const { SCAN_PAGE } = require('../../config/scanPage');
const { NEW_REALM, REALMS, DEFAULT_REALM, REALM_TEXTS, REALM_EMPTY_TEXT_KEYS, REPLENISH_REALM, PURCHASE_RETURN_REALM, foldedSpecialRowsOf, sellableCountOf } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { stockTableHtml } = require('./stockBlock');
const { labelBlockHtml } = require('./productBlock');
const { submitFeedbackAttrs } = require('./script');
const { hiddenField, saleFormHtml, specialFactsHtml } = require('./paymentBlock');
const { replenishFormHtml } = require('./replenishBlock');
const { returnFormHtml } = require('./returnBlock');

const realmEmptyHtml = (realm, config) => {
  const textKey = REALM_EMPTY_TEXT_KEYS[realm] || REALM_EMPTY_TEXT_KEYS[DEFAULT_REALM];
  const body = config.texts[textKey] || config.texts.realmEmptySalesBody;
  return `<section class="card state-msg">
<h1>${escapeHtml(config.texts.realmEmptyTitle)}</h1>
<p>${escapeHtml(body)}</p>
<a class="btn" href="?from=${escapeHtml('inventory')}">${escapeHtml(config.texts.realmEmptyAction)}</a>
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

const realmBlockHtml = (realm, view, config, write, page = {}) => {
  const id = REALMS.some((item) => item.id === realm) ? realm : DEFAULT_REALM;
  const wrap = (inner) => `<div class="realm-block realm-block--${escapeHtml(id)}">\n${inner}\n</div>`;
  // ⭐ 2026-10-13：「上新」是**外链 tab**（`external: true`），**不是页面领域** ⇒
  //   它没有自己的块内容（也没有 `?from=new` 入口）。
  //   ⚠️ 不接这一支的话，`id` 会落到**销售**那一块（它会出现「加入本单」✗——一颗外链 tab 不该渲染成建单表单）。
  if (id === NEW_REALM) return wrap(realmEmptyHtml(NEW_REALM, config));

  if (id === 'inventory') {
    // ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「**库存的表格里还是没有排除特殊码**」＋她纠正过的口径：
    //   「特殊码**有货就正常显示**，**没货就显示在折叠区**」（销售 / 补货 / 库存**同一套** ✓）
    //   ⇒ 改前：缺货的特殊码**既在表里、又在折叠区**（重复 ✗）
    //   ⇒ 改后：**表里排除"缺货的特殊码"** ✓（它们在折叠区 ✓）；
    //           ⭐ **有货的特殊码照旧在表里** ✓（一条都不许少 ✗）；普通码**一条不少** ✓
    //   ⭐ 判定复用**既有那一处** helper（`foldedSpecialRowsOf` = 缺货 ∩ 特殊码 ✓ 三处共用 ✓ 不新写 if ✗）
    const foldedRows = foldedSpecialRowsOf(view);
    const foldedSizes = new Set(foldedRows.map((row) => String(row.size_text)));
    const foldedInventory = foldedRows.map((row) => ({
      size_text: String(row.size_text), sellable: sellableCountOf(row, view?.columns),
    }));
    const tableRows = (Array.isArray(view?.rows) ? view.rows : [])
      .filter((row) => !foldedSizes.has(String(row.size_text)));
    return wrap(stockTableHtml({ ...view, rows: tableRows }, config) + specialFactsHtml(foldedInventory, REALM_TEXTS));
  }
  if (id === 'product') return wrap(labelBlockHtml(view, page?.print));
  if (id === REPLENISH_REALM) {
    // ⭐ 2026-10-11：**补货**从原「采购」领域里独立成一块（内容一个字没变）。
    const form = write && write.enabled !== false && write.replenishEnabled !== false
      ? replenishFormHtml(view, write, page, config)
      : '';
    return wrap(form || realmEmptyHtml(REPLENISH_REALM, config));
  }
  if (id === PURCHASE_RETURN_REALM) {
    // ⭐⭐ 2026-10-14（业务负责人最终口径 · 见 `docs/scan-page-tabs-2026-10-14.md`）：
    //   「退货」**回到条上** ✓ ⇒ 本块 = **退货表单**（`returnFormHtml` 一直在 ✓
    //   只是 2026-10-13 那版被"配品页"占着 ✗）· 能力一个字没删 ✗
    //   ⇒ 「配品」另开新领域 `accessory`（任务 B ✓ 待接路由/动作配置 ✓）
    const form = write && write.enabled !== false ? returnFormHtml(view, write, page, config) : '';
    // ⭐⭐ 2026-10-15（task-31 · 她真机 21:47「有库存点退货 ⇒ 只有一颗按钮」）：
    //   只读复现：**同一款 `HL55173-1|黑色|A` ⇒ `rows=11`、退货块 11 行** ✓（不是"有数据不画" ✗）；
    //   唯一能画出"一句人话 + **一颗**按钮"的是 `realmEmptyHtml` **通用兜底卡** —— 它只在
    //   "退货表单**根本没画出来**"时出现（写入口没接上 ⇒ `write` 为空 / `enabled:false` ✗）。
    //   🔴 那张卡的句子是「**这一款现在没有可退的尺码。**」＋ 一颗"看看这一款的库存 →" ⇒
    //      **有库存时这么说就是假话** ✗（她今晚看到的形状 ✓）。
    //   ⇒ 表单没画出来 ⇒ **如实说**（`returnForm.formMissing` ✓ 文案在 config 里）；
    //      "这一款真的没有可退的库存"是**另一件事**（task-28 的 `noReturnableStock` ✓）—— 两者分开 ✗。
    if (form) return wrap(form);
    return wrap(`<section class="card state-msg" data-view="return-form-missing">
<h1>${escapeHtml(config.texts.realmEmptyTitle)}</h1>
<p>${escapeHtml(SCAN_PAGE.returnForm.formMissing)}</p>
</section>`);
  }



  // sales（缺省）
  if (!write || write.enabled === false || write.saleEnabled === false) {
    return wrap(realmEmptyHtml('sales', config));
  }
  // ⚠️ 2026-10-11：「刚加入本单」那一句**上移到顶部的本单条**（`draftBarHtml`）——
  //    她无论停在哪个领域（库存 / 补货 / 退货 / 验收 / 货品）都该立刻看见 N+1。
  return wrap(saleFormHtml(view, write, page, config));
};

module.exports = {
  realmEmptyHtml,
  realmBlockHtml,
};
