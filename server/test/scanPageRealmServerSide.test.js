// ⭐⭐ 2026-10-14 晚（业务负责人逐字，**覆盖 10-13 的六领域口径**）：
//   「配品给迁移到工作台销售里…整体都迁移过去」＋「把上新 tab 也给去掉」
//   ⇒ 扫码页**只剩 4 个领域**：销售 · 补货 · 库存 · 退货 ✓
//   🔴 不是放宽 ✗：判据从"六个都在"翻成"**四个在 + 配品/上新必须不在**" ✓
/**
 * ⚠️ 2026-10-12 旧断言改写（**"零 JS"口径按业务负责人的要求改了**）：
 *  改前（逐字）：`assert.equal(/<script[\\s>]/i.test(html), false, '页面里一行前端脚本都没有');`
 *  改后（逐字）：**有提交按钮的页面**（销售提交 / 打印这一款）= 整页**只有那一段**
 *                `<script data-view="submit-feedback">`（只做"置灰 + 换文案 + 计时"）；
 *                **没有提交按钮的页面**（库存 / 货品无打印 / 补货 / 退货 / 验收）= **0 段**。
 *  理由：业务负责人真机（逐字）「点完之后**没有 Toast、按键置灰**之类的提示，页面完全没有
 *        及时的交互反馈 ⇒ 我不知道指令到底有没有到达，**就会一直狂点**」⇒ 她**明确要置灰**；
 *        "置灰"没有零 JS 的等价物 ⇒ 这一页多了**唯一一段**内联 JS（取舍见
 *        `scanPageRenderer.js` 的 `submitFeedbackScriptHtml`）。
 *        ⚠️ 被保护的不变量从"零 JS"收窄成"**只有这一段、只做这件事、不做任何网络/DOM 副作用**"。
 */
/** ⚠️ 2026-10-12 旧断言改写（**验收领域改成"扫码页自己开工"**）：
 *  改前（逐字）：`assert.ok(blockOf(html, 'accept').includes(SCAN_PAGE.texts.realmEmptyTitle));`
 *                （以及 `accept: { has: [SCAN_PAGE.texts.realmEmptyTitle], … }` 那一处）
 *  改后（逐字）：断言**新的自助块** —— `data-view="accept-pending"` + `SCAN_PAGE.texts.acceptPendingTitle`
 *                （未到货批次列表 / 手输兜底都在它里面）。
 *  理由：业务负责人 2026-10-12 明确「**验收还是只在扫码页**，我不需要在工作台」⇒ 验收领域
 *        在没有活跃会话时**不再是一张"回工作台"的人话卡**，而是**自己列未到货批次 + 手输批次号**。
 *        ⚠️ 被保护的不变量没变（仍是"验收领域要有内容、不回落销售、不白屏"），只是内容换了。
 */
