/**
 * ⭐⭐【首屏】「先旧后新」—— 验收标准（业务负责人 2026-10-12，**先写后做**）。
 *
 * 她的口径：第一次打开 ⇒ **立刻**显示上次那批（0 秒）+「刷新中」⇒ 后台拉到新的 ⇒ **悄悄替换**、标记消失；
 * 🔴 **写操作（补收款/交付/售后）之后必须立刻拉最新**（绝不能给她看旧的 ✗）；
 * 拉新失败 ⇒ **仍显示旧数据 + 一行提示**（不白屏 ✗）；服务端 `WORKBENCH_ORDERS_CACHE_MS` 一行不动。
 *
 * ⚠️ 结构约束（本项目经验）：`features/orders/index.js` 被 13~15 个 harness「拷到临时目录 + 显式改写 import」
 *   ⇒ **这个文件不许新增同目录相对 import** ⇒ 三个小函数**就放在它自己里面并 export**（本用例从它 import ✓）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把 `features/orders/index.js` 当模块加载（复制成 .mjs，只改它那几个 import 的文件名）。 */
async function loadOrders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-paint-'));
  const copies = {
    'config/orders.js': 'orders-config.mjs',
    'core/formatters.js': 'formatters.mjs',
    'core/api-client.js': 'api-client.mjs',
    'core/ui.js': 'ui.mjs',
  };
  for (const [from, to] of Object.entries(copies)) fs.copyFileSync(path.join(WORKBENCH, from), path.join(dir, to));
  let source = read('features/orders/index.js');
  for (const [needle, replacement] of [
    ["from '../../config/orders.js'", "from './orders-config.mjs'"],
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../core/ui.js'", "from './ui.mjs'"],
  ]) {
    assert.ok(source.includes(needle), `harness 失配（源码里没有 ${needle}）`);
    source = source.split(needle).join(replacement);
  }
  fs.writeFileSync(path.join(dir, 'orders.mjs'), source, 'utf8');
  return import(pathToFileURL(path.join(dir, 'orders.mjs')).href);
}

/** 假的 localStorage：能记 `getItem`/`setItem` 被调几次（用来钉「写操作后不读缓存」）。 */
const fakeStorage = (initial = null) => {
  const box = { value: initial, gets: 0, sets: 0 };
  return {
    box,
    getItem(key) { box.gets += 1; return key === 'workbench.orders.last' ? box.value : null; },
    setItem(key, value) { box.sets += 1; if (key === 'workbench.orders.last') box.value = value; },
  };
};
const cachedPayload = (orders) => JSON.stringify({ at: Date.now() - 60_000, orders });

test('AC1 命中旧缓存 ⇒ **立刻**渲染（拉新之前就有数据）+ 标记「刷新中」', async () => {
  const orders = await loadOrders();
  assert.equal(orders.ORDERS_CACHE_KEY, 'workbench.orders.last', '缓存键要稳定');
  const storage = fakeStorage(cachedPayload([{ record_id: 'old-1' }]));
  let resolveLoad;
  const loader = orders.createFirstPaintLoader({ storage, load: () => new Promise((r) => { resolveLoad = r; }) });
  const events = [];
  const running = loader.firstPaint({
    onCached: (rows) => events.push(['cached', rows.length]),
    onFresh: (rows) => events.push(['fresh', rows.length]),
  });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, [['cached', 1]], '拉到新数据**之前**就要先用旧数据画出来（0 秒可看）');
  resolveLoad([{ record_id: 'new-1' }, { record_id: 'new-2' }]);
  await running;
  assert.deepEqual(events, [['cached', 1], ['fresh', 2]], '然后才悄悄替换');
});

test('AC2 后台拉新成功 ⇒ 替换 + 写回缓存（下次首屏更快）', async () => {
  const orders = await loadOrders();
  const storage = fakeStorage(cachedPayload([{ record_id: 'old-1' }]));
  const loader = orders.createFirstPaintLoader({ storage, load: async () => [{ record_id: 'new-1' }] });
  const fresh = [];
  await loader.firstPaint({ onCached: () => {}, onFresh: (rows) => fresh.push(rows) });
  assert.deepEqual(fresh, [[{ record_id: 'new-1' }]]);
  assert.equal(storage.box.sets, 1, '新数据要写回缓存');
  assert.deepEqual(orders.readCachedOrders(storage).orders, [{ record_id: 'new-1' }]);
});

