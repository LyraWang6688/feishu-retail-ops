'use strict';

/**
 * 供应单据自动同步（2026-11-18 业务负责人）：
 *   · 报货 + 已到货：我方单据 → 供应单据/我方；对方单据 → 供应单据/对方；
 *   · 退货：我方单据 → 供应单据/我方；
 *   · 成功后勾选采购主表「单据同步」。
 *
 * 纯后端；云盘访问只经 gateway.drive（与样例图同步同一层）。
 * 同步失败**不勾选**，由调用方记录；下次触发会重试。
 */
const { textValue } = require('./v1BitableGateway');
const { extraOfAttachment } = require('./driveApi');
const { logInfo, logWarn } = require('../utils/logger');
const CONFIG = require('../config/supplyDocumentSync');

const attachmentList = (cell) => (Array.isArray(cell) ? cell : [])
  .map((item) => ({
    fileToken: String(item?.file_token || item?.fileToken || '').trim(),
    name: String(item?.name || '').trim(),
    extra: extraOfAttachment(item),
  }))
  .filter((item) => item.fileToken);

const dayKeyOfBatchNo = (batchNo) => {
  const match = String(batchNo || '').match(/^CGD-(\d{4})(\d{2})(\d{2})-/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
};

const safePart = (value) => String(value || '')
  .replace(/[\\/:*?"<>|\r\n]/g, '_')
  .replace(/\s+/g, ' ')
  .trim();

const createSupplyDocumentSyncService = ({ gateway, config = CONFIG } = {}) => {
  if (!gateway) throw new Error('SupplyDocumentSyncService requires gateway');

  const syncFile = async ({ attachment, folderToken, prefix, correlation }) => {
    if (!gateway.drive) throw new Error('gateway.drive 未挂载，无法同步供应单据');
    const baseName = safePart(attachment.name) || attachment.fileToken;
    const fileName = safePart(`${prefix}_${baseName}`).slice(0, 180);
    const content = await gateway.drive.downloadMedia(
      attachment.fileToken, config.operations.download, { extra: attachment.extra },
    );
    const existing = await gateway.drive.listDriveFolder(folderToken, config.operations.list);
    const sameName = (existing || []).filter((item) => item.type === 'file' && item.name === fileName);
    for (const item of sameName) {
      await gateway.drive.deleteDriveFile(item.token, config.operations.delete);
    }
    const fileToken = await gateway.drive.uploadDriveFile({
      folderToken, fileName, content, operation: config.operations.upload,
    });
    logInfo('supply.document.sync.file', {
      batch_no: correlation?.batch_no || '', folder: folderToken,
      file_name: fileName, file_token: fileToken, overwritten: sameName.length,
    });
    return { fileName, fileToken, overwritten: sameName.length };
  };

  const syncBatch = async ({ batchNo = '', batchRecordId = '' } = {}) => {
    const wantedNo = String(batchNo || '').trim();
    const wantedId = String(batchRecordId || '').trim();
    if (!wantedId && !wantedNo) throw new Error('同步供应单据缺少批次身份');
    const record = wantedId
      ? await gateway.get('purchaseOrderBatch', wantedId)
      : (await gateway.listAll('purchaseOrderBatch')).find((row) => (
        textValue(row.fields?.[config.fields.batchNo]).trim() === wantedNo
      ));
    if (!record) return { ok: true, skipped: 'no_batch_record', batch_no: wantedNo };
    const fields = record.fields || {};
    if (fields[config.fields.documentSync] === true) {
      return { ok: true, skipped: 'already_synced', batch_no: wantedNo };
    }
    const behavior = textValue(fields[config.fields.behavior]).trim();
    const status = textValue(fields[config.fields.status]).trim();
    const myDocs = attachmentList(fields[config.fields.myDocuments]);
    const otherDocs = attachmentList(fields[config.fields.counterpartyDocuments]);
    const isReturn = behavior === config.behavior.return;
    const isPurchase = behavior === config.behavior.purchase;
    if (!isReturn && !(isPurchase && status === config.arrivedStatus)) {
      return { ok: true, skipped: 'not_ready', batch_no: wantedNo, behavior, status };
    }
    if (!myDocs.length && !otherDocs.length) {
      return { ok: true, skipped: 'no_documents', batch_no: wantedNo, behavior, status };
    }
    const dateKey = dayKeyOfBatchNo(wantedNo) || config.texts.unknownDate;
    const supplier = safePart(textValue(fields[config.fields.supplier]).trim()) || config.texts.unknownSupplier;
    const prefix = `${dateKey}_${supplier}_${behavior || config.texts.unknownBehavior}`;
    const correlation = { batch_no: wantedNo };
    const synced = [];
    for (const doc of myDocs) {
      synced.push(await syncFile({ attachment: doc, folderToken: config.folders.our, prefix, correlation }));
    }
    if (isPurchase && status === config.arrivedStatus) {
      for (const doc of otherDocs) {
        synced.push(await syncFile({ attachment: doc, folderToken: config.folders.counterparty, prefix, correlation }));
      }
    }
    await gateway.update('purchaseOrderBatch', record.record_id, { documentSync: true }, { correlation });
    logInfo('supply.document.sync.done', {
      batch_no: wantedNo, batch_record_id: record.record_id, behavior,
      status, my_count: myDocs.length, counterparty_count: isPurchase ? otherDocs.length : 0,
      synced_count: synced.length,
    });
    return {
      ok: true, batch_no: wantedNo, batch_record_id: record.record_id,
      behavior, status, my_count: myDocs.length,
      counterparty_count: isPurchase ? otherDocs.length : 0,
      synced,
    };
  };

  return { syncBatch };
};

module.exports = { createSupplyDocumentSyncService };
