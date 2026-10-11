/**
 * 扫码页**两个写入口**的验收用例（销售建单 / 补货报单）。
 *
 * 先写"按我们的链路应该是什么效果"，再逐条对照（业务负责人 2026-10-06 定的测试流程）：
 *   ① 累积多双 → 提交后**一张单多明细**（每双一行）；
 *   ② 连点两次 / 并发两次 → **只写一次**（幂等）；
 *   ③ **钱留空也能成单** + 状态如实（销售状态=已写入、资金状态=未写入）;
 *   ④ 收款方式**默认「微信」**（页面选中）**且可改**（改成现金就写现金）；
 *   ⑤ 赠品写**销售主表**的「赠品」列（明细不带赠品）；
 *   ⑥ 补货勾尺码 + 数量 → **采购申请**（走既有采购链路；供应商取「货品信息.供应商」）；
 *   ⑦ **不读写 `data/lark_mvp_tasks/`**（哨兵：跑完整条写入流程，那个目录一个字节都没变）；
 *   ⑧ 未登录 302 / 白名单外 403 语义不变（GET 与 POST 同一道闸门）；
 *   ⑨ 失败**有人话**（页面上说清楚；内部错误不回显）。
 *   ⭐ 2026-10-09（下半场）新增两条（"一个码、三个领域扫出来不一样"里销售与采购那两条）：
 *   ⑩ 销售：所选尺码在（样品 + 门盒）**有货 ⇒ 现货 `SALE_CASH`**，
 *      **没货 ⇒ 预订 `SALE_PREPAID`** —— 用**既有**行为编码写进**每条明细自己的**「交易类型」；
 *   ⑪ 采购【一键补货】：**勾了不填数量按 1 双算**（既有 `replenish.defaultQuantity`），
 *      填了就按她填的 —— 走**既有** `purchaseWebhookService.publishPurchaseRequest` 那条链路。
 *
 * 另有一条源码哨兵：扫码侧**没有第二套写库逻辑**
 *（`scanWriteService.js` 里没有任何 `gateway.create/update/delete`，只有对既有业务层的调用）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService`（被复用的主表创建函数所在模块）在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_write_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_write_test_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { SalesProgressService } = require('../src/services/salesProgressService');
// ⭐ 2026-10-11（A）：现货行"提交即交付 + 扣库存"之后，**交付**成了提交这一步的一部分。
//    本文件的假网关里没有「实时库存」（它只管扫码入口这一段），所以这里注入一个
//    只记账、不真动库存的库存替身 —— 交付**走的是真的** `SalesDeliveryService.deliver`，
//    库存真的被扣的验收在 `scanSaleCashDeliveryOnSubmit.test.js`（那边用真库存引擎）。
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const DATA_DIR = path.join(__dirname, '..', 'data');

// ── 夹具（照测试 Base 的真实列形状写）────────────────────────────────────────
const NUMBER = 'YD6693-2|黑色|A';
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER,
    货号: 'YD6693-2',
    颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A',
    品类: { text: '休闲鞋', record_ids: ['cat_casual'] },
    单价: 399,
    供应商: ['sup_1'],
  },
};
// 这一款**没有单价**（③⑨ 两条用例要用它）：金额留空就得让她自己填。
const PRODUCT_NO_PRICE = {
  record_id: 'prod_2',
  fields: { 编号: 'YD1111|白色|A', 货号: 'YD1111', 颜色: { text: '白色' }, 类别: 'A', 单价: null, 供应商: ['sup_1'] },
};
const SIZE_RECORDS = [
  { record_id: 'size_40', fields: { 尺码: 40 } },
  { record_id: 'size_41', fields: { 尺码: 41 } },
  { record_id: 'size_42', fields: { 尺码: 42 } },
  // ⭐ 2026-10-09：现货 / 预订那两组要用到的另外两个尺码（43 只有仓库货 / 44 完全没有）
  { record_id: 'size_43', fields: { 尺码: 43 } },
  { record_id: 'size_44', fields: { 尺码: 44 } },
];

const seedTables = (overrides = {}) => ({
  product: [PRODUCT],
  sizeManagement: SIZE_RECORDS,
  liveInventory: [],
  paymentMethod: [
    { record_id: 'pm_wechat', fields: { 收款方式: '微信' } },
    { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
  ],
  behavior: [
    { record_id: 'bh_request', fields: { 行为名称: '采购申请', 行为编码: 'STOCK_PURCHASE_INCREASE' } },
    // ⭐ 2026-10-09：现货 / 预订 = 扫码页销售建单要写的**既有**交易类型编码
    //    （「行为管理」表里就这两条，见 `config/salesMovements.js`）。
    { record_id: 'bh_cash', fields: { 行为名称: '现货', 行为编码: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { 行为名称: '预定', 行为编码: 'SALE_PREPAID' } },
  ],
  supplier: [{ record_id: 'sup_1', fields: { 供应商名称: '大发鞋厂' } }],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  ...overrides,
});

/**
 * 内存假网关。**语义键 → 物理列名**一律走真 schema（写错语义键当场抛，
 * 与真网关同一个形状）——这样"赠品写主表还是明细"这类断言才有意义。
 */
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
    // 假网关**不支持**按条件读：扫码页那条只读链路会自动回退整表读（既有行为）。
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
    delete: async () => { throw new Error('测试网关：扫码侧不许删记录'); },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-write-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 假采购群客户端：出图 → 发群 → 记映射，这一条链路走真的 PurchaseWebhookService。 */
