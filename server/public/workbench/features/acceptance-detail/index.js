/**
 * 2026-11-19：采购验收独立明细页。
 * 批次列表点「验收」跳到这里；本页只负责明细、数量合计、自定义尺码和提交。
 * 写入口仍是既有 POST /purchase/arrivals/accept，不新开写库路径。
 */
import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { describeError, showPageError } from '../../core/ui.js';
import { showToast } from '../shared/toast.js';
import {
  arrivalDocFieldHtml, updateArrivalDocHint, uploadArrivalDocuments,
  validateArrivalDocuments, arrivalSubmitLines, sampleChoiceProducts, compareArrivalProducts,
} from '../orders/acceptanceDoc.js';
import { openSampleChoiceModal } from '../orders/sampleChoice.js';
import { ARRIVAL_CONFIRM, ARRIVAL_FULL_API, ARRIVAL_FULL_TEXTS, ORDERS_TEXTS } from '../../config/orders.js';

const fill = (text, values = {}) => String(text || '').replace(/\{(\w+)\}/g, (match, key) => (
  Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match
));
const asQuantity = (value) => {
  const text = String(value ?? '').trim();
  if (text === '') return null;
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : null;
};
const sizeText = (value) => String(value ?? '').trim();

const groupRows = (rows) => {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.productId)) {
      groups.set(row.productId, {
        productId: row.productId,
        itemNo: row.itemNo,
        color: row.color,
        number: row.number,
        delisted: row.delisted === true,
        delistedLabel: row.delisted_label || '',
        rows: [],
      });
    }
    groups.get(row.productId).rows.push(row);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      rows: group.rows.slice().sort((left, right) => Number(left.size) - Number(right.size)),
    }))
    .sort(compareArrivalProducts);
};

const groupLabel = (group) => {
  const label = [group.itemNo, group.color].filter(Boolean).join(' · ')
    || group.number || ARRIVAL_FULL_TEXTS.detailGroupUnknown;
  return group.delisted ? label + '（' + (group.delistedLabel || '已下架') + '）' : label;
};

const rowHtml = (row) => {
  const label = escapeHtml(String(row.size ?? ''));
  const actual = row.actual == null ? '' : String(row.actual);
  const stepper = '<div class="pr-stepper">'
    + '<button type="button" data-action="arrival-step" data-delta="-1" data-row-uid="' + escapeHtml(row.uid) + '">−</button>'
    + '<input class="pr-qty line-actual" data-field="arrival-actual" data-row-uid="' + escapeHtml(row.uid) + '"'
    + ' inputmode="numeric" value="' + escapeHtml(actual) + '" aria-label="' + escapeHtml(ARRIVAL_FULL_TEXTS.actualQuantityLabel) + '">'
    + '<button type="button" data-action="arrival-step" data-delta="1" data-row-uid="' + escapeHtml(row.uid) + '">+</button>'
    + '</div>';
  if (row.custom) {
    return '<div class="arrival-custom-row" data-row-uid="' + escapeHtml(row.uid) + '">'
      + '<input class="arrival-custom-size" data-field="custom-size" data-row-uid="' + escapeHtml(row.uid) + '"'
      + ' inputmode="numeric" value="' + label + '" placeholder="' + escapeHtml(ARRIVAL_FULL_TEXTS.customSizeLabel) + '"'
      + ' aria-label="' + escapeHtml(ARRIVAL_FULL_TEXTS.customSizeLabel) + '">'
      + stepper
      + '<button class="del" type="button" data-remove-size="' + escapeHtml(row.uid) + '">删</button>'
      + '</div>';
  }
  return '<div class="pr-size-row arrival-size-row" data-row-uid="' + escapeHtml(row.uid) + '">'
    + '<div class="pr-size-row-head"><div class="pr-size">' + label + '</div>'
    + '<small class="arrival-declared">' + escapeHtml(fill(ARRIVAL_FULL_TEXTS.summaryExpected, { count: row.declared })) + '</small></div>'
    + stepper
    + '</div>';
};

const productsHtml = (groups, checkedProducts = new Set()) => groups.map((group) => {
  const rows = group.rows.map(rowHtml).join('');
  const checked = checkedProducts.has(group.productId);
  return '<section class="pr-group arrival-product' + (checked ? ' is-checked' : '') + '" data-product-id="' + escapeHtml(group.productId) + '">'
    + '<div class="pr-group-head"><div class="arrival-title-wrap">'
    + '<label class="arrival-verify"><input type="checkbox" data-arrival-verify="' + escapeHtml(group.productId) + '"'
    + ' aria-label="' + escapeHtml(ARRIVAL_FULL_TEXTS.checkedLabel) + '"' + (checked ? ' checked' : '') + '></label>'
    + '<h2 class="pr-group-name">' + escapeHtml(groupLabel(group)) + '</h2></div>'
    + '<button class="btn small" type="button" data-add-size="' + escapeHtml(group.productId) + '">'
    + escapeHtml(ARRIVAL_FULL_TEXTS.addSize) + '</button></div>'
    + '<div class="pr-size-grid" data-view="arrival-size-rows">' + rows + '</div></section>';
}).join('');

