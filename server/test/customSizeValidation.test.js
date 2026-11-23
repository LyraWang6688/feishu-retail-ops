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

test('customSizes：标准尺码重复返回 duplicate，不是 integer', async () => {
  const { customSizesValidation } = await load();
  const result = customSizesValidation({
    draft: draftOf({ recA: ['42'] }), bodies, tabs: ['replenish', 'new'], store,
  });
  assert.deepEqual(result, { ok: false, reason: 'duplicate' });
});

test('customSizes：刷新裁剪隐藏/重复/非法旧项，保留可见有效项', async () => {
  const { pruneCustomSizes } = await load();
  const draft = draftOf({ recA: ['42', '45', '45', 'oops'], recGone: ['46'] });
  const pruned = pruneCustomSizes({ draft, bodies, tabs: ['replenish', 'new'] });
  assert.deepEqual(pruned.customSizes.recA, ['45']);
  assert.equal(pruned.customSizes.recGone, undefined);
  assert.notEqual(pruned, draft);
});

test('customSizes：普通可见非法格式返回 invalid', async () => {
  const { customSizesValidation } = await load();
  const result = customSizesValidation({
    draft: draftOf({ recA: ['oops'] }), bodies, tabs: ['replenish', 'new'], store,
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid' });
});
