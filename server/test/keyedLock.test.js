'use strict';

/**
 * #50：进程内按 key 串行锁（库存手工调整的 read-modify-write 并发防护）。
 *   AC-KL-1 同 key 严格串行（不会同时进入临界区）
 *   AC-KL-2 不同 key 可并行
 *   AC-KL-3 前一个失败不挡住后一个
 *   AC-KL-4 库存单双调整的公开入口确实接了锁（源码哨兵）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createKeyedLock } = require('../src/utils/keyedLock');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('AC-KL-1 同 key 严格串行', async () => {
  const lock = createKeyedLock();
  let active = 0;
  let maxActive = 0;
  const task = (value) => lock('same', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(5);
    active -= 1;
    return value;
  });
  const results = await Promise.all([task(1), task(2), task(3)]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.equal(maxActive, 1, '同 key 不许同时进临界区');
});

test('AC-KL-2 不同 key 可并行', async () => {
  const lock = createKeyedLock();
  let active = 0;
  let maxActive = 0;
  const task = (key) => lock(key, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(5);
    active -= 1;
  });
  await Promise.all([task('a'), task('b')]);
  assert.equal(maxActive, 2);
});

test('AC-KL-3 前一个失败不挡住后一个', async () => {
  const lock = createKeyedLock();
  const first = lock('k', async () => { throw new Error('boom'); });
  await assert.rejects(first, /boom/);
  await assert.doesNotReject(lock('k', async () => 'next'));
});

test('AC-KL-4 库存单双调整公开入口接了锁（源码哨兵）', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'inventoryPairAdjustmentService.js'), 'utf8',
  );
  assert.match(source, /adjustmentLock\(`inventory-pair:/, 'adjustPairs 必须按货品加锁');
  assert.match(source, /adjustmentLock\(`inventory-season:/, 'setSeason 必须按品类加锁');
});
