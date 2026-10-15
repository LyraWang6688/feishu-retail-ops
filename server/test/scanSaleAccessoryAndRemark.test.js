/**
 * ⭐⭐ B：销售建单支持 —— **配品（单独一行）+ 备注 + 实收金额**
 *（业务负责人 2026-10-09 定，口径全文 `docs/sales-order-states-and-gifts-2026-10-09.md` 第三 / 四节）。
 *
 *   · **配品**：可选、**不是校验项**；**单独占一行「销售明细」**：`配品` 有值、
 *     **`编号` / `尺码` 留空**、**实收金额单列**；取值来自「**其他配品**」表的**名称**（关联字段）；
 *   · ⚠️ **配品行不参与「待交付 / 库存扣减」**（它没有鞋）⇒ 履约与库存计算里必须识别并跳过；
 *   · **备注**：写销售主表「**赠品**」（文本）；**页面上一定要有输入框，但可以为空**（不是校验项）；
 *   · **实收金额**：扫码建单页可填（留空时的兜底口径**先按现状** = 取那张表自己的「单价」，
 *     取不到就**让她填**，绝不写 0）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-B1 **配品行单独占一行销售明细**：`配品` 有值、`编号`/`尺码` 留空、
 *        `实收金额` 单列（鞋那一行一个字都不受影响）。
 *  AC-B2 **配品行不参与库存扣减**：纯配品单提交后 —— 实时库存一条不动、库存流水一条不写、
 *        履约状态 = 已交付（它没有"待交付"这回事）。
 *  AC-B3 **交付链路显式识别并跳过配品行**：把配品明文的 id 交给既有
 *        `SalesDeliveryService.deliver` ⇒ 结果里**如实标出"跳过"**，库存一动不动
 *        （不是"碰巧因为它已交付所以没扣"）。
 *  AC-B4 **备注写销售主表「赠品」**（明细不带赠品列）；**可以为空**（不填不报错）。
 *  AC-B5 **实收金额口径**（⭐ 2026-10-11 **方案甲**）：配品**填了** ⇒ 写她填的数；
 *        **留空 ⇒ 那一列留空**（**不再取「其他配品.单价」顶上去**、也绝不写 0）——
 *        与鞋那一行同一条规则（`scanSaleTwoLayerMoney.test.js` 的 AC-2b / AC-15）。
 *  AC-B6 **页面上能填**：销售领域渲染出①配品下拉（选项 = 「其他配品」的**名称**）
 *        ②配品实收金额 ③**备注输入框**；没有配品可选时**不画一个空下拉**（不留死控件）。
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

/** ⭐ 2026-10-13「金额两步走」：这一组能力**整块挪到第 2 步页** ⇒ 断言在它该在的那一页做
 *  （能力去哪：`renderSalePaymentStepPage`）。🔴 口径未放宽：字段名 / 标签 / 默认档一个字都没变 ✓
 *  ⚠️ 这里**自带 require**，不依赖各文件顶部的局部名（各文件的导入风格不一样）。 */
