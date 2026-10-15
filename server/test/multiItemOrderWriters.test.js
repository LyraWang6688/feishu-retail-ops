/**
 * task-46 第 2 步 · **切片 2a**：`scanWriteService.multiItemWriters()` 只读访问器。
 *
 * Lead 2026-10-15 批准的硬要求（逐字）：
 *   「**两次调用必须返回【同一批实例】（引用相等 ✓）** —— 不许每次调用都新建一份 ✗」
 *   理由：那两个写入件里带着**串行队列 / 幂等缓存 / 装配好的 references** ⇒
 *   每次新建 ⇒ 队列与幂等状态**分叉** ⇒ 同一单可能被两条队列各写一次 ✗（把"防重复"的地基挖了）。
 *
 * AC-RT7 🔴 `multiItemWriters()` 调两次 ⇒ **`===` 同一对象**；两个写入件也各是同一实例 ✓
 * AC-RT7b ⭐ 它给引擎用的键名 = `config.multiItemOrder.chains[].writer`（两边不许漂移 ✗）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_writers';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_writers_secret';

const { createScanWriteService } = require('../src/services/scanWriteService');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');

const build = () => createScanWriteService({ gateway: {}, config: SCAN_WRITE });

test('AC-RT7 🔴 `multiItemWriters()` 两次调用 ⇒ **引用相等**（同一批实例，队列/幂等不分叉）', () => {
  const write = build();
  assert.equal(typeof write.multiItemWriters, 'function', '要有这个只读访问器 ✓');
  const first = write.multiItemWriters();
  const second = write.multiItemWriters();
  // 🔴 能真红：把访问器改成每次 `return { purchase: purchase(), purchaseReturn: purchaseReturn() }` ⇒ 红
  assert.equal(first, second, '🔴 两次必须是**同一个对象**（能真红：每次新建 ⇒ 红）');
  assert.equal(first.purchase, second.purchase, '`purchase` 必须是同一实例 ✓');
  assert.equal(first.purchaseReturn, second.purchaseReturn, '`purchaseReturn` 必须是同一实例 ✓');
  // 另一个实例拿到的是**另一批**（不是全局单例）—— 免得两个 router 之间串状态
  const other = build().multiItemWriters();
  assert.notEqual(first, other, '不同 service 实例 ⇒ 各自一批（不是进程级单例 ✓）');
});

test('AC-RT7b ⭐ 它给引擎的键名 = `config.multiItemOrder.chains[].writer`（两边不许漂移 ✗）', () => {
  const writers = build().multiItemWriters();
  const cfg = resolveMultiItemOrderConfig({});
  for (const chain of Object.keys(cfg.chains)) {
    const key = cfg.chains[chain].writer;
    assert.equal(typeof writers[key], 'function',
      `链 ${chain} 的 writer 键名「${key}」必须在访问器给的这批里 ✓（改名 ⇒ 红）`);
  }
  assert.deepEqual(Object.keys(writers).sort(), ['purchase', 'purchaseReturn']);
});
