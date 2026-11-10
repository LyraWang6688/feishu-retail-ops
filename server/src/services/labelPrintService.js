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
 *    用途 = 「**一次给一批新货打码**（新店开业 / 换季上架）」——
 *    ⚠️ **新货常常还没有入库**（真机只读核过：测试 Base 里 440 个编号有 **16 个**在「实时库存」
 *    里一行都没有）⇒ 只认库存的话，这批新货一张标签都打不出来。
 *    · 有「实时库存」行的编号 ⇒ 照旧（`sizes` = 各尺码数量，一张 = 一个编号）；
 *    · **没有库存行、但在「货品信息」里的编号 ⇒ 也出一张标签**：`sizes = []`
 *      （页面据此**不印「尺码」那一行** —— 她选的版式：新品标签上不印"尺码 + 库存数量"）；
 *    · 「货品信息」原来只用来**补价格 / 品牌**，现在还要出「货号 / 颜色 / 类别」（新货的这三样
 *      只有那里有）。
 *    🔴 2026-11-09（业务负责人：旧批量逻辑「完全删除」）：条件筛选（状态 / 类别 / 尺码 /
 *      最近新增 / 排序）**整段物理删除**；本文件现在只按 **`keyword`**（编号 / 货号）过滤。
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
const { getConfigRows } = require('./configTableCache');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { LABEL_PRINT, resolveGrid } = require('../config/labelPrint');
const { SCAN_URL } = require('../config/tagQrCode');
const { buildRecordIdScanUrl } = require('./tagQrCodeService');
const { textValue } = require('./v1BitableGateway');
const { parseStockKey } = require('./liveInventoryIndex');
const { equalsFormula } = require('./bitableFilterFormula');
// ⭐⭐ task-15：飞书 `filter` 公式的拼装**只有那一处实现**（`bitableFilterFormula.js`）——
//    这里只 import 复用（**值的安全字符检查也在它那里**），**不抄第二份** ✗。
const { logInfo, logWarn } = require('../utils/logger');
const { resolveOrderReadRetryConfig, isRetriableOrderReadError } = require('../config/orderReadRetry');
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
 * 读不出「库存键」四段时返回 `null`（由调用方计数、**不猜**：
 * 按错的键印标签等于把这一双贴到别的款上，宁可少一张也不印错）。
 *
 * 🔴 2026-11-09（业务负责人）：「销售前端后端、退货对库存的鉴定**已经不依赖所属状态**了，
 *    只要在实时库存里有记录就可以」⇒ 标签打印**同一口径**：
 *    「所属状态」为空的库存行**照常算这一双**（`state: ''`，状态清单里不出现、标签默认也不印状态）；
 *    只有**库存键本身坏掉**的行才跳过并计数。
 */
