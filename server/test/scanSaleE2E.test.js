/** ⚠️ 2026-10-12 旧断言改写（"**零 JS**"口径按业务负责人的要求改了）：
 *  改前（逐字）：`assert.equal(/<script[\s>]/i.test(page.html), false, '第7步：页面里一行 `<script>` 都不许有');`
 *  改后（逐字）：销售页有【提交这一单】⇒ **整页只有那一段**
 *    `<script data-view="submit-feedback">`（只做"置灰 + 换文案 + 计时"）。
 *  理由：业务负责人真机（逐字）「点完之后**没有 Toast、按键置灰**……**我就会一直狂点**」
 *    ⇒ 她**明确要置灰**；"置灰"没有零 JS 的等价物 ⇒ 多了**唯一一段**内联 JS。
 *    ⚠️ 其余断言（一行 4 个、不显示数量、业务表零写入…）一条没放宽。
 */
/**
 * ⭐⭐ 扫码销售 **端到端（E2E）主干链路** —— 一条"**能复现定位**"的测试。
 *
 * 业务负责人 2026-10-11 批准：「**加吧～**」。
 *
 * 这条测试的目的**不是**"证明能过"，而是：**当她说"某一步不对"时，跑一遍就能立刻看出断在哪一步**。
 *   ⇒ 所有断言写的都是**她看得见的事实**（页面文案 / 本单几双 / 单号 / 表里几条 / 库存少没少 / 流水几条），
 *     每条断言的消息都带 **第N步：…** 前缀 —— 红了就知道断在哪一步。
 *
 * 范围（**走真实 HTTP 路由 + 真服务，只有飞书那一层是内存假网关** ⇒ **零远端调用**）：
 *   `GET/POST /s/{编号}?from=sales` → `createScanPageService`（真读）
 *   → `createScanWriteService`（真写）→ `SalesOrderService.confirm`（真建单）
 *   → `SalesDeliveryService.deliver`（真交付）→ `InventoryService.applySale`（真扣库存）。
 *
 * ⚠️ **本文件只加测试**：不改任何产品代码。若某条 AC 跑不通 ⇒ 说明产品**真有 bug**，
 *    **如实报告 + 定位（文件:行）**，不许改产品代码去迁就。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-E2E-1 扫第一个码 ⇒ `/s/{编号}?from=sales` 是**销售页**：尺码**一行 4 个**（现货组 / 预订组）、
 *            **不显示数量**、页面**零 `<script>`**。
 *  AC-E2E-2 「加入本单」（现货尺码、实收留空）⇒ **303 + 本单条 1 双**；**业务表零写入**（只写本地会话）。
 *  AC-E2E-3 ⭐ **跨编号累积**：再扫**另一个**编号 → 加入本单 ⇒ **本单 2 双**（同一会话，不是新开一单）。
 *  AC-E2E-4 提交这一单（**资金全空**）⇒ 成功页（**单号 + 双数**）：**销售主表 1 条、销售明细 2 行**，都挂同一张单。
 *  AC-E2E-5 ⭐ **现货行 = 已交付 + 扣库存；预订行不扣**（走既有交付/库存链路；断言**库存真的少 1**、
 *            流水只多 1 条且只关联现货那一行）。
 *  AC-E2E-6 **幂等**：同一把提交键**连点两次（含并发）**⇒ 只建一张单、只扣一次库存。
 *  AC-E2E-7 **提交后本单归零**：再打开那一页 ⇒ `本单：0 双`，**本单条上不再渲染【提交这一单】**。
 *  AC-E2E-8 ⭐⭐ **她真机卡住的那一步（回归）**：扫码建单 ——
 *            **只填了每件实收、收款一行都没填**（线上日志 `scan.sale.amount_mismatch
 *            items_cents=9900 payments_cents=0`）以及**什么都不填** ⇒ **一定能提交成单**；
 *            而且**不会**自动冒出一条【未收款】。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService`（被复用的"创建销售主表记录"那个函数所在模块）在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_sale_e2e';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_sale_e2e_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { REALM_TEXTS } = require('../src/views/scanPageRealm');
const { createScanPageService } = require('../src/services/scanPageService');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
// ⭐ 2026-10-12 新写用例回读"欠款"用（既有服务，只读）
const { SalesProgressService } = require('../src/services/salesProgressService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanPageRouter } = require('../src/routes/scanPage');
const PAYMENT_FIELDS = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;

// ── 语义键 → 物理列名（照真 schema；写错语义键当场抛，别让夹具自己漂）─────────────
const F = (table, key) => {
  const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
  if (!name) throw new Error(`schema 里没有 ${table}.${key}`);
  return name;
};

// ── 夹具：**两个编号** —— A 有货（门盒 40 ⇒ 现货）；B 一双都没有（只能预订）───────
const NUMBER_A = 'YD6693-2|黑色|A';
const ITEM_A = 'YD6693-2';
const NUMBER_B = 'XHB8095|黑色|A';
const ITEM_B = 'XHB8095';
/** 「品类」不在 schema 的语义映射里（它是那张表上的公式/文本列）⇒ 按真实列名写。 */
const CATEGORY_COLUMN = '品类';
const CATEGORY_NAME = '休闲鞋';

const productRow = (recordId, number, itemNo) => ({
  record_id: recordId,
  fields: {
    [F('product', 'number')]: number,
    [F('product', 'itemNo')]: itemNo,
    [F('product', 'color')]: { text: '黑色', record_ids: ['color_black'] },
    [F('product', 'category')]: 'A',
    [F('product', 'price')]: 399,
    [F('product', 'supplier')]: ['sup_1'],
  },
});

/** 「尺码管理」：类别是**多选**（真表形状，记录 API 回数组）⇒ 夹具照写。 */
const sizeRow = (size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement', 'size')]: size, 类别: ['A'] } });

/** 「实时库存」一行：A 的 40 码有一双门盒（= 现货）；B 一行都没有。 */
const liveRow = (recordId, productRecordId, size, state) => ({
  record_id: recordId,
  fields: {
    [F('liveInventory', 'product')]: [productRecordId],
    [F('liveInventory', 'size')]: [`size_${size}`],
    [F('liveInventory', 'state')]: state,
    [F('liveInventory', 'stockKey')]: `${ITEM_A}|黑色|A|${size}`,
    [CATEGORY_COLUMN]: CATEGORY_NAME,
  },
});

const seedTables = () => ({
  product: [productRow('prod_a', NUMBER_A, ITEM_A), productRow('prod_b', NUMBER_B, ITEM_B)],
  sizeManagement: [40, 41, 42].map(sizeRow),
  liveInventory: [liveRow('live_a_40_box', 'prod_a', 40, '门盒')],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { [F('behavior', 'name')]: '现货', [F('behavior', 'code')]: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { [F('behavior', 'name')]: '预定', [F('behavior', 'code')]: 'SALE_PREPAID' } },
    // 既有库存引擎认识的那条"销售减少"行为（交付那一步扣的就是它）
    {
      record_id: 'bh_sale_decrease',
      fields: {
        [F('behavior', 'name')]: '销售减少',
        [F('behavior', 'code')]: 'STOCK_SALE_DECREASE',
        [F('behavior', 'stockDirection')]: '减少',
        [F('behavior', 'enabled')]: true,
      },
    },
  ],
  paymentMethod: [{ record_id: 'pm_wechat', fields: { [F('paymentMethod', 'name')]: '微信' } }],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
});

/** 内存假网关：读 + 写都走真 schema 的语义键；**只有「实时库存」允许删**（既有库存引擎的语义）。 */
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
    listByFilter: async () => { throw new Error('假网关不支持 filter'); },
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
      if (key !== 'liveInventory') throw new Error(`假网关：不许删 ${key}`);
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      writes.push({ op: 'delete', table: key, record_id: id });
      return { deleted: true };
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-sale-e2e-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * ⭐⭐ 2026-10-12：给假网关**每一趟飞书调用**加一个"线上量级"的延时，并把**每一次调用**
 * 记进 `calls`（起止时间戳）。用途：**逐步耗时**的量法与"哪些调用是串行的"的证据。
 * ⚠️ 只包读/写方法，**不改任何返回值**（业务链路仍然跑的是同一份代码）。
 */
const withLatency = (gateway, ms) => {
  const calls = [];
  const t0 = Date.now();
  const callerOf = () => {
    const lines = String(new Error().stack || '').split('\n');
    for (const line of lines) {
      const match = line.match(/src\/services\/([a-zA-Z]+)\.js/);
      if (match) return match[1];
      const route = line.match(/src\/routes\/([a-zA-Z]+)\.js/);
      if (route) return `routes/${route[1]}`;
    }
    return 'unknown';
  };
  const wrap = (name) => async (...args) => {
    const start = Date.now() - t0;
    await new Promise((resolve) => { setTimeout(resolve, ms); });
    try {
      return await gateway[name](...args);
    } finally {
      calls.push({ name, table: String(args[0] ?? ''), start, end: Date.now() - t0, caller: callerOf() });
    }
  };
  return Object.assign(Object.create(null), gateway, {
    listAll: wrap('listAll'),
    listByFilter: wrap('listByFilter'),
    get: wrap('get'),
    findOneByText: wrap('findOneByText'),
    create: wrap('create'),
    update: wrap('update'),
    delete: wrap('delete'),
    calls,
    // 同一时刻**同时在飞**的调用数（>1 = 真的并行了）。
    maxConcurrent: () => {
      const marks = [];
      for (const call of calls) { marks.push([call.start, 1], [call.end, -1]); }
      marks.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
      let current = 0; let peak = 0;
      for (const [, delta] of marks) { current += delta; if (current > peak) peak = current; }
      return peak;
    },
  });
};

/**
 * 一套"真的在跑"的 E2E：真 HTTP 路由 + 真读服务 + 真写服务 + 真建单 / 交付 / 库存引擎；
 * **只有飞书那一层**是内存替身。
 * ⭐ 2026-10-12：`gatewayOverride`（例：`withLatency(createFakeGateway(), 120)`）供
 *    "逐步耗时"那几条用例注入延时；不传 = 与改前逐字相同的假网关。
 */
const createE2E = (gatewayOverride = null, writeOptions = {}) => {
  const gateway = gatewayOverride || createFakeGateway();
  const sessionDir = tempDir('session');
  const inventoryDir = tempDir('inventory');
  const replenishDir = tempDir('replenish');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const delivery = new SalesDeliveryService({ gateway, inventory });
  const writeService = createScanWriteService({
    gateway,
    sessions,
    delivery,
    // 这条 E2E 不碰补货链路：给它一对不会落盘的替身，免得误写工作区。
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: replenishDir, idField: 'task_id' }),
    // ⭐ 2026-10-12：`readCache: false` 就是"改前"那一档（同一份代码、只关只读引用缓存）。
    ...writeOptions,
  });
  const service = createScanPageService(gateway, { config: SCAN_PAGE, startSnapshot: false });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service, gateway, writeService, startSnapshot: false,
  }));
  return {
    gateway, sessions, writeService, app, tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(inventoryDir); rmDir(replenishDir); },
  };
};

// ── HTTP 工具（走真实路由；鉴权走工作台既有一道闸门）──────────────────────────
const SESSION_SECRET = 'scan_sale_e2e_session_secret';
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const pageUrlOf = (base, number, realm = 'sales') => `${base}/s/${encodeURIComponent(number)}?from=${realm}`;
const getPage = async (url, cookie) => {
  const response = await fetch(url, { headers: { cookie } });
  return { status: response.status, html: await response.text() };
};
// ⚠️ 页面上的收款行 / 每件实收是**同名字段重复出现**（`line_amount` 一行一个）⇒
//    这里必须发**重复的键**（`URLSearchParams` 的"数组值"会拼成 `150,130`，那是错的）。
const postForm = (url, cookie, body) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};

