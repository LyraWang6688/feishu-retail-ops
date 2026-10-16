'use strict';

/**
 * ⭐⭐ 2026-10-16 21:2x「**扫一扫五处**」的验收用例（业务负责人逐字：
 *   「一共 5 处扫一扫……**本质是一件事**：点按钮 ⇒ 弹二维码框；**差别只有两处**：
 *   ① 扫完回到哪 ② 带不带之前的数据」⇒ 口径落档 `docs/scan-five-places-2026-10-16.md`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *  AC-5S1 ⭐ **A/C 两套实现各只有一处**（谁再手写一套扫码头 ⇒ 红 ✓）
 *  AC-5S2 ⭐ **三处「再加一单」都声明"回当前领域 + 带草稿"**，且回跳触发参数**走配置**
 *  AC-5S3 ⭐ **C 套（标签打印）的行为参数与文案都从登记表取**（改配置即改页面 ⇒ 能真红）
 *  AC-5S4 ⭐ **B 套（领域条那颗）与今天逐字一致**（AppLink / 不带数据）
 *  AC-5S5 ⭐ **零回归**：C 套对外的文案 / HTML / 端点常量与今天**逐字节一致**
 *  AC-5S6 ⭐ **配置先行 + 显式布尔**（不设 ⇒ 默认；显式 false ⇒ 关得掉；非法值 ⇒ 当场抛；禁 `||` 兜底）
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件**只读**别人的文件（`views/scanPage/**` 正被另一个 teammate 改 ✗ 一个字没碰）；
 *   A 套那三处"接线到本登记表"**因避让未做**（如实写在 `docs/scan-five-places-2026-10-16.md`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.join(__dirname, '..', 'src');
const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const readWorkbench = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

const {
  SCAN_ENTRIES, SCAN_PLACES, placeById, resolveScanEntriesConfig,
} = require('../src/config/scanEntries');

/** 把前端两个模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）——本仓既有做法 ✓。 */
const loadScanPrintModule = (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'five-scans-ui-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/ui.js'), path.join(dir, 'ui.mjs'));
  let entries = readWorkbench('config/scanEntries.js');
  // 用例可以**只改副本**里的一句文案 ⇒ 用来证明"页面是**从配置**取的，不是写死的" ✓（能真红）。
  // ⚠️ 用 `split/join` 换**全部**出现（`labelPrintButton` 与 `labelPrintTitle` 今天同值）——
  //    只换第一处会让"另一处没跟着变"看起来像红，那是**用例写错**，不是代码错 ✗。
  if (options.configText) {
    entries = entries.split(`'${options.originalText}'`).join(`'${options.configText}'`);
  }
  fs.writeFileSync(path.join(dir, 'scanEntries.mjs'), entries, 'utf8');
  fs.writeFileSync(path.join(dir, 'scan-print.mjs'),
    readWorkbench('features/labels/scan-print.js')
      .split("from '../../core/ui.js'").join("from './ui.mjs'")
      .split("from '../../config/scanEntries.js'").join("from './scanEntries.mjs'"),
    'utf8');
  return import(pathToFileURL(path.join(dir, 'scan-print.mjs')).href);
};

// ── AC-5S1：A / C 两套实现各只有一处（新写一套 ⇒ 红）────────────────────────

test('AC-5S1 ⭐ 直接调 `tt.scanCode` 的**只有 A / C 两处**（谁再手写一套 ⇒ 红）', () => {
  const roots = [SRC, WORKBENCH];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      if (/\.scanCode\s*\(/.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(path.join(__dirname, '..'), full));
      }
    }
  };
  roots.forEach(walk);
  // ⭐ **闭集**：A 套（领域内扫一扫，服务端内联脚本）+ C 套（工作台标签打印）。
  assert.deepEqual(hits.sort(), [
    'public/workbench/features/labels/scan-print.js',
    'src/views/scanRealmScan.js',
  ], `"点按钮⇒弹二维码"只许有这两处实现，实际：\n${hits.join('\n')}`);
});

test('AC-5S1b ⭐ 登记表把五处都登记齐了（新入口忘了登记参数 ⇒ 红）', () => {
  assert.equal(SCAN_PLACES.length, 5, '她数的是五处（①标签打印 ②领域条 ③销售 ④补货 ⑤退货）');
  assert.deepEqual(SCAN_PLACES.map((place) => place.id), [
    'label-print', 'realm-bar', 'sales-add', 'replenish-add', 'purchase-return-add',
  ], '顺序 = 她数的顺序 ①②③④⑤');
  for (const place of SCAN_PLACES) {
    for (const key of ['mechanism', 'mode', 'returnsToRealm', 'keepDraft']) {
      assert.ok(Object.prototype.hasOwnProperty.call(place, key), `${place.id} 少登记了 ${key} ✗`);
    }
    assert.equal(typeof place.keepDraft, 'boolean', `${place.id}.keepDraft 必须是显式布尔`);
    assert.equal(typeof place.returnsToRealm, 'boolean', `${place.id}.returnsToRealm 必须是显式布尔`);
  }
});

