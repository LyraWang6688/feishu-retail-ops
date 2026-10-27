/**
 * 鞋盒标签打印 service —— **只干一件事**：从「实时库存」（一双一条）取数，
 * 按**编号**（= `货号|颜色|类别`）聚合成"**每张标签要印什么**"
 * （品牌 / 货号 / 颜色 · 品类 / 尺码+数量 / 单价 / 二维码）。
 *
 * 业务负责人 2026-10-08 **定案**的版式改造（40×30mm）：
 *   · **一张标签 = 一个编号**（不是一双）—— 尺码那一项 = 该编号下**所有尺码 + 各自数量**
 *     （数量是角标：小号字下沉；**不用 Unicode 下标字符**，见 config 的 `SIZES`）；
 *   · **只印有库存（数量>0）的尺码**（0 的不印，缺号扫码看）；
 *   · **尺码按数值从小到大**（`38` < `40` < `100`，不是字符串序）⇒ config 的 `sizes.order` / `sizes.compare`；
 *     一行放不下**自动换行**（`maxLines` 是**安全上限**，默认 6 —— **不是固定行数**；
 *     真正装不下才省略并留 `…`）—— `perLine` / `maxLines` 来自 config；
 *     ⚠️ 2026-10-12 真机 bug：她 `26812 黑色` 有 44 码，就是被"固定两行"截成 `…` 的 ⇒ 上限改成 6；
 *   · 价格印**单价**（「货品信息.单价」，按编号取）；读不到**照发标签、不印价格**并计数（不静默丢）。
 *
 * ⭐ **2026-10-08 她看了实物标签后的第二次定案**（「品牌顶部居中 / 货号+颜色第一行 / 价格第二行 /
 *    下面尺码区」）改的**只是"怎么摆"**：右栏行序、品牌位置、货号+颜色同行的超宽处理都在
 *    config 的 `BODY` 里，由页面落成 HTML/CSS —— **本文件照旧只回答"印什么"**
 *    （唯一跟着动的是**尺码排序**，因为它属于"取什么数"）。
 *
 * ⚠️ **只读**：本文件**没有任何写入路径** —— 只调 `gateway.listAll('liveInventory' | 'product')`
 *    这两次读（`V1BitableGateway` 的 create / update / delete 一次都不调）。
 *    业务负责人 2026-10-08 的口径：这个功能**只读表**，就不该有任何写入路径。
 *
 * ⭐⭐ **2026-10-15：数据源第二次定案 = 「货品信息 ∪ 实时库存」（按「编号」去重）**。
 *    她的原话：「编号对呀，我们的编号**只要它在货品信息里就行了**，不一定非要在库存里面有啊」，
 *    并说清批量打印的用途 = 「**一次给一批新货打码**（新店开业 / 换季上架）」——
 *    ⚠️ **新货常常还没有入库**（真机只读核过：测试 Base 里 440 个编号有 **16 个**在「实时库存」
 *    里一行都没有）⇒ 只认库存的话，这批新货一张标签都打不出来。
 *    · 有「实时库存」行的编号 ⇒ 照旧（`sizes` = 各尺码数量，一张 = 一个编号）；
 *    · **没有库存行、但在「货品信息」里的编号 ⇒ 也出一张标签**：`sizes = []`
 *      （页面据此**不印「尺码」那一行** —— 她选的版式：新品标签上不印"尺码 + 库存数量"）；
 *    · 「货品信息」原来只用来**补价格 / 品牌**，现在还要出「货号 / 颜色 / 类别」（新货的这三样
 *      只有那里有）。
 *    ⚠️ 筛选口径如实：`keyword` / `category` / `recentDays` 两边都参与；
 *      `size` / `state` **无库存的那批不参与**（它的尺码与所属状态无从得知）——
 *      **排除并计数**（`without_stock_skipped` ＋ 一条 warn），**不静默丢** ✗。
 *    🔴 仍然是**只读**：依旧只有 `listAll('liveInventory')` / `listAll('product')` 两次读。
 *
 * ⚠️ **二维码内容是单一真源**：模板来自 `config/tagQrCode.js` 的 `SCAN_URL.recordIdTemplate`
 *    （`https://hm.bamamei.online/s/{编号}`），替换用 `services/tagQrCodeService.js` 导出的
 *    记录 ID 二维码构造器（只编码值、不编码模板）。本文件**不抄第二份 URL 模板** —— 旧的那条
 *    `https://workbench.bamamei.online/scan?no=…` 已随本次改造删除。
 *
 * ⚠️ **排版不进这里**（那是页面的事）：service 只回答"印什么"（数值 / 文案 / SVG 字符串 /
 *    尺码怎么分行），40×30mm、每页几行几列、字号这些**怎么摆**的参数原样带在响应的 `layout` 里，
 *    由页面（`public/workbench/features/labels/*`）落到 CSS 上。
 *
 * 字段映射（**只读**，一个都不写）：
 *   · 「库存键」（`liveInventory.stockKey`）—— 飞书侧公式 `货号|颜色|类别|尺码`，
 *     一次读一列就同时拿到货号、颜色、类别、尺码（与 `services/liveInventoryIndex.js`
 *     同一套解析，**复用 `parseStockKey`**，不另写一份、不另读三张关联表）；
 *     前 3 段拼起来就是**编号**（与「货品信息.编号」同一格式，见 `docs/production-base-changes-2026-10-08.md`）；
 *   · 「品类」（`liveInventory.category`）—— 公式列，标签上"颜色 · **品类**"印的是它（打样图：黑色 · 休闲鞋）；
 *   · 「所属状态」（`liveInventory.state`）—— 只用来筛选 / 排序（默认不印，见 `FIELDS.state`）；
 *   · 「创建时间」—— 只用于「最近新增」筛选（字段名暂放 config，见那里的说明）；
 *   · 「货品信息.编号 / 单价」（+ 品牌那列，仅当 `BRAND.from = 'table'`）—— 按编号补齐价格与品牌。
 */
const QRCode = require('qrcode');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { LABEL_PRINT, resolveGrid } = require('../config/labelPrint');
const { SCAN_URL } = require('../config/tagQrCode');
const { buildRecordIdScanUrl } = require('./tagQrCodeService');
const { textValue } = require('./v1BitableGateway');
const { parseStockKey } = require('./liveInventoryIndex');
// ⭐⭐ task-15：飞书 `filter` 公式的拼装**只有那一处实现**（`bitableFilterFormula.js`）——
//    这里只 import 复用（**值的安全字符检查也在它那里**），**不抄第二份** ✗。
const { containsFormula, orFormula } = require('./bitableFilterFormula');
const { logInfo, logWarn } = require('../utils/logger');

// 她填错了（400，原样回显）vs 远端出错（其余，页面只说"查询失败"）——与
// `inventoryAdjustmentService` 同一条约定，控制器按 statusCode 分流。
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * 把「创建时间」这类飞书时间字段还原成毫秒时间戳。
 * 飞书返回的是毫秒数（`type:1001` 自动字段）；也认 `[毫秒]`（`type:1002`）与可解析的字符串。
 * 读不出来一律回 `0`（= 不知道），**不猜** —— 由调用方决定"要不要因为读不到而报错"。
 */
const asTimestamp = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return 0;
  const number = Number(raw);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * 文本模板（底部小字）—— 把 `{占位符}` 换成值，**不做 URL 编码**，
 * 且取不到的值用 `texts.missingValue` 顶上（`42` 前面是空段看着像漏印）。
 * 模板里出现不认识的占位符 → **当场抛错**（配置写错时不许静默印出一行空话）。
 */
const buildText = (template, values, missingValue) => String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
  if (!Object.prototype.hasOwnProperty.call(values, key)) {
    throw new Error(`文案模板里的占位符不认识：{${key}}（可用：${Object.keys(values).join(' / ')}）`);
  }
  const value = values[key];
  const text = value === undefined || value === null ? '' : String(value).trim();
  return text || missingValue;
});

const requireInteger = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw userError(`${label}必须是整数`);
  return Number(text);
};

/**
 * 「单价」单元格 → 数字。飞书数字列可能回字符串 / `[{text}]` / 带货币符号的文本，
 * 统一取数字部分；**读不出来回 `null`（= 没有单价）**，不回 0 —— 0 是一个真实的价格。
 */
const asAmount = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const raw = textValue(value).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
};

/**
 * 单价印出来的字（`399` → `¥399`；`399.5` → `¥399.5`）。`null` ⇒ 空串（**不印**）。
 * 整数不补零：打样图上是 `¥399`，不是 `¥399.00`。
 */
const formatPrice = (amount, priceConfig = {}) => {
  if (amount === null || amount === undefined) return '';
  const prefix = String(priceConfig.prefix ?? '');
  const decimals = Number.isInteger(priceConfig.decimals) && priceConfig.decimals >= 0
    ? priceConfig.decimals
    : 2;
  // `Number(x.toFixed(n))` 顺手去掉尾随 0 与多余小数点。
  return `${prefix}${Number(Number(amount).toFixed(decimals))}`;
};

/**
 * 三段拼成**编号**（`货号|颜色|类别`）—— 「实时库存.库存键」前 3 段与「货品信息.编号」是**同一个格式**
 * （见 `docs/production-base-changes-2026-10-08.md`）。
 */
