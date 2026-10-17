const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS, fillText } = require('../../config/scanPage');
const { MULTI_ITEM_ORDER } = require('../../config/multiItemOrder');
const { DEFAULT_REALM, REALM_TEXTS, saleSizeGroups } = require('../scanPageRealm');
const { realmScanConfigHtml } = require('../scanRealmScan');
const { escapeHtml } = require('./fields');
const { submitFeedbackAttrs, submitSubmittingElapsedText, submitSubmittingText } = require('./script');


const hiddenField = (name, value) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

/**
 * ⭐⭐ 2026-10-12：「她那次 400 是不是**旧页面**」这个问题，日志里答不了 ✗ ⇒ 让**页面自己说**：
 * 每个**写表单**都带一个隐藏的构建标识，她提交时随 body 回来 ⇒ warn 里就能看出来 ✓
 * ⚠️ **只加一个 hidden**（既有字段名 / 语义一个字不动 ✓）；不写死中文 ✓。
 */
const pageBuildField = () => hiddenField(
  SCAN_PAGE.pageBuildField || 'page_build', SCAN_PAGE.pageBuild || '',
);

const optionsHtml = (values, selected) => values
  .map((value) => `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(value)}</option>`)
  .join('');

/** 本单里一行的人话（配品行只有名称；鞋行是 `货号 · N 码`）。 */
const draftLineText = (t, line) => (line.accessory_record_id
  ? fillText(t.draftAccessoryItem, { name: line.accessory_name || '' })
  : fillText(t.draftItem, { itemNo: line.item_no || line.number || '', size: line.size }));

/**
 * ⭐⭐ 2026-10-11：**每件实收** —— 提交表单里**一行一双**，行尾一个数字输入框。
 *
 * 她的口径里这是第①层（每件）：`这一件实际收到多少` 是**她唯一要填的金额**；
 * 页面上**没有第二个金额输入框**（只有一个「实收金额」）。
 * ⚠️ 这些输入框同名重复（`fields.lineAmount`）⇒ POST 上来是**有序数组**，
 *    下标与本单的明细行一一对应（服务端按同一个顺序落「销售明细.实收金额」）。
 * ⚠️ 值来自会话（她加单时填过 / 上一次提交填过）—— `escapeHtml` 之后回填。
 */
const draftLinesHtml = (write) => {
  const t = write.texts;
  const fields = write.fields;
  const lines = write.draft?.lines || [];
  // ⭐ 2026-10-14 晚（她：「实收金额下的两行文字说明不需要」）⇒ 空态那句整条退场 ✗
  if (!lines.length) return '';
  const rows = lines.map((line) => {
    const label = line.accessory_record_id ? t.accessoryLineAmountLabel : t.lineAmountLabel;
    const value = line.amount === null || line.amount === undefined ? '' : String(line.amount);
    return `<div class="draft-line">
<span class="draft-line__text">${escapeHtml(draftLineText(t, line))}</span>
<input class="draft-line__amount" name="${escapeHtml(fields.lineAmount)}" inputmode="decimal" value="${escapeHtml(value)}" placeholder="${escapeHtml(t.lineAmountPlaceholder)}" aria-label="${escapeHtml(label || '')}">
</div>`;
  }).join('\n');
  return `<div class="draft-lines">${rows}</div>`;
};

/**
 * ⭐⭐ 收款行的**预置规则**（纯函数；路由与渲染层共用同一份 —— 不写第二遍）。
 *   · 正常打开页面（`rows` 没给）⇒ 预置 `count` 行，**第一行默认选中「微信」**（她 2026-10-08 定的），
 *     其余行留空（空 = 这一行不用）；
 *   · 校验失败**原地重渲染**（`rows` = 她刚填的那几行）⇒ 原样带回来，行数补齐到 `count`
 *     —— ⚠️ 补齐的那几行**不注入默认方式**（她明明没选，替她选上就等于替她记账）。
 */
const buildPaymentRows = ({ count, defaultMethod, rows } = {}) => {
  const given = Array.isArray(rows) ? rows : [];
  const total = Math.max(1, Number(count) || 1, given.length);
  return Array.from({ length: total }, (_, index) => {
    const row = given[index];
    if (row) {
      return {
        method: String(row.method || ''),
        amount: row.amount === undefined || row.amount === null ? '' : String(row.amount),
      };
    }
    return { method: given.length ? '' : (index === 0 ? String(defaultMethod || '') : ''), amount: '' };
  });
};

