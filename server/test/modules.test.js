const test = require('node:test');
const assert = require('node:assert/strict');

const { getModuleDefinition, normalizeModule } = require('../src/config/modules');

test('normalizeModule defaults to purchase', () => {
  assert.equal(normalizeModule(), 'purchase');
  assert.equal(normalizeModule(''), 'purchase');
});

test('normalizeModule accepts supported modules case-insensitively', () => {
  assert.equal(normalizeModule('purchase'), 'purchase');
  assert.equal(normalizeModule(' Sales '), 'sales');
  assert.equal(normalizeModule('INVENTORY'), 'inventory');
});

test('normalizeModule rejects unsupported modules', () => {
  assert.throws(() => normalizeModule('returns'), /Invalid module: returns/);
});

// 原先这条还断言 recognition.requireSupplier（purchase=true / sales=false）。
// 2026-10-05 拍照识别链路退场，recognition 这段配置（含到货单识别提示词）没有任何
// 读取点了，已从 config/module-manifest.json 与生成物 modules.shared.js 一起删除，
// 所以这里只留 sync 策略的断言。
test('module definitions expose sync strategy config', () => {
  assert.equal(getModuleDefinition('purchase').sync.payloadMode, 'aggregate_by_sku');
  assert.equal(getModuleDefinition('inventory').sync.payloadMode, 'aggregate_by_sku');
  assert.equal(getModuleDefinition('sales').sync.payloadMode, 'detail_rows');
});

test('module definitions no longer carry image-recognition config', () => {
  // 回归护栏：识别配置不该被重新加回来（它已经没有任何读取点）。
  for (const key of ['purchase', 'sales', 'inventory']) {
    assert.equal('recognition' in getModuleDefinition(key), false, `${key} 不应再有 recognition 配置`);
  }
});
