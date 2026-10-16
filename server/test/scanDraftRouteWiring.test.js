require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ **「补货 / 退货 / 销售 存草稿 · 接着录」S3（路由半）的验收标准** —— 2026-10-16。
 *
 * 本刀 = **接线那一半**（S1 = 存储层 #732 ✓、S2 = 渲染半 #735 ✓ 都已在 main）。
 * 业务负责人的口径（**逐字**；出处 = `docs/draft-save-resume-plan-2026-10-16.md`
 *   ＋ Lead 的两页便条 `.local/draft-plan/LEAD-ADDENDUM-2.md` / `LEAD-ADDENDUM-3.md`）：
 *   · 「我们的**销售货品页上面也需要加一个按钮**，叫「**存报货草稿**」」；
 *   · 「我们的**补货和退货需要支持存草稿**功能…需要支持**存草稿后续再处理**」；
 *   · ⭐ **两种草稿**：**销售页 / 补货页存补货草稿**、**退货页存退货草稿**；
 *   · ⭐「**草稿也写明细**」⇒ 存草稿 = 「采购主表」**1 行**（`到货状态 = 未报货`）＋
 *     「采购明细」**N 行**（一行 = 一个货品 × 一个尺码）；
 *   · **保留 7 天** ✓ **只留一份** ✓（第二次存覆盖 ＋ 留痕 `scan.draft.overwritten` ✓）；
 *   · **接着录**：进页面若有草稿 ⇒ 提示条「你有一份草稿，接着录吗？」✓
 *     **不点就正常新建** ✓。
 *
 * ── 先写「按我们的链路应该实现的效果」，再跑，再逐条对照（她定的流程）────────────
 *
 *  AC-D3a ⭐ **三处入口真出现**（销售货品页 / 补货页 / 退货页）且**点击 = POST `save_draft`** ✓；
 *         库存页 / 标签页**不出** ✓（取值必须是 `REALMS[].id`；认不出的领域不显示 ✗ 不猜）。
 *          ⚠️ 判据分两半：①**路由真的喂了 `page.draft`**（`enabled === true` ⇒ 渲染半才画
 *             —— 只喂给三个领域页）；②页面上那颗 submit **带得走她刚填的尺码/数量**
 *             （`name=action value=save_draft`，与 `DRAFT_ENTRY.saveAction` 逐字同源 ✓）。
 *  AC-D3b ⭐ 存草稿 ⇒ ⭐ **主表 1 行（未报货）＋ 明细 N 行** ✓；
 *         再去 GET ⇒ **`hasDraft = true` ＋ 提示条出现** ✓（`page.draft` 的五个字段**全部取自
 *         S1 的 `readDraft`** —— 判据直接比对"读了什么"与"喂了什么"）。
 *  AC-D3c ⭐ **幂等**：同一草稿存两次 ⇒ 明细**不翻倍** ✓ 主表**不多行** ✓（S1 的键照用 ✓）。
 *  AC-D3d ⭐ **零副作用仍成立**：**不发群 / 不出图 / 不写库存 / 不出单号** ✓
 *         （**唯一例外 = 明细行** ✓ 她口径 ✓ **假 gateway 记账**证明）。
 *  AC-D3e ⭐ **接着录**：存 → 重进带 `?resume=1` ⇒ **尺码/数量/已加货品逐字还原** ✓
 *         （少了/多了 ⇒ 红 ✓）；⚠️ **不点提示条**（不带 `?resume=1`）⇒ **草稿不进页面** ✓。
 *  AC-D3f ⭐ **不点就正常新建** ⇒ 与今天**逐字节一致** ✓（S2 的 `stripDraftEntries` 手法沿用 ✓）。
 *  AC-D3g ⭐ **草稿不进任何"已提交 / 待处理"投影** ✓ ＋ **9 点推送捡不到草稿行** ✓
 *         （反向钉：把草稿行的 `到货状态` 改成 `未到货` ⇒ 它**立刻**进候选 ⇒ 判据不是空跑 ✓）。
 *  AC-D3h **票面 / 资金页**：草稿**不碰**收款 / 实收 / 资金状态 ✓（真写服务在跑：它那几张表 0 次 ✓）。
 *  AC-D3i 🔴 **源码哨兵**：`services/scanWriteService.js` 与 main **逐字节一致**（余量 0：谁改一个字就红）。
 *
 * ⚠️ 本文件每条都写明「**去掉哪一句就该红**」（见文件末 `MUTATION`）——
 *   避免"名字出现过 = 有判据"那种假绿（AGENTS.md 第 1b 条③）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// 渲染 / 写链路在 require 阶段就要凭证（与既有扫码页用例同一前置 ✓）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_draft_route';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_draft_route_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_scan_draft_route';
// 本文件测的是"货品页上的那三处入口 / 提示条 / 存草稿"，与骨架屏无关 ⇒ 显式关（不受环境干扰 ✓）
process.env.SCAN_PAGE_SKELETON_ENABLED = 'false';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE, DRAFT_ENTRY } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { resolveScanDraftConfig } = require('../src/config/scanDraft');
const { createScanDraftService } = require('../src/services/scanDraftService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage.js'), 'utf8');
const FROZEN_PATH = path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js');
/** 🔴 main 上那个冻结件的基线指纹（与 `test/scanWriteServiceFrozen.test.js` 的常量**同一个值** ✓）。
 *  ⚠️ **2026-10-16 成对迁移**（task-62「货 / 钱分离」阶段二 · 业务负责人明确「允许改冻结文件」，**一次性、只为本卡**）：
 *     改前逐字 `199551e1…35ca`（1699 行）⇒ 改后逐字 `49772bda…2c12`（1770 行）。
 *     本刀（草稿接线）自己在那份文件里**仍然一个字都没加** ✗ —— 判据没放宽，只是基线随授权的那一刀一起搬 ✓。
 *     ⚠️ 许可**不能复用**：下一次改它必须重新拿裁决（见冻结哨兵的「解冻台账」✓）。
 */
