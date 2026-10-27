/**
 * ⭐ 工作台「领域录单」卡片：点一下 ⇒ 飞书 JSAPI 扫一扫 ⇒ 带领域参数落到扫码页。
 *
 * 依据（2026-10-27）：扫一扫按业务拆开，不再有全局扫一扫；从销售进来只显示销售，
 * 从补货/退货/库存进来只显示对应领域。底层仍然复用既有 JSAPI 签名与扫码页 `?from=`。
 *
 * 边界：
 *   · 不新开业务接口：签名走既有 `/api/workbench/lark/jsapi-signature`；
 *   · 不重写扫码页：扫到后只负责跳 `/r/{id}?from=<realm>`（或保留完整 URL 并替换 from）；
 *   · 相机只能由飞书 h5sdk 提供：Chrome / PC 没有 h5sdk 时给明确人话，不静默。
 */
import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';

export const SCAN_SIGNATURE_PATH = '/api/workbench/lark/jsapi-signature';

const DEFAULT_TIMEOUT_MS = 8000;
const SCAN_TIMEOUT_MS = 120000;

const withTimeout = (promise, ms, code) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(code)), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

const loadSdk = (url) => new Promise((resolve, reject) => {
  if (window.h5sdk) return resolve();
  if (!url) return reject(new Error('jssdk_missing'));
  const script = document.createElement('script');
  script.src = String(url);
  script.onload = () => resolve();
  script.onerror = () => reject(new Error('jssdk_load_failed'));
  document.head.append(script);
  return undefined;
});

const withRealm = (url, realm) => {
  try {
    const parsed = new URL(url, window.location.origin);
    parsed.searchParams.set('from', realm);
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return '';
  }
};

/** 扫到的内容 → 落点；认不出就返回空串（不猜）。 */
export const scanTargetUrl = (scanned, realm, origin = window.location.origin) => {
  const raw = String(scanned || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      url.searchParams.set('from', realm);
      return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : url.toString();
    } catch { return ''; }
  }
  if (raw.startsWith('/')) return withRealm(raw, realm);
  if (/[\s?#]/.test(raw)) return '';
  return `/r/${encodeURIComponent(raw)}?from=${encodeURIComponent(realm)}`;
};

const cardsHtml = (cards = []) => cards.map((card) => {
  const body = `<span class="entry-card-icon">${escapeHtml(card.icon || '')}</span>
      <span class="entry-card-body"><strong>${escapeHtml(card.title || '')}</strong></span>`;
  if (card.disabled) {
    return `<div class="entry-card disabled-card" aria-disabled="true" data-scan-disabled="true">${body}</div>`;
  }
  if (card.jumpTo) {
    return `<button class="entry-card card-button" type="button" data-jump="${escapeHtml(card.jumpTo)}" data-tap-target="${escapeHtml('jump:' + card.jumpTo)}">${body}</button>`;
  }
  if (card.scanRealm) {
    return `<button class="entry-card card-button" type="button" data-scan-realm="${escapeHtml(card.scanRealm)}" data-tap-target="${escapeHtml('scan:' + card.scanRealm)}">${body}</button>`;
  }
  return `<a class="entry-card" href="${escapeHtml(card.href || '')}" rel="noopener" data-tap-target="${escapeHtml('link:' + (card.title || ''))}">${body}</a>`;
}).join('\n');

export const scanCardsPageHtml = (page = {}) => `
  <div class="domain-page" data-page-kind="scan-cards">
    <div class="domain-cards">${cardsHtml(page.cards || [])}</div>
    <p class="hint" data-view="scan-launch-notice" role="status" aria-live="polite"></p>
  </div>`;

export function createScanCardsModule(page = {}) {
  let scanNow = null;
  const texts = {
    noSdk: '这台设备调不起飞书扫一扫：请在飞书里打开工作台再试一次。',
    failed: '扫码没有成功，请再试一次。',
    timeout: '飞书扫一扫没响应（超时了）：请退出这一页重进再试一次。',
    empty: '没有扫到内容，请对着货品二维码再扫一次。',
    ...(page.texts || {}),
  };
  return {
    mount(container) {
      if (!container) return;
      container.innerHTML = scanCardsPageHtml(page);
      const notice = container.querySelector('[data-view="scan-launch-notice"]');
      let noticeTimer = null;
      // 扫描中的状态保持；取消/失败/超时只短暂提示，避免一行提示长期占着页面。
      const show = (text, autoHideMs = 0) => {
        if (!notice) return;
        if (noticeTimer) clearTimeout(noticeTimer);
        notice.textContent = String(text || '');
        if (autoHideMs > 0) {
          noticeTimer = setTimeout(() => { notice.textContent = ''; noticeTimer = null; }, autoHideMs);
        }
      };
      let busy = false;

      const scan = async (realm) => {
        if (busy) return;
        busy = true;
        try {
          const signature = await api.get(`${SCAN_SIGNATURE_PATH}?url=${encodeURIComponent(window.location.href.split('#')[0])}`);
          await withTimeout(loadSdk(signature?.jssdkUrl || ''), DEFAULT_TIMEOUT_MS, 'jssdk_timeout');
          if (!window.h5sdk || typeof window.h5sdk.config !== 'function') throw new Error('jssdk_missing');
          await withTimeout(window.h5sdk.config({
            appId: signature.appId,
            timestamp: signature.timestamp,
            nonceStr: signature.nonceStr,
            signature: signature.signature,
            jsApiList: Array.isArray(signature.jsApiList) && signature.jsApiList.length
              ? signature.jsApiList : ['scanCode'],
          }), DEFAULT_TIMEOUT_MS, 'config_timeout');
          await withTimeout(new Promise((resolve) => window.h5sdk.ready(resolve)), DEFAULT_TIMEOUT_MS, 'ready_timeout');
          const result = await withTimeout(new Promise((resolve, reject) => {
            if (!window.tt || typeof window.tt.scanCode !== 'function') return reject(new Error('scan_unsupported'));
            return window.tt.scanCode({ scanType: ['qrCode'], success: resolve, fail: reject });
          }), SCAN_TIMEOUT_MS, 'scan_timeout');
          const target = scanTargetUrl(result?.result, realm);
          if (!target) { show(texts.empty, 4000); return; }
          window.location.href = target;
        } catch (error) {
          const code = String(error?.message || '');
          if (code === 'jssdk_missing' || code === 'jssdk_load_failed' || code === 'scan_unsupported') show(texts.noSdk, 6000);
          else if (code === 'scan_timeout' || code === 'jssdk_timeout' || code === 'config_timeout' || code === 'ready_timeout') show(texts.timeout, 6000);
          else if (/cancel/i.test(String(error?.errMsg || ''))) { /* 用户取消：不提示，直接回到页面 */ }
          else show(texts.failed, 4000);
        } finally {
          busy = false;
        }
      };

      scanNow = () => { if (page.scanRealm) void scan(page.scanRealm); };
      container.querySelectorAll('[data-scan-realm]').forEach((button) => {
        button.addEventListener('click', () => { void scan(button.dataset.scanRealm); });
      });
    },
    scanNow: () => { if (scanNow) scanNow(); },
  };
}
