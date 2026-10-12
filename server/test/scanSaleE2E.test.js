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
 * 一套"真的在跑"的 E2E：真 HTTP 路由 + 真读服务 + 真写服务 + 真建单 / 交付 / 库存引擎；
 * **只有飞书那一层**是内存替身。
 */
const createE2E = () => {
  const gateway = createFakeGateway();
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
      assert.match(doneHtml, /这一单提交好了/, '第3步：给她的是"提交好了"那一页');
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
      assert.match(firstHtml, /这一单提交好了/, '第1步：给她"提交好了"那一页');
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
      assert.match(secondHtml, /这一单提交好了/, '第2步：给她"提交好了"那一页');
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
      assert.match(doneHtml, /这一单提交好了/, '第4步：给她"提交好了"那一页');
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
      assert.match(html, /这一单提交好了/, '第1步：结果页说提交好了');

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
      assert.match(html, /这一单提交好了/, '文案：这一单提交好了');
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
      assert.match(html, /这一单提交好了/, '第2步：结果页说提交好了');
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
