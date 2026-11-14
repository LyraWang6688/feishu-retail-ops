'use strict';

/**
 * #1206：库存手工调整页的用户可见文案必须走 config。
 *
 * 判据（能真红）：
 *   · 页面里不许出现 showToast / showPageError / new Error 的**中文字面量**；
 *   · 那几句话必须在 config/inventoryAdjustment.js；
 *   · 页面确实引用了它们（不是"搬走了但没用"）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const page = fs.readFileSync(path.join(ROOT, 'features/inventory/adjustment.js'), 'utf8');
const config = fs.readFileSync(path.join(ROOT, 'config/inventoryAdjustment.js'), 'utf8');

test('AC-IMT1 页面里没有硬编码的用户可见文案', () => {
  const hits = page.match(/(showToast|showPageError)\(\s*['"`][^'"`]*[\u4e00-\u9fff]/g) || [];
  assert.deepEqual(hits, [], `页面里仍有硬编码中文：${hits.join(' / ')}`);
  assert.equal(/new Error\([^)]*[\u4e00-\u9fff]/.test(page), false, 'new Error 里不许有中文字面量');
});

test('AC-IMT2 文案在 config，且页面确实引用了它们', () => {
  for (const key of ['rowsRequired', 'submittedStock', 'seasonApplied', 'seasonCleared', 'categoryRequired', 'inventoryJobFailed', 'scanNoProduct', 'scanNoSdk', 'scanFailed']) {
    assert.match(config, new RegExp(`${key}: '.+'`), `config 缺少 ${key}`);
    assert.ok(page.includes(`INVENTORY_MANUAL_TEXTS.${key}`), `页面没有使用 ${key}`);
  }
});
