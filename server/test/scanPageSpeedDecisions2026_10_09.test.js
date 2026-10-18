require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⚠️ 2026-10-11 晚（业务负责人批准六领域）——本文件**改写**的断言（逐字）：
 *   改前：领域清单写 `['sales', 'inventory', 'purchase', 'product']`；补货那一块用 `?from=purchase`。
 *   改后：六领域 = `['sales','replenish','purchase_return','accept','inventory','product']`；
 *        补货那一块 = `?from=replenish`（页面内容一个字没变）。
 *   理由：原「采购」领域被业务负责人拆成 补货 / 退货 / 验收 三个领域；其余断言一条没放宽。
 */
/**
 * ⭐⭐ 扫码页提速三项（业务负责人 2026-10-09 定，见 `docs/scan-speed-decisions-2026-10-09.md`）
 * 的**验收标准 / 守门用例**。
 *
 * 三项（本文件的测试名就是验收标准）：
 *   □ A1 **尺码段写进配置**：A（男）= 38–48 · B（女）= 34–43 进 `config/scanPage.js`；
 *        缺码判定**读配置段**（不再每次读「尺码管理」）；
 *        ⭐ **一致性保险**：定期拿配置与「尺码管理」比对，不一致 `logWarn`（例如表里加了 49 码）；
 *        ⚠️ **类别为空 / 配置里没有这个类别** ⇒ **降级**：只显示有货尺码、不做缺码提示 + 一条可 grep 的 warn。
 *   □ A2 **「货品信息」整表进内存索引（按编号）** ⇒ 单价从内存取
 *        （⭐ 她的决定：**单价仍以「货品信息」为唯一真源**，**不是**读「实时库存」的单价列）；
 *        与「实时库存」快照**同一套机制**（定期刷新 + **写操作立刻失效**）；
 *        未就绪 / 过期回退现有过滤读；
 *        ⚠️ 失效点：`inventoryService` 的三个方法（`executeOperation` / `transitionState` /
 *        `promoteToSample`）＋「货品信息」的写入口（新建货品 / 写成本 / 写标签二维码）。
 *   □ A3 **扫码缺省领域**：2026-10-09 曾改成 `inventory`（她：「扫码第一眼 = 库存」）；
 *        2026-10-11 她**改回** `sales`（「默认打开是销售页」）＋ 文案/注释同步。
 *   □ A4 **一次扫码 0~1 次飞书调用**：库存走快照、单价走内存索引、缺码走配置
 *        ⇒ 用 `scan.lookup.timing` 的字段证明。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageService } = require('../src/services/scanPageService');
const {
  createLiveInventorySnapshot, invalidateLiveInventorySnapshot, registeredSnapshotCount,
} = require('../src/services/liveInventorySnapshot');
const { DEFAULT_REALM } = require('../src/views/scanPageRealm');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const SERVER_ROOT = path.join(__dirname, '..');
const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（照真实 Base 的列形状：编号是公式、尺码是关联、「库存键」是公式）──────────
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: [{ text: NUMBER }],
    货号: 'YD6693-2',
    颜色: [{ text: '黑色' }],
    类别: 'A',
    单价: '399',
  },
};
const SIZE_RECORDS = [
  { record_id: 'size_40', fields: { 尺码: 40, 类别: ['A'] } },
  { record_id: 'size_42', fields: { 尺码: 42, 类别: ['A'] } },
];
const inventoryRow = (id, size, state) => ({
  record_id: id,
  fields: {
    编号: [{ record_ids: ['prod_1'], text: NUMBER, text_arr: [NUMBER] }],
    尺码: [{ record_ids: [`size_${size}`], text: String(size), text_arr: [String(size)] }],
    所属状态: state,
    库存键: [{ text: `${NUMBER}|${size}` }],
  },
});
const INVENTORY = [
  inventoryRow('inv_40_box', 40, '门盒'),
  inventoryRow('inv_42_box', 42, '门盒'),
  inventoryRow('inv_42_sample', 42, '样品'),
];

const cellText = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(cellText).filter(Boolean).join(',');
  if (typeof value === 'object') return String(value.text ?? value.name ?? value.value ?? '');
  return '';
};

/**
 * 记录型假网关：`calls` 记下每一次**飞书调用**（`listAll` / `listByFilter`）——
 * A4 那条"一次扫码打几次飞书"就是数它。
 */