const createFakeLarkClient = () => ({
  im: {
    image: { create: async () => ({ image_key: 'img_key_1' }) },
    message: {
      create: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_1', thread_id: 'th_1' } }),
      reply: async () => ({ code: 0, msg: 'ok', data: { message_id: 'om_2', thread_id: 'th_1' } }),
    },
  },
});

/**
 * 一套"真的在跑"的扫码写链路：真 service + 真业务层（SalesOrderService /
 * PurchaseWebhookService），只有飞书那一层是内存替身。
 */
const createHarness = (options = {}) => {
  const gateway = options.gateway || createFakeGateway(options.tables);
  const sessionDir = options.sessionDir || tempDir('session');
  const taskDir = options.taskDir || tempDir('task');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const purchaseStore = new JsonTaskStore({ dir: taskDir, idField: 'task_id' });
  const renders = [];
  const batchMessages = [];
  const purchase = new PurchaseWebhookService({
    client: createFakeLarkClient(),
    gateway,
    store: purchaseStore,
    images: { render: async (input) => { renders.push(input); return Buffer.from('png'); } },
    sandboxChatId: 'oc_test_group',
    batchLocator: { rememberGroupMessage: async (entry) => { batchMessages.push(entry); } },
    batchNoGenerator: { runExclusive: async (work) => work(), next: async () => ({ batchNo: 'CGD-20261008-0001' }) },
  });
  const delivery = options.delivery || new SalesDeliveryService({
    gateway,
    // 库存替身：只回一个成功结果（本文件不验库存，验的是扫码入口这一段）。
    inventory: { applySale: async () => ({ sampleConsumedQuantity: 0 }), getSaleResult: async () => null },
  });
  const write = createScanWriteService({
    gateway,
    sessions,
    purchase,
    purchaseStore,
    delivery,
    now: options.now,
  });
  return {
    gateway, sessions, purchase, purchaseStore, write, renders, batchMessages,
    cleanup: () => { rmDir(sessionDir); rmDir(taskDir); },
    tables: gateway._tables,
  };
};

const entriesOf = (gateway, tableKey) => gateway._tables[tableKey] || [];
const addLine = (harness, openId, line) => harness.write.addSaleLine({ openId, requestId: 'req_add', ...line });
const currentKey = async (harness, openId, flow = 'sale') => {
  const session = await harness.sessions.get(openId);
  return flow === 'replenish' ? session.replenish.key : session.sale.key;
};

// ── ① 累积多双 → 一张单多明细 ───────────────────────────────────────────────
test('① 连续扫三双加入本单 → 提交后是**一张销售单 + 三条明细**（每双一行）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_scan_1';
    for (const [size, amount] of [[40, 399], [41, 399], [42, 359]]) {
      const added = await addLine(h, openId, {
        productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2', color: '黑色', size, amount,
      });
      assert.equal(added.ok, true, JSON.stringify(added));
    }
    // 加了三双，**业务表一条都还没写**（"点【提交】才写账"）。
    assert.deepEqual(entriesOf(h.gateway, 'salesEntry'), []);
    assert.deepEqual(entriesOf(h.gateway, 'salesDetail'), []);

    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentMethod: '微信', paymentAmount: '',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.order_no, /^XSD-\d{8}-\d{4}$/, '单号由既有 salesOrderNo 逻辑生成');
    assert.equal(result.detail_count, 3);

    const entries = entriesOf(h.gateway, 'salesEntry');
    assert.equal(entries.length, 1, '一张单');
    const details = entriesOf(h.gateway, 'salesDetail');
    assert.equal(details.length, 3, '三条明细（每双一行）');
    for (const detail of details) {
      assert.equal(detail.fields['销售单号'][0], entries[0].record_id, '每条明细都挂在这一张单上');
      assert.equal(detail.fields['数量'], undefined, '明细没有「数量」这一列：一单一双就是一行');
      assert.equal(detail.fields['成交金额'] > 0, true);
    }
    // 「确认状态」= 已确认（她在页面上点了【提交】——提交就是确认）
    assert.equal(entries[0].fields['确认状态'], '已确认');
    // 🔴 2026-10-09：主表「原话」那一列已被业务负责人删除 ⇒ 扫码建单**不再写**它
    //（映射 + 写入点一起删，见 `config/v1BitableSchema.salesEntry` 段）。
    // ⚠️ 扫码侧那个「扫码建单（N 双）：…」模板（`config/scanWrite.js` 的
    // `SCAN_SALE_ORIGINAL_TEXT`）现在**没有落点**了 —— 本次**没动那个文件**
    //（它在"不要碰"清单里），已写进收尾报告的待办。
    // ⚠️ 这个假网关对未配置的语义键**当场抛**（与真网关同一个形状）⇒ 写入点回来这条就红。
    assert.equal(entries[0].fields['原话'], undefined,
      '「原话」列已删 ⇒ 扫码建单不许再写');
  } finally { h.cleanup(); }
});

