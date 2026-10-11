/**
 * ⭐⭐ 扫码页「**一单多双 · 多次扫码**」的验收标准（业务负责人 **2026-10-11**）。
 *
 * 她的原话（逐字）：
 *   「因为比如说我们在**扫码页卖了多双鞋**的时候，怎么可以**一双订单多次扫码**呢？」
 *
 * 现状（先自己核过）：`/s/{编号}` 每次扫一个码打开**一款**的页面；点【加入本单】把这一双
 * 写进**扫码会话**（`services/scanSessionService.js`，`data/scan_sessions/`），
 * 最后【提交这一单】生成一张销售单。三个缺口：
 *   ① 加完本单**没有"继续扫下一个"的入口**（要退回去再扫，容易漏扫 / 忘了提交）；
 *   ② **看不到"本单已经有几双"**；
 *   ③ 扫到第 3 个码时，**【提交这一单】在别的页面上**（第 1 个码那一页），得回去找。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-DB1 **每个扫码页（任意领域）顶部固定一条"本单条"**：显示 `本单：N 双`
 *         （N 从扫码会话实时读；**跨编号共用**同一份会话 ⇒ 扫 A、扫 B 是同一个 N）。
 *  AC-DB2 **【提交这一单】有草稿才出现**（没有草稿时**不是**灰按钮，而是**不渲染**）；
 *         出现时是一个**真能提交**的表单（带 `action=submit_order` + 那一轮的幂等键）。
 *  AC-DB3 **【加入本单】成功后**：本单条立即反映 **N+1**，并在条内给一句**极简**反馈
 *         （`已加入本单（2 双）`）—— **不留说明书**（她 2026-10-10 的硬要求）；
 *         反馈旁边就是【继续扫下一个】/【提交这一单】。
 *  AC-DB4 **【继续扫下一个】**：飞书**手机**客户端内 = **可点的扫一扫 AppLink**
 *         （`https://applink.feishu.cn/client/qrcode/main`，官方文档实查过）；
 *         **电脑 / 手机自带浏览器** = **一句如实的人话**（`scanNextHint`）——
 *         **绝不给一个点了没反应的按钮**（她 2026-10-11 的硬要求）。
 *  AC-DB5 **跨编号累积**（"多次扫码"的命门）：扫 A 加单 → 扫 B 加单 ⇒ 本单继续累积
 *         （不是每次新开一单）。⚠️ 会话 key 核过是**按人（登录会话）**、
 *         不是按编号 ⇒ 这一条本来就成立，本 AC 把它**钉住**，防止将来被改成按编号隔离。
 *         HTTP 那一条（走真实路由 + 真实会话 + 真实业务层）在
 *         `scanPageWrite.test.js` 的『AC-DB5 ⭐ 一单多双 · 多次扫码』里。
 *  AC-DB6 **提交后**：本单条归零（【提交这一单】跟着消失），成功页照旧（单号 / 双数），
 *         而且成功页是"结果页"、**不挂本单条**（既有形状不变）。
 *  AC-DB7 **【加入本单】的 303 回跳停在本单所在的领域**：表单 action 带上 `?from=`
 *         （2026-10-11 修的一处：原来 action 漏传 realm，回跳会掉到缺省领域）。
 *  AC-DB8 **默认领域 = 销售**（她 2026-10-11：「默认打开是销售页」）+ 领域切换四个值照旧可用。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// `routes/scanPage` → … → `services/larkMvpService` 在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_draft_bar_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_draft_bar_secret';

const { renderScanPage, renderScanMessagePage, canScanNextWithFeishu } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, fillText } = require('../src/config/scanWrite');
const { DEFAULT_REALM, resolveRealm, REALMS } = require('../src/views/scanPageRealm');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan_draft_bar_session_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
/** 飞书手机客户端的真机 UA 形状（`Lark/x` + Android/iOS 关键字）。 */
const FEISHU_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148 Lark/7.20.0';
/** 飞书**桌面**端（官方文档：扫一扫 PC 端不支持）—— 也带 `Lark/x`，但**不是**手机。 */
const FEISHU_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Lark/7.20.0';
const PLAIN_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
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

