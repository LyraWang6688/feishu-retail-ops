/**
 * 扫码页的「**领域切换**」配置（业务负责人 2026-10-09）—— 一个二维码，四个领域。
 *
 * 她的原话（逐字）：
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *   ＋ 首版口径：「扫描页（扫码入口）**保持 `GET /s/:number` 不变**，但**顶部加"领域切换"**：
 *     `?from=sales|inventory|purchase|product`（缺省=**销售**），切换后**只显示该领域的操作**」
 *
 * ⇒ 四个领域与**工作台一级 tab 一一对应**（销售 · 库存 · 采购 · 货品，顺序都一样）：
 *     · `sales`     → 销售建单（加入本单 / 提交这一单；资金等非必填、可后续补）
 *     · `inventory` → 库存查询（这一款按尺码 × 所属状态的库存表）
 *     · `purchase`  → 采购报货（勾选要补的尺码 → 生成采购申请）
 *     · `product`   → 货品标签（打这一款的 40×30mm 标签 / 去批量打印）
 *   ⚠️ **四个领域共用同一套业务处理层**（`services/scanWriteService.js` 与它的既有下游）：
 *      这里只决定"页面上先给她看哪一块"，**一行业务逻辑都没有**。
 *
 * ⭐⭐ 2026-10-09 真机反馈（**手机在飞书内置 webview 里扫码是一片空白**）之后的**改法**：
 *    **服务端按 `?from` 只渲染该领域那一块** —— 页面里**一行前端脚本都没有**
 *    （连 `<head>` 里那段读 `location.search` 的也删掉了），领域切换条是**真链接**
 *    （`<a href="?from=…">`，点一下就是一次新的服务端请求）。
 *
 *    为什么要把"四块全渲染 + CSS 显隐 + head 脚本"整层拿掉：
 *      · 那一版**所有领域块都在 HTML 里**，靠 `<html data-realm>` + CSS 只显示一块；
 *        只要那段内联脚本在飞书 webview 里没跑（被 CSP 拦、预加载阻断、老内核…），
 *        页面就多了一层"行为取决于脚本有没有执行"的不确定性 —— 而这一页的初衷
 *        本来就是"**一次请求就有完整内容、没有 JS**"；
 *      · 现在：请求什么领域、服务端就只拼那一块 ⇒ **没有 JS 也 100% 是对的**，
 *        页面上也不会有另外三块（内容更小、手机上首屏更快）。
 *    ⚠️ 兜底一条都不少：`<noscript>` 里再给一遍四条领域链接；任何领域块"没内容"时
 *      渲染的是**一张人话卡片**（标题 + 为什么 + 下一步），**绝不留空 div**。
 *
 * ⚠️ 为什么放在 `src/views/` 而不是 `src/config/`：这一份是**扫码页这个视图自己的展示参数**
 *    （跟 `views/scanPageRenderer.js` 一起看），所以与它同目录。
 *
 * ⭐⭐ 2026-10-09 下半场（业务负责人）：「一个码、三个领域扫出来**不一样**」——
 *   · `from=inventory` **就是现在这个页面，一个字不许变**（既有用例是哨兵）；
 *   · `from=sales`     尺码**分两组**：有货（样品 + 门盒）⇒ **现货**；其余 ⇒ **预订**
 *                     （判据与分组都在下面 `SELLABLE_STATES` / `saleSizeGroups`）；
 *   · `from=purchase`  列出各尺码的（样品 + 门盒）数量 + 【一键补货】（`purchaseSizeLines`）。
 *   ⚠️ 交易类型**不在这一层写编码**：写入口按 `config/salesTradeTypePolicy.salesTradeTypeForStock`
 *      （"有货 → 现货 / 没货 → 预订"的**唯一判据**）推出来，用的是**既有**行为编码。
 */
// ⭐⭐ 2026-10-11（业务负责人定）：**扫码"第一眼"改回「销售」**。
//   她的原话：「**默认打开是销售页**」（2026-10-11 改回）。
//   ⚠️ 历史：2026-10-09/10 她当时的口径是「第一眼看库存」，于是缺省一度是 `inventory`；
//      2026-10-11 她改回来了 —— 裸码扫开**先看到销售（建单）那一块**，
//      想查库存 / 补货 / 打标签 ⇒ 页面顶部点【库存】/【采购】/【货品】。
//   ⚠️ 领域切换（`?from=` 四个值）与「加入本单」303 回跳**都还照旧可用**：
//      回跳停在**本单所在的领域**（表单 action 由 `routes/scanPage.js` 的
//      `postActionFor(number, realm)` 带上 `?from=`，见那里的注释）。
const { SCAN_PAGE } = require('../config/scanPage');

