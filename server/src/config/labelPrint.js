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
 * │ ┌────────┐  0225  棕色             │  ② 右栏第一行：货号（大字）+ 颜色
 * │ │ 二维码  │  ¥198                   │  ③ 右栏第二行：单价
 * │ │15×15mm │  36₁ 37₁ 38₁           │  ④ 下面：尺码区（数量角标，**数值升序**）
 * │ └────────┘  39₁ 40₁                │     一行放不下自动换行（最多 maxLines 行）
 * └────────────────────────────────────┘  30mm
 * ```
 * ⚠️ **「品类」默认不印**（`FIELDS.category = false`；2026-10-08 业务负责人明确
 *    「我只能放货号、颜色，然后单价，然后尺码。放品类了吗？没放品类啊」）——
 *    只有把开关打开时，颜色后面才跟成「棕色 · B」。
 *
 * 她定的规则（逐条落到下面的配置里）：
 *   ① **一张标签 = 一个「编号」（= 货号|颜色|类别）**：尺码那项 = 该编号下所有尺码 + 各自数量
 *      （角标 = 数量，小号字下沉；**不用 Unicode 下标字符** —— 预览里试过会显示成方框）；
 *   ② **只印有库存（数量>0）的尺码**（0 的不印，缺号扫码看）；
 *   ③ **尺码按数值从小到大**排（`38` < `40` < `100`，**不是字符串序**）⇒ `sizes.order` / `sizes.compare`；
 *      一行放不下**自动换行**（行数**按可用高度 + 实际字宽算**；`sizes.maxLines` 只是安全上限；
 *      连上限/字号下限都放不下才留 `…`/`+N`，并记 warn）⇒ `sizes.perLine`；
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
 *    在 `config/tagQrCode.js`（`SCAN_URL.recordIdTemplate`）与 `services/tagQrCodeService.js`
 *    （记录 ID 二维码构造器）里了 —— 本链路**import 复用**它们（旧的那条
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
 *   · `maxLines` —— ⭐ **安全上限**（默认 **6**），**不是固定行数**！
 *     真实行数 = **`ceil(码数 / 每行实际能放几个)`**（每行几个按**实际字宽**算），
 *     并且受"纸上可用高度"约束 ⇒ 优先**排满行**、必要时**缩字号**（下限 `minFontMm`），
 *     只有"连上限/下限都放不下"时才用 `…` / `+N`（**可见的**省略，且记 warn）✓
 *     ⚠️ 2026-10-12 真机 bug：她 `26812 黑色` 有 44 码，却只排了两行就 `…` ⇒ **44 没了**。
 *       根因就是这个默认值**当初拍的是"两行"**（既没按可用高度算，也没考虑她 A 男 38–48 = 11 个码）
 *       —— "可见省略"的出发点没错，但**触发得太早** ✗
 *   · `itemGapMm` —— 同一个尺码与它右边那个之间的空隙；
 *   · `qtyFontRatio` / `qtyBaselineShiftEm` —— **数量角标**的画法：
 *     小号字（= 尺码字号的这个比例）+ **下沉**。
 *     `qtyBaselineShiftEm` 是直接落到 CSS `vertical-align: -Xem` 上的值，**相对角标自己的字号**
 *     （按打样图量出来 ≈ 0.2em；比例 × 字号 = 角标实际大小，两个旋钮各管一件事）。
 *     ⚠️ **不用 Unicode 下标字符**（`₁` `₂`）——预览里试过，部分字体显示成方框；
 *        角标是**真的 `<span>`**，由 `public/workbench/features/labels/render.js` 画。
 */
/**
 * ⭐⭐ **右栏行序的白名单**（唯一真源；`artifact.rows` / `LABEL_PRINT_ROWS` 都按它校验）。
 * 可选行：见下 —— 「货号+颜色同行」是**老版式**；`itemNo` / `colorPrice` 是**新排法**的拆行。
 * 默认行序（`body.rows`）**不动** ⇒ 老版式逐字节不变 ✓
 */
const ROW_IDS = Object.freeze([
  'brand', 'itemNoColor', 'itemNo', 'color', 'colorPrice', 'price', 'state', 'sizes',
]);

const SIZES = Object.freeze({
  perLine: 3,
  // ⭐ 安全上限（不是固定行数）：行数按"内容 + 可用高度"算，上限只兜底。
  //   ⚠️ 2026-10-12 从 2 改成 6 —— 她 11 个码排 3 行、7 个码排 2 行，都不该被这个值卡住。
  maxLines: 6,
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
 * 默认值 = **品牌 / 货号 / 颜色 / 尺码 / 单价 + 二维码**；
 * 打样图上没有的「所属状态」与底部小字**默认不印**，但开关留着（她要就能打开）。
 *   · `qr` 关掉 = 不出二维码；`brand` 关掉 = 不出品牌那行；`price` 关掉 = 不出单价；
 *   · `category` —— ⚠️ **2026-10-08 起默认 `false`**：业务负责人明确
 *       「**我只能放货号、颜色，然后单价，然后尺码。放品类了吗？没放品类啊**」
 *       ⇒ 右栏第一行只剩「货号 + 颜色」，颜色后面不再跟品类；
 *       打开（`true`）时恢复"颜色 · 品类"，并重新走上 `body.itemNoColor` 那套
 *       "缩字号保品类 / 丢品类保颜色"的阶梯规则；
 *   · `footer` 关掉 = 不出底部那行小字。
 */
const FIELDS = Object.freeze({
  qr: true,
  brand: true,
  itemNo: true,
  color: true,
  category: false,
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
 * ⚠️ **URL 模板不在这里**：唯一真源是 `config/tagQrCode.js` 的 `SCAN_URL.recordIdTemplate`
 *    （**2026-10-12 起**：`https://hm.bamamei.online/r/{记录ID}`；旧 `/s/{编号}` 只作兼容），由 `services/tagQrCodeService.js`
 *    的 记录 ID 二维码构造器 替换（**只编码值、不编码模板**）。
 *    本文件**刻意不放二维码 URL 模板** —— 抄第二份的下场是"两条链路各指一个域名"。
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

