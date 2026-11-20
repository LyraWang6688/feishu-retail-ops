/**
 * 「配置 → 货品资料」页：
 *   · 货品上新：搜索替代自动查重；用户看结果和样例图自行判断，再去飞书表单；
 *   · 货品完善：按「商品信息缺失」实际值动态分组，选择分类查看记录；
 *   · 同步样例图：复用货品资料的存量同步动作（bindDomainAction）。
 */
import { api } from '../../core/api-client.js';
import { PRODUCT_PROFILE_API, PRODUCT_PROFILE_TEXTS as T } from '../../config/productProfile.js';
import { showToast } from '../shared/toast.js';
import { showPageError } from '../../core/ui.js';
import { bindDomainAction } from './dataConfigAction.js';
import { productIssueChipsOf } from '../shared/productIssues.js';
import { createAccessoryConfigModule } from './accessoryConfig.js';
import { createProductDelistedModule } from './productDelisted.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (values[k] == null ? '' : String(values[k])));
const COMPLETE_PAGE_SIZE = 40;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// ⭐ 2026-11-17（业务负责人）：缩略图**严格进入视口才请求**。
//   初始 `src` 用透明占位（不产生网络请求），URL 只存 `data-pp-thumb`；
//   IntersectionObserver 看到进入视口再赋给 `src`。
const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const thumbImgHtml = (url) => `<img class="pp-thumb" data-pp-thumb="${esc(url)}" decoding="async" src="${TRANSPARENT_PIXEL}" alt="样例图">`;

/** host → IntersectionObserver（每个货品资料页实例一个）。 */
const thumbObservers = new WeakMap();
const ensureThumbObserver = (host) => {
  let observer = thumbObservers.get(host);
  if (observer) return observer;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) loadThumb(host, entry.target);
    }
  }, { rootMargin: '0px', threshold: 0 });
  thumbObservers.set(host, observer);
  return observer;
};
const loadThumb = (host, img) => {
  if (!img || img.dataset.ppLoaded === '1') return;
  img.dataset.ppLoaded = '1';
  thumbObservers.get(host)?.unobserve(img);
  const url = img.dataset.ppThumb || '';
  if (url) img.src = url;
};
const observeThumbs = (host, root) => {
  const imgs = [...root.querySelectorAll('img[data-pp-thumb]')];
  if (!imgs.length) return;
  if (!('IntersectionObserver' in window)) {
    // 老 WebView 没有 IO ⇒ 退回“渲染即加载”（不会白图；新浏览器仍是严格视口加载）。
    imgs.forEach((img) => loadThumb(host, img));
    return;
  }
  const observer = ensureThumbObserver(host);
  imgs.forEach((img) => {
    if (img.dataset.ppLoaded !== '1') observer.observe(img);
  });
};
const resetThumbs = (host) => {
  const observer = thumbObservers.get(host);
  if (!observer) return;
  observer.disconnect();
  thumbObservers.delete(host);
};

const delistedModule = createProductDelistedModule({
  api, PRODUCT_PROFILE_API, T, esc, fill, COMPLETE_PAGE_SIZE, thumbImgHtml, resetThumbs, observeThumbs, showToast, showPageError,
});

const cardsHtml = () => `
  <div class="domain-cards">
    <button class="entry-card" type="button" data-pp-view="new"><span class="icon">🆕</span><h3>${esc(T.newTitle)}</h3></button>
    <button class="entry-card" type="button" data-pp-view="complete"><span class="icon">📝</span><h3>${esc(T.completeTitle)}</h3></button>
    <button class="entry-card" type="button" data-pp-view="delisted"><span class="icon">📤</span><h3>${esc(T.delistedTitle)}</h3></button>
    <button class="entry-card" type="button" data-domain-action="sample-image-sync"><span class="icon">🖼️</span><h3>${esc(T.sampleTitle)}</h3></button>
    <button class="entry-card" type="button" data-pp-view="accessory"><span class="icon">🛒</span><h3>${esc(T.accessoryTitle)}</h3></button>
  </div>
  <p class="placeholder-note" data-view="domain-action-note"></p>`;

export const productProfilePageHtml = () => `
  <div class="domain-page" data-page-kind="product-profile">
    <div data-pp="cards">${cardsHtml()}</div>
    <div data-pp="new" hidden>
      <div class="pp-head"><h2>${esc(T.newTitle)}</h2></div>
      <a class="pp-primary" href="${esc(T.formUrl)}" target="_blank" rel="noopener">${esc(T.newAction)}</a>
      <div class="pp-search"><input data-pp-search placeholder="${esc(T.searchPlaceholder)}" autocomplete="off"></div>
      <p class="pp-note" data-pp-count hidden></p>
      <div data-pp-results></div>
      <p class="pp-note" data-pp-empty>${esc(T.searchEmpty)}</p>
      <div class="pp-modal" data-pp-modal hidden><button type="button" data-pp-close>×</button><img data-pp-large alt="样例图大图"></div>
    </div>
    <div data-pp="complete" hidden>
      <div class="pp-head"><h2>${esc(T.completeTitle)}</h2></div>
      <div class="pp-search"><input data-pp-complete-search placeholder="${esc(T.completeSearchPlaceholder)}" autocomplete="off"></div>
      <p class="pp-note" data-pp-complete-search-count hidden></p>
      <div data-pp-complete-search-results hidden></div>
      <p class="pp-note" data-pp-complete-search-empty hidden></p>
      <p class="pp-note" data-pp-complete-hint></p>
      <div class="pp-tabs" data-pp-complete-tabs></div>
      <div data-pp-complete-list></div>
    </div>
    ${delistedModule.viewHtml()}
    <div data-pp="accessory" hidden></div>
  </div>`;

