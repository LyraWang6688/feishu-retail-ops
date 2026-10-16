'use strict';

/**
 * ⭐⭐ 测试用：把「按**旧路径**读 `src/routes/scanPage.js`」**重定向**到**聚合文本** ✓
 *
 * 起因：`routes/scanPage.js` 现在只是**薄壳**（13 行 ✗），而**几十条判据是按"源码文本"钉行为的** ✓
 *   ⇒ 它们读到的会是壳 ⇒ 全部失效 ✗（2026-10-16 实测：53 条红 ✗）
 * ⇒ 做法：在**受影响测试文件的顶部**加一行 `require('./support/scanPageReadRedirect');` ✓
 *   ⇒ 本模块把 `fs.readFileSync` 包一层：**只拦**"恰好是 `src/routes/scanPage.js` 这一个路径"的读取 ✓
 *     ⇒ 返回 `scanPageSource()`（= 拆之前那一份，逐字节相同 ✓）
 *
 * 🔴 **拦截面必须窄** ✗（Lead 明确要求）：**只认那一个路径** ✓
 *   · `src/routes/scanPage/**` 的子文件读取 ⇒ **一律原样透传** ✓（拦了会"假绿" ✗）
 *   · 任何别的路径 ⇒ 原样透传 ✓（由 `test/scanPageReadRedirect.test.js` 钉住 ✓）
 *   · 不传 encoding ⇒ 返回 **Buffer**（与 `fs.readFileSync` 的行为一致 ✓，别悄悄改成 string ✗）
 *
 * ⚠️ 只给测试用（`test/support/` 不在生产依赖里 ✓）；幂等（重复 require 只包一次 ✓）。
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..', '..');
const TARGET = path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js');
const { scanPageSource } = require('./scanPageSource');

const MARK = Symbol.for('dsh.scanPageReadRedirect.installed');
const original = fs.readFileSync;

if (!fs[MARK]) {
  const patched = function readFileSyncWithScanPageRedirect(file, ...rest) {
    try {
      const resolved = typeof file === 'string' ? path.resolve(file) : '';
      if (resolved === TARGET) {
        const text = scanPageSource();
        const encoding = rest.find((x) => typeof x === 'string');
        return encoding ? text : Buffer.from(text, 'utf8');
      }
    } catch { /* 任何异常 ⇒ 老老实实走原实现 ✓（绝不吞掉读取错误 ✗） */ }
    return original.call(fs, file, ...rest);
  };
  fs.readFileSync = patched;
  fs[MARK] = true;
}

module.exports = { TARGET, installed: true, readRealSync: (file, ...rest) => original.call(fs, file, ...rest) };