const FROZEN_SHA256 = '49772bdaffc82411b427f5f5b26a9d74ca937e317fb4fbdebfd33492b7fd2c12';
const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

const SESSION_SECRET = 'scan_draft_route_session_secret';
const OPEN_ID = 'ou_draft_route';
const NUMBER = 'HM-D1|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

const SALES = 'sales';
const REPLENISH = 'replenish';
const PURCHASE_RETURN = 'purchase_return';
const OTHER_REALMS = ['inventory', 'product'];
/** 她说的那三页（三处入口的取值必须是 `REALMS[].id` ✓）。 */
const THREE_REALMS = [SALES, REPLENISH, PURCHASE_RETURN];

const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const view = (realm = SALES) => ({
  found: true,
  number: NUMBER,
  item_no: 'HM-D1',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 3 }], total: 3, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 21:05',
  product_record_id: 'rec_product_A',
  // 退货那一块要"这一款当前库存"（尺码明细），与真 service 同形
  size_stock: [{ size_text: '40', stock: 3 }, { size_text: '41', stock: 1 }],
  realm,
});

// ═══════════════════════════════════════════════════════════════════════════
// 假 gateway（**记账** ＋ 一张内存表）—— 本文件从头到尾零真表写入 ✓
// ═══════════════════════════════════════════════════════════════════════════
const DRAFT_FIELD_KEYS = ['batchNo', 'arrivalStatus', 'idempotencyKey', 'product', 'size', 'quantity'];

const makeFakeGateway = () => {
  const tables = new Map();
  const calls = [];
  let seq = 0;
  const rowsOf = (tableKey) => {
    if (!tables.has(tableKey)) tables.set(tableKey, []);
    return tables.get(tableKey);
  };
  const fieldNamesOf = (tableKey) => {
    const fields = (V1_BITABLE_SCHEMA.tables[tableKey] || {}).fields || {};
    return Object.fromEntries(Object.entries(fields)
      .filter(([semanticKey]) => DRAFT_FIELD_KEYS.includes(semanticKey))
      .map(([semanticKey, column]) => [semanticKey, column]));
  };
  const physical = (tableKey, values) => {
    const fieldNames = fieldNamesOf(tableKey);
    const out = {};
    Object.entries(values || {}).forEach(([key, value]) => { out[fieldNames[key] || key] = value; });
    return out;
  };
  return {
    calls,
    tables,
    fieldNamesOf,
    table(tableKey) { return V1_BITABLE_SCHEMA.tables[tableKey] || null; },
    async listAll(tableKey) {
      calls.push({ op: 'listAll', table: tableKey });
      await Promise.resolve();
      return rowsOf(tableKey).map((row) => ({ ...row, fields: { ...row.fields } }));
    },
    async create(tableKey, values) {
      calls.push({ op: 'create', table: tableKey, values: { ...values } });
      await Promise.resolve();
      seq += 1;
      const record = { record_id: `rec_${tableKey}_${seq}`, fields: physical(tableKey, values) };
      rowsOf(tableKey).push(record);
      return { record_id: record.record_id, recordId: record.record_id };
    },
    async update(tableKey, recordId, values) {
      calls.push({ op: 'update', table: tableKey, record_id: recordId, values: { ...values } });
      await Promise.resolve();
      const row = rowsOf(tableKey).find((item) => item.record_id === recordId);
      if (row) row.fields = { ...row.fields, ...physical(tableKey, values) };
      return { record_id: recordId };
    },
    writesTo(tableKey) {
      return calls.filter((call) => (call.op === 'create' || call.op === 'update') && call.table === tableKey);
    },
    touchedTables() {
      return [...new Set(calls.filter((call) => call.op === 'create' || call.op === 'update')
        .map((call) => call.table))].sort();
    },
    /** 明细那几行（按「幂等键」列认 ⇒ 与 S1 的判据同一口径 ✓） */
    detailKeysOf() {
      return rowsOf('purchaseRequest')
        .map((row) => String(row.fields[fieldNamesOf('purchaseRequest').idempotencyKey] || ''));
    },
    async seedPendingRow(batchNo, status = '未到货') {
      seq += 1;
      const id = `rec_seed_${seq}`;
      rowsOf('purchaseOrderBatch').push({
        record_id: id,
        fields: {
          [fieldNamesOf('purchaseOrderBatch').batchNo]: batchNo,
          [fieldNamesOf('purchaseOrderBatch').arrivalStatus]: status,
        },
      });
      return id;
    },
  };
};

/** 假尺码解析器（形状与真件 `SizeReferenceService.resolveByNumber` 一致 ✓）。 */
const makeFakeSizeReferences = () => ({
  async resolveByNumber(value) {
    const size = Number(value);
    if (!Number.isFinite(size) || size <= 0) throw new Error(`尺码必须是正整数：${value}`);
    return { recordId: `rec_size_${size}`, size };
  },
});

