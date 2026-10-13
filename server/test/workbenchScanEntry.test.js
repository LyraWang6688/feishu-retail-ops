/**
 * 「扫一扫」= 工作台一级 tab（放最前）· **2026-10-13 晚按她真机口径重做**：
 *   她（逐字）：「**就是点那个 tab 上的扫一扫**」（⇒ 那一格本身 = `<a href="<AppLink>">`，用户手势 ⇒ 弹 ✓）
 *             「点击了还是没有弹出来，反而是**点击工作台之后就出现了扫描框**。需要的是，**每点一次掉一次**」
 *             「若飞书依旧不弹 ⇒ 那一格里必须有一颗真能点的按钮 ✓，**不需要，就是点那个 tab 上的扫一扫**」
 * ⇒ 本文件钉的新口径：① 那一格是链接（点一次弹一次 ✓）② 进工作台**不**自动弹 ✗
 *                    ③ 面板里**没有**"打开扫一扫"按钮 ✗（她明确说不需要 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把 core/tabs.js（只 import config/tabs.js）拷成 .mjs 再 import ✓ */

/** 只取 `main.js` 里**扫一扫相关**的两段（renderMainTabs / loadScanEntry / bindMainTabClicks）
 *  —— 登录那条链路本来就有 `location.assign`，与扫一扫无关，不能一起判 ✗ */
function scanRelatedSource() {
  const source = read('main.js');
  const from = source.indexOf('let scanAppLink');
  const to = source.indexOf('function activateModule(');
  return source.slice(from, to > from ? to : undefined);
}

async function loadTabs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-tabs-'));
  fs.writeFileSync(path.join(dir, 'tabs.mjs'), read('core/tabs.js').replace("'../config/tabs.js'", "'./config.mjs'"));
  fs.writeFileSync(path.join(dir, 'config.mjs'), read('config/tabs.js'));
  return import(path.join(dir, 'tabs.mjs'));
}
async function loadScanModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-scan-'));
  fs.copyFileSync(path.join(WORKBENCH, 'features/scan/index.js'), path.join(dir, 'scan.mjs'));
  return import(path.join(dir, 'scan.mjs'));
}