/**
 * ⭐⭐ 2026-10-16 A2a：**「付款情况」三档单选（全付 / 部分付 / 未付）＋「实付多少」从页面上退场** ✓
 *
 * 改前逐字：这里原来有一个 `paymentStatusHtml(write)` —— 渲染 `<fieldset class="pay-status">`
 *   三个同名 `radio`（`name="payment_status"`，取值来自 `config/scanWrite.js` 的
 *   `texts.paymentStatusOptions`）＋「实付多少」那个 `input`（`fields.paidAmount`）。
 * 改后逐字：**这一块整个不渲染**（定义删除 ＋ 两处调用点去掉 ✓）——
 *   ⇒ 页面里**没有** `name="payment_status"`、**也没有**「实付多少」✓
 * 依据 = 她 2026-10-16 逐字（「加校验，别让他带着这三个单选提交」）的**前半刀**：
 *   页面与判据**都不再依赖档位**；**档位由金额自动定**（`config/saleSettlement.js` 的 `autoModeOf` ✓，
 *   路由 `routes/scanPage.js` 在资金页那一步用它 ✓）。
 * ⚠️ **本刀不拒绝**旧档位（请求里带着它照样能提交 ✓ —— 拒绝是 A3 ✓）；
 *    `config/scanWrite.js` 里的 `PAYMENT_STATUS` / `texts.paymentStatusOptions` **仍保留**
 *    （写服务与路由换档时还要用它们 ✓ 只是**不再渲染**成控件 ✗）。
 */

/**
 * ⭐⭐ 总单层的**多笔收款**（收款方式 + 金额，一行一笔）。
 *
 * 她的例子：「本次共收 500 = 微信 200 + 现金 300」⇒ 一行一笔、方式来自「收款方式管理」。
 * ⚠️ 这一页是**零 JS** 的原生表单 ⇒"可增删行"落地成"预置 N 行（`sale.paymentRowCount`），
 *    填了金额的行才算一笔，没填的行不用"（服务端同一个判据）。
 * ⚠️ 校验失败**原地重渲染**时，`write.paymentRows` 是**她刚填的那几行**（值原样回填）。
 */
const paymentRowsHtml = (write) => {
  const t = write.texts;
  const fields = write.fields;
  const rows = Array.isArray(write.paymentRows)
    ? write.paymentRows
    : buildPaymentRows({
      count: write.paymentRowCount,
      defaultMethod: write.defaultPaymentMethod,
    });
  return rows.map((row) => `<div class="form-row form-row--pay">
<select name="${escapeHtml(fields.paymentMethod)}" aria-label="${escapeHtml(t.paymentLabel)}"><option value="">${escapeHtml(t.paymentNoneOption)}</option>${optionsHtml(write.paymentMethods, row.method)}</select>
<input name="${escapeHtml(fields.paymentAmount)}" inputmode="decimal" required min="0" placeholder="${escapeHtml(t.paymentAmountPlaceholder)}" aria-label="${escapeHtml(t.paymentAmountLabel)}" value="${escapeHtml(row.amount)}">
</div>`).join('\n');
};

/** 销售表单：**每件层**（加入本单 / 加配品）+ **总单层**（每件实收 + 付款情况 + 收款行 + 提交）。
 *
 * ⭐ 2026-10-10：卡片的说明标题（`saleHeading`，「销售（可以连着扫，最后一起提交）」）
 *   与「资金不是必填…」那句说明（`fundsPendingNote`）**都删掉** —— 子 tab 上已经写着「销售」，
 *   剩下的只留能填能点的（本单双数 / 尺码 / 每件实收 / 付款情况 / 收款行 / 按钮）。
 * ⭐⭐ 2026-10-11（**最终口径**）：
 *   · 每件**只有一个金额**：「实收金额」；
 *   · 总单加**「付款情况」三档**（全付（默认）/ 部分付 / 未付）+「实付多少」；
 *   · 收款明细**预置 1 行**（方式 + 金额，填了金额才算一笔）。
 */
