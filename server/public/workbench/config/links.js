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
 * 「采购和退货」页的两个按钮，按这个顺序渲染。
 * 加/减按钮只改这张表（`features/purchase/links.js` 只负责画）。
 */
export const PURCHASE_FORMS = [
  {
    id: 'purchase-request',
    icon: '🛒',
    title: '采购报货',
    desc: '提交采购报货（供应商报货）',
    url: PURCHASE_REQUEST_FORM_URL,
  },
  {
    id: 'purchase-return',
    icon: '↩️',
    title: '采购退货',
    desc: '把货退给供应商',
    url: PURCHASE_RETURN_FORM_URL,
  },
];
