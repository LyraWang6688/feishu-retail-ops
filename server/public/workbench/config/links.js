/**
 * 工作台用到的外部链接（飞书表单等）—— **配置先行：换链接只改这一个文件**。
 *
 * 来源：业务负责人 **2026-10-06** 在飞书里逐字给出的两个「多维表格表单」链接。
 * 口径留档见 `docs/workbench-requirements-2026-10-06.md` 一①「采购和退货」：
 * **只放两个飞书表单链接 —— 不自建表单、不做查询**（她的原话：
 * 「采购和退货的话，实际上它就是多维表格，给到多维表格的两个表单链接就可以」）。
 *
 * ⚠️ 这两个链接是**外链**（`/share/base/form/...`），不是工作台自己的页面；
 *    工作台只负责把用户送过去，不在本地重算任何业务事实。
 */

// ⭐ 表单名 2026-10-06 由业务负责人改名：「采购申请」→「采购报货」。
// 原话：「我说的是采购申请改为了采购报货，然后采购退单改成了采购退货」
/**
 * ⭐⭐ 「打开飞书扫一扫」的 AppLink（她 2026-10-13：「**扫码页的『继续扫下一个』在手机上就是能弹**」⇒ 照抄形状）。
 * 形状来源（真机验证过 ✓）：`views/scanPageRenderer.js:429` 的
 *   `<a class="btn" href="https://applink.feishu.cn/client/qrcode/main" rel="noopener">继续扫下一个</a>`
 *   ⇒ **纯 `<a href>`** · **无 target** · **无 JS** ✓
 * ⚠️ 这里与服务端 `config/scanPage.js` 的 `SCAN_NEXT.applink` 是**同一把链接**：
 *    两端**逐字相同**，有 AC 钉着（`test/workbenchScanEntry.test.js`）
 *    ⇒ 客户端这一份是**给首屏就能渲染 `<a>` 用的**（不必等 `/scan-entry` 回来 ✗ 免得又出现"点了没反应"）
 */
export const SCAN_APPLINK = 'https://applink.feishu.cn/client/qrcode/main';

export const PURCHASE_REQUEST_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc';

// 采购退货表单（表单名 2026-10-06 为「采购退货」）。
export const PURCHASE_RETURN_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnjsqt4D5URseSSXgecYlqGd';

/**
 * 「货品上新」飞书表单 —— ⭐ **2026-10-09 起是「货品」tab 的第①个子页面**。
 *
 * 这个 URL 原来**只写死在** `features/purchase/index.js` 的 `FORMS[0]` 里（旧「采购管理」页）。
 * 现在它同时被「货品 · 货品上新」那张卡用 ⇒ 按本仓库「URL 单一来源」的规矩**提到这里**，
 * 两处都只 `import`（那份旧页面也改成从这里取，不再各写一份字面量）。
 */
export const PRODUCT_NEW_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m';

/**
 * 两个飞书表单，按这个顺序渲染。**消费方**（只负责画，不改这张表）：
 *   `config/domains.js` —— 「采购」tab 的「报货」/「退货」**两个子页各一张卡**（当前正式入口；
 *   ⚠️ 2026-10-10 起「验收到货」不再是一张卡，它成了**独立子页**）。
 *   `features/purchase/links.js` —— 老「采购和退货」独立页的两张卡
 *   （⚠️ 2026-10-09：那一页 `purchase-return.html` 已按她的口令删掉 ⇒ 本模块当前没有页面挂载，
 *      **只是先留着没删**；URL 仍然共用这里这一份）。
 *   `config/home.js` —— 首页【常用功能】那**一张**「报货与退货」卡的 `href`
 *   （只 `import` 本文件的 `PURCHASE_REQUEST_FORM_URL`，**不复制 URL**）。
 *   ⚠️ 2026-10-08（业务负责人逐字，**ⓐ**）：「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，
 *      只删退货那张卡……现在就是按照原来一样，**采购和退货用的是一个表单**」——
 *      ⇒ 首页那**一张**卡**直连报货飞书表单**（不再指回内页 `purchase-return.html`）。
 *      ⚠️ **`PURCHASE_RETURN_FORM_URL` 一个字节都不删**：它仍被「采购」tab 的「退货」卡用着。
 *      留档：`docs/workbench-report-return-direct-form-2026-10-08.md`。
 * 加 / 减表单只改这张表。
 */