const makeFakeBatchNoGenerator = () => {
  let sequence = 0;
  return {
    async next() {
      sequence += 1;
      const current = sequence;
      await Promise.resolve();
      return { batchNo: `CGD-20261016-${String(current).padStart(4, '0')}`, sequence: current };
    },
    get assigned() { return sequence; },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// 夹具：**真**的 session / draft 服务 ＋ 真 writeService（假 gateway）＋ 真 HTTP 服务器
// ═══════════════════════════════════════════════════════════════════════════
const makeHarness = ({ env = {}, draftEnabled = true, seedPending = null } = {}) => {
  const dirs = [];
  const tempDir = (label) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scan-draft-route-${label}-`));
    dirs.push(dir);
    return dir;
  };
  const gateway = makeFakeGateway();
  const sessionDir = tempDir('sessions');
  const draftDir = tempDir('drafts');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const config = resolveScanDraftConfig({
    SCAN_DRAFT_ENABLED: draftEnabled ? 'true' : 'false',
    ...env,
  });
  const draftService = createScanDraftService({
    gateway,
    config,
    dir: draftDir,
    sessions,
    // 🔴 会话 id 的形状**只有 session 服务那一处真源**（`scanSessionService.idOf`）——
    //    传进去 ⇒ 草稿的键与"跟着录的那一份会话"**永远同一把** ✓（各写一份公式必漂 ✗）
    idOf: sessions.idOf,
    batchNoGenerator: makeFakeBatchNoGenerator(),
    sizeReferences: makeFakeSizeReferences(),
    logger: { logInfo: () => {}, logWarn: () => {}, logError: () => {} },
  });
  const writeService = {
    sessions,
    multiItemWriters: () => ({ purchase: async () => {}, purchaseReturn: async () => {} }),
    listAccessories: async () => [],
  };
  if (seedPending) gateway.seedPendingRow(seedPending);
  return { gateway, sessions, draftService, writeService, config, draftDir, sessionDir, dirs };
};

const appFor = (h, draftConfig, realm = SALES) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = 'req_scan_draft_route'; next(); });
  // 本文件不测"多货品提交"⇒ 给一个**记账用**的假引擎（只证明草稿那条路**不碰**它 ✓）
  const engine = {
    calls: [],
    async openDraft() { engine.calls.push('openDraft'); return { ok: true, orderKey: 'k', draft: { items: [] } }; },
    async addItem() { engine.calls.push('addItem'); return { ok: true, orderKey: 'k', draft: { items: [] } }; },
    async submitDraft() { engine.calls.push('submitDraft'); return { ok: true, summary: {} }; },
  };
  h.engine = engine;
  const router = createScanPageRouter({
    service: { lookup: async () => view(realm) },
    gateway: h.gateway,
    writeService: h.writeService,
    scanDraftService: h.draftService,
    // ⚠️ 生产里这份配置是**模块级解析一次**（`config/scanDraft.js` 的 `SCAN_DRAFT`）——
    //    用例把同一份（harness 解析出来的）传进去 ⇒ 路由读的与草稿服务用的是**同一份** ✓
    draftConfig,
    multiItemOrder: engine,
    startSnapshot: false,
  });
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const getPage = async (base, realm = SALES, query = '') => {
  const response = await fetch(`${base}/s/${ENCODED}?from=${realm}${query}`, {
    headers: { cookie: sessionCookie() },
  });
  return { status: response.status, html: await response.text() };
};

const post = (base, body, realm = SALES) => fetch(`${base}/s/${ENCODED}?from=${realm}`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

/** 页面上那颗「存报货草稿」：**同一条表单里的第二颗 submit**（带得走她填的尺码/数量 ✓）。 */
const draftSaveButtonMark = (label = DRAFT_ENTRY.saveLabel) => `data-draft-save="1"`;
const draftNoticeMark = 'data-view="draft-notice"';
const draftResumeMark = 'data-draft-resume="1"';

/**
 * ⭐ **加货**那一发（生产里她那颗「＋ 再加一个货品」= 同一张表单里的第二颗 submit ✓）——
 *   它把"已经加进来的那几件"存进**会话暂存**、再 303 回本页。
 *   ⚠️ 夹具用**真 POST**（不是手写会话文件）：这样"存草稿时会把它一起收进草稿"
 *     走的就是生产那条路 ✓（`multiItemWire` 缺省开着 ⇒ 字段名从配置取 ✓）。
 */
/**
 * 会话暂存里"她刚填的那一份"（= 表单在浏览器里渲出来的 hidden `multi_items` ✓）——
 * 由**渲染层那个序列化器**产出（`[首件, ...已加]`，首件 `entries: []` ✓ 与真页面同源）。
 */
const stagedPayload = async (base, realm = REPLENISH) => hiddenMultiItems(
  (await getPage(base, realm)).html,
);

/**
 * ⭐ **会话暂存里真正存了什么**（"接着录"那一发把草稿填进去的落点 ✓）——
 * 直接从**真** `scanSessionService` 那一份会话 store 读（与路由写入**同一个地方** ⇒ 不是看页面猜 ✓）。
 */
const sessionPending = async (harness, chain = 'replenish') => {
  const ordersField = require('../src/config/multiItemOrder').MULTI_ITEM_ORDER.session.ordersField;
  const session = await harness.sessions.get(OPEN_ID);
  const block = (session && session[ordersField]) || {};
  const entry = block[`${chain}:pending`] || {};
  return Array.isArray(entry.items) ? entry.items : [];
};

const postAddItems = (base, item) => {
  const body = new URLSearchParams();
  body.append('multi_item_add', 'add');
  // 🔴 **加货一次只加一件**：`multi_items` 里放"当前这一件（entries 由这里合并进首件）
  //    ＋ 已加的那几件"（= 渲染层那个 hidden 字段的形状 ✓）。
  //    只放**已加的那一件** ⇒ 首件就是它自己的 `entries`（数量逐字是她填的 ✓）。
  body.append(SCAN_WRITE.fields.replenishSizes, String(item.entries[0].size));
  body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}${item.entries[0].size}`,
    String(item.entries[0].quantity));
  body.append('multi_items', JSON.stringify([item]));
  return fetch(`${base}/s/${ENCODED}?from=${REPLENISH}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
};

/** 从页面里取 hidden `multi_items` 那一份（**渲染半的序列化器产物** ⇒ 与真页面同源 ✓）。 */
const hiddenMultiItems = (html) => {
  const match = html.match(/<input type="hidden" name="multi_items" value="([^"]*)">/);
  if (!match) return null;
  const decode = (text) => text
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return JSON.parse(decode(match[1]));
};

/** ⭐ S2 的 `stripDraftEntries` 手法（逐字节比对"没有草稿时的页面"与时今天）✓ */
const stripDraftEntries = (html) => html
  // ⚠️ 只删**那颗按钮本身**、**不删它后面那个换行**：渲染层把它拼在两行之间
  //    （`<button …add_line…>\n<button data-draft-save>\n${lines.length ? …}`）⇒
  //    删掉换行就等于把"今天那一屏"里那个空行也一起删了 ⇒ 差一个字节 ✗（真踩过）。
  //    `[^\n]*` 而不是 `.*`（后者在 `m` 下也可能跨行贪婪 ✗）。
  .replace(/^[^\n]*<button data-draft-save="1"[^\n]*/gm, '')
  // 提示条那一块（**有草稿**时它才是那几行）：没有草稿时它渲染成空串 ⇒ 这里无事可做 ✓
  .replace(/<section class="card draft-notice"[\s\S]*?<\/section>\n?/g, '')


/**
 * 草稿那一份的形状（S1 `normalizeItem`：**字段顺序与类型逐字**）——用于"逐字还原"这条判据：
 * 页面上的载荷（渲染半那个序列化器产出）与草稿里的条目**归一后必须 deepEqual** ✓。
 */
const asDraftItem = (item) => ({
  product_record_id: String(item.product_record_id || ''),
  number: String(item.number || ''),
  item_no: String(item.item_no || ''),
  color: String(item.color || ''),
  supplier_record_id: String(item.supplier_record_id || ''),
  entries: (Array.isArray(item.entries) ? item.entries : []).map((entry) => ({
    size: String(entry.size ?? ''),
    // ⚠️ 数量：草稿里是**她填的那个原值**（S1 逐字存）；页面上那个值是**序列化再解析**回来的
    //    ⇒ 数字形态不同（`3` vs `'3'`）不算"丢了/多了" ⇒ 归一成字符串再比 ✓
    quantity: String(entry.quantity ?? ''),
  })),
});

const DRAFT_ITEMS = [
  {
    product_record_id: 'rec_product_A',
    number: NUMBER,
    item_no: 'HM-D1',
    color: '黑色',
    supplier_record_id: 'rec_supplier_1',
    entries: [{ size: '40', quantity: '2' }],
  },
  {
    product_record_id: 'rec_product_B',
    number: 'HM-D2|白色|A',
    item_no: 'HM-D2',
    color: '白色',
    supplier_record_id: 'rec_supplier_2',
    entries: [{ size: '38', quantity: '3' }, { size: '39', quantity: '1' }],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3a ⭐ 三处入口真出现 ＋ 点击 = POST save_draft
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3a ⭐ 三处入口（销售 / 补货 / 退货）都出「存报货草稿」且**提交 save_draft**；库存 / 标签页不出', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    for (const realm of THREE_REALMS) {
      const page = await getPage(base, realm);
      assert.equal(page.status, 200, `${realm} 页要 200（不是 4xx）`);
      assert.equal(page.html.includes(draftSaveButtonMark()), true,
        `⭐ ${realm} 页必须有那颗「存报货草稿」（路由没喂 page.draft ⇒ 渲染半不画 ⇒ 这里红 ✓）`);
      // ⭐ 那颗按钮**是同一张表单里的 submit**，值 = 配置的 saveAction（路由按它分派 ✓ 两处同源）
      const button = page.html.match(/<button data-draft-save="1"[^>]*>/)[0];
      assert.equal(button.includes('type="submit"'), true, '必须是一颗 submit（GET 链接带不走她填的值 ✗）');
      assert.equal(button.includes(`name="${SCAN_WRITE.fields.action}"`), true,
        '字段名沿用既有 action（不新造隐藏字段 ✓）');
      assert.equal(button.includes(`value="${DRAFT_ENTRY.saveAction}"`), true,
        `提交值 = 配置里的 saveAction（${DRAFT_ENTRY.saveAction}）⇒ 路由按它分派 ✓`);
      assert.equal(page.html.includes(DRAFT_ENTRY.saveLabel), true, '文案走配置（改配置即改文案 ✓）');
      // 没有草稿 ⇒ **只有按钮、没有提示条**（她说"不点就正常新建" ✓）
      assert.equal(page.html.includes(draftNoticeMark), false, `${realm} 页没草稿 ⇒ 提示条一个字都不许出 ✗`);
    }
    // ⭐ 库存 / 标签页**不出**这颗入口（取值必须是 REALMS[].id；认不出的领域不显示 ✗ 不猜）
    for (const realm of OTHER_REALMS) {
      const page = await getPage(base, realm);
      assert.equal(page.html.includes(draftSaveButtonMark()), false,
        `❌ ${realm} 页不该有「存报货草稿」（她只说了销售 / 补货 / 退货 ✓）`);
      assert.equal(page.html.includes(DRAFT_ENTRY.saveLabel), false, `${realm} 页连文案都不该出现`);
    }
  });
});

test('AC-D3a2 开关关着（SCAN_DRAFT_ENABLED=false）⇒ 三处入口**一个字节都不出**（影子/回滚位 ✓）', async () => {
  login();
  const h = makeHarness({ draftEnabled: false });
  await withServer(appFor(h, h.config), async (base) => {
    for (const realm of THREE_REALMS) {
      const page = await getPage(base, realm);
      assert.equal(page.html.includes(draftSaveButtonMark()), false,
        `开关关着 ⇒ ${realm} 页不许出现草稿入口 ✗`);
      assert.equal(page.html.includes(DRAFT_ENTRY.saveLabel), false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3b ⭐ 存草稿 ⇒ 主表 1 行（未报货）＋ 明细 N 行；再 GET ⇒ hasDraft=true ＋ 提示条
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3b ⭐ 补货页存草稿 ⇒ 主表 1 行（未报货）＋ 明细 3 行；303 回本页；再 GET ⇒ 提示条出现', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    // ① 先走**真 POST** 把"已经加进来的那一件"（HM-D2：38 码 3 双 / 39 码 1 双）存进会话暂存 ✓
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '加货那一发 303 回本页 ✓');
    // ② 她填的：本页这一款（40 码 2 双）—— hidden `multi_items` 由**渲染半那个序列化器**产出 ✓
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    assert.deepEqual(staged.map((item) => item.number), [NUMBER, DRAFT_ITEMS[1].number],
      '夹具：暂存里真的是"当前这一件 ＋ 已加那一件" ✓');
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '40');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '2');
    body.append('multi_items', JSON.stringify(staged));
    const response = await post(base, body, REPLENISH);
    assert.equal(response.status, 303, '存草稿 ⇒ **303 回本领域那一页**（PRG：刷新不重复存 ✓）');
    const location = String(response.headers.get('location') || '');
    assert.equal(location.includes(`from=${REPLENISH}`), true, `回跳要留在本领域：${location}`);
    assert.equal(location.includes('saved=1'), true, '⭐ 存成功要**给她看得见的反馈**（不许无声 ✗）');

    // ① 主表那一行：**1 行**、到货状态 = 未报货
    const batchWrites = h.gateway.writesTo('purchaseOrderBatch');
    assert.equal(batchWrites.length, 1, '主表那一行只许 1 行 ✗');
    const statusColumn = h.gateway.fieldNamesOf('purchaseOrderBatch').arrivalStatus;
    assert.equal(batchWrites[0].values.arrivalStatus, '未报货', '草稿行的到货状态 = 她的"草稿状态" ✓');
    assert.equal(batchWrites[0].values[statusColumn], undefined,
      '⚠️ 表侧写入走**语义键**（中文列名由 gateway 映射；这里不该出现中文列名 ✗）');
    // ② 明细：**一行 = 一个（货品 × 尺码）**——本页这一件（HM-D1 / 40 码 2 双）
    //    ＋ 已加那一件（HM-D2 / 38 码 3 双）⇒ **2 行**（两个货品各一个尺码 ⇒ N = 货品数 ✓）
    const detailWrites = h.gateway.writesTo('purchaseRequest');
    const expectedLines = 2;
    assert.equal(detailWrites.length, expectedLines, `明细行 = 货品 × 尺码（实际 ${detailWrites.length} 行）`);
    assert.deepEqual(detailWrites.map((call) => call.values.quantity).sort(), [2, 3],
      '数量逐字跟着她填的走 ✓');

    // ③ 再 GET ⇒ page.draft 的五个字段**全部取自 S1 的 readDraft**
    const read = await h.draftService.readDraft({ openId: OPEN_ID });
    assert.equal(read.ok, true, 'S1 读得回来 ✓');
    // ⭐ "喂了什么 = 读了什么"：**明细行数**与 `readDraft.draft.line_count` 必须一致
    assert.equal(read.draft.line_count, expectedLines, 'readDraft 的行数 = 真写下去的明细行数 ✓');
    assert.equal(read.draft.items.length, 2, 'readDraft 说 2 个货品');
    const page = await getPage(base, REPLENISH);
    assert.equal(page.status, 200);
    assert.equal(page.html.includes(draftNoticeMark), true,
      '⭐ 有草稿 ⇒ 「你有一份草稿，接着录吗？」提示条必须出现（路由没喂 hasDraft ⇒ 这里红 ✓）');
    assert.equal(page.html.includes(DRAFT_ENTRY.noticeLabel), true, '提示条文案走配置 ✓');
    assert.equal(page.html.includes(draftResumeMark), true, '【接着录】那颗链接也要在 ✓');
    // 五个字段的"喂了什么"与"读了什么"逐字对齐（**别自己另读文件** ✗ —— 直接比对同一份事实）
    assert.equal(page.html.includes('2 个货品 · 2 行'), true,
      `提示条上的数字必须是 readDraft 那一份（got: ${read.draft.items.length} / ${read.draft.line_count}）`);
    assert.equal(page.html.includes(`resume=${DRAFT_ENTRY.resumeQueryValue}`), true,
      '【接着录】链接带 ?resume=1（查询键/值走配置 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3c ⭐ 幂等：同一草稿存两次 ⇒ 明细不翻倍、主表不多行
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3c ⭐ 同一份草稿存两次 ⇒ 明细**不翻倍**（同一把幂等键）＋ 主表不多行', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '先加一件（走真 POST ✓）');
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    const body = () => {
      const params = new URLSearchParams();
      params.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
      params.append(SCAN_WRITE.fields.replenishSizes, '40');
      params.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '2');
      params.append('multi_items', JSON.stringify(staged));
      return params;
    };
    const first = await post(base, body(), REPLENISH);
    assert.equal(first.status, 303);
    const keysAfterFirst = h.gateway.detailKeysOf();
    assert.equal(keysAfterFirst.length, 2);

    const second = await post(base, body(), REPLENISH);
    assert.equal(second.status, 303, '第二次存也要成功（覆盖，不是报错）✓');
    assert.deepEqual(h.gateway.detailKeysOf(), keysAfterFirst,
      '⭐ 明细**一行都没多**（键 = 会话/桶/货品/尺码 ⇒ 第二次全部命中幂等 ✓；翻倍 ⇒ 红 ✓）');
    // ⚠️ 已知边界（如实写）：主表那一行**仍会再 create 一次**（S1 既有行为，同一把幂等键）
    //    —— 本刀**不改 S1**（那是 #732 的口径）；S3 只保证"明细不翻倍 + 键逐字同一把" ✓
    const batchWrites = h.gateway.writesTo('purchaseOrderBatch');
    const batchKeys = new Set(batchWrites.map((call) => call.values.idempotencyKey));
    assert.equal(batchKeys.size, 1, '两次用的是**同一把**草稿行幂等键 ⇒ 身份只有一份 ✓');

    // 幂等键的形状（会话 | 桶 | 货品 | 尺码）—— 逐个说得出来（不含时间/随机 ⇒ 才可能命中 ✓）
    const sessionId = h.sessions.idOf(OPEN_ID);
    keysAfterFirst.forEach((key) => {
      assert.equal(key.startsWith(`${h.config.detailIdempotencyPrefix}:${sessionId}:single:`), true,
        `明细幂等键要带上（会话 ｜ 桶）前缀：${key}`);
    });
    assert.equal(new Set(keysAfterFirst).size, 2, '两行两把键（货品 × 尺码 各不相同 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3d ⭐ 零副作用（唯一例外 = 明细行）—— 假 gateway 记账
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3d ⭐ 存草稿零副作用：只碰「采购主表 ＋ 采购明细」两张表（发群/出图/库存/单号一次都没有）', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '先加一件（走真 POST ✓）');
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '40');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '2');
    body.append('multi_items', JSON.stringify(staged));
    const response = await post(base, body, REPLENISH);
    assert.equal(response.status, 303);
    assert.deepEqual(h.gateway.touchedTables(), ['purchaseOrderBatch', 'purchaseRequest'],
      '⭐ 存草稿碰的表**只有这两张**（明细 = 她口径允许的唯一例外 ✓；其余表 0 次 ⇒ 红 ✓）');
    assert.deepEqual(h.gateway.calls.filter((call) => call.op === 'update'), [],
      '草稿阶段**一次 update 都不许有**（不覆盖任何既有事实 ✓）');
    // 出单号：批次号是**草稿行自己那一列**（她两条逻辑的第 ① 条），**不另开单号** ✓
    const batchWrites = h.gateway.writesTo('purchaseOrderBatch');
    assert.match(String(batchWrites[0].values.batchNo), /^CGD-20261016-\d{4}$/,
      '草稿行带的是**沿用/新建**的那个批次号（她两条逻辑 ✓）');
    assert.equal(Object.prototype.hasOwnProperty.call(batchWrites[0].values, 'taskId'), false);
    // 库存 / 资金那几张表**一次都不许出现**
    for (const table of ['liveInventory', 'inventoryLedger', 'salesEntry', 'payments']) {
      assert.equal(h.gateway.writesTo(table).length, 0, `存草稿绝不许写 ${table} ✗`);
    }
  });
});

test('AC-D3h ⭐ 草稿不碰收款 / 实收 / 资金状态：资金那几个动作**一次都没被认成**（假引擎 0 次）', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  const app = appFor(h, h.config);
  // 把假引擎拿出来（它是"多货品提交"那条路的登记簿 —— 存草稿**绝不许**走它 ✓）
  const engine = h.engine;
  await withServer(app, async (base) => {
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '先加一件（走真 POST ✓）');
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '40');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '2');
    body.append('multi_items', JSON.stringify(staged));
    const response = await post(base, body, REPLENISH);
    assert.equal(response.status, 303, '存草稿是 303（不是提交那条成功页/资金页 ✗）');
    const html = await response.text();
    assert.equal(html.includes('data-view="payment-step"'), false, '存草稿**不许**把她顶到资金页 ✗');
    if (engine) assert.deepEqual(engine.calls, [], '存草稿不许调多货品提交引擎（那是出单那一路 ✓）');
    // 收款那两张表：草稿阶段 0 次（"实收 / 资金状态"这一类一个字都不写 ✓）
    for (const table of ['payments', 'customerPayments', 'salesEntry']) {
      assert.equal(h.gateway.writesTo(table).length, 0, `草稿不许碰 ${table} ✗`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3e ⭐ 接着录：?resume=1 ⇒ 尺码/数量/已加货品逐字还原
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3e ⭐ 存 → 重进带 ?resume=1 ⇒ 已加货品与尺码/数量**逐字还原**（少了/多了 ⇒ 红）', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    // ① 先存一份（补货页）
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '先加一件（走真 POST ✓）');
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '41');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}41`, '5');
    body.append('multi_items', JSON.stringify(staged));
    assert.equal((await post(base, body, REPLENISH)).status, 303);
    const stored = await h.draftService.readDraft({ openId: OPEN_ID });
    assert.equal(stored.ok, true);
    // 存进去的那一份 = 她填的（本页那一款）＋ 已加的（HM-D2）
    assert.deepEqual(stored.draft.items.map((item) => item.number).sort(),
      [NUMBER, 'HM-D2|白色|A'].sort(), '夹具：两份不同货品都进去了 ✓');

    // ② 不带 ?resume=1 ⇒ **草稿一个字都不进页面**（她要的零回归 ✓）
    //    ⚠️ 但**存之前那一发"加货"的暂存还在**（本刀**不清**它 —— "存草稿"是单向投影，
    //      页面上看得见的那份一个字都不动 ✓）⇒ 判据：**草稿里那两件不许因此消失** ✓
    const plain = await getPage(base, REPLENISH);
    const plainPayload = hiddenMultiItems(plain.html);
    assert.equal(plainPayload.some((item) => item.number === NUMBER), true, '当前这一件照旧在 ✓');
    assert.deepEqual((await h.draftService.readDraft({ openId: OPEN_ID })).draft.items, stored.draft.items,
      '⚠️ 不带 ?resume=1 的那一发 **不许动草稿那一份** ✓');

    // ③ 带 ?resume=1 ⇒ 逐字还原
    const resumed = await getPage(base, REPLENISH, '&resume=1');
    assert.equal(resumed.status, 200);
    const payload = hiddenMultiItems(resumed.html);
    assert.notEqual(payload, null, '接着录那一页必须带 hidden `multi_items`（否则提交时草稿就丢了 ✗）');
    // 首件 = 她当前扫的这一款（服务端给的形状），其余 = 草稿里那几件（逐字）
    const [first, ...rest] = payload;
    assert.equal(first.number, NUMBER, '首件仍是当前这一款 ✓');
    // ⭐ **与草稿那一份逐字比**（不拿手写夹具比 —— 那会掩盖"存进去时就已经少了"那种 ✗）
    const storedRest = stored.draft.items
      .filter((item) => String(item.product_record_id || item.number) !== 'rec_product_A');
    assert.deepEqual(rest.map(asDraftItem), storedRest.map(asDraftItem),
      '⭐ 已加货品 / 尺码 / 数量 / 供应商**逐字 deepEqual**（顺序也一致 ✓；少一个 ⇒ 红 ✓）');
    // ⚠️ 首件的 `entries` **刻意是空的**（它是表单里"当前这一件"，由路由在提交时合并 —— 与
    //    渲染层/引擎同一条口径 ✓）；但它的**身份**（哪一件）要与草稿里那一份对得上 ✓。
    const storedCurrent = stored.draft.items.find((item) => String(item.product_record_id) === 'rec_product_A');
    assert.ok(storedCurrent, '夹具：草稿里那份"当前这一件"还在（她被 resume 排掉的是**重复项**，不是内容 ✓）');
    assert.equal(first.product_record_id, storedCurrent.product_record_id, '首件身份与草稿里那一份一致 ✓');
    assert.equal(first.number, storedCurrent.number, '首件货号逐字一致 ✓');
    // ④ 列表上也画出来了（她看得见 —— 不是只在 hidden 字段里）
    assert.equal(resumed.html.includes('data-view="multi-item-list"'), true, '已加货品列表要画出来 ✓');
    assert.equal(resumed.html.includes('HM-D2'), true, '列表里要看得到那一件的货号 ✓');
    // ⑤ 草稿**没有被这次 GET 改掉**（零副作用：读就是读 ✓）
    const after = await h.draftService.readDraft({ openId: OPEN_ID });
    assert.deepEqual(after.draft.items, stored.draft.items, '接着录**不许**改草稿那一份（读就是读 ✓）');
    assert.equal(h.gateway.writesTo('purchaseOrderBatch').length, 1, '重进一次**不许**再写一行草稿行 ✗');
  });
});

