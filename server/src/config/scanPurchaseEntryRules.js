'use strict';

/**
 * ⭐⭐ 2026-10-16（task-52 · ②-⑭ 收尾）：**补货 / 退货「勾了哪些尺码、每个几双」那三类校验**的
 * **唯一真源**（纯函数 · 不碰任何 IO · 配置先行 ✓）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么要有这个文件（本刀的口子）：
 *   #695 把「写库」挪进后台之后，写层的**输入校验**（尺码空 / 数量空或非法 / 空单）
 *   **跟着写库一起进了后台** ✗ ⇒ 她真填错时**先看到成功页**、失败只在后台 warn ＋
 *   会话 `last_error`（不静默 ✓ 但体验错了 ✗）。
 *   业务负责人的口径：**异步只针对「写库」** ✓；**校验必须当场同步拦**
 *   （拦住 + 人话 + **零写入** + **不调度后台** ✓）。
 *
 * 🔴 本文件**不发明任何新规则** —— 逐条抄自写层（`src/services/scanWriteService.js`）：
 *   · 补货 `submitReplenish`：`scanWriteService.js:1397-1426`（① 校验那一段）；
 *   · 退货 `submitPurchaseReturn`：`scanWriteService.js:1556-1585`（① 校验那一段）。
 *   三组规则（错误码 / 人话 / 条件）**逐字对照**写在本文件每个函数上面 ✓。
 *
 * 🔴 本刀**一个字都不改 `scanWriteService.js`**（余量 0 硬红线 ✗）⇒ 写层那三组校验**照旧在**
 *   （它是"绕过扫码页直调写服务"时的最后一道防线 ✓）；本文件是**给路由那一半**用的同一套判据：
 *   · 路由在 `schedulePurchaseWrite(…)` **之前**调 `purchaseEntryViolation(…)`；
 *   · 命中 ⇒ **400 + 同一句人话 + 零写入 + 一次后台都不排** ✓；
 *   · 通过 ⇒ 才排后台（异步那半**一个字不改** ✗）。
 * ⚠️ 于是判据在**两份真源**上（写层那份没动 + 本文件这份）—— 这正是本刀的**已知取舍**：
 *   要"同一份"必须**把写层那两段抽出来**（= 动 `scanWriteService.js`）⇒ **超出本刀授权**，
 *   留给 Lead 决策。在那之前，本文件的注释把**出处行号逐字钉住**，
 *   并用 `fileTag`（`services/scanWriteService.js:1397-1426`）把"这份判据抄自哪儿"写进返回值 ——
 *   塞回手抄版（把 `rulesTag` 删掉 / 改掉）⇒ 判据红 ✓（见 `test/purchaseSyncValidation.test.js`）。
 */

// 让 `require('./scanWrite')` 先跑起来（`fillText` / `TEXTS` / 两个链路配置都在那边 —— 只有一份 ✗ 不抄第二份）。
const { fillText, TEXTS, REPLENISH, PURCHASE_RETURN } = require('./scanWrite');

/**
 * 校验错误的**来源标记**（写层那两个函数名的**行号**）—— 判据的"同源哨兵"按它断言 ✓。
 * ⚠️ 行号变了（写层被改动）⇒ 这里也要跟着改；那是**故意**的：它逼着下一个人回去对一遍。
 */
const RULES_SOURCE = Object.freeze({
  replenish: 'services/scanWriteService.js:1397-1426',
  purchaseReturn: 'services/scanWriteService.js:1556-1585',
});

/** 错误的**机器码**（与写层**逐字同一套**）—— 路由 / 用例按它分辨是哪一类。 */
const ENTRY_RULE_CODES = Object.freeze({
  sizeUnknown: 'size_unknown',
  quantityInvalid: 'quantity_invalid',
  replenishEmpty: 'replenish_empty',
  returnEmpty: 'return_empty',
});

/** 出错的链路（决定人话用哪一句 —— 补货/退货各一句，与写层逐字同源 ✓）。 */
const ENTRY_RULE_CHAINS = Object.freeze({ replenish: 'replenish', purchaseReturn: 'purchase_return' });

/**
 * 拦住时那张人话页的**抬头**（与"金额那两张页"同形状：H1 一句话 + 照写的人话 + 回上一页 ✓）。
 * ⚠️ 正文**不在这儿**：正文就是**写层那一句**（`TEXTS.sizeUnknownBody` /
 *    `quantityInvalidBody{max}` / `replenishNoneBody` / `returnNoneBody`）——
 *    **同一句人话**、不是第二句 ✓（她自己说的：「**同一句人话**」）。
 */
const ENTRY_RULE_TEXTS = Object.freeze({
  entryInvalidTitle: '这一单还没填对',
});

/**
 * ⭐ 正整数（**逐字抄**写层 `scanWriteService.js:342-345` 的 `positiveInteger`）：
 *   `return /^[1-9]\d*$/.test(text) ? Number(text) : null;`
 * ⇒ `0` / `-1` / `1.5` / `abc` / 空串 / `undefined` **一律 `null`**（= 认不出）✓。
 */
const positiveInteger = (raw) => {
  const text = String(raw ?? '').trim();
  return /^[1-9]\d*$/.test(text) ? Number(text) : null;
};

