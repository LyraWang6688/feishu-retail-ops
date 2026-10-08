/**
 * 工作台「信息录入 → 鞋盒标签打印」页面 —— 业务负责人 2026-10-08 批准的第一个功能。
 *
 * 她点哪里 / 怎么用：
 *   ① 选条件（货号 / 所属状态 / 类别 / 尺码 / 最近新增 / 排序）→「查询可打印的标签」；
 *   ② 下面就是 A4 预览（每张 50×30mm，同款同码有几双就出几张，**每张都印**）；
 *   ③ 点「打印这些标签」→ 浏览器打印对话框 → 选 A4、缩放 100% → 打印 → 沿虚线剪开贴鞋盒。
 *
 * ⚠️ 排版参数**全部来自服务端** `config/labelPrint.js`（随响应 `layout` 下来，
 *    落到 `@page` 与 CSS 变量上）—— 改标签纸尺寸 / 字号 / 印哪些字段只改服务端 config，
 *    这个文件与 `render.js` 都不用动（配置先行）。
 * ⚠️ 只读页面：整页**只有一次** `GET /api/workbench/labels`（一次写入都不发；
 *    「类别」下拉的候选也来自这次响应，不另查库存）。
 */
import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { describeError, setBusy, showPageError } from '../../core/ui.js';
import { FILTER_OPTIONS, TEXTS, pageStyleText, sheetHtml, sheetStyleVars, summaryHtml } from './render.js';

const $ = (container, selector) => container.querySelector(selector);

const stateLabel = (state) => FILTER_OPTIONS.stateLabels[state] || state;
const recentLabel = (days) => FILTER_OPTIONS.recentDayLabels[days] || `最近 ${days} 天`;
const sortLabel = (sort) => FILTER_OPTIONS.sortLabels[sort] || sort;

function renderShell(container) {
  container.innerHTML = `
    <section class="panel no-print">
      <div class="panel-header">
        <div>
          <h2>${escapeHtml(TEXTS.title)}</h2>
          <p class="subtitle">${escapeHtml(TEXTS.subtitle)}</p>
        </div>
      </div>
      <div class="toolbar compact-toolbar label-filters">
        <label class="form-field grow">货号 / 颜色 / 类别
          <input data-field="keyword" placeholder="例如 XHB8095；留空 = 不按关键字过滤">
        </label>
        <label class="form-field">所属状态
          <select data-field="state">
            ${FILTER_OPTIONS.states.map((state) => `<option value="${escapeHtml(state)}">${escapeHtml(stateLabel(state))}</option>`).join('')}
          </select>
        </label>
        <label class="form-field">类别
          <select data-field="category"><option value="">全部类别</option></select>
        </label>
      </div>
      <div class="toolbar compact-toolbar label-filters">
        <label class="form-field">尺码
          <input data-field="size" type="number" min="1" step="1" inputmode="numeric" placeholder="例如 42">
        </label>
        <label class="form-field">最近新增
          <select data-field="recent-days">
            ${FILTER_OPTIONS.recentDays.map((days) => `<option value="${days}">${escapeHtml(recentLabel(days))}</option>`).join('')}
          </select>
        </label>
        <label class="form-field grow">排序
          <select data-field="sort">
            ${FILTER_OPTIONS.sorts.map((sort) => `<option value="${escapeHtml(sort)}">${escapeHtml(sortLabel(sort))}</option>`).join('')}
          </select>
        </label>
        <button class="btn btn-primary" type="button" data-action="query">${escapeHtml(TEXTS.queryButton)}</button>
      </div>
      <div data-view="summary"><p class="label-summary">${escapeHtml(TEXTS.initial)}</p></div>
      <div class="label-print-bar">
        <button class="btn btn-primary" type="button" data-action="print" disabled>${escapeHtml(TEXTS.printButton)}</button>
        <span class="muted">${escapeHtml(TEXTS.printHint)}</span>
      </div>
      <p class="data-caption" data-view="scan-url"></p>
    </section>
    <section class="label-preview">
      <div class="label-sheet-scroll">
        <div id="label-sheet" class="label-sheet"></div>
      </div>
    </section>`;
}

