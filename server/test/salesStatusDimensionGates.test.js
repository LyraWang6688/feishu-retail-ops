// 6 处闸门的「双读」验收：新字段（「资金状态」）为空时，行为必须与改名之前**逐字一致**
// ——也就是逐字退回旧「确认状态（旧）」；新字段有值时以新字段为准。
//
// 每一处闸门一条测试，每条都跑三种输入：
//   ① 只有旧字段（= 今天的生产状态）→ 与今天等价
//   ② 只有新字段（将来她开始用新字段）→ 用新字段
//   ③ 两个都空 → 与今天一样关闸
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { createWorkbenchService } = require('../src/services/v1WorkbenchService');

const applyFields = (tableKey, values) => Object.fromEntries(Object.entries(values || {})
  .filter(([, value]) => value !== undefined)
  .map(([semantic, value]) => {
    const name = V1_BITABLE_SCHEMA.tables[tableKey].fields[semantic];
    if (!name) throw new Error(`${tableKey}: unknown field ${semantic}`);
    return [name, value];
  }));

const gatewayFor = (seed = {}) => {
  const records = new Map(Object.entries(seed)
    .map(([key, rows]) => [key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } }))]));
  let sequence = 0;
  const gateway = {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id) || null,
    create: async (key, values) => {
      const recordId = `rec_${key}_${++sequence}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: applyFields(key, values) });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      if (!record) throw new Error(`${key} ${id} 不存在`);
      Object.assign(record.fields, applyFields(key, values));
      return record;
    },
  };
  return gateway;
};

// 闸门是否**因为「尚未确认入账」**挡下了这次调用。
// 其余任何错误都说明闸门是放行的（后续步骤才失败），所以不能用 assert.rejects 的字符串匹配。
const blockedByGate = async (promise) => {
  try {
    await promise;
    return false;
  } catch (error) {
    return /尚未确认入账/.test(String(error?.message || ''));
  }
};

const storeStub = () => ({ get: async () => null, create: async () => {}, update: async () => {} });

// ── 闸门 1：salesDeliveryService —— 交付 / 扣库存 ──────────────────────────────
test('闸门 1 交付/扣库存（salesDeliveryService）：新字段空则退回旧字段', async () => {
  const delivery = (entryFields) => new SalesDeliveryService({
    gateway: gatewayFor({
      salesEntry: [{ record_id: 'o1', fields: entryFields }],
      salesDetail: [{ record_id: 'd1', fields: {
        销售单号: ['o1'], 编号: ['p1'], 尺码: ['size_38'], 履约状态: '未交付', 成交金额: 100,
      } }],
      sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
      product: [{ record_id: 'p1', fields: { 编号: 'P1' } }],
    }),
    // 闸门是第一道：闸门之后的库存不在本测试范围，注入桩件让它跑完且不写库。
    inventory: { applySale: async () => ({}), getSaleResult: async () => null },
    progress: { sync: async () => ({ fulfillmentStatus: '未交付' }) },
  }).deliver({ salesEntryRecordId: 'o1', detailRecordIds: ['d1'] });

  assert.equal(await blockedByGate(delivery({ '确认状态（旧）': '已入账' })), false);
  assert.equal(await blockedByGate(delivery({ 资金状态: '已入账' })), false);
  assert.equal(await blockedByGate(delivery({ 资金状态: '  ', '确认状态（旧）': '已入账' })), false);
  assert.equal(await blockedByGate(delivery({})), true);
});

// ── 闸门 2：salesFollowupService.listOrders —— 工作台订单列表 ──────────────────
test('闸门 2 订单列表（salesFollowupService.listOrders）：新字段空则退回旧字段', async () => {
  const listOrders = async (entryFields) => {
    const gateway = gatewayFor({
      salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-1', ...entryFields } }],
      salesDetail: [{ record_id: 'd1', fields: {
        销售单号: ['o1'], 编号: ['p1'], 尺码: ['size_38'], 履约状态: '未交付', 成交金额: 100,
      } }],
      sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
      product: [{ record_id: 'p1', fields: { 编号: 'P1' } }],
    });
    return new SalesFollowupService({ gateway, store: storeStub() }).listOrders();
  };

  assert.equal((await listOrders({ '确认状态（旧）': '已入账' })).orders.length, 1);
  assert.equal((await listOrders({ 资金状态: '已入账' })).orders.length, 1);
  assert.equal((await listOrders({})).orders.length, 0);
});

// ── 闸门 3：salesFollowupService.addPayment —— 补记收款 ───────────────────────
test('闸门 3 补记收款（salesFollowupService.addPayment）：新字段空则退回旧字段', async () => {
  const addPayment = (entryFields) => new SalesFollowupService({
    gateway: gatewayFor({ salesEntry: [{ record_id: 'o1', fields: entryFields }] }),
    store: storeStub(),
  }).addPayment({
    requestId: '11111111-1111-1111-1111-111111111111',
    salesEntryRecordId: 'o1',
    // 金额故意非法：闸门放行后必然停在「收款金额」校验上，据此区分"闸门放行"。
    amount: 'x', method: '微信', operatorOpenId: 'ou_1',
  });

  assert.equal(await blockedByGate(addPayment({ '确认状态（旧）': '已入账' })), false);
  assert.equal(await blockedByGate(addPayment({ 资金状态: '已入账' })), false);
  assert.equal(await blockedByGate(addPayment({})), true);
});

// ── 闸门 4：secondDeliveryService.confirm —— 二次交付 / 成交 ──────────────────
test('闸门 4 成交（secondDeliveryService.confirm）：新字段空则退回旧字段', async () => {
  const confirm = (entryFields) => new SecondDeliveryService({
    gateway: gatewayFor({ salesEntry: [{ record_id: 'o1', fields: entryFields }] }),
    store: storeStub(),
    client: {},
  }).confirm({ salesEntryRecordId: 'o1', method: '微信' });

  // 放行后：没有待收款也没有未交付明细 → 直接回 alreadyCompleted，不再写任何东西。
  const legacy = await confirm({ '确认状态（旧）': '已入账' });
  assert.equal(legacy.alreadyCompleted, true);
  const funds = await confirm({ 资金状态: '已入账' });
  assert.equal(funds.alreadyCompleted, true);
  assert.equal(await blockedByGate(confirm({})), true);
});

// ── 闸门 5：secondDeliveryService.listPendingDeliveries —— 待成交提醒候选 ─────
test('闸门 5 提醒候选（secondDeliveryService.listPendingDeliveries）：新字段空则退回旧字段', async () => {
  const candidates = async (entryFields) => {
    const gateway = gatewayFor({
      behavior: [{ record_id: 'b1', fields: { 行为编码: 'SALE_UNPAID', 行为名称: '未付' } }],
      salesEntry: [{ record_id: 'o1', fields: {
        销售单号: 'XSD-1', 交易类型: ['b1'], 录单日: Date.now(), ...entryFields,
      } }],
      salesDetail: [{ record_id: 'd1', fields: { 销售单号: ['o1'], 履约状态: '已交付', 成交金额: 100 } }],
      paymentRecord: [{ record_id: 'r1', fields: { 关联销售单: ['o1'], 收款金额: 100, 收款状态: '未收款' } }],
    });
    return new SecondDeliveryService({ gateway, store: storeStub(), client: {} })
      .listPendingDeliveries({ now: new Date() });
  };

  assert.equal((await candidates({ '确认状态（旧）': '已入账' })).length, 1);
  assert.equal((await candidates({ 资金状态: '已入账' })).length, 1);
  assert.equal((await candidates({})).length, 0);
});

// ── 闸门 6：v1WorkbenchService.getTodaySales —— 今日销售 ──────────────────────
test('闸门 6 今日销售（v1WorkbenchService.getTodaySales）：新字段空则退回旧字段', async () => {
  const day = Date.parse('2026-09-25T10:00:00+08:00');
  const todayRows = async (entryFields) => {
    const gateway = gatewayFor({
      salesDetail: [{ record_id: 'd1', fields: {
        销售单号: ['o1'], 编号: ['p1'], 数量: 1, 销售日: day, 成交金额: 100,
      } }],
      salesEntry: [{ record_id: 'o1', fields: { 销售单号: 'XSD-1', ...entryFields } }],
      product: [{ record_id: 'p1', fields: { 编号: 'P1' } }],
    });
    return (await createWorkbenchService(gateway).getTodaySales({ date: '2026-09-25' })).rows;
  };

  assert.equal((await todayRows({ '确认状态（旧）': '已入账' })).length, 1);
  assert.equal((await todayRows({ 资金状态: '已入账' })).length, 1);
  assert.equal((await todayRows({})).length, 0);
});
