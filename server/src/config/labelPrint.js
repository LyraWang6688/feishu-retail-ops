/**
 * 鞋盒标签打印的可配参数 —— **配置先行**：尺寸 / 每页能铺几张 / 字号 / 印哪些字段 /
 * 每行几个尺码 / 品牌文字 / 价格格式，全部在这一个文件里，逻辑里一个数字都不写死。
 *
 * 业务负责人 2026-10-08 批准的第一个功能：**鞋盒标签打印**；
 * 同日她**定案**了标签版式改造（她买了 **40×30mm** 标签纸）。
 *
 * ⭐ **2026-10-08 她看了实物标签之后又改了一版**（原话：「邯美皮鞋需要是放在**顶部居中**，
 *    左边是二维码，右边是货品信息，顺序是**货号 颜色第一行 价格第二行** 然后下面是尺码区，
 *    **按照从小到大排序**」）。现行版式 = **BODY** 那一段配置说了算：
 *
 * ```
 * ┌────────────────────────────────────┐  40mm
 * │              邯美皮鞋               │  ① 品牌：**顶部居中**（跨整张标签宽度）
 * │ ┌────────┐  0225  棕色 · B         │  ② 右栏第一行：货号（大字）+ 颜色 · 品类
 * │ │ 二维码  │  ¥198                   │  ③ 右栏第二行：单价
 * │ │15×15mm │  36₁ 37₁ 38₁           │  ④ 下面：尺码区（数量角标，**数值升序**）
 * │ └────────┘  39₁ 40₁                │     一行放不下自动换行（最多 maxLines 行）
 * └────────────────────────────────────┘  30mm
 * ```
 *
 * 她定的规则（逐条落到下面的配置里）：
 *   ① **一张标签 = 一个「编号」（= 货号|颜色|类别）**：尺码那项 = 该编号下所有尺码 + 各自数量
 *      （角标 = 数量，小号字下沉；**不用 Unicode 下标字符** —— 预览里试过会显示成方框）；
 *   ② **只印有库存（数量>0）的尺码**（0 的不印，缺号扫码看）；
 *   ③ **尺码按数值从小到大**排（`38` < `40` < `100`，**不是字符串序**）⇒ `sizes.order` / `sizes.compare`；
 *      一行放不下**自动换行**（最多 `sizes.maxLines` 行；再超出就省略并留 `…`）⇒ `sizes.perLine`；
 *   ④ **二维码 15×15mm** ⇒ `typography.qrSizeMm`；
 *   ⑤ **价格印「单价」**（来自「货品信息.单价」，按编号取）⇒ `fields.price` / `price`，**排在第二行**；
 *   ⑥ **品牌文字进配置**（以后可换 logo/文字）⇒ `brand`；**位置（置顶居中）与字号**在 `BODY` / `TYPOGRAPHY`；
 *   ⑦ 尺寸 / 字号 / 字段开关 / **品牌位置** / **右栏行顺序** / **尺码排序与换行** / **价格位置** ——
 *      **全在这一个文件**（渲染层一个数字、一个行序都不写死）。
 *
 * ⚠️ **为什么是 HTML + 内联 SVG 而不是出 PNG**（她 2026-10-08 的明确口径）：
 *    「**不要用 sharp 出 PNG**」—— 服务端只出 **HTML（内联 SVG 二维码）**，
 *    靠 **CSS 的 mm 单位 + `@page`** 做 A4 排版，她在浏览器里点打印就行：
 *    更简单、更清晰（矢量）、没有任何二进制依赖，也不用把 sharp 拉进这条链路。
 *    真正用到的那个二维码库（`qrcode`）是**纯 JS**，不出图、只出 SVG 文本。
 *
 * ⚠️ **二维码 URL 的单一真源不在本文件**（刻意不放）：按 **编号** 出码的规范与实现已经
 *    在 `config/tagQrCode.js`（`SCAN_URL.urlTemplate`）与 `services/tagQrCodeService.js`
 *    （`buildScanUrl`）里了 —— 本链路**import 复用**它们（旧的那条
 *    `https://workbench.bamamei.online/scan?no=…` 模板**已删除**，不许再抄第二份）。
 */

