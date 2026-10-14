export class ApiError extends Error {
  constructor(message, { status = 0, requestId = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
  }
}

/**
 * ⭐⭐ 2026-10-14 晚（埋点 P0 ②）：**页面最近一次点击**的 `tap_id` + 该带的字段名。
 * 两者都从**同一份**客户端实现（`shared/ui-tap.js`，工作台与扫码页共用）读 ——
 * ⚠️ 本文件**只读**它、**不自己生成**、也**不 import** 别处（生成规则与字段名都只有一处 ✓；
 *    服务端那份 `config/uiTap.js` 由用例钉住两边一致）。
 * ⚠️ 这条 import 一个兄弟配置都会被测试里的"把本文件拷进临时目录"的夹具打断 ✗（踩过）。
 */
function currentTap() {
  const reporter = typeof window === 'undefined' ? null : window.dshUiTap;
  if (!reporter || typeof reporter.currentTapId !== 'function') return { tapId: '', field: '' };
  return {
    tapId: String(reporter.currentTapId() || ''),
    field: String(reporter.formField || ''),
  };
}

async function request(path, options = {}) {
  const method = options.method || 'GET';
  const url = new URL(path, window.location.origin);
  if (method === 'GET') url.searchParams.set('_', Date.now());
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    throw new ApiError(body.error || `请求失败（${response.status}）`, {
      status: response.status,
      requestId: response.headers.get('x-request-id') || '',
    });
  }
  return body;
}

export const api = {
  get(path) { return request(path); },
  post(path, body) {
    // ⭐⭐ 2026-10-14 晚（埋点 P0 ②）：把"这次写请求是哪一次点击引起的"带上 ——
    //   服务端（`utils/uiTapReport.js` 的 `uiTapResultMiddleware`）据此记一条
    //   `ui.tap.result`（状态 + 原因码 + 耗时）。
    //   ⚠️ **只在"刚点过一下"时加**这一个键；没有点击（别的调用方 / 定时刷新）⇒ 一个键都不多 ✓
    //     ⇒ 既有调用方与既有请求体形状零影响。
    //   🔴 只带**我们的标识**（tap_id），**绝不带**表单值 / 金额 / 个人信息 ✗。
    const tap = currentTap();
    const payload = tap.tapId && tap.field
      ? { ...(body || {}), [tap.field]: tap.tapId }
      : (body || {});
    return request(path, { method: 'POST', body: JSON.stringify(payload) });
  },
};
