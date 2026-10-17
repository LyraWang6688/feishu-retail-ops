'use strict';

/**
 * ⭐⭐ **领域内扫一扫**的客户端那一段（业务负责人 2026-10-16 14:32 / 14:38 逐字；口径见
 *   `config/realmScan.js` 的文件头）。
 *
 * 这一段做的事**只有一件**：领域页上"点完了接着扫"那一发 ——
 *   `config.realms[realm]` 在 ⇒ 挂一个 `/realm-scan?from=<领域>` 的扫一扫，
 *   扫到之后**把那一件交给本领域**（导航到它 **并带上 `?from=<领域>`** ✓）。
 *
 * 🔴 **四个不许**（每一条都有对应的判据）：
 *   ① **不许新增第二段脚本** ✗ —— 本模块只产出**文本**，由 `views/scanPageRenderer.js` 内联进
 *      **既有那一段** `<script data-view="submit-feedback">`（`AC-6R5` 数的是**业务脚本段数** ✓）；
 *   ② **不许散写中文** ✗ —— 全部人话来自服务端下发的**配置 JSON**（`options.texts`），
 *      本模块正文**只有 ASCII**（既有硬编码中文闸门与 `AC-ML7` 都盯这一条 ✓）；
 *   ③ **不许把密钥写进页面** ✗ —— 签名只从 `signaturePath` 拿（服务端用法务凭证现算 ✓
 *      页面拿到的只有 `appId/timestamp/nonceStr/signature` ✓）；
 *   ④ **每一个等待都要有超时** ✗ —— `h5sdk` 在真机上"装死"是实测过的（工作台那条链的教训）；
 *      超时一律**给人话**，绝不留一个点了没反应的按钮 ✓。
 *
 * ⚠️ 这一段**不是新造**：`tt.scanCode` 那一条链（`h5sdk.config` ⇒ `ready` ⇒ `tt.scanCode`）
 *   与工作台「扫码打印」**同一套飞书 JSAPI**（`services/larkJsapiService.js` + 页面里 `public/workbench/
 *   features/labels/scan-print.js` 的同一条链 ✓）；这里只把"扫完去哪儿"换成**本领域** ✓。
 */