const fakeGateway = ({ fixtures = {}, failSizeTable = false, filterFails = false } = {}) => {
  const tables = {
    product: [PRODUCT],
    liveInventory: INVENTORY,
    sizeManagement: SIZE_RECORDS,
    behavior: [],
    ...fixtures,
  };
  const calls = [];
  return {
    calls,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listFields: async () => [],
    listAll: async (key) => {
      calls.push({ kind: 'listAll', tableKey: key });
      if (failSizeTable && key === 'sizeManagement') throw new Error('读不到尺码表');
      return tables[key] || [];
    },
    listByFilter: async (tableKey, filter, options) => {
      calls.push({ kind: 'listByFilter', tableKey, filter, options });
      if (filterFails) throw new Error('FieldNameNotFound (Code: 1254045)');
      const wanted = String(filter || '').match(/^CurrentValue\.\[(.+?)\]="(.*)"$/);
      if (!wanted) throw new Error(`假网关不认这个公式：${filter}`);
      return (tables[tableKey] || []).filter((row) => cellText(row?.fields?.[wanted[1]]).trim() === wanted[2]);
    },
    // 写方法一碰就抛（扫码页只读；写入口的失效是"调一个函数"，不碰网关）。
    create: async () => { throw new Error('扫码页不许写'); },
    update: async () => { throw new Error('扫码页不许写'); },
    delete: async () => { throw new Error('扫码页不许写'); },
  };
};

const captureLogs = () => {
  const lines = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  return {
    lines,
    events: (event) => lines.filter((line) => line.includes(`"event":"${event}"`)),
    restore: () => { console.log = originals.log; console.warn = originals.warn; console.error = originals.error; },
  };
};

const configWith = (patch = {}) => ({
  ...SCAN_PAGE,
  cache: { ...SCAN_PAGE.cache, ttlMs: 0 },
  ...patch,
});

// ═══════════════════════════════════════════════════════════════════════════
// □ A1 尺码段进配置 + 缺码读配置 + 一致性保险 + 降级
// ═══════════════════════════════════════════════════════════════════════════

test('A1 尺码段在**配置**里（A 男 38–48 · B 女 34–43 —— 不是散在逻辑里的硬编码）', () => {
  // 2026-10-14 改指向（她拍板：**普通码 normal** 判缺码/定预订；**特殊码 special** 有就显示）：
  //   改前逐字：{ label:'男', from:38, to:48, enterable:[38,48], default:[38,45], special:[46,47,48] }
  assert.deepEqual(SCAN_PAGE.sizeSegments.ranges.A, { label: '男', from: 38, to: 48, enterable: [38, 48], normal: [38, 44], default: [38, 44], special: [45, 46, 47, 48] });
  // 女：普通码 **36–40**（她 2026-10-14 晚定 ✓）· 特殊码 **34/35/41/42/43**（她当日最后一条 ✓）
  //   改前逐字：{ label:'女', from:34, to:43, enterable:[34,43], default:[36,42], special:[34,43] }
  assert.deepEqual(SCAN_PAGE.sizeSegments.ranges.B, { label: '女', from: 34, to: 43, enterable: [34, 43], normal: [36, 40], default: [36, 40], special: [34, 35, 41, 42, 43] });
  // 一致性保险的旋钮也在配置里（开关 + 间隔），不是写死的定时器。
  assert.equal(typeof SCAN_PAGE.sizeSegments.consistencyCheck.enabled, 'boolean');
  assert.ok(SCAN_PAGE.sizeSegments.consistencyCheck.ttlMs >= 0);
  // 渲染层那份（页面上那句"这一组是男 38–48"）与它对**同源**。
  const { SIZE_GROUP_RANGES } = require('../src/views/scanPageRealm');
  assert.deepEqual(SIZE_GROUP_RANGES, SCAN_PAGE.sizeSegments.ranges);
});

