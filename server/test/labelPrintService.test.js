/**
 * 鞋盒标签打印 service 的回归护栏（业务负责人 2026-10-08 定案的 **40×30mm 版式改造**，
 * 以及她**看了实物标签之后**的第二次定案：品牌置顶居中 / 货号+颜色第一行 / 价格第二行 / 尺码升序）。
 *
 * 钉住的几件事（brief 里逐条点名的那些）：
 *   ① **尺码按「编号」聚合**：一张标签 = 一个编号（= `货号|颜色|类别`，= 库存键前三段），
 *      尺码那一项 = 该编号下**所有尺码 + 各自数量**（数量 = 这个尺码有几双）；
 *   ② **只印有库存的尺码**（数量 > 0；0 的不印，缺号扫码看）；
 *   ③ **尺码按数值从小到大**（`38` < `40` < `100`；比较方式与方向都来自 `config/labelPrint.js`
 *      的 `sizes.compare` / `sizes.order`）；
 *   ④ 一行放不下自动换行（最多 `maxLines` 行；再超出省略 —— `size_overflow` 让页面补 `…`）；
 *   ⑤ **单价**来自「货品信息.单价」（按编号取）；**读不到照发标签、不印价格并计数**（不许静默丢）；
 *   ⑥ **二维码 URL 来自 `tagQrCode` 的单一真源**：`https://hm.bamamei.online/s/{编号}`，
 *      模板与替换实现都 import 复用，`config/labelPrint.js` 里**一个 URL 都不许有**；
 *   ⑦ **40×30 的每页行列数**由 `resolveGrid()` 算（A4 + 6mm 边距 ⇒ 4 列 × 9 行 = 36 张）；
 *   ⑧ **版式参数（品牌置顶居中 / 右栏行序 / 价格位置 / 货号+颜色同行的超宽规则）随 `layout.body`
 *      下发给页面** —— 渲染层不写死（见 `labelPrintRender.test.js`）；
 *   ⑨ **只读**：网关上只调 `listAll`（两次：实时库存 + 货品信息），create/update/delete 一次都不碰。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const { SCAN_URL } = require('../src/config/tagQrCode');
const {
  createLabelPrintService, buildLabelScanUrl, buildSizeLines, compareSizes, formatPrice, asAmount,
  buildText, asTimestamp,
} = require('../src/services/labelPrintService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const F = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
const P = V1_BITABLE_SCHEMA.tables.product.fields;
const SOURCE_DIR = path.join(__dirname, '../src');

/** 一份只覆盖指定几组的 config（其余沿用 `config/labelPrint.js` 的默认值）。 */
const configWith = (patch = {}) => {
  const merged = { ...LABEL_PRINT };
  for (const [group, value] of Object.entries(patch)) merged[group] = { ...LABEL_PRINT[group], ...value };
  return merged;
};

/** 一条「实时库存」记录（一双一条）。 */
const record = (id, { stockKey, state = '门盒', category, createdAt } = {}) => ({
  record_id: id,
  fields: {
    [F.stockKey]: stockKey,
    [F.state]: state,
    ...(category === undefined ? {} : { [F.category]: category }),
    ...(createdAt === undefined ? {} : { 创建时间: createdAt }),
  },
});

/** 一条「货品信息」记录（编号 / 单价 / 品牌）。 */
const productRecord = (id, { number, price, brand } = {}) => ({
  record_id: id,
  fields: {
    [P.number]: number,
    ...(price === undefined ? {} : { [P.price]: price }),
    ...(brand === undefined ? {} : { 品牌: brand }),
  },
});

/**
 * 只实现 `listAll` 的假网关 —— 顺手钉住"这条链路只读"，并且**只认这两张表**
 * （多读一张表就当场抛错：这条链路的数据来源是被钉死的）。
 */
