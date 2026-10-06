import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { bindSubTabs, describeError, setBusy, showPageError } from '../../core/ui.js';

// 「库存手工调整」——常用功能里的核心子页，两个子 tab：
//   · 盘点调整：改**数量**，可增可减（盘多了加、盘少了减）→ POST .../adjustments/count
//   · 换季调整：改**状态**，数量不变（门盒/样品 ↔ 仓库）→ POST .../adjustments/season
//
// 两条硬约束（后端已实现，界面也必须按它设计）：
//   ① 流水里的「变动数量」存的是**绝对值**，增减由「库存方向」表达 —— 页面不拼 +N/−N；
//   ② 幂等靠**界面侧的 requestId**：一次提交生成一个，**重试复用同一个**
//      （state.pendingRequest：失败保留、成功清空），这样重试不会重复加/减。
const $ = (container, selector) => container.querySelector(selector);

const STATES = ['门盒', '样品', '仓库'];
const SEASON_ACTIONS = {
  season_freeze: { label: '转冻结（门盒/样品 → 仓库）', from: ['门盒', '样品'], needsTarget: false },
  season_release: { label: '转释放（仓库 → 门盒/样品）', from: ['仓库'], needsTarget: true },
};

function renderShell(container) {
  container.innerHTML = `
    <section class="panel">
      <div class="panel-header">
        <div>
          <h2>库存手工调整</h2>
          <p class="subtitle">盘点调整改数量（可增可减）；换季调整只改状态，数量一双都不变</p>
        </div>
      </div>
      <div class="sub-tabs">
        <button class="sub-tab active" type="button" data-subtab="adjust-count">盘点调整</button>
        <button class="sub-tab" type="button" data-subtab="adjust-season">换季调整</button>
      </div>

      <div id="adjust-count-subpanel" class="sub-panel">
        <div class="toolbar compact-toolbar">
          <label class="form-field grow">找货品（货号 / 编号 / 颜色）
            <input data-field="count-keyword" placeholder="例如 XHB8095 或 YD6693">
          </label>
          <button class="btn" type="button" data-action="count-search">查找货品</button>
        </div>
        <div class="product-picker" data-view="count-products">
          <p class="empty compact">先按货号查找，再从结果里选一双鞋</p>
        </div>
        <div class="action-form">
          <h3>盘点调整</h3>
          <p class="muted">选货号 + 尺码 → 看当前库存 → 填「实际盘点数」或「增减几双」。</p>
          <div class="order-details" data-view="count-selected"><div><span>已选</span><strong>未选择</strong></div></div>
          <div class="two-col">
            <label class="form-field">尺码
              <input data-field="count-size" type="number" min="1" step="1" inputmode="numeric" placeholder="例如 42">
            </label>
            <label class="form-field">所属状态
              <select data-field="count-state">${STATES.map((state) => `<option>${state}</option>`).join('')}</select>
            </label>
          </div>
          <div class="order-details" data-view="count-levels"><p class="muted">选择货品并填好尺码后，这里显示三种状态的当前库存。</p></div>
          <div class="mode-choice">
            <label><input type="radio" name="count-mode" value="counted" checked> 按「实际盘点数」调整</label>
            <label><input type="radio" name="count-mode" value="delta"> 按「增减数量」调整</label>
          </div>
          <label class="form-field" data-view="counted-field">实际盘点数（双）
            <input data-field="counted-quantity" type="number" min="0" step="1" inputmode="numeric" placeholder="仓库里实际有几双">
          </label>
          <label class="form-field hidden" data-view="delta-field">增减数量（正数=加，负数=减）
            <input data-field="delta-quantity" type="number" step="1" inputmode="numeric" placeholder="例如 2 或 -1">
          </label>
          <button class="btn btn-primary" type="button" data-action="submit-count">提交盘点调整</button>
          <p class="operation-result" data-view="count-result" role="status"></p>
        </div>
      </div>

      <div id="adjust-season-subpanel" class="sub-panel hidden">
        <p class="muted">换季调整只改「所属状态」，**不新建也不删除**库存记录，所以总双数不变。
          记录进了「仓库」以后，原来在门盒还是样品就查不到了——转释放时请自己选回哪里。</p>
        <div class="toolbar compact-toolbar">
          <label class="form-field grow">动作
            <select data-field="season-action">
              ${Object.entries(SEASON_ACTIONS).map(([value, item]) => `<option value="${value}">${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </label>
          <label class="form-field" data-view="release-target-field">释放回哪里
            <select data-field="season-to-state"><option>门盒</option><option>样品</option></select>
          </label>
        </div>
        <div class="mode-choice">
          <label><input type="radio" name="season-mode" value="category" checked> 按品类批量</label>
          <label><input type="radio" name="season-mode" value="single"> 按编号单个</label>
        </div>
        <div data-view="season-category-block">
          <div class="toolbar compact-toolbar">
            <label class="form-field grow">品类
              <select data-field="season-category"><option value="">正在加载品类…</option></select>
            </label>
            <button class="btn" type="button" data-action="season-list">列出这一品类的鞋</button>
          </div>
          <div class="season-list" data-view="season-rows">
            <p class="empty compact">选好品类和动作后，点「列出这一品类的鞋」</p>
          </div>
        </div>
        <div class="hidden" data-view="season-single-block">
          <div class="toolbar compact-toolbar">
            <label class="form-field grow">找货品（货号 / 编号 / 颜色）
              <input data-field="season-keyword" placeholder="例如 XHB8095">
            </label>
            <button class="btn" type="button" data-action="season-search">查找货品</button>
          </div>
          <div class="product-picker" data-view="season-products">
            <p class="empty compact">先按货号查找，再从结果里选一双鞋</p>
          </div>
          <div class="two-col">
            <label class="form-field">尺码
              <input data-field="season-size" type="number" min="1" step="1" inputmode="numeric" placeholder="例如 42">
            </label>
            <label class="form-field">数量（双）
              <input data-field="season-quantity" type="number" min="1" step="1" inputmode="numeric" value="1">
            </label>
          </div>
          <div class="order-details" data-view="season-single-selected"><div><span>已选</span><strong>未选择</strong></div></div>
        </div>
        <button class="btn btn-primary" type="button" data-action="submit-season">提交换季调整</button>
        <p class="operation-result" data-view="season-result" role="status"></p>
      </div>
    </section>`;
}

export function createInventoryAdjustmentModule() {
  const state = {
    container: null,
    // 幂等：一次提交生成一个 requestId，重试复用同一个（成功后清空）。
    pendingRequest: null,
    countProduct: null,
    seasonProduct: null,
    categoryRows: [],
    selectedCategoryKeys: new Set(),
  };

  // ── 共用：货品查找 ────────────────────────────────────────────────────
  async function searchProducts(keyword, listSelector, onPick) {
    showPageError('');
    const panel = $(state.container, listSelector);
    panel.innerHTML = '<p class="section-loading">正在查找货品…</p>';
    try {
      const params = new URLSearchParams({ keyword: keyword || '' });
      const data = await api.get(`/api/workbench/inventory/products?${params}`);
      const rows = data.rows || [];
      panel.innerHTML = rows.length
        ? `<div class="picker-list">${rows.map((row) => `
            <button class="picker-item" type="button" data-product="${escapeHtml(row.record_id)}"
              data-label="${escapeHtml([row.item_no, row.color].filter(Boolean).join(' ') || row.product_number)}">
              <strong>${escapeHtml(row.item_no || row.product_number || row.record_id)}</strong>
              <span class="muted">${escapeHtml(row.product_number || '')}${row.color ? ` · ${escapeHtml(row.color)}` : ''}</span>
            </button>`).join('')}</div>`
        : '<p class="empty compact">没有匹配的货品，换个货号试试。</p>';
      panel.querySelectorAll('[data-product]').forEach((button) => button.addEventListener('click', () => {
        panel.querySelectorAll('[data-product]').forEach((item) => item.classList.toggle('active', item === button));
        onPick({ recordId: button.dataset.product, label: button.dataset.label });
      }));
    } catch (error) {
      panel.innerHTML = '<p class="empty compact">货品查找失败</p>';
      showPageError(describeError(error));
    }
  }

  function renderSelected(selector, product, extra = '') {
    $(state.container, selector).innerHTML = product
      ? `<div><span>已选货品</span><strong>${escapeHtml(product.label)}</strong></div>${extra}`
      : '<div><span>已选</span><strong>未选择</strong></div>';
  }

  // ── 盘点调整 ─────────────────────────────────────────────────────────
  function countInputs() {
    const panel = $(state.container, '#adjust-count-subpanel');
    return {
      panel,
      size: $(panel, '[data-field="count-size"]').value.trim(),
      state: $(panel, '[data-field="count-state"]').value,
      mode: panel.querySelector('input[name="count-mode"]:checked')?.value || 'counted',
      counted: $(panel, '[data-field="counted-quantity"]').value.trim(),
      delta: $(panel, '[data-field="delta-quantity"]').value.trim(),
    };
  }

  function toggleCountMode() {
    const { panel, mode } = countInputs();
    $(panel, '[data-view="counted-field"]').classList.toggle('hidden', mode !== 'counted');
    $(panel, '[data-view="delta-field"]').classList.toggle('hidden', mode !== 'delta');
  }

  async function loadCountLevels() {
    const { panel, size, state: currentState } = countInputs();
    const view = $(panel, '[data-view="count-levels"]');
    if (!state.countProduct) return;
    if (!size) { view.innerHTML = '<p class="muted">先填尺码，再看当前库存。</p>'; return; }
    if (!/^[1-9]\d*$/.test(size)) { view.innerHTML = '<p class="muted">尺码必须是正整数，例如 42。</p>'; return; }
    view.innerHTML = '<p class="section-loading">正在读取当前库存…</p>';
    try {
      const params = new URLSearchParams({ productRecordId: state.countProduct.recordId, size });
      const data = await api.get(`/api/workbench/inventory/stock?${params}`);
      const rows = data.rows || [];
      view.innerHTML = rows.map((row) => `
        <div class="${row.state === currentState ? 'level-current' : ''}">
          <span>${escapeHtml(row.state)}${row.state === currentState ? '（本次调整）' : ''}</span>
          <strong>${escapeHtml(row.quantity)}</strong>
        </div>`).join('') + `<div><span>合计</span><strong>${escapeHtml(data.total || 0)}</strong></div>`;
    } catch (error) {
      view.innerHTML = '<p class="muted">当前库存读取失败</p>';
      showPageError(describeError(error));
    }
  }

  async function submitCount(button) {
    const { panel, size, state: currentState, mode, counted, delta } = countInputs();
    if (!state.countProduct) return showPageError('请先选一个货品');
    if (!/^[1-9]\d*$/.test(size)) return showPageError('尺码必须是正整数，例如 42');
    if (mode === 'counted' && !/^\d+$/.test(counted)) return showPageError('实际盘点数必须是不小于 0 的整数');
    if (mode === 'delta' && !/^-?\d+$/.test(delta)) return showPageError('增减数量必须是整数，例如 2 或 -1');
    const body = {
      productRecordId: state.countProduct.recordId,
      size: Number(size),
      state: currentState,
      mode,
      requestId: state.pendingRequest || crypto.randomUUID(),
    };
    state.pendingRequest = body.requestId;
    if (mode === 'counted') body.countedQuantity = Number(counted);
    else body.delta = Number(delta);
    setBusy(button, true, '正在调整…');
    showPageError('');
    try {
      const result = await api.post('/api/workbench/inventory/adjustments/count', body);
      state.pendingRequest = null; // 成功后才换新的 requestId
      $(panel, '[data-view="count-result"]').textContent =
        `已调整：${result.product_record_id}｜${result.size}码｜${result.state} `
        + `${result.before_quantity} → ${result.after_quantity} 双（本次 ${result.delta > 0 ? '+' : ''}${result.delta}）。`;
      $(panel, '[data-view="count-result"]').classList.remove('error-text');
      await loadCountLevels();
    } catch (error) {
      // 400 = 她填错了（没写任何东西），可以换一个 requestId；其余保留，
      // 重试时复用同一个，避免"其实已经写进去一次"被记成两次。
      if (error.status === 400) state.pendingRequest = null;
      $(panel, '[data-view="count-result"]').textContent = describeError(error);
      $(panel, '[data-view="count-result"]').classList.add('error-text');
      showPageError(describeError(error));
    } finally {
      setBusy(button, false);
    }
  }

  // ── 换季调整 ─────────────────────────────────────────────────────────
  function seasonAction() {
    const panel = $(state.container, '#adjust-season-subpanel');
    const action = $(panel, '[data-field="season-action"]').value;
    return { panel, action, config: SEASON_ACTIONS[action] || SEASON_ACTIONS.season_freeze,
      toState: $(panel, '[data-field="season-to-state"]').value };
  }

  function seasonMode() {
    const panel = $(state.container, '#adjust-season-subpanel');
    return panel.querySelector('input[name="season-mode"]:checked')?.value || 'category';
  }

  async function loadCategories() {
    const panel = $(state.container, '#adjust-season-subpanel');
    const select = $(panel, '[data-field="season-category"]');
    try {
      const data = await api.get('/api/workbench/inventory/categories');
      const rows = data.rows || [];
      select.innerHTML = '<option value="">选择品类</option>'
        + rows.map((row) => `<option value="${escapeHtml(row.category)}">${escapeHtml(row.category)}（${row.quantity} 双）</option>`).join('');
    } catch (error) {
      select.innerHTML = '<option value="">品类加载失败</option>';
      showPageError(describeError(error));
    }
  }

  async function loadCategoryRows() {
    const { panel, config } = seasonAction();
    const category = $(panel, '[data-field="season-category"]').value;
    const view = $(panel, '[data-view="season-rows"]');
    if (!category) return showPageError('请先选一个品类');
    view.innerHTML = '<p class="section-loading">正在列出这一品类的鞋…</p>';
    try {
      const data = await api.get('/api/workbench/inventory');
      // 只保留这个品类、且状态在本次动作「起点」里的行（转冻结看门盒/样品，转释放只看仓库）。
      state.categoryRows = (data.rows || []).filter((row) => row.category === category
        && config.from.includes(row.state));
      state.selectedCategoryKeys = new Set();
      renderCategoryRows();
    } catch (error) {
      view.innerHTML = '<p class="empty compact">库存读取失败</p>';
      showPageError(describeError(error));
    }
  }

  function renderCategoryRows() {
    const { panel, config } = seasonAction();
    const view = $(panel, '[data-view="season-rows"]');
    const rows = state.categoryRows;
    if (!rows.length) {
      view.innerHTML = `<p class="empty compact">这个品类里没有「${config.from.join(' / ')}」状态的库存。</p>`;
      return;
    }
    view.innerHTML = `
      <div class="row-actions">
        <button class="btn btn-ghost" type="button" data-action="season-select-all">全选</button>
        <button class="btn btn-ghost" type="button" data-action="season-select-none">全不选</button>
      </div>
      <div class="table-wrap mobile-card-table"><table>
        <thead><tr><th>选择</th><th>货号</th><th>颜色</th><th>尺码</th><th>所属状态</th><th>现有数量</th></tr></thead>
        <tbody>${rows.map((row) => {
          const key = `${row.product_record_id}|${row.size}|${row.state}`;
          return `<tr><td data-label="选择"><input type="checkbox" data-season-key="${escapeHtml(key)}" ${state.selectedCategoryKeys.has(key) ? 'checked' : ''}></td>
            <td data-label="货号"><span class="cell-value">${escapeHtml(row.item_no || row.product_number || '-')}</span></td>
            <td data-label="颜色"><span class="cell-value">${escapeHtml(row.color || '-')}</span></td>
            <td data-label="尺码"><span class="cell-value">${escapeHtml(row.size ?? '-')}</span></td>
            <td data-label="所属状态"><span class="cell-value tag tag-info">${escapeHtml(row.state)}</span></td>
            <td data-label="现有数量" class="quantity"><span class="cell-value">${escapeHtml(row.quantity)}</span></td></tr>`;
        }).join('')}</tbody></table></div>`;
    view.querySelectorAll('[data-season-key]').forEach((input) => input.addEventListener('change', () => {
      if (input.checked) state.selectedCategoryKeys.add(input.dataset.seasonKey);
      else state.selectedCategoryKeys.delete(input.dataset.seasonKey);
      updateSeasonSubmit();
    }));
    $(view, '[data-action="season-select-all"]').addEventListener('click', () => {
      rows.forEach((row) => state.selectedCategoryKeys.add(`${row.product_record_id}|${row.size}|${row.state}`));
      renderCategoryRows();
    });
    $(view, '[data-action="season-select-none"]').addEventListener('click', () => {
      state.selectedCategoryKeys = new Set();
      renderCategoryRows();
    });
    updateSeasonSubmit();
  }

  function buildTargets() {
    const { config } = seasonAction();
    if (seasonMode() === 'category') {
      return state.categoryRows
        .filter((row) => state.selectedCategoryKeys.has(`${row.product_record_id}|${row.size}|${row.state}`))
        .map((row) => ({ productRecordId: row.product_record_id, size: row.size, state: row.state, quantity: row.quantity }));
    }
    const panel = $(state.container, '#adjust-season-subpanel');
    const size = $(panel, '[data-field="season-size"]').value.trim();
    const quantity = $(panel, '[data-field="season-quantity"]').value.trim();
    if (!state.seasonProduct) return [];
    if (!/^[1-9]\d*$/.test(size)) return [];
    if (!/^[1-9]\d*$/.test(quantity)) return [];
    return [{
      productRecordId: state.seasonProduct.recordId,
      size: Number(size),
      // 按编号时起点由动作决定：冻结从门盒起（样品要单独选）、释放一定从仓库起。
      state: config.from[0],
      quantity: Number(quantity),
    }];
  }

  function updateSeasonSubmit() {
    const { panel } = seasonAction();
    const targets = buildTargets();
    const button = $(panel, '[data-action="submit-season"]');
    const total = targets.reduce((sum, item) => sum + item.quantity, 0);
    button.textContent = `提交换季调整（${targets.length} 条 / ${total} 双）`;
    button.disabled = !targets.length;
  }

  async function submitSeason(button) {
    const { panel, action, config, toState } = seasonAction();
    const targets = buildTargets();
    if (!targets.length) return showPageError('请先选择要调整的鞋');
    const body = {
      action,
      targets,
      requestId: state.pendingRequest || crypto.randomUUID(),
    };
    if (config.needsTarget) body.toState = toState;
    state.pendingRequest = body.requestId;
    setBusy(button, true, '正在调整…');
    showPageError('');
    try {
      const result = await api.post('/api/workbench/inventory/adjustments/season', body);
      state.pendingRequest = null;
      const failed = result.failures || [];
      $(panel, '[data-view="season-result"]').innerHTML = failed.length
        ? `成功 ${result.succeeded} 条，失败 ${result.failed} 条：<br>${failed.map((item) =>
          `${escapeHtml(item.product_record_id)}｜${escapeHtml(item.size)}码｜${escapeHtml(item.state)}：${escapeHtml(item.error)}`).join('<br>')}`
        : `已把 ${result.succeeded} 条（共 ${targets.reduce((sum, item) => sum + item.quantity, 0)} 双）改成「${escapeHtml(result.to_state)}」，数量没有变化。`;
      if (seasonMode() === 'category') await loadCategoryRows();
      else await loadSeasonSingleLevels();
    } catch (error) {
      if (error.status === 400) state.pendingRequest = null;
      $(panel, '[data-view="season-result"]').textContent = describeError(error);
      showPageError(describeError(error));
    } finally {
      setBusy(button, false);
      updateSeasonSubmit();
    }
  }

  async function loadSeasonSingleLevels() {
    const { panel, config } = seasonAction();
    if (!state.seasonProduct) return;
    const size = $(panel, '[data-field="season-size"]').value.trim();
    const view = $(panel, '[data-view="season-single-selected"]');
    if (!/^[1-9]\d*$/.test(size)) { renderSelected('[data-view="season-single-selected"]', state.seasonProduct); return; }
    try {
      const params = new URLSearchParams({ productRecordId: state.seasonProduct.recordId, size });
      const data = await api.get(`/api/workbench/inventory/stock?${params}`);
      const rows = (data.rows || []).filter((row) => config.from.includes(row.state));
      renderSelected('[data-view="season-single-selected"]', state.seasonProduct,
        rows.map((row) => `<div><span>${escapeHtml(row.state)}</span><strong>${escapeHtml(row.quantity)}</strong></div>`).join(''));
    } catch (error) { showPageError(describeError(error)); }
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────
  function bindCount() {
    const panel = $(state.container, '#adjust-count-subpanel');
    $(panel, '[data-action="count-search"]').addEventListener('click', () => searchProducts(
      $(panel, '[data-field="count-keyword"]').value.trim(), '[data-view="count-products"]',
      (product) => { state.countProduct = product; renderSelected('[data-view="count-selected"]', product); loadCountLevels(); },
    ));
    $(panel, '[data-field="count-keyword"]').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $(panel, '[data-action="count-search"]').click();
    });
    $(panel, '[data-field="count-size"]').addEventListener('change', loadCountLevels);
    $(panel, '[data-field="count-state"]').addEventListener('change', loadCountLevels);
    panel.querySelectorAll('input[name="count-mode"]').forEach((input) => input.addEventListener('change', toggleCountMode));
    $(panel, '[data-action="submit-count"]').addEventListener('click', (event) => submitCount(event.currentTarget));
  }

  function bindSeason() {
    const panel = $(state.container, '#adjust-season-subpanel');
    const refresh = () => {
      const { config } = seasonAction();
      state.selectedCategoryKeys = new Set();
      $(panel, '[data-view="release-target-field"]').classList.toggle('hidden', !config.needsTarget);
      $(panel, '[data-view="season-rows"]').innerHTML = '<p class="empty compact">换动作后请重新「列出这一品类的鞋」</p>';
      state.categoryRows = [];
      updateSeasonSubmit();
    };
    $(panel, '[data-field="season-action"]').addEventListener('change', refresh);
    panel.querySelectorAll('input[name="season-mode"]').forEach((input) => input.addEventListener('change', () => {
      const single = seasonMode() === 'single';
      $(panel, '[data-view="season-category-block"]').classList.toggle('hidden', single);
      $(panel, '[data-view="season-single-block"]').classList.toggle('hidden', !single);
      updateSeasonSubmit();
    }));
    $(panel, '[data-action="season-list"]').addEventListener('click', loadCategoryRows);
    $(panel, '[data-action="season-search"]').addEventListener('click', () => searchProducts(
      $(panel, '[data-field="season-keyword"]').value.trim(), '[data-view="season-products"]',
      (product) => { state.seasonProduct = product; loadSeasonSingleLevels(); updateSeasonSubmit(); },
    ));
    $(panel, '[data-field="season-keyword"]').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') $(panel, '[data-action="season-search"]').click();
    });
    $(panel, '[data-field="season-size"]').addEventListener('change', () => { loadSeasonSingleLevels(); updateSeasonSubmit(); });
    $(panel, '[data-field="season-quantity"]').addEventListener('input', updateSeasonSubmit);
    $(panel, '[data-action="submit-season"]').addEventListener('click', (event) => submitSeason(event.currentTarget));
  }

  return {
    mount(container) {
      state.container = container;
      renderShell(container);
      bindSubTabs(container);
      bindCount();
      bindSeason();
      toggleCountMode();
      updateSeasonSubmit();
      loadCategories();
    },
  };
}