// ── AC-5S2：三处「再加一单」都回当前领域 + 带草稿 ──────────────────────────

test('AC-5S2 ⭐ 三处「再加一单」= 回当前领域 + 带草稿；回跳触发参数走配置', () => {
  const within = SCAN_PLACES.filter((place) => place.mode === SCAN_ENTRIES.modes.withinRealm);
  assert.deepEqual(within.map((place) => place.id), ['sales-add', 'replenish-add', 'purchase-return-add'],
    '她点名的正是销售 / 补货 / 退货这三处 ✓');
  for (const place of within) {
    assert.equal(place.returnsToRealm, true, `${place.id} 必须"扫完回当前领域"`);
    assert.equal(place.keepDraft, true, `${place.id} 必须"带着之前的数据"（本单草稿）`);
    assert.ok(place.realm, `${place.id} 要写明回哪个领域`);
  }
  // ⭐ 回跳 URL 上的触发参数**走配置**（改名不用改代码 ✓；空 = 那三处就没法告诉领域页"是扫完回来的" ✗）
  assert.ok(String(SCAN_ENTRIES.backParam).trim(), 'backParam 必须有值');
  assert.equal(resolveScanEntriesConfig({ SCAN_ENTRY_BACK_PARAM: 'from_scan' }).backParam, 'from_scan',
    '换一个值就跟着换 ✓（配置先行）');
});

// ── AC-5S3：C 套（标签打印）从登记表取参数与文案 ───────────────────────────

test('AC-5S3 ⭐ 服务端登记表与浏览器镜像**逐字一致**（改一边忘另一边 ⇒ 红）', () => {
  const mirror = readWorkbench('config/scanEntries.js');
  // 两端都跑起来比（镜像只改 import，不用改别的 ✓）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'five-scans-mirror-'));
  fs.writeFileSync(path.join(dir, 'scanEntries.mjs'), mirror, 'utf8');
  return import(pathToFileURL(path.join(dir, 'scanEntries.mjs')).href).then((client) => {
    assert.deepEqual(client.SCAN_PLACES, SCAN_PLACES,
      '五处登记表两端必须逐字一致（真源 = server/src/config/scanEntries.js）');
    assert.deepEqual(client.SCAN_ENTRIES.texts, SCAN_ENTRIES.texts, '文案两端逐字一致');
    assert.equal(client.SCAN_ENTRIES.backParam, SCAN_ENTRIES.backParam, '回跳参数两端逐字一致');
  });
});

test('AC-5S3b ⭐ C 套的行为参数 = 登记表里那一行（页面上不再自己判一次 ✗）', async () => {
  const module = await loadScanPrintModule();
  assert.deepEqual(module.scanPrintPlaceParams(), {
    id: 'label-print',
    mechanism: 'jsapi',
    mode: 'standalone',
    returnsToRealm: false,
    keepDraft: false,
  });
  assert.equal(module.SCAN_PRINT_PLACE, module.scanPrintPlaceParams().id ? module.SCAN_PRINT_PLACE : null);
});

test('AC-5S3c ⭐ 文案**确实从配置取**（只改配置副本里那一句 ⇒ 模块跟着变；写死就红）', async () => {
  const module = await loadScanPrintModule({
    originalText: '📷 扫码打印',
    configText: '【来自配置的按钮名】',
  });
  assert.equal(module.SCAN_PRINT_TEXTS.button, '【来自配置的按钮名】',
    '改配置即改按钮名 ⇒ 证明 `scan-print.js` 没有把文案写死 ✓');
  assert.equal(module.SCAN_PRINT_TEXTS.title, '【来自配置的按钮名】');
});

// ── AC-5S4：B 套（领域条那颗）与今天逐字一致 ───────────────────────────────

