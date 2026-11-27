'use strict';
const { rendererSource } = require('./support/rendererSource');

/**
 * multiItemOrderRender.test.js —— 「一单多货品」**渲染半**的判据（补货 / 退货 两块）。
 *
 * 她的口径（逐字）：「核心就是…**销售、补货、退货支持一单多货**」
 * ⇒ 补货 / 退货那两块各要**一个"再加一个货品"入口 + 已加货品列表**，且表单**发得出去** `multi_items`。
 *
 * 钉四条（都能真红）：
 * - **AC-MIR1** 两块**都有**那个入口（源码哨兵：`multiItemBlockHtml` **恰好 2 处调用** ＋ 块本身含 `data-multi-add`）
 *   —— 去掉任一处 ⇒ 红
 * - **AC-MIR2** 载荷 `multi_items` 是**合法 JSON 且形状 = 设计 §4.3**（六个键 + `entries:[{size,quantity}]`，数量是**数字**）
 *   —— 改一个键名 ⇒ 红
 * - **AC-MIR3** ⭐ **没有开关**（2026-10-29）：配置上无 `enabled` ⇒ 那一块**永远渲染** ⇒
 *   两个表单**一个字节都不变**（旧字段逐字还在、**没有**任何新 DOM）—— 删掉那个闸门 ⇒ 红
 * - **AC-MIR4** 既有渲染判据 **0 行放宽**（`scanPageWrite` / `scanReturnBlockGuard` 等原样绿；见 PR 证据）
 *
 * ⚠️ 只读静态 + 纯函数 + 一次子进程（**不联网、不写任何 Base、不碰路由**）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const serverRoot = path.resolve(__dirname, '..');
const rendererPath = path.join(serverRoot, 'src', 'views', 'scanPageRenderer.js');
const rendererSrcText = rendererSource();
const renderer = require(rendererPath);
const { MULTI_ITEM_ORDER } = require(path.join(serverRoot, 'src', 'config', 'multiItemOrder.js'));

const VIEW = Object.freeze({
  product_record_id: 'recProductForRenderTest',
  number: 'HL92006',
  item_no: 'HM-1',
  color: '黑',
  supplier_record_id: 'recSupplierForRenderTest',
});

test('AC-MIR1 🔴 退货那一块**有**那个入口（去掉 ⇒ 红）＋ 补货那一处**已删**（塞回 ⇒ 红）', () => {
  // 🔴 2026-11-27：补货扫码页整体删除（业务负责人：「采购页扫一扫要有；其他的补货不需要」）
  //   ⇒ 这份渲染半判据**只剩退货这一处**：
  //     · 原意不变：**"那一块必须接上这个入口，不然就加不了第二个货品"** ✓；
  //     · 调用数从 2 翻成 **1**（补货那一处随页面一起退场）；**反向**钉住"补货那一处不许回来" ✓
  //       （塞回 ⇒ 红，比原来只数 2 处**多一条**判据）。
  const callSites = (rendererSrcText.match(/multiItemBlockHtml\(write, view[^)]*\)/g) || []).length;
  assert.equal(callSites, 1,
    `退货**恰一处**调用（实得 ${callSites} 处）—— 退货那块少一处就是"加不了第二个货品" ✗`);
  assert.equal(rendererSrcText.includes("multiItemBlockHtml(write, view, 'replenish'"), false,
    '🔴 补货扫码页已删除 ⇒ 渲染层**不许**再有补货那一处调用（塞回 ⇒ 红 ✓）');
  const ret = rendererSrcText.slice(rendererSrcText.indexOf('const returnFormHtml'));
  assert.ok(/multiItemBlockHtml\(write, view[^)]*\)/.test(ret), '退货块里必须接这个入口');
  // 🔴 退货那一处**必须显式传自己那一档** 'return'（= 走退货的精简版；传空 / 传别的 ⇒ 红 ✓）——
  //   判据原意不变（2026-10-16 真机：退货按钮改字 ＋ 删那三句说明 ⇒ 走 'return' 档），
  //   只是**补货那一处随页面退场**（2026-11-27）⇒ 这里只钉剩下那一处。
  assert.match(ret, /multiItemBlockHtml\(write, view, 'return'[^)]*\)/,
    '退货那一处**显式传自己那一档** \'return\' ⇒ 走退货的精简版 ✓（传空 / 传 \'replenish\' ⇒ 红 ✓）');
  assert.equal(/multiItemBlockHtml\(write, view, 'replenish'/.test(ret), false,
    '🔴 退货那一处**绝不许**传 \'replenish\'（补货扫码页已删除 ⇒ 更没有这一档 ✗）');

  const html = renderer.multiItemBlockHtml({}, VIEW);
  assert.match(html, /data-multi-add/, '那一块必须有「再加一个货品」的按钮');
  assert.match(html, /data-view="multi-item-list"/, '那一块必须有"已加货品"的列表');
  assert.match(html, new RegExp(`name="${MULTI_ITEM_ORDER.field}"`),
    '必须有那个 hidden 字段（字段名来自配置 ✓）');
  assert.doesNotMatch(html, /<script/i, '这一块里**不许有任何 `<script>`**（扫码页零 JS 是既有判据 ✗ 不放宽）');
  // 2026-11-24：旧 ?add=1 链接已删除，入口只剩表单 submit。
  assert.match(html, /<button[^>]*data-multi-add/, '「再加一个货品」必须是表单 submit');
  assert.equal(html.includes('href="?add=1"'), false, '旧链接不再出现');
  // 首件**由服务端**渲进 hidden 字段（形状 = §4.3；`entries` 由路由在提交时合并 ✓）
  const hiddenValue = html.match(new RegExp(`name="${MULTI_ITEM_ORDER.field}" value="([^"]*)"`))[1];
  const baked = JSON.parse(hiddenValue.replace(/&quot;/g, '"'));
  assert.deepEqual(Object.keys(baked[0]).sort(),
    ['color', 'entries', 'item_no', 'number', 'product_record_id', 'supplier_record_id'],
    'hidden 里那件也必须是 §4.3 的六键形状 ✓');
});

test('AC-MIR2 🔴 载荷是合法 JSON 且形状 = 设计 §4.3（改一个键名 ⇒ 红）', () => {
  const json = renderer.multiItemPayloadJson([{
    product_record_id: 'recA', number: 'HL1', item_no: 'A1', color: '黑',
    supplier_record_id: 'recS', entries: [{ size: '41', quantity: 2 }, { size: '42', quantity: 1 }],
  }]);
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed) && parsed.length === 1, '必须是数组（一单 N 个货品）');
  assert.deepEqual(Object.keys(parsed[0]).sort(),
    ['color', 'entries', 'item_no', 'number', 'product_record_id', 'supplier_record_id'],
    '六个键**一个不多一个不少**（形状 = 设计 §4.3）');
  assert.deepEqual(parsed[0].entries, [{ size: '41', quantity: 2 }, { size: '42', quantity: 1 }],
    'entries 形状必须是 [{size, quantity}]，且 quantity 是**数字**（字符串会被下游当非法 ✗）');
  assert.equal(typeof parsed[0].entries[0].quantity, 'number');
  // 空输入不许抛（没加任何货品时也要能提交）
  assert.deepEqual(JSON.parse(renderer.multiItemPayloadJson()), []);
  assert.deepEqual(renderer.MULTI_ITEM_ITEM_KEYS.slice().sort(),
    ['color', 'entries', 'item_no', 'number', 'product_record_id', 'supplier_record_id'],
    '键名清单**只此一份**（服务端纯函数与页面脚本共用 ✓）');
});

// 🔴 2026-11-27：补货扫码页已删除 ⇒ 本判据只剩**退货**那一个表单（判据强度不变 ✓）。
test('AC-MIR3 ⭐ N=1 逐字不变：**没有开关** ⇒ 那一块永远渲染、退货表单其余字节不变', () => {
  // ① ⭐ 2026-10-29 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.match(rendererSrcText, /if \(!MULTI_ITEM_ORDER\.enabled\) return '';/, …)`
  //   改后逐字：**那道门闸必须不在** ✗（她：「不应该有配置按钮」）＋ 配置上也没有 `enabled` 键
  //   依据＝业务负责人 2026-10-29 逐字（同 AC-MI1）；🔴 判据反向钉住（塞回门闸/开关 ⇒ 红 ✓）
  assert.equal(/if \(!MULTI_ITEM_ORDER\.enabled\) return '';/.test(rendererSrcText), false,
    '🔴 渲染层**不许**再有"开关关 ⇒ 空串"那道门（开关已整件退场 ✗）');
  assert.equal('enabled' in MULTI_ITEM_ORDER, false,
    '🔴 配置上不许再有 `enabled`（一单多货永远开 ✓）');
  // ② 退货块旧字段**逐字还在**、顺序不变（多货品块仍**插**在"整单金额行"与提交按钮之间 ✓）
  for (const line of [
    '${hiddenField(fields.action, write.actions.purchaseReturn)}${pageBuildField()}',
    '${hiddenField(fields.submitKey, write.returnKey)}',
    '${rows}',
  ]) {
    assert.ok(rendererSrcText.includes(line), `退货块既有字段必须逐字还在：${line}`);
  }
  // 🔴 2026-11-27：补货扫码页已删除 ⇒ 补货那套字段（actions.replenish / replenishKey）**不许回来**
  for (const gone of [
    '${hiddenField(fields.action, write.actions.replenish)}${pageBuildField()}',
    '${hiddenField(fields.submitKey, write.replenishKey)}',
  ]) {
    assert.equal(rendererSrcText.includes(gone), false, `补货块已删除 ⇒ 这段字段不许回来：${gone}`);
  }
  // ③ 顺序：退货表单里 **rows → 整单金额行 → 多货品块 → 提交按钮**（相对顺序不动 ✓）
  const returnSrc = rendererSrcText.slice(rendererSrcText.indexOf('const returnFormHtml'));
  const atRows = returnSrc.indexOf('${rows}');
  const atAmount = returnSrc.indexOf('${purchaseAmountRowHtml(write)}');
  const atMulti = returnSrc.indexOf("multiItemBlockHtml(write, view, 'return'");
  const atButton = returnSrc.indexOf('<button type="submit"');
  assert.ok(atRows >= 0 && atAmount > atRows && atMulti > atAmount && atButton > atMulti,
    '退货表单的顺序必须仍是 **rows → 整单金额行 → 多货品块 → 提交按钮**（既有顺序不动 ✓）');
  // 🔴 补货那套"按配置的画不画"随页面退场 ⇒ 渲染层不许再有 rp.amountRow
  assert.equal(rendererSrcText.includes('rp.amountRow'), false,
    '补货扫码页已删除 ⇒ 渲染层不许再有那个补货专用的金额行开关（塞回 ⇒ 红 ✓）');
  // ③ ⭐⭐ 2026-10-29 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：子进程 `SCAN_MULTI_ITEM_ENABLED=false` ⇒ `out.html === ''`（开关关 = 空串）
  //   改后逐字：子进程里**没有开关** ⇒ 配置上没有 `enabled` 键、那一块**照常渲染**（非空）
  //   依据＝业务负责人 2026-10-29 逐字：「啥叫默认开启呀？就应该开启呀，就应该支持一单多货呀，
  //     不应该有配置按钮呀！」＋ 2026-10-16「不需要开关」（`docs/no-switch-rule-2026-10-16.md`）
  //   🔴 判据**没消失、也没放宽**：从"关着 ⇒ 空串"翻成"**没有关这个动作** ⇒ 永远渲染"
  //     （把 `enabled` 塞回配置 / 渲染层加回开关 ⇒ 本用例红 ✓）。
  const probe = spawnSync(process.execPath, ['-e', `
    const r = require(${JSON.stringify(rendererPath)});
    const html = r.multiItemBlockHtml({}, { product_record_id: 'recA', number: 'HL1' });
    process.stdout.write(JSON.stringify({ html, hasEnabled: 'enabled' in require(${JSON.stringify(path.join(serverRoot, 'src', 'config', 'multiItemOrder.js'))}).MULTI_ITEM_ORDER }));
  `], {
    cwd: serverRoot,
    env: { ...process.env, SCAN_MULTI_ITEM_ENABLED: 'false' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(probe.status, 0, `子进程应正常退出：${probe.stderr}`);
  const out = JSON.parse(probe.stdout);
  assert.equal(out.hasEnabled, false, '🔴 配置里不许再有 `enabled`（老 env 也已经不读了 ✓）');
  assert.ok(String(out.html || '').length > 0, '🔴 没有开关 ⇒ 那一块**永远渲染**（不再有"空串"那条老路 ✓）');
});
