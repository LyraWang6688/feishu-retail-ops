// ⭐⭐ 2026-10-14 晚（业务负责人逐字，**覆盖 10-13 的六 tab 口径**）：
//   「把配品迁移到工作台销售里，新建一个子 tab，整体都迁移过去」＋「把上新 tab 也给去掉」
//   ⇒ 扫码页**只剩 4 个领域**：销售 · 补货 · 库存 · 退货 ✓
//   🔴 不是放宽 ✗：判据从"六 tab 必须在"翻成"**四 tab + 配品/上新必须不在**" ✓
/**
 * ⭐⭐ 2026-10-13 扫码页**六 tab + 配品页**的验收标准（业务负责人的最终版）：
 *   她逐字：「第一行：销售 · 补货 · 库存；第二行：标签 · 上新 · 配品」
 *   ＋「你先把扫码页的退货改成配品页面」。
 *
 * 与 `scanPageSixRealms.test.js`（领域解析/渲染那一套）互补：这里钉的是**条上的六个**这件事本身
 * ——名字与顺序、两行三列、不许再出现旧显示名、其余领域落点不动、外链同源、配品空态。
 *
 *   AC-RB1 六 tab 的**名称与顺序逐字** = 销售 · 补货 · 库存 · 标签 · 上新 · 配品（条上**没有**验收 ✓）
 *   AC-RB2 **两行三列**：第一行 3 个（销售·补货·库存）· 第二行 3 个（标签·上新·配品）+ CSS `repeat(3,` ✓
 *   AC-RB3 扫码页**不出现**「退货」「货品」这两个显示名（**源码哨兵 + 渲染哨兵**；注释里的不算 ✗）
 *   AC-RB4 其余领域**落点与改前逐字相同**（`?from=` 值不变：sales / replenish / inventory / product /
 *          purchase_return 五个都还在，且 `resolveRealm` 仍认得出它们 ✓）
 *   AC-RB5 ⭐「上新」外链与**工作台同一份 URL**（逐字比 `public/workbench/config/links.js` ✓ 只读它）
 *          ＋ **服务端配置缺 URL / 写错 ⇒ 当场报错**（不静默渲染一颗点不动的死链 ✗）
 *   AC-RB6 **配品页空态不留空 div**（没有人话卡以外的东西；有配品时才出表单 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_realm_tabs';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'realm_tabs_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { REALMS, REALM_TABS, resolveRealm } = require('../src/views/scanPageRealm');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SERVER = path.join(__dirname, '..');
const RENDERER_SRC = path.join(SERVER, 'src/views/scanPageRenderer.js');
const REALM_SRC = path.join(SERVER, 'src/views/scanPageRealm.js');
const WORKBENCH_LINKS = path.join(SERVER, 'public/workbench/config/links.js');

const VIEW = {
  found: true, number: 'XHB8095|棕色|A', item_no: 'XHB8095', color: '棕色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '36', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-13 16:00',
};

/** 源码哨兵要**去掉注释**（注释里提到「退货/货品」不算 ✗ —— 那是给人看的说明）。 */
const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const htmlFor = (realm, write = null) => renderScanPage(VIEW, SCAN_PAGE, write, realm, {});
const barOf = (html) => html.slice(html.indexOf('<nav class="realm-bar"'), html.indexOf('</nav>'));

