/**
 * 鞋盒标签打印的可配参数 —— **配置先行**：尺寸 / 每页能铺几张 / 字号 / 印哪些字段 /
 * 二维码里的 URL，全部在这一个文件里，逻辑里一个数字都不写死。
 *
 * 业务负责人 2026-10-08 批准的第一个功能：**鞋盒标签打印**。
 *   · 她按条件挑出要打的货（某个货号 / 某个「所属状态」/ 最近新增…）→ 服务端从
 *     **「实时库存」（一双一条）** 取数（**只读**，一个字都不写）；
 *   · 页面按 **50×30mm** 排版、**A4 一页铺多张**，用**浏览器打印**打出来贴鞋盒；
 *   · 每张标签 = 二维码 + 货号（最大字）· 颜色 · 类别 · 尺码 · 所属状态 + 底部一行小字。
 *
 * ⚠️ **为什么是 HTML + 内联 SVG 而不是出 PNG**（她 2026-10-08 的明确口径）：
 *    「**不要用 sharp 出 PNG**」—— 服务端只出 **HTML（内联 SVG 二维码）**，
 *    靠 **CSS 的 mm 单位 + `@page`** 做 A4 排版，她在浏览器里点打印就行：
 *    更简单、更清晰（矢量）、没有任何二进制依赖，也不用把 sharp 拉进这条链路。
 *    真正用到的那个二维码库（`qrcode`）是**纯 JS**，不出图、只出 SVG 文本。
 *
 * ⚠️ **同款同码会有多双**（实测：1337 行里 92 个「库存键」是 ×2）⇒ 同一货号 + 尺码 + 颜色
 *    会出**多张标签**，**每张都印**（长得一样是**设计如此**：扫码后由将来的 `/scan` 页面
 *    列出这几双让她点选）。这里不需要"去重"开关 —— 一条「实时库存」记录 = 一张标签。
 */

/**
 * 单张标签的纸张尺寸（mm）—— 她给的规格：**50mm × 30mm**。
 * 改这里 = 换一批标签纸（排版、每页张数都会跟着重算，不用改代码）。
 */
const LABEL = Object.freeze({
  widthMm: 50,
  heightMm: 30,
  // 标签内容到边缘的留白。⚠️ 这是**印在标签纸内部**的边距，不是打印机边距（后者在 PAGE.marginMm）。
  paddingMm: 1.5,
});

/**
 * 纸张与**打印机边距**（mm）。
 * ⚠️ 这三个值会**原样注入 `@page { size: …; margin: … }`**，所以它同时决定两件事：
 *   ① 每张 A4 上能铺几列几行（见 resolveGrid）；② 打印机自己那圈不可打印的边。
 * 默认左右各 6mm ⇒ 可用宽 198mm ⇒ 50mm 的标签**一行 3 张**（4 张要 200mm，太贴边，
 * 大多数打印机会缩放出错位）。她要一行 4 张，把左右边距改成 ≤5mm 或直接写死 grid.columns。
 */
const PAGE = Object.freeze({
  // 只用于页面上的显示文案（"A4 每页 27 张"）；真正排版用的是下面的 mm 尺寸。
  name: 'A4',
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ top: 6, right: 6, bottom: 6, left: 6 }),
});

/**
 * 每页行列 / 间距。
 * `columns` / `rows` 留 `null` = **按纸张、边距、标签尺寸自动算**（换标签纸不用改这里）；
 * 写死数字 = 强制（例如她的打印机就是能一行 4 张）。
 */
const GRID = Object.freeze({
  columns: null,
  rows: null,
  gapXMm: 0,
  gapYMm: 0,
});

/**
 * 字号（mm）。
 * ⚠️ 用 mm 而不是 px/pt：打印时 mm 与纸张尺寸同一坐标系，缩放 100% 时**所见即所得**。
 * `itemNoMm` = 货号（**最大字**，标签上第一眼要看到的）；`fieldMm` = 颜色/类别/尺码/状态；
 * `footerMm` = 底部那行人可读小字；`qrSizeMm` = 二维码边长。
 */
