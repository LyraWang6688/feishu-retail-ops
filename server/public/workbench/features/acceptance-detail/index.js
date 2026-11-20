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

const groupLabel = (group) => [group.itemNo, group.color].filter(Boolean).join(' · ')
  || group.number || ARRIVAL_FULL_TEXTS.detailGroupUnknown;

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

const productsHtml = (groups) => groups.map((group) => {
  const rows = group.rows.map(rowHtml).join('');
  return '<section class="pr-group arrival-product" data-product-id="' + escapeHtml(group.productId) + '">'
    + '<div class="pr-group-head"><h2 class="pr-group-name">' + escapeHtml(groupLabel(group)) + '</h2>'
    + '<button class="btn small" type="button" data-add-size="' + escapeHtml(group.productId) + '">'
    + escapeHtml(ARRIVAL_FULL_TEXTS.addSize) + '</button></div>'
    + '<div data-view="arrival-size-rows">' + rows + '</div></section>';
}).join('');

const shellHtml = () => '<section class="arrival-summary" data-view="arrival-summary" aria-live="polite"></section>'
  + '<div data-view="arrival-products"></div>'
  + '<form class="arrival-detail-form" data-arrival-form>'
  + '<label class="form-field">' + escapeHtml(ORDERS_TEXTS.arrivalAmount)
  + '<input data-field="arrival-amount" type="text" inputmode="decimal" required aria-required="true" placeholder="'
  + escapeHtml(ARRIVAL_CONFIRM.amountPlaceholder) + '"></label>'
  + '<p class="arrival-amount-hint" data-view="arrival-amount-hint" hidden></p>'
  + arrivalDocFieldHtml({ escapeHtml, label: ARRIVAL_FULL_TEXTS.acceptanceDocLabel, hint: ARRIVAL_FULL_TEXTS.acceptanceDocHint })
  + '</form>'
  + '<div class="pr-bottom"><div class="pr-bottom-inner">'
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
  const state = { host, batchNo, supplierRecordId, supplierName, rows: [], submitting: false };

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
  const renderSummary = () => {
    const totals = totalsOf();
    const box = host.querySelector('[data-view="arrival-summary"]');
    if (box) {
      box.innerHTML = [
        fill(ARRIVAL_FULL_TEXTS.summaryExpected, { count: totals.expected }),
        fill(ARRIVAL_FULL_TEXTS.summaryActual, { count: totals.actual }),
        fill(ARRIVAL_FULL_TEXTS.summaryExtra, { count: totals.extra }),
      ].map((text) => '<span>' + escapeHtml(text) + '</span>').join(' / ');
    }
    const total = host.querySelector('[data-view="arrival-total"]');
    if (total) total.textContent = fill(ARRIVAL_FULL_TEXTS.arrivalTotalUnit, { count: totals.arrival });
  };
  const renderProducts = () => {
    const box = host.querySelector('[data-view="arrival-products"]');
    if (box) box.innerHTML = productsHtml(groups());
    renderSummary();
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
        }
        if (event.target.closest?.('[data-field="arrival-doc"]')) {
          updateArrivalDocHint(event.target, ARRIVAL_FULL_TEXTS);
        }
      });
      host.addEventListener('click', (event) => {
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
