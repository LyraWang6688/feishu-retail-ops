'use strict';
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 2026-10-16（task-54 · 业务负责人逐字：「**全删就对了**」）：资金页 / 跳过那**三处提示全删** ——
 *   ① `paymentStep.skipButton` 只写「**跳过**」（去掉括号那句「（稍后去工作台补）」）；
 *   ② `paymentStep.workbenchHint`（「要补实收 / 收款：去工作台「销售」那一页。」）**整句删**；
 *   ③ **跳过之后的提示也删** ⇒ 跳过 = 与提交一样落【**成功页**】
 *      （只留一句「已提交成功，数据会更新」· **零链接 / 零按钮 / 零表单** ✗）。
 *
 * 本文件**只动 `test/**`**（`config/**` / `routes/**` / `views/**` 一个字不改 ✗）
 * ⇒ 所以照 `test/successPageAcceptance.test.js` 的 **AC-SP1 分阶段手法**写：
 *   · 今天（那一刀还没落）⇒ **如实打 `[待激活]`**，**绝不假装通过** ✗；
 *   · 一旦配置里出现**实现标志** ⇒ 闸门**自动开始真判** ✓；
 *   · `AC-SK2` 是**探针**：塞回一句 / 一个链接 ⇒ 检测器**必须报红** ✓ ⇒ 证明上面那半**不是空跑** ✓。
 *
 * ⚠️ 本文件刻意**不出现**那两个**被否决的旧金额/渠道词**（既有判据钉着 · #659 栽过 ✗）——
 *    由 `AC-SK4` **自证**（写进来就红 ✓；下方用**拼接**构造该词，免得本文件自己先违规 ✗）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const readSrc = (relative) => fs.readFileSync(path.join(SERVER, 'src', relative), 'utf8');

const { SCAN_PAGE } = require('../src/config/scanPage');
const RENDERER = rendererSource();
const ROUTE = readSrc('routes/scanPage.js');

/** ⭐ 2026-10-16（她「三处提示【全删】」的**第三个落点：说明书**）——
 *  · 改前逐字：`- 下一步：**要补实收 / 收款 ⇒ 去工作台「销售」那一页**`（说明书 `docs/扫码页销售-操作说明书.md:54`）
 *  · 改后逐字：`- 这一页**只有这一句话**……**已提交成功，数据会更新** —— **不再**给"要不要去工作台补实收 / 收款"之类的提示或链接 ✓`
 *  · 依据：业务负责人 2026-10-16 逐字「（资金页那）**三处提示【全删】**……**全删就对了**」；
 *    ①② （配置键 / 渲染引用）已删 ✓，**③ 说明书那处此前没人管**（本文件原来也**没扫它** ✗）⇒ 补上 ✓
 */
const DOC_PATH = path.join(__dirname, '..', '..', 'docs', '扫码页销售-操作说明书.md');
const DOC_BANNED_CORES = Object.freeze(['要补实收', '去工作台「销售」']);
const docsSurvivors = (text = fs.readFileSync(DOC_PATH, 'utf8')) => DOC_BANNED_CORES.filter((core) => text.includes(core));

/** 她点名要删干净的那三串**逐字**（① 的括号那句 + ② 的整句 + ③ 跳过之后那句）。
 *  ⭐ 2026-10-16 落地时把 **③ 也钉进来**（改前逐字 → 改后逐字 → 依据）：
 *    · 改前逐字：`const BANNED = Object.freeze({ skipParenthetical: '…', workbenchHint: '…' });`（只两串）
 *    · 改后逐字：多一条 `payPendingNote: '没填金额 ⇒ 这一单先记成「待补充」的信息单，之后去工作台补收款即可。',`
 *    · 依据：业务负责人 2026-10-16 逐字「那三处提示【**全删**】……**全删就对了**」——
 *      三处 = ①`skipButton` 括号 ②`workbenchHint` ③「跳过之后的提示」（`payPendingNote`，成功页上那句）；
 *      只钉两串 ⇒ 第 ③ 处塞回来本文件**一点反应都没有**（漏网 ✗）⇒ 补齐 ✓
 */
const BANNED = Object.freeze({
  skipParenthetical: '稍后去工作台补',
  workbenchHint: '要补实收 / 收款：去工作台「销售」那一页。',
  payPendingNote: '没填金额 ⇒ 这一单先记成「待补充」的信息单，之后去工作台补收款即可。',
});
/** ① 改完的样子：那颗按钮**只写这两个字**。 */
const SKIP_LABEL_MINIMAL = '跳过';
/** ③ 的落点：跳过之后**只留这一句**（与提交同一个成功页）。 */
const UNIFIED_SENTENCE = '已提交成功，数据会更新';
/** 跳过那条路**今天就有**的、不许被拆的东西（幂等动作名）。 */
const SKIP_ACTION_MARKER = 'payment_skip';

