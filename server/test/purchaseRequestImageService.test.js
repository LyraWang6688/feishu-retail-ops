const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  TITLE,
  RETURN_TITLE,
  FONT_FAMILY,
  buildPurchaseRequestSvg,
  renderPurchaseRequestPng,
  formatSize,
  summarize,
  normalizeItems,
  truncateToWidth,
  charWidth,
  COLUMNS,
  TABLE_WIDTH,
  GROUP_ROW_HEIGHT,
  UNKNOWN_ITEM_NO,
  groupRowsByItemNo,
  mergeSizesByColor,
  formatSizeQuantity,
  SIZE_QUANTITY_SEPARATOR,
  SIZE_QUANTITY_MULTIPLIER,
  SHOW_TOTAL,
  sizeSortValue,
  compareSize,
  COLORS,
  MARGIN,
  CELL_PADDING,
  TABLE_TOP,
  ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
  LINE_HEIGHT,
  textWidth,
  wrapTextToWidth,
  wrapBlocksToWidth,
  layoutColorRows,
} = require('../src/services/purchaseRequestImageService');
// 排版配置单独一个文件（配置先行）：单测直接对着**配置**断言符号与开关，
// 免得"逻辑里换了字面量、配置里没改"这种两边不一致的情况溜过去。
const LAYOUT = require('../src/config/purchaseRequestImageLayout');

// ─────────────────────────────────────────────────────────────────────────────
// 验收标准（业务负责人 2026-10-06 第三次拍板）——本文件逐条钉住：
//   ① 同一货号的明细聚在一个分组行下；组内**同颜色并成一行**、不同颜色各自一行
//   ② 货号分组行跨满整张表、有底色、字比正文重
//   ③ 尺码×数量拼在**同一格**（`37码×1、41码×3`），颜色（首次出现）＋ 尺码（数字升序、均码最后）
//   ④ 底部**有「合计」行**，且数字 = summarize 口径（N 条 = 明细行数，M 双 = 总双数）；空明细不画
//   ⑤ 两个标题、供应商段（有/无）行为不变；采购单与退货单排版逐字节只差标题
//   ⑥ 空明细不崩；**「尺码×数量」装不下就换行**（整块换行、行首不是顿号、不丢字、不截断），
//      换行后**这一行变高、整张表跟着变高**；不换行的格子（颜色 / 货号）仍按像素宽度截断
// ─────────────────────────────────────────────────────────────────────────────

const ITEMS = [
  { item_no: '8088', color: '黑色', size: 36, quantity: 2 },
  { item_no: '8088', color: '黑色', size: 37, quantity: 1 },
  { item_no: 'A-1366-31', color: '棕色', size: 38, quantity: 3 },
];

// 业务负责人举的那个例子（她真实货号 6C98012-15L）：
// 一个货号 ＋ 一个颜色 ＋ 多个尺码，外加第二个颜色和一条非数字尺码。
const MERGED_ITEMS = [
  { item_no: '6C98012-15L', color: '黑色', size: 37, quantity: 1 },
  { item_no: '6C98012-15L', color: '黑色', size: 41, quantity: 3 },
  { item_no: '6C98012-15L', color: '棕色', size: 39, quantity: 2 },
  { item_no: '6C98012-15L', color: '黑色', size: '均码', quantity: 1 },
];

// 正文单元格的字号 / 分组行标题的字号：验收标准 ② 说的「字比正文重」就是这两个数。
const BODY_FONT_SIZE = 22;
const GROUP_FONT_SIZE = 24;

// ─── 把 SVG **按坐标解析**成有顺序的行，而不是对着整段字符串做 includes ──────
// ⚠️ 只断言「包含某个货号」是钉不住"分组"的：那只证明它出现过，
// 证明不了"同一货号的明细聚在一条分组行下面"、也证明不了先后顺序。
const attrOf = (attributes, name) => {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attributes);
  return match ? match[1] : '';
};

const parseSvg = (svg) => {
  const elements = [];
  const token = /<rect ([^>]*)\/>|<text ([^>]*)>([^<]*)<\/text>/g;
  for (const match of svg.matchAll(token)) {
    if (match[2] !== undefined) {
      elements.push({
        kind: 'text',
        x: Number(attrOf(match[2], 'x')),
        y: Number(attrOf(match[2], 'y')),
        size: Number(attrOf(match[2], 'font-size')),
        bold: /font-weight="bold"/.test(match[2]),
        anchor: attrOf(match[2], 'text-anchor'),
        fontFamily: attrOf(match[2], 'font-family'),
        content: match[3],
      });
    } else {
      elements.push({
        kind: 'rect',
        x: Number(attrOf(match[1], 'x')),
        y: Number(attrOf(match[1], 'y')),
        width: Number(attrOf(match[1], 'width')),
        height: Number(attrOf(match[1], 'height')),
        fill: attrOf(match[1], 'fill'),
      });
    }
  }
  return elements;
};

/**
 * 表格区 → 分组数组，**顺序 = 绘制顺序**。
 * 分组行 = 用 groupBg 铺满整张表的底色矩形 + 紧跟着的加粗大字。
 * 它之后、下一条分组行之前的 22 号正文文本，就是这一组的明细单元格。
 */
const readGroups = (svg) => {
  const elements = parseSvg(svg);
  // 表格外框（fill="none" 的那条）：用它把"表格区"框出来，
  // 免得把表外面的文字也当成最后一条分组的明细单元格。
  const frame = elements.find((element) => element.kind === 'rect'
    && element.fill === 'none' && element.y === TABLE_TOP);
  const tableBottom = frame ? frame.y + frame.height : Number.POSITIVE_INFINITY;
  const groups = [];
  let current = null;
  for (const element of elements) {
    if (element.y < TABLE_TOP || element.y >= tableBottom) continue;
    if (element.kind === 'rect' && element.fill === COLORS.groupBg) {
      current = { band: element, label: null, cells: [] };
      groups.push(current);
      continue;
    }
    if (element.kind !== 'text') continue;
    if (element.size === GROUP_FONT_SIZE && element.bold) {
      if (current) current.label = element;
      continue;
    }
    if (element.size === BODY_FONT_SIZE && current) current.cells.push(element);
  }
  return groups;
};

