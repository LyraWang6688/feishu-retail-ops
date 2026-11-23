/**
 * 采购页渲染器（纯函数：配置 + 数据 + 草稿 → HTML 字符串）。
 *
 * 🔴 视觉目标 = `docs/prototypes/procurement-board-2026-10-27.html`（生产目标视觉稿）；
 *    样式全在 `procurement.css`（只用 tokens），本文件**不写内联 style、不写色值**；
 *    文案/模板/端点全在 `config/procurement.js`（这里不写死中文）。
 * 🔴 记录 ID 只作 `data-*` 内部主键，**不出现在展示文本里**。
 */
import { escapeHtml } from '../../core/formatters.js';
import { productActionsHtml } from './productActions.js';
import { customSizeModalHtml } from './customSizeModal.js';
const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));
export const formatDay = (isoText, config) => {
  const parts = String(isoText || '').split('-');
  if (parts.length !== 3) return String(isoText || '');
  return fill(config.range.dayTemplate, { month: Number(parts[1]), day: Number(parts[2]) });
};

export const formatClock = (epoch, offsetMinutes) => {
  if (!Number.isFinite(Number(epoch))) return '';
  const date = new Date(Number(epoch) + Number(offsetMinutes) * 60 * 1000);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
};

/** epoch → 「M月D日」（上海时区）；上新窗口跨多天后卡片小字要带日期，不能都写「今日」。 */
export const formatDayOfEpoch = (epoch, config) => {
  if (!Number.isFinite(Number(epoch))) return '';
  const date = new Date(Number(epoch) + Number(config.timezoneOffsetMinutes) * 60 * 1000);
  return formatDay(date.toISOString().slice(0, 10), config);
};

export const titleOf = (product, config) => {
  const primary = product?.itemNo || product?.number;
  return primary ? fill(config.card.titleTemplate, { itemNo: primary, color: product?.color || '' })
    : fill(config.card.titleFallback, { number: product?.number || '', color: product?.color || '' });
};

const stepperHtml = ({ recordId, size, quantity, config }) => `<div class="pr-pick">
    <div class="pr-stepper">
      <button type="button" data-pr-step="-1" data-record="${escapeHtml(recordId)}" data-size="${escapeHtml(size)}">−</button>
      <input class="pr-qty" inputmode="numeric" pattern="[0-9]*" data-pr-qty data-record="${escapeHtml(recordId)}"
        data-size="${escapeHtml(size)}" value="${escapeHtml(quantity)}" aria-label="${escapeHtml(fill(config.a11y.qtyLabel, { size }))}">
      <button type="button" data-pr-step="1" data-record="${escapeHtml(recordId)}" data-size="${escapeHtml(size)}">+</button>
    </div>
  </div>`;

/** 把 `需补{total}双` 这类模板渲染成「文本 + <b>数字</b> + 文本」（总数要能局部更新）。 */
const totalTemplateHtml = (template, total) => {
  const [before, after] = String(template || '').split('{total}');
  return `${escapeHtml(before)}<b>${escapeHtml(total)}</b>${escapeHtml(after || '')}`;
};

const saleTagsHtml = (row, config) => {
  const parts = [];
  if (Number(row.spotSold) > 0) {
    parts.push(`<span><span class="pr-tag pr-tag-spot">${escapeHtml(config.card.tags.spot)}</span> <b>${row.spotSold}</b> ${escapeHtml(config.units.pair)}</span>`);
  }
  if (Number(row.prepaidSold) > 0) {
    parts.push(`<span><span class="pr-tag pr-tag-pre">${escapeHtml(config.card.tags.prepaid)}</span> <b>${row.prepaidSold}</b> ${escapeHtml(config.units.pair)}</span>`);
  }
  if (Number(row.notArrived) > 0) {
    parts.push(`<span><span class="pr-tag pr-tag-not">${escapeHtml(config.card.tags.notArrived)}</span> <b>${row.notArrived}</b> ${escapeHtml(config.units.pair)}</span>`);
  }
  return `<div class="pr-sale">${parts.join('')}</div>`;
};

const replenishRowHtml = (group, row, draft, store, config) => {
  const quantity = store.quantityOf(draft, group.productRecordId, row.size);
  // 业务负责人 2026-10-29 两次批注：
  //   ① 预订（必补）行不要"对勾"；② 现货行也**不要方框** —— 补货数量由数量框决定（0=不选，>0=选中）。
  // 每个尺码卡仍然**上下两栏**：第一行 尺码 + 现货/预订数量；第二行 加减数量圆框。
  return `<div class="pr-size-row">
    <div class="pr-size-row-head">
      <div class="pr-size">${escapeHtml(row.size)}</div>
      ${saleTagsHtml(row, config)}
    </div>
    ${stepperHtml({ recordId: group.productRecordId, size: row.size, quantity, config })}
  </div>`;
};

