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
  sizeSortValue,
  compareSize,
  COLORS,
  MARGIN,
  CELL_PADDING,
  TABLE_TOP,
  ROW_HEIGHT,
  HEADER_ROW_HEIGHT,
} = require('../src/services/purchaseRequestImageService');

// ─────────────────────────────────────────────────────────────────────────────
// 验收标准（业务负责人 2026-10-06 拍板的「🅱️ 分组版」）——本文件逐条钉住：
//   ① 同一货号的明细聚在一个分组行下
//   ② 货号分组行跨 3 列、有底色、字比正文重
//   ③ 组内按颜色分组排序、颜色内按尺码数字升序
//   ④ 合计行：条数 = 明细行数、双数 = 数量之和（与改前一致）
//   ⑤ 两个标题、供应商段（有/无）、多供应商多图 行为不变
//   ⑥ 空明细不崩
// ─────────────────────────────────────────────────────────────────────────────

const ITEMS = [
  { item_no: '8088', color: '黑色', size: 36, quantity: 2 },
  { item_no: '8088', color: '黑色', size: 37, quantity: 1 },
  { item_no: 'A-1366-31', color: '棕色', size: 38, quantity: 3 },
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
  // 免得把表下面的「合计：…」也当成最后一条分组的明细单元格。
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

/** 一组里的明细单元格 → [[颜色, 尺码, 数量], ...]（按绘制顺序）。 */
const rowsOf = (group) => {
  const rows = [];
  for (let index = 0; index < group.cells.length; index += COLUMNS.length) {
    rows.push(group.cells.slice(index, index + COLUMNS.length).map((cell) => cell.content));
  }
  return rows;
};

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
// ② 分组行：跨 3 列、有底色、字比正文重
// ─────────────────────────────────────────────────────────────────────────────

test('② 分组行：每个货号一条，跨满 3 列（整张表宽）、有底色、字比正文重', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'BH-1', items: ITEMS });
  const groups = readGroups(svg);
  assert.equal(groups.length, 2, '两个货号 → 两条分组行');
  assert.equal((svg.match(/<svg /g) || []).length, 1, '同一张图里分组，不是每个货号一张图');

  for (const group of groups) {
    assert.equal(group.band.x, MARGIN, '分组行底色从头开始');
    assert.equal(group.band.width, TABLE_WIDTH, '分组行必须跨满 3 列（= 整张表宽）');
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
// ① 同一货号的明细聚在一个分组行下 + ③ 组内顺序
// ─────────────────────────────────────────────────────────────────────────────

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
  assert.deepEqual(groups.map((group) => rowsOf(group).length), [3, 1], '8088 的三条必须聚在同一分组行下');
  assert.deepEqual(rowsOf(groups[0]), [
    ['黑色', '36码', '2'],
    ['黑色', '37码', '1'],
    ['棕色', '37码', '1'],
  ]);
  assert.deepEqual(rowsOf(groups[1]), [['棕色', '38码', '3']]);

  // 分组行的 y 必须严格递增，且组内明细行的 y 也严格递增（顺序 = 视觉上的从上到下）
  for (let index = 1; index < groups.length; index += 1) {
    assert.ok(groups[index].band.y > groups[index - 1].band.y, '分组行的先后顺序必须与绘制顺序一致');
  }
  for (const group of groups) {
    const tops = group.cells.filter((_, cellIndex) => cellIndex % COLUMNS.length === 0).map((cell) => cell.y);
    assert.deepEqual(tops, [...tops].sort((a, b) => a - b), '组内明细行必须自上而下');
  }
});

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
    ['黑', '9码', '1'],
    ['黑', '40码', '1'],
    ['黑', '41码', '1'],
    ['黑', '均码', '1'],
    ['棕', '9码', '1'],
    ['棕', '40码', '1'],
  ]);
  // ⚠️ 字符串序恰好是反的（'40码' < '9码'），所以这条断言就是"按数字排"的钉子。
  assert.ok('40码' < '9码', '对照：字符串序下 40 排在 9 前面');
  assert.ok(svg.indexOf('>9码</text>') < svg.indexOf('>40码</text>'), '图上 9 码必须排在 40 码前面');
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

