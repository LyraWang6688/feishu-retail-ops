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
  const started = await service.start();
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
  const first = await service.start();
  assert.equal(first.started, true);
  const second = await service.start();
  assert.equal(second.started, false, '同一时间只许跑一轮');
  resolveFirst();
  await service.waitForIdle();
  assert.equal(service.status().synced, 1);
});

test('AC-BF4 整表读失败 ⇒ 如实记 error（running:false，不假装完成）', async () => {
  const { gateway, driveService } = createFake({ records: [], failList: true });
  const service = createSampleImageBackfillService({ gateway, driveService, config: configOf() });
  await service.start();
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
  await service.start();
  const status = await service.waitForIdle();
  assert.equal(status.total, 2);
  assert.deepEqual(calls.sync.map(([id]) => id), ['r1', 'r2']);
});


test('AC-BF6 接统一异步任务：enqueue(type/owner) → job_id 返回 → run 执行；再点返回同一个 job', async () => {
  const { gateway, driveService } = createFake({
    records: [recordOf({ id: 'r1', images: [imageOf()] })],
  });
  const fakeJobs = {
    enqueued: [], runCalls: [], last: null,
    async enqueue(payload) {
      this.enqueued.push(payload);
      return { job: { ...payload, job_id: payload.jobId, status: 'queued' }, created: true };
    },
    async run({ jobId, run, classifyResult }) {
      this.runCalls.push(jobId);
      const result = await run({ attempt: 1 });
      const outcome = classifyResult(result);
      this.last = { status: outcome?.partial ? 'partial_failed' : 'succeeded', last_error: outcome?.message || '' };
      return { job_id: jobId, ...this.last };
    },
    async get(jobId) { return { job_id: jobId, status: this.last?.status || 'queued', last_error: this.last?.last_error || '' }; },
  };
  const service = createSampleImageBackfillService({
    gateway, driveService, jobs: fakeJobs, config: configOf(),
  });
  const started = await service.start({ ownerOpenId: 'ou_owner', operatorName: '王颖' });
  assert.equal(started.started, true);
  assert.match(started.job_id, /^sample_image_backfill_job_/, 'job_id 前缀来自 config/asyncJobs.js');
  assert.equal(fakeJobs.enqueued.length, 1);
  assert.equal(fakeJobs.enqueued[0].type, 'sample_image_backfill', '类型走统一配置');
  assert.equal(fakeJobs.enqueued[0].ownerOpenId, 'ou_owner', 'owner 用于状态接口"只能查自己的"');
  assert.equal(fakeJobs.runCalls[0], started.job_id);

  const second = await service.start({ ownerOpenId: 'ou_owner' });
  assert.equal(second.started, false, '同一时间只跑一轮');
  assert.equal(second.job_id, started.job_id, '再点返回同一个 job（不新建）');

  const status = await service.waitForIdle();
  assert.equal(status.synced, 1);
  const withJob = await service.statusWithJob();
  assert.equal(withJob.job_status, 'succeeded', '状态接口能查到 job 终态');
});
