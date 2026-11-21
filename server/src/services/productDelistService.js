'use strict';

/**
 * 货品下架：软删除（「下架」复选框）+ 样例图归档（2026-11-21）。
 *
 * 口径：
 *   · 有样例图：优先把**在售样例图云盘**里的同名文件 move 到「历史货品」；
 *     在售云盘找不到 ⇒ 从 Bitable「样例图」附件补传一份到历史云盘；
 *   · 历史云盘同名 ⇒ 直接删除目标同名文件后再移动/上传（覆盖）；
 *   · 没有样例图：调用方传 allowNoSample=true 才删；
 *   · 归档失败 ⇒ 不写下架标记。
 *   · 绝不删除「货品信息」记录；货品状态是公式，代码不写。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { textValue } = require('./v1BitableGateway');
const { SAMPLE_IMAGE_DRIVE } = require('../config/sampleImageDrive');
const { buildFileName, isImageAttachment } = require('./sampleImageDriveService');
const { DRIVE_SYNC } = require('../config/driveSync');
const { PRODUCT_LIFECYCLE } = require('../config/productLifecycle');
const { isDelistedRecord } = require('./productLifecycle');
const { createDriveFileSyncService } = require('./driveFileSyncService');
const { invalidateConfigTable } = require('./configTableCache');
const { invalidateProductSearchSnapshot } = require('./productSearchSnapshot');
const { logInfo, logWarn } = require('../utils/logger');

const createProductDelistService = ({
  gateway,
  sampleConfig = SAMPLE_IMAGE_DRIVE,
  historyConfig = DRIVE_SYNC.destinations.productHistory,
} = {}) => {
  if (!gateway) throw new Error('ProductDelistService requires gateway');
  const table = V1_BITABLE_SCHEMA.tables.product;
  const fields = table.fields;
  if (!fields.delisted) throw new Error('「货品信息」schema 没有 delisted 字段映射');
  const drive = gateway.drive;
  if (!drive) throw new Error('ProductDelistService requires gateway.drive');

  const historyOps = historyConfig.operations || DRIVE_SYNC.operations;
  const driveFiles = createDriveFileSyncService({
    gateway,
    operations: historyOps,
    overwrite: historyConfig.overwrite || 'replace',
  });

  const imagesOf = (recordFields) => {
    const value = recordFields?.[fields.sampleImage];
    const list = Array.isArray(value) ? value : [];
    return list.filter((item) => item && item.file_token && isImageAttachment(item));
  };

  const nameBaseOf = (recordFields, recordId) => {
    const number = textValue(recordFields?.[fields.number]).trim();
    if (number) return number;
    const parts = [
      textValue(recordFields?.[fields.itemNo]).trim(),
      textValue(recordFields?.[fields.color]).trim(),
      textValue(recordFields?.[fields.category]).trim(),
    ].filter(Boolean);
    return parts.length ? parts.join('|') : recordId;
  };

  const fileNameOf = ({ recordFields, recordId, attachment, index, total }) => (
    buildFileName({
      number: nameBaseOf(recordFields, recordId),
      index: index + 1,
      total,
      sourceName: attachment?.name,
      naming: sampleConfig.naming,
    }) || `${recordId}-${index + 1}${String(attachment?.name || '').match(/\.[a-z0-9]+$/i)?.[0] || '.jpg'}`
  );

  const deleteExistingTarget = async (files, fileName) => {
    const same = (files || []).filter((file) => file.name === fileName && file.type === 'file');
    for (const file of same) {
      await drive.deleteDriveFile(file.token, historyOps.delete);
    }
    return same.length;
  };

  const archiveImages = async ({ recordId, recordFields }) => {
    const images = imagesOf(recordFields);
    if (!images.length) return { archived: 0, moved: 0, uploaded: 0 };
    const sourceFiles = await driveFiles.listFolder(sampleConfig.folder.token, sampleConfig.operations);
    let historyFiles = await driveFiles.listFolder(historyConfig.folderToken, historyOps);
    let moved = 0;
    let uploaded = 0;
    for (let index = 0; index < images.length; index += 1) {
      const attachment = images[index];
      const fileName = fileNameOf({
        recordFields, recordId, attachment, index, total: images.length,
      });
      const source = (sourceFiles || []).find((file) => file.name === fileName && file.type === 'file');
      if (source) {
        await deleteExistingTarget(historyFiles, fileName);
        await drive.moveDriveFile(source.token, historyConfig.folderToken, historyOps.move);
        moved += 1;
        historyFiles = historyFiles.filter((file) => file.name !== fileName);
        continue;
      }
      // 在售云盘没有这一张（历史未同步 / 被手工删）⇒ 从附件补传；同名覆盖。
      await driveFiles.syncAttachment({
        attachment,
        folderToken: historyConfig.folderToken,
        fileName,
        existingFiles: null,
        overwrite: 'replace',
        operations: historyOps,
      });
      uploaded += 1;
    }
    return { archived: moved + uploaded, moved, uploaded };
  };

  const deleteDelistedProduct = async ({ recordId, allowNoSample = false, operatorOpenId = '', correlation = {} } = {}) => {
    const id = String(recordId || '').trim();
    if (!id) return { ok: false, reason: 'missing_record_id' };
    const record = await gateway.get('product', id);
    if (!record) return { ok: false, reason: 'product_not_found' };
    if (isDelistedRecord(record)) {
      return { ok: true, record_id: id, already_delisted: true, archive: { archived: 0, moved: 0, uploaded: 0 } };
    }
    const recordFields = record.fields || {};
    const images = imagesOf(recordFields);
    if (!images.length && allowNoSample !== true) {
      return { ok: false, reason: 'no_sample_image' };
    }
    let archive = { archived: 0, moved: 0, uploaded: 0 };
    if (PRODUCT_LIFECYCLE.downlist.archiveSampleImages && images.length) {
      try {
        archive = await archiveImages({ recordId: id, recordFields });
      } catch (error) {
        logWarn('product.delisted.archive_failed', {
          record_id: id, error: String(error?.message || error).slice(0, 300),
        });
        return { ok: false, reason: 'archive_failed', error: String(error?.message || error).slice(0, 300) };
      }
    }
    await gateway.update('product', id, {
      [fields.delisted]: PRODUCT_LIFECYCLE.downlist.setDelisted,
    }, { correlation });
    invalidateConfigTable('product');
    invalidateProductSearchSnapshot();
    logInfo('product.delisted.soft_deleted', {
      record_id: id,
      number: textValue(recordFields[fields.number]).trim(),
      operator_open_id: operatorOpenId || undefined,
      archived: archive.archived,
      moved: archive.moved,
      uploaded: archive.uploaded,
      ...correlation,
    });
    return { ok: true, record_id: id, soft_deleted: true, archive };
  };

  return { deleteDelistedProduct };
};

module.exports = { createProductDelistService };
