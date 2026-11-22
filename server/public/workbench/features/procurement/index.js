import { showLoginButton } from '../../core/auth.js';
import { ensureProcurementAuth } from './auth.js';
import { describeError } from '../../core/ui.js';
import { PROCUREMENT_UI as config } from '../../config/procurement.js';
import { createApi } from './api.js';
import { createDraftStore } from './store.js';
import { shellHtml, errorHtml, emptyHtml } from './render.js';
import { createReplenishPanel } from './replenish.js';
import { createNewProductsPanel } from './newProducts.js';
import { createSubmitController } from './submit.js';
import { createRefresher } from './refresh.js';
import { customSizesValid, customRowsError } from './customSize.js';
import { createCustomSizeModal } from './customSizeModal.js';
import { pendingListHtml, supplierNameMap } from './pending.js';
import { createProcurementSearch } from './search.js';
import { metaOf as metaOfState, spotSoldOf as spotSoldOfState, syncRow as syncRowState, quantityInput } from './rowHelpers.js';
const DATA_TABS = ['replenish', 'new'];
const TABS = [...DATA_TABS, 'pending'];
export function mountProcurementPage(host) {
  if (!host) return undefined;
  host.innerHTML = shellHtml(config);
  const remote = createApi(config);
  const panels = { replenish: createReplenishPanel(config), new: createNewProductsPanel(config) };
  const state = { tab: 'replenish', bodies: {}, errors: {}, loadedAt: {}, suppliers: { replenish: '', new: '' } };
  let store = null;
  let draft = null;
  const submitCtl = createSubmitController({ config, api: remote, getStore: () => store });
  const modal = createCustomSizeModal({ host, config });
  const panelEl = (tab) => host.querySelector(`[data-pr-panel="${tab}"]`);
  const setDraft = (next) => { draft = next; submitCtl.renderBottom(host, draft); };
  const paint = (tab) => {
    const element = panelEl(tab);
    if (!element) return;
    if (tab === 'pending') { element.innerHTML = pendingListHtml(draft, config, supplierNameMap(state.bodies)); return; }
    if (state.errors[tab]) { element.innerHTML = errorHtml(state.errors[tab], config); return; }
    const body = state.bodies[tab];
    element.innerHTML = body
      ? panels[tab].render({ body, draft, store, supplierId: state.suppliers[tab] })
      : emptyHtml(config.texts.loading);
  };
  const refreshNumbers = () => {
    for (const tab of DATA_TABS) {
      if (!state.bodies[tab] || state.errors[tab]) continue;
      panels[tab].refresh(host, { body: state.bodies[tab], draft, store });
    }
    submitCtl.renderBottom(host, draft);
  };
  const refresher = createRefresher({
    host, config, panels, remote, getStore: () => store, getDraft: () => draft,
    state, setDraft: (next) => setDraft(next), paint, refreshNumbers, submitCtl,
  });
  const metaOf = (recordId) => metaOfState(state, recordId);
  const spotSoldOf = (recordId, size) => spotSoldOfState(state, recordId, size);
  const syncRow = (recordId, size) => syncRowState(host, store, draft, recordId, size);
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
      const result = await panels[tab].load({ api: remote, store, draft, force });
      state.bodies[tab] = result.body;
      state.loadedAt[tab] = Date.now();
      // 刷新后：已不在数据里的「已选行」要清掉（防提交到页面上已看不到的货品）
      setDraft(store.pruneSource(result.draft, tab, (result.body.groups || []).map((group) => group.productRecordId)));
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
    const searchWrap = host.querySelector('.pr-search');
    if (searchWrap) searchWrap.hidden = tab === 'pending';
    host.querySelectorAll('[data-pr-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.prTab === tab);
    });
    TABS.forEach((id) => panelEl(id)?.classList.toggle('hidden', id !== tab));
    if (tab === 'pending') { paint(tab); return; }
    await load(tab, options.force === true);
  };
  host.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('[data-pr-tab]');
    if (tabButton) { search.hide(); await activate(tabButton.dataset.prTab); return; }
    const supplier = event.target.closest('[data-pr-supplier]');
    if (supplier) {
      search.hide();
      state.suppliers[state.tab] = supplier.dataset.prSupplier || '';
      paint(state.tab);
      return;
    }
    const step = event.target.closest('[data-pr-step]');
    if (step) {
      const { record, size } = step.dataset;
      const delta = Number(step.dataset.prStep);
      const current = store.quantityOf(draft, record, Number(size));
      // 没有勾选框：从 0 往上加 = "选中" —— 现货行按业务口径先给「现货已售数」，其它行给 1
      const spot = current === 0 && delta > 0 ? spotSoldOf(record, Number(size)) : 0;
      applyQuantity(record, Number(size), spot > 0 ? spot : current + delta);
      return;
    }
    const addSize = event.target.closest('[data-pr-add-size]');
    if (addSize) {
      const recordId = addSize.dataset.record;
      const group = (state.bodies[state.tab]?.groups || []).find((item) => item.productRecordId === recordId);
      modal.open(recordId, (id, rows) => {
        const currentGroup = (state.bodies[state.tab]?.groups || []).find((item) => item.productRecordId === id);
        const error = customRowsError({ group: currentGroup || group, draft, recordId: id, rows, store });
        if (error) return { error: error === 'duplicate' ? config.texts.customSizeDuplicate : (error === 'required' ? config.texts.customSizeRequired : config.texts.customSizeInvalid) };
        setDraft(store.addCustomSizes(draft, metaOf(id), rows));
        paint(state.tab);
        refreshNumbers();
        return {};
      });
      return;
    }
    const removeSize = event.target.closest('[data-pr-custom-remove]');
    if (removeSize) {
      const recordId = removeSize.dataset.record;
      setDraft(store.removeCustomSize(draft, metaOf(recordId), removeSize.dataset.size));
      paint(state.tab);
      refreshNumbers();
      return;
    }
    if (event.target.closest('[data-pr-retry]')) { await load(state.tab, true); return; }
    if (event.target.closest('[data-pr-refresh]')) { await refresher.refresh(); return; }
    if (event.target.closest('[data-pr-submit]')) {
      if (!customSizesValid({ draft, bodies: state.bodies, tabs: DATA_TABS, store })) {
        submitCtl.toast(host, config.texts.customSizeInvalid); return;
      }
      const result = await submitCtl.submit(host, draft);
      if (result.ok) { setDraft(store.ensure()); paint(state.tab); refreshNumbers(); }
    }
  });
  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-pr-qty]');
    if (input) quantityInput({ input, config, applyQuantity });
  });
  const search = createProcurementSearch({
    host, config,
    getBodies: () => state.bodies,
    ensureLoaded: async () => {
      if (!state.bodies.replenish) await load('replenish');
      if (!state.bodies.new) await load('new');
    },
    onSelect: async ({ tab, supplier, record }) => {
      state.suppliers[tab] = supplier;
      await activate(tab);
      requestAnimationFrame(() => host.querySelector(`[data-pr-group="${record}"]`)?.scrollIntoView({ block: 'center' }));
    },
  });
  const start = async () => {
    let user = null;
    try {
      // 只取身份，不渲染登录 UI（页面顶部没有登录态，对照交割单页）
      user = await ensureProcurementAuth();
    } catch (error) {
      panelEl('replenish').innerHTML = errorHtml(`${config.texts.authFailed}${describeError(error)}`, config);
      showLoginButton();
      return;
    }
    if (!user) return;
    const openId = String(user.open_id || '');
    if (!openId) {
      panelEl('replenish').innerHTML = errorHtml(config.texts.loadFailed, config);
      return;
    }
    store = createDraftStore({ openId, config });
    setDraft(store.ensure());
    submitCtl.renderBottom(host, draft);
    await activate('replenish');
    // 实时性：页面停留期间按配置间隔自动刷新 + 手动「刷新」按钮；重新可见时也补一次
    refresher.startAuto();
  };
  void start();
  return { activate };
}
