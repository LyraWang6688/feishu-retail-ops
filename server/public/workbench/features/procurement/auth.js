import { api } from '../../core/api-client.js';
import { feishuLoginUrl } from '../../core/auth.js';

/**
 * 采购页鉴权：**只要身份，不渲染登录 UI**（业务负责人 2026-10-29：对照交割单页，移动端顶部不放登录态）。
 *
 * 与 `core/auth.js` 的 `requireFeishuAuth` 行为一致（401/未登录 ⇒ 跳登录页；403/5xx ⇒ 抛给调用方显示错误），
 * 区别只有两点：① 不写「已登录：X」；② 不渲染「退出登录」按钮。
 * 返回 `body.user`；需要跳转时返回 `null`（调用方直接 return）。
 */
export async function ensureProcurementAuth() {
  let body;
  try {
    body = await api.get('/api/auth/feishu/me');
  } catch (error) {
    if (error.status === 401) {
      window.location.href = feishuLoginUrl();
      return null;
    }
    throw error;
  }
  if (!body.enabled) throw new Error('飞书身份认证尚未启用，请联系管理员');
  if (!body.authenticated) {
    window.location.href = feishuLoginUrl();
    return null;
  }
  return body.user || {};
}
