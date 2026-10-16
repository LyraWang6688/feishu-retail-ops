/**
 * ⭐⭐ **「存草稿 · 接着录」S2（渲染半）的验收标准** —— 2026-10-16。
 *
 * 业务负责人的口径（**逐字**；出处 = `docs/draft-save-resume-plan-2026-10-16.md` 文首追加节
 *   ＋ Lead 的两页便条 `.local/draft-plan/LEAD-ADDENDUM-2.md` / `LEAD-ADDENDUM-3.md`）：
 *   · 「我们的**销售货品页上面也需要加一个按钮**，叫「**存报货草稿**」」← **只点了这一颗**；
 *   · 「我们的**补货和退货需要支持存草稿**功能…需要支持**存草稿后续再处理**」；
 *   · 「**进去就提示，接着录**」（= 顶部那条「你有一份草稿，接着录吗？」）。
 *
 * ── 先写「按我们的链路应该实现的效果」，再跑，再逐条对照（她定的流程）────────────
 *
 *  AC-D2a ⭐ **三处入口都在**（销售货品页 / 补货页 / 退货页）＋ **名字走配置**
 *         （**改配置即改文案** ⇒ 能真红）：三处**共用同一句**文案 —— 依据 = 她**只点名了
 *         销售页那颗叫「存报货草稿」**，另两处**她没点名** ⇒ 本刀**不自己另起名字** ✗，
 *         取用销售页那颗的原文案（来源如实登记在 `config/scanPage.js` 的 `resolveDraftEntryConfig`）。
 *         库存页 / 标签页**没有**这颗入口（取值必须是 `REALMS[].id`；认不出的领域 **不显示** ✗ 不猜）。
 *  AC-D2e ⭐ **没有草稿 ⇒ 页面与今天逐字一致**（零回归）：今天所有调用方都不传 `page.draft`
 *         ⇒ 页面**一个草稿字节都没有**；`{enabled:true, hasDraft:false}` ⇒ **提示条一个字都不出**，
 *         且**去掉三处入口那一段之后**与"不传 `page.draft`"渲染出的页面**逐字相等** ✓。
 *         （🔴 **能真红**：把提示条改成无条件渲染 ⇒ 本条红 ✓）
 *  AC-D2f ⭐ 「**你有一份草稿，接着录吗？**」提示条：**有草稿才出** ✓（没草稿 = 空串 ✓）；
 *         【接着录】= 真链接（查询键/值走配置 ✓）；**不点它 = 正常新建** ✓
 *         （页面里别的按钮/表单**一个字都不动** ⇒ 她那半零回归）。
 *         ⚠️ **如实标「待接线」**：「接着录」那一下要**路由**读 `?resume=1` 才真的接着录 ——
 *           本刀**不碰 `routes/**`** ✗ ⇒ 渲染层已按配置画好链接与查询键，**路由那一步在 S3** ✓
 *           （判据见 AC-D2f3：**今天不传 `page.draft` 时，生产页面上一个字都不出现** ✓）。
 *
 * ⚠️ 每条下面都写明「**去掉哪一句就该红**」（见文件末 `MUTATION` 注释与 PR 说明）——
 *   避免"名字出现过 = 有判据"那种假绿（AGENTS.md 第 1b 条③）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ⚠️ 渲染链路在 require 阶段就要凭证（与其它扫码页用例同一套写法）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_draft_render';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_draft_render_secret';

const { renderScanPage, escapeHtml } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE, resolveDraftEntryConfig } = require('../src/config/scanPage');

const RENDERER_PATH = path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js');
const RENDERER_SRC = fs.readFileSync(RENDERER_PATH, 'utf8');

/** 三个领域（她说的那三页）—— 取值必须是 `views/scanPageRealm.js` 的 `REALMS[].id` ✓。 */
const THREE_REALMS = ['sales', 'replenish', 'purchase_return'];
/** 她**没点名**的那两页（回归用：不许"顺手"也给它们加） */
const OTHER_REALMS = ['inventory', 'product'];

