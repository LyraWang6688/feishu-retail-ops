/**
 * ⭐⭐「货品 → 标签打印 → **选择编号打印**」那一格 = **可搜索的编号选择器**（她 2026-10-15 逐字：
 *   「编号对呀，我们的编号**只要它在货品信息里就行了**」＋
 *   「这个编号现在有个问题，**是否可以就让用户选择呢？然后它的选项是来自于货品信息里面的编号**」）。
 *
 * 它做的**只有一件事**：把服务端那个只读端点回的编号**列出来让她点**，点中的编号**填进既有那个输入框**。
 *
 * ⚠️ 三条边界（改这一块前先读这三条）：
 *   ① **不造第二份数据源** ✗ —— 选项一律来自服务端（`keyword` 原样传上去，本地不做过滤 / 不缓存成"另一份清单"）；
 *   ② **不新开落点** ✗ —— 选中只是 `input.value = 编号`，跳转仍走**既有表单提交**
 *      （`config/domains.js` 的 `targetTemplate`）⇒ 本文件里**一个字都不提**标签打印页的地址；
 *   ③ **不留死界面** ✗ —— 拉不到 / 超时 / 空的统一出口 = **一句人话 + 输入框照旧能手输**
 *      （她最恨"点了没反应"，见 `config/numberPicker.js` 的文案）。
 *
 * ⚠️ 文案 / 端点 / 条数上限 / 超时**全部在 `config/numberPicker.js`**（配置先行），本文件只负责行为与摆法。
 * ⚠️ 用例把本文件当模块跑（`test/productNumberPicker.test.js`）：所有 DOM 访问都走注入的 `host`
 *    （`querySelector` + `value` / `textContent` / `innerHTML` / `setAttribute` / `addEventListener`），
 *    `api` 也可注入 ⇒ **不碰真网络、不需要真浏览器**。
 */
import { escapeHtml } from '../../core/formatters.js';
import { api as defaultApi } from '../../core/api-client.js';
import { NUMBER_PICKER } from '../../config/numberPicker.js';

/** 这一块的文案（配置为底，允许调用方覆盖 —— 用例注入自己的那几句）。 */
export const pickerTexts = (overrides) => ({ ...NUMBER_PICKER.texts, ...(overrides || {}) });

/** `limit` 收敛到契约区间（1..500，默认 200）—— 换个上限只改配置。 */
export const pickerLimit = (value, config = NUMBER_PICKER) => {
  const max = Number(config.limitMax) > 0 ? Math.floor(Number(config.limitMax)) : 500;
  const fallback = Math.min(max, Math.max(1, Math.floor(Number(config.limit) || 200)));
  const wanted = Math.floor(Number(value));
  if (!Number.isFinite(wanted) || wanted <= 0) return fallback;
  return Math.min(max, Math.max(1, wanted));
};

/**
 * 只读端点的地址（**契约唯一真源在 `config/numberPicker.js`**）：
 * `GET {endpoint}?keyword=<str>&limit=<1..500>` —— 没输关键字就**不带 keyword**（= 全量前 N 条）。
 */
export const pickerNumbersUrl = (keyword, config = NUMBER_PICKER) => {
  const params = new URLSearchParams();
  const trimmed = String(keyword ?? '').trim();
  if (trimmed) params.set('keyword', trimmed);
  params.set('limit', String(pickerLimit(config.limit, config)));
  return `${config.endpoint}?${params.toString()}`;
};

/** 选项的副标题（`货号 · 颜色 · 类别`；与主标题重复的段落不重复写）。 */
export const pickerOptionSub = (item) => {
  const number = String(item?.number ?? '').trim();
  return [item?.itemNo, item?.color, item?.category]
    .map((part) => String(part ?? '').trim())
    .filter((part) => part && part !== number)
    .filter((part, index, list) => list.indexOf(part) === index)
    .join(' · ');
};

/**
 * 选项列表的 HTML —— 每个选项是一个**真按钮**（`type="button"`：不会误提交表单；手机上 ≥44px 命中区，
 * 见 `features/domains/domains.css`），`data-number` 就是选中时要填进输入框的**编号原文**。
 * `hasStock === false` 的选项自己带一个「还没入库」小标签（她 2026-10-15 的口径）。
 */
export const pickerOptionsHtml = (numbers, config = NUMBER_PICKER) => {
  const texts = pickerTexts(config.texts);
  const list = (Array.isArray(numbers) ? numbers : [])
    .filter((item) => String(item?.number ?? '').trim());
  return list.map((item) => {
    const number = String(item.number).trim();
    const sub = pickerOptionSub(item);
    const tag = item.hasStock === false
      ? `<span class="tag tag-warning number-option-tag">${escapeHtml(texts.optionNoStock)}</span>`
      : '';
    return `<li class="number-option" role="none">`
      + `<button class="number-option-button" type="button" role="option" data-number="${escapeHtml(number)}">`
      + `<span class="number-option-main">${escapeHtml(number)}</span>`
      + (sub ? `<span class="number-option-sub">${escapeHtml(sub)}</span>` : '')
      + tag
      + '</button></li>';
  }).join('');
};

/**
 * 那**一行**状态字（她的三种情形各有各的人话）：
 *   · 选中了 ⇒ 有库存 / 还没入库（她 2026-10-15 的"尺码行不印"口径）；
 *   · 正在拉 / 拉失败 / 没匹配到 ⇒ 都是人话，且后两者明说"还能手输"。
 */
