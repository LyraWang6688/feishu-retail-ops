'use strict';

/**
 * 「货品信息.样例图」→ 云盘文件夹 自动同步（业务负责人 2026-11-10 指令）。
 *
 * 她本轮口径（逐字）：
 *   「是的，就是这个时候把样例图写入到云盘里，**但只有新增的时候**，
 *     然后需要把**那个复选框勾选上**」
 *
 * 来源与背景：
 *   · `docs/task-sample-image-drive-sync-2026-10-13.md`（她 2026-10-13 交办的任务底稿）；
 *   · issue #629「自动同步样例图到云盘」（OPEN）；
 *   · 事件入口：`routes/larkEvents.js` 的 `drive.file.bitable_record_changed_v1`（货品信息分支）。
 *
 * ── 这条链路做什么 ───────────────────────────────────────────────────────
 *   1. 只处理**新增**（`record_added`，见 `config/sampleImageDrive.js` 的 `events`）；
 *   2. 读该货品记录 → 取「样例图」附件（0 张就跳过，**不勾复选框**）；
 *   3. 逐张：下载素材（`gateway.downloadMedia`）→ 上传到云盘文件夹
 *      （`gateway.uploadDriveFile`，`parent_type=explorer`）；
 *      · 命名 = `{货号}{颜色}` + 后缀（多张加 `-1` `-2`）—— 规则全在 config；
 *      · 同名已存在 ⇒ 按 `overwrite`（默认 `replace`：先删同名再传，不堆重复）；
 *   4. **全部成功**后把「已同步云盘」复选框勾上（`gateway.update`）——
 *      ⭐ 它既是"她一眼看进度"的标记，也是**幂等判据**（已勾 ⇒ 再触发也不重复传）；
 *   5. 任何一步失败 ⇒ 记 `product.sample_image.drive.failed`，**不勾复选框**，留待补跑。
 *
 * ── 边界 / 红线 ──────────────────────────────────────────────────────────
 *   🔴 只上传「样例图」，**不碰**「标签二维码」或任何别的附件（附件类型先过筛）；
 *   🔴 不删云盘里"不是我们按命名模板生成"的文件（只删同名的那一个）；
 *   🔴 成本等内部字段一个都不进云盘（文件名只用货号 + 颜色，内容只有图片字节）；
 *   🔴 官方限制：drive 上传 **5 QPS / 10000 次每天，且不支持并发** ⇒ 本 service **串行**处理；
 *   🔴 存量 184 条"有图未勾"的批量补齐**不在本轮**（另开脚本；仍按"先干跑再动手"纪律）。
 *
 * ⚠️ 与「标签二维码」是**两条独立链路**（各自 config / 各自 service / 同一个事件入口分派两次），
 *    改一条不会影响另一条。
 */

const path = require('node:path');

const { logInfo, logWarn, logError } = require('../utils/logger');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SAMPLE_IMAGE_DRIVE } = require('../config/sampleImageDrive');
// ⭐ 2026-11-13：读记录遇飞书 1254607 / 5xx / 限流时**就地短重试**（单条事件链路没人替它重跑）
const { withTransientRetry, resolveTransientRetryConfig } = require('../config/pushRetry');

const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic']);
/**
 * 取纯文本：字符串 / 富文本数组（飞书公式列！例 `[{ text: '66888|黑色|男', type: 'text' }]`）/
 * 富文本对象（`{ text }`）/ 关联字段数组（`[{ text }]`）都能解。
 *
 * 🔴 2026-11-10 真机事故：公式列「编号」返回的是**富文本数组**，旧实现直接 `String(value)`
 *    ⇒ 文件名变成 `[object Object].jpeg`（343 条全撞同一个名字、互相覆盖）。
 *    本条判据 AC-SD13 钉住：塞回数组形状必须解出正确名字。
 */
const textOf = (value) => {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map((item) => textOf(item?.text ?? item?.name ?? '')).join('').trim();
  }
  if (typeof value === 'object') return textOf(value.text ?? value.name ?? value.value ?? '');
  return String(value).trim();
};

/** 关联字段（颜色）取可读文本：`[{ text: '黑色', ... }]` / `{ text }` / 纯字符串都兼容。 */
const linkedTextOf = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (item === null || item === undefined) return '';
      if (typeof item === 'string') return item;
      return textOf(item.text ?? item.name ?? '');
    }).join('');
  }
  if (value && typeof value === 'object') return textOf(value.text ?? value.name ?? '');
  return textOf(value);
};

