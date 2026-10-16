const { SCAN_PAGE, fillText } = require('../../config/scanPage');
const { REALM_TEXTS, REPLENISH_REALM, purchaseSizeLines, purchaseSizeGroups } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { submitFeedbackAttrs } = require('./script');
const { hiddenField, pageBuildField, specialFoldShellHtml } = require('./paymentBlock');
const { multiItemBlockHtml, purchaseAmountRowHtml } = require('./multiItemBlock');
const { sizeRowsHtml } = require('./returnBlock');

const replenishFormHtml = (view, write, page = {}, config = SCAN_PAGE) => {
  const t = write.texts;
  const v = REALM_TEXTS;
  const fields = write.fields;
  // ⭐⭐ 2026-10-16（补货那三处 · 她真机截图 + 逐字）：**补货领域的渲染文案与开关**走
  //   `SCAN_PAGE.replenishForm`（与退货那一块的 `SCAN_PAGE.returnForm` 同一个形状 ✓）：
  //   · `rp.submitLabel` —— 最下面那颗蓝色按钮的文字（改前逐字 `t.replenishButton` = '生成报货订单'）；
  //   · `rp.amountRow`   —— 「整单金额」那一块**画不画**（缺省 false ⇒ 补货页上不画 ✓）。
  const rp = SCAN_PAGE.replenishForm;
  const lines = purchaseSizeLines(view);
  const sizes = lines.length ? lines : (write.sizes || []).map((item) => ({
    size_text: item.size_text, sellable: null, missing: Boolean(item.missing), checked: Boolean(item.missing),
  }));
  if (!sizes.length) return '';
  // ⭐⭐ 2026-10-14 版式改版（她：「按照**尺码×数量**的形式……**一行 3 个**，多了就换行，保持一行 3 个」）
  //   · 列数**走配置**（`--size-cols` ⇒ CSS `repeat(var(--size-cols), minmax(0, 1fr))` ⇒ 每列平分、自动换行 ✓）
  //   · 🔴 不用 `auto-fit/auto-fill`（那会随宽度变 2/4 列 ✗ 她要的是"保持一行 3 个"）
  const columnsPerRow = Number(SCAN_PAGE.purchaseSizes?.columnsPerRow) > 0
    ? Number(SCAN_PAGE.purchaseSizes.columnsPerRow) : 3;
  const cellHtml = (item, extraClass = '') => `
<li class="purchase-size-cell${extraClass}" data-purchase-size="${escapeHtml(item.size_text)}">
<span class="purchase-size__size">${escapeHtml(item.size_text)} 码</span>
<span class="purchase-size__amount"><span class="purchase-size__times">\u00d7</span>${escapeHtml(fillText(v.saleCountTemplate, { count: item.sellable ?? 0 }))}</span>
<span class="tag tag--${item.sellable > 0 ? 'success' : 'warning'}">${escapeHtml(item.sellable > 0 ? v.purchaseInStockTag : (item.missing ? v.purchaseMissingTag : v.purchaseNoneTag))}</span>
</li>`;
  // ⚠️ 判据在 realm 的 `purchaseSizeGroups`（一处逻辑 ✓）；这里只做"视图模型没给 ⇒ 退回写上下文"的兜底 ✗
  const groups = purchaseSizeGroups(view);
  const hasLines = groups.lines.length > 0 || groups.folded.length > 0;
  const visible = hasLines ? groups.lines : sizes;
  const folded = hasLines ? groups.folded : [];
  //   ⭐⭐ 2026-10-16（业务负责人真机截图 + 逐字，**补货领域**）：
  //     「我记得我要把**补货的尺码 × 数量，不用一行一个尺码，而是改为一行 3 组尺码 × 数量**这样的模式」
  //     ⚠️ **这不是"没做"** —— 2026-10-14 那次就已经加了 `.purchase-size-grid` ＋ `--size-cols`（3 列）
  //       ✓，**但一根旧 CSS 把它顶掉了**，所以线上一直是**一行一个** ✗（她截图是对的 ✓）。
  //     🔎 **根因（静默失效）**：那个 `<ul>` 上**同时挂着两个类** ——
  //       `purchase-size-grid`（**新**的 3 列网格类）＋ `purchase-sizes`（**旧一列版式的残留**）：
  //       ⚠️ 这两个类名**刻意不写成 `class="…"` 那种原文**（本仓有**读源码数次数**的既有哨兵，
  //         注释里抄一遍会让计数凭空多出来 ⇒ 假红 ✗ —— 与上面 `purchaseAmountRowHtml` 同一类坑）。
  //       · `.purchase-size-grid`（本文件 `:249`）= `repeat(var(--size-cols, 3), minmax(0, 1fr))` ⇒ **3 列** ✓
  //       · `.purchase-sizes`（本文件 `:256`，**旧一列版式的残留**）= `minmax(0, 1fr)` ⇒ **1 列** ✗
  //       两者**特异性相同**（都是单类选择器），`.purchase-sizes` 在**后面** ⇒ **后者赢** ⇒ 实际 1 列 ✗
  //     ⇒ **修法 = 把那个已无用的旧类从这两个 `<ul>` 上摘掉**（`data-view="purchase-sizes"` 锚**保留** ✓）：
  //       `.purchase-sizes` 规则随即**没有任何消费者** ⇒ `.purchase-size-grid` 的 3 列**真正生效** ✓
  //       ⚠️ **刻意不动那条 CSS 规则本身**（不删也不改）：`STYLE` 里那段 CSS 文本另有
  //         `test/fixtures/hardcodedChineseWhitelist.json` 的整块留档盯着（动它就要连带改那个夹具 ✗）
  //         ⇒ 摘一个类名是**最小且够**的那一刀 ✓（谁把类塞回来 ⇒ `test/replenishTrimThreeFixes.test.js`
  //         的 **AC-RP7** 当场红 ✓）。
  //     🔴 **功能零变化**：勾选 / 数量输入 / 字段名 / 提交顺序 / 库存数量 / 缺码·现货标记语义
  //       **一个字都没改** ✗（本刀只动那一个 `class` 属性里的一个旧类名 ✓）——
  //       钉在 AC-RP8（同一个 POST 载荷逐字相同）＋ AC-RP9（组内元素逐字仍在）✓
  const stockList = `<ul class="purchase-size-grid" data-view="purchase-sizes" style="--size-cols: ${escapeHtml(String(columnsPerRow))}">${visible.map((item) => cellHtml(item)).join('')}</ul>`
    + specialFoldShellHtml(folded, `<ul class="purchase-size-grid" data-view="purchase-sizes-folded" style="--size-cols: ${escapeHtml(String(columnsPerRow))}">${folded.map((item) => cellHtml(item, ' size-fold__item')).join('')}</ul>`);
  const rows = sizeRowsHtml({
    sizes,
    name: fields.replenishSizes,
    quantityPrefix: fields.replenishQuantityPrefix,
    quantityLabel: t.replenishQuantityLabel,
    // 补货：**缺码默认勾上**（她要补的就是缺的那些）
    checkedOf: (item) => Boolean(item.checked),
  });
  return `<section class="card">
${stockList}
<details class="disclosure" data-view="one-tap-replenish">
<summary class="disclosure__summary">${escapeHtml(v.oneTapReplenish)}</summary>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.replenish)}${pageBuildField()}
${hiddenField(fields.submitKey, write.replenishKey)}
${rows}
${rp.amountRow ? purchaseAmountRowHtml(write) : ''}
${multiItemBlockHtml(write, view, 'replenish', page)}
<button type="submit" class="btn btn--primary"${submitFeedbackAttrs(write)}>${escapeHtml(rp.submitLabel)}</button>
</form>
</details>
</section>`;
};

/**
 * 一列"尺码 + 数量"的行（补货与退货**共形**，只有字段名与是否预勾不同）。
 *
 * ⚠️ 两个表单各自是独立的 `<form>`，所以同名控件互不影响；但**字段名仍然各用各的**
 *   （配置里的 `sizes` / `return_sizes`），断言与将来的合并提交都不至于互相串。
 */
/**
 * 尺码行（补货 / 退货**共用**一份 ✓ 她是对照着看的）。
 * ⚠️ 2026-10-15（task-23）：多了两个**可选**参数 —— **不传就与改动前逐字相同** ✓
 *   · `defaultQuantity`：数量输入的默认值（**不再写死 `1`** ✗ —— 走配置 ✓）
 *   · `stockOf(item)`：**退货**那一块要的"当前库存数量"列；返回 `null` = 这一块不要这一列
 *     （补货不传 ⇒ 一个字都不变 ✓ —— 有既有断言逐字钉着 'value="1"' ✓）
 *   · 勾选框上的 `data-qty-name`：给"前端拦截"那段脚本用（**脚本里不写死字段名拼接** ✗）。
 */

module.exports = {
  replenishFormHtml,
};
