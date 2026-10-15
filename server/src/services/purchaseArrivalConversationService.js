// ⭐ 用户可见文案抽到 config（2026-10-12 技术债批次：只挪位置，一个字符没改）
const { pageMessages, landingMessages, scanMessages } = require('../config/purchaseArrivalTexts');
const crypto = require('node:crypto');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const {
  purchaseArrivalReconcileStatusCard,
} = require('../utils/larkCards');
const {
  ARRIVAL_CONVERSATION_ACTIONS,
  resolveArrivalConversationConfig,
} = require('../config/arrivalConversation');
const { logError, logInfo, logWarn } = require('../utils/logger');

// 会话任务 id 只跟「哪一批」有关，不含时间：同一批单子（含她后来另开一个话题）
// 永远是同一条核对记录，重复投递/重启都不会各起一份。
// `arrival_reconcile_` 前缀让它和销售/采购申请的任务一眼可分。
const taskIdForBatch = (batchNo) =>
  `arrival_reconcile_${crypto.createHash('sha256').update(String(batchNo || '')).digest('hex').slice(0, 24)}`;

const TASK_TYPE = 'purchase_arrival_reconcile';

// 回话模板：`{key}` 用值替换，值缺失时原样留着（不静默吞掉占位符）。
// 与 `services/salesThreadProgressService.js` 里的 `formatCopy` 同一套写法
//（同一件事不要有两种拼法；这里是本文件自己的小工具，不跨 service 依赖）。
const formatCopy = (template, values = {}) =>
  String(template || '').replace(/\{(\w+)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? whole : String(values[key])
  ));

// 一行明细在卡片/日志里的身份（货号+颜色+尺码）。
const rowLabel = (row) => `${textValue(row?.item_no) || '（未知货号）'}${textValue(row?.color) || ''} ${Number(row?.size)} 码`;

// ⭐⭐ 2026-10-08：「实际金额」那一项的**服务端**解析（业务负责人：必填、必须让用户填）。
//
// 🔴 为什么数字校验在**服务端**：飞书卡片的输入框**没有数字类型** —— 官方 `input_type`
//   只有 `text` / `multiline_text` / `password` 三个取值（curl 实查的原文与出处见
//   `config/arrivalConversation.js` 的 `amountInputType` 注释）。⇒ "非数字"只能我们自己拦。
//
// 口径（她说的「缺失 / 非数字 / 为负 ⇒ 一个字都不许写」）：
//   · 空白（或没这一项）        → `amount_missing`；
//   · 去掉空白 / 千分位逗号 / 前缀 ￥¥ 之后不是纯数字、或是负数 → `amount_invalid`；
//   · **0 允许**（她只说了"为负"要拒；"这次金额 0"是真实存在的输入形状）。
// ⚠️ 刻意**不**做任何"猜"：`12800元` / `1.2万` / `1e3` 一律判非法，让她改成数字。
const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
const parseActualAmount = (raw) => {
  const source = String(raw ?? '').trim();
  if (!source) return { ok: false, reason: 'amount_missing' };
  const normalized = source.replace(/[\s,，]/g, '').replace(/^[￥¥]/, '');
  if (!AMOUNT_PATTERN.test(normalized)) return { ok: false, reason: 'amount_invalid' };
  const value = Number(normalized);
  // ⭐ 2026-10-08 晚业务负责人定：金额**必填且必须是正数** ——
  //    「不会出现零的情况的。如果这个金额没填，就提交不了」⇒ **0 也当"没填"**（拒）。
  if (!Number.isFinite(value) || value <= 0) return { ok: false, reason: 'amount_invalid' };
  return { ok: true, value };
};

/** 这一批**在本地任务上**有没有一个可用的金额（点「是」那条路的闸门判据）。 */
const hasActualAmount = (task) => {
  const raw = task?.actual_amount;
  // ⭐ 与 `parseActualAmount` 同一口径：**正数**才算"这一批已经有金额"（0 不算）。
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0;
};

/**
 * 「采购到货：群话题对话式核对」（业务负责人 2026-10-06 定的口径）。
 *
 * 这个 service 只干**一件事**：把群话题里的自然对话，变成一次「到货核对」的会话状态
 * + 一次触发点。真正的入库能力**一点都没重写**——它调的是 PurchaseWebhookService 里
 * 保留下来的 `confirmArrival`（写「采购入库」→ InventoryService.applyPurchase）。
 *
 * 流程（每一步都对得上她的原话）：
 *   ① 话题里她说话 → 记进本地任务记录（**一张业务表都不写**）；
 *   ② 每条消息都让模型判一次：她说的差异是哪一类（完全一样 / 比申请多 / 比申请少）
 *      ＋她说完了没有（「完毕」之类，字眼不固定 → 靠模型理解，不做关键词匹配）；
 *   ③ ⭐ **收到到货反馈就直接处理**（2026-10-07 业务负责人口径：「用户一般一句话就能够
 *      说清楚这个事情，所以收到用户关于到货情况的反馈时，直接处理就可以」）：
 *      这句话里有可核对的内容（有差异，或她说了「都一样」）→ **直接**算计划 + 在**话题里**
 *      发卡片（是 / 否两个按钮）。**不再要求她先说一句「核对完毕」** ——
 *      `complete` 只剩诊断用途（见下面 `handleTopicMessageLocked` 的注释）。
 *      已经有一张卡片时她再补充/修正（或换了话题）→ **在当前话题重发一张新卡**，
 *      旧卡**尽力作废**（收掉按钮）—— 见 `retirePreviousCard` 的注释（2026-10-07 晚改）；
 *   ④ 点「是」→ 这是**唯一的入库点**：
 *        「验收原话」写到**「报货批次」那一行** → **逐条加库存**（`inventory.applyPurchase`，
 *        「库存流水」/「实时库存」由它负责）→ 同一行的「确认状态」改成已确认；
 *        ⚠️ 2026-10-07 深夜起**不再写任何入库明细行**（「采购入库」表已被她整表删除），
 *        「到货状态 = 已到货」由本类的 `notifyBatchArrived` 在事后写；
 *   ⑤ 点「否」→ **零业务表写入**，只回一句「好，那先不入库」。
 *
 * ⚠️ 「报货信息」（= 采购申请表；表名沿革：原「采购申请」→「单据信息」→「具体信息」→「报货信息」）**一个字都不动**：
 *   本类里没有任何对 purchaseRequest 的写路径；`confirmArrival` 里原先那一段
 *   回写入库状态的代码已按她的口径删除（见 purchaseWebhookService 的注释 + 测试里的断言）。
 *
 * ⚠️ 不做的事（她没有说，就不替她决定）：
 *   · 不改采购申请、不改报货表、不建货品（申请行本来就挂着已有货品）。
 *
 * ⭐ 「某一行算出来 `实际 = 0 双`」怎么办（业务负责人 **2026-10-07 当面纠正**，逐字：
 *   「**如果这个尺码算下来为 0，那么就不用入库啊！**」）：
 *   · `实际 = 0` 是**到货核实的正常结果**（供应商漏发一整双），**不是错误**；
 *     该行**不入库**（不写任何入库明细、不调 `inventory.applyPurchase`），
 *     **但绝不阻断整单** —— 其它 `实际 > 0` 的行照常入库；
 *   · 卡片上如实显示「申请 N 双 → 实际 0 双（这双没到）」（文案可配）；
 *   · **真正的「对不上明细」**（尺码/货号在单据里找不到、命中不唯一）仍走
 *     `plan_unmatched` + 一句让她重说的话 —— **两者不许混为一谈**；
 *   · `实际 < 0`（她说少的双数比申请数还多）**既不静默当 0、也不放行**：
 *     回一句"算出来是负数"让她重说（`replies.negative`，事件 `plan_negative`）。
 *   ⚠️ 差异**类型**仍然只有三类（一样 / 多 / 少）—— 她 2026-10-06 定的那个口径一个字没改；
 *     0 是**由「少」算出来的实际数量**，不是第四类差异。
 */
