import { domainById } from '../../config/domains.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { createInventoryAdjustmentModule } from '../inventory/adjustment.js';
import { createOrdersModule } from '../orders/index.js';
import { entryTarget } from './pages.js';
import { domainPageHtml, domainSubTabsHtml } from './nav.js';

/**
 * ⭐⭐ 工作台**领域 tab** 的骨架（业务负责人 2026-10-09 定的最终结构）。
 *
 * 一个领域 = 一个一级 tab = **若干子页面**（清单在 `config/domains.js`，本文件只负责画与切换）：
 *   | Tab  | 子页面                                                        |
 *   | 销售 | 销售建单 · 订单列表 · 销售查询                                 |
 *   | 库存 | 单款查询 · 全仓查询 · 手工调整                                 |
 *   | 采购 | 报货 / 验收 / 退货 · 采购订单列表                              |
 *   | 货品 | 货品上新 · 标签打印（单个 / 批量）                             |
 *
 * ⚠️ **一个字节的业务逻辑都不在这里**：每个子页面要么是**既有模块**（订单列表 / 库存手工调整 /
 *    查询外链卡），要么是一个"把编号交给既有页面"的小入口（见 `pages.js`）——
 *    她说的「点击的按钮不同，触发的逻辑就不一样」由**既有业务处理层**决定，不在这里重写。
 *
 * ⚠️ 子 tab 的标记刻意用 `data-domain-page`（**不是** `data-subtab`）：
 *    内嵌的「订单列表」「库存手工调整」模块自己也用 `data-subtab` 做**它们内部**的子 tab，
 *    两边混用的话，点它们内部的子 tab 会把领域页切走（真踩过的坑）。
 */

export function createDomainModule(domainId) {
  const domain = domainById(domainId);
  const state = { container: null, active: domain.pages[0].id, mounted: new Set() };

  const hostOf = (pageId) => state.container?.querySelector(`[data-domain-host="${pageId}"]`);

  function activate(pageId) {
    const page = domain.pages.find((item) => item.id === pageId) || domain.pages[0];
    state.active = page.id;
    state.container.querySelectorAll('[data-domain-page]').forEach((tab) => {
      const on = tab.dataset.domainPage === page.id;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    });
    state.container.querySelectorAll('[data-domain-host]').forEach((host) => {
      host.classList.toggle('hidden', host.dataset.domainHost !== page.id);
    });
    showPageError('');
    if (state.mounted.has(page.id)) return;
    state.mounted.add(page.id);
    const host = hostOf(page.id);
    if (!host) return;
    // 两个"既有模块"直接挂进来（切回来时不用重挂 —— 状态留在模块自己那儿）。
    if (page.kind === 'orders') return void createOrdersModule({ mode: page.mode }).mount(host);
    if (page.kind === 'inventory-adjustment') return void createInventoryAdjustmentModule().mount(host);
    host.innerHTML = domainPageHtml(page);
    return undefined;
  }

  return {
    mount(container) {
      state.container = container;
      container.innerHTML = `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>${escapeHtml(domain.title)}</h2>
              <p class="subtitle">${escapeHtml(domain.subtitle || '')}</p>
            </div>
          </div>
          <div class="sub-tabs" data-view="domain-subtabs">${domainSubTabsHtml(domain, state.active)}</div>
          ${domain.pages.map((page) => `<div class="sub-panel${page.id === state.active ? '' : ' hidden'}" data-domain-host="${escapeHtml(page.id)}"></div>`).join('\n          ')}
        </section>`;

      container.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-domain-page]');
        if (tab) return activate(tab.dataset.domainPage);
        // 「跳到本 tab 里的另一个子页」（例：采购 → 验收 → 采购订单列表）
        const jump = event.target.closest('[data-jump]');
        if (jump) return activate(jump.dataset.jump);
        return undefined;
      });

      // 「输入编号 → 打开既有页面」：目标 URL 由配置模板拼（不在这里写死路径）。
      container.addEventListener('submit', (event) => {
        const form = event.target.closest('[data-entry-form]');
        if (!form) return;
        event.preventDefault();
        const raw = form.querySelector('input[name="number"]')?.value || '';
        const target = entryTarget(form.dataset.targetTemplate, raw);
        if (!target) return showPageError('先填编号，再点打开');
        showPageError('');
        return window.location.assign(target);
      });

      activate(state.active);
    },
  };
}
