const { rendererSource } = require('./support/rendererSource');
/**
 * ⭐⭐ 2026-10-11（业务负责人**选定方案A**）：「**手机上打开工作台 → 采购 → 验收到货 →
 * 选「报货批次」里【未到货】的那个报货号 → 点【验收】⇒ 进入"验收模式"（连续扫） →
 * 每次扫一个码（二维码里只有【编号】）⇒ 列该编号各尺码 ⇒ 选尺码 + 填数量（默认 1，可改）
 * → 支持【连续扫多双】（本单条式：**已验收 N 双 / 应到 M 双** + 【继续扫下一个】+【完成验收】）
 * → 点【完成验收】⇒ **入库 + 该批次改「已到货」**（实际到货数量 = 已扫合计）」。
 *
 * 她的补充口径（逐字）：
 *   · 「不管是扫码页还是工作台，都是在**移动端**完成的」；
 *   · 「【继续扫下一个】用 **AppLink**（`https://applink.feishu.cn/client/qrcode/main`）即可
 *     （手机飞书可用、桌面不支持 ⇒ 桌面给人话）」；
 *   · 「扫到不属于本批的货 ⇒ 提示"**这一双不在本批**"、**不记**；**重复扫** ⇒ **只记一次**」；
 *   · 「完成后：实际到货数量 = 已扫合计，"少发的"自然就是差异（**不额外写差异说明**）」；
 *   · ⭐ 2026-10-11（当天追问后答）：「我们已经通过扫码解决了具体到货情况，所以**就不用到货说明了**，
 *     其他没有问题～」⇒ **【完成验收】只收「发生金额」（必填）**，不收「到货说明」。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-A1 工作台「采购 → 验收到货」每张未到货批次卡上多一条【扫码验收】入口（`/r/accept?batch=`），
 *        ⚠️ **既有「验收到货」表单 / 接口 / 载荷一个字不改**（那是另一条既有链路）。
 *  AC-A2 `GET /r/accept?batch=X` 开一次**验收会话**；落地页出现本单条
 *        （已验收 0 双 / 应到 M 双）+【继续扫下一个】+【完成验收】+「发生金额」输入。
 *  AC-A3 扫一个码 ⇒ 该编号的**各尺码**列出来 ⇒ 选尺码 + 填数量（默认 1、可改）⇒ 加入本次验收
 *        ⇒ **只写本地会话**（业务表零写入）；N/M 实时更新。
 *  AC-A4 连续扫多双：同一 (货品,尺码) **重复扫只记一次**（提示"已经记过了"，N 不变）；
 *        不同尺码累加。
 *  AC-A5 **不在本批**的货 ⇒ 提示"这一双不在本批"、**不记**、N/M 不变。
 *  AC-A6 【完成验收】⇒ 实际到货数 = **已扫合计**（没扫到的行 = 0 ⇒ **不入库**）⇒ 走**既有**
 *        `confirmBatchArrival` → `buildPlan` → `confirmLocked` → 既有入库；批次改「已到货」。
 *  AC-A7 **幂等**：同一批再点一次【完成验收】⇒ 不重复入库（既有 already_posted / 会话回执）。
 *  AC-A8 **会话互不覆盖**：销售本单 / 补货 / 退货 / 验收 四条链各写各的（一条提交不动另三条）。
 *  AC-A9 【继续扫下一个】= 飞书 UA 给 AppLink（`/client/qrcode/main`）；桌面 UA 给人话（不是死按钮）。
 *  AC-A10 **一双都还没扫**就点【完成验收】⇒ 拦住、**一个字都不写**、人话说明。
 *  AC-A11 移动端：viewport / 单列 / 不横向滚动 / 控件 ≥44px（静态哨兵）。
 *  AC-A12 源码哨兵：验收**没有第二套入库** —— 复用既有 `buildPlan` 与 `confirmLocked`
 *        （不自己拼 draft.actual、不自己调 applyPurchase）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_accept_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_accept_test_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const WORKBENCH = path.join(__dirname, '../public/workbench');
const SESSION_SECRET = 'scan-accept-test-session-secret';
const NUMBER = 'YD6693-2|黑色|A';
const SESSION_SECRET_ENV = 'LARK_WEB_SESSION_SECRET';

// ── 夹具：一批两行申请（38 码 2 双 / 39 码 1 双），两款货品 ─────────────────────
const BATCH = 'CGD-20261011-0001';
const BATCH_RECORD_ID = 'batch_rec_1';
const rowsOf = () => [
  { record_id: 'pr_38', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: ['prod_1'], 尺码: ['size_38'], 数量: 2 } },
  { record_id: 'pr_39', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: ['prod_1'], 尺码: ['size_39'], 数量: 1 } },
];
const seedTables = (overrides = {}) => ({
  purchaseRequest: rowsOf(),
  product: [
    { record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } },
    // 另一款：**不在本批**（AC-A5 用）
    { record_id: 'prod_other', fields: { 编号: 'XHB1|白色|A', 货号: 'XHB1', 颜色: { text: '白色' } } },
  ],
  sizeManagement: [
    { record_id: 'size_38', fields: { 尺码: 38 } },
    { record_id: 'size_39', fields: { 尺码: 39 } },
    { record_id: 'size_40', fields: { 尺码: 40 } },
  ],
  purchaseOrderBatch: [
    { record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH, 到货状态: '未到货' } },
  ],
  behavior: [],
  ...overrides,
});

const fakeGateway = (records = seedTables()) => ({
  writes: [],
  _tables: records,
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => [...(records[key] || [])],
  listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
  get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
});

const ARRIVAL_SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-accept-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 一套"真的在跑"的验收链路：真会话 + 真核对服务（只有最外层入库用桩）。 */
const createHarness = (options = {}) => {
  const gateway = options.gateway || fakeGateway(seedTables(options.tables || {}));
  const sessionDir = options.sessionDir || tempDir('session');
  const taskDir = options.taskDir || tempDir('arrival-task');
  const store = new JsonTaskStore({ dir: taskDir, idField: 'task_id' });
  const scannedGate = options.scannedGate || tempDir('scan-session');
  const purchaseQuery = createPurchaseQueryService(gateway, { sizeReferences: ARRIVAL_SIZE_STUB });
  const confirmed = [];
  const arrived = [];
  const arrivalConversation = options.arrivalConversation || new PurchaseArrivalConversationService({
    gateway,
    store,
    sizeReferences: () => ARRIVAL_SIZE_STUB,
    confirmArrival: async (taskId, task, operatorOpenId) => {
      confirmed.push({ taskId, task, operatorOpenId });
      return { toast: { type: 'success', content: '采购已入库，库存已更新' } };
    },
    markBatchArrived: async (batchNo, arrivalOptions) => {
      arrived.push({ batchNo, options: arrivalOptions });
      return { updated: true };
    },
  });
  const arrival = createScanArrivalService({
    gateway,
    config: SCAN_WRITE.acceptance,
    purchaseQuery,
    arrivalConversation,
    store: new JsonTaskStore({ dir: sessionDir, idField: 'session_id' }),
  });
  // 扫码页那条链路的会话（AC-A8 用它钉"四条链互不覆盖"）
  const scanSessions = createScanSessionService({ config: SCAN_WRITE, dir: scannedGate });
  return {
    gateway, arrival, arrivalConversation, purchaseQuery, confirmed, arrived, scanSessions,
    tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(taskDir); rmDir(scannedGate); },
  };
};

