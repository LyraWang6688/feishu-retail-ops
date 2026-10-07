// 「这条日志属于哪一笔业务」—— 关联键的唯一取用口。
//
// 为什么要有它（2026-10-07 业务负责人拍板「日志改下吧！」）：
//   一条销售在被读日志时是**劈成两半**的：
//     · 带 task_id 的那半（lark.sales.* / lark.card.*）能串起来；
//     · **真正写库的那半**（sales.status.written / bitable.record.created /
//       bitable.record.updated / v1.sale.posted / inventory.change.applied）一个键都没有，
//       只能靠 record_id 或时间窗口手工去接。
//   实际后果：第一遍按 task_id grep → **"看不到"明细 / 收款 / 库存** → 差点误判。
//
// 三条硬约束（这就是本文件存在的理由，不是"多一层封装"）：
//   ① **白名单**：只认下面这几个业务键。日志会长期留存、供人和 agent 翻阅
//      （与 utils/larkLogger 同源的理由），随手 spread 一个调用方传进来的对象，
//      等于把"以后谁往里面塞了 App Secret"交给运气。
//   ② **去空**：没有的键**不出现**。日志里出现 `"task_id":""` 会把"没有这个键"
//      和"这个键是空的"混成同一件事，排查时反而要多想一步。
//   ③ **不做任何推导**：本文件不查表、不读本地任务、不猜。谁调用谁负责把**已经知道**的
//      键放进来源对象。"取不到"是正常状态——如实少一个字段，比猜一个错的强。
//
// ⚠️ 扩展点（**2026-10-07 已接采购链路**，两处都做完；详见
//    docs/log-correlation-and-stock-key-label-2026-10-07.md 第六节）：
//   1) 下面的 CORRELATION_KEYS 加了采购那几个键；
//   2) purchaseWebhookService / purchaseArrivalConversationService 在调
//      gateway.create/update 与 inventory.applyPurchase / applyChange 时把键传下去
//      —— 下游（网关 / 库存引擎 / createOnceByKey）**一行都没改**。
//
// 采购的键名为什么是 `batch_no` 而不是 `purchase_batch_no`：
//   采购链路**现有**日志一直用 `batch_no`（purchase.batch.* / purchase.return.batch.* /
//   purchase.request.image.group_sent …）。改叫 purchase_batch_no 会让同一个值在同一条链上
//   有两个字段名 ⇒ `grep '"batch_no":"202610071"'` 串不起整条链 —— 那正是这次要消灭的现象。
const CORRELATION_KEYS = Object.freeze([
  // 销售链路（2026-10-07 上半场）
  'task_id',
  'order_no',
  'sales_entry_record_id',
  // 采购链路（2026-10-07 下半场）
  'batch_no', // 采购批次号：表单填的 202610071 / 自动生成的 CGD-YYYYMMDD-NNNN（旧号 BH-… 仍然认）
  'purchase_report_record_id', // 「信息填写」那条报单记录（采购链路的最上游）
  // ⭐ 2026-10-07 晚替换：原来是 `purchase_arrival_record_id`（「到货验收」那条记录）。
  //    那张表已被业务负责人**整个删除**，到货信息的落点搬到**「报货批次」那一行** ⇒
  //    这个键换成**批次记录 id**（`purchaseOrderBatch.record_id`）。
  //    为什么**不改叫 `batch_record_id`**：本仓采购链路的日志一直用 `batch_no` 表示批次号，
  //    再加一个同前缀的 `batch_record_id` 会和 `batch_no` 混起来（一个号、一个记录 id）；
  //    `purchase_*_record_id` 这一族已经有两个成员（report / 原来的 arrival），语义自解释。
  'purchase_batch_record_id', // 「报货批次」那条记录（到货核对 → 入库那一段的来源）
]);

/**
 * 从任意来源里挑出关联键。
 *
 * @param {object|undefined|null} source 形如 `{ task_id, order_no, sales_entry_record_id }`
 * @returns {object} 只含白名单里**有值**的键；没有就是 `{}`（不是 null，调用方直接 spread）
 */
const correlationFields = (source) => {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of CORRELATION_KEYS) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text) continue;
    out[key] = text;
  }
  return out;
};

/**
 * 合并多份关联键（后面的覆盖前面的），用于「调用方给的 ＋ 这一层自己知道的」。
 *
 * 例：`mergeCorrelation(input.correlation, { sales_entry_record_id })`
 *     —— 调用方给 task_id，这一层补上自己刚读到的销售主表 record_id。
 */
const mergeCorrelation = (...sources) =>
  Object.assign({}, ...sources.map((source) => correlationFields(source)));

module.exports = { CORRELATION_KEYS, correlationFields, mergeCorrelation };
