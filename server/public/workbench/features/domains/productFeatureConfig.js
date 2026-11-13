import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { PRODUCT_FEATURES_API, PRODUCT_FEATURES_TEXTS as T } from '../../config/productFeatures.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));

const tagChip = (tag) => `<span class="pf-tag">${escapeHtml(tag)}</span>`;

const sectionHtml = (dimension) => `
  <section class="pf-section" data-feature-key="${escapeHtml(dimension.key)}">
    <div class="pf-section-head"><h3>${escapeHtml(dimension.label)}</h3><span class="pf-count">${escapeHtml(fill(T.count, { count: dimension.count || 0 }))}</span></div>
    <div class="pf-tags">${(dimension.items || []).map((item) => tagChip(item.tag)).join('') || `<p class="pf-empty">${escapeHtml(T.empty)}</p>`}</div>
    <div class="pf-add"><input data-feature-input="${escapeHtml(dimension.key)}" placeholder="${escapeHtml(T.addPlaceholder)}" autocomplete="off"><button class="btn small primary" type="button" data-feature-add="${escapeHtml(dimension.key)}">${escapeHtml(T.add)}</button></div>
    <p class="pf-error" data-feature-error="${escapeHtml(dimension.key)}" hidden></p>
  </section>`;

const panelHtml = (dimensions) => `
  <div class="pf-head"><button class="pp-back" type="button" data-feature-back>${escapeHtml(T.back)}</button><h2>${escapeHtml(T.title)}</h2></div>
  <div data-feature-sections>${dimensions.map(sectionHtml).join('')}</div>`;

export function openProductFeatureConfig(host) {
  if (!host) return;
  const cards = host.querySelector('.domain-cards');
  const note = host.querySelector('.placeholder-note');
  const old = host.querySelector('[data-view="product-feature-config"]');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.dataset.view = 'product-feature-config';
  host.append(panel);
  if (cards) cards.hidden = true;
  if (note) note.hidden = true;
  panel.hidden = false;
  panel.innerHTML = `<p class="pf-empty">${escapeHtml(T.loading)}</p>`;
  const close = () => {
    panel.hidden = true;
    if (cards) cards.hidden = false;
    if (note) note.hidden = false;
  };
  let dimensions = [];
  const render = () => { panel.innerHTML = panelHtml(dimensions); };
  const load = async () => {
    try {
      const data = await api.get(PRODUCT_FEATURES_API.list);
      dimensions = Array.isArray(data?.dimensions) ? data.dimensions : [];
      render();
    } catch {
      panel.innerHTML = `<div class="pf-head"><button class="pp-back" type="button" data-feature-back>${escapeHtml(T.back)}</button><h2>${escapeHtml(T.title)}</h2></div><p class="pf-empty">${escapeHtml(T.loadFailed)}</p>`;
    }
  };
  panel.addEventListener('click', async (event) => {
    if (event.target.closest?.('[data-feature-back]')) {
      close();
      return;
    }
    const button = event.target.closest?.('[data-feature-add]');
    if (!button || button.disabled) return;
    const key = button.dataset.featureAdd;
    const input = panel.querySelector(`[data-feature-input="${key}"]`);
    const error = panel.querySelector(`[data-feature-error="${key}"]`);
    const value = String(input?.value || '').trim();
    const dimension = dimensions.find((item) => item.key === key);
    const showError = (text) => { if (error) { error.textContent = text; error.hidden = false; } };
    if (error) error.hidden = true;
    if (!value) return showError(T.addPlaceholder);
    if ((dimension?.items || []).some((item) => item.tag.toLowerCase() === value.toLowerCase())) {
      return showError(T.duplicate);
    }
    button.disabled = true;
    const original = button.textContent;
    button.textContent = T.adding;
    try {
      await api.post(PRODUCT_FEATURES_API.add(key), { tag: value });
      await load();
    } catch (err) {
      showError(err?.message || T.addFailed);
      button.disabled = false;
      button.textContent = original;
    }
  });
  void load();
}
