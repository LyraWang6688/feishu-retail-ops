// 6 处闸门的验收：判据统一读「资金状态」，**值必须是「已写入」**。
//
// 2026-10-06 业务负责人的口径（原话）：
//   「旧的两个字段不用管，代码里也不需要了，schema 可以留着」
//   「我需要知道的是：用户有没有点击确认按钮，有没有写进销售明细、收款明细、
//     库存流水以及实时库存」
// ⇒ 所以这里**刻意不测"退回旧字段"**：双读/legacy 兜底已经拿掉，
//    旧「确认状态（旧）」= 已入账 的单子**应当被闸门挡下**（它没写进「收款明细」，
//    这一列就是空的——那正是她要看到的真实达成情况）。
//
// 每条闸门跑四组输入：
//   ① 资金状态 = 已写入          → 放行（新的放行条件）
//   ② 资金状态 = 写入失败        → 关闸
//   ③ 资金状态 空                → 关闸（历史单子的现状）
//   ④ 只有旧「确认状态（旧）」= 已入账 → **也必须关闸**（不再兜底）
const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SALES_STATUS_VALUES } = require('../src/config/salesStatusDimensions');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesFollowupService } = require('../src/services/salesFollowupService');
const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
const { createWorkbenchService } = require('../src/services/v1WorkbenchService');

const POSTED = SALES_STATUS_VALUES.funds.WRITTEN;
const FAILED = SALES_STATUS_VALUES.funds.FAILED;

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
test('闸门 1 交付/扣库存（salesDeliveryService）：资金状态必须是「已写入」', async () => {
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

  assert.equal(await blockedByGate(delivery({ 资金状态: POSTED })), false);
  assert.equal(await blockedByGate(delivery({ 资金状态: FAILED })), true);
  assert.equal(await blockedByGate(delivery({})), true);
  assert.equal(await blockedByGate(delivery({ '确认状态（旧）': '已入账' })), true);
});

// ── 闸门 2：salesFollowupService.listOrders —— 工作台订单列表 ──────────────────
test('闸门 2 订单列表（salesFollowupService.listOrders）：资金状态必须是「已写入」', async () => {
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

  assert.equal((await listOrders({ 资金状态: POSTED })).orders.length, 1);
  assert.equal((await listOrders({ 资金状态: FAILED })).orders.length, 0);
  assert.equal((await listOrders({})).orders.length, 0);
  assert.equal((await listOrders({ '确认状态（旧）': '已入账' })).orders.length, 0);
});

// ── 闸门 3：salesFollowupService.addPayment —— 补记收款 ───────────────────────
test('闸门 3 补记收款（salesFollowupService.addPayment）：资金状态必须是「已写入」', async () => {
  const addPayment = (entryFields) => new SalesFollowupService({
    gateway: gatewayFor({ salesEntry: [{ record_id: 'o1', fields: entryFields }] }),
    store: storeStub(),
  }).addPayment({
    requestId: '11111111-1111-1111-1111-111111111111',
    salesEntryRecordId: 'o1',
    // 金额故意非法：闸门放行后必然停在「收款金额」校验上，据此区分"闸门放行"。
    amount: 'x', method: '微信', operatorOpenId: 'ou_1',
  });

  assert.equal(await blockedByGate(addPayment({ 资金状态: POSTED })), false);
  assert.equal(await blockedByGate(addPayment({ 资金状态: FAILED })), true);
  assert.equal(await blockedByGate(addPayment({})), true);
  assert.equal(await blockedByGate(addPayment({ '确认状态（旧）': '已入账' })), true);
});

// ── 闸门 4：secondDeliveryService.confirm —— 二次交付 / 成交 ──────────────────
test('闸门 4 成交（secondDeliveryService.confirm）：资金状态必须是「已写入」', async () => {
  const confirm = (entryFields) => new SecondDeliveryService({
    gateway: gatewayFor({ salesEntry: [{ record_id: 'o1', fields: entryFields }] }),
    store: storeStub(),
    client: {},
  }).confirm({ salesEntryRecordId: 'o1', method: '微信' });

  // 放行后：没有待收款也没有未交付明细 → 直接回 alreadyCompleted，不再写任何东西。
  assert.equal((await confirm({ 资金状态: POSTED })).alreadyCompleted, true);
  assert.equal(await blockedByGate(confirm({ 资金状态: FAILED })), true);
  assert.equal(await blockedByGate(confirm({})), true);
  assert.equal(await blockedByGate(confirm({ '确认状态（旧）': '已入账' })), true);
});

// ── 闸门 5：secondDeliveryService.listPendingDeliveries —— 待成交提醒候选 ─────
test('闸门 5 提醒候选（secondDeliveryService.listPendingDeliveries）：资金状态必须是「已写入」', async () => {
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

  assert.equal((await candidates({ 资金状态: POSTED })).length, 1);
  assert.equal((await candidates({ 资金状态: FAILED })).length, 0);
  assert.equal((await candidates({})).length, 0);
  assert.equal((await candidates({ '确认状态（旧）': '已入账' })).length, 0);
});

// ── 闸门 6：v1WorkbenchService.getTodaySales —— 今日销售 ──────────────────────
test('闸门 6 今日销售（v1WorkbenchService.getTodaySales）：资金状态必须是「已写入」', async () => {
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

  assert.equal((await todayRows({ 资金状态: POSTED })).length, 1);
  assert.equal((await todayRows({ 资金状态: FAILED })).length, 0);
  assert.equal((await todayRows({})).length, 0);
  assert.equal((await todayRows({ '确认状态（旧）': '已入账' })).length, 0);
});
