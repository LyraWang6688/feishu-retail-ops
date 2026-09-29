import { api } from '../../core/api-client.js';
import { dateTime, escapeHtml, money, statusClass } from '../../core/formatters.js';
import { bindSubTabs, describeError, setBusy, showPageError } from '../../core/ui.js';

const $ = (container, selector) => container.querySelector(selector);

function renderShell(container, focused = false) {
  if (focused) {
    container.innerHTML = `
      <section class="panel">
        <div class="panel-header">
          <div><h2>今日销售明细</h2><p class="subtitle">快速查看今天已经确认的销售情况</p></div>
          <button class="btn" type="button" data-action="refresh">刷新数据</button>
        </div>
        <div id="sales-today-subpanel" class="sub-panel"><div class="section-loading">正在加载今日销售…</div></div>
      </section>`;
    return;
  }
  container.innerHTML = `
    <section class="panel">
      <div class="panel-header">
        <div><h2>销售管理</h2><p class="subtitle">销售查询、后续收款与实际交付</p></div>
        <div class="header-actions"><a class="btn" href="/workbench/sales-today.html">独立打开今日销售</a><button class="btn" type="button" data-action="refresh">刷新数据</button></div>
      </div>
      <div class="sub-tabs">
        <button class="sub-tab active" type="button" data-subtab="sales-today">今日销售明细</button>
        <button class="sub-tab" type="button" data-subtab="sales-followup">交付 / 收款管理</button>
        <button class="sub-tab" type="button" data-subtab="sales-return">退换货管理</button>
        <button class="sub-tab" type="button" data-subtab="sales-voucher">抖音团购券</button>
      </div>

      <div id="sales-today-subpanel" class="sub-panel">
        <div class="section-loading">正在加载今日销售…</div>
      </div>
      <div id="sales-followup-subpanel" class="sub-panel hidden">
        <div class="section-loading">打开后加载待处理订单…</div>
      </div>
      <div id="sales-return-subpanel" class="sub-panel hidden">
        <div class="inline-placeholder"><h3>退换货管理</h3><p>退货、退款和退回库存的业务规则及接口尚未建立。</p><span class="tag tag-info">规划中</span></div>
      </div>
      <div id="sales-voucher-subpanel" class="sub-panel hidden">
        <div class="inline-placeholder"><h3>销售关联团购券</h3><p>这里将展示销售单使用的券款及待平台结算状态；不会替代抖音平台核销与对账模块。</p><span class="tag tag-info">规划中</span></div>
      </div>
    </section>`;
}

