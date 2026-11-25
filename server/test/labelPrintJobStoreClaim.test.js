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

test('list：readdir 之后文件被 cleanup 删除 ⇒ 跳过，不抛 ENOENT', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'label-list-race-'));
  const original = fs.promises.readdir;
  try {
    const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
    fs.promises.readdir = async () => ['gone.json'];
    assert.deepEqual(await store.jobs.list(), []);
  } finally {
    fs.promises.readdir = original;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
