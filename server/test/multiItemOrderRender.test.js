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
  // ⭐⭐ 2026-10-16 **成对迁移**（依据：业务负责人真机截图 + 逐字「把最下面的蓝色按钮改为「退货」」
  //   ＋ 弹窗选择「说明 + 整块都删」）：
  //   改前逐字：
  //     `const callSites = rendererSource.split('multiItemBlockHtml(write, view)').length - 1;`
  //   改后逐字：下面这一行（**改指向、不放宽** ✓）——
  //     ⚠️ 退货那一处现在多传一个 `'return'`（**退货 tab 专用**的精简那一版），
  //       所以字面量 `multiItemBlockHtml(write, view)` **只剩补货那一处**；
  //       旧写法把"退货那一处"也数进去 ⇒ 现在会数成 1 ⇒ **假红** ✗。
  //   ⚠️ 这条的原意一个字没改：**"两块各接一次、少一处就是某一块加不了第二个货品"** ✓
  //     ⇒ 用**带参数的正则**把两种形状都数上（`[^)]*` 只含 `view` / `, 'return'`，不会跨到别的调用 ✗）。
  const callSites = (rendererSource.match(/multiItemBlockHtml\(write, view[^)]*\)/g) || []).length;
  assert.equal(callSites, 2,
    `补货/退货**各一处**调用（实得 ${callSites} 处）—— 少一处就是"某一块加不了第二个货品" ✗`);
  // 补货块与退货块各自的函数体里都要有（防止两处都塞在同一块里 ✗）
  const replenish = rendererSource.slice(rendererSource.indexOf('const replenishFormHtml'),
    rendererSource.indexOf('const sizeRowsHtml'));
  const ret = rendererSource.slice(rendererSource.indexOf('const returnFormHtml'));
  assert.ok(/multiItemBlockHtml\(write, view[^)]*\)/.test(replenish), '补货块里必须接这个入口');
  assert.ok(/multiItemBlockHtml\(write, view[^)]*\)/.test(ret), '退货块里必须接这个入口');
  // 🔴 补货那一处**只许传它自己那一档**（`'replenish'`）——
  //   ⭐⭐ 2026-10-16 **成对迁移**（依据 = 业务负责人真机截图 · 补货 tab · 货品 832-500 ＋ 逐字：
  //     「这个是报货的页面，还是需要填写金额啊，以及**不需要的文字说明给删除**，
  //       **生成报货订单按钮文字改为补货**」）：
  //   改前逐字：
  //     `assert.ok(replenish.includes('multiItemBlockHtml(write, view)'),
  //        '补货那一处**不传 mode** ⇒ 走缺省 = 逐字不变 ✓（传上 \\'return\\' ⇒ 红）');`
  //     （那时缺省档 = 把说明 / 标题 / 空态**照旧画出来** ⇒ 补货那边要的正是"不传" ✗）
  //   改后逐字：下面这一行 —— 补货那一处**显式传 `'replenish'`**（= 走**补货自己的**精简档 ✓
  //     她这一次点的就是补货那三处 ✓）。⚠️ **不是放宽**：原来禁的是"传成 `'return'`"，
  //     现在钉的是"**必须恰好传 `'replenish'`**"（传空 / 传 `'return'` / 乱传 ⇒ 都红 ✓ 更严 ✓）。
  //     ⚠️ `mode` 的**缺省档 `''` 本身一个字没动**（仍是老形状 ⇒ AC-RT7 / 本文件 AC-MIR3 的
  //       子进程探针照旧靠它 ✓）。
  assert.ok(replenish.includes("multiItemBlockHtml(write, view, 'replenish')"),
    '补货那一处**显式传自己那一档** `\'replenish\'` ⇒ 走补货的精简版 ✓（传空 / 传 `\'return\'` ⇒ 红 ✓）');
  assert.equal(replenish.includes("multiItemBlockHtml(write, view, 'return')"), false,
    '🔴 补货那一处**绝不许**传 `\'return\'`（那是退货 tab 的档 ⇒ 传错就是"顺手把补货按退货办" ✗）');

  const html = renderer.multiItemBlockHtml({}, VIEW);
  assert.match(html, /data-multi-add/, '那一块必须有「再加一个货品」的按钮');
  assert.match(html, /data-view="multi-item-list"/, '那一块必须有"已加货品"的列表');
  assert.match(html, new RegExp(`name="${MULTI_ITEM_ORDER.field}"`),
    '必须有那个 hidden 字段（字段名来自配置 ✓）');
  // 🔴 **零 JS**：扫码页有既有哨兵（`AC-W2` / `AC-6R5`）钉着"一行 `<script>` 都不许有" ⇒
  //   这一块**必须是纯 HTML**（**一颗原生 `submit` 按钮**就够：加货由服务端记草稿、再 303 回本页 ✓）
  assert.doesNotMatch(html, /<script/i, '这一块里**不许有任何 `<script>`**（扫码页零 JS 是既有判据 ✗ 不放宽）');
  // ⭐⭐ 2026-10-16 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.match(html, /data-multi-add[^>]*href="/, '「再加一个货品」必须是一颗**链接**（零 JS 下唯一的"加"法 ✓）');`
  //   改后逐字：下面这一行（**改指向、不放宽** ✓ —— 入口本身照旧必须存在 ✓ 只是形态从链接变成 submit）
  //   依据 = 业务负责人 **2026-10-16 本 bug**（她真机：填了尺码/数量，点那颗链接 ⇒
  //     **值丢了 / 点了没反应**）+ 她 **2026-10-12 逐字**「我可没有说过，**我们是能够进行动态交互的**」：
  //     🔴 链接是 **GET** ⇒ **天生带不走她刚填的表单字段** ✗ ⇒ 只有 **POST** 能把她填的一起发出去 ✓；
  //       所以那颗入口改成**同一张表单里的第二颗 `submit`**（字段名是配置里的**新名字**，
  //       **不许叫 `action`** —— 表单里已经有 hidden `action=replenish`，`extended:true` 下会变成数组 ✗）。
  //   ⚠️ 零 JS 这条哨兵**一个字没动**（本刀**仍然一行 JS 都不加** ✓）。
  assert.match(html, new RegExp(`data-multi-add[^>]*name="${MULTI_ITEM_ORDER.addField}"`),
    '「＋ 再加一个货品」必须是**同一张表单里的第二颗 `submit`**（带配置里的新字段名 ✓ 零 JS ✓）');
  assert.equal(/data-multi-add[^>]*href=/.test(html), false,
    '🔴 旧的 `href="…?add=1"` 链接形态**去掉**（两种入口并存 ⇒ 判据混乱 ✗）');
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
  // ② 旧字段**逐字还在**、顺序不变（多货品块仍**插**在"金额行那一格"与提交按钮之间 ✓
  //    ⚠️ 那一格现在**按配置**渲染 —— 缺省 false ⇒ 页面上看不到金额行，但**位置留着** ✓
  //      ⇒ 她哪天打开那个开关，金额行仍回到原位（见下面那两条逐字断言 ✓））
  for (const line of [
    '${hiddenField(fields.action, write.actions.replenish)}${pageBuildField()}',
    '${hiddenField(fields.submitKey, write.replenishKey)}',
    '${rows}',
  ]) {
    assert.ok(rendererSource.includes(line), `补货块既有字段必须逐字还在：${line}`);
  }
  // ⭐⭐ 2026-10-16 **成对迁移**（同一句依据：她真机截图 + 逐字「还是需要填写金额啊」✗
  //   ＋「不需要的文字说明给删除」）：
  //   改前逐字（那一行**同时**钉住了"金额行在"＋"入口紧跟在它后面"）：
  //     `assert.ok(rendererSource.includes('${rows}\n${purchaseAmountRowHtml(write)}\n${multiItemBlockHtml(write, view)}\n<button type="submit"'),
  //        '新块必须**插在**金额行之后、提交按钮之前（既有顺序不动）');`
  //   改后逐字：下面两行 —— 把"顺序"与"金额行"**拆开**钉（**更严** ✓）：
  //     ① 补货表单里 **`rows` → 那个多货品块 → 提交按钮** 的**相对顺序**逐字不动 ✓
  //        （只是中间那一格从"金额行"换成"**按配置的金额行插槽**"—— 缺省 `false` ⇒ 渲染出来是空 ✗
  //          但**源码里那一格还在**：她哪天把 `SCAN_PAGE_REPLENISH_AMOUNT_ROW_ENABLED` 打开，
  //          金额行仍然**回到原位**（在 `rows` 之后、多货品块之前）✓ —— 这就是"顺序不动"的真意 ✓）；
  //     ② 补货块的**金额行插槽确实按配置**（不是被删掉了 ✗）。
  //   ⚠️ 依据里的"既有顺序不动"**一个字没放宽**：上面①把三件的相对顺序逐字钉住了 ✓。
  assert.ok(rendererSource.includes('${rows}\n${rp.amountRow ? purchaseAmountRowHtml(write) : \'\'}\n${multiItemBlockHtml(write, view, \'replenish\')}\n<button type="submit"'),
    '补货表单的顺序必须仍是 **`rows` → 金额行那一格 → 多货品块 → 提交按钮**（既有顺序不动 ✓）');
  assert.ok(rendererSource.includes("${rp.amountRow ? purchaseAmountRowHtml(write) : ''}"),
    '⭐ 中间那一格必须**按配置**决定画不画（缺省 false ⇒ 她截图上那个框不再出现 ✓）');
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
