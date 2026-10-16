/**
 * task-59「销售一单多货」—— **判据 AC-SM-A…F ＋ 上限**（先写判据 → 再跑 → 逐条对照 ✓）。
 *
 * ## ⭐ 本刀的性质（**下一个人别再误判** ✗）
 * **销售今天就已经有自己的一单多件机制**（只读核过 `main b7ba07e`）：
 * ```
 * 货品页【➕ 还要加一双】  action=add_line  →  writeService.addSaleLine  →  session.sale.lines
 * 货品页【✅ 提交这一单】  action=submit_order  →  资金页（一个字都不写业务表 ✗）
 * 资金页【提交整单付款 / 跳过】 payment_pay / payment_skip  →  既有 submitSale（读【全部】sale.lines ✓）
 * ```
 * ⇒ 本刀 = **给【销售货品页】补上那个"一单多货"入口 ＋「本单已加的货品」列表** ✓
 *   **不是**新建机制 ✗ · **不是**"销售不支持多件" ✗
 *
 * ## 🔴 Lead 2026-10-16 裁决 = **甲′**（逐字照做）
 * ```
 * 销售的 N 件**进既有的 `session.sale.lines`**（经**既有** `action=add_line` → `writeService.addSaleLine` ✓）
 *   ⇒ 再**落回今天的资金页**那条路 ⇒ **既有 `submitSale`** ✓
 *   ⇒ 渲染层：货品页加「＋ 再加一个货品」入口 ＋「本单已加的货品」列表 ✓
 *   ⇒ `config/multiItemOrder.js` 里加 `chains.sales` **只用来描述这条链的形状**（前缀/上限/文案 ✓）**不参与落库** ✓
 * 🔴 **不要**走 `submitMultiItemOrder` ✗ · **不要**改 `services/multiItemOrderService.js` ✗
 * 🔴 `scanWriteService.js` 一个字不许动 ✗ · 补货/退货**零变化** ✗ · **N=1 逐字不变** ✗ · 券/少付**零变化** ✗
 * ```
 *
 * ## ⭐ 只读核出来的**三条实现约束**（都不是猜，都有既有判据钉着 —— 落地时照这三条走 ✓）
 * 1. 🔴 **销售那一块不能复用 `multiItemBlockHtml`**：`test/multiItemOrderRender.test.js` 的 **AC-MIR1**
 *    （`:52-54`）把 `multiItemBlockHtml(write, view…)` 的**调用点数成"恰好 2"**（补货/退货各一处 ✓）
 *    ⇒ 销售那一块必须落在 **`views/scanPageRenderer.js` 的 `saleFormHtml`**（那里**本来就有**
 *    一颗 `action=add_line` 的 submit 与一张已加货品的表 ✓）。
 *    ⇒ ⭐ **"形状与补货一致"的可执行判据** = **同一份文案配置**（`config/scanPage.js` 的
 *      `MULTI_ITEM_RENDER_TEXTS.addButton` / `.title`，**零新增中文** ✓）＋ **同一个 `data-multi-add` 钩子** ✓。
 * 2. 🔴 **加货那颗必须是本表单里的 submit**（`<form method="post">` 里）——
 *    补货/退货那块今天那颗是 `<a href="…?add=1">`（**GET ⇒ 天生带不走**她刚填的尺码/金额 ✗，
 *    `scanPageRenderer.js:1357`）；销售这张表单本来就是 POST ⇒ 用它自己那颗既有 submit ✓。
 * 3. ⭐ **`chains.sales` 会落进 `test/multiItemOrderWriters.test.js` 的 AC-RT7b 遍历**
 *    （`for (const chain of Object.keys(cfg.chains))` ⇒ `writers[chains[chain].writer]` 必须是函数）——
 *    而 `multiItemWriters()` 在**冻结件** `scanWriteService.js` 里、**加不了 `sales` 这一支** ✗
 *    ⇒ 需要一次**成对迁移**（本仓既有机制：改前逐字 → 改后逐字 → 依据 ✓）且**只许更严**：
 *    纯描述链（`persists === false`）**不许**配写入口（反向钉 ✓）＋ **落库链集合**钉死 = `{replenish, return}` ✓。
 *
 * ## 判据（**先写先红 / 能真红**）
 * - **AC-SM-A** ⏳ 销售货品页出现「＋ 再加一个货品」入口 ＋「本单已加的货品」列表（**形状与补货一致** ✓）
 *   —— 今天**还没实现** ⇒ **待激活闸门**（**不假装通过** ✗；配探针证明检测器**真能红** ✓）
 * - **AC-SM-B** ⭐⭐ 填了首件的 **尺码 ＋ 金额** ⇒ 点「加货」⇒ 那两个值**在 `sale.lines` 里且逐字没变** ✓
 *   （`add_line` 那条老路**本来就把她刚填的一起带到** ⇒ 天然绿 ✓；但**丢了 / 串了 / 换位** ⇒ 红 ✓）
 * - **AC-SM-C** ⭐⭐ 走**既有** `addLine` / `submitSale`（引擎 0 次 ✗），且**逐件尺码 / 金额都对** ✓
 * - **AC-SM-D** ⭐⭐ **N=1 ⇒ 走今天那条老路 ＋ 资金页 ＋ 券判定参数逐字不变** ✓（改了就红 ✓）
 * - **AC-SM-E** ⭐ 多件时**少付 ⇒ 自动记未收款仍生效**（她 2026-10-16 裁的 A ✓）
 * - **AC-SM-F** ⭐ 补货 / 退货 / 库存**行为不变** ✓（含两个红线文件的**逐字节指纹** ✓）
 * - **AC-SM-LIMIT** 🔴 上限 = `SESSION.maxLines`（= **50**，配置 ✓）⇒ 超了**人话拦住 ＋ 零业务表写入** ✓
 *
 * ⚠️ 本文件**只加判据**（`server/test/**`）—— 产品代码一个字节都不改 ✓
 *   · 范围：真 HTTP 路由 ＋ 真读服务 ＋ 真写服务 ＋ 真建单/交付/库存引擎；**只有飞书那一层是内存假网关**
 *     ⇒ **零远端调用、零 Base 写入** ✓
 *   · 🔴 判据**一条都不许删 / skip / 放宽** ✗（要改就写成"改前逐字 → 改后逐字 → 依据"的**成对迁移** ✓）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_sales_chain';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_sales_chain_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createScanPageService } = require('../src/services/scanPageService');
const { createScanWriteService, waitForPendingSaleBackgrounds } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SERVER = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');
const ROUTE_SRC = readSrc('src/routes/scanPage.js');
const RENDERER_SRC = readSrc('src/views/scanPageRenderer.js');

// ── 语义键 → 物理列名（照真 schema；写错语义键当场抛，别让夹具自己漂）─────────────
const F = (table, key) => {
  const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
  if (!name) throw new Error(`schema 里没有 ${table}.${key}`);
  return name;
};

// ── 夹具：**两个货品** —— A 的 40 码有门盒（⇒ 现货）；B 一双都没有（⇒ 只能预订）──
const NUMBER_A = 'YD6693-2|黑色|A';
const ITEM_A = 'YD6693-2';
const NUMBER_B = 'XHB8095|黑色|A';
const ITEM_B = 'XHB8095';
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
const sizeRow = (size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement', 'size')]: size, 类别: ['A'] } });
const liveRow = (recordId, productRecordId, size, state, itemNo = ITEM_A) => ({
  record_id: recordId,
  fields: {
    [F('liveInventory', 'product')]: [productRecordId],
    [F('liveInventory', 'size')]: [`size_${size}`],
    [F('liveInventory', 'state')]: state,
    [F('liveInventory', 'stockKey')]: `${itemNo}|黑色|A|${size}`,
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

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mi-sales-chain-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的 E2E（照 `test/scanSaleE2E.test.js` 的既有搭建手法 ✓ 不改产品代码 ✓）：
 * 真 HTTP 路由 ＋ 真读/写服务 ＋ 真建单 / 交付 / 库存；**只有飞书那一层**是内存替身。
 *
 * ⭐ `voucherCalls`：⭐ 注入一个**只记账**的券解析器 ⇒ AC-SM-D 能把"券判定参数"**逐字**钉住 ✓
 *    （它只记收到的那两个参数、原样返回 ⇒ **不改任何业务行为** ✗）。
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
    gateway, sessions, delivery,
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: replenishDir, idField: 'task_id' }),
  });
  const service = createScanPageService(gateway, { config: SCAN_PAGE, startSnapshot: false });
  const voucherCalls = [];
  const voucherPaymentService = {
    settings: { enabled: true, unresolvedText: '这张券认不出来' },
    // 只记账、**原样返回**（不许改行为 ✗）
    resolveRows: async (payments) => {
      voucherCalls.push({ fn: 'resolveRows', payments: JSON.parse(JSON.stringify(payments)) });
      return { ok: true, payments, voucherRows: [], balanceDeltaCents: 0, faceValueCents: 0 };
    },
    adjustLineAmounts: (amounts, deltaCents) => {
      voucherCalls.push({ fn: 'adjustLineAmounts', amounts: JSON.parse(JSON.stringify(amounts)), deltaCents });
      return { amounts };
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service, gateway, writeService, startSnapshot: false, voucherPaymentService,
  }));
  return {
    gateway, sessions, writeService, app, tables: gateway._tables, voucherCalls,
    cleanup: () => { rmDir(sessionDir); rmDir(inventoryDir); rmDir(replenishDir); },
  };
};

// ── HTTP 工具（走真实路由；鉴权走工作台既有一道闸门）──────────────────────────
const SESSION_SECRET = 'mi_sales_chain_session_secret';
const OPEN_ID = 'ou_mi_sales_chain';
const sessionCookie = (openId) => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const pageUrlOf = (base, number, realm = 'sales') => `${base}/s/${encodeURIComponent(number)}?from=${realm}`;
const getPage = async (url, cookie) => {
  const response = await fetch(url, { headers: { cookie } });
  return { status: response.status, html: await response.text() };
};
/** ⚠️ 同名字段重复出现（`line_amount` / `payment_amount` 一行一个）⇒ 必须发**重复的键** ✓ */
const postForm = async (url, cookie, body) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  const text = await response.text();
  // 销售提交是**异步**的（单号先出、余下转后台）⇒ 端状态断言前先确定性地等后台那一跑跑完 ✓
  await waitForPendingSaleBackgrounds();
  return { status: response.status, location: response.headers.get('location') || '', html: text };
};

