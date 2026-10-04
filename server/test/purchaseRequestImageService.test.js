const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const {
  TITLE,
  FONT_FAMILY,
  buildPurchaseRequestSvg,
  renderPurchaseRequestPng,
  formatSize,
  summarize,
  normalizeItems,
  truncateToWidth,
  charWidth,
} = require('../src/services/purchaseRequestImageService');

const ITEMS = [
  { item_no: '8088', color: '黑色', size: 36, quantity: 2 },
  { item_no: '8088', color: '黑色', size: 37, quantity: 1 },
  { item_no: 'A-1366-31', color: '棕色', size: 38, quantity: 3 },
];

test('采购申请 SVG：有标题、四列、欧码尺码和合计', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', batchNo: 'BH-20261005-0001', items: ITEMS });
  assert.ok(svg.includes(`>${TITLE}</text>`), '必须有「邯美皮鞋采购申请单」标题');
  assert.ok(svg.includes('供应商：金猴'));
  assert.ok(svg.includes('报货批次：BH-20261005-0001'));
  for (const label of ['货号', '颜色', '尺码', '数量']) {
    assert.ok(svg.includes(`>${label}</text>`), `缺列：${label}`);
  }
  // 尺码只写欧码：37 码就是「37码」，不能出现毫米数或「37/235」这种双写
  assert.ok(svg.includes('>37码</text>'));
  assert.ok(!/\d{3}\s*\/\s*37/.test(svg), '不能出现毫米/欧码双写');
  assert.ok(svg.includes('合计：3 条 / 6 双'), '合计要同时给条数和总双数');
});

test('采购申请 SVG：字体显式指定 CJK 字体，中文不会渲染成方框', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: ITEMS });
  // 服务器上没有 fontconfig 显式配置，只能靠 SVG 里写死字体名。
  // 一旦有人把 font-family 去掉或改成通用族，中文会静默变成方框。
  assert.equal(FONT_FAMILY, 'Noto Sans CJK SC, Noto Serif CJK SC, Noto Sans SC, WenQuanYi Zen Hei, sans-serif');
  const fontAttributes = svg.match(/font-family="[^"]*"/g) || [];
  assert.ok(fontAttributes.length >= 6, '每个文本节点都要带 font-family');
  assert.ok(fontAttributes.every((attribute) => attribute.includes('Noto Sans CJK SC')));
});

test('采购申请 SVG：空明细不崩，也给出 0 条 / 0 双', () => {
  for (const items of [[], undefined, null]) {
    const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items });
    assert.ok(svg.startsWith('<svg '));
    assert.ok(svg.includes('本批次没有明细'));
    assert.ok(svg.includes('合计：0 条 / 0 双'));
  }
});

test('采购申请 SVG：超长货号与颜色按列宽截断，不溢出到别的列', () => {
  const longItemNo = 'A'.repeat(80);
  const longColor = '深'.repeat(60);
  const svg = buildPurchaseRequestSvg({ supplierName: '金猴', items: [{ item_no: longItemNo, color: longColor, size: 36, quantity: 1 }] });
  assert.ok(!svg.includes(longItemNo), '超长货号必须被截断');
  assert.ok(svg.includes('…'), '截断要有省略号，让人看得出被截了');
  // 逐个单元格检查绘制宽度：汉字按字号 1:1、其余按 0.56 倍估算，
  // 任何一个单元格的估算宽度都不能超过它的列宽（真机上挤进隔壁列就是这么发生的）。
  const cells = [...svg.matchAll(/<text x="(\d+(?:\.\d+)?)"[^>]*font-size="(\d+)"[^>]*text-anchor="(\w+)">([^<]*)<\/text>/g)];
  const drawn = cells.filter(([, , , , content]) => content.includes('A') || content.includes('深'));
  assert.equal(drawn.length, 2);
  const widthOf = (text, fontSize) => [...text].reduce((sum, char) => sum + charWidth(char, fontSize), 0);
  const colorCell = drawn.find(([, , , , content]) => content.includes('深'));
  assert.ok(widthOf(colorCell[4], 22) <= 220 - 32, `颜色单元格宽度超出列宽：${colorCell[4]}`);
  assert.ok(colorCell[4].endsWith('…') && [...colorCell[4]].length <= 8, `颜色截断过长：${colorCell[4]}`);
  const itemNoCell = drawn.find(([, , , , content]) => content.includes('A'));
  assert.ok(widthOf(itemNoCell[4], 22) <= 320 - 32, `货号单元格宽度超出列宽：${itemNoCell[4]}`);
});

test('采购申请 SVG：XML 特殊字符被转义，不会被当成标签', () => {
  const svg = buildPurchaseRequestSvg({ supplierName: '<金猴&co>', items: [{ item_no: 'A"1\'', color: '<黑>', size: 36, quantity: 1 }] });
  assert.ok(svg.includes('&lt;金猴&amp;co&gt;'));
  assert.ok(!svg.includes('<金猴'));
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

test('采购申请 PNG：sharp 真的渲染出 900px 宽的 PNG', async () => {
  const png = await renderPurchaseRequestPng({ supplierName: '金猴', batchNo: 'BH-20261005-0001', items: ITEMS });
  assert.ok(Buffer.isBuffer(png));
  // PNG 魔数：确认拿到的是图片而不是 SVG 字符串
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 900);
  assert.ok(metadata.height > 100 && metadata.height < 2000);
});
