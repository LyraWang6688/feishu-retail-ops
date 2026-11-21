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

test('AC-P24 前端补货标签：未到货用现货 / 预订同一套标签渲染', () => {
  const render = read(`${PUBLIC}/features/procurement/render.js`);
  const config = read(`${PUBLIC}/config/procurement.js`);
  assert.match(render, /pr-tag-not/, '未到货标签必须走同一套 saleTagsHtml');
  assert.match(render, /row\.notArrived/, '未到货数量来自后端 row.notArrived');
  assert.match(config, /notArrived: '未到货'/, '标签文案走配置');
});

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
  for (const key of ['endpoints', 'tabs', 'texts', 'stats', 'defaults', 'storage', 'card']) {
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
  assert.match(configSource, /newSubtitleNoSupplier: '\{date\} \{time\} 新增'/);
  assert.match(read(`${PUBLIC}/features/procurement/render.js`), /supplier \? config\.card\.newSubtitle : config\.card\.newSubtitleNoSupplier/);
});

test('AC-P26 供应商筛选：全部 + 唯一供应商；筛选后统计按当前供应商重算', async () => {
  const filter = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/supplierFilter.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;
  const groups = [
    { productRecordId: 'a', supplierRecordId: 's1', supplierName: '供应商A', spotTotal: 2, prepaidTotal: 1, notArrivedTotal: 3 },
    { productRecordId: 'b', supplierRecordId: 's2', supplierName: '供应商B', spotTotal: 5, prepaidTotal: 0, notArrivedTotal: 0 },
    { productRecordId: 'c', supplierRecordId: '', supplierName: '', spotTotal: 1, prepaidTotal: 0, notArrivedTotal: 0 },
  ];
  assert.deepEqual(filter.supplierOptions(groups, config).map((item) => item.label), ['全部', '供应商A', '供应商B', '未标注']);
  assert.deepEqual(filter.filterGroups(groups, 's2').map((item) => item.productRecordId), ['b']);
  assert.deepEqual(filter.filteredStats('replenish', [groups[0]], config),
    { spotSold: 2, prepaidPending: 1, notArrived: 3, productCount: 1 });
});

test('AC-P27 自定义尺码草稿：跨供应商/刷新保留，提交进入现有 items', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/store.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const draftStore = store.createDraftStore({ openId: 'ou_custom', config, storage, now: () => 1761600000000 });
  let draft = draftStore.ensure();
  draft = draftStore.addCustomSize(draft, { productRecordId: 'recA', source: 'replenish' });
  draft = draftStore.renameCustomSize(draft, { productRecordId: 'recA', source: 'replenish' }, '', '45');
  draft = draftStore.setQuantity(draft, { productRecordId: 'recA', source: 'replenish' }, 45, 2);
  assert.deepEqual(draftStore.customSizesOf(draft, 'recA'), ['45']);
  assert.deepEqual(store.buildItems(draft), [{ productRecordId: 'recA', source: 'replenish', entries: [{ size: 45, quantity: 2 }] }]);
  draft = draftStore.removeCustomSize(draft, { productRecordId: 'recA', source: 'replenish' }, '45');
  assert.deepEqual(draftStore.customSizesOf(draft, 'recA'), []);
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
  // 2026-11-17：预订也不再自动填数量（默认 0）⇒ 她手填的行才进草稿
  assert.equal(draftStore.quantityOf(draft, 'recGone', 40), 0, '预订行默认 0');
  draft = draftStore.setQuantity(draft, { productRecordId: 'recKeep', source: 'replenish' }, 39, 1);
  draft = draftStore.setQuantity(draft, { productRecordId: 'recGone', source: 'replenish' }, 40, 2);
  const pruned = draftStore.pruneSource(draft, 'replenish', ['recKeep']);
  assert.equal(draftStore.quantityOf(pruned, 'recKeep', 39), 1, '还在数据里的已选行保留');
  assert.equal(pruned.products.recGone, undefined, '刷新后已消失的货品要从草稿剔除（防提交看不见的行）');
});

test('底部提交条 + 空/错态 + 统计范围都在渲染层（与视觉稿一致）', async () => {
  const render = read(`${PUBLIC}/features/procurement/render.js`);
  for (const marker of ['data-pr-total', 'data-pr-breakdown', 'data-pr-submit', 'data-pr-toast', 'pr-summary-grid', 'pr-group', 'pr-stepper', 'data-pr-retry']) {
    assert.ok(render.includes(marker), `渲染层缺 ${marker}`);
  }
  assert.match(render, /newProductsWindow|newProducts/);
  // 文案跟随 range.days，不写死 7（改配置几天就显示几天）。
  const { rangeText } = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/render.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;
  assert.equal(rangeText('new', { days: 7 }, config), '近 7 天（含今天）');
  assert.equal(rangeText('new', { days: 3 }, config), '近 3 天（含今天）');
});

