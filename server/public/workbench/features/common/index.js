import { COMMON_ENTRIES } from '../../config/home.js';
import { escapeHtml } from '../../core/formatters.js';

// 「常用功能」的入口卡片 —— **清单（名称 / 图标 / 目标 / 顺序）在 `config/home.js`**，
// 这里只负责画（配置先行：加 / 减 / 改入口不改这个文件）。
//
// ⭐ 2026-10-07：原来是【一个】「采购和退货」入口 → 进 `purchase-return.html` 再点一次，
//    业务负责人要「不需要多点一次」。现在首页就是【采购】【退货】两张卡，
//    各自**直接落在对应的飞书表单**上（href 来自 config/home.js → config/links.js）。
//    ⚠️ `purchase-return.html` **一个字没改**：别人收藏的老链接照样能开，
//       仍然显示「报货」「退货」两张表单卡（默认视图 = 两张都显示）。
//
// ⚠️ 外链**同窗口跳转**（故意不加 `target="_blank"`）：用户实际是在手机上、多半是
//    飞书内置浏览器里打开工作台，新窗口/新标签页在内置浏览器里体验差、还可能被拦；
//    同一窗口一跳就走，返回键直接回工作台。`rel="noopener"` 保底。
export function createCommonModule({ focused = false } = {}) {
  return {
    mount(container) {
      container.innerHTML = `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>常用功能</h2>
              <p class="subtitle">日常最常用的入口；点卡片直接去填写或操作</p>
            </div>
          </div>
          <div class="quick-entries entries-pair">
            ${COMMON_ENTRIES.map((entry) => `
              <a class="entry-card${entry.wide ? ' entry-wide' : ''}" href="${escapeHtml(entry.href)}" rel="noopener">
                <div class="icon">${entry.icon}</div>
                <h3>${escapeHtml(entry.title)}</h3>
                <p>${escapeHtml(entry.desc)}</p>
                <div class="arrow">${escapeHtml(entry.arrow || '进入 →')}</div>
              </a>`).join('')}
          </div>
        </section>`;
    },
  };
}
