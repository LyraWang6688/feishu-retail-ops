const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_TRADE_TYPE_BY_STOCK, salesTradeTypeForStock,
  itemTradeTypeCode, orderTradeTypeCodes,
} = require('../src/config/salesTradeTypePolicy');
const {
  SALES_MOVEMENTS, SALES_TRADE_TYPE_CODES, tradeTypeCodeFromLabel, tradeTypeLabel,
} = require('../src/config/salesMovements');

// 「类型的判据」与「逐明细类型取法」的唯一来源是这份配置（业务负责人 2026-10-07 拍板）。
// 这几条用例守的就是"配置先行"本身：改判据只改配置，不改逻辑。

test('行为管理表里只有两条：SALE_CASH（现货）/ SALE_PREPAID（预定）—— 不发明新编码', () => {
  assert.deepEqual([...SALES_TRADE_TYPE_CODES].sort(), ['SALE_CASH', 'SALE_PREPAID']);
  assert.deepEqual(SALES_MOVEMENTS.SALE_CASH, { label: '现货', delivery: '已交付' });
  assert.deepEqual(SALES_MOVEMENTS.SALE_PREPAID, { label: '预定', delivery: '未交付' });
});

test('未付不再是交易类型：中文标签「未付」不映射任何编码，主表也不会写出第三个编码', () => {
  assert.equal(tradeTypeCodeFromLabel('未付'), '', '「未付」不再是一种交易类型');
  assert.equal(tradeTypeCodeFromLabel('未付销售'), '');
  assert.equal(tradeTypeCodeFromLabel('现货'), 'SALE_CASH');
  assert.equal(tradeTypeCodeFromLabel('预定'), 'SALE_PREPAID');
  // 「预付」是同一条记录（SALE_PREPAID）的**旧说法**，映射到同一个编码；
  // 但落到卡片 / 表上的**规范标签**只有「预定」（`tradeTypeLabel`）。
  assert.equal(tradeTypeCodeFromLabel('预付'), 'SALE_PREPAID');
  assert.equal(tradeTypeLabel('SALE_PREPAID'), '预定');
});

test('⭐ 类型的唯一判据：实时库存里有 → 现货；没有 → 预定（同样输入、只有库存不同）', () => {
  assert.equal(salesTradeTypeForStock({ inStock: true }), 'SALE_CASH');
  assert.equal(salesTradeTypeForStock({ inStock: false }), 'SALE_PREPAID');
  // 取值是显式的两个字面量键（不靠注释才看得懂）。
  assert.deepEqual(SALES_TRADE_TYPE_BY_STOCK, { inStock: 'SALE_CASH', outOfStock: 'SALE_PREPAID' });
  // 没给 `inStock`（既不是 true 也不是 false）时按"没货"处理 —— 缺证据不能当成有货。
  assert.equal(salesTradeTypeForStock({}), 'SALE_PREPAID');
});

test('ⓑ 逐明细取码：一行自己的编码优先 → 中文标签 → 整单编码；认不出就是空串（不许兜成现货）', () => {
  assert.equal(itemTradeTypeCode({ trade_type_code: 'SALE_PREPAID' }, 'SALE_CASH'), 'SALE_PREPAID');
  assert.equal(itemTradeTypeCode({ trade_type: '预定' }, 'SALE_CASH'), 'SALE_PREPAID');
  assert.equal(itemTradeTypeCode({}, 'SALE_CASH'), 'SALE_CASH');
  assert.equal(itemTradeTypeCode({}, ''), '', '认不出 = 空串 = "还没定"，绝不当成现货');
  assert.equal(itemTradeTypeCode({ trade_type: '未付' }, ''), '',
    '「未付」不再是类型 ⇒ 取不出编码，交给库存判据');
});

test('ⓑ 整单取码：按明细行出现顺序去重（写入是确定性的，幂等重试不会变形状）', () => {
  const items = [
    { trade_type_code: 'SALE_PREPAID' },
    { trade_type_code: 'SALE_CASH' },
    { trade_type_code: 'SALE_PREPAID' },
  ];
  assert.deepEqual(orderTradeTypeCodes(items, ''), ['SALE_PREPAID', 'SALE_CASH']);
  assert.deepEqual(orderTradeTypeCodes([], ''), []);
  assert.deepEqual(orderTradeTypeCodes([{ trade_type_code: '' }], ''), ['']);
});

test('交付那条规则只认类型编码，且与"跑不跑解析"彻底无关（B 对两种类型都跑）', () => {
  const { deliveryForTradeType } = require('../src/config/salesMovements');
  assert.equal(deliveryForTradeType(tradeTypeCodeFromLabel('预定')), '未交付');
  assert.equal(deliveryForTradeType(tradeTypeCodeFromLabel('现货')), '已交付');
  // ⭐ 老那套"按交易类型声明这一步跑不跑"（含 `SALE_PREPAID: stock:false`）已整体退场：
  //    类型是"查完库存"才有的结论，不可能再拿它决定"要不要查"。
  //    这条断言钉住它**没有被偷偷加回来**。
  const policyModule = require('../src/config/salesTradeTypePolicy');
  assert.equal(policyModule.salesParseRuns, undefined, '按类型跳过解析的那套 API 必须不存在');
  assert.equal(policyModule.SALES_TRADE_TYPE_PARSE_POLICY, undefined);
  assert.equal(policyModule.salesColorOptionsScopeFor, undefined, '候选范围那套已随"全色"退场');
});
