/**
 * 采购页前端判据（AC-P17 / P18 / P19 / P21 / P22 的静态部分）：
 *   · 薄壳 + 模块化 + 文件行数；文案/端点全在 config；不往旧演示页补逻辑；
 *   · 颜色只用 tokens（不写 hex/rgb、不写内联 style）；
 *   · 扫一扫本轮**只占位/禁用**（不 import 扫码模块、不发请求）；
 *   · 草稿纯函数（默认数量 / 合计 / items / submitKey 轮换）口径正确。
 *
 * ⚠️ 交互行为（切 tab / 刷新 / 提交次数）在 Playwright：`test/e2e/procurement.spec.js`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const lines = (relative) => read(relative).split('\n').length;
const PUBLIC = 'public/workbench';
const FEATURE_FILES = fs.readdirSync(path.join(ROOT, PUBLIC, 'features/procurement'))
  .filter((name) => name.endsWith('.js'))
  .map((name) => `${PUBLIC}/features/procurement/${name}`);
const PAGE_FILES = [
  `${PUBLIC}/procurement.html`,
  `${PUBLIC}/procurement.css`,
  `${PUBLIC}/config/procurement.js`,
  ...FEATURE_FILES,
];

test('AC-P17 薄壳 + 模块化：procurement.html 只做壳，业务在 features/procurement/**', () => {
  const html = read(`${PUBLIC}/procurement.html`);
  assert.ok(lines(`${PUBLIC}/procurement.html`) <= 40, 'procurement.html 必须是薄壳（旧 398 行演示页整体替换）');
  assert.match(html, /features\/procurement\/index\.js/, '薄壳只引入口模块');
  assert.match(html, /procurement\.css/);
  // 旧演示页的内联色值 / 内联业务逻辑 / 假数据必须已删净
  assert.equal(/#[0-9a-fA-F]{6}/.test(html), false, 'HTML 不许有内联色值');
  assert.equal(/<style/i.test(html), false, 'HTML 不许有内联样式块');
  assert.equal(/<script>[\s\S]*querySelectorAll\('\.size-row'/.test(html), false, 'HTML 不许有内联业务逻辑');
  assert.equal(html.includes('92608'), false, '旧演示数据必须删净');
  assert.equal(html.includes('fake-toast'), false, '旧演示 toast 必须删净');
  assert.ok(FEATURE_FILES.length >= 6, '按职责拆模块（index / render / store / api / replenish / newProducts / submit）');
  for (const file of FEATURE_FILES) assert.ok(lines(file) <= 200, `${file} 超过 200 行`);
  assert.ok(lines(`${PUBLIC}/config/procurement.js`) <= 200, '前端 config 超过 200 行');
  assert.ok(lines(`${PUBLIC}/procurement.css`) <= 200, 'CSS 超过 200 行');
});

test('AC-P18 颜色只用 tokens：页面/CSS/模块里不写 hex/rgb、不写内联 style', () => {
  for (const file of PAGE_FILES) {
    const source = read(file);
    assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(source), false, `${file} 写了 hex 色值（只许用 tokens）`);
    assert.equal(/rgba?\(/.test(source), false, `${file} 写了 rgb/rgba 色值（只许用 tokens）`);
    assert.equal(/style="/.test(source), false, `${file} 写了内联 style`);
  }
  assert.match(read(`${PUBLIC}/procurement.css`), /var\(--primary\)/, 'CSS 必须引用 tokens 变量');
});

test('AC-P17 配置先行：端点 / 文案 / 默认值 / 尺码规则都在 config/procurement.js', () => {
  const config = read(`${PUBLIC}/config/procurement.js`);
  for (const endpoint of ['/api/workbench/procurement/replenish', '/api/workbench/procurement/new-products', '/api/workbench/procurement/submit']) {
    assert.ok(config.includes(endpoint), `config 缺端点 ${endpoint}`);
  }
  for (const key of ['endpoints', 'tabs', 'texts', 'stats', 'defaults', 'storage', 'card', 'legends']) {
    assert.ok(config.includes(key), `config 缺 ${key}`);
  }
  // 渲染层不写死中文文案（抽查几条：只允许出现在 config）
  const render = read(`${PUBLIC}/features/procurement/render.js`);
  for (const text of ['已提交成功', '统计范围', '涉及货品', '缺类别', '暂未开放']) {
    assert.equal(render.includes(text), false, `render.js 不许写死中文文案「${text}」（放 config）`);
  }
});

test('AC-P9/P21 扫一扫本轮占位：tab 视觉保留但禁用；页面不 import 扫码模块', () => {
  const render = read(`${PUBLIC}/features/procurement/render.js`);
  assert.match(render, /data-pr-scan-disabled/, '扫一扫 tab 必须渲染成禁用/占位');
  assert.match(render, /disabled/, '扫一扫 tab 必须用原生 disabled');
  assert.match(render, /data-tap-target="\$\{escapeHtml\(tab\.tapTarget\)\}"/, 'tab 保留既有 scan:replenish 埋点属性');
  assert.equal(/scanCodeRaw|createScanCardsModule|features\/scan\/launch/.test(read(`${PUBLIC}/features/procurement/index.js`)), false,
    '本轮不接扫码模块');
  const html = read(`${PUBLIC}/procurement.html`);
  assert.equal(/scanCodeRaw|createScanCardsModule/.test(html), false);
  // 服务端 ui-tap 仍允许这个 action（下一轮做扫一扫时不用再改服务端）
  assert.match(read('src/utils/uiTapReport.js'), /procurement_scan_returned/);
});

test('AC-P18f 上新副标题：供应商为空时不出现孤立的「·」', () => {
  const configSource = read(`${PUBLIC}/config/procurement.js`);
  assert.match(configSource, /newSubtitleNoSupplier: '今日 \{time\} 新增'/);
  assert.match(read(`${PUBLIC}/features/procurement/render.js`), /supplier \? config\.card\.newSubtitle : config\.card\.newSubtitleNoSupplier/);
});

test('AC-P19b 实时刷新：刷新按钮 + 自动刷新配置 + 刷新后裁掉已消失的已选行', async () => {
  const configSource = read(`${PUBLIC}/config/procurement.js`);
  assert.match(configSource, /replenish: '\{from\} 00:00 – 现在'/);
  assert.match(configSource, /autoMs: 0/, '默认不自动刷新（业务负责人：打开时更新一次就够）');
  assert.match(configSource, /visibilityRefreshMs: 0/);
  const refresh = read(`${PUBLIC}/features/procurement/refresh.js`);
  assert.match(refresh, /data-pr-refresh/);
  assert.match(refresh, /pruneSource/);
  assert.match(refresh, /visibilitychange/);
  assert.ok(lines(`${PUBLIC}/features/procurement/refresh.js`) <= 200);
  assert.match(read(`${PUBLIC}/features/procurement/render.js`), /data-pr-refresh/);

  const store = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/store.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const draftStore = store.createDraftStore({ openId: 'ou_refresh', config, storage, now: () => 1761600000000 });
  let draft = draftStore.ensure();
  draft = draftStore.seedDefaults(draft, 'replenish', [
    { productRecordId: 'recKeep', itemNo: 'A1', color: '黑', sizes: [{ size: 39, prepaidSold: 1, spotSold: 0 }] },
    { productRecordId: 'recGone', itemNo: 'A2', color: '黑', sizes: [{ size: 40, prepaidSold: 2, spotSold: 0 }] },
  ]);
  assert.equal(draftStore.quantityOf(draft, 'recGone', 40), 2);
  const pruned = draftStore.pruneSource(draft, 'replenish', ['recKeep']);
  assert.equal(draftStore.quantityOf(pruned, 'recKeep', 39), 1, '还在数据里的已选行保留');
  assert.equal(pruned.products.recGone, undefined, '刷新后已消失的货品要从草稿剔除（防提交看不见的行）');
});

test('底部提交条 + 空/错态 + 统计范围都在渲染层（与视觉稿一致）', () => {
  const render = read(`${PUBLIC}/features/procurement/render.js`);
  for (const marker of ['data-pr-total', 'data-pr-breakdown', 'data-pr-submit', 'data-pr-toast', 'pr-summary-grid', 'pr-group', 'pr-stepper', 'data-pr-retry']) {
    assert.ok(render.includes(marker), `渲染层缺 ${marker}`);
  }
  assert.match(render, /todayWindow|newProducts/);
});

test('AC-P19/P22 草稿纯函数：默认选中 / 合计 / items / submitKey 轮换', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/store.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;

  // 补货默认选中：预订必补 = 预订数；只有现货 ⇒ 0（默认不选）
  assert.equal(store.defaultReplenishQuantity({ prepaidSold: 2, spotSold: 5 }), 2);
  assert.equal(store.defaultReplenishQuantity({ prepaidSold: 0, spotSold: 5 }), 0);
  // 上新默认：普通 1 / 特殊 0
  assert.equal(store.defaultNewQuantity('normal', config.defaults), 1);
  assert.equal(store.defaultNewQuantity('special', config.defaults), 0);

  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  const draftStore = store.createDraftStore({ openId: 'ou_front_1', config, storage, now: () => 1761600000000 });
  let draft = draftStore.ensure();
  assert.equal(draftStore.storageKey, `${config.storage.prefix}:ou_front_1`, 'localStorage key 必须带 open_id');
  const firstKey = draft.submitKey;
  assert.match(firstKey, /^procurement_/);

  draft = draftStore.seedDefaults(draft, 'replenish', [
    { productRecordId: 'recA', number: '86822', itemNo: '86822', color: '黑色', sizes: [{ size: 39, prepaidSold: 1, spotSold: 0 }] },
  ]);
  assert.equal(draftStore.quantityOf(draft, 'recA', 39), 1, '预订默认选中且数量 = 预订数');
  // 用户手改之后 seed 不许覆盖
  draft = draftStore.setQuantity(draft, { productRecordId: 'recA', source: 'replenish' }, 39, 3);
  draft = draftStore.seedDefaults(draft, 'replenish', [
    { productRecordId: 'recA', number: '86822', itemNo: '86822', color: '黑色', sizes: [{ size: 39, prepaidSold: 1, spotSold: 0 }] },
  ]);
  assert.equal(draftStore.quantityOf(draft, 'recA', 39), 3, '只补不覆盖');
  // 同一 product + 尺码只有一行
  assert.deepEqual(store.buildItems(draft), [{ productRecordId: 'recA', entries: [{ size: 39, quantity: 3 }] }]);
  assert.deepEqual(store.computeTotals(draft), { total: 3, replenish: 3, newProducts: 0 });

  // 上新普通码默认 1 / 特殊码默认 0
  draft = draftStore.seedDefaults(draft, 'new', [{
    productRecordId: 'recB', number: 'LY001', itemNo: 'LY001', color: '米白',
    sizes: { normal: [36, 37], special: [34] },
  }]);
  assert.equal(draftStore.quantityOf(draft, 'recB', 36), 1);
  assert.equal(draftStore.quantityOf(draft, 'recB', 34), 0);
  assert.deepEqual(store.computeTotals(draft), { total: 5, replenish: 3, newProducts: 2 });

  // 提交成功才换 submitKey（这里显式调 rotate；清理 = 新草稿 + 新键）
  draftStore.clear();
  const fresh = draftStore.rotateSubmitKey(draftStore.ensure());
  assert.notEqual(fresh.submitKey, firstKey);
  assert.deepEqual(Object.keys(fresh.products), []);
});