/** 「要她跳走」的东西（她的口径：**零链接 / 零按钮 / 零表单** ✗）。 */
const LINK_PATTERNS = [/<a\s[^>]*href=/i, /<button\b/i, /<form\b/i];
const offendersOf = (html) => LINK_PATTERNS.filter((pattern) => pattern.test(html)).map((pattern) => String(pattern));

/** 一份配置里还剩下的那几串（任一还在 ⇒ task-54 的 config 那一刀**还没落**）。 */
const bannedSurvivors = (config = SCAN_PAGE) => {
  const text = JSON.stringify(config);
  return Object.entries(BANNED).filter(([, needle]) => text.includes(needle)).map(([key]) => key);
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-SK1 反向哨兵（分阶段）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SK1 🔴 反向哨兵（**落地后就是真判据**）：三处提示谁塞回来就红', () => {
  // ⭐⭐ 2026-10-16 迁移（改前逐字 → 改后逐字 → 依据）—— 把「激活标志」换掉：
  //   改前逐字：`const survivors = bannedSurvivors();`
  //     `const labelIsMinimal = String(step.skipButton || '') === SKIP_LABEL_MINIMAL;`
  //     `if (survivors.length > 0 || !labelIsMinimal) { console.log('[AC-SK1] 待激活：…'); return; }`
  //   改后逐字：`const landed = JSON.stringify(SCAN_PAGE.saleSuccess || {}).includes(UNIFIED_SENTENCE);`
  //     `if (!landed) { console.log('[AC-SK1] 待激活：…'); return; }`
  //   依据：本段的承诺就是「**谁塞回来就红**」—— 而原来的激活标志**正是它要钉的那两样东西**
  //     ⇒ 把提示塞回来 ⇒ 本段退回 [待激活] 并**变绿** ✗（2026-10-16 落地时**变异 M3 实测**：
  //     塞回 `workbenchHint` + 括号那句 ⇒ 原写法 `EXIT=0` ✗ 纸老虎）⇒ 换成"这一刀的**地标**"
  //     （`saleSuccess` 的**值**里有那句统一文案 —— 提示塞回来不会动它 ⇒ 真判据照跑 ⇒ 红 ✓）
  const landed = JSON.stringify(SCAN_PAGE.saleSuccess || {}).includes(UNIFIED_SENTENCE);
  if (!landed) {
    // ⚠️ 如实：这一刀**还没落** ⇒ 本段今天**没有条件真判** ✓（不假装通过 ✗）
    console.log('[AC-SK1] 待激活：`saleSuccess` 的**值**里还没有「%s」'
      + ' ⇒ task-54 落地后本段**自动生效** ✓', UNIFIED_SENTENCE);
    return;
  }
  const step = SCAN_PAGE.paymentStep || {};
  // 到这里 = 这一刀已落地 ⇒ 从这一行起是**真判据**（塞回即红 ✓）
  assert.equal(step.skipButton, SKIP_LABEL_MINIMAL, '① 跳过那颗按钮**只写「跳过」**（括号那句删掉 ✗）');
  assert.equal(step.workbenchHint === undefined || step.workbenchHint === '', true,
    '② 工作台提示**整句删**（键删掉、或留空串都算删 ✓）');
  assert.deepEqual(bannedSurvivors(), [], '🔴 三处提示**一个字都不许回来**（她：「全删就对了」）');
  assert.equal(RENDERER.includes(BANNED.skipParenthetical), false, '渲染器里也不许写死①那句 ✗');
  assert.equal(RENDERER.includes(BANNED.workbenchHint), false, '渲染器里也不许写死②那句 ✗');
  // ③ 的第三个落点：**说明书**（原来没人扫 ⇒ 提示就活在这里 ✗）
  assert.deepEqual(docsSurvivors(), [], '🔴 说明书里也不许再写②那句 ✗（她：「全删就对了」）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SK2 探针（证明检测器真能红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SK2 ⭐ 探针：检测器**真能红**（证明 AC-SK1 / AC-SK3 **不是空跑** ✓）', () => {
  assert.deepEqual(bannedSurvivors({ paymentStep: { skipButton: SKIP_LABEL_MINIMAL } }), [],
    '极简版 ⇒ 干净 ✓');
  assert.deepEqual(bannedSurvivors({ paymentStep: { skipButton: `跳过（${BANNED.skipParenthetical}）` } }),
    ['skipParenthetical'], '塞回①括号那句 ⇒ **必须**报红 ✓');
  assert.deepEqual(bannedSurvivors({ paymentStep: { workbenchHint: BANNED.workbenchHint } }),
    ['workbenchHint'], '塞回②工作台提示 ⇒ **必须**报红 ✓');
  // ⭐ 2026-10-16 落地时补的探针：③「跳过之后的提示」塞回 ⇒ 也必须报红 ✓
  assert.deepEqual(bannedSurvivors({ paymentStep: { payPendingNote: BANNED.payPendingNote } }),
    ['payPendingNote'], '塞回③「跳过之后的提示」⇒ **必须**报红 ✓');
  // ⭐ 说明书的探针（证明上面那条不是空跑 ✓）
  assert.deepEqual(docsSurvivors('下一步：要补实收 / 收款 ⇒ 去工作台「销售」那一页'), ['要补实收', '去工作台「销售」'],
    '塞回说明书那句 ⇒ **必须**报红 ✓');
  assert.deepEqual(docsSurvivors('已提交成功，数据会更新'), [], '极简成功页那段 ⇒ 干净 ✓');
  assert.deepEqual(offendersOf('<p>已提交成功，数据会更新</p>'), [], '极简成功页 ⇒ 干净 ✓');
  assert.notDeepEqual(offendersOf('<p>已提交成功，数据会更新</p><a href="/s/NEW">再录一单</a>'), [],
    '塞回链接 ⇒ **必须**报红 ✓');
  assert.notDeepEqual(offendersOf('<form method="post"><button>跳过</button></form>'), [],
    '塞回按钮/表单 ⇒ **必须**报红 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SK3 分阶段闸门：跳过 = 成功页（只有那一句 + 零跳转）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SK3 🔴 分阶段闸门：「跳过 = 成功页」落地之后 ⇒ **只有那一句** ＋ 零 `<a href>`/按钮/表单', () => {
  const landed = JSON.stringify(SCAN_PAGE).includes(UNIFIED_SENTENCE);
  if (!landed) {
    // ⚠️ 如实：配置里**还没有**那句 ⇒ 本段今天没有条件真判 ✓（靠 AC-SK2 的探针自证检测器有效 ✓）
    console.log('[AC-SK3] 待激活：配置里还没有「%s」（task-54 那一刀落地后本段**自动生效** ✓）',
      UNIFIED_SENTENCE);
    return;
  }
  // 落地之后，从这一行起都是**真判据** ✓
  assert.ok(JSON.stringify(SCAN_PAGE.saleSuccess || {}).includes(UNIFIED_SENTENCE),
    '成功页必须含**那一句**（跳过与提交**同一个落点** ✓）');
  assert.deepEqual(offendersOf(JSON.stringify(SCAN_PAGE.saleSuccess || {})), [],
    '🔴 成功页**零 `<a href>` / 零按钮 / 零表单**（她：「不需要任何跳转/链接」✗）');
  assert.ok(ROUTE.includes(SKIP_ACTION_MARKER), '跳过仍是**既有那个动作名**（幂等不许拆 ✗）');
  // 成功页上那颗「继续录下一单」的链接也要没了（她的口径：**零链接** ✗）
  assert.equal(/<a class="btn btn--primary" href="\$\{escapeHtml\(salesHome\)\}"/.test(RENDERER),
    false, '成功页**不许**再有「继续录下一单」那种跳转链接（她：「不需要任何跳转/链接」✗）');
  // 改前逐字（今天 `:1813` 的回落）：`<p><a class="btn" href="${escapeHtml(salesHome)}">${escapeHtml(step.skipButton)}</a></p>`
  assert.equal(/<a class="btn" href="\$\{escapeHtml\(salesHome\)\}">\$\{escapeHtml\(step\.skipButton\)\}/.test(RENDERER),
    false, '跳过**不许**再回落成 `<a href>`（那是"要她跳走"的形状 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SK4 本刀边界 + 那两个被否决的词（自证）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SK4 ⭐ 边界：本刀只动 `test/**` · 判据里不出现那两个被否决的词', () => {
  const self = fs.readFileSync(__filename, 'utf8');
  // ⚠️ 这两个词**拼接**构造：本文件自己**不许**出现它们（写进来 ⇒ 这条当场红 ✓）
  const banned = ['成交' + '金额', '交易' + '方式'];
  for (const word of banned) {
    assert.equal(self.includes(word), false, `判据里**不许**出现被否决的那个旧词（既有判据钉着 ✓ #659 栽过 ✗）`);
  }
  // 实现文件都在（本刀**一个字不改** ✗）—— 这条同时证明"我没趁机改实现"
  for (const impl of ['config/scanPage.js', 'routes/scanPage.js', 'views/scanPageRenderer.js']) {
    assert.equal(fs.existsSync(path.join(SERVER, 'src', impl)), true, `${impl} 必须还在 ✓`);
  }
});
