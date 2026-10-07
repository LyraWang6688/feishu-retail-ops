// 卡片场景的**共享输入**：`cardUpdateMulti.test.js` 与一次性的「可见内容零变化」快照生成
// 都用它渲染，保证两边喂给 builder 的输入**逐字相同**（否则快照对不上，测试会当场挂）。
//
// 每个场景是 `{ name, build(larkCards) }` —— 传入整个卡片模块，
// 这样可以拿**同一批输入**分别渲染「改动前（origin/main）」与「改动后」两份，逐字比对。
//
// ⚠️ 这里的输入刻意取最小：目的不是排版回归（那由 larkCards.test.js / afterSalesCard.test.js /
//    secondDeliveryService.test.js 等既有文件钉住），而是钉住
//    「**只有 `config` 变了、可见内容一个字节都没变**」这一条。

const ITEMS = [
  { item_no: 'A100', size: 38, quantity: 1, actual_amount: 99 },
  { item_no: 'A100', size: 39, quantity: 1, actual_amount: 99 },
];

const PAYMENTS = [{ method: '微信', amount: 198, status: '已收' }];

const AFTER_SALES_PLAN = {
  candidate: { date: '2026-10-01', item_no: 'A100', color: '黑', size: 38, actual_amount: 198 },
  action_label: '退货',
  diff_amount: -198,
  settlement: 'cash',
  requires_restock_state: true,
  restock_state: '门盒',
  restock_state_explicit: true,
  new_lines: [],
};

const AFTER_SALES_RESULT = {
  detailRecordIds: ['detail_1'],
  money: { route: 'cash', direction: '退给她', amount: 198 },
  stock: [{ behaviorCode: 'SALE_RETURN', state: '门盒', quantity: 1 }],
};

const ARRIVAL_ROWS = [
  { item_no: 'A100', color: '黑', size: 38, quantity: 2, actual: 2 },
];

// 会被 `im.v1.message.patch` 更新的 14 张卡（13 个 builder；afterSalesRetryCard 继承
// afterSalesConfirmationCard 的 config）。理由与调用方见 docs/card-update-multi-2026-10-07.md 第四节。
const PATCHABLE_CARD_SCENARIOS = [
  { name: 'salesConfirmationCard',
    build: (c) => c.salesConfirmationCard('draft_1', { items: ITEMS, payments: PAYMENTS, agreed_total: 198 }) },
  { name: 'salesStatusCard',
    build: (c) => c.salesStatusCard({ items: ITEMS }, '销售订单已入账', '销售单号：XSD-001。', 'green') },
  { name: 'salesProcessingCard',
    build: (c) => c.salesProcessingCard({ items: ITEMS }, {
      title: '⏳ 处理中，正在写入', template: 'blue', itemColor: 'grey',
      progressLine: '⏳ 正在写入销售记录与收款…', note: '已收到确认，请勿重复点击。',
    }) },
  { name: 'sampleReplacementCard',
    build: (c) => c.sampleReplacementCard('task_sample', { productNumber: 'A100',
      remainingSizes: [{ size: 38, doorBoxCount: 1, sampleCount: 0, warehouseCount: 2 }] }) },
  { name: 'sampleReplacementStatusCard',
    build: (c) => c.sampleReplacementStatusCard('A100', '38码已从门盒转为样品。') },
  { name: 'sampleReplacementProcessingCard',
    build: (c) => c.sampleReplacementProcessingCard('A100', '正在处理。') },
  { name: 'purchaseArrivalReconcileCard',
    build: (c) => c.purchaseArrivalReconcileCard({ taskId: 'task_arrival', batchNo: 'BH-20261007-0001',
      rows: ARRIVAL_ROWS, differences: [],
      copy: { title: '本次到货核对完毕，确认入库吗？', confirmLabel: '是', rejectLabel: '否', hint: '核对后再点。' } }) },
  { name: 'purchaseArrivalReconcileStatusCard',
    build: (c) => c.purchaseArrivalReconcileStatusCard({ batchNo: 'BH-20261007-0001',
      message: '已入库 2 双。', template: 'green' }) },
  { name: 'purchaseStatusCard',
    build: (c) => c.purchaseStatusCard({ items: ITEMS }, '采购申请处理中',
      '已收到确认，正在生成采购申请；请勿重复点击。', 'blue') },
  { name: 'afterSalesConfirmationCard',
    build: (c) => c.afterSalesConfirmationCard('task_as', AFTER_SALES_PLAN) },
  { name: 'afterSalesResultCard',
    build: (c) => c.afterSalesResultCard(AFTER_SALES_PLAN, AFTER_SALES_RESULT) },
  { name: 'afterSalesRetryCard',
    build: (c) => c.afterSalesRetryCard('task_as', AFTER_SALES_PLAN, '库存流水写入失败') },
  { name: 'afterSalesStatusCard',
    build: (c) => c.afterSalesStatusCard({ title: '售后', message: '已受理。', template: 'blue' }) },
  { name: 'secondDeliveryCard',
    build: (c) => c.secondDeliveryCard({ orders: [{ orderNo: 'XSD-001', salesEntryRecordId: 'rec_1',
      tradeTypeLabel: '已付', quantity: 2, pendingAmount: 99, pendingDeliveryQuantity: 1 }],
      methods: ['微信', '现金'], dayKey: '2026-10-07' }) },
];

// 刻意**不动**的卡片（只发不 patch / 无调用方）：它们**不该**出现 `update_multi`。
const UNPATCHABLE_CARD_SCENARIOS = [
  { name: 'saleLookupCard(0 条)',
    build: (c) => c.saleLookupCard({ days: 3, itemNo: 'A100', color: '黑', candidates: [] }) },
  { name: 'saleLookupCard(N 条)',
    build: (c) => c.saleLookupCard({ days: 3, itemNo: 'A100', color: '黑',
      candidates: [{ date: '2026-10-01', item_no: 'A100', color: '黑', size: 38, actual_amount: 99 }] }) },
  { name: 'purchaseRequestConfirmationCard',
    build: (c) => c.purchaseRequestConfirmationCard('draft_2', { items: ITEMS }) },
];

module.exports = { ITEMS, PAYMENTS, AFTER_SALES_PLAN, PATCHABLE_CARD_SCENARIOS, UNPATCHABLE_CARD_SCENARIOS };
