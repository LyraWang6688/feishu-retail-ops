import { escapeHtml } from '../../core/formatters.js';

export function createPlaceholderModule({ title, description, planned = [] }) {
  return {
    mount(container) {
      container.innerHTML = `
        <section class="panel placeholder-panel">
          <div class="placeholder-icon" aria-hidden="true">⌛</div>
          <h2>${escapeHtml(title)}</h2>
          <p>${escapeHtml(description)}</p>
          ${planned.length ? `<ul>${planned.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
          <span class="tag tag-info">规划中</span>
        </section>`;
    },
  };
}
