/**
 * ⭐⭐ 2026-10-15 晚（业务负责人真机截图）：扫码聚焦页的**成功提示重复了两行** ——
 *   大绿字「✅ 已提交打印：这一张」＋ 下面小字**同一句话**又说一遍 ⇒ 同一件事说两遍 ✗
 *   ＋ 那行大字**退化成"这一张"**（真机那一单是 `L6950|黑色|A`）—— 根因是**服务端响应里没有 `numbers`** ✗
 *     （服务端日志有、HTTP 响应没有 ⇒ 页面拿不到编号就只能说"这一张"）。
 *
 * 修法：
 *   B 成功时**只留大字那一行**（小字那行清空 —— 不然还留着"正在打印这一张…"那句旧的）；
 *     失败 / 取消 / 超时 / 没扫到**照旧**走小字那行 ✓
 *   C `/label-print/jobs` 的响应**带上 `numbers`**（**加字段**，既有字段不动 ✓）⇒ 大字显示真编号 ✓
 *     ⚠️ 服务端那半的判据在 `labelPrintJobNumbers.test.js`（真的打完 HTTP 响应断言）；
 *        本文件用**假响应**钉页面那半（她要看到的是「✅ 已提交打印：L6950|黑色|A」）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 *   AC-A4 成功 ⇒ **只有一行**成功提示（大字那行；小字那行为空）—— 改回两行 ⇒ 红 ✓
 *   AC-A5 成功那行**带真实编号**（假响应给 `numbers:['L6950|黑色|A']` ⇒ 页面出现该编号）✓
 *   AC-A6 失败 / 取消 / 超时 / 没扫到那几条人话**一条没丢**（仍走小字那行 ⇒ 大字那行必须空）✓
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把前端模块复制成 `.mjs`（**只改 import 的文件名，逻辑一个字不改**）再当模块跑。 */
const loadScanPrintModule = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-print-line-'));
  fs.copyFileSync(path.join(WORKBENCH, 'core/ui.js'), path.join(dir, 'ui.mjs'));
  // ⚠️ 2026-10-16 **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`read('features/labels/scan-print.js').split("from '../../core/ui.js'").join("from './ui.mjs'")`
  //             —— 只处理 `core/ui.js` 这一条 import。
  //   改后逐字：**多复制一份 `config/scanEntries.js`** ＋ 把新 import 指向副本
  //             （业务负责人 2026-10-16 21:2x 五处口径 ⇒ 这一处的参数/文案收敛到登记表 ✓）。
  //   ⚠️ 只改**加载器**（不复制 ⇒ 模块不存在 ⇒ 假红 ✗）；**判据一个字没放宽** ✓。
  fs.copyFileSync(path.join(WORKBENCH, 'config/scanEntries.js'), path.join(dir, 'scanEntries.mjs'));
  fs.writeFileSync(path.join(dir, 'scan-print.mjs'),
    read('features/labels/scan-print.js')
      .split("from '../../core/ui.js'").join("from './ui.mjs'")
      .split("from '../../config/scanEntries.js'").join("from './scanEntries.mjs'"),
    'utf8');
  return import(pathToFileURL(path.join(dir, 'scan-print.mjs')).href);
};