// ── ② 幂等：连点两次 / 并发只写一次 ─────────────────────────────────────────
test('② 同一把提交键连点两次（含并发）→ **只写一次**，第二次把上一次的结果还给她', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_scan_2';
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 41, amount: 399 });
    const key = await currentKey(h, openId);

    const first = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    const second = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
    assert.equal(first.ok, true);
    assert.equal(first.reused, false);
    assert.equal(second.ok, true);
    assert.equal(second.reused, true, '第二次认得这是同一把键');
    assert.equal(second.order_no, first.order_no);
    assert.equal(entriesOf(h.gateway, 'salesEntry').length, 1);
    assert.equal(entriesOf(h.gateway, 'salesDetail').length, 1);

    // 并发：另开一张单，两个请求**同时**打进来
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 42, amount: 399 });
    const key2 = await currentKey(h, openId);
    const [a, b] = await Promise.all([
      h.write.submitSale({ openId, submitKey: key2, paymentAmount: '' }),
      h.write.submitSale({ openId, submitKey: key2, paymentAmount: '' }),
    ]);
    assert.equal(a.ok && b.ok, true);
    assert.equal([a, b].filter((item) => item.reused).length, 1, '并发时恰好一次真写、一次复用');
    assert.equal(entriesOf(h.gateway, 'salesEntry').length, 2, '第二张单只加了一条主表记录');
    assert.equal(entriesOf(h.gateway, 'salesDetail').length, 2);
  } finally { h.cleanup(); }
});

// ── ③ 钱留空也能成单 + 状态如实 ─────────────────────────────────────────────
test('③ 成交金额留空（按货品单价）+ 收款留空（先货后钱）→ 成单，状态如实', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_scan_3';
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 40, amount: '' });
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.payment_count, 0);

    const entry = entriesOf(h.gateway, 'salesEntry')[0];
    assert.equal(entry.fields['销售状态'], '已写入', '货写上了');
    assert.equal(entriesOf(h.gateway, 'paymentRecord').length, 0, '钱可以不填：一条收款明细都没有');
    assert.equal(entriesOf(h.gateway, 'salesDetail')[0].fields['成交金额'], 399, '金额留空按「货品信息.单价」');
    // 「资金状态」这一列是**既有业务层**的口径（= "收款这一步跑完了"），扫码侧一个字都没改它。
    // 「待补资金」是**既有进度口径**推出来的：收款明细为空 ⇒ 未收款 / 欠款 = 成交金额。
    const progress = await new SalesProgressService({ gateway: h.gateway })
      .forOrder(entry.record_id, { detailRecordIds: [entriesOf(h.gateway, 'salesDetail')[0].record_id] });
    assert.equal(progress.paymentStatus, '未收款', '既有口径就是「未收款」（工作台显示的待补资金）');
    assert.equal(progress.pendingAmount, 399);
    assert.equal(progress.fulfillmentStatus, '未交付');
  } finally { h.cleanup(); }
});

// ── ④ 默认收款方式 = 微信（可改）────────────────────────────────────────────
test('④ 收款方式默认「微信」；改成现金就写现金（扫码入口的默认值**只属于扫码**）', async () => {
  assert.equal(SCAN_WRITE.sale.defaultPaymentMethod, '微信');
  assert.equal(
    SCAN_WRITE.sale.paymentMethods[0], '微信',
    '表单第一项 = 默认选中项（页面渲染用例见下面第 ⑧ 条那一组）',
  );

  const h = createHarness();
  try {
    const openId = 'ou_scan_4';
    // ① 不改：写微信
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 40, amount: 399 });
    const wechat = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentAmount: '100', paymentMethod: '',
    });
    assert.equal(wechat.ok, true, JSON.stringify(wechat));
    // ② 改成现金：写现金
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 41, amount: 399 });
    const cash = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentAmount: '200', paymentMethod: '现金',
    });
    assert.equal(cash.ok, true, JSON.stringify(cash));

    const methodField = V1_BITABLE_SCHEMA.tables.paymentRecord.fields.method;
    const payments = entriesOf(h.gateway, 'paymentRecord');
    assert.equal(payments.length, 2);
    assert.deepEqual(payments[0].fields[methodField], ['pm_wechat'], '没传方式 → 用扫码页的默认「微信」');
    assert.deepEqual(payments[1].fields[methodField], ['pm_cash'], '她改了方式 → 按她说的写');
    assert.equal(payments[0].fields['收款金额'], 100);
    assert.equal(payments[0].fields['收款状态'], '已收款');
  } finally { h.cleanup(); }
});

// ── ⑤ 赠品写主表 ────────────────────────────────────────────────────────────
test('⑤ 赠品写**销售主表**的「赠品」列（明细不带赠品）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_scan_5';
    await addLine(h, openId, {
      productRecordId: 'prod_1', number: NUMBER, size: 40, amount: 399, gift: '袜子',
    });
    await addLine(h, openId, {
      productRecordId: 'prod_1', number: NUMBER, size: 41, amount: 399, gift: '鞋垫',
    });
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    assert.equal(result.ok, true, JSON.stringify(result));
    const entry = entriesOf(h.gateway, 'salesEntry')[0];
    assert.equal(entry.fields['赠品'], '袜子、鞋垫', '一单一条：合并规则来自 config/salesGift');
    for (const detail of entriesOf(h.gateway, 'salesDetail')) {
      assert.equal(Object.prototype.hasOwnProperty.call(detail.fields, '赠品'), false, '明细没有赠品这一列');
    }
  } finally { h.cleanup(); }
});

