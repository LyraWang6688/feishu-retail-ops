/**
 * ⭐⭐ 2026-10-13（真根因 · 硬证据）：`JsonTaskStore.update()` = **读-改-写，三步之间没有互斥** ✗
 *   ⇒ 两个并发写会**互相覆盖**（后落的那个用**旧快照** ⇒ 先落的那个改动**丢了** ✗）。
 *
 *   真实现场（她真机 / 全量偶发）：提交成功后路由调 `setLastRealm`（**不在串行队列里** ✗），
 *   与紧接着的 `addLine`（在队列里 ✓）交错 ⇒ `setLastRealm` 用**提交后/加行前**的旧快照写回
 *   ⇒ 把刚加进去的那一行**抹掉** ✗（抓到的会话快照：`sale_status=submitted / sale_lines=0` ✗）。
 *
 *   ⚠️ 复现方式**不靠运气** ✗：把**第一次写文件**延后 80ms ⇒ 两个"读-改-写"必然交错 ✓
 *      （改前必红 ✓ 修好后必绿 ✓ —— 这是"能红的竞态 AC" ✓）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-mutex-${label}-`));

/** 可控调度：把**第一次**写文件延后 ms 毫秒（只改这一次 ⇒ 不改其它语义 ✓ 用完还原 ✓）。 */
const delayFirstWrite = (ms) => {
  const original = fs.promises.writeFile;
  let first = true;
  fs.promises.writeFile = async (...args) => {
    if (first) { first = false; await new Promise((resolve) => setTimeout(resolve, ms)); }
    return original(...args);
  };
  return () => { fs.promises.writeFile = original; };
};

test('AC-MX1 ⭐ 同一 id 的两个并发写 ⇒ **两个字段都要在**（读-改-写必须互斥）', async () => {
  const store = new JsonTaskStore({ dir: tempDir('store'), idField: 'task_id' });
  await store.create({ task_id: 'rec_1' });
  const restore = delayFirstWrite(80);
  try {
    await Promise.all([store.update('rec_1', { a: 1 }), store.update('rec_1', { b: 2 })]);
  } finally { restore(); }
  const record = await store.get('rec_1');
  assert.equal(record.a, 1, '先发的那个写**不许丢** ✗（丢了 = 真 bug ✓）');
  assert.equal(record.b, 2, '后发的那个写也要在 ✓');
});

test('AC-MX2 ⭐⭐ 真实现场：`setLastRealm`（提交后由路由调 ✗ 不在队列里）与 `addLine` 交错 ⇒ 那一行不许被抹掉', async () => {
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: tempDir('session') });
  const openId = 'ou_mutex_1';
  await sessions.ensure(openId);
  const restore = delayFirstWrite(80);
  try {
    await Promise.all([
      sessions.setLastRealm(openId, 'sales'),
      sessions.addLine(openId, { size: '41', amount: '99' }),
    ]);
  } finally { restore(); }
  const after = await sessions.get(openId);
  assert.equal((after.sale?.lines || []).length, 1, '刚加的那一行**不许**被 setLastRealm 的旧快照抹掉 ✗');
  assert.equal(after.last_realm, 'sales', 'last_realm 也要写上 ✓');
});

test('AC-MX3 回归：顺序执行时 update 的语义与返回值**逐字不变** ✓', async () => {
  const store = new JsonTaskStore({ dir: tempDir('seq'), idField: 'task_id' });
  await store.create({ task_id: 'rec_2', keep: 'x' });
  const first = await store.update('rec_2', { a: 1 });
  assert.equal(first.a, 1);
  assert.equal(first.keep, 'x', '其他字段不动 ✓');
  assert.ok(first.updated_at, 'updated_at 照旧写 ✓');
  const second = await store.update('rec_2', { b: 2 });
  assert.deepEqual([second.a, second.b, second.keep], [1, 2, 'x'], '顺序写叠加 ✓');
  await assert.rejects(() => store.update('rec_missing', { a: 1 }), /任务不存在/);
});