test('AC-P23 旧版草稿（version 1/2）在默认 0 上线后作废，不把旧自动数量带回来', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/store.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, value),
    removeItem: (key) => memory.delete(key),
  };
  // v1：上新自动 1 那一版；v2：预订仍自动填预订数那一版 —— 两版都要作废。
  for (const version of [1, 2]) {
    memory.clear();
    memory.set(config.storage.prefix + ':ou_old', JSON.stringify({
      version,
      submitKey: 'old-key',
      products: { recOld: { productRecordId: 'recOld', source: 'new', entries: { 36: 1, 37: 1 } } },
    }));
    const draftStore = store.createDraftStore({ openId: 'ou_old', config, storage, now: () => 1761600000000 });
    const draft = draftStore.ensure();
    assert.equal(draft.version, 3);
    assert.deepEqual(draft.products, {}, '旧草稿的产品/数量全部作废');
    assert.notEqual(draft.submitKey, 'old-key');
  }
});

test('AC-P19/P22 草稿纯函数：默认选中 / 合计 / items / submitKey 轮换', async () => {
  const store = await import(pathToFileURL(path.join(ROOT, PUBLIC, 'features/procurement/store.js')).href);
  const config = (await import(pathToFileURL(path.join(ROOT, PUBLIC, 'config/procurement.js')).href)).PROCUREMENT_UI;

  // 上新默认：普通 / 特殊都是 0（需手动选）
  assert.equal(store.defaultNewQuantity('normal', config.defaults), 0);
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

  const replenishGroups = [
    { productRecordId: 'recA', number: '86822', itemNo: '86822', color: '黑色', sizes: [{ size: 39, prepaidSold: 1, spotSold: 5 }] },
  ];
  draft = draftStore.seedDefaults(draft, 'replenish', replenishGroups);
  assert.equal(draftStore.quantityOf(draft, 'recA', 39), 0, '预订也不再自动填数量（默认 0）');
  // 用户手改之后 seed 不许覆盖
  draft = draftStore.setQuantity(draft, { productRecordId: 'recA', source: 'replenish' }, 39, 3);
  draft = draftStore.seedDefaults(draft, 'replenish', replenishGroups);
  assert.equal(draftStore.quantityOf(draft, 'recA', 39), 3, '只补不覆盖');
  // 改成 0 之后再刷新也不会弹回（以前会自动填回预订数）
  draft = draftStore.setQuantity(draft, { productRecordId: 'recA', source: 'replenish' }, 39, 0);
  draft = draftStore.seedDefaults(draft, 'replenish', replenishGroups);
  assert.equal(draftStore.quantityOf(draft, 'recA', 39), 0, '改成 0 后刷新保持 0');
  draft = draftStore.setQuantity(draft, { productRecordId: 'recA', source: 'replenish' }, 39, 3);
  // 同一 product + 尺码只有一行
  assert.deepEqual(store.buildItems(draft), [{ productRecordId: 'recA', source: 'replenish', entries: [{ size: 39, quantity: 3 }] }]);
  assert.deepEqual(store.computeTotals(draft), { total: 3, replenish: 3, newProducts: 0 });

  // 上新普通码 / 特殊码默认都 0，不自动进草稿
  draft = draftStore.seedDefaults(draft, 'new', [{
    productRecordId: 'recB', number: 'LY001', itemNo: 'LY001', color: '米白',
    sizes: { normal: [36, 37], special: [34] },
  }]);
  assert.equal(draftStore.quantityOf(draft, 'recB', 36), 0);
  assert.equal(draftStore.quantityOf(draft, 'recB', 34), 0);
  assert.deepEqual(store.computeTotals(draft), { total: 3, replenish: 3, newProducts: 0 });

  // 提交成功才换 submitKey（这里显式调 rotate；清理 = 新草稿 + 新键）
  draftStore.clear();
  const fresh = draftStore.rotateSubmitKey(draftStore.ensure());
  assert.notEqual(fresh.submitKey, firstKey);
  assert.deepEqual(Object.keys(fresh.products), []);
});
