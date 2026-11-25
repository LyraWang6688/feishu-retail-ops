'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');

test('claim：任务文件已被 cleanup 删除 ⇒ not_found，不抛 ENOENT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-claim-'));
  try {
    const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
    const result = await store.claim('missing-job', { deviceId: 'store-pc' });
    assert.deepEqual(result, { claimed: false, reason: 'not_found' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
