const { SCAN_PAGE } = require('../../config/scanPage');
const { SCAN_WRITE } = require('../../config/scanWrite');
const { REALM_TEXTS, PURCHASE_RETURN_REALM, purchaseSizeLines } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { submitFeedbackAttrs } = require('./script');
const { hiddenField, pageBuildField } = require('./paymentBlock');
const { multiItemBlockHtml, purchaseAmountRowHtml } = require('./multiItemBlock');

const sizeRowsHtml = ({
  sizes, name, quantityPrefix, quantityLabel, checkedOf, defaultQuantity = 1, stockOf = null,
}) => sizes.map((item) => {
  const size = item.size_text;
  const quantityName = `${quantityPrefix}${size}`;
  const stock = stockOf ? stockOf(item) : null;
  // ⭐ 2026-10-15 晚：这一行的**库存上限**挂在勾选框上（脚本据此拦"退货数量 > 当前库存" ✓）；
  //   **取不到库存 ⇒ 不带这个属性** ⇒ 脚本不拿 0 当库存拦她 ✗（她只会看到"取不到"那句人话 ✓）。
  const stockCapAttr = stock && Number.isFinite(stock.cap)
    ? ` data-stock="${escapeHtml(String(stock.cap))}"` : '';
  // ⚠️ 新属性**放在 `name` 之前**、`checked` 仍**紧跟在 `value` 后面** ——
  //   既有断言钉着逐字 `name="sizes" value="41" checked`（不许为了加属性把它改红 ✗ 我第一版就踩了）。
  const dataQtyNameAttr = ` data-qty-name="${escapeHtml(quantityName)}"`;
  return `<div class="size-row">
<label class="size-check"><input type="checkbox"${stockCapAttr}${dataQtyNameAttr} name="${escapeHtml(name)}" value="${escapeHtml(size)}"${checkedOf(item) ? ' checked' : ''}> ${escapeHtml(size)} 码</label>
${stock ? `<span class="hint" data-view="${escapeHtml(stock.view)}">${escapeHtml(stock.text)}</span>` : ''}
<input class="size-qty" name="${escapeHtml(quantityName)}" value="${escapeHtml(String(defaultQuantity))}" inputmode="numeric" aria-label="${escapeHtml(`${size} ${quantityLabel}`)}" placeholder="${escapeHtml(quantityLabel)}">
</div>`;
}).join('');

/**
 * ⭐⭐ 2026-10-11（业务负责人定）：采购领域的【**退货**】——与【一键补货】**同形**
 *   （同一个 POST 端点、同一套会话与幂等键风格、勾尺码 + 填数量）。
 *
 * 口径要点：
 *   · **不预勾任何尺码**：退哪几个码是**业务事实**（她现场看货才知道），替她预勾就是猜；
 *   · 数量默认 1（与补货同一条"至少一双"），可改；
 *   · **一行业务逻辑都没有**：动作名 / 字段名 / 幂等键 / 文案全来自配置，
 *     写库在既有构件里（见 `services/purchaseReturnService.js` 的文件头）。
 */
