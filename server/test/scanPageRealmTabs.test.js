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

test('AC-RB1 六 tab 名称与顺序逐字（条上**没有**验收）', () => {
  assert.deepEqual(REALM_TABS.map((realm) => `${realm.id}=${realm.label}`),
    ['sales=销售', 'replenish=补货', 'inventory=库存', 'product=标签', 'new=上新', 'purchase_return=配品']);
  assert.equal(REALM_TABS.length, 6, '条上就六个');
  assert.equal(REALM_TABS.some((realm) => realm.id === 'accept'), false, '验收不上条（有会话才切进来）');
  assert.equal(REALMS.some((realm) => realm.id === 'accept'), true, '但验收必须仍能解析 ✓');
});

test('AC-RB2 ⭐ 一行六格（2026-10-14 她：「没有铺满屏幕的水平方向……最后一格被截」——改成铺满整宽）', () => {
  const bar = barOf(htmlFor('sales'));
  const ids = [...bar.matchAll(/data-realm-id="([^"]+)"/g)].map((match) => match[1]);
  // ⚠️ 2026-10-14 **改写**（她：「没有铺满屏幕的水平方向」✗）——
  //   改前逐字：`assert.deepEqual(ids.slice(0,3), [...'第一行 3 个'])` + `ids.slice(3)` 第二行 +
  //              `assert.match(barRule, /repeat\(3,/, '三列（六个 = 两行）')` + `不许横滑`
  //   改后：**一行六格、等分铺满**（顺序不变 ✓）；窄屏允许横向滚动（不裁切 ✗）
  assert.deepEqual(ids, ['sales', 'replenish', 'inventory', 'product', 'new', 'purchase_return'], '一行六个、顺序逐字 ✓');
  const style = fs.readFileSync(RENDERER_SRC, 'utf8');
  const barRule = style.match(/\.realm-bar \{[^}]*\}/)[0];
  assert.match(barRule, /grid-template-columns:\s*1fr;/, '容器一整列（每行占满整宽 ✓）');
  assert.match(barRule, /width:\s*100%/, '容器整宽 ✓');
  assert.match(barRule, /overflow-x:\s*auto/, '⭐ 窄屏**横向滚动**（不是裁切 ✗）');
  assert.ok(style.includes('repeat(6,minmax(0,1fr))') && style.includes('width:100%'),
    '行 = 六列等分整宽 ✓（一格都不许被挤出容器）');
});

test('AC-RB3 扫码页**不出现**「退货」「货品」显示名（源码 + 渲染双哨兵）', () => {
  // ① 源码哨兵（**去注释**后判：注释里解释历史用词不算 ✗）
  for (const file of [RENDERER_SRC, REALM_SRC]) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const word of ['退货', '货品']) {
      assert.equal(code.includes(word), false, `${path.basename(file)} 的**代码**里不该再出现「${word}」`);
    }
  }
  // ② 渲染哨兵：六个 tab 逐页都不出这两个词
  for (const realm of REALM_TABS.map((item) => item.id)) {
    const bar = barOf(htmlFor(realm));
    assert.equal(bar.includes('退货'), false, `条上不该有「退货」（${realm} 页）`);
    assert.equal(bar.includes('货品'), false, `条上不该有「货品」（${realm} 页）`);
  }
  assert.ok(barOf(htmlFor('sales')).includes('标签'), '「货品」已改名成「标签」✓');
});

test('AC-RB4 其余领域落点与改前逐字相同（`?from=` 值一个没变）', () => {
  const bar = barOf(htmlFor('sales'));
  for (const id of ['sales', 'replenish', 'inventory', 'product', 'purchase_return']) {
    assert.ok(bar.includes(`href="?from=${id}"`), `落点逐字不变：?from=${id}`);
    assert.equal(resolveRealm(id), id, `${id} 仍解析得出来`);
  }
  // 已退役的 `purchase` 仍回落销售（既有口径不回归）
  assert.equal(resolveRealm('purchase'), 'sales');
  // 每个领域都还渲染得出来、且只有自己那一块
  for (const realm of REALMS.map((item) => item.id)) {
    const html = htmlFor(realm);
    assert.ok(html.includes(`realm-block--${realm}"`), `${realm} 那一块还在`);
  }
});