// ── ⑥ 补货报单 → 采购申请（供应商取货品信息）─────────────────────────────────
test('⑥ 勾选尺码 + 填数量 → 生成采购申请（走既有采购链路，供应商取「货品信息.供应商」）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_scan_6';
    await h.write.addSaleLine({
      openId, requestId: 'req_pre', productRecordId: 'prod_1', number: NUMBER, size: 40, amount: 399,
    });
    const key = await currentKey(h, openId, 'replenish');
    const result = await h.write.submitReplenish({
      openId,
      submitKey: key,
      productRecordId: 'prod_1',
      number: NUMBER,
      entries: [{ size: 41, quantity: 2 }, { size: 42, quantity: 1 }],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.request_count, 2);
    assert.equal(result.batch_no, 'CGD-20261008-0001', '批次号由既有生成器给');

    const requests = entriesOf(h.gateway, 'purchaseRequest');
    assert.equal(requests.length, 2, '勾了两个尺码 → 两条采购申请');
    const bySize = new Map(requests.map((record) => [String(record.fields['尺码']), record]));
    assert.deepEqual(bySize.get('size_41').fields['数量'], 2, '数量按她填的写');
    assert.deepEqual(bySize.get('size_42').fields['数量'], 1);
    for (const record of requests) {
      assert.deepEqual(record.fields['编号'], ['prod_1']);
      assert.deepEqual(record.fields['采购行为'], ['bh_request'], '采购行为来自「行为管理」的既有编码');
      assert.ok(record.fields['幂等键'], '每条采购申请都有幂等键（既有 createOnceByKey 的回查依据）');
      assert.ok(record.fields['报货批次号'], '挂在同一个报货批次上');
    }
    assert.equal(entriesOf(h.gateway, 'purchaseOrderBatch').length, 1);

    // 供应商取「货品信息.供应商」：出图那一步按供应商分组（既有链路的分组依据）。
    assert.equal(h.renders.length, 1);
    assert.equal(h.renders[0].supplierName, '大发鞋厂');
    assert.deepEqual(h.renders[0].items.map((item) => item.size), [41, 42]);

    // 幂等：同一把键再提交一次 → 不再写第二条采购申请。
    const again = await h.write.submitReplenish({
      openId, submitKey: key, productRecordId: 'prod_1', number: NUMBER,
      entries: [{ size: 41, quantity: 2 }, { size: 42, quantity: 1 }],
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(entriesOf(h.gateway, 'purchaseRequest').length, 2, '重放不写第二条');
    assert.equal(entriesOf(h.gateway, 'purchaseOrderBatch').length, 1);
  } finally { h.cleanup(); }
});

// ── ⑦ 不读写 lark_mvp_tasks（哨兵）─────────────────────────────────────────
test('⑦ 整条写入链路**不读写** `data/lark_mvp_tasks/`（群聊入口的任务记录）', async () => {
  // 源码哨兵：三个新件里一个字都不许出现那条路径（**注释里提到它是对的** ——
  // 那里写的正是"绝不碰它"，所以先把注释剥掉再看代码）。
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  for (const file of ['services/scanWriteService.js', 'services/scanSessionService.js', 'config/scanWrite.js']) {
    const code = stripComments(fs.readFileSync(path.join(SERVER_SRC, file), 'utf8'));
    assert.equal(code.includes('lark_mvp_tasks'), false, `${file} 的代码里出现了 lark_mvp_tasks`);
  }
  // 默认落点是**扫码自己的**目录（入口隔离约定里点名的那个形状）。
  assert.match(SCAN_WRITE.session.dir, /scan_sessions$/);

  // 运行时哨兵：跑完整条写链路，`data/lark_mvp_tasks/` 的文件清单与修改时间**一个都没变**。
  const snapshot = () => {
    if (!fs.existsSync(DATA_DIR)) return null;
    const dir = path.join(DATA_DIR, 'lark_mvp_tasks');
    if (!fs.existsSync(dir)) return { dir: '', files: [] };
    return {
      dir,
      files: fs.readdirSync(dir).sort().map((name) => {
        const stat = fs.statSync(path.join(dir, name));
        return `${name}:${stat.size}:${stat.mtimeMs}`;
      }),
    };
  };
  const before = snapshot();

  const h = createHarness();
  try {
    const openId = 'ou_scan_7';
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 40, amount: 399 });
    await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), paymentAmount: '' });
    await h.write.submitReplenish({
      openId, submitKey: await currentKey(h, openId, 'replenish'),
      productRecordId: 'prod_1', number: NUMBER, entries: [{ size: 41, quantity: 1 }],
    });
  } finally { h.cleanup(); }

  assert.deepEqual(snapshot(), before, 'lark_mvp_tasks 一个字节都不许因扫码而变');
});

// ── ⑧ 闸门语义不变（GET 与 POST 同一道）+ 页面上的默认收款方式 ───────────────
const SESSION_SECRET = 'scan_write_test_session_secret';
const sessionCookie = (openId = 'ou_scan_route') => {
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

const view = (overrides = {}) => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
  ...overrides,
});

const formApp = (harness, lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup },
    gateway: harness.gateway,
    writeService: harness.write,
  }));
  return app;
};

