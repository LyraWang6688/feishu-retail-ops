/**
 * 采购页入口（mount/facade）：**只做编排**，不写业务规则。
 *
 *   · 薄壳 `procurement.html` 只引本模块；DOM 结构 / 文案 / 端点全在 render.js + config；
 *   · 补货 / 上新两个 panel 各自负责自己的数据 + 渲染（扫一扫本轮只占位/禁用）；
 *   · 草稿：同一张 localStorage 草稿（key 带 open_id）；切 tab / 刷新 / 关掉重开都保留，
 *     只有**提交成功**才清空（`submit.js`）；
 *   · 懒加载：首屏只请求补货一次；点上新才请求；失败给「重新加载」。
 */
import { api } from '../../core/api-client.js';
import { requireFeishuAuth, showLoginButton } from '../../core/auth.js';
import { describeError } from '../../core/ui.js';
import { PROCUREMENT_UI as config } from '../../config/procurement.js';
import { createApi } from './api.js';
import { createDraftStore, clampQuantity, defaultNewQuantity, defaultReplenishQuantity } from './store.js';
import { shellHtml, errorHtml, emptyHtml } from './render.js';
import { createReplenishPanel } from './replenish.js';
import { createNewProductsPanel } from './newProducts.js';
import { createSubmitController } from './submit.js';

const TABS = ['replenish', 'new'];

export function mountProcurementPage(host) {
  if (!host) return undefined;
  host.innerHTML = shellHtml(config);
  const remote = createApi(config);
  const panels = { replenish: createReplenishPanel(config), new: createNewProductsPanel(config) };
  const submitCtl = createSubmitController({ config, api: remote, getStore: () => store });
  const state = { tab: 'replenish', bodies: {}, errors: {} };
  let store = null;
  let draft = null;

  const panelEl = (tab) => host.querySelector(`[data-pr-panel="${tab}"]`);
  const setDraft = (next) => { draft = next; submitCtl.renderBottom(host, draft); };

  const paint = (tab) => {
    const element = panelEl(tab);
    if (!element) return;
    if (state.errors[tab]) { element.innerHTML = errorHtml(state.errors[tab], config); return; }
    const body = state.bodies[tab];
    element.innerHTML = body
      ? panels[tab].render({ body, draft, store })
      : emptyHtml(config.texts.loading);
  };

  const refreshNumbers = () => {
    for (const tab of TABS) {
      if (!state.bodies[tab] || state.errors[tab]) continue;
      panels[tab].refresh(host, { body: state.bodies[tab], draft, store });
    }
    submitCtl.renderBottom(host, draft);
  };

  const metaOf = (recordId) => {
    for (const tab of TABS) {
      for (const group of state.bodies[tab]?.groups || []) {
        if (group.productRecordId !== recordId) continue;
        return {
          productRecordId: recordId, source: tab, number: group.number,
          itemNo: group.itemNo, color: group.color, supplierRecordId: group.supplierRecordId,
        };
      }
    }
    return { productRecordId: recordId, source: state.tab };
  };

  const rowDefaults = (recordId, size) => {
    for (const group of state.bodies.replenish?.groups || []) {
      if (group.productRecordId !== recordId) continue;
      const row = (group.sizes || []).find((one) => Number(one.size) === Number(size));
      if (row) return defaultReplenishQuantity(row) || Number(row.spotSold) || 1;
    }
    for (const group of state.bodies.new?.groups || []) {
      if (group.productRecordId !== recordId) continue;
      const kind = (group.sizes?.special || []).includes(Number(size)) ? 'special' : 'normal';
      return defaultNewQuantity(kind, config.defaults);
    }
    return 1;
  };

  const syncRow = (recordId, size) => {
    const quantity = store.quantityOf(draft, recordId, size);
    host.querySelectorAll('[data-pr-qty]').forEach((input) => {
      if (input.dataset.record === recordId && Number(input.dataset.size) === Number(size)) {
        input.value = String(quantity);
      }
    });
    host.querySelectorAll('[data-pr-check]').forEach((box) => {
      if (box.dataset.record === recordId && Number(box.dataset.size) === Number(size)) {
        box.checked = quantity > 0;
      }
    });
  };

  const applyQuantity = (recordId, size, quantity) => {
    setDraft(store.setQuantity(draft, metaOf(recordId), size, quantity));
    syncRow(recordId, size);
    refreshNumbers();
  };

  const load = async (tab, force = false) => {
    state.errors[tab] = '';
    if (!force && state.bodies[tab]) { paint(tab); return; }
    paint(tab);
    try {
      const result = await panels[tab].load({ api: remote, store, draft });
      state.bodies[tab] = result.body;
      setDraft(result.draft);
      paint(tab);
      refreshNumbers();
    } catch (error) {
      state.errors[tab] = error?.message || config.texts.loadFailed;
      paint(tab);
    }
  };

  const activate = async (tab, options = {}) => {
    if (!TABS.includes(tab)) return;
    state.tab = tab;
    host.querySelectorAll('[data-pr-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.prTab === tab);
    });
    TABS.forEach((id) => panelEl(id)?.classList.toggle('hidden', id !== tab));
    await load(tab, options.force === true);
  };

  const onQuantityInput = (input) => {
    const { record, size } = input.dataset;
    const value = clampQuantity(input.value === '' ? 0 : input.value, config.defaults.maxQuantity);
    applyQuantity(record, Number(size), value);
    if (input.value !== String(value)) input.value = String(value);
  };

  host.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('[data-pr-tab]');
    if (tabButton) { await activate(tabButton.dataset.prTab); return; }
    const step = event.target.closest('[data-pr-step]');
    if (step) {
      const { record, size } = step.dataset;
      const next = store.quantityOf(draft, record, Number(size)) + Number(step.dataset.prStep);
      applyQuantity(record, Number(size), next);
      return;
    }
    if (event.target.closest('[data-pr-retry]')) { await load(state.tab, true); return; }
    if (event.target.closest('[data-pr-submit]')) {
      const result = await submitCtl.submit(host, draft);
      if (result.ok) { setDraft(store.ensure()); paint(state.tab); refreshNumbers(); }
    }
  });

  host.addEventListener('change', (event) => {
    const box = event.target.closest('[data-pr-check]');
    if (!box) return;
    const { record, size } = box.dataset;
    const quantity = box.checked ? rowDefaults(record, Number(size)) : 0;
    applyQuantity(record, Number(size), quantity);
  });

  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-pr-qty]');
    if (input) onQuantityInput(input);
  });

  const start = async () => {
    let ready = false;
    try {
      ready = await requireFeishuAuth({
        statusElement: host.querySelector('#auth-status'),
        logoutButton: host.querySelector('#logout'),
      });
    } catch (error) {
      panelEl('replenish').innerHTML = errorHtml(`${config.texts.authFailed}${describeError(error)}`, config);
      showLoginButton();
      return;
    }
    if (!ready) return;
    const me = await api.get('/api/auth/feishu/me').catch(() => null);
    const openId = String(me?.user?.open_id || '');
    if (!openId) {
      panelEl('replenish').innerHTML = errorHtml(config.texts.loadFailed, config);
      return;
    }
    store = createDraftStore({ openId, config });
    setDraft(store.ensure());
    submitCtl.renderBottom(host, draft);
    await activate('replenish');
  };
  void start();
  return { activate };
}
