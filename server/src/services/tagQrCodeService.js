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
 *   · **幂等**：这一列**已经有值就跳过**（脚本/新增记录记 `product.tag_qr.skipped_existing`；
 *     事件那一路判不了、退化成比文件名之后**一致**的，记 `product.tag_qr.skipped_number_unchanged`）；
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
 *      ⭐ **只有"两边都读得出可比较的文本、且真的不同"才算变了**；
 *      **只有"两边都读得出、且完全相同"才算没变**（这一档才走快路径，省一次读）。
 *      🔴 **"读不出"绝不许当成"没变"** —— 见下面 2026-10-09 的真事。
 *   ② 判不了（事件没带这一列 / 值读不出可比文本，比如公式列推过来的是富文本数组或空值）
 *      ⇒ 读一次记录：**现存附件的文件名 ≠ 当前编号该有的文件名** ⇒ 认定过期，重写。
 *      （文件名由编号决定、同一条记录每次一样，见 config 的 `fileName`。）
 *   ③ 连文件名都读不出来 ⇒ **不写**（宁可漏一次，也不盲写覆盖她表里的东西）。
 *
 * 🔴 **2026-10-09 生产事故（本文件必须记住的教训）**：
 *   她在「货品信息」把一条记录的颜色由 `黑` 改成 `黑色`（编号 `3357|黑|B` → `3357|黑色|B`），
 *   日志却是 `product.tag_qr.skipped_number_unchanged` —— 二维码停在旧编号上，**被跳过了**。
 *   根因就在旧的第①层：`String(before ?? '') !== String(after ?? '')`。
 *   「编号」现在是**公式列**（`type=20`，内容 `货号|颜色|类别`），事件里推过来的
 *   `field_value` **不是一个普通字符串**（公式列在本仓别处也被证实是富文本数组 `[{text}]`，
 *   也可能是空值）⇒ `String()` 两边都变成同一个串（`'[object Object]'` / `''`）⇒
 *   判成"没变" ⇒ **永远轮不到第②层的文件名兜底** ⇒ 编号变了也不重生成。
 *   ⇒ 改法：把"值读不出可比文本"**显式判成 `null`（不确定）**，而不是 `false`（没变）。
 *
 * 🔴 **还有一层兜底**（同一天加）：`sweepStaleTagQrCodes` —— 不看事件、全表巡检
 *   「文件名 ≠ 当前编号应有文件名 ⇒ 重生成」，供 cron / scheduler 调用（见 `config.sweep`）。
 */
const fs = require('node:fs');
const path = require('node:path');
const QRCode = require('qrcode');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { TAG_QR_CODE } = require('../config/tagQrCode');
const { textValue } = require('./v1BitableGateway');
const { logInfo, logWarn, logError } = require('../utils/logger');
// ⭐ 2026-10-09：扫码页「货品信息」内存快照的跨模块失效（写标签二维码 = 改了货品）。
const { invalidateLiveInventorySnapshot } = require('./liveInventorySnapshot');

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

/**
 * 把事件里的 `field_value` 读成**能比较的文本**（`services/v1BitableGateway` 的 `textValue`
 * 的**严格版**：读不出就返回 `null` = "不确定"，**绝不返回空串冒充"没有值"**）。
 *
 * 🔴 为什么要这么写：飞书事件里的 `field_value` **不保证是普通字符串**——
 *   · **公式列**（「编号」`type=20`）在**记录 API** 里返回的就是富文本数组 `[{text:'…'}]`；
 *   · 事件里也可能是 `null`（这一列没被推过来）或空串（老版本 / 没带值）。
 *   旧实现直接 `String(value)`：数组/对象 ⇒ 两边都是 `'[object Object]'`、空值 ⇒ 两边都是 `''`
 *   ⇒ **"读不懂"被当成了"没变"** —— 这就是 2026-10-09 那次漏判（详见文件头）。
 *
 * @returns {string|null} 可比较的文本；`null` = 读不出（**判不了**，不是"没变"）
 */
