/** 采购待提交列表：只读，按供应商分组，按打印采购单结构展示草稿里的已选货品。 */
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

export const pendingListHtml = (draft, config, supplierNames = {}) => {
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
  if (!suppliers.size) return `<div class="pr-empty">${escapeHtml(config.texts.pendingEmpty)}</div>`;
  return `<div class="pr-pending" data-pr-pending>${[...suppliers.values()]
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
    </section>`).join('')}</div>`;
};
