/**
 * ⭐ **扫码取数链路的「分阶段耗时」验收标准**（业务负责人 2026-10-09：卡）。
 *
 * 她的原话：「以后**一查日志就知道卡在哪一步**」。
 * 线上真机证据（2026-10-09，服务器只读日志）：同一款连着两次扫码
 * `scan.page.cache_miss 08:30:19` → `scan.page.viewed 08:30:33`
 * ⇒ `duration_ms: 13917`；更早一次（编号不存在）25 秒后 nginx 记 `499`（她没等到就关了）。
 * **只有总时长、看不出卡在哪一段** —— 这条日志就是补这个缺口。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-T1 `lookup` 把各阶段毫秒写进**出参** `timing`（不污染视图模型）：
 *        `number` / `cache_hit` / `product_ms` / `inventory_ms` / `size_ms` /
 *        `whole_table_fallback` / `total_ms` / `rows`；分阶段真的分别计时
 *        （给三张表各加不同的延时，断言三个 ms 各自对得上）。
 *  AC-T2 一条汇总日志 `scan.lookup.timing`（info 级、**一条就够**）：
 *        字段与上面同一套 + `render_ms`（由路由在渲染完之后补上）。
 *  AC-T3 **失败也看得出卡在哪**：没找到 / 取数抛错时同样打一条（`found:false`、`rows:0`），
 *        而且**不许**因为要多打一条日志就改变原来的状态码与人话页。
 *  AC-T4 **缓存命中**时：`product_ms` / `inventory_ms` / `size_ms` 都是 0（一次飞书都没打）、
 *        `cache_hit:true`、`total_ms` 仍然记（"快在哪"也要看得见）。
 *  AC-T5 `whole_table_fallback` 的语义**只有一个**：本次取数有没有走「整表回退」
 *        （过滤读用不了 / 一条没读到 / 飞书不认公式）；
 *        「尺码管理」本来就是整表读，**不算**回退（它有独立的 `size_ms`）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_timing_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_timing_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageService } = require('../src/services/scanPageService');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan_timing_session_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ── 夹具（与 scanPage.test.js 同一份真实列形状）──────────────────────────────
const PRODUCT = {
  record_id: 'prod_1',
  fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' }, 类别: 'A', 品类: { text: '休闲鞋' }, 单价: 399 },
};
const SIZE_RECORDS = [
  { record_id: 'size_40', fields: { 尺码: 40, 类别: ['A'] } },
  { record_id: 'size_41', fields: { 尺码: 41, 类别: ['A'] } },
];
const inventoryRow = (id, sizeRecordId, state) => ({
  record_id: id,
  fields: {
    编号: ['prod_1'],
    尺码: [sizeRecordId],
    所属状态: state,
    库存键: `${NUMBER}|${String(sizeRecordId).replace('size_', '')}`,
    品类: '休闲鞋',
    更新时间: Date.UTC(2026, 9, 8, 12, 30),
  },
});
const INVENTORY = [
  inventoryRow('inv_40_box', 'size_40', '门盒'),
  inventoryRow('inv_41_sample', 'size_41', '样品'),
  inventoryRow('inv_40_wh', 'size_40', '仓库'),
];

/**
 * 假网关：三张表的**读各带不同延时**（好把三个阶段的 ms 分辨出来）。
 * `filter: false` = 这个网关没有"按条件读"的能力（既有的整表回退路径）。
 * 写方法一碰就抛（钉住"只读"）。
 */
const fakeGateway = ({ filter = true, delays = {}, products = [PRODUCT], inventory = INVENTORY } = {}) => {
  const data = { product: products, liveInventory: inventory, sizeManagement: SIZE_RECORDS };
  const boom = (name) => async () => { throw new Error(`扫码页不许写：${name}`); };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      if (delays[key]) await sleep(delays[key]);
      return data[key] || [];
    },
    create: boom('create'),
    update: boom('update'),
    delete: boom('delete'),
  };
  if (filter) {
    // 真实的 `listByFilter` 也是"按条件只读这几行"；这里直接复用同一份数据
    //（返回体形状与 listAll 逐字相同），服务层回来还会再跑一遍内存判据。
    gateway.listByFilter = async (key) => {
      if (delays[`filter:${key}`]) await sleep(delays[`filter:${key}`]);
      return data[key] || [];
    };
  }
  return gateway;
};

const serviceOf = (options) => createScanPageService(fakeGateway(options), {
  config: options?.config || SCAN_PAGE,
  startSnapshot: false,
});