/**
 * 一组里的明细单元格 → **每行的格文本数组**，按**行几何**分组（不是按索引切片）。
 * ⚠️ 2026-10-06 第三轮起「尺码×数量」那一格可能折成**多行**——
 * 一个颜色行里的 text 数量不再等于 `COLUMNS.length`，"每 N 条算一行"的老写法
 * 会把折出来的第 2 行当成另一个颜色行。
 * 新的判据：**遇到第一列（颜色列）的 x 就另起一行**。绘制顺序本来就是
 * "一行里按列画完，再画下一行"，所以这个判据与画法一一对应。
 */
const cellRowsOf = (group) => {
  const colorX = MARGIN + CELL_PADDING;
  const rows = [];
  for (const cell of group.cells) {
    if (!rows.length || cell.x === colorX) rows.push([]);
    rows[rows.length - 1].push(cell.content);
  }
  return rows;
};

/**
 * 一组里的明细单元格 → [[颜色, 整格「尺码×数量」], ...]（按绘制顺序，一色一行）。
 * 折行的多条 text 用顿号拼回去 —— 拼回去必须**恰好等于**原来的整格文本（换行不丢字、不加字）。
 */
const rowsOf = (group) => cellRowsOf(group).map((cells) => [
  cells[0],
  cells.slice(1).join(SIZE_QUANTITY_SEPARATOR),
]);

/** 每组里「尺码×数量」**实际画出来的每一行**（用来钉住换行发生在哪两块之间）。 */
const sizeLinesOf = (group) => cellRowsOf(group).map((cells) => cells.slice(1));

/** 一张图里所有「×N」的数量之和——用来钉住"合并没吞数量"。 */
const quantityTotalOf = (svg) => [...svg.matchAll(/×(\d+)/g)]
  .reduce((sum, match) => sum + Number(match[1]), 0);

const widthOf = (text, fontSize) => [...text].reduce((sum, char) => sum + charWidth(char, fontSize), 0);

const labelsOf = (groups) => groups.map((group) => group.label.content);
const stripesOf = (svg) => parseSvg(svg)
  .filter((element) => element.kind === 'rect' && element.fill === COLORS.stripeBg)
  .map((element) => element.y);
const verticalsOf = (svg) => [...svg.matchAll(/<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/g)]
  .map((match) => ({
    x1: Number(match[1]), y1: Number(match[2]), x2: Number(match[3]), y2: Number(match[4]),
  }))
  .filter((line) => line.x1 === line.x2 && line.y1 !== line.y2);

// ─────────────────────────────────────────────────────────────────────────────
// ① 同货号 ＋ 同颜色 → 一行（「合并版」的核心）
// ─────────────────────────────────────────────────────────────────────────────

test('① 同颜色并成一行：尺码×数量用「、」拼在同一格，不再一个尺码一行', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'BH-1', items: MERGED_ITEMS });
  const groups = readGroups(svg);
  assert.equal(groups.length, 1, '只有一个货号 → 一条分组行');
  assert.deepEqual(rowsOf(groups[0]), [
    // 黑：37 / 41 / 均码 并成一格；非数字尺码按口径兜到最后
    ['黑色', '37码×1、41码×3、均码×1'],
    // 不同颜色各自一行
    ['棕色', '39码×2'],
  ]);
  assert.equal(rowsOf(groups[0]).length, 2, '3 条黑色明细 + 1 条棕色 → 图上只有 2 行');
  assert.ok(svg.includes('>37码×1、41码×3、均码×1</text>'), '整格文本要能原样在 SVG 里找到');
});

test('① 她举的例子「37码×1、41码×3」必须放得下、不被截断（按像素宽度算）', () => {
  const sample = `${formatSizeQuantity('37码', '1')}${SIZE_QUANTITY_SEPARATOR}${formatSizeQuantity('41码', '3')}`;
  assert.equal(sample, '37码×1、41码×3');
  assert.ok(widthOf(sample, BODY_FONT_SIZE) <= COLUMNS[1].maxWidth,
    `「${sample}」宽 ${widthOf(sample, BODY_FONT_SIZE)}px，超过第二列可画宽度 ${COLUMNS[1].maxWidth}px`);

  const svg = buildPurchaseRequestSvg({
    items: [
      { item_no: '6C98012-15L', color: '黑色', size: 37, quantity: 1 },
      { item_no: '6C98012-15L', color: '黑色', size: 41, quantity: 3 },
    ],
  });
  const cell = rowsOf(readGroups(svg)[0])[0][1];
  assert.equal(cell, '37码×1、41码×3');
  assert.ok(!cell.includes('…'), '这个例子绝不能被截断');
});

test('① 不合并数量：同色同尺码出现两次就写两次（×1、×2），不做加总', () => {
  const svg = buildPurchaseRequestSvg({
    items: [
      { item_no: '8088', color: '黑色', size: 41, quantity: 1 },
      { item_no: '8088', color: '黑色', size: 41, quantity: 2 },
    ],
  });
  assert.deepEqual(rowsOf(readGroups(svg)[0]), [['黑色', '41码×1、41码×2']]);
  assert.equal(quantityTotalOf(svg), 3, '两个数量都还在（1 + 2），没有被并成一条 41码×3');
});