const VIEW = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }], total: 2, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 21:05',
  product_record_id: 'rec_product_A',
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
    submitButton: '提交这一单',
    clearButton: '清空本单',
    replenishQuantityLabel: '数量',
    replenishButton: '生成采购申请',
  },
  fields: {
    action: 'action',
    submitKey: 'submit_key',
    size: 'size',
    amount: 'amount',
    gift: 'gift',
    replenishSizes: 'sizes',
    replenishQuantityPrefix: 'qty_',
    returnSizes: 'return_sizes',
    returnQuantityPrefix: 'return_qty_',
  },
  actions: {
    addLine: 'add_line', submitOrder: 'submit_order', clearDraft: 'clear_draft',
    replenish: 'replenish', purchaseReturn: 'return_purchase',
  },
  postAction: '/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA',
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: false }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};

/** 路由（S3）会喂进来的那一个上下文（本刀只在**传了它**的时候才画草稿那一块 ✓）。 */
const DRAFT_ON = { draft: { enabled: true } };
const pageOf = (draft = null, extra = {}) => (draft ? { draft, ...extra } : { ...extra });
const htmlOf = (realm, page = {}, config = SCAN_PAGE, write = WRITE) =>
  renderScanPage(VIEW, config, write, realm, page);

/** 把那三处入口那一段**整段摘掉**（用来证明"除入口外，其余逐字一致" ✓）。 */
const stripDraftEntries = (html) => html
  .replace(/<button data-draft-save="1"[^>]*>[^<]*<\/button>/g, '');
/** 把提示条那一段**整段摘掉**。 */
const stripDraftNotice = (html) => html
  .replace(/<section class="card draft-notice"[\s\S]*?<\/section>/g, '');

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2a 三处入口 ＋ 名字走配置
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2a 三处入口都在（销售货品页 / 补货页 / 退货页），文案三处**同一句**且只在配置里', () => {
  const cfg = SCAN_PAGE.draftEntry;
  assert.equal(cfg.saveLabel, '存报货草稿', '缺省 = 她点名的那一句（销售页那颗的原文案）');
  for (const realm of THREE_REALMS) {
    const html = htmlOf(realm, DRAFT_ON);
    const hits = html.match(/data-draft-save="1"/g) || [];
    assert.equal(hits.length, 1, `${realm} 页**恰好一颗**「存报货草稿」（多一颗/少一颗都要红）`);
    assert.ok(html.includes(`>${cfg.saveLabel}</button>`), `${realm} 页那颗按钮的文字 = 配置里的 saveLabel`);
    // 提交的那一下 = 配置里的 saveAction（**路由 S3 按它分派**；字段名沿用既有 `fields.action` ✓）
    assert.ok(html.includes(`name="${WRITE.fields.action}" value="${escapeHtml(cfg.saveAction)}"`),
      `${realm} 页那颗按钮提交的是配置里的动作名（不新造字段名 ✓）`);
    // ⭐ 它必须在**那张表单里面**（否则点了带不走她刚填的尺码 / 数量 ✗）
    const lastFormOpen = html.lastIndexOf('<form');
    assert.ok(html.indexOf('data-draft-save="1"') > lastFormOpen,
      `${realm} 页那颗按钮必须在既有那张 <form> 里（否则提交上去什么都没有 ✗）`);
  }
  // 她**没点名**的两页不许"顺手"加 ✗（取值必须是 REALMS[].id；认不出的领域 = 不显示）
  for (const realm of OTHER_REALMS) {
    assert.equal(htmlOf(realm, DRAFT_ON).includes('data-draft-save="1"'), false,
      `${realm} 页不在她点名的三处里 ⇒ 不许出现这颗入口 ✗`);
  }
  assert.deepEqual(cfg.realms, THREE_REALMS, '三处入口的领域清单在配置里（改它不用动渲染层 ✓）');
});

