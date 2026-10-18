'use strict';
/**
 * ⭐⭐ 退货「**出图发群**」接线（修一个线上真缺陷）的验收标准。
 *
 * ── 线上铁证（照抄，别重新排查 ✗）────────────────────────────────────────────
 *   · 她 **2026-10-16 20:12:04** 那一次**真退货**的线上日志：
 *     `{"level":"warn","event":"scan.purchase_return.image_failed","reason":"no_image_pipeline",
 *       "batch_no":"CGD-20261016-0001","note":"没有接出图链路（用例 / 未接线）"}`
 *     —— 而 20:11:30 有 `purchase.return.batch.record_ensured` ⇒ **账走了、图一张没发** ✗；
 *   · 根因（只读核过，全仓只有这一处读它）：`services/scanWriteService.js:239`
 *     的 `...(options.purchaseReturnOptions || {})` —— 三条生产装配处
 *     （`routes/scanPage/index.js` / `routes/workbench.js` / `routes/larkEvents.js`）**都没传**它
 *     ⇒ `purchaseReturnService` 的 `webhooks` 恒为空 ⇒ 必然走 `no_image_pipeline` ✗。
 *     ⚠️ 单货品退货**同样**中招（老缺口，不是多货品那一刀引入的）。
 *
 * ── 改前逐字 → 改后逐字 → 依据 ──────────────────────────────────────────────
 *   · **改前逐字**（`routes/scanPage/index.js`）：
 *       `const writeService = writeConfig && options.writeService !== false`
 *       `  ? (options.writeService || createScanWriteService({ gateway, config: writeConfig }))`
 *       `  : null;`
 *   · **改后逐字**：同一个三元里那一次 `createScanWriteService` 多了
 *       `purchaseReturnOptions: resolvePurchaseReturnImageOptions({ gateway, config: …, overrides: … })`
 *     （装配件 = 新文件 `services/purchaseReturnImageWiring.js`：默认给真 `PurchaseWebhookService`，
 *      与补货 / 验收**同一个类、同一个 `deliverSupplierImages`** ✓ 不发明新写法 ✗）。
 *   · **依据** = 业务负责人 2026-10-16 明确拍板「**修**」（这张卡）＋ 她 2026-10-05
 *     「**一定要配置先行**」（开关 / 群 id 全在 `config/**` ✓）。
 *
 * ── 本文件的判据（**先写后做** ✓；每条都能真红 ✓）────────────────────────────
 *   AC-RI1 ⭐ **线上同路径**：扫码页退货 POST（**真路由 → 真引擎 → 真写入件 → 真
 *          `deliverSupplierImages`**；只假**出图 / IM / 网关**）⇒ 装配之后 `webhooks` **非空**
 *          ⇒ **不再出现 `no_image_pipeline`** ✓
 *   AC-RI2 **单货品**：1 件 ⇒ **1 张图** ＋ 「单据」1 张 ＋ 群消息 2 条（与既有一致 ✓）
 *   AC-RI3 **多货品 / 多供应商**：2 家 ⇒ **按供应商分 2 组 · 2 张图** ✓ ＋ **幂等**（同一份提交重放
 *          ⇒ 图 +0 · 群 +0 · 附件 +0 ✓）
 *   AC-RI4 🔴 **反向哨兵 / 探针**：把出图开关**关掉**（= 装配那几行不接）⇒ **`no_image_pipeline`
 *          出现 ⇒ 本文件的判据会红** ✓（证明判据不是空跑 ✓）
 *   AC-RI5 🔴 **冻结件逐字节没动**：`services/scanWriteService.js` 的 sha256 与 main 一致 ✓
 *          （本卡只在**装配处传参**，一个字都没碰它 ✗）
 *   AC-RI6 🔴 **源码哨兵**：`routes/scanPage/index.js` 里出现的是
 *          `purchaseReturnOptions:`（装配处真的接上了）＋ 路由**代码行**里**没有**写链路服务名
 *          （RT5 / AC-D3i2 那两条既有哨兵的口径 ✓ 不放宽 ✗）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/purchaseWebhookService` 的构造函数会取凭证（**本文件零真表调用**，凭证是哑值）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_return_image';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'return_image_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { resolvePurchaseReturnImageOptions } = require('../src/services/purchaseReturnImageWiring');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { createPurchaseReturnService } = require('../src/services/purchaseReturnService');
const { PurchaseOrderBatchService, attachmentNames } = require('../src/services/purchaseOrderBatchService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');
const { documentFileNameOf } = require('../src/services/supplierSplitService');
const { scanPageSource } = require('./support/scanPageSource');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const SCAN_WRITE_SERVICE_PATH = path.join(SERVER_SRC, 'services', 'scanWriteService.js');
/** 与 `test/scanWriteServiceFrozen.test.js` / `test/purchaseReturnMultiItem.test.js` **同一个值** ✓。 */
// ⭐⭐ 2026-10-16 成对迁移（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：sha `b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3`（1770 行 · 冻结件 `deferFunds` 那一版）
//   改后逐字：sha `b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3`（1770 行 · 货那一跑**照扣库存**）
//   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：…**如果是现货，就是要扣库存**；
//          如果是预订，就不扣库存，等二次交付的时候再扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」
//          ⇒ 冻结件只动批准的 5 行（`deliverStockLines` 形参/转发 ＋ `:1318` 三元 ＋ 两处注释）✓
//          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
const FROZEN_SCAN_WRITE_SHA256 = 'b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3';

