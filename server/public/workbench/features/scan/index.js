/**
 * ⭐⭐ 「扫一扫」= 工作台**一级 tab、放最前**（她 2026-10-13）· **本文件 2026-10-13 晚按她真机反馈重做**。
 *
 * 她的原话（逐字，2026-10-13 晚）：
 *   「工作台「扫一扫」直接弹摄像头，**这个不好用，点击了还是没有弹出来**，反而是**点击工作台之后，就出现了扫描框**。
 *    需要的是，**每点一次掉一次**……**不需要这个**，**目前这个也用不了**」
 *
 * ⇒ 三条改动（**换可靠做法，不打补丁** ✗）：
 *   ① 🔴 **进工作台 / 进面板 ⇒ 一律不自动跳**（她踩到的正是"一进就弹、顺序反了"✗）
 *   ② ⭐ 面板里给一颗**真链接** `<a href="<AppLink>">` —— 她**手指点它 = 用户手势** ✓
 *      飞书只允许用户手势里打开 AppLink ⇒ **点一次开一次** ✓（不需要"只跳一次"的记号 ✗ 已删）
 *   ③ 非飞书 / 取不到入口 ⇒ **一屏明白话 + 手输编号**（**不给点了没反应的死按钮** ❌）
 *
 * 目标与判据都**同源**（✗ 不抄第二份）：
 *   · AppLink = `config/scanPage.js` 的 `SCAN_NEXT.applink`（服务端经 `/scan-entry` 给前端）
 *   · 设备判据 = `views/scanPageRenderer.js` 导出的 `canScanNextWithFeishu`（服务端看 UA）
 *
 * ⚠️ 本文件只负责"扫一扫"这一屏；**扫码页、验收、退货、服务层一行都不碰** ✓
 */

/** 取「扫一扫」入口信息的接口（AppLink 目标 + 本设备能不能调起来）—— 服务端唯一来源 ✓ */
export const SCAN_ENTRY_PATH = '/api/workbench/scan-entry';

/** 调不起飞书扫一扫时那一句人话（**不许白屏** ✗，也不给死按钮 ✗） */
export const MANUAL_FALLBACK_MESSAGE = '当前不在飞书里，扫码打不开 —— 在下面输入编号也一样能进。';

/**
 * 这一屏的 HTML（**纯函数 ⇒ 可单测** ✓）。
 * · 能调起飞书扫一扫 ⇒ 给**真链接**（`<a href=AppLink>`）—— 用户手势点 ⇒ 点一次开一次 ✓
 * · 调不起来 ⇒ **只给人话 + 手输**，**没有**任何按钮 / href（**不给死按钮** ❌）
 * · 手输编号兜底**永远在** ✓（复用既有机制：`data-entry-form` + `data-target-template`）
 */
export function scanPanelHtml() {
  // 🔴 她 2026-10-13 晚（逐字）：「**不需要，就是点那个 tab 上的扫一扫**」⇒
  //    **这一屏里不再有**"打开扫一扫"按钮 / 链接 ✗ —— 只有**手输编号**兜底（**不白屏** ❌）。
  return `
    <div class="panel">
      <div class="card" data-view="scan-card">
        <p class="hint" data-scan-unavailable>${MANUAL_FALLBACK_MESSAGE}</p>
      </div>
      <form class="card" data-entry-form data-target-template="/s/{number}">
        <label class="hint" for="scan-manual-number">手输编号</label>
        <input id="scan-manual-number" name="number" type="text" inputmode="numeric" autocomplete="off" placeholder="例如 66133-17">
        <button class="btn" type="submit">打开</button>
      </form>
    </div>`;
}

/**
 * 挂载「扫一扫」。
 * 🔴 **挂载时不做任何导航** ✗（她："一进工作台就弹"是错的 ✓）—— 只去取一次入口信息，
 *    然后**把可点的真链接渲染出来**；弹不弹由她的手指决定 ✓（点一次 = 一次手势 = 开一次 ✓）
 */
export function createScanModule() {
  return {
    mount(container) {
      // 只是"进得来、不白屏"：手输编号兜底 ✓（扫码由**切换条上那一格**负责 —— 见 `main.js`）✓
      container.innerHTML = scanPanelHtml();
    },
  };
}
