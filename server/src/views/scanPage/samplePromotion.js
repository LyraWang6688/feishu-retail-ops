'use strict';

const { SAMPLE_PROMOTION } = require('../../config/samplePromotion');
const { escapeHtml } = require('./fields');

/** 弹窗 + 隐藏字段（放在销售表单里；没有候选时 JS 不会弹）。 */
const samplePromotionHtml = () => [
  '<input type="hidden" name="' + escapeHtml(SAMPLE_PROMOTION.field) + '" data-sample-promotion-value value="">',
  '<div class="sample-modal" data-sample-promotion hidden>',
  '<div class="sample-modal__panel" role="dialog" aria-modal="true" aria-labelledby="sample-modal-title">',
  '<h2 class="sample-modal__title" id="sample-modal-title" data-sample-title>' + escapeHtml(SAMPLE_PROMOTION.texts.modalTitle) + '</h2>',
  '<p class="sample-modal__body" data-sample-body>' + escapeHtml(SAMPLE_PROMOTION.texts.modalBody) + '</p>',
  '<div class="sample-modal__options" data-sample-options></div>',
  '<button type="button" class="btn btn--ghost" data-sample-cancel>' + escapeHtml(SAMPLE_PROMOTION.texts.cancel) + '</button>',
  '</div>',
  '</div>',
].join('\n');

const SAMPLE_PROMOTION_STYLE = '.sample-modal{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.42)}'
  + '.sample-modal[hidden]{display:none}'
  + '.sample-modal__panel{width:100%;max-width:420px;background:var(--surface);border-radius:var(--radius-lg);box-shadow:var(--shadow-card);padding:20px}'
  + '.sample-modal__title{margin:0 0 8px;font-size:18px}'
  + '.sample-modal__body{margin:0 0 14px;color:var(--text-secondary)}'
  + '.sample-modal__options{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:14px}'
  + '.sample-modal__option{min-height:var(--control-height);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);font:inherit;cursor:pointer}'
  + '.size-chip__states{display:flex;flex-wrap:wrap;gap:4px;margin-top:2px}'
  + '.size-chip__state{font-size:11px;line-height:1.4;padding:0 4px;border-radius:4px;background:var(--surface-muted,#f2f3f5);color:var(--text-secondary)}'
  + '.size-chip__state[data-state="' + SAMPLE_PROMOTION.texts.tagSample + '"]{color:#8a5a00;background:#fff4d6}'
  + '.size-chip__state[data-state=""]{color:#666;background:#eee}';

const SAMPLE_PROMOTION_SCRIPT = '(function(){'
  + 'var form=document.querySelector("form[data-sample-candidates]");if(!form)return;'
  + 'var modal=form.querySelector("[data-sample-promotion]");'
  + 'var value=form.querySelector("[data-sample-promotion-value]");'
  + 'var options=form.querySelector("[data-sample-options]");'
  + 'var cancel=form.querySelector("[data-sample-cancel]");'
  + 'if(!modal||!value||!options)return;'
  + 'var candidates=[];try{candidates=JSON.parse(form.getAttribute("data-sample-candidates")||"[]");}catch(e){candidates=[];}'
  + 'function close(){modal.hidden=true;}'
  + 'function open(){if(!candidates.length)return;options.innerHTML="";candidates.forEach(function(size){'
  + 'var button=document.createElement("button");button.type="button";button.className="sample-modal__option";button.textContent=' + JSON.stringify(SAMPLE_PROMOTION.texts.candidateLabel) + '.replace("{size}",size);'
  + 'button.addEventListener("click",function(){value.value=size;close();});options.appendChild(button);});modal.hidden=false;}'
  + 'form.querySelectorAll("input[name=size]").forEach(function(radio){'
  + 'radio.addEventListener("change",function(){if(!radio.checked)return;value.value="";var chip=radio.closest(".size-chip");if(!chip||chip.getAttribute("data-sample-only")!=="1"||!candidates.length){return;}open();});});'
  + 'cancel&&cancel.addEventListener("click",close);'
  + 'form.addEventListener("submit",function(event){var checked=form.querySelector("input[name=size]:checked");var chip=checked&&checked.closest(".size-chip");if(chip&&chip.getAttribute("data-sample-only")==="1"&&candidates.length&&!value.value){event.preventDefault();open();}});'
  + '})();';

const samplePromotionScriptHtml = () => '<script>' + SAMPLE_PROMOTION_SCRIPT + '</script>';

module.exports = { samplePromotionHtml, samplePromotionScriptHtml, SAMPLE_PROMOTION_STYLE };
