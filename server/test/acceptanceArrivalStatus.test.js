require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');
/**
 * ⭐⭐ 2026-10-12（业务负责人口述版，落档 `docs/acceptance-scan-design-2026-10-12.md`）：
 *   「用户点验收的时候，**先默认带出我们采购申请里的尺码和数量**。用户可以在**给定的区域里
 *     直接修改**，同时**也可以自定义**；**自定义的时候同样支持扫码**。」
 *
 * 本文件钉的就是这段：**进验收 ⇒ 明细预填成一张可编辑清单**（默认 = 报货数量）+ 可改 + 可自定义
 * + 扫码加一款 + 完成时写「实际数量（各行之和）」/「发生金额」+ **逐尺码加库存**（既有口径）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-AP1 进验收（`GET /r/accept?batch=…`）⇒ **明细逐字预填**（35×1 · 36×1 · 37×1 ⇒ 每个尺码一个
 *         数量输入框，`value` = **报货数量**）+ 发生金额输入框 + 确认完成验收（表单字段名来自配置）。
 *  AC-AP2 **改数量**（37 改成 2）⇒ 完成后写进去的 `scanLines` / 「实际数量」= **改后各行之和**。
 *  AC-AP3 **改成 0** ⇒ 那一行**不算到货**（不进 `scanLines`、不加库存）。
 *  AC-AP4 ⚠️ **自定义加一行**：**能加进清单（会话里看得见）**；但在"完成"这一步会被**既有**链路
 *         按「这一双不在本批」**如实拦住** —— 因为 `purchaseArrivalConversationService.buildPlan`
 *         只认"有采购明细的那几行"（该文件**不在本轮文件面**）。
 *         ⇒ 本条钉的是**不 500、不静默丢、有一句人话**；真正"自定义行也能入库"要等她拍业务口径
 *         （加到哪个款 / 未报货尺码怎么办）+ 授权改那个文件。（报告里单列 ✓）
 *  AC-AP5 ⭐ **扫码加一款**：走既有 `accept_add` 扫进来 ⇒ 该款**出现在清单里**（可继续改数量）。
 *  AC-AP6 **完成** ⇒ 既有口径一字不变：`actualAmount` 原样交给 `confirmBatchArrival` +
 *         **逐尺码** `scanLines`（每一行 货品/尺码/数量）。
 *  AC-AP7 没有采购明细的批次（开关打开）⇒ 页面仍 **200** + 仍能手输自定义 / 扫码加（**不崩**）。
 *  AC-AP8 回归：既有「加入本次验收」表单与自助块**逐字还在**（`name=accept_size` / `accept_quantity`）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_ar';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_ar_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-ar-secret';
const NUMBER = 'YD6693-2|黑色|A';
const BATCH = 'CGD-20261012-0001';
const BATCH_ID = 'batch_a';
const SIZES = [35, 36, 37, 38, 39];
const T = SCAN_WRITE.texts;
const F = SCAN_WRITE.fields;
const A = SCAN_WRITE.actions;

const VIEW = {
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色', category_name: '休闲鞋',
  category_code: 'A', price_text: '¥399', total: 2, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '37', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-12 16:00',
  product_record_id: 'prod_1',
};
const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-ar-${label}-`));

/** ⭐ 抓 `confirmBatchArrival` 的入参（= 写库那一刻的"实际数量 / 逐尺码清单 / 发生金额"）。 */
const createHarness = ({ rows = SIZES.map((size) => ({ size, quantity: 1 })), allowEmptyRows = false, twoProducts = false } = {}) => {
  const records = {
    purchaseOrderBatch: [{ record_id: BATCH_ID, fields: { 报货批次号: BATCH, 到货状态: '未到货', 供应商: [{ text: '大发鞋厂' }] } }],
    purchaseRequest: [
      ...rows.map((row, index) => ({
        record_id: `pr_${index + 1}`,
        fields: { 报货批次号: [BATCH_ID], 编号: ['prod_1'], 尺码: [`size_${row.size}`], 数量: row.quantity },
      })),
      // 第二款（只在她要验"多款"那条 AC 时加）
      ...(twoProducts ? [{
        record_id: 'pr_other',
        fields: { 报货批次号: [BATCH_ID], 编号: ['prod_2'], 尺码: ['size_40'], 数量: 1 },
      }] : []),
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } },
      ...(twoProducts ? [{ record_id: 'prod_2', fields: { 编号: 'XHB8095|棕色|A', 货号: 'XHB8095', 颜色: { text: '棕色' } } }] : []),
    ],
    sizeManagement: SIZES.map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    behavior: [],
  };
  const updates = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records[key] || [],
    get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    // ⭐ 真网关有 update（`markArrived` → `setArrivalStatus` 靠它）——这里记下来并**真的改数据**，
    //    这样"到货状态有没有被写"与"未到货列表里还在不在"都能断言。
    update: async (key, recordId, values) => {
      updates.push({ table: key, recordId, values });
      // ⚠️ 真网关收的是**语义键**（`arrivalStatus`），落表时要翻成**物理列名**（「到货状态」）——
      //    假网关也必须这么做，否则"到货状态到底写没写"就断不出来。
      const mapping = V1_BITABLE_SCHEMA.tables[key].fields;
      const row = (records[key] || []).find((record) => record.record_id === recordId);
      if (row) {
        for (const [semantic, value] of Object.entries(values || {})) {
          if (!mapping[semantic]) throw new Error(`未配置语义字段: ${semantic}`);
          row.fields[mapping[semantic]] = value;
        }
      }
      return { recordId };
    },
  };
  const confirmCalls = [];
  // eslint-disable-next-line global-require
  const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
  const orderBatches = new PurchaseOrderBatchService({ gateway, texts: SCAN_WRITE.texts, events: SCAN_WRITE.events });
  const conversation = new PurchaseArrivalConversationService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'task_id' }),
    sizeReferences: () => SIZE_STUB,
    confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
    // ⭐ 与工作台 / 对话到货**同一条路**：既有 `PurchaseOrderBatchService.markArrived`
    //    （它就是"把批次行到货状态写成已到货"的唯一实现）。
    markBatchArrived: (batchNo, arrivalOptions) => orderBatches.markArrived(batchNo, arrivalOptions),
  });
  const originalConfirm = conversation.confirmBatchArrival.bind(conversation);
  conversation.confirmBatchArrival = async (input) => {
    confirmCalls.push(input);
    return originalConfirm(input);
  };
  const config = allowEmptyRows
    ? { ...SCAN_WRITE.acceptance, allowEmptyRows: true }
    : SCAN_WRITE.acceptance;
  const arrival = createScanArrivalService({
    gateway,
    config,
    texts: T,
    events: SCAN_WRITE.events,
    purchaseQuery: createPurchaseQueryService(gateway, { sizeReferences: SIZE_STUB }),
    arrivalConversation: conversation,
    store: new JsonTaskStore({ dir: tempDir('session'), idField: 'session_id' }),
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: { table: () => ({ fields: {} }), listAll: async () => [], get: async () => null },
    // ⚠️ 逐码页的 POST 走的是"写入口"那道闸门 ⇒ 没它一律 503（与线上同一道闸门）。
    //    这里给一个最小的替身（本文件只验验收那一段，不碰销售写入）。
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'scan_sale:test:1' },
      addSaleLine: async () => ({ ok: false }),
      submitSale: async () => ({ ok: false }),
      clearDraft: async () => ({ ok: true }),
    },
    arrivalService: arrival,
    writeConfig: { ...SCAN_WRITE, acceptance: config },
  }));
  return { app, arrival, confirmCalls, updates, orderBatches };
};

