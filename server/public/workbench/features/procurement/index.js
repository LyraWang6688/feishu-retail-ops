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
import { buildSuggestedBody, suggestedHtml } from './suggested.js';
import { metaOf as metaOfState, spotSoldOf as spotSoldOfState, syncRow as syncRowState, quantityInput } from './rowHelpers.js';
const DATA_TABS = ['replenish', 'new'];
const TABS = ['suggested', 'pending'];
export function mountProcurementPage(host) {
  if (!host) return undefined;
  host.innerHTML = shellHtml(config);
  const remote = createApi(config);
  const panels = { replenish: createReplenishPanel(config), new: createNewProductsPanel(config) };
  const state = { tab: 'suggested', bodies: {}, errors: {}, loadedAt: {}, supplierId: '' };
  let store = null;
  let draft = null;
  const submitCtl = createSubmitController({ config, api: remote, getStore: () => store });
  const modal = createCustomSizeModal({ host, config });
  const panelEl = (tab) => host.querySelector('[data-pr-panel="' + tab + '"]');
  const setDraft = (next) => { draft = next; submitCtl.renderBottom(host, draft); };
  const mergedBody = () => buildSuggestedBody({ replenishBody: state.bodies.replenish, newBody: state.bodies.new, config });
  const paint = () => {
    const element = panelEl(state.tab);
    if (!element) return;
    if (state.tab === 'pending') { element.innerHTML = pendingListHtml(draft, config, supplierNameMap(state.bodies)); return; }
    const error = state.errors.suggested || state.errors.replenish || state.errors.new;
    if (error) { element.innerHTML = errorHtml(error, config); return; }
    element.innerHTML = state.bodies.replenish && state.bodies.new
      ? suggestedHtml({ body: mergedBody(), draft, store, supplierId: state.supplierId, config })
      : emptyHtml(config.texts.loading);
  };
  const refreshNumbers = () => {
    for (const tab of DATA_TABS) {
      if (!state.bodies[tab] || state.errors[tab]) continue;
      panels[tab].refresh(host, { body: state.bodies[tab], draft, store });
    }
    submitCtl.renderBottom(host, draft);
  };
  const loadData = async (tab, force = false) => {
    if (!force && state.bodies[tab]) return;
    state.errors[tab] = '';
    try {
      const result = await panels[tab].load({ api: remote, store, draft, force });
      state.bodies[tab] = result.body;
      state.loadedAt[tab] = Date.now();
      setDraft(store.pruneSource(result.draft, tab, (result.body.groups || []).map((group) => group.productRecordId)));
    } catch (error) {
      state.errors[tab] = error?.message || config.texts.loadFailed;
    }
  };
  const loadAll = async (force = false) => {
    await Promise.all(DATA_TABS.map((tab) => loadData(tab, force)));
    state.loadedAt.suggested = Date.now();
    paint();
    refreshNumbers();
  };
  const refresher = createRefresher({
    host, config, panels, remote, getStore: () => store, getDraft: () => draft,
    state, setDraft: (next) => setDraft(next), paint, refreshNumbers, submitCtl,
    reload: () => loadAll(true),
  });
  const metaOf = (recordId) => metaOfState(state, recordId);
  const spotSoldOf = (recordId, size) => spotSoldOfState(state, recordId, size);
  const syncRow = (recordId, size) => syncRowState(host, store, draft, recordId, size);
  const applyQuantity = (recordId, size, quantity) => {
    setDraft(store.setQuantity(draft, metaOf(recordId), size, quantity));
    syncRow(recordId, size);
    refreshNumbers();
  };
  const groupOf = (recordId) => (state.bodies.replenish?.groups || []).find((item) => item.productRecordId === recordId)
    || (state.bodies.new?.groups || []).find((item) => item.productRecordId === recordId);
  const activate = async (tab, options = {}) => {
    if (!TABS.includes(tab)) return;
    state.tab = tab;
    const searchWrap = host.querySelector('.pr-search');
    if (searchWrap) searchWrap.hidden = tab === 'pending';
    host.querySelectorAll('[data-pr-tab]').forEach((button) => {
      button.classList.toggle('active', button.dataset.prTab === tab);
    });
    TABS.forEach((id) => panelEl(id)?.classList.toggle('hidden', id !== tab));
    if (tab === 'pending') { paint(); return; }
    if (!state.bodies.replenish || !state.bodies.new) await loadAll(options.force === true);
    else paint();
  };
  host.addEventListener('click', async (event) => {
    const tabButton = event.target.closest('[data-pr-tab]');
    if (tabButton) { search.hide(); await activate(tabButton.dataset.prTab); return; }
    const supplier = event.target.closest('[data-pr-supplier]');
    if (supplier) { search.hide(); state.supplierId = supplier.dataset.prSupplier || ''; paint(); return; }
    const step = event.target.closest('[data-pr-step]');
    if (step) {
      const { record, size } = step.dataset;
      const delta = Number(step.dataset.prStep);
      const current = store.quantityOf(draft, record, Number(size));
      const spot = current === 0 && delta > 0 ? spotSoldOf(record, Number(size)) : 0;
      applyQuantity(record, Number(size), spot > 0 ? spot : current + delta);
      return;
    }
    const addSize = event.target.closest('[data-pr-add-size]');
    if (addSize) {
      const recordId = addSize.dataset.record;
      modal.open(recordId, (id, rows) => {
        const group = groupOf(id);
        const error = customRowsError({ group, draft, recordId: id, rows, store });
        if (error) return { error: error === 'duplicate' ? config.texts.customSizeDuplicate : (error === 'required' ? config.texts.customSizeRequired : config.texts.customSizeInvalid) };
        setDraft(store.addCustomSizes(draft, metaOf(id), rows));
        paint(); refreshNumbers();
        return {};
      });
      return;
    }
    const removeSize = event.target.closest('[data-pr-custom-remove]');
    if (removeSize) {
      setDraft(store.removeCustomSize(draft, metaOf(removeSize.dataset.record), removeSize.dataset.size));
      paint(); refreshNumbers();
      return;
    }
    if (event.target.closest('[data-pr-retry]')) { await loadAll(true); return; }
    if (event.target.closest('[data-pr-refresh]')) { await refresher.refresh(); return; }
    if (event.target.closest('[data-pr-submit]')) {
      if (!customSizesValid({ draft, bodies: state.bodies, tabs: DATA_TABS, store })) {
        submitCtl.toast(host, config.texts.customSizeInvalid); return;
      }
      const result = await submitCtl.submit(host, draft);
      if (result.ok) { setDraft(store.ensure()); paint(); refreshNumbers(); }
    }
  });
  host.addEventListener('input', (event) => {
    const input = event.target.closest('[data-pr-qty]');
    if (input) quantityInput({ input, config, applyQuantity });
  });
  const search = createProcurementSearch({
    host, config,
    getBodies: () => state.bodies,
    ensureLoaded: async () => { await loadAll(false); },
    onSelect: async ({ supplier, record }) => {
      state.supplierId = supplier;
      await activate('suggested');
      requestAnimationFrame(() => host.querySelector('[data-pr-group="' + record + '"]')?.scrollIntoView({ block: 'center' }));
    },
  });
  const start = async () => {
    let user = null;
    try {
      user = await ensureProcurementAuth();
    } catch (error) {
      panelEl('suggested').innerHTML = errorHtml(config.texts.authFailed + describeError(error), config);
      showLoginButton();
      return;
    }
    if (!user) return;
    const openId = String(user.open_id || '');
    if (!openId) { panelEl('suggested').innerHTML = errorHtml(config.texts.loadFailed, config); return; }
    store = createDraftStore({ openId, config });
    setDraft(store.ensure());
    submitCtl.renderBottom(host, draft);
    await activate('suggested');
    refresher.startAuto();
  };
  void start();
  return { activate };
}
