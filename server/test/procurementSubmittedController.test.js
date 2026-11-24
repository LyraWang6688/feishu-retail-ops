'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public/workbench');

test('已报货：同批次详情请求在途时，直接点修改复用同一个 Promise，不会返回 null', async () => {
  const { createSubmittedController } = await import(pathToFileURL(path.join(PUBLIC, 'features/procurement/submitted.js')).href);
  let resolveDetail;
  let calls = 0;
  const detailPromise = new Promise((resolve) => { resolveDetail = resolve; });
  const state = {
    tab: 'pending', submitted: [{ batch_no: 'CGD-1', is_today: false }], submittedTotal: 1,
    submittedExpanded: new Set(), submittedDetailLoading: new Set(), submittedListLoading: false,
  };
  const ctl = createSubmittedController({
    config: { texts: { loadFailed: '读取失败' } },
    api: { loadSubmittedDetail: () => { calls += 1; return detailPromise; } },
    state, paint: () => {}, toast: () => {},
  });
  const first = ctl.prepareModify('CGD-1');
  const second = ctl.prepareModify('CGD-1');
  resolveDetail({ batch: { batch_no: 'CGD-1', products: [{ product_record_id: 'p1', entries: [{ size: 39, quantity: 1 }] }] } });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls, 1, '同批次只能发一次明细请求');
  assert.deepEqual(a.products[0].entries, [{ size: 39, quantity: 1 }]);
  assert.deepEqual(b.products[0].entries, [{ size: 39, quantity: 1 }]);
});
