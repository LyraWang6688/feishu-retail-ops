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
 *   `config/domains.js` —— 「采购」tab ①「报货 / 验收 / 退货」的**两张卡**（当前正式入口）。
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