const saleFormHtml = (view, write, page = {}, config = SCAN_PAGE) => {
  const t = write.texts;
  const fields = write.fields;
  const lines = write.draft?.lines || [];
  const sizeInput = sizeGroupsHtml(view, write);
  // 🔴🔴 2026-10-13（业务负责人：「我们先把**扫码页里的配品逻辑拿掉**，配品**改放在工作台里面**。
  //   也就是说，**扫码的时候就不用考虑配品信息了**」）—— 这一块（配品下拉 + 配品实收金额 + 那一颗
  //   【加入本单】）**已整块退场**，改到工作台去录（见 `docs/scan-sales-payment-flow-2026-10-13.md` 第六节）。
  //   ⚠️ **只是不再渲染**：`config/scanPage.js` 的那几条文案、`scanWriteService` 的配品能力、
  //      表的字段与历史数据**一个字都没动** ✓（AC-B1..B5/B7 那些**服务层**能力用例照旧全绿 ✓）
  //   ⚠️ 「备注（可不填）」（写进销售主表「赠品」）**仍在** —— 它在②里还要用 ✓ 见下面那个输入框。
  // 校验失败原地给她的那句话（差额）—— 没有就不渲染这一个块。
  const alert = String(write.errorText || '').trim()
    ? `<p class="form-alert">${escapeHtml(write.errorText)}</p>`
    : '';
  // 🔴🔴 2026-10-12（真机丢钱之后**合并**的）：原来这里是**两个 form** ——
  //    上面那个（尺码 + 加入本单）和下面那个（每件实收 + 付款情况 + 收款行 + 提交）。
  //    本单条还有**第三颗**不带钱的提交按钮 ⇒ 她在销售块填的钱被别的按钮吃掉 ⇒ `payment_count: 0`。
  //    ⇒ 现在**整页只有一个 form**：尺码 / 每件实收 / 付款情况 / 收款行 **都在里面**，
  //      两个按钮各自带 `action` 值（HTML 原生：提交按钮的 name=value 会进 POST）——
  //      **任何一颗按钮提交，钱字段都在**，结构上不可能再丢钱；而且零 JS。
  //    ⭐ 一单一笔 = 【选尺码】+【✅ 提交这一单（1 双）】**两下**；
  //      要多笔就点【➕ 还要加一双】（本单计数 +1，主按钮文案跟着变）。
  // ⚠️ 新文案缺省回落旧文案：渲染层**绝不因为少配一个 key 就把整块弄没了**
  //    （仓库里好几个用例自带最小 config —— 2026-10-12 实测：缺 `submitButtonCount`
  //      会让 `fillText(undefined)` 抛 ⇒ 整个销售块退化成一张空卡片）。
  const countLabel = fillText(t.submitButtonCount || t.submitButton, { count: Math.max(lines.length, 1) });
  // ══════════════════════════════════════════════════════════════════════════
  // ⭐⭐ 2026-10-16（task-59 · **销售也接上「一单多货」**）—— 业务负责人逐字：「**要：销售也接上**」
  //   ＋ Lead 裁决 **甲′**（逐字见 `test/multiItemOrderSalesChain.test.js` 的文件头）。
  //
  // 🔴 为什么**不复用** `multiItemBlockHtml`（那是补货 / 退货那一块）：
  //   既有判据 `test/multiItemOrderRender.test.js` 的 **AC-MIR1** 把它的调用点数成**恰好 2**
  //   ⇒ 销售这一块必须落在**这里**（本表单**本来就有一颗 `action=add_line` 的 submit** ✓）。
  //   判据文件头逐字写明了这条约束 ⇒ **不放宽那条判据** ✗。
  //
  // ⭐ "形状与补货一致"的**可执行**含义（两条，都不是"看着像"）：
  //   ① **同一份文案配置**（`MULTI_ITEM_RENDER_TEXTS` 的 `addButton` / `title` ⇒ **零新增中文** ✓）；
  //   ② **同一个 `data-multi-add` 钩子**（补货那块那颗入口的钩子 ✓）。
  //
  // 🔴 加货这一下**必须是本表单里的 submit**（`<form method="post">`）——
  //   补货/退货那颗是 `<a href="…?add=1">`（**GET ⇒ 天生带不走**她刚填的尺码/金额 ✗）；
  //   销售这张表单本来就是 POST 的表单 ⇒ **用它自己那颗既有 submit**（`action=add_line` ✓
  //   ⇒ 既有 `addSaleLine` ⇒ `session.sale.lines` ✓ **不新造写入口** ✗）。
  //
  // ⚠️ 开关关（`MULTI_ITEM_ORDER.enabled === false`）⇒ **那一颗逐字回到今天**（`t.addAnotherButton`）✓
  //   ⇒ 既有页面判据（`scanSaleAccessoryAndRemark` 等）与"N=1 逐字不变"都靠这个闸门 ✓。
  // ⚠️「本单已加的货品」标题**只在真的加了才出现**（本单为空时那一屏**逐字不变** ✓）；
  //   列表本身沿用**既有** `draftLinesHtml`（每行一个 `line_amount` 输入框 ⇒ 她填的钱看得见、改得动 ✓）。
  // ⚠️ 属性顺序**刻意**是 `data-multi-add` 在 `type="submit"` **之前**：
  //   判据 AC-SM-A 从 `data-multi-add` 那一处切到下一个 `>` 再核 `type="submit"` / `name` / `value`
  //   ⇒ 钩子必须出现在同一个元素**靠前**的位置（这不是风格问题，是判据切片的定义 ✓）。
  //
  // 🔴 **本单为空 ⇒ 这一屏逐字回到今天**（`t.addAnotherButton || t.addButton` ＋ **没有**任何新 DOM ✗）
  //   —— 这是"N=1 逐字不变"落在**页面**上的那一半（既有的领域渲染判据 AC-W1 / AC2 / AC5 / AC7
  //   都在空单下断言那一颗按钮的文字「加入本单」⇒ 本设计**一处都不动它们** ✓ 不需要成对迁移 ✓）。
  // ⭐ **本单已有货品 ⇒ 换那颗入口**（同一颗按钮、**同一个 `action=add_line`** ✓ 只是文案与钩子换成
  //   「＋ 再加一个货品」＋`data-multi-add`）—— **不新增第二颗同义按钮**（两颗一模一样的按钮更糟 ✗）。
  //   ⚠️「加入本单」⇒「＋ 再加一个货品」是**有意的语义递进**：第一件叫"加入本单"，
  //     已经在建多货品单了才叫"再加一个货品" ✓（依据 = 她 2026-10-16「要：销售也接上」）。
  // ══════════════════════════════════════════════════════════════════════════
  const multiItemAdd = MULTI_ITEM_ORDER.enabled === true && lines.length > 0;
  const multiItemTitleHtml = multiItemAdd
    ? `<h3 class="multi-item__title">${escapeHtml(MULTI_ITEM_RENDER_TEXTS.title)}</h3>\n`
    : '';
  const addLineLabel = multiItemAdd
    ? MULTI_ITEM_RENDER_TEXTS.addButton : (t.addAnotherButton || t.addButton);
  // ══════════════════════════════════════════════════════════════════════════
  // ⭐⭐ 2026-10-16 21:1x（本卡 ·「**销售也弹扫码框**」）——「加货成功、303 回来这一发接着扫」
  //   的**销售那一份**（业务负责人当天 21:1x 弹窗拍板「**要，销售也弹扫码框**」✓）。
  //
  // 🔴 为什么**必须有这一块**（只改配置与那条 303 是不够的 ✗）：路由把"这一页该接着扫"喂进
  //   `page.realmScan` 之后，**是渲染层**把那句话交给页面脚本的 ——
  //   而 `views/scanRealmScan.js` 那一段脚本**只在页面上存在 `data-view="realm-scan-config"`
  //   这个宿主时才启动**（`layout.js` 也**按同一个标记**决定发不发那一段 `<script>` ✓）——
  //   补货 / 退货那一块一直有（`multiItemBlock.js` ✓），**销售这一块此前没有** ✗
  //   ⇒ 销售页即使带 `?scan=1` 回来也**不会弹**（这正是本卡要补的那一格 ✓）。
  //
  // 🔴 **与 `multiItemBlock.js` 那一份逐字同形**（同一份 `page.realmScan` 参数、同一处
  //   `<` ⇒ `\u003c` 的转义 —— CodeQL `js/incomplete-sanitization` 挡的就是"只过 escapeHtml"✗）。
  //   判据把这件事钉死：`test/salesRealmScan.test.js` 的 **AC-SR2b** 把**销售**与**补货**两边
  //   渲染出来的 `data-config` 逐字比一遍 ⇒ **哪一边漂了就红** ✓（不是"看着像" ✗）。
  //
  // 🔴 **只在 `page.realmScan` 非空时出**（= 开关开着 ＋ 这一页配了链 ＋ URL 上真带触发参数 ✓）
  //   ⇒ 其余任何时候**一个字节都不多** ✓ —— 页面一加载就弹相机那种坑从这里堵死 ✗（`AC-SR4`）。
  // ══════════════════════════════════════════════════════════════════════════
  const realmScanBlock = realmScanConfigHtml({
    configJson: (page.realmScan
      ? escapeHtml(JSON.stringify({
        realm: String(page.realmScan.realm || ''),
        // ⭐ 落点是**扫完那一刻现算**的（"扫到的是哪一件"服务端此刻不可能知道 ✗）——
        //   所以这里只给**参数**：领域键 / 记录路径段 / 本页来源 ＋ 认不出的上限 ✓
        origin: String(page.realmScan.origin || ''),
        realmQueryKey: String(page.realmScan.realmQueryKey || ''),
        recordBasePath: String(page.realmScan.recordBasePath || ''),
        maxScannedLength: Number(page.realmScan.maxScannedLength) || 0,
        signaturePath: String(page.realmScan.signaturePath || ''),
        reportPath: String(page.realmScan.reportPath || ''),
        sdkTimeoutMs: Number(page.realmScan.sdkTimeoutMs) || 0,
        scanTimeoutMs: Number(page.realmScan.scanTimeoutMs) || 0,
        texts: page.realmScan.texts || {},
      }).replace(/</g, '\\u003c'))
      : ''),
    scanNow: page.realmScan?.scanNow === true,
  });
  return `<section class="card">
<p class="draft-count">${escapeHtml(fillText(t.draftHeading, { count: lines.length }))}</p>
<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(write.fields.submitKey, write.saleKey)}${pageBuildField()}
${sizeInput}
<div class="form-row"><label>${escapeHtml(t.amountLabel)}</label><input name="${escapeHtml(fields.amount)}" inputmode="decimal" placeholder="${escapeHtml(t.amountPlaceholder)}"></div>
${alert}
${multiItemTitleHtml}${draftLinesHtml(write)}
${String(write.errorText || '').trim() ? `${paymentRowsHtml(write)}` : ''}
<!-- ⭐⭐ 2026-10-13（金额两步走）：整单那一组（档位 / 收款行 / 备注）**整块挪到第 2 步页**
     ⇒ 录入页只留：每双 颜色 · 尺码 · 这一双的金额 ✓（那一组的字段名与标签字面量一个都不许留，否则 AC-2S1/AC-1 会打红） -->
<button type="submit" class="btn btn--primary" name="${escapeHtml(fields.action)}" value="${escapeHtml(write.actions.submitOrder)}" data-submit-feedback="${escapeHtml(submitSubmittingText(write))}" data-submitting-elapsed="${escapeHtml(submitSubmittingElapsedText(write))}">${escapeHtml(countLabel)}</button>
<button${multiItemAdd ? ' data-multi-add' : ''} type="submit" class="btn" name="${escapeHtml(fields.action)}" value="${escapeHtml(write.actions.addLine)}"${submitFeedbackAttrs(write)}>${escapeHtml(addLineLabel)}</button>
</form>
${lines.length ? `<form method="post" action="${escapeHtml(write.postAction)}" class="write-form">
${hiddenField(fields.action, write.actions.clearDraft)}${pageBuildField()}
${hiddenField(fields.submitKey, write.saleKey)}
<button type="submit" class="btn btn--ghost"${submitFeedbackAttrs(write)}>${escapeHtml(t.clearButton)}</button>
</form>` : ''}${realmScanBlock}
</section>`;
};

