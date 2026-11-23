import { api } from '../../core/api-client.js';
import { escapeHtml } from '../../core/formatters.js';
import { describeError, showPageError } from '../../core/ui.js';
import { arrivalLineKey, arrivalSubmitLines } from './acceptanceDoc.js';

// 兼容既有调用方/用例：这两个纯函数仍从 index.js 导出。
export { arrivalLineKey, arrivalSubmitLines };
import {
  ORDERS_API, ORDERS_PAGE, ORDERS_TEXTS,
  SALES_SECTIONS, SALES_DELIVERY_PAGE,
  PURCHASE_ORDER_BEHAVIOR_CODE, PURCHASE_IN_BEHAVIOR_CODE,
} from '../../config/orders.js';

// 工作台【订单列表】—— 一级 tab 的第三个（**只剩三条路径**，业务负责人 2026-10-29 定稿）。
//
// 现状（2026-10-29 清理后）：
//   · **销售侧**：这一页只画**三张入口卡** —— 交割单（跳独立页）/ 售后单（飞书扫一扫→售后落地页）/
//     草稿箱（占位）；**老订单列表 / 订单详情 / 售后折叠区 / 补收款 / 交付 / 二次交付 / 补实收 /
//     补样品 已整体删除**（业务：前端不用保留老订单列表；后端业务服务层保留，供独立页复用）。
//   · **采购侧**：保留既有「验收到货」页（`mode: 'purchase'`，hidden 页面，行为不变）。
//
// ⚠️ 保留的东西**不许再删**（业务负责人点名）：三卡入口 · 扫一扫 · 首屏缓存 · 后端写入能力。
// ⚠️ 移动端友好：按钮 ≥44px 命中区；不横向滚动（样式见 `orders.css`）。

const P = ORDERS_PAGE;
const T = ORDERS_TEXTS;

/** 收款方式候选：后端给的就用后端的（**不自己造选项**），一条都没有才用配置兜底。 */
// ── ⭐⭐【首屏】先旧后新（stale-while-revalidate，只在前端展示层做）──────────────────────
// ⚠️ 为什么放在**这个文件里**（而不是新开一个模块）：本文件被 13~15 个 harness「拷到临时目录 + 显式改写 import」
//    ⇒ 一旦它多一个同目录相对 import，那批 harness 会一起挂（实测 41 红）。这里是纯函数、没有 DOM 依赖，先就地放着。

/** localStorage 的键（只放"上一次拉到的订单"，够画首屏就行）。 */
export const ORDERS_CACHE_KEY = 'workbench.orders.last';

/** 读缓存：没有 / 坏 JSON / 结构不对 / storage 抛错 ⇒ 一律当"没有"（**绝不抛**，别让缓存把页面搞崩）。 */
export const readCachedOrders = (storage) => {
  try {
    const raw = storage?.getItem?.(ORDERS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.orders) ? parsed : null;
  } catch {
    return null;
  }
};

/** 写缓存：配额满 / 隐私模式 ⇒ **静默失败**（写不进不该影响她看单子）。 */
export const writeCachedOrders = (storage, orders) => {
  try {
    storage?.setItem?.(ORDERS_CACHE_KEY, JSON.stringify({ at: Date.now(), orders }));
  } catch {
    // 写不进就算了 —— 下次首屏慢一点而已。
  }
};

/**
 * 首屏加载器：`firstPaint` 先给旧数据、再拉新；`forceReload` **只拉新、绝不读缓存**。
 * 🔴 写操作之后走 `forceReload`（见 `loadOrders({ freshOnly: true })`）—— 绝不能给她看旧的。
 */
export const createFirstPaintLoader = ({ load, storage, write = writeCachedOrders } = {}) => ({
  async firstPaint({ onCached, onFresh, onError } = {}) {
    const cached = readCachedOrders(storage);
    if (cached) onCached?.(cached.orders, { at: cached.at });
    try {
      const rows = await load();
      write(storage, rows);
      onFresh?.(rows);
      return rows;
    } catch (error) {
      onError?.(error, { hadCache: Boolean(cached) });
      return cached?.orders ?? null;
    }
  },
  async forceReload() {
    const rows = await load();
    write(storage, rows);
    return rows;
  },
});

