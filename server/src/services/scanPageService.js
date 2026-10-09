/**
 * 扫码页（第一版：**只读查库存**）的取数与聚合。
 *
 * 输入：`编号`（= `货号|颜色|类别`，扫码 URL 里那一段）。
 * 输出：一个**给渲染层用的视图模型**（身份 / 单价 / 每个尺码 × 每种状态的库存 / 缺码标记）。
 *
 * 🔴 **只读**：本文件只调 `gateway.listAll` / `gateway.listByFilter`（外加共享的
 *    `SizeReferenceService` 读尺码表），
 *    全文件**没有任何 `create` / `update` / `delete`** ——
 *    这条链路是"扫码就能看"，写操作（补货 / 销售 / 验收）是下一版的事，
 *    而且必须落到 `入口隔离`（`docs/entry-isolation-2026-10-08.md`）允许共享的**业务处理层**去。
 *    `test/scanPage.test.js` 有一条用例**逐字扫这三个文件**，出现写调用就判红。
 *
 * ⭐ **2026-10-08 提速（业务负责人：「扫码页打开有点慢」）**：
 *    提速前**每次扫码整表读三张表**（货品信息 + 实时库存 + 尺码管理，4+ 次分页请求，
 *    其中整表读「实时库存」真机实测 5~9 秒）。现在：
 *      · 「实时库存」→ 按**「编号」关联的显示文本** +「库存键」前缀过滤读，只取这一款的行；
 *      · 「货品信息」→ 按**「编号」**精确过滤读（公式 → 1 条），再在内存里跑同一个 `findProduct`；
 *      · 「尺码管理」→ 保持整表读（一共 15 条，一次请求就回来），**并给这 15 条单独加一层 TTL 缓存**
 *        （每次扫码都要用它算缺码，而它几乎不变）；
 *      · 外面再套一层**进程内短 TTL 缓存**（`编号` → 视图模型，TTL 进 config）。
 *    ⚠️ 过滤读**拿不到 / 飞书不认**时**自动回退整表读**（`reads.filterEnabled` 是一键退回的开关）
 *       —— 回退路径的行为与提速前**逐字一致**；过滤读回来**仍然过一遍原来的内存判据**
 *       （`findProduct` / `belongsToNumber`），所以"读到的行"与提速前是同一个集合。
 *
 * 口径与降级（都是业务负责人拍过的，见 `config/scanPage.js` 的注释）：
 *   · 「实时库存」一双一条 ⇒ **数量 = 记录条数**（与工作台 `getLiveInventory` 同一口径）；
 *   · 缺码 = 「尺码管理」里**这个类别**有的尺码、但库存为 0；
 *   · 读不到「类别」列 / 这个类别没有尺码 ⇒ **降级**：只显示有库存的尺码 + warn（**不编造**）；
 *   · 状态里出现配置外的取值 / 读不出尺码 ⇒ **不丢**，另列一行/一列 + warn（"共 N 双"必须对得上）。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { createScanPageCache } = require('./scanPageCache');
const { createLiveInventorySnapshot } = require('./liveInventorySnapshot');
const { SCAN_PAGE, fillText } = require('../config/scanPage');
const { logInfo, logWarn } = require('../utils/logger');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

const fieldName = (schema, tableKey, semanticKey) => schema?.tables?.[tableKey]?.fields?.[semanticKey] || '';
const readField = (schema, tableKey, record, semanticKey) => {
  const name = fieldName(schema, tableKey, semanticKey);
  return name ? record?.fields?.[name] : undefined;
};

/**
 * 路由参数 → 编号。
 *
 * Express 已经对 `:number` 做过一次百分号解码，这里**再解**是为了容忍
 * "客户端把中文原样塞进路径 / 双重编码"这两种形状：
 *   · 只有"还看得见 `%XX`"才继续解（最多 `number.decodePasses` 次）；
 *   · 编号里出现孤立的 `%`（例：`50%OFF`）时**一个字都不动** ——
 *     `decodeURIComponent` 会抛，绝不让一个字符把整页打成 500。
 *
 * ⚠️ 只 trim 首尾：**颜色里可能真有空格**（`tagQrCodeService` 的用例里就有 `A B`），
 *    不能把中间的空格折叠掉，否则会与表里的编号对不上。
 */
const decodeScanNumber = (raw, config = SCAN_PAGE) => {
  let text = String(raw ?? '');
  const passes = Number.isInteger(config.number.decodePasses) && config.number.decodePasses > 0
    ? config.number.decodePasses
    : 1;
  for (let pass = 0; pass < passes; pass += 1) {
    if (!/%[0-9A-Fa-f]{2}/.test(text)) break;
    try {
      const next = decodeURIComponent(text);
      if (next === text) break;
      text = next;
    } catch (_) {
      break;
    }
  }
  return text.trim();
};

/** 编号 → 三段。切不出第 3 段就没有类别（缺码判定随之降级）。 */
const parseNumberSegments = (number, config = SCAN_PAGE) => {
  const parts = String(number ?? '').split(config.number.separator);
  const { itemNo, color, category } = config.number.segment;
  return {
    itemNo: String(parts[itemNo] ?? '').trim(),
    color: String(parts[color] ?? '').trim(),
    categoryCode: String(parts[category] ?? '').trim(),
  };
};

const positiveInteger = (value) => {
  const text = typeof value === 'number' ? String(value) : textValue(value).trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
};

/**
 * 「尺码管理.类别」的取值 → 一组类别。
 *
 * ⚠️ 本机测试 Base（生产同形状）只读实测：这一列是**多选**（`type=4`，选项 A/B），
 *    记录 API 回的是**数组**（例：`['A','B']` = 这个尺码男女鞋都用）。
 *    ⇒ 判断"这个尺码属不属于类别 X"必须是**成员判断**，不能拿整格文本做等号比较
 *      （`'A,B' === 'A'` 永远不成立 —— 那会让 38 码在男鞋里变成"缺码"，是错的）。
 *    单选/文本形状（`'A'`）也一并认，防的是"她哪天把这一列改成单选"。
 */