test('① 同一货号的明细全聚在它那条分组行下面，货号按**首次出现**排', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '金猴',
    // 故意把 A-1366-31 插在两条 8088 中间：按首次出现排 → 8088 在前；
    // 且 8088 不能被拆成两条分组行。
    items: [
      { item_no: '8088', color: '黑色', size: 36, quantity: 2 },
      { item_no: 'A-1366-31', color: '棕色', size: 38, quantity: 3 },
      { item_no: '8088', color: '黑色', size: 37, quantity: 1 },
      { item_no: '8088', color: '棕色', size: 37, quantity: 1 },
    ],
  });
  const groups = readGroups(svg);
  assert.deepEqual(labelsOf(groups), ['8088', 'A-1366-31'], '货号按首次出现顺序');
  assert.deepEqual(groups.map((group) => rowsOf(group).length), [2, 1],
    '8088 的三条必须聚在同一分组行下（黑色 2 条并成 1 行 + 棕色 1 行）');
  assert.deepEqual(rowsOf(groups[0]), [
    ['黑色', '36码×2、37码×1'],
    ['棕色', '37码×1'],
  ]);
  assert.deepEqual(rowsOf(groups[1]), [['棕色', '38码×3']]);

  // 分组行的 y 必须严格递增，且组内明细行的 y 也严格递增（顺序 = 视觉上的从上到下）
  for (let index = 1; index < groups.length; index += 1) {
    assert.ok(groups[index].band.y > groups[index - 1].band.y, '分组行的先后顺序必须与绘制顺序一致');
  }
  for (const group of groups) {
    const tops = group.cells.filter((_, cellIndex) => cellIndex % COLUMNS.length === 0).map((cell) => cell.y);
    assert.deepEqual(tops, [...tops].sort((a, b) => a - b), '组内明细行必须自上而下');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 分组行：跨满整张表、有底色、字比正文重
// ─────────────────────────────────────────────────────────────────────────────

test('② 分组行：每个货号一条，跨满整张表、有底色、字比正文重', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'BH-1', items: ITEMS });
  const groups = readGroups(svg);
  assert.equal(groups.length, 2, '两个货号 → 两条分组行');
  assert.equal((svg.match(/<svg /g) || []).length, 1, '同一张图里分组，不是每个货号一张图');

  for (const group of groups) {
    assert.equal(group.band.x, MARGIN, '分组行底色从头开始');
    assert.equal(group.band.width, TABLE_WIDTH, '分组行必须跨满整张表宽');
    assert.equal(group.band.height, GROUP_ROW_HEIGHT);
    assert.equal(group.band.fill, COLORS.groupBg, '分组行必须有底色');
    assert.equal(group.label.x, MARGIN + CELL_PADDING, '分组行文字从跨列区域的左边距起');
    assert.equal(group.label.anchor, 'start');
    assert.equal(group.label.size, GROUP_FONT_SIZE);
    assert.ok(group.label.bold, '分组行的字要比正文重');
    assert.ok(group.label.size > BODY_FONT_SIZE, '分组行字号要大于正文');
    assert.ok(group.label.y > group.band.y && group.label.y < group.band.y + GROUP_ROW_HEIGHT,
      '分组行文字必须落在自己那条底色带里');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 组内顺序：颜色按首次出现、颜色内尺码数字升序（非数字兜最后）
// ─────────────────────────────────────────────────────────────────────────────

test('③ 组内排序：颜色按首次出现分组，颜色内尺码按【数字】升序，非数字尺码兜到最后', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '金猴',
    items: [
      { item_no: '2070-9', color: '黑', size: 41, quantity: 1 },
      { item_no: '2070-9', color: '棕', size: 9, quantity: 1 },
      { item_no: '2070-9', color: '黑', size: 40, quantity: 1 },
      { item_no: '2070-9', color: '黑', size: '均码', quantity: 1 },
      { item_no: '2070-9', color: '棕', size: 40, quantity: 1 },
      { item_no: '2070-9', color: '黑', size: 9, quantity: 1 },
    ],
  });
  const groups = readGroups(svg);
  assert.deepEqual(rowsOf(groups[0]), [
    ['黑', '9码×1、40码×1、41码×1、均码×1'],
    ['棕', '9码×1、40码×1'],
  ]);
  // ⚠️ 字符串序恰好是反的（'40码' < '9码'），所以这条断言就是"按数字排"的钉子。
  assert.ok('40码' < '9码', '对照：字符串序下 40 排在 9 前面');
  assert.ok(svg.indexOf('>9码') < svg.indexOf('40码'), '图上 9 码必须排在 40 码前面');
});

test('③ 尺码数字序：取「XX码」的数字部分；非数字尺码（均码/XL）一律排到有数字的后面', () => {
  assert.equal(sizeSortValue('37码'), 37);
  assert.equal(sizeSortValue('40.5码'), 40.5);
  assert.equal(sizeSortValue('均码'), null);
  assert.equal(sizeSortValue('XL'), null);
  assert.equal(sizeSortValue(''), null);
  assert.equal(sizeSortValue(null), null);

  assert.deepEqual(
    ['41码', '9码', '均码', '40码', '37码', 'XL'].sort(compareSize),
    ['9码', '37码', '40码', '41码', 'XL', '均码'],
  );
  assert.ok(compareSize('40码', '9码') > 0, '数字序：40 大于 9');
  assert.ok(compareSize('37码', '均码') < 0, '非数字尺码排在数字后面');
  assert.equal(compareSize('37码', '37码'), 0);
  assert.equal(compareSize('均码', '均码'), 0);
});

test('① 组内明细行不再重复写货号：每行只有 颜色 | 尺码×数量 两格，货号只在分组行出现一次', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  const groups = readGroups(svg);
  for (const group of groups) {
    assert.equal(group.cells.length % COLUMNS.length, 0, `每行必须正好 ${COLUMNS.length} 格`);
    for (const row of rowsOf(group)) assert.equal(row.length, 2);
  }
  assert.equal((svg.match(/>8088</g) || []).length, 1, '货号只在分组行写一次');
  assert.equal((svg.match(/>A-1366-31</g) || []).length, 1, '货号只在分组行写一次');
  assert.ok(!svg.includes('>货号</text>'), '货号已经变成分组行，表头里不该再有「货号」这一列');
  // 合并版里「数量」不再是单独一列
  assert.ok(!svg.includes('>数量</text>'), '「数量」列已经并进「尺码×数量」那一格');
  assert.equal(COLUMNS.length, 2);
});

test('① 货号缺失的明细兜底成「未标注货号」分组行，不会被并进上一组', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '金猴',
    items: [
      { item_no: '8088', color: '黑色', size: 36, quantity: 1 },
      { item_no: '', color: '棕色', size: 37, quantity: 1 },
    ],
  });
  const groups = readGroups(svg);
  assert.deepEqual(labelsOf(groups), ['8088', UNKNOWN_ITEM_NO]);
  assert.deepEqual(rowsOf(groups[1]), [['棕色', '37码×1']]);
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 底部「合计」回来了（2026-10-06 第三轮：「底部『合计』留」）；数字 = summarize 口径
// ─────────────────────────────────────────────────────────────────────────────

/** 图上那条合计文本（不存在时返回 null）——按内容找，不靠"最后一条 text"。 */
const totalTextOf = (svg) => parseSvg(svg)
  .filter((element) => element.kind === 'text' && element.content.startsWith('合计'))
  .map((element) => element.content)[0] || null;

