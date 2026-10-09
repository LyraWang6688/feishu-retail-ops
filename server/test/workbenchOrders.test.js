/**
 * 工作台【订单列表】的验收标准（业务负责人 2026-10-09 明确要的东西）。
 *
 * 她的原话（逐字）：
 *   「我们建一个**订单列表**吧……订单列表实际上就是**看销售情况**，包含这几项：
 *    **1. 销售单号  2. 具体销售明细  3. 收款情况**」
 *   「**工作台要对移动端友好**。……如果它在移动端进行**补收款、售后，以及二次交付**，
 *    这些都是可以的。如果我们能有一个**订单列表来操作售后**，其实完全没有问题」
 *   「我之前说的不维护，是说**有一些功能**不再维护了，并不是说整个工作台都不维护」
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ⭐ 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC1 列表三项字段齐：一行一张销售单 —— **销售单号 · 销售明细 · 收款情况**；
 *      服务层仍走 `SalesFollowupService.listOrders()`（`GET /api/workbench/sales/orders`），
 *      渲染层把三项都画出来（一张单一张卡，不是表格）。
 *  AC2 移动端友好：viewport + **单列卡片式** + **不横向滚动** + 按钮够大（≥44px 命中区），
 *      电脑上也要能用（桌面 2 列 / 窄屏 1 列）—— 静态哨兵 ＋ 渲染哨兵。
 *  AC3 补收款：**收款方式默认「微信」且可改**；⚠️ 默认**只在这一页**给，
 *      **群聊链路一个字不动**（源码哨兵：这个默认值的读取点只有工作台这一处）。
 *  AC4 交付：复用既有 `POST /api/workbench/sales/deliveries` 与
 *      `SalesFollowupService.delivery.deliver`（不另写一套出库）。
 *  AC5 售后（退 / 换 / 赔）：**三种动作都走既有 `AfterSalesService.execute`**，
 *      ⭐ 源码哨兵断言**没有新写库实现**（接线层一次 `gateway.create/update` 都没有）。
 *  AC6 二次交付（收尾款 + 交付）：复用既有 `SecondDeliveryService.confirm`。
 *  AC7 鉴权语义不变：两条新接口都挂在**既有** `requireWorkbenchAccess` 之内 ——
 *      未启用认证 503 / 未登录 401 / 白名单外 403（**不新开鉴权**）。
 *  AC8 失败有人话：服务层的拒绝原因（她填错的 / 业务拒绝）原样回到页面，
 *      **不静默**、也不拿"系统错误"糊过去。
 *
 * ⭐⭐ 2026-10-09 追加（业务负责人当天 15:07 亲口定的结构，逐字）：
 *   「第三个 tab 是**订单列表**，分**两个子 tab**：
 *     1. **销售**，按照**是否钱货两清**分类。**没有钱货两清的就是有二次的**，比如
 *        **货物交付或者资金交付，或者两者都有**。然后两者**都有售后**，售后就是**换货、退货、赔货**。
 *     2. **采购**，按照**采购订单**，有**验收到货**的按钮」
 *
 *  AC9 订单列表内部两个子 tab：**销售 / 采购**（子 tab 的**选中态与切换自己实现**，
 *      **不动**一级 tab 的结构与前两个 tab；一级 tab 仍逐字 3 个，由旧用例钉住）。
 *  AC10 销售子 tab 按「是否钱货两清」分四类：**钱货两清 / 有二次·货未交付 /
 *      有二次·资金未收 / 有二次·两者都有**；判据**只用既有字段与取值**
 *      （`fulfillment_status` ∈ 未交付·部分交付·已交付、`payment_status` ∈ 未收款·部分收款·
 *      待平台结算·已收款·空），**不新增枚举**；每一类都能进**既有售后入口**（退 / 换 / 赔）。
 *  AC11 采购子 tab：**一张采购申请/报货批次一行**（按 `batch_no` 归行），字段与既有
 *      「采购管理」页口径一致（报货批次号 / 货品编号 / 尺码 / 数量 / 到货状态），
 *      每行有「**验收到货**」按钮。
 *  AC12 「验收到货」**复用既有**到货核对/入库链路：
 *      接线层 → `PurchaseArrivalConversationService.confirmBatchArrival`（**新薄方法**，
 *      复用既有 `loadRequestRows` / `buildPlan` / `confirmLocked`）→ 既有
 *      `PurchaseWebhookService.confirmArrival`（逐条 `InventoryService.applyPurchase`）。
 *      **源码哨兵钉死**：接线层一次 `gateway.create/update/delete` 都没有，
 *      也没有第二套库存实现。
 *  AC13 「验收到货」失败有人话：金额缺失 / 批次没有明细 / 入库失败 —— 原样回到页面，不静默。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const express = require('express');

// 路由文件模块级会 new 一个 V1BitableGateway（构造时读飞书凭证）。
// 给一对**假凭证**只为让模块能加载：本用例不打飞书（与 labelPrintRoute.test.js 同一做法）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';

const { createWorkbenchRouter } = require('../src/routes/workbench');
const { WorkbenchOrderActionService } = require('../src/services/workbenchOrderActionService');
const { WorkbenchPurchaseArrivalService } = require('../src/services/workbenchPurchaseArrivalService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { DEFAULT_COLLECTION_METHOD } = require('../src/config/workbenchOrders');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const SRC = path.join(__dirname, '../src');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** 去掉注释再对"代码里有没有某件事"下结论 —— 注释里提一句历史不算实现。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return /node_modules|data/.test(entry.name) ? [] : walk(full);
  return full.endsWith('.js') ? [full] : [];
});

// ── 前端模块真跑起来（与 workbenchTwoTabsAndQueryEntries.test.js 同一套做法）──────────
function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-orders-'));
  const copy = (from, to, replacements = []) => {
    let source = readWorkbench(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('config/orders.js', 'orders-config.mjs');
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('core/ui.js', 'ui.mjs');
  copy('features/orders/index.js', 'orders-index.mjs', [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return { config: load('orders-config'), orders: load('orders-index') };
}

/**
 * 夹具 = `listOrders()` 的真实返回形状（字段名逐字对齐 `SalesFollowupService.listOrders`）。
 * 一张单：3 条明细（1 条已交付 / 2 条未交付）、1 笔已收 50、还差 137。
 */
