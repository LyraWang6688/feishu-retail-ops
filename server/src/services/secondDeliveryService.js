const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { PaymentService, amount } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService, progressFromRecords } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { itemFactsForDetails } = require('./salesDetailItemFacts');
const { asDate, isWithinLookupWindow } = require('../utils/salesDateWindows');
// ⭐⭐ 2026-10-14（业务负责人逐字）：「**数据从 20261015 开始**」＋「**存量行不用管，就看增量**」
//   ⇒ 这份**每日提醒**只看 `DATA_SINCE`（含）之后录的单；之前的存量**一律不管** ✗。
//   🔴 判据只有一处实现（`config/dataSince` 的 `isOnOrAfterSince`，上海时区）——
//      本文件只把它**与既有的「最近 7 天」窗口并排用在同一个判断里**（见下面那一行 continue），
//      **不自己比日期字符串、也不另写时区折算** ✗。
//   ⚠️ **故意不受它约束**的是"她当下正在做的那一单"：扫码页提交 / 交付 ·
//      工作台**单笔**补记收款 / 交付并扣库存 · 群里她点名的那一单 ·
//      「未完成，可点重试」她**点重试那一刻** —— 那些**不经过**这份每日提醒 ✓。
const { isOnOrAfterSince } = require('../config/dataSince');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { logInfo, logWarn } = require('../utils/logger');
const { mergeCorrelation } = require('../utils/correlationFields');
// ⭐ 2026-10-08：「退过 / 换过 / 赔过 的明细不属于待处理」——判据（唯一一处）在售后配置里。
const { isAfterSalesFulfillment } = require('../config/afterSales');
// ⭐ 2026-10-08：飞书错误的**真实** code / msg / log_id / method_id（唯一取用口）。
// ⭐ 2026-10-08（P0）· 失败要重试 + 失败要可见 + 瞬时错误自动重试：
//   原来这条链路"当天失败即落 failed、当天不再重试，而且只写日志"（真机 10-06 / 10-08 早上
//   两条推送都在 09:0x 掉了，她整天没收到卡）。现在**与 9 点待处理单推送共用同一套**：
//   · 按天层（分钟级）：`resolveAttempt` + `retryDelaysMs`（默认每 10 分钟 × 6，成功一次即停）；
//   · 瞬时层（秒级）：读表 / 发消息的 1254607 / 5xx / 429 / 网络中断小退避；确定性错误不重试；
//   · 告警：次数用完往群里回一句人话（一天最多一句）。
//   ⚠️ 策略值 / 判据 / 状态机 / 文案都在 `config/pushRetry`，本文件不写第二份。
// ⭐ 2026-10-28：只留**瞬时错误小退避**（读表的 1254607 / 429 / 5xx）——「按天重试 + 群告警」
//   那一套是**每日推送**专用的，随推送一起退场（`resolveDailyAttempt` / `shouldSendFailureAlert`
//   / `formatPushAlertText` / `pushFailureReason` 不再 import）。
const { resolvePushRetryConfig, withTransientRetry, DEFAULT_SLEEP } = require('../config/pushRetry');

// 「第二次交付」= 已入账之后的那次收尾：把还没收到的钱收掉、把还没交的货交掉。
//
// 一句话业务口径（业务负责人逐字说的）：**现货 + 钱没结清**的单第一次录单时货已经交付、
// 库存已经扣过，点「成交」**只补收款**；**预定**单第一次录单时货还没拿走，点「成交」要
// ① 明细未交付 → 已交付 ② 补收款 ③ 扣库存流水与实时库存。
//
// 🔴 2026-10-07 口径大改：交易类型 = **库存有没有**（现货 / 预定），
//    「未付」**不再是交易类型** ⇒ 候选**不能再按交易类型编码筛**：
//      · 现货 + 钱没结清 的主表类型是 `SALE_CASH` —— 按老口径它**不会进候选**，
//        于是"现货欠着钱"这笔单会永远收不到提醒（真实的静默漏单）；
//      · 新判据 = **尚未完成履约**（货没交完 或 钱没收清），见下面 `listPendingDeliveries`。
//    候选源 = 「**预定（未交付）**」＋「**现货但钱没结清**」 = `progress.orderStatus !== '已完成'`。
//
// ⚠️ 这个类**不自己实现任何库存或收款逻辑**：
//   · 收款走 PaymentService.collectPendingReceipt（"补收款"专用，校验必须是未收款、金额必须等于该记录）；
//   · 交付与扣库存走 SalesDeliveryService.deliver（全仓唯一的销售扣库存入口）。
// 它只负责"先收钱、再交货"这个**顺序**和"哪些单要提醒"这个**筛选**。