const OPEN_ID = 'ou_return_image';
const SESSION_SECRET = 'return-image-test-session-secret';
const NUMBER_A = 'KA|黑色|A';
const NUMBER_B = 'KB|黑色|A';
const SANDBOX_CHAT_ID = 'oc_return_image_group';

/** 两个货品、两个不同供应商（AC-RI3 的输入）。 */
const PRODUCT_A = {
  record_id: 'prod_A',
  fields: { 编号: NUMBER_A, 货号: 'KA', 颜色: { text: '黑色', record_ids: ['c1'] }, 类别: 'A', 单价: 399, 供应商: ['sup_a'] },
};
const PRODUCT_B = {
  record_id: 'prod_B',
  fields: { 编号: NUMBER_B, 货号: 'KB', 颜色: { text: '黑色', record_ids: ['c1'] }, 类别: 'A', 单价: 359, 供应商: ['sup_b'] },
};
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const liveUnit = (id, product, size, state = '门盒') => ({
  record_id: id, fields: { 编号: [product], 尺码: [`size_${size}`], 所属状态: state },
});
const seedTables = (overrides = {}) => ({
  product: [PRODUCT_A, PRODUCT_B],
  sizeManagement: SIZE_RECORDS,
  supplier: [
    { record_id: 'sup_a', fields: { 供应商名称: '甲供应商' } },
    { record_id: 'sup_b', fields: { 供应商名称: '乙供应商' } },
  ],
  behavior: [
    { record_id: 'bh_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    {
      record_id: 'bh_return',
      fields: {
        行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true,
      },
    },
  ],
  liveInventory: [
    liveUnit('live_a41_box', 'prod_A', 41, '门盒'),
    liveUnit('live_b41_box', 'prod_B', 41, '门盒'),
  ],
  inventoryLedger: [],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  ...overrides,
});

/**
 * 内存假网关（与 `test/purchaseReturnMultiItem.test.js` 同一种替身）：语义键 → 物理列名走真
 * schema（**写错语义键当场抛** ⇒ "发明列"立刻被抓住 ✓）；附件列像飞书那样把文件名留在上面
 * （= "这一组已经出过了"的物理基础 ✓）。
 */