const ORDER = {
  record_id: 'order_1',
  order_no: 'XSD-20261009-0001',
  fulfillment_status: '部分交付',
  payment_status: '部分收款',
  receivable_amount: 187,
  paid_amount: 50,
  pending_amount: 137,
  platform_pending_amount: 0,
  pending_delivery_quantity: 2,
  details: [
    {
      record_id: 'detail_1', product: 'XHB8095', product_record_id: 'product_1', size: 38,
      size_record_id: 'size_38', quantity: 1, delivered_quantity: 1,
      fulfillment_status: '已交付', actual_amount: 89,
    },
    {
      record_id: 'detail_2', product: 'XHB8095', product_record_id: 'product_1', size: 39,
      size_record_id: 'size_39', quantity: 1, delivered_quantity: 0,
      fulfillment_status: '未交付', actual_amount: 59,
    },
    {
      record_id: 'detail_3', product: 'YD6693', product_record_id: 'product_2', size: 40,
      size_record_id: 'size_40', quantity: 1, delivered_quantity: 0,
      fulfillment_status: '未交付', actual_amount: 39,
    },
  ],
  payments: [
    { record_id: 'receipt_1', amount: 50, status: '已收款', received_at: 1759900000000, method: '微信' },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// AC1 列表三项字段齐
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 列表三项字段齐：销售单号 · 销售明细 · 收款情况，一行一张单（一张卡，不是表格）', async () => {
  const { orders } = loadFrontendModules();
  const html = (await orders).ordersListHtml([ORDER]);

  // ① 销售单号
  assert.match(html, /XSD-20261009-0001/, '列表必须看得到销售单号');
  // ② 具体销售明细：哪些货 / 尺码 / 金额（三条都在，尺码与金额逐条可辨）
  for (const [product, size, amount] of [['XHB8095', 38, 89], ['XHB8095', 39, 59], ['YD6693', 40, 39]]) {
    assert.ok(html.includes(product), `明细必须看得到货 ${product}`);
    assert.ok(new RegExp(`${size}\\s*码|${size}码`).test(html), `明细必须看得到尺码 ${size}`);
    assert.ok(html.includes(`¥${Number(amount).toFixed(2)}`), `明细必须看得到金额 ¥${amount}`);
  }
  // ③ 收款情况：已收多少 / 还差多少 / 状态
  assert.ok(html.includes('¥50.00'), '收款情况必须显示已收金额');
  assert.ok(html.includes('¥137.00'), '收款情况必须显示还差金额');
  assert.ok(html.includes('部分收款'), '收款状态来自现有字段（不自己造词）');
  assert.ok(html.includes('部分交付'), '履约状态来自现有字段（不自己造词）');

  // 「一行一张销售单」= 一张卡；列表里**不许再有 table**（表格在手机上必然横向滚动）
  assert.ok(html.includes('order-card'), '一张销售单 = 一张卡（order-card）');
  assert.ok(!/<table/i.test(html), '列表不许用 <table>（手机上会横向滚动）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 移动端友好：viewport / 单列 / 不横向滚动 / 按钮够大
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 移动端友好：viewport + 单列卡片 + 不横向滚动 + 按钮 ≥44px（静态哨兵）', () => {
  const indexHtml = readWorkbench('index.html');
  // ① viewport（她是在手机上、飞书内置浏览器里打开的）
  assert.match(indexHtml, /<meta name="viewport" content="width=device-width, initial-scale=1[^"]*">/,
    'index.html 必须有移动端 viewport');
  assert.ok(indexHtml.includes('/workbench/features/orders/orders.css'),
    'index.html 必须加载订单列表自己的样式（不然手机上没有单列卡片规则）');

  const css = readWorkbench('features/orders/orders.css');
  // ② 单列卡片：窄屏一列
  const mobileBlock = css.match(/@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*?\n\}/);
  assert.ok(mobileBlock, 'orders.css 必须有 @media (max-width: 760px) 的窄屏规则');
  assert.match(mobileBlock[0], /grid-template-columns:\s*1fr/, '窄屏必须单列（grid-template-columns: 1fr）');
  // ③ 不横向滚动：长单号 / 长货号必须能断行，且不许出现表格 or 超宽固定宽度
  assert.match(css, /overflow-wrap:\s*anywhere/, '长单号 / 长货号必须能断行（overflow-wrap: anywhere）');
  assert.ok(!/<table|table\s*\{/.test(css), 'orders.css 不许出现表格版式');
  assert.ok(!/min-width:\s*\d{3,}px/.test(css), 'orders.css 不许有 ≥100px 的固定 min-width（会挤横向滚动条）');
  // ④ 按钮够大：手机上点得准（≥44px 命中区，与 base.css 的既有口径一致）
  assert.match(css, /min-height:\s*44px/, '按钮 / 输入框在手机上必须有 ≥44px 命中区');

  // ⑤ 渲染出来的单张单卡里也没有固定宽度 / 表格
  const { orders } = loadFrontendModules();
  return orders.then((module) => {
    const html = module.orderDetailHtml(ORDER, { methods: ['微信', '现金'] });
    assert.ok(!/<table/i.test(html), '订单详情也不许用 <table>');
    assert.ok(!/min-width:\s*\d{3,}px/.test(html), '订单详情不许内联超宽固定宽度');
    assert.ok(html.includes('order-actions'), '详情页必须把四个动作放在 order-actions 区（窄屏整行可点）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 补收款：收款方式默认「微信」且可改（默认只在这一页）
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 补收款：收款方式默认「微信」且可改（默认值来自配置，能改）', async () => {
  const { config, orders } = loadFrontendModules();
  const [frontConfig, module] = await Promise.all([config, orders]);

  // ⭐ 默认 = 「微信」（业务负责人 2026-10-08 定的），而且是**可配**的（配置先行）
  assert.equal(frontConfig.DEFAULT_COLLECTION_METHOD, '微信', '工作台订单列表的默认收款方式 = 微信');
  assert.equal(DEFAULT_COLLECTION_METHOD, '微信', '后端的默认值也必须来自 config/workbenchOrders.js，同样是微信');
  assert.ok(Array.isArray(frontConfig.COLLECTION_METHODS) && frontConfig.COLLECTION_METHODS.length > 1,
    '收款方式是**可改**的：必须有不止一个候选（否则"默认且可改"是空话）');

  const html = module.orderDetailHtml(ORDER, { methods: ['微信', '现金', '支付宝'] });
  const select = html.match(/<select[^>]*data-field="payment-method"[\s\S]*?<\/select>/);
  assert.ok(select, '补收款区必须有收款方式下拉（data-field="payment-method"）');
  const options = [...select[0].matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)<\/option>/g)];
  assert.deepEqual(options.map((item) => item[1]), ['微信', '现金', '支付宝'],
    '下拉的候选来自**后端返回的收款方式清单**（不自己造选项）');
  assert.ok(options[0][2].includes('selected'), '「微信」必须默认选中');
  assert.equal(options[0][3], '微信');
  assert.ok(options.filter((item) => item[2].includes('selected')).length === 1, '只能有一个默认选中');
  assert.ok(html.includes('data-field="payment-amount"'), '补收款区必须有金额输入');
  // 金额预填「还差多少」是**这张单自己的数据**，不是我们猜的
  assert.match(html, /data-field="payment-amount"[^>]*value="137"/, '补收款金额默认预填这张单的待收金额');
});

test('AC3b 入口隔离：默认收款方式只被工作台这一页的接线层读取，群聊链路一行都不碰', () => {
  // ⚠️ 「只在这个页面给默认，群聊链路一个字不动」——
  //    这条哨兵钉的是**读取点**：后端读 `DEFAULT_COLLECTION_METHOD` 的只有
  //    config 定义处 + 工作台订单动作接线层；群聊链路（larkMvpService /
  //    salesThreadProgressService / afterSalesFlowService / secondDeliveryService…）
  //    一个都不许读它。
  const hits = walk(SRC)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('DEFAULT_COLLECTION_METHOD'))
    .map((file) => path.relative(SRC, file))
    .sort();
  assert.deepEqual(hits, ['config/workbenchOrders.js', 'services/workbenchOrderActionService.js'],
    '默认收款方式的读取点只能是"配置文件 + 工作台订单动作接线层"（群聊链路不许读它）');

  // 群聊链路的入口文件里不许出现这个默认值 —— 它们只认"她说的那个方式"。
  for (const rel of [
    'services/larkMvpService.js',
    'services/salesThreadProgressService.js',
    'services/afterSalesFlowService.js',
    'services/secondDeliveryService.js',
    'services/salesFollowupService.js',
  ]) {
    assert.ok(!readSrc(rel).includes('DEFAULT_COLLECTION_METHOD'), `${rel} 不许读工作台的默认收款方式`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 / AC6 交付 · 二次交付
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 交付：复用既有 deliveries 接口 → SalesFollowupService.delivery.deliver（不另写一套出库）', async () => {
  login();
  const calls = [];
  const app = appWith({
    followup: {
      gateway: {},
      listOrders: async () => ({ orders: [], methods: [] }),
      delivery: { deliver: async (input) => { calls.push(input); return { results: [], failures: [] }; } },
    },
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/sales/deliveries`, {
      method: 'POST',
      headers: { cookie: sessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesEntryRecordId: 'order_1', detailRecordIds: ['detail_2', 'detail_3'] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
  });
  assert.deepEqual(calls[0], { salesEntryRecordId: 'order_1', detailRecordIds: ['detail_2', 'detail_3'] },
    '交付接口把「哪几张明细」原样交给既有交付服务');

  // 渲染层：只列**未交付**的明细（已交付的不再给勾）
  const { orders } = loadFrontendModules();
  const html = (await orders).orderDetailHtml(ORDER, { methods: ['微信'] });
  const boxes = [...html.matchAll(/data-field="delivery-detail" value="([^"]*)"/g)].map((item) => item[1]);
  assert.deepEqual(boxes.sort(), ['detail_2', 'detail_3'], '交付只列未交付的明细');
  assert.ok(html.includes('data-action="deliver"'), '交付必须有提交按钮');
});

test('AC6 二次交付（收尾款 + 交付）：复用既有 SecondDeliveryService.confirm', async () => {
  login();
  const calls = [];
  const app = appWith({
    orderActions: {
      afterSales: async () => { throw new Error('不该被调用'); },
      secondDelivery: async (input) => { calls.push(input); return { collectedAmount: 137, delivery: {} }; },
    },
  });
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/workbench/sales/second-delivery`, {
      method: 'POST',
      headers: { cookie: sessionCookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ salesEntryRecordId: 'order_1', method: '现金' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.collectedAmount, 137);
  });
  assert.deepEqual(calls[0], { salesEntryRecordId: 'order_1', method: '现金', operatorOpenId: 'ou_test_user' },
    '二次交付把「哪张单 + 收款方式 + 操作人」交给既有 SecondDeliveryService.confirm');

  // 真的是既有服务：接线层调用 `secondDelivery.confirm`
  const source = stripComments(readSrc('services/workbenchOrderActionService.js'));
  assert.ok(source.includes('secondDeliveryExecutor.confirm('), '二次交付必须调既有 SecondDeliveryService.confirm');
  assert.ok(source.includes('SecondDeliveryService'), '接线层必须复用既有 SecondDeliveryService');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC5 售后：退 / 换 / 赔 —— 三种动作全部走既有 AfterSalesService.execute
// ═══════════════════════════════════════════════════════════════════════════

/** 造一个只读网关（schema 用真的，数据用假的）。 */
const fakeGateway = (records = {}) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
  listAll: async (key) => records[key] || [],
});

const ORDER_RECORD = { record_id: 'order_1', fields: { 销售单号: 'XSD-20261009-0001' } };
const DETAIL_RECORD = {
  record_id: 'detail_1',
  fields: { 销售单号: ['order_1'], 编号: ['product_1'], 尺码: ['size_38'], 履约状态: '已交付', 成交金额: 89 },
};
const SIZE_STUB = { resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }) };

/**
 * 到货核对那条路要的是**关联单元格**解析（`resolveLinkedCell`）——
 * 既有的 `SIZE_STUB` 只实现了 `resolveByNumber`（售后那条路用的），这里补一个。
 */
const ARRIVAL_SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
};