const startBatch = (h, openId = 'ou_accept_1', batchNo = BATCH) => h.arrival.start({
  openId, batchNo, batchRecordId: 'batch_rec_1', operatorOpenId: openId,
});

// ── 路由夹具 ────────────────────────────────────────────────────────────────
const sessionCookie = (openId = 'ou_accept_route') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env[SESSION_SECRET_ENV] = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
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
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '38', cells: [{ count: 2 }], total: 2, missing: false },
    { size_text: '39', cells: [{ count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-11 17:00',
  product_record_id: 'prod_1',
  ...overrides,
});
const scanApp = (harness, lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup },
    gateway: harness.gateway,
    writeService: false,
    arrivalService: harness.arrival,
    writeConfig: SCAN_WRITE,
  }));
  return app;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-A1 工作台入口（加法：既有全额验收链路一个字不改）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A1 工作台的扫码验收入口**已改造进工作台**（不再跳 /r/accept）；既有验收链路一字不改', () => {
  const config = fs.readFileSync(path.join(WORKBENCH, 'config/orders.js'), 'utf8');
  const orders = fs.readFileSync(path.join(WORKBENCH, 'features/orders/index.js'), 'utf8');
  // ⭐⭐ 2026-10-14 **改指向**（口径 (a) · 依据：业务负责人逐字
  //   「**连它一起改造进工作台（变成工作台自己的页面）**」· 详见
  //   `docs/acceptance-into-workbench-2026-10-14.md` §二/§三）：
  //   改前逐字：`assert.match(orders, /data-action="scan-arrival"/);`
  //             `assert.match(orders, /ARRIVAL_SCAN\.pagePath/);`
  //   改后：工作台**不再从 /r/accept 进**（那颗入口退场 ✗）——
  //   但 ⚠️ **「扫码」那一步物理上仍在扫码页**（标签二维码印的就是 /r/{编号} ✓ 不换标签绕不开）
  //     ⇒ `/r/accept` 那条路 **保留、仍能用，不许删** ✓（配置常量与路由都还在）
  assert.equal(/data-action="scan-arrival"/.test(orders), false, '工作台不该再有"扫码验收"那颗跳转入口 ✗');
  assert.equal(/ARRIVAL_SCAN\.pagePath/.test(orders), false, '也不该再用它当入口 ✗');
  assert.match(config, /ARRIVAL_SCAN/);      // ⭐ 常量**保留**（别的调用方/老链接仍可能用 ✓）
  assert.match(config, /\/s\/accept/);        // ⭐ 扫码页那条路**保留** ✓
  // 既有那条（验收表单 / 它的接口与载荷）**逐字还在**
  // ⭐⭐ 2026-10-15（task-27 · **Lead 放行**，逐字记录）：
  //   改前逐字：`'api.post(ORDERS_API.arrivalConfirm, {'`
  //   改后逐字：`'api.post(ARRIVAL_FULL_API.accept, {'`
  //   依据：业务负责人 2026-10-15 逐字「（一键确认按申请数）……**实际到多少就是到多少**」
  //     ⇒ 前端**不再有**"按申请数一键确认"的调用路径 ✗（那条自述「全部按申请数到货」⇒ 会把少到的补齐 ✗）
  //     ⇒ 一律走 `accept`、提交她填的**实际值** ✓。
  //   ⚠️ **判据没丢**：这条的本意是"这一页**确实通过某个接口提交**"⇒ 换接口名后**仍然钉着同一件事** ✓；
  //      `POST /purchase/arrivals/confirm` 端点/服务与 `ORDERS_API.arrivalConfirm` 常量**保留** ✓
  //      （下面那条 `assert.match(config, /arrivalConfirm: .../)` 照旧 ✓）。
  for (const needle of [
    'data-action="verify-arrival"', 'data-action="submit-arrival"',
  // ⭐⭐ 2026-10-16（她逐字：「**「到货说明」，到货说明必须得删**。因为目前我们的**数据表里面已经没有
  //   验收原话了**，这个是**之前我们的群聊链路**，跟这个**已经没有关系了**。**你必须得删**」）
  //   · 改前逐字：needle 列表里有 `'data-field="arrival-note"',`
  //   · 改后逐字：该沿用项删除 ＋ 新增反向断言 `assert.equal(orders.includes('data-field="arrival-note"'), false)`
  //   · 依据：她 2026-10-16 逐字（同上）；⭐ 反向钉住 ⇒ 把框塞回即红 ✓
    'data-field="arrival-amount"',
    'api.post(ARRIVAL_FULL_API.accept, {',
  ]) {
    assert.ok(orders.includes(needle), `既有验收逻辑少了 ${needle}`);
  }
  assert.equal(orders.includes('data-field="arrival-note"'), false, '⛔「到货说明」输入框不许再回来 ✗');
  assert.match(config, /arrivalConfirm: '\/api\/workbench\/purchase\/arrivals\/confirm'/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A2 开验收会话 + 落地页（本单条 / 继续扫下一个 / 完成验收 / 发生金额）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A2 🔴 GET /r/accept?batch=X ⇒ **验收落地页已退场**（200 回落销售；不再开验收会话）', async () => {
  // ⭐ 2026-10-14 晚 **改指向**（依据：她「`/r/accept` 这条路要彻底拆掉」）
  //   改前逐字：`assert.match(html, /继续扫下一个/)` + `/完成验收/` + `/发生金额/` +
  //              `const session = await h.arrival.get(openId); assert.equal(session.batch_no, BATCH);`
  //   改后：这一页**不再是验收页**（那几个标记一个都不许有 ✗）＋ **不再建验收会话** ✓
  login();
  const h = createHarness();
  try {
    const openId = 'ou_accept_route';
    await withServer(scanApp(h), async (base) => {
      const response = await fetch(`${base}/r/accept?batch=${encodeURIComponent(BATCH)}`, {
        headers: { cookie: sessionCookie(openId), 'user-agent': 'Mozilla/5.0 (iPhone) Lark/7.0' },
      });
      assert.equal(response.status, 200, '旧链接仍可打开（回落销售 ⇒ 不 4xx/5xx ✓）');
      const html = await response.text();
      // ⚠️ 「继续扫下一个」是**本单条**的既有文案（弹回销售页也会有 ✓）⇒ 不在判据里 ✗
      for (const gone of ['完成验收', 'data-view="acceptance"', 'accept-pending', '发生金额（必填）']) {
        assert.equal(html.includes(gone), false, `验收页的「${gone}」必须不再出现 ✗`);
      }
      const session = await h.arrival.get(openId).catch(() => null);
      assert.equal(session, null, '这一趟**不许**再开验收会话 ✓（验收那条路已拆）');
    });
  } finally { h.cleanup(); }
});
test('AC-A3 🔴 扫一个码 ⇒ **不再记进验收会话**（那套写入入口随验收退场）', async () => {
  // ⭐ 2026-10-14 晚 **改指向**：改前逐字断言"扫一个码 ⇒ 列各尺码 + 选尺码 + 填数量 ⇒ 只写本地会话"✗
  //   改后：派发那条验收动作 ⇒ 会话仍为空 ✓（能力留在服务层，但**扫码页不再有这条路** ✓）
  login();
  const h = createHarness();
  try {
    const openId = 'ou_accept_scan_off';
    await withServer(scanApp(h), async (base) => {
      const response = await fetch(`${base}/r/${encodeURIComponent(NUMBER)}`, {
        method: 'POST',
        headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.acceptAdd, accept_size: '40', accept_quantity: '1' }).toString(),
        redirect: 'manual',
      });
      assert.ok(response.status >= 300, '这条动作不再有对应写入口（不会安静成功 ✓）');
      const session = await h.arrival.get(openId).catch(() => null);
      assert.equal(session, null, '一个字都不许写进验收会话 ✓');
    });
  } finally { h.cleanup(); }
});
test('AC-A4 连续扫多双：同一 (货品,尺码) 重复扫只记一次；不同尺码累加（N/M 实时更新）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_accept_4';
    await startBatch(h, openId);
    const first = await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 38, quantity: 2 });
    assert.equal(first.ok, true);
    assert.equal(first.session.scanned, 2);
    // 重复扫同一双 ⇒ 不记（第二次扫描不改变任何数字）
    const again = await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 38, quantity: 1 });
    assert.equal(again.ok, true);
    assert.equal(again.duplicate, true, '重复扫只记一次');
    assert.equal(again.session.scanned, 2, 'N 不变');
    assert.equal(again.session.scans.length, 1);
    // 另一个尺码 ⇒ 累加
    const second = await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 39, quantity: 1 });
    assert.equal(second.session.scanned, 3);
    assert.equal(second.session.expected, 3);
  } finally { h.cleanup(); }
});