// 候选**不再**按交易类型编码筛（2026-10-07 口径大改）。
// 老口径是 `['SALE_UNPAID', 'SALE_PREPAID']` 两个编码 —— 它在新模型下会**漏掉**
// 「现货 + 钱没结清」（主表类型是 `SALE_CASH`），而且 `SALE_UNPAID` 那条行为记录
// 已被业务负责人从「行为管理」里删掉（历史单的关联是悬空的）。
// 新口径只有一条：**尚未完成履约**（见 listPendingDeliveries 里的 `progress.orderStatus`）。

// 「最近 7 天」：今天 + 往前 6 个上海自然日（复用查找链路的窗口口径，含边界）。
const REMINDER_WINDOW_DAYS = 7;

/**
 * ⭐⭐ 这份**每日提醒**的候选日期判据 —— **两个条件只在这一处合并** ✗ 不散写：
 *   `isWithinLookupWindow(...)`（既有口径：「最近 7 天」）
 *   **且** `isOnOrAfterSince(...)`（她 2026-10-14：「**数据从 20261015 开始**」＋
 *        「**存量行不用管，就看增量**」）。
 *
 * ⚠️ 为什么合在一处：她这两条口径是**先后**定下的（窗口「最近 7 天」先有，数据起点后加）——
 *    任何一处漏改都会变成"某块悄悄多推存量"；合成一个函数 ⇒ **改一处就全改**。
 * ⚠️ 判据本身仍然只有一处实现（`config/dataSince` 的 `isOnOrAfterSince`，上海时区）：
 *    本文件**不自己比日期字符串、也不另写时区折算** ✗。
 * ⚠️ 「故意不受它约束」的是**她当下正在做的那一单**（扫码提交 / 交付 · 工作台**单笔** ·
 *    群里她点名的那一单 · 「未完成，可点重试」她点重试那一刻）—— 那些**不经过**这份每日提醒 ✓。
 */
const withinReminderWindow = (date, now) => isWithinLookupWindow(date, { now, days: REMINDER_WINDOW_DAYS })
  && isOnOrAfterSince(date);

