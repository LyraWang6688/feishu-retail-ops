'use strict';

/**
 * 「样例图 → 云盘」**存量补齐**（业务负责人 2026-11-10：数据配置页的按钮卡 = 存量写入）。
 *
 * 判据（不连网）：
 *   AC-BF1 只挑「有样例图、且没勾已同步云盘」的记录（没图表 / 已勾 / 非图片附件都不碰）；
 *   AC-BF2 逐条串行调用同一个 `syncRecord`（不并发），计数 = 成功/跳过/失败；
 *   AC-BF3 已在跑 ⇒ 再点一次不并发（`started:false`）；
 *   AC-BF4 整表读失败 ⇒ `running:false` + `error` 如实（不假装完成）；
 *   AC-BF5 `maxRecords` 生效（防一次点太多）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SAMPLE_IMAGE_DRIVE } = require('../src/config/sampleImageDrive');
const { createSampleImageBackfillService } = require('../src/services/sampleImageBackfillService');

const F = V1_BITABLE_SCHEMA.tables.product.fields;

const recordOf = ({ id, images = [], synced = false }) => ({
  record_id: id,
  fields: {
    [F.itemNo]: 'A1',
    [F.color]: [{ text: '黑色' }],
    [F.number]: 'A1|黑色|A',
    [F.sampleImage]: images,
    [F.sampleImageSynced]: synced,
  },
});

const imageOf = (token = 'ft1') => ({ file_token: token, name: 'x.jpg', type: 'image/jpeg' });

const configOf = (over = {}) => ({
  ...SAMPLE_IMAGE_DRIVE,
  folder: { ...SAMPLE_IMAGE_DRIVE.folder, token: 'folder_test' },
  fields: { sampleImage: 'sampleImage', synced: 'sampleImageSynced' },
  backfill: { maxRecords: 0 },
  ...over,
});

const createFake = ({ records, failList = false, results = {} } = {}) => {
  const calls = { listAll: [], sync: [] };
  return {
    calls,
    gateway: {
      async listAll(tableKey) {
        calls.listAll.push(tableKey);
        if (failList) throw new Error('整表读失败');
        return records;
      },
    },
    driveService: {
      async syncRecord(recordId, options) {
        calls.sync.push([recordId, options?.reason]);
        return results[recordId] || { record_id: recordId, status: 'synced' };
      },
    },
  };
};

test('AC-BF1/BF2 只挑「有图且未勾」的记录，逐条串行 + 计数', async () => {
  const { gateway, driveService, calls } = createFake({
    records: [
      recordOf({ id: 'r_pending', images: [imageOf()] }),
      recordOf({ id: 'r_synced', images: [imageOf()], synced: true }), // 已勾 ⇒ 跳过
      recordOf({ id: 'r_no_image', images: [] }), // 没图 ⇒ 跳过
      recordOf({ id: 'r_pdf', images: [{ file_token: 'ft_pdf', name: 'a.pdf', type: 'application/pdf' }] }),
      recordOf({ id: 'r_pending2', images: [imageOf('ft2')] }),
    ],
    results: {
      r_pending: { record_id: 'r_pending', status: 'synced' },
      r_pending2: { record_id: 'r_pending2', status: 'failed', error: '炸了' },
    },
  });
  const service = createSampleImageBackfillService({ gateway, driveService, config: configOf() });
  const started = service.start();
  assert.equal(started.started, true);
  const status = await service.waitForIdle();

  assert.deepEqual(calls.listAll, ['product']);
  assert.deepEqual(calls.sync.map(([id]) => id), ['r_pending', 'r_pending2'], '只处理两条未勾且有图的');
  assert.equal(status.running, false);
  assert.equal(status.total, 2);
  assert.equal(status.synced, 1);
  assert.equal(status.failed, 1);
  assert.equal(status.done, 2);
  assert.equal(status.error, '');
});

test('AC-BF3 已在跑 ⇒ 再点一次不并发（started:false）', async () => {
  let resolveFirst;
  const gate = new Promise((resolve) => { resolveFirst = resolve; });
  const service = createSampleImageBackfillService({
    gateway: { async listAll() { await gate; return [recordOf({ id: 'r1', images: [imageOf()] })]; } },
    driveService: { async syncRecord(id) { return { record_id: id, status: 'synced' }; } },
    config: configOf(),
  });
  const first = service.start();
  assert.equal(first.started, true);
  const second = service.start();
  assert.equal(second.started, false, '同一时间只许跑一轮');
  resolveFirst();
  await service.waitForIdle();
  assert.equal(service.status().synced, 1);
});

test('AC-BF4 整表读失败 ⇒ 如实记 error（running:false，不假装完成）', async () => {
  const { gateway, driveService } = createFake({ records: [], failList: true });
  const service = createSampleImageBackfillService({ gateway, driveService, config: configOf() });
  service.start();
  const status = await service.waitForIdle();
  assert.equal(status.running, false);
  assert.match(status.error, /整表读失败/);
  assert.equal(status.done, 0);
});

test('AC-BF5 maxRecords 生效（一次最多处理 N 条）', async () => {
  const { gateway, driveService, calls } = createFake({
    records: [1, 2, 3].map((i) => recordOf({ id: `r${i}`, images: [imageOf(`ft${i}`)] })),
  });
  const service = createSampleImageBackfillService({
    gateway, driveService, config: configOf({ backfill: { maxRecords: 2 } }),
  });
  service.start();
  const status = await service.waitForIdle();
  assert.equal(status.total, 2);
  assert.deepEqual(calls.sync.map(([id]) => id), ['r1', 'r2']);
});
