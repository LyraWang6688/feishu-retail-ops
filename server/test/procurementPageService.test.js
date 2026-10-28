/**
 * 采购页读模型（I/O + 判据注入）判据：AC-P1 / P4 / P6 / P9(占位无接口)。
 *
 * 口径（2026-10-28 业务负责人确认）：
 *   · **只查「销售明细」一张表**（业务负责人纠正：库存数量来自销售明细，不是实时库存）；
 *   · 补货筛选公式 = `库存数量 = 0` + `销售日 >= TODAY()-3`；
 *   · 上新筛选公式 = `上架日期 >= TODAY()`；
 *   · 交易类型判据来自「行为管理.行为编码」（复用 salesMovements 的编码集合）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { buildProcurementPageConfig } = require('../src/config/procurementPage');
const { createProcurementPageService } = require('../src/services/procurementPageService');

const config = buildProcurementPageConfig({});
const SF = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
const PF = V1_BITABLE_SCHEMA.tables.product.fields;
const BF = V1_BITABLE_SCHEMA.tables.behavior.fields;
const SH = (iso) => Date.parse(`${iso}+08:00`);
const NOW = SH('2026-10-28T09:00:00');
const link = (...ids) => ids.map((id) => ({ record_ids: [id], text: id }));

const behavior = (id, code, name) => ({ record_id: id, fields: { [BF.code]: code, [BF.name]: name } });
const salesRecord = ({ id = 'recA', size = 39, code = 'SALE_CASH', stock = 0, soldAt = SH('2026-10-27T10:00:00') }) => ({
  record_id: `sd_${id}_${size}_${code}`,
  fields: {
    [SF.product]: link(id), [SF.size]: size, [SF.soldAt]: soldAt,
    [SF.stockQuantity]: stock, [SF.tradeType]: link(code === 'SALE_CASH' ? 'behCash' : 'behPrepaid'),
  },
});
const productRecord = ({ id = 'recA', number = '86822', itemNo = '86822', color = '黑色', category = 'A', createdAt = NOW }) => ({
  record_id: id,
  fields: {
    [PF.number]: number, [PF.itemNo]: itemNo, [PF.color]: color, [PF.category]: category,
    [PF.supplier]: link('recSupplier'), [PF.createdAt]: createdAt,
  },
});

const makeGateway = ({ sales = [], products = [], behaviors = [] } = {}) => {
  const calls = [];
  return {
    calls,
    async listByFilter(tableKey, filter) {
      calls.push({ kind: 'listByFilter', tableKey, filter });
      if (tableKey === 'salesDetail') return sales;
      if (tableKey === 'product') return products;
      return [];
    },
    async listAll(tableKey) {
      calls.push({ kind: 'listAll', tableKey });
      return tableKey === 'behavior' ? behaviors : [];
    },
    async getBatch(tableKey, ids) {
      calls.push({ kind: 'getBatch', tableKey, ids });
      return (ids || []).map((id) => products.find((one) => one.record_id === id)).filter(Boolean);
    },
  };
};

test('AC-P1 补货只查「销售明细」一张表：筛选公式 = 库存数量=0 + 销售日>=TODAY()-3；不读实时库存', async () => {
  const gateway = makeGateway({
    sales: [salesRecord({ id: 'recA', size: 39, code: 'SALE_CASH' }), salesRecord({ id: 'recA', size: 41, code: 'SALE_PREPAID' })],
    products: [productRecord({ id: 'recA' })],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货'), behavior('behPrepaid', 'SALE_PREPAID', '预定')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r1' });
  assert.equal(result.ok, true);
  assert.equal(result.stats.spotSold, 1);
  assert.equal(result.stats.prepaidPending, 1);
  assert.equal(result.groups[0].itemNo, '86822');
  const filters = gateway.calls.filter((call) => call.kind === 'listByFilter');
  assert.deepEqual(filters.map((call) => call.tableKey), ['salesDetail']);
  assert.match(filters[0].filter, new RegExp(`CurrentValue\\.\\[${SF.stockQuantity}\\]=(0|"0")`));
  assert.match(filters[0].filter, /TODAY\(\)-3/);
  assert.match(filters[0].filter, new RegExp(`CurrentValue\\.\\[${SF.soldAt}\\]`));
  assert.deepEqual(gateway.calls.filter((call) => call.kind === 'getBatch').map((call) => call.tableKey), ['product']);
});

test('AC-P1 源码反向哨兵：读模型不碰实时库存，也不写任何表', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/procurementPageService.js'), 'utf8')
    + fs.readFileSync(path.join(__dirname, '../src/services/procurementPageData.js'), 'utf8');
  assert.equal(source.includes('liveInventory'), false, '补货读模型不许读实时库存（业务负责人 2026-10-28 纠正）');
  assert.equal(/gateway\.create\(|gateway\.update\(|gateway\.delete\(/.test(source), false, '读模型只能是只读');
});

test('AC-P4 交易类型判据走「行为管理.行为编码」：关联记录认不出时回落显示文本（现货/预订）', async () => {
  const gateway = makeGateway({
    sales: [{
      record_id: 'sd_label',
      fields: {
        [SF.product]: link('recA'), [SF.size]: 39, [SF.soldAt]: SH('2026-10-27T10:00:00'),
        [SF.stockQuantity]: 0, [SF.tradeType]: [{ text: '预定' }],
      },
    }],
    products: [productRecord({ id: 'recA' })],
    behaviors: [behavior('behPrepaid', 'SALE_PREPAID', '预定')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({});
  assert.equal(result.stats.prepaidPending, 1);
});

test('AC-P6 上新只查货品信息 + 上架日期>=TODAY()；类别缺失不猜', async () => {
  const gateway = makeGateway({
    products: [
      productRecord({ id: 'recToday', category: 'B', createdAt: SH('2026-10-28T08:00:00') }),
      productRecord({ id: 'recNoCat', category: '', createdAt: SH('2026-10-28T08:30:00') }),
    ],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadNewProducts({});
  assert.equal(result.stats.productCount, 2);
  const filters = gateway.calls.filter((call) => call.kind === 'listByFilter');
  assert.equal(filters[0].tableKey, 'product');
  assert.match(filters[0].filter, new RegExp(`CurrentValue\\.\\[${PF.createdAt}\\]>=TODAY\\(\\)`));
  const missing = result.groups.find((group) => group.productRecordId === 'recNoCat');
  assert.equal(missing.categoryMissing, true);
  assert.deepEqual(missing.sizes, { normal: [], special: [] });
});

test('行为表索引命中缓存（默认 60 秒内不再重读）；换 config 即换行为', async () => {
  const gateway = makeGateway({
    sales: [salesRecord({})],
    products: [productRecord({})],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  await service.loadReplenish({});
  await service.loadReplenish({});
  assert.equal(gateway.calls.filter((call) => call.kind === 'listAll' && call.tableKey === 'behavior').length, 1);
});

test('config 可注入：把补货窗口改成 1 天 ⇒ 筛选公式跟着变（配置先行）', async () => {
  const custom = buildProcurementPageConfig({ PROCUREMENT_REPLENISH_DAYS: '1' });
  const gateway = makeGateway({ sales: [], products: [], behaviors: [] });
  const service = createProcurementPageService({ gateway, config: custom, now: () => NOW, logger: {} });
  await service.loadReplenish({});
  assert.match(gateway.calls[0].filter, /TODAY\(\)-1/);
});