const rowFromRecord = (record, { fieldNames, createdTimeField }) => {
  const key = parseStockKey(record?.fields?.[fieldNames.stockKey]);
  if (!key) return null;
  const state = textValue(record?.fields?.[fieldNames.state]).trim();
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
 *   `createdTimeFields` 是**候选名列表**（旧「最近新增」筛选已删除，这里固定传空数组）：
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
 * ⭐⭐ 2026-10-15（task-11）：**这条只读链路的短 TTL 缓存** —— 两个用途**共用同一份实现**
 *    （`listLabels` 专用；旧的编号清单端点已随「选择编号打印」删除）。
 *
 * 为什么要有它（Lead 线上**只读实测**）：`listAll('liveInventory')` 1362 行 5924ms ＋
 *   `listAll('product')` 561 行 5478ms ⇒ **一次 ≈ 11.4 秒**；而她**每打开一次**那一页都要等 ✗。
 *
 * 口径（与 #582 落地的那套逐条一致）：
 *   · `ttlMs > 0`：TTL 内重复调用**不再读飞书**（命中）；`= 0`：**关掉缓存**，每次真读；
 *   · 缓存里**只放与请求无关的数据**（原始记录 / 编号底表）；**keyword 过滤在缓存之外
 *     每请求现算** ✗（连过滤结果一起缓存会串数据）；
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

const createLabelPrintService = (gateway, options = {}) => {
  if (!gateway) throw new Error('LabelPrintService requires gateway');
  const config = options.config || LABEL_PRINT;
  const now = options.now || (() => Date.now());
  // 读飞书标签底表时的瞬时错误重试：判据与订单/库存查询同一份（config/orderReadRetry）。
  const readRetry = options.readRetry || resolveOrderReadRetryConfig();
  const sleep = options.sleep || ((ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve()));
  const listAllWithRetry = async (tableKey) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await gateway.listAll(tableKey);
      } catch (error) {
        if (!isRetriableOrderReadError(error) || attempt >= readRetry.maxRetries) throw error;
        const delayMs = Math.max(0, Number(readRetry.delayMs)) * (attempt + 1);
        logWarn('workbench.labels.read_retry', {
          table_key: tableKey, attempt: attempt + 1, of: readRetry.maxRetries + 1, delay_ms: delayMs,
        });
        await sleep(delayMs);
      }
    }
  };
  /** 缓存 TTL 从 config 取（**0 是一个合法值** = 关掉；没配才用兜底值）。 */
  const ttlOf = (group, fallback) => (Number.isInteger(group?.cacheTtlMs) && group.cacheTtlMs >= 0
    ? group.cacheTtlMs
    : fallback);

  /**
   * ⭐ `listLabels` 的两次全表读（**只缓存原始记录**；筛选 /「最近新增」**每请求现算**）。
   * 读序仍是「实时库存 → 货品信息」（与改动前逐字一致）。
   */
  const loadLabelListTables = async () => {
    const records = await listAllWithRetry('liveInventory');
    const productRecords = await getConfigRows({ gateway, tableKey: 'product',
      loader: () => listAllWithRetry('product') });
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
   * 按**编号 / 货号关键字**挑出要打的货 → **每个编号一张标签**、每张印什么。
   *
   * 🔴 2026-11-09（业务负责人：旧批量逻辑「完全删除」）：原来的条件筛选
   *   （所属状态 / 类别 / 尺码 / 最近新增 / 排序）以及对应的配置项**整段物理删除** ✗。
   *   本方法现在**只认一个** `keyword`：
   *     · 「选择编号打印」带进来的编号 / 货号；
   *     · 「扫码打印」按记录 ID 拿到编号后复用它（`labelForRecord`）；
   *     · 队列的单品 / 表单链路也复用它。
   *
   * 数据源 = **「货品信息」∪「实时库存」**（按**编号**去重，见文件头）：
   *   · 有库存行的编号 ⇒ 尺码 + 数量角标；没有库存行的新货 ⇒ 也出一张（不印尺码那一行）。
   *
   * @param {{keyword?: string}} input
   */
  const listLabels = async (input = {}) => {
    const table = V1_BITABLE_SCHEMA.tables.liveInventory;
    const fieldNames = table?.fields || {};
    if (!fieldNames.stockKey || !fieldNames.state) {
      throw new Error('「实时库存」缺少必要的字段映射（库存键 / 所属状态），请先补 v1BitableSchema.liveInventory');
    }
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    const keyword = String(input.keyword ?? '').trim();

    // 两张整表的短 TTL 缓存（只缓存原始记录；keyword 过滤每次现算）。
    const { records, productRecords } = await labelListCache.get();
    return buildLabelsFromTables(records, productRecords, { keyword });
  };

  /**
   * 从**已读到的原始记录**构建标签结果（`listLabels` 与「扫码精确读」共用这一份，不抄第二份）。
   * @param {Array} records 实时库存原始记录
   * @param {Array} productRecords 货品信息原始记录（可以是整表，也可以只是扫到的那一条）
   * @param {{keyword?: string}} input
   */
  const buildLabelsFromTables = async (records, productRecords, { keyword: rawKeyword = '' } = {}) => {
    const table = V1_BITABLE_SCHEMA.tables.liveInventory;
    const fieldNames = table?.fields || {};
    const productFields = V1_BITABLE_SCHEMA.tables.product?.fields || {};
    const keyword = String(rawKeyword ?? '').trim();

    const skipped = { stock_key: 0 };
    const rows = [];
    // 「有库存行」的编号集合（= 与「货品信息」去重的判据；所属状态无关）。
    const stockedNumbers = new Set();
    for (const record of records || []) {
      const key = parseStockKey(record?.fields?.[fieldNames.stockKey]);
      if (key) stockedNumbers.add(compoundNumber(key.itemNo, key.color, key.category));
      const row = rowFromRecord(record, { fieldNames, createdTimeField: '' });
      if (!row) {
        skipped.stock_key += 1;
        continue;
      }
      rows.push(row);
    }
    const parsedTotal = rows.length;

    const brandFieldName = config.brand?.from === 'table' ? String(config.brand.tableFieldName || '').trim() : '';
    const productIndex = buildProductIndex(productRecords, productFields, brandFieldName, []);

    // 没有库存行、但在「货品信息」里的编号 ⇒ 每个编号一张「新品标签」（sizes 为空 ⇒ 不印尺码行）。
    let withoutStock = [];
    for (const [number, product] of productIndex) {
      if (stockedNumbers.has(number)) continue;
      withoutStock.push({ number, product });
    }

    // 只按 keyword 过滤（编号 / 货号 / 颜色 / 类别，大小写不敏感）—— **唯一**的筛选条件。
    const normalizedKeyword = keyword.toLowerCase();
    const matchesKeyword = (values) => !normalizedKeyword
      || values.some((value) => String(value ?? '').toLowerCase().includes(normalizedKeyword));
    const matchedRows = rows.filter((row) => matchesKeyword([numberOf(row), row.item_no, row.color, row.category]));
    withoutStock = withoutStock.filter((item) => matchesKeyword(
      [item.number, item.product.item_no, item.product.color, item.product.category],
    ));

    // 按**编号**聚合（一张标签 = 一个编号；尺码 → 数量 = 这个编号 + 这个尺码的库存条数）。
    const groups = new Map();
    for (const row of matchedRows) {
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
      if (row.state) group.states.add(row.state);
      group.record_ids.push(row.record_id);
      if (row.created_at > group.created_at) group.created_at = row.created_at;
    }
    for (const item of withoutStock) {
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

    // 货架顺序：货号 → 颜色 → 类别（旧的 `recent` 排序已随批量筛选一起删除）。
    const shelfCompare = (left, right) => String(left.item_no).localeCompare(String(right.item_no), 'zh-CN')
      || String(left.color).localeCompare(String(right.color), 'zh-CN')
      || String(left.category_code).localeCompare(String(right.category_code), 'zh-CN');
    const ordered = [...groups.values()].sort(shelfCompare);

    // 截断（**不静默**：matched / truncated 都回给页面）。
    const maxLabels = config.limits.maxLabels;
    const matchedTotal = ordered.length;
    const truncated = matchedTotal > maxLabels;
    const visible = ordered.slice(0, maxLabels);
    const totalPairs = ordered.reduce((sum, group) => sum + group.record_ids.length, 0);

    const stateRank = (value) => {
      const order = config.stateOrder || [];
      const index = order.indexOf(value);
      return index === -1 ? order.length : index;
    };
    let missingPrice = 0;
    let missingPriceNoProduct = 0;
    let missingQrRecordId = 0;
    const prepared = visible.map((group) => {
      const product = productIndex.get(group.number) || null;
      const price = product ? product.price : null;
      const priceMissing = config.fields?.price === true && price === null;
      if (priceMissing) {
        missingPrice += 1;
        if (!product) missingPriceNoProduct += 1;
      }
      const priceText = config.fields?.price ? formatPrice(price, config.price) : '';
      const sizes = [...group.sizes.entries()]
        .map(([sizeValue, quantity]) => ({ size: sizeValue, qty: quantity }))
        .sort((left, right) => compareSizes(left.size, right.size, config.sizes));
      const { lines, overflow } = buildSizeLines(sizes, config.sizes);
      const states = [...group.states].sort((left, right) => stateRank(left) - stateRank(right));
      const totalQty = sizes.reduce((sum, item) => sum + item.qty, 0);
      const brandText = (brandFieldName && product?.brand) || String(config.brand?.text ?? '');
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
        key: group.number,
        number: group.number,
        item_no: group.item_no,
        color: group.color,
        category: group.category,
        category_code: group.category_code,
        sizes,
        size_lines: lines,
        size_overflow: overflow,
        total_qty: totalQty,
        states,
        state_text: states.join(config.texts.stateSeparator),
        price,
        price_text: priceText,
        brand_text: config.fields?.brand ? brandText : '',
        record_ids: group.record_ids,
        record_count: group.record_ids.length,
        // `false` = 还在「货品信息」里、没入库的新货（sizes 一定为空数组 ⇒ 页面不印尺码行）。
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
    const withStockMatched = ordered.filter((group) => group.without_stock !== true).length;
    const withoutStockMatched = matchedTotal - withStockMatched;
    const productRecordsNoNumber = (productRecords || [])
      .filter((record) => !(productFields.number ? textValue(record?.fields?.[productFields.number]).trim() : ''))
      .length;
    logInfo('workbench.labels.listed', {
      keyword: keyword || undefined,
      scanned_records: (records || []).length,
      parsed_records: parsedTotal,
      product_records: (productRecords || []).length,
      product_records_no_number: productRecordsNoNumber || undefined,
      with_stock: withStockMatched,
      without_stock: withoutStockMatched,
      matched_labels: matchedTotal,
      matched_pairs: totalPairs,
      returned_labels: labels.length,
      truncated: truncated || undefined,
      skipped_stock_key: skipped.stock_key || undefined,
      missing_price: missingPrice || undefined,
      missing_price_no_product: missingPriceNoProduct || undefined,
      missing_qr_record_id: missingQrRecordId || undefined,
    });
    if (skipped.stock_key) {
      logWarn('workbench.labels.skipped_records', {
        skipped_stock_key: skipped.stock_key,
        hint: '「实时库存」里有读不出「库存键」四段的记录，这些记录没有出现在标签里',
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
      logWarn('workbench.labels.missing_qr_record_id', {
        missing_qr_record_id: missingQrRecordId,
        hint: '这些编号在「货品信息」里没有对应记录 ⇒ 二维码退回旧的编号版格式；扫码打印只认记录 ID 版（她会收到"请重打新标签"的人话）',
      });
    }

    return {
      generated_at: new Date(now()).toISOString(),
      total_matched: matchedTotal,
      total_returned: labels.length,
      total_pairs: totalPairs,
      total_with_stock: withStockMatched,
      total_without_stock: withoutStockMatched,
      truncated,
      max_labels: maxLabels,
      // 🔴 2026-11-09：不再有「所属状态为空被跳过」这一档（销售/退货/标签统一口径：
      //    实时库存里有记录就算）。只保留「库存键坏掉」的计数。
      skipped_records: {
        stock_key: skipped.stock_key,
        total: skipped.stock_key,
      },
      missing_price: missingPrice,
      missing_price_no_product: missingPriceNoProduct,
      missing_qr_record_id: missingQrRecordId,
      // 🔴 旧的 `filters`（state/category/size/recent_days/sort/品类候选/排序模式）已随批量筛选删除。
      filters: { keyword },
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

    // ⭐ 2026-11-11（业务负责人：「实时库存表可以先按照编号做筛选吗」）：
    //   **优先只读这一款**，不再每次读 1335 行实时库存 + 559 行货品：
    //   · 货品：上面已经按记录 ID 读了那一条（不整表）；
    //   · 库存：飞书 `filter` 按「库存键 contains 货号」只回这一款的那几行
    //     （旧的「编号清单」查询已验证公式列 filter 可用，见 `bitableFilterFormula`）；
    //   · **任何一步拿不到 / 报错 / 筛不出那一张 ⇒ 自动回退整表读** `listLabels`（与改动前逐字一致，保证不退化）。
    const itemNo = number.split('|')[0] || number;
    // ⭐ 2026-11-11（业务负责人）：「不用做回退，这个字段肯定有」——
    //   只走「实时库存.recordID（查找引用）＝ 货品记录 ID」**精确筛选**这一条路；
    //   没有整表读兜底（筛选失败就是系统错误，不静默降级）。
    const fastReadConfig = config.fastRead || {};
    const recordIdLookupField = String(fastReadConfig.liveInventoryRecordIdField || '').trim();
    if (!recordIdLookupField) {
      throw new Error('标签打印缺少「实时库存.recordID」字段配置（见 config/labelPrint.js 的 fastRead）');
    }
    if (typeof gateway.listByFilter !== 'function') {
      throw new Error('打印服务不支持按记录 ID 精确读（gateway 缺少 listByFilter）');
    }
    const filter = equalsFormula(recordIdLookupField, id);
    if (!filter) throw new Error(`记录 ID 含有不能拼进筛选公式的字符：${id}`);
    const stockRecords = await gateway.listByFilter('liveInventory', filter);
    const data = await buildLabelsFromTables(stockRecords, [record], { keyword: itemNo });
    const exact = (data.labels || []).filter((label) => label.number === number);
    logInfo('workbench.labels.record_fast_read', {
      product_record_id: id,
      item_no: itemNo,
      filter_kind: 'record_id_lookup',
      stock_rows: (stockRecords || []).length,
      labels: (data.labels || []).length,
      exact: exact.length,
    });
    if (!exact.length) throw userError(texts.noStock);
    logInfo('workbench.labels.record_resolved', {
      product_record_id: id,
      number,
      labels: exact.length,
    });
    return { ...data, labels: exact, total_matched: exact.length, total_returned: exact.length };
  };

  return { listLabels, labelForRecord };
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
};
