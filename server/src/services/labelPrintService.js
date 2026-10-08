/**
 * 鞋盒标签打印 service —— **只干一件事**：从「实时库存」（一双一条）取数，
 * 组装出"**每张标签要印什么**"（货号 / 颜色 / 类别 / 尺码 / 所属状态 / 二维码 / 底部小字）。
 *
 * ⚠️ **只读**：本文件**没有任何写入路径** —— 全仓只有 `gateway.listAll('liveInventory')`
 *    这一次读（`V1BitableGateway` 的 create / update / delete 一次都不调）。
 *    业务负责人 2026-10-08 的口径：这个功能**只读表**，就不该有任何写入路径。
 *    测试 `labelPrintService.test.js` 用一个"只有 listAll"的假网关钉住这一点。
 *
 * ⚠️ **排版不进这里**（那是页面的事）：service 只回答"印什么"（数值 / 文案 / SVG 字符串），
 *    50×30mm、每页几行几列、字号这些**怎么摆**的参数原样带在响应的 `layout` 里，
 *    由页面（`public/workbench/features/labels/*`）落到 CSS 上。
 *
 * 字段映射（**只读**，一个都不写）：
 *   · 「库存键」（`liveInventory.stockKey`）—— 飞书侧公式 `货号|颜色|类别|尺码`，
 *     一次读一列就同时拿到货号、颜色、类别、尺码（与 `services/liveInventoryIndex.js`
 *     同一套解析，**复用 `parseStockKey`**，不另写一份、不另读三张关联表）；
 *   · 「所属状态」（`liveInventory.state`）；
 *   · 「创建时间」—— 只用于「最近新增」筛选（字段名暂放 config，见那里的说明）。
 */
const QRCode = require('qrcode');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { LABEL_PRINT, resolveGrid } = require('../config/labelPrint');
const { textValue } = require('./v1BitableGateway');
const { parseStockKey } = require('./liveInventoryIndex');
const { logInfo, logWarn } = require('../utils/logger');

// 她填错了（400，原样回显）vs 远端出错（其余，页面只说"查询失败"）——与
// `inventoryAdjustmentService` 同一条约定，控制器按 statusCode 分流。
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * 把模板里的 `{占位符}` 替换成**已 URL 编码**的值。
 * ⚠️ **只编码值、不编码模板**：否则 `?` `=` `&` 会被一起编码，扫出来就不是一个能打开的 URL。
 * ⚠️ 模板里出现不认识的占位符 → **当场抛错**（配置写错时不许静默生成一堆指向 `no=` 的空码）。
 */
const buildScanUrl = (template, values) => String(template ?? '').replace(/\{(\w+)\}/g, (match, key) => {
  if (!Object.prototype.hasOwnProperty.call(values, key)) {
    throw new Error(`二维码 URL 模板里的占位符不认识：{${key}}（可用：${Object.keys(values).join(' / ')}）`);
  }
  const value = values[key];
  return value === undefined || value === null ? '' : encodeURIComponent(String(value));
});

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
 * 文本模板（底部小字）—— 与 `buildScanUrl` 同一套占位符规则，但**不做 URL 编码**，
 * 且取不到的值用 `texts.missingValue` 顶上（`42` 前面是空段看着像漏印）。
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
 * 一条「实时库存」记录 → 一张标签。
 * 记录里读不出「库存键」四段（或所属状态为空）时返回 `null`（由调用方计数、**不猜**：
 * 按错的键印标签等于把这一双贴到别的款上，宁可少一张也不印错）。
 */
const rowFromRecord = (record, { fieldNames, createdTimeField }) => {
  const key = parseStockKey(record?.fields?.[fieldNames.stockKey]);
  if (!key) return null;
  const state = textValue(record?.fields?.[fieldNames.state]).trim();
  if (!state) return null;
  // 「品类」优先取库存键里的那段（同一列一次读全）；库存键里那一段为空时，回落到
  // 「品类」公式列（`liveInventory.category`）—— 两者取到哪个都不会多打一次飞书请求。
  const categoryFromField = fieldNames.category ? textValue(record?.fields?.[fieldNames.category]).trim() : '';
  return {
    record_id: record.record_id,
    item_no: key.itemNo,
    color: key.color || '',
    category: key.category || categoryFromField,
    size: key.size,
    state,
    stock_key: textValue(record?.fields?.[fieldNames.stockKey]).trim(),
    created_at: createdTimeField ? asTimestamp(record?.fields?.[createdTimeField]) : 0,
  };
};