const line = (size, itemNo = 'YD6693-2') => ({
  number: NUMBER, item_no: itemNo, color: '黑色', product_record_id: 'prod_1', size, amount: 399,
});

/** 写上下文：形状照路由给渲染层的那一份（文案直接用**真配置**，才测得到"没有说明书"）。 */
const WRITE = (lines = [], overrides = {}) => ({
  enabled: true,
  saleEnabled: true,
  replenishEnabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: `/s/${ENCODED}?from=inventory`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  notice: '',
  ...overrides,
});

const pageFor = (realm, write, userAgent) => renderScanPage(VIEW, SCAN_PAGE, write, realm, { userAgent });

/** 取页面里「本单条」那一段（收在它自己的 `</section>`）。 */
const barOf = (html) => {
  const start = html.indexOf('data-view="draft-bar"');
  assert.ok(start > -1, '页面里没有本单条（data-view="draft-bar"）');
  const end = html.indexOf('</section>', start);
  return html.slice(html.lastIndexOf('<section', start), end > -1 ? end : html.length);
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB1 每个领域页顶部都有本单条：本单：N 双
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB1 本单条在**每个领域**页面的**顶部**：显示 `本单：N 双`（N 来自扫码会话，跨编号共用）', () => {
  // ① 文案与占位符在配置里（唯一真源）
  assert.equal(SCAN_PAGE.texts.draftBarCount, '本单：{count} 双');
  assert.equal(fillText(SCAN_PAGE.texts.draftBarCount, { count: 2 }), '本单：2 双');

  // ② 四个领域都渲染出这一条，而且它在**领域块之前**（= 顶部）
  for (const realm of REALMS.map((item) => item.id)) {
    const html = pageFor(realm, WRITE([line(40), line(41, 'XHB8095')]));
    const bar = barOf(html);
    assert.ok(bar.includes('本单：2 双'), `realm=${realm} 的本单条没有"N 双"：${bar}`);
    assert.ok(bar.includes('data-view="draft-bar"'));
    assert.ok(html.indexOf('data-view="draft-bar"') < html.indexOf(`realm-block--${realm}"`),
      `realm=${realm} 的本单条必须在领域块**之前**（顶部）`);
  }

  // ③ 没有草稿 = 0 双（也照样有这一条，她一扫开就知道"这一单还空着"）
  assert.ok(barOf(pageFor('inventory', WRITE([]))).includes('本单：0 双'));
  // ④ 连"没有写上下文"（拿不到身份）时这一条也在（绝不留白），N 认成 0。
  assert.ok(barOf(pageFor('sales', null)).includes('本单：0 双'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB2 有草稿才出现【提交这一单】（不是灰按钮）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB2 【提交这一单】**有草稿才出现**（没有草稿时不渲染，不是灰按钮）；出现时真能提交', () => {
  const submitText = SCAN_WRITE.texts.submitButton;
  // ① 没有草稿 ⇒ 本单条里**没有**提交按钮（也没有那个表单的痕迹）
  const empty = barOf(pageFor('inventory', WRITE([])));
  assert.equal(empty.includes(submitText), false, '没有草稿时不许出现【提交这一单】');
  assert.equal(empty.includes('<button'), false, '没有草稿时本单条里一个按钮都不该有');
  assert.equal(empty.includes(SCAN_WRITE.actions.submitOrder), false);
  assert.equal(empty.includes('submit_key'), false);

  // ② 有草稿 ⇒ 是一个**真能提交**的表单：POST 目标 + 动作 + 幂等键
  const write = WRITE([line(40), line(41)]);
  const filled = barOf(pageFor('inventory', write));
  assert.ok(filled.includes(`action="${write.postAction}"`), '提交表单要 POST 回本单所在的领域');
  assert.ok(filled.includes(`value="${SCAN_WRITE.actions.submitOrder}"`), '动作 = submit_order');
  assert.ok(filled.includes(`value="${write.saleKey}"`), '表单里带着这一轮的幂等键');
  assert.match(filled, new RegExp(`<button type="submit"[^>]*>${submitText}</button>`));
  // ⚠️ 提交表单只带"动作 + 幂等键"：收款方式 / 金额留空 = 既有口径的"先货后钱"
  assert.equal(filled.includes(SCAN_WRITE.fields.paymentMethod), false,
    '本单条上的提交不带收款字段（要记钱回【销售】那一块的表单）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB3 加单成功：N+1 + 一句极简反馈（不留说明书）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB3 【加入本单】成功后：本单条立即变成 N+1 + 一句极简反馈（`已加入本单（2 双）`）', () => {
  // ① 反馈文案是**极简**的那一句（她 2026-10-11 的例子），而且旧的长句必须不在
  assert.equal(SCAN_WRITE.texts.lineAddedBanner, '已加入本单（{count} 双）');
  assert.equal(fillText(SCAN_WRITE.texts.lineAddedBanner, { count: 2 }), '已加入本单（2 双）');
  assert.equal(/已加入本单：现在共/.test(JSON.stringify(SCAN_WRITE.texts)), false,
    '旧那句「已加入本单：现在共 N 双。」必须退场（她：不要写说明书）');

  // ② 回跳落在同一个领域时：条里的 N 已经是加完之后的值，反馈就在条里（旁边就是两颗按钮）
  const write = WRITE([line(40), line(41, 'XHB8095')], {
    notice: fillText(SCAN_WRITE.texts.lineAddedBanner, { count: 2 }),
  });
  for (const realm of REALMS.map((item) => item.id)) {
    const bar = barOf(pageFor(realm, write, FEISHU_MOBILE_UA));
    assert.ok(bar.includes('本单：2 双'), `realm=${realm}：加完之后条里还是旧数字`);
    assert.ok(bar.includes('已加入本单（2 双）'), `realm=${realm}：条里没有那句极简反馈`);
    assert.ok(bar.includes('继续扫下一个') && bar.includes(SCAN_WRITE.texts.submitButton),
      `realm=${realm}：反馈旁边就该是【继续扫下一个】/【提交这一单】`);
  }

  // ③ 反馈句里**只有数字**来自会话（不回显编号 / 货号之外的任何输入）
  const withLine = WRITE([line(40)], { notice: fillText(SCAN_WRITE.texts.lineAddedBanner, { count: 1 }) });
  assert.ok(barOf(pageFor('sales', withLine)).includes('已加入本单（1 双）'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB4 【继续扫下一个】：能调就真能调，调不了就明说人话
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB4 【继续扫下一个】：飞书手机客户端 = 扫一扫 AppLink；电脑 / 普通浏览器 = 人话（无死按钮）', () => {
  // ① 设备能力判据（服务端看 UA；页面上依然零 JS）
  assert.equal(SCAN_PAGE.scanNext.applink, 'https://applink.feishu.cn/client/qrcode/main',
    'AppLink 的唯一真源（飞书官方：打开扫一扫）');
  assert.equal(canScanNextWithFeishu(FEISHU_MOBILE_UA), true, '飞书手机客户端 ⇒ 能调起飞书扫一扫');
  assert.equal(canScanNextWithFeishu(FEISHU_DESKTOP_UA), false, '飞书桌面端 ⇒ 扫一扫 PC 端不支持');
  assert.equal(canScanNextWithFeishu(PLAIN_BROWSER_UA), false, '普通浏览器 ⇒ 没有扫码能力');
  assert.equal(canScanNextWithFeishu(''), false);
  assert.equal(canScanNextWithFeishu(undefined), false);

  // ② 飞书手机客户端：本单条里是**真链接**（点一下直接扫下一个）
  const inFeishu = barOf(pageFor('sales', WRITE([line(40)]), FEISHU_MOBILE_UA));
  assert.ok(inFeishu.includes(`href="${SCAN_PAGE.scanNext.applink}"`), '缺飞书扫一扫 AppLink');
  assert.ok(inFeishu.includes(SCAN_PAGE.texts.scanNextLabel), '缺【继续扫下一个】这几个字');

  // ③ 电脑 / 普通浏览器：**不给按钮**，只给一句如实的人话（她的硬要求：绝不允许点了没反应）
  for (const ua of [PLAIN_BROWSER_UA, FEISHU_DESKTOP_UA, '', undefined]) {
    const html = pageFor('sales', WRITE([line(40)]), ua);
    const bar = barOf(html);
    assert.equal(bar.includes(SCAN_PAGE.scanNext.applink), false,
      `UA=${String(ua)} 时不该给扫码 AppLink（电脑上没有扫码能力）`);
    assert.equal(bar.includes(SCAN_PAGE.texts.scanNextLabel), false,
      `UA=${String(ua)} 时不该把"继续扫下一个"画成一个假按钮`);
    assert.ok(bar.includes(SCAN_PAGE.texts.scanNextHint), `UA=${String(ua)} 时必须给出那句人话`);
  }
  assert.match(SCAN_PAGE.texts.scanNextHint, /扫一扫/, '那句人话要指名"用飞书的扫一扫"');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB5 跨编号累积（会话 key 核过：按人、不是按编号）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB5 跨编号累积：会话 key **按人（登录会话）**存，扫不同编号读到的是**同一份本单**', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scanSessionService.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // 会话 id = 前缀 + **录单人 open_id** 的哈希（不是编号）⇒ 一单跨款累积
  assert.match(code, /const idOf = \(openId\)/);
  assert.match(code, /createHash\('sha256'\)\.update\(String\(openId \|\| ''\)\)/);
  // 加单 / 读会话都只吃 openId（编号只是行上的一个字段，不参与 key）
  assert.match(code, /const addLine = async \(openId, line\)/);
  assert.match(code, /const get = async \(openId\)/);
  assert.equal(/idOf\(\s*number\s*\)/.test(code), false, '会话 id 不许按编号算（那会让每次换款都新开一单）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB6 提交之后：本单条归零 + 成功页照旧
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB6 提交之后：本单条归零（提交按钮跟着消失）；成功页照旧（单号 / 双数），且不挂本单条', () => {
  // ① 提交成功后服务端把会话复位（`completeSale` 把 lines 清空 + 幂等键轮换）⇒ 再打开这一页是 0 双
  const afterSubmit = barOf(pageFor('sales', WRITE([]), FEISHU_MOBILE_UA));
  assert.ok(afterSubmit.includes('本单：0 双'), '提交后本单条要归零');
  assert.equal(afterSubmit.includes(SCAN_WRITE.texts.submitButton), false, '提交后【提交这一单】要跟着消失');

  // ② 成功页（结果页）形状照旧：单号 + 双数都在；它是"结果页"，**不挂本单条**
  const done = renderScanMessagePage({
    title: SCAN_WRITE.texts.submittedTitle,
    body: fillText(SCAN_WRITE.texts.submittedBody, { orderNo: 'XSD-20261011-0001', count: 2 }),
    details: [
      fillText(SCAN_WRITE.texts.submittedOrderLine, { orderNo: 'XSD-20261011-0001' }),
      fillText(SCAN_WRITE.texts.submittedDetailLine, { count: 2 }),
    ],
    retryHint: SCAN_WRITE.texts.submittedNextHint,
  }, SCAN_PAGE);
  assert.ok(done.includes('这一单提交好了'));
  assert.ok(done.includes('XSD-20261011-0001'), '成功页照旧显示单号');
  assert.ok(done.includes('明细：2 双（每双一行）'), '成功页照旧显示双数');
  assert.equal(done.includes('data-view="draft-bar"'), false, '成功页是结果页，不挂本单条（既有形状不变）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB7 / AC-DB8 路由：303 回跳停在本单所在的领域 + 缺省领域 = 销售
// ═══════════════════════════════════════════════════════════════════════════

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_draft_bar_user') => {
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

/**
 * 一个"本单里已经有一双"的假写服务（只为路由那一层：渲染 / 303 回跳）。
 * 真写库那一条在 `scanPageWrite.test.js`（真会话 + 真业务层）。
 */
const fakeWriteService = () => {
  const state = { lines: [] };
  return {
    state,
    sessions: {
      get: async () => ({ sale: { key: 'scan_sale:scan_session_0123456789abcdef:1', lines: state.lines } }),
      submitKeyFor: () => 'scan_sale:scan_session_0123456789abcdef:1',
    },
    addSaleLine: async ({ size, itemNo, number }) => {
      state.lines = [...state.lines, { size: Number(size), item_no: itemNo, number }];
      return { ok: true, count: state.lines.length };
    },
    clearDraft: async () => ({ ok: true, count: 0 }),
    submitSale: async () => ({ ok: false, code: 'not_used' }),
  };
};

const fakeApp = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: {},
    writeService: write,
    startSnapshot: false,
  }));
  return app;
};

test('AC-DB7 【加入本单】的 303 回跳**停在本单所在的领域**（表单 action 带着 ?from=）', async () => {
  login();
  const write = fakeWriteService();
  await withServer(fakeApp(write), async (base) => {
    const bare = `${base}/s/${ENCODED}`;
    const inventoryUrl = `${base}/s/${ENCODED}?from=inventory`;
    const post = (url, body) => fetch(url, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    // ① 缺省（裸码）= 销售：表单 action **不带** `?from=`（URL 干净，见 `postActionFor`）
    const salesHtml = await (await fetch(bare, { headers: { cookie: sessionCookie() } })).text();
    assert.ok(salesHtml.includes('realm-block--sales'), '裸码扫开缺省 = 销售');
    assert.equal(salesHtml.match(/action="([^"]*)"/)[1], `/s/${ENCODED}`,
      '缺省领域（销售）的表单 action 不带 ?from=');
    const salesKey = salesHtml.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
    const added = await post(bare, { action: SCAN_WRITE.actions.addLine, submit_key: salesKey, size: '40' });
    assert.equal(added.status, 303);
    assert.match(String(added.headers.get('location')), /added=1$/, '缺省领域回跳不带 ?from=');

    // ② 切到【库存】：本单条上有【提交这一单】，它的 action 必须带上 `?from=inventory`
    const inventoryHtml = await (await fetch(inventoryUrl, { headers: { cookie: sessionCookie() } })).text();
    assert.ok(barOf(inventoryHtml).includes('本单：1 双'), '库存页顶部读得到销售页加的那一双');
    assert.ok(barOf(inventoryHtml).includes(SCAN_WRITE.texts.submitButton), '有草稿 ⇒ 库存页上也能提交');
    assert.match(inventoryHtml, new RegExp(`action="/s/${ENCODED}\\?from=inventory"`),
      '非缺省领域的表单 action 要带上领域');

    // ③ 从库存页加第二双：303 回跳仍是库存领域
    const inventoryKey = inventoryHtml.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
    const added2 = await post(inventoryUrl, { action: SCAN_WRITE.actions.addLine, submit_key: inventoryKey, size: '41' });
    assert.equal(added2.status, 303);
    assert.match(String(added2.headers.get('location')), /\?from=inventory&added=1$/,
      '回跳要停在本单所在的领域（不是缺省领域）');

    // ④ 回跳后那一页：本单 2 双 + 一句极简反馈
    const after = await (await fetch(`${inventoryUrl}&added=1`, { headers: { cookie: sessionCookie() } })).text();
    assert.match(after, /本单：2 双/);
    assert.match(after, /已加入本单（2 双）/);
  });
});

test('AC-DB8 默认领域 = **销售**；`?from=` 四个值照旧可用（认不出的回落销售）', () => {
  assert.equal(DEFAULT_REALM, 'sales', '她 2026-10-11：「默认打开是销售页」');
  for (const id of ['sales', 'inventory', 'purchase', 'product']) assert.equal(resolveRealm(id), id);
  for (const bad of [undefined, null, '', '   ', 'bogus', '库存']) {
    assert.equal(resolveRealm(bad), 'sales', `认不出的 from「${String(bad)}」必须回落缺省（销售）`);
  }
  // 渲染层不带 realm 参数 = 缺省 = 销售
  assert.ok(renderScanPage(VIEW, SCAN_PAGE, WRITE([])).includes('realm-block--sales'));
  assert.ok(renderScanPage(VIEW, SCAN_PAGE, WRITE([])).includes('realm-block--sales'),
    '认不出的领域也回落销售（不报错、不空白）');
  assert.ok(renderScanPage(VIEW, SCAN_PAGE, WRITE([]), '不存在的领域').includes('realm-block--sales'));
});
