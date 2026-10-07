import { api } from '../../core/api-client.js';
import { dateTime, escapeHtml, statusClass } from '../../core/formatters.js';
import { bindSubTabs, describeError, showPageError } from '../../core/ui.js';
import { PURCHASE_REQUEST_FORM_URL } from '../../config/links.js';

const FORMS = [
  { label: '货品上新', desc: '新增货品基础信息', url: 'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m', icon: '🏷️' },
  // 采购申请表单的链接统一从 config/links.js 取（配置先行：换链接只改那一个文件）。
  { label: '信息填写', desc: '提交采购申请或采购退货', url: PURCHASE_REQUEST_FORM_URL, icon: '📦' },
  // ⚠️ 2026-10-07 晚：原先这里还有一张「到货验收」表单卡（"登记到货与验收情况"）——
  //    那张**表已被业务负责人整个删除**（飞书里表一删，表单跟着不可用），
  //    而且新口径下到货不用表单登记：**在采购群那个话题里说一句**就行。
  //    ⇒ 这张卡删掉（留着一个打不开的表单链接比少一个入口更糟）。
];

const $ = (container, selector) => container.querySelector(selector);

function renderShell(container) {
  container.innerHTML = `
    <section class="panel">
      <div class="panel-header"><div><h2>采购管理</h2><p class="subtitle">报货信息与到货核对情况</p></div><button class="btn" type="button" data-action="refresh">刷新数据</button></div>
      <h3 class="section-title">快捷录入入口</h3>
      <div class="quick-entries">${FORMS.map((form) => `
        <a class="entry-card" href="${form.url}" target="_blank" rel="noopener noreferrer">
          <div class="icon">${form.icon}</div><h3>${form.label}</h3><p>${form.desc}</p><div class="arrow">去填写 →</div>
        </a>`).join('')}</div>
      <div class="sub-tabs">
        <button class="sub-tab active" type="button" data-subtab="purchase-request">报货信息情况</button>
        <button class="sub-tab" type="button" data-subtab="purchase-arrival">到货验收情况</button>
      </div>
      <div id="purchase-request-subpanel" class="sub-panel"><div class="section-loading">正在加载报货信息…</div></div>
      <div id="purchase-arrival-subpanel" class="sub-panel hidden"><div class="section-loading">打开后加载到货记录…</div></div>
      <!-- ⚠️ 2026-10-07 深夜：「采购入库」表已被业务负责人**整表删除** ⇒ 原「采购入库记录」
           这个子页**整个摘掉**。它本来就是一张"规划中"的占位卡（原文案：当前后端尚未提供
           采购入库查询接口），表没了以后它永远不会有用；留着只会让人以为还有这张表。
           到货信息现在看「到货验收情况」那一页（数据来自「报货批次」）。 -->
    </section>`;
}

function renderRequests(container, rows) {
  $(container, '#purchase-request-subpanel').innerHTML = `
    <div class="summary"><div class="metric"><span>当前查询记录</span><strong>${rows.length}</strong></div><div class="metric"><span>待到货</span><strong>${rows.filter((row) => row.arrival_status === '未到货').length}</strong></div></div>
    <div class="filters"><input data-filter="request-batch" placeholder="输入报货批次号"><select data-filter="request-status"><option value="">全部到货状态</option><option>未到货</option><option>部分到货</option><option>已全部到货</option></select><button class="btn btn-primary" type="button" data-search="requests">查询</button></div>
    <div class="table-wrap mobile-card-table"><table><thead><tr><th>报货批次号</th><th>货品编号</th><th>尺码</th><th>数量</th><th>到货状态</th><th>报单时间</th></tr></thead><tbody>${rows.map((row) => `<tr><td data-label="报货批次号"><span class="cell-value">${escapeHtml(row.batch_no || '-')}</span></td><td data-label="货品编号"><span class="cell-value">${escapeHtml(row.product_number || '-')}</span></td><td data-label="尺码"><span class="cell-value">${escapeHtml(row.size || '-')}</span></td><td data-label="数量"><span class="cell-value">${escapeHtml(row.quantity || 0)}</span></td><td data-label="到货状态"><span class="cell-value tag ${statusClass(row.arrival_status)}">${escapeHtml(row.arrival_status || '-')}</span></td><td data-label="报单时间"><span class="cell-value">${escapeHtml(dateTime(row.reported_at))}</span></td></tr>`).join('')}</tbody></table></div>
    ${rows.length ? '' : '<p class="empty">没有匹配的报货信息。</p>'}`;
}

