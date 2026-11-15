/**
 * 容器标题里带上登录人：`邯美工作台 · 王颖`（2026-11-15 业务负责人口径）。
 *
 * - 首页 / label-print：`requireFeishuAuth` 已经拿到姓名，直接用 `setUserTitle`；
 * - 其他独立页（售后 / 采购 / 验收 / 交割 / 写入时序）：没有走 requireFeishuAuth，
 *   这里补一次 `/me` 只读请求；失败（401/403/网络）保持静态标题，不跳转、不报错。
 */

export function setUserTitle(name) {
  document.title = `邯美工作台 · ${name || '飞书用户'}`;
}

export async function syncUserTitle() {
  try {
    const response = await fetch('/api/auth/feishu/me', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json();
    if (body?.authenticated && body.user?.name) setUserTitle(body.user.name);
  } catch { /* 标题只是增强，失败不影响页面 */ }
}