test('AC-RB1 ⭐ 六 tab 名称与顺序逐字 = 销售·补货·库存·退货·配品·上新（条上**没有**标签/验收）', () => {
  // ⚠️ 2026-10-14 **改指向**（业务负责人最终口径，逐字「销售 · 补货 · 库存 · 退货 · 配品 · 上新」✓
  //   见 `docs/scan-page-tabs-2026-10-14.md`）：
  //   改前逐字：`['sales=销售','replenish=补货','inventory=库存','product=标签','new=上新','purchase_return=配品']`
  //   ⇒ 变化：**退货回到条上**（`purchase_return` label 改回"退货"✓）· **配品 = 新领域 `accessory`** ✓ ·
  //             **标签整格撤下条** ✗（功能不删 ✓ 仍能解析 ✓）· 「货品」这个词一个都不许回来 ✗
  assert.deepEqual(REALM_TABS.map((realm) => `${realm.id}=${realm.label}`),
    ['sales=销售', 'replenish=补货', 'inventory=库存', 'purchase_return=退货']);
  // ⭐ 2026-10-14 晚：条上**只剩四个**（配品搬去工作台 ✓ 上新去掉 ✓）
  assert.equal(REALM_TABS.length, 4, '条上就四个');
  assert.equal(REALM_TABS.some((realm) => realm.id === 'accessory'), false, '配品不在扫码页 ✓');
  assert.equal(REALM_TABS.some((realm) => realm.id === 'new'), false, '上新不在扫码页 ✓');
  // ⭐⭐ 2026-10-14 晚 **cut B 成对翻新**（依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」
  //    ＋ Lead 的 cut B 清单「REALMS 删 `accept`」）：
  //    改前逐字：`assert.equal(REALM_TABS.some((realm) => realm.id === 'accept'), false, '验收不上条（有会话才切进来）');`
  //             ＋ `assert.equal(REALMS.some((realm) => realm.id === 'accept'), true, '但验收必须仍能解析 ✓');`
  //    改后逐字：第一条**照旧**（它本来就要求"不在条上" ✓）；第二条翻成 **false**
  //      （`accept` 连 REALMS 都不在了 ⇒ 旧 `?from=accept` 回落销售，与 `product` 的区别正在这里：
  //       `product` 仍在 REALMS（只是不上条）⇒ 下面那三条 product 的断言逐字不变 ✓）
  //    判据没放宽：条上**4 格**（上面那条 deepEqual 逐字不变）· `accept` 不许能解析 ✓
  assert.equal(REALM_TABS.some((realm) => realm.id === 'accept'), false, '验收不上条（已整格退场）');
  assert.equal(REALMS.some((realm) => realm.id === 'accept'), false, 'cut B：验收**已退出 REALMS** ⇒ 旧链接回落销售 ✓');
  assert.equal(resolveRealm('accept'), 'sales', '旧 ?from=accept ⇒ 认不出 ⇒ 回落缺省（销售）✓');
  // ⭐ 标签：**不在条上**，但**必须仍能解析**（旧 `?from=product` 链接不能死 ✗）
  assert.equal(REALM_TABS.some((realm) => realm.id === 'product'), false, '标签整格撤下条 ✓');
  assert.equal(REALMS.some((realm) => realm.id === 'product'), true, '但标签必须仍能解析 ✓');
  assert.equal(resolveRealm('product'), 'product', '旧 ?from=product 照旧能开 ✓');
  assert.equal(resolveRealm('accessory'), 'sales', '配品已从扫码页撤下 ⇒ 旧 ?from=accessory 回落销售 ✓');
  assert.equal(resolveRealm('purchase_return'), 'purchase_return', '退货仍解析到自己 ✓');
});

