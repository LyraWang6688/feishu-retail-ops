'use strict';

/**
 * ⭐⭐ 2026-10-15（task-48 · 她认可埋点方向 · 她关心的原话是「**方便我们的排查**」）
 *
 * 本文件钉**这次新增的四类事实埋点**（a/c/d）+ **点击↔写入那条关联键**（b）：
 *   · `fluency:skeleton` —— 骨架停留时长（"无声停留"的量化 ✓）
 *   · `fluency:card_swap` —— 卡片整块跳变次数（"先出现一个配品再换表单"那类 ✓）
 *   · `fluency:realm` / `fluency:form` —— "看着像坏了"的动作：她点了什么、页面给了什么 ✓
 *   · `fluency:error` —— **前端 404 / JS 报错统一入口** ✓（今晚是靠"爬资源"才发现的 ✗）
 *
 * AC-LOG1 每条**能真红**（去掉那一句上报 ⇒ 红）· AC-LOG2 **不采集隐私**（白名单 + query 一律丢 ✗）
 * AC-LOG4 **不新造键名**：沿用既有 `tap_id`（任务书建议的 `client_tap_id` **没有采用**，理由写在
 *         `src/utils/correlationFields.js` 与体检表里 ✓）
 *
 * ⚠️ `public/workbench/shared/ui-fluency.js` 是**零 import 的 ES 模块** ⇒ 用例直接 `import()` 它
 *    （不需要真浏览器：`now` / `post` / `win` 全部可注入 ✓）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'server/public/workbench/shared/ui-fluency.js');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const load = () => import(pathToFileURL(MODULE_PATH).href);

test('AC-LOG1 ⭐ 四类事实各有一条上报（能真红：删掉任一句 ⇒ 红）', async () => {
  const mod = await load();
  const sent = [];
  let clock = 0;
  const tracker = mod.createFluencyTracker({ post: (p) => sent.push(p), now: () => clock, slowMs: 1000 });
  clock = 0; tracker.skeletonShown();
  clock = 2600; tracker.skeletonReplaced();          // 骨架停了 2.6s ⇒ 应打 level:slow
  tracker.cardSwapped('orders');
  tracker.realmEntered('inventory');
  tracker.formRevealed('return-form');
  tracker.uiError({ status: '404', path: '/api/workbench/orders?q=1', summary: 'not found' });

  const targets = sent.map((p) => p.target);
  assert.deepEqual(targets, [
    'fluency:skeleton', 'fluency:card_swap', 'fluency:realm', 'fluency:form', 'fluency:error',
  ], '五条事实各上报一次 ✓');
  const skeleton = sent[0];
  assert.equal(skeleton.ms, '2600', '⭐ 骨架停留时长是**量出来的**（能真红）');
  assert.equal(skeleton.level, 'slow', '⭐ 超阈值打标（她照 level:slow 过滤就能挑出慢的 ✓）');
  assert.equal(sent[1].count, '1', '卡片跳变第 1 次 ✓');
  assert.equal(sent[2].realm, 'inventory', 'realm 事实 ✓');
  assert.equal(sent[3].form, 'return-form', '表单事实 ✓');
  assert.equal(sent[4].status, '404', '⭐ 404 进统一入口 ✓');
  // 没进过骨架 ⇒ **不许编**一条（如实 ✓）
  const fresh = mod.createFluencyTracker({ post: () => {}, now: () => 0 });
  assert.equal(fresh.skeletonReplaced(), null, '没进过骨架就不报（不编 ✗）');
});

test('AC-LOG2 🔴 不采集隐私：白名单外的键一律丢、query 一律丢（能真红：放开白名单 ⇒ 红）', async () => {
  const mod = await load();
  const payload = mod.sanitizeFluencyPayload({
    target: 'fluency:form', form: 'return-form',
    // ⛔ 下面这些**一个都不许进日志**
    客户姓名: '张三', phone: '13800138000', idCard: '310...', amount: '199.00', memo: '客户说…',
    path: '/api/workbench/orders?customer=张三&phone=13800138000',
  });
  assert.deepEqual(Object.keys(payload).sort(), ['form', 'path', 'target'], '只有白名单键能进 ✓');
  assert.equal(payload.path, '/api/workbench/orders', '⛔ query 一律丢掉（编号/客户信息都可能在里面 ✗）');
  assert.equal(JSON.stringify(payload).includes('张三'), false, '⛔ 姓名不许出现 ✗');
  assert.equal(JSON.stringify(payload).includes('13800138000'), false, '⛔ 电话不许出现 ✗');
  // 源码哨兵：这个模块**不许**去读表单值 / localStorage / 提交体
  const src = read('server/public/workbench/shared/ui-fluency.js');
  for (const forbidden of ['req.body', 'localStorage', 'form.elements', '.value']) {
    assert.equal(src.includes(forbidden), false, `⛔ ui-fluency 不许碰 ${forbidden}（隐私红线 ✗）`);
  }
  // 全局观察者只挂 error / unhandledrejection / fetch 三类
  assert.ok(src.includes("addEventListener?.('error'"), 'JS 报错入口 ✓');
  assert.ok(src.includes("addEventListener?.('unhandledrejection'"), 'Promise 报错入口 ✓');
  assert.ok(src.includes('response.status === 404'), '⭐ 404 统一入口 ✓');
});

test('AC-LOG4 ⭐ 关联键沿用既有 `tap_id`（**不新造 `client_tap_id`**；能真红：塞回新名字 ⇒ 红）', () => {
  const { CORRELATION_KEYS } = require('../src/utils/correlationFields');
  assert.ok(CORRELATION_KEYS.includes('tap_id'), '⭐ `tap_id` 必须能进写库日志（b 的贯穿）✓');
  assert.ok(CORRELATION_KEYS.includes('task_id') && CORRELATION_KEYS.includes('order_no'),
    '既有关联键一个没丢 ✓');
  // ⛔ **不许真的用**那个备选名（同一个东西两个名字 ⇒ `grep '"tap_id":…'` 串不起整条链 ✗）
  //    ⚠️ 判据 = "**赋值 / 取值**"那种用法；注释里**说明"为什么没采用它"**是应当的（AC-LOG4 要的"写清理由" ✓）
  //    ⚠️ 用 Node 做（不再拼 shell 引号 —— 那个引号陷阱今天已经踩过一次 ✗）
  const files = require('node:child_process')
    //    ⚠️ 只扫**代码侧**（`src` / `public`）：`test/logCorrelation.test.js` 里**故意**把它当
    //       "混进来必须被拒"的噪声喂进去 ✓（那是判据，不是用法）
    .execSync('git ls-files server/src server/public', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const offenders = files.filter((f) => /client_tap_id\s*[:=]/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  assert.deepEqual(offenders, [], '⛔ 不许真的用第二个名字（理由写在 correlationFields.js 里）✗');
});

test('AC-LOG1b `tap_id` 能从请求里取出来接进写库日志（能真红：改读错字段 ⇒ 红）', () => {
  const { tapIdFromRequest, correlationFields } = require('../src/utils/correlationFields');
  assert.deepEqual(tapIdFromRequest({ body: { tap_id: 'tap-1' } }), { tap_id: 'tap-1' }, 'body 里取 ✓');
  assert.deepEqual(tapIdFromRequest({ query: { tap_id: 'tap-2' } }), { tap_id: 'tap-2' }, 'query 里取 ✓');
  assert.deepEqual(tapIdFromRequest({ body: {}, query: {} }), {}, '取不到 ⇒ **不编** ✗');
  // 与既有网关那一套合起来用：写路径只要这么接就能带上它 ✓
  assert.deepEqual(correlationFields({ ...tapIdFromRequest({ body: { tap_id: 'tap-3' } }), order_no: 'XSD-1' }),
    { order_no: 'XSD-1', tap_id: 'tap-3' }, '写库日志能同时带单号与点击 id ✓');
});

test('AC-LOG5 阈值走配置（换值不用改代码；能真红：写死 ⇒ 红）', () => {
  const cfg = read('server/public/workbench/config/telemetry.js');
  assert.match(cfg, /FLUENCY_TELEMETRY/, '客户端那份配置能读 ✓');
  assert.match(cfg, /slowMs:\s*1000/, '阈值在配置里 ✓');
  const src = read('server/public/workbench/shared/ui-fluency.js');
  assert.match(src, /slowMs = 1000/, '模块参数默认值来自配置口径（可注入 ✓）');
  assert.match(src, /FLUENCY_ALLOWED_KEYS/, '白名单是导出常量（用例可核 ✓）');
});