test('AC1 ⭐⭐ 点「扫一扫」那一格 ⇒ 触发 AppLink（那一格**本身**是 `<a href>` ⇒ 用户手势 ✓）', async () => {
  const { mainTabsHtml, MAIN_TABS } = await loadTabs();
  const { SCAN_NEXT } = require('../src/config/scanPage');
  assert.equal(SCAN_NEXT.applink, 'https://applink.feishu.cn/client/qrcode/main', '飞书官方"打开扫一扫"AppLink');
  const html = mainTabsHtml(MAIN_TABS, { hrefs: { scan: SCAN_NEXT.applink } });
  // ① 扫一扫那一格 = 原生链接，href **逐字** = SCAN_NEXT.applink（同源 ✓）
  assert.match(html, new RegExp(`<a class="main-tab[^"]*" data-module="scan" href="${SCAN_NEXT.applink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`),
    '⭐ 那一格必须**本身**是链接（点它 = 用户手势 ⇒ 飞书才放行 ✓）');
  assert.match(html, />扫一扫<\/a>/, '文案逐字');
  // ② 其余四格仍是 button（既有面板机制不动 ✓）且顺序不变
  const order = [...html.matchAll(/data-module="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['scan', 'sales', 'inventory', 'purchase', 'product'], '顺序回归 ✓');
  assert.equal((html.match(/<button class="main-tab/g) || []).length, 4, '其余四格仍是面板按钮 ✓');
  // ③ 点一次弹一次：**没有**任何一次性记号 / JS 导航（原生链接天然按次 ✓）
  // ⚠️ 只能查**扫一扫这两个函数体内** —— `main.js` 里登录那条本来就有 `location.assign`（与我们无关 ✗）
  const scanPath = scanRelatedSource();
  for (const bad of ['location.assign', 'location.replace', 'window.open', 'sessionStorage']) {
    assert.equal(scanPath.includes(bad), false, `扫一扫这条路上不许有 JS 导航 / 一次性记号：${bad}`);
  }
  assert.match(scanPath, /appLink/, 'AppLink 来自服务端 /scan-entry（同源 ✓）');
});

test('AC2 ⭐⭐ 进入工作台 ⇒ **不触发任何导航**（她踩到的就是"一进就弹" ✗）', async () => {
  const { mainTabsHtml, MAIN_TABS } = await loadTabs();
  // 默认渲染（入口信息还没到 / 取不到）⇒ 仍是 5 颗按钮 ⇒ **点它只会切面板**，不会跳走 ✓
  const html = mainTabsHtml(MAIN_TABS);
  assert.equal((html.match(/<button class="main-tab/g) || []).length, 5, '默认 5 颗按钮（行为与改前逐字相同 ✓）');
  assert.equal(/<a\b/.test(html), false, '默认渲染里没有任何链接 ⇒ 进工作台不会自动跳 ✓');
  const scanPath = scanRelatedSource();
  assert.equal(/location\.assign|location\.replace|window\.open/.test(scanPath), false, '扫一扫这条路上没有 JS 导航 ✓');
  assert.match(scanPath, /loadScanEntry/, '只"取一次入口信息" ✓');
  assert.equal(/\.click\(\)/.test(scanPath), false, '不许自己点自己 ✗');
});

test('AC3 panel keeps nothing: no manual number input, no form, no button, no hint text', async () => {
  const { scanPanelHtml } = await loadScanModule();
  const html = scanPanelHtml();
  assert.match(html, /data-view="scan-panel"/, 'keep the container the shell needs');
  assert.equal(html.replace(/<[^>]+>/g, '').trim(), '', 'panel renders ZERO visible text (hint text removed too)');
  for (const gone of ['<input', 'data-entry-form', 'name="number"', 'data-scan-unavailable', '扫描', '手输', '编号']) {
    assert.equal(html.includes(gone), false, `panel must not contain: ${gone}`);
  }
  assert.equal(/<button\b/.test(html), false, 'no button in the panel');
  assert.equal(/<a\b/.test(html), false, 'no link in the panel (the tab cell itself is the link)');
  // clearing the panel must NOT turn the tab cell back into a button
  assert.match(read('core/tabs.js'), /if \(href\) \{[\s\S]*?<a class="main-tab/, 'tab-as-link branch still in core/tabs.js');
  assert.match(read('main.js'), /hrefs: scanAppLink \? \{ scan: scanAppLink \} : \{\}/, 'main.js still swaps that cell to a link');
});

test('AC4 ⭐ AppLink 与 `config/scanPage.js` 的 `SCAN_NEXT.applink` **逐字同源**（路由侧不抄第二份 ✓）', () => {
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
  assert.match(route, /appLink: SCAN_NEXT\.applink/, 'AppLink 取自既有 SCAN_NEXT ✓');
  assert.match(route, /canScan: canScanNextWithFeishu\(req\.get\('user-agent'\)\)/, 'UA 判据取自既有导出 ✓');
  const entry = fs.readdirSync(path.join(WORKBENCH, 'features/scan'));
  assert.ok(entry.includes('index.js'), '那一格的链接目标由 /scan-entry 提供（单一来源 ✓）');
});

test('AC5 一级 tab 顺序回归：扫一扫 ▸ 销售 ▸ 库存 ▸ 采购 ▸ 货品', () => {
  const order = [...read('config/tabs.js').matchAll(/\{ module: '([^']+)', label: '([^']+)' \}/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['scan:扫一扫', 'sales:销售', 'inventory:库存', 'purchase:采购', 'product:货品']);
});

test('AC6 🔴 源码里不再有签名相关符号（她 2026-10-13：统一走 AppLink，签名不需要）', () => {
  const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'public', 'workbench')];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      if (/jsapi[-_]?signature|jsapiSignature|JSSDK_SIGNATURE_PATH|signJsapiTicket|startLarkScan|canUseLarkScan/i.test(fs.readFileSync(full, 'utf8'))) {
        hits.push(path.relative(path.join(__dirname, '..'), full));
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(hits, [], `不许留签名相关符号：\n${hits.join('\n')}`);
});