const fakeGateway = ({ liveInventory = [], product = [] } = {}) => {
  const calls = [];
  return {
    calls,
    async listAll(tableKey) {
      calls.push(tableKey);
      if (tableKey === 'liveInventory') return liveInventory;
      if (tableKey === 'product') return product;
      throw new Error(`鞋盒标签打印只读这两张表，不该读：${tableKey}`);
    },
    create() { throw new Error('鞋盒标签打印是只读功能：不许 create'); },
    update() { throw new Error('鞋盒标签打印是只读功能：不许 update'); },
    delete() { throw new Error('鞋盒标签打印是只读功能：不许 delete'); },
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

// ── ⑤ 二维码 URL：单一真源（config/tagQrCode.js + tagQrCodeService.js）────────

test('二维码内容 = hm 的 /s/{编号}（编号 = 货号|颜色|类别，中文 URL 编码）', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].scan_url,
    'https://hm.bamamei.online/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA');
  // 只编码值、不编码模板：域名与 `/s/` 必须原样在（整体 encodeURIComponent 会把 `://` 编掉）。
  assert.ok(data.labels[0].scan_url.startsWith('https://hm.bamamei.online/s/'));
  assert.equal(data.qr.url_template, SCAN_URL.urlTemplate, '模板来自 tagQrCode 的 SCAN_URL（不是本链路自己抄的）');
  assert.match(data.labels[0].qr_svg, /^<svg /);
  assert.ok(data.labels[0].qr_svg.includes('</svg>'));
});

test('二维码 URL 的单一真源：labelPrint.js 里不许有第二份 URL 模板，service 里只 import 复用', () => {
  // 只看**代码**（注释里会提到"旧的那条已删""新规范长什么样"，那是说明不是真源）。
  const code = sourceOf('config/labelPrint.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/https?:\/\//.test(code),
    'config/labelPrint.js 的代码里不许出现任何 http(s) URL（旧的那条 workbench…/scan?no= 已删，模板唯一真源在 config/tagQrCode.js）');
  assert.ok(!/urlTemplate/.test(code), 'config/labelPrint.js 里不许再放 urlTemplate');

  const service = sourceOf('services/labelPrintService.js');
  assert.match(service, /require\('\.\.\/config\/tagQrCode'\)/, 'service 必须从 config/tagQrCode 取模板');
  assert.match(service, /SCAN_URL\.urlTemplate/, 'service 用的是 SCAN_URL.urlTemplate');
  assert.match(service, /require\('\.\/tagQrCodeService'\)/, 'service 必须复用 tagQrCodeService');
  assert.match(service, /buildScanUrl\(SCAN_URL\.urlTemplate/, '替换实现是 tagQrCodeService 导出的 buildScanUrl');
  // 旧的那条 URL 只许留在"已删除"的说明注释里，**代码里一个字都不许有**。
  const serviceCode = service
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/workbench\.bamamei\.online/.test(serviceCode), '旧的 workbench 扫码 URL 必须删干净');
});

test('复用 tagQrCode 的 buildScanUrl：空编号 / 模板没有 {number} → 当场抛错（不静默出空码）', () => {
  assert.equal(buildLabelScanUrl('XHB8095|黑色|A'),
    'https://hm.bamamei.online/s/XHB8095%7C%E9%BB%91%E8%89%B2%7CA');
  assert.throws(() => buildLabelScanUrl(''), /编号/);
  assert.throws(() => buildLabelScanUrl('   '), /编号/);
});

test('二维码出图参数可配：fields.qr = false → 不出 SVG，但 URL 照样回给她看', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|A|42' })],
  }, { fields: { qr: false } });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].qr_svg, '');
  assert.equal(data.layout.fields.qr, false);
  assert.ok(data.labels[0].scan_url.includes('/s/'));
});

// ── ① 尺码按「编号」聚合 + 数量角标 ────────────────────────────────────────

test('尺码按编号聚合：同一编号的多个尺码 / 多双合成**一张**标签，数量 = 这个尺码有几双', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'YD6693-2|黑色|A|38' }),
      record('r2', { stockKey: 'YD6693-2|黑色|A|39' }),
      record('r3', { stockKey: 'YD6693-2|黑色|A|39' }),
      record('r4', { stockKey: 'YD6693-2|黑色|A|40' }),
    ],
  });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 1, '一个编号 = 一张标签（不再是"一双一张"）');
  assert.equal(data.total_pairs, 4, '同一个编号下 4 双库存');
  const label = data.labels[0];
  assert.equal(label.key, 'YD6693-2|黑色|A', '标签的唯一键 = 编号');
  assert.equal(label.number, 'YD6693-2|黑色|A');
  assert.deepEqual(label.sizes, [
    { size: 38, qty: 1 }, { size: 39, qty: 2 }, { size: 40, qty: 1 },
  ], '尺码升序、每个尺码带数量');
  assert.equal(label.total_qty, 4);
  assert.deepEqual(label.size_lines, [[
    { size: 38, qty: 1 }, { size: 39, qty: 2 }, { size: 40, qty: 1 },
  ]], '一行放得下 ⇒ 只有一行');
  assert.equal(label.size_overflow, false);
  assert.deepEqual(label.record_ids, ['r1', 'r2', 'r3', 'r4'], '这一个编号是由哪几条库存聚合的（排障用）');
});