export function createLabelPrintModule() {
  const state = { container: null, layout: null };

  const panel = () => $(state.container, '.panel');
  const sheet = () => $(state.container, '#label-sheet');
  const printButton = () => $(state.container, '[data-action="print"]');

  /** 把服务端来的排版参数落到 `@page` 与 CSS 变量上（配置驱动，页面不写死 mm）。 */
  function applyLayout(layout, labels) {
    const styleId = 'label-print-page-style';
    let style = document.getElementById(styleId);
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.append(style);
    }
    style.textContent = pageStyleText(layout);
    const target = sheet();
    target.setAttribute('style', sheetStyleVars(layout));
    target.innerHTML = sheetHtml(labels, layout);
  }

  /**
   * 「类别」下拉的候选**不另发请求**：直接用这次响应里 `filters.category_options`
   * （= 服务端从「实时库存」解析出来的类别去重，与筛选用的是同一个来源 ⇒ 选了一定有结果）。
   */
  function fillCategories(options) {
    const select = $(panel(), '[data-field="category"]');
    const selected = select.value;
    const list = Array.isArray(options) ? options : [];
    select.innerHTML = '<option value="">全部类别</option>'
      + list.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    select.value = list.includes(selected) ? selected : '';
  }

  function currentFilters() {
    const form = panel();
    return {
      keyword: $(form, '[data-field="keyword"]').value.trim(),
      state: $(form, '[data-field="state"]').value,
      category: $(form, '[data-field="category"]').value,
      size: $(form, '[data-field="size"]').value.trim(),
      recentDays: $(form, '[data-field="recent-days"]').value,
      sort: $(form, '[data-field="sort"]').value,
    };
  }

  async function query(button) {
    const filters = currentFilters();
    const params = new URLSearchParams();
    if (filters.keyword) params.set('keyword', filters.keyword);
    if (filters.state) params.set('state', filters.state);
    if (filters.category) params.set('category', filters.category);
    if (filters.size) params.set('size', filters.size);
    if (filters.recentDays && filters.recentDays !== '0') params.set('recentDays', filters.recentDays);
    if (filters.sort) params.set('sort', filters.sort);

    showPageError('');
    $(panel(), '[data-view="summary"]').innerHTML = `<p class="label-summary">${escapeHtml(TEXTS.loading)}</p>`;
    setBusy(button, true, TEXTS.loading);
    try {
      const data = await api.get(`/api/workbench/labels?${params}`);
      state.layout = data.layout;
      applyLayout(data.layout, data.labels || []);
      $(panel(), '[data-view="summary"]').innerHTML = summaryHtml(data);
      $(panel(), '[data-view="scan-url"]').textContent = `${TEXTS.scanUrlCaption}${data.qr?.url_template || ''}`;
      fillCategories(data.filters?.category_options);
      const printable = (data.labels || []).length > 0;
      printButton().disabled = !printable;
      printButton().title = printable ? '' : TEXTS.printDisabled;
    } catch (error) {
      // 空结果不是错误（service 回 200 + 空 labels）；这里只有真失败才走到。
      $(panel(), '[data-view="summary"]').innerHTML = `<p class="label-notice">${escapeHtml(describeError(error))}</p>`;
      applyLayout(state.layout || fallbackLayout(), []);
      printButton().disabled = true;
      showPageError(describeError(error));
    } finally {
      setBusy(button, false);
    }
  }

  // 还没成功查到 layout 就失败时，用一份"最小可用"的默认排版把预览区画出来
  //（尺寸的真源头仍是服务端 `config/labelPrint.js`；这里只是别让预览区空着。
  //  ⚠️ 这几个数字是**镜子**：改了服务端 config 的默认值，这里也要跟着改 —— 只影响
  //  "第一次查询就失败"那一屏，成功一次之后一律用服务端下来的 layout）。
  const fallbackLayout = () => ({
    label: { widthMm: 50, heightMm: 30, paddingMm: 1.5 },
    page: { name: 'A4', widthMm: 210, heightMm: 297, marginMm: { top: 6, right: 6, bottom: 6, left: 6 } },
    grid: { columns: 3, rows: 9, perPage: 27, usableWidthMm: 198, gapXMm: 0, gapYMm: 0 },
    typography: { itemNoMm: 5, fieldMm: 2.6, footerMm: 1.7, qrSizeMm: 18 },
    fields: { qr: true, itemNo: true, color: true, category: true, size: true, state: true, footer: true },
    texts: { sizeSuffix: '码', missingValue: '—' },
  });

  return {
    mount(container) {
      state.container = container;
      renderShell(container);
      $(panel(), '[data-action="query"]').addEventListener('click', (event) => query(event.currentTarget));
      $(panel(), '[data-field="keyword"]').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') $(panel(), '[data-action="query"]').click();
      });
      printButton().addEventListener('click', () => window.print());
      applyLayout(fallbackLayout(), []);
      // 打开页面就先查一次（不填条件 = 全部库存，最多 config 里的张数）：
      // 免得她一进来看到一片空白、以为坏了。
      query($(panel(), '[data-action="query"]'));
    },
  };
}
