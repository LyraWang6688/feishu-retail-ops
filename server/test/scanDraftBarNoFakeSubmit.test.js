'use strict';

/**
 * 本单条（draft-bar）**不许再出现"提交"按钮/链接**。
 *
 * 背景（2026-11-26 业务负责人确认删除）：
 *   2026-10-12 真机丢钱后，本单条原来那颗"不带钱"的提交按钮被换成一条
 *   `<a href="?from=sales">` 指路链接；但那条链接的文案键从未配置，且
 *   2026-10-27 裸扫默认领域改成 inventory 后，销售页被误判成"没有带钱表单"
 *   ⇒ 销售页顶部出现一个**整条宽、没有字的蓝色空按钮**。
 *   她 2026-11-26 看了截图确认："可以，整段删掉"。
 *
 * 本文件钉住两件事：
 *   ① 本单条里**没有任何按钮/链接**（只有「本单：N 双」+ 刚加入那句 + 非飞书人话）；
 *   ② 本单的数据照旧在销售表单里逐行显示（没有因为删链接把数据一起弄丢）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_draft_bar';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'draft_bar_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const VIEW = {
  found: true, number: 'A|黑|男', item_no: '测试款A', color: '黑', category_code: 'A',
  category_name: '单鞋', price_text: '¥100', total: 2,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  rows: [{ size_text: '39', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-11-26 20:00',
};

const WRITE = {
  enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: '/r/A%7C%E9%BB%91%7C%E7%94%B7?from=sales', saleKey: 'k',
  draft: {
    lines: [
      { product_number: '测试款A', item_no: '测试款A', size: 39, quantity: 1, sale_unit_price: 100, amount: '100' },
      { product_number: '测试款B', item_no: '测试款B', size: 40, quantity: 1, sale_unit_price: 120, amount: '120' },
    ],
  },
  paymentMethods: ['微信'], defaultPaymentMethod: '微信', saleEnabled: true,
};

const draftBarOf = (html) => {
  const start = html.indexOf('<section class="card draft-bar"');
  if (start < 0) return '';
  const end = html.indexOf('</section>', start);
  return end < 0 ? '' : html.slice(start, end);
};

test('销售页本单条：只报数，不出现任何按钮/链接（尤其没有空白色块）', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'sales', { userAgent: 'Mozilla/5.0 (Macintosh)' });
  const bar = draftBarOf(html);

  assert.ok(bar, '有 2 双本单时必须渲染本单条');
  assert.match(bar, /本单：2 双/, '本单条要如实报数');
  assert.equal(bar.includes('<a '), false, '本单条里不许有链接');
  assert.equal(bar.includes('class="btn'), false, '本单条里不许有按钮');
  assert.equal(bar.includes('?from=sales'), false, '不许再出现指回销售页的空链接');
});

test('本单已加的货品：整块在本单条里（标题 + 两行 + 金额），且仍随销售表单提交', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'sales', { userAgent: 'Mozilla/5.0 (Macintosh)' });
  const barStart = html.indexOf('data-view="draft-bar"');
  const barEnd = html.indexOf('</section>', barStart);
  const bar = html.slice(barStart, barEnd);
  const lineCount = (bar.match(/<div class="draft-line">/g) || []).length;
  assert.equal(lineCount, 2, '两双要在本单条里逐行显示');
  assert.match(bar, /已加的货品/, '块标题跟着一起搬过来');
  assert.match(bar, /测试款A/, '第一行货号要在');
  assert.match(bar, /测试款B/, '第二行货号要在');
  const inputCount = (bar.match(/form="scan-sale-form"/g) || []).length;
  assert.equal(inputCount, 2, '两行金额输入都要用 form 属性挂回销售表单');
  assert.ok(html.includes('id="scan-sale-form"'), '销售表单要有同一个 id');
  const formStart = html.indexOf('id="scan-sale-form"');
  const form = html.slice(formStart, html.indexOf('</form>', formStart));
  assert.equal(form.includes('class="draft-line"'), false, '销售表单里不再重复一份（避免双提交）');
});
