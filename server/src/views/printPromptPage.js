'use strict';

/**
 * 「是否打印」轻页（2026-11-17）—— 销售资金页 / 验收提交后共用。
 *
 * 🔴 只做三件事：列出货品（默认全勾）· 提交勾选 · 不打印回工作台。
 * ⚠️ 文案全部来自 `config/printPrompt.js`（页面里不写中文）。
 */
const { PRINT_PROMPT_TEXTS } = require('../config/printPrompt');

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

const CSS = [
  ':root{color-scheme:light}',
  'body{margin:0;background:#f6f7f9;color:#1f2329;font:16px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC",sans-serif}',
  '.wrap{max-width:560px;margin:0 auto;padding:24px 16px 40px}',
  '.card{background:#fff;border-radius:14px;padding:18px 16px;box-shadow:0 2px 10px rgba(0,0,0,.05)}',
  'h1{font-size:20px;margin:0 0 6px}',
  '.hint{color:#646a73;font-size:13px;margin:0 0 16px}',
  '.item{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-top:1px solid #eff0f1}',
  '.item:first-of-type{border-top:0}',
  '.item input{width:22px;height:22px;margin-top:2px;flex:0 0 auto}',
  '.name{font-weight:600;font-size:16px}',
  '.sub{color:#646a73;font-size:13px;margin-top:2px}',
  '.actions{display:flex;gap:10px;margin-top:18px}',
  '.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 18px;border-radius:10px;border:1px solid #d0d3d6;background:#fff;color:#1f2329;text-decoration:none;font-size:16px;cursor:pointer}',
  '.btn.primary{background:#3370ff;border-color:#3370ff;color:#fff;flex:1}',
  '.result{font-size:18px;font-weight:600;margin:0 0 8px}',
  '.muted{color:#646a73}',
].join('\n');

const pageHtml = (body, texts) => '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<title>' + escapeHtml(texts.pageTitle) + '</title><style>' + CSS + '</style></head><body>'
  + '<div class="wrap">' + body + '</div></body></html>';

const itemHtml = (product) => {
  const name = [product.itemNo, product.color].filter(Boolean).join(' · ') || product.number || product.recordId;
  const sub = product.number && product.number !== name ? product.number : '';
  return '<label class="item"><input type="checkbox" name="product" value="' + escapeHtml(product.recordId) + '" checked>'
    + '<span><span class="name">' + escapeHtml(name) + '</span>'
    + (sub ? '<span class="sub">' + escapeHtml(sub) + '</span>' : '')
    + '</span></label>';
};

const renderPrintPromptPage = ({ token, products = [], returnUrl = '/workbench/', texts = PRINT_PROMPT_TEXTS } = {}) => {
  const rows = (products || []).map(itemHtml).join('');
  const body = '<div class="card"><h1>' + escapeHtml(texts.title) + '</h1>'
    + '<p class="hint">' + escapeHtml(texts.hint) + '</p>'
    + '<form method="post" action="/print-prompt?token=' + encodeURIComponent(String(token || '')) + '">'
    + rows
    + '<div class="actions"><a class="btn" href="' + escapeHtml(returnUrl) + '">' + escapeHtml(texts.noPrint) + '</a>'
    + '<button class="btn primary" type="submit">' + escapeHtml(texts.printSelected) + '</button></div>'
    + '</form></div>';
  return pageHtml(body, texts);
};

const renderPrintPromptInvalid = ({ texts = PRINT_PROMPT_TEXTS } = {}) => pageHtml(
  '<div class="card"><p class="result">' + escapeHtml(texts.invalidTitle) + '</p>'
  + '<p class="hint">' + escapeHtml(texts.invalidHint) + '</p>'
  + '<div class="actions"><a class="btn primary" href="/workbench/">' + escapeHtml(texts.back) + '</a></div></div>',
  texts,
);

module.exports = {
  renderPrintPromptPage,
  renderPrintPromptInvalid,
};
