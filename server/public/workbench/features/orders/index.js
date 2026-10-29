import { api } from '../../core/api-client.js';
import { escapeHtml, money, statusClass } from '../../core/formatters.js';
import { describeError, runWriteAction, showPageError } from '../../core/ui.js';
import {
  ORDERS_API, ORDERS_PAGE, ORDERS_TEXTS,
  SALES_SECTIONS, SALES_DELIVERY_PAGE,
  ARRIVAL_CONFIRM, ARRIVAL_STATUS_PENDING, ARRIVAL_STATUS_ARRIVED,
} from '../../config/orders.js';
import { ARRIVAL_FULL_API, ARRIVAL_FULL_FIELDS, ARRIVAL_FULL_TEXTS } from '../../config/orders.js';

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

const amount = (value) => money(Number(value || 0));
const sizeText = (size) => (size == null || size === '' ? '尺码待补' : `${escapeHtml(size)} 码`);

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
      <span class="entry-card-icon">${escapeHtml(section.icon || '')}</span>
      <span class="entry-card-body"><strong>${escapeHtml(section.label)}</strong></span>
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

/** 这一批的到货状态（既有字段；同批次里任一明细说没到货就算没到货）。 */
const arrivalStatusOf = (batch) => {
  const statuses = (batch.rows || []).map((row) => String(row.arrival_status || '').trim()).filter(Boolean);
  if (statuses.includes(ARRIVAL_STATUS_PENDING)) return ARRIVAL_STATUS_PENDING;
  return statuses[0] || '';
};

/**
 * ⭐ 2026-10-10：这一批是不是**已经到过货**（只有取值严格等于「已到货」才算）。
 *   其余（含状态为空 / 未来她新加的取值）一律当"还没到货" ⇒ 排前面等验收 ——
 *   **宁可多给她一张待验收的卡，也不把一个还没验收的批次收进折叠里**。
 */
const isArrivedBatch = (batch) => arrivalStatusOf(batch) === ARRIVAL_STATUS_ARRIVED;

/** 旧分组用的占位键（历史数据里出现过）—— 现在**只用来识别并跳过**它 ✓（不再往页面上渲染）。 */
export const NO_BATCH_KEY = '（无批次号）';