export const PURCHASE_FORMS = [
  {
    id: 'purchase-request',
    icon: '🛒',
    title: '报货',
    desc: '供应商报货——填完直接生成报货单',
    url: PURCHASE_REQUEST_FORM_URL,
  },
  {
    id: 'purchase-return',
    icon: '↩️',
    title: '退货',
    desc: '把货退给供应商，填完直接生成退货单',
    url: PURCHASE_RETURN_FORM_URL,
  },
];

/**
 * 【信息查询】两个板块的网页 URL —— **飞书多维表格里的页面**（不是我们自建的页面）。
 *
 * ⭐ 业务负责人 2026-10-08（逐字）：
 *   「目前我采用的并不是我们自己搭建的页面，而是**多维表格里的页面**。我希望就像我们的**报货和退货**一样，
 *    点开之后是**一个表单**，**销售查询和库存查询点开也是多维表格上的一个网页**。
 *    ⇒ 在这个维度上我们**不用自己搭建接口**」
 *
 * ⇒ 「信息查询」那两个板块**就是两张外链卡**，点一下直接打开她配好的多维表格网页；
 *    工作台**不新增任何接口 / 页面**，也不在本地重算任何业务事实。
 *
 * ⚠️ 空值的**明确行为**（现在两条都配好了，这段留给将来再加板块时用）：
 *    `features/query/index.js` 把它渲染成 `<div class="entry-card disabled-card">`（**不是 `<a>`**），
 *    卡面 arrow 文案 = **「链接待配置」** ⇒ **不产生空 `href`、点了不跳空链接、不报错**。
 *    给了 URL 就**只改下面那一行**（配置先行），页面一行都不用动。
 *
 * 写法与 `PURCHASE_REQUEST_FORM_URL` 同一套（`*_URL` 常量；`config/query.js` 只 import、不复制）。
 */
// ⭐ 2026-10-08 业务负责人**改口定稿**（逐字）：
//   「另外我们的URL就是用的这两个，**严禁你换成别的**：
//    销售的，https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnY3ZG9LAjrArEe5RzfS8UGh ；
//    库存的，https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnaSFKbJAci7YxvC1AXpweBc」
// ⇒ 两条都**逐字**用她给的**发布分享链接**（`/share/base/webpage/<shareId>`），
//    谁都不许改成另一种形状（早先我自作主张用过内部页面 URL `/base/<appToken>?table=<页面id>`，已按她的口径改回）。
// ⚠️ 这是**多维表格里的 AI 生成网页**（vibe view）：`wbpzfEmPGK` / `wbpmx4eW9A` 是**页面 id、不是 tableId**。
//    **页面代码不在本仓库** ⇒ 不进 CI、不受 `v1:schema-check` 保护；
//    她改生产表之后，**页面可能静默算错或变空，我们这边没有任何告警**
//    （她 2026-10-08 已经遇到一次：「今日销售减少和采购增加的数据不对」，排查留档在
//     `docs/todo-inventory-query-page-logic.md`）。
// ⚠️ 分享链接的权限提示（她知情）：飞书页面上写着
//    「通过分享链接访问的用户可查看当前页面展示的**全部数据，不受多维表格高级权限限制**」。
// ⚠️ 该页面声明的统计口径 + 与系统口径的差异，留档：
//    `docs/sales-query-page-and-system-caliber-2026-10-08.md`（她定的定位 = **最小 MVP，之后迭代**）。
export const SALES_QUERY_PAGE_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnY3ZG9LAjrArEe5RzfS8UGh';