/**
 * ⭐⭐ 2026-10-15（task-10）：「**货品信息**的创建时间列」—— `recentDays`（最近新增）
 * 筛"**还没有入库的新货**"要用它。**这一项就是它的家**（原先只散在 service 里的兜底值）。
 *
 * 🔴 **只读核过真表**（`appTableField.list`，测试 Base 2026-10-15）：
 *   · 她那一列**叫「上架日期」**（**不是**「创建时间」），但**类型仍是 `1001 = CreatedTime`**
 *     （飞书自动字段）—— 她只是把它**改了名**；
 *   · 「更新日期」是 **`1002 = ModifiedTime`** ⇒ **不能**拿它当「最近新增」
 *     （会把"她刚改过的老货"当成新货 ✗）。
 * ⚠️ **改名闸门拦不住**（`v1:schema-check` 按 tableId 比对字段名 —— `AGENTS.md` 里那条）
 *   ⇒ 所以这里**名字 + 类型两条都留**（解析顺序见 `services/labelPrintService.js`）：
 *     ① `fieldName` 优先：这次读到的记录里**有这一列**就直接用（**零额外请求**；她再改名只改这一行）；
 *     ② 记录里**没有这一列** ⇒ 按 `fieldType`（1001）去字段表里找那一列（改多少次名都认），
 *        并**如实 warn**（`workbench.labels.product_created_time_renamed`：配置的名字跟真表对不上了）；
 *     ③ 两条都拿不到 ⇒ 那一条 `created_at = 0`：如实计数（`missing_created_at_without_stock`）＋ warn，
 *        **不猜** ✗。
 */
const PRODUCT_CREATED_TIME = Object.freeze({
  fieldName: '上架日期',
  fieldType: 1001,
});

