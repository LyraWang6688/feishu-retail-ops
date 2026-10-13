/**
 * 「扫一扫」= 工作台一级 tab（放最前）· 她 2026-10-13 真机口径：**点 tab 就直达飞书扫一扫**
 * （「不用在我点了扫一扫之后，再去弹提示说'去飞书扫一扫'，而是**直接点扫一扫就能调出摄像头**」）。
 * 一级 tab 的顺序/文案由 `test/workbenchFourTabs.test.js` 的 AC1 钉着 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

async function loadScanModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-scan-'));
  fs.copyFileSync(path.join(WORKBENCH, 'features/scan/index.js'), path.join(dir, 'scan.mjs'));
  return import(path.join(dir, 'scan.mjs'));
}

/** 假的 sessionStorage（防循环那条 AC 要用） */
const fakeStorage = () => {
  const bag = new Map();
  return { getItem: (k) => (bag.has(k) ? bag.get(k) : null), setItem: (k, v) => bag.set(k, String(v)), bag };
};

test('AC1 这一屏只有**兜底**形态：按钮 + 人话位子 + **手输编号兜底**（缺一不可）', async () => {
  const { scanPageHtml } = await loadScanModule();
  const html = scanPageHtml();
  assert.match(html, /data-scan-start[^>]*>打开飞书扫一扫</, '兜底时给的那颗按钮（能自动跳时她看不到它 ✓）');
  assert.match(html, /data-scan-unavailable/, '要有"打不开时"那条人话的位子（**不白屏** ❌）');
  assert.match(html, /data-entry-form[^>]*data-target-template="\/s\/\{number\}"/, '手输编号兜底（复用既有机制）');
  assert.match(html, /name="number"/, '要真的有一个编号输入框');
});

test('AC2 ⭐⭐ 点 tab ⇒ **直接弹摄像头**（`auto` 模式：不用她再点一次）', async () => {
  const { scanEntryPlan } = await loadScanModule();
  const { SCAN_NEXT } = require('../src/config/scanPage');
  assert.equal(SCAN_NEXT.applink, 'https://applink.feishu.cn/client/qrcode/main', '飞书官方"打开扫一扫"AppLink');
  const plan = scanEntryPlan({ canScan: true, appLink: SCAN_NEXT.applink, alreadyTriggered: false });
  assert.deepEqual(plan, { mode: 'auto', href: SCAN_NEXT.applink },
    '⭐ 飞书里进这一屏 ⇒ **立刻跳**（等价于"点了 tab 就弹摄像头" ✓ 不再有中间那一屏 ✓）');
  // AppLink 与扫码页**同一来源**（不抄第二份 ✓）；UA 判据也同源 ✓
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
  assert.match(route, /appLink: SCAN_NEXT\.applink/, 'AppLink 取自 config/scanPage.js 的 SCAN_NEXT');
  assert.match(route, /canScan: canScanNextWithFeishu\(req\.get\('user-agent'\)\)/, 'UA 判据取自既有导出');
});

test('AC3 ⭐ 非飞书 UA ⇒ **不自动跳**，给一屏人话 + 手输（**不白屏** ❌）', async () => {
  const { scanEntryPlan, MANUAL_FALLBACK_MESSAGE } = await loadScanModule();
  const { canScanNextWithFeishu } = require('../src/views/scanPageRenderer');
  assert.equal(canScanNextWithFeishu('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false, '电脑 ⇒ 不能调');
  assert.equal(canScanNextWithFeishu('Mozilla/5.0 (iPhone) Feishu/7.0'), true, '飞书 iPhone ⇒ 能调');
  const plan = scanEntryPlan({ canScan: false, appLink: 'https://applink.feishu.cn/client/qrcode/main' });
  assert.deepEqual(plan, { mode: 'fallback', message: MANUAL_FALLBACK_MESSAGE });
  assert.equal('href' in plan, false, '⭐ 不自动跳、也**不许**给一个点了没反应的 href ✗');
  assert.deepEqual(scanEntryPlan({}), { mode: 'fallback', message: MANUAL_FALLBACK_MESSAGE }, '取不到入口 ⇒ 也走兜底');
});

test('AC4 ⭐⭐ 护栏：**只自动跳一次、不循环**（她回到这一屏 ⇒ 不再被弹走 ✗）', async () => {
  const { scanEntryPlan, SCAN_AUTO_FLAG_KEY } = await loadScanModule();
  const plan = scanEntryPlan({ canScan: true, appLink: 'https://applink.feishu.cn/client/qrcode/main', alreadyTriggered: true });
  assert.deepEqual(plan, { mode: 'manual', appLink: 'https://applink.feishu.cn/client/qrcode/main' },
    '已经自动跳过 ⇒ 改给一颗**手动**按钮（否则她会被弹出去出不来 ✗）');
  assert.equal(SCAN_AUTO_FLAG_KEY, 'workbench.scan.autoTriggered');
  // 真挂载一次：能自动跳 ⇒ 只 navigate 一次 + 打了记号；再挂一次 ⇒ 不再 navigate ✓
  const { createScanModule } = await loadScanModule();
  const storage = fakeStorage();
  const navigations = [];
  const html = read('features/scan/index.js');
  const source = { innerHTML: '' };
  const node = () => ({ classList: { add() {}, remove() {} }, dataset: {}, addEventListener() {}, querySelector: () => null });
  const container = { set innerHTML(v) { source.innerHTML = v; }, querySelector: () => node() };
  const service = createScanModule({
    storage,
    navigate: (url) => navigations.push(url),
    fetchImpl: async () => ({ json: async () => ({ success: true, canScan: true, appLink: 'https://applink.feishu.cn/client/qrcode/main' }) }),
  });
  service.mount(container);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(navigations, ['https://applink.feishu.cn/client/qrcode/main'], '第一次进 ⇒ 自动跳一次');
  service.mount(container);
  await new Promise((r) => setImmediate(r));
  assert.equal(navigations.length, 1, '⭐ 第二次进 ⇒ **不再自动跳**（防循环 ✓）');
  assert.ok(html.includes('SCAN_AUTO_FLAG_KEY'), '记号键来自模块常量（不是散落字面量）');
});

test('AC5 ⭐ 文案单一来源 + 一级 tab 顺序回归：扫一扫 ▸ 销售 ▸ 库存 ▸ 采购 ▸ 货品', () => {
  assert.ok(!read('index.html').includes('打开飞书扫一扫'), 'index.html 不许硬编码文案');
  assert.ok(read('features/scan/index.js').includes('打开飞书扫一扫'), '文案单一来源 = features/scan/index.js');
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
