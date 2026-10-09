/**
 * 扫码页**提速**的用例（2026-10-08：业务负责人「扫码页打开有点慢」）。
 *
 * 提速前的形状（真机实测）：`GET /s/:number` **每次整表读三张表**
 * （「货品信息」+「实时库存」+「尺码管理」⇒ 4+ 次分页请求，其中整表读「实时库存」5~9 秒）。
 * 提速后：按条件只读需要的那几行（`GET .../records?filter=<公式>`）+ 进程内短 TTL 缓存。
 *
 * 这个文件钉住五件事（brief 点名）：
 *   ① **按条件读真的少读**：调用的形状（表 / 公式 / 上限）+ 整表读**不再发生**；
 *      且按条件读出来的视图与整表读**逐字一致**（少读不等于少算）；
 *   ② **回退**：拿不到"按条件读"的能力 / 飞书不认这个公式 / 开关关掉 / 值没法安全拼进公式 ⇒
 *      回退整表读，页面**照旧对**（宁可慢，不许错）；大小写不一致那种手输也走这条退路；
 *   ③ **缓存**：命中不重复读、TTL 过期后重读、日志里有 `cache_hit/cache_miss`、
 *      "没找到"不进缓存、有容量上限；
 *   ④ **只读**：假网关的写方法一碰就抛 + 源码扫描（新文件也在扫描名单里）；
 *   ⑤ `V1BitableGateway.listByFilter` 自身的请求形状（filter 原样透传 / 分页 / 上限 / 报错），
 *      以及 `listAll` **一个字没改**。
 *
 * 夹具照**真实 Base 的列形状**写（本机测试 Base 只读实测）：
 *   · 「货品信息.编号」是**公式**（`type=20`，内容 `货号|颜色|类别`）、「货号」是多行文本；
 *   · 「实时库存.编号」是**关联**（`record_ids` + 显示文本）、「库存键」是公式；
 *   · 「尺码管理.类别」是**多选**（`type=4`，选项 A/B）。
 *
 * ⭐⭐ 2026-10-09（业务负责人定）：**缺码判定改读配置里的尺码段**
 *   （`config/scanPage.js` 的 `sizeSegments`：A 男 38–48 / B 女 34–43）——
 *   不再每次扫码读「尺码管理」算类别清单 ⇒ 本文件里"缺码 = 1 个"那类断言
 *   按新口径改（A 段的 11 个码里，库存为 0 的**每一个**都算缺码）。
 *   ⚠️ 「尺码管理」现在只被**一致性保险**（定期，默认 10 分钟一次）与
 *      共享的 `SizeReferenceService` 读。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageService } = require('../src/services/scanPageService');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（测试 Base 的真实形状）──────────────────────────────────────────────
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: [{ text: NUMBER, type: 'text' }],
    货号: 'YD6693-2',
    颜色: [{ record_ids: ['color_black'], text: '黑色', text_arr: ['黑色'], type: 'text' }],
    类别: 'A',
    品类: [{ record_ids: ['cat_casual'], text: '休闲鞋', text_arr: ['休闲鞋'], type: 'text' }],
    单价: '399',
  },
};
const OTHER_PRODUCT = {
  record_id: 'prod_2',
  fields: {
    编号: [{ text: 'X7601|蓝|A', type: 'text' }],
    货号: 'X7601',
    颜色: [{ record_ids: ['color_blue'], text: '蓝', text_arr: ['蓝'], type: 'text' }],
    类别: 'A',
    品类: [{ record_ids: ['cat_casual'], text: '休闲鞋', text_arr: ['休闲鞋'], type: 'text' }],
    单价: '249',
  },
};
const SIZE_RECORDS = [
  { record_id: 'size_40', fields: { 尺码: 40, 类别: ['A'] } },
  { record_id: 'size_41', fields: { 尺码: 41, 类别: ['A'] } },
  { record_id: 'size_42', fields: { 尺码: 42, 类别: ['A'] } },
  { record_id: 'size_38', fields: { 尺码: 38, 类别: ['B'] } },
];
const inventoryRow = (id, productId, number, sizeRecordId, size, state) => ({
  record_id: id,
  fields: {
    编号: [{ record_ids: [productId], text: number, text_arr: [number], type: 'text' }],
    尺码: [{ record_ids: [sizeRecordId], text: String(size), text_arr: [String(size)], type: 'text' }],
    所属状态: state,
    库存键: [{ text: `${number}|${size}`, type: 'text' }],
    品类: [{ text: '休闲鞋', type: 'text' }],
  },
});
const INVENTORY = [
  inventoryRow('inv_40_box', 'prod_1', NUMBER, 'size_40', 40, '门盒'),
  inventoryRow('inv_42_box', 'prod_1', NUMBER, 'size_42', 42, '门盒'),
  inventoryRow('inv_42_sample', 'prod_1', NUMBER, 'size_42', 42, '样品'),
  // 别的货品：**一条都不许**混进来
  inventoryRow('inv_other', 'prod_2', 'X7601|蓝|A', 'size_42', 42, '门盒'),
];
const FIXTURES = { product: [PRODUCT, OTHER_PRODUCT], liveInventory: INVENTORY, sizeManagement: SIZE_RECORDS };

// ── 假网关：带"按条件读"（照真 filter 公式的语义在夹具上筛，并记下每一次调用）──
const cellText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

/** 把 `OR(a,b)` 拆开（引号里的逗号不算分隔符）。 */
const splitTopLevel = (text) => {
  const parts = [];
  let current = '';
  let inQuote = false;
  for (const char of text) {
    if (char === '"') inQuote = !inQuote;
    if (char === ',' && !inQuote) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts;
};

/** 假网关只认我们在扫码页里真的会拼出来的两种公式 + OR（照真接口的**区分大小写**语义）。 */
const matchesFormula = (record, formula) => {
  if (formula.startsWith('OR(') && formula.endsWith(')')) {
    return splitTopLevel(formula.slice(3, -1)).some((part) => matchesFormula(record, part));
  }
  const equals = formula.match(/^CurrentValue\.\[(.+?)\]="(.*)"$/);
  if (equals) return cellText(record?.fields?.[equals[1]]).trim() === equals[2];
  const contains = formula.match(/^CurrentValue\.\[(.+?)\]\.contains\("(.*)"\)$/);
  if (contains) return cellText(record?.fields?.[contains[1]]).includes(contains[2]);
  throw new Error(`假网关不认这个公式：${formula}`);
};

const fakeGateway = ({
  fixtures = FIXTURES,
  filtered = true,
  filterError = null,
} = {}) => {
  const calls = [];
  const writes = [];
  const boom = (name) => async () => {
    writes.push(name);
    throw new Error(`扫码页不许写：${name}`);
  };
  const gateway = {
    calls,
    writes,
    listAllCalls: () => calls.filter((call) => call.kind === 'listAll'),
    filterCalls: () => calls.filter((call) => call.kind === 'listByFilter'),
    filterOf: (tableKey) => (calls.find((call) => call.kind === 'listByFilter' && call.tableKey === tableKey) || {}).filter,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      calls.push({ kind: 'listAll', tableKey: key });
      return (fixtures[key] || []).map((record) => record);
    },
    create: boom('create'),
    update: boom('update'),
    delete: boom('delete'),
  };
  if (filtered) {
    gateway.listByFilter = async (tableKey, filter, options = {}) => {
      calls.push({ kind: 'listByFilter', tableKey, filter, options });
      if (filterError) throw new Error(filterError);
      const rows = (fixtures[tableKey] || []).filter((record) => matchesFormula(record, filter));
      return typeof options.maxRecords === 'number' && options.maxRecords > 0
        ? rows.slice(0, options.maxRecords) : rows;
    };
  }
  return gateway;
};