/** 一张单的收款情况（她的第 3 项）。状态文案直接来自现有字段，不自己造词。 */
function reportOrdersRendered(section, count) {
  try {
    const reporter = typeof window !== 'undefined' ? window.dshUiTap : null;
    if (reporter && typeof reporter.diagnostic === 'function') {
      reporter.diagnostic('action', { action: 'orders_section_rendered', result: 'ok', realm: 'sales', durationMs: count }, { path: '/api/workbench/ui-tap', page: 'workbench' });
    }
  } catch { /* never block rendering */ }
}

export function ordersSectionCardsHtml(orders = []) {
  const listAll = Array.isArray(orders) ? orders : [];
  return `<div class="orders-section-cards" data-view="orders-section-cards">${SALES_SECTIONS.map((section) => {
    return `<button class="entry-card orders-section-card" type="button" data-orders-section="${escapeHtml(section.key)}" data-tap-target="orders-section:${escapeHtml(section.key)}">
      <span class="icon">${escapeHtml(section.icon || '')}</span>
      <h3>${escapeHtml(section.label)}</h3>
    </button>`;
  }).join('')}</div>`;
}

// ── ⭐ 2026-10-09：采购子 tab（按采购订单 = 一张采购申请/报货批次一行）──────────────
//
// 字段口径与既有「采购管理 · 报货信息情况」面板**一致**
//（`GET /api/workbench/purchase/requests` → `PurchaseQueryService.listPurchaseRequests`）：
// 报货批次号 / 货品编号 / 尺码 / 数量 / 到货状态。⚠️ 一列状态都不新造，全部来自既有字段。

/** 一个报货批次 = 一行（把这一批的申请明细都收在那张卡里）。 */
export function groupPurchaseOrders(rows = []) {
  const byBatch = new Map();
  for (const row of rows || []) {
    const key = String(row?.batch_no || '').trim();
    // ⭐⭐ 2026-10-15（task-27 · 她追加口径，逐字）：「（无批次号）……后续不会出现了，然后最新的逻辑，
    //   这些数据也不会出现，**因为首先得在采购主表有批次号才会展示**」
    //   ⇒ 明细**挂不上批次**（批次号空 / 旧的「（无批次号）」）⇒ **根本不进这一屏** ✓
    //   （**不是**"留着 + 写一句说明" ✗ 也别在这儿兜数据侧的孤儿明细 —— 那是 #606 的数据问题 ✓）
    if (!key || key === NO_BATCH_KEY) continue;
    if (!byBatch.has(key)) byBatch.set(key, { batch_no: key, rows: [] });
    byBatch.get(key).rows.push(row);
  }
  return [...byBatch.values()];
}

/** 这一批是否已入库：直接看供应主表的发生行为编码，不再翻译成「未到货/已到货」。 */
const isArrivedBatch = (batch) => (batch.rows || []).some(
  (row) => String(row.behavior_code || '').trim() === PURCHASE_IN_BEHAVIOR_CODE,
);

/** 旧分组用的占位键（历史数据里出现过）—— 现在**只用来识别并跳过**它 ✓（不再往页面上渲染）。 */
export const NO_BATCH_KEY = '（无批次号）';

// 2026-10-15 task-27: first screen = batch no + arrival status only; the purchase detail rows
//   are on the independent acceptance detail page now (features/acceptance-detail).
const batchSummaryOf = (batch) => {
  const rows = batch.rows || [];
  const quantity = rows.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  const products = new Set(rows.map((row) => String(row.product_record_id || row.product_number || ''))).size;
  return String(P.batchSummary || '')
    .split('{quantity}').join(String(quantity))
    .split('{products}').join(String(products));
};

