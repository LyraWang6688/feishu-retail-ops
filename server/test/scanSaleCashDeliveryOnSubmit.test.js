/**
 * ⭐⭐ A：**现货 ⇒ 提交即交付 + 扣库存**（业务负责人 2026-10-09 明确：「肯定是的」）。
 *
 * 口径全文：`docs/sales-order-states-and-gifts-2026-10-09.md` 第五节
 *   · 扫码建单：选中的尺码属于**有货（样品 + 门盒）** ⇒ 交易类型已经是**现货 `SALE_CASH`**
 *     ⇒ **提交时直接按「已交付」处理并扣库存**；
 *   · 选中**缺码** ⇒ **预订 `SALE_PREPAID`** ⇒ **不扣库存**（只写单）；
 *   · ⚠️ 扣库存必须走**既有交付链路**（`SalesDeliveryService.deliver`），**不许新写一套扣减**；
 *   · ⚠️ 幂等：连点只写一次；失败要**如实报错**、**不许"半扣"**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-A1 **现货行**（`inStock = true` ⇒ 会话里那一行 `trade_type_code = SALE_CASH`）：
 *        提交后① 明细「履约状态」= 已交付；② **库存真的少了一双**（那一双门盒被消耗）；
 *        ③ 新增一条「库存流水」，库存行为 = **销售减少**那条既有行为；
 *        ④ 主表「库存状态」= 已写入；⑤ 日志里出现既有交付链路的 `sales.inventory.applied`。
 *  AC-A2 **预订行**（缺码 ⇒ `SALE_PREPAID`）：提交后明细 = **未交付**，
 *        **实时库存一条都不动、库存流水一条都不写**（只写单）。
 *  AC-A3 **混合单**（一条现货 + 一条预订）：只有现货那一行交付并扣库存，预订那行照旧未交付。
 *  AC-A4 **幂等**：同一把提交键连点两次（含并发）⇒ 只交付一次、**只扣一次库存**
 *        （实时库存只少一双、库存流水只有一条、主表/明细各一条）。
 *  AC-A5 **不猜**：页面上拿不到"有货 / 没货"（`trade_type_code` 为空，例如老页面）⇒
 *        **不交付、不扣库存**（保持未交付，交给工作台那条既有交付入口）。
 *  AC-A6 **失败如实报错，不许"半扣"当成功**：现货那一双店里其实没货 ⇒
 *        提交返回里**如实**给出"库存没扣成"与原因（`stock.failed > 0`）、
 *        主表「库存状态」= 部分扣减 / 扣减失败，**并且这一单不算提交完成**（同一把键可以重试）。
 *  AC-A7 **重试只补没扣成的那一双**：补上库存后拿同一把键再提交 ⇒
 *        ① 那一双被扣掉；② **不会重复建单 / 重复建明细**（幂等没被破坏）；
 *        ③ 已经交付过的那一双**不会被重复扣**。
 *
 * ⚠️ 本文件用的是**真的** `SalesOrderService` / `SalesDeliveryService` / `InventoryService`
 *    （只有飞书那一层是内存替身）—— 所以"库存真的动了"是跑出来的，不是断言一句话。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// `services/larkMvpService`（被复用的主表创建函数所在模块）在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_cash_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_cash_test_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { deliversOnSubmit } = require('../src/config/salesMovements');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（照测试 Base 的真实列形状）────────────────────────────────────────
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER,
    货号: 'YD6693-2',
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A',
    单价: 399,
    供应商: ['sup_1'],
  },
};
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
/** 一双门盒（"有货"的那一双 —— 现货行扣的就是它）。 */
const liveUnit = (id, size, state = '门盒') => ({
  record_id: id,
  fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: state },
});

const seedTables = (overrides = {}) => ({
  product: [PRODUCT],
  sizeManagement: SIZE_RECORDS,
  // 40 有一双门盒（现货）；41 / 42 一双都没有（预订 / 库存对不上时用）
  liveInventory: [liveUnit('live_40_box', 40)],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { 行为名称: '现货', 行为编码: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { 行为名称: '预定', 行为编码: 'SALE_PREPAID' } },
    // 既有库存引擎认识的那条销售减少行为（`InventoryService` 的 MOVEMENT_SALE_DECREASE）
    { record_id: 'bh_sale_decrease', fields: { 行为名称: '销售减少', 行为编码: 'STOCK_SALE_DECREASE', 库存方向: '减少', 是否启用: true } },
  ],
  paymentMethod: [{ record_id: 'pm_wechat', fields: { 收款方式: '微信' } }],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
  ...overrides,
});