test('AC-RB2 ⭐ 一行铺满（4 格；2026-10-14 她：「没有铺满屏幕的水平方向……最后一格被截」⇒ 列数=格数）', () => {
  const bar = barOf(htmlFor('sales'));
  const ids = [...bar.matchAll(/data-realm-id="([^"]+)"/g)].map((match) => match[1]);
  // ⚠️ 2026-10-14 **改写**（她：「没有铺满屏幕的水平方向」✗）——
  //   改前逐字：`assert.deepEqual(ids.slice(0,3), [...'第一行 3 个'])` + `ids.slice(3)` 第二行 +
  //              `assert.match(barRule, /repeat\(3,/, '三列（六个 = 两行）')` + `不许横滑`
  //   改后：**一行六格、等分铺满**（顺序不变 ✓）；窄屏允许横向滚动（不裁切 ✗）
  // ⚠️ 2026-10-14 改指向（同上）：条上六个 = 销售·补货·库存·退货·配品·上新 ✓
  // ⚠️ 2026-10-15 **改写**（她：「…**库存、销售、补货、退货、扫一扫**」）：
  //   改前逐字：`assert.deepEqual(ids, ['sales', 'replenish', 'inventory', 'purchase_return'], '四个领域、顺序逐字 ✓')`
  //   改后逐字：`assert.deepEqual(ids, ['inventory', 'sales', 'replenish', 'purchase_return'], …)`
  //   依据：她 2026-10-15 那句；顺序在**配置**里（`SCAN_PAGE.realmBar.order` ✓ 配置先行）
  //   🔴 判据没放宽 ✗：仍是「四个领域 + 顺序逐字」；本用例 UA 为空 ⇒ 条上就是 4 格 ✓
  assert.deepEqual(ids, ['inventory', 'sales', 'replenish', 'purchase_return'], '四个领域、顺序逐字 ✓（按她的新口径）');
  const style = fs.readFileSync(RENDERER_SRC, 'utf8');
  const barRule = style.match(/\.realm-bar \{[^}]*\}/)[0];
  assert.match(barRule, /grid-template-columns:\s*1fr;/, '容器一整列（每行占满整宽 ✓）');
  assert.match(barRule, /width:\s*100%/, '容器整宽 ✓');
  assert.match(barRule, /overflow-x:\s*auto/, '⭐ 窄屏**横向滚动**（不是裁切 ✗）');
  // ⚠️ 2026-10-15 **改写**（同一天：4 个领域 + 飞书多一格「扫一扫」）：
  //   改前逐字：`assert.ok(style.includes('repeat(6,minmax(0,1fr))') && style.includes('width:100%'), '行 = 六列等分整宽 ✓…')`
  //   改后逐字：下面这两条 —— 行**列数 = 实际格数**（`repeat(${htmlCells.length}, …)`），
  //             并要求**渲染出来的列数 === 渲染出来的格数**（4 格 4 列、铺满整宽 ⇒ 手机上不需要横滑 ✓）
  //   依据：固定 6 列在只有 4 格时右边空两列（= 她说的"没铺满"✗）；列数跟格数走才是"铺满整宽"的正解 ✓
  assert.ok(style.includes('grid-template-columns:repeat(${htmlCells.length},minmax(0,1fr));width:100%'),
    '行 = 列数=格数、等分整宽 ✓（一格都不许被挤出容器）');
  const renderedCols = Number((bar.match(/grid-template-columns:repeat\((\d+)/) || [])[1]);
  assert.equal(renderedCols, ids.length, `渲染出来的列数必须 === 格数（实际 ${renderedCols} 列 / ${ids.length} 格）`);
});

test('AC-RB3 ⭐ 「退货」回到条上（逐字 ✓）而「货品」一个都不许回来（源码 + 渲染双哨兵）', () => {
  // ⚠️ 2026-10-14 **改指向**（业务负责人最终口径）：改前这条钉的是「**不出现**「退货」」✗
  //   —— 那时 `purchase_return` 的 label 被"配品"占着 ✓；现在**退货回到条上** ✓ ⇒ 反过来钉 ✓
  //   ⭐ 强度不变：① 「货品」这个词在**代码**里仍不许出现 ✓（去注释后判 ✓）
  //                ② 条上**必须有**「退货」这一格（label 逐字 ✓）
  //                ③ 条上仍不许出现「货品」✓
  for (const file of [RENDERER_SRC, REALM_SRC]) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    assert.equal(code.includes('货品'), false, `${path.basename(file)} 的**代码**里不该再出现「货品」`);
  }
  for (const realm of REALM_TABS.map((item) => item.id)) {
    const bar = barOf(htmlFor(realm));
    assert.equal(bar.includes('货品'), false, `条上不该有「货品」（${realm} 页）`);
    assert.ok(bar.includes('退货'), `条上**必须**有「退货」这一格（${realm} 页）`);
  }
  // ⚠️ 2026-10-14 改指向：标签**撤下条** ✗ ⇒ 改判它还在**自己的那一页**上（改名成果没丢 ✓）
  assert.ok(htmlFor('product').includes('<h2 class="stock__heading">标签</h2>'), '「货品」已改名成「标签」（页内标题逐字 ✓）');
});