const purchaseBatchCardHtml = (unit) => {
  const supplier = String(unit.supplier_record_id || '').trim();
  // 2026-11-19：点「验收」跳到独立明细页，不在列表卡里原地展开。
  const params = new URLSearchParams({
    batchNo: String(unit.batch_no || ''),
    supplierRecordId: supplier,
    supplierName: String(unit.supplier_name || ''),
  });
  const href = `/workbench/purchase-acceptance-detail.html?${params.toString()}`;
  return `
      <article class="order-card" data-purchase-batch="${escapeHtml(unit.batch_no)}" data-purchase-supplier="${escapeHtml(unit.supplier_key)}">
        <div class="order-card-head">
          <!-- ⭐ 2026-11-09（业务负责人批注）：此页出现的批次状态一致 ⇒ 不再显示状态标签 -->
          <span class="order-summary" data-view="arrival-batch-summary">${escapeHtml(batchSummaryOf(unit))}</span>
        </div>
        <a class="btn btn-primary action-form__summary" data-action="open-arrival" href="${escapeHtml(href)}">${escapeHtml(T.verifyArrival)}</a>
      </article>`;
};

/** 验收页两层：供应商卡片 → 按采购日由远及近的批次（不显示采购单号；已到货不渲染）。 */
const supplierKeyOfRow = (row = {}) => {
  const id = String(row.supplier_record_id || '').trim();
  const name = String(row.supplier_name || '').trim() || P.supplierFallback;
  return id || `name:${name}`;
};

// 验收单位 = 批次号 × 供应商（采购侧仍是一个提交一个批次号）。
export function groupAcceptanceUnits(rows = []) {
  const units = [];
  for (const batch of groupPurchaseOrders(rows).filter((item) => !isArrivedBatch(item))) {
    const bySupplier = new Map();
    for (const row of batch.rows || []) {
      const key = supplierKeyOfRow(row);
      if (!bySupplier.has(key)) {
        bySupplier.set(key, {
          key,
          name: String(row.supplier_name || '').trim() || P.supplierFallback,
          supplier_record_id: String(row.supplier_record_id || '').trim(),
          rows: [],
        });
      }
      bySupplier.get(key).rows.push(row);
    }
    for (const group of bySupplier.values()) {
      units.push({
        batch_no: batch.batch_no,
        supplier_key: group.key,
        supplier_name: group.name,
        supplier_record_id: group.supplier_record_id,
        rows: group.rows,
      });
    }
  }
  return units;
}

const groupUnitsBySupplier = (units = []) => {
  const bySupplier = new Map();
  for (const unit of units) {
    if (!bySupplier.has(unit.supplier_key)) {
      bySupplier.set(unit.supplier_key, { key: unit.supplier_key, name: unit.supplier_name, units: [] });
    }
    bySupplier.get(unit.supplier_key).units.push(unit);
  }
  return bySupplier;
};

const supplierCardHtml = (supplier, group = null) => {
  const batches = group ? (group.units || []).length : 0;
  const quantity = group ? (group.units || []).reduce((sum, unit) => sum
    + (unit.rows || []).reduce((n, row) => n + Number(row.quantity || 0), 0), 0) : 0;
  const summary = batches
    ? String(P.supplierCardSummary || '')
      .split('{batches}').join(String(batches))
      .split('{quantity}').join(String(quantity))
    : String(P.supplierCardEmpty || '');
  return `<button class="entry-card purchase-supplier-card" type="button" data-action="pick-supplier" data-supplier-key="${escapeHtml(supplier.key)}">
      <span class="entry-card-body"><strong>${escapeHtml(supplier.name)}</strong><span class="purchase-supplier-meta">${escapeHtml(summary)}</span></span>
    </button>`;
};

/** 采购日：来自采购主表「报货日」（自动字段 epoch ms）→ 上海时区 YYYY-MM-DD；取不到 ⇒ ''（显示"日期未知"）。 */
const formatPurchaseDate = (value) => {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(ms));
  } catch { return ''; }
};