test('AC-D2a2 ⭐ 名字走配置：**改配置即改文案**（三处一起变 —— 一处定义 ✓）', () => {
  const custom = resolveDraftEntryConfig({
    SCAN_DRAFT_SAVE_LABEL: '存个草稿先', SCAN_DRAFT_SAVE_ACTION: 'draft_save_v2',
  });
  assert.equal(custom.saveLabel, '存个草稿先');
  assert.equal(custom.saveAction, 'draft_save_v2');
  const config = { ...SCAN_PAGE, draftEntry: custom };
  for (const realm of THREE_REALMS) {
    const html = htmlOf(realm, DRAFT_ON, config);
    assert.ok(html.includes('>存个草稿先</button>'), `${realm} 页要用**改过之后**的文案`);
    assert.equal(html.includes('>存报货草稿</button>'), false, `${realm} 页不许还留着旧文案 ✗`);
    assert.ok(html.includes('value="draft_save_v2"'), `${realm} 页的动作名也跟着配置走 ✓`);
  }
  // 探针：领域清单改成"一个都不要" ⇒ 三页都不出那颗按钮（seams 真的接在这份配置上 ✓）
  const none = { ...SCAN_PAGE, draftEntry: resolveDraftEntryConfig({ SCAN_DRAFT_ENTRY_REALMS: ' ' }) };
  assert.deepEqual(none.draftEntry.realms, [], '空串 = 显式的"一个领域都不要"（readList 的既有语义 ✓）');
  for (const realm of THREE_REALMS) {
    assert.equal(htmlOf(realm, DRAFT_ON, none).includes('data-draft-save="1"'), false,
      '配置说"一个都不要" ⇒ 任何一页都不许再出那颗按钮');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2e 没有草稿 ⇒ 与今天逐字一致（零回归）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2e ⭐ 没有草稿 ⇒ 页面与今天逐字一致：不传 page.draft = 今天所有调用方，一个草稿字节都没有', () => {
  const cfg = SCAN_PAGE.draftEntry;
  for (const realm of [...THREE_REALMS, ...OTHER_REALMS]) {
    const today = htmlOf(realm);                       // 今天的调用形状（page = {}）
    const explicitlyOff = htmlOf(realm, { draft: { enabled: false } });
    assert.equal(explicitlyOff, today, '显式关掉 ⇒ 与"不传"逐字相等（同一把闸门 ✓）');
    for (const bytes of [cfg.saveLabel, cfg.noticeLabel, cfg.resumeLabel, 'data-draft-save', 'data-view="draft-notice"']) {
      assert.equal(today.includes(bytes), false,
        `不传 page.draft（= 今天所有调用方）时，页面上不许出现「${bytes}」✗`);
    }
  }
  // ⭐ 开关开、但**没有草稿** ⇒ **只有三处入口**，提示条一个字都不出；
  //   把入口那一段摘掉之后，与"今天"**逐字相等** ✓（这条就是"零回归"的准确口径 ✓）
  for (const realm of [...THREE_REALMS, ...OTHER_REALMS]) {
    const noDraft = htmlOf(realm, pageOf({ enabled: true, hasDraft: false }));
    assert.equal(noDraft.includes(cfg.noticeLabel), false, `${realm} 页没草稿 ⇒ 不许出提示条 ✗`);
    assert.equal(noDraft.includes('data-view="draft-notice"'), false, `${realm} 页没草稿 ⇒ 不许出提示条 ✗`);
    assert.equal(noDraft.includes('data-draft-resume="1"'), false, `${realm} 页没草稿 ⇒ 不许出【接着录】✗`);
    assert.equal(stripDraftEntries(noDraft), htmlOf(realm),
      `${realm} 页：除三处入口那一颗以外，与今天**逐字一致** ✗`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2f 「你有一份草稿，接着录吗？」提示条
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2f1 有草稿才出：提示条 ＋【接着录】真链接（查询键 / 值走配置）', () => {
  const cfg = SCAN_PAGE.draftEntry;
  for (const realm of THREE_REALMS) {
    const html = htmlOf(realm, pageOf({ enabled: true, hasDraft: true, productCount: 2, lineCount: 3 }));
    assert.ok(html.includes('data-view="draft-notice"'), `${realm} 页有草稿 ⇒ 出提示条 ✓`);
    assert.ok(html.includes(cfg.noticeLabel), `${realm} 页提示条那句人话 = 配置里的原文`);
    assert.ok(html.includes('data-draft-resume="1"'), `${realm} 页要有【接着录】✓`);
    assert.ok(html.includes(`>${cfg.resumeLabel}</a>`), `${realm} 页【接着录】的文字 = 配置里的原文`);
    // 真链接：同一路径 + `?from=<当前领域>` + 配置里的查询键 / 值（S3 的路由读同一份 ✓）
    assert.ok(html.includes(`href="?from=${realm}&${cfg.resumeQueryKey}=${cfg.resumeQueryValue}"`),
      `${realm} 页【接着录】的落点要带当前领域与配置里的查询键 ✓`);
    // 数字只有路由喂了才写（拿不到就不写 —— **不编 0** ✗）
    assert.ok(html.includes('data-view="draft-notice-meta"'), '路由喂了数字 ⇒ 那行小字要出 ✓');
    assert.ok(html.includes('2 个货品 · 3 行'), '数字逐字来自路由喂的那两个 ✓');
    const bare = htmlOf(realm, pageOf({ enabled: true, hasDraft: true }));
    assert.equal(bare.includes('data-view="draft-notice-meta"'), false,
      '路由没喂数字 ⇒ 那行小字一个字都不出（不编 0 ✗）');
  }
});

test('AC-D2f2 ⭐ 不点它 = 正常新建：页面里别的按钮 / 表单**一个字都不动**', () => {
  const cfg = SCAN_PAGE.draftEntry;
  // 三个领域各自的"主提交"那一颗：有草稿 vs 没草稿 ⇒ 逐字相同（提示条只是**多**了一条，不替换任何东西 ✓）
  const mainButtonOf = (realm) => htmlOf(realm, pageOf({ enabled: true, hasDraft: true }))
    .slice(0, htmlOf(realm, pageOf({ enabled: true, hasDraft: true })).indexOf('data-draft-save="1"'));
  for (const realm of THREE_REALMS) {
    const withDraft = htmlOf(realm, pageOf({ enabled: true, hasDraft: true }));
    const noDraft = htmlOf(realm, pageOf({ enabled: true, hasDraft: false }));
    // 提示条去掉之后 = 没草稿那一页（**逐字**）⇒ "不点它就正常新建" ✓
    assert.equal(stripDraftNotice(withDraft), noDraft,
      `${realm} 页：把提示条摘掉后要与"没草稿"那一页逐字一致（它只是多一条人话 ✓）`);
    assert.ok(withDraft.includes(WRITE.actions.submitOrder) || withDraft.includes(WRITE.actions.replenish),
      `${realm} 页既有那颗主提交还在（没被提示条顶掉 ✓）`);
    assert.ok(mainButtonOf(realm).includes(cfg.noticeLabel), '提示条在**页面最上面**（身份区之前 ⇒ 她一进来就看得到 ✓）');
  }
  // 改配置即改文案（提示条那两句也一样走配置 ✓）
  const custom = resolveDraftEntryConfig({
    SCAN_DRAFT_NOTICE_LABEL: '上次那份还在，接着录？',
    SCAN_DRAFT_RESUME_LABEL: '继续',
    SCAN_DRAFT_RESUME_QUERY_KEY: 'draft_resume',
    SCAN_DRAFT_RESUME_QUERY_VALUE: 'yes',
  });
  const html = htmlOf('replenish', pageOf({ enabled: true, hasDraft: true }), { ...SCAN_PAGE, draftEntry: custom });
  assert.ok(html.includes('上次那份还在，接着录？'), '提示条那句跟着配置走 ✓');
  assert.ok(html.includes('>继续</a>'), '【接着录】那句跟着配置走 ✓');
  assert.ok(html.includes('href="?from=replenish&draft_resume=yes"'), '查询键 / 值跟着配置走 ✓');
});

test('AC-D2f3 不传 page.draft（或没草稿）⇒ 生产页面上一个草稿字节都不出现；闸门只有那两道', () => {
  // ── ⭐⭐ **成对迁移（2026-10-16 · task-S3）**（改前逐字 → 改后逐字 → 依据）─────────
  //   · **改前逐字**（S2 那一刀自己写的哨兵，**只对 S2 成立**）：
  //     `assert.equal(/(?:resumeQueryKey|\bresume\b)/.test(src), false,
  //        '🔴 routes/scanPage.js 里还没有读 ?resume（S3 才接）⇒ 本刀如实标「待接线」✓');`
  //     `assert.match(RENDERER_SRC, /待接线/, '渲染层要如实写明这一步的接线在 S3 …');`
  //   · **改后逐字**：那两条**换成**"路由接住了 `?resume`（查询键走配置）＋ 渲染层不再有待接线"
  //     （本测试下面那两条）✓。
  //   · **依据**：S3 落地了（`routes/scanPage.js` 读 `resumeQueryKey` 并把草稿填回页面 ✓
  //     —— 判据在 `test/scanDraftRouteWiring.test.js` 的 AC-D3e ✓）⇒ "还没接"那两条断言
  //     从**事实**变成了**过期断言**（留着就是"拿一句谎当哨兵" ✗）。
  //   · ⚠️ **不是放宽** ✓：本测试真正要保的两条不变量**一个字都没动** ——
  //     ① 不传 `page.draft` ⇒ 一个草稿字节都不出；② 两道闸门（`enabled` / `hasDraft`）还在 ✓。
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage.js'), 'utf8');
  assert.match(src, /draftEntry\.resumeQueryKey/,
    '⭐ 路由按**配置**里的查询键读 `?resume`（S3 已接；不写死 `resume` 字面量 ✓）');
  assert.equal(/待接线/.test(RENDERER_SRC), false,
    '渲染层**不再**标"待接线"（S3 已接上 ⇒ 那句话已经过期 ✗）');
  // 两个渲染点都必须先过 `page.draft.enabled === true` 这道闸（缺省 = 一个字节都不出 ✓）
  assert.match(RENDERER_SRC, /draft\.enabled !== true\) return null/,
    '两块草稿 UI 的**唯一**闸门 = `page.draft.enabled === true`（缺省不渲染 ✓）');
  assert.match(RENDERER_SRC, /draft\.hasDraft !== true\) return ''/,
    '提示条的第二道闸门 = `hasDraft === true`（没草稿 ⇒ 空串 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// 探针：上面几条**真能红**（不是空跑 ✓）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2-Probe ⭐ 闸门真的在起作用：三个领域 × 三种 page 形状，出/不出**逐条**对得上', () => {
  const matrix = [
    [{}, false],
    [{ draft: { enabled: false } }, false],
    [{ draft: { enabled: true, hasDraft: false } }, false],
    [{ draft: { hasDraft: true } }, false], // 只有 hasDraft、没 enabled ⇒ 同样一个字节都不出（显式布尔 ✓）
    [{ draft: { enabled: true, hasDraft: true } }, true],
  ];
  for (const realm of THREE_REALMS) {
    for (const [page, shouldShow] of matrix) {
      const html = htmlOf(realm, page);
      assert.equal(html.includes('data-view="draft-notice"'), shouldShow, `${realm} ${JSON.stringify(page)}`);
    }
  }
});

// MUTATION（每组都单独跑过、确认**真红**，跑完逐字节还原）：
//   ① 把 `draftUiOf` 的 `return null` 改成 `return draft || {}`（= 没传也当开着）
//      ⇒ AC-D2e 红（今天那一页里出现了草稿字节）✓
//   ② 把 `draftNoticeHtml` 的 `hasDraft !== true` 去掉（= 提示条无条件渲染）
//      ⇒ AC-D2e 红（没草稿也出了提示条）✓
//   ③ 把 `draftEntryConfigOf` 改成读模块级 `SCAN_PAGE.draftEntry`（不认传进来的 config）
//      ⇒ AC-D2a2 红（改配置不改文案）✓
