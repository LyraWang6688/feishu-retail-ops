/**
 * 采购页读模型（I/O + 判据注入）判据：AC-P1 / P4 / P6 / P9(占位无接口)。
 *
 * 口径（2026-10-28 业务负责人确认）：
 *   · **只查「销售明细」一张表**（业务负责人纠正：库存数量来自销售明细，不是实时库存）；
 *   · 补货筛选公式 = `库存数量 = 0` + `销售日 >= TODAY()-7`；
 *   · 上新筛选公式 = `上架日期 >= TODAY()-6`（最近 7 天）；
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
const PRF = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields;
const PRRO = V1_BITABLE_SCHEMA.tables.purchaseRequest.readOnlyFields;
const PBF = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields;
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
// ⚠️ 两种形状：`getBatch`（batch_get）与 `listByFilter`（GET list）返回的单元格形状**不同** ——
// 2026-10-28 真测试 Base 验证发现的 Bug-2；读模型必须归一化 batch 形状。
const CF = V1_BITABLE_SCHEMA.tables.color.fields;
const productListRecord = ({ id = 'recA', number = '86822', itemNo = '86822', color = '黑色', category = 'A', createdAt = NOW, delisted = false }) => ({
  record_id: id,
  fields: {
    [PF.number]: link(number), [PF.itemNo]: itemNo, [PF.color]: link(color), [PF.category]: category,
    [PF.supplier]: link('recSupplier'), [PF.createdAt]: createdAt,
    ...(delisted ? { [PF.delisted]: true } : {}),
  },
});
const productBatchRecord = ({ id = 'recA', number = '86822', itemNo = '86822', colorRecordId = 'recColorBlack', category = 'A', createdAt = NOW, delisted = false }) => ({
  record_id: id,
  fields: {
    [PF.number]: { type: 1, value: [{ text: number }] },
    [PF.itemNo]: [{ text: itemNo, type: 'text' }],
    [PF.color]: { link_record_ids: [colorRecordId] },
    [PF.category]: category,
    [PF.supplier]: { link_record_ids: ['recSupplier'] },
    [PF.createdAt]: createdAt,
    ...(delisted ? { [PF.delisted]: true } : {}),
  },
});
const colorRecord = (id, name) => ({ record_id: id, fields: { [CF.name]: [{ text: name, type: 'text' }] } });

const makeGateway = ({ sales = [], products = [], listProducts, behaviors = [], colors = [], purchases = [], batches = [], suppliers = [] } = {}) => {
  const calls = [];
  return {
    calls,
    async listByFilter(tableKey, filter) {
      calls.push({ kind: 'listByFilter', tableKey, filter });
      if (tableKey === 'salesDetail') return sales;
      if (tableKey === 'product') return listProducts || products;
      return [];
    },
    async listAll(tableKey) {
      calls.push({ kind: 'listAll', tableKey });
      if (tableKey === 'behavior') return behaviors;
      if (tableKey === 'purchaseRequest') return purchases;
      if (tableKey === 'purchaseOrderBatch') return batches;
      if (tableKey === 'supplier') return suppliers;
      return [];
    },
    async getBatch(tableKey, ids) {
      calls.push({ kind: 'getBatch', tableKey, ids });
      const pool = tableKey === 'color' ? colors : products;
      return (ids || []).map((id) => pool.find((one) => one.record_id === id)).filter(Boolean);
    },
  };
};

test('AC-P1 补货读销售明细 + 采购明细未到货：销售筛选公式 = 库存数量=0 + 销售日>=TODAY()-7；不读实时库存', async () => {
  const gateway = makeGateway({
    sales: [salesRecord({ id: 'recA', size: 39, code: 'SALE_CASH' }), salesRecord({ id: 'recA', size: 41, code: 'SALE_PREPAID' })],
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货'), behavior('behPrepaid', 'SALE_PREPAID', '预定')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r1' });
  assert.equal(result.ok, true);
  assert.equal(result.stats.spotSold, 1);
  assert.equal(result.stats.prepaidPending, 1);
  assert.equal(result.groups[0].itemNo, '86822');
  // Bug-2 回归：batch 形状的「编号」不许变成 `[object Object]`；颜色要按关联 ID 解析出显示名
  assert.equal(result.groups[0].number, '86822');
  assert.equal(result.groups[0].color, '黑色');
  const filters = gateway.calls.filter((call) => call.kind === 'listByFilter');
  assert.deepEqual(filters.map((call) => call.tableKey), ['salesDetail']);
  assert.match(filters[0].filter, new RegExp(`CurrentValue\\.\\[${SF.stockQuantity}\\]=(0|"0")`));
  assert.match(filters[0].filter, /TODAY\(\)-7/);
  assert.match(filters[0].filter, new RegExp(`CurrentValue\\.\\[${SF.soldAt}\\]`));
  // getBatch：先按记录 ID 读货品，再按颜色关联 ID 读颜色管理（解析显示名；Bug-2 修复）
  assert.deepEqual(gateway.calls.filter((call) => call.kind === 'getBatch').map((call) => call.tableKey), ['product', 'color']);
});

test('AC-P1d 已下架货品不进入补货建议（销售来源）', async () => {
  const gateway = makeGateway({
    sales: [salesRecord({ id: 'recA', size: 39, code: 'SALE_CASH' }), salesRecord({ id: 'recB', size: 39, code: 'SALE_CASH' })],
    products: [
      productBatchRecord({ id: 'recA' }),
      productBatchRecord({ id: 'recB', number: '99999', itemNo: '99999', delisted: true }),
    ],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r_delisted_sales' });
  assert.deepEqual(result.groups.map((group) => group.productRecordId), ['recA']);
  assert.equal(result.delistedRows, 1);
});

test('AC-P1e 已下架货品不进入补货建议（未到货来源）', async () => {
  const gateway = makeGateway({
    products: [productBatchRecord({ id: 'recB', number: '99999', itemNo: '99999', delisted: true })],
    colors: [colorRecord('recColorBlack', '黑色')],
    purchases: [{
      record_id: 'pd_delisted',
      fields: {
        [PRF.product]: link('recB'), [PRF.size]: 39, [PRF.quantity]: 5,
        [PRRO.arrivedQuantity.name]: 0,
      },
    }],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r_delisted_pending' });
  assert.equal(result.groups.length, 0);
  assert.equal(result.delistedRows, 1);
});

test('AC-P6b 已下架货品不进入上新建议', async () => {
  const gateway = makeGateway({
    products: [
      productListRecord({ id: 'recActive', createdAt: SH('2026-10-28T08:00:00') }),
      productListRecord({ id: 'recDelisted', number: '99999', itemNo: '99999', createdAt: SH('2026-10-28T08:30:00'), delisted: true }),
    ],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadNewProducts({ requestId: 'r_delisted_new' });
  assert.deepEqual(result.groups.map((group) => group.productRecordId), ['recActive']);
});

test('AC-P25 补货分组带供应商名称（来自供应商配置表）', async () => {
  const gateway = makeGateway({
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货')],
    suppliers: [{ record_id: 'recSupplier', fields: { [V1_BITABLE_SCHEMA.tables.supplier.fields.name]: '供应商A' } }],
    sales: [salesRecord({ id: 'recA', size: 39, code: 'SALE_CASH' })],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r_supplier' });
  assert.equal(result.groups[0].supplierRecordId, 'recSupplier');
  assert.equal(result.groups[0].supplierName, '供应商A');
});

test('AC-P24 补货加入采购明细未到货：数量 - 已入库数量，和销售同尺码合并', async () => {
  const gateway = makeGateway({
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货')],
    purchases: [{
      record_id: 'pd_1',
      fields: {
        [PRF.product]: link('recA'),
        [PRF.size]: 39,
        [PRF.quantity]: 5,
        [PRRO.arrivedQuantity.name]: 2,
      },
    }],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r_pending' });
  assert.equal(result.stats.notArrived, 3);
  assert.deepEqual(result.groups[0].sizes.map((row) => [row.size, row.notArrived]), [[39, 3]]);
  assert.ok(gateway.calls.some((call) => call.kind === 'listAll' && call.tableKey === 'purchaseRequest'));
});

test('AC-P24c 采购退货批次的明细不进入补货未到货', async () => {
  const gateway = makeGateway({
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behReturn', 'PURCHASE_RETURN', '退货')],
    batches: [{ record_id: 'batch_ret', fields: { [PBF.behavior]: link('behReturn') } }],
    purchases: [{
      record_id: 'pd_ret',
      fields: {
        [PRF.product]: link('recA'), [PRF.size]: 39, [PRF.quantity]: 5,
        [PRF.batchNo]: link('batch_ret'), [PRRO.arrivedQuantity.name]: 0,
      },
    }],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({ requestId: 'r_return' });
  assert.equal(result.stats.notArrived, 0);
  assert.equal(result.groups.length, 0);
});

test('AC-P10（#950）`trade_type_unknown` 只对**真认不出交易类型**的行告警', async () => {
  const warns = [];
  const logger = {
    logInfo() {},
    logWarn: (event, fields) => warns.push({ event, fields }),
    logError() {},
  };
  const unknownTrade = {
    record_id: 'sd_unknown',
    fields: {
      [SF.product]: link('recA'), [SF.size]: 41, [SF.soldAt]: SH('2026-10-27T10:00:00'),
      [SF.stockQuantity]: 0, [SF.tradeType]: link('behReturn'),
    },
  };
  const gateway = makeGateway({
    sales: [unknownTrade],
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behReturn', 'SALE_RETURN', '退货')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger });
  const result = await service.loadReplenish({ requestId: 'r950' });
  assert.equal(result.tradeTypeUnknownRows, 1);
  const tradeWarns = warns.filter((warn) => warn.event === config.events.tradeTypeUnknown);
  assert.equal(tradeWarns.length, 1, '只告警一次（且只因为那一条真认不出的行）');
  assert.equal(tradeWarns[0].fields.trade_type_unknown_rows, 1);
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
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behPrepaid', 'SALE_PREPAID', '预定')],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadReplenish({});
  assert.equal(result.stats.prepaidPending, 1);
});

test('AC-P6 上新只查货品信息 + 上架日期>=TODAY()-6（最近 7 天）；类别缺失不猜', async () => {
  const gateway = makeGateway({
    products: [
      productListRecord({ id: 'recToday', category: '女', createdAt: SH('2026-10-28T08:00:00') }),
      productListRecord({ id: 'recNoCat', category: '', createdAt: SH('2026-10-28T08:30:00') }),
    ],
  });
  const service = createProcurementPageService({ gateway, config, now: () => NOW, logger: {} });
  const result = await service.loadNewProducts({});
  assert.equal(result.stats.productCount, 2);
  const filters = gateway.calls.filter((call) => call.kind === 'listByFilter');
  assert.equal(filters[0].tableKey, 'product');
  assert.match(filters[0].filter, new RegExp(`CurrentValue\\.\\[${PF.createdAt}\\]>=TODAY\\(\\)-6`));
  const missing = result.groups.find((group) => group.productRecordId === 'recNoCat');
  assert.equal(missing.categoryMissing, true);
  assert.deepEqual(missing.sizes, { normal: [], special: [] });
});

test('行为表索引命中缓存（默认 60 秒内不再重读）；换 config 即换行为', async () => {
  const gateway = makeGateway({
    sales: [salesRecord({})],
    products: [productBatchRecord({})],
    colors: [colorRecord('recColorBlack', '黑色')],
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

test('补货读 salesDetail 遇到 1254607 会短重试，成功后正常返回', async () => {
  let salesCalls = 0;
  const gateway = makeGateway({
    sales: [salesRecord({ id: 'recA', size: 39, code: 'SALE_CASH' })],
    products: [productBatchRecord({ id: 'recA' })],
    colors: [colorRecord('recColorBlack', '黑色')],
    behaviors: [behavior('behCash', 'SALE_CASH', '现货')],
  });
  const original = gateway.listByFilter;
  gateway.listByFilter = async function listByFilter(tableKey, filter) {
    if (tableKey === 'salesDetail') {
      salesCalls += 1;
      if (salesCalls === 1) {
        throw Object.assign(new Error('Request failed with status code 400'), {
          response: { status: 400, data: { code: 1254607, msg: 'Data not ready, please try again later' } },
        });
      }
    }
    return original.call(this, tableKey, filter);
  };
  const service = createProcurementPageService({
    gateway, config, now: () => NOW, logger: {}, readRetry: { maxRetries: 1, delayMs: 0 }, sleep: async () => {},
  });
  const result = await service.loadReplenish({ requestId: 'r-retry' });
  assert.equal(salesCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.stats.spotSold, 1);
});
