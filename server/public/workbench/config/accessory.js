/**
 * ⭐⭐ 2026-10-14 晚：工作台「销售 → 配品」子 tab 的**前端文案/字段/接口真源**（配置先行 ✓ 不散写 ✗）。
 *   业务负责人逐字：「把配品给迁移到工作台销售里，新建一个子 tab，整体都迁移过去，只是入口变了，逻辑没有变」
 *              ＋「配品页的成交金额确实要必填」
 * ⚠️ 接口与字段名**必须与服务端** `src/config/workbenchAccessory.js` **逐字一致**（那边是真源 ✓）。
 */
export const ACCESSORY_API = {
  list: '/api/workbench/sales/accessories',
  methods: '/api/workbench/sales/payment-methods',
  submit: '/api/workbench/sales/accessory-sales',
};

export const ACCESSORY_FIELDS = {
  accessoryId: 'accessoryRecordId',
  quantity: 'quantity',
  amount: 'amount',
  submitKey: 'submitKey',
};

export const ACCESSORY_DEFAULT_QUANTITY = 1;

export const ACCESSORY_TEXTS = {
  title: '配品',
  nameLabel: '名称',
  quantityLabel: '数量',
  amountLabel: '成交金额',
  submit: '提交',
  submitting: '正在提交…',
  empty: '「其他配品」里还没有可选的名称',
  listFailed: '配品清单读取失败',
  submitFailed: '没写成功，请稍后再试',
  // 成交金额必填（她 2026-10-14）—— 与服务端 `workbenchAccessory.texts.amountRequired` 逐字一致 ✓
  amountRequired: '请先填成交金额再提交',
  methodLabel: '收款方式',
  methodsFailed: '收款方式没读到，先别提交，稍后再试',
  created: '已建单',
};
