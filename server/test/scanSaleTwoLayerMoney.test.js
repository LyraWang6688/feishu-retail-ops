/**
 * ⭐⭐ 销售建单**两层结构**的验收标准（业务负责人 **2026-10-11** 定）——
 *    「每件（一单多双时逐件）」+「总单」两层，**金额必须相等**。
 *
 * 她的结构（逐字要点）：
 * ```
 * ① 每件（一单多双时逐件）              → 落【销售明细】
 *    选尺码（现货/预订，已有）
 *    填【这一双实收了多少】              ← 用户填的唯一金额
 *    ⚠️「成交金额」= 自动字段（读「货品信息.单价」）⇒ 页面上不再让用户填（现在的输入框删掉）
 * ② 总单层面（共有字段）                → 落【收款明细】+【销售主表】
 *    赠品 / 备注（已有，保留在总单层）
 *    收款：⭐ 支持多笔、多方式（例：本次共收 500 = 微信 200 + 现金 300）
 * ③ 销售单号：系统自动生成、自动写入（不变）
 * ```
 *
 * ⭐ **核心校验**（她 2026-10-11 明确：「必须相等，所以系统需要校验！」）：
 *   · `Σ每件实收 === Σ多笔收款`；
 *   · **不等 ⇒ 拦住（一个字都不写）+ 人话提示**（说清差多少、哪边多了/少了），让她改；
 *   · 相等才提交；
 *   · ⚠️ 与"钱可以先不填（先货后钱）"的关系：**整单都没填钱**（每件实收全空 + 一笔收款都没有）
 *     ⇒ 仍可提交（不写收款明细）；**只要填了任何一边** ⇒ 两边合计必须相等。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-1  **表单只有这两层**：销售页上「成交金额」输入框**整体退场**（鞋与配品都没有），
 *        每件只填「这一双实收」；总单层是多行收款（方式 + 金额），第一行默认「微信」。
 *  AC-2  **每件实收 → 销售明细.成交金额**（她填的唯一金额就是这一位的落点）：
 *        填了 ⇒ 写她填的；留空 ⇒ **自动读「单价」**（鞋 = 货品信息.单价 / 配品 = 其他配品.单价）；
 *        两边都取不到 ⇒ **人话拦住、绝不写 0**（也不建单）。
 *  AC-3  **核心校验（相等才提交）**：`Σ每件实收 === Σ多笔收款` ⇒ 成单，
 *        收款明细**如实写多笔、多方式**（500 = 微信 200 + 现金 300）。
 *  AC-4  **核心校验（不等 ⇒ 拦住且一个字都不写）**：收款多了 / 少了两种都拦住，
 *        人话说清"两边各多少 + 哪边多了/少了 + 差多少"；销售主表 / 明细 / 收款明细**全空**。
 *  AC-5  **只填了一边也拦住**（边界）：只填每件实收（没有收款行）/ 只填收款（每件实收全空）/
 *        部分填了但合计不等 —— 三种都拦住，且人话指得出是哪一边。
 *  AC-6  **先货后钱**：两边都没填 ⇒ 仍可提交（**一条收款明细都不写**），成交金额自动按单价。
 *  AC-7  **收款行必填**：填了金额没选方式 ⇒ 人话拦住；**只选了方式没填金额 = 这一行不用**
 *        （金额空的行不算一笔）。
 *  AC-8  **校验的落点**：服务端是权威（AC-3/4/5）；页面上**原地**把差额说给她听
 *        （400 + 销售那一块 + 差额人话 + 她刚填的每件实收 / 收款行原样还在）——
 *        这一条是"前端落点"，**改一下就能再提交**，不用重打。
 *  AC-9  **幂等不变**：拦住那一次**不轮换幂等键、不记账**；她改对后用**同一把键**再提交
 *        ⇒ 只写一次（连点两次仍然只写一次）。
 *  AC-10 **现货"提交即交付 + 扣库存"照旧**：等额校验通过后，现货行仍然提交即交付、
 *        扣库存、写「库存状态」（刚上线那套一个字不许改坏）。
 *  AC-11 **配置先行 + 无说明书**：收款行数 / 金额前缀 / 校验错误码 / 文案全在
 *        `config/scanWrite.js`；页面上不出现"成交金额"这个输入框，也不出现说明句。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService`（被复用的主表创建函数所在模块）在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_two_layer_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_two_layer_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanPageRouter, parsePaymentRows } = require('../src/routes/scanPage');
const { renderScanPage, buildPaymentRows } = require('../src/views/scanPageRenderer');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（照测试 Base 的真实列形状）────────────────────────────────────────
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A', 品类: { text: '休闲鞋', record_ids: ['cat_casual'] }, 单价: 399, 供应商: ['sup_1'],
  },
};
/** 这一款**没有单价**（AC-2 用它：留空又取不到 ⇒ 拦住，绝不写 0）。 */
const PRODUCT_NO_PRICE = {
  record_id: 'prod_2',
  fields: { 编号: 'YD1111|白色|A', 货号: 'YD1111', 颜色: { text: '白色' }, 类别: 'A', 单价: null, 供应商: ['sup_1'] },
};
/** 「其他配品」：`15元鞋油` 有单价 15；`赠品鞋垫` 没有单价。 */
const ACCESSORIES = [
  { record_id: 'acc_oil', fields: { 名称: '15元鞋油', 种类: '鞋油', 单价: 15 } },
  { record_id: 'acc_insole', fields: { 名称: '赠品鞋垫', 种类: '鞋垫' } },
];
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
/** 40 有一双门盒（现货）；41 / 42 没有（预订）。 */
const liveUnit = (id, size) => ({
  record_id: id, fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: '门盒' },
});

