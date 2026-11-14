'use strict';

/**
 * #57：两个"假开关"改成真开关（2026-11-14）。
 *   AC-KS-1 标签二维码链路：TAG_QR_CODE_ENABLED 显式布尔（默认开、可关）
 *   AC-KS-2 采购到货写库存：PURCHASE_WRITE_INVENTORY_ENABLED（默认开、测试仍可注入 options）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const loadTagConfig = () => {
  delete require.cache[require.resolve('../src/config/tagQrCode')];
  return require('../src/config/tagQrCode').TAG_QR_CODE;
};

test('AC-KS-1 TAG_QR_CODE_ENABLED 可关可开', () => {
  const original = process.env.TAG_QR_CODE_ENABLED;
  try {
    assert.equal(loadTagConfig().enabled, true, '默认开');
    process.env.TAG_QR_CODE_ENABLED = 'false';
    assert.equal(loadTagConfig().enabled, false, '显式 false 必须真的关');
    process.env.TAG_QR_CODE_ENABLED = '';
    assert.equal(loadTagConfig().enabled, false, '空串 = 关（显式布尔语义）');
  } finally {
    if (original === undefined) delete process.env.TAG_QR_CODE_ENABLED;
    else process.env.TAG_QR_CODE_ENABLED = original;
    delete require.cache[require.resolve('../src/config/tagQrCode')];
  }
});

test('AC-KS-2 采购写库存开关来自 env，options 可覆盖（测试缝）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'purchaseWebhookService.js'), 'utf8');
  assert.match(source, /readFlag\(process\.env, 'PURCHASE_WRITE_INVENTORY_ENABLED', true\)/);
  assert.match(source, /options\.enablePurchaseInventory/);
});
