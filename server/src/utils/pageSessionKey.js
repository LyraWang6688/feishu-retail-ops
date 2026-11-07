'use strict';

/**
 * ⭐⭐ 「**这一页的会话键**」（`<openId>|page|<页面 token>`）的**唯一解析处**。
 *
 * 为什么单独抽这一个文件（2026-10-29）：
 *   · 扫码页 2026-10-18 起按「**人 + 页面/设备**」隔离会话（`routes/scanPage/pageToken.js`），
 *     会话键的形状变成 `openId|page|<token>`，会话文件里 `open_id` 字段存的就是这个键；
 *   · 工作台「草稿箱」要**按人**列出她自己那些草稿 ⇒ 必须用**同一把尺子**判"这份会话是不是她的"，
 *     也要能从键里取回页面 token（"继续编辑"要把它写回 cookie）。
 *   · 两处若各写一份分隔符 / 正则，改一边就静默漏单 ✗ ⇒ 抽到这里，两边都 import。
 *
 * ⚠️ 这里**只有字符串解析**：不读环境变量、不碰存储、不认识任何业务。
 * ⚠️ `routes/scanPage/pageToken.js` 里的 `SESSION_KEY_SEPARATOR` / `TOKEN_PATTERN`
 *    现在就是**从这里 re-export** 的（公开形状 / 取值一个字都没变）。
 */

/** 会话键里 openId 与页面 token 之间的分隔符（只出现在本地会话文件 / 本地日志里）。 */
const SESSION_KEY_SEPARATOR = '|page|';

/** 合法页面 token：URL-safe 的固定长随机串（生成端是 16 字节 hex = 32 字符）。 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * 拆开会话键。
 *   · `<openId>|page|<token>` ⇒ `{ openId, token }`
 *   · 纯 `<openId>`（旧页面 / 没有 cookie 的写入口）⇒ `{ openId, token: '' }`
 *   · token 不合法的（手改文件 / 损坏）⇒ 也按"没有 token"处理（**不猜**）
 */
const parsePageSessionKey = (key) => {
  const text = String(key || '');
  const at = text.indexOf(SESSION_KEY_SEPARATOR);
  if (at < 0) return { openId: text, token: '' };
  const openId = text.slice(0, at);
  const token = text.slice(at + SESSION_KEY_SEPARATOR.length);
  return { openId, token: TOKEN_PATTERN.test(token) ? token : '' };
};

/**
 * 这份会话键是不是**这个人的**（`openId` 本人，或他的某一页）。
 * ⚠️ 空 openId / 空键一律 `false`（没有身份就什么都不算他的 —— 宁可少列，不可串单）。
 */
const isPageSessionKeyOf = (key, openId) => {
  const who = String(openId || '');
  const text = String(key || '');
  if (!who || !text) return false;
  return text === who || text.startsWith(`${who}${SESSION_KEY_SEPARATOR}`);
};

module.exports = {
  SESSION_KEY_SEPARATOR,
  TOKEN_PATTERN,
  parsePageSessionKey,
  isPageSessionKeyOf,
};
