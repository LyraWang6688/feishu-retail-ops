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
 *     一行放不下**自动换行**（最多 `maxLines` 行；再超出省略并留 `…`）—— `perLine` / `maxLines` 来自 config；
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
 * ⚠️ **二维码内容是单一真源**：模板来自 `config/tagQrCode.js` 的 `SCAN_URL.urlTemplate`
 *    （`https://hm.bamamei.online/s/{编号}`），替换用 `services/tagQrCodeService.js` 导出的
 *    `buildScanUrl`（只编码值、不编码模板）。本文件**不抄第二份 URL 模板** —— 旧的那条
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
const { buildScanUrl } = require('./tagQrCodeService');
const { textValue } = require('./v1BitableGateway');
const { parseStockKey } = require('./liveInventoryIndex');
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
 * 一条（`rowFromRecord` 解析出来的）库存记录的前三段 = **编号**
 * （`货号|颜色|类别`，与「货品信息.编号」同格式，见 `docs/production-base-changes-2026-10-08.md`）。
 */
const numberOf = (row) => `${row.item_no}|${row.color || ''}|${row.category_code || ''}`;

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
 * 返回 `{ lines, overflow }`：`lines` 最多 `maxLines` 行（每行至多 `perLine` 个），
 * `overflow = true` 表示还有尺码没排上（页面在最后一行尾上补 `…`，**不静默吞掉**）。
 */