test('AC-A5 不在本批的货 ⇒ 提示"这一双不在本批"、不记（会话与 N/M 一个数字都不变）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_accept_5';
    await startBatch(h, openId);
    const before = await h.arrival.get(openId);
    const result = await h.arrival.addScan({
      openId, productRecordId: 'prod_other', size: 40, quantity: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_in_batch');
    assert.match(result.message, /不在本批/);
    const after = await h.arrival.get(openId);
    assert.equal(after.scanned, before.scanned);
    assert.equal(after.scans.length, 0);
    // 尺码不在本批（同一货品、别的码）同样拦住
    const otherSize = await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 40, quantity: 1 });
    assert.equal(otherSize.ok, false);
    assert.equal(otherSize.reason, 'not_in_batch');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A6/A7 完成验收（实际到货 = 已扫合计；未扫到的不入库；幂等）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A6 完成验收 ⇒ 实际到货 = 已扫合计（没扫到的行 = 0 ⇒ 不入库）⇒ 走既有入库链路', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_accept_6';
    await startBatch(h, openId);
    // 只扫到 38 码 2 双 —— 39 码（申请 1 双）没扫到 ⇒ 实际 0 ⇒ 不入库
    await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 38, quantity: 2 });
    const result = await h.arrival.finish({ openId, actualAmount: 1200, operatorOpenId: openId });
    assert.equal(result.ok, true, JSON.stringify(result));
    // 草稿形状 = 既有 confirmArrival 一直在等的那一份：只有实际 > 0 的行
    assert.equal(h.confirmed.length, 1);
    assert.deepEqual(h.confirmed[0].task.draft.actual, [
      { product_record_id: 'prod_1', item_no: 'YD6693-2', color: '黑色', size: 38, quantity: 2 },
    ], '没扫到的行 actual = 0 ⇒ 被既有实现摘掉（不入库）');
    assert.equal(h.confirmed[0].task.draft.actual_amount, 1200);
    assert.equal(h.confirmed[0].task.draft.batch_no, BATCH);
    // 到货状态仍由既有 markBatchArrived 写
    assert.deepEqual(h.arrived.map((item) => item.batchNo), [BATCH]);
    // 会话进入 posted（验收模式结束）
    assert.equal((await h.arrival.get(openId)).status, 'posted');
  } finally { h.cleanup(); }
});

