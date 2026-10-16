const { SCAN_PAGE, fillText } = require('../../config/scanPage');
const { DEFAULT_REALM, REALM_TEXTS, resolveRealm } = require('../scanPageRealm');
const { escapeHtml } = require('./fields');
const { canScanNextWithFeishu } = require('./styles');
const { submitFeedbackAttrs } = require('./script');

const draftBarHtml = (write, config, userAgent, realm = DEFAULT_REALM, page = {}) => {
  const texts = config.texts;
  const count = ((write && write.draft && write.draft.lines) || []).length;
  const saleEnabled = Boolean(write) && write.enabled !== false && write.saleEnabled !== false;
  // 【提交这一单】出现在哪些领域：配置说了算（缺省只有「销售」；认不出的领域 = 不显示）。
  const submitRealms = Array.isArray(config?.draftBar?.submitRealms)
    ? config.draftBar.submitRealms.map((item) => String(item).trim())
    : [DEFAULT_REALM];
  const canSubmitHere = submitRealms.includes(resolveRealm(realm));
  // 🔴🔴 2026-10-12（真机丢钱之后**删掉**的那颗按钮）：本单条原来**自带一颗【提交这一单】**，
  //    它的表单里**只有 action + 幂等键**（收款方式 / 金额一个都不带）。
  //    真机现场：她在**销售块**填了「全付 + 微信 280」，却按了本单条这颗 ⇒
  //    `payment_count: 0` —— 钱一行都没记（她：「我明确写了收款是微信 280，为什么收款明细没有」）。
  //    ⇒ **一页只允许一颗提交按钮**，而且必须是**带钱的那一颗**（销售块那一个表单）。
  //      这里只在"这一页没有带钱的提交表单"时给一条**指路链接**（GET，不带钱、也丢不了钱）：
  //      没有链接、也没有第二颗按钮 ⇒ 不可能再"点了提交却没记钱"。
  const moneyFormOnPage = page.moneyFormOnPage === true;
  const submitHtml = canSubmitHere && saleEnabled && count > 0 && !moneyFormOnPage
    ? `<a class="btn btn--primary" href="?from=${escapeHtml(REALM_TEXTS.defaultRealmId || 'sales')}" rel="noopener">${escapeHtml(texts.submitOnSalesRealmLabel || texts.submitButton)}</a>`
    : '';
  // 【继续扫下一个】⭐⭐ 2026-10-15（业务负责人逐字：「…**库存、销售、补货、退货、扫一扫**」）：
  //   飞书客户端里这一颗**已经搬去顶部那一排做第 5 格**（`realmBarHtml` 的 `scanCellHtml`）⇒
  //   本单条**不再重复放它**（同一件事说两遍、还白占一行 ✗）；
  //   ⚠️ **非飞书**（电脑 / 普通浏览器）**照旧**给那句人话 —— 那里没有第 5 格，
  //      不给一句人话就是"点了没反应"的死路 ✗（她 2026-10-14 报过桌面端这个现象 ✓）。
  const scanNextHtml = canScanNextWithFeishu(userAgent)
    ? ''
    : `<p class="hint">${escapeHtml(texts.scanNextHint)}</p>`;
  // 「刚加入本单」那一句：文案来自配置、只有数字来自会话（**没有回显注入面**）。
  const noticeHtml = write && write.notice
    ? `<p class="notice">${escapeHtml(write.notice)}</p>`
    : '';
  // ⭐⭐ 2026-10-15：条里**一件东西都没有时**（飞书 + 没草稿 + 没反馈）⇒ **整条不渲染** ——
  //   她的目的就是"少占地方" ✓ 一张空白卡（只剩内边距）比不渲染更占地方 ✗。
  //   ⚠️ 非飞书**永远有那句人话** ⇒ 照旧渲染（AC-DB1 那些"没草稿也有这条"的判据都走这条路 ✓）。
  if (!noticeHtml && !submitHtml && !scanNextHtml) return '';
  return `<section class="card draft-bar" data-view="draft-bar" aria-label="${escapeHtml(texts.draftBarLabel)}">
${noticeHtml}
${submitHtml}
${scanNextHtml}
</section>`;
};

