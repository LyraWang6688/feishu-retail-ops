'use strict';


/**
 * 换款式「差价弹窗」块（2026-11-11）：填完实收金额 → 算差价 → 有差价弹窗选方式 → 提交换货接口。
 * 单独成文件：`paymentBlock.js` 是 file-size 棘轮盯着的存量超限文件，只许变小。
 */
/** 换款式：填完实收金额 → 算差价 → 有差价弹窗选方式（无差价直接提交）。 */
const exchangeDiffBlock = (flow) => {
  if (flow?.id !== 'afterSalesExchange' || !flow.exchange) return '';
  const cfg = {
    submitEndpoint: flow.exchange.submitEndpoint,
    paymentMethodsPath: flow.exchange.paymentMethodsPath,
    amountField: 'amount',
    sizeField: 'size',
    texts: flow.exchange.texts || {},
  };
  return `
<div data-exchange-modal hidden style="position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;padding:16px">
  <div style="background:#fff;border-radius:12px;padding:16px;max-width:420px;width:100%">
    <h3 data-exchange-title style="margin:0 0 8px;font-size:18px"></h3>
    <p data-exchange-hint style="margin:0 0 12px;color:#666;font-size:14px"></p>
    <label data-exchange-label style="display:block;margin:0 0 6px;font-size:14px"></label>
    <select data-exchange-method style="width:100%;padding:10px;border:1px solid #ccc;border-radius:8px"></select>
    <p data-exchange-error hidden style="color:#d33;font-size:13px;margin:8px 0 0"></p>
    <div style="display:flex;gap:8px;margin-top:14px">
      <button type="button" data-exchange-cancel style="flex:1;padding:11px;border:1px solid #ccc;border-radius:8px;background:#fff"></button>
      <button type="button" data-exchange-confirm style="flex:1;padding:11px;border:0;border-radius:8px;background:#165dff;color:#fff"></button>
    </div>
  </div>
</div>
<script data-view="exchange-diff">
(function () {
  var cfg = ${JSON.stringify(cfg).replace(/</g, '\\u003c')};
  var form = document.querySelector('form[data-exchange-form]');
  if (!form || !cfg || !cfg.texts) return;
  var modal = document.querySelector('[data-exchange-modal]');
  var title = modal.querySelector('[data-exchange-title]');
  var hint = modal.querySelector('[data-exchange-hint]');
  var label = modal.querySelector('[data-exchange-label]');
  var select = modal.querySelector('[data-exchange-method]');
  var error = modal.querySelector('[data-exchange-error]');
  var cancel = modal.querySelector('[data-exchange-cancel]');
  var confirm = modal.querySelector('[data-exchange-confirm]');
  var methods = null;
  var refunds = null;
  var pending = null;
  function load(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }
  function prepare() {
    if (methods) return Promise.resolve();
    return Promise.all([
      load(cfg.paymentMethodsPath),
      load(cfg.paymentMethodsPath + '?use=refund'),
    ]).then(function (out) {
      methods = (out[0] && out[0].items) || [];
      refunds = (out[1] && out[1].items) || [];
    });
  }
  function valueOf(name) { var el = form.querySelector('[name="' + name + '"]'); return el ? String(el.value || '') : ''; }
  function ctx(name) { return valueOf('ctx_' + name); }
  function selectedSize() {
    var el = form.querySelector('[name="' + cfg.sizeField + '"]:checked');
    return el ? String(el.value || '') : '';
  }
  function post(amount, size, method) {
    var f = document.createElement('form');
    f.method = 'post';
    f.action = cfg.submitEndpoint;
    f.style.display = 'none';
    var path = decodeURIComponent(String(location.pathname || ''));
    var newProductRecordId = path.slice(path.lastIndexOf('/') + 1);
    var fields = {
      requestId: ctx('requestId'),
      salesEntryRecordId: ctx('salesEntryRecordId'),
      detailRecordId: ctx('detailRecordId'),
      productRecordId: ctx('productRecordId'),
      scenario: 'new',
      newProductRecordId: newProductRecordId,
      newSize: size,
      newAmount: String(amount),
      diffPaymentMethod: method || '',
    };
    Object.keys(fields).forEach(function (key) {
      var input = document.createElement('input');
      input.type = 'hidden'; input.name = key; input.value = fields[key] || '';
      f.appendChild(input);
    });
    document.body.appendChild(f);
    f.submit();
  }
  function openModal(diff) {
    var isCollect = diff > 0;
    var list = isCollect ? methods : refunds;
    title.textContent = isCollect ? cfg.texts.collectTitle : cfg.texts.refundTitle;
    hint.textContent = isCollect ? cfg.texts.collectHint : cfg.texts.refundHint;
    label.textContent = cfg.texts.methodLabel;
    cancel.textContent = cfg.texts.cancel;
    confirm.textContent = cfg.texts.confirm;
    select.innerHTML = '';
    list.forEach(function (name) {
      var option = document.createElement('option');
      option.value = String(name); option.textContent = String(name);
      select.appendChild(option);
    });
    pending = { diff: diff };
    modal.hidden = false;
    modal.style.display = 'flex';
  }
  cancel.addEventListener('click', function () { modal.hidden = true; modal.style.display = 'none'; pending = null; });
  confirm.addEventListener('click', function () {
    if (!pending) return;
    var method = String(select.value || '');
    if (!method) { error.textContent = cfg.texts.needMethod; error.hidden = false; return; }
    post(pending.amount, pending.size, method);
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var amount = parseFloat(valueOf(cfg.amountField));
    var original = parseFloat(ctx('originalAmount'));
    var size = selectedSize();
    var message = '';
    if (!(amount > 0)) message = cfg.texts.needAmount;
    else if (!size) message = cfg.texts.needSize;
    else if (!isFinite(original)) message = cfg.texts.needAmount;
    if (message) { error.textContent = message; error.hidden = false; return; }
    var diff = Math.round((amount - original) * 100) / 100;
    if (!diff) { post(amount, size, ''); return; }
    prepare().then(function () { openModal(diff); pending.amount = amount; pending.size = size; });
  }, true);
})();
</script>`;
};


module.exports = { exchangeDiffBlock };
