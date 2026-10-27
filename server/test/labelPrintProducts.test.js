/**
 * ⭐⭐ 2026-10-15（业务负责人口径）：**批量打印支持「货品信息 ∪ 实时库存」** ＋ 只读端点
 * `GET /api/workbench/products/numbers`。
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
 * · **AC-N5** `GET /api/workbench/products/numbers`：`keyword` 过滤 / `limit` 截断
 *   （`truncated:true`）/ `hasStock` 正确 / 响应**不含任何密钥** / 挂在**既有**
 *   `requireWorkbenchAccess` 之后（行为 503/401 ＋ 源码哨兵）。
 * · **AC-N6** **只读**：`listLabels` 与 `listProductNumbers` 都**没有任何创建 / 更新 / 删除调用**
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
const crypto = require('node:crypto');
const express = require('express');
// 这个路由/控制器在模块级会 `new V1BitableGateway()`（构造时读飞书凭证）。
// 给一对**假凭证**只为让模块能加载：本文件**不打飞书**（与 labelPrintRoute.test.js 同一做法）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  createLabelPrintService, partsOfNumber, compoundNumber, createdAtOf,
} = require('../src/services/labelPrintService');
const { createWorkbenchRouter } = require('../src/routes/workbench');
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

test('AC-N3 按尺码筛 ⇒ 没入库的那批被排除，**且**响应与日志都如实计数（删掉就红）', async () => {
  const { service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [
      productRecord('rec_brown', { number: 'XHB8095|棕色|A', price: 198 }),
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 }),
    ],
  });
  const logs = captureLogs();
  let data;
  try {
    data = await service.listLabels({ size: 36 });
  } finally {
    logs.restore();
  }
  assert.deepEqual(data.labels.map((label) => label.number), ['XHB8095|棕色|A'], '只留能判断尺码的那张');
  assert.equal(data.without_stock_skipped, 1, '⭐ 被排除的没入库编号数 = 1（**不静默**）');
  assert.equal(data.total_without_stock, 0);
  const warns = logs.events('workbench.labels.without_stock_skipped');
  assert.equal(warns.length, 1, '⭐ 必须有一条 warn 日志（删掉这条日志 ⇒ 本断言当场红）');
  const payload = JSON.parse(warns[0]);
  assert.equal(payload.without_stock_skipped, 1);
  assert.equal(payload.filtered_by_size, true);
  assert.equal(payload.filtered_by_state, false);
});

test('AC-N3 按所属状态筛 ⇒ 同样排除并计数（state 与 size 同一个口径）', async () => {
  const { service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', state: '门盒' })],
    product: [
      productRecord('rec_brown', { number: 'XHB8095|棕色|A', price: 198 }),
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 }),
    ],
  });
  const logs = captureLogs();
  let data;
  try {
    data = await service.listLabels({ state: '门盒' });
  } finally {
    logs.restore();
  }
  assert.deepEqual(data.labels.map((label) => label.number), ['XHB8095|棕色|A']);
  assert.equal(data.without_stock_skipped, 1);
  const payload = JSON.parse(logs.events('workbench.labels.without_stock_skipped')[0]);
  assert.equal(payload.filtered_by_state, true);
  assert.equal(payload.filtered_by_size, false);
});

test('AC-N3 keyword / category 两侧**都参与**（新货也能被关键词与类别挑出来）', async () => {
  const { service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', category: '休闲鞋' })],
    product: [
      productRecord('rec_brown', { number: 'XHB8095|棕色|A', price: 198 }),
      productRecord('rec_new', { number: 'NEW2026|黑色|B', price: 399, itemNo: 'NEW2026', color: '黑色', category: 'B' }),
    ],
  });
  assert.equal((await service.listLabels({})).total_matched, 2);
  assert.equal((await service.listLabels({ keyword: 'new2026' })).total_matched, 1, '关键词大小写不敏感，命中新货的货号');
  assert.equal((await service.listLabels({ keyword: 'NEW2026|黑色|B' })).total_matched, 1, '按**编号**也能搜到');
  assert.equal((await service.listLabels({ category: 'B' })).total_matched, 1, '类别（没库存那批的「类别」列）也参与');
  assert.equal((await service.listLabels({ category: '休闲鞋' })).total_matched, 1, '库存那批照旧按「品类」筛');
  assert.equal((await service.listLabels({ category: '不存在' })).total_matched, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N4 recentDays：没入库的那批按「货品信息」的创建时间列（真表里叫「上架日期」）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N4 配置里的列名跟真表对不上 ⇒ 按**飞书字段类型 1001** 兜底认出来（＋如实 warn）（能真红）', async () => {
  // ⚠️ task-10 改（**只改"注入哪一组 config"，断言一条都没放**）：
  //   改前逐字：`const service = createLabelPrintService(gateway, { now: () => now });`
  //   改后逐字：多注入一份 `productCreatedTime: { fieldName: '这个列名她后来改掉了', fieldType: 1001 }`
  //             （模拟"配置里的名字跟真表已经对不上"）⇒ 才走**类型兜底**那条路；
  //             `assert.ok(gateway.calls.includes('listFields:product'), …)` 等三条断言**原文一字未动**，
  //             另**加**一条 `workbench.labels.product_created_time_renamed` 的 warn 断言（**加强**，不是放宽）。
  //   依据：task-10 的 B2 —— 创建时间那套口径搬进 config 的正规一项后，**名字是配置的第一优先**
  //         （记录里有这一列就零额外请求），所以"按 type 1001 兜底"只能用"名字对不上"来触发。
  //         **判据没放宽**：仍是"记录里没有配置的那一列 ⇒ 按 type 1001 认出来，能真红"。
  const now = Date.parse('2026-10-15T12:00:00+08:00');
  const day = 24 * 60 * 60 * 1000;
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', createdAt: now - 1 * day })],
    product: [
      productRecord('rec_old', { number: 'OLD2026|黑色|A', price: 100, createdAt: now - 30 * day }),
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 200, createdAt: now - 1 * day }),
      productRecord('rec_stock', { number: 'XHB8095|棕色|A', price: 198, createdAt: now - 30 * day }),
    ],
    // 真表实测：创建时间列**被改名**成「上架日期」，但**类型仍是 1001**；「更新日期」是 1002。
    fieldLists: { product: [{ field_name: '上架日期', type: 1001 }, { field_name: '更新日期', type: 1002 }] },
  });
  const service = createLabelPrintService(gateway, {
    now: () => now,
    // 配置里的名字**已经对不上真表**（她改过名）⇒ 必须走类型兜底，并且**如实 warn** 提醒改配置。
    config: configWith({ productCreatedTime: { fieldName: '这个列名她后来改掉了', fieldType: 1001 } }),
  });
  const logs = captureLogs();
  let data;
  try {
    data = await service.listLabels({ recentDays: 7 });
  } finally {
    logs.restore();
  }
  assert.deepEqual(data.labels.map((label) => label.number), ['NEW2026|黑色|A', 'XHB8095|棕色|A'],
    '⭐ 最近 7 天：新货（按货品信息的创建时间列）＋ 有库存的（按实时库存的创建时间）都进来，30 天前的老货出去');
  assert.equal(data.missing_created_at_without_stock, 0);
  assert.ok(gateway.calls.includes('listFields:product'), '创建时间列是按**字段类型**解析的（不是写死列名）');
  const renamed = logs.events('workbench.labels.product_created_time_renamed');
  assert.equal(renamed.length, 1, '⭐ 名字对不上必须**如实 warn**（删掉这条日志 ⇒ 本断言当场红）');
  const payload = JSON.parse(renamed[0]);
  assert.equal(payload.configured_name, '这个列名她后来改掉了');
  assert.equal(payload.resolved_name, '上架日期', '按类型认出来的是真表那一列');
});

test('AC-N4 配置可覆盖字段名（`productCreatedTime.fieldName`）⇒ 不再问字段表', async () => {
  // ⚠️ task-10 改（**只改"注入哪一组 config"，断言一条都没放**）：
  //   改前逐字：`config: configWith({ fieldNamesPendingSchema: { createdTime: '创建时间', productCreatedTime: '创建时间' } }),`
  //   改后逐字：`config: configWith({ productCreatedTime: { fieldName: '创建时间', fieldType: 1001 } }),`
  //   依据：那个键从"service 散读的兜底口径"搬成了 config 的正规一项
  //         （task-10 B2 ⇒ `config/labelPrint.js#PRODUCT_CREATED_TIME`）；**判据没放宽**：
  //         两条断言的原文一字未动 —— 仍是"配置给了字段名 ⇒ 不去读字段表（零额外请求）"。
  const now = Date.parse('2026-10-15T12:00:00+08:00');
  const day = 24 * 60 * 60 * 1000;
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', createdAt: now - 1 * day })],
    product: [
      productRecord('rec_old', { number: 'OLD2026|黑色|A', price: 100, createdAt: now - 30 * day, createdField: '创建时间' }),
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 200, createdAt: now - 1 * day, createdField: '创建时间' }),
    ],
  });
  const service = createLabelPrintService(gateway, {
    now: () => now,
    config: configWith({ productCreatedTime: { fieldName: '创建时间', fieldType: 1001 } }),
  });
  const data = await service.listLabels({ recentDays: 7 });
  assert.deepEqual(data.labels.map((label) => label.number), ['NEW2026|黑色|A', 'XHB8095|棕色|A'],
    '新货（按配置的字段名）＋ 有库存的（按实时库存的创建时间）都在；30 天前的老货不在');
  assert.ok(!gateway.calls.includes('listFields:product'), '配置给了字段名 ⇒ 不去读字段表（零额外请求）');
});

test('AC-N4 默认 config 的列名「上架日期」在记录里 ⇒ 直接用它，**零额外请求**（不为了兜底白问字段表）', async () => {
  const now = Date.parse('2026-10-15T12:00:00+08:00');
  const day = 24 * 60 * 60 * 1000;
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', createdAt: now - 1 * day })],
    product: [
      productRecord('rec_old', { number: 'OLD2026|黑色|A', price: 100, createdAt: now - 30 * day }),
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 200, createdAt: now - 1 * day }),
    ],
    fieldLists: { product: [{ field_name: '上架日期', type: 1001 }, { field_name: '更新日期', type: 1002 }] },
  });
  const service = createLabelPrintService(gateway, { now: () => now });
  const data = await service.listLabels({ recentDays: 7 });
  assert.deepEqual(data.labels.map((label) => label.number), ['NEW2026|黑色|A', 'XHB8095|棕色|A']);
  assert.ok(!gateway.calls.includes('listFields:product'),
    '⭐ 配置的名字在记录里 ⇒ **不**去问字段表（兜底只在"名字对不上"时才动）');
});

test('AC-N4 读不到创建时间列 ⇒ 没入库的那批**如实排除并计数 + warn**（不静默当成"没有新货"）', async () => {
  const now = Date.parse('2026-10-15T12:00:00+08:00');
  const day = 24 * 60 * 60 * 1000;
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', createdAt: now - 1 * day })],
    product: [productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 200, createdAt: now - 1 * day, createdField: '更新日期' })],
    // 只有 ModifiedTime（1002）——**不是**创建时间：拿它当"最近新增"会把改过的老货当新货 ✗
    fieldLists: { product: [{ field_name: '更新日期', type: 1002 }] },
  });
  const service = createLabelPrintService(gateway, { now: () => now });
  const logs = captureLogs();
  let data;
  try {
    data = await service.listLabels({ recentDays: 7 });
  } finally {
    logs.restore();
  }
  assert.deepEqual(data.labels.map((label) => label.number), ['XHB8095|棕色|A'], '没有创建时间 ⇒ 不能用它筛（如实排除）');
  assert.equal(data.missing_created_at_without_stock, 1, '如实计数');
  assert.equal(logs.events('workbench.labels.without_stock_missing_created_at').length, 1, '而且有一条 warn（不静默）');
});

test('AC-N4 既有口径不回退：两侧都读不到创建时间 ⇒ 当场抛错（沿用"不许静默当没筛"）', async () => {
  const service = createLabelPrintService(fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 200 })],
    fieldLists: { product: [] },
  }), { now: () => Date.parse('2026-10-15T12:00:00+08:00') });
  await assert.rejects(() => service.listLabels({ recentDays: 7 }), /创建时间/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N5 只读端点 GET /api/workbench/products/numbers（契约冻结）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N5 `listProductNumbers`：按编号去重 / keyword 大小写不敏感 / 中文升序 / hasStock 正确', async () => {
  // ⚠️ task-15 改（**契约变了，逐字写了改前/改后/依据；判据没放宽**）：
  //   改前逐字：`const all = await service.listProductNumbers({});`
  //             ＋ `assert.deepEqual(gateway.calls, ['product', 'liveInventory'], '只读这两张表，各一次');`
  //   改后逐字：空关键字那一段换成"**空列表 + 零读**"（依据 = 她「输入一个编号 ⇒ 系统给相关选项」，
  //             task-15 要求"从根上取消读全表"）；有字那一段改成**按关键字读**，
  //             判据换成 `gateway.calls === []`（**没有整表读**）＋ `filterCalls` 各两次。
  //   依据：task-15 第 1/2 条（`keyword` 非空走按条件读；为空 ⇒ 空列表 + 一次飞书都不读）。
  //   下面每一条**业务判据**（去重 / 中文序 / 大小写不敏感 / hasStock）**原文都没动** ✓。
  const { gateway, service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [
      productRecord('rec_z', { number: 'Z900|黑色|A', price: 1, itemNo: 'Z900', color: '黑色', category: 'A' }),
      productRecord('rec_a', { number: 'A100|棕色|A', price: 2, itemNo: 'A100', color: '棕色', category: 'A' }),
      productRecord('rec_xhb', { number: 'XHB8095|棕色|A', price: 3, itemNo: 'XHB8095', color: '棕色', category: 'A' }),
      // 同一编号的第二条记录 ⇒ **去重**（只回一条）
      productRecord('rec_a_dup', { number: 'A100|棕色|A', price: 9 }),
      // 没有编号的记录 ⇒ 跳过（不动产物）
      productRecord('rec_blank', { price: 5 }),
    ],
  });
  // ⭐ task-15：**空关键字 ⇒ 空列表 + 一次飞书都不读**（原来这里是"回全表前 200 条"）。
  // ⚠️ 2026-10-16：`labelPrintProducts` 是**服务端**这一半 —— 空关键字仍然**空列表 + 零读**，
  //    一个字没变 ✓（她那天点的是**前端状态区**那句话，与这里的服务端契约无关）
  //    ⇒ 这一句只把消息里的"前端显示…"改成"前端不再显示那句话"。**判据本身一个字没动** ✓。
  const empty = await service.listProductNumbers({});
  assert.deepEqual(empty, { total: 0, truncated: false, numbers: [] },
    '空关键字 ⇒ 空列表（前端 2026-10-16 起不再写那句提示语，见 productNumberPicker.test.js，AC-F2）');
  assert.deepEqual(gateway.calls, [], '空关键字**一次整表读都没有**');
  assert.deepEqual(gateway.filterCalls, [], '空关键字连按条件读都不发');
  // ⭐ 「棕色」一次命中两条编号 ⇒ 验证去重（`rec_a_dup` 不重复出）+ 中文升序。
  const byColor = await service.listProductNumbers({ keyword: '棕色' });
  assert.deepEqual(byColor.numbers.map((item) => item.number), ['A100|棕色|A', 'XHB8095|棕色|A'],
    '⭐ 按「编号」中文序升序，且同一编号只回一条');
  assert.equal(byColor.total, 2);
  assert.equal(byColor.truncated, false);
  assert.deepEqual(byColor.numbers[0], {
    number: 'A100|棕色|A', itemNo: 'A100', color: '棕色', category: 'A', hasStock: false, recordId: 'rec_a',
  }, '⭐ 契约字段逐字：number / itemNo / color / category / hasStock / recordId');
  assert.equal(byColor.numbers.find((item) => item.number === 'XHB8095|棕色|A').hasStock, true, '在「实时库存」里有行 ⇒ hasStock: true');
  assert.deepEqual(gateway.calls, [], '⭐⭐ **一次整表读都没有**（只走按条件读）');

  const byKeyword = await service.listProductNumbers({ keyword: 'xhb8095' });
  assert.deepEqual(byKeyword.numbers.map((item) => item.number), ['XHB8095|棕色|A'], '关键词大小写不敏感（货号）');
  assert.deepEqual((await service.listProductNumbers({ keyword: 'Z900' })).numbers.map((item) => item.number),
    ['Z900|黑色|A'], '编号 / 货号都参与');
});

test('AC-N5 limit 截断如实（truncated:true）；越界 / 非整数 ⇒ 400 原样回显', async () => {
  // ⚠️ task-15 改（**只补了关键字，判据原文没动**）：
  //   改前逐字：`const limited = await service.listProductNumbers({ limit: 2 });` / `listProductNumbers({})` / `{ limit: '500' }`
  //   改后逐字：都补上 `keyword: 'N'`（空关键字在新契约下**不再**表示"全部"，见 AC-F2）。
  //   依据：task-15 第 2 条（空关键字 = 空列表）—— 截断要测的东西没变，只是要给它一个关键字 ✓。
  const product = [1, 2, 3, 4, 5].map((n) => productRecord(`p${n}`, { number: `N${n}|黑色|A`, price: 1 }));
  const { service } = serviceFor({ product });
  const limited = await service.listProductNumbers({ keyword: 'N', limit: 2 });
  assert.equal(limited.total, 5);
  assert.equal(limited.truncated, true, '⭐ 不静默截断');
  assert.deepEqual(limited.numbers.map((item) => item.number), ['N1|黑色|A', 'N2|黑色|A']);
  const defaulted = await service.listProductNumbers({ keyword: 'N' });
  assert.equal(defaulted.numbers.length, 5, '默认 limit 200（这里 5 条都回）');
  await assert.rejects(() => service.listProductNumbers({ keyword: 'N', limit: '0' }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.listProductNumbers({ keyword: 'N', limit: '2.5' }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.listProductNumbers({ keyword: 'N', limit: '501' }), (error) => error.statusCode === 400);
  assert.equal((await service.listProductNumbers({ keyword: 'N', limit: '500' })).numbers.length, 5, '500 是允许的上限');
});

test('AC-N5 `GET /products/numbers`：query 交给 service、响应摊平在 success 之外、**响应里没有任何密钥**', async () => {
  login();
  const calls = [];
  const labelPrint = {
    listProductNumbers: async (input) => {
      calls.push(input);
      return {
        total: 2,
        truncated: true,
        numbers: [{ number: 'A100|黑色|A', itemNo: 'A100', color: '黑色', category: 'A', hasStock: false, recordId: 'rec_a' }],
      };
    },
  };
  await withServer(appFor(labelPrint), async (base) => {
    const response = await fetch(`${base}/api/workbench/products/numbers?keyword=XHB&limit=2`,
      { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 200);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(body.success, true);
    assert.equal(body.total, 2);
    assert.equal(body.truncated, true);
    assert.equal(body.numbers.length, 1);
    assert.deepEqual(Object.keys(body.numbers[0]).sort(),
      ['category', 'color', 'hasStock', 'itemNo', 'number', 'recordId'],
      '契约字段集合是冻结的（不多塞内部字段）');
    // 🔴 响应里不许有任何密钥 / 票据 / 签名（这条端点连飞书凭证的影子都不该有）。
    assert.equal(/token|secret|signature|api_key|ticket/i.test(text), false,
      '⭐ 响应不含任何密钥（原样扫一遍返回体）');
  });
  assert.deepEqual(calls[0], { keyword: 'XHB', limit: '2' }, 'query 原样交给 service');
});

test('AC-N5 这个端点挂在**既有** `requireWorkbenchAccess` 之后（行为：未启用 503 / 未登录 401）', async () => {
  const app = appFor({ listProductNumbers: async () => { throw new Error('不该被调用'); } });
  delete process.env.LARK_WEB_AUTH_ENABLED;
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/products/numbers`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 503, '认证没启用时必须拒绝（即使带着会话 cookie）');
  });

  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/products/numbers`);
    assert.equal(response.status, 401, '没登录必须 401');
    assert.equal((await response.json()).auth_required, true);
  });
  delete process.env.LARK_WEB_AUTH_ENABLED;
});

test('AC-N5 失败口径复用控制器那一份：她填错 400 原样回显 / 远端出错 500 不回显内部细节', async () => {
  login();
  const inputError = Object.assign(new Error('limit 必须是 1 到 500 之间的整数'), { statusCode: 400 });
  await withServer(appFor({ listProductNumbers: async () => { throw inputError; } }), async (base) => {
    const response = await fetch(`${base}/api/workbench/products/numbers?limit=0`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'limit 必须是 1 到 500 之间的整数');
  });
  await withServer(appFor({
    listProductNumbers: async () => { throw new Error('App token 不合法（内部细节）'); },
  }), async (base) => {
    const response = await fetch(`${base}/api/workbench/products/numbers`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.error, '标签数据读取失败');
    assert.ok(!body.error.includes('App token'), '内部细节不回显');
  });
});

test('AC-N5 源码哨兵：新端点挂在闸门之后，且**不新开鉴权 / 不新造读取口**', () => {
  const routes = sourceOf('routes/workbench.js');
  const labelRoutes = sourceOf('routes/workbench/labels.js');
  const routeAt = labelRoutes.indexOf("router.get('/products/numbers'");
  const gateAt = routes.indexOf('router.use(requireWorkbenchAccess)');
  assert.ok(routeAt > 0, '`/products/numbers` 必须在 labels 子路由里');
  assert.ok(gateAt > 0, '父 router 必须保留既有 requireWorkbenchAccess');
  assert.match(labelRoutes, /labelPrint\.listProductNumbers\(/, '取数走 labelPrintService（不在这里另写一份）');
  const endpoint = labelRoutes.slice(routeAt, labelRoutes.indexOf('router.post(', routeAt));
  for (const forbidden of ['.create(', '.update(', '.delete(']) {
    assert.ok(!endpoint.includes(forbidden), `只读端点里不许出现 ${forbidden}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N6 只读（运行时 + 源码）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N6 只读：`listLabels` 与 `listProductNumbers` 一次 create/update/delete 都不调', async () => {
  const { gateway, service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 })],
  });
  // 假网关的 create/update/delete 直接抛错 ⇒ 只要被调到，这条用例当场红。
  await service.listLabels({});
  // ⚠️ task-15 改（**只补了关键字；判据换成"整表读 + 按条件读各是什么"**）：
  //   改前逐字：`await service.listProductNumbers({});` ＋
  //             `assert.deepEqual(gateway.calls, ['liveInventory','product','product','liveInventory']);`
  //   改后逐字：`await service.listProductNumbers({ keyword: 'NEW2026' });` ＋
  //             `assert.deepEqual(gateway.calls, ['liveInventory','product']);`（只有 listLabels 那两次整表读）
  //             ＋ `assert.equal(gateway.filterCalls.length, 2, …)`（端点走的是**按条件读**）
  //   依据：task-15 第 1/2 条（空关键字不再读表；有字走按条件读）。
  //   **判据没放宽**：仍然钉"整条链路只读、且只读这两张表"。
  await service.listProductNumbers({ keyword: 'NEW2026' });
  assert.deepEqual(gateway.calls, ['liveInventory', 'product'], '整表读只有 listLabels 那两次');
  assert.deepEqual(gateway.filterCalls.map((item) => item.tableKey), ['product', 'liveInventory'],
    '端点的两次读都是**按条件读**（不是整表）');
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

test('AC-F1 有 keyword ⇒ **只走按条件读**：一次整表读都没有，公式里带关键字（能真红）', async () => {
  const { gateway, service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [
      productRecord('rec_xhb', { number: 'XHB8095|棕色|A', price: 198, itemNo: 'XHB8095' }),
      productRecord('rec_other', { number: 'Z900|黑色|A', price: 1, itemNo: 'Z900' }),
    ],
  });
  const data = await service.listProductNumbers({ keyword: 'xhb8095' });
  assert.deepEqual(data.numbers.map((item) => item.number), ['XHB8095|棕色|A'], '只回匹配的那一条');
  assert.deepEqual(gateway.calls, [], '⭐⭐ **没有任何无条件的整表读**（`listAll` 一次都没调）');
  assert.deepEqual(gateway.filterCalls.map((item) => item.tableKey), ['product', 'liveInventory'],
    '两次读都是**按条件读**（货品 + 实时库存）');
  const productFilter = gateway.filterCalls[0].filter;
  assert.match(productFilter, /CurrentValue\.\[编号\]\.contains\("xhb8095"\)/, '公式按「编号」contains 关键字');
  assert.match(productFilter, /CurrentValue\.\[货号\]\.contains\("xhb8095"\)/, '也按「货号」contains（编号为空的边角）');
  assert.equal(/颜色/.test(productFilter), false,
    '⭐ **绝不**把「颜色」拼进公式（关联列 type 18 拼 filter 会 InvalidFilter 1254018 —— 仓库里已有硬事实）');
  assert.match(gateway.filterCalls[1].filter, /CurrentValue\.\[库存键\]\.contains\("xhb8095"\)/,
    '库存那次也按条件读（「库存键」含编号）');
});

test('AC-F1b 缓存**按关键字分槽**：A 关键字的结果不会被 B 关键字命中（能真红）', async () => {
  const gateway = fakeGateway({
    liveInventory: [],
    product: [
      productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 198, itemNo: 'XHB8095' }),
      productRecord('rec_z', { number: 'Z900|黑色|A', price: 1, itemNo: 'Z900' }),
    ],
  });
  const service = createLabelPrintService(gateway, { config: configWith({ productNumbers: { cacheTtlMs: 60000 } }) });
  const byX = await service.listProductNumbers({ keyword: 'XHB8095' });
  const byZ = await service.listProductNumbers({ keyword: 'Z900' });
  const byXAgain = await service.listProductNumbers({ keyword: 'xhb8095' });
  assert.deepEqual(byX.numbers.map((item) => item.number), ['XHB8095|棕色|A']);
  assert.deepEqual(byZ.numbers.map((item) => item.number), ['Z900|黑色|A'],
    '⭐ B 关键字拿到的是**它自己**的结果（不是 A 的缓存）');
  assert.deepEqual(byXAgain.numbers.map((item) => item.number), ['XHB8095|棕色|A']);
  assert.equal(gateway.filterCalls.length, 4,
    '三次调用 = 2 次首查（X / Z）＋ 0 次（`xhb8095` 与 `XHB8095` 是**同一个槽**，大小写不敏感）');
});

test('AC-F2 ⭐ `keyword` 为空 ⇒ **一次飞书都不读** + 空列表（能真红：改回读全表就红）', async () => {
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 198, itemNo: 'XHB8095' })],
  });
  const service = createLabelPrintService(gateway, {});
  const logs = captureLogs();
  let empty; let blank;
  try {
    empty = await service.listProductNumbers({});
    blank = await service.listProductNumbers({ keyword: '   ' });
  } finally {
    logs.restore();
  }
  assert.deepEqual(empty, { total: 0, truncated: false, numbers: [] }, '空关键字 ⇒ 空列表（前端显示提示语）');
  assert.deepEqual(blank, { total: 0, truncated: false, numbers: [] }, '只有空白也当空');
  assert.deepEqual(gateway.calls, [], '⭐⭐ **整表读 0 次**');
  assert.deepEqual(gateway.filterCalls, [], '按条件读也 0 次（**这一趟就是零飞书调用**）');
  const filtered = logs.events('workbench.products.numbers.filtered');
  assert.equal(filtered.length, 2, '两次都记了 `products.numbers.filtered`（真机一眼看出"没读表"）');
  assert.equal(JSON.parse(filtered[0]).source, 'empty_keyword');
  assert.equal(JSON.parse(filtered[0]).read, false);
});

test('AC-F3 `hasStock` 三种取值都对：true / false / **null（不猜）**', async () => {
  // ① true（有库存行）+ ② false（真的没有库存行，且编号含关键字 ⇒ 结论可靠）
  const { service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [
      productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 198, itemNo: 'XHB8095' }),
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399, itemNo: 'NEW2026' }),
    ],
  });
  const both = await service.listProductNumbers({ keyword: '2026' });
  assert.equal(both.numbers.length, 1);
  assert.equal(both.numbers[0].hasStock, false, '⭐ 过滤读没查到 + 编号含关键字 ⇒ **真的没有库存**（false 可靠）');
  const stocked = await service.listProductNumbers({ keyword: 'XHB8095' });
  assert.equal(stocked.numbers[0].hasStock, true, '在「实时库存」里有行 ⇒ true');

  // ③ null 之一：**库存那次读失败** ⇒ 一律"未确认"（绝不猜成没入库 ✗）
  const failGateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 198, itemNo: 'XHB8095' })],
    stockReadThrows: true,
  });
  const logs = captureLogs();
  let unknown;
  try {
    unknown = await createLabelPrintService(failGateway, {}).listProductNumbers({ keyword: 'XHB8095' });
  } finally {
    logs.restore();
  }
  assert.equal(unknown.numbers[0].hasStock, null, '⭐ 库存读失败 ⇒ `hasStock: null`（未确认）');
  assert.equal(logs.events('workbench.products.numbers.stock_read_failed').length, 1, '而且如实 warn');

  // ④ null 之二：**库存扫描撞上限** ⇒ 没查到的不敢说 false（可能只是没看全）
  const capGateway = fakeGateway({
    liveInventory: [
      stockRecord('s2', { stockKey: 'A2|黑|A|40' }),
      stockRecord('s3', { stockKey: 'A3|黑|A|41' }),
      stockRecord('s1', { stockKey: 'A1|黑|A|42' }),
    ],
    product: [1, 2, 3].map((n) => productRecord(`p${n}`, { number: `A${n}|黑|A`, price: 1, itemNo: `A${n}` })),
  });
  const capped = await createLabelPrintService(capGateway, {
    config: configWith({ productNumbers: { stockScanMax: 1 } }),
  }).listProductNumbers({ keyword: 'A' });
  const byNumber = new Map(capped.numbers.map((item) => [item.number, item.hasStock]));
  assert.equal(byNumber.get('A2|黑|A'), true, '看全的那两个照旧 true');
  assert.equal(byNumber.get('A1|黑|A'), null, '⭐ 撞了扫描上限 ⇒ 没查到的一律 `null`（**不猜 false**）');

  // ⑤ null 之三：这个编号**本身不含**关键字（靠「货号」命中的边角）⇒ 上面那条推理不成立
  const edgeGateway = fakeGateway({
    liveInventory: [stockRecord('se', { stockKey: 'XY|黑|A|40' })],
    product: [productRecord('rec_edge', { number: 'XY|黑|A', price: 1, itemNo: 'T202' })],
  });
  const edge = await createLabelPrintService(edgeGateway, {}).listProductNumbers({ keyword: 'T202' });
  assert.equal(edge.numbers.length, 1, '靠「货号」也能命中');
  assert.equal(edge.numbers[0].hasStock, null, '⭐ 编号不含关键字 ⇒ `null`（不许把"没查全"说成"没入库" ✗）');
});

test('AC-F4 开关 / 上限 / 扫描上限**都来自配置**（能真红）', async () => {
  // ① `serverFilter: false` ⇒ 回退老路径（整表读 + 内存过滤），并**如实 warn**
  const { gateway, service } = serviceFor({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
    product: [productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 198, itemNo: 'XHB8095' })],
  }, { productNumbers: { serverFilter: false } });
  const logs = captureLogs();
  let fallback;
  try {
    fallback = await service.listProductNumbers({ keyword: 'XHB8095' });
  } finally {
    logs.restore();
  }
  assert.deepEqual(fallback.numbers.map((item) => item.number), ['XHB8095|棕色|A'], '老路径结果一样对');
  assert.deepEqual(gateway.calls, ['product', 'liveInventory'], '⭐ 关掉开关 ⇒ 回退**整表读**（这是退路，不是死代码）');
  assert.deepEqual(gateway.filterCalls, [], '这一趟没有按条件读');
  assert.equal(JSON.parse(logs.events('workbench.products.numbers.server_filter_off')[0]).reason, 'disabled_by_config');
  assert.equal(JSON.parse(logs.events('workbench.products.numbers.listed')[0]).source, 'full_table');

  // ② 网关没有 `listByFilter`（老假网关 / 老部署）⇒ 也回退，reason 说清是"网关没有这个能力"
  const noFilterGateway = {
    calls: [],
    async listAll(tableKey) {
      this.calls.push(tableKey);
      return tableKey === 'product' ? [productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 1 })] : [];
    },
  };
  const noFilterLogs = captureLogs();
  let degraded;
  try {
    degraded = await createLabelPrintService(noFilterGateway, {}).listProductNumbers({ keyword: 'XHB8095' });
  } finally {
    noFilterLogs.restore();
  }
  assert.deepEqual(degraded.numbers.map((item) => item.number), ['XHB8095|棕色|A'], '降级路径照样能用');
  assert.equal(JSON.parse(noFilterLogs.events('workbench.products.numbers.server_filter_off')[0]).reason,
    'gateway_without_filter');

  // ③ 关键字里带了**拼不进公式**的字符 ⇒ 如实 400（**不硬拼**：错数据比慢更坏）
  const { service: plain } = serviceFor({ product: [productRecord('rec_x', { number: 'A|黑|A', price: 1 })] });
  await assert.rejects(() => plain.listProductNumbers({ keyword: 'A"B' }),
    (error) => error.statusCode === 400 && /符号/.test(error.message), '双引号 ⇒ 400 + 人话');
});


// ═══════════════════════════════════════════════════════════════════════════
// AC-N8 性能（task-10）：短 TTL 缓存 —— 只服务这个端点
//   线上只读实测：listAll('product') 561 行 5478ms ＋ listAll('liveInventory') 1362 行 5924ms
//   ⇒ 一次 ≈ 11.4 秒。所以：TTL 内只读一次；= 0 关闭；过期重读；命中/未命中都记日志。
// ═══════════════════════════════════════════════════════════════════════════

/** 假时钟（可拨）—— 缓存 TTL 全靠它驱动，用例**不依赖 wall-clock**（免得又出 flaky）。 */
const fakeClock = (start = Date.parse('2026-10-15T12:00:00+08:00')) => {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
};

