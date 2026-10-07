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
 *
 * ⚠️ 2026-10-06 第三轮（业务负责人原话）：「底部『合计』留，同色 7+ 尺码截断换行！」
 * ⇒ 一格装不下的「尺码×数量」**换行**画到下一行——行高变高、整张表跟着变高，
 *   **不再截断、不再出现「…」**。⚠️ 字号一个都没动（见 `BODY_FONT_SIZE`）。
 *
 * ⚠️ 2026-10-07 **第四轮**（业务负责人真机测试后当面提，原话）：
 *   「图片底部有共多少条以及合计多少双的不需要了，需要把合计多少双的放在，供应商那一行，
 *    然后报货批次不用显示，所以在供应商那一行是 供应商 报货日期和合计数量……
 *    同样退货单也需要改」
 * ⇒ ① 底部那条「合计：N 条 / M 双」**整条删掉**（`SHOW_TOTAL` / `TOTAL_LABEL` / `FOOTER_*`
 *      已从本文件删除，**不留开关**——它就是不要了；留一个恒 `false` 的开关只会让下一个人
 *      以为"还能打开"）；
 *    ② 「合计 M 双」挪进**副标题（供应商那一行）**，与「供应商」「报货日期」并列
 *      （见 `SUBTITLE_FIELDS`）；⚠️ 只留**双数**，**「N 条」不要了**；
 *    ③ **报货批次不再出现在图上**：它根本不在 `SUBTITLE_FIELDS` 里 —— 删字段就是删渲染，
 *      不在渲染逻辑里留一个"配了才画"的钩子（钩子会让"不显示"变成"看配置"）。
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
// ⚠️ 2026-10-07：`FOOTER_GAP` / `FOOTER_HEIGHT`（底部合计那一条的留白与高度）**已删除** ——
//    底部合计整条不要了，留着两个"没人用、但名字还在"的常量只会让下一个人以为还有那条带子。
const BOTTOM_PADDING = 36;

// ─── 副标题（「供应商」那一行）────────────────────────────────────────────────
// 业务负责人 2026-10-07（逐字，见文件头「第四轮」）：
//   副标题 = **供应商 + 报货日期 + 合计数量**；底部那条合计不要了；报货批次不显示。
// ⚠️ 这里是**这一行唯一的口径来源**：放哪几个字段、每个字段什么文案、字段之间怎么隔，
//    全在这张表里。渲染逻辑按它逐字段取值拼串，**一个字符串都不写死**。
//    · key           —— 渲染端按它取值（见 purchaseRequestImageService 的 subtitleValues）
//    · label         —— 画在图上的前缀（原样，不加工）
//    · format        —— 值 → 图上文本（不填 = 值本身）
//    · hideWhenEmpty —— 值为空时**整段不画**：供应商没维护时不留「供应商：未填写」
//                       那种像警告的文案；合计为 0 时不留「合计：0 双」（正是被禁止的"合计和为 0"）
//    · 数组顺序 = 图上从左到右的顺序
const SUBTITLE_FIELDS = [
  { key: 'supplier', label: '供应商：', hideWhenEmpty: true },
  { key: 'date', label: '报货日期：' },
  { key: 'totalPairs', label: '合计：', format: (totalPairs) => `${totalPairs} 双`, hideWhenEmpty: true },
];
// 字段之间的分隔符：全角空格 ×2（与 2026-10-06 那一版逐字节相同）。
const SUBTITLE_SEPARATOR = '　　';
// 副标题字号、以及"单个字段最长画多宽"（超了截断加「…」）——与改前同款，
// 只是从渲染逻辑里挪到这里（换字号/换截断宽度不用改逻辑）。
const SUBTITLE_FONT_SIZE = 18;
const SUBTITLE_FIELD_MAX_WIDTH = 300;

