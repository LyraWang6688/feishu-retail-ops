'use strict';

const { SUBMIT_TOAST, DEFAULT_SUBMIT_TOAST_PATH } = require('../config/submitToast');

/**
 * ⭐⭐ **「提交成功」toast 的唯一实现处**（业务负责人 2026-10-29：「数据提交成功，后台自动写入，
 *    统一都是这个」＋「以后就没有成功页了」）。
 *
 * 用它做什么：一条**后台自动写入**的提交链成功收下之后，服务端**303 回工作台**并把那句统一文案
 * 放进 `?toast=`，由已有的 `public/workbench/shared/toast.js` 显示 5 秒。
 *
 * 🔴 **共用件**（不专属扫码页）：任何提交入口都能 import 本文件，
 *   · 文案 / 落点 / 参数名 **全部走 `config/submitToast.js`**（调用方不写中文、不拼 URL ✗）；
 *   · 缓存头（`no-store` 一族）也在这里统一设 —— 回执页**不许**被缓存成"上一次的成功"。
 * 🔴 **不做任何业务判断**：它不认识"销售 / 补货 / 退货"，只回答"把这一页送去 toast"。
 */

/** 只允许站内相对路径（`/workbench/…` 这种）：跨站 / `//host` / 反斜杠 / 空白 / 绝对 URL 一律拒。 */
const isSafeInternalPath = (value) => {
  const path = String(value || '').trim();
  if (!path || path.length > 200) return false;
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  if (path.includes('\\') || /\s/.test(path)) return false;
  return true;
};

/** 文案规整：去多余空白、截到配置上限（**截断不报错** —— 回执不该因为一句话太长就拦住她）。 */
const normalizeToastText = (text, maxLength = SUBMIT_TOAST.maxTextLength) => String(text || '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, Math.max(1, Number(maxLength) || SUBMIT_TOAST.maxTextLength));

/** 允许覆盖的参数（其余 `extra` 会被忽略？不 —— 见下面：`extra` 只加**不冲突**的键）。 */
const submitToastQuery = ({ orderNo = '', text = '', extra = {}, config = SUBMIT_TOAST } = {}) => {
  const params = new URLSearchParams();
  // 单号只进 `done`（排查/漏斗用），**不进 toast 文案**（她要求统一那一句）。
  const notice = String(orderNo || '').trim();
  if (notice) params.set(String(config.noticeKey || 'done'), notice.slice(0, 64));
  const message = normalizeToastText(text || config.text, config.maxTextLength);
  if (message) params.set(String(config.param || 'toast'), message);
  const reserved = new Set([String(config.param || 'toast'), String(config.noticeKey || 'done')]);
  for (const [key, value] of Object.entries(extra || {})) {
    const name = String(key || '').trim();
    const val = String(value ?? '').trim();
    if (!name || !val || reserved.has(name)) continue;
    params.set(name, val);
  }
  return params;
};

/** 完整 URL（带 query）；落点不合法 ⇒ **回落缺省工作台**（绝不把浏览器送去外站）。 */
const submitToastUrl = (options = {}) => {
  const config = options.config || SUBMIT_TOAST;
  const wanted = String(options.path || config.path || '').trim();
  const path = isSafeInternalPath(wanted) ? wanted : DEFAULT_SUBMIT_TOAST_PATH;
  const query = submitToastQuery({ ...options, config }).toString();
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
};

/**
 * 303 回工作台 + toast。
 * 为什么是 303：提交是 POST，回执是一次 **GET 导航**（浏览器地址栏落到工作台，刷新不会重复提交 ✓）。
 */
const redirectWithSubmitToast = (res, options = {}) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  return res.redirect(303, submitToastUrl(options));
};

module.exports = {
  isSafeInternalPath,
  normalizeToastText,
  submitToastQuery,
  submitToastUrl,
  redirectWithSubmitToast,
};
