'use strict';

/**
 * ⭐⭐ 2026-11-08（业务负责人真机截图 · M2165|卡其|）：
 *   销售扫码页「一行尺码都没有」时的兜底人话 —— 从旧句「这一款现在没有可选的尺码」
 *   改成 **「这个编号缺类别（男/女），暂时算不出尺码，请核对编号」**。
 *
 * 真实成因（截图三项事实都对上）：
 *   · 编号 `M2165|卡其|` 第 3 段（类别 A/B）为空 ⇒ `scanPageService` 的 `number_without_category`
 *     降级（`scope.degraded = true, sizes = []`）；
 *   · 这一款在「实时库存」里一条记录都没有（库存更新时间 `—`）⇒ `buckets` 空；
 *   · ⇒ `view.rows = []` ⇒ `saleSizeGroups` 三堆全空 ⇒ 兜底一句（**不是「没货」** ✗）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AC-DS1 ⭐ 三堆全空（算不出尺码）⇒ 只给**新文案**；**不画** `.size-group` 两组；
 *          旧句「这一款现在没有可选的尺码」**不出现**（不再误导成没货）。
 *  AC-DS2 ⭐ 正常「没货」（普通码都在、只是没库存）⇒ 仍是「现货空 + 预订组 + 旧句」；
 *          **新文案不出现**（防误伤正常路径）。
 *  AC-DS3 ⭐ 只有特殊码缺货（folded 非空）⇒ 照常画两组 + 特殊码折叠块，**不吃掉折叠块**；
 *          不触发新兜底（条件是**三堆**全空，不是两堆）。
 *  AC-DS4 ⭐ 源码哨兵：`paymentBlock.js` 里旧 `write.sizes` 回填**已删净**（与 saleSizeGroups 同源、
 *          实测不改变结果）；新文案的真源在 **config**（config 目录不被硬编码中文闸门扫描 ⇒
 *          不新增「存量债」）；渲染层只转发 `SCAN_PAGE.texts.saleSizesUnavailable`。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sale_sizes_unavailable';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sale_sizes_unavailable_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SERVER = path.join(__dirname, '..');
const OLD_TEXT = '这一款现在没有可选的尺码';

const COLUMNS = [
  { key: '门盒', label: '门盒' },
  { key: '样品', label: '样品' },
  { key: '仓库', label: '仓库' },
  { key: '', label: SCAN_PAGE.states.emptyLabel },
];

const WRITE = {
  enabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: '/r/x',
  sizes: [],
  draft: { lines: [] },
  saleEnabled: true,
  replenishEnabled: true,
  returnEnabled: true,
  saleKey: 'scan_sale:test:1',
  replenishKey: 'scan_replenish:test:1',
  returnKey: 'scan_return:test:1',
  paymentMethods: [],
  defaultPaymentMethod: '微信',
  paymentStatus: SCAN_WRITE.sale.paymentStatus.default,
  defaultPaymentStatus: SCAN_WRITE.sale.paymentStatus.default,
  paidAmount: '',
};

const viewOf = ({ number, rows, degraded = false, categoryCode = 'B' }) => ({
  found: true,
  number,
  item_no: number.split('|')[0],
  color: '卡其',
  category_name: '女鞋',
  category_code: categoryCode,
  price_text: '—',
  total: rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
  columns: COLUMNS,
  rows,
  missing_count: rows.filter((row) => row.missing).length,
  sizes_degraded: degraded,
  notes: [],
  updated_at_text: '—',
  product_record_id: 'rec_test',
});

const rowOf = (size, { total = 0, missing = false } = {}) => ({
  size_text: String(size),
  cells: [{ key: '门盒', count: total }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }, { key: '', count: 0 }],
  total,
  missing,
});

const render = (view) => renderScanPage(view, SCAN_PAGE, WRITE, 'sales', {});

test('AC-DS1 ⭐⭐ 三堆全空（编号缺类别 + 无库存）⇒ 只给「核对编号」那一句；不画两组、不再出现旧句', () => {
  // 与她截图一致的形状：编号 M2165|卡其| 第 3 段为空 + rows = []（降级 + 实时库存无记录）
  const html = render(viewOf({ number: 'M2165|卡其|', rows: [], degraded: true, categoryCode: '' }));
  const message = SCAN_PAGE.texts.saleSizesUnavailable;
  assert.equal(message, '这个编号缺类别（男/女），暂时算不出尺码，请核对编号');
  assert.ok(html.includes(message), '兜底那句「核对编号」必须在页面上');
  assert.ok(html.includes('data-view="sale-sizes-unavailable"'), '稳定标记（判据/埋点用）');
  assert.equal(html.includes(OLD_TEXT), false, '旧句「这一款现在没有可选的尺码」不许再出现（它会误导成没货）');
  assert.equal(html.includes('data-stock-group='), false, '三堆全空 ⇒ **不画**现货/预订两个组（只一句人话）');
});

test('AC-DS2 ⭐ 正常「没货」（普通码都在、只是没库存）⇒ 仍是「现货空 + 预订组 + 旧句」；新文案不出现', () => {
  const rows = [36, 37, 38, 39, 40].map((size) => rowOf(size, { missing: true }));
  const html = render(viewOf({ number: 'QPL8093|卡其|女', rows }));
  assert.match(html, /data-stock-group="prepaid"/, '预订组照常画');
  assert.ok(html.includes(OLD_TEXT), '空的那一组仍用旧句（业务负责人确认过这句没问题）');
  assert.equal(html.includes(SCAN_PAGE.texts.saleSizesUnavailable), false, '正常没货不许出现「核对编号」那句 ✗');
});

test('AC-DS3 ⭐ 只有特殊码缺货 ⇒ 照常画两组 + 特殊码折叠块（不吞折叠块）；不触发新兜底', () => {
  // 女 B 段：34 是特殊码；只给这一行（缺货）⇒ saleSizeGroups 的 folded 非空
  const html = render(viewOf({ number: 'M2165|卡其|女', rows: [rowOf(34, { missing: true })] }));
  assert.ok(html.includes(SCAN_PAGE.texts.saleSizesUnavailable) === false,
    '折叠块非空 ⇒ 不走「三堆全空」兜底（否则会把特殊码吞掉 ✗）');
  assert.ok(/data-stock-group="in_stock"/.test(html) && /data-stock-group="prepaid"/.test(html), '两组照常画');
  assert.match(html, /<details[^>]*size-fold/, '特殊码折叠块仍在');
});

test('AC-DS4 ⭐ 源码哨兵：冗余 write.sizes 回填已删净 · 新文案真源在 config、渲染层只转发', () => {
  const block = fs.readFileSync(path.join(SERVER, 'src/views/scanPage/paymentBlock.js'), 'utf8');
  // ⚠️ 先剥掉 `//` 注释再断言：解释性注释里提到「旧的 write.sizes 回填」是允许的 ✓
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.equal(/fallback\s*=\s*\(write\.sizes/.test(code), false, '旧的 write.sizes 回填已删净（与 saleSizeGroups 同源，冗余）');
  assert.equal(/write\.sizes/.test(code), false, 'paymentBlock 的**代码**不再读 write.sizes（注释里提到历史除外 ✓）');
  assert.match(block, /saleSizeUnavailable/, '兜底用新文案键');

  const cfg = fs.readFileSync(path.join(SERVER, 'src/config/scanPage.js'), 'utf8');
  assert.equal((cfg.match(/这个编号缺类别（男\/女），暂时算不出尺码，请核对编号/g) || []).length, 1,
    '新文案**唯一真源**在 config（只出现一次）');
  const realm = fs.readFileSync(path.join(SERVER, 'src/views/scanPageRealm.js'), 'utf8');
  assert.match(realm, /saleSizeUnavailable:\s*SCAN_PAGE\.texts\.saleSizesUnavailable/,
    'views 只转发 config 的值（不写死中文 ⇒ 不新增硬编码存量债 ✓）');
});