/** 把非法字符换成 `_`，并裁到配置里的最长长度（不改变可读性）。 */
const sanitizeFileName = (value, naming) => {
  let name = textOf(value);
  for (const char of naming.illegalChars || []) name = name.split(char).join(naming.replacement);
  // 兼容 Windows 保留字符 / 首尾空格
  name = name.replace(/\s+/g, ' ').trim();
  const maxLength = Number(naming.maxLength) > 0 ? Number(naming.maxLength) : 0;
  return maxLength && name.length > maxLength ? name.slice(0, maxLength) : name;
};

/** 从附件名取图片扩展名；不是图片扩展名就退回配置里的缺省（`.jpg`）。 */
const extensionOf = (sourceName, naming) => {
  const ext = path.extname(textOf(sourceName)).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext) ? ext : naming.fallbackExtension;
};

/**
 * 云盘文件名（**纯函数**，单测直接钉）：
 *   · 单张：`{货号}{颜色}.jpg`
 *   · 多张：`{货号}{颜色}-1.jpg` / `-2` …（序号从 1 开始）
 *   ⚠️ 模板里 `{itemNo}` / `{color}` 来自 config；索引后缀来自 `naming.multiSuffix`。
 */
const buildFileName = ({ number, index, total, sourceName, naming = SAMPLE_IMAGE_DRIVE.naming }) => {
  // ⭐ 2026-11-10（业务负责人）：「用编号」—— 编号 = `货号|颜色|类别`，`|` 换成 numberSeparator（默认 `_`）。
  //   ⚠️ **不做货号+颜色兜底**：编号为空 ⇒ 返回 `''`，调用方会「重试直到有编号」（或跳过）。
  const separator = String(naming.numberSeparator ?? '_');
  const numberParts = textOf(number).split('|').map((part) => part.trim()).filter(Boolean);
  if (!numberParts.length) return '';
  const base = numberParts.join(separator);
  const suffix = total > 1 ? String(naming.multiSuffix || '-{index}').replace(/\{index\}/g, String(index)) : '';
  return `${sanitizeFileName(`${base}${suffix}`, naming)}${extensionOf(sourceName, naming)}`;
};

/** 附件是不是图片（类型前缀 `image/`，或文件名是图片扩展名）。 */
const isImageAttachment = (attachment) => {
  const type = textOf(attachment?.type).toLowerCase();
  if (type.startsWith('image/')) return true;
  const ext = path.extname(textOf(attachment?.name)).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
};

/**
 * @param {object} options
 * @param {object} options.gateway  V1BitableGateway（或测试替身）
 * @param {object} [options.config] 覆盖 `SAMPLE_IMAGE_DRIVE`（单测注入；生产用默认）
 */
