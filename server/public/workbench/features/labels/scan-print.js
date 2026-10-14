/**
 * 「**扫码打印**」—— 点一下 ⇒ 弹飞书**原生扫一扫**（JSAPI，**不是跳外链** ✗）⇒
 * 扫到的那一张标签**直接排进既有打印队列**（店里那台电脑出纸）⇒ 页面上给一句明确结果。
 *
 * 依据（**都在文件里**，不是偏好）：
 *   · 业务负责人 2026-10-14 晚选了 **ⓐ**「扫完**直接打印这一张**」
 *     ⇒ `docs/scan-to-print-jsapi-2026-10-14.md`（AC-SP7：JSAPI ✓ 不是跳外链 ✗ / 点了必须有即时反馈）；
 *   · 她 2026-10-12（逐字）：「**我们是能够进行动态交互的**」
 *     ⇒ 页面**允许 JS**（"零 JS"是我方 agent 侧的老约束，**不是她的口径**，不许再拿它当理由 ✗）。
 *
 * ⚠️ 三条边界：
 *   ① **不新开打印接口** ✗ —— 走的就是既有 `POST /api/workbench/label-print/jobs`
 *      （`SCAN_PRINT_ENDPOINTS.jobs` 是唯一出口，有源码哨兵钉着）；
 *   ② **形状真源在服务端** —— 页面**只把扫到的字符串原样交上去**；解析成记录 ID 那件事由
 *      `services/labelPrintService.js` 的 `parseLabelScanUrl` 做（与 `buildLabelScanUrl` 一对反函数）。
 *      页面**不抄第二份 URL 模板**（抄了就会两边慢慢走歪 ✗）；认不出来时服务端回**可操作的人话**，
 *      页面只负责把它显示出来。
 *   ③ **文案走配置**（`config/labelPrintQueue.js` 的 `texts` 随 `/status` 下来 + 这里一份兜底）；
 *      按钮命中区 **≥44px**（CSS：`.scan-print-bar .btn`）。
 */
import { describeError, runWriteAction } from '../../core/ui.js';

/** 两个端点（**唯一真源**；AC-SP6 的源码哨兵钉的就是这里）。 */
export const SCAN_PRINT_ENDPOINTS = Object.freeze({
  signature: '/api/workbench/lark/jsapi-signature',
  // ⭐ **既有**队列接口（与扫码页同一把队列 / 同一个 `/jobs`）——**不新开打印接口** ✗
  jobs: '/api/workbench/label-print/jobs',
});

/** 页面侧文案（服务端 `texts` 下来时以服务端为准；这一份只是兜底，防"接口没下来时白屏"）。 */
export const SCAN_PRINT_TEXTS = Object.freeze({
  button: '📷 扫码打印',
  scanning: '正在唤起扫一扫…',
  printing: '正在打印这一张…',
  noSdk: '这台设备调不起飞书扫一扫：请在**飞书里**打开工作台，再点一次。',
  cancelled: '取消了扫码，没有打印任何东西。',
  failed: '扫码没有成功，请再试一次。',
  enqueued: '✅ 已提交打印：这一张',
  reused: '刚刚已经发过这一张（没有重复提交）',
  nothing: '没有扫到内容，请对着标签上的二维码再扫一次。',
});

/** 签名请求的地址：**页面地址原样带上**（签名必须与页面 URL 逐字一致，服务端只去掉 `#fragment`）。 */
export const signaturePath = (pageUrl) => `${SCAN_PRINT_ENDPOINTS.signature}?url=${encodeURIComponent(String(pageUrl || ''))}`;

/**
 * `h5sdk.config` 的入参 —— **只有服务端下来的那四样**（`appId/timestamp/nonceStr/signature`）
 * ＋ `jsApiList`；页面**不夹带任何密钥**（服务端本来就不下发 ✗）。
 */
export const jsapiConfigOf = (signature = {}) => ({
  appId: signature.appId,
  timestamp: signature.timestamp,
  nonceStr: signature.nonceStr,
  signature: signature.signature,
  jsApiList: Array.isArray(signature.jsApiList) && signature.jsApiList.length
    ? signature.jsApiList
    : ['scanCode'],
});

/** `tt.scanCode` 成功对象 ⇒ 扫到的字符串（官方：`{ result, errMsg }`）。 */
export const scannedValueOf = (result) => String(result?.result ?? '').trim();

/** 扫码失败 ⇒ 人话（**她自己取消**与"真失败"要分得开 —— 取消不是错误）。 */
export const scanFailureText = (fail, texts = SCAN_PRINT_TEXTS) => {
  const merged = { ...SCAN_PRINT_TEXTS, ...(texts || {}) };
  const message = String(fail?.errMsg || '');
  return /cancel/i.test(message) ? merged.cancelled : merged.failed;
};

/** `?scan=1` = 从「货品 → 标签打印 → 扫码打印」那一格进来的 ⇒ 进页面就直接弹扫一扫（一次）。 */
export const wantsScanFromSearch = (search) => {
  try {
    return new URLSearchParams(String(search || '')).get('scan') === '1';
  } catch {
    return false;
  }
};

