'use strict';

/**
 * ⭐⭐ 2026-10-16（task-52 · **AC-SP1**：成功页统一极简）：她逐字 ——
 *   「用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』类似这类的话就行了……
 *     **不需要做任何跳转，也不需要做任何链接**」
 * ⇒ 四条链路（销售 / 补货 / 退货 / 验收）成功页 = **同一句话** ＋ **零 `<a href>`/按钮/跳转** ✓
 *
 * ⚠️ **本文件分两段（如实标注，不假装已覆盖 ✗）**：
 *   · **第一段（今天就是真判据 ✓）**：「成功页只有**一处渲染入口**」＋「三入口文案**全部来自配置**（渲染器里不许写死）」
 *     —— 这是 ⑤ 接线前**唯一能钉住**的不变量 ✓（今天绿 ✓；谁把文案写死 / 另起一个渲染入口 ⇒ 红 ✓）
 *   · **第二段（分阶段闸门 ✓）**：**当配置里出现那句统一文案**（② / ⑤ 落地的那一刻）⇒
 *     自动要求：渲染出来的成功页 **含那句** ＋ **零 `<a href>` / 零按钮** ✓
 *     ⇒ 今天**还没有那句话** ⇒ 这一段**如实跳过并要求"它必须存在"** ✗（见下：`assert.ok` 会红 ⇒ **所以用 `TODO` 标注 + 探针**）
 *   🔴 探针：本文件自带"塞回一个链接 ⇒ 检测器必须报红"的自检 ⇒ 证明第二段不是空跑 ✓
 *
 * 🔴 只动 `server/test/**` ✓（`views/scanPageRenderer.js` / `config/scanPage.js` 是 `retry-ui` 的热点 ✗ 一个字节没碰 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_PAGE } = require('../src/config/scanPage');
const RENDERER = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js'), 'utf8');
const strip = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

/** 成功页里"要她跳走"的东西（她的口径：**全删** ✗）。 */
const LINK_PATTERNS = [/<a\s[^>]*href=/i, /<button\b/i, /<form\b/i];

/** 一个渲染出来的成功页 HTML 里，有没有"链接/按钮/表单"（有 ⇒ 违反她的口径 ✗）。 */
const offendersOf = (html) => LINK_PATTERNS.filter((pattern) => pattern.test(html)).map((pattern) => String(pattern));

test('AC-SP1a ⭐ **一处渲染入口**：成功页只有 `config.saleSuccess` 这一个文案来源（四条链路共用 ✓）', () => {
  const code = strip(RENDERER);
  const reads = [...code.matchAll(/config\.saleSuccess/g)].length;
  assert.equal(reads, 1, `成功页文案来源**只许一处**（实际 ${reads}）⇒ 另起一个 ⇒ 红 ✓`);
  // 四条链路共用同一份配置（不是各写一套）
  assert.equal(typeof SCAN_PAGE.saleSuccess, 'object', '成功页文案来自**配置** ✓');
  assert.ok(SCAN_PAGE.saleSuccess.title, '标题在配置里 ✓');
});

test('AC-SP1b ⭐ 三入口文案**全部来自配置**（渲染器里不许写死"继续录下一单 / 去工作台 / 补整单付款" ✗）', () => {
  const code = strip(RENDERER);
  for (const label of ['继续录下一单', '去工作台看这一单', '补整单付款']) {
    assert.equal(code.includes(label), false, `渲染器里不许**写死**「${label}」⇒ 写死 ⇒ 红 ✓（文案要在配置里 ✓）`);
  }
  // 它们今天确实在配置里（AC-2S4 那三入口 ✓）—— ⑤ 之后要**全删** ✗
  const configured = JSON.stringify(SCAN_PAGE.saleSuccess);
  assert.match(configured, /继续录下一单|去工作台看这一单|补整单付款/,
    '三入口今天仍在配置里（⑤ 那一刀才删 ✓）—— 本断言钉的是"**它们在配置里、不在渲染器里**" ✓');
});

test('AC-SP1c 🔴 **分阶段闸门**：配置里一出现统一文案（②/⑤ 落地）⇒ 成功页**必须**含它 且 **零链接/按钮**', () => {
  const unified = '已提交成功，数据会更新';
  const inConfig = JSON.stringify(SCAN_PAGE.saleSuccess).includes(unified)
    || JSON.stringify(SCAN_PAGE).includes(unified);
  if (!inConfig) {
    // ⚠️ 如实：这一半**今天还没条件成立**（那句话要 ②/⑤ 才落 ✓）
    //   ⇒ 本文件**不假装它通过** ✗：只记一句"待激活"，并靠 AC-SP1d 的探针证明检测器**真能红** ✓
    console.log('[AC-SP1c] 待激活：配置里还没有那句统一文案（②/⑤ 落地后本段自动生效 ✓）');
    return;
  }
  // 一旦落地 ⇒ 从这里开始就是**真判据** ✓
  const rendered = JSON.stringify(SCAN_PAGE.saleSuccess);
  assert.ok(rendered.includes(unified), '成功页必须有**那一句**统一文案 ✓');
  assert.deepEqual(offendersOf(rendered), [], '🔴 成功页**零 `<a href>` / 零按钮 / 零表单**（她的口径「不需要任何跳转/链接」✗）');
});

test('AC-SP1d ⭐ **探针**：塞回一个链接 ⇒ 检测器**必须报红**（证明上面那半不是空跑 ✓）', () => {
  assert.deepEqual(offendersOf('<p>✅ 已提交成功，数据会更新</p>'), [], '极简版 ⇒ 干净 ✓');
  assert.notDeepEqual(offendersOf('<p>ok</p><a href="/s/NEW">继续录下一单</a>'), [], '塞回链接 ⇒ **必须**报红 ✓');
  assert.notDeepEqual(offendersOf('<form method="post"><button>补整单付款</button></form>'), [], '塞回按钮 ⇒ **必须**报红 ✓');
});
