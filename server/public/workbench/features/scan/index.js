/**
 * ⭐⭐ 「扫一扫」= 工作台**一级 tab、放最前**（她 2026-10-13）；**点它就等于点了飞书扫一扫**。
 *
 * 她 2026-10-13 真机口径（逐字）：
 *   「现在的界面有点冗余，我希望**点了 Tab 页的扫一扫，就直接能调用飞书的镜头**。
 *    不用在我点了扫一扫之后，再去弹提示说'去飞书扫一扫'，而是**直接点扫一扫就能调出摄像头**。」
 *
 * ⭐ 我选的做法（两种里选**第二种**，原因见下）：
 *   · ①「tab 直接是外链」✗ 做不到：工作台 tab 是**面板切换**机制
 *     （`main.js` 的 `button.main-tab[data-module]` + `activateModule`，既有测试钉着这个机制），
 *     tab 不能既是外链又是面板。
 *   · ② ⭐ **进入该面板后立刻自动触发一次** AppLink 跳转 —— 她原话里的"或"就是这条 ✓
 *     ⇒ 点击效果 = 直接弹摄像头 ✓（**不再有"去飞书扫一扫"那一屏** ✓）
 *   · 目标仍取 `config/scanPage.js` 的 `SCAN_NEXT.applink`（**同源** ✗ 不抄第二份），
 *     `canScan` 仍由服务端 UA 判据 `canScanNextWithFeishu` 给（**同源** ✓）
 *
 * ⚠️ 两条护栏（都必须有）：
 *   ① **只自动跳一次、不循环**：跳之前打一个"本会话已自动跳过"的记号；她回到这一屏时
 *      **不再自动跳** ✗，改给一颗手动按钮 + 手输编号（否则会被弹出去出不来 ✗）。
 *   ② **非飞书 / 取不到入口 ⇒ 一屏明白话 + 手输编号**（**不许白屏** ❌）。
 *
 * ⚠️ 本文件只负责"扫一扫"这一屏；**扫码页、验收、服务层一行都不碰** ✓
 */

/** 取「扫一扫」入口信息的接口（AppLink 目标 + 本设备能不能调起来）—— 服务端唯一来源 ✓ */
export const SCAN_ENTRY_PATH = '/api/workbench/scan-entry';

/** 本会话"已经自动跳过"的记号键（防循环 ✓） */
export const SCAN_AUTO_FLAG_KEY = 'workbench.scan.autoTriggered';

/** 调不起飞书扫一扫时那一句人话（**不许白屏** ✗，也不给死按钮 ✗） */
export const MANUAL_FALLBACK_MESSAGE = '当前不在飞书里，扫码打不开 —— 在下面输入编号也一样能进。';

/** 这一屏的 HTML（**只有兜底形态**才显示按钮；能自动跳时她看不到这一屏 ✓） */
export function scanPageHtml() {
  return `
    <div class="panel">
      <div class="card" data-view="scan-card">
        <button class="btn primary big hidden" type="button" data-scan-start>打开飞书扫一扫</button>
        <p class="hint hidden" data-scan-hint>对着鞋子标签上的二维码扫一下，飞书就会直接打开那一页。</p>
        <p class="hint hidden" data-scan-unavailable>${MANUAL_FALLBACK_MESSAGE}</p>
      </div>
      <form class="card" data-entry-form data-target-template="/s/{number}">
        <label class="hint" for="scan-manual-number">手输编号</label>
        <input id="scan-manual-number" name="number" type="text" inputmode="numeric" autocomplete="off" placeholder="例如 66133-17">
        <button class="btn" type="submit">打开</button>
      </form>
    </div>`;
}

/**
 * ⭐ 这一屏该怎么动（**纯函数 ⇒ 可单测** ✓）：
 * · `{ mode: 'auto', href }` —— **进面板立刻弹摄像头**（只一次 ✓）
 * · `{ mode: 'manual', appLink }` —— 已经自动跳过一次了 ⇒ **不循环** ✗：给一颗手动按钮
 * · `{ mode: 'fallback', message }` —— 非飞书 / 取不到 ⇒ 一屏人话 + 手输（**不白屏** ❌）
 */
export function scanEntryPlan({ canScan, appLink, alreadyTriggered } = {}) {
  const usable = canScan === true && typeof appLink === 'string' && appLink.length > 0;
  if (!usable) return { mode: 'fallback', message: MANUAL_FALLBACK_MESSAGE };
  if (alreadyTriggered === true) return { mode: 'manual', appLink };
  return { mode: 'auto', href: appLink };
}

/** 进面板 ⇒ 能自动跳就**立刻**跳（并打记号，防循环）；否则给兜底那一屏 ✓ */
export function createScanModule(options = {}) {
  const fetchImpl = options.fetchImpl || ((...args) => globalThis.fetch(...args));
  const storage = options.storage || globalThis.sessionStorage;
  const navigate = options.navigate || ((url) => globalThis.window.location.assign(url));
  return {
    mount(container) {
      container.innerHTML = scanPageHtml();
      const button = container.querySelector('[data-scan-start]');
      const hint = container.querySelector('[data-scan-hint]');
      const unavailable = container.querySelector('[data-scan-unavailable]');
      const showManualButton = (href) => {
        if (!button) return;
        button.classList.remove('hidden');
        button.dataset.applink = href;
        button.addEventListener('click', () => navigate(href));
      };
      (async () => {
        let plan = { mode: 'fallback', message: MANUAL_FALLBACK_MESSAGE };
        try {
          const response = await fetchImpl(SCAN_ENTRY_PATH);
          const payload = await response.json();
          const alreadyTriggered = Boolean(storage && storage.getItem(SCAN_AUTO_FLAG_KEY));
          if (payload?.success) plan = scanEntryPlan({ canScan: payload.canScan, appLink: payload.appLink, alreadyTriggered });
        } catch {
          plan = { mode: 'fallback', message: MANUAL_FALLBACK_MESSAGE };
        }
        if (plan.mode === 'auto') {
          // ⭐ 只一次：先打记号再跳（她回来时不会又被弹走 ✓）
          try { storage?.setItem(SCAN_AUTO_FLAG_KEY, String(Date.now())); } catch { /* 存不了就退化成"可能再跳一次"，不致命 */ }
          navigate(plan.href);
          return;
        }
        if (plan.mode === 'manual') {
          showManualButton(plan.appLink);
          hint?.classList.remove('hidden');
          return;
        }
        if (button) button.classList.add('hidden');
        if (unavailable) unavailable.classList.remove('hidden');
      })();
    },
  };
}
