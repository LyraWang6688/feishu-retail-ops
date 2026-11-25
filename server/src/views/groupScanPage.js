'use strict';

const { GROUP_SCAN_PAGE } = require('../config/groupScanPage');

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const fill = (template, values = {}) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

const adjustmentUrl = (groupId, memberId, currentUrl) => {
  const params = new URLSearchParams({
    module: 'inventory',
    page: 'inventory-adjust',
    product: memberId,
    return_to: currentUrl,
  });
  return GROUP_SCAN_PAGE.adjustmentUrl + '&' + params.toString();
};

const style = [
  ':root{--bg:#f6f7f9;--surface:#fff;--text:#1f2329;--muted:#646a73;--line:#e5e6eb;--primary:#3370ff;--radius:12px}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}',
  '.page{max-width:720px;margin:0 auto;padding:16px 12px 40px}.card{background:var(--surface);border-radius:var(--radius);padding:16px;margin:0 0 12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}',
  'h1{font-size:22px;margin:0 0 6px}h2{font-size:17px;margin:0 0 10px}.muted{color:var(--muted);font-size:13px}',
  '.member-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.member-title{font-weight:700;font-size:16px}',
  '.tag{display:inline-block;border-radius:99px;padding:2px 8px;font-size:12px;background:#f0f2f5;color:var(--muted)}.tag.warn{background:#fff1e8;color:#b54800}',
  'table{width:100%;border-collapse:collapse;margin:4px 0 10px}th,td{padding:7px 6px;border-bottom:1px solid var(--line);text-align:center}th{color:var(--muted);font-weight:500;font-size:12px}td:first-child,th:first-child{text-align:left}',
  '.actions{display:flex;gap:10px;flex-wrap:wrap}.btn{display:inline-block;text-decoration:none;border-radius:8px;padding:9px 14px;background:var(--primary);color:#fff;font-weight:600}',
  '.picker{margin-top:8px}.member-link{display:flex;align-items:center;justify-content:space-between;gap:10px;text-decoration:none;color:var(--text);padding:12px;border:1px solid var(--line);border-radius:10px;margin:8px 0}',
].join('');

const page = (title, body) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>' + esc(title) + '</title><style>' + style + '</style></head><body><main class="page">' + body + '</main></body></html>';

const groupHeader = (group) => '<div class="card"><h1>' + esc(group.name || group.recordId) + '</h1><div class="muted">' + esc(fill(GROUP_SCAN_PAGE.texts.total, { count: group.total })) + '</div></div>';

const memberCard = (group, member, currentUrl) => {
  const t = GROUP_SCAN_PAGE.texts;
  const rows = (member.sizes || []).map((row) => '<tr><td>' + esc(row.size) + '</td><td>' + esc(row.states[t.doorboxKey] || 0) + '</td><td>' + esc(row.states[t.sampleKey] || 0) + '</td><td>' + esc(row.total) + '</td></tr>').join('');
  const table = rows
    ? '<table><thead><tr><th>' + esc(t.size) + '</th><th>' + esc(t.doorbox) + '</th><th>' + esc(t.sample) + '</th><th>' + esc(t.totalColumn) + '</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<div class="muted">' + esc(t.noStock) + '</div>';
  const link = adjustmentUrl(group.recordId, member.recordId, currentUrl);
  const delisted = member.delisted ? '<span class="tag warn">' + esc(t.delisted) + '</span>' : '';
  return '<section class="card"><div class="member-head"><div><div class="member-title">' + esc(member.number || member.itemNo || member.recordId) + '</div>' + (member.color ? '<div class="muted">' + esc(member.color) + '</div>' : '') + '</div><div>' + delisted + '<span class="tag">' + esc(member.total) + '</span></div></div>' + table + '<div class="actions"><a class="btn" href="' + esc(link) + '">' + esc(t.adjust) + '</a></div></section>';
};

const renderGroupStockPage = (group, options = {}) => page(
  group?.name || GROUP_SCAN_PAGE.title,
  groupHeader(group) + (group.members?.length
    ? group.members.map((member) => memberCard(group, member, options.currentUrl)).join('')
    : '<div class="card"><div class="muted">' + esc(GROUP_SCAN_PAGE.texts.noMembers) + '</div></div>'),
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
