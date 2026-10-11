/**
 * ⭐⭐ B：销售建单支持 —— **配品（单独一行）+ 备注 + 成交金额**
 *（业务负责人 2026-10-09 定，口径全文 `docs/sales-order-states-and-gifts-2026-10-09.md` 第三 / 四节）。
 *
 *   · **配品**：可选、**不是校验项**；**单独占一行「销售明细」**：`配品` 有值、
 *     **`编号` / `尺码` 留空**、**成交金额单列**；取值来自「**其他配品**」表的**名称**（关联字段）；
 *   · ⚠️ **配品行不参与「待交付 / 库存扣减」**（它没有鞋）⇒ 履约与库存计算里必须识别并跳过；
 *   · **备注**：写销售主表「**赠品**」（文本）；**页面上一定要有输入框，但可以为空**（不是校验项）；
 *   · **成交金额**：扫码建单页可填（留空时的兜底口径**先按现状** = 取那张表自己的「单价」，
 *     取不到就**让她填**，绝不写 0）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-B1 **配品行单独占一行销售明细**：`配品` 有值、`编号`/`尺码` 留空、
 *        `成交金额` 单列（鞋那一行一个字都不受影响）。
 *  AC-B2 **配品行不参与库存扣减**：纯配品单提交后 —— 实时库存一条不动、库存流水一条不写、
 *        履约状态 = 已交付（它没有"待交付"这回事）。
 *  AC-B3 **交付链路显式识别并跳过配品行**：把配品明文的 id 交给既有
 *        `SalesDeliveryService.deliver` ⇒ 结果里**如实标出"跳过"**，库存一动不动
 *        （不是"碰巧因为它已交付所以没扣"）。
 *  AC-B4 **备注写销售主表「赠品」**（明细不带赠品列）；**可以为空**（不填不报错）。
 *  AC-B5 **成交金额口径**：配品金额留空 ⇒ 取「其他配品.单价」；单价也没有 ⇒
 *        **明确让她填**（不是静默写 0、也不是拿别的数字顶）。
 *  AC-B6 **页面上能填**：销售领域渲染出①配品下拉（选项 = 「其他配品」的**名称**）
 *        ②配品成交金额 ③**备注输入框**；没有配品可选时**不画一个空下拉**（不留死控件）。
 *        页面里**没有说明书**（她 2026-10-10 的硬要求）。
 *  AC-B7 **路由**：POST 配品那一颗按钮 ⇒ 只写**本地会话**（业务表一个字都不写），
 *        会话里多一行 `kind = accessory`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_accessory_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_accessory_test_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { createScanPageRouter } = require('../src/routes/scanPage');

const NUMBER = 'YD6693-2|黑色|A';

const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A', 单价: 399, 供应商: ['sup_1'],
  },
};
/** 「其他配品」：`15元鞋油` 有单价；`赠品鞋垫` **没有单价**（AC-B5 用它）。 */
const ACCESSORIES = [
  { record_id: 'acc_oil', fields: { 名称: '15元鞋油', 种类: '鞋油', 单价: 15 } },
  { record_id: 'acc_insole', fields: { 名称: '赠品鞋垫', 种类: '鞋垫' } },
];
const SIZE_RECORDS = [40, 41].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const liveUnit = (id, size) => ({
  record_id: id, fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: '门盒' },
});

const seedTables = (overrides = {}) => ({
  product: [PRODUCT],
  accessory: ACCESSORIES,
  sizeManagement: SIZE_RECORDS,
  liveInventory: [liveUnit('live_40_box', 40)],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { 行为名称: '现货', 行为编码: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { 行为名称: '预定', 行为编码: 'SALE_PREPAID' } },
    { record_id: 'bh_sale_decrease', fields: { 行为名称: '销售减少', 行为编码: 'STOCK_SALE_DECREASE', 库存方向: '减少', 是否启用: true } },
  ],
  paymentMethod: [{ record_id: 'pm_wechat', fields: { 收款方式: '微信' } }],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
  ...overrides,
});

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
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      writes.push({ op: 'delete', table: key, record_id: id });
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-acc-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