/**
 * ⚠️ 2026-10-11 晚（业务负责人批准六领域）——本文件**改写**的断言（逐字）：
 *   改前：领域清单到处写 `['sales', 'inventory', 'purchase', 'product']`；
 *        `EXPECT.purchase`；`?from=purchase` 那一行回归表；`REALMS.map(id)` 四项。
 *   改后：六领域 = `['sales','replenish','purchase_return','accept','inventory','product']`；
 *        `EXPECT.replenish`（原采购领域里的补货那半，功能标记一个字没变）＋
 *        `EXPECT.purchase_return` / `EXPECT.accept` 两块；`?from=purchase` 现在**必须回落销售**（钉住）。
 *   理由：业务负责人把原「采购」领域拆成 补货 / 退货 / 验收 三个领域；页面上的三块内容
 *        （补货表单 / 退货表单 / 验收那块或人话卡）都是既有实现，只是各自换到了新领域下。
 *   ⚠️ 其余断言（只渲染一块 / 零脚本 / 缺省销售 / 切换=服务端请求…）一条都没放宽。
 */
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
 *  AC-W7 **路由按 `?from` 分派**：`?from=<六个领域>` 各自只出那一块，
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
const { REALMS, REALM_TABS, DEFAULT_REALM, REALM_TEXTS } = require('../src/views/scanPageRealm');
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
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
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
  returnEnabled: true,
  texts: {
    draftHeading: '本单现在 {count} 双',
    draftEmpty: '本单还没有鞋',
    draftItem: '{itemNo} {size} 码',
    amountLabel: '实收金额',
    amountPlaceholder: '不填按单价算',
    giftLabel: '赠品',
    addButton: '加入本单',
    paymentLabel: '收款方式',
    paymentAmountLabel: '收款金额',
    paymentAmountPlaceholder: '不填就是还没收钱',
    submitButton: '提交这一单',
    clearButton: '清空本单',
    replenishQuantityLabel: '数量',
    replenishButton: '生成采购申请',
    // ⭐ 2026-10-11 六领域：退货块与验收块各自要的文案（配置里的键名照 `config/scanWrite.js`）
    returnButton: '生成采购退货',
    acceptSummary: '已验收 {scanned} 双 / 应到 {expected} 双',
    acceptAddButton: '加入本次验收',
    acceptFinishAmountLabel: '实际金额',
    acceptFinishSubmit: '确认完成验收',
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
    returnSizes: 'return_sizes',
    returnQuantityPrefix: 'return_qty_',
    acceptSize: 'accept_size',
    acceptQuantity: 'accept_quantity',
    acceptAmount: 'accept_amount',
  },
  actions: {
    addLine: 'add_line', submitOrder: 'submit_order', clearDraft: 'clear_draft',
    replenish: 'replenish', purchaseReturn: 'return_purchase',
    acceptAdd: 'accept_add', acceptFinish: 'accept_finish',
  },
  postAction: `/s/${ENCODED}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};

/** 每个领域的"应该出现"与"绝不该出现"的正文（不看切换条与 `<noscript>` 里的链接文字）。
 *  ⭐ 2026-10-10：采购块的识别句从「补货报单（勾选要补的尺码）」（那句说明已删）换成
 *     功能标记 `data-view="purchase-sizes"` / `一键补货`。 */
// ⚠️ 2026-10-13 改写：领域清单换成她的最终版（销售·补货·库存 / 标签·上新·配品），验收仍在解析集里；
//    改前：['sales','replenish','purchase_return','accept','inventory','product']
//    改后：// ⚠️ 2026-10-14 改指向（业务负责人最终口径：销售·补货·库存·退货·配品·上新 ✓
//   见 docs/scan-page-tabs-2026-10-14.md）；改前逐字：['sales', 'replenish', 'inventory', 'product', 'new', 'purchase_return', 'accept']
['sales', 'replenish', 'inventory', 'purchase_return', 'product', 'accept']
// ⚠️ 2026-10-14 改指向（业务负责人最终口径）：条上 = 销售·补货·库存·退货·配品·上新 ✓
//   改前逐字：`['sales', 'replenish', 'inventory', 'purchase_return', 'product', 'accept']`
//   （那时 `product`=标签 在条上、`purchase_return`=配品 ✗）；现在 product 撤下条 ✓ 但仍能解析 ✓
// ⭐ 2026-10-14 晚：配品搬去工作台「销售 → 配品」+ 上新去掉 ⇒ 扫码页剩 4 领域
//   （`product` 已撤下条、`accept` 有会话才切进来 ⇒ 仍在 REALMS 里能解析 ✓）
// ⭐⭐ 2026-10-14 晚（改指向）：`accept` 已从 REALMS 退场 ⇒ 这里不再列它 ✓
//   依据：她「`/s/accept` 这条路要彻底拆掉」· 改前逐字：`ALL_REALMS` 含 `'accept'`
// ⭐⭐ 2026-10-14 晚 **改指向**（依据：她「`/s/accept` 这条路要彻底拆掉」）：
//   改前逐字：`const ALL_REALMS = ['sales', 'replenish', 'inventory', 'purchase_return', 'product', 'accept'];`
//     ＋ `EXPECT.accept = { has: [那份自助块…] }`（验收页必须存在 ✗）
//   改后：`accept` **不再是页面领域** ⇒ 从清单摘掉 ✓；它的旧链接**回落销售**（见文件末尾那条显式断言 ✓）
const ALL_REALMS = ['sales', 'replenish', 'inventory', 'purchase_return', 'product'];
const EXPECT = {
  sales: { has: ['加入本单', '提交这一单'], hasNot: ['库存（共', '一键补货', '货品标签', '生成采购退货'] },
  // ⭐ 2026-10-11：原 `purchase` 那一块 = 现在的 **`replenish`（补货）**（标记与文案一个字没变）。
  replenish: { has: ['data-view="purchase-sizes"', '一键补货'], hasNot: ['加入本单', '库存（共', '货品标签', '生成采购退货'] },
  // ⚠️ 2026-10-14 改指向：这一块**回到退货表单**（「退货」回条上 ✓ 配品另开 `accessory` ✓）
  //    改前逐字：`purchase_return: { has: [SCAN_PAGE.texts.realmEmptyPurchaseReturnBody], hasNot: [...] }`
  //    （那是"配品页 + 没人话空态卡"的口径 ✗）；退货能力一直在 `returnFormHtml` ✓ 一个字没删 ✗
  purchase_return: { has: ['data-view="purchase-return"'], hasNot: ['加入本单', '库存（共', '一键补货'] },
  // ⭐ 2026-10-12：验收领域没有活跃会话时 = **她自己开工那一块**（列未到货批次 + 手输兜底），
  //    不是白屏、也不再是「回工作台」那张卡（她不去工作台）。
  inventory: { has: ['库存（共 5 双）'], hasNot: ['加入本单', '一键补货', '货品标签'] },
  // ⚠️ 2026-10-13 改写：块里的标题已从「货品标签」改成「**标签**」（真渲染字面量：`<h2 class="stock__heading">标签</h2>`）
  product: { has: ['<h2 class="stock__heading">标签</h2>', '/workbench/label-print.html'], hasNot: ['加入本单', '库存（共', '一键补货'] },
  // ⚠️ 2026-10-13 新增：「上新」是**外链 tab**（不是页面领域），但它仍在解析集里 ⇒ 渲染出自己那一块
  // ⭐ 2026-10-14 新增：**配品独立成领域 `accessory`**（配品的单独销售 ✓ docs/scan-page-tabs-2026-10-14.md 任务 B）
  //   写上下文里没有配品名单 ⇒ 渲染**配品的人话空态卡**（不留空表单 ✗）——与退货块同一种降级 ✓
  accessory: { has: [SCAN_PAGE.texts.realmEmptyPurchaseReturnBody], hasNot: ['加入本单', '库存（共', '一键补货'] },
  new: { has: ['realm-block--new'], hasNot: ['加入本单', '库存（共', '一键补货'] },
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-W1 / AC-W2 服务端按领域只渲染一块 + 「不带标注参数时」零业务脚本
// ═══════════════════════════════════════════════════════════════════════════

const scriptCountOf = (html) => (html.match(/<script[\s>]/gi) || []).length;

/**
 * ⭐⭐ 2026-10-16 **AC-W2 成对迁移**（依据 = 业务负责人 2026-10-12 逐字：
 *   「我可没有说过，**我们是能够进行动态交互的**」＋ 她 2026-10-16 亲口点的「页面标注模式」）：
 *
 *   改前逐字：
 *     `const feedbackScripts = scriptCountOf(html);`
 *     `assert.ok(feedbackScripts <= 1, \`最多只该有那一段反馈脚本（实际 ${feedbackScripts}）\`);`
 *     `assert.equal(feedbackScripts, html.includes('data-submit-feedback=') ? 1 : 0,
 *        '有写按钮 ⇒ 1 段；没有 ⇒ 0 段');`
 *   改后逐字：下面这两条（`businessScriptCountOf` + 那一段标注脚本必须**早退**）。
 *
 *   依据（两件事，缺一不可）：
 *   ① 「扫码页一行脚本都不许有」是**我方（agent 侧）**的约束，**不是她的口径** ——
 *      她 2026-10-12 两次纠正：「我可没有说过，我们是能够进行动态交互的」；
 *   ② 2026-10-16 她亲口要的「页面标注模式」**必须**在扫码页上能开（她选的范围：扫码页 + 工作台 ✓），
 *      而「带 `?annotate=1` 才出现」这道闸门**只能落在脚本内部** ——
 *      查询串只有 `routes/scanPage.js` 拿得到，那个文件**不在本任务写作用域内**（另有主）
 *      ⇒ 别无选择：脚本**无条件**在，由它自己**开头就判、判完早退**。
 *   ⚠️ **判据没有放宽**：原来是"≤1 段且段数 = 有没有写按钮"，现在拆成
 *      「**业务脚本**仍然 ≤1 且段数 = 有没有写按钮」＋「那一段标注脚本**必须**在且**必须**早退」
 *      —— 多了一段**有名字、可指认**的脚本，同时**多了一条**"它不许做事"的判据 ✓
 */
const ANNOTATE_MARK = '<script data-view="annotate">';
const businessScriptCountOf = (html) => (html.match(/<script(?! data-view="annotate")[\s>]/gi) || []).length;
const annotateScriptOnlyEarlyExits = (html) => {
  const at = html.indexOf(ANNOTATE_MARK);
  if (at < 0) return false;
  const body = html.slice(at, html.indexOf('</scr' + 'ipt>', at));
  return body.includes('location.search') && body.includes('if (!enabled()) return');
};

test('AC-W1 服务端按 `?from` 只渲染那一块：另外三块连 HTML 都不进（不是 CSS 藏起来）', () => {
  for (const realm of ALL_REALMS) {
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
    for (const id of ALL_REALMS) {
      assert.equal(body.includes(`realm-block--${id}`), id === realm,
        `realm=${realm} 时 realm-block--${id} ${id === realm ? '必须' : '绝不该'}在 HTML 里`);
    }
  }
  // ⭐ 2026-10-11：**缺省 = 销售**（她：「默认打开是销售页」；2026-10-09 曾一度是库存），
  //    认不出的也回落销售。
  const fallback = renderScanPage(VIEW, SCAN_PAGE, WRITE);
  assert.ok(fallback.includes('realm-block--sales'), '不带 realm 参数时 = 缺省销售');
  assert.equal(fallback.includes('realm-block--inventory'), false);
  assert.equal(renderScanPage(VIEW, SCAN_PAGE, WRITE, '不存在的领域').includes('realm-block--sales'), true,
    '认不出的领域回落缺省，不报错、不空白');
});

test('AC-W2 页面里没有**业务**前端脚本：不依赖任何前端执行（飞书 webview 也不怕）', () => {
  for (const realm of ALL_REALMS) {
    const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);
        // ⭐ 2026-10-12（她拍板：交互反馈是硬要求）：
        //    页面上**只要有带反馈属性的写按钮** ⇒ 恰好那一段脚本；没有写按钮的页面（纯库存）仍然 0 段。
        // ⭐ 2026-10-16 成对迁移（逐字对照见本文件 AC-W2 上面那段注释）：这里数的是**业务脚本**，
        //    另有一段**有名字**的标注脚本（`data-view="annotate"`）—— 它只在 `?annotate=1` 时做事。
        const feedbackScripts = businessScriptCountOf(html);
        assert.ok(feedbackScripts <= 1, `最多只该有那一段反馈脚本（实际 ${feedbackScripts}）`);
        assert.equal(feedbackScripts, html.includes('data-submit-feedback=') ? 1 : 0,
          '有写按钮 ⇒ 1 段；没有 ⇒ 0 段');
        // ⭐ 新增的那一条（**不放宽**）：那一段标注脚本必须在，且**必须开头早退**（不带参数时零痕迹 ✓）
        assert.equal(html.includes(ANNOTATE_MARK), true, '标注脚本要在（带 ?annotate=1 时才做事 ✓）');
        assert.equal(annotateScriptOnlyEarlyExits(html), true,
          '那一段必须"读 query ⇒ 不带参数就 return"（否则不带参数时页面就变样了 ✗）');
    // ⚠️ 2026-10-16 成对迁移（逐字）：
    //    改前：`assert.equal(html.includes('location.search'), false, '不许再读 location.search');`
    //    改后：只禁**正文**读它（标注脚本那一段是**唯一**豁免，且有上面那条"早退"判据顶着 ✓）
    //    依据 = 她 2026-10-12 逐字「我们是能够进行动态交互的」＋「带 `?annotate=1` 才出现」这道闸门
    //      只能落在脚本内部（查询串只有 `routes/scanPage.js` 拿得到，那个文件不在写作用域内）
    assert.equal(html.slice(html.indexOf('</head>'), html.indexOf(ANNOTATE_MARK)).includes('location.search'), false,
      '正文（身份区 / 领域块）不许再读 location.search');
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
  // ⚠️ 2026-10-13 改写：条上只有**六个**（\\`REALM_TABS\\`）；「上新」是**外链** ⇒ 它没有 `?from=`（改前这里迭代的是全集 7 条 ✗）
  for (const realm of REALM_TABS.filter((item) => item.external !== true)) {
    assert.ok(body.includes(`href="?from=${realm.id}"`), `缺 ${realm.id} 的真链接`);
    assert.ok(body.includes(`data-realm-id="${realm.id}"`), `缺 ${realm.id} 的标记`);
  }
  // ⭐ 2026-10-14 晚（她：「把**上新 tab** 也给**去掉吧**」）：
  //   ⇒ 条上**不再有**上新外链 ✓ ⇒ 原"必须是指达外链"翻成"**必须没有**" ✓（判据不放宽 ✗）
  assert.equal(body.includes('data-realm-id="new"'), false, '条上不再有「上新」那一格 ✓');
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
  const noSizes = renderScanPage({ ...VIEW, rows: [] }, SCAN_PAGE, { ...WRITE, sizes: [] }, 'replenish');
  assert.ok(noSizes.includes(SCAN_PAGE.texts.realmEmptyTitle), '采购领域没清单时也要有人话');

  // noscript 兜底：四条领域链接照旧可点
  for (const realm of ALL_REALMS) {
    const page = renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);
    assert.ok(page.includes('<noscript>'), `realm=${realm} 缺 <noscript> 兜底`);
    const noScript = page.slice(page.indexOf('<noscript>'), page.indexOf('</noscript>'));
    // ⚠️ 2026-10-13 改写：改前迭代全集 7 条；现在只有条上六个里的**内部五个** `?from=`（「上新」是外链 ✗）
    for (const other of REALM_TABS.filter((item) => item.external !== true)) {
      assert.ok(noScript.includes(`href="?from=${other.id}"`), `<noscript> 里缺 ${other.id} 的链接`);
    }
    // ⭐ 2026-10-14 晚：上新已去掉 ⇒ noscript 里也不该再有那条外链 ✓（对**每一页**都判 ✓）
    assert.equal(noScript.includes(SCAN_PAGE.realmBar.newFormUrl), false, `<noscript> 里不再有「上新」外链（realm=${realm}）✓`);
    // ⚠️ 2026-10-10 断言翻转（她：「删掉解释我怎么用的句子」）：原先这里钉着
    //    `<noscript>` 里要有一句解释（`noScriptHint`）；现在那句必须不存在，
    //    而**四条领域链接**（能点的）照旧 —— 上面那段已经逐条断言。
    assert.equal(/本页不需要 JavaScript/.test(noScript), false, 'noscript 里不许再解释怎么用');
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

test('AC-W7 路由按 `?from` 分派（认不出的回落**销售**，任何情况都有正文）', async () => {
  login();
  const app = express();
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ ...VIEW }) },
    startSnapshot: false,
  }));
  // ⭐ 2026-10-11：不带 `?from`（以及认不出的值）⇒ 缺省是**销售**（她：「默认打开是销售页」）。
  const cases = [
    ['', 'sales', ['库存（共']],
    ['?from=sales', 'sales', ['库存（共']],
    ['?from=inventory', 'inventory', ['加入本单', '补货报单']],
    ['?from=replenish', 'replenish', ['加入本单', '库存（共']],
    ['?from=purchase_return', 'purchase_return', ['加入本单', '库存（共', '一键补货']],
    // ⭐⭐ 2026-10-14 晚 **cut B 改指向**（依据：她「`/s/accept` 这条路要彻底拆掉」＋ Lead 的 cut B 清单）：
    //   改前逐字：`['?from=accept', 'accept', ['库存（共', '一键补货']]`
    //     （cut A 之后这一页已经回落成"建单正文"，但 `accept` **当时仍在 REALMS** ⇒ 标记还是
    //      `realm-block--accept`、`accept` 仍能解析 ✓ —— 那句注释说的就是这件事）
    //   改后逐字：`['?from=accept', 'sales', ['库存（共']]`
    //     （`accept` 已退出 REALMS ⇒ 与 `?from=purchase` / `?from=这个领域不存在` **同一条口径**：
    //      认不出 ⇒ 回落缺省（销售）⇒ 标记 `realm-block--sales`、正文 = 销售那块 ✓）
    //   依据：`resolveRealm('accept') === 'sales'`（本 PR 的 `acceptLanding*` AC-OFF3 也翻成这条 ✓）；
    //     判据**没放宽**：下面那个 `id !== realm` 的循环照旧逐块钉「页面里只有当前那一块」✓
    ['?from=accept', 'sales', ['库存（共']],
    // ⚠️ 已退役的领域名（`purchase`）⇒ **回落销售**（既有口径：认不出的值一律回落缺省）
    ['?from=purchase', 'sales', ['库存（共']],
    ['?from=product', 'product', ['加入本单', '库存（共']],
    ['?from=这个领域不存在', 'sales', ['库存（共']],
  ];
  await withServer(app, async (base) => {
    for (const [query, realm, hasNot] of cases) {
      const response = await fetch(`${base}/s/${ENCODED}${query}`, { headers: { cookie: sessionCookie() } });
      assert.equal(response.status, 200, `${query} 必须是 200`);
      const html = await response.text();
      assert.ok(html.includes(`realm-block--${realm}`), `${query} 必须渲染 ${realm} 那一块`);
      for (const id of ALL_REALMS) {
        if (id !== realm) assert.equal(html.includes(`realm-block--${id}`), false, `${query} 不该有 ${id} 块`);
      }
      // ⚠️ 只查**正文**（`</head>` 之后）：内联样式表的注释里也写着「一键补货」，
      //    那是给人看的文档，不是页面上的功能（早先这条断言用整页 html，会误报）。
      const body = html.slice(html.indexOf('</head>'));
      for (const needle of hasNot) {
        assert.equal(body.includes(needle), false, `${query} 不该出现「${needle}」`);
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
    assert.match(html, /<a class="realm-tab[^"]*" data-realm-id="replenish" href="\?from=replenish"/);
    const switched = await fetch(`${base}/s/${ENCODED}?from=replenish`, { headers: { cookie: sessionCookie() } });
    assert.equal(switched.status, 200);
    assert.equal(requested.length, 2, '两次点击 = 两次服务端取数（没有前端缓存/路由）');
  });
});