/** 「本单条」那一段（`data-view="draft-bar"`）：她是**看这一条**知道"本单几双、能不能提交"的。 */
const draftBarOf = (html) => {
  const start = html.indexOf('data-view="draft-bar"');
  assert.ok(start > -1, '页面里没有本单条（data-view="draft-bar"）——第1步就断在渲染上了');
  return html.slice(html.lastIndexOf('<section', start), html.indexOf('</section>', start));
};
/** 某一组尺码（`data-stock-group="in_stock" / "prepaid"`）的 HTML。 */
const sizeGroupOf = (html, id) => {
  const start = html.indexOf(`data-stock-group="${id}"`);
  assert.ok(start > -1, `销售页里没有 ${id} 那一组尺码`);
  return html.slice(start, html.indexOf('</fieldset>', start));
};
const rowsOf = (e2e, table) => e2e.tables[table] || [];
const addLine = (base, cookie, number, size) => postForm(pageUrlOf(base, number), cookie, {
  action: SCAN_WRITE.actions.addLine, submit_key: 'unused-on-add', size,
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-1 扫第一个码 ⇒ 销售页（一行 4 个 / 不显示数量 / 零脚本）
// ═══════════════════════════════════════════════════════════════════════════

const scriptCountOf = (html) => (html.match(/<script[\s>]/gi) || []).length;

test('AC-E2E-1 扫第一个码 ⇒ /s/{编号}?from=sales 是销售页：尺码一行 4 个、不显示数量、零 <script>', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const page = await getPage(pageUrlOf(base, NUMBER_A), sessionCookie('ou_e2e_1'));
      assert.equal(page.status, 200, '第1步：扫码页要能打开（200）');
      assert.ok(page.html.includes('realm-block--sales'), '第2步：默认/`?from=sales` 打开的是**销售**那一块');

      // 第3步：尺码分两组（现货 / 预订）——A 的 40 有门盒（现货），41 / 42 没有（预订）
      const inStock = sizeGroupOf(page.html, 'in_stock');
      const prepaid = sizeGroupOf(page.html, 'prepaid');
      assert.ok(inStock.includes(REALM_TEXTS.saleInStockHeading), '第3步：有「现货组」');
      assert.ok(prepaid.includes(REALM_TEXTS.salePrepaidHeading), '第3步：有「预订组」');
      assert.match(inStock, /name="size" value="40"/, '第4步：40 码在现货组（实时库存里有门盒）');
      assert.ok(prepaid.includes('name="size" value="41"') && prepaid.includes('name="size" value="42"'),
        '第4步：41 / 42 在预订组（实时库存里没有）');

      // 第5步：**一行 4 个**（四列网格；`minmax(0, 1fr)` ⇒ 窄屏不横向滚动）
      assert.match(page.html, /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
        '第5步：尺码区必须是四列网格（一行 4 个）');

      // 第6步：**不显示数量**（她：「你不用管数量，只要它实时库存表里面有，你显示就行」）
      for (const [label, group] of [['现货组', inStock], ['预订组', prepaid]]) {
        assert.equal(group.includes('双'), false, `第6步：${label}里还显示着数量（不该有「双」）`);
      }

      // 第7步：页面**零前端脚本**（手机白屏事故之后定的底线）
      // ⭐ 2026-10-12：销售页有提交按钮 ⇒ 只允许那一段反馈脚本
      assert.equal(scriptCountOf(page.html), 1, '第7步：整页只该有那一段提交反馈脚本');
      assert.ok(page.html.includes('<script data-view="submit-feedback">'));
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-2 加入本单 ⇒ 303 + 本单 1 双 + 业务表零写入
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-2 加入本单（现货尺码、实收留空）⇒ 303 + 本单条 1 双；业务表零写入', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_2');
  try {
    await withServer(e2e.app, async (base) => {
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.equal(page.status, 200, '第1步：先打开扫码页');
      assert.ok(draftBarOf(page.html).includes('本单：0 双'), '第1步：还没加单 ⇒ 本单条是 0 双');

      const added = await addLine(base, cookie, NUMBER_A, '40');
      assert.equal(added.status, 303, '第2步：加入本单 = Post-Redirect-Get 的 303（刷新不会重复提交）');
      const location = String(added.headers.get('location'));
      assert.match(location, /added=1$/, '第2步：回跳带上 added=1（本单看得见）');

      // 她手机上看到的是**303 回跳后的那一页**（带 added=1）—— 所以就按那一页断言
      const after = await getPage(`${base}${location}`, cookie);
      assert.equal(after.status, 200, '第3步：303 回跳后的那一页能打开');
      assert.ok(draftBarOf(after.html).includes('本单：1 双'), '第3步：本单条显示 1 双');
      assert.ok(draftBarOf(after.html).includes('已加入本单（1 双）'),
        '第3步：本单条里有那句极简反馈');

      // 第4步：**业务表一个字都没写**（她："点【提交】才写账"）
      for (const table of ['salesEntry', 'salesDetail', 'paymentRecord', 'inventoryLedger']) {
        assert.equal(rowsOf(e2e, table).length, 0, `第4步：「${table}」被提前写了（加单只该写本地会话）`);
      }
      assert.equal(rowsOf(e2e, 'liveInventory').length, 1, '第4步：库存一条不动（还没交付）');
      const session = await e2e.sessions.get('ou_e2e_2');
      assert.equal(session.sale.lines.length, 1, '第5步：本单确实落在**本地会话**里（1 双）');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-3 ⭐ 跨编号累积（一单多双 · 多次扫码 的命门）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-3 ⭐ 跨编号累积：再扫另一个编号 → 加入本单 ⇒ 本单 2 双（同一会话，不是新开一单）', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_3');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.equal((await addLine(base, cookie, NUMBER_A, '40')).status, 303, '第1步：扫 A 加 1 双');

      // 第2步：换一个编号（B —— 一双库存都没有）**重新扫**，仍然看到"本单 1 双"
      const pageB = await getPage(pageUrlOf(base, NUMBER_B), cookie);
      assert.equal(pageB.status, 200, '第2步：B 的扫码页能打开');
      assert.ok(draftBarOf(pageB.html).includes('本单：1 双'),
        '第2步：换编号后本单条读到的是**同一个本单**（跨编号累积）');
      assert.equal((await addLine(base, cookie, NUMBER_B, '41')).status, 303, '第3步：扫 B 再加 1 双');

      const after = await getPage(pageUrlOf(base, NUMBER_B), cookie);
      assert.ok(draftBarOf(after.html).includes('本单：2 双'), '第4步：本单条变成 2 双');
      const session = await e2e.sessions.get('ou_e2e_3');
      assert.equal(session.sale.lines.length, 2, '第4步：本地会话里就是 2 行（一单两双）');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 0, '第4步：还没提交 ⇒ 表里一张单都没有');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 公共：加两双（A 的现货 40 + B 的预订 41）并提交（**资金全空**）
// ═══════════════════════════════════════════════════════════════════════════

const addTwoAndSubmit = async (e2e, cookie, base) => {
  await getPage(pageUrlOf(base, NUMBER_A), cookie);
  await addLine(base, cookie, NUMBER_A, '40');       // 现货（有门盒）
  await addLine(base, cookie, NUMBER_B, '41');       // 预订（一双都没有）
  // 提交表单**原样**提交：每件实收留空、收款行空、付款情况 = **页面默认那一档**。
  // ⚠️ 2026-10-12 **改写**：这里原来写 `PAYMENT_STATUS.full` ——
  //    改前口径：选「全付」但一笔收款都不填 ⇒ 按「未付」落库（她 2026-10-11 点头的行为）；
  //    改后口径：**全付 + 收款 0 笔 + 每件实收也全空** ⇒ **拦住**（零元全付单直接拒绝，
  //    见 `scanWriteService` 的 `full_without_money`）。
  //    这一批用例要钉的是"**资金全空也能建单**"，那就该用页面默认那一档（未付）——
  //    逐条理由写在报告里。
  return postForm(pageUrlOf(base, NUMBER_A), cookie, {
    action: SCAN_WRITE.actions.submitOrder,
    submit_key: 'scan_sale:scan_session_e2e:1',
    payment_status: PAYMENT_STATUS.unpaid,
    payment_method: '',
    payment_amount: '',
    line_amount: ['', ''],
  });
};

/** 提交那一把真实的幂等键（从页面上取，与她的手机页面同一把）。 */
const submitKeyOf = (html) => {
  const match = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/);
  assert.ok(match, '页面上没有 submit_key（连提交表单都没渲染出来）');
  return match[1];
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-4 提交这一单（资金全空）⇒ 成功页 + 一张单两行明细
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-4 提交这一单（资金全空）⇒ 成功页（单号 + 双数）：主表 1 条、明细 2 行、都挂同一张单', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_4');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      await addLine(base, cookie, NUMBER_B, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const submitKey = submitKeyOf(page.html);
      assert.ok(draftBarOf(page.html).includes('本单：2 双'), '第1步：提交前本单 2 双');

      // 第2步：**资金全空**（每件实收留空 + 没有收款行）照样提交 —— 门槛只要"货品信息齐"
      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKey,
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: ['', ''],
      });
      const doneHtml = await done.text();
      assert.equal(done.status, 200, `第2步：资金全空应该直接成单（不是 400）：${doneHtml.slice(0, 200)}`);
      assert.match(doneHtml, /您的提交已成功/, '第3步：给她的是"提交好了"那一页');
      assert.match(doneHtml, /销售单号：XSD-\d{8}-\d{4}/, '第3步：结果页上有**单号**');
      assert.match(doneHtml, /明细：2 双（每双一行）/, '第3步：结果页上有**双数**');

      // 第4步：表里真的是"一张单 + 两行明细"
      const entries = rowsOf(e2e, 'salesEntry');
      const details = rowsOf(e2e, 'salesDetail');
      assert.equal(entries.length, 1, '第4步：销售主表 1 条');
      assert.equal(details.length, 2, '第4步：销售明细 2 行（一单一双一行）');
      for (const detail of details) {
        assert.deepEqual(detail.fields[F('salesDetail', 'salesEntry')], [entries[0].record_id],
          '第4步：两行明细都挂在**同一张**单上');
      }
      assert.equal(rowsOf(e2e, 'paymentRecord').length, 0, '第4步：资金全空 ⇒ 一条收款明细都不写');
      // 第5步：她那两个编号都进了这一张单
      assert.deepEqual(
        details.map((detail) => detail.fields[F('salesDetail', 'product')][0]).sort(),
        ['prod_a', 'prod_b'],
        '第5步：A（现货 40）+ B（预订 41）都在这一张单里',
      );
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-5 ⭐ 现货行 = 已交付 + 扣库存；预订行不扣
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-5 ⭐ 现货行已交付 + 库存真的少 1（流水 1 条）；预订行未交付、库存不动', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_5');
  try {
    await withServer(e2e.app, async (base) => {
      assert.equal(rowsOf(e2e, 'liveInventory').length, 1, '第1步：提交前，A 的 40 码有 1 双门盒');
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');                      // 现货
      await addLine(base, cookie, NUMBER_B, '41');                      // 预订
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: ['', ''],
      });
      assert.equal(done.status, 200, `第2步：提交要成功：${(await done.text()).slice(0, 200)}`);

      const details = rowsOf(e2e, 'salesDetail');
      const byProduct = (id) => details.find((detail) => detail.fields[F('salesDetail', 'product')][0] === id);
      const cash = byProduct('prod_a');
      const prepaid = byProduct('prod_b');

      // 第3步：货那一维 —— 现货 = 已交付；预订 = 未交付
      assert.equal(cash.fields[F('salesDetail', 'fulfillmentStatus')], '已交付',
        '第3步：现货行（有门盒）提交即交付');
      assert.equal(prepaid.fields[F('salesDetail', 'fulfillmentStatus')], '未交付',
        '第3步：预订行（没货）不交付');

      // 第4步：**库存真的少了一双**（那一双门盒被既有库存引擎扣掉）
      const liveLeft = rowsOf(e2e, 'liveInventory');
      assert.equal(liveLeft.length, 0, `第4步：门盒那一双应该被扣掉（还剩 ${liveLeft.length} 条实时库存）`);

      // 第5步：库存流水 1 条，且只关联**现货**那一行
      const ledger = rowsOf(e2e, 'inventoryLedger');
      assert.equal(ledger.length, 1, '第5步：库存流水只多 1 条（预订行不许写流水）');
      assert.deepEqual(ledger[0].fields[F('inventoryLedger', 'salesDetail')], [cash.record_id],
        '第5步：那一条流水关联的是现货那一行');
      // ⚠️ 既有口径：**数量恒为正数，方向写在「库存行为」那一列**（销售减少 = 减少 1 双）
      assert.equal(Number(ledger[0].fields[F('inventoryLedger', 'quantityChange')]), 1,
        '第5步：变动数量 = 1（正数；"减少"由「库存行为」表达）');
      assert.deepEqual(ledger[0].fields[F('inventoryLedger', 'behavior')], ['bh_sale_decrease'],
        '第5步：库存行为 = 既有那条「销售减少」（方向 减少）');

      // 第6步：主表「库存状态」由既有交付链路收口
      assert.equal(rowsOf(e2e, 'salesEntry')[0].fields[F('salesEntry', 'stock')], '已写入',
        '第6步：主表库存状态 = 已写入');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-6 幂等：同一把提交键连点两次（含并发）⇒ 只建一张单、只扣一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-6 幂等：同一提交键连点两次（含并发）⇒ 只建一张单、只扣一次库存', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_6');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      await addLine(base, cookie, NUMBER_B, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const submitKey = submitKeyOf(page.html);
      const body = {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKey,
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: ['', ''],
      };

      // 第1步：**并发**两个一模一样的提交（她手滑连点 / 网络重发）
      const [first, second] = await Promise.all([
        postForm(pageUrlOf(base, NUMBER_A), cookie, body),
        postForm(pageUrlOf(base, NUMBER_A), cookie, body),
      ]);
      const [firstHtml, secondHtml] = [await first.text(), await second.text()];
      assert.equal(first.status, 200, `第1步：第一次要成功：${firstHtml.slice(0, 200)}`);
      assert.equal(second.status, 200, `第1步：第二次也要给她一个成功页（可能是"已提交过"）：${secondHtml.slice(0, 200)}`);

      // 第2步：只写了一次
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第2步：销售主表只有 1 条');
      assert.equal(rowsOf(e2e, 'salesDetail').length, 2, '第2步：明细只有 2 行');
      assert.equal(rowsOf(e2e, 'inventoryLedger').length, 1, '第2步：库存流水只有 1 条');
      assert.equal(rowsOf(e2e, 'liveInventory').length, 0, '第2步：库存只扣了一次');
      assert.equal(rowsOf(e2e, 'paymentRecord').length, 0, '第2步：资金全空 ⇒ 一条收款明细都没有');

      // 第3步：**再点一次**（串行）也只有一个结果 —— 而且拿到的是"已经提交过"那一页
      const third = await postForm(pageUrlOf(base, NUMBER_A), cookie, body);
      const thirdHtml = await third.text();
      assert.equal(third.status, 200, '第3步：第三次也是 200');
      // ⚠️ 2026-10-12 **改写**：改前文案「这一单已经提交过了」——她把这句读成"没写进去"，
      //    还为此报过"我提交成功的都没有"。改后是「✅ 这一单刚才已经交过了」（语气平、事实不变）。
      assert.match(thirdHtml, /这一单刚才已经交过了/, '第3步：第三次告诉她"已经交过了"（没重复写）');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第3步：主表仍然只有 1 条');
      assert.equal(rowsOf(e2e, 'inventoryLedger').length, 1, '第3步：库存流水仍然只有 1 条');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-7 提交后本单归零（再打开那一页）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-7 提交后本单归零：再打开 ⇒ 本单：0 双，本单条上不再渲染【提交这一单】', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_7');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      await addLine(base, cookie, NUMBER_B, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.ok(draftBarOf(page.html).includes('本单：2 双'), '第1步：提交前 2 双');
      // ⚠️ 2026-10-12 **改写**：改前断言"本单条上就有【提交这一单】"；改后**本单条不再放提交按钮**
      //    （真机丢钱就是它造成的：那颗按钮不带收款字段）⇒ 改成断言"有草稿 ⇒ 页面上有且只有一颗提交按钮"。
      assert.equal((page.html.match(/value="submit_order"/g) || []).length, 1,
        '第1步：有草稿 ⇒ 销售块上那颗（带钱的）提交按钮在');

      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: ['', ''],
      });
      assert.equal(done.status, 200, `第2步：提交要成功：${(await done.text()).slice(0, 200)}`);

      // 第3步：再打开（她接着扫下一个）⇒ 本单条归零、提交按钮跟着消失
      const again = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const bar = draftBarOf(again.html);
      assert.ok(bar.includes('本单：0 双'), '第3步：本单条归零（提交后可以接着开新的一单）');
      assert.equal(bar.includes(SCAN_WRITE.texts.submitButton), false,
        '第3步：没有草稿 ⇒ 本单条上不再渲染【提交这一单】（不是灰按钮）');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第3步：表里仍然只有那一张单');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-8 ⭐⭐ 她真机卡住的那一步（回归）：