test('④ 图上画「合计：N 条 / M 双」：N = 明细行数、M = 总双数，两个数都与 summarize 一致', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });

  assert.equal(SHOW_TOTAL, true, '业务负责人 2026-10-06 第三轮：「底部『合计』留」');
  assert.equal(LAYOUT.SHOW_TOTAL, true, '开关在配置里，逻辑不写死');
  assert.equal(LAYOUT.TOTAL_LABEL({ rowCount: 3, totalPairs: 6 }), '合计：3 条 / 6 双',
    '文案的唯一出处是配置里的 TOTAL_LABEL');

  // ITEMS = 3 条明细（3 个「尺码×数量」块）/ 2+1+3 = 6 双
  assert.deepEqual(summarize(normalizeItems(ITEMS)), { rowCount: 3, totalPairs: 6 });
  assert.equal(totalTextOf(svg), '合计：3 条 / 6 双', '图上的数字必须与 summarize 一致');

  // 「条」= 图上「尺码×数量」块的总数：一格里有几块就数几块 —— 与合计里的 N 对得上，
  // 这正是"合并成一行之后『条』仍然说得通"的判据（不是图上数得出来的行数）。
  const blocks = [...svg.matchAll(/[0-9]+(?:\.[0-9]+)?码?×\d+/g)].length;
  assert.equal(blocks, 3, `图上应正好 3 个「尺码×数量」块：${blocks}`);

  // 合并不吞数量、不丢行：图上各格 ×N 之和 == 原始双数 == 合计里的 M
  assert.equal(quantityTotalOf(svg), 6);
  assert.equal(readGroups(svg).flatMap((group) => rowsOf(group)).length, 2, '3 条明细 → 2 个颜色行');
});

test('④ 合计行在**表格下面**、居中等宽、加粗；表高不含它（它挂在 FOOTER 上）', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  const elements = parseSvg(svg);
  const frame = elements.find((element) => element.kind === 'rect' && element.fill === 'none' && element.y === TABLE_TOP);
  const total = elements.find((element) => element.kind === 'text' && element.content === '合计：3 条 / 6 双');
  assert.ok(total, '必须有合计那一条 text');
  assert.equal(total.anchor, 'middle', '合计居中');
  assert.equal(total.x, 450, '合计在画布中线');
  assert.ok(total.bold, '合计加粗');
  assert.ok(total.y > frame.y + frame.height, '合计必须落在表格**下面**，不能压在明细上');
  assert.equal(total.size, LAYOUT.BODY_FONT_SIZE, '合计沿用正文字号（这一轮不动字号）');
});

test('④ 合计口径不是"图上数得出来的行数"：颜色并成一行后，条数照旧按明细算', () => {
  // MERGED_ITEMS：4 条明细（黑 3 + 棕 1）→ 图上只有 2 个颜色行，但合计仍是 4 条 / 7 双。
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: MERGED_ITEMS });
  assert.deepEqual(summarize(normalizeItems(MERGED_ITEMS)), { rowCount: 4, totalPairs: 7 });
  assert.equal(readGroups(svg).flatMap((group) => rowsOf(group)).length, 2, '图上 2 行');
  assert.equal(totalTextOf(svg), '合计：4 条 / 7 双', '合计按**明细**算，不按图上的行数算');
});

// ─────────────────────────────────────────────────────────────────────────────
// 布局：列宽、竖线、斑马纹
// ─────────────────────────────────────────────────────────────────────────────

test('列宽之和必须等于 TABLE_WIDTH（820），两列顺序 = 颜色 → 尺码×数量', () => {
  assert.equal(TABLE_WIDTH, 820);
  assert.equal(COLUMNS.reduce((sum, column) => sum + column.width, 0), TABLE_WIDTH, '列宽之和必须 === 820');
  assert.equal(COLUMNS.length, 2, '合并版是 2 列：颜色 | 尺码×数量');
  assert.deepEqual(COLUMNS.map((column) => column.key), ['color', 'sizeQuantity']);
  assert.equal(COLUMNS[1].label, `尺码${SIZE_QUANTITY_MULTIPLIER}数量`, '列头由乘法号常量拼出来');
  // ⚠️ 口径变了：以前"颜色最长、给最多空间"，现在**尺码×数量是正文信息**
  //（一个颜色的全部尺码都挤在这一格），必须拿到最多宽度；颜色是货品库里的短词。
  const widest = COLUMNS.reduce((best, column) => (column.width > best.width ? column : best));
  assert.equal(widest.key, 'sizeQuantity', '「尺码×数量」要拿最多的宽度');
  for (const column of COLUMNS) {
    assert.equal(column.maxWidth, column.width - CELL_PADDING * 2);
  }
});

test('格式符号只有一个来源：分隔符「、」与乘法号「×」来自排版配置', () => {
  assert.equal(SIZE_QUANTITY_SEPARATOR, '、', '业务负责人要的是顿号');
  assert.equal(SIZE_QUANTITY_MULTIPLIER, '×', '乘法号是 U+00D7，不是字母 x');
  assert.equal(LAYOUT.SIZE_QUANTITY_SEPARATOR, SIZE_QUANTITY_SEPARATOR);
  assert.equal(LAYOUT.SIZE_QUANTITY_MULTIPLIER, SIZE_QUANTITY_MULTIPLIER);
  assert.equal(LAYOUT.SIZE_QUANTITY_LABEL, COLUMNS[1].label);
  assert.equal(formatSizeQuantity('37码', '1'), `37码${SIZE_QUANTITY_MULTIPLIER}1`);

  const svg = buildPurchaseRequestSvg({ items: MERGED_ITEMS });
  assert.ok(svg.includes(`>尺码${SIZE_QUANTITY_MULTIPLIER}数量</text>`), '图上的列头也用同一个常量');
  assert.ok(svg.includes(SIZE_QUANTITY_SEPARATOR), '格里的分隔符就是它');
  assert.ok(!svg.includes('码x') && !svg.includes('码 x'), '不能退化成字母 x');
});

