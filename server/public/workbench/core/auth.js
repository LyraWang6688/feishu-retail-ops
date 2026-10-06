import { api } from './api-client.js';

// 飞书登录入口。`return_to` 带上当前页（含查询串），登录完回到这里。
export const feishuLoginUrl = () =>
  `/api/auth/feishu/start?return_to=${encodeURIComponent(location.pathname + location.search)}`;

/**
 * 「去登录」按钮。
 *
 * ⚠️ 401 时**首选自动跳转**（见下），这个按钮是**兜底**：
 *    自动跳转被打断（登录页打不开、脚本在一个不支持跳转的承载里跑）、
 *    或返回的是 403（当前飞书账号未被授权，换一个账号登录才有意义）时，
 *    页面上至少有一个能点的入口 —— 而不是只甩一句「工作台启动失败：请求失败（401）」
 *    加三个点了没反应的 tab。
 */
export function showLoginButton() {
  if (document.getElementById('go-login')) return null;
  const button = document.createElement('button');
  button.id = 'go-login';
  button.type = 'button';
  button.className = 'btn';
  button.textContent = '去登录';
  button.addEventListener('click', () => { window.location.href = feishuLoginUrl(); });
  const status = document.getElementById('auth-status');
  if (status?.after) status.after(button);
  else document.body.prepend(button);
  return button;
}

export async function requireFeishuAuth({ statusElement, logoutButton }) {
  let body;
  try {
    body = await api.get('/api/auth/feishu/me');
  } catch (error) {
    // ⚠️ 401 = 认证**已启用**、但这次请求没带 session（登录过期 / 直接打开链接）。
    //    `/me` 在 401 时其实带了 `auth_required`，但 api-client 把非 2xx 一律抛成
    //    ApiError，所以原来那句 `if (!body.authenticated)` 永远走不到 ——
    //    页面只显示「工作台启动失败：请求失败（401）」。这里按状态码分流。
    //    ⚠️ `LARK_WEB_AUTH_ENABLED=false` 时 `/me` 返回的是 **200**（enabled:false），
    //    根本走不到这里 —— 所以"只有 enabled=true 且没 session 时才跳"。
    if (error.status === 401) {
      window.location.href = feishuLoginUrl();
      return false;
    }
    // 403（账号未被授权）/ 5xx / 网络错误：交给调用方显示错误，并给出「去登录」按钮。
    throw error;
  }
  if (!body.enabled) throw new Error('飞书身份认证尚未启用，请联系管理员');
  if (!body.authenticated) {
    window.location.href = feishuLoginUrl();
    return false;
  }
  statusElement.textContent = `已登录：${body.user?.name || '飞书用户'}`;
  logoutButton.classList.remove('hidden');
  logoutButton.addEventListener('click', async () => {
    await fetch('/api/auth/feishu/logout', { method: 'POST', credentials: 'include' });
    window.location.reload();
  });
  return true;
}