const seedTables = (overrides = {}) => ({
  product: [PRODUCT, PRODUCT_NO_PRICE],
  accessory: ACCESSORIES,
  sizeManagement: SIZE_RECORDS,
  liveInventory: [liveUnit('live_40_box', 40)],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { 行为名称: '现货', 行为编码: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { 行为名称: '预定', 行为编码: 'SALE_PREPAID' } },
  ],
  paymentMethod: [
    { record_id: 'pm_wechat', fields: { 收款方式: '微信' } },
    { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
  ],
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
    delete: async () => { throw new Error('测试网关：扫码侧不许删记录'); },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-two-layer-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的链路：真 service + 真业务层（SalesOrderService / SalesDeliveryService），
 * 只有飞书那一层是内存替身；库存引擎只记账（AC-10 只验"交付那一步被调了"）。
 */
const createHarness = (options = {}) => {
  const gateway = options.gateway || createFakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const taskDir = tempDir('task');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const stockCalls = [];
  const delivery = new SalesDeliveryService({
    gateway,
    inventory: {
      applySale: async (input) => { stockCalls.push(input); return { sampleConsumedQuantity: 0 }; },
      getSaleResult: async () => null,
    },
  });
  const write = createScanWriteService({
    gateway, sessions, delivery, now: options.now,
    purchase: {}, purchaseStore: new JsonTaskStore({ dir: taskDir, idField: 'task_id' }),
  });
  return {
    gateway, sessions, write, stockCalls, tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(taskDir); },
  };
};

const entriesOf = (h, tableKey) => h.tables[tableKey] || [];
const currentKey = async (h, openId) => (await h.sessions.get(openId)).sale.key;
const addShoe = (h, openId, overrides = {}) => h.write.addSaleLine({
  openId, requestId: 'req_add', productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2',
  color: '黑色', size: 40, inStock: true, ...overrides,
});
const addAccessory = (h, openId, overrides = {}) => h.write.addSaleLine({
  openId, requestId: 'req_add', kind: 'accessory', accessoryRecordId: 'acc_oil', ...overrides,
});
const methodField = () => V1_BITABLE_SCHEMA.tables.paymentRecord.fields.method;
const MONEY = SCAN_WRITE.sale.moneyPrefix;

// ═══════════════════════════════════════════════════════════════════════════
// AC-1 表单只有两层：成交金额输入框整体退场 + 每件实收 + 多笔收款
// ═══════════════════════════════════════════════════════════════════════════

const VIEW = {
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色',
  category_name: '休闲鞋', category_code: 'A', price_text: '¥399', total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1, sizes_degraded: false, notes: [], updated_at_text: '2026-10-11 10:00',
  product_record_id: 'prod_1',
};
const WRITE = (overrides = {}) => ({
  enabled: true, saleEnabled: true, replenishEnabled: true,
  texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: `/s/${encodeURIComponent(NUMBER)}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_x:1',
  replenishKey: 'scan_replenish:scan_session_x:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  paymentRowCount: SCAN_WRITE.sale.paymentRowCount,
  accessories: [{ record_id: 'acc_oil', name: '15元鞋油' }],
  notice: '',
  ...overrides,
});

test('AC-1 销售页只有两层：删掉「成交金额」输入框；每件填「这一双实收」；总单是多笔收款', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE(), 'sales');
  // ① 页面上**再也没有**「成交金额」这个输入框（她：成交金额是自动字段）
  assert.equal(html.includes('成交金额'), false, '「成交金额」整体退场（鞋与配品都不许再让用户填）');
  // ② 每件层：鞋表单 + 配品表单各有一个「这一双实收」/「这一件实收」输入框
  assert.ok(html.includes(SCAN_WRITE.texts.amountLabel), `鞋那一行要有「${SCAN_WRITE.texts.amountLabel}」`);
  assert.ok(html.includes(SCAN_WRITE.texts.accessoryAmountLabel), `配品那一行要有「${SCAN_WRITE.texts.accessoryAmountLabel}」`);
  assert.ok(html.includes(`name="${SCAN_WRITE.fields.amount}"`), '加单表单里的金额位就是「这一双实收」');
  // ③ 总单层：多笔收款 = 多行（同名重复）+ 第一行默认「微信」
  const methods = html.match(new RegExp(`name="${SCAN_WRITE.fields.paymentMethod}"`, 'g')) || [];
  const amounts = html.match(new RegExp(`name="${SCAN_WRITE.fields.paymentAmount}"`, 'g')) || [];
  assert.equal(methods.length, SCAN_WRITE.sale.paymentRowCount, '收款行数 = 配置的预置行数');
  assert.equal(amounts.length, SCAN_WRITE.sale.paymentRowCount);
  assert.ok(html.includes('<option value="微信" selected>微信</option>'), '第一行默认选中「微信」');
  // ④ 提交表单里**逐行**一个「每件实收」（同名重复 ⇒ POST 上来是有序数组）
  const withLines = WRITE({ draft: { lines: [{ item_no: 'YD6693-2', size: 40, amount: 350 }] } });
  const lineHtml = renderScanPage(VIEW, SCAN_PAGE, withLines, 'sales');
  assert.equal((lineHtml.match(new RegExp(`name="${SCAN_WRITE.fields.lineAmount}"`, 'g')) || []).length, 1);
  assert.match(lineHtml, /value="350"/, '她填过的每件实收要回填出来（提交前能核对）');
  // ⑤ ≥44px 命中区（她 2026-10-11 的硬要求）：新控件都吃 `--control-height`
  const { STYLE } = require('../src/views/scanPageRenderer');
  assert.match(STYLE, /\.draft-line__amount\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
  assert.match(STYLE, /\.form-row--pay/);
  // ⑥ 零 JS 的底线不许破（2026-10-09 白屏事故之后的既有约束）
  assert.equal(/<script[\s>]/i.test(html), false, '页面里一行前端脚本都没有');
  assert.equal(/on(click|load|submit)\s*=/i.test(html), false, '不许有内联事件');
});

test('AC-1b 收款行的预置规则（配置先行）：预置 N 行、第一行默认微信；回填时不替她选', () => {
  assert.equal(SCAN_WRITE.sale.paymentRowCount, 3, '预置行数可配（SCAN_SALE_PAYMENT_ROWS）');
  assert.deepEqual(buildPaymentRows({ count: 2, defaultMethod: '微信' }), [
    { method: '微信', amount: '' }, { method: '', amount: '' },
  ]);
  assert.deepEqual(
    buildPaymentRows({ count: 3, defaultMethod: '微信', rows: [{ method: '现金', amount: '300' }] }),
    [{ method: '现金', amount: '300' }, { method: '', amount: '' }, { method: '', amount: '' }],
    '校验失败回填：她填的那一行原样带回来，补齐的行**不注入默认方式**',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-2 每件实收 → 销售明细.成交金额（留空 ⇒ 自动读单价；取不到 ⇒ 人话拦住）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-2a 每件实收 = 销售明细「成交金额」的落点；留空才自动读「单价」（鞋 / 配品同规则）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_amount';
    await addShoe(h, openId, { size: 40, amount: 350 });       // 她填了实收 → 350（不是单价 399）
    await addAccessory(h, openId, { amount: 12 });             // 配品填了实收 → 12（不是单价 15）
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 362 }],             // 350 + 12 = 362
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const details = entriesOf(h, 'salesDetail');
    const shoe = details.find((row) => !row.fields[accessoryField]);
    const accessory = details.find((row) => row.fields[accessoryField]);
    assert.equal(shoe.fields['成交金额'], 350, '她填的实收就是「销售明细.成交金额」');
    assert.equal(accessory.fields['成交金额'], 12, '配品行同一条规则（与鞋一致）');

    // 留空 ⇒ 自动读那张表的「单价」（鞋 = 货品信息.单价 / 配品 = 其他配品.单价）
    const openId2 = 'ou_two_layer_fallback';
    await addShoe(h, openId2, { size: 41, amount: '' });
    await addAccessory(h, openId2, { accessoryRecordId: 'acc_oil', amount: '' });
    const fallback = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2) });
    assert.equal(fallback.ok, true, JSON.stringify(fallback));
    const rows = entriesOf(h, 'salesDetail').slice(2);
    const shoe2 = rows.find((row) => !row.fields[accessoryField]);
    const acc2 = rows.find((row) => row.fields[accessoryField]);
    assert.equal(shoe2.fields['成交金额'], 399, '留空 ⇒ 自动取「货品信息.单价」');
    assert.equal(acc2.fields['成交金额'], 15, '留空 ⇒ 自动取「其他配品.单价」');
  } finally { h.cleanup(); }
});

test('AC-2b 取不到单价又没填实收 ⇒ 人话拦住、**一个字都不写**（绝不写 0）', async () => {
  const h = createHarness();
  try {
    // 鞋：这一款没有单价
    const openId = 'ou_two_layer_nomoney';
    await addShoe(h, openId, { productRecordId: 'prod_2', number: 'YD1111|白色|A', itemNo: 'YD1111', size: 40, amount: '' });
    const failed = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId) });
    assert.equal(failed.ok, false, '取不到单价 ⇒ 拦住');
    assert.equal(failed.code, 'line_amount_missing');
    assert.match(failed.message, /YD1111/, '人话里点名是哪一双');
    assert.match(failed.message, /这一双实收/, '告诉她"能做的事"：在本单里填上这一双实收');
    assert.equal(entriesOf(h, 'salesEntry').length, 0, '一个字都不写（主表都不建）');
    assert.equal(entriesOf(h, 'salesDetail').length, 0);

    // 配品：这一件没有单价
    const openId2 = 'ou_two_layer_nomoney_acc';
    await addAccessory(h, openId2, { accessoryRecordId: 'acc_insole', amount: '' });
    const failed2 = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2) });
    assert.equal(failed2.ok, false);
    assert.equal(failed2.code, 'accessory_amount_missing');
    assert.match(failed2.message, /赠品鞋垫/);
    assert.match(failed2.message, /这一件实收/);
    assert.equal(entriesOf(h, 'salesDetail').length, 0, '绝不写 0');
  } finally { h.cleanup(); }
});

test('AC-2c 取不到单价、但她在本单里补填了实收 ⇒ 用她填的（不必去改货品表）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_fill_missing';
    await addShoe(h, openId, { productRecordId: 'prod_2', number: 'YD1111|白色|A', itemNo: 'YD1111', size: 40, amount: '' });
    const key = await currentKey(h, openId);
    // 提交表单里那一排「每件实收」= 她当场补填的 260
    const ok = await h.write.submitSale({
      openId, submitKey: key, lineAmounts: ['260'], payments: [{ method: '现金', amount: 260 }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(entriesOf(h, 'salesDetail')[0].fields['成交金额'], 260);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-3 核心校验（相等才提交）+ 多笔多方式如实写收款明细
// ═══════════════════════════════════════════════════════════════════════════

test('AC-3 Σ每件实收 === Σ多笔收款 ⇒ 成单；收款明细如实写多笔、多方式（500 = 微信 200 + 现金 300）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_equal';
    await addShoe(h, openId, { size: 40, amount: 200 });
    await addShoe(h, openId, { size: 41, amount: 300 });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: '200' }, { method: '现金', amount: '300' }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.detail_count, 2, '一单一双一行');
    assert.equal(ok.payment_count, 2, '两笔收款 → 两条「收款明细」');
    const paymentField = methodField();
    const rows = entriesOf(h, 'paymentRecord');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => [row.fields[paymentField][0], row.fields['收款金额']]),
      [['pm_wechat', 200], ['pm_cash', 300]], '方式按她说的写（微信 200 + 现金 300）');
    assert.equal(rows[0].fields['收款状态'], '已收款');
    for (const row of rows) assert.ok(row.fields['收款时间'], '收款时间照旧写（既有口径）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-4 核心校验（不等 ⇒ 拦住 + 一个字都不写 + 说清差额）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-4a 收款比每件实收**多** ⇒ 拦住（一个字都不写）+ 人话说清差多少', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_over';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 400 }],
    });
    assert.equal(result.ok, false, '不等必须拦住');
    assert.equal(result.code, 'amount_mismatch');
    assert.match(result.message, new RegExp(`每件实收合计 ${MONEY}350`), '人话要给两边的合计');
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}400`));
    assert.match(result.message, new RegExp(`收款比每件实收多 ${MONEY}50`), '说清哪边多了、差多少');
    // 🔴 **一个字都不写**（钱货都不动）
    assert.equal(entriesOf(h, 'salesEntry').length, 0, '主表不建');
    assert.equal(entriesOf(h, 'salesDetail').length, 0, '明细不写');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '收款明细不写');
    // 幂等键还在（同一把键可以重试）—— AC-9 细验
    assert.equal((await h.sessions.get(openId)).sale.key, await currentKey(h, openId));
  } finally { h.cleanup(); }
});