export const pickerStatusText = (state = {}, config = NUMBER_PICKER) => {
  const texts = pickerTexts(config.texts);
  if (state.picked) {
    if (state.picked.hasStock === false) return texts.noStock;
    if (state.picked.hasStock === true) return texts.pickedOk;
    return texts.picked;
  }
  if (state.loading) return texts.loading;
  if (state.failed) return texts.failed;
  if (state.loaded && state.count > 0) return String(texts.ready).replace('{count}', String(state.count));
  if (state.loaded) return texts.empty;
  return texts.idle;
};

/** 给一个 Promise 加超时：**超时按失败处理**（人话 + 仍可手输），绝不永挂 ✗。 */
const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('numbers_timeout')), ms);
  Promise.resolve(promise).then(
    (value) => { clearTimeout(timer); resolve(value); },
    (error) => { clearTimeout(timer); reject(error); },
  );
});

/**
 * 这一块的控制器。`options` 全部可注入（`api` / `config` / `texts` / `timeoutMs`）⇒ 用例不碰真网络。
 * 返回 `{ mount, load, state, texts }`；`mount(host)` 返回**首次拉取**的 Promise（用例好等）。
 */
export function createNumberPicker(options = {}) {
  const api = options.api || defaultApi;
  const config = options.config || NUMBER_PICKER;
  const texts = pickerTexts(options.texts || config.texts);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : Number(config.timeoutMs) || 8000;
  const state = { loading: false, failed: false, loaded: false, count: 0, picked: null };

  let input = null;
  let optionsHost = null;
  let statusHost = null;
  /** 当前这批选项（编号 ⇒ 服务端回的那一条）—— 只存**这一次**服务端回来的，不在本地造清单。 */
  let items = new Map();
  /** 请求序号：她连着打字时，**只有最后那一次**算（过期的回包丢掉，免得选项跳来跳去）。 */
  let seq = 0;

  const renderStatus = () => {
    if (statusHost) statusHost.textContent = String(pickerStatusText(state, config));
  };

  const setExpanded = (expanded) => {
    if (input) input.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };

  /**
   * 拉一次选项（`keyword` 原样交给服务端）。
   * 失败 / 超时 / 空**都不抛**：落到 status 那一句人话上，输入框照旧能手输。
   */
  async function load(keyword) {
    const my = ++seq;
    state.loading = true;
    state.picked = null;
    setExpanded(false);
    if (optionsHost) optionsHost.setAttribute('aria-busy', 'true');
    renderStatus();
    if (!api || typeof api.get !== 'function') {
      state.loading = false;
      state.failed = true;
      if (optionsHost) optionsHost.setAttribute('aria-busy', 'false');
      renderStatus();
      return state;
    }
    try {
      const data = await withTimeout(api.get(pickerNumbersUrl(keyword, config)), timeoutMs);
      if (my !== seq) return state; // 过期回包：丢掉（最后那一次才算）
      const numbers = Array.isArray(data?.numbers) ? data.numbers : [];
      items = new Map(numbers
        .filter((item) => String(item?.number ?? '').trim())
        .map((item) => [String(item.number).trim(), item]));
      state.loading = false;
      state.failed = false;
      state.loaded = true;
      state.count = items.size;
      if (optionsHost) {
        optionsHost.innerHTML = pickerOptionsHtml(numbers, config);
        optionsHost.setAttribute('aria-busy', 'false');
      }
      setExpanded(items.size > 0);
    } catch (error) {
      if (my !== seq) return state;
      state.loading = false;
      state.failed = true;
      state.loaded = false;
      state.count = 0;
      items = new Map();
      if (optionsHost) {
        optionsHost.innerHTML = '';
        optionsHost.setAttribute('aria-busy', 'false');
      }
      setExpanded(false);
    }
    renderStatus();
    return state;
  }

  /** 选中一个编号：填进**既有**输入框 + 说一句它有没有库存（跳转仍走既有表单提交 ✗ 不在这里跳）。 */
  function pick(number) {
    const key = String(number ?? '').trim();
    if (!key) return state;
    const item = items.get(key);
    state.picked = item || { number: key };
    if (input) input.value = key;
    setExpanded(false);
    renderStatus();
    return state;
  }

  return {
    state,
    texts,
    load,
    pick,
    mount(host) {
      input = host?.querySelector ? host.querySelector('input[name="number"]') : null;
      optionsHost = host?.querySelector ? host.querySelector('[data-view="number-options"]') : null;
      statusHost = host?.querySelector ? host.querySelector('[data-view="number-status"]') : null;
      // 不是"编号选择器"那一格（例：别的入口页没配 `numberPicker`）⇒ **老实退场**，一个字节都不改。
      if (!input || !optionsHost || !statusHost) return Promise.resolve(state);

      input.setAttribute('role', 'combobox');
      input.setAttribute('aria-autocomplete', 'list');
      input.setAttribute('aria-expanded', 'false');
      input.setAttribute('autocomplete', 'off');
      const listId = optionsHost.getAttribute('id');
      if (listId) input.setAttribute('aria-controls', listId);
      optionsHost.setAttribute('role', 'listbox');
      optionsHost.setAttribute('aria-label', String(config.aria?.listLabel || ''));

      // 输入即搜（关键字**交给服务端**过滤）；聚焦时**只在上次没拉到时**补一次（免得一点就一串请求）。
      input.addEventListener('input', () => load(input.value));
      input.addEventListener('focus', () => (state.loaded ? undefined : load(input.value)));
      input.addEventListener('keydown', (event) => {
        if (event?.key === 'Escape') setExpanded(false);
      });
      // 点选项 ⇒ 填进输入框（`closest` 兼容"点到里面那层 span"）。
      optionsHost.addEventListener('click', (event) => {
        const option = event?.target?.closest ? event.target.closest('[data-number]') : null;
        if (!option) return;
        pick(option.dataset?.number);
      });

      state.loaded = false;
      return load(String(input.value || ''));
    },
  };
}