export function purchaseOrdersHtml(rows = [], options = {}) {
  // ⭐ 2026-11-10：拆卡后第一层仍按供应商固定出现；第二层是该供应商的「采购日 → 批次卡」，
  //   每张批次卡只含**这个供应商**的明细子集（同一批次号可能出现在多家供应商卡下）。
  const pendingUnits = groupAcceptanceUnits(rows);
  const bySupplier = groupUnitsBySupplier(pendingUnits);
  // 验收页第一层只出现**当前有未到货批次**的供应商；没有批次的不占卡片。
  const supplierList = [...bySupplier.values()].map((group) => ({ key: group.key, name: group.name }));
  if (!pendingUnits.length && !supplierList.length) {
    return `<p class="empty" data-view="purchase-empty">${escapeHtml(P.arrivalEmpty)}</p>`;
  }
  const activeKey = String(options.supplierKey || '');
  // 第一层：供应商卡片（固定按配置表顺序）
  if (!activeKey) {
    return `<div class="purchase-orders" data-view="purchase-orders">${supplierList.map((supplier) => supplierCardHtml(supplier, bySupplier.get(supplier.key))).join('')}</div>`;
  }
  const activeSupplier = supplierList.find((item) => item.key === activeKey);
  const active = bySupplier.get(activeKey);
  // 供应商存在、但当前没有未到货批次 ⇒ 第二层空态（卡片仍固定出现）
  if (!active) {
    if (!activeSupplier) {
      return `<div class="purchase-orders" data-view="purchase-orders">${supplierList.map((supplier) => supplierCardHtml(supplier, bySupplier.get(supplier.key))).join('')}</div>`;
    }
    return `<div class="purchase-orders" data-view="purchase-orders">
      <section class="purchase-supplier" data-view="purchase-supplier" data-supplier-key="${escapeHtml(activeSupplier.key)}">
        <h3 class="purchase-supplier-head">${escapeHtml(activeSupplier.name)}</h3>
        <p class="empty" data-view="supplier-empty">${escapeHtml(P.supplierEmpty)}</p>
      </section>
    </div>`;
  }
  // 第二层：该供应商的采购日（**由远及近**：早 → 晚；日期未知的排最后）
  const byDate = new Map();
  for (const unit of active.units) {
    const first = (unit.rows || [])[0] || {};
    const date = formatPurchaseDate(first.arrival_created_at);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(unit);
  }
  const dates = [...byDate.keys()].sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  // 不显示「返回」按钮；日期标题只显示日期（仍按日期由远及近分组）。
  const dateHtml = dates.map((date) => `
        <section class="purchase-date-group" data-view="purchase-date" data-purchase-date="${escapeHtml(date)}">
          <h4 class="purchase-date-head">${escapeHtml(date || P.purchaseDateUnknown)}</h4>
          ${byDate.get(date).map((unit) => purchaseBatchCardHtml(unit)).join('')}
        </section>`).join('');
  return `<div class="purchase-orders" data-view="purchase-orders">
      <section class="purchase-supplier" data-view="purchase-supplier" data-supplier-key="${escapeHtml(active.key)}">
        <h3 class="purchase-supplier-head">${escapeHtml(activeSupplier?.name || active.name)}</h3>${dateHtml}
      </section>
    </div>`;
}

/**
 * ⭐⭐ 2026-10-11（方案甲之后的**补充入口**）：**逐件补「实收金额」**。
 *
 * 她的原话：「**待补充的时候，一定要把每件的实收都留下来**」——
 * 扫码建单时她可以一分钱都不填（那一列留空），补的地方就是这里。
 *
 * ⚠️ 只在**这一单有件没填实收**时才画（没得补的单调出来只是噪音）；
 * ⚠️ 字段名与扫码页**逐字一致**（「实收金额」）；输入框预填**现有的值**（有就显示，不用重打）；
 * ⚠️ **留空 = 这一件先不动**（服务端只写她真填了的那几件）——所以这里不写任何说明书句。
 */