//   「只有一笔单子，一直提交不了」（线上日志 `scan.sale.amount_mismatch
//    payment_status="全付" items_cents=9900 payments_cents=0`）
//   ⇒ 扫码建单：**只填实收 / 什么都不填** 都必须能提交成单。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-8 ⭐ 只填实收（或什么都不填）⇒ **一定能提交成单**；不会自动冒出一条【未收款】', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      // ── 第一单：她**只填了每件实收**、收款一行都没填（线上卡的正是这一种）────────
      const cookie1 = sessionCookie('ou_e2e_8a');
      await getPage(pageUrlOf(base, NUMBER_A), cookie1);
      await addLine(base, cookie1, NUMBER_A, '40');            // 现货
      const page1 = await getPage(pageUrlOf(base, NUMBER_A), cookie1);
      const key1 = submitKeyOf(page1.html);
      // 表单**原样**提交：付款情况 = 页面上预选的那一档（现在是「未付」）+ 每件实收 99、收款行空
      const first = await postForm(pageUrlOf(base, NUMBER_A), cookie1, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: key1,
        payment_status: PAYMENT_STATUS.unpaid,
        payment_method: '', payment_amount: '',
        line_amount: ['99'],
      });
      const firstHtml = await first.text();
      assert.equal(first.status, 200,
        `第1步：**只填实收也要能提交**（她卡的就是这一步）：${firstHtml.slice(0, 300)}`);
      assert.match(firstHtml, /您的提交已成功/, '第1步：给她"提交好了"那一页');
      assert.match(firstHtml, /明细：1 双（每双一行）/, '第1步：结果页上有双数');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第1步：单子建出来了');
      assert.equal(rowsOf(e2e, 'salesDetail')[0].fields[F('salesDetail', 'actualAmount')], 99,
        '第1步：她填的实收照旧落表');
      assert.equal(rowsOf(e2e, 'paymentRecord').length, 0,
        '第1步：**不会**自动冒出一条【未收款】（她没说欠钱）');

      // ── 第二单：**什么都不填**（每件实收空 + 收款空）──────────────────────────
      const cookie2 = sessionCookie('ou_e2e_8b');
      await getPage(pageUrlOf(base, NUMBER_B), cookie2);
      await addLine(base, cookie2, NUMBER_B, '41');
      const page2 = await getPage(pageUrlOf(base, NUMBER_B), cookie2);
      const second = await postForm(pageUrlOf(base, NUMBER_B), cookie2, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page2.html),
        payment_status: PAYMENT_STATUS.unpaid,
        payment_method: '', payment_amount: '', line_amount: [''],
      });
      const secondHtml = await second.text();
      assert.equal(second.status, 200, `第2步：什么都不填也要能提交：${secondHtml.slice(0, 300)}`);
      assert.match(secondHtml, /您的提交已成功/, '第2步：给她"提交好了"那一页');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 2, '第2步：第二张单也建出来了');
      assert.equal(rowsOf(e2e, 'paymentRecord').length, 0, '第2步：一条收款明细都没有');
      // 第3步：两张单都**不缺货那一半**（钱可以待补充，货不能丢）
      assert.equal(rowsOf(e2e, 'salesDetail').length, 2, '第3步：两张单各 1 行明细');
      assert.equal(rowsOf(e2e, 'liveInventory').length, 0,
        '第3步：现货那一双照旧提交即交付、库存扣掉');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-E2E-9 🔴🔴 真机 bug 的 HTTP 回归：**会话过期 ≠ 死路**
//   她的现场：页面 200、`POST` 一提交就 **400（本单已过期）**，刷新 / 重扫三遍都一样
//   （日志 17:48-17:52Z）。这一条把"她那一整套动作"在真路由上跑一遍。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-9 🔴 会话过期后：页面照旧打得开 ⇒ 用页面上那把 key 提交**必须成单**（不再 400）', async () => {
  login();
  const e2e = createE2E();
  const openId = 'ou_e2e_9';
  const cookie = sessionCookie(openId);
  try {
    await withServer(e2e.app, async (base) => {
      // ① 正常扫两双（现货 40 + 预订 41），本单 2 双
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      await addLine(base, cookie, NUMBER_B, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.ok(draftBarOf(page.html).includes('本单：2 双'), '第1步：本单 2 双');

      // ② 把这一份会话的 `expires_at` 拨到**过去**（= 她挂了 8 小时那种形态）
      await e2e.sessions.store.update(e2e.sessions.idOf(openId), {
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });
      const expired = await e2e.sessions.get(openId);
      assert.equal(expired.expired, true, '第2步：夹具前提 —— 会话现在**是过期的**');

      // ③ 她刷新那一页：**照旧 200**（页面渲染走只读的 `sessions.get`）—— 这正是"页面能打开"的现场
      const refreshed = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.equal(refreshed.status, 200, '第3步：过期后页面**照样打得开**（现场就是这样）');
      assert.ok(draftBarOf(refreshed.html).includes('本单：2 双'), '第3步：过期会话里那 2 双照旧显示');

      // ④ 她拿这一页上的那把 key 点【提交这一单】⇒ **必须成功**（改前这里 400，反复刷都没用）
      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(refreshed.html),
        payment_status: PAYMENT_STATUS.unpaid,
        payment_method: '', payment_amount: '', line_amount: ['', ''],
      });
      const doneHtml = await done.text();
      assert.equal(done.status, 200,
        `第4步：过期会话提交**必须成功**（她真机卡的就是这里，改前是 400）：${doneHtml.slice(0, 300)}`);
      assert.match(doneHtml, /您的提交已成功/, '第4步：给她"提交好了"那一页');
      assert.match(doneHtml, /明细：2 双（每双一行）/, '第4步：两双都在（草稿没被过期吃掉）');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第4步：成了一张单');
      assert.equal(rowsOf(e2e, 'salesDetail').length, 2, '第4步：两行明细');

      // ⑤ 提交后本单归零（她可以接着扫下一单）
      const after = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.ok(draftBarOf(after.html).includes('本单：0 双'), '第5步：本单归零');
      // ⚠️ 2026-10-12 改写：**本单条里不再有提交按钮**（真机丢钱就是它造成的）。
      //    ⚠️ 销售块那颗**照旧一直在**：空本单时它写着"（1 双）"，正是"一单一笔 = 选尺码 + 提交"的入口。
      assert.equal(draftBarOf(after.html).includes('value="submit_order"'), false,
        '第5步：本单条里没有提交按钮');
      assert.ok(after.html.includes('提交这一单（1 双）'),
        '第5步：销售块那颗还在，文案回到"（1 双）"');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第5步：没有再建第二张单');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴🔴 2026-10-12 真机丢钱（`payment_count: 0`）之后定的两条
//   根因：**同一页上有两颗【提交这一单】**（本单条那颗不带收款字段、销售块那颗带）
//   ⇒ 她在销售块填的「全付 + 微信 280」被本单条那颗吃了 ⇒ 钱一行没记。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-10 🔴 销售页**只有一颗**提交按钮，而且它**带着收款字段**', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_10');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const html = page.html;

      // ① 只允许存在**一颗**提交按钮（= 一个带钱字段的提交表单）
      const submitButtons = (html.match(/value="submit_order"/g) || []).length;
      assert.equal(submitButtons, 1,
        `🔴 一页上只能有一颗【提交这一单】（真机丢钱就是"两颗、其中一颗不带钱"造成的）：${submitButtons}`);

      // ② 那颗按钮所在表单必须带齐钱字段（付款情况 / 收款方式 / 收款金额 / 每件实收）
      const formStart = html.lastIndexOf('<form', html.indexOf('value="submit_order"'));
      const form = html.slice(formStart, html.indexOf('</form>', formStart));
      for (const [name, field] of [
        ['付款情况', SCAN_WRITE.fields.paymentStatus], ['收款方式', SCAN_WRITE.fields.paymentMethod],
        ['收款金额', SCAN_WRITE.fields.paymentAmount], ['每件实收', SCAN_WRITE.fields.lineAmount],
      ]) {
        assert.ok(form.includes(`name="${field}"`),
          `🔴 那一颗提交按钮的表单里缺「${name}」（${field}）—— 少一个就会静默丢钱`);
      }
      // ③ 本单条里**不再有**任何提交表单（只剩 本单：N 双 + 继续扫下一个）
      assert.equal(draftBarOf(html).includes('value="submit_order"'), false,
        '本单条里不许再有第二颗提交按钮（它带不了钱）');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-11 🔴 全付 + 收款 0 笔 + 每件实收也全空 ⇒ 400 + 人话；**零写入**', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_11');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const rejected = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.full, payment_method: '', payment_amount: '', line_amount: [''],
      });
      const html = await rejected.text();
      assert.equal(rejected.status, 400, `🔴 这种"零元全付单"必须拦住（不许静默落库）：${html.slice(0, 200)}`);
      assert.match(html, /全付/, '人话里要指名「全付」');
      for (const table of ['salesEntry', 'salesDetail', 'paymentRecord', 'inventoryLedger']) {
        assert.equal(rowsOf(e2e, table).length, 0, `第2步：拦住时「${table}」不许写（零写入）`);
      }
      // 同一把键、改成「未付」（= 页面默认那一档）⇒ 立刻能提交成单（她不会被卡住）
      const ok = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: [''],
      });
      assert.equal(ok.status, 200, `第3步：改成「未付」就能提交：${(await ok.text()).slice(0, 200)}`);
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '第3步：成了一张单');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-12 ⭐ 销售块提交「全付 + 微信 280 + 每件实收 280」⇒ 收款明细 1 行（方式/金额/状态都对）', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_12');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      await addLine(base, cookie, NUMBER_B, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.full,
        // ⚠️ 收款行是**重复的同名字段**（一 row 一份）⇒ 必须传数组（页面就是这么发的）
        payment_method: ['微信'], payment_amount: ['280'],
        line_amount: ['150', '130'],
      });
      const html = await done.text();
      const mismatch = (html.match(/<p class="form-alert">([^<]*)<\/p>/) || [])[1] || '';
      assert.equal(done.status, 200, `第1步：提交要成功（400 时页面上那句人话 = ${mismatch}）：${html.slice(0, 200)}`);
      assert.match(html, /您的提交已成功/, '第1步：结果页说提交好了');

      const rows = rowsOf(e2e, 'paymentRecord');
      assert.equal(rows.length, 1, '🔴 收款明细必须有 **1 行**（真机那次是 0 行）');
      assert.deepEqual(rows[0].fields[PAYMENT_FIELDS.method], ['pm_wechat'], '方式 = 微信（假网关里那条记录）');
      assert.equal(rows[0].fields[PAYMENT_FIELDS.amount], 280, '金额 = 280');
      assert.equal(rows[0].fields[PAYMENT_FIELDS.status], '已收款', '状态 = 已收款');
      assert.ok(rows[0].fields[PAYMENT_FIELDS.receivedAt] > 0, '收款日照旧写');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '主表 1 行');
      assert.equal(rowsOf(e2e, 'salesDetail').length, 2, '明细 2 行');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-12 UX：一眼看到成功 / 按钮带双数 / 重复提交不吓人
