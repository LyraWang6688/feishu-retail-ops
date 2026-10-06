import { escapeHtml } from '../../core/formatters.js';

// 「常用功能」的入口卡片。加/减功能只改这张表。
// ⭐ 只保留两个入口（业务负责人 2026-10-06：「常用里只保留库存和采购，其他不需要」），
//    且【采购和退货在上、库存手工调整在下】（她：「采购放在库存上面」）。
const ENTRIES = [
  {
    icon: '📦',
    title: '采购和退货',
    desc: '报货、退货两个飞书表单，点一下直接去填写',
    href: '/workbench/purchase-return.html',
  },
  {
    icon: '🧮',
    title: '库存手工调整',
    desc: '盘点调整（改数量，盘多了加、盘少了减）· 换季调整（门盒/样品 ↔ 仓库，数量不变）',
    href: '/workbench/inventory-adjustment.html',
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
        </section>`;
    },
  };
}