test('① 组内明细行不再重复写货号：每行只有 颜色 | 尺码 | 数量 三格，货号只在分组行出现一次', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  const groups = readGroups(svg);
  for (const group of groups) {
    assert.equal(group.cells.length % COLUMNS.length, 0, '每行必须正好 3 格');
    for (const row of rowsOf(group)) assert.equal(row.length, 3);
  }
  assert.equal((svg.match(/>8088</g) || []).length, 1, '货号只在分组行写一次');
  assert.equal((svg.match(/>A-1366-31</g) || []).length, 1, '货号只在分组行写一次');
  assert.ok(!svg.includes('>货号</text>'), '货号已经变成分组行，表头里不该再有「货号」这一列');
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
  assert.deepEqual(rowsOf(groups[1]), [['棕色', '37码', '1']]);
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 合计口径不变
// ─────────────────────────────────────────────────────────────────────────────

test('④ 合计口径与改前一致：条数 = 明细行数（一尺码一行），双数 = 数量之和', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  assert.ok(svg.includes('合计：3 条 / 6 双'), '合计要同时给条数和总双数');
  // 「只改怎么画」：summarize / normalizeItems 的口径一个数都不动
  assert.deepEqual(summarize(normalizeItems(ITEMS)), { rowCount: 3, totalPairs: 6 });
  // 分组不复制、不丢行：各组明细行加起来 == 原始行数，数量之和 == 原始双数
  const groups = readGroups(svg);
  const grouped = groups.flatMap((group) => rowsOf(group));
  assert.equal(grouped.length, 3);
  assert.equal(grouped.reduce((sum, row) => sum + Number(row[2]), 0), 6);
});

// ─────────────────────────────────────────────────────────────────────────────
// 布局：列宽、竖线、斑马纹
// ─────────────────────────────────────────────────────────────────────────────

test('列宽之和必须等于 TABLE_WIDTH（820），且「颜色最长、给最多空间」的思路保留', () => {
  assert.equal(TABLE_WIDTH, 820);
  assert.equal(COLUMNS.reduce((sum, column) => sum + column.width, 0), TABLE_WIDTH, '列宽之和必须 === 820');
  assert.equal(COLUMNS.length, 3, '分组版是 3 列：颜色 | 尺码 | 数量');
  assert.deepEqual(COLUMNS.map((column) => column.key), ['color', 'size', 'quantity']);
  const widest = COLUMNS.reduce((best, column) => (column.width > best.width ? column : best));
  assert.equal(widest.key, 'color', '颜色是唯一的自由文本，必须拿到最多的宽度');
  for (const column of COLUMNS) {
    assert.equal(column.maxWidth, column.width - CELL_PADDING * 2);
  }
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
  // 每组明细那一段确实有竖线兜住
  for (const group of groups) {
    const detailTop = group.band.y + GROUP_ROW_HEIGHT;
    const detailBottom = detailTop + rowsOf(group).length * ROW_HEIGHT;
    const covering = verticals.filter((line) => line.y1 === detailTop && line.y2 === detailBottom);
    assert.equal(covering.length, COLUMNS.length - 1, '每组明细都要有自己的列间竖线');
  }
});

