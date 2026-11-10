/**
 * 货品信息「标签二维码」service —— 只干一件事：让「货品信息.标签二维码」跟着 **记录 ID** 走。
 *
 * 二维码内容：`https://hm.bamamei.online/r/{recordId}`（唯一真源 `config/tagQrCode.js`
 * 的 `scanUrl.recordIdTemplate`）；文件名：`tag-qr-{recordId}.png`。
 *
 * 🔴 **与「编号」（货号|颜色|类别）彻底无关**（业务负责人 2026-11-11 定案：「不用做兼容了，
 *    目前业务已经没有了，就是用 recordId」）：
 *   · 不再读「编号」、不再拼公式、不再按编号判过期；
 *   · recordId 在记录生命周期内不变 ⇒ 改任何字段都不影响码；
 *   · 旧 `/s/{编号}` 贴纸不再兼容（扫码入口只保留 `/r/:recordId`）。
 *
 * 一段流程，三步（`syncRecord`）：
 *   ① `qrcode` 生成 PNG（仓库已有依赖，不引新依赖）；
 *   ② 上传飞书素材库拿 `file_token`（`drive/v1/medias/upload_all`）；
 *   ③ `gateway.update('product', recordId, { tagQrCode: [{ file_token }] })` 写回附件列。
 *
 * 幂等：现存附件名 = 当前规范名（`tag-qr-{recordId}.png`）⇒ 跳过；
 *   否则（没有附件 / 旧格式命名 / 名字不符）⇒ 覆盖重写 —— 旧 `/s/{编号}` 码就是这样被升级的。
 * 失败大声报错并抛出（调用方计失败数/记日志）；`enabled=false` 时一个字都不写。
 */
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { TAG_QR_CODE } = require('../config/tagQrCode');
const { logInfo, logWarn, logError } = require('../utils/logger');
// ⭐ 2026-10-09：扫码页「货品信息」内存快照的跨模块失效（写标签二维码 = 改了货品）。
const { invalidateLiveInventorySnapshot } = require('./liveInventorySnapshot');

const RECORD_ID_PLACEHOLDER = '{recordId}';

/** 二维码 URL（只认 recordId；模板没有占位符 / 有别的占位符 ⇒ 当场抛）。 */
const buildRecordIdScanUrl = (recordId, config = TAG_QR_CODE) => {
  const source = String(config?.scanUrl?.recordIdTemplate ?? '');
  if (!source.includes(RECORD_ID_PLACEHOLDER)) {
    throw new Error(`二维码 URL 模板里没有 {recordId} 占位符：${source || '(空)'}`);
  }
  const id = String(recordId ?? '').trim();
  if (!id) throw new Error('记录没有 record_id，无法生成标签二维码');
  const encoded = source.split(RECORD_ID_PLACEHOLDER).join(encodeURIComponent(id));
  const stray = encoded.replace(encodeURIComponent(id), '').match(/\{(\w+)\}/);
  if (stray) throw new Error(`二维码 URL 模板里的占位符不认识：{${stray[1]}}（可用：{recordId}）`);
  return encoded;
};

/** 规范文件名：模板来自 config，值 = recordId（非法字符替换掉，超长截断）。 */
const buildFileName = (recordId, config = TAG_QR_CODE) => {
  const fileName = config.fileName;
  const safe = String(recordId ?? '').replace(fileName.invalidChars, fileName.replacement);
  const name = fileName.template.replace(RECORD_ID_PLACEHOLDER, safe);
  return name.length > fileName.maxLength ? name.slice(0, fileName.maxLength) : name;
};

/** 附件 cell → `[{ file_token, name }]`。 */
const attachmentsOf = (value) => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .filter((item) => item && typeof item === 'object' && String(item.file_token || '').trim())
    .map((item) => ({ file_token: String(item.file_token).trim(), name: String(item.name || '') }));
};

/**
 * 在事件带的字段值数组里找某一列的取值（**保留**：其它入口复用同一份读法）。
 * 返回 `undefined` = 事件里没有这一列（与"有这一列但值为空"区分开）。
 */
const findFieldValue = (values, fieldId) => {
  if (!fieldId || !Array.isArray(values)) return undefined;
  const hit = values.find((item) => item && item.field_id === fieldId);
  return hit ? hit.field_value : undefined;
};

/** 生成二维码 PNG（默认实现；测试可注入，避免每次真出图）。 */
const generateQrPng = (text, qrConfig = TAG_QR_CODE.qr) => QRCode.toBuffer(text, {
  type: 'png',
  errorCorrectionLevel: qrConfig.errorCorrectionLevel,
  width: qrConfig.widthPx,
  margin: qrConfig.marginModules,
  color: { dark: qrConfig.darkColor, light: qrConfig.lightColor },
});