function renderArrivals(container, rows) {
  // ⚠️ 2026-10-05：原先这里还有「识别状态」「失败原因」两列和「失败记录」指标——
  // 识别状态 / 识别失败原因两个字段已被业务负责人从生产表删除、拍照识别链路整体退场，
  // 接口也不再返回这两项。
  // ⚠️ 2026-10-07 晚：表改名「到货验收」（子标签跟着改），并且**「图片」整列被她删掉** ——
  // 原先这里还有一列「图片数」（读接口的 image_count）**一并删掉**。
  // ⭐ 2026-10-07 晚（到货落点大改）：**「到货验收」表已被她整个人删除**，
  //    到货信息（验收原话 / 确认状态）现在写在**「报货批次」那一行**上
  //    ⇒ 这个面板改读「报货批次」，列换成 报货批次号 / 到货状态 / 确认状态 / 验收原话。
  //    刻意**不再显示「到货日」**：批次行上那一列是飞书自动的「更新时间」，
  //    不是真的到货时刻（写附件等动作也会刷新它），拿它当"到货日"会误导。
  $(container, '#purchase-arrival-subpanel').innerHTML = `
    <div class="summary"><div class="metric"><span>当前查询记录</span><strong>${rows.length}</strong></div><div class="metric"><span>还没核对确认</span><strong>${rows.filter((row) => !row.confirm_status).length}</strong></div></div>
    <div class="filters"><input data-filter="arrival-batch" placeholder="输入报货批次号"><select data-filter="arrival-status"><option value="">全部确认状态</option><option>待确认</option><option>已确认</option><option>已入库</option><option>入库失败</option><option>已取消</option></select><button class="btn btn-primary" type="button" data-search="arrivals">查询</button></div>
    <div class="table-wrap mobile-card-table"><table><thead><tr><th>报货批次号</th><th>到货状态</th><th>确认状态</th><th>验收原话</th></tr></thead><tbody>${rows.map((row) => `<tr><td data-label="报货批次号"><span class="cell-value">${escapeHtml(row.batch_no || '-')}</span></td><td data-label="到货状态"><span class="cell-value tag ${statusClass(row.arrival_status)}">${escapeHtml(row.arrival_status || '-')}</span></td><td data-label="确认状态"><span class="cell-value tag ${statusClass(row.confirm_status)}">${escapeHtml(row.confirm_status || '-')}</span></td><td data-label="验收原话"><span class="cell-value">${escapeHtml(row.acceptance_text || '-')}</span></td></tr>`).join('')}</tbody></table></div>
    ${rows.length ? '' : '<p class="empty">没有匹配的到货验收记录。</p>'}`;
}

export function createPurchaseModule() {
  const state = { container: null, activeSubtab: 'purchase-request', requestsLoaded: false, arrivalsLoaded: false };

  async function loadRequests(filters = {}) {
    showPageError('');
    const params = new URLSearchParams();
    if (filters.batchNo) params.set('batchNo', filters.batchNo);
    if (filters.arrivalStatus) params.set('arrivalStatus', filters.arrivalStatus);
    try {
      const query = params.toString();
      const data = await api.get(`/api/workbench/purchase/requests${query ? `?${query}` : ''}`);
      state.requestsLoaded = true;
      renderRequests(state.container, data.rows || []);
      bindRequestFilters();
    } catch (error) { showPageError(describeError(error)); }
  }

  async function loadArrivals(filters = {}) {
    showPageError('');
    const params = new URLSearchParams();
    if (filters.batchNo) params.set('batchNo', filters.batchNo);
    if (filters.confirmStatus) params.set('confirmStatus', filters.confirmStatus);
    try {
      const query = params.toString();
      const data = await api.get(`/api/workbench/purchase/arrivals${query ? `?${query}` : ''}`);
      state.arrivalsLoaded = true;
      renderArrivals(state.container, data.rows || []);
      bindArrivalFilters();
    } catch (error) { showPageError(describeError(error)); }
  }

  function bindRequestFilters() {
    const panel = $(state.container, '#purchase-request-subpanel');
    const run = () => loadRequests({ batchNo: $(panel, '[data-filter="request-batch"]').value.trim(), arrivalStatus: $(panel, '[data-filter="request-status"]').value });
    $(panel, '[data-search="requests"]').addEventListener('click', run);
    $(panel, '[data-filter="request-batch"]').addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
  }

  function bindArrivalFilters() {
    const panel = $(state.container, '#purchase-arrival-subpanel');
    const run = () => loadArrivals({ batchNo: $(panel, '[data-filter="arrival-batch"]').value.trim(), confirmStatus: $(panel, '[data-filter="arrival-status"]').value });
    $(panel, '[data-search="arrivals"]').addEventListener('click', run);
    $(panel, '[data-filter="arrival-batch"]').addEventListener('keydown', (event) => { if (event.key === 'Enter') run(); });
  }

  return {
    mount(container) {
      state.container = container;
      renderShell(container);
      bindSubTabs(container, (subtab) => {
        state.activeSubtab = subtab;
        if (subtab === 'purchase-arrival' && !state.arrivalsLoaded) loadArrivals();
      });
      $(container, '[data-action="refresh"]').addEventListener('click', () => {
        if (state.activeSubtab === 'purchase-arrival') loadArrivals();
        else if (state.activeSubtab === 'purchase-request') loadRequests();
      });
      loadRequests();
    },
  };
}