test('竖线只画在列头与各组明细那一段，绝不横穿跨列的分组行', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  const groups = readGroups(svg);
  const verticals = verticalsOf(svg);

  // 列头 1 段 + 每个货号 1 段，每段 COLUMNS.length - 1 条竖线
  assert.equal(verticals.length, (COLUMNS.length - 1) * (groups.length + 1));

  for (const group of groups) {
    const bandTop = group.band.y;
    const bandBottom = bandTop + GROUP_ROW_HEIGHT;
    for (const line of verticals) {
      assert.ok(line.y2 <= bandTop || line.y1 >= bandBottom,
        `竖线 x=${line.x1} 横穿了「${group.label.content}」的分组行（y ${line.y1}~${line.y2}）`);
    }
  }
  // 每组明细那一段确实有竖线兜住（长度按**颜色行数**算，不是明细条数）
  for (const group of groups) {
    const detailTop = group.band.y + GROUP_ROW_HEIGHT;
    const detailBottom = detailTop + rowsOf(group).length * ROW_HEIGHT;
    const covering = verticals.filter((line) => line.y1 === detailTop && line.y2 === detailBottom);
    assert.equal(covering.length, COLUMNS.length - 1, '每组明细都要有自己的列间竖线');
  }
});

test('斑马纹保留，按**颜色行**在分组内重新起算（每组第 1 行永远是白底）', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '金猴',
    items: [
      // 一个货号三个颜色 → 3 个颜色行（第 2 行起有斑马纹）
      { item_no: '8088', color: '黑', size: 36, quantity: 1 },
      { item_no: '8088', color: '棕', size: 36, quantity: 1 },
      { item_no: '8088', color: '米', size: 36, quantity: 1 },
      { item_no: 'A-1', color: '棕', size: 39, quantity: 1 },
      { item_no: 'A-1', color: '黑', size: 40, quantity: 1 },
    ],
  });
  const groups = readGroups(svg);
  const expected = [];
  for (const group of groups) {
    const detailTop = group.band.y + GROUP_ROW_HEIGHT;
    const rowCount = rowsOf(group).length;
    for (let index = 1; index < rowCount; index += 2) {
      expected.push(detailTop + index * ROW_HEIGHT);
    }
  }
  assert.ok(expected.length > 0, '这个用例里必须有斑马纹行，否则断言等于没测');
  assert.deepEqual(stripesOf(svg), expected, '斑马纹按分组内序号起算');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑤ 标题 / 供应商段（行为不变）
// ─────────────────────────────────────────────────────────────────────────────

test('⑤ 标题文案：采购单 = 「邯美皮鞋采购单」，退货单 = 「邯美皮鞋退货单」；旧标题一个都不留', () => {
  assert.equal(TITLE, '邯美皮鞋采购单');
  assert.equal(RETURN_TITLE, '邯美皮鞋退货单');

  const requestSvg = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'B-1', items: MERGED_ITEMS });
  assert.ok(requestSvg.includes('>邯美皮鞋采购单</text>'), '默认标题必须是「邯美皮鞋采购单」');
  assert.ok(!requestSvg.includes('邯美皮鞋采购申请单'), '旧标题「邯美皮鞋采购申请单」不能再出现');

  const returnSvg = buildPurchaseRequestSvg({
    supplierName: '金猴', batchNo: 'B-1', items: MERGED_ITEMS, title: RETURN_TITLE,
  });
  assert.ok(returnSvg.includes('>邯美皮鞋退货单</text>'), '退货标题必须是「邯美皮鞋退货单」');
  assert.ok(!returnSvg.includes('邯美皮鞋采购退货单'), '旧标题「邯美皮鞋采购退货单」不能再出现');
  // 只换标题：两种单据的合并排版必须一模一样
  assert.deepEqual(labelsOf(readGroups(returnSvg)), labelsOf(readGroups(requestSvg)));
  assert.deepEqual(rowsOf(readGroups(returnSvg)[0]), rowsOf(readGroups(requestSvg)[0]));
});

test('⑤ 没维护供应商：不画「供应商：」这一段（不是「未填写」那种像警告的文案）；有供应商时照旧画', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '', batchNo: 'B-1', items: ITEMS });
  assert.ok(!svg.includes('供应商'), '没有供应商时不该出现「供应商」三个字');
  assert.ok(!svg.includes('未填写'), '也不该写成「供应商：未填写」');
  assert.ok(svg.includes('报货批次：B-1'), '其余副标题照常渲染');

  assert.ok(
    buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS }).includes('供应商：金猴'),
    '有供应商时照旧渲染「供应商：xxx」',
  );
});

test('字体显式指定 CJK 字体，中文不会渲染成方框（分组行也不例外）', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  assert.equal(FONT_FAMILY, 'Noto Sans CJK SC, Noto Serif CJK SC, Noto Sans SC, WenQuanYi Zen Hei, sans-serif');
  const fontAttributes = svg.match(/font-family="[^"]*"/g) || [];
  assert.ok(fontAttributes.length >= 5, '每个文本节点都要带 font-family');
  assert.ok(fontAttributes.every((attribute) => attribute.includes('Noto Sans CJK SC')));
  for (const group of readGroups(svg)) {
    assert.equal(group.label.fontFamily, FONT_FAMILY, '分组行也必须带 CJK 字体链');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 空明细 / 截断 / 转义 / PNG
// ─────────────────────────────────────────────────────────────────────────────

test('⑥ 空明细不崩：照旧给「本批次没有明细」，不画任何分组行、也不画合计（0 条 / 0 双 不许出现）', () => {
  for (const items of [[], undefined, null]) {
    const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items });
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('本批次没有明细'));
    assert.equal(totalTextOf(svg), null, '空明细不画合计——「合计：0 条 / 0 双」正是被禁止的"合计和为 0"');
    assert.deepEqual(readGroups(svg), [], '空明细不该产出一条空的分组行');
    assert.deepEqual(stripesOf(svg), []);
  }
});

