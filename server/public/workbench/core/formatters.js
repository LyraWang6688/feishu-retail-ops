export const money = (value) => `¥${Number(value || 0).toFixed(2)}`;

export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export const dateTime = (value) => value
  ? new Date(value).toLocaleString('zh-CN', { hour12: false })
  : '-';

export const statusClass = (value = '') => {
  if (/失败|取消|退款/.test(value)) return 'tag-danger';
  if (/已完成|已入库|已交付|已收清|识别成功|全部到货/.test(value)) return 'tag-success';
  if (/部分|平台结算/.test(value)) return 'tag-info';
  return 'tag-warning';
};
