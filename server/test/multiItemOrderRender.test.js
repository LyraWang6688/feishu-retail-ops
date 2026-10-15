'use strict';

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
 * - **AC-MIR3** ⭐ **N=1 逐字不变**：开关关（`SCAN_MULTI_ITEM_ENABLED=false`）⇒ 那一块**返回空串** ⇒
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
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const renderer = require(rendererPath);
const { MULTI_ITEM_ORDER } = require(path.join(serverRoot, 'src', 'config', 'multiItemOrder.js'));

const VIEW = Object.freeze({
  product_record_id: 'recProductForRenderTest',
  number: 'HL92006',
  item_no: 'HM-1',
  color: '黑',
  supplier_record_id: 'recSupplierForRenderTest',
});

test('AC-MIR1 🔴 补货 / 退货**两块都有**那个入口（去掉任一处 ⇒ 红）', () => {
  const callSites = rendererSource.split('multiItemBlockHtml(write, view)').length - 1;
  assert.equal(callSites, 2,
    `补货/退货**各一处**调用（实得 ${callSites} 处）—— 少一处就是"某一块加不了第二个货品" ✗`);
  // 补货块与退货块各自的函数体里都要有（防止两处都塞在同一块里 ✗）
  const replenish = rendererSource.slice(rendererSource.indexOf('const replenishFormHtml'),
    rendererSource.indexOf('const sizeRowsHtml'));
  const ret = rendererSource.slice(rendererSource.indexOf('const returnFormHtml'));
  assert.ok(replenish.includes('multiItemBlockHtml(write, view)'), '补货块里必须接这个入口');
  assert.ok(ret.includes('multiItemBlockHtml(write, view)'), '退货块里必须接这个入口');

  const html = renderer.multiItemBlockHtml({}, VIEW);
  assert.match(html, /data-multi-add/, '那一块必须有「再加一个货品」的按钮');
  assert.match(html, /data-view="multi-item-list"/, '那一块必须有"已加货品"的列表');
  assert.match(html, new RegExp(`name="${MULTI_ITEM_ORDER.field}"`),
    '必须有那个 hidden 字段（字段名来自配置 ✓）');
  // 🔴 **零 JS**：扫码页有既有哨兵（`AC-W2` / `AC-6R5`）钉着"一行 `<script>` 都不许有" ⇒
  //   这一块**必须是纯 HTML**（入口做成链接，提交时由路由侧去记草稿）✓
  assert.doesNotMatch(html, /<script/i, '这一块里**不许有任何 `<script>`**（扫码页零 JS 是既有判据 ✗ 不放宽）');
  assert.match(html, /data-multi-add[^>]*href="/, '「再加一个货品」必须是一颗**链接**（零 JS 下唯一的"加"法 ✓）');
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

test('AC-MIR3 ⭐ N=1 逐字不变：开关关 ⇒ 那一块**空串**、两个表单一个字节不变', () => {
  // ① 闸门在源码里（关 ⇒ 立刻返回空串，不做任何别的事）
  assert.match(rendererSource, /if \(!MULTI_ITEM_ORDER\.enabled\) return '';/,
    '必须有"开关关 ⇒ 返回空串"的闸门（这是 N=1 逐字不变的物理保证）');
  // ② 旧字段**逐字还在**、顺序不变（新块只**插**在金额行与提交按钮之间 ✓）
  for (const line of [
    '${hiddenField(fields.action, write.actions.replenish)}${pageBuildField()}',
    '${hiddenField(fields.submitKey, write.replenishKey)}',
    '${rows}',
  ]) {
    assert.ok(rendererSource.includes(line), `补货块既有字段必须逐字还在：${line}`);
  }
  assert.ok(rendererSource.includes('${rows}\n${purchaseAmountRowHtml(write)}\n${multiItemBlockHtml(write, view)}\n<button type="submit"'),
    '新块必须**插在**金额行之后、提交按钮之前（既有顺序不动）');
  // ③ **真跑一个子进程**：开关关 ⇒ 那一块空串（不是靠读源码猜 ✓）
  const probe = spawnSync(process.execPath, ['-e', `
    const r = require(${JSON.stringify(rendererPath)});
    const html = r.multiItemBlockHtml({}, { product_record_id: 'recA', number: 'HL1' });
    process.stdout.write(JSON.stringify({ html, enabled: require(${JSON.stringify(path.join(serverRoot, 'src', 'config', 'multiItemOrder.js'))}).MULTI_ITEM_ORDER.enabled }));
  `], {
    cwd: serverRoot,
    env: { ...process.env, SCAN_MULTI_ITEM_ENABLED: 'false' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(probe.status, 0, `子进程应正常退出：${probe.stderr}`);
  const out = JSON.parse(probe.stdout);
  assert.equal(out.enabled, false, '开关必须真的读到了 false（显式布尔 ✓）');
  assert.equal(out.html, '', '🔴 开关关 ⇒ 那一块必须是空串 ⇒ 页面与今天逐字一致 ✓');
});
