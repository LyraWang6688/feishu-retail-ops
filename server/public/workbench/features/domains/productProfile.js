/**
 * 「配置 → 货品资料」页：
 *   · 货品上新：搜索替代自动查重；用户看结果和样例图自行判断，再去飞书表单；
 *   · 货品完善：按「缺失信息说明」实际值动态分组，选择分类查看记录；
 *   · 同步样例图：复用货品资料的存量同步动作（bindDomainAction）。
 */
import { api } from '../../core/api-client.js';
import { PRODUCT_PROFILE_API, PRODUCT_PROFILE_TEXTS as T } from '../../config/productProfile.js';
import { showToast } from '../shared/toast.js';
import { bindDomainAction } from './dataConfigAction.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (values[k] == null ? '' : String(values[k])));
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const cardsHtml = () => `
  <div class="domain-cards">
    <button class="entry-card" type="button" data-pp-view="new"><span class="icon">🆕</span><h3>${esc(T.newTitle)}</h3></button>
    <button class="entry-card" type="button" data-pp-view="complete"><span class="icon">📝</span><h3>${esc(T.completeTitle)}</h3></button>
    <button class="entry-card" type="button" data-domain-action="sample-image-sync"><span class="icon">🖼️</span><h3>${esc(T.sampleTitle)}</h3></button>
    <a class="entry-card" href="${esc(T.accessoryTableUrl)}" rel="noopener"><span class="icon">🛒</span><h3>${esc(T.accessoryTitle)}</h3></a>
  </div>
  <p class="placeholder-note" data-view="domain-action-note"></p>`;

const backBtn = (view) => `<button class="pp-back" type="button" data-pp-back="${view}">${esc(T.back)}</button>`;

export const productProfilePageHtml = () => `
  <div class="domain-page" data-page-kind="product-profile">
    <div data-pp="cards">${cardsHtml()}</div>
    <div data-pp="new" hidden>
      <div class="pp-head">${backBtn('new')}<h2>${esc(T.newTitle)}</h2></div>
      <a class="pp-primary" href="${esc(T.formUrl)}" target="_blank" rel="noopener">${esc(T.newAction)}</a>
      <div class="pp-search"><input data-pp-search placeholder="${esc(T.searchPlaceholder)}" autocomplete="off"></div>
      <p class="pp-note" data-pp-count hidden></p>
      <div data-pp-results></div>
      <p class="pp-note" data-pp-empty>${esc(T.searchEmpty)}</p>
      <div class="pp-modal" data-pp-modal hidden><button type="button" data-pp-close>×</button><img data-pp-large alt="样例图大图"></div>
    </div>
    <div data-pp="complete" hidden>
      <div class="pp-head">${backBtn('complete')}<h2>${esc(T.completeTitle)}</h2></div>
      <p class="pp-note" data-pp-complete-hint></p>
      <div class="pp-search"><input data-pp-complete-search placeholder="${esc(T.completeSearchPlaceholder)}" autocomplete="off"></div>
      <label class="pp-field">${esc(T.completeField)}
        <select data-pp-select></select>
      </label>
      <div data-pp-complete-list></div>
    </div>
  </div>`;

export function createProductProfileModule() {
  return {
    mount(host) {
      host.innerHTML = productProfilePageHtml();
      bindDomainAction(host);
      const show = (name) => {
        host.querySelector('[data-pp="cards"]').hidden = name !== 'cards';
        host.querySelector('[data-pp="new"]').hidden = name !== 'new';
        host.querySelector('[data-pp="complete"]').hidden = name !== 'complete';
        if (name === 'complete') loadComplete(host, host.querySelector('[data-pp-complete-search]')?.value.trim() || '');
      };
      host.addEventListener('click', (event) => {
        const view = event.target.closest?.('[data-pp-view]')?.dataset.ppView;
        if (view) return show(view);
        const back = event.target.closest?.('[data-pp-back]')?.dataset.ppBack;
        if (back) return show('cards');
        if (event.target.closest?.('[data-pp-close]') || event.target.matches?.('[data-pp-modal]')) {
          const modal = host.querySelector('[data-pp-modal]');
          if (modal) modal.hidden = true;
        }
      });
      const input = host.querySelector('[data-pp-search]');
      const completeSearch = host.querySelector('[data-pp-complete-search]');
      let timer = null;
      let completeTimer = null;
      input?.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q) showToast(T.searchingToast, { sticky: true });
        timer = setTimeout(() => loadSearch(host, q), 250);
      });
      completeSearch?.addEventListener('input', () => {
        clearTimeout(completeTimer);
        completeTimer = setTimeout(() => loadComplete(host, completeSearch.value.trim()), 250);
      });
      host.querySelector('[data-pp-results]')?.addEventListener('click', (event) => {
        const img = event.target.closest?.('img[data-pp-thumb]');
        if (img) {
          host.querySelector('[data-pp-large]').src = img.dataset.ppThumb;
          host.querySelector('[data-pp-modal]').hidden = false;
          return;
        }
        const row = event.target.closest?.('[data-pp-record-url]');
        if (row?.dataset.ppRecordUrl) window.open(row.dataset.ppRecordUrl, '_blank', 'noopener');
      });
    },
  };
}