// ═══════════════════════════════════════════════════════════════════════════

test('AC-E2E-13 ⭐ 提交按钮文案带双数：「提交这一单（2 双）」', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_13');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      await addLine(base, cookie, NUMBER_B, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.match(page.html, /提交这一单（2 双）/,
        '按钮上直接写几双（她一眼知道这一单里有几双）');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-14 ⭐ 结果页：✅ 一眼成功 + 单号 + 双数 + 下一步；**不含任何表单**', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_14');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: [''],
      });
      const html = await done.text();
      assert.equal(done.status, 200);
      assert.match(html, /✅/, '结果页要有那个一眼就看得见的 ✅');
      assert.match(html, /您的提交已成功/, '文案：您的提交已成功');
      assert.match(html, /销售单号：XSD-\d{8}-\d{4}/, '单号');
      assert.match(html, /明细：1 双/, '共几双');
      assert.match(html, /工作台/, '下一步：去工作台补实收/收款');
      assert.equal(/<form|<button/i.test(html), false,
        '🔴 结果页里**不许**再出现表单/按钮（刷新、误点都不会再提交一遍）');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-15 ⭐ 重复提交的文案：✅「这一单刚才已经交过了」——**不许**出现让人以为失败的话', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_15');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const body = {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: [''],
      };
      const first = await postForm(pageUrlOf(base, NUMBER_A), cookie, body);
      assert.equal(first.status, 200);
      const again = await postForm(pageUrlOf(base, NUMBER_A), cookie, body);   // 同一把键再点一次
      const html = await again.text();
      assert.equal(again.status, 200);
      assert.match(html, /✅/, '重复提交那一页同样是一眼可见的 ✅');
      assert.match(html, /这一单刚才已经交过了/, '文案：这一单刚才已经交过了');
      assert.match(html, /XSD-\d{8}-\d{4}/, '并把单号还给她');
      // ⚠️ 只看**她看得见的那张卡**（`state-msg`）——整页 HTML 里还有样式表，扫整页会误伤。
      const card = (html.match(/<section class="card state-msg">[\s\S]*?<\/section>/) || [''])[0];
      assert.ok(card.includes('这一单刚才已经交过了'), '那张卡就是要给她看的内容');
      for (const banned of ['没有重复写入', '重复提交', '已经提交过了', '失败', '错误']) {
        assert.equal(card.includes(banned), false,
          `🔴 重复提交页里不许出现会让她以为失败的话：「${banned}」`);
      }
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '只写了一单（幂等照旧）');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-16 ⭐ 每件实收旁边写明「可以留空」；400 校验页把人话差额挂在**最上面**', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_16');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.match(page.html, /可以留空/, '每件实收旁边要写明"可以不填"（她的痛点是费劲）');

      // 全付 + 收款 200、实收 150 ⇒ 差额 → 400，人话差额必须在**最上面**（H1）
      const rejected = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.full, payment_method: '微信', payment_amount: '200',
        method: ['微信'], amount: ['200'], line_amount: ['150'],
      });
      const html = await rejected.text();
      assert.equal(rejected.status, 400);
      // 原地重渲染那一版：差额必须挂在**销售块最上面**（`.form-alert`），
      // 而且位置要在**提交按钮之前**（她一眼就能看到，不用往下翻）。
      const alert = (html.match(/<p class="form-alert">([\s\S]*?)<\/p>/) || [])[1] || '';
      assert.match(alert, /差|¥/, `人话差额要挂在销售块最上面：实际 = ${alert}`);
      assert.ok(html.indexOf('form-alert') < html.indexOf('value="submit_order"'),
        '差额要在提交按钮**上面**');
      assert.equal(/<p class="form-alert">[^<]*没提交成功/.test(html), false,
        '泛泛的"没提交成功"不许占着最上面那一行');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-17 ⭐ 一单一笔 = **选尺码 + 提交**（两下）：空本单时提交按钮写着「（1 双）」，带着尺码一起提交只需一次 POST', async () => {
  login();
  const e2e = createE2E();
  const cookie = sessionCookie('ou_e2e_17');
  try {
    await withServer(e2e.app, async (base) => {
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      // ① 空本单：页面上那颗提交按钮就在**尺码同一个表单**里，文案是「（1 双）」
      assert.match(page.html, /✅ 提交这一单（1 双）/, '空本单 ⇒ 主按钮就是"提交这一双"');
      const formStart = page.html.lastIndexOf('<form', page.html.indexOf('value="submit_order"'));
      const form = page.html.slice(formStart, page.html.indexOf('</form>', formStart));
      assert.ok(form.includes('name="size"'), '尺码 radio 与提交按钮在**同一个表单**里（零 JS 也能一起提交）');

      // ② 两下 = 【选尺码】+【提交】：这一次 POST 就是浏览器在她选完尺码后按那颗按钮发的
      const done = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        size: '40', payment_status: PAYMENT_STATUS.unpaid,
        payment_method: '', payment_amount: '', line_amount: [],
      });
      const html = await done.text();
      assert.equal(done.status, 200, `第2步：一次 POST 就成单：${html.slice(0, 200)}`);
      assert.match(html, /您的提交已成功/, '第2步：结果页说提交好了');
      assert.match(html, /明细：1 双/, '第2步：这一双真的进去了');
      assert.equal(rowsOf(e2e, 'salesEntry').length, 1, '主表 1 行');
      assert.equal(rowsOf(e2e, 'salesDetail').length, 1, '明细 1 行');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12 新写：把"群聊链路验过、但扫码链路没验过"的核心语义补上
//
// 来历（见 `docs/group-chat-test-removal-2026-10-12.md`「判据 (b) 等价覆盖核对」）：
//   群聊自然语言录入退场后，原 `salesFundTypeDecoupling.test.js`(12) 与
//   `salesMultiLineTradeType.test.js`(5) 那 17 条要处置。逐条核对后：
//     · 5 条**已有等价覆盖**（类型由库存定 / 混合单逐行交付 / 预定不被钱卡住）
//     · 1 条**随能力退场**（"一句原话 → 一单多明细多收款" = 解析层能力）
//     · **11 条对不上 ⇒ 在这里新写**（断言逐字保留）
//
// ⚠️ **走的是项目代码**：`createScanWriteService.addSaleLine` → `submitSale`
//   —— **不是**在用例里手拼 `V1PostingService.postSale` + `SalesDeliveryService.deliver`
//   （那是"自己拼链"，测不到项目代码；项目纪律明令禁止）。
//
// 语料（照抄 `config/scanWrite.js:92-107` 的口径）：
//   · 全付   ⇒ 写 1 条【已收款】
//   · 部分付 ⇒ 已收那几条 + **差额一条【未收款】**
//   · 未付   ⇒ **一条【未收款】**（= 每件实收合计）
// ═══════════════════════════════════════════════════════════════════════════

const AMOUNT_KEY = F('paymentRecord', 'amount');
const STATUS_KEY = F('paymentRecord', 'status');

/** 提交一笔扫码销售：`size` 决定类型（40 = A 的门盒有货 ⇒ 现货；41 = 没货 ⇒ 预定）。 */
const submitSaleAt = async (e2e, openId, { size, amount, payments, paymentStatus, paidAmount }) => {
  const added = await e2e.writeService.addSaleLine({
    openId, requestId: `req_${size}`, productRecordId: 'prod_a',
    number: NUMBER_A, itemNo: ITEM_A, color: '黑色', size, amount,
    // ⭐ 类型由**库存分组**定（扫码页渲染时就分成有货/没有两组）⇒ 显式传给她。
    //    判据仍是既有那一份 `salesTradeTypeForStock`（`scanWriteService.js:393`）。
    inStock: size === 40,
  });
  assert.equal(added.ok, true, JSON.stringify(added));
  const session = await e2e.sessions.get(openId);
  const result = await e2e.writeService.submitSale({
    openId, submitKey: session.sale.key, payments, paymentStatus, paidAmount,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
};

/** 回读：收款行（金额 + 状态，按写入顺序）、欠款、类型、履约状态、库存流水条数。 */
const readBack = async (e2e) => {
  const receipts = rowsOf(e2e, 'paymentRecord')
    .map((row) => [row.fields[AMOUNT_KEY], row.fields[STATUS_KEY]]);
  const entry = rowsOf(e2e, 'salesEntry')[0];
  const progress = await new SalesProgressService({ gateway: e2e.gateway })
    .forOrder(entry.record_id);
  return {
    receipts,
    pendingAmount: progress.pendingAmount,
    tradeType: rowsOf(e2e, 'salesDetail')[0].fields[F('salesDetail', 'tradeType')],
    fulfillment: rowsOf(e2e, 'salesDetail')[0].fields[F('salesDetail', 'fulfillmentStatus')],
    ledgerCount: rowsOf(e2e, 'inventoryLedger').length,
  };
};

const FUND_SHAPES = [
  { key: 'full', label: '全款 228 微信', amount: '228',
    payments: [{ method: '微信', amount: '228' }], paidAmount: '228', paymentStatus: PAYMENT_STATUS.full,
    receipts: [[228, '已收款']], pendingAmount: 0 },
  { key: 'partial', label: '部分：先给 100、还欠 128', amount: '228',
    payments: [{ method: '微信', amount: '100' }], paidAmount: '100', paymentStatus: PAYMENT_STATUS.partial,
    receipts: [[100, '已收款'], [128, '未收款']], pendingAmount: 128 },
  { key: 'unpaid', label: '没付：整单未付', amount: '228', payments: [],
    paymentStatus: PAYMENT_STATUS.unpaid, receipts: [], pendingAmount: 228,
    note: '2026-10-11 晚口径：未付 ⇒ **不替她记【未收款】**（欠款由读侧现算）' },
  { key: 'deposit', label: '定金 100 + 尾款 128', amount: '228',
    payments: [{ method: '微信', amount: '100' }], paidAmount: '100', paymentStatus: PAYMENT_STATUS.partial,
    receipts: [[100, '已收款'], [128, '未收款']], pendingAmount: 128 },
  { key: 'tail_collect', label: '定金 100 + 下次收 120', amount: '220',
    payments: [{ method: '微信', amount: '100' }], paidAmount: '100', paymentStatus: PAYMENT_STATUS.partial,
    receipts: [[100, '已收款'], [120, '未收款']], pendingAmount: 120 },
];

for (const shape of FUND_SHAPES) {
  test(`⭐新写 ③ ${shape.label}：**现货**（扫码 40 码有货）→ 收款 ${JSON.stringify(shape.receipts)}、欠款 ${shape.pendingAmount}`, async () => {
    const e2e = createE2E();
    try {
      await submitSaleAt(e2e, `ou_fund_cash_${shape.key}`, { size: 40, ...shape });
      const back = await readBack(e2e);
      // ⚠️ 「交易类型」是**关联到「行为管理」的记录数组**（不是编码字符串）⇒ 按记录 id 断言。
      assert.deepEqual(back.tradeType, ['bh_cash'], '门盒有货 ⇒ 现货（行为=SALE_CASH 那条）');
      assert.deepEqual(back.receipts, shape.receipts, '收款条数与状态逐字');
      assert.equal(back.pendingAmount, shape.pendingAmount, '欠款逐字');
      assert.equal(back.fulfillment, '已交付');
      assert.ok(back.ledgerCount >= 1, '现货必须写库存流水');
    } finally { e2e.cleanup(); }
  });

  test(`⭐新写 ③ ${shape.label}：**预定**（扫码 41 码没货）→ 收款与欠款**逐字相同**；不交付、不扣库存`, async () => {
    const e2e = createE2E();
    try {
      await submitSaleAt(e2e, `ou_fund_prepaid_${shape.key}`, { size: 41, ...shape });
      const back = await readBack(e2e);
      assert.deepEqual(back.tradeType, ['bh_prepaid'], '没货 ⇒ 预定（行为=SALE_PREPAID 那条）');
      // ⭐ 这就是"资金与类型无关"：**同样一串收款，一字不差**。
      assert.deepEqual(back.receipts, shape.receipts, '收款条数与状态**与现货逐字相同**');
      assert.equal(back.pendingAmount, shape.pendingAmount, '欠款**与现货逐字相同**');
      assert.equal(back.fulfillment, '未交付');
      assert.equal(back.ledgerCount, 0, '预定不许写库存流水');
    } finally { e2e.cleanup(); }
  });
}

// ── ⭐⭐ 跨两态逐字对照（原 `salesFundTypeDecoupling` 最后一条的强断言）────────
test('⭐⭐新写 ③ 同一份资金输入：现货 / 预定两次的收款与欠款**逐字相同**（类型不影响钱）', async () => {
  const shape = FUND_SHAPES.find((row) => row.key === 'partial');
  const cash = createE2E();
  const prepaid = createE2E();
  try {
    await submitSaleAt(cash, 'ou_same_money_in', { size: 40, ...shape });
    await submitSaleAt(prepaid, 'ou_same_money_out', { size: 41, ...shape });
    const withStock = await readBack(cash);
    const withoutStock = await readBack(prepaid);

    assert.deepEqual(withStock.receipts, withoutStock.receipts,
      '同一串收款在现货/预定下必须逐字相同');
    assert.equal(withStock.pendingAmount, withoutStock.pendingAmount, '欠款也必须逐字相同');
    // 类型确实不同（否则上面那条对照就成了"两边同一态"的假证）。
    assert.deepEqual(withStock.tradeType, ['bh_cash']);
    assert.deepEqual(withoutStock.tradeType, ['bh_prepaid']);
    assert.equal(withStock.fulfillment, '已交付');
    assert.equal(withoutStock.fulfillment, '未交付');
    assert.equal(withStock.ledgerCount, 1);
    assert.equal(withoutStock.ledgerCount, 0);
  } finally { cash.cleanup(); prepaid.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12 提交链路【分阶段耗时】（业务负责人真机被卡住 / 收过 504 网关超时）
//    她 2026-10-09 对取数那条说过「以后**一查日志就知道卡在哪一步**」——这里是**提交**那条的同一件事。
// ═══════════════════════════════════════════════════════════════════════════

/** 抓 info 日志（`utils/logger` 的 info 就是 `console.log`，与 `scanPageLookupTiming` 同一做法）。 */
const captureInfo = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const value = await run();
    return { value, entries: lines.map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean) };
  } finally { console.log = original; }
};

const TIMING_KEYS = ['submit_ms', 'queue_wait_ms', 'lookup_ms', 'prepare_ms', 'master_ms',
  'status_ms', 'detail_ms', 'stock_ms'];

const submitOnceForTiming = async (base, cookie, page, extra = {}) => postForm(pageUrlOf(base, NUMBER_A), cookie, {
  action: SCAN_WRITE.actions.submitOrder,
  submit_key: submitKeyOf(page.html),
  payment_status: PAYMENT_STATUS.unpaid,
  ...extra,
});

test('AC-E2E-16 ⭐ 提交链路**逐步耗时**：一条 `scan.sale.timing` 带出每一段（含排队等待）', async () => {
  login();
  // 每一趟"飞书调用" 60ms（线上量级：一次 API 往返几百 ms；这里取小值只为让用例快）。
  const gateway = withLatency(createFakeGateway(), 60);
  const e2e = createE2E(gateway);
  const cookie = sessionCookie('ou_e2e_timing');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const startedAt = Date.now();
      const callsBefore = gateway.calls.length;
      const { value: response, entries } = await captureInfo(
        () => submitOnceForTiming(base, cookie, page),
      );
      const wallMs = Date.now() - startedAt;
      // ⚠️ 只算**这一趟提交**打出去的飞书调用（GET 渲染那几趟不算进来）。
      const submitCalls = gateway.calls.slice(callsBefore);
      assert.equal(response.status, 200, `提交要成（${response.status}）`);
      const timing = entries.filter((entry) => entry.event === SCAN_WRITE.events.saleTiming).pop();
      assert.ok(timing, '必须打出一条 scan.sale.timing（"一查日志就知道卡在哪一步"）');
      for (const key of TIMING_KEYS) {
        assert.equal(typeof timing[key], 'number', `timing 里要有数字 ${key}`);
      }
      assert.equal(timing.ok, true);
      assert.ok(submitCalls.length > 0, '这一趟提交至少要打一次飞书');
      assert.ok(timing.master_ms > 0, `建主表那一段要能量出来（假网关每趟 60ms）：${timing.master_ms}`);
      assert.ok(timing.detail_ms > 0, `明细/收款那一段要能量出来：${timing.detail_ms}`);
      // 分段之和**不许超过**这一趟的墙钟（分段是墙钟的子集；差值 = 本文件没打点的零头 + 渲染）。
      const parts = timing.queue_wait_ms + timing.lookup_ms + timing.prepare_ms
        + timing.master_ms + timing.status_ms + timing.detail_ms + timing.stock_ms;
      assert.ok(parts <= timing.submit_ms + 80,
        `分段之和(${parts}ms) 不该超过 submit_ms(${timing.submit_ms}ms) + 打点零头`);
      assert.ok(timing.submit_ms <= wallMs + 80, 'submit_ms 是墙钟的一部分');
      // 打印逐步耗时（人看的报告；这也是"改前/改后"对照的原始数据）。
      const rows = [
        ['lookup(取商品)', timing.lookup_ms], ['queue_wait(排队)', timing.queue_wait_ms],
        ['prepare(会话+校验)', timing.prepare_ms], ['master(建主表)', timing.master_ms],
        ['status(确认状态)', timing.status_ms], ['detail(明细/收款)', timing.detail_ms],
        ['stock(交付/扣库存)', timing.stock_ms],
      ];
      // eslint-disable-next-line no-console
      const byTable = {};
      for (const call of submitCalls) {
        const key = `${call.name}:${call.table}`;
        byTable[key] = (byTable[key] || 0) + 1;
      }
      const byCaller = {};
      for (const call of submitCalls) {
        const key = `${call.caller} → ${call.name}:${call.table}`;
        byCaller[key] = (byCaller[key] || 0) + 1;
      }
      process.stdout.write('\n  ── 谁打的（按文件归因）──\n'
        + Object.entries(byCaller).sort((a, b) => b[1] - a[1])
          .map(([key, count]) => `  ${key}: ${count}次`).join('\n') + '\n');
      process.stdout.write(`\n【逐步耗时】submit_ms=${timing.submit_ms}ms wall=${wallMs}ms 飞书调用=${submitCalls.length}次 峰值并发=${gateway.maxConcurrent()}\n`
        + rows.map(([label, ms]) => `  ${label}: ${ms}ms`).join('\n')
        + '\n  ── 每一趟飞书调用按表统计 ──\n'
        + Object.entries(byTable).sort((a, b) => b[1] - a[1])
          .map(([key, count]) => `  ${key}: ${count}次`).join('\n') + '\n');
    });
  } finally { e2e.cleanup(); }
});