const step2Of = () => {
  const { SCAN_WRITE: SW } = require('../src/config/scanWrite');
  const { renderSalePaymentStepPage: renderStep2 } = require('../src/views/scanPageRenderer');
  return renderStep2({
    write: {
      texts: SW.texts, fields: SW.fields, actions: SW.actions,
      paymentMethods: SW.sale.paymentMethods,
      defaultPaymentMethod: SW.sale.defaultPaymentMethod,
      paymentRowCount: SW.sale.paymentRowCount,
      paymentStatus: SW.sale.paymentStatus.default,
      defaultPaymentStatus: SW.sale.paymentStatus.default,
      paidAmount: '', draft: { lines: [] },
    },
  });
};

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { SalesOrderService } = require('../src/services/salesOrderService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { renderScanPage, renderSalePaymentStepPage } = require('../src/views/scanPageRenderer');
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
  // ⭐⭐ 2026-10-15（⑨b-2）：开关默认翻成 `true` 之后，`submitSale` 变成"**单号先出、余下转后台**" ——
  //   ⇒ 用例**必须先等后台那一跑跑完**，再去回读端状态（不然读到的还是"没写完"的那一刻 ✗）。
  //   在这里**包一层**（`await result.background`）⇒ 本文件**所有** `write.submitSale(...)` 调用点
  //   **一个字都不用动** ✓（改前逐字：`write` 直接用服务实例；改后逐字：包成"等后台再返回" ✓）。
  //   依据：她 2026-10-15「**单号一出立刻回**…明细/库存/交付转后台」⇒ 端状态在后台跑完才齐 ✓
  //   🔴 **判据没放宽**：仍是"端状态逐字比"，只是**先等它跑完** ✓（不是我替它放宽，是等它做完 ✗）
  const rawSubmitSale = write.submitSale;
  write.submitSale = async (input) => {
    const result = await rawSubmitSale(input);
    if (!result?.background) return result;
    const rest = await result.background;
    // ⭐ 等完之后把**后台那一跑的结果合回来** ⇒
    //   用例拿到的就是"端状态齐了的那一份"（与开关关着时**同一个形状** ✓）
    //   ⚠️ 只合**有值**的键（不拿 `undefined` 去盖掉原来的字段 ✗）
    const defined = Object.fromEntries(
      Object.entries(rest || {}).filter(([, value]) => value !== undefined),
    );
    return { ...result, ...defined };
  };
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
  size: 40, inStock: true, ...overrides,
});
const addAccessory = (harness, openId, overrides = {}) => harness.write.addSaleLine({
  openId, kind: 'accessory', accessoryRecordId: 'acc_oil', ...overrides,
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B1 配品行单独占一行销售明细
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B1 配品单独占一行：配品有值、编号/尺码留空、实收金额单列（鞋那一行不受影响）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_acc_1';
    assert.equal((await addShoe(h, openId, { amount: 399 })).ok, true);
    assert.equal((await addAccessory(h, openId, { amount: 15 })).ok, true);   // 配品实收她填了 15

    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.detail_count, 2, '一单一双鞋 + 一件配品 = 两行明细');

    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const details = entriesOf(h, 'salesDetail');
    const accessoryRow = details.find((detail) => detail.fields[accessoryField]);
    assert.ok(accessoryRow, '配品那一行必须落在「配品」关联字段上');
    assert.deepEqual(accessoryRow.fields[accessoryField], ['acc_oil'], '配品 = 「其他配品」那一条记录');
    assert.equal(accessoryRow.fields['编号'], undefined, '配品行**不写编号**');
    assert.equal(accessoryRow.fields['尺码'], undefined, '配品行**不写尺码**');
    // ⚠️ 2026-10-11（方案甲）改写：改前配品留空 ⇒ 读「其他配品.单价」顶成 15；
    //    现在**留空就留空** ⇒ 这里改成"她填了 15 就写 15"（留空那条见 AC-B5）。
    assert.equal(accessoryRow.fields['实收金额'], 15, '实收金额**单列**（她填的那个数）');
    assert.equal(accessoryRow.fields['履约状态'], '已交付', '配品当场结清（既有可售品口径）');
    // 鞋那一行不受影响：她填了 399
    const shoeRow = details.find((detail) => !detail.fields[accessoryField]);
    assert.deepEqual(shoeRow.fields['编号'], ['prod_1']);
    assert.deepEqual(shoeRow.fields['尺码'], ['size_40']);
    assert.equal(shoeRow.fields['实收金额'], 399, '鞋那一行按她自己填的数写');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B2 配品行不参与库存扣减
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B2 配品行不参与库存扣减：纯配品单 → 库存一条不动、流水一条不写、库存引擎一次都不调', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_acc_only';
    await addAccessory(h, openId, { amount: '' });
    const before = entriesOf(h, 'liveInventory').map((record) => record.record_id);
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid });
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
    await addAccessory(h, openId, { amount: '' });
    await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid });
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
    await addAccessory(h, openId, { amount: '', gift: '' });
    await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['赠品'], '送袜子一双',
      '备注的落点是销售主表「赠品」列');
    for (const detail of entriesOf(h, 'salesDetail')) {
      assert.equal(detail.fields['赠品'], undefined, '明细没有「赠品」这一列（她已删）');
    }

    // 不填（空）也能提交 —— 备注**不是校验项**
    const openId2 = 'ou_acc_gift_empty';
    await addShoe(h, openId2, { gift: '' });
    const second = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2), paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(entriesOf(h, 'salesEntry')[1].fields['赠品'], '');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B5 配品实收金额的口径（⭐ 2026-10-11 方案甲：留空 ⇒ 那一列留空）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B5 配品金额留空 ⇒ **那一列留空**（不再取「其他配品.单价」）；填了就写她填的', async () => {
  const h = createHarness();
  try {
    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    // ⚠️ 三小段共用同一个 harness（明细表是累积的）⇒ 一律取**最后一条配品明细**。
    const lastAccessoryRow = () => entriesOf(h, 'salesDetail')
      .filter((detail) => detail.fields[accessoryField]).pop();

    // ① 留空 ⇒ 什么都不写（**改前**：读「其他配品.单价」顶成 15）
    const openId = 'ou_acc_amount';
    await addAccessory(h, openId, { amount: '' });
    const ok = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal('实收金额' in lastAccessoryRow().fields, false, '留空 ⇒ 那一列不写（不拿配品单价顶、也不写 0）');

    // ② 没有单价（`赠品鞋垫`）又没填 ⇒ **照样成单**（改前是 `accessory_amount_missing` 拦住）
    const openId2 = 'ou_acc_amount_missing';
    const added = await addAccessory(h, openId2, { accessoryRecordId: 'acc_insole', amount: '' });
    assert.equal(added.ok, true, '加进本单不校验金额（点【提交】才校验）');
    const ok2 = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2), paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(ok2.ok, true, JSON.stringify(ok2));
    assert.equal('实收金额' in lastAccessoryRow().fields, false, '没有单价也一样：留空 + 单照建成');

    // ③ 她**填了** ⇒ 写她填的（配品与鞋同规则）
    const openId3 = 'ou_acc_amount_filled';
    await addAccessory(h, openId3, { accessoryRecordId: 'acc_insole', amount: 39 });
    const ok3 = await h.write.submitSale({ openId: openId3, submitKey: await currentKey(h, openId3), paymentStatus: PAYMENT_STATUS.unpaid });
    assert.equal(ok3.ok, true, JSON.stringify(ok3));
    assert.equal(lastAccessoryRow().fields['实收金额'], 39, '填了就按她填的写');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B6 页面：配品下拉 + 配品金额 + 赠品输入框（且没有说明书）
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

