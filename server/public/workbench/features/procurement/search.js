/** 采购页全局货品搜索：跨补货 / 上新、跨供应商，按货号模糊匹配。 */
import { escapeHtml } from '../../core/formatters.js';
import { scanCodeRaw, scanTargetUrl } from '../scan/launch.js';

export const searchResultsOf = (bodies, query) => {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return [];
  const newIds = new Set((bodies?.new?.groups || []).map((group) => group.productRecordId));
  const rows = [];
  for (const [tab, body] of Object.entries(bodies || {})) {
    if (tab === 'replenish') {
      for (const group of body?.groups || []) {
        if (newIds.has(group.productRecordId)) continue;
        if (String(group?.itemNo || '').toLowerCase().includes(text)) rows.push({ tab, group });
      }
      continue;
    }
    for (const group of body?.groups || []) {
      if (String(group?.itemNo || '').toLowerCase().includes(text)) rows.push({ tab, group });
    }
  }
  return rows;
};


/** 搜索选中后把卡头滚到 sticky 头下方；不能居中，否则矮屏上卡片标题会被滚出可视区。 */
export const scrollGroupBelowHeader = (host, record) => {
  requestAnimationFrame(() => {
    const el = host?.querySelector?.('[data-pr-group="' + record + '"]');
    if (!el) return;
    const sticky = host.querySelector('.pr-sticky-head');
    const offset = (sticky?.getBoundingClientRect().height || 0) + 8;
    const top = window.scrollY + el.getBoundingClientRect().top - offset;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
};

/** 扫到的内容 → 采购定位用的 recordId；只认 /r/{recordId}，不猜。 */
export const recordIdFromScanTarget = (target) => {
  try {
    const url = new URL(String(target || ''), 'https://procurement.local');
    const match = url.pathname.match(/^\/r\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : '';
  } catch {
    return '';
  }
};

/** 在当前采购数据里定位 recordId：上新优先，其次补货。 */
export const findGroupByRecordId = (bodies, recordId) => {
  const wanted = String(recordId || '').trim();
  if (!wanted) return null;
  for (const tab of ['new', 'replenish']) {
    const group = (bodies?.[tab]?.groups || []).find((item) => String(item?.productRecordId || '') === wanted);
    if (group) return { tab, group };
  }
  return null;
};

/** 扫码定位后的短暂高亮。 */
export const highlightGroup = (host, record, durationMs = 2500) => {
  const el = host?.querySelector?.('[data-pr-group="' + record + '"]');
  if (!el) return;
  el.classList.add('is-scan-target');
  const timer = setTimeout(() => el.classList.remove('is-scan-target'), Math.max(0, Number(durationMs) || 0));
  el.dataset.prScanHighlight = String(timer);
};

/** 把顶部搜索框接到全局结果面板；数据加载 / 跳转由调用方给。 */
export function createProcurementSearch({ host, config, getBodies, ensureLoaded, onSelect, toast = () => {} }) {
  const input = host?.querySelector('[data-pr-search]');
  const resultsHost = host?.querySelector('[data-pr-search-results-host]');
  let timer = null;
  let requestId = 0;
  const hide = () => { if (resultsHost) { resultsHost.hidden = true; resultsHost.innerHTML = ''; } };
  const clear = () => { if (input) input.value = ''; hide(); };
  const render = (items, loading = false) => {
    if (!resultsHost) return;
    resultsHost.innerHTML = searchResultsHtml(items, config, { loading });
    resultsHost.hidden = false;
  };
  const run = async (query) => {
    const q = String(query || '').trim();
    const seq = ++requestId;
    if (!q) { hide(); return; }
    render([], true);
    try {
      await ensureLoaded();
      if (seq !== requestId) return;
      render(searchResultsOf(getBodies(), q));
    } catch {
      if (seq !== requestId) return;
      render([]);
    }
  };
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value;
    timer = setTimeout(() => { void run(q); }, 150);
  });
  resultsHost?.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-pr-search-result]');
    if (!button) return;
    const result = {
      tab: button.dataset.tab || '',
      supplier: button.dataset.supplier || '',
      record: button.dataset.record || '',
    };
    clear();
    onSelect?.(result);
  });

  const scanButton = host?.querySelector('[data-pr-scan]');
  const scanLabel = config.texts.scan || '扫码';
  let scanning = false;
  const setScanning = (value) => {
    scanning = value;
    if (!scanButton) return;
    scanButton.disabled = value;
    scanButton.textContent = value ? (config.texts.scanning || scanLabel) : scanLabel;
  };
  const scan = async () => {
    if (scanning || !scanButton) return;
    setScanning(true);
    hide();
    try {
      const scanned = await scanCodeRaw(config.scan?.realm || 'procurement');
      const target = scanTargetUrl(scanned, config.scan?.realm || 'procurement');
      const recordId = recordIdFromScanTarget(target);
      if (!recordId) {
        toast(config.texts.scanInvalid || config.texts.scanFailed);
        return;
      }
      await ensureLoaded();
      const hit = findGroupByRecordId(getBodies(), recordId);
      if (!hit) {
        toast(config.texts.scanNotFound || config.texts.searchEmpty);
        return;
      }
      clear();
      await onSelect?.({
        tab: hit.tab,
        supplier: hit.group.supplierRecordId || '',
        record: recordId,
        scanned: true,
      });
    } catch (error) {
      const code = String(error?.message || '');
      const errMsg = String(error?.errMsg || '');
      if (/cancel/i.test(errMsg) || /cancel/i.test(code)) return;
      if (['jssdk_missing', 'jssdk_load_failed', 'scan_unsupported', 'config_timeout', 'ready_timeout'].includes(code)) {
        toast(config.texts.scanUnsupported || config.texts.scanFailed);
      } else {
        toast(config.texts.scanFailed);
      }
    } finally {
      setScanning(false);
    }
  };
  scanButton?.addEventListener('click', () => { void scan(); });
  return { clear, hide, run, scan };
}

export const searchResultsHtml = (results, config, { loading = false } = {}) => {
  if (loading) return `<div class="pr-search-results" data-pr-search-results><p class="pr-search-status">${escapeHtml(config.texts.searchLoading)}</p></div>`;
  if (!results.length) return `<div class="pr-search-results" data-pr-search-results><p class="pr-search-status">${escapeHtml(config.texts.searchEmpty)}</p></div>`;
  return `<div class="pr-search-results" data-pr-search-results>${results.slice(0, 40).map(({ tab, group }) => {
    const supplier = group.supplierName || config.texts.supplierUnassigned;
    return `<button type="button" class="pr-search-result" data-pr-search-result data-tab="${escapeHtml(tab)}" data-supplier="${escapeHtml(group.supplierRecordId || '')}" data-record="${escapeHtml(group.productRecordId || '')}">
      <span class="pr-search-result-main"><b>${escapeHtml(group.itemNo || group.number || '')}</b> · ${escapeHtml(group.color || '')}</span>
      <span class="pr-search-result-meta">${escapeHtml(supplier)}</span>
    </button>`;
  }).join('')}</div>`;
};
