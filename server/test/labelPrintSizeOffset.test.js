'use strict';

/**
 * 真机 bug（2026-11-15）：普通码全量后，3877 的 44 码在纸底被打印机裁掉。
 * 修法：只把尺码区上移 `sizes.yOffsetMm`（默认 -1.5mm），不动行高/字号/每行个数。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { LABEL_PRINT } = require('../src/config/labelPrint');
const artifact = require('../src/services/labelPrintArtifactService');

const label = (count = 7) => ({
  key: 'XHB8095|棕色|男', number: 'XHB8095|棕色|男', item_no: 'XHB8095', color: '棕色',
  category: '休闲鞋', category_code: '男',
  sizes: Array.from({ length: count }, (_, i) => ({ size: 38 + i, qty: (i % 2) + 1 })),
  size_lines: [Array.from({ length: count }, (_, i) => ({ size: 38 + i, qty: (i % 2) + 1 }))],
  size_overflow: false, total_qty: count,
  price: 198, price_text: '¥198', brand_text: '邯美皮鞋',
  qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
  footer_text: 'XHB8095|棕色|男',
});
const layout = (yOffsetMm) => ({
  ...LABEL_PRINT,
  sizes: { ...LABEL_PRINT.sizes, yOffsetMm },
});
const cfg = { dpi: 203, leftPaddingMm: 3.5, qrSizeMm: 13, cutLineMm: 0, rows: ['brand', 'itemNo', 'colorPrice', 'sizes'] };
const yOfText = (svg, text) => {
  const match = new RegExp(`<text x="[-\\d.]+" y="([-\\d.]+)"[^>]*>${text}<\\/text>`).exec(svg);
  return match ? Number(match[1]) : NaN;
};

test('AC-C19-3 尺码区 yOffsetMm：只把尺码文字上移，不动行高/字号/其它行', () => {
  const yOf44 = (yOffsetMm) => yOfText(artifact.labelSvg(label(), layout(yOffsetMm), cfg), '44');
  assert.equal(Number((yOf44(0) - yOf44(-1.5)).toFixed(2)), 1.5,
    '44 码应比默认位置上移 1.5mm（避免贴纸底边被裁）');
  assert.equal(LABEL_PRINT.sizes.yOffsetMm, -1.5, '默认值就是这次真机修法的 1.5mm 上移');
});
