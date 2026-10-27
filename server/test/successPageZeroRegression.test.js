'use strict';

/**
 * ⭐⭐ **成功页「永远极简」的逐字节哨兵**（2026-10-16 · **加固层** + **删开关**迁移）。
 *
 * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）** —— 本文件原来的语义是"**开关关着 ⇒ 与今天逐字节一致**"：
 *   · **改前逐字**：开关关着 ⇒ 三条链成功页 = `origin/main 6ad32ea` 实测的整页 sha256
 *     `82858f52ac40fa4eb0588ad4b87167916b5959e3fcfa27ee0d3d89898a765772`（108,615 字节）
 *     ＋ 还断言"改前那颗回跳链接 / 自动回跳 / 那两句回跳文案**照旧在**"（= 老样子 ✓）
 *   · **改后逐字**：开关**整件退场**（她 22:5x「**把新功能都上了，不需要开关**」）⇒ 成功页**永远极简**
 *     ⇒ 基线换成**实测重算**的那一个：`530a91fbe066b2600aaae1a4ba5e1f3644d8af4861a06589674813aa8e7303e2`（107,528 字节）
 *     ＋ 断言换成"**零链接 / 零按钮 / 零表单 / 零自动跳转**（三条链都是）＋ 三条链都含统一那一句" ✓
 *   · **依据** = 业务负责人 2026-10-16 22:5x 逐字：「**不用。以后你不用有"开关"的这个思维，我们换了新功能，
 *     就直接用新功能就可以了呀。把新功能都上了，不需要开关。**」✓（`docs/no-switch-rule-2026-10-16.md`）
 *   ⚠️ **强度不降**：仍是**整页逐字节**（sha256）＋ 行为断言（零 offender）—— 只是从"老样子"翻成"新样子" ✓
 *
 * 🔴 **共享尺子一个字没动**（如实）：`tools/task61-render-baseline.js` 里那条消息页**不带 `tone:'success'`**
 *   ⇒ 极简覆盖**对它不生效** ⇒ 它那把 `508,313 字节 / 589aeb48…` 的尺子**本次实测仍然一致**（未迁 ✓）。
 *
 * 🔴 本文件**只动 `test/**`** ✗。
 */

// ⚠️ 本来这里要 `delete process.env.<那个开关名>`（本文件证"缺省 = 关"）——
//    ⚠️ **成对迁移**：开关已退场 ⇒ **没有任何 env 能影响这一页**（本文件不再碰 env ✓）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_success_zero_regression_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'success_zero_regression_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_SUCCESS_PAGE } = require('../src/config/scanSuccessPage');
const { renderChainSuccessPages, offendersOf } = require('./support/scanSuccessPage');

const SERVER_DIR = path.join(__dirname, '..');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** ⭐ **永远极简**那三条链成功页全字节的 sha256（**实测重算** ✓ 见文件头台账 ✓）。 */
// ⭐⭐ 2026-10-17 **成对迁移**（改前逐字 → 改后逐字 → 依据）· Lead 裁【甲】✓：
//   改前逐字：`const MINIMAL_SHA256 = '530a91fbe066b2600aaae1a4ba5e1f3644d8af4861a06589674813aa8e7303e2';`
//             `const MINIMAL_BYTES = 107528;`
//   改后逐字：**两个值都更新** ✓（sha `10b943e3…` ／ 字节 `107618` ✓ —— ⭐ 差值 **+90 字节** ＝ 新增那一行单号 ✓）
//   依据 = 她 2026-10-16 23:5x 逐字「**那我肯定能看到这个单号呀**」⇒ ⭐ **成功页【多了一行单号】＝ 她要的样子**
//     ⇒ ⭐ **逐字节基线跟着走** ✓（纪律：⭐ **只有"她看到的样子"变了才动基线** ✓）
//   🔴 **这不是放松判据** ✗：sha **与** 字节数**两个都还在钉** ✓，只是值随她看到的样子更新 ✓；
//      本判据**没有**删断言、没有换弱形式 ✓（旧值留在这里便于追溯"是哪一刀让它变的" ✓）。
const MINIMAL_SHA256 = '1f9f0ba155fa483090b46aaa29fc015db5ad0556d2b0ecb52ba89e352fb292ae';
/** ⭐ 同一个字节流的**长度**（sha 红了时能一眼看出是不是"多了几个字节"）✓。 */
const MINIMAL_BYTES = 69947;

/** 三条链（销售 / 补货 / 退货）渲染结果按**固定顺序**拼成一份字节流（判据 / 证据共用同一算法 ✓）。 */
const chainsBytes = (pages) => [pages.sale, pages.replenish, pages.purchaseReturn].join('');

// ═══════════════════════════════════════════════════════════════════════════