class PurchaseArrivalConversationService {
  constructor({
    gateway,
    store,
    sizeReferences,
    confirmArrival,
    markBatchArrived,
    replyText,
    replyCard,
    updateCard,
    getMessageMeta,
    config,
    now,
  } = {}) {
    if (!gateway) throw new Error('PurchaseArrivalConversationService 需要 gateway');
    if (!store) throw new Error('PurchaseArrivalConversationService 需要 store');
    this.gateway = gateway;
    // ⚠️ 刻意**共用采购任务存储**（PurchaseWebhookService 的 store）：
    // `confirmArrival` 是从这个 store 里读草稿的，会话状态放别处就得复制一份过去。
    this.store = store;
    // 🔴 2026-10-16：`this.recognizer = recognizer` 已删 —— 「群话题对话式核对」的
    //    **解析**那一半（`handleTopicMessage` / `handleTopicMessageLocked`）随
    //    「与 AI 分析有关的都停掉」整体退场，本类现在只留**确认**那一半
    //    （`confirmLocked` / `confirmBatchArrival` / `buildPlan` / `loadRequestRows`）。
    //    依据=业务负责人 2026-10-16 逐字「**都停掉，与 AI 分析有关的都停掉**」＋「**连代码一起删**」。
    // 尺码解析（「尺码」是关联字段，要读回数字）。缺了它只是这条链路读不出明细——
    // 那一步会明确报错，不会静默按错尺码入库。
    this.getSizeReferences = sizeReferences || (() => {
      throw new Error('到货核对缺少尺码解析依赖（sizeReferences）');
    });
    this.confirmArrival = confirmArrival;
    // ⭐ 到货核对确认成功之后，把「报货批次」那一行的到货状态改成「已到货」。
    // 注入而不是自己 new：谁维护"报货批次"那一行是**别人的职责**
    //（`PurchaseOrderBatchService`），本类只负责在**正确的时机**叫它一声。
    // ⚠️ 默认空实现 = 什么都不做（单测/别的调用方不关心这条链路时行为与改动前一模一样）。
    // 🔴 它**必须永不抛**：入库事实已经落地，批次状态只是投影。
    this.markBatchArrived = markBatchArrived || (async () => ({ updated: false, reason: 'not_wired' }));
    // 群里的反馈一律**引用回复/回复卡片**（群聊没有"上一次对话"的概念）。
    // ⭐ ④ 两个端口都收第三个参数 `{ threadId }`：非空时由**飞书发送适配器**
    //    带 `reply_in_thread` 把这条反馈回到**那个话题**（本类不认识 reply_in_thread）。
    this.replyText = replyText || (async () => '');
    this.replyCard = replyCard || (async () => '');
    this.updateCard = updateCard || (async () => false);
    // ⭐⭐ 2026-10-07 晚（真机 23:37「日志说卡片已更新，她那边一张卡都没有」）：
    //    **更新一张已经存在的消息之前，先读一眼它到底是什么** ——
    //    `im.v1.message.get` 的 `msg_type` / `deleted` / `thread_id` / `updated`。
    //    为什么非要有这一步：`im.v1.message.patch` 的**唯一成功判据是 `code === 0`**
    //    （官方文档：该接口"仅支持更新卡片（消息类型为 `interactive`）"，
    //     可它的错误码表里**没有**"目标不是卡片"这一条）⇒ 对一条文字 / 图片消息，
    //    patch 完全可能回 `code 0` 却什么都没改，旧代码据此记成 `card_updated`。
    //    ⚠️ 默认"读不到"（`not_wired`）= **不更新**：宁可不做，也不做一件看不见的事。
    //    ⚠️ 它只是**证据与闸门**，**不参与任何业务判据**（读不到也绝不影响入库/发卡）。
    this.getMessageMeta = getMessageMeta || (async () => ({ ok: false, reason: 'not_wired' }));
    // 配置从配置模块取；传进来的（测试/多租户）按**字段**覆盖，不会把没覆盖的项变成 undefined。
    const defaults = resolveArrivalConversationConfig();
    this.config = config
      ? {
        ...defaults,
        ...config,
        card: {
          ...defaults.card,
          ...(config.card || {}),
          // ⚠️ 2026-10-12（清群聊入口 C1）：原先进来还有一层 `card.form`
          //    （输入框 / 提交按钮 / 降级文案）的嵌套合并 —— 那张表单只有群话题链路会发，
          //    入口已删除 ⇒ 配置项与这层合并一起退场。
        },
        replies: { ...defaults.replies, ...(config.replies || {}) },
        summary: { ...defaults.summary, ...(config.summary || {}) },
      }
      : defaults;
    this.now = now || (() => Date.now());
    // 同一批的核对串行：同一条话题里两条消息几乎同时到达时，
    // 不能让两边各读到旧 transcript 再互相覆盖（会把她说的话丢掉）。
    this.queue = new KeyedSerialQueue();
  }

  /** 这一批的报货批次号（任务上冻结的那个；没有就空串 —— 空串时不去改任何批次行）。 */
  taskBatchNo(task, draft = {}) {
    return String(task?.batch_no || draft?.batch_no || '').trim();
  }

