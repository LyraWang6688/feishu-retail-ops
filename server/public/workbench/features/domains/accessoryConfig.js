import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { showToast, showErrorToast } from '../shared/toast.js';
import { waitForAsyncJob } from '../shared/asyncJob.js';
import { ACCESSORY_CONFIG_API as API, ACCESSORY_CONFIG_TEXTS as T } from '../../config/accessoryConfig.js';

const submitKey = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`);

const fieldHtml = (label, input) => `<label class="ac-field"><span>${escapeHtml(label)}</span>${input}</label>`;

const optionHtml = (selected = '') => ['<option value="">' + escapeHtml(T.selectCategory) + '</option>']
  .concat(T.categories.map((name) => `<option${name === selected ? ' selected' : ''}>${escapeHtml(name)}</option>`))
  .join('');

const formHtml = () => `
  <form class="ac-form" data-ac-form>
    <h2 data-ac-form-title>${escapeHtml(T.addTitle)}</h2>
    <div class="ac-grid">
      ${fieldHtml(T.name + ' *', '<input class="input" data-ac-name autocomplete="off">')}
      ${fieldHtml(T.category, `<select class="input" data-ac-category>${optionHtml()}</select>`)}
      ${fieldHtml(T.price + ' *', '<input class="input" data-ac-price type="number" min="0" step="0.01" inputmode="decimal" placeholder="0.00">')}
      ${fieldHtml(T.cost, '<input class="input" data-ac-cost type="number" min="0" step="0.01" inputmode="decimal" placeholder="选填">')}
      ${fieldHtml(T.stockQuantity, '<input class="input" data-ac-stock type="number" min="0" step="1" inputmode="numeric" placeholder="选填">')}
      <div class="ac-field ac-field-full"><span>${escapeHtml(T.sampleImage)}</span><div class="ac-upload-row"><label class="ac-upload"><input data-ac-image type="file" accept="image/*" hidden><img data-ac-preview hidden alt="样例图预览"><span data-ac-upload-text>${escapeHtml(T.upload)}</span></label><small>${escapeHtml(T.imageHint)}</small></div></div>
    </div>
    <div class="ac-actions"><button class="btn primary" type="submit" data-ac-submit>${escapeHtml(T.submit)}</button><button class="btn" type="button" data-ac-cancel hidden>${escapeHtml(T.cancelEdit)}</button></div>
  </form>`;

export function createAccessoryConfigModule() {
  return {
    mount(host) {
      if (!host) return;
      host.innerHTML = `<div class="ac-page">${formHtml()}<section class="ac-list" data-ac-list><p class="ac-empty">${escapeHtml(T.loading)}</p></section></div>`;
      const form = host.querySelector('[data-ac-form]');
      const list = host.querySelector('[data-ac-list]');
      const nameInput = form.querySelector('[data-ac-name]');
      const categoryInput = form.querySelector('[data-ac-category]');
      const priceInput = form.querySelector('[data-ac-price]');
      const costInput = form.querySelector('[data-ac-cost]');
      const stockInput = form.querySelector('[data-ac-stock]');
      const imageInput = form.querySelector('[data-ac-image]');
      const preview = form.querySelector('[data-ac-preview]');
      const uploadText = form.querySelector('[data-ac-upload-text]');
      const submitButton = form.querySelector('[data-ac-submit]');
      const cancelButton = form.querySelector('[data-ac-cancel]');
      const title = form.querySelector('[data-ac-form-title]');
      let rows = [];
      let editingId = '';
      let imageToken = '';

      const showError = (message) => showErrorToast(message);
      const setBusy = (busy) => {
        submitButton.disabled = busy;
        submitButton.textContent = busy ? T.submitKey : (editingId ? T.save : T.submit);
      };
      const resetForm = () => {
        editingId = '';
        imageToken = '';
        form.reset();
        imageInput.value = '';
        preview.hidden = true;
        preview.removeAttribute('src');
        uploadText.hidden = false;
        uploadText.textContent = T.upload;
        title.textContent = T.addTitle;
        cancelButton.hidden = true;
        setBusy(false);
        showError('');
      };
      const categoryName = (row) => String(row.category || '').trim() || '未分类';
      const renderList = () => {
        if (!rows.length) {
          list.innerHTML = `<p class="ac-empty">${escapeHtml(T.empty)}</p>`;
          return;
        }
        const groups = new Map();
        for (const row of rows) {
          const key = categoryName(row);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(row);
        }
        list.innerHTML = [...groups.entries()].map(([category, items]) => `
          <section class="ac-group"><h3>${escapeHtml(category)} <span>${items.length}</span></h3>
            <div class="ac-cards">${items.map((row) => `
              <article class="ac-card" data-ac-row="${escapeHtml(row.recordId)}">
                <div class="ac-thumb">${row.hasSampleImage ? `<img src="${escapeHtml(row.sampleImageUrl)}" alt="" loading="lazy">` : '<span>🛍️</span>'}</div>
                <div class="ac-main"><strong>${escapeHtml(row.name)}</strong><div class="ac-meta"><span>¥${escapeHtml(row.price ?? '—')}</span><span>${escapeHtml(T.stock.replace('{count}', row.stockQuantity ?? '—'))}</span></div></div>
                <div class="ac-row-actions"><button class="mini" type="button" data-ac-edit="${escapeHtml(row.recordId)}">${escapeHtml(T.edit)}</button><button class="mini danger" type="button" data-ac-delete="${escapeHtml(row.recordId)}">${escapeHtml(T.remove)}</button></div>
              </article>`).join('')}</div>
          </section>`).join('');
      };
      const load = async () => {
        try {
          const data = await api.get(API.list);
          rows = Array.isArray(data?.rows) ? data.rows : [];
          renderList();
        } catch {
          list.innerHTML = `<p class="ac-empty">${escapeHtml(T.loadFailed)}</p>`;
        }
      };
      const waitAccepted = async (result) => {
        if (result?.toast) showToast(result.toast);
        const jobId = String(result?.job_id || '').trim();
        if (jobId) await waitForAsyncJob(jobId);
      };
      const editRow = (recordId) => {
        const row = rows.find((item) => item.recordId === recordId);
        if (!row) return;
        editingId = recordId;
        imageToken = '';
        nameInput.value = row.name || '';
        categoryInput.value = row.category || '';
        priceInput.value = row.price ?? '';
        costInput.value = row.cost ?? '';
        stockInput.value = row.stockQuantity ?? '';
        title.textContent = T.editTitle;
        submitButton.textContent = T.save;
        cancelButton.hidden = false;
        preview.hidden = !row.hasSampleImage;
        if (row.hasSampleImage) preview.src = row.sampleImageUrl;
        uploadText.hidden = row.hasSampleImage;
        showError('');
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      imageInput.addEventListener('change', async () => {
        const file = imageInput.files?.[0];
        if (!file) return;
        uploadText.hidden = false;
        uploadText.textContent = T.uploading;
        submitButton.disabled = true;
        try {
          const result = await api.postRaw(API.upload, file);
          imageToken = String(result?.file?.file_token || '').trim();
          preview.src = URL.createObjectURL(file);
          preview.hidden = false;
          uploadText.hidden = true;
        } catch {
          showError(T.uploadFailed);
          imageInput.value = '';
        } finally {
          uploadText.textContent = T.upload;
          setBusy(false);
        }
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = nameInput.value.trim();
        const price = Number(priceInput.value);
        const category = categoryInput.value;
        if (!name) return showError(T.nameRequired);
        if (priceInput.value === '' || !Number.isFinite(price) || price < 0) return showError(T.priceRequired);
        const duplicate = rows.find((row) => row.recordId !== editingId
          && categoryName(row) === (category || '未分类')
          && row.name.trim().toLowerCase() === name.toLowerCase());
        if (duplicate) return showError(T.duplicate);
        setBusy(true);
        showError('');
        const wasEditing = Boolean(editingId);
        try {
          const body = {
            name,
            category,
            price,
            cost: costInput.value,
            stockQuantity: stockInput.value,
            submitKey: submitKey(),
          };
          if (imageToken) body.sampleImageToken = imageToken;
          const result = editingId
            ? await api.patch(API.update(editingId), body)
            : await api.post(API.create, body);
          await waitAccepted(result);
          await load();
          resetForm();
          showToast(wasEditing ? T.updated : T.added);
        } catch (error) {
          setBusy(false);
          showError(error?.message || T.saveFailed);
        }
      });
      cancelButton.addEventListener('click', () => resetForm());
      host.addEventListener('click', async (event) => {
        const edit = event.target.closest?.('[data-ac-edit]');
        if (edit) { editRow(edit.dataset.acEdit); return; }
        const remove = event.target.closest?.('[data-ac-delete]');
        if (!remove) return;
        if (!window.confirm(T.deleteConfirm)) return;
        try {
          await waitAccepted(await api.delete(API.remove(remove.dataset.acDelete), { submitKey: submitKey() }));
          await load();
          showToast(T.removed);
        } catch (error) {
          showError(error?.message || T.deleteFailed);
        }
      });
      void load();
    },
  };
}
