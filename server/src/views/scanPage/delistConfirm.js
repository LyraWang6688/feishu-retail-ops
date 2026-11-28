'use strict';

/**
 * ⭐ 2026-11-26（卖完下架确认）：**销售 / 供应退货共用的确认层**（服务端渲染）。
 *
 * 口径（业务负责人定稿）：
 *   · 只有「页面快照 − 本单数量 <= 0」（= 卖完/退完该货品的全部库存记录）才出现；
 *   · 每行一个勾选框（默认全选，可逐个取消）—— 多款都卖完时她只下架想下架的那几款；
 *   · 确认后 = **把原提交原样再发一次**（回显原 body 的字段）＋ `delist_confirmed=1` ＋ 勾中的 id；
 *     所以二次提交和一次提交走的是同一条处理链，不会丢金额/尺码/多货草稿。
 *   · 文案全部来自 `config/scanPage.js`（换说法只改配置）。
 */
const { escapeHtml } = require('./fields');
const { SCAN_PAGE, fillText } = require('../../config/scanPage');

const hiddenField = (name, value) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;

// 确认层自己会用到的字段：回显 body 时**必须排除**，否则会带出旧的决策值。
const CONFIRM_ONLY_KEYS = Object.freeze(['delist_decision', 'delist_confirmed', 'delist_pick', 'delist_picked']);

const bodyHiddenFieldsHtml = (body = {}) => Object.entries(body || {})
  .filter(([key]) => !CONFIRM_ONLY_KEYS.includes(key))
  .map(([key, value]) => (Array.isArray(value)
    ? value.map((item) => hiddenField(key, item)).join('')
    : hiddenField(key, value)))
  .join('');

/**
 * @param {{ order: object, fields: object }} options
 *   order.candidates: [{ productRecordId, number, qty, snapshotCount }]
 *   order.body: 这一次提交的原始 body（原样回显，保证二次提交不丢字段）
 */
const delistConfirmHtml = ({ order, fields, action = '', config = SCAN_PAGE } = {}) => {
  const candidates = Array.isArray(order?.candidates) ? order.candidates : [];
  if (!candidates.length) return '';
  const pickField = escapeHtml((fields && fields.delistPick) || 'delist_pick');
  // ⭐ 2026-11-28：勾选框的 name 仍保留（无 JS 时原生可用）；另交一份隐藏的已勾选列表，
  //   由下面的小脚本在 change / submit 时同步。这样即使浏览器没把 checkbox 带上来，
  //   后台仍能拿到「确认下架」时的真实选择，不会静默变成 delistIds=[]。
  const pickedField = escapeHtml((fields && fields.delistPicked) || 'delist_picked');
  const pickedIds = candidates.map((candidate) => String(candidate.productRecordId || '')).filter(Boolean);
  const rows = candidates.map((candidate) => `<li class="delist-confirm__row"><label><input type="checkbox" data-delist-picked="1" name="${pickField}" value="${escapeHtml(candidate.productRecordId)}"${candidate.selected === false ? '' : ' checked'}><span>${escapeHtml(fillText(String(config.delistConfirmRow || ''), { number: candidate.number || candidate.productRecordId, qty: candidate.qty, stock: candidate.snapshotCount }))}</span></label></li>`).join('');
  return `<div class="delist-confirm" data-delist-confirm>
<div class="delist-confirm__card" role="dialog" aria-modal="true">
<h3 class="delist-confirm__title">${escapeHtml(String(config.delistConfirmTitle || ''))}</h3>
<p class="delist-confirm__body">${escapeHtml(String(config.delistConfirmBody || ''))}</p>
<form method="post" action="${escapeHtml(action || order.action || '')}" class="write-form">
${bodyHiddenFieldsHtml(order.body)}
${hiddenField((fields && fields.delistConfirmed) || 'delist_confirmed', '1')}
${hiddenField(pickedField, pickedIds.join(','))}
<ul class="delist-confirm__rows">${rows}</ul>
<div class="delist-confirm__actions">
<button type="submit" class="btn" name="delist_decision" value="skip">${escapeHtml(String(config.delistConfirmNo || ''))}</button>
<button type="submit" class="btn btn--primary" name="delist_decision" value="confirm">${escapeHtml(String(config.delistConfirmYes || ''))}</button>
</div>
<script data-view="delist-confirm-picked">(function(){var s=document.currentScript;var f=s&&s.closest?s.closest('form'):null;if(!f)return;var h=f.querySelector('input[name="${pickedField}"]');if(!h)return;var boxes=f.querySelectorAll('input[data-delist-picked]');function sync(){var ids=[];for(var i=0;i<boxes.length;i++){if(boxes[i].checked)ids.push(boxes[i].value);}h.value=ids.join(',');}for(var j=0;j<boxes.length;j++){boxes[j].addEventListener('change',sync);}f.addEventListener('submit',sync);sync();})();</script>
</form>
</div>
</div>`;
};

module.exports = { delistConfirmHtml, bodyHiddenFieldsHtml };
