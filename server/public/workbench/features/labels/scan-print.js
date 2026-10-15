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
  // ⭐⭐ 2026-10-15（真机反馈「扫码打印好像没调用成功」）：**只读诊断**上报 ——
  //   飞书 JSSDK 在手机里"装死"时**只有客户端知道原因**（页面上只有一行小字、服务端一条日志都没有 ✗）。
  //   ⇒ 把 phase（config/ready/scan）+ 原因码 + errMsg 报上去，**一条一条进日志** ✓
  //   ⚠️ 它**不写任何业务表**、**不改任何状态**（服务端只 logInfo）✓
  report: '/api/workbench/labels/scan-report',
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
  // ⭐⭐ 2026-10-15：**超时**也必须给人话（改前是 Promise 永挂 ⇒ 按钮一直灰着、既不结束也不报错 ✗）
  timeout: '飞书扫一扫没响应（超时了）：请退出这一页重进再试一次；还不行就用上面「选择编号打印」。',
  // ⭐⭐ 2026-10-15：**失败原因已上报**（她看到人话的同时，我们日志里能查到确切原因 ✓）
  reported: '（已把失败原因记到日志，方便工程师查）',
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

  // ⭐⭐ 2026-10-15：**每个可能永挂的等待都要有超时**（真机实测：`h5sdk.ready` 不回调 ⇒ 她那边
  //   "点了没反应"、按钮一直灰着 ✗）。三个阈值都可配（`options.*Ms`，用例注入小值 ⇒ 不用真等 ✓）。
  const readyTimeoutMs = Number(options.readyTimeoutMs) > 0 ? Number(options.readyTimeoutMs) : 8000;
  const scanTimeoutMs = Number(options.scanTimeoutMs) > 0 ? Number(options.scanTimeoutMs) : 120000;

  /** 给一个 Promise 加超时：**超时按失败处理**（人话 + 上报），绝不永挂 ✓ */
  const withTimeout = (promise, ms, code) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

  /**
   * ⭐⭐ 2026-10-15：把这一趟的结果（成功 / 失败原因）**只读上报**给服务端 ⇒ 日志里查得到 ✓
   *   ⚠️ **fire-and-forget**：上报本身**绝不影响她的操作**、失败也**不抛**（吞掉）✗。
   *   ⚠️ 用 `api.post`（既有客户端）⇒ 带上工作台身份 ✓
   */
  const report = (payload) => {
    try {
      const sending = api.post(SCAN_PRINT_ENDPOINTS.report, payload);
      if (sending && typeof sending.catch === 'function') sending.catch(() => undefined);
    } catch (_) { /* 上报失败绝不影响她 ✓ */ }
  };

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
    await withTimeout(loadJssdk(signature?.jssdkUrl || ''), readyTimeoutMs, 'jssdk_timeout');
    if (!win?.h5sdk?.config) throw new Error('jssdk_missing');
    // ⭐⭐ 2026-10-15：`config` 与 `ready` **都要超时** —— 真机上只要 config 没成，
    //   `ready` 就**永远不回调**（改前 ⇒ 永挂、按钮一直灰、她只看到"没反应" ✗、日志里也没有任何线索 ✗）。
    await withTimeout(
      Promise.resolve(win.h5sdk.config(jsapiConfigOf(signature))), readyTimeoutMs, 'config_timeout',
    );
    await withTimeout(
      new Promise((resolve) => { win.h5sdk.ready(resolve); }), readyTimeoutMs, 'ready_timeout',
    );
    return await withTimeout(new Promise((resolve, reject) => {
      if (!win?.tt?.scanCode) return reject(new Error('scan_unsupported'));
      return win.tt.scanCode({ scanType: ['qrCode'], success: resolve, fail: reject });
    }), scanTimeoutMs, 'scan_timeout');
  };

  /**
   * 跑一次「扫码 ⇒ 打印这一张」。**任何一步失败都给人话、绝不当成功** ✗。
   * 返回队列响应（成功）或 `null`（失败/取消）。
   */
  async function run() {
    if (state.busy) return null;
    state.busy = true;
    // ⭐⭐ 2026-10-15：**每一步都带着"我是哪一步挂的"**（真机看不到控制台 ⇒ 这是唯一的线索来源 ✓）
    let phase = 'signature';
    try {
      notice(texts.scanning);
      const signature = await api.get(signaturePath(win?.location?.href || ''));
      phase = 'config';
      const scanned = await scanOnce(signature);
      const value = scannedValueOf(scanned);
      phase = 'scan';
      if (!value) {
        notice(texts.nothing);
        report({ ok: false, phase: 'scan', reason: 'empty' });
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
      report({ ok: true, phase: 'done', reason: result?.reused ? 'reused' : 'enqueued' });
      return result || null;
    } catch (error) {
      const code = error instanceof Error ? String(error.message || '') : '';
      const errMsg = String((error && error.errMsg) || '');
      const noSdk = ['jssdk_missing', 'jssdk_load_failed', 'scan_unsupported'].includes(code);
      const timedOut = ['jssdk_timeout', 'config_timeout', 'ready_timeout', 'scan_timeout'].includes(code);
      // ⭐⭐ 2026-10-15：**先把线索报上去**（失败/取消/超时都要）—— 手机上她看不到控制台，
      //   这一条是我们唯一能查到"到底卡在哪一步、原因码是什么"的地方 ✓
      //   ⚠️ 上报**不影响她**：fire-and-forget、出错吞掉 ✓
      report({
        ok: false,
        phase,
        reason: timedOut ? code : (code || (/cancel/i.test(errMsg) ? 'cancelled' : 'failed')),
        err_msg: errMsg,
        url: String(win?.location?.href || ''),
      });
      if (noSdk) {
        notice(texts.noSdk);
        return null;
      }
      // ⭐ 超时 ⇒ **必须给人话**（改前是永挂：按钮一直灰着、既不结束也不报错 ✗）
      if (timedOut) {
        notice(`${texts.timeout}${texts.reported}`);
        return null;
      }
      // `tt.scanCode` 的 fail 对象 / 服务端 400 的人话 / 别的网络错 —— 分三种如实说。
      if (error && typeof error === 'object' && (error.errMsg || error.errno !== undefined)) {
        // ⭐⭐ 2026-10-15：**她自己取消**不是失败 ⇒ 不加"已上报"那句（那样读起来像出错了 ✗），
        //   但**仍然上报**（原因码 `cancelled`，用来区分"取消"与"真失败" ✓）。
        notice(/cancel/i.test(errMsg)
          ? scanFailureText(error, texts)
          : `${scanFailureText(error, texts)}${texts.reported}`);
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
