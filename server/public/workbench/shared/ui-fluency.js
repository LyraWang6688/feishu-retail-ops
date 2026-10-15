// ⭐⭐ 2026-10-15（task-48 · 埋点 a/c/d「前端流畅性 / 404+JS 报错入口 / "看着像坏了"的动作」）
//
// 她最看重的第 1 点就是「**前端交互的流畅性**」，而她的原话是「**方便我们的排查**」✓
// ⇒ 这里只做一件事：把"她点了一下、页面多久给出结果 / 中间有没有卡在骨架 / 卡片有没有整块跳变 /
//    有没有 404 或 JS 报错 / 进了哪个 realm、展开了哪个表单"这些**事实**变成**能 grep 的一条条日志**。
//
// 🔴 三条纪律（照既有 `config/uiTap.js` 的口径，一个都不许破）：
//   ① **只记我们的标识**（`fluency:skeleton` / `fluency:card_swap` / `fluency:error` …）
//      —— **绝不采集表单值 / 客户姓名 / 电话 / 身份证 / 金额** ✗（见 `sanitizeFluencyPayload` 的白名单）；
//   ② **不新造事件名** ✗：新事实**复用既有那一套**（同一端点 `/api/workbench/ui-tap`、同一 `tap_id` 关联键），
//      用 `target` 的命名空间 `fluency:` 区分 ⇒ **服务端一行都不用改** ✓
//      （要独立事件名，得动 `src/config/uiTap.js` + 路由 —— 不在本任务写作用域，已写进体检表「未实施/为什么」✓）；
//   ③ 客户端**只报事实**，判"算不算慢/算不算跳变"的**阈值**在配置里（`config/telemetry.js`）✓
//
// ⚠️ 纯函数与 DOM 包装**分开**：`sanitizeFluencyPayload` / `makeFluencyFacts` / `createFluencyTracker`
//    都是纯的（可注入 `now` / `doc`）⇒ 用例能真红，不需要真浏览器 ✓

/** 上报时 `target` 的命名空间（服务端不认事件名，只把这串当"她点了什么"的标识 ✓）。 */
export const FLUENCY_PREFIX = 'fluency:';

/** 允许进日志的键（**白名单**：不在里面的一律丢掉 ⇒ 隐私进不去 ✗）。 */
export const FLUENCY_ALLOWED_KEYS = Object.freeze([
  'target', 'tap_id', 'since_ms', 'page', 'ms', 'phase', 'status', 'path', 'realm', 'form', 'count', 'level',
]);

/** 只留 `origin + pathname`：**query 一律丢掉**（编号/关键字/客户信息都有可能藏在里面 ✗）。 */
export const safePath = (raw) => {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, 'https://placeholder.invalid');
    return url.pathname || '/';
  } catch (error) {
    return text.split('?')[0].split('#')[0].slice(0, 120);
  }
};

/** 摘要：截断 + 去掉 query + 去掉换行（**不保留任何值**：只有名字与一句话）。 */
export const safeSummary = (raw, limit = 120) =>
  String(raw ?? '').replace(/\s+/g, ' ').split('?')[0].slice(0, limit);

/**
 * 白名单净化：**只有** `FLUENCY_ALLOWED_KEYS` 里的键能进 payload，值一律转字符串并截断。
 * `path` 额外只留 origin+pathname；空值**不出现**（与 `correlationFields` 的"去空"同一口径 ✓）。
 */
export const sanitizeFluencyPayload = (input, limit = 160) => {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of FLUENCY_ALLOWED_KEYS) {
    const value = input[key];
    if (value === undefined || value === null) continue;
    if (key === 'path') {
      const path = safePath(value);
      if (path) out.path = path.slice(0, limit);
      continue;
    }
    const text = String(value).trim();
    if (!text) continue;
    out[key] = text.slice(0, limit);
  }
  return out;
};

/**
 * 流畅性事实 → 一条能 grep 的 payload（**纯函数**，用例直接喂数字）。
 * · `skeletonMs`：进骨架 → 骨架被换掉，停留了多久（**沉默停留**的量化 ✓）
 * · `cardSwaps`：这一屏卡片被**整块替换**了几次（"先出现一个配品再换表单"那类 ✗ 的量化 ✓）
 */
export const makeFluencyFacts = ({ target, skeletonMs = null, cardSwaps = 0, slowMs = 1000, ...rest }) => {
  const facts = { ...rest, target: `${FLUENCY_PREFIX}${target}` };
  if (Number.isFinite(skeletonMs) && skeletonMs >= 0) {
    facts.ms = String(Math.round(skeletonMs));
    facts.phase = 'skeleton';
    // ⭐ 阈值**只用来打标**（`level: slow`），不改事实：她照着过滤 `level:slow` 就能一眼挑出慢的 ✓
    if (slowMs > 0 && skeletonMs > slowMs) facts.level = 'slow';
  }
  if (cardSwaps > 0) {
    facts.count = String(cardSwaps);
    facts.phase = facts.phase || 'card_swap';
  }
  return sanitizeFluencyPayload(facts);
};

