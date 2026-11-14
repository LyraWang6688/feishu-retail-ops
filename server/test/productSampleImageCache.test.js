'use strict';

/** #1204：样例图 file_token 缓存 —— TTL / LRU。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductSampleImageCache } = require('../src/services/productSampleImageCache');

test('AC-SIC1 TTL 内命中、过期后失效', () => {
  let clock = 0;
  const cache = createProductSampleImageCache({ ttlMs: 1000, maxEntries: 10, now: () => clock });
  cache.set('rec1', { fileToken: 'f1', type: 'image/jpeg' });
  clock = 999;
  assert.equal(cache.get('rec1')?.fileToken, 'f1');
  clock = 1000;
  assert.equal(cache.get('rec1'), null, '到 TTL 必须失效');
});

test('AC-SIC2 超过上限按 LRU 淘汰最久未用', () => {
  let clock = 0;
  const cache = createProductSampleImageCache({ ttlMs: 60000, maxEntries: 2, now: () => clock });
  cache.set('a', { fileToken: 'fa' }); clock += 1;
  cache.set('b', { fileToken: 'fb' }); clock += 1;
  cache.get('a'); // a 变成最近使用
  cache.set('c', { fileToken: 'fc' });
  assert.equal(cache.size(), 2);
  assert.equal(cache.get('b'), null, '最久未用的 b 被淘汰');
  assert.equal(cache.get('a')?.fileToken, 'fa');
  assert.equal(cache.get('c')?.fileToken, 'fc');
});
