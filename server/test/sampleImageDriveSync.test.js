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
  const calls = { get: [], list: [], del: [], download: [], upload: [], update: [], transfer: [] };
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
      async transferFileOwner(fileToken, { owner = {}, operation } = {}) {
        calls.transfer.push({ fileToken, owner, operation });
        return { token: fileToken };
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

test('AC-SD7 命名口径：只用「编号」（货号|颜色|类别）→ `_` 分隔；编号空 ⇒ 不命名（空串）', () => {
  // ⭐ 2026-11-10 业务负责人：「需要用编号」—— 编号全段都进文件名（含类别 ⇒ 同货号同色、A/B 不撞名）
  assert.equal(buildFileName({ number: '261175|杏色|A', index: 1, total: 1, sourceName: 'x.jpg' }), '261175_杏色_A.jpg');
  assert.equal(buildFileName({ number: 'A1|黑色|B', index: 1, total: 2, sourceName: 'a.png' }), 'A1_黑色_B-1.png');
  // ⭐ 2026-11-10（业务负责人）：「重试直到有（编号）」⇒ **不再用货号/颜色兜底**
  assert.equal(buildFileName({ number: '', index: 1, total: 1, sourceName: 'x.jpg' }), '', '编号空 ⇒ 不命名（由调用方等编号 / 跳过）');
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

test('AC-SD12 ⭐ 本功能**没有开关**（业务负责人 2026-11-10：「不需要加开关」）—— 塞回开关即红', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const SERVER = path.join(__dirname, '..');
  const stripComments = (code) => code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const configSrc = stripComments(fs.readFileSync(path.join(SERVER, 'src/config/sampleImageDrive.js'), 'utf8'));
  const serviceSrc = stripComments(fs.readFileSync(path.join(SERVER, 'src/services/sampleImageDriveService.js'), 'utf8'));
  // 注释里写"曾经/不许再有"是允许的；**代码里**出现才红（与仓库"注释不算"的既有口径一致）
  assert.equal(/SAMPLE_IMAGE_DRIVE_SYNC_ENABLED/.test(configSrc + serviceSrc), false,
    '开关名不许再出现在代码里（她：「不需要加开关」）');
  assert.equal(/\benabled\s*:/.test(configSrc), false, '配置里不许再放 enabled 开关字段');
  assert.equal(/config\.enabled/.test(serviceSrc), false, '服务不许再读 config.enabled');
  assert.equal(/drive\.disabled/.test(serviceSrc), false, 'disabled 日志分支不许回来');
});


test('AC-SD10 ⭐ 新增瞬间「编号」为空 ⇒ **重试直到有编号**再用它命名（不用货号兜底）', async () => {
  const waitConfig = configOf({ numberWait: { attempts: 3, intervalMs: 0 } });
  let reads = 0;
  const sequences = [
    fieldsOf({ number: '', images: [imageOf('ft1')] }),            // 第 1 次：公式还没算完
    fieldsOf({ number: '', images: [imageOf('ft1')] }),            // 第 2 次：还没
    fieldsOf({ number: 'A1|黑色|A', images: [imageOf('ft1')] }),   // 第 3 次：有了
  ];
  const gateway = {
    calls: { get: [], upload: [] },
    async get() { const fields = sequences[Math.min(reads, sequences.length - 1)]; reads += 1; gateway.calls.get.push(reads); return { fields }; },
    async update() { return {}; },
    drive: {
      async listDriveFolder() { return []; },
      async deleteDriveFile() { return {}; },
      async downloadMedia() { return Buffer.from('img'); },
      async uploadDriveFile({ fileName }) { gateway.calls.upload.push(fileName); return 'ft_1'; },
    },
  };
  const service = createSampleImageDriveService({ gateway, config: waitConfig, sleep: async () => {} });
  const result = await service.syncRecord('r1', { waitForNumber: true });

  assert.equal(result.status, 'synced');
  assert.equal(reads, 3, '等到第 3 次读到编号才传');
  assert.deepEqual(gateway.calls.upload, ['A1_黑色_A.jpg'], '用编号命名，不是 A1黑色A.jpg');
});

test('AC-SD11 ⭐ 一直等不到「编号」⇒ 跳过不传、不勾（留给存量补）', async () => {
  const waitConfig = configOf({ numberWait: { attempts: 2, intervalMs: 0 } });
  let reads = 0;
  const gateway = {
    calls: { get: 0, upload: [] },
    async get() { reads += 1; return { fields: fieldsOf({ number: '', images: [imageOf('ft1')] }) }; },
    async update() { throw new Error('不该勾复选框'); },
    drive: {
      async listDriveFolder() { return []; },
      async deleteDriveFile() { return {}; },
      async downloadMedia() { return Buffer.from('img'); },
      async uploadDriveFile({ fileName }) { gateway.calls.upload.push(fileName); return 'ft_1'; },
    },
  };
  const service = createSampleImageDriveService({ gateway, config: waitConfig, sleep: async () => {} });
  const result = await service.syncRecord('r1', { waitForNumber: true });

  assert.deepEqual(result, { record_id: 'r1', status: 'skipped', reason: 'number_missing' });
  assert.deepEqual(gateway.calls.upload, [], '编号都没有 ⇒ 不传无名文件');
  assert.equal(reads, 3, '初次读 1 次 + 等 2 次（attempts=2）');
});

test('AC-SD13 ⭐ 公式「编号」是富文本数组（真机形状）⇒ 必须解出文本命名，不能 [object Object]', async () => {
  // 生产实际返回（2026-11-10 实查）：[{"text":"66888|黑色|男","type":"text"}]
  const rawNumber = [{ text: '66888|黑色|男', type: 'text' }];
  assert.equal(
    buildFileName({ number: rawNumber, index: 1, total: 1, sourceName: 'x.jpeg' }),
    '66888_黑色_男.jpeg',
    '公式列富文本数组要解出 text（旧实现 String() ⇒ [object Object].jpeg）',
  );

  const gateway = createGateway({
    fields: fieldsOf({ number: rawNumber, images: [imageOf('ft1')] }),
  });
  const service = createSampleImageDriveService({ gateway, config: configOf() });
  const result = await service.syncRecord('r1');
  assert.equal(result.status, 'synced');
  assert.equal(gateway.calls.upload[0].fileName, '66888_黑色_男.jpg', '上传文件名必须是编号文本（扩展名跟附件走）');
  assert.equal(gateway.calls.upload[0].fileName.includes('object Object'), false);
});


test('AC-SD16 ⭐ 固定所有者：配置了 owner ⇒ 每个上传成功的文件立刻转移给赵瑞玲；失败则该条不勾', async () => {
  const fixedOwner = { openId: 'ou_zhaoruiling', email: '' };
  const gateway = createGateway({ fields: fieldsOf({ images: [imageOf('ft1', 'a.jpg')] }) });
  const service = createSampleImageDriveService({ gateway, config: configOf({ owner: fixedOwner }) });
  const result = await service.syncRecord('r1', { reason: 'backfill' });
  assert.equal(result.status, 'synced');
  assert.deepEqual(gateway.calls.transfer.map((t) => t.fileToken), ['cloud_A1_黑色_A.jpg']);
  assert.deepEqual(gateway.calls.transfer[0].owner, fixedOwner, '转移给固定的人（赵瑞玲）');
  assert.deepEqual(gateway.calls.update.at(-1), ['product', 'r1', { sampleImageSynced: true }]);

  // 没配置 owner ⇒ 不转移（旧行为：所有者 = 应用）
  const gateway2 = createGateway({ fields: fieldsOf({ images: [imageOf('ft1', 'a.jpg')] }) });
  const service2 = createSampleImageDriveService({ gateway: gateway2, config: configOf() });
  await service2.syncRecord('r1');
  assert.deepEqual(gateway2.calls.transfer, []);

  // 转移失败 ⇒ 该条 failed、不勾（如实；下次点会重传+重转）
  const gateway3 = createGateway({ fields: fieldsOf({ images: [imageOf('ft1', 'a.jpg')] }) });
  gateway3.drive.transferFileOwner = async () => { throw new Error('转移失败'); };
  const service3 = createSampleImageDriveService({ gateway: gateway3, config: configOf({ owner: fixedOwner }) });
  const failed = await service3.syncRecord('r1');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(gateway3.calls.update, [], '转移失败 ⇒ 不勾复选框');
});