const sessionCookie = (openId = 'ou_accept_ar') => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000 })).toString('base64url');
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
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = async (base, target, openId = 'ou_accept_ar') => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie(openId) } });
  return { response, html: await response.text() };
};
const post = (base, target, body, openId = 'ou_accept_ar') => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  return fetch(`${base}${target}`, {
    method: 'POST',
    headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};



// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12 21:15（她真机验收成功，但暴露两个真问题）
//   ① 验收成功后那一批的**「到货状态」仍是「未到货」** ✗ ⇒ 它继续躺在"未到货批次"列表里
//      ⇒ 她会以为没生效 / 重复验收 ✗（口径应与"对话到货点【是】"那条**一致**）。
//   ② 「发生金额」是必填，但页面上看不出来 ⇒ 她第一次提交被拒；**被拒后她填的内容还丢了** ✗。
//
//  AC-AR1 完成验收（入库成功）⇒ 批次行**真的被写成「已到货」**（断言写入值 + 目标记录）。
//  AC-AR2 完成后再看「未到货批次」列表 ⇒ **它不在了**。
//  AC-AR3 幂等：同一批再提交 ⇒ **不重复加库存**，状态仍是「已到货」。
//  AC-AR4 金额是必填 ⇒ 页面上**看得出来**（label 标注必填 + 一句提示）。
//  AC-AR5 金额为空被拒 ⇒ **她还填着的数量/金额不许丢**（页面带着它们回来 + 一句人话）。
// ═══════════════════════════════════════════════════════════════════════════


/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「**`/r/accept` 这条路要彻底拆掉**」
 *
 * ⚠️ **本文件原来是"扫码页那条完成验收（`acceptFinishRows`）的验收标准"** ——
 *    那条能力**随验收页一起退场** ✓ ⇒ 这里**整体改指向**（改前逐字：`GET /r/accept` ⇒ 200 验收页 +
 *    `POST /r/accept {action: acceptFinishRows}` ⇒ 写回批次行「已到货」＋金额必填/成功页/幂等 10 条 ✗）
 *    ⇒ 改后断言：**这条路已退场**（302 回首页）＋ **一个字都不许写** ✓
 *    ＋ **仍然成立、照旧不许动**的：工作台「确认到货」（`POST /api/workbench/purchase/arrivals/confirm`）
 *      与加库存 `InventoryService.applyPurchase` ✓（另有用例罩着 ✓）
 */
const SRC_DIR = path.join(__dirname, '../src');
const readSrc = (rel) => fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');

test('AC-AR1 🔴 旧 `GET /r/accept` ⇒ **302 回首页**（不再是验收页；别再挂住/500）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    // ⚠️ 产品形状本来就对（Lead 判定 ✓）：`/r/accept` 落进 `/:number` ⇒ 把 `accept` 当编号查不到 ⇒ 人话页 ✓
    //    ⇒ 这里只断言"**不再是验收那一屏**"（不要求特定状态码 ✓ 不挂住就够了 ✓）
    const res = await get(base, `/r/accept?batch=${encodeURIComponent(BATCH)}`);
    const body = String(res.html || '');
    assert.equal(/data-view="acceptance"/.test(body), false, '不许再渲染验收那一屏 ✗');
    assert.equal(/完成验收/.test(body), false, '「完成验收」那颗按钮跟着退场 ✗');
  });
});