test('AC-5S4 ⭐ B 套仍走 AppLink、且**不带数据**（与今天逐字一致）', () => {
  const layout = readSrc('views/scanPage/layout.js');
  assert.match(layout, /href="\$\{escapeHtml\(SCAN_PAGE\.scanNext\.applink\)\}"/,
    '领域条那颗仍是 AppLink（不是 JSAPI ⇒ 与今天逐字一致 ✓）');
  const row = placeById('realm-bar');
  assert.equal(row.mechanism, 'applink', '登记表里 ② 那行 = applink');
  assert.equal(row.mode, 'standalone');
  assert.equal(row.returnsToRealm, false, '② 扫完**不回**领域');
  assert.equal(row.keepDraft, false, '② **不带**之前的数据（她逐字）');
});

// ── AC-5S5：零回归（C 套对外的东西逐字节不变）────────────────────────────

test('AC-5S5 ⭐ 零回归：C 套的文案 / HTML / 端点常量与今天逐字节一致', async () => {
  const module = await loadScanPrintModule();
  assert.deepEqual(module.SCAN_PRINT_TEXTS, {
    button: '📷 扫码打印',
    scanning: '正在唤起扫一扫…',
    printing: '正在打印这一张…',
    noSdk: '这台设备调不起飞书扫一扫：请在**飞书里**打开工作台，再点一次。',
    cancelled: '取消了扫码，没有打印任何东西。',
    failed: '扫码没有成功，请再试一次。',
    enqueued: '✅ 已提交打印：这一张',
    reused: '刚刚已经发过这一张（没有重复提交）',
    nothing: '没有扫到内容，请对着标签上的二维码再扫一次。',
    timeout: '飞书扫一扫没响应（超时了）：请退出这一页重进再试一次；还不行就用上面「选择编号打印」。',
    reported: '（已把失败原因记到日志，方便工程师查）',
    title: '📷 扫码打印',
    subtitle: '对着鞋盒标签上的二维码扫一下 —— 那一张就直接排进店里那台电脑的打印队列，这里不用选编号。',
    scanAgain: '📷 再扫一张',
    batchLink: '要一次打很多张？去「批量打印」→',
    resultPrefix: '✅ 已提交打印：',
    reusedPrefix: '✅ 刚刚已经发过这一张：',
  }, '文案一个字节都不许变（本轮只做"参数/文案收敛"，不改任何用户可见行为）');
  assert.deepEqual(module.SCAN_PRINT_ENDPOINTS, {
    signature: '/api/workbench/lark/jsapi-signature',
    report: '/api/workbench/labels/scan-report',
    jobs: '/api/workbench/label-print/jobs',
  }, '端点一个字节都不许变');
  assert.equal(module.scanPrintBarHtml(),
    '\n      <div class="label-queue-bar scan-print-bar" data-view="scan-print-bar">\n'
    + '        <button class="btn btn-primary" type="button" data-action="scan-print"></button>\n'
    + '      </div>\n      <p class="scan-print-result" data-view="scan-print-result"></p>\n'
    + '      <p class="label-notice" data-view="scan-print-notice"></p>',
    '这一块的外壳逐字节不变');
});

// ── AC-5S6：配置先行 + 显式布尔 ─────────────────────────────────────────────

test('AC-5S6 ⭐ 显式布尔：不设 ⇒ 默认；显式 false ⇒ 关得掉；非法值 ⇒ 当场抛；禁 `||` 兜底', () => {
  const base = resolveScanEntriesConfig({});
  assert.equal(base.places.find((place) => place.id === 'sales-add').keepDraft, true, '不设 ⇒ 表里的默认值');
  const off = resolveScanEntriesConfig({ SCAN_ENTRY_SALES_ADD_KEEP_DRAFT: 'false' });
  assert.equal(off.places.find((place) => place.id === 'sales-add').keepDraft, false, '显式 false ⇒ 关得掉 ✓');
  const empty = resolveScanEntriesConfig({ SCAN_ENTRY_SALES_ADD_KEEP_DRAFT: '' });
  assert.equal(empty.places.find((place) => place.id === 'sales-add').keepDraft, false,
    '空串 = false（**不是**"回退默认值" ⇒ 关得掉 ✓，这正是禁 `||` 兜底的原因）');
  assert.throws(() => resolveScanEntriesConfig({ SCAN_ENTRY_SALES_ADD_KEEP_DRAFT: '也许' }), /显式布尔/);
  assert.throws(() => placeById('不存在的一处'), /登记表里没有/);

  const code = readSrc('config/scanEntries.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/process\.env\.[A-Z_]+\s*\|\|/.test(code), '不许 `process.env.X || fallback`（`||` 会关不掉 ✗）');
  assert.match(code, /readFlag\(/, '布尔一律走 `readFlag`（显式布尔语义 ✓）');
});
