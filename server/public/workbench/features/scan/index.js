/**
 * ⭐⭐ 「扫一扫」—— 工作台**一级 tab、放第一个**（她 2026-10-13 逐字裁定）；**统一走飞书官方 AppLink**。
 *
 * 链路（与扫码页**同一来源** ✓ 不抄第二份）：
 *   ① 取入口信息：`GET /api/workbench/scan-entry` ⇒ `{ appLink, canScan }`
 *      · `appLink` = `config/scanPage.js` 的 `SCAN_NEXT.applink`（`https://applink.feishu.cn/client/qrcode/main`）
 *      · `canScan` = `views/scanPageRenderer.js` 导出的 `canScanNextWithFeishu(req.get('user-agent'))`
 *   ② 能调起来 ⇒ 点一下 = **飞书自己弹扫一扫** ⇒ 扫到标签 ⇒ **飞书打开那个网址**
 *      ⇒ 落点天然是 `/r/{recordId}` 或 `/s/{编号}`（= 扫码页 ✓，与她的口径一致 ✓）
 *   ③ 调不起来（电脑 / 手机自带浏览器 / 没取到）⇒ **不给"点了没反应"的按钮** ✗
 *      ⇒ 收起按钮 + 一句人话 + **手输编号兜底**（不许白屏 ✗）
 *
 * ⚠️ ⚠️ **AppLink 的天然限制**（她 2026-10-13 认可这条限制）：它是"弹飞书扫一扫 ⇒ 飞书打开扫到的网址"，
 *    ⇒ **结果回不到我们页面** ✗。所以：扫货品标签 ⇒ 落到**扫码页** ✓（天然行为 ✓）；
 *    而「验收」里的输入以**手输编号 / 选批次**为主 ✓（将来要在验收里扫 ⇒ 再单独议 ✗）。
 *
 * ⚠️ 本文件只负责"扫一扫"这一屏；**扫码页、验收、服务层一行都不碰** ✓
 */

/** 取「扫一扫」入口信息的接口（AppLink 目标 + 本设备能不能调起来）—— 服务端唯一来源 ✓ */
export const SCAN_ENTRY_PATH = '/api/workbench/scan-entry';

/** 调不起飞书扫一扫时那一句人话（**不许白屏** ✗，也不给死按钮 ✗） */
export const MANUAL_FALLBACK_MESSAGE = '当前不在飞书里，扫码打不开 —— 在下面输入编号也一样能进。';

/** 扫一扫这一屏的 HTML（纯字符串 ⇒ 可直接单测；文案单一来源 = 本文件 ✓）。 */
export function scanPageHtml() {
  return `
    <div class="panel">
      <div class="card" data-view="scan-card">
        <button class="btn primary big" type="button" data-scan-start>打开飞书扫一扫</button>
        <p class="hint" data-scan-hint>对着鞋子标签上的二维码扫一下，飞书就会直接打开那一页。</p>
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
 * ⭐ 按钮该是什么形态（**纯函数 ⇒ 可单测** ✓）：
 * · 能调起来 ⇒ `{ mode: 'applink', href }`
 * · 调不起来 ⇒ `{ mode: 'manual', message }` —— **没有 href**（那就是死按钮 ✗）
 */
export function scanButtonPlan({ canScan, appLink } = {}) {
  if (canScan === true && typeof appLink === 'string' && appLink) return { mode: 'applink', href: appLink };
  return { mode: 'manual', message: MANUAL_FALLBACK_MESSAGE };
}

/** 挂载「扫一扫」：能调 ⇒ 点一下弹飞书扫一扫；不能调 ⇒ 收起按钮 + 人话 + 手输兜底（**不白屏** ✓） */
export function createScanModule() {
  return {
    mount(container) {
      container.innerHTML = scanPageHtml();
      const hint = container.querySelector('[data-scan-unavailable]');
      const button = container.querySelector('[data-scan-start]');
      (async () => {
        let plan = { mode: 'manual', message: MANUAL_FALLBACK_MESSAGE };
        try {
          const response = await globalThis.fetch(SCAN_ENTRY_PATH);
          const payload = await response.json();
          if (payload?.success) plan = scanButtonPlan({ canScan: payload.canScan, appLink: payload.appLink });
        } catch {
          plan = { mode: 'manual', message: MANUAL_FALLBACK_MESSAGE };
        }
        if (plan.mode === 'applink') {
          if (button) {
            button.dataset.applink = plan.href;
            button.addEventListener('click', () => globalThis.window.location.assign(plan.href));
          }
          return;
        }
        if (button) button.classList.add('hidden');
        if (hint) hint.textContent = plan.message;
      })();
    },
  };
}
