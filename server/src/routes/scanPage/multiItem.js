'use strict';

/**
 * ⭐⭐ 2026-10-16 拆分（阶段二 · 纯搬运 ✓）：**多货品**相关的纯函数。
 *   本轮先落 `parseMultiItemGroups` / `mergeFirstItemEntries`（后续层：multiItemOrder* 那几件 ✓）。
 */

/**
 * ⭐⭐ 2026-10-16（task-59 · 路由半）：隐藏字段 `multi_items` → **分组数组**（纯函数 ✓ 用例直调 ✓）。
 *
 * 形状 = 设计 §4.3（渲染半的 `multiItemPayloadJson` 逐字同源）：
 *   `[{ product_record_id, number, item_no, color, supplier_record_id, entries: [{ size, quantity }] }]`
 *
 * 🔴 **坏输入一律 `[]`**（回落老路径 ⇒ 引擎 **0 次** ✓）：没这个字段 / 空串 / **JSON 坏** /
 *    **不是数组** —— 解析器**不抛、不编、不猜** ✗（RT6）。
 * ⚠️ 同名字段出现多次时（`extended:true` ⇒ 数组）**取最后一个**（= 浏览器最后提交的那一份）。
 * ⚠️ 字段名**只从配置取**（`config/multiItemOrder.js` 的 `field` ✓）—— 这里**不写死** ✗。
 */
const parseMultiItemGroups = (body, multiConfig) => {
  const field = String((multiConfig && multiConfig.field) || '');
  if (!field || !body) return [];
  const raw = body[field];
  const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (typeof value !== 'string' || !value.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    return [];
  }
  return Array.isArray(parsed) ? parsed : [];
};

/**
 * ⭐⭐ **首件 + 本次表单的尺码/数量**（渲染半逐字注明「`entries` 由路由在提交时合并」✓）。
 *
 * 🔴 **只合并一次**：这里是**赋值**（不是 `concat` / `push`）⇒ 就算这一段被走两遍，
 *    数量也**不会翻倍** ✓（翻倍 = 那一单凭空多补/多退 ✗）。
 * ⚠️ 真的"同货号 + 同尺码出现两次"（她勾了两遍）由引擎的 `duplicate_line` **拒单**兜住 ✓
 *    —— **不是**静默翻倍 ✗。
 * ⚠️ 只动**首件**（= 隐藏字段里那件，也就是她当前扫的这一款）；
 *    其余分组**原样透传**（它们的 `entries` 由渲染那一侧决定，本函数**不碰** ✗）。
 */
const mergeFirstItemEntries = (groups, entries) => {
  const list = Array.isArray(groups) ? groups : [];
  if (!list.length) return [];
  const lines = (Array.isArray(entries) ? entries : []).map((entry) => ({
    size: entry?.size, quantity: entry?.quantity,
  }));
  return [{ ...list[0], entries: lines }, ...list.slice(1)];
};

/**
 * 表单里**同名重复**的字段（`line_amount` / `payment_method` / `payment_amount`）
 * 在 `express.urlencoded({extended:true})` 下是**数组**；只出现一次时是**字符串**。
 * 这个纯函数把两种形状统一成有序数组（顺序 = 页面上的行顺序）。
 */
/**
 * ⭐ 2026-10-12：表单里传来的**尺码**（正整数；认不出就丢）——
 * 与 `asList` 并排，只给"未报货候选"那几个可点元素用。
 */
const positiveSize = (value) => {
  const text = String(value ?? '').trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
};

/**
 * ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）：**写入口关着 ⇒ 不许收单** ——
 *   这条闸门必须在**同步那一半**（排后台之前）：否则开关关着时她也会看到成功页，
 *   而**一个字都没写** ✗（val-cp 盘点的 X-6：「关着还收单 = 骗她」）。
 *
 * ⚠️ 它是**运维开关**（`SCAN_REPLENISH_WRITE_ENABLED` / `SCAN_RETURN_WRITE_ENABLED`，显式布尔 ✓），
 *    不是她的输入 ⇒ 与「她填错了」那类校验**分开**：
 *   · **金额 / 单号认不出** ⇒ 仍在**同步路径**（`purchaseAmount*Page` / `notFoundPage` ✓）；
 *   · **尺码 / 数量 / 空单** ⇒ 也**已经**在**同步路径**（`purchaseEntryViolation` ⇒
 *     `purchaseEntryInvalidPage`，**排后台之前** ⇒ 400 + 人话 + 零写入 + 不调度 ✓）。
 *     ⚠️ **改前逐字**（2026-10-16 上半场 · #695 的已知取舍）：
 *       `· **尺码 / 数量 / 空单** ⇒ 在**写层**（\`services/scanWriteService.js\`，本刀**一个字不改** ✗）——
 *        它们跟着"写库那一步"进后台（**已知取舍**：写层失败 ⇒ 后台 warn ＋ 会话 \`last_error\`，
 *        不会静默；🔴 见 PR 说明，别当它不存在 ✗）。`
 *     ⚠️ **改后逐字**：本刀把这三类**搬到同步路径**（**移出后台** ✓）——
 *       判据只有一份真源（`config/scanPurchaseEntryRules.js`，与写层
 *       `services/scanWriteService.js:1397-1426` / `:1556-1585` 逐字同源 ✓），
 *       **`scanWriteService.js` 一个字都不改** ✗（余量 0 硬红线）。
 *       依据：业务负责人口径「**异步只针对"写库"**；**校验必须当场同步拦**」。
 *
 * @returns {null|{code:string, message:string}} `null` = 放行；否则调用方照旧
 *   `respondWriteFailure` ⇒ **400 + 人话 + 零写入**（与改前那张页逐字同形 ✓）。
 */
const purchaseWriteDisabledError = (chainConfig, texts) => (chainConfig?.enabled === false
  ? { code: 'disabled', message: texts.writeDisabledBody }
  : null);

module.exports = { parseMultiItemGroups, mergeFirstItemEntries };
