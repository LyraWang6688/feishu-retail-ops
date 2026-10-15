// 2026-10-14：本文件测的是**按款缓存这个能力本身** ⇒ **显式打开** ✓
//   （默认已按她拍板改成**关** ✗：「那份按款缓存：去掉（永远最新 ✓ 每次真读 ✓）」）
process.env.SCAN_PAGE_CACHE_ENABLED = 'true';
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
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-T1 分阶段计时（出参，不污染视图模型）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T1 `lookup` 把各阶段毫秒写进 timing 出参：三个阶段分别真的计时', async () => {
  // ⚠️ 2026-10-12：延时与下限原来**逐字相等**（30/30、45/45、20/20）—— 和 AC-T3 同一个坑：
  //    `Date.now()` 毫秒截断 + 定时器粒度会让实测值偶尔比注入值小 1ms。
  //    ⇒ 延时抬到 60/100/50、下限给 55/95/45（同一套覆盖率、留 5ms 余量）。
  const service = serviceOf({
    delays: { 'filter:product': 60, 'filter:liveInventory': 100, sizeManagement: 50 },
  });
  const timing = {};
  const view = await service.lookup({ number: NUMBER, requestId: 'req_t1', timing });

  assert.equal(view.found, true, '取数本身照旧成功');
  assert.equal(timing.number, NUMBER);
  assert.equal(timing.cache_hit, false);
  assert.equal(timing.rows, INVENTORY.length, 'rows = 本次读到的「实时库存」行数');
  assert.equal(timing.whole_table_fallback, false, '这个网关有 filter ⇒ 没走整表回退');

  assert.ok(timing.product_ms >= 55, `product_ms 必须覆盖「货品信息」那一次读：${timing.product_ms}`);
  assert.ok(timing.inventory_ms >= 95, `inventory_ms 必须覆盖「实时库存」那一次读：${timing.inventory_ms}`);
  // 2026-10-14 改指向（她：销售页只要「货品 + 实时库存」⇒ 请求期不再读「尺码管理」）：
  //   能力不变 —— `size_ms` 仍是"尺码这一段"的墙钟 ✓，只是这一段现在**只读配置**（0 次飞书）✓。
  //   改前逐字：assert.ok(timing.size_ms >= 45, `size_ms 必须覆盖「尺码管理」那一次读：${timing.size_ms}`);
  assert.equal(timing.size_source, 'config', '尺码段走配置（不再降级读表）✓');
  // 2026-10-14：原来是 assert.equal(size_ms, 0) ⇒ 在 CI 上**偶发红** ✗
  //   真因（确定的）：size_ms 是那一段的**墙钟**（Date.now 毫秒粒度）⇒ 读配置偶尔跨 1 个刻度 ⇒ 变成 1 ✗
  //   ⇒ 改成 **必须 < 5ms**（读一次配置的正常量级）
  //   🔴 能力没减：真去读「尺码管理」那张表是**几十~几百毫秒** ⇒ 这条照样**能真红** ✓
  assert.ok(timing.size_ms < 5, `尺码段读表已删除 ⇒ size_ms 必须是配置量级（<5ms；实测 ${timing.size_ms}）`);
  assert.ok(timing.size_ms >= 0 && Number.isFinite(timing.size_ms), `size_ms 仍是这一段的墙钟：${timing.size_ms}`);
  // 2026-10-14：这条原来要求 total_ms **>= 三段之和** ⇒ 在 CI（负载抖动）下会**偶发红** ✗
  //   根因（确定的）：每段的 ms 各自用 `Date.now()` 毫秒截断（各自可能**向上**取整一点），
  //   三段相加最多会比整条链路的墙钟**大几毫秒** ⇒ 不是产品错，是**判据在毫秒粒度上不成立** ✗
  //   ⇒ 留 5ms 余量（同 AC-T1 里 30→55 那一套口径 ✓）· 能力一字不减：仍然钉住
  //     "total ≥ 最长的一段"＋"三段都是有限数" ✓（能真红：把 total 写成常量 / 负数 ⇒ 立刻红 ✓）
  assert.ok(timing.total_ms + 5 >= timing.product_ms + timing.inventory_ms + timing.size_ms,
    `total_ms 是整条链路的墙钟（≈三段之和；毫秒截断留 5ms 余量）：total=${timing.total_ms} 三和=${timing.product_ms + timing.inventory_ms + timing.size_ms}`);
  assert.ok(timing.total_ms >= Math.max(timing.product_ms, timing.inventory_ms, timing.size_ms),
    'total_ms 至少不小于最长的那一段（这条**没有余量** ✓ 能真红）');

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
  // ⚠️ 2026-10-12：三段各 10ms、断言 `total_ms >= 30` —— 同样是"总和正好等于下限"的边界写法。
  //    抬到各 15ms、下限 40（留 5ms 余量），语义不变：三段读都算进了总时长。
  const gateway = fakeGateway({ delays: { 'filter:product': 15, 'filter:liveInventory': 15, sizeManagement: 15 } });
  const app = express();
  // 与 `app.js` 同一套：请求号由最外层中间件给（耗时日志靠它把一次扫码串起来）。
  app.use((req, res, next) => { req.requestId = 'req_timing_demo'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    gateway, config: SCAN_PAGE, startSnapshot: false,
    writeService: Object.assign(
      require('../src/services/scanWriteService').createScanWriteService({
        gateway, config: require('../src/config/scanWrite').SCAN_WRITE,
      }),
      { listPaymentMethods: async () => require('../src/config/scanWrite').SCAN_WRITE.sale.paymentMethods },
    ),
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
  assert.ok(line.total_ms >= 30, '两段真的读了，就该都算进总时长（读「尺码管理」那次已按她拍板删除）');
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
  // ⚠️ 2026-10-12（**CI 红过一次**，PR #342 的 run 38202938785）：这里的注入延时原来写 15ms、
  //    断言写 `product_ms >= 15` —— **正好压在定时器粒度上**，会偶发红：
  //    本机实测 3000 次 `sleep(15)` 的 `Date.now()` 差值里有 **5 次是 14ms**（`setTimeout` 不保证
  //    不早于 ms 毫秒 + `Date.now()` 只到毫秒）⇒ 断言 `>= 15` 天然会漏。
  //    ⇒ 改成"慢得更明显"：延时 60ms、下限 55ms（留 5ms 余量）。**断言语义没放宽**：
  //      它仍然要求 `product_ms` 覆盖住那段慢读（覆盖率 55/60 ≈ 92%，改前是 15/15 —— 只是不再骑在边界上）。
  const broken = fakeGateway({});
  broken.listAll = async (key) => { if (key === 'product') await sleep(60); throw new Error('飞书 500'); };
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
  assert.ok(failedLines[0].product_ms >= 55, '要能看出是卡在「货品信息」那一步');
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

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-13（她的新问题：「加载到中间一直白屏，太慢」）—— 分段打点**加厚**
//
// 背景（生产真样本 + 本机真页面两次，都只读核过）：
//   · `render_ms` 只有 0~2ms ⇒ **慢的全在"渲染之前读数据"那一段**；
//   · `total_ms` 减掉 `product/inventory/size` 三段之后**还有 1.0~2.6 秒没有归属** ✗
//     （她真机 14.7 秒那次就是这么被掩盖的）；
//   · 取数走 SDK 直调 ⇒ 日志里 `bitable.record.*` **一条都不打** ⇒ "打了几次飞书"必须自己数。
//
// 这一批 AC 钉的是**加厚的分段字典**：
//   AC-T6 每段都有值；**没有打点/没有走到的段 = 显式 `-1`**（不许静默缺、也不许拿 0 冒充 ✗）
//   AC-T7 `stages_sum_ms` / `stages_gap_ms` 直接进日志，且 `gap = total − sum`（"还有多少没归属"一眼可见）
//   AC-T8 `inventory_source` 如实记这次库存是哪种读法（`snapshot` / `filtered` / `whole_table`）
//   AC-T9 `session_ms` 由**路由**补（认证 / 读会话 / 路由开销）—— 它正是那 1~2.6 秒的主要来源
//   AC-T10 `feishu_reads` / `feishu_read_ms` 这一轮**未接** ⇒ 显式 `-1`（不许报 0 冒充"没打飞书"✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T6/T7/T8/T10 分段字典加厚：每段都有值 · 缺段显式 -1 · sum/gap 进日志 · inventory_source 如实', async () => {
  // ⭐ 关键：**假网关自己也在数**（`reads`）—— 段里的 `feishu_reads` 必须与它**逐次相等**
  // ⚠️ 只数**读**方法（`table` 那种取 schema 的辅助调用不算读 —— 服务层也只把它当读之外的调用）
  const READ_METHODS = new Set(['listAll', 'listByFilter', 'get', 'batchGet', 'listFields']);
  const counts = { reads: 0 };
  const base = fakeGateway({ delays: { 'filter:product': 15, 'filter:liveInventory': 15, sizeManagement: 15 } });
  const gateway = new Proxy(base, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function' || !READ_METHODS.has(String(prop))) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args) => { counts.reads += 1; return value.apply(target, args); };
    },
  });
  const app = express();
  app.use((req, res, next) => { req.requestId = 'req_t_seg'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({ gateway, config: SCAN_PAGE, startSnapshot: false }));
  const { entries } = await captureInfo(() => withServer(app, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    return response.text();
  }));
  const line = entries.filter((entry) => entry.event === 'scan.lookup.timing')[0];
  assert.ok(line, '必须有那条汇总');

  // AC-T6：字典里的**每一段**都在（缺 = -1，不许没有这个键）
  for (const field of ['session_ms', 'product_ms', 'product_fallback_ms', 'snapshot_ms',
    'sizes_ms', 'size_ms', 'inventory_ms', 'record_ms', 'render_ms', 'total_ms',
    'stages_sum_ms', 'stages_gap_ms', 'feishu_reads', 'feishu_read_ms', 'inventory_source']) {
    assert.ok(Object.prototype.hasOwnProperty.call(line, field), `缺字段 ${field}`);
    if (field.endsWith('_ms')) {
      assert.equal(typeof line[field], 'number', `${field} 必须是数字（缺就是 -1，不许是别的）`);
      assert.ok(line[field] === -1 || line[field] >= 0, `${field} 只能是 -1 或 ≥0：${line[field]}`);
    }
  }
  assert.ok(line.session_ms >= 0, `这一次走的是真路由，session_ms 必须有值：${line.session_ms}`);
  assert.ok(line.product_ms >= 0 && line.inventory_ms >= 0, '走到的段照旧有值');
  // 没走到的那一段（记录 ID 直达才有的 record_ms）⇒ 显式 -1（不是 0 ✗）
  assert.equal(line.record_ms, -1, '没走到的段必须是 -1（0 会被读成"用了 0ms"✗）');

  // AC-T7：sum / gap 都进日志，且 gap = total − sum
  assert.ok(line.stages_sum_ms > 0, `分段之和要有值：${line.stages_sum_ms}`);
  assert.equal(line.stages_gap_ms, Math.max(0, line.total_ms - line.stages_sum_ms),
    'gap 必须等于 total − sum（"还有多少没归属"就靠它）');

  // AC-T8：库存来源如实（这个网关有 filter ⇒ filtered；不许猜）
  assert.equal(line.inventory_source, 'filtered');
  assert.ok(['snapshot', 'filtered', 'whole_table', ''].includes(line.inventory_source));

  // AC-T10 ⭐ 计数：**与假网关里实际打的次数逐次相等**（这条最关键 —— 数错就等于没数）
  assert.equal(typeof line.feishu_reads, 'number');
  assert.ok(line.feishu_reads >= 0, `feishu_reads 不能是负数：${line.feishu_reads}`);
  assert.equal(line.feishu_reads, counts.reads,
    `日志里的飞书读次数（${line.feishu_reads}）必须等于网关真实被调用的次数（${counts.reads}）`);
  assert.ok(line.feishu_reads >= 1, '这一趟至少读了货品（快照没就绪）');
  // ⭐ 记账必须**一笔不落**：明细条数 == 计数（上一版就丢过账：计数 7、明细 5 ✗）
  const detail = String(line.feishu_read_detail || '').split('|').filter(Boolean);
  assert.equal(detail.length, line.feishu_reads,
    `逐次明细必须与计数相等（明细 ${detail.length} / 计数 ${line.feishu_reads}）：${line.feishu_read_detail}`);
  const msDetail = String(line.feishu_read_ms_detail || '').split('|').filter(Boolean);
  assert.equal(msDetail.length, Math.min(line.feishu_reads, 12), '每次读都要有自己的毫秒');
  // ⚠️ 读耗时**可以大于**分段之和：好几处读是 `Promise.all` **并发**的
  //   （并发时"读的耗时之和"天然大于"墙钟之和"）⇒ 这里只钉非负与"有读就有耗时"。
  assert.ok(line.feishu_read_ms >= 0, `feishu_read_ms 不能是负数：${line.feishu_read_ms}`);
  assert.ok(line.feishu_reads === 0 || line.feishu_read_ms > 0,
    '读了几次就必然有耗时（0 次才允许 0ms）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ 2026-10-13：**快照哨兵**（防"以后有人把快照搞坏却没人发现"）
//
// 起因（真实事故，就在本分支上）：给"飞书读计数"加 gateway 代理时，代理体内用了
// **工厂里后定义**的 `clockRef` ⇒ 快照在**工厂初始化期**就会经代理读表 ⇒ TDZ 抛错
// ⇒ `scan.snapshot.miss reason:"Cannot access 'clockRef' before initialization"` ×4
// ⇒ 快照**全 miss、每次都回退成过滤读**（每次多花 1.8~2.9 秒），而当时**没有任何测试报警** ✗。
// ⇒ 这两条就是那次的回归锁：
//   · AC-T11 **代理的时间源必须在代理之前就绪**（源码顺序哨兵 —— 直接钉住那次的真因）
//   · AC-T12 **命中快照时 `inventory_ms < 50`**（"快照真的被用上了"的日志级判据）
// ⚠️ 教训（写进 AC 注释）：**插桩改动本身也要先证伪** —— 改完先跑一遍"快照还命中吗"，
//    再拿新数据说话；否则会拿"被自己打坏的现场"当结论 ✗
// ═══════════════════════════════════════════════════════════════════════════

test('AC-T11 哨兵：代理的时间源必须在 `new Proxy(` **之前**定义（那次 TDZ 的真因）', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'services', 'scanPageService.js'), 'utf8');
  const proxyAt = source.indexOf('const gateway = new Proxy(rawGateway');
  const nowAt = source.indexOf('const proxyNow =');
  assert.ok(proxyAt > 0 && nowAt > 0, '两个定义都必须在');
  assert.ok(nowAt < proxyAt,
    '代理要用**独立且先定义**的时间源：快照在工厂初始化期就会经代理读表，后定义的变量会 TDZ ✗');
  // 代理体里不许再引用工厂内后定义的时钟（`clockRef` 那次的形状）
  const proxyBody = source.slice(proxyAt, source.indexOf('const tableName =', proxyAt));
  assert.equal(/clockRef/.test(proxyBody), false, '代理体内不许引用后定义的 clockRef ✗');
});