const buildSizeLines = (sizes, sizesConfig = {}) => {
  const perLine = Number.isInteger(sizesConfig.perLine) && sizesConfig.perLine > 0 ? sizesConfig.perLine : 3;
  const maxLines = Number.isInteger(sizesConfig.maxLines) && sizesConfig.maxLines > 0 ? sizesConfig.maxLines : 2;
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
 * 「货品信息」→ `编号 ⇒ { price, brand }` 的索引（只读一次表就够）。
 * 同一个编号出现多条时：**第一条非空**的价格 / 品牌为准（不覆盖已有值）。
 */
const buildProductIndex = (records, fields = {}, brandFieldName = '') => {
  const index = new Map();
  for (const record of records || []) {
    const number = fields.number ? textValue(record?.fields?.[fields.number]).trim() : '';
    if (!number) continue;
    const entry = index.get(number) || { price: null, brand: '' };
    const price = fields.price ? asAmount(record?.fields?.[fields.price]) : null;
    if (entry.price === null && price !== null) entry.price = price;
    const brand = brandFieldName ? textValue(record?.fields?.[brandFieldName]).trim() : '';
    if (!entry.brand && brand) entry.brand = brand;
    index.set(number, entry);
  }
  return index;
};

/** 按**编号**出码（URL 模板与替换实现都复用 `tagQrCode` 那一份，**不抄第二份**）。 */
const buildLabelScanUrl = (number) => buildScanUrl(SCAN_URL.urlTemplate, number);

const createLabelPrintService = (gateway, options = {}) => {
  if (!gateway) throw new Error('LabelPrintService requires gateway');
  const config = options.config || LABEL_PRINT;
  const now = options.now || (() => Date.now());

  /**
   * 她按条件挑出要打的货 → **每个编号一张标签**、每张印什么。
   *
   * filters（全部可选，可组合）：
   *   keyword     货号 / 颜色 / 品类 的模糊包含（大小写不敏感）
   *   state       「所属状态」精确匹配（空 = 不限）—— 只影响**哪些库存算进来**
   *   category    「品类」精确匹配（空 = 不限）
   *   size        尺码精确匹配（空 = 不限）—— 只印这个尺码（该编号其余尺码不进这一轮）
   *   recentDays  「最近新增」= 「创建时间」在最近 N 天内（0 = 不限）
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

    // ── 读一：整张「实时库存」（分页由网关负责）──────────────────────────────
    const records = await gateway.listAll('liveInventory');

    const skipped = { stock_key: 0, state: 0 };
    let rows = [];
    for (const record of records || []) {
      const row = rowFromRecord(record, { fieldNames, createdTimeField });
      if (!row) {
        // 分辨"是库存键不完整还是所属状态为空"，只为了日志/提示能说清；不改变"跳过"这个结论。
        if (parseStockKey(record?.fields?.[fieldNames.stockKey])) skipped.state += 1;
        else skipped.stock_key += 1;
        continue;
      }
      rows.push(row);
    }
    const parsedTotal = rows.length;

    // ── 「最近新增」筛选（读「创建时间」）──────────────────────────────────
    let missingCreatedAt = 0;
    if (recentDays > 0) {
      const available = rows.some((row) => row.created_at > 0);
      if (!available) {
        // **不静默**：宁可她看到一句"读不到创建时间"，也不要"筛了等于没筛"或"一张都不剩"。
        throw new Error(`读不到「实时库存.${createdTimeField || '创建时间'}」，暂时不能用「最近新增」筛选`);
      }
      const cutoff = now() - recentDays * 24 * 60 * 60 * 1000;
      rows = rows.filter((row) => {
        if (row.created_at > 0) return row.created_at >= cutoff;
        missingCreatedAt += 1;
        return false;
      });
    }

    // ── 条件筛选（货号 / 颜色 / 品类 模糊，状态 / 品类 / 尺码 精确）────────────
    // 「品类」下拉的候选 = 从**解析出来的全部记录**去重（在筛选之前算，否则她越筛选项越少）；
    // 与筛选用的是同一个来源 ⇒ 选了一定有结果，不会出现"选了某个品类却 0 张"。
    const categoryOptions = [...new Set(rows.map((row) => row.category).filter(Boolean))]
      .sort((left, right) => String(left).localeCompare(String(right), 'zh-CN'));
    const normalizedKeyword = keyword.toLowerCase();
    rows = rows.filter((row) => {
      if (state && row.state !== state) return false;
      if (category && row.category !== category) return false;
      if (size !== null && row.size !== size) return false;
      if (!normalizedKeyword) return true;
      return [row.item_no, row.color, row.category]
        .some((value) => String(value).toLowerCase().includes(normalizedKeyword));
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
        };
        groups.set(number, group);
      }
      group.sizes.set(row.size, (group.sizes.get(row.size) || 0) + 1);
      group.states.add(row.state);
      group.record_ids.push(row.record_id);
      if (row.created_at > group.created_at) group.created_at = row.created_at;
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

    // ── 读二：整张「货品信息」（只为**补价格 / 品牌**；一次读、按编号建索引）──
    const brandFieldName = config.brand?.from === 'table' ? String(config.brand.tableFieldName || '').trim() : '';
    const productIndex = buildProductIndex(
      await gateway.listAll('product'),
      productFields,
      brandFieldName,
    );

    // ── 每张标签要印什么（先同步算完数据，再异步出二维码 SVG）──────────────
    const stateRank = (value) => {
      const index = config.filters.stateOptions.indexOf(value);
      return index === -1 ? config.filters.stateOptions.length : index;
    };
    let missingPrice = 0;
    let missingPriceNoProduct = 0;
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
        created_at: group.created_at ? new Date(group.created_at).toISOString() : '',
        scan_url: buildLabelScanUrl(group.number),
        footer_text: buildText(config.footer.template, footerValues, config.texts.missingValue),
      };
    });

    const labels = await Promise.all(prepared.map(async (label) => ({
      ...label,
      qr_svg: config.fields?.qr
        ? await QRCode.toString(label.scan_url, {
          type: 'svg',
          errorCorrectionLevel: config.qr.errorCorrectionLevel,
          margin: config.qr.marginModules,
          color: { dark: config.qr.darkColor, light: config.qr.lightColor },
        })
        : '',
    })));

    const grid = resolveGrid(config);
    logInfo('workbench.labels.listed', {
      keyword: keyword || undefined,
      state: state || undefined,
      category: category || undefined,
      size: size === null ? undefined : size,
      recent_days: recentDays || undefined,
      sort,
      scanned_records: (records || []).length,
      parsed_records: parsedTotal,
      matched_labels: matchedTotal,
      matched_pairs: totalPairs,
      returned_labels: labels.length,
      truncated: truncated || undefined,
      skipped_stock_key: skipped.stock_key || undefined,
      skipped_state: skipped.state || undefined,
      missing_created_at: missingCreatedAt || undefined,
      missing_price: missingPrice || undefined,
      missing_price_no_product: missingPriceNoProduct || undefined,
    });
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

    return {
      generated_at: new Date(now()).toISOString(),
      // ⚠️ 单位变了：`total_matched` 现在是**标签张数 = 编号个数**（不是库存双数）；
      //    `total_pairs` 才是这些编号一共有多少双库存（她按"还剩几双"对数时用这个）。
      total_matched: matchedTotal,
      total_returned: labels.length,
      total_pairs: totalPairs,
      truncated,
      max_labels: maxLabels,
      skipped_records: {
        stock_key: skipped.stock_key,
        state: skipped.state,
        total: skipped.stock_key + skipped.state,
      },
      missing_created_at: missingCreatedAt,
      missing_price: missingPrice,
      missing_price_no_product: missingPriceNoProduct,
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
      qr: { url_template: SCAN_URL.urlTemplate, source: 'config/tagQrCode.js#SCAN_URL' },
      labels,
    };
  };

  return { listLabels };
};

module.exports = {
  createLabelPrintService,
  buildLabelScanUrl,
  buildSizeLines,
  compareSizes,
  buildProductIndex,
  formatPrice,
  asAmount,
  numberOf,
  buildText,
  asTimestamp,
  rowFromRecord,
};
