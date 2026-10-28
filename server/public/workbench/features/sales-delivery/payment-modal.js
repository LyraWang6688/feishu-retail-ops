/** 付款确认弹窗：只负责打开/关闭与金额预填（DOM 在 render.js，提交在 index.js）。 */
import { formatMoney } from './format.js';

export const openPaymentModal = (container, card, T) => {
  const modal = container.querySelector('[data-sd-modal]');
  if (!modal || !card) return;
  const pending = Number(card.dataset.sdPending || 0);
  const input = modal.querySelector('[data-sd-modal-amount]');
  input.value = formatMoney(pending);
  input.dataset.max = String(pending);
  modal.querySelector('[data-sd-modal-method]').selectedIndex = 0;
  modal.querySelector('[data-sd-modal-error]').hidden = true;
  modal.querySelector('[data-sd-modal-confirm]').disabled = false;
  modal.hidden = false;
  input.focus?.();
};

export const closePaymentModal = (container) => {
  const modal = container.querySelector('[data-sd-modal]');
  if (modal) modal.hidden = true;
};

export const validatePaymentAmount = (input, card, T) => {
  const modal = input?.closest('[data-sd-modal]');
  if (!modal) return false;
  const raw = String(input.value || '').replace(/[^\d.]/g, '');
  const value = Number(raw);
  const pending = Number(card?.dataset.sdPending || 0);
  let error = '';
  if (!raw || !Number.isFinite(value) || value <= 0 || !/^\d+(\.\d{1,2})?$/.test(raw)) {
    error = T.forms.paymentAmountInvalid;
  } else if (value > pending + 1e-6) {
    error = T.forms.paymentAmountTooLarge.replace('{amount}', formatMoney(pending));
  }
  const errorNode = modal.querySelector('[data-sd-modal-error]');
  if (errorNode) { errorNode.textContent = error; errorNode.hidden = !error; }
  const confirm = modal.querySelector('[data-sd-modal-confirm]');
  if (confirm) confirm.disabled = Boolean(error);
  return !error;
};
