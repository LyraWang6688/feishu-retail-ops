/**
 * ⭐⭐ 2026-10-15（业务负责人口径）：**批量打印支持「货品信息 ∪ 实时库存」** ＋ 只读端点
 * `listLabels`（数据源：「货品信息」∪「实时库存」）。
 *
 * 她的原话（逐字，**这是本文件所有 AC 的依据**）：
 *   ①「编号对呀，我们的编号**只要它在货品信息里就行了**，不一定非要在库存里面有啊」
 *   ② 批量打印的用途 =「**一次给一批新货打码**（新店开业 / 换季上架）」——新货常常**还没有入库**
 *   ③ 新品那张标签上「尺码 + 库存数量」那一行：**不印**（她选 ①，逐字确认）
 *   ④「货品信息」表字段：编号 / 货号 / 颜色 / 单价 / 成本 / 货品状态 / 供应商 / 类别 /
 *      缺失信息说明 / 样例图 / 标签二维码 —— **没有尺码、没有库存数量**
 *
 * ── 验收标准（**先写（这一节）后做**，逐条对照）──────────────────────────────
 * · **AC-N1** 无库存但在「货品信息」里的编号 ⇒ **出现在 `listLabels` 结果里**（`sizes: []`、
 *   `has_stock: false`、`record_ids: []`），并有 `price` / `brand_text` / 记录 ID 版二维码
 *   （`scan_url` = `/r/{recordId}`）；`total_pairs` 只数库存双数。
 * · **AC-N2** **有库存的编号行为逐字不变**：尺码 / 数量 / 排序 / 截断 / `record_ids` / 二维码
 *   一个字都不改（老用例 `labelPrintService.test.js` **一条都没改、全绿**；这里再加一条
 *   混合数据集上的对照 —— 两侧的标签各是各的）。
 * · **AC-N3** `size` / `state` 筛选时，**没有库存的那批被排除且计数**：
 *   响应 `without_stock_skipped` ＋ 日志事件 `workbench.labels.without_stock_skipped`（**真红**：
 *   删掉那条 warn 或那个计数，这两条断言当场红）；`keyword` / `category` 两侧**都参与**。
 * · **AC-N4** `recentDays` 对没有库存的那批按「货品信息」的**创建时间列**筛 ——
 *   ⚠️ 那一列在真表里**不叫「创建时间」**（只读核过：名字是「上架日期」、`type:1001 = CreatedTime`）
 *   ⇒ 口径在 `config/labelPrint.js` 的 `PRODUCT_CREATED_TIME`（名字 + 类型两条）：名字在记录里就用名字
 *   （零额外请求）；记录里没有这一列 ⇒ 按 `fieldType`（1001）去字段表里认 ＋ **如实 warn**。
 *   **能真红**：把这条筛掉就是红。
 *   （`truncated:true`）/ `hasStock` 正确 / 响应**不含任何密钥** / 挂在**既有**
 *   `requireWorkbenchAccess` 之后（行为 503/401 ＋ 源码哨兵）。
 * · **AC-N6** **只读**：`listLabels` **没有任何创建 / 更新 / 删除调用**
 *   （假网关 `create/update/delete` 直接抛错 ＋ 源码哨兵）。
 * · **AC-N7**（**如实记录的副作用**，不是她新提的口径）`labelForRecord`（扫码打印）复用的是
 *   `listLabels` ⇒ 一个「在货品信息里、但库存里没有」的编号**现在也能打出一张**（`sizes: []`），
 *   不再回「没有可打印的标签」。这是数据源改成并集的**必然结果**，本文件把它**钉出来**
 *   （要退回旧行为 = 显式改这里，不是"悄悄变了"）。
 *
 * ── task-10（2026-10-15）追加的两条 AC ────────────────────────────────────────
 * · **AC-N8（性能：短 TTL 缓存）** 端点的那两次全表读**在 TTL 内只读一次**（Lead 线上实测
 *   单次 ≈ 11.4 秒 ⇒ 必须缓存）：TTL 内第二次调用 **0 次飞书读**（假网关计数能真红）；`cacheTtlMs = 0`
 *   ⇒ **每次真读**（能真红）；TTL 过期 ⇒ 重读（能真红）；命中 / 未命中都有**日志**（能真红）；
 *   ⚠️ **只影响这个端点**：`listLabels` 两次调用仍然是 2 次真读（**不许被缓存**）。
 * · **AC-N9（配置先行）** `cacheTtlMs` / `limitDefault` / `limitMax` / 创建时间列（名字 + 类型）
 *   **全在 `config/labelPrint.js`**：换一份注入的 config ⇒ 行为跟着变（能真红），**不用改代码**。
 *
 * ⚠️ 本文件**不放宽也不删除任何既有断言**：`test/labelPrintService.test.js` 的 42 条**原文未动**、
 *    全绿。task-10 只动了本文件里**两条 AC-N4 用例的「注入哪一组 config」**（配置项从
 *    `fieldNamesPendingSchema.productCreatedTime` 那个"散读"口径，搬成 config 的**正规一项**
 *    `productCreatedTime`）—— 两条都逐字写了「改前 / 改后 / 依据」，**断言本身一条没改**。
 *
 * ── task-11（2026-10-15）追加：`listLabels` 也加短 TTL 缓存 ───────────────────
 * 依据：她真机逐字「我扫完之后…等了一会儿才出现扫描框…整个链路我觉得不太友好」＋ Lead 线上只读实测
 *     `listAll('liveInventory')` 1362 行 5924ms ＋ `listAll('product')` 561 行 5478ms
 *     ⇒ **她每打开一次「批量打印 / 选择编号打印」那一页都要等 ≈ 11 秒**（`GET /labels` 进页自动查一次）。
 * · **AC-N10** `listLabels` 走**同一套**短 TTL 缓存（`createShortTtlCache` —— 与端点是**同一份实现**，
 *   不抄第二份）：TTL 内第二次调用 **0 次飞书读**，且 `workbench.labels.cache_hit` / `.cache_miss`
 *   各如实记一条；两个缓存**互不干扰**。
 * · **AC-N11** `config.labelList.cacheTtlMs = 0` ⇒ **每次真读**（`reason:'disabled'`）。
 * · **AC-N12** TTL 过期 ⇒ **重读**（`reason:'expired'`）。
 * · **AC-N13** ⭐⭐ **缓存的是原始行，不是筛选结果**：同一个 TTL 里不同 `keyword` / `size`
 *   各自正确（连筛选结果一起缓存会串数据 ✗）；**「最近新增」的时间判断每请求现算**
 *   （同一份缓存、同一个 `recentDays`，时间往前走 ⇒ 结果跟着变，且这一轮没有重读飞书）。
 * · **AC-N14** 这一档口径住在 `config/labelPrint.js#LABEL_LIST`（默认 60000；换值不用改代码）。
 *
 * ── task-15（2026-10-15）追加：编号选择器改「**服务端模糊查询**」 ──────────────
 * 依据（她逐字）：「**是否可以让用户进行类似于模糊查询的操作？就是用户输入一个编号，
 * 然后系统再给出与这个模糊编号相关的选项**」⇒ Lead 判：可以，而且这是正解 ✓。
 * 原来：整张「货品信息」（554 个编号 / 冷启动 ≈13.9 秒）读回来再内存过滤 ✗。
 * 现在：**飞书只回匹配的那几条**（`GET /records` 的 `filter`）＋ **空关键字一次都不读**。
 * · **AC-F1** 有 keyword ⇒ **只走按条件读**：`listAll`（整表读）**一次都没调**；
 *   公式 = `OR(编号.contains(k), 货号.contains(k))` —— **不拼「颜色」**（关联列 type 18 拼 filter
 *   会 `InvalidFilter 1254018`，仓库里已有硬事实）；库存那次按「库存键」contains 同一个关键字。
 * · **AC-F1b** 缓存**按关键字分槽**（`maxCacheEntries`）：A 关键字的结果不会被 B 关键字命中（能真红）。
 * · **AC-F2** `keyword` 为空 ⇒ **一次飞书都不读** + 空列表（前端 2026-10-16 起**不再**写那句提示语）。
 * · **AC-F3** `hasStock` 三种取值都对：`true` / `false`（过滤读没查到 **且** 编号含关键字 ⇒ 结论可靠）
 *   / **`null` 未确认**（三种情形：库存那次读失败 · 撞 `stockScanMax` 扫描上限 · 编号本身不含关键字）
 *   —— **绝不许猜** ✗。
 * · **AC-F4** 开关 / 上限 / 扫描上限**都来自配置**：`serverFilter:false` 或网关没有 `listByFilter`
 *   ⇒ 回退"整表读 + 内存过滤"老路（**退路，不是死代码**）并如实 warn；关键字带引号等拼不进公式的字符 ⇒ 400。
 * · **AC-F6**（**冷启动实测**，写进 PR）测试 Base 只读实测（`cacheTtlMs:0`，每次都真读）：
 *   `6681` / `XHB8095` / `T202` ⇒ **1.7–2.1 秒**（目标 < 3 秒 ✓）；很宽的关键字 `黑`（252 条）⇒ 3.5 秒；
 *   同一个关键字第二次 ⇒ **0 秒**（缓存命中）；空关键字 ⇒ **0 秒、0 次飞书读**。
 *
 * ⚠️ task-15 **改了几条既有端点用例的"触发方式 / 观测量"**（每条都逐字写了改前 → 改后 → 依据，
 *    业务判据本身一条没放宽）：
 *   ① 空关键字不再表示"回全表前 200 条" ⇒ 原来用它测的东西改成**带关键字**（AC-N5 / AC-N8 / AC-N9）；
 *   ② `gateway.calls`（整表读）与 `filterCalls`（按条件读）**分开记**，才说得清"读没读全表"。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  createLabelPrintService, partsOfNumber, compoundNumber, createdAtOf,
} = require('../src/services/labelPrintService');
// 假网关模拟飞书 `contains`（大小写不敏感）时，要按**真表一样的取值方式**读单元格（公式 / 关联列的形状）。
const { textValue } = require('../src/services/v1BitableGateway');

const F = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
const P = V1_BITABLE_SCHEMA.tables.product.fields;
const SOURCE_DIR = path.join(__dirname, '../src');

/** 「货品信息」的创建时间列在**真表**里的名字（只读核过：`type:1001 = CreatedTime`）。 */
const PRODUCT_CREATED_FIELD = '上架日期';

