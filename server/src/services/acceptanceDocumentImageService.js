'use strict';

/**
 * 验收单 PNG：把验收页「预览区」的最终明细画成一张单据。
 *
 * 口径与 purchaseArrival/differenceAnalysis.js 完全一致：
 *   · expected = 非自定义行采购数量；
 *   · actual   = 非自定义行 min(实到, 采购)；
 *   · extra    = 非自定义超出采购的部分 + 自定义尺码的全部实到。
 *
 * ⚠️ 只渲染，不写表、不发群；编排在 acceptanceDocumentService.js。
 */
const sharp = require('sharp');
const LAYOUT = require('../config/acceptanceDocumentImageLayout');

const escapeXml = (value) => String(value ?? '').replace(/[<>&'"]/g, (char) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
}[char]));

const fill = (template, values = {}) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const statusOf = (row) => {
  const declared = Math.max(0, Number(row?.quantity ?? row?.declared) || 0);
  const arrived = Math.max(0, Number(row?.actual) || 0);
  if (row?.custom) return { key: 'extra', expected: 0, actual: 0, extra: arrived };
  if (arrived > declared) return { key: 'extra', expected: declared, actual: declared, extra: arrived - declared };
  if (arrived < declared) return { key: 'short', expected: declared, actual: arrived, extra: 0 };
  return { key: 'match', expected: declared, actual: arrived, extra: 0 };
};

const groupRows = (rows = []) => {
  const groups = new Map();
  for (const row of rows) {
    const productKey = String(row?.product_record_id || row?.productRecordId || row?.item_no || '').trim() || 'unknown';
    if (!groups.has(productKey)) {
      groups.set(productKey, {
        key: productKey,
        itemNo: String(row?.item_no || row?.itemNo || row?.number || '').trim() || LAYOUT.labels.unknownItem,
        color: String(row?.color || '').trim(),
        rows: [],
      });
    }
    groups.get(productKey).rows.push(row);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    rows: group.rows.slice().sort((left, right) => Number(left.size) - Number(right.size)),
  }));
};

const summarize = (rows) => {
  let expected = 0;
  let actual = 0;
  let extra = 0;
  for (const row of rows) {
    const status = statusOf(row);
    expected += status.expected;
    actual += status.actual;
    extra += status.extra;
  }
  return { expected, actual, extra };
};

const rowText = (text, x, y, options = {}) => '<text x="' + x + '" y="' + y + '" fill="' + (options.fill || LAYOUT.colors.text)
  + '" font-size="' + (options.fontSize || LAYOUT.bodyFontSize)
  + '" font-weight="' + (options.weight || 'normal')
  + '" text-anchor="' + (options.anchor || 'start')
  + '">' + escapeXml(text) + '</text>';