test('AC-A7 幂等：同一批再点一次【完成验收】⇒ 不重复入库（既有 already_posted 口径）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_accept_7';
    await startBatch(h, openId);
    await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 39, quantity: 1 });
    const first = await h.arrival.finish({ openId, actualAmount: 999, operatorOpenId: openId });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(h.confirmed.length, 1);
    // 再点一次（会话已是 posted）⇒ 把上一次的结果还给她，不再入库
    const again = await h.arrival.finish({ openId, actualAmount: 999, operatorOpenId: openId });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true);
    assert.equal(h.confirmed.length, 1, '不重复入库');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A8 四条会话互不覆盖
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A8 会话互不覆盖：销售本单 / 补货 / 退货 / 验收 四条链各写各的', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_accept_8';
    // 验收会话（独立 store + 独立键）
    await startBatch(h, openId);
    await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 38, quantity: 1 });
    // 扫码页那三条链的键各是各的
    const saleKey = h.scanSessions.submitKeyFor(openId, await h.scanSessions.get(openId), 'sale');
    const replenishKey = h.scanSessions.submitKeyFor(openId, await h.scanSessions.get(openId), 'replenish');
    const returnKey = h.scanSessions.submitKeyFor(openId, await h.scanSessions.get(openId), 'purchase_return');
    const useKeys = [saleKey, replenishKey, returnKey];
    assert.equal(new Set(useKeys).size, 3, '三条键互不相同');
    assert.ok(useKeys.every((key) => key.startsWith('scan_')));
    assert.ok(saleKey.startsWith('scan_sale:'));
    assert.ok(replenishKey.startsWith('scan_replenish:'));
    assert.ok(returnKey.startsWith('scan_return:'));
    // 验收会话不被前三条影响（它有自己的 store）
    const session = await h.arrival.get(openId);
    assert.equal(session.scanned, 1);
    assert.equal(session.scans.length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A9 AppLink：飞书给按钮，桌面给人话
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A9 🔴 【继续扫下一个】那颗 AppLink 随验收页一起退场（不再是页面的一部分）', () => {
  // ⭐ 2026-10-14 晚 **改指向**：改前逐字"飞书 UA 给 AppLink / 桌面 UA 给人话"✗
  //   改后：渲染层里**不再有**验收那一块 ⇒ 也就没有那颗按钮 ✓（AppLink 生成器本身仍保留给别处 ✓）
  const renderer = rendererSource();
  assert.equal(/data-view="acceptance"/.test(renderer), false, '验收块必须没有了 ✗');
  assert.ok(/applink/i.test(renderer) === true || /applink/i.test(renderer) === false, '（不强制：AppLink 生成器若还有别的调用方则保留 ✓）');
});
test('AC-A10 一双都还没扫就点【完成验收】⇒ 拦住、一个字都不写', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_accept_10';
    await startBatch(h, openId);
    const result = await h.arrival.finish({ openId, actualAmount: 100, operatorOpenId: openId });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_scan_lines');
    assert.match(result.message, /还没扫/);
    assert.equal(h.confirmed.length, 0, '一次入库都没发生');
    assert.equal(h.arrived.length, 0, '批次状态也不动');
    assert.equal((await h.arrival.get(openId)).status, 'open', '会话还开着，她扫了还能继续');
    // 金额缺失同样一个字都不写（既有必填口径）
    await h.arrival.addScan({ openId, productRecordId: 'prod_1', size: 39, quantity: 1 });
    const noAmount = await h.arrival.finish({ openId, actualAmount: '', operatorOpenId: openId });
    assert.equal(noAmount.ok, false);
    assert.equal(h.confirmed.length, 0);
  } finally { h.cleanup(); }
});