/** 一份只覆盖指定几组的 config（其余沿用 `config/labelPrint.js` 的默认值）。 */
const configWith = (patch = {}) => {
  const merged = { ...LABEL_PRINT };
  for (const [group, value] of Object.entries(patch)) merged[group] = { ...LABEL_PRINT[group], ...value };
  return merged;
};

/** 一条「实时库存」记录（一双一条）。 */
const stockRecord = (id, { stockKey, state = '门盒', category, createdAt } = {}) => ({
  record_id: id,
  fields: {
    [F.stockKey]: stockKey,
    [F.state]: state,
    ...(category === undefined ? {} : { [F.category]: category }),
    ...(createdAt === undefined ? {} : { 创建时间: createdAt }),
  },
});

/** 一条「货品信息」记录（编号 / 货号 / 颜色 / 类别 / 单价 / 创建时间列）。 */
const productRecord = (id, {
  number, price, itemNo, color, category, createdAt, createdField = PRODUCT_CREATED_FIELD,
} = {}) => ({
  record_id: id,
  fields: {
    [P.number]: number,
    ...(price === undefined ? {} : { [P.price]: price }),
    ...(itemNo === undefined ? {} : { [P.itemNo]: itemNo }),
    ...(color === undefined ? {} : { [P.color]: color }),
    ...(category === undefined ? {} : { [P.category]: category }),
    ...(createdAt === undefined ? {} : { [createdField]: createdAt }),
  },
});