const createSampleImageDriveService = ({
  gateway, config = SAMPLE_IMAGE_DRIVE, sleep, retrySleep,
} = {}) => {
  if (!gateway) throw new Error('样例图云盘同步缺少 gateway');
  // ⭐ 云盘层由网关构造器挂载（`services/driveApi.js`）⇒ 服务只认 `gateway.drive`。
  //   ⚠️ 构造时**不抛**：很多测试/脚本只装配了"点表"那一半的网关替身（不跑云盘链路），
  //      构造就抛会让它们一起挂；真缺失在**第一次要传时**如实报 failed（见 syncRecord）。
  const drive = gateway.drive || null;

  const productTable = V1_BITABLE_SCHEMA.tables.product;
  const fieldNames = productTable.fields;
  const itemNoField = fieldNames.itemNo;
  const colorField = fieldNames.color;
  const categoryField = fieldNames.category;
  const numberField = fieldNames.number;
  const sampleImageField = fieldNames[config.fields.sampleImage];
  const syncedField = fieldNames[config.fields.synced];

  // 契约缺失 ⇒ 当场抛（否则每次触发都变成运行时"未配置语义字段"）
  if (!sampleImageField) {
    throw new Error('「货品信息」schema 里没有 sampleImage 字段映射（应为「样例图」附件列）');
  }
  if (!syncedField) {
    throw new Error('「货品信息」schema 里没有 sampleImageSynced 字段映射（应为「已同步云盘」复选框列）');
  }

  const sleepFn = typeof sleep === 'function' ? sleep : ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // ⭐ 2026-11-13：读记录瞬时重试配置（次数/退避来自 config；默认 4 次 ≈22s）
  const readRetryConfig = {
    ...resolveTransientRetryConfig(),
    maxRetries: Number(config.readRetry?.maxRetries ?? 4),
    baseDelayMs: Number(config.readRetry?.baseDelayMs ?? 1500),
    factor: 2,
  };
  const readRecord = (recordId) => withTransientRetry(
    () => gateway.get('product', recordId),
    {
      operation: 'sample_image.read_record',
      config: readRetryConfig,
      ...(typeof retrySleep === 'function' ? { sleep: retrySleep } : {}),
    },
  );
  const folderToken = textOf(config.folder?.token);
  const naming = config.naming || SAMPLE_IMAGE_DRIVE.naming;
  const ops = config.operations || SAMPLE_IMAGE_DRIVE.operations || {};

  /** 解析这一条记录的文件名主体：优先 货号 + 颜色；缺了就退回「编号」拆段（不猜）。 */
  const nameBaseOf = (fields) => {
    const number = textOf(fields?.[numberField]);
    let itemNo = textOf(fields?.[itemNoField]);
    let color = linkedTextOf(fields?.[colorField]);
    let category = textOf(fields?.[categoryField]);
    // 「编号」= 货号|颜色|类别：源字段缺哪段就从编号里补（不猜、只补缺的）
    if ((!itemNo || !color || !category) && number) {
      const parts = number.split('|').map((part) => part.trim());
      if (!itemNo) itemNo = parts[0] || '';
      if (!color) color = parts[1] || '';
      if (!category) category = parts[2] || '';
    }
    return { number, itemNo, color, category };
  };

  const owner = config.owner || {};

  const imagesOf = (fields) => {
    const value = fields?.[sampleImageField];
    const list = Array.isArray(value) ? value : [];
    return list.filter((item) => item && item.file_token && isImageAttachment(item));
  };

  const skip = (recordId, reason, extra = {}) => {
    logInfo('product.sample_image.drive.skipped', { record_id: recordId, reason, ...extra });
    return { record_id: recordId, status: 'skipped', reason };
  };

  /**
   * 同步一条货品（**串行**：一张一张传；上传接口不支持并发）。
   * 返回 `{ record_id, status: 'synced'|'skipped'|'failed', ... }`（不抛：事件分支不因单条失败中断）。
   */
  const syncRecord = async (recordId, { reason = 'record_added', waitForNumber = false } = {}) => {
    const id = textOf(recordId);
    if (!id) return { record_id: id, status: 'skipped', reason: 'record_id_missing' };
    if (!drive || typeof drive.uploadDriveFile !== 'function') {
      logError('product.sample_image.drive.failed', { record_id: id, reason, error: 'drive 层缺失（gateway.drive）' });
      return { record_id: id, status: 'failed', reason: 'drive_missing' };
    }
    try {
      let record = await readRecord(id);
      let fields = record?.fields || {};

      // 幂等：已勾「已同步云盘」⇒ 不再传（重复事件 / 重试都只会有一次）
      if (fields?.[syncedField] === true) return skip(id, 'already_synced');

      let images = imagesOf(fields);
      if (!images.length) return skip(id, 'no_sample_image');

      let nameBase = nameBaseOf(fields);
      // ⭐⭐ 2026-11-10（业务负责人）：「**重试直到有**（编号）」——新增瞬间公式可能还没算完。
      //   · 只在事件链路（waitForNumber=true）等；存量补齐里都是老记录，编号该有就有，不等。
      //   · 每次都**重读记录**（公式算完才会出现在字段里）；最多 attempts 次，间隔 intervalMs。
      const waitCfg = config.numberWait || { attempts: 0, intervalMs: 0 };
      const maxWait = Number(waitCfg.attempts) > 0 ? Number(waitCfg.attempts) : 0;
      let waited = 0;
      while (waitForNumber && !nameBase.number && waited < maxWait) {
        waited += 1;
        logInfo('product.sample_image.drive.number_pending', {
          record_id: id, attempt: waited, max_attempts: maxWait, interval_ms: Number(waitCfg.intervalMs) || 0,
        });
        await sleepFn(Number(waitCfg.intervalMs) || 0);
        record = await readRecord(id);
        fields = record?.fields || {};
        images = imagesOf(fields);
        nameBase = nameBaseOf(fields);
      }
      if (!nameBase.number) {
        // 等不到编号 ⇒ **不传无名文件、不勾**（等记录补全后由存量按钮补）
        logWarn('product.sample_image.drive.number_missing', {
          record_id: id, reason, waited, max_attempts: maxWait,
        });
        return skip(id, 'number_missing');
      }

      const maxImages = Number(config.maxImages) > 0 ? Number(config.maxImages) : 0;
      const targets = maxImages && images.length > maxImages ? images.slice(0, maxImages) : images;
      if (targets.length < images.length) {
        logWarn('product.sample_image.drive.truncated', {
          record_id: id, total: images.length, limit: maxImages, uploaded: targets.length,
        });
      }

      logInfo('product.sample_image.drive.started', {
        record_id: id, reason, sample_image_count: targets.length, item_no: nameBase.itemNo, color: nameBase.color, number: nameBase.number,
      });

      // 文件夹里已有的文件（一次列出；同名覆盖直接沿用这个快照）
      const existingFiles = await drive.listDriveFolder(folderToken, ops.list);
      const existingByName = new Map(
        (existingFiles || []).filter((file) => file?.name).map((file) => [file.name, file]),
      );

      const uploaded = [];
      for (let index = 0; index < targets.length; index += 1) {
        const attachment = targets[index];
        const fileName = buildFileName({
          ...nameBase, index: index + 1, total: targets.length, sourceName: attachment.name, naming,
        });

        const existing = existingByName.get(fileName);
        if (existing) {
          if (config.overwrite !== 'replace') {
            logInfo('product.sample_image.drive.name_exists', { record_id: id, file_name: fileName });
            continue;
          }
          // 同名覆盖：只删"跟我们命名完全一致"的那个文件（不碰她手工传的）
          await drive.deleteDriveFile(existing.token, ops.delete);
        }

        const content = await drive.downloadMedia(attachment.file_token, ops.download);
        const fileToken = await drive.uploadDriveFile({ folderToken, fileName, content, operation: ops.upload });
        // ⭐ 2026-11-10（业务负责人）：所有图片的所有者都固定成赵瑞玲 ⇒ 上传后立刻转移
        if (owner.openId || owner.email) {
          await drive.transferFileOwner(fileToken, { owner, operation: ops.transfer });
          logInfo('product.sample_image.drive.owner_transferred', {
            record_id: id, file_name: fileName, owner: owner.openId ? 'openid' : 'email',
          });
        }
        uploaded.push({ file_name: fileName, file_token: fileToken });
        logInfo('product.sample_image.drive.uploaded', {
          record_id: id, file_name: fileName, file_token: fileToken,
        });
      }

      // 全部成功才勾复选框（部分失败 ⇒ 不勾，留给补跑）
      if (uploaded.length !== targets.length) {
        logWarn('product.sample_image.drive.partial', {
          record_id: id, expected: targets.length, uploaded: uploaded.length,
        });
        return { record_id: id, status: 'partial', uploaded: uploaded.length, expected: targets.length };
      }

      await gateway.update('product', id, { [config.fields.synced]: true });
      logInfo('product.sample_image.drive.synced', { record_id: id, uploaded_count: uploaded.length });
      return { record_id: id, status: 'synced', uploaded: uploaded.length };
    } catch (error) {
      logError('product.sample_image.drive.failed', {
        record_id: id, reason, error: error?.message || String(error),
      });
      return { record_id: id, status: 'failed', reason, error: error?.message || String(error) };
    }
  };

  /**
   * 事件入口：`action_list` 来自 `drive.file.bitable_record_changed_v1`。
   * 只挑 `events.created` 里的动作（本轮 = 只有 `record_added`），其余动作**一眼都不看**。
   */
  const handleTableChanges = async (actionList) => {
    const createdActions = new Set(config.events?.created || []);
    const results = [];
    const failed = [];
    for (const actionItem of Array.isArray(actionList) ? actionList : []) {
      const recordId = actionItem?.record_id;
      const action = actionItem?.action;
      if (!recordId) continue;
      if (!createdActions.has(action)) continue;
      // ⭐ 事件链路：新增瞬间「编号」公式可能还没算完 ⇒ 等它出来再传（重试直到有）
      const result = await syncRecord(recordId, { reason: action, waitForNumber: true });
      results.push(result);
      if (result.status === 'failed') failed.push(result);
    }
    return { results, failed };
  };

  return {
    handleTableChanges,
    syncRecord,
    // 纯函数导出（单测直接钉命名口径；生产调用方别跳过 config）
    buildFileName: (parts) => buildFileName({ ...parts, naming }),
  };
};

module.exports = {
  createSampleImageDriveService,
  buildFileName,
  sanitizeFileName,
  extensionOf,
  isImageAttachment,
  linkedTextOf,
};