// ⭐ 2026-10-09：男女两组尺码段**进配置**（`config/scanPage.js` 的 `sizeSegments`）——
//   页面上那句"这一组是男 38–48"与**缺码判定**用的是**同一份配置**（唯一真源）。
const SIZE_GROUP_RANGES = SCAN_PAGE.sizeSegments.ranges;

const REALMS = Object.freeze([
  Object.freeze({ id: 'sales', label: '销售' }),
  Object.freeze({ id: 'inventory', label: '库存' }),
  Object.freeze({ id: 'purchase', label: '采购' }),
  Object.freeze({ id: 'product', label: '货品' }),
]);

/** 缺省领域 = **销售**（她 2026-10-11：「默认打开是销售页」；2026-10-09 曾一度是库存）。 */
const DEFAULT_REALM = 'sales';

/** 切换条与「货品标签」那一块的文案（页面上的每一个字都在这里，渲染层不写死句子）。
 *
 * ⭐⭐ **2026-10-10（业务负责人）：「只留能点、能做的事，删掉解释我怎么用的句子」** ——
 *   这里**只剩功能性的字**：领域名（`REALMS[].label`）· 无障碍用的条标签（`barLabel`）·
 *   货品标签页的标题与两颗按钮 · 销售两组的标题与状态小标签 · 采购那一列的三个小标签 ·
 *   以及压成最短的【一键补货】。
 *   ⇒ 退场的说明句（逐条）：`barHint`（「同一个二维码，四个领域都能扫；点一下切换」）·
 *     `noScriptHint`（「本页不需要 JavaScript…」）· `labelHint` · `saleInStockHint` /
 *     `salePrepaidHint`（「选这一组里的尺码 = 现货…」）· `purchaseSizesHint`（「只算可卖的…」）·
 *     `oneTapReplenish` 里那半句用法说明。
 *   ⚠️ **保留**：数据不全的如实说明（`config/scanPage.js` 的四条 note）· `⚠️ 缺` 高亮 ·
 *     状态小标签 · `noscript` **兜底链接**（没有脚本时四条领域链接照旧可点，只是不再解释）。
 */
const REALM_TEXTS = Object.freeze({
  barLabel: '这一页要做什么',
  labelHeading: '货品标签',
  labelSingleButton: '打印这一款的标签 →',
  labelBatchButton: '批量打印（按条件挑货）→',
  // ── 销售（`from=sales`）：尺码**分两组** —— 有货 ⇒ 现货 / 其余 ⇒ 预订 ──────────
  saleInStockHeading: '有货（样品 + 门盒）',
  salePrepaidHeading: '现在没有（预订）',
  saleInStockTag: '现货',
  salePrepaidTag: '预订',
  saleSizeEmpty: '这一款现在没有可选的尺码',
  saleCountTemplate: '{count} 双',
  // ── 采购（`from=purchase`）：各尺码（样品 + 门盒）数量 + 一键补货 ──────────────
  purchaseSizesHeading: '这一款各尺码现在有多少（样品 + 门盒）',
  purchaseInStockTag: '现货',
  purchaseMissingTag: '缺码',
  purchaseNoneTag: '无',
  // ⭐ 2026-10-10：原来那句「一键补货（缺的尺码已勾上，默认各 1 双）」是**用法说明**，压成功能名。
  oneTapReplenish: '一键补货',
});

/**
 * ⭐ **可卖 = 样品 + 门盒**（业务负责人 2026-10-09：「系统能够给出目前**样品加门盒**的尺码」）。
 * 「仓库」仍然显示（作参考），但**不参与**「现货 / 预订」的判定 —— 见 `sellableCountOf`。
 */
const SELLABLE_STATES = Object.freeze(['门盒', '样品']);

// （`SIZE_GROUP_RANGES` 已上移到文件顶部：从 `config/scanPage.js` 的 `sizeSegments` 取，
//   与缺码判定**同源**——2026-10-09 之前这里另有一份内联的硬编码副本。）

