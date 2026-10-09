import { api } from '../../core/api-client.js';
import { escapeHtml, money, statusClass } from '../../core/formatters.js';
import { describeError, setBusy, showPageError } from '../../core/ui.js';
import {
  ORDERS_API, ORDERS_PAGE, ORDERS_TEXTS, DEFAULT_COLLECTION_METHOD, COLLECTION_METHODS,
  REFUND_METHOD_PLACEHOLDER, RESTOCK_STATES, AFTER_SALES_ACTIONS, SETTLEMENTS,
  ORDERS_SUB_TABS, SALES_GROUPS, SALES_SECTIONS, DELIVERED_FULFILLMENT, PAID_PAYMENT_STATUS,
  ARRIVAL_CONFIRM,
} from '../../config/orders.js';

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

/** 一条销售明细（她的第 2 项）：哪些货 / 颜色 / 尺码 / 金额 / 履约状态。 */
const lineHtml = (line) => `
          <li class="order-line">
            <span class="line-product">${escapeHtml(line.product || '未填货号')}</span>
            <span class="line-size">${sizeText(line.size)}</span>
            <span class="line-amount">${line.actual_amount == null ? '—' : amount(line.actual_amount)}</span>
            <span class="tag ${statusClass(line.fulfillment_status)}">${escapeHtml(line.fulfillment_status || '')}</span>
          </li>`;

const detailsBlock = (order) => {
  const lines = order.details || [];
  return `
        <details class="order-details-toggle">
          <summary>${escapeHtml(T.details)}（${lines.length} 项 · 待交付 ${Number(order.pending_delivery_quantity || 0)}）</summary>
          <ul class="order-lines">${lines.map(lineHtml).join('') || '<li class="order-line muted">这张单没有明细</li>'}</ul>
        </details>`;
};

/**
 * 订单**列表**：一行一张销售单 = 一张卡（销售单号 · 销售明细 · 收款情况）。
 * 纯函数：喂 `listOrders()` 的 `orders` 就能渲染（测试直接用）。
 */