test('AC-E2E-17 ⭐ 排队等待看得见：**同一把键连点两次**时第二次几乎不等（幂等短路）', async () => {
  login();
  const gateway = withLatency(createFakeGateway(), 40);
  const e2e = createE2E(gateway);
  const cookie = sessionCookie('ou_e2e_timing_replay');
  try {
    await withServer(e2e.app, async (base) => {
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const first = await captureInfo(() => submitOnceForTiming(base, cookie, page));
      const firstTiming = first.entries.filter((e) => e.event === SCAN_WRITE.events.saleTiming).pop();
      const second = await captureInfo(() => submitOnceForTiming(base, cookie, page));
      const secondTiming = second.entries.filter((e) => e.event === SCAN_WRITE.events.saleTiming).pop();
      assert.equal((await second.value.text()) && second.value.status, 200);
      assert.ok(firstTiming && secondTiming, '两次都要有 scan.sale.timing');
      assert.equal(secondTiming.reused, true, '第二次 = 重放（不许再写一遍）');
      assert.equal(secondTiming.detail_ms, 0, '重放**一次飞书写都不该打**（detail 段为 0）');
      assert.equal(secondTiming.master_ms, 0, '重放不该再建主表');
      assert.ok(secondTiming.submit_ms < firstTiming.submit_ms,
        `重放要明显快于首次（第二次 ${secondTiming.submit_ms}ms vs 首次 ${firstTiming.submit_ms}ms）`);
      // eslint-disable-next-line no-console
      process.stdout.write(`\n【幂等对照】首次 submit_ms=${firstTiming.submit_ms}ms / 重放 submit_ms=${secondTiming.submit_ms}ms\n`);
    });
  } finally { e2e.cleanup(); }
});

