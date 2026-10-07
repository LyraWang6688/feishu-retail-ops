const { PaymentService } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService } = require('./salesProgressService');
const { V1ReferenceResolver } = require('./v1ReferenceResolver');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const {
  PROGRESS_KINDS,
  PROGRESS_TASK_STATUS,
  resolveSalesProgressIntakeConfig,
} = require('../config/salesProgressIntake');
const { logInfo, logWarn } = require('../utils/logger');
const { skipNoGroupContext } = require('../utils/privateChatSend');
// ⭐【确认成交】卡片按钮（2026-10-07 业务负责人拍板的**甲**）的用户可见文案（配置先行）。
//   本类自己只回"货还没到"那一句（`confirmDeal.shortStock`）；其余回话仍走
//   `config/salesProgressIntake` —— 那条路是她说「已完毕 / 成交」时用的同一条。
const { resolveSalesConfirmDealConfig } = require('../config/salesConfirmDeal');

// 把"不是钱"的数字遮掉（货号 1366-33、尺码 42码、批次号 BH-…）——
// 遮罩规则在 config/salesProgressIntake（配置先行，改规则不碰逻辑）。
const maskIgnoredNumbers = (text, patterns) => {
  let masked = String(text || '');
  for (const pattern of patterns) {
    masked = masked.replace(new RegExp(pattern, 'g'), ' ');
  }
  return masked;
};

const collectAmounts = (masked, amountPattern) => {
  const matches = String(masked || '').match(new RegExp(amountPattern, 'g'));
  return matches || [];
};

const firstCue = (text, cues) => cues.find((cue) => text.includes(cue)) || '';

const formatCopy = (template, values = {}) =>
  String(template || '').replace(/\{(\w+)\}/g, (whole, key) =>
    (values[key] === undefined || values[key] === null ? whole : String(values[key])));

/**
 * 「话题里的二次处理识别」（②）——**已定位到某笔销售之后**，判断她这句话是
 * **那笔的进展同步**（收到多少钱 / 货已经拿走）还是**新的销售原话**。
 *
 * 为什么单独一个 service（模块化 / 解耦）：
 *   · 判据（词表 / 正则 / 文案）在 `config/salesProgressIntake`，本类里一个关键词都不写死；
 *   · 它**不解析销售原话**、不发销售卡片、不建销售记录 —— 那是销售入口的事；
 *   · 它**不自己收钱/交货** —— 收款走 `PaymentService`，交付走 `SalesDeliveryService`，
 *     进度只算不写（`SalesProgressService`），和网页工作台"补记收款"用的是同一套底层能力。
 *
 * ⚠️ 一条硬边界：**只有在群话题里、且已经定位到某笔销售时才会被调用**
 *    （调用方 `larkMvpService.processSalesTask` 用 `task.chat_type === 'group'`
 *      ＋ `task.sales_entry_record_id` 两道判据拦住）。私聊的任务两个字段都没有 →
 *    本类**一次都不会执行**，私聊行为一个字不变。
 *
 * ⚠️ 它是**排他的**：一旦判定"这是进展"（含判不清的 ambiguous），
 *    就**不会**再吐回去当新原话解析 —— 判不清时回一句问她，**绝不猜**
 *    （业务负责人 2026-10-06 明确的口径）。
 */
class SalesThreadProgressService {
  constructor(options = {}) {
    this.gateway = options.gateway;
    if (!this.gateway) throw new Error('SalesThreadProgressService requires gateway');
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.progress = options.progress || new SalesProgressService({ gateway: this.gateway });
    // 「整单完成」（她说「已完毕 / 成交」）交给 SecondDeliveryService：**成交只有这一处实现**
    // （点卡片「成交」按钮与她直接说这句话走同一条编排：先补收款、再交付）。
    // 不传时只有在"整单完成"这条分支上才报错，其它路径不受影响。
    this.secondDelivery = options.secondDelivery || null;
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.config = options.config || resolveSalesProgressIntakeConfig();
    // 【确认成交】卡片按钮那几句话（默认文案 + 可配）。只在"货还没到"那条回话上用得到，
    // 但它与进度配置是两件事（一个管"她说的这句话是什么意思"，一个管"这张卡上写什么"），
    // 所以各读各的配置，不混进 `this.config`。
    this.confirmDeal = options.confirmDeal || resolveSalesConfirmDealConfig();
    this.now = options.now || (() => new Date());
    // 群里：文字回到那条销售话题。
    // 🔴 2026-10-07「私聊链路移除」：原来的缺省是
    //   `options.sendText?.(task?.sender_open_id, message)` —— **偷偷发私聊**。
    //   它连同 `options.sendText` 这个 open_id 口径一起**整体删除**
    //   （业务负责人拍板的 ⓐ：「代码里一行私聊都不留」）。
    //   没有群上下文 = **没有去处** → 只记一条 `lark.private_chat.send_skipped`、返 `null`。
    //   见 docs/private-chat-removal-decision-2026-10-07.md。
    this.sendTextToTask = options.sendTextToTask
      || (async (task) => skipNoGroupContext('text', task));
    this.store = options.store;
  }

