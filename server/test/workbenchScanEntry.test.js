/**
 * 「扫一扫」= 工作台一级 tab（放最前）· 2026-10-13 她裁定 —— 本文件只管**这一屏自己**的 AC。
 * （一级 tab 的**顺序/文案**由 `test/workbenchFourTabs.test.js` 的 AC1 钉着 ✓）
 *
 * ⚠️ 原生扫码需要**飞书 JSAPI 签名**（要动 app 凭证）⇒ 那一步**待 Lead 批准**；
 *    所以这里钉的是"**没接入时也不许白屏、必须给明确人话 + 手输编号兜底**" ✗。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/** 把 ES 模块拷成 .mjs 再 import（这套 frontend 测试的既有做法；本模块**没有相对 import** ✓）。 */
async function loadScanModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-scan-'));
  fs.copyFileSync(path.join(WORKBENCH, 'features/scan/index.js'), path.join(dir, 'scan.mjs'));
  return import(path.join(dir, 'scan.mjs'));
}

test('AC1 ⭐ 扫一扫这一屏：大按钮 + 人话说明 + **手输编号兜底**（缺一不可）', async () => {
  const { scanPageHtml } = await loadScanModule();
  const html = scanPageHtml();
  assert.match(html, /data-scan-start[^>]*>打开飞书扫一扫</, '要有那个大按钮（文案逐字）');
  assert.match(html, /data-scan-hint[\s\S]*?二维码/, '要有一句人话说明（不是说明书腔）');
  assert.match(html, /data-scan-unavailable/, '要有"打不开时"那条人话的位子（非飞书/未授权 ⇒ 不白屏）');
  assert.match(html, /data-entry-form[^>]*data-target-template="\/s\/\{number\}"/, '手输编号兜底（复用既有"输入编号 → 打开"机制，目标 URL 由模板拼）');
  assert.match(html, /name="number"/, '要真的有一个编号输入框');
});

test('AC2 扫码能力判据：不在飞书 ⇒ false（**不许假装能扫** ✗）；有 h5sdk ⇒ true', async () => {
  const { canUseLarkScan } = await loadScanModule();
  assert.equal(canUseLarkScan({}), false, '空环境 ⇒ 不可用');
  assert.equal(canUseLarkScan({ h5sdk: {} }), false, '只有 h5sdk 壳、没有 ready ⇒ 仍不可用');
  assert.equal(canUseLarkScan({ h5sdk: { ready() {} } }), true, '飞书里 ⇒ 可用');
});

test('AC3 文案单一来源：扫一扫页的按钮/说明不在 index.html 里再写一遍', () => {
  const indexHtml = read('index.html');
  assert.ok(!indexHtml.includes('打开飞书扫一扫'), 'index.html 不许硬编码扫一扫按钮文案（配置先行）');
  const scanSource = read('features/scan/index.js');
  assert.ok(scanSource.includes('打开飞书扫一扫'), '文案的单一来源 = features/scan/index.js');
});