/**
 * ⭐⭐ 2026-10-15（task-10）：**只读清单端点** `GET /api/workbench/products/numbers` 的那几档旋钮。
 *
 * 为什么要有短 TTL 缓存：Lead 线上**只读实测** ——
 *   `listAll('product')` **561 行 / 5478 ms** ＋ `listAll('liveInventory')` **1362 行 / 5924 ms**
 *   ⇒ 冷启动走一次这个端点 **≈ 11.4 秒**（她的手机等不了）。
 * ⚠️ **只影响这个端点**：`listLabels`（批量 / 编号打印那一页）**这次不动** ——
 *    它那 11 秒是另一个更大的话题（另开任务）。
 * ⚠️ `cacheTtlMs = 0` **= 关掉缓存**（每次真读；数值口径，没有"空串等于关"那种坑）。
 * ⚠️ 缓存只存**与请求无关**的那部分（编号底表 + 计数）；`keyword` / `limit` 每个请求现算。
 */
const PRODUCT_NUMBERS = Object.freeze({
  // 缓存有效期（毫秒）。0 = 关掉缓存（每次真读飞书）。
  cacheTtlMs: 60000,
  // 一次默认回多少条编号（契约：默认 200）。
  limitDefault: 200,
  // limit 的上限（契约：1..500；超过 ⇒ 400 如实告诉她，**不静默截断**）。
  limitMax: 500,
  // ⭐⭐ task-15：**服务端模糊查询**（走飞书 `filter`，只回匹配的那几条）。
  //   · `false` ⇒ 回退"整表读 + 内存过滤"那条老路（退路 / 开关；**显式布尔**，别写 `|| 默认`）；
  //   · 依据：她逐字「用户输入一个编号，然后系统再给出与这个模糊编号相关的选项」；
  //     原来整表 554 个编号 ≈ 13.9 秒 ✗ ⇒ 现在**空关键字一次都不读**、有字只读匹配的那几条 ✓。
  serverFilter: true,
  // 按关键字分槽的缓存**槽位上限**（同一个关键字重复搜 ⇒ 秒开；超了丢最旧的）。
  maxCacheEntries: 50,
  // 「实时库存」那次按条件读**最多看多少行**（防止一个宽关键字把库存整表拖回来）。
  // ⚠️ 撞到这个上限时，没查到的编号一律回 `hasStock: null`（**未确认**）——**绝不猜成"没入库"** ✗。
  stockScanMax: 500,
});

/**
 * ⭐⭐ 2026-10-15（task-11）：**`listLabels`**（`GET /api/workbench/labels` —— 「批量打印 / 选择编号打印」
 * 那一页**进页就自动查一次**）的短 TTL 缓存。
 *
 * 为什么（她原话，2026-10-15 真机）：「我扫完之后…等了一会儿才出现扫描框…整个链路我觉得不太友好」；
 * Lead 线上**只读实测**：`listAll('liveInventory')` 1362 行 5924ms ＋
 * `listAll('product')` 561 行 5478ms ⇒ **她每打开一次那一页都要等 ≈ 11 秒** ✗。
 *
 * ⚠️ `cacheTtlMs = 0` **= 关掉缓存**（每次真读）；默认 60000（她连着翻几次都是秒开）。
 * 🔴 缓存里**只有原始记录**：`keyword` / `state` / `category` / `size` / `recentDays` / `sort`
 *    与「最近新增」的时间判断**一律每请求现算** ✗（连筛选结果一起缓存会串数据）。
 */
const LABEL_LIST = Object.freeze({
  // 缓存有效期（毫秒）。0 = 关掉缓存（每次真读飞书）。
  cacheTtlMs: 60000,
});

/** 标签列表 / 编号清单查询失败时给页面的人话（不放进 TEXTS，避免改变版面镜像形状）。 */
const QUERY_FAILED_FALLBACK = '标签数据读取失败';

/** 用户可见文案（服务端要拼进标签里的那些）。 */
const TEXTS = Object.freeze({
  // 颜色/品类/尺码这类值取不到时的占位（**不留空**，否则标签上看着像漏印了）。
  missingValue: '—',
  // 尺码多到两行都放不下时，最后那个省略号（她定案的规则 ③）。
  overflowMark: '…',
  // 一个编号下同时有多个「所属状态」时（默认不印），它们之间的连接符。
  stateSeparator: '/',
});

