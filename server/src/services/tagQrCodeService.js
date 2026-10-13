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
// ⭐ 2026-10-12：事件判"没变/判不了"时的**延迟复核**（真机根因：公式列延迟 ⇒ 没有人再复核）

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
 * ⭐⭐ 2026-10-12：**新格式**（记录 ID）的 URL 构造 —— 与旧格式**各自独立**、各有各的守卫。
 * 为什么独立：编号版有"空编号 ⇒ 拦住"的语义；记录 ID 版同形（空 id ⇒ 拦住），
 * 两条路的报错文案也各自准确（不要把两者混成一条函数，否则守卫语义会互相污染）。
 */
const buildRecordIdScanUrl = (recordId, config = TAG_QR_CODE) => {
  const source = String(config?.scanUrl?.recordIdTemplate ?? '');
  const marker = '{recordId}';
  if (!source.includes(marker)) {
    throw new Error(`二维码 URL 模板里没有 {recordId} 占位符：${source || '(空)'}`);
  }
  const id = String(recordId ?? '').trim();
  if (!id) throw new Error('记录没有 record_id，无法生成标签二维码');
  const encoded = source.split(marker).join(encodeURIComponent(id));
  // 除 {recordId} 外不许有别的占位符（写错就当场抛，不静默出空码）
  const rest = encoded.replace(encodeURIComponent(id), '');
  const stray = rest.match(/\{(\w+)\}/);
  if (stray) {
    throw new Error(`二维码 URL 模板里的占位符不认识：{${stray[1]}}（可用：{recordId}）`);
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
 * ⭐⭐ 从附件名里**反解出编号**（按配置的文件名模板）——「**以编号为准**」那一层判据。
 *
 * 为什么需要它（业务负责人 2026-10-12 的口径）：**附件名只是辅助**，真正要问的是
 * "这张码的编号 == 当前编号吗"。而这张码是我们自己按 `fileName.template`（`tag-qr-{number}.png`）
 * 传上去的 —— 所以从名字里**按模板抠出编号那一段**，比"整串名字逐字相等"更贴近语义：
 *   · `tag-qr-2635-1_黑_A.png`    ⇒ 抠出 `2635-1_黑_A` == 当前编号 ✅ 已同步；
 *   · `tag-qr-QPL2635-1_黑_A.png` ⇒ 抠出 `QPL2635-1_黑_A` ≠ 当前编号 ⇒ **旧码**（真机那 5 条）；
 *   · 名字被人手工改过前后缀（模板对不上）⇒ 抠不出 ⇒ **判为过期**（重写成规范名，宁严不松）。
 * ⚠️ 反解是**有损**的（编号里的 `|` 等非法字符在上传时被换成了 `_`）⇒ 比较时两边都做同一次替换。
 * 🔴 **不许退化成 `name.includes(number)`**：`tag-qr-QPL2635-1_黑_A.png` **确实包含**
 *    `2635-1_黑_A` —— 那样会把旧码当成"已同步"（真机就是这么漏的）。
 *
 * ⚠️ 为什么不直接核"二维码 URL 里的编号"：附件格里只有 `{file_token, name}`，**没有 URL**；
 *    要核 URL 只能**下载附件再解码二维码**（仓库里的 `qrcode` 只能编码、不能解码）⇒ 要引新依赖。
 *    ⇒ 名字是我们上传时按模板定的，反解编号在语义上等价，且不引依赖（业务负责人已确认）。
 */
const numberFromFileName = (name, config = TAG_QR_CODE) => {
  const template = String(config?.fileName?.template || '');
  const marker = `{${SCAN_URL_PLACEHOLDER}}`;
  const at = template.indexOf(marker);
  if (at < 0) return null;
  const prefix = template.slice(0, at);
  const suffix = template.slice(at + marker.length);
  const text = String(name ?? '');
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return null;
  const middle = text.slice(prefix.length, text.length - suffix.length);
  return middle || null;
};

/** 编号 → 写进文件名时用的"安全形态"（与 `buildFileName` 同一套替换，供反解后比较）。 */
const sanitizeNumberForFileName = (number, config = TAG_QR_CODE) => String(number ?? '')
  .replace(config?.fileName?.invalidChars || /[\\/:*?"<>|]/g, config?.fileName?.replacement || '_');

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
  setTimer,
  clearTimer,
} = {}) => {
  const productTable = V1_BITABLE_SCHEMA.tables.product;
  /** 源字段的语义键 → 物理列名（配置里 `numberAssembly.fields` 用的是这些键） */
  const fieldNames = productTable.fields;
  let fieldIdsPromise = null;
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
   * ⭐⭐ **源字段判据**（2026-10-12 业务负责人提的：别只盯公式列的「编号」）。
   *
   * 她的原话：「那为什么你要去校验货品信息里面的编号呢？**不直接校验货号或者颜色有没有变化呢**？
   *            是不是更快一些？因为一般就是货号和颜色呀」
   * ⇒ 工程理由：**「编号」是飞书公式列 ⇒ 有延迟**（实测量到几秒~十几秒），而**货号/颜色/类别是源字段**，
   *    事件里拿到的就是新值 ⇒ **没有延迟**、判得更准也更快。公式列只留作"兜底判据"。
   *
   * @returns {Promise<{changed: true|false|null, why: string, changed_fields: string[],
   *   compared: object, unreadable: string[]}>}
   */
  const resolveSourceChangeDetail = async (actionItem) => {
    const keys = (config.numberAssembly?.fields || []).filter((key) => fieldNames[key]);
    const ids = await resolveFieldIds(keys);
    const changedFields = [];
    const compared = {};
    const unreadable = [];
    for (const key of keys) {
      const fieldId = ids[key];
      if (!fieldId) { unreadable.push(key); continue; }
      const before = readableFieldText(findFieldValue(actionItem?.before_value, fieldId));
      const after = readableFieldText(findFieldValue(actionItem?.after_value, fieldId));
      compared[key] = { before: previewValue(before), after: previewValue(after) };
      if (before === null || after === null || !before.trim() || !after.trim()) { unreadable.push(key); continue; }
      if (before !== after) changedFields.push(key);
    }
    if (changedFields.length) {
      return { changed: true, why: 'source_field_changed', changed_fields: changedFields, compared, unreadable };
    }
    if (unreadable.length) {
      // 有字段判不了 ⇒ 整体"判不了"（**绝不当成"没变"**，2026-10-09 的教训）
      return { changed: null, why: 'source_field_unreadable', changed_fields: [], compared, unreadable };
    }
    return { changed: false, why: 'source_fields_unchanged', changed_fields: [], compared, unreadable };
  };

  /** 三个源字段的 field_id（懒加载一次，和「编号」那条一样）。 */
  const resolveFieldIds = async (keys) => {
    if (typeof gateway?.listFields !== 'function') return {};
    if (!fieldIdsPromise) {
      fieldIdsPromise = gateway.listFields('product')
        .then((fields) => {
          const byName = new Map((fields || []).map((field) => [field?.field_name, field?.field_id]));
          const map = {};
          for (const [key, name] of Object.entries(fieldNames)) if (byName.get(name)) map[key] = byName.get(name);
          return map;
        })
        .catch((error) => {
          logWarn('product.tag_qr.field_id_unavailable', { keys: keys.join(','), error: error.message });
          return {};
        });
    }
    return fieldIdsPromise;
  };

  /**
   * ⭐ 按**她公式的规则**（`货号|颜色|类别`，分隔符/顺序见 `config/tagQrCode.js` 的 `numberAssembly`）
   * 从记录字段里拼出「编号」——公式列读不出/为空时的**兜底**。
   * ⚠️ 任一源字段为空 ⇒ 返回 `''`（**不硬拼出 `a||c` 这种公式不会产出的串**）。
   */
  /**
   * ⭐ 逐段读源字段（诊断用）：返回 [{ key, value }] —— 顺序 = 她公式的顺序。
   * ⚠️ 2026-10-12 真机「印了过期公式值」复盘：原先只有"拼出来的整串"，
   *    **看不出是哪一段读空了**（类别是单选、颜色是关联字段 type 18 ⇒ 读成数组/对象时
   *    `textValue().trim()` 会得空串）⇒ 现在把**每段各自的值**也带出来，一条日志自证。
   */
  const assembleParts = (fields) => {
    const assembly = config.numberAssembly || {};
    return (assembly.fields || []).map((key) => ({
      key, value: textValue(fields[fieldNames[key]]).trim(),
    }));
  };

  const assembleNumber = (fields) => {
    const assembly = config.numberAssembly || {};
    const parts = assembleParts(fields).map((part) => part.value);
    if (!parts.length || parts.some((part) => !part)) return '';
    return parts.join(assembly.separator || '|');
  };

  /**
   * ⭐⭐ 决定二维码 URL 用哪一串「编号」。
   *   · 两边一致 ⇒ 用它；
   *   · 只有一边有 ⇒ 用那一边；
   *   · 不一致 ⇒ 记 `number_mismatch`（带两个值），然后：
   *       - 若公式值 == **现存附件里那个编号**（说明公式还没算完、停在旧值）⇒ 用**拼装值**
   *         （否则她"改完货号"永远写回旧码，正是今天的真机反馈）；
   *       - 否则以**公式值**为准（保证与扫码页的键一致）。
   * ⚠️ `existingFileNameNumber` 传的是 `numberFromFileName()` 的结果 —— 那是**文件名形态**
   *    （分隔符已按模板编码成 `_`），所以比较前要把公式值也 `sanitizeNumberForFileName` 一下，
   *    否则"同一个编号的两种写法"永远不相等（这个坑 2026-10-12 踩过一次）。
   */
  /**
   * ⭐⭐ 2026-10-12：决定二维码里装哪一串「标识」——**新格式用 record_id（永不变），缺了才回退编号**。
   * @returns {{url,identity,value,fallback,upgrade,previousNumber,previousIdentity}}
   */
  const resolveQrIdentity = ({ recordId, number, existingUrl = '' }) => {
    const hasRecordId = Boolean(String(recordId ?? '').trim());
    const url = hasRecordId
      ? buildRecordIdScanUrl(recordId, config)
      : buildScanUrl(config.scanUrl.numberTemplate, number, config);
    // 旧格式（/s/ = 编号）与文件名里那串编号 ⇒ 这次是"升级"
    const existing = String(existingUrl ?? '');
    const existingIsNumber = existing.includes(config.scanUrl.numberTemplate.split('{')[0]);
    return {
      url,
      identity: hasRecordId ? 'record_id' : 'number',
      value: hasRecordId ? String(recordId).trim() : number,
      fallback: !hasRecordId,
      upgrade: hasRecordId && Boolean(existing) && existingIsNumber && existing !== url,
      // 旧格式 ⇒ 把那串编号**从 URL 里反解回来**（事件里要的是编号本身，不是 URL）
      previousNumber: existingIsNumber
        ? decodeURIComponent(existing.slice(existing.indexOf('/s/') + 3))
        : '',
      previousIdentity: existingIsNumber ? 'number' : (existing ? 'record_id' : ''),
    };
  };

  /**
   * ⭐⭐ AC-X（2026-10-12）：她新加的「记录 ID」**公式字段**与**接口读到的 record_id** 做交叉校验。
   * 🔴 **公式列有延迟** ⇒ **一律以【接口值】为准**；两者不一致 ⇒ 记 warn（带两个值）便于排查。
   * ⚠️ 绝不反过来"以公式值为准"——那正是今天"印了旧编号"那个 bug 的成因。
   */
  const crossCheckRecordId = ({ apiRecordId, formulaRecordId, recordId }) => {
    const api = String(apiRecordId ?? '').trim();
    const fromFormula = String(formulaRecordId ?? '').trim();
    const mismatch = Boolean(fromFormula) && fromFormula !== api;
    if (mismatch) {
      logWarn('product.tag_qr.record_id_mismatch', {
        record_id: recordId || api, api_record_id: api, formula_record_id: fromFormula,
        picked: 'api', note: '公式列有延迟 ⇒ 以接口值为准',
      });
    }
    return { recordId: api, mismatch, source: 'api' };
  };

  /** 二维码矩阵边长（模块数）：N 模块 ⇒ 13mm 下每模块 13/N mm。 */
  const qrMatrixSize = (text) => require('qrcode').create(String(text)).modules.size;

  const resolveQrNumber = ({ formulaNumber, assembledNumber, existingFileNameNumber, recordId, parts = [] }) => {
    // ⭐ 缺段定位：哪几段源字段读成了空（诊断 + 守卫都要用）
    const missingSegments = parts.filter((part) => !part.value).map((part) => part.key);
    const sourceFields = Object.fromEntries(parts.map((part) => [part.key, part.value]));
    if (!formulaNumber && !assembledNumber) {
      return { number: '', source: 'none', mismatch: false, missingSegments, sourceFields };
    }
    if (!formulaNumber) {
      if (!assembledNumber) {
        logWarn('product.tag_qr.assemble_incomplete', { record_id: recordId, missing_segments: missingSegments.join(','), source_fields: sourceFields });
      }
      return { number: assembledNumber, source: 'assembled_fallback', mismatch: false, missingSegments, sourceFields };
    }
    // ⭐⭐ 2026-10-12 真机修复：`formulaLooksStale` **先算**（原来它在这两行**之后**才算）
    const formulaLooksStale = Boolean(existingFileNameNumber)
      && existingFileNameNumber === sanitizeNumberForFileName(formulaNumber, config);
    // ⚠️ 拼装为空 ⇒ 原先**无条件**回落公式。若此时公式**还停在旧值**（= 现存附件里那一串），
    //    那就是「**要把过期公式值印出去**」——本轮的病根 ⇒ 不许静默：记 warn 并在产物上打可见标记。
    if (!assembledNumber) {
      if (formulaLooksStale) {
        logWarn('product.tag_qr.assemble_incomplete', {
          record_id: recordId, formula_number: formulaNumber,
          missing_segments: missingSegments.join(','), source_fields: sourceFields,
          formula_looks_stale: true,
        });
        return {
          number: formulaNumber, source: 'formula_stale_incomplete', mismatch: true,
          formulaLooksStale: true, missingSegments, sourceFields, incomplete: true,
        };
      }
      if (missingSegments.length) {
        logWarn('product.tag_qr.assemble_incomplete', { record_id: recordId, missing_segments: missingSegments.join(','), source_fields: sourceFields });
      }
      return { number: formulaNumber, source: 'formula_only', mismatch: false, missingSegments, sourceFields };
    }
    if (formulaNumber === assembledNumber) {
      return { number: formulaNumber, source: 'both_agree', mismatch: false, missingSegments, sourceFields };
    }
    if (config.numberAssembly?.crossCheck !== false) {
      logWarn('product.tag_qr.number_mismatch', {
        record_id: recordId,
        formula_number: formulaNumber,
        assembled_number: assembledNumber,
        existing_file_name_number: existingFileNameNumber || '',
        formula_looks_stale: formulaLooksStale,
      });
    }
    const useAssembled = formulaLooksStale;
    if (useAssembled) {
      // ⭐ 2026-10-12：**用了拼装值**就记一条带两个值 + 三段源字段的日志 ⇒ 下次一发生即可自证。
      logInfo('product.tag_qr.used_assembled', {
        record_id: recordId, formula_number: formulaNumber, assembled_number: assembledNumber,
        existing_file_name_number: existingFileNameNumber || '', source_fields: sourceFields,
      });
    }
    return {
      number: useAssembled ? assembledNumber : formulaNumber,
      source: useAssembled ? 'assembled_formula_stale' : 'formula_mismatch',
      mismatch: true,
      formulaLooksStale, missingSegments, sourceFields,
    };
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
   *   **其余（`false` / `null` / `undefined`）= 走"按编号核一遍"**：现存附件的**文件名/反解出的编号
   *   == 当前编号** ⇒ 跳过（真的已同步）；否则 ⇒ **覆盖重写**。
   *   ⭐ `undefined`（回填脚本 `--write` 不带 `--overwrite`、新增记录那一档）**也走这条** ——
   *      真机 2026-10-12：这一档曾被当成"已经有值就跳过" ⇒ `--write` 也修不了旧码 ✗。
   *   ⚠️ `null` = 事件里**判不了**（没带值 / 读不出）—— **绝不许把"判不了"当"没变"**（2026-10-09 教训）。
   * @returns {Promise<{record_id, status, reason, file_token?, file_name?, scan_url?}>}
   *   `status` ∈ written | skipped；**失败一律抛错**（由调用方记日志/计失败数）。
   *   ⚠️ 靠文件名判出过期而重写时，`reason` 一律记成 **`number_changed`**（事实如此）；
   *      判不了但比完**一致** ⇒ `number_unchanged`；脚本/新增那一路的幂等跳过 ⇒ `already_present`。
   */
  /** 从现存附件名反解出**旧格式**（/s/数号）的 URL；反解不出（已是新格式）⇒ 空串。 */
  const legacyScanUrlOf = (existing, cfg) => {
    const name = Array.isArray(existing) ? existing[0]?.name : null;
    const middle = numberFromFileName(name, cfg);
    if (!middle) return '';
    const legacy = String(cfg?.scanUrl?.numberTemplate || '');
    return legacy ? legacy.split('{number}').join(middle) : '';
  };

  const syncRecord = async (recordId, { reason = 'manual', numberChanged } = {}) => {
    if (!config.enabled) {
      logInfo('product.tag_qr.disabled', { record_id: recordId, reason });
      return { record_id: recordId, status: 'skipped', reason: 'disabled' };
    }
    const record = await gateway.get('product', recordId);
    const fields = record?.fields || {};
    const existing = attachmentsOf(fields[tagQrFieldName]);
    // ⭐⭐ 2026-10-12：二维码 URL 那串「编号」= **公式列优先**（扫码页认它）+ **源字段拼装兜底**
    //    （她改完货号那一刻公式列还没算完 ⇒ 拼装值才是"新码"；见 `resolveQrNumber` 的注释）
    const formulaNumber = textValue(fields[numberFieldName]).trim();
    const assembledNumber = assembleNumber(fields);
    const numberPick = resolveQrNumber({
      formulaNumber,
      assembledNumber,
      existingFileNameNumber: numberFromFileName(existing[0]?.name, config),
      recordId,
      // ⭐ 逐段源字段值：诊断 + 缺段守卫（见 `assembleParts`）
      parts: assembleParts(fields),
    });
    const number = numberPick.number;
    if (!number) {
      // 「还没填编号」不是故障：记一条 warn 就跳过（重试也不会变）。
      logWarn('product.tag_qr.number_missing', {
        record_id: recordId, reason, formula_number: formulaNumber, assembled_number: assembledNumber,
      });
      return { record_id: recordId, status: 'skipped', reason: 'number_missing' };
    }

    // ⭐⭐ 2026-10-12 接线：**二维码里装的是「记录 ID」（永不变），不再是编号（会变的快照）**。
    //    她今天亲自提的方案：「如果必须得要一个完全不变的标识，那我们是不是可以用记录 ID 呀？」
    //    · 有 record_id ⇒ 新格式 `/r/{recordId}`（接口读到的即时值 ✓）
    //    · 没有（异常数据）⇒ **不静默**：记 warn + 回退编号格式（保证还能印出来）
    //    · 现存附件还是旧格式 ⇒ 这次就是**升级**（是在**修复已经印错的码**，不是兼容）
    const existingUrl = legacyScanUrlOf(existing, config);
    const identity = resolveQrIdentity({ recordId, number, existingUrl });
    if (identity.fallback) {
      logWarn('product.tag_qr.record_id_missing', {
        record_id: recordId, reason, number, fallback_identity: 'number',
      });
    }
    if (identity.upgrade) {
      logInfo('product.tag_qr.upgraded_to_record_id', {
        record_id: recordId, reason,
        previous_number: identity.previousNumber,
        previous_identity: 'number',
        new_url: identity.url,
      });
    }
    const scanUrl = identity.url;
    const fileName = buildFileName(identity.value, config);

    // 「现存附件的文件名 ≠ 当前编号应有的文件名」= **事实上的编号变了**（只读一次就判得出，
    // 不依赖事件带没带前后值）。这一档才是 `numberChanged === null` 时的**唯一**判据。
    // "已同步" = 附件名与规范名**逐字一致**，**或**从名字里按模板反解出的编号 == 当前编号
    // （后者是"以编号为准"的语义判据；见 `numberFromFileName` 的注释）。
    //
    // 🔴🔴 2026-10-12 修（业务负责人真机发现"改货号后二维码没更新"）：
    //   ① 判据必须是"**与规范名一致 / 反解出的编号一致**"，**不能**退化成"名字里含有当前编号"——
    //      反例（真机形状）：`tag-qr-QPL2635-1_黑_A.png` **确实含有** `2635-1_黑_A` ❌；
    //   ② `numberChanged === false`（事件说这一列前后值相同）**也要核一遍附件** ——
    //      改前这一档直接"连表都不读"就跳过了，于是"附件早就旧了、之后只改别的字段"
    //      这条路会**永远**跳过 ⇒ 二维码一直停在旧编号上（真机 292 次跳过 / 0 次写回）。
    //   ③ ⭐ **2026-10-12 二次修（写入路径）**：`numberChanged` 只认**三种**含义 ——
    //      `true` = 已确定编号变了（**强制覆盖**，不再看文件名）；
    //      **其余（`false` / `null` / `undefined`）一律要核一遍附件**（按编号/文件名），核不过就覆盖。
    //      ⚠️ 改前 `undefined`（回填脚本 `--write` **不带** `--overwrite` 就是这一档）被当成
    //      "已经有值就跳过" ⇒ 真机现场：`--write` 那一条记 `skipped_existing`
    //      （`existing_file_names=["tag-qr-832-372-6H_棕色_A.png"]`）而它明明是旧码 ✗。
    //      ⇒ 现在**写入路径也按编号判过期**：干跑说"待更新"的，`--write` 就必须真的更新。
    // ⚠️ 锚是 **identity 值**（新格式 = record_id）⇒ 旧编号命名的附件**天然不匹配** ⇒ 判为过期 ⇒ 覆盖升级 ✓
    const safeNumber = sanitizeNumberForFileName(identity.value, config);
    const namesMatch = existing.length > 0 && existing.some((item) => item.name === fileName
      || numberFromFileName(item.name, config) === safeNumber);
    const forceOverwrite = numberChanged === true;
    const staleByFileName = existing.length > 0 && !forceOverwrite && !namesMatch;
    // ⭐ 覆盖原因**如实**：靠文件名判出来的不匹配，就是 `number_changed`
    //   （而不是含混的 `number_change_unknown`）——日志/返回值里要能一眼看出是"改了"。
    const effectiveReason = staleByFileName ? 'stale_file_name' : reason;

    if (existing.length) {
      const overwrite = forceOverwrite || staleByFileName;
      if (!overwrite) {
        // ⚠️ 跳过时的**日志口径按"来路"分**（2026-10-12）：
        //    事件那一路（`false` = 事件说没变 / `null` = 判不了）⇒ `skipped_number_unchanged` + `number_unchanged`；
        //    脚本/新增那一路（`undefined` = 幂等档）⇒ 仍然是 `skipped_existing` + `already_present`。
        //    （判**过期**的口径两边已经统一：`staleByFileName` 覆盖 undefined ✅）
        if (numberChanged === false || numberChanged === null) {
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
        // ⭐ 这串「编号」是哪来的：formula_only / assembled_fallback / assembled_formula_stale /
        //   formula_mismatch / both_agree（排查"为什么写的是这个码"看它）
        number_source: numberPick.source,
        number_mismatch: numberPick.mismatch,
        formula_looks_stale: Boolean(numberPick.formulaLooksStale),
        // ⭐ 2026-10-12：缺段就**在作业日志里可见**（不静默印一枚扫不出来的码）
        assemble_incomplete: Boolean(numberPick.incomplete || (numberPick.missingSegments || []).length),
        missing_segments: (numberPick.missingSegments || []).join(','),
        file_token: fileToken,
        file_name: fileName,
        scan_url: scanUrl,
      };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  /**
   * ⭐ 延迟复核队列（2026-10-12）：事件把这次编辑判成"编号没变/判不了"时，
   * **过一会儿再核一次**（那时公式列已经算完）—— 真机那次改货号就是这么漏的。
   * 幂等（同一条只排一次）、失败只记日志；可注入定时器便于单测用假时钟。
   */
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
        // ⭐⭐ 2026-10-12：**先用源字段判**（货号/颜色/类别 —— 事件里没有延迟）；
        //    源字段判不了（事件没带/读不出）才退回公式列的「编号」判据。
        const sourceDetail = await resolveSourceChangeDetail(actionItem);
        const detail = await resolveNumberChangeDetail(actionItem);
        const numberChanged = sourceDetail.changed !== null ? sourceDetail.changed : detail.changed;
        // ⚠️ 2026-10-12 改：**"确定没变"这一档不再短路跳过**（改前它连表都不读）。
        //    真机证明"附件早就旧了、之后只改别的字段"会在这条路上**永远**跳过 ⇒
        //    二维码停在旧编号上（292 次跳过 / 0 次写回）。现在一律交给 `syncRecord`：
        //    读一次记录、拿**规范文件名 / 反解出的编号**核附件；核得上才记
        //    `skipped_number_unchanged`（多一次只读，换来"不会静默停在旧码上"）。
        // 判据来源记一条（哪一路判的、改了哪几个字段）—— 排查"为什么没触发/为什么触发"靠它
        logInfo('product.tag_qr.change_criteria', {
          record_id: recordId,
          action,
          source_changed: sourceDetail.changed,
          source_fields_changed: sourceDetail.changed_fields,
          source_why: sourceDetail.why,
          formula_changed: detail.changed,
          formula_why: detail.why,
          used: sourceDetail.changed !== null ? 'source_fields' : 'formula_number',
        });
        if (numberChanged === null) {
          // ⭐⭐ **判不了 ≠ 没变**（2026-10-09 就是在这里漏判的）：退化到"读一次记录、比文件名"。
          //    把事件里的原始值一并记下来 —— 这是这类漏判**唯一**的现场证据。
          logInfo('product.tag_qr.number_change_unknown', {
            record_id: recordId,
            action,
            why: sourceDetail.changed !== null ? sourceDetail.why : detail.why,
            before_value: previewValue(detail.before),
            after_value: previewValue(detail.after),
          });
        }
        const outcome = await syncRecord(recordId, {
          reason: numberChanged === true ? 'number_changed' : 'number_change_unknown',
          numberChanged,
        });
        // ⭐⭐ 2026-10-12：**判成"没变"（`number_unchanged`）或"判不了"（`number_change_unknown`）时
        //    排一次延迟复核** —— 真机那次编辑，事件到达时公式列还是旧值 ⇒ 如实判"没变"，
        //    而之后再没有第二次事件 ⇒ 旧码一直挂着。这一排程就是"过 60 秒再看一眼"。
        results.push(outcome);
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
      // ⭐⭐ 2026-10-12 修复（真缺口）：巡检算「规范名」也必须按 **identity（record_id）**，
      //    不能按编号 —— 否则新码下旧编号命名的附件会被判"不符"⇒ 每次都重生成 ✗。
      const expectedFileName = buildFileName(resolveQrIdentity({ recordId, number }).value, config);
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
        const result = await syncRecord(item.record_id, { reason: 'sweep_stale' });
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
    // ⭐ 源字段判据 / 拼装 / URL 编号取舍（测试与排查都要用）
    resolveSourceChangeDetail,
    assembleNumber,
    assembleParts,
    resolveQrNumber,
    resolveQrIdentity,
    qrMatrixSize,
    crossCheckRecordId,
    syncRecord,
    handleTableChanges,
    sweepStaleTagQrCodes,
  };
};

module.exports = {
  createTagQrCodeService,
  buildScanUrl,
  buildRecordIdScanUrl,
  buildFileName,
  numberFromFileName,
  sanitizeNumberForFileName,
  attachmentsOf,
  findFieldValue,
  readableFieldText,
  generateQrPng,
};