class SecondDeliveryService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.progress = options.progress || new SalesProgressService({ gateway: this.gateway });
    // 同一张单连点两次「成交」排成一前一后：第二次进来时状态已经是已收款 / 已交付，
    // 会走到"这一单已成交"那条分支，而不是各写一遍。
    this.queue = new KeyedSerialQueue();
    // ⛔ 2026-10-28：`this.client` / `this.chatId` / `this.store` / `this.reminderRun` /
    //   `this.scheduleRetry` 已删除 —— 它们只服务**每日成交提醒卡片**（含按天认领与失败重试），
    //   而业务负责人确认「9 点群推送不再需要」「现在没有群聊入口，也没有旧卡片」。
    //   本类现在只保留**成交本身**（`confirm`：补收款 + 交付），工作台「二次交付」照旧调它。
    // ⭐ 2026-10-08（P0）：共享的重试策略（惰性解析一次；注入的优先）。
    //    · `transient` —— 一次**读**的秒级小退避（2~3 次；写一步都不重试）。
    this._retrySettings = options.retrySettings || null;
    // 「等一会儿再试」的睡眠：单测注入假的，避免真等 1s / 2s。
    this.sleep = options.sleep || DEFAULT_SLEEP;
    // 「尺码」在销售明细里是**关联**「尺码管理」，不能只信关联单元格的显示文本
    // （部分接口只回 record_ids 不回 text）。走共享的尺码解析（30 秒缓存），
    // 只有 `includeItems` 那条路会用到它（见 listPendingDeliveries）。
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway,
      sizeReferences: options.sizeReferences,
    });
  }

  /** 共享的重试 / 告警策略（**只解析一次**；注入的优先）。 */
  get retrySettings() {
    if (!this._retrySettings) this._retrySettings = resolvePushRetryConfig();
    return this._retrySettings;
  }

  /**
   * 一次**读**或一次**发**的瞬时错误小退避（业务负责人 P0 第 3 条）。
   * 瞬时错误 → 1s / 2s 各再来一次；**确定性错误一次都不重试**（只留一条清晰日志）。
   * ⚠️ `operation` 只进日志（例 `second_delivery.reminder.send_card`）。
   */
  transientRetry(fn, operation) {
    return withTransientRetry(fn, {
      operation, config: this.retrySettings.transient, sleep: this.sleep,
    });
  }

  /** 读表：全部走瞬时小退避（读是幂等的，重试安全）。 */
  read(fn, operation) {
    return this.transientRetry(fn, operation);
  }

  // ⛔ 2026-10-28：`alertChatId` / `alertFailure`（次数用完往群里回一句告警）随**每日推送**删除 ——
  //   它们是那条推送「失败要可见」的配套，而推送本身已退场（业务负责人：「9 点群推送不再需要」）。
  //   `confirm` 这条链路的失败**照旧向上抛**（工作台把它回显到页面，不静默）。

  /**
   * 「成交」：补收款 + 交付。**工作台「销售订单列表 → 待交割单 → 二次交付」**调的就是它
   * （`routes/workbenchOrderActions.js` → `WorkbenchOrderActionService.secondDelivery`）。
   *
   * 顺序是**先收钱、再交货**：钱没记上就不该把货记成已交付（预定单的货是收了钱才给）。
   * 任一步失败会向上抛（工作台把原因原样回显到页面）；底层两个写操作都是幂等的，
   * 所以她重试一次是安全的。
   *
   * ⛔ 2026-10-28：卡片按钮那条入口（及其 `cardMessageId` / `reminderDay` 入参）已随
   *   每日成交提醒卡片一起删除 —— 本方法现在**只有一个调用方**：工作台。
   */
  // ⚠️ 关联键走**尾部可选参数**（`options.correlation`），不塞进 `input`：
  //    `input` 的形状被既有测试逐字 deepEqual，那就是这条边界的证明。关联键只进日志。
  confirm(input = {}, options = {}) {
    const salesEntryRecordId = String(input.salesEntryRecordId || '').trim();
    if (!salesEntryRecordId) throw new Error('成交缺少销售主表 record_id');
    return this.queue.run(salesEntryRecordId, () => this._confirm({ ...input, salesEntryRecordId }, options));
  }

  // ⭐ 2026-10-28：入参里原来的 `cardMessageId` / `reminderDay` / `settledAt` 已删除 ——
  //   它们只服务"把被点的那张提醒卡改成已成交"（`markCardSettled`），随每日提醒卡片一起退场。
  async _confirm({ salesEntryRecordId, method, operatorOpenId }, options = {}) {
    await this.gateway.validateTables?.(['salesEntry', 'salesDetail', 'paymentRecord']);
    const entryFields = this.gateway.table('salesEntry').fields;
    // ⭐ 2026-10-08（P0）：读表走瞬时小退避（读是幂等的，重试安全）。**写一步都不重试**。
    const entry = await this.read(
      () => this.gateway.get('salesEntry', salesEntryRecordId), 'second_delivery.confirm.get_entry',
    );
    if (!entry) throw new Error('销售主表记录不存在');
    if (!isPosted(postedOf(entry, entryFields))) throw new Error('销售订单尚未确认入账');
    // ⭐ 关联键（2026-10-07 业务负责人拍板「日志改下吧！」）：这条链路写的
    //   「收款明细（未收款→已收款）/ 库存流水 / 实时库存 / 库存状态」正是以前
    //   **一个键都没有**的那半。`order_no` 从这条**已经读到的**主表记录上取，零额外请求。
    //   只进日志，不改任何写入内容与顺序。
    const correlation = mergeCorrelation(options.correlation, {
      sales_entry_record_id: salesEntryRecordId,
      order_no: textValue(entry.fields?.[entryFields.orderNo]),
    });

    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const [allDetails, allPayments] = await Promise.all([
      this.read(() => this.gateway.listAll('salesDetail'), 'second_delivery.confirm.list_details'),
      this.read(() => this.gateway.listAll('paymentRecord'), 'second_delivery.confirm.list_payments'),
    ]);
    const orderDetails = allDetails.filter((record) =>
      linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId));
    const orderPayments = allPayments.filter((record) =>
      linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(salesEntryRecordId));

    const pending = orderPayments.filter((record) =>
      textValue(record.fields?.[paymentFields.status]) === '未收款');
    // 只把**未交付**的明细交给交付服务。现货单的明细在第一次录单时就已是「已交付」，
    // 这里天然是空列表——所以这条链路根本走不到扣库存那一步，不存在"扣两次"。
    const undeliveredIds = orderDetails
      .filter((record) => textValue(record.fields?.[detailFields.fulfillmentStatus]) !== '已交付')
      .map((record) => record.record_id);

    if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');
    if (!pending.length && !undeliveredIds.length) {
      // 两次点击、或者钱和货都齐了：不重复写，回一句可判断的结果。
      return {
        salesEntryRecordId, alreadyCompleted: true, method,
        collectedPaymentIds: [], collectedAmount: 0, delivery: null, progress: null,
      };
    }

    // ① 只补收款：那条「未收款」→「已收款」，收款时间 = 点击时间。
    //    金额**原样取记录上的数**，不在这里算差额（collectPendingReceipt 自己会校验相等）；
    //    收款方式必须由点击带上来，缺了就报错——不能替她猜一个方式写进账里。
    const collectedIds = [];
    let collectedCents = 0;
    for (const record of pending) {
      const raw = textValue(record.fields?.[paymentFields.amount]);
      await this.payments.collectPendingReceipt(record.record_id, {
        salesEntryRecordId, amount: raw, method, receivedAt: Date.now(),
      }, { correlation });
      collectedIds.push(record.record_id);
      collectedCents += Math.round(amount(raw) * 100);
    }

    // ② 交付：有未交付明细才交给 deliver（它写「已交付」+ 扣库存流水 + 扣实时库存，
    //    并在内部重算销售进度——只算、不写任何状态列）。没有未交付明细时只做进度同步，一样不碰库存。
    let deliveryResult = null;
    let progress = null;
    if (undeliveredIds.length) {
      deliveryResult = await this.delivery.deliver({
        salesEntryRecordId, detailRecordIds: undeliveredIds, paymentRecordIds: collectedIds,
      }, { correlation });
    } else {
      progress = await this.progress.sync(salesEntryRecordId, { paymentRecordIds: collectedIds });
    }

    const result = {
      salesEntryRecordId,
      alreadyCompleted: false,
      method,
      collectedPaymentIds: collectedIds,
      collectedAmount: collectedCents / 100,
      delivery: deliveryResult,
      progress,
    };
    // ③ 写完了 —— 只记日志。⛔ 2026-10-28：原来这里还会把**被点的那张提醒卡**改成「已成交」
    //    （`markCardSettled`）；每日提醒卡片已随 9 点群推送整体退场 ⇒ 没有任何卡片要改。
    logInfo('sales.second_delivery.completed', {
      sales_entry_record_id: salesEntryRecordId,
      operator_open_id: operatorOpenId || '',
      method: method || '',
      collected_payment_ids: collectedIds,
      collected_amount: result.collectedAmount,
      delivered_detail_ids: undeliveredIds,
      delivery_failed_count: deliveryResult?.failures?.length || 0,
      fulfillment_status: deliveryResult?.fulfillmentStatus || progress?.fulfillmentStatus || '',
      order_status: progress?.orderStatus || '',
      ...correlation,
    });
    return result;
  }

  // ⛔ 2026-10-28：`markCardSettled`（把被点的那张每日提醒卡的那一单改成「已成交」）已删除 ——
  //   提醒卡片与群推送整体退场，没有任何卡片需要 patch。

  /**
   * 候选单：最近 7 天里**尚未完成履约**的已入账销售单 ——
   * 即「**预定（还没交付）**」＋「**现货但钱没结清**」。
   * ⚠️ 2026-10-07 之前这里还多一层"交易类型必须是未付 / 预付"的筛选；
   *    新口径下类型 = 库存有没有，那一层会把"现货 + 欠着钱"整类漏掉 ⇒ 已撤掉。
   *
   * 「尚未完成履约」的判据是"我们交货、用户付钱"这两件事有没有都做到，
   * 也就是算出来的 `progress.orderStatus` 还没到「已完成」——货没交完算没完成，钱没收清算没完成。
   * （`progress.orderStatus` 是**算出来的 JS 字段**，不是表里的列：表里的「订单状态」已被业务负责人删除。）
   * 进度是**现算**的（复用销售进度那套纯函数），不看主表上可能过期的派生值。
   *
   * ── 2026-10-08：**退过 / 换过 / 赔过 的单不进候选**（业务负责人逐字）────────────
   *   「**不需要退货和换货的**，销售就是预定和现货待收的」
   *   ⇒ 明细里含「已退货 / 已换货 / 已赔货」的单，在这里**明确跳过**（记 info，不再打
   *     "未知销售明细履约状态"的 warn）。判据只从 `config/afterSales` 取。
   *   ⚠️ 这条对**两个调用方都生效**（9 点待处理单推送 / 成交提醒卡片）——候选口径只有一处。
   *
   * ── 2026-10-07：`includeItems`（**可选**，默认关）──────────────────────────
   * 待处理单推送要按「货号 + 尺码」显示每条单。那两个字段的**事实**在这里顺手取最省：
   * 本轮已经把 `salesDetail` 整表读进来了（就在下面的 `orderDetails` 里），
   * 所以**不会为了货号尺码再读一遍销售明细**；只额外整表读一次「货品信息」，
   * 「其他配品」**配了才读**，尺码走共享的尺码解析（有缓存）。
   * ⚠️ 关着时（第二次交付提醒那条路）返回的对象**一个字都不变**：
   *    `items` 根本不加，读表也一次都不多发。
   * ⚠️ 这段是**增强**：货品表读挂了只记一条 warn、这一轮没有货号尺码，**不让整条推送失败**。
   */
  async listPendingDeliveries({ now = new Date(), includeItems = false } = {}) {
    // ⭐ 2026-10-08（P0）：这一组整表读正是早上 9:00 最容易撞上瞬时错误的地方
    //   （读一次「实时库存」要 5~9 秒、1337 行分页；两条链路并发读多张表）⇒ 每张表各自小退避。
    const [entries, allDetails, allPayments, behaviors] = await Promise.all([
      this.read(() => this.gateway.listAll('salesEntry'), 'second_delivery.reminder.list_entries'),
      this.read(() => this.gateway.listAll('salesDetail'), 'second_delivery.reminder.list_details'),
      this.read(() => this.gateway.listAll('paymentRecord'), 'second_delivery.reminder.list_payments'),
      this.read(() => this.gateway.listAll('behavior'), 'second_delivery.reminder.list_behaviors'),
    ]);
    const entryFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const behaviorFields = this.gateway.table('behavior').fields;

    // 「交易类型」是关联「行为管理」的字段。这里只把**名称**留给卡片显示用
    //（新口径下类型是现货 / 预定；分区**不用**它，见 config/pendingDealPush 的判据）。
    // ⚠️ 关联悬空（她删过行为记录 / 老数据）时**不跳过这笔单** —— 账面事实是"还没收齐"，
    //    名字读不出来不该让一笔单从提醒里消失（静默漏单是最难查的一类）。
    const behaviorsById = new Map(behaviors.map((record) => [record.record_id, {
      code: textValue(record.fields?.[behaviorFields.code]),
      label: textValue(record.fields?.[behaviorFields.name]) || '',
    }]));

    let itemIndex = null;
    if (includeItems) {
      // 货号尺码是**增强**：索引读挂了就这一轮没有它，**绝不让整条推送失败**
      // （单号 + 金额 + 深链本身就该看得见）。
      try {
        itemIndex = await this.loadItemIndex();
      } catch (error) {
        logWarn('sales.second_delivery.items.index_failed', { error: error.message });
        itemIndex = null;
      }
    }

    const orders = [];
    let unlabeledItemCount = 0;
    let missingSizeCount = 0;
    for (const entry of entries) {
      if (!isPosted(postedOf(entry, entryFields))) continue;
      const orderDetails = allDetails.filter((record) =>
        linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(entry.record_id));
      // ⭐ 2026-10-18：生产「销售主表.交易类型」列已删 ⇒ 交易类型改从**明细行**取
      //   （主表若有旧值仍兼容读；空则逐行找第一个认得出的）。
      const tradeTypeIds = [
        ...linkedRecordIds(entry.fields?.[entryFields.tradeType]),
        ...orderDetails.flatMap((record) => linkedRecordIds(record.fields?.[detailFields.tradeType])),
      ];
      // ⚠️ 取**第一个认得出来的**关联记录只为了显示名称；一个都不认得也继续往下走
      //    （判据是履约进展，不是这个关联）。
      const tradeTypeRecordId = tradeTypeIds.find((id) => behaviorsById.has(id)) || '';
      const orderPayments = allPayments.filter((record) =>
        linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(entry.record_id));
      // 「这一单是哪天的」：明细「销售日」优先，退回主表「录单日」——和查单链路
      // （`utils/salesDateWindows` + 销售状态判据）用同一条口径，两边不能对同一张单给出两个日期。
      // ⚠️ 两个都读不到时必须**大声跳过**：悄悄按"太老了"处理会让这张单永远收不到提醒，
      // 属于最难查的静默失效。
      const detailDates = orderDetails
        .map((record) => asDate(record.fields?.[detailFields.soldAt]))
        .filter(Boolean);
      const orderDate = detailDates.length
        ? new Date(Math.min(...detailDates.map((date) => date.getTime())))
        : asDate(entry.fields?.[entryFields.recordedAt]);
      if (!orderDate) {
        logWarn('sales.second_delivery.reminder.order_skipped', {
          sales_entry_record_id: entry.record_id, reason: 'no_sale_date',
          hint: '「销售日」和「录单日」都读不到，无法判断是否在最近 7 天内',
        });
        continue;
      }
      // ⭐⭐ 候选日期判据 = 「最近 7 天」**且**「数据起点之后」，**合在一处**（见上面的
      //    `withinReminderWindow`）：窗口按上海自然日算（线上服务器是 UTC，用本地时区会把
      //    凌晨的单算错一天）；数据起点是业务负责人 2026-10-14 的口径。
      // ⚠️ 存量单是**有意**不推的（不是读表失败、也不是数据缺）⇒ 与这条窗口一样不刷日志：
      //    每天几十条存量单逐条打日志只会把日志刷满，反而盖住真正的异常。
      if (!withinReminderWindow(orderDate, now)) continue;
      // ⭐ 2026-10-08（业务负责人逐字：「**不需要退货和换货的**，销售就是预定和现货待收的」）：
      //   明细里含「已退货 / 已换货 / 已赔货」的单**不进**这两份待处理清单。
      // ⚠️ 这是**明确规则**，不是兜底：改动前这些单会走到 `progressFromRecords` 抛
      //   「未知销售明细履约状态：已换货」，被下面的 catch 当成"数据不自洽"跳过并打 warn
      //   —— 同一个结果，但日志说的是"未知"，看着像代码没想过这个取值。
      // ⚠️ 判据只从 `config/afterSales` 取（不在本文件写第二份中文）。
      const afterSalesStatuses = orderDetails
        .map((record) => textValue(record.fields?.[detailFields.fulfillmentStatus]))
        .filter((status) => isAfterSalesFulfillment(status));
      if (afterSalesStatuses.length) {
        logInfo('sales.second_delivery.reminder.order_skipped', {
          sales_entry_record_id: entry.record_id,
          reason: 'after_sales_fulfillment',
          fulfillment_status: afterSalesStatuses.join(','),
          hint: '这一单里有退过/换过/赔过的明细 ⇒ 不属于"预定 / 现货待收"，两份待处理清单都不推',
        });
        continue;
      }
      let progress;
      try {
        progress = progressFromRecords(orderDetails, orderPayments, detailFields, paymentFields);
      } catch (error) {
        // 单条数据不自洽（比如收款超过成交额）不能让整轮提醒挂掉：
        // 跳过它、大声记一条，其余单照推。
        logWarn('sales.second_delivery.reminder.order_skipped', {
          sales_entry_record_id: entry.record_id, error: error.message,
        });
        continue;
      }
      if (progress.orderStatus === '已完成') continue;
      // 「这单里卖的是什么」：只在 `includeItems` 时算，且复用**上面已经读到的** `orderDetails`。
      let items = [];
      if (itemIndex) {
        const facts = await itemFactsForDetails({
          details: orderDetails,
          detailFields,
          itemIndex,
          resolveSize: (detail) => this.resolveDetailSize(detail, detailFields),
        });
        items = facts.items;
        unlabeledItemCount += facts.unlabeledCount;
        missingSizeCount += facts.missingSizeCount;
      }
      orders.push({
        salesEntryRecordId: entry.record_id,
        orderNo: textValue(entry.fields?.[entryFields.orderNo]) || entry.record_id,
        tradeTypeLabel: behaviorsById.get(tradeTypeRecordId)?.label || '',
        // ⚠️ 只作**显示 / 排查**用；分区判据是履约进展（见 config/pendingDealPush），
        //    不是这个编码。关联悬空时为空串。
        tradeTypeCode: behaviorsById.get(tradeTypeRecordId)?.code || '',
        saleDate: orderDate.toISOString(),
        pendingAmount: progress.pendingAmount,
        platformPendingAmount: progress.platformPendingAmount,
        pendingDeliveryQuantity: progress.pendingDeliveryQuantity,
        quantity: progress.quantity,
        fulfillmentStatus: progress.fulfillmentStatus,
        paymentStatus: progress.paymentStatus,
        // ⚠️ 只在 `includeItems` 时才有这个键（关着时返回形状与改动前**逐字相同**）。
        ...(includeItems ? { items } : {}),
      });
    }
    if (includeItems && (unlabeledItemCount || missingSizeCount)) {
      // 一次推送只记**一条**汇总（不是每件一条），否则日志会被刷满。
      // 「缺货号」= 明细指不到可售品、或指向的那条记录没有货号/名称——那一件**不会**被显示；
      // 「鞋缺尺码」= 关联了「尺码管理」但解析不出来。两种都是数据问题，得能查。
      logWarn('sales.second_delivery.items.incomplete', {
        order_count: orders.length,
        unlabeled_item_count: unlabeledItemCount,
        missing_size_count: missingSizeCount,
        hint: '有明细行取不到货号/配品名称，或鞋的尺码解析不出来；这些件不会出现在推送文案里',
      });
    }
    // 最早的单排最前：越久没成交的越该先被看见。
    return orders.sort((left, right) => String(left.saleDate).localeCompare(String(right.saleDate)));
  }

  /**
   * 「货号 / 配品名称」要用的两张索引：**整表各读一次**（不是每单、每件各读一次）。
   *   · 「货品信息」：核心表，读挂了让调用方降级（这一轮没有货号尺码，不影响推送本身）；
   *   · 「其他配品」：**没配 tableId 就不读**（有些部署只卖鞋；见 larkMvpService 同款处理）。
   */
  async loadItemIndex() {
    const index = {};
    const productTable = this.gateway.table?.('product');
    if (productTable?.tableId) {
      const records = await this.read(() => this.gateway.listAll('product'), 'second_delivery.items.list_products');
      index.product = {
        labelField: productTable.fields?.itemNo,
        // ⭐ 2026-10-08 晚：9 点推送的行要「货号 **颜色** 尺码」⇒ 索引里也带上「颜色」这一列
        //    （取值与显示都在 `salesDetailItemFacts`，这里只负责把列名交出去）。
        colorField: productTable.fields?.color,
        byId: new Map(records.map((record) => [record.record_id, record])),
      };
    }
    const accessoryTable = this.gateway.table?.('accessory');
    if (accessoryTable?.tableId) {
      try {
        const records = await this.read(
          () => this.gateway.listAll('accessory'), 'second_delivery.items.list_accessories',
        );
        index.accessory = {
          labelField: accessoryTable.fields?.name,
          byId: new Map(records.map((record) => [record.record_id, record])),
        };
      } catch (error) {
        // 配品表读不到不该让整条推送掉：配品那一件这轮就没有名称（不会拼出空壳），其余照旧。
        logWarn('sales.second_delivery.items.accessory_read_failed', { error: error.message });
      }
    }
    return index;
  }

  /**
   * 明细的尺码：关联「尺码管理」→ 走共享解析（有缓存）；老数据 / 没配「尺码管理」
   * 退回单元格自带的文本；都没有就留空 —— 调用方据此**不拼「码」**。
   * ⚠️ 配品没有尺码关联，这里会走 catch 分支拿到空串，**不是**错误。
   * ⚠️ 退回的文本**必须是正整数**才算尺码（与 SizeReferenceService.normalizeSize 同一值域）：
   *    有的接口把关联单元格回成 `['recXXXX']`（只有 record_id、没有文本），
   *    照单全收就会把 record_id 当尺码拼进群里（`A-2 recXXXX码`）——那比留空更糟。
   */
  async resolveDetailSize(detail, detailFields) {
    try {
      const entry = await this.getSizeReferences().resolveLinkedCell(detail?.fields?.[detailFields?.size]);
      return entry?.size === undefined || entry?.size === null ? '' : String(entry.size);
    } catch (error) {
      const fallback = textValue(detail?.fields?.[detailFields?.size]).trim();
      return /^[1-9]\d*$/.test(fallback) ? fallback : '';
    }
  }

  // ⛔ 2026-10-28：本方法之后原先还有 `paymentMethodNames` / `sendCardToChat` / `sendTextToChat`
  //   / `sendDailyReminder` / `_sendDailyReminder` —— 它们**只服务每日成交提醒卡片**
  //   （按钮上要带收款方式、按天认领、失败重试与告警），随 9 点群推送整体删除。
  //   ⚠️ 「成交」本身（`confirm`）与「待处理候选」（`listPendingDeliveries`）保留：
  //     前者是工作台「二次交付」的实现，后者是这条能力自己的候选查询。
}

module.exports = { SecondDeliveryService };