test('超长颜色按列宽截断；超长货号（分组行）按跨列宽度截断；都不溢出', () => {
  const longItemNo = 'A'.repeat(120);
  const longColor = '深'.repeat(60);
  const svg = buildPurchaseRequestSvg({
    supplierName: '金猴',
    items: [{ item_no: longItemNo, color: longColor, size: 36, quantity: 1 }],
  });
  const groups = readGroups(svg);
  assert.equal(groups.length, 1);
  assert.ok(!svg.includes(longItemNo), '超长货号必须被截断');
  assert.ok(groups[0].label.content.endsWith('…') && groups[0].label.content.length < longItemNo.length);
  assert.ok(svg.includes('…'), '截断要有省略号，让人看得出被截了');

  // 分组行：可画宽度 = TABLE_WIDTH 去掉左右内边距
  assert.ok(
    widthOf(groups[0].label.content, GROUP_FONT_SIZE) <= TABLE_WIDTH - CELL_PADDING * 2,
    `分组行文字宽度超出跨列区域：${groups[0].label.content}`,
  );
  // 正文颜色单元格：可画宽度 = 列宽 - 32（合并版颜色列窄了：240 → 可画 208px = 9 个汉字）
  const colorCell = rowsOf(groups[0])[0][0];
  assert.ok(widthOf(colorCell, BODY_FONT_SIZE) <= COLUMNS[0].width - CELL_PADDING * 2,
    `颜色单元格宽度超出列宽：${colorCell}`);
  assert.ok(colorCell.endsWith('…'), `颜色截断要有省略号：${colorCell}`);
  assert.ok([...colorCell].length <= 10, `颜色截断过长：${colorCell}`);
});

test('⑥ 尺码×数量：6 个尺码一行放得下；第 7 个起**【换行】不截断**（业务负责人 2026-10-06 第三轮）', () => {
  const sizes = [35, 36, 37, 38, 39, 40, 41, 42, 43];
  const build = (count) => buildPurchaseRequestSvg({
    supplierName: '金猴',
    items: sizes.slice(0, count).map((size) => ({ item_no: '6C98012-15L', color: '黑色', size, quantity: 1 })),
  });
  const cellOf = (count) => rowsOf(readGroups(build(count))[0])[0][1];
  const sizeLines = (count) => sizeLinesOf(readGroups(build(count))[0])[0];
  const heightOf = (count) => Number(/height="(\d+)"/.exec(build(count))[1]);

  // 6 个尺码：仍然是**一行**放得下（压力图验证过的边界，口径不变）
  const six = cellOf(6);
  assert.equal(six, '35码×1、36码×1、37码×1、38码×1、39码×1、40码×1');
  assert.ok(!six.includes('…'), '6 个尺码必须全部放得下');
  assert.equal(sizeLines(6).length, 1, '6 个尺码仍然只有一行');
  assert.ok(widthOf(six, BODY_FONT_SIZE) <= COLUMNS[1].maxWidth);

  // ⚠️ 第 7 个起：**换行**（不再截断、不再有「…」）—— 这一条就是本次改动的钉子
  const seven = cellOf(7);
  assert.ok(!seven.includes('…'), `7 个尺码不能再出现省略号：${seven}`);
  assert.equal(seven, '35码×1、36码×1、37码×1、38码×1、39码×1、40码×1、41码×1', '一个字都不能少');
  const lines = sizeLines(7);
  assert.equal(lines.length, 2, '7 个尺码 → 2 行');
  // 换行按**整块**「尺码×数量」切：不会出现「41码×」这种被劈开的半块
  assert.deepEqual(lines, ['35码×1、36码×1、37码×1、38码×1、39码×1、40码×1', '41码×1']);
  for (const line of lines) {
    assert.ok(widthOf(line, BODY_FONT_SIZE) <= COLUMNS[1].maxWidth, `换行后仍不得溢出列宽：${line}`);
    assert.ok(!line.startsWith(SIZE_QUANTITY_SEPARATOR), `行首不能是顿号：${line}`);
    assert.ok(!line.endsWith(SIZE_QUANTITY_SEPARATOR), `行尾不留顿号：${line}`);
    assert.ok(/^\d/.test(line), '每一行都从尺码的数字开始（顿号只出现在两块之间）');
  }

  // 换行后**这一行的行高变高**，整张表跟着变高：正好多一个 LINE_HEIGHT
  assert.equal(heightOf(7) - heightOf(6), LINE_HEIGHT, '表高必须跟着换行变高');
  // 再多尺码只是把第 2 行填满，还是 2 行 → 高度一样（不会每多一个尺码就再长高一行）
  assert.equal(heightOf(9), heightOf(7), '9 个尺码仍然只占 2 行');

  // 行高本身：单行 42（与改前一致），两行 42 + LINE_HEIGHT
  assert.equal(LAYOUT.detailRowHeight(1), ROW_HEIGHT);
  assert.equal(LAYOUT.detailRowHeight(2), ROW_HEIGHT + LINE_HEIGHT);
});

test('⑥ 换行纯函数：整块换行、行首不是顿号、单块超宽时按字符拆也**不丢字**', () => {
  const maxWidth = COLUMNS[1].maxWidth;
  const blocks = ['35码×1', '36码×1', '37码×1'];

  // 够宽 → 拼成一行，分隔符照旧
  assert.deepEqual(wrapBlocksToWidth(blocks, 1000, BODY_FONT_SIZE), ['35码×1、36码×1、37码×1']);
  // 只够两块 → 第 3 块另起一行（行首是尺码，不是顿号）
  const twoPerLine = wrapBlocksToWidth(blocks, widthOf('35码×1、36码×1', BODY_FONT_SIZE), BODY_FONT_SIZE);
  assert.deepEqual(twoPerLine, ['35码×1、36码×1', '37码×1']);
  // 换行**不丢字**：拼回去必须等于原文本
  const wrapped = wrapBlocksToWidth(blocks, 100, BODY_FONT_SIZE);
  assert.equal(wrapped.join(SIZE_QUANTITY_SEPARATOR), blocks.join(SIZE_QUANTITY_SEPARATOR));
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => !line.startsWith(SIZE_QUANTITY_SEPARATOR)));

  // 单块自己就超宽（脏数据）→ 按字符拆，**一个字都不丢**（不截断、不加省略号）
  const huge = ['深'.repeat(40)];
  const pieces = wrapBlocksToWidth(huge, maxWidth, BODY_FONT_SIZE);
  assert.ok(pieces.length > 1);
  assert.equal(pieces.join(''), huge[0], '按字符拆也不许丢字');
  assert.ok(!pieces.join('').includes('…'), '不截断 —— 不该出现省略号');
  assert.equal(wrapTextToWidth('深'.repeat(40), maxWidth, BODY_FONT_SIZE).join(''), '深'.repeat(40));

  // 脏输入不炸
  assert.deepEqual(wrapBlocksToWidth([], maxWidth, BODY_FONT_SIZE), ['']);
  assert.deepEqual(wrapBlocksToWidth(null, maxWidth, BODY_FONT_SIZE), ['']);
  assert.deepEqual(wrapTextToWidth('', maxWidth, BODY_FONT_SIZE), ['']);
});

