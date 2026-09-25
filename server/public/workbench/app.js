const $ = (id) => document.getElementById(id);
const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const showError = (message = '') => { $('error').textContent = message; $('error').classList.toggle('hidden', !message); };
const headers = () => ({});

async function getJson(path) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${path}${separator}_=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

async function postJson(path, body) {
  const response = await fetch(path, { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) throw new Error(result.error || `请求失败（${response.status}）`);
  return result;
}

let salesOrders = [];

function renderSelectedOrder() {
  const order = salesOrders.find((item) => item.record_id === $('followup-order').value);
  $('order-details').textContent = order
    ? `履约：${order.fulfillment_status}；已记录收款 ${order.payments.length} 笔`
    : '请选择销售单';
  $('delivery-details').replaceChildren();
  for (const detail of order?.details || []) {
    const label = document.createElement('label');
    label.className = 'delivery-option';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = detail.record_id;
    input.disabled = detail.delivered_quantity >= detail.quantity;
    label.append(input, document.createTextNode(`${detail.product || detail.record_id}｜${detail.size}码 × ${detail.quantity}${input.disabled ? '（已交付）' : ''}`));
    $('delivery-details').append(label);
  }
}

async function loadOrders(selectedId = '') {
  showError('');
  try {
    const result = await getJson('/api/workbench/sales/orders');
    salesOrders = result.orders || [];
    const orderSelect = $('followup-order');
    orderSelect.replaceChildren();
    for (const order of salesOrders) orderSelect.add(new Option(order.order_no, order.record_id));
    if (selectedId && salesOrders.some((order) => order.record_id === selectedId)) orderSelect.value = selectedId;
    const methodSelect = $('payment-method');
    methodSelect.replaceChildren();
    for (const method of result.methods || []) methodSelect.add(new Option(method, method));
    renderSelectedOrder();
  } catch (error) { showError(error.message); }
}

function renderSales(data) {
  const summary = data.summary || {};
  $('sales-date').textContent = `日期：${data.date || '-'}`;
  $('sales-summary').innerHTML = [
    ['销售笔数', summary.order_count || 0], ['销售明细', summary.detail_count || 0],
    ['销售数量', summary.quantity || 0], ['明细应收合计', summary.receivable_amount === null ? '待公式计算' : money(summary.receivable_amount)],
    ['这些订单累计已收', money(summary.paid_amount)],
  ].map(([label, value]) => `<div class="metric"><span>${html(label)}</span><strong>${html(value)}</strong></div>`).join('');
  $('sales-rows').innerHTML = (data.rows || []).map((row) => `<tr>${[
    dateTime(row.sold_at), row.sales_behavior || '-', row.product_number || '-', row.size || '-',
    row.quantity, row.receivable_amount === null ? '待公式计算' : money(row.receivable_amount),
    row.payment_method || '-', row.gift || '-', row.sales_order_no || '-',
  ].map((value) => `<td>${html(value)}</td>`).join('')}</tr>`).join('');
  $('sales-empty').classList.toggle('hidden', Boolean(data.rows?.length));
}

function renderInventory(data) {
  const duplicate = data.duplicate_stock_keys || [];
  $('inventory-warning').textContent = duplicate.length ? `提示：发现重复库存键 ${duplicate.length} 个，请在多维表格中检查唯一性。` : '';
  $('inventory-warning').classList.toggle('hidden', !duplicate.length);
  $('inventory-rows').innerHTML = (data.rows || []).map((row) => `<tr>${[
    row.stock_key || '-', row.product_number || '-', row.item_no || '-', row.color || '-',
    row.size || '-', row.state || '-', row.quantity, dateTime(row.updated_at),
  ].map((value, index) => `<td${index === 6 ? ' class="quantity"' : ''}>${html(value)}</td>`).join('')}</tr>`).join('');
  $('inventory-empty').classList.toggle('hidden', Boolean(data.rows?.length));
}

async function loadSales() { showError(''); try { renderSales(await getJson('/api/workbench/sales/today')); } catch (error) { showError(error.message); } }
async function loadInventory() { showError(''); try { renderInventory(await getJson(`/api/workbench/inventory?keyword=${encodeURIComponent($('inventory-keyword').value)}&size=${encodeURIComponent($('inventory-size').value)}`)); } catch (error) { showError(error.message); } }

async function initAuth() {
  const response = await fetch(`/api/auth/feishu/me?_=${Date.now()}`, { credentials: 'include', cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!body.enabled) {
    showError('飞书身份认证尚未启用，请联系管理员');
    return false;
  }
  if (body.enabled && !body.authenticated) {
    window.location.href = `/api/auth/feishu/start?return_to=${encodeURIComponent(location.pathname + location.search)}`;
    return false;
  }
  if (body.enabled && body.authenticated) {
    $('auth-status').textContent = `已登录：${body.user?.name || '飞书用户'}`;
    $('logout').classList.remove('hidden');
  }
  return true;
}

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
  $('sales-panel').classList.toggle('hidden', button.dataset.tab !== 'sales');
  $('inventory-panel').classList.toggle('hidden', button.dataset.tab !== 'inventory');
  $('followup-panel').classList.toggle('hidden', button.dataset.tab !== 'followup');
  if (button.dataset.tab === 'inventory' && !$('inventory-rows').children.length) loadInventory();
  if (button.dataset.tab === 'followup') loadOrders();
}));
$('followup-order').addEventListener('change', renderSelectedOrder);
$('refresh-orders').addEventListener('click', () => loadOrders($('followup-order').value));
$('payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const orderId = $('followup-order').value;
  if (!orderId) return showError('请选择销售单');
  const button = event.submitter;
  button.disabled = true;
  showError('');
  try {
    const requestId = crypto.randomUUID();
    await postJson('/api/workbench/sales/payments', {
      salesEntryRecordId: orderId, method: $('payment-method').value,
      amount: $('payment-amount').value, requestId,
    });
    $('followup-result').textContent = '收款记录已新增';
    $('payment-amount').value = '';
    await loadOrders(orderId);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
});
$('delivery-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const orderId = $('followup-order').value;
  const detailRecordIds = [...$('delivery-details').querySelectorAll('input:checked')].map((item) => item.value);
  if (!orderId || !detailRecordIds.length) return showError('请先选择销售单和待交付明细');
  if (!window.confirm('确认这些商品已实际交付？确认后将扣减对应状态的库存。')) return;
  const button = event.submitter;
  button.disabled = true;
  showError('');
  try {
    await postJson('/api/workbench/sales/deliveries', {
      salesEntryRecordId: orderId, detailRecordIds, state: $('delivery-state').value,
    });
    $('followup-result').textContent = '交付已记录，库存已更新';
    await loadOrders(orderId);
  } catch (error) { showError(error.message); }
  finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => { await fetch('/api/auth/feishu/logout', { method: 'POST', credentials: 'include' }); window.location.reload(); });
$('refresh-sales').addEventListener('click', loadSales);
$('refresh-inventory').addEventListener('click', loadInventory);
$('search-inventory').addEventListener('click', loadInventory);
$('inventory-keyword').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadInventory(); });
initAuth().then((ready) => { if (ready) loadSales(); }).catch((error) => showError(`登录状态检查失败：${error.message}`));