const actionServiceWith = (captured) => new WorkbenchOrderActionService({
  gateway: fakeGateway({ salesEntry: [ORDER_RECORD], salesDetail: [DETAIL_RECORD] }),
  sizeReferences: SIZE_STUB,
  afterSales: { execute: async (input) => { captured.push(input); return { action: input.action }; } },
  secondDelivery: { confirm: async () => ({}) },
});

test('AC5 售后三种动作：退 / 换 / 赔都交给既有 AfterSalesService.execute（入参形状逐字对齐）', async () => {
  // ── 退货：钱改成「已退款」（资金走向 = 退给她）
  const returnCalls = [];
  await actionServiceWith(returnCalls).afterSales({
    action: 'return',
    salesEntryRecordId: 'order_1',
    detailRecordIds: ['detail_1'],
    restockState: '门盒',
    diffAmount: -89,
    settlement: 'cash',
    paymentMethod: '微信',
    requestId: '11111111-1111-4111-8111-111111111111',
    operatorOpenId: 'ou_test_user',
  });
  assert.equal(returnCalls.length, 1);
  assert.deepEqual({
    action: returnCalls[0].action,
    originalSalesEntryRecordId: returnCalls[0].originalSalesEntryRecordId,
    originalSalesOrderNo: returnCalls[0].originalSalesOrderNo,
    originalSalesDetailRecordIds: returnCalls[0].originalSalesDetailRecordIds,
    newLines: returnCalls[0].newLines,
    restockState: returnCalls[0].restockState,
    settlement: returnCalls[0].settlement,
    paymentMethod: returnCalls[0].paymentMethod,
    diffAmount: returnCalls[0].diffAmount,
    operatorOpenId: returnCalls[0].operatorOpenId,
  }, {
    action: 'return',
    originalSalesEntryRecordId: 'order_1',
    originalSalesOrderNo: 'XSD-20261009-0001',
    originalSalesDetailRecordIds: ['detail_1'],
    newLines: [], // 退货不带新出货商品（既有契约）
    restockState: '门盒',
    settlement: 'cash',
    paymentMethod: '微信',
    diffAmount: -89,
    operatorOpenId: 'ou_test_user',
  }, '退货：原单号从主表读出、明细原样、退货不带 newLines');
  assert.ok(returnCalls[0].originalText, '执行器要求「原话」非空 —— 工作台自己拼一句可追溯的话');
  assert.ok(returnCalls[0].taskId, '这一次售后的幂等分片必须由工作台给出（requestId）');

  // ── 换货（同款换码：不点货号 ⇒ 货品取原明细那一双）
  const exchangeCalls = [];
  await actionServiceWith(exchangeCalls).afterSales({
    action: 'exchange',
    salesEntryRecordId: 'order_1',
    detailRecordIds: ['detail_1'],
    restockState: '样品',
    newLine: { sameItem: true, size: 42, amount: 89 },
    diffAmount: 0,
    requestId: '22222222-2222-4222-8222-222222222222',
  });
  assert.deepEqual(exchangeCalls[0].newLines, [{ productId: 'product_1', sizeId: 'size_42', amount: 89 }],
    '换货：出货商品 = 原明细那一双的货品 + 新尺码（尺码走共享尺码服务解析成关联 id）');
  assert.equal(exchangeCalls[0].restockState, '样品');
  assert.equal(exchangeCalls[0].diffAmount, 0, '差价 0 ⇒ 不动钱');
  assert.equal(exchangeCalls[0].settlement, null, '不动钱时 settlement 必须为空（既有契约）');

  // ── 赔货：金额由动作配置固定成 0（这里只负责给一个 >0 的占位）
  const compensationCalls = [];
  await actionServiceWith(compensationCalls).afterSales({
    action: 'compensation',
    salesEntryRecordId: 'order_1',
    detailRecordIds: ['detail_1'],
    newLine: { productRecordId: 'product_2', size: 41, amount: 129 },
    requestId: '33333333-3333-4333-8333-333333333333',
  });
  assert.equal(compensationCalls[0].action, 'compensation');
  assert.deepEqual(compensationCalls[0].newLines, [{ productId: 'product_2', sizeId: 'size_41', amount: 129 }],
    '赔货：出货商品由调用方指定（金额被既有动作配置固定成 0，见 config/afterSales）');
  assert.equal(compensationCalls[0].restockState, null, '赔货不需要「退回的鞋回哪儿」（既有契约）');
});

