const { SCAN_PAGE } = require('../../config/scanPage');
const { REALM_TABS, DEFAULT_REALM, REALM_TEXTS } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { PAYMENT_STEP_STYLE, REALM_BAR_STYLE, SCAN_TAB_MARKER, SKELETON_STYLE, STYLE, canScanNextWithFeishu } = require('./styles');
const { annotateScriptHtml, realmScanScriptTagHtml, submitFeedbackScriptHtml } = require('./script');

const renderDocument = ({ title, content, requestId, config = SCAN_PAGE, head = '' }) => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
${head}
<style>${STYLE}${PAYMENT_STEP_STYLE}${REALM_BAR_STYLE}${SKELETON_STYLE}</style>
</head>
<body>
<main class="page">
${content}
</main>
${requestId ? `<p class="foot">${escapeHtml(config.texts.requestIdLabel)} <span class="mono">${escapeHtml(requestId)}</span></p>` : ''}
${content.includes('data-submit-feedback=') ? submitFeedbackScriptHtml() : ''}${content.includes('data-view="realm-scan-config"') ? `\n${realmScanScriptTagHtml()}` : ''}
${annotateScriptHtml()}
</body>
</html>
`;

/** 一行的数量格：有货给数字（加粗），0 给破折号。 */
const cellHtml = (count, config) => (count > 0
  ? `<td>${escapeHtml(count)}</td>`
  : `<td class="zero">${escapeHtml(config.texts.zero)}</td>`);

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：
 *   「`category_name` ⇒ **品类**（类别表名字）· `category_code` ⇒ **类别**（货品表原值），
 *    **两个都显示**，**有就显示，没有就不显示**」＋「需要做个映射，**A 等于男，B 等于女**」
 *
 * ⭐ 映射**复用既有那一份配置**（`sizeSegments.ranges[code].label` ✓ 那里本来就是 A⇒男 / B⇒女 ✓）——
 *   **不新造映射表** ✗ · **不散写 if** ✗（她定了"配置先行"✓）
 * ⚠️ 认不出的类别码 ⇒ **原样显示那个码**（**不猜** ✗ 不吞 ✗）
 */
const categoryLabelOf = (code, config) => {
  const key = String(code || '').trim().toUpperCase();
  if (!key) return '';
  const ranges = (config && config.sizeSegments && config.sizeSegments.ranges) || {};
  return String(ranges[key] && ranges[key].label ? ranges[key].label : '').trim();
};

const identityHtml = (view, config) => {
  // ⭐ 三段：颜色 · **品类**（category_name）· **类别**（category_code ⇒ 映射成 男/女，认不出就原样）
  const categoryLabel = categoryLabelOf(view.category_code, config) || view.category_code;
  const meta = [view.color, view.category_name, categoryLabel]
    .filter(Boolean)
    .join(config.texts.identitySeparator);
  return `<header class="card identity">