/**
 * 一条明细的**尺寸校验**（**逐字抄** `scanWriteService.js:1400-1405`（补货）与
 * `:1559-1564`（退货）—— 两处**同形**，写层也是各写一遍的）：
 *
 *   条件：`positiveInteger(entry.size) === null`（尺码**认不出**：空 / 非正整数）
 *   错误码：`size_unknown`
 *   人话：`TEXTS.sizeUnknownBody`（`config/scanWrite.js:807`
 *        「这个尺码不在「尺码管理」里，请刷新这一页重新选。」）
 */
const entrySizeUnknown = (entry) => {
  if (positiveInteger(entry?.size) !== null) return null;
  return { code: ENTRY_RULE_CODES.sizeUnknown, message: TEXTS.sizeUnknownBody, field: 'size' };
};

/**
 * 一条明细的**数量校验**（**逐字抄** `scanWriteService.js:1406-1413`（补货）与
 * `:1565-1572`（退货））：
 *
 *   条件：`rawQuantity` 为空 ⇒ 取该链路的 `defaultQuantity`（补货 `REPLENISH.defaultQuantity`
 *        / 退货 `PURCHASE_RETURN.defaultQuantity`，`config/scanWrite.js:420 / :457`，默认 1）；
 *        `quantity === null（认不出：0 / 负数 / 小数 / 非数字） || quantity > maxQuantity` ⇒ 拦。
 *   错误码：`quantity_invalid`
 *   人话：`fillText(TEXTS.quantityInvalidBody, { max })`（`config/scanWrite.js:820`
 *        「数量要填 1 ~ {max} 之间的整数。」）—— `max` 取该链路的 `maxQuantity`
 *        （`config/scanWrite.js:418 / :455`，默认 99）✓。
 *
 * ⚠️ **"空"是合法输入**（勾了尺码不填数量 = 按默认值 1 双 —— 写层就是这个语义 ✓ 本文件不改它 ✗）。
 *   真正被拦的是**认不出的数量**（`abc` / `0` / `1.5` / 超上限）✓。
 */
const entryQuantityInvalid = (entry, chainConfig) => {
  const rawQuantity = String(entry?.quantity ?? '').trim();
  const fallback = chainConfig?.defaultQuantity;
  const quantity = rawQuantity ? positiveInteger(rawQuantity) : fallback;
  const max = Number(chainConfig?.maxQuantity);
  if (quantity !== null && quantity <= max) return null;
  return {
    code: ENTRY_RULE_CODES.quantityInvalid,
    message: fillText(TEXTS.quantityInvalidBody, { max: chainConfig?.maxQuantity }),
    field: 'quantity',
  };
};

/**
 * ⭐⭐ **补货 / 退货 共用的那一套「勾了哪些尺码、每个几双」校验** —— **唯一真源** ✓。
 *
 * 顺序**逐字同写层**（补货 `scanWriteService.js:1397-1426` / 退货 `:1556-1585`）：
 *   ① 逐条：**尺码**认不出 ⇒ `size_unknown`；
 *   ② 逐条：**数量**认不出 / 超上限 ⇒ `quantity_invalid`；
 *   ③ 一条明细都没有（`entries` 为空）⇒ `replenish_empty`（补货） / `return_empty`（退货）；
 *   ④ 明细条数 > `maxSizes` ⇒ `replenish_too_many` / `return_too_many`
 *      （⚠️ 与①②③**同一套配置**，本刀的判据清单只点名前三类；
 *         第④类**照旧留在写层**（它不在本刀要补的口子里 ✗）⇒ 本函数**不判它**，
 *         塞回"顺手把上限也搬过来"会与写层重复判一次 —— 不值得 ✓）。
 *
 * @param {object} input
 * @param {Array<{size:number|string, quantity:number|string}>} [input.entries] 页面上勾的尺码与数量
 * @param {'replenish'|'purchase_return'} input.chain 哪条链路（决定 `empty` 码 + 用哪份配置）
 * @returns {null|{code:string, message:string, field:string, rulesTag:string}} `null` = **通过** ✓
 */
const purchaseEntryViolation = ({ entries, chain } = {}) => {
  const isReturn = chain === ENTRY_RULE_CHAINS.purchaseReturn;
  const chainConfig = isReturn ? PURCHASE_RETURN : REPLENISH;
  const list = Array.isArray(entries) ? entries : [];
  const tagged = (violation) => (violation
    ? { ...violation, rulesTag: isReturn ? RULES_SOURCE.purchaseReturn : RULES_SOURCE.replenish }
    : null);

  // ① / ② 逐条（先尺寸、再数量 —— 与写层同一个顺序 ✓）
  for (const entry of list) {
    const sizeViolation = entrySizeUnknown(entry);
    if (sizeViolation) return tagged(sizeViolation);
    const quantityViolation = entryQuantityInvalid(entry, chainConfig);
    if (quantityViolation) return tagged(quantityViolation);
  }

  // ③ 空单（没有任何明细）
  if (!list.length) {
    return tagged({
      code: isReturn ? ENTRY_RULE_CODES.returnEmpty : ENTRY_RULE_CODES.replenishEmpty,
      message: isReturn ? TEXTS.returnNoneBody : TEXTS.replenishNoneBody,
      field: 'entries',
    });
  }

  return null;
};

module.exports = {
  RULES_SOURCE,
  ENTRY_RULE_CODES,
  ENTRY_RULE_CHAINS,
  ENTRY_RULE_TEXTS,
  positiveInteger,
  entrySizeUnknown,
  entryQuantityInvalid,
  purchaseEntryViolation,
};
