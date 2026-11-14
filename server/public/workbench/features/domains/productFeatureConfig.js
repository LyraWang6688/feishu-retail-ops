import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { PRODUCT_FEATURES_API, PRODUCT_FEATURES_TEXTS as T } from '../../config/productFeatures.js';
import { showToast } from '../shared/toast.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (m, key) => (values[key] == null ? '' : String(values[key])));
const usageText = (usage) => fill(T.usage, { count: Number(usage) || 0 });

const rowHtml = (dimension, item, editing) => {
  if (editing && editing.key === dimension.key && editing.recordId === item.recordId) {
    return `<div class="pf-row pf-row-editing"><input class="pf-edit-input" data-feature-edit-input="${escapeHtml(dimension.key)}" value="${escapeHtml(item.tag)}" autocomplete="off"><button class="btn small primary" type="button" data-feature-save="${escapeHtml(dimension.key)}" data-record-id="${escapeHtml(item.recordId)}">${escapeHtml(T.save)}</button><button class="btn small" type="button" data-feature-cancel>${escapeHtml(T.cancel)}</button></div>`;
  }
  return `<div class="pf-row"><span class="pf-tag-name">${escapeHtml(item.tag)}</span><span class="pf-usage">${escapeHtml(usageText(item.usage))}</span><button class="pf-mini" type="button" data-feature-edit="${escapeHtml(dimension.key)}" data-record-id="${escapeHtml(item.recordId)}" data-tag="${escapeHtml(item.tag)}">${escapeHtml(T.edit)}</button><button class="pf-mini danger" type="button" data-feature-remove="${escapeHtml(dimension.key)}" data-record-id="${escapeHtml(item.recordId)}" data-tag="${escapeHtml(item.tag)}">${escapeHtml(T.remove)}</button></div>`;
};

const sectionHtml = (dimension, editing) => `
  <section class="pf-section" data-feature-key="${escapeHtml(dimension.key)}">
    <div class="pf-add"><input data-feature-input="${escapeHtml(dimension.key)}" placeholder="${escapeHtml(T.addPlaceholder)}" autocomplete="off"><button class="btn small primary" type="button" data-feature-add="${escapeHtml(dimension.key)}">${escapeHtml(T.add)}</button></div>
    <div class="pf-list">${(dimension.items || []).map((item) => rowHtml(dimension, item, editing)).join('') || `<p class="pf-empty">${escapeHtml(T.empty)}</p>`}</div>
    <p class="pf-error" data-feature-error="${escapeHtml(dimension.key)}" hidden></p>
  </section>`;

const panelHtml = (dimensions, editing, deleting, activeKey) => {
  const active = dimensions.find((dimension) => dimension.key === activeKey) || dimensions[0];
  return `
  <div class="pf-head"><button class="pp-back" type="button" data-feature-back>${escapeHtml(T.back)}</button><h2>${escapeHtml(T.title)}</h2></div>
  <div class="pp-tabs">${dimensions.map((dimension) => `<button class="pp-tab ${dimension.key === active?.key ? 'active' : ''}" type="button" data-feature-tab="${escapeHtml(dimension.key)}"><b>${escapeHtml(dimension.label)}</b><span>${escapeHtml(fill(T.count, { count: dimension.count || 0 }))}</span></button>`).join('')}</div>
  <div data-feature-sections>${active ? sectionHtml(active, editing) : ''}</div>
  ${deleting ? `<div class="pf-modal"><div class="pf-modal-card"><h3>${escapeHtml(T.deleteTitle)}</h3><p>${escapeHtml(fill(T.deleteHint, { table: deleting.tableName }))}</p><p class="pf-modal-tag">${escapeHtml(deleting.tag)}</p><div class="pf-modal-actions"><button class="btn" type="button" data-feature-delete-cancel>${escapeHtml(T.cancel)}</button><button class="btn danger" type="button" data-feature-delete-confirm>${escapeHtml(T.confirmDelete)}</button></div></div></div>` : ''}`;
};

