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
// ⭐⭐ 2026-10-16 21:2x（业务负责人五处口径 ⇒ `docs/scan-five-places-2026-10-16.md`）：
//   **这一处在"五处扫一扫登记表"里的那一行** —— ⚠️ 「**扫完回哪 / 带不带之前的数据 / 文案**」
//   一律**从登记表取** ✗ 不在这一页里写死（页面只决定"怎么摆" ✓ 不决定"算不算/带不带" ✗）。
//   ⚠️ 真源是服务端 `src/config/scanEntries.js`；这里是它在浏览器里的**逐字镜像**
//   （`test/scanFivePlaces.test.js` 的 AC-5S3 把两份逐字对比 ⇒ 改一边忘另一边就红）。
import { SCAN_ENTRIES, SCAN_LABEL_PRINT_PLACE } from '../../config/scanEntries.js';

/** ①标签打印在五处登记表里的那一行（`null` = 登记表里没有 ⇒ 这一页**不猜**、不硬弹相机）。 */
export const SCAN_PRINT_PLACE = SCAN_LABEL_PRINT_PLACE;
const PLACE_TEXTS = SCAN_ENTRIES.texts;

/**
 * 这一处的**行为参数**（登记表原样，只读）。
 *   · `returnsToRealm` —— 扫完**回不回当前领域**（① = 不回：扫完就在这一页出结果 ✓）；
 *   · `keepDraft` —— **带不带之前的数据**（① = 不带：标签打印与销售草稿无关 ✓）；
 *   · `mechanism` —— 用哪套（① = `jsapi`：弹飞书相机）；
 *   · `mode` —— `standalone`（不是"领域内扫"）。
 * ⚠️ **别在这一页里再判一次**（那就等于把口径抄成第二份 ✗）。
 */
export const scanPrintPlaceParams = () => ({
  id: SCAN_PRINT_PLACE ? SCAN_PRINT_PLACE.id : '',
  mechanism: SCAN_PRINT_PLACE ? SCAN_PRINT_PLACE.mechanism : '',
  mode: SCAN_PRINT_PLACE ? SCAN_PRINT_PLACE.mode : '',
  returnsToRealm: Boolean(SCAN_PRINT_PLACE && SCAN_PRINT_PLACE.returnsToRealm),
  keepDraft: Boolean(SCAN_PRINT_PLACE && SCAN_PRINT_PLACE.keepDraft),
});

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

/** 页面侧文案（服务端 `texts` 下来时以服务端为准；这一份只是兜底，防"接口没下来时白屏"）。
 *  ⚠️ `button` / `title` **取自五处登记表**（`config/scanEntries.js` ✓ 配置先行）——
 *     今天它们与下面这句逐字相同 ⇒ **行为零变化** ✓。 */
