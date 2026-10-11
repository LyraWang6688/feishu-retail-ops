/**
 * 「工作台订单列表」那三段（**待补充 / 待交割 / 已两清**）的**后端纯判据**。
 *
 * 🔴 为什么后端要有一份：**采购群那条待办通知**要报"待补充 X 条 · 待补样品 Y 条 · 待交割 Z 条"，
 *    而它跑在服务端（没有浏览器、也不能 require 前端的 ESM）。
 *    ⚠️ 前端那份判据在 `public/workbench/features/orders/index.js` 的 `salesInfoOf` /
 *      `salesSectionOf`（**渲染要在前端算**）；这里是**同一口径的第二处实现** ——
 *      两处**必须一致**，由 `test/samplePendingNotice.test.js` 的 AC-PN4 用同一组 fixture
 *      **逐条比对**钉住（任一处漂移，那条用例当场红）。
 *
 * 判据（与前端口径逐条相同，全部只用**既有字段与取值**）：
 *   · **待补样品**（`sample_pending === true`，服务端只读事实）⇒ `supplement`（**先判它**）；
 *   · 缺**货品信息**（明细的 编号 / 颜色 / 尺码；配品行不参与）或**资金信息**
 *     （至少一笔收款且有收款方式）⇒ `supplement`（= 待补充）；
 *   · 否则：履约「已交付」且收款「已收款」⇒ `afterSales`；其余 ⇒ `pending`（= 待交割）。
 */
const DELIVERED_FULFILLMENT = '已交付';
const PAID_PAYMENT_STATUS = '已收款';
const SECTIONS = Object.freeze({ SUPPLEMENT: 'supplement', PENDING: 'pending', AFTER_SALES: 'afterSales' });

const workbenchSectionOf = (order = {}) => {
  const lines = Array.isArray(order.details) ? order.details : [];
  const goodsLines = lines.filter((line) => line?.requires_size !== false);
  const goodsMissing = lines.length === 0 || goodsLines.some((line) => (
    !String(line?.product ?? '').trim()
    || !String(line?.color ?? '').trim()
    || line?.size == null || String(line.size).trim() === ''
  ));
  const payments = Array.isArray(order.payments) ? order.payments : [];
  const fundsMissing = !payments.some((payment) => String(payment?.method ?? '').trim());
  // ⭐ 「卖了样品没指定门盒」也进待补充（**先判它**，与前端 `salesSectionOf` 同一顺序）
  if (order.sample_pending) return SECTIONS.SUPPLEMENT;
  if (goodsMissing || fundsMissing) return SECTIONS.SUPPLEMENT;
  return (order.fulfillment_status === DELIVERED_FULFILLMENT && order.payment_status === PAID_PAYMENT_STATUS)
    ? SECTIONS.AFTER_SALES
    : SECTIONS.PENDING;
};

/**
 * 通知要的那四个数：待补充 / **待补样品**（待补充里的一个子集）/ 待交割 / 共几条。
 * ⚠️ `sample` 是 `supplement` 的**子集**（不是第四段）——她给的文案里三个数并列，但语义上
 *    "待补样品"是"待补充"里的一类，所以 `total` **不把 sample 再加一遍**。
 */
const workbenchCountsOf = (orders = []) => {
  const counts = { supplement: 0, sample: 0, pending: 0, total: 0 };
  for (const order of Array.isArray(orders) ? orders : []) {
    counts.total += 1;
    const section = workbenchSectionOf(order);
    if (section === SECTIONS.SUPPLEMENT) counts.supplement += 1;
    if (section === SECTIONS.PENDING) counts.pending += 1;
    if (order?.sample_pending) counts.sample += 1;
  }
  return counts;
};

module.exports = {
  DELIVERED_FULFILLMENT,
  PAID_PAYMENT_STATUS,
  SECTIONS,
  workbenchSectionOf,
  workbenchCountsOf,
};