const numbersFixture = () => ({
  liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36' })],
  product: [
    productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399 }),
    productRecord('rec_stock', { number: 'XHB8095|棕色|A', price: 198 }),
  ],
});

test('AC-N8 ⭐ TTL 内第二次调用 **0 次飞书读**（假网关计数能真红）＋ 命中/未命中都有日志', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(numbersFixture());
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ productNumbers: { cacheTtlMs: 60000 } }),
  });
  const logs = captureLogs();
  let first; let second;
  try {
    // ⚠️ task-15 改（**只补了关键字 + 把观测量从"整表读"换成"按条件读"，判据没放宽**）：
    //   改前逐字：`listProductNumbers({})` ＋ `assert.deepEqual(gateway.calls, ['product','liveInventory'], …)`
    //   改后逐字：`listProductNumbers({ keyword: 'NEW2026' })` ＋
    //             `assert.equal(gateway.filterCalls.length, 2, …)`（两次调用只留下第一次那两次按条件读）
    //   依据：task-15 第 2 条（空关键字不再读表）⇒ 缓存要拿**有关键字**的请求来测。
    first = await service.listProductNumbers({ keyword: 'NEW2026' });
    clock.advance(30 * 1000);
    second = await service.listProductNumbers({ keyword: 'NEW2026' });
  } finally {
    logs.restore();
  }
  assert.equal(gateway.filterCalls.length, 2,
    '⭐ 第二次**一次飞书都没读**（两次调用只留下第一次那两次按条件读）');
  assert.deepEqual(second, first, '命中的结果与未命中逐字一致');
  assert.equal(logs.events('workbench.products.numbers.cache_miss').length, 1, '第一次未命中');
  assert.equal(logs.events('workbench.products.numbers.cache_hit').length, 1, '第二次命中');
  const hit = JSON.parse(logs.events('workbench.products.numbers.cache_hit')[0]);
  assert.equal(hit.age_ms, 30000, '如实记"缓存多大了"');
  assert.equal(hit.ttl_ms, 60000);
  assert.equal(JSON.parse(logs.events('workbench.products.numbers.cache_miss')[0]).reason, 'empty',
    '第一次未命中的原因 = 还没有缓存');
});