test('AC5d 售后「同款」勾了多条明细：不猜，当场问清楚（校验在写之前）', async () => {
  const calls = [];
  await assert.rejects(
    () => actionServiceWith(calls).afterSales({
      action: 'exchange',
      salesEntryRecordId: 'order_1',
      detailRecordIds: ['detail_1', 'detail_2'],
      restockState: '门盒',
      newLine: { sameItem: true, size: 42 },
      diffAmount: 0,
      requestId: '44444444-4444-4444-8444-444444444444',
    }),
    /一次只能选一条销售明细/,
    '「同款」取哪一条明细没有唯一答案 ⇒ 问她，不许悄悄拿第一条',
  );
  assert.equal(calls.length, 0, '校验阶段失败 ⇒ 执行器一次都没被调到（一个字节都没写）');
});

test('AC5b 售后：退 / 换 / 赔三条路由都能通，且都进 afterSales 接线层', async () => {
  login();
  const calls = [];
  const app = appWith({
    orderActions: {
      afterSales: async (input) => { calls.push(input); return { action: input.action, label: input.action }; },
      secondDelivery: async () => ({}),
    },
  });
  for (const action of ['return', 'exchange', 'compensation']) {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/workbench/sales/after-sales`, {
        method: 'POST',
        headers: { cookie: sessionCookie(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, salesEntryRecordId: 'order_1', detailRecordIds: ['detail_1'] }),
      });
      assert.equal(response.status, 200, `${action} 的路由必须通`);
    });
  }
  assert.deepEqual(calls.map((item) => item.action), ['return', 'exchange', 'compensation']);
  assert.equal(calls[0].operatorOpenId, 'ou_test_user', '操作人取登录会话里的 open_id');
});

test('AC5c 源码哨兵：接线层**没有新写库实现** —— 一次 gateway 写操作都没有', () => {
  for (const rel of ['services/workbenchOrderActionService.js', 'routes/workbenchOrderActions.js']) {
    const source = stripComments(readSrc(rel));
    assert.ok(!/\bgateway\s*\.\s*(create|update|delete|batchCreate|batchUpdate)\s*\(/.test(source),
      `${rel} 不许直接写库（一切写入走既有业务处理层）`);
    assert.ok(!/\.\s*(create|update|delete)\s*\(\s*['"](?:sales|payment|inventory)/.test(source),
      `${rel} 不许出现"直接写某张表"的调用`);
    assert.ok(!/inventoryService|InventoryService/.test(source),
      `${rel} 不许自己碰库存（出库走 SalesDeliveryService.deliver）`);
  }
  const actionSource = stripComments(readSrc('services/workbenchOrderActionService.js'));
  assert.ok(actionSource.includes('afterSalesExecutor.execute('), '售后必须调既有 AfterSalesService.execute');
  assert.ok(actionSource.includes('AfterSalesService'), '接线层必须复用既有 AfterSalesService');
  // 三个动作的取值只从既有配置来（不在这里写中文动作名 / 不自己造状态）
  assert.ok(actionSource.includes("require('../config/afterSales')"), '动作枚举取自 config/afterSales（配置先行）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC7 / AC8 鉴权语义不变 · 失败有人话
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'workbench_orders_test_secret';
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

const appWith = ({ followup, orderActions, purchaseArrival } = {}) => {
  const app = express();
  app.use(express.json());
  app.use('/api/workbench', createWorkbenchRouter({
    gateway: {},
    followup: followup || { gateway: {}, listOrders: async () => ({ orders: [], methods: [] }) },
    orderActions: orderActions || {
      afterSales: async () => { throw new Error('不该被调用'); },
      secondDelivery: async () => { throw new Error('不该被调用'); },
    },
    purchaseArrival: purchaseArrival || {
      confirmArrival: async () => { throw new Error('不该被调用'); },
    },
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const post = (base, url, body, cookie) => fetch(`${base}${url}`, {
  method: 'POST',
  headers: { ...(cookie ? { cookie } : {}), 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

test('AC7 鉴权语义不变：新接口都在既有闸门之内（未启用 503 / 未登录 401 / 白名单外 403）', async () => {
  const urls = [
    '/api/workbench/sales/after-sales',
    '/api/workbench/sales/second-delivery',
    // ⭐ 2026-10-09：采购子 tab 的「验收到货」也挂在**同一个** router 上（不新开鉴权）。
    '/api/workbench/purchase/arrivals/confirm',
  ];

  delete process.env.LARK_WEB_AUTH_ENABLED;
  await withServer(appWith(), async (base) => {
    for (const url of urls) {
      const response = await post(base, url, {}, sessionCookie());
      assert.equal(response.status, 503, `${url}：认证没启用时必须 503，即使带着会话 cookie`);
    }
  });

  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  await withServer(appWith(), async (base) => {
    for (const url of urls) {
      const response = await post(base, url, {});
      assert.equal(response.status, 401, `${url}：没登录必须 401`);
      assert.equal((await response.json()).auth_required, true);
    }
  });

  process.env.WORKBENCH_ALLOWED_OPEN_IDS = 'ou_allowed';
  try {
    await withServer(appWith(), async (base) => {
      for (const url of urls) {
        const response = await post(base, url, {}, sessionCookie('ou_other'));
        assert.equal(response.status, 403, `${url}：白名单外的飞书账号必须 403`);
      }
    });
  } finally {
    delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
  }
  delete process.env.LARK_WEB_AUTH_ENABLED;
});

test('AC8 失败有人话：业务拒绝的原因原样回到页面（不静默、也不糊成"系统错误"）', async () => {
  login();
  // ① 她填错的（statusCode=400）→ 400 + 原话
  const app400 = appWith({
    orderActions: {
      afterSales: async () => { throw Object.assign(new Error('请先勾选要处理的销售明细'), { statusCode: 400 }); },
      secondDelivery: async () => { throw new Error('收款方式不能为空'); },
    },
  });
  await withServer(app400, async (base) => {
    const response = await post(base, '/api/workbench/sales/after-sales', { action: 'return' }, sessionCookie());
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error, '请先勾选要处理的销售明细', '她填错的地方必须原样回到页面');
  });

  // ② 业务拒绝（既有业务层抛的，例如"钱留在我们这里"现在没有落点）→ 也是人话
  const appBusiness = appWith({
    orderActions: {
      afterSales: async () => { throw new Error('「客户往来货款」表已被整表删除：这笔售后不会写任何记录'); },
      secondDelivery: async () => { throw new Error('销售订单尚未确认入账'); },
    },
  });
  await withServer(appBusiness, async (base) => {
    const response = await post(base, '/api/workbench/sales/second-delivery', { salesEntryRecordId: 'order_1' }, sessionCookie());
    // 口径与 `workbenchInventoryAdjustmentRoute` 一致：她填错的 400；业务拒绝 502
    //（⚠️ 两种状态**都**把原因原样回到页面 —— 判据不是状态码，是"页面上看不看得见原因"）。
    assert.ok([400, 502].includes(response.status), `业务拒绝的状态码只能是 400 / 502，实际 ${response.status}`);
    assert.equal((await response.json()).error, '销售订单尚未确认入账', '业务拒绝的原因也必须让人看见');
  });

  // ③ 前端把原因显示在页面上（不静默吞掉）
  const source = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(source.includes('describeError'), '渲染层必须把失败原因写给人看（core/ui 的 describeError）');
  assert.ok(/role="status"|role="alert"/.test(readWorkbench('features/orders/index.js')),
    '动作结果必须有 role="status" / role="alert" 的可见落点');
  assert.ok(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(source), '不许空 catch 静默吞错');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC9 子 tab：销售 / 采购（选中态与切换自己实现，一级 tab 一个字不动）
// ═══════════════════════════════════════════════════════════════════════════

test('AC9 订单列表内部两个子 tab：销售 / 采购 —— 选中态与切换自己实现（一级 tab 不动）', async () => {
  const { config, orders } = loadFrontendModules();
  const [frontConfig, module] = await Promise.all([config, orders]);

  // ① 子 tab 清单来自配置（配置先行：加减 / 改名只改 config/orders.js）
  assert.deepEqual(frontConfig.ORDERS_SUB_TABS.map((item) => item.value), ['sales', 'purchase']);
  assert.deepEqual(frontConfig.ORDERS_SUB_TABS.map((item) => item.label), ['销售', '采购']);

  // ② 选中态：默认「销售」；切到「采购」时选中态跟着走（同一份渲染函数）
  const salesHtml = module.subTabsHtml('sales');
  const salesButtons = [...salesHtml.matchAll(/<button class="([^"]*)"[^>]*data-subtab="([^"]*)"[^>]*>([^<]*)</g)];
  assert.deepEqual(salesButtons.map((item) => item[2]), ['sales', 'purchase'], '两个子 tab 按钮都在');
  assert.ok(salesButtons[0][1].includes('active'), '默认选中「销售」');
  assert.ok(!salesButtons[1][1].includes('active'), '没选中的子 tab 不许带 active');

  const purchaseHtml = module.subTabsHtml('purchase');
  const purchaseButtons = [...purchaseHtml.matchAll(/<button class="([^"]*)"[^>]*data-subtab="([^"]*)"[^>]*>([^<]*)</g)];
  assert.ok(!purchaseButtons[0][1].includes('active'), '切到采购后，销售不再是选中态');
  assert.ok(purchaseButtons[1][1].includes('active'), '切到采购后，「采购」是选中态');

  // ③ 切换：纯状态机 —— 认不出的按钮原样不动（不瞎切、也不报错）
  assert.equal(module.resolveSubTab('sales', 'purchase'), 'purchase');
  assert.equal(module.resolveSubTab('purchase', 'sales'), 'sales');
  assert.equal(module.resolveSubTab('sales', 'bogus'), 'sales', '认不出的子 tab 不许把页面切走');

  // ④ 一级 tab 一个字不动：这份实现里不许出现 main-tab / MAIN_TABS
  const source = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(!/main-tab|MAIN_TABS/.test(source), '子 tab 的实现不许碰一级 tab');
  assert.ok(source.includes('data-subtab'), '子 tab 走容器上的 data-subtab 事件委托');
  assert.ok(source.includes('resolveSubTab('), '切换必须走那个纯状态机（不是就地改字符串）');
  // 一级 tab 清单仍是逐字三个（与 workbenchTwoTabsAndQueryEntries.test.js 的 AC1 同一口径）
  assert.deepEqual((await loadFrontendTabs()).map((tab) => tab.label), ['信息录入', '信息查询', '订单列表']);
});

/** 一级 tab 清单（只读 config/tabs.js；用来证明子 tab 那件事没动它）。 */
async function loadFrontendTabs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-orders-tabs-'));
  fs.copyFileSync(path.join(WORKBENCH, 'config/tabs.js'), path.join(dir, 'tabs.mjs'));
  return (await import(pathToFileURL(path.join(dir, 'tabs.mjs')).href)).MAIN_TABS;
}

// ═══════════════════════════════════════════════════════════════════════════
// AC10 销售子 tab：钱货两清 / 有二次（货未交付 · 资金未收 · 两者都有）
// ═══════════════════════════════════════════════════════════════════════════

/** 只用**既有字段的真实取值**造一单（不新增枚举）：履约状态 × 收款状态。 */
const orderWith = (fulfillment, payment) => ({
  ...ORDER, fulfillment_status: fulfillment, payment_status: payment,
});

test('AC10 销售四类判定：只用既有字段与取值（履约状态 / 收款状态），不造状态', async () => {
  const { config, orders } = loadFrontendModules();
  const [frontConfig, module] = await Promise.all([config, orders]);

  // 分类的键与文案来自配置（四类，顺序固定）
  assert.deepEqual(frontConfig.SALES_GROUPS.map((group) => group.key),
    ['settled', 'undelivered', 'unpaid', 'both']);
  // ⭐ 判据的两个取值必须是**既有字段上真实存在的字面量**（出处：services/salesProgressService.js）
  assert.equal(frontConfig.DELIVERED_FULFILLMENT, '已交付');
  assert.equal(frontConfig.PAID_PAYMENT_STATUS, '已收款');

  // ① 钱货两清 = 履约「已交付」且收款「已收款」
  assert.equal(module.salesCategoryOf(orderWith('已交付', '已收款')), 'settled');
  // ② 有二次·货未交付 = 货没交完（未交付 / 部分交付），钱已收清
  assert.equal(module.salesCategoryOf(orderWith('未交付', '已收款')), 'undelivered');
  assert.equal(module.salesCategoryOf(orderWith('部分交付', '已收款')), 'undelivered');
  // ③ 有二次·资金未收 = 货交付了，钱没收清（未收款 / 部分收款 / 待平台结算 / 空）
  assert.equal(module.salesCategoryOf(orderWith('已交付', '未收款')), 'unpaid');
  assert.equal(module.salesCategoryOf(orderWith('已交付', '部分收款')), 'unpaid');
  assert.equal(module.salesCategoryOf(orderWith('已交付', '待平台结算')), 'unpaid',
    '平台还没结算 = 钱还没到我们账上，不算钱货两清');
  assert.equal(module.salesCategoryOf(orderWith('已交付', '')), 'unpaid',
    '收款状态读不出来（成交金额缺失）时**不许硬说成两清**，归到钱那一侧');
  // ④ 有二次·两者都有 = 两边都没结清
  assert.equal(module.salesCategoryOf(orderWith('未交付', '未收款')), 'both');
  assert.equal(module.salesCategoryOf(orderWith('部分交付', '部分收款')), 'both');

  // 分组渲染：四类都在（空的那类也画出来，她一眼看到"这一类现在没有单"）
  const fixtures = [
    orderWith('已交付', '已收款'),
    orderWith('未交付', '已收款'),
    orderWith('已交付', '未收款'),
    orderWith('部分交付', '部分收款'),
  ];
  const groups = module.groupSalesOrders(fixtures);
  assert.deepEqual(groups.map((group) => group.key), ['settled', 'undelivered', 'unpaid', 'both']);
  assert.deepEqual(groups.map((group) => group.orders.length), [1, 1, 1, 1]);
  assert.deepEqual(module.groupSalesOrders([]).map((group) => group.orders.length), [0, 0, 0, 0]);

  const board = module.ordersBoardHtml(fixtures);
  for (const group of frontConfig.SALES_GROUPS) {
    assert.ok(board.includes(`data-sales-group="${group.key}"`), `四类分组必须都渲染出来：${group.key}`);
    assert.ok(board.includes(group.label), `分组标题逐字来自配置：${group.label}`);
  }

  // ⭐ 每一类都能操作售后：每张卡都能进**既有**详情入口，详情里是既有售后入口（退 / 换 / 赔）
  for (const group of module.groupSalesOrders(fixtures)) {
    const html = module.ordersBoardHtml(group.orders);
    assert.ok(html.includes('data-action="open-order"'), `「${group.label}」这一类必须能点进单子`);
  }
  for (const fixture of fixtures) {
    const detail = module.orderDetailHtml(fixture, { methods: ['微信', '现金'] });
    for (const action of ['return', 'exchange', 'compensation']) {
      assert.ok(detail.includes(`value="${action}"`), '售后动作仍是既有三件套（退 / 换 / 赔）');
    }
    assert.ok(detail.includes('data-action="submit-after-sales"'), '售后提交按钮复用既有那一套');
  }

  // ⑤ 不造状态：源码里不许出现自造的"两清 / 已付清"之类字面量
  const source = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(!/已两清|钱货未清|已付清|未付清|已交清/.test(source), '不许自己造状态文案');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC11 采购子 tab：一张采购申请/报货批次一行 + 「验收到货」按钮
// ═══════════════════════════════════════════════════════════════════════════

const PURCHASE_ROWS = [
  { record_id: 'pr1', batch_no: 'CGD-20261009-0001', product_number: 'XHB8095', size: 38, quantity: 2, arrival_status: '未到货' },
  { record_id: 'pr2', batch_no: 'CGD-20261009-0001', product_number: 'XHB8095', size: 39, quantity: 1, arrival_status: '未到货' },
  { record_id: 'pr3', batch_no: 'CGD-20261008-0002', product_number: 'YD6693', size: 40, quantity: 3, arrival_status: '已到货' },
];

test('AC11 采购子 tab：按报货批次一张一行，字段口径与既有采购页一致，每行有「验收到货」按钮', async () => {
  const { orders } = loadFrontendModules();
  const module = await orders;

  // 一张报货批次 = 一行（3 条申请明细 → 2 行）
  assert.deepEqual(module.groupPurchaseOrders(PURCHASE_ROWS).map((batch) => batch.batch_no),
    ['CGD-20261009-0001', 'CGD-20261008-0002']);

  const html = module.purchaseOrdersHtml(PURCHASE_ROWS);
  assert.equal((html.match(/data-purchase-batch=/g) || []).length, 2, '一条报货批次 = 一行');
  // 字段口径与既有「采购管理」的报货信息面板一致：批次号 / 货品编号 / 尺码 / 数量 / 到货状态
  assert.ok(html.includes('CGD-20261009-0001') && html.includes('CGD-20261008-0002'));
  assert.ok(html.includes('XHB8095') && html.includes('YD6693'), '货品编号');
  assert.ok(/38\s*码/.test(html) && /40\s*码/.test(html), '尺码');
  assert.ok(html.includes('未到货') && html.includes('已到货'), '到货状态来自既有字段（不造词）');
  // 每行都有「验收到货」按钮 + 一个收「实际金额」的表单（金额是既有必填口径）
  assert.equal((html.match(/data-action="verify-arrival"/g) || []).length, 2, '每一行都有一个验收按钮');
  assert.equal((html.match(/data-action="submit-arrival"/g) || []).length, 2, '每一行都有提交按钮');
  assert.equal((html.match(/data-field="arrival-amount"/g) || []).length, 2, '每一行都收「实际金额」');
  assert.ok(!/<table/i.test(html), '采购子 tab 也不许用 <table>（手机上会横向滚动）');
  assert.ok(module.purchaseOrdersHtml([]).includes('purchase-empty'), '空列表给人话');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC12 验收到货：复用既有到货核对/入库链路 + 零新写库
// ═══════════════════════════════════════════════════════════════════════════

test('AC12 「验收到货」：接线层只把这一批交给既有核对链路（confirmBatchArrival → confirmArrival）', async () => {
  const calls = [];
  const service = new WorkbenchPurchaseArrivalService({
    purchaseQuery: {
      listPurchaseRequests: async (filters) => {
        calls.push({ kind: 'list', filters });
        return [
          { record_id: 'pr1', batch_no: 'B1', report_behavior: 'purchase_request' },
          { record_id: 'pr2', batch_no: 'B1', report_behavior: 'purchase_request' },
        ];
      },
    },
    arrivalConversation: {
      confirmBatchArrival: async (input) => {
        calls.push({ kind: 'confirm', input });
        return { ok: true, reason: 'posted', message: '已入库 2 行' };
      },
    },
  });

  const result = await service.confirmArrival({
    batchNo: 'B1', actualAmount: 1200, acceptanceText: '跟单子一样', operatorOpenId: 'ou_1',
  });
  assert.equal(result.message, '已入库 2 行');
  // 只读既有查询拿到这一批的申请行 id（不自己读表、不自己算明细）
  assert.deepEqual(calls[0].filters, { batchNo: 'B1', reportBehavior: 'purchase_request' },
    '采购退货单不在验收范围内（用既有 reportBehavior 过滤）');
  // 原样交给既有对话式核对那条路：批次身份 + 她填的金额与原话 + 操作人
  assert.deepEqual(calls[1].input.batch.request_ids, ['pr1', 'pr2']);
  assert.equal(calls[1].input.batch.batch_no, 'B1');
  assert.equal(calls[1].input.actualAmount, 1200);
  assert.equal(calls[1].input.acceptanceText, '跟单子一样');
  assert.equal(calls[1].input.operatorOpenId, 'ou_1');

  // 空批次 / 找不到明细：人话拒绝且**一次都没调**核对链路
  const refused = new WorkbenchPurchaseArrivalService({
    purchaseQuery: { listPurchaseRequests: async () => [] },
    arrivalConversation: { confirmBatchArrival: async () => { throw new Error('不该被调用'); } },
  });
  await assert.rejects(() => refused.confirmArrival({ batchNo: 'B9', actualAmount: 1 }), /没找到报货批次/);
  await assert.rejects(() => refused.confirmArrival({ batchNo: '' }), /批次/);

  // ── 源码哨兵：接线层没有任何新写库实现 ─────────────────────────────────────
  for (const rel of ['services/workbenchPurchaseArrivalService.js', 'routes/workbenchOrderActions.js']) {
    const source = stripComments(readSrc(rel));
    assert.ok(!/\bgateway\s*\.\s*(create|update|delete|batchCreate|batchUpdate)\s*\(/.test(source),
      `${rel} 不许直接写库（一切写入走既有业务处理层）`);
    assert.ok(!/inventoryService|InventoryService|applyPurchase/.test(source),
      `${rel} 不许自己碰库存（加库存归既有 InventoryService，由 confirmArrival 调）`);
  }
  const serviceSource = stripComments(readSrc('services/workbenchPurchaseArrivalService.js'));
  assert.ok(serviceSource.includes('confirmBatchArrival('), '必须交给既有到货核对服务的薄方法');
  assert.ok(!/buildPlan|applyPurchase|writeAcceptance|markConfirmed/.test(serviceSource),
    '接线层不许自己算计划 / 自己写批次行 / 自己入库');

  // ── 那个薄方法本身也**没有**第二套算法：复用既有 loadRequestRows / buildPlan / confirmLocked
  const conversation = stripComments(readSrc('services/purchaseArrivalConversationService.js'));
  assert.ok(conversation.includes('this.loadRequestRows(batch)'), '复用既有只读读行（loadRequestRows）');
  assert.ok(conversation.includes("buildPlan(snapshot.rows, { same: true, differences: [] })"),
    '「全部按申请数到货」复用既有 buildPlan 的 same 分支，不新增第二条算法');
  assert.ok(conversation.includes('this.confirmLocked(taskId, operatorOpenId)'),
    '建草稿 + 入库仍然走既有 confirmLocked（→ PurchaseWebhookService.confirmArrival）');
});

test('AC12b confirmBatchArrival：种进同一批的会话任务 → 既有 confirmLocked → 注入的 confirmArrival 收到真实草稿', async () => {
  // 走**真实**服务（只有最外层的 confirmArrival 用桩 —— 它代表既有 PurchaseWebhookService）
  const gateway = fakeGateway({
    purchaseRequest: [
      { record_id: 'pr1', fields: { 编号: ['p1'], 尺码: ['size_38'], 数量: 2 } },
    ],
    product: [{ record_id: 'p1', fields: { 货号: 'XHB8095', 颜色: '黑' } }],
    sizeManagement: [{ record_id: 'size_38', fields: { 尺码: 38 } }],
  });
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-arrival-')), idField: 'task_id',
  });
  const confirmed = [];
  const arrived = [];
  const service = new PurchaseArrivalConversationService({
    gateway,
    store,
    // ⚠️ 这个 service 的 `sizeReferences` 要的是**取值函数**（与 larkMvpService 传的是同一个
    //    `PurchaseWebhookService.getSizeReferences`），不是解析器本身。
    sizeReferences: () => ARRIVAL_SIZE_STUB,
    confirmArrival: async (taskId, task, operatorOpenId) => {
      confirmed.push({ taskId, task, operatorOpenId });
      return { toast: { type: 'success', content: '采购已入库，库存已更新' } };
    },
    markBatchArrived: async (batchNo, options) => { arrived.push({ batchNo, options }); return { updated: true }; },
  });

  const result = await service.confirmBatchArrival({
    batch: { batch_no: 'B1', request_ids: ['pr1'] },
    acceptanceText: '跟单子一样，全部到货',
    actualAmount: 1200,
    operatorOpenId: 'ou_1',
  });
  assert.equal(result.ok, true);
  // ① 真的调了既有入库能力，草稿形状就是既有 confirmArrival 一直在等的那一份
  assert.equal(confirmed.length, 1, 'confirmArrival 必须被调到（且只一次）');
  assert.deepEqual(confirmed[0].task.draft.actual, [
    { product_record_id: 'p1', item_no: 'XHB8095', color: '黑', size: 38, quantity: 2 },
  ], '「全部按申请数到货」= 实际数 = 申请数（复用既有 buildPlan）');
  assert.equal(confirmed[0].task.draft.actual_amount, 1200, '她填的实际金额原样进草稿');
  assert.equal(confirmed[0].task.draft.acceptance_text, '跟单子一样，全部到货', '验收原话是她给的那句');
  assert.equal(confirmed[0].task.draft.batch_no, 'B1');
  assert.equal(confirmed[0].operatorOpenId, 'ou_1');
  // ② 到货状态仍由既有 markBatchArrived 写（本方法不自己写批次行）
  assert.deepEqual(arrived.map((item) => item.batchNo), ['B1']);

  // ③ 幂等：同一批再来一次（已入库）→ 不再调入库能力
  await store.update(confirmed[0].taskId, { status: 'posted' });
  const again = await service.confirmBatchArrival({
    batch: { batch_no: 'B1', request_ids: ['pr1'] }, acceptanceText: '再来一次', actualAmount: 1200,
  });
  assert.equal(again.ok, true);
  assert.equal(again.reason, 'already_posted');
  assert.equal(confirmed.length, 1, '已经入库过的批次不重复入库');

  // ④ 金额必填（既有业务口径）：缺失 / 非数字 / 0 与负数 —— 一个字都不写
  const before = confirmed.length;
  for (const bad of [undefined, '', 'abc', 0, -5]) {
    const denied = await service.confirmBatchArrival({
      batch: { batch_no: 'B2', request_ids: ['pr1'] }, acceptanceText: 'x', actualAmount: bad,
    });
    assert.equal(denied.ok, false, `金额 ${JSON.stringify(bad)} 必须被拒`);
  }
  assert.equal(confirmed.length, before, '金额不合法 ⇒ 一次入库都没发生');

  // ⑤ 退货批次（明细没有尺码）/ 空批次：人话拒绝，不猜
  const noRows = await service.confirmBatchArrival({ batch: { batch_no: 'B3' }, acceptanceText: 'x', actualAmount: 1 });
  assert.equal(noRows.ok, false);
  assert.match(noRows.message, /明细/);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC13 验收失败有人话 + 路由把原因原样带回页面
// ═══════════════════════════════════════════════════════════════════════════

test('AC13 「验收到货」路由：走既有闸门、原因原样回到页面（不静默、不糊成系统错误）', async () => {
  login();
  // ① 走通：批次 + 金额 + 原话原样进接线层，操作人取登录会话
  const calls = [];
  const okApp = appWith({
    purchaseArrival: {
      confirmArrival: async (input) => { calls.push(input); return { message: '已入库 2 行', alreadyPosted: false }; },
    },
  });
  await withServer(okApp, async (base) => {
    const response = await post(base, '/api/workbench/purchase/arrivals/confirm', {
      batchNo: 'B1', actualAmount: 1200, acceptanceText: '跟单子一样',
    }, sessionCookie());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.message, '已入库 2 行');
  });
  assert.deepEqual(calls[0], {
    batchNo: 'B1', actualAmount: 1200, acceptanceText: '跟单子一样', operatorOpenId: 'ou_test_user',
  });

  // ② 她填错的（statusCode=400）→ 400 + 原话
  const badApp = appWith({
    purchaseArrival: {
      confirmArrival: async () => {
        throw Object.assign(new Error('请先填这次的「实际金额」，再点验收到货'), { statusCode: 400 });
      },
    },
  });
  await withServer(badApp, async (base) => {
    const response = await post(base, '/api/workbench/purchase/arrivals/confirm', { batchNo: 'B1' }, sessionCookie());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '请先填这次的「实际金额」，再点验收到货');
  });

  // ③ 业务拒绝（入库失败）→ 502 + 原话
  const failApp = appWith({
    purchaseArrival: {
      confirmArrival: async () => { throw new Error('「报货批次」里找不到这一批（B1），确认状态没地方落'); },
    },
  });
  await withServer(failApp, async (base) => {
    const response = await post(base, '/api/workbench/purchase/arrivals/confirm', { batchNo: 'B1' }, sessionCookie());
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /找不到这一批/);
  });

  // ④ 前端把原因写给她看（复用既有 describeError + role=status 落点）
  const source = stripComments(readWorkbench('features/orders/index.js'));
  assert.ok(source.includes('submitArrival'), '渲染层必须有验收提交的处理');
  assert.ok(source.includes('describeError'), '失败原因必须原样显示（不静默）');
});
