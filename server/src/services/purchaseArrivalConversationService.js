// ⭐ 用户可见文案抽到 config（2026-10-12 技术债批次：只挪位置，一个字符没改）
const { pageMessages, landingMessages, scanMessages } = require('../config/purchaseArrivalTexts');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { resolveArrivalConversationConfig } = require('../config/arrivalConversation');
// ⛔ 2026-10-28：`ARRIVAL_CONVERSATION_ACTIONS`（卡片上的「是」）随**卡片按钮回调**一起摘掉 ——
//   到货验收的现行入口是**工作台发起 + 扫码录入**（`confirmBatchArrival`，本文件保留）。
const { logError, logInfo, logWarn } = require('../utils/logger');

// 会话任务 id 只跟「哪一批」有关，不含时间：同一批单子（含她后来另开一个话题）
// 永远是同一条核对记录，重复投递/重启都不会各起一份。
// `arrival_reconcile_` 前缀让它和销售/采购申请的任务一眼可分。
// ⭐ 2026-11-10（业务负责人：验收按采购明细的供应商拆卡）：
//   同一批次号下**每家供应商是一次独立验收** ⇒ 任务 id 必须带供应商维度（否则第二家会被
//   第一家那条 posted 任务当重放拦掉）；旧链路（无供应商）任务 id 保持原样 ✓。
const {
  taskIdForBatch, computeSupplierTotals, listAcceptedSuppliers,
} = require('./acceptanceSupplierProgress');

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

