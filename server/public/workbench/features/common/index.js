import { COMMON_ENTRIES } from '../../config/home.js';
import { escapeHtml } from '../../core/formatters.js';

// 「常用功能」的入口卡片 —— **清单（名称 / 图标 / 目标 / 顺序）在 `config/home.js`**，
// 这里只负责画（配置先行：加 / 减 / 改入口不改这个文件）。
//
// ⭐ 2026-10-08（业务负责人逐字，**ⓐ**）：「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，
//    只删退货那张卡……现在就是按照原来一样，**采购和退货用的是一个表单**，
//    所以你那个点击卡片上应该是"**报货与退货**"」
//    ⇒ 首页只剩【报货与退货】一张卡，它**直连报货飞书表单外链**（点一次直达）。
//    （上一版 ⓑ 曾指回工作台内页 `purchase-return.html` = 点两次，本次按新口径收回。）
//    清单仍在 `config/home.js`（配置先行），本文件只负责画、不写死清单与 URL。
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
