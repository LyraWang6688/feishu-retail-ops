'use strict';

/**
 * ⭐⭐ **提交成功页 · 统一极简**（2026-10-16 · task-52 收尾件）。
 *
 * 业务负责人的口径（逐字 · 2026-10-16）：
 *   「用户提交之后**都是一个成功页**，说"**已提交成功，数据会更新**"类似这类的话就行了。
 *     **都是一个异步的提醒**，告诉系统已经接收到用户提交的这单了」
 *   「**不需要做任何跳转，也不需要做任何链接**」
 *
 * ⇒ 本件只回答两件事（**一个 service 只干一件事** ✓）：
 *   ① **开关**：`SCAN_SUCCESS_PAGE_MINIMAL_ENABLED`（**显式布尔 · 缺省 false** ✓ 关着＝与今天**逐字节一致** ✗）
 *   ② **那一句**：`SCAN_SUCCESS_PAGE_MINIMAL_TEXT`（**文案走配置** ✓ 模板里不写中文 ✓）
 *
 * 🔴 规矩（《配置先行》✓）：
 *   · **显式布尔**：`readFlag(env, …, false)` ✓ **不许**写 `process.env.X || 默认` ✗（`||` 会让"清空变量"
 *     回退到默认值 ⇒ **关不掉** ✗）；**空字符串 = 关** ✓（`readFlag` 的口径 ✓）
 *   · 文案：**空串 ⇒ 用缺省那句** ✓（文案不是开关，"清空"没有"关掉"的语义 ✓ —— 与开关口径不同 ✓ 这里写明 ✗）
 *
 * ⚠️ 本件**不渲染任何 HTML**（画由 `views/scanPage/index.js` 的 `renderScanMessagePage` 负责 ✓）：
 *   它只输出一组"把成功页收成极简"的**覆盖值**（见 `minimalSuccessOverrides` ✓），
 *   由渲染层在**开关打开时**套用 ⇒ **单一真源** ✓ 不散落 ✗。
 */

const { readFlag, readString } = require('./envValue');

/** 缺省那一句（她给的原话形状 ✓ 文案真源就在这里 ✓ 别处不许再抄一份 ✗）。 */
const DEFAULT_MINIMAL_TEXT = '已提交成功，数据会更新';

const env = process.env;

/** ⭐ 开关：**显式布尔 · 缺省 false** ✓（关着 ⇒ 成功页与今天**逐字节一致** ✓）。 */
const minimalEnabled = readFlag(env, 'SCAN_SUCCESS_PAGE_MINIMAL_ENABLED', false);

/** ⭐ 那一句：**空串 ⇒ 用缺省** ✓（文案的"清空"没有关掉的语义 ✓ 与开关分开口径 ✓）。 */
const minimalText = (() => {
  const raw = readString(env, 'SCAN_SUCCESS_PAGE_MINIMAL_TEXT', DEFAULT_MINIMAL_TEXT);
  return String(raw || '').trim() || DEFAULT_MINIMAL_TEXT;
})();

const SCAN_SUCCESS_PAGE = Object.freeze({
  minimalEnabled,
  minimalText,
  /** @deprecated 只为可读性：她原话里那句形状 ✓ 判据按 `minimalText` 走 ✓。 */
  defaultMinimalText: DEFAULT_MINIMAL_TEXT,
});

/**
 * ⭐ 把一页"成功页"收成极简时用的**覆盖值** —— **开关关着 ⇒ 返回空对象** ✗（调用方 spread 后**逐字不变** ✓）。
 *
 * 覆盖到什么程度（逐条对应她的原话 ✓）：
 *   · `body` ⇒ 统一那一句 ✓（"已提交成功，数据会更新"这类 ✓）
 *   · **不跳转** ⇒ `autoReturnUrl=''` ＋ `returnDelaySeconds=0` ⇒ 渲染层**不写 `<meta http-equiv="refresh">`** ✓
 *   · **不链接** ⇒ `backPath/backLabel/backHint` ＋ `returnPath/returnLabel` 全清 ⇒ 一个 `<a>` 都没有 ✓
 *   · 追加动作块（`extraActionsHtml`）也清 ✗（它同样是"跳走/再做一件事"的入口 ✓）
 *   · `details` 清 ✗（她说"就一句话" ✓；单号这类事实**进日志** ✓ 不占她的成功页 ✗）
 *
 * ⚠️ **不改 `title`**：四条链各自的标题照旧 ✓（她要说的是"**一句话 + 不跳不链接**"✓ 不是"标题也统一"✗）。
 */
const minimalSuccessOverrides = (config = SCAN_SUCCESS_PAGE) => {
  if (!config || config.minimalEnabled !== true) return {};
  return {
    body: config.minimalText,
    details: [],
    number: '',
    retryHint: '',
    backPath: '',
    backLabel: '',
    backHint: '',
    returnPath: '',
    returnLabel: '',
    returnDelaySeconds: 0,
    autoReturnUrl: '',
    extraActionsHtml: '',
  };
};

module.exports = { SCAN_SUCCESS_PAGE, minimalSuccessOverrides, DEFAULT_MINIMAL_TEXT };