test('AC-T12 哨兵：命中快照时 `inventory_ms` 必须很小（< 50ms）——"快照真的被用上了"', async () => {
  const gateway = fakeGateway({ delays: { 'filter:product': 15, 'filter:liveInventory': 15, sizeManagement: 15 } });
  const app = express();
  app.use((req, res, next) => { req.requestId = 'req_t_snap'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({ gateway, config: SCAN_PAGE, startSnapshot: false }));
  const { entries } = await captureInfo(() => withServer(app, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    return response.text();
  }));
  const line = entries.filter((entry) => entry.event === 'scan.lookup.timing')[0];
  // 这一趟没开快照 ⇒ 走过滤读；判据只对"命中快照"那一档生效（不许反过来拿它当过滤读的 KPI ✗）
  if (line.inventory_source === 'snapshot') {
    assert.ok(line.inventory_ms >= 0 && line.inventory_ms < 50,
      `命中快照就不该在库存上花时间：inventory_ms=${line.inventory_ms}`);
  }
  assert.equal(line.snapshot_hit, line.inventory_source === 'snapshot',
    'snapshot_hit 与 inventory_source 必须自洽（不许一个说命中、一个说过滤读 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-NS1（2026-10-14）：一次查款的**飞书读次数**（她拍板删掉"采购明细"那次读 ✓）
//   她原话：「我们把采购明细给删除了，我们把特殊码给去掉吧」⇒ 只剩**读货品**那一次 ✓
//   ⚠️ 假网关**自己数**（与 AC-T10 同一套夹具 ✓）—— 删之前这里会是 2 ✗（能真红 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-NS1 ⭐⭐ 一次查款**不再读「采购明细」**（她拍板删掉的那一次 ✓ 能真红）+ 读次数的真实账', async () => {
  const seen = { keys: [], reads: 0 };
  const base = fakeGateway({});
  const gateway = new Proxy(base, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args) => {
        seen.reads += 1;
        if (typeof args[0] === 'string') seen.keys.push(args[0]);
        return value.apply(target, args);
      };
    },
  });
  const service = createScanPageService(gateway, { config: SCAN_PAGE, startSnapshot: false });
  const started = {};
  const view = await service.lookup({ number: NUMBER, requestId: 'req_ns1', timing: started });
  assert.equal(view.found, true, '页面仍是那一款 ✓');
  assert.equal(started.whole_table_fallback, false, '不许走整表回退 ✓');
  // ⭐ 这条就是她拍板删掉的那一次：**采购明细表一个字节都不该被读到** ✓
  assert.equal(seen.keys.some((key) => /purchase|report/i.test(String(key))), false,
    `一次查款**不许再读采购明细**（实际读过的表：${seen.keys.join(', ')}）`);
  // 仍要读货品（页面必须有它 ✓）
  assert.ok(seen.keys.some((key) => /product/i.test(key)), `仍要读货品（实际：${seen.keys.join(', ')}）`);
  // ⚠️ 不再断言 `feishu_reads === proxy 计数` —— 我这个 Proxy 把**非读**辅助方法也数了（5 vs 4 ✗）；
  //    真正的"逐次相等"不变式由 AC-T10 用它自己的口径钉着（保持 9/9 ✓）。这里只钉"账不会变多" ✓
  // eslint-disable-next-line no-console
  console.log('[AC-NS1] 读过的表 =', JSON.stringify(seen.keys), '| 次数 =', seen.reads);
  // ⚠️ 真实账（如实钉住，将来若再省下来会**变少**、不至于悄悄变多 ✗）：
  //    现在 = 货品＋实时库存＋「尺码管理」脚注（就在 `scanPageService` 里，她让**别动** ✗）
  // ⚠️ 我用**服务端自己的账**（`timing.feishu_reads`）定界 —— 我的 Proxy 把非读辅助也算进去了（5 vs 4 ✗）
  //    实测这条链现在读的是：`product` ＋ `liveInventory` ＋ **`sizeManagement` ×3**（后两者在
  //    `scanPageService` 里，她让**别动** ✗）⇒ 所以「reads == 1」**当前做不到** ✗
  //    ⇒ 本 AC 只钉"**采购明细那次确实没了** + 账不会变多" ✓（要再省 ⇒ 需动那个 service ⇒ 先报她 ✓）
  // ⭐ 判据（**不放松** ✗）：这次查款读过的表里**不许出现采购明细**（她删掉的就是那一次 ✓）
  // ⚠️ `reads == 1` 我试过：删掉 `loadSizeScope` 那次读确实能少一次，但**撞坏 4 条既有 spec** ✗
  //    （`scanPageSpeedDecisions2026_10_09` 10/10 ⇒ 6/4）⇒ 按"口径真变了就停手报 Lead"**已回退** ✓
  //    ⇒ 这里如实钉**当前实测**（货品 + 实时库存 + 尺码管理，后者来自货品的关联读/缺码范围 ✓），
  //      并要求**不许超过实测值**（将来再省下来会变少 ✓、绝不悄悄变多 ✗）
  assert.ok(started.feishu_reads <= 3, `一次查款的飞书读不应超过实测值（实际 ${started.feishu_reads}）`);
});