/**
 * 单张标签的纸张尺寸（mm）—— 她定案的规格：**40mm × 30mm（横版）**。
 * 改这里 = 换一批标签纸（排版、每页张数都会跟着重算，不用改代码）。
 */
const LABEL = Object.freeze({
  widthMm: 40,
  heightMm: 30,
  // 标签内容到边缘的留白。⚠️ 这是**印在标签纸内部**的边距，不是打印机边距（后者在 PAGE.marginMm）。
  paddingMm: 1.5,
  // 裁切线（屏幕上是虚线、打印时是细实线）的粗细。⚠️ 它也**占宽度**：页面用的是
  //   `box-sizing: border-box` ⇒ 内容宽 = 40 − 2×1.5(留白) − 2×0.2(裁切线) = 36.6mm，
  //   右栏可用 = 36.6 − 15(二维码) − 1.5(间距) = **20.1mm**。
  //   算"货号 + 颜色放不放得下"时必须把它减掉，否则会乐观 0.4mm、把颜色挤出右栏。
  borderMm: 0.2,
});

/**
 * 纸张与**打印机边距**（mm）。
 * ⚠️ 这三个值会**原样注入 `@page { size: …; margin: … }`**，所以它同时决定两件事：
 *   ① 每张 A4 上能铺几列几行（见 resolveGrid）；② 打印机自己那圈不可打印的边。
 * 默认左右各 6mm ⇒ 可用宽 198mm ⇒ **40mm 的标签一行 4 张**（5 张要 200mm，超出可用宽；
 * 想一行 5 张就把左右边距改成 ≤5mm —— 那是"贴着打印机的不可打印边"，不建议默认这么干）。
 */
const PAGE = Object.freeze({
  // 只用于页面上的显示文案（"A4 每页 36 张"）；真正排版用的是下面的 mm 尺寸。
  name: 'A4',
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ top: 6, right: 6, bottom: 6, left: 6 }),
});

/**
 * 每页行列 / 间距。
 * `columns` / `rows` 留 `null` = **按纸张、边距、标签尺寸自动算**（换标签纸不用改这里）；
 * 写死数字 = 强制（例如她的标签纸就是能一行 4 张）。
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
 * 下面这些默认值是按打样图 `docs/prototypes/label-40x30-203dpi-fit.png` 反推的
 * （把打样图按 203dpi = 8 点/mm 换算成 mm 量出来的字高）：
 *   · `itemNoMm`   —— 货号（**最大字**，第一眼要看到的）＋ 与它同行的颜色；
 *   · `brandMm`    —— 品牌那行小灰字（**2026-10-08 起印在顶部居中**，见 `BODY.brandRow`）；
 *   · `fieldMm`    —— 颜色 · 品类那一行；
 *   · `sizeMm`     —— 尺码（`38`）；数量角标比它小，比例在 `SIZES.qtyFontRatio`；
 *   · `priceMm`    —— 单价（打样图里与货号一个量级）；
 *   · `footerMm`   —— 底部那行人可读小字（默认不印，见 FIELDS.footer）；
 *   · `qrSizeMm`   —— 二维码边长（她定案：**15mm**）。
 */
const TYPOGRAPHY = Object.freeze({
  itemNoMm: 3.6,
  brandMm: 2.4,
  fieldMm: 2.8,
  sizeMm: 2.8,
  priceMm: 3.2,
  footerMm: 1.7,
  qrSizeMm: 15,
});