const categoryValues = (cell) => {
  const values = Array.isArray(cell) ? cell : [cell];
  return values
    .flatMap((value) => (Array.isArray(value) ? value : String(value ?? '').split(/[,，、;；\s]+/)))
    .map((value) => textValue(value).trim())
    .filter(Boolean);
};

const asAmount = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = textValue(value).replace(/[¥,\s]/g, '');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 金额文案：整数不补零（`¥399`），带角分才显示小数（`¥399.50`）。 */
const formatPrice = (value, config = SCAN_PAGE) => {
  if (value === null || value === undefined) return config.texts.missingValue;
  const decimals = Number.isInteger(config.price.decimals) && config.price.decimals >= 0 ? config.price.decimals : 2;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(decimals);
  return `${config.price.prefix}${text}`;
};

/** 飞书时间字段 → 毫秒（Date / 数字 / 数字串 / 可解析文本都认；读不出回 0）。 */
const asTimestamp = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 0 : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = textValue(value).trim();
  if (!text) return 0;
  if (/^\d{10,13}$/.test(text)) {
    const number = Number(text);
    return number < 1e12 ? number * 1000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/**
 * 毫秒 → 上海时间文案（**UTC+8**）。
 * ⚠️ 服务端日志是 UTC，但**给她看的**一律 +8（AGENTS.md《协作纪律》第 6 条）。
 */
const shanghaiDateTimeText = (timestamp) => {
  if (!timestamp) return '';
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} `
    + `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
};

const sortSizes = (sizes) => [...sizes].sort((left, right) => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), 'zh-CN');
});

/** 上限超了：**明确报错**，不静默截断（截断出来的库存表是错的数据，比打不开更坏）。 */
const limitError = (tableName, actual, limit) => {
  const error = new Error(`「${tableName}」有 ${actual} 条记录，超过本页本次可读上限 ${limit}`);
  error.scanLimitExceeded = true;
  return error;
};

/**
 * 飞书 GET `filter` 的**公式**拼装（官方《记录筛选的开发指南》：
 * `CurrentValue.[字段名]="值"`、`CurrentValue.[字段名].contains("值")`、`OR(...)`）。
 * `field_name` 一律由调用方按 schema 的物理列名传进来 —— 这里不写死任何一个业务字段名。
 *
 * 🔴 **值是要嵌进公式里的**，所以必须过安全字符检查：
 *    带双引号 / 反斜杠 / 方括号 / 换行的值**一律不拼**（返回 `null` ⇒ 调用方回退整表读）。
 *    宁可慢一次，也绝不让一个"颜色名里带引号"的编号把公式拼坏 ——
 *    拼坏了飞书要么报错、要么按错的条件返回（**错的数据比慢更坏**）。
 */