const compoundNumber = (itemNo, color, categoryCode) => `${itemNo}|${color || ''}|${categoryCode || ''}`;

/**
 * 一条（`rowFromRecord` 解析出来的）库存记录的前三段 = **编号**。
 */
const numberOf = (row) => compoundNumber(row.item_no, row.color, row.category_code);

/**
 * 一个**编号**拆回三段（`货号|颜色|类别`）—— 与 `numberOf()` 是**一对**。
 * ⭐ 2026-10-15：没有库存的那些编号，只有「货品信息」这一处能给出这三段
 *   （表里也有「货号 / 颜色 / 类别」三列；列读不出来才用编号自己拆，**不猜**别的）。
 */
const partsOfNumber = (number) => {
  const [itemNo, color, categoryCode] = String(number ?? '').split('|');
  return {
    item_no: String(itemNo ?? '').trim(),
    color: String(color ?? '').trim(),
    category_code: String(categoryCode ?? '').trim(),
  };
};

/**
 * 尺码比较器 —— **配置先行**：`sizes.compare` 决定按数值还是按文本（她定案：**数值**，
 * 这样 `38` < `40` < `100`；字符串序会把 `100` 排到 `38` 前面）；`sizes.order` 决定升/降序。
 * ⚠️ 读不出数字时**不猜**：两边都退化成文本比较（而不是让 `NaN` 污染排序、把整表顺序搅乱）。
 */
const compareSizes = (left, right, sizesConfig = {}) => {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const numeric = sizesConfig.compare !== 'string'
    && Number.isFinite(leftNumber) && Number.isFinite(rightNumber);
  const delta = numeric
    ? leftNumber - rightNumber
    : String(left).localeCompare(String(right), 'zh-CN');
  return sizesConfig.order === 'desc' ? -delta : delta;
};

/**
 * 尺码 + 数量 → **按每行几个自动分行**（她定案的规则 ③）。
 * 返回 `{ lines, overflow }`：`lines` 最多 `maxLines` 行（**安全上限**；每行至多 `perLine` 个），
 * `overflow = true` 表示还有尺码没排上（页面在最后一行尾上补 `…`，**不静默吞掉**）。
 */
const buildSizeLines = (sizes, sizesConfig = {}) => {
  const perLine = Number.isInteger(sizesConfig.perLine) && sizesConfig.perLine > 0 ? sizesConfig.perLine : 3;
  // 安全上限（默认 6）：**它不是"固定行数"** —— 打印产物那边还会按"可用高度 + 实际字宽"再自适应
  const maxLines = Number.isInteger(sizesConfig.maxLines) && sizesConfig.maxLines > 0 ? sizesConfig.maxLines : 6;
  const visible = sizes.slice(0, perLine * maxLines);
  const lines = [];
  for (let index = 0; index < visible.length; index += perLine) {
    lines.push(visible.slice(index, index + perLine));
  }
  return { lines, overflow: sizes.length > visible.length };
};

/**
 * 一条「实时库存」记录 → 聚合用的一行。
 * 记录里读不出「库存键」四段（或所属状态为空）时返回 `null`（由调用方计数、**不猜**：
 * 按错的键印标签等于把这一双贴到别的款上，宁可少一张也不印错）。
 */
const rowFromRecord = (record, { fieldNames, createdTimeField }) => {
  const key = parseStockKey(record?.fields?.[fieldNames.stockKey]);
  if (!key) return null;
  const state = textValue(record?.fields?.[fieldNames.state]).trim();
  if (!state) return null;
  // 「品类」= 「实时库存.品类」公式列（休闲鞋 / 单鞋…），**标签上"颜色 · 品类"印的就是它**；
  // 读不到才回落到库存键第 3 段。两者都在**这一次读**里，零额外请求。
  const categoryFromField = fieldNames.category ? textValue(record?.fields?.[fieldNames.category]).trim() : '';
  return {
    record_id: record.record_id,
    item_no: key.itemNo,
    color: key.color || '',
    // 「类别」= 库存键第 3 段（生产真表里是 A / B）—— **编号**用它（= 与「货品信息.编号」对齐）。
    category_code: key.category || '',
    category: categoryFromField || key.category || '',
    size: key.size,
    state,
    stock_key: textValue(record?.fields?.[fieldNames.stockKey]).trim(),
    created_at: createdTimeField ? asTimestamp(record?.fields?.[createdTimeField]) : 0,
  };
};

/**
 * 「货品信息」→ `编号 ⇒ { price, brand, record_id, item_no, color, category_code, category, created_at }`
 * 的索引（只读一次表就够）。
 * 同一个编号出现多条时：**第一条非空**的价格 / 品牌 / 三段 / 创建时间为准（不覆盖已有值）。
 *
 * ⭐ 2026-10-14：多留一个 `record_id` —— 标签上的二维码从 `/s/{编号}` 改成
 *   `/r/{记录 ID}`（她 2026-10-12 定案：「新二维码一律 `https://hm.bamamei.online/r/{recordId}`」；
 *   依据见 `docs/qr-record-id-and-js-2026-10-12.md`）。QR 里装的是**接口读到的** record_id
 *   （她那个「记录 ID」公式列有延迟 ⇒ 只作交叉校验，以接口值为准）。
 *
 * ⭐ 2026-10-15：这张索引**不再只是价格 / 品牌的字典** —— 没有库存行的编号就是靠它出标签的
 *   （`item_no` / `color` / `category_code` 取列，列读不出来才拆编号；`created_at` 供「最近新增」筛）。
 *   `createdTimeFields` 是**候选名列表**（见 `PRODUCT_CREATED_TIME_TYPES` 的说明）：
 *   按顺序取第一个读得出的时间，**不猜**（都读不出 ⇒ 0）。
 */
const buildProductIndex = (records, fields = {}, brandFieldName = '', createdTimeFields = []) => {
  const index = new Map();
  const createdFields = [].concat(createdTimeFields || []).filter(Boolean);
  const firstText = (record, fieldName) => (fieldName ? textValue(record?.fields?.[fieldName]).trim() : '');
  for (const record of records || []) {
    const number = fields.number ? textValue(record?.fields?.[fields.number]).trim() : '';
    if (!number) continue;
    const parts = partsOfNumber(number);
    const entry = index.get(number) || {
      price: null, brand: '', record_id: '', item_no: '', color: '', category_code: '', category: '', created_at: 0,
    };
    const price = fields.price ? asAmount(record?.fields?.[fields.price]) : null;
    if (entry.price === null && price !== null) entry.price = price;
    const brand = brandFieldName ? textValue(record?.fields?.[brandFieldName]).trim() : '';
    if (!entry.brand && brand) entry.brand = brand;
    if (!entry.record_id && record?.record_id) entry.record_id = String(record.record_id);
    if (!entry.item_no) entry.item_no = firstText(record, fields.itemNo) || parts.item_no;
    if (!entry.color) entry.color = firstText(record, fields.color) || parts.color;
    if (!entry.category_code) entry.category_code = firstText(record, fields.category) || parts.category_code;
    // 「货品信息」**没有**「品类」列（标签上那个"颜色 · 品类"的品类是「实时库存」的公式列）
    // ⇒ 无库存的那批没有品类，如实拿「类别」顶上（页面默认不印这一项，见 `FIELDS.category`）。
    if (!entry.category) entry.category = entry.category_code;
    if (!entry.created_at) entry.created_at = createdAtOf(record, createdFields);
    index.set(number, entry);
  }
  return index;
};

/**
 * 一条记录上**第一个读得出**的「创建时间」候选列（毫秒）；都读不出回 `0`（= 不知道，**不猜**）。
 */
const createdAtOf = (record, createdFields = []) => {
  for (const fieldName of [].concat(createdFields || [])) {
    if (!fieldName) continue;
    const value = asTimestamp(record?.fields?.[fieldName]);
    if (value > 0) return value;
  }
  return 0;
};

/**
 * 按**记录 ID**出码（URL 模板与替换实现都复用 `tagQrCode` 那一份，**不抄第二份**）。
 *
 * ⚠️ 2026-10-14（业务负责人 2026-10-12 定案 + Lead 当晚裁决走 ⓐ）：
 *   标签上的二维码从 `/s/{编号}` 换成 **`/r/{记录 ID}`** —— 编号是**会变的快照**
 *   （她打印时类别还空着、事后补上 ⇒ 旧码对不上），record_id 是飞书**永不变**的身份证。
 *   旧贴纸按她的口径**重打**（`/s/{编号}` 路径保留，但扫码打印**不认它** ⇒ 人话提示重打）。
 */
const buildLabelScanUrl = (recordId) => buildRecordIdScanUrl(recordId, { scanUrl: SCAN_URL });

/**
 * 从 URL 模板里拆出「前缀 / 后缀」（`https://hm.bamamei.online/r/{recordId}` ⇒ 前缀 `…/r/`、后缀 `''`）。
 * 模板里没有占位符 ⇒ 返回 `null`（**不猜**：那种模板本来就生成不出可解析的码）。
 */
const templateParts = (template) => {
  const source = String(template ?? '');
  const open = source.indexOf('{');
  const close = open === -1 ? -1 : source.indexOf('}', open);
  if (open === -1 || close === -1) return null;
  return { prefix: source.slice(0, open), suffix: source.slice(close + 1) };
};