test('⑧ 页面上的两个写入口：默认收款方式「微信」+ 缺码的尺码默认勾上（POST 走同一道闸门）', async () => {
  login();
  const h = createHarness();
  try {
    const app = formApp(h);
    await withServer(app, async (base) => {
      // 未登录：GET 与 POST 都是 302 去登录（共享闸门的语义没变）
      const anonymousGet = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`, { redirect: 'manual' });
      assert.equal(anonymousGet.status, 302);
      const anonymousPost = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `action=${SCAN_WRITE.actions.addLine}&size=40`,
      });
      assert.equal(anonymousPost.status, 302, '写入口也在同一道闸门里');
      assert.match(anonymousPost.headers.get('location'), /^\/api\/auth\/feishu\/start\?next=/);

      // 已登录：拿到写入口表单。
      // ⚠️ 2026-10-09（手机白屏之后）起：**服务端按 `?from` 只渲染那一块** ——
      //    销售建单在 `from=sales`、补货报单在 `from=purchase`，一次请求只回其中一块。
      const salePage = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, { headers: { cookie: sessionCookie() } });
      assert.equal(salePage.status, 200);
      const saleHtml = await salePage.text();
      // ⚠️ 2026-10-10 断言翻转（她：「删掉解释我怎么用的句子」）：原先这里钉着
      //    卡片标题「销售（可以连着扫，最后一起提交）」（`saleHeading`）**要在页面上**；
      //    现在它必须不存在。**不放宽**：能填能点的（加入本单 / 提交这一单 / 默认微信）照旧。
      assert.equal(saleHtml.includes('销售（可以连着扫，最后一起提交）'), false, '销售那句说明必须删掉');
      assert.match(saleHtml, /加入本单/);
      // 默认选中「微信」
      assert.match(saleHtml, new RegExp(`<option value="微信" selected>微信</option>`));
      // 幂等键在表单里（这一把就是"连点两次只写一次"的判据）
      assert.match(saleHtml, /name="submit_key" value="scan_sale:scan_session_[0-9a-f]{16}:1"/);

      const purchasePage = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=purchase`, { headers: { cookie: sessionCookie() } });
      assert.equal(purchasePage.status, 200);
      const html = await purchasePage.text();
      // ⚠️ 2026-10-10 断言翻转：补货那句标题「补货报单（勾选要补的尺码）」必须不存在；
      //    能点的（各尺码清单 + 一键补货 + 默认勾上的缺码）照旧。
      assert.equal(html.includes('补货报单（勾选要补的尺码）'), false, '补货那句标题必须删掉');
      assert.match(html, /data-view="purchase-sizes"/);
      assert.match(html, /data-view="one-tap-replenish"/);
      // 缺码的 41 默认勾上
      assert.match(html, /name="sizes" value="41" checked/);
      assert.equal(/name="sizes" value="40" checked/.test(html), false, '40 不缺码 → 不预勾');
      assert.match(html, /name="submit_key" value="scan_replenish:scan_session_[0-9a-f]{16}:1"/);
    });

    // 白名单外：GET 与 POST 都是 403（共享闸门一字不变）
    process.env.WORKBENCH_ALLOWED_OPEN_IDS = 'ou_allowed';
    try {
      await withServer(formApp(h), async (base) => {
        const get = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`, { headers: { cookie: sessionCookie('ou_other') } });
        assert.equal(get.status, 403);
        const post = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`, {
          method: 'POST',
          headers: { cookie: sessionCookie('ou_other'), 'content-type': 'application/x-www-form-urlencoded' },
          body: `action=${SCAN_WRITE.actions.submitOrder}&submit_key=x`,
        });
        assert.equal(post.status, 403);
      });
    } finally {
      delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
    }

    // 认证没启用：503（与工作台一字不差）
    process.env.LARK_WEB_AUTH_ENABLED = 'false';
    await withServer(formApp(h), async (base) => {
      const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`);
      assert.equal(response.status, 503);
    });
    login();
  } finally { h.cleanup(); }
});

test('⑧ 路由：加入本单 → 回跳带上"本单几双"；提交整单 → 结果页给人话（含先货后钱那句）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_scan_route';
    const app = formApp(h);
    await withServer(app, async (base) => {
      // ⭐ 2026-10-11：缺省领域改回**销售** ⇒ 销售页的显式 `?from=sales` 照旧可用（四个值都还在）。
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const page = await fetch(pageUrl, { headers: { cookie: sessionCookie(openId) } });
      const html = await page.text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];

      // 加入本单：303 回原页（Post-Redirect-Get），本单变成 1 双
      const added = await fetch(pageUrl, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size: '40', amount: '399', gift: '袜子' }).toString(),
      });
      assert.equal(added.status, 303);
      // ⭐ 2026-10-11：缺省领域改回**销售** ⇒ 缺省领域不带 `?from=`（URL 干净），
      //    但**绝不许掉到别的领域**。非缺省领域的回跳带上 `?from=`（见 `postActionFor`
      //    与 `scanPageDraftBar.test.js` 的 AC-DB7）。
      assert.match(String(added.headers.get('location')), /added=1$/);
      assert.equal(String(added.headers.get('location')).includes('from=inventory'), false,
        '加单回跳必须停在本单所在的领域（销售），不许掉到库存');

      const afterAdd = await fetch(`${pageUrl}&added=1`, { headers: { cookie: sessionCookie(openId) } });
      const afterHtml = await afterAdd.text();
      assert.match(afterHtml, /已加入本单（1 双）/);
      assert.match(afterHtml, /本单已加 1 双/);
      assert.match(afterHtml, /YD6693-2 · 40 码/);

      // 提交整单（带收款）：结果页给她单号 + 明细分行 + 收款那句
      const submitted = await fetch(pageUrl, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey, payment_method: '现金', payment_amount: '100',
        }).toString(),
      });
      assert.equal(submitted.status, 200);
      const doneHtml = await submitted.text();
      assert.match(doneHtml, /这一单提交好了/);
      assert.match(doneHtml, /XSD-\d{8}-\d{4}/);
      assert.match(doneHtml, /明细：1 双/);
      assert.match(doneHtml, /接着扫下一款就可以开新的一单。/);
      assert.equal(entriesOf(h.gateway, 'salesEntry').length, 1);
      const methodField = V1_BITABLE_SCHEMA.tables.paymentRecord.fields.method;
      assert.equal(entriesOf(h.gateway, 'paymentRecord')[0].fields[methodField][0], 'pm_cash');
    });
  } finally { h.cleanup(); }
});

test('⑧ 路由：补货表单勾两个尺码 → 采购申请结果页（批次号 + 条数）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_scan_route';
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}`;
      // ⚠️ 补货表单在 `from=purchase` 那一块（服务端只渲染当前领域）
      const html = await (await fetch(`${pageUrl}?from=purchase`, { headers: { cookie: sessionCookie(openId) } })).text();
      const replenishKey = html.match(/name="submit_key" value="(scan_replenish:[^"]+)"/)[1];
      const response = await fetch(pageUrl, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: SCAN_WRITE.actions.replenish,
          submit_key: replenishKey,
          sizes: '40',
          qty_40: '3',
        }).toString(),
      });
      assert.equal(response.status, 200);
      const doneHtml = await response.text();
      assert.match(doneHtml, /采购申请已生成/);
      assert.match(doneHtml, /CGD-20261008-0001/);
      assert.match(doneHtml, /采购申请：1 条/);
      assert.equal(entriesOf(h.gateway, 'purchaseRequest')[0].fields['数量'], 3);
    });
  } finally { h.cleanup(); }
});