// 2026-10-15 task-27: first screen = batch no + arrival status only; the purchase detail rows
//   are loaded after she opens the disclosure (see arrivalDetailHtml / loadArrivalDetail below).
//   (Kept in ASCII on purpose: test/workbenchAcceptanceInPlace.test.js AC-AW5 scans this window.)
const purchaseBatchCardHtml = (batch) => `
      <article class="order-card" data-purchase-batch="${escapeHtml(batch.batch_no)}">
        <div class="order-card-head">
          <h3 class="order-no">${escapeHtml(batch.batch_no)}</h3>
          <div class="order-tags">
            <span class="tag ${statusClass(arrivalStatusOf(batch))}">${escapeHtml(arrivalStatusOf(batch) || ARRIVAL_STATUS_PENDING)}</span>
          </div>
        </div>
        <div class="order-card-actions">
          <!-- ⭐ 2026-10-14（业务负责人逐字：「**连它一起改造进工作台（变成工作台自己的页面）**」）：
               这里原来还有一颗【扫码验收】= 一颗指向 /s/accept?batch=… 的链接（**跳到扫码页** ✗）
               ⇒ **已退出工作台**：本屏的确认路径就是下面那张**工作台内**的【验收到货】表单 ✓
               ⚠️ 「逐双扫码录入」那半**物理上仍在扫码页**（标签二维码印的就是 /s/{编号} ✓ 不换标签绕不开 ✗）
                  ⇒ /s/accept 那条路**保留、仍能用**，只是**工作台不再从它进** ✓（不许删 ✗）
                  ⇒ 依据：docs/acceptance-into-workbench-2026-10-14.md §二/§三 -->
          <button class="btn btn-primary" type="button" data-action="verify-arrival" data-batch="${escapeHtml(batch.batch_no)}">${escapeHtml(T.verifyArrival)}</button>
        </div>
        <details class="action-form" data-action-block="verify-arrival" data-arrival-batch="${escapeHtml(batch.batch_no)}">
          <summary>${escapeHtml(T.arrivalVerifyTitle)}</summary>
          <p class="order-note" data-view="arrival-detail-hint">${escapeHtml(ARRIVAL_FULL_TEXTS.detailOpenHint)}</p>
          <div class="action-body">
            <div data-view="arrival-detail" data-batch="${escapeHtml(batch.batch_no)}"></div>
            <div class="form-field" data-view="arrival-custom-size">
              <span>${escapeHtml(ARRIVAL_FULL_TEXTS.customSizeLabel)}</span>
              <input data-field="custom-size" type="text" inputmode="numeric" placeholder="${escapeHtml(ARRIVAL_FULL_TEXTS.customSizePlaceholder)}">
              <input data-field="custom-quantity" type="text" inputmode="numeric" placeholder="${escapeHtml(ARRIVAL_FULL_TEXTS.customQuantityPlaceholder)}">
            </div>
            <div class="form-field" data-view="arrival-custom-item">
              <span>${escapeHtml(ARRIVAL_FULL_TEXTS.customItemNoLabel)}</span>
              <input data-field="custom-item-no" type="text" placeholder="${escapeHtml(ARRIVAL_FULL_TEXTS.customItemNoPlaceholder)}">
              <input data-field="custom-item-size" type="text" inputmode="numeric" placeholder="${escapeHtml(ARRIVAL_FULL_TEXTS.customSizePlaceholder)}">
              <input data-field="custom-item-quantity" type="text" inputmode="numeric" placeholder="${escapeHtml(ARRIVAL_FULL_TEXTS.customQuantityPlaceholder)}">
            </div>
            <label class="form-field">${escapeHtml(T.arrivalAmount)}
              <input data-field="arrival-amount" type="text" inputmode="decimal" placeholder="${escapeHtml(ARRIVAL_CONFIRM.amountPlaceholder)}">
            </label>
            <button class="btn btn-primary" type="button" data-action="submit-arrival" data-batch="${escapeHtml(batch.batch_no)}">${escapeHtml(T.arrivalSubmit)}</button>
          </div>
        </details>
      </article>`;

/**
 * 采购子 tab 的列表：一张报货批次一张卡，每张卡上都有「验收到货」。
 *
 * ⭐ 2026-10-10（业务负责人真机反馈：「验收到货」要能一眼看到她该干的事）：
 *   · **未到货的批次排在前面**（还没验收的 = 她要动的）；
 *   · **已到货的折叠**在下面（`<details data-view="purchase-arrived">`，默认收起）——
 *     不占屏幕，但一个批次都没丢，点开还是那张卡 + 那颗【验收到货】（重复验收由后端幂等兜底）。
 */
export function purchaseOrdersHtml(rows = []) {
  const batches = groupPurchaseOrders(rows);
  if (!batches.length) return `<p class="empty" data-view="purchase-empty">${escapeHtml(P.purchaseEmpty)}</p>`;
  const pending = batches.filter((batch) => !isArrivedBatch(batch));
  const arrived = batches.filter(isArrivedBatch);
  const pendingHtml = pending.map(purchaseBatchCardHtml).join('');
  const arrivedHtml = arrived.length ? `
      <details class="purchase-arrived" data-view="purchase-arrived">
        <summary class="purchase-arrived__summary">${escapeHtml(P.purchaseArrivedSummary)}（${escapeHtml(arrived.length)}）</summary>
        ${arrived.map(purchaseBatchCardHtml).join('')}
      </details>` : '';
  return `<div class="purchase-orders" data-view="purchase-orders">${pendingHtml}${arrivedHtml}
    </div>`;
}

/**
 * ⭐⭐ 2026-10-15（task-27 · 她逐字）：「点进去之后才是对应的采购明细情况，然后**可以自行补充**这个货号下的
 *   其余尺码和数量」＋「**实际到多少就是到多少**」
 *
 * `arrivalDetailHtml(rows)` = 那一批的**明细 + 每行一个「实际到货数量」输入**
 *   · 默认值 = 该行的**申请数量**（她要"改"，不是"从空开始填" ✓）；
 *   · 行的身份挂在 `data-*` 上（`product_record_id` / `size` / `declared`）⇒ 提交时**不用猜** ✓。
 */