test('AC-B6 录入页**不再有配品块**（能力改到工作台 ✓）· 服务层配品能力**仍在** · 赠品输入框仍在', async () => {
  // ⚠️ 2026-10-13 **改写**（能力退场，不是放宽断言）：
  //    改前：断言页面上有「配品下拉（选项 = 其他配品名称）+ 配品实收金额 + 赠品输入框」。
  //    她的口径（`docs/scan-sales-payment-flow-2026-10-13.md` 第六节逐字）：
  //    「先把**扫码页里的配品逻辑拿掉**，配品**改放在工作台里面**」⇒ 那一块**整块退场** ✓
  //    ⇒ 这条现在钉**两端**：
  //      ① 录入页**没有**配品块（下拉 / 配品实收 / 那一颗【加入本单】都不在 ✗）
  //      ② **服务层配品能力仍在**（直接调仍能加配品行 ✓ 表结构与能力一个字没动 ✓）
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE({ accessories: [{ record_id: 'acc_1', name: '腰带' }] }), 'sales');
  assert.equal(html.includes(`name="${SCAN_WRITE.fields.accessory}"`), false, '配品下拉必须没了');
  assert.equal(html.includes(SCAN_WRITE.actions.addAccessory), false, '配品那颗按钮必须没了');
  // ⚠️ 2026-10-13 改写：**切换条上现在本来就有「配品」两个字**（那是一个 tab 名 ✗）
  //    ⇒ 判据收窄到**销售那一块里**（她的本意："录入页不再有配品块" ✓）
  const salesBlock = html.slice(html.indexOf('realm-block--sales'));
  assert.equal(salesBlock.includes(SCAN_WRITE.texts.accessoryLabel), false, '录入页（销售块）里配品标签必须没了');
  // ⚠️ 别删错：备注（写「赠品」）与鞋的加单入口必须还在 ✓
  // ⭐ 2026-10-13 改指向：赠品输入框**仍在**（能力没退场），但渲染在**第 2 步页** ✓
  assert.match(step2Of(), new RegExp(`name="${SCAN_WRITE.fields.gift}"`), '赠品输入框仍在（在第 2 步页）');
  assert.match(html, new RegExp(`name="${SCAN_WRITE.fields.action}" value="${SCAN_WRITE.actions.addLine}"`),
    '鞋的【加入本单】/【还要加一双】必须还在（别删错 ✗）');

  // ② 服务层：配品能力仍在（这条是"服务层一行没动"的实证 ✓）
  const harness = createHarness();
  try {
    // ⚠️ 配品记录要取**夹具里真实存在的那件**（`acc_oil`），否则服务层会如实报
    //    「这件配品不在「其他配品」里」（那不是能力没了，是喂错了数据 ✗）
    const added = await addAccessory(harness, 'ou_acc_b6');
    assert.equal(added.ok, true, `服务层仍能加配品行：${JSON.stringify(added)}`);
    const lines = (await harness.sessions.get('ou_acc_b6')).sale.lines;
    assert.equal(lines.some((line) => line.kind === 'accessory'), true, '会话里真的多了一行配品');
  } finally { harness.cleanup(); }
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
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
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
      // ⚠️ 只用 `/added=1$/` 收口（与既有 `scanPageWrite` 的加入本单同一条）：
      //    缺省领域现在是**销售** ⇒ 回跳 URL 里不必再带 `?from=sales`（#311 之后的口径）。
      assert.match(String(posted.headers.get('location')), /added=1$/);

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

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-15（task-19 ② · Lead 批准的口子）：**会话键**与**操作人**拆开
//
// 起因（真事，不是假想）：「配品销售」那张表是**表变更事件**驱动的，一行 = 一次独立成单。
//   上一位实现里所有行共用一个写死的 `openId` 当会话键 ⇒ 第 2 条记录进来时，引擎的
//   `submitSale` 走到「键对不上 ⇒ 把上一单的结果还给你」那条分支 ⇒ 第 2 条记录
//   **拿到上一条的单号、自己一个字都没写** = 假成功（她最恨的那一类 ✗）。
//   ⚠️ 它**在单测里看不出来**（那条链路的用例用的是引擎替身）；只有**真引擎**才现形。
//
// 做法（两条都必须成立）：
//   · `sessionKey` **可选**，不传 = 按 `openId` 分 ⇒ **工作台 / 扫码两条老路一个字都不变** ✓；
//   · 传了 ⇒ 会话（草稿 / 幂等 / 进度）按它分，而 `openId` **只**当操作人写 User 字段 ✓
//     （`openId` 必须是真 open_id：它要写进「录单人」「操作人」这些 **User** 字段）。
// ═══════════════════════════════════════════════════════════════════════════

test('②1 🔴 同一个操作人 + 两条**各自独立会话**的记录 ⇒ 各自成单 / 各自单号 / 各自明细（第 2 条绝不返回上一条的单号）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_same_operator';       // ⚠️ **同一个人**（真实场景：她连着填了两行）
    const recordA = 'rec_accessory_sale_A';
    const recordB = 'rec_accessory_sale_B';
    const sessionA = `accessory_sale:${recordA}`;
    const sessionB = `accessory_sale:${recordB}`;

    assert.equal((await h.write.addSaleLine({
      openId, sessionKey: sessionA, kind: 'accessory', accessoryRecordId: 'acc_oil', amount: 34, inStock: true,
    })).ok, true);
    const a = await h.write.submitSale({
      openId, sessionKey: sessionA, submitKey: recordA,
      payments: [{ method: '微信', amount: '34' }], paymentStatus: PAYMENT_STATUS.full, paidAmount: '34',
    });
    assert.equal(a.ok, true, JSON.stringify(a));
    assert.equal(a.reused === true, false, '第 1 条是**新成单** ✓');

    assert.equal((await h.write.addSaleLine({
      openId, sessionKey: sessionB, kind: 'accessory', accessoryRecordId: 'acc_oil', amount: 15, inStock: true,
    })).ok, true);
    const b = await h.write.submitSale({
      openId, sessionKey: sessionB, submitKey: recordB,
      payments: [{ method: '微信', amount: '15' }], paymentStatus: PAYMENT_STATUS.full, paidAmount: '15',
    });
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.notEqual(b.order_no, a.order_no,
      '🔴 **第 2 条必须有自己的单号**（拿到上一条的单号 = 假成功 ✗）');
    assert.equal(b.reused === true, false, '第 2 条也不许被当成"重放" ✓');
    assert.equal(entriesOf(h, 'salesEntry').length, 2, '两张销售主表 ✓');
    assert.equal(entriesOf(h, 'salesDetail').length, 2, '两条明细（各写各的）✓');
    // 会话确实按 sessionKey 分：两个会话各自留档自己的那把键
    assert.equal((await h.sessions.get(sessionA)).sale.completed[0].key, recordA);
    assert.equal((await h.sessions.get(sessionB)).sale.completed[0].key, recordB);
  } finally { h.cleanup(); }
});

