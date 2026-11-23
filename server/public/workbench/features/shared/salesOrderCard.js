import { escapeHtml } from '../../core/formatters.js';
import { SALES_ORDER_CARD as TEXT } from '../../config/salesOrderCard.js';

export const amountText = (value) => {
  const number = Number(value || 0);
  return '¥' + number.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
};

const timeOnlyText = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || '';
  return get('hour') + ':' + get('minute');
};

const statusClass = (status) => (status === TEXT.delivered ? 'ok' : (status === TEXT.undelivered ? 'wait' : 'back'));

/** 销售明细订单卡：销售查询与售后扫一扫共用同一份 DOM。 */
export const salesOrderCardHtml = (order, {
  highlightDetailId = '', actionDetailId = '', actionHtml = '', matchDetailId = '', strikeDelisted = false,
} = {}) => {
  const pays = (order.payments || []).length
    ? order.payments.map((payment) => `<span class="sq-pay-tag">${escapeHtml(payment.method)} <b>${escapeHtml(amountText(payment.amount))}</b> · ${escapeHtml(payment.status)}</span>`).join('')
    : `<span class="sq-pay-tag">${TEXT.unpaid}</span>`;
  const gift = String(order.gift || '').trim();
  const accessory = String(order.accessory || '').trim();
  const accessoryUnits = [...accessory.matchAll(/[×xX]\s*(\d+)/g)]
    .reduce((sum, match) => sum + Number(match[1] || 0), 0);
  const benefits = (gift || accessory)
    ? '<div class="sq-benefits" data-sq-benefits>'
      + (gift ? '<div class="sq-benefit-row"><span class="sq-benefit-label">' + escapeHtml(TEXT.gift) + '</span><span class="sq-benefit-value">' + escapeHtml(gift) + '</span></div>' : '')
      + (accessory ? '<div class="sq-benefit-row"><span class="sq-benefit-label">' + escapeHtml(TEXT.accessory) + '</span><span class="sq-benefit-value">' + escapeHtml(accessory)
        + (accessoryUnits > 0 ? '<em class="sq-benefit-count">' + escapeHtml(TEXT.accessoryCount.replace('{count}', String(accessoryUnits))) + '</em>' : '') + '</span>'
        + '<b class="sq-benefit-amount">' + escapeHtml(amountText(order.accessory_amount)) + '</b></div>' : '')
      + '</div>'
    : '';
  const details = (order.details || []).map((detail) => {
    const recordId = String(detail.record_id || '');
    const highlighted = Boolean(highlightDetailId && recordId === highlightDetailId);
    const hasAction = Boolean(actionHtml && actionDetailId && recordId === actionDetailId);
    const productClass = strikeDelisted && detail.delisted === true ? ' product-delisted' : '';
    const row = `<tr class="${highlighted ? 'sq-detail-highlight' : ''}" data-detail-id="${escapeHtml(recordId)}">
      <td class="sq-detail-product${productClass}">${escapeHtml(detail.number || detail.product || '')}</td>
      <td class="sq-detail-size">${escapeHtml(detail.size == null ? '' : detail.size)} ${TEXT.sizeSuffix}</td>
      <td class="sq-detail-amount">${escapeHtml(amountText(detail.actual_amount))}</td>
      <td><span class="sq-status ${statusClass(detail.fulfillment_status)}">${escapeHtml(detail.fulfillment_status || '')}</span></td>
    </tr>`;
    return row + (hasAction ? `<tr class="sq-detail-action-row"><td colspan="4">${actionHtml}</td></tr>` : '');
  }).join('');
  return `<div class="sq-order-scroll scroll-hint-wrap" data-scroll-wrap><div class="sq-order-viewport" data-scroll-area><article class="sq-order" data-as-match="${escapeHtml(matchDetailId || '')}">
    <div class="sq-order-head">
      <div class="sq-order-title"><b>${escapeHtml(order.order_no)}</b><span class="sq-order-time">${escapeHtml(timeOnlyText(order.recorded_at))}</span></div>
      <div class="sq-order-total">${order.total_amount == null ? '—' : escapeHtml(amountText(order.total_amount))}</div>
      <div class="sq-order-pays">${pays}</div>
    </div>
    <table class="sq-detail-table"><tbody>${details}</tbody></table>
    ${benefits}
  </article></div></div>`;
};