/** 这一款的类别（编号第 3 段）属于哪一组（认不出返回 null，不猜）。 */
const sizeGroupOf = (categoryCode) => {
  const key = String(categoryCode ?? '').trim().toUpperCase();
  const range = SIZE_GROUP_RANGES[key];
  return range ? { key, label: range.label, from: range.from, to: range.to } : null;
};

/** 一格的列名是不是"可卖"的那两种状态（门盒 / 样品）。 */
const isSellableCell = (cell) => SELLABLE_STATES.includes(String(cell?.key ?? '').trim());

/**
 * 一行（一个尺码）**可卖的**数量 = 门盒 + 样品（仓库不算）。
 *
 * 两种形状都认（**单一判据，不猜**）：
 *   ① 正常形状：`cells[].key` 就是列名（服务端视图模型一直这么给）；
 *   ② 老形状 / 夹具：`cells` 上没有 `key` ⇒ 按**视图模型的列序**取
 *      （`columns` 里第几个是"门盒 / 样品"，就取第几格）——
 *      取不到列序时返回 0（宁可判成"没货 → 预订"，也不把仓库算成可卖）。
 */
const sellableCountOf = (row, columns = []) => {
  const cells = Array.isArray(row?.cells) ? row.cells : [];
  if (cells.some((cell) => String(cell?.key ?? '').trim())) {
    return cells.reduce((sum, cell) => (isSellableCell(cell) ? sum + Number(cell.count || 0) : sum), 0);
  }
  return (Array.isArray(columns) ? columns : []).reduce((sum, column, index) => (
    SELLABLE_STATES.includes(String(column?.key ?? '').trim())
      ? sum + Number(cells[index]?.count || 0)
      : sum
  ), 0);
};

/** 视图模型里"这一款的尺码行"：读不出尺码的那一行不算（它不是一个能选的码）。 */
const sizeRowsOf = (view) => (Array.isArray(view?.rows) ? view.rows : [])
  .filter((row) => !row?.unknown_size && String(row?.size_text ?? '').trim());

/**
 * ⭐ 销售建单的**两个分组**（她 2026-10-09）：
 *   · 第一组 = **有货（样品 + 门盒 ＞ 0）**的尺码 ⇒ 选中它 = **现货**；
 *   · 第二组 = 该组（类别）**目前没有的**尺码 ⇒ 选中它 = **预订**。
 *
 * ⚠️ 第二组的尺码来自**同一份视图模型**（= 该编号在「尺码管理」里有的那些码）——
 *    这样"页面上能选的码"与"提交时写得进去的码"**是同一个集合**
 *    （写入口会按「尺码管理」解析尺码，清单里没有的码提交时会被拦下）。
 * ⚠️ 降级（拿不到该类别在「尺码管理」里的清单）时**第二组为空**：
 *    只显示有库存的尺码，**绝不编造**"没有的尺码"（与既有缺码判定的降级口径一致）。
 */
const saleSizeGroups = (view) => {
  const inStock = [];
  const prepaid = [];
  for (const row of sizeRowsOf(view)) {
    const item = { size_text: String(row.size_text), count: sellableCountOf(row, view?.columns) };
    if (item.count > 0) inStock.push(item);
    else if (!view?.sizes_degraded) prepaid.push(item);
  }
  return { inStock, prepaid };
};

/** 「有货」的那些尺码（写入口要按它判"这一双是现货还是预订"）。 */
const sellableSizeTexts = (view) => new Set(saleSizeGroups(view).inStock.map((item) => item.size_text));

/**
 * ⭐ 采购（补货）那一边的尺码清单：每个尺码的（样品 + 门盒）数量 +
 * 是不是"缺码"（既有口径：该类别在「尺码管理」里有、但**三种状态都没有** ⇒ 默认勾上要补）。
 * 「仓库」里有货的尺码**不预勾**（仓库能出，不必补）—— 与既有缺码口径一致。
 */
const purchaseSizeLines = (view) => sizeRowsOf(view).map((row) => ({
  size_text: String(row.size_text),
  sellable: sellableCountOf(row, view?.columns),
  missing: Boolean(row.missing),
  checked: Boolean(row.missing),
}));


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

module.exports = {
  REALMS,
  DEFAULT_REALM,
  REALM_TEXTS,
  LABEL_PRINT_PATH,
  SELLABLE_STATES,
  SIZE_GROUP_RANGES,
  resolveRealm,
  labelPrintUrls,
  sizeGroupOf,
  sellableCountOf,
  saleSizeGroups,
  sellableSizeTexts,
  purchaseSizeLines,
};
