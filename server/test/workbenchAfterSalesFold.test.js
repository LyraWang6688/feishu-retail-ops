/**
 * 【乙】工作台订单列表：**「售后列表」默认折叠**（业务负责人 2026-10-12）。
 *
 * 为什么：售后单多的时候，待补充 / 待交割 被挤到屏外；售后那段**默认收起** ⇒ 一屏多出至少 1 单。
 * 口径：**只折叠「售后列表」**（待补充 / 待交割保持展开 ✓）· 折叠状态要**记住**（她手动展开后不该被刷掉 ✓）·
 * **写入逻辑一个字不动**（补收款 / 交付 / 售后三条写路径逐字不变 ✓）。
 *
 * AC：AC1 默认折叠 · AC2 记住展开（重画后仍展开）· AC3 另两段仍展开 · AC4 写路径逐字不变 ·
 *     AC5 命中区 ≥44px（summary 走 `--control-height`）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把 `features/orders/index.js` 当模块加载（复制成 .mjs，只改 import 的文件名）。 */
async function loadOrders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orders-fold-'));
  const replacements = [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ];
  const copies = {
    'config/orders.js': 'orders-config.mjs',
    'core/formatters.js': 'formatters.mjs',
    'core/api-client.js': 'api-client.mjs',
    'core/ui.js': 'ui.mjs',
  };
  for (const [from, to] of Object.entries(copies)) fs.copyFileSync(path.join(WORKBENCH, from), path.join(dir, to));
  let source = read('features/orders/index.js');
  for (const [needle, replacement] of replacements) {
    assert.ok(source.includes(needle), `harness 失配（源码里没有 ${needle}）`);
    source = source.split(needle).join(replacement);
  }
  fs.writeFileSync(path.join(dir, 'orders.mjs'), source, 'utf8');
  return import(pathToFileURL(path.join(dir, 'orders.mjs')).href);
}

/** 一条"售后列表"的单（`salesSectionOf` 判它进 afterSales）。 */
const afterSalesOrder = () => ({
  record_id: 'rec-after-1', order_no: 'XSD-1', customer_name: '张三', fulfilled: true,
  payment_status: '已收款', fulfillment_status: '已交付', after_sales_closed: true,
  totals: { quantity: 1, amount: 100 }, details: [],
});
/** 一条"待交割"的单。 */
const pendingOrder = () => ({
  record_id: 'rec-pending-1', order_no: 'XSD-2', customer_name: '李四', fulfilled: false,
  payment_status: '已收款', fulfillment_status: '未交付',
  totals: { quantity: 1, amount: 100 }, details: [],
});

const FOLD = 'data-view="after-sales-section"';

test('AC1 默认折叠：售后那段收在 <details> 里、且**不带 open**', async () => {
  const orders = await loadOrders();
  const html = orders.ordersSectionsHtml([afterSalesOrder()]);
  assert.ok(html.includes(FOLD), '售后那段要有可折叠容器');
  const tag = /<details[^>]*data-view="after-sales-section"[^>]*>/.exec(html)
    || /<details[^>]*>/.exec(html.slice(html.indexOf(FOLD) - 200));
  assert.ok(tag, '必须是 <details> 折叠块');
  assert.equal(/\sopen(\s|>)/.test(tag[0]), false, `默认必须是收起的：${tag[0]}`);
  assert.ok(html.includes('售后列表'), '标题仍在（收起也要看得见是哪一段）');
});

test('AC2 ⭐ 记住展开：`openSections` 里有它 ⇒ 渲染成展开（重画也不会被刷掉）', async () => {
  const orders = await loadOrders();
  const collapsed = orders.ordersSectionsHtml([afterSalesOrder()]);
  const expanded = orders.ordersSectionsHtml([afterSalesOrder()], { openSections: ['afterSales'] });
  const openTag = (html) => (/<details[^>]*data-view="after-sales-section"[^>]*>/.exec(html) || [''])[0];
  assert.equal(/\sopen(\s|>)/.test(openTag(expanded)), true, `传了 openSections 就要展开：${openTag(expanded)}`);
  assert.equal(/\sopen(\s|>)/.test(openTag(collapsed)), false, '不传就还是收起');
  // ⭐ 状态在模块 state 里（重画时把 state 传回去 ⇒ 她手动展开后不被刷掉）
  const source = read('features/orders/index.js');
  assert.match(source, /openSections/, '要有 openSections 状态');
  assert.match(source, /addEventListener\('toggle'/, '要监听 <details> 的 toggle（注意 toggle 不冒泡）');
});

test('AC3 待补充 / 待交割**仍然展开**（只折叠售后那段）', async () => {
  const orders = await loadOrders();
  const html = orders.ordersSectionsHtml([pendingOrder(), afterSalesOrder()]);
  const pendingTag = /<section[^>]*data-sales-section="pending"[^>]*>/.exec(html);
  assert.ok(pendingTag, '待交割那段的 <section> 要直接出现（不是收在 details 里）');
  const before = html.slice(0, html.indexOf('data-sales-section="pending"'));
  assert.equal(/<details[^>]*$/.test(before.trimEnd().slice(-200)), false, '待交割不许被包进 <details>');
  assert.ok(!html.includes('data-view="after-sales-section" open'), '售后仍是收起');
});

test('AC4 三条写路径逐字不变（本切片只动"折叠"，不许碰写入）', () => {
  const source = read('features/orders/index.js');
  for (const action of ["'submit-payment'", "'deliver'", "'submit-after-sales'"]) {
    assert.ok(source.includes(action), `写入口 ${action} 不见了吗？`);
  }
  for (const endpoint of ['ORDERS_API.payments', 'ORDERS_API.deliveries', 'ORDERS_API.afterSales']) {
    assert.ok(source.includes(endpoint), `${endpoint} 的写入调用要原样在`);
  }
});

test('AC5 折叠条的命中区 ≥44px（summary 走 --control-height）', () => {
  const css = read('features/orders/orders.css');
  const rule = /\.order-section-collapsible\s*>\s*summary\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '要有折叠条的样式');
  assert.match(rule[1], /min-height:\s*var\(--control-height\)/, '命中区 ≥44px（移动端）');
});