test('同款同码多双**不再印多张**：两条一模一样的库存 ⇒ 一张标签 + 角标 2', async () => {
  const same = { stockKey: 'XHB8095|黑色|A|42' };
  const { service } = serviceFor({ liveInventory: [record('r1', same), record('r2', same)] });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 1);
  assert.equal(data.labels.length, 1);
  assert.deepEqual(data.labels[0].size_lines, [[{ size: 42, qty: 2 }]]);
  assert.equal(data.total_pairs, 2);
});

test('不同类别 / 颜色 = 不同编号 ⇒ 各出各的标签（编号里的三段都参与）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'XHB8095|黑色|A|42' }),
      record('r2', { stockKey: 'XHB8095|米白|A|42' }),
      record('r3', { stockKey: 'XHB8095|黑色|B|42' }),
    ],
  });
  const data = await service.listLabels({});
  assert.deepEqual(data.labels.map((label) => label.key),
    ['XHB8095|黑色|A', 'XHB8095|黑色|B', 'XHB8095|米白|A'], '货架顺序：货号 → 颜色 → 类别');
});

// ── ② 只印有库存的尺码 ───────────────────────────────────────────────────

test('只印有库存的尺码：没有库存条目的尺码不出现在标签上（0 的不印，缺号扫码看）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'YD6693-2|黑色|A|38' }),
      record('r2', { stockKey: 'YD6693-2|黑色|A|40' }),
      // 39 / 41 / 42… 一双都没有 ⇒ 标签上就不该有它们。
    ],
  });
  const data = await service.listLabels({});
  assert.deepEqual(data.labels[0].sizes.map((item) => item.size), [38, 40]);
});

// ── ③-2 尺码**按数值从小到大**（她 2026-10-08 定案：「按照从小到大排序」）──────────────────

test('尺码按数值升序：38 < 40 < 100（**不是字符串序** —— 字符串序会把 100 排到 38 前面）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'YD6693-2|黑色|A|100' }),
      record('r2', { stockKey: 'YD6693-2|黑色|A|38' }),
      record('r3', { stockKey: 'YD6693-2|黑色|A|40' }),
      record('r4', { stockKey: 'YD6693-2|黑色|A|40' }),
    ],
  });
  const data = await service.listLabels({});
  const label = data.labels[0];
  assert.deepEqual(label.sizes, [
    { size: 38, qty: 1 }, { size: 40, qty: 2 }, { size: 100, qty: 1 },
  ], '数值升序，数量跟着尺码走');
  assert.deepEqual(label.size_lines.map((line) => line.map((token) => token.size)), [[38, 40, 100]],
    '分行用的也是这个顺序');
});

test('尺码排序可配：`sizes.order` 倒序 / `sizes.compare` 文本序（只改 config，不改代码）', async () => {
  const liveInventory = [38, 40, 100].map((size, index) => record(`r${index}`, { stockKey: `A1|黑色|A|${size}` }));
  const { service: desc } = serviceFor({ liveInventory }, { sizes: { order: 'desc' } });
  assert.deepEqual((await desc.listLabels({})).labels[0].sizes.map((item) => item.size), [100, 40, 38]);

  const { service: asText } = serviceFor({ liveInventory }, { sizes: { compare: 'string' } });
  assert.deepEqual((await asText.listLabels({})).labels[0].sizes.map((item) => item.size), [100, 38, 40],
    '文本序："100" < "38" < "40"（留着这个开关是为了 S/M/L 这类非数字尺码）');
});

test('compareSizes：纯函数，默认数值升序；读不出数字时退化成文本比较（不产出 NaN）', () => {
  assert.ok(compareSizes(38, 100, {}) < 0, '默认按数值：38 在 100 前面');
  assert.ok(compareSizes('38', '100', {}) < 0, '字符串数字也按数值比');
  assert.equal(compareSizes(42, 42, {}), 0);
  assert.ok(compareSizes(38, 100, { order: 'desc' }) > 0);
  assert.ok(compareSizes('38', '100', { compare: 'string' }) > 0, '文本序："38" > "100"');
  assert.ok(Number.isFinite(compareSizes('不是数字', '也不是', {})), '读不出数字时不许返回 NaN');
});

