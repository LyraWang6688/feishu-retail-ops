/** 采购预览区：未提交草稿 + 已报货批次（今天展开、历史折叠、明细懒加载）。 */
import { escapeHtml } from '../../core/formatters.js';

const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));
const productTitle = (product) => [product.itemNo || product.number, product.color].filter(Boolean).join(' · ');

export const supplierNameMap = (bodies = {}) => {
  const map = {};
  for (const body of Object.values(bodies)) {
    for (const group of body?.groups || []) map[group.supplierRecordId || ''] = group.supplierName || '';
  }
  return map;
};

const draftSupplierHtml = (draft, config, supplierNames) => {
  const suppliers = new Map();
  for (const product of Object.values(draft?.products || {})) {
    const entries = Object.entries(product.entries || {})
      .map(([size, quantity]) => ({ size: Number(size), quantity: Number(quantity) || 0 }))
      .filter((row) => Number.isFinite(row.size) && row.quantity > 0)
      .sort((a, b) => a.size - b.size);
    if (!entries.length) continue;
    const key = String(product.supplierRecordId || '') || '__unassigned__';
    const name = String(product.supplierName || supplierNames[key] || config.texts.supplierUnassigned || '');
    if (!suppliers.has(key)) suppliers.set(key, { name, products: [], total: 0 });
    const bucket = suppliers.get(key);
    bucket.products.push({ product, entries });
    bucket.total += entries.reduce((sum, row) => sum + row.quantity, 0);
  }
  return [...suppliers.values()]
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .map((supplier) => `<section class="pr-pending-supplier">
      <h3 class="pr-pending-supplier-name">${escapeHtml(config.texts.pendingSupplier)}：${escapeHtml(supplier.name)}</h3>
      ${supplier.products
        .sort((a, b) => productTitle(a.product).localeCompare(productTitle(b.product), 'zh-CN'))
        .map(({ product, entries }) => `<div class="pr-pending-product">
          <h4>${escapeHtml(productTitle(product))}</h4>
          <ul>${entries.map((row) => `<li>${escapeHtml(fill(config.texts.pendingSizeLine, { size: row.size, quantity: row.quantity }))}</li>`).join('')}</ul>
        </div>`).join('')}
      <p class="pr-pending-total">${escapeHtml(fill(config.texts.pendingTotal, { total: supplier.total }))}</p>
    </section>`).join('');
};

const batchProductsHtml = (batch, config) => {
  if (!Array.isArray(batch.products) || !batch.products.length) {
    return `<p class="hint">${escapeHtml(config.texts.detailEmpty)}</p>`;
  }
  return `<p class="pr-pending-batch-summary">${escapeHtml(fill(config.texts.submittedSummary, {
    products: batch.product_count,
    total: batch.total_quantity,
  }))}</p>
  <div class="pr-pending-batch-products">${batch.products.map((product) => `<div class="pr-pending-product">
    <h4>${escapeHtml(productTitle(product))}</h4>
    <ul>${(product.entries || []).map((row) => `<li>${escapeHtml(fill(config.texts.pendingSizeLine, { size: row.size, quantity: row.quantity }))}</li>`).join('')}</ul>
  </div>`).join('')}</div>`;
};

const submittedBatchHtml = (batch, config, { expanded = false, loading = false } = {}) => {
  const batchNo = String(batch.batch_no || '');
  const isExpanded = expanded;
  const canModify = config.texts.modifyEnabled && batch.batch_no;
  const toggleText = isExpanded ? config.texts.collapse : config.texts.expand;
  return `<section class="pr-pending-submitted-batch" data-pr-submitted-batch="${escapeHtml(batchNo)}">
    <div class="pr-pending-submitted-head">
      <div class="pr-pending-submitted-title">
        <h4 class="pr-pending-batch-no">${escapeHtml(batch.batch_no)}</h4>
        <p class="pr-pending-batch-meta">${escapeHtml(config.texts.pendingSupplier)}：${escapeHtml(batch.supplier_name || config.texts.supplierUnassigned)}</p>
      </div>
      <div class="pr-pending-actions">
        <button type="button" class="pr-pending-expand" data-pr-expand-batch="${escapeHtml(batchNo)}">${escapeHtml(toggleText)}</button>
        ${canModify ? `<button type="button" class="pr-pending-modify" data-pr-modify-batch="${escapeHtml(batchNo)}">${escapeHtml(config.texts.modify)}</button>` : ''}
      </div>
    </div>
    ${isExpanded ? (loading ? `<p class="hint">${escapeHtml(config.texts.detailLoading)}</p>` : batchProductsHtml(batch, config)) : ''}
  </section>`;
};

const groupHtml = (title, batches, config, state) => {
  if (!batches.length) return '';
  const expanded = state.expanded instanceof Set ? state.expanded : new Set();
  const loading = state.detailLoading instanceof Set ? state.detailLoading : new Set();
  return `<section class="pr-pending-submitted-group">
    <h3>${escapeHtml(title)}</h3>
    ${batches.map((batch) => submittedBatchHtml(batch, config, {
      expanded: expanded.has(batch.batch_no),
      loading: loading.has(batch.batch_no),
    })).join('')}
  </section>`;
};

export const pendingListHtml = (draft, config, supplierNames = {}, submitted = [], state = {}) => {
  const draftHtml = draftSupplierHtml(draft, config, supplierNames);
  const today = (submitted || []).filter((batch) => batch.is_today);
  const history = (submitted || []).filter((batch) => !batch.is_today);
  const groups = groupHtml(config.texts.todayTitle, today, config, state)
    + groupHtml(config.texts.historyTitle, history, config, state);
  const more = state.hasMore
    ? `<button class="pr-pending-more" type="button" data-pr-more>${escapeHtml(config.texts.loadMore)}</button>`
    : '';
  const submittedHtml = (submitted || []).length
    ? `<section class="pr-pending-submitted"><h3>${escapeHtml(config.texts.submittedTitle)}</h3>${groups}${more}</section>`
    : '';
  if (!draftHtml && !submittedHtml) return `<div class="pr-empty">${escapeHtml(config.texts.pendingEmpty)}</div>`;
  return `<div class="pr-pending" data-pr-pending>${draftHtml ? `<section class="pr-pending-draft"><h3>${escapeHtml(config.texts.unsubmittedTitle)}</h3>${draftHtml}</section>` : ''}${submittedHtml}</div>`;
};