const customSizeRowHtml = (group, size, draft, store, config) => {
  const quantity = store.quantityOf(draft, group.productRecordId, size);
  return '<div class="pr-size-row pr-custom-size" data-pr-custom-row data-record="' + escapeHtml(group.productRecordId) + '" data-size="' + escapeHtml(size) + '">'
    + '<div class="pr-size-row-head"><div class="pr-size">' + escapeHtml(size) + '</div>'
    + '<button type="button" class="pr-custom-size-remove" data-pr-custom-remove data-record="' + escapeHtml(group.productRecordId) + '" data-size="' + escapeHtml(size) + '" aria-label="' + escapeHtml(config.texts.customSizeRemove) + '">×</button></div>'
    + stepperHtml({ recordId: group.productRecordId, size, quantity, config })
    + '</div>';
};
export const replenishGroupHtml = (group, draft, store, config) => {
  const customs = typeof store.customSizesOf === 'function' ? store.customSizesOf(draft, group.productRecordId) : [];
  return `<section class="pr-group" data-pr-group="${escapeHtml(group.productRecordId)}">
  <div class="pr-group-head">
    <div class="pr-group-title-wrap"><h2 class="pr-group-name">${escapeHtml(titleOf(group, config))}</h2>${productActionsHtml(group, config)}</div>
    <div class="pr-group-total" data-pr-group-total="${escapeHtml(group.productRecordId)}">${totalTemplateHtml(config.card.replenishTotal, 0)}</div>
  </div>
  <div class="pr-size-grid">${(group.sizes || []).map((row) => replenishRowHtml(group, row, draft, store, config)).join('')}${customs.map((size) => customSizeRowHtml(group, size, draft, store, config)).join('')}</div>
  <button type="button" class="btn pr-add-size" data-pr-add-size data-record="${escapeHtml(group.productRecordId)}">${escapeHtml(config.texts.addCustomSize)}</button>
</section>`;
};

const newRowHtml = (group, size, draft, store, config) => {
  const quantity = store.quantityOf(draft, group.productRecordId, size);
  // 业务负责人 2026-10-29 二次批注：上新卡里**尺码和加减框在同一行**（不需要像补货那样上下两栏，
  // 因为上新没有"现货/预订数量"信息要展示）；仍保持**一行两个尺码**。
  return `<div class="pr-size-row pr-size-row-inline">
    <div class="pr-size">${escapeHtml(size)}</div>
    ${stepperHtml({ recordId: group.productRecordId, size, quantity, config })}
  </div>`;
};

export const newGroupHtml = (group, draft, store, config) => {
  const supplier = String(group.supplierName || '').trim();
  // 供应商为空 ⇒ 用无「·」的模板（否则卡片小字会多一个孤零零的「·」）
  const subtitle = fill(supplier ? config.card.newSubtitle : config.card.newSubtitleNoSupplier, {
    date: formatDayOfEpoch(group.createdAt, config),
    time: formatClock(group.createdAt, config.timezoneOffsetMinutes),
    supplier,
  });
  const head = `<div class="pr-group-head">
    <h2 class="pr-group-name">${escapeHtml(titleOf(group, config))}<small>${escapeHtml(subtitle)}</small></h2>
    <div class="pr-group-total" data-pr-group-total="${escapeHtml(group.productRecordId)}">${totalTemplateHtml(group.categoryMissing ? '' : config.card.newNormalTotal, 0)}</div>
  </div>`;
  if (group.categoryMissing) {
    return `<section class="pr-group" data-pr-group="${escapeHtml(group.productRecordId)}">${head}
      <p class="pr-hint">${escapeHtml(config.texts.categoryMissing)}</p></section>`;
  }
  const normal = (group.sizes?.normal || []).map((size) => newRowHtml(group, size, draft, store, config)).join('');
  const special = (group.sizes?.special || []).map((size) => newRowHtml(group, size, draft, store, config)).join('');
  const specialBlock = special ? `<details class="pr-special"><summary>${escapeHtml(fill(config.card.specialSummary, { count: group.sizes.special.length }))}</summary>
    <div class="pr-size-grid">${special}</div></details>` : '';
  return `<section class="pr-group" data-pr-group="${escapeHtml(group.productRecordId)}">${head}
    <div class="pr-size-grid">${normal}</div>${specialBlock}</section>`;
};

export const emptyHtml = (text) => `<div class="pr-empty">${escapeHtml(text)}</div>`;

export const errorHtml = (text, config) => `<div class="pr-empty"><p>${escapeHtml(text)}</p>
  <button type="button" class="btn" data-pr-retry>${escapeHtml(config.texts.retry)}</button></div>`;

export const toastHtml = () => '<div class="pr-toast" data-pr-toast role="status" aria-live="polite"></div>';

/** 页面骨架（薄壳之上的唯一一份 DOM 结构；tabs/底部条/各 panel 容器）。 */
export const shellHtml = (config) => {
  const tabs = config.tabs.map((tab) => `<button type="button" class="pr-tab" data-pr-tab="${escapeHtml(tab.id)}" role="tab">${escapeHtml(tab.label)}<small>${escapeHtml(tab.hint)}</small></button>`).join('');
  return `<div class="pr-sticky-head">
    <div class="pr-tabs" role="tablist" aria-label="${escapeHtml(config.title)}">${tabs}</div>
    <div class="pr-query-row">
      <label class="pr-search"><span class="pr-search__icon" aria-hidden="true">⌕</span><input type="search" data-pr-search placeholder="${escapeHtml(config.texts.searchPlaceholder)}" aria-label="${escapeHtml(config.texts.searchPlaceholder)}"></label>
      <div class="pr-range-host" data-pr-range-host></div>
    </div>
    <div class="pr-search-results-host" data-pr-search-results-host hidden></div>
  </div>
  <div class="pr-modify-banner hidden" data-pr-modify-banner></div>
  <div class="pr-panel" data-pr-panel="suggested"></div>
  <div class="pr-panel hidden" data-pr-panel="pending"></div>
  ${customSizeModalHtml(config)}
  <div class="pr-bottom"><div class="pr-bottom-inner">
    <div class="pr-picked"><span>${escapeHtml(config.units.pickedLabel)}</span><b data-pr-total>0 ${escapeHtml(config.units.pair)}</b>
      <small data-pr-breakdown></small></div>
    <button type="button" class="pr-clear" data-pr-clear hidden>${escapeHtml(config.texts.clearDraft)}</button>
    <button type="button" class="pr-submit" data-pr-submit>${escapeHtml(config.texts.submit)}</button>
  </div></div>
  ${toastHtml()}`;
};

export { fill, totalTemplateHtml };