/**
 * 只实现只读方法的假网关 —— `create/update/delete` **直接抛错**（AC-N6 的运行时哨兵）。
 *
 * ⭐ task-15：多了 `listByFilter`（**按条件读**）。两个数组分开记，判据才说得清：
 *   · `calls`       = `listAll`（**整表读**）—— 服务端模糊查询生效时它应当是**空的** ✓（AC-F1）；
 *   · `filterCalls` = `listByFilter`（**按条件读**）—— 每次带回它收到的 `filter` 公式原文。
 * ⚠️ 假网关**按真表的实测语义**模拟 `contains`：**大小写不敏感**、只认「编号 / 货号」（货品）
 *    与「库存键」（库存）—— 与 `productNumbersFilterOf` 拼出来的那两列一致。
 * `stockReadThrows: true` 用来演"库存那次读失败"（AC-F3 的 `hasStock: null`）。
 */
const fakeGateway = ({
  liveInventory = [], product = [], fieldLists = {}, stockReadThrows = false,
} = {}) => {
  const calls = [];
  const filterCalls = [];
  const keywordOf = (filter) => {
    const matched = /contains\("([^"]*)"\)/.exec(String(filter));
    return matched ? matched[1].toLowerCase() : null;
  };
  return {
    calls,
    filterCalls,
    async listAll(tableKey) {
      calls.push(tableKey);
      if (tableKey === 'liveInventory') return liveInventory;
      if (tableKey === 'product') return product;
      throw new Error(`这条链路只读这两张表，不该读：${tableKey}`);
    },
    async listByFilter(tableKey, filter, options = {}) {
      filterCalls.push({ tableKey, filter, maxRecords: options.maxRecords });
      if (tableKey === 'liveInventory' && stockReadThrows) throw new Error('stock read failed (injected)');
      const source = tableKey === 'liveInventory' ? liveInventory : product;
      const keyword = keywordOf(filter);
      const rows = keyword === null ? source : source.filter((record) => {
        const values = tableKey === 'liveInventory'
          ? [textValue(record?.fields?.[F.stockKey])]
          : [textValue(record?.fields?.[P.number]), textValue(record?.fields?.[P.itemNo])];
        return values.some((value) => String(value ?? '').toLowerCase().includes(keyword));
      });
      return options.maxRecords ? rows.slice(0, options.maxRecords) : rows;
    },
    async listFields(tableKey) {
      calls.push(`listFields:${tableKey}`);
      return fieldLists[tableKey] || [];
    },
    create() { throw new Error('只读功能：不许 create'); },
    update() { throw new Error('只读功能：不许 update'); },
    delete() { throw new Error('只读功能：不许 delete'); },
  };
};

