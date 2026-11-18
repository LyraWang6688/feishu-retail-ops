'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupplyDocumentSyncService } = require('../src/services/supplyDocumentSyncService');

const makeGateway = (fields, existingByFolder = {}) => {
  const updates = [];
  const uploaded = [];
  const deleted = [];
  const batch = { record_id: 'batch_1', fields };
  const gateway = {
    get: async () => batch,
    listAll: async () => [batch],
    update: async (table, id, patch, options) => { updates.push({ table, id, patch, options }); },
    drive: {
      downloadMedia: async (token) => Buffer.from(token),
      listDriveFolder: async (folder) => existingByFolder[folder] || [],
      deleteDriveFile: async (token) => { deleted.push(token); },
      uploadDriveFile: async ({ folderToken, fileName, content }) => {
        uploaded.push({ folderToken, fileName, content: String(content) });
        return 'new_' + uploaded.length;
      },
    },
  };
  return { gateway, updates, uploaded, deleted, batch };
};

test('AC-SDS1 报货 + 已到货：我方→我方，对方→对方，成功后勾选单据同步', async () => {
  const h = makeGateway({
    报货批次号: 'CGD-20261117-0001',
    发生行为: '报货',
    到货状态: '已到货',
    报货日: Date.parse('2026-11-17T10:00:00+08:00'),
    供应商: '信踏',
    我方单据: [{ file_token: 'f_my', name: '采购单.png', tmp_url: 'https://x?extra=e' }],
    对方单据: [{ file_token: 'f_other', name: '验收.jpg' }],
    单据同步: false,
  });
  const service = createSupplyDocumentSyncService({ gateway: h.gateway });
  const result = await service.syncBatch({ batchNo: 'CGD-20261117-0001' });
  assert.equal(result.ok, true);
  assert.equal(result.synced.length, 2);
  assert.deepEqual(h.uploaded.map((item) => item.folderToken), [
    'QXT9fkXkClKicndPJWOcigOFnDg',
    'DwRdfewUvlwdurdd6oBcM6ttnvv',
  ]);
  assert.deepEqual(h.uploaded.map((item) => item.fileName), [
    '2026-11-17_信踏_报货_采购单.png',
    '2026-11-17_信踏_报货_验收.jpg',
  ]);
  assert.deepEqual(h.updates[0].patch, { documentSync: true });
});

test('AC-SDS2 退货：只同步我方单据到 我方', async () => {
  const h = makeGateway({
    报货批次号: 'CGD-20261117-0005',
    发生行为: '退货',
    报货日: Date.parse('2026-11-17T09:00:00+08:00'),
    供应商: '信踏',
    我方单据: [{ file_token: 'f_my', name: '退货单.png' }],
    对方单据: [{ file_token: 'f_other', name: '不应同步.jpg' }],
    单据同步: false,
  });
  const result = await createSupplyDocumentSyncService({ gateway: h.gateway })
    .syncBatch({ batchNo: 'CGD-20261117-0005' });
  assert.equal(result.ok, true);
  assert.deepEqual(h.uploaded.map((item) => item.folderToken), ['QXT9fkXkClKicndPJWOcigOFnDg']);
  assert.deepEqual(h.uploaded.map((item) => item.fileName), ['2026-11-17_信踏_退货_退货单.png']);
});

test('AC-SDS3 未到货 / 已勾选：跳过，不读云盘', async () => {
  const notReady = makeGateway({
    报货批次号: 'CGD-1', 发生行为: '报货', 到货状态: '未到货', 供应商: '信踏',
    我方单据: [{ file_token: 'f', name: 'x.png' }], 单据同步: false,
  });
  const skipped = await createSupplyDocumentSyncService({ gateway: notReady.gateway })
    .syncBatch({ batchNo: 'CGD-1' });
  assert.equal(skipped.skipped, 'not_ready');
  assert.equal(notReady.uploaded.length, 0);

  const synced = makeGateway({
    报货批次号: 'CGD-2', 发生行为: '退货', 供应商: '信踏',
    我方单据: [{ file_token: 'f', name: 'x.png' }], 单据同步: true,
  });
  const done = await createSupplyDocumentSyncService({ gateway: synced.gateway })
    .syncBatch({ batchNo: 'CGD-2' });
  assert.equal(done.skipped, 'already_synced');
  assert.equal(synced.uploaded.length, 0);
});

test('AC-SDS4 同名文件覆盖：先删旧文件再上传', async () => {
  const h = makeGateway({
    报货批次号: 'CGD-20261117-0003', 发生行为: '退货', 报货日: Date.parse('2026-11-17T09:00:00+08:00'), 供应商: '信踏',
    我方单据: [{ file_token: 'f', name: '退货单.png' }], 单据同步: false,
  }, {
    QXT9fkXkClKicndPJWOcigOFnDg: [{ token: 'old_token', name: '2026-11-17_信踏_退货_退货单.png', type: 'file' }],
  });
  await createSupplyDocumentSyncService({ gateway: h.gateway }).syncBatch({ batchNo: 'CGD-20261117-0003' });
  assert.deepEqual(h.deleted, ['old_token']);
  assert.equal(h.uploaded.length, 1);
});

test('AC-SDS5 多供应商退货：按附件名的供应商逐个生成文件名，不统一用主表空供应商', async () => {
  const h = makeGateway({
    报货批次号: 'CGD-20261119-0002', 发生行为: '退货',
    供应商: '',
    我方单据: [
      { file_token: 'f_a', name: '信踏-采购退货单.png' },
      { file_token: 'f_b', name: '七匹狼-采购退货单.png' },
    ],
    单据同步: false,
  });
  await createSupplyDocumentSyncService({ gateway: h.gateway }).syncBatch({
    batchNo: 'CGD-20261119-0002',
    supplierNames: ['信踏', '七匹狼'],
  });
  assert.deepEqual(h.uploaded.map((item) => item.fileName), [
    '2026-11-19_信踏_退货_信踏-采购退货单.png',
    '2026-11-19_七匹狼_退货_七匹狼-采购退货单.png',
  ]);
});
