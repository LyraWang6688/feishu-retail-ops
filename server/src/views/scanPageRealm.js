/**
 * 扫码页的「**领域切换**」配置（业务负责人 2026-10-09）—— 一个二维码，四个领域。
 *
 * 她的原话（逐字）：
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *   ＋ 本任务的口径：「扫描页（扫码入口）**保持 `GET /s/:number` 不变**，但**顶部加"领域切换"**：
 *     `?from=sales|inventory|purchase|product`（缺省=销售），切换后**只显示该领域的操作**」
 *
 * ⇒ 四个领域与**工作台一级 tab 一一对应**（销售 · 库存 · 采购 · 货品，顺序都一样）：
 *     · `sales`     → 销售建单（加入本单 / 提交这一单；资金等非必填、可后续补）
 *     · `inventory` → 库存查询（这一款按尺码 × 所属状态的库存表）
 *     · `purchase`  → 采购报货（勾选要补的尺码 → 生成采购申请）
 *     · `product`   → 货品标签（打这一款的 40×30mm 标签 / 去批量打印）
 *   ⚠️ **四个领域共用同一套业务处理层**（`services/scanWriteService.js` 与它的既有下游）：
 *      这里只决定"页面上先给她看哪一块"，**一行业务逻辑都没有**。
 *
 * ⚠️ 实现方式（**没有动 `routes/scanPage.js`、也没有动 `config/scanPage.js`**）：
 *    四个领域的区块**全都渲染进 HTML**（各自的 `realm-block--<id>`），由**几行 CSS 按
 *    `<html data-realm="…">` 只显示当前领域**；那一行 `data-realm` 由页面 `<head>` 里
 *    **一小段内联脚本**从 `location.search` 的 `from` 读出来、在 body 解析前就设好
 *    （⇒ 不会闪一下"四个领域全显示"）。
 *    · 好处 ①：**路由/配置一个字没改**（本任务明确不碰 `routes/**`、`config/**`）；
 *    · 好处 ②：既有页面行为逐字不变 —— 销售建单表单与补货表单**都还在 HTML 里**
 *      （既有 51+ 条扫码页用例断言的就是这个），只是屏幕上按领域显示其中一块；
 *    · 兜底：脚本没跑起来（禁 JS / 老浏览器）时**四块全部显示**（见 STYLE 里 `:not([data-realm])`），
 *      宁可多显示，也绝不让页面空着。
 *
 * ⚠️ 为什么放在 `src/views/` 而不是 `src/config/`：本轮改动范围是**前端结构 + 样式 + 必要的只读接线**，
 *    `src/config/**` 与 `src/routes/**` 不在改动范围内 —— 而这一份是**扫码页这个视图自己的展示参数**
 *    （跟 `views/scanPageRenderer.js` 一起看），所以与它同目录。要挪进 `config/` 只需移文件 + 改一行 require。
 */
const REALMS = Object.freeze([
  Object.freeze({ id: 'sales', label: '销售' }),
  Object.freeze({ id: 'inventory', label: '库存' }),
  Object.freeze({ id: 'purchase', label: '采购' }),
  Object.freeze({ id: 'product', label: '货品' }),
]);

/** 缺省领域 = **销售**（她 2026-10-09 的口径：「缺省=销售」）。 */
const DEFAULT_REALM = 'sales';

/** 切换条与「货品标签」那一块的文案（页面上的每一个字都在这里，渲染层不写死句子）。 */
const REALM_TEXTS = Object.freeze({
  barLabel: '这一页要做什么',
  barHint: '同一个二维码，四个领域都能扫；点一下切换',
  labelHeading: '货品标签',
  labelHint: '打这一款（按货号）的鞋盒标签：40×30mm、A4 一页多张，用浏览器打印出来贴鞋盒',
  labelSingleButton: '打印这一款的标签 →',
  labelBatchButton: '批量打印（按条件挑货）→',
});

/** 「货品标签」的去处（工作台里那个**既有**标签打印页；本文件只拼 URL，不实现打印）。 */
const LABEL_PRINT_PATH = '/workbench/label-print.html';

/** `?from=` 的取值 → 领域 id（**认不出来的一律回落缺省**，不报错、不白屏）。 */
const resolveRealm = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  return REALMS.some((realm) => realm.id === raw) ? raw : DEFAULT_REALM;
};

/**
 * 这一款的标签打印链接：**单个** = 带上货号（标签打印页的 `keyword` 认货号，见 `labelPrintService`），
 * **批量** = 不带条件直接开那一页（她再按货号 / 状态 / 最近新增挑货）。
 */
const labelPrintUrls = (view = {}) => {
  const itemNo = String(view.item_no || String(view.number || '').split('|')[0] || '').trim();
  return {
    single: itemNo ? `${LABEL_PRINT_PATH}?keyword=${encodeURIComponent(itemNo)}` : LABEL_PRINT_PATH,
    batch: LABEL_PRINT_PATH,
  };
};

module.exports = { REALMS, DEFAULT_REALM, REALM_TEXTS, LABEL_PRINT_PATH, resolveRealm, labelPrintUrls };
