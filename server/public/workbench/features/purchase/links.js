import { PURCHASE_FORMS } from '../../config/links.js';
import { escapeHtml } from '../../core/formatters.js';

// 「采购和退货」——常用功能里的第二个子页。
// ⚠️ 2026-10-09（业务负责人点头）：它服务的那个独立页 `purchase-return.html` **已从仓库删掉**
//    （同批删的还有 `common.html` / `others.html` / `purchase.html`）⇒ 本模块**当前没有页面挂载**。
//    两张表单卡现在的正式入口在「采购」tab ①「报货 / 验收 / 退货」（`config/domains.js`），
//    URL 仍是 `config/links.js` 那一份；本模块**先留着没删**，等业务负责人一句话。
//
// 业务负责人 2026-10-06 定的口径（`docs/workbench-requirements-2026-10-06.md` 一①）：
//   **这个子页只放两个飞书表单链接** —— 不自建表单、不做查询、不查后端接口。
//   （原话：「采购和退货的话，实际上它就是多维表格，给到多维表格的两个表单链接就可以」）
// 所以这里**没有任何 api.get** —— 上一版那个「采购 / 退货」查询 UI 已整体去掉。
//
// 链接本身在 `config/links.js`（配置先行：换链接只改那一个文件），这里只负责画。
//
// ⚠️ 移动端**同窗口跳转**（故意不加 `target="_blank"`）：用户实际是在手机上、多半是
//    飞书内置浏览器里打开工作台，新窗口/新标签页在内置浏览器里体验差、还可能被拦；
//    同窗口一跳就走，返回键直接回工作台。`rel="noopener"` 保底。
export function createPurchaseLinksModule() {
  return {
    mount(container) {
      container.innerHTML = `
        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>采购和退货</h2>
              <p class="subtitle">点下面两个按钮，直接打开对应的飞书表单填写</p>
            </div>
          </div>
          <div class="purchase-links">
            ${PURCHASE_FORMS.map((form) => `
              <a class="purchase-link-card" href="${escapeHtml(form.url)}" rel="noopener">
                <div class="icon" aria-hidden="true">${escapeHtml(form.icon)}</div>
                <div class="text">
                  <h3>${escapeHtml(form.title)}</h3>
                  <p>${escapeHtml(form.desc)}</p>
                </div>
                <div class="arrow">去填写 →</div>
              </a>`).join('')}
          </div>
        </section>`;
    },
  };
}