const previewStatusOf = (row) => {
  const declared = Math.max(0, Number(row?.declared) || 0);
  const arrived = Math.max(0, Number(row?.actual) || 0);
  if (row?.custom) return { key: 'extra', expected: 0, actual: 0, extra: arrived };
  if (arrived > declared) return { key: 'extra', expected: declared, actual: declared, extra: arrived - declared };
  if (arrived < declared) return { key: 'short', expected: declared, actual: arrived, extra: 0 };
  return { key: 'match', expected: declared, actual: arrived, extra: 0 };
};

const previewRowHtml = (row) => {
  const status = previewStatusOf(row);
  const size = sizeText(row.size);
  const name = row.custom ? (size ? size + ' · ' + ARRIVAL_FULL_TEXTS.previewCustom : ARRIVAL_FULL_TEXTS.previewCustom) : size;
  const label = { match: ARRIVAL_FULL_TEXTS.previewMatch, short: ARRIVAL_FULL_TEXTS.previewShort, extra: ARRIVAL_FULL_TEXTS.previewExtra }[status.key];
  return '<div class="arrival-preview-row is-' + status.key + '" data-preview-status="' + status.key + '">'
    + '<div class="arrival-preview-line"><b>' + escapeHtml(name) + '</b><span class="arrival-preview-tag">' + escapeHtml(label) + '</span></div>'
    + '<div class="arrival-preview-meta"><span>' + escapeHtml(fill(ARRIVAL_FULL_TEXTS.previewExpected, { count: status.expected })) + '</span>'
    + '<span>' + escapeHtml(fill(ARRIVAL_FULL_TEXTS.previewActual, { count: status.actual })) + '</span>'
    + '<span>' + escapeHtml(fill(ARRIVAL_FULL_TEXTS.previewExtraCount, { count: status.extra })) + '</span></div>'
    + '</div>';
};

const previewHtml = (groups) => (groups.length ? groups.map((group) => '<section class="arrival-preview-group" data-product-id="' + escapeHtml(group.productId) + '">'
  + '<h2 class="pr-group-name">' + escapeHtml(groupLabel(group)) + '</h2>'
  + group.rows.map(previewRowHtml).join('')
  + '</section>').join('') : '<p class="empty">' + escapeHtml(ARRIVAL_FULL_TEXTS.previewEmpty) + '</p>');

const shellHtml = () => '<div class="pr-sticky-head arrival-sticky-head">'
  + '<nav class="pr-tabs arrival-tabs" role="tablist" aria-label="' + escapeHtml(ARRIVAL_FULL_TEXTS.acceptanceTabsLabel) + '">'
  + '<button class="pr-tab active" type="button" role="tab" aria-selected="true" data-arrival-tab="accept">' + escapeHtml(ARRIVAL_FULL_TEXTS.acceptanceTab) + '</button>'
  + '<button class="pr-tab" type="button" role="tab" aria-selected="false" data-arrival-tab="preview">' + escapeHtml(ARRIVAL_FULL_TEXTS.previewTab) + '</button>'
  + '</nav>'
  + '<section class="arrival-summary" data-view="arrival-summary" aria-live="polite"></section>'
  + '<section class="arrival-summary" data-view="arrival-preview-summary" aria-live="polite" hidden></section>'
  + '</div>'
  + '<div data-view="arrival-panel-accept">'
  + '<div data-view="arrival-products"></div>'
  + '<form class="arrival-detail-form" data-arrival-form>'
  + '<label class="form-field">' + escapeHtml(ORDERS_TEXTS.arrivalAmount)
  + '<input data-field="arrival-amount" type="text" inputmode="decimal" required aria-required="true" placeholder="'
  + escapeHtml(ARRIVAL_CONFIRM.amountPlaceholder) + '"></label>'
  + '<p class="arrival-amount-hint" data-view="arrival-amount-hint" hidden></p>'
  + arrivalDocFieldHtml({ escapeHtml, label: ARRIVAL_FULL_TEXTS.acceptanceDocLabel, hint: ARRIVAL_FULL_TEXTS.acceptanceDocHint })
  + '</form>'
  + '</div>'
  + '<div data-view="arrival-panel-preview" hidden>'
  + '<div data-view="arrival-preview-body"></div>'
  + '</div>'
  + '<div class="pr-bottom" data-view="arrival-bottom"><div class="pr-bottom-inner">'
  + '<div class="pr-picked"><span>' + escapeHtml(ARRIVAL_FULL_TEXTS.bottomArrival) + '</span>'
  + '<b data-view="arrival-total">0 双</b></div>'
  + '<button class="pr-submit" type="button" data-view="arrival-submit">' + escapeHtml(ORDERS_TEXTS.arrivalSubmit) + '</button>'
  + '</div></div>';

