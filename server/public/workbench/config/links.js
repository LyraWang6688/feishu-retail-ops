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
// 2026-11-08：`SCAN_APPLINK` 已移除（无运行期消费点，旧扫码入口由领域扫码 `features/scan/launch.js` 接管）。

/**
 * 「货品上新」飞书表单 —— ⭐ **2026-10-09 起是「货品」tab 的第①个子页面**。
 *
 * 这个 URL 原来**只写死在**老「采购管理」页（`features/purchase/index.js` 的 `FORMS[0]`）里。
 * 现在它被「货品 · 货品上新」那张卡用 ⇒ 按本仓库「URL 单一来源」的规矩**提到这里**，
 * 消费方只 `import`（不再各写一份字面量）。
 * ⚠️ **2026-10-15**（业务负责人逐字：「采购页的老文件是死代码，给删除了吧」）：
 *    那个老页 `features/purchase/**` **已整目录删除** ⇒ 本文件里提到它的地方只剩这段历史。
 *    ⚠️ **URL 常量照旧保留**（`旧采购报货表单常量` / `旧采购退货表单常量` /
 *    `旧采购表单列表`）—— 删 or 留不由这次清理决定 ✓
 */
// ⭐ 2026-10-14（业务负责人逐字）：「在工作台的**采购**页面加一个子 tab 是**供应商名录**，
//   我会给一个链接，也是**点击了之后直接跳转**」⇒ 她给的那条网址（**只此一处** ✓ 别处不复制字面量 ✗）
export const SUPPLIER_DIRECTORY_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/webpage/shrcnpZB0eX27B773hsrsyYf3gb';

// ⭐ 2026-11-19（业务负责人）：供应 → 交易记录 = 飞书表单外链，点击子 tab 直接跳转。
// URL 只在这里登记一处；config/domains.js 只 import，不复制字面量。
export const PURCHASE_TRANSACTION_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnkw0A6W9JW9WKXo5cmPqNEb';

export const PRODUCT_NEW_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m';

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：「**配品就是走表单了～工作台自建写服务"可以删除了，
 *   也就说在工作台点击配品就是直接跳转表单链接**」⇒ 她新建的「配品销售」表单（**只此一处** ✓
 *   别处不复制字面量 ✗）。
 *
 * ⚠️ 与 `PRODUCT_NEW_FORM_URL` **同一套**：URL 只写在这里，`config/domains.js` 只 `import`；
 *   点「销售 → 配品」那一格 ⇒ **一次就跳**（`kind:'links'` + `directJump:true`，走既有直跳机制）。
 * ⚠️ 提交上来的记录由**既有引擎**成单（`services/accessorySaleIntakeService.js`，她那张
 *   「配品销售」表 = `tblkT1QTUsESnl5b`）—— 工作台那套**自建写服务已删** ✓
 */
export const ACCESSORY_SALE_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnCUHxarWSWhoQRiv6qJeKWh';

/**
 * ⭐⭐ 2026-11-09（业务负责人）：**批量打印改成「填飞书表单」** ——
 *   「点「批量打印」进的是飞书表单链接，后续就只用这个了」。
 *   表单写到生产 Base 的「标签打印」表（`tblcUksCp3EmbmBa` 的同构表；后端监听该表新增记录自动打印）。
 * ⚠️ URL 只写在这里（**唯一来源**）；`config/domains.js` 的「批量打印」卡只 `import`，不复制字面量。
 * ⚠️ 旧的「筛选条件 + 批量预览」页已按业务负责人「完全删除」下线（代码物理删除）。
 */
export const LABEL_BATCH_FORM_URL =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnoFRAGvPyAWmSephrLpOvgh';


/**
 * 飞书 **AppLink：在端内打开一个 web-view** 的基址 —— AGENTS §13 实查过的那条官方格式
 * （2026-10-12 又 `curl` 核过官方文档：`mode` 是**PC 端**容器模式）。
 *
 * `https://applink.feishu.cn/client/web_url/open?mode=<mode>&url=<encodeURIComponent 后的网址>`
 *
 * ⚠️ **URL 字面量只在本文件出现一次** —— `config/domains.js` / `features/domains/**` 里
 *    **不许再写 `feishu.cn`**。
 */
export const FEISHU_APPLINK_WEB_URL_OPEN = 'https://applink.feishu.cn/client/web_url/open';

/**
 * ⭐⭐ **外链怎么"到达"** —— 配置先行（业务负责人 **2026-10-12**）。三个值都是**显式**的
 * （**不写 `||` 兜底**：清空 / 改错一个值必须能真的改变行为）。
 *
 * 现在仍使用直跳的是「货品上新 / 配品」；销售查询已改为自研页。
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