const TYPOGRAPHY = Object.freeze({
  itemNoMm: 5,
  fieldMm: 2.6,
  footerMm: 1.7,
  qrSizeMm: 18,
});

/**
 * 印哪些字段（字段开关）—— 她要"只印货号 + 二维码"时，把别的关掉即可，不用改代码。
 * `qr` 关掉 = 不出二维码；`footer` 关掉 = 不出底部那行小字。
 */
const FIELDS = Object.freeze({
  qr: true,
  itemNo: true,
  color: true,
  category: true,
  size: true,
  state: true,
  footer: true,
});

/**
 * 二维码里的内容 = **一个能扫的 URL**（扫码后打开工作台将来的 `/scan` 页面）。
 * ⚠️ **参数值必须 URL 编码**（货号/颜色可能含中文或特殊字符）——
 *    实现见 `services/labelPrintService.js` 的 `buildScanUrl`：**只编码替换进去的值**，
 *    模板本身的 `?` `=` `&` 保持原样。
 * ⚠️ 这个 URL 现在**还没有对应页面**（`/scan` 是下一步做的）——**照印**，不用管 404。
 *
 * 模板里可用的占位符：`{itemNo}` `{color}` `{category}` `{size}` `{state}` `{stockKey}`
 * （`{stockKey}` = 「实时库存.库存键」原值，形如 `XHB8095|黑色|休闲鞋|42`）。
 */
const QR = Object.freeze({
  urlTemplate: 'https://workbench.bamamei.online/scan?no={itemNo}&size={size}&color={color}',
  // 纠错等级：贴鞋盒会磨、会蹭，M（15%）是"能扫 + 不至于太密"的常规选择，可调到 Q/H。
  errorCorrectionLevel: 'M',
  // 二维码四周留几个模块的白边。0 = 不留（排版靠 CSS 的 padding），留白会让码变小。
  marginModules: 0,
  darkColor: '#000000',
  lightColor: '#ffffff',
});

/**
 * 底部那行**人可读**小字（二维码扫不出来时的兜底）。默认逐字等于「库存键」的形状
 * （`货号|颜色|类别|尺码`，与打样图 `docs/prototypes/label-samples-50x30.png` 一致）——
 * 她本来就按这串认货。要加「所属状态」就把模板改成 `…|{size}|{state}`（占位符都在）。
 * 占位符与 QR.urlTemplate 相同；取不到的值用 `TEXTS.missingValue` 顶上，**不留空段**。
 */
const FOOTER = Object.freeze({
  template: '{itemNo}|{color}|{category}|{size}',
});

/**
 * 筛选器可选项（服务端校验 + 页面渲染用）。
 * ⚠️ 后端的 service **不会**因为"所属状态不在这个清单里"就丢掉记录 ——
 *    她在生产表里新加一个状态时，标签照常打得出来（只影响下拉框选项）。
 */
const FILTERS = Object.freeze({
  stateOptions: Object.freeze(['门盒', '样品', '仓库']),
  // 「最近新增」按天挑：0 = 不限。数值是下拉框的候选，上限见 LIMITS.maxRecentDays。
  recentDayOptions: Object.freeze([0, 1, 3, 7, 30]),
  defaultRecentDays: 0,
  defaultSort: 'shelf',
});

/**
 * 排序方式（`sort` 查询参数的值域）。
 *   · `shelf`  —— 货架顺序：货号 → 尺码 → 状态（门盒/样品/仓库）→ 颜色，方便按堆数拣货；
 *   · `recent` —— 按「创建时间」倒序（最近新增的在前），挑"今天新到的先打"时用。
 */
const SORT_MODES = Object.freeze({
  shelf: '货架顺序（货号 → 尺码 → 状态）',
  recent: '最近新增在前',
});