const createHarness = (options = {}) => {
  const gateway = createFakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const replenishDir = tempDir('replenish');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  // ⚠️ 本文件不验"库存真的被扣"（那是 A 的用例），只验"配品行**不**参与扣减"——
  //    所以库存替身会**记账**（记下每一次调用）而不真动表。
  const stockCalls = [];
  const inventory = {
    applySale: async (input) => { stockCalls.push(input); return { sampleConsumedQuantity: 0 }; },
    getSaleResult: async () => null,
  };
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const write = createScanWriteService({
    gateway, sessions, delivery,
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: replenishDir, idField: 'task_id' }),
  });
  return {
    gateway, sessions, delivery, write, stockCalls,
    tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(replenishDir); },
  };
};

const entriesOf = (harness, tableKey) => harness.tables[tableKey] || [];
const currentKey = async (harness, openId) => (await harness.sessions.get(openId)).sale.key;
const addShoe = (harness, openId, overrides = {}) => harness.write.addSaleLine({
  openId, productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色',
  size: 40, amount: 399, inStock: true, ...overrides,
});
const addAccessory = (harness, openId, overrides = {}) => harness.write.addSaleLine({
  openId, kind: 'accessory', accessoryRecordId: 'acc_oil', amount: 15, ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B1 配品行单独占一行销售明细
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B1 配品单独占一行：配品有值、编号/尺码留空、成交金额单列（鞋那一行不受影响）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_acc_1';
    assert.equal((await addShoe(h, openId)).ok, true);
    assert.equal((await addAccessory(h, openId, { amount: 15 })).ok, true);

    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.detail_count, 2, '一单一双鞋 + 一件配品 = 两行明细');

    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const details = entriesOf(h, 'salesDetail');
    const accessoryRow = details.find((detail) => detail.fields[accessoryField]);
    assert.ok(accessoryRow, '配品那一行必须落在「配品」关联字段上');
    assert.deepEqual(accessoryRow.fields[accessoryField], ['acc_oil'], '配品 = 「其他配品」那一条记录');
    assert.equal(accessoryRow.fields['编号'], undefined, '配品行**不写编号**');
    assert.equal(accessoryRow.fields['尺码'], undefined, '配品行**不写尺码**');
    assert.equal(accessoryRow.fields['成交金额'], 15, '成交金额**单列**（她的口径）');
    assert.equal(accessoryRow.fields['履约状态'], '已交付', '配品当场结清（既有可售品口径）');
    // 鞋那一行不受影响
    const shoeRow = details.find((detail) => !detail.fields[accessoryField]);
    assert.deepEqual(shoeRow.fields['编号'], ['prod_1']);
    assert.deepEqual(shoeRow.fields['尺码'], ['size_40']);
    assert.equal(shoeRow.fields['成交金额'], 399);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B2 配品行不参与库存扣减
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B2 配品行不参与库存扣减：纯配品单 → 库存一条不动、流水一条不写、库存引擎一次都不调', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_acc_only';
    await addAccessory(h, openId, { amount: 15 });
    const before = entriesOf(h, 'liveInventory').map((record) => record.record_id);
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.detail_count, 1);
    assert.deepEqual(result.stock, { requested: 0, delivered: 0, failed: 0, reasons: [] },
      '配品这一行根本不该请求交付');
    assert.deepEqual(h.stockCalls, [], '库存引擎一次都没被调用（配品没有鞋）');
    assert.deepEqual(entriesOf(h, 'liveInventory').map((record) => record.record_id), before);
    assert.deepEqual(entriesOf(h, 'inventoryLedger'), []);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B3 交付链路**显式**识别并跳过配品行
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B3 既有交付链路显式跳过配品行（不是"碰巧因为它已交付"）—— 库存一动不动', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_acc_deliver';
    await addAccessory(h, openId, { amount: 15 });
    await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const accessoryRow = entriesOf(h, 'salesDetail').find((detail) => detail.fields[accessoryField]);
    const entry = entriesOf(h, 'salesEntry')[0];
    h.stockCalls.length = 0;
    const before = entriesOf(h, 'liveInventory').map((record) => record.record_id);

    // 她（或页面）把配品那一条明细交给交付入口 —— 必须**被认出来是配品**并跳过
    const invoice = await h.delivery.deliver({
      salesEntryRecordId: entry.record_id, detailRecordIds: [accessoryRow.record_id],
    });
    assert.equal(invoice.failures.length, 0, '跳过不是失败');
    const line = invoice.results.find((item) => item.detailRecordId === accessoryRow.record_id);
    assert.ok(line, '结果里必须**如实**有这一条');
    assert.equal(line.skipped, true, '如实标出"跳过"（配品没有鞋，不参与交付）');
    assert.equal(line.reason, 'not_tracked_kind', '跳过原因来自可售品属性（不跟踪库存）');
    assert.deepEqual(h.stockCalls, [], '库存引擎一次都没被调用');
    assert.deepEqual(entriesOf(h, 'liveInventory').map((record) => record.record_id), before);
    assert.deepEqual(entriesOf(h, 'inventoryLedger'), []);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B4 备注写销售主表「赠品」（可为空）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B4 备注写**销售主表.「赠品」**（明细不带这一列）；不填也能提交', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_acc_gift';
    await addShoe(h, openId, { gift: '送袜子一双' });
    await addAccessory(h, openId, { amount: 15, gift: '' });
    await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['赠品'], '送袜子一双',
      '备注的落点是销售主表「赠品」列');
    for (const detail of entriesOf(h, 'salesDetail')) {
      assert.equal(detail.fields['赠品'], undefined, '明细没有「赠品」这一列（她已删）');
    }

    // 不填（空）也能提交 —— 备注**不是校验项**
    const openId2 = 'ou_acc_gift_empty';
    await addShoe(h, openId2, { gift: '' });
    const second = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2), paymentAmount: '' });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(entriesOf(h, 'salesEntry')[1].fields['赠品'], '');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B5 配品成交金额的口径（留空 → 那张表的单价；取不到 → 让她填）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B5 配品金额留空 ⇒ 取「其他配品.单价」；单价也没有 ⇒ 明确让她填（绝不写 0）', async () => {
  const h = createHarness();
  try {
    // ① 留空 → 「其他配品.单价」= 15
    const openId = 'ou_acc_amount';
    await addAccessory(h, openId, { amount: '' });
    const ok = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const row = entriesOf(h, 'salesDetail').find((detail) => detail.fields[accessoryField]);
    assert.equal(row.fields['成交金额'], 15, '金额留空 ⇒ 用那张表自己的「单价」');

    // ② 没有单价（`赠品鞋垫`）又没填 → 明确报错，**不写 0**（也不建单）
    const openId2 = 'ou_acc_amount_missing';
    const added = await addAccessory(h, openId2, { accessoryRecordId: 'acc_insole', amount: '' });
    assert.equal(added.ok, true, '加进本单不校验金额（点【提交】才校验）');
    const failed = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2), paymentAmount: '' });
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'accessory_amount_missing');
    assert.match(failed.message, /赠品鞋垫/, '人话里点名是哪一件');
    assert.match(failed.message, /配品成交金额/, '告诉她填哪个字段');
    assert.equal(entriesOf(h, 'salesDetail').length, 1, '没成单：一条配品明细都不许写');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B6 页面：配品下拉 + 配品金额 + 备注输入框（且没有说明书）