/**
 * ⭐⭐ 2026-10-16（task-S2 ·「**存草稿 · 接着录**」· **渲染半**）—— 两块 UI：
 *   ① **三处入口**：销售货品页 / 补货页 / 退货页各一颗「**存报货草稿**」（她点名的是销售页那颗）；
 *   ② **「你有一份草稿，接着录吗？」提示条**（她先前定的"进去就提示、接着录"）。
 *
 * 她的口径（逐字）与**不许自己定**的那一条：
 *   · 「我们的**销售货品页上面也需要加一个按钮**，叫「**存报货草稿**」」← **只有这一颗被她点名**；
 *   · 「我们的**补货和退货需要支持存草稿**功能」；
 *   · ⚠️ 补货页 / 退货页那两颗**她没点名** ✗ ⇒ 本刀**三处共用同一句文案**（配置 `SCAN_PAGE.draftEntry`），
 *     **不自己另起名字** ✗ —— 来源如实登记在 `config/scanPage.js` 的 `resolveDraftEntryConfig` ✓。
 *
 * 🔴 **零回归的物理保证**（`AC-D2e`）：两块都只在 `page.draft.enabled === true` 时才**可能**出字节；
 *   **今天所有调用方都不传 `page.draft`**（路由那半步 = S3）⇒ 本函数返回**空串** ⇒
 *   渲染结果与改动前**逐字相同** ✓（既有那几十条页面判据一条都不用改 ✓）。
 *   ⚠️ **没有草稿**（`hasDraft !== true`）⇒ **提示条一个字都不出** ✓（塞进提示条 ⇒ `AC-D2e` 红 ✓）。
 *
 * ⚠️ 这一块**没有一行 JS**：入口是**同一张表单里的第二颗 submit**（原生，带得走她刚填的尺码/数量）；
 *   【接着录】是一颗**真链接**（同一路径 + `?resume=1`，查询键走配置 ✓）。
 *     本刀**不碰 `routes/**`** ✗ ⇒ 渲染层已按配置画好链接与查询键，**路由那一步在 S3** ✓。
 */
const draftUiOf = (page) => {
  const draft = page && page.draft;
  if (!draft || draft.enabled !== true) return null; // 缺省（今天所有调用方）⇒ 一个字节都不出 ✓
  return draft;
};

/** 草稿那一块的配置（**优先用传进来的那一份** ⇒ 用例可以拿一份改过的 config 直接钉"改配置即改文案" ✓）。 */
const draftEntryConfigOf = (config) => (config && config.draftEntry) || SCAN_PAGE.draftEntry || {};

/**
 * 「存报货草稿」那一颗（**三处入口共用这一个渲染点** ⇒ 形状只有一份，不会三处各写一遍 ✗）。
 *   · 落在**既有那张表单里**（`write.fields.action` 是既有字段名 ⇒ 不新造隐藏字段 ✓）；
 */
const draftSaveButtonHtml = (write, realm, config, page) => {
  if (!draftUiOf(page)) return '';
  if (!write || write.enabled === false) return '';
  const cfg = draftEntryConfigOf(config);
  const realms = Array.isArray(cfg.realms) ? cfg.realms.map((item) => String(item).trim()) : [];
  // 认不出的领域 ⇒ 那一页**不显示**（绝不猜 ✗）；取值必须是 `scanPageRealm.js` 的 `REALMS[].id`
  if (!realms.includes(resolveRealm(realm))) return '';
  const fields = write.fields || {};
  return `<button data-draft-save="1" type="submit" class="btn" name="${escapeHtml(fields.action)}" value="${escapeHtml(cfg.saveAction || '')}"${submitFeedbackAttrs(write)}>${escapeHtml(cfg.saveLabel || '')}</button>`;
};

/**
 * 「你有一份草稿，接着录吗？」那一条。
 *   · **只有真的有草稿才出** ✓（`page.draft.hasDraft === true`；路由用 S1 的 `readDraft` 判定 ✓）；
 *   · 数字（几个货品 / 几行）**只有路由喂了才写** —— 拿不到就**不写**（**不编 0** ✗）；
 *   · 【接着录】= 真链接（`?from=<当前领域>&<resumeQueryKey>=<resumeQueryValue>`）；
 *     ⚠️ **不点它 = 正常新建** ✓（页面上别的东西一个字都不动 ⇒ 她的零回归 ✓）。
 */
const draftNoticeHtml = (realm, config, page) => {
  const draft = draftUiOf(page);
  if (!draft || draft.hasDraft !== true) return '';
  const cfg = draftEntryConfigOf(config);
  const products = Number(draft.productCount) > 0 ? Number(draft.productCount) : 0;
  const lines = Number(draft.lineCount) > 0 ? Number(draft.lineCount) : 0;
  const meta = (products || lines)
    ? `<p class="hint" data-view="draft-notice-meta">${escapeHtml(fillText(cfg.noticeMeta || '', {
      products, lines, updatedAt: String(draft.updatedAt || ''),
    }))}</p>`
    : '';
  const queryKey = String(cfg.resumeQueryKey || 'resume');
  const queryValue = String(cfg.resumeQueryValue ?? '1');
  const href = `?from=${escapeHtml(resolveRealm(realm))}`
    + `&${encodeURIComponent(queryKey)}=${encodeURIComponent(queryValue)}`;
  return `<section class="card draft-notice" data-view="draft-notice">
<p class="notice">${escapeHtml(cfg.noticeLabel || '')}</p>
${meta}
<a class="btn" data-draft-resume="1" href="${href}">${escapeHtml(cfg.resumeLabel || '')}</a>
</section>`;
};


module.exports = {
  draftBarHtml,
  draftSaveButtonHtml,
  draftNoticeHtml,
};