/** 内存假网关（语义键 → 物理列名走真 schema；写错语义键当场抛）。 */
const createFakeGateway = (tables = seedTables()) => {
  const writes = [];
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    writes,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((record) => String(record.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, record_id: record.record_id, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    // 卖出那一双会把「实时库存」里那条记录**删掉**（既有库存引擎的语义）；
    // 别的表一律不许删（扫码侧没有删除业务）。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      const before = (tables[key] || []).length;
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      writes.push({ op: 'delete', table: key, record_id: id, removed: before - (tables[key]).length });
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-cash-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 一套"真的在跑"的扫码写链路：真 service + 真业务层 + 真库存引擎，只有飞书那层是替身。 */
const createHarness = (options = {}) => {
  const gateway = createFakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const inventoryDir = tempDir('inventory');
  const replenishDir = tempDir('replenish');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const write = createScanWriteService({
    gateway,
    sessions,
    delivery,
    // 本文件不碰补货那条链路；给它一对不会落盘的替身，免得误写工作区。
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: replenishDir, idField: 'task_id' }),
  });
  return {
    gateway, sessions, inventory, delivery, write,
    tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(inventoryDir); rmDir(replenishDir); },
  };
};

const entriesOf = (harness, tableKey) => harness.tables[tableKey] || [];
const currentKey = async (harness, openId) => (await harness.sessions.get(openId)).sale.key;
const detailBySize = (harness, sizeRecordId) => entriesOf(harness, 'salesDetail')
  .find((detail) => (detail.fields['尺码'] || [])[0] === sizeRecordId);

