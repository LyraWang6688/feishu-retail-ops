/**
 * ⭐⭐ **task-61 · ② 领域内扫一扫**的**客户端那一段**运行时判据（**先写后做** ✓）。
 *
 * 为什么值得单独一个文件：这一段是整条链里**只有真机才碰得到**的那半（相机 / JSSDK / 跳转）——
 *   本机跑不了真机 ⇒ 用**假 DOM + 假 window** 把 `views/scanRealmScan.js` 产出的那段脚本
 *   **真跑一遍**（`node:vm` ✓ 不是"读源码猜" ✗），把三件事钉死：
 *
 *  **AC-ML9a** 不是"加货刚回来那一发"（`data-scan-now` ≠ `1`）⇒ **什么都不做**
 *              （不载 SDK、不弹相机、不跳走 ✗ —— 她没点就跳是最糟的 ✓）
 *  **AC-ML9b** 调不起来扫一扫（没有 `h5sdk` / 没有 `tt.scanCode`）⇒ **给人话** 且 **绝不跳**
 *              （"点了没反应"是她最恨的 ✗）
 *  **AC-ML9c** ⭐ 扫到了 ⇒ 跳到**那一件**的地址 **并带上当前领域**（退货里扫 ⇒ 落回退货 ✓）
 *              ＋ 关着 / 空结果 / 认不出的结果 ⇒ **不跳**
 *  **AC-ML9d** 签名只从**服务端端点**要（页面不掺密钥 ✓）＋ 上报**只读**（`ok/realm/reason` ✓）
 *
 * 🔴 依据：业务负责人 2026-10-16 14:32 / 14:38 逐字（见 `task-61` / `config/realmScan.js` 文件头）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_realm_scan_client';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_realm_scan_client_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_client';

const { createRealmScanConfig } = require('../src/config/realmScan');
const { realmScanScriptSource } = require('../src/views/scanRealmScan');
const { SCAN_PAGE } = require('../src/config/scanPage');

const CONFIG = createRealmScanConfig({
  SCAN_REALM_SCAN_ENABLED: 'true',
  SCAN_REALM_SCAN_SDK_TIMEOUT_MS: '2000',
  SCAN_REALM_SCAN_TIMEOUT_MS: '5000',
});

/** 一份最小配置块（形状与 `views/scanRealmScan.js` 读的那一份**逐字同源** ✓ 不各写一份 ✗）。 */
const configOf = ({ realm = 'purchase_return', scanNow = true } = {}) => ({
  realm,
  origin: 'https://hm.bamamei.online',
  realmQueryKey: CONFIG.realmQueryKey,
  recordBasePath: CONFIG.recordBasePath,
  maxScannedLength: CONFIG.maxScannedLength,
  signaturePath: CONFIG.signaturePath,
  reportPath: CONFIG.signaturePath.replace(/[^/]+$/, 'scan-report'),
  sdkTimeoutMs: CONFIG.sdkTimeoutMs,
  scanTimeoutMs: CONFIG.scanTimeoutMs,
  texts: CONFIG.texts,
  scanNow,
});

/**
 * 假 DOM / 假 window（**只这一份**，两个用例共用 ✓）。
 * `scanResult` = `tt.scanCode` 的 success 入参；`scanFail` = fail 入参。
 */
