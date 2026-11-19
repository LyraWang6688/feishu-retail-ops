'use strict';

/**
 * 「其他配品.样例图」→ 配品云盘。
 * 业务动作与货品样例图同步一致，复用 driveFileSyncService / 图片附件判定 / 命名清洗。
 */
const { logInfo, logWarn, logError } = require('../utils/logger');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { ACCESSORY_SAMPLE_IMAGE_DRIVE, buildAccessoryFileName } = require('../config/accessorySampleImageDrive');
const { createDriveFileSyncService } = require('./driveFileSyncService');
const { isImageAttachment } = require('./sampleImageDriveService');
const { resolveTransientRetryConfig } = require('../config/pushRetry');

const textOf = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => textOf(item?.text ?? item?.name ?? '')).join('').trim();
  if (typeof value === 'object') return textOf(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
};

const createAccessorySampleImageDriveService = ({
  gateway, config = ACCESSORY_SAMPLE_IMAGE_DRIVE,
} = {}) => {
  if (!gateway) throw new Error('配品样例图云盘同步缺少 gateway');
  const table = V1_BITABLE_SCHEMA.tables.accessory;
  const fields = table.fields;
  const sampleImageField = fields[config.fields.sampleImage];
  const syncedField = fields[config.fields.synced];
  const nameField = fields[config.fields.name];
  const categoryField = fields[config.fields.category];
  if (!sampleImageField || !syncedField || !nameField) {
    throw new Error('「其他配品」schema 缺少样例图 / 同步云盘 / 名称 字段映射');
  }
  const drive = gateway.drive || null;
  const driveFiles = createDriveFileSyncService({
    gateway, operations: config.operations, overwrite: config.overwrite, owner: config.owner,
  });
  const folderToken = textOf(config.folder?.token);
  const readRetryConfig = {
    ...resolveTransientRetryConfig(),
    maxRetries: Number(config.readRetry?.maxRetries ?? 4),
    baseDelayMs: Number(config.readRetry?.baseDelayMs ?? 1500),
    factor: 2,
  };

  const imagesOf = (recordFields) => {
    const value = recordFields?.[sampleImageField];
    const list = Array.isArray(value) ? value : [];
    return list.filter((item) => item && (item.file_token || item.fileToken) && isImageAttachment(item));
  };
  const isPending = (record) => {
    const recordFields = record?.fields || {};
    if (recordFields?.[syncedField] === true) return false;
    return imagesOf(recordFields).length > 0;
  };
  const skip = (recordId, reason) => {
    logInfo('accessory.sample_image.drive.skipped', { record_id: recordId, reason });
    return { record_id: recordId, status: 'skipped', reason };
  };

  const syncRecord = async (recordId, { reason = 'record_added' } = {}) => {
    const id = textOf(recordId);
    if (!id) return { record_id: id, status: 'skipped', reason: 'record_id_missing' };
    if (!drive || typeof drive.uploadDriveFile !== 'function') {
      logError('accessory.sample_image.drive.failed', { record_id: id, reason, error: 'drive 层缺失（gateway.drive）' });
      return { record_id: id, status: 'failed', reason: 'drive_missing' };
    }
    try {
      const record = await gateway.get('accessory', id, { retry: readRetryConfig });
      const recordFields = record?.fields || {};
      if (recordFields?.[syncedField] === true) return skip(id, 'already_synced');
      const images = imagesOf(recordFields);
      if (!images.length) return skip(id, 'no_sample_image');
      const name = textOf(recordFields?.[nameField]);
      const category = textOf(recordFields?.[categoryField]);
      if (!name) return skip(id, 'name_missing');
      const attachment = images[0];
      const fileName = buildAccessoryFileName({
        name, category, sourceName: attachment.name, naming: config.naming,
      });
      if (!fileName) return skip(id, 'file_name_missing');
      const existingFiles = await driveFiles.listFolder(folderToken, config.operations);
      const result = await driveFiles.syncAttachment({
        attachment,
        folderToken,
        fileName,
        existingFiles,
        onlyFiles: false,
        operations: config.operations,
        overwrite: config.overwrite,
        owner: config.owner,
      });
      if (result.skipped) {
        logInfo('accessory.sample_image.drive.name_exists', { record_id: id, file_name: fileName });
        return { record_id: id, status: 'skipped', reason: 'name_exists', file_name: fileName };
      }
      await gateway.update('accessory', id, { [config.fields.synced]: true });
      logInfo('accessory.sample_image.drive.synced', {
        record_id: id, file_name: fileName, file_token: result.fileToken, category,
      });
      return { record_id: id, status: 'synced', uploaded: 1 };
    } catch (error) {
      logError('accessory.sample_image.drive.failed', {
        record_id: id, reason, error: error?.message || String(error),
      });
      return { record_id: id, status: 'failed', reason, error: error?.message || String(error) };
    }
  };

  const handleTableChanges = async (actionList) => {
    const created = new Set(config.events?.created || []);
    const results = [];
    const failed = [];
    for (const item of Array.isArray(actionList) ? actionList : []) {
      if (!item?.record_id || !created.has(item.action)) continue;
      // eslint-disable-next-line no-await-in-loop —— drive 上传不支持并发
      const result = await syncRecord(item.record_id, { reason: item.action });
      results.push(result);
      if (result.status === 'failed') failed.push(result);
    }
    return { results, failed };
  };

  return { handleTableChanges, syncRecord, isPending };
};

module.exports = { createAccessorySampleImageDriveService };