// ─── 字号与「一格多行」（2026-10-06 第三轮）────────────────────────────────────
// ⚠️ 字号**一个都没动**（业务负责人的原话：「字号不要动 —— 先只做换行，变更小、好回滚」）：
// 正文 22 / 分组行 24 / 表头 20，与改前逐字节一样，只是从"散在渲染逻辑里"挪到这里。
// 挪出来是为了**换行的行距**有一个自己的来源：行距跟着正文字号走，改字号时不会对不上。
const BODY_FONT_SIZE = 22;
const GROUP_FONT_SIZE = 24;
const HEADER_FONT_SIZE = 20;
// 一格里第 2 行起的行距：30px；上下各留 6px 内边距。
// ⚠️ 这两个数的组合是**刻意**选的：30 + 6*2 = 42 = ROW_HEIGHT
// ⇒ **单行的行高与改前完全一致**（这一轮只让"装不下的那些行"变高，普通行一行都不动）。
const LINE_HEIGHT = 30;
const CELL_PADDING_Y = 6;

/**
 * 一行明细的最终高度：单行 = ROW_HEIGHT(42)，每多一行 +LINE_HEIGHT(30)。
 * ⚠️ 这是「换行」的**唯一**几何口径：渲染端按它累加表高，
 * 所以"这一行变高 ⇒ 整张表变高"是同一个数推出来的，不会两处各算一遍、慢慢长歪。
 */
const detailRowHeight = (lineCount) => {
  const lines = Math.max(1, Math.floor(Number(lineCount)) || 1);
  return Math.max(ROW_HEIGHT, lines * LINE_HEIGHT + CELL_PADDING_Y * 2);
};

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
  { key: 'color', label: '说明', width: 240, align: 'start' },
  // ⚠️ `wrap: true`（2026-10-06 第三轮）：这一格的「尺码×数量」**装不下就换行**，
  // 不截断。颜色那一格仍然是截断（颜色是货品库里的短词，240 宽能放 9 个汉字，
  // 真超长说明数据有问题，截断+「…」正好让人一眼看出来）。
  // ⇒ "哪一格换行、哪一格截断"是**配置**，渲染端只读这个标志（见 service 的 layoutColorRows）。
  { key: 'sizeQuantity', label: SIZE_QUANTITY_LABEL, width: 580, align: 'start', wrap: true },
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

// ─── 底部「合计」行（🔴 2026-10-07 **已删**，不要再加回来）──────────────────────
// 业务负责人 2026-10-07（逐字）：「图片底部有共多少条以及合计多少双的不需要了」。
// 删掉的是三样东西：`SHOW_TOTAL`（开关）、`TOTAL_LABEL`（「合计：N 条 / M 双」文案）、
// `FOOTER_GAP` / `FOOTER_HEIGHT`（那一条的留白与高度）。
// ⚠️ **刻意不留开关**：留一个恒 `false` 的 `SHOW_TOTAL` 会让下一个人以为"还能打开"，
//    而她的口径是**不要了**。要回滚请从 git 历史取（`git log -S 'TOTAL_LABEL'`）。
// ⚠️ 「合计」**没有消失**，它挪到了副标题那一行（见 `SUBTITLE_FIELDS`），
//    且只保留**双数**——她明确说「条数」不需要了。

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
  BOTTOM_PADDING,
  CELL_PADDING,
  // 副标题（供应商那一行）：放哪些字段 / 文案 / 分隔符 / 字号 / 截断宽度
  SUBTITLE_FIELDS,
  SUBTITLE_SEPARATOR,
  SUBTITLE_FONT_SIZE,
  SUBTITLE_FIELD_MAX_WIDTH,
  // 字号 / 行距 / 换行后的行高
  BODY_FONT_SIZE,
  GROUP_FONT_SIZE,
  HEADER_FONT_SIZE,
  LINE_HEIGHT,
  CELL_PADDING_Y,
  detailRowHeight,
  // 列与配色
  COLUMNS,
  COLORS,
  // 🔴 底部「合计」那一套（SHOW_TOTAL / TOTAL_LABEL / FOOTER_*）**已于 2026-10-07 删除**，
  //    不要再导出、也不要再加回来 —— 口径与回滚方式见本文件里「底部『合计』行（已删）」一节。
};