test('版式参数随响应下发：品牌**顶部居中** + 右栏行序「货号+颜色 → 单价 → 尺码」都在 layout.body 里', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.layout.body.brandRow, 'top', '品牌在整张标签顶部（她定案）');
  assert.equal(data.layout.body.brandAlign, 'center', '顶部居中');
  assert.deepEqual(data.layout.body.rows, ['brand', 'itemNoColor', 'price', 'state', 'sizes'],
    '右栏行序：货号+颜色 → 单价 → 尺码（状态那行默认不印）');
  assert.equal(data.layout.body.itemNoColor.preferColorOverCategory, true, '放不下时优先保颜色');
  assert.equal(data.layout.body.itemNoColor.minItemNoMm, 2.4, '货号缩字号的下限也在 config 里');
  assert.equal(data.layout.sizes.order, 'asc');
  assert.equal(data.layout.sizes.compare, 'numeric');

  // 换一份 config（倒序 + 不保颜色 + 品牌回右栏）⇒ 响应里的 layout 跟着变。
  const { service: custom } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  }, {
    body: {
      rows: ['itemNoColor', 'price', 'sizes'],
      brandRow: 'inline',
      brandAlign: 'left',
      itemNoColor: { ...LABEL_PRINT.body.itemNoColor, preferColorOverCategory: false },
    },
    sizes: { order: 'desc' },
  });
  const customData = await custom.listLabels({});
  assert.equal(customData.layout.body.brandRow, 'inline');
  assert.deepEqual(customData.layout.body.rows, ['itemNoColor', 'price', 'sizes']);
  assert.equal(customData.layout.body.itemNoColor.preferColorOverCategory, false);
  assert.equal(customData.layout.sizes.order, 'desc');
});

// ── ③ 换行（最多两行，超出留 …）────────────────────────────────────────────

test('换行：一行 3 个、最多两行 ⇒ 7 个尺码排成 3 + 3，剩下 1 个被省略（size_overflow）', async () => {
  const liveInventory = [38, 39, 40, 41, 42, 43, 44].map((size, index) => record(`r${index}`, { stockKey: `YD6693-2|黑色|A|${size}` }));
  const { service } = serviceFor({ liveInventory });
  const data = await service.listLabels({});
  const label = data.labels[0];
  assert.equal(label.sizes.length, 7, '数据里 7 个尺码一个不少（省略只发生在"怎么排"上）');
  assert.deepEqual(label.size_lines.map((line) => line.map((token) => token.size)), [[38, 39, 40], [41, 42, 43]]);
  assert.equal(label.size_overflow, true, '还有尺码没排上 ⇒ 页面在最后一行尾上补 …');
});

test('换行：正好两行排满（6 个）⇒ 不省略；一行放得下（3 个）⇒ 只有一行', async () => {
  const six = [38, 39, 40, 41, 42, 43].map((size, index) => record(`r${index}`, { stockKey: `A1|黑色|A|${size}` }));
  const { service: service6 } = serviceFor({ liveInventory: six });
  const data6 = await service6.listLabels({});
  assert.equal(data6.labels[0].size_lines.length, 2);
  assert.equal(data6.labels[0].size_overflow, false);

  const { service: service3 } = serviceFor({ liveInventory: six.slice(0, 3) });
  const data3 = await service3.listLabels({});
  assert.equal(data3.labels[0].size_lines.length, 1);
});

test('换行：每行几个 / 最多几行都来自 config（改成 2 个一行、只允许一行 ⇒ 2 + 省略）', async () => {
  const liveInventory = [38, 39, 40, 41].map((size, index) => record(`r${index}`, { stockKey: `A1|黑色|A|${size}` }));
  const { service } = serviceFor({ liveInventory }, { sizes: { perLine: 2, maxLines: 1 } });
  const data = await service.listLabels({});
  assert.deepEqual(data.labels[0].size_lines.map((line) => line.map((token) => token.size)), [[38, 39]]);
  assert.equal(data.labels[0].size_overflow, true);
  assert.equal(data.layout.sizes.perLine, 2, '页面拿到的也是 config 里的值');
});