test('AC-4b 收款比每件实收**少** ⇒ 拦住（一个字都不写）+ 人话说清差多少', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_short';
    await addShoe(h, openId, { size: 40, amount: 350 });
    await addShoe(h, openId, { size: 41, amount: 349 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 500 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'amount_mismatch');
    assert.match(result.message, new RegExp(`每件实收合计 ${MONEY}699`));
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}500`));
    assert.match(result.message, new RegExp(`收款比每件实收少 ${MONEY}199`));
    assert.equal(entriesOf(h, 'salesEntry').length + entriesOf(h, 'salesDetail').length
      + entriesOf(h, 'paymentRecord').length, 0, '一个字都不写');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-5 只填了一边 / 部分填了但不等（边界）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-5a 只填了每件实收、一笔收款都没有 ⇒ 拦住（收款少了 X）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_items_only';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId) });
    assert.equal(result.ok, false, '填了一边就必须两边相等');
    assert.equal(result.code, 'amount_mismatch');
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}0`));
    assert.match(result.message, new RegExp(`收款比每件实收少 ${MONEY}350`));
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

test('AC-5b 只填了收款、每件实收全空 ⇒ 拦住（人话指"每件实收还没填"）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_pay_only';
    await addShoe(h, openId, { size: 40, amount: '' });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 500 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'amount_mismatch');
    assert.match(result.message, new RegExp(`每件实收合计 ${MONEY}0`));
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}500`));
    assert.match(result.message, /每件实收还没填/, '这种情况要指得出"该填哪一边"');
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

test('AC-5c **部分填了但不等** ⇒ 拦住；合计相等才放行（未填的那一双按"还没收到钱"走）', async () => {
  const h = createHarness();
  try {
    // ① 两双：只填了第一双（350），收款 500 ⇒ 两边合计对不上 ⇒ 拦住
    const openId = 'ou_two_layer_partial';
    await addShoe(h, openId, { size: 40, amount: 350 });
    await addShoe(h, openId, { size: 41, amount: '' });   // 第二双没填
    const blocked = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 500 }],
    });
    assert.equal(blocked.ok, false, '第二双没填 ⇒ 两边合计对不上（500 ≠ 350）');
    assert.equal(blocked.code, 'amount_mismatch');
    assert.match(blocked.message, new RegExp(`每件实收合计 ${MONEY}350`));
    assert.equal(entriesOf(h, 'salesEntry').length, 0);

    // ② 合计恰好相等（收款 350）⇒ 放行：填了的那一双 = 已收 350，没填的那一双 = 还没收到钱
    //    （成交金额按「单价」挂应收 399）—— 这条边界就是她定的口径：「两边**合计**必须相等」。
    const openId2 = 'ou_two_layer_partial_equal';
    await addShoe(h, openId2, { size: 40, amount: 350 });
    await addShoe(h, openId2, { size: 41, amount: '' });
    const ok = await h.write.submitSale({
      openId: openId2, submitKey: await currentKey(h, openId2),
      payments: [{ method: '微信', amount: 350 }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const amounts = entriesOf(h, 'salesDetail').map((row) => row.fields['成交金额']);
    assert.deepEqual(amounts, [350, 399], '没填实收的那一双落「单价」= 应收（不是 0）');
  } finally { h.cleanup(); }
});

test('AC-5d 小数也按**分**比：0.1 + 0.2 不误报（浮点误差不算数）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_decimal';
    await addShoe(h, openId, { size: 40, amount: '0.1' });
    await addShoe(h, openId, { size: 41, amount: '0.2' });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: '0.3' }],
    });
    assert.equal(ok.ok, true, `0.1 + 0.2 === 0.3 不该被浮点误差拦下：${JSON.stringify(ok)}`);
    assert.equal(entriesOf(h, 'paymentRecord').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6 先货后钱（两边都没填）仍然可提交
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6 先货后钱：每件实收全空 + 没有收款行 ⇒ 仍可提交，**一条收款明细都不写**', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_goods_first';
    await addShoe(h, openId, { size: 40, amount: '' });
    const ok = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId) });
    assert.equal(ok.ok, true, `先货后钱的口径必须保持：${JSON.stringify(ok)}`);
    assert.equal(ok.payment_count, 0);
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '钱可以先不填：一条收款明细都没有');
    assert.equal(entriesOf(h, 'salesDetail')[0].fields['成交金额'], 399, '成交金额自动按「单价」= 应收');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['销售状态'], '已写入');
    // ⚠️ 「资金状态」是**既有业务层**的口径（= "收款这一步跑完了"，零笔收款也算跑完）
    //    —— 扫码侧一个字都没改它；她说的"待补资金"是**进度**那一侧算出来的（未收款 / 欠款 = 成交金额）。
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['资金状态'], '已写入');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-7 收款行：金额填了就必须有方式；只选方式不填金额 = 这一行不用
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7a 填了金额没选收款方式 ⇒ 人话拦住（不写库）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_no_method';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '', amount: 350 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'payment_row_incomplete');
    assert.equal(result.message, SCAN_WRITE.texts.paymentRowIncompleteBody);
    assert.equal(entriesOf(h, 'paymentRecord').length, 0);
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

test('AC-7b 只选了方式、没填金额 = 这一行不用（不算一笔，也不报错）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_empty_row';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 350 }, { method: '现金', amount: '' }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.payment_count, 1, '金额空的那一行不算一笔');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1);
    assert.deepEqual(entriesOf(h, 'paymentRecord')[0].fields[methodField()], ['pm_wechat']);
  } finally { h.cleanup(); }
});

test('AC-7c 金额不是数字 ⇒ 人话拦住（收款行 / 每件实收 两种都验）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_bad_amount';
    await addShoe(h, openId, { size: 40, amount: '' });
    const badPay = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: '一百' }],
    });
    assert.equal(badPay.ok, false);
    assert.equal(badPay.code, 'payment_amount_invalid');
    const badLine = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), lineAmounts: ['3.999'],
    });
    assert.equal(badLine.ok, false);
    assert.equal(badLine.code, 'line_amount_invalid');
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-8 校验的落点：服务端权威 + 页面上原地给差额（她改一下就能再提交）
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'scan_two_layer_session_secret';
const sessionCookie = (openId = 'ou_two_layer_route') => {
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
const formApp = (harness, lookup = async () => VIEW) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup }, gateway: harness.gateway, writeService: harness.write,
  }));
  return app;
};
/**
 * 表单体（**同名重复的字段要真的重复出现** —— 数组必须逐项 `append`）。
 * ⚠️ 不能写成 `new URLSearchParams({ line_amount: ['1','2'] })`：那会拼成 `1,2` 一个值。
 */
const formBody = (entries) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of (Array.isArray(value) ? value : [value])) {
      body.append(key, item === undefined || item === null ? '' : String(item));
    }
  }
  return body.toString();
};
const formPost = (base, cookie, body) => fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: formBody(body),
});

test('AC-8a 不等 ⇒ 400 + **还是销售那一块** + 差额人话 + 她刚填的值原样还在（改一下再提交）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_route';
    const cookie = sessionCookie(openId);
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const html = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      // 加两双（每件实收 200 / 300）
      for (const [size, amount] of [['40', '200'], ['41', '300']]) {
        const added = await fetch(pageUrl, {
          method: 'POST', redirect: 'manual',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size, amount }).toString(),
        });
        assert.equal(added.status, 303);
      }
      // 总单只记了 200（少 300）⇒ 拦住
      const failed = await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey,
        payment_method: '现金', payment_amount: '200',
        line_amount: ['200', '300'],
      });
      assert.equal(failed.status, 400, '校验失败是"她能改"的那一类 ⇒ 400 而不是 500');
      const failedHtml = await failed.text();
      assert.ok(failedHtml.includes('realm-block--sales'), '原地回到销售那一块（不是一张干巴巴的失败页）');
      assert.match(failedHtml, /每件实收合计 ¥500，收款合计 ¥200；收款比每件实收少 ¥300/,
        '差额人话就在页面上');
      // 她刚填的值还在（不用重打）：每件实收两行 + 她选的方式 / 金额
      assert.equal((failedHtml.match(/name="line_amount"/g) || []).length, 2);
      assert.match(failedHtml, /name="line_amount"[^>]*value="200"/);
      assert.match(failedHtml, /name="line_amount"[^>]*value="300"/);
      assert.match(failedHtml, /<option value="现金" selected>现金<\/option>/);
      assert.match(failedHtml, /name="payment_amount"[^>]*value="200"/);
      // **一个字都没写库**
      assert.equal(entriesOf(h, 'salesEntry').length, 0);
      assert.equal(entriesOf(h, 'salesDetail').length, 0);
      assert.equal(entriesOf(h, 'paymentRecord').length, 0);
      // 照着上面那句话改对 ⇒ 同一把键再提交 ⇒ 成单（只写一次，见 AC-9）
      const fixed = await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey,
        payment_method: ['微信', '现金'], payment_amount: ['200', '300'],
        line_amount: ['200', '300'],
      });
      assert.equal(fixed.status, 200, await fixed.text());
      assert.equal(entriesOf(h, 'salesEntry').length, 1);
      assert.equal(entriesOf(h, 'salesDetail').length, 2);
      assert.equal(entriesOf(h, 'paymentRecord').length, 2, '两笔收款写两条');
    });
  } finally { h.cleanup(); }
});

test('AC-8b 路由把表单的**同名重复**字段拼成有序的多笔收款（形式解析，不判业务）', () => {
  const fields = SCAN_WRITE.fields;
  assert.deepEqual(parsePaymentRows({ [fields.paymentMethod]: ['微信', '现金'], [fields.paymentAmount]: ['200', '300'] }, fields),
    [{ method: '微信', amount: '200' }, { method: '现金', amount: '300' }]);
  // 只出现一次时是字符串（express 的形状）
  assert.deepEqual(parsePaymentRows({ [fields.paymentMethod]: '微信', [fields.paymentAmount]: '200' }, fields),
    [{ method: '微信', amount: '200' }]);
  // 缺一位也照拼（服务端那边才判"方式必填 / 金额必填"）
  assert.deepEqual(parsePaymentRows({ [fields.paymentAmount]: ['200', '300'] }, fields),
    [{ method: '', amount: '200' }, { method: '', amount: '300' }]);
  assert.deepEqual(parsePaymentRows({}, fields), []);
});

test('AC-8c 先货后钱走真路由：页面上两边都不填 ⇒ 直接成单（没有收款明细）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_route_gift';
    const cookie = sessionCookie(openId);
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const html = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      await fetch(pageUrl, {
        method: 'POST', redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size: '40' }).toString(),
      });
      const done = await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey, line_amount: '',
      });
      assert.equal(done.status, 200);
      assert.match(await done.text(), /这一单提交好了/);
      assert.equal(entriesOf(h, 'paymentRecord').length, 0);
      assert.equal(entriesOf(h, 'salesDetail')[0].fields['成交金额'], 399);
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-9 幂等不变：拦住那一次不轮换键、不记账；改对后同一把键只写一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-9 拦住不轮换幂等键；改对后同一把键提交 ⇒ 只写一次（连点两次也只写一次）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_idem';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const key = await currentKey(h, openId);
    const blocked = await h.write.submitSale({ openId, submitKey: key, payments: [{ method: '微信', amount: 100 }] });
    assert.equal(blocked.ok, false);
    const session = await h.sessions.get(openId);
    assert.equal(session.sale.key, key, '拦住那一次不许轮换幂等键（否则她没法用同一把键重试）');
    assert.equal(session.sale.completed.length, 0, '拦住那一次不算"已提交过"');
    assert.deepEqual(entriesOf(h, 'salesEntry'), []);

    const fixed = await h.write.submitSale({ openId, submitKey: key, payments: [{ method: '现金', amount: 350 }] });
    assert.equal(fixed.ok, true, JSON.stringify(fixed));
    const again = await h.write.submitSale({ openId, submitKey: key, payments: [{ method: '现金', amount: 350 }] });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true, '同一把键第二次 = 把她上一次的结果还给她');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '只写一次');
    assert.equal(entriesOf(h, 'salesDetail').length, 1);
    assert.equal(entriesOf(h, 'paymentRecord').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-10 现货"提交即交付 + 扣库存"照旧（刚上线那套一个字不许改坏）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-10 等额校验通过后：现货行仍然提交即交付 + 扣库存 + 写「库存状态」', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_deliver';
    await addShoe(h, openId, { size: 40, amount: 399, inStock: true });   // 40 有货 ⇒ 现货
    await addShoe(h, openId, { size: 41, amount: 399, inStock: false });  // 41 没货 ⇒ 预订
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 798 }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.stock.requested, 1, '只有现货那一行进交付');
    assert.equal(ok.stock.failed, 0, `现货那一双必须扣成功：${JSON.stringify(ok.stock)}`);
    assert.equal(h.stockCalls.length, 1, '库存引擎只被调了一次（预订那一行不许碰库存）');
    const details = entriesOf(h, 'salesDetail');
    const bySize = new Map(details.map((row) => [row.fields['尺码'][0], row.fields['履约状态']]));
    assert.equal(bySize.get('size_40'), '已交付', '现货 ⇒ 提交即交付');
    assert.equal(bySize.get('size_41'), '未交付', '预订 ⇒ 不交付');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], '已写入');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-11 配置先行 + 无说明书（源码/文案哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-11 配置先行：行数 / 前缀 / 校验错误码 / 文案都在 config；页面无"成交金额"输入框', () => {
  // ① 旋钮全在 config（换一个值不必改代码）
  for (const key of ['paymentRowCount', 'moneyPrefix', 'amountDecimals', 'formFailureCodes']) {
    assert.ok(SCAN_WRITE.sale[key] !== undefined, `config/scanWrite.sale.${key} 必须在`);
  }
  assert.ok(SCAN_WRITE.sale.formFailureCodes.includes('amount_mismatch'), '核心校验要进"原地重渲染"那一组');
  for (const key of ['amountMismatchBody', 'amountMismatchShort', 'amountMismatchOver',
    'amountMismatchNoItems', 'paymentRowIncompleteBody', 'amountInvalidBody']) {
    assert.equal(typeof SCAN_WRITE.texts[key], 'string', `config/scanWrite.texts.${key} 必须在`);
  }
  // ② 收款行 / 每件实收的字段名都在 config（渲染层与路由都不写死）
  assert.equal(SCAN_WRITE.fields.lineAmount, 'line_amount');
  assert.equal(SCAN_WRITE.fields.paymentMethod, 'payment_method');
  assert.equal(SCAN_WRITE.fields.paymentAmount, 'payment_amount');
  // ③ 页面上没有说明书（她 2026-10-10 的硬要求）—— 逐句扫一遍
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE({
    draft: { lines: [{ item_no: 'YD6693-2', size: 40, amount: 350 }] },
    errorText: SCAN_WRITE.texts.amountMismatchBody,
  }), 'sales');
  for (const gone of ['怎么用', '使用说明', '说明：', '你可以', '资金不是必填']) {
    assert.equal(html.includes(gone), false, `页面上不该出现说明句：「${gone}」`);
  }
  // ④ 收盘差那句人话的源码哨兵：绝不能"只写日志、页面上不说"
  const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8');
  assert.match(source, /amount_mismatch/, '服务端必须有这条校验');
  assert.match(source, /config\.events\.amountMismatch/, '拦下来要有可 grep 的日志');
  const route = fs.readFileSync(path.join(SERVER_SRC, 'routes', 'scanPage.js'), 'utf8');
  assert.match(route, /formFailureCodes/, '路由要按配置把校验失败"原地"渲染回销售那一块');
});
