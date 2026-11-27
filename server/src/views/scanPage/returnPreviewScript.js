'use strict';

/** 2026-11-27：退货 / 预览双区的前端逻辑（从 script.js 拆出，控制既有文件净增）。 */
const returnPreviewScriptSource = () => `(function(){
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  var root = document.querySelector('[data-view="return-tabs"]');
  var dataEl = document.querySelector('[data-view="return-preview-data"]');
  var body = document.querySelector('[data-view="return-preview-body"]');
  var form = document.querySelector('[data-view="purchase-return"]');
  if (!root || !dataEl || !body || !form) return;
  var data;
  try { data = JSON.parse(dataEl.getAttribute('data-json') || '{}'); } catch (e) { return; }
  var labels = data.labels || {};
  var panelReturn = document.querySelector('[data-return-panel="return"]');
  var panelPreview = document.querySelector('[data-return-panel="preview"]');
  var buttons = root.querySelectorAll('[data-return-tab]');
  var active = 'return';
  var esc = function(value){ return String(value == null ? '' : value).replace(/[&<>"']/g, function(ch){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]; }); };
  var money = function(cents){ var n = Number(cents || 0) / 100; return '¥' + (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toFixed(2)); };
  var qtyOf = function(){
    var prefix = form.getAttribute('data-return-qty-prefix') || '';
    var out = [];
    var inputs = form.querySelectorAll('input[name^="' + prefix + '"]');
    for (var i = 0; i < inputs.length; i += 1) {
      var q = Number(inputs[i].value);
      if (!Number.isFinite(q) || q <= 0) continue;
      out.push({ size: String(inputs[i].name.slice(prefix.length)), quantity: q });
    }
    return out;
  };
  var currentAmount = function(){
    var name = form.getAttribute('data-amount-field') || '';
    var input = form.querySelector('input[name="' + name + '"]');
    var text = String((input && input.value) || '').replace(/[^0-9.]/g, '');
    var amount = Number(text);
    return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
  };
  var build = function(){
    var items = Array.isArray(data.items) ? data.items.concat() : [];
    var current = data.current || {};
    var entries = qtyOf();
    if (entries.length) {
      items.push({
        product_record_id: current.product_record_id,
        item_no: current.item_no,
        color: current.color,
        number: current.number,
        supplier_record_id: current.supplier_record_id,
        supplier_name: current.supplier_name,
        amount_cents: currentAmount(),
        entries: entries,
      });
    }
    var suppliers = {};
    var order = [];
    var add = function(item){
      var sk = String(item.supplier_record_id || '__unassigned__');
      if (!suppliers[sk]) { suppliers[sk] = { supplierRecordId: item.supplier_record_id || '', supplierName: item.supplier_name || '', products: [], productIndex: {} }; order.push(sk); }
      var supplier = suppliers[sk];
      if (!supplier.supplierName && item.supplier_name) supplier.supplierName = item.supplier_name;
      var pk = String(item.product_record_id || '');
      if (!pk) return;
      if (!supplier.productIndex[pk]) { supplier.productIndex[pk] = { productRecordId: pk, itemNo: item.item_no || '', color: item.color || '', amountCents: null, entries: [] }; supplier.products.push(supplier.productIndex[pk]); }
      var product = supplier.productIndex[pk];
      if (product.amountCents == null && Number.isInteger(item.amount_cents)) product.amountCents = item.amount_cents;
      var entries = Array.isArray(item.entries) ? item.entries : [];
      for (var i = 0; i < entries.length; i += 1) {
        var e = entries[i]; var q = Number(e.quantity) || 0;
        if (q > 0) product.entries.push({ size: String(e.size || ''), quantity: q });
      }
    };
    for (var i = 0; i < items.length; i += 1) add(items[i]);
    var totalQty = 0; var totalAmount = 0;
    var html = '';
    if (!order.length) html = '<p class="hint">' + esc(labels.previewEmpty || '') + '</p>';
    for (var si = 0; si < order.length; si += 1) {
      var supplier = suppliers[order[si]];
      var name = supplier.supplierName || labels.previewUnassigned || '';
      var subQty = 0; var subAmount = 0;
      var productsHtml = '';
      for (var pi = 0; pi < supplier.products.length; pi += 1) {
        var product = supplier.products[pi];
        product.entries.sort(function(a,b){ return Number(a.size) - Number(b.size); });
        var entriesText = product.entries.map(function(e){ return String(labels.previewEntry || '').replace('{size}', e.size).replace('{qty}', e.quantity); }).join(labels.previewSeparator || '');
        var qty = product.entries.reduce(function(sum, e){ return sum + e.quantity; }, 0);
        subQty += qty;
        if (Number.isInteger(product.amountCents)) subAmount += product.amountCents;
        productsHtml += '<div class="return-preview-product"><h4>' + esc([product.itemNo, product.color].filter(Boolean).join(' · ')) + '</h4><p>' + esc(entriesText || '—') + '</p>' + (Number.isInteger(product.amountCents) ? '<p class="return-preview-amount">' + esc(labels.previewAmount || '') + '：' + esc(money(product.amountCents)) + '</p>' : '') + '</div>';
      }
      totalQty += subQty; totalAmount += subAmount;
      html += '<section class="return-preview-supplier"><h3>' + esc(labels.previewSupplier || '') + '：' + esc(name) + ' <small>' + esc(labels.previewBatch || '') + '</small></h3>' + productsHtml + '<p class="return-preview-subtotal">' + esc(labels.previewSubtotal || '') + '：' + subQty + ' ' + esc(labels.previewQtyUnit || '') + ' / ' + esc(money(subAmount)) + '</p></section>';
    }
    if (order.length) html = '<div class="return-preview"><h3>' + esc(labels.previewTitle || '') + '</h3><p class="hint">' + esc(labels.previewHint || '') + '</p>' + html + '<p class="return-preview-total">' + esc(labels.previewTotal || '') + '：' + totalQty + ' ' + esc(labels.previewQtyUnit || '') + ' / ' + esc(money(totalAmount)) + '</p></div>';
    body.innerHTML = html;
  };
  var show = function(tab){
    active = tab === 'preview' ? 'preview' : 'return';
    for (var i = 0; i < buttons.length; i += 1) {
      var on = buttons[i].getAttribute('data-return-tab') === active;
      buttons[i].className = 'return-tab' + (on ? ' is-active' : '');
      buttons[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (panelReturn) panelReturn.hidden = active !== 'return';
    if (panelPreview) panelPreview.hidden = active !== 'preview';
    if (active === 'preview') build();
  };
  for (var i = 0; i < buttons.length; i += 1) buttons[i].addEventListener('click', function(){ show(this.getAttribute('data-return-tab')); });
  form.addEventListener('input', function(){ if (active === 'preview') build(); });
  form.addEventListener('change', function(){ if (active === 'preview') build(); });
  show('return');
})();`;

module.exports = { returnPreviewScriptSource };