  /**
   * 判据（纯函数，可单测）：这句话是那笔的进展，还是新原话？
   *
   * @returns {{kind: 'payment'|'delivery'|'ambiguous'|'none', reason: string,
   *   amount?: number, method?: string}}
   */
  classify(text = '') {
    const raw = String(text || '');
    if (!this.config.enabled) return { kind: PROGRESS_KINDS.NONE, reason: 'disabled' };
    const paymentCue = firstCue(raw, this.config.progressCues.payment);
    const deliveryCue = firstCue(raw, this.config.progressCues.delivery);
    const completeCue = firstCue(raw, this.config.progressCues.complete);
    if (!paymentCue && !deliveryCue && !completeCue) {
      return { kind: PROGRESS_KINDS.NONE, reason: 'no_progress_cue' };
    }

    // 进展线索和新原话线索同时出现 = 分不清 → 交给她确认，绝不猜。
    const newSaleCue = firstCue(raw, this.config.newSaleCues);
    if (newSaleCue) {
      return { kind: PROGRESS_KINDS.AMBIGUOUS, reason: `new_sale_cue:${newSaleCue}` };
    }
    // 钱和货两条线索都在 = 不知道她要说哪一件事 → 同样问清楚。
    if (paymentCue && deliveryCue) {
      return { kind: PROGRESS_KINDS.AMBIGUOUS, reason: 'payment_and_delivery_cue' };
    }

    // ⭐ 整单完成（「已完毕 / 成交」）只在**没有**更具体的收款 / 交付线索时才成立：
    //    「好了，收到微信 500」仍按收款处理（"好了"只是口头语），不降级成整单完成。
    if (completeCue && !paymentCue && !deliveryCue) {
      return { kind: PROGRESS_KINDS.COMPLETE, reason: `complete_cue:${completeCue}` };
    }

    if (deliveryCue) return { kind: PROGRESS_KINDS.DELIVERY, reason: `delivery_cue:${deliveryCue}` };

    // 收款进展必须说清"多少钱"：说不清就**不猜**（宁可多问一句，也不能记错一笔钱）。
    const masked = maskIgnoredNumbers(raw, this.config.ignoreNumberPatterns);
    const amounts = collectAmounts(masked, this.config.amountPattern);
    if (amounts.length !== 1) {
      return {
        kind: PROGRESS_KINDS.AMBIGUOUS,
        reason: amounts.length ? 'amount_ambiguous' : 'amount_missing',
      };
    }
    return {
      kind: PROGRESS_KINDS.PAYMENT,
      reason: `payment_cue:${paymentCue}`,
      amount: Number(amounts[0]),
      method: this.detectPaymentMethod(raw),
    };
  }

  /** 她嘴里的收款方式 → 交给「收款方式管理」核实的那个名字（核实在 apply 里做）。 */
  detectPaymentMethod(text = '') {
    const raw = String(text || '');
    for (const [spoken, canonical] of this.config.paymentMethodAliases) {
      if (raw.includes(spoken)) return canonical;
    }
    return '';
  }

