import { bindProductSearch, productSearchHtml } from '../shared/productSearch.js';
import { MANUAL_ENTRY_PAGE } from '../../config/manualEntry.js';

/**
 * 销售 / 售后共用的「输入货号」页。
 * 只做一件事：选具体货品 → 跳到和扫码相同的落点；不复制任何写链路。
 */
export function mountManualEntryPage(container) {
  if (!container) return;
  const params = new URLSearchParams(window.location.search);
  const realm = params.get('realm') === 'afterSales' ? 'afterSales' : 'sales';
  const title = container.querySelector('[data-view="manual-title"]');
  const hint = container.querySelector('[data-view="manual-hint"]');
  const search = container.querySelector('[data-view="manual-search"]');
  const status = container.querySelector('[data-view="manual-status"]');
  const mode = realm === 'afterSales' ? 'afterSales' : 'salesEntry';
  const page = MANUAL_ENTRY_PAGE;

  if (title) title.textContent = realm === 'afterSales' ? page.afterSalesTitle : page.salesTitle;
  if (hint) {
    hint.textContent = page.hint + (realm === 'afterSales' ? page.afterSalesSearchHint : page.salesSearchHint);
  }
  if (search) search.innerHTML = productSearchHtml({ mode });

  const showStatus = (text) => {
    if (!status) return;
    status.textContent = String(text || '');
    status.hidden = !status.textContent;
  };

  bindProductSearch(search, {
    mode,
    onSelect(item) {
      const recordId = String(item?.recordId || '').trim();
      if (!recordId) {
        showStatus(page.noRecord);
        return;
      }
      showStatus('');
      if (realm === 'afterSales') {
        window.location.href = `${page.afterSalesPage}?productRecordId=${encodeURIComponent(recordId)}`;
        return;
      }
      window.location.href = `${page.salesRecordBase}/${encodeURIComponent(recordId)}?from=sales`;
    },
  });
}
