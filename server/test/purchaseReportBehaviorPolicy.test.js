const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPORT_BEHAVIOR,
  classifyReportBehavior,
} = require('../src/services/purchaseReportBehaviorPolicy');

// 「采购行为」分流是采购退货链路的第一道门：认错了，一条退货记录会掉进
// 「采购申请」分支，然后在"必须选尺码"那一步失败（她能看到的只是"没反应/报错"）。
// 所以这里把口径钉死：只认行为记录自己的名称/编码，读不到一律退回采购申请。
// 认错方向的代价：把退货当采购申请会让解析在"必须选尺码"这一步炸掉；
// 把采购申请当退货会白扣库存。所以两个方向都要钉住。

test('行为名称含「退货」→ 采购退货', () => {
  assert.equal(classifyReportBehavior({ name: '采购退货' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: '退货' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: ' 采购退货 ' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
});

test('行为编码带 RETURN（不看大小写）→ 采购退货', () => {
  assert.equal(classifyReportBehavior({ code: 'PURCHASE_RETURN' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ code: 'purchase_return' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: '', code: 'Return' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: 'Purchase Return' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
});

test('行为编码就是退货的库存编码（STOCK_PURCHASE_DECREASE）→ 采购退货', () => {
  // 业务负责人给退货的「库存行为」编码是 STOCK_PURCHASE_DECREASE；表单上的「采购行为」
  // 选的是同一条行为记录。只认「退货」两个字的话，她按库存行为的叫法维护这条记录时，
  // 退货就会被误判成采购申请（然后在"必须选尺码"那一步失败）。
  assert.equal(classifyReportBehavior({ code: 'STOCK_PURCHASE_DECREASE' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ code: 'stock_purchase_decrease' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
});

test('只看中文名「采购减少」不算退货信号：误判的代价是白扣库存', () => {
  // 「采购减少」是库存行为的叫法。万一「行为管理」里同时有这条记录、又有人把它
  // 挂到一条采购申请上，按名字认就会把申请当退货、直接把库存扣掉。
  // 所以只认稳定编码，不认中文名——宁可让她看到"采购申请那边报错"，也不能误扣。
  assert.equal(classifyReportBehavior({ name: '采购减少' }), REPORT_BEHAVIOR.PURCHASE_REQUEST);
});

test('采购申请 / 读不到行为记录 / 名称不认识 → 一律按采购申请（维持现状）', () => {
  const asRequest = [
    { name: '采购申请' },
    { name: '采购申请', code: 'PURCHASE_REQUEST' },
    { name: '采购入库' },
    { name: '采购入库', code: 'STOCK_PURCHASE_INCREASE' },
    { code: 'PURCHASE_IN' },
    undefined,
    null,
    {},
    { name: '' },
    { name: 123 },
  ];
  asRequest.forEach((input) => {
    assert.equal(classifyReportBehavior(input), REPORT_BEHAVIOR.PURCHASE_REQUEST,
      `${JSON.stringify(input)} 应退回采购申请`);
  });
});

test('空参调用不抛错（分流绝不因为脏数据把报货链路带崩）', () => {
  assert.equal(classifyReportBehavior(), REPORT_BEHAVIOR.PURCHASE_REQUEST);
});
