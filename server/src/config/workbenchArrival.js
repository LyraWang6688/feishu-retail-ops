/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「把**老验收整块搬进工作台**」——
 *   采购 → 验收 → 某批卡的展开里：**该批采购明细（只读）** ＋ **自定义尺码** ＋ **自定义货号**
 *   ＋ 发生金额 ⇒【确认到货】
 * ⇒ 本文件 = 这一屏的**文案/字段/接口真源**（配置先行 ✓ 不散写 if ✗）。
 *
 * 🔴 写入**一行都不在这里**：复用既有 `services/scanArrivalService.js`（**只调用** ✓ 不改它 ✗）·
 *    加库存仍由它内部走 `InventoryService.applyPurchase` ✓（**绝不直连表** ✗）·
 *    幂等 = 它自己的 `submitKeyOf(session)` ✓ 状态值只用已拍板值域 ✓
 * 口径真源：`docs/acceptance-into-workbench-full-2026-10-14.md`（AC-AW10…AW17）
 *
 * ⭐⭐ 2026-10-16（task-56 · 业务负责人**弹窗选定 B**：「**工作台那半也接异步**」）：
 *   本屏【确认到货】从"当场写完再回页"改成"**先回成功页 ⇒ 后台那一跑写库**" ✓
 *   ⇒ 成功页那一句 = **统一那一句**「已提交成功，数据会更新」——
 *     ⚠️ **唯一真源在 `config/scanPage.js` 的 `SCAN_PAGE.saleSuccess.message`**
 *     （四条链路共用 · 一处定义 ✓）⇒ 这里**只指向它、不抄第二份** ✗。
 *   ⚠️ `texts.accepted`（『已确认到货』）**保留但不再是本链路的成功页** ——
 *     异步之后那一刻**还没确认到货**（后台才写）⇒ 拿它当成功页就是**假成功** ✗。
 */
'use strict';

const { SCAN_PAGE } = require('./scanPage');

module.exports = {
  api: Object.freeze({
    detail: '/purchase/arrivals/detail',
    accept: '/purchase/arrivals/accept',
  }),
  fields: Object.freeze({
    batchNo: 'batchNo',
    actualAmount: 'actualAmount',
    lines: 'lines',
    productRecordId: 'productRecordId',
    itemNo: 'itemNo',
    size: 'size',
    quantity: 'quantity',
  }),
  texts: Object.freeze({
    batchMissing: '这一批的批次号没拿到，请刷新后再试',
    detailFailed: '这一批的采购明细没读到，请稍后再试',
    emptyDetail: '这一批没有可验收的采购明细',
    itemNoUnresolved: '这个货号还没建档（认不出），请先扫码或先建档再验收',
    sizeInvalid: '尺码要填数字，数量要大于 0',
    acceptFailed: '没验收成功，请稍后再试',
    accepted: '已确认到货',
    // ⭐ 2026-10-17（她逐字）：「验收就是我报货、货到了才验收；退货是发给别人，不用验收」
    notRequestBatch: '这一批是退货批次，不需要验收（验收只针对「报货」的货）。',
    // ⭐⭐ 2026-10-16（task-56）：**异步成功页那一句** —— 唯一真源是 `SCAN_PAGE.saleSuccess.message`
    //   （「已提交成功，数据会更新」· 四条链路共用一处定义 ✓）⇒ 这里**只引用、不抄一份字面量** ✗。
    //   ⚠️ 它只承诺"**系统已收到**"（数据会更新 ✓），**不承诺"已入账/已写完"** ✗
    //     —— 真失败仍有出口：后台件那条 warn ＋ 会话 `last_error`（可查、可重试 ✓）。
    submitted: SCAN_PAGE.saleSuccess.message,
  }),
};
