const { multiItemBlockHtml, multiItemPayloadJson, MULTI_ITEM_ITEM_KEYS, MULTI_ITEM_ENTRY_KEYS } = require('./multiItemBlock');
const { readThemeTokens, canScanNextWithFeishu, PAYMENT_STEP_STYLE, REALM_BAR_STYLE, SKELETON_STYLE, STYLE } = require('./styles');
const { buildPaymentRows, paymentRowsHtml } = require('./paymentBlock');
const { SCAN_PAGE, fillText } = require('../../config/scanPage');
// ⭐⭐ 2026-10-16（task-52 收尾）：**成功页统一极简**的配置真源（开关 ＋ 那一句 ✓ 见 config/scanSuccessPage.js）
const { SCAN_SUCCESS_PAGE, minimalSuccessOverrides } = require('../../config/scanSuccessPage');
const { DEFAULT_REALM, resolveRealm } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { identityHtml, noScriptHtml, realmBarHtml, renderDocument } = require('./layout');
const { draftBarHtml } = require('./draftBlock');
const { submitFeedbackAttrs, submitSubmittingElapsedText, submitSubmittingText } = require('./script');
const { realmBlockHtml, realmEmptyHtml } = require('./realmBlock');


/**
 * 正常页：**本单条**（顶部固定）+ 领域切换（真链接）+ 身份区 + 单价 + **当前领域那一块**。
 *
 * ⚠️ 渲染层**绝不抛**：任何一块拼装出问题都退化成一张人话卡片 ——
 *    这一页对她是"扫码就能看"，**空白页是最坏的结果**（比她看到一句"暂时打不开"还坏）。
 *
 * `page.userAgent`（可选，路由从请求头传）= 【继续扫下一个】那一个按钮的判据
 * （见 `canScanNextWithFeishu`）；不传 = 认成"不是飞书客户端" ⇒ 给那句人话，不给死按钮。
 */
/**
 * ⭐⭐ 2026-10-13（她的口径，逐字）：「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，
 *   **应该就跟这一单没关系了**，除非我是选"**再加一双**"呀」
 *  ⇒ **销售领域入口页**（= 她说的"销售首页"）：**不带任何编号/货号** ✗，只有
 *     ①（可选）「上一单已提交（单号）」（来自回跳 URL 的 `?done=` ✓ 无状态）
 *     ②「请扫下一个标签」+ ③ 手输编号兜底框
 *  ⚠️ 文案全走 config（模板里不写中文 ✓）；**不含本单清单**（那是"同一单"才有的东西 ✗）。
 */
const renderSalesHome = ({ config = SCAN_PAGE, orderNo = '', basePath = '' } = {}) => {
  const texts = config.texts || {};
  const prefix = String(basePath || '');
  const notice = String(orderNo || '').trim()
    ? `<p class="notice notice--ok" data-view="sales-home-submitted">`
      + `${escapeHtml(fillText(texts.salesHomeJustSubmitted || '', { orderNo: String(orderNo).trim() }))}</p>`
    : '';
  return renderDocument({
    title: texts.salesHomeTitle || texts.pageTitle,
    config,
    content: `<main class="page" data-view="sales-home">
${notice}
<h1 class="title">${escapeHtml(texts.salesHomeTitle || '')}</h1>
<p class="notice">${escapeHtml(texts.salesHomeHint || '')}</p>
<form method="get" action="${escapeHtml(prefix)}/" class="write-form" data-view="sales-home-manual">
<label class="field"><span>${escapeHtml(texts.salesHomeManualLabel || '')}</span>
<input type="text" name="number" value="" autocomplete="off" inputmode="text"></label>
<button type="submit" class="btn btn--primary">${escapeHtml(texts.salesHomeManualSubmit || '')}</button>
</form>
</main>`,
  });
};