/** 关联列（「编号」/「尺码」在真表里是**关联**）⇒ 取第一个关联记录 id（非数组则原样）✓ */
const linkedId = (fields, name) => {
  const value = fields?.[name];
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
};

const linesOf = (session) => (Array.isArray(session?.sale?.lines) ? session.sale.lines : []);
const fieldsOf = (key, semanticKey, value) => V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
const valuesIn = (tables, key, semanticKey) => {
  const name = fieldsOf(key, semanticKey);
  return (tables[key] || []).map((record) => record.fields?.[name]);
};

/** 往本单加一件（走**真实路由** ⇒ 真的 `add_line` → `addSaleLine` ✓）。 */
const addLineVia = async (base, cookie, number, body, realm = 'sales') => postForm(
  pageUrlOf(base, number, realm), cookie,
  { [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.addLine, [SCAN_WRITE.fields.submitKey]: 'k_add', ...body },
);

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-A ⏳ 销售货品页的「＋ 再加一个货品」入口 ＋「本单已加的货品」列表
//   —— **形状与补货一致**（同一份文案配置 ＋ 同一个 `data-multi-add` 钩子 ✓）
//   ⚠️ 今天还没实现 ⇒ **待激活闸门**（不假装通过 ✗）；探针证明检测器**真能红** ✓
// ═══════════════════════════════════════════════════════════════════════════

const SALES_VIEW = Object.freeze({
  found: true, number: NUMBER_A, item_no: ITEM_A, color: '黑色', category_name: CATEGORY_NAME,
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 12:00',
});
const salesWriteOf = (lines) => ({
  enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: '/s/K1?from=sales', saleKey: 'k', paymentMethods: ['微信'],
  defaultPaymentMethod: '微信', saleEnabled: true, draft: { lines },
});
const salesPageHtml = (lines = []) => renderScanPage(SALES_VIEW, SCAN_PAGE, salesWriteOf(lines), 'sales', {});
/** 检测器（**纯函数**，探针直接喂造出来的 HTML ⇒ 证明它不是空跑 ✓）。 */
const salesHasMultiItemEntry = (html) => {
  const block = String(html).slice(String(html).indexOf('realm-block--sales'));
  return {
    entry: block.includes(MULTI_ITEM_RENDER_TEXTS.addButton),
    hook: /data-multi-add/.test(block),
    title: block.includes(MULTI_ITEM_RENDER_TEXTS.title),
  };
};

test('AC-SM-A-probe ⭐ **探针**：上面那个检测器**真能红** ✓（不是空跑 ✓）', () => {
  const good = `<div class="realm-block realm-block--sales">
<a class="btn" data-multi-add href="?add=1">${MULTI_ITEM_RENDER_TEXTS.addButton}</a>
<h3>${MULTI_ITEM_RENDER_TEXTS.title}</h3></div>`;
  assert.deepEqual(salesHasMultiItemEntry(good), { entry: true, hook: true, title: true },
    '探针：造一个"有入口 + 有列表标题"的 HTML ⇒ 三点全中 ✓');
  assert.equal(salesHasMultiItemEntry('<div class="realm-block realm-block--sales"><p>什么都没有</p></div>').entry, false,
    '探针：没有那句文案 ⇒ **必须**不认（证明这条判据能红 ✓）');
  assert.equal(salesHasMultiItemEntry(good.replace('data-multi-add', 'x')).hook, false,
    '探针：去掉那个钩子 ⇒ **必须**不认 ✓');
  assert.equal(salesHasMultiItemEntry(good.replace(MULTI_ITEM_RENDER_TEXTS.title, '别的标题')).title, false,
    '探针：换掉列表标题 ⇒ **必须**不认 ✓');
});

test('AC-SM-A ⭐ 销售货品页有「＋ 再加一个货品」入口 ＋「本单已加的货品」列表（形状与补货一致）', () => {
  // ⭐⭐ 2026-10-16 **成对迁移（⏳ 待激活 ⇒ ✓ 真判据）**——本刀就是"接线"那一刀：
  //   改前逐字（⏳ 闸门）：
  //     ```
  //     const got = salesHasMultiItemEntry(html);
  //     if (!got.entry || !got.hook || !got.title) {
  //       console.log(`[AC-SM-A] 待激活：销售货品页还没接「一单多货」入口`
  //         + `（entry=${got.entry} hook=${got.hook} title=${got.title}）`);
  //       return;
  //     }
  //     ```
  //   改后逐字：**下面这一段直接断言**（⏳ 撤掉、**闸门不再早退**）。
  //   依据：接线那一刀（本刀）已经落地 ⇒ 闸门**必须**变真判据 ——
  //     ⚠️ 留着 `return` 的后果是**静默假绿**：把入口删掉 ⇒ 这条判据照样"通过"（只打一行 log ✗），
  //       而那正是 #711 点名清掉过的那种"永远待激活的自足替身闸门" ✗。
  //   🔴 **不是放宽**：改前那 5 条 `assert` 一条没删、一条没松；只是**去掉了那条早退** ⇒ **更严** ✓。
  //   ⚠️ 探针（`AC-SM-A-probe`，逐字未动 ✓）仍然证明这个检测器**真能红** ✓。
  const html = salesPageHtml([{ product_number: ITEM_A, size: 40, quantity: 1, amount: 240 }]);
  const got = salesHasMultiItemEntry(html);
  // 接线后 ⇒ 这里是**真判据** ✓
  // ① 「＋ 再加一个货品」那颗入口必须**真的还在**（**形状与补货一致**：同一份文案配置 ✓）
  assert.ok(got.entry, `销售货品页必须有「${MULTI_ITEM_RENDER_TEXTS.addButton}」✓`);
  assert.ok(got.hook, '入口必须带**与补货同一个** `data-multi-add` 钩子（"形状一致"的可执行判据 ✓）');
  // ② 「本单已加的货品」列表（标题 + 已加的那些行）
  assert.ok(got.title, `销售货品页必须有「${MULTI_ITEM_RENDER_TEXTS.title}」列表 ✓`);
  const salesBlock = html.slice(html.indexOf('realm-block--sales'));
  assert.match(salesBlock, /name="line_amount"/, '已加的每一件都要能看见/改它的实收金额（既有 draft 行 ✓）');
  // ③ 🔴 加货这一下必须**带得走**她刚填的尺码 + 金额 ⇒ 只能是**本表单里的 submit**（不是 GET 链接 ✗）
  const entryTag = salesBlock.slice(salesBlock.indexOf('data-multi-add'));
  const entryEl = entryTag.slice(0, entryTag.indexOf('>'));
  assert.match(entryEl, /type="submit"/,
    '🔴 加货那颗必须是**同一张表单里的 submit**（POST ⇒ 她填的尺码/金额一起到 ✓；GET 链接天生带不走 ✗）');
  assert.equal(/href=/.test(entryEl), false, '🔴 不能是链接（链接 = GET ⇒ 值必丢 ✗）');
  assert.match(entryEl, new RegExp(`name="${SCAN_WRITE.fields.action}" value="${SCAN_WRITE.actions.addLine}"`),
    '🔴 它走的必须是**既有** `action=add_line`（⇒ 既有 `addSaleLine` ⇒ `sale.lines` ✓ 不新造写入口 ✗）');
});

test('AC-SM-A2 ⭐ `chains.sales` 只描述这条链的形状（**不参与落库** ✓）', () => {
  const cfg = resolveMultiItemOrderConfig({});
  const sales = cfg.chains.sales;
  // ⭐⭐ 2026-10-16 **成对迁移（⏳ 待激活 ⇒ ✓ 真判据）**——与 AC-SM-A 同一刀、同一条依据：
  //   改前逐字（⏳ 闸门）：
  //     ```
  //     if (!sales) {
  //       console.log('[AC-SM-A2] 待激活：`config/multiItemOrder.js` 还没有 `chains.sales`（Lead 裁决 = 甲′ 要加）');
  //       return;
  //     }
  //     ```
  //   改后逐字：`assert.ok(sales, …)` ⇒ **没有 `chains.sales` 就红**（⏳ 撤掉、不再早退）。
  //   依据：本刀已经把 `chains.sales` 加上 ⇒ 留着 `return` 就是**静默假绿**
  //     （谁把这一块删掉，这条判据照样"通过" ✗ —— 与 #711 清掉的那种自足替身闸门同一个形状 ✗）。
  //   🔴 **不是放宽**：下面那几条 `assert` 一条没删、一条没松，只是不再允许"没有这一块" ✓。
  assert.ok(sales, '🔴 `config/multiItemOrder.js` 必须有 `chains.sales`（Lead 裁决 = 甲′ ✓；删掉 ⇒ 红 ✓）');
  // ① 形状位：前缀复用既有销售会话前缀（**不新造** ✓）＋ 上限 = 既有 `SESSION.maxLines`（**同一个数** ✓）
  assert.equal(sales.orderKeyPrefix, SCAN_WRITE.session.saleKeyPrefix,
    'chain 的前缀必须复用既有销售会话前缀（`SCAN_SALE_KEY_PREFIX` ✓ 改了就红 ✓）');
  assert.equal(sales.maxLines, SCAN_WRITE.session.maxLines,
    `上限必须与 \`SESSION.maxLines\`（= ${SCAN_WRITE.session.maxLines}）**同一个数**（两处写死必漂 ✗）`);
  // ② 🔴 **不参与落库**：不许有引擎写入件键（`multiItemWriters()` 里没有销售这一支 ✗ 也不许硬指 `purchase` ✗）
  const writers = createScanWriteService({ gateway: {}, config: SCAN_WRITE }).multiItemWriters();
  assert.equal(writers.sales, undefined,
    '🔴 销售这条链**不许**有引擎写入件（`multiItemWriters()` 是 `scanWriteService` 的冻结件 ✗ 加不了 ✓）');
  assert.notEqual(sales.writer, 'purchase',
    '🔴 **绝不许**把销售指到补货那个写入件（那会"钱还没收就先落货" ✗ 与今天的顺序冲突 ✗）');
  assert.notEqual(sales.writer, 'purchaseReturn', '🔴 同理不许指到退货那一个 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-B ⭐⭐ 填了首件的**尺码 + 金额** ⇒ 点「加货」⇒ 那两个值
//   **在 `sale.lines` 里且逐字没变**（丢了 / 串了 / 换位 ⇒ 红 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM-B ⭐⭐ 填了尺码 + 金额 ⇒ 加货 ⇒ 值在 `sale.lines` 里且**逐字没变**（丢了/串了 ⇒ 红）', async () => {
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      const response = await addLineVia(base, cookie, NUMBER_A, {
        [SCAN_WRITE.fields.size]: '41',
        [SCAN_WRITE.fields.amount]: '240',
        [SCAN_WRITE.fields.gift]: '备注一句',
      });
      assert.equal(response.status, 303, '加货是 Post-Redirect-Get（303 ✓）');

      const lines = linesOf(await h.sessions.get(OPEN_ID));
      assert.equal(lines.length, 1, '本单应当正好一行 ✓');
      const line = lines[0];
      // 🔴 逐字：她填的**尺码**与**金额**（丢了 / 变成别的数 / 串到别的货品上 ⇒ 红 ✓）
      assert.equal(String(line.size), '41', '🔴 尺码必须逐字 = 她填的那个（丢了 / 串了 ⇒ 红）');
      assert.equal(Number(line.amount), 240, '🔴 金额必须逐字 = 她填的那个（丢了 / 串了 ⇒ 红）');
      // 这一行还得**认得清是哪个货品**（否则"串了货品"照样绿 ✗）
      assert.equal(line.number, NUMBER_A, '货品编号必须是**她扫的那一个** ✓');
      assert.equal(line.product_record_id, 'prod_a', '货品 record_id 也要对上 ✓');
      assert.equal(line.item_no, ITEM_A, '货号要对上 ✓');
      assert.equal(line.gift, '备注一句', '备注也一起带到了（同一张表单 ✓）');
      // ⭐ 页面重开 ⇒ 她刚填的数**还在**（不用重打 ✓）
      const page = await getPage(pageUrlOf(base, NUMBER_A), cookie);
      const salesBlock = page.html.slice(page.html.indexOf('realm-block--sales'));
      assert.match(salesBlock, /name="line_amount"[^>]*value="240"/,
        '⭐ 重开这一页 ⇒ 她填的 240 还在那个输入框里（不用重打 ✓）');
    });
  } finally { h.cleanup(); }
});

