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
 * 通知要的那几个数：待补充 / **待补样品**（待补充里的一个子集）/ 待交割 / 已两清 / **共几条待办**。
 *
 * 🔴 `total` 的口径（**2026-10-12 现场事故后定死**）：
 *    **`total` = `supplement` + `pending`** —— 也就是"她文案里列出来的**三段待办**之和"。
 *    为什么这样算（而不是"取到几单就算几单"）：
 *      ① **已两清不是待办**（`afterSales`）⇒ 不进 `total`；
 *      ② `sample`（待补样品）是 `supplement`（待补充）的**子集** —— 一个单只要 `sample_pending`
 *         就一定被 `workbenchSectionOf` 判进待补充 ⇒ **不能重复加**；
 *      ③ 通知与**工作台订单列表三段**用的是**同一份取数**（`listOrders`）与**同一份判据**
 *         （本文件）⇒ 她 9 点看通知、再去工作台，两边的段数**能对上**。
 *    ⚠️ 事故现场（2026-10-12 09:00 那条通知）：`supplement 10 · sample 8 · pending 5 · total 76`
 *      —— `total` 当时数的是"**全部已入账单**"（含 61 单已两清）⇒ 文案自相矛盾。修的就是这里。
 *
 * ⚠️ 结构上保证恒等式：`total` 由另外两个数**算出来**，不是独立累加的
 *    （这样以后加分段也不会再漂）。
 */
const workbenchCountsOf = (orders = []) => {
  const counts = { supplement: 0, sample: 0, pending: 0, afterSales: 0, total: 0 };
  for (const order of Array.isArray(orders) ? orders : []) {
    const section = workbenchSectionOf(order);
    if (section === SECTIONS.SUPPLEMENT) counts.supplement += 1;
    if (section === SECTIONS.PENDING) counts.pending += 1;
    if (section === SECTIONS.AFTER_SALES) counts.afterSales += 1;
    if (order?.sample_pending) counts.sample += 1;
  }
  counts.total = counts.supplement + counts.pending;
  return counts;
};

module.exports = {
  DELIVERED_FULFILLMENT,
  PAID_PAYMENT_STATUS,
  SECTIONS,
  workbenchSectionOf,
  workbenchCountsOf,
};
