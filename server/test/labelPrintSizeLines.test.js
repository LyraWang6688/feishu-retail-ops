'use strict';

/**
 * V5 定稿（2026-11-15）：
 * 第一行货号+颜色、第二行单价；二维码左；品牌在二维码下；尺码 3.6mm/横向2mm/行距4.8mm。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { LABEL_PRINT_V5 } = require('../src/config/labelPrint');
const artifact = require('../src/services/labelPrintArtifactService');

const label = (specs = [[38, ''], [39, ''], [40, 1], [41, 1], [42, ''], [43, 1], [44, '']]) => {
  const items = specs.map(([size, qty]) => ({ size, qty }));
  return {
    key: '3877|白蓝|男', number: '3877|白蓝|男', item_no: '3877', color: '白蓝',
    category: '男', category_code: '男',
    sizes: items, size_lines: [items], size_overflow: false, total_qty: 3,
    price: 189, price_text: '¥189', brand_text: '邯美皮鞋',
    qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
    footer_text: '',
  };
};
const cfg = { dpi: 203, cutLineMm: 0 };
const yOfText = (svg, text) => {
  const match = new RegExp(`<text x="[-\\d.]+" y="([-\\d.]+)"[^>]*>${text}<\\/text>`).exec(svg);
  return match ? Number(match[1]) : NaN;
};

test('V5-1 3877 普通码：3 个一行、3 行（3+3+1），44 完整', () => {
  const m = artifact.measureVerticalLayout(label(), LABEL_PRINT_V5, cfg);
  assert.deepEqual(m.sizes_line_items, [['38', '39', '40'], ['41', '42', '43'], ['44']]);
  assert.equal(m.sizes_lines, 3);
  assert.equal(m.sizes_shown, 7);
  assert.equal(m.sizes_hidden, 0);
  assert.equal(m.sizes_size_mm, 3.6);
});

test('V5-2 第一行到第二行的纵向行距 = 4.8mm（3.6 + 1.2 空白）', () => {
  const svg = artifact.labelSvg(label(), LABEL_PRINT_V5, cfg);
  const y38 = yOfText(svg, '38');
  const y41 = yOfText(svg, '41');
  assert.equal(Number((y41 - y38).toFixed(2)), 4.8, '38 到 41 的基线差应为 4.8mm');
});

test('V5-5 长货号可以使用整张纸安全宽度，不提前截断', () => {
  const lab = label();
  lab.item_no = '1234567890';
  lab.color = '白蓝';
  const svg = artifact.labelSvg(lab, LABEL_PRINT_V5, cfg);
  assert.ok(svg.includes('1234567890'), '10 位货号应完整显示');
  assert.ok(!svg.includes('…'), '不应提前用省略号截断');
});

test('V5-4 旧 LABEL_PRINT_ROWS 覆盖不影响 V5 行序（货号+颜色同行、单价下一行）', () => {
  const svg = artifact.labelSvg(label(), LABEL_PRINT_V5, {
    ...cfg,
    rows: ['brand', 'itemNo', 'colorPrice', 'sizes'],
  });
  assert.equal(yOfText(svg, '3877'), yOfText(svg, '白蓝'), '货号与颜色必须同一行');
  assert.ok(yOfText(svg, '¥189') > yOfText(svg, '3877'), '单价必须在下一行');
});

test('V5-3 品牌在二维码下方居中', () => {
  const svg = artifact.labelSvg(label(), LABEL_PRINT_V5, cfg);
  const brandY = yOfText(svg, '邯美皮鞋');
  assert.ok(brandY > 25, `品牌应在二维码下方，实际 y=${brandY}`);
  const brand = /<text x="([-\d.]+)" y="[-\d.]+"[^>]*text-anchor="middle">邯美皮鞋<\/text>/.exec(svg);
  assert.equal(Number(brand[1]), 11.5, '品牌中心 = 二维码中心（4 + 15/2）');
});