const createLabelPrintService = (gateway, options = {}) => {
  if (!gateway) throw new Error('LabelPrintService requires gateway');
  const config = options.config || LABEL_PRINT;
  const now = options.now || (() => Date.now());

  /**
   * 她按条件挑出要打的货 → 每张标签印什么。
   *
   * filters（全部可选，可组合）：
   *   keyword     货号 / 颜色 / 类别 的模糊包含（大小写不敏感）
   *   state       「所属状态」精确匹配（空 = 不限）
   *   category    「类别」精确匹配（空 = 不限）
   *   size        尺码精确匹配（空 = 不限）
   *   recentDays  「最近新增」= 「创建时间」在最近 N 天内（0 = 不限）
   *   sort        'shelf'（默认，货架顺序）| 'recent'（最近新增在前）
   */
  const listLabels = async (filters = {}) => {
    const table = V1_BITABLE_SCHEMA.tables.liveInventory;
    const fieldNames = table?.fields || {};
    if (!fieldNames.stockKey || !fieldNames.state) {
      throw new Error('「实时库存」缺少必要的字段映射（库存键 / 所属状态），请先补 v1BitableSchema.liveInventory');
    }
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

    // ── 唯一的一次读：整张「实时库存」（分页由网关负责）────────────────────
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

    // ── 条件筛选（货号 / 颜色 / 类别 模糊，状态 / 类别 / 尺码 精确）────────
    // 「类别」下拉的候选 = 从**解析出来的全部记录**去重（在筛选之前算，否则她越筛选项越少）；
    // 与筛选用的是同一个来源 ⇒ 选了一定有结果，不会出现"选了某个类别却 0 张"。
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

    // ── 排序 ─────────────────────────────────────────────────────────────
    const stateOrder = config.filters.stateOptions;
    const stateRank = (value) => {
      const index = stateOrder.indexOf(value);
      return index === -1 ? stateOrder.length : index;
    };
    const shelfCompare = (left, right) => String(left.item_no).localeCompare(String(right.item_no), 'zh-CN')
      || left.size - right.size
      || stateRank(left.state) - stateRank(right.state)
      || String(left.color).localeCompare(String(right.color), 'zh-CN');
    rows.sort(sort === 'recent'
      ? (left, right) => (right.created_at - left.created_at) || shelfCompare(left, right)
      : shelfCompare);

    // ── 截断（**不静默**：matched/truncated 都回给页面）─────────────────────
    const maxLabels = config.limits.maxLabels;
    const matchedTotal = rows.length;
    const truncated = matchedTotal > maxLabels;
    const visible = rows.slice(0, maxLabels);

    // ── 每张标签要印什么（含二维码 SVG）──────────────────────────────────
    const missingValue = config.texts.missingValue;
    const labels = await Promise.all(visible.map(async (row) => {
      const values = {
        itemNo: row.item_no,
        color: row.color,
        category: row.category,
        size: row.size,
        state: row.state,
        stockKey: row.stock_key,
      };
      const scanUrl = buildScanUrl(config.qr.urlTemplate, values);
      return {
        // 一张标签一个唯一键 = 一条「实时库存」记录（同款同码多双 ⇒ 多张标签，键各不相同）。
        key: row.record_id,
        record_id: row.record_id,
        item_no: row.item_no,
        color: row.color,
        category: row.category,
        size: row.size,
        // 尺码那格印的文字（`42` → `42码`），文案来自 config。
        size_text: `${row.size}${config.texts.sizeSuffix}`,
        state: row.state,
        stock_key: row.stock_key,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : '',
        scan_url: scanUrl,
        qr_svg: config.fields.qr
          ? await QRCode.toString(scanUrl, {
            type: 'svg',
            errorCorrectionLevel: config.qr.errorCorrectionLevel,
            margin: config.qr.marginModules,
            color: { dark: config.qr.darkColor, light: config.qr.lightColor },
          })
          : '',
        footer_text: buildText(config.footer.template, values, missingValue),
      };
    }));

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
      returned_labels: labels.length,
      truncated: truncated || undefined,
      skipped_stock_key: skipped.stock_key || undefined,
      skipped_state: skipped.state || undefined,
      missing_created_at: missingCreatedAt || undefined,
    });
    if (skipped.stock_key || skipped.state) {
      logWarn('workbench.labels.skipped_records', {
        skipped_stock_key: skipped.stock_key,
        skipped_state: skipped.state,
        hint: '「实时库存」里有读不出「库存键」四段或「所属状态」为空的记录，这些记录没有出现在标签里',
      });
    }

    return {
      generated_at: new Date(now()).toISOString(),
      total_matched: matchedTotal,
      total_returned: labels.length,
      truncated,
      max_labels: maxLabels,
      skipped_records: {
        stock_key: skipped.stock_key,
        state: skipped.state,
        total: skipped.stock_key + skipped.state,
      },
      missing_created_at: missingCreatedAt,
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
      layout: {
        label: config.label,
        page: config.page,
        grid: { ...grid, gapXMm: config.grid.gapXMm, gapYMm: config.grid.gapYMm },
        typography: config.typography,
        fields: config.fields,
        texts: config.texts,
      },
      qr: { url_template: config.qr.urlTemplate },
      labels,
    };
  };

  return { listLabels };
};

module.exports = { createLabelPrintService, buildScanUrl, buildText, asTimestamp, rowFromRecord };
