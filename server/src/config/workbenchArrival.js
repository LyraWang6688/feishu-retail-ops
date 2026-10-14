/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「把**老验收整块搬进工作台**」——
 *   采购 → 验收 → 某批卡的展开里：**该批采购明细（只读）** ＋ **自定义尺码** ＋ **自定义货号**
 *   ＋ 实际金额 ＋ 验收原话 ⇒【确认到货】
 * ⇒ 本文件 = 这一屏的**文案/字段/接口真源**（配置先行 ✓ 不散写 if ✗）。
 *
 * 🔴 写入**一行都不在这里**：复用既有 `services/scanArrivalService.js`（**只调用** ✓ 不改它 ✗）·
 *    加库存仍由它内部走 `InventoryService.applyPurchase` ✓（**绝不直连表** ✗）·
 *    幂等 = 它自己的 `submitKeyOf(session)` ✓ 状态值只用已拍板值域 ✓
 * 口径真源：`docs/acceptance-into-workbench-full-2026-10-14.md`（AC-AW10…AW17）
 */
'use strict';

module.exports = {
  api: Object.freeze({
    detail: '/purchase/arrivals/detail',
    accept: '/purchase/arrivals/accept',
  }),
  fields: Object.freeze({
    batchNo: 'batchNo',
    actualAmount: 'actualAmount',
    acceptanceText: 'acceptanceText',
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
  }),
};