const runScript = async ({
  config = configOf(),
  hasH5sdk = true,
  scanResult = { result: 'https://hm.bamamei.online/r/rec_K2' },
  scanFail = null,
  signatureOk = true,
} = {}) => {
  const state = { navigated: null, notices: [], sdkRequests: [], reports: [], signatureCalls: [] };
  const attributes = {
    'data-scan-now': config.scanNow ? '1' : '0',
    'data-config': JSON.stringify(config),
  };
  const host = {
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
  };
  const noticeLine = { set textContent(value) { state.notices.push(String(value)); }, get textContent() { return ''; } };
  const timers = [];
  const win = {
    location: { href: 'https://hm.bamamei.online/r/rec_K1?from=purchase_return&scan=1' },
    navigator: { sendBeacon: (path, blob) => { state.reports.push({ path, body: String(blob && blob.__text) }); return true; } },
    fetch: async (url, options = {}) => {
      if (String(url).indexOf('scan-report') >= 0) {
        state.reports.push({ path: String(url), body: String(options.body || '') });
        return { ok: true, json: async () => ({ success: true }) };
      }
      state.signatureCalls.push(String(url));
      if (!signatureOk) return { ok: false, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          appId: 'cli_fake', timestamp: 1, nonceStr: 'n', signature: 's',
          jssdkUrl: 'https://cdn.example/jssdk.js', jsApiList: ['scanCode'],
        }),
      };
    },
  };
  if (hasH5sdk) {
    win.h5sdk = {
      config: (options) => { state.sdkRequests.push(options); return undefined; },
      ready: (callback) => { callback(); },
    };
    win.tt = {
      scanCode: (options) => {
        if (scanFail) { options.fail(scanFail); return; }
        options.success(scanResult);
      },
    };
  }
  const document = {
    querySelector: (selector) => {
      if (selector === '[data-view="realm-scan-config"]') return host;
      if (selector === '[data-view="realm-scan-notice"]') return noticeLine;
      return null;
    },
    createElement: () => ({ set src(value) { state.sdkLoaded = value; }, onload: null, onerror: null }),
    head: {
      append: (element) => {
        if (element && element.onload) element.onload();
        else if (element && element.onerror) element.onerror();
      },
    },
  };
  const sandbox = {
    window: win,
    document,
    // 页面里那两样是**全局**（不是 `window.` 前缀）—— 与真实浏览器一致 ✓
    navigator: win.navigator,
    fetch: win.fetch,
    Blob: class { constructor(parts) { this.__text = String((parts && parts[0]) || ''); } },
    Promise,
    JSON,
    String,
    Number,
    encodeURIComponent,
    setTimeout: (fn, ms) => { const id = timers.push(fn); return id; },
    clearTimeout: () => {},
    console,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(realmScanScriptSource(), sandbox, { timeout: 5000 });
  // 画面里那一段是 fire-and-forget 的 Promise 链 ⇒ 让它跑完（微任务队列清空 ✓ 不等真网络 ✗）
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  return { state, win };

};

test('AC-ML9a ⭐ 不是"加货刚回来那一发" ⇒ **什么都不做**（不弹相机、不跳、不载 SDK）', async () => {
  const { state, win } = await runScript({ config: configOf({ scanNow: false }) });
  assert.deepEqual(state.sdkRequests, [], 'SDK 一次都不配（她没点 ⇒ 不许弹 ✗）');
  assert.deepEqual(state.signatureCalls, [], '签名一次都不要（零远端调用 ✓）');
  assert.deepEqual(state.reports, [], '连上报都没有（这一段压根不启动 ✓ 零噪音 ✓）');
  assert.equal(win.location.href, 'https://hm.bamamei.online/r/rec_K1?from=purchase_return&scan=1',
    'URL 一个字没动 ✓');
});

test('AC-ML9b 🔴 调不起扫一扫（这台设备没有 `h5sdk` / `tt.scanCode`）⇒ **给人话** 且 **绝不跳**', async () => {
  const { state, win } = await runScript({ hasH5sdk: false });
  assert.ok(state.notices.length >= 1, '必须有人话（"点了没反应"是她最恨的 ✗）');
  assert.equal(state.notices[state.notices.length - 1], CONFIG.texts.noSdk, '人话走配置 ✓');
  assert.equal(win.location.href, 'https://hm.bamamei.online/r/rec_K1?from=purchase_return&scan=1',
    '🔴 调不起来 ⇒ **不许**把她跳走（留在原页 ✓）');
  const report = state.reports[state.reports.length - 1];
  assert.ok(report, '失败也要**只读上报**一条（手机上她看不到控制台 ⇒ 日志是唯一线索 ✓）');
  const payload = JSON.parse(report.body);
  assert.equal(payload.ok, false, '如实说失败 ✓（绝不假装成功 ✗）');
});