export function ordersListHtml(orders = []) {
  if (!orders.length) return `<p class="empty" data-view="orders-empty">${escapeHtml(P.empty)}</p>`;
  return `<div class="orders-list" data-view="orders">${orders.map((order) => `
      <article class="order-card" data-order="${escapeHtml(order.record_id)}">
        <div class="order-card-head">
          <h3 class="order-no">${escapeHtml(order.order_no || order.record_id)}</h3>
          <div class="order-tags">
            <span class="tag ${statusClass(order.fulfillment_status)}">${escapeHtml(order.fulfillment_status || '')}</span>
          </div>
        </div>
        ${paymentBlock(order)}
        ${detailsBlock(order)}
        <div class="order-card-actions">
          <button class="btn btn-primary" type="button" data-action="open-order" data-order="${escapeHtml(order.record_id)}">${escapeHtml(P.open)}</button>
        </div>
      </article>`).join('')}
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
          <span class="muted">${escapeHtml(group.hint)} · ${group.orders.length} 单</span>
        </div>
        ${group.orders.length
    ? ordersListHtml(group.orders)
    : `<p class="empty compact">${escapeHtml(T.groupEmpty)}</p>`}
      </section>`).join('')}
    </div>`;
}

// ── ⭐⭐ 2026-10-09（她定的最终结构）：订单列表内部的三份单子 ────────────────────────
//
// 她逐字：「② **订单列表**（**补充信息单** ｜ **待交割单**（货没给 / 钱没付完）｜ **售后列表**（钱货两清的））」
// ⚠️ 判据只用**既有字段与取值**（`fulfillment_status` / `payment_status` / 明细的 `size`、
//    `actual_amount`），**不新增任何状态枚举**；分段互斥且覆盖全部单子。

/**
 * 一张单属于哪一份单子（**纯函数**，配置里的三段顺序就是判定的优先级）：
 *   · `supplement` —— 信息还没填全：履约 / 收款状态读不出来，或有明细缺尺码 / 缺成交金额
 *     （「资金等非必填、可后续补」建出来的单就落在这里）；
 *   · `afterSales` —— **钱货两清**（`salesCategoryOf` 判成 `settled`）；
 *   · `pending`    —— 其余（信息齐了，但货没给完 / 钱没付完）。
 */
export function salesSectionOf(order) {
  const lines = order?.details || [];
  const infoMissing = !order?.fulfillment_status || !order?.payment_status
    || lines.some((line) => line?.size == null || line.size === '' || line.actual_amount == null);
  if (infoMissing) return SALES_SECTIONS[0].key;
  return salesCategoryOf(order) === 'settled'
    ? SALES_SECTIONS[SALES_SECTIONS.length - 1].key
    : 'pending';
}

/**
 * 三份单子（**顺序 = 配置顺序**）：每一段一个标题 + 条数，下面照旧是一张单一张卡。
 * ⚠️ 「待交割单」那一段**仍按既有的三类细分展示**（有二次 · 货未交付 / 资金未收 / 两者都有）
 *    —— 她 2026-10-09 上半场定的那三类**一条信息都没丢**，只是收在"待交割单"这一段里。
 */
export function ordersSectionsHtml(orders = []) {
  if (!(orders || []).length) return `<p class="empty" data-view="orders-empty">${escapeHtml(P.empty)}</p>`;
  return `<div class="orders-sections" data-view="orders-sections">${SALES_SECTIONS.map((section) => {
    const list = orders.filter((order) => salesSectionOf(order) === section.key);
    const body = !list.length
      ? `<p class="empty compact">${escapeHtml(T.groupEmpty)}</p>`
      : (section.key === 'pending'
        ? ordersBoardHtml(list, SALES_GROUPS.filter((group) => group.key !== 'settled').map((group) => group.key))
        : ordersListHtml(list));
    return `
      <section class="order-section" data-sales-section="${escapeHtml(section.key)}">
        <div class="order-group-head">
          <h3>${escapeHtml(section.label)}</h3>
          <span class="muted">${escapeHtml(section.hint)} · ${list.length} 单</span>
        </div>
        ${body}
      </section>`;
  }).join('')}
    </div>`;
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
    const key = String(row?.batch_no || '').trim() || '（无批次号）';
    if (!byBatch.has(key)) byBatch.set(key, { batch_no: key, rows: [] });
    byBatch.get(key).rows.push(row);
  }
  return [...byBatch.values()];
}

/** 这一批的到货状态（既有字段；同批次里任一明细说没到货就算没到货）。 */
const arrivalStatusOf = (batch) => {
  const statuses = (batch.rows || []).map((row) => String(row.arrival_status || '').trim()).filter(Boolean);
  if (statuses.includes('未到货')) return '未到货';
  return statuses[0] || '';
};

/** 采购子 tab 的列表：一张报货批次一张卡，每张卡上都有「验收到货」。 */
export function purchaseOrdersHtml(rows = []) {
  const batches = groupPurchaseOrders(rows);
  if (!batches.length) return `<p class="empty" data-view="purchase-empty">${escapeHtml(P.purchaseEmpty)}</p>`;
  return `<div class="purchase-orders" data-view="purchase-orders">${batches.map((batch) => `
      <article class="order-card" data-purchase-batch="${escapeHtml(batch.batch_no)}">
        <div class="order-card-head">
          <h3 class="order-no">${escapeHtml(batch.batch_no)}</h3>
          <div class="order-tags">
            <span class="tag ${statusClass(arrivalStatusOf(batch))}">${escapeHtml(arrivalStatusOf(batch) || '未到货')}</span>
          </div>
        </div>
        <ul class="order-lines">${batch.rows.map((row) => `
          <li class="order-line">
            <span class="line-product">${escapeHtml(row.product_number || '未填货号')}</span>
            <span class="line-size">${sizeText(row.size)}</span>
            <span class="line-amount">×${escapeHtml(Number(row.quantity || 0))}</span>
          </li>`).join('')}</ul>
        <div class="order-card-actions">
          <button class="btn btn-primary" type="button" data-action="verify-arrival" data-batch="${escapeHtml(batch.batch_no)}">${escapeHtml(T.verifyArrival)}</button>
        </div>
        <details class="action-form" data-action-block="verify-arrival" data-arrival-batch="${escapeHtml(batch.batch_no)}">
          <summary>${escapeHtml(T.arrivalVerifyTitle)}</summary>
          <div class="action-body">
            <p class="muted">${escapeHtml(T.arrivalVerifyHint)}</p>
            <label class="form-field">${escapeHtml(T.arrivalAmount)}
              <input data-field="arrival-amount" type="text" inputmode="decimal" placeholder="${escapeHtml(ARRIVAL_CONFIRM.amountPlaceholder)}">
            </label>
            <label class="form-field">${escapeHtml(T.arrivalNote)}
              <input data-field="arrival-note" type="text" value="${escapeHtml(ARRIVAL_CONFIRM.defaultAcceptanceText)}">
            </label>
            <button class="btn btn-primary" type="button" data-action="submit-arrival" data-batch="${escapeHtml(batch.batch_no)}">${escapeHtml(T.arrivalSubmit)}</button>
          </div>
        </details>
      </article>`).join('')}
    </div>`;
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
          <p class="muted">${escapeHtml(T.deliveryHint)}</p>
          ${body}
        </div>
      </details>`;
};