test('AC-N8 关掉缓存（`cacheTtlMs: 0`）⇒ **每次真读**（能真红）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(numbersFixture());
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ productNumbers: { cacheTtlMs: 0 } }),
  });
  const logs = captureLogs();
  try {
    await service.listProductNumbers({ keyword: 'NEW2026' });
    clock.advance(1);
    await service.listProductNumbers({ keyword: 'NEW2026' });
  } finally {
    logs.restore();
  }
  assert.equal(gateway.filterCalls.length, 4, '⭐ 0 = 关掉 ⇒ 每次都真读飞书（两次调用 = 4 次按条件读）');
  assert.equal(logs.events('workbench.products.numbers.cache_hit').length, 0, '一次都没命中');
  assert.deepEqual(logs.events('workbench.products.numbers.cache_miss')
    .map((line) => JSON.parse(line).reason), ['disabled', 'disabled'], '未命中的原因如实写 disabled');
});

test('AC-N8 TTL 过期 ⇒ 重读（能真红）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(numbersFixture());
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ productNumbers: { cacheTtlMs: 60000 } }),
  });
  const logs = captureLogs();
  try {
    await service.listProductNumbers({ keyword: 'NEW2026' });
    clock.advance(59999);
    await service.listProductNumbers({ keyword: 'NEW2026' });   // 差 1ms 没过期 ⇒ 命中
    clock.advance(1);                                           // 正好到 TTL ⇒ 过期
    await service.listProductNumbers({ keyword: 'NEW2026' });
  } finally {
    logs.restore();
  }
  assert.equal(gateway.filterCalls.length, 4, '⭐ 过期后必须重读（不能拿过期的清单一直糊弄她）');
  assert.equal(logs.events('workbench.products.numbers.cache_hit').length, 1);
  assert.deepEqual(logs.events('workbench.products.numbers.cache_miss')
    .map((line) => JSON.parse(line).reason), ['empty', 'expired']);
});

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
  const gateway = fakeGateway(numbersFixture());
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
  // 两个缓存**互不干扰**：listLabels 命中不等于端点也命中（各自一个实例）。
  assert.equal(logs.events('workbench.products.numbers.cache_hit').length, 0);
  assert.equal(logs.events('workbench.products.numbers.cache_miss').length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N11/N12/N13（task-11）：`listLabels` 缓存的关闭 / 过期 / **筛选每请求现算**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N11 关掉 `labelList` 缓存（`cacheTtlMs: 0`）⇒ `listLabels` **每次真读**（能真红）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(numbersFixture());
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
  assert.deepEqual(gateway.calls, ['liveInventory', 'product', 'liveInventory', 'product'],
    '⭐ 0 = 关掉 ⇒ 每次都真读飞书（拿到的永远是最新的货）');
  assert.equal(logs.events('workbench.labels.cache_hit').length, 0, '一次都没命中');
  assert.deepEqual(logs.events('workbench.labels.cache_miss').map((line) => JSON.parse(line).reason),
    ['disabled', 'disabled'], '未命中的原因如实写 disabled');
});