const createFakeGateway = (tables = seedTables()) => {
  const calls = { create: [], update: [], upload: [], listAll: [] };
  let sequence = 0;
  const tokenNames = new Map();
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    const docField = table.fields.document;
    if (docField && Array.isArray(out[docField])) {
      out[docField] = out[docField].map((item) => ({
        file_token: item?.file_token, name: item?.name || tokenNames.get(item?.file_token) || '',
      }));
    }
    return out;
  };
  return {
    calls,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      calls.listAll.push(key);
      return [...(tables[key] || [])];
    },
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
      calls.create.push({ table: key, values: { ...values }, record_id: record.record_id });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      calls.update.push({ table: key, record_id: id, fields });
      return record;
    },
    // 扣库存会把「实时库存」里那几条记录删掉（既有库存引擎的语义）；别的表不许删。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      const before = (tables[key] || []).length;
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      return { deleted: before !== (tables[key]).length };
    },
    uploadAttachment: async (filePath) => {
      calls.upload.push(path.basename(String(filePath || '')));
      const token = `file_token_${calls.upload.length}`;
      tokenNames.set(token, path.basename(String(filePath || '')));
      return token;
    },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `return-image-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 假飞书 IM：只把"发了什么"记下来（**出图 / 发群那一整条仍然是真的** ✓）。 */
const fakeLarkClient = (messages) => ({
  im: {
    image: { create: async () => ({ image_key: 'img_key' }) },
    message: {
      create: async (payload) => {
        messages.push({ kind: 'create', ...payload });
        return { code: 0, msg: 'ok', data: { message_id: `m_${messages.length}`, thread_id: 'th_1' } };
      },
      reply: async (payload) => {
        messages.push({ kind: 'reply', ...payload });
        return { code: 0, msg: 'ok', data: { message_id: `m_${messages.length}`, thread_id: 'th_1' } };
      },
    },
  },
});

/** 结构化日志的出口就是 console.log/warn/error（`src/utils/logger.js`）⇒ 捕获才能断言"记了/没记"。 */
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

/**
 * ⭐⭐ 一套**真的在跑**的退货链路 —— **用生产那套装配方式**：
 *   `createScanPageRouter(...)` ⇒ 路由自己 `createScanWriteService({gateway, config, purchaseReturnOptions})`
 *   ⇒ 路由**自己**装出图链路（本用例**只**换掉**出图 / IM / 群**这三样：AC-RI1 说的"只假这些" ✓）。
 *   🔴 **不注入 `writeService`**、也**不注入 `webhooks`** —— 否则测的就不是装配，而是替身 ✗。
 */
const createHarness = (options = {}) => {
  const gateway = createFakeGateway(options.tables || seedTables());
  const dirs = {
    session: tempDir('session'),
    ret: tempDir('return-task'),
    replenish: tempDir('replenish-task'),
    webhook: tempDir('webhook-task'),
  };
  const renders = [];
  const messages = [];
  const webhookOptions = {
    client: fakeLarkClient(messages),
    images: {
      render: async (input) => {
        renders.push(input);
        return Buffer.from(`png:${input.supplierName || ''}`);
      },
    },
    sandboxChatId: SANDBOX_CHAT_ID,
    store: new JsonTaskStore({ dir: dirs.webhook, idField: 'task_id' }),
    batchLocator: { rememberGroupMessage: async () => ({ ok: true }) },
    ...(options.webhookOptions || {}),
  };
  const writeConfig = {
    ...SCAN_WRITE,
    // ⚠️ 键名逐字是 `session`（单数 ✓ —— `config/scanWrite.js` 的 `SESSION`）：写错成 `sessions`
    //    会**静默**用回 `server/data/scan_sessions`，用例之间就会互相污染（踩过一次 ✗）。
    session: { ...SCAN_WRITE.session, dir: dirs.session },
    // ⚠️ 临时目录只是为了"别把测试数据写进仓库工作区"（生产用的是配置里的缺省目录 ✓）——
    //    装配方式本身**逐字就是生产那一套** ✓。
    replenish: { ...SCAN_WRITE.replenish, taskDir: dirs.replenish },
    purchaseReturn: {
      ...SCAN_WRITE.purchaseReturn,
      taskDir: dirs.ret,
      ...(options.purchaseReturn || {}),
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: options.lookup || (async () => view()) },
    gateway,
    writeConfig,
    // ⭐ 只假**出图 / IM / 群**（网关在上一行给了内存替身）✓
    purchaseReturnImage: { webhookOptions },
  }));
  return {
    gateway,
    app,
    renders,
    messages,
    dirs,
    webhookOptions,
    tables: gateway._tables,
    cleanup: () => Object.values(dirs).forEach(rmDir),
  };
};

const entriesOf = (harness, tableKey) => harness.tables[tableKey] || [];
const documentNamesOf = (harness) => attachmentNames(
  (entriesOf(harness, 'purchaseOrderBatch')[0] || {}).fields?.['单据'],
);
const documentSuffix = SCAN_WRITE.purchaseReturn.fileNameSuffix;

// ── 路由夹具（真链路：GET 拿页面给出的 submit_key ⇒ POST 提交）────────────────
const sessionCookie = (openId = OPEN_ID) => {
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
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER_A,
  item_no: 'KA',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 0,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 0 }], total: 0, missing: true },
    { size_text: '41', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '42', cells: [{ count: 0 }], total: 0, missing: true },
  ],
  missing_count: 2,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 20:12',
  product_record_id: 'prod_A',
  ...overrides,
});
/** `GET` 页面里那颗隐藏的**幂等键**（服务端会话给出的那一串 —— 她就是带着它提交的 ✓）。 */
const submitKeyOf = (html) => {
  const matched = html.match(/name="submit_key"[^>]*value="([^"]*)"/)
    || html.match(/value="([^"]*)"[^>]*name="submit_key"/);
  return matched ? matched[1] : '';
};
const getReturnPage = async (base, number = NUMBER_A) => {
  const response = await fetch(`${base}/s/${encodeURIComponent(number)}?from=purchase_return`, {
    headers: { cookie: sessionCookie() },
  });
  return { status: response.status, html: await response.text() };
};
const multiItemsJson = (groups) => JSON.stringify(groups.map((group) => ({
  product_record_id: String(group.product_record_id || ''),
  number: String(group.number || ''),
  item_no: String(group.item_no || ''),
  color: String(group.color || ''),
  supplier_record_id: String(group.supplier_record_id || ''),
  entries: (group.entries || []).map((entry) => ({ size: String(entry.size), quantity: Number(entry.quantity) })),
})));
const postReturn = async (base, {
  number = NUMBER_A, openId = OPEN_ID, form = {}, multiItems = null,
} = {}) => {
  const body = new URLSearchParams({
    action: SCAN_WRITE.actions.purchaseReturn,
    purchase_amount: '399',
    ...form,
  });
  if (multiItems) body.set(MULTI_ITEM_ORDER.field, multiItemsJson(multiItems));
  return fetch(`${base}/s/${encodeURIComponent(number)}?from=purchase_return`, {
    method: 'POST',
    headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
};
/** 走**真链路**提交一次（GET 拿 key ⇒ POST ⇒ 等后台那一跑写完）✓ 返回页面给的 key。 */
const submitThroughRoute = async (harness, { base, number = NUMBER_A, form = {}, multiItems = null } = {}) => {
  const page = await getReturnPage(base, number);
  assert.equal(page.status, 200, '退货那一页必须渲得出来（否则这条判据是空跑 ✗）');
  const submitKey = submitKeyOf(page.html);
  assert.ok(submitKey, '页面必须带 `submit_key`（服务端会话给的幂等键 ✓）');
  // ⚠️ 键名逐字是 `submit_key`（`config/scanWrite.js` 的 `FIELDS.submitKey` ✓）：
  //    写成 `submitKey` ⇒ 路由读不到 ⇒ 写层判"这一页放太久了"（真踩过一次 ✗）。
  const response = await postReturn(base, { number, form: { ...form, submit_key: submitKey }, multiItems });
  assert.equal(response.status, 200, '退货 ⇒ 先回统一成功页（她 2026-10-16 的口径 ✓）');
  await waitForPendingPurchaseBackgrounds();
  return submitKey;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-RI1 ⭐⭐ 线上同路径：装配之后 `webhooks` 非空 ⇒ 不再 `no_image_pipeline`
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RI1 ⭐⭐ 扫码页退货 POST（真路由→真引擎→真写入件→真 deliverSupplierImages）⇒ 装配的 webhooks 非空 ⇒ 不再 no_image_pipeline', async () => {
  login();
  const h = createHarness();
  const logs = captureLogs();
  try {
    // ① 装配本身（**生产那套装配**用的同一个函数、同一份配置）⇒ 给的是**真**出图链路 ✓
    const options = resolvePurchaseReturnImageOptions({
      gateway: h.gateway, config: SCAN_WRITE.purchaseReturn.imageDelivery,
    });
    assert.equal(options.webhooks instanceof PurchaseWebhookService, true,
      '🔴 装配必须给出**真** `PurchaseWebhookService`（给空 / 给别的 ⇒ 线上还是 no_image_pipeline ✗）');
    assert.equal(typeof options.webhooks.deliverSupplierImages, 'function',
      '出图那一步必须是既有的 `deliverSupplierImages`（**不发明第二套** ✗）');
    // 探针：关掉配置 ⇒ 一个键都不接（证明上面那条不是"构造函数自己变出来的"✓）
    assert.deepEqual(
      Object.keys(resolvePurchaseReturnImageOptions({ gateway: h.gateway, config: { enabled: false } })), [],
      '配置关着 ⇒ 装配**什么都不接**（写入口维持原状、并如常记 no_image_pipeline ✓）',
    );

    // ② 真链路（扫码页那一页 GET 出来的 key ⇒ POST ⇒ 后台那一跑写完）
    await withServer(h.app, async (base) => {
      await submitThroughRoute(h, { base, form: { return_sizes: '41', return_qty_41: '1' } });
    });
    // ③ 出图 / 发群那一整条**真的跑过**（她 20:12 那次缺的正是这一步）
    assert.equal(h.renders.length, 1, '1 件退货 ⇒ 出图那一步被调了一次 ✓');
    assert.equal(h.messages.length, 2, '图 + @文字（真的发了两条 ✓）');
    assert.ok(logs.events('purchase.request.image.group_sent').length >= 1,
      '⭐ 出图链路真的跑到"发进群"那一步（`purchase.request.image.group_sent` ✓）——'
      + '这是"接线接上了"的**物理证据**（改前线上永远没有它 ✗）');
    // ④ 🔴 反向：那一条线上告警**必须消失**
    assert.equal(logs.lines.some((line) => line.includes('"reason":"no_image_pipeline"')), false,
      '🔴 装配接上之后**不许**再出现 `no_image_pipeline`（出现 = 这条链路又断了 ✗）');
    assert.equal(logs.events(SCAN_WRITE.events.returnImageFailed).length, 0,
      `退货出图那条失败告警（${SCAN_WRITE.events.returnImageFailed}）一条都不许有 ✓`);
  } finally { logs.restore(); h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RI2 单货品：1 件 ⇒ 1 张图 ＋ 单据 1 张 ＋ 群消息 2 条（与既有一致 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RI2 单货品退货（1 件）⇒ 1 张图 ＋ 「单据」1 张 ＋ 群消息 2 条（与既有一致 ✓）', async () => {
  login();
  const h = createHarness();
  const logs = captureLogs();
  try {
    await withServer(h.app, async (base) => {
      await submitThroughRoute(h, { base, form: { return_sizes: '41', return_qty_41: '1' } });
    });
    assert.equal(h.renders.length, 1);
    assert.equal(h.renders[0].supplierName, '甲供应商', '供应商由代码读「货品信息.供应商」✓');
    assert.equal(h.renders[0].title, SCAN_WRITE.purchaseReturn.imageTitle,
      '标题来自配置（`SCAN_RETURN_IMAGE_TITLE` ✓ 零硬编码）');
    assert.equal(Number(h.renders[0].items[0].quantity), 1, '图上写的是**实退数** ✓');
    assert.deepEqual(documentNamesOf(h), [documentFileNameOf('甲供应商', documentSuffix)],
      '「单据」里 1 张、文件名 = `documentFileNameOf`（唯一一处拼法 ✓）');
    assert.equal(h.messages.length, 2, '图 + @文字 = 2 条 ✓');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '主表 1 行 ✓');
    assert.equal(entriesOf(h, 'purchaseRequest').length, 1, '明细 1 行 ✓');
    assert.equal(logs.lines.some((line) => line.includes('"reason":"no_image_pipeline"')), false);
  } finally { logs.restore(); h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RI3 多货品 / 多供应商：2 家 ⇒ 2 组 · 2 张图；同一份提交重放 ⇒ +0
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RI3a ⭐ 一单退货 2 个货品（2 家供应商）⇒ 按供应商**分 2 组 · 2 张图**（真路由 ⇒ 真出图链路）', async () => {
  login();
  const h = createHarness();
  const logs = captureLogs();
  try {
    await withServer(h.app, async (base) => {
      await submitThroughRoute(h, {
        base,
        form: { return_sizes: '41', return_qty_41: '1' },
        multiItems: [
          // ⚠️ 扫码页真实给出的形状：`supplier_record_id` 是空的（供应商由**代码**从货品行读 ✓）
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: '', entries: [] },
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: '', entries: [{ size: '41', quantity: '1' }] },
        ],
      });
    });
    assert.equal(h.renders.length, 2, '🔴 2 家供应商 ⇒ **2 张退货单**（1 张 = 混在一起 ⇒ 红）');
    const bySupplier = new Map(h.renders.map((render) => [render.supplierName, render]));
    assert.deepEqual([...bySupplier.keys()].sort(), ['乙供应商', '甲供应商'], '两家各一张、不重不漏 ✓');
    assert.deepEqual(bySupplier.get('甲供应商').items.map((item) => item.item_no), ['KA'],
      '每组**只含该供应商的行**（混进去 ⇒ 红 ✓）');
    assert.deepEqual(bySupplier.get('乙供应商').items.map((item) => item.item_no), ['KB']);
    assert.deepEqual(
      documentNamesOf(h).sort(),
      ['甲供应商', '乙供应商'].map((name) => documentFileNameOf(name, documentSuffix)).sort(),
      '「单据」每组一张、文件名用同一个拼法 ✓',
    );
    assert.equal(h.messages.length, 4, '2 组 ×（图 + @文字）= 4 条 ✓');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '她选的 ⓐ：**同一个批次号**下分组（不是 2 行 ✗）');
    assert.equal(logs.lines.some((line) => line.includes('"reason":"no_image_pipeline"')), false);
  } finally { logs.restore(); h.cleanup(); }
});

test('AC-RI3b ⭐ 幂等：同一份提交重放 ⇒ 图 +0 · 群消息 +0 · 附件 +0（装配件给的那一份真出图链路）', async () => {
  const h = createHarness();
  try {
    const gateway = h.gateway;
    const dirs = { ret: tempDir('ret-replay'), webhook: tempDir('webhook-replay'), inventory: tempDir('inv-replay') };
    const orderBatches = new PurchaseOrderBatchService({ gateway });
    // ⭐ 这一份**就是从装配件出来的**（与路由装配同一个函数、同一份配置）——
    //   本用例只把"出图 / IM"换成替身，**真 `deliverSupplierImages`** 一个字没换 ✓
    const assembled = resolvePurchaseReturnImageOptions({
      gateway,
      config: SCAN_WRITE.purchaseReturn.imageDelivery,
      overrides: { webhookOptions: { ...h.webhookOptions, store: new JsonTaskStore({ dir: dirs.webhook, idField: 'task_id' }) } },
    });
    const purchaseReturn = createPurchaseReturnService({
      gateway,
      config: { ...SCAN_WRITE.purchaseReturn, taskDir: dirs.ret },
      store: new JsonTaskStore({ dir: dirs.ret, idField: 'task_id' }),
      inventory: new InventoryService({ gateway, store: new JsonTaskStore({ dir: dirs.inventory, idField: 'operation_id' }) }),
      orderBatches,
      ...assembled,
    });
    const draft = {
      product_record_id: '', product_number: '', item_no: '', color: '', supplier_record_id: '',
      behavior_record_id: 'bh_return_purchase',
      operator_open_id: OPEN_ID,
      order_amount: '399',
      items: [
        { size: 41, quantity: 1, product_record_id: 'prod_A', product_number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a' },
        { size: 41, quantity: 1, product_record_id: 'prod_B', product_number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_b' },
      ],
    };
    const first = await purchaseReturn.submit('scan_return_image_replay_1', draft);
    assert.equal(first.ok === undefined || first.ok === true, true, JSON.stringify(first));
    const rendersAfter = h.renders.length;
    const messagesAfter = h.messages.length;
    const uploadsAfter = gateway.calls.upload.length;
    const documentsAfter = documentNamesOf(h).length;
    assert.deepEqual([rendersAfter, messagesAfter, uploadsAfter, documentsAfter], [2, 4, 2, 2],
      '第一次：2 家 ⇒ 2 张图 / 4 条群消息 / 2 个附件 / 2 张单据 ✓');

    // 重放**同一份提交**（同一个 task ⇒ 同一份冻结计划；与 AC-RS4 同形 ✓）
    await purchaseReturn.submit('scan_return_image_replay_1', draft);
    assert.equal(h.renders.length, rendersAfter, '🔴 重放**一张图都不许再出**（去掉"已经出过"那一步 ⇒ 红 ✓）');
    assert.equal(h.messages.length, messagesAfter, '🔴 群里也不许再发一遍 ✗');
    assert.equal(gateway.calls.upload.length, uploadsAfter, '附件不用再传一次 ✓');
    assert.equal(documentNamesOf(h).length, documentsAfter, '「单据」还是那 2 张、不重复 ✗');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '重放不会多一行主表 ✓');
    Object.values(dirs).forEach(rmDir);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RI4 🔴 反向哨兵 / 探针：装配那一行**不接** ⇒ no_image_pipeline 出现 ⇒ 判据会红
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RI4 🔴 探针：关掉出图开关（= 装配那几行不接）⇒ **no_image_pipeline 出现** ⇒ AC-RI1/RI2 的断言会红', async () => {
  login();
  const h = createHarness({
    purchaseReturn: { ...SCAN_WRITE.purchaseReturn, imageDelivery: { enabled: false } },
  });
  const logs = captureLogs();
  try {
    await withServer(h.app, async (base) => {
      await submitThroughRoute(h, { base, form: { return_sizes: '41', return_qty_41: '1' } });
    });
    // ⭐ 这就是**改前线上**的那一刻：账走了（批次行在）、图一张没发 ✗
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '账照走（这条链路本来就不受影响 ✓）');
    assert.equal(h.renders.length, 0, '没接线 ⇒ 一次出图都没有 ✗（这正是线上那个缺陷）');
    assert.equal(h.messages.length, 0, '群里一条消息都没有 ✗');
    const failed = logs.events(SCAN_WRITE.events.returnImageFailed);
    assert.equal(failed.length >= 1, true, `必须留下那条 warn（${SCAN_WRITE.events.returnImageFailed}）✓`);
    assert.equal(failed.some((line) => line.includes('"reason":"no_image_pipeline"')), true,
      '⭐ 本文件 AC-RI1/RI2 里那条"不许出现 no_image_pipeline"的断言，**在这里真的能红** ✓'
      + '（探针 ⇒ 判据不是空跑 ✓）');
  } finally { logs.restore(); h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RI5 🔴 冻结件：`services/scanWriteService.js` 逐字节没动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RI5 🔴 冻结件 `services/scanWriteService.js` 与 main **逐字节一致**（本卡一个字都没碰它）', () => {
  const raw = fs.readFileSync(SCAN_WRITE_SERVICE_PATH);
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  assert.equal(sha, FROZEN_SCAN_WRITE_SHA256,
    '🔴 冻结件被改动了 ✗ —— 本卡只在**装配处传参**（需要动它 ⇒ 停手报 Lead ✓）');
  // 探针：指纹**真能认出**改动（不是拿一个常量自证 ✓）
  assert.notEqual(
    crypto.createHash('sha256').update(Buffer.concat([raw, Buffer.from(' ')])).digest('hex'),
    FROZEN_SCAN_WRITE_SHA256,
    '多一个字节 ⇒ 指纹必变 ✓',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RI6 🔴 源码哨兵：装配处真的接上了 ＋ 路由里没有写链路服务名（既有口径不放宽）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RI6 🔴 源码哨兵：路由装配处出现 `purchaseReturnOptions` ＋ 代码行里**没有**写链路服务名', () => {
  const route = scanPageSource();
  assert.ok(route.includes('createScanWriteService('), '先确认读到的确实是路由源码（防空文件假绿 ✗）');
  assert.ok(route.includes('purchaseReturnOptions: resolvePurchaseReturnImageOptions({'),
    '🔴 装配处必须把 `purchaseReturnOptions` 接上（去掉它 ⇒ AC-RI1/RI2/RI3 红 ✓）');
  // 既有口径（`test/multiItemOrderRoute.test.js` RT5 / `test/scanDraftRouteWiring.test.js` AC-D3i2）：
  // **代码行**里不许出现写链路的服务名 —— 真名只住在那个装配件里 ✓ 本卡不放宽它 ✗
  const code = route.split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/'));
    })
    .join('\n');
  for (const name of ['purchaseWebhookService', 'purchaseReturnService', 'PurchaseWebhookService']) {
    assert.equal(code.includes(name), false, `🔴 路由的代码行里不许出现 ${name} ✗`);
  }
  // ⭐ 2026-10-17 成对迁移（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：这里还有**第二圈**——`route.includes(name)`（**连注释一起扫**，禁
  //     `inventoryService|salesOrderService|purchaseWebhookService`），依据写的是
  //     「既有哨兵 `test/scanPage.test.js` ④ 连注释一起扫」。
  //   改后逐字：**这一圈退场** —— ④ 已迁成"剥注释再扫"（注释不是代码 ✓），本圈的立论随之失效；
  //     **代码行**的禁令仍由上面那圈 `code.includes(name)` 钉着（**没放宽** ✓）。
  //   依据 = `test/scanPage.test.js` ④ 的 2026-10-17 成对迁移（注释里提到服务名 ≠ 写了调用）。
});

// MUTATION（本卡 · 2 组，每组都在**独立 worktree** 上单独跑过、确认真红，跑完逐字节还原 ✓）：
//   ① 把 `routes/scanPage/index.js` 里那段装配（`purchaseReturnOptions:` 那一段）删掉
//      ⇒ **AC-RI1 / RI2 / RI3a 红**（出图那一步一次都没被调：`renders`=0）＋ **AC-RI6 红**（源码哨兵）；
//      ⚠️ **AC-RI4 仍是绿的** —— 它本来就是"不接的时候该看到什么"，所以它不参与这一组 ✓
//   ② 把 `config/scanWrite.js` 的 `imageDelivery.enabled` 缺省改成 `false`
//      ⇒ **AC-RI1 / RI2 / RI3a / RI3b 红**（装配件那一份也拿不到出图链路）＋ **AC-RI4 仍绿** ✓
//   还原核验：`git checkout -- <改过的那个文件>` ⇒ `shasum -a 256 -c` 与变异前**逐字节一致** ✓
//   （上面的清单**与实测一致**，不是照抄预期 —— 完整表见 `docs/purchase-return-image-wiring-2026-10-16.md` 第 6 节 ✓）
