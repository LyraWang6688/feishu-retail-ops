import { api } from '../../core/api-client.js';
import { escapeHtml, money, statusClass } from '../../core/formatters.js';
import { describeError, runWriteAction, setBusy, showPageError, SUBMIT_PENDING_TEXT } from '../../core/ui.js';

/** 文案模板填充（`{name}` 占位符）—— 文案在 `config/orders.js` 里，代码只填值。 */
const fillText = (template, values = {}) => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined || values[key] === null ? match : String(values[key])));
import {
  ORDERS_API, ORDERS_PAGE, ORDERS_TEXTS, DEFAULT_COLLECTION_METHOD, COLLECTION_METHODS,
  REFUND_METHOD_PLACEHOLDER, RESTOCK_STATES, AFTER_SALES_ACTIONS, SETTLEMENTS,
  ORDERS_SUB_TABS, SALES_GROUPS, SALES_SECTIONS, DELIVERED_FULFILLMENT, PAID_PAYMENT_STATUS,
  ARRIVAL_CONFIRM, ARRIVAL_STATUS_PENDING, ARRIVAL_STATUS_ARRIVED,
} from '../../config/orders.js';
import { ARRIVAL_FULL_API, ARRIVAL_FULL_FIELDS, ARRIVAL_FULL_TEXTS } from '../../config/orders.js';

// 工作台【订单列表】（业务负责人 2026-10-09）—— 一级 tab 的第三个。
//
// ⭐ 这一页只干两件事：**看销售情况** + **在手机上操作这张单**。
//    看：**销售单号 · 销售明细 · 收款情况**（一行一张单，一张卡）。
//    操作：补收款 / 交付 / 售后（退 · 换 · 赔）/ 二次交付 —— **全部走既有业务处理层**，
//    这一层只负责收表单、调接口、把结果或**原因**显示出来。
//
// ⚠️ **移动端友好**是硬要求（她的原话：「工作台要对移动端友好」）：
//    · 一列卡片、没有表格 ⇒ 不横向滚动（样式见 `orders.css`）；
//    · 按钮 / 输入框 ≥44px 命中区（窄屏整行可点）；
//    · 每个动作收在 `<details>` 里，点开才展开，不把一屏全占了。
//
// ⚠️ 这里的 render 函数是**纯函数**（配置可注入）—— 测试可以直接喂一份
//    `listOrders()` 形状的数据，断言"三项字段都画出来了"。

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

export const collectionMethodsOf = (methods) => (Array.isArray(methods) && methods.length
  ? methods.map((item) => String(item)).filter(Boolean)
  : [...COLLECTION_METHODS]);

/** 收款方式下拉：`selected` 缺省 = 配置里的默认值（**只在这一页**给默认）。 */
export function methodOptionsHtml(methods, selected = DEFAULT_COLLECTION_METHOD,
  { placeholder = '' } = {}) {
  const list = collectionMethodsOf(methods);
  const chosen = list.includes(selected) ? selected : list[0];
  const head = placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '';
  return head + list.map((method) => `<option value="${escapeHtml(method)}"${method === chosen ? ' selected' : ''}>${escapeHtml(method)}</option>`).join('');
}

const amount = (value) => money(Number(value || 0));
const sizeText = (size) => (size == null || size === '' ? '尺码待补' : `${escapeHtml(size)} 码`);

/** 一张单的收款情况（她的第 3 项）。状态文案直接来自现有字段，不自己造词。 */
const paymentBlock = (order) => {
  const payments = order.payments || [];
  const methods = payments.map((payment) => `${escapeHtml(payment.method || '')} ${amount(payment.amount)}`).join(' / ');
  return `
        <div class="order-money">
          <div class="metric"><span>${escapeHtml(T.paid)}</span><strong>${amount(order.paid_amount)}</strong></div>
          <div class="metric"><span>${escapeHtml(T.pending)}</span><strong>${amount(order.pending_amount)}</strong></div>
        </div>
        <p class="order-payment-line">
          <span class="tag ${statusClass(order.payment_status)}">${escapeHtml(order.payment_status || '')}</span>
          <span class="muted">${escapeHtml(T.receivable)} ${amount(order.receivable_amount)}</span>
          <span class="muted">${payments.length ? `已记 ${payments.length} 笔：${methods}` : '还没有收款记录'}</span>
        </p>`;
};

/** 一条销售明细（她的第 2 项）：哪些货 / 颜色 / 尺码 / 金额 / 履约状态。
 * ⭐ 2026-10-11（B/C）：**配品行**显示「其他配品」的**名称**，而且**不硬塞一个尺码**
 *   （它的 编号 / 颜色 / 尺码 本来就是留空的 —— 显示成"未填货号 / 尺码待补"会误导她）。
 *   ⚠️ 判据用服务端给的 `requires_size`（可售品属性），页面里**不写死 kind 名字**。
 * ⭐ 颜色也画出来（货品信息 = 货号 / 颜色 / 尺码；服务端已给，零额外请求）。
 */
const lineHtml = (line) => {
  const isAccessory = line?.requires_size === false;
  const color = String(line?.color ?? '').trim();
  const label = isAccessory ? (line.accessory || '配品') : (line.product || '未填货号');
  const sizeCell = isAccessory
    ? '<span class="line-size tag tag-info">配品</span>'
    : `<span class="line-size">${sizeText(line.size)}</span>`;
  return `
          <li class="order-line">
            <span class="line-product">${escapeHtml(label)}</span>
            ${!isAccessory && color ? `<span class="line-color">${escapeHtml(color)}</span>` : ''}
            ${sizeCell}
            <span class="line-amount">${line.actual_amount == null ? '—' : amount(line.actual_amount)}</span>
            <span class="tag ${statusClass(line.fulfillment_status)}">${escapeHtml(line.fulfillment_status || '')}</span>
          </li>`;
};

/**
 * ⭐⭐ 2026-10-12（她：「一屏下来只能展示一个半订单……争取在一屏里呈现更多信息」）：
 * 一张卡的**第二行 = 折叠行**：金额 / 待交付都压在这一行里（她一眼看完），
 * 收款明细与销售明细**点开才展开**（信息一个都不删，只是不默认占屏）。
 * ⚠️ 这一行本身就是 ≥44px 的命中区（`summary` 在 `base.css` / `orders.css` 里都是 `--control-height`）。
 */
const detailsBlock = (order) => {
  const lines = order.details || [];
  return `
        <details class="order-details-toggle">
          <summary>
            <span class="order-summary-line">${escapeHtml(T.receivable)} ${amount(order.receivable_amount)} · ${escapeHtml(T.paid)} ${amount(order.paid_amount)} · ${escapeHtml(T.pending)} ${amount(order.pending_amount)} · 待交付 ${Number(order.pending_delivery_quantity || 0)}</span>
            <span class="order-more">${escapeHtml(T.details)} ${lines.length} 项 ›</span>
          </summary>
          ${paymentBlock(order)}
          <ul class="order-lines">${lines.map(lineHtml).join('') || '<li class="order-line muted">这张单没有明细</li>'}</ul>
        </details>`;
};