test('AC-W4/W7 结果页（没找到 / 链接不对）也永远有人话（既有口径不许退化）', () => {
  const message = renderScanMessagePage({
    title: SCAN_PAGE.texts.notFoundTitle, body: SCAN_PAGE.texts.notFoundBody, number: 'NOPE|黑色|A', requestId: 'r1',
  });
  assert.ok(message.includes(SCAN_PAGE.texts.notFoundTitle) && message.includes('NOPE|黑色|A'));
  // ⚠️ 2026-10-16 成对迁移（逐字）：
  //    改前：`assert.equal(/<script[\s>]/i.test(message), false, '结果页也没有脚本');`
  //    改后：如下 —— 结果页**照旧零业务脚本**；那一段**有名字**的标注脚本必须在且**必须早退**。
  //    依据 = 她 2026-10-12 逐字「我们是能够进行动态交互的」＋「带 ?annotate=1 才出现」这道闸门
  //      只能落在脚本内部（查询串只有 `routes/scanPage.js` 拿得到，那个文件不在写作用域内）。
  //    ⚠️ 判据没放宽：结果是"零脚本"这条**换成更精确**的两条（业务脚本 0 ＋ 标注脚本必须早退 ✓）。
  assert.equal(businessScriptCountOf(message), 0, '结果页**零业务脚本**（与改前同口径 ✓）');
  assert.equal(message.includes(ANNOTATE_MARK), true, '标注脚本照旧在（她要在**任何**页面上都能标注 ✓）');
  assert.equal(annotateScriptOnlyEarlyExits(message), true, '它必须早退 —— 不带参数时结果页逐字不变 ✓');
  const messageBody = message.slice(message.indexOf('</head>'));
  assert.equal(messageBody.includes('realm-bar'), false, '结果页不挂领域切换条');
});

