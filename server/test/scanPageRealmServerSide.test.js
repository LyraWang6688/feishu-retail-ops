/**
 * ⭐⭐ 扫码页「**手机扫码不再白屏**」的验收标准（业务负责人 **2026-10-09** 真机反馈）。
 *
 * 她的现象（逐字要点）：**手机在飞书内置 webview 里扫开是一片空白**
 *（顶部有进度条、底部有刷新/分享/更多，**一个字都没有**）；**PC 正常**。
 * 线上日志已查明：**不是 302 循环、不是 CSS、不是令牌**（时间线见
 * `docs/` 那份报告与 `routes/scanPage.js` 的注释）——
 * 真正的原因是**首屏要等十几到二十几秒**，webview 那段时间就是一张白页，她没等到就先关了
 *（nginx `499`）。但那一版**还依赖 `<head>` 内联脚本 + CSS 显隐**，
 * 这在飞书 webview 里是**额外的一层不确定性**，本轮按她的口径把它整层拿掉。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-W1 **服务端按 `?from` 只渲染那一块**：`renderScanPage(view, config, write, realm)`
 *        只产出该领域的内容块；另外三块**连 HTML 都不进**（不是靠 CSS 藏起来）。
 *  AC-W2 **页面里一行前端脚本都没有**：没有 `<script>` / 没有 `location.search` /
 *        没有 `<html data-realm>`；不依赖任何前端执行。
 *  AC-W3 **领域切换 = 真链接**（`?from=<id>`，服务端 302/GET 跳转），当前那一颗高亮
 *        （`realm-tab--active` + `aria-current="page"`）—— 没有 JS 也能换领域。
 *  AC-W4 **没内容也绝不留白**：拿不到写上下文（`write=null`）时，销售领域渲染的是
 *        **一张人话卡片**（标题 + 说明 + 「看这一款的库存 →」），而不是空 div；
 *        每一页都有 `<noscript>` 兜底（无 JS 时四条领域链接照旧可点）。
 *  AC-W5 **任何异常都输出人话页**：渲染器抛错 → 路由回一张人话页（不是空白、不是 500 裸字）；
 *        `renderMinimalPage` 自己**不许抛**（最后一道兜底，任何输入都有正文）。
 *  AC-W6 **主题令牌读不到也不影响内容**：`readThemeTokens(不存在的文件)` 返回 `[]` 不抛；
 *        页面正文（身份区 / 领域块）一个字都不少。
 *  AC-W7 **路由按 `?from` 分派**：`?from=inventory|purchase|product|sales` 各自只出那一块，
 *        认不出的 `from` 回落销售（不报错、不空白）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_realm_ssr_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_realm_ssr_secret';

const {
  renderScanPage, renderScanMessagePage, renderMinimalPage, readThemeTokens, STYLE,
} = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { REALMS, DEFAULT_REALM, REALM_TEXTS } = require('../src/views/scanPageRealm');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan_realm_ssr_session_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_scan_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

const WRITE = {
  enabled: true,
  saleEnabled: true,
  replenishEnabled: true,
  texts: {
    saleHeading: '销售（可以连着扫，最后一起提交）',
    draftHeading: '本单现在 {count} 双',
    draftEmpty: '本单还没有鞋',
    draftItem: '{itemNo} {size} 码',
    amountLabel: '成交金额',
    amountPlaceholder: '不填按单价算',
    giftLabel: '赠品',
    addButton: '加入本单',
    paymentLabel: '收款方式',
    paymentAmountLabel: '收款金额',
    paymentAmountPlaceholder: '不填就是还没收钱',
    submitButton: '提交这一单',
    fundsPendingNote: '资金不是必填，之后可以在订单列表里补',
    clearButton: '清空本单',
    replenishHeading: '补货报单（勾选要补的尺码）',
    replenishHint: '打勾的尺码会生成采购申请；不填数量按 1 双算。',
    replenishQuantityLabel: '数量',
    replenishButton: '生成采购申请',
  },
  fields: {
    action: 'action',
    submitKey: 'submit_key',
    size: 'size',
    amount: 'amount',
    gift: 'gift',
    paymentMethod: 'payment_method',
    paymentAmount: 'payment_amount',
    replenishSizes: 'sizes',
    replenishQuantityPrefix: 'qty_',
  },
  actions: { addLine: 'add_line', submitOrder: 'submit_order', clearDraft: 'clear_draft', replenish: 'replenish' },
  postAction: `/s/${ENCODED}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};

/** 每个领域的"应该出现"与"绝不该出现"的正文（不看切换条与 `<noscript>` 里的链接文字）。 */
const EXPECT = {
  sales: { has: ['加入本单', '提交这一单'], hasNot: ['库存（共', '补货报单（勾选要补的尺码）', '货品标签'] },
  inventory: { has: ['库存（共 5 双）'], hasNot: ['加入本单', '补货报单（勾选要补的尺码）', '货品标签'] },
  purchase: { has: ['补货报单（勾选要补的尺码）', '一键补货'], hasNot: ['加入本单', '库存（共', '货品标签'] },
  product: { has: ['货品标签', '/workbench/label-print.html'], hasNot: ['加入本单', '库存（共', '补货报单（勾选要补的尺码）'] },
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-W1 / AC-W2 服务端按领域只渲染一块 + 一页零脚本
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W1 服务端按 `?from` 只渲染那一块：另外三块连 HTML 都不进（不是 CSS 藏起来）', () => {
  for (const realm of ['sales', 'inventory', 'purchase', 'product']) {
    const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);
    const body = html.slice(html.indexOf('</head>'));
    for (const [id, expect] of Object.entries(EXPECT)) {
      const wanted = id === realm;
      for (const needle of expect.has) {
        assert.equal(body.includes(needle), wanted,
          `realm=${realm} 时「${needle}」${wanted ? '必须' : '绝不该'}出现`);
      }
    }
    // 四块里只留了当前这一块的标记
    for (const id of ['sales', 'inventory', 'purchase', 'product']) {
      assert.equal(body.includes(`realm-block--${id}`), id === realm,
        `realm=${realm} 时 realm-block--${id} ${id === realm ? '必须' : '绝不该'}在 HTML 里`);
    }
  }
  // 缺省 = 销售（她的口径），认不出的也回落销售
  const fallback = renderScanPage(VIEW, SCAN_PAGE, WRITE);
  assert.ok(fallback.includes('realm-block--sales'), '不带 realm 参数时 = 缺省销售');
  assert.equal(fallback.includes('realm-block--inventory'), false);
  assert.equal(renderScanPage(VIEW, SCAN_PAGE, WRITE, '不存在的领域').includes('realm-block--sales'), true,
    '认不出的领域回落缺省，不报错、不空白');
});