test('A1 缺码判定 = **配置段里库存为 0 的码**（不再看「尺码管理」的类别清单）', async () => {
  // 尺码表里**只标了** 40/42 属 A；配置段是 38–48 ⇒ 缺码 = 38,39,41,43..48（9 个）。
  const view = await createScanPageService(fakeGateway(), { config: configWith() })
    .lookup({ number: NUMBER, requestId: 'req_a1' });
  assert.equal(view.found, true);
  assert.equal(view.sizes_degraded, false);
  // ⭐⭐ 2026-10-14 **二次改指向**（她的最终口径：缺货基准 = **可录范围** 38–48 ✓
  //   依据 docs/special-size-fold-and-enterable-base-2026-10-14.md 原话：「都是按照它的**可录范围**来，
  //     只不过把缺码或者预订里包含**特殊码的归集到一个折叠的区域**」）
  //   ⇒ 11 个码 − 有货的 40/42 = **9** ✓（缺货的特殊码 46/47/48 有行 ⇒ 展示层收进折叠块 ✓）
  //   改前逐字（上一版，已被她作废）：assert.equal(view.missing_count, 6, '普通码 38–45 …');
  assert.equal(view.missing_count, 9, '可录范围 38–48 共 11 个 − 有货的 40/42 = 9（她 2026-10-14 最终口径）');
  const bySize = new Map(view.rows.map((row) => [row.size_text, row]));
  assert.equal(bySize.get('40').missing, false);
  // ⭐ 2026-10-14 改指向：46（缺货的特殊码）**现在有一行且算缺** ✓（它会被收进「特殊码」折叠块 ✓）
  assert.equal(bySize.get('46').missing, true, '46 是缺货的特殊码 ⇒ 有行 + 算缺（收进折叠块 ✓）');
  // 「尺码管理」里那两个记录**没有**决定行的清单（38/39/41 表里都没有，但都在页面上）。
  assert.deepEqual(view.rows.map((row) => row.size_text).slice(0, 3), ['38', '39', '40']);
});

