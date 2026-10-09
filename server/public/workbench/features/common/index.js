import { COMMON_ENTRIES } from '../../config/home.js';
import { escapeHtml } from '../../core/formatters.js';

// 「**信息录入**」（原「常用功能」，业务负责人 2026-10-08 **只改名**）的入口卡片 ——
// **清单（名称 / 图标 / 目标 / 顺序）在 `config/home.js`**，
// 这里只负责画（配置先行：加 / 减 / 改入口不改这个文件）。
//
// ⭐ 2026-10-08（业务负责人逐字）：「**1. 信息录入**：实际上就是"常用功能"，
//    把那个 tab 页的名字改一下就行」 ⇒ **只改显示文案，里面的两个入口一个字节不动**。
//
// ⭐ 2026-10-08（业务负责人逐字，**ⓐ**）：「ⓐ（另一种）：**采购卡继续点一次直达报货表单**，
//    只删退货那张卡……现在就是按照原来一样，**采购和退货用的是一个表单**，
//    所以你那个点击卡片上应该是"**报货与退货**"」
//    ⇒ 首页只剩【报货与退货】一张卡，它**直连报货飞书表单外链**（点一次直达）。
//    （上一版 ⓑ 曾指回工作台内页 `purchase-return.html` = 点两次，本次按新口径收回。）
//    清单仍在 `config/home.js`（配置先行），本文件只负责画、不写死清单与 URL。
//    ⚠️ `purchase-return.html` 那一页**2026-10-09 已被她点头删掉**（"原样能开"是改动前的历史）。
// ⚠️ 2026-10-09（业务负责人点头）：承载这一份卡片的**老首页 `common.html` 也从仓库删掉了**
//    （「代码从仓库里删，不是隐藏」；同批删的还有 `others.html` / `purchase.html` /
//      `purchase-return.html`）⇒ 本模块**当前没有任何页面挂载它**（`standalone.js` 里的
//    `common` 注册已摘）。清单（`config/home.js`）与渲染口径**先留着没删**：
//    · 三张卡的等价入口在四个领域 tab 上都有（采购 → 报货 / 退货 · 库存 → 手工调整 · 货品 → 标签打印）；
//    · 要不要把本模块也一起删，等她一句话（她的习惯口径是"连代码一起删"）。
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
              <h2>信息录入</h2>
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
