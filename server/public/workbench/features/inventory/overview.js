import { escapeHtml } from '../../core/formatters.js';
import { INVENTORY_LEDGER_PAGE as PAGE } from '../../config/inventoryLedger.js';

/**
 * 库存总览渲染（纯函数，不碰状态）：
 *   B 段「库存变动」在上（吃页面日期栏），A 段「库存现状」在下（实时快照）。
 *
 * 业务标签（入库/出库/状态调整、当季/非当季、门盒/样品）全部来自接口，
 * 前端只负责排版与单位，不在这里另写一份中文口径。
 */
const T = PAGE.texts;

const fill = (text, values = {}) => Object.keys(values)
  .reduce((out, key) => out.split('{' + key + '}').join(String(values[key])), String(text || ''));
const num = (value) => Number(value || 0).toLocaleString('zh-CN');
const pct = (share) => {
  const rounded = Math.round(Number(share || 0) * 1000) / 10;
  return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
};
const pairsText = (value) => fill(T.pairsUnit, { n: num(value) });
const recordsText = (value) => fill(T.recordsUnit, { n: num(value) });
const stylesText = (value) => fill(T.stylesUnit, { n: num(value) });

const metricHtml = (label, value, sub, modifier) => '<div class="ledger-metric' + (modifier ? ' ledger-metric--' + modifier : '') + '">'
  + '<span>' + escapeHtml(label) + '</span>'
  + '<b>' + escapeHtml(value) + '</b>'
  + '<small>' + escapeHtml(sub || '') + '</small>'
  + '</div>';

const changeGroupHtml = (group) => {
  const isState = group.key === 'state';
  const behaviors = Array.isArray(group.behaviors) ? group.behaviors : [];
  const items = behaviors.map((item) => '<li>'
    + '<span class="ledger-behavior-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>'
    + '<b>' + (isState ? recordsText(item.records) : pairsText(item.pairs)) + '</b>'
    + (isState ? '' : '<small>' + recordsText(item.records) + '</small>')
    + '</li>').join('');
  return '<div class="ledger-change-group" data-change-group="' + escapeHtml(group.key) + '">'
    + '<h3><span>' + escapeHtml(group.label) + '</span><small>' + recordsText(group.records) + '</small></h3>'
    + (items ? '<ul>' + items + '</ul>' : '<p class="ledger-empty-inline">—</p>')
    + (isState ? '<p class="ledger-group-note">' + escapeHtml(T.stateNoQuantity) + '</p>' : '')
    + '</div>';
};

const changeHtml = (change = {}) => {
  const groups = Array.isArray(change.groups) ? change.groups : [];
  const visible = groups.filter((group) => group.records > 0 || group.key !== 'unknown');
  const totalRecords = groups.reduce((sum, group) => sum + Number(group.records || 0), 0);
  const net = Number(change.net_pairs || 0);
  const netText = (net > 0 ? '+' : '') + num(net);
  const sameDay = change.from && change.from === change.to;
  const hint = sameDay
    ? fill(T.changeHintSingle, { from: change.from })
    : fill(T.changeHint, { from: change.from || '', to: change.to || '' });
  return '<section class="ledger-section" data-overview-change>'
    + '<div class="ledger-section-head"><h2>' + escapeHtml(T.changeTitle) + '</h2>'
    + '<span class="ledger-hint">' + escapeHtml(hint) + '</span></div>'
    + '<div class="ledger-metric-cards">'
    + metricHtml(T.inbound, num(change.inbound && change.inbound.pairs), recordsText(change.inbound && change.inbound.records))
    + metricHtml(T.outbound, num(change.outbound && change.outbound.pairs), recordsText(change.outbound && change.outbound.records))
    + metricHtml(T.net, netText, T.netHint, 'net')
    + '</div>'
    + (totalRecords === 0
      ? '<p class="ledger-empty">' + escapeHtml(T.changeEmpty) + '</p>'
      : '<div class="ledger-change-groups">' + visible.map(changeGroupHtml).join('') + '</div>')
    + (Number(change.state_anomalies) > 0
      ? '<p class="ledger-footnote">' + escapeHtml(fill(T.stateAnomaly, { n: num(change.state_anomalies) })) + '</p>'
      : '')
    + (change.truncated ? '<p class="ledger-footnote">' + escapeHtml(fill(T.truncated, { n: num(change.limit) })) + '</p>' : '')
    + '</section>';
};