<div class="identity__main">
<h1 class="identity__item">${escapeHtml(view.item_no || view.number)}</h1>
${meta ? `<p class="identity__meta">${escapeHtml(meta)}</p>` : ''}
</div>
<div class="price">
<span class="price__label">${escapeHtml(config.texts.priceLabel)}</span>
<span class="price__value">${escapeHtml(view.price_text)}</span>
</div>
</header>`;
};

/**
 * ⭐ 领域切换条（顶部）：**六个领域**各一条**真链接**（`?from=<id>`；3 列 × 2 行、不横滑）。
 *
 * 🔴 当前领域那一颗的高亮是**服务端**决定的（`realm-tab--active` + `aria-current="page"`），
 *    不是脚本在浏览器里切 class —— 没 JS 也完全正确。
 * 领域顺序 / 名字全部来自 `views/scanPageRealm.js`（加减领域只改那个文件）。
 */
/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：「…**我希望我们的排序可以改下，库存、销售、补货、退货、扫一扫**。默认还是销售页。」
 *   ⇒ 上条的**显示顺序**由 `SCAN_PAGE.realmBar.order` 定（**配置先行** ✓）：
 *     `scanPageRealm.js` 只回答「**有哪些领域**」（成员唯一真源 ✓），"先摆哪个"是**视图参数** ⇒ 放配置里。
 *   ⚠️ **兜底（不静默丢格 ✗）**：配置缺失 / 与 `REALM_TABS` **不是同一个集合** ⇒ 回落 `REALM_TABS`
 *      自己的顺序（宁可顺序旧，也不能少一格/多一格 ✗）。
 */
const orderedRealmTabs = () => {
  const configured = (SCAN_PAGE.realmBar && SCAN_PAGE.realmBar.order) || [];
  const ids = REALM_TABS.map((item) => item.id);
  const picked = configured.map(String).filter((id) => ids.includes(id));
  if (picked.length !== ids.length || new Set(picked).size !== ids.length) return REALM_TABS;
  return picked.map((id) => REALM_TABS.find((item) => item.id === id));
};

/** 第 5 格：「扫一扫」（AppLink；**只在调得起来的设备上出现** —— 文案来自配置 ✓）。 */
const scanCellHtml = () => `<a class="realm-tab realm-tab--scan" data-realm-id="scan" href="${escapeHtml(SCAN_PAGE.scanNext.applink)}" rel="noopener">${escapeHtml((SCAN_PAGE.realmBar && SCAN_PAGE.realmBar.scanLabel) || SCAN_PAGE.texts.scanNextLabel)}</a>`;

const realmBarHtml = (realm = DEFAULT_REALM, userAgent = '') => {
  // ⭐⭐ 2026-10-15（现状，改了就要同步这里）：**一整排** = 4 个领域（顺序见上面的 `orderedRealmTabs`）
  //   ＋（只有飞书客户端）第 5 格「扫一扫」；列数 = 格数 ⇒ 铺满整宽、手机上不需要横滑 ✓
  //   ⚠️ 2026-10-13 那个"两行三列 / 标签·上新·配品"的版式**已经不存在了**（配品搬去工作台、
  //      上新与标签不上条 ⇒ 见 `scanPageRealm.js` 的沿革）—— 别再照那句话理解本函数 ✗
  const tabHtml = (item) => {
    if (item.external === true) {
      return `<a class="realm-tab" data-realm-id="${escapeHtml(item.id)}" href="${escapeHtml(SCAN_PAGE.realmBar.newFormUrl)}" target="_blank" rel="noopener">${escapeHtml(item.label)}</a>`;
    }
    const active = item.id === realm;
    return `<a class="realm-tab${active ? ' realm-tab--active' : ''}" data-realm-id="${escapeHtml(item.id)}" href="?from=${escapeHtml(item.id)}"${active ? ' aria-current="page"' : ''} data-tap-target="realm:${escapeHtml(item.id)}" data-open-label="${escapeHtml(SCAN_PAGE.tapFeedback && SCAN_PAGE.tapFeedback.label || '')}">${escapeHtml(item.label)}</a>`;
  };
  // ⭐⭐ 2026-10-14（她：「6 个领域……**没有铺满屏幕的水平方向**……最后一格被截」）：
  //   真因：**容器 `.realm-bar` 自己是 3 列网格**，里面却塞了**两个** `.realm-row`
  //   ⇒ 每个 row 只占容器宽的 1/3，右边那一列空着 ✗（看起来就是"没铺满 + 最后一格像被截"）
  //   ⇒ 现在：容器**一整列**（每个 row 占满整宽 ✓）＋ **一行六格**、六列等分（`minmax(0,1fr)` ✓）
  //     每格 `min-width: 0`（长文案不会撑宽自己 ⇒ 不会把最后一格挤出去 ✗）；窄屏交给 `overflow-x: auto` ✓
  // ⭐⭐ 2026-10-15：列数 = **实际格数**（4 个领域，飞书客户端再加「扫一扫」这第 5 格）——
  //   改前逐字：`repeat(6, minmax(0,1fr))`（固定 6 列 ⇒ 4 格时右边空两列 ✗ 看着"没铺满"）
  //   改后逐字：`repeat(${cells.length}, minmax(0,1fr))` ⇒ **整排铺满、等分**，手机上**不需要横滑** ✓
  //   ⚠️ `minmax(0,1fr)` 与每格 `min-width: 0`（见 `REALM_BAR_STYLE`）一起保证长文案不撑宽 ✗
  const row = (htmlCells) => `<div class="realm-row" style="display:grid;grid-template-columns:repeat(${htmlCells.length},minmax(0,1fr));width:100%;gap:8px">${htmlCells.join('')}</div>`;
  // 第 5 格只在**能调起飞书扫一扫**的设备上出现（电脑 / 普通浏览器不给假按钮 ✗ —— 那里照旧由
  // 本单条的 `scanNextHint` 说人话 ✓，见 `draftBarHtml`）。
  const cells = orderedRealmTabs().slice();
  const scanTab = canScanNextWithFeishu(userAgent);
  if (scanTab) cells.push(SCAN_TAB_MARKER);
  const rendered = cells.map((item) => (item === SCAN_TAB_MARKER ? scanCellHtml() : tabHtml(item)));
  return `<nav class="realm-bar" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${row(rendered)}