test('AC4 一级 tab 的配置里，扫一扫是**第一条**（其余 4 条一个字没动）', () => {
  const tabs = read('config/tabs.js');
  const order = [...tabs.matchAll(/\{ module: '([^']+)', label: '([^']+)' \}/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(order, ['scan:扫一扫', 'sales:销售', 'inventory:库存', 'purchase:采购', 'product:货品'],
    '⭐ 扫一扫最前；销售 · 库存 · 采购 · 货品 逐字不变 ✓');
});

test('AC5 扫码结果 → 路径：记录 ID ⇒ /r/… ；纯编号 ⇒ /s/… ；认不出 ⇒ null（**不猜** ✗）', async () => {
  const { extractScanTarget } = await loadScanModule();
  assert.equal(extractScanTarget('https://hm.bamamei.online/r/recAbC-1'), '/r/recAbC-1', '记录 ID 口径（她 2026-10-12 定）');
  assert.equal(extractScanTarget('66133-17'), '/s/66133-17', '带后缀的编号');
  assert.equal(extractScanTarget('  66133  '), '/s/66133', '纯编号（去空格）');
  assert.equal(extractScanTarget('随便一句话'), null, '认不出 ⇒ null（由调用方给人话，不猜）');
  assert.equal(extractScanTarget(''), null);
});

test('AC6 ⭐ 不在飞书 ⇒ not_in_lark，且**一个网络请求都不发**（不许假装能扫 ✗）', async () => {
  const { startLarkScan } = await loadScanModule();
  let called = 0;
  const outcome = await startLarkScan({ win: {}, fetchImpl: async () => { called += 1; return { status: 200, json: async () => ({ success: true }) }; } });
  assert.deepEqual(outcome, { ok: false, reason: 'not_in_lark' });
  assert.equal(called, 0, '不在飞书就别去取签名（省一次请求，也不假装）');
});

test('AC7 飞书里但**没登录**（401）⇒ not_logged_in', async () => {
  const { startLarkScan } = await loadScanModule();
  const win = { h5sdk: { ready() {} }, location: { href: 'https://hm.bamamei.online/workbench/' } };
  const outcome = await startLarkScan({ win, fetchImpl: async () => ({ status: 401, json: async () => ({ success: false, auth_required: true }) }) });
  assert.deepEqual(outcome, { ok: false, reason: 'not_logged_in' });
});

test('AC8 ⭐⭐ 飞书 + 签名成功 + 扫到编号 ⇒ 直接给目标路径（config 收到四项、跳 /s/…）', async () => {
  const { startLarkScan, JSSDK_SIGNATURE_PATH } = await loadScanModule();
  const seen = { url: '', config: null };
  const win = {
    h5sdk: {
      ready() {},
      config(args) { seen.config = args; args.onSuccess(); },
      biz: { util: { scanCard({ onSuccess }) { onSuccess({ result: '66133-17' }); } } },
    },
    location: { href: 'https://hm.bamamei.online/workbench/' },
  };
  const outcome = await startLarkScan({
    win,
    fetchImpl: async (url) => {
      seen.url = url;
      return { status: 200, json: async () => ({ success: true, appId: 'cli_x', timestamp: 123, nonceStr: 'n', signature: 's' }) };
    },
  });
  assert.deepEqual(outcome, { ok: true, target: '/s/66133-17' }, '扫到编号 ⇒ 直奔对应页面（不中转）');
  assert.ok(seen.url.startsWith(`${JSSDK_SIGNATURE_PATH}?url=`), '取签名的路径必须是配置里那一个');
  assert.ok(seen.url.includes(encodeURIComponent('https://hm.bamamei.online/workbench/')), 'url 参数 = 当前页');
  assert.deepEqual(Object.keys(seen.config).filter((k) => ['appId', 'timestamp', 'nonceStr', 'signature', 'jsApiList'].includes(k)).sort(),
    ['appId', 'jsApiList', 'nonceStr', 'signature', 'timestamp'], 'config 只吃签名四项 + jsApiList');
});

test('AC9 扫码失败 / 能力缺失 ⇒ scan_failed（**不白屏**：调用方会给一句人话）', async () => {
  const { startLarkScan, fallbackMessageFor } = await loadScanModule();
  const signatureOk = async () => ({ status: 200, json: async () => ({ success: true, appId: 'cli_x', timestamp: 1, nonceStr: 'n', signature: 's' }) });
  const base = { ready() {}, config(args) { args.onSuccess(); } };
  const failing = { ...base, location: { href: 'https://x/workbench/' }, biz: { util: { scanCard({ onFail }) { onFail(); } } } };
  const win1 = { ...failing, h5sdk: failing };
  assert.deepEqual(await startLarkScan({ win: win1, fetchImpl: signatureOk }), { ok: false, reason: 'scan_failed' });
  const win2 = { h5sdk: { ...base }, location: { href: 'https://x/workbench/' } };
  assert.deepEqual(await startLarkScan({ win: win2, fetchImpl: signatureOk }), { ok: false, reason: 'scan_failed' }, '没有 biz.util ⇒ scan_failed');
  for (const reason of ['not_in_lark', 'not_logged_in', 'signature_failed', 'scan_failed', 'unrecognized', '其它']) {
    assert.ok(fallbackMessageFor(reason).length > 6, `每个失败都要有一句人话（reason=${reason}）`);
  }
});