/** 记录 ID 允许的字符（飞书 `record_id` 是字母数字）—— 认不出的形状**不猜**，当场拒。 */
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 「扫码打印」的文案（**唯一真源** = `config/labelPrint.js` 的 `SCAN_PRINT.texts`）。
 * ⚠️ 服务里**一句中文都不写死**（`test/noHardcodedChinese.test.js` 会红 ✗）：
 *    自定义 config 缺这一块时回落到模块默认配置（`LABEL_PRINT`）的那一份 ⇒ 永远有文案。
 */
const scanPrintTextsOf = (config) => config?.scanPrint?.texts || LABEL_PRINT.scanPrint.texts;

/**
 * ⭐⭐ 「扫码打印」：**扫到的字符串 ⇒ 记录 ID**（与 `buildLabelScanUrl` 是**一对反函数**）。
 *
 * 形状唯一真源 = `config/tagQrCode.js` 的 `SCAN_URL`（本函数里**没有第二个 URL 模板** ✗）。
 * 三种结果：
 *   · `/r/{recordId}` ⇒ `{ ok:true, mode:'recordId', value }` ✓
 *   · `/s/{编号}`（旧贴纸）⇒ `{ ok:false, reason:'legacy_sticker', message }`（**可操作**的人话 ✓）
 *   · 别的 / 空 ⇒ `{ ok:false, reason:'not_label_code' | 'empty', message }`（**不猜** ✗）
 * ⚠️ **绝不**"从随便一段文字里抠一个像 ID 的串" —— 形状不对就是不对（那是替她乱打一张纸）。
 */
const parseLabelScanUrl = (raw, config = LABEL_PRINT) => {
  const texts = scanPrintTextsOf(config);
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'empty', message: texts.empty };
  const recordParts = templateParts(SCAN_URL.recordIdTemplate);
  if (recordParts && value.startsWith(recordParts.prefix) && value.endsWith(recordParts.suffix)) {
    const sliced = value.slice(recordParts.prefix.length, value.length - recordParts.suffix.length);
    let id = sliced;
    try { id = decodeURIComponent(sliced); } catch { id = sliced; }
    if (RECORD_ID_PATTERN.test(id)) return { ok: true, mode: 'recordId', value: id };
    return { ok: false, reason: 'not_label_code', message: texts.notLabelCode };
  }
  return { ok: false, reason: 'not_label_code', message: texts.notLabelCode };
};

/**
 * ⭐ 2026-10-15：「货品信息」那个**创建时间**列怎么找 —— **口径全在 config**
 *    （`config/labelPrint.js` 的 `PRODUCT_CREATED_TIME`：`fieldName` + `fieldType`）。
 *
 * 为什么不能写死「创建时间」：**只读核过测试 Base 真表**（`appTableField.list`，2026-10-15）——
 *   「货品信息」里**没有**叫「创建时间」的列：她把它改名叫 **「上架日期」**，
 *   但**类型仍是 `1001 = CreatedTime`（飞书自动字段）**；而「更新日期」是 `1002 = ModifiedTime`
 *   （**不是**创建时间 —— 拿它当"最近新增"会把"她刚改过的老货"当成新货 ✗）。
 *   ⚠️ 这正是 `AGENTS.md` 里说的**表改名闸门拦不住**的那类静默失效（闸门按 tableId 校验字段名）。
 * ⇒ 解析顺序（实现在 `resolveProductCreatedTimeFields`）：
 *   ① `config.productCreatedTime.fieldName`（**字段名归配置**）：这次读到的记录里**有这一列**就用它
 *      （**零额外请求**；她再改名只改 config 那一行）；
 *   ② 记录里**没有这一列** ⇒ 按 `config.productCreatedTime.fieldType`（1001）去字段表里找那一列
 *      （`gateway.listFields`，**只读**、网关自己有缓存；改多少次名都认）＋ **如实 warn**
 *      （`workbench.labels.product_created_time_renamed`：配置的名字跟真表对不上了）；
 *   ③ 都拿不到 ⇒ 那一条 `created_at = 0`：计进 `missing_created_at_without_stock` 并**如实 warn**，不猜。
 */

/**
 * ⭐⭐ 2026-10-15（task-11）：**这条只读链路的短 TTL 缓存** —— 两个用途**共用同一份实现**
 *    （收敛 `#582` 落在端点里的那一套，**不抄第二份** ✗）：
 *      · `listProductNumbers`（编号清单端点：`GET /products/numbers`）；
 *      · `listLabels`（批量 / 编号打印那一页：`GET /labels`）。
 *
 * 为什么要有它（Lead 线上**只读实测**）：`listAll('liveInventory')` 1362 行 5924ms ＋
 *   `listAll('product')` 561 行 5478ms ⇒ **一次 ≈ 11.4 秒**；而她**每打开一次**那一页都要等 ✗。
 *
 * 口径（与 #582 落地的那套逐条一致）：
 *   · `ttlMs > 0`：TTL 内重复调用**不再读飞书**（命中）；`= 0`：**关掉缓存**，每次真读；
 *   · 缓存里**只放与请求无关的数据**（原始记录 / 编号底表）；**筛选、排序、
 *     「最近新增」的时间判断一律在缓存之外每请求现算** ✗（连筛选结果一起缓存会串数据）；
 *   · 命中 / 未命中都**如实记日志**：`<event>.cache_hit`（`age_ms` / `ttl_ms`）·
 *     `<event>.cache_miss`（`reason: empty | expired | disabled`）—— 真机一眼看出"到底读没读表"；
 *   · 时钟往回跳（`age < 0`）**不当命中**，宁可重读。
 *
 * `load()` 只在**未命中**时被调用一次，返回 `{ value, meta }`（`meta` 只进日志，不参与逻辑）。
 *
 * ⭐⭐ 2026-10-15（task-15）：**可以按 key 分槽**（`get(key)`）—— 端点的"服务端模糊查询"
 *    是**按关键字**去飞书取数的，缓存也必须**按关键字分槽**（否则 A 关键字的清单会被 B 关键字命中 ✗）。
 *    `maxEntries` 是槽位上限（超了丢最旧的），默认 1 = 单槽（`listLabels` 与老路径就是单槽）。
 *    `load(key)` 会收到那个 key（单槽时是 `''`）。
 */
const createShortTtlCache = ({ now, ttlMs, event, load, maxEntries = 1 }) => {
  const capacity = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 1;
  // ⚠️ 用**数组**（最旧在前）而不是 `Map`：这里要"去重 + 丢最旧"，数组一句 `filter` / `slice` 就够 ——
  //    也避开 `Map.delete`（`labelPrintService.test.js` 的**只读哨兵**把 `.delete(` 当作"网关删除调用"，
  //    那是给"这条链路只读"用的判据；**不许**为了这里去放宽它 ✗）。
  let entries = []; // [{ slot, at, value, meta }]
  return {
    async get(key = '') {
      const slot = String(key ?? '');
      const at = now();
      const entry = entries.find((item) => item.slot === slot) || null;
      const age = entry ? at - entry.at : null;
      if (ttlMs > 0 && entry && age >= 0 && age < ttlMs) {
        logInfo(`${event}.cache_hit`, { age_ms: age, ttl_ms: ttlMs, ...(entry.meta || {}) });
        return entry.value;
      }
      const reason = ttlMs <= 0 ? 'disabled' : (entry ? 'expired' : 'empty');
      const loaded = await load(slot);
      const meta = (loaded && loaded.meta) || {};
      // `ttlMs = 0` ⇒ **不写缓存**（配置说关就关；下次照样真读）。
      if (ttlMs > 0) {
        // 重新排到队尾（最近用过的最后被挤掉）+ 超容量丢最旧。
        entries = entries.filter((item) => item.slot !== slot);
        entries.push({ slot, at, value: loaded.value, meta });
        if (entries.length > capacity) entries = entries.slice(entries.length - capacity);
      }
      logInfo(`${event}.cache_miss`, { reason, ttl_ms: ttlMs, ...meta });
      return loaded.value;
    },
  };
};

/**
 * ⭐⭐ 2026-10-15（task-15）：「货品信息」的**服务端模糊查询公式**
 *    （她逐字：「**用户输入一个编号，然后系统再给出与这个模糊编号相关的选项**」）。
 *
 * `OR(编号 contains 关键字, 货号 contains 关键字)`。**为什么只这两列**：
 *   · `编号` = `货号|颜色|类别`（飞书公式列，真表核过）⇒ 命中**颜色 / 类别**的关键字
 *     **也必然命中编号** ⇒ 不用再拼那两列 ✓；
 *   · ⚠️ `颜色` 是**关联列（type 18）** —— 仓库里已有硬事实：**关联列拼 filter 会
 *     `InvalidFilter (1254018)`**（见 `services/bitableFilterFormula.js` 顶部那段），
 *     所以**绝不**把它拼进公式 ✓。
 * 实测（2026-10-15 · 测试 Base **只读** · 项目代码）：`.contains()` **大小写不敏感**
 *   （`contains("xhb8095")` 能命中 `XHB8095E2E|全黑|A`）⇒ **不用**为大小写各拼一遍，
 *   也**不用**"命中 0 条就换大小写重试"那套退避 ✓。
 * 值里有双引号 / 反斜杠 / 方括号 / 换行 ⇒ `containsFormula` 回 `null` ⇒ 调用方**如实拒绝**
 *   （**不硬拼**：拼坏了的公式要么报错、要么按错的条件返回，错数据比慢更坏 ✗）。
 */