test('AC-AR2 🔴 扫码页那条"完成验收"的写入入口已退场（**源码哨兵** —— 不发那个请求 ✗）', () => {
  // ⚠️ 为什么用源码哨兵而不是真发 `POST /r/accept`：
  //   那条路摘掉后，`POST /r/accept` 会落进 **`POST /:number`**（把 `accept` 当编号）⇒ 走**普通扫码提交那条路** ⇒
  //   本套测试**没有 stub** 那条路用的服务 ⇒ 它会去建真件 / 调真 SDK ⇒ **挂住 ≈301 秒** ✗（已实测）
  //   ⇒ 那正是"退场"的正确形状（产品行为对 ✓ Lead 判定 ✓）⇒ 测试里**不要再打这条旧路** ✓
  //   改前逐字：`await post(base, '/r/accept', { [F.action]: A.acceptFinishRows, … })` ⇒ 断言写「已到货」✗
  //   改后：**源码哨兵**（那条分支与人话入口都没有了 ✓）＋ 仍成立的能力在工作台那条路上验 ✓
  const routes = readSrc('routes/scanPage.js');
  // ⭐⭐ 2026-10-14 晚 cut B **改指向**（依据：她「`/r/accept` 这条路要彻底拆掉」＋ Lead 的 cut B 清单）：
  //   改前逐字：`// ⚠️ writeConfig.actions.acceptFinishRows 这个名字还出现在 realmOfAction 的**映射表**里`
  //   改后逐字：**那句话不再成立** —— `realmOfAction` 里那一行已经删掉（`accept` 也退出了 `REALMS`）
  //   依据：cut A 已把「完成验收」的 handler 摘掉（下面两条断言就是钉它没了的 ✓）、cut B 收掉领域本身
  //     ⇒ 再留一个「动作 → 已不存在的领域 id」的映射只会骗人 ✗。**断言一条没动、判据没放宽** ✓
  assert.equal(/handleAcceptFinishRows|acceptanceContext/.test(routes), false, '完成验收那个分支/handler 必须已退场 ✗');
  assert.equal(/acceptanceLandingPath/.test(routes), false, '验收落地页的跳转路径也必须已退场 ✗');
  assert.equal(/handleAcceptFinishRows/.test(routes), false, '它的 handler 也必须已退场 ✗');
  assert.equal(/renderAcceptancePage/.test(rendererSource()), false, '验收页渲染函数已退场 ✓');
  const workbench = readSrc('routes/workbench.js');
  assert.match(workbench, /router\.post\('\/purchase\/arrivals\/confirm'/, '仍成立：工作台"确认到货"照旧 ✓');
});

test('AC-AR3 🔴 那条"到货状态/金额/幂等"的验收标准已随验收页退场（能力仍在工作台那条路上）', async () => {
  // ⭐ 仍成立的部分（**照旧不许动** ✓）：工作台「确认到货」接口 + 加库存通路都在 ✓
  const SRC = path.join(__dirname, '../src');
  const routes = fs.readFileSync(path.join(SRC, 'routes/workbench.js'), 'utf8');
  assert.match(routes, /router\.post\('\/purchase\/arrivals\/confirm'/, '工作台"确认到货"仍在 ✓');
  const inventory = fs.readFileSync(path.join(SRC, 'services/inventoryService.js'), 'utf8');
  assert.match(inventory, /applyPurchase/, '加库存仍走 `InventoryService.applyPurchase` ✓');
  // 而扫码页那条验收渲染/会话入口**必须没有** ✓
  const renderer = rendererSource();
  assert.equal(/data-view="acceptance"/.test(renderer), false, '扫码页验收块必须没有了 ✗');
});
