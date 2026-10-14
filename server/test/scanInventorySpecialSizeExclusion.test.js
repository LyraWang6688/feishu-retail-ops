'use strict';

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「**库存的表格里还是没有排除特殊码**」
 *   ＋ 她纠正过的口径：「特殊码**有货就正常显示**，**没货就显示在折叠区**」（销售 / 补货 / 库存**同一套**）
 *
 * 要的行为（**三个都要** ✓）：
 *   ✅ **缺货的特殊码** ⇒ **不在表里** ✗（它在折叠区 ✓ 不许重复 ✗）
 *   ✅ **有货的特殊码** ⇒ ⭐ **照旧在表里** ✓（一条都不许少 ✗）
 *   ✅ **普通码**（有货 / 缺货）⇒ **一条不少、顺序不变** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_inv_special';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'inv_special_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const WRITE = {
  enabled: true, texts: SCAN_WRITE.texts, fields: {}, actions: {}, sizes: [],
};
const cell = (size, count) => ({ size_text: String(size), cells: [{ key: '门盒', count }], total: count, missing: count === 0 });
/** 女款（B）：34/42/43 是特殊码（她的最终口径）；36 有货、38 缺货是普通码。 */
const viewOf = () => ({
  found: true, number: 'J5|咖色|B', item_no: 'J5', color: '咖色', total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [cell(36, 1), cell(38, 0), cell(42, 0), cell(43, 2)],
  missing_count: 2, notes: [], updated_at_text: 't',
});

const htmlOf = () => renderScanPage(viewOf(), SCAN_PAGE, WRITE, 'inventory');

test('AC-IV1 ⭐ 缺货的特殊码**不在表里**（它在折叠区 ✓ 不重复 ✗）', () => {
  const html = htmlOf();
  const table = html.slice(0, html.indexOf('data-special-fold') > 0 ? html.indexOf('data-special-fold') : html.length);
  assert.equal(/data-stock-size="42"|>42 码<|>42</.test(table), false, '42 缺货的特殊码不许出现在库存表里 ✗');
});

test('AC-IV2 ⭐⭐ 有货的特殊码**照旧在表里**（一条都不许少 ✗ —— 防一刀切）', () => {
  const html = htmlOf();
  const table = html.slice(0, html.indexOf('data-special-fold') > 0 ? html.indexOf('data-special-fold') : html.length);
  assert.match(table, /43/, '43 有货的特殊码必须照旧在表里 ✓');
});

test('AC-IV3 ⭐ 缺货的特殊码**在折叠区里**（条数/内容照旧 ✓）', () => {
  const html = htmlOf();
  const fold = html.slice(html.indexOf('data-special-fold'));
  assert.match(fold, /42/, '42 在折叠区 ✓');
});

test('AC-IV4 ⭐ 普通码**一条不少**（有货的 + 缺货的都在表里 ✓）', () => {
  const html = htmlOf();
  const table = html.slice(0, html.indexOf('data-special-fold') > 0 ? html.indexOf('data-special-fold') : html.length);
  for (const size of [36, 38]) assert.match(table, new RegExp(String(size)), `${size} 码（普通码）要在表里 ✓`);
});