/**
 * ⭐ 销售建单的**尺码两组**（业务负责人 2026-10-09：「选的是库存里面的 = 现货；不是 = 预订」）：
 *   · 第一组 = **有货（样品 + 门盒）**的尺码 ⇒ 选中它 = **现货**；
 *   · 第二组 = 该组（类别）**目前没有的**尺码 ⇒ 选中它 = **预订**。
 *
 * ⚠️ 分组**只来自视图模型**（`views/scanPageRealm.saleSizeGroups`）—— 页面上看到的两组
 *    与提交时判"现货 / 预订"用的是**同一份**（路由按同一份算 `inStock`）。
 * ⚠️ 没有一行 JS：两个 `<fieldset>` 里的 radio 都叫 `size`，选哪个就是哪个；
 *    每个可选项都是一整块（≥44px 命中区，见 STYLE 的 `.size-chip`）。
 * ⚠️ 视图模型里一行尺码都没有时（老数据 / 降级）退回 `write.sizes`，**不把页面空着**。
 * ⭐ 2026-10-10：「选这一组 = 现货 / 预订…」那两句说明与「（这一组 = 男 A · 38–48）」那句备注
 *    **都删掉** —— 组名 + 状态小标签 + 能选的尺码就够了。
 * ⭐⭐ 2026-10-11（业务负责人）：**一行 4 个码、卡上不显示数量**（四列网格见 STYLE 的
 *    `.size-chips`）——「你不用管数量，只要它实时库存表里面有，你显示就行」。
 *    ⇒ 这里**不再渲染 `size-chip__meta`**（原来它写着「N 双」/「预订」）：
 *       数量只在「库存」页看；「预订」已经在**组标题**那颗小标签上了，卡上不必每张重复。
 */