</nav>`;
};

/**
 * `<noscript>` 兜底：把四条领域链接**再给一遍**（**只给能点的，不解释怎么用**）。
 *
 * ⚠️ 这一页**本来就不需要 JavaScript**（切换条是真链接、服务端只渲染当前那一块），
 *    所以这一段不是"页面能不能用"的前提，而是"万一 webview 禁脚本/样式被裁掉"的保险带
 *    —— 她的第一要求是"**手机上无论如何都要有看得见的东西**"。
 * ⭐ 2026-10-10：原来那句「本页不需要 JavaScript；点下面的领域换个用法：」是**说明书**，删掉；
 *    四条领域链接（能点的）一个字不动。
 */
const noScriptHtml = () => `<noscript>
<nav class="realm-bar realm-bar--plain" aria-label="${escapeHtml(REALM_TEXTS.barLabel)}">
${orderedRealmTabs().map((realm) => (realm.external === true
  ? `<a class="realm-link" href="${escapeHtml(SCAN_PAGE.realmBar.newFormUrl)}" target="_blank" rel="noopener">${escapeHtml(realm.label)}</a>`
  : `<a class="realm-link" href="?from=${escapeHtml(realm.id)}">${escapeHtml(realm.label)}</a>`)).join('\n')}
</nav>
</noscript>`;

/**
 * ⭐⭐ 2026-10-11「**本单条**」—— 每个扫码页（**任意领域**）顶部固定的一条。
 *
 * 她的原话（逐字）：
 *   「因为比如说我们在**扫码页卖了多双鞋**的时候，怎么可以**一双订单多次扫码**呢？」
 * 要解决的三个缺口（都是真机上的真麻烦）：
 *   ① 加完本单**没有"继续扫下一个"的入口** ⇒ 要退回去再扫，容易漏扫 / 忘了提交；
 *   ② **看不到"本单已经有几双"**；
 *   ③ 扫到第 3 个码时，【提交这一单】在**第 1 个码那一页**上 ⇒ 得回去找。
 * ⇒ 这一条把 ①②③ 一次解决：`本单：N 双`（从扫码会话实时读，**跨编号共用**）
 *   ＋（**有草稿才出现**）【提交这一单】＋【继续扫下一个】。
 *
 * 硬约束（她 2026-10-10 / 2026-10-11）：
 *   · **不留说明书**：只有"能点、能做的事" + 状态（几双 / 已加入本单那一句；
 *     加单反馈见 `config/scanWrite.js` 的 `lineAddedBanner`，**极简**）；
 *   · **没有草稿时不要显示成灰按钮** ⇒ `count > 0` 才渲染【提交这一单】那一个表单；
 *   · 【继续扫下一个】**能调就真能调**（飞书客户端内 = AppLink 打开扫一扫），
 *     调不了就**明说人话**（`scanNextHint`），**绝不给点了没反应的按钮**；
 *     判据在 `canScanNextWithFeishu`（服务端看 UA，页面上依然零 JS）。
 *
 * ⚠️ 提交表单里只带 `action=submit_order` + 幂等键：收款方式 / 金额**都不带** ——
 *    留空 = 既有口径的"先货后钱"（`scanWriteService.submitSale` 里
 *    `payments = []`），首页那一颗只是想让她**不必回到第 1 双那一页**去提交。
 *    要记钱仍然回到【销售】那一块的表单填（那里有收款方式 / 金额）。
 *
 * ⭐⭐ 2026-10-11（业务负责人定的，**改写了一条旧断言**）：「**提交这一单只在销售页显示**」
 *    —— 本单条在**每个领域**都有（`本单：N 双` ＋【继续扫下一个】），
 *    但那颗**提交按钮只在她点名的领域**里出现（取值在 `config/scanPage.js` 的 `draftBar.submitRealms`，
 *    渲染层**不写死 `'sales'`**）。
 *    ⚠️ 这一条推翻了 2026-10-11 上午那条旧断言（`scanPageDraftBar.test.js` 的 AC-DB7：
 *       「有草稿 ⇒ **库存页上也能提交**」）—— 口径变了，断言按新口径改写，理由逐字写在报告里。
 */

module.exports = {
  renderDocument,
  cellHtml,
  identityHtml,
  realmBarHtml,
  noScriptHtml,
};
