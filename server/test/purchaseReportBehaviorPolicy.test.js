const test = require('node:test');
const assert = require('node:assert/strict');
const {
  REPORT_BEHAVIOR,
  classifyReportBehavior,
} = require('../src/services/purchaseReportBehaviorPolicy');

// 「采购行为」分流：业务负责人 2026-10-05 改了报单表结构后，两种格式都走表单，
// 靠「采购行为」区分——采购申请（编号+尺码+数量说明）/ 采购退货（编号+数量，无尺码）。
// 认错方向的代价：把退货当采购申请会让解析在"必须选尺码"这一步炸掉；
// 把采购申请当退货会丢尺码。所以两个方向都要钉住。

test('行为名称含「退货」→ 采购退货', () => {
  assert.equal(classifyReportBehavior({ name: '采购退货' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: '退货' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: ' 采购退货 ' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
});

test('行为编码带 RETURN（不看大小写）→ 采购退货', () => {
  assert.equal(classifyReportBehavior({ code: 'PURCHASE_RETURN' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ code: 'purchase_return' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
  assert.equal(classifyReportBehavior({ name: '', code: 'Return' }), REPORT_BEHAVIOR.PURCHASE_RETURN);
});

test('采购申请 / 读不到行为记录 / 名称不认识 → 一律按采购申请（维持现状）', () => {
  const asRequest = [
    { name: '采购申请' },
    { name: '采购申请', code: 'PURCHASE_REQUEST' },
    { name: '采购入库' },
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
