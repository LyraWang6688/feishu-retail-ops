'use strict';

const { GROUP_SCAN_PAGE } = require('../config/groupScanPage');
const { SCAN_PAGE } = require('../config/scanPage');
const { STYLE } = require('./scanPage/styles');
const { identityHtml } = require('./scanPage/layout');
const { stockTableHtml } = require('./scanPage/stockBlock');
const { specialFactsHtml } = require('./scanPage/paymentBlock');
const { foldedSpecialRowsOf, sellableCountOf, REALM_TEXTS } = require('./scanPageRealm');
const { formatPrice } = require('../services/scanPagePrice');

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fill = (template, values = {}) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const adjustmentUrl = (groupId, memberId, currentUrl) => {
  const params = new URLSearchParams({ module: 'inventory', page: 'inventory-adjust', product: memberId, return_to: currentUrl });
  return GROUP_SCAN_PAGE.adjustmentUrl + '&' + params.toString();
};

const groupStyle = [
  '.group-head { margin-bottom: 10px; }',
  '.group-head .identity__meta { margin: 4px 0 0; }',
  '.group-member { margin-top: 12px; }',
  '.group-member .identity { margin-bottom: 0; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }',
  '.group-member .stock-card { border-radius: 0 0 var(--radius-lg) var(--radius-lg); margin-top: 0; }',
  '.group-member .card { box-shadow: none; border: 1px solid var(--border); }',
  '.group-empty { color: var(--text-secondary); padding: 12px 0; }',
  '.muted { color: var(--text-secondary); font-size: var(--font-size-sm); }',
  '.tag { display: inline-block; border-radius: 99px; padding: 2px 8px; font-size: var(--font-size-xs); background: var(--background-secondary); color: var(--text-secondary); }',
  '.member-link { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-decoration: none; color: var(--text); padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); margin: 8px 0; }',
].join('');

const page = (title, body) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>' + esc(title) + '</title><style>' + STYLE + groupStyle + '</style></head><body><main class="page">' + body + '</main></body></html>';

const groupHeader = (group) => {
  const meta = [group.color, fill(GROUP_SCAN_PAGE.texts.total, { count: group.total })].filter(Boolean).join(' · ');
  const price = group.price === null || group.price === undefined ? '' : formatPrice(group.price, SCAN_PAGE);
  return '<header class="card identity group-head"><div class="identity__main"><h1 class="identity__item">' + esc(group.name || group.recordId) + '</h1><p class="identity__meta">' + esc(meta) + '</p></div>' + (price ? '<div class="price"><span class="price__label">' + esc(SCAN_PAGE.texts.priceLabel) + '</span><span class="price__value">' + esc(price) + '</span></div>' : '') + '</header>';
};

const memberStockHtml = (member, group, currentUrl) => {
  const view = member.view;
  if (!view || view.found !== true) {
    const adjust = adjustmentUrl(group.recordId, member.recordId, currentUrl);
    return '<section class="card stock-card">'
      + '<div class="identity__main"><h1 class="identity__item">' + esc(member.number || member.itemNo || member.recordId) + '</h1>'
      + (member.color ? '<p class="identity__meta">' + esc(member.color) + '</p>' : '') + '</div>'
      + '<div class="group-empty">' + esc(GROUP_SCAN_PAGE.texts.noStock) + '</div>'
      + '<div class="identity__actions"><a class="btn" href="' + esc(adjust) + '">' + esc(GROUP_SCAN_PAGE.texts.adjust) + '</a></div>'
      + '</section>';
  }
  const foldedRows = foldedSpecialRowsOf(view);
  const foldedSizes = new Set(foldedRows.map((row) => String(row.size_text)));
  const foldedInventory = foldedRows.map((row) => ({ size_text: String(row.size_text), sellable: sellableCountOf(row, view.columns) }));
  const tableRows = (view.rows || []).filter((row) => !foldedSizes.has(String(row.size_text)));
  const foot = '<p class="foot">' + esc(SCAN_PAGE.texts.footerNumberLabel) + ' <span class="mono">' + esc(view.number) + '</span>'
    + (view.updated_at_text ? ' · ' + esc(SCAN_PAGE.texts.updatedAtLabel) + ' ' + esc(view.updated_at_text) : '') + '</p>';
  return identityHtml(view, SCAN_PAGE, { realm: 'inventory' })
    + stockTableHtml({ ...view, rows: tableRows }, SCAN_PAGE)
    + specialFactsHtml(foldedInventory, REALM_TEXTS)
    + foot;
};

const memberCard = (group, member, currentUrl) => {
  const adjust = adjustmentUrl(group.recordId, member.recordId, currentUrl);
  const view = member.view ? { ...member.view, product_adjust_url: adjust } : null;
  const body = memberStockHtml({ ...member, view }, group, currentUrl);
  return '<section class="group-member">' + body + '</section>';
};

const renderGroupStockPage = (group, options = {}) => page(
  group?.name || GROUP_SCAN_PAGE.title,
  groupHeader(group) + (group.members?.length
    ? group.members.map((member) => memberCard(group, member, options.currentUrl)).join('')
    : '<div class="card"><div class="group-empty">' + esc(GROUP_SCAN_PAGE.texts.noMembers) + '</div></div>'),
);

const renderGroupPickerPage = (group, options = {}) => {
  const t = GROUP_SCAN_PAGE.texts;
  const from = options.from || '';
  const items = (group.members || []).map((member) => {
    const noStock = Number(member.total) <= 0;
    const href = from === 'after_sales'
      ? GROUP_SCAN_PAGE.afterSalesPage + '?productRecordId=' + encodeURIComponent(member.recordId)
      : '/r/' + encodeURIComponent(member.recordId) + '?from=' + encodeURIComponent(from);
    const note = noStock ? '<span class="tag">' + esc(t.memberNoStock) + '</span>' : '';
    return '<a class="member-link" href="' + esc(href) + '"><span><strong>' + esc(member.number || member.itemNo || member.recordId) + '</strong>' + (member.color ? '<span class="muted"> · ' + esc(member.color) + '</span>' : '') + '</span><span>' + note + '<span class="muted">' + esc(member.total) + ' ' + esc(t.unit) + '</span></span></a>';
  }).join('');
  return page(group?.name || GROUP_SCAN_PAGE.title, '<div class="card"><h1>' + esc(group.name || group.recordId) + '</h1><h2>' + esc(t.pickMember) + '</h2><div class="muted">' + esc(t.pickHint) + '</div><div class="picker">' + (items || '<div class="muted">' + esc(t.noMembers) + '</div>') + '</div></div>');
};

module.exports = { renderGroupStockPage, renderGroupPickerPage };