test('AC-SM-B2 ⭐⭐ 两件**各自**的尺码/金额不许串（A=40/240、B=41/260）', async () => {
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      await addLineVia(base, cookie, NUMBER_A, { [SCAN_WRITE.fields.size]: '40', [SCAN_WRITE.fields.amount]: '240' });
      await addLineVia(base, cookie, NUMBER_B, { [SCAN_WRITE.fields.size]: '41', [SCAN_WRITE.fields.amount]: '260' });
      const lines = linesOf(await h.sessions.get(OPEN_ID));
      assert.equal(lines.length, 2, '本单应当两行 ✓');
      // 按下标对齐逐件核（**换位 ⇒ 红** ✓）
      assert.deepEqual(
        lines.map((line) => [line.number, String(line.size), Number(line.amount)]),
        [[NUMBER_A, '40', 240], [NUMBER_B, '41', 260]],
        '🔴 逐件的 货品 / 尺码 / 金额 必须**一一对应**（串了 / 换位 / 丢了 ⇒ 红 ✓）',
      );
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-C ⭐⭐ 走**既有** `addLine` / `submitSale`（**引擎 0 次** ✗），逐件尺码/金额都对
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM-C ⭐⭐ 多件 ⇒ 走既有 `addLine`/`submitSale`：逐件尺码 + 金额**都落对**', async () => {
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      // ① 两件分别加进本单（既有 `add_line` ⇒ 既有 `addSaleLine` ✓）
      await addLineVia(base, cookie, NUMBER_A, { [SCAN_WRITE.fields.size]: '40', [SCAN_WRITE.fields.amount]: '240' });
      await addLineVia(base, cookie, NUMBER_B, { [SCAN_WRITE.fields.size]: '41', [SCAN_WRITE.fields.amount]: '260' });
      // ② 提交这一单 ⇒ **资金页**（这一步一个字都不写业务表 ✓）
      const step = await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.submitOrder,
        [SCAN_WRITE.fields.submitKey]: 'k_submit',
      });
      assert.equal(step.status, 200, '点「提交这一单」⇒ 停在资金页（还不是成功页 ✓）');
      assert.equal(valuesIn(h.tables, 'salesEntry', 'orderNo').length, 0,
        '🔴 到资金页为止**业务表零写入**（建单发生在资金页那一按 ✓ 她 2026-10-14 口径）');
      // ③ 资金页那一按 ⇒ **既有 `submitSale`**（读全部 `sale.lines` ✓）—— 全付 500
      const pay = await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        [SCAN_WRITE.fields.action]: 'payment_pay',
        [SCAN_WRITE.fields.submitKey]: 'k_submit',
        [SCAN_WRITE.fields.paymentMethod]: '微信',
        [SCAN_WRITE.fields.paymentAmount]: '500',
      });
      assert.equal(pay.status, 200, `资金页提交应当成功（实得 ${pay.status}）`);
      // ④ 主表 1 条、明细 **2 行**，逐件的**尺码**与**实收金额**都对 ✓
      assert.equal(valuesIn(h.tables, 'salesEntry', 'orderNo').length, 1, '只建**一张**单 ✓');
      const details = h.tables.salesDetail || [];
      assert.equal(details.length, 2, '明细必须**两行**（一件一行 ✓）');
      const sizeName = fieldsOf('salesDetail', 'size');
      const amountName = fieldsOf('salesDetail', 'actualAmount');
      const numberName = fieldsOf('salesDetail', 'product');
      // ⚠️ 真表里「编号」「尺码」都是**关联**列（写进去的是记录 id）⇒ 逐行把三件事**绑在同一行上**核：
      //    货品 prod_a ↔ 尺码 size_40 ↔ 金额 240；prod_b ↔ size_41 ↔ 260（串行 / 串值 / 换位 ⇒ 红 ✓）
      assert.deepEqual(
        details.map((row) => [
          linkedId(row.fields, numberName), linkedId(row.fields, sizeName), Number(row.fields?.[amountName]),
        ]).sort(),
        [['prod_a', 'size_40', 240], ['prod_b', 'size_41', 260]].sort(),
        '🔴 落库的**逐件 货品 / 尺码 / 实收金额** 必须绑在同一行上且一一对应（串了 / 丢了 ⇒ 红 ✓）',
      );
    });
  } finally { h.cleanup(); }
});