// ⭐⭐ 2026-10-08：「发生金额」那一项的**服务端**解析（业务负责人：必填、必须让用户填）。
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
 *        「到货文字说明（该列已从真表退场）」写到**「报货批次」那一行** → **逐条加库存**（`inventory.applyPurchase`，
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
    writeBatchTotals,
    markSupplierArrived,
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
    // ⭐ 2026-11-10：按供应商分批验收时，「实际数量 / 发生金额」要写**所有已验收供应商的累计**。
    //   注入而不是自己 new：写「报货批次」那一行是 `PurchaseOrderBatchService` 的职责。
    //   失败只 warn（入库已成功，累计列没写不改变事实）。
    this.writeBatchTotals = writeBatchTotals || (async () => ({ updated: false, reason: 'not_wired' }));
    // ⭐ 2026-11-10：按供应商拆卡后，用主表两个字段判断"全批验完"：
    //   · 「供应商」Lookup（名称）→ 映射成 supplier_record_id 集合；
    //   · 「已到货供应商」关联字段 ⇒ 追加本家后，两集合相等 = 全批到货。
    //   注入而不是自己写表：谁维护「报货批次」是 `PurchaseOrderBatchService` 的职责。
    this.markSupplierArrived = markSupplierArrived || null;
    // 群里的反馈一律**引用回复/回复卡片**（群聊没有"上一次对话"的概念）。
    // ⭐ ④ 两个端口都收第三个参数 `{ threadId }`：非空时由**飞书发送适配器**
    //    带 `reply_in_thread` 把这条反馈回到**那个话题**（本类不认识 reply_in_thread）。
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
  /** 这一批里已验收（posted）供应商的累计实际数量/金额（拆到 `acceptanceSupplierProgress`）。 */
  async supplierTotalsOfBatch(task, batchNo) {
    return computeSupplierTotals(this, task, batchNo);
  }

  /** 已验收供应商（按批次）；前端隐卡用。 */
  async listAcceptedSuppliersByBatch() {
    return listAcceptedSuppliers(this);
  }

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

  // ⛔ 2026-10-28：`handleCardAction`（群话题到货核对卡片上的「是」）**整体删除** ——
  //   业务负责人现行口径：「现在没有群聊入口，也没有旧卡片」；到货验收改由
  //   **工作台发起 + 扫码录入**（`confirmBatchArrival` → `confirmLocked`，两条都在本文件保留）。
  //   ⚠️ 恢复卡片那条路 = 重新实现（卡片渲染 + 动作分派），不是翻一个开关。

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
    if (!Array.isArray(task.plan) || !task.plan.length
      || !task.request_ids?.length || !task.request_rows?.length) {
      // 她说的话我们还没算出结果 → 同样不能只弹 toast（那是"点了没反应"的另一种样子）。
      return this.visibleFailure({
        tier: 'not_confirmed_yet', taskId, operator: operatorOpenId, event, task,
        copy: replies.notConfirmedYet, logEvent: 'purchase.arrival.reconcile.not_confirmed_yet',
        toastType: 'info',
      });
    }
    // ⭐⭐ 2026-10-08（业务负责人亲自批准）：**「发生金额」必填** —— 点「是」这条路
    //   **没有金额输入**（输入框在表单里），所以这一批**还没有金额**时：
    //     · 🔴 **不许**写一个空的「发生金额」（她的口径："必须让用户填"）；
    //     · 🔴 也**不许静默跳过** —— 明确把话指回表单那条路（可见失败：patch 卡 + 回文字）。
    //   ⚠️ 位置**在任何写入之前**（连 `status:'posting'` 都还没落）⇒ 这一批一个字都没动。
    //   ⚠️ 这**不是**放宽"提交"那条路的必填，而是它的对称面：金额只能从表单进来，
    //      而写库发生在「是」这一刻。
    if (!hasActualAmount(task)) {
      logWarn('purchase.arrival.reconcile.amount_missing', {
        task_id: taskId, batch_no: task.batch_no || '', operator_open_id: operatorOpenId || '',
        note: '点「是」但这一批还没有金额：不写空的「发生金额」、不写任何业务表，明确提示她先在表单里填',
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
    // ⭐ 2026-11-10（业务负责人：验收按供应商拆卡）：
    //   本次只验了**一家** ⇒ 只写「实际数量/发生金额」的**累计值**；批次只有等**所有供应商**
    //   都有 posted 任务后才标「已到货」（中间态保持未到货，另一家的卡继续在验收页）。
    const scopedSupplier = String(task.supplier_record_id || '').trim();
    if (scopedSupplier) {
      const batchNo = this.taskBatchNo(task, draft);
      const totals = await this.supplierTotalsOfBatch(task, batchNo);
      if (totals && totals.quantity >= 0) {
        try {
          await this.writeBatchTotals({
            batchNo,
            batchRecordId: String(task.batch_record_id || draft.batch_record_id || '').trim(),
            actualQuantity: totals.quantity,
            actualAmount: totals.amount,
            correlation: { task_id: taskId, batch_no: batchNo },
          });
        } catch (error) {
          logWarn('purchase.arrival.reconcile.batch_totals_failed', {
            task_id: taskId, batch_no: batchNo, error: String(error?.message || error).slice(0, 200),
          });
        }
      }
      // ⭐ 2026-11-10（业务负责人方案）：以主表「供应商」Lookup 与「已到货供应商」为准判断全批。
      //   没有注入实现时（单测/旧调用方）退回任务存储的旧判据。
      let allArrived = totals?.allDone === true;
      if (typeof this.markSupplierArrived === 'function') {
        try {
          const arrivedState = await this.markSupplierArrived({
            batchNo,
            batchRecordId: String(task.batch_record_id || draft.batch_record_id || '').trim(),
            supplierRecordId: scopedSupplier,
            correlation: { task_id: taskId, batch_no: batchNo },
          });
          allArrived = arrivedState?.all_arrived === true;
          if (arrivedState?.missing_names?.length) {
            logWarn('purchase.arrival.reconcile.supplier_lookup_unmapped', {
              task_id: taskId, batch_no: batchNo,
              missing_names: arrivedState.missing_names.slice(0, 10),
              note: '「供应商」Lookup 里有名称在「供应商管理」找不到 ⇒ 不标已到货（不猜）',
            });
          }
        } catch (error) {
          allArrived = false;
          logWarn('purchase.arrival.reconcile.arrived_suppliers_failed', {
            task_id: taskId, batch_no: batchNo, error: String(error?.message || error).slice(0, 200),
          });
        }
      }
      if (allArrived) {
        await this.notifyBatchArrived(batchNo, { correlation: { task_id: taskId } });
      } else {
        logInfo('purchase.arrival.reconcile.supplier_pending', {
          task_id: taskId, batch_no: batchNo, supplier_record_id: scopedSupplier,
          done_suppliers: totals?.doneCount || 0, total_suppliers: totals?.total || 0,
          note: '这一批还有别的供应商没验收 ⇒ 批次保持未到货',
        });
      }
    } else {
      await this.notifyBatchArrived(this.taskBatchNo(task, draft), { correlation: { task_id: taskId } });
    }
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
    logInfo('purchase.arrival.reconcile.success_notice', { task_id: taskId });
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
      // ⭐⭐ 2026-10-08：这两个值就是这次写到「报货批次」那一行的「实际数量」「发生金额」
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
   *      然后调**既有** `confirmLocked` —— 建草稿、写「到货文字说明（该列已从真表退场） / 实际数量 / 发生金额」、
   *      逐条 `inventory.applyPurchase`、写「确认状态」「到货状态」**全部还是那一份实现**。
   *
   * 🔴 为什么不直接调 `PurchaseWebhookService.confirmArrival`：
   *    它读的是**任务上的草稿**，草稿由 `confirmLocked` 按核对计划建。绕过它 = 自己拼草稿、
   *    自己拼入库明细 = **第二套写库逻辑**（明令禁止）。
   *
   * ⚠️ 「发生金额」**必填**（业务负责人 2026-10-08：「金额这个是必填的，必须让用户填」）
   *    —— 工作台表单收的就是它；缺失 / 非数字 / 0 / 负数一律**一个字都不写**（与卡片
   *    表单那条路**同一个** `parseActualAmount`）。
   * ⚠️ 「到货说明」这一输入**已随真表那一列的删除一起退场**（2026-10-09/10-16）：
   *    这里**不替她编一句话**，空了就拒绝 —— 它是**解析实际到货情况的输入**。
   *    ⚠️ 2026-10-09：这一段文字**不再落进表里**（那一列在真表上没有了），
   *      仍然逐字留在本地任务草稿上，供解析与排查复读。
   * ⚠️ 串行：与群话题那条路**共用同一个 `this.queue`**（同一批不会被两条路同时写）。
   *
   * @returns {Promise<{ok: boolean, reason?: string, message: string, taskId?: string}>}
   *   `message` 是**给人看的一句话**（工作台直接显示它），不是内部术语。
   */
  async confirmBatchArrival({
    batch, actualAmount, operatorOpenId = '', scanLines = null, timing = null,
    supplierRecordId = '', supplierRecordIds = [],
  } = {}) {
    const batchNo = String(batch?.batch_no || '').trim();
    if (!batchNo) {
      return { ok: false, reason: 'no_batch_no', message: pageMessages.m1 };
    }
    // ⭐ 2026-11-10：本次验收的供应商范围（空 = 旧链路整批验收）。
    const supplier = String(supplierRecordId || batch?.supplier_record_id || '').trim();
    // ⚠️ 参数默认 [] 是 truthy ⇒ 不能写 `supplierRecordIds || batch...`（会吞掉 batch 里的集合）。
    const supplierIdSource = (Array.isArray(supplierRecordIds) && supplierRecordIds.length)
      ? supplierRecordIds : (batch?.supplier_record_ids || []);
    const allSuppliers = [...new Set(supplierIdSource
      .map((id) => String(id || '').trim()).filter(Boolean))];
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
    // ⭐⭐ 2026-10-11（方案A）：**扫码验收**走这里 —— `scanLines` = 逐码实际到货（她扫了什么）。
    //    ⚠️ 这是**加法**：不传 `scanLines` 时下面每一行与改动前**逐字相同**（工作台既有那条
    //    「全额验收」表单与群话题对话链路都还在用它）。
    const scans = Array.isArray(scanLines) ? scanLines : null;
    if (scans && !scans.length) {
      return { ok: false, reason: 'no_scan_lines', message: this.scanRowsMessage('no_scan_lines') };
    }
    const taskId = taskIdForBatch(batchNo, supplier);
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
        // ⭐ 2026-11-10：把供应商范围冻结在任务上（写回时判断全批是否验完、累计各家的数）
        supplier_record_id: supplier,
        supplier_record_ids: allSuppliers,
        request_ids: snapshot.requestIds,
        request_rows: snapshot.rows,
        plan: plan.rows,
        differences: plan.differences,
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
  //   · `createArrivalRecord`：写「报货批次号」+「到货文字说明（该列已从真表退场）」+「验收人」，并做
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
      // ⭐⭐ 2026-10-11（方案A · 扫码验收）：**逐码实际到货**。
      //    · 按 (货品 record_id, 尺码) 精确匹配申请行（一批里可能同码不同款）；
      //    · 没扫到的行 = 0（调用方入库时摘掉）；
      //    · 命中多行 / 扫到本批没有的货 / 同一行被两条扫码行命中 ⇒ 拦住。
      //    不在申请行里的扫码行 ⇒ 一律 `scan_not_in_batch`（不猜款 ✓）。
      const keyOf = (productRecordId, size) => `${productRecordId}|${Number(size)}`;
      const byKey = new Map();
      for (const row of rows) {
        const key = keyOf(row.product_record_id, row.size);
        if (byKey.has(key)) return { ok: false, reason: 'duplicate_request_rows' };
        byKey.set(key, row);
      }
      const actualById = new Map(rows.map((row) => [row.request_record_id, 0]));
      const hit = new Set();
      for (const scan of parsed.scanLines) {
        const row = byKey.get(keyOf(scan?.product_record_id, scan?.size));
        if (!row) return { ok: false, reason: 'scan_not_in_batch' };
        if (hit.has(row.request_record_id)) return { ok: false, reason: 'scan_duplicated' };
        const quantity = Number(scan?.quantity);
        if (!Number.isSafeInteger(quantity) || quantity < 0) {
          return { ok: false, reason: 'actual_not_positive' };
        }
        hit.add(row.request_record_id);
        actualById.set(row.request_record_id, quantity);
      }
      const scanned = rows.map((row) => ({ ...row, actual: actualById.get(row.request_record_id) }));
      if (scanned.some((row) => !Number.isSafeInteger(row.actual) || row.actual < 0)) {
        return { ok: false, reason: 'actual_not_positive' };
      }
      return { ok: true, rows: scanned, differences: [] };
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

  async visibleFailure({ tier, taskId, operator = '', logEvent = '', error = null, toastType = 'error', copy } = {}) {
    logInfo('purchase.arrival.reconcile.failure_notice', {
      tier, task_id: taskId, operator_open_id: operator || '', log_event: logEvent,
      error: error ? error.message : '', tables_written: 0,
    });
    return { toast: { type: toastType, content: copy } };
  }

  async visibleAlreadyPosted({ taskId } = {}) {
    const copy = this.config.replies.alreadyPosted;
    logInfo('purchase.arrival.reconcile.success_notice', { task_id: taskId });
    return { toast: { type: 'info', content: copy } };
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
