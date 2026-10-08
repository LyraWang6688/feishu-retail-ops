/**
 * 鞋盒标签打印 service 的回归护栏（业务负责人 2026-10-08 批准的第一个功能）。
 *
 * 钉住的几件事（brief 里逐条点名的那些）：
 *   ① **二维码 URL 的编码**：模板里的值必须 URL 编码（中文颜色、带 `&` 的货号），
 *      而模板自身的 `?` `=` `&` 不许被编码；占位符写错要**当场报错**，不许静默出空码。
 *   ② **字段映射**：一条「实时库存」= 一张标签，货号/颜色/类别/尺码来自「库存键」四段、
 *      所属状态来自 `liveInventory.state`（不猜、不另读三张关联表）。
 *   ③ **同款同码出多张**：两条「库存键」相同的记录 ⇒ **两张**标签（设计如此）。
 *   ④ **空结果不炸**：没有匹配 → 200 + labels: []（不是异常）。
 *   ⑤ **尺寸来自 config**：换一份 config（40×20mm、关掉类别）→ 响应里的 layout 跟着变。
 *   ⑥ **只读**：网关上**只调 listAll**，create/update/delete 一次都不碰。
 *   ⑦ 截断 / 跳过 / 读不到创建时间 —— 都不静默（响应或异常里说得清）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { LABEL_PRINT } = require('../src/config/labelPrint');
const {
  createLabelPrintService, buildScanUrl, buildText, asTimestamp,
} = require('../src/services/labelPrintService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const F = V1_BITABLE_SCHEMA.tables.liveInventory.fields;

/** 一份只覆盖指定几组的 config（其余沿用 `config/labelPrint.js` 的默认值）。 */
const configWith = (patch = {}) => {
  const merged = { ...LABEL_PRINT };
  for (const [group, value] of Object.entries(patch)) merged[group] = { ...LABEL_PRINT[group], ...value };
  return merged;
};

const record = (id, { stockKey, state = '门盒', createdAt } = {}) => ({
  record_id: id,
  fields: {
    [F.stockKey]: stockKey,
    [F.state]: state,
    ...(createdAt === undefined ? {} : { 创建时间: createdAt }),
  },
});

/** 只实现 listAll 的假网关 —— 顺手钉住"这条链路只读"。 */
const fakeGateway = (records) => {
  const calls = [];
  return {
    calls,
    async listAll(tableKey) { calls.push(tableKey); return records; },
    create() { throw new Error('鞋盒标签打印是只读功能：不许 create'); },
    update() { throw new Error('鞋盒标签打印是只读功能：不许 update'); },
    delete() { throw new Error('鞋盒标签打印是只读功能：不许 delete'); },
  };
};

const serviceFor = (records, patch) => {
  const gateway = fakeGateway(records);
  return { gateway, service: createLabelPrintService(gateway, patch ? { config: configWith(patch) } : {}) };
};

// ── ① 二维码 URL ─────────────────────────────────────────────────────────

test('二维码 URL：模板里的值 URL 编码、模板自身的 ? = & 不动（中文颜色 / 特殊字符货号）', () => {
  const url = buildScanUrl('https://workbench.bamamei.online/scan?no={itemNo}&size={size}&color={color}', {
    itemNo: 'XH&B 80/95', size: 42, color: '黑色',
  });
  assert.equal(url,
    'https://workbench.bamamei.online/scan?no=XH%26B%2080%2F95&size=42&color=%E9%BB%91%E8%89%B2');
  // 逐条再确认：`?` `=` `&` 必须还在（编码整个 URL 是最容易犯的错）。
  assert.ok(url.includes('?no='));
  assert.ok(url.includes('&size=42&color='));
});

test('二维码 URL：模板里出现不认识的占位符 → 当场报错，不静默生成空码', () => {
  assert.throws(() => buildScanUrl('https://x/scan?no={itemno}', { itemNo: 'A' }),
    /占位符不认识：\{itemno\}/);
});

