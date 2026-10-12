// 售后**配置层**的测试（2026-10-12 从 `test/afterSalesFlow.test.js` 里**保留下来**的两条）。
//
// 为什么只剩两条：**群卡片售后整条链路已退场**（售后编排服务 + 5 张卡片 +
// 派分都删了），那 37 条"出卡片 / 点确认 / 卡片重渲染"的用例随链路一起退场；
// 但**这两条钉的是 `config/afterSalesFlow.js` 的解析口径**，而那份配置**仍在跑**
// （`services/doubaoService.js` 用它解析她说的"钱怎么走 / 哪个渠道"）⇒ **必须留**。
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAfterSalesSettlement, resolveAfterSalesPaymentMethod,
  AFTER_SALES_PAYMENT_METHOD_HINTS } = require('../src/config/afterSalesFlow');

// 配置层：删掉的那个默认值不许加回来（这是当初改动的根因，用测试锁住）
test('配置层：**不存在**默认资金走向；只有她明说了才解析得出走向', () => {
  const flowConfig = require('../src/config/afterSalesFlow');
  assert.equal('DEFAULT_AFTER_SALES_SETTLEMENT' in flowConfig, false, '钱不能有默认值');
  assert.equal(resolveAfterSalesSettlement(''), '');
  assert.equal(resolveAfterSalesSettlement(undefined), '');
  assert.equal(resolveAfterSalesSettlement('退我现金'), 'cash');
  assert.equal(resolveAfterSalesSettlement('退我微信'), 'cash');
  assert.equal(resolveAfterSalesSettlement('钱先给我存着'), 'prepaid');
  assert.equal(resolveAfterSalesSettlement('现金还是先存着'), '');
  assert.equal(resolveAfterSalesSettlement('钱先存着'), 'prepaid');
  // ⚠️ 2026-10-12（卡片链路退场）：原先这里还断言"没有为没解析出来而准备的**卡片动作**"。
  //    卡片动作整族已删 ⇒ 改成**更强**的那一条：这份配置里**根本没有卡片动作这个概念**了。
  assert.equal('AFTER_SALES_CARD' + '_ACTIONS' in flowConfig, false,
    '售后卡片动作整族已随链路退场（连常量都不该在）');
});

// 配置层：她说的是**哪个渠道**（现金 / 微信 / …）—— 与"钱怎么走"是两件事。
// 业务负责人 2026-10-06：「钱退现金」→ 记录里的「收款方式」就写现金。
test('配置层：从原话里认得出她说的收款方式（认不出就返回空 = 沿用原单）', () => {
  assert.equal(resolveAfterSalesPaymentMethod('退那双 1366-33 黑，退我现金'), '现金');
  assert.equal(resolveAfterSalesPaymentMethod('退给她 230，微信退'), '微信');
  assert.equal(resolveAfterSalesPaymentMethod('退我支付宝'), '支付宝');
  assert.equal(resolveAfterSalesPaymentMethod('刷卡退'), '刷卡');
  assert.equal(resolveAfterSalesPaymentMethod('退我银行卡'), '银行卡');
  assert.equal(resolveAfterSalesPaymentMethod('转账退给我'), '转账');
  assert.equal(resolveAfterSalesPaymentMethod('退那双 1366-33 黑'), '');
  assert.equal(resolveAfterSalesPaymentMethod(''), '');
  assert.equal(resolveAfterSalesPaymentMethod(undefined), '');
  assert.equal(resolveAfterSalesPaymentMethod('那双原来微信买的，现在退现金'), '现金');
  assert.deepEqual(AFTER_SALES_PAYMENT_METHOD_HINTS.map((hint) => hint.method),
    ['微信', '支付宝', '现金', '刷卡', '银行卡', '转账']);
});