const productNumbersFilterOf = (productFields, keyword) => orFormula([
  containsFormula(productFields?.number, keyword),
  containsFormula(productFields?.itemNo, keyword),
]);

const createLabelPrintService = (gateway, options = {}) => {
  if (!gateway) throw new Error('LabelPrintService requires gateway');
  const config = options.config || LABEL_PRINT;
  const now = options.now || (() => Date.now());
  /** 缓存 TTL 从 config 取（**0 是一个合法值** = 关掉；没配才用兜底值）。 */
  const ttlOf = (group, fallback) => (Number.isInteger(group?.cacheTtlMs) && group.cacheTtlMs >= 0
    ? group.cacheTtlMs
    : fallback);

  /**
   * 列表端点那几档旋钮（**构造时读一次 config**）。全部可配：换值只改 `config/labelPrint.js`。
   * `serverFilter` 是显式布尔（`!== false` = 默认开）：关掉 ⇒ 回退"整表读 + 内存过滤"那条老路。
   */
  const numbersLimits = (() => {
    const group = config.productNumbers || {};
    const positive = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
    return {
      defaultLimit: positive(group.limitDefault, 200),
      maxLimit: positive(group.limitMax, 500),
      cacheTtlMs: ttlOf(group, 60000),
      serverFilter: group.serverFilter !== false,
      maxCacheEntries: positive(group.maxCacheEntries, 50),
      stockScanMax: positive(group.stockScanMax, 500),
    };
  })();

  /**
   * ⭐ `listLabels` 的两次全表读（**只缓存原始记录**；筛选 /「最近新增」**每请求现算**）。
   * 读序仍是「实时库存 → 货品信息」（与改动前逐字一致）。
   */
  const loadLabelListTables = async () => {
    const records = await gateway.listAll('liveInventory');
    const productRecords = await gateway.listAll('product');
    return {
      value: { records, productRecords },
      meta: {
        scanned_records: (records || []).length,
        product_records: (productRecords || []).length,
      },
    };
  };

  const labelListCache = createShortTtlCache({
    now,
    ttlMs: ttlOf(config.labelList, 60000),
    event: 'workbench.labels',
    load: loadLabelListTables,
  });

  /**
   * 「货品信息」的创建时间列候选名（见上面那段说明）。
   * 只有「最近新增」真的要用时才解析（平时**一次都不问**，不给这条只读链路加请求）。
   */
  const resolveProductCreatedTimeFields = async (productRecords) => {
    const createdTimeConfig = config.productCreatedTime || {};
    // ⚠️ 兼容 #580 那个「可注入、没配用兜底」的旧口径（`fieldNamesPendingSchema.productCreatedTime`）——
    //    现在它只是**后备**：正规的家是 `config.productCreatedTime`（见 `config/labelPrint.js`）。
    const configuredName = String(
      createdTimeConfig.fieldName || config.fieldNamesPendingSchema?.productCreatedTime || '',
    ).trim();
    const fieldType = Number.isInteger(createdTimeConfig.fieldType) ? createdTimeConfig.fieldType : 1001;
    // ① 配置里的那一列**这次读到的记录里真的在**（任意一条带这个键）⇒ 直接用它，**零额外请求**。
    const hasConfiguredColumn = configuredName
      && (productRecords || []).some((record) => Object.prototype.hasOwnProperty.call(record?.fields || {}, configuredName));
    if (hasConfiguredColumn) return [configuredName];
    // 「货品信息」这次一条记录都没有 ⇒ 无从判断列名，也就没必要去问字段表（读了也没有值可读）。
    if (!productRecords || !productRecords.length) return configuredName ? [configuredName] : [];
    if (typeof gateway.listFields !== 'function') return configuredName ? [configuredName] : [];
    let fields = [];
    try {
      fields = (await gateway.listFields('product')) || [];
    } catch (error) {
      // 读不到字段表 ⇒ 如实 warn（不能"安静地按没有创建时间处理"）。
      logWarn('workbench.labels.product_created_time_unresolved', {
        error: error.message,
        hint: '读「货品信息」的字段表失败，没有库存的编号在这次「最近新增」里按"读不到创建时间"处理（会计数并 warn，不静默）',
      });
      return configuredName ? [configuredName] : [];
    }
    const created = fields.find((field) => Number(field?.type) === fieldType);
    const name = created ? String(created.field_name || '').trim() : '';
    if (!name) {
      logWarn('workbench.labels.product_created_time_unresolved', {
        configured_name: configuredName || undefined,
        field_type: fieldType,
        hint: '「货品信息」里没有飞书自动的创建时间列（字段类型 = config 的 productCreatedTime.fieldType），没有库存的编号用不了「最近新增」筛选',
      });
      return configuredName ? [configuredName] : [];
    }
    if (configuredName && configuredName !== name) {
      // ⚠️ **表改名闸门拦不住**的那类：配置里的名字跟真表对不上了 —— 按类型认出来了，但必须**如实说**。
      logWarn('workbench.labels.product_created_time_renamed', {
        configured_name: configuredName,
        resolved_name: name,
        resolved_by: 'field_type',
        hint: '配置里「货品信息」创建时间列的名字跟真表对不上了（她改过名），这次按飞书字段类型（config 里的 productCreatedTime.fieldType）认出来了；请把 config/labelPrint.js 的 productCreatedTime.fieldName 改成真表的名字',
      });
      return [name];
    }
    logInfo('workbench.labels.product_created_time_resolved', {
      field_name: name,
      source: 'field_type',
    });
    return [name];
  };

  /**
   * 她按条件挑出要打的货 → **每个编号一张标签**、每张印什么。
   *
   * ⭐ 2026-10-15：数据源 = **「货品信息」∪「实时库存」**（按**编号**去重，见文件头）。
   *
   * filters（全部可选，可组合）：
   *   keyword     编号 / 货号 / 颜色 / 类别（库存那批还有「品类」）的模糊包含（大小写不敏感）
   *   state       「所属状态」精确匹配（空 = 不限）—— 只影响**哪些库存算进来**；
   *               ⚠️ 没有库存行的编号**不参与**（所属状态无从得知）⇒ 排除并计数，**不静默**
   *   category    「品类」（库存那批）/「类别」（没有库存的那批）精确匹配（空 = 不限）
   *   size        尺码精确匹配（空 = 不限）—— 只印这个尺码（该编号其余尺码不进这一轮）；
   *               ⚠️ 没有库存行的编号**不参与**（尺码无从得知）⇒ 排除并计数，**不静默**
   *   recentDays  「最近新增」= 创建时间在最近 N 天内（0 = 不限）：有库存的看「实时库存.创建时间」，
   *               没有库存的看「货品信息」那个**创建时间列**（按飞书字段类型 1001 解析，见常量说明）
   *   sort        'shelf'（默认，货架顺序）| 'recent'（最近新增在前）
   */
  const listLabels = async (filters = {}) => {
    const table = V1_BITABLE_SCHEMA.tables.liveInventory;
    const fieldNames = table?.fields || {};
    if (!fieldNames.stockKey || !fieldNames.state) {
      throw new Error('「实时库存」缺少必要的字段映射（库存键 / 所属状态），请先补 v1BitableSchema.liveInventory');
    }
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    const createdTimeField = config.fieldNamesPendingSchema?.createdTime || '';

    const keyword = String(filters.keyword ?? '').trim();
    const state = String(filters.state ?? '').trim();
    const category = String(filters.category ?? '').trim();
    const size = requireInteger(filters.size, '尺码');
    const recentDays = requireInteger(filters.recentDays, '最近新增天数') ?? config.filters.defaultRecentDays;
    if (recentDays > config.limits.maxRecentDays) {
      throw userError(`最近新增最多只能看 ${config.limits.maxRecentDays} 天`);
    }
    const sort = String(filters.sort ?? '').trim() || config.filters.defaultSort;
    if (!Object.prototype.hasOwnProperty.call(config.sortModes, sort)) {
      throw userError(`排序方式只能是：${Object.keys(config.sortModes).join(' / ')}`);
    }

    // ── 读一 / 读二：「实时库存」＋「货品信息」两张整表（**短 TTL 缓存**；分页由网关负责）──
    //    ⚠️ 缓存里只有**原始记录**：下面所有筛选 / 排序 /「最近新增」的时间判断**每请求现算** ✗
    //       （连筛选结果一起缓存会串数据 —— 她 A 条件看到的清单跑到 B 条件上）。
    const { records, productRecords } = await labelListCache.get();

    const skipped = { stock_key: 0, state: 0 };
    let rows = [];
    // ⭐ 「**有库存行**的编号」集合 —— 只认「库存键」解析得出的编号（**与所属状态无关**：
    //    所属状态为空的那条仍然是"入库过"的行，只是不参与标签）。
    //    它就是「货品信息 ∪ 实时库存」的**去重判据**：在这里面 ⇒ 走库存那一套；不在 ⇒ 出新品标签。
    const stockedNumbers = new Set();
    for (const record of records || []) {
      const key = parseStockKey(record?.fields?.[fieldNames.stockKey]);
      if (key) stockedNumbers.add(compoundNumber(key.itemNo, key.color, key.category));
      const row = rowFromRecord(record, { fieldNames, createdTimeField });
      if (!row) {
        // 分辨"是库存键不完整还是所属状态为空"，只为了日志/提示能说清；不改变"跳过"这个结论。
        if (key) skipped.state += 1;
        else skipped.stock_key += 1;
        continue;
      }
      rows.push(row);
    }
    const parsedTotal = rows.length;

    // ── 「货品信息」那份记录**已在上面同一个缓存快照里**一起读回来了（不再第二次 listAll）──
    const brandFieldName = config.brand?.from === 'table' ? String(config.brand.tableFieldName || '').trim() : '';
    const productCreatedTimeFields = recentDays > 0
      ? await resolveProductCreatedTimeFields(productRecords)
      : [];
    const productIndex = buildProductIndex(productRecords, productFields, brandFieldName, productCreatedTimeFields);

    // ⭐ **没有库存行、但在「货品信息」里的编号 ⇒ 每个编号一张「新品标签」**
    //    （`sizes` = 空数组 ⇒ 页面**不印「尺码」那一行**，这是她要的版式）。
    let withoutStock = [];
    for (const [number, product] of productIndex) {
      if (stockedNumbers.has(number)) continue;
      withoutStock.push({ number, product });
    }

    // ── 「最近新增」筛选：有库存的看「实时库存.创建时间」，没有库存的看「货品信息」那个创建时间列 ──
    let missingCreatedAt = 0;
    let missingCreatedAtWithoutStock = 0;
    if (recentDays > 0) {
      const available = rows.some((row) => row.created_at > 0)
        || withoutStock.some((item) => item.product.created_at > 0);
      if (!available) {
        // **不静默**：宁可她看到一句"读不到创建时间"，也不要"筛了等于没筛"或"一张都不剩"。
        throw new Error('读不到「实时库存」/「货品信息」的创建时间列，暂时不能用「最近新增」筛选');
      }
      const cutoff = now() - recentDays * 24 * 60 * 60 * 1000;
      rows = rows.filter((row) => {
        if (row.created_at > 0) return row.created_at >= cutoff;
        missingCreatedAt += 1;
        return false;
      });
      withoutStock = withoutStock.filter((item) => {
        if (item.product.created_at > 0) return item.product.created_at >= cutoff;
        missingCreatedAt += 1;
        missingCreatedAtWithoutStock += 1;
        return false;
      });
    }

    // ── 条件筛选（编号 / 货号 / 颜色 / 类别 模糊；状态 / 品类 / 尺码 精确）────────
    // 「品类」下拉的候选 = 从**解析出来的全部记录 + 没有库存的那批**去重（在筛选之前算，
    // 否则她越筛选项越少）；与筛选用的是同一个来源 ⇒ 选了一定有结果，不会"选了某个品类却 0 张"。
    const categoryOptions = [...new Set([
      ...rows.map((row) => row.category),
      ...withoutStock.map((item) => item.product.category),
    ].filter(Boolean))].sort((left, right) => String(left).localeCompare(String(right), 'zh-CN'));
    const normalizedKeyword = keyword.toLowerCase();
    const matchesKeyword = (values) => !normalizedKeyword
      || values.some((value) => String(value ?? '').toLowerCase().includes(normalizedKeyword));

    // ⭐ **没有库存的那批：`size` / `state` 两个条件它不参与**（尺码与所属状态无从得知）——
    //    排除 + **计数**（响应 `without_stock_skipped` ＋ 一条 warn），**绝不静默丢** ✗。
    const withoutStockSkipped = [];
    const withoutStockKept = [];
    for (const item of withoutStock) {
      if (!matchesKeyword([item.number, item.product.item_no, item.product.color, item.product.category])) continue;
      if (category && item.product.category !== category) continue;
      if (size !== null || state) { withoutStockSkipped.push(item); continue; }
      withoutStockKept.push(item);
    }

    rows = rows.filter((row) => {
      if (state && row.state !== state) return false;
      if (category && row.category !== category) return false;
      if (size !== null && row.size !== size) return false;
      return matchesKeyword([numberOf(row), row.item_no, row.color, row.category]);
    });

    // ── 按**编号**聚合（一张标签 = 一个编号）───────────────────────────────
    // 尺码 → 数量：一条「实时库存」= 一双 ⇒ **数量 = 这个编号 + 这个尺码的库存条数**
    // （同款同码有几双 = 角标上的数字；老版式里"有几双就出几张标签"的行为已按她的新定案改掉）。
    const groups = new Map();
    for (const row of rows) {
      const number = numberOf(row);
      let group = groups.get(number);
      if (!group) {
        group = {
          number,
          item_no: row.item_no,
          color: row.color,
          category_code: row.category_code,
          category: row.category,
          sizes: new Map(),
          states: new Set(),
          record_ids: [],
          created_at: 0,
          without_stock: false,
        };
        groups.set(number, group);
      }
      group.sizes.set(row.size, (group.sizes.get(row.size) || 0) + 1);
      group.states.add(row.state);
      group.record_ids.push(row.record_id);
      if (row.created_at > group.created_at) group.created_at = row.created_at;
    }
    // ⭐ 没有库存行的编号：`sizes` / `states` / `record_ids` **都是空的**（**不许编一个尺码出来** ✗）。
    for (const item of withoutStockKept) {
      if (groups.has(item.number)) continue;
      groups.set(item.number, {
        number: item.number,
        item_no: item.product.item_no,
        color: item.product.color,
        category_code: item.product.category_code,
        category: item.product.category,
        sizes: new Map(),
        states: new Set(),
        record_ids: [],
        created_at: item.product.created_at || 0,
        without_stock: true,
      });
    }

    // ── 排序（货架顺序：货号 → 颜色 → 类别；最近新增：组内最新的那条在前）──────
    const shelfCompare = (left, right) => String(left.item_no).localeCompare(String(right.item_no), 'zh-CN')
      || String(left.color).localeCompare(String(right.color), 'zh-CN')
      || String(left.category_code).localeCompare(String(right.category_code), 'zh-CN');
    const ordered = [...groups.values()].sort(sort === 'recent'
      ? (left, right) => (right.created_at - left.created_at) || shelfCompare(left, right)
      : shelfCompare);

    // ── 截断（**不静默**：matched/truncated 都回给页面）─────────────────────
    const maxLabels = config.limits.maxLabels;
    const matchedTotal = ordered.length;
    const truncated = matchedTotal > maxLabels;
    const visible = ordered.slice(0, maxLabels);
    const totalPairs = ordered.reduce((sum, group) => sum + group.record_ids.length, 0);

    // ── 每张标签要印什么（先同步算完数据，再异步出二维码 SVG）──────────────
    // ⚠️ 2026-10-15：「货品信息」那次读**已经上移到"读二"**了（没有库存的编号也要靠它出标签，
    //    不能等到截断之后才读）—— 这里不再有第二次 listAll。
    const stateRank = (value) => {
      const index = config.filters.stateOptions.indexOf(value);
      return index === -1 ? config.filters.stateOptions.length : index;
    };
    let missingPrice = 0;
    let missingPriceNoProduct = 0;
    // ⭐ 这一轮有几张标签**拿不到记录 ID**（那条编号在「货品信息」里没有对应记录）⇒ 二维码退回编号版。
    let missingQrRecordId = 0;
    const prepared = visible.map((group) => {
      const product = productIndex.get(group.number) || null;
      const price = product ? product.price : null;
      // ⚠️ 读不到单价**照发标签**、只是不印价格，并**计数提示**（不许静默丢标签）。
      const priceMissing = config.fields?.price === true && price === null;
      if (priceMissing) {
        missingPrice += 1;
        if (!product) missingPriceNoProduct += 1;
      }
      const priceText = config.fields?.price ? formatPrice(price, config.price) : '';
      const sizes = [...group.sizes.entries()]
        .map(([sizeValue, quantity]) => ({ size: sizeValue, qty: quantity }))
        // 尺码**按数值升序**（她 2026-10-08 定案：「按照从小到大排序」）—— 比较方式与方向都来自 config。
        .sort((left, right) => compareSizes(left.size, right.size, config.sizes));
      const { lines, overflow } = buildSizeLines(sizes, config.sizes);
      const states = [...group.states].sort((left, right) => stateRank(left) - stateRank(right));
      const totalQty = sizes.reduce((sum, item) => sum + item.qty, 0);
      const brandText = (brandFieldName && product?.brand) || String(config.brand?.text ?? '');
      // ⭐ 二维码里装**记录 ID**（接口读到的那个，见 buildProductIndex 的注释）。
      // ⚠️ 编号在「货品信息」里找不到对应记录 ⇒ **退回旧的编号版 URL** + 计数（**不静默丢码** ✗；
      //    那张码扫开仍能看货品，只是"扫码打印"不认它 —— 会给她一句"重打新标签"的人话）。
      const productRecordId = String(product?.record_id || '').trim();
      let scanUrl;
      if (productRecordId) {
        scanUrl = buildLabelScanUrl(productRecordId);
      } else {
        missingQrRecordId += 1;
        scanUrl = '';
      }
      const footerValues = {
        number: group.number,
        itemNo: group.item_no,
        color: group.color,
        category: group.category,
        sizes: sizes.map((item) => `${item.size}×${item.qty}`).join(' '),
        totalQty,
        price: priceText,
        state: states.join(config.texts.stateSeparator),
      };
      return {
        // 一张标签一个唯一键 = 一个**编号**（同一编号的库存都聚合到这一张上）。
        key: group.number,
        number: group.number,
        item_no: group.item_no,
        color: group.color,
        // 标签上印的「品类」（休闲鞋 / 单鞋…）；`category_code` 是编号里那一段（A / B）。
        category: group.category,
        category_code: group.category_code,
        // 该编号下**有库存的**尺码 + 数量（升序）；标签上按 `sizes.perLine` 自动分行。
        sizes,
        size_lines: lines,
        size_overflow: overflow,
        total_qty: totalQty,
        states,
        // 所属状态**默认不印**（见 FIELDS.state），要印时用这个拼好的文本。
        state_text: states.join(config.texts.stateSeparator),
        // 价格：`price` 是数值（没有 = null），`price_text` 是印出来的字（没有 = 空串）。
        price,
        price_text: priceText,
        brand_text: config.fields?.brand ? brandText : '',
        // 这一个编号是由哪几条「实时库存」聚合出来的（排障 / 对数用）。
        record_ids: group.record_ids,
        record_count: group.record_ids.length,
        // ⭐ 2026-10-15：这个编号**在「实时库存」里有没有行**。
        //    `false` = 还在「货品信息」里、没入库的新货 ⇒ `sizes` 一定是空数组
        //    （页面据此**不印「尺码 + 库存数量」那一行**，她选的版式）。
        has_stock: group.without_stock !== true,
        created_at: group.created_at ? new Date(group.created_at).toISOString() : '',
        scan_url: scanUrl,
        footer_text: buildText(config.footer.template, footerValues, config.texts.missingValue),
      };
    });

    const labels = await Promise.all(prepared.map(async (label) => ({
      ...label,
      qr_svg: config.fields?.qr && label.scan_url
        ? await QRCode.toString(label.scan_url, {
          type: 'svg',
          errorCorrectionLevel: config.qr.errorCorrectionLevel,
          margin: config.qr.marginModules,
          color: { dark: config.qr.darkColor, light: config.qr.lightColor },
        })
        : '',
    })));

    const grid = resolveGrid(config);
    // ⭐ 2026-10-15：这一轮标签的**来路**（有库存 / 还没入库）—— 真机排查时一眼看出"新货有没有进来"。
    const withStockMatched = ordered.filter((group) => group.without_stock !== true).length;
    const withoutStockMatched = matchedTotal - withStockMatched;
    const productRecordsNoNumber = (productRecords || [])
      .filter((record) => !(productFields.number ? textValue(record?.fields?.[productFields.number]).trim() : ''))
      .length;
    logInfo('workbench.labels.listed', {
      keyword: keyword || undefined,
      state: state || undefined,
      category: category || undefined,
      size: size === null ? undefined : size,
      recent_days: recentDays || undefined,
      sort,
      scanned_records: (records || []).length,
      parsed_records: parsedTotal,
      product_records: (productRecords || []).length,
      product_records_no_number: productRecordsNoNumber || undefined,
      // ⭐ 有库存的编号 / 还没有库存行的编号（**两张来路各多少张**）。
      with_stock: withStockMatched,
      without_stock: withoutStockMatched,
      // ⭐ 因为按尺码/所属状态筛，被排除的**还没有库存的编号**数（响应同名字段，**不静默**）。
      without_stock_skipped: withoutStockSkipped.length || undefined,
      matched_labels: matchedTotal,
      matched_pairs: totalPairs,
      returned_labels: labels.length,
      truncated: truncated || undefined,
      skipped_stock_key: skipped.stock_key || undefined,
      skipped_state: skipped.state || undefined,
      missing_created_at: missingCreatedAt || undefined,
      missing_created_at_without_stock: missingCreatedAtWithoutStock || undefined,
      missing_price: missingPrice || undefined,
      missing_price_no_product: missingPriceNoProduct || undefined,
      missing_qr_record_id: missingQrRecordId || undefined,
    });
    if (withoutStockSkipped.length) {
      // **不静默**：这几个编号在「货品信息」里、但「实时库存」里一行都没有 ⇒
      // 按尺码 / 所属状态筛的时候它们**无从判断**，所以这一轮不参与。
      // ⚠️ hint 写成**一条字面量**、串里不带花括号（守门用例靠最近的 `;` / `}` 认日志语句）。
      logWarn('workbench.labels.without_stock_skipped', {
        without_stock_skipped: withoutStockSkipped.length,
        filtered_by_size: size !== null,
        filtered_by_state: Boolean(state),
        hint: '这些编号在「货品信息」里、但「实时库存」里还没有行，尺码与所属状态无从得知，所以按尺码或所属状态筛的时候它们不参与；去掉这两个条件就能看到它们',
      });
    }
    if (missingCreatedAtWithoutStock) {
      // **不静默**：没有库存的那批读不到「货品信息」的创建时间列 ⇒ 「最近新增」筛不了它们（如实计数）。
      logWarn('workbench.labels.without_stock_missing_created_at', {
        missing_created_at_without_stock: missingCreatedAtWithoutStock,
        hint: '「货品信息」的创建时间列读不出来，这些还没有库存的编号在「最近新增」里被排除；请核对那一列的字段类型（飞书自动字段 CreatedTime / type 1001）',
      });
    }
    if (skipped.stock_key || skipped.state) {
      logWarn('workbench.labels.skipped_records', {
        skipped_stock_key: skipped.stock_key,
        skipped_state: skipped.state,
        hint: '「实时库存」里有读不出「库存键」四段或「所属状态」为空的记录，这些记录没有出现在标签里',
      });
    }
    if (missingPrice) {
      logWarn('workbench.labels.missing_price', {
        missing_price: missingPrice,
        missing_price_no_product: missingPriceNoProduct,
        hint: '按「编号」在「货品信息」里取「单价」，这些编号没有读到价格 —— 标签照常打印，只是不印价格',
      });
    }
    if (missingQrRecordId) {
      // **不静默**：这几张标签的二维码退回旧的编号版（扫开能看货品，但"扫码打印"不认它）。
      // ⚠️ 这句写成**一条字面量**（不跨 `+` 拼接、串里也不带花括号）—— 守门用例
      //    `noHardcodedChinese.test.js` 靠"最近一个 `;` / `}`"认日志语句，串里带 `}` 会把它截断 ⇒ 误报 ✗。
      logWarn('workbench.labels.missing_qr_record_id', {
        missing_qr_record_id: missingQrRecordId,
        hint: '这些编号在「货品信息」里没有对应记录 ⇒ 二维码退回旧的编号版格式；扫码打印只认记录 ID 版（她会收到"请重打新标签"的人话）',
      });
    }

    return {
      generated_at: new Date(now()).toISOString(),
      // ⚠️ 单位变了：`total_matched` 现在是**标签张数 = 编号个数**（不是库存双数）；
      //    `total_pairs` 才是这些编号一共有多少双库存（她按"还剩几双"对数时用这个）。
      total_matched: matchedTotal,
      total_returned: labels.length,
      total_pairs: totalPairs,
      // ⭐ 2026-10-15：匹配到的这些标签里，**有库存的** / **还没有入库的**各多少张
      //    （`without_stock` 那批的 `sizes` 一定是空数组 ⇒ 页面不印「尺码 + 数量」那一行）。
      total_with_stock: withStockMatched,
      total_without_stock: withoutStockMatched,
      truncated,
      max_labels: maxLabels,
      skipped_records: {
        stock_key: skipped.stock_key,
        state: skipped.state,
        total: skipped.stock_key + skipped.state,
      },
      // ⭐ 按 `size` / `state` 筛时被排除的**还没有库存的编号**数（**不静默**：同一件事还有一条 warn）。
      without_stock_skipped: withoutStockSkipped.length,
      missing_created_at: missingCreatedAt,
      missing_created_at_without_stock: missingCreatedAtWithoutStock,
      missing_price: missingPrice,
      missing_price_no_product: missingPriceNoProduct,
      // ⭐ 二维码拿不到记录 ID 的张数（那几张退回了旧的编号版 URL，见上面的 warn 日志）。
      missing_qr_record_id: missingQrRecordId,
      filters: {
        keyword,
        state,
        category,
        size,
        recent_days: recentDays,
        sort,
        state_options: config.filters.stateOptions,
        category_options: categoryOptions,
        recent_day_options: config.filters.recentDayOptions,
        sort_modes: config.sortModes,
      },
      // 排版参数（**怎么摆**）——页面把它落到 CSS 变量与 `@page` 上，逻辑里不写死 mm。
      // `body` = 品牌摆哪（默认**顶部居中**）+ 右栏自上而下的行序 + 货号+颜色同行的超宽规则。
      layout: {
        label: config.label,
        page: config.page,
        grid: { ...grid, gapXMm: config.grid.gapXMm, gapYMm: config.grid.gapYMm },
        typography: config.typography,
        sizes: config.sizes,
        body: config.body,
        fields: config.fields,
        texts: config.texts,
      },
      // 二维码 URL 的**出处**也回给页面（让她一眼看到码里是什么域名，且只有一个来源）。
      // ⭐ 2026-10-14：主模板 = **记录 ID 版**（她 2026-10-12 定案）；`fallback_url_template` =
      //    那条编号在「货品信息」里找不到记录时退回的旧版（见 `missing_qr_record_id`）。
      qr: {
        url_template: SCAN_URL.recordIdTemplate,
        source: 'config/tagQrCode.js#SCAN_URL',
      },
      labels,
    };
  };

  /**
   * ⭐⭐ 「扫码打印」的**按记录 ID 精确一张**（2026-10-14）。
   *
   * 链路：扫到的 `/r/{记录 ID}` ⇒ 本方法 ⇒ **恰好这一款的那一张**标签（0 张 ⇒ 400 + 人话）。
   *   · 记录 ID 来自**接口读到的那一份**（她 2026-10-12：公式列有延迟 ⇒ 以接口值为准）；
   *   · 读法 = `gateway.get('product', recordId)` **只读一条**（不整表读、不按编号猜 ✗）；
   *   · 再用**既有** `listLabels({ keyword })` 挑标签（"印什么"逻辑一个字都不重写 ✓），
   *     最后**按编号精确筛到那一张**（一个货号可以有多个颜色/类别 ⇒ 不筛就会多打 ✗）。
   *   · **不新增筛选语义**：本方法不进 `listLabels` 的 filters，`keyword/state/category/size` 一条都没改。
   */
  const labelForRecord = async (recordId) => {
    const texts = scanPrintTextsOf(config);
    const id = String(recordId || '').trim();
    if (!id) throw userError(texts.notLabelCode);
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    if (!productFields.number) {
      throw new Error('「货品信息」缺少必要的字段映射（编号），请先补 v1BitableSchema.product');
    }
    let record = null;
    try {
      record = await gateway.get('product', id);
    } catch (error) {
      // 读不到那一条（记录被删 / 跨 Base）⇒ **人话**，不是 500（与扫码页同一条口径）。
      logWarn('workbench.labels.record_read_failed', { product_record_id: id, error: error.message });
      throw userError(texts.recordMissing);
    }
    if (!record) throw userError(texts.recordMissing);
    const number = textValue(record?.fields?.[productFields.number]).trim();
    if (!number) throw userError(texts.recordNoNumber);

    const data = await listLabels({ keyword: number.split('|')[0] || number });
    const exact = (data.labels || []).filter((label) => label.number === number);
    if (!exact.length) throw userError(texts.noStock);
    logInfo('workbench.labels.record_resolved', {
      product_record_id: id,
      number,
      labels: exact.length,
    });
    return { ...data, labels: exact, total_matched: exact.length, total_returned: exact.length };
  };

  /**
   * ⭐⭐ 2026-10-15（task-10）：**编号底表**（`GET /products/numbers` 那两次全表读的产物）。
   *
   * · **与请求无关**（keyword / limit 每请求现算）⇒ 整份快照交给**共用的** `createShortTtlCache`
   *   （task-11 收敛：`listLabels` 用的是**同一个** factory，不抄第二份 ✗）；
   * · TTL / 命中日志口径见 `createShortTtlCache` 的说明（事件前缀 `workbench.products.numbers`）。
   */
  const loadProductNumbersSnapshot = async () => {
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    const inventoryFields = V1_BITABLE_SCHEMA.tables.liveInventory?.fields || {};

    // ── 读一：「货品信息」整张（这个端点的主数据）────────────────────────────
    const products = await gateway.listAll('product');

    // ── 读二：「实时库存」整张（只为回答"这个编号有没有入库过"；只用它的「库存键」）──
    const stockRecords = await gateway.listAll('liveInventory');
    const stockedNumbers = new Set();
    for (const record of stockRecords || []) {
      const key = parseStockKey(record?.fields?.[inventoryFields.stockKey]);
      if (key) stockedNumbers.add(compoundNumber(key.itemNo, key.color, key.category));
    }

    // ── 「货品信息」→ 编号去重（同一个编号取**第一条**记录，与 `buildProductIndex` 同一口径）──
    const seen = new Set();
    const numbers = [];
    let withoutNumber = 0;
    for (const record of products || []) {
      const number = textValue(record?.fields?.[productFields.number]).trim();
      if (!number) { withoutNumber += 1; continue; }
      if (seen.has(number)) continue;
      seen.add(number);
      const parts = partsOfNumber(number);
      const itemNo = (productFields.itemNo ? textValue(record?.fields?.[productFields.itemNo]).trim() : '') || parts.item_no;
      const color = (productFields.color ? textValue(record?.fields?.[productFields.color]).trim() : '') || parts.color;
      const category = (productFields.category ? textValue(record?.fields?.[productFields.category]).trim() : '') || parts.category_code;
      numbers.push({
        number,
        itemNo,
        color,
        category,
        hasStock: stockedNumbers.has(number),
        recordId: String(record?.record_id || ''),
      });
    }

    const productRecordsNoNumber = withoutNumber;
    return {
      // `value` = 与请求无关的编号底表（listProductNumbers 只读它；keyword/limit 现算）。
      value: {
        numbers,
        product_records: (products || []).length,
        product_records_no_number: productRecordsNoNumber,
        stock_records: (stockRecords || []).length,
      },
      // `meta` 只进缓存命中/未命中日志（口径与 #582 落地的那两条一致）。
      meta: {
        numbers: numbers.length,
        product_records: (products || []).length,
        product_records_no_number: productRecordsNoNumber || undefined,
        stock_records: (stockRecords || []).length,
      },
    };
  };

  const productNumbersFullCache = createShortTtlCache({
    now,
    ttlMs: numbersLimits.cacheTtlMs,
    event: 'workbench.products.numbers',
    load: loadProductNumbersSnapshot,
  });

  /**
   * ⭐ **老路径**（`serverFilter` 关掉 / 网关没有按条件读能力时才走）：整表底表（缓存）+ 内存过滤。
   * ⚠️ 它**不是死代码**：它是这个端点的**退路**，也是"服务端过滤不好用"时的开关（配置驱动）。
   */
  const listProductNumbersFromFullTable = async ({ keyword, limit, startedAt }) => {
    const snapshot = await productNumbersFullCache.get();
    const needle = keyword.toLowerCase();
    const matched = snapshot.numbers
      .filter((item) => [item.number, item.itemNo, item.color, item.category]
        .some((value) => String(value ?? '').toLowerCase().includes(needle)))
      // 排序**稳定、可预期**：按编号中文序升序。
      .sort((left, right) => String(left.number).localeCompare(String(right.number), 'zh-CN'));
    const total = matched.length;
    const truncated = total > limit;
    const page = matched.slice(0, limit);
    logInfo('workbench.products.numbers.listed', {
      source: 'full_table',
      keyword: keyword || undefined,
      limit,
      product_records: snapshot.product_records,
      product_records_no_number: snapshot.product_records_no_number || undefined,
      stock_records: snapshot.stock_records,
      total,
      returned: page.length,
      with_stock: matched.filter((item) => item.hasStock === true).length,
      without_stock: matched.filter((item) => item.hasStock === false).length,
      truncated: truncated || undefined,
      elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
    });
    return { total, truncated, numbers: page };
  };

  /**
   * ⭐⭐ task-15：**按条件读**（飞书 `filter`）—— 让飞书**只回匹配的那几条**，不再读整表。
   *
   * 两次读**并行**（`Promise.all`：两张表互不依赖 ⇒ 省掉一次串行的等待）；
   * `load(key)` 的 key = **小写关键字**（`.contains` 实测大小写不敏感 ⇒ 同一个关键字只占一个缓存槽）。
   *
   * `hasStock` 的**如实**口径（绝不许猜 ✗）：
   *   · 库存那次过滤读用的是**同一个关键字**；而"命中编号"按定义**含这个关键字**
   *     ⇒ 该编号的库存行**一定也在**这次返回里 ⇒ **没查到 = 真的没有库存**（`false`）✓；
   *   · 三种情况**只回 `null`（未知）**：① 库存那次读**失败**；② 库存读**撞到扫描上限**
   *     （可能还有没看全的行）；③ 这个编号**本身不含**关键字（例：靠「货号」命中的那种边角）
   *     ⇒ 上面那条推理**不成立** ⇒ 不许说 `false` ✗。
   */
  const loadFilteredProductNumbers = async (keyword) => {
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    const inventoryFields = V1_BITABLE_SCHEMA.tables.liveInventory?.fields || {};
    const productFilter = productNumbersFilterOf(productFields, keyword);
    if (!productFilter) {
      // 关键字里带了**拼不进公式**的字符 ⇒ 如实告诉她（**不硬拼**；错的数据比慢更坏 ✗）。
      throw userError('编号里不能有引号 / 反斜杠 / 方括号这类符号，请只输编号、货号、颜色或类别');
    }
    const stockFilter = containsFormula(inventoryFields.stockKey, keyword);
    const [rows, stockRows] = await Promise.all([
      gateway.listByFilter('product', productFilter, { maxRecords: numbersLimits.maxLimit + 1 }),
      (stockFilter
        ? gateway.listByFilter('liveInventory', stockFilter, { maxRecords: numbersLimits.stockScanMax + 1 })
        : Promise.resolve([])
      ).catch((error) => {
        // 库存那次读失败 ⇒ **不猜**（下面一律回 `hasStock: null`），并如实 warn。
        logWarn('workbench.products.numbers.stock_read_failed', {
          error: error.message,
          hint: '「实时库存」那次按条件读失败了 ⇒ 这一轮的编号一律回 hasStock=null（未确认），绝不猜成"没入库"',
        });
        return null;
      }),
    ]);

    const stockedNumbers = new Set();
    for (const record of stockRows || []) {
      const key = parseStockKey(record?.fields?.[inventoryFields.stockKey]);
      if (key) stockedNumbers.add(compoundNumber(key.itemNo, key.color, key.category));
    }
    const stockUnknown = stockRows === null;
    const stockCapHit = !stockUnknown && (stockRows || []).length > numbersLimits.stockScanMax;

    const needle = keyword.toLowerCase();
    const seen = new Set();
    const numbers = [];
    let withoutNumber = 0;
    for (const record of rows || []) {
      const number = textValue(record?.fields?.[productFields.number]).trim();
      if (!number) { withoutNumber += 1; continue; }
      if (seen.has(number)) continue;
      seen.add(number);
      const parts = partsOfNumber(number);
      const itemNo = (productFields.itemNo ? textValue(record?.fields?.[productFields.itemNo]).trim() : '') || parts.item_no;
      const color = (productFields.color ? textValue(record?.fields?.[productFields.color]).trim() : '') || parts.color;
      const category = (productFields.category ? textValue(record?.fields?.[productFields.category]).trim() : '') || parts.category_code;
      let hasStock;
      if (stockedNumbers.has(number)) hasStock = true;
      else if (stockUnknown || stockCapHit || !number.toLowerCase().includes(needle)) hasStock = null;
      else hasStock = false;
      numbers.push({
        number,
        itemNo,
        color,
        category,
        hasStock,
        recordId: String(record?.record_id || ''),
      });
    }
    numbers.sort((left, right) => String(left.number).localeCompare(String(right.number), 'zh-CN'));

    const capHit = (rows || []).length > numbersLimits.maxLimit;
    return {
      value: {
        numbers,
        product_records: (rows || []).length,
        stock_records: (stockRows || []).length,
        cap_hit: capHit,
        read: true,
      },
      meta: {
        keyword_length: keyword.length,
        numbers: numbers.length,
        product_records: (rows || []).length,
        product_records_no_number: withoutNumber || undefined,
        stock_records: (stockRows || []).length,
        stock_unknown: stockUnknown || undefined,
        cap_hit: capHit || undefined,
      },
    };
  };

  const productNumbersKeywordCache = createShortTtlCache({
    now,
    ttlMs: numbersLimits.cacheTtlMs,
    event: 'workbench.products.numbers',
    maxEntries: numbersLimits.maxCacheEntries,
    load: loadFilteredProductNumbers,
  });

  /**
   * ⭐⭐ 2026-10-15：`GET /api/workbench/products/numbers` 的取数（**只读**）。
   *
   * 契约（**冻结**）：
   *   `{ total, truncated, numbers: [{ number, itemNo, color, category, hasStock, recordId }] }`
   *   · **`keyword` 非空 ⇒ 服务端模糊查询**（飞书 `filter`，**只回匹配的那几条**，不再读整表）；
   *   · 🔴 **`keyword` 为空 ⇒ 空列表 + 一次飞书都不读**（她逐字：「用户输入一个编号，然后系统再给出
   *     与这个模糊编号相关的选项」⇒ 从根上取消"读全表"那条路径 ✗）；
   *   · `keyword` 按 编号 / 货号 / 颜色 / 类别 模糊（**大小写不敏感** —— 公式列 `编号` = `货号|颜色|类别`，
   *     所以只拼「编号 / 货号」两列就够，见 `productNumbersFilterOf` 的说明）；
   *   · `hasStock`：`true` / `false`（**真没有库存**）/ `null`（**未知**，前端显示"入库情况未确认"）
   *     —— 绝不把"没查全/没读成"说成 false ✗（口径见 `loadFilteredProductNumbers`）；
   *   · `limit`：1..500，默认 200；命中超过上限 ⇒ `truncated: true`（**不静默截断**）；
   *   · 排序：按「编号」`localeCompare('zh-CN')` 升序（稳定、可预期）。
   * 🔴 **只读诊断/查询**：不写任何业务表、不改任何状态（只有 `listByFilter` 两次读 + 日志）。
   *
   * ⭐⭐ 2026-10-15（task-10/11/15）三层性能口径，**都在 config**（`config/labelPrint.js`）：
   *   · `PRODUCT_NUMBERS.cacheTtlMs`（默认 60000；**0 = 关掉**）—— **按关键字分槽**的短 TTL 缓存
   *     （同一个关键字重复搜 ⇒ 秒开；A 关键字不会串到 B 关键字 ✗）；
   *   · `serverFilter`（默认开）—— 关掉就回退"整表读 + 内存过滤"那条老路（退路 + 开关）；
   *   · `maxCacheEntries` / `stockScanMax` —— 缓存槽位上限 / 库存那次扫描上限；
   *   · `limitDefault` / `limitMax`（默认 200 / 500）。
   * ⚠️ task-11 起 `listLabels`（批量 / 编号打印那一页）也走**同一个**缓存 factory
   *    （`config.labelList`）—— 各处一个实例、互不干扰。
   */
  const listProductNumbers = async (filters = {}) => {
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    if (!productFields.number) {
      throw new Error('「货品信息」缺少必要的字段映射（编号），请先补 v1BitableSchema.product');
    }

    const numbersConfig = config.productNumbers || {};
    const defaultLimit = numbersLimits.defaultLimit;
    const maxLimit = numbersLimits.maxLimit;
    const limitText = String(filters.limit ?? '').trim();
    let limit = defaultLimit;
    if (limitText) {
      if (!/^\d+$/.test(limitText) || Number(limitText) < 1) {
        throw userError(`limit 必须是 1 到 ${maxLimit} 之间的整数`);
      }
      limit = Number(limitText);
      if (limit > maxLimit) throw userError(`limit 最多 ${maxLimit}`);
    }
    const keyword = String(filters.keyword ?? '').trim();

    // ⭐⭐ task-15（她逐字：「**用户输入一个编号，然后系统再给出与这个模糊编号相关的选项**」）：
    //   ① **空关键字 = 一次飞书都不读**（从根上取消"读全表"那条路径 ✗）—— 前端会显示
    //      「输入编号 / 货号，我就列出匹配的编号」；
    //   ② 非空关键字 ⇒ **走"按条件读"**（飞书 `filter`，只回匹配的那几条）⇒ 第一次也快
    //      （原来要整表 554 个编号 ≈ 13.9 秒 ✗）。
    const startedAt = now();
    if (!keyword) {
      logInfo('workbench.products.numbers.filtered', {
        source: 'empty_keyword',
        read: false,
        keyword_length: 0,
        limit,
        total: 0,
        returned: 0,
        elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
      });
      return { total: 0, truncated: false, numbers: [] };
    }

    const serverFilterEnabled = numbersLimits.serverFilter
      && typeof gateway.listByFilter === 'function';
    if (!serverFilterEnabled) {
      // 配置关掉 / 假网关没有这个能力 ⇒ **回退老路径**（整表读 + 内存过滤），并**如实 warn**。
      const reason = numbersLimits.serverFilter === false ? 'disabled_by_config' : 'gateway_without_filter';
      logWarn('workbench.products.numbers.server_filter_off', {
        reason,
        hint: '这个端点没有走"按条件读"（飞书 filter），而是回退成整表读 + 内存过滤 —— 会慢很多；把 config/labelPrint.js 的 productNumbers.serverFilter 打开即可',
      });
      return listProductNumbersFromFullTable({ keyword, limit, startedAt });
    }

    // ⭐ 按**关键字**分槽的短 TTL 缓存（同一个关键字重复搜 ⇒ 秒开；A 关键字不会串到 B 关键字 ✗）。
    const snapshot = await productNumbersKeywordCache.get(keyword.toLowerCase());
    const matched = snapshot.numbers;
    const selected = matched.slice(0, limit);
    const truncated = snapshot.cap_hit || matched.length > limit;
    logInfo('workbench.products.numbers.filtered', {
      source: 'server_filter',
      read: snapshot.read,
      keyword_length: keyword.length,
      limit,
      product_records: snapshot.product_records,
      stock_records: snapshot.stock_records,
      total: matched.length,
      returned: selected.length,
      with_stock: matched.filter((item) => item.hasStock === true).length,
      without_stock: matched.filter((item) => item.hasStock === false).length,
      stock_unknown: matched.filter((item) => item.hasStock === null).length || undefined,
      cap_hit: snapshot.cap_hit || undefined,
      truncated: truncated || undefined,
      elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
    });
    return { total: matched.length, truncated, numbers: selected };
  };

  return { listLabels, labelForRecord, listProductNumbers };
};

module.exports = {
  createLabelPrintService,
  buildLabelScanUrl,
  parseLabelScanUrl,
  buildSizeLines,
  compareSizes,
  buildProductIndex,
  formatPrice,
  asAmount,
  compoundNumber,
  numberOf,
  partsOfNumber,
  createdAtOf,
  buildText,
  asTimestamp,
  rowFromRecord,
};
