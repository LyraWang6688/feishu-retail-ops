import { escapeHtml } from '../../core/formatters.js';

/**
 * 「**待建设**」—— 占位页统一的那一句话（业务负责人 2026-10-09）。
 *
 * 她用它的地方：
 *   · 领域 tab 里的**占位子页面**（客户往来款 / 采购订单列表 / 供应商往来款，
 *     见 `config/domains.js` 的 `kind: 'placeholder'`）；
 *   · 一直只是占位的那三个模块（资金管理 / 抖音运营 / 平台管理，见 `config/others.js`）。
 * ⚠️ 两个地方**共用这一个常量**（统一口径：占位就写"待建设"，不各写各的说法）。
 */
export const PLACEHOLDER_STATUS = '待建设';

export function createPlaceholderModule({ title, description, planned = [], status = PLACEHOLDER_STATUS }) {
  return {
    mount(container) {
      container.innerHTML = `
        <section class="panel placeholder-panel">
          <div class="placeholder-icon" aria-hidden="true">⌛</div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
          ${planned.length ? `<ul>${planned.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
          <span class="tag tag-info">${escapeHtml(status)}</span>
        </section>`;
    },
  };
}
