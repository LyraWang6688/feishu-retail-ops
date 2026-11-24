'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public/workbench');

test('库存样品汇总：0 双缺样品、1 双正常、2 双样品多，状态为空优先', async () => {
  const { sampleSummaryOf } = await import(pathToFileURL(path.join(PUBLIC, 'features/inventory/adjustment.js')).href);
  const one = sampleSummaryOf([{ state: '样品', quantity: 1 }, { state: '门盒', quantity: 2 }]);
  assert.equal(one.sampleCount, 1);
  assert.equal(one.issueKey, '');

  const none = sampleSummaryOf([{ state: '门盒', quantity: 2 }]);
  assert.equal(none.sampleCount, 0);
  assert.equal(none.issueKey, 'missing');

  const extra = sampleSummaryOf([{ state: '样品', quantity: 2 }, { state: '门盒', quantity: 1 }]);
  assert.equal(extra.sampleCount, 2);
  assert.equal(extra.issueKey, 'extra');

  const empty = sampleSummaryOf([{ state: '样品', quantity: 2 }, { state: '', quantity: 1 }]);
  assert.equal(empty.issueKey, 'empty', '状态为空优先于样品多');
});