test('⑥ 行布局纯函数 layoutColorRows：只有标了 wrap 的格子折行，颜色格仍然截断', () => {
  const rows = mergeSizesByColor(normalizeItems(
    [35, 36, 37, 38, 39, 40, 41].map((size) => ({ item_no: '6C98012-15L', color: '黑色', size, quantity: 1 })),
  ));
  const laid = layoutColorRows(rows);
  assert.equal(laid.length, 1);
  assert.equal(laid[0].lineCount, 2, '7 个尺码 → 2 行');
  assert.equal(laid[0].height, ROW_HEIGHT + LINE_HEIGHT);
  assert.deepEqual(laid[0].cellLines[0], ['黑色'], '颜色格永远只有一行');
  assert.equal(laid[0].cellLines[1].length, 2, '尺码×数量格折成 2 行');
  // 原样字段一个都没丢（sizeQuantity 仍是"不换行时的样子"）
  assert.equal(laid[0].sizeQuantity, '35码×1、36码×1、37码×1、38码×1、39码×1、40码×1、41码×1');
  assert.equal(COLUMNS[1].wrap, true, '「哪一格换行」是配置：尺码×数量格标了 wrap');
  assert.ok(!COLUMNS[0].wrap, '颜色格不换行（仍然是截断）');

  // 颜色超长仍然截断（这一轮只改尺码×数量那一格）
  const longColor = layoutColorRows(mergeSizesByColor(normalizeItems(
    [{ item_no: 'A', color: '深'.repeat(60), size: 36, quantity: 1 }],
  )));
  assert.ok(longColor[0].cellLines[0][0].endsWith('…'), '颜色超长照旧截断');
});

test('XML 特殊字符被转义，不会被当成标签（分组行与正文行都要转义）', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '<金猴&co>',
    items: [{ item_no: 'A"1\'', color: '<黑>', size: 36, quantity: 1 }],
  });
  assert.ok(svg.includes('&lt;金猴&amp;co&gt;'));
  assert.ok(!svg.includes('<金猴'));
  assert.ok(svg.includes('A&quot;1&apos;'), '分组行的货号也要转义');
  assert.ok(svg.includes('&lt;黑&gt;'), '正文的颜色也要转义');
});

test('尺码写法与 summarize 的口径', () => {
  assert.equal(formatSize(37), '37码');
  assert.equal(formatSize('37'), '37码');
  // 已经带「码」或不是纯数字的值原样保留，不重复补字
  assert.equal(formatSize('37码'), '37码');
  assert.equal(formatSize(''), '');
  assert.equal(formatSize(null), '');

  const rows = normalizeItems([{ item_no: '8088', size: 36, quantity: 2 }, { item_no: '', size: 37, quantity: 1 }]);
  assert.equal(rows.length, 2);
  assert.deepEqual(summarize(rows), { rowCount: 2, totalPairs: 3 });
  // 数量和货号都认不出来时按 0 处理，不能算出 NaN 污染合计
  assert.deepEqual(summarize(normalizeItems([{ item_no: '8088', size: 36, quantity: '' }])), { rowCount: 1, totalPairs: 0 });
  // 数量为 0 也照写出来（图是给供应商看的，不悄悄少写一双）
  assert.equal(formatSizeQuantity('36码', '0'), `36码${SIZE_QUANTITY_MULTIPLIER}0`);
});

test('按像素宽度截断：汉字按 1 个字宽算，放不下才加省略号', () => {
  // 一个 22px 的汉字占 22px，8 个就是 176px，第 9 个会超过 188px 的可用宽度。
  assert.equal(truncateToWidth('深'.repeat(60), 188, 22), `${'深'.repeat(7)}…`);
  // 汉字放得下就一个字都不动
  assert.equal(truncateToWidth('黑色', 188, 22), '黑色');
  // 半角字符更窄：同样的像素宽度能放更多字符
  assert.equal(truncateToWidth('A'.repeat(80), 288, 22), `${'A'.repeat(22)}…`);
  assert.ok(charWidth('深', 22) > charWidth('A', 22));
  // 空值不炸
  assert.equal(truncateToWidth('', 100, 22), '');
  assert.equal(truncateToWidth(null, 100, 22), '');
});

test('分组纯函数：groupRowsByItemNo 只重排显示顺序，不增删行（仍是一个尺码一行）', () => {
  const rows = normalizeItems([
    { item_no: 'B', color: '黑', size: 40, quantity: 1 },
    { item_no: 'A', color: '黑', size: 41, quantity: 2 },
    { item_no: 'B', color: '黑', size: 9, quantity: 3 },
    { item_no: 'A', color: '棕', size: 41, quantity: 4 },
  ]);
  const groups = groupRowsByItemNo(rows);
  assert.deepEqual(groups.map((group) => group.itemNo), ['B', 'A'], '按首次出现');
  assert.deepEqual(groups[0].rows.map((row) => row.size), ['9码', '40码']);
  assert.deepEqual(groups[1].rows.map((row) => row.size), ['41码', '41码']);
  assert.deepEqual(groups[1].rows.map((row) => row.color), ['黑', '棕']);
  assert.equal(groups.reduce((sum, group) => sum + group.rows.length, 0), rows.length, '不丢行');
  assert.deepEqual(summarize(rows), { rowCount: 4, totalPairs: 10 });
  assert.deepEqual(groupRowsByItemNo([]), []);
});