test('二维码内容是一张能扫的 URL：默认指向工作台将来的 /scan 页面（现在 404 是预期）', async () => {
  const { service } = serviceFor([record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42' })]);
  const data = await service.listLabels({});
  assert.equal(data.labels[0].scan_url,
    'https://workbench.bamamei.online/scan?no=XHB8095&size=42&color=%E9%BB%91%E8%89%B2');
  assert.equal(data.qr.url_template, LABEL_PRINT.qr.urlTemplate);
  assert.match(data.labels[0].qr_svg, /^<svg /);
  assert.ok(data.labels[0].qr_svg.includes('</svg>'));
});

// ── ② 字段映射 ───────────────────────────────────────────────────────────

test('字段映射：库存键 → 货号/颜色/类别/尺码，所属状态来自实时库存的「所属状态」列', async () => {
  const { gateway, service } = serviceFor([
    record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42', state: '样品' }),
  ]);
  const data = await service.listLabels({});
  const label = data.labels[0];
  assert.equal(label.item_no, 'XHB8095');
  assert.equal(label.color, '黑色');
  assert.equal(label.category, '休闲鞋');
  assert.equal(label.size, 42);
  assert.equal(label.size_text, '42码', '尺码那格印的文字带 config 里的后缀');
  assert.equal(label.state, '样品');
  assert.equal(label.stock_key, 'XHB8095|黑色|休闲鞋|42');
  assert.equal(label.key, 'r1', '一张标签一个唯一键 = 一条实时库存记录');
  assert.equal(label.footer_text, 'XHB8095|黑色|休闲鞋|42',
    '底部小字默认 = 库存键那四段（货号|颜色|类别|尺码），与打样图一致');
  assert.deepEqual(gateway.calls, ['liveInventory'], '只读一次「实时库存」（不读货品/尺码/颜色三张表）');
});

test('字段映射：库存键里类别为空时，回落到「品类」公式列（零额外请求）', async () => {
  const records = [{ record_id: 'r1', fields: { [F.stockKey]: 'XHB8095|黑色||42', [F.state]: '门盒', [F.category]: '休闲鞋' } }];
  const { service } = serviceFor(records);
  const data = await service.listLabels({});
  assert.equal(data.labels[0].category, '休闲鞋');
});

test('读不出来的记录（库存键不是四段 / 所属状态为空）→ 跳过并计数，不猜、不静默', async () => {
  const { service } = serviceFor([
    record('ok', { stockKey: 'XHB8095|黑色|休闲鞋|42' }),
    record('bad-key', { stockKey: 'XHB8095|黑色' }),
    record('no-state', { stockKey: 'YD6693|米白|单鞋|38', state: '' }),
  ]);
  const data = await service.listLabels({});
  assert.equal(data.total_returned, 1);
  assert.deepEqual(data.skipped_records, { stock_key: 1, state: 1, total: 2 });
});

// ── ③ 同款同码多双 ⇒ 多张 ─────────────────────────────────────────────────

test('同款同码出多张：两条库存键相同的记录 ⇒ 两张标签（扫码后由 /scan 列出这几双）', async () => {
  const same = { stockKey: 'XHB8095|黑色|休闲鞋|42', state: '门盒' };
  const { service } = serviceFor([record('r1', same), record('r2', same)]);
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 2);
  assert.equal(data.labels.length, 2);
  assert.deepEqual(data.labels.map((label) => label.key), ['r1', 'r2'], '两张标签各自对应一条库存记录');
  assert.equal(data.labels[0].scan_url, data.labels[1].scan_url, '同款同码扫出来的 URL 一样（设计如此）');
  assert.notEqual(data.labels[0].qr_svg, '', '两张都要有二维码');
});

// ── ④ 空结果 ─────────────────────────────────────────────────────────────

test('空结果不炸：没有匹配时回 200 + 空 labels + total_matched: 0', async () => {
  const { service } = serviceFor([record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42' })]);
  const data = await service.listLabels({ keyword: '不存在的货号' });
  assert.equal(data.total_matched, 0);
  assert.deepEqual(data.labels, []);
  assert.equal(data.truncated, false);
  assert.deepEqual(data.skipped_records, { stock_key: 0, state: 0, total: 0 });
});

test('空表也不炸（一张实时库存都没有）', async () => {
  const { service } = serviceFor([]);
  const data = await service.listLabels({});
  assert.deepEqual(data.labels, []);
  assert.equal(data.total_matched, 0);
});

// ── ⑤ 尺寸 / 字段开关来自 config ─────────────────────────────────────────

test('尺寸来自 config：换一份 40×20mm、关掉类别的 config → 响应的 layout 跟着变', async () => {
  const { service } = serviceFor([record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42' })], {
    label: { widthMm: 40, heightMm: 20 },
    page: { name: 'A4', widthMm: 210, heightMm: 297, marginMm: { top: 5, right: 5, bottom: 5, left: 5 } },
    typography: { itemNoMm: 5, fieldMm: 2.2, footerMm: 1.5, qrSizeMm: 15 },
    fields: { category: false },
  });
  const data = await service.listLabels({});
  assert.equal(data.layout.label.widthMm, 40);
  assert.equal(data.layout.label.heightMm, 20);
  assert.equal(data.layout.typography.itemNoMm, 5);
  assert.equal(data.layout.fields.category, false);
  assert.equal(data.layout.fields.itemNo, true);
  // 200×287 可用 ⇒ 40mm 一行 5 张、20mm 一列 14 行（自动算，不写死）。
  assert.equal(data.layout.grid.columns, 5);
  assert.equal(data.layout.grid.rows, 14);
  assert.equal(data.layout.grid.perPage, 70);
});

test('字段开关能关掉二维码：fields.qr = false → 不出 SVG', async () => {
  const { service } = serviceFor([record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42' })], { fields: { qr: false } });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].qr_svg, '');
  assert.equal(data.layout.fields.qr, false);
});

test('二维码 URL 模板可配：换域名 / 换参数名都只改 config', async () => {
  const { service } = serviceFor([record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42', state: '仓库' })], {
    qr: { urlTemplate: 'https://example.test/s?code={stockKey}&st={state}' },
  });
  const data = await service.listLabels({});
  assert.equal(data.labels[0].scan_url,
    'https://example.test/s?code=XHB8095%7C%E9%BB%91%E8%89%B2%7C%E4%BC%91%E9%97%B2%E9%9E%8B%7C42&st=%E4%BB%93%E5%BA%93');
});

// ── ⑥ 只读 ───────────────────────────────────────────────────────────────

test('只读：整条链路只调 gateway.listAll，没有任何写入路径', async () => {
  const { gateway, service } = serviceFor([record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42' })]);
  await service.listLabels({});
  // 假网关的 create/update/delete 直接抛错 ⇒ 只要被调到这条用例就红。
  assert.deepEqual(gateway.calls, ['liveInventory']);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/services/labelPrintService.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const forbidden of ['.create(', '.update(', '.delete(', 'applyChange', 'transitionState']) {
    assert.ok(!code.includes(forbidden), `只读功能里不许出现 ${forbidden}`);
  }
});

// ── ⑦ 筛选 / 截断 / 不静默 ───────────────────────────────────────────────

test('筛选：货号关键字 / 所属状态 / 类别 / 尺码 都能单独与组合使用', async () => {
  const { service } = serviceFor([
    record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42', state: '门盒' }),
    record('r2', { stockKey: 'XHB8095|黑色|休闲鞋|43', state: '仓库' }),
    record('r3', { stockKey: 'YD6693|米白|单鞋|38', state: '门盒' }),
  ]);
  assert.equal((await service.listLabels({ keyword: 'xhb8095' })).total_matched, 2, '关键字大小写不敏感');
  assert.equal((await service.listLabels({ keyword: '米白' })).total_matched, 1);
  assert.equal((await service.listLabels({ state: '门盒' })).total_matched, 2);
  assert.equal((await service.listLabels({ category: '单鞋' })).total_matched, 1);
  assert.equal((await service.listLabels({ size: '43' })).total_matched, 1);
  assert.equal((await service.listLabels({ state: '门盒', size: 42, keyword: 'XHB' })).total_matched, 1);
});

test('类别候选来自同一份数据：filters.category_options 去重排序，且不随筛选条件变少', async () => {
  const { gateway, service } = serviceFor([
    record('r1', { stockKey: 'XHB8095|黑色|休闲鞋|42', state: '门盒' }),
    record('r2', { stockKey: 'YD6693|米白|单鞋|38', state: '仓库' }),
    record('r3', { stockKey: 'YD6693|米白|单鞋|39', state: '仓库' }),
  ]);
  const all = await service.listLabels({});
  assert.deepEqual(all.filters.category_options, ['单鞋', '休闲鞋'], '去重 + 按中文排序');
  const filtered = await service.listLabels({ state: '仓库' });
  assert.deepEqual(filtered.filters.category_options, ['单鞋', '休闲鞋'],
    '候选在筛选之前算出来 —— 她越筛，下拉里可选的类别不会越来越少');
  assert.deepEqual(gateway.calls, ['liveInventory', 'liveInventory']);
});

test('筛选：尺码不是整数 / 排序方式不认识 → 400（原样告诉她哪里填错）', async () => {
  const { service } = serviceFor([]);
  await assert.rejects(() => service.listLabels({ size: '42码' }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.listLabels({ sort: '按价格' }), (error) => error.statusCode === 400);
  await assert.rejects(() => service.listLabels({ recentDays: '9999' }), (error) => error.statusCode === 400);
});

test('「最近新增」：按「创建时间」筛 + 倒序；读不到创建时间时**报错**，不静默当成没筛', async () => {
  const now = Date.parse('2026-10-08T12:00:00+08:00');
  const records = [
    record('old', { stockKey: 'A1|黑色|休闲鞋|41', createdAt: now - 10 * 24 * 3600 * 1000 }),
    record('new', { stockKey: 'A2|黑色|休闲鞋|41', createdAt: now - 2 * 3600 * 1000 }),
  ];
  const gateway = fakeGateway(records);
  const service = createLabelPrintService(gateway, { now: () => now });
  const data = await service.listLabels({ recentDays: 1, sort: 'recent' });
  assert.equal(data.total_matched, 1);
  assert.equal(data.labels[0].key, 'new');
  assert.ok(data.labels[0].created_at, '创建时间原样回给页面（排障用）');

  // 表里一条创建时间都读不出来 → 明确报错（不许"筛了等于没筛"，也不许"一张都不剩"）。
  const noCreated = createLabelPrintService(fakeGateway([record('r1', { stockKey: 'A1|黑色|休闲鞋|41' })]), { now: () => now });
  await assert.rejects(() => noCreated.listLabels({ recentDays: 7 }), /创建时间/);
});

test('截断不静默：匹配超过上限时回 truncated + total_matched，labels 只给前 N 张', async () => {
  const records = Array.from({ length: 5 }, (unused, index) => record(`r${index}`,
    { stockKey: `A${index}|黑色|休闲鞋|41` }));
  const { service } = serviceFor(records, { limits: { maxLabels: 3 } });
  const data = await service.listLabels({});
  assert.equal(data.total_matched, 5);
  assert.equal(data.total_returned, 3);
  assert.equal(data.truncated, true);
  assert.equal(data.max_labels, 3);
});

test('排序：货架顺序默认按 货号 → 尺码 → 状态（门盒/样品/仓库）', async () => {
  const { service } = serviceFor([
    record('warehouse', { stockKey: 'B1|黑色|休闲鞋|41', state: '仓库' }),
    record('door', { stockKey: 'B1|黑色|休闲鞋|41', state: '门盒' }),
    record('sample', { stockKey: 'B1|黑色|休闲鞋|41', state: '样品' }),
    record('other-item', { stockKey: 'A9|黑色|休闲鞋|45', state: '门盒' }),
  ]);
  const data = await service.listLabels({});
  assert.deepEqual(data.labels.map((label) => label.key), ['other-item', 'door', 'sample', 'warehouse']);
});

test('文案模板：底部小字取不到的值用 config 的占位顶（不留空段）', () => {
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