export function openProductFeatureConfig(host) {
  if (!host) return;
  const cards = host.querySelector('.domain-cards');
  const note = host.querySelector('.placeholder-note');
  const old = host.querySelector('[data-view="product-feature-config"]');
  if (old) old.remove();
  const panel = document.createElement('div');
  panel.dataset.view = 'product-feature-config';
  host.append(panel);
  if (cards) cards.classList.add('hidden');
  if (note) note.classList.add('hidden');
  panel.hidden = false;
  panel.innerHTML = `<p class="pf-empty">${escapeHtml(T.loading)}</p>`;
  let dimensions = [];
  let activeKey = '';
  let editing = null;
  let deleting = null;
  const close = () => {
    panel.hidden = true;
    if (cards) cards.classList.remove('hidden');
    if (note) note.classList.remove('hidden');
  };
  const render = () => {
    panel.innerHTML = panelHtml(dimensions, editing, deleting, activeKey);
    const input = panel.querySelector('.pf-edit-input');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  };
  const load = async () => {
    try {
      const data = await api.get(PRODUCT_FEATURES_API.list);
      dimensions = Array.isArray(data?.dimensions) ? data.dimensions : [];
      if (!dimensions.some((dimension) => dimension.key === activeKey)) activeKey = dimensions[0]?.key || '';
      editing = null;
      deleting = null;
      render();
    } catch {
      panel.innerHTML = `<div class="pf-head"><button class="pp-back" type="button" data-feature-back>${escapeHtml(T.back)}</button><h2>${escapeHtml(T.title)}</h2></div><p class="pf-empty">${escapeHtml(T.loadFailed)}</p>`;
    }
  };
  const showError = (key, text) => {
    const error = panel.querySelector(`[data-feature-error="${key}"]`);
    if (error) { error.textContent = text; error.hidden = false; }
  };
  const dimensionOf = (key) => dimensions.find((item) => item.key === key);
  const duplicates = (key, value, exceptRecordId = '') => (dimensionOf(key)?.items || [])
    .some((item) => item.recordId !== exceptRecordId && item.tag.toLowerCase() === value.toLowerCase());
  panel.addEventListener('click', async (event) => {
    if (event.target.closest?.('[data-feature-back]')) { close(); return; }
    const tab = event.target.closest?.('[data-feature-tab]');
    if (tab) { activeKey = tab.dataset.featureTab; editing = null; deleting = null; render(); return; }
    if (event.target.closest?.('[data-feature-cancel]')) { editing = null; render(); return; }
    if (event.target.closest?.('[data-feature-delete-cancel]')) { deleting = null; render(); return; }
    const editButton = event.target.closest?.('[data-feature-edit]');
    if (editButton) {
      editing = { key: editButton.dataset.featureEdit, recordId: editButton.dataset.recordId, tag: editButton.dataset.tag };
      deleting = null;
      render();
      return;
    }
    const removeButton = event.target.closest?.('[data-feature-remove]');
    if (removeButton) {
      const dimension = dimensions.find((item) => item.key === removeButton.dataset.featureRemove);
      deleting = { key: removeButton.dataset.featureRemove, recordId: removeButton.dataset.recordId, tag: removeButton.dataset.tag, tableName: dimension?.label || '' };
      editing = null;
      render();
      return;
    }
    const saveButton = event.target.closest?.('[data-feature-save]');
    if (saveButton) {
      const key = saveButton.dataset.featureSave;
      const value = String(panel.querySelector('.pf-edit-input')?.value || '').trim();
      if (!value) return showError(key, T.addPlaceholder);
      if (duplicates(key, value, saveButton.dataset.recordId)) return showError(key, T.duplicate);
      const originalText = saveButton.textContent;
      saveButton.disabled = true;
      saveButton.textContent = T.saving;
      try {
        await api.patch(PRODUCT_FEATURES_API.update(key, saveButton.dataset.recordId), { tag: value });
        await load();
        showToast(T.updatedToast);
      } catch (err) {
        saveButton.disabled = false;
        saveButton.textContent = originalText;
        showError(key, err?.message || T.updateFailed);
      }
      return;
    }
    if (event.target.closest?.('[data-feature-delete-confirm]')) {
      if (!deleting) return;
      const confirmButton = event.target.closest('[data-feature-delete-confirm]');
      const originalText = confirmButton?.textContent || T.confirmDelete;
      if (confirmButton) {
        confirmButton.disabled = true;
        confirmButton.textContent = T.removing;
      }
      try {
        await api.delete(PRODUCT_FEATURES_API.remove(deleting.key, deleting.recordId));
        await load();
        showToast(T.removedToast);
      } catch (err) {
        if (confirmButton) {
          confirmButton.disabled = false;
          confirmButton.textContent = originalText;
        }
        showError(deleting.key, err?.message || T.deleteFailed);
      }
      return;
    }
    const addButton = event.target.closest?.('[data-feature-add]');
    if (!addButton || addButton.disabled) return;
    const key = addButton.dataset.featureAdd;
    const value = String(panel.querySelector(`[data-feature-input="${key}"]`)?.value || '').trim();
    if (!value) return showError(key, T.addPlaceholder);
    if (duplicates(key, value)) return showError(key, T.duplicate);
    addButton.disabled = true;
    const original = addButton.textContent;
    addButton.textContent = T.adding;
    try {
      await api.post(PRODUCT_FEATURES_API.add(key), { tag: value });
      await load();
      showToast(T.addedToast);
    } catch (err) {
      addButton.disabled = false;
      addButton.textContent = original;
      showError(key, err?.message || T.addFailed);
    }
  });
  void load();
}