// ═══════════════════════════════════════════════════════════════════════════

const VIEW = {
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色',
  category_name: '休闲鞋', category_code: 'A', price_text: '¥399', total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-11 10:00',
  product_record_id: 'prod_1',
};
const WRITE = (overrides = {}) => ({
  enabled: true, saleEnabled: true, replenishEnabled: true,
  texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: `/s/${encodeURIComponent(NUMBER)}`,
  sizes: [{ size_text: '40', missing: false }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_x:1',
  replenishKey: 'scan_replenish:scan_session_x:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  accessories: [{ record_id: 'acc_oil', name: '15元鞋油' }, { record_id: 'acc_insole', name: '赠品鞋垫' }],
  notice: '',
  ...overrides,
});

test('AC-B6 销售领域页面上：配品下拉（选项 = 「其他配品」名称）+ 配品成交金额 + 备注输入框', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE(), 'sales');
  // ① 配品下拉：动作是配品那一个，选项来自「其他配品」的名称
  assert.match(html, new RegExp(`name="${SCAN_WRITE.fields.action}" value="${SCAN_WRITE.actions.addAccessory}"`),
    '配品那一颗按钮必须有**自己的动作**');
  const select = html.match(new RegExp(`<select name="${SCAN_WRITE.fields.accessory}">([\\s\\S]*?)</select>`));
  assert.ok(select, '配品必须是一个下拉（选「其他配品」里的一件）');
  assert.match(select[1], /<option value="">[^<]*<\/option>/, '第一项是"不加配品"（配品不是校验项）');
  for (const name of ['15元鞋油', '赠品鞋垫']) {
    assert.ok(select[1].includes(`>${name}</option>`), `下拉里少了「${name}」`);
  }
  assert.ok(select[1].includes('value="acc_oil"'), '选项的 value = 那一条配品记录的 id（不靠名字猜）');
  // ② 配品成交金额（单列）+ ③ 备注输入框（可为空）
  assert.match(html, /配品成交金额/);
  assert.match(html, new RegExp(`name="${SCAN_WRITE.fields.amount}"`));
  assert.match(html, new RegExp(`name="${SCAN_WRITE.fields.gift}"`));
  assert.match(html, /备注/, '页面上写「备注」（落点是主表「赠品」列）');
  // ④ 页面里没有说明书（她 2026-10-10 的硬要求）：只有标签 / 占位 / 按钮
  for (const gone of ['怎么用', '使用说明', '你可以', '说明：']) {
    assert.equal(html.includes(gone), false, `页面上不该出现说明句：「${gone}」`);
  }
  // ⑤ 没有配品可选时**不画一个空下拉**（不留死控件）
  const noAccessory = renderScanPage(VIEW, SCAN_PAGE, WRITE({ accessories: [] }), 'sales');
  assert.equal(noAccessory.includes(`name="${SCAN_WRITE.fields.accessory}"`), false,
    '「其他配品」一件都没有时不画配品表单');
  assert.ok(noAccessory.includes(`name="${SCAN_WRITE.fields.gift}"`), '备注输入框照旧在（不是靠配品表单带出来的）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B7 路由：加配品只写本地会话
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'scan_accessory_test_session_secret';
const sessionCookie = (openId = 'ou_acc_route') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const formApp = (harness) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: harness.gateway,
    writeService: harness.write,
  }));
  return app;
};