/**
 * ⭐⭐ 「**扫码打印**」（2026-10-14 晚）—— 扫标签上的二维码 ⇒ **直接把这一张排进打印队列**。
 *
 * 依据（**都在文件里**，不是偏好）：
 *   · 业务负责人 2026-10-14 晚选了 **ⓐ**「扫完直接打印这一张」
 *     ⇒ `docs/scan-to-print-jsapi-2026-10-14.md`（第 8 行 / AC-SP4 / AC-SP5）；
 *   · 她 2026-10-12 逐字：「**新二维码一律 `https://hm.bamamei.online/r/{recordId}`**（旧贴纸**重打**；
 *     `/s/{编号}` 路径保留但**不再加功能**）」＋「**不需要保持兼容**」
 *     ⇒ `docs/qr-record-id-and-js-2026-10-12.md` / `AGENTS.md`。
 *
 * ⚠️ 这里**只放文案**：URL 的**形状**唯一真源仍是 `config/tagQrCode.js` 的 `SCAN_URL`
 *    （解析器与 `buildLabelScanUrl` 是**一对反函数**，都在 `services/labelPrintService.js`，
 *     都不许抄第二份模板 ✗）。
 * ⚠️ 被拒时的人话必须**可操作**（Lead 2026-10-14 裁决）：旧码要告诉她"这是什么 + 该怎么办"，
 *    不是干巴巴的"格式不对"。
 */
const SCAN_PRINT = Object.freeze({
  texts: Object.freeze({
    // 一个字符都没有（扫码器回了空串）。
    empty: '没有扫到内容，请对着标签上的二维码再扫一次。',
    // ⭐ 旧贴纸（`/s/{编号}`）：说清"这是什么 + 该怎么办"。
    legacySticker: '这是旧版二维码（编号版），扫码打印只认新版标签。'
      + '请到「货品」里找到这一款，重新打印一张新标签再扫。',
    // 压根不是我们的码（别人的二维码 / 一段文字）。
    notLabelCode: '这个码不是我们的标签码（只认「货品」里那个带「记录 ID」的标签码）。'
      + '请扫鞋盒上我们打印的标签。',
    // 记录 ID 读得到，但那一条「货品信息」已经不在了。
    recordMissing: '这个码对应的货品找不到了（记录可能已被删除）。'
      + '请到「货品」里确认这一款，或改用「选择编号打印」。',
    // 货品记录在，但「编号」列是空的 ⇒ 打不了标签（**不猜**）。
    recordNoNumber: '这个码对应的货品还没有「编号」，打不了标签。请先在「货品信息」里补上编号。',
    // 编号读到了，但这一款现在一张可打印的标签都没有（库存 0 / 所属状态为空）。
    noStock: '这个码对应的那一款现在没有可打印的标签（可能库存是 0）。',
  }),
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
  // ⭐ 「扫码打印」的文案（形状仍来自 config/tagQrCode.js，见上面 SCAN_PRINT 的注释）。
  scanPrint: SCAN_PRINT,
  // ⭐⭐ 2026-10-15（task-10）：**配置先行补齐** —— 这两组原先散在 service 的兜底值里。
  //    · `productNumbers` = 只读清单端点的缓存 TTL / limit 默认与上限（**换值不用改代码**）；
  //    · `productCreatedTime` = 「货品信息」创建时间列的**名字 + 类型**两条口径（见上面的说明）。
  productNumbers: PRODUCT_NUMBERS,
  productCreatedTime: PRODUCT_CREATED_TIME,
  // ⭐⭐ 2026-10-15（task-11）：`listLabels`（批量那一页）自己的短 TTL 缓存。
  labelList: LABEL_LIST,
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
  SCAN_PRINT,
  ROW_IDS,
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
  QUERY_FAILED_FALLBACK,
  // ⭐⭐ 2026-10-15（task-10）：这两组也单独导出（用例/排查脚本可以直接 import 拿默认值）。
  PRODUCT_NUMBERS,
  PRODUCT_CREATED_TIME,
  LABEL_LIST,
};
