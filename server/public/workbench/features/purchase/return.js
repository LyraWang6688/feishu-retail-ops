import { api } from '../../core/api-client.js';
import { escapeHtml, statusClass } from '../../core/formatters.js';
import { bindSubTabs, describeError, showPageError } from '../../core/ui.js';
import { createPurchaseModule } from './index.js';

// 「采购退货」——常用功能里的第二个子页，两个子 tab：
//   · 采购：直接复用现有的采购模块（单据信息情况 / 采购到货情况 / 采购入库记录）
//   · 退货：只列「单据信息」里「采购行为 = 采购退货」的那些行
//
// 分流口径不在这里判断：后端 `purchaseQueryService` 复用采购链路自己的
// `purchaseReportBehaviorPolicy`（名称/编码里带「退货」或 RETURN），
// 用 ?reportBehavior=purchase_return 过滤 —— 两处各写一套判断迟早会分家。
const $ = (container, selector) => container.querySelector(selector);

export function createPurchaseReturnModule() {
  const state = { container: null, purchasesMounted: false, returnsLoaded: false };

  function renderShell(container) {
    container.innerHTML = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>采购退货</h2>
            <p class="subtitle">采购申请与采购退货都在「单据信息」表里，按「采购行为」分栏</p>
          </div>
        </div>
        <div class="sub-tabs">
          <button class="sub-tab active" type="button" data-subtab="return-purchase">采购</button>
          <button class="sub-tab" type="button" data-subtab="return-list">退货</button>
        </div>
        <div id="return-purchase-subpanel" class="sub-panel"><div data-view="purchase-host"></div></div>
        <div id="return-list-subpanel" class="sub-panel hidden">
          <div class="section-loading">打开后加载退货记录…</div>
        </div>
      </section>`;
  }

  function mountPurchases() {
    if (state.purchasesMounted) return;
    state.purchasesMounted = true;
    createPurchaseModule().mount($(state.container, '[data-view="purchase-host"]'));
  }

  function renderReturns(rows) {
    const panel = $(state.container, '#return-list-subpanel');
    panel.innerHTML = `
      <div class="summary">
        <div class="metric"><span>退货记录</span><strong>${rows.length}</strong></div>
        <div class="metric"><span>退货总数量</span><strong>${rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0)}</strong></div>
      </div>
      <div class="filters">
        <input data-filter="return-batch" placeholder="输入报货批次号">
        <button class="btn btn-primary" type="button" data-search="returns">查询</button>
      </div>
      <div class="table-wrap mobile-card-table"><table>
        <thead><tr><th>报货批次号</th><th>货品编号</th><th>数量</th><th>采购行为</th><th>到货状态</th></tr></thead>
        <tbody>${rows.map((row) => `<tr>
          <td data-label="报货批次号"><span class="cell-value">${escapeHtml(row.batch_no || '-')}</span></td>
          <td data-label="货品编号"><span class="cell-value">${escapeHtml(row.product_number || '-')}</span></td>
          <td data-label="数量" class="quantity"><span class="cell-value">${escapeHtml(row.quantity || 0)}</span></td>
          <td data-label="采购行为"><span class="cell-value tag tag-info">${escapeHtml(row.report_behavior_name || '采购退货')}</span></td>
          <td data-label="到货状态"><span class="cell-value tag ${statusClass(row.arrival_status)}">${escapeHtml(row.arrival_status || '-')}</span></td>
        </tr>`).join('')}</tbody></table></div>
      ${rows.length ? '' : '<p class="empty">没有匹配的采购退货记录。</p>'}
      <p class="data-caption">采购退货按「采购行为」分流；退货行没有尺码，数量记在「数量」列。</p>`;
    $(panel, '[data-search="returns"]').addEventListener('click', () => loadReturns($(panel, '[data-filter="return-batch"]').value.trim()));
    $(panel, '[data-filter="return-batch"]').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadReturns($(panel, '[data-filter="return-batch"]').value.trim());
    });
  }

  async function loadReturns(batchNo = '') {
    showPageError('');
    const params = new URLSearchParams({ reportBehavior: PURCHASE_RETURN_FILTER });
    if (batchNo) params.set('batchNo', batchNo);
    try {
      const data = await api.get(`/api/workbench/purchase/requests?${params}`);
      state.returnsLoaded = true;
      renderReturns(data.rows || []);
    } catch (error) { showPageError(describeError(error)); }
  }

  return {
    mount(container) {
      state.container = container;
      renderShell(container);
      bindSubTabs(container, (subtab) => {
        if (subtab === 'return-purchase') mountPurchases();
        if (subtab === 'return-list' && !state.returnsLoaded) loadReturns();
      });
      mountPurchases();
    },
  };
}

// 「退货」这一栏的过滤口径（后端 purchaseQueryService 的 reportBehavior 取值）。
export const PURCHASE_RETURN_FILTER = 'purchase_return';