test('AC-B7 路由：配品按钮 → 只写本地会话（业务表一个字不写），会话里多一行 kind=accessory', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_acc_route';
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const page = await fetch(pageUrl, { headers: { cookie: sessionCookie(openId) } });
      const html = await page.text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      const posted = await fetch(pageUrl, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: SCAN_WRITE.actions.addAccessory,
          submit_key: saleKey,
          [SCAN_WRITE.fields.accessory]: 'acc_oil',
          [SCAN_WRITE.fields.amount]: '15',
          [SCAN_WRITE.fields.gift]: '送鞋油',
        }).toString(),
      });
      assert.equal(posted.status, 303, `加配品应当 303 回原页：${posted.status}`);
      assert.match(String(posted.headers.get('location')), /from=sales&added=1$/);

      const session = await h.sessions.get(openId);
      assert.equal(session.sale.lines.length, 1);
      const line = session.sale.lines[0];
      assert.equal(line.kind, 'accessory');
      assert.equal(line.accessory_record_id, 'acc_oil');
      assert.equal(line.accessory_name, '15元鞋油', '本单里要能看出是哪一件（名称）');
      assert.equal(line.amount, 15);
      assert.equal(line.gift, '送鞋油');
      // **业务表一个字都没写**（点【提交】才写账）
      assert.deepEqual(entriesOf(h, 'salesEntry'), []);
      assert.deepEqual(entriesOf(h, 'salesDetail'), []);
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 源码哨兵：配品只用既有可售品通路（没有第二套"配品写库"）
// ═══════════════════════════════════════════════════════════════════════════

test('源码哨兵：配品走既有 SalesOrderService 的可售品通路（扫码侧没有第二套写库）', () => {
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const scanWrite = stripComments(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js'), 'utf8',
  ));
  // 配品的 kind / 关联字段名都由配置声明（`config/sellableKinds`），逻辑里不许写死
  assert.match(scanWrite, /sellableKindOf/, '配品的属性必须来自 config/sellableKinds');
  for (const pattern of [/accessoryRecordId:\s*'[^']*'/, /配品[\s\S]{0,80}gateway\.(create|update)/]) {
    assert.equal(pattern.test(scanWrite), false, `扫码侧出现了硬编码的配品写库：${pattern}`);
  }
  // 既有业务层确实**本来就支持**配品行（我们只是把 her 的输入翻译过去）
  const order = stripComments(fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'salesOrderService.js'), 'utf8',
  ));
  assert.match(order, /accessoryRecordId/, '配品那一行落哪个字段由既有业务层说了算');
  assert.ok(SalesOrderService && typeof SalesOrderService === 'function');
});