const renderScanPage = (view = {}, config = SCAN_PAGE, write = null, realm = DEFAULT_REALM, page = {}) => {
  const safeRealm = resolveRealm(realm);
  let block;
  try {
    block = realmBlockHtml(safeRealm, view, config, write, page);
  } catch (error) {
    block = `<div class="realm-block realm-block--${escapeHtml(safeRealm)}">${realmEmptyHtml(safeRealm, config)}</div>`;
  }
  // ⚠️ 验收模式下**不挂销售本单条**：那一条讲的是"销售本单几双"，与"这次验收扫了几双"
  //    是两件事，同屏出现只会让她看错数（验收自己的本单条在验收块里）。
  const bar = draftBarHtml(write, config, page?.userAgent, safeRealm, {
      // ⭐ 2026-10-12：销售页上那颗**带钱**的提交表单就在下面 ⇒ 本单条不再放第二颗提交按钮。
      moneyFormOnPage: safeRealm === DEFAULT_REALM && Boolean(write),
    });
  // ⛔ 2026-10-16 22:0x（业务负责人逐字：「**存草稿的功能都删除吧……整个链路都删除**」）——
  //   改前逐字：`const draftNotice = draftNotice` ＋ `Html(safeRealm, config, page);`（「你有一份草稿，接着录吗？」那张卡）
  //   改后逐字：**这一处不渲染任何东西**（恒为空串 ✓；`${draftNotice}` 那个占位随之失效但**不改变页面输出** ✓）
  //   依据 = 她 2026-10-16 22:0x 上面那句 ✓（整条存草稿链退场 ⇒ 提示条也退场 ✓）
  const draftNotice = '';
  // ⭐⭐ 2026-10-12（编号兜底）：编号缺段（典型 = 缺「类别」）但按（货号 + 颜色）**唯一命中**时，
  //    页面上出**一条轻提示**（一句话，不写说明书）——她才知道"这个标签该重打了"。
  const fallbackHint = view.number_fallback
    ? `<p class="notice">${escapeHtml(config.texts.numberFallbackHint)}</p>` : '';
  return renderDocument({
    title: fillText(config.texts.pageTitle, { itemNo: view.item_no || view.number, number: view.number }),
    config,
    // ⭐⭐ 2026-10-14（业务负责人逐字）：「**② 和 ③ 换一下位置，即先 3 后 2**」
    //   ⇒ **货品卡在上、6 格 tab 条在下** ✓（原来是反的 ✗）· 只改顺序 ✓ 内容一字不动 ✗
    content: `${bar}
${draftNotice}
${identityHtml(view, config)}
${realmBarHtml(safeRealm, page?.userAgent)}
${noScriptHtml()}
${fallbackHint}
${block}
<p class="foot">${escapeHtml(config.texts.footerNumberLabel)} <span class="mono">${escapeHtml(view.number)}</span>`
  + `${view.updated_at_text ? ` · ${escapeHtml(config.texts.updatedAtLabel)} ${escapeHtml(view.updated_at_text)}` : ''}</p>`,
  });
};

/**
 * 「不是库存表」的那些页（没找到 / 链接不对 / 出错 / 数据准备中 / 超上限 / **写失败**）——
 * 一张都不许白屏：标题 + 一句人话 + （有的话）她扫到的编号与我给她的重试建议。
 *
 * `details` 是**写成功/写失败**时给她看的几行事实（单号 / 双数 / 批次号…）：
 * 有就逐行列出来，没有就一个字都不多渲染（既有那几种页面**逐字不变**）。
 * ⚠️ 这些页面**不挂领域切换条**（它们是"结果页"，不是她操作的地方）。
 *
 * ⭐⭐ 2026-10-12（业务负责人真机口径）：「页面跳转到提交成功页……给一个**链接**让我能回到扫码页」——
 * `backPath` + `backLabel`（+ 可选 `backHint`）就是那颗**回扫码页**的链接；
 * `tone` 只用来加一个类（`success` ⇒ H1 走主色）。
 * 🔴 **不传这三样时，输出与改前逐字相同**（既有那些结果页一个字都没动）。
 */