test('AC-N12 `listLabels` 缓存 TTL 过期 ⇒ 重读（能真红）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway(numbersFixture());
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
  assert.deepEqual(gateway.calls, ['liveInventory', 'product', 'liveInventory', 'product'],
    '⭐ 过期后必须重读（新到的货不能一直看不到）');
  assert.equal(logs.events('workbench.labels.cache_hit').length, 1);
  assert.deepEqual(logs.events('workbench.labels.cache_miss').map((line) => JSON.parse(line).reason),
    ['empty', 'expired']);
});

test('AC-N13 ⭐⭐ 不同筛选参数**在缓存之上各自正确**（缓存的是原始行，不是筛选结果）', async () => {
  const clock = fakeClock();
  const gateway = fakeGateway({
    liveInventory: [
      stockRecord('st_x', { stockKey: 'XHB8095|棕色|A|36' }),
      stockRecord('st_y', { stockKey: 'YD6693|米白|A|38' }),
    ],
    product: [
      productRecord('rec_x', { number: 'XHB8095|棕色|A', price: 198 }),
      productRecord('rec_y', { number: 'YD6693|米白|A', price: 298 }),
    ],
  });
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ labelList: { cacheTtlMs: 60000 } }),
  });
  const all = await service.listLabels({});
  const byX = await service.listLabels({ keyword: 'XHB8095' });
  const byY = await service.listLabels({ keyword: 'YD6693' });
  const bySize = await service.listLabels({ size: 38 });
  assert.equal(all.total_matched, 2);
  assert.deepEqual(byX.labels.map((label) => label.number), ['XHB8095|棕色|A'],
    '⭐ 同一个 TTL 里的另一个 keyword 拿到的是**它自己**的结果（连筛选结果一起缓存就会串数据）');
  assert.deepEqual(byY.labels.map((label) => label.number), ['YD6693|米白|A']);
  assert.deepEqual(bySize.labels.map((label) => label.number), ['YD6693|米白|A']);
  assert.deepEqual(gateway.calls, ['liveInventory', 'product'], '4 次查询共用**一次**真读');
});