test('buildSizeLines：纯函数，按 perLine / maxLines 切行并报 overflow', () => {
  const sizes = [1, 2, 3, 4, 5].map((size) => ({ size, qty: 1 }));
  assert.deepEqual(buildSizeLines(sizes, { perLine: 2, maxLines: 2 }),
    { lines: [[sizes[0], sizes[1]], [sizes[2], sizes[3]]], overflow: true });
  assert.deepEqual(buildSizeLines(sizes, { perLine: 5, maxLines: 2 }),
    { lines: [sizes], overflow: false });
  assert.deepEqual(buildSizeLines([], {}), { lines: [], overflow: false });
});

// ── ④ 单价（货品信息.单价，按编号取）──────────────────────────────────────

test('单价：按编号从「货品信息.单价」取，印成 ¥399（整数不补零）', async () => {
  const { gateway, service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
    product: [productRecord('p1', { number: 'YD6693-2|黑色|A', price: 399 })],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].price, 399);
  assert.equal(data.labels[0].price_text, '¥399');
  assert.equal(data.missing_price, 0);
  assert.deepEqual(gateway.calls, ['liveInventory', 'product'], '只读这两张表');
});

test('单价读不到：**照发标签**、不印价格、计数提示（不许静默丢标签）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'YD6693-2|黑色|A|38' }),
      record('r2', { stockKey: 'XHB8095|米白|B|42' }),
    ],
    // 货品信息里**没有** XHB8095|米白|B 这条（价格缺失的第一种原因）
    product: [productRecord('p1', { number: 'YD6693-2|黑色|A', price: 399 })],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels.length, 2, '两条标签都要发出来（一条都不许丢）');
  const missing = data.labels.find((label) => label.key === 'XHB8095|米白|B');
  assert.equal(missing.price, null);
  assert.equal(missing.price_text, '');
  assert.equal(data.missing_price, 1);
  assert.equal(data.missing_price_no_product, 1, '连「货品信息」里那条记录都没读到');
  assert.equal(data.labels.find((label) => label.key === 'YD6693-2|黑色|A').price_text, '¥399');
});

test('单价是空的另一条路：货品记录在、但「单价」没填 ⇒ 同样计数（不算 no_product）', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
    product: [productRecord('p1', { number: 'YD6693-2|黑色|A' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.missing_price, 1);
  assert.equal(data.missing_price_no_product, 0);
  assert.equal(data.labels[0].price_text, '');
});

test('关掉价格印字（fields.price = false）⇒ 不印也不报缺（她没要价格时不该刷提示）', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  }, { fields: { price: false } });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].price_text, '');
  assert.equal(data.missing_price, 0);
});

test('价格格式 / 解析：¥399 不补零、角分保留、货币符号可配；解析读不出来回 null（不猜 0）', () => {
  assert.equal(formatPrice(399, { prefix: '¥', decimals: 2 }), '¥399');
  assert.equal(formatPrice(399.5, { prefix: '¥', decimals: 2 }), '¥399.5');
  assert.equal(formatPrice(399.99, { prefix: '¥', decimals: 2 }), '¥399.99');
  assert.equal(formatPrice(399, { prefix: '￥', decimals: 0 }), '￥399');
  assert.equal(formatPrice(null, { prefix: '¥' }), '');
  assert.equal(asAmount(399), 399);
  assert.equal(asAmount('¥399'), 399);
  assert.equal(asAmount([{ text: '399' }]), 399);
  assert.equal(asAmount(0), 0, '0 是一个真实价格，不是"没有价格"');
  assert.equal(asAmount(''), null);
  assert.equal(asAmount('没填'), null);
});

// ── 品牌（默认配置里的「邯美皮鞋」，可切成从表里取）─────────────────────────

test('品牌：默认用 config 里的文字（即使表里有「品牌」列也不动它）', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
    product: [productRecord('p1', { number: 'YD6693-2|黑色|A', price: 399, brand: '别的牌子' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].brand_text, '邯美皮鞋');
  assert.equal(data.layout.fields.brand, true);
});

test('品牌：from = table 时优先取「货品信息」的列，读不到再回落 config 的文字', async () => {
  const patch = { brand: { from: 'table', text: '邯美皮鞋', tableFieldName: '品牌' } };
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'YD6693-2|黑色|A|38' }),
      record('r2', { stockKey: 'XHB8095|米白|B|42' }),
    ],
    product: [productRecord('p1', { number: 'YD6693-2|黑色|A', brand: '邯美' })],
  }, patch);
  const data = await service.listLabels({});
  assert.equal(data.labels.find((label) => label.key === 'YD6693-2|黑色|A').brand_text, '邯美');
  assert.equal(data.labels.find((label) => label.key === 'XHB8095|米白|B').brand_text, '邯美皮鞋',
    '表里读不到就回落配置里的文字（不留空）');
});

