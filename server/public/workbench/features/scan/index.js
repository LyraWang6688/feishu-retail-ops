/**
 * ⭐⭐ 「扫一扫」—— 工作台**一级 tab、放第一个**（业务负责人 2026-10-13 逐字裁定）：
 *   「我们现在的目标是把『**扫一扫**』功能**搬到工作台**，作为和**销售、采购、库存同级**的一个 tab，
 *    并且要**放在最前面**」
 *
 * 能力选 **A 方案**：**飞书原生扫码**（不用摄像头授权 ✓）。链路：
 *   ① 向**本站**取签名（`GET /api/workbench/lark/jsapi-signature?url=<当前页>`，**要登录** ✓）
 *   ② `window.h5sdk.config({ appId, timestamp, nonceStr, signature, jsApiList: ['scanCard'] })`
 *   ③ 调扫码 ⇒ 拿结果 ⇒ **取编号 / 记录 ID** ⇒ 直接跳对应页面（不中转 ✗）
 * ⚠️ 任何一步不行（不在飞书 / 未登录 / 签名失败 / 扫失败 / 认不出）⇒
 *    **明确人话 + 手输编号兜底** —— **不许白屏** ✗（有 AC 钉着 ✓）
 *
 * ⚠️ 本文件只负责"扫一扫"这一屏；**扫码页、验收、服务层一行都不碰** ✓
 */

/** 取签名的接口路径（与服务端 `config/jsapiSignature.js` 同一份口径 ✓） */
export const JSSDK_SIGNATURE_PATH = '/api/workbench/lark/jsapi-signature';

/** 扫一扫这一屏的 HTML（纯字符串 ⇒ 可直接单测；文案单一来源 = 本文件，不散落在 main.js ✓）。 */
export function scanPageHtml() {
  return `
    <div class="panel">
      <div class="card" data-view="scan-card">
        <button class="btn primary big" type="button" data-scan-start>打开飞书扫一扫</button>
        <p class="hint" data-scan-hint>对着鞋子标签上的二维码扫一下，就能直接进对应页面。</p>
        <p class="hint hidden" data-scan-unavailable>当前不在飞书里（或还没授权），扫码打不开 —— 在下面输入编号也一样能进。</p>
      </div>
      <form class="card" data-entry-form data-target-template="/s/{number}">
        <label class="hint" for="scan-manual-number">手输编号</label>
        <input id="scan-manual-number" name="number" type="text" inputmode="numeric" autocomplete="off" placeholder="例如 66133-17">
        <button class="btn" type="submit">打开</button>
      </form>
    </div>`;
}

/** 飞书原生扫码是否可用（H5 JSAPI）。**只判断可用性，不做任何签名** ✓ */
export function canUseLarkScan(win = globalThis.window || globalThis) {
  return Boolean(win && win.h5sdk && typeof win.h5sdk.ready === 'function');
}

/**
 * 把扫码结果变成要跳的路径（**不中转** ✗）：
 * · 二维码里的 `…/r/{recordId}` ⇒ `/r/{recordId}`（她 2026-10-12 定的"记录 ID"口径 ✓）
 * · 纯编号（`66133-17` / `66133`）⇒ `/s/{编号}`（既有扫码页路径 ✓）
 * · 认不出 ⇒ `null`（调用方给人话 + 手输兜底，**不猜** ✗）
 */
export function extractScanTarget(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const record = text.match(/\/r\/([A-Za-z0-9_-]+)/);
  if (record) return `/r/${record[1]}`;
  const number = text.match(/(\d{3,}-\d+|\d{3,})/);
  if (number) return `/s/${number[1]}`;
  return null;
}

/** 每种失败给一句人话（**白屏 = 不允许** ✗）—— 由 `createScanModule` 显示 ✓ */
export function fallbackMessageFor(reason) {
  switch (reason) {
    case 'not_in_lark': return '当前不在飞书里，扫码打不开 —— 在下面输入编号也一样能进。';
    case 'not_logged_in': return '还没登录工作台，先登录再扫码；也可以直接在下面输入编号。';
    case 'signature_failed': return '扫码能力还在接入（签名没取到）—— 先用下面手输编号，一样能进。';
    case 'scan_failed': return '这次没扫上，再点一次试试；也可以直接在下面输入编号。';
    case 'unrecognized': return '没认出来这是哪件货品，麻烦确认二维码或直接输入编号。';
    default: return '扫码暂时用不了 —— 在下面输入编号也一样能进。';
  }
}

/**
 * 走一次原生扫码（**一切可注入 ⇒ 零网络可测** ✓）。
 * @returns `{ ok: true, target }` 或 `{ ok: false, reason }`（reason 见 `fallbackMessageFor`）
 */
export async function startLarkScan({ win = globalThis.window || globalThis, fetchImpl = globalThis.fetch } = {}) {
  if (!canUseLarkScan(win)) return { ok: false, reason: 'not_in_lark' };
  let payload;
  try {
    const response = await fetchImpl(`${JSSDK_SIGNATURE_PATH}?url=${encodeURIComponent(win.location.href)}`);
    if (response.status === 401) return { ok: false, reason: 'not_logged_in' };
    payload = await response.json();
  } catch {
    return { ok: false, reason: 'signature_failed' };
  }
  if (!payload?.success) return { ok: false, reason: payload?.auth_required ? 'not_logged_in' : 'signature_failed' };

  const configured = await new Promise((resolve) => {
    win.h5sdk.config({
      appId: payload.appId,
      timestamp: payload.timestamp,
      nonceStr: payload.nonceStr,
      signature: payload.signature,
      jsApiList: ['scanCard'],
      onSuccess: () => resolve(true),
      onFail: () => resolve(false),
    });
  });
  if (!configured) return { ok: false, reason: 'signature_failed' };
  if (!win.h5sdk.biz?.util?.scanCard) return { ok: false, reason: 'scan_failed' };

  const scanned = await new Promise((resolve) => {
    win.h5sdk.biz.util.scanCard({
      onSuccess: (result) => resolve({ ok: true, raw: result?.result ?? result?.code ?? '' }),
      onFail: () => resolve({ ok: false, reason: 'scan_failed' }),
    });
  });
  if (!scanned.ok) return scanned;
  const target = extractScanTarget(scanned.raw);
  return target ? { ok: true, target } : { ok: false, reason: 'unrecognized' };
}

/** 挂载「扫一扫」：点按钮 ⇒ 原生扫码 ⇒ 跳到对应页面；任何失败 ⇒ 人话 + 手输兜底（**不白屏** ✓） */
export function createScanModule() {
  return {
    mount(container) {
      container.innerHTML = scanPageHtml();
      const hint = container.querySelector('[data-scan-unavailable]');
      const showHint = (reason) => {
        if (!hint) return;
        hint.textContent = fallbackMessageFor(reason);
        hint.classList.remove('hidden');
      };
      container.querySelector('[data-scan-start]')?.addEventListener('click', async () => {
        const outcome = await startLarkScan();
        if (outcome.ok) return void globalThis.window.location.assign(outcome.target);
        return showHint(outcome.reason);
      });
    },
  };
}