/**
 * 订单**列表**：一行一张销售单 = 一张卡（销售单号 · 销售明细 · 收款情况）。
 * 纯函数：喂 `listOrders()` 的 `orders` 就能渲染（测试直接用）。
 */
export function ordersListHtml(orders = []) {
  if (!orders.length) return `<p class="empty" data-view="orders-empty">${escapeHtml(P.empty)}</p>`;
  return `<div class="orders-list" data-view="orders">${orders.map((order) => {
    // ⭐⭐ 2026-10-15（⑨b-1 UI · 她逐字）：「失败落「**写入失败**」、工作台显示「**未完成，可点重试**」」
    //   ⇒ **只有没写完的单**才出那一句 + 那颗按钮（写完了的不该出现"可点重试" ✗）。
    //   ⚠️ 判据来自**服务端**已经算好的 `write_incomplete`（`salesFollowupService` 用已合并的
    //      `isOrderIncomplete` 算的 ✓）—— 页面**不自己判** ✗、也不另发明一套 ✗。
    //   ⚠️ 文案一律从 `T`（= `ORDERS_TEXTS`）取：这一套「重试」文案**按读取口**归在那一处
    //      （同一个对象里读，就不会再出现"配在 P、代码读 T ⇒ 读成 undefined"那个真 bug ✗）。
    const incomplete = order.write_incomplete === true;
    return `
      <article class="order-card" data-order="${escapeHtml(order.record_id)}">
        <div class="order-card-head">
          <h3 class="order-no">${escapeHtml(order.order_no || order.record_id)}</h3>
          <div class="order-tags">
            <span class="tag ${statusClass(order.fulfillment_status)}">${escapeHtml(order.fulfillment_status || '')}</span>
            ${incomplete ? `<span class="tag tag-warning" data-view="order-incomplete">${escapeHtml(T.incomplete)}</span>` : ''}
          </div>
          <button class="btn btn-ghost order-open" type="button" data-action="open-order" data-order="${escapeHtml(order.record_id)}">${escapeHtml(P.open)} ›</button>
          ${incomplete ? `<button class="btn btn-primary order-retry" type="button" data-action="retry-write" data-order-no="${escapeHtml(order.order_no || '')}">${escapeHtml(T.retry)}</button>` : ''}
        </div>
        ${detailsBlock(order)}
      </article>`;
  }).join('')}
    </div>`;
}

// ── ⭐ 2026-10-09：订单列表内部的**两个子 tab**（销售 / 采购）────────────────────────
//
// 她 15:07 逐字：「第三个 tab 是订单列表，分两个子 tab：1. 销售… 2. 采购…」
//
// ⚠️ **选中态与切换自己实现**（就在本模块里），**不动**一级 tab 的结构与前两个 tab：
//    · 一级 tab 的唯一来源仍是 `config/tabs.js` 的 `MAIN_TABS`（本文件不认识 main-tab）；
//    · 子 tab 用 `data-subtab` + 容器上的事件委托（innerHTML 重画之后不用重新绑定）。

/** 子 tab 按钮（选中态）. 纯函数：喂一个 value 就能渲染（测试直接用）。 */
export function subTabsHtml(active = ORDERS_SUB_TABS[0].value) {
  return ORDERS_SUB_TABS.map((tab) => `
        <button class="sub-tab${tab.value === active ? ' active' : ''}" type="button"
          data-subtab="${escapeHtml(tab.value)}" aria-selected="${tab.value === active}">${escapeHtml(tab.label)}</button>`).join('');
}

/** 子 tab 的**纯状态机**：点一个按钮该切到哪一页（认不出的按钮 → 原样不动，不瞎切）。 */
export function resolveSubTab(current, next) {
  return ORDERS_SUB_TABS.some((tab) => tab.value === next) ? next : current;
}

/**
 * 销售子 tab：按**是否钱货两清**归类 —— 判据**只用既有字段与取值**：
 *   · 货结清 ⟺ 履约状态 = 「已交付」（`fulfillment_status`，服务端 `progressFromRecords` 算的）；
 *   · 钱结清 ⟺ 收款状态 = 「已收款」（`payment_status`）。
 * 「没有钱货两清的就是有二次的」→ 再按哪一边没结清分三类（她给的三个例子）。
 * ⚠️ 值取不到（履约 / 收款状态为空）时**不许硬说成两清**：归到"没结清"那一侧。
 */
export function salesCategoryOf(order) {
  const delivered = order?.fulfillment_status === DELIVERED_FULFILLMENT;
  const paid = order?.payment_status === PAID_PAYMENT_STATUS;
  if (delivered && paid) return 'settled';
  if (!delivered && paid) return 'undelivered';
  if (delivered && !paid) return 'unpaid';
  return 'both';
}

/** 四类分组（空的那类也留着 —— 页面要显式告诉她这一类现在没有单）。 */
export function groupSalesOrders(orders = []) {
  return SALES_GROUPS.map((group) => ({
    ...group,
    orders: (orders || []).filter((order) => salesCategoryOf(order) === group.key),
  }));
}

/** 销售子 tab 的看板：四类分组 + 每类下面照旧是一张单一张卡（操作入口一个字没变）。 */
export function ordersBoardHtml(orders = [], groupKeys = SALES_GROUPS.map((group) => group.key)) {
  if (!(orders || []).length) return `<p class="empty" data-view="orders-empty">${escapeHtml(P.empty)}</p>`;
  const groups = groupSalesOrders(orders).filter((group) => groupKeys.includes(group.key));
  return `<div class="orders-board" data-view="orders-board">${groups.map((group) => `
      <section class="order-group" data-sales-group="${escapeHtml(group.key)}">
        <div class="order-group-head">
          <h3>${escapeHtml(group.label)}</h3>
          <span class="muted">${group.orders.length} 单</span>
        </div>
        ${group.orders.length
    ? ordersListHtml(group.orders)
    : `<p class="empty compact">${escapeHtml(T.groupEmpty)}</p>`}
      </section>`).join('')}
    </div>`;
}

// ── ⭐⭐ 2026-10-09（她定的最终结构）+ 2026-10-11（判据按她的新口径重写）────────────
//
// 她逐字：「② **订单列表**（**补充信息单** ｜ **待交割单**（货没给 / 钱没付完）｜ **售后列表**（钱货两清的））」
//        「**货品信息和资金信息是校验项，其余不是校验项**」
//        「**至少一笔就算"信息全"**（它进待交割），**收齐才进"售后列表"**」
// ⚠️ 判据只用**既有字段与取值**（点名表在 `config/orders.js` 的 `ORDER_STATE_FIELDS`），
//    **不新增任何状态枚举**；分段互斥且覆盖全部单子。