test('品牌可以整个关掉：fields.brand = false ⇒ 标签上没有品牌文字', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  }, { fields: { brand: false } });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].brand_text, '');
  assert.equal(data.layout.fields.brand, false);
});

// ── ⑥ 40×30 的每页行列数 ─────────────────────────────────────────────────

test('40×30mm：A4 + 6mm 边距 ⇒ 4 列 × 9 行 = 每页 36 张（自动算，不写死）', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.layout.label.widthMm, 40);
  assert.equal(data.layout.label.heightMm, 30);
  assert.equal(data.layout.typography.qrSizeMm, 15, '二维码 15×15mm（她定案的）');
  assert.deepEqual(
    { columns: data.layout.grid.columns, rows: data.layout.grid.rows, perPage: data.layout.grid.perPage },
    { columns: 4, rows: 9, perPage: 36 },
  );
  assert.equal(data.layout.grid.usableWidthMm, 198);
  assert.equal(data.layout.sizes.perLine, 3, '每行几个尺码也是 config 里的值');
});

test('尺寸 / 字号 / 字段开关全部来自 config：换一份 config，响应里的 layout 跟着变', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'YD6693-2|黑色|A|38' })],
  }, {
    label: { widthMm: 40, heightMm: 20 },
    // 边距收到 5mm ⇒ 可用 200×287mm（40mm 一行 5 张、20mm 一列 14 行）。
    page: { name: 'A4', widthMm: 210, heightMm: 297, marginMm: { top: 5, right: 5, bottom: 5, left: 5 } },
    typography: { itemNoMm: 4.2, brandMm: 2, fieldMm: 2.2, sizeMm: 2.2, priceMm: 3, footerMm: 1.5, qrSizeMm: 12 },
    fields: { category: false },
  });
  const data = await service.listLabels({});
  assert.equal(data.layout.label.heightMm, 20);
  assert.equal(data.layout.typography.itemNoMm, 4.2);
  assert.equal(data.layout.typography.qrSizeMm, 12);
  assert.equal(data.layout.fields.category, false);
  assert.equal(data.layout.fields.itemNo, true);
  // 200×287 可用 ⇒ 40mm 一行 5 张、20mm 一列 14 行（自动算）。
  assert.equal(data.layout.grid.columns, 5);
  assert.equal(data.layout.grid.rows, 14);
});

// ── 字段映射 ─────────────────────────────────────────────────────────────

test('字段映射：库存键 → 货号/颜色/类别/尺码；标签上印的「品类」取「实时库存.品类」公式列', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|A|42', category: '休闲鞋', state: '样品' })],
  });
  const data = await service.listLabels({});
  const label = data.labels[0];
  assert.equal(label.item_no, 'XHB8095');
  assert.equal(label.color, '黑色');
  assert.equal(label.category, '休闲鞋', '标签上"颜色 · 品类"印的是品类（打样图：黑色 · 休闲鞋）');
  assert.equal(label.category_code, 'A', '编号里那一段是「类别」（A/B）');
  assert.equal(label.number, 'XHB8095|黑色|A', '编号 = 货号|颜色|类别');
  assert.equal(label.states[0], '样品');
});

test('品类读不到时回落库存键第 3 段（不留空）；所属状态默认不印但仍在数据里', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].category, '休闲鞋');
  assert.equal(data.labels[0].category_code, '休闲鞋', '库存键第 3 段是什么就是什么（编号跟着它走）');
  assert.equal(data.labels[0].state_text, '门盒');
  assert.equal(data.layout.fields.state, false, '所属状态默认不印（打样图上没有这一项）');
});

test('同一编号下多个状态：数量合并打印，状态清单留给她（排序按 config 的状态顺序）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'A1|黑色|A|42', state: '仓库' }),
      record('r2', { stockKey: 'A1|黑色|A|42', state: '门盒' }),
      record('r3', { stockKey: 'A1|黑色|A|42', state: '样品' }),
    ],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels.length, 1);
  assert.deepEqual(data.labels[0].size_lines, [[{ size: 42, qty: 3 }]], '三个状态的三双都算进数量');
  assert.deepEqual(data.labels[0].states, ['门盒', '样品', '仓库']);
  assert.equal(data.labels[0].state_text, '门盒/样品/仓库');
});

