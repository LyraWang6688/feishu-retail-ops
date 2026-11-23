'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('售后换货链路保留样品 / 门盒状态和补样品选择', () => {
  const route = read('src/routes/workbenchOrderActions.js');
  const page = read('public/workbench/features/after-sales/index.js');
  const diff = read('src/views/scanPage/exchangeDiff.js');
  const service = read('src/services/afterSalesExchangeService.js');
  assert.match(route, /states:\s*Array\.isArray\(item\.states\)/, '售后换尺码 API 必须保留 states');
  assert.match(route, /sampleCandidates/, '售后换尺码 API 必须给出补样品候选');
  assert.match(route, /originalSize/, '补样品候选必须接收换回来的原尺码');
  assert.match(page, /originalSize/, '前端查询补样品候选必须带原尺码');
  assert.match(page, /data-as-sample-only/, '售后换尺码必须标记只有样品的尺码');
  assert.match(page, /samplePromotionSize/, '售后换尺码必须提交补样品尺码');
  assert.match(diff, /samplePromotionSize:\s*String/, '换款式不能丢补样品字段');
  assert.match(service, /sampleReplacementCandidates/, '后台必须校验补样品候选');
  assert.match(service, /sampleConsumedQuantity/, '后台扣到样品后必须补样品');
});