/** 抓 info 日志：`utils/logger` 的 info 就是 `console.log`（与 voucherSettlement 同一做法）。 */
const captureInfo = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (line) => { lines.push(String(line)); };
  try {
    const value = await run();
    return { value, entries: lines.map((line) => JSON.parse(line)) };
  } finally {
    console.log = original;
  }
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_scan_user') => {
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

// ═══════════════════════════════════════════════════════════════════════════
// AC-T1 分阶段计时（出参，不污染视图模型）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T1 `lookup` 把各阶段毫秒写进 timing 出参：三个阶段分别真的计时', async () => {
  const service = serviceOf({
    delays: { 'filter:product': 30, 'filter:liveInventory': 45, sizeManagement: 20 },
  });
  const timing = {};
  const view = await service.lookup({ number: NUMBER, requestId: 'req_t1', timing });

  assert.equal(view.found, true, '取数本身照旧成功');
  assert.equal(timing.number, NUMBER);
  assert.equal(timing.cache_hit, false);
  assert.equal(timing.rows, INVENTORY.length, 'rows = 本次读到的「实时库存」行数');
  assert.equal(timing.whole_table_fallback, false, '这个网关有 filter ⇒ 没走整表回退');

  assert.ok(timing.product_ms >= 30, `product_ms 必须覆盖「货品信息」那一次读：${timing.product_ms}`);
  assert.ok(timing.inventory_ms >= 45, `inventory_ms 必须覆盖「实时库存」那一次读：${timing.inventory_ms}`);
  assert.ok(timing.size_ms >= 20, `size_ms 必须覆盖「尺码管理」那一次读：${timing.size_ms}`);
  assert.ok(timing.total_ms >= timing.product_ms + timing.inventory_ms + timing.size_ms,
    'total_ms 是整条链路的墙钟（不小于三段之和）');

  // 出参是**独立的对象**：不准往视图模型上挂计时字段（既有用例对视图模型是逐字 deepEqual）
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'timing'), false, '视图模型不许被污染');
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'product_ms'), false, '视图模型不许被污染');

  // 不传 timing 也照常工作（既有调用方一个字都不用改）
  const plain = await serviceOf({}).lookup({ number: NUMBER, requestId: 'req_t1b' });
  assert.equal(plain.found, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-T2 一条汇总日志（info、字段齐全、只有一条）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T2 走完一次扫码只打一条 `scan.lookup.timing`（含 render_ms）', async () => {
  login();
  const gateway = fakeGateway({ delays: { 'filter:product': 10, 'filter:liveInventory': 10, sizeManagement: 10 } });
  const app = express();
  // 与 `app.js` 同一套：请求号由最外层中间件给（耗时日志靠它把一次扫码串起来）。
  app.use((req, res, next) => { req.requestId = 'req_timing_demo'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    gateway, config: SCAN_PAGE, startSnapshot: false,
  }));

  const { entries } = await captureInfo(() => withServer(app, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    return response.text();
  }));

  const timingLines = entries.filter((entry) => entry.event === 'scan.lookup.timing');
  assert.equal(timingLines.length, 1, '一次扫码只许有一条耗时汇总（别刷屏）');
  const line = timingLines[0];
  for (const field of [
    'number', 'cache_hit', 'product_ms', 'inventory_ms', 'size_ms',
    'whole_table_fallback', 'render_ms', 'total_ms', 'rows',
    // `snapshot_hit` 是规格那 9 个字段之外**多加的一个**（"这一趟吃的是内存快照吗"）——
    // `inventory_ms ≈ 0` 有两种解释，有了它就不用猜。
    'snapshot_hit',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(line, field), `缺字段 ${field}`);
  }
  assert.equal(line.level, 'info');
  assert.equal(line.number, NUMBER);
  assert.equal(line.cache_hit, false);
  assert.equal(line.whole_table_fallback, false);
  assert.equal(typeof line.render_ms, 'number');
  assert.ok(line.render_ms >= 0);
  assert.ok(line.total_ms >= 30, '总时长把三段读都算进去了');
  assert.ok(line.rows === INVENTORY.length);
  assert.ok(typeof line.request_id === 'string' && line.request_id.length > 0, '带 request_id 才追得下去');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-T3 失败也看得出卡在哪（状态码与人话页一个字不变）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T3 没找到 / 取数抛错：照样一条 timing（found:false、rows:0），页面与状态码不变', async () => {
  login();
  const notFound = fakeGateway({ products: [], inventory: [] });
  const appNotFound = express();
  appNotFound.use((req, res, next) => { req.requestId = 'req_timing_nf'; next(); });
  appNotFound.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    gateway: notFound, config: SCAN_PAGE, startSnapshot: false,
  }));
  const { entries } = await captureInfo(() => withServer(appNotFound, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 404, '没找到还是 404 + 人话页（日志不许改变行为）');
    assert.match(await response.text(), /没找到这个编号/);
  }));
  const lines = entries.filter((entry) => entry.event === 'scan.lookup.timing');
  assert.equal(lines.length, 1, '没找到也要有一条耗时（不然"卡在找货品"看不出来）');
  assert.equal(lines[0].found, false);
  assert.equal(lines[0].rows, 0);
  assert.ok(lines[0].product_ms >= 0);

  // 取数抛错（网关整个炸了）→ 500 人话页 + 仍然一条 timing
  const broken = fakeGateway({});
  broken.listAll = async (key) => { if (key === 'product') await sleep(15); throw new Error('飞书 500'); };
  broken.listByFilter = async () => { throw new Error('飞书 500'); };
  const appBroken = express();
  appBroken.use((req, res, next) => { req.requestId = 'req_timing_broken'; next(); });
  appBroken.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    gateway: broken, config: SCAN_PAGE, startSnapshot: false,
  }));
  const { entries: failed } = await captureInfo(() => withServer(appBroken, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 500);
    assert.match(await response.text(), /暂时打不开/);
  }));
  const failedLines = failed.filter((entry) => entry.event === 'scan.lookup.timing');
  assert.equal(failedLines.length, 1, '抛错时也要有一条耗时');
  assert.equal(failedLines[0].found, false);
  assert.ok(failedLines[0].product_ms >= 15, '要能看出是卡在「货品信息」那一步');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-T4 缓存命中：三个阶段都是 0
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T4 命中短缓存：三个阶段的 ms 都是 0、cache_hit:true（一次飞书都没打）', async () => {
  const gateway = fakeGateway({});
  const service = createScanPageService(gateway, { config: SCAN_PAGE, startSnapshot: false });
  await service.lookup({ number: NUMBER, requestId: 'req_t4a' });

  const timing = {};
  const view = await service.lookup({ number: NUMBER, requestId: 'req_t4b', timing });
  assert.equal(view.found, true);
  assert.equal(timing.cache_hit, true);
  assert.equal(timing.product_ms, 0);
  assert.equal(timing.inventory_ms, 0);
  assert.equal(timing.size_ms, 0);
  assert.equal(timing.whole_table_fallback, false);
  assert.equal(timing.rows, view.total, '命中缓存时 rows 也照给（就是这次视图模型的总双数）');
  assert.ok(timing.total_ms >= 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-T5 `whole_table_fallback` 只有一个语义
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T5 `whole_table_fallback` 只表示"这一趟走了整表回退"；尺码管理本来就是整表读，不算', async () => {
  // ① 没有"按条件读"能力的网关 ⇒ 货品 / 实时库存都回退整表 ⇒ true
  const noFilter = serviceOf({ filter: false, delays: {} });
  const timingA = {};
  await noFilter.lookup({ number: NUMBER, requestId: 'req_t5a', timing: timingA });
  assert.equal(timingA.whole_table_fallback, true, '过滤读用不了 ⇒ 走了整表回退');

  // ② 有 filter、而且真的读到了 ⇒ false（尺码管理那一次整表读不算）
  const withFilter = serviceOf({ filter: true });
  const timingB = {};
  await withFilter.lookup({ number: NUMBER, requestId: 'req_t5b', timing: timingB });
  assert.equal(timingB.whole_table_fallback, false);

  // ③ 有 filter、但一条都没读到（大小写不一致 / 老数据）⇒ 回退整表 ⇒ true
  const emptyFilter = fakeGateway({ filter: false });
  emptyFilter.listByFilter = async () => [];
  const serviceC = createScanPageService(emptyFilter, { config: SCAN_PAGE, startSnapshot: false });
  const timingC = {};
  await serviceC.lookup({ number: NUMBER, requestId: 'req_t5c', timing: timingC });
  assert.equal(timingC.whole_table_fallback, true, '过滤读一条都没读到 ⇒ 回退整表');
});

test('AC-T5 耗时字段全部是数字（日志里不能出现 undefined / NaN）', async () => {
  const service = serviceOf({});
  const timing = {};
  await service.lookup({ number: NUMBER, requestId: 'req_t5d', timing });
  for (const field of ['product_ms', 'inventory_ms', 'size_ms', 'total_ms', 'rows']) {
    assert.equal(Number.isFinite(timing[field]), true, `${field} 必须是有限数字：${timing[field]}`);
  }
  assert.equal(typeof timing.whole_table_fallback, 'boolean');
  assert.equal(typeof timing.cache_hit, 'boolean');
  assert.equal(typeof timing.number, 'string');
});
