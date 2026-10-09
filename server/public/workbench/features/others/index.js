import { LEGACY_ENTRIES, OTHERS_PAGE, PLANNED_MODULES } from '../../config/others.js';
import { escapeHtml } from '../../core/formatters.js';
import { cardsHtml } from '../domains/pages.js';

/**
 * 「**其它 / 历史功能**」页 —— 业务负责人 2026-10-09 换四个领域 tab 时的硬要求：
 *   「**其余旧功能不删**：集中到一个不显眼的"其它/历史功能"入口（例如页脚一行，点开一个独立页列出它们）」。
 *
 * ⇒ 工作台首页页脚那一行 `其它 / 历史功能` → `/workbench/others.html`（本模块渲染）：
 *   · 上半页 = `LEGACY_ENTRIES`（**能点进去**，功能原样：信息录入首页 / 采购管理 / 三个独立页）；
 *   · 下半页 = `PLANNED_MODULES`（一直只是占位的三个模块，如实列出来，不是能点的入口）。
 * ⚠️ 清单在 `config/others.js`（配置先行），本文件只负责画。
 */
export const othersCardsHtml = (entries = LEGACY_ENTRIES) => `<div class="domain-cards">${cardsHtml(entries)}</div>`;

export const plannedModulesHtml = (modules = PLANNED_MODULES) => modules.map((module) => `
        <article class="list-card" data-planned="${escapeHtml(module.id)}">
          <div class="info">
            <div class="title">${escapeHtml(`${module.icon || ''} ${module.title}`.trim())}</div>
            <div class="desc">${escapeHtml(module.desc || '')}${module.planned?.length ? `（规划：${escapeHtml(module.planned.join(' · '))}）` : ''}</div>
          </div>
          <div class="card-action"><span class="tag tag-info">规划中</span></div>
        </article>`).join('');

export function createOthersModule() {
  return {
    mount(container) {
      container.innerHTML = `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>${escapeHtml(OTHERS_PAGE.title)}</h2>
              <p class="subtitle">${escapeHtml(OTHERS_PAGE.subtitle)}</p>
            </div>
          </div>
          ${LEGACY_ENTRIES.length ? othersCardsHtml() : `<p class="empty">${escapeHtml(OTHERS_PAGE.empty)}</p>`}
          <h3 class="section-title">${escapeHtml(OTHERS_PAGE.plannedTitle)}</h3>
          ${plannedModulesHtml()}
        </section>`;
    },
  };
}
