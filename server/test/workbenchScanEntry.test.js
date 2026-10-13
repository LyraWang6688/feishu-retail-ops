/**
 * 「扫一扫」= 工作台一级 tab（放最前）· 2026-10-13 她裁定：**统一走飞书官方 AppLink**（签名那套已删 ✗）。
 * 本文件只管这一屏自己的 AC；一级 tab 的顺序/文案由 `test/workbenchFourTabs.test.js` 的 AC1 钉着 ✓
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

test('AC1 ⭐ 扫一扫这一屏：按钮 + 人话说明 + **手输编号兜底**（缺一不可）', async () => {
  const { scanPageHtml } = await loadScanModule();
  const html = scanPageHtml();
  assert.match(html, /data-scan-start[^>]*>打开飞书扫一扫</, '要有那个按钮（文案逐字）');
  assert.match(html, /data-scan-hint[\s\S]*?二维码/, '要有一句人话说明');
  assert.match(html, /data-scan-unavailable/, '要有"调不起来时"那条人话的位子（**不白屏** ✗）');
  assert.match(html, /data-entry-form[^>]*data-target-template="\/s\/\{number\}"/, '手输编号兜底（复用既有"输入编号 → 打开"机制）');
  assert.match(html, /name="number"/, '要真的有一个编号输入框');
});

test('AC2 ⭐ AppLink 与**扫码页同一来源**（逐字相同 · 不抄第二份 ✗）', async () => {
  const { scanButtonPlan, SCAN_ENTRY_PATH } = await loadScanModule();
  const { SCAN_NEXT } = require('../src/config/scanPage');
  assert.equal(SCAN_NEXT.applink, 'https://applink.feishu.cn/client/qrcode/main', '飞书官方"打开扫一扫"AppLink');
  assert.deepEqual(scanButtonPlan({ canScan: true, appLink: SCAN_NEXT.applink }),
    { mode: 'applink', href: SCAN_NEXT.applink }, 'AppLink **逐字相同**（同一份配置 ✓）');
  assert.equal(SCAN_ENTRY_PATH, '/api/workbench/scan-entry');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');
  assert.match(route, /appLink: SCAN_NEXT\.applink/, 'AppLink 取自 config/scanPage.js 的 SCAN_NEXT');
  assert.match(route, /canScan: canScanNextWithFeishu\(req\.get\('user-agent'\)\)/, 'UA 判据取自既有导出（不写第二份）');
});

test('AC3 ⭐ 非飞书 UA ⇒ **不给"点了没反应"的按钮** ✗（人话 + 手输兜底）', async () => {
  const { scanButtonPlan, MANUAL_FALLBACK_MESSAGE } = await loadScanModule();
  const { canScanNextWithFeishu } = require('../src/views/scanPageRenderer');
  assert.equal(canScanNextWithFeishu('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), false, '电脑 ⇒ 不能调');
  assert.equal(canScanNextWithFeishu('Mozilla/5.0 (iPhone) Feishu/7.0'), true, '飞书 iPhone ⇒ 能调');
  const plan = scanButtonPlan({ canScan: false, appLink: 'https://applink.feishu.cn/client/qrcode/main' });
  assert.equal(plan.mode, 'manual');
  assert.equal('href' in plan, false, '⭐ 调不起来时**不许**给 href（那就是死按钮 ✗）');
  assert.equal(plan.message, MANUAL_FALLBACK_MESSAGE);
  assert.deepEqual(scanButtonPlan({}), { mode: 'manual', message: MANUAL_FALLBACK_MESSAGE }, '没取到入口信息 ⇒ 也走手输');
});

test('AC4 ⭐ 文案单一来源：按钮/说明不在 index.html 里再写一遍（配置先行）', () => {
  assert.ok(!read('index.html').includes('打开飞书扫一扫'), 'index.html 不许硬编码文案');
  assert.ok(read('features/scan/index.js').includes('打开飞书扫一扫'), '文案单一来源 = features/scan/index.js');
});

test('AC5 ⭐ 一级 tab：扫一扫第一条；销售 · 库存 · 采购 · 货品 逐字不变', () => {
  const tabs = read('config/tabs.js');
  const order = [...tabs.matchAll(/\{ module: '([^']+)', label: '([^']+)' \}/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['scan:扫一扫', 'sales:销售', 'inventory:库存', 'purchase:采购', 'product:货品']);
});

test('AC6 🔴 源码里**不再有签名相关符号**（她 2026-10-13：统一走 AppLink，签名不需要）', () => {
  const roots = [path.join(__dirname, '..', 'src'), path.join(__dirname, '..', 'public', 'workbench')];
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs|mjs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/jsapi[-_]?signature|jsapiSignature|JSSDK_SIGNATURE_PATH|signJsapiTicket|startLarkScan|canUseLarkScan/i.test(text)) {
        hits.push(path.relative(path.join(__dirname, '..'), full));
      }
    }
  };
  roots.forEach(walk);
  assert.deepEqual(hits, [], `不许留签名相关符号（含半截死代码）：\n${hits.join('\n')}`);
  for (const gone of ['src/config/jsapiSignature.js', 'src/services/larkJsapiSignatureService.js', 'test/larkJsapiSignature.test.js']) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', gone)), false, `${gone} 应已删除`);
  }
});