// ⭐⭐ 2026-10-12 (b) 提速：**改前 / 改后 逐步耗时对照**（同一份代码，只切"只读引用缓存"这一档）
/** 一趟提交的飞书调用数 / 分阶段耗时（可指定编号与尺码）。 */
const measureOneSubmit = async (base, gateway, cookie, number, size) => {
  await getPage(pageUrlOf(base, number), cookie);
  await addLine(base, cookie, number, size);
  const page = await getPage(pageUrlOf(base, number), cookie);
  const callsBefore = gateway.calls.length;
  const { value: response, entries } = await captureInfo(async () => postForm(pageUrlOf(base, number), cookie, {
    action: SCAN_WRITE.actions.submitOrder,
    submit_key: submitKeyOf(page.html),
    // 下单时把这一双一起带进来（选尺码 + 提交两下）。
    size,
    payment_status: PAYMENT_STATUS.unpaid,
    payment_method: '', payment_amount: '', line_amount: [''],
  }));
  const timing = entries.filter((entry) => entry.event === SCAN_WRITE.events.saleTiming).pop();
  assert.ok(timing, '要有一条 scan.sale.timing');
  const calls = gateway.calls.slice(callsBefore);
  return {
    status: response.status,
    calls,
    timing,
    byTable: calls.reduce((acc, call) => {
      const key = `${call.name}:${call.table}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  };
};

/**
 * ⭐ 改前 / 改后对照：**同一个进程里连着提交两单**（她连续扫码的真实用法）。
 * 第 1 单把只读引用读一遍（冷缓存），第 2 单才是"缓存生效"的那一单 ——
 * 拿第 2 单的飞书调用数比，才是只读缓存真正省下来的。
 */
const measureTwoSubmits = async (writeOptions, openId) => {
  const gateway = withLatency(createFakeGateway(), 40);
  const e2e = createE2E(gateway, writeOptions);
  const cookie = sessionCookie(openId);
  try {
    return await withServer(e2e.app, async (base) => {
      const first = await measureOneSubmit(base, gateway, cookie, NUMBER_A, '40');
      const second = await measureOneSubmit(base, gateway, cookie, NUMBER_B, '41');
      return { first, second };
    });
  } finally { e2e.cleanup(); }
};

test('AC-E2E-18 ⭐ 提速对照：**只读引用缓存**开 / 关（连续提交两单 ⇒ 看第 2 单）', async () => {
  login();
  const off = await measureTwoSubmits({ readCache: false }, 'ou_e2e_cache_off');
  const on = await measureTwoSubmits({}, 'ou_e2e_cache_on');
  assert.equal(off.first.status, 200);
  assert.equal(off.second.status, 200);
  assert.equal(on.first.status, 200);
  assert.equal(on.second.status, 200);
  // 对照用"第 2 单"（第 1 单是冷缓存，两边一样）。
  const before = off.second;
  const after = on.second;
  // ⚠️ 这条 E2E 的"交付"是**本文件自己注入**的（用原始网关，免得测试往 server/data 落库存文件）
  //    ⇒ 交付那一段的引用读**不经过**写服务的只读缓存。
  //    所以这里**不**断言"E2E 调用数一定变少"（那是夹具的限制，不是产品行为）；
  //    只读缓存的**去重效果**由单元用例 `scanWriteReadCache.test.js` 直接钉。
  //    这里钉的是**红线**：缓存**不许**碰到任何写入判据。
  // 🔴 写与"写入判据"那几张表**一次都不许少**（缓存碰不到它们 —— 这条就是红线哨兵）。
  for (const key of ['update:salesEntry', 'listAll:salesDetail', 'listAll:paymentRecord',
    'listAll:liveInventory', 'create:salesEntry', 'create:salesDetail', 'delete:liveInventory']) {
    assert.equal(after.byTable[key] || 0, before.byTable[key] || 0,
      `${key} 的次数必须与改前**逐字相同**（只读缓存不许影响写入判据）`);
  }
  const delta = before.timing.submit_ms - after.timing.submit_ms;
  // eslint-disable-next-line no-console
  process.stdout.write('\n【提速对照（假网关每趟 40ms；连续两单，看**第 2 单**）】\n'
    + `  改前（冷/热）：第1单 飞书 ${off.first.calls.length} 次 / 第2单 飞书 ${before.calls.length} 次`
    + `｜第2单 submit_ms=${before.timing.submit_ms}ms`
    + `（master ${before.timing.master_ms} / status ${before.timing.status_ms} / detail ${before.timing.detail_ms} / stock ${before.timing.stock_ms}）\n`
    + `  改后（冷/热）：第1单 飞书 ${on.first.calls.length} 次 / 第2单 飞书 ${after.calls.length} 次`
    + `｜第2单 submit_ms=${after.timing.submit_ms}ms`
    + `（master ${after.timing.master_ms} / status ${after.timing.status_ms} / detail ${after.timing.detail_ms} / stock ${after.timing.stock_ms}）\n`
    + `  ⇒ 只读引用缓存省下：飞书 ${before.calls.length - after.calls.length} 次 / submit_ms ${delta >= 0 ? '少' : '多'} ${Math.abs(delta)}ms`
    + '（⚠️ 本夹具自己注入了交付实例，交付那段的引用读没走缓存 ⇒ 省下的只是"写服务这一侧"的）\n');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她拍板 · 方案 A，逐字）：「**提交完 ⇒ 自动回首页，而首页 = 销售页** ✓」
//   AC-SR1 提交成功 ⇒ 成功页里**自动跳转目标 = 销售领域的扫码首页**（服务端渲染的**确定 URL**，逐字）
//   AC-SR2 【返回扫码】的 href 与自动跳转目标**逐字相同**（唯一来源 ✓）
//   AC-SR3 **先看到结果**：成功页首屏就有单号（不许秒跳吞掉 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SR1/SR2/SR3 销售提交成功 ⇒ 自动回**销售**首页（URL 确定 + 按钮同 URL + 首屏有单号）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_e2e_success_return');
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const response = await submitOnceForTiming(base, cookie, page);
      assert.equal(response.status, 200, `提交要成（${response.status}）`);
      const html = await response.text();
      const meta = html.match(/<meta http-equiv="refresh" content="(\d+);url=([^"]+)">/);
      assert.ok(meta, `成功页要有"自动回首页"（服务端渲染的确定 URL）：${html.slice(0, 200)}`);
      // ⭐⭐ 2026-10-13 **口径变更**（她的原话：「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，
      //   **应该就跟这一单没关系了**，除非我是选"**再加一双**"呀」）：
      //   目标从"她扫的那一页（`/s/<编号>` ✗ 还带着这一单）"改成 **不带编号的销售首页**（`/s/` ✓）+
      //   带 `?done=<单号>`（首页据此显示"上一单已提交" ✓ 无状态）
      const target = new URL(meta[2], 'http://x');
      assert.equal(target.pathname.replace(/\/$/, ''), '/s',
        `自动跳转目标要落在**不带编号的销售首页**（实际 ${meta[2]}）`);
      assert.equal(target.searchParams.get('from'), null, '销售首页不带 ?from=（与这一单无关 ✓）');
      assert.ok(Number(meta[1]) >= 1, `要先让她看到结果再跳（实际 ${meta[1]}s）`);
      const link = html.match(/<a class="btn" data-view="success-return" href="([^"]+)">/);
      assert.ok(link, '还要有一颗【返回扫码】兜底');
      assert.equal(link[1], meta[2], '按钮 href 与自动跳转目标**必须同一个 URL**（唯一来源 ✓）');
      // 首屏就有结果（单号）——不会被"秒跳"吞掉 ✓
      assert.match(html, /XSD-/, '成功页里要有单号（结果先显示 ✓）');
    });
  } finally { e2e.cleanup?.(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她拍板，逐字）：「扫 16 ⇒ 补货 ⇒ 提交 ⇒ 继续扫 ⇒ **自动还是补货** … 中途想卖货 ⇒ 点一下【销售】」
//   口径：**裸扫**（标签码不带 `?from=`）时用她**最近用过**的领域；显式 `?from=` 永远优先；
//        从没记过 ⇒ 仍是缺省**销售**（既有口径不回归 ✓）；**只在写成功时记**（看一眼不算 ✓）。
//
//   AC-RF1 记得住：记过「补货」⇒ 裸扫落在**补货**
//   AC-RF2 显式优先：`?from=sales` 覆盖记忆 ⇒ 落**销售**
//   AC-RF3 没记忆 ⇒ 仍落**销售**（既有缺省 ✓）
//   AC-RF4 只写成功才记：真提交一次销售 ⇒ 会话 `last_realm = sales`（并且成功页照旧回销售首页 ✓ AC-SR）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RF1 记过「补货」⇒ **裸扫**（不带 ?from=）落在补货领域', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const openId = 'ou_e2e_realm_1';
      const cookie = sessionCookie(openId);
      // ① 先证明"写进去了"（⚠️ 不证这一步就会把 AC 写成"没记忆却怪读不到" ✗）
      await e2e.sessions.setLastRealm(openId, 'replenish');
      assert.equal((await e2e.sessions.get(openId)).last_realm, 'replenish', '记忆要真写上');
      // ② ⚠️ 必须是**真·裸扫**：`pageUrlOf` 永远带 `?from=sales` ⇒ 那条不算裸扫 ✗
      //    （我第一版就是这么写错的：显式 from 优先 ⇒ 当然落回销售 ⇒ 假红）
      const { html } = await getPage(`${base}/s/${encodeURIComponent(NUMBER_A)}`, cookie);
      assert.ok(html.includes('realm-block--replenish'),
        '她上次在补货里干过活 ⇒ 裸扫要**自动还是补货**（她的原话 ✓）');
      assert.equal(html.includes('realm-block--sales'), false, '不该落回销售');
    });
  } finally { e2e.cleanup(); }
});

test('AC-RF2 显式 `?from=sales` ⇒ 以它为准（记忆不覆盖显式）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const openId = 'ou_e2e_realm_2';
      const cookie = sessionCookie(openId);
      await e2e.sessions.setLastRealm(openId, 'replenish');
      const { html } = await getPage(`${pageUrlOf(base, NUMBER_A)}&from=sales`, cookie);
      assert.ok(html.includes('realm-block--sales'), '她点【销售】⇒ 必须听她的（随时随地能切 ✓）');
      assert.equal(html.includes('realm-block--replenish'), false, '显式覆盖记忆 ✓');
    });
  } finally { e2e.cleanup(); }
});

test('AC-RF3 从来没记过 ⇒ 仍落缺省**销售**（既有口径不回归）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_e2e_realm_3');
      const { html } = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.ok(html.includes('realm-block--sales'), '从没记过 ⇒ 销售（既有缺省 ✓）');
    });
  } finally { e2e.cleanup(); }
});

test('AC-RF4 只在**写成功**时记：真提交一次销售 ⇒ 会话 last_realm = sales', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const openId = 'ou_e2e_realm_4';
      const cookie = sessionCookie(openId);
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const response = await submitOnceForTiming(base, cookie, page);
      assert.equal(response.status, 200, '提交要成');
      // ⚠️ 记领域是**写完才发生**（fire-and-forget）⇒ 给事件循环一拍再读
      await new Promise((resolve) => setTimeout(resolve, 50));
      const session = await e2e.sessions.get(openId);
      assert.equal(session.last_realm, 'sales', `写成功要记下领域（实际 ${session.last_realm}）`);
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她拍板）：**三路成功页都自动回**——销售/补货/退货 ⇒ 【销售】扫码页；
//   验收 ⇒ 【未到货批次列表】（选项 ① ✓）；两类都在 `SUCCESS_RETURN` 里区分（一处改 ✓）。
//
//   AC-SR4 接线哨兵：三路成功 payload 都走**同一个** `successReturnFields(...)`（不各写一遍 ✗）
//   AC-SR5 验收成功页：自动跳转目标 = **未到货批次列表** · 返回按钮**同一 URL** · 首屏有实际数量/金额
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SR4 接线哨兵：销售/补货/退货三路都走同一个 successReturnFields（唯一来源 ✓）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  // ⚠️ 只数**调用**（定义那行是 `const successReturnFields = (req, target)` ⇒ 带空格，不被这个正则算进来 ✓）
  const calls = source.match(/successReturnFields\(/g) || [];
  assert.equal(calls.length, 3, `三路（销售 / 补货 / 退货）都要接上（实际 ${calls.length} 处调用）`);
  for (const anchor of ['scan_sale_submitted', 'scan_replenish_submitted', 'scan_purchase_return_submitted']) {
    const at = source.indexOf(anchor);
    assert.ok(at > -1, `${anchor} 那一段要在`);
    assert.ok(source.slice(at, at + 400).includes('markRealmUsed('), `${anchor} 之后要记住领域`);
  }
  const cfg = fs.readFileSync(path.join(__dirname, '../src/config/scanPage.js'), 'utf8');
  assert.match(cfg, /homeRealm: 'sales'/, '三路回销售（她的口径）');
  assert.match(cfg, /acceptHome: 'pendingBatches'/, '验收回未到货批次列表（她 ① ✓）');
});

test('AC-SR5 验收成功页：自动回**未到货批次列表** + 按钮同 URL + 首屏有实际数量/金额', async () => {
  const { renderAcceptanceDonePage } = require('../src/views/scanPageRenderer');
  const { SCAN_PAGE } = require('../src/config/scanPage');
  const { SCAN_WRITE } = require('../src/config/scanWrite');
  const backHref = '/s/accept';
  const html = renderAcceptanceDonePage({
    config: SCAN_PAGE,
    write: { texts: SCAN_WRITE.texts },
    acceptance: { batchNo: 'CGD-20261012-0009', scanned: 5, amountText: '10' },
    backHref,
    returnPath: backHref,
    returnLabel: SCAN_PAGE.successReturn.label,
    returnDelaySeconds: SCAN_PAGE.successReturn.delaySeconds,
    autoReturnUrl: backHref,
  });
  const meta = html.match(/<meta http-equiv="refresh" content="(\d+);url=([^"]+)">/);
  assert.ok(meta, '要自动回（服务端确定 URL）');
  assert.equal(meta[2], '/s/accept', '验收 ⇒ 未到货批次列表（选项 ① ✓ 别"顺手统一"改掉 ✗）');
  const link = html.match(/<a class="btn" data-view="success-return" href="([^"]+)">/);
  assert.ok(link, '要有一颗【返回扫码】兜底');
  assert.equal(link[1], meta[2], '按钮 href 与自动跳转**同一 URL** ✓');
  assert.match(html, /实际数量 5/, '首屏就有实际数量（不被秒跳吞掉 ✓）');
  assert.match(html, /实际金额 10/, '首屏就有实际金额 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她真机：`POST /MK31-1|咖色|B` ⇒ **400 / 1ms**、周围**零日志** ✗
//   页面提示「这一页上的按钮我认不出来（可能放太久了）」—— 页面才渲染 41 秒 ⇒ **不是放太久** ✗）
//
//   ⚠️ 写法教训（我踩过）：**日志不能靠"补 `console.log`/`process.stdout.write`"来断言** ✗
//     —— `utils/logger` 在**模块加载时**就把 sink 绑死了：`logInfo` 走 `console.log`、`logWarn` 走
//     另一个已绑定的 writer ⇒ 后打的补丁**收不到**（我因此得出过"日志没打"的**错误结论** ✗）。
//     所以这几条 AC 断言**可观测的行为**（她看到的人话）+ **源码哨兵**（那条 warn 的字段）✓
//
//   AC-UA1 缺 action ⇒ 400 + 人话「这一页没带上要做什么」· AC-UA2 空 action ⇒ 同一句
//   AC-UA3 认不出的 action ⇒ 原句「按钮我认不出来」（**不再说"可能放太久了"** ✗）
//   AC-UA4 源码哨兵：那条 warn 带 `action_kind`（missing/blank/unrecognized 三分）
//                    + **只打字段名**（`body_keys`），**不打 body 的值** ✗
//   AC-UA5 ⭐ 页面上的 POST 表单**每一张都带 hidden action**（她那条 400 的可能根因 ⇒ 查过：没有 ✓）
// ═══════════════════════════════════════════════════════════════════════════

const htmlTextOf = async (response) => String(await response.text()).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('AC-UA1 缺 action ⇒ 400 + 人话「这一页没带上要做什么」（不是"可能放太久了"✗）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const response = await postForm(pageUrlOf(base, NUMBER_A), sessionCookie('ou_ua_1'), { size: '40' });
      assert.equal(response.status, 400, '认不出来 ⇒ 400');
      const text = await htmlTextOf(response);
      assert.ok(text.includes(SCAN_WRITE.texts.unknownActionMissingBody),
        `缺 action 要给"没带上要做什么"：${text.slice(0, 200)}`);
      assert.equal(text.includes('可能放太久了'), false, '那句误导的话要删掉 ✗');
    });
  } finally { e2e.cleanup(); }
});

test('AC-UA2 空 action ⇒ 同一句人话（blank 与 missing 同一出口）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const response = await postForm(pageUrlOf(base, NUMBER_A), sessionCookie('ou_ua_2'), { action: '' });
      assert.equal(response.status, 400);
      assert.ok((await htmlTextOf(response)).includes(SCAN_WRITE.texts.unknownActionMissingBody));
    });
  } finally { e2e.cleanup(); }
});

test('AC-UA3 认不出的 action ⇒ 保留原句（且不再说"放太久了"）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const response = await postForm(pageUrlOf(base, NUMBER_A), sessionCookie('ou_ua_3'), { action: 'no_such_action' });
      assert.equal(response.status, 400);
      const text = await htmlTextOf(response);
      assert.ok(text.includes(SCAN_WRITE.texts.unknownActionBody), '认不出 ⇒ 原句');
      assert.equal(text.includes('可能放太久了'), false, '误导那句要删掉 ✗');
    });
  } finally { e2e.cleanup(); }
});

test('AC-UA4 源码哨兵：那条 warn 三分 action_kind + **只打字段名**（不打 body 的值 ✗）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.match(source, /action_kind: kind/, '要带 action_kind');
  assert.match(source, /raw === undefined \? 'missing'/, "缺 action ⇒ 'missing'");
  assert.match(source, /'blank'/, "空 action ⇒ 'blank'（与 missing 分开 ✓）");
  assert.match(source, /'unrecognized'/, "认不出 ⇒ 'unrecognized'");
  assert.match(source, /body_keys: Object\.keys\(body\)/, '只打字段名 ✓');
  assert.equal(/body_keys[\s\S]{0,40}\.\.\.body/.test(source), false, '不许把 body 整个铺进日志 ✗');
  const cfg = fs.readFileSync(path.join(__dirname, '../src/config/scanWrite.js'), 'utf8');
  assert.match(cfg, /unknownWriteAction: 'scan\.write\.unknown_action'/, '事件名走配置 ✓');
});

test('AC-UA5 ⭐ 页面上的 POST 表单**每张都带 hidden action**（她那条 400 的可能根因）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_ua_5');
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const realms = ['sales', 'replenish', 'purchase_return', 'accept', 'inventory', 'product'];
      for (const realm of realms) {
        const { html } = await getPage(pageUrlOf(base, NUMBER_A, realm), cookie);
        const forms = html.match(/<form[\s\S]*?<\/form>/g) || [];
        for (const form of forms) {
          if (!/method="post"/.test(form)) continue;
          // ⚠️ 打印那颗【打印这一款】的表单：action 挂在**按钮**上，且被打印线的哨兵**逐字钉着**
          //    （只有一段脚本 / 隐藏字段来自配置）⇒ **不动它** ✓；它也不属于"她提交按钮的写操作"那条路 ✓
          if (form.includes('label-print-form')) continue;
          assert.ok(/name="action"/.test(form),
            `${realm} 领域有一张 POST 表单**没带 action** ⇒ 点它必然 400 ✗：${form.slice(0, 160)}`);
          // ⭐ 2026-10-12：每张**写表单**还要带"这一页是哪一版渲染的"（她那次 400 是不是旧页面 ✓）
          assert.ok(new RegExp(`name="page_build" value="${SCAN_PAGE.pageBuild.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(form),
            `${realm} 领域的写表单要带当前构建标识（实际 pageBuild=${SCAN_PAGE.pageBuild}）：${form.slice(0, 160)}`);
        }
      }
    });
  } finally { e2e.cleanup(); }
});