/** 这一块的外壳（按钮 + 结果那一行）。文案**由 JS 填**，这里不写死。 */
export const scanPrintBarHtml = () => `
      <div class="label-queue-bar scan-print-bar" data-view="scan-print-bar">
        <button class="btn btn-primary" type="button" data-action="scan-print"></button>
      </div>
      <p class="label-notice" data-view="scan-print-notice"></p>`;

/**
 * 这一块的控制器。`options` 全部可注入（用例用假 api / 假 `h5sdk`，**不碰真网络**）。
 * 返回 `{ mount, run, state }`。
 */
export function createScanPrintAction(options = {}) {
  const api = options.api;
  const doc = options.doc || (typeof document === 'undefined' ? null : document);
  const win = options.win || (typeof window === 'undefined' ? null : window);
  const texts = { ...SCAN_PRINT_TEXTS, ...(options.texts || {}) };
  const state = { busy: false };
  let root = null;

  const pick = (name) => (root ? root.querySelector(`[data-action="${name}"]`) : null);
  const view = (name) => (root ? root.querySelector(`[data-view="${name}"]`) : null);
  const notice = (text) => {
    const element = view('scan-print-notice');
    if (element) element.textContent = String(text || '');
  };

  /** 按需引入飞书 JSSDK（地址由服务端配置下发 —— 页面不抄第二份 ✗）。 */
  const loadJssdk = (url) => new Promise((resolve, reject) => {
    if (win?.h5sdk) return resolve();
    if (!url || !doc) return reject(new Error('jssdk_missing'));
    const script = doc.createElement('script');
    script.src = String(url);
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('jssdk_load_failed'));
    doc.head.append(script);
    return undefined;
  });

  /** 真正的扫一扫：`config` ⇒ `ready` ⇒ `tt.scanCode`（官方链路，全在客户端）。 */
  const scanOnce = async (signature) => {
    await loadJssdk(signature?.jssdkUrl || '');
    if (!win?.h5sdk?.config) throw new Error('jssdk_missing');
    await win.h5sdk.config(jsapiConfigOf(signature));
    await new Promise((resolve) => { win.h5sdk.ready(resolve); });
    return await new Promise((resolve, reject) => {
      if (!win?.tt?.scanCode) return reject(new Error('scan_unsupported'));
      return win.tt.scanCode({ scanType: ['qrCode'], success: resolve, fail: reject });
    });
  };

  /**
   * 跑一次「扫码 ⇒ 打印这一张」。**任何一步失败都给人话、绝不当成功** ✗。
   * 返回队列响应（成功）或 `null`（失败/取消）。
   */
  async function run() {
    if (state.busy) return null;
    state.busy = true;
    try {
      notice(texts.scanning);
      const signature = await api.get(signaturePath(win?.location?.href || ''));
      const scanned = await scanOnce(signature);
      const value = scannedValueOf(scanned);
      if (!value) {
        notice(texts.nothing);
        return null;
      }
      notice(texts.printing);
      // ⭐ **既有队列接口**（不新开打印接口 ✗）：服务端按形状解析 ⇒ **只排这一张**。
      const result = await api.post(SCAN_PRINT_ENDPOINTS.jobs, {
        mode: 'single',
        scan: value,
        // 一次扫码 = 一次提交意图（同一把幂等键 ⇒ 连点也只建一个任务）。
        submit_key: options.submitKey ? String(options.submitKey()) : `${Date.now()}`,
      });
      notice(result?.reused ? texts.reused : texts.enqueued);
      return result || null;
    } catch (error) {
      if (error instanceof Error && ['jssdk_missing', 'jssdk_load_failed', 'scan_unsupported'].includes(error.message)) {
        notice(texts.noSdk);
        return null;
      }
      // `tt.scanCode` 的 fail 对象 / 服务端 400 的人话 / 别的网络错 —— 分三种如实说。
      if (error && typeof error === 'object' && (error.errMsg || error.errno !== undefined)) {
        notice(scanFailureText(error, texts));
        return null;
      }
      notice(error && typeof error === 'object' && 'message' in error ? describeError(error) : String(error ?? ''));
      return null;
    } finally {
      state.busy = false;
    }
  }

  return {
    state,
    texts,
    run,
    /**
     * 跑一次并带上**即时反馈**（按钮置灰 + 换文案 + 防连点）——
     * 手动点按钮与"`?scan=1` 进页面自动弹一次"两条路都走它（**只有一份实现** ✗ 不各写一份）。
     */
    runWithFeedback() {
      const button = pick('scan-print');
      return runWriteAction(button, () => run(), texts.scanning);
    },
    mount(container) {
      root = container;
      const button = pick('scan-print');
      if (button) {
        button.textContent = texts.button;
        // ⭐ 即时反馈 + 防连点：点了**立刻**置灰 + 换文案（`core/ui.js` 的全仓同一个守卫）。
        button.addEventListener('click', () => runWriteAction(button, () => run(), texts.scanning));
      }
      return button;
    },
  };
}