export const arrivalLineKey = (row = {}) => `${String(row.product_record_id || '').trim()}|${String(row.size ?? '').trim()}`;

export function arrivalDetailHtml(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return `<p data-view="arrival-detail-empty">${escapeHtml(ARRIVAL_FULL_TEXTS.detailEmpty)}</p>`;
  return `<ul class="order-lines" data-view="arrival-detail-list">${list.map((row) => `
          <li class="order-line" data-view="arrival-detail-row"
              data-product-record-id="${escapeHtml(String(row.product_record_id || ''))}"
              data-size="${escapeHtml(String(row.size ?? ''))}"
              data-declared="${escapeHtml(String(Number(row.quantity || 0)))}">
            <span class="line-product">${escapeHtml(row.item_no || '')}</span>
            <span class="line-size">${escapeHtml(sizeText(row.size))}</span>
            <span class="line-amount">${escapeHtml(ARRIVAL_FULL_TEXTS.declaredQuantityLabel)} ${escapeHtml(String(Number(row.quantity || 0)))}</span>
            <input class="line-actual" data-field="arrival-actual" type="text" inputmode="numeric"
              data-product-record-id="${escapeHtml(String(row.product_record_id || ''))}"
              data-size="${escapeHtml(String(row.size ?? ''))}"
              value="${escapeHtml(String(Number(row.quantity || 0)))}"
              placeholder="${escapeHtml(ARRIVAL_FULL_TEXTS.zeroMeansNotArrived)}"
              aria-label="${escapeHtml(ARRIVAL_FULL_TEXTS.actualQuantityLabel)}">
          </li>`).join('')}</ul>`;
}

/**
 * 🔴 **她填的实际到货数量** ⇒ 提交用的 `lines`（**唯一来源** ✓ 绝不按申请数补齐 ✗）：
 *   · 某个尺码**填 0** ⇒ **不提交那一行**（没到就是没到 ✓）；
 *   · **没填**（清空）⇒ **不猜**（`ok:false` + 人话，页面上拦住 ✓）—— 「没填」与「填 0」是两件事 ✗；
 *   · 没碰过的行 ⇒ 用页面**预填值**（= 申请数量 ✓ 这与"按申请数补齐"不是一回事：
 *     预填是**页面给她看的默认**，她改了就按她的值，提交的永远是**她确认过的那个值** ✓）。
 *   · `extra` = 她自行补充的行（自定义尺码 / 自定义货号）—— 由调用方解析好 `productRecordId` ✓。
 */