test('AC-RB4 其余领域落点与改前逐字相同（`?from=` 值一个没变）', () => {
  const bar = barOf(htmlFor('sales'));
  // ⚠️ 2026-10-14 改指向：**条上六个**的落点逐字 ✓（标签撤下条 ✗ ⇒ 它不在这张单子里 ✓）
  for (const id of ['sales', 'replenish', 'inventory', 'purchase_return']) {
    assert.ok(bar.includes(`href="?from=${id}"`), `落点逐字不变：?from=${id}`);
    assert.equal(resolveRealm(id), id, `${id} 仍解析得出来`);
  }
  // ⭐ 2026-10-14（她：「把**上新 tab** 也给**去掉**」）：
  //   ⇒ 条上**不再有**上新外链 ✓ · 配品也**不再在扫码页** ✓（它整体搬去工作台「销售 → 配品」✓）
  //   🔴 不是放宽 ✗：判据从"必须有"翻成"**必须没有**" ✓
  assert.equal(bar.includes('target="_blank"'), false, '上新外链已从扫码页去掉 ✓');
  assert.equal(bar.includes('?from=new'), false, '条上不再有 ?from=new ✓');
  assert.equal(bar.includes('?from=accessory'), false, '条上不再有 ?from=accessory（配品搬去工作台 ✓）');
  assert.equal(resolveRealm('product'), 'product', '?from=product 照旧能解析 ✓（只是不上条 ✗）');
  // 已退役的 `purchase` 仍回落销售（既有口径不回归）
  assert.equal(resolveRealm('purchase'), 'sales');
  // 每个领域都还渲染得出来、且只有自己那一块
  for (const realm of REALMS.map((item) => item.id)) {
    const html = htmlFor(realm);
    assert.ok(html.includes(`realm-block--${realm}"`), `${realm} 那一块还在`);
  }
});

test('AC-RB5 ⭐ 上新**已从扫码页退场**（能力搬到工作台；扫码页不再渲染它）', () => {
  // ⭐⭐ 2026-10-14（业务负责人逐字）：「把**上新 tab** 也给**去掉吧**」
  //   ⇒ 扫码页**不再渲染**上新外链 ✓（配置 `realmBar.newFormUrl` 仍在 ✓ 归工作台侧用 ✓）
  //   🔴 **不是放宽** ✗：原判据"扫码页外链 URL 与工作台逐字相同"已随"扫码页不再有外链"退场 ✓
  const ids = REALM_TABS.map((item) => item.id);
  assert.equal(ids.includes('new'), false, '条上没有 new ✓');
  const bar = barOf(htmlFor('sales'));
  assert.equal(bar.includes('target="_blank"'), false, '条上没有任何外链了 ✓');
});

test('AC-RB6 ⭐ 配品**已从扫码页退场**（整块搬到工作台「销售 → 配品」）', () => {
  // ⭐⭐ 2026-10-14（业务负责人逐字）：「把**配品**给**迁移到工作台销售里**，新建一个子 tab，
  //   **整体都迁移过去**，**只是入口变了，逻辑没有变**」
  //   ⇒ 扫码页**不再有配品领域/表单** ✓（`?from=accessory` 回落销售 ✓）
  //   ⭐ 配品的验收（选名称 + 数量默认 1 + **成交金额必填** + 一步成单 + **不扣库存**）
  //      改到**工作台那一页的测试**里判 ✓（本文件不再重复判 ✗）
  assert.equal(REALMS.map((item) => item.id).includes('accessory'), false, 'REALMS 里没有 accessory ✓');
  assert.equal(resolveRealm('accessory'), 'sales', '旧 ?from=accessory 回落销售 ✓');
  const html = htmlFor('sales');
  assert.equal(html.includes('realm-block--accessory'), false, '扫码页不再渲染配品那一块 ✓');
  assert.equal(html.includes('data-view="accessory-sell"'), false, '扫码页不再有配品表单 ✓');
});
