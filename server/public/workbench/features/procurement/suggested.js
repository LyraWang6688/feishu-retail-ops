/** 采购页「建议报货清单」：合并补货 / 上新，统一按货号自然升序；上新同款优先。 */
import { escapeHtml } from '../../core/formatters.js';
import { newGroupHtml, replenishGroupHtml } from './render.js';
import { supplierFilteredBody, supplierTabsHtml } from './supplierFilter.js';
import { compareProductOrder } from '../shared/productOrder.js';

export const buildSuggestedBody = ({ replenishBody, newBody, config }) => {
  const newGroups = Array.isArray(newBody?.groups) ? newBody.groups : [];
  const newIds = new Set(newGroups.map((group) => group.productRecordId));
  const groups = [
    ...newGroups.map((group) => ({ ...group, source: 'new' })),
    ...((replenishBody?.groups || [])
      .filter((group) => !newIds.has(group.productRecordId))
      .map((group) => ({ ...group, source: 'replenish' }))),
  ];
  groups.sort(compareProductOrder);
  const days = Number(config.range?.days || newBody?.range?.days || replenishBody?.range?.days) || 7;
  return { groups, range: { days } };
};

export const rangeBarHtml = (days, config) => {
  const range = String(config.range.suggested || '近 {days} 天（含今天）').replace('{days}', String(days || config.range?.days || 7));
  return `<div class="pr-range-inline"><span>${escapeHtml(config.texts.rangeLabel)}</span><strong>${escapeHtml(range)}</strong></div>`
    + `<button type="button" class="pr-refresh" data-pr-refresh>${escapeHtml(config.texts.refresh)}</button>`;
};

export const suggestedHtml = ({ body, draft, store, supplierId = '', config, modify = false }) => {
  if (!body) return '';
  const filtered = supplierFilteredBody('suggested', body, supplierId, config);
  const cards = filtered.visible.length
    ? filtered.visible.map((group) => {
      return group.source === 'new'
        ? newGroupHtml(group, draft, store, config)
        : replenishGroupHtml(group, draft, store, config, { modify });
    }).join('')
    : `<div class="pr-empty">${escapeHtml(config.texts.suggestedEmpty)}</div>`;
  return `${supplierTabsHtml(filtered.groups, filtered.supplierKey, config)}${cards}`;
};
