'use strict';

/**
 * ⭐⭐ **提交成功页 · 统一极简**（2026-10-16 · task-52 收尾件）。
 *
 * 业务负责人的口径（逐字 · 2026-10-16）：
 *   「用户提交之后**都是一个成功页**，说"**已提交成功，数据会更新**"类似这类的话就行了。
 *     **都是一个异步的提醒**，告诉系统已经接收到用户提交的这单了」
 *   「**不需要做任何跳转，也不需要做任何链接**」
 *
 * ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
 *   改前逐字：① **开关**：`SCAN_SUCCESS_PAGE` ＋ `_MINIMAL_ENABLED`（显式布尔 · 缺省 false ⇒ 关着＝老样子）
 *   改后逐字：**没有开关了** —— 成功页**永远极简**（那一句仍走 `SCAN_SUCCESS_PAGE_MINIMAL_TEXT` ✓）
 *   依据 = 业务负责人 **2026-10-16 22:5x** 逐字：「**不用。以后你不用有"开关"的这个思维，我们换了新功能，
 *          就直接用新功能就可以了呀。把新功能都上了，不需要开关。**」✓（落档 `docs/no-switch-rule-2026-10-16.md`）
 *
 * ⇒ 本件只回答一件事（**一个 service 只干一件事** ✓）：
 *   ① **那一句**：`SCAN_SUCCESS_PAGE_MINIMAL_TEXT`（**文案走配置** ✓ 模板里不写中文 ✓）
 *
 * 🔴 规矩（《配置先行》✓）：
 *   · ⚠️ **本件已无开关**（她 2026-10-16 22:5x：「不需要开关」）⇒ 这里不再有 `readFlag` ✗；
 *     那条"禁 `process.env.X || 默认`"的禁令**依旧成立于全仓**（清空变量会关不掉 ✗）
 *   · 文案：**空串 ⇒ 用缺省那句** ✓（文案不是开关，"清空"没有"关掉"的语义 ✓ —— 与开关口径不同 ✓ 这里写明 ✗）
 *
 * ⚠️ 本件**不渲染任何 HTML**（画由 `views/scanPage/index.js` 的 `renderScanMessagePage` 负责 ✓）：
 *   它只输出一组"把成功页收成极简"的**覆盖值**（见 `minimalSuccessOverrides` ✓），
 *   由渲染层在**开关打开时**套用 ⇒ **单一真源** ✓ 不散落 ✗。
 */

const { readString } = require('./envValue');

/** 缺省那一句（她给的原话形状 ✓ 文案真源就在这里 ✓ 别处不许再抄一份 ✗）。 */
const DEFAULT_MINIMAL_TEXT = '已提交成功，数据会更新';

const env = process.env;

/** ⭐ 那一句：**空串 ⇒ 用缺省** ✓（文案的"清空"没有关掉的语义 ✓ 与开关分开口径 ✓）。 */
const minimalText = (() => {
  const raw = readString(env, 'SCAN_SUCCESS_PAGE_MINIMAL_TEXT', DEFAULT_MINIMAL_TEXT);
  return String(raw || '').trim() || DEFAULT_MINIMAL_TEXT;
})();

const SCAN_SUCCESS_PAGE = Object.freeze({
  minimalText,
  /** @deprecated 只为可读性：她原话里那句形状 ✓ 判据按 `minimalText` 走 ✓。 */
  defaultMinimalText: DEFAULT_MINIMAL_TEXT,
});

/**
 * ⭐ 把一页"成功页"收成极简时用的**覆盖值** —— **永远生效**（没有开关 ✓ 她 2026-10-16 22:5x「不需要开关」✓）。
 *
 * 覆盖到什么程度（逐条对应她的原话 ✓）：
 *   · `body` ⇒ 统一那一句 ✓（"已提交成功，数据会更新"这类 ✓）
 *   · **不跳转** ⇒ `autoReturnUrl=''` ＋ `returnDelaySeconds=0` ⇒ 渲染层**不写 `<meta http-equiv="refresh">`** ✓
 *     ⭐ **依据出处（不许靠记忆转述 ✓）**：⭐ **零链接 ＋ 零跳转** 与上游**零回归判据**
 *       `test/successPageZeroRegression.test.js` 的 **`AC-REG1`**（**逐字节 sha256 ＋ 零 offender** ✓）**同一基线** ✓
 *       ⇒ ⭐ 这是**技术设计与上游判据的自洽** ✓ —— ⚠️ **不是"她的口径"** ✗（技术取舍不许伪造出处 ✗）。
 *       ⚠️ 2026-10-17 00:5x 记：Lead 曾在派活卡里误写「2 秒后自动回首页**保留**」✗（**转述错误** ✓ 他已认错撤回 ✓）
 *       ⇒ 本注释据此**显式钉住"不跳转"的出处** ✓（防止下一次又靠记忆转述 ✗）；
 *         他的正确裁决：⭐ **路 A = 不跳转** ✓（判据 `AC-R9` 已按此**反向钉住** ✓）
 *   · **不链接** ⇒ `backPath/backLabel/backHint` ＋ `returnPath/returnLabel` 全清 ⇒ 一个 `<a>` 都没有 ✓
 *   · 追加动作块（`extraActionsHtml`）也清 ✗（它同样是"跳走/再做一件事"的入口 ✓）
 *   · `details` 清 ✗（她说"就一句话" ✓；单号这类事实**进日志** ✓ 不占她的成功页 ✗）
 *
 * ⚠️ **不改 `title`**：四条链各自的标题照旧 ✓（她要说的是"**一句话 + 不跳不链接**"✓ 不是"标题也统一"✗）。
 */
const minimalSuccessOverrides = (config = SCAN_SUCCESS_PAGE) => {
  // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`if (!config || config.minimalEnabled !== true) return {};`（开关关着 ⇒ 不覆盖 ⇒ 老样子）
  //   改后逐字：**这一行删掉** ⇒ 永远返回覆盖值（= 成功页永远极简 ✓）
  //   依据 = 她 2026-10-16 22:5x「**把新功能都上了，不需要开关**」✓
  return {
    body: (config && config.minimalText) || DEFAULT_MINIMAL_TEXT,
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