test('AC-SM-C2 🔴 这条链上**没有引擎调用**：`submitMultiItemOrder` 不在销售那条路上（源码 + 运行时双证）', () => {
  // ① 源码：`submitMultiItemOrder` 的调用点**只有**补货 / 退货两处（`groups.length > 1`）✓
  assert.match(ROUTE_SRC, /const submitMultiItemOrder = async \(/, '引擎那条路的定义必须还在 ✓');
  const callSites = (ROUTE_SRC.match(/return submitMultiItemOrder\(/g) || []).length;
  assert.equal(callSites, 2,
    `\`submitMultiItemOrder\` 只该有 2 处调用（补货 / 退货各一处）——实得 ${callSites} ⇒`
    + ' 多出来那一处就是把销售也接上引擎了 ✗（Lead 裁决 = 甲′：销售**不走引擎** ✗）');
  for (const chain of ["chain: 'replenish'", "chain: 'return'"]) {
    assert.ok(ROUTE_SRC.includes(chain), `既有的那两处调用必须逐字还在：${chain} ✓`);
  }
  assert.equal(/submitMultiItemOrder\([\s\S]{0,400}?chain: 'sales'/.test(ROUTE_SRC), false,
    '🔴 绝不许出现 `chain: \'sales\'` 的引擎调用 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-D ⭐⭐ **N=1 ⇒ 走今天那条老路 ＋ 资金页 ＋ 券判定参数逐字不变**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM-D ⭐⭐ N=1 ⇒ 老路（submit_order ⇒ 资金页 ⇒ submitSale）＋ 券判定参数**逐字不变**', async () => {
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      // ① 一单一笔的默认路径：**不点加货**，直接「选尺码 + 填金额 + 提交这一单」
      const step = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.submitOrder,
        [SCAN_WRITE.fields.submitKey]: 'k_one',
        [SCAN_WRITE.fields.size]: '40',
        [SCAN_WRITE.fields.amount]: '240',
      });
      assert.equal(step.status, 200, 'N=1 ⇒ 停在**资金页**（与改前逐字同一条路 ✓）');
      assert.ok(step.html.includes('整单付款'), '资金页真的渲染出来了 ✓');
      assert.equal(valuesIn(h.tables, 'salesEntry', 'orderNo').length, 0, '资金页之前零写入 ✓');

      // ② 资金页那一按 ⇒ 既有 submitSale
      const pay = await postForm(pageUrlOf(base, NUMBER_A), cookie, {
        [SCAN_WRITE.fields.action]: 'payment_pay',
        [SCAN_WRITE.fields.submitKey]: 'k_one',
        [SCAN_WRITE.fields.paymentMethod]: '微信',
        [SCAN_WRITE.fields.paymentAmount]: '240',
      });
      assert.equal(pay.status, 200, '全付 240 ⇒ 成功 ✓');
      // ③ 只有 **1 行**明细，逐字 = 她填的那一件
      const details = h.tables.salesDetail || [];
      assert.equal(details.length, 1, 'N=1 ⇒ 只有一行明细（没有多出任何东西 ✓）');
      const sizeName = fieldsOf('salesDetail', 'size');
      const amountName = fieldsOf('salesDetail', 'actualAmount');
      assert.equal(linkedId(details[0].fields, sizeName), 'size_40', '尺码（关联列）逐字 = 她填的 40 码 ✓');
      assert.equal(Number(details[0].fields?.[amountName]), 240, '实收金额逐字 ✓');

      // ④ ⭐⭐ **券判定参数逐字不变**（她是 2026-10-16 裁的券口径；改了就红 ✓）
      //    · `resolveRows(pendingPayments)` ⇒ **资金页那张表单上的收款行**（她填的那一行 ✓ 逐字：方式 + 金额）
      //    · `adjustLineAmounts(pendingLineAmounts, balanceDeltaCents)` ⇒ **她填的每件实收 240** ＋ 券差额 0 ✓
      assert.deepEqual(h.voucherCalls, [
        { fn: 'resolveRows', payments: [{ method: '微信', amount: '240' }] },
        { fn: 'adjustLineAmounts', amounts: ['240'], deltaCents: 0 },
      ], '🔴 N=1 的券判定参数必须**逐字不变**（多一项 / 少一项 / 换了值 ⇒ 红 ✓）');
      // ⑤ N=1 收尾也走**成功页**（与改前同一条 ✓）
      assert.ok(pay.html.includes('本单提交成功') || pay.html.includes('已提交成功，数据会更新'),
        'N=1 提交成功 ⇒ 成功页（她 2026-10-16 定的那一句 ✓）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-E ⭐ 多件时**少付 ⇒ 自动记未收款**仍生效（她 2026-10-16 裁的 A ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM-E ⭐ 多件（500）少付（300）⇒ **自动记一条未收款 200**（裁的 A 仍生效 ✓）', async () => {
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      await addLineVia(base, cookie, NUMBER_A, { [SCAN_WRITE.fields.size]: '40', [SCAN_WRITE.fields.amount]: '240' });
      await addLineVia(base, cookie, NUMBER_B, { [SCAN_WRITE.fields.size]: '41', [SCAN_WRITE.fields.amount]: '260' });
      await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.submitOrder,
        [SCAN_WRITE.fields.submitKey]: 'k_owe',
      });
      const pay = await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        [SCAN_WRITE.fields.action]: 'payment_pay',
        [SCAN_WRITE.fields.submitKey]: 'k_owe',
        [SCAN_WRITE.fields.paymentMethod]: '微信',
        [SCAN_WRITE.fields.paymentAmount]: '300',
      });
      assert.equal(pay.status, 200, `少付也要能提交成单（实得 ${pay.status}）`);
      const amountName = fieldsOf('paymentRecord', 'amount');
      const amounts = (h.tables.paymentRecord || []).map((row) => Number(row.fields?.[amountName]))
        .sort((left, right) => left - right);
      assert.deepEqual(amounts, [200, 300],
        '🔴 收款明细 = 真收到的 300 ＋ **自动那条未收款 200**（差额 = 累计 500 − 已收 300 ✓ 她 2026-10-16 裁的 A）');
      // 且那条未收款**方式留空**（形状归既有业务层 ✓ 本文件不拼）
      const methodName = fieldsOf('paymentRecord', 'method');
      const owed = (h.tables.paymentRecord || []).find((row) => Number(row.fields?.[amountName]) === 200);
      assert.ok(!String(owed.fields?.[methodName] ?? '').trim(), '未收款那一条**方式留空** ✓（不许编一个方式 ✗）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-F ⭐ 补货 / 退货 / 库存**行为不变**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM-F1 🔴 两个红线文件**逐字节未动**（谁改一个字就红 ✓）', () => {
  // ① `scanWriteService.js`：指纹 = 既有的那份冻结基线（`test/scanWriteServiceFrozen.test.js` 的常量 ✓）
  const frozenSrc = fs.readFileSync(path.join(__dirname, 'scanWriteServiceFrozen.test.js'), 'utf8');
  const baseline = frozenSrc.match(/const FROZEN_SHA256 = '([0-9a-f]{64})';/)[1];
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(SERVER, 'src/services/scanWriteService.js'))).digest('hex');
  assert.equal(actual, baseline,
    '🔴 `services/scanWriteService.js` 是**余量 0 的冻结件**（含注释 ✗）——本刀一个字都不许动 ✓'
    + '（这条与 AC-FRZ1 同一个指纹 ⇒ 两处同时红 = 真的被改了 ✓）');
  // ② `services/multiItemOrderService.js`：Lead 2026-10-16 明文"**不授权**"改 ⇒ 记指纹基线（谁动一个字就红 ✓）。
  //    ⚠️ 基线 = 本判据落地时（`main b7ba07e`）**实测值**；那两处 `assert` 是**能真红**的证明 ✓
  //    （改动那个文件若**确属授权过的另一刀** ⇒ 按"成对迁移"更新这个常量 ✓ 不许静默 ✗）。
  const MULTI_ITEM_SERVICE_SHA256 = 'eaa1f7fcb4045be5246e2f5c2447ca3648f84d3b9e9f777a904dd190efd8c7d5';
  const enginePath = path.join(SERVER, 'src/services/multiItemOrderService.js');
  const engineRaw = fs.readFileSync(enginePath);
  const engineActual = crypto.createHash('sha256').update(engineRaw).digest('hex');
  assert.equal(engineRaw.length > 0, true, '先确认读到的确实是那个文件（防空文件假绿 ✗）');
  // 探针（真能红）：改一个字节 ⇒ 指纹必须变 ✓
  assert.notEqual(
    crypto.createHash('sha256').update(Buffer.concat([engineRaw, Buffer.from(' ')])).digest('hex'),
    MULTI_ITEM_SERVICE_SHA256,
    '探针：多一个空格 ⇒ **必须**与基线不等（证明这条判据不是空跑 ✓）',
  );
  assert.equal(engineActual, MULTI_ITEM_SERVICE_SHA256,
    '🔴 `services/multiItemOrderService.js` 本刀**不授权改**（Lead 逐字 ✗）——'
    + ' 改了 ⇒ 本判据红 ✓（授权过的另一刀请按"成对迁移"显式更新这个基线 ✓）');
});

test('AC-SM-F2 🔴 补货 / 退货那两条链**一处没动**（源码锚点 + 配置值 ✓）', () => {
  const cfg = resolveMultiItemOrderConfig({});
  // ① 两条链的配置值一个都不许变（前缀 / 行为编码 / 上下限 ✓）
  assert.equal(cfg.chains.replenish.orderKeyPrefix, SCAN_WRITE.session.replenishKeyPrefix, '补货前缀不变 ✓');
  assert.equal(cfg.chains.return.orderKeyPrefix, SCAN_WRITE.session.returnKeyPrefix, '退货前缀不变 ✓');
  assert.equal(cfg.chains.replenish.behaviorCode, SCAN_WRITE.replenish.behaviorCode, '补货行为编码不变 ✓');
  assert.equal(cfg.chains.return.behaviorCode, SCAN_WRITE.purchaseReturn.behaviorCode, '退货行为编码不变 ✓');
  assert.equal(cfg.chains.replenish.amountRequired, false, '补货不问金额（她 2026-10-15 裁的 ✓）');
  assert.equal(cfg.chains.return.amountRequired, true, '退货整单金额必填（既有键名 ✓）');
  // ② 渲染层那两处调用**逐字还在**（补货 / 退货各一处 ✓ "两块都加得了第二个货品" ✓）
  assert.ok(RENDERER_SRC.includes("multiItemBlockHtml(write, view, 'replenish')"), '补货那一处还在 ✓');
  assert.ok(RENDERER_SRC.includes("multiItemBlockHtml(write, view, 'return')"), '退货那一处还在 ✓');
  // ③ 路由里那两处 `groups.length > 1` 分流**逐字还在** ✓
  const branches = ROUTE_SRC.match(/if \(groups\.length > 1\) \{/g) || [];
  assert.equal(branches.length, 2, `补货/退货各一处「>1 组才走引擎」的分流（实得 ${branches.length}）✓`);
});

test('AC-SM-F3 ⭐ 库存行为不变：现货行交付扣库存、预订行**不碰**库存 ✓', async () => {
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      await addLineVia(base, cookie, NUMBER_A, { [SCAN_WRITE.fields.size]: '40', [SCAN_WRITE.fields.amount]: '240' });
      await addLineVia(base, cookie, NUMBER_B, { [SCAN_WRITE.fields.size]: '41', [SCAN_WRITE.fields.amount]: '260' });
      await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        [SCAN_WRITE.fields.action]: SCAN_WRITE.actions.submitOrder,
        [SCAN_WRITE.fields.submitKey]: 'k_stock',
      });
      await postForm(pageUrlOf(base, NUMBER_B), cookie, {
        [SCAN_WRITE.fields.action]: 'payment_pay',
        [SCAN_WRITE.fields.submitKey]: 'k_stock',
        [SCAN_WRITE.fields.paymentMethod]: '微信',
        [SCAN_WRITE.fields.paymentAmount]: '500',
      });
      // A 的 40 码（门盒 = 现货）⇒ 交付即扣库存 ⇒ 那一行没了 ✓
      assert.equal((h.tables.liveInventory || []).some((row) => row.record_id === 'live_a_40_box'), false,
        '⭐ 现货那一件提交即交付 ⇒ 门盒那一行被扣掉（既有交付/库存链路 ✓ 行为不变）');
      // B 那一件是**预订**（一行库存都没有）⇒ 不产生任何库存动作 ✓
      assert.equal((h.tables.liveInventory || []).length, 0, '预订那一件**不碰**库存 ✓（只剩被扣掉的那一行 ⇒ 0）');
      assert.equal((h.tables.inventoryLedger || []).length, 1,
        '⭐ 库存流水**只多 1 条**（只有现货那一件扣了；预订不扣 ✓）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SM-LIMIT 🔴 上限 = `SESSION.maxLines`（= 50，配置 ✓）⇒ 超了**人话拦住 + 零业务表写入**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SM-LIMIT 🔴 上限走配置（50）：第 51 件 ⇒ **人话拦住 + 零业务表写入** ✓', async () => {
  assert.equal(SCAN_WRITE.session.maxLines, 50,
    `上限的**唯一真源**是配置里的 \`SESSION.maxLines\`（实得 ${SCAN_WRITE.session.maxLines}）——`
    + ' 写死在逻辑里 ⇒ 换一个值要改代码 ✗（配置先行 ✓）');
  const h = createE2E();
  const cookie = sessionCookie(OPEN_ID);
  try {
    await withServer(h.app, async (base) => {
      const max = SCAN_WRITE.session.maxLines;
      for (let index = 0; index < max; index += 1) {
        // eslint-disable-next-line no-await-in-loop
        const response = await addLineVia(base, cookie, NUMBER_A, {
          [SCAN_WRITE.fields.size]: String(40 + (index % 3)),
          [SCAN_WRITE.fields.amount]: '100',
        });
        assert.equal(response.status, 303, `第 ${index + 1} 件应当在限额内（303 ✓）`);
      }
      assert.equal(linesOf(await h.sessions.get(OPEN_ID)).length, max, `本单应当正好 ${max} 行 ✓`);
      // 🔴 第 51 件 ⇒ **拦住**
      const overflow = await addLineVia(base, cookie, NUMBER_A, {
        [SCAN_WRITE.fields.size]: '41', [SCAN_WRITE.fields.amount]: '100',
      });
      assert.equal(overflow.status, 400, '🔴 超上限 ⇒ 400（她**能看懂**的那一类 ✓）');
      // 人话（文案来自配置，**模板里的 `{max}` 要填成真数** ✓ 不许把模板原样丢给她 ✗）
      const human = String(SCAN_WRITE.texts.tooManyLinesBody).replace('{max}', String(max));
      assert.ok(overflow.html.includes(human),
        `🔴 必须给她**人话**（缺了 ⇒ 她只看到 400、不知道为什么 ✗）：应当含「${human}」`);
      assert.equal(overflow.html.includes('{max}'), false, '🔴 模板占位符不许原样出现在页面上 ✗');
      // 🔴 **零业务表写入**（本地会话也不许多出第 51 行 ✓）
      assert.equal(linesOf(await h.sessions.get(OPEN_ID)).length, max, '🔴 拦住的那一件**不落**会话草稿 ✓');
      const businessWrites = h.gateway.writes.filter((write) => write.table !== 'liveInventory');
      assert.deepEqual(businessWrites, [], '🔴 拦住时**业务表一个字都不许写** ✓（含主表 / 明细 / 收款）');
    });
  } finally { h.cleanup(); }
});
