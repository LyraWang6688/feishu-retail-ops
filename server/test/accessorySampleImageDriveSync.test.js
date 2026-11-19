'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { ACCESSORY_SAMPLE_IMAGE_DRIVE } = require('../src/config/accessorySampleImageDrive');
const { createAccessorySampleImageDriveService } = require('../src/services/accessorySampleImageDriveService');

const F = V1_BITABLE_SCHEMA.tables.accessory.fields;
const record = ({ id = 'a1', synced = false, images = [{ file_token: 'ft1', name: 'x.jpg', type: 'image/jpeg' }] } = {}) => ({
  record_id: id,
  fields: { [F.name]: '39元腰带', [F.category]: '腰带', [F.sampleImage]: images, [F.sampleImageSynced]: synced },
});

const make = ({ rows = [record()], uploadFails = false } = {}) => {
  const updates = [];
  const uploads = [];
  const gateway = {
    async get() { return rows[0]; },
    async update(_table, id, patch) { updates.push([id, patch]); Object.assign(rows[0].fields, patch); return rows[0]; },
    drive: {
      async listDriveFolder() { return []; },
      async downloadMedia() { return Buffer.from('jpg'); },
      async uploadDriveFile({ fileName }) { if (uploadFails) throw new Error('upload failed'); uploads.push(fileName); return 'new_token'; },
      async deleteDriveFile() {},
      async transferFileOwner() {},
    },
  };
  const service = createAccessorySampleImageDriveService({ gateway, config: ACCESSORY_SAMPLE_IMAGE_DRIVE });
  return { service, updates, uploads, rows };
};

test('配品新增有图 ⇒ 上传到配品云盘并勾同步云盘', async () => {
  const { service, updates, uploads } = make();
  const result = await service.syncRecord('a1');
  assert.equal(result.status, 'synced');
  assert.deepEqual(uploads, ['腰带_39元腰带.jpg']);
  assert.equal(updates[0][1].sampleImageSynced, true);
});

test('无图 / 已勾 / 非图片 ⇒ 跳过，不勾', async () => {
  const noImage = make({ rows: [record({ images: [] })] });
  assert.equal((await noImage.service.syncRecord('a1')).status, 'skipped');
  const synced = make({ rows: [record({ synced: true })] });
  assert.equal((await synced.service.syncRecord('a1')).status, 'skipped');
  const pdf = make({ rows: [record({ images: [{ file_token: 'f', name: 'a.pdf', type: 'application/pdf' }] })] });
  assert.equal((await pdf.service.syncRecord('a1')).status, 'skipped');
  assert.equal(noImage.updates.length + synced.updates.length + pdf.updates.length, 0);
});

test('上传失败 ⇒ 不勾；后续可补', async () => {
  const { service, updates } = make({ uploadFails: true });
  const result = await service.syncRecord('a1');
  assert.equal(result.status, 'failed');
  assert.equal(updates.length, 0);
});

test('事件只处理新增', async () => {
  const { service, uploads } = make();
  const result = await service.handleTableChanges([
    { record_id: 'a1', action: 'record_edited' },
    { record_id: 'a1', action: 'record_added' },
  ]);
  assert.equal(result.results.length, 1);
  assert.deepEqual(uploads, ['腰带_39元腰带.jpg']);
});
