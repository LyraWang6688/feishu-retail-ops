/**
 * 「货品信息」反查归一化判据（Bug-2 回归，2026-10-28 真测试 Base 验证发现）：
 *   `getBatch`（batch_get）与列表接口的单元格形状**不同**：
 *     · 公式 / 文本：`{ type, value: [{ text }] }`（没有顶层 text）；
 *     · 关联：`{ link_record_ids: [...] }`（没有显示文本，颜色名要再读「颜色管理」）。
 *   ⇒ 不归一化就会出现：补货卡片颜色为空、payload `product_number = "[object Object]"`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createProductEnricher, batchTextOf } = require('../src/services/procurementProductEnricher');

const PF = V1_BITABLE_SCHEMA.tables.product.fields;
const CF = V1_BITABLE_SCHEMA.tables.color.fields;

const batchProduct = ({ id = 'recA', number = '66133-15|咖色|B', itemNo = '66133-15', colorId = 'recColorKa', supplierId = 'recSup' } = {}) => ({
  record_id: id,
  fields: {
    [PF.number]: { type: 1, value: [{ text: number }] },
    [PF.itemNo]: [{ text: itemNo, type: 'text' }],
    [PF.color]: { link_record_ids: [colorId] },
    [PF.category]: 'B',
    [PF.supplier]: { link_record_ids: [supplierId] },
    [PF.createdAt]: 1790573535000,
  },
});
const colorRecord = (id, name) => ({ record_id: id, fields: { [CF.name]: [{ text: name, type: 'text' }] } });

const makeGateway = ({ products = [batchProduct()], colors = [colorRecord('recColorKa', '咖色')], failColor = false } = {}) => ({
  async getBatch(tableKey, ids) {
    if (tableKey === 'color') {
      if (failColor) throw new Error('color table down');
      return (ids || []).map((id) => colors.find((one) => one.record_id === id)).filter(Boolean);
    }
    assert.equal(tableKey, 'product');
    return (ids || []).map((id) => products.find((one) => one.record_id === id)).filter(Boolean);
  },
});

test('AC-E1 batch 形状归一化：number/itemNo/颜色/供应商/类别/上架时间全部取到，且没有 [object Object]', async () => {
  const enricher = createProductEnricher({ gateway: makeGateway(), schema: V1_BITABLE_SCHEMA });
  const map = await enricher.enrich(['recA']);
  const dto = map.get('recA');
  assert.equal(dto.number, '66133-15|咖色|B');
  assert.equal(dto.itemNo, '66133-15');
  assert.equal(dto.color, '咖色', '颜色必须按关联 ID 再读颜色管理解析显示名');
  assert.equal(dto.category, 'B');
  assert.equal(dto.supplierRecordId, 'recSup');
  assert.equal(dto.createdAt, 1790573535000);
  assert.equal(JSON.stringify(dto).includes('[object Object]'), false);
});

test('AC-E1b 颜色表读不到 ⇒ 颜色留空 + 一条 warn（不崩、不猜）', async () => {
  const warns = [];
  const enricher = createProductEnricher({
    gateway: makeGateway({ failColor: true }),
    schema: V1_BITABLE_SCHEMA,
    logger: { logWarn: (...args) => warns.push(args) },
  });
  const dto = (await enricher.enrich(['recA'])).get('recA');
  assert.equal(dto.color, '');
  assert.equal(dto.number, '66133-15|咖色|B', '颜色失败不影响其他字段');
  assert.ok(warns.some(([event]) => event === 'procurement.page.color_lookup_failed'));
});

test('AC-E2 batchTextOf：公式形状解包、关联列无文本时返回空串（不是 [object Object]）', () => {
  assert.equal(batchTextOf({ type: 1, value: [{ text: '66133-15' }] }), '66133-15');
  assert.equal(batchTextOf([{ text: '黑色' }]), '黑色');
  assert.equal(batchTextOf('86822'), '86822');
  assert.equal(batchTextOf(39), '39');
  assert.equal(batchTextOf({ link_record_ids: ['recColor'] }), '');
  assert.equal(batchTextOf(null), '');
});

test('AC-E3 空输入 ⇒ 零请求（不读飞书）', async () => {
  let calls = 0;
  const enricher = createProductEnricher({
    gateway: { async getBatch() { calls += 1; return []; } },
    schema: V1_BITABLE_SCHEMA,
  });
  const map = await enricher.enrich([]);
  assert.equal(map.size, 0);
  assert.equal(calls, 0);
});
