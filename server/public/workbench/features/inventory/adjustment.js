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

const cardsHtml = (expandedSingle = false) => `<div class="domain-cards domain-cards-single">${INVENTORY_MANUAL_CARDS.map((card) => {
  if (card.id === 'single' && expandedSingle) {
    return `<div class="candidate-card-actions" role="group" aria-label="${escapeHtml(card.label)}">
      <button class="candidate-action" type="button" data-single-action="scan">${escapeHtml(INVENTORY_MANUAL_TEXTS.singleScan)}</button>
      <button class="candidate-action" type="button" data-single-action="input">${escapeHtml(INVENTORY_MANUAL_TEXTS.singleInput)}</button>
    </div>`;
  }
  return `<button class="entry-card" type="button" data-manual="${card.id}"><span class="icon">${escapeHtml(card.icon)}</span><h3>${escapeHtml(card.label)}</h3></button>`;
}).join('')}</div>`;

export function createInventoryAdjustmentModule() {
  const state = { host: null, rows: [], categories: [], view: 'cards', productId: '', editorRows: [], pendingRequest: null, inventoryJobId: '', productInfo: null, singleExpanded: false };

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
    $(host, '[data-view="manual-picker"]')?.classList.toggle('hidden', view !== 'picker');
  }

  function renderCards() {
    const box = $(state.host, '[data-manual="cards"]');
    if (box) box.innerHTML = cardsHtml(state.singleExpanded);
  }

  function resetSingleEntry() {
    state.singleExpanded = false;
    renderCards();
  }

  function productRows(productId) {
    return state.rows.filter((row) => row.product_record_id === productId);
  }

  function renderEditor() {
    const first = state.editorRows[0] || {};
    const info = state.productInfo || {};
    const label = [first.product_number || info.number, first.color || info.color, first.category || info.category]
      .filter(Boolean).join('｜') || state.productId;
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
    // 无库存也要进编辑器：显示「＋ 添加尺码」，从空白开始建库存。
    showPageError('');
    renderSingle(productId);
  }

  async function loadProductInfo(productId) {
    try {
      const data = await api.get(`/api/workbench/products/${encodeURIComponent(productId)}`);
      state.productInfo = data?.item || null;
    } catch {
      state.productInfo = null;
    }
  }

  function showSinglePicker() {
    resetSingleEntry();
    const input = $(state.host, '[data-single-search]');
    const status = $(state.host, '[data-single-status]');
    const results = $(state.host, '[data-single-results]');
    if (input) input.value = '';
    if (status) status.textContent = '';
    if (results) results.innerHTML = '';
    show('picker');
    input?.focus();
  }

  async function loadSingleSearch(host, q) {
    const status = $(host, '[data-single-status]');
    const results = $(host, '[data-single-results]');
    if (!q) {
      if (status) status.textContent = '';
      if (results) results.innerHTML = '';
      return;
    }
    if (status) status.textContent = INVENTORY_MANUAL_TEXTS.singleSearchLoading;
    try {
      const data = await api.get(`${INVENTORY_MANUAL_TEXTS.productSearchApi}?q=${encodeURIComponent(q)}`);
      const items = Array.isArray(data?.items) ? data.items : [];
      if (status) status.textContent = items.length ? '' : INVENTORY_MANUAL_TEXTS.singleSearchEmpty;
      if (results) {
        results.innerHTML = items.length
          ? `<div class="domain-cards">${items.map((item) => `<button class="entry-card card-button" type="button" data-pick-product="${escapeHtml(item.recordId || '')}"><span class="icon">🔎</span><h3>${escapeHtml(item.number || '')}</h3></button>`).join('')}</div>`
          : '';
      }
    } catch {
      if (status) status.textContent = INVENTORY_MANUAL_TEXTS.singleSearchFailed;
      if (results) results.innerHTML = '';
    }
  }

  async function selectProduct(productId) {
    if (!productId) return;
    showPageError('');
    await loadRows(true);
    if (!productRows(productId).length) await loadProductInfo(productId);
    fitRowsForProduct(productId);
  }

  async function scanSingle() {
    showPageError('');
    try {
      const scanned = await scanCodeRaw('inventory');
      const target = scanTargetUrl(scanned, 'inventory');
      const match = String(target || '').match(/\/r\/([^/?#]+)/);
      if (!match) return showPageError(INVENTORY_MANUAL_TEXTS.scanNoProduct);
      await loadRows();
      const productId = decodeURIComponent(match[1]);
      if (!productRows(productId).length) await loadProductInfo(productId);
      fitRowsForProduct(productId);
    } catch (error) {
      const message = String(error?.message || '');
      if (/cancel/i.test(message)) return;
      showPageError(message === 'jssdk_missing' ? INVENTORY_MANUAL_TEXTS.scanNoSdk : INVENTORY_MANUAL_TEXTS.scanFailed);
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
    const rows = state.editorRows
      .filter((row) => Number(row.quantity) > 0)
      .map((row) => ({ size: Number(row.size), state: String(row.state || ''), quantity: Number(row.quantity) }));
    if (!rows.length) return showPageError(INVENTORY_MANUAL_TEXTS.rowsRequired);
    state.pendingRequest = state.pendingRequest || crypto.randomUUID();
    try {
      const result = await api.post('/api/workbench/inventory/adjustments/pairs', {
        productRecordId: state.productId, rows, requestId: state.pendingRequest,
      });
      state.pendingRequest = null;
      state.inventoryJobId = String(result?.job_id || '').trim();
      state.rows = [];
      showToast(INVENTORY_MANUAL_TEXTS.submittedStock);
      $(state.host, '[data-view="print-modal"]').hidden = false;
    } catch (error) {
      showPageError(describeError(error));
    }
  }

  async function printSaved(yes) {
    $(state.host, '[data-view="print-modal"]').hidden = true;
    if (!yes) {
      window.location.assign(`/workbench/?toast=${encodeURIComponent(INVENTORY_MANUAL_TEXTS.submittedToast)}`);
      return;
    }
    try {
      if (!state.inventoryJobId) throw new Error(INVENTORY_MANUAL_TEXTS.inventoryJobFailed);
      // ⭐ #1210：只发**一次**意图请求；库存成功后由后端建打印任务（页面可以直接走）。
      await api.post(`/api/workbench/inventory/adjustments/pairs/${encodeURIComponent(state.inventoryJobId)}/print-intent`, {});
      window.location.assign(`/workbench/?toast=${encodeURIComponent(INVENTORY_MANUAL_TEXTS.printQueuedToast)}`);
    } catch (error) {
      showPageError(describeError(error));
    }
  }

  async function setSeason(season) {
    const category = $(state.host, '[data-field="batch-category"]')?.value || '';
    if (!category) return showPageError(INVENTORY_MANUAL_TEXTS.categoryRequired);
    try {
      await api.post('/api/workbench/inventory/adjustments/season-flag', {
        category, season, requestId: crypto.randomUUID(),
      });
      state.rows = [];
      await loadRows(true);
      renderViolations();
      showToast(season ? INVENTORY_MANUAL_TEXTS.seasonApplied : INVENTORY_MANUAL_TEXTS.seasonCleared);
    } catch (error) { showPageError(describeError(error)); }
  }

  return {
    mount(host) {
      state.host = host;
      host.innerHTML = `<div data-manual="cards"></div>
        <div data-view="manual-single" class="hidden">
          <div class="page-head"><button class="back" type="button" data-back>‹ 返回</button><h2>单双调整</h2></div>
          <div class="row-card"><div class="row-top"><div class="row-num" data-view="single-label"></div><span class="tag season">编辑中</span></div>
            <div data-view="single-rows" style="margin-top:10px"></div>
            <button class="btn small" type="button" data-add-size style="margin-top:8px">＋ 添加尺码</button>
            <p class="hint" data-view="single-note"></p>
            <div class="row-actions"><button class="btn primary" type="button" data-save>保存库存调整</button><button class="btn" type="button" data-back>取消</button></div>
          </div>
        </div>
        <div data-view="manual-picker" class="hidden">
          <div class="page-head"><button class="back" type="button" data-back>‹ 返回</button><h2>${escapeHtml(INVENTORY_MANUAL_TEXTS.singlePickTitle)}</h2></div>
          <div class="pp-search"><input data-single-search placeholder="${escapeHtml(INVENTORY_MANUAL_TEXTS.singleSearchPlaceholder)}" autocomplete="off"></div>
          <p class="pp-note" data-single-status></p>
          <div data-single-results></div>
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
      renderCards();
      let singleTimer = null;
      host.querySelector('[data-single-search]')?.addEventListener('input', (event) => {
        clearTimeout(singleTimer);
        const q = event.target.value.trim();
        singleTimer = setTimeout(() => { void loadSingleSearch(host, q); }, 250);
      });
      host.addEventListener('click', (event) => {
        const back = event.target.closest?.('[data-back]');
        if (back) { resetSingleEntry(); show('cards'); return; }
        const manual = event.target.closest?.('[data-manual="single"], [data-manual="batch"]');
        if (manual) {
          if (manual.dataset.manual === 'single') {
            state.singleExpanded = true;
            renderCards();
            return;
          }
          void enterBatch().catch((error) => showPageError(describeError(error)));
          return;
        }
        const singleAction = event.target.closest?.('[data-single-action]');
        if (singleAction) {
          resetSingleEntry();
          if (singleAction.dataset.singleAction === 'scan') void scanSingle();
          else showSinglePicker();
          return;
        }
        const pick = event.target.closest?.('[data-pick-product]');
        if (pick) { void selectProduct(pick.dataset.pickProduct); return; }
        if (event.target.closest?.('[data-save]')) { void savePairs(); return; }
        const season = event.target.closest?.('[data-action="season-set"]');
        if (season) { void setSeason(season.dataset.season === 'true'); return; }
        const print = event.target.closest?.('[data-print]');
        if (print) { void printSaved(print.dataset.print === 'yes'); return; }
        if (event.target.closest?.('[data-add-size]')) {
          state.editorRows.push({ size: '', state: '门盒', quantity: 1 });
          renderEditor();
        }
      });
      host.querySelector('[data-field="batch-category"]').addEventListener('change', () => renderViolations());
      host.querySelector('[data-field="status-filter"]')?.addEventListener('change', () => renderViolations());
    },
  };
}
