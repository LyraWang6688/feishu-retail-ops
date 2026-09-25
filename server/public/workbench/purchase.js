// 采购管理面板 — 独立模块，由集成负责人接入工作台 Tab
// 功能：三个飞书表单入口 + 采购申请只读进度 + 采购到货只读进度（含失败记录）

const PURCHASE_FORMS = [
  { key: 'product', label: '货品上新', desc: '新增货品信息到货品表', url: 'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m' },
  { key: 'report', label: '供应商报货', desc: '向供应商提交报货申请', url: 'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnn4f9ZJzpm7JbT2rCH247xc' },
  { key: 'arrival', label: '到货验收', desc: '到货后上传鞋盒图片触发识别', url: 'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnVzhSlH9tLIxMUSfVjwF1se' },
];

const p$ = (id) => document.getElementById(id);
const pHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pDateTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';

async function purchaseGetJson(path) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(`${path}${separator}_=${Date.now()}`, { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

function renderFormEntries(container) {
  const grid = document.createElement('div');
  grid.className = 'purchase-form-grid';
  for (const form of PURCHASE_FORMS) {
    const card = document.createElement('a');
    card.className = 'purchase-form-card';
    card.href = form.url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    const title = document.createElement('strong');
    title.textContent = form.label;
    const desc = document.createElement('span');
    desc.className = 'muted';
    desc.textContent = form.desc;
    const arrow = document.createElement('span');
    arrow.className = 'purchase-form-arrow';
    arrow.textContent = '→';
    card.append(title, desc, arrow);
    grid.append(card);
  }
  container.append(grid);
}

function renderRequestTable(container, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>报货批次号</th><th>货品编号</th><th>尺码</th><th>数量</th><th>到货状态</th><th>报单时间</th></tr></thead>';
  const tbody = document.createElement('tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无采购申请记录</td></tr>';
  } else {
    for (const row of rows) {
      const tr = document.createElement('tr');
      const statusClass = row.arrival_status === '未到货' ? 'status-pending'
        : row.arrival_status === '部分到货' ? 'status-partial'
        : row.arrival_status === '全部到货' ? 'status-done' : '';
      tr.innerHTML = `
        <td>${pHtml(row.batch_no)}</td>
        <td>${pHtml(row.product_number || row.product_record_id)}</td>
        <td>${row.size}</td>
        <td class="quantity">${row.quantity}</td>
        <td><span class="status-badge ${statusClass}">${pHtml(row.arrival_status || '-')}</span></td>
        <td>${pDateTime(row.reported_at)}</td>`;
      tbody.append(tr);
    }
  }
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
}

function renderArrivalTable(container, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>报货批次号</th><th>到货日</th><th>识别状态</th><th>确认状态</th><th>图片数</th><th>失败原因</th></tr></thead>';
  const tbody = document.createElement('tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">暂无采购到货记录</td></tr>';
  } else {
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.recognition_status === '识别失败' || row.confirm_status === '入库失败') {
        tr.className = 'row-failed';
      }
      const recClass = row.recognition_status === '识别成功' ? 'status-done'
        : row.recognition_status === '识别失败' ? 'status-failed' : 'status-pending';
      const confClass = row.confirm_status === '已确认' || row.confirm_status === '已入库' ? 'status-done'
        : row.confirm_status === '已取消' ? 'status-failed' : 'status-pending';
      tr.innerHTML = `
        <td>${pHtml(row.batch_no || row.batch_record_id)}</td>
        <td>${pDateTime(row.arrival_at)}</td>
        <td><span class="status-badge ${recClass}">${pHtml(row.recognition_status || '-')}</span></td>
        <td><span class="status-badge ${confClass}">${pHtml(row.confirm_status || '-')}</span></td>
        <td>${row.image_count}</td>
        <td class="failure-reason">${pHtml(row.failure_reason || '-')}</td>`;
      tbody.append(tr);
    }
  }
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
}