const service = (gateway, config = SCAN_PAGE, options = {}) =>
  createScanPageService(gateway, { config, ...options });

/** 结构化日志的出口就是 console.log/warn/error（沿用 arrivalConversation.test.js 的范式）。 */
const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map((value) => String(value)).join(' ')); };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// ① 按条件读：调用的形状 + 整表读不再发生
// ═══════════════════════════════════════════════════════════════════════════

test('① 按条件读：只读这款货品的行 —— 两张表的 filter 公式与上限（且它们都不再整表读）', async () => {
  const gateway = fakeGateway();
  const view = await service(gateway).lookup({ number: NUMBER, requestId: 'req_shape' });

  assert.equal(view.found, true);
  assert.equal(view.total, 3, '只有这一款的 3 双进来（别的货品的行一条都不许混）');

  // 「货品信息」：按「编号」精确匹配（公式列；用 GET 的 filter 公式，返回体与 listAll 同形状）
  assert.deepEqual(gateway.filterCalls()[0], {
    kind: 'listByFilter',
    tableKey: 'product',
    filter: `CurrentValue.[编号]="${NUMBER}"`,
    options: { maxRecords: SCAN_PAGE.limits.productRowsPerNumber + 1 },
  });

  // 「实时库存」：OR(「编号」关联的显示文本 = 这一款的编号, 「库存键」.contains("编号|"))
  assert.deepEqual(gateway.filterCalls()[1], {
    kind: 'listByFilter',
    tableKey: 'liveInventory',
    filter: `OR(CurrentValue.[编号]="${NUMBER}",CurrentValue.[库存键].contains("${NUMBER}|"))`,
    options: { maxRecords: SCAN_PAGE.limits.inventoryRowsPerNumber + 1 },
  });
  assert.equal(gateway.filterCalls().length, 2, '只有这两张表走"按条件读"');

  // ⭐ 2026-10-09：缺码判定**读配置**，不再为它整表读「尺码管理」——
  //    这张表现在只被两件事读：① 行尺码的关联解析（`SizeReferenceService`，带缓存）；
  //    ② **一致性保险**（定期比对配置与表，默认 10 分钟一次）。
  assert.deepEqual(
    gateway.listAllCalls().map((call) => call.tableKey).filter((key) => key === 'product' || key === 'liveInventory'),
    [],
    '货品信息 / 实时库存**一次整表读都不许有**（这就是提速本身）',
  );
  // ⭐ 2026-10-09：这一趟读「尺码管理」的次数是**常数**（与扫码次数无关）：
  //    ① 行尺码的关联解析（`SizeReferenceService`，每个 service 只整表读一次）；
  //    ② **一致性保险**（每个 service 每个 TTL 窗口最多一次）。
  //    ⇒ 缺码判定这条路上**一次都不读**（与提速前"每次扫码都读"正好相反）。
  const sizeReads = gateway.listAllCalls().filter((call) => call.tableKey === 'sizeManagement').length;
  assert.ok(sizeReads <= 2, `「尺码管理」在这一趟里最多两次（实际 ${sizeReads}）`);
});