test('归并纯函数：mergeSizesByColor 同颜色并一行、尺码数字序、数量一个都不加总', () => {
  const rows = normalizeItems([
    { item_no: 'A', color: '黑', size: 41, quantity: 2 },
    { item_no: 'A', color: '黑', size: 9, quantity: 3 },
    { item_no: 'A', color: '黑', size: '均码', quantity: 1 },
    { item_no: 'A', color: '棕', size: 40, quantity: 4 },
  ]);
  const merged = mergeSizesByColor(rows);
  assert.deepEqual(merged, [
    {
      color: '黑',
      sizeQuantity: `9码${SIZE_QUANTITY_MULTIPLIER}3、41码${SIZE_QUANTITY_MULTIPLIER}2、均码${SIZE_QUANTITY_MULTIPLIER}1`,
      // ⚠️ 整块列表（第三轮加的）：换行必须按整块换，渲染端要拿到"块"而不是只能拿到拼好的串
      sizeQuantities: [
        `9码${SIZE_QUANTITY_MULTIPLIER}3`,
        `41码${SIZE_QUANTITY_MULTIPLIER}2`,
        `均码${SIZE_QUANTITY_MULTIPLIER}1`,
      ],
    },
    {
      color: '棕',
      sizeQuantity: `40码${SIZE_QUANTITY_MULTIPLIER}4`,
      sizeQuantities: [`40码${SIZE_QUANTITY_MULTIPLIER}4`],
    },
  ]);
  // 块列表与整格文本必须永远一致（一个来源，否则"合的"和"画的"会分家）
  for (const row of merged) {
    assert.equal(row.sizeQuantities.join(SIZE_QUANTITY_SEPARATOR), row.sizeQuantity);
  }
  // 颜色按**首次出现**（输入里 黑 在前 → 黑 那行在前）
  assert.deepEqual(merged.map((row) => row.color), ['黑', '棕']);
  // 打乱输入：同一个颜色的格文本必须一模一样（函数自己排尺码，不依赖上游顺序）
  const shuffled = mergeSizesByColor([rows[2], rows[0], rows[3], rows[1]]);
  assert.equal(shuffled[0].sizeQuantity, merged[0].sizeQuantity);
  // 空输入 / 脏输入不炸
  assert.deepEqual(mergeSizesByColor([]), []);
  assert.deepEqual(mergeSizesByColor(undefined), []);
});

test('采购申请 PNG：sharp 真的渲染出 900px 宽的 PNG（高度按分组行 + 颜色行变）', async () => {
  const png = await renderPurchaseRequestPng({ supplierName: '金猴', batchNo: 'BH-20261005-0001', items: ITEMS });
  assert.ok(Buffer.isBuffer(png));
  // PNG 魔数：确认拿到的是图片而不是 SVG 字符串
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 900);
  assert.ok(metadata.height > 100 && metadata.height < 2000);

  // 加一个货号 = 多一条分组行 + 它的颜色行 → 图必须变高（分组行真的占位了）
  const taller = await renderPurchaseRequestPng({
    supplierName: '金猴',
    items: [...ITEMS, { item_no: '9999', color: '米色', size: 39, quantity: 1 }],
  });
  const tallerMeta = await sharp(taller).metadata();
  assert.equal(tallerMeta.height - metadata.height, GROUP_ROW_HEIGHT + ROW_HEIGHT);

  // 同一个货号加一个**新颜色** = 多一个颜色行（不是多一条分组行）→ 只高一行
  const extraColor = await renderPurchaseRequestPng({
    supplierName: '金猴',
    items: [...ITEMS, { item_no: '8088', color: '米色', size: 39, quantity: 1 }],
  });
  const extraColorMeta = await sharp(extraColor).metadata();
  assert.equal(extraColorMeta.height - metadata.height, ROW_HEIGHT, '新颜色只加一行颜色行');
});

test('采购申请 PNG：一个颜色 7 个尺码 → 换行后 **PNG 真的更高**（不只是 SVG 字符串自证）', async () => {
  const sizes = [35, 36, 37, 38, 39, 40, 41];
  const metaOf = async (count) => sharp(await renderPurchaseRequestPng({
    supplierName: '金猴',
    items: sizes.slice(0, count).map((size) => ({ item_no: '6C98012-15L', color: '黑色', size, quantity: 1 })),
  })).metadata();

  const six = await metaOf(6);
  const seven = await metaOf(7);
  assert.equal(six.width, 900);
  assert.equal(seven.width, 900, '换行只在纵向长高，宽度不变');
  assert.equal(seven.height - six.height, LINE_HEIGHT, '7 个尺码换到第 2 行 → 图高多一行');
  // 再多尺码只是把第 2 行填满，不会继续长高（9 个尺码仍然 2 行）
  assert.equal((await metaOf(9)).height, seven.height);
});

test('合并版表高：列头 + Σ（分组行 + **折行后的**明细段高），没有隐形空行', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  const height = Number(/height="(\d+)"/.exec(svg)[1]);
  // ITEMS：2 个货号各 1 个颜色行（都是单行）→ 2 条分组行 + 2 行正文
  const tableHeight = HEADER_ROW_HEIGHT + GROUP_ROW_HEIGHT * 2 + ROW_HEIGHT * 2;
  // 表格外框那条 rect 的高度必须正好等于上面算出来的表高
  const frame = parseSvg(svg).find((element) => element.kind === 'rect'
    && element.fill === 'none' && element.y === TABLE_TOP);
  assert.equal(frame.height, tableHeight);
  // 合计**开着**：表格下面留 FOOTER_GAP + FOOTER_HEIGHT，再是底部留白（这条跟着 SHOW_TOTAL 反过来）
  assert.equal(LAYOUT.SHOW_TOTAL, true);
  assert.equal(height, TABLE_TOP + tableHeight + LAYOUT.FOOTER_GAP + LAYOUT.FOOTER_HEIGHT + LAYOUT.BOTTOM_PADDING);

  // ⚠️ 换行的那一行要**真的**占两行高：表高按折行后的行高累加，不是一律 ROW_HEIGHT
  const wrapItems = [35, 36, 37, 38, 39, 40, 41].map((size) => ({
    item_no: '6C98012-15L', color: '黑色', size, quantity: 1,
  }));
  const wrapSvg = buildPurchaseRequestSvg({ supplierName: '金猴', items: wrapItems });
  const wrapHeight = Number(/height="(\d+)"/.exec(wrapSvg)[1]);
  const wrapTableHeight = HEADER_ROW_HEIGHT + GROUP_ROW_HEIGHT + (ROW_HEIGHT + LINE_HEIGHT);
  const wrapFrame = parseSvg(wrapSvg).find((element) => element.kind === 'rect'
    && element.fill === 'none' && element.y === TABLE_TOP);
  assert.equal(wrapFrame.height, wrapTableHeight, '折行的那一行必须按两行高占位');
  assert.equal(wrapHeight, TABLE_TOP + wrapTableHeight + LAYOUT.FOOTER_GAP + LAYOUT.FOOTER_HEIGHT + LAYOUT.BOTTOM_PADDING);
});
