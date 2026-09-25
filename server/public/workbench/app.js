const $ = (id) => document.getElementById(id);
const tokenKey = 'feishu-workbench-token';
const money = (value) => `¥${Number(value || 0).toFixed(2)}`;
const dateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
const showError = (message = '') => { $('error').textContent = message; $('error').classList.toggle('hidden', !message); };
const headers = () => { const token = sessionStorage.getItem(tokenKey); return token ? { 'X-Workbench-Token': token } : {}; };

async function getJson(path) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${path}${separator}_=${Date.now()}`, { headers: headers(), cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

function renderSales(data) {
  const summary = data.summary || {};
  $('sales-date').textContent = `日期：${data.date || '-'}`;
  $('sales-summary').innerHTML = [
    ['销售笔数', summary.order_count || 0], ['销售明细', summary.detail_count || 0], ['销售数量', summary.quantity || 0], ['实收金额', money(summary.paid_amount)],
  ].map(([label, value]) => `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`).join('');
  $('sales-rows').innerHTML = (data.rows || []).map((row) => `<tr><td>${dateTime(row.sold_at)}</td><td>${row.sales_behavior || '-'}</td><td>${row.product_number || '-'}</td><td>${row.size || '-'}</td><td>${row.quantity}</td><td>${money(row.paid_amount)}</td><td>${row.payment_method || '-'}</td><td>${row.gift || '-'}</td><td>${row.sales_order_no || '-'}</td></tr>`).join('');
  $('sales-empty').classList.toggle('hidden', Boolean(data.rows?.length));
}

function renderInventory(data) {
  const duplicate = data.duplicate_stock_keys || [];
  $('inventory-warning').textContent = duplicate.length ? `提示：发现重复库存键 ${duplicate.length} 个，请在多维表格中检查唯一性。` : '';
  $('inventory-warning').classList.toggle('hidden', !duplicate.length);
  $('inventory-rows').innerHTML = (data.rows || []).map((row) => `<tr><td>${row.stock_key || '-'}</td><td>${row.product_number || '-'}</td><td>${row.item_no || '-'}</td><td>${row.color || '-'}</td><td>${row.size || '-'}</td><td class="quantity">${row.quantity}</td><td>${dateTime(row.updated_at)}</td></tr>`).join('');
  $('inventory-empty').classList.toggle('hidden', Boolean(data.rows?.length));
}

async function loadSales() { showError(''); try { renderSales(await getJson('/api/workbench/sales/today')); } catch (error) { showError(error.message); } }
async function loadInventory() { showError(''); try { renderInventory(await getJson(`/api/workbench/inventory?keyword=${encodeURIComponent($('inventory-keyword').value)}&size=${encodeURIComponent($('inventory-size').value)}`)); } catch (error) { showError(error.message); } }

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((item) => item.classList.toggle('active', item === button));
  $('sales-panel').classList.toggle('hidden', button.dataset.tab !== 'sales');
  $('inventory-panel').classList.toggle('hidden', button.dataset.tab !== 'inventory');
  if (button.dataset.tab === 'inventory' && !$('inventory-rows').children.length) loadInventory();
}));
$('save-token').addEventListener('click', () => { sessionStorage.setItem(tokenKey, $('token').value.trim()); loadSales(); });
$('refresh-sales').addEventListener('click', loadSales);
$('refresh-inventory').addEventListener('click', loadInventory);
$('search-inventory').addEventListener('click', loadInventory);
$('inventory-keyword').addEventListener('keydown', (event) => { if (event.key === 'Enter') loadInventory(); });
$('token').value = sessionStorage.getItem(tokenKey) || '';
loadSales();
