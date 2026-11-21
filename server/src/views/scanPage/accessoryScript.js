'use strict';

const accessoryRowsScriptHtml = () => `<script data-view="accessory-rows">
(function(){
  var section = document.querySelector('[data-accessory-section]');
  if (!section) return;
  var rows = section.querySelector('[data-accessory-rows]');
  var tpl = section.querySelector('[data-accessory-template]');
  var value = section.querySelector('[data-accessory-value]');
  var totalValue = section.querySelector('[data-accessory-total-value]');
  var totalNode = section.querySelector('[data-accessory-total]');
  var error = section.querySelector('[data-accessory-error]');
  var add = section.querySelector('[data-accessory-add]');
  var collectNode = document.querySelector('[data-collect-total]');
  var diffNode = document.querySelector('[data-payment-diff]');
  var shoe = Number((document.querySelector('[data-shoe-total]') || {}).value || 0) || 0;
  var payment = document.querySelector('[data-payment-row] input[name="payment_amount"]');
  var paymentDirty = false;
  if (!rows || !tpl || !value || !add) return;
  function money(n) { return String(Math.round(Number(n || 0) * 100) / 100); }
  function recalc() {
    var parts = [];
    var total = 0;
    var list = rows.querySelectorAll('[data-accessory-row]');
    for (var i = 0; i < list.length; i++) {
      var select = list[i].querySelector('[data-accessory-name]');
      var qty = list[i].querySelector('[data-accessory-quantity]');
      var amount = list[i].querySelector('[data-accessory-amount]');
      var name = select ? String(select.value || '').trim() : '';
      var n = qty ? Math.max(1, Math.floor(Number(qty.value) || 1)) : 1;
      var a = amount ? Number(String(amount.value || '').replace(/,/g, '')) : 0;
      if (!Number.isFinite(a) || a < 0) a = 0;
      if (name) parts.push(name + '×' + n);
      total += a;
    }
    total = Math.round(total * 100) / 100;
    value.value = parts.join('、');
    if (totalValue) totalValue.value = money(total);
    if (totalNode) totalNode.textContent = money(total);
    if (collectNode) collectNode.textContent = money(shoe + total);
    if (error) error.hidden = true;
    if (payment) {
      if (!paymentDirty) payment.value = money(shoe + total);
      if (diffNode) {
        var paid = Number(String(payment.value || '').replace(/,/g, ''));
        var diff = Math.round((shoe + total - paid) * 100) / 100;
        var label = diffNode.getAttribute('data-diff-label') || '';
        if (paymentDirty && Number.isFinite(diff) && diff !== 0) {
          diffNode.textContent = label + ' ' + money(diff);
          diffNode.hidden = false;
        } else {
          diffNode.textContent = '';
          diffNode.hidden = true;
        }
      }
    }
  }
  if (payment) {
    payment.addEventListener('input', function(){ paymentDirty = true; recalc(); });
    payment.addEventListener('change', function(){ paymentDirty = true; recalc(); });
  }
  var options = null;
  var loading = null;
  function load() {
    if (options) return Promise.resolve(options);
    if (loading) return loading;
    loading = fetch('/api/workbench/accessories/options', { credentials: 'same-origin' })
      .then(function (res) { return res.json(); })
      .then(function (data) { options = Array.isArray(data.items) ? data.items : []; return options; })
      .catch(function () { options = []; return options; });
    return loading;
  }
  function addRow() {
    load().then(function (items) {
      if (!items.length) { if (error) error.hidden = false; return; }
      var row = tpl.content.firstElementChild.cloneNode(true);
      var select = row.querySelector('[data-accessory-name]');
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = section.getAttribute('data-accessory-placeholder') || '';
      select.appendChild(placeholder);
      for (var i = 0; i < items.length; i++) {
        var option = document.createElement('option');
        option.value = String(items[i].name || '');
        option.textContent = String(items[i].name || '');
        select.appendChild(option);
      }
      row.querySelector('[data-accessory-remove]').addEventListener('click', function () {
        row.remove();
        recalc();
      });
      rows.appendChild(row);
      recalc();
    });
  }
  add.addEventListener('click', addRow);
  rows.addEventListener('input', recalc);
  rows.addEventListener('change', recalc);
  recalc();
})();
</script>`;

module.exports = { accessoryRowsScriptHtml };