const serviceFor = (tables = {}, patch) => {
  const gateway = fakeGateway(tables);
  return {
    gateway,
    service: createLabelPrintService(gateway, patch ? { config: configWith(patch) } : {}),
  };
};

const sourceOf = (relative) => fs.readFileSync(path.join(SOURCE_DIR, relative), 'utf8');

/** 可控时钟（缓存 TTL 用例用）＋ 一份最小的「库存 1 双 + 货品 1 条」数据。 */
const fakeClock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
};
const labelListFixture = () => ({
  liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
  product: [productRecord('rec1', { number: 'XHB8095|棕色|A', price: 198 })],
});

/** 结构化日志的出口就是 console.log/warn/error（`src/utils/logger.js`）—— 捕获它们才能断言"记了"。 */
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
// AC-N1 / AC-N2 「货品信息 ∪ 实时库存」（按编号去重）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N1 无库存但在「货品信息」里的编号 ⇒ 也出一张标签（sizes: []、has_stock: false、记录 ID 版二维码）', async () => {
  const { service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [
      productRecord('rec_brown', { number: 'XHB8095|棕色|A', price: 198 }),
      // ⭐ 新货：**还没有入库**（「实时库存」里一行都没有），只在「货品信息」里。
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399, itemNo: 'NEW2026', color: '黑色', category: 'A' }),
    ],
  });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 2, '两个编号各一张标签（其中一个是没入库的新货）');
  assert.equal(data.total_with_stock, 1);
  assert.equal(data.total_without_stock, 1);
  const fresh = data.labels.find((label) => label.number === 'NEW2026|黑色|A');
  assert.ok(fresh, '⭐ 没入库的新货必须在结果里（她的口径：编号只要在货品信息里就行）');
  assert.deepEqual(fresh.sizes, [], '⭐ 尺码 = **空数组** ⇒ 页面据此不印「尺码 + 库存数量」那一行');
  assert.deepEqual(fresh.size_lines, [], '没有尺码就没有行');
  assert.equal(fresh.total_qty, 0);
  assert.equal(fresh.has_stock, false, '⭐ 明确如实：这个编号在「实时库存」里没有行');
  assert.deepEqual(fresh.record_ids, [], '没有库存行 ⇒ 没有可聚合的库存记录');
  assert.equal(fresh.record_count, 0);
  assert.equal(fresh.item_no, 'NEW2026', '货号来自「货品信息」（她表里有这一列）');
  assert.equal(fresh.color, '黑色');
  assert.equal(fresh.price, 399, '单价来自「货品信息.单价」');
  assert.equal(fresh.price_text, '¥399');
  assert.equal(fresh.brand_text, '邯美皮鞋');
  assert.equal(fresh.scan_url, 'https://hm.bamamei.online/r/rec_new', '二维码仍装**接口读到的**记录 ID');
  assert.equal(fresh.category_code, 'A', '类别来自编号第三段 / 「货品信息.类别」');
  // 有库存的那一张：**一字未变**（AC-N2）。
  const stocked = data.labels.find((label) => label.number === 'XHB8095|棕色|A');
  assert.deepEqual(stocked.sizes, [{ size: 36, qty: 1 }]);
  assert.equal(stocked.has_stock, true);
  assert.deepEqual(stocked.record_ids, ['st1']);
  assert.equal(stocked.scan_url, 'https://hm.bamamei.online/r/rec_brown');
  assert.equal(data.total_pairs, 1, 'total_pairs 只数库存双数（新货 0 双）');
  assert.equal(data.missing_qr_record_id, 0, '两侧都拿到了记录 ID ⇒ 没有降级');
});