test('AC-UA6 源码哨兵：warn 里带 page_build（缺失标 missing / 不一致标 stale）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.match(source, /page_build: String\(body\[config\.pageBuildField/, '要读页面带回的构建标识');
  assert.match(source, /\|\| 'missing'/, "旧页面/手改表单（没带该字段）⇒ 标 'missing'（正是要抓的 ✓）");
  assert.match(source, /page_build_stale:/, '与当前构建不一致 ⇒ 标 stale');
  const cfg = fs.readFileSync(path.join(__dirname, '../src/config/scanPage.js'), 'utf8');
  assert.match(cfg, /pageBuild: PAGE_BUILD/, '构建标识走 config（一处定义 ✓）');
  assert.match(cfg, /APP_COMMIT/, '带 commit（发版窗口里能分辨新旧 ✓）');
});

test('AC-UA7 渲染层：每个写表单的 action 后面**只加**一个 page_build（既有语义不动 ✓）', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
  const fields = (renderer.match(/\$\{pageBuildField\(\)\}/g) || []).length;
  // ⚠️ 2026-10-13 **改写**（能力退场）：原来是 8 处（含**配品表单**那一处）——
  //    她的口径是「扫码页里的**配品逻辑拿掉**」（配品改到工作台）⇒ 配品表单整块退场
  //    ⇒ 现在 **7 处**（鞋表单 + 提交表单 + 其余写入口 ✓）。口径没变：**每个写表单只加一个** ✓
  assert.equal(fields, 7, `配品表单退场后是 7 处（实际 ${fields} 处）`);
  assert.match(renderer, /const pageBuildField = \(\) => hiddenField\(\n\s*SCAN_PAGE\.pageBuildField/, '字段名走 config ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 🔴 2026-10-12（她真机：`POST /s/MK31-1|咖色|B` ⇒ 400 / 1ms，`scan.write.unknown_action`
//   且 `action_kind=missing`，而 `body_keys` 里**该带的都带了** ⇒ 唯独没有 action ✗）
//   ⇒ 那是"**没有提交者的提交**"（webview 里 JS/回车/隐式提交 ⇒ 浏览器不送按钮 name/value ✗）
//   AC-ACT1 真提交（**故意不带 action**）⇒ 服务端**窄化兜底**认出"提交这一单" ⇒ 建单成功（她不被卡 ✓）
//   AC-ACT2 两处计数**故意不同**（不是 bug）：本单条数 vs "这一下要提交的那一双" ✓
// ═══════════════════════════════════════════════════════════════════════════
test('AC-ACT1 🔴 不带 action 的真提交 ⇒ 窄化兜底认出"提交这一单"（她不再被卡）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_act_1');
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const response = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid,
        size: '40',
        amount: '399',
      });
      assert.equal(response.status, 200, `要能建单（实际 ${response.status}）`);
      const html = await response.text();
      assert.match(html, /XSD-/, '成功页要带单号（她那次是 400 ✗）');
      assert.equal(html.includes('按钮我认不出来'), false, '不该再出现"按钮认不出来" ✗');
    });
  } finally { e2e.cleanup(); }
});

test('AC-ACT2 ⭐ 两处计数**故意不同**（不是 bug）：本单条数 vs 这一下要提交的那一双', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_act_2');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.ok(page.html.includes(SCAN_PAGE.texts.draftBarCount.replace('{count}', '0')), '空本单：本单条写 0 双 ✓');
      assert.match(page.html, /✅ 提交这一单（1 双）/, '空本单：按钮写"这一双" ✓（既有 AC-E2E-17 钉的设计 ✓）');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她："领域/批次**要点 4、5 次**才切换、跳转" + "我想查我点了几次"）
//   AC-TAP1 点击即时反馈（附加式）：领域条/批次行带 `data-tap-target` + `data-open-label`（配置文案）+ CSS :active
//           ⚠️ **脚本段数 ≤ 1**（并进既有那段 ✓ 绝不新增第二段 ✗）
//   AC-TAP2 埋点：`POST /<prefix>/ui-tap?target=…` ⇒ 204；缺 target ⇒ 400；**不采集任何值**（只有 target/page）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-TAP1 ⭐ 点击即时反馈：钩子 + 配置文案 + CSS :active + **脚本仍只有一段**', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_tap_1');
      const { html } = await getPage(pageUrlOf(base, NUMBER_A, 'replenish'), cookie);
      const label = SCAN_PAGE.tapFeedback.label;
      const tabs = html.match(/<a class="realm-tab[^>]*data-tap-target="realm:[^"]*"[^>]*data-open-label="[^"]*"/g) || [];
      assert.ok(tabs.length >= 2, `领域条要带钩子（实际 ${tabs.length} 颗）`);
      assert.ok(tabs.every((t) => t.includes(label)), '文案来自配置 ✓');
      // ⚠️ 这个 harness 里 `/s/accept` **没有未到货批次**（空态渲染 ✗）⇒ 批次行改断言**渲染层源码**
      //    （真页面那条我在真启动里用 `acceptLandingSelfServe` 那套页面验过 ✓）
      const rendererSrc = require('node:fs').readFileSync(
        require('node:path').join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8',
      );
      assert.match(rendererSrc, /data-tap-target="batch:/, '批次行要带钩子 ✓');
      assert.match(html, /\.realm-tab:active[^{]*\{[^}]*opacity/, 'CSS :active 要有（按住即变淡 ✓ 零脚本 ✓）');
      const scripts = html.match(/<script[\s>]/gi) || [];
      assert.ok(scripts.length <= 1, `**不许新增脚本**（实际 ${scripts.length} 段 ✗）`);
      assert.ok(/navigator\.sendBeacon/.test(html), '同一段脚本里要有上报（keepalive ✓）');
    });
  } finally { e2e.cleanup(); }
});