const readableFieldText = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    // 富文本数组：`[{ text: '…' }, …]`；任何一段读不出就直接判"读不出"（不猜、不拼接半截）。
    const parts = value.map(readableFieldText);
    if (!parts.length || parts.some((part) => part === null)) return null;
    return parts.join(',');
  }
  if (value && typeof value === 'object') {
    const nested = value.text ?? value.name ?? value.value;
    if (typeof nested === 'string') return nested;
    if (typeof nested === 'number') return String(nested);
    return null;
  }
  return null; // null / undefined / 其他 ⇒ 不确定
};

/** 事件里的原始值裁成**短、可读**的一小段，只用于日志（这是这类漏判唯一的现场证据）。 */
const previewValue = (value) => {
  let text;
  try {
    text = value === undefined ? 'undefined' : (JSON.stringify(value) ?? String(value));
  } catch {
    text = String(value);
  }
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
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
   *
   * ⭐ **只有"读得出可比文本"才下结论**（2026-10-09 的漏判就死在这里）：
   *   · 两边都读得出、且**不同** ⇒ `true`（变了）；
   *   · 两边都读得出、且**相同**（都是非空文本）⇒ `false`（没变，可走快路径省一次读）；
   *   · **其余一律 `null`（判不了）** —— 事件没带这一列、值读不出（公式列的富文本数组、
   *     对象、`null`）、或任一侧是空串。**"不确定"绝不许当成"没变"。**
   *
   * @returns {Promise<{changed: true|false|null, why: string, before: *, after: *}>}
   */
  const resolveNumberChangeDetail = async (actionItem) => {
    const fieldId = await resolveNumberFieldId();
    if (!fieldId) {
      return { changed: null, why: 'field_id_unavailable', before: undefined, after: undefined };
    }
    const rawBefore = findFieldValue(actionItem?.before_value, fieldId);
    const rawAfter = findFieldValue(actionItem?.after_value, fieldId);
    const before = readableFieldText(rawBefore);
    const after = readableFieldText(rawAfter);
    if (before === null || after === null) {
      // 值读不出可比文本（`null` / 富文本数组 / 对象 / 这一列根本没被推过来）。
      return { changed: null, why: 'value_not_readable', before: rawBefore, after: rawAfter };
    }
    if (!before.trim() || !after.trim()) {
      // 任一侧是空串：多半是"这一列没被推过来"，**不是**"编号被清空了" ⇒ 判不了。
      return { changed: null, why: 'value_empty', before: rawBefore, after: rawAfter };
    }
    return { changed: before !== after, why: 'compared', before: rawBefore, after: rawAfter };
  };

  /**
   * @returns {Promise<true|false|null>} true=变了；false=**确定**没变（可走快路径）；
   *   null=判不了 ⇒ 交给"读一次记录 + 比文件名"那一层（**绝不当成"没变"**）。
   */
  const resolveNumberChange = async (actionItem) =>
    (await resolveNumberChangeDetail(actionItem)).changed;

  /**
   * 让一条货品记录的「标签二维码」与它的「编号」一致。
   *
   * @param {string} recordId
   * @param {object} [options]
   * @param {string} [options.reason]         日志用（record_added / number_changed / backfill …）
   * @param {true|false|null} [options.numberChanged]
   *   `true`    = 已经确定编号变了 ⇒ **覆盖**；
   *   `false` / 不传 = 走**幂等**：这一列有值就跳过（脚本 / 新增记录都用这一档）；
   *   `null`    = **判不了**（事件没带值 / 值读不出）⇒ 只有在"现存附件的文件名与当前编号不符"
   *               时才覆盖；名字对得上就跳过。⭐ **绝不许把"判不了"当"没变"**（2026-10-09 的教训）。
   * @returns {Promise<{record_id, status, reason, file_token?, file_name?, scan_url?}>}
   *   `status` ∈ written | skipped；**失败一律抛错**（由调用方记日志/计失败数）。
   *   ⚠️ 靠文件名判出过期而重写时，`reason` 一律记成 **`number_changed`**（事实如此）；
   *      判不了但比完**一致** ⇒ `number_unchanged`；脚本/新增那一路的幂等跳过 ⇒ `already_present`。
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

    // 「现存附件的文件名 ≠ 当前编号应有的文件名」= **事实上的编号变了**（只读一次就判得出，
    // 不依赖事件带没带前后值）。这一档才是 `numberChanged === null` 时的**唯一**判据。
    const staleByFileName = existing.length > 0
      && numberChanged === null
      && !existing.some((item) => item.name === fileName);
    // ⭐ 覆盖原因**如实**：靠文件名判出来的不匹配，就是 `number_changed`
    //   （而不是含混的 `number_change_unknown`）——日志/返回值里要能一眼看出是"改了"。
    const effectiveReason = staleByFileName ? 'number_changed' : reason;

    if (existing.length) {
      const overwrite = numberChanged === true || staleByFileName;
      if (!overwrite) {
        if (numberChanged === null) {
          // `numberChanged === null` 只可能来自**事件那一路**（判不了 ⇒ 退化成比文件名）：
          // 比完一致 ⇒ 结论就是"编号没变"，**如实记成 skipped_number_unchanged**
          //（与快路径同一个事件名；`verified_by` 说明这一次是靠文件名核出来的）。
          logInfo('product.tag_qr.skipped_number_unchanged', {
            record_id: recordId,
            verified_by: 'file_name',
            number,
            file_names: existing.map((item) => item.name),
          });
          return { record_id: recordId, status: 'skipped', reason: 'number_unchanged', scan_url: scanUrl };
        }
        logInfo('product.tag_qr.skipped_existing', {
          record_id: recordId,
          reason: effectiveReason,
          number,
          file_names: existing.map((item) => item.name),
        });
        return { record_id: recordId, status: 'skipped', reason: 'already_present', scan_url: scanUrl };
      }
      // ⭐ **先记日志，再覆盖**（业务负责人的口径：覆盖时先留证据）。
      logInfo('product.tag_qr.overwriting', {
        record_id: recordId,
        reason: effectiveReason,
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
      logError('product.tag_qr.failed', { record_id: recordId, reason: effectiveReason, step: 'generate', error: error.message });
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
        logError('product.tag_qr.failed', { record_id: recordId, reason: effectiveReason, step: 'upload', error: error.message });
        throw error;
      }
      if (!fileToken) {
        const error = new Error('上传标签二维码成功但未返回 file_token');
        logError('product.tag_qr.failed', { record_id: recordId, reason: effectiveReason, step: 'upload', error: error.message });
        throw error;
      }
      try {
        // 附件字段的写法（官方 FAQ「如何在多维表格中上传附件」）：`[{ file_token }]`。
        await gateway.update('product', recordId, { [config.fields.tagQrCode]: [{ file_token: fileToken }] });
        // ⭐ 2026-10-09：改了货品（写标签二维码附件）⇒ 作废扫码页那份「货品信息」内存快照
        //   （**只作废货品那一份**：写附件不影响库存）。
        invalidateLiveInventorySnapshot('product_tag_qr_written', { tableKey: 'product' });
      } catch (error) {
        logError('product.tag_qr.failed', {
          record_id: recordId, reason: effectiveReason, step: 'write_back', file_token: fileToken, error: error.message,
        });
        throw error;
      }
      logInfo('product.tag_qr.written', {
        record_id: recordId,
        reason: effectiveReason,
        number,
        file_token: fileToken,
        file_name: fileName,
        scan_url: scanUrl,
        bytes: Buffer.isBuffer(png) ? png.length : undefined,
        overwritten: existing.length > 0,
      });
      return {
        record_id: recordId,
        status: 'written',
        reason: effectiveReason,
        file_token: fileToken,
        file_name: fileName,
        scan_url: scanUrl,
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
        const detail = await resolveNumberChangeDetail(actionItem);
        const numberChanged = detail.changed;
        if (numberChanged === false) {
          // ⭐ 只有**确定**没变才走快路径（其他字段变更）：连读表都不读，只记一条。
          logInfo('product.tag_qr.skipped_number_unchanged', { record_id: recordId, action });
          results.push({ record_id: recordId, status: 'skipped', reason: 'number_unchanged' });
          continue;
        }
        if (numberChanged === null) {
          // ⭐⭐ **判不了 ≠ 没变**（2026-10-09 就是在这里漏判的）：退化到"读一次记录、比文件名"。
          //    把事件里的原始值一并记下来 —— 这是这类漏判**唯一**的现场证据。
          logInfo('product.tag_qr.number_change_unknown', {
            record_id: recordId,
            action,
            why: detail.why,
            before_value: previewValue(detail.before),
            after_value: previewValue(detail.after),
          });
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

  /**
   * ⭐ **兜底巡检**（2026-10-09 加，供 cron / scheduler 调用；本函数**不挂定时器**）。
   *
   * 干什么：**不看事件**，只认**当前事实** —— `gateway.listAll('product')` 读全表，
   * 逐条用**同一个** `buildFileName`（不抄第二份规则）算出"这条记录当前编号应有的文件名"：
   *   · 附件名里**有一个对得上** ⇒ 不动它（`consistent`）；
   *   · 有附件但对不上 ⇒ 重生成（`stale`）；**一个附件都没有** ⇒ 按"要补"处理（`missing`）；
   *   · 没有「编号」⇒ 跳过（生不出码来，不是故障）。
   * ⇒ 正好补住事件那条路**万一判漏**留下的过期二维码（2026-10-09 生产就漏了一条）。
   *
   * ⚠️ **不复用别处的判据**：文件名规则只有 `buildFileName` 一处真源；
   *    真正写回还是走 `syncRecord`（幂等、先记 `overwriting` 再动手、失败抛错都在那儿）。
   * ⚠️ **上限 / 间隔 / 开关全在 `config.sweep`**（`enabled` / `limit` / `intervalMs` / `dryRun`），
   *    这里一个数字都不写死；三个参数也可以由调用方显式覆盖（定时任务想跑小批时用）。
   * ⚠️ **一条失败不带走别的**：逐条 try/catch，失败进 `failed` 并 `logError`（大声、可重跑）。
   *
   * @param {object} [options]
   * @param {number} [options.limit]       单次最多处理多少条（>0 时覆盖 config；0 = 不限）
   * @param {number} [options.intervalMs]  每条之间的间隔（毫秒，覆盖 config）
   * @param {boolean} [options.dryRun]     干跑：只报告要修哪些，一个字都不写
   * @returns {Promise<{enabled, dry_run, scanned, consistent, number_missing,
   *   candidates, planned, written, skipped, failed, results}>}
   */
  const sweepStaleTagQrCodes = async ({ limit, intervalMs, dryRun } = {}) => {
    // 整条链路关掉时，巡检也不该动（否则会为每一条都跑一遍 syncRecord 再各自记一条 disabled）。
    if (config.enabled !== true) {
      logInfo('product.tag_qr.disabled', { reason: 'sweep' });
      return { enabled: false, dry_run: true, results: [] };
    }
    const sweepConfig = config.sweep || {};
    if (sweepConfig.enabled !== true) {
      logInfo('product.tag_qr.sweep_disabled', {});
      return { enabled: false, dry_run: true, results: [] };
    }
    if (typeof gateway?.listAll !== 'function') {
      // 网关不支持整表读 ⇒ 巡检根本跑不起来。**当场抛**，不要"安静地什么都没做"。
      throw new Error('网关不支持 listAll，「标签二维码」巡检无法扫全表');
    }
    const configuredLimit = Number.isInteger(sweepConfig.limit) && sweepConfig.limit > 0
      ? sweepConfig.limit : 0;
    const maxRecords = Number.isInteger(limit) && limit > 0 ? limit : configuredLimit;
    const configuredGap = Number.isFinite(sweepConfig.intervalMs) && sweepConfig.intervalMs > 0
      ? sweepConfig.intervalMs : 0;
    const gapMs = Number.isFinite(intervalMs) && intervalMs >= 0 ? intervalMs : configuredGap;
    // `dryRun` 缺省看 config；config 里也没有 `sweep.dryRun` 这个键时**按干跑**（最保守）。
    const isDryRun = dryRun === undefined ? sweepConfig.dryRun !== false : Boolean(dryRun);

    const records = await gateway.listAll('product');
    const candidates = [];
    let consistent = 0;
    let numberMissing = 0;
    for (const record of records || []) {
      const recordId = record?.record_id;
      if (!recordId) continue;
      const number = textValue(record?.fields?.[numberFieldName]).trim();
      if (!number) { numberMissing += 1; continue; }
      const expectedFileName = buildFileName(number, config);
      const existing = attachmentsOf(record?.fields?.[tagQrFieldName]);
      if (existing.length && existing.some((item) => item.name === expectedFileName)) {
        consistent += 1;
        continue;
      }
      candidates.push({
        record_id: recordId,
        number,
        expected_file_name: expectedFileName,
        existing_file_names: existing.map((item) => item.name),
        kind: existing.length ? 'stale' : 'missing',
      });
    }
    const planned = maxRecords > 0 ? candidates.slice(0, maxRecords) : candidates;
    const summary = {
      enabled: true,
      dry_run: isDryRun,
      scanned: (records || []).length,
      consistent,
      number_missing: numberMissing,
      candidates: candidates.length,
      planned: planned.length,
      written: 0,
      skipped: 0,
      failed: [],
      results: [],
    };

    if (isDryRun) {
      logInfo('product.tag_qr.sweep_dry_run', {
        scanned: summary.scanned,
        consistent,
        number_missing: numberMissing,
        candidates: candidates.length,
        planned: planned.length,
        record_ids: planned.slice(0, 20).map((item) => item.record_id),
      });
      summary.results = planned.map((item) => ({ ...item, status: 'dry_run' }));
      return summary;
    }

    for (let index = 0; index < planned.length; index += 1) {
      const item = planned[index];
      // 上传素材 5 QPS 且不支持并发 ⇒ 串行 + 间隔。
      if (index > 0 && gapMs > 0) {
        await new Promise((resolve) => { setTimeout(resolve, gapMs); });
      }
      try {
        // 巡检已经按**同一个** `buildFileName` 判过期 ⇒ 直接要求覆盖（reason 标明来源是巡检）。
        const result = await syncRecord(item.record_id, { reason: 'sweep_stale', numberChanged: true });
        summary.results.push(result);
        if (result.status === 'written') summary.written += 1;
        else summary.skipped += 1;
      } catch (error) {
        summary.failed.push({ record_id: item.record_id, error: error.message });
      }
    }
    logInfo('product.tag_qr.sweep_done', {
      scanned: summary.scanned,
      consistent,
      number_missing: numberMissing,
      candidates: candidates.length,
      planned: planned.length,
      written: summary.written,
      skipped: summary.skipped,
      failed_count: summary.failed.length,
    });
    if (summary.failed.length) {
      logError('product.tag_qr.sweep_failed', {
        failed_count: summary.failed.length,
        failed: summary.failed,
      });
    }
    return summary;
  };

  return {
    buildScanUrl: (number) => buildScanUrl(config.scanUrl.urlTemplate, number, config),
    buildFileName: (number) => buildFileName(number, config),
    resolveNumberChange,
    resolveNumberChangeDetail,
    syncRecord,
    handleTableChanges,
    sweepStaleTagQrCodes,
  };
};

module.exports = {
  createTagQrCodeService,
  buildScanUrl,
  buildFileName,
  attachmentsOf,
  findFieldValue,
  readableFieldText,
  generateQrPng,
};