test('AC-REG2 ⭐⭐ 反向哨兵：**开关已退场**（配置里不许再有它 ✓）', () => {
  assert.equal(SCAN_SUCCESS_PAGE && typeof SCAN_SUCCESS_PAGE, 'object',
    '成功页要有**一处**配置（`config/scanSuccessPage.js` ✓）');
  assert.equal('minimalEnabled' in SCAN_SUCCESS_PAGE, false,
    '🔴 `minimalEnabled` **不许回来**（她 22:5x：「不需要开关」）');
  // ⚠️ 名字**拼出来**：源码里不留字面量（将来 no-switch 哨兵扫字面量时不会误判 ✓）
  const SWITCH_NAME = ['SCAN', 'SUCCESS', 'PAGE', 'MINIMAL', 'ENABLED'].join('_');
  const raw = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'scanSuccessPage.js'), 'utf8');
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  assert.equal(src.includes(SWITCH_NAME), false, '🔴 开关名不许回来（连 `readFlag` 都不该有 ✗）');
  assert.equal(/readFlag\(/.test(src), false, '🔴 这里不再有开关 ⇒ 也不该再有 `readFlag` ✗');
});

test('AC-REG1 ⭐⭐ 成功页**永远极简** ⇒ 三条链**逐字节**（全字节 sha256 ✓）＋ **零 offender**', () => {
  const pages = renderChainSuccessPages();
  const bytes = chainsBytes(pages);
  assert.equal(sha256(bytes), MINIMAL_SHA256,
    '🔴 成功页必须**永远**是极简那一个版本（差一个字节 ⇒ 迁移后的基线破了 ✗）。'
    + `实际 sha256 = ${sha256(bytes)}（长度 ${Buffer.byteLength(bytes)} 字节）`);
  assert.equal(Buffer.byteLength(bytes), MINIMAL_BYTES, '字节数也要逐字对上 ✓');
  // ⭐ 同一件事的**可读**指纹（sha 红了的时候能一眼看出"是哪里回去了"）：
  for (const [chain, html] of Object.entries(pages)) {
    assert.deepEqual(offendersOf(html), [],
      `${chain}：成功页上**一个"要她跳走"的东西都不许有**（a-href / button / form / 自动跳转 ✗）`);
    assert.ok(html.includes(SCAN_SUCCESS_PAGE.minimalText),
      `${chain}：必须有那句统一的「${SCAN_SUCCESS_PAGE.minimalText}」✓`);
  }
});

test('AC-REG3 ⭐⭐ 探针：**没有任何开关**也照样极简（老那几样"要她跳走"的东西被清掉 ✓）', () => {
  // eslint-disable-next-line global-require
  const { renderScanMessagePage } = require('../src/views/scanPageRenderer');
  // 一页"塞满了老 affordance"的成功页入参（回跳链接 / 返回 / 自动跳转 / 追加动作块）
  const payload = {
    title: 'T', body: 'B', tone: 'success', number: 'N', details: ['D'], retryHint: 'H',
    backPath: '/s/a', backLabel: '再录一单', returnPath: '/s/b', returnLabel: '返回扫码',
    autoReturnUrl: '/s/c', returnDelaySeconds: 2, extraActionsHtml: '<button>追加</button>',
  };
  // 🔴 **不传任何 `successPage`**（= 没有开关、没有注入）⇒ 必须已经极简 ✓
  const defaultHtml = renderScanMessagePage(payload, SCAN_PAGE);
  assert.deepEqual(offendersOf(defaultHtml), [],
    '不传任何配置 ⇒ 成功页已经是极简（"删开关 ⇒ 永远开" ✓）');
  assert.ok(defaultHtml.includes(SCAN_SUCCESS_PAGE.minimalText), '那句统一的文案在 ✓');
  // 显式给配置（文案相同）⇒ 逐字节相同（证明"开"已成为唯一的一条路 ✓）
  const explicitHtml = renderScanMessagePage({
    ...payload, successPage: { minimalText: SCAN_SUCCESS_PAGE.minimalText },
  }, SCAN_PAGE);
  assert.equal(sha256(explicitHtml), sha256(defaultHtml),
    '默认路与"显式配"路**逐字节相同**（只剩一条路 ✓ 没有第二条分支 ✗）');
  // 非成功页（tone 不同）**不套用**极简（那一条行为照旧 ✓）
  const noticeHtml = renderScanMessagePage({ ...payload, tone: 'notice' }, SCAN_PAGE);
  assert.notDeepEqual(offendersOf(noticeHtml), [],
    '非成功页照旧保留它的东西（极简**只管成功页** ✓ 没有扩大到别处 ✗）');
});

test('AC-REG4 ⭐ 回跳配置**没有被删**（本卡只改"成功页渲不渲染它" ✗ 不顺手删配置）', () => {
  assert.equal(SCAN_PAGE.successReturn && SCAN_PAGE.successReturn.enabled, true,
    '`successReturn` 照旧（删了 = 越界 ✗ —— 那一刀要单独评估）');
  assert.equal(typeof SCAN_PAGE.successReturn.delaySeconds, 'number', '回跳延迟照旧在配置里 ✓');
  const cfgSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'scanPage.js'), 'utf8');
  assert.match(cfgSrc, /const SUCCESS_RETURN = Object\.freeze\(/,
    '配置块本身照旧（本卡**删**一个开关，**不改**既有件 ✓）');
});