test('AC3 ⭐ 写操作后**不走旧缓存**：`forceReload` 一次都不读 storage', async () => {
  const orders = await loadOrders();
  const storage = fakeStorage(cachedPayload([{ record_id: 'old-1' }]));
  let loads = 0;
  const loader = orders.createFirstPaintLoader({
    storage, load: async () => { loads += 1; return [{ record_id: `fresh-${loads}` }]; },
  });
  const rows = await loader.forceReload();
  assert.deepEqual(rows, [{ record_id: 'fresh-1' }], '写操作后拿到的是**真·最新**');
  assert.equal(storage.box.gets, 0, '⭐ forceReload 不许读缓存（读了就可能把旧数据给她看）');
  assert.equal(loads, 1, '必须真的发一次请求');
});

test('AC4 拉新失败 ⇒ 旧数据**不撤**（不白屏）+ 一行提示', async () => {
  const orders = await loadOrders();
  const storage = fakeStorage(cachedPayload([{ record_id: 'old-1' }]));
  const loader = orders.createFirstPaintLoader({ storage, load: async () => { throw new Error('网络断了'); } });
  const events = [];
  const rows = await loader.firstPaint({
    onCached: () => events.push('cached'),
    onFresh: () => events.push('fresh'),
    onError: (error, meta) => events.push(['error', error.message, meta.hadCache]),
  });
  assert.deepEqual(events, ['cached', ['error', '网络断了', true]]);
  assert.deepEqual(rows, [{ record_id: 'old-1' }], '返回旧数据 ⇒ 页面继续显示它（不白屏）');
  assert.equal(storage.box.sets, 0, '失败不许把缓存写坏');
});

test('AC4b 没有缓存 + 拉新失败 ⇒ 如实报错（不假装有数据）', async () => {
  const orders = await loadOrders();
  const loader = orders.createFirstPaintLoader({ storage: fakeStorage(null), load: async () => { throw new Error('500'); } });
  const events = [];
  const rows = await loader.firstPaint({ onError: (error, meta) => events.push([error.message, meta.hadCache]) });
  assert.deepEqual(events, [['500', false]]);
  assert.equal(rows, null, '没有旧数据就是没有（页面自己顶报错，不许编）');
});

test('AC5 缓存坏了 / 写不进 / storage 都没有 ⇒ 不崩，退化成"没有缓存"', async () => {
  const orders = await loadOrders();
  assert.equal(orders.readCachedOrders(fakeStorage('{ not json')), null, '坏 JSON ⇒ 当没有');
  assert.equal(orders.readCachedOrders(fakeStorage(JSON.stringify({ orders: 'nope' }))), null, '结构不对 ⇒ 当没有');
  assert.equal(orders.readCachedOrders(undefined), null, 'storage 都没有 ⇒ 当没有');
  const throwing = { getItem() { throw new Error('隐私模式'); }, setItem() { throw new Error('配额满'); } };
  assert.equal(orders.readCachedOrders(throwing), null, '读抛错 ⇒ 不崩');
  assert.doesNotThrow(() => orders.writeCachedOrders(throwing, [{ record_id: 'x' }]), '写抛错 ⇒ 静默');
  const loader = orders.createFirstPaintLoader({ storage: throwing, load: async () => [{ record_id: 'x' }] });
  assert.deepEqual(await loader.firstPaint({}), [{ record_id: 'x' }], '缓存坏了照样能拿到新数据');
});

test('AC6 接线：首屏用它 · 写操作走 freshOnly（不读缓存）· 「刷新中」固定高度不抖布局', () => {
  const source = read('features/orders/index.js');
  assert.ok(source.includes('createFirstPaintLoader'), '要 export/使用它');
  assert.ok(source.includes('forceReload'), '拉新走 forceReload（只拉新、不读缓存）');
  assert.match(source, /刷新中/, '要有一行「刷新中」文案');
  assert.match(source, /freshOnly/, '写操作后要能声明"只拉新"');
  const css = read('features/orders/orders.css');
  const rule = /\.orders-refreshing\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '「刷新中」那一行要有样式');
  assert.match(rule[1], /min-height/, '固定高度 ⇒ 出现/消失不顶动列表（不抖布局）');
});

test('AC7 服务端缓存口径一行不动（本切片只改前端展示层）', () => {
  const config = fs.readFileSync(path.join(__dirname, '../src/config/workbenchOrders.js'), 'utf8');
  assert.match(config, /WORKBENCH_ORDERS_CACHE_MS/, '服务端那个开关还在（没被本切片碰）');
  assert.equal(/WORKBENCH_ORDERS_CACHE_MS/.test(read('features/orders/index.js')), false, '前端不许改服务端缓存口径');
});