test('AC-N2 混合数据集：有库存的编号与没入库的编号各排各的（货架顺序把两侧排在一起）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      stockRecord('st_b', { stockKey: 'B100|黑色|A|41' }),
      stockRecord('st_a', { stockKey: 'A100|黑色|A|40', state: '仓库' }),
    ],
    product: [
      productRecord('rec_b', { number: 'B100|黑色|A', price: 100 }),
      productRecord('rec_a', { number: 'A100|黑色|A', price: 200 }),
      productRecord('rec_new', { number: 'A050|白色|A', price: 300, itemNo: 'A050', color: '白色' }),
    ],
  });
  const data = await service.listLabels({});
  assert.deepEqual(data.labels.map((label) => label.number),
    ['A050|白色|A', 'A100|黑色|A', 'B100|黑色|A'], '货架顺序仍按 货号 → 颜色 → 类别（两侧一起排）');
  assert.equal(data.labels[0].has_stock, false, 'A050 没入库');
  assert.equal(data.labels[1].has_stock, true);
  assert.deepEqual(data.labels[1].sizes, [{ size: 40, qty: 1 }], '有库存的照旧（含所属状态那条库存）');
  assert.deepEqual(data.labels[1].states, ['仓库']);
  assert.equal(data.labels[1].state_text, '仓库');
});

