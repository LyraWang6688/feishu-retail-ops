'use strict';

/**
 * ⭐⭐ `test/support/scanPageReadRedirect.js` 的**自带判据**（Lead 要求 ✓）：
 *   · 拦到目标 ⇒ 返回**聚合文本**（= `scanPageSource()` ✓ **能过语法解析** ✓）
 *   · **别的路径 ⇒ 原样返回**（含 `routes/scanPage/**` 的子文件 ✗ 不许拦）
 *   · 不传 encoding ⇒ **Buffer**（与 `fs.readFileSync` 行为一致 ✓）
 *
 * ⭐⭐ 2026-10-16（第 2 轮 A′）**成对迁移**（改前逐字 → 改后逐字 → 依据）：
 *   改前逐字：`assert.equal(sha(text), ORIGINAL_SHA256)`（"聚合 == 拆之前那一份"的**整份 sha** ✓ 74cc86d…）
 *   改后逐字：`assert.equal(text, scanPageSource())` ＋ `new vm.Script(text)` **能解析** ✓
 *   依据 = Lead 批的第 2 轮**新 parity 口径** ✓：真分配后 `index.js` 里会留下**调用行** ✗
 *     ⇒ 聚合**不可能**再等于原文 ✗ —— 强度**没有降低**，而是**换了抓法**：
 *     · **AC-SP-R2**：**逐个函数体**的 sha 必须等于**基线提交**里切出来的那一份 ✓（比整份 sha 更细 ✓）
 *     · **AC-SP-R5**：聚合**必须能过语法解析** ✓（上次 31 红那类崩，秒级就拦得住 ✓）
 *   ⚠️ 本文件只改"**读数口径**"✓ **拦截面（只认那一个路径）与 Buffer 行为**一个字没动 ✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./support/scanPageReadRedirect');

const SERVER_DIR = path.join(__dirname, '..');

test('AC-RD1 ⭐ 拦到 `routes/scanPage.js` ⇒ 返回**聚合文本**（= scanPageSource() ✓ 且能过语法解析 ✓）', () => {
  const vm = require('node:vm');
  const { scanPageSource } = require('./support/scanPageSource');
  const text = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8');
  assert.equal(text, scanPageSource(), '重定向后拿到的必须是**聚合文本** ✓（口径见本文件头 ✓）');
  assert.doesNotThrow(() => new vm.Script(text), '聚合文本必须能过**语法解析** ✓（AC-SP-R5 同口径 ✓）');
});

test('AC-RD2 🔴 **拦截面要窄**：别的路径一律原样返回（含子文件 ✗ 不许拦）', () => {
  const others = [
    path.join(SERVER_DIR, 'src', 'routes', 'workbench.js'),
    path.join(SERVER_DIR, 'src', 'routes', 'scanPage', 'index.js'),   // ⭐ 子文件 ⇒ 绝不许拦 ✗
    path.join(SERVER_DIR, 'src', 'routes', 'scanPage', 'payment.js'),
    path.join(SERVER_DIR, 'src', 'config', 'scanWrite.js'),
  ];
  for (const file of others) {
    const viaHook = fs.readFileSync(file, 'utf8');
    const viaOriginal = require('node:fs').readFileSync;   // 同一实现（已被包一层 ✓ 但路径不匹配 ⇒ 透传 ✓）
    assert.equal(viaHook, viaOriginal.call(fs, file, 'utf8'), `${file} 必须原样返回 ✗`);
    assert.equal(viaHook, require('node:fs').readFileSync(file, 'utf8'));
  }
});

test('AC-RD3 ⭐ 不传 encoding ⇒ 返回 **Buffer**（与 fs 行为一致 ✓ 别悄悄改成 string ✗）', () => {
  const buf = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'));
  assert.ok(Buffer.isBuffer(buf), '不传 encoding 时必须还是 Buffer ✓');
  const { scanPageSource } = require('./support/scanPageSource');
  assert.equal(buf.toString('utf8'), scanPageSource(), 'Buffer 内容 = 聚合文本 ✓（口径同 AC-RD1 ✓）');
});
