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
// ⚠️ 扩展点（将来接采购链路时只改两处）：
//   1) 这里的 CORRELATION_KEYS 加 `purchase_batch_no`；
//   2) purchaseWebhookService 在调 gateway.create / inventory.applyPurchase 时把
//      `correlation: { purchase_batch_no }` 传下去 —— 下游已经全部就位，不用再改。
const CORRELATION_KEYS = Object.freeze(['task_id', 'order_no', 'sales_entry_record_id']);

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