// ── ⑨ 失败有人话 ────────────────────────────────────────────────────────────
test('⑨ 失败有人话：没单价又没填金额 → 页面上说清"要填成交金额"，不是静默/只写日志', async () => {
  login();
  const h = createHarness({ tables: seedTables({ product: [PRODUCT, PRODUCT_NO_PRICE] }) });
  try {
    const openId = 'ou_scan_fail';
    await h.write.addSaleLine({
      openId, requestId: 'req', productRecordId: 'prod_2', number: 'YD1111|白色|A', itemNo: 'YD1111', size: 40, amount: '',
    });
    const key = await currentKey(h, openId);
    await withServer(formApp(h, async () => view({
      number: 'YD1111|白色|A', item_no: 'YD1111', product_record_id: 'prod_2',
    })), async (base) => {
      const response = await fetch(`${base}/s/${encodeURIComponent('YD1111|白色|A')}`, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.submitOrder, submit_key: key }).toString(),
      });
      assert.equal(response.status, 400, '她可以改一下就再提交 → 400 而不是 500');
      const html = await response.text();
      assert.match(html, /这一步没成功/);
      assert.match(html, /「YD1111」在「货品信息」里没有单价，请填一下成交金额再提交。/);
      assert.match(html, /可以照上面那句话改一下再点一次/);
      // 金额是在**建主表之前**算的 ⇒ 这一种失败不会留下半张空单（更好，不是更差）。
      assert.equal(entriesOf(h.gateway, 'salesEntry').length, 0);
      assert.equal(entriesOf(h.gateway, 'salesDetail').length, 0);
      // 而她改完金额再提交，就能成单（同一把键、同一页）
      const fixed = await h.write.submitSale({ openId, submitKey: key, paymentAmount: '' });
      // 金额仍取不到 ⇒ 仍然是人话失败（**不许写 0**）
      assert.equal(fixed.ok, false);
      assert.match(fixed.message, /没有单价/);
    });
  } finally { h.cleanup(); }
});

test('⑨ 失败有人话：内部错误（字段名/错误码）**不回显**，页面只给配置好的通用人话', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_scan_fail2';
    await addLine(h, openId, { productRecordId: 'prod_1', number: NUMBER, size: 40, amount: 399 });
    const key = await currentKey(h, openId);
    // 让业务层在写明细那一步抛一个"内部形状"的错误（真实现里长这样）。
    const original = h.gateway.update;
    h.gateway.update = async (tableKey, id, values) => {
      if (tableKey === 'salesDetail' || values?.gift !== undefined) {
        throw new Error('未配置语义字段: gift（内部细节，不许给她看）');
      }
      return original(tableKey, id, values);
    };
    await withServer(formApp(h), async (base) => {
      const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}`, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.submitOrder, submit_key: key }).toString(),
      });
      assert.equal(response.status, 500);
      const html = await response.text();
      assert.match(html, /这一步没成功/);
      assert.match(html, /系统这边没处理成功/, '通用人话要在页面上');
      assert.equal(html.includes('未配置语义字段'), false, '内部细节不许回显');
      assert.equal(html.includes('gift'), false);
    });
  } finally { h.cleanup(); }
});

test('⑨ 失败有人话：清空本单 / 未知动作也给页面回应（不静默）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_scan_fail3';
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}`;
      const cleared = await fetch(pageUrl, {
        method: 'POST', redirect: 'manual',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.clearDraft }).toString(),
      });
      assert.equal(cleared.status, 303);
      const unknown = await fetch(pageUrl, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'action=nonsense',
      });
      assert.equal(unknown.status, 400);
      assert.match(await unknown.text(), /这一页上的按钮我认不出来/);
    });
  } finally { h.cleanup(); }
});

// ── ⭐ 2026-10-09（下半场）⑩ 现货 / 预订（既有行为编码）─────────────────────────
/**
 * 一个"有货 / 没货"齐全的视图模型（页面上的两个分组就是按它分的）：
 *   40 门盒 1            ⇒ 现货
 *   41 三种状态都没有     ⇒ 预订（缺码）
 *   42 门盒 1 + 样品 1    ⇒ 现货
 *   43 只有仓库 2        ⇒ 预订（**可卖 = 样品 + 门盒**，仓库不算）
 */
