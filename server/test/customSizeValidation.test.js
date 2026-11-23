'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public/workbench');
const load = () => import(pathToFileURL(path.join(PUBLIC, 'features/procurement/customSize.js')).href);

const draftOf = (customSizes = {}) => ({ products: {}, customSizes });
const bodies = {
  replenish: { groups: [{ productRecordId: 'recA', sizes: [{ size: 42 }, { size: 43 }] }] },
  new: { groups: [] },
};
const store = { quantityOf: (draft, recordId, text) => Number(draft.products?.[recordId]?.entries?.[text] || 0) };

test('customSizes：隐藏货品的旧自定义尺码不阻塞提交', async () => {
  const { customSizesValidation } = await load();
  const result = customSizesValidation({
    draft: draftOf({ recHidden: ['not-a-number'], recGone: ['0'] }), bodies, tabs: ['replenish', 'new'], store,
  });
  assert.equal(result.ok, true);
});

test('customSizes：标准尺码可以自定义；只去重自定义尺码自身', async () => {
  const { customSizesValidation } = await load();
  const allowed = customSizesValidation({
    draft: draftOf({ recA: ['42', '41'] }), bodies, tabs: ['replenish', 'new'], store,
  });
  assert.equal(allowed.ok, true, '42 是标准尺码也允许作为自定义尺码');
  const duplicate = customSizesValidation({
    draft: draftOf({ recA: ['43', '43'] }), bodies, tabs: ['replenish', 'new'], store,
  });
  assert.deepEqual(duplicate, { ok: false, reason: 'duplicate' });
});

test('customSizes：刷新只裁剪隐藏/自定义重复/非法旧项，标准尺码保留', async () => {
  const { pruneCustomSizes } = await load();
  const draft = draftOf({ recA: ['42', '45', '45', 'oops'], recGone: ['46'] });
  const pruned = pruneCustomSizes({ draft, bodies, tabs: ['replenish', 'new'] });
  assert.deepEqual(pruned.customSizes.recA, ['42', '45']);
  assert.equal(pruned.customSizes.recGone, undefined);
  assert.notEqual(pruned, draft);
});

test('customRowsError：标准尺码允许；本次 rows 重复才报 duplicate', async () => {
  const { customRowsError } = await load();
  const draft = draftOf({});
  const group = { sizes: [{ size: 42 }, { size: 43 }] };
  const rowsStore = { ...store, customSizesOf: () => [] };
  assert.equal(customRowsError({ group, draft, recordId: 'recA', rows: [{ size: 42, quantity: 1 }, { size: 41, quantity: 1 }], store: rowsStore }), '');
  assert.equal(customRowsError({ group, draft, recordId: 'recA', rows: [{ size: 43, quantity: 1 }, { size: 43, quantity: 1 }], store: rowsStore }), 'duplicate');
});

test('customSizes：普通可见非法格式返回 invalid', async () => {
  const { customSizesValidation } = await load();
  const result = customSizesValidation({
    draft: draftOf({ recA: ['oops'] }), bodies, tabs: ['replenish', 'new'], store,
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid' });
});
