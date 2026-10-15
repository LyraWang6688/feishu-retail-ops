'use strict';

/**
 * ⭐⭐ 2026-10-16（task-52 · AC-ASY1/2/3 · 先写判据）：**补货 / 退货 / 验收 共用的「后台那一半」**
 *
 * 这一份只钉**后台件本身**（`services/purchaseWriteBackgroundService.js`）：
 *   AC-ASY1 ⭐ 排一次 ⇒ **不 await 也照跑**（她已经拿到成功页 ✓）⇒ 跑完 `runRest` **真的被调**、参数逐字透传 ✓
 *   AC-ASY2 🔴 **失败如实**：`runRest` 返回 `{ok:false}` 或**抛** ⇒ ① 记 warn ② `markFailed` 被调
 *            （⇒ 状态可查 + 可重试）③ **不许把失败吞成成功**（返回值 `ok:false`，绝不 `ok:true` ✗）
 *   AC-ASY3 🔴 **幂等不拆**：`submitKey` **原样透传**（重试/并发同一把键 ✓）—— 本件**不拼、不改** ✗
 *   AC-ASY4 ⭐ 三条链路**同一个件**（`chain` 只是标签 ⇒ 行为一致 ✓）
 *   AC-SP2 ⭐ 配置**注入**（事件名 / phase / 超时都从参数来 ⇒ 本件**不 require 任何 config** ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const logger = require('../src/utils/logger');
const logs = [];
const originalWarn = logger.logWarn;
const originalInfo = logger.logInfo;
logger.logWarn = (event, fields) => { logs.push({ level: 'warn', event, fields }); };
logger.logInfo = (event, fields) => { logs.push({ level: 'info', event, fields }); };
test.after(() => { logger.logWarn = originalWarn; logger.logInfo = originalInfo; });

const {
  createPurchaseWriteBackgroundService, waitForPendingPurchaseBackgrounds,
} = require('../src/services/purchaseWriteBackgroundService');

const CONFIG = Object.freeze({
  events: Object.freeze({ restTiming: 'purchase.write.rest.timing', restFailed: 'purchase.write.background.failed' }),
  timing: Object.freeze({ phase: Object.freeze({ background: 'background' }) }),
});

const build = ({ runRest, markFailed, purchaseAsync = { backgroundTimeoutMs: 30000 } } = {}) => {
  const calls = [];
  const marks = [];
  const service = createPurchaseWriteBackgroundService({
    runRest: runRest || (async (input) => { calls.push(input); return { ok: true, order_no: 'CGD-1' }; }),
    markFailed: markFailed || (async (input) => { marks.push(input); }),
    purchaseAsync,
    config: CONFIG,
  });
  return { service, calls, marks };
};

test('AC-ASY1 ⭐ 排一次 ⇒ **不 await 也照跑**（她已拿到成功页 ✓）· 参数逐字透传', async () => {
  logs.length = 0;
  const h = build();
  const promise = h.service.schedulePurchaseRest({
    chain: 'replenish', requestId: 'req_1', submitKey: 'key-abc', context: { openId: 'ou_1' }, restInput: { sizes: ['40'] },
  });
  // ⚠️ 口径写准（我第一版写错过 ✗）：fire-and-forget 的语义是"**调用方不必 await**"，
  //   **不是**"排完那一刻还没跑" —— `runRest` 会在首个 `await` 之前就**同步**被调 ✓。
  //   ⇒ 这里钉的是：① 它**立即返回一个 Promise**（调用方可选择不 await ✓ 她不被打断 ✓）
  //     ② 不 await 也**照样跑完** ✓
  assert.equal(typeof promise?.then, 'function', '立即返回 Promise（调用方可不等它 ✓）');
  await promise;
  assert.equal(h.calls.length, 1, '随后**真的跑了** ✓');
  assert.equal(h.calls[0].chain, 'replenish');
  assert.equal(h.calls[0].submitKey, 'key-abc', '🔴 幂等键原样透传 ✓');
  assert.deepEqual(h.calls[0].restInput, { sizes: ['40'] });
  assert.equal(logs.some((entry) => entry.event === 'purchase.write.rest.timing'), true, '后台也要打 timing ✓');
});

test('AC-ASY2 🔴 **失败如实**（返回 ok:false）⇒ 记 warn ＋ `markFailed`（可查可重试）＋ **绝不假装成功**', async () => {
  logs.length = 0;
  const h = build({ runRest: async () => ({ ok: false, message: '库存那一列没写进去' }) });
  const result = await h.service.schedulePurchaseRest({ chain: 'return', submitKey: 'k1' });
  assert.equal(result.ok, false, '🔴 失败就是失败（不许吞成成功 ✗）');
  const warned = logs.find((entry) => entry.event === 'purchase.write.background.failed');
  assert.ok(warned, '必须**如实记一条 warn** ✓');
  assert.match(warned.fields.error, /库存那一列/, 'warn 里要有真原因 ✓');
  assert.equal(h.marks.length, 1, '必须调 `markFailed` ⇒ 状态可查 + 可重试 ✓');
  assert.equal(h.marks[0].submitKey, 'k1', 'mark 也要带**同一把键**（重试才认得出这一单 ✓）');
});

test('AC-ASY2b 🔴 **抛异常**也如实（不许冒泡到她那儿、也不许吞成成功）', async () => {
  logs.length = 0;
  const h = build({ runRest: async () => { throw new Error('飞书 500'); } });
  const result = await h.service.schedulePurchaseRest({ chain: 'accept', submitKey: 'k2' });
  assert.equal(result.ok, false, '抛 ⇒ 也必须如实成失败 ✓');
  assert.equal(logs.some((entry) => entry.event === 'purchase.write.background.failed'), true, '留痕 ✓');
  assert.equal(h.marks.length, 1, '可重试 ✓');
});

test('AC-ASY3 🔴 **幂等不拆**：并发/重试**同一把 submitKey** 原样透传（本件不拼不改 ✗）', async () => {
  logs.length = 0;
  const h = build();
  await Promise.all([
    h.service.schedulePurchaseRest({ chain: 'replenish', submitKey: 'same-key' }),
    h.service.schedulePurchaseRest({ chain: 'replenish', submitKey: 'same-key' }),
  ]);
  assert.deepEqual(h.calls.map((call) => call.submitKey), ['same-key', 'same-key'], '两跑都是**同一把键** ✓');
});

test('AC-ASY4 ⭐ 三条链路**同一个件**：`chain` 只是标签 ⇒ 行为一致（成功/失败口径不因链路而变 ✓）', async () => {
  logs.length = 0;
  for (const chain of ['replenish', 'return', 'accept']) {
    const h = build();
    const result = await h.service.schedulePurchaseRest({ chain, submitKey: `k-${chain}` });
    assert.equal(result.ok, true, `${chain} 成功口径一致 ✓`);
    assert.equal(h.calls[0].chain, chain);
  }
});

test('AC-SP2 ⭐ 配置**全部注入**（本件不 require 任何 config ✗）· 登记簿能等（用例专用入口 ✓）', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'purchaseWriteBackgroundService.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(/require\(['"]\.\.\/config\//.test(code), false,
    '🔴 本件**不许 require 任何 config**（开关/超时/事件名**注入** ⇒ 不依赖 `retry-ui` 在动的那两处 ✓）');
  // 登记簿：排两跑 ⇒ 等一次就都完成 ✓
  const h = build();
  h.service.schedulePurchaseRest({ chain: 'replenish', submitKey: 'a' });
  h.service.schedulePurchaseRest({ chain: 'return', submitKey: 'b' });
  await waitForPendingPurchaseBackgrounds();
  assert.equal(h.calls.length, 2, '两个后台都跑完了 ✓');
});