const sizeGroupHtml = ({ id, heading, tag, tone, items, empty }) => `
<fieldset class="size-group" data-stock-group="${escapeHtml(id)}">
<legend class="size-group__legend">
<span class="size-group__title">${escapeHtml(heading)}</span>
<span class="tag tag--${escapeHtml(tone)}">${escapeHtml(tag)}</span>
</legend>
<div class="size-chips">${items.length
    ? items.map((item) => `<label class="size-chip">
<input type="radio" name="size" value="${escapeHtml(item.size_text)}">
<span class="size-chip__size">${escapeHtml(item.size_text)} 码</span>
</label>`).join('\n')
    : `<span class="hint">${escapeHtml(empty)}</span>`}</div>
</fieldset>`;

/**
 * ⭐ 2026-10-14（她的最终口径）：「特殊码」折叠块 —— 原生 `<details>`（**零 JS** ✓）
 *   · **默认收起** ⇒ 浏览器原生：内容**不可见 + 不占布局高度** ✓（不用自己写 display:none ✗）
 *   · `<summary>` ≥44px（`--control-height`）⇒ 手机上点得到 ✓
 *   · 文案全走 `config.specialSizes.toggleLabel`（**渲染层不写死中文** ✗）
 *   ⚠️ 里面那张卡与外面**同规则**（`name="size"` 的 radio、`.size-chip` ⇒ 命中区一样 ✓）
 */
