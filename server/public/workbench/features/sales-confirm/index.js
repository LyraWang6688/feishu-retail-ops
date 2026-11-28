/**
 * 销售「确认单」页：复用共享销售订单卡 + 售后弹窗样式，整单修改。
 */
import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { salesOrderCardHtml } from '../shared/salesOrderCard.js';
import { SALES_CORRECTION_API, SALES_CORRECTION_PAYMENT_STATUS, SALES_CORRECTION_TEXTS as T } from '../../config/salesCorrection.js';

const money = (value) => '¥' + Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const amountOf = (value) => String(value ?? '').trim();

export function mountSalesConfirmPage(container) {
  const body = container.querySelector('[data-view="sales-confirm-body"]');
  const status = container.querySelector('[data-view="sales-confirm-status"]');
  const modal = document.querySelector('[data-correction-modal]');
  const modalBody = document.querySelector('[data-correction-body]');
  const modalError = document.querySelector('[data-correction-error]');
  const state = { orders: [], methods: [], sizes: new Map(), current: null, saving: false };

  const setStatus = (text, error) => {
    status.textContent = text || '';
    status.classList.toggle('error', Boolean(error));
  };
  const showModalError = (text) => {
    modalError.textContent = text || '';
    modalError.hidden = !text;
  };
  const closeModal = () => {
    if (state.saving) return;
    modal.hidden = true;
    state.current = null;
    state.sizes.clear();
  };
  const summaryHtml = (order) => {
    const total = Number(order.total_amount || 0) + Number(order.accessory_amount || 0);
    return '<span>' + T.totalLabel + ' <b>' + money(total) + '</b></span>'
      + '<span>' + T.paidLabel + ' <b>' + money(order.paid_amount) + '</b></span>'
      + '<span>' + T.pendingLabel + ' <b>' + money(order.pending_amount) + '</b></span>';
  };
  const blockedText = (order) => {
    if ((order.blocked_reasons || []).includes('after_sales')) return T.blockedAfterSales;
    if ((order.blocked_reasons || []).includes('status')) return T.blockedStatus;
    if (!order.editable) return T.readonly;
    if (!order.can_edit) return T.forbidden;
    return '';
  };

  const renderList = () => {
    if (!state.orders.length) {
      body.innerHTML = '<p class="empty">' + escapeHtml(T.empty) + '</p>';
      return;
    }
    let html = '';
    for (const order of state.orders) {
      const first = (order.details || [])[0];
      const blocked = blockedText(order);
      const action = blocked
        ? '<span class="hint">' + escapeHtml(blocked) + '</span>'
        : '<button type="button" class="btn btn--primary sales-confirm-edit" data-correction-edit="'
          + escapeHtml(order.record_id) + '">' + escapeHtml(T.edit) + '</button>';
      html += '<div class="sales-confirm-card-wrap" data-order-id="' + escapeHtml(order.record_id) + '">'
        + salesOrderCardHtml(order, {
          showColor: true,
          summaryHtml: summaryHtml(order),
          actionDetailId: first ? first.record_id : '',
          actionHtml: action,
        }) + '</div>';
    }
    body.innerHTML = html;
  };

  const load = async () => {
    setStatus(T.loading);
    try {
      const result = await api.get(SALES_CORRECTION_API.list);
      state.orders = Array.isArray(result && result.orders) ? result.orders : [];
      state.methods = Array.isArray(result && result.methods) ? result.methods : [];
      renderList();
      setStatus(state.orders.length ? '' : T.empty);
    } catch (error) {
      setStatus(T.failed, true);
    }
  };

  const sizeOptionsOf = (detail, currentSize) => {
    const groups = state.sizes.get(detail.product_record_id) || {};
    let html = '';
    // ⭐ 2026-11-28：实时库存 + 原单尺码。
    //   原单尺码固定第一项并默认选中；实时库存里的同尺码不再重复出现。
    if (currentSize) {
      html += '<option value="' + escapeHtml(String(currentSize)) + '" selected>'
        + escapeHtml(T.original) + ' ' + escapeHtml(String(currentSize)) + ' 码</option>';
    }
    const add = (label, items) => {
      for (const item of items || []) {
        if (String(item.size) === String(currentSize)) continue;
        html += '<option value="' + escapeHtml(String(item.size)) + '">'
          + escapeHtml(label) + ' ' + escapeHtml(String(item.size)) + ' 码</option>';
      }
    };
    add(T.inStock, groups.inStock);
    add(T.reserve, groups.reserve);
    add(T.special, groups.special);
    return html;
  };

  const recalcSummary = () => {
    const order = state.current;
    if (!order) return;
    let total = 0;
    modalBody.querySelectorAll('[data-detail-amount]').forEach((input) => {
      total += Number(input.value || 0);
    });
    total += Number(modalBody.querySelector('[data-correction-accessory-amount]')?.value || 0);
    let paid = 0;
    for (const payment of order.payments || []) {
      if (payment.status === SALES_CORRECTION_PAYMENT_STATUS.unpaid) continue;
      paid += Number(modalBody.querySelector('[data-payment-amount="' + payment.record_id + '"]')?.value || 0);
    }
    const pending = Math.max(0, total - paid);
    const node = modalBody.querySelector('[data-correction-summary]');
    if (node) {
      node.innerHTML = '<span>' + T.totalLabel + ' <b>' + money(total) + '</b></span>'
        + '<span>' + T.paidLabel + ' <b>' + money(paid) + '</b></span>'
        + '<span>' + T.pendingLabel + ' <b>' + money(pending) + '</b></span>';
    }
  };

  const renderModal = () => {
    const order = state.current;
    if (!order) return;
    let detailHtml = '';
    for (const detail of order.details || []) {
      detailHtml += '<div class="form-row sales-confirm-row" data-detail-row="' + escapeHtml(detail.record_id) + '">'
        + '<div><b>' + escapeHtml(detail.product || '') + '</b>'
        + (detail.color ? ' · ' + escapeHtml(detail.color) : '')
        + '<select data-detail-size="' + escapeHtml(detail.record_id) + '" aria-label="' + escapeHtml(T.sizeLabel) + '">'
        + sizeOptionsOf(detail, detail.size) + '</select></div>'
        + '<input data-detail-amount="' + escapeHtml(detail.record_id) + '" inputmode="decimal" value="'
        + escapeHtml(amountOf(detail.actual_amount)) + '" aria-label="' + escapeHtml(T.amountLabel) + '">'
        + '</div>';
    }
    let paymentHtml = '';
    for (const payment of order.payments || []) {
      // 未收款行只是待收占位：没有支付方式，不能默认成第一个方式。
      if (payment.status === SALES_CORRECTION_PAYMENT_STATUS.unpaid) {
        paymentHtml += '<div class="form-row sales-confirm-row" data-payment-row="' + escapeHtml(payment.record_id) + '">'
          + '<div><span class="sales-confirm-unpaid">' + escapeHtml(SALES_CORRECTION_PAYMENT_STATUS.unpaid) + '</span></div>'
          + '<input readonly value="' + escapeHtml(amountOf(payment.amount)) + '" aria-label="' + escapeHtml(T.pendingLabel) + '">'
          + '</div>';
        continue;
      }
      const methods = [payment.method].concat(state.methods || []).filter((value, index, arr) => value && arr.indexOf(value) === index);
      let options = '';
      for (const method of methods) {
        options += '<option value="' + escapeHtml(method) + '"' + (method === payment.method ? ' selected' : '') + '>'
          + escapeHtml(method) + '</option>';
      }
      paymentHtml += '<div class="form-row sales-confirm-row" data-payment-row="' + escapeHtml(payment.record_id) + '">'
        + '<div><select data-payment-method="' + escapeHtml(payment.record_id) + '" aria-label="' + escapeHtml(T.methodLabel) + '">'
        + options + '</select></div>'
        + '<input data-payment-amount="' + escapeHtml(payment.record_id) + '" inputmode="decimal" value="'
        + escapeHtml(amountOf(payment.amount)) + '" aria-label="' + escapeHtml(T.paymentAmountLabel) + '">'
        + '</div>';
    }
    modalBody.innerHTML = '<h2 class="as-modal-title" id="correction-title">' + T.modalTitle + '</h2>'
      + '<p class="sales-confirm-note">' + escapeHtml(order.order_no || '') + '</p>'
      + '<section class="sales-confirm-block"><h3>' + T.goodsTitle + '</h3>' + (detailHtml || '<p class="hint">-</p>') + '</section>'
      + '<section class="sales-confirm-block"><h3>' + T.paymentTitle + '</h3>' + (paymentHtml || '<p class="hint">-</p>') + '</section>'
      + '<section class="sales-confirm-block"><h3>' + T.giftLabel + ' / ' + T.accessoryLabel + '</h3>'
      + '<label>' + T.giftLabel + '<input data-correction-gift value="' + escapeHtml(order.gift || '') + '"></label>'
      + '<label>' + T.accessoryLabel + '<input data-correction-accessory value="' + escapeHtml(order.accessory || '') + '"></label>'
      + '<label>' + T.accessoryAmountLabel + '<input data-correction-accessory-amount inputmode="decimal" value="'
      + escapeHtml(amountOf(order.accessory_amount)) + '"></label></section>'
      + '<div class="sales-confirm-summary" data-correction-summary>' + summaryHtml(order) + '</div>'
      + '<div class="sales-confirm-actions"><button type="button" class="btn" data-correction-close>' + T.cancel + '</button>'
      + '<button type="button" class="btn btn--primary" data-correction-save>' + T.save + '</button></div>';
    modal.hidden = false;
    bindModal();
    recalcSummary();
  };

  const bindModal = () => {
    modalBody.querySelector('[data-correction-save]')?.addEventListener('click', save);
    modalBody.querySelector('[data-correction-close]')?.addEventListener('click', closeModal);
    modalBody.querySelectorAll('[data-detail-amount], [data-payment-amount], [data-correction-accessory-amount]')
      .forEach((input) => input.addEventListener('input', recalcSummary));
  };

  const open = async (orderId) => {
    const order = state.orders.find((item) => item.record_id === orderId);
    if (!order || !order.can_edit) return;
    state.current = order;
    showModalError('');
    try {
      for (const detail of order.details || []) {
        if (state.sizes.has(detail.product_record_id)) continue;
        const result = await api.get(SALES_CORRECTION_API.sizeGroups + '?productRecordId=' + encodeURIComponent(detail.product_record_id));
        state.sizes.set(detail.product_record_id, (result && result.groups) || {});
      }
      renderModal();
    } catch (error) {
      closeModal();
      setStatus(T.failed, true);
    }
  };

  const save = async () => {
    const order = state.current;
    if (!order || state.saving) return;
    const details = [];
    modalBody.querySelectorAll('[data-detail-size]').forEach((select) => {
      const recordId = select.getAttribute('data-detail-size');
      details.push({
        recordId,
        size: select.value,
        actualAmount: modalBody.querySelector('[data-detail-amount="' + recordId + '"]')?.value || '',
      });
    });
    const payments = [];
    modalBody.querySelectorAll('[data-payment-method]').forEach((select) => {
      const recordId = select.getAttribute('data-payment-method');
      payments.push({
        recordId,
        method: select.value,
        amount: modalBody.querySelector('[data-payment-amount="' + recordId + '"]')?.value || '',
      });
    });
    const payload = {
      submitKey: globalThis.crypto?.randomUUID?.() || ('correction-' + Date.now() + '-' + Math.random().toString(36).slice(2)),
      salesEntryRecordId: order.record_id,
      details,
      payments,
      gift: modalBody.querySelector('[data-correction-gift]')?.value || '',
      accessory: modalBody.querySelector('[data-correction-accessory]')?.value || '',
      accessoryTotal: modalBody.querySelector('[data-correction-accessory-amount]')?.value || '',
    };
    if (!globalThis.confirm?.(T.confirmHint)) return;
    state.saving = true;
    const button = modalBody.querySelector('[data-correction-save]');
    if (button) button.textContent = T.saving;
    try {
      const result = await api.post(SALES_CORRECTION_API.save, payload);
      state.saving = false;
      // 统一异步回执：入队成功就主动回工作台，由工作台 toast 显示“已提交”。
      if (result?.redirect_url) {
        window.location.href = result.redirect_url;
        return;
      }
      closeModal();
      await load();
    } catch (error) {
      state.saving = false;
      if (button) button.textContent = T.save;
      showModalError(String(error?.message || T.failedSave));
    }
  };

  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-correction-edit]');
    if (button) void open(button.getAttribute('data-correction-edit'));
  });
  document.querySelector('[data-correction-modal] .as-modal-backdrop')?.addEventListener('click', closeModal);
  void load();
  return { reload: load };
}