test('AC-ML9c ⭐⭐⭐ 扫到了 ⇒ 跳到那一件 **并带上当前领域**（退货里扫 ⇒ 落回退货 ✓）', async () => {
  const { state, win } = await runScript({
    config: configOf({ realm: 'purchase_return' }),
    scanResult: { result: 'https://hm.bamamei.online/r/rec_K2?job=x' },
  });
  assert.equal(win.location.href, 'https://hm.bamamei.online/r/rec_K2?job=x&from=purchase_return',
    '🔴 扫到的那一件 + **当前领域**（她 14:32 逐字："扫完之后，就是直接放到退货里面的货品" ✓）');
  assert.equal(state.sdkRequests.length, 1, 'SDK 配置恰好一次 ✓');
  const payload = JSON.parse(state.reports[state.reports.length - 1].body);
  assert.equal(payload.ok, true);
  assert.equal(payload.realm, 'purchase_return', '上报里带领域（排查时按它 grep ✓）');

  // 补货里扫 ⇒ 落点换成补货（**领域不同 ⇒ 落点不同** ✓ 这就是"与全局扫一扫不同" ✓）
  const replenish = await runScript({
    config: configOf({ realm: 'replenish' }),
    scanResult: { result: 'https://hm.bamamei.online/r/rec_K2' },
  });
  assert.equal(replenish.win.location.href, 'https://hm.bamamei.online/r/rec_K2?from=replenish');

  // 扫到的是**记录 ID**（不是完整网址）⇒ 用配置里那一段路径在本页域名下拼 ✓
  const byId = await runScript({
    config: configOf({ realm: 'purchase_return' }),
    scanResult: { result: 'rec_K2' },
  });
  assert.equal(byId.win.location.href, 'https://hm.bamamei.online/r/rec_K2?from=purchase_return',
    '扫到 id ⇒ 同源 `/r/{id}` ＋领域 ✓');
});

test('AC-ML9d 🔴 空结果 / 认不出的结果 / 取消 ⇒ **不跳**，且如实上报（不假装成功 ✗）', async () => {
  // ① 扫到空串
  const empty = await runScript({ scanResult: { result: '' } });
  assert.equal(empty.win.location.href, 'https://hm.bamamei.online/r/rec_K1?from=purchase_return&scan=1',
    '🔴 空结果 ⇒ 不跳（留在原页 ✓）');
  assert.equal(JSON.parse(empty.state.reports[empty.state.reports.length - 1].body).ok, false);
  assert.equal(empty.state.notices[empty.state.notices.length - 1], CONFIG.texts.empty, '给人话 ✓');

  // ② 扫到认不出的怪串（不是网址、也不是 id）
  const weird = await runScript({ scanResult: { result: 'rec K2 ???' } });
  assert.equal(weird.win.location.href, 'https://hm.bamamei.online/r/rec_K1?from=purchase_return&scan=1',
    '🔴 认不出 ⇒ **不许乱跳**（宁可不动 ✓）');

  // ③ 她自己取消 ⇒ 说"取消了"，**不是错误**（也别跳 ✓）
  const cancelled = await runScript({ scanFail: { errMsg: 'scanCode:fail cancel' } });
  assert.equal(cancelled.win.location.href, 'https://hm.bamamei.online/r/rec_K1?from=purchase_return&scan=1');
  assert.equal(cancelled.state.notices[cancelled.state.notices.length - 1], CONFIG.texts.cancelled,
    '"取消"与"真失败"要分得开 ✓');
});

test('AC-ML9e 🔴 页面**不掺任何密钥**：签名只从服务端端点要（响应里那四样 ✓）', async () => {
  const { state } = await runScript({});
  assert.equal(state.signatureCalls.length, 1, '签名恰好要一次 ✓');
  // ⚠️ 不做"手工转义再拼正则"（CodeQL 的 `js/incomplete-sanitization` 会红 ✗）——
  //    直接把那个端点当**字面量子串**判就够（它本来就是 `/lark/jsapi-signature` ✓）。
  const endpoint = state.signatureCalls[0].split('?')[0];
  assert.equal(endpoint, CONFIG.signaturePath,
    '🔴 走的是配置里那个端点（`config.realmScan.signaturePath` ✓ 不写死 ✗）');
  assert.equal(state.signatureCalls[0].indexOf('?url=') >= 0, true, '签名要带页面地址（官方要求逐字一致 ✓）');
  // 🔴 配置块（页面上的 JSON）里**不许**出现 ticket / secret / token 这类东西
  const blob = JSON.stringify(configOf());
  for (const forbidden of ['secret', 'ticket', 'tenant_access_token', 'appSecret']) {
    assert.equal(blob.includes(forbidden), false, `🔴 页面上不许带 ${forbidden} ✗`);
  }
  // 🔴 那一段脚本正文**只有 ASCII**（零硬编码中文 ✓ 中文一律走配置 ✓）
  assert.equal(/[^\x00-\x7F]/.test(realmScanScriptSource()), false, '脚本正文只有 ASCII ✓');
  // ⚠️ 全局那颗「扫一扫」的 AppLink 一个字没动（本刀不碰它 ✓）
  assert.equal(SCAN_PAGE.scanNext.applink, 'https://applink.feishu.cn/client/qrcode/main');
});
