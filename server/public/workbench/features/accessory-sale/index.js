import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { showToast } from '../shared/toast.js';
import { ACCESSORY_SALE_PAGE as T } from '../../config/accessorySalePage.js';

const money = (value) => Number(value || 0).toLocaleString('zh-CN', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function createAccessorySaleModule() {
  const state = { host: null, accessories: [], methods: [], cart: new Map(), total: '', methodId: '', busy: false };

  const totalOf = () => [...state.cart.values()].reduce((sum, item) => sum + Number(item.price || 0) * item.quantity, 0);
  const selectedAmount = () => {
    const value = Number(state.total);
    return Number.isFinite(value) && value > 0 ? value : totalOf();
  };

  const renderCart = () => {
    const host = state.host;
    if (!host) return;
    const box = host.querySelector('[data-as-cart]');
    if (!box) return;
    const rows = [...state.cart.values()];
    box.innerHTML = rows.length ? rows.map((item) => `
      <div class="as-line" data-as-line="${escapeHtml(item.recordId)}">
        <div class="as-line-name">${escapeHtml(item.name)}<small>${escapeHtml(item.category || '')}</small></div>
        <input class="as-qty" data-as-qty type="number" inputmode="numeric" min="1" step="1" value="${item.quantity}" aria-label="数量">
        <div class="as-line-amount">¥${money(Number(item.price || 0) * item.quantity)}</div>
        <button class="as-remove" type="button" data-as-remove>删除</button>
      </div>`).join('') : `<p class="as-empty">${escapeHtml(T.cartEmpty)}</p>`;
    const totalInput = host.querySelector('[data-as-total]');
    if (totalInput && state.total === '') totalInput.value = totalOf().toFixed(2);
  };

  const render = () => {
    const host = state.host;
    if (!host) return;
    host.innerHTML = `
      <div class="as-page" data-page-kind="accessory-sale">
        <header class="as-head"><div><h1>${escapeHtml(T.title)}</h1><p>${escapeHtml(T.subtitle)}</p></div></header>
        <section class="as-card">
          <h2>${escapeHtml(T.selectedTitle)}</h2>
          <div data-as-cart></div>
          <div class="as-checkout">
            <label class="as-field">${escapeHtml(T.totalLabel)}
              <input data-as-total type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(state.total || totalOf().toFixed(2))}">
            </label>
            <label class="as-field">${escapeHtml(T.methodLabel)}
              <select data-as-method>
                ${state.methods.map((method) => `<option value="${escapeHtml(method.recordId)}"${method.recordId === state.methodId ? ' selected' : ''}>${escapeHtml(method.name)}</option>`).join('')}
              </select>
            </label>
          </div>
          <button class="as-submit" type="button" data-as-submit>${escapeHtml(T.submit)}</button>
          <p class="as-success" data-as-success hidden></p>
        </section>
        <label class="as-search"><input data-as-search type="search" placeholder="${escapeHtml(T.searchPlaceholder)}" autocomplete="off"></label>
        <section class="as-card">
          <div class="as-list" data-as-list>
            ${state.accessories.length ? state.accessories.map((item) => `
              <article class="as-item" data-as-item="${escapeHtml(item.recordId)}">
                <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category || '')}</small></div>
                <span class="as-price">¥${money(item.price)}</span>
                <button class="as-add" type="button" data-as-add>加入</button>
              </article>`).join('') : `<p class="as-empty">${escapeHtml(T.emptyAccessories)}</p>`}
          </div>
        </section>
      </div>`;
    bind();
    renderCart();
  };

  const filtered = (query) => {
    const keyword = String(query || '').trim().toLowerCase();
    if (!keyword) return state.accessories;
    return state.accessories.filter((item) => `${item.name || ''} ${item.category || ''}`.toLowerCase().includes(keyword));
  };

  const filterList = (query) => {
    const host = state.host;
    const list = host?.querySelector('[data-as-list]');
    if (!list) return;
    const rows = filtered(query);
    list.innerHTML = rows.length ? rows.map((item) => `
      <article class="as-item" data-as-item="${escapeHtml(item.recordId)}">
        <div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.category || '')}</small></div>
        <span class="as-price">¥${money(item.price)}</span>
        <button class="as-add" type="button" data-as-add>加入</button>
      </article>`).join('') : `<p class="as-empty">${escapeHtml(T.emptyAccessories)}</p>`;
  };

  const add = (recordId) => {
    const accessory = state.accessories.find((item) => item.recordId === recordId);
    if (!accessory) return;
    const current = state.cart.get(recordId);
    state.cart.set(recordId, { ...accessory, quantity: (current?.quantity || 0) + 1 });
    state.total = '';
    renderCart();
  };

  const submit = async () => {
    const host = state.host;
    if (!host || state.busy) return;
    const items = [...state.cart.values()].map((item) => ({ accessoryRecordId: item.recordId, quantity: item.quantity }));
    const amount = selectedAmount();
    const methodRecordId = String(host.querySelector('[data-as-method]')?.value || '');
    if (!items.length) { showToast(T.invalidItems); return; }
    if (!amount) { showToast(T.invalidAmount); return; }
    if (!methodRecordId) { showToast(T.invalidMethod); return; }
    state.busy = true;
    const button = host.querySelector('[data-as-submit]');
    if (button) { button.disabled = true; button.textContent = T.submitting; }
    showPageError('');
    try {
      const result = await api.post(T.api, { items, amount, methodRecordId, saleDate: Date.now() });
      state.cart.clear();
      state.total = '';
      renderCart();
      const success = host.querySelector('[data-as-success]');
      if (success) {
        success.hidden = false;
        success.textContent = `${T.success}：${T.orderNoLabel} ${result.orderNo || ''}`;
      }
      showToast(T.success);
      if (button) button.textContent = T.submit;
    } catch (error) {
      showToast(error?.message || T.failed);
      if (button) button.textContent = T.submit;
    } finally {
      state.busy = false;
      if (button) button.disabled = false;
    }
  };

  const bind = () => {
    const host = state.host;
    if (!host) return;
    host.querySelector('[data-as-search]')?.addEventListener('input', (event) => filterList(event.target.value));
    host.addEventListener('click', (event) => {
      const addButton = event.target.closest('[data-as-add]');
      if (addButton) { add(addButton.closest('[data-as-item]')?.dataset.asItem); return; }
      const removeButton = event.target.closest('[data-as-remove]');
      if (removeButton) {
        const id = removeButton.closest('[data-as-line]')?.dataset.asLine;
        state.cart.delete(id);
        state.total = '';
        renderCart();
        return;
      }
      if (event.target.closest('[data-as-submit]')) void submit();
    });
    host.addEventListener('change', (event) => {
      const qty = event.target.closest('[data-as-qty]');
      if (qty) {
        const id = qty.closest('[data-as-line]')?.dataset.asLine;
        const item = state.cart.get(id);
        const value = Number(qty.value);
        if (item && Number.isInteger(value) && value > 0) { item.quantity = value; state.total = ''; renderCart(); }
        return;
      }
      if (event.target.matches('[data-as-method]')) state.methodId = event.target.value;
    });
    host.addEventListener('input', (event) => {
      if (event.target.matches('[data-as-total]')) state.total = event.target.value;
    });
  };

  const load = async () => {
    if (!state.host) return;
    state.host.innerHTML = `<p class="as-loading">读取配品…</p>`;
    try {
      const data = await api.get(T.optionsApi);
      state.accessories = Array.isArray(data?.accessories) ? data.accessories : [];
      state.methods = Array.isArray(data?.paymentMethods) ? data.paymentMethods : [];
      state.methodId = state.methods[0]?.recordId || '';
      render();
    } catch (error) {
      state.host.innerHTML = `<p class="as-empty">${escapeHtml(T.loadFailed)}</p>`;
      showPageError(String(error?.message || ''));
    }
  };

  return { mount(host) { state.host = host; void load(); } };
}
