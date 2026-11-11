/**
 * 库存 → 手工调整（2026-11-11 前端替换版）。
 *
 * 两张入口卡：
 *   · 单双调整：直接调库存扫一扫 → 可编辑库存页
 *   · 批量调整：当季 / 库存（检查当季鞋的样品数量）
 *
 * ⚠️ 本版只做前端替换：保存、批量写接口尚未接入，相关按钮禁用并标明原因，
 *    不留"点了没反应"的死按钮。
 */
import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { describeError, showPageError } from '../../core/ui.js';
import { showToast } from '../shared/toast.js';
import { scanCodeRaw, scanTargetUrl } from '../scan/launch.js';
import { INVENTORY_MANUAL_CARDS, INVENTORY_MANUAL_TEXTS } from '../../config/inventoryAdjustment.js';

const $ = (host, selector) => host.querySelector(selector);
const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const STATES = ['门盒', '样品'];

const cardsHtml = () => `<div class="domain-cards domain-cards-single">${INVENTORY_MANUAL_CARDS.map((card) => `
  <button class="entry-card" type="button" data-manual="${card.id}"><span class="icon">${escapeHtml(card.icon)}</span><h3>${escapeHtml(card.label)}</h3></button>`).join('')}</div>`;

export function createInventoryAdjustmentModule() {
  const state = { host: null, rows: [], categories: [], view: 'cards', productId: '', editorRows: [], pendingRequest: null, savedNumber: '', inventoryJobId: '' };

  async function loadRows(force = false) {
    if (state.rows.length && !force) return state.rows;
    const data = await api.get('/api/workbench/inventory');
    state.rows = Array.isArray(data.rows) ? data.rows : [];
    return state.rows;
  }

  function show(view) {
    state.view = view;
    const host = state.host;
    $(host, '[data-manual="cards"]')?.classList.toggle('hidden', view !== 'cards');
    $(host, '[data-view="manual-single"]')?.classList.toggle('hidden', view !== 'single');
    $(host, '[data-view="manual-batch"]')?.classList.toggle('hidden', view !== 'batch');
  }

  function productRows(productId) {
    return state.rows.filter((row) => row.product_record_id === productId);
  }

  function renderEditor() {
    const first = state.editorRows[0] || {};
    const label = [first.product_number, first.color, first.category].filter(Boolean).join('｜') || state.productId;
    const host = state.host;
    const body = $(host, '[data-view="single-rows"]');
    body.innerHTML = state.editorRows.length ? state.editorRows.map((row, index) => `
      <div class="edit-row">
        <input data-row="${index}" data-k="size" value="${escapeHtml(row.size ?? '')}" inputmode="numeric" aria-label="尺码">
        <select data-row="${index}" data-k="state" aria-label="所属状态">${STATES.map((s) => `<option ${row.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <input data-row="${index}" data-k="quantity" value="${escapeHtml(row.quantity ?? 1)}" type="number" min="0" inputmode="numeric" aria-label="数量">
        <button class="del" type="button" data-remove="${index}">删</button>
      </div>`).join('') : '<p class="empty compact">这个编号暂时没有实时库存。</p>';
    $(host, '[data-view="single-label"]').textContent = label;
    $(host, '[data-view="single-note"]').textContent = '';
    body.querySelectorAll('[data-row]').forEach((el) => el.addEventListener('input', () => {
      state.editorRows[Number(el.dataset.row)][el.dataset.k] = el.value;
    }));
    body.querySelectorAll('[data-remove]').forEach((btn) => btn.addEventListener('click', () => {
      state.editorRows.splice(Number(btn.dataset.remove), 1);
      renderEditor();
    }));
    show('single');
  }

  function renderSingle(productId) {
    state.productId = productId;
    state.editorRows = productRows(productId).map((row) => ({ ...row }));
    renderEditor();
  }

  function fitRowsForProduct(productId) {
    const rows = productRows(productId);
    if (!rows.length) {
      showPageError('这个编号没有实时库存，不能调整。');
      return;
    }
    showPageError('');
    renderSingle(productId);
  }

  async function scanSingle() {
    showPageError('');
    try {
      const scanned = await scanCodeRaw('inventory');
      const target = scanTargetUrl(scanned, 'inventory');
      const match = String(target || '').match(/\/r\/([^/?#]+)/);
      if (!match) return showPageError('没有认出货品编号，请重新扫码。');
      await loadRows();
      fitRowsForProduct(decodeURIComponent(match[1]));
    } catch (error) {
      const message = String(error?.message || '');
      if (/cancel/i.test(message)) return;
      showPageError(message === 'jssdk_missing' ? '当前设备调不起飞书扫一扫，请在飞书里打开工作台。' : '扫码没有成功，请再试一次。');
    }
  }

  function violations() {
    // 状态调整与当季调整相互独立：不看品类，也不看当季。
    //    判据 = 同一个编号没有一双样品，其余是门盒。
    const groups = new Map();
    for (const row of state.rows) {
      const key = row.product_record_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return [...groups.entries()].map(([productId, items]) => {
      const samples = items.filter((row) => row.state === '样品');
      const doorbox = items.filter((row) => row.state === '门盒');
      const sampleCount = samples.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
      const doorboxCount = doorbox.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
      const emptyCount = items.filter((row) => !['门盒', '样品'].includes(row.state)).length;
      const issueKey = emptyCount > 0
        ? 'empty'
        : (sampleCount === 0 ? 'missing'
          : (sampleCount > 1 ? 'extra' : ''));
      const issue = issueKey === 'empty'
        ? INVENTORY_MANUAL_TEXTS.statusIssueEmpty
        : (issueKey === 'missing'
          ? INVENTORY_MANUAL_TEXTS.statusIssueMissing
          : (issueKey === 'extra'
            ? fill(INVENTORY_MANUAL_TEXTS.statusIssueExtra, { count: sampleCount - 1 }) : ''));
      return { productId, items, samples, doorbox, sampleCount, doorboxCount, emptyCount, issueKey, issue };
    }).filter((group) => group.issueKey);
  }

  function renderViolations() {
    const box = $(state.host, '[data-view="batch-violations"]');
    const filter = $(state.host, '[data-field="status-filter"]')?.value || 'all';
    const list = violations().filter((group) => filter === 'all' || group.issueKey === filter);
    if (!list.length) {
      box.innerHTML = '<p class="empty compact">当前没有不符合规则的状态。</p>';
      return;
    }
    const groups = ['extra', 'empty', 'missing']
      .map((key) => ({ key, items: list.filter((group) => group.issueKey === key) }))
      .filter((group) => group.items.length);
    box.innerHTML = groups.map((group) => {
      const title = group.items[0]?.issue || '';
      const cards = group.items.map((item) => {
        const first = item.items[0] || {};
        const label = [first.product_number, first.color].filter(Boolean).join('｜') || item.productId;
        const candidates = item.doorbox.map((row) => `${row.size}码`).join('、');
        return `<div class="row-card violation-card"><div class="violation-info">
          <div class="row-top"><div class="row-num">${escapeHtml(label)}</div><span class="tag bad">${escapeHtml(item.issue)}</span></div>
          <div class="row-line">当前：样品 ${item.sampleCount} 双｜门盒 ${item.doorboxCount} 双${item.sampleCount === 0 && candidates ? `；候选：${escapeHtml(candidates)}` : ''}</div>
        </div><button class="btn small primary" type="button" data-fix="${escapeHtml(item.productId)}">调整</button></div>`;
      }).join('');
      return `<section class="violation-group" data-issue="${escapeHtml(group.key)}"><h4 class="violation-group-title">${escapeHtml(title)} <span>${escapeHtml(fill(INVENTORY_MANUAL_TEXTS.statusGroupCount, { count: group.items.length }))}</span></h4><div class="violation-list">${cards}</div></section>`;
    }).join('');
    box.querySelectorAll('[data-fix]').forEach((btn) => btn.addEventListener('click', () => fitRowsForProduct(btn.dataset.fix)));
  }

  async function enterBatch() {
    const host = state.host;
    const select = $(host, '[data-field="batch-category"]');
    showToast(INVENTORY_MANUAL_TEXTS.batchLoading, { sticky: true });
    try {
      // 品类与库存并行：品类短请求不再串行挡住 1335 行的库存读取。
      const categoriesPromise = state.categories.length
        ? Promise.resolve(null)
        : api.get('/api/workbench/inventory/categories');
      const [data] = await Promise.all([categoriesPromise, loadRows()]);
      if (data) {
        state.categories = Array.isArray(data.rows) ? data.rows : [];
        select.innerHTML = state.categories.map((row) => `<option value="${escapeHtml(row.category)}">${escapeHtml(row.category)}</option>`).join('');
      }
      renderViolations();
      show('batch');
    } catch (error) {
      showPageError(describeError(error));
    }
  }


  async function savePairs() {
    const first = state.editorRows[0] || {};
    const rows = state.editorRows
      .filter((row) => Number(row.quantity) > 0)
      .map((row) => ({ size: Number(row.size), state: String(row.state || ''), quantity: Number(row.quantity) }));
    if (!rows.length) return showPageError('请至少保留一行数量大于 0 的库存');
    state.pendingRequest = state.pendingRequest || crypto.randomUUID();
    try {
      const result = await api.post('/api/workbench/inventory/adjustments/pairs', {
        productRecordId: state.productId, rows, requestId: state.pendingRequest,
      });
      state.pendingRequest = null;
      state.savedNumber = first.product_number || '';
      state.inventoryJobId = String(result?.job_id || '').trim();
      state.rows = [];
      showToast('已提交，后台写入库存');
      $(state.host, '[data-view="print-modal"]').hidden = false;
    } catch (error) {
      showPageError(describeError(error));
    }
  }

  async function waitForInventoryJob(jobId) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const payload = await api.get(`/api/workbench/async-jobs/${encodeURIComponent(jobId)}`);
      const job = payload?.job || payload;
      if (job?.status === 'succeeded') return job;
      if (job?.status === 'failed' || job?.status === 'partial_failed') {
        throw new Error(job.last_error || job.error || '库存调整失败');
      }
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
    }
    throw new Error(INVENTORY_MANUAL_TEXTS.inventoryJobTimeout);
  }

  async function printSaved(yes) {
    $(state.host, '[data-view="print-modal"]').hidden = true;
    if (!yes) {
      window.location.assign(`/workbench/?toast=${encodeURIComponent(INVENTORY_MANUAL_TEXTS.submittedToast)}`);
      return;
    }
    showToast(INVENTORY_MANUAL_TEXTS.printWaiting, { sticky: true });
    try {
      if (!state.inventoryJobId) throw new Error(INVENTORY_MANUAL_TEXTS.inventoryJobTimeout);
      await waitForInventoryJob(state.inventoryJobId);
      const result = await api.post('/api/workbench/label-print/jobs', {
        mode: 'single',
        number: state.savedNumber,
        submit_key: state.pendingRequest || crypto.randomUUID(),
      });
      const printJobId = String(result?.job_id || '').trim();
      if (!printJobId) throw new Error(INVENTORY_MANUAL_TEXTS.printJobMissing);
      window.location.assign(`/workbench/label-print.html?scan=1&print_job=${encodeURIComponent(printJobId)}`);
    } catch (error) {
      showPageError(describeError(error));
    }
  }

  async function setSeason(season) {
    const category = $(state.host, '[data-field="batch-category"]')?.value || '';
    if (!category) return showPageError('请先选择品类');
    try {
      await api.post('/api/workbench/inventory/adjustments/season-flag', {
        category, season, requestId: crypto.randomUUID(),
      });
      state.rows = [];
      await loadRows(true);
      renderViolations();
      showToast(season ? '已提交，后台设为当季' : '已提交，后台入库');
    } catch (error) { showPageError(describeError(error)); }
  }

  return {
    mount(host) {
      state.host = host;
      host.innerHTML = `<div data-manual="cards">${cardsHtml()}</div>
        <div data-view="manual-single" class="hidden">
          <div class="page-head"><button class="back" type="button" data-back>‹ 返回</button><h2>单双调整</h2></div>
          <div class="row-card"><div class="row-top"><div class="row-num" data-view="single-label"></div><span class="tag season">编辑中</span></div>
            <div data-view="single-rows" style="margin-top:10px"></div>
            <button class="btn small" type="button" data-add-size style="margin-top:8px">＋ 添加尺码</button>
            <p class="hint" data-view="single-note"></p>
            <div class="row-actions"><button class="btn primary" type="button" data-save>保存库存调整</button><button class="btn" type="button" data-back>取消</button></div>
          </div>
        </div>
        <div data-view="manual-batch" class="hidden">
          <div class="page-head"><button class="back" type="button" data-back>‹ 返回</button><h2>批量调整</h2></div>
          <div class="batch-section"><h3>当季调整</h3>
            <label class="field"><select data-field="batch-category"></select></label>
            <div class="row-actions"><button class="btn small primary" type="button" data-action="season-set" data-season="true">当季</button><button class="btn small" type="button" data-action="season-set" data-season="false">库存</button></div>
          </div>
          <div class="batch-section"><h3>状态调整</h3>
            <label class="field"><select data-field="status-filter" aria-label="${escapeHtml(INVENTORY_MANUAL_TEXTS.statusFilterLabel)}"><option value="all">${escapeHtml(INVENTORY_MANUAL_TEXTS.statusFilterAll)}</option><option value="extra">${escapeHtml(INVENTORY_MANUAL_TEXTS.statusIssueExtraGroup)}</option><option value="empty">${escapeHtml(INVENTORY_MANUAL_TEXTS.statusIssueEmpty)}</option><option value="missing">${escapeHtml(INVENTORY_MANUAL_TEXTS.statusIssueMissing)}</option></select></label>
            <div data-view="batch-violations"></div></div>
        </div>
        <div class="manual-modal" data-view="print-modal" hidden>
          <div class="manual-modal-card"><h3>是否需要打印？</h3><p class="hint">库存调整已保存，可以继续打印这一款标签。</p>
            <div class="row-actions"><button class="btn" type="button" data-print="no">不打印</button><button class="btn primary" type="button" data-print="yes">打印</button></div>
          </div>
        </div>`;
      host.querySelectorAll('[data-back]').forEach((btn) => btn.addEventListener('click', () => show('cards')));
      host.querySelector('[data-manual="single"]').addEventListener('click', () => { void scanSingle(); });
      host.querySelector('[data-manual="batch"]').addEventListener('click', () => { void enterBatch().catch((error) => showPageError(describeError(error))); });
      host.querySelector('[data-add-size]').addEventListener('click', () => { state.editorRows.push({ size: '', state: '门盒', quantity: 1 }); renderEditor(); });
      host.querySelector('[data-save]').addEventListener('click', () => { void savePairs(); });
      host.querySelectorAll('[data-action="season-set"]').forEach((btn) => btn.addEventListener('click', () => {
        void setSeason(btn.dataset.season === 'true');
      }));
      host.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => { void printSaved(btn.dataset.print === 'yes'); }));
      host.querySelector('[data-field="batch-category"]').addEventListener('change', () => renderViolations());
      host.querySelector('[data-field="status-filter"]')?.addEventListener('change', () => renderViolations());
    },
  };
}
