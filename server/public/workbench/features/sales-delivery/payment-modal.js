/** 付款确认弹窗：只负责打开/关闭与金额预填（DOM 在 render.js，提交在 index.js）。 */
import { formatMoney } from './format.js';

export const openPaymentModal = (container, card) => {
  const modal = container.querySelector('[data-sd-modal]');
  if (!modal || !card) return;
  modal.querySelector('[data-sd-modal-amount]').value = formatMoney(Number(card.dataset.sdPending || 0));
  modal.querySelector('[data-sd-modal-method]').selectedIndex = 0;
  modal.hidden = false;
  modal.querySelector('[data-sd-modal-amount]')?.focus?.();
};

export const closePaymentModal = (container) => {
  const modal = container.querySelector('[data-sd-modal]');
  if (modal) modal.hidden = true;
};