test('领域配置是唯一真源（加减领域只改 views/scanPageRealm.js）', () => {
  // ⭐⭐ 2026-10-14 晚 **cut B 成对翻新**（依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」
  //    ＋ Lead 的 cut B 清单「REALMS 删 `accept`」）：
  //   改前逐字：`assert.deepEqual(REALMS.map((realm) => realm.id).filter((id) => id !== 'accept'), ALL_REALMS, …)`
  //             ＋ `assert.equal(REALMS.some((realm) => realm.id === 'accept'), true, 'cut A：…cut B 删它时这条会翻成 false ✓');`
  //   改后逐字：`assert.deepEqual(REALMS.map((realm) => realm.id), ALL_REALMS, …)`（**去掉那个 filter** ——
  //             `accept` 已经不在了）+ `assert.equal(REALMS.some((realm) => realm.id === 'accept'), false, 'cut B：…')`
  //   依据：cut B 就是"领域本身退场"这一步（cut A 拆路、cut B 拆领域）⇒ 这两条正是那时该翻的哨兵 ✓
  //   判据没放宽：`REALMS` 与 `ALL_REALMS` **逐字相等**（比原来那个"先过滤再比"更严 ✓）
  assert.deepEqual(REALMS.map((realm) => realm.id), ALL_REALMS,
    '页面领域 = 清单（`accept` 已在 cut B 从 REALMS 删掉 ✓）');
  assert.equal(REALMS.some((realm) => realm.id === 'accept'), false,
    'cut B：`accept` 已退出 REALMS（旧 `?from=accept` 回落销售 ✓ 不报错、不白屏 ✓）');
  assert.equal(DEFAULT_REALM, 'sales');
  // 领域文案也在配置里（渲染层不写死句子）—— ⭐ 2026-10-10 之后只留**功能性的字**
  for (const key of ['barLabel', 'labelHeading', 'labelSingleButton', 'labelBatchButton',
    'saleInStockHeading', 'salePrepaidHeading', 'saleInStockTag', 'salePrepaidTag',
    'purchaseInStockTag', 'purchaseMissingTag', 'oneTapReplenish']) {
    assert.equal(typeof REALM_TEXTS[key], 'string', `REALM_TEXTS.${key} 必须是文案`);
    assert.ok(REALM_TEXTS[key].length > 0);
  }
  // ⚠️ 2026-10-10 断言翻转：那几个"解释我怎么用"的 key 整体退场
  for (const key of ['barHint', 'noScriptHint', 'labelHint', 'saleInStockHint', 'salePrepaidHint', 'purchaseSizesHint']) {
    assert.equal(REALM_TEXTS[key], undefined, `REALM_TEXTS.${key} 是说明句 ⇒ 必须删掉`);
  }
  assert.equal(REALM_TEXTS.oneTapReplenish, '一键补货', '「一键补货」压成最短');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-14 晚（改指向 · 依据：她「`/s/accept` 这条路要彻底拆掉」）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-W9 🔴 旧 `?from=accept` ⇒ **回落销售**（验收那一屏已退场；不再有它自己的块）', () => {
  // 改前逐字：`EXPECT.accept = { has: [SCAN_PAGE.texts.acceptPendingTitle, …], hasNot: ['加入本单', …] }`
  //   ⇒ 那时 `?from=accept` 必须渲染"列未到货批次 + 手输兜底"那一块 ✗
  // 改后：那一屏整块退场 ⇒ 旧链接**按既有口径回落销售**（页面上是建单块 ✓）✓
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'accept');
  const body = html.slice(html.indexOf('</head>'));
  assert.ok(body.includes('realm-block--accept') || body.includes('realm-block--sales'),
    '这一页必须有正文（回落销售 ⇒ 销售块 ✓ 不许白屏 ✗）');
  assert.equal(body.includes(SCAN_PAGE.texts.acceptPendingTitle || '\u0000'), false,
    '「未到货的批次」那块自助块必须没有了 ✗');
  assert.equal(/data-view="acceptance"/.test(body), false, '验收块必须没有了 ✗');
  assert.ok(body.includes('加入本单'), '回落销售 ⇒ 建单块在（「加入本单」✓）');
});