export function createProductProfileModule() {
  return {
    mount(host) {
      host.innerHTML = productProfilePageHtml();
      resetThumbs(host);
      bindDomainAction(host);
      let accessoryModule = null;
      const show = (name) => {
        host.querySelector('[data-pp="cards"]').hidden = name !== 'cards';
        host.querySelector('[data-pp="new"]').hidden = name !== 'new';
        host.querySelector('[data-pp="complete"]').hidden = name !== 'complete';
        host.querySelector('[data-pp="delisted"]').hidden = name !== 'delisted';
        host.querySelector('[data-pp="accessory"]').hidden = name !== 'accessory';
        if (name === 'accessory') {
          if (!accessoryModule) {
            accessoryModule = createAccessoryConfigModule();
            accessoryModule.mount(host.querySelector('[data-pp="accessory"]'));
          }
          return;
        }
        if (name === 'complete') {
          loadComplete(host);
          const q = host.querySelector('[data-pp-complete-search]')?.value.trim() || '';
          loadCompleteSearch(host, q);
        }
        if (name === 'delisted') delistedModule.load(host, '');
      };
      // ⭐ #1204：图片加载失败 → 变成「加载失败 · 点击重试」（不再冒充"无样例图"）。
      host.addEventListener('error', (event) => {
        const img = event.target?.closest?.('img[data-pp-thumb]');
        if (!img) return;
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'pp-thumb pp-thumb-empty pp-thumb-retry';
        retry.dataset.ppRetry = img.dataset.ppThumb || img.getAttribute('src') || '';
        retry.textContent = T.thumbFailed;
        img.replaceWith(retry);
      }, true);
      host.addEventListener('click', (event) => {
        const retry = event.target.closest?.('[data-pp-retry]');
        if (retry) {
          const url = retry.dataset.ppRetry || '';
          if (!url) return;
          const img = document.createElement('img');
          img.className = 'pp-thumb';
          img.alt = '样例图';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.dataset.ppThumb = url;
          img.dataset.ppLoaded = '1';
          img.src = `${url}${url.includes('?') ? '&' : '?'}r=${Date.now()}`;
          retry.replaceWith(img);
          return;
        }
        const view = event.target.closest?.('[data-pp-view]')?.dataset.ppView;
        if (view) return show(view);
        if (event.target.closest?.('[data-pp-close]') || event.target.matches?.('[data-pp-modal]')) {
          const modal = host.querySelector('[data-pp-modal]');
          if (modal) modal.hidden = true;
        }
      });
      const input = host.querySelector('[data-pp-search]');
      let timer = null;
      input?.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q) showToast(T.searchingToast, { sticky: true });
        timer = setTimeout(() => loadSearch(host, q), 250);
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
      const completeInput = host.querySelector('[data-pp-complete-search]');
      let completeTimer = null;
      completeInput?.addEventListener('input', () => {
        clearTimeout(completeTimer);
        const q = completeInput.value.trim();
        if (q) showToast(T.searchingToast, { sticky: true });
        completeTimer = setTimeout(() => loadCompleteSearch(host, q), 250);
      });
      host.querySelector('[data-pp-complete-search-results]')?.addEventListener('click', (event) => {
        if (event.target.closest?.('a')) return;
        const row = event.target.closest?.('[data-pp-record-url]');
        if (row?.dataset.ppRecordUrl) window.open(row.dataset.ppRecordUrl, '_blank', 'noopener');
      });
      delistedModule.bind(host);
    },
  };
}

const searchRowsHtml = (items, actionText = '') => (items || []).map((item) => {
  const chips = productIssueChipsOf(item);
  return `<div class="pp-row" data-pp-record-url="${esc(item.recordUrl || '')}">
    ${item.hasSampleImage && item.imageUrl ? thumbImgHtml(item.imageUrl) : `<span class="pp-thumb pp-thumb-empty">${esc(T.noImage)}</span>`}
    <div class="pp-meta"><b>${esc(item.number)}</b>${chips.length ? `<div class="pp-issues">${chips.map((issue) => `<span class="pp-issue">${esc(issue)}</span>`).join('')}</div>` : ''}</div>
    ${actionText ? `<a class="pp-small-btn" href="${esc(item.recordUrl || '')}" target="_blank" rel="noopener">${esc(actionText)}</a>` : ''}
  </div>`;
}).join('');