/**
 * 一个 session 内的流畅性记录器（**纯**：`now` 可注入）。
 * 它**不自己发请求** —— 发不发由调用方注入的 `post` 决定（用例传假件即可断言"发了什么" ✓）。
 */
export const createFluencyTracker = ({ post = () => {}, now = () => Date.now(), slowMs = 1000, page = 'workbench' } = {}) => {
  let skeletonShownAt = null;
  let cardSwaps = 0;
  const facts = { cardSwaps: 0, skeletonDwells: [], errors: 0, realms: [], forms: [] };

  const send = (target, extra = {}) => {
    const payload = makeFluencyFacts({ target, slowMs, page, ...extra });
    post(payload);
    return payload;
  };

  return {
    facts,
    skeletonShown() { skeletonShownAt = now(); },
    /** 骨架被真内容替掉 ⇒ 记**停留时长**（没有"进过骨架"就不报：如实、不编 ✗）。 */
    skeletonReplaced(label = 'replaced') {
      if (skeletonShownAt === null) return null;
      const dwell = now() - skeletonShownAt;
      skeletonShownAt = null;
      facts.skeletonDwells.push(dwell);
      // ⚠️ 传 `skeletonMs`（不是 `ms`）：`makeFluencyFacts` 由它算 `ms` 与 `level:slow` ✓
      return send('skeleton', { skeletonMs: dwell, phase: label });
    },
    /** 卡片**整块替换**了一次（正常渲染不算；只有"先画一半、再换掉"才算 ✗）。 */
    cardSwapped(next) {
      cardSwaps += 1;
      facts.cardSwaps = cardSwaps;
      return send('card_swap', { count: cardSwaps, phase: next || 'render' });
    },
    /** 进了哪个 realm（"看着像坏了"第一现场：她点进去看到了什么 ✓）。 */
    realmEntered(realm) {
      facts.realms.push(realm);
      return send('realm', { realm });
    },
    /** 某个表单被展开（今晚那颗退货按钮就是这一类 ✗ ⇒ 至少能看出"她点开了、页面给了什么" ✓）。 */
    formRevealed(form, count = 1) {
      facts.forms.push(form);
      return send('form', { form, count });
    },
    /** 前端 404 / JS 报错：**统一入口**（她说的"方便排查"就靠这条 ✓）。 */
    uiError({ level = 'error', status = '', path = '', summary = '' } = {}) {
      facts.errors += 1;
      return send('error', { level, status, path, phase: safeSummary(summary) });
    },
  };
};

/**
 * 装上三个全局观察者（**只读、不改业务** ✗）：
 *   ① `window.onerror` / `unhandledrejection` ⇒ 一条 `fluency:error`；
 *   ② `fetch` 包装 ⇒ 任何 **404/5xx** 一条 `fluency:error`（**URL 只留 pathname**）；
 *   ③ 点击：既有 `data-tap-target` 那套照旧（`shared/ui-tap.js` 管），这里**只补**上面两类 ✓。
 */
export const installFluencyObservers = ({ tracker, win = (typeof window !== 'undefined' ? window : null) } = {}) => {
  if (!tracker || !win) return () => {};
  const onError = (event) => tracker.uiError({
    level: 'error',
    summary: (event && (event.message || (event.error && event.error.message))) || 'window.onerror',
    path: safePath((win.location && win.location.pathname) || ''),
  });
  const onRejection = (event) => tracker.uiError({
    level: 'error',
    summary: (event && event.reason && (event.reason.message || String(event.reason))) || 'unhandledrejection',
    path: safePath((win.location && win.location.pathname) || ''),
  });
  win.addEventListener?.('error', onError);
  win.addEventListener?.('unhandledrejection', onRejection);

  const originalFetch = win.fetch;
  let restore = () => {};
  if (typeof originalFetch === 'function') {
    win.fetch = async (...args) => {
      const response = await originalFetch.apply(win, args);
      if (response && (response.status === 404 || response.status >= 500)) {
        tracker.uiError({ level: 'error', status: String(response.status), path: safePath(args[0] && (args[0].url || args[0])) });
      }
      return response;
    };
    restore = () => { win.fetch = originalFetch; };
  }
  return () => {
    win.removeEventListener?.('error', onError);
    win.removeEventListener?.('unhandledrejection', onRejection);
    restore();
  };
};