/** 只 ASCII —— 这一段会被原样内联进页面（中文一律走配置 JSON ✓）。 */
const REALM_SCAN_SOURCE = `
(function () {
  var host = document.querySelector('[data-view="realm-scan-config"]');
  if (!host) return;
  // Not requested on this page load: do nothing at all (no SDK load, no camera).
  if (host.getAttribute('data-scan-now') !== '1') return;
  var config = {};
  try { config = JSON.parse(host.getAttribute('data-config') || '{}'); } catch (error) { return; }
  var texts = config.texts || {};
  var win = window;
  var write = function (message) {
    var line = document.querySelector('[data-view="realm-scan-notice"]');
    if (line && message) line.textContent = String(message);
  };
  var withTimeout = function (promise, ms, code) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error(code)); }, ms);
      promise.then(function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); });
    });
  };
  var loadSdk = function (url) {
    return new Promise(function (resolve, reject) {
      if (win.h5sdk) return resolve();
      if (!url) return reject(new Error('jssdk_missing'));
      var script = document.createElement('script');
      script.src = String(url);
      script.onload = function () { resolve(); };
      script.onerror = function () { reject(new Error('jssdk_load_failed')); };
      document.head.append(script);
      return undefined;
    });
  };
  var report = function (payload, ok) {
    try {
      var body = JSON.stringify(payload);
      if (win.navigator && typeof win.navigator.sendBeacon === 'function') {
        win.navigator.sendBeacon(config.reportPath, new Blob([body], { type: 'application/json' }));
        return;
      }
      if (typeof win.fetch === 'function') {
        win.fetch(config.reportPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
        });
        return;
      }
      if (!ok) write(texts.reportFailed);
    } catch (error) {
      if (!ok) write(texts.reportFailed);
    }
  };
  var scanOnce = function (signature) {
    return withTimeout(loadSdk(signature && signature.jssdkUrl), config.sdkTimeoutMs, 'jssdk_timeout')
      .then(function () {
        if (!win.h5sdk || typeof win.h5sdk.config !== 'function') throw new Error('jssdk_missing');
        return withTimeout(Promise.resolve(win.h5sdk.config({
          appId: signature.appId,
          timestamp: signature.timestamp,
          nonceStr: signature.nonceStr,
          signature: signature.signature,
          jsApiList: (signature.jsApiList || ['scanCode']),
        })), config.sdkTimeoutMs, 'config_timeout');
      })
      .then(function () {
        return withTimeout(new Promise(function (resolve) {
          win.h5sdk.ready(resolve);
        }), config.sdkTimeoutMs, 'ready_timeout');
      })
      .then(function () {
        return withTimeout(new Promise(function (resolve, reject) {
          if (!win.tt || typeof win.tt.scanCode !== 'function') return reject(new Error('scan_unsupported'));
          return win.tt.scanCode({ scanType: ['qrCode'], success: resolve, fail: reject });
        }), config.scanTimeoutMs, 'scan_timeout');
      });
  };
  // Same rules as the server-side builder (config/realmScan.js realmScanUrlFor), inlined here:
  //   full URL  -> append/overwrite the realm query key only (path untouched)
  //   id/number -> origin + configured record path + the id
  //   anything else -> no navigation at all (never guess where to go)
  var destinationFor = function (scanned) {
    var raw = String(scanned || '').slice(0, Number(config.maxScannedLength) || 512);
    if (!raw) return '';
    var key = String(config.realmQueryKey || 'from');
    // 2026-10-17: appendRealm=false (returnsToRealm=false) => do not append from=realm
    var appendRealm = config.appendRealm !== false;
    var withRealm = function (url) {
      var text = String(url || '');
      if (!text) return '';
      if (!appendRealm) return text;
      var hashAt = text.indexOf('#');
      var head = hashAt >= 0 ? text.slice(0, hashAt) : text;
      var hash = hashAt >= 0 ? text.slice(hashAt) : '';
      var queryAt = head.indexOf('?');
      var base = queryAt >= 0 ? head.slice(0, queryAt) : head;
      var pairs = (queryAt >= 0 ? head.slice(queryAt + 1) : '').split('&').filter(function (part) {
        return part && part.split('=')[0] !== key;
      });
      pairs.push(key + '=' + encodeURIComponent(String(config.realm || '')));
      return base + '?' + pairs.join('&') + hash;
    };
    // Plain string test (no regex inside this template: a backslash here would be eaten).
    if (raw.indexOf('http://') === 0 || raw.indexOf('https://') === 0) return withRealm(raw);
    // Plain string trimming (no regex here: a backslash inside this template would be eaten).
    var trimEnd = function (text) {
      var out = String(text || '');
      while (out.length && out.charAt(out.length - 1) === '/') out = out.slice(0, -1);
      return out;
    };
    var trimStart = function (text) {
      var out = String(text || '');
      while (out.length && out.charAt(0) === '/') out = out.slice(1);
      return out;
    };
    var mount = trimEnd(config.recordBasePath);
    var origin = trimEnd(config.origin);
    var id = trimStart(raw);
    if (!mount || !origin || !id || id.indexOf('?') >= 0 || id.indexOf('#') >= 0
      || /\s/.test(id)) return '';
    var landed = origin + mount + '/' + encodeURIComponent(id);
    return appendRealm ? withRealm(landed) : landed;
  };
  var run = function () {
    write(texts.scanning);
    // The signature must cover the page we finally land on (official: the url must match exactly).
    // We cannot know it before scanning, so we sign THIS page (it is an allowed host too) and only
    // then navigate; the h5sdk config is already applied by the time scanCode returns.
    var pageUrl = String(win.location.href || '').split('#')[0];
    return win.fetch(config.signaturePath + '?url=' + encodeURIComponent(pageUrl), { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('signature_failed');
        return response.json();
      })
      .then(function (signature) { return scanOnce(signature); })
      .then(function (result) {
        var scanned = String((result && result.result) || '').trim();
        if (!scanned) {
          write(texts.empty);
          report({ ok: false, reason: 'empty' }, false);
          return null;
        }
        var finalUrl = destinationFor(scanned);
        if (!finalUrl) {
          write(texts.empty);
          report({ ok: false, reason: 'unrecognized', scanned: scanned }, false);
          return null;
        }
        report({ ok: true, realm: config.realm, scanned: scanned }, true);
        win.location.href = finalUrl;
        return null;
      })
      .catch(function (error) {
        var code = String((error && error.message) || '');
        var errMsg = String((error && error.errMsg) || '');
        report({ ok: false, realm: config.realm, reason: code || 'failed', err_msg: errMsg }, false);
        if (code === 'jssdk_missing' || code === 'jssdk_load_failed' || code === 'scan_unsupported') {
          write(texts.noSdk);
          return null;
        }
        if (code === 'scan_timeout' || code === 'jssdk_timeout' || code === 'config_timeout'
          || code === 'ready_timeout') {
          write(texts.timeout);
          return null;
        }
        write(/cancel/i.test(errMsg) ? texts.cancelled : texts.failed);
        return null;
      });
  };
  run();
}());
`;

/**
 * 内联用那一段（**一个字节都不加包装**：调用方负责放进它那一段 `<script>` 里 ✓）。
 * @returns {string} 只含 ASCII 的 JS 源（无 `<script>` 标签 ✓）
 */
const realmScanScriptSource = () => REALM_SCAN_SOURCE;

/**
 * 「配置块」—— 把**服务端算好的**配置 JSON 交给那一段脚本读。
 * 🔴 **它只在开关开着、且这一页真有领域扫一扫时渲染**（关着 ⇒ 空串 ⇒ 页面逐字节不变 ✓）。
 * 🔴 `data-scan-now` 由路由决定（**只有加货成功 303 回来那一发是 `1`** ✓）——
 *    页面一加载就弹相机那种坑（乱弹 / 她没点就跳）从这里堵死 ✗。
 * ⚠️ 全部值都在**属性**里（HTML 转义过 ✓），脚本只读不写 ⇒ 不采集表单值、不落任何隐私 ✗。
 */
const realmScanConfigHtml = ({ configJson = '', scanNow = false, notice = '' } = {}) => {
  if (!configJson) return '';
  return `<div class="realm-scan" data-view="realm-scan-config" data-scan-now="${scanNow ? '1' : '0'}"`
    + ` data-config="${configJson}" hidden></div>`
    + `<p class="hint" data-view="realm-scan-notice">${notice}</p>`;
};

module.exports = { realmScanScriptSource, realmScanConfigHtml };