test('斑马纹保留，改成「分组内」重新起算（每组第 1 行永远是白底）', () => {
  const svg = buildPurchaseRequestSvg({
    supplierName: '金猴',
    items: [
      { item_no: '8088', color: '黑', size: 36, quantity: 1 },
      { item_no: '8088', color: '黑', size: 37, quantity: 1 },
      { item_no: '8088', color: '黑', size: 38, quantity: 1 },
      { item_no: 'A-1', color: '棕', size: 39, quantity: 1 },
      { item_no: 'A-1', color: '棕', size: 40, quantity: 1 },
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

  const requestSvg = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'B-1', items: ITEMS });
  assert.ok(requestSvg.includes('>邯美皮鞋采购单</text>'), '默认标题必须是「邯美皮鞋采购单」');
  assert.ok(!requestSvg.includes('邯美皮鞋采购申请单'), '旧标题「邯美皮鞋采购申请单」不能再出现');

  const returnSvg = buildPurchaseRequestSvg({
    supplierName: '金猴', batchNo: 'B-1', items: ITEMS, title: RETURN_TITLE,
  });
  assert.ok(returnSvg.includes('>邯美皮鞋退货单</text>'), '退货标题必须是「邯美皮鞋退货单」');
  assert.ok(!returnSvg.includes('邯美皮鞋采购退货单'), '旧标题「邯美皮鞋采购退货单」不能再出现');
  // 只换标题：两种单据的分组排版必须一模一样
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
  assert.ok(fontAttributes.length >= 6, '每个文本节点都要带 font-family');
  assert.ok(fontAttributes.every((attribute) => attribute.includes('Noto Sans CJK SC')));
  for (const group of readGroups(svg)) {
    assert.equal(group.label.fontFamily, FONT_FAMILY, '分组行也必须带 CJK 字体链');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 空明细 / 截断 / 转义 / PNG
// ─────────────────────────────────────────────────────────────────────────────

test('⑥ 空明细不崩：照旧给「本批次没有明细」和 0 条 / 0 双，且不画任何分组行', () => {
  for (const items of [[], undefined, null]) {
    const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items });
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('本批次没有明细'));
    assert.ok(svg.includes('合计：0 条 / 0 双'));
    assert.deepEqual(readGroups(svg), [], '空明细不该产出一条空的分组行');
    assert.deepEqual(stripesOf(svg), []);
  }
});

test('超长颜色按列宽截断、超长货号（分组行）也按跨列宽度截断，都不溢出', () => {
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

  const widthOf = (text, fontSize) => [...text].reduce((sum, char) => sum + charWidth(char, fontSize), 0);
  // 分组行：可画宽度 = TABLE_WIDTH 去掉左右内边距
  assert.ok(
    widthOf(groups[0].label.content, GROUP_FONT_SIZE) <= TABLE_WIDTH - CELL_PADDING * 2,
    `分组行文字宽度超出跨列区域：${groups[0].label.content}`,
  );
  // 正文颜色单元格：可画宽度 = 列宽 - 32
  const colorCell = rowsOf(groups[0])[0][0];
  assert.ok(widthOf(colorCell, BODY_FONT_SIZE) <= COLUMNS[0].width - CELL_PADDING * 2,
    `颜色单元格宽度超出列宽：${colorCell}`);
  assert.ok(colorCell.endsWith('…') && [...colorCell].length <= 17, `颜色截断过长：${colorCell}`);
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

test('尺码与合计的口径', () => {
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

test('分组纯函数：groupRowsByItemNo 只重排显示顺序，不增删行', () => {
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

test('采购申请 PNG：sharp 真的渲染出 900px 宽的 PNG（分组版高度按分组行数变）', async () => {
  const png = await renderPurchaseRequestPng({ supplierName: '金猴', batchNo: 'BH-20261005-0001', items: ITEMS });
  assert.ok(Buffer.isBuffer(png));
  // PNG 魔数：确认拿到的是图片而不是 SVG 字符串
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 900);
  assert.ok(metadata.height > 100 && metadata.height < 2000);

  // 加一个货号 = 多一条分组行 + 它的明细行 → 图必须变高（分组行真的占位了）
  const taller = await renderPurchaseRequestPng({
    supplierName: '金猴',
    items: [...ITEMS, { item_no: '9999', color: '米色', size: 39, quantity: 1 }],
  });
  const tallerMeta = await sharp(taller).metadata();
  assert.equal(tallerMeta.height - metadata.height, GROUP_ROW_HEIGHT + ROW_HEIGHT);
});

test('分组版表高：列头 + Σ（分组行 + 明细行），没有隐形空行', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  const height = Number(/height="(\d+)"/.exec(svg)[1]);
  const tableHeight = HEADER_ROW_HEIGHT + GROUP_ROW_HEIGHT * 2 + ROW_HEIGHT * 3;
  // 表格外框那条 rect 的高度必须正好等于上面算出来的表高
  const frame = parseSvg(svg).find((element) => element.kind === 'rect'
    && element.fill === 'none' && element.y === TABLE_TOP);
  assert.equal(frame.height, tableHeight);
  assert.ok(height > TABLE_TOP + tableHeight, '合计行在表格下面，整图必须比表格高');
});
