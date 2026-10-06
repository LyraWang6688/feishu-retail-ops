const { PaymentService } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService } = require('./salesProgressService');
const { V1ReferenceResolver } = require('./v1ReferenceResolver');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const {
  PROGRESS_KINDS,
  resolveSalesProgressIntakeConfig,
} = require('../config/salesProgressIntake');
const { logInfo, logWarn } = require('../utils/logger');

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
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.config = options.config || resolveSalesProgressIntakeConfig();
    this.now = options.now || (() => new Date());
    // 群里：文字回到那条销售话题；私聊的兜底形状与别处一致（本类在私聊根本不会被调用）。
    this.sendTextToTask = options.sendTextToTask
      || (async (task, message) => options.sendText?.(task?.sender_open_id, message));
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
    if (!paymentCue && !deliveryCue) return { kind: PROGRESS_KINDS.NONE, reason: 'no_progress_cue' };

    // 进展线索和新原话线索同时出现 = 分不清 → 交给她确认，绝不猜。
    const newSaleCue = firstCue(raw, this.config.newSaleCues);
    if (newSaleCue) {
      return { kind: PROGRESS_KINDS.AMBIGUOUS, reason: `new_sale_cue:${newSaleCue}` };
    }
    // 钱和货两条线索都在 = 不知道她要说哪一件事 → 同样问清楚。
    if (paymentCue && deliveryCue) {
      return { kind: PROGRESS_KINDS.AMBIGUOUS, reason: 'payment_and_delivery_cue' };
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
      await this.mark(task, { status: 'ignored', progress_kind: 'ambiguous', progress_reason: decision.reason });
      return { handled: true, kind: 'ambiguous', reason: decision.reason };
    }

    try {
      const applied = decision.kind === PROGRESS_KINDS.PAYMENT
        ? await this.applyPayment(task, decision)
        : await this.applyDelivery(task);
      await this.mark(task, {
        status: 'progress_applied',
        progress_kind: decision.kind,
        progress_reason: decision.reason,
        progress_result: applied.result || null,
      });
      return { handled: true, kind: decision.kind, ...applied };
    } catch (error) {
      // 记不上就**如实告诉她**（不静默、也不改口成"这是在录新单"）。
      await this.reply(task, formatCopy(this.config.replies.failed, { reason: error.message }));
      await this.mark(task, { status: 'progress_failed', progress_reason: error.message });
      logWarn('sales.thread_progress.failed', {
        task_id: task.task_id, kind: decision.kind, error: error.message,
      });
      return { handled: true, kind: decision.kind, failed: true, reason: error.message };
    }
  }

  /** 收款进展：先读那一笔，再按"这一笔还差多少钱"设闸门，然后才记收款。 */
  async applyPayment(task, decision) {
    const salesEntryRecordId = String(task.sales_entry_record_id || '').trim();
    if (decision.method) {
      // 先说清"她说的是哪种收款方式、表里有没有" —— 它不存在时 resolvePaymentMethod 会抛，
      // 我们把它换成一句问话（`needMethod`），而不是记一笔没有方式的收款。
      try {
        await this.references.resolvePaymentMethod(decision.method);
      } catch (error) {
        await this.reply(task, this.config.replies.needMethod);
        return { replied: true, reason: 'payment_method_unknown' };
      }
    } else {
      await this.reply(task, this.config.replies.needMethod);
      return { replied: true, reason: 'payment_method_missing' };
    }

    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry || !isPosted(postedOf(entry, this.gateway.table('salesEntry').fields))) {
      await this.reply(task, this.config.replies.notPosted);
      return { replied: true, reason: 'not_posted' };
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

    const created = await this.payments.record({
      salesEntryRecordId,
      method: decision.method,
      amount: decision.amount,
      operatorOpenId: task.sender_open_id || '',
      receivedAt: this.now().getTime(),
    });
    // 进度只算不写（和网页工作台「补记收款」同一条口径，见 salesProgressService.sync）。
    await this.progress.sync(salesEntryRecordId, { paymentRecordIds: [created.recordId] });
    await this.reply(task, formatCopy(this.config.replies.paymentDone, {
      method: decision.method, amount: decision.amount,
    }));
    logInfo('sales.thread_progress.payment_recorded', {
      task_id: task.task_id,
      sales_entry_record_id: salesEntryRecordId,
      payment_record_id: created.recordId,
      amount: decision.amount,
      method: decision.method,
    });
    return { replied: true, amount: decision.amount, method: decision.method,
      result: { paymentRecordId: created.recordId } };
  }

  /** 交付进展：把**还没交**的明细交给既有的交付服务（它写「已交付」+ 扣库存）。 */
  async applyDelivery(task) {
    const salesEntryRecordId = String(task.sales_entry_record_id || '').trim();
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry || !isPosted(postedOf(entry, this.gateway.table('salesEntry').fields))) {
      await this.reply(task, this.config.replies.notPosted);
      return { replied: true, reason: 'not_posted' };
    }
    const detailFields = this.gateway.table('salesDetail').fields;
    const undelivered = (await this.gateway.listAll('salesDetail'))
      .filter((record) => linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId))
      .filter((record) => textValue(record.fields?.[detailFields.fulfillmentStatus]) !== '已交付')
      .map((record) => record.record_id);
    if (!undelivered.length) {
      await this.reply(task, this.config.replies.nothingPending);
      return { replied: true, reason: 'nothing_pending' };
    }
    const delivered = await this.delivery.deliver({
      salesEntryRecordId, detailRecordIds: undelivered,
    });
    await this.reply(task, formatCopy(this.config.replies.deliveryDone, { count: undelivered.length }));
    logInfo('sales.thread_progress.delivery_applied', {
      task_id: task.task_id,
      sales_entry_record_id: salesEntryRecordId,
      detail_ids: undelivered,
    });
    return { replied: true, count: undelivered.length, result: { detailRecordIds: undelivered, delivered } };
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