test('AC-W2 页面里一行前端脚本都没有：不依赖任何前端执行（飞书 webview 也不怕）', () => {
  for (const realm of ['sales', 'inventory', 'purchase', 'product']) {
    const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);
    assert.equal(/<script[\s>]/i.test(html), false, '页面里不许有任何 <script>');
    assert.equal(html.includes('location.search'), false, '不许再读 location.search');
    assert.equal(/\sdata-realm\s*=\s*"/.test(html), false, '不许再有 <html data-realm> 那种靠属性显隐的写法');
    assert.equal(/on(click|load|submit)\s*=/i.test(html), false, '不许有内联事件');
  }
  // CSS 里也不再有"按 data-realm 显隐"的规则，更不会有"未设 realm 时全隐藏"那种白屏写法
  assert.equal(STYLE.includes('data-realm'), false, 'CSS 不许再依赖 data-realm');
  assert.equal(/\.realm-block[^{]*\{\s*display:\s*none/.test(STYLE), false,
    '不许再出现"领域块默认 display:none"（那正是白屏的写法）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W3 领域切换 = 真链接（服务端跳转）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W3 领域切换是真链接 `?from=<id>`，当前那一颗高亮（没有 JS 也能换领域）', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'inventory');
  // ⚠️ 只看 <body>：`<style>` 里也有 `.realm-tab--active` 这个选择器，别数到 CSS 上
  const body = html.slice(html.indexOf('</head>'));
  for (const realm of REALMS) {
    assert.ok(body.includes(`href="?from=${realm.id}"`), `缺 ${realm.id} 的真链接`);
    assert.ok(body.includes(`data-realm-id="${realm.id}"`), `缺 ${realm.id} 的标记`);
  }
  // 只有当前领域那一颗是 active（数一遍，别数错）
  const active = body.match(/realm-tab--active/g) || [];
  assert.equal(active.length, 1, '有且只有一颗按钮高亮');
  assert.match(body, /class="realm-tab realm-tab--active" data-realm-id="inventory" href="\?from=inventory" aria-current="page"/,
    '高亮的是当前领域，且带 aria-current');
  assert.match(STYLE, /\.realm-tab--active\s*\{[^}]*background:\s*var\(--primary\)/s, '高亮 = 主色（实体链接，不是脚本切 class）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W4 没内容也绝不留白 + noscript 兜底
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W4 拿不到写上下文时销售领域给一张人话卡片；每页都有 <noscript> 兜底', () => {
  const html = renderScanPage(VIEW, SCAN_PAGE, null, 'sales');
  assert.equal(html.includes('加入本单'), false, '没有写上下文就不该出现表单');
  assert.ok(html.includes(SCAN_PAGE.texts.realmEmptyTitle), '必须给一个人话标题');
  assert.ok(html.includes(SCAN_PAGE.texts.realmEmptySalesBody), '必须说清为什么没有表单');
  assert.ok(html.includes(SCAN_PAGE.texts.realmEmptyAction), '必须给一个下一步（去看库存）');
  assert.match(html, /href="\?from=inventory"/, '下一步就是领域切换的真链接');
  // 领域块仍然在（不是空 div）
  assert.match(html, /<div class="realm-block realm-block--sales">[\s\S]*?<h1>/, '销售块里必须真有人话内容');

  // 采购领域一个尺码都没有（连 `write.sizes` 也空 —— 页面上真的没东西可填）时同样不空白
  const noSizes = renderScanPage({ ...VIEW, rows: [] }, SCAN_PAGE, { ...WRITE, sizes: [] }, 'purchase');
  assert.ok(noSizes.includes(SCAN_PAGE.texts.realmEmptyTitle), '采购领域没清单时也要有人话');

  // noscript 兜底：四条领域链接照旧可点
  for (const realm of ['sales', 'inventory', 'purchase', 'product']) {
    const page = renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);
    assert.ok(page.includes('<noscript>'), `realm=${realm} 缺 <noscript> 兜底`);
    const noScript = page.slice(page.indexOf('<noscript>'), page.indexOf('</noscript>'));
    for (const other of REALMS) {
      assert.ok(noScript.includes(`href="?from=${other.id}"`), `<noscript> 里缺 ${other.id} 的链接`);
    }
    assert.ok(noScript.includes(REALM_TEXTS.noScriptHint), 'noscript 里要有一句人话');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W5 任何异常都输出人话页（绝不空白）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W5 渲染器抛错 → 路由回人话页；`renderMinimalPage` 自己绝不抛', async () => {
  login();
  const app = express();
  // 注入一个"一定会炸"的领域渲染器：路由必须接住并回人话页，而不是空白/裸 500
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ ...VIEW }) },
    render: {
      scan: () => { throw new Error('渲染炸了'); },
      message: renderScanMessagePage,
    },
  }));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/s/${ENCODED}`, { headers: { cookie: sessionCookie() } });
    assert.equal(response.status, 500);
    const html = await response.text();
    assert.match(html, /<html/i, '必须是 HTML');
    assert.ok(html.includes(SCAN_PAGE.texts.errorTitle), '要说人话（标题）');
    assert.ok(html.includes(SCAN_PAGE.texts.retryHint), '要给重试建议');
    assert.ok(html.replace(/<[^>]*>/g, '').trim().length > 0, '页面不能是空的（去掉标签后还有字）');
    assert.equal(html.includes('渲染炸了'), false, '内部异常细节不许回显');
  });

  // 最后一道兜底：任何输入都不抛，且一定有正文
  for (const input of [undefined, null, {}, { title: '<script>', body: '&<>"\'', requestId: 'r' }]) {
    const html = renderMinimalPage(input);
    assert.match(html, /^<!doctype html>/i);
    assert.ok(html.replace(/<[^>]*>/g, '').trim().length > 0, '兜底页必须有可见文字');
  }
  assert.equal(renderMinimalPage({ title: '<b>x</b>' }).includes('<b>x</b>'), false, '兜底页也要转义');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W6 主题令牌读不到也不影响内容
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W6 主题令牌文件读不到：不抛、`:root` 为空，但正文一个字不少', () => {
  assert.deepEqual(readThemeTokens('/definitely/not/here/tokens.css'), [], '读不到就是空表，绝不抛');
  assert.ok(STYLE.includes(':root'), ':root 那一层照旧在');
  // 内容不依赖任何令牌（显隐 / 可见性都不走变量）
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'inventory');
  assert.ok(html.includes('库存（共 5 双）') && html.includes('<h1 class="identity__item">YD6693-2</h1>'),
    '令牌有没有都不影响正文');
  assert.equal(/display:\s*none/.test(STYLE), false, 'CSS 里不许再有"默认藏起来"的写法（那是白屏的形状）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-W7 路由按 `?from` 分派
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W7 路由按 `?from` 分派（认不出的回落销售，任何情况都有正文）', async () => {
  login();
  const app = express();
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ ...VIEW }) },
    startSnapshot: false,
  }));
  const cases = [
    ['', 'sales', ['库存（共']],
    ['?from=sales', 'sales', ['库存（共']],
    ['?from=inventory', 'inventory', ['加入本单', '补货报单']],
    ['?from=purchase', 'purchase', ['加入本单', '库存（共']],
    ['?from=product', 'product', ['加入本单', '库存（共']],
    ['?from=这个领域不存在', 'sales', ['库存（共']],
  ];
  await withServer(app, async (base) => {
    for (const [query, realm, hasNot] of cases) {
      const response = await fetch(`${base}/s/${ENCODED}${query}`, { headers: { cookie: sessionCookie() } });
      assert.equal(response.status, 200, `${query} 必须是 200`);
      const html = await response.text();
      assert.ok(html.includes(`realm-block--${realm}`), `${query} 必须渲染 ${realm} 那一块`);
      for (const id of ['sales', 'inventory', 'purchase', 'product']) {
        if (id !== realm) assert.equal(html.includes(`realm-block--${id}`), false, `${query} 不该有 ${id} 块`);
      }
      for (const needle of hasNot) {
        assert.equal(html.includes(needle), false, `${query} 不该出现「${needle}」`);
      }
      assert.ok(html.replace(/<[^>]*>/g, '').trim().length > 0, `${query} 的页面必须有可见文字`);
    }
  });
});

test('AC-W7 领域切换走的是服务端：点切换条就是一次带 `?from=` 的新请求（没有前端路由）', async () => {
  login();
  const requested = [];
  const app = express();
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async (input) => { requested.push(input); return { ...VIEW }; } },
    startSnapshot: false,
  }));
  await withServer(app, async (base) => {
    const page = await fetch(`${base}/s/${ENCODED}?from=sales`, { headers: { cookie: sessionCookie() } });
    const html = await page.text();
    // 页面上的切换链接是一个**同路径的服务端地址**（浏览器点下去就是一次新的 GET）
    assert.match(html, /<a class="realm-tab[^"]*" data-realm-id="purchase" href="\?from=purchase"/);
    const switched = await fetch(`${base}/s/${ENCODED}?from=purchase`, { headers: { cookie: sessionCookie() } });
    assert.equal(switched.status, 200);
    assert.equal(requested.length, 2, '两次点击 = 两次服务端取数（没有前端缓存/路由）');
  });
});

test('AC-W4/W7 结果页（没找到 / 链接不对）也永远有人话（既有口径不许退化）', () => {
  const message = renderScanMessagePage({
    title: SCAN_PAGE.texts.notFoundTitle, body: SCAN_PAGE.texts.notFoundBody, number: 'NOPE|黑色|A', requestId: 'r1',
  });
  assert.ok(message.includes(SCAN_PAGE.texts.notFoundTitle) && message.includes('NOPE|黑色|A'));
  assert.equal(/<script[\s>]/i.test(message), false, '结果页也没有脚本');
  const messageBody = message.slice(message.indexOf('</head>'));
  assert.equal(messageBody.includes('realm-bar'), false, '结果页不挂领域切换条');
});

test('领域配置是唯一真源（加减领域只改 views/scanPageRealm.js）', () => {
  assert.deepEqual(REALMS.map((realm) => realm.id), ['sales', 'inventory', 'purchase', 'product']);
  assert.equal(DEFAULT_REALM, 'sales');
  // 领域文案也在配置里（渲染层不写死句子）
  for (const key of ['barLabel', 'barHint', 'noScriptHint', 'labelHeading']) {
    assert.equal(typeof REALM_TEXTS[key], 'string', `REALM_TEXTS.${key} 必须是文案`);
    assert.ok(REALM_TEXTS[key].length > 0);
  }
});
