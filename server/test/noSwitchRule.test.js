'use strict';

/**
 * ⭐⭐ **不再有开关**（业务负责人 2026-10-16 22:5x 逐字）：
 *   「**不用。以后你不用有"开关"的这个思维，我们换了新功能，就直接用新功能就可以了呀。
 *     把新功能都上了，不需要开关。**」
 * ⇒ 落档 `docs/no-switch-rule-2026-10-16.md` ✓（PR #786 ✓）
 *
 * 判据（**先写后做** ✓ 每条能真红 ✓；本文件按批次**逐批加** ✗ 一次只钉一个开关 ✓）：
 *   **AC-NS1** ⭐ **开关名全仓 0 处读取**（源码扫 ✓ "退役 = 删代码，不是翻开关" ✓）
 *   **AC-NS2** 🔴 **反向哨兵**：⭐ **名字回来 ⇒ 红** ✓（逐个钉 ✓）
 *   **AC-NS4** ⭐ **老分支没了**：⭐ 那几处"关着时的老路"**不许留下一行** ✗
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const SRC = path.join(SERVER, 'src');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return walk(full);
  return e.name.endsWith('.js') ? [full] : [];
});
/**
 * ⚠️ 判**代码**（**剥掉注释** ✗）—— 成对迁移注释里**必须**引用旧开关名（写"改前逐字"✓），
 *   那不是"读取点" ✗；真读取（`readFlag(env, 'SCAN_…')` / 真分支）一定在**代码**里 ✓（强度不降 ✓）。
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .map((line) => line.replace(/\/\/.*$/, '')).join('\n');
const allSrc = () => walk(SRC).map((f) => ({
  file: path.relative(SERVER, f), text: stripComments(fs.readFileSync(f, 'utf8')),
}));

test('AC-NS1 + AC-NS2 ⭐ **一单多货异步那一刀**：`SCAN_MULTI_ITEM_ASYNC_ENABLED` / `asyncEnabled` **全仓 0 处**（回来即红 ✓）', () => {
  const hits = allSrc().filter(({ text }) => text.includes('SCAN_MULTI_ITEM_ASYNC_ENABLED') || /\basyncEnabled\b/.test(text));
  assert.deepEqual(hits.map((h) => h.file), [],
    '⭐ 那个开关必须**删净** ✗（她 22:5x：不需要开关 ⇒ 永远开 ✓）—— 名字回来 ⇒ 红 ✓');
  // ⭐ 行为还在（"永远开"）⇒ 后台那一跑的调度点必须仍在（不然就把功能删了 ✗）
  const routes = fs.readFileSync(path.join(SRC, 'routes', 'scanPage', 'index.js'), 'utf8');
  assert.ok(/schedulePurchaseRest|schedulePurchaseWrite/.test(routes),
    '⭐ "提交即回、后台那一跑"必须**照旧在** ✗（删开关 = 永远开 ✓ 不是把功能删了 ✗）');
});