/**
 * 尺码那一项怎么排（她定案的规则 ①③）。
 *   · `perLine` —— **每行几个尺码**（打样图里一行 3 个：`38₁ 39₂ 40₁`）；
 *   · `maxLines` —— 最多几行（**两行**，再超出就省略）；
 *   · `itemGapMm` —— 同一个尺码与它右边那个之间的空隙；
 *   · `qtyFontRatio` / `qtyBaselineShiftEm` —— **数量角标**的画法：
 *     小号字（= 尺码字号的这个比例）+ **下沉**。
 *     `qtyBaselineShiftEm` 是直接落到 CSS `vertical-align: -Xem` 上的值，**相对角标自己的字号**
 *     （按打样图量出来 ≈ 0.2em；比例 × 字号 = 角标实际大小，两个旋钮各管一件事）。
 *     ⚠️ **不用 Unicode 下标字符**（`₁` `₂`）——预览里试过，部分字体显示成方框；
 *        角标是**真的 `<span>`**，由 `public/workbench/features/labels/render.js` 画。
 */
const SIZES = Object.freeze({
  perLine: 3,
  maxLines: 2,
  itemGapMm: 1,
  qtyFontRatio: 0.64,
  qtyBaselineShiftEm: 0.2,
  // 排序：`asc` = 从小到大（她 2026-10-08 定案「按照从小到大排序」）；`desc` 留着（只改这里，不改代码）。
  order: 'asc',
  // 比较方式：`numeric` = **按数值**（`38` < `40` < `100`；字符串序会把 `100` 排到 `38` 前面）；
  //          `string`  = 按文本（尺码是 `S/M/L` 这类非数字时才用得上）。
  compare: 'numeric',
});

/**
 * ⭐ **标签内部版式**（品牌摆哪、右栏自上而下放什么、放不下怎么办）——
 * 业务负责人 2026-10-08 **看了实物标签之后**定案（她原话：「邯美皮鞋需要是放在**顶部居中**，
 * 左边是二维码，右边是货品信息，顺序是**货号 颜色第一行 价格第二行** 然后下面是尺码区，
 * **按照从小到大排序**」）：
 *
 * ```
 *              邯美皮鞋                ← brandRow: 'top'（跨整张标签宽度、居中）
 * ┌────────┐  0225  棕色 · B          ← rows: 'itemNoColor'（货号大字在前 + 颜色 · 品类）
 * │ 二维码  │  ¥198                   ← rows: 'price'
 * └────────┘  36₁ 37₁ 38₁            ← rows: 'sizes'（数值升序，最多 maxLines 行）
 *             39₁ 40₁
 * ```
 *
 *   · `rows` —— **右栏从上到下的行序**。改顺序 / 加减行**只改这个数组**，渲染层不写死。
 *     取值：`brand`（品牌，只有 `brandRow: 'inline'` 时才落在这条右栏里）· `itemNoColor`
 *     （货号 + 颜色同一行）· `price`（单价）· `state`（所属状态，默认 `fields.state = false` 不印）
 *     · `sizes`（尺码区）。
 *   · `brandRow` —— `'top'` = **整张标签最上面一行、跨左右**（她定案）；`'inline'` = 老版式（留在右栏）。
 *   · `brandAlign` —— 品牌那一行的水平对齐（`'center'` 她定案）。
 *   · `brandGapMm` / `qrGapMm` —— 品牌行与下面的空隙 / 二维码与右栏之间的空隙。
 *   · `itemNoColor` —— 货号与颜色同行的排法与**超宽处理**（见那段自己的说明）。
 */