const fakeContainer = () => {
  const make = () => ({
    textContent: '', className: '', disabled: false, dataset: {}, handlers: {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
  });
  const elements = {
    '[data-action="scan-print"]': make(),
    '[data-view="scan-print-notice"]': make(),
    '[data-view="scan-print-result"]': make(),
  };
  return { elements, querySelector: (selector) => elements[selector] || null };
};

const fakeWin = ({ scanResult = { result: 'https://hm.bamamei.online/r/rec_l6950', errMsg: 'scanCode:ok' }, fail = null } = {}) => ({
  location: { href: 'https://hm.bamamei.online/workbench/label-print.html?scan=1' },
  h5sdk: { config() { return Promise.resolve(); }, ready(callback) { callback(); } },
  tt: { scanCode(options) { if (fail) options.fail(fail); else options.success(scanResult); } },
});

const apiOf = (jobsResult) => {
  const calls = { get: [], post: [] };
  return {
    calls,
    api: {
      async get() { return { appId: 'cli_x', timestamp: 1, nonceStr: 'n', signature: 's', jssdkUrl: 'https://cdn.test/h5sdk.js' }; },
      async post(url, body) { calls.post.push({ url, body }); return jobsResult; },
    },
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-A4 / AC-A5 成功：只有一行 + 带真实编号
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A4/AC-A5 ⭐⭐ 成功 ⇒ **只有一行**成功提示，而且那行带**真实编号**（L6950|黑色|A）', async () => {
  const module = await loadScanPrintModule();
  const container = fakeContainer();
  const win = fakeWin();
  // ⭐ 真机那一单的**真实编号**（服务端响应加了 `numbers` 之后页面就拿得到它）
  const { api } = apiOf({ success: true, total_labels: 1, job_id: 'job-1', numbers: ['L6950|黑色|A'] });
  const action = module.createScanPrintAction({ api, doc: null, win });
  const button = action.mount(container);
  await button.handlers.click();

  const notice = container.elements['[data-view="scan-print-notice"]'].textContent;
  const result = container.elements['[data-view="scan-print-result"]'].textContent;
  // ① 🔴 同一件事**只说一遍**：小字那行不许再重复（改回两行 ⇒ 这里红）
  assert.equal(notice, '', `成功时小字那行必须是空的（同一句话不许说两遍 ✗）；实际：${notice}`);
  // ② 成功那一句在**大字**那行，且带**真编号**（不是"这一张"）
  assert.equal(result, '✅ 已提交打印：L6950|黑色|A', `大字要带真实编号（实际：${result}）`);
  assert.ok(!result.includes('这一张'), '拿到编号就不许再说"这一张" ✗');
  // ③ 按钮照旧变「再扫一张」（既有行为没动）
  assert.equal(container.elements['[data-action="scan-print"]'].textContent, '📷 再扫一张');
});

test('AC-A5 重复提交（reused）也**只有一行**，并且如实说"刚刚已经发过"＋编号', async () => {
  const module = await loadScanPrintModule();
  const container = fakeContainer();
  const win = fakeWin();
  const { api } = apiOf({ success: true, total_labels: 1, job_id: 'job-1', reused: true, numbers: ['L6950|黑色|A'] });
  const action = module.createScanPrintAction({ api, doc: null, win });
  const button = action.mount(container);
  await button.handlers.click();

  assert.equal(container.elements['[data-view="scan-print-notice"]'].textContent, '', '还是一行（不许说两遍）');
  assert.equal(container.elements['[data-view="scan-print-result"]'].textContent,
    '✅ 刚刚已经发过这一张：L6950|黑色|A', '重复提交的措辞与大字的编号都在同一行 ✓');
});

test('AC-A5 拿不到编号（老响应没带 numbers）⇒ 大字退回"这一张"（**不编假编号** ✗）且仍只有一行', async () => {
  const module = await loadScanPrintModule();
  const container = fakeContainer();
  const win = fakeWin();
  const { api } = apiOf({ success: true, total_labels: 1, job_id: 'job-1' });
  const action = module.createScanPrintAction({ api, doc: null, win });
  const button = action.mount(container);
  await button.handlers.click();

  assert.equal(container.elements['[data-view="scan-print-notice"]'].textContent, '');
  assert.equal(container.elements['[data-view="scan-print-result"]'].textContent, '✅ 已提交打印：这一张',
    '拿不到编号 ⇒ 不编（既有纯函数判据照旧 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-A6 失败 / 取消 / 超时 / 没扫到：那几条人话一条没丢（仍走小字那行）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A6 ⭐ 失败 / 取消 / 超时 / 没扫到的人话**一条没丢**（走小字那行；大字那行保持空）', async () => {
  const module = await loadScanPrintModule();

  // ① 她自己取消
  const cancelled = fakeContainer();
  const winCancel = fakeWin({ fail: { errMsg: 'scanCode:cancel' } });
  await (await loadScanPrintModule()).createScanPrintAction({
    api: apiOf({ success: true }).api, doc: null, win: winCancel,
  }).mount(cancelled).handlers.click();
  assert.equal(cancelled.elements['[data-view="scan-print-notice"]'].textContent, module.SCAN_PRINT_TEXTS.cancelled);
  assert.equal(cancelled.elements['[data-view="scan-print-result"]'].textContent, '', '取消 ⇒ 大字那行不许有成功话 ✗');

  // ② 没扫到内容
  const empty = fakeContainer();
  const winEmpty = fakeWin({ scanResult: { result: '', errMsg: 'scanCode:ok' } });
  await module.createScanPrintAction({ api: apiOf({ success: true }).api, doc: null, win: winEmpty })
    .mount(empty).handlers.click();
  assert.equal(empty.elements['[data-view="scan-print-notice"]'].textContent, module.SCAN_PRINT_TEXTS.nothing);
  assert.equal(empty.elements['[data-view="scan-print-result"]'].textContent, '');

  // ③ 没有飞书 JSSDK（电脑上打开的）
  const noSdk = fakeContainer();
  const action = module.createScanPrintAction({
    api: apiOf({ success: true }).api, doc: null, win: { location: { href: 'https://hm.bamamei.online/x' } },
  });
  await action.mount(noSdk).handlers.click();
  assert.match(noSdk.elements['[data-view="scan-print-notice"]'].textContent, /飞书/);
  assert.equal(noSdk.elements['[data-view="scan-print-result"]'].textContent, '');

  // ④ 超时（`ready` 永不回调）
  const timeout = fakeContainer();
  const winTimeout = {
    location: { href: 'https://hm.bamamei.online/workbench/label-print.html?scan=1' },
    h5sdk: { config() { return Promise.resolve(); }, ready() { /* 永不回调 */ } },
    tt: { scanCode() { throw new Error('不该走到这里'); } },
  };
  await module.createScanPrintAction({
    api: apiOf({ success: true }).api, doc: null, win: winTimeout, readyTimeoutMs: 20,
  }).mount(timeout).handlers.click();
  assert.match(timeout.elements['[data-view="scan-print-notice"]'].textContent, /超时/);
  assert.equal(timeout.elements['[data-view="scan-print-result"]'].textContent, '');
});

// ═══════════════════════════════════════════════════════════════════════════
// 源码哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-A4 源码哨兵：成功分支里**不再**写"已提交打印"那句小字（只有 notice(\'\') + resultLine）', () => {
  const source = read('features/labels/scan-print.js');
  // ⚠️ 先剥注释：成功那段注释里**逐字留着"改前"那一行**（成对翻新要写清改前 → 改后）
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/notice\(result\?\.reused/.test(code), false,
    '成功那一步不许再往小字那行写（改回两行 ⇒ 红）');
  const successBlock = source.slice(source.indexOf('notice(texts.printing)'), source.indexOf('report({ ok: true'));
  assert.ok(successBlock.includes("notice('')"), '成功先把小字那行清空（不留"正在打印…"那句旧的）');
  assert.ok(successBlock.includes('resultLine(scanResultText('), '成功那句话在**大字**那行');
  // 失败那几条照旧（本哨兵只保护"成功不重复"这一件事）
  // ⚠️ "取消"那句走 `scanFailureText(error, texts)`（`/cancel/i` 那支）—— 判据按**真的那几处**钉：
  for (const needle of ['notice(texts.nothing)', 'notice(texts.noSdk)',
    'notice(`${texts.timeout}${texts.reported}`)', 'scanFailureText(error, texts)']) {
    assert.ok(source.includes(needle), `失败/取消/超时那几条人话不许丢：${needle}`);
  }
});