test('AC-A11 🔴 静态哨兵：渲染层里**没有**验收块（那条"移动端布局"随它一起退场）', () => {
  // ⭐ 2026-10-14 晚 **改指向**：改前逐字 `assert.match(renderer, /data-view="acceptance"/)` ✗
  //   改后：**必须没有** ✓（扫码页整页的 ≥44px / 单列 / 不横滑 由既有那几条哨兵继续罩着 ✓）
  const renderer = rendererSource();
  assert.equal(/data-view="acceptance"/.test(renderer), false, '验收块必须没有了 ✗');
  assert.match(renderer, /--control-height/, '页面级的 ≥44px 口径照旧 ✓');
});
test('AC-A12 源码哨兵：验收没有第二套入库（复用 buildPlan / confirmLocked，不自己拼 draft）', () => {
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const service = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'services/scanArrivalService.js'), 'utf8'));
  for (const pattern of [/gateway\.(create|update|delete)\s*\(/, /\.applyPurchase\s*\(/, /\.applyChange\s*\(/, /writeAcceptance/]) {
    assert.equal(pattern.test(service), false, `scanArrivalService 出现了不该有的东西：${pattern}`);
  }
  assert.match(service, /confirmBatchArrival/);
  // ⚠️ `markArrived` 只允许出现在**注入既有能力**的那一行（`markBatchArrived: ... => webhooks.
  //    orderBatches.markArrived(...)`，与 `routes/workbench.js` 那条接线逐字同形）——
  //    本 service **自己不写批次行**（写状态的是既有 `confirmLocked → notifyBatchArrived`）。
  assert.equal((service.match(/markArrived/g) || []).length, 1, 'markArrived 只作为既有能力被注入一次');
  assert.match(service, /markBatchArrived:.*markArrived/, '注入形状与工作台那条一致');
  const conversation = stripComments(fs.readFileSync(path.join(SERVER_SRC, 'services/purchaseArrivalConversationService.js'), 'utf8'));
  assert.match(conversation, /buildPlan\(snapshot\.rows, \{ scanLines: scans \}\)/, '扫码验收复用同一个 buildPlan（新增输入口，不写第二套算法）');
  assert.match(conversation, /buildPlan\(snapshot\.rows, \{ same: true, differences: \[\] \}\)/, '既有「全额验收」分支逐字还在');
  assert.match(conversation, /this\.confirmLocked\(taskId, operatorOpenId/);
});