test('AC-TAP2 埋点端点：target 必填 ⇒ 204；缺 target ⇒ 400；**只有 target/page，没有值** ✗', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const post = (qs) => fetch(`${base}/s/ui-tap${qs}`, { method: 'POST', headers: { cookie: sessionCookie('ou_tap_2') } });
      assert.equal((await post('?target=realm%3Areplenish&page=scan')).status, 204, '正常上报 ⇒ 204');
      assert.equal((await post('?target=batch%3ACGD-1&page=accept')).status, 204, '批次点击也能报');
      assert.equal((await post('')).status, 400, '没有 target ⇒ 400（不静默吞 ✓）');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（Lead 核日志的两个可观测性缺口）
//   AC-QK1 `http.request.completed` 要带 **`query_keys`（只有键名，没有值 ✗）** ⇒ 才数得出她切了几次领域
//   AC-PT1 `/accept`（批次列表页）要有**分段耗时** `scan.accept.pending_timing`（她点 4、5 次才过去 ✗）
//   ⚠️ 这两条用**源码哨兵**（日志的 sink 在模块加载时绑死 ⇒ 用例里拦不到 warn/info ✗ 我踩过）
//     —— 真实证据在报告里（真服务器的日志原文 ✓）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-QK1 源码哨兵：请求日志带 `query_keys`（**只有键名**，值不出现 ✗）', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.match(appSrc, /query_keys: Object\.keys\(req\.query \|\| \{\}\)/, '要打键名列表');
  assert.equal(/query_keys[\s\S]{0,60}req\.query\b(?! \|\| \{\}\))/.test(appSrc), false, '不许把 query 的值铺进日志 ✗');
});

test('AC-PT1 源码哨兵：/accept 自助页打 `scan.accept.pending_timing`（分段耗时，只加打点 ✗）', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.match(route, /config\.events\.pendingTiming/, '要打那条汇总');
  assert.match(route, /pendingTiming\.render_ms = /, '要有渲染段');
  assert.match(route, /loadPendingBatches\(requestId, pendingTiming\)/, '取批次那一段要量');
  const svc = fs.readFileSync(path.join(__dirname, '../src/services/scanArrivalService.js'), 'utf8');
  assert.match(svc, /pendingBatches = async \(\{ timing = null \} = \{\}\)/, '取数支持 timing 出参（逻辑零改动 ✓）');
  assert.match(svc, /batches_ms/, '要有读表那一段');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-13（她真机："我开新单子的时候，系统会挂一个 86900" ✗）
//   只读复现结论：**草稿确实清了**（0 双 ✓）、`no-store` 在 ✓、"未交付"零逻辑命中 ✓
//   ⇒ 最贴症状的机制：提交成功后自动回跳 = **`/s/<她刚提交的那个编号>`** ⇒ 页面标题/上下文
//     仍是上一单那个产品（86900）✗ ⇒ 她要的 ⓑ：**顶部给一条明确指引**（上一单已提交 + 单号 + 请扫下一个标签）
//   AC-B1（行为）真提交 ⇒ 成功页回跳 URL 带 `?done=<单号>` ⇒ 打开它 ⇒ 顶部指引**逐字**含那个单号 + 本单 0 双
//   AC-B2（回归）没有 `done` 的普通访问 ⇒ **不出现**那条指引 ✓
// ═══════════════════════════════════════════════════════════════════════════


test('AC-B2 回归：没有 `done` 的普通访问 ⇒ **不出现**那条指引', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_notice_2');
      const fresh = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.equal(fresh.html.includes('data-view="just-submitted"'), false, '新会话/新编号页不该有指引 ✗');
      // ⭐ 2026-10-13：提示已搬到**销售首页**（ⓑ 并入 ⓐ ✓）⇒ 没有 `done` 的首页也不该有它 ✓
      const home = await getPage(`${base}/s`, cookie);
      assert.equal(home.html.includes('data-view="sales-home-submitted"'), false, '首页没有 done ⇒ 不显示提示 ✗');
    });
  } finally { e2e.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-13（她的口径，逐字）：「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，
//   **应该就跟这一单没关系了**，除非我是选"**再加一双**"呀」
//   ⇒ **两条必须严格分开**：提交 ⇒ 与这一单无关（页面**不带任何货号** ✗）；
//     「继续再加一双」⇒ 同一单里继续加行 ✓（这才是唯一"与这一单有关"的入口）
//   ⇒ ⓐ：**新建"不带编号的销售首页"**（`GET /s` = 领域入口页 ✓），提交后回跳它 ✓
//   AC-H1 提交 ⇒ 落到**不带任何货号/编号**的销售首页 ✓
//   AC-H2 该页显示「上一单已提交（刚提交那一单的单号）」+「请扫下一个标签」✓（单号逐字 ✓）
//   AC-H3 ⭐ **回归（最关键）**：「继续再加一双」⇒ 仍在本单（同一 session / 同一单号 ✓）
//   AC-H4 直接访问编号页 ⇒ **不显示**"上一单已提交"（回归 ✓ 别把提示挂到所有页 ✗）
//   AC-H5 开新单 ⇒ 清单只有新扫的那一双（不含上一单任何行 ✓）
// ═══════════════════════════════════════════════════════════════════════════
const homeText = () => require('../src/config/scanPage').SCAN_PAGE.texts;

test('AC-H1/H2 ⭐ 「提交这一单」⇒ 落到**不带编号**的销售首页（含"上一单已提交（单号）"+请扫下一个标签）', async () => {
  login();
  const e2e = createE2E();
  const text = (s) => String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_home_1');
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const submitted = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: [''],
      });
      const sHtml = await submitted.text();
      const orderNo = (/XSD-[0-9-]+/.exec(sHtml) || [''])[0];
      assert.ok(orderNo, '成功页要有单号');
      const meta = (sHtml.match(/http-equiv="refresh"[^>]*url=([^">]+)/) || [])[1] || '';
      const noticeKey = require('../src/config/scanPage').SCAN_PAGE.successReturn.noticeKey || 'done';
      assert.ok(meta.includes(`${noticeKey}=${encodeURIComponent(orderNo)}`), `回跳要带单号标记（实际 ${meta}）`);
      const metaPath = meta.startsWith('http') ? new URL(meta).pathname + new URL(meta).search : meta;
      // ⭐ ① 落点是**不带编号**的销售首页（路径就是挂载前缀本身 ✓）
      assert.equal(new URL(`${base}${metaPath}`).pathname.replace(/\/$/, ''),
        new URL(`${base}/s`).pathname.replace(/\/$/, ''), '提交后要落在不带编号的销售首页 ✗');
      const home = await getPage(`${base}${metaPath}`, cookie);
      const body = text(home.html);
      // ⭐ ② 页面上**不出现任何编号/货号**（与上一单无关 ✓）
      assert.equal(home.html.includes(NUMBER_A), false, `销售首页不许带上一单的编号 ✗（${NUMBER_A}）`);
      assert.equal(home.html.includes(ITEM_A), false, `销售首页不许带任何货号 ✗（${ITEM_A}）`);
      assert.equal(home.html.includes('data-view="draft-bar"'), false, '销售首页不该有本单清单 ✗');
      // ⭐ ③ 单号逐字 + 请扫下一个标签
      assert.ok(body.includes(orderNo), `要显示刚提交那一单的单号 ${orderNo}`);
      assert.ok(body.includes(homeText().salesHomeTitle), `要有"${homeText().salesHomeTitle}"`);
      assert.ok(home.html.includes('data-view="sales-home"'), '要有明确的数据视图标记 ✓');
    });
  } finally { e2e.cleanup(); }
});

test('AC-H3 ⭐⭐ 回归（最关键）：「继续再加一双」⇒ **仍在本单**（同一 session / 同一单号）', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_home_3');
      await getPage(pageUrlOf(base, NUMBER_A), cookie);
      await addLine(base, cookie, NUMBER_A, '40');
      // 「继续再加一双」= 页面上的 addLine 动作（**同一单** ✓ 不换 session、不换单号 ✓）
      await addLine(base, cookie, NUMBER_A, '41');
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const bar = require('node:assert');
      assert.ok(/本单：2 双/.test(page.html), '再加一双要留在本单（2 双 ✓）');
      // 提交后**同一个 session** 里那一单只落一次、单号唯一 ✓
      const submitted = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: ['', ''],
      });
      const sHtml = await submitted.text();
      // ⚠️ 单号在成功页会出现多次（标题/正文/回跳标记 ✓）⇒ 断言**去重后只有一个** ✓
      const orders = new Set(sHtml.match(/XSD-[0-9-]+/g) || []);
      assert.equal(orders.size, 1, `同一单只允许一个单号（实际 ${[...orders].join(',')}）`);
    });
  } finally { e2e.cleanup(); }
});

test('AC-H4/H5 回归：编号页**不显示**"上一单已提交"；提交后开新单 ⇒ 清单只有新那一双', async () => {
  login();
  const e2e = createE2E();
  try {
    await withServer(e2e.app, async (base) => {
      const cookie = sessionCookie('ou_home_5');
      const fresh = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      assert.equal(fresh.html.includes(homeText().salesHomeTitle), false, '编号页不该显示"请扫下一个标签" ✗');
      assert.equal(fresh.html.includes(homeText().salesHomeJustSubmitted.replace('{orderNo}', '')), false,
        '编号页不该显示"上一单已提交" ✗（除非回跳带了标记 ✓）');
      // 提交一单
      await addLine(base, cookie, NUMBER_A, '40');
      let page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const subRes = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: submitKeyOf(page.html),
        payment_status: PAYMENT_STATUS.unpaid, payment_method: '', payment_amount: '', line_amount: [''],
      });
      const subHtml = await subRes.text();
      // ⭐⭐ **强化断言**（原来这里**忽略了提交结果** ✗ ⇒ 提交一旦没成，后面那条"新单只有 1 双"会**莫名其妙地红** ✗）：
      //   提交必须成功、并且**这一单已经结束**（草稿清空由上一条成功的提交保证 ✓）。
      assert.equal(subRes.status, 200, `提交必须成功（实际 ${subRes.status}）`);
      assert.match(subHtml, /XSD-[0-9-]+/, '成功页要有单号 ✓');
      // 开新单：扫另一个编号 ⇒ 清单**只有**新扫的那一双
      // ⚠️ 用**页面上的真 key**（真实页面就是这么发的 ✓）——
      //   原来用 helper 里的伪造 key `'unused-on-add'`：服务端会**接受并回 303 `?added=1`**，
      //   但会话**没落上**（2026-10-13 抓到的现场：`sale_status=submitted / lines=0` ✗）⇒ 偶发红 ✓
      const nbPage = await getPage(pageUrlOf(base, NUMBER_B), cookie);
      const addRes = await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        action: SCAN_WRITE.actions.addLine, submit_key: submitKeyOf(nbPage.html), size: '41',
      });
      page = await getPage(pageUrlOf(base, NUMBER_B), cookie);
      // ⭐⭐ 失败现场打印（**不是 retry、也没有放宽断言** ✗）：
      //   2026-10-13 这条在全量里偶发红过一次（同一提交连跑 10 次全绿、整文件 6 次全绿 ✗ 未复现），
      //   所以先把"失败那一刻的现场"打出来 ⇒ 下次一红就能直接定位根因（提交被 reuse？被限流？草稿没清？）。
      if (!/本单：1 双/.test(page.html)) {
        const bars = page.html.match(/本单：[0-9]+ 双/g) || [];
        const snap = await e2e.sessions.get('ou_home_5').catch(() => null);
        console.log('FLAKE-EVIDENCE 会话=', JSON.stringify(snap && {
          sale_status: snap.sale?.status, sale_lines: (snap.sale?.lines || []).length,
          sale_seq: snap.sale?.seq, sale_key: snap.sale?.key, completed: (snap.sale?.completed || []).length,
          session_status: snap.status,
        }));
        console.log('FLAKE-EVIDENCE 提交状态=', subRes.status,
          '| 单号=', (/XSD-[0-9-]+/.exec(subHtml) || [''])[0],
          '| addLine 状态=', addRes.status,
          '| addLine Location=', String(addRes.headers?.get?.('location') || ''),
          '| 本单条=', JSON.stringify(bars),
          '| 提交页有失败文案=', /没成功|认不出|没带上/.test(subHtml));
      }
      assert.ok(/本单：1 双/.test(page.html), '新单只有新扫的那一双（1 双 ✓）');
      assert.equal(page.html.includes(NUMBER_A), false, '新单里不许出现上一单的编号 ✗');
      assert.equal(page.html.includes(homeText().salesHomeJustSubmitted.replace('{orderNo}', '')), false,
        '新单页也不该有那条提示 ✗');
    });
  } finally { e2e.cleanup(); }
});


