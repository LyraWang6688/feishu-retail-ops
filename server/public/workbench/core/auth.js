import { api } from './api-client.js';

export async function requireFeishuAuth({ statusElement, logoutButton }) {
  const body = await api.get('/api/auth/feishu/me');
  if (!body.enabled) throw new Error('飞书身份认证尚未启用，请联系管理员');
  if (!body.authenticated) {
    window.location.href = `/api/auth/feishu/start?return_to=${encodeURIComponent(location.pathname + location.search)}`;
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
