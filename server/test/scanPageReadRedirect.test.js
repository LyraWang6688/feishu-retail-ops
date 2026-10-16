'use strict';

/**
 * ⭐⭐ `test/support/scanPageReadRedirect.js` 的**自带判据**（Lead 要求 ✓）：
 *   · 拦到目标 ⇒ 返回**聚合文本**（sha 与拆之前那一份一致 ✓）
 *   · **别的路径 ⇒ 原样返回**（含 `routes/scanPage/**` 的子文件 ✗ 不许拦）
 *   · 不传 encoding ⇒ **Buffer**（与 `fs.readFileSync` 行为一致 ✓）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

require('./support/scanPageReadRedirect');

const SERVER_DIR = path.join(__dirname, '..');
const ORIGINAL_SHA256 = '74cc86d900ab93831723c29c5e195c5e8324804305240504dcf60d367281c285';
const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');

test('AC-RD1 ⭐ 拦到 `routes/scanPage.js` ⇒ 返回**聚合文本**（sha = 拆之前那一份）', () => {
  const text = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8');
  assert.equal(sha(text), ORIGINAL_SHA256, '重定向后拿到的必须是"拆之前那一份"✓');
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
  assert.equal(sha(buf.toString('utf8')), ORIGINAL_SHA256);
});