async function loadSearch(host, q) {
  const results = host.querySelector('[data-pp-results]');
  const empty = host.querySelector('[data-pp-empty]');
  const count = host.querySelector('[data-pp-count]');
  if (!q) {
    results.innerHTML = '';
    empty.textContent = T.searchEmpty;
    empty.hidden = false;
    count.hidden = true;
    return;
  }
  try {
    const data = await api.get(`${PRODUCT_PROFILE_API.search}?q=${encodeURIComponent(q)}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    count.hidden = false;
    count.textContent = fill(T.searchFound, { count: items.length });
    empty.hidden = items.length > 0;
    empty.textContent = T.searchNone;
    results.innerHTML = items.map((item) => `
      <div class="pp-row" data-pp-record-url="${esc(item.recordUrl || '')}">
        ${item.hasSampleImage && item.imageUrl ? `<img class="pp-thumb" data-pp-thumb="${esc(item.imageUrl)}" src="${esc(item.imageUrl)}" alt="样例图">` : `<span class="pp-thumb pp-thumb-empty">${esc(T.noImage)}</span>`}
        <div class="pp-meta"><b>${esc(item.number)}</b><span>货号 ${esc(item.itemNo)} · 颜色 ${esc(item.color)} · 类别 ${esc(item.category)}</span></div>
      </div>`).join('');
    results.querySelectorAll('img[data-pp-thumb]').forEach((img) => {
      img.addEventListener('error', () => {
        img.hidden = true;
        const fallback = document.createElement('span');
        fallback.className = 'pp-thumb pp-thumb-empty';
        fallback.textContent = T.noImage;
        img.replaceWith(fallback);
      }, { once: true });
    });
  } catch {
    empty.hidden = false;
    empty.textContent = T.searchFailed;
    count.hidden = true;
  }
}

async function loadComplete(host, q = '') {
  const select = host.querySelector('[data-pp-select]');
  const hint = host.querySelector('[data-pp-complete-hint]');
  const list = host.querySelector('[data-pp-complete-list]');
  if (!select) return;
  // 首次读货品表可能要几秒：先给明确加载态，不能只留一个「无选项」空下拉。
  select.disabled = true;
  select.innerHTML = `<option value="">${esc(T.completeSelectLoading)}</option>`;
  hint.textContent = T.completeLoading;
  list.innerHTML = '';
  try {
    const data = await api.get(`${PRODUCT_PROFILE_API.incomplete}${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    if (!groups.length) {
      select.disabled = false;
      select.innerHTML = `<option value="">${esc(T.completeSelectPlaceholder)}</option>`;
      hint.textContent = q ? T.completeSearchEmpty : T.completeEmpty;
      return;
    }
    select.disabled = false;
    select.innerHTML = `<option value="">${esc(T.completeSelectPlaceholder)}</option>${groups.map((g, i) => `<option value="${i}">${esc(g.value)}（${g.count} 条）</option>`).join('')}`;
    select.value = '0';
    hint.textContent = fill(T.completeHint, { count: data?.total || 0 });
    const render = () => {
      const group = groups[Number(select.value)] || groups[0];
      list.innerHTML = (group?.items || []).map((item) => `
        <div class="pp-row"><span class="pp-number">${esc(item.number)}</span>
          <a class="pp-small-btn" href="${esc(item.recordUrl)}" target="_blank" rel="noopener">${esc(T.completeAction)}</a>
        </div>`).join('');
    };
    select.onchange = render;
    render();
  } catch {
    select.disabled = false;
    select.innerHTML = `<option value="">${esc(T.completeSelectPlaceholder)}</option>`;
    hint.textContent = T.incompleteFailed;
    list.innerHTML = '';
  }
}