test('AC-N2 截断仍然如实：两侧合起来超过上限 ⇒ truncated + total_matched（没入库的也算在总数里）', async () => {
  const liveInventory = [1, 2, 3].map((n) => stockRecord(`s${n}`, { stockKey: `S${n}|黑色|A|41` }));
  const product = [1, 2, 3].map((n) => productRecord(`p${n}`, { number: `S${n}|黑色|A`, price: 10 }));
  product.push(productRecord('p_n1', { number: 'NEW1|黑色|A', price: 10 }));
  product.push(productRecord('p_n2', { number: 'NEW2|黑色|A', price: 10 }));
  const { service } = serviceFor({ liveInventory, product }, { limits: { maxLabels: 3 } });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 5, '3 个有库存 + 2 个没入库 = 5 张');
  assert.equal(data.total_returned, 3);
  assert.equal(data.truncated, true);
  assert.equal(data.total_pairs, 3, '被截断的也是有库存的 3 双');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N3 size / state 不参与 ⇒ 排除并计数（不静默）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N6 只读：`listLabels` 一次 create/update/delete 都不调', async () => {
  const { gateway, service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 })],
  });
  // 假网关的 create/update/delete 直接抛错 ⇒ 只要被调到，这条用例当场红。
  await service.listLabels({});
  assert.deepEqual(gateway.calls, ['liveInventory', 'product'], '整条链路只读这两张表（各一次整表读）');
  assert.deepEqual(gateway.filterCalls, [], '没有按条件读（那套只服务已删除的编号选择器）');
  const code = sourceOf('services/labelPrintService.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['.create(', '.update(', '.delete(', 'applyChange', 'transitionState']) {
    assert.ok(!code.includes(forbidden), `只读功能里不许出现 ${forbidden}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-F1…AC-F4（task-15）：编号选择器改「**服务端模糊查询**」
//   她的原话：「**是否可以让用户进行类似于模糊查询的操作？就是用户输入一个编号，
//   然后系统再给出与这个模糊编号相关的选项**」⇒ 让飞书**只回匹配的那几条**（不再读全表 ✗）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N10 ⭐ `listLabels` 也走**同一套**短 TTL 缓存：TTL 内第二次 **0 次飞书读** ＋ 命中日志', async () => {
  // ⚠️ task-11 **改写**（这条原来是 task-10 的"缓存**只影响**这个端点、listLabels 两次仍 4 次真读"）：
  //   改前逐字：`assert.deepEqual(gateway.calls, ['liveInventory','product','liveInventory','product'],
  //               '⚠️ 批量/编号打印那一页这次**不动** —— 它照旧每次真读（它那 11 秒另开任务）');`
  //               ＋ `assert.equal(logs.events('workbench.products.numbers.cache_miss').length, 0, 'listLabels 根本不碰这个缓存');`
  //   改后逐字：`assert.deepEqual(gateway.calls, ['liveInventory','product'],
  //               '⭐⭐ 第二次**一次飞书都没读**（她每开一次那页少等 ≈ 11 秒）');`
  //               ＋ 断言 `workbench.labels.cache_hit` / `.cache_miss` 各一条（**加强**：现在还看它有没有记日志）。
  //   依据：**task-11 的口径直接要求**给 `listLabels` 加缓存（她每打开一次「批量打印」都要等 ~11 秒，
  //         这是她最能感受到的一笔）⇒ 上一轮的"只影响端点"这条**被新口径取代**（不是放宽，
  //         而是观测点从"`listLabels` 不缓存"翻成"`listLabels` 也缓存、且记日志"）。
  const clock = fakeClock();
  const gateway = fakeGateway(labelListFixture());
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ labelList: { cacheTtlMs: 60000 } }),
  });
  const logs = captureLogs();
  let first; let second;
  try {
    first = await service.listLabels({});
    clock.advance(30 * 1000);
    second = await service.listLabels({});
  } finally {
    logs.restore();
  }
  assert.deepEqual(gateway.calls, ['liveInventory', 'product'],
    '⭐⭐ 第二次**一次飞书都没读**（她每开一次那页少等 ≈ 11 秒）');
  assert.equal(second.total_matched, first.total_matched, '命中的清单与未命中一致');
  assert.deepEqual(second.labels.map((label) => label.number), first.labels.map((label) => label.number));
  assert.equal(logs.events('workbench.labels.cache_miss').length, 1, '第一次未命中（read 了飞书）');
  assert.equal(logs.events('workbench.labels.cache_hit').length, 1, '第二次命中（一次都没读）');
  assert.equal(JSON.parse(logs.events('workbench.labels.cache_hit')[0]).age_ms, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N11/N12/N13（task-11）：`listLabels` 缓存的关闭 / 过期 / **筛选每请求现算**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N11 关掉 `labelList` 缓存（`cacheTtlMs: 0`）⇒ `listLabels` **每次真读**（能真红）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(labelListFixture());
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ labelList: { cacheTtlMs: 0 } }),
  });
  const logs = captureLogs();
  try {
    await service.listLabels({});
    clock.advance(1);
    await service.listLabels({});
  } finally {
    logs.restore();
  }
  assert.deepEqual(gateway.calls, ['liveInventory', 'product', 'liveInventory'],
    '⭐ 0 = 关掉 labelList 缓存 ⇒ liveInventory 每次真读；product 由统一 configTableCache 负责');
  assert.equal(logs.events('workbench.labels.cache_hit').length, 0, '一次都没命中');
  assert.deepEqual(logs.events('workbench.labels.cache_miss').map((line) => JSON.parse(line).reason),
    ['disabled', 'disabled'], '未命中的原因如实写 disabled');
});

test('AC-N12 `listLabels` 缓存 TTL 过期 ⇒ 重读（能真红）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(labelListFixture());
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ labelList: { cacheTtlMs: 60000 } }),
  });
  const logs = captureLogs();
  try {
    await service.listLabels({});
    clock.advance(59999);
    await service.listLabels({});   // 差 1ms 没过期 ⇒ 命中
    clock.advance(1);               // 正好到 TTL ⇒ 过期 ⇒ 重读
    await service.listLabels({});
  } finally {
    logs.restore();
  }
  assert.deepEqual(gateway.calls, ['liveInventory', 'product', 'liveInventory'],
    '⭐ labelList 过期后必须重读 liveInventory；product 由统一 configTableCache 负责');
  assert.equal(logs.events('workbench.labels.cache_hit').length, 1);
  assert.deepEqual(logs.events('workbench.labels.cache_miss').map((line) => JSON.parse(line).reason),
    ['empty', 'expired']);
});

