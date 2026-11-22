/** 采购待提交列表：未提交草稿 + 今日已提交批次（只读，批次提供“修改”入口）。 */
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

const submittedBatchHtml = (batch, config) => `<section class="pr-pending-submitted-batch">
  <div class="pr-pending-submitted-head">
    <div>
      <h4 class="pr-pending-batch-no">${escapeHtml(batch.batch_no)}</h4>
      <p class="pr-pending-batch-meta">${escapeHtml(config.texts.pendingSupplier)}：${escapeHtml(batch.supplier_name || config.texts.supplierUnassigned)} · ${escapeHtml(config.texts.submittedAt)} ${escapeHtml(String(batch.submitted_at || '').slice(11, 16))}</p>
    </div>
    ${config.texts.modifyEnabled ? `<button type="button" class="pr-pending-modify" data-pr-modify-batch="${escapeHtml(batch.batch_no)}">${escapeHtml(config.texts.modify)}</button>` : ''}
  </div>
  <p class="pr-pending-batch-summary">${escapeHtml(fill(config.texts.submittedSummary, { products: batch.product_count, total: batch.total_quantity }))}</p>
  <div class="pr-pending-batch-products">${(batch.products || []).map((product) => `<div class="pr-pending-product">
    <h4>${escapeHtml(productTitle(product))}</h4>
    <ul>${(product.entries || []).map((row) => `<li>${escapeHtml(fill(config.texts.pendingSizeLine, { size: row.size, quantity: row.quantity }))}</li>`).join('')}</ul>
  </div>`).join('')}</div>
</section>`;

export const pendingListHtml = (draft, config, supplierNames = {}, submitted = []) => {
  const draftHtml = draftSupplierHtml(draft, config, supplierNames);
  const submittedHtml = (submitted || []).length
    ? `<section class="pr-pending-submitted"><h3>${escapeHtml(config.texts.submittedTitle)}</h3>${submitted.map((batch) => submittedBatchHtml(batch, config)).join('')}</section>`
    : '';
  if (!draftHtml && !submittedHtml) return `<div class="pr-empty">${escapeHtml(config.texts.pendingEmpty)}</div>`;
  return `<div class="pr-pending" data-pr-pending>${draftHtml ? `<section class="pr-pending-draft"><h3>${escapeHtml(config.texts.unsubmittedTitle)}</h3>${draftHtml}</section>` : ''}${submittedHtml}</div>`;
};