  /**
   * 处理一条**已定位到某笔销售**的话题消息。
   *
   * @param {{task: object}} input
   * @returns {Promise<{handled: boolean, kind?: string, reason?: string}>}
   *   handled:true = 这条归"二次处理"，调用方**不要再**走销售原话解析。
   */
  async handle({ task } = {}) {
    if (!task || task.chat_type !== 'group' || !task.sales_entry_record_id) {
      return { handled: false, reason: 'not_thread_sale' };
    }
    const decision = this.classify(task.original_text || task.text || '');
    if (decision.kind === PROGRESS_KINDS.NONE) return { handled: false, reason: decision.reason };

    logInfo('sales.thread_progress.detected', {
      task_id: task.task_id,
      sales_entry_record_id: task.sales_entry_record_id,
      kind: decision.kind,
      reason: decision.reason,
    });

    // 判不清 → 回一句问她，**不回退**去当新原话解析（那正是这次要修的 bug）。
    if (decision.kind === PROGRESS_KINDS.AMBIGUOUS) {
      await this.reply(task, this.config.replies.ambiguous);
      await this.mark(task, {
        status: PROGRESS_TASK_STATUS.ASKED_UNKNOWN,
        progress_kind: 'ambiguous',
        progress_reason: decision.reason,
      });
      return { handled: true, kind: 'ambiguous', reason: decision.reason };
    }

    try {
      const applied = decision.kind === PROGRESS_KINDS.PAYMENT
        ? await this.applyPayment(task, decision)
        : decision.kind === PROGRESS_KINDS.COMPLETE
          ? await this.applyComplete(task, decision)
          : await this.applyDelivery(task);
      // ⭐ **状态如实**（业务负责人 2026-10-06 拍板，`AGENTS.md` 第 16 条①）：
      //    "只回问了一句、业务表一个字没写"绝**不能**记成 `progress_applied` ——
      //    那正是这次要修的假成功：看起来成功了，其实钱货都没动。
      //    各 apply* 用 `asked: true` 声明"我什么都没写，只是问了一句"。
      const asked = Boolean(applied.asked);
      await this.mark(task, {
        status: asked ? PROGRESS_TASK_STATUS.ASKING : PROGRESS_TASK_STATUS.APPLIED,
        progress_kind: decision.kind,
        progress_reason: asked ? (applied.reason || decision.reason) : decision.reason,
        progress_result: applied.result || null,
      });
      return { handled: true, kind: decision.kind, ...applied };
    } catch (error) {
      // 记不上就**如实告诉她**（不静默、也不改口成"这是在录新单"）。
      await this.reply(task, formatCopy(this.config.replies.failed, { reason: error.message }));
      await this.mark(task, { status: PROGRESS_TASK_STATUS.FAILED, progress_reason: error.message });
      logWarn('sales.thread_progress.failed', {
        task_id: task.task_id, kind: decision.kind, error: error.message,
      });
      return { handled: true, kind: decision.kind, failed: true, reason: error.message };
    }
  }

  /**
   * 收款进展：先读那一笔，再按"这一笔还差多少钱"设闸门，然后才记收款。
   *
   * ⚠️ 下面几条"只回问一句 / 只让她先去入账"的分支一律带 `asked: true`：
   *    它们**业务表一个字都没写**，handle 会据此把任务状态记成 `progress_asking`
   *    而不是 `progress_applied`（业务负责人 2026-10-06 要求状态如实）。
   */
  async applyPayment(task, decision) {
    const salesEntryRecordId = String(task.sales_entry_record_id || '').trim();
    if (decision.method) {
      // 先说清"她说的是哪种收款方式、表里有没有" —— 它不存在时 resolvePaymentMethod 会抛，
      // 我们把它换成一句问话（`needMethod`），而不是记一笔没有方式的收款。
      try {
        await this.references.resolvePaymentMethod(decision.method);
      } catch (error) {
        await this.reply(task, this.config.replies.needMethod);
        return { replied: true, asked: true, reason: 'payment_method_unknown' };
      }
    } else {
      await this.reply(task, this.config.replies.needMethod);
      return { replied: true, asked: true, reason: 'payment_method_missing' };
    }

    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry || !isPosted(postedOf(entry, this.gateway.table('salesEntry').fields))) {
      await this.reply(task, this.config.replies.notPosted);
      return { replied: true, asked: true, reason: 'not_posted' };
    }

