/**
 * 采购页渲染器（纯函数：配置 + 数据 + 草稿 → HTML 字符串）。
 *
 * 🔴 视觉目标 = `docs/prototypes/procurement-board-2026-10-27.html`（生产目标视觉稿）；
 *    样式全在 `procurement.css`（只用 tokens），本文件**不写内联 style、不写色值**；
 *    文案/模板/端点全在 `config/procurement.js`（这里不写死中文）。
 * 🔴 记录 ID 只作 `data-*` 内部主键，**不出现在展示文本里**。
 */
import { escapeHtml } from '../../core/formatters.js';

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));

export const formatDay = (isoText, config) => {
  const parts = String(isoText || '').split('-');
  if (parts.length !== 3) return String(isoText || '');
  return fill(config.range.dayTemplate, { month: Number(parts[1]), day: Number(parts[2]) });
};

export const rangeText = (tab, range, config) => {
  if (tab !== 'replenish') return config.range.newProducts;
  return fill(config.range.replenish, { from: formatDay(range?.from, config), to: formatDay(range?.to, config) });
};

export const formatClock = (epoch, offsetMinutes) => {
  if (!Number.isFinite(Number(epoch))) return '';
  const date = new Date(Number(epoch) + Number(offsetMinutes) * 60 * 1000);
  return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
};

export const titleOf = (product, config) => {
  const primary = product?.itemNo || product?.number;
  return primary ? fill(config.card.titleTemplate, { itemNo: primary, color: product?.color || '' })
    : fill(config.card.titleFallback, { number: product?.number || '', color: product?.color || '' });
};

const statsHtml = (tab, body, config) => {
  const defs = tab === 'replenish' ? config.stats.replenish : config.stats.newProducts;
  const refreshButton = `<button type="button" class="pr-refresh" data-pr-refresh>${escapeHtml(config.texts.refresh)}</button>`;
  // 业务负责人 2026-10-29 批注：只有 1 个统计项（上新）时 ⇒ 统计 + 范围文案 + 刷新**放在一行**（不再大块留白）
  if (defs.length === 1) {
    const def = defs[0];
    return `<section class="pr-summary pr-summary-inline" aria-label="${escapeHtml(config.title)}">
      <div class="pr-stat-inline"><b>${escapeHtml(body?.stats?.[def.key] ?? 0)}</b><span>${escapeHtml(def.label)}</span></div>
      <div class="pr-range-inline"><span>${escapeHtml(config.texts.rangeLabel)}</span><strong>${escapeHtml(rangeText(tab, body?.range, config))}</strong></div>
      ${refreshButton}
    </section>`;
  }
  const cells = defs.map((def) => `<div class="pr-stat"><b>${escapeHtml(body?.stats?.[def.key] ?? 0)}</b><span>${escapeHtml(def.label)}</span></div>`).join('');
  return `<section class="pr-summary" aria-label="${escapeHtml(config.title)}">
    <div class="pr-summary-grid">${cells}</div>
    <div class="pr-range"><span>${escapeHtml(config.texts.rangeLabel)}</span><strong>${escapeHtml(rangeText(tab, body?.range, config))}</strong>
      ${refreshButton}</div>
  </section>`;
};

const legendHtml = (tab, config) => {
  const items = (tab === 'replenish' ? config.legends.replenish : config.legends.newProducts)
    .map((legend) => `<span><i class="pr-dot pr-dot-${legend.kind}"></i>${escapeHtml(legend.text)}</span>`).join('');
  return `<div class="pr-legend">${items}</div>`;
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

export const replenishGroupHtml = (group, draft, store, config) => `<section class="pr-group" data-pr-group="${escapeHtml(group.productRecordId)}">
  <div class="pr-group-head">
    <h2 class="pr-group-name">${escapeHtml(titleOf(group, config))}</h2>
    <div class="pr-group-total" data-pr-group-total="${escapeHtml(group.productRecordId)}">${totalTemplateHtml(config.card.replenishTotal, 0)}</div>
  </div>
  ${(group.sizes || []).map((row) => replenishRowHtml(group, row, draft, store, config)).join('')}
</section>`;

const newRowHtml = (group, size, draft, store, config) => {
  const quantity = store.quantityOf(draft, group.productRecordId, size);
  // 业务负责人 2026-10-29：上新尺码格**统一成补货那种卡片样式** ——
  // 上下两栏（第一行尺码 / 第二行加减圆框居中），一行两个。
  return `<div class="pr-size-row">
    <div class="pr-size-row-head"><div class="pr-size">${escapeHtml(size)}</div></div>
    ${stepperHtml({ recordId: group.productRecordId, size, quantity, config })}
  </div>`;
};

export const newGroupHtml = (group, draft, store, config) => {
  const subtitle = fill(config.card.newSubtitle, {
    time: formatClock(group.createdAt, config.timezoneOffsetMinutes),
    supplier: group.supplierName || '',
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
    <div class="pr-new-grid">${special}</div></details>` : '';
  return `<section class="pr-group" data-pr-group="${escapeHtml(group.productRecordId)}">${head}
    <div class="pr-new-grid">${normal}</div>${specialBlock}</section>`;
};

export const emptyHtml = (text) => `<div class="pr-empty">${escapeHtml(text)}</div>`;

export const errorHtml = (text, config) => `<div class="pr-empty"><p>${escapeHtml(text)}</p>
  <button type="button" class="btn" data-pr-retry>${escapeHtml(config.texts.retry)}</button></div>`;

export const toastHtml = () => '<div class="pr-toast" data-pr-toast role="status" aria-live="polite"></div>';

/** 页面骨架（薄壳之上的唯一一份 DOM 结构；tabs/底部条/各 panel 容器）。 */
export const shellHtml = (config) => {
  const tabs = config.tabs.map((tab) => {
    const attrs = [`type="button"`, `class="pr-tab${tab.disabled ? ' pr-tab-disabled' : ''}"`];
    if (tab.disabled) {
      attrs.push('disabled', 'aria-disabled="true"', 'data-pr-scan-disabled',
        `title="${escapeHtml(tab.disabledHint || '')}"`);
      if (tab.tapTarget) attrs.push(`data-tap-target="${escapeHtml(tab.tapTarget)}"`);
    } else {
      attrs.push(`data-pr-tab="${escapeHtml(tab.id)}"`, 'role="tab"');
    }
    return `<button ${attrs.join(' ')}>${escapeHtml(tab.label)}<small>${escapeHtml(tab.hint)}</small></button>`;
  }).join('');
  return `<header class="pr-top">
    <h1 class="pr-title">${escapeHtml(config.title)}</h1>
    <div class="pr-auth"><span id="auth-status"></span><button id="logout" class="btn pr-logout hidden" type="button">${escapeHtml(config.texts.logout)}</button></div>
  </header>
  <div class="pr-tabs" role="tablist" aria-label="${escapeHtml(config.title)}">${tabs}</div>
  <div class="pr-panel" data-pr-panel="replenish"></div>
  <div class="pr-panel hidden" data-pr-panel="new"></div>
  <div class="pr-bottom"><div class="pr-bottom-inner">
    <div class="pr-picked"><span>${escapeHtml(config.units.pickedLabel)}</span><b data-pr-total>0 ${escapeHtml(config.units.pair)}</b>
      <small data-pr-breakdown></small></div>
    <button type="button" class="pr-submit" data-pr-submit>${escapeHtml(config.texts.submit)}</button>
  </div></div>
  ${toastHtml()}`;
};

export { fill, statsHtml, legendHtml, totalTemplateHtml };
