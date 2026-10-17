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

test('AC-AN2 ⭐⭐「验收原话」整条概念已删净（真表无此列；能真红：塞回即红）', () => {
  // ⭐ 2026-10-17 成对迁移（依据 = 她逐字「我们现在已经不走群聊和发语音了…数据库里面已经没有这个字段了…
  //   为什么还有验收原话？要把这里删掉呀」）：
  //   改前逐字：判据是"工作台不要求、扫码线仍要求那句原话"（两套行为）；
  //   改后逐字：**两边都不再要求、也不再拼那句话** —— 这个概念整体退场 ✓
  const conversation = read('src/services/purchaseArrivalConversationService.js');
  assert.equal(/acceptanceText|acceptance_text|requireAcceptanceText/.test(conversation), false,
    '⛔ 会话层不许再出现「验收原话」入参 / 判据 / 字段');
  const scan = read('src/services/scanArrivalService.js');
  assert.equal(/acceptanceText/.test(scan), false, '⛔ 扫码线也不许再拼 / 传那句话');
  const writeConfig = read('src/config/scanWrite.js');
  assert.equal(/acceptanceTextTemplate/.test(writeConfig), false, '⛔ 模板配置已随概念退场');
  const arrivalConfig = read('src/config/workbenchArrival.js');
  assert.equal(/acceptanceText/.test(arrivalConfig), false, '⛔ 验收配置里不许再有那个字段名');
});

test('AC-AN3 ⭐ 真表 / 前端也不许把那个输入或字段带回来（反向哨兵）', () => {
  const schema = read('src/config/v1BitableSchema.js');
  assert.equal(/acceptanceText:/.test(schema), false, '⛔ schema 不许再映射那一列（真表已无）');
  const copy = read('public/workbench/config/orders.js');
  assert.equal(/acceptanceText/.test(copy), false, '⛔ 前端字段表不许再有 acceptanceText');
  const landing = read('src/services/purchaseOrderBatchService.js');
  assert.equal(/wrote_acceptance_text/.test(landing), false, '⛔ 写批次那条日志字段也已退场');
});
