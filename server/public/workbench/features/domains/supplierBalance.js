/** 「供应 → 供应分析」：交易流水（供应商最新余额 + 最近 30 天 P 交易） / 供应总览占位。 */
import { api } from '../../core/api-client.js';
import { SUPPLIER_BALANCE_API, SUPPLIER_BALANCE_TEXTS as T } from '../../config/supplierBalance.js';
import { showPageError } from '../../core/ui.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (values[k] == null ? '' : String(values[k])));
const amount = (value) => new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 })
  .format(Number(value) || 0);
const money = (value) => {
  const number = Number(value) || 0;
  return `${number < 0 ? '-¥' : '¥'}${amount(Math.abs(number))}`;
};
const typeClass = (type) => ({
  报货: 'is-inbound', 退货: 'is-return', 付款: 'is-pay', 收款: 'is-receive',
}[type] || 'is-inbound');
const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};
const balanceClass = (value) => {
  const number = Number(value) || 0;
  if (number > 0) return 'is-positive';
  if (number < 0) return 'is-negative';
  return 'is-zero';
};
const transactionHtml = (item) => `
  <div class="sb-txn">
    <div class="sb-txn-top">
      <span class="sb-type ${typeClass(item.type)}">${esc(item.type)}</span>
      <span class="sb-txn-amount">${money(item.amount)}</span>
    </div>
    <div class="sb-txn-meta">
      <time>${esc(formatDate(item.tradeDate))}</time>
      <span>余额 ${money(item.balance)}</span>
    </div>
  </div>`;

const cardHtml = (supplier) => `
  <article class="sb-card" data-sb-card data-sb-id="${esc(supplier.recordId)}" data-name="${esc(supplier.name)}">
    <div class="sb-card-head">
      <div class="sb-card-name">
        <h3>${esc(supplier.name)}</h3>
      </div>
      <div class="sb-card-balance ${balanceClass(supplier.balance)}">
        <strong>${money(supplier.balance)}</strong>
      </div>
    </div>
    <div class="sb-txns">
      ${(supplier.transactions || []).length
        ? `<p class="sb-txns-title">${esc(T.transactionsTitle)}</p>${supplier.transactions.map(transactionHtml).join('')}`
        : `<p class="sb-no-tx">${esc(T.noTransactions)}</p>`}
    </div>
  </article>`;

const TABS = Array.isArray(T.tabs) ? T.tabs : [];
const tabsHtml = () => TABS.map((tab) => `<button class="sb-tab${tab.id === 'transactions' ? ' active' : ''}" type="button" role="tab" data-sb-tab="${esc(tab.id)}" aria-selected="${tab.id === 'transactions'}">${esc(tab.label)}</button>`).join('');

export function createSupplierBalanceModule() {
  return {
    mount(host) {
      host.innerHTML = `
        <div class="domain-page" data-page-kind="supplier-balance">
          <div class="sb-sticky-head">
            <div class="sb-tabs" role="tablist" aria-label="${esc(T.tabsLabel)}">${tabsHtml()}</div>
          </div>
          <div data-sb-panel="overview" hidden>
            <div class="sb-placeholder"><p>${esc(T.overviewBuilding)}</p></div>
          </div>
          <div data-sb-panel="transactions">
            <div class="pp-search">
              <input data-sb-search type="search" placeholder="${esc(T.searchPlaceholder)}" autocomplete="off">
            </div>
            <p class="pp-note" data-sb-count hidden></p>
            <p class="pp-note" data-sb-empty hidden></p>
            <div data-sb-list aria-live="polite"></div>
          </div>
        </div>`;
      const mainTabs = document.querySelector('.main-tabs');
      if (mainTabs) host.style.setProperty('--sb-main-tabs-height', `${Math.ceil(mainTabs.getBoundingClientRect().height)}px`);
      const list = host.querySelector('[data-sb-list]');
      const count = host.querySelector('[data-sb-count]');
      const empty = host.querySelector('[data-sb-empty]');
      const input = host.querySelector('[data-sb-search]');
      let suppliers = [];
      const render = () => {
        const query = String(input?.value || '').trim().toLowerCase();
        const visible = suppliers.filter((item) => !query || String(item.name || '').toLowerCase().includes(query));
        list.innerHTML = visible.map(cardHtml).join('');
        count.hidden = false;
        count.textContent = fill(T.count, { count: visible.length });
        empty.hidden = visible.length > 0;
        empty.textContent = query ? '没有匹配的供应商。' : T.empty;
      };
      const load = async () => {
        list.innerHTML = `<p class="pp-note">${esc(T.loading)}</p>`;
        try {
          const data = await api.get(SUPPLIER_BALANCE_API);
          suppliers = Array.isArray(data?.suppliers) ? data.suppliers : [];
          render();
        } catch (error) {
          suppliers = [];
          list.innerHTML = '';
          count.hidden = true;
          empty.hidden = false;
          empty.textContent = T.failed;
          showPageError(T.failed);
        }
      };
      host.querySelector('.sb-tabs')?.addEventListener('click', (event) => {
        const button = event.target.closest('[data-sb-tab]');
        if (!button) return;
        const id = button.dataset.sbTab || 'transactions';
        host.querySelectorAll('[data-sb-tab]').forEach((tab) => {
          const selected = tab.dataset.sbTab === id;
          tab.classList.toggle('active', selected);
          tab.setAttribute('aria-selected', String(selected));
        });
        host.querySelectorAll('[data-sb-panel]').forEach((panel) => {
          panel.hidden = panel.dataset.sbPanel !== id;
        });
      });
      input?.addEventListener('input', render);
      load();
    },
  };
}
