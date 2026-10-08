/**
 * 货品信息「标签二维码」service —— **只干一件事**：
 * 让「货品信息.标签二维码」这一列跟着「编号」走。
 *
 * 一段流程，三步，全在 `syncRecord` 里：
 *   ① 用 `qrcode`（仓库已有依赖，不引新依赖）把**规范里的 URL** 生成 PNG；
 *   ② 把 PNG 上传到飞书素材库拿 `file_token`（`drive/v1/medias/upload_all`，
 *      `parent_type` / 文件名模板都来自 `config/tagQrCode.js`）；
 *   ③ `gateway.update('product', recordId, { tagQrCode: [{ file_token }] })` 写回**附件字段**。
 *
 * 为什么上传/写回都走 `gateway`：本仓只有 `V1BitableGateway` 认识飞书 API 与字段映射
 *   （它也已经有一条**生产验证过**的附件上传路径 `uploadAttachment`）。这一层只回答
 *   "出什么码、叫什么名、该不该写"，不自己 new 飞书客户端。
 *
 * 三条硬口径：
 *   · **幂等**：这一列**已经有值就跳过**（记 `product.tag_qr.skipped_existing`）；
 *     只有"显式要求覆盖"（编号变了 / 脚本带 `--overwrite`）才重写，
 *     而且**覆盖前先记一条 `product.tag_qr.overwriting`**（先留证据，再动手）。
 *   · **失败大声报错 + 可重试**：任何一步失败都 `logError('product.tag_qr.failed')` 并
 *     **抛出**（脚本据此计失败数、事件路径据此记 `dispatch_failed`）；不吞、不静默。
 *     ⚠️ 唯一的例外是"这条记录没有「编号」"——那不是故障，是"还没填"：
 *     记 `product.tag_qr.number_missing` 并**跳过**（重试一万次也生不出码来）。
 *   · **只有「编号」相关的变化才写**：其他字段变了不碰这一列（判定见 `resolveNumberChange`）。
 *
 * 编号变更怎么判（这是本轮唯一"拿不准"的地方，所以做成**三层**，一层判不了退下一层）：
 *   ① **事件里的字段值**（`action_list[].before_value` / `after_value`，含 `field_id`）：
 *      找到「编号」列的 `field_id`，两边取值不同 ⇒ 变了；两边都没有这一列 ⇒ 没变（不触发）。
 *   ② 事件里**根本没带**这一列的字段值（老版本推送 / 只推了其它列）⇒ 判不了，
 *      改为读一次记录：**现存附件的文件名 ≠ 当前编号该有的文件名** ⇒ 认定过期，重写。
 *      （文件名由编号决定、同一条记录每次一样，见 config 的 `fileName`。）
 *   ③ 连文件名都读不出来 ⇒ **不写**（宁可漏一次，也不盲写覆盖她表里的东西）。
 */
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { TAG_QR_CODE } = require('../config/tagQrCode');
const { textValue } = require('./v1BitableGateway');
const { logInfo, logWarn, logError } = require('../utils/logger');

const SCAN_URL_PLACEHOLDER = 'number';

/**
 * 把模板里的 `{number}` 换成**已 URL 编码**的编号。
 *
 * ⚠️ **只编码值、不编码模板**：模板里的 `https://`、`/s/` 必须原样保留
 *   （整体 encodeURIComponent 会把 `://` 也编掉，扫出来打不开）。
 * ⚠️ 模板里出现不认识的占位符、或**一个 `{number}` 都没有** ⇒ **当场抛错**。
 *   配置写错时不许静默生成一堆指向同一个地址的空码 —— 那种错最难发现。
 */
const buildScanUrl = (template, number, config = TAG_QR_CODE) => {
  const source = String(template ?? '');
  const values = { [SCAN_URL_PLACEHOLDER]: number };
  let replacedNumber = false;
  const encoded = source.replace(/\{(\w+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(
        `二维码 URL 模板里的占位符不认识：{${key}}（可用：{${SCAN_URL_PLACEHOLDER}}）`,
      );
    }
    replacedNumber = true;
    const value = values[key];
    return value === undefined || value === null ? '' : encodeURIComponent(String(value));
  });
  // 模板里**一个 `{number}` 都没有** ⇒ 每条记录都会生成同一个地址（"静默出空码"），当场拦住。
  if (!replacedNumber) {
    throw new Error(`二维码 URL 模板里没有 {${SCAN_URL_PLACEHOLDER}} 占位符：${source || '(空)'}`);
  }
  // 空编号生成出来的码扫开是 `/s/`，同样拦住。
  if (!String(number ?? '').trim()) {
    throw new Error('记录没有「编号」值，无法生成标签二维码');
  }
  return encoded;
};