const paymentFormBlock = (order, methods) => `
      <details class="action-form" data-action-block="payment">
        <summary>${escapeHtml(T.collectTitle)}</summary>
        <div class="action-body">
          <p class="muted">${escapeHtml(T.collectHint)}</p>
          <label class="form-field">${escapeHtml(T.collectAmount)}（还差 ${amount(order.pending_amount)}）
            <input data-field="payment-amount" type="text" inputmode="decimal" value="${escapeHtml(order.pending_amount == null ? '' : order.pending_amount)}">
          </label>
          <label class="form-field">${escapeHtml(T.paymentMethod)}
            <select data-field="payment-method">${methodOptionsHtml(methods)}</select>
          </label>
          <button class="btn btn-primary" type="button" data-action="submit-payment">${escapeHtml(T.collectSubmit)}</button>
        </div>
      </details>`;

const secondDeliveryBlock = (order, methods) => `
      <details class="action-form" data-action-block="second-delivery">
        <summary>${escapeHtml(T.secondDeliveryTitle)}</summary>
        <div class="action-body">
          <p class="muted">${escapeHtml(T.secondDeliveryHint)}</p>
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
          <p class="muted">${escapeHtml(T.afterSalesHint)}</p>
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
    container: null,
    orders: [],
    methods: [],
    order: null,
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
    const subtitle = mode === 'purchase' ? (P.purchaseSubtitle || P.subtitle) : P.subtitle;
    // 单领域模式（销售 tab / 采购 tab）**不画**内部那排子 tab —— 一级 tab 已经分好领域了，
    // 再套一层"销售 / 采购"只会让她多点一下（移动端尤其烦）。默认模式一个字没变。
    const subTabs = singleMode ? '' : `<div class="sub-tabs" data-view="orders-subtabs">${subTabsHtml(state.subTab)}</div>`;
    const salesPanel = `<div class="sub-panel${state.subTab === 'sales' ? '' : ' hidden'}" data-view="sales-panel">
          <div data-view="orders-host"><p class="section-loading">正在读取订单…</p></div>
        </div>`;
    const purchasePanel = `<div class="sub-panel${state.subTab === 'purchase' ? '' : ' hidden'}" data-view="purchase-panel">
          <div data-view="purchase-host"><p class="section-loading">${state.subTab === 'purchase' ? '正在读取采购申请…' : '打开后读取采购申请…'}</p></div>
        </div>`;
    state.container.innerHTML = `
      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>${escapeHtml(P.title)}</h2>
            <p class="subtitle">${escapeHtml(subtitle)}</p>
          </div>
        </div>
        ${subTabs}
        ${mode === 'purchase' ? '' : salesPanel}
        ${mode === 'sales' ? '' : purchasePanel}
        <p class="operation-result" data-view="action-result" role="status"></p>
      </section>`;
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
    // 三份单子（补充信息单 ｜ 待交割单 ｜ 售后列表）—— 她的口径，见 config/orders.js 的 SALES_SECTIONS。
    if (host) host.innerHTML = ordersSectionsHtml(state.orders);
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

  async function loadOrders() {
    const host = $('[data-view="orders-host"]');
    if (host && !state.order) host.innerHTML = '<p class="section-loading">正在读取订单…</p>';
    try {
      const data = await api.get(ORDERS_API.orders);
      state.orders = data.orders || [];
      state.methods = data.methods || [];
      if (state.order) {
        const refreshed = state.orders.find((item) => item.record_id === state.order.record_id);
        if (refreshed) openOrder(refreshed);
        else renderList();
      } else {
        renderList();
      }
    } catch (error) {
      if (host) host.innerHTML = '<p class="empty">订单读取失败</p>';
      showPageError(describeError(error));
    }
  }

  /** 动作成功后刷新这张单（列表数据是唯一事实来源，不在前端自己改数字）。 */
  async function refreshAfterAction(keepResult) {
    const text = keepResult;
    await loadOrders();
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
  async function submitArrival(button) {
    const batchNo = button.dataset.batch || '';
    const form = state.container.querySelector(`[data-arrival-batch="${batchNo}"]`);
    const read = (name) => String(form?.querySelector(`[data-field="${name}"]`)?.value ?? '').trim();
    const rawAmount = read('arrival-amount');
    const acceptanceText = read('arrival-note');
    if (!batchNo) return renderResult('这一行没有报货批次号，不能验收到货', true);
    if (!/^\d+(\.\d+)?$/.test(rawAmount) || Number(rawAmount) <= 0) {
      return renderResult('请先填这次的「实际金额」（大于 0 的数字），再点验收到货', true);
    }
    if (!acceptanceText) return renderResult('请先写一句到货说明，再点验收到货', true);
    setBusy(button, true, '正在验收入库…');
    renderResult('');
    try {
      const result = await api.post(ORDERS_API.arrivalConfirm, {
        batchNo, actualAmount: Number(rawAmount), acceptanceText,
      });
      // 列表数据是唯一事实来源：重新读一次（到货状态会跟着更新）
      await loadPurchaseOrders();
      renderResult(result.alreadyPosted
        ? `这批（${batchNo}）已经验收入库过了，没有重复入库。`
        : (result.message || `这批（${batchNo}）已验收入库。`));
      return true;
    } catch (error) {
      renderResult(describeError(error), true);
      return false;
    } finally {
      setBusy(button, false);
    }
  }

  async function runAction(button, busyText, work) {
    setBusy(button, true, busyText);
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
    } finally {
      setBusy(button, false);
    }
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
      await api.post(ORDERS_API.payments, {
        salesEntryRecordId: order.record_id, method, amount: Number(raw), requestId,
      });
      state.pendingRequest = null;
      return `已记一笔收款：${method} ${amount(raw)}。`;
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
    state.container.addEventListener('click', (event) => {
      // 货品选择器（换 / 赔那一块）：点中一行就记下来，再点一次换一双。
      const picker = event.target.closest('[data-product]');
      if (picker) {
        state.newProduct = { recordId: picker.dataset.product, label: picker.dataset.label || '' };
        state.container.querySelectorAll('[data-product]').forEach((item) => item.classList.toggle('active', item === picker));
        renderResult(`已选：${state.newProduct.label}`);
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
      if (action === 'back') return renderList();
      if (action === 'search-product') return searchProduct();
      if (action === 'submit-payment') return submitPayment(trigger);
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
      else loadOrders();
    },
  };
}
