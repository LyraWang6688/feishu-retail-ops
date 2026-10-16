/**
 * ⭐⭐ 2026-10-16（task-61）**零回归比对**的现场工具（**不进 CI** ✗ · 只做"改前后逐字节"比对 ✓）。
 *
 * 用法（改前 / 改后**各跑一次**，然后 `diff` 两份输出）：
 *   node tools/task61-render-baseline.js > /tmp/before.txt
 *   ...改...
 *   node tools/task61-render-baseline.js > /tmp/after.txt
 *   diff /tmp/before.txt /tmp/after.txt   # 必须**一个字节都不差**（开关关着时）
 *
 * 它只调**纯渲染函数**（不碰网络 / 不读表 / 不写任何东西 ✓）。
 */
'use strict';

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_task61_baseline';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'task61_baseline_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_task61';

const {
  renderScanPage, renderScanMessagePage, renderMinimalPage,
} = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const view = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 12,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }],
  rows: [
    { size_text: '41', cells: [{ count: 2 }, { count: 1 }], total: 3, missing: false },
    { size_text: '42', cells: [{ count: 0 }, { count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 05:00',
  product_record_id: 'rec_task61',
};

const write = {
  enabled: true,
  saleEnabled: true,
  replenishEnabled: true,
  returnEnabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  multiItem: SCAN_WRITE.multiItem,
  postAction: '/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA?from=sales',
  sizes: [{ size_text: '41', missing: false }, { size_text: '42', missing: true }],
  draft: { lines: [] },
  accessories: [],
  saleKey: 'scan_sale:baseline:1',
  replenishKey: 'scan_replenish:baseline:1',
  returnKey: 'scan_return:baseline:1',
  paymentMethods: ['微信'],
  defaultPaymentMethod: '微信',
  paymentStatus: 'paid',
  defaultPaymentStatus: 'paid',
  paidAmount: '',
  paymentRows: [{ method: '微信', amount: '' }],
  errorText: '',
  notice: '',
};

const viewWithPending = { ...view, multi_items: [
  { product_record_id: 'rec_a', number: 'A|黑色|A', item_no: 'A', entries: [{ size: '41', quantity: '1' }] },
  { product_record_id: 'rec_b', number: 'B|白色|A', item_no: 'B', entries: [{ size: '42', quantity: '2' }] },
] };

const realms = ['sales', 'replenish', 'inventory', 'purchase_return', 'product'];
const out = [];
for (const realm of realms) {
  for (const [label, model] of [['plain', view], ['pending', viewWithPending]]) {
    out.push(`===== ${realm} / ${label} =====`);
    out.push(renderScanPage(model, SCAN_PAGE, write, realm, { userAgent: 'Mozilla/5.0 (iPhone) Lark/7.0', basePath: '/s' }));
  }
}
out.push('===== message =====');
out.push(renderScanMessagePage({
  title: '标题', body: '正文', number: view.number, requestId: 'req-baseline',
  details: ['a', 'b'], backPath: '/s', backLabel: '返回扫码',
}, SCAN_PAGE));
out.push('===== minimal =====');
out.push(renderMinimalPage({ title: '最小页', body: '正文', requestId: 'req-baseline' }));

process.stdout.write(out.join('\n'));
