import { domainById } from '../../config/domains.js';
import { escapeHtml } from '../../core/formatters.js';
import { showPageError } from '../../core/ui.js';
import { createInventoryAdjustmentModule } from '../inventory/adjustment.js';
import { createOrdersModule } from '../orders/index.js';
import { createScanModule } from '../scan/index.js';
import { createAccessoryModule } from '../accessory/index.js';
import { entryTarget } from './pages.js';
import { domainPageHtml, domainSubTabsHtml, resolveTabClick } from './nav.js';

/**
 * ⭐⭐ 工作台**领域 tab** 的骨架（业务负责人 2026-10-09 定的最终结构）。
 *
 * 一个领域 = 一个一级 tab = **若干子页面**（清单在 `config/domains.js`，本文件只负责画与切换）：
 *   | Tab  | 子页面                                                        |
 *   | 销售 | 订单列表 · 销售查询（直跳）· 客户往来款（占位）                  |
 *   | 库存 | 全仓查询（直跳）· 手工调整                                     |
 *   | 采购 | 订单列表（占位）· 供应商往来款（占位）                            |
 *   | 货品 | 货品上新（直跳）· 标签打印                                     |
 *   ⚠️ **2026-10-12**（业务负责人）：① 销售不再有「销售建单」、库存不再有「单款查询」、
 *      采购不再有「验收到货」——**都是只删工作台入口**，后端链路一条没删
 *      （见 `config/domains.js` 里各自的注释）；② 「销售查询 / 全仓查询 / 货品上新」
 *      **点一次就到**她配的外链（下面的点击处理 + `nav.js` 的 `resolveTabClick`）。
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
    // ⭐ 2026-10-10：「验收到货」走的就是下面这条 —— 它是**独立子页**（`kind: 'orders'` /
    //    `mode: 'purchase'`），点一下子 tab 换一屏；**不是**在报货那一页下面展开
    //    （她真机反馈：「不应该是一点完之后在同一个 tab 页里下面出现」）。
    // ⭐「扫一扫」是一屏独立页面（kind: 'scan'）—— 复用既有机制，不动别的 kind ✓
    if (page.kind === 'scan') return void createScanModule().mount(host);
    if (page.kind === 'orders') return void createOrdersModule({ mode: page.mode }).mount(host);
    if (page.kind === 'inventory-adjustment') return void createInventoryAdjustmentModule().mount(host);
    // 2026-10-14: accessory sales has its own sub-page (kind 'accessory')
    if (page.kind === 'accessory') return void createAccessoryModule().mount(host);
    host.innerHTML = domainPageHtml(page);
    return undefined;
  }

  return {
    mount(container) {
      state.container = container;
      // ⭐ 2026-10-10（业务负责人真机反馈：「我已经点到了采购，直接出来报货、退货、到货就行，
      //    下面的这些文字解释就不用了」）⇒ **一级领域的大标题与它下面那行描述整行删掉**：
      //    一级 tab 上已经写了领域名，页内再写一遍就是"说明书"。
      //    她要留的只有**子 tab + 卡片 + 按钮**（下面那些）。见 `test/workbenchNoManualText.test.js` AC1。
      // ⭐⭐ 2026-10-13 晚（她：「面板里那个「扫一扫」小标题 + 空框也要去掉」✗）：
      //    **只有一个子页的领域**（= 「扫一扫」）不再画子 tab 条 —— 那条「扫一扫」小标题
      //    在一级 tab 上已经写了（她要的是**面板真空** ✓）。
      //    ⚠️ 其余领域（销售 / 库存 / 采购 / 货品，都是多子页）**一个字不变** ✓
      const subTabsHtml = domain.pages.length > 1
        ? `<div class="sub-tabs" data-view="domain-subtabs">${domainSubTabsHtml(domain, state.active)}</div>`
        : '';
      container.innerHTML = `
        <section class="panel">
          ${subTabsHtml}
          ${domain.pages.map((page) => `<div class="sub-panel${page.id === state.active ? '' : ' hidden'}" data-domain-host="${escapeHtml(page.id)}"></div>`).join('\n          ')}
        </section>`;

      container.addEventListener('click', (event) => {
        const tab = event.target.closest('[data-domain-page]');
        if (tab) {
          const page = domain.pages.find((item) => item.id === tab.dataset.domainPage) || domain.pages[0];
          // ⭐ 2026-10-12（业务负责人）：「点击了『销售查询』这个按钮之后，**系统可以直接自动跳转**……
          //    **不需要让我再去点一下那个消息查询的卡片**」⇒ 配了 `directJump` 的子 tab **一次点击就跳走**
          //    （目标 URL 全部来自配置；空 href 不产生目标 ⇒ 回落到切页 + 不可点卡片，没有死链）。
          const action = resolveTabClick(page);
          if (action.jump) return void window.location.assign(action.jump);
          return activate(action.activate);
        }
        // 「跳到本 tab 里的另一个子页」（由 `data-jump` 卡片触发的老路，机制保留）
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