test('②2 ⭐ 同一个会话 + 同一把 `submitKey` 再来一次 ⇒ **幂等**（同一单号、不写第二遍）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_same_operator';
    const recordId = 'rec_accessory_sale_idem';
    const sessionKey = `accessory_sale:${recordId}`;
    await h.write.addSaleLine({
      openId, sessionKey, kind: 'accessory', accessoryRecordId: 'acc_oil', amount: 34, inStock: true,
    });
    const first = await h.write.submitSale({
      openId, sessionKey, submitKey: recordId,
      payments: [{ method: '微信', amount: '34' }], paymentStatus: PAYMENT_STATUS.full, paidAmount: '34',
    });
    // 同一行**再触发一次**（没有再加行）：引擎按 submitKey 认旧结果 ⇒ 不许写第二张单
    const again = await h.write.submitSale({
      openId, sessionKey, submitKey: recordId,
      payments: [{ method: '微信', amount: '34' }], paymentStatus: PAYMENT_STATUS.full, paidAmount: '34',
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true, '第二次必须走"认旧键"✓');
    assert.equal(again.order_no, first.order_no, '同一张单 ✓');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '🔴 只成一次单 ✓');
    assert.equal(entriesOf(h, 'salesDetail').length, 1, '🔴 明细不许写第二遍 ✓');
  } finally { h.cleanup(); }
});