const realmView = (overrides = {}) => ({
  ...view(),
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }, { count: 0 }, { count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }, { count: 0 }, { count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ count: 1 }, { count: 1 }, { count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ count: 0 }, { count: 0 }, { count: 2 }], total: 2, missing: false },
  ],
  ...overrides,
});

test('⑩ 现货 / 预订：所选尺码在（样品 + 门盒）有货 ⇒ SALE_CASH，没货 ⇒ SALE_PREPAID', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_scan_realm';
    await withServer(formApp(h, async () => realmView()), async (base) => {
      // ⭐ 2026-10-09：缺省领域 = 库存 ⇒ 现货/预订这两组在【销售】那一块，显式带 `?from=sales`。
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const page = await fetch(pageUrl, { headers: { cookie: sessionCookie(openId) } });
      const html = await page.text();

      // ① 页面上就是两组（有货 ⇒ 现货 / 其余 ⇒ 预订）
      assert.ok(html.includes('data-stock-group="in_stock"'), '第一组 = 有货（现货）');
      assert.ok(html.includes('data-stock-group="prepaid"'), '第二组 = 没有的（预订）');
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];

      // ② 加"有货的 42" + "只有仓库货的 43"
      for (const size of ['42', '43']) {
        const response = await fetch(pageUrl, {
          method: 'POST', redirect: 'manual',
          headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size }).toString(),
        });
        assert.equal(response.status, 303, `加入 ${size} 码应当回跳`);
      }
      const session = await h.sessions.get(openId);
      assert.deepEqual(
        session.sale.lines.map((line) => [String(line.size), line.trade_type_code]),
        [['42', 'SALE_CASH'], ['43', 'SALE_PREPAID']],
        '交易类型按"选中的那一组"定，用的是**既有**行为编码',
      );

      // ③ 提交 → **每条明细写自己那一个**交易类型（关联「行为管理」里那两条既有记录）
      const result = await h.write.submitSale({
        openId, submitKey: await currentKey(h, openId), paymentAmount: '',
      });
      assert.equal(result.ok, true, JSON.stringify(result));
      const tradeType = V1_BITABLE_SCHEMA.tables.salesDetail.fields.tradeType;
      const bySize = new Map(entriesOf(h.gateway, 'salesDetail')
        .map((detail) => [detail.fields['尺码'][0], detail.fields[tradeType]]));
      assert.deepEqual(bySize.get('size_42'), ['bh_cash'], '现货那一行 = 现货（SALE_CASH）');
      assert.deepEqual(bySize.get('size_43'), ['bh_prepaid'], '预订那一行 = 预订（SALE_PREPAID）');
    });
  } finally { h.cleanup(); }
});

// ── ⭐ 2026-10-09（下半场）⑪ 一键补货：默认各 1 双（数量可改）────────────────────
test('⑪ 一键补货：勾了不填数量按 **1 双**算（填了就按她填的）→ 既有采购链路', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_scan_replenish_default';
    // 扫开就直接补货：会话还没建，页面上的键就是第 1 轮那把（纯函数算出来的）。
    const key = h.write.sessions.submitKeyFor(openId, null, 'replenish');
    const result = await h.write.submitReplenish({
      openId,
      submitKey: key,
      productRecordId: 'prod_1',
      number: NUMBER,
      // 缺的尺码默认各 1 双（页面预勾 + 预填 1）；她改了 42 就按她填的写。
      entries: [{ size: 41 }, { size: 42, quantity: 3 }],
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const requests = entriesOf(h.gateway, 'purchaseRequest');
    const bySize = new Map(requests.map((record) => [String(record.fields['尺码']), record.fields['数量']]));
    assert.equal(bySize.get('size_41'), 1, '没填数量 → 1 双（既有 defaultQuantity）');
    assert.equal(bySize.get('size_42'), 3, '填了 3 → 按她填的写（数量可改）');
    // 走的是**既有**采购链路：批次 / 幂等键 / 采购行为都在
    assert.equal(entriesOf(h.gateway, 'purchaseOrderBatch').length, 1);
    for (const record of requests) {
      assert.ok(record.fields['幂等键'], '既有 createOnceByKey 的判据');
      assert.deepEqual(record.fields['采购行为'], ['bh_request']);
    }
  } finally { h.cleanup(); }
});

