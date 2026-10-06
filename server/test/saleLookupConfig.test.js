const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MESSAGE_INTENTS,
  normalizeMessageIntent,
  isLookupIntent,
  isAfterSalesIntent,
} = require('../src/config/saleIntents');
const {
  SALE_LOOKUP_DEFAULTS,
  readSaleLookupConfig,
  readPositiveInt,
  isReturnedSalesStatus,
  isReturnTradeType,
} = require('../src/config/saleLookup');
const {
  AFTER_SALES_ORIGINAL_SALES_STATUS,
  originalSalesStatusFor,
} = require('../src/config/afterSalesOriginalSalesStatus');
const { AFTER_SALES_ACTIONS } = require('../src/config/afterSales');

test('意图注册表只认规范值，认不出来的都不当销售处理', () => {
  assert.equal(normalizeMessageIntent('sale'), MESSAGE_INTENTS.SALE);
  assert.equal(normalizeMessageIntent('sale_query'), MESSAGE_INTENTS.SALE_QUERY);
  assert.equal(normalizeMessageIntent('查销售记录'), MESSAGE_INTENTS.SALE_QUERY);
  assert.equal(normalizeMessageIntent('return'), MESSAGE_INTENTS.RETURN);
  assert.equal(normalizeMessageIntent('退货'), MESSAGE_INTENTS.RETURN);
  assert.equal(normalizeMessageIntent('exchange'), MESSAGE_INTENTS.EXCHANGE);
  assert.equal(normalizeMessageIntent('换货'), MESSAGE_INTENTS.EXCHANGE);
  // 空、胡说、模型给了个没见过的词：一律 unsupported，绝不猜成 sale 去写单。
  assert.equal(normalizeMessageIntent(''), MESSAGE_INTENTS.UNSUPPORTED);
  assert.equal(normalizeMessageIntent(undefined), MESSAGE_INTENTS.UNSUPPORTED);
  assert.equal(normalizeMessageIntent('卖东西啦'), MESSAGE_INTENTS.UNSUPPORTED);
});

test('意图分类：查询要执行（只读），退货换货只识别不执行', () => {
  assert.equal(isLookupIntent(MESSAGE_INTENTS.SALE_QUERY), true);
  assert.equal(isLookupIntent(MESSAGE_INTENTS.SALE), false);
  assert.equal(isAfterSalesIntent(MESSAGE_INTENTS.RETURN), true);
  assert.equal(isAfterSalesIntent(MESSAGE_INTENTS.EXCHANGE), true);
  assert.equal(isAfterSalesIntent(MESSAGE_INTENTS.SALE_QUERY), false);
});

test('查询窗口与上下文有效期有默认值，坏配置回落默认值而不是变成 0', () => {
  assert.deepEqual(readSaleLookupConfig({}), SALE_LOOKUP_DEFAULTS);
  assert.deepEqual(readSaleLookupConfig({ SALE_LOOKUP_DAYS: '3', SALE_LOOKUP_TTL_MS: '60000' }),
    { days: 3, ttlMs: 60000 });
  for (const bad of ['', '0', '-2', 'abc', 'NaN']) {
    assert.equal(readPositiveInt(bad, 5), 5, `坏值 ${bad} 应回落默认值`);
  }
});

test('排除已退的两个判据：销售状态已退货/部分退货，明细交易类型销售退货', () => {
  assert.equal(isReturnedSalesStatus('已退货'), true);
  assert.equal(isReturnedSalesStatus(' 部分退货 '), true);
  assert.equal(isReturnedSalesStatus('已写入'), false);
  assert.equal(isReturnedSalesStatus(''), false);
  assert.equal(isReturnTradeType('销售退货'), true);
  assert.equal(isReturnTradeType('现货'), false);
});

test('写进原单「销售状态」的值必须落在查单能识别的退货态里（写/读同一套字面量）', () => {
  const target = originalSalesStatusFor(AFTER_SALES_ACTIONS.RETURN);
  assert.ok(target, '退货要有写入映射');
  for (const value of [target.returned, target.partial]) {
    assert.equal(isReturnedSalesStatus(value), true,
      `写进去的「${value}」必须被查单判据一认成"退过"，否则等于没写`);
  }
  // 换货 / 赔货不写（值域里只有退货态，写它是把业务事实说错）
  assert.equal(originalSalesStatusFor(AFTER_SALES_ACTIONS.EXCHANGE), null);
  assert.equal(originalSalesStatusFor(AFTER_SALES_ACTIONS.COMPENSATION), null);
  assert.equal(originalSalesStatusFor(''), null);
  assert.deepEqual(Object.keys(AFTER_SALES_ORIGINAL_SALES_STATUS), [AFTER_SALES_ACTIONS.RETURN]);
});
