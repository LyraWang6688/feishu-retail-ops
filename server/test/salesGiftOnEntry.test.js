const test = require('node:test');
const assert = require('node:assert/strict');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// ── 赠品落点从「销售明细」搬到「销售主表」（业务负责人 2026-10-08，逐字）─────────
//   「好的，写入的落点放在销售主表里的赠品，销售明细没有赠品了」
//
// 真表事实（她给的只读核对）：销售主表 18 列里有「赠品」[文本]；销售明细 12 列里「赠品」已删。
// 验收标准见 docs/sales-gift-landing-on-entry-2026-10-08.md（动手前写定）。
//
// ⚠️ 这个假 Base 的 `create` / `update` 会按 **schema 的字段映射** 反查物理列名：
//    未配置的语义键 → 当场抛 `unknown field`，所以"明细还带着 gift 写"一定红，
//    而不是靠断言"恰好没看到"。

const fake = () => {
  const sizes = [38, 39, 40, 41, 42, 43, 44].map((size) => ({
    record_id: `size_${size}`, fields: { 尺码: size },
  }));
  const records = new Map([
    ['salesEntry', [{ record_id: 'order_1', fields: { 销售单号: 'XSD-001', 确认状态: '未确认' } }]],
    ['sizeManagement', sizes],
  ]);
  let seq = 0;
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
          const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
          if (!field) throw new Error(`${key}: unknown field ${name}`);
          return [field, value];
        }));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      Object.assign(record.fields, Object.fromEntries(Object.entries(values)
        .map(([name, value]) => {
          const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
          if (!field) throw new Error(`${key}: unknown field ${name}`);
          return [field, value];
        })));
      return record;
    },
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
  };
  return gateway;
};

const references = {
  resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }),
};

const entryGift = (gateway) => gateway.records.get('salesEntry')[0].fields['赠品'];
const detailFields = (gateway) => gateway.records.get('salesDetail').map((row) => row.fields);

// ── ⑤ schema 守门：明细不再有 gift 映射；主表有 ───────────────────────────────
test('⑤ schema 守门：赠品映射在销售主表、不在销售明细', () => {
  assert.equal(V1_BITABLE_SCHEMA.tables.salesEntry.fields.gift, '赠品');
  assert.equal(V1_BITABLE_SCHEMA.tables.salesDetail.fields.gift, undefined);
});

// ── ① 单件有赠品 → 主表 = 描述；明细不带赠品 ──────────────────────────────────
test('① 单件有赠品：写进销售主表，明细行不带「赠品」', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 250 }],
  });
  assert.equal(entryGift(gateway), '鞋垫一双');
  assert.equal(detailFields(gateway).length, 1);
  assert.equal(detailFields(gateway)[0]['赠品'], undefined);
});

// ── ② 多件各有赠品 → 主表按明细顺序合并、去重 ─────────────────────────────────
test('② 多件各有赠品：主表按明细顺序用「、」连起来', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100, gift: true, giftDescription: '鞋垫一双' },
      { itemNo: 'B200', size: 39, quantity: 1, actualAmount: 130, gift: true, giftDescription: '袜子一双' },
    ],
    payments: [{ method: '微信', amount: 230 }],
  });
  assert.equal(entryGift(gateway), '鞋垫一双、袜子一双');
  // 每一件都不带赠品列
  assert.ok(detailFields(gateway).every((fields) => fields['赠品'] === undefined));
});

test('② 合并去重是"逐个赠品"级：一件里的多个赠品与后一件重复时只留一次', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100, gift: true, giftDescription: '鞋垫一双、袜子一双' },
      { itemNo: 'B200', size: 39, quantity: 1, actualAmount: 130, gift: true, giftDescription: '袜子一双' },
    ],
    payments: [{ method: '微信', amount: 230 }],
  });
  assert.equal(entryGift(gateway), '鞋垫一双、袜子一双');
});

test('③ `gift=true` 但没描述 ⇒ 主表沿用占位「有赠品」', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250, gift: true }],
    payments: [{ method: '微信', amount: 250 }],
  });
  assert.equal(entryGift(gateway), '有赠品');
});

// ── ③ 没有赠品 → 主表写空 ────────────────────────────────────────────────────
test('③ 没有赠品：主表「赠品」写空串（同既有语义）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250 }],
    payments: [{ method: '微信', amount: 250 }],
  });
  assert.equal(entryGift(gateway), '');
  assert.equal(detailFields(gateway)[0]['赠品'], undefined);
});

// ── ④ 幂等：重放不重复写；赠品串相同判一致、变了要能被识别 ────────────────────
test('④ 幂等：重放不重复写明细，主表赠品串不变', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const input = {
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 250 }],
  };
  const first = await sales.confirm(input);
  const second = await sales.confirm(input);
  assert.deepEqual(second.detailRecordIds, first.detailRecordIds);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('salesEntry').length, 1);
  assert.equal(entryGift(gateway), '鞋垫一双');
});

test('④ 幂等：主表赠品串与草稿不同 ⇒ 判不一致、停止重试（不许悄悄改写）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const base = {
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 250 }],
  };
  await sales.confirm(base);
  assert.equal(entryGift(gateway), '鞋垫一双');
  await assert.rejects(sales.confirm({
    ...base,
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250, gift: true, giftDescription: '袜子一双' }],
  }), /赠品.*不一致/);
  // 没被悄悄改写
  assert.equal(entryGift(gateway), '鞋垫一双');
});

test('④ 幂等：草稿把赠品去掉（变空）也要能被识别', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const base = {
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250, gift: true, giftDescription: '鞋垫一双' }],
    payments: [{ method: '微信', amount: 250 }],
  };
  await sales.confirm(base);
  await assert.rejects(sales.confirm({
    ...base,
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 250 }],
  }), /赠品.*不一致/);
});

// ── ⑥ 哨兵：金额 / 履约 / 库存口径不受影响 ──────────────────────────────────
test('⑥ 哨兵：赠品不参与金额，也不产生库存动作', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100, gift: true, giftDescription: '鞋垫一双' },
      { itemNo: 'B200', size: 39, quantity: 1, actualAmount: 130 },
    ],
    payments: [{ method: '微信', amount: 230 }],
  });
  assert.deepEqual(gateway.records.get('salesDetail').map((row) => row.fields['成交金额']), [100, 130]);
  assert.deepEqual(gateway.records.get('salesDetail').map((row) => row.fields['履约状态']),
    ['未交付', '未交付']);
  assert.equal(gateway.records.get('inventoryLedger'), undefined);
  assert.equal(gateway.records.get('liveInventory'), undefined);
});