function initPurchasePanel(panelElement) {
  if (!panelElement) return;
  panelElement.innerHTML = '';

  // 表单入口区
  const formSection = document.createElement('div');
  formSection.className = 'purchase-section';
  const formTitle = document.createElement('h2');
  formTitle.textContent = '采购录入入口';
  const formHint = document.createElement('p');
  formHint.className = 'muted';
  formHint.textContent = '点击按钮在新标签页打开飞书表单；到货验收提交后自动触发图片识别与确认流程。';
  formSection.append(formTitle, formHint);
  renderFormEntries(formSection);
  panelElement.append(formSection);

  // 采购申请进度区
  const requestSection = document.createElement('div');
  requestSection.className = 'purchase-section';
  const requestHeader = document.createElement('div');
  requestHeader.className = 'toolbar';
  const requestTitleWrap = document.createElement('div');
  const requestTitle = document.createElement('h2');
  requestTitle.textContent = '采购申请进度';
  const requestHint = document.createElement('p');
  requestHint.className = 'muted';
  requestHint.textContent = '只读查询，展示报单生成的采购申请及到货状态。';
  requestTitleWrap.append(requestTitle, requestHint);
  const requestFilters = document.createElement('div');
  requestFilters.className = 'filters';
  requestFilters.style.margin = '0';
  const batchInput = document.createElement('input');
  batchInput.id = 'purchase-request-batch';
  batchInput.placeholder = '按批次号筛选';
  const statusSelect = document.createElement('select');
  statusSelect.id = 'purchase-request-status';
  statusSelect.innerHTML = '<option value="">全部到货状态</option><option value="未到货">未到货</option><option value="部分到货">部分到货</option><option value="全部到货">全部到货</option><option value="超额到货">超额到货</option>';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = '刷新';
  requestFilters.append(batchInput, statusSelect, refreshBtn);
  requestHeader.append(requestTitleWrap, requestFilters);
  const requestBody = document.createElement('div');
  requestBody.id = 'purchase-request-body';
  requestSection.append(requestHeader, requestBody);
  panelElement.append(requestSection);

  // 采购到货进度区
  const arrivalSection = document.createElement('div');
  arrivalSection.className = 'purchase-section';
  const arrivalHeader = document.createElement('div');
  arrivalHeader.className = 'toolbar';
  const arrivalTitleWrap = document.createElement('div');
  const arrivalTitle = document.createElement('h2');
  arrivalTitle.textContent = '采购到货进度';
  const arrivalHint = document.createElement('p');
  arrivalHint.className = 'muted';
  arrivalHint.textContent = '只读查询，展示到货验收记录及识别/确认状态；识别失败的记录高亮显示。';
  arrivalTitleWrap.append(arrivalTitle, arrivalHint);
  const arrivalFilters = document.createElement('div');
  arrivalFilters.className = 'filters';
  arrivalFilters.style.margin = '0';
  const arrivalBatchInput = document.createElement('input');
  arrivalBatchInput.id = 'purchase-arrival-batch';
  arrivalBatchInput.placeholder = '按批次号筛选';
  const arrivalConfirmSelect = document.createElement('select');
  arrivalConfirmSelect.id = 'purchase-arrival-confirm';
  arrivalConfirmSelect.innerHTML = '<option value="">全部确认状态</option><option value="待确认">待确认</option><option value="已确认">已确认</option><option value="已取消">已取消</option><option value="入库失败">入库失败</option>';
  const arrivalRefreshBtn = document.createElement('button');
  arrivalRefreshBtn.type = 'button';
  arrivalRefreshBtn.textContent = '刷新';
  arrivalFilters.append(arrivalBatchInput, arrivalConfirmSelect, arrivalRefreshBtn);
  arrivalHeader.append(arrivalTitleWrap, arrivalFilters);
  const arrivalBody = document.createElement('div');
  arrivalBody.id = 'purchase-arrival-body';
  arrivalSection.append(arrivalHeader, arrivalBody);
  panelElement.append(arrivalSection);

  // 错误提示
  const errorEl = document.createElement('p');
  errorEl.id = 'purchase-error';
  errorEl.className = 'error hidden';
  panelElement.append(errorEl);

  const showError = (msg) => { errorEl.textContent = msg; errorEl.classList.toggle('hidden', !msg); };

  async function loadRequests() {
    showError('');
    const body = p$('purchase-request-body');
    body.innerHTML = '<p class="empty">加载中…</p>';
    try {
      const params = new URLSearchParams();
      if (batchInput.value.trim()) params.set('batchNo', batchInput.value.trim());
      if (statusSelect.value) params.set('arrivalStatus', statusSelect.value);
      const qs = params.toString();
      const data = await purchaseGetJson(`/api/workbench/purchase/requests${qs ? `?${qs}` : ''}`);
      body.innerHTML = '';
      renderRequestTable(body, data.rows || []);
    } catch (error) {
      body.innerHTML = '';
      showError(`加载采购申请失败：${error.message}`);
    }
  }

  async function loadArrivals() {
    showError('');
    const body = p$('purchase-arrival-body');
    body.innerHTML = '<p class="empty">加载中…</p>';
    try {
      const params = new URLSearchParams();
      if (arrivalBatchInput.value.trim()) params.set('batchNo', arrivalBatchInput.value.trim());
      if (arrivalConfirmSelect.value) params.set('confirmStatus', arrivalConfirmSelect.value);
      const qs = params.toString();
      const data = await purchaseGetJson(`/api/workbench/purchase/arrivals${qs ? `?${qs}` : ''}`);
      body.innerHTML = '';
      renderArrivalTable(body, data.rows || []);
    } catch (error) {
      body.innerHTML = '';
      showError(`加载采购到货失败：${error.message}`);
    }
  }

  refreshBtn.addEventListener('click', loadRequests);
  batchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRequests(); });
  statusSelect.addEventListener('change', loadRequests);
  arrivalRefreshBtn.addEventListener('click', loadArrivals);
  arrivalBatchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadArrivals(); });
  arrivalConfirmSelect.addEventListener('change', loadArrivals);

  loadRequests();
  loadArrivals();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { initPurchasePanel, PURCHASE_FORMS };
}