const specialFoldShellHtml = (items, inner) => {
  const cfg = SCAN_PAGE.specialSizes || {};
  if (cfg.foldable === false || !items.length) return '';
  const open = cfg.collapsedByDefault === false ? ' open' : '';
  return `
<details class="size-group size-fold" data-special-fold="1"${open}>
<summary class="size-group__legend size-fold__summary">
<span class="size-group__title">${escapeHtml(cfg.toggleLabel || '')}</span>
<span class="tag tag--warning">${escapeHtml(String(items.length))}</span>
</summary>
${inner}
</details>`;
};

/** 销售页那一块（#515）：折叠块里是**能选的尺码卡**（与外面同规则：`name="size"` 的 radio ✓） */
const specialFoldHtml = (items) => specialFoldShellHtml(items, `<div class="size-chips">${items.map((item) => `<label class="size-chip">
<input type="radio" name="size" value="${escapeHtml(item.size_text)}">
<span class="size-chip__size">${escapeHtml(item.size_text)} 码</span>
</label>`).join('\n')}</div>`);

/** 库存 / 补货共用：折叠块里的条目**只是事实**（尺码 + 数量），不是可点的卡 ✓ */
const specialFactsHtml = (items, v) => specialFoldShellHtml(items, `<ul class="size-fold__list">${items.map((item) => `
<li class="size-fold__item" data-folded-size="${escapeHtml(item.size_text)}">
<span class="size-fold__size">${escapeHtml(item.size_text)} 码</span>
<span class="size-fold__times">\u00d7</span>
<span class="size-fold__count">${escapeHtml(fillText(v.saleCountTemplate, { count: item.sellable ?? 0 }))}</span>
</li>`).join('')}</ul>`);