const BODY = Object.freeze({
  rows: Object.freeze(['brand', 'itemNoColor', 'price', 'state', 'sizes']),
  brandRow: 'top',
  brandAlign: 'center',
  brandGapMm: 0.6,
  qrGapMm: 1.5,
  /**
   * 「**货号 + 颜色**」同一行（她定案的第一行）。
   * ⚠️ 右栏可用宽度 = 标签宽 − 左右留白 − 二维码 − `qrGapMm` ≈ **20.5mm** —— 货号一长就挤。
   *    **货号绝不许压到二维码上**：渲染层按下面的规则先**丢品类**、再**缩字号**、最后**截断**，
   *    并且这一行永远是 `nowrap + overflow: hidden`（第二道保险，见 labels.css）。
   *    整套"放不下怎么办"都在这一段里，渲染层一个数字都不写死。
   *   · `gapMm`        —— 货号与颜色之间的空隙；
   *   · `categorySeparator` —— 颜色与品类之间的分隔符（她定案：`·`，保持现状）；
   *   · `preferColorOverCategory` —— **放不下时优先保颜色**（她定案）：
   *        `true`  = 品类只在「货号不用缩到最小字号、也不用截断」时才印（缩一点点让位可以接受）；
   *                  真要牺牲货号才塞得下品类，就**丢品类、保颜色**；
   *        `false` = 品类优先：就算货号要缩到最小字号甚至截断，也保住品类；
   *   · `minItemNoMm`  —— 货号字号最多缩到这么小；再放不下就**截断 + 补 `truncateMark`**；
   *   · `truncateMark` —— 截断时补的省略号（与尺码溢出那个 `…` 分开配）；
   *   · `widthEm`      —— **估算文字宽度**用的"每类字符占多少 em"（按页面实际字体
   *        PingFang SC 量过：数字 ≈ 0.60em、大写字母 ≈ 0.67em、间隔号 `·` 与连字符 ≈ 0.72em、
   *        空格 ≈ 0.2em、中文 = 1em）：
   *        `narrow`（空格）· `ascii`（数字与字母）· `wide`（`·` `-` 这类）· `cjk`（中文等全角）
   *        ＋ `narrowChars` / `wideChars`（哪些字符归哪一档 —— 换个分隔符不用改代码）。
   *        为什么用估算：浏览器里的真实字体度量要 canvas，而这条渲染链是**纯函数 + 可测**的；
   *        估算只决定"缩到多小 / 截到几个字"，**真正兜底的是 CSS**（`.label-item-line` 的
   *        nowrap + hidden ＋ 货号那格 `flex-shrink` + `text-overflow: ellipsis`），
   *        所以估偏一点也只会让货号多缩/被裁一点，**颜色永远整段看得见**、更不会压到二维码。
   */
  itemNoColor: Object.freeze({
    gapMm: 1.2,
    categorySeparator: ' · ',
    preferColorOverCategory: true,
    minItemNoMm: 2.4,
    truncateMark: '…',
    widthEm: Object.freeze({
      narrow: 0.25,
      ascii: 0.66,
      wide: 0.72,
      cjk: 1,
      narrowChars: Object.freeze([' ']),
      wideChars: Object.freeze(['·', '-', '—', '/']),
    }),
  }),
});

/**
 * 印哪些字段（字段开关）—— 她要"只印货号 + 二维码"时，把别的关掉即可，不用改代码。
 * 默认值 = **打样那一版**（品牌 / 货号 / 颜色 / 品类 / 尺码 / 单价 + 二维码），
 * 打样图上没有的「所属状态」与底部小字**默认不印**，但开关留着（她要就能打开）。
 *   · `qr` 关掉 = 不出二维码；`brand` 关掉 = 不出品牌那行；`price` 关掉 = 不出单价；
 *   · `category` 关掉 = 颜色后面不再跟品类（右栏第一行只剩货号 + 颜色）；
 *   · `footer` 关掉 = 不出底部那行小字。
 */
const FIELDS = Object.freeze({
  qr: true,
  brand: true,
  itemNo: true,
  color: true,
  category: true,
  size: true,
  price: true,
  state: false,
  footer: false,
});

/**
 * 品牌文字（她定案的规则 ⑥：**进配置**，以后可换 logo/文字）。
 *   · `from: 'config'`（**默认**）—— 一律印下面的 `text`；
 *   · `from: 'table'`           —— 优先取「货品信息」里 `tableFieldName` 那列的值，读不到再回落 `text`。
 * ⚠️ `tableFieldName` 是**物理列名**，按规矩该放 `config/v1BitableSchema.js`；
 *    但那个文件本轮正被另一个子代理改动（明确不许碰）⇒ 先放这里，等它解冻后迁过去
 *    （迁的时候把这里删掉，service 改读 schema）。
 */