test('读不出来的记录（库存键不是四段 / 所属状态为空）→ 跳过并计数，不猜、不静默', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('ok', { stockKey: 'XHB8095|黑色|A|42' }),
      record('bad-key', { stockKey: 'XHB8095|黑色' }),
      record('no-state', { stockKey: 'YD6693|米白|A|38', state: '' }),
    ],
  });
  const data = await service.listLabels({});
  assert.equal(data.total_returned, 1);
  assert.deepEqual(data.skipped_records, { stock_key: 1, state: 1, total: 2 });
});

// ── ⑦ 只读 ───────────────────────────────────────────────────────────────

test('只读：整条链路只调 gateway.listAll（实时库存 + 货品信息），没有任何写入路径', async () => {
  const { gateway, service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|A|42' })],
  });
  await service.listLabels({});
  // 假网关的 create/update/delete 直接抛错 ⇒ 只要被调到这条用例就红。
  assert.deepEqual(gateway.calls, ['liveInventory', 'product']);
  const code = sourceOf('services/labelPrintService.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['.create(', '.update(', '.delete(', 'applyChange', 'transitionState']) {
    assert.ok(!code.includes(forbidden), `只读功能里不许出现 ${forbidden}`);
  }
});

// ── 筛选 / 排序 / 截断 / 不静默 ───────────────────────────────────────────

test('筛选：货号关键字 / 所属状态 / 品类 / 尺码 都能单独与组合使用（按编号聚合之后）', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'XHB8095|黑色|A|42', state: '门盒' }),
      record('r2', { stockKey: 'XHB8095|黑色|A|43', state: '仓库' }),
      record('r3', { stockKey: 'YD6693|米白|A|38', state: '门盒' }),
    ],
  });
  assert.equal((await service.listLabels({ keyword: 'xhb8095' })).total_matched, 1, '关键字大小写不敏感');
  assert.equal((await service.listLabels({ keyword: '米白' })).total_matched, 1);
  assert.equal((await service.listLabels({ state: '门盒' })).total_matched, 2);
  assert.equal((await service.listLabels({ category: '单鞋' })).total_matched, 0, '品类按「品类」列/键第 3 段比');
  assert.equal((await service.listLabels({ size: '43' })).total_matched, 1, '尺码筛选：只印这个尺码');
  const bySize = await service.listLabels({ size: 43 });
  assert.deepEqual(bySize.labels[0].size_lines, [[{ size: 43, qty: 1 }]], '筛了尺码就只印那个尺码');
  assert.equal((await service.listLabels({ state: '门盒', size: 42, keyword: 'XHB' })).total_matched, 1);
});

test('品类候选来自同一份数据：filters.category_options 去重排序，且不随筛选条件变少', async () => {
  const { gateway, service } = serviceFor({
    liveInventory: [
      record('r1', { stockKey: 'XHB8095|黑色|A|42', category: '休闲鞋' }),
      record('r2', { stockKey: 'YD6693|米白|A|38', category: '单鞋' }),
      record('r3', { stockKey: 'YD6693|米白|A|39', category: '单鞋' }),
    ],
  });
  const all = await service.listLabels({});
  assert.deepEqual(all.filters.category_options, ['单鞋', '休闲鞋'], '去重 + 按中文排序');
  const filtered = await service.listLabels({ state: '门盒' });
  assert.deepEqual(filtered.filters.category_options, ['单鞋', '休闲鞋'],
    '候选在筛选之前算出来 —— 她越筛，下拉里可选的品类不会越来越少');
  assert.deepEqual(gateway.calls, ['liveInventory', 'product', 'liveInventory', 'product']);
});