const returnFormHtml = (view, write, page = {}, config = SCAN_PAGE) => {
  const t = write.texts;
  const v = REALM_TEXTS;
  const fields = write.fields;
  const lines = purchaseSizeLines(view);
  const declaredSizes = lines.length ? lines : (write.sizes || []).map((item) => ({
    size_text: item.size_text, sellable: null, missing: Boolean(item.missing), checked: false,
  }));
  // ⭐⭐ 2026-10-15（task-28 · 她逐字）：「退货**严格按照实时库存里的数据来，只展示有数量的尺码**」
  //   · `sellable === 0` ⇒ **不列**（不是"列出来但退不了"✗ —— 那是她上一条口径的字面结果，她不认 ✓）；
  //   · `sellable` **不是数字** = **取不到 / 未确认** ⇒ ⭐ **仍然列出** + 标注"取不到" ✓
  //     🔴「**0**」与「**取不到**」**必须区分** —— 把"取不到"也当 0 藏掉会把**能退的码**藏了 ✗。
  const sizes = declaredSizes.filter((item) => !Number.isFinite(item.sellable) || item.sellable > 0);
  // 整款都是 0（且有尺码这一读）⇒ 给她一句人话（**不是空白页** ✗）
  const noReturnableStock = declaredSizes.length > 0 && sizes.length === 0;
  // ⭐⭐ 2026-10-15（task-23 · 她逐字：「直接就是出来实时库存里的**尺码和数量**」）：
  //   ① 每行多一个"当前库存数量"列 —— 数从**扫码那一次已经取到的** `sellable` 来（**不新增读表** ✗）；
  //      取不到（`sellable` 不是数字）⇒ **如实说"暂时取不到"**，**绝不用假数字占位** ✗；
  //   ② 数量默认值 = 写侧那一份配置（`purchaseReturn.defaultQuantity`）—— **不再写死 1** ✗；
  //   ③ 表单上挂几个 `data-*`（字段名 / 上限 / 三句人话）⇒ 那段**唯一**脚本据此拦截 ✓
  //      （脚本里**不写死任何字段名/文字** ✗ —— 她 2026-10-09 白屏之后"只许一段脚本"那条规矩照旧 ✓）。
  const rf = SCAN_PAGE.returnForm;
  const returnConfig = SCAN_WRITE.purchaseReturn;
  const rows = noReturnableStock ? '' : sizeRowsHtml({
    sizes,
    name: fields.returnSizes,
    quantityPrefix: fields.returnQuantityPrefix,
    quantityLabel: t.replenishQuantityLabel,
    checkedOf: () => false,
    defaultQuantity: returnConfig.defaultQuantity,
    // ⚠️ 走到这里的行**一定是"有数量"的**（0 已被上面滤掉 ✓）⇒ 数量列直接就是那个数；
    //    `cap` = 她那条口径的判据（**退货数量 ≤ 当前库存** ✓ 原样保留）；
    //    取不到的行（`sellable` 不是数字）⇒ 如实说"取不到"、**不带上限** ✓
    stockOf: (item) => (Number.isFinite(item.sellable)
      ? { view: 'return-stock', text: String(item.sellable), cap: item.sellable }
      : { view: 'return-stock-unknown', text: rf.stockUnknown, cap: null }),
  });
  // ⚠️ 三种"没东西可勾"要分清（都**不空白** ✓）：
  //   · 整款 0 库存 ⇒ `return-no-stock`（她说的"这一款现在没有可退的库存" ✓）
  //   · 尺码这一读**取不到** ⇒ `return-sizes-unknown`（如实说取不到 ✓ 不硬编假尺码 ✗）
  const sizesNotice = noReturnableStock
    ? `<p class="hint" data-view="return-no-stock">${escapeHtml(rf.noReturnableStock)}</p>`
    : (sizes.length ? '' : `<p class="hint" data-view="return-sizes-unknown">${escapeHtml(rf.sizesUnknown)}</p>`);
  // ⭐⭐ 2026-10-16（task-47 · 业务负责人真机逐字：「我首先是点击了退货的 tab 页，**然后只有一个退货按钮**，
  //   点击了退货按钮之后，才出现的下面的内容」）：
  //   🔴 **改前逐字**：`<details class="disclosure" data-view="purchase-return">`（**没有 open**）
  //      —— `<details>` **默认收起** ⇒ 首屏**只剩那颗 `<summary>`**：实心主色、通栏
  //      （:215 「.disclosure__summary」= background var(--primary) + color var(--surface)），
  //      文案 = v.purchaseReturn = **「退货」** ⇒ 她看到的就是「**一颗退货按钮**」✓，点它才展开出表单 ✓
  //   ✅ **2026-10-16 晚 改后逐字（本刀）**：**去掉 `<details>` / `<summary>` 包壳**，表单直接渲染 ——
  //      改前逐字：`<details class="disclosure" data-view="purchase-return" open>` + 下一行
  //                 `<summary class="disclosure__summary">${escapeHtml(v.purchaseReturn)}</summary>`
  //      改后逐字：**这两行都删掉**（`<section class="card">` 外层保留 ✓，`<form …>` 紧跟其后 ✓）
  //      **依据**：她 2026-10-16 真机截图 + 逐字「退货那个确实点击了之后确实是出现了表单，
  //        但是那个**退货按钮为什么还有呢，不需要了**」—— 上一刀加了 `open` ⇒ 表单**已经首屏可见** ✓
  //        ⇒ 那颗实心通栏 `<summary>`（写着「退货」）就**纯多余**了 ✗（她还以为要多点一下 ✓）
  //      **判据**：`test/returnBlockFirstScreen.test.js`（塞回 `<details>`/`<summary>` ⇒ 红 ✓）
  //   ⭐⭐ **定位标记 `data-view="purchase-return"` 迁到 `<form>` 上**（**只去折叠壳、不动标记** ✓）：
  //      全仓有 6+ 处用例拿它当"退货表单从哪开始"的**锚**（例：`html.indexOf('data-view="purchase-return"')`）
  //      ⇒ 标记一起删掉会得到 `indexOf === -1` 的空切片 —— 那是**静默假绿** ✗（比红更坏）
  //      ⇒ 标记留在语义相同的位置（**退货表单那一元素**上）✓ 那些用例一个字都不用改 ✓
  //   ⚠️ 「一键补货」那个同形的 `<details>`（下面 one-tap-replenish）**这一刀不动** ✗
  //   🔴 **2026-10-16 晚 收尾（标签配对 · 改前逐字 → 改后逐字 → 依据）**：
  //      改前逐字（WIP 那一版把 `</details>` **删错了地方**）：补货块 `</form>` 之后**少了** `</details>` ✗，
  //        而本函数 `</form>` 之后**多留了一个** `</details>` ✗（开始标签已删、闭合标签还在 ⇒ 标签不配对）
  //      改后逐字：`</details>` **还给补货块**（`</form>` 后一行，与 WIP 前逐字一致 ✓）；
  //        本函数 `</form>` 后那个 `</details>` **删掉**（退货块**一个 `<details>` 标签都不剩** ✓）
  //      依据：本刀的口径是「**只去退货那一个折叠壳**」＋「**补货块一个字不动**」
  //        ⇒ 开始标签与闭合标签必须**同进同出**；`</section>` 虽然能让浏览器容错补上，
  //          但源码不再逐字可信，且"删错了那一个"正是最该被拦住的错 ✗
  //      判据：`test/collapseSemanticsSentinel.test.js` ①（补货块**自己**的 `</details>` 必须在 ⇒ 少一个即红 ✓）
  //        ＋ `test/returnBlockFirstScreen.test.js` AC-RF1a（退货块里 `</details>` 也不许有 ✓）
  return `<section class="card">
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form"
data-view="purchase-return"
data-return-sizes-field="${escapeHtml(fields.returnSizes)}"
data-return-qty-prefix="${escapeHtml(fields.returnQuantityPrefix)}"
data-return-max-sizes="${escapeHtml(String(returnConfig.maxSizes))}"
data-return-max-quantity="${escapeHtml(String(returnConfig.maxQuantity))}"
data-return-required-text="${escapeHtml(rf.sizesRequiredText)}"
data-return-quantity-text="${escapeHtml(rf.quantityInvalidText)}"
data-return-limit-text="${escapeHtml(rf.sizesLimitText)}"
data-return-stock-text="${escapeHtml(rf.stockLimitText)}"
data-return-hint-view="${escapeHtml(rf.hintView)}">
${hiddenField(fields.action, write.actions.purchaseReturn)}${pageBuildField()}
${hiddenField(fields.submitKey, write.returnKey)}
${sizesNotice}
<p class="hint" data-view="${escapeHtml(rf.hintView)}" hidden></p>
${rows}
${sizes.length ? `${purchaseAmountRowHtml(write)}
${multiItemBlockHtml(write, view, 'return', page)}
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(rf.submitLabel)}</button>
</form>
` : ''}
</section>`;
};