test('AC-N13 ⭐⭐ 「最近新增」按时间过滤**每请求现算**（时间往前走 ⇒ 同一份缓存里筛出不同结果）', async () => {
  const clock = fakeClock();
  const day = 24 * 60 * 60 * 1000;
  // ⚠️ 时间账要算清（否则测的不是"现算"而是"缓存过期"）：
  //   · 货是**1 天前差 30 秒**到的 ⇒ t0 时在「最近 1 天」**里**（勉强）；
  //   · 时钟往前拨 **59 秒** ⇒ 货变成"1 天零 29 秒前" ⇒ 出了窗口；
  //   · 而 59 秒 **< TTL 60 秒** ⇒ 这一轮**仍然命中缓存**（没有重读飞书）。
  //   ⇒ 同一份缓存、同一个 recentDays=1，结果从 2 张变 0 张 = **时间判断在缓存之外每请求现算** ✓
  const arrivedAt = clock.now() - (day - 30 * 1000);
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', createdAt: arrivedAt })],
    product: [productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 399, createdAt: arrivedAt })],
  });
  const service = createLabelPrintService(gateway, {
    now: clock.now, config: configWith({ labelList: { cacheTtlMs: 60000 } }),
  });
  const fresh = await service.listLabels({ recentDays: 1 });
  assert.equal(fresh.total_matched, 2, 't0：刚到的货还在「最近 1 天」里');
  clock.advance(59 * 1000);                                 // 窗口内、但货已经出了"最近 1 天"
  const stale = await service.listLabels({ recentDays: 1 });
  assert.equal(stale.total_matched, 0, '⭐⭐ 同一份缓存、同一个条件：时间判断**每请求现算** ⇒ 它们已经不在"最近 1 天"里了');
  assert.deepEqual(gateway.calls, ['liveInventory', 'product'], '这一轮没有重读飞书（命中缓存的是**原始行**）');
});