function renderToday(container, data) {
  const panel = $(container, '#sales-today-subpanel');
  const summary = data.summary || {};
  panel.innerHTML = `
    <div class="summary">
      <div class="metric"><span>今日销售单数</span><strong>${escapeHtml(summary.order_count || 0)}</strong></div>
      <div class="metric"><span>今日销售数量</span><strong>${escapeHtml(summary.quantity || 0)}</strong></div>
      <div class="metric"><span>今日成交金额</span><strong>${summary.receivable_amount === null ? '待录入' : money(summary.receivable_amount)}</strong></div>
      <div class="metric"><span>这些订单累计已收</span><strong>${money(summary.paid_amount)}</strong></div>
      <div class="metric"><span>待平台结算</span><strong>${money(summary.platform_pending_amount)}</strong></div>
    </div>
    <p class="data-caption">业务日期：${escapeHtml(data.date || '-')}。页面不展示接口未提供的同比或环比数据。</p>
    <div class="table-wrap mobile-card-table">
      <table>
        <thead><tr><th>时间</th><th>编号</th><th>尺码</th><th>数量</th><th>成交金额</th><th>收款方式</th><th>赠品</th><th>销售单号</th></tr></thead>
        <tbody>${(data.rows || []).map((row) => `<tr>${[
          ['时间', dateTime(row.sold_at)], ['编号', row.product_number || '-'], ['尺码', row.size || '-'], ['数量', row.quantity],
          ['成交金额', row.receivable_amount === null ? '待录入' : money(row.receivable_amount)],
          ['收款方式', row.payment_method || '-'], ['赠品', row.gift || '-'], ['销售单号', row.sales_order_no || '-'],
        ].map(([label, value]) => `<td data-label="${label}"><span class="cell-value">${escapeHtml(value)}</span></td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>
    ${data.rows?.length ? '' : '<p class="empty">今天还没有已确认的销售明细。</p>'}`;
}

function orderSummary(order) {
  return (order.details || []).map((item) => `${item.product || item.record_id} ${item.size}码`).join('、');
}

function renderFollowup(container, state) {
  const panel = $(container, '#sales-followup-subpanel');
  const pendingPayments = state.orders.filter((order) => order.pending_amount > 0);
  const pendingDeliveries = state.orders.filter((order) => order.pending_delivery_quantity > 0);
  panel.innerHTML = `
    <div class="two-col followup-columns">
      <section class="col-section">
        <h3>待交付 <span class="tag tag-warning">${pendingDeliveries.length}</span></h3>
        <div class="pending-list" data-list="deliveries">${pendingDeliveries.length ? pendingDeliveries.map((order) => `
          <article class="list-card"><div class="info"><div class="title">${escapeHtml(order.order_no)}</div><div class="desc">${escapeHtml(orderSummary(order))} · 待交付 ${order.pending_delivery_quantity} 双</div></div><button class="btn btn-primary" type="button" data-select-order="${escapeHtml(order.record_id)}" data-target="delivery">去交付</button></article>`).join('') : '<p class="empty compact">暂无待交付订单</p>'}</div>
      </section>
      <section class="col-section">
        <h3>待收款 <span class="tag tag-info">${pendingPayments.length}</span></h3>
        <div class="pending-list" data-list="payments">${pendingPayments.length ? pendingPayments.map((order) => `
          <article class="list-card"><div class="info"><div class="title">${escapeHtml(order.order_no)}</div><div class="desc">${escapeHtml(orderSummary(order))}</div></div><div class="card-action"><strong>${money(order.pending_amount)}</strong><button class="btn" type="button" data-select-order="${escapeHtml(order.record_id)}" data-target="payment">去收款</button></div></article>`).join('') : '<p class="empty compact">暂无待收款订单</p>'}</div>
      </section>
    </div>
    <div class="followup-workspace">
      <div class="toolbar compact-toolbar"><label class="form-field grow">销售单<select data-field="order"></select></label><button class="btn" type="button" data-action="refresh-orders">刷新订单</button></div>
      <div class="order-details" data-view="order-details">请选择销售单</div>
      <div class="two-col action-columns">
        <form class="action-form" data-form="payment">
          <h3>补充收款</h3>
          <p class="muted">只在顾客实际付款后操作；新订单的未收款记录要求一次收清。</p>
          <label class="form-field">收款金额<input data-field="payment-amount" type="number" min="0.01" step="0.01" required></label>
          <label class="form-field">支付方式<select data-field="payment-method" required></select></label>
          <button class="btn btn-primary" type="submit">确认收款</button>
        </form>
        <form class="action-form" data-form="delivery">
          <h3>确认交付</h3>
          <p class="muted">只勾选已经实际交给顾客的鞋；成功后才扣减库存。</p>
          <div data-view="delivery-details"></div>
          <button class="btn btn-primary" type="submit">确认交付并扣库存</button>
        </form>
      </div>
      <p class="operation-result" data-view="result" role="status"></p>
    </div>`;

  const orderSelect = $(panel, '[data-field="order"]');
  state.orders.forEach((order) => orderSelect.add(new Option(order.order_no, order.record_id)));
  const methodSelect = $(panel, '[data-field="payment-method"]');
  state.methods.forEach((method) => methodSelect.add(new Option(method, method)));
  bindFollowupEvents(container, state);
  renderSelectedOrder(container, state);
  $(panel, '[data-view="result"]').textContent = state.operationMessage || '';
}

function selectedOrder(container, state) {
  const select = $(container, '[data-field="order"]');
  return state.orders.find((order) => order.record_id === select?.value);
}

function renderSelectedOrder(container, state) {
  const order = selectedOrder(container, state);
  const details = $(container, '[data-view="order-details"]');
  const delivery = $(container, '[data-view="delivery-details"]');
  if (!details || !delivery) return;
  details.innerHTML = order ? `
    <div><span>收款状态</span><strong class="tag ${statusClass(order.payment_status)}">${escapeHtml(order.payment_status || '待核对')}</strong></div>
    <div><span>成交</span><strong>${order.receivable_amount === null ? '待录入' : money(order.receivable_amount)}</strong></div>
    <div><span>已收</span><strong>${money(order.paid_amount)}</strong></div>
    <div><span>待收</span><strong>${order.pending_amount === null ? '待核对' : money(order.pending_amount)}</strong></div>
    <div><span>履约</span><strong class="tag ${statusClass(order.fulfillment_status)}">${escapeHtml(order.fulfillment_status || '待核对')}</strong></div>` : '<p>请选择销售单</p>';
  delivery.replaceChildren();
  for (const detail of order?.details || []) {
    const label = document.createElement('label');
    label.className = 'delivery-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = detail.record_id;
    input.disabled = detail.delivered_quantity >= detail.quantity;
    label.append(input, document.createTextNode(`${detail.product || detail.record_id}｜${detail.size}码${input.disabled ? '（已交付）' : ''}`));
    delivery.append(label);
  }
}

function bindFollowupEvents(container, state) {
  const panel = $(container, '#sales-followup-subpanel');
  panel.querySelectorAll('[data-select-order]').forEach((button) => button.addEventListener('click', () => {
    const orderSelect = $(panel, '[data-field="order"]');
    orderSelect.value = button.dataset.selectOrder;
    renderSelectedOrder(container, state);
    if (button.dataset.target === 'payment') {
      const order = selectedOrder(container, state);
      $(panel, '[data-field="payment-amount"]').value = order?.pending_amount || '';
    } else {
      panel.querySelectorAll('[data-view="delivery-details"] input:not(:disabled)').forEach((input) => { input.checked = true; });
    }
    $(panel, `[data-form="${button.dataset.target}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $(panel, '[data-field="order"]').addEventListener('change', () => renderSelectedOrder(container, state));
}

export function createSalesModule({ focused = false } = {}) {
  const state = { container: null, orders: [], methods: [], activeSubtab: 'sales-today', loadedFollowup: false, operationMessage: '' };

  async function loadToday() {
    showPageError('');
    try { renderToday(state.container, await api.get('/api/workbench/sales/today')); }
    catch (error) { showPageError(describeError(error)); }
  }

  async function loadOrders(selectedId = '') {
    showPageError('');
    try {
      const result = await api.get('/api/workbench/sales/orders');
      state.orders = result.orders || [];
      state.methods = result.methods || [];
      state.loadedFollowup = true;
      renderFollowup(state.container, state);
      const panel = $(state.container, '#sales-followup-subpanel');
      if (selectedId && state.orders.some((order) => order.record_id === selectedId)) {
        $(panel, '[data-field="order"]').value = selectedId;
        renderSelectedOrder(state.container, state);
      }
      bindFollowupActions(panel);
    } catch (error) { showPageError(describeError(error)); }
  }

  function bindFollowupActions(panel) {
    $(panel, '[data-action="refresh-orders"]').addEventListener('click', () => loadOrders($(panel, '[data-field="order"]').value));
    $(panel, '[data-form="payment"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const order = selectedOrder(state.container, state);
      if (!order) return showPageError('请选择销售单');
      const button = event.submitter;
      setBusy(button, true);
      showPageError('');
      try {
        await api.post('/api/workbench/sales/payments', {
          salesEntryRecordId: order.record_id,
          method: $(panel, '[data-field="payment-method"]').value,
          amount: $(panel, '[data-field="payment-amount"]').value,
          requestId: crypto.randomUUID(),
        });
        state.operationMessage = '收款已记录，订单状态已刷新。';
        await loadOrders(order.record_id);
      } catch (error) { showPageError(describeError(error)); }
      finally { setBusy(button, false); }
    });
    $(panel, '[data-form="delivery"]').addEventListener('submit', async (event) => {
      event.preventDefault();
      const order = selectedOrder(state.container, state);
      const ids = [...panel.querySelectorAll('[data-view="delivery-details"] input:checked')].map((input) => input.value);
      if (!order || !ids.length) return showPageError('请选择销售单和待交付明细');
      if (!window.confirm('确认这些商品已实际交付？系统会优先扣门盒，门盒不足时再扣样品。')) return;
      const button = event.submitter;
      setBusy(button, true);
      showPageError('');
      try {
        const result = await api.post('/api/workbench/sales/deliveries', { salesEntryRecordId: order.record_id, detailRecordIds: ids });
        if (result.failures?.length) {
          const failed = result.failures.map((item) => `第${item.lineNumber || '?'}件 ${item.size || '-'}码：${item.error}`).join('；');
          state.operationMessage = `本单累计已交付 ${result.deliveredQuantity}/${result.totalQuantity} 双；以下仍未交付：${failed}`;
        } else {
          state.operationMessage = result.sampleReplacements?.length
            ? '交付已记录，库存已扣减；有样品售出，请查看机器人补选样品提醒。'
            : '交付已记录，库存已更新。';
        }
        await loadOrders(order.record_id);
      } catch (error) { showPageError(describeError(error)); }
      finally { setBusy(button, false); }
    });
  }

  return {
    mount(container) {
      state.container = container;
      renderShell(container, focused);
      if (!focused) {
        bindSubTabs(container, (subtab) => {
          state.activeSubtab = subtab;
          if (subtab === 'sales-followup' && !state.loadedFollowup) loadOrders();
        });
      }
      $(container, '[data-action="refresh"]').addEventListener('click', () => {
        if (state.activeSubtab === 'sales-followup') loadOrders($(container, '[data-field="order"]')?.value || '');
        else if (state.activeSubtab === 'sales-today') loadToday();
      });
      loadToday();
    },
  };
}