export function createOrdersModule({ mode = 'both' } = {}) {
  const state = {
    // ⭐【首屏】先旧后新：只做一次 + 两个展示标记
    firstPaintDone: false,
    refreshing: false,
    refreshError: '',
    container: null,
    // ⚠️ 2026-10-29：老订单列表/详情已删（销售订单列表只剩三条路径：交割单 / 售后单 / 草稿箱）。
    //   这里保留 `orders` 只为**首屏缓存**（业务负责人要求保留"首屏缓存"）与草稿占位；不再渲染任何订单行。
    orders: [],
    activeSection: null,
    ordersLoaded: false,
    ordersLoading: false,
    purchaseRows: [],

    // ⭐ 2026-11-09：验收页第二层的"当前选中的供应商"（空 = 显示供应商卡片层）
    activeSupplierKey: '',
  };
  const $ = (selector) => state.container.querySelector(selector);
  const field = (name) => $(`[data-field="${name}"]`);
  const valueOf = (name) => (field(name)?.value ?? '').trim();
  function renderResult(text, isError = false) {
    const node = $('[data-view="action-result"]');
    if (node) {
      node.textContent = text || '';
      node.classList.toggle('error-text', Boolean(isError));
    }
    if (isError) showPageError(text || '');
    else showPageError('');
  }
  function renderShell() {
    // ⚠️ 2026-10-29：老列表/详情退场后，这一页**只画当前领域那一块**（销售 = 三卡入口；采购 = 验收）。
    //    单领域模式（销售 tab / 采购 tab）本来就没有内部子 tab，这次把那段也一起删了。
    const salesPanel = `<div class="sub-panel" data-view="sales-panel">
          <div data-view="orders-host"><p class="section-loading">正在读取…</p></div>
        </div>`;
    const purchasePanel = `<div class="sub-panel" data-view="purchase-panel">
          <div data-view="purchase-host"><p class="section-loading">正在读取采购申请…</p></div>
        </div>`;
    state.container.innerHTML = `
      ${mode === 'purchase' ? '' : salesPanel}
      ${mode === 'sales' ? '' : purchasePanel}
      <p class="operation-result" data-view="action-result" role="status"></p>`;
  }
  /** 售后单不是列表：点卡片直接扫货品码，再进入售后候选页。 */
  async function scanAfterSales() {
    try {
      const { scanCodeRaw } = await import('../scan/launch.js');
      const scanned = await scanCodeRaw('after_sales');
      const raw = String(scanned || '').trim();
      let recordId = '';
      try {
        const url = new URL(raw, window.location.origin);
        const match = url.pathname.match(/^\/r\/([^/]+)/);
        if (match) recordId = decodeURIComponent(match[1]);
      } catch { /* raw id below */ }
      if (!recordId && /^[A-Za-z0-9_-]+$/.test(raw)) recordId = raw;
      if (!recordId) return renderResult('没有扫到货品记录 ID，请重新扫码', true);
      window.location.href = `/workbench/after-sales.html?productRecordId=${encodeURIComponent(recordId)}`;
      return undefined;
    } catch (error) {
      if (/cancel/i.test(String(error?.errMsg || error?.message || ''))) return undefined;
      return renderResult('扫一扫没有成功，请再试一次。', true);
    }
  }
  function renderList() {
    const host = $('[data-view="orders-host"]');
    if (!host) return;
    const notices = `${state.refreshing ? '<p class="orders-refreshing">刷新中…</p>' : ''}${!state.refreshing && state.refreshError ? '<p class="orders-refreshing orders-refreshing--error">刷新失败，先看的是上次的结果</p>' : ''}`;
    if (!state.activeSection) {
      host.innerHTML = notices + ordersSectionCardsHtml(state.orders);
      reportOrdersRendered('cards', SALES_SECTIONS.length);
      return;
    }
    // 只有「草稿箱」会进这里（交割单在本页直接跳独立页；售后单直接起扫一扫）⇒ 显示显式占位。
    // ⭐ 2026-11-08（业务负责人：「草稿页需要和其他占位前端一致」）：
    //   占位页**统一成同一张虚线卡 + 「待建设」小标签**（与 货品→信息配置 同一套
    //   `.placeholder-card` / `.tag-info`，样式在 `features/domains/domains.css`，index.html 已加载 ✓）。
    //   ⚠️ 这里**不新增 import**（本文件被十余个 harness 拷贝 + 显式改写 import，多一条相对 import 会一起挂）。
    // ⭐ 2026-11-08 业务负责人 HTML 批注：「← 返回订单列表」不需要 ⇒ 删掉（占位页只剩统一占位卡）。
    host.innerHTML = `${notices}<div class="placeholder-card" data-view="section-placeholder" data-placeholder="draft">
        <span class="tag tag-info">待建设</span>
      </div>`;
  }
  function renderPurchaseList() {
    $('[data-view="purchase-host"]').innerHTML = purchaseOrdersHtml(state.purchaseRows, {
      supplierKey: state.activeSupplierKey,
    });
  }

 
  /**
   * ⭐⭐ 2026-10-12（她：「它**一直说正在读取订单**」）：等待时给一个**在动**的指示 ——
   * 「正在读取订单…（已 N 秒）」。纯前端计时，**不发任何请求**；读回来/失败都会停。
   * ⚠️ 不写"说明书"式文字，只是把那句已经在的提示补上秒数（后端慢的时候她知道系统还活着）。
   */
  function startWaitingTicker(host) {
    if (!host) return () => {};
    const started = Date.now();
    const render = () => {
      const seconds = Math.floor((Date.now() - started) / 1000);
      host.querySelector('[data-view="orders-waiting"]')?.replaceChildren(
        document.createTextNode(`正在读取订单…（已 ${seconds} 秒）`),
      );
    };
    host.innerHTML = '<p class="section-loading" data-view="orders-waiting">正在读取订单…（已 0 秒）</p>';
    const timer = setInterval(render, 1000);
    return () => clearInterval(timer);
  }
  /** localStorage 拿不到（隐私模式 / 老内核）⇒ 当没有缓存，功能照旧。 */
  const safeStorage = () => {
    try { return globalThis.localStorage; } catch { return undefined; }
  };
  /** 只负责"拉一次最新订单"（缓存读写都在首屏那一层做）。 */
  const fetchOrders = async () => {
    const data = await api.get(ORDERS_API.orders);
    return data.orders || [];
  };
  /**
   * ⭐⭐【首屏】先旧后新（业务负责人 2026-10-12）：
   *   ① 第一次打开 ⇒ **立刻**用"上次那批"画出来（0 秒可看）+ 一行「刷新中」；
   *   ② 后台拉最新 ⇒ 悄悄替换、标记消失；失败 ⇒ **仍显示旧数据 + 一行提示**（不白屏 ✗）。
   * 🔴 写操作之后走 `loadOrders({ freshOnly: true })` —— **绝不读旧缓存**（不能给她看旧的 ✗）。
   */
  const ordersLoader = createFirstPaintLoader({ storage: safeStorage(), load: fetchOrders });
  async function loadOrders({ freshOnly = false } = {}) {
    if (state.ordersLoading) return;
    state.ordersLoading = true;
    const host = $('[data-view="orders-host"]');
    const hasOrders = (state.orders || []).length > 0;
    const stopTicker = host && !hasOrders ? startWaitingTicker(host) : () => {};
    const apply = (rows) => {
      state.orders = rows;
      state.ordersLoaded = true;
      state.ordersLoading = false;
      renderList();
    };
    try {
      if (!freshOnly && !state.firstPaintDone) {
        state.firstPaintDone = true;
        const cached = readCachedOrders(safeStorage());
        if (cached && !hasOrders) {
          apply(cached.orders);
          state.refreshing = true;
          renderList();
        }
      }
      const rows = await ordersLoader.forceReload();
      state.refreshing = false;
      state.refreshError = '';
      apply(rows);
      writeCachedOrders(safeStorage(), state.orders);
    } catch (error) {
      state.refreshing = false;
      state.ordersLoading = false;
      state.refreshError = describeError(error);
      if ((state.orders || []).length) renderList();
      else if (host) host.innerHTML = '<p class="empty">订单读取失败</p>';
      showPageError(describeError(error));
    } finally {
      stopTicker();
    }
  }

  // ── ⭐ 2026-10-09：采购子 tab（读既有 /purchase/requests；验收走既有入库链路）────────
  async function loadPurchaseOrders() {
    const host = $('[data-view="purchase-host"]');
    if (host) host.innerHTML = '<p class="section-loading">正在读取采购申请…</p>';
    try {
      // 只读「报货」（采购退货单不在验收范围内）——按发生行为编码过滤。
      // 验收页供应商卡片由未到货批次自己聚合，不再读「供应商管理」全量列表。
      const data = await api.get(`${ORDERS_API.purchaseRequests}?${new URLSearchParams({ behaviorCode: PURCHASE_ORDER_BEHAVIOR_CODE })}`);
      state.purchaseRows = data.rows || [];
      renderPurchaseList();
    } catch (error) {
      if (host) host.innerHTML = '<p class="empty">采购申请读取失败</p>';
      showPageError(describeError(error));
    }
  }
  /**
   * 「验收到货」：把这张卡上的批次 + 实际金额 + 到货说明交给后端既有入库链路。
   * ⚠️ 金额必填（既有口径）；校验放在提交前，后端还会再判一次（两道）。
   */
  /** 明细（只读）：展开时拉一次 `GET /purchase/arrivals/detail` ✓ 失败给人话 ✗ */
  function bind() {
    state.container.addEventListener('click', (event) => {
      const sectionCard = event.target.closest('[data-orders-section]');
      if (sectionCard) {
        if (sectionCard.dataset.ordersSection === 'afterSales') {
          void scanAfterSales();
          return;
        }
        // ⭐ 2026-10-28：「交割单」卡片 → 独立预览页（v1 只读；供应验收 mode=purchase 不渲染这三张卡，行为不变）。
        if (mode !== 'purchase' && sectionCard.dataset.ordersSection === 'pending') {
          window.location.href = SALES_DELIVERY_PAGE;
          return;
        }
        state.activeSection = sectionCard.dataset.ordersSection;
        renderList();
        // ⭐ 2026-11-11：点「草稿单」不拉订单列表（占位页不需要数据；以前会闪「刷新中…」，
        //   飞书读表抖动时还会直接显示 400 报错）。交割单/售后单在更上面就分流 ⇒ 本页零调用。
        if (state.activeSection !== 'draft' && !state.ordersLoaded && !state.ordersLoading) loadOrders();
        return;
      }
      const pickSupplier = event.target.closest('[data-action="pick-supplier"]');
      if (pickSupplier) {
        state.activeSupplierKey = pickSupplier.dataset.supplierKey || '';
        return renderPurchaseList();
      }
      const trigger = event.target.closest('[data-action]');
      if (!trigger) return;
      const action = trigger.dataset.action;
      if (action === 'refresh') return loadPurchaseOrders();
      if (action === 'back') return renderList();
      return undefined;
    });
  }

  return {
    /** 回到三张入口卡（切走再切回订单列表时调用；采购模式无入口卡，不处理）。 */
    resetToCards() {
      if (mode === 'purchase') return;
      state.activeSection = null;
      if (state.container) renderList();
    },
    mount(container) {
      state.container = container;
      renderShell();
      bind();
      // 单领域模式只读自己那一边（采购 tab 不发销售订单请求，销售 tab 不发采购申请请求）。
      if (mode === 'purchase') loadPurchaseOrders();
      // ⭐ 2026-10-29：入口**不拉订单**（三卡是静态入口；e2e AC-ENTRY 钉住"入口 0 个 /sales/orders 请求"）。
      //    首屏缓存那三个纯函数仍 export（能力保留），将来若列表回来直接接。
      else renderList();
    },
  };
}
