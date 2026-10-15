/**
 * ⭐⭐ 2026-10-15：`SCAN_TAP_FEEDBACK_LABEL` 改用**本文件既有的** `readString` 口径（**不再是 `||`**）。
 *
 *   改前逐字：`label: process.env.SCAN_TAP_FEEDBACK_LABEL || '正在打开…',`
 *   改后逐字：`label: readString(process.env, 'SCAN_TAP_FEEDBACK_LABEL', '正在打开…'),`
 *   依据：`readString`（`config/envValue.js:25`）的语义是
 *     「**没设 → 默认值；设了（含空串）→ 原样返回**」——先例：`PRIVATE_CHAT_DISABLED_NOTICE_TEXT`
 *     「**空串 = 关掉那句话**」；而 `||` 会让"设成空串"**回落默认** ⇒ 这句**她可见**的文案
 *     **关不掉** ✗（与仓库约定相反）。
 *
 *   AC-TFL1 没设 ⇒ 默认「正在打开…」 ✓
 *   AC-TFL2 🔴 **设成空串 ⇒ 空串（= 关掉这句话），不许回落默认** ✓（能真红：把实现改回 `||` 即红）
 *   AC-TFL3 设了正常值 ⇒ 原样 ✓
 *
 * ⚠️ `config/scanPage.js` 是**模块级**读 `process.env` 的 ⇒ 这里用本仓既有的
 *    "清 require.cache 再 require" 手法（先例：`test/scanSnapshotRetry.test.js:139`），
 *    并且**无论成败都还原 env 与缓存**（不给别的用例留污染 ✗）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const CONFIG_PATH = require.resolve('../src/config/scanPage');
const ENV_KEY = 'SCAN_TAP_FEEDBACK_LABEL';

/** 用给定的 env 值重新加载配置，取那一刻的 `tapFeedback.label`；**结束时把 env 与缓存都还原** ✓ */
const labelWith = (value) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
  const before = process.env[ENV_KEY];
  try {
    if (value === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = value;
    delete require.cache[CONFIG_PATH];
    const { SCAN_PAGE } = require('../src/config/scanPage');
    return SCAN_PAGE.tapFeedback.label;
  } finally {
    if (had) process.env[ENV_KEY] = before;
    else delete process.env[ENV_KEY];
    delete require.cache[CONFIG_PATH];
  }
};

test('AC-TFL1 没设 ⇒ 默认「正在打开…」', () => {
  assert.equal(labelWith(undefined), '正在打开…');
});

test('AC-TFL2 🔴 设成**空串** ⇒ **空**（= 关掉这句话），**不许回落默认** ✗（能真红）', () => {
  assert.equal(labelWith(''), '',
    '空串必须原样返回（`||` 会回落默认 ⇒ 关不掉 ✗；先例：PRIVATE_CHAT_DISABLED_NOTICE_TEXT 空串 = 关掉）');
});

test('AC-TFL3 设了正常值 ⇒ 原样（含前后空格被 trim）', () => {
  assert.equal(labelWith('  正在打开，稍等…  '), '正在打开，稍等…');
});
