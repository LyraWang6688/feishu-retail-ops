'use strict';

/**
 * 工作台点击人的 **user_access_token**（内存缓存）。
 *
 * 业务负责人 2026-11-10：「所有者，可以是谁点击属于谁吗？不能算来财的」
 *   ⇒ 云盘上传必须用**点击人自己的 user_access_token**（tenant token 传的文件所有者是应用「来财」）。
 *
 * 三条硬边界：
 *   · 🔴 **只放内存**：不进 cookie（当前 session 是 HMAC 签名的 JSON，**签名≠加密**，放进去等于明文），
 *     不落盘、不写日志；
 *   · ⏰ 过期即丢：按 `expires_in` 提前 60 秒作废（过期的 token 留着只会让上传 401）；
 *   · 🧹 退出登录清掉（`clearUserAccessToken`）。
 *
 * ⚠️ 单进程内存：服务重启后需要重新登录一次工作台（重新授权后自动补上）；
 *    多实例部署时跨进程不共享（本项目单进程，与配置表缓存同一口径）。
 */

const SAFETY_MS = 60 * 1000;
const DEFAULT_TTL_SEC = 2 * 60 * 60;

const store = new Map();
let nowFn = () => Date.now();

/**
 * 登录回调拿到 token 后存起来。
 * @param {string} openId 点击人 open_id
 * @param {string} accessToken user_access_token（**绝不写日志**）
 * @param {number} [expiresInSec] 飞书返回的 expires_in（秒）
 * @returns {boolean} 是否真的存了（参数不全 / 立即过期 ⇒ false）
 */
const saveUserAccessToken = (openId, accessToken, expiresInSec) => {
  const id = String(openId || '').trim();
  const token = String(accessToken || '').trim();
  if (!id || !token) return false;
  const ttlSec = Number(expiresInSec) > 0 ? Number(expiresInSec) : DEFAULT_TTL_SEC;
  const ttlMs = Math.max(ttlSec * 1000 - SAFETY_MS, 0);
  if (!ttlMs) return false;
  store.set(id, { token, exp: nowFn() + ttlMs });
  return true;
};

/** 取点击人的 token（过期/没有 ⇒ 空串，调用方回落到 tenant token）。 */
const getUserAccessToken = (openId) => {
  const id = String(openId || '').trim();
  if (!id) return '';
  const entry = store.get(id);
  if (!entry) return '';
  if (entry.exp <= nowFn()) {
    store.delete(id);
    return '';
  }
  return entry.token;
};

/** 退出登录时清掉。 */
const clearUserAccessToken = (openId) => {
  const id = String(openId || '').trim();
  if (!id) return false;
  return store.delete(id);
};

/** 用例专用：清空（避免串用例）。 */
const resetUserAccessTokenStoreForTests = () => {
  store.clear();
  nowFn = () => Date.now();
};

/** 用例注入时钟（测过期；生产不调用）。 */
const setNowForTests = (fn) => {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
};

module.exports = {
  saveUserAccessToken,
  getUserAccessToken,
  clearUserAccessToken,
  resetUserAccessTokenStoreForTests,
  setNowForTests,
};
