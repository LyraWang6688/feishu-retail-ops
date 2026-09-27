import { api } from '../../core/api-client.js';
import { dateTime, escapeHtml } from '../../core/formatters.js';
import { bindSubTabs, describeError, showPageError } from '../../core/ui.js';

const $ = (container, selector) => container.querySelector(selector);

function renderShell(container, focused = false) {
  if (focused) {
    container.innerHTML = `
      <section class="panel">
        <div class="panel-header"><div><h2>实时库存查询</h2><p class="subtitle">按编号、货号、颜色或尺码快速查库存</p></div><button class="btn" type="button" data-action="refresh">刷新数据</button></div>
        <div id="inventory-live-subpanel" class="sub-panel"><div class="section-loading">正在加载实时库存…</div></div>
      </section>`;
    return;
  }
  container.innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><h2>库存管理</h2><p class="subtitle">实时库存查询、盘点和库存调整</p></div><div class="header-actions"><a class="btn" href="/workbench/inventory.html">独立打开实时库存</a><button class="btn" type="button" data-action="refresh">刷新数据</button></div></div>
      <h3 class="section-title">库存操作入口</h3>
      <div class="quick-entries inventory-entries">
        <div class="entry-card disabled-card"><div class="icon">📊</div><h3>库存手工盘点</h3><p>核对系统库存与实际库存差异</p><div class="arrow">规划中</div></div>
        <div class="entry-card disabled-card"><div class="icon">✏️</div><h3>盘点结果录入</h3><p>记录盘点结果并生成差异</p><div class="arrow">规划中</div></div>
        <div class="entry-card disabled-card"><div class="icon">🔧</div><h3>库存状态调整</h3><p>按规则调整样品、门盒和仓库状态</p><div class="arrow">规划中</div></div>
      </div>
      <div class="sub-tabs">
        <button class="sub-tab active" type="button" data-subtab="inventory-live">实时库存查询</button>
        <button class="sub-tab" type="button" data-subtab="inventory-check">盘点记录</button>
        <button class="sub-tab" type="button" data-subtab="inventory-adjust">库存调整记录</button>
      </div>
      <div id="inventory-live-subpanel" class="sub-panel"><div class="section-loading">正在加载实时库存…</div></div>
      <div id="inventory-check-subpanel" class="sub-panel hidden"><div class="inline-placeholder"><h3>盘点记录</h3><p>盘点业务规则和查询接口尚未建立。</p><span class="tag tag-info">规划中</span></div></div>
      <div id="inventory-adjust-subpanel" class="sub-panel hidden"><div class="inline-placeholder"><h3>库存调整记录</h3><p>批量状态流转和调整流水将在后端接口完成后接入。</p><span class="tag tag-info">规划中</span></div></div>
    </section>`;
}

function sumState(rows, state) {
  return rows.filter((row) => row.state === state).reduce((total, row) => total + Number(row.quantity || 0), 0);
}

function renderInventory(container, data, filters) {
  const rows = data.rows || [];
  const duplicates = data.duplicate_stock_keys || [];
  const total = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  $(container, '#inventory-live-subpanel').innerHTML = `
    <div class="summary">
      <div class="metric"><span>当前查询库存</span><strong>${total}</strong></div>
      <div class="metric"><span>样品</span><strong>${sumState(rows, '样品')}</strong></div>
      <div class="metric"><span>门盒</span><strong>${sumState(rows, '门盒')}</strong></div>
      <div class="metric"><span>仓库</span><strong>${sumState(rows, '仓库')}</strong></div>
    </div>
    <div class="filters"><input data-filter="keyword" value="${escapeHtml(filters.keyword || '')}" placeholder="输入库存键/编号/货号/颜色"><input data-filter="size" value="${escapeHtml(filters.size || '')}" placeholder="尺码"><button class="btn btn-primary" type="button" data-search="inventory">查询</button></div>
    ${duplicates.length ? `<div class="warning">发现重复库存键 ${duplicates.length} 个，请在多维表格中检查唯一性。</div>` : ''}
    <div class="table-wrap mobile-card-table"><table><thead><tr><th>库存键</th><th>编号</th><th>货号</th><th>颜色</th><th>尺码</th><th>所属状态</th><th>当前数量</th><th>更新时间</th></tr></thead><tbody>${rows.map((row) => `<tr><td data-label="库存键"><span class="cell-value">${escapeHtml(row.stock_key || '-')}</span></td><td data-label="编号"><span class="cell-value">${escapeHtml(row.product_number || '-')}</span></td><td data-label="货号"><span class="cell-value">${escapeHtml(row.item_no || '-')}</span></td><td data-label="颜色"><span class="cell-value">${escapeHtml(row.color || '-')}</span></td><td data-label="尺码"><span class="cell-value">${escapeHtml(row.size || '-')}</span></td><td data-label="所属状态"><span class="cell-value tag tag-info">${escapeHtml(row.state || '-')}</span></td><td data-label="当前数量" class="quantity"><span class="cell-value">${escapeHtml(row.quantity || 0)}</span></td><td data-label="更新时间"><span class="cell-value">${escapeHtml(dateTime(row.updated_at))}</span></td></tr>`).join('')}</tbody></table></div>
    ${rows.length ? '' : '<p class="empty">没有匹配的库存记录。</p>'}`;
}

export function createInventoryModule({ focused = false } = {}) {
  const state = { container: null, filters: { keyword: '', size: '' } };

  async function loadInventory(filters = state.filters) {
    state.filters = filters;
    showPageError('');
    const params = new URLSearchParams({ keyword: filters.keyword || '', size: filters.size || '' });
    try {
      const data = await api.get(`/api/workbench/inventory?${params}`);
      renderInventory(state.container, data, filters);
      bindSearch();
    } catch (error) { showPageError(describeError(error)); }
  }

  function bindSearch() {
    const panel = $(state.container, '#inventory-live-subpanel');
    const run = () => loadInventory({ keyword: $(panel, '[data-filter="keyword"]').value.trim(), size: $(panel, '[data-filter="size"]').value.trim() });
    $(panel, '[data-search="inventory"]').addEventListener('click', run);
    panel.querySelectorAll('input').forEach((input) => input.addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); }));
  }

  return {
    mount(container) {
      state.container = container;
      renderShell(container, focused);
      if (!focused) bindSubTabs(container);
      $(container, '[data-action="refresh"]').addEventListener('click', () => loadInventory());
      loadInventory();
    },
  };
}