export function mountPurchaseAcceptanceDetail(host) {
  if (!host) return undefined;
  const params = new URLSearchParams(window.location.search);
  const batchNo = String(params.get('batchNo') || '').trim();
  const supplierRecordId = String(params.get('supplierRecordId') || '').trim();
  const supplierName = String(params.get('supplierName') || '').trim();
  const state = { host, batchNo, supplierRecordId, supplierName, rows: [], submitting: false, activeTab: 'accept', checkedProducts: new Set() };

  const groups = () => groupRows(state.rows);
  const totalsOf = () => {
    let expected = 0;
    let actual = 0;
    let extra = 0;
    for (const row of state.rows) {
      const quantity = Number(row.actual || 0);
      if (row.custom) {
        extra += quantity;
      } else {
        const declared = Number(row.declared || 0);
        expected += declared;
        actual += Math.min(quantity, declared);
        extra += Math.max(0, quantity - declared);
      }
    }
    return { expected, actual, extra, arrival: actual + extra };
  };
  const summaryHtmlOf = (totals) => [
    fill(ARRIVAL_FULL_TEXTS.summaryExpected, { count: totals.expected }),
    fill(ARRIVAL_FULL_TEXTS.summaryActual, { count: totals.actual }),
    fill(ARRIVAL_FULL_TEXTS.summaryExtra, { count: totals.extra }),
  ].map((text) => '<span>' + escapeHtml(text) + '</span>').join(' / ');
  const renderPreview = () => {
    const totals = totalsOf();
    const body = host.querySelector('[data-view="arrival-preview-body"]');
    if (body) body.innerHTML = previewHtml(groups());
    const summary = host.querySelector('[data-view="arrival-preview-summary"]');
    if (summary) summary.innerHTML = summaryHtmlOf(totals);
  };
  const renderSummary = () => {
    const totals = totalsOf();
    const box = host.querySelector('[data-view="arrival-summary"]');
    if (box) box.innerHTML = summaryHtmlOf(totals);
    const total = host.querySelector('[data-view="arrival-total"]');
    if (total) total.textContent = fill(ARRIVAL_FULL_TEXTS.arrivalTotalUnit, { count: totals.arrival });
    renderPreview();
  };
  const renderProducts = () => {
    const box = host.querySelector('[data-view="arrival-products"]');
    if (box) box.innerHTML = productsHtml(groups(), state.checkedProducts);
    renderSummary();
  };
  const applyTab = (tab) => {
    state.activeTab = tab === 'preview' ? 'preview' : 'accept';
    for (const button of host.querySelectorAll('[data-arrival-tab]')) {
      const active = button.dataset.arrivalTab === state.activeTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    const acceptPanel = host.querySelector('[data-view="arrival-panel-accept"]');
    const previewPanel = host.querySelector('[data-view="arrival-panel-preview"]');
    const acceptSummary = host.querySelector('[data-view="arrival-summary"]');
    const previewSummary = host.querySelector('[data-view="arrival-preview-summary"]');
    const bottom = host.querySelector('[data-view="arrival-bottom"]');
    if (acceptPanel) acceptPanel.hidden = state.activeTab !== 'accept';
    if (previewPanel) previewPanel.hidden = state.activeTab !== 'preview';
    if (acceptSummary) acceptSummary.hidden = state.activeTab !== 'accept';
    if (previewSummary) previewSummary.hidden = state.activeTab !== 'preview';
    if (bottom) bottom.hidden = state.activeTab !== 'accept';
    if (state.activeTab === 'preview') renderPreview();
  };
  const rowOf = (uid) => state.rows.find((row) => row.uid === uid);
  const updateActual = (uid, value) => {
    const row = rowOf(uid);
    if (!row) return;
    if (String(value).trim() === '') {
      row.actual = null;
    } else {
      const parsed = asQuantity(value);
      if (parsed == null) return;
      row.actual = parsed;
    }
    renderSummary();
  };
  const addSize = (productId) => {
    const parent = state.rows.find((row) => row.productId === productId);
    if (!parent) return;
    const row = {
      uid: 'custom_' + crypto.randomUUID(),
      productId: parent.productId,
      product_record_id: parent.productId,
      itemNo: parent.itemNo,
      color: parent.color,
      number: parent.number,
      size: '',
      declared: 0,
      actual: 1,
      custom: true,
      needsSampleChoice: parent.needsSampleChoice,
    };
    state.rows.push(row);
    renderProducts();
    const input = host.querySelector('[data-field="custom-size"][data-row-uid="' + row.uid + '"]');
    input?.focus();
  };
  const removeSize = (uid) => {
    const row = rowOf(uid);
    if (!row?.custom) return;
    state.rows = state.rows.filter((item) => item.uid !== uid);
    renderProducts();
  };
  const collectActuals = () => {
    const actuals = {};
    for (const input of host.querySelectorAll('[data-field="arrival-actual"]')) {
      const row = rowOf(input.dataset.rowUid);
      if (!row) continue;
      actuals[row.productId + '|' + sizeText(row.size)] = String(input.value ?? '').trim();
    }
    return actuals;
  };
  const validateRows = () => {
    const seen = new Set();
    for (const row of state.rows) {
      const size = sizeText(row.size);
      if (!/^[1-9]\d*$/.test(size)) {
        showPageError(ARRIVAL_FULL_TEXTS.customSizeInvalid);
        return null;
      }
      const key = row.productId + '|' + size;
      if (seen.has(key)) {
        showPageError(ARRIVAL_FULL_TEXTS.duplicateSize);
        return null;
      }
      seen.add(key);
    }
    return true;
  };

  const amountInputOf = () => host.querySelector('[data-field="arrival-amount"]');
  const amountHintOf = () => host.querySelector('[data-view="arrival-amount-hint"]');
  const clearAmountHint = () => {
    const hint = amountHintOf();
    if (hint) { hint.textContent = ''; hint.hidden = true; }
  };
  const submitButtonOf = () => host.querySelector('[data-view="arrival-submit"]');
  const setSubmitBusy = (busy, text = ARRIVAL_FULL_TEXTS.submitting) => {
    const button = submitButtonOf();
    if (!button) return;
    if (busy) button.disabled = true;
    else button.disabled = false;
    button.textContent = busy ? text : ORDERS_TEXTS.arrivalSubmit;
  };

  const submit = async () => {
    if (state.submitting) return;
    state.submitting = true;
    showPageError('');
    clearAmountHint();
    setSubmitBusy(true, ARRIVAL_FULL_TEXTS.submitting);
    const finish = (message = '', { toast = false } = {}) => {
      state.submitting = false;
      setSubmitBusy(false);
      if (!message) return;
      if (toast) showToast(message, { durationMs: 6000 });
      else showPageError(message);
    };

    const form = host.querySelector('[data-arrival-form]');
    const amountInput = amountInputOf();
    const amount = Number(String(amountInput?.value || '').replace(/[¥,，\s]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      const hint = amountHintOf();
      if (hint) { hint.textContent = ARRIVAL_FULL_TEXTS.amountRequired; hint.hidden = false; }
      amountInput?.focus();
      amountInput?.reportValidity?.();
      finish();
      return;
    }
    const docs = validateArrivalDocuments(form, ARRIVAL_FULL_TEXTS);
    if (!docs.ok) { finish(); return; }
    if (!validateRows()) { finish(); return; }
    const built = arrivalSubmitLines({ rows: state.rows, actuals: collectActuals() });
    if (!built.ok) {
      finish(built.reason === 'actual_missing'
        ? ARRIVAL_FULL_TEXTS.actualQuantityRequired : ARRIVAL_FULL_TEXTS.sizeInvalid);
      return;
    }
    if (!built.lines.length) {
      finish(ARRIVAL_FULL_TEXTS.noArrivalLines);
      return;
    }
    const products = sampleChoiceProducts({ rows: state.rows, lines: built.lines });
    let sampleChoices = {};
    if (products.length) {
      sampleChoices = await openSampleChoiceModal({ products, texts: ARRIVAL_FULL_TEXTS, escapeHtml });
      if (!sampleChoices) { finish(); return; }
    }
    setSubmitBusy(true, ARRIVAL_FULL_TEXTS.uploading);
    const uploaded = await uploadArrivalDocuments({
      api, endpoint: ARRIVAL_FULL_API.acceptanceDoc, files: docs.files, texts: ARRIVAL_FULL_TEXTS,
    });
    if (!uploaded.ok) {
      finish(uploaded.error);
      return;
    }
    setSubmitBusy(true, ARRIVAL_FULL_TEXTS.submitting);
    try {
      const result = await api.post(ARRIVAL_FULL_API.accept, {
        batchNo: state.batchNo,
        supplierRecordId: state.supplierRecordId,
        actualAmount: String(amount),
        lines: built.lines,
        counterpartyDocuments: uploaded.documents || [],
        sampleChoices,
      });
      if (!result?.redirect_url) throw new Error(ARRIVAL_FULL_TEXTS.redirectMissing);
      window.location.assign(result.redirect_url);
    } catch (error) {
      const message = describeError(error) || ARRIVAL_FULL_TEXTS.acceptFailed;
      finish(message, { toast: true });
    }
  };

  const load = async () => {
    if (!batchNo) {
      showPageError(ARRIVAL_FULL_TEXTS.batchMissing);
      return;
    }
    host.innerHTML = '<p class="empty">' + escapeHtml(ARRIVAL_FULL_TEXTS.detailLoading || '正在读取验收明细…') + '</p>';
    try {
      const query = new URLSearchParams({ batchNo });
      if (supplierRecordId) query.set('supplierRecordId', supplierRecordId);
      const data = await api.get(ARRIVAL_FULL_API.detail + '?' + query.toString());
      const rows = (Array.isArray(data?.rows) ? data.rows : []).map((input, index) => ({
        uid: 'original_' + index,
        productId: String(input.product_record_id || '').trim(),
        product_record_id: String(input.product_record_id || '').trim(),
        itemNo: String(input.item_no || '').trim(),
        color: String(input.color || '').trim(),
        number: String(input.number || '').trim(),
        size: String(input.size ?? ''),
        declared: Number(input.quantity || 0),
        actual: Number(input.quantity || 0),
        custom: false,
        needsSampleChoice: input.needs_sample_choice === true,
        hasStock: input.has_stock === true,
        hasSample: input.has_sample === true,
      })).filter((row) => row.productId);
      state.rows = rows;
      host.innerHTML = shellHtml();
      renderProducts();
      host.addEventListener('input', (event) => {
        const amountInput = event.target.closest?.('[data-field="arrival-amount"]');
        if (amountInput) {
          const hint = host.querySelector('[data-view="arrival-amount-hint"]');
          if (hint) { hint.textContent = ''; hint.hidden = true; }
        }
        const input = event.target.closest?.('[data-field="arrival-actual"]');
        if (input) updateActual(input.dataset.rowUid, input.value);
        if (event.target.closest?.('[data-field="custom-size"]')) {
          const row = rowOf(event.target.closest('[data-field="custom-size"]').dataset.rowUid);
          if (row) row.size = String(event.target.value || '').trim();
          renderPreview();
        }
        if (event.target.closest?.('[data-field="arrival-doc"]')) {
          updateArrivalDocHint(event.target, ARRIVAL_FULL_TEXTS);
        }
      });
      host.addEventListener('change', (event) => {
        const box = event.target.closest?.('[data-arrival-verify]');
        if (!box) return;
        const productId = box.dataset.arrivalVerify;
        if (box.checked) state.checkedProducts.add(productId);
        else state.checkedProducts.delete(productId);
        box.closest('.arrival-product')?.classList.toggle('is-checked', box.checked);
      });
      host.addEventListener('click', (event) => {
        const tabButton = event.target.closest?.('[data-arrival-tab]');
        if (tabButton) { applyTab(tabButton.dataset.arrivalTab); return; }
        const add = event.target.closest?.('[data-add-size]');
        if (add) { addSize(add.dataset.addSize); return; }
        const remove = event.target.closest?.('[data-remove-size]');
        if (remove) { removeSize(remove.dataset.removeSize); return; }
        const step = event.target.closest?.('[data-action="arrival-step"]');
        if (step) {
          const row = rowOf(step.dataset.rowUid);
          if (!row) return;
          const current = Number(row.actual || 0);
          const next = Math.max(0, current + Number(step.dataset.delta || 0));
          row.actual = next;
          const input = host.querySelector('[data-field="arrival-actual"][data-row-uid="' + row.uid + '"]');
          if (input) input.value = String(next);
          renderSummary();
          return;
        }
        if (event.target.closest?.('[data-view="arrival-submit"]')) void submit();
      });
    } catch (error) {
      showPageError(error?.message || ARRIVAL_FULL_TEXTS.detailLoadFailed);
    }
  };

  void load();
  return { reload: load };
}
