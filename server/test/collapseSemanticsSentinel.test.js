'use strict';
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 2026-10-16（task-48 审计 · Lead 批的 ① + ②）：把**每一处 `<details>` 的收/展状态**钉进判据
 *
 * 为什么需要它：折叠决定**用户第一眼看到什么**，但审计发现 **11 / 13 处没有任何判据** ✗ ——
 *   于是"某个 agent 顺手把它从展开改成收起"**谁都不会红**（task-47 的退货缺口就是这样活到今天的 ✗）。
 *   ⇒ 本文件**只钉状态、不改任何外观/行为** ✓（`src/` 一个字节不动 ✓）
 *
 * 🔴 两条口径写在这里（免得以后被当成"技术偏好"改掉 ✗）：
 *   · 「**一键补货**」默认收起**是她的口径** —— 她 2026-10-16 逐字：
 *     「**补货不用动，因为补货和退货的页面不一样**」✓ ⇒ 这里**只钉"它就该收起"**，
 *     **外观一个字不动** ✗（不许加 `open`、不许改样式 ✗）
 *   · ⚠️ **2026-10-16 订正（陈旧口径）** —— 原文逐字：「「退货」默认**展开**是 task-47 修的口径
 *     （她：「只有一个退货按钮，点它之后才出现下面的内容」✗）」
 *     ⇒ 那句**已被今晚那一刀取代** ✗：「退货」块**不再有折叠壳**（#691 收尾去掉）——
 *     「首屏即见表单」＝**没有** `<details>` 可展开/收起 ⇒ 对本文件而言它**不在「折叠语义」的名单里** ✓
 *     （判据**一个字没动** ✗ —— 这里只是把口径订正到现况 ✓）
 *
 * 能真红（逐条验过 · 见 PR 说明）：把源码里那处的收/展**改一下** ⇒ 对应用例红 ✓（改完字节还原 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAW_SCAN = rendererSource();
const RAW_ORDERS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'workbench', 'features', 'orders', 'index.js'), 'utf8',
);
// ⚠️ 先剥注释再找标签：否则会命中注释里那些"改前逐字"的旧标签 ✗（第一版就踩过）
const strip = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')                                  // 块注释
  .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'); // ⚠️ 行注释也要剥：我的"改前逐字"留痕就在 `//` 里 ✗（第一版漏了 ⇒ 假红 ✓）

/** 取**所有**匹配到的开始标签（`<details …>`）—— 用来做"这一类一律…"的合并哨兵 ✓ */
const tagsOf = (source, needle) => [...strip(source).matchAll(new RegExp(`<details[^>]*${needle}[^>]*>`, 'g'))]
  .map((match) => match[0]);

// 🔴 2026-11-27：补货扫码页整体删除 ⇒ 这条「一键补货 `<details>` 默认收起」的哨兵**只针对补货页**，
//   随页面一起删除（提交信息里写明）。其余折叠语义判据（退货 / 特殊码 / 已到货 / 工作台）**一条没动** ✓。

test('① 退货 `purchase-return`：**已不再是折叠块**（0 处 `<details>` ⇒ 表单恒可见 ✓ 没有折叠状态可言）', () => {
  // 改前逐字（task-47 那一刀的判据）：
  //   const tags = tagsOf(RAW_SCAN, 'data-view="purchase-return"');
  //   assert.equal(tags.length, 1, '恰一处 ✓');
  //   assert.equal(/\sopen(\s|>)/.test(tags[0]), true, '去掉 open ⇒ 首屏又只剩一颗「退货」⇒ 红 ✓');
  // 改后逐字：下面这三行
  // 依据：业务负责人 **2026-10-16 真机截图 + 逐字**「退货那个确实点击了之后确实是出现了表单，
  //   但是那个**退货按钮为什么还有呢，不需要了**」—— 上一刀已加 `open`（表单首屏可见 ✓）
  //   ⇒ 那颗实心通栏 `<summary>` 连同 `<details>` 包壳**一起去掉** ✓
  // 🔴 反向哨兵：把 `<details data-view="purchase-return">` 塞回来 ⇒ `tags.length` 变 1 ⇒ **红** ✓
  const tags = tagsOf(RAW_SCAN, 'data-view="purchase-return"');
  assert.equal(tags.length, 0, '退货块**不该再有 `<details>`** ✗（塞回即红 ✓）');
});

test('① 特殊码折叠 `size-fold`：**条件**展开（`${open}` —— 不许改成固定收起/展开 ✗）', () => {
  const tags = tagsOf(RAW_SCAN, 'data-special-fold="1"');
  assert.equal(tags.length, 1, '恰一处 ✓');
  assert.match(tags[0], /\$\{open\}/, '它按她的口径**按条件**收/展 ⇒ 改成固定值 ⇒ 红 ✓');
});

test('① 已到货折叠 `purchase-arrived`：**整段退场**（业务负责人 2026-11-09：只展示未到货）', () => {
  // 改前：已到货批次折叠在下面（`data-view="purchase-arrived"`，默认收起）
  // 改后：验收页只展示未到货 ⇒ 那段折叠**连模板一起删除**（塞回 ⇒ 这里红 ✓）
  const tags = tagsOf(RAW_ORDERS, 'data-view="purchase-arrived"');
  assert.equal(tags.length, 0, '⛔ 不许再渲染已到货折叠（塞回即红 ✓）');
});


test('② 一个操作表单（`action-form`）：验收卡改为跳独立页后，列表里不再有这类表单', () => {
  const tags = tagsOf(RAW_ORDERS, 'class="action-form"');
  assert.equal(tags.length, 0, `验收列表不再原地展开（实际 ${tags.length}）✓`);
});
