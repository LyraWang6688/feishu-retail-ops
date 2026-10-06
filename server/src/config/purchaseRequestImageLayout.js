/**
 * 「采购单 / 退货单」出图的**排版配置**（配置先行）。
 *
 * 为什么单独一个文件：出图是**给供应商看的单据**，格式会跟着业务负责人的口径反复调
 * （2026-10-06 一天里就改了两轮：先"按货号分组的 3 列版"，再"同颜色并成一行的 2 列版"）。
 * 格式的每一处——列顺序、列宽、分隔符、乘法号、要不要合计——都在这里，
 * 渲染逻辑（`services/purchaseRequestImageService.js`）只消费这些常量：
 * **改格式不用改逻辑，改逻辑不用碰格式**（AGENTS.md《底层工程原则》的「配置先行」）。
 *
 * ⚠️ 采购单与退货单**共用这一份配置**（同一个渲染器、只换标题）：改这里两张图一起变。
 *
 * 当前口径（业务负责人 2026-10-06 原话）：
 *   「一个颜色一行，然后尺码和数量放一块。比方说：41码×1、41码×2、41码×3 这种」
 * ⇒ 分组行（货号）＋ 两列「颜色 | 尺码×数量」；
 *   同货号＋同颜色并成一行，该颜色的所有尺码用「、」拼在同一格里。
 */

// ─── 「尺码×数量」这一格里的两个符号 ────────────────────────────────────────────
// 都是**可读常量**而不是散在字符串里的字面量：她要改成「37码/1」或「37码x1」只需要改这两行。
// ⚠️ 分隔符用顿号「、」是她的原话；乘法号是「×」(U+00D7，不是字母 x)。
const SIZE_QUANTITY_SEPARATOR = '、';
const SIZE_QUANTITY_MULTIPLIER = '×';
// 第二列的列头也由乘法号拼出来，保证「列头」和「格里的写法」永远说的是同一件事。
const SIZE_QUANTITY_LABEL = `尺码${SIZE_QUANTITY_MULTIPLIER}数量`;

// ─── 画布与行高（单位 px）─────────────────────────────────────────────────────
// 宽度取 900：手机微信里放大看货号够清楚，又不至于大到飞书图片消息再次压缩后糊掉。
const WIDTH = 900;
const MARGIN = 40;
const TABLE_WIDTH = WIDTH - MARGIN * 2; // 820
const ROW_HEIGHT = 42;
const HEADER_ROW_HEIGHT = 48;
// 「货号分组行」的高度：夹在表头（48）和正文行（42）之间，
// 让它在视觉上明显是一条**分组标题**，而不是一条普通明细。
const GROUP_ROW_HEIGHT = 44;
const TABLE_TOP = 168;
const TITLE_BASELINE = 78;
const SUBTITLE_BASELINE = 118;
const FOOTER_GAP = 18;
const FOOTER_HEIGHT = 52;
const BOTTOM_PADDING = 36;

// ─── 列（**数组顺序 = 图上从左到右的顺序**）────────────────────────────────────
// ⚠️ 列宽之和必须等于 TABLE_WIDTH（820）——单测钉住了这条不变量。
//
// 合并版是**2 列**（货号是跨列的分组行，不是列；「数量」并进了「尺码×数量」那一格）：
//   颜色 240 | 尺码×数量 580 = 820。
// 为什么颜色从 400 缩到 240：颜色是**货品库里维护的短词**（她真实数据里就是
// 「黑」「黑色」「黑兰」这种 1–4 个字），240 的可画宽度（208px）能放下 9 个汉字；
// 而「尺码×数量」这一格现在要装下**该颜色的全部尺码**（以前一个尺码一行），
// 是这张单的正文信息，必须给它最多空间。
//   · 240 宽 → 可画 208px；
//   · 580 宽 → 可画 548px，`37码×1、41码×3` 只占约 165px，留足了一眼能看的余量。
// ⚠️ 截断按**像素宽度**而不是字符数：一个汉字在 22px 字号下就占 22px，
// 按字符数限制会让 12 个汉字的颜色轻松捅进第二列（真机渲染验证时踩到过）。
const CELL_PADDING = 16;
const COLUMNS = [
  { key: 'color', label: '颜色', width: 240, align: 'start' },
  { key: 'sizeQuantity', label: SIZE_QUANTITY_LABEL, width: 580, align: 'start' },
].map((column) => ({ ...column, maxWidth: column.width - CELL_PADDING * 2 }));

const COLORS = {
  ink: '#1f2329',
  muted: '#646a73',
  line: '#c9cdd4',
  headerBg: '#eef1f5',
  // 「货号分组行」的底色：比表头（headerBg）略深一档，
  // 这样一眼能分出「列头」和「分组标题」两层，而不是糊成一片。
  groupBg: '#e2e8f0',
  stripeBg: '#f7f8fa',
  border: '#8f959e',
};

// ─── 合计行 ──────────────────────────────────────────────────────────────────
// ⚠️ 业务负责人 2026-10-06 的口径是**不做合计**：数量已经写在「尺码×数量」格里，
// 「合计：N 条 / M 双」在合并版里还会失去意义——**「条」原来 = 明细行数，
// 现在同颜色并成一行，"几条"与图上能数出来的行数对不上**。
// 总双数没有丢：它由群文字那条消息带出去
//（`purchaseWebhookService` 的「这批 N 条（共 M 双），图可以直接转给供应商」）。
// 留成开关是为了"改回来只要一个 true"，而不是把这段渲染代码删掉重写。
const SHOW_TOTAL = false;

module.exports = {
  // 格式符号
  SIZE_QUANTITY_SEPARATOR,
  SIZE_QUANTITY_MULTIPLIER,
  SIZE_QUANTITY_LABEL,
  // 画布与行高
  WIDTH,
  MARGIN,
  TABLE_WIDTH,
  ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
  GROUP_ROW_HEIGHT,
  TABLE_TOP,
  TITLE_BASELINE,
  SUBTITLE_BASELINE,
  FOOTER_GAP,
  FOOTER_HEIGHT,
  BOTTOM_PADDING,
  CELL_PADDING,
  // 列与配色
  COLUMNS,
  COLORS,
  // 开关
  SHOW_TOTAL,
};