    const before = await this.progress.forOrder(salesEntryRecordId);
    if (before.pendingAmount === null) throw new Error('这笔的销售明细还没有成交金额，我没法算还差多少钱');
    if (Number(before.pendingAmount) <= 0) {
      await this.reply(task, this.config.replies.nothingPending);
      return { replied: true, reason: 'nothing_pending' };
    }
    if (Math.round(decision.amount * 100) > Math.round(Number(before.pendingAmount) * 100)) {
      throw new Error(`本次收款 ￥${decision.amount} 超过待收金额 ￥${before.pendingAmount}`);
    }
    // ⭐ 关联键（2026-10-07 业务负责人拍板「日志改下吧！」）：这条链路写的
    //   「收款明细 / 库存流水 / 实时库存」以前一个键都没有，按 task_id grep 看不到。
    //   单号从这条**已经读到的**主表记录（`entry`）上取，零额外请求；只进日志，不改写入内容。
    const correlation = { task_id: task.task_id, sales_entry_record_id: salesEntryRecordId,
      order_no: textValue(entry.fields?.[this.gateway.table('salesEntry').fields.orderNo]) };

    // ⭐ 有「未收款」占位就**翻它**（未收款 → 已收款 + 写收款时间 + 补交易方向），
    //    没有占位才新建 —— 与网页工作台「补记收款」（`SalesFollowupService.addPayment`）
    //    逐条同口径（docs/workbench-query-contract.md：新订单有「未收款」记录时更新原记录；
    //    旧订单无占位记录时仍新增收款）。
    //    ⚠️ 改动前无条件 `payments.record(...)` **新建**一条已收款 → 那条「未收款」
    //       永远留着，同一笔单同时挂"已收 + 待收"，账目对不上。
    //    业务负责人的口径（逐字）：「**未收款变为已收款，并且有收款时间**」。
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const pending = (await this.payments.recordsForSale(salesEntryRecordId)).filter((record) =>
      textValue(record.fields?.[paymentFields.status]) === '未收款');
    if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');
    if (pending.length && Math.round(decision.amount * 100) !== Math.round(
      Number(textValue(pending[0].fields?.[paymentFields.amount])) * 100)) {
      throw new Error(`本版请一次收清这条待收款记录（￥${textValue(pending[0].fields?.[paymentFields.amount])}）；分笔补款暂不支持`);
    }
    const payment = {
      salesEntryRecordId,
      method: decision.method,
      amount: decision.amount,
      operatorOpenId: task.sender_open_id || '',
      receivedAt: this.now().getTime(),
    };
    // 「钱」这一半：收款明细的写入日志也带同一个关联键（见上面 `correlation` 的定义）。
    const paymentOptions = { correlation };
    let recordId;
    if (pending.length) {
      await this.payments.collectPendingReceipt(pending[0].record_id, payment, paymentOptions);
      recordId = pending[0].record_id;
    } else {
      recordId = (await this.payments.record(payment, paymentOptions)).recordId;
    }
    // 进度只算不写（和网页工作台「补记收款」同一条口径，见 salesProgressService.sync）。
    await this.progress.sync(salesEntryRecordId, { paymentRecordIds: [recordId] });
    await this.reply(task, formatCopy(this.config.replies.paymentDone, {
      method: decision.method, amount: decision.amount,
    }));
    logInfo('sales.thread_progress.payment_recorded', {
      task_id: task.task_id,
      sales_entry_record_id: salesEntryRecordId,
      payment_record_id: recordId,
      // 是"翻了那条未收款"还是"新建了一条" —— 排查账目时一眼能看出走了哪条路。
      collected_pending: Boolean(pending.length),
      amount: decision.amount,
      method: decision.method,
    });
    return { replied: true, amount: decision.amount, method: decision.method,
      result: { paymentRecordId: recordId } };
  }

  /**
   * ⭐ **货那一半**：把这一单里**还没交**的明细交给既有的交付服务
   * （它写「已交付」+ 扣库存流水 + 扣实时库存）。**不回复、不记状态、不碰钱** ——
   * 回复与状态由调用方决定，所以「交付进展」和「整单完成」能共用同一段取数与交付。
   *
   * 为什么抽成方法：`AGENTS.md` 第 16 条①要求「先把货那一半做掉、再就钱回问一句」，
   * 而"交付进展"那条路本来就有这段逻辑 —— 复制一份就是两处实现，改一处忘一处。
   */
  async deliverUndelivered(salesEntryRecordId, options = {}) {
    const detailFields = this.gateway.table('salesDetail').fields;
    const undelivered = (await this.gateway.listAll('salesDetail'))
      .filter((record) => linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId))
      .filter((record) => textValue(record.fields?.[detailFields.fulfillmentStatus]) !== '已交付')
      .map((record) => record.record_id);
    if (!undelivered.length) return { count: 0, detailRecordIds: [], delivered: null };
    const delivered = await this.delivery.deliver({
      salesEntryRecordId, detailRecordIds: undelivered,
    }, options);
    return { count: undelivered.length, detailRecordIds: undelivered, delivered };
  }

  /** 交付进展：把**还没交**的明细交给既有的交付服务（它写「已交付」+ 扣库存）。 */
  async applyDelivery(task) {
    const salesEntryRecordId = String(task.sales_entry_record_id || '').trim();
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry || !isPosted(postedOf(entry, this.gateway.table('salesEntry').fields))) {
      await this.reply(task, this.config.replies.notPosted);
      return { replied: true, asked: true, reason: 'not_posted' };
    }
    const delivery = await this.deliverUndelivered(salesEntryRecordId, {
      correlation: { task_id: task.task_id, sales_entry_record_id: salesEntryRecordId },
    });
    if (!delivery.count) {
      await this.reply(task, this.config.replies.nothingPending);
      return { replied: true, reason: 'nothing_pending' };
    }
    await this.reply(task, formatCopy(this.config.replies.deliveryDone, { count: delivery.count }));
    logInfo('sales.thread_progress.delivery_applied', {
      task_id: task.task_id,
      sales_entry_record_id: salesEntryRecordId,
      detail_ids: delivery.detailRecordIds,
    });
    return { replied: true, count: delivery.count,
      result: { detailRecordIds: delivery.detailRecordIds, delivered: delivery.delivered } };
  }

  /**
   * 她说「成交」时用哪个收款方式：
   *   ① 这句话里说了（"成交 微信"）→ 用它；
   *   ② 没说、且「收款方式管理」里**只有一个** → 用那一个。这不是猜、也不是"默认方式"：
   *      库里只有一种收钱渠道时不存在第二种可能；
   *   ③ 没说、又有多个（或一个都没有）→ 返回空，由调用方先做货、再回一句问她，
   *      **绝不替她挑一个**。
   *
   * ⚠️ **刻意没有**"配置里的默认收款方式"这种兜底（业务负责人 2026-10-06 纠正过：
   *    「用户会直接告诉收款方式的」）—— 见 `AGENTS.md` 第 16 条(1)。
   */
  async resolveCompletePaymentMethod(task) {
    const spoken = this.detectPaymentMethod(String(task?.original_text || task?.text || ''));
    if (spoken) return spoken;
    if (!this.secondDelivery?.paymentMethodNames) return '';
    const methods = await this.secondDelivery.paymentMethodNames();
    return methods.length === 1 ? methods[0] : '';
  }

  /** 这一单还挂着几条「未收款」占位（= 钱那一半还有没有活）。**一处实现**，两处用。 */
  async pendingPaymentsFor(salesEntryRecordId) {
    const paymentFields = this.gateway.table('paymentRecord').fields;
    return (await this.payments.recordsForSale(salesEntryRecordId))
      .filter((record) => textValue(record.fields?.[paymentFields.status]) === '未收款');
  }

  /**
   * ⭐【确认成交】卡片按钮（业务负责人 2026-10-07 拍板的**甲**：**不新发消息**，
   *   就在她手里那张「已入账」终态卡上点）。
   *
   * **点击 = 走既有那条「成交」逻辑**：钱货两半都交给本类的 `applyComplete`
   * （= 与她说「已完毕 / 成交」逐字同一条路 → `SecondDeliveryService.confirm`
   *  → `PaymentService` / `SalesDeliveryService`）。本方法**不另造一套**。
   *
   * 它只多做一件她 2026-10-06 明确要求的事（`AGENTS.md` 第 16 条① ＋ 本次任务第 4 条）：
   * **"货那一半"先做掉**。为什么必须由这里先做：
   *   · 【确认成交】按钮上**没有收款方式**（她明确"选项只能点是"，卡上只有一个按钮）；
   *   · 而 `SecondDeliveryService.confirm` 的顺序是**先收钱、再交货**（那条链路自己是有意的：
   *     预定单"钱没记上就不该把货记成已交付"）。
   *   ⇒ 预定单的货**很可能还没到**，照那个顺序走就会**先把「未收款」写成「已收款」**、
   *     再交付失败 —— 那是**半成品账**（货没到，钱却已经写成收到）。
   *   ⇒ 所以：**只有在这一单确实有待收款时**，先做货；货没到就**一个字节都不写**
   *     （不写钱、不写交付、卡片不变灰），并回一句她能照做的话（配置里的 `shortStock`）。
   *     货做完了，钱那一半仍交给 `applyComplete`（不猜方式、不设默认方式）。
   *
   * 没有待收款时**不做任何前置动作**（钱那一半本来就没活）—— 直接走 `applyComplete`，
   * 由既有的 `SecondDeliveryService.confirm` 去交付；这保证"预定 + 全款"的回话仍是
   * 既有的那句「交付 N 双」，不会退化成"我没有重复写"。
   */
  async completeDealFromCard({ task } = {}) {
    const salesEntryRecordId = String(task?.sales_entry_record_id || '').trim();
    if (!salesEntryRecordId) throw new Error('确认成交缺少销售主表 record_id');
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry || !isPosted(postedOf(entry, this.gateway.table('salesEntry').fields))) {
      await this.reply(task, this.config.replies.notPosted);
      return { replied: true, asked: true, reason: 'not_posted' };
    }
    const correlation = { task_id: task.task_id, sales_entry_record_id: salesEntryRecordId };
    const pending = await this.pendingPaymentsFor(salesEntryRecordId);
    if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');

    let deliveredBefore = { count: 0, detailRecordIds: [] };
    if (pending.length) {
      const delivery = await this.deliverUndelivered(salesEntryRecordId, { correlation });
      const failures = delivery.delivered?.failures || [];
      if (failures.length) {
        await this.reply(task, this.confirmDeal.shortStock);
        logWarn('sales.confirm_deal.short_stock', {
          task_id: task.task_id,
          sales_entry_record_id: salesEntryRecordId,
          failed_count: failures.length,
          reason: failures[0]?.error || '',
          // 可排查：这次**什么都没写**（钱、交付、卡片都没动），到货入库后再点一次是安全的。
          written: false,
          hint: '货还没到 → 不写钱、不写交付、卡片不变灰；到货入库后再到这张卡上点确认成交',
        });
        return {
          replied: true, asked: true, reason: 'short_stock',
          result: { failures, detailRecordIds: delivery.detailRecordIds },
        };
      }
      deliveredBefore = { count: delivery.count, detailRecordIds: delivery.detailRecordIds };
    }
    const applied = await this.applyComplete(task, { deliveredBefore });
    return { ...applied, deliveredBefore };
  }

  /**
   * 整单完成（「已完毕 / 成交 / 搞定 / 好了」）——**等于点那张「成交」按钮**：
   * ① 补收款（那条「未收款」→「已收款」+ 收款时间）② 交付（写「已交付」+ 扣库存）。
   *   业务负责人的口径见 docs/e2e-sales-status-method.md：
   *   「话题里说『已完毕/成交』→ 未履约→履约 · 待收→已收 · 有收款时间」。
   *
   * ⚠️ 这两件事**都不在本类实现**：钱货都交给 `SecondDeliveryService`（成交只有一处实现）。
   *    本类只做"这句话 = 成交"的判定与转交，绝不自己收钱或扣库存。
   *
   * ⭐ **收款方式按她说的**（业务负责人 2026-10-06 拍板，`AGENTS.md` 第 16 条(1)）：
   *   · 她说了 → 用她说的（同一单里每一笔可以不同：定金微信、尾款现金）；
   *   · 她没说、而「收款方式管理」里**只有一个** → 用那一个（这不是默认值，是"没有第二种可能"）；
   *   · 否则**不猜、也不设默认方式** —— 但⚠️**必须先把"货那一半"做掉**
   *     （未交付 → 已交付 + 扣库存），再就"钱"回问一句；`handle` 会把任务状态记成
   *     `progress_asking`（**不是** `progress_applied`）。
   *   · ⚠️ 改动前这里在问不出方式时**直接 return**：钱货都没动、状态却记成
   *     `progress_applied`（看起来成功了）——那正是这次要修的 bug。
   *
   * ⚠️ 尾部可缺省的 `{ deliveredBefore }` 是**给【确认成交】卡片那条链路用的**：
   *    为了不写半成品账，它进来之前可能**已经替这一单做掉了"货那一半"**
   *    （见 `completeDealFromCard`）。这里只把**回话与日志**说全，不碰任何写入、不改任何判断；
   *    不传 = 行为逐字不变（她说「已完毕 / 成交」那条路一个字都没动）。
   */
  async applyComplete(task, { deliveredBefore = { count: 0, detailRecordIds: [] } } = {}) {
    const salesEntryRecordId = String(task.sales_entry_record_id || '').trim();
    if (!this.secondDelivery) throw new Error('整单完成链路没有接上成交服务');
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry || !isPosted(postedOf(entry, this.gateway.table('salesEntry').fields))) {
      await this.reply(task, this.config.replies.notPosted);
      return { replied: true, asked: true, reason: 'not_posted' };
    }
    // 收款方式只在**确实有待收款**时才必须要：钱货两清的单说「成交」只是补交付，
    // 不该因为没提收款方式就把这条正确的话挡回去。
    // 「有没有待收款」的取法**只有一处**（`pendingPaymentsFor`）：句子识别那条路与
    // 【确认成交】卡片那条路读的是同一份事实，不会两边各写一个判断而慢慢走歪。
    const hasPending = (await this.pendingPaymentsFor(salesEntryRecordId)).length > 0;
    const method = hasPending ? await this.resolveCompletePaymentMethod(task) : '';
    if (hasPending && !method) {
      // ⭐ 钱没法定（她没说方式、可选方式也不是唯一）→ **不替她挑、也不设默认方式**，
      //    但"货那一半"先做掉（`AGENTS.md` 第 16 条①）：
      //    走的是与点卡片「成交」**同一段交付能力**（SalesDeliveryService.deliver，
      //    SecondDeliveryService 内部用的也是它），所以不存第二套交付实现。
      const delivery = await this.deliverUndelivered(salesEntryRecordId, {
        correlation: { task_id: task.task_id, sales_entry_record_id: salesEntryRecordId },
      });
      // 货可能已经由调用方（【确认成交】卡片那条路）先做掉了：回话把两次**加起来**说，
      // 别让她以为啥也没干。不传 `deliveredBefore` 时（她说「已完毕」那条路）逐字不变。
      const deliveredTotal = delivery.count || Number(deliveredBefore.count || 0);
      await this.reply(task, deliveredTotal
        ? formatCopy(this.config.replies.completeAskMethod, { count: deliveredTotal })
        : this.config.replies.needMethod);
      logInfo('sales.thread_progress.complete_asking_method', {
        task_id: task.task_id,
        sales_entry_record_id: salesEntryRecordId,
        // 货做到了什么程度：说清"我只是没动钱，不是什么都没做"。
        delivered_quantity: delivery.count,
        delivered_detail_ids: delivery.detailRecordIds,
        // ⚠️ 只有"成交前已经替它做掉过货"时才有这个键 —— 既有那条路的日志逐字不变。
        ...(Number(deliveredBefore.count || 0) > 0
          ? { delivered_before_click: Number(deliveredBefore.count) } : {}),
        hint: '她没说收款方式、「收款方式管理」里也不是唯一一个 → 先做货、钱回问一句，不猜方式',
      });
      return {
        replied: true, asked: true, reason: 'payment_method_missing',
        result: {
          detailRecordIds: [...(deliveredBefore.detailRecordIds || []), ...delivery.detailRecordIds],
        },
      };
    }
    const result = await this.secondDelivery.confirm({
      salesEntryRecordId, method, operatorOpenId: task.sender_open_id || '',
    }, {
      correlation: { task_id: task.task_id, sales_entry_record_id: salesEntryRecordId },
    });
    if (result.alreadyCompleted) {
      await this.reply(task, this.config.replies.completeAlready);
      return { replied: true, reason: 'already_completed' };
    }
    // ⭐⭐ **交付失败也是成交结论**（bug 1 的核心）：**一条都没交出去**（货还没到）时，
    //   这一单**不算成交** —— 不许说"已成交"、不许把卡变灰，回她那句"到货入库后再点"。
    //
    // 为什么这里必须管：`completeDealFromCard` 那道"先做货"的闸门是**为"钱"写的**
    // （防"货没到、钱却先记成已收"的半成品账），所以它长在 `pending.length` 上。
    // **全款已收**的单没有"钱"要防 ⇒ 整段绕过那道闸门，走到这里；改动前这里只 `reply` 一句
    // 「还有 N 双交付未完成」就 `return { replied, result }` —— 返回值**没有 `asked`**，
    // 上层 `settled = !outcome.asked` 便把"一句话"读成了"成交"（假成交）。
    //
    // ⚠️ 判据是"**这次一条都没交成**"（`deliveredQuantity === 0`），不是"有失败"：
    //    **部分交付**（A 双交出去、B 双没货）是既有语义（钱货各自记账），
    //    那种情况仍算成交，只在回话/卡面里如实写上"还有 N 双"（见下面的 `failedCount`）。
    const deliveredThisCall = Number(result.delivery?.deliveredQuantity || 0);
    const failedCount = result.delivery?.failures?.length || 0;
    if (failedCount && !deliveredThisCall) {
      await this.reply(task, this.confirmDeal.shortStock);
      logWarn('sales.confirm_deal.short_stock', {
        task_id: task.task_id,
        sales_entry_record_id: salesEntryRecordId,
        failed_count: failedCount,
        reason: result.delivery?.failures?.[0]?.error || '',
        // 可排查：这次**钱和货都没写**（没有待收款可写；明细一条都没交成、库存没扣），
        // 卡片也不会变灰 —— 到货入库后再点一次是安全的。
        written: false,
        hint: '货还没到 → 不写钱、不写交付、卡片不变灰；到货入库后再到这张卡上点确认成交',
      });
      return {
        replied: true, asked: true, reason: 'short_stock',
        result: { failures: result.delivery?.failures || [] },
      };
    }
    const parts = [];
    if (Number(result.collectedAmount) > 0) parts.push(`补收款 ￥${result.collectedAmount}`);
    // 交付数量取"这次 confirm 交的"；confirm 里没有交付那一段（货已经被卡片那条路先做掉了）
    // 时退回"成交前已经做掉的"数量 —— 两种情况都如实说，且**不重复计数**。
    const deliveredCount = deliveredThisCall
      || (result.delivery ? 0 : Number(deliveredBefore.count || 0));
    if (deliveredCount > 0) parts.push(`交付 ${deliveredCount} 双`);
    // 交付只成了一半时**如实说**（与点卡片那条路一致：钱收下了、货没交齐不能报成功）。
    if (failedCount) parts.push(`还有 ${failedCount} 双交付未完成，请到工作台核对`);
    await this.reply(task, formatCopy(this.config.replies.completeDone, {
      summary: parts.join('，') || '无待处理项',
    }));
    logInfo('sales.thread_progress.completed', {
      task_id: task.task_id,
      sales_entry_record_id: salesEntryRecordId,
      method,
      collected_amount: Number(result.collectedAmount) || 0,
      delivered_quantity: deliveredCount,
      delivery_failed_count: result.delivery?.failures?.length || 0,
    });
    return { replied: true, result };
  }

  async reply(task, message) {
    try {
      await this.sendTextToTask(task, message);
    } catch (error) {
      // 回不出去不能把"已经记上的进展"判失败：日志留痕即可，她再问一次能看到结果。
      logWarn('sales.thread_progress.reply_failed', {
        task_id: task?.task_id, error: error.message,
      });
    }
  }

  async mark(task, patch) {
    if (!this.store || !task?.task_id) return;
    try {
      await this.store.update(task.task_id, patch);
    } catch (error) {
      logWarn('sales.thread_progress.mark_failed', { task_id: task?.task_id, error: error.message });
    }
  }
}

module.exports = { SalesThreadProgressService, maskIgnoredNumbers, collectAmounts, formatCopy };