async function loadSearch(host, q) {
  const results = host.querySelector('[data-pp-results]');
  const empty = host.querySelector('[data-pp-empty]');
  const count = host.querySelector('[data-pp-count]');
  if (!q) {
    resetThumbs(host);
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
    results.innerHTML = searchRowsHtml(items);
    resetThumbs(host);
    observeThumbs(host, results);
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


async function loadComplete(host) {
  const hint = host.querySelector('[data-pp-complete-hint]');
  const tabs = host.querySelector('[data-pp-complete-tabs]');
  const list = host.querySelector('[data-pp-complete-list]');
  if (!tabs || !list) return;
  hint.textContent = T.completeLoading;
  resetThumbs(host);
  tabs.innerHTML = '';
  list.innerHTML = '';
  try {
    const data = await api.get(PRODUCT_PROFILE_API.completion);
    const dimensions = Array.isArray(data?.dimensions) ? data.dimensions : [];
    if (!dimensions.length) {
      hint.textContent = T.completeEmpty;
      return;
    }
    let active = dimensions.some((item) => item.key === host.__ppDimension) ? host.__ppDimension : dimensions[0].key;
    // ⭐ #1204：完整度列表**分页渲染**（默认 40 条）—— 不再一次铺 300+ 张图。
    let shown = COMPLETE_PAGE_SIZE;
    const render = () => {
      const dimension = dimensions.find((item) => item.key === active) || dimensions[0];
      tabs.innerHTML = dimensions.map((item) => `<button class="pp-tab ${item.key === active ? 'active' : ''}" type="button" data-pp-dimension="${esc(item.key)}"><b>${esc(item.label)}</b><span>${esc(fill(T.completeTabCount, { count: item.count || 0 }))}</span></button>`).join('');
      hint.textContent = fill(T.completeHint, { count: data?.total || 0 });
      const items = dimension.items || [];
      const visible = items.slice(0, shown);
      const more = items.length - visible.length;
      list.innerHTML = visible.map((item) => {
        const missing = item.key === 'sample' || dimension.key === 'sample'
          ? T.completeSampleMissing
          : `${T.completeMissingPrefix}${dimension.key === 'product' ? item.missingProduct : item.missingTag}`;
        return `<div class="pp-row"><span class="pp-thumb-wrap">${item.imageUrl ? thumbImgHtml(item.imageUrl) : `<span class="pp-thumb pp-thumb-empty">${esc(T.noImage)}</span>`}</span><div class="pp-meta"><b>${esc(item.number)}</b><span>${esc(missing)}</span></div><a class="pp-small-btn" href="${esc(item.recordUrl)}" target="_blank" rel="noopener">${esc(T.completeGo)}</a></div>`;
      }).join('') + (more > 0 ? `<div class="pp-more"><button class="btn small" type="button" data-pp-more>${esc(fill(T.more, { count: more }))}</button></div>` : '');
      resetThumbs(host);
      observeThumbs(host, list);
    };
    tabs.onclick = (event) => {
      const button = event.target.closest?.('[data-pp-dimension]');
      if (!button) return;
      active = button.dataset.ppDimension;
      host.__ppDimension = active;
      shown = COMPLETE_PAGE_SIZE;
      render();
    };
    list.onclick = (event) => {
      if (!event.target.closest?.('[data-pp-more]')) return;
      shown += COMPLETE_PAGE_SIZE;
      render();
    };
    render();
  } catch {
    hint.textContent = T.incompleteFailed;
    tabs.innerHTML = '';
    list.innerHTML = '';
  }
}
async function loadCompleteSearch(host, q) {
  const results = host.querySelector('[data-pp-complete-search-results]');
  const count = host.querySelector('[data-pp-complete-search-count]');
  const empty = host.querySelector('[data-pp-complete-search-empty]');
  const hint = host.querySelector('[data-pp-complete-hint]');
  const tabs = host.querySelector('[data-pp-complete-tabs]');
  const list = host.querySelector('[data-pp-complete-list]');
  if (!results || !count || !empty || !hint || !tabs || !list) return;

  const showDefault = () => {
    results.hidden = true;
    count.hidden = true;
    empty.hidden = true;
    hint.hidden = false;
    tabs.hidden = false;
    list.hidden = false;
  };
  if (!q) {
    showDefault();
    return;
  }

  hint.hidden = true;
  tabs.hidden = true;
  list.hidden = true;
  results.hidden = false;
  try {
    // 搜索范围 = 货品信息全量，不限制在「待完善」分组里；默认分组视图不变。
    const data = await api.get(`${PRODUCT_PROFILE_API.completion}?q=${encodeURIComponent(q)}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    count.hidden = false;
    count.textContent = fill(T.searchFound, { count: items.length });
    empty.hidden = items.length > 0;
    empty.textContent = T.completeSearchEmpty;
    results.innerHTML = searchRowsHtml(items, T.completeAction);
    resetThumbs(host);
    observeThumbs(host, results);
  } catch {
    results.innerHTML = '';
    count.hidden = true;
    empty.hidden = false;
    empty.textContent = T.searchFailed;
  }
}