const createTagQrCodeService = ({
  gateway,
  config = TAG_QR_CODE,
  generatePng = generateQrPng,
} = {}) => {
  const productTable = V1_BITABLE_SCHEMA.tables.product;
  const tagQrFieldName = productTable.fields[config.fields.tagQrCode];
  const ensureFieldNames = () => {
    if (!tagQrFieldName) throw new Error('「货品信息」schema 里没有 tagQrCode 字段映射（config.fields.tagQrCode）');
  };
  const scanUrlOf = (recordId) => buildRecordIdScanUrl(recordId, config);
  const fileNameOf = (recordId) => buildFileName(recordId, config);

  /** 让一条货品记录的「标签二维码」与它的 recordId 一致。失败一律抛错（调用方记日志）。 */
  const syncRecord = async (recordId, { reason = 'manual', force = false } = {}) => {
    if (config.enabled !== true) {
      logInfo('product.tag_qr.disabled', { record_id: recordId, reason });
      return { record_id: recordId, status: 'skipped', reason: 'disabled' };
    }
    ensureFieldNames();
    const scanUrl = scanUrlOf(recordId);
    const fileName = fileNameOf(recordId);
    const record = await gateway.get('product', recordId);
    const existing = attachmentsOf(record?.fields?.[tagQrFieldName]);
    const namesMatch = existing.some((item) => item.name === fileName);

    if (!force && existing.length && namesMatch) {
      logInfo('product.tag_qr.skipped_existing', {
        record_id: recordId, reason, file_names: existing.map((item) => item.name),
      });
      return { record_id: recordId, status: 'skipped', reason: 'already_present', scan_url: scanUrl };
    }
    if (existing.length) {
      // ⭐ 覆盖前先留证据（业务负责人的口径）。
      logInfo('product.tag_qr.overwriting', {
        record_id: recordId,
        reason,
        existing_file_tokens: existing.map((item) => item.file_token),
        existing_file_names: existing.map((item) => item.name),
        expected_file_name: fileName,
      });
    }

    let png;
    try {
      png = await generatePng(scanUrl, config.qr);
    } catch (error) {
      logError('product.tag_qr.failed', { record_id: recordId, reason, step: 'generate', error: error.message });
      throw error;
    }
    const tempDir = await fs.promises.mkdtemp(path.join(config.temp.dir, config.temp.prefix));
    try {
      const filePath = path.join(tempDir, fileName);
      await fs.promises.writeFile(filePath, png);
      let fileToken;
      try {
        fileToken = await gateway.uploadAttachment(filePath, {
          parentType: config.upload.parentType,
          operation: config.upload.operation,
        });
      } catch (error) {
        logError('product.tag_qr.failed', { record_id: recordId, reason, step: 'upload', error: error.message });
        throw error;
      }
      if (!fileToken) {
        const error = new Error('上传标签二维码成功但未返回 file_token');
        logError('product.tag_qr.failed', { record_id: recordId, reason, step: 'upload', error: error.message });
        throw error;
      }
      try {
        // 附件字段写法（官方 FAQ）：`[{ file_token }]`。
        await gateway.update('product', recordId, { [config.fields.tagQrCode]: [{ file_token: fileToken }] });
        // 改了货品 ⇒ 作废扫码页「货品信息」内存快照（只作废货品那一份）。
        invalidateLiveInventorySnapshot('product_tag_qr_written', { tableKey: 'product' });
      } catch (error) {
        logError('product.tag_qr.failed', {
          record_id: recordId, reason, step: 'write_back', file_token: fileToken, error: error.message,
        });
        throw error;
      }
      logInfo('product.tag_qr.written', {
        record_id: recordId, reason, file_token: fileToken, file_name: fileName,
        scan_url: scanUrl, bytes: Buffer.isBuffer(png) ? png.length : undefined,
        overwritten: existing.length > 0,
      });
      return {
        record_id: recordId, status: 'written', reason,
        file_token: fileToken, file_name: fileName, scan_url: scanUrl,
      };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /**
   * 表变更事件入口：**只认「新增」**（业务负责人 2026-11-11：「只需要盯着创建记录，
   * 编辑/更新都不需要了，也不需要定时任务」）。
   * 逐条 try/catch：一条失败不带走同一包里的其他记录；失败汇总 `batch_failed`。
   */
  const handleTableChanges = async (actionList) => {
    if (config.enabled !== true) {
      logInfo('product.tag_qr.disabled', { action_count: (actionList || []).length });
      return { enabled: false, results: [] };
    }
    const results = [];
    const failed = [];
    for (const actionItem of Array.isArray(actionList) ? actionList : []) {
      const recordId = actionItem?.record_id;
      const action = actionItem?.action;
      if (!recordId) continue;
      if (!config.events.created.includes(action)) continue; // 修改/删除等动作都不处理
      try {
        results.push(await syncRecord(recordId, { reason: 'record_added' }));
      } catch (error) {
        failed.push({ record_id: recordId, action, error: error.message });
        logError('product.tag_qr.record_failed', { record_id: recordId, action, error: error.message });
      }
    }
    if (failed.length) logError('product.tag_qr.batch_failed', { failed_count: failed.length, failed });
    return { enabled: true, results, failed };
  };

  return {
    buildFileName: (recordId) => fileNameOf(recordId),
    resolveQrIdentity: ({ recordId }) => ({
      url: recordId ? scanUrlOf(recordId) : '', identity: 'record_id',
      value: String(recordId ?? '').trim(),
    }),
    syncRecord,
    handleTableChanges,
  };
};

module.exports = {
  createTagQrCodeService,
  buildRecordIdScanUrl,
  buildFileName,
  attachmentsOf,
  findFieldValue,
  generateQrPng,
};
