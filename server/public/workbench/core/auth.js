import { api } from './api-client.js';

// 跳登录用的标记：走完授权仍拿不到会话（例如飞书后台没配回调）时，
// 不能再跳第二次，否则会无限重定向。跳过一次就改成明确报错。
const REDIRECT_FLAG = 'workbench.auth.redirected';

function redirectToFeishuLogin() {
  const returnTo = encodeURIComponent(location.pathname + location.search);
  const target = `/api/auth/feishu/start?return_to=${returnTo}`;
  let alreadyRedirected = false;
  try {
    alreadyRedirected = sessionStorage.getItem(REDIRECT_FLAG) === '1';
  } catch (error) {
    // 隐私模式等拿不到 sessionStorage：宁可只跳一次也不无限循环
    alreadyRedirected = true;
  }
  if (alreadyRedirected) {
    throw new Error('飞书登录未完成（可能是应用回调地址未配置），请重新打开工作台或联系管理员');
  }
  try {
    sessionStorage.setItem(REDIRECT_FLAG, '1');
  } catch (error) {
    /* 忽略：上面已经在拿不到时按"已跳过"处理 */
  }
  window.location.href = target;
  return false;
}

export async function requireFeishuAuth({ statusElement, logoutButton }) {
  let body;
  try {
    body = await api.get('/api/auth/feishu/me');
  } catch (error) {
    // ⚠️ 401 = 没有登录会话（后端会带 auth_required）。api-client 对非 2xx 是【抛异常】，
    // 所以这里必须先接住，否则会冒到调用方、页面卡在"工作台启动失败：请求失败（401）"。
    if (error?.status === 401) return redirectToFeishuLogin();
    throw error;
  }
  // 拿到了会话之后，清掉"跳过"标记，避免下次 401 时被误判成已跳过一次。
  try {
    sessionStorage.removeItem(REDIRECT_FLAG);
  } catch (error) {
    /* 忽略 */
  }
  if (!body.enabled) throw new Error('飞书身份认证尚未启用，请联系管理员');
  if (!body.authenticated) return redirectToFeishuLogin();
  statusElement.textContent = `已登录：${body.user?.name || '飞书用户'}`;
  logoutButton.classList.remove('hidden');
  logoutButton.addEventListener('click', async () => {
    await fetch('/api/auth/feishu/logout', { method: 'POST', credentials: 'include' });
    window.location.reload();
  });
  return true;
}