test('②3 ⭐ 不传 `sessionKey` ⇒ 会话**仍按 openId**（工作台 / 扫码那条老路一个字都没变）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_old_path';
    await addAccessory(h, openId, { amount: 15 });
    const key = await currentKey(h, openId);   // 老路的幂等键 = 页面上那把会话键
    const result = await h.write.submitSale({
      openId, submitKey: key,
      payments: [{ method: '微信', amount: '15' }], paymentStatus: PAYMENT_STATUS.full, paidAmount: '15',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const session = await h.sessions.get(openId);
    assert.equal(session.sale.completed[0].key, key, '不传 sessionKey ⇒ 会话就是 openId 那一个 ✓');
    assert.equal(await h.sessions.get('accessory_sale:whatever'), null, '绝不会凭空另起一个会话 ✓');
    assert.equal(entriesOf(h, 'salesEntry').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-15（她逐字）：「目前配品销售表加了一个**录单人**字段，是飞书的**自动字段**，
//    就是**提交表单的人**」⇒ 那个人 = 「**销售主表.录单人**」（`sender`）。
//
// 下面两条是**端到端**（入口 service + **真引擎** + 假网关）：只钉"落进销售主表那一列"的真实形状 ——
//   ① 事件带了那一列 ⇒ 主表「录单人」= **那个人**（`[{ id: 'ou_…' }]`）
//   ② 三级都拿不到 ⇒ 主表 payload 里**没有这一列**（空 id ⇒ `person('')` = undefined ⇒ 飞书不报错 ✓）
//      ⚠️ **绝不编一个 id** ✗（编了就会出现一个假的"录单人"，AC-AS11 那条会红）
// ═══════════════════════════════════════════════════════════════════════════

const { createAccessorySaleIntakeService } = require('../src/services/accessorySaleIntakeService');
const { resolveAccessorySaleIntakeConfig } = require('../src/config/accessorySaleIntake');

const INTAKE_FIELD = {
  name: 'fld_t_name', quantity: 'fld_t_qty', paymentMethod: 'fld_t_method',
  amount: 'fld_t_amount', operator: 'fld_t_operator',
};
const intakeActionItem = ({ operatorId } = {}) => ({
  record_id: 'rec_intake_e2e_1',
  action: 'record_added',
  after_value: [
    { field_id: INTAKE_FIELD.name, field_value: [{ record_ids: ['acc_oil'] }] },
    { field_id: INTAKE_FIELD.quantity, field_value: 1 },
    { field_id: INTAKE_FIELD.paymentMethod, field_value: [{ text: '微信' }] },
    { field_id: INTAKE_FIELD.amount, field_value: 15 },
    ...(operatorId ? [{ field_id: INTAKE_FIELD.operator, field_value: [{ id: operatorId }] }] : []),
  ],
});
/** 入口 service + **真引擎**（`h.write`）；回写关掉（这张假表没有那两列，本组只验成单那一侧）。 */
const buildIntake = (h, over = {}) => {
  const base = resolveAccessorySaleIntakeConfig({});
  return createAccessorySaleIntakeService({
    gateway: h.gateway,
    scanWrite: h.write,
    config: {
      ...base,
      tableId: 'tbl_intake_e2e',
      fieldIds: INTAKE_FIELD,
      writeBack: { ...base.writeBack, enabled: false },
      ...over,
    },
  });
};

test('AC-AS9（端到端）⭐ 她表「录单人」= 提交表单的人 ⇒ **销售主表.录单人**就是那个人', async () => {
  const h = createHarness();
  try {
    const intake = buildIntake(h);
    const result = await intake.handleTableChanges([intakeActionItem({ operatorId: 'ou_who_filled' })], { event: {} });
    assert.equal(result.results[0].ok, true, JSON.stringify(result.results[0]));
    const rows = entriesOf(h, 'salesEntry');
    assert.equal(rows.length, 1, '销售主表写好 ✓');
    assert.deepEqual(rows[0].fields[V1_BITABLE_SCHEMA.tables.salesEntry.fields.sender],
      [{ id: 'ou_who_filled' }], '🔴 「销售主表.录单人」= 她表那一列的人 ✓');
    assert.equal(entriesOf(h, 'salesDetail').length, 1, '销售明细写好 ✓');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '收款明细写好 ✓');
  } finally { h.cleanup(); }
});

test('AC-AS11（端到端）🔴 三级都拿不到 ⇒ 销售主表 payload 里**没有**「录单人」那一列（绝不编 id ✗）', async () => {
  const h = createHarness();
  try {
    const intake = buildIntake(h);   // 事件没带那一列；假网关也没有 `getByTableId`（第三级也不可用）
    const result = await intake.handleTableChanges([intakeActionItem()], { event: {} });
    assert.equal(result.results[0].ok, true, '成单照办（录单人缺失**不是**拒单理由 ✓）');
    const rows = entriesOf(h, 'salesEntry');
    assert.equal(rows.length, 1);
    assert.equal(Object.keys(rows[0].fields).includes('录单人'), false,
      '🔴 payload 里**不许**出现「录单人」（不写这一列 ✓；编一个假 id 会在这条红 ✗）');
  } finally { h.cleanup(); }
});