/**
 * 「库存查询」URL —— 业务负责人 **2026-10-08** 给的发布分享链接（逐字）：
 *   「你可以把库存URL也放上去，https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnaSFKbJAci7YxvC1AXpweBc」
 *   （她同一条消息里定稿：「我们的URL就是用的这两个，**严禁你换成别的**」）
 *
 * ⇒ **两条都是发布分享链接**（`/share/base/webpage/<shareId>`），逐字用她给的，不做任何加工、
 *    也不换成内部页面 URL（`/base/<appToken>?table=<页面id>`）。
 * ⚠️ 权限提示（她知情）：飞书对这种链接写着「通过分享链接访问的用户可查看当前页面展示的
 *    **全部数据，不受多维表格高级权限限制**」。
 * ⚠️ 页面代码**不在本仓库** ⇒ 口径与风险见 `docs/todo-inventory-query-page-logic.md`
 *    （口径她 2026-10-08 已定；给页面生成 AI 的提示词、以及「今日变动」的对账表都在那一份里）。
 */
export const INVENTORY_QUERY_PAGE_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnaSFKbJAci7YxvC1AXpweBc';

/**
 * 飞书 **AppLink：在端内打开一个 web-view** 的基址 —— AGENTS §13 实查过的那条官方格式
 * （2026-10-12 又 `curl` 核过官方文档：`mode` 是**PC 端**容器模式）。
 *
 * `https://applink.feishu.cn/client/web_url/open?mode=<mode>&url=<encodeURIComponent 后的网址>`
 *
 * ⚠️ **URL 字面量只在本文件出现一次** —— `config/query.js` / `features/query/index.js` 里
 *    **不许再写 `feishu.cn`**（那条规矩有测试钉着，见 `test/workbenchTwoTabsAndQueryEntries.test.js` AC4）。
 */
export const FEISHU_APPLINK_WEB_URL_OPEN = 'https://applink.feishu.cn/client/web_url/open';

/**
 * ⭐⭐ **外链怎么"到达"** —— 配置先行（业务负责人 **2026-10-12**）。三个值都是**显式**的
 * （**不写 `||` 兜底**：清空 / 改错一个值必须能真的改变行为）。
 *
 * 她的原话（逐字）：
 *   「关于**销售查询**，我希望在点击了『销售查询』这个按钮之后，**系统可以直接自动跳转到我们的
 *    多维表格页面**，而**不需要让我再去点一下那个消息查询的卡片**。」
 *   「同理来说，**库存的全仓查询**也是……」
 *   「同理，我们『**货品**』的 tab 页里面不是有一个『**货品上新**』的子页面吗？也希望点击
 *    『货品上新』之后，**它能直接跳转到我的表单链接**，**不用我再去点击那个消息卡片了**」
 *   「『销售查询』和『全仓查询』**(乙) 飞书【端内】打开（AppLink，手机体验更好）**」
 *
 *   `LINK_DIRECT_JUMP_ENABLED` —— 显式布尔：`true`（当前）= 点子 tab **一次就跳**、**不渲染**
 *       中间那张卡；`false` = 回到老路（渲染卡片，她自己点）。
 *
 *   `LINK_APPLINK_ENABLED` —— 显式布尔：`true`（当前）= 走**飞书端内 AppLink**（乙）；
 *       ⭐ **`false` 就是"一键回落"**：立刻改成**普通跳转**（同窗口，与现有卡片同一条导航，
 *       手机上真机已在用）—— 万一某些机型 / 容器打不开 AppLink，改这一个值即可。
 *
 *   `LINK_APPLINK_MODE` —— 只在走 AppLink 时生效，取值同官方文档：
 *       `sidebar-semi`（侧边栏，当前）/ `window`（独立窗口）/ `appCenter`（导航栏标签页，需飞书 7.5+）。
 *       ⭐ 为什么当前选 **`sidebar-semi`**：官方文档写明 `mode` 是 **PC 端**的容器模式
 *       （手机端不生效 ⇒ 对她主要在手机上用的场景**无差别**）；PC 上侧边栏最贴合
 *       "在飞书里看一眼数据就回来"，也是 AppLink 工具最常用的那一个。
 *       若她想要 PC 端独立大窗口：只改这一个值为 `'window'`（文档还支持 `width`/`height`，
 *       我们**不设**，用客户端默认）。
 */
export const LINK_DIRECT_JUMP_ENABLED = true;
export const LINK_APPLINK_ENABLED = true;
export const LINK_APPLINK_MODE = 'sidebar-semi';
