'use strict';

/**
 * 2026-11-15（业务负责人）：标签二维码**不设开关** —— 新增就必须生成。
 *   AC-KS-1 源码哨兵：config/service 都不许再出现 TAG_QR_CODE_ENABLED / disabled 分支
 *   AC-KS-2 采购到货写库存：PURCHASE_WRITE_INVENTORY_ENABLED（默认开、测试仍可注入 options）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('AC-KS-1 标签二维码没有开关：新增即生成', () => {
  const config = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'tagQrCode.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'tagQrCodeService.js'), 'utf8');
  assert.equal(config.includes('TAG_QR_CODE_ENABLED'), false, '配置里不许再有二维码开关');
  assert.equal(service.includes('config.enabled'), false, 'service 不许再读开关');
  assert.equal(service.includes('product.tag_qr.disabled'), false, '不许再有 disabled 分支');
});

test('AC-KS-2 采购写库存开关来自 env，options 可覆盖（测试缝）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'purchaseWebhookService.js'), 'utf8');
  assert.match(source, /readFlag\(process\.env, 'PURCHASE_WRITE_INVENTORY_ENABLED', true\)/);
  assert.match(source, /options\.enablePurchaseInventory/);
});