test('AC-N14 这一档口径住在 config：`LABEL_PRINT.labelList.cacheTtlMs` 默认 60000（换值不用改代码）', () => {
  assert.equal(LABEL_PRINT.labelList.cacheTtlMs, 60000, 'task-11 定的默认：60 秒（她连着翻几次都是秒开）');
  // 「换值不用改代码」由 AC-N10/N11/N12 证明：三处都是**注入不同的 `labelList`** ⇒ 行为跟着变。
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N9 配置先行（task-10）：换值只改 config，不用改代码
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N7 `labelForRecord`：在「货品信息」里、库存里没有的编号 ⇒ 现在也能打出那一张（数据源并集的必然结果）', async () => {
  const gateway = fakeGateway({
    liveInventory: [],
    product: [productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 })],
  });
  gateway.get = async (tableKey, id) => (tableKey === 'product' && id === 'rec_new'
    ? productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 })
    : null);
  const service = createLabelPrintService(gateway);
  const data = await service.labelForRecord('rec_new');
  assert.equal(data.labels.length, 1, '恰好一张（不是 0 张，也不是多张）');
  assert.equal(data.labels[0].number, 'NEW2026|黑色|A');
  assert.deepEqual(data.labels[0].sizes, [], '新货没有尺码 ⇒ 不印「尺码 + 数量」那一行');
  assert.equal(data.labels[0].has_stock, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 纯函数（与既有 numberOf / buildProductIndex 一对）
// ═══════════════════════════════════════════════════════════════════════════

test('partsOfNumber / compoundNumber 是一对：编号 ↔ 三段（缺段不炸、也不编）', () => {
  assert.equal(compoundNumber('A1', '黑色', 'A'), 'A1|黑色|A');
  assert.equal(compoundNumber('A1', '', 'A'), 'A1||A');
  assert.deepEqual(partsOfNumber('A1|黑色|A'), { item_no: 'A1', color: '黑色', category_code: 'A' });
  assert.deepEqual(partsOfNumber('A1|黑色'), { item_no: 'A1', color: '黑色', category_code: '' });
  assert.deepEqual(partsOfNumber(''), { item_no: '', color: '', category_code: '' });
  assert.equal(compoundNumber(...Object.values(partsOfNumber('A1|黑色|A'))), 'A1|黑色|A');
});

test('createdAtOf：候选列按顺序取第一个读得出的时间；都读不出回 0（不猜）', () => {
  const now = 1759900000000;
  assert.equal(createdAtOf({ fields: { 上架日期: now } }, ['上架日期', '创建时间']), now);
  assert.equal(createdAtOf({ fields: { 创建时间: now } }, ['上架日期', '创建时间']), now);
  assert.equal(createdAtOf({ fields: { 更新日期: now } }, ['上架日期', '创建时间']), 0);
  assert.equal(createdAtOf({ fields: {} }, []), 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 无库存那批的边界：空表 / 只有新货（一张库存都没有）
// ═══════════════════════════════════════════════════════════════════════════

test('边界：一张库存都没有时，只回「货品信息」里那批（sizes 全空、total_pairs 0）', async () => {
  const { service } = serviceFor({
    product: [
      productRecord('p1', { number: 'A1|黑色|A', price: 100 }),
      productRecord('p2', { number: 'A2|黑色|A', price: 200 }),
    ],
  });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 2);
  assert.equal(data.total_pairs, 0);
  assert.equal(data.total_with_stock, 0);
  assert.equal(data.total_without_stock, 2);
  assert.deepEqual(data.labels.map((label) => label.sizes), [[], []]);
  assert.deepEqual(data.labels.map((label) => label.has_stock), [false, false]);
});

test('边界：两张表都空 ⇒ 200 + 空结果（不炸）', async () => {
  const { service } = serviceFor({});
  const data = await service.listLabels({});
  assert.deepEqual(data.labels, []);
  assert.equal(data.total_matched, 0);
});

