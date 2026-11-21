/** 「货品资料 → 货品下架」子视图：搜索 / 加载更多 / 异步下架确认。 */
import { waitForAsyncJob } from '../shared/asyncJob.js';

export const createProductDelistedModule = ({
  api, PRODUCT_PROFILE_API, T, esc, fill, COMPLETE_PAGE_SIZE, thumbImgHtml, resetThumbs, observeThumbs, showToast, showPageError,
}) => {
  const rowsHtml = (items) => (items || []).map((item) => `
    <div class="pp-row" data-pp-delisted-row="${esc(item.recordId)}">
      ${item.hasSampleImage && item.imageUrl ? thumbImgHtml(item.imageUrl) : `<span class="pp-thumb pp-thumb-empty">${esc(T.noImage)}</span>`}
      <div class="pp-meta"><b>${esc(item.number)}</b><span>${esc(item.itemNo)}</span></div>
      <button class="pp-small-btn pp-danger-btn" type="button" data-pp-delete="${esc(item.recordId)}" data-pp-delete-number="${esc(item.number)}" data-pp-has-sample="${item.hasSampleImage ? '1' : '0'}">${esc(T.delistedDelete)}</button>
    </div>`).join('');

  const viewHtml = () => `
    <div data-pp="delisted" hidden>
      <div class="pp-head"><h2>${esc(T.delistedTitle)}</h2></div>
      <div class="pp-search"><input data-pp-delisted-search placeholder="${esc(T.delistedSearchPlaceholder)}" autocomplete="off"></div>
      <p class="pp-note" data-pp-delisted-count hidden></p>
      <div data-pp-delisted-list></div>
      <p class="pp-note" data-pp-delisted-empty hidden></p>
      <div class="pp-delete-modal" data-pp-delete-modal hidden>
        <div class="pp-delete-card">
          <h3>${esc(T.delistedDeleteTitle)}</h3>
          <p class="pp-note" data-pp-delete-number></p>
          <p class="pp-note" data-pp-delete-warning></p>
          <p class="pp-note" data-pp-delete-sample></p>
          <div class="pp-delete-actions">
            <button class="btn" type="button" data-pp-delete-cancel>${esc(T.delistedDeleteCancel)}</button>
            <button class="btn danger" type="button" data-pp-delete-confirm>${esc(T.delistedDeleteConfirm)}</button>
          </div>
        </div>
      </div>
    </div>`;

  const load = async (host, q = '') => {
    const list = host.querySelector('[data-pp-delisted-list]');
    const count = host.querySelector('[data-pp-delisted-count]');
    const empty = host.querySelector('[data-pp-delisted-empty]');
    if (!list || !count || !empty) return;
    host.__ppDelistedQuery = q;
    host.__ppDelistedShown = COMPLETE_PAGE_SIZE;
    try {
      const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
      const data = await api.get(`${PRODUCT_PROFILE_API.delisted}${suffix}`);
      const remote = Array.isArray(data?.items) ? data.items : [];
      const seen = new Set(remote.map((item) => item.recordId));
      // 已提交但后端已下架的货品，在当前页面继续保留（直到用户刷新/离开）。
      const local = [...(host.__ppDelistedLocal?.values() || [])]
        .filter((item) => !seen.has(item.recordId))
        .filter((item) => !q || String(item.itemNo || '').toLowerCase().includes(q.toLowerCase()));
      host.__ppDelistedItems = remote.concat(local);
      render(host);
    } catch {
      host.__ppDelistedItems = [];
      list.innerHTML = '';
      count.hidden = true;
      empty.hidden = false;
      empty.textContent = T.searchFailed;
    }
  };

  const render = (host) => {
    const list = host.querySelector('[data-pp-delisted-list]');
    const count = host.querySelector('[data-pp-delisted-count]');
    const empty = host.querySelector('[data-pp-delisted-empty]');
    if (!list || !count || !empty) return;
    const items = host.__ppDelistedItems || [];
    const shown = host.__ppDelistedShown || COMPLETE_PAGE_SIZE;
    const visible = items.slice(0, shown);
    const more = items.length - visible.length;
    list.innerHTML = rowsHtml(visible)
      + (more > 0 ? `<div class="pp-more"><button class="btn small" type="button" data-pp-delisted-more>${esc(fill(T.more, { count: more }))}</button></div>` : '');
    count.hidden = false;
    count.textContent = fill(T.delistedHint, { count: items.length });
    empty.hidden = items.length > 0;
    empty.textContent = host.__ppDelistedQuery ? T.delistedSearchEmpty : T.delistedEmpty;
    resetThumbs(host);
    observeThumbs(host, list);
    for (const [recordId, status] of (host.__ppDelistedStates || [])) {
      setRowState(host, recordId, status);
    }
  };

  const closeModal = (host) => {
    const modal = host.querySelector('[data-pp-delete-modal]');
    if (modal) modal.hidden = true;
    host.__ppDelistSelection = null;
  };

  const openModal = (host, button) => {
    const confirmButton = host.querySelector('[data-pp-delete-confirm]');
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.textContent = T.delistedDeleteConfirm;
    }
    host.__ppDelistSelection = {
      recordId: button.dataset.ppDelete || '',
      number: button.dataset.ppDeleteNumber || '',
      hasSampleImage: button.dataset.ppHasSample === '1',
      submitKey: globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    };
    if (!host.__ppDelistSelection.recordId) return;
    host.querySelector('[data-pp-delete-number]').textContent = `编号：${host.__ppDelistSelection.number}`;
    host.querySelector('[data-pp-delete-warning]').textContent = `${T.delistedDeleteWarning}${T.delistedDeleteIrreversible}`;
    host.querySelector('[data-pp-delete-sample]').textContent = host.__ppDelistSelection.hasSampleImage
      ? T.delistedDeleteSample : T.delistedDeleteNoSample;
    const modal = host.querySelector('[data-pp-delete-modal]');
    if (modal) modal.hidden = false;
  };

  const setRowState = (host, recordId, status) => {
    const row = host.querySelector('[data-pp-delisted-row="' + recordId + '"]');
    const button = row?.querySelector('[data-pp-delete]');
    if (!button) return;
    host.__ppDelistedStates = host.__ppDelistedStates || new Map();
    host.__ppDelistedStates.set(recordId, status);
    const done = status === 'succeeded';
    const pending = status === 'pending';
    button.disabled = pending || done;
    button.textContent = pending ? T.delistedDeleting
      : (done ? T.delistedDeleted
        : (status === 'failed' ? T.delistedRetry : T.delistedDelete));
    row.dataset.ppState = status;
  };

  const confirm = async (host) => {
    const item = host.__ppDelistSelection;
    if (!item?.recordId) return;
    host.__ppDelistSelection = null;
    host.__ppDelistedLocal = host.__ppDelistedLocal || new Map();
    host.__ppDelistedLocal.set(item.recordId, item);
    closeModal(host);
    setRowState(host, item.recordId, 'pending');
    showPageError('');
    try {
      const accepted = await api.delete(PRODUCT_PROFILE_API.product(item.recordId), {
        allowNoSample: !item.hasSampleImage,
        submitKey: item.submitKey,
      });
      if (accepted?.toast) showToast(accepted.toast);
      if (accepted?.job_id) await waitForAsyncJob(accepted.job_id);
      setRowState(host, item.recordId, 'succeeded');
    } catch (error) {
      setRowState(host, item.recordId, 'failed');
      const code = String(error?.message || '');
      const message = code === 'product_not_delisted' ? T.delistedNotDelisted
        : (code === 'archive_failed' ? T.delistedArchiveFailed
          : (code === 'no_sample_image' ? T.delistedNoSample : T.delistedDeleteFailed));
      showPageError(message);
    }
  };

  const bind = (host) => {
    const input = host.querySelector('[data-pp-delisted-search]');
    let timer = null;
    input?.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q) showToast(T.searchingToast, { sticky: true });
      timer = setTimeout(() => load(host, q), 250);
    });
    host.querySelector('[data-pp-delisted-list]')?.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-pp-delisted-more]')) {
        host.__ppDelistedShown = (host.__ppDelistedShown || COMPLETE_PAGE_SIZE) + COMPLETE_PAGE_SIZE;
        render(host);
        return;
      }
      const button = event.target.closest?.('[data-pp-delete]');
      if (button) openModal(host, button);
    });
    host.querySelector('[data-pp-delete-cancel]')?.addEventListener('click', () => closeModal(host));
    host.querySelector('[data-pp-delete-modal]')?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeModal(host);
    });
    host.querySelector('[data-pp-delete-confirm]')?.addEventListener('click', () => confirm(host));
  };

  return { viewHtml, bind, load };
};