const renderScanMessagePage = ({
  title, body, number = '', requestId = '', retryHint = '', details = [],
  backPath = '', backLabel = '', backHint = '', tone = '',
  // ⭐⭐ 2026-10-12（方案 A）：成功后**自动回首页**（`returnPath` = 服务端渲染的确定 URL ✓）
  //    + 一颗【返回扫码】兜底（href 与自动跳转**同一个 URL** ⇒ 唯一来源 ✓）。
  returnPath = '', returnLabel = '', returnDelaySeconds = 0, autoReturnUrl = '',
  // ⭐ 2026-10-13（成功页三入口）：透明的"追加动作块"—— 不传 = 既有页面逐字不变 ✓
  extraActionsHtml = '',
  // ⭐⭐ 2026-10-16（task-52 收尾 · 成功页统一极简）：配置源（缺省 = `config/scanSuccessPage.js` ✓）
  //    判据可直接注入 `{ minimalEnabled: true, minimalText: '…' }` ⇒ 不必改 env ✓
  successPage = null,
  // ⭐⭐ 2026-10-17 02:5x **成对迁移（补上缺失的消费者）· 改前逐字 → 改后逐字 → 依据**：
  //   改前逐字：参数表里**没有 `order_no`** ✗ ⇒ 路由 payload 里的 `order_no`（`routes:2732` ✓）
  //     被**静默丢掉** ⇒ 成功页上**看不到单号** ✗（她 23:5x 逐字：「**那我肯定能看到这个单号呀**」✓）
  //   改后逐字：⭐ **收下它** ✓（`order_no` 就是 `routes:965` 那个 `payload` 的键 ✓ 原样传进来的 ✓）
  //     ＋ ⭐ 在**极简覆盖之外**渲染一行**纯文案** ✓（否则会被 `minimalSuccessOverrides` 吃掉 ✗ —— 实测 ✓）
  //   依据 = 她 2026-10-16 23:5x「**那我肯定能看到这个单号呀**」＋「**就一页、没有按钮没有链接、
  //         也不自动跳（你得自己点返回），按照这个，保持现状**」✓（两句要**同时**满足 ✓）
  order_no = '',
}, config = SCAN_PAGE) => {
  // ⭐ **只在成功页**上套用；**开关关着 ⇒ minimal = {} ⇒ 下面每一处都逐字不变** ✓（零回归 ✓）
  const minimal = tone === 'success' ? minimalSuccessOverrides(successPage || SCAN_SUCCESS_PAGE) : {};
  const eff = {
    body, details, number, retryHint, backPath, backLabel, backHint,
    returnPath, returnLabel, returnDelaySeconds, autoReturnUrl, extraActionsHtml,
    ...minimal,
  };
  // ⭐⭐ 单号那一行（**极简覆盖之外** ✗ ⇒ 不会被吃掉 ✓）：
  //   · ⭐ **号非空才出现** ✓（空 ⇒ 整行不出现 ✗ **不显示空括号** ✓）
  //   · ⭐ **纯文案**（无 `<a>` / 无按钮 / 无跳转 ✓ —— 零链接零按钮零自动跳是她定的 ✓）
  //   · ⭐ **文案走 config** ✗（模板里不写中文 ✓）—— ⭐ 取自 **`SCAN_SUCCESS_PAGE.orderNoText`** ✓
  //     （⭐ **不读 `config.texts.…`** ✗：这文案属于**成功页**那份配置 ✓、与 `minimalSuccessOverrides` 同一个家 ✓
  //       ⇒ ⭐ **不必动 `config/scanPage.js`** ✓ 依据 = 她 23:5x「那我肯定能看到这个单号呀」✓）
  //   · ⭐ **键缺省为空 ⇒ 整行不出现** ✓（向后兼容 ✓ 且"没有号"时**逐字节不变** ✓ —— 判据 `AC-REG1` 锁着 ✓）
  const orderNoNotice = String(order_no || '').trim();
  const orderNoTemplate = String((successPage || SCAN_SUCCESS_PAGE).orderNoText || '').trim();
  const orderNoHtml = tone === 'success' && orderNoNotice && orderNoTemplate
    ? `<p class="foot" data-view="success-order-no">${escapeHtml(
      orderNoTemplate.replace(/\{orderNo\}/g, orderNoNotice),
    )}</p>`
    : '';
  return renderDocument({
  title,
  config,
  requestId,
  // ⚠️ 用 `<meta http-equiv="refresh">`（**不是 JS**）：老手机 / 禁脚本也能跳，且 URL 是**服务端写的** ✓
  head: eff.autoReturnUrl && eff.returnDelaySeconds > 0
    ? `<meta http-equiv="refresh" content="${Number(eff.returnDelaySeconds)};url=${escapeHtml(eff.autoReturnUrl)}">`
    : '',
  // ⚠️ **`<section class="card state-msg">` 这一串逐字不变**（连成功页也一样）：
  //    有断言按这串取"她看得见的那张卡"，在 section 上多加属性/class 会把它们悄悄打红。
  //    所以"成功"这个色调只挂在 **h1 的 class** 与那颗 ✅ 上。
  content: `<section class="card state-msg">
${tone === 'success' ? '<p class="state-msg__mark" aria-hidden="true">✅</p>' : ''}
<h1${tone === 'success' ? ' class="state-msg__title--success"' : ''}>${escapeHtml(title)}</h1>
<p>${escapeHtml(eff.body)}</p>
${eff.details.length ? `<ul class="result">${eff.details.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
${eff.number ? `<p>${escapeHtml(config.texts.notFoundHint)}<span class="number mono">${escapeHtml(eff.number)}</span></p>` : ''}${orderNoHtml}
${eff.retryHint ? `<p class="hint">${escapeHtml(eff.retryHint)}</p>` : ''}
${eff.backPath && eff.backLabel ? `<a class="btn btn--primary back-link" href="${escapeHtml(eff.backPath)}">${escapeHtml(eff.backLabel)}${eff.backHint ? `<span>${escapeHtml(eff.backHint)}</span>` : ''}</a>` : ''}
${eff.returnPath && eff.returnLabel ? `<a class="btn" data-view="success-return" href="${escapeHtml(eff.returnPath)}">${escapeHtml(eff.returnLabel)}</a>` : ''}
${eff.extraActionsHtml}
</section>`,
  });
};

/**
 * ⭐⭐ **提交成功页**（`POST submit_order` 写成功之后 POST 直接渲染的就是这一页；
 * 不 303、不回原页 —— 业务负责人的口径是"点完**直接**告诉我成功"）。
 *
 * 🔴 它**不是**新的书写方式，只是"消息页 + 成功色调 + 一颗回扫码页的链接"这一组约定的**一个名字**：
 *    `renderScanMessagePage({ tone: 'success', backPath, backLabel, ... })`。
 *    这样"成功页长什么样"只有一处定义，将来改版不用满仓库找。
 * 🔴 只在**真的写成功**时用：建单失败 ⇒ 照旧报错页；建单成功但后面某步没写完 ⇒
 *    `partialFailed*`（**不许**显示成功）。
 */
/**
 * ⭐⭐ 2026-10-13「金额两步走」第 2 步：**整单付款屏**（提交成功之后落到这里）。
 *
 * 口径（业务负责人逐字）：三档「全付 / 部分付 / 未付」**横向一排**（垂直占屏太高 ✗）
 *   + 付款方式**可加多行** + **赠品** + 「**跳过**」。
 * ⭐ **可填可不填** ⇒ 不填 = 这一单先记成**待补充**的信息单（**不是失败** ✗ 不许报错拦人）。
 *
 * ⚠️ 本轮只落**页面与入口**（文案/结构/横向布局由 AC 钉住）；
 *    "填进去的钱怎么落库"要走**既有**的唯一收款入口 —— 那一支还没接（见 PR 说明），
 *    所以这一屏的按钮**不假装已经记了钱** ✗：只给「跳过」与「去工作台补收款」两条真路径。
 */
const renderSalePaymentStepPage = ({
  write = null, orderNo = '', config = SCAN_PAGE, basePath = '',
  // ⭐ 2026-10-13（ⓒ 落点）：`successPath` = 成功页（【跳过】就去那里）；
  //    `workbenchPath` = 既有「补记收款」入口（默认 `/workbench`）。
  successPath = '', workbenchPath = '',
  // ⭐ 跳过 = POST 动作（`paymentStep.skipAction`）；这三个隐藏字段把"成功页要显示的事实"带过去 ✓
  postAction = '', submitKey = '', count = 0, reused = false,
  // ⭐ 第 2 步付款要写进「收款明细」⇒ 需要刚提交那张销售主表的 record_id（`submitSale` 返回里有 ✓）
  salesEntryRecordId = '',
  // ⭐⭐ 2026-10-14（她：**点资金页按钮才建单**）：结算校验没过时**原地重渲染这一页**并把这句人话带回来 ✓
  //   （文案由**调用方**给 —— 用的是既有那几条文案真源 ✓ 这里只负责画 ✗ 不新造中文 ✓）
  notice = '',
} = {}) => {
  const step = { ...(config.paymentStep || {}) };
  const t = (write && write.texts) || {};
  const fields = (write && write.fields) || {};
  // ⚠️ `successPath` / `workbenchPath` 两个入参**保留**（调用方还在传 ⇒ 签名不动 ✓）——
  //    但 2026-10-16 那一刀之后，本页**不再渲染任何"跳走"的东西**（那颗 `<a href={销售首页}>`
  //    与工作台提示都删了 ✗）⇒ 原来"没有 successPath 就会给出一个点不动的链接"那个风险**没了** ✓。
  // ⭐ 2026-10-16 A2a：**三档那一块不再渲染**（`paymentStatusHtml` 已退场 ✓ 见上面那条注释）——
  //    资金页现在只剩：**收款行**（`paymentRowsHtml`）＋ 赠品 ✓；档位由金额自动定（路由那一步 ✓）。
  const rowsBlock = paymentRowsHtml(write);
  // ⭐⭐ 2026-10-17 C（她逐字：「默认一行 ＋ ＋ 再加一种付款方式」）：
  //   加行 = **纯前端**（`data-payment-add`，克隆最后一行并清空值）——不提交、不写库 ✓。
  //   ⚠️ 文案走配置（`step.addRowButton`）；不写死中文 ✗。
  const addRowButtonHtml = `<button type="button" class="btn" data-payment-add>${escapeHtml(step.addRowButton || '')}</button>`;
  const giftFieldHtml = `<div class="form-row"><label>${escapeHtml(t.giftLabel || '')}</label><input name="${escapeHtml(fields.gift || 'gift')}"></div>`;
  // ⭐⭐ 2026-10-13 结构重排（**行为不变**）：三件套（三档 / 收款行 / 赠品）先攒成一块，
  //    由 `payForm` 统一放进"提交整单付款"那张表单里（**在表单外就是"提交上去什么都没有"** ✗）。
  //    ⚠️ 还没配 `payAction` 时 ⇒ 退化成原来那个 `<div class="payment-step">`（逐字同形 ✓ 不吃亏 ✓）
  //    ⭐ 2026-10-16 A2a：三件套里的**「三档」那件已退场** ⇒ 现在只有**收款行 + 赠品** ✓
  const paymentFieldsHtml = `${rowsBlock}${addRowButtonHtml}${giftFieldHtml}`;
  const payForm = (postAction && step.payAction)
    ? `<form method="post" action="${escapeHtml(postAction)}" data-view="payment-pay">
<input type="hidden" name="${escapeHtml(fields.action || 'action')}" value="${escapeHtml(step.payAction)}">
${submitKey ? `<input type="hidden" name="${escapeHtml(fields.submitKey || 'submit_key')}" value="${escapeHtml(submitKey)}">` : ''}
<input type="hidden" name="order_no" value="${escapeHtml(orderNo)}">
<input type="hidden" name="count" value="${escapeHtml(String(count))}">
${salesEntryRecordId ? `<input type="hidden" name="sales_entry_record_id" value="${escapeHtml(salesEntryRecordId)}">` : ''}
${reused ? '<input type="hidden" name="reused" value="1">' : ''}
${paymentFieldsHtml}
<button type="submit" class="btn btn--primary" data-tap-target="${escapeHtml(step.payAction || '')}"${submitFeedbackAttrs(write)} data-submit-feedback="${escapeHtml(submitSubmittingText(write))}" data-submitting-elapsed="${escapeHtml(submitSubmittingElapsedText(write))}">${escapeHtml(step.payButton || '')}</button>
</form>`
    : `<div class="payment-step">${paymentFieldsHtml}</div>`;
  return renderDocument({
    title: step.heading,
    config,
    // ⭐ `data-view="payment-step"` = 第 2 步页的**稳定标记**（测试顺着它决定"要不要再走一步"✓）
    content: `<section class="card state-msg" data-view="payment-step">
<h1>${escapeHtml(step.heading)}</h1>
${orderNo ? `<p class="foot">${escapeHtml(orderNo)}</p>` : ''}
<p class="hint">${escapeHtml(step.pendingNote || '')}</p>
${String(notice || '').trim()
    // 🔴 2026-10-16 P0：拦下的原因**必须醒目**（她真机"看着像坏了"✗）——从 `hint`（小字）
    //   提到 `form-alert`（红色告警级 ✓）；`data-view` 钩子**保留**（既有判据还在用 ✓）
    ? `<p class="hint" role="alert" data-emphasis="alert" data-view="payment-step-notice">${escapeHtml(String(notice).trim())}</p>`
    : ''}
${payForm}
<!-- 🔴 2026-10-16（她逐字：「资金页上……那三处提示【全删】……全删就对了」）：
     原来这里还有一句工作台提示（step.workbenchHint）——**整句删** ✗（键也一起删了 ✓）。 -->
<!-- 🔴 2026-10-16（她逐字：「资金页实际上就应该有两个按钮」= 提交 / 跳过）⇒ **资金页不再渲染
     那颗跳工作台的链接** ✗（她把它误读成第三种付款方式）——补收款去成功页那颗 ✓ -->
<!-- 🔴🔴 2026-10-17 C（业务负责人逐字：「**去「跳过」**」）：
     原来这里还有**第二张表单**（skipAction = payment_skip ＋ skipButton = 「跳过」）——
     **整块删** ✗。资金页现在**只有一颗**「提交整单付款」（payButton）。
     ⚠️ 不写金额直接提交 = **未付**（差额自动挂一条【未收款】✓ 既有结算校验负责）；
        收多了 ⇒ 拦住 + 说差额（既有 amount_mismatch 人话 ✓）。
     ⚠️ 重复提交（同一把 submitKey）⇒ **仍然说「这一单刚才已经交过了」**（pay 分支已对齐 skip 口径 ✓）。
     🔴 反向哨兵见 test/scanPagePaymentButtons.test.js AC-PB1（skipButton 回来即红 ✓）。
     ⚠️ 路由侧的 payment_skip 处理器**保留**（既有判据仍直接 POST 它 ✓ 本次只删 UI ✗）。 -->
</section>`,
  });
};

const renderSaleSuccessPage = (input = {}, config = SCAN_PAGE) => {
  const success = { ...(config.saleSuccess || {}) };
  const orderNo = String(input.order_no || input.orderNo || '').trim();
  const number = String(input.number || '').trim();
  // ⚠️ 单号按 `order_no` 原样显示（形如 `XSD-…`）；没有就不编一个 ✗。
  const orderLine = orderNo ? `<p class="foot">${escapeHtml(orderNo)}</p>` : '';
  return renderScanMessagePage({
    ...input,
    tone: 'success',
    // 主文案「本单提交成功」+ **单号**（她的口径：成功页要能一眼看到单号）
    title: input.title || success.title,
    // ⭐⭐ 2026-10-16（她逐字：「用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』
    //   类似这类的话就行了……」）⇒ 四条链路**同一句**；文案的家在 `config/scanPage.js` ✓
    //   ⚠️ 调用方另有正事要说时**以它为准**（例：异步那条已给她「本单已创建成功（单号）」✓
    //      —— 那是她 2026-10-15 的逐字口径，本刀**不推翻** ✗）；没人给正文时 = **那一句** ✓
    body: input.body || success.message,
    details: [...(input.details || []), orderLine].filter(Boolean),
    // 🔴 三入口（`continueButton` / `workbenchButton` / `fillPaymentButton`）**已全删** ✗ ——
    //   她逐字：「成功页它**不需要做任何跳转**，也**不需要做任何链接**」⇒ 这里**一个 `<a>` 都不给** ✗
    //   （路由自己给的「再录一单 / 回扫码页」那几个既有去向**不归这一刀管** ✓ 见 `successReturnFields`）
    ...(number ? { number } : {}),
  }, config);
};

/**
 * 🔴 **最后一道兜底页**（"绝不空白"的物理保证）。
 *
 * 为什么单独一个函数：上面那些页都依赖 `config`。万一 `config` 本身坏了 /
 * 渲染抛到一个没预料到的地方，路由需要一个**几乎不可能再抛**的渲染器 ——
 * 只有三行字符串拼接 + `escapeHtml`，不需要任何配置、不读文件、不解析任何东西。
 * ⚠️ 任何输入（`undefined` / `null` / 对象 / 带标签的字符串）都**必须**返回一段有正文的 HTML。
 */
/**
 * 2026-10-13（她：加载到中间一直白屏）—— 骨架屏：先出页面，绝不空白。
 * 取数要 4~6 秒（真测 product 1969 + sizes 768 + inventory 1410），这段是服务端整页渲染
 * ⇒ 读数据回来之前整页是白的。这一屏不读任何表、纯字符串拼接：她扫到的那串 / 货号 / 颜色
 * + 尺码区占位 + 正在读取…，然后由同一段脚本 fetch ?data=1 填进来。
 * 整页仍然只有一段脚本（哨兵 scanAcceptSelfServe / labelPrintScanEntry / scanPrintFeedback）。
 * 路由那一半（先发骨架再取数）还没接，本函数只负责渲染。
 */
const renderScanSkeleton = (view = {}, config = SCAN_PAGE) => {
  const texts = { ...SCAN_PAGE.texts, ...(config?.texts || {}) };
  const number = String(view?.number || '').trim();
  const itemNo = String(view?.item_no || (number.split('|')[0] || '')).trim();
  const color = String(view?.color || (number.split('|')[1] || '')).trim();
  const meta = [color].filter(Boolean).join(' · ');
  const script = `<script>
(function(){
  var host = document.getElementById('scan-skeleton');
  if (!host || !window.fetch) return;
  var number = host.getAttribute('data-number') || '';
  // 2026-10-13: fetch THIS page's own data fragment - not a hardcoded /s/.
  //   The skeleton is served for both mounts (/s/<number> and /r/<recordId>); hardcoding
  //   /s/ made the record page pull the home fragment and replace itself with it
  //   (she saw the home page after scanning a label). location.pathname keeps whichever
  //   mount we were served from, and ?data=1 still goes through the same service.lookup.
  // 2026-10-14: KEEP the current query (the realm is ?from=...) when pulling the data
  //   fragment. The old line dropped it, so the fragment was always rendered for the
  //   DEFAULT realm; document.write then replaced the page with look-alike content and
  //   every realm tap looked like "nothing happened" (her report: 5 of 6 tabs dead).
  //   Keep every existing parameter and only force data=1. ASCII only in this template.
  // 2026-10-14: NO regex here. This whole script lives inside a template literal, so an
  //   escaped question mark in a regex came out as /^?/ in the browser -- an invalid regex
  //   that made the WHOLE script throw, so the data fragment was never even fetched.
  //   Plain string ops instead: leading '?' stripped by hand, then force data=1.
  var dataSearch = window.location.search || '';
  if (dataSearch.charAt(0) === '?') { dataSearch = dataSearch.slice(1); }
  var dataQuery = dataSearch.split('&').filter(function (part) {
    return part && part.indexOf('data=') !== 0;
  });
  dataQuery.push('data=1');
  // 2026-10-14: never swallow the error again (her report: the page opens and then just sits
  //   on the skeleton forever). Any failure -- request error, non-ok response, empty body, or a
  //   response that is STILL the skeleton -- shows a human line plus a retry button. No auto loop.
  var retryText = ${JSON.stringify(texts.skeletonErrorText || '')};
  var retryLabel = ${JSON.stringify(texts.skeletonRetryLabel || '')};
  function showProblem() {
    var card = document.querySelector('[data-view="scan-skeleton-loading"]');
    if (!card || card.getAttribute('data-problem') === '1') return;
    card.setAttribute('data-problem', '1');
    while (card.firstChild) { card.removeChild(card.firstChild); }
    var message = document.createElement('p');
    message.setAttribute('data-view', 'scan-skeleton-error');
    message.textContent = retryText;
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.setAttribute('data-view', 'scan-skeleton-retry');
    retry.className = 'skeleton-retry';
    retry.textContent = retryLabel;
    retry.addEventListener('click', function () {
      card.removeAttribute('data-problem');
      retry.disabled = true;
      retry.setAttribute('aria-busy', 'true');
      load();
    });
    card.appendChild(message);
    card.appendChild(retry);
  }
  var slowMs = ${JSON.stringify(texts.skeletonSlowMs)};
  var slowText = ${JSON.stringify(texts.skeletonSlowText || '')};
  var attempt = 0;
  function showSlow() {
    var card = document.querySelector('[data-view="scan-skeleton-loading"]');
    if (!card || card.getAttribute('data-problem') === '1') return;
    var line = card.querySelector('[data-view="scan-skeleton-slow"]');
    if (line) { line.textContent = slowText; return; }
    line = document.createElement('p');
    line.setAttribute('data-view', 'scan-skeleton-slow');
    line.textContent = slowText;
    card.appendChild(line);
  }
  // first failure/timeout -> one automatic retry; the second one -> human line + manual retry
  function retryOrProblem() {
    if (attempt === 1) { showSlow(); load(); return; }
    showProblem();
  }
  function load() {
    attempt += 1;
    var slowTimer = window.setTimeout(function () {
      showSlow();
      if (attempt === 1) { load(); }
    }, slowMs);
    fetch(window.location.pathname + '?' + dataQuery.join('&'), { credentials: 'same-origin' })
      .then(function (response) { return response.ok ? response.text() : ''; })
      .then(function (html) {
        window.clearTimeout(slowTimer);
        if (!html) { retryOrProblem(); return; }                     // empty body
        if (html.indexOf('data-view="scan-skeleton"') !== -1) {      // still skeleton -> do NOT write it back
          retryOrProblem(); return;
        }
        document.open(); document.write(html); document.close();
      })
      .catch(function () { window.clearTimeout(slowTimer); retryOrProblem(); });   // no silent swallow
  }
  load();
})();
</script>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(itemNo || number || '')}</title>
<!-- 2026-10-13: STYLE must be wrapped - emitted bare it is foster-parented into
     the body and painted as visible text (she saw the raw style rules first). -->
<style>${STYLE}${PAYMENT_STEP_STYLE}${REALM_BAR_STYLE}${SKELETON_STYLE}</style>
</head>
<body>
<div class="page">
<section id="scan-skeleton" class="skeleton-stage" data-number="${escapeHtml(number)}"
  data-view="scan-skeleton" aria-busy="true">
<div class="card skeleton-card" data-view="scan-skeleton-loading">${escapeHtml(texts.skeletonLoading || '')}</div>
</section>
</div>
${script}
</body>
</html>
`;
};

const renderMinimalPage = (input = {}) => {
  const title = escapeHtml(input?.title || SCAN_PAGE.texts.errorTitle) || '打不开';
  const body = escapeHtml(input?.body || SCAN_PAGE.texts.errorBody) || '请稍后再试。';
  const requestId = input?.requestId ? `<p>请求号 ${escapeHtml(input.requestId)}</p>` : '';
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${title}</title></head>`
    + `<body style="margin:0;padding:24px;font:16px/1.6 -apple-system,BlinkMacSystemFont,\"PingFang SC\",sans-serif;color:#1f2329;background:#fff">`
    + `<h1 style="font-size:20px">${title}</h1><p>${body}</p>${requestId}</body></html>\n`;
};


module.exports = {
  renderSalePaymentStepPage,
  renderScanPage,
  renderScanSkeleton,
  renderSalesHome,
  renderScanMessagePage,
  renderMinimalPage,
  renderSaleSuccessPage,
};

// ── ⚠️ 下面这些**不是本文件定义的**：原文件里它们就来自别处（fields / styles / …）⇒ 原样转出 ✓ ──
module.exports = Object.assign(module.exports, { MULTI_ITEM_ENTRY_KEYS, MULTI_ITEM_ITEM_KEYS, multiItemBlockHtml, multiItemPayloadJson });
module.exports = Object.assign(module.exports, { escapeHtml });
module.exports = Object.assign(module.exports, { STYLE, canScanNextWithFeishu, readThemeTokens });
module.exports = Object.assign(module.exports, { resolveRealm });
module.exports = Object.assign(module.exports, { buildPaymentRows });
module.exports.resolveRealm = require('../scanPageRealm').resolveRealm;
