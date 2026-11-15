'use strict';

/**
 * 真机 bug（2026-11-15）：普通码全量后，3877 的 44 码在纸底被打印机裁掉。
 * 修法：每行 4 个，7 个普通码排成 2 行（4+3），44 不再贴纸底。
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
const layout = {
  ...LABEL_PRINT,
  sizes: { ...LABEL_PRINT.sizes, perLine: 4, itemGapMm: 0.6 },
};
const cfg = { dpi: 203, leftPaddingMm: 3.5, qrSizeMm: 13, cutLineMm: 0, rows: ['brand', 'itemNo', 'colorPrice', 'sizes'] };

test('AC-C19-3 7 个普通码 ⇒ 每行 4 个、排成 2 行，44 在第二行', () => {
  const m = artifact.measureVerticalLayout(label(), layout, cfg);
  assert.deepEqual(m.sizes_line_items, [['38', '39', '40', '41'], ['42', '43', '44']]);
  assert.equal(m.sizes_lines, 2);
  assert.equal(m.sizes_hidden, 0);
  assert.equal(m.sizes_per_line, 4);
});