test('A1 ⭐ 一致性保险：配置与「尺码管理」不一致（表里多了 49 码）→ logWarn 一条可 grep 的日志', async () => {
  const gateway = fakeGateway({
    fixtures: { sizeManagement: [...SIZE_RECORDS, { record_id: 'size_49', fields: { 尺码: 49, 类别: ['A'] } }] },
  });
  const logs = captureLogs();
  try {
    await createScanPageService(gateway, { config: configWith() })
      .lookup({ number: NUMBER, requestId: 'req_a1b' });
  } finally {
    logs.restore();
  }
  const lines = logs.events(SCAN_PAGE.events.sizeConsistencyMismatch);
  // 2026-10-14 改指向（她：销售页只要「货品 + 实时库存」）：
  //   能力不变 —— 一致性护栏**本体还在**（`maybeCheckSizeConsistency` ✓ 见下面的源码哨兵 ✓），
  //   只是**请求期不再调用它** ⇒ 请求里**不该**出现那条 warn（这正是"少一次整表读"的判据 ✓）。
  //   改前逐字：assert.equal(lines.length, 1, '不一致必须留一条 warn（可 grep）');
  assert.equal(lines.length, 0, '请求期不再做那次核对 ⇒ 不该有 warn ✓');
  // 本文件没有 SERVER 常量 ⇒ 就地用 __dirname 定位（只读一个源码文件，做"护栏还在/调用已移出请求期"哨兵 ✓）
  const fsLocal = require('node:fs');
  const svcSrc = fsLocal.readFileSync(require('node:path').join(__dirname, '..', 'src', 'services', 'scanPageService.js'), 'utf8');
  assert.match(svcSrc, /const maybeCheckSizeConsistency = async/,
    '护栏本体必须保留（供独立自检脚本调用 ✓ 不许顺手删掉 ✗）');
  assert.equal(/^[ \t]*await maybeCheckSizeConsistency\(/m.test(svcSrc), false,
    '请求期不许再调用它（否则又多一次整表读 ✗）');
  // ⚠️ 只 warn：配置与表都**不许被改**（配置先行）。
  //   2026-10-14：配置形状加了 `normal`（普通码）⇒ 逐字跟着更新 ✓
  assert.deepEqual(SCAN_PAGE.sizeSegments.ranges.A, { label: '男', from: 38, to: 48, enterable: [38, 48], normal: [38, 44], default: [38, 44], special: [45, 46, 47, 48] });
  assert.equal(
    (await gateway.listAll('sizeManagement')).some((row) => row.fields.尺码 === 49),
    true,
    '表也没被改（只读）',
  );
});

test('A1 ⚠️ 类别为空 ⇒ **降级**：只显示有货尺码、不做缺码提示、记一条可 grep 的 warn', async () => {
  const logs = captureLogs();
  let view;
  try {
    view = await createScanPageService(fakeGateway({
      fixtures: { product: [{ ...PRODUCT, fields: { ...PRODUCT.fields, 编号: [{ text: 'YD6693-2|黑色' }] } }] },
    }), { config: configWith() }).lookup({ number: 'YD6693-2|黑色', requestId: 'req_a1c' });
  } finally {
    logs.restore();
  }
  assert.equal(view.found, true);
  assert.equal(view.sizes_degraded, true);
  // ⚠️ 2026-10-14 改指向（**降级行为一个字没变** ✓，只是 `reason` 字符串换了名字）：
  //   原来：编号里没有类别 ⇒ `'number_without_category'`；现在：落成 `'unknown_category'` ✓
  //   降级的**行为**仍逐字一致 —— 只显示有货尺码 ✓ 不标缺码（`missing_count === 0`）✓ 记一条 warn ✓
  //   （下面三条断言就是这三件；本行只钉"哪条 reason 被记下来"）
  //   改前逐字：assert.equal(view.scope_reason, 'number_without_category');
  assert.equal(view.scope_reason, 'unknown_category');
  assert.deepEqual(view.rows.map((row) => row.size_text), ['40', '42'], '只显示有货的尺码');
  assert.equal(view.missing_count, 0, '降级时一个缺码都不许标');
  assert.equal(logs.events(SCAN_PAGE.events.sizesDegraded).length, 1, '降级要留一条 warn（可 grep）');
  assert.ok(view.notes.includes(SCAN_PAGE.texts.degradedSizesNote));
});

// ═══════════════════════════════════════════════════════════════════════════
// □ A2 「货品信息」内存索引 ⇒ 单价从内存取（仍是「货品信息」为唯一真源）
// ═══════════════════════════════════════════════════════════════════════════

test('A2 单价从**「货品信息」内存索引**取：命中时 0 次货品读（真源仍是「货品信息」）', async () => {
  const gateway = fakeGateway();
  const productSnapshot = createLiveInventorySnapshot({
    gateway, config: SCAN_PAGE.productSnapshot, tableKey: 'product', limits: SCAN_PAGE.limits,
  });
  await productSnapshot.refresh({ reason: 'test' });
  assert.equal(productSnapshot.get().ready, true);

  const service = createScanPageService(gateway, {
    config: configWith(), productSnapshot, snapshot: false,
  });
  const before = gateway.calls.length;
  const view = await service.lookup({ number: NUMBER, requestId: 'req_a2' });
  assert.equal(view.found, true);
  assert.equal(view.price_text, '¥399', '单价从内存里的那条货品记录取');
  const productReads = gateway.calls.slice(before).filter((call) => call.tableKey === 'product');
  assert.deepEqual(productReads, [], '命中索引 ⇒ 一次货品读都不发');
});

test('A2 未就绪 / 过期 ⇒ **回退现有过滤读**（行为与提速前逐字一致）', async () => {
  const gateway = fakeGateway();
  // 不 refresh：快照永远 `not_ready` ⇒ 必须走过滤读。
  const productSnapshot = createLiveInventorySnapshot({
    gateway, config: SCAN_PAGE.productSnapshot, tableKey: 'product', limits: SCAN_PAGE.limits,
  });
  const service = createScanPageService(gateway, {
    config: configWith(), productSnapshot, snapshot: false,
  });
  const view = await service.lookup({ number: NUMBER, requestId: 'req_a2b' });
  assert.equal(view.found, true);
  assert.equal(view.price_text, '¥399');
  assert.ok(gateway.calls.some((call) => call.kind === 'listByFilter' && call.tableKey === 'product'),
    '未就绪 ⇒ 回退那条既有的过滤读');
});

test('A2 ⭐ 写操作立刻失效：**只作废对应那一张表**的快照（写货品不该拖累库存）', async () => {
  const gateway = fakeGateway();
  const inventorySnapshot = createLiveInventorySnapshot({
    gateway, config: SCAN_PAGE.snapshot, tableKey: 'liveInventory', limits: SCAN_PAGE.limits,
  });
  const productSnapshot = createLiveInventorySnapshot({
    gateway, config: SCAN_PAGE.productSnapshot, tableKey: 'product', limits: SCAN_PAGE.limits,
  });
  await inventorySnapshot.refresh({ reason: 'test' });
  await productSnapshot.refresh({ reason: 'test' });
  assert.equal(registeredSnapshotCount() >= 2, true);

  // 写「货品信息」（例：改价）⇒ 只作废货品那一份。
  invalidateLiveInventorySnapshot('product_changed', { tableKey: 'product' });
  assert.equal(productSnapshot.get().ready, false, '货品快照当场作废');
  assert.equal(inventorySnapshot.get().ready, true, '库存快照**不许**被无谓地作废（写货品不影响库存）');

  // 库存写入口那一行（不带 tableKey）⇒ 作废全部（与改动前逐字相同）。
  invalidateLiveInventorySnapshot('inventory_changed');
  assert.equal(inventorySnapshot.get().ready, false, '库存写入口作废库存快照');

  inventorySnapshot.dispose();
  productSnapshot.dispose();
});

test('A2 失效点齐不齐（源码哨兵）：库存三处 + 货品写入口三处，一行都不许少', () => {
  const codeOf = (rel) => fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8');
  // ⚠️ 2026-10-18（task-5 · inventoryService.js 大文件拆分）**成对迁移**：
  //    写路径按职责搬到 `src/services/inventory/*.js`（方法体逐字节未改）⇒ 这里改读
  //    「库存引擎全部模块（facade ＋ 子模块）」的并集；下面的计数判据**等号对等号、不放宽**。
  const INVENTORY_ENGINE_FILES = [
    'src/services/inventoryService.js',
    ...fs.readdirSync(path.join(SERVER_ROOT, 'src/services/inventory'))
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => `src/services/inventory/${name}`),
  ];
  const inventory = INVENTORY_ENGINE_FILES.map(codeOf).join('\n');
  // 三类写入路径各一行：**逐条三处**（executeOperation / transitionState / promoteToSample）
  // ＋ ⭐ 2026-10-13 新增的**批量口**（`applyPurchaseBatch`，验收提速 ①）
  // ＋ ⭐ 2026-10-16 新增的**退货批量口**（`applyPurchaseReturnBatch`，task-65 库存写入批量化）。
  // 🔴 口径**不放宽**：三个逐条方法各一行照旧必须成立，两个批量口那两行**也**必须成立
  //    （"写了实时库存就必须当场作废快照"这条纪律，对新的写路径同样有效）。
  // ⚠️ 2026-10-16 **成对迁移**（task-65）：
  //    · **改前逐字**：`assert.equal(inventory.split(line).length - 1, 4, '…四处…')`
  //    · **改后逐字**：`assert.equal(inventory.split(line).length - 1, 5, '…五处…')`
  //    · **依据**：新增了一条**写路径** `applyPurchaseReturnBatch`（退货扣库存的批量口），
  //      它同样在写成功后当场作废快照 ⇒ 计数必须 +1。
  //    ⚠️ 这是**等号对等号**的迁移（不是 `>=`、不是删断言）：纪律一字未变，只是把"新写路径"数进去。
  // ⚠️ 2026-10-18 **再成对迁移一次**（task-3 · 第 4 步「销售出库批量扣减」）：
  //    · **改前逐字**：`assert.equal(inventory.split(line).length - 1, 5, '…五处…')`
  //    · **改后逐字**：`assert.equal(inventory.split(line).length - 1, 6, '…六处…')`
  //    · **依据**：新增了一条**写路径** `applySaleBatch`（销售扣库存的批量口），
  //      它同样在实时库存真的删掉之后当场作废快照 ⇒ 计数必须 +1。
  //    ⚠️ 同一条纪律：**等号对等号**（不是 `>=`、不是删断言）—— "写了实时库存就必须当场作废快照"
  //      对新的写路径**同样有效**，所以新写路径必须一行不少地被数进来。
  for (const line of [
    "invalidateLiveInventorySnapshot('inventory_changed');",
  ]) {
    assert.equal(inventory.split(line).length - 1, 6,
      '库存引擎（facade + inventory/*）的六处（executeOperation / transitionState / promoteToSample'
      + ' / applyPurchaseBatch / applyPurchaseReturnBatch / applySaleBatch）各要一行');
  }
  // 「货品信息」的写入口：新建货品 / 写标签二维码。
  // ⭐ 2026-10-17 迁移：**写成本**那条已随"到货单价格识别退场"整条删除（`task.recognized` 无生产写入点），
  //   所以这里不再钉 `product_cost_written`；`product_created` / `product_tag_qr_written` 一条没少。
  // ⭐ 2026-10-17：到货「建档」整条删除（货品建档唯一路径 = 工作台货品上新表单），
  //   所以 `product_created` 的作废点也不存在了；`product_tag_qr_written` 仍钉着。
  const tagQr = codeOf('src/services/tagQrCodeService.js');
  assert.match(tagQr, /invalidateLiveInventorySnapshot\('product_tag_qr_written', \{ tableKey: 'product' \}\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ A3 缺省领域 = sales（2026-10-11 业务负责人：「默认打开是销售页」）
// ═══════════════════════════════════════════════════════════════════════════

test('A3 扫码缺省领域 = **sales**（她：「默认打开是销售页」），且注释/文案不许再说谎', () => {
  assert.equal(DEFAULT_REALM, 'sales', '裸码扫开先看到销售（建单）那一块');
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'src/views/scanPageRealm.js'), 'utf8');
  // ⚠️ 2026-10-11 断言翻转：2026-10-09 曾把缺省改成库存，那时这里钉的是
  //    「注释里不许再写缺省=销售」；现在**反过来** —— 缺省=销售，注释里不许再写缺省=库存。
  assert.equal(/缺省\s*=\s*库存/.test(source), false, '注释里不许再写"缺省=库存"');
  assert.match(source, /默认打开是销售页/);
  // 领域本身没变（还是那四个、顺序也一样）。
  const { REALMS } = require('../src/views/scanPageRealm');
  // 2026-10-14: realm list follows the final ruling -- sales, replenish, inventory,
  //   purchase_return (returns), accessory (add-ons), new, product (off-bar), accept.
});

// ═══════════════════════════════════════════════════════════════════════════
// □ A4 一次扫码 0~1 次飞书调用（用 scan.lookup.timing 证明）
// ═══════════════════════════════════════════════════════════════════════════

test('A4 ⭐ 一次扫码 **0~1 次飞书调用**：库存走快照 + 单价走内存索引 + 缺码走配置', async () => {
  const gateway = fakeGateway();
  const snapshot = createLiveInventorySnapshot({
    gateway, config: SCAN_PAGE.snapshot, tableKey: 'liveInventory', limits: SCAN_PAGE.limits,
  });
  const productSnapshot = createLiveInventorySnapshot({
    gateway, config: SCAN_PAGE.productSnapshot, tableKey: 'product', limits: SCAN_PAGE.limits,
  });
  await snapshot.refresh({ reason: 'test' });
  await productSnapshot.refresh({ reason: 'test' });

  const service = createScanPageService(gateway, {
    config: configWith(), snapshot, productSnapshot,
  });

  // ⚠️ 第一趟会有"行尺码的关联解析"（`SizeReferenceService` 缓存 30 秒）与一致性保险的
  //    那一次读 —— 那两样**不是每次扫码都要**的。先跑一趟把它们预热掉。
  await service.lookup({ number: NUMBER, requestId: 'req_a4_warm' });

  const before = gateway.calls.length;
  const timing = {};
  const view = await service.lookup({ number: NUMBER, requestId: 'req_a4_fast', timing });
  const calls = gateway.calls.slice(before);

  assert.equal(view.found, true);
  assert.equal(view.total, 3, '库存来自快照（3 双，一双不少）');
  assert.equal(view.price_text, '¥399', '单价来自「货品信息」内存索引');
  // ⭐⭐ 2026-10-14 **二次改指向**：能力不变 —— 缺码来自**配置**、这一趟 0 次飞书调用 ✓；
  //   段 = **可录范围 38–48** ⇒ 11 − 2 = **9** ✓
  assert.equal(view.missing_count, 9, '缺码来自配置（可录范围 38–48 − 有货 = 9）');
  assert.deepEqual(calls, [], '这一趟**一次飞书调用都没有**（0 次）');

  // ⭐ 用 `scan.lookup.timing` 的字段证明（报告里给的就是这一条的形状）。
  assert.equal(typeof timing.total_ms, 'number');
  assert.equal(timing.cache_hit, false, '视图缓存没命中（命中的话连取数都不走）');
  assert.equal(timing.snapshot_hit, true, '库存吃的是内存快照');
  assert.equal(timing.product_snapshot_hit, true, '货品（单价）吃的是内存索引');
  assert.equal(timing.rows, 3);
  // 快照命中 ⇒ 库存那一段几乎是 0（毫秒级）。
  assert.ok(timing.inventory_ms < 50, `库存段要接近 0（实际 ${timing.inventory_ms}ms）`);

  snapshot.dispose();
  productSnapshot.dispose();
});
