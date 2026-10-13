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


/** links.js 现在是纯常量导出，但有相对 import 的可能 ⇒ 拷成 .mjs 再 import ✓ */
function mkLinksModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-links-'));
  fs.writeFileSync(path.join(dir, 'links.mjs'), read('config/links.js').replace(/from '\.\.\//g, "from '../"));
  return dir;
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

test('AC7 ⭐⭐ mobile UA ⇒ that cell is <a href=AppLink>; PC UA ⇒ cell hidden (no dead tap)', async () => {
  const { mainTabsHtml, MAIN_TABS } = await loadTabs();
  const { canScanNextWithFeishu } = require('../src/views/scanPageRenderer');
  const { SCAN_NEXT } = require('../src/config/scanPage');
  const MOBILE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Lark/7.36.0';
  const PC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
  assert.equal(canScanNextWithFeishu(MOBILE), true, 'mobile Feishu ⇒ canScan true');
  assert.equal(canScanNextWithFeishu(PC), false, 'PC ⇒ canScan false');
  // mobile: the cell itself is the link (逐字同源 ✓)
  const html = mainTabsHtml(MAIN_TABS, { hrefs: { scan: SCAN_NEXT.applink } });
  assert.match(html, new RegExp(`<a class="main-tab[^"]*" data-module="scan" href="${SCAN_NEXT.applink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  // PC: main.js hides that cell (no dead tap ✗) and keeps the default panel on the first usable tab
  const mainSource = read('main.js');
  assert.match(mainSource, /if \(scanEntryReady && !scanAppLink\)/, 'PC / 取不到 ⇒ 收起那一格');
  assert.match(mainSource, /cell\.classList\.add\('hidden'\)/);
  assert.match(mainSource, /find\(\(tab\) => !tab\.classList\.contains\('hidden'\)\)/, '默认面板 = 第一格可用（不是被藏起来的那格）');
});

test('AC8 ⭐ 扫一扫面板**真空**（只有一个空容器；唯一子页不再画子 tab 条）+ favicon 不再空响应', () => {
  // ① 面板：唯一的子页 ⇒ 领域骨架不画子 tab 条（她要的"小标题 + 空框"就是它 ✗）
  const renderer = read('features/domains/index.js');
  assert.match(renderer, /const subTabsHtml = domain\.pages\.length > 1/, '单子页领域不画子 tab 条 ✓');
  const domains = read('config/domains.js');
  const scanBlock = domains.slice(domains.indexOf("id: 'scan'"), domains.indexOf("id: 'sales'"));
  assert.equal((scanBlock.match(/kind: 'scan'/g) || []).length, 1, '扫一扫领域**只有一个**子页 ✓');
  // ② favicon：明确"没有图标" ⇒ 不再请求 /favicon.ico（她截图里那条 ERR_EMPTY_RESPONSE ✗）
  const html = read('index.html');
  assert.match(html, /<link rel="icon" href="data:,">/, '要有一条明确的 icon 声明 ✓');
  assert.equal(/href="[^"]*favicon/.test(html), false, '不许再有指向 favicon.ico 的引用 ✗');
});

test('AC9 ⭐⭐ first paint already renders that cell as <a href=AppLink rel=noopener> (same shape as the scan page)', async () => {
  const { mainTabsHtml, MAIN_TABS } = await loadTabs();
  const { SCAN_APPLINK } = await import(path.join(mkLinksModule(), 'links.mjs'));
  // ① 客人端的 links.js 与 服务端的 SCAN_NEXT.applink **逐字相同**（两端同一把链接 ✓，有断言钉着）
  const { SCAN_NEXT } = require('../src/config/scanPage');
  assert.equal(SCAN_APPLINK, SCAN_NEXT.applink, 'client SCAN_APPLINK === server SCAN_NEXT.applink（逐字 ✓）');
  assert.equal(SCAN_APPLINK, 'https://applink.feishu.cn/client/qrcode/main');
  // ② 首屏（不依赖任何接口返回）就已经是 <a>：形状**照抄扫码页那条**（无 target / 无 JS ✓）
  const html = mainTabsHtml(MAIN_TABS, { hrefs: { scan: SCAN_APPLINK } });
  assert.ok(html.startsWith(`<a class="main-tab" data-module="scan" href="${SCAN_APPLINK}" rel="noopener">扫一扫</a>`),
    `那一格必须是纯 <a href=AppLink rel=noopener>（实际开头：${html.slice(0, 120)}）`);
  assert.equal(/target=/.test(html), false, '不要 target（照抄扫码页那条 ✓）');
  assert.equal((html.match(/<button class="main-tab/g) || []).length, 4, '其余四格仍是 button（别顺手都变 <a> ✗）');
  // ③ main.js 的初值就是它 ⇒ 不依赖 /scan-entry 的返回时机 ✓
  assert.match(read('main.js'), /let scanAppLink = SCAN_APPLINK;/, '首屏即 <a>（消除时序怀疑点 ✓）');
  assert.match(read('main.js'), /import \{ SCAN_APPLINK \} from '\.\/config\/links\.js';/);
});

test('AC10 that cell is never intercepted by JS (no preventDefault / no activateModule on it)', () => {
  const main = read('main.js');
  assert.match(main, /querySelectorAll\('\.main-tab:not\(\[href\]\)'\)/, '只给"不是链接"的格子绑点击 ✓');
  assert.equal(/preventDefault/.test(main), false, '不许对那一格 preventDefault ✗');
  assert.equal(/\.click\(\)/.test(main), false, '不许自点 ✗');
  assert.equal(/sessionStorage/.test(main), false, '不许"只弹一次"的记号 ✗');
});