/**
 * 这条记录的附件该叫什么名 —— 模板来自 config，值来自「编号」，非法字符替换掉。
 */
const buildFileName = (number, config = TAG_QR_CODE) => {
  const fileName = config.fileName;
  const safe = String(number ?? '').replace(fileName.invalidChars, fileName.replacement);
  const name = fileName.template.replace(`{${SCAN_URL_PLACEHOLDER}}`, safe);
  return name.length > fileName.maxLength ? name.slice(0, fileName.maxLength) : name;
};

/**
 * 从附件格的原始值里取出附件清单（`[{ file_token, name, … }]`）。
 * 只认有 `file_token` 的元素 —— 别的东西（文本、空值、关联）一律当"没有附件"。
 */
const attachmentsOf = (value) => {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .filter((item) => item && typeof item === 'object' && String(item.file_token || '').trim())
    .map((item) => ({ file_token: String(item.file_token).trim(), name: String(item.name || '') }));
};

/**
 * 在事件带的字段值数组里找某一列的取值。
 * 返回 `undefined` = 事件里**没有这一列**（与"有这一列但值为空"区分开）。
 * 取值形态是字符串（飞书自带），这里只做**相等比较**用，所以不做解析、不猜类型。
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
  const numberFieldName = productTable.fields[config.fields.number];
  const tagQrFieldName = productTable.fields[config.fields.tagQrCode];

  const ensureFieldNames = () => {
    if (!numberFieldName) {
      throw new Error('「货品信息」schema 里没有 number 字段映射（config.fields.number）');
    }
    if (!tagQrFieldName) {
      // 契约缺失时**当场抛**：否则每次写回都会变成"未配置语义字段"的运行时错误。
      throw new Error(
        '「货品信息」schema 里没有 tagQrCode 字段映射（应为「标签二维码」附件列，见 config/v1BitableSchema）',
      );
    }
  };
  ensureFieldNames();

  // 「编号」列的 field_id 只在第一次事件触发时查、之后复用（网关自己也有字段缓存）。
  let numberFieldIdPromise = null;
  const resolveNumberFieldId = async () => {
    if (typeof gateway?.listFields !== 'function') return '';
    if (!numberFieldIdPromise) {
      numberFieldIdPromise = gateway.listFields('product')
        .then((fields) => (fields || []).find((field) => field?.field_name === numberFieldName)?.field_id || '')
        .catch((error) => {
          // 查不到就退回"文件名校验"那一层，**不因此中断**；但要说清楚为什么少了一层判据。
          logWarn('product.tag_qr.field_id_unavailable', {
            field_name: numberFieldName, error: error.message,
          });
          return '';
        });
    }
    return numberFieldIdPromise;
  };

  /**
   * 判「编号」这一列在这一次变更里动没动。
   * @returns {Promise<true|false|null>} true=变了；false=没变（不触发）；
   *   null=事件里没带这一列的字段值，**判不了**（交给文件名那一层）。
   */
  const resolveNumberChange = async (actionItem) => {
    const fieldId = await resolveNumberFieldId();
    if (!fieldId) return null;
    const before = findFieldValue(actionItem?.before_value, fieldId);
    const after = findFieldValue(actionItem?.after_value, fieldId);
    if (before === undefined && after === undefined) return null;
    return String(before ?? '') !== String(after ?? '');
  };

  /**
   * 让一条货品记录的「标签二维码」与它的「编号」一致。
   *
   * @param {string} recordId
   * @param {object} [options]
   * @param {string} [options.reason]         日志用（record_added / number_changed / backfill …）
   * @param {true|false|null} [options.numberChanged]
   *   `true`    = 已经确定编号变了 ⇒ **覆盖**；
   *   `false` / 不传 = 走**幂等**：这一列有值就跳过（脚本 / 新增记录都用这一档）；
   *   `null`    = 判不了 ⇒ 只有在"现存附件的文件名与当前编号不符"时才覆盖。
   * @returns {Promise<{record_id, status, reason, file_token?, file_name?, scan_url?}>}
   *   `status` ∈ written | skipped；**失败一律抛错**（由调用方记日志/计失败数）。
   */
  const syncRecord = async (recordId, { reason = 'manual', numberChanged } = {}) => {
    if (!config.enabled) {
      logInfo('product.tag_qr.disabled', { record_id: recordId, reason });
      return { record_id: recordId, status: 'skipped', reason: 'disabled' };
    }
    const record = await gateway.get('product', recordId);
    const fields = record?.fields || {};
    const number = textValue(fields[numberFieldName]).trim();
    if (!number) {
      // 「还没填编号」不是故障：记一条 warn 就跳过（重试也不会变）。
      logWarn('product.tag_qr.number_missing', { record_id: recordId, reason });
      return { record_id: recordId, status: 'skipped', reason: 'number_missing' };
    }

    const scanUrl = buildScanUrl(config.scanUrl.urlTemplate, number, config);
    const fileName = buildFileName(number, config);
    const existing = attachmentsOf(fields[tagQrFieldName]);

    if (existing.length) {
      const staleByFileName = numberChanged === null
        && !existing.some((item) => item.name === fileName);
      const overwrite = numberChanged === true || staleByFileName;
      if (!overwrite) {
        logInfo('product.tag_qr.skipped_existing', {
          record_id: recordId,
          reason,
          number,
          file_names: existing.map((item) => item.name),
        });
        return { record_id: recordId, status: 'skipped', reason: 'already_present', scan_url: scanUrl };
      }
      // ⭐ **先记日志，再覆盖**（业务负责人的口径：覆盖时先留证据）。
      logInfo('product.tag_qr.overwriting', {
        record_id: recordId,
        reason,
        number,
        existing_file_tokens: existing.map((item) => item.file_token),
        existing_file_names: existing.map((item) => item.name),
        expected_file_name: fileName,
        stale_by_file_name: staleByFileName,
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
        // 附件字段的写法（官方 FAQ「如何在多维表格中上传附件」）：`[{ file_token }]`。
        await gateway.update('product', recordId, { [config.fields.tagQrCode]: [{ file_token: fileToken }] });
      } catch (error) {
        logError('product.tag_qr.failed', {
          record_id: recordId, reason, step: 'write_back', file_token: fileToken, error: error.message,
        });
        throw error;
      }
      logInfo('product.tag_qr.written', {
        record_id: recordId,
        reason,
        number,
        file_token: fileToken,
        file_name: fileName,
        scan_url: scanUrl,
        bytes: Buffer.isBuffer(png) ? png.length : undefined,
        overwritten: existing.length > 0,
      });
      return {
        record_id: recordId, status: 'written', reason, file_token: fileToken, file_name: fileName, scan_url: scanUrl,
      };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /**
   * 表变更事件入口：`routes/larkEvents.js` 把**货品信息**那张表的 `action_list` 原样交进来。
   *
   * ⚠️ **逐条 try/catch**：一条失败不能带走同一包里的其他记录（飞书一次推送常带好几条）。
   *    失败全部 `logError`，最后再补一条汇总 `product.tag_qr.batch_failed` —— 大声、可重试。
   * ⚠️ **串行**执行：事件量很小（一次表单提交几条），串行换来实现简单 + 不打满上传频控。
   */
  const handleTableChanges = async (actionList) => {
    if (!config.enabled) {
      logInfo('product.tag_qr.disabled', { action_count: (actionList || []).length });
      return { enabled: false, results: [] };
    }
    const results = [];
    const failed = [];
    for (const actionItem of Array.isArray(actionList) ? actionList : []) {
      const recordId = actionItem?.record_id;
      const action = actionItem?.action;
      if (!recordId) continue;
      const isCreated = config.events.created.includes(action);
      const isUpdated = config.events.updated.includes(action);
      if (!isCreated && !isUpdated) continue; // 删除等动作没有落点
      try {
        if (isCreated) {
          results.push(await syncRecord(recordId, { reason: 'record_added' }));
          continue;
        }
        const numberChanged = await resolveNumberChange(actionItem);
        if (numberChanged === false) {
          // ⭐ 其他字段变更**不触发**：连读表都不读，只记一条。
          logInfo('product.tag_qr.skipped_number_unchanged', { record_id: recordId, action });
          results.push({ record_id: recordId, status: 'skipped', reason: 'number_unchanged' });
          continue;
        }
        results.push(await syncRecord(recordId, {
          reason: numberChanged === true ? 'number_changed' : 'number_change_unknown',
          numberChanged,
        }));
      } catch (error) {
        failed.push({ record_id: recordId, action, error: error.message });
        logError('product.tag_qr.record_failed', { record_id: recordId, action, error: error.message });
      }
    }
    if (failed.length) {
      logError('product.tag_qr.batch_failed', { failed_count: failed.length, failed });
    }
    return { enabled: true, results, failed };
  };

  return {
    buildScanUrl: (number) => buildScanUrl(config.scanUrl.urlTemplate, number, config),
    buildFileName: (number) => buildFileName(number, config),
    resolveNumberChange,
    syncRecord,
    handleTableChanges,
  };
};

module.exports = {
  createTagQrCodeService,
  buildScanUrl,
  buildFileName,
  attachmentsOf,
  findFieldValue,
  generateQrPng,
};
