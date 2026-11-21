/**
 * 采购页供应商筛选：纯视图层，只影响「显示哪些货品卡」和「顶部统计怎么算」。
 * 草稿 / 数量 / 提交 payload 一律不经过这里。
 */
import { escapeHtml } from '../../core/formatters.js';

const UNASSIGNED = '__unassigned__';

const keyOf = (group) => String(group?.supplierRecordId || '').trim() || UNASSIGNED;

export const supplierOptions = (groups = [], config = {}) => {
  const seen = new Map();
  for (const group of groups || []) {
    const key = keyOf(group);
    if (seen.has(key)) continue;
    seen.set(key, {
      key,
      label: key === UNASSIGNED
        ? String(config.texts?.supplierUnassigned || '')
        : String(group?.supplierName || config.texts?.supplierUnassigned || ''),
    });
  }
  return [{ key: 'all', label: String(config.texts?.supplierAll || '') }, ...seen.values()];
};

export const supplierTabsHtml = (groups, active, config) => {
  const tabs = supplierOptions(groups, config).map((item) => {
    const selected = item.key === active;
    return '<button type="button" class="pr-supplier-tab' + (selected ? ' active' : '')
      + '" data-pr-supplier="' + escapeHtml(item.key) + '" aria-selected="' + selected + '">'
      + escapeHtml(item.label) + '</button>';
  }).join('');
  return '<div class="pr-supplier-filter" role="tablist" aria-label="'
    + escapeHtml(String(config.texts?.supplierLabel || '')) + '">'
    + '<span class="pr-supplier-label">' + escapeHtml(String(config.texts?.supplierLabel || '')) + '</span>'
    + '<div class="pr-supplier-tabs">' + tabs + '</div></div>';
};

export const filterGroups = (groups = [], active = 'all') => (
  active === 'all' ? groups : groups.filter((group) => keyOf(group) === active)
);

export const filteredStats = (tab, groups = [], config = {}) => {
  if (tab === 'new') return { productCount: groups.length };
  const defs = config.stats?.replenish || [];
  const stats = {};
  for (const def of defs) {
    if (def.key === 'productCount') stats[def.key] = groups.length;
    else if (def.key === 'notArrived') stats[def.key] = groups.reduce((sum, group) => sum + (Number(group.notArrivedTotal) || 0), 0);
    else if (def.key === 'prepaidPending') stats[def.key] = groups.reduce((sum, group) => sum + (Number(group.prepaidTotal) || 0), 0);
    else stats[def.key] = groups.reduce((sum, group) => sum + (Number(group.spotTotal) || 0), 0);
  }
  return stats;
};

export const supplierFilteredBody = (tab, body, active, config) => {
  const groups = body?.groups || [];
  const visible = filterGroups(groups, active);
  return {
    body: { ...body, groups: visible, stats: filteredStats(tab, visible, config) },
    groups,
    visible,
  };
};