const LIMITS = Object.freeze({
  // 一次最多返回多少张标签。匹配更多时**不静默截断**：响应里带 truncated + total_matched，
  // 页面明确提示"匹配 N 张，本轮最多 M 张，请缩小条件"（一次 300 张 ≈ A4 十一页）。
  maxLabels: 300,
  // 「最近 N 天」的上限（她手滑写 3650 天时不让它变成一个全表扫描的语义）。
  maxRecentDays: 365,
});

/**
 * ⚠️ **只有这一个字段名放在这里，其余一律来自 `v1BitableSchema.liveInventory.fields`**。
 * 为什么破例：「实时库存.创建时间」是飞书**自动字段**（type 1001，只读核过测试 Base），
 * 「最近新增」筛选要用它；而字段映射的正规去处 `config/v1BitableSchema.js` 本轮
 * **正被另一个子代理改动（明确不许碰）** ⇒ 先放在这里，等那个文件解冻后**迁过去**
 * （迁的时候把这里删掉，service 改读 schema）。
 * ⚠️ 只**读**不写：时间字段不许代码写（业务负责人 2026-10-06：「改完只有收款是代码的事情」）。
 * ⚠️ 语义键名叫 `createdTime` 而**不是** `createdAt`：全仓有一条守门用例
 *    （`test/purchaseTableRenameSync.test.js`）把 `createdAt` 这个标识符当作
 *    **「报货批次.报货日（原创建时间）」那张表的自动时间列**，出现即判红。这里读的是
 *    **另一张表**的自动列、且只读，换个名字就不去蹭那条与采购链路无关的白名单。
 */
const FIELD_NAMES_PENDING_SCHEMA = Object.freeze({
  createdTime: '创建时间',
});

/** 用户可见文案（服务端要拼进标签里的那些）。 */
const TEXTS = Object.freeze({
  // 尺码后面的那个字：`42` → `42码`。
  sizeSuffix: '码',
  // 颜色/类别/尺码这类值取不到时的占位（**不留空**，否则标签上看着像漏印了）。
  missingValue: '—',
});

const LABEL_PRINT = Object.freeze({
  label: LABEL,
  page: PAGE,
  grid: GRID,
  typography: TYPOGRAPHY,
  fields: FIELDS,
  qr: QR,
  footer: FOOTER,
  filters: FILTERS,
  sortModes: SORT_MODES,
  limits: LIMITS,
  fieldNamesPendingSchema: FIELD_NAMES_PENDING_SCHEMA,
  texts: TEXTS,
});

/**
 * 每页能铺几张 —— 由**纸张、打印机边距、标签尺寸、间距**算出来（配置驱动，不写死 3×9）。
 * 返回里带上 `usableWidthMm/usableHeightMm`，页面上那句"每页 N 张"就是拿它算的。
 */
const resolveGrid = (config = LABEL_PRINT) => {
  const { page, label, grid } = config;
  const usableWidthMm = page.widthMm - page.marginMm.left - page.marginMm.right;
  const usableHeightMm = page.heightMm - page.marginMm.top - page.marginMm.bottom;
  const fit = (usable, item, gap) => Math.max(1, Math.floor((usable + gap) / (item + gap)));
  const columns = Number.isInteger(grid.columns) && grid.columns > 0
    ? grid.columns
    : fit(usableWidthMm, label.widthMm, grid.gapXMm);
  const rows = Number.isInteger(grid.rows) && grid.rows > 0
    ? grid.rows
    : fit(usableHeightMm, label.heightMm, grid.gapYMm);
  return { columns, rows, perPage: columns * rows, usableWidthMm, usableHeightMm };
};

module.exports = {
  LABEL_PRINT,
  resolveGrid,
  LABEL,
  PAGE,
  GRID,
  TYPOGRAPHY,
  FIELDS,
  QR,
  FOOTER,
  FILTERS,
  SORT_MODES,
  LIMITS,
  TEXTS,
};