const barRows = (rows) => {
  const list = Array.isArray(rows) ? rows : [];
  const max = list.reduce((value, row) => Math.max(value, Number(row.pairs || 0)), 1);
  return list.map((row) => {
    const width = Math.max(2, Math.round((Number(row.pairs || 0) / max) * 100));
    return '<div class="ledger-bar-row">'
      + '<span class="ledger-bar-name" title="' + escapeHtml(row.name) + '">' + escapeHtml(row.name) + '</span>'
      + '<div class="ledger-bar"><i style="width:' + width + '%"></i></div>'
      + '<b class="ledger-bar-value">' + num(row.pairs)
      + '<small>' + pct(row.share) + ' · ' + escapeHtml(stylesText(row.styles)) + '</small></b>'
      + '</div>';
  }).join('');
};

const structureBlock = (title, rows) => '<div class="ledger-structure-block">'
  + '<h3>' + escapeHtml(title) + '</h3>'
  + (Array.isArray(rows) && rows.length ? barRows(rows) : '<p class="ledger-empty-inline">—</p>')
  + '</div>';

const seasonCard = (season = {}) => '<div class="ledger-season-card" data-season="' + escapeHtml(season.key || '') + '">'
  + '<span>' + escapeHtml(season.label || '') + '</span>'
  + '<b>' + num(season.pairs) + '</b>'
  + '<small>' + escapeHtml(T.pairsWord + ' · ' + stylesText(season.styles)) + '</small>'
  + '</div>';

const stateCard = (state = {}, totalPairs = 0) => '<div class="ledger-state-card">'
  + '<span>' + escapeHtml(state.label || '') + '</span>'
  + '<b>' + num(state.pairs) + '</b>'
  + '<small>' + escapeHtml(T.pairsWord + ' · ' + pct(totalPairs ? Number(state.pairs || 0) / totalPairs : 0)) + '</small>'
  + '</div>';

const missingNote = (missing = {}) => {
  const parts = [];
  if (Number(missing.category_pairs) > 0) parts.push(fill(T.missingCategory, { n: num(missing.category_pairs) }));
  if (Number(missing.class_pairs) > 0) parts.push(fill(T.missingClass, { n: num(missing.class_pairs) }));
  if (Number(missing.supplier_pairs) > 0) parts.push(fill(T.missingSupplier, { n: num(missing.supplier_pairs) }));
  return parts.length ? '<p class="ledger-footnote">' + escapeHtml(fill(T.missingNote, { parts: parts.join(' · ') })) + '</p>' : '';
};

const snapshotHtml = (snapshot = {}) => {
  const seasons = snapshot.seasons || {};
  const current = snapshot.current || {};
  const currentLabel = seasons.current && seasons.current.label ? seasons.current.label : '';
  const states = Array.isArray(current.states) ? current.states : [];
  return '<section class="ledger-section" data-overview-snapshot>'
    + '<div class="ledger-section-head"><h2>' + escapeHtml(T.snapshotTitle) + '</h2>'
    + '<span class="ledger-hint">' + escapeHtml(T.snapshotHint) + '</span></div>'
    + '<div class="ledger-season-cards">' + seasonCard(seasons.current) + seasonCard(seasons.off) + '</div>'
    + '<div class="ledger-state-row">' + states.map((state) => stateCard(state, Number(current.pairs || 0))).join('') + '</div>'
    + '<div class="ledger-structure">'
    + structureBlock(currentLabel + T.categoryTitle, current.by_category)
    + structureBlock(currentLabel + T.classTitle, current.by_class)
    + structureBlock(currentLabel + T.supplierTitle, current.by_supplier)
    + '</div>'
    + missingNote(snapshot.missing)
    + '</section>';
};

export const overviewHtml = (data = {}) => '<div class="ledger-overview" data-overview>'
  + changeHtml(data.change)
  + snapshotHtml(data.snapshot)
  + '</div>';
