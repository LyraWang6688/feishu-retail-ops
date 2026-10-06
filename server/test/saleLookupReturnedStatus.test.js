// 查单「排除已退」判据一的**保守化**（2026-10-06 口径）：
//   · 「订单状态」= 已退货 / 部分退货        → 排除（原有行为，回归保护）
//   · 「订单状态」空 **且**「销售状态」也空   → 保守当"退过"排除 + logWarn
//   · 两者**至少一个有值**                  → 不排除（新链路停写旧字段后，新单子不能全被判成退过）
//
// 为什么单独一个文件：这条规则是"判错代价不对称"的安全兜底，值得有自己的一组用例；
// 也刻意不去动 saleLookupService.test.js（那是别的改动在用的文件）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { linkedRecordIds } = require('../src/services/v1BitableGateway');
const { SaleLookupService } = require('../src/services/saleLookupService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const NOW = new Date('2026-10-05T16:00:00+08:00');
const TODAY_9AM = Date.parse('2026-10-05T09:00:00+08:00');

// 订单状态 / 销售状态都**只在显式给值时才落字段**：这样"字段不存在"与"字段是空的"
// 在用例里是同一件事（都是取不到值），正是要测的场景。
const entryRow = (id, { orderStatus, sales } = {}) => ({
  record_id: id,
  fields: {
    销售单号: `XSD-${id}`,
    录单日: TODAY_9AM,
    ...(orderStatus === undefined ? {} : { 订单状态: orderStatus }),
    ...(sales === undefined ? {} : { 销售状态: sales }),
  },
});

const productRow = (id) => ({
  record_id: id,
  fields: { 货号: '6035', 颜色: '黑', 编号: '6035|黑' },
});

const detailRow = (id, orderId, productId) => ({
  record_id: id,
  fields: {
    编号: [{ record_ids: [productId], text: '' }],
    销售单号: [{ record_ids: [orderId], text: '' }],
    销售日: TODAY_9AM,
    尺码: [{ record_ids: ['size_38'], text: '' }],
    成交金额: 230,
  },
});

const makeService = async ({ entries = [], details = [], products = [] } = {}) => {
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sale-lookup-returned-')),
    idField: 'task_id',
  });
  const gateway = {
    table: (tableKey) => V1_BITABLE_SCHEMA.tables[tableKey],
    listAll: async (tableKey) => ({ salesDetail: details, salesEntry: entries, product: products }[tableKey] || []),
    // 写操作一律抛错：本链路一次业务写都不许有。
    create: async () => { throw new Error('本链路不允许写业务表'); },
    update: async () => { throw new Error('本链路不允许写业务表'); },
    delete: async () => { throw new Error('本链路不允许写业务表'); },
  };
  return new SaleLookupService({
    gateway,
    store,
    sizeReferences: {
      resolveLinkedCell: async (cell) => ({ size: linkedRecordIds(cell)[0] === 'size_38' ? 38 : 39 }),
    },
    config: { days: 5, ttlMs: 10 * 60 * 1000 },
    now: () => NOW,
    replyCard: async () => 'om_card',
    sendCard: async () => 'om_card',
  });
};

const findWithWarnings = async (service) => {
  const warnings = [];
  const original = console.warn;
  console.warn = (line) => warnings.push(line);
  try {
    const candidates = await service.findCandidates({ itemNo: '6035', color: '黑' });
    return { candidates, warnings };
  } finally {
    console.warn = original;
  }
};

test('订单状态 = 已退货 / 部分退货 的单仍然被排除（原有行为不回归）', async () => {
  const service = await makeService({
    entries: [
      entryRow('e_ok', { orderStatus: '已完成', sales: '已写入' }),
      entryRow('e_back', { orderStatus: '已退货' }),
      entryRow('e_part', { orderStatus: '部分退货' }),
    ],
    products: [productRow('p1')],
    details: ['e_ok', 'e_back', 'e_part'].map((orderId) => detailRow(`d_${orderId}`, orderId, 'p1')),
  });
  const { candidates } = await findWithWarnings(service);
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_e_ok']);
});

test('订单状态空、销售状态也空 → 保守当成"退过"排除，并留一条 logWarn', async () => {
  const service = await makeService({
    entries: [
      entryRow('e_ok', { orderStatus: '已完成', sales: '已写入' }),
      entryRow('e_blind'), // 两个状态都取不到值：判不出来
    ],
    products: [productRow('p1')],
    details: [detailRow('d_ok', 'e_ok', 'p1'), detailRow('d_blind', 'e_blind', 'p1')],
  });
  const { candidates, warnings } = await findWithWarnings(service);
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_ok']);
  const warn = warnings.map((line) => JSON.parse(line))
    .find((row) => row.event === 'sale_lookup.returned_status.missing');
  assert.ok(warn, '取不到状态时必须打 sale_lookup.returned_status.missing');
  assert.equal(warn.sales_entry_record_id, 'e_blind');
  assert.equal(warn.sales_order_no, 'XSD-e_blind');
  assert.equal(warn.treated_as, 'returned');
});

test('订单状态空但「销售状态」有值 → 不排除（新链路停写旧字段后新单子仍然查得到）', async () => {
  for (const sales of ['未写入', '部分写入', '已写入', '写入失败']) {
    const service = await makeService({
      entries: [entryRow('e_new', { sales })],
      products: [productRow('p1')],
      details: [detailRow('d_new', 'e_new', 'p1')],
    });
    const { candidates, warnings } = await findWithWarnings(service);
    assert.deepEqual(candidates.map((row) => row.record_id), ['d_new'], `销售状态=${sales} 不该被排除`);
    assert.equal(warnings.length, 0, `销售状态=${sales} 不该打保守排除的 warn`);
  }
});

test('订单状态有值（非退货）时，销售状态空也不排除', async () => {
  const service = await makeService({
    entries: [entryRow('e_old', { orderStatus: '已完成' })],
    products: [productRow('p1')],
    details: [detailRow('d_old', 'e_old', 'p1')],
  });
  const { candidates, warnings } = await findWithWarnings(service);
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_old']);
  assert.equal(warnings.length, 0);
});

test('排除判据二（明细里有销售退货行）不受本次改动影响', async () => {
  const service = await makeService({
    entries: [
      entryRow('e_ok', { orderStatus: '已完成', sales: '已写入' }),
      // 订单状态还没改成已退货：只能靠明细的退货行识别——这就是双保险的意义。
      entryRow('e_back', { orderStatus: '已完成', sales: '已写入' }),
    ],
    products: [productRow('p1')],
    details: [
      detailRow('d_ok', 'e_ok', 'p1'),
      detailRow('d_sold', 'e_back', 'p1'),
      { ...detailRow('d_return', 'e_back', 'p1'), fields: { ...detailRow('d_return', 'e_back', 'p1').fields, 交易类型: [{ text: '销售退货' }] } },
    ],
  });
  const { candidates } = await findWithWarnings(service);
  assert.deepEqual(candidates.map((row) => row.record_id), ['d_ok']);
});