// ── 自查：扫码侧没有第二套写库逻辑 ──────────────────────────────────────────
test('源码哨兵：扫码写服务里没有一处直连写库（只调既有业务层）', () => {
  const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8');
  const forbidden = [
    { pattern: /gateway\.(create|update|delete)\s*\(/, what: 'gateway 写调用' },
    { pattern: /appTableRecord\.(create|update|delete)/, what: '飞书写记录接口' },
    { pattern: /\.(applySale|applyPurchase|applyChange|applyReturn)\s*\(/, what: '库存写入口' },
    { pattern: /new\s+InventoryService|new\s+PaymentService|new\s+SalesProgressService/, what: '另建业务层实例' },
  ];
  for (const { pattern, what } of forbidden) {
    assert.equal(pattern.test(source), false, `scanWriteService.js 出现了${what}：${pattern}`);
  }
  // 复用的既有业务函数必须在（否则就是"另写一套"了）
  assert.match(source, /SalesOrderService/);
  assert.match(source, /publishPurchaseRequest/);
  assert.match(source, /LarkMvpService\.prototype\.createSalesEntryWithOrderNo\.call/);
  // 会话服务只写本地 JSON（复用既有的 jsonTaskStore），不碰业务表
  const sessions = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanSessionService.js'), 'utf8');
  assert.equal(/gateway\./.test(sessions), false, '会话服务不认识网关');
});

test('只读页的取数代码一个字都没动（scanPageService 仍是只读）', () => {
  const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanPageService.js'), 'utf8');
  for (const pattern of [/gateway\.(create|update|delete)\s*\(/, /inventoryService|salesOrderService|purchaseWebhookService/]) {
    assert.equal(pattern.test(source), false, `scanPageService.js 出现了写链路：${pattern}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB5 ⭐ 2026-10-11（业务负责人）「一单多双 · 多次扫码」的**命门**：跨编号累积
//
// 她的原话：「我们在扫码页卖了多双鞋的时候，怎么可以**一双订单多次扫码**呢？」
// 会话 key 核过是**按人（登录会话）**存的、**不是按编号** ⇒ 扫 A 加一双、再扫 B 加一双，
// 读到的是**同一份本单**。这一条用真路由 + 真会话 + 真业务层把它钉住：
// 一旦将来有人把会话改成"按编号隔离"，这里当场红（症状 = 每次换款都新开一单）。
// ═══════════════════════════════════════════════════════════════════════════
test('AC-DB5 ⭐ 一单多双·多次扫码：扫 A 加单 → 扫 B 加单 → 本单 2 双 → 提交后**一张单两行**', async () => {
  login();
  // 第二款 = **另一个编号**（没有它，这条用例证明不了"跨编号"）。
  const NUMBER_B = 'XHB8095|黑色|A';
  const PRODUCT_B = {
    record_id: 'prod_b',
    fields: {
      编号: NUMBER_B, 货号: 'XHB8095', 颜色: { text: '黑色', record_ids: ['color_black'] },
      类别: 'A', 品类: { text: '休闲鞋', record_ids: ['cat_casual'] }, 单价: 359, 供应商: ['sup_1'],
    },
  };
  const h = createHarness({ tables: seedTables({ product: [PRODUCT, PRODUCT_B] }) });
  try {
    const openId = 'ou_scan_multi_number';
    const lookup = async ({ number }) => (String(number) === NUMBER_B
      ? view({ number: NUMBER_B, item_no: 'XHB8095', product_record_id: 'prod_b' })
      : view());
    await withServer(formApp(h, lookup), async (base) => {
      const urlA = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const urlB = `${base}/s/${encodeURIComponent(NUMBER_B)}?from=sales`;
      const cookie = sessionCookie(openId);
      const post = (url, body) => fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      const keyOf = (html) => html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];

      // ① 扫 A（YD6693-2）：加入本单
      const keyA = keyOf(await (await fetch(urlA, { headers: { cookie } })).text());
      const addedA = await post(urlA, { action: SCAN_WRITE.actions.addLine, submit_key: keyA, size: '40', amount: '399' });
      assert.equal(addedA.status, 303);

      // ② 扫 B（XHB8095，**另一个编号**）：本单条上已经读得到 A 那一双
      const pageB = await fetch(urlB, { headers: { cookie } });
      const htmlB = await pageB.text();
      assert.match(htmlB, /本单：1 双/, 'B 页顶部的本单条要读到 A 那一双（跨编号累积 = 一单，不是新开一单）');

      // ③ 就在 B 页加第二双
      const keyB = keyOf(htmlB);
      const addedB = await post(urlB, { action: SCAN_WRITE.actions.addLine, submit_key: keyB, size: '41', amount: '359' });
      assert.equal(addedB.status, 303);

      // ④ B 页（回跳后）：本单 2 双 + 极简反馈 + 顶部**就地**能提交（不用回第 1 双那一页）
      const afterHtml = await (await fetch(urlB, { headers: { cookie } })).text();
      assert.match(afterHtml, /本单：2 双/);
      const bar = afterHtml.slice(afterHtml.indexOf('data-view="draft-bar"'));
      assert.ok(bar.slice(0, bar.indexOf('</section>')).includes(SCAN_WRITE.texts.submitButton),
        'B 页顶部的本单条上就有【提交这一单】');

      // ⑤ 就在 B 页提交这一单 → **一张主表 + 两行明细**
      const submitted = await post(urlB, { action: SCAN_WRITE.actions.submitOrder, submit_key: keyB });
      assert.equal(submitted.status, 200);
      const doneHtml = await submitted.text();
      assert.match(doneHtml, /这一单提交好了/);
      assert.match(doneHtml, /明细：2 双/);
      const entries = entriesOf(h.gateway, 'salesEntry');
      const details = entriesOf(h.gateway, 'salesDetail');
      assert.equal(entries.length, 1, '两次扫码只该有**一张**销售单');
      assert.equal(details.length, 2, '一张单**两行**（每双一行）');
      for (const detail of details) {
        assert.equal(detail.fields['销售单号'][0], entries[0].record_id, '两行都挂在这一张单上');
      }

      // ⑥ 提交完再打开任一一页：本单条归零（提交按钮跟着消失）
      const afterSubmit = await (await fetch(urlA, { headers: { cookie } })).text();
      assert.match(afterSubmit, /本单：0 双/);
      const barAfter = afterSubmit.slice(afterSubmit.indexOf('data-view="draft-bar"'));
      assert.equal(barAfter.slice(0, barAfter.indexOf('</section>')).includes(SCAN_WRITE.texts.submitButton),
        false, '提交后本单条上不该还有【提交这一单】');
    });
  } finally { h.cleanup(); }
});