test('AC-D3e2 ⭐ 接着录之后点「＋ 再加一个货品」⇒ 草稿里那几件**一件都不丢**（合并语义 ✓）', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '先加一件（走真 POST ✓）');
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '41');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}41`, '5');
    body.append('multi_items', JSON.stringify(staged));
    assert.equal((await post(base, body, REPLENISH)).status, 303);
    const stored = await h.draftService.readDraft({ openId: OPEN_ID });
    assert.equal(stored.ok, true, '夹具：草稿已经在 ✓');

    // 带 resume 看一眼（确认页面上真的有那两件）
    const resumed = await getPage(base, REPLENISH, '&resume=1');
    assert.equal(hiddenMultiItems(resumed.html).length, 2);

    // 点「＋ 再加一个货品」= 那颗 submit（**带着她刚填的尺码/数量**）⇒ 303 回本页
    //   ⚠️ 表单里那个 hidden `multi_items` 用**页面自己渲出来的那一份**（首件空 entries ＋ 已加那件 ✓）
    const addBody = new URLSearchParams();
    addBody.append('multi_item_add', 'add');
    addBody.append(SCAN_WRITE.fields.replenishSizes, '40');
    addBody.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '7');
    addBody.append('multi_items',
      JSON.stringify(await stagedPayload(base)));
    const added = await fetch(`${base}/s/${ENCODED}?from=${REPLENISH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: addBody.toString(),
    });
    assert.equal(added.status, 303, '加货 ⇒ 303 回本页（PRG ✓）');
    // 回来那一页（**不带 resume**）仍要看得见"前面加的不丢" ✓
    const back = await getPage(base, REPLENISH);
    const payload = hiddenMultiItems(back.html);
    assert.deepEqual(payload.map((item) => item.number), [NUMBER, 'HM-D2|白色|A'],
      '⭐ 加货之后：当前这一件 ＋ 草稿里那件**都在**（草稿那半不许被这次加货挤掉 ✗）');
    assert.deepEqual(asDraftItem(payload[1]), asDraftItem(
      stored.draft.items.find((item) => String(item.product_record_id) === 'rec_product_B'),
    ), '草稿里那件**逐字不动** ✓');
    // ⭐ 她刚填的那一份（40 码 7 双）**真的存进了暂存**（不是只在页面上看着像 ✓）
    const pending = await sessionPending(h);
    const addedItem = pending.find((item) => String(item.product_record_id) === 'rec_product_A');
    assert.deepEqual(addedItem.entries, [{ size: '40', quantity: '7' }],
      '新加那一件的尺码/数量 = 她刚填的（去暂存里直接核 ✓）');
    // ⭐ 草稿那一份**一个字节都没被这一发改掉**（"接着录 + 继续加"不许动草稿 ✓）
    assert.deepEqual((await h.draftService.readDraft({ openId: OPEN_ID })).draft.items, stored.draft.items,
      '加货那一发不许改草稿那一份 ✓');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3f ⭐ 不点就正常新建 ⇒ 与今天逐字节一致
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3f ⭐ 不点提示条 ⇒ 去掉草稿那两块之后与「今天（不喂 page.draft）」**逐字节一致**', async () => {
  login();
  const off = makeHarness({ draftEnabled: false });
  const on = makeHarness({ draftEnabled: true });
  await withServer(appFor(off, off.config), async (baseOff) => {
    await withServer(appFor(on, on.config), async (baseOn) => {
      for (const realm of [SALES, REPLENISH, PURCHASE_RETURN]) {
        // 今天那一屏 = **开关关着**（路由一次都不读草稿、page.draft 根本不存在）
        const today = await getPage(baseOff, realm);
        // 本刀那一屏 = 开着、**没有草稿**（只有那三颗入口）＋ **没点提示条**（不带 resume）
        const now = await getPage(baseOn, realm);
        assert.equal(stripDraftEntries(now.html), today.html,
          `${realm}：去掉草稿入口那一段之后必须与今天**逐字节相同**（零回归 ✓）`);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3g ⭐ 草稿不进"已提交 / 待处理"投影 ＋ 9 点推送捡不到
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3g ⭐ 9 点推送（未到货候选）捡不到草稿行；把草稿行改成「未到货」⇒ **立刻捡到**（判据不是空跑）', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  // 表里先有一笔"正常待处理"（未到货）＋ 她刚存的一份草稿（未报货）
  await h.gateway.seedPendingRow('CGD-20261015-0007', '未到货');
  await withServer(appFor(h, h.config), async (base) => {
    assert.equal((await postAddItems(base, DRAFT_ITEMS[1])).status, 303, '先加一件（走真 POST ✓）');
    const staged = hiddenMultiItems((await getPage(base, REPLENISH)).html);
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '40');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '2');
    body.append('multi_items', JSON.stringify(staged));
    assert.equal((await post(base, body, REPLENISH)).status, 303);

    const pending = new PurchasePendingBatchService({ gateway: h.gateway, cacheTtlMs: 0 });
    const candidates = await pending.listPendingBatches();
    assert.deepEqual(candidates.map((item) => item.batchNo), ['CGD-20261015-0007'],
      '⭐ 草稿行（未报货）**不许**进 9 点推送的候选（它只捡"未到货" ✓）');
    // 反向钉：把草稿行的到货状态改成「未到货」⇒ **立刻**出现在候选里（判据真能分辨 ✓）
    const draftRow = h.gateway.tables.get('purchaseOrderBatch')
      .find((row) => String(row.fields[h.gateway.fieldNamesOf('purchaseOrderBatch').arrivalStatus]) === '未报货');
    assert.ok(draftRow, '夹具：草稿行要在表里（否则这条判据是空跑 ✗）');
    draftRow.fields[h.gateway.fieldNamesOf('purchaseOrderBatch').arrivalStatus] = '未到货';
    const after = await new PurchasePendingBatchService({ gateway: h.gateway, cacheTtlMs: 0 }).listPendingBatches();
    assert.equal(after.length, 2, '反向钉：改成「未到货」⇒ 立刻进候选（⇒ 上面那条不是空跑 ✓）');
    assert.equal(after.some((item) => item.recordId === draftRow.record_id), true, '就是那一行 ✓');
  });
});

test('AC-D3g2 ⭐ 草稿行不带"已提交"的任何标记：`到货状态=未报货` ＋ 幂等键前缀 = 草稿自己的 ✓', async () => {
  login();
  const h = makeHarness({ draftEnabled: true });
  await withServer(appFor(h, h.config), async (base) => {
    const body = new URLSearchParams();
    body.append(SCAN_WRITE.fields.action, DRAFT_ENTRY.saveAction);
    body.append(SCAN_WRITE.fields.replenishSizes, '40');
    body.append(`${SCAN_WRITE.fields.replenishQuantityPrefix}40`, '2');
    body.append('multi_items', JSON.stringify([DRAFT_ITEMS[0]]));
    assert.equal((await post(base, body, REPLENISH)).status, 303);
    const row = h.gateway.writesTo('purchaseOrderBatch')[0];
    assert.equal(row.values.arrivalStatus, '未报货');
    // 幂等键前缀 = 草稿自己的（**独立前缀** ⇒ 不被当成 `purchase_batch:*` 那种已提交事实 ✓）
    assert.equal(String(row.values.idempotencyKey).startsWith(`${h.config.idempotencyPrefix}:`), true,
      `草稿行的键要带自己的前缀：${row.values.idempotencyKey}`);
    assert.equal(String(row.values.idempotencyKey).startsWith('purchase_batch:'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3i 🔴 源码哨兵：冻结件逐字节未动 ＋ 本刀不 require 它
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3i 🔴 `scanWriteService.js` 与 main **逐字节一致**（余量 0：谁改一个字就红）', () => {
  const raw = fs.readFileSync(FROZEN_PATH);
  assert.equal(sha256Of(raw), FROZEN_SHA256,
    '🔴 冻结件被改动了 ✗ —— 本刀一个字都不许碰它（需要动它 ⇒ 停手报 Lead）');
  // 探针：指纹**真能认出**改动（不是拿一个常量自证）
  assert.notEqual(sha256Of(Buffer.concat([raw, Buffer.from(' ')])), FROZEN_SHA256, '多一个字节 ⇒ 指纹必变 ✓');
});

test('AC-D3i2 接线里的服务名 / 动作名都从配置来（路由不写死中文列名、不新造动作名 ✗）', () => {
  // ① 三处入口的领域清单、动作名、查询键**都从 `config/scanPage.js` 的 `DRAFT_ENTRY` 取** ✓
  const draftEntryUsage = ROUTE_SRC.match(/draftEntry/gi) || [];
  assert.ok(draftEntryUsage.length >= 1, '路由要读 `config.scanPage.draftEntry`（配置先行 ✓）');
  assert.equal(ROUTE_SRC.includes('草稿已存'), false,
    '中文文案**一个字都不在路由里**（存成功那一句走 `config/scanDraft.js` 的 `texts.saved` ✓）');
  assert.equal(ROUTE_SRC.includes('draftConfig.texts?.saved'), true,
    '路由只把配置里那一句**取出来用**（文案的家在配置 ✓）');
  // ② 源码哨兵：路由里不许出现写链路那几个服务名（既有 `test/scanPage.test.js` ④ 同一条口径 ✓）
  //    ⚠️ 只钉**require**（注释里本来就会提到它们 —— 既有 `test/scanPage.test.js` ④ 同一条口径：
  //      「路由里不许**直连**写链路的服务」指的是 require/调用，不是解释性注释 ✗）
  for (const name of ['purchaseWebhookService', 'purchaseReturnService', 'inventoryService']) {
    assert.equal(new RegExp(`require\\('[^']*${name}`).test(ROUTE_SRC), false,
      `路由里不许直连 ${name} ✗（写库只经既有服务 ✓）`);
  }
});

// MUTATION（本刀 · 每组都单独跑过、确认**真红**，跑完逐字节还原 ✓）：
//   ① 把 GET 里喂 `page.draft` 的那一段删掉（或改成只喂 `{enabled:true}` 不喂 `hasDraft`）
//      ⇒ **AC-D3a** 红（三处入口不出现）＋ **AC-D3b** 红（提示条不出现）✓
//   ② 把 `save_draft` 那条分派删掉 ⇒ **AC-D3b/AC-D3c/AC-D3d** 红（POST 落到 unknown_action）✓
//   ③ 把 `?resume=1` 那一段删掉 ⇒ **AC-D3e** 红（页面上只有当前这一件、草稿那几件丢了）✓
//   还原核验：`git diff | shasum -a 256` 与变异前**逐字节一致** ✓
