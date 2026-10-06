// 四个状态维度的**写入点**验收：她问的那四句话各自在什么时候落表。
//
// 业务负责人的口径（原话）：
//   「用户有没有点击确认按钮，有没有写进销售明细、收款明细、库存流水以及实时库存」
// ⇒ 所以这个文件按"做没做到"逐个钉住写入点：
//   · ① 确认状态 ← larkMvpService 卡片处理器（建单=未确认 / 确认=已确认 / 取消 / 修改）
//   · ② 销售状态 ← salesOrderService 写完销售明细之后
//   · ③ 资金状态 ← 写完收款明细之后（失败=写入失败）
//   · ④ 库存状态 ← salesDeliveryService 扣库存之后（全成功/部分/全失败）
//
// ⚠️ 负向用例同样重要：**写失败不许静默**、**值域外的值不许写进飞书**（写错的值会永久
//    留在选项里）。这里用"假 Base 只认 schema 语义键"来保证写的是真的那四列。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { LarkMvpService } = require('../src/services/larkMvpService');

const S = require('../src/config/salesStatusDimensions').SALES_STATUS_VALUES;

// 内存假 Base：语义键 → 真实字段名，映射与线上 schema 完全一致。
// ⚠️ 语义键不认识就当场抛（= 线上 gateway 的「未配置语义字段」）。
const fakeGateway = (seed = {}) => {
  let seq = 0;
  const records = new Map(Object.entries(seed)
    .map(([key, rows]) => [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  const writes = { create: {}, update: {} };
  const apply = (key, values) => Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([semantic, value]) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semantic];
      if (!name) throw new Error(`${key}: unknown field ${semantic}`);
      return [name, value];
    }));
  const gateway = {
    records, writes,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id) || null,
    create: async (key, values) => {
      writes.create[key] = (writes.create[key] || 0) + 1;
      const recordId = `rec_${key}_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: apply(key, values) });
      return { recordId };
    },
    update: async (key, id, values) => {
      writes.update[key] = (writes.update[key] || 0) + 1;
      const record = await gateway.get(key, id);
      if (!record) throw new Error(`${key} ${id} 不存在`);
      Object.assign(record.fields, apply(key, values));
      return record;
    },
  };
  return gateway;
};

const entryFields = (gateway, id) => gateway.get('salesEntry', id).then((row) => row.fields);
const makeStore = (prefix) =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), idField: 'task_id' });

// ── ① 确认状态：建单 = 未确认 ─────────────────────────────────────────────────
test('① 确认状态：建单时落「未确认」（她还没点按钮）', async () => {
  const gateway = fakeGateway({ salesEntry: [] });
  const service = new LarkMvpService({ client: {}, gateway, store: makeStore('status-create-'),
    references: {}, recognizer: {} });
  const created = await service.createSalesEntryWithOrderNo({
    original_text: '卖一双 A100 黑 39', sender_open_id: 'ou_1',
  });
  const fields = await entryFields(gateway, created.recordId);
  assert.equal(fields['确认状态'], S.userAction.PENDING);
  assert.equal(fields['销售状态'], undefined);
  assert.equal(fields['资金状态'], undefined);
  assert.equal(fields['库存状态'], undefined);
});

// ── ① 确认状态：点「确认」= 已确认（旧代码里这处完全没有）────────────────────
test('① 确认状态：她点「确认」时落「已确认」——入账服务自己一个字都不写这一列', async () => {
  const gateway = fakeGateway({ salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-1', 确认状态: S.userAction.PENDING } }] });
  const store = makeStore('status-confirm-');
  await store.create({ task_id: 'sale_1', type: 'sale', status: 'ready_to_confirm', sender_open_id: 'ou_1',
    sales_entry_record_id: 'o1', card_message_id: 'om_1',
    draft: { items: [{ product_record_id: 'p1', item_no: 'A100', size: 39, quantity: 1, actual_amount: 260 }] } });
  const service = new LarkMvpService({ client: {}, gateway, store, references: {}, recognizer: {},
    posting: { postSale: async () => ({ sourceNo: 'XSD-1', detailRecordIds: ['d1'], paymentRecordIds: ['r1'] }) },
    delivery: { deliver: async () => ({ failures: [], deliveredQuantity: 1, totalQuantity: 1 }) } });
  service.updateSalesActionCard = async () => true;
  service.publishSalesResultCard = async () => true;

  await service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_1' } } });

  assert.equal((await entryFields(gateway, 'o1'))['确认状态'], S.userAction.CONFIRMED);
  // 入账服务没被调到（这里桩掉了），所以「销售状态 / 资金状态」还是空的：
  // 确认状态与"货/钱写没写进去"是**两条独立的事实**，这正是四维分开的意义。
  assert.equal((await entryFields(gateway, 'o1'))['销售状态'], undefined);
  assert.equal((await entryFields(gateway, 'o1'))['资金状态'], undefined);
});

// ── ① 确认状态：取消 / 修改 ──────────────────────────────────────────────────
test('① 确认状态：点「取消」→ 已取消；点「修改」→ 待修改', async () => {
  const setup = async (taskId) => {
    const gateway = fakeGateway({ salesEntry: [{ record_id: 'o1', fields: { 确认状态: S.userAction.PENDING } }] });
    const store = makeStore(`status-${taskId}-`);
    await store.create({ task_id: taskId, type: 'sale', status: 'ready_to_confirm', sender_open_id: 'ou_1',
      sales_entry_record_id: 'o1', draft: { items: [] } });
    const service = new LarkMvpService({ client: {}, gateway, store, references: {}, recognizer: {},
      posting: {}, delivery: {} });
    service.publishSalesResultCard = async () => true;
    return { gateway, service };
  };
  const cancelled = await setup('sale_cancel');
  await cancelled.service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'cancel', draft_id: 'sale_cancel' } } });
  assert.equal((await entryFields(cancelled.gateway, 'o1'))['确认状态'], S.userAction.CANCELLED);

  const modified = await setup('sale_modify');
  modified.service.sendText = async () => undefined;
  await modified.service.handleCardAction({ operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'modify_sale', draft_id: 'sale_modify' } } });
  assert.equal((await entryFields(modified.gateway, 'o1'))['确认状态'], S.userAction.TO_MODIFY);
});

// ── ②③ 销售状态 / 资金状态：入账服务写完明细与收款之后 ────────────────────────
const saleGateway = (extra = {}) => fakeGateway({
  salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-1', 确认状态: S.userAction.CONFIRMED } }],
  // 尺码是关联字段：入账前必须能在「尺码管理」里解析出 38 / 39 两条。
  sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }, { record_id: 'size_39', fields: { 尺码: 39 } }],
  ...extra,
});
const saleInput = (overrides = {}) => ({
  salesEntryRecordId: 'o1',
  items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 230 }],
  payments: [{ method: '微信', amount: 230 }],
  ...overrides,
});
const saleReferences = {
  resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }),
};

test('②③ 明细 + 收款都写完 → 销售状态=已写入、资金状态=已写入', async () => {
  const gateway = saleGateway();
  await new SalesOrderService({ gateway, references: saleReferences }).confirm(saleInput());
  const fields = await entryFields(gateway, 'o1');
  assert.equal(fields['销售状态'], S.sales.WRITTEN);
  assert.equal(fields['资金状态'], S.funds.WRITTEN);
  // ⚠️ 入账服务**不再**写「确认状态」（旧代码会写「入账中」/「已入账」）：
  //    她点没点按钮只有卡片处理器知道，而且「入账中」不属于新值域。
  assert.equal(fields['确认状态'], S.userAction.CONFIRMED);
});

test('② 明细写了一半失败 → 销售状态=部分写入（且不谎报已写入）', async () => {
  const gateway = saleGateway();
  const create = gateway.create.bind(gateway);
  let created = 0;
  gateway.create = async (key, values) => {
    if (key === 'salesDetail') {
      created += 1;
      if (created === 2) throw new Error('飞书抽风了');
    }
    return create(key, values);
  };
  await assert.rejects(new SalesOrderService({ gateway, references: saleReferences }).confirm(saleInput({
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 },
      { itemNo: 'B200', size: 39, quantity: 1, actualAmount: 130 },
    ],
  })), /飞书抽风了/);
  const fields = await entryFields(gateway, 'o1');
  assert.equal(fields['销售状态'], S.sales.PARTIAL);
  // 一条收款都没写 → 资金状态也不该说"已写入"。
  assert.notEqual(fields['资金状态'], S.funds.WRITTEN);
});

test('③ 收款明细没写成 → 资金状态=写入失败（6 处闸门因此关着，不会放行）', async () => {
  const gateway = saleGateway();
  await assert.rejects(new SalesOrderService({ gateway, references: saleReferences }).confirm(saleInput({
    payments: [{ method: '微信', amount: '' }],
  })), /收款金额/);
  const fields = await entryFields(gateway, 'o1');
  assert.equal(fields['资金状态'], S.funds.FAILED);
  assert.equal(fields['销售状态'], S.sales.WRITTEN, '明细其实写进去了，这一维要如实说');
});

test('③ 重复确认（幂等）：状态只写同样的值，不会多出记录、也不会写值域外的值', async () => {
  const gateway = saleGateway();
  const service = new SalesOrderService({ gateway, references: saleReferences });
  await service.confirm(saleInput());
  const afterFirst = gateway.writes.update.salesEntry;
  await service.confirm(saleInput());
  assert.equal(gateway.records.get('salesEntry').length, 1);
  assert.equal(gateway.records.get('salesDetail').length, 1);
  assert.equal(gateway.records.get('paymentRecord').length, 1);
  // 第二次也会再写一遍同样的状态值（update 幂等），但字段值必须一模一样。
  assert.ok(gateway.writes.update.salesEntry > afterFirst);
  const fields = await entryFields(gateway, 'o1');
  assert.equal(fields['销售状态'], S.sales.WRITTEN);
  assert.equal(fields['资金状态'], S.funds.WRITTEN);
  // 飞书选项不会被写脏：这四个值都在值域里。
  for (const [semantic, domain] of Object.entries({
    销售状态: Object.values(S.sales), 资金状态: Object.values(S.funds),
  })) {
    assert.ok(domain.includes(fields[semantic]), `${semantic}=${fields[semantic]} 不在值域里`);
  }
});

// ── ④ 库存状态：扣库存（+ 实时库存）之后 ─────────────────────────────────────
const deliveryGateway = (entryExtra = {}) => fakeGateway({
  salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-1', 资金状态: S.funds.WRITTEN, ...entryExtra } }],
  salesDetail: [
    { record_id: 'd1', fields: { 销售单号: [{ record_ids: ['o1'] }], 编号: [{ record_ids: ['p1'] }],
      尺码: [{ record_ids: ['size_38'] }], 履约状态: '未交付', 成交金额: 100 } },
    { record_id: 'd2', fields: { 销售单号: [{ record_ids: ['o1'] }], 编号: [{ record_ids: ['p2'] }],
      尺码: [{ record_ids: ['size_39'] }], 履约状态: '未交付', 成交金额: 130 } },
  ],
  sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }, { record_id: 'size_39', fields: { 尺码: 39 } }],
  product: [{ record_id: 'p1', fields: { 编号: 'A100' } }, { record_id: 'p2', fields: { 编号: 'B200' } }],
});
const deliverWith = (gateway, inventory, detailRecordIds = ['d1', 'd2']) => new SalesDeliveryService({
  gateway, inventory, progress: { sync: async () => ({ fulfillmentStatus: '未交付' }) },
}).deliver({ salesEntryRecordId: 'o1', detailRecordIds });

test('④ 库存都扣成功 → 库存状态=已扣减', async () => {
  const gateway = deliveryGateway();
  const result = await deliverWith(gateway, { applySale: async () => ({}), getSaleResult: async () => null });
  assert.deepEqual(result.failures, []);
  assert.equal((await entryFields(gateway, 'o1'))['库存状态'], S.stock.DONE);
});

test('④ 只扣成一半 → 库存状态=部分扣减', async () => {
  const gateway = deliveryGateway();
  const result = await deliverWith(gateway, {
    applySale: async ({ salesDetailRecordId }) => {
      if (salesDetailRecordId === 'd2') throw new Error('库存不足');
      return {};
    },
    getSaleResult: async () => null,
  });
  assert.equal(result.failures.length, 1);
  assert.equal((await entryFields(gateway, 'o1'))['库存状态'], S.stock.PARTIAL);
});

test('④ 一条都没扣成 → 库存状态=扣减失败（交付本身不抛，逐行记 failures）', async () => {
  const gateway = deliveryGateway();
  const result = await deliverWith(gateway, {
    applySale: async () => { throw new Error('库存不足'); },
    getSaleResult: async () => null,
  });
  assert.equal(result.failures.length, 2);
  assert.equal((await entryFields(gateway, 'o1'))['库存状态'], S.stock.FAILED);
});

test('④ 闸门在前：资金状态不是「已写入」时，连库存都不碰（库存状态也不写）', async () => {
  const gateway = deliveryGateway({ 资金状态: S.funds.FAILED });
  let called = 0;
  await assert.rejects(deliverWith(gateway, { applySale: async () => { called += 1; return {}; } }),
    /尚未确认入账/);
  assert.equal(called, 0);
  assert.equal((await entryFields(gateway, 'o1'))['库存状态'], undefined);
});