/**
 * ⭐⭐ **只渲染当前领域那一块**（2026-10-09 手机白屏之后的改法）。
 *
 * **六个领域**各自的正文（每个都带 `realm-block--<领域>` 标记，方便对照 / 断言）：
 *   · `sales`            —— 销售建单表单；
 *   · `replenish`        —— 补货（原「采购」领域里的【一键补货】）；
 *   · `purchase_return`  —— 退货；
 *   · `inventory`        —— 库存表；
 *   · `product`          —— 货品标签（**不上条**，旧 `?from=product` 照旧能开 ✓）。
 *
 * ⭐⭐ 2026-10-14 晚 cut B（改前逐字 → 改后逐字 → 依据）：
 *   改前逐字：上面还列着「`accept` —— 验收（有活跃验收会话时那一块；没有就一张人话卡）；」
 *   改后逐字：**那一行删掉**（`accept` 已从 `REALMS` 退场）
 *   依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」；旧 `?from=accept` 现在按
 *        既有口径回落缺省（销售）✓（不报错、不白屏 ✓）。
 *
 * ⚠️ **只有当前这一块进 HTML**（另外五块**连字符串都不拼**）—— 页面里没有"靠 CSS 藏起来"
 *    的东西，也就没有"脚本没跑 ⇒ 什么都没显示"的可能。
 * ⚠️ 认不出的领域一律回落缺省（`resolveRealm` 在路由那一层已经做过一次；这里再兜一次，
 *    **渲染层永远不抛、永远有正文**）。
 */

module.exports = {
  sizeRowsHtml,
  returnFormHtml,
};
