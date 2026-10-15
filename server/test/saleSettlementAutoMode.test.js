'use strict';

/**
 * ⭐⭐ 2026-10-16（业务负责人逐字 · 资金页两点之一）：
 *   「**1. 未付、全付的差额怎么进未收款**」
 *
 * 她的口径（同一句话的完整版，见 `docs/sales-async-write-2026-10-14.md` 与
 * `config/scanWrite.js:1047-1053`）：「**只要本次付的金额小于累计的，那么差额都是未收款，
 * 包括本次付款为 0**」。
 *
 * ⇒ 资金页**不再让她选档**：档位由「**本次填写的金额 vs 货品累计金额**」自动定出来
 *   （`config/saleSettlement.js` 的纯函数 `autoModeOf`），差额交给**既有业务层**落一条【未收款】。
 *
 * ⚠️ 本文件只测**那个纯函数**（不碰 IO、不起服务器）——"定档结果 ⇒ 真落库几行"那半边
 *   在 `test/scanSaleTwoLayerMoney.test.js` 的 `AC-AM-E2E-*`（真网关 + 真业务层）。
 * ⚠️ **语义键不新造**：`mode` 只可能是 `full` / `partial` / `unpaid`（与
 *   `config/scanWrite.js` 的 `PAYMENT_STATUS` 同一份真源）；文案/取值都不在本文件里 ✓。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC-AM1 **四档边界**：已收 0 / 中间 / 相等 / 超出 各算什么档、差额多少（**分**）。
 *   AC-AM1b **累计不可知 ⇒ 不猜「全付」**（累计 ≤ 0 却报"收齐了"就是编 ✗）。
 *   AC-AM2 ⭐ **换配置即换行为**：注入一份假规则 ⇒ 同一输入行为变，**代码零改动**。
 *   AC-AM3 ⭐ **语义键唯一真源**：`mode` 与 `scanWrite` 的三档对齐；block 复用既有 `amount_mismatch`
 *           （路由能直接拿这个码去取**既有**文案 ⇒ 不在配置里新造中文 ✗）。
 *   AC-AM4 **运行期不产生中文**：返回的每个值里都没有汉字（文案只在 `texts` / `labelKey`）。
 *   AC-AM5 **稳健**：缺参 / 非数字 / 负数 ⇒ 当 0 处理，**不抛异常**、也不乱说"收齐了"。
 * ─────────────────────────────────────────────────────────────────────────
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { autoModeOf, AUTO_MODES, settlementOf, resolveSettlement } = require('../src/config/saleSettlement');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const yuan = (value) => Math.round(Number(value) * 100);

// ═══════════════════════════════════════════════════════════════════════════
// AC-AM1 四档边界（含差额）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AM1 ⭐⭐ 四档边界：本次已收 0 / 中间 / 相等 / 超出 各定成哪一档、差额多少', () => {
  const items = yuan(3000); // 货品累计 ¥3000

  // ① 本次填 0 ⇒ 未付 + **差额 = 累计**（她逐字：「包括本次付款为 0」）
  const none = autoModeOf({ itemsCents: items, paymentsCents: 0 });
  assert.equal(none.action, 'allow');
  assert.equal(none.mode, 'unpaid', '一分没付 ⇒ 未付');
  assert.equal(none.owedCents, items, '差额 = 累计（那一条【未收款】要照写）');

  // ② 中间 ⇒ 部分付 + 差额 = 累计 − 已收
  const partial = autoModeOf({ itemsCents: items, paymentsCents: yuan(1000) });
  assert.equal(partial.action, 'allow');
  assert.equal(partial.mode, 'partial', '0 < 已收 < 累计 ⇒ 部分付');
  assert.equal(partial.owedCents, yuan(2000), '差额 = ¥2000');

  // ③ 相等 ⇒ 全付 + 差额 0（**一条【未收款】都不写**）
  const full = autoModeOf({ itemsCents: items, paymentsCents: items });
  assert.equal(full.action, 'allow');
  assert.equal(full.mode, 'full', '已收 = 累计 ⇒ 全付');
  assert.equal(full.owedCents, 0, '收齐了 ⇒ 没有差额');

  // ④ 超出 ⇒ 拦住（既有那条"收多了"的口径，**不放宽** ✗）
  const over = autoModeOf({ itemsCents: items, paymentsCents: yuan(3100) });
  assert.equal(over.action, 'block');
  assert.equal(over.mode, null, '拦住的这一次**不定档**（不许拿一个档位去写库 ✗）');
  assert.equal(over.owedCents, 0);
  assert.equal(over.code, 'amount_mismatch', '复用既有错误码（路由据此取既有文案 ✓）');

  // ⑤ 分币：一分不差的边界（不许拿浮点数比）
  const cents = autoModeOf({ itemsCents: 9999, paymentsCents: 9999 });
  assert.equal(cents.mode, 'full', '精确到分：9999 === 9999 ⇒ 全付');
  assert.equal(autoModeOf({ itemsCents: 9999, paymentsCents: 9998 }).owedCents, 1, '差 1 分也如实算差额');
});

test('AC-AM1b ⭐ 累计不可知（≤ 0）⇒ **不猜「全付」**，落未付（没有累计就别替她说"收齐了" ✗）', () => {
  for (const itemsCents of [0, undefined, null, '']) {
    const got = autoModeOf({ itemsCents, paymentsCents: 0 });
    assert.equal(got.action, 'allow', `累计 ${JSON.stringify(itemsCents)} ⇒ 不拦（她只是还没填实收）`);
    assert.equal(got.mode, 'unpaid', `累计 ${JSON.stringify(itemsCents)} ⇒ 未付（**不是**全付 ✗）`);
    assert.equal(got.owedCents, 0, '没有累计 ⇒ 差额算不出来 ⇒ 0（**不编** ✗）');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AM2 换配置即换行为
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AM2 ⭐⭐ 换配置即换行为：注入一份假规则 ⇒ 同一输入行为随之变，**代码零改动**', () => {
  const input = { itemsCents: yuan(3000), paymentsCents: yuan(1000) };
  assert.equal(autoModeOf(input).mode, 'partial', '默认配置：中间 ⇒ 部分付');

  const fake = { ...AUTO_MODES, underItems: 'full' };
  assert.equal(autoModeOf(input, fake).mode, 'full', '换配置 ⇒ 同一输入定成「全付」（代码一行没改）');

  const fakeOver = { ...AUTO_MODES, over: { action: 'block', reason: 'fake_reason', code: 'fake_code' } };
  const over = autoModeOf({ itemsCents: yuan(3000), paymentsCents: yuan(3100) }, fakeOver);
  assert.equal(over.action, 'block');
  assert.equal(over.code, 'fake_code', '换配置 ⇒ 连错误码都跟着换 ✓');
  assert.equal(autoModeOf({ itemsCents: yuan(3000), paymentsCents: yuan(3000) }, fakeOver).action, 'allow',
    '相等那一档没被假配置动过（仍是放行）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AM3 语义键唯一真源 · 与既有三档 / 既有校验对齐
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AM3 ⭐ `mode` 只可能是既有三档，且「自动定的档 + 同一份金额」不许撞上旧校验的 block', () => {
  const modeOfConfig = SCAN_WRITE.sale.paymentStatus.mode;
  const cases = [
    { itemsCents: yuan(3000), paymentsCents: 0, expected: 'unpaid' },
    { itemsCents: yuan(3000), paymentsCents: yuan(1000), expected: 'partial' },
    { itemsCents: yuan(3000), paymentsCents: yuan(3000), expected: 'full' },
    { itemsCents: 0, paymentsCents: 0, expected: 'unpaid' },
  ];
  for (const item of cases) {
    const auto = autoModeOf(item);
    assert.equal(auto.mode, item.expected, `${item.paymentsCents}/${item.itemsCents} ⇒ ${item.expected}`);
    assert.ok(modeOfConfig[auto.mode], `${auto.mode} 必须能在 scanWrite 的 paymentStatus.mode 里找到（同一份真源）`);
    assert.ok(settlementOf(auto.mode), `${auto.mode} 必须是 settlementOf 认得的档位（路由那句前置校验认它）`);
    // ⭐ 关键：自动定出来的档位 + **同一份金额**交给既有 resolver ⇒ **不许 block**
    //    （block 就等于"差额进不了那条【未收款】"，她的第一点又落空 ✗）
    const settled = resolveSettlement({
      mode: auto.mode,
      itemsCents: item.itemsCents,
      paymentsCents: item.paymentsCents,
      hasPaymentRows: item.paymentsCents > 0,
      anyLineAmount: item.itemsCents > 0,
      paidCents: item.paymentsCents,
    });
    assert.notEqual(settled.action, 'block', `自动定的「${auto.mode}」不许撞上旧校验的 block`);
  }
  // 累计不可知 ⇒ 落到既有的「未付」那一档（pending = 只记货，与 2026-10-11 晚的口径一致）
  assert.equal(resolveSettlement({ mode: 'unpaid', itemsCents: 0, paymentsCents: 0, hasPaymentRows: false }).action,
    'pending', '未付 = 只记货（既有口径）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AM4 运行期不产生中文
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AM4 ⭐ 这个纯函数**运行期不产生中文**（文案只在 texts / labelKey；三档取值在 scanWrite）', () => {
  const samples = [
    autoModeOf({ itemsCents: 1000, paymentsCents: 0 }),
    autoModeOf({ itemsCents: 1000, paymentsCents: 400 }),
    autoModeOf({ itemsCents: 1000, paymentsCents: 1000 }),
    autoModeOf({ itemsCents: 1000, paymentsCents: 1200 }),
    autoModeOf({}),
  ];
  for (const sample of samples) {
    const text = JSON.stringify(sample);
    assert.equal(/[\u4e00-\u9fa5]/.test(text), false, `返回值里不许有中文：${text}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AM5 稳健（缺参 / 非数字 / 负数）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AM5 ⭐ 稳健：缺参 / 非数字 / 负数 ⇒ 当 0 处理，**不抛**、也不乱说"收齐了"', () => {
  for (const input of [undefined, {}, { itemsCents: null }, { itemsCents: 'abc' }, { itemsCents: -100 }]) {
    const got = autoModeOf(input);
    assert.equal(got.action, 'allow', `${JSON.stringify(input)} ⇒ 不抛、也不拦（单子照建）`);
    assert.equal(got.mode, 'unpaid', `${JSON.stringify(input)} ⇒ 未付（**不猜全付** ✗）`);
    assert.equal(got.owedCents, 0);
  }
  // 负数当 0：本次"已收 -1 元"不该变成一条负差额
  assert.equal(autoModeOf({ itemsCents: -100, paymentsCents: -100 }).owedCents, 0);
  assert.equal(autoModeOf({ itemsCents: 1000, paymentsCents: -100 }).mode, 'unpaid', '负的本次金额当 0 ⇒ 未付');
});