test('AC-N14 这一档口径住在 config：`LABEL_PRINT.labelList.cacheTtlMs` 默认 60000（换值不用改代码）', () => {
  assert.equal(LABEL_PRINT.labelList.cacheTtlMs, 60000, 'task-11 定的默认：60 秒（她连着翻几次都是秒开）');
  // 「换值不用改代码」由 AC-N10/N11/N12 证明：三处都是**注入不同的 `labelList`** ⇒ 行为跟着变。
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N9 配置先行（task-10）：换值只改 config，不用改代码
// ═══════════════════════════════════════════════════════════════════════════

test('AC-N9 `config/labelPrint.js` 就是这几档的家（默认 60s / 200 / 500 ＋「上架日期」+ 1001）', () => {
  assert.equal(LABEL_PRINT.productNumbers.cacheTtlMs, 60000, '默认 TTL = 60 秒（task-10 定的）');
  assert.equal(LABEL_PRINT.productNumbers.limitDefault, 200, '默认 limit = 200（契约）');
  assert.equal(LABEL_PRINT.productNumbers.limitMax, 500, 'limit 上限 = 500（契约）');
  assert.equal(LABEL_PRINT.productCreatedTime.fieldName, '上架日期',
    '真表里那一列的名字（只读核过：type 1001 = CreatedTime，她把它改了名）');
  assert.equal(LABEL_PRINT.productCreatedTime.fieldType, 1001,
    '类型兜底：1001 = 飞书自动 CreatedTime（1002 = ModifiedTime，**不能**拿来当最近新增）');
});

test('AC-N9 注入不同的 `productNumbers` ⇒ limit 默认 / 上限跟着变（不用改代码，能真红）', async () => {
  const { service } = serviceFor({
    product: [1, 2, 3].map((n) => productRecord(`p${n}`, { number: `N${n}|黑色|A`, price: 1 })),
  }, { productNumbers: { limitDefault: 1, limitMax: 2 } });
  // ⚠️ task-15 改（**只补了关键字，判据原文没动**）：空关键字在新契约下 = 空列表（AC-F2）。
  const data = await service.listProductNumbers({ keyword: 'N' });
  assert.equal(data.numbers.length, 1, '默认 limit = 注入的 1');
  assert.equal(data.truncated, true);
  assert.equal((await service.listProductNumbers({ keyword: 'N', limit: '2' })).numbers.length, 2, '上限 = 注入的 2');
  await assert.rejects(() => service.listProductNumbers({ keyword: 'N', limit: '3' }),
    (error) => error.statusCode === 400 && /limit 最多 2/.test(error.message),
    '超过注入的上限 ⇒ 400（不是 500，也不静默截断）');
});

test('AC-N9 注入不同的 `productCreatedTime.fieldType` ⇒ 认出来的列跟着变（不用改代码，能真红）', async () => {
  const now = Date.parse('2026-10-15T12:00:00+08:00');
  const day = 24 * 60 * 60 * 1000;
  const gateway = fakeGateway({
    liveInventory: [stockRecord('st1', { stockKey: 'XHB8095|棕色|A|36', createdAt: now - 1 * day })],
    product: [
      productRecord('rec_new', { number: 'NEW2026|黑色|A', price: 200, createdAt: now - 1 * day, createdField: '更新日期' }),
    ],
    fieldLists: { product: [{ field_name: '上架日期', type: 1001 }, { field_name: '更新日期', type: 1002 }] },
  });
  const service = createLabelPrintService(gateway, {
    now: () => now,
    // 故意把"创建时间列的字段类型"配成 1002 ⇒ 它就该去认「更新日期」（证明**类型也是配置说了算**）
    config: configWith({ productCreatedTime: { fieldName: '对不上的名字', fieldType: 1002 } }),
  });
  const logs = captureLogs();
  let data;
  try {
    data = await service.listLabels({ recentDays: 7 });
  } finally {
    logs.restore();
  }
  assert.ok(data.labels.some((label) => label.number === 'NEW2026|黑色|A'),
    '换一份 config（fieldType: 1002）⇒ 就按 1002 找到那一列（配置驱动，不是写死在代码里）');
  const renamed = JSON.parse(logs.events('workbench.labels.product_created_time_renamed')[0]);
  assert.equal(renamed.resolved_name, '更新日期');
  assert.equal(renamed.resolved_by, 'field_type');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-N7 如实记录的副作用：扫码打印（labelForRecord）也认没入库的新货
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
  assert.equal((await service.listProductNumbers({})).total, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 路由测试脚手架（沿用 `labelPrintRoute.test.js`：真的 workbench 路由 + 假的标签服务）
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'label_print_products_test_secret';

const sessionCookie = (openId = 'ou_test_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const appFor = (labelPrint) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: { gateway: {}, listOrders: async () => ({ orders: [] }) },
    labelPrint,
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
