/**
 * 「销售 → 订单列表 → 交割单」页（三子 tab）的门面：只做 mount / 状态 / 事件。
 *
 * 分层：
 *   · `data.js`   —— 样例数据 + 归一化（**零网络请求**；字段映射在 config）
 *   · `filter.js` —— 货没清 / 钱没清 / 并集 + 订单归类（纯函数）
 *   · `items.js`  —— 归类后的订单 → 三个 tab 的**逐条事项**（纯函数）
 *   · `sort.js`   —— 销售日旧→新 / 新→旧（纯函数）
 *   · `render.js` —— 三个子 tab、逐条紧凑卡、空/加载/失败态
 *   · `actions.js`—— 行尾交付按钮 / 付款预览表单 UI（**不提交写库**）
 *   · `format.js` —— 文本 / 日期 / 金额格式化（纯函数）
 *
 * 🔴 本文件不写死文案 / tab 顺序 / 状态 / 字段名 —— 全部来自 `config/sales-delivery.js`。
 */

import { api } from '../../core/api-client.js';
import { describeError } from '../../core/ui.js';
import {
  SALES_DELIVERY_CONFIG, SALES_DELIVERY_DEFAULT_TAB, SALES_DELIVERY_FIELDS,
  SALES_DELIVERY_STATUSES, SALES_DELIVERY_TABS, SALES_DELIVERY_TEXTS,
} from '../../config/sales-delivery.js';
import { fetchDeliveryData } from './data.js';
import { buildDeliveryGroups, filterItemsByProduct } from './filter.js';
import { buildTabItems } from './items.js';
import { groupItemsBySoldDate } from './group.js';
import { sortDeliveryGroups } from './sort.js';
import { openPaymentModal, closePaymentModal, validatePaymentAmount } from './payment-modal.js';
import { showToast, requestId } from './ui-feedback.js';
import { renderPage } from './render.js';

const CONFIG = SALES_DELIVERY_CONFIG;
const FIELDS = SALES_DELIVERY_FIELDS;
const STATUSES = SALES_DELIVERY_STATUSES;
const TABS = SALES_DELIVERY_TABS;
const T = SALES_DELIVERY_TEXTS;

/** 当前 tab：货号筛选 → 固定销售日远→近排序 → 按销售日分组。 */
const viewState = (state) => {
  const filtered = filterItemsByProduct(state.itemsByTab[state.activeTab] || [], state.productFilter);
  const sorted = sortDeliveryGroups(filtered, CONFIG.sortDirection);
  return { ...state, groups: groupItemsBySoldDate(sorted, T.soldAtMissing) };
};

export function mountSalesDeliveryPage(container) {
  const state = {
    orders: [],
    itemsByTab: {},
    methods: [],
    activeTab: SALES_DELIVERY_DEFAULT_TAB,
    productFilter: '',
    loading: false,
    error: '',
  };
  let host = null;

  document.title = CONFIG.pageTitle;

  function render() {
    if (!host) return;
    const view = viewState(state);
    // 业务负责人 2026-10-29 批注：tab 数字按**明细数（双）**统计，不是卡片数。
    const counts = Object.fromEntries(TABS.map((tab) => [tab.key,
      (state.itemsByTab[tab.key] || []).reduce((total, item) => total + (item.details || []).length, 0)]));
    const products = [...new Set((state.itemsByTab[state.activeTab] || [])
      .flatMap((item) => (item.details || []).map((line) => line.product).filter(Boolean)))].sort();
    host.innerHTML = renderPage({ ...view, counts, products }, CONFIG, T, STATUSES, TABS);
  }

  /** 打开 / 刷新页面时拉一次；不做定时刷新。 */
  async function load() {
    if (state.loading) return;
    state.loading = true;
    state.error = '';
    render();
    try {
      const data = await fetchDeliveryData(api, CONFIG, FIELDS);
      state.methods = data.methods;
      state.orders = data.orders;
      state.itemsByTab = buildTabItems(
        buildDeliveryGroups(data.orders, STATUSES),
        STATUSES,
        TABS,
      );
      state.error = '';
    } catch (error) {
      state.error = describeError(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  container.innerHTML = '<main data-sd-host></main>';
  host = container.querySelector('[data-sd-host]');

  /** 预览交付：本轮只改前端状态 + toast；真正写库存/销售明细待接写库接口。 */
  const busy = new Set();

  async function postDelivery(salesEntryRecordId, detailRecordId, button) {
    const key = `delivery:${detailRecordId}`;
    if (!salesEntryRecordId || !detailRecordId || busy.has(key)) return;
    busy.add(key);
    button.disabled = true;
    try {
      await api.post('/api/workbench/sales/deliveries', {
        salesEntryRecordId, detailRecordIds: [detailRecordId],
      });
      showToast(T.deliveryToast);
      await load();
    } catch (error) {
      showToast(describeError(error));
    } finally {
      busy.delete(key);
      button.disabled = false;
    }
  }

  let paymentCard = null;

  async function postPayment(card, amountText, method, confirmButton) {
    const key = `payment:${card?.dataset.sdEntry || ''}`;
    if (!card || busy.has(key)) return;
    busy.add(key);
    confirmButton.disabled = true;
    try {
      await api.post('/api/workbench/sales/delivery/payments', {
        salesEntryRecordId: card.dataset.sdEntry,
        amount: String(amountText || '').replace(/[^\d.]/g, ''),
        method,
        requestId: requestId(),
      });
      closePaymentModal(container);
      paymentCard = null;
      showToast(T.paymentToast);
      await load();
    } catch (error) {
      showToast(describeError(error));
    } finally {
      busy.delete(key);
      confirmButton.disabled = false;
    }
  }

  container.addEventListener('click', (event) => {
    if (event.target.closest('[data-sd-action="retry"]')) {
      void load();
      return;
    }
    const deliver = event.target.closest('[data-sd-deliver]');
    if (deliver) {
      const card = deliver.closest('[data-sd-entry]');
      void postDelivery(card?.dataset.sdEntry || '', String(deliver.dataset.sdDeliver || ''), deliver);
      return;
    }
    if (event.target.closest('[data-sd-modal-close]')) {
      closePaymentModal(container);
      paymentCard = null;
      return;
    }
    const confirm = event.target.closest('[data-sd-modal-confirm]');
    if (confirm) {
      const modal = confirm.closest('[data-sd-modal]');
      const amountInput = modal?.querySelector('[data-sd-modal-amount]');
      if (!validatePaymentAmount(amountInput, paymentCard, T)) return;
      void postPayment(paymentCard,
        modal?.querySelector('[data-sd-modal-amount]')?.value,
        modal?.querySelector('[data-sd-modal-method]')?.value,
        confirm);
      return;
    }
    const toggle = event.target.closest('[data-sd-toggle="payment"]');
    if (toggle) {
      paymentCard = toggle.closest('[data-sd-entry]');
      openPaymentModal(container, paymentCard, T);
      return;
    }
    const tab = event.target.closest('[data-sd-tab]');
    if (tab && TABS.some((item) => item.key === tab.dataset.sdTab)) {
      state.activeTab = tab.dataset.sdTab;
      // 切 tab 时重置货号筛选（业务负责人 2026-10-29 定）。
      state.productFilter = '';
      render();
    }
  });
  container.addEventListener('input', (event) => {
    if (event.target.matches('[data-sd-modal-amount]')) validatePaymentAmount(event.target, paymentCard, T);
  });
  container.addEventListener('change', (event) => {
    if (event.target.matches('[data-sd-field="product"]')) {
      state.productFilter = String(event.target.value || '');
      render();
    }
  });
  void load();
}
