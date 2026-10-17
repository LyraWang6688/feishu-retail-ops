'use strict';

/**
 * ⭐⭐ 静态哨兵：**真表 E2E `scanMoneyPageTwoStepVerify.test.js` 的"资金页形状"不许退回旧口径** ✗
 *
 * 为什么需要它：那个文件是**真表 E2E**（要真凭证 + 会写测试 Base ⇒ 主套件与 CI **排除**它 ✓
 * `ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify`）⇒ 它里面的**旧形状**在 CI 里
 * **永远不会红** ✗ —— 2026-10-16 就是这么漏掉 V4 的（带真凭证跑才红 ✓）。
 * ⇒ 所以本文件用**静态**方式把它钉住：**塞回旧形状 ⇒ 主套件当场红** ✓（不必有真凭证 ✓）
 *
 * 她 2026-10-16 的两条口径（逐字）：
 *   · 「**去掉三个单选、按金额自动算**」⇒ 请求体里**不该再有**「全付 / 部分付 / 未付」这种**档位字段** ✗
 *   · 「**实收金额用户必须填写**……**不用做那个为空去单价的功能了**」⇒ 金额为空**不是**"按单价兜底" ✗
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ⭐ 2026-10-17：真实 Base 用例已迁到 test/realbase/（默认入口不再收它）⇒ 静态哨兵跟着读新路径
const E2E = path.join(__dirname, 'realbase', 'scanMoneyPageTwoStepVerify.test.js');
const source = fs.readFileSync(E2E, 'utf8');

/** 剥掉注释（`//` 与 `/* *​/`）—— 只扫"真的会发出去的东西" ✓（改前逐字写在注释里不算 ✗） */
const stripComments = (text) => String(text)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');

/** 取某个用例的**代码块**（从 `test(\`V4 · …` 起，到下一个 `test(` 或文件末）。 */
const caseBlock = (tag) => {
  const start = source.indexOf(`test(\`${tag}`);
  assert.ok(start > 0, `找不到用例 ${tag}（改名了？⇒ 本哨兵要跟着改 ✓）`);
  const next = source.indexOf('\ntest(', start + 1);
  return source.slice(start, next > 0 ? next : source.length);
};

// ── AC-V4-1：V4 那一发**不许**再带档位字段 ✗（塞回 ⇒ 红 ✓）──────────────────────────
test('AC-V4-1 🔴 V4 的请求体**不带档位字段**（`payment_status` / 「全付|部分付|未付」⇒ 塞回即红）', () => {
  const block = stripComments(caseBlock('V4 · '));
  assert.equal(/payment_status/.test(block), false,
    'V4 **不许**再发 `payment_status`（档位已退场 ✗ —— 她：「去掉三个单选、按金额自动算」）');
  for (const tier of ['全付', '部分付', '未付']) {
    assert.equal(block.includes(tier), false,
      `V4 **不许**出现档位字面量「${tier}」✗（档位由金额自动算 ✓）`);
  }
});

// ── AC-V4-2：V4 的**三件断言**一件都不许少 ✗（删一条 ⇒ 红 ✓）────────────────────────
test('AC-V4-2 🔴 V4 仍钉住三件：**钱零写入** ＋ **金额必填人话** ＋ **原地重渲染资金页**', () => {
  // ⭐ 2026-10-17 成对迁移（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.deepEqual(after, before` ＋ `/差|不符|对不上|金额|没提交成功/`
  //     （旧口径：整单四表零写入 + 差额人话）
  //   改后逐字：`assert.equal(after.payment - before.payment, 0` ＋ `/金额必须填写/`
  //     （④ 后点提交已建「货」那一单 ⇒ "零写入"收窄成**钱那一半零写入**；
  //      她 2026-10-18 起资金页金额必填，未填 ⇒ 400 +「金额必须填写」人话）
  //   依据 = 她 2026-10-18 逐字：「资金页面也得填写了，必须填写…0 也可以填，必须得填写金额」
  const block = caseBlock('V4 · ');
  assert.match(block, /assert\.equal\(after\.payment - before\.payment, 0/,
    'V4 必须仍钉「钱那一半零写入」（不许假成功 ✗）');
  assert.match(block, /payment_pay/, 'V4 必须仍钉「原地重渲染资金页」（她能改 ✓）');
  assert.match(block, /assert\.match\(bad\.html, \/金额必须填写\//,
    'V4 必须仍钉「金额必须填写」那一条人话断言（删掉 ⇒ 红 ✓）');
});

// ── AC-V4-3：**整份真表 E2E 里一处都不许再有档位字段**（塞回 ⇒ 红 ✓）─────────────────
// ⭐ 2026-10-16 收紧：V2（:220 附近）/ V3（:286 附近）已随本刀一起去掉档位 ⇒ 现在应当是 **0 处** ✓
//    （改前逐字写在注释里 ✓ 不算 ✗ —— 本哨兵先剥注释再数 ✓）
test('AC-V4-3 🔴 整份真表 E2E 里**一处都不许**再有档位字段（塞回即红 ✗）', () => {
  const code = stripComments(source);
  const hits = code.split('\n')
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter((x) => /payment_status/.test(x.line));
  assert.equal(hits.length, 0,
    `真表 E2E 里**一处都不许**再有档位字段（V2/V3/V4 都已迁移 ✓）；实际 ${hits.length} 处：`
    + hits.map((h) => `${h.no}: ${h.line}`).join(' | '));
  for (const tier of ['全付', '部分付', '未付']) {
    assert.equal(code.includes(`'${tier}'`), false,
      `真表 E2E 里**一处都不许**再有档位字面量「${tier}」✗（档位由金额自动算 ✓）`);
  }
  // ⭐ 并且 V4 那一块**一处都不许有**（与 AC-V4-1 双重钉 ✓）
  const block = stripComments(caseBlock('V4 · '));
  assert.equal(/payment_status/.test(block), false, 'V4 块里一处都不许有 ✗');
});

// ── AC-V4-4：V4 的迁移**留痕**（改前逐字 → 改后逐字 → 依据）——不许只改代码不写依据 ✗ ──
test('AC-V4-4 ⭐ V4 的迁移**必须留痕**：改前逐字 ＋ 改后逐字 ＋ 依据（她 2026-10-16 逐字）', () => {
  assert.match(source, /改前逐字[\s\S]{0,400}payment_status/, 'V4 要写清**改前逐字**（那时发的什么 ✗）');
  assert.match(source, /改后逐字/, 'V4 要写清**改后逐字**（现在发的什么 ✓）');
  assert.match(source, /去掉三个单选、按金额自动算/, 'V4 的要写依据 = 她 2026-10-16 逐字「去掉三个单选、按金额自动算」');
});