const renderAcceptanceDocumentPng = async ({
  batchNo = '', supplierName = '', acceptedAt = '', rows = [],
} = {}) => {
  const groups = groupRows(rows);
  const totals = summarize(rows);
  const { width, margin, headerHeight, groupHeight, rowHeight, footerHeight } = LAYOUT;
  const tableWidth = width - margin * 2;
  const tableTop = headerHeight + 130;
  const headerRowHeight = 40;
  const height = tableTop + headerRowHeight
    + groups.reduce((sum, group) => sum + groupHeight + group.rows.length * rowHeight, 0)
    + footerHeight;
  const cols = [
    { key: 'size', x: margin + 14, label: LAYOUT.labels.size, anchor: 'start' },
    { key: 'expected', x: margin + 300, label: LAYOUT.labels.expected, anchor: 'end' },
    { key: 'actual', x: margin + 470, label: LAYOUT.labels.actual, anchor: 'end' },
    { key: 'extra', x: margin + 640, label: LAYOUT.labels.extra, anchor: 'end' },
    { key: 'status', x: margin + tableWidth - 14, label: LAYOUT.labels.status, anchor: 'end' },
  ];
  const pieces = [];
  pieces.push('<rect width="' + width + '" height="' + height + '" fill="' + LAYOUT.colors.background + '"/>');
  pieces.push(rowText(LAYOUT.title, margin, 62, { fontSize: LAYOUT.titleFontSize, weight: 'bold' }));
  pieces.push(rowText(fill(LAYOUT.labels.supplier, { value: supplierName || LAYOUT.labels.unknownSupplier }), margin, 102, {
    fontSize: LAYOUT.subtitleFontSize, fill: LAYOUT.colors.muted,
  }));
  pieces.push(rowText(fill(LAYOUT.labels.batchNo, { value: batchNo || LAYOUT.labels.unknownBatch }), margin + 300, 102, {
    fontSize: LAYOUT.subtitleFontSize, fill: LAYOUT.colors.muted,
  }));
  pieces.push(rowText(fill(LAYOUT.labels.acceptedAt, { value: acceptedAt || '' }), margin + 650, 102, {
    fontSize: LAYOUT.subtitleFontSize, fill: LAYOUT.colors.muted,
  }));
  pieces.push('<line x1="' + margin + '" y1="' + (tableTop - 14) + '" x2="' + (width - margin) + '" y2="' + (tableTop - 14)
    + '" stroke="' + LAYOUT.colors.line + '"/>');
  pieces.push('<rect x="' + margin + '" y="' + tableTop + '" width="' + tableWidth + '" height="' + headerRowHeight
    + '" fill="' + LAYOUT.colors.headerFill + '"/>');
  for (const col of cols) {
    pieces.push(rowText(col.label, col.x, tableTop + 26, {
      fontSize: LAYOUT.headerFontSize, weight: 'bold', fill: LAYOUT.colors.muted, anchor: col.anchor,
    }));
  }
  let y = tableTop + headerRowHeight;
  for (const group of groups) {
    pieces.push('<rect x="' + margin + '" y="' + y + '" width="' + tableWidth + '" height="' + groupHeight
      + '" fill="' + LAYOUT.colors.groupFill + '"/>');
    pieces.push(rowText([group.itemNo, group.color].filter(Boolean).join(' · '), margin + 14, y + 27, {
      fontSize: LAYOUT.headerFontSize, weight: 'bold', fill: LAYOUT.colors.text,
    }));
    y += groupHeight;
    for (const row of group.rows) {
      const status = statusOf(row);
      const fillColor = status.key === 'match' ? LAYOUT.colors.matchFill
        : (status.key === 'short' ? LAYOUT.colors.shortFill : LAYOUT.colors.extraFill);
      const textColor = status.key === 'match' ? LAYOUT.colors.match
        : (status.key === 'short' ? LAYOUT.colors.short : LAYOUT.colors.extra);
      const statusLabel = LAYOUT.labels[status.key === 'extra' ? 'extraStatus' : status.key];
      pieces.push('<rect x="' + margin + '" y="' + y + '" width="' + tableWidth + '" height="' + rowHeight
        + '" fill="' + fillColor + '"/>');
      pieces.push(rowText(row?.custom ? LAYOUT.labels.custom : String(row?.size ?? ''), cols[0].x, y + 27, {
        fontSize: LAYOUT.bodyFontSize,
      }));
      pieces.push(rowText(String(status.expected), cols[1].x, y + 27, { fontSize: LAYOUT.bodyFontSize, anchor: 'end' }));
      pieces.push(rowText(String(status.actual), cols[2].x, y + 27, { fontSize: LAYOUT.bodyFontSize, anchor: 'end' }));
      pieces.push(rowText(String(status.extra), cols[3].x, y + 27, { fontSize: LAYOUT.bodyFontSize, anchor: 'end' }));
      pieces.push(rowText(statusLabel, cols[4].x, y + 27, {
        fontSize: LAYOUT.bodyFontSize, anchor: 'end', fill: textColor, weight: 'bold',
      }));
      pieces.push('<line x1="' + margin + '" y1="' + (y + rowHeight) + '" x2="' + (width - margin) + '" y2="' + (y + rowHeight)
        + '" stroke="' + LAYOUT.colors.line + '"/>');
      y += rowHeight;
    }
  }
  pieces.push(rowText(fill(LAYOUT.labels.total, totals), margin, y + 42, {
    fontSize: LAYOUT.footerFontSize, weight: 'bold',
  }));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height
    + '" font-family="' + LAYOUT.fontFamily + '">' + pieces.join('') + '</svg>';
  return sharp(Buffer.from(svg)).png().toBuffer();
};

module.exports = { renderAcceptanceDocumentPng, statusOf, groupRows, summarize };
