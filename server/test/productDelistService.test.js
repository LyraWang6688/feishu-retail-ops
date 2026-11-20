'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductDelistService } = require('../src/services/productDelistService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const F = V1_BITABLE_SCHEMA.tables.product.fields;

const makeRecord = ({ status = '下架', sample = true } = {}) => ({
  record_id: 'prod_1',
  fields: {
    [F.number]: [{ text: 'A1|黑色|男', type: 'text' }],
    [F.itemNo]: 'A1',
    [F.color]: [{ text: '黑色', type: 'text' }],
    [F.category]: [{ text: '男', type: 'text' }],
    [F.status]: status,
    [F.sampleImage]: sample ? [{ file_token: 'att_1', name: 'source.jpg', type: 'image/jpeg' }] : [],
  },
});

const makeHarness = ({ record = makeRecord(), sourceFiles = null, targetFiles = [], moveError = null } = {}) => {
  const calls = { moved: [], deletedTargets: [], uploaded: [], deletedProducts: [] };
  const historyFiles = [...targetFiles];
  const gateway = {
    table: () => V1_BITABLE_SCHEMA.tables.product,
    get: async () => record,
    delete: async (tableKey, id) => { calls.deletedProducts.push({ tableKey, id }); },
    drive: {
      listDriveFolder: async (folder) => (folder === 'source-folder' ? (sourceFiles || []) : historyFiles),
      deleteDriveFile: async (token) => { calls.deletedTargets.push(token); },
      moveDriveFile: async (token, folder) => {
        if (moveError) throw moveError;
        calls.moved.push({ token, folder });
      },
      downloadMedia: async () => Buffer.from('image'),
      uploadDriveFile: async (input) => { calls.uploaded.push(input); return 'uploaded_1'; },
    },
  };
  const service = createProductDelistService({
    gateway,
    sampleConfig: {
      folder: { token: 'source-folder' },
      operations: { list: 'list', download: 'download', upload: 'upload', delete: 'delete', move: 'move' },
      naming: { numberSeparator: '_', multiSuffix: '-{index}', fallbackExtension: '.jpg', illegalChars: [], replacement: '_', maxLength: 200 },
    },
    historyConfig: {
      folderToken: 'history-folder', overwrite: 'replace',
      operations: { list: 'list', download: 'download', upload: 'upload', delete: 'delete', move: 'move' },
    },
  });
  return { calls, gateway, service };
};

test('PD1 在售货品拒绝删除', async () => {
  const h = makeHarness({ record: makeRecord({ status: '在售' }) });
  const result = await h.service.deleteDelistedProduct({ recordId: 'prod_1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'product_not_delisted');
  assert.equal(h.calls.deletedProducts.length, 0);
});

test('PD2 下架且有样例图：先覆盖同名目标，再移动到历史云盘，再删货品', async () => {
  const h = makeHarness({
    sourceFiles: [{ token: 'src_1', name: 'A1_黑色_男.jpg', type: 'file' }],
    targetFiles: [{ token: 'old_1', name: 'A1_黑色_男.jpg', type: 'file' }],
  });
  const result = await h.service.deleteDelistedProduct({ recordId: 'prod_1' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.calls.deletedTargets, ['old_1']);
  assert.deepEqual(h.calls.moved, [{ token: 'src_1', folder: 'history-folder' }]);
  assert.equal(h.calls.deletedProducts[0].tableKey, 'product');
});

test('PD3 在售云盘找不到 ⇒ 从附件补传到历史云盘', async () => {
  const h = makeHarness({ sourceFiles: [] });
  const result = await h.service.deleteDelistedProduct({ recordId: 'prod_1' });
  assert.equal(result.ok, true);
  assert.equal(h.calls.moved.length, 0);
  assert.equal(h.calls.uploaded.length, 1);
  assert.equal(h.calls.uploaded[0].folderToken, 'history-folder');
  assert.equal(h.calls.uploaded[0].fileName, 'A1_黑色_男.jpg');
});

test('PD4 没有样例图：默认要求确认，确认后直接删货品', async () => {
  const h = makeHarness({ record: makeRecord({ sample: false }) });
  const refused = await h.service.deleteDelistedProduct({ recordId: 'prod_1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'no_sample_image');
  assert.equal(h.calls.deletedProducts.length, 0);
  const accepted = await h.service.deleteDelistedProduct({ recordId: 'prod_1', allowNoSample: true });
  assert.equal(accepted.ok, true);
  assert.equal(h.calls.deletedProducts.length, 1);
});

test('PD5 归档失败 ⇒ 不删货品', async () => {
  const h = makeHarness({
    sourceFiles: [{ token: 'src_1', name: 'A1_黑色_男.jpg', type: 'file' }],
    moveError: new Error('move failed'),
  });
  const result = await h.service.deleteDelistedProduct({ recordId: 'prod_1' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'archive_failed');
  assert.equal(h.calls.deletedProducts.length, 0);
});