export function arrivalSubmitLines({ rows = [], actuals = {}, extra = [] } = {}) {
  const lines = [];
  for (const row of rows || []) {
    const key = arrivalLineKey(row);
    const has = Object.prototype.hasOwnProperty.call(actuals || {}, key);
    const raw = String((has ? actuals[key] : row.quantity) ?? '').trim();
    if (raw === '') return { ok: false, reason: 'actual_missing', lines: [] };
    if (!/^\d+$/.test(raw)) return { ok: false, reason: 'actual_invalid', lines: [] };
    const quantity = Number(raw);
    if (quantity === 0) continue;
    lines.push({ productRecordId: String(row.product_record_id || ''), size: Number(row.size), quantity });
  }
  for (const line of extra || []) {
    const size = Number(line?.size);
    const quantity = Number(line?.quantity);
    if (!line?.productRecordId) return { ok: false, reason: 'extra_unresolved', lines: [] };
    if (!Number.isSafeInteger(size) || size <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
      return { ok: false, reason: 'extra_invalid', lines: [] };
    }
    lines.push({ productRecordId: String(line.productRecordId), size, quantity });
  }
  return { ok: true, reason: '', lines };
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
    arrivalRowsByBatch: {},
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
    host.innerHTML = `${notices}<button class="btn btn-ghost" type="button" data-orders-section-back="1">← 返回订单列表</button>
      <p class="empty compact" data-view="section-placeholder">待建设</p>`;
  }

  function renderPurchaseList() {
    $('[data-view="purchase-host"]').innerHTML = purchaseOrdersHtml(state.purchaseRows);
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
      // ⚠️ 只读「采购申请」（采购退货单不在验收范围内）——用**既有** reportBehavior 过滤。
      const data = await api.get(`${ORDERS_API.purchaseRequests}?${new URLSearchParams({ reportBehavior: 'purchase_request' })}`);
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
  async function loadArrivalDetail(host) {
    const box = host.querySelector('[data-view="arrival-detail"]');
    const batchNo = box?.dataset?.batch || '';
    if (!box || !batchNo || box.dataset.loaded === '1') return;
    box.dataset.loaded = '1';
    try {
      const res = await api.get(`${ARRIVAL_FULL_API.detail}?${ARRIVAL_FULL_FIELDS.batchNo}=${encodeURIComponent(batchNo)}`);
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      // ⚠️ **按批次存**：她可能开了 A 批又开 B 批 —— 提交时只能读**这一批**的明细 ✓（不许串 ✗）
      state.arrivalRowsByBatch = { ...(state.arrivalRowsByBatch || {}), [batchNo]: rows };
      box.innerHTML = arrivalDetailHtml(rows);
    } catch (error) {
      box.innerHTML = `<p>${escapeHtml(ARRIVAL_FULL_TEXTS.detailFailed)}</p>`;
    }
  }

  /** 自定义货号 ⇒ `record_id`（走**既有**货品读取口 ✓ 不打新接口 ✗） */
  async function resolveItemNo(itemNo) {
    const wanted = String(itemNo || '').trim().toLowerCase();
    if (!wanted) return '';
    try {
      const res = await api.get(`${ARRIVAL_FULL_API.products}?keyword=${encodeURIComponent(itemNo)}`);
      const rows = Array.isArray(res?.rows) ? res.rows : [];
      const exact = rows.find((row) => String(row.item_no || '').trim().toLowerCase() === wanted)
        || rows.find((row) => String(row.product_number || '').trim().toLowerCase() === wanted);
      return (exact || rows[0])?.record_id || '';
    } catch (error) {
      return '';
    }
  }

  /** 这一批的第一条明细（自定义尺码要挂在某个款上 ⇒ 用**这一批**刚读到的明细 ✓ 不猜 ✗） */
  const firstArrivalRow = (batchNo) => ((state.arrivalRowsByBatch || {})[batchNo] || [])[0] || null;

  async function submitArrival(button) {
    const batchNo = button.dataset.batch || '';
    const form = state.container.querySelector(`[data-arrival-batch="${batchNo}"]`);
    const read = (name) => String(form?.querySelector(`[data-field="${name}"]`)?.value ?? '').trim();
    const rawAmount = read('arrival-amount');
    // ⭐ 2026-10-16（她逐字：「数据表里已经没有到货文字说明（该列已从真表退场）了…你必须得删」）：工作台这条**不再有**
    //    「到货说明」这个输入框 ⇒ 这里也不再有读值与必填（那条判据**随她这句一起退场** ✓）
    if (!batchNo) return renderResult('这一行没有报货批次号，不能验收到货', true);
    if (!/^\d+(\.\d+)?$/.test(rawAmount) || Number(rawAmount) <= 0) {
      return renderResult('请先填这次的「实际金额」（大于 0 的数字），再点验收到货', true);
    }
    // ⭐ 同上：点一下立刻有反馈 + 防连点（校验放在守卫**之前** —— 没填完不该置灰）
    return runWriteAction(button, async () => {
      renderResult('');
      try {
        // ⭐⭐ 2026-10-15（task-27 · 她逐字：「**实际到多少就是到多少**」）：
        //   🔴 改前：没有自定义行 ⇒ 走 `ORDERS_API.arrivalConfirm`（= **全部按申请数到货**）✗
        //      —— 与她的口径**正面冲突**（少到的会被按申请数补齐 ✗）。
        //   改后：**一律走 `accept`**，`lines` = **她在明细里填的实际到货数量**（填 0 的那一行**不提交** ✓）
        //      ＋ 她自行补充的行（自定义尺码 / 自定义货号）✓ —— **没有任何"按申请数补齐"的路径** ✗。
        const actuals = {};
        for (const input of form.querySelectorAll('[data-field="arrival-actual"]')) {
          actuals[arrivalLineKey({
            product_record_id: input.dataset.productRecordId, size: input.dataset.size,
          })] = input.value;
        }
        const extraLines = [];
        const customSize = read('custom-size');
        const customQuantity = read('custom-quantity');
        if (customSize || customQuantity) {
          const row = firstArrivalRow(batchNo) || {};
          if (!row.product_record_id) return renderResult(ARRIVAL_FULL_TEXTS.detailFailed, true);
          extraLines.push({
            productRecordId: row.product_record_id, size: customSize,
            quantity: customQuantity === '' ? row.quantity : customQuantity,
          });
        }
        const itemNo = read('custom-item-no');
        if (itemNo) {
          const found = await resolveItemNo(itemNo);
          if (!found) return renderResult(ARRIVAL_FULL_TEXTS.itemNoNotFound, true);
          extraLines.push({
            productRecordId: found,
            size: read('custom-item-size'),
            quantity: read('custom-item-quantity') || 1,
          });
        }
        const built = arrivalSubmitLines({
          rows: (state.arrivalRowsByBatch || {})[batchNo] || [],
          actuals,
          extra: extraLines,
        });
        // ⚠️ 「**没填**」与「填 0」是两件事：填 0 = 这一码没到（不提交 ✓）；没填 = **不猜** ⇒ 拦住 + 人话 ✗
        if (!built.ok) {
          const text = built.reason === 'actual_missing' ? ARRIVAL_FULL_TEXTS.actualQuantityRequired
            : built.reason === 'extra_unresolved' ? ARRIVAL_FULL_TEXTS.itemNoNotFound
              : ARRIVAL_FULL_TEXTS.sizeInvalid;
          return renderResult(text, true);
        }
        if (!built.lines.length) return renderResult(ARRIVAL_FULL_TEXTS.noArrivalLines, true);
        const result = await api.post(ARRIVAL_FULL_API.accept, {
          [ARRIVAL_FULL_FIELDS.batchNo]: batchNo,
          [ARRIVAL_FULL_FIELDS.actualAmount]: Number(rawAmount),
          [ARRIVAL_FULL_FIELDS.lines]: built.lines,
        });
        // 列表数据是唯一事实来源：重新读一次（到货状态会跟着更新）
        await loadPurchaseOrders();
        renderResult((result.notice ? result.notice : '') || result.alreadyPosted
          ? `这批（${batchNo}）已经验收入库过了，没有重复入库。`
          : (result.message || `这批（${batchNo}）已验收入库。`));
        return true;
      } catch (error) {
        renderResult(describeError(error), true);
        return false;
      }
    }, '正在验收入库…');
  }

 





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
        if (!state.ordersLoaded && !state.ordersLoading) loadOrders();
        return;
      }
      if (event.target.closest('[data-orders-section-back]')) {
        state.activeSection = null;
        renderList();
        return;
      }
      const trigger = event.target.closest('[data-action]');
      if (!trigger) return;
      const action = trigger.dataset.action;
      if (action === 'refresh') return loadPurchaseOrders();
      if (action === 'back') return renderList();
      // 「验收到货」：点一下把那张卡的验收表单展开（真正的写入在 submit-arrival）
      if (action === 'verify-arrival') {
        const form = state.container.querySelector(`[data-arrival-batch="${trigger.dataset.batch || ''}"]`);
        if (form) form.open = true;
        return undefined;
      }
      if (action === 'submit-arrival') return submitArrival(trigger);
      return undefined;
    });
    state.container.addEventListener('toggle', (event) => {
      const node = event.target;
      if (node?.matches?.('details[data-action-block="verify-arrival"]') && node.open) loadArrivalDetail(node);
    }, true);
  }

  return {
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
