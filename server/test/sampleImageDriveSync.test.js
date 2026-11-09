'use strict';

/**
 * 「货品信息.样例图 → 云盘文件夹」同步（2026-11-10 业务负责人）。
 *
 * 口径（逐字）：「是的，就是这个时候把样例图写入到云盘里，**但只有新增的时候**，
 *                然后需要把**那个复选框勾选上**」
 *
 * 这里钉的是**业务判据**（不连网、不连 Base）：
 *   AC-SD1 只认**新增**（`record_added`）—— 修改/删除事件一条都不处理；
 *   AC-SD2 有图 ⇒ 下载 + 上传到配置的文件夹 + **成功后勾「已同步云盘」**；
 *   AC-SD3 已勾（幂等）⇒ 不重复下载/上传；
 *   AC-SD4 没图 ⇒ 跳过，**不勾复选框**；
 *   AC-SD5 多张图 ⇒ 全部上传，命名加 `-1` `-2` 序号；同名先删旧文件（replace）；
 *   AC-SD6 上传失败 ⇒ 不勾复选框（留给补跑），失败如实返回；
 *   AC-SD7 命名口径 = 货号 + 颜色 + 原扩展名（非法字符替换）；
 *   AC-SD8 schema 契约：「样例图」「已同步云盘」两个字段映射必须在货品信息 schema 里；
 *   AC-SD9 开关关掉 ⇒ 一个字节都不传。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SAMPLE_IMAGE_DRIVE } = require('../src/config/sampleImageDrive');
const {
  createSampleImageDriveService,
  buildFileName,
  sanitizeFileName,
  extensionOf,
  isImageAttachment,
} = require('../src/services/sampleImageDriveService');

const F = V1_BITABLE_SCHEMA.tables.product.fields;
const FOLDER = 'folder_test_xyz';

const configOf = (over = {}) => ({
  ...SAMPLE_IMAGE_DRIVE,
  enabled: true,
  folder: { ...SAMPLE_IMAGE_DRIVE.folder, token: FOLDER },
  events: { created: ['record_added'], updated: [] },
  overwrite: 'replace',
  maxImages: 10,
  fields: { sampleImage: 'sampleImage', synced: 'sampleImageSynced' },
  ...over,
});

const fieldsOf = ({
  itemNo = 'A1', color = '黑色', category = 'A', images = [], synced = false,
  number = `${itemNo}|${color}|${category}`,
} = {}) => ({
  [F.itemNo]: itemNo,
  [F.color]: [{ text: color }],
  [F.category]: category,
  [F.number]: number,
  [F.sampleImage]: images,
  [F.sampleImageSynced]: synced,
});

const imageOf = (token, name = 'x.jpg', type = 'image/jpeg') => ({ file_token: token, name, type });

const createGateway = ({ fields, folderFiles = [], failUploadAt = 0 } = {}) => {
  const calls = { get: [], list: [], del: [], download: [], upload: [], update: [] };
  let uploadCount = 0;
  return {
    calls,
    async get(tableKey, recordId) {
      calls.get.push([tableKey, recordId]);
      return { fields };
    },
    async update(tableKey, recordId, patch) {
      calls.update.push([tableKey, recordId, patch]);
      return {};
    },
    // ⭐ 云盘层 = `services/driveApi.js` 挂出来的 `gateway.drive`（服务只认这一个入口）
    drive: {
      async listDriveFolder(token) {
        calls.list.push(token);
        return folderFiles;
      },
      async deleteDriveFile(token) {
        calls.del.push(token);
        return { token };
      },
      async downloadMedia(token) {
        calls.download.push(token);
        return Buffer.from(`img:${token}`);
      },
      async uploadDriveFile({ folderToken, fileName, content, operation }) {
        uploadCount += 1;
        if (failUploadAt && uploadCount === failUploadAt) throw new Error('上传接口炸了');
        calls.upload.push({ folderToken, fileName, size: content.length, operation });
        return `cloud_${fileName}`;
      },
    },
  };
};

test('AC-SD1 只认新增：record_edited / record_deleted 一条都不处理', async () => {
  const gateway = createGateway({ fields: fieldsOf({ images: [imageOf('ft1')] }) });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.handleTableChanges([
    { record_id: 'r1', action: 'record_edited' },
    { record_id: 'r2', action: 'record_deleted' },
  ]);
  assert.deepEqual(result.results, []);
  assert.deepEqual(gateway.calls.get, [], '非新增事件连记录都不读');
  assert.deepEqual(gateway.calls.upload, []);
});

test('AC-SD2 新增有图 ⇒ 下载 + 上传到配置文件夹 + 成功后勾「已同步云盘」', async () => {
  const gateway = createGateway({ fields: fieldsOf({ images: [imageOf('ft1', 'orig.jpg')] }) });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.handleTableChanges([{ record_id: 'r1', action: 'record_added' }]);

  assert.equal(result.results[0].status, 'synced');
  assert.deepEqual(gateway.calls.get, [['product', 'r1']]);
  assert.deepEqual(gateway.calls.download, ['ft1']);
  assert.deepEqual(gateway.calls.list, [FOLDER]);
  assert.equal(gateway.calls.upload.length, 1);
  assert.deepEqual(gateway.calls.upload[0], {
    folderToken: FOLDER, fileName: 'A1_黑色_A.jpg', size: Buffer.from('img:ft1').length, operation: configOf().operations.upload,
  });
  assert.deepEqual(gateway.calls.update, [['product', 'r1', { sampleImageSynced: true }]]);
});

test('AC-SD3 已勾「已同步云盘」⇒ 幂等跳过，不重复下载/上传', async () => {
  const gateway = createGateway({ fields: fieldsOf({ images: [imageOf('ft1')], synced: true }) });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.syncRecord('r1');
  assert.deepEqual(result, { record_id: 'r1', status: 'skipped', reason: 'already_synced' });
  assert.deepEqual(gateway.calls.download, []);
  assert.deepEqual(gateway.calls.upload, []);
  assert.deepEqual(gateway.calls.update, []);
});

test('AC-SD4 没图 ⇒ 跳过且**不勾**复选框（不能假装同步过）', async () => {
  const gateway = createGateway({ fields: fieldsOf({ images: [] }) });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.syncRecord('r1');
  assert.deepEqual(result, { record_id: 'r1', status: 'skipped', reason: 'no_sample_image' });
  assert.deepEqual(gateway.calls.update, []);
  assert.deepEqual(gateway.calls.upload, []);
});

test('AC-SD5 多张图 ⇒ 全部上传、命名加序号；同名先删旧文件（replace）', async () => {
  const gateway = createGateway({
    fields: fieldsOf({ images: [imageOf('ft1', 'a.png'), imageOf('ft2', 'b.png')] }),
    folderFiles: [
      { token: 'old_1', name: 'A1_黑色_A-1.png' },
      { token: 'manual', name: '261175杏色.jpg' }, // 她手工传的：绝不能被删
    ],
  });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.syncRecord('r1');

  assert.equal(result.status, 'synced');
  assert.deepEqual(gateway.calls.upload.map((item) => item.fileName), ['A1_黑色_A-1.png', 'A1_黑色_A-2.png']);
  assert.deepEqual(gateway.calls.del, ['old_1'], '只删同名旧文件；她手工传的保留');
  assert.deepEqual(gateway.calls.update, [['product', 'r1', { sampleImageSynced: true }]]);
});

test('AC-SD6 上传失败 ⇒ 不勾复选框、失败如实返回（留给补跑）', async () => {
  const gateway = createGateway({ fields: fieldsOf({ images: [imageOf('ft1')] }), failUploadAt: 1 });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.syncRecord('r1');
  assert.equal(result.status, 'failed');
  assert.match(result.error, /上传接口炸了/);
  assert.deepEqual(gateway.calls.update, [], '失败不许勾「已同步云盘」');
});

test('AC-SD7 命名口径：用「编号」（货号|颜色|类别）→ `_` 分隔；多张加序号；兜底/非法字符/.jpg', () => {
  // ⭐ 2026-11-10 业务负责人：「需要用编号」—— 编号全段都进文件名（含类别 ⇒ 同货号同色、A/B 不撞名）
  assert.equal(buildFileName({ number: '261175|杏色|A', index: 1, total: 1, sourceName: 'x.jpg' }), '261175_杏色_A.jpg');
  assert.equal(buildFileName({ number: 'A1|黑色|B', index: 1, total: 2, sourceName: 'a.png' }), 'A1_黑色_B-1.png');
  // 编号为空（新增瞬间公式还没算完）⇒ 用源字段兜底（货号+颜色+类别，同序）
  assert.equal(buildFileName({ number: '', itemNo: 'A1', color: '黑色', category: 'A', index: 1, total: 1, sourceName: 'x.jpg' }), 'A1黑色A.jpg');
  // 编号里出现非法字符 ⇒ 替换成 `_`
  assert.equal(buildFileName({ number: 'A1|黑/色|A', index: 1, total: 1, sourceName: 'noext' }), 'A1_黑_色_A.jpg');
  assert.equal(sanitizeFileName('A1:黑色', SAMPLE_IMAGE_DRIVE.naming), 'A1_黑色');
  assert.equal(extensionOf('whatever.JPEG', SAMPLE_IMAGE_DRIVE.naming), '.jpeg');
  assert.equal(extensionOf('noext', SAMPLE_IMAGE_DRIVE.naming), '.jpg');
  assert.equal(isImageAttachment({ name: 'a.PNG', type: '' }), true);
  assert.equal(isImageAttachment({ name: 'a.pdf', type: 'application/pdf' }), false, '非图片附件不许混进云盘');
});

test('AC-SD8 schema 契约：「样例图」/「已同步云盘」两个字段映射必须在货品信息 schema 里', () => {
  assert.equal(F[configOf().fields.sampleImage], '样例图');
  assert.equal(F[configOf().fields.synced], '已同步云盘');
  assert.equal(SAMPLE_IMAGE_DRIVE.folder.token, 'NIxifKs4ulS5uudlGP2cKtDBnkd', '默认文件夹 = 她 2026-10-13 给的那个');
  assert.deepEqual(SAMPLE_IMAGE_DRIVE.events.created, ['record_added'], '只认新增');
  assert.deepEqual(SAMPLE_IMAGE_DRIVE.events.updated, [], '本轮改图不触发');
});

test('AC-SD9 开关关掉 ⇒ 一个字节都不传（连记录都不读）', async () => {
  const gateway = createGateway({ fields: fieldsOf({ images: [imageOf('ft1')] }) });
  const service = createSampleImageDriveService({ gateway, config: configOf({ enabled: false }) });
  const result = await service.syncRecord('r1');
  assert.deepEqual(result, { record_id: 'r1', status: 'skipped', reason: 'disabled' });
  assert.deepEqual(gateway.calls.get, []);
  assert.deepEqual(gateway.calls.upload, []);
});