/**
 * 两个**校验项**齐不齐（纯函数；她 2026-10-09 的口径）：
 *   · ① **货品信息** = 明细的 `product`（编号）/ `color`（颜色）/ `size`（尺码）都有值。
 *     ⚠️ **配品行不参与**：`requires_size === false` 的那些行（编号 / 颜色 / 尺码**本来就是留空的**，
 *        那是她的口径，不是"缺信息"）先被排除掉；一条明细都没有 = 缺（还没卖东西）。
 *   · ② **资金信息** = **至少一笔收款记录**且那一笔**有收款方式**（`method`）。
 *     ⚠️ 只写了一条「未收款」（欠款）而没有真正的收款 = **还没齐**（它没有收款方式）。
 *   ⚠️ **备注 / 配品 / 赠品都不是校验项** —— 这里一个都不读。
 */
export function salesInfoOf(order = {}) {
  const lines = Array.isArray(order.details) ? order.details : [];
  const goodsLines = lines.filter((line) => line?.requires_size !== false);
  const goodsMissing = lines.length === 0 || goodsLines.some((line) =>
    !String(line?.product ?? '').trim()
    || !String(line?.color ?? '').trim()
    || line?.size == null || String(line.size).trim() === '');
  const payments = Array.isArray(order.payments) ? order.payments : [];
  const fundsMissing = !payments.some((payment) => String(payment?.method ?? '').trim());
  return { goodsMissing, fundsMissing };
}

/**
 * 一张单属于哪一份单子（**纯函数**，配置里的三段顺序就是判定的优先级）：
 *   · `supplement` —— **缺任一校验项**（货品信息 / 资金信息）；
 *   · `afterSales` —— **钱货两清**（`salesCategoryOf` 判成 `settled`）；
 *   · `pending`    —— 其余（两个校验项齐了，但货没给完 / 钱没付完）。
 */
export function salesSectionOf(order) {
  // ⭐⭐ 2026-10-11：「**卖了样品、没指定门盒**」也是一类**待补充**（服务端只读事实
  //    `order.sample_pending`，见 `salesFollowupService.listOrders`）—— **先判它**。
  //    ⚠️ 其余判据**一个字都没动**（货品信息 / 资金信息 / 两清那三段照旧）。
  if (order?.sample_pending) return SALES_SECTIONS[0].key;
  const info = salesInfoOf(order);
  // ⚠️ 履约 / 收款状态读不出来（空）时不敢说"两清"：`salesCategoryOf` 会把它归到
  //    「有二次」那一侧 —— 但那种单**往往连资金信息都还没有**（收款明细为空），
  //    所以它会先落到"待补充"，与她的口径一致。
  if (info.goodsMissing || info.fundsMissing) return SALES_SECTIONS[0].key;
  return salesCategoryOf(order) === 'settled' ? 'afterSales' : 'pending';
}

/**
 * 三份单子（**顺序 = 配置顺序**）：每一段一个标题 + 条数，下面照旧是一张单一张卡。
 * ⚠️ 「待交割单」那一段**仍按既有的三类细分展示**（有二次 · 货未交付 / 资金未收 / 两者都有）
 *    —— 她 2026-10-09 上半场定的那三类**一条信息都没丢**，只是收在"待交割单"这一段里。
 */
export function ordersSectionsHtml(orders = [], { openSections = [] } = {}) {
  const listAll = Array.isArray(orders) ? orders : [];
  return `<div class="orders-sections" data-view="orders-sections">${SALES_SECTIONS.map((section) => {
    const list = listAll.filter((order) => salesSectionOf(order) === section.key);
    let body;
    if (section.key === 'pending') {
      body = !list.length
        ? `<p class="empty compact">${escapeHtml(T.groupEmpty)}</p>`
        : ordersBoardHtml(list, SALES_GROUPS.filter((group) => group.key !== 'settled').map((group) => group.key));
    } else {
      body = `<p class="empty compact" data-view="section-placeholder">待建设</p>`;
    }
    const head = `
        <div class="order-group-head">
          <h3>${escapeHtml(section.label)}<span class="tag tag-${escapeHtml(section.tone || 'info')}">${escapeHtml(section.tag || '')}</span></h3>
          <span class="muted">${list.length} 单</span>
        </div>`;
    return `
      <section class="order-section" data-sales-section="${escapeHtml(section.key)}" data-tap-target="orders-section:${escapeHtml(section.key)}">
        ${head}
        ${body}
      </section>`;
  }).join('')}
    </div>`;
}

/**
 * 销售订单列表的**入口卡片**：交割单 / 售后单 / 草稿单。
 * 点击卡片后才进入对应内容（交割单=现有订单，其余=待建设）。
 */
