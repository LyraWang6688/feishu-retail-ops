/**
 * ⭐⭐ 飞书 **JSAPI 签名**（扫码用）—— 2026-10-13 业务负责人批准「接原生扫码」后新增。
 *
 * 口径（Lead 裁定的范围，**不扩**）：
 * · 接口路径：`/api/workbench/lark/jsapi-signature`（挂在工作台那道准入闸门内 ⇒ **未登录 401** ✓）
 *   ⚠️ 不放进 `/api/lark/*`：那样要动 `app.js` 的挂载（不在本轮允许面 ✗）；挂着闸门内语义等价 ✓
 * · `url` 参数**必须与请求自身的 Host 一致**（协议限 http/https）⇒
 *   **不会被当成"任意域名的签名机"** ✗（不引入新的环境变量 ⇒ 不用改线上 `.env` ✓）
 * · 票据有效期 2 小时（飞书口径）⇒ 提前 5 分钟视为过期（`TICKET_SAFETY_MS`）✓
 */
const JSSDK_SIGNATURE_PATH = '/api/workbench/lark/jsapi-signature';
const TICKET_TTL_MS = 2 * 60 * 60 * 1000; // 飞书 jsapi_ticket / tenant_access_token 都是 2 小时
const TICKET_SAFETY_MS = 5 * 60 * 1000; // 提前 5 分钟刷新（不卡在过期边上）

/**
 * `url` 是否允许签名：**只能是本站**（与请求 Host 逐字相同，协议 http/https）。
 * 返回 true/false —— 路由据此给 400 ✓
 */
function isAllowedSignatureUrl(rawUrl, requestHost) {
  if (!rawUrl || !requestHost) return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return parsed.host === requestHost;
}

/** ⭐ 用户可见文案（守门测试要求：路由里不许留硬编码中文 ⇒ 一律放这儿 ✓） */
const SIGNATURE_MESSAGES = {
  badUrl: 'url 参数必须是本站地址',
  unavailable: '签名服务暂时不可用，请用手输编号',
};

module.exports = {
  JSSDK_SIGNATURE_PATH,
  TICKET_TTL_MS,
  TICKET_SAFETY_MS,
  isAllowedSignatureUrl,
  SIGNATURE_MESSAGES,
};