const FILTER_TEXT_UNSAFE = /["\\[\]\r\n\t]/;
// 官方：`filter` 参数长度不超过 2000 个字符。
const MAX_FILTER_CHARS = 2000;
// 「尺码管理」整表在它自己那份缓存里的键（只有这一张表，键就是常量）。

const filterTextLiteral = (value) => {
  const text = String(value ?? '');
  if (!text || FILTER_TEXT_UNSAFE.test(text)) return null;
  return `"${text}"`;
};

/** `CurrentValue.[字段]="值"`（值不安全 / 字段没配 → `null`）。 */
const equalsFormula = (field, value) => {
  const literal = filterTextLiteral(value);
  return field && literal ? `CurrentValue.[${field}]=${literal}` : null;
};

/** `CurrentValue.[字段].contains("值")`（同上）。 */
const containsFormula = (field, value) => {
  const literal = filterTextLiteral(value);
  return field && literal ? `CurrentValue.[${field}].contains(${literal})` : null;
};

/** `OR(条件1,条件2)`；只有一个条件时就去掉 OR（少一层解析）；拼出来太长也不拼。 */
const orFormula = (parts) => {
  const conditions = (parts || []).filter(Boolean);
  if (!conditions.length) return null;
  if (conditions.length === 1) return conditions[0];
  const formula = `OR(${conditions.join(',')})`;
  return formula.length <= MAX_FILTER_CHARS ? formula : null;
};

const createScanPageService = (gateway, options = {}) => {
  if (!gateway) throw new Error('ScanPageService requires gateway');
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const config = options.config || SCAN_PAGE;
  const getSizeReferences = createSizeReferenceAccess({ gateway, sizeReferences: options.sizeReferences });
  const limits = config.limits;
  const reads = config.reads || {};
  // ⚠️ 开关只在**显式 false** 时关掉（配置项缺失 = 用默认的"开"）：
  //    `filterEnabled` 是"一键退回整表读"的闸门，别因为少传一个字段就静默关掉提速。
  const filterEnabled = reads.filterEnabled !== false;
  const warnOnEmptyFilteredRead = reads.warnOnEmptyFilteredRead !== false;
  // TTL 缓存：`config.cache` 是唯一真源；`options.cache` 供用例注入（自己的时钟/预置条目）。
  const cacheConfig = config.cache || {};
  const cacheTtlMs = cacheConfig.enabled === false ? 0 : cacheConfig.ttlMs;
  const cache = options.cache || createScanPageCache({
    ttlMs: cacheTtlMs,
    maxEntries: cacheConfig.maxEntries,
    now: options.now,
  });
  /**
   * ⭐ 「实时库存」**内存快照**（业务负责人 2026-10-09 同意的第二项优化）。
   *
   * `options.snapshot`：
   *   · 传实例 → 用它（用例注入自己的时钟 / 预置条目）；
   *   · `false` → **彻底不用快照**（行为与提速后逐字一致）；
   *   · 不传 → 按 `config.snapshot` 建一个。
   *
   * ⚠️ `startSnapshot` **默认 false**：定时器/预热只由**生产接线**（`routes/scanPage.js`）打开。
   *    理由有二：① 单测里"多出来一次整表读"会破坏既有用例逐字的调用计数；
   *    ② 定时器是**进程级**资源，不该由"构造一个 service"这种动作偷偷拉起。
   *    没启动的快照永远 `not_ready` ⇒ 调用方**自动回退**到老路径（行为与今天完全一样）。
   */
  const snapshot = options.snapshot === false
    ? null
    : (options.snapshot || createLiveInventorySnapshot({
      gateway,
      config: config.snapshot,
      limits,
      now: options.now,
    }));
  if (snapshot && options.startSnapshot === true) snapshot.start();

  /**
   * ⭐⭐ 「货品信息」**内存快照**（业务负责人 2026-10-09：单价以「货品信息」为唯一真源）。
   *
   * 机制与上面那个「实时库存」快照**完全同一套**（同一个工厂，只是 `tableKey: 'product'`）：
   *   后台定期整表拉一次（默认 60 秒）+ **写操作立刻失效**；
   *   未就绪 / 过期 / 刷新失败 ⇒ **回退现有过滤读**。
   * ⚠️ 它不是"第二套逻辑"：命中时用的仍是**同一个 `findProduct`**（大小写兜底也在里面），
   *    结果与"按编号过滤读"逐字一致。
   */
  const productSnapshot = options.productSnapshot === false
    ? null
    : (options.productSnapshot || createLiveInventorySnapshot({
      gateway,
      config: config.productSnapshot,
      limits,
      tableKey: 'product',
      now: options.now,
    }));
  if (productSnapshot && options.startSnapshot === true) productSnapshot.start();

  /** 时钟：与 TTL 缓存共用（用例可以注入一个假时钟，两个窗口一起被推进）。 */
  const clock = options.now || Date.now;
  /**
   * 各阶段耗时（`Date.now()` 差值）—— 出参 `timing` 由调用方传一个空对象进来，
   * 这样**视图模型一个字都不加**（既有用例对它是逐字 `deepEqual`）。
   * ⚠️ 任何一段抛错时，前面几段已经写进去了 —— "卡在哪一步"正是这么看出来的。
   */
  const startStage = () => clock();
  const elapsed = (startedAt) => Math.max(0, clock() - startedAt);

  /**
   * ⭐ **一条**分阶段耗时汇总（她：「以后一查日志就知道卡在哪一步」）。
   *
   * 只在这里打一次（不是每个阶段一条）—— 由路由在**渲染完之后**调用，
   * 于是 `render_ms` 也能进同一行；失败路径（没找到 / 抛错）同样调用。
   */
  const logTiming = (timing, { requestId = '', found = false } = {}) => {
    if (!timing || typeof timing !== 'object') return;
    logInfo(config.events.lookupTiming, {
      request_id: requestId,
      found: found === true,
      number: timing.number || '',
      cache_hit: timing.cache_hit === true,
      snapshot_hit: timing.snapshot_hit === true,
      // ⭐ 2026-10-09：这两条就是"一次扫码打几次飞书"的直接证据 ——
      //   库存吃快照 + 单价吃「货品信息」内存索引 + 缺码读配置 ⇒ **0 次读**；
      //   任一为 false / `size_source != 'config'` 就说明那一段回退去读了飞书。
      product_snapshot_hit: timing.product_snapshot_hit === true,
      size_source: timing.size_source || '',
      product_ms: Number(timing.product_ms) || 0,
      inventory_ms: Number(timing.inventory_ms) || 0,
      size_ms: Number(timing.size_ms) || 0,
      whole_table_fallback: timing.whole_table_fallback === true,
      render_ms: Number(timing.render_ms) || 0,
      total_ms: Number(timing.total_ms) || 0,
      rows: Number(timing.rows) || 0,
    });
  };

  const tableName = (tableKey) => schema?.tables?.[tableKey]?.tableName || tableKey;

  const readAllCapped = async (tableKey, cap, requestId) => {
    const records = await gateway.listAll(tableKey);
    if (cap > 0 && records.length > cap) {
      logWarn(config.events.limitExceeded, {
        request_id: requestId, table_key: tableKey, records: records.length, limit: cap,
      });
      throw limitError(tableName(tableKey), records.length, cap);
    }
    return records;
  };

  /**
   * 用 `gateway.listByFilter` 读（**唯一**一处 `search/filter` 能力的入口）。
   *
   * 两种**预期**回退（都记 `scan.data.filter_fallback`，行为与提速前逐字一致，只是慢）：
   *   ① 开关关掉了（`reads.filterEnabled=false`）或压根拼不出可用的公式（值含引号等）；
   *   ② 网关没有"按条件读"这个能力（测试桩 / 别的注入实现）。
   * 一种**意外**回退：③ 飞书不认这个公式（字段改名 / 权限不足…）—— 抛错，同样回退。
   *
   * `cap` 是**按条件读的单次上限**（按 `cap + 1` 去读，一眼看出超没超）；
   * `fallbackCap` 是回退整表读时沿用的老上限。超了都**明确报错**，不静默截断。
   *
   * @returns {Promise<{records:Array, fallback:string}>}
   *   `fallback` 非空 = **这一趟走了整表回退**（取值与改动前**逐字一致**：
   *   `unavailable` / `failed`）—— 它就是耗时日志里那个 `whole_table_fallback` 的真源
   *   （"卡在哪一步"要看得见这一档，它正是线上 25 秒那一次的成因）。
   */
  const readFilteredCapped = async ({ tableKey, filter, cap, fallbackCap, requestId }) => {
    const fallback = async (reason, error) => {
      logWarn(config.events.filterFallback, {
        request_id: requestId,
        table_key: tableKey,
        reason,
        error: error ? error.message : '',
      });
      return { records: await readAllCapped(tableKey, fallbackCap, requestId), fallback: reason };
    };
    if (!filterEnabled || !filter || typeof gateway.listByFilter !== 'function') {
      return fallback('unavailable', null);
    }
    let records;
    try {
      records = await gateway.listByFilter(tableKey, filter, { maxRecords: cap > 0 ? cap + 1 : 0 });
    } catch (error) {
      return fallback('failed', error);
    }
    if (cap > 0 && records.length > cap) {
      logWarn(config.events.limitExceeded, {
        request_id: requestId, table_key: tableKey, records: records.length, limit: cap,
      });
      throw limitError(tableName(tableKey), records.length, cap);
    }
    return { records, fallback: '' };
  };

  const findProduct = (products, number) => {
    const numberField = fieldName(schema, 'product', 'number');
    if (!numberField) return null;
    const exact = products.find((record) => textValue(record?.fields?.[numberField]).trim() === number);
    if (exact) return exact;
    if (!config.number.caseInsensitiveFallback) return null;
    const lower = number.toLowerCase();
    return products.find((record) => textValue(record?.fields?.[numberField]).trim().toLowerCase() === lower) || null;
  };

  /**
   * 一条「实时库存」属于不属于这个编号？
   *   ① 首选**关联记录 id**（「实时库存.编号」→「货品信息」）—— 这是权威判据；
   *   ② 关联单元格为空时，用「库存键」公式（`货号|颜色|类别|尺码`）的**前缀**兜底
   *      —— 只在"关联被清空、但公式还在"这种数据残缺时才生效，不会重复计数。
   */
  const belongsToNumber = (record, { productId, number, stockKeyField }) => {
    const ids = linkedRecordIds(readField(schema, 'liveInventory', record, 'product'));
    if (productId && ids.includes(productId)) return true;
    if (ids.length || !config.number.stockKeyPrefixFallback || !stockKeyField) return false;
    const key = textValue(record?.fields?.[stockKeyField]).trim();
    return key.startsWith(`${number}${config.number.separator}`);
  };

  /**
   * 「货品信息」：**按「编号」精确匹配读**（正常就 1 条），再在内存里跑同一个 `findProduct`
   * （精确 + 大小写兜底都在里面）。
   *
   * ⚠️ 按「编号」过滤用 **GET 的 filter 公式**（官方《记录筛选的开发指南》的字段表里
   *    **公式**是支持的类型），不用 `POST .../records/search`：
   *    那个接口返回的公式列是 `{type:1,value:[{text}]}`、关联列只有 `link_record_ids`
   *    （**没有显示文本**）—— 会让「品类」「颜色」这类关联文字读不出来（页面会变）。
   *    GET + filter 的返回体与 `listAll` **逐字同形状**（见 `V1BitableGateway.listByFilter` 的注释）。
   * ⚠️ GET 的 filter **区分大小写**（本机实测：`编号="xhb8095|黑色|A"` 匹配不到大写那条）
   *    ⇒ "她照着标签手打一遍"那种大小写不一致的输入会走下面的整表回退，**结论不变、只是慢一次**。
   *
   * 返回 `resolved`：
   *   · `true`  —— 按条件读**确实读到了行** ⇒ 没匹配上「编号」就是真的没有；
   *   · `false` —— 一条都没读到（大小写不一致 / 老数据 / 值里有引号拼不出公式）
   *               ⇒ 调用方**回退整表读**再找一次，"找不到"的判定与提速前逐字一致。
   * `fallback` 非空 = 这一趟已经走了整表回退（耗时日志的 `whole_table_fallback` 用它）。
   */
  const readProductsByNumber = async ({ number, requestId }) => {
    const numberField = fieldName(schema, 'product', 'number');
    const filter = equalsFormula(numberField, number);
    if (!filterEnabled || !filter) return { product: null, resolved: false, fallback: 'unavailable' };
    const read = await readFilteredCapped({
      tableKey: 'product',
      filter,
      cap: limits.productRowsPerNumber,
      fallbackCap: limits.productRecords,
      requestId,
    });
    if (!read.records.length && warnOnEmptyFilteredRead) {
      logWarn(config.events.filteredEmpty, { request_id: requestId, table_key: 'product', number });
    }
    return {
      product: findProduct(read.records, number),
      resolved: read.records.length > 0,
      fallback: read.fallback,
    };
  };

  /**
   * 「实时库存」：**按条件只读这一款的行**（提速的主要手段 —— 提速前这里是整表读，真机 5~9 秒）。
   *
   * filter = `OR(「编号」关联 = 这一款的编号文本, 「库存键」.contains(「编号|」))`：
   *   · 两条**同源**于内存判据 `belongsToNumber`（① 关联命中；② 关联为空时按公式前缀兜底）；
   *   · ⚠️ **缺一不可**：只按关联读会漏掉"关联单元格被清空、但公式还在"的数据残缺行
   *     （既有用例 `② 关联单元格为空时用「库存键」前缀认行` 钉着它）。
   *     关联列按**显示文本**筛（GET 的 filter 只支持这么筛，实测可用）；
   *   · 过滤读回来**仍然过一遍 `belongsToNumber`**（OR 前缀那条是**超集**：
   *     关联存在但指错的行也会被前缀命中）⇒ 最终行集与提速前**逐字一致**。
   *
   * ⚠️ 拼公式用的是**表里那条货品的编号**（`tableNumber`，调用方从刚读到的货品上抄），
   *    **不是** URL 里那串：URL 可能是大小写不一致的手输值，而 filter 区分大小写 ——
   *    用 URL 那串去筛会**一条都读不到**（页面会显示"一双都没有"，是最坏的那种错）。
   *    内存判据仍然用 URL 那串（与提速前一致）。
   *
   * @returns {Promise<{rows:Array, fallback:string}>} `fallback` 非空 = 走了整表回退。
   */
  const readInventoryRows = async ({ productId, tableNumber, number, stockKeyField, requestId }) => {
    const linkField = fieldName(schema, 'liveInventory', 'product');
    const conditions = [
      equalsFormula(linkField, tableNumber),
      config.number.stockKeyPrefixFallback
        ? containsFormula(stockKeyField, `${tableNumber}${config.number.separator}`)
        : null,
    ];
    const read = await readFilteredCapped({
      tableKey: 'liveInventory',
      filter: orFormula(conditions),
      cap: limits.inventoryRowsPerNumber,
      fallbackCap: limits.inventoryRecords,
      requestId,
    });
    const rows = read.records.filter((record) => belongsToNumber(record, { productId, number, stockKeyField }));
    // 「库存真的为 0」与「filter 悄悄不生效」在返回体上长得一样 ⇒ 留一条可 grep 的 warn，不当成静默的成功。
    if (!rows.length && warnOnEmptyFilteredRead) {
      logWarn(config.events.filteredEmpty, {
        request_id: requestId, table_key: 'liveInventory', number, product_record_id: productId,
      });
    }
    return { rows, fallback: read.fallback };
  };

  /**
   * ⭐ 「实时库存」这一款的行 —— **内存快照优先**，未就绪 / 过期就回退"按编号过滤读"。
   *
   * ⚠️ 两条路径用的是**同一份内存判据**（`belongsToNumber`）⇒ 行集逐字一致
   *    （用例 `AC-S1` 对 `rows` / `total` / `missing_count` 做 deepEqual 钉着）。
   * ⚠️ 未就绪 / 过期时**记一条 `scan.snapshot.miss`**（带 `reason`）—— 不静默；
   *    她那边按这个词就能回答"这次为什么又慢了"。
   */
  const readInventoryRecords = async ({ productId, tableNumber, number, stockKeyField, requestId }) => {
    if (snapshot) {
      const current = snapshot.get();
      if (current.ready) {
        return {
          rows: current.records.filter((record) => belongsToNumber(record, { productId, number, stockKeyField })),
          snapshotHit: true,
          fallback: '',
        };
      }
      logInfo(config.events.snapshotMiss, {
        request_id: requestId,
        number,
        reason: current.reason,
        age_ms: current.ageMs === null || current.ageMs === undefined ? -1 : current.ageMs,
      });
    }
    const read = await readInventoryRows({ productId, tableNumber, number, stockKeyField, requestId });
    return { rows: read.rows, snapshotHit: false, fallback: read.fallback };
  };

  /** 一行的尺码：关联记录（共享解析，带 30 秒缓存）→ 「库存键」最后一段 → 读不出。 */
  const resolveRowSize = async (record, stockKeyField) => {
    const cell = readField(schema, 'liveInventory', record, 'size');
    try {
      const entry = await getSizeReferences().resolveLinkedCell(cell);
      return entry.size;
    } catch (_) {
      if (!stockKeyField) return null;
      const key = textValue(record?.fields?.[stockKeyField]).trim();
      if (!key) return null;
      const parts = key.split(config.number.separator);
      return positiveInteger(parts[parts.length - 1]);
    }
  };

  /**
   * 缺码判定用的尺码清单：**配置里的尺码段**（A 男 38–48 / B 女 34–43）。
   *
   * ⭐⭐ 2026-10-09（业务负责人定）：这一段原来每次扫码都要整表读「尺码管理」算类别清单
   *   （一次飞书往返 1.5~2.5 秒）⇒ 改成**读配置**（`config.sizeSegments.ranges`）。
   *   ⚠️ 这不是"把会变的东西写死"：段本身是**配置**（换一个值不用改代码），
   *      而且有**一致性保险**——`maybeCheckSizeConsistency` 定期拿配置与「尺码管理」比对，
   *      不一致就 logWarn（例如表里加了 49 码）。
   *
   * 降级口径**一个字没变**（拿不到就不做缺码提示，只显示有货的尺码）：
   *   · 类别为空（编号里没有第 3 段）→ `number_without_category`；
   *   · 配置里没有这个类别 → `no_sizes_for_category`。
   */
  const loadSizeScope = async ({ categoryCode }) => {
    const ranges = config.sizeSegments?.ranges || {};
    if (!categoryCode) return { degraded: true, reason: 'number_without_category', sizes: [] };
    const range = ranges[String(categoryCode).trim().toUpperCase()];
    if (!range) return { degraded: true, reason: 'no_sizes_for_category', sizes: [] };
    const from = positiveInteger(range.from);
    const to = positiveInteger(range.to);
    if (from === null || to === null || to < from) {
      return { degraded: true, reason: 'segment_config_invalid', sizes: [] };
    }
    const sizes = [];
    for (let size = from; size <= to; size += 1) sizes.push(size);
    return { degraded: false, reason: '', sizes: sortSizes(sizes) };
  };

  /**
   * ⭐ **一致性保险**（业务负责人 2026-10-09）：定期拿**配置里的尺码段**与
   * 「尺码管理」表比对，不一致就 `logWarn(scan.size_consistency.mismatch)`。
   *
   * 为什么要有它：缺码判定改成读配置之后，"表里改了尺码、配置没跟"这类漂移就没人拦了
   * —— 这条 warn 就是那道拦网（**只记日志**：不改配置、不改表）。
   *
   * ⚠️ **定期**（TTL 内一次都不读那张表，默认 10 分钟）：若每次扫码都比对，
   *    等于又把那 1.5~2.5 秒的往返加回来了。
   * ⚠️ 比对本⾝**永不抛**、也不阻塞失败路径：读不到就静默跳过（下次 TTL 到了再试）。
   */
  // ⚠️ `at: -1`（不是 0）：注入时钟从 0 开始的用例也要能区分“从没查过”与“0 时刻查过”。
  const sizeConsistencyCheckedAt = { at: -1 };
  // ⚠️ 时钟走 `options.now`（与缓存/快照同一口）：用例注入自己的时钟就能测"TTL 到点才比对"。
  const nowFn = options.now || Date.now;
  const maybeCheckSizeConsistency = async ({ requestId = '', force = false } = {}) => {
    const settings = config.sizeSegments?.consistencyCheck || {};
    if (settings.enabled === false) return { checked: false, reason: 'disabled' };
    const ttlMs = Number(settings.ttlMs) > 0 ? Number(settings.ttlMs) : 0;
    const nowMs = nowFn();
    if (!force && ttlMs > 0 && sizeConsistencyCheckedAt.at >= 0
      && nowMs - sizeConsistencyCheckedAt.at < ttlMs) {
      return { checked: false, reason: 'ttl' };
    }
    sizeConsistencyCheckedAt.at = nowMs;
    try {
      const sizeRecords = await readAllCapped('sizeManagement', limits.sizeRecords, requestId);
      const sizeField = fieldName(schema, 'sizeManagement', 'size');
      const categoryField = config.fieldNamesPendingSchema?.sizeCategory || '';
      const actual = new Map();
      for (const record of sizeRecords) {
        const categories = categoryField ? categoryValues(record?.fields?.[categoryField]) : [];
        const size = positiveInteger(readField(schema, 'sizeManagement', record, 'size') ?? record?.fields?.[sizeField]);
        if (size === null) continue;
        for (const category of categories) {
          if (!actual.has(category)) actual.set(category, new Set());
          actual.get(category).add(size);
        }
      }
      if (!categoryField) return { checked: false, reason: 'no_category_column' };
      const mismatches = [];
      for (const [category, range] of Object.entries(config.sizeSegments?.ranges || {})) {
        const expected = new Set();
        for (let size = range.from; size <= range.to; size += 1) expected.add(size);
        const found = actual.get(category) || new Set();
        const missingInConfig = [...found].filter((size) => !expected.has(size)).sort((a, b) => a - b);
        const missingInTable = [...expected].filter((size) => !found.has(size)).sort((a, b) => a - b);
        if (missingInConfig.length || missingInTable.length) {
          mismatches.push({
            category, in_table_not_in_config: missingInConfig, in_config_not_in_table: missingInTable,
          });
        }
      }
      if (mismatches.length) {
        logWarn(config.events.sizeConsistencyMismatch, {
          request_id: requestId || undefined,
          // ⚠️ 只报**尺寸段**这一层的不一致（哪些码多了/少了），不改配置、不改表。
          mismatches: mismatches.map((item) => `${item.category}:+[${item.in_table_not_in_config.join(',')}]-[${item.in_config_not_in_table.join(',')}]`),
          hint: '配置里的尺码段与「尺码管理」不一致：要么改配置（SCAN_PAGE 的 sizeSegments），要么改表',
        });
      }
      return { checked: true, mismatches };
    } catch (error) {
      // 读不到「尺码管理」：静默跳过（下次 TTL 到了再试）—— 这条保险不该让扫码变慢或变红。
      return { checked: false, reason: 'read_failed', error: error.message };
    }
  };

  /**
   * 查一个编号。
   * 返回 `{ found: false, number, reason }`（`reason`: `empty` / `unknown`）或
   *      `{ found: true, ...视图模型 }`。
   *
   * ⭐ 取数顺序（2026-10-08 提速后）：缓存 → 「货品信息」（按编号过滤）→「实时库存」
   *    （**内存快照**优先，未就绪才回退按关联 + 库存键前缀过滤读）→「尺码管理」（整表，15 条）。
   *    命中缓存时**一次飞书请求都不打**，并且照样记 `scan.page.viewed`（日志口径不断）。
   *
   * ⭐ 2026-10-09：多了**出参 `timing`**（调用方给一个空对象，这里把各阶段毫秒写进去）。
   *    刻意用出参而不是往视图模型上挂字段：既有的用例对视图模型是**逐字 deepEqual**。
   */
  /**
   * 外面这一层只管**总耗时**：取数这一段无论成功、抛错、还是提前 return，
   * `total_ms` 都会被写进 `timing` —— 她要的正是"**失败也看得出卡在哪一步**"。
   * 真正的取数在 `performLookup`（下面），两层的参数逐字相同。
   */
  const lookup = async ({ number: rawNumber, requestId, timing = null } = {}) => {
    const totalStartedAt = startStage();
    try {
      return await performLookup({ rawNumber, requestId, timing });
    } finally {
      if (timing) timing.total_ms = elapsed(totalStartedAt);
    }
  };

  const performLookup = async ({ rawNumber, requestId, timing = null } = {}) => {
    const number = decodeScanNumber(rawNumber, config);
    if (timing) {
      timing.number = number;
      timing.cache_hit = false;
      timing.snapshot_hit = false;
      timing.product_snapshot_hit = false;
      timing.size_source = '';
      timing.product_ms = 0;
      timing.inventory_ms = 0;
      timing.size_ms = 0;
      timing.whole_table_fallback = false;
      timing.rows = 0;
      timing.total_ms = 0;
    }
    if (!number) return { found: false, number, reason: 'empty' };

    const cached = cache.get(number);
    if (cached) {
      logInfo(config.events.cacheHit, { request_id: requestId, number, cache_hit: true, ttl_ms: cache.ttlMs });
      // 「看了这一页」这个事实**不许因为走了缓存就消失**（她那边按这个词 grep）。
      logInfo(config.events.viewed, {
        request_id: requestId,
        number,
        product_record_id: cached.product_record_id,
        total: cached.total,
        sizes: cached.rows.length,
        missing: cached.missing_count,
        sizes_degraded: cached.sizes_degraded,
        cache_hit: true,
      });
      if (timing) {
        // 命中缓存 = 一次飞书都没打 ⇒ 三个阶段都是 0（"快在哪"也要看得见）。
        timing.cache_hit = true;
        timing.rows = cached.total;
      }
      return cached;
    }
    logInfo(config.events.cacheMiss, { request_id: requestId, number, cache_hit: false });

    const parsed = parseNumberSegments(number, config);
    const productStartedAt = startStage();
    let product = null;
    let wholeTableFallback = false;
    try {
      // ⭐⭐ 2026-10-09：**先查「货品信息」内存快照**（按编号索引）——命中就 **0 次飞书调用**。
      //    单价仍以「货品信息」为唯一真源（她的口径），只是从内存里取。
      //    未就绪 / 过期 / 没这一条 ⇒ 回退下面那条**既有的过滤读**（行为逐字不变）。
      const indexed = productSnapshot ? productSnapshot.get() : { ready: false, reason: 'disabled' };
      if (indexed.ready) {
        product = findProduct(indexed.records, number);
        if (timing) timing.product_snapshot_hit = Boolean(product);
      }
      if (!product) {
        const filteredProduct = await readProductsByNumber({ number, requestId });
        product = filteredProduct.product;
        wholeTableFallback = Boolean(filteredProduct.fallback);
        if (!product && !filteredProduct.resolved) {
          // 按条件读一条都没读到 ⇒ **回退整表读**再找一次：
          // 「找不到」的判定与提速前**逐字一致**（宁可慢这一次，也不许把"有货"判成"没这条编号"）。
          const products = await readAllCapped('product', limits.productRecords, requestId);
          product = findProduct(products, number);
          wholeTableFallback = true;
        }
      }
    } finally {
      // ⚠️ 用 finally：这一阶段**抛错时也要**留下 product_ms（"卡在货品信息那一步"就是这么看出来的）。
      if (timing) {
        timing.product_ms = elapsed(productStartedAt);
        timing.whole_table_fallback = wholeTableFallback;
      }
    }
    if (!product) {
      logInfo(config.events.notFound, { request_id: requestId, number });
      return { found: false, number, reason: 'unknown' };
    }

    const stockKeyField = fieldName(schema, 'liveInventory', 'stockKey');
    const productId = product.record_id || '';
    // ⚠️ 拼 filter 用**表里那条货品的编号**（大小写与表一致），内存判据仍用 URL 那串：
    //    GET 的 filter 区分大小写，拿 URL 那串去筛可能一条都读不到（最坏的那种错）。
    const tableNumber = textValue(readField(schema, 'product', product, 'number')).trim() || number;
    const inventoryStartedAt = startStage();
    let inventory;
    try {
      inventory = await readInventoryRecords({ productId, tableNumber, number, stockKeyField, requestId });
    } finally {
      if (timing) timing.inventory_ms = elapsed(inventoryStartedAt);
    }
    const rows = inventory.rows;
    if (timing) {
      timing.snapshot_hit = inventory.snapshotHit === true;
      timing.whole_table_fallback = timing.whole_table_fallback || Boolean(inventory.fallback);
      timing.rows = rows.length;
    }

    const stateField = fieldName(schema, 'liveInventory', 'state');
    const updatedAtField = fieldName(schema, 'liveInventory', 'updatedAt');
    const inventoryCategoryField = fieldName(schema, 'liveInventory', 'category');
    const buckets = new Map();
    const stateCounts = new Map();
    const unresolvedByState = new Map();
    let unresolvedRows = 0;
    let inventoryCategory = '';
    let updatedAt = 0;

    for (const record of rows) {
      const size = await resolveRowSize(record, stockKeyField);
      const state = stateField ? textValue(record?.fields?.[stateField]).trim() : '';
      stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
      const timestamp = updatedAtField ? asTimestamp(record?.fields?.[updatedAtField]) : 0;
      if (timestamp > updatedAt) updatedAt = timestamp;
      if (!inventoryCategory && inventoryCategoryField) {
        inventoryCategory = textValue(record?.fields?.[inventoryCategoryField]).trim();
      }
      if (size === null) {
        unresolvedRows += 1;
        unresolvedByState.set(state, (unresolvedByState.get(state) || 0) + 1);
        continue;
      }
      const bucket = buckets.get(size) || { size, counts: new Map() };
      bucket.counts.set(state, (bucket.counts.get(state) || 0) + 1);
      buckets.set(size, bucket);
    }
    const total = rows.length;

    const sizeStartedAt = startStage();
    let scope;
    try {
      // ⭐ 2026-10-09：缺码判定**读配置段**（不再每次读「尺码管理」）。
      scope = await loadSizeScope({ categoryCode: parsed.categoryCode });
      // ⭐ 缺码这一段是**读配置**还是**降级**（`scan.lookup.timing` 里就靠它看"有没有回退"）。
      if (timing) timing.size_source = scope.degraded ? `degraded:${scope.reason}` : 'config';
      // ⭐ 一致性保险（**定期**，默认 10 分钟一次）：拿配置与「尺码管理」比对，不一致就 warn。
      //    它只在 TTL 到点那一趟真的读一次那张表 —— 平时这一趟是 **0 次调用**。
      await maybeCheckSizeConsistency({ requestId });
    } finally {
      if (timing) timing.size_ms = elapsed(sizeStartedAt);
    }
    if (!scope.degraded) {
      // 只有**没有库存**的那些清单尺码才需要限流：有库存的尺码一行都不许丢，
      // 否则"共 N 双"会与明细对不上。
      const stockSizes = new Set(buckets.keys());
      const scopeOnly = scope.sizes.filter((size) => !stockSizes.has(size));
      if (scopeOnly.length > limits.sizesPerNumber) {
        scope.sizes = scope.sizes.filter((size) => stockSizes.has(size) || scopeOnly.indexOf(size) < limits.sizesPerNumber);
        scope.truncated = true;
      }
    }
    if (scope.degraded) {
      logWarn(config.events.sizesDegraded, {
        request_id: requestId, number, category: parsed.categoryCode, reason: scope.reason,
      });
    }

    const configuredStates = config.states.columns;
    const extraStates = [...stateCounts.keys()].filter((state) => state && !configuredStates.includes(state));
    const columns = [
      ...configuredStates.map((state) => ({ key: state, label: state })),
      ...extraStates.map((state) => ({ key: state, label: state })),
    ];
    const emptyStateRows = stateCounts.get('') || 0;
    if (emptyStateRows) columns.push({ key: '', label: config.states.emptyLabel });
    const unexpectedStateRows = extraStates.reduce((sum, state) => sum + (stateCounts.get(state) || 0), 0);
    if (unexpectedStateRows) {
      logWarn(config.events.unknownState, {
        request_id: requestId, number, states: extraStates, records: unexpectedStateRows,
      });
    }
    if (unresolvedRows) {
      logWarn(config.events.unknownSize, { request_id: requestId, number, records: unresolvedRows });
    }

    // `counts` 可能是 `undefined`：**缺码那一行**（清单里有、库存一条都没有）根本没有 bucket。
    const countOf = (counts, state) => (counts ? counts.get(state) || 0 : 0);
    const scopeSet = new Set(scope.sizes);
    const renderSizes = sortSizes([...new Set([...buckets.keys(), ...scope.sizes])]);
    const viewRows = renderSizes.map((size) => {
      const bucket = buckets.get(size);
      const cells = columns.map((column) => ({ key: column.key, count: countOf(bucket?.counts, column.key) }));
      const rowTotal = cells.reduce((sum, cell) => sum + cell.count, 0);
      return {
        size_text: String(size),
        cells,
        total: rowTotal,
        // 缺码 = 这个尺码在「尺码管理」的该类别清单里、但三种状态都没有库存。
        missing: Boolean(config.missingSize.enabled && !scope.degraded && scopeSet.has(size) && rowTotal === 0),
      };
    });
    if (unresolvedRows) {
      viewRows.push({
        size_text: config.texts.unknownSizeLabel,
        cells: columns.map((column) => ({ key: column.key, count: countOf(unresolvedByState, column.key) })),
        total: unresolvedRows,
        missing: false,
        unknown_size: true,
      });
    }

    const notes = [];
    if (scope.degraded) notes.push(config.texts.degradedSizesNote);
    if (scope.truncated) notes.push(fillText(config.texts.truncatedSizesNote, { count: limits.sizesPerNumber }));
    if (unexpectedStateRows) notes.push(fillText(config.texts.unknownStateNote, { count: unexpectedStateRows }));
    if (unresolvedRows) notes.push(fillText(config.texts.unknownSizeNote, { count: unresolvedRows }));
    const missingCount = viewRows.filter((row) => row.missing).length;
    if (missingCount) notes.push(config.missingSize.hint);

    const productText = (semanticKey) => textValue(readField(schema, 'product', product, semanticKey)).trim();
    const categoryNameField = config.fieldNamesPendingSchema?.productCategoryName || '';
    const view = {
      found: true,
      number,
      item_no: productText('itemNo') || parsed.itemNo,
      color: productText('color') || parsed.color,
      category_code: productText('category') || parsed.categoryCode,
      // 「品类」（休闲鞋 / 单鞋…）：优先「货品信息.品类」，再退「实时库存.品类」公式。
      category_name: (categoryNameField ? textValue(product?.fields?.[categoryNameField]).trim() : '') || inventoryCategory,
      price_text: formatPrice(asAmount(readField(schema, 'product', product, 'price')), config),
      total,
      columns: columns.map((column) => ({ key: column.key, label: column.label })),
      rows: viewRows,
      missing_count: missingCount,
      sizes_degraded: scope.degraded,
      scope_reason: scope.reason,
      notes,
      updated_at_text: updatedAt ? shanghaiDateTimeText(updatedAt) : config.texts.updatedAtUnknown,
      product_record_id: productId,
    };

    logInfo(config.events.viewed, {
      request_id: requestId,
      number,
      product_record_id: productId,
      total,
      sizes: viewRows.length,
      missing: missingCount,
      sizes_degraded: scope.degraded,
      cache_hit: false,
      // ⚠️ 2026-10-09：`size_cache_hit` 不再有意义（缺码判定读配置，不读「尺码管理」）——
      //    这一趟有没有读那张表，看有没有 `scan.size_consistency.mismatch` / 那条 TTL 就够。
      size_source: 'config',
    });
    // 只缓存 `found: true`（否定结果不缓存：新品刚建档就该立刻扫得到）。
    cache.set(number, view);
    // ⚠️ `total_ms`（取数这一段）由最外层的 `lookup` 统一写；路由渲染完再把 `render_ms` 加进来。
    return view;
  };

  return { lookup, logTiming, cache, snapshot };
};

module.exports = {
  createScanPageService,
  decodeScanNumber,
  parseNumberSegments,
  formatPrice,
  shanghaiDateTimeText,
  sortSizes,
};