const sizeGroupsHtml = (view, write) => {
  const t = REALM_TEXTS;
  const groups = saleSizeGroups(view);
  const fallback = (write.sizes || []).map((item) => ({ size_text: item.size_text, missing: Boolean(item.missing) }));
  const inStock = groups.inStock.length || groups.prepaid.length
    ? groups.inStock
    : fallback.filter((item) => !item.missing).map((item) => ({ size_text: item.size_text, count: null }));
  const prepaid = groups.inStock.length || groups.prepaid.length
    ? groups.prepaid
    : fallback.filter((item) => item.missing).map((item) => ({ size_text: item.size_text, count: 0 }));
  if (!inStock.length && !prepaid.length) return `<span class="hint">${escapeHtml(t.saleSizeEmpty)}</span>`;
  // ⚠️ 2026-10-11 起**不再算每个码的数量文案**（`countText` 已退场）：卡上只有尺码本身，
  //    数量只在「库存」页看；两组的分法由 `saleSizeGroups` 决定，一个字没变。
  return sizeGroupHtml({
    id: 'in_stock',
    heading: t.saleInStockHeading,
    tag: t.saleInStockTag,
    tone: 'success',
    items: inStock,
    empty: t.saleSizeEmpty,
  }) + sizeGroupHtml({
    id: 'prepaid',
    heading: t.salePrepaidHeading,
    tag: t.salePrepaidTag,
    tone: 'warning',
    items: prepaid,
    empty: t.saleSizeEmpty,
  }) + specialFoldHtml(groups.folded || []);
};

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人**逐字**）：「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」
 *   ⇒ **退货运这一个渲染片段**（一个输入、一个总额 ✓ 不按行分填 ✗）：
 *     · 字段名来自 `fields.purchaseAmount`（= 配置 `PURCHASE_AMOUNT.field` 的唯一来源 ✓）；
 *     · 标签 / 占位来自 `texts.purchaseAmount*`（改文案只改配置 ✓ 不写死 ✗）。
 *   ⚠️ 这里是**唯一**一处画这个输入的地方 —— 将来改版式/加输入属性只改这一个函数
 *     （各抄一份 = 迟早改漏一个 ✗）。
 *
 *   ⭐⭐ 2026-10-16（她逐字：「这个是报货的页面，**还是需要填写金额啊**」✗）**成对翻新**：
 *     改前逐字：**补货 + 退货两个表单各调它一次**（两处都是无条件调用的那一行 ✗）；
 *     改后逐字：**只有退货那一处无条件调它** ✓ —— 补货那一处改成
 *       一个**三元表达式**：先问配置 `rp.amountRow`，真才调它（**按配置**决定画不画 ✓
 *       缺省 `SCAN_PAGE.replenishForm.amountRow === false` ⇒ **她截图上那个框不再出现** ✓）。
 *     ⚠️ 这里**刻意不把那两处的代码原文抄进注释**：本仓有**读源码数次数**的既有哨兵
 *       （`test/scanPurchaseAmountRequired.test.js` AC-PA5 ④ 数"那个片段被调了几次"），
 *       注释里抄一遍会让计数**凭空多出来** ⇒ 那是"注释把判据顶红"的假红 ✗。
 *     依据：她 2026-10-16 真机截图（补货 tab · 货品 832-500）＋ 逐字「还是需要填写金额啊」
 *       ＋（背景）她早定的「**补货不问金额**」（校验那一半 = `requiredByRealm.replenish === false` ✓ #689）。
 *     ⚠️ **不是放宽**：这个函数**本身一个字没改**（退货的字段名/标签/占位逐字不变 ✓）；
 *       补货那一侧是**更强的反向判据**（`test/replenishTrimThreeFixes.test.js` AC-RP1：塞回即红 ✓）。
 */

module.exports = {
  buildPaymentRows,
  hiddenField,
  pageBuildField,
  paymentRowsHtml,
  saleFormHtml,
  specialFoldShellHtml,
  specialFactsHtml,
};