export const SCAN_PRINT_TEXTS = Object.freeze({
  button: PLACE_TEXTS.labelPrintButton,
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
  // ⭐⭐ 2026-10-15：**「只扫码」聚焦页**（`?scan=1` 那条入口）的文案 ——
  //   她真机反馈「整条链路不太友好」之后做的：原来这条入口复用的是**批量打印那一页**
  //   ⇒ 进页先跑一次 `/labels` 查询（真机实测 **23.6 秒**）⇒ 她**先看到批量页干等**、相机才弹 ✗
  title: PLACE_TEXTS.labelPrintTitle,
  subtitle: '对着鞋盒标签上的二维码扫一下 —— 那一张就直接排进店里那台电脑的打印队列，这里不用选编号。',
  scanAgain: '📷 再扫一张',
  batchLink: '要一次打很多张？去「批量打印」→',
  resultPrefix: '✅ 已提交打印：',
  reusedPrefix: '✅ 刚刚已经发过这一张：',
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
      <p class="scan-print-result" data-view="scan-print-result"></p>
      <p class="label-notice" data-view="scan-print-notice"></p>`;

/**
 * ⭐⭐ 2026-10-15：**「只扫码」聚焦页的壳**（`?scan=1` = 「货品 → 标签打印 → 扫码打印」那条入口）。
 *   🔴 它**只有这一块**：标题 + 一颗大按钮 + 结果那一行 + 一条去批量打印的链接 ——
 *     **没有**筛选框 / 预览纸张 / 打印队列（那些是"批量打印"的事，进来会白跑一次 23.6 秒的查询 ✗）。
 *   ⚠️ 要批量打印走下面那条链接（落到**不带** `?scan` 的同一页 = 原来那一页，**一个字节没改** ✓）。
 */
export const scanOnlyShellHtml = () => `
    <section class="panel no-print scan-only">
      <div class="panel-header">
        <div>
          <h2 data-view="scan-title"></h2>
          <p class="subtitle" data-view="scan-subtitle"></p>
        </div>
      </div>
      ${scanPrintBarHtml()}
      <p class="data-caption"><a class="scan-batch-link" href="?" data-action="scan-batch-link"></a></p>
    </section>`;

/**
 * 扫完那一刻给她看的那一行大字（**编号是主角** —— 她要一眼确认"刚才打的是哪一张" ✓）。
 * 拿不到编号就**不编**（只说"这一张"）✗。
 */
export const scanResultText = (result, texts = SCAN_PRINT_TEXTS) => {
  const merged = { ...SCAN_PRINT_TEXTS, ...(texts || {}) };
  const numbers = Array.isArray(result?.numbers) ? result.numbers.filter(Boolean) : [];
  const prefix = result?.reused ? merged.reusedPrefix : merged.resultPrefix;
  return numbers.length ? `${prefix}${numbers.join('、')}` : `${merged.resultPrefix}这一张`;
};

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
  // ⭐⭐ 2026-10-15：**当前走到哪一小步**（signature → loadSdk → config → ready → scanCode → enqueue）
  //   —— 写进上报里 ⇒ 一眼看出卡在哪 ✓（真机实测：只报一个 `config` 分不清是哪一小步 ✗）
  const progress = { step: 'signature' };
  let root = null;

  // ⭐⭐ 2026-10-15：**每个可能永挂的等待都要有超时**（真机实测：`h5sdk.ready` 不回调 ⇒ 她那边
  //   "点了没反应"、按钮一直灰着 ✗）。三个阈值都可配（`options.*Ms`，用例注入小值 ⇒ 不用真等 ✓）。
  const readyTimeoutMs = Number(options.readyTimeoutMs) > 0 ? Number(options.readyTimeoutMs) : 8000;
  const scanTimeoutMs = Number(options.scanTimeoutMs) > 0 ? Number(options.scanTimeoutMs) : 120000;

  /**
   * ⭐⭐ 2026-10-15：**把飞书回的原始内容原样序列化** —— 真机实测它 `config` 失败时
   *   **既不回 `errMsg` 也不回 `message`**（我们只看到"失败"、看不到为什么 ✗）
   *   ⇒ 不管是字符串 / 对象 / Error，一律**原样**带上 ⇒ 下一刀就能看到飞书自己那句话 ✓
   */
  const describeRaw = (error) => {
    if (error === undefined || error === null) return '';
    if (typeof error === 'string') return error;
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    try { return JSON.stringify(error); } catch (_) { return String(error); }
  };

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
  /** 结果那一行大字（聚焦页与批量页**都有**这个节点；批量页上它就是"扫完的确认" ✓） */
  const resultLine = (text) => {
    const element = view('scan-print-result');
    if (element) element.textContent = String(text || '');
  };
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
    progress.step = 'loadSdk';
    await withTimeout(loadJssdk(signature?.jssdkUrl || ''), readyTimeoutMs, 'jssdk_timeout');
    if (!win?.h5sdk?.config) throw new Error('jssdk_missing');
    // ⭐⭐ 2026-10-15：`config` 与 `ready` **都要超时** —— 真机上只要 config 没成，
    //   `ready` 就**永远不回调**（改前 ⇒ 永挂、按钮一直灰、她只看到"没反应" ✗、日志里也没有任何线索 ✗）。
    progress.step = 'config';
    await withTimeout(
      Promise.resolve(win.h5sdk.config(jsapiConfigOf(signature))), readyTimeoutMs, 'config_timeout',
    );
    progress.step = 'ready';
    await withTimeout(
      new Promise((resolve) => { win.h5sdk.ready(resolve); }), readyTimeoutMs, 'ready_timeout',
    );
    progress.step = 'scanCode';
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
    progress.step = 'signature';
    try {
      notice(texts.scanning);
      const signature = await api.get(signaturePath(win?.location?.href || ''));
      const scanned = await scanOnce(signature);
      const value = scannedValueOf(scanned);
      progress.step = 'enqueue';
      if (!value) {
        notice(texts.nothing);
        report({ ok: false, phase: 'scanCode', reason: 'empty' });
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
      // ⭐⭐ 2026-10-15 晚 **成对翻新**（她真机截图：大绿字「✅ 已提交打印：这一张」＋
      //   下面小字**同一句话**又说一遍 ⇒ 同一件事说两遍 ✗）：
      //   改前逐字：`notice(result?.reused ? texts.reused : texts.enqueued);`
      //             `resultLine(scanResultText(result, texts));`
      //   改后逐字：**成功只留大字那一行** —— 小字那行清空（不然还留着"正在打印这一张…"那句旧的），
      //             成功/重复提交的措辞**全在** `scanResultText` 里（`reused` 那支照旧说"刚刚已经发过"✓）
      //   依据：她 2026-10-15 真机截图**两行重复** ✗；判据**没放宽**——成功那句话一条没丢，
      //        只是从"两行"收成"一行（大字）" ✓；失败 / 取消 / 超时 / 没扫到**仍走 `notice(...)`** ✗
      notice('');
      // ⭐⭐ 2026-10-15：**大字结果**（编号是主角）+ 按钮改成「再扫一张」——
      //   她真机反馈"扫完又回到这一页、不知道刚才打了哪张" ⇒ 结果必须**一眼看见** ✓
      //   ⚠️ 编号来自服务端响应里的 `numbers`（`/label-print/jobs` 加的那个字段 ✓ 不编假话 ✗）。
      resultLine(scanResultText(result, texts));
      // ⚠️ 按钮文案**不在这里改**：`runWriteAction` 在动作结束时会**把文案还原成点击前那份**
      //   （它的职责就是"忙完复原"）⇒ 在这里改会被它覆盖掉 ✗ ⇒ 交给 `runWithFeedback` 在**它之后**改 ✓
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
        // ⭐ 精确子步骤：signature / loadSdk / config / ready / scanCode / enqueue ✓
        phase: progress.step,
        reason: timedOut ? code : (code || (/cancel/i.test(errMsg) ? 'cancelled' : 'failed')),
        // ⭐ 飞书自己的话（`errMsg`）+ **原始内容**（它常常两个都不给 ✓）
        err_msg: errMsg,
        raw: describeRaw(error),
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

  /**
   * 跑一次并带上**即时反馈**（按钮置灰 + 换文案 + 防连点），**手动点**与「进页自动弹一次」
   * **两条路都走它**（只有一份实现 ✗ 不各写一份）。
   * ⭐⭐ 2026-10-15：扫成功之后按钮变「再扫一张」—— 这一步**必须写在 `runWriteAction` 之后**
   *   （它结束时会**把按钮文案还原** ⇒ 写在 `run()` 里会被覆盖 ✗；这是用例先红后改发现的 ✓）。
   */
  async function runWithFeedback() {
    const button = pick('scan-print');
    const result = await runWriteAction(button, () => run(), texts.scanning);
    if (result && button) button.textContent = texts.scanAgain;
    return result;
  }

  return {
    state,
    texts,
    run,
    runWithFeedback,
    mount(container) {
      root = container;
      // ⭐⭐ 2026-10-15：聚焦页（`?scan=1`）的标题 / 说明 / "去批量打印"链接文案都在这里填
      //   （批量页上没有这三个节点 ⇒ 一句都不改 ✓）
      const title = view('scan-title');
      if (title) title.textContent = texts.title;
      const subtitle = view('scan-subtitle');
      if (subtitle) subtitle.textContent = texts.subtitle;
      const batchLink = pick('scan-batch-link');
      if (batchLink) batchLink.textContent = texts.batchLink;
      const button = pick('scan-print');
      if (button) {
        button.textContent = texts.button;
        // ⭐ 即时反馈 + 防连点：点了**立刻**置灰 + 换文案（`core/ui.js` 的全仓同一个守卫）。
        // ⭐⭐ 2026-10-15：走 `runWithFeedback` —— 手动点与"进页自动弹"**只有一份实现** ✓
        //   （它多做的事只有一件：成功后把按钮改成「再扫一张」✓）
        button.addEventListener('click', () => runWithFeedback());
      }
      return button;
    },
  };
}

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字：「**可以，给隐藏掉吧**」）：`?scan=1` **「只扫码」聚焦页**上，
 *   **导航胶囊只留「返回完整工作台」**（那是"回家的路"，不许一起藏 ✗），
 *   其余两颗（库存手工调整 / 鞋盒标签打印 —— 后者就是这一页自己）隐藏。
 *
 * ⚠️ **只在 `?scan=1` 这条入口上生效**：标记打在 `<html>` 上，隐藏规则在 `features/labels/labels.css`
 *   （`html[data-scan-only="1"] .standalone-nav [data-nav-scan-only-hide]`）——
 *   **不带 `?scan` 的批量打印页一个字节都不改** ✓（这个属性只有本函数会标）。
 * ⚠️ 用**属性 + CSS**，不是逐个改 `style`、也不是删节点：一处规则管住所有被标记的胶囊，
 *   DOM 结构不动（既有判据照旧：导航条还在、`返回完整工作台` 逐字还在 ✓）。
 */
export const SCAN_ONLY_ATTR = 'data-scan-only';

/** 给 `<html>` 标上"这一屏是只扫码聚焦页"（没有 `document` 时**老实返回 false**，不炸 ✓）。 */
export const markScanOnlyPage = (doc) => {
  const root = doc || (typeof document === 'undefined' ? null : document);
  const element = root?.documentElement;
  if (!element || typeof element.setAttribute !== 'function') return false;
  element.setAttribute(SCAN_ONLY_ATTR, '1');
  return true;
};

/**
 * ⭐⭐ 2026-10-15：**挂载「只扫码」的聚焦页**（`?scan=1` 那条入口）——这是**唯一的编排点**，
 *   `features/labels/index.js` 命中这条入口时**只调它一下就 return**。
 *   🔴 **一个字节的批量逻辑都不碰**：不查 `/labels`、不挂筛选 / 预览纸张 / 打印队列 ——
 *     真机实测原来那次批量查询要 **23.6 秒**（扫 1362 条货品记录），正是"进页先看到批量页干等"的根因 ✗。
 *   ⭐ 它只做四件事：标上"这一屏只扫码"（导航只留回家的路 ⇒ 她要的"隐藏掉" ✓）→ 渲染聚焦壳
 *     → 挂扫码块 → **进页自动弹一次相机** ✓
 *   ⚠️ `autoOpen: false` 供用例关掉自动弹（真机那条路是默认开的）；`doc` 供用例注入假 document。
 */
export const mountScanOnlyPage = (container, scanPrint, options = {}) => {
  markScanOnlyPage(options.doc);
  container.innerHTML = scanOnlyShellHtml();
  const panel = container.querySelector('.panel') || container;
  scanPrint.mount(panel);
  if (options.autoOpen !== false) void scanPrint.runWithFeedback();
  return panel;
};