  /**
   * 叫一声"这一批到货了"，并把所有失败吞成 warn。
   *
   * 🔴 **本方法永不抛**：到这一步「库存流水」+「实时库存」都已经写完了，
   *    批次状态写不回去只是"她那张表上没显示已到货"，绝不能把入库成功判成失败。
   *
   * ⚠️ 方法名与注入依赖名（`this.markBatchArrived`）**必须不同**：
   *    同名的话构造函数里那个实例属性会**静默覆盖**原型方法（AGENTS.md 记过这个坑）。
   */
  async notifyBatchArrived(batchNo, { correlation = {} } = {}) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) {
      logInfo('purchase.arrival.reconcile.batch_arrival_skipped', { reason: 'no_batch_no' });
      return { updated: false, reason: 'no_batch_no' };
    }
    try {
      return await this.markBatchArrived(wanted, { correlation });
    } catch (error) {
      logWarn('purchase.arrival.reconcile.batch_arrival_failed', {
        batch_no: wanted, error: error.message,
        hint: '入库已经成功；只是「采购主表」的到货状态没改成已到货（不影响库存与单据）',
      });
      return { updated: false, reason: 'failed', error: error.message };
    }
  }

  /**
   * 卡片动作入口。**只认「是」这一个动作名**，其余一律返回 null（交给别的链路）。
   *
   * @returns {Promise<{toast?: object}|null>}
   */
  async handleCardAction(value, event = {}, operatorOpenId = '') {
    const action = value?.action;
    // ⚠️⚠️ 2026-10-12（清群聊入口 C1）：这里原先还认 `REJECT`（卡片上的「否」）。
    //    那个动作只由**群话题那条对话链路**发出来的卡片提供，而那条入口已整体删除
    //    （业务的到货验收改由**工作台发起 + 扫码录入**，见 `confirmBatchArrival`）。
    //    ⇒ 那个分支（以及它调用的「不入库」实现）一起退场；**只留 `CONFIRM`（「是」）**。
    if (action !== ARRIVAL_CONVERSATION_ACTIONS.CONFIRM) return null;
    const taskId = String(value?.draft_id || '').trim();
    if (!taskId) throw new Error('到货核对卡片缺少任务 ID');
    return this.queue.run(taskId, () => this.confirmLocked(taskId, operatorOpenId, event));
  }
  async confirmLocked(taskId, operatorOpenId, event = {}, options = {}) {
    const { replies } = this.config;
    const task = await this.store.get(taskId);
    if (!task) {
      // ⭐ 2026-10-07：以前这里**只弹 toast**，她在话题里看不见任何东西 → 现在 patch 卡片 + 回文字。
      return this.visibleFailure({
        tier: 'task_missing', taskId, operator: operatorOpenId, event, task,
        copy: replies.taskMissing, logEvent: 'purchase.arrival.reconcile.task_missing',
      });
    }
    if (task.status === 'posted') {
      // 重复点「是」（双击 / 飞书重投）：**不重复入库**，如实回执。
      // ⭐ 2026-10-07：顺手把那张卡**再 patch 一次成绿色终态** —— 正常路径上它已经是终态，
      //    这一次是幂等的重试；万一上一次 patch 没改成，她这一次点击就能看见结果。
      logInfo('purchase.arrival.reconcile.confirm_duplicate', { task_id: taskId, operator_open_id: operatorOpenId || '' });
      return this.visibleAlreadyPosted({
        tier: 'confirm_duplicate', taskId, operator: operatorOpenId, event, task,
      });
    }
    if (!Array.isArray(task.plan) || !task.plan.length || !task.acceptance_text
      || !task.request_ids?.length || !task.request_rows?.length) {
      // 她说的话我们还没算出结果 → 同样不能只弹 toast（那是"点了没反应"的另一种样子）。
      return this.visibleFailure({
        tier: 'not_confirmed_yet', taskId, operator: operatorOpenId, event, task,
        copy: replies.notConfirmedYet, logEvent: 'purchase.arrival.reconcile.not_confirmed_yet',
        toastType: 'info',
      });
    }
    // ⭐⭐ 2026-10-08（业务负责人亲自批准）：**「实际金额」必填** —— 点「是」这条路
    //   **没有金额输入**（输入框在表单里），所以这一批**还没有金额**时：
    //     · 🔴 **不许**写一个空的「实际金额」（她的口径："必须让用户填"）；
    //     · 🔴 也**不许静默跳过** —— 明确把话指回表单那条路（可见失败：patch 卡 + 回文字）。
    //   ⚠️ 位置**在任何写入之前**（连 `status:'posting'` 都还没落）⇒ 这一批一个字都没动。
    //   ⚠️ 这**不是**放宽"提交"那条路的必填，而是它的对称面：金额只能从表单进来，
    //      而写库发生在「是」这一刻。
    if (!hasActualAmount(task)) {
      logWarn('purchase.arrival.reconcile.amount_missing', {
        task_id: taskId, batch_no: task.batch_no || '', operator_open_id: operatorOpenId || '',
        note: '点「是」但这一批还没有金额：不写空的「实际金额」、不写任何业务表，明确提示她先在表单里填',
      });
      return this.visibleFailure({
        tier: 'amount_missing', taskId, operator: operatorOpenId, event, task,
        copy: replies.amountMissingOnConfirm, logEvent: 'purchase.arrival.reconcile.amount_missing',
        toastType: 'info',
        // ⚠️ 橙色（不是红色）：这不是"核对失败"，而是"还差一步、她补上就能继续"
        //    —— 与"还没算出结果"那一条同理，别把中性状态说成失败。
        template: 'orange',
      });
    }
    const actualAmount = Number(task.actual_amount);
    // ⭐ 「实际数量」= **代码算出来的**实际到货数合计（`plan.rows` 的 `actual` 求和）。
    //    ⚠️ 与**库存口径一致**：`actual = 0` 的行不入库、但它们在这里加的是 **0**
    //       ⇒ "按全量求和"与"按实际入库的行求和"是**同一个数**（0 加不加都一样）。
    const actualQuantity = task.plan.reduce((sum, row) => sum + Number(row.actual || 0), 0);
    // ⭐ 2026-10-07 晚：这里原先会**新建「到货验收」一行**并落盘 `arrival_record_id`。
    //    那张表已被业务负责人删除，落点改到「报货批次」那一行 ⇒ 这一步整段删除：
    //      · 批次记录 id 本来就在任务上（`task.batch_record_id`，发图时从采购申请行读到的，
    //        见 `loadRequestRows` / `readBatchRecordId`）——不需要第二个 id 来定位那一行；
    //      · 拿不到它时，`confirmArrival` 里的 `writeAcceptance` 会按**批次号**回查，
    //        所以这里不再有"先建行再记住 id"的幂等窗口。
    const requests = [];
    for (const requestId of task.request_ids) {
      const record = await this.gateway.get('purchaseRequest', requestId).catch(() => null);
      if (record) requests.push(record);
    }
    // ⚠️ 这里的形状就是 confirmArrival 一直在等的草稿形状：
    //    actual = 按实际调整完的明细（每行一条 货品+尺码+实际双数）
    //    requests = 申请行原样（⚠️ 2026-10-07 深夜起**不再**用来挂「采购入库」的「采购申请」——
    //              那张表已被整表删除；仍然照传，因为到货核对卡片/建档还要用它的形状）
    //    pending_creation 空数组：到货的货品在建采购申请时就已经存在了，这里不建新品。
    // ⭐ 2026-10-07：`实际 = 0 双` 的行**到这里就被摘掉**，一张表都不写 ——
    //    不写任何入库明细、不调 inventory.applyPurchase（库存流水/实时库存都不动）。
    //    为什么在**建草稿这一步**摘（而不是塞给 confirmArrival 让它跳过）：
    //      · `PurchaseWebhookService.aggregateArrivalItems` 对 `quantity <= 0` **当场抛错**
    //        （那道闸门是给"数量无效"兜底的，不能放宽 —— 它同样拦着负数）；
    //      · 在源头摘掉，"没到"这个事实就只存在于**核对卡片 + 日志**里，
    //        下游入库能力完全不必认识"0 双"这个新概念（解耦：将来换入库实现也不受影响）。
    //    其它行（actual > 0）照常入库；全部是 0 时 postable 为空 —— 那是"一件都没到"，
    //    流程照样收尾（见 summary.postedNothingArrived），**不卡单**。
    const zeroRows = task.plan.filter((row) => Number(row.actual) === 0);
    const postableRows = task.plan.filter((row) => Number(row.actual) !== 0);
    const draft = {
      // ⭐ 到货信息的落点（2026-10-07 晚）：**报货批次的那一行**。
      //    `batch_record_id` 是发图时从采购申请行的「报货批次号」关联上读到的（可能为空——
      //    空时 `confirmArrival.writeAcceptance` 会按 `batch_no` 回查）。
      batch_record_id: String(task.batch_record_id || '').trim(),
      batch_no: task.batch_no || '',
      // 「验收原话」随草稿传给 confirmArrival —— 由它写进批次行（本类不写业务表）。
      acceptance_text: String(task.acceptance_text || ''),
      // ⭐⭐ 2026-10-08：这两个值也随草稿下去，由 `confirmArrival` → `writeAcceptance`
      //   在**同一次 update** 里写到「报货批次」那一行（本类自己仍然一张业务表都不写）：
      //     · actual_amount   = 她在卡片表单里填的**整批金额**（上面已校验：非空、非负、是数字）；
      //     · actual_quantity = **代码算出来的**实际到货数合计（与库存口径一致）。
      actual_amount: actualAmount,
      actual_quantity: actualQuantity,
      operator_open_id: String(task.operator_open_id || operatorOpenId || ''),
      requests,
      actual: postableRows.map((row) => ({
        product_record_id: row.product_record_id,
        item_no: row.item_no,
        color: row.color,
        size: row.size,
        quantity: row.actual,
      })),
      pending_creation: [],
    };
    await this.store.update(taskId, { status: 'posting', draft, confirmed_by: String(operatorOpenId || '') });
    const latest = await this.store.get(taskId);
    try {
      // ⭐ 2026-10-13（验收提速）：把验收那一段自造的 timing **原样透传**到入库实现
      //    （`inventory_ms` 只有库存层量得准）。不传 = 行为逐字不变。
      await this.confirmArrival(taskId, latest, operatorOpenId,
        options.timing ? { timing: options.timing } : {});
    } catch (error) {
      // 入库中途失败：**不改状态**（停在 posting），她再点一次「是」会从断点继续。
      // ⚠️ 错误原文**一个字都不吞**：日志（下面 `logError` 的 `error`）与**她要看到的那句话**
      //    （`{error}` 插值）里都带着它。返回的 toast 仍然是 `error`（不许把失败写成成功）。
      logError('purchase.arrival.reconcile.confirm_failed', { task_id: taskId, error: error.message });
      // ⭐ 2026-10-07：失败**必须在她点的那张卡片上看得见**（以前只有一行不带 `threadId` 的回话，
      //    她连着两次反馈「卡片点击后没有任何反应」）。
      return this.visibleFailure({
        tier: 'inbound_failed', taskId, operator: operatorOpenId, event, task, error,
        copy: formatCopy(this.config.replies.inboundFailed, { error: error.message }),
        logEvent: 'purchase.arrival.reconcile.confirm_failed',
      });
    }
    await this.store.update(taskId, { status: 'posted', posted_at: new Date(this.now()).toISOString() });
    // ⭐ 到货事实落地之后 → 把「报货批次」那一行的到货状态改成「已到货」
    //（业务负责人 2026-10-07：「**当用户在话题群里说了到货之后，状态应该改成「已到货」**」）。
    // ⚠️ 位置**必须在入库之后**：入库是事实，批次状态是它的投影 —— 反过来的话，
    //    写状态成功、入库失败，她会看到"已到货"而库存里没有这批货。
    // ⚠️ 它是**增强**：失败只记 warn，**绝不**把已经入库成功的一单判成失败
    //    （与"附件写回失败不阻塞主流程"同一条纪律）。
    await this.notifyBatchArrived(this.taskBatchNo(task, draft), { correlation: { task_id: taskId } });
    const total = draft.actual.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    // 回话模板（可配）：没有 0 行 → 与改动前逐字相同；有 0 行 → 说清"这些行没入库"；
    // 全是 0 行 → 不能写成"已入库 0 条"含糊过去，用专门那句。
    const summaryTemplate = zeroRows.length === 0
      ? this.config.summary.posted
      : (draft.actual.length === 0
        ? this.config.summary.postedNothingArrived
        : this.config.summary.postedWithZero);
    const summary = formatCopy(summaryTemplate, {
      rowCount: draft.actual.length,
      total,
      zeroCount: zeroRows.length,
      batchNo: task.batch_no || '（未知）',
    });
    // 明确反馈：**先把卡片改成终态，再在群里回一句结果**（业务负责人 2026-10-08：
    // 她要的是"原地更新卡片"，回话只是兜底 ⇒ 顺序 patch 在前、回话在后）。
    // 发不出去只记日志，业务事实已经落地。
    // ⚠️ 2026-10-07：回话补 `threadId` —— 她是在**群话题**里操作的，回复必须落回那条话题
    //    （少了它就发到主群洪流里，她一样"看不到"）。
    const cardMessageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id || '';
    const cardPatched = await this.safeUpdateCard(
      cardMessageId,
      purchaseArrivalReconcileStatusCard({ batchNo: task.batch_no || '', message: summary, template: 'green' }),
      // 下面紧接着就回这句结果（同一句话），所以这里不再叠一句"卡片没刷新成功"。
      { task, taskId, replyOnFailure: false },
    );
    await this.safeReplyText(this.replyTarget(event, task), summary, this.threadOptions(task));
    // ⭐ 正向证据：成功之后**卡片到底改没改成**也留痕（改不动时她那边的现象就是"点了没反应"）。
    logInfo('purchase.arrival.reconcile.success_notice', {
      task_id: taskId, card_message_id: cardMessageId, card_patched: cardPatched,
    });
    // ⭐ 正向证据：这些行**没有**入库（不是"看起来没写"，是把该写多少写进日志）。
    //    与 `purchase.arrival.reconcile.posted` 一起看，就能核清"0 双的行到底动没动库存"。
    if (zeroRows.length) {
      logInfo('purchase.arrival.reconcile.zero_actual_skipped', {
        task_id: taskId, batch_no: task.batch_no || '',
        zero_actual_count: zeroRows.length,
        rows: zeroRows.map((row) => ({
          item_no: row.item_no, color: row.color, size: row.size, quantity: row.quantity, actual: 0,
        })),
        inbound_rows_written: 0,
        inventory_apply_calls: 0,
        note: '实际 0 双的行：不入库、不写库存流水（业务负责人 2026-10-07 口径）',
      });
    }
    logInfo('purchase.arrival.reconcile.posted', {
      task_id: taskId, batch_no: task.batch_no || '',
      // ⭐ 2026-10-07 晚：键从 `arrival_record_id`（「到货验收」那条记录）换成
      //    `batch_record_id`（到货信息现在的落点 = 「报货批次」那一行）。
      batch_record_id: draft.batch_record_id || '',
      // row_count = 这次核对**一共几行**（含没到的），posting 的口径看下面两个字段。
      row_count: task.plan.length,
      posted_row_count: draft.actual.length,
      skipped_zero_count: zeroRows.length,
      skipped_zero_rows: zeroRows.map(rowLabel),
      total_quantity: total,
      // ⭐⭐ 2026-10-08：这两个值就是这次写到「报货批次」那一行的「实际数量」「实际金额」
      //   （正向证据：日志能直接回答"到底写了什么数"，而不用去表里翻）。
      actual_quantity: actualQuantity,
      actual_amount: actualAmount,
      // 「报货信息」（采购申请表）在这条链路上**一个字都没写**——这是断言钉住的口径。
      purchase_request_writes: 0,
      // ⭐ 2026-10-07 深夜：「采购入库」表被整表删除 ⇒ 这次确认**没有**任何入库明细行；
      //    库存照加，写的就是上面 summary 里那个实际数。
      inbound_rows_written: 0,
    });
    // ⚠️ 只回自己的 toast：`confirmArrival` 返回的 toast 是"给卡片点的人看的一句话"，
    //    和这里这句"按实际到货入库"是两回事，展开到前面会把它盖掉（踩过一次）。
    return { toast: { type: 'success', content: summary } };
  }

  /**
   * ⭐⭐ 2026-10-09（业务负责人当天 15:07 定的「订单列表 · 采购」子 tab：
   *   「**采购**，按照**采购订单**，有**验收到货**的按钮」）：
   *   工作台那个「验收到货」按钮的**服务端入口**。
   *
   * 🔴 这个方法**不实现任何入库 / 写库逻辑**，它只做三件"翻译"的事：
   *   ① 读这一批的申请行 —— 复用**既有** `loadRequestRows`（同一个只读实现，
   *      退货行没有尺码那条数据闸门也照旧生效）；
   *   ② 「全部按申请数到货」 —— 复用**既有** `buildPlan(rows, { same: true, differences: [] })`
   *      （不新增第二条"算实际到货"的算法）；
   *   ③ 把结果种进**同一批**的会话任务（task id 用同一个 `taskIdForBatch`），
   *      然后调**既有** `confirmLocked` —— 建草稿、写「验收原话 / 实际数量 / 实际金额」、
   *      逐条 `inventory.applyPurchase`、写「确认状态」「到货状态」**全部还是那一份实现**。
   *
   * 🔴 为什么不直接调 `PurchaseWebhookService.confirmArrival`：
   *    它读的是**任务上的草稿**，草稿由 `confirmLocked` 按核对计划建。绕过它 = 自己拼草稿、
   *    自己拼入库明细 = **第二套写库逻辑**（明令禁止）。
   *
   * ⚠️ 「实际金额」**必填**（业务负责人 2026-10-08：「金额这个是必填的，必须让用户填」）
   *    —— 工作台表单收的就是它；缺失 / 非数字 / 0 / 负数一律**一个字都不写**（与卡片
   *    表单那条路**同一个** `parseActualAmount`）。
   * ⚠️ 「到货说明」（本地草稿里的 `acceptance_text`，也是**她给的**，默认值由前端配置给）：
   *    这里**不替她编一句话**，空了就拒绝 —— 它是**解析实际到货情况的输入**。
   *    ⚠️ 2026-10-09：这一段文字**不再落进表里**（那一列在真表上没有了），
   *      仍然逐字留在本地任务草稿上，供解析与排查复读。
   * ⚠️ 串行：与群话题那条路**共用同一个 `this.queue`**（同一批不会被两条路同时写）。
   *
   * @returns {Promise<{ok: boolean, reason?: string, message: string, taskId?: string}>}
   *   `message` 是**给人看的一句话**（工作台直接显示它），不是内部术语。
   */
  async confirmBatchArrival({ batch, acceptanceText = '', actualAmount, operatorOpenId = '', scanLines = null, timing = null,
    // ⭐ 2026-10-16（她逐字「数据表里已经没有验收原话了…你必须得删」＋ Lead 裁决 ⓐ）：
    //   那条「必须有原话」的判据**收窄成由调用方声明** —— 扫码线显式 true（判据一字不变 ✗），
    //   工作台那条不传（它已经没有那个输入框了 ⇒ 不再要求、也不再写那一列 ✓）
    requireAcceptanceText = false } = {}) {
    const batchNo = String(batch?.batch_no || '').trim();
    if (!batchNo) {
      return { ok: false, reason: 'no_batch_no', message: pageMessages.m1 };
    }
    const amount = parseActualAmount(actualAmount);
    if (!amount.ok) {
      return {
        ok: false,
        reason: amount.reason,
        message: amount.reason === 'amount_missing'
          ? pageMessages.m2
          : pageMessages.m3,
      };
    }
    const text = String(acceptanceText == null ? '' : acceptanceText).trim();
    // 🔴 扫码线照样必须非空（它自己声明 requireAcceptanceText: true ⇒ 判据一字不变 ✗）
    if (!text && requireAcceptanceText) {
      return {
        ok: false,
        reason: 'acceptance_text_missing',
        message: pageMessages.m4,
      };
    }
    // ⭐⭐ 2026-10-11（方案A）：**扫码验收**走这里 —— `scanLines` = 逐码实际到货（她扫了什么）。
    //    ⚠️ 这是**加法**：不传 `scanLines` 时下面每一行与改动前**逐字相同**（工作台既有那条
    //    「全额验收」表单与群话题对话链路都还在用它）。
    const scans = Array.isArray(scanLines) ? scanLines : null;
    if (scans && !scans.length) {
      return { ok: false, reason: 'no_scan_lines', message: this.scanRowsMessage('no_scan_lines') };
    }
    const taskId = taskIdForBatch(batchNo);
    const existing = await this.store.get(taskId).catch(() => null);
    if (existing?.status === 'posted') {
      // 已经入过库：**一个字都不写**，如实告诉她（与群话题那条路同一个判据）。
      logInfo('purchase.arrival.reconcile.workbench_already_posted', { task_id: taskId, batch_no: batchNo });
      return {
        ok: true, reason: 'already_posted', taskId,
        message: pageMessages.m5({ batchNo }),
      };
    }
    return this.queue.run(taskId, async () => {
      // ⭐⭐ P0 2026-10-12（真机：同一批两次提交 ⇒ 每个尺码各 +2 ⇒ 5 双变 10 双）：
      //    **队列是按 taskId 串行的**（`KeyedSerialQueue`）⇒ 第二次进来时必须**在锁内**再看一眼状态。
      //    外面那次 `existing?.status === 'posted'` 是**顺序**检查 —— 拦得住"上一次已完成"，
      //    **拦不住两个请求同时进来**（两份都通过了外面的检查，再各自跑完 ✗）。
      const locked = await this.store.get(taskId).catch(() => null);
      if (locked?.status === 'posted') {
        logInfo('purchase.arrival.reconcile.workbench_already_posted', {
          task_id: taskId, batch_no: batchNo, where: 'locked',
        });
        return {
          ok: true, reason: 'already_posted', taskId,
          message: `这批（${batchNo}）已经验收入库过了，没有重复入库`,
        };
      }
      // ① 读申请行（既有只读实现；退货行没有尺码会在这里被挡住）
      const snapshot = await this.loadRequestRows(batch);
      if (!snapshot.ok) {
        logWarn('purchase.arrival.reconcile.workbench_rows_unavailable', {
          task_id: taskId, batch_no: batchNo, reason: snapshot.reason,
        });
        return { ok: false, reason: snapshot.reason, taskId, message: this.workbenchRowsMessage(snapshot.reason) };
      }
      // ② 「全部按申请数到货」（既有纯函数，工作台那条路）／**逐码实际到货**（扫码验收那条路）
      //    ⚠️ 两条路都是**同一个纯函数 `buildPlan`** —— 不为扫码再写一套"算实际到货"的算法。
      const plan = scans
        ? this.buildPlan(snapshot.rows, { scanLines: scans })
        : this.buildPlan(snapshot.rows, { same: true, differences: [] });
      if (!plan.ok) {
        logWarn('purchase.arrival.reconcile.workbench_plan_failed', {
          task_id: taskId, batch_no: batchNo, reason: plan.reason,
        });
        return {
          ok: false,
          reason: plan.reason,
          taskId,
          message: scans ? this.scanRowsMessage(plan.reason) : this.workbenchRowsMessage(plan.reason),
        };
      }
      // ③ 种任务（形状与"卡片核对算完之后"那一份逐字对齐；接着走既有 confirmLocked）
      const seed = {
        type: TASK_TYPE,
        batch_no: batchNo,
        batch_record_id: String(batch?.batch_record_id || snapshot.batchRecordId || '').trim(),
        request_ids: snapshot.requestIds,
        request_rows: snapshot.rows,
        plan: plan.rows,
        differences: plan.differences,
        acceptance_text: text,
        actual_amount: amount.value,
        status: 'awaiting_confirmation',
        source: scans ? 'scan' : 'workbench',
        operator_open_id: String(operatorOpenId || existing?.operator_open_id || ''),
      };
      if (existing) await this.store.update(taskId, seed);
      else await this.store.create({ task_id: taskId, ...seed, transcript: [] });
      logInfo(scans ? 'purchase.arrival.reconcile.scan_seeded' : 'purchase.arrival.reconcile.workbench_seeded', {
        task_id: taskId, batch_no: batchNo, row_count: plan.rows.length,
        actual_amount: amount.value,
        ...(scans ? { scan_count: scans.length, scanned_quantity: plan.rows.reduce((sum, row) => sum + Number(row.actual || 0), 0) } : {}),
        note: scans
          ? '扫码验收：逐码实际到货种进与群话题同一个任务，接着走既有 confirmLocked'
          : '工作台「验收到货」：种进与群话题同一个任务，接着走既有 confirmLocked',
      });
      const result = await this.confirmLocked(taskId, operatorOpenId, {}, { timing });
      const failure = result?.toast?.type === 'error';
      const message = result?.toast?.content || '';
      return { ok: !failure, reason: failure ? 'inbound_failed' : 'posted', taskId, message };
    });
  }

  /**
   * 「读不到 / 算不出」时的**人话**（工作台直接显示）。
   * ⚠️ 每个 reason 都对得上一条**数据事实**，不糊成"系统错误"；认不出的 reason 也要给一句话。
   */
  workbenchRowsMessage(reason) {
    const copy = {
      no_request_ids: landingMessages.m1,
      too_many_request_rows: landingMessages.m2,
      request_rows_unreadable: landingMessages.m3,
      request_row_without_product: landingMessages.m4,
      request_row_without_size: landingMessages.m5,
      request_row_bad_quantity: landingMessages.m6,
      actual_not_positive: landingMessages.m7,
      difference_unmatched: landingMessages.m8,
    };
    return copy[reason] || landingMessages.m9;
  }

  /**
   * ⭐ 2026-10-11（方案A）：「**扫码验收**」那条路的**人话**（与工作台那条分开一份 ——
   * 同 reason 在两边的说法不同：一边是"这一批读不到"，一边是"这一双不在本批/重复扫了"）。
   */
  scanRowsMessage(reason) {
    const copy = {
      no_scan_lines: scanMessages.m1,
      scan_not_in_batch: scanMessages.m2,
      scan_duplicated: scanMessages.m3,
      duplicate_request_rows: scanMessages.m4,
      actual_not_positive: scanMessages.m5,
      no_request_ids: scanMessages.m6,
      request_rows_unreadable: scanMessages.m7,
      request_row_without_product: scanMessages.m8,
      request_row_without_size: scanMessages.m9,
      request_row_bad_quantity: scanMessages.m10,
      too_many_request_rows: scanMessages.m11,
    };
    return copy[reason] || scanMessages.m12;
  }

  // ── 已删除（2026-10-07 晚）：`createArrivalRecord` / `findExistingArrival` ──────────
  //
  // 两个方法都在往**已被业务负责人删除的**「到货验收」表里建行 / 回查：
  //   · `createArrivalRecord`：写「报货批次号」+「验收原话」+「验收人」，并做
  //     "同批次 + 同原话先回查再创建"的幂等；
  //   · `findExistingArrival`：上面那个回查。
  // 落点搬到「报货批次」那一行之后：
  //   · 落点是**更新**已有的那一行，不是新建 ⇒ 不再有"重复建行"这回事，
  //     幂等也由"写同一个值"天然保证（`PurchaseOrderBatchService.writeAcceptance`）；
  //   · 「验收人」在真表上是**创建人**（自动字段）⇒ 代码不写（原来那次
  //     `UserFieldConvFail` 退一步重试的补丁随之删除，连同 `person` / `relation` 依赖）；
  //   · 批次行的维护归 `PurchaseOrderBatchService`（本类一个业务表都不写）。

  /**
   * 把她说的话算成"实际到货"。
   *
   * 三类差异（业务负责人 2026-10-06 定的，**只有这三类**）：
   *   · 完全一样（`same: true`）→ 实际 = 申请数；
   *   · 比申请多 → 实际 = 申请数 + 她说的双数；
   *   · 比申请少 → 实际 = 申请数 − 她说的双数。
   *
   * ⭐ `实际 = 0`（业务负责人 **2026-10-07 当面纠正**，逐字：
   *   「**如果这个尺码算下来为 0，那么就不用入库啊！**」）：
   *   **放行**——它是"少"这条差异算出来的**正常结果**（供应商漏发一整双）。
   *   该行由调用方在入库那一步摘掉（不入库、不写库存流水），**不阻断整单**。
   *
   * ⚠️ 仍然拦住的是**负数**（她说少的双数比这行申请数还多）：
   *   那不是事实、只可能是口误/听错，**既不放行、也不静默夹成 0**（夹成 0 等于替她编
   *   一行"没到"）；reason 维持 `actual_not_positive`（既有断言钉住这个取值），
   *   回话由调用方换成"算出来是负数"那一句（见 `replies.negative`）。
   *
   * @returns {{ok: true, rows: Array, differences: Array} | {ok: false, reason: string}}
   */
  buildPlan(rows, parsed) {
    // ⭐⭐ 2026-10-11（方案A · 扫码验收）：**逐码实际到货**。
    //    `parsed.scanLines = [{ product_record_id, size, quantity }]`（她扫到的那些货）。
    //    · 按 **(货品 record_id, 尺码)** **精确**匹配申请行（不是按尺码单挑 —— 一批里
    //      可能有两个货品都是 38 码）；
    //    · **没扫到的行 = 0** ⇒ 调用方在入库那一步摘掉（"少发的"自然就是差异）；
    //    · 命中多行 / 扫到本批没有的货 / 同一行被两条扫码行命中 ⇒ **拦住**（宁可不入库，
    //      也不能把实际数记到别的行上）。
    //    ⭐⭐ 2026-10-12（她口述版的"自定义"）：**没报过的尺码**只要是**本批的款**就允许
    //      —— 见下面 `extra` 那一段（款不认识 ⇒ 照旧 `scan_not_in_batch`，不猜 ✗）。
    if (parsed.scanLines) {
      const keyOf = (productRecordId, size) => `${productRecordId}|${Number(size)}`;
      const byKey = new Map();
      for (const row of rows) {
        const key = keyOf(row.product_record_id, row.size);
        // 同一 (货品, 尺码) 在申请里有两行 ⇒ 不确定这笔到货算哪一行 ⇒ 拦住
        if (byKey.has(key)) return { ok: false, reason: 'duplicate_request_rows' };
        byKey.set(key, row);
      }
      const actualById = new Map(rows.map((row) => [row.request_record_id, 0]));
      const hit = new Set();
      // ⭐⭐ 2026-10-12（Lead 裁定 · 口径照业务负责人原话）：
      //   「**自定义加进来的尺码，必须能归到"她扫进来的那一款"**」——
      //   她可以在清单里"自定义加一行"（**没报过、但到了**的尺码）：
      //     · **允许**：该行挂的**款**（`product_record_id`）**出现在这一批的申请行里**
      //       ⇒ 它归到"她本次确认的那一款"，**计入**（下面那条 extra 行）；
      //     · **拦住**：款根本不在这批里（不认识的款）/ 没款可归 ⇒ `scan_not_in_batch`
      //       —— 🔴 **绝不猜款**（猜到别的款上 = 库存加错人头，比让她扫一下坏得多）。
      //   ⚠️ 这是**加法**：没有自定义行时，下面每一行与改动前**逐字相同**（顺序 / 字段 / 长度）。
      const knownProducts = new Set(rows.map((row) => row.product_record_id).filter(Boolean));
      const extra = [];
      const extraKeys = new Set();
      for (const scan of parsed.scanLines) {
        const row = byKey.get(keyOf(scan?.product_record_id, scan?.size));
        if (!row) {
          // 不是申请行 ⇒ 只可能是"自定义加进来的那一行"：款必须是本批的款。
          if (!knownProducts.has(scan?.product_record_id)) {
            return { ok: false, reason: 'scan_not_in_batch' };
          }
          const quantity = Number(scan?.quantity);
          // 0 / 负数 / 非整数 ⇒ 不静默写成 0 双（与"申请行"那一侧同一条口径）。
          if (!Number.isSafeInteger(quantity) || quantity <= 0) {
            return { ok: false, reason: 'actual_not_positive' };
          }
          const key = keyOf(scan?.product_record_id, scan?.size);
          if (extraKeys.has(key)) return { ok: false, reason: 'scan_duplicated' };
          extraKeys.add(key);
          extra.push({
            // ⭐ 没有申请行：`request_record_id` 留空 ⇒ 下游（写回 / 建草稿）天然不会去动"不存在的那一行"，
            //    入库那一步只认 `product_record_id` + `size` + `actual`（见 `confirmLocked` 的 `draft.actual`）。
            request_record_id: '',
            product_record_id: scan.product_record_id,
            item_no: '',
            color: '',
            size: Number(scan.size),
            quantity: 0,
            actual: quantity,
            custom: true,
          });
          continue;
        }
        if (hit.has(row.request_record_id)) return { ok: false, reason: 'scan_duplicated' };
        hit.add(row.request_record_id);
        actualById.set(row.request_record_id, Number(scan.quantity));
      }
      const scanned = rows.map((row) => ({ ...row, actual: actualById.get(row.request_record_id) }));
      if (scanned.some((row) => !Number.isSafeInteger(row.actual) || row.actual < 0)) {
        return { ok: false, reason: 'actual_not_positive' };
      }
      return { ok: true, rows: [...scanned, ...extra], differences: [] };
    }
    const actualById = new Map(rows.map((row) => [row.request_record_id, row.quantity]));
    if (parsed.same) {
      return { ok: true, rows: rows.map((row) => ({ ...row, actual: row.quantity })), differences: [] };
    }
    const differences = [];
    for (const diff of parsed.differences || []) {
      // 命中行：尺码必须匹配；货号/颜色她说了就必须也对上。
      // 命中不唯一（或一条都没命中）→ 整单不入库：宁可让她再说一遍，也不能把差异记到别的行上。
      const matches = rows.filter((row) => Number(row.size) === Number(diff.size)
        && (!diff.item_no || String(row.item_no) === String(diff.item_no))
        && (!diff.color || String(row.color) === String(diff.color)));
      if (matches.length !== 1) return { ok: false, reason: 'difference_unmatched' };
      const row = matches[0];
      const delta = diff.type === 'more' ? diff.quantity : diff.type === 'less' ? -diff.quantity : 0;
      actualById.set(row.request_record_id, actualById.get(row.request_record_id) + delta);
      differences.push({
        item_no: row.item_no, color: row.color, size: row.size,
        type: diff.type, quantity: diff.quantity, request_record_id: row.request_record_id,
      });
    }
    const plan = rows.map((row) => ({ ...row, actual: actualById.get(row.request_record_id) }));
    // ⚠️ 只拦"算不出来 / 负数"：`actual === 0` 是**允许**的（2026-10-07 口径）。
    if (plan.some((row) => !Number.isSafeInteger(row.actual) || row.actual < 0)) {
      return { ok: false, reason: 'actual_not_positive' };
    }
    return { ok: true, rows: plan, differences };
  }

  /**
   * 读这批的采购申请明细（**只读**）。
   *
   * 从哪来：群消息映射记录里的 `request_ids`（发采购单进群时记的），
   * 每条申请行再读出「编号」「尺码」「数量」，并按货品记录补上「货号」「颜色」
   *（模型要能看到货号和颜色，才能把"少了两双 38"对到具体一行上）。
   *
   * ⚠️ 采购退货单也在同一张表里，但**退货行没有尺码**——这里直接判不可核对，
   * 所以即使批次类型标记缺失，也不会把退货话题当成到货核对。
   */
  async loadRequestRows(batch) {
    const requestIds = [...new Set((batch?.request_ids || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (!requestIds.length) return { ok: false, reason: 'no_request_ids' };
    if (requestIds.length > this.config.maxRequestRows) return { ok: false, reason: 'too_many_request_rows' };
    const requestTable = this.gateway.table('purchaseRequest');
    const raw = [];
    for (const recordId of requestIds) {
      const record = await this.gateway.get('purchaseRequest', recordId).catch(() => null);
      if (record) raw.push(record);
    }
    if (!raw.length) return { ok: false, reason: 'request_rows_unreadable' };
    const rows = [];
    for (const record of raw) {
      const productRecordId = linkedRecordIds(record.fields?.[requestTable.fields.product])[0] || '';
      if (!productRecordId) return { ok: false, reason: 'request_row_without_product' };
      let size = null;
      try {
        size = (await this.getSizeReferences().resolveLinkedCell(record.fields?.[requestTable.fields.size]))?.size ?? null;
      } catch (error) {
        return { ok: false, reason: 'request_row_without_size' };
      }
      if (!Number.isSafeInteger(Number(size)) || Number(size) <= 0) return { ok: false, reason: 'request_row_without_size' };
      const quantity = Number(textValue(record.fields?.[requestTable.fields.quantity]));
      if (!Number.isSafeInteger(quantity) || quantity <= 0) return { ok: false, reason: 'request_row_bad_quantity' };
      rows.push({
        request_record_id: record.record_id,
        product_record_id: productRecordId,
        size: Number(size),
        quantity,
        item_no: '',
        color: '',
      });
    }
    const productTable = this.gateway.table('product');
    const productCache = new Map();
    for (const row of rows) {
      if (!productCache.has(row.product_record_id)) {
        const record = await this.gateway.get('product', row.product_record_id).catch(() => null);
        productCache.set(row.product_record_id, {
          item_no: textValue(record?.fields?.[productTable.fields.itemNo]),
          color: textValue(record?.fields?.[productTable.fields.color]),
        });
      }
      const product = productCache.get(row.product_record_id);
      row.item_no = product.item_no;
      row.color = product.color;
    }
    return {
      ok: true,
      rows,
      requestIds: rows.map((row) => row.request_record_id),
      batchRecordId: this.readBatchRecordId(raw, requestTable),
    };
  }

  /** 「报货批次号」关联：从申请行上读；读不到就返回空串（本次不挂批次关联，但不影响入库）。 */
  readBatchRecordId(rawRequests, requestTable) {
    for (const record of rawRequests) {
      const linked = linkedRecordIds(record.fields?.[requestTable.fields.batchNo])[0];
      if (linked) return linked;
    }
    return '';
  }

  replyTarget(event, task) {
    return event?.context?.open_message_id || event?.open_message_id || task?.card_message_id || '';
  }

  /**
   * 回复这条消息时要带的话题上下文。
   *
   * ⭐ 2026-10-07（她第二次说「卡片点击后没有任何反应」）：**卡片点击没有 `thread_id`**，
   *    但对话任务上记着它是从哪个话题起的（`task.thread_id`，见 handleTopicMessageLocked）。
   *    把它交给飞书发送适配器 → 带 `reply_in_thread` → 回复落回**她正在看的那个话题**。
   *    任务上没有话题（主群 @ 进来的）→ 空对象，行为与改动前逐字相同。
   */
  threadOptions(task) {
    const threadId = textValue(task?.thread_id);
    return threadId ? { threadId } : {};
  }

  /**
   * 🔴 **失败的可见反馈**（业务负责人 2026-10-07 连着两次：「卡片点击后也是没有任何反应」）。
   *
   * 以前失败的出口是「一行日志 + 一句不带 `threadId` 的回话 + 一个一闪而过的 toast」，
   * 卡片**原样不动** ⇒ 她的结论就是"点了没反应"。现在两条腿一起走：
   *   ① **把那张卡片 patch 成终态**（红色，标题 `card.failedTitle`）—— 就在她点的地方，跑不掉；
   *   ② **回一句同样的话**（带 `threadId`，落回本话题）—— 卡片改不动时的兜底。
   * 两者都失败也不隐藏：各记一条 `*_failed` 警告 + 下面这条 `failure_notice` 里如实写
   * `card_patched` / `replied`，排查时能直接看出"她到底看没看到"。
   *
   * ⚠️ 这里**只负责"让她看见"**：错误原文原样带上（调用方用 `{error}` 插值），
   *    **绝不**吞掉、**绝不**把失败说成成功；返回的 toast 仍是 `error`（除非调用方显式指定
   *    为非错误的 `toastType`，例如"还没算出结果"）。
   */
  async visibleFailure({
    tier, taskId, operator = '', event = {}, task = null, copy,
    logEvent = '', error = null, toastType = 'error', template = 'red',
  } = {}) {
    // "还没算出结果"不是错误，只是要她再说一句：卡片用橙色，别把中性状态说成失败。
    const headerTemplate = tier === 'not_confirmed_yet' ? 'orange' : template;
    const messageId = this.replyTarget(event, task);
    const cardPatched = await this.safeUpdateCard(messageId, purchaseArrivalReconcileStatusCard({
      batchNo: task?.batch_no || '',
      message: copy,
      template: headerTemplate,
      title: this.config.card.failedTitle,
      // ⚠️ 下面紧接着就用**同一句**回话（失败本来就要回到话题里）⇒ 这里不再叠一句
      //    "卡片没刷新成功"，免得她一次点击收到两句。
    }), { task, taskId, replyOnFailure: false });
    const replied = await this.safeReplyText(messageId, copy, this.threadOptions(task));
    // ⭐ 正向证据：她"应该看到"的东西与"实际发出去"的东西都写下来。
    //    ⚠️ 与调用方那条 error 级日志（如 `purchase.arrival.reconcile.confirm_failed`）**并存**，
    //    不是替换 —— 错误原文仍然在 error 日志里。
    logInfo('purchase.arrival.reconcile.failure_notice', {
      tier,
      task_id: taskId,
      operator_open_id: operator || '',
      card_message_id: messageId,
      card_patched: cardPatched,
      replied,
      log_event: logEvent,
      error: error ? error.message : '',
      // 业务事实：失败**不写**入库、状态停在可重试的位置（由调用方保证）。
      tables_written: 0,
    });
    return { toast: { type: toastType, content: copy } };
  }

  /**
   * 「这一批已经入过库了」的可见终态（重复点「是」/ 已入库之后又点「否」）。
   *
   * 与 `visibleFailure` 的区别：这不是失败，卡片用**绿色**；也**不回文字**
   *（她只是重复点了一次，不必再刷一条消息），只把卡片**幂等地**再改成终态 ——
   * 上一次 patch 万一没成功，这一次点击就能看见。
   */
  async visibleAlreadyPosted({ tier, taskId, operator = '', event = {}, task = null } = {}) {
    const copy = this.config.replies.alreadyPosted;
    const messageId = this.replyTarget(event, task);
    const cardPatched = await this.safeUpdateCard(messageId, purchaseArrivalReconcileStatusCard({
      batchNo: task?.batch_no || '',
      message: copy,
      template: 'green',
    }), { task, taskId });
    logInfo('purchase.arrival.reconcile.success_notice', {
      tier, task_id: taskId, operator_open_id: operator || '',
      card_message_id: messageId, card_patched: cardPatched, replied: false,
    });
    return { toast: { type: 'info', content: copy } };
  }

  /**
   * 回一句话到那条消息。
   * ⭐ ④ `options.threadId` 非空 = 这条消息在**话题**里 → 让飞书发送适配器带
   * `reply_in_thread` 把它回到**同一个话题**（采购单/图是发群的，后续对话也必须回话题）。
   * 不传 / 为空（主群 @ 进来）时与改动前逐字相同。
   */
  async safeReplyText(messageId, content, options = {}) {
    if (!messageId || !content) return false;
    try {
      await this.replyText(messageId, content, options);
      return true;
    } catch (error) {
      // 回不出去（缺权限、消息被撤回）绝不能把业务判失败：日志留痕，业务事实已经落地。
      logWarn('purchase.arrival.reconcile.reply_failed', { message_id: messageId, error: error.message });
      return false;
    }
  }

  /**
   * 读一眼**一条已经存在的消息**到底是什么（只读，`im.v1.message.get`）。
   *
   * 🔴 这个方法的唯一职责是回答"我能不能安全地 patch 它"：
   *   `im.v1.message.patch` 官方文档写着"**仅支持更新卡片（消息类型为 `interactive`）**"，
   *   可错误码表里**没有**"目标不是卡片"这一条（只有 230001 参数错 / 230011 已撤回 /
   *   230031 超 14 天 / 230110 已删除 / 230027 无权限…）⇒ 对一条文字消息它可能回
   *   `code 0` 却什么都没改。**判据必须落在"读一次事实"上，不能靠猜。**
   *
   * ⚠️ **本方法永不抛**：读不到（缺权限 / 网络 / 没接线）一律返 `{ ok: false, reason }`，
   *    由调用方决定"拿不准就不动手"。
   *
   * @returns {Promise<{ok: boolean, reason?: string, error?: string,
   *   msgType?: string, deleted?: boolean, updated?: boolean, threadId?: string}>}
   */
  async readMessageMeta(messageId) {
    const id = String(messageId || '').trim();
    if (!id) return { ok: false, reason: 'no_message_id' };
    try {
      const meta = await this.getMessageMeta(id);
      if (!meta || meta.ok === false) {
        return { ok: false, reason: (meta && meta.reason) || 'unavailable', error: (meta && meta.error) || '' };
      }
      return {
        ok: true,
        msgType: String(meta.msgType || ''),
        deleted: Boolean(meta.deleted),
        // ⚠️ `updated` 只作**证据**（刚 patch 完能不能立刻读到它变 true 没在真机验过），
        //    不作任何业务判据 —— 见 `docs/arrival-card-visibility-2026-10-07.md` 第 10 节。
        updated: meta.updated === true,
        threadId: String(meta.threadId || ''),
      };
    } catch (error) {
      return { ok: false, reason: 'call_failed', error: error.message };
    }
  }

  /**
   * ⭐ **刚发出去的那张卡片**的客观证据（只读一次 `im.v1.message.get`）。
   *
   * 要回答的就是她那句「话题里根本没有卡片」：日志里从此有
   * `card_message_id`（发的是哪条）· `card_msg_type`（**读回来的事实**是不是 `interactive`）·
   * `card_deleted`（有没有被撤回）· `card_thread_id` / `card_thread_match`
   *（卡片落的话题 = 她这次说话的话题吗 —— 真机那次事故一眼就能看出来）。
   *
   * ⚠️ 读不到也**不判失败**：飞书已经回了 `message_id`（`code = 0`），卡片就是发出去了的；
   *    这里只如实记 `card_msg_type_source: 'unavailable'` + 原因，**不猜**。
   */
  async cardEvidence(cardMessageId, threadId) {
    const meta = await this.readMessageMeta(cardMessageId);
    if (!meta.ok) {
      return {
        msgType: '', source: 'unavailable', reason: meta.reason,
        deleted: null, threadId: '', threadMatch: null,
      };
    }
    const wanted = String(threadId || '');
    return {
      msgType: meta.msgType,
      source: 'message_get',
      reason: '',
      deleted: meta.deleted,
      threadId: meta.threadId,
      // `false` = 卡片落到了**别的话题**；`null` = 有一边没给到话题 id（判不了，不猜）。
      threadMatch: wanted && meta.threadId ? meta.threadId === wanted : null,
    };
  }

  /**
   * 把**上一张核对卡片**尽力作废（按钮收掉、写明"用最新那张"）。
   *
   * ⭐⭐ 为什么必须先读一眼再动它（2026-10-07 真机事故的正面答案）：
   *   改前是**无条件** patch `task.card_message_id` 指向的那条消息 —— 它可能
   *   ① 是一条**文字/图片消息**（patch 回 `code 0` 却什么都没改，日志却记成 `card_updated`）；
   *   ② 是**另一个话题**里那张卡（她那边照样什么都看不到）。
   *   ⇒ 这里三道闸门：**先读一眼确认 `msg_type === 'interactive'` 且未被撤回** →
   *     patch → **再读一眼校验**（`updated`）。读不到就**不动手**（宁可不做）。
   *
   * ⚠️ 它**永远不参与**"卡片发出去没有"这件事：新卡在这之前就已经发出去了
   *   （见 `handleTopicMessageLocked` 的发卡那一段）⇒ 作废失败只是"话题里多留一张旧卡"，
   *   记 `card_supersede_failed` 即可，**绝不影响**她这一轮的交付物。
   *
   * @returns {Promise<{attempted: boolean, result: 'ok'|'skipped'|'failed'|'none', reason?: string}>}
   */
  async retirePreviousCard(previousCardMessageId, { taskId = '', batchNo = '', newCardMessageId = '' } = {}) {
    const id = String(previousCardMessageId || '').trim();
    if (!id) return { attempted: false, result: 'none', reason: 'no_previous_card' };
    if (id === String(newCardMessageId || '').trim()) {
      return { attempted: false, result: 'none', reason: 'same_message' };
    }
    // ① 闸门：只在目标**确实是卡片**时才动手。
    const meta = await this.readMessageMeta(id);
    if (!meta.ok) {
      logWarn('purchase.arrival.reconcile.card_supersede_skipped', {
        task_id: taskId, card_message_id: id, reason: meta.reason, error: meta.error || '',
        note: '读不到那条消息是什么（缺权限/网络）⇒ 拿不准就不动它；新卡已经发出去了',
      });
      return { attempted: false, result: 'skipped', reason: meta.reason };
    }
    if (meta.msgType !== 'interactive') {
      // 🔴 **真机 2026-10-07 23:37 的根因就在这一行**：那条消息根本不是卡片，
      //    旧代码却对它 patch、还记成 `card_updated` ⇒ 她那边自然什么都看不到。
      //    现在：一个字都不改它，把**它真实的类型**写进日志（这就是排查要靠的那条证据）。
      logWarn('purchase.arrival.reconcile.card_supersede_skipped', {
        task_id: taskId, card_message_id: id, reason: 'target_not_interactive',
        target_msg_type: meta.msgType, target_thread_id: meta.threadId || '',
        note: '目标不是卡片（patch 对非卡片可能回 code 0 却什么都不改）⇒ 不 patch 它；新卡已经发出去了',
      });
      return { attempted: false, result: 'skipped', reason: 'target_not_interactive' };
    }
    if (meta.deleted) {
      logWarn('purchase.arrival.reconcile.card_supersede_skipped', {
        task_id: taskId, card_message_id: id, reason: 'target_deleted',
        note: '那张卡已经被撤回 ⇒ 没什么可改的；新卡已经发出去了',
      });
      return { attempted: false, result: 'skipped', reason: 'target_deleted' };
    }
    // ② 动手：把它改成"已作废"的终态（按钮收掉、指向最新那张）。
    // ⚠️ `replyOnFailure: false`：这里的失败**不该**往话题里插一句"卡片没刷新成功" ——
    //    新卡已经发出去了、她看到的那张是好的；真正的失败证据是下面的 `card_supersede_failed`。
    const updated = await this.safeUpdateCard(id, purchaseArrivalReconcileStatusCard({
      batchNo,
      message: this.config.card.supersededMessage,
      template: 'grey',
      title: this.config.card.supersededTitle,
    }), { taskId, replyOnFailure: false });
    if (!updated) {
      logWarn('purchase.arrival.reconcile.card_supersede_failed', {
        task_id: taskId, card_message_id: id, new_card_message_id: newCardMessageId,
        note: '旧卡没改成终态：话题里可能同时留着两张可点的卡（两张指向同一个 taskId，点哪张都按最新计划入库）',
      });
      return { attempted: true, result: 'failed', reason: 'update_failed' };
    }
    // ③ 校验更新结果：再读一眼（只作证据，不作业务判据）。
    const after = await this.readMessageMeta(id);
    logInfo('purchase.arrival.reconcile.card_superseded', {
      task_id: taskId, batch_no: batchNo,
      card_message_id: id, new_card_message_id: newCardMessageId,
      // `false` = 改是改了（`code 0`），但**读回来的 `updated` 不是 true**：
      // 说明"改没改成"这件事靠 `code 0` 判不了 —— 正是这次要留下的证据。
      update_verified: after.ok ? after.updated === true : false,
      update_verify_reason: after.ok ? '' : after.reason,
    });
    return { attempted: true, result: 'ok', verified: after.ok ? after.updated === true : null };
  }

  /**
   * 更新一张**已经存在的**卡片；**失败必须看得见**（业务负责人 2026-10-08 逐条批准）。
   *
   * 改前：失败只 `logWarn` + 返 `false` —— 她那边的现象就是"点了一点反应都没有"
   *（卡片没动、也没有任何文字），日志里却只有一行 warn。
   * 现在两条腿一起走：
   *   ① **warn 留痕**（保留原有的 `card_update_failed`，把"适配器返回假值"与"抛错"都写上）；
   *   ② **往那条话题回一句人话**（`replies.cardUpdateFailed`，可置空）——
   *      文案说清"卡片没刷新成功，以这条话为准 / 重新说一句我重出卡"。
   *      ⚠️ 这句回话**自己失败也不许抛**（`safeReplyText` 内部已吞并记 `reply_failed`），
   *         这里**不再套第二层兜底**。
   *
   * @param {object} [options] `{ task, taskId, threadId, replyOnFailure }`
   *   · `task` / `taskId`：拿 `task.thread_id` 把兜底那句回到**同一条话题**（拿不到就不带）；
   *   · `replyOnFailure: false`：调用方**自己紧接着就会回话**（或回话会误导）⇒ 不叠这句。
   */
  async safeUpdateCard(messageId, card, options = {}) {
    if (!messageId) return false;
    let updated = false;
    try {
      updated = await this.updateCard(messageId, card);
      // ⚠️ 适配器**不抛错但返回假值**也是"没改成"（例如 `client.im.v1.message.patch` 不存在），
      //    一样要留痕 —— 否则排查时只看到"卡片没变"，不知道为什么。
      if (!updated) {
        logWarn('purchase.arrival.reconcile.card_update_failed', {
          message_id: messageId, error: 'updateCard 返回了假值（卡片没改成功）',
        });
      }
    } catch (error) {
      logWarn('purchase.arrival.reconcile.card_update_failed', { message_id: messageId, error: error.message });
      updated = false;
    }
    if (!updated) await this.notifyCardUpdateFailed(messageId, options);
    return updated;
  }

  /**
   * 卡片没刷新成功时，往那条话题回一句人话（**本身永不抛**）。
   *
   * ⚠️ 它是 `safeUpdateCard` 的兜底，**不反向调用 `safeUpdateCard`**（否则就是无限兜底）。
   * ⚠️ 文案在 config（`replies.cardUpdateFailed`）；置空 = 只留 warn、不回话。
   */
  async notifyCardUpdateFailed(messageId, options = {}) {
    const copy = options.replyOnFailure === false ? '' : this.config.replies.cardUpdateFailed;
    if (!copy) return false;
    const task = options.task || await this.loadTaskQuietly(options.taskId);
    const thread = options.threadId ? { threadId: String(options.threadId) } : this.threadOptions(task);
    const replied = await this.safeReplyText(messageId, copy, thread);
    logWarn('purchase.arrival.reconcile.card_update_failed_notice', {
      message_id: messageId,
      task_id: options.taskId || task?.task_id || '',
      replied,
      note: '卡片没刷新的兜底回话（这句本身失败也只记日志，绝不抛）',
    });
    return replied;
  }

  /** 读一眼任务拿 `thread_id` 用；读不到（没接线 / 记录没了）返 null，**不抛**。 */
  async loadTaskQuietly(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return null;
    try {
      return await this.store.get(id);
    } catch (error) {
      logWarn('purchase.arrival.reconcile.task_read_failed', {
        task_id: id, error: error.message, note: '只为拿 thread_id；读不到就不带话题',
      });
      return null;
    }
  }
}

module.exports = {
  PurchaseArrivalConversationService,
  taskIdForBatch,
  TASK_TYPE,
  // ⭐⭐ 2026-10-16（task-56）：工作台【确认到货】接异步之后，**金额这道校验必须留在同步路径**
  //   （拦住 + 人话 + 零写入 + 不排后台 ✗）—— 而规则**只有本文件上面那唯一一份实现**
  //   ⇒ **导出给路由复用**，路由**不抄第二份** ✗。
  //   ⚠️ 它是**纯函数**（零副作用、不碰 gateway）⇒ 导出不会让路由绕开任何服务边界 ✓。
  //   ⚠️ `arrivalConversation.test.js` 那条"金额解析只有一份实现"的哨兵**照旧成立**（不放宽 ✗）。
  parseActualAmount,
};
