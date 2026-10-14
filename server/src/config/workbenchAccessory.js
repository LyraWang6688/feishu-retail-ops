/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「把**配品**给**迁移到工作台销售里**，新建一个子 tab，
 *   **整体都迁移过去**，**只是入口变了，逻辑没有变**」＋「配品页的**成交金额确实要必填**」
 * ⇒ 本文件 = 工作台「销售 → 配品」子 tab 的**唯一文案/字段/接口真源**（配置先行 ✓ 不散写 if ✗）。
 *
 * ⚠️ 写入**一行都不在这里**：全部复用既有 `services/scanWriteService`（只**调用** ✓ 不改它 ✗）。
 * 🔴 口径与扫码页那套**完全相同**（一字不改 ✗）：名称走「其他配品」只读下拉 ✓ 数量默认 1 ✓
 *    成交金额**必填** ✓ 付款方式 = **全付** ✓ ⇒ **一步成单**（主表 1 + 明细 1 + 收款 1 ✓）·
 *    **零库存动作** ✓（`docs/sales-total-and-accessory-render-2026-10-07.md:75` C5 逐字：
 *    「配品不写尺码、**不产生库存动作**」✓）· 幂等 = **同一把 `submitKey`** ✓
 */
'use strict';

module.exports = {
  // 接口路径（`routes/workbench.js` 挂的就是这两个；前端只读这一份 ✓）
  api: Object.freeze({
    list: '/sales/accessories',
    // ⭐ 收款方式选项 = **只读**「收款方式管理」表（她 2026-10-14：「配品收款方式读『收款方式管理』表」）
    methods: '/sales/payment-methods',
    submit: '/sales/accessory-sales',
  }),
  // 表单字段名（前端 `<input name>` 与后端取值都用这一份 ✓）
  fields: Object.freeze({
    accessoryId: 'accessoryRecordId',
    quantity: 'quantity',
    amount: 'amount',
    submitKey: 'submitKey',
    // 收款方式（她选的那条 ⇒ 落「收款明细.收款方式」✓ 选项来自「收款方式管理」表 ✓）
    method: 'method',
  }),
  // 数量：**默认 1**（她 2026-10-14：「数量可填、默认 1」✓ 不填也能提交 ✓）
  defaultQuantity: 1,
  texts: Object.freeze({
    tabLabel: '配品',
    title: '配品',
    nameLabel: '名称',
    quantityLabel: '数量',
    amountLabel: '成交金额',
    submitLabel: '提交',
    // 金额必填（她：「确实要必填」✓）——空 / 非正数 ⇒ **当场拦住 + 这句人话** ✗ 不许假成功
    amountRequired: '请先填成交金额再提交',
    emptyList: '「其他配品」里还没有可选的名称',
    listFailed: '配品清单读取失败',
    submitFailed: '没写成功，请稍后再试',
    methodLabel: '收款方式',
    // 读不到表 ⇒ **如实**（不进录入 ✓ 不拿配置默认列表兜底 ✗）
    methodsFailed: '收款方式没读到，先别提交，稍后再试',
    submitting: '正在提交…',
  }),
};
