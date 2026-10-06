import { escapeHtml } from '../../core/formatters.js';

// 「常用功能」的入口卡片。加/减功能只改这张表。
const ENTRIES = [
  {
    icon: '🧮',
    title: '库存手工调整',
    desc: '盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）',
    href: '/workbench/inventory-adjustment.html',
  },
  {
    icon: '📦',
    title: '采购和退货',
    desc: '采购申请、采购退货两个飞书表单，点一下直接去填写',
    href: '/workbench/purchase-return.html',
  },
];

export function createCommonModule({ focused = false } = {}) {
  return {
    mount(container) {
      container.innerHTML = `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>常用功能</h2>
              <p class="subtitle">日常最常用的两个手工入口；点卡片进入各自的独立页面</p>
            </div>
          </div>
          <div class="quick-entries entries-two">
            ${ENTRIES.map((entry) => `
              <a class="entry-card" href="${escapeHtml(entry.href)}">
                <div class="icon">${entry.icon}</div>
                <h3>${escapeHtml(entry.title)}</h3>
                <p>${escapeHtml(entry.desc)}</p>
                <div class="arrow">进入 →</div>
              </a>`).join('')}
          </div>
          ${focused ? '' : `
            <h3 class="section-title">其余常用页面</h3>
            <div class="inline-links">
              <a class="btn" href="/workbench/sales-query.html">销售查询</a>
              <a class="btn" href="/workbench/inventory.html">实时库存</a>
            </div>`}
        </section>`;
    },
  };
}