test('筛选：尺码不是整数 / 排序方式不认识 / 最近新增太大 → 400（原样告诉她哪里填错）', async () => {
  const { service } = serviceFor({});
  await assert.rejects(() => service.listLabels({ size: '42码' }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.listLabels({ sort: '按价格' }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.listLabels({ recentDays: '9999' }), (error) => error.statusCode === 400);
});

test('「最近新增」：按「创建时间」筛 + 倒序；读不到创建时间时**报错**，不静默当成没筛', async () => {
  const now = Date.parse('2026-10-08T12:00:00+08:00');
  const records = [
    record('old', { stockKey: 'A1|黑色|A|41', createdAt: now - 10 * 24 * 3600 * 1000 }),
    record('new', { stockKey: 'A2|黑色|A|41', createdAt: now - 2 * 3600 * 1000 }),
  ];
  const gateway = fakeGateway({ liveInventory: records });
  const service = createLabelPrintService(gateway, { now: () => now });
  const data = await service.listLabels({ recentDays: 1, sort: 'recent' });
  assert.equal(data.total_matched, 1);
  assert.equal(data.labels[0].key, 'A2|黑色|A');
  assert.ok(data.labels[0].created_at, '创建时间原样回给页面（排障用）');

  const noCreated = createLabelPrintService(fakeGateway({
    liveInventory: [record('r1', { stockKey: 'A1|黑色|A|41' })],
  }), { now: () => now });
  await assert.rejects(() => noCreated.listLabels({ recentDays: 7 }), /创建时间/);
});

test('截断不静默：匹配超过上限时回 truncated + total_matched，labels 只给前 N 张', async () => {
  const liveInventory = Array.from({ length: 5 }, (unused, index) => record(`r${index}`, { stockKey: `A${index}|黑色|A|41` }));
  const { service } = serviceFor({ liveInventory }, { limits: { maxLabels: 3 } });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 5);
  assert.equal(data.total_returned, 3);
  assert.equal(data.truncated, true);
  assert.equal(data.max_labels, 3);
  assert.equal(data.total_pairs, 5, '被截断的编号的库存双数仍算在总数里（她要对得上账）');
});

test('排序：货架顺序默认 货号 → 颜色 → 类别', async () => {
  const { service } = serviceFor({
    liveInventory: [
      record('warehouse', { stockKey: 'B1|黑色|A|41', state: '仓库' }),
      record('door', { stockKey: 'B1|黑色|A|41', state: '门盒' }),
      record('other-item', { stockKey: 'A9|黑色|A|45', state: '门盒' }),
      record('other-color', { stockKey: 'A9|米白|A|45', state: '门盒' }),
    ],
  });
  const data = await service.listLabels({});
  assert.deepEqual(data.labels.map((label) => label.key),
    ['A9|黑色|A', 'A9|米白|A', 'B1|黑色|A']);
});

// ── 空结果 / 文案 / 工具函数 ──────────────────────────────────────────────

test('空结果不炸：没有匹配时回 200 + 空 labels + total_matched/total_pairs: 0', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|A|42' })],
  });
  const data = await service.listLabels({ keyword: '不存在的货号' });
  assert.equal(data.total_matched, 0);
  assert.equal(data.total_pairs, 0);
  assert.deepEqual(data.labels, []);
  assert.equal(data.truncated, false);
  assert.equal(data.missing_price, 0);
  assert.deepEqual(data.skipped_records, { stock_key: 0, state: 0, total: 0 });
});

test('空表也不炸（一张实时库存都没有）', async () => {
  const { service } = serviceFor({});
  const data = await service.listLabels({});
  assert.deepEqual(data.labels, []);
  assert.equal(data.total_matched, 0);
});

test('底部小字默认 = 编号（默认不印，开关打开才印）；占位符写错当场抛错', async () => {
  const { service } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|A|42' })],
  });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].footer_text, 'XHB8095|黑色|A');
  assert.equal(data.layout.fields.footer, false, '底部小字默认不印（打样图上没有）');

  const { service: withFooter } = serviceFor({
    liveInventory: [record('r1', { stockKey: 'XHB8095|黑色|A|42' })],
  }, { fields: { footer: true }, footer: { template: '{itemNo}|{color}|{category}|{sizes}|{totalQty}|{price}' } });
  const withText = await withFooter.listLabels({});
  assert.equal(withText.labels[0].footer_text, 'XHB8095|黑色|A|42×1|1|—');

  assert.equal(buildText('{itemNo}|{color}|{size}', { itemNo: 'A1', color: '', size: 42 }, '—'), 'A1|—|42');
  assert.throws(() => buildText('{nope}', {}, '—'), /占位符不认识/);
});

test('时间字段解析：毫秒数 / [毫秒] / 可解析字符串都认，其余回 0（不猜）', () => {
  assert.equal(asTimestamp(1759900000000), 1759900000000);
  assert.equal(asTimestamp([1759900000000]), 1759900000000);
  assert.equal(asTimestamp('2026-10-08T04:00:00.000Z'), Date.parse('2026-10-08T04:00:00.000Z'));
  assert.equal(asTimestamp('不是时间'), 0);
  assert.equal(asTimestamp(undefined), 0);
});
