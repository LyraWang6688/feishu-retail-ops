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
 * 两个飞书表单，按这个顺序渲染。**消费方**（只负责画，不改这张表）：
 *   `features/purchase/links.js` —— 「采购和退货」页（`purchase-return.html`）的两张卡。
 *   `config/home.js` —— 首页【常用功能】那**一张**「报货与退货」卡的 `href`
 *   （只 `import` 本文件的 `PURCHASE_REQUEST_FORM_URL`，**不复制 URL**）。
 *   ⚠️ 2026-10-08（业务负责人逐字，**ⓐ**）：「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，
 *      只删退货那张卡……现在就是按照原来一样，**采购和退货用的是一个表单**」——
 *      ⇒ 首页那**一张**卡**直连报货飞书表单**（不再指回内页 `purchase-return.html`）。
 *      ⚠️ **`PURCHASE_RETURN_FORM_URL` 一个字节都不删**：它仍被 `features/purchase/links.js`
 *      用着（`/workbench/purchase-return.html` 老链接打开仍是报货 / 退货两张表单卡）。
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
 * ⚠️ 空值的**明确行为**（现在还剩下「库存查询」是空的）：
 *    `features/query/index.js` 把它渲染成 `<div class="entry-card disabled-card">`（**不是 `<a>`**），
 *    卡面 arrow 文案 = **「链接待配置」** ⇒ **不产生空 `href`、点了不跳空链接、不报错**。
 *    她给了 URL 就**只改下面这一行**（配置先行），页面一行都不用动。
 *
 * 写法与 `PURCHASE_REQUEST_FORM_URL` 同一套（`*_URL` 常量；`config/query.js` 只 import、不复制）。
 */
// ⭐ 2026-10-08 业务负责人已给（逐字）：
//   「「销售查询」URL ：https://scnzoiwpgxik.feishu.cn/base/QrXlbwXMLaJ2TNsxSfFcIA3rnwh?table=wbpzfEmPGK」
// ⚠️ 这是**多维表格里的那个页面**：`wbpzfEmPGK` 是**页面 id、不是 tableId** ——
//    页面类型 = 飞书多维表格的「AI 生成网页」（vibe view：她在 Base 里对 AI 说要什么，AI 生成并发布）。
//    **页面代码不在本仓库** ⇒ 不进 CI、不受 `v1:schema-check` 保护；
//    她在生产表改名 / 删列之后，**页面会静默算错或变空，我们这边没有任何告警**。
// ⭐ 刻意用**内部页面 URL**（不选 `/share/base/webpage/...` 那条发布分享链接）：
//    内部页面走**打开者自己的 Base 权限**；而那条分享链接她自己页面上写着
//    「通过分享链接访问的用户可查看当前页面展示的**全部数据，不受多维表格高级权限限制**」。
//    同页面的分享链接（留档备查、刻不使用）：
//    `https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnY3ZG9LAjrArEe5RzfS8UGh`
// ⚠️ 该页面声明的统计口径 + 与系统口径的差异，留档：
//    `docs/sales-query-page-and-system-caliber-2026-10-08.md`（她定的定位 = **最小 MVP，之后迭代**）。
export const SALES_QUERY_PAGE_URL =
  'https://scnzoiwpgxik.feishu.cn/base/QrXlbwXMLaJ2TNsxSfFcIA3rnwh?table=wbpzfEmPGK';

// TODO(业务负责人): 库存查询 —— 飞书多维表格网页 URL（她给之前留空串，空值 = 卡面「链接待配置」）
export const INVENTORY_QUERY_PAGE_URL = '';