export function ordersSectionCardsHtml(orders = [], { counts = true } = {}) {
  const listAll = Array.isArray(orders) ? orders : [];
  return `<div class="orders-section-cards" data-view="orders-section-cards">${SALES_SECTIONS.map((section) => {
    const count = listAll.filter((order) => salesSectionOf(order) === section.key).length;
    return `<button class="entry-card orders-section-card" type="button" data-orders-section="${escapeHtml(section.key)}">
      <span class="icon">${escapeHtml(section.icon || '')}</span>
      <h3>${escapeHtml(section.label)}</h3>
      <p>${escapeHtml(section.desc || '')}</p>
      <span class="orders-section-meta"><span class="tag tag-${escapeHtml(section.tone || 'info')}">${escapeHtml(section.tag || '')}</span>${counts ? `<span class="muted">${count} 单</span>` : '<span class="muted">点开查看</span>'}</span>
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

/** 交付区：**只列未交付的明细**（已交付的库存早扣了，不再给勾）。 */
const deliveryBlock = (order) => {
  const pending = (order.details || []).filter((line) => line.fulfillment_status !== '已交付');
  const body = pending.length
    ? `<div class="check-list">${pending.map((line) => `
            <label class="check-line">
              <input type="checkbox" data-field="delivery-detail" value="${escapeHtml(line.record_id)}" checked>
              <span>${escapeHtml(line.product || '')} · ${sizeText(line.size)} · ${line.actual_amount == null ? '—' : amount(line.actual_amount)}</span>
            </label>`).join('')}</div>
          <button class="btn btn-primary" type="button" data-action="deliver">${escapeHtml(T.deliverySubmit)}</button>`
    : `<p class="muted">${escapeHtml(T.deliveryEmpty)}</p>`;
  return `
      <details class="action-form" data-action-block="delivery">
        <summary>${escapeHtml(T.deliveryTitle)}</summary>
        <div class="action-body">
          ${body}
        </div>
      </details>`;
};

const paymentFormBlock = (order, methods) => `
      <details class="action-form" data-action-block="payment">
        <summary>${escapeHtml(T.collectTitle)}</summary>
        <div class="action-body">
          <label class="form-field">${escapeHtml(T.collectAmount)}（还差 ${amount(order.pending_amount)}）
            <input data-field="payment-amount" type="text" inputmode="decimal" value="${escapeHtml(order.pending_amount == null ? '' : order.pending_amount)}">
          </label>
          <label class="form-field">${escapeHtml(T.paymentMethod)}
            <select data-field="payment-method">${methodOptionsHtml(methods)}</select>
          </label>
          <button class="btn btn-primary" type="button" data-action="submit-payment">${escapeHtml(T.collectSubmit)}</button>
        </div>
      </details>`;

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
const detailAmountBlock = (order) => {
  const lines = (order.details || []).filter((line) => line.actual_amount == null);
  if (!lines.length) return '';
  return `
      <details class="action-form" data-action-block="detail-amount">
        <summary>${escapeHtml(T.detailAmountTitle)}</summary>
        <div class="action-body">
          ${(order.details || []).map((line) => `
          <label class="form-field">${escapeHtml(line.product || '')} · ${sizeText(line.size)}
            <input data-field="detail-amount" data-detail="${escapeHtml(line.record_id)}" type="text"
              inputmode="decimal" value="${escapeHtml(line.actual_amount == null ? '' : line.actual_amount)}"
              aria-label="${escapeHtml(T.detailAmountLabel)}">
          </label>`).join('')}
          <button class="btn btn-primary" type="button" data-action="submit-detail-amount">${escapeHtml(T.detailAmountSubmit)}</button>
        </div>
      </details>`;
};

/**
 * ⭐⭐ 2026-10-11（业务负责人）：「**卖了样品、没指定把门盒变成谁的**」那条待办的操作块。
 *
 * 一条待办一行：`哪双鞋 · 哪个码 的样品卖掉了` + **选一个还有门盒的码** ⇒ 补上
 * （服务端：那一双 **门盒 → 样品**，**1 双**、库存总数不变；与群卡片共用同一个幂等键）。
 * ⚠️ 候选码与"还剩几双门盒"**都来自服务端**（`sample_pending_lines[].candidates`），
 *    页面不猜、也不自己设默认值之外的东西；一个候选都没有 ⇒ 只给一句人话，**不给假按钮**。
 */
const sampleFillBlock = (order) => {
  const lines = (order.sample_pending_lines || []).filter((line) => line?.detail_record_id);
  if (!lines.length) return '';
  const rows = lines.map((line) => {
    const label = fillText(T.sampleFillLine, {
      product: line.product_number || '这一双', size: line.size == null ? '—' : line.size,
    });
    if (!(line.candidates || []).length) {
      return `<p class="muted" data-sample-line="${escapeHtml(line.detail_record_id)}">${escapeHtml(label)}</p>
          <p class="muted">${escapeHtml(T.sampleFillNoCandidate)}</p>`;
    }
    return `<label class="form-field">${escapeHtml(label)}
            <select data-field="sample-fill-size" data-detail="${escapeHtml(line.detail_record_id)}">
              ${line.candidates.map((candidate) => `<option value="${escapeHtml(String(candidate.size))}">${escapeHtml(fillText(T.sampleFillOption, { size: candidate.size, count: candidate.doorBoxCount }))}</option>`).join('')}
            </select>
          </label>`;
  }).join('');
  const actionable = lines.some((line) => (line.candidates || []).length);
  return `
      <details class="action-form" data-action-block="sample-fill">
        <summary>${escapeHtml(T.sampleFillTitle)}</summary>
        <div class="action-body">
          <span class="muted">${escapeHtml(T.sampleFillSizeLabel)}</span>
          ${rows}
          ${actionable ? `<button class="btn btn-primary" type="button" data-action="submit-sample-fill">${escapeHtml(T.sampleFillSubmit)}</button>` : ''}
        </div>
      </details>`;
};

const secondDeliveryBlock = (order, methods) => `
      <details class="action-form" data-action-block="second-delivery">
        <summary>${escapeHtml(T.secondDeliveryTitle)}</summary>
        <div class="action-body">
          <label class="form-field">${escapeHtml(T.secondDeliveryMethod)}
            <select data-field="second-delivery-method">${methodOptionsHtml(methods)}</select>
          </label>
          <button class="btn btn-primary" type="button" data-action="submit-second-delivery">${escapeHtml(T.secondDeliverySubmit)}</button>
        </div>
      </details>`;

/** 售后区（退 / 换 / 赔）：动作 + 要处理的明细 + 回库状态 + 换/赔的鞋 + 钱。 */
const afterSalesBlock = (order, methods) => {
  const lines = order.details || [];
  return `
      <details class="action-form" data-action-block="after-sales">
        <summary>${escapeHtml(T.afterSalesTitle)}</summary>
        <div class="action-body">
          <label class="form-field">${escapeHtml(T.afterSalesAction)}
            <select data-field="after-sales-action">
              ${AFTER_SALES_ACTIONS.map((item, index) => `<option value="${escapeHtml(item.value)}"${index === 0 ? ' selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </label>
          <fieldset class="form-field check-fieldset">
            <legend>${escapeHtml(T.afterSalesDetails)}</legend>
            ${lines.map((line) => `
              <label class="check-line">
                <input type="checkbox" data-field="after-sales-detail" value="${escapeHtml(line.record_id)}">
                <span>${escapeHtml(line.product || '')} · ${sizeText(line.size)} · ${line.actual_amount == null ? '—' : amount(line.actual_amount)} · ${escapeHtml(line.fulfillment_status || '')}</span>
              </label>`).join('') || '<p class="muted">这张单没有可处理的明细</p>'}
          </fieldset>
          <div data-view="restock-block">
            <label class="form-field">${escapeHtml(T.restockState)}
              <select data-field="restock-state">${RESTOCK_STATES.map((state) => `<option>${escapeHtml(state)}</option>`).join('')}</select>
            </label>
          </div>
          <div class="hidden" data-view="new-line-block">
            <div class="mode-choice">
              <label><input type="radio" name="new-line-mode" value="same" checked> ${escapeHtml(T.newLineSame)}</label>
              <label><input type="radio" name="new-line-mode" value="other"> ${escapeHtml(T.newLineOther)}</label>
            </div>
            <div class="hidden" data-view="new-product-block">
              <div class="toolbar compact-toolbar">
                <label class="form-field grow">${escapeHtml(T.newProductKeyword)}
                  <input data-field="new-product-keyword" placeholder="例如 XHB8095">
                </label>
                <button class="btn" type="button" data-action="search-product">${escapeHtml(T.newProductSearch)}</button>
              </div>
              <div data-view="new-product-rows"><p class="empty compact">${escapeHtml(T.newProductEmpty)}</p></div>
            </div>
            <label class="form-field">${escapeHtml(T.newLineSize)}
              <input data-field="new-line-size" type="number" min="1" step="1" inputmode="numeric" placeholder="例如 42">
            </label>
            <label class="form-field">${escapeHtml(T.newLineAmount)}
              <input data-field="new-line-amount" type="text" inputmode="decimal">
            </label>
          </div>
          <label class="form-field">${escapeHtml(T.diffAmount)}
            <input data-field="diff-amount" type="text" inputmode="decimal">
          </label>
          <label class="form-field">${escapeHtml(T.settlement)}
            <select data-field="settlement">
              <option value="">${escapeHtml(T.select)}</option>
              ${SETTLEMENTS.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </label>
          <label class="form-field">${escapeHtml(T.refundMethod)}
            <select data-field="refund-method">${methodOptionsHtml(methods, '', { placeholder: REFUND_METHOD_PLACEHOLDER })}</select>
          </label>
          <button class="btn btn-primary" type="button" data-action="submit-after-sales">${escapeHtml(T.afterSalesSubmit)}</button>
        </div>
      </details>`;
};

/**
 * 订单**详情**（点进一张单）：三项照旧看得到，下面四个动作各自收在 `<details>` 里。
 * 纯函数，`methods` = 后端返回的收款方式清单（可注入，便于测试）。
 */
export function orderDetailHtml(order, { methods = [] } = {}) {
  return `
    <div class="order-detail" data-order="${escapeHtml(order.record_id)}">
      <div class="order-detail-head">
        <button class="btn btn-ghost" type="button" data-action="back">${escapeHtml(P.back)}</button>
        <h3 class="order-no">${escapeHtml(order.order_no || order.record_id)}</h3>
        <span class="tag ${statusClass(order.payment_status)}">${escapeHtml(order.payment_status || '')}</span>
        <span class="tag ${statusClass(order.fulfillment_status)}">${escapeHtml(order.fulfillment_status || '')}</span>
      </div>
      <div class="summary">
        <div class="metric"><span>${escapeHtml(T.paid)}</span><strong>${amount(order.paid_amount)}</strong></div>
        <div class="metric"><span>${escapeHtml(T.pending)}</span><strong>${amount(order.pending_amount)}</strong></div>
        <div class="metric"><span>${escapeHtml(T.receivable)}</span><strong>${amount(order.receivable_amount)}</strong></div>
        <div class="metric"><span>${escapeHtml(T.pendingDelivery)}</span><strong>${escapeHtml(order.pending_delivery_quantity ?? 0)}</strong></div>
      </div>
      <section class="detail-block">
        <h4>${escapeHtml(T.details)}</h4>
        <ul class="order-lines">${(order.details || []).map(lineHtml).join('') || '<li class="order-line muted">这张单没有明细</li>'}</ul>
      </section>
      <section class="detail-block">
        <h4>${escapeHtml(T.payments)}</h4>
        ${(order.payments || []).length
    ? `<ul class="order-lines">${(order.payments || []).map((payment) => `
          <li class="order-line">
            <span class="line-product">${escapeHtml(payment.method || '')}</span>
            <span class="line-amount">${amount(payment.amount)}</span>
            <span class="tag ${statusClass(payment.status)}">${escapeHtml(payment.status || '')}</span>
          </li>`).join('')}</ul>`
    : '<p class="muted">还没有收款记录</p>'}
      </section>
      <div class="order-actions">
        ${detailAmountBlock(order)}
        ${sampleFillBlock(order)}
        ${paymentFormBlock(order, methods)}
        ${deliveryBlock(order)}
        ${secondDeliveryBlock(order, methods)}
        ${afterSalesBlock(order, methods)}
      </div>
      <p class="operation-result" data-view="action-result" role="status"></p>
    </div>`;
};

const actionSpecOf = (value) => AFTER_SALES_ACTIONS.find((item) => item.value === value) || AFTER_SALES_ACTIONS[0];

const uuid = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`);

/**
 * 页面模块。**事件全部走容器上的委托** —— 每次重画 innerHTML 后不需要重新绑定，
 * 也就不会出现"重画一次、按钮点不动"的老毛病。
 *
 * ⭐ 2026-10-09：多了 `mode`（`'both' | 'sales' | 'purchase'`，由 `config/domains.js` 给）——
 *    同一个模块现在挂在**两个领域**里：销售 tab 只看销售、采购 tab 只看采购；
 *    `mode: 'both'`（缺省）保留原来"内部两个子 tab"的老行为（既有用例钉着）。
 */
export function createOrdersModule({ mode = 'both' } = {}) {
  const singleMode = mode === 'sales' || mode === 'purchase';
  const state = {
    // ⭐【首屏】先旧后新：只做一次 + 两个展示标记
    firstPaintDone: false,
    refreshing: false,
    refreshError: '',
    // ⭐【乙】售后列表的折叠状态（她手动展开过 ⇒ 重画时照旧展开）
    openSections: [],
    container: null,
    orders: [],
    methods: [],
    order: null,
    activeSection: null,
    ordersLoaded: false,
    ordersLoading: false,
    // ⭐ 2026-10-09：订单列表内部的子 tab（销售 / 采购）—— 选中态自己实现。
    //    单领域模式（销售 tab / 采购 tab）下没有这一排按钮，直接从 mode 定住。
    subTab: mode === 'purchase' ? 'purchase' : ORDERS_SUB_TABS[0].value,
    purchaseRows: [],
    // 幂等：一次提交生成一个 requestId，重试复用同一个（成功后清空）。
    // 与「库存手工调整」页同一套做法（服务端就是这么认同一笔的）。
    pendingRequest: null,
    newProduct: null,
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
    // ⭐ 2026-10-10（业务负责人真机反馈：「下面的这些文字解释就不用了」）：
    //    一级领域页里**不再画大标题与描述行** —— 与子 tab 重复（订单列表在「销售」/「采购」
    //    两个领域里都是子 tab）。这里只留**能点的**：内部子 tab（非单领域模式）+ 列表正文。
    //    单领域模式（销售 tab / 采购 tab）**不画**内部那排子 tab —— 一级 tab 已经分好领域了，
    //    再套一层"销售 / 采购"只会让她多点一下（移动端尤其烦）。默认模式一个字没变。
    const subTabs = singleMode ? '' : `<div class="sub-tabs" data-view="orders-subtabs">${subTabsHtml(state.subTab)}</div>`;
    const salesPanel = `<div class="sub-panel${state.subTab === 'sales' ? '' : ' hidden'}" data-view="sales-panel">
          <div data-view="orders-host"><p class="section-loading">正在读取订单…</p></div>
        </div>`;
    const purchasePanel = `<div class="sub-panel${state.subTab === 'purchase' ? '' : ' hidden'}" data-view="purchase-panel">
          <div data-view="purchase-host"><p class="section-loading">${state.subTab === 'purchase' ? '正在读取采购申请…' : '打开后读取采购申请…'}</p></div>
        </div>`;
    state.container.innerHTML = `
      ${subTabs}
      ${mode === 'purchase' ? '' : salesPanel}
      ${mode === 'sales' ? '' : purchasePanel}
      <p class="operation-result" data-view="action-result" role="status"></p>`;
  }

  /** 子 tab 的**选中态**（只重画那两个按钮，不动一级 tab）。 */
  function renderSubTabs() {
    const host = $('[data-view="orders-subtabs"]');
    if (host) host.innerHTML = subTabsHtml(state.subTab);
  }

  /**
   * 切子 tab：**自己实现的选中态与切换**（认不出的按钮不动 —— `resolveSubTab`）。
   * 采购那一边每次切过去都**重新读一次**（到货状态会随验收变化，缓存住反而会撒谎）。
   */
  function switchSubTab(next) {
    const wanted = resolveSubTab(state.subTab, next);
    if (wanted === state.subTab && next !== state.subTab) return; // 认不出的按钮：什么都不做
    state.subTab = wanted;
    // 切走 / 切回都把销售那半边退回**列表**（详情页里有它自己的结果落点，
    // 留在 DOM 里会让 purchase 那边的人话显示在一张看不见的节点上）。
    state.order = null;
    renderSubTabs();
    $('[data-view="sales-panel"]')?.classList.toggle('hidden', wanted !== 'sales');
    $('[data-view="purchase-panel"]')?.classList.toggle('hidden', wanted !== 'purchase');
    if (wanted === 'purchase') {
      renderList();
      return loadPurchaseOrders();
    }
    renderList();
    return Promise.resolve();
  }

  function renderList() {
    state.order = null;
    const host = $('[data-view="orders-host"]');
    if (!host) return;
    const notices = `${state.refreshing ? '<p class="orders-refreshing">刷新中…</p>' : ''}${!state.refreshing && state.refreshError ? '<p class="orders-refreshing orders-refreshing--error">刷新失败，先看的是上次的结果</p>' : ''}`;
    if (!state.activeSection) {
      host.innerHTML = notices + ordersSectionCardsHtml(state.orders, { counts: state.ordersLoaded });
      return;
    }
    const section = SALES_SECTIONS.find((item) => item.key === state.activeSection);
    if (!state.ordersLoaded) {
      host.innerHTML = `${notices}<button class="btn btn-ghost" type="button" data-orders-section-back="1">← 返回订单列表</button>
        <p class="section-loading" data-view="orders-waiting">正在读取订单…</p>`;
      return;
    }
    const list = state.orders.filter((order) => salesSectionOf(order) === state.activeSection);
    const body = state.activeSection === 'pending'
      ? (list.length ? ordersBoardHtml(list, SALES_GROUPS.filter((group) => group.key !== 'settled').map((group) => group.key)) : `<p class="empty compact">${escapeHtml(T.groupEmpty)}</p>`)
      : `<p class="empty compact" data-view="section-placeholder">待建设</p>`;
    host.innerHTML = `${notices}<button class="btn btn-ghost" type="button" data-orders-section-back="1">← 返回订单列表</button>
      <section class="order-section" data-sales-section="${escapeHtml(section?.key || '')}"><div class="order-group-head"><h3>${escapeHtml(section?.label || '')}<span class="tag tag-${escapeHtml(section?.tone || 'info')}">${escapeHtml(section?.tag || '')}</span></h3><span class="muted">${list.length} 单</span></div>${body}</section>`;
  }

  function renderPurchaseList() {
    $('[data-view="purchase-host"]').innerHTML = purchaseOrdersHtml(state.purchaseRows);
  }

  function openOrder(order) {
    state.order = order;
    state.newProduct = null;
    state.diffEdited = false;
    $('[data-view="orders-host"]').innerHTML = orderDetailHtml(order, { methods: state.methods });
    toggleAfterSalesBlocks();
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
    state.methods = data.methods || [];
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
    const stopTicker = host && !state.order && !hasOrders ? startWaitingTicker(host) : () => {};
    const apply = (rows) => {
      state.orders = rows;
      state.ordersLoaded = true;
      state.ordersLoading = false;
      if (state.order) {
        const refreshed = state.orders.find((item) => item.record_id === state.order.record_id);
        if (refreshed) openOrder(refreshed);
        else renderList();
      } else {
        renderList();
      }
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

  /** 动作成功后刷新这张单（列表数据是唯一事实来源，不在前端自己改数字）。 */
  async function refreshAfterAction(keepResult) {
    const text = keepResult;
    await loadOrders({ freshOnly: true }); // ⭐ 写操作后强制拉新（绝不走旧缓存）
    if (text) renderResult(text);
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

  async function runAction(button, busyText, work) {
    // ⭐⭐ 2026-10-12《前端交互反馈纪律》：点击**立刻**置灰 + 换文案 +「（已 N 秒）」；
    //    同一颗按钮在跑的时候**再点直接忽略**（防连点重复提交）；失败/成功后都恢复。
    return runWriteAction(button, async () => {
      renderResult('');
      try {
        const message = await work();
        await refreshAfterAction(message);
        return true;
      } catch (error) {
        // 400 = 她填错了（服务端一个字节都没写）⇒ 换一个 requestId；
        // 其余保留，重试时复用同一个，避免"其实已经写进去一次"被记成两次。
        if (error.status === 400) state.pendingRequest = null;
        renderResult(describeError(error), true);
        return false;
      }
    }, busyText || SUBMIT_PENDING_TEXT);
  }

  // ── 补收款 ────────────────────────────────────────────────────────────────
  async function submitPayment(button) {
    const order = state.order;
    const raw = valueOf('payment-amount');
    const method = valueOf('payment-method');
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) return renderResult('收款金额必须是不小于 0 的数字（最多两位小数）', true);
    if (!method) return renderResult('请选择收款方式', true);
    const requestId = state.pendingRequest || uuid();
    state.pendingRequest = requestId;
    await runAction(button, '正在记收款…', async () => {
      const result = await api.post(ORDERS_API.payments, {
        salesEntryRecordId: order.record_id, method, amount: Number(raw), requestId,
      });
      state.pendingRequest = null;
      // ⭐ 2026-10-12（分笔补收款）：这句话里顺手把**还差多少**说出来 ——
      //    她接着记下一笔时一眼知道还剩多少（`pendingAmount` 是服务端现算的；收满 ⇒ 0）。
      //    ⚠️ 不加任何"怎么做"的说明句（她 2026-10-10 的硬要求）。
      const left = Number(result?.pendingAmount);
      return Number.isFinite(left) && left > 0
        ? `已记一笔收款：${method} ${amount(raw)}；还差 ${amount(left)}。`
        : `已记一笔收款：${method} ${amount(raw)}。`;
    });
  }

  // ── 逐件补「实收金额」────────────────────────────────────────────────────
  async function submitDetailAmount(button) {
    const order = state.order;
    const inputs = [...state.container.querySelectorAll('[data-field="detail-amount"]')];
    const amounts = inputs
      .map((input) => ({ detailRecordId: input.dataset.detail, amount: input.value.trim() }))
      .filter((item) => item.amount !== '');
    if (!amounts.length) return renderResult('还没有填实收金额', true);
    const invalid = amounts.find((item) => !/^\d+(\.\d{1,2})?$/.test(item.amount) || Number(item.amount) <= 0);
    if (invalid) return renderResult('实收金额要填大于 0 的数字（最多两位小数）', true);
    const requestId = state.pendingRequest || uuid();
    state.pendingRequest = requestId;
    await runAction(button, '正在保存实收金额…', async () => {
      const result = await api.post(ORDERS_API.detailAmounts, {
        salesEntryRecordId: order.record_id, amounts, requestId,
      });
      state.pendingRequest = null;
      const saved = `已保存 ${(result.changed || []).length} 件的实收金额`;
      return result.owed
        ? `${saved}；还差 ${amount(result.owed.amount)}，待收款那条已经同步。`
        : `${saved}。`;
    });
  }

  // ── 补样品（卖了样品没指定门盒的那条待办）────────────────────────────────
  async function submitSampleFill(button) {
    const selects = [...state.container.querySelectorAll('[data-field="sample-fill-size"]')];
    const wanted = selects
      .map((select) => ({ detailRecordId: select.dataset.detail, size: select.value }))
      .filter((item) => item.detailRecordId && item.size !== '');
    if (!wanted.length) return renderResult(T.sampleFillNoCandidate, true);
    const requestId = state.pendingRequest || uuid();
    state.pendingRequest = requestId;
    const lines = [];
    await runAction(button, '正在补样品…', async () => {
      for (const item of wanted) {
        const result = await api.post(ORDERS_API.sampleFill, { ...item, requestId });
        lines.push(result.message || fillText(T.sampleFillDone, { size: item.size }));
      }
      state.pendingRequest = null;
      return lines.join('；');
    });
  }

  // ── 交付 ─────────────────────────────────────────────────────────────────
  async function submitDelivery(button) {
    const order = state.order;
    const detailRecordIds = [...state.container.querySelectorAll('[data-field="delivery-detail"]')]
      .filter((input) => input.checked).map((input) => input.value);
    if (!detailRecordIds.length) return renderResult('请先勾选要交付的明细', true);
    await runAction(button, '正在交付…', async () => {
      const result = await api.post(ORDERS_API.deliveries, { salesEntryRecordId: order.record_id, detailRecordIds });
      const failed = result.failures || [];
      return failed.length
        ? `交付完成 ${(result.results || []).length} 条，失败 ${failed.length} 条：${failed.map((item) => item.error).join('；')}`
        : `已交付 ${detailRecordIds.length} 条明细。`;
    });
  }

  // ── 二次交付 ─────────────────────────────────────────────────────────────
  async function submitSecondDelivery(button) {
    const order = state.order;
    const method = valueOf('second-delivery-method');
    await runAction(button, '正在收尾款并交付…', async () => {
      const result = await api.post(ORDERS_API.secondDelivery, { salesEntryRecordId: order.record_id, method });
      if (result.alreadyCompleted) return '这张单的钱和货都已经齐了，没有重复写。';
      return `已收尾款 ${amount(result.collectedAmount)} 并交付。`;
    });
  }

  // ── ⭐⭐ 2026-10-15（⑨b-1 UI）「未完成，可点重试」──────────────────────────
  /**
   * 续写那一单（**同一把 `submitKey`**，服务端 = 既有 `POST /sales/retry`）。
   *
   * 🔴 三条：
   *   · **不新开写库** ✗ —— 服务端走的是既有 `submitSale`（幂等不拆 ✓ 绝不直调 `_confirm` ✓）；
   *   · **失败如实显示** ✗ 不许假成功 —— `runAction` 的 catch 会把服务端那句人话原样摆出来
   *     （400 = "没有待续的单 / 单号对不上"、500 = "没写成"）；
   *   · 成功 ⇒ `runAction` 里的 `refreshAfterAction` **强制拉新**（`freshOnly`）⇒ 她那一眼看到的是
   *     真实状态（服务端同时作废了订单缓存 ✓）。
   */
  async function submitRetryWrite(button) {
    const orderNo = String(button?.dataset?.orderNo || '').trim();
    await runAction(button, T.retrying, async () => {
      const result = await api.post(ORDERS_API.retry, orderNo ? { order_no: orderNo } : {});
      // ⭐ `reused:true` = 这一单刚才已经交过了（不是又写了一遍）⇒ 如实说"已经写完了"
      if (result?.reused === true) return T.retryAlreadyDone;
      return result?.message || T.retryDone;
    });
  }

  // ── 售后 ─────────────────────────────────────────────────────────────────
  function afterSalesInput() {
    const action = valueOf('after-sales-action');
    const spec = actionSpecOf(action);
    const detailRecordIds = [...state.container.querySelectorAll('[data-field="after-sales-detail"]')]
      .filter((input) => input.checked).map((input) => input.value);
    const body = {
      action,
      salesEntryRecordId: state.order.record_id,
      detailRecordIds,
      requestId: state.pendingRequest || uuid(),
    };
    if (spec.needsRestock) body.restockState = valueOf('restock-state');
    if (spec.needsNewLine) {
      const mode = state.container.querySelector('input[name="new-line-mode"]:checked')?.value || 'same';
      body.newLine = {
        sameItem: mode === 'same',
        size: valueOf('new-line-size'),
        amount: valueOf('new-line-amount'),
      };
      if (mode === 'other' && state.newProduct) body.newLine.productRecordId = state.newProduct.recordId;
    }
    body.diffAmount = valueOf('diff-amount');
    body.settlement = valueOf('settlement');
    body.paymentMethod = valueOf('refund-method');
    return body;
  }

  async function submitAfterSales(button) {
    const body = afterSalesInput();
    if (!body.detailRecordIds.length) return renderResult('请先勾选要处理的销售明细', true);
    const spec = actionSpecOf(body.action);
    if (spec.needsNewLine && !body.newLine.size) return renderResult('请填新鞋的尺码', true);
    if (spec.needsNewLine && body.newLine.sameItem === false && !body.newLine.productRecordId) {
      return renderResult('请先查找并选择另一双的货号', true);
    }
    state.pendingRequest = body.requestId;
    await runAction(button, '正在提交售后…', async () => {
      const result = await api.post(ORDERS_API.afterSales, body);
      state.pendingRequest = null;
      return `${result.label || spec.label}已经记好了（售后单 ${result.masterRecordId || ''}）。`;
    });
  }

  // ── 换 / 赔的货品查找（复用既有只读货品选择器）─────────────────────────────
  async function searchProduct() {
    const rows = $('[data-view="new-product-rows"]');
    const keyword = valueOf('new-product-keyword');
    rows.innerHTML = '<p class="section-loading">正在查找货品…</p>';
    try {
      const data = await api.get(`${ORDERS_API.products}?${new URLSearchParams({ keyword })}`);
      const list = data.rows || [];
      rows.innerHTML = list.length
        ? `<div class="picker-list" data-view="new-product-list">${list.map((row) => {
          const label = [row.item_no, row.color].filter(Boolean).join(' ') || row.product_number || row.record_id;
          return `<button class="picker-item" type="button" data-product="${escapeHtml(row.record_id)}" data-label="${escapeHtml(label)}"><strong>${escapeHtml(row.item_no || row.product_number || row.record_id)}</strong><span class="muted">${escapeHtml(row.product_number || '')}${row.color ? ` · ${escapeHtml(row.color)}` : ''}</span></button>`;
        }).join('')}</div>`
        : '<p class="empty compact">没有匹配的货品，换个货号试试。</p>';
    } catch (error) {
      rows.innerHTML = '<p class="empty compact">货品查找失败</p>';
      renderResult(describeError(error), true);
    }
  }

  /** 换 / 赔那块表单按动作 + 模式显隐（赔货不需要「退回的鞋回哪儿」）。 */
  function toggleAfterSalesBlocks() {
    const actionSelect = field('after-sales-action');
    if (!actionSelect) return;
    const spec = actionSpecOf(actionSelect.value);
    $('[data-view="restock-block"]')?.classList.toggle('hidden', !spec.needsRestock);
    $('[data-view="new-line-block"]')?.classList.toggle('hidden', !spec.needsNewLine);
    const mode = state.container.querySelector('input[name="new-line-mode"]:checked')?.value || 'same';
    $('[data-view="new-product-block"]')?.classList.toggle('hidden', mode !== 'other');
    renderSettlementOptions(spec);
  }

  /**
   * 「资金走向」下拉：候选只有既有配置里那两个，且按动作过滤
   * （`prepaid`（钱留在我们这里）只有**退货**走得通 —— 换货 / 赔货选它，
   *  既有执行器会当场把原因说出来，这里就别给她一个点不通的选项）。
   */
  function renderSettlementOptions(spec) {
    const select = field('settlement');
    if (!select) return;
    const current = select.value;
    const allowed = SETTLEMENTS.filter((item) => item.actions.includes(spec.value));
    select.innerHTML = `<option value="">${escapeHtml(T.select)}</option>`
      + allowed.map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`).join('');
    if (allowed.some((item) => item.value === current)) select.value = current;
  }

  /** 已经在售后区勾上的明细（退款金额的**建议值**从这张单自己的成交金额来）。 */
  function checkedAfterSalesLines() {
    const ids = [...state.container.querySelectorAll('[data-field="after-sales-detail"]')]
      .filter((input) => input.checked).map((input) => input.value);
    return (state.order?.details || []).filter((line) => ids.includes(line.record_id));
  }

  /**
   * 退货时把「差价」预填成**负的原明细成交金额合计**（= 要退给她多少钱）。
   * ⚠️ 这是**建议值、她自己可以改** —— 与群聊链路里那张卡片的口径一致
   *   （`afterSalesFlowService.buildPlan`：退货建议差价 = -原明细成交金额）；
   *   她手动改过之后就不再覆盖（`state.diffEdited`）。
   */
  function suggestDiffAmount() {
    const input = field('diff-amount');
    if (!input || state.diffEdited) return;
    if (valueOf('after-sales-action') !== 'return') return;
    const total = checkedAfterSalesLines()
      .reduce((sum, line) => sum + Number(line.actual_amount || 0), 0);
    input.value = total ? String(-Math.round(total * 100) / 100) : '';
  }

  function bind() {
    // ⚠️ `<details>` 的 `toggle` **不冒泡** ⇒ 必须用捕获阶段监听，否则收不到
    state.container.addEventListener('toggle', (event) => {
      const target = event.target;
      if (!target || target.dataset?.view !== 'after-sales-section') return;
      const key = 'afterSales';
      state.openSections = target.open
        ? [...new Set([...state.openSections, key])]
        : state.openSections.filter((item) => item !== key);
    }, true);
    state.container.addEventListener('click', (event) => {
      // 货品选择器（换 / 赔那一块）：点中一行就记下来，再点一次换一双。
      const picker = event.target.closest('[data-product]');
      if (picker) {
        state.newProduct = { recordId: picker.dataset.product, label: picker.dataset.label || '' };
        state.container.querySelectorAll('[data-product]').forEach((item) => item.classList.toggle('active', item === picker));
        renderResult(`已选：${state.newProduct.label}`);
        return;
      }
      const sectionCard = event.target.closest('[data-orders-section]');
      if (sectionCard) {
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
      // ⭐ 2026-10-09：子 tab 的切换（自己实现）—— 放在 data-action 分派**之前**，
      //    因为子 tab 是另一套标记（`data-subtab`），不该和业务动作混在一个分支里。
      const subTab = event.target.closest('[data-subtab]');
      if (subTab) return switchSubTab(subTab.dataset.subtab);
      if (!trigger) return;
      const action = trigger.dataset.action;
      if (action === 'refresh') {
        return state.subTab === 'purchase' ? loadPurchaseOrders() : loadOrders();
      }
      if (action === 'open-order') {
        const order = state.orders.find((item) => item.record_id === trigger.dataset.order);
        return order ? openOrder(order) : undefined;
      }
      // ⭐⭐ 2026-10-15（⑨b-1 UI）：「未完成，可点重试」那颗按钮 —— 调**既有**服务端路由续写
      if (action === 'retry-write') return submitRetryWrite(trigger);
      if (action === 'back') return renderList();
      if (action === 'search-product') return searchProduct();
      if (action === 'submit-payment') return submitPayment(trigger);
      if (action === 'submit-detail-amount') return submitDetailAmount(trigger);
      if (action === 'submit-sample-fill') return submitSampleFill(trigger);
      if (action === 'deliver') return submitDelivery(trigger);
      if (action === 'submit-second-delivery') return submitSecondDelivery(trigger);
      if (action === 'submit-after-sales') return submitAfterSales(trigger);
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
    state.container.addEventListener('change', (event) => {
      const target = event.target;
      if (target.matches('[data-field="after-sales-action"], input[name="new-line-mode"]')) {
        toggleAfterSalesBlocks();
        suggestDiffAmount();
      }
      if (target.matches('[data-field="after-sales-detail"]')) suggestDiffAmount();
      if (target.matches('[data-field="diff-amount"]')) state.diffEdited = true;
    });
    state.container.addEventListener('input', (event) => {
      if (event.target.matches('[data-field="diff-amount"]')) state.diffEdited = true;
    });
  }

  return {
    mount(container) {
      state.container = container;
      renderShell();
      bind();
      // 单领域模式只读自己那一边（采购 tab 不发销售订单请求，销售 tab 不发采购申请请求）。
      if (mode === 'purchase') loadPurchaseOrders();
      else renderList();
    },
  };
}