/** 抓结构化日志（`logger` 写的是 console.log 的 JSON 行）。 */
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 判据在配置里（"哪几种交易类型是提交即交付"不写死在逻辑里）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A0 「提交即交付」的判据来自既有注册表：现货 true / 预定 false / 认不出的编码不交付', () => {
  assert.equal(deliversOnSubmit('SALE_CASH'), true, '现货（既有编码）= 提交即交付');
  assert.equal(deliversOnSubmit('SALE_PREPAID'), false, '预定（既有编码）= 不交付、不扣库存');
  assert.equal(deliversOnSubmit(''), false, '拿不到类型（老页面 / 还没定）⇒ 不猜、不交付');
  assert.equal(deliversOnSubmit('SALE_UNKNOWN'), false, '认不出的编码 ⇒ 不交付（绝不兜成现货）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A1 现货 ⇒ 提交即交付 + 真扣库存
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A1 现货（有货）：提交即交付 + 库存真的少一双 + 主表库存状态已写入（走既有交付链路）', async () => {
  const h = createHarness();
  const logs = captureLogs();
  try {
    const openId = 'ou_cash_1';
    const added = await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
      size: 40, amount: 399, inStock: true,
    });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(
      (await h.sessions.get(openId)).sale.lines[0].trade_type_code, 'SALE_CASH',
      '有货 ⇒ 既有判据 salesTradeTypeForStock 给的现货编码',
    );

    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentMethod: '微信', paymentAmount: '399',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stock?.failed, 0, `现货行必须扣成功：${JSON.stringify(result.stock)}`);

    // ① 明细 = 已交付
    assert.equal(detailBySize(h, 'size_40').fields['履约状态'], '已交付');
    // ② 库存真的少了一双（那一双门盒被消耗）
    assert.deepEqual(entriesOf(h, 'liveInventory').map((record) => record.record_id), [],
      '那一双门盒已经从「实时库存」里扣掉');
    // ③ 库存流水：一条，行为 = 既有「销售减少」那条行为
    const ledger = entriesOf(h, 'inventoryLedger');
    assert.equal(ledger.length, 1, '库存流水写了一条（既有库存引擎写的）');
    assert.deepEqual(ledger[0].fields['库存行为'], ['bh_sale_decrease']);
    assert.deepEqual(ledger[0].fields['关联销售'], [detailBySize(h, 'size_40').record_id]);
    // ④ 主表「库存状态」= 已写入（既有交付链路写的）
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], '已写入');
    // ⑤ 走的是**既有交付链路**：那条正向证据日志必须出现
    const applied = logs.events('sales.inventory.applied');
    assert.equal(applied.length, 1, `应有且仅有一条 sales.inventory.applied：${logs.lines.join('\n')}`);
    assert.match(applied[0], /"applied_detail_count":1/);
    assert.match(applied[0], /"stock_status":"已写入"/);
  } finally { logs.restore(); h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A2 预订 ⇒ 不交付、不扣库存
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A2 预订（缺码）：只写单 —— 明细未交付、实时库存一条不动、库存流水一条不写', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_prepaid_1';
    const before = entriesOf(h, 'liveInventory').map((record) => record.record_id);
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
      size: 41, amount: 399, inStock: false,
    });
    assert.equal((await h.sessions.get(openId)).sale.lines[0].trade_type_code, 'SALE_PREPAID');

    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.detail_count, 1, '单子照写（一单一双一行）');
    assert.equal(result.stock?.requested || 0, 0, '预订行根本不该请求交付');

    assert.equal(detailBySize(h, 'size_41').fields['履约状态'], '未交付', '缺码 ⇒ 未交付');
    assert.equal(entriesOf(h, 'salesDetail').length, 1);
    assert.deepEqual(entriesOf(h, 'liveInventory').map((record) => record.record_id), before, '库存没动');
    assert.deepEqual(entriesOf(h, 'inventoryLedger'), [], '一条库存流水都不许写');
    // 「库存状态」保持空的既有口径（没跑过交付，就不许写"已写入"）
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], undefined);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A3 混合单：一条现货 + 一条预订
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A3 混合单：只有现货那一行交付并扣库存，预订那一行照旧未交付', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_mixed_1';
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size: 40, amount: 399, inStock: true,
    });
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size: 41, amount: 399, inStock: false,
    });
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.detail_count, 2);
    assert.equal(result.stock.requested, 1, '只有现货那一行进了交付');
    assert.equal(result.stock.failed, 0);

    assert.equal(detailBySize(h, 'size_40').fields['履约状态'], '已交付');
    assert.equal(detailBySize(h, 'size_41').fields['履约状态'], '未交付');
    assert.deepEqual(entriesOf(h, 'liveInventory'), [], '只扣了现货那一双');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A4 幂等：连点只交付一次、只扣一次库存
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A4 幂等：同一把提交键连点两次（含并发）⇒ 只扣一次库存、只建一张单一条明细', async () => {
  const h = createHarness({
    tables: seedTables({ liveInventory: [liveUnit('live_40_a', 40), liveUnit('live_40_b', 40)] }),
  });
  try {
    const openId = 'ou_cash_idem';
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size: 40, amount: 399, inStock: true,
    });
    const key = await currentKey(h, openId);
    const first = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    const second = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.reused, false);
    assert.equal(second.reused, true, '第二次认得这是同一把键');

    // 并发：另开一单
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size: 40, amount: 399, inStock: true,
    });
    const key2 = await currentKey(h, openId);
    const [a, b] = await Promise.all([
      h.write.submitSale({ openId, submitKey: key2, paymentAmount: '' }),
      h.write.submitSale({ openId, submitKey: key2, paymentAmount: '' }),
    ]);
    assert.equal(a.ok && b.ok, true, JSON.stringify([a, b]));
    assert.equal([a, b].filter((item) => item.reused).length, 1, '并发时恰好一次真写');

    // 两单、两条明细、**两条库存流水**（= 只扣了两双，连点没有多扣）
    assert.equal(entriesOf(h, 'salesEntry').length, 2);
    assert.equal(entriesOf(h, 'salesDetail').length, 2);
    assert.equal(entriesOf(h, 'inventoryLedger').length, 2);
    assert.deepEqual(entriesOf(h, 'liveInventory'), [], '两双门盒各扣一次，没有多扣');
    for (const detail of entriesOf(h, 'salesDetail')) {
      assert.equal(detail.fields['履约状态'], '已交付');
    }
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A5 不猜：拿不到"有货 / 没货"就不交付
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A5 拿不到有货/没货（老页面没传 inStock）⇒ 不猜：不交付、不扣库存（保持既有未交付口径）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_cash_unknown';
    // 老页面 / 没传 inStock ⇒ 会话里那一行的 trade_type_code 是空串
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size: 40, amount: 399,
    });
    assert.equal((await h.sessions.get(openId)).sale.lines[0].trade_type_code, '');
    const before = entriesOf(h, 'liveInventory').map((record) => record.record_id);

    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(detailBySize(h, 'size_40').fields['履约状态'], '未交付');
    assert.deepEqual(entriesOf(h, 'liveInventory').map((record) => record.record_id), before);
    assert.deepEqual(entriesOf(h, 'inventoryLedger'), []);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A6 失败如实报错（不许半扣当成功）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A6 现货那一双其实没货 ⇒ 如实报"库存没扣成"+原因；主表库存状态 = 扣减失败；不算提交完成', async () => {
  const h = createHarness({ tables: seedTables({ liveInventory: [] }) });
  try {
    const openId = 'ou_cash_fail';
    await h.write.addSaleLine({
      openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size: 40, amount: 399, inStock: true,
    });
    const key = await currentKey(h, openId);
    const result = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    // 单子写了（货 / 钱记为事实），但**库存没扣成**这件事必须如实回给她
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.stock.requested, 1);
    assert.equal(result.stock.failed, 1, '如实报失败条数');
    assert.equal(result.stock.reasons.length, 1);
    assert.match(result.stock.reasons[0], /库存不足/, `原因要能看懂：${result.stock.reasons[0]}`);
    // 明细**不许**被写成已交付（没扣成就不能谎报已交付）
    assert.equal(detailBySize(h, 'size_40').fields['履约状态'], '未交付');
    // 主表「库存状态」= 写入失败（**既有取值**，见 config/salesStatusDimensions 的值域：
    // 「未写入 / 部分写入 / 已写入 / 写入失败」—— 别按交付服务里那句过时注释写成"扣减失败"）
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], '写入失败');
    // **不算提交完成**：同一把键还在（能重试）
    const session = await h.sessions.get(openId);
    assert.equal(session.sale.key, key, '失败那一次不许轮换幂等键（否则她就没法用同一把键重试）');
    assert.equal(session.sale.completed.length, 0, '失败那一次不许被记成"已提交过"');
    assert.equal(session.sale.master_record_id, entriesOf(h, 'salesEntry')[0].record_id,
      '主表 id 已落盘 ⇒ 重试接着同一张单写');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A7 重试：只补没扣成的那一双（不重复建单、不重复扣）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A7 失败后补上库存、拿同一把键再提交 ⇒ 只补扣没扣成的那一双（不重复建单/明细/扣减）', async () => {
  // 两条现货：40 有货（会扣成）、42 没货（会失败）
  const h = createHarness({ tables: seedTables({ liveInventory: [liveUnit('live_40_box', 40)] }) });
  try {
    const openId = 'ou_cash_retry';
    for (const size of [40, 42]) {
      await h.write.addSaleLine({
        openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', size, amount: 399, inStock: true,
      });
    }
    const key = await currentKey(h, openId);
    const first = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    assert.equal(first.stock.requested, 2);
    assert.equal(first.stock.failed, 1, '一条成、一条败');
    assert.equal(detailBySize(h, 'size_40').fields['履约状态'], '已交付');
    assert.equal(detailBySize(h, 'size_42').fields['履约状态'], '未交付');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 1);
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], '部分写入');

    // 店里补上 42 那一双 ⇒ 同一把键重试
    h.tables.liveInventory = [...h.tables.liveInventory, liveUnit('live_42_box', 42)];
    const second = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.stock.failed, 0, `重试必须把没扣成的那一双扣掉：${JSON.stringify(second.stock)}`);

    // 不重复：一张单、两条明细、两条流水；40 那一双**没被重复扣**
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '重试没有建第二张单');
    assert.equal(entriesOf(h, 'salesDetail').length, 2, '重试没有建第二条明细');
    assert.equal(entriesOf(h, 'inventoryLedger').length, 2, '40 只扣一次、42 扣一次');
    assert.deepEqual(entriesOf(h, 'liveInventory'), [], '两双都扣掉了');
    assert.equal(detailBySize(h, 'size_42').fields['履约状态'], '已交付');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], '已写入');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 源码哨兵：扣库存走的是**既有交付链路**，扫码侧没有第二套扣减
// ═══════════════════════════════════════════════════════════════════════════

test('源码哨兵：扫码写服务只调既有 SalesDeliveryService.deliver，自己没有一次库存写调用', () => {
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const source = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8'));
  assert.match(source, /SalesDeliveryService/, '交付必须复用既有 SalesDeliveryService');
  assert.match(source, /\.deliver\s*\(/, '交付必须走既有的 deliver 那一条');
  for (const pattern of [/new\s+InventoryService/, /\.applySale\s*\(/, /inventoryLedger/, /liveInventory/]) {
    assert.equal(pattern.test(source), false, `scanWriteService.js 出现了第二套扣减：${pattern}`);
  }
});
