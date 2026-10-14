/**
 * ⭐⭐ 2026-10-14 晚：工作台「销售 → 配品」子页（业务负责人：「整体都迁移过去，只是入口变了，逻辑没有变」）。
 *   · 名称 = 「其他配品」只读下拉（`GET /api/workbench/sales/accessories` ✓ 与扫码页同源 ✓）
 *   · 数量默认 1 ✓（可填）· 成交金额**必填** ✓（空 ⇒ 前端当场拦住，服务端**也会** 400 ✓）
 *   · 提交 = **一步成单**（服务端 `addSaleLine(kind:'accessory')` + `submitSale` ✓ 同一把 `submitKey` ✓）
 *   · 🔴 零库存动作 ✓（配品没有鞋 —— 服务端只调那两个既有写方法 ✓）
 *   · 交互硬规矩：控件 ≥44px（`--control-height` ✓ 既有样式）· 点击**即时反馈**（置灰 + 换文案 ✓）
 *   · 空清单 ⇒ **人话空态卡** ✗ 不留空下拉 ✗；失败 ⇒ **如实报错** ✗ 绝不假装成功 ✗
 */
import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { ACCESSORY_API, ACCESSORY_FIELDS, ACCESSORY_DEFAULT_QUANTITY, ACCESSORY_TEXTS as T } from '../../config/accessory.js';

/** 一把键在**一次进入这一页**内固定：连点两次 / 重试都带同一把 ⇒ 服务端幂等 ⇒ 只建一单 ✓ */
const newSubmitKey = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return `acc-${c.randomUUID()}`;
  return `acc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
};

const optionHtml = (item) => `<option value="${escapeHtml(item.record_id)}">${escapeHtml(item.name || '')}</option>`;

export const createAccessoryModule = () => {
  const state = { submitKey: newSubmitKey(), items: [] };

  const cardHtml = () => {
    if (!state.items.length) {
      return `<div class="card" data-view="accessory-empty"><p>${escapeHtml(T.empty)}</p></div>`;
    }
    return `<div class="card" data-view="accessory-form">
  <h3>${escapeHtml(T.title)}</h3>
  <label>${escapeHtml(T.nameLabel)}
    <select data-field="accessory-name">${state.items.map(optionHtml).join('')}</select>
  </label>
  <label>${escapeHtml(T.quantityLabel)}
    <input data-field="accessory-quantity" type="number" min="1" inputmode="numeric" value="${ACCESSORY_DEFAULT_QUANTITY}">
  </label>
  <label>${escapeHtml(T.amountLabel)}
    <input data-field="accessory-amount" type="text" inputmode="decimal" placeholder="${escapeHtml(T.amountLabel)}">
  </label>
  <p data-view="accessory-notice" hidden></p>
  <button class="btn btn-primary" type="button" data-action="accessory-submit">${escapeHtml(T.submit)}</button>
</div>`;
  };

  const noticeOf = (host, text, isError = false) => {
    const node = host.querySelector('[data-view="accessory-notice"]');
    if (!node) return;
    node.hidden = !text;
    node.textContent = text;
    node.setAttribute('data-error', isError ? '1' : '0');
  };

  const submit = async (host, button) => {
    const name = host.querySelector('[data-field="accessory-name"]');
    const amountInput = host.querySelector('[data-field="accessory-amount"]');
    const quantityInput = host.querySelector('[data-field="accessory-quantity"]');
    const amount = String(amountInput?.value ?? '').trim();
    // ⭐ 成交金额**必填**：空 / 非正数 ⇒ 当场拦住 + 人话（服务端也会 400 兜底 ✓）
    if (!(Number(amount) > 0)) {
      noticeOf(host, T.amountRequired, true);
      return;
    }
    // 点击**即时反馈**：置灰 + 换文案（`.btn:disabled` 已有 cursor:wait / opacity ✓）
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = T.submitting;
    try {
      const result = await api.post(ACCESSORY_API.submit, {
        [ACCESSORY_FIELDS.accessoryId]: name?.value || '',
        [ACCESSORY_FIELDS.quantity]: String(quantityInput?.value ?? ACCESSORY_DEFAULT_QUANTITY),
        [ACCESSORY_FIELDS.amount]: amount,
        [ACCESSORY_FIELDS.submitKey]: state.submitKey,
      });
      noticeOf(host, `${T.created} ${result?.order_no || ''}`.trim(), false);
    } catch (error) {
      // 🔴 失败 ⇒ **如实**（服务端的人话优先 ✓）—— 绝不假装成功 ✗；按钮恢复 ⇒ 她可以再来一次 ✓
      noticeOf(host, error?.message || T.submitFailed, true);
    } finally {
      button.textContent = T.submit;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  };

  return {
    async mount(host) {
      host.innerHTML = `<div class="card" data-view="accessory-loading"><p>${escapeHtml(T.title)}</p></div>`;
      try {
        const result = await api.get(ACCESSORY_API.list);
        state.items = Array.isArray(result?.accessories) ? result.accessories : [];
      } catch (error) {
        state.items = [];
        host.innerHTML = `<div class="card" data-view="accessory-error"><p>${escapeHtml(error?.message || T.listFailed)}</p></div>`;
        return;
      }
      host.innerHTML = cardHtml();
      const button = host.querySelector('[data-action="accessory-submit"]');
      if (button) button.addEventListener('click', () => submit(host, button));
    },
  };
};
