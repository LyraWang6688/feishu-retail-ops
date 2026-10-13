'use strict';

/**
 * ⭐⭐ 2026-10-14（她 02:31 那次扫码 `total_ms=7451`、`feishu_reads=2`）：**启动预热「实时库存」快照**。
 *
 * 根因：快照实例是**扫码服务被创建时**才建的 ⇒ 服务重启后到第一次扫码之间它是**冷的** ✗
 *       ⇒ 那一次退回真读（她 2026-10-14 日志：命中快照 `total_ms=1743` / 冷 `7451`）。
 * 做法：`app.js` 启动处调 `warmLiveInventorySnapshot({reason:'warm'})` —— 用**已经建好的实例** ✓
 *       **绝不新建第二个快照** ✗（新建 = 两份缓存 / 双份读表 / 互相作废）。
 *
 * ⚠️ 本机 `.env` **没有可用的 `LARK_AGENT_*`**（按纪律本机不配有效凭证 ✓）⇒ **真启动在本机起不来** ✗
 *    ⇒ 这里只用「单测 + 源码哨兵」出证据；**真启动/线上首次扫码 `snapshot_hit=true` 由 Lead 在服务器验**。
 *
 * AC：
 *   AC-W1 预热**恰好一次**（`refresh({reason:'warm'})`）+ `app.js` 调了它 + `app.js` **没有**新建实例
 *   AC-W2 预热失败 ⇒ **不抛到外面**（服务照常起）+ warn 用**既有事件名** `scan.snapshot.refresh_failed`
 *   AC-W3 缺省作用于**服务自己那个实例**（不新建 ✗）· 没有实例 ⇒ 预热是**安全的空操作**（`warmed === 0`）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { warmLiveInventorySnapshot } = require('../src/services/scanPageService');
const { SCAN_PAGE } = require('../src/config/scanPage');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const SERVICE_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scanPageService.js'), 'utf8');

test('AC-W1 预热恰好一次：`refresh({reason:"warm"})` 被调 1 次 + app.js 真的调了它', async () => {
  const calls = [];
  const fake = { refresh: async (options) => { calls.push(options); } };
  const warmed = await warmLiveInventorySnapshot({ reason: 'warm', snapshots: [fake] });
  assert.equal(warmed, 1, '正好预热 1 个实例');
  assert.equal(calls.length, 1, '`refresh` 恰好被调 1 次（多调 = 重复预热 ✗）');
  assert.equal(calls[0]?.reason, 'warm', 'reason 必须是 warm（线上就是靠它 grep 证据 ✓）');

  // ⭐ 源码哨兵（能真红）：`app.js` 确实调了 warm
  assert.match(APP_SOURCE, /warmLiveInventorySnapshot\(/, 'app.js 启动处必须调 warmLiveInventorySnapshot');
  // ⭐ 反向哨兵（能真红）：`app.js` **不许**自己建快照（那就会有两个实例 ✗）
  assert.equal(APP_SOURCE.includes('createLiveInventorySnapshot('), false,
    'app.js 不许出现 createLiveInventorySnapshot( —— 会建出第二个快照 ✗');
  assert.equal(APP_SOURCE.includes('createProductSnapshot('), false, '同理：货品快照也不许在 app.js 里建');
});

test('AC-W2 预热失败 ⇒ 不抛到调用外（服务照常起）+ warn 用**既有**事件名', async () => {
  const boom = { refresh: async () => { throw new Error('快照表读不动'); } };
  // ① 不抛出去：预热失败绝不能把启动搞挂 ✗
  const warmed = await warmLiveInventorySnapshot({ reason: 'warm', snapshots: [boom] });
  assert.equal(warmed, 0, '失败的那个不算预热成功');
  // ② 用的是**既有**事件名（不许新造 ✗）
  assert.equal(SCAN_PAGE.events.snapshotFailed, 'scan.snapshot.refresh_failed', '既有事件名不许改');
  assert.match(SERVICE_SOURCE, /SCAN_PAGE\.events\.snapshotFailed/, 'warn 必须走既有事件名');
  // ③ 失败也要能继续下一个实例（不因为一个坏实例放弃整批）
  const good = { refresh: async () => {} };
  const mixed = await warmLiveInventorySnapshot({ reason: 'warm', snapshots: [boom, good] });
  assert.equal(mixed, 1, '一个失败不影响另一个');
});

test('AC-W3 缺省作用于「服务自己那个实例」· 没有实例时是安全空操作（不新建 ✗）', async () => {
  // 没有登记实例（本用例进程里没建过 scanPageService）⇒ 预热必须**安全地什么都不做**
  const warmed = await warmLiveInventorySnapshot({ reason: 'warm' });
  assert.equal(warmed, 0, '没有实例 ⇒ 0（绝不偷偷新建一个 ✗）');
  assert.match(SERVICE_SOURCE, /liveInventorySnapshots\.push\(snapshot\)/,
    '服务创建实例时必须登记 —— 预热打的**就是它自己那个实例** ✓（这是"同一实例"的源码证据 ✓）');
  assert.match(SERVICE_SOURCE, /const targets = Array\.isArray\(snapshots\) \? snapshots : liveInventorySnapshots;/,
    '缺省 = 登记表（生产路径不新建 ✓）');
});
