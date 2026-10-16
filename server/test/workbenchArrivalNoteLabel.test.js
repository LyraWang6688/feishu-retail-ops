'use strict';

/**
 * ⭐⭐ 2026-10-16（task「到货说明必须得删」· 业务负责人逐字）：
 *   「**「到货说明」，到货说明必须得删**。因为目前我们的**数据表里面已经没有验收原话了**，
 *     这个是**之前我们的群聊链路**，跟这个**已经没有关系了**。**你必须得删**」
 *
 * 本文件**成对迁移**了两条既有判据（**不许删、不许 skip** ✗）：
 *
 * ① 原「到货说明标签不再承诺写进验收原话」（`#648` 合进来的那条 `AC-FB6-1`）
 *    · 改前逐字：`assert.equal(line.trim(), "arrivalNote: '到货说明',")`（配置里**有**这一项）
 *    · 改后逐字：`assert.equal(feature.includes('arrivalNote'), false)`（这一项与输入框**整条退场**）
 *    · 依据：她 2026-10-16 逐字「到货说明**必须得删**……数据表里已经没有验收原话了」✓
 *
 * ② 原「渲染处要用配置项 `T.arrivalNote`」（`AC-FB6-2`）
 *    · 改前逐字：`assert.ok(/\bT\.arrivalNote\b/.test(feature))`（要求渲染它）
 *    · 改后逐字：`assert.equal(/data-field="arrival-note"/.test(feature), false)`（**不许再渲染**）
 *    · 依据：同上 ✓
 *
 * 🔴 同时钉住 **扫码线判据一字不变**（那条线仍是活的）：
 *    · `scanArrivalService` 显式声明 `requireAcceptanceText: true`（会话层照旧要求非空原话 ✓）
 *    · `pageMessages.m4`（「请先写一句到货说明…」）**原样还在**（扫码线仍在用 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('AC-AN1 ⭐ 界面**不再出现**「到货说明」输入框（能真红：塞回那个 input ⇒ 红）', () => {
  const feature = read('public/workbench/features/orders/index.js');
  assert.equal(/data-field="arrival-note"/.test(feature), false, '⛔ 那个输入框不许再渲染 ✗');
  assert.equal(/\bT\.arrivalNote\b/.test(feature), false, '⛔ 不许再引用 `T.arrivalNote` ✗');
  assert.equal(/read\('arrival-note'\)/.test(feature), false, '⛔ 不许再读它的值 ✗');
  assert.equal(feature.includes('请先写一句到货说明'), false, '⛔ 那条"必填"拦截也随框退场 ✓（她说了必须删 ✓）');
  // ⭐ 其余验收能力**一个不少**（AC-AN6 的前半）：发生金额 + 提交按钮 + 明细行都还在 ✓
  assert.match(feature, /data-field="arrival-amount"/, '「发生金额」还在 ✓');
  assert.match(feature, /data-action="submit-arrival"/, '提交按钮还在 ✓');
  assert.match(feature, /data-field="arrival-actual"/, '逐码实际到货输入还在 ✓');
});

test('AC-AN4 配置里**0 孤儿**（能真红：把 `arrivalNote:` 塞回配置 ⇒ 红）', () => {
  const config = read('public/workbench/config/orders.js');
  const feature = read('public/workbench/features/orders/index.js');
  // ⚠️ 判据只抓「**真的当配置项用**」（行首缩进 + `key:`）—— 注释里**说明"为什么删了"**是应当的 ✓
  for (const gone of ['arrivalNote', 'defaultAcceptanceText']) {
    const used = new RegExp(`^\\s{2}${gone}\\s*:`, 'm');
    assert.equal(used.test(config), false, `⛔ 配置里不许再有 ${gone} 这一项 ✗`);
    assert.equal(used.test(feature), false, `⛔ 渲染处不许再有 ${gone} 这一项 ✗`);
    assert.equal(new RegExp(`\\bT\\.${gone}\\b`).test(feature), false, `⛔ 不许再引用 T.${gone} ✗`);
  }
  // 工作台这条**不再传** `acceptanceText`（路由 / 服务各一处）
  const route = read('src/routes/workbench.js');
  const service = read('src/services/workbenchPurchaseArrivalService.js');
  assert.equal(/acceptanceText:\s*req\.body/.test(route), false, '⛔ 路由不许再转参 ✗');
  assert.equal(/acceptanceText\s*=/.test(service), false, '⛔ 工作台到货服务不许再收入参 ✗');
  assert.equal(/^\s*acceptanceText,\s*$/m.test(service), false, '⛔ 也不许再透传 ✗');
});

test('AC-AN2 ⭐⭐ 工作台**不再要求**那句原话（能真红：把判据放回"无条件要求" ⇒ 红）', () => {
  const conversation = read('src/services/purchaseArrivalConversationService.js');
  // ⭐ 判据收窄成"由调用方声明"：`!text && requireAcceptanceText`
  assert.match(conversation, /if \(!text && requireAcceptanceText\)/,
    '⭐ 空值拒绝必须**只在调用方声明时**生效（工作台那条不声明 ⇒ 验收照常成功 ✓）');
  assert.equal(/if \(!text\) \{\s*return \{\s*ok: false,\s*reason: 'acceptance_text_missing'/.test(conversation), false,
    '⛔ 不许再无条件要求（那会让工作台验收变成"假卡" ✗）');
  assert.match(conversation, /requireAcceptanceText = false/, '默认**不要求** ⇒ 工作台直接可用 ✓');
});

test('AC-AN3 ⭐ 扫码线**非空要求照旧**（能真红：把它放水 ⇒ 红）', () => {
  const scan = read('src/services/scanArrivalService.js');
  assert.match(scan, /requireAcceptanceText: true/, '⭐ 扫码线必须**显式声明**要那句话 ✓');
  assert.match(scan, /acceptanceText,/, '扫码线那条原话**照旧**传 ✓');
  assert.match(scan, /acceptanceTextTemplate/, '模板仍走既有配置 `scanWrite.js` 的 acceptanceTextTemplate ✓');
  const conversation = read('src/services/purchaseArrivalConversationService.js');
  assert.match(conversation, /message: pageMessages\.m4/, '那条人话仍在（扫码线还在用 ✓）');
  const texts = read('src/config/purchaseArrivalTexts.js');
  assert.match(texts, /请先写一句到货说明/, '`pageMessages.m4` 原文**逐字不动** ✓');
});