test('① 按条件读 vs 整表读：视图**逐字一致**（少读 ≠ 少算）', async () => {
  const filteredView = await service(fakeGateway()).lookup({ number: NUMBER, requestId: 'req_f' });
  const wholeView = await service(fakeGateway({ filtered: false })).lookup({ number: NUMBER, requestId: 'req_w' });
  assert.deepEqual(filteredView, wholeView);
  assert.equal(filteredView.total, 3);
  // ⭐ 2026-10-09：缺码 = **配置段（A 男 38–48）里库存为 0 的码** ⇒ 11 个码里 40/42 有货，
  //    其余 9 个（38/39/41/43/44/45/46/47/48）都算缺码。
  assert.equal(filteredView.missing_count, 9, 'A 段里库存为 0 的码都算缺码（配置先行）');
  assert.deepEqual(
    filteredView.rows.map((row) => row.size_text),
    ['38', '39', '40', '41', '42', '43', '44', '45', '46', '47', '48'],
  );
  assert.equal(filteredView.color, '黑色', '关联列的**显示文本**要读得出来（这是不用 search 接口的原因）');
  assert.equal(filteredView.category_name, '休闲鞋');
});

test('① 关联单元格为空（数据残缺）时：按条件读的「库存键」那条把它捞回来', async () => {
  const orphans = [{
    record_id: 'inv_orphan',
    fields: { 编号: [], 尺码: [{ record_ids: ['size_40'], text: '40' }], 所属状态: '门盒', 库存键: [{ text: `${NUMBER}|40` }] },
  }];
  const gateway = fakeGateway({ fixtures: { ...FIXTURES, liveInventory: orphans } });
  const view = await service(gateway).lookup({ number: NUMBER, requestId: 'req_orphan' });
  assert.equal(view.total, 1, '既有用例「关联为空时用库存键前缀认行」的行为一个字都不许变');
  // ⚠️ 行的清单现在按**配置段**补全（38–48），所以 40 那一行不一定是第一行。
  const row40 = view.rows.find((row) => row.size_text === '40');
  assert.ok(row40, '40 码那一行必须在（按库存键前缀认回来的）');
  assert.equal(row40.total, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 回退：拿不到 / 不认 / 关掉 / 值不安全 ⇒ 整表读，页面照旧对
// ═══════════════════════════════════════════════════════════════════════════

test('② 回退：飞书不认这个公式（抛错）→ 整表读，页面照旧对 + 记一条 warn', async () => {
  const gateway = fakeGateway({ filterError: 'FieldNameNotFound (Code: 1254045)' });
  const logs = captureLogs();
  let view;
  try {
    view = await service(gateway).lookup({ number: NUMBER, requestId: 'req_fb' });
  } finally {
    logs.restore();
  }
  assert.equal(view.found, true);
  assert.equal(view.total, 3);
  // ⭐ 2026-10-09：缺码按配置段算 ⇒ A 段 11 个码里有 9 个库存为 0。
  assert.equal(view.missing_count, 9);
  assert.equal(gateway.filterCalls().length, 2, '两次都试过了');
  const wholeTables = gateway.listAllCalls().map((call) => call.tableKey);
  assert.ok(wholeTables.includes('product') && wholeTables.includes('liveInventory'),
    '回退到整表读：货品信息与实时库存都要整表读一遍');
  assert.ok(wholeTables.filter((key) => key === 'sizeManagement').length >= 1,
    '「尺码管理」照旧会被行尺码解析读到（共享的 SizeReferenceService，带缓存）');
  assert.equal(logs.events(SCAN_PAGE.events.filterFallback).length, 2, '每次回退都记一条 warn');
  assert.match(logs.events(SCAN_PAGE.events.filterFallback)[0], /"reason":"failed"/);
});

test('② 回退：网关没有"按条件读"这个能力（旧注入实现 / 测试桩）→ 整表读', async () => {
  const gateway = fakeGateway({ filtered: false });
  const view = await service(gateway).lookup({ number: NUMBER, requestId: 'req_no_cap' });
  assert.equal(view.total, 3);
  assert.deepEqual(gateway.listAllCalls().map((call) => call.tableKey).sort(),
    ['liveInventory', 'product', 'sizeManagement', 'sizeManagement']);
});

test('② 开关（config 先行）：reads.filterEnabled=false → 一次"按条件读"都不发', async () => {
  const gateway = fakeGateway();
  const config = { ...SCAN_PAGE, reads: { ...SCAN_PAGE.reads, filterEnabled: false } };
  const view = await service(gateway, config).lookup({ number: NUMBER, requestId: 'req_off' });
  assert.equal(view.total, 3);
  assert.equal(gateway.filterCalls().length, 0);
  assert.ok(gateway.listAllCalls().some((call) => call.tableKey === 'liveInventory'));
});

test('② 值没法安全拼进公式（编号里带引号）→ **不拼**，直接整表读（宁可慢，不许拼坏公式）', async () => {
  const weirdNumber = 'A"B|黑色|A';
  const weird = {
    record_id: 'prod_weird',
    fields: { 编号: [{ text: weirdNumber }], 货号: 'A"B', 类别: 'A', 单价: '100' },
  };
  const gateway = fakeGateway({ fixtures: { ...FIXTURES, product: [weird], liveInventory: [] } });
  const view = await service(gateway).lookup({ number: weirdNumber, requestId: 'req_weird' });
  assert.equal(view.found, true, '带引号的编号照样能查到（只是走整表读）');
  assert.equal(gateway.filterCalls().length, 0, '一条公式都不许拼');
  assert.ok(gateway.listAllCalls().some((call) => call.tableKey === 'product'));
});

test('② 手打大小写不一致：按条件读 0 条 → 整表回退；库存仍按**表里的编号**筛，不显示 0 双', async () => {
  const gateway = fakeGateway();
  const view = await service(gateway).lookup({ number: 'yd6693-2|黑色|A', requestId: 'req_ci' });

  assert.equal(view.found, true, '大小写兜底还在（既有用例钉着它）');
  assert.equal(view.total, 3, '⚠️ 这里最容易出的错：filter 区分大小写，拿 URL 那串去筛库存会 0 条');
  assert.ok(gateway.listAllCalls().some((call) => call.tableKey === 'product'), '货品整表回退');
  assert.match(
    gateway.filterOf('liveInventory'),
    /"YD6693-2\|黑色\|A"/,
    '库存的 filter 用的是**表里那条货品的编号**（大写），不是 URL 那串小写',
  );
});

test('② 按条件读超上限 → **明确报错**（不显示一张不完整的库存表）', async () => {
  const many = Array.from({ length: SCAN_PAGE.limits.inventoryRowsPerNumber + 1 }, (_, index) =>
    inventoryRow(`inv_${index}`, 'prod_1', NUMBER, 'size_40', 40, '门盒'));
  const gateway = fakeGateway({ fixtures: { ...FIXTURES, liveInventory: many } });
  await assert.rejects(
    () => service(gateway).lookup({ number: NUMBER, requestId: 'req_cap' }),
    (error) => {
      assert.equal(error.scanLimitExceeded, true);
      assert.match(error.message, /可读上限/);
      return true;
    },
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ 缓存：命中不重复读 / TTL 过期重读 / 日志 / 不缓存"没找到"
// ═══════════════════════════════════════════════════════════════════════════

test('③ 缓存命中：同一个编号第二次**一次飞书请求都不发**，并且日志里有 cache_hit / cache_miss', async () => {
  const gateway = fakeGateway();
  const clock = 0;
  const scan = service(gateway, SCAN_PAGE, { now: () => clock });
  const logs = captureLogs();
  let first;
  let second;
  try {
    first = await scan.lookup({ number: NUMBER, requestId: 'req_c1' });
    const callsAfterFirst = gateway.calls.length;
    second = await scan.lookup({ number: NUMBER, requestId: 'req_c2' });
    assert.equal(gateway.calls.length, callsAfterFirst, '命中缓存后一次读都不许再发');
  } finally {
    logs.restore();
  }
  assert.deepEqual(second, first, '缓存命中的视图与首次**逐字一致**');
  assert.equal(logs.events(SCAN_PAGE.events.cacheMiss).length, 1);
  assert.match(logs.events(SCAN_PAGE.events.cacheMiss)[0], /"cache_hit":false/);
  assert.equal(logs.events(SCAN_PAGE.events.cacheHit).length, 1);
  assert.match(logs.events(SCAN_PAGE.events.cacheHit)[0], /"cache_hit":true/);
  // 走缓存也**不许**把"看了这一页"这个事实弄丢（她按 scan.page.viewed 排查）
  assert.equal(logs.events(SCAN_PAGE.events.viewed).length, 2);
});

test('③ TTL 过期后重读（TTL 进 config：默认 45s，可调）', async () => {
  const gateway = fakeGateway();
  let clock = 0;
  const scan = service(gateway, SCAN_PAGE, { now: () => clock });
  await scan.lookup({ number: NUMBER, requestId: 'req_t1' });
  const afterFirst = gateway.calls.length;

  clock += SCAN_PAGE.cache.ttlMs - 1;
  await scan.lookup({ number: NUMBER, requestId: 'req_t2' });
  assert.equal(gateway.calls.length, afterFirst, 'TTL 内还是命中');

  clock += 2;
  await scan.lookup({ number: NUMBER, requestId: 'req_t3' });
  assert.ok(gateway.calls.length > afterFirst, 'TTL 一过就重读（库存会变 ⇒ 缓存只能短）');
});

test('③ 缓存关掉（config.cache.enabled=false）→ 每次都读，行为回到"没有缓存"', async () => {
  const gateway = fakeGateway();
  const config = { ...SCAN_PAGE, cache: { ...SCAN_PAGE.cache, enabled: false } };
  const scan = service(gateway, config);
  await scan.lookup({ number: NUMBER, requestId: 'req_off1' });
  const afterFirst = gateway.calls.length;
  await scan.lookup({ number: NUMBER, requestId: 'req_off2' });
  assert.ok(gateway.calls.length > afterFirst);
});

test('③ 「没找到」不进缓存（新品刚建档就该立刻扫得到）', async () => {
  const gateway = fakeGateway();
  const scan = service(gateway);
  const unknown = await scan.lookup({ number: 'NOPE|黑色|A', requestId: 'req_u1' });
  assert.deepEqual(unknown, { found: false, number: 'NOPE|黑色|A', reason: 'unknown' });
  const callsAfterFirst = gateway.calls.length;
  await scan.lookup({ number: 'NOPE|黑色|A', requestId: 'req_u2' });
  assert.ok(gateway.calls.length > callsAfterFirst, '第二次仍然真的去读（不许把否定结果缓存住）');
});

test('③ ⭐ 缺码判定不再读「尺码管理」：一致性保险只在 TTL 到点那一趟比对一次', async () => {
  // ⭐ 2026-10-09：这一条的性质**整个变了**（业务负责人定的提速项之一）：
  //   提速前：缺码判定**每次扫码**都要整表读「尺码管理」；
  //   现在：缺码 = 配置段（`sizeSegments`）里库存为 0 的码 ⇒ 判定本身 **0 次读**；
  //         那张表只被**一致性保险**读（定期，默认 10 分钟；这里压到 1000ms 便于验证）。
  const gateway = fakeGateway();
  let clock = 0;
  const config = {
    ...SCAN_PAGE,
    // ⚠️ 视图缓存 TTL 压到 1ms：第三次扫码才会真的走到取数那一段
    //   （否则会命中视图缓存 —— 那条路**一次飞书都不打**，也就到不了保险那一步）。
    cache: { ...SCAN_PAGE.cache, ttlMs: 1 },
    sizeSegments: {
      ...SCAN_PAGE.sizeSegments,
      consistencyCheck: { enabled: true, ttlMs: 1000 },
    },
  };
  const scan = service(gateway, config, { now: () => clock });
  const sizeReads = () => gateway.listAllCalls().filter((call) => call.tableKey === 'sizeManagement').length;

  await scan.lookup({ number: NUMBER, requestId: 'req_s1' });
  const afterFirst = sizeReads();

  // 换一个编号（视图缓存不命中）：缺码判定读配置 ⇒ 不再读尺码表；TTL 内连保险也不读。
  await scan.lookup({ number: 'X7601|蓝|A', requestId: 'req_s2' });
  assert.equal(sizeReads(), afterFirst, '缺码判定读配置、保险在 TTL 内 ⇒ 不重复读尺码表');

  clock += 1001;
  await scan.lookup({ number: 'X7601|蓝|A', requestId: 'req_s3' });
  assert.ok(sizeReads() > afterFirst, 'TTL 一过，一致性保险会比对一次（这是唯一会读它的地方）');
});

test('③ 缓存有上限（不无界增长）：塞满以后仍然只留 maxEntries 条', async () => {
  const gateway = fakeGateway();
  const config = { ...SCAN_PAGE, cache: { ...SCAN_PAGE.cache, maxEntries: 2 } };
  const scan = service(gateway, config);
  await scan.lookup({ number: NUMBER, requestId: 'req_m1' });
  await scan.lookup({ number: 'X7601|蓝|A', requestId: 'req_m2' });
  assert.equal(scan.cache.size(), 2);
  await scan.lookup({ number: NUMBER, requestId: 'req_m3' });
  assert.ok(scan.cache.size() <= 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ 只读
// ═══════════════════════════════════════════════════════════════════════════

test('④ 只读：整条提速链路（按条件读 + 缓存）里一次写调用都没有', async () => {
  const gateway = fakeGateway();
  const scan = service(gateway);
  await scan.lookup({ number: NUMBER, requestId: 'req_r1' });
  await scan.lookup({ number: NUMBER, requestId: 'req_r2' });
  await scan.lookup({ number: 'NOPE|黑色|A', requestId: 'req_r3' });
  assert.deepEqual(gateway.writes, []);
});

test('④ 只读（源码扫描）：提速新增/改动的那几个文件里没有任何写调用', () => {
  const files = [
    path.join(SERVER_SRC, 'services', 'scanPageService.js'),
    path.join(SERVER_SRC, 'services', 'scanPageCache.js'),
    path.join(SERVER_SRC, 'config', 'scanPage.js'),
  ];
  const forbidden = [
    { pattern: /gateway\.(create|update|delete)\s*\(/, what: 'gateway 写调用' },
    { pattern: /appTableRecord\.(create|update|delete)/, what: '飞书写记录接口' },
    { pattern: /\.(applySale|applyPurchase|applyChange|applyReturn)\s*\(/, what: '库存写入口' },
    { pattern: /inventoryService|salesOrderService|purchaseWebhookService/, what: '写链路的服务' },
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { pattern, what } of forbidden) {
      assert.equal(pattern.test(source), false, `${path.basename(file)} 出现了${what}：${pattern}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 网关：`listByFilter` 自身的请求形状（`listAll` 一个字没改）
// ═══════════════════════════════════════════════════════════════════════════

const gatewayWithClient = (client, tableId = 'tbl_live') => new V1BitableGateway({
  schema: { appToken: 'app_test', tables: { liveInventory: { tableName: '实时库存', tableId, fields: {} } } },
  client,
});

test('⑤ listByFilter：GET 带 filter 公式、分页翻页、公式原样透传（网关不认识业务字段名）', async () => {
  const payloads = [];
  const pages = [
    { code: 0, data: { items: [{ record_id: 'rec_1', fields: {} }], has_more: true, page_token: 'pt_2' } },
    { code: 0, data: { items: [{ record_id: 'rec_2', fields: {} }], has_more: false } },
  ];
  const client = {
    bitable: {
      appTableRecord: {
        list: async (payload) => { payloads.push(payload); return pages.shift(); },
      },
    },
  };
  const filter = 'CurrentValue.[编号]="YD6693-2|黑色|A"';
  const records = await gatewayWithClient(client).listByFilter('liveInventory', filter);

  assert.deepEqual(records.map((record) => record.record_id), ['rec_1', 'rec_2']);
  assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0].path, { app_token: 'app_test', table_id: 'tbl_live' });
  assert.equal(payloads[0].params.filter, filter, 'filter 原样透传');
  assert.equal(payloads[0].params.page_size, 500);
  assert.equal(payloads[0].params.page_token, undefined, '第一次不带 page_token');
  assert.equal(payloads[1].params.page_token, 'pt_2', '第二次带上上一页回的分页标记');
});

test('⑤ listByFilter：maxRecords 读够就停（不白翻后面的页）', async () => {
  let calls = 0;
  const client = {
    bitable: {
      appTableRecord: {
        list: async () => {
          calls += 1;
          return { code: 0, data: { items: [{ record_id: 'a' }, { record_id: 'b' }, { record_id: 'c' }], has_more: true, page_token: 'next' } };
        },
      },
    },
  };
  const records = await gatewayWithClient(client).listByFilter('liveInventory', 'CurrentValue.[编号]="x"', { maxRecords: 2 });
  assert.equal(calls, 1, '已经读够 2 条（实际回来 3 条）⇒ 不再翻页');
  assert.equal(records.length, 3);
});

test('⑤ listByFilter：公式为空 → 等价于整表读（不炸、也不发一个没条件的请求）', async () => {
  const filters = [];
  const client = {
    bitable: {
      appTableRecord: {
        list: async (payload) => {
          filters.push(payload.params.filter);
          return { code: 0, data: { items: [{ record_id: 'rec_1' }], has_more: false } };
        },
      },
    },
  };
  const records = await gatewayWithClient(client).listByFilter('liveInventory', '   ');
  assert.equal(records.length, 1);
  assert.deepEqual(filters, [undefined]);
});

test('⑤ listByFilter：飞书明确拒绝 → 抛错带 bitableRejected（幂等判据那条路不变）', async () => {
  const client = {
    bitable: {
      appTableRecord: {
        list: async () => ({ code: 1254045, msg: 'FieldNameNotFound' }),
      },
    },
  };
  await assert.rejects(
    () => gatewayWithClient(client).listByFilter('liveInventory', 'CurrentValue.[编号]="x"'),
    (error) => {
      assert.match(error.message, /按条件读取“实时库存”记录失败/);
      assert.equal(error.bitableRejected, true);
      assert.equal(error.bitableCode, 1254045);
      return true;
    },
  );
});

test('⑤ listByFilter：表没配 table_id 时**当场抛错**（不许打到 .../tables//records 变成静默 404）', async () => {
  const client = { bitable: { appTableRecord: { list: async () => ({ code: 0, data: {} }) } } };
  await assert.rejects(
    () => gatewayWithClient(client, '').listByFilter('liveInventory', 'CurrentValue.[编号]="x"'),
    /未配置 table_id/,
  );
});

test('⑤ listAll 一个字没改：仍然 GET 列出记录、不带 filter（提速没动既有调用方）', async () => {
  const payloads = [];
  const client = {
    bitable: {
      appTableRecord: {
        list: async (payload) => {
          payloads.push(payload);
          return { code: 0, data: { items: [{ record_id: 'rec_1', fields: {} }], has_more: false } };
        },
      },
    },
  };
  const records = await gatewayWithClient(client).listAll('liveInventory');
  assert.equal(records.length, 1);
  assert.equal(payloads[0].params.page_size, 500);
  assert.equal(payloads[0].params.filter, undefined, 'listAll 不带任何 filter');
});
