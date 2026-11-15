'use strict';

/**
 * 真机 bug（2026-11-15）：普通码全量后，3877 的 44 码在纸底被打印机裁掉。
 * 修法：品牌与货号之间还有空白 ⇒ 右侧信息区整体上移 2.5mm（`body.infoOffsetYMm`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { LABEL_PRINT } = require('../src/config/labelPrint');
const artifact = require('../src/services/labelPrintArtifactService');

const label = (count = 7) => {
  const items = Array.from({ length: count }, (_, i) => ({ size: 38 + i, qty: (i % 2) + 1 }));
  return {
    key: 'XHB8095|棕色|男', number: 'XHB8095|棕色|男', item_no: 'XHB8095', color: '棕色',
    category: '休闲鞋', category_code: '男',
    sizes: items,
    // activeRows 以 size_lines 是否为空决定「有没有尺码行」；artifact 实际以 sizes 重排。
    size_lines: [items],
    size_overflow: false, total_qty: count,
    price: 198, price_text: '¥198', brand_text: '邯美皮鞋',
    qr_svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path d="M0 0h21v21H0z"/></svg>',
    footer_text: 'XHB8095|棕色|男',
  };
};
const layout = (infoOffsetYMm) => ({
  ...LABEL_PRINT,
  body: { ...LABEL_PRINT.body, infoOffsetYMm },
});
const cfg = { dpi: 203, leftPaddingMm: 3.5, qrSizeMm: 13, cutLineMm: 0, rows: ['brand', 'itemNo', 'colorPrice', 'sizes'] };
const yOfText = (svg, text) => {
  const match = new RegExp(`<text x="[-\\d.]+" y="([-\\d.]+)"[^>]*>${text}<\\/text>`).exec(svg);
  return match ? Number(match[1]) : NaN;
};

test('AC-C19-3 信息区上移 2.5mm：7 个普通码仍是 3 行，但 44 整体上移', () => {
  const plain = artifact.labelSvg(label(), layout(0), cfg);
  const shifted = artifact.labelSvg(label(), layout(-2.5), cfg);
  assert.equal(Number((yOfText(plain, '44') - yOfText(shifted, '44')).toFixed(2)), 2.5,
    '44 码应比默认位置上移 2.5mm（品牌与货号之间的空白）');
  assert.equal(LABEL_PRINT.body.infoOffsetYMm, -2.5, '默认值 = 这次真机修法的 2.5mm 上移');
  assert.ok(shifted.includes('>44<'), '44 码仍在图上');
});
