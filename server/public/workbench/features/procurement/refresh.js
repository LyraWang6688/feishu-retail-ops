/**
 * 采购页「实时刷新」：页面停留期间按配置间隔自动刷新（默认 60s）+ 手动「刷新」按钮 + 重新可见时补一次。
 *
 * 🔴 三条纪律：
 *   ① 刷新**不覆盖她的已选**：草稿里已改的数量保留，只补新增行（`seedDefaults` 只补不覆盖）；
 *   ② 刷新后**清掉已消失的已选行**（`pruneSource`）—— 防提交到页面上已经看不到的货品；
 *   ③ 刷新失败**不白屏**：保留当前数据 + 一条提示；提交进行中不刷新（避免打断）。
 */
export const createRefresher = ({
  host, config, panels, remote, getStore, getDraft, state, setDraft, paint, refreshNumbers, submitCtl,
}) => {
  let busy = false;
  const buttonOf = () => host.querySelector('[data-pr-refresh]');

  const refresh = async () => {
    if (busy) return;
    const button = buttonOf();
    if (button) { button.disabled = true; button.textContent = config.texts.refreshing; }
    busy = true;
    const tab = state.tab;
    try {
      const store = getStore();
      const result = await panels[tab].load({ api: remote, store, draft: getDraft(), force: true });
      state.bodies[tab] = result.body;
      state.loadedAt[tab] = Date.now();
      setDraft(store.pruneSource(result.draft, tab, (result.body.groups || []).map((group) => group.productRecordId)));
      paint(tab);
      refreshNumbers();
      submitCtl.toast(host, config.texts.refreshed);
    } catch (error) {
      // 静默失败会让人以为"数据没变"；这里如实提示，但保留当前数据（不白屏）
      submitCtl.toast(host, error?.message || config.texts.loadFailed);
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = config.texts.refresh; }
    }
  };

  /** 启动自动刷新（`config.refresh.autoMs = 0` ⇒ 关掉；只刷新当前可见 tab）。 */
  const startAuto = () => {
    if (config.refresh.autoMs > 0) {
      setInterval(() => {
        if (document.visibilityState !== 'visible') return;
        if (host.querySelector('[data-pr-submit]')?.disabled) return; // 提交中不刷
        refresh();
      }, config.refresh.autoMs);
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const last = state.loadedAt[state.tab] || 0;
      if (Date.now() - last >= config.refresh.visibilityRefreshMs) refresh();
    });
  };

  return { refresh, startAuto };
};