const BRAND = Object.freeze({
  from: 'config',
  text: '邯美皮鞋',
  tableFieldName: '品牌',
});

/**
 * 价格（她定案的规则 ⑤：印**单价**，来自「货品信息.单价」，按编号取）。
 *   · `prefix` —— 货币符号；· `decimals` —— 角分位数（整数不补零：`¥399`，不是 `¥399.00`）。
 * ⚠️ 读不到单价的记录**照常发标签、只是不印价格**，并在响应里**计数提示**（不许静默丢标签）——
 *    实现见 `services/labelPrintService.js` 的 `missing_price`。
 */
const PRICE = Object.freeze({
  prefix: '¥',
  decimals: 2,
});

/**
 * 二维码的**出图参数**（内容 = 一个能扫的 URL）。
 * ⚠️ **URL 模板不在这里**：唯一真源是 `config/tagQrCode.js` 的 `SCAN_URL.urlTemplate`
 *    （新规范：`https://hm.bamamei.online/s/{编号}`），由 `services/tagQrCodeService.js`
 *    的 `buildScanUrl` 替换（**只编码值、不编码模板**）。
 *    本文件**刻意不放 urlTemplate** —— 抄第二份的下场是"两条链路各指一个域名"。
 */
const QR = Object.freeze({
  // 纠错等级：贴鞋盒会磨、会蹭，M（15%）是"能扫 + 不至于太密"的常规选择，可调到 Q/H。
  errorCorrectionLevel: 'M',
  // 二维码四周留几个模块的白边。0 = 不留（排版靠 CSS 的 padding），留白会让码变小。
  marginModules: 0,
  darkColor: '#000000',
  lightColor: '#ffffff',
});

/**
 * 底部那行**人可读**小字（二维码扫不出来时的兜底）。默认 **不印**（`FIELDS.footer = false`，
 * 与打样图一致），要印时把开关打开即可。
 * 占位符：`{number}`（编号 = 货号|颜色|类别）`{itemNo}` `{color}` `{category}` `{sizes}`
 * （形如 `38×1 39×2`）`{totalQty}` `{price}` `{state}`；
 * 取不到的值用 `TEXTS.missingValue` 顶上，**不留空段**。
 */
const FOOTER = Object.freeze({
  template: '{number}',
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
 *   · `shelf`  —— 货架顺序：货号 → 颜色 → 类别，方便按堆数拣货；
 *   · `recent` —— 按「创建时间」倒序（最近新增的在前），挑"今天新到的先打"时用。
 */
const SORT_MODES = Object.freeze({
  shelf: '货架顺序（货号 → 颜色 → 类别）',
  recent: '最近新增在前',
});

const LIMITS = Object.freeze({
  // 一次最多返回多少张标签（**一张 = 一个编号**）。匹配更多时**不静默截断**：
  // 响应里带 truncated + total_matched，页面明确提示"匹配 N 张，本轮最多 M 张，请缩小条件"。
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
  // 颜色/品类/尺码这类值取不到时的占位（**不留空**，否则标签上看着像漏印了）。
  missingValue: '—',
  // 尺码多到两行都放不下时，最后那个省略号（她定案的规则 ③）。
  overflowMark: '…',
  // 一个编号下同时有多个「所属状态」时（默认不印），它们之间的连接符。
  stateSeparator: '/',
});

const LABEL_PRINT = Object.freeze({
  label: LABEL,
  page: PAGE,
  grid: GRID,
  typography: TYPOGRAPHY,
  sizes: SIZES,
  body: BODY,
  fields: FIELDS,
  brand: BRAND,
  price: PRICE,
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
 * 40×30mm + A4 + 边距 6mm ⇒ 可用 198×285mm ⇒ **4 列 × 9 行 = 36 张/页**。
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
  SIZES,
  BODY,
  FIELDS,
  BRAND,
  PRICE,
  QR,
  FOOTER,
  FILTERS,
  SORT_MODES,
  LIMITS,
  TEXTS,
};
