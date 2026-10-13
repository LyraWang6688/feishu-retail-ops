'use strict';

/**
 * ⭐⭐ 2026-10-14（业务负责人口径）：「这个不应该是 if else，而是用配置文件的思路」。
 *
 * 这一步**只做加法**：把「全付 / 部分付 / 未付」的**判定**从 `scanWriteService` 的 if 链抽成
 * **表 + 一个纯函数**（本文件只测这两样）。**service 一个字没改** ⇒ 生产行为零变化 ✓
 * （把 `:886-965` 换成"调 resolver + 按 action 分支"是**下一步**，那时才动 service ✓）
 *
 * 逐处对照（我按代码核出来的，不是按草案抄的）：
 *   · 「全付 + 没有收款行」其实是**两种**：① 哪儿都没钱（收款行空 **且** 每件实收全空）⇒ **block**
 *     `full_without_money`（`:886`）；② 没有收款行但**实收有值** ⇒ **degrade → 未付**（`:898-899`）
 *   · `amount_mismatch` 有**两个 site**：全付两边不等（`:900-910`）与"已收 > 每件实收合计"（`:952-965`）
 *   · 实际共 **5 个 fail code**：`full_without_money` · `amount_mismatch`(×2) ·
 *     `partial_amount_missing` · **`partial_amount_mismatch`**（草案里漏了这个）
 *   · 「未付」= **状态未付 + 不写欠款行**（`owed = 0`）⇒ 这里叫 `action: 'pending'`（语义不变 ✓）
 *   · 状态值只引用 `config/scanWrite.js` 的 `PAYMENT_STATUS`（语义键 full/partial/unpaid）——
 *     本配置**只有 labelKey，没有中文字面量** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const saleSettlement = require('../src/config/saleSettlement');
const { resolveSettlement, SETTLEMENTS, settlementOf } = saleSettlement;

const base = { hasPaymentRows: false, anyLineAmount: false, itemsCents: 0, paymentsCents: 0, paidCents: null };

test('AC-1 ⭐⭐ 逐档参数化：full / partial / unpaid 各组合 ⇒ action ∈ {allow, block, degrade, pending}', () => {
  const cases = [
    // 全付：哪儿都没钱 ⇒ block（`:886`）
    ['全付 + 没收款行 + 没实收 ⇒ block full_without_money',
      { ...base, mode: 'full', itemsCents: 9900, hasPaymentRows: false, anyLineAmount: false },
      { action: 'block', code: 'full_without_money', reason: 'full_without_money' }],
    // 全付：没收款行但实收有值 ⇒ degrade → 未付（`:898-899`，她 2026-10-11 点头过的口径）
    ['全付 + 没收款行 + 实收有值 ⇒ degrade 到未付',
      { ...base, mode: 'full', itemsCents: 9900, hasPaymentRows: false, anyLineAmount: true },
      { action: 'degrade', effectiveMode: 'unpaid', owedCents: 0, code: null }],
    // 全付：填了收款行但两边不等 ⇒ block（`:900-910`）
    ['全付 + 有收款行 + 金额不等 ⇒ block amount_mismatch',
      { ...base, mode: 'full', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 0 },
      { action: 'block', code: 'amount_mismatch' }],
    ['全付 + 有收款行 + 金额相等 ⇒ allow',
      { ...base, mode: 'full', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 9900 },
      { action: 'allow', effectiveMode: 'full', owedCents: 0, code: null }],
    // 部分付
    ['部分付 + 实付没填 ⇒ block partial_amount_missing',
      { ...base, mode: 'partial', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 4000, paidCents: null },
      { action: 'block', code: 'partial_amount_missing' }],
    ['部分付 + 实付 ≠ 收款合计 ⇒ block partial_amount_mismatch',
      { ...base, mode: 'partial', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 4000, paidCents: 5000 },
      { action: 'block', code: 'partial_amount_mismatch' }],
    ['部分付 + 实付 = 收款合计 < 应收 ⇒ allow + 欠款 = 差额',
      { ...base, mode: 'partial', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 5000, paidCents: 5000 },
      { action: 'allow', effectiveMode: 'partial', owedCents: 4900, code: null }],
    ['部分付 + 已收 > 应收 ⇒ block amount_mismatch（超标）',
      { ...base, mode: 'partial', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 12000, paidCents: 12000 },
      { action: 'block', code: 'amount_mismatch' }],
    // 未付
    ['未付 ⇒ pending（状态未付 + 不写欠款行）',
      { ...base, mode: 'unpaid', itemsCents: 9900, paymentsCents: 0 },
      { action: 'pending', effectiveMode: 'unpaid', owedCents: 0, code: null }],
    ['未付 但收款行合计超过应收 ⇒ 一样 block（`:952`）',
      { ...base, mode: 'unpaid', itemsCents: 9900, hasPaymentRows: true, paymentsCents: 12000 },
      { action: 'block', code: 'amount_mismatch' }],
    // 拿不到档位 ⇒ 不猜
    ['认不出的档位 ⇒ block unknown_mode（不猜）',
      { ...base, mode: '半付' },
      { action: 'block', code: 'unknown_mode' }],
  ];
  for (const [label, input, expected] of cases) {
    const got = resolveSettlement(input);
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(got[key], value, `${label} ⇒ ${key} 应为 ${JSON.stringify(value)}（实际 ${JSON.stringify(got[key])}）`);
    }
    assert.ok(['allow', 'block', 'degrade', 'pending'].includes(got.action), `${label} ⇒ action 必须是四者之一`);
  }
});

test('AC-2 ⭐⭐ 换配置即换行为：喂一份假配置（`full.whenMissingRows.action=block`）⇒ 同输入行为随之变，**代码零改动**', () => {
  const input = { ...base, mode: 'full', itemsCents: 9900, hasPaymentRows: false, anyLineAmount: true };
  assert.equal(resolveSettlement(input).action, 'degrade', '默认配置下：全付 + 没收款行 + 有实收 ⇒ degrade');
  const fake = {
    ...SETTLEMENTS,
    full: { ...SETTLEMENTS.full, whenMissingRows: { action: 'block', reason: 'fake_reason', code: 'fake_code' } },
  };
  const got = resolveSettlement(input, fake);
  assert.equal(got.action, 'block', '换配置后 ⇒ block（同一份输入、同一份代码）');
  assert.equal(got.code, 'fake_code');
  assert.equal(got.reason, 'fake_reason');
});

test('AC-3 ⭐⭐ 5 个 fail code 逐档覆盖（含草案里漏掉的 `partial_amount_mismatch`）', () => {
  const codes = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.code === 'string') codes.add(node.code);
    for (const value of Object.values(node)) walk(value);
  };
  walk(SETTLEMENTS);
  for (const code of ['full_without_money', 'amount_mismatch', 'partial_amount_missing', 'partial_amount_mismatch']) {
    assert.ok(codes.has(code), `配置表里必须有 ${code}`);
  }
  assert.equal(codes.size, 4, `fail code 恰好这 4 个（实际 ${[...codes].join(',')}）`);
  assert.equal(settlementOf('full').labelKey, 'paymentStatusFull');
  assert.equal(settlementOf('partial').labelKey, 'paymentStatusPartial');
  assert.equal(settlementOf('unpaid').labelKey, 'paymentStatusUnpaid');
  assert.equal(settlementOf('nope'), null, '拿不到档位 ⇒ null ⇒ 不猜');
});

test('AC-4 ⭐ 配置里**不许有中文字面量**（文案只给 labelKey；状态值只引用语义键）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config/saleSettlement.js'), 'utf8');
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.ok(!/[\u4e00-\u9fa5]/.test(body), '代码部分不许出现中文（文案走 labelKey，状态值走语义键 ✓）');
});

test('AC-5 ⭐ 状态值只有一个真源：语义键 full/partial/unpaid 与 `scanWrite.js` 的 `PAYMENT_STATUS` 对齐', () => {
  const { SCAN_WRITE } = require('../src/config/scanWrite');
  const mode = SCAN_WRITE.sale.paymentStatus.mode;
  for (const key of Object.keys(SETTLEMENTS)) {
    assert.ok(mode[key], `scanWrite 的 paymentStatus.mode 里要有 ${key}（状态值真源）`);
  }
  assert.equal(saleSettlement.PAY_MODES.length, 3);
});

// ⏸ 第 3 步（把 service 的 :886-965 换成"调 resolver"）合了之后，这条才该启用 —— 现在是**预期红**，
//   因为那些串**还在 service 里**（本步只做加法、不动 service ✓ 不留红测试 ✓）
test.skip('AC-6 ⭐ 源码哨兵（第 3 步启用）：`scanWriteService.js` 里不许再出现这些特征串', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/scanWriteService.js'), 'utf8');
  for (const token of ['full_without_money', 'partial_amount_missing', 'partial_amount_mismatch']) {
    assert.ok(!source.includes(`'${token}'`), `${token} 只能出现在 config/saleSettlement.js 里`);
  }
});
