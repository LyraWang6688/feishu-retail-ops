/**
 * 2026-11-18：验收「哪个入库尺码做样品」的前端纯逻辑 + 弹窗。
 * 从 acceptanceDoc.js 拆出（文件大小棘轮）；只负责交互，不写库。
 */

/**
 * 2026-11-18：一个弹窗分产品选样品尺码。
 * 所有产品都选完，确定按钮才可用；取消 = 回到验收页，不提交。
 */
export function openSampleChoiceModal({ products, texts, escapeHtml }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'sample-choice-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    const productHtml = products.map((product, index) => {
      const label = [product.itemNo, product.color].filter(Boolean).join(' · ')
        || product.number || product.productRecordId;
      const status = product.hasStock ? texts.sampleChoiceNoSample : texts.sampleChoiceNoStock;
      const options = product.candidates.map((candidate) => `<label class="sample-choice-option">
<input type="radio" name="sample-choice-${index}" value="${escapeHtml(String(candidate.size))}" data-product="${escapeHtml(product.productRecordId)}">
<span>${escapeHtml(String(candidate.size))} 码</span>
</label>`).join('');
      return `<section class="sample-choice-product" data-sample-product="${escapeHtml(product.productRecordId)}">
<h4>${escapeHtml(label)}</h4>
<p>${escapeHtml(status)}</p>
<div class="sample-choice-options">${options}</div>
</section>`;
    }).join('');
    overlay.innerHTML = `<div class="sample-choice-card">
<h3>${escapeHtml(texts.sampleChoiceTitle)}</h3>
<p>${escapeHtml(texts.sampleChoiceBody)}</p>
<form class="sample-choice-form">
${productHtml}
<p class="sample-choice-error" data-sample-choice-error hidden>${escapeHtml(texts.sampleChoiceRequired)}</p>
<div class="sample-choice-actions">
<button type="button" class="btn btn-ghost" data-sample-choice-cancel>${escapeHtml(texts.sampleChoiceCancel)}</button>
<button type="button" class="btn btn-primary" data-sample-choice-confirm disabled>${escapeHtml(texts.sampleChoiceConfirm)}</button>
</div>
</form>
</div>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('.sample-choice-form');
    const confirm = overlay.querySelector('[data-sample-choice-confirm]');
    const error = overlay.querySelector('[data-sample-choice-error]');
    const selected = () => {
      const out = {};
      for (const product of products) {
        const checked = form.querySelector(`input[data-product="${product.productRecordId}"]:checked`);
        if (checked) out[product.productRecordId] = Number(checked.value);
      }
      return out;
    };
    const refresh = () => {
      const chosen = selected();
      const complete = products.every((product) => chosen[product.productRecordId] !== undefined);
      confirm.disabled = !complete;
      error.hidden = complete;
    };
    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { cleanup(); resolve(null); }
    };
    form.addEventListener('change', refresh);
    form.addEventListener('submit', (event) => event.preventDefault());
    overlay.querySelector('[data-sample-choice-cancel]').addEventListener('click', () => {
      cleanup(); resolve(null);
    });
    confirm.addEventListener('click', () => {
      refresh();
      if (confirm.disabled) return;
      const chosen = selected();
      cleanup();
      resolve(chosen);
    });
    document.addEventListener('keydown', onKey);
    refresh();
    const first = form.querySelector('input[type="radio"]');
    if (first) first.focus();
  });
}
