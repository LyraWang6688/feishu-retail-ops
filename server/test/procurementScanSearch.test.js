'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public/workbench');
const load = (relative) => import(pathToFileURL(path.join(PUBLIC, relative)).href);

test('扫码定位：只认 /r/{recordId}，旧 /s/ 与空值不猜', async () => {
  const { recordIdFromScanTarget } = await load('features/procurement/search.js');
  assert.equal(recordIdFromScanTarget('/r/rec_abc?from=procurement'), 'rec_abc');
  assert.equal(recordIdFromScanTarget('https://hm.example.com/r/rec_xyz?from=procurement'), 'rec_xyz');
  assert.equal(recordIdFromScanTarget('/s/123'), '');
  assert.equal(recordIdFromScanTarget('rec_abc'), '');
  assert.equal(recordIdFromScanTarget(''), '');
});

test('扫码定位：同一货品优先上新，再补货', async () => {
  const { findGroupByRecordId } = await load('features/procurement/search.js');
  const bodies = {
    new: { groups: [{ productRecordId: 'rec_same', itemNo: 'A', supplierRecordId: 's_new' }] },
    replenish: { groups: [{ productRecordId: 'rec_same', itemNo: 'A', supplierRecordId: 's_rep' }] },
  };
  const hit = findGroupByRecordId(bodies, 'rec_same');
  assert.equal(hit.tab, 'new');
  assert.equal(hit.group.supplierRecordId, 's_new');
  assert.equal(findGroupByRecordId(bodies, 'rec_missing'), null);
});

test('采购页布局：搜索与扫码同一行，统计范围独立下一行', async () => {
  const { shellHtml } = await load('features/procurement/render.js');
  const { PROCUREMENT_UI } = await load('config/procurement.js');
  const html = shellHtml(PROCUREMENT_UI);
  assert.ok(html.includes('data-pr-scan'));
  assert.ok(html.includes('data-pr-range-row'));
  assert.ok(html.indexOf('data-pr-search') < html.indexOf('data-pr-scan'));
  assert.ok(html.indexOf('data-pr-scan') < html.indexOf('data-pr-range-row'));
});
