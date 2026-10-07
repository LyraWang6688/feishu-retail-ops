const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SALES_TRADE_TYPE_PARSE_POLICY, salesParsePolicyFor, salesParseRuns,
} = require('../src/config/salesTradeTypePolicy');
const { SALES_TRADE_TYPE_CODES, tradeTypeCodeFromLabel } = require('../src/config/salesMovements');

// 「录单时跑哪些解析」的唯一判据来源是这份配置（业务负责人 2026-10-07 确认的设计）。
// 这几条用例守的就是"配置先行"本身：加/改交易类型的规则只改配置，不改逻辑。

test('配置覆盖且只覆盖三个销售交易类型编码 —— 漏一个就是静默失效', () => {
  assert.deepEqual(
    Object.keys(SALES_TRADE_TYPE_PARSE_POLICY).sort(),
    [...SALES_TRADE_TYPE_CODES].sort(),
  );
});

test('她定的口径：预付不跑库存解析；现货 / 未付都要跑', () => {
  // 解析 A（「货品信息」→ 颜色 / 商品记录 id）：**所有交易类型都要跑** ——
  // 「它实际上还是要写销售明细的，所以这个时候需要提供颜色信息」。
  for (const code of SALES_TRADE_TYPE_CODES) {
    assert.equal(salesParseRuns(code, 'productInfo'), true, `${code} 必须跑解析 A`);
  }
  // 解析 B（「实时库存」→ 有没有这一双 / 门盒样品）：只有需要库存的交易类型。
  assert.equal(salesParseRuns('SALE_PREPAID', 'stock'), false,
    '预付 = 没货、要调货 —— 「系统实际上就不应该再去库存里面找了」');
  assert.equal(salesParseRuns('SALE_CASH', 'stock'), true);
  assert.equal(salesParseRuns('SALE_UNPAID', 'stock'), true,
    '鞋已经被拿走了，必须确实有这双鞋');
});

test('认不出的交易类型（空编码 / 未知编码）一律按「该跑的都跑」—— 宁可多问一句', () => {
  for (const code of ['', undefined, null, 'SALE_UNKNOWN', '销售退货']) {
    assert.deepEqual(salesParsePolicyFor(code), { productInfo: true, stock: true },
      `${JSON.stringify(code)} 该按最保守的那一档处理`);
  }
});

test('「中文标签 → 编码 → 解析策略」串起来也是配置说了算（模型只输出中文）', () => {
  assert.equal(salesParseRuns(tradeTypeCodeFromLabel('预付'), 'stock'), false);
  assert.equal(salesParseRuns(tradeTypeCodeFromLabel('现货'), 'stock'), true);
  assert.equal(salesParseRuns(tradeTypeCodeFromLabel('未付'), 'stock'), true);
});

test('交付那条规则不受本配置影响：预付仍然是「未交付」', () => {
  const { deliveryForTradeType } = require('../src/config/salesMovements');
  assert.equal(deliveryForTradeType(tradeTypeCodeFromLabel('预付')), '未交付');
  assert.equal(deliveryForTradeType(tradeTypeCodeFromLabel('现货')), '已交付');
  assert.equal(deliveryForTradeType(tradeTypeCodeFromLabel('未付')), '已交付');
});