test('AC-RB5 ⭐ 上新外链与工作台**同一份 URL** + 缺 URL 不静默', () => {
  // ① 与工作台那份逐字同源（**只读**那个文件；它在另一位手里 ⇒ 不碰 ✓）
  const workbench = fs.readFileSync(WORKBENCH_LINKS, 'utf8');
  const match = workbench.match(/PRODUCT_NEW_FORM_URL\s*=\s*\n?\s*'([^']+)'/);
  assert.ok(match, '工作台那份要有 PRODUCT_NEW_FORM_URL');
  assert.equal(SCAN_PAGE.realmBar.newFormUrl, match[1], '扫码页与工作台**逐字**同一个 URL');
  // ② 渲染出来的也是它（外链开新窗口）
  const external = barOf(htmlFor('sales')).match(/data-realm-id="new" href="([^"]+)"[^>]*>/);
  assert.ok(external, '条上要有「上新」那一颗');
  assert.equal(external[1], SCAN_PAGE.realmBar.newFormUrl);
  assert.match(external[0], /target="_blank"/);
  // ③ 缺 / 写错 ⇒ **当场报错**（绝不静默渲染一颗点不动的死链 ✗）——**真行为**：清缓存 + 设坏值 + 重新 require
  const CONFIG_PATH = require.resolve('../src/config/scanPage');
  const original = process.env.PRODUCT_NEW_FORM_URL;
  try {
    for (const bad of ['', '   ', 'not-a-url', 'ftp://x/y']) {
      process.env.PRODUCT_NEW_FORM_URL = bad;
      delete require.cache[CONFIG_PATH];
      assert.throws(() => require('../src/config/scanPage'),
        /「上新」外链|PRODUCT_NEW_FORM_URL/, `PRODUCT_NEW_FORM_URL=${JSON.stringify(bad)} 必须当场报错`);
    }
    // 正常值 ⇒ 解析得出来（别把守卫写成"一律报错"）
    process.env.PRODUCT_NEW_FORM_URL = 'https://example.com/form/x';
    delete require.cache[CONFIG_PATH];
    assert.equal(require('../src/config/scanPage').SCAN_PAGE.realmBar.newFormUrl, 'https://example.com/form/x');
  } finally {
    if (original === undefined) delete process.env.PRODUCT_NEW_FORM_URL;
    else process.env.PRODUCT_NEW_FORM_URL = original;
    delete require.cache[CONFIG_PATH];
  }
});

test('AC-RB6 配品页：有配品才出表单；没有配品 ⇒ **人话空态卡**（不留空 div）', () => {
  const empty = htmlFor('purchase_return');
  const emptyBlock = empty.slice(empty.indexOf('realm-block--purchase_return'));
  assert.ok(emptyBlock.includes('<section class="card state-msg">'), '空态是**人话卡**');
  assert.ok(emptyBlock.includes(SCAN_PAGE.texts.realmEmptyPurchaseReturnBody), '空态那句是配品的人话');
  assert.equal(emptyBlock.includes('<form'), false, '空态不留空表单 ✗');

  const withAccessory = htmlFor('purchase_return', {
    enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
    postAction: '/s/XHB8095%7C%E6%A3%95%E8%89%B2%7CA', saleKey: 'k',
    accessories: [{ record_id: 'acc_1', name: '腰带' }],
  });
  const block = withAccessory.slice(withAccessory.indexOf('realm-block--purchase_return'));
  assert.ok(block.includes(`name="${SCAN_WRITE.fields.accessory}"`), '能看到并选配品');
  assert.ok(block.includes(SCAN_WRITE.actions.addAccessory), '有"加进本单"那颗');
  assert.ok(block.includes('腰带'), '配品名逐字出现');
});
