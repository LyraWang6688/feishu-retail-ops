/**
 * **打印任务队列** —— 这条链路的大脑：把"她要打什么"变成一条能被电脑取走的任务，
 * 并如实记住它现在到哪一步了。
 *
 * 业务负责人 2026-10-11 的口径（唯一权威）：
 *   · 「这个打印小助手，**不一定会常开着机**，需要打标签的时候才会开，所以**可以做事件触发吗**？」
 *   · ⇒ **事件触发**：入队那一刻**立刻**唤醒正在长连接等着的小助手（`subscribe` → SSE），
 *         **不是**每 2-3 秒轮询；**电脑没开时**任务就**排队保留**，小助手一启动**先补拉**。
 *   · ⇒ **在线状态**：小助手的心跳写在这里（`heartbeat`），手机据此显示在线 / 未连接。
 *   · ⇒ **幂等**：同一任务绝不重复打印 —— 服务端这道是"认领 + 认领超时才能重投"，
 *         小助手那道是"本地已打印 id 台账"（崩溃重投时不重打）。**两道缺一不可**。
 *
 * ⚠️ **本文件不懂"标签长什么样"**：
 *   · "印什么" 来自 `services/labelPrintService.js`（只读「实时库存」+「货品信息」）；
 *   · "长什么样" 来自 `services/labelPrintArtifactService.js`（SVG → PNG/PDF）；
 *   · 本文件只负责"**排到哪了**"：入队 → 落盘产物 → 认领 → 回执 → 心跳 → 状态 → 补打。
 *
 * ⚠️ **产物在入队时冻结**：她点打印那一刻就把 PDF 画好落盘 ⇒ 之后库存怎么变都不影响这一批
 *    （"我点了打印，出来的就应该是我点的时候看到的那几张"）。代价是库存变了要**重新提交**——
 *    这是有意的：静默换成"现在"的数据比"多打一次"更让人措手不及。
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { STATES, SOURCES } = require('../config/labelPrintQueue');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { logInfo, logWarn } = require('../utils/logger');
const { renderLabels, normalizeRotation, normalizeCanvas } = require('./labelPrintArtifactService');

/** 她填错 / 业务上做不到 ⇒ 400，原因原样回页面（与工作台其它写接口同一套口径）。 */
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });
/** 系统这一侧出了问题（产物渲染失败、文件写不进去）⇒ 502/500。 */
const systemError = (message) => Object.assign(new Error(message), { statusCode: 502 });

const ISO = (ms) => new Date(ms).toISOString();

/**
 * 编成一个能写进任务记录的"输入规格"——**补打与排障都靠它**。
 *   · `single`：按**编号**（`货号|颜色|类别`）打一款；
 *   · `single` + `recordId`：⭐ 2026-10-14「**扫码打印**」—— 按**记录 ID 精确一张**
 *     （`labelPrintService.labelForRecord` 把记录 ID 解成恰好那一张标签）；
 *   · `batch` ：按筛选条件（与标签打印页同一个 `listLabels` 的入参）打一批。
 * ⚠️ 新增的 `recordId` 是**并列的一种 single**（不是新 mode、不是新接口 ✗）——
 *    既有 `number` 那条请求的形状与语义**一个字都没改**。
 */
const normalizeRequest = (input = {}) => {
  const mode = String(input.mode || '').trim();
  if (mode === 'single') {
    // ⭐ 「扫码打印」：记录 ID 优先（它比编号更准 —— 编号是会变的快照）。
    const recordId = String(input.recordId || '').trim();
    if (recordId) return { mode: 'single', recordId };
    const number = String(input.number || '').trim();
    if (!number) throw userError('缺少「编号」（货号|颜色|类别）');
    return { mode: 'single', number };
  }
  if (mode === 'batch') {
    return {
      mode: 'batch',
      filters: {
        keyword: String(input.filters?.keyword ?? '').trim(),
        state: String(input.filters?.state ?? '').trim(),
        category: String(input.filters?.category ?? '').trim(),
        size: String(input.filters?.size ?? '').trim(),
        recentDays: String(input.filters?.recentDays ?? '').trim(),
        sort: String(input.filters?.sort ?? '').trim(),
      },
    };
  }
  throw userError('打印请求的 mode 只能是 single（按编号）或 batch（按条件）');
};

/**
 * 一份请求的**内容指纹**（连点去重用）—— 与"她点了什么"一一对应：
 *   · `single`：`single|编号`（同编号 = 同一款 = 同一份请求）；
 *   · `batch` ：`batch|` + 固定字段顺序的筛选条件（**顺序固定**，否则同样的条件会算出两个键）。
 * ⚠️ 键里**不含时间/用户**：她连点的那几次必须算出同一个键（不然去重就白做了）。
 * ⚠️ **含打印方向**（`rotate`）：试方向时"打 90°"和"打 270°"是**两件事**，
 *    不能被防连点窗口认成同一次提交（否则她试第二张会被"没有重复提交"挡住，白等）。
 */
const requestKeyOf = (request, rotate, canvas) => {
  const suffix = `${rotate === undefined || rotate === null ? '' : `|rotate=${rotate}`}`
    + `${canvas === undefined || canvas === null ? '' : `|canvas=${canvas}`}`;
  if (request.mode === 'single') {
    // ⭐ 「扫码打印」按记录 ID：`single|record:<id>`（与按编号的键**互不串** ⇒ 两张不同的纸）。
    return request.recordId
      ? `single|record:${request.recordId}${suffix}`
      : `single|${request.number}${suffix}`;
  }
  const filters = request.filters || {};
  const ordered = ['keyword', 'state', 'category', 'size', 'recentDays', 'sort']
    .map((name) => `${name}=${String(filters[name] ?? '').trim()}`)
    .join('&');
  return `batch|${ordered}${suffix}`;
};

const createLabelPrintQueueService = (deps = {}) => {
  if (!deps.store) throw new Error('LabelPrintQueueService requires store');
  if (!deps.labelPrint) throw new Error('LabelPrintQueueService requires labelPrint');
  const store = deps.store;
  const labelPrint = deps.labelPrint;
  // 产物渲染器可注入：用例要能造出"渲染失败"这种真实故障（sharp 本身很少失败，但不代表不会）。
  const render = deps.renderLabels || renderLabels;
  const config = deps.config || {};
  const now = deps.now || (() => Date.now());
  const idFactory = deps.idFactory || (() => crypto.randomUUID());
  const artifactConfig = config.artifact || {};
  const states = config.states || STATES;

  // SSE 订阅者（每个长连接一个；小助手断开时自己摘掉）。
  const subscribers = new Set();
  // ⭐ 连点去重的**并发闸门**：同一个 `request_key`/`submit_key` 的"再查一次 + 建任务"串行执行
  //   （两个一模一样的 POST 同时到达时，只有一个会真的建任务）。
  const enqueueLock = new KeyedSerialQueue();
  // 每台电脑最后一次心跳（内存即可：服务重启后"未连接"是**如实**的，小助手下一次 ping 就补上）。
  const devices = new Map();
  let lastCleanupAt = 0;

  /** 一个任务 → 给它订阅者 / 页面看的摘要（**不含产物字节**，只有引用与状态）。 */
  const summaryOf = (job) => (job ? {
    job_id: job.job_id,
    status: job.status,
    status_label: states[job.status]?.label || job.status,
    total_labels: job.total_labels ?? 0,
    numbers: job.numbers || [],
    created_at: job.created_at || '',
    claimed_at: job.claimed_at || '',
    printed_at: job.printed_at || '',
    failed_at: job.failed_at || '',
    failure_reason: job.failure_reason || '',
    claim_count: job.claim_count || 0,
    source: job.source || '',
    reprint_of: job.reprint_of || '',
    requested_by: job.requested_by || '',
    printed_by: job.printed_by || '',
  } : null);

  const notify = (event) => {
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch (error) {
        logWarn('label_print.subscriber.failed', { error: error.message });
      }
    }
  };

  /**
   * 落盘产物（PDF / 首张 PNG）——**先写文件、再建任务记录**：
   * 反过来的话，任务已经"可被领取"，但文件还没落盘，小助手会领到一个空任务。
   * 写完建记录失败 ⇒ 把刚写的文件删掉（不留孤儿）。
   */
  const writeArtifacts = async (jobId, rendered) => {
    const pdfName = `${jobId}.pdf`;
    await fs.promises.writeFile(store.artifactPath(pdfName), rendered.pdf);
    let pngName = '';
    if (artifactConfig.keepPng && rendered.pngFirst) {
      pngName = `${jobId}.png`;
      await fs.promises.writeFile(store.artifactPath(pngName), rendered.pngFirst);
    }
    return { pdfName, pngName };
  };

  /**
   * 入队（内部共用一个实现，`single` 与 `batch` 只差"怎么挑出要打的标签"）。
   *
   * ⭐⭐ 2026-10-11 真机反馈：「点完没有反馈 ⇒ 她以为没点上、**连点几次 ⇒ 多打了好几张**」
   * ⇒ 这里有两道**去重**（都只在"她没有明确说要再打"时才生效）：
   *   ① `submitKey` —— 表单带回来的幂等键，**同一个 key 只会有一个任务**（最硬的一道）；
   *   ② `request_key` + `dedupeWindowMs` —— 同一份请求（同编号 / 同筛选）在**短窗口内**
   *      复用同一个任务（扫描页是零 JS，连点会发出几个一模一样的 POST，就靠这道兜住）。
   * 🔴 她**真想再打一张**时：带 `again: true`（页面上那颗【再打一张】）⇒ **两道都绕过**。
   */
  const enqueue = async (input, {
    actor = '', source = SOURCES.workbench, submitKey = '', again = false, rotate, canvas,
  } = {}) => {
    if (config.enabled === false) throw Object.assign(new Error('打印队列没有启用'), { statusCode: 503 });
    const request = normalizeRequest(input);
    // ⭐ 打印方向：**默认跟随配置**（`artifact.rotate`）；页面可以**按这一次**覆盖（试 90°/270° 用）。
    //    ⚠️ 认不出的角度 ⇒ **400**（她/页面填错了，原样回页面），**不许静默按 0**
    //    印出一堆方向反的标签（那是最费纸的一种失败）。
    let rotateOverride;
    if (rotate !== undefined && rotate !== null && rotate !== '') {
      try {
        rotateOverride = normalizeRotation(rotate);
      } catch (error) {
        throw userError(error.message);
      }
    }
    // ⭐ 画布方向也可以按这一次覆盖（试"竖版铺满 / 横版"不用改配置重启）。
    let canvasOverride;
    if (canvas !== undefined && canvas !== null && canvas !== '') {
      try {
        canvasOverride = normalizeCanvas(canvas);
      } catch (error) {
        throw userError(error.message);
      }
    }
    const renderConfig = {
      ...artifactConfig,
      ...(rotateOverride === undefined ? {} : { rotate: rotateOverride }),
      ...(canvasOverride === undefined ? {} : { canvas: canvasOverride }),
    };
    const requestKey = requestKeyOf(request, rotateOverride, canvasOverride);
    const key = String(submitKey || '').trim();
    const force = Boolean(again);
    const dedupeWindowMs = Number(config.dedupeWindowMs || 0);

    /** 这一份请求现在能不能复用一条已有任务（**只复用没有失败过的**）。 */
    const findReusable = async () => {
      if (force) return null;
      const jobs = await store.listAll();
      if (key) {
        const sameSubmit = jobs.find((job) => job.submit_key === key && job.status !== STATES.failed.id);
        if (sameSubmit) return { job: sameSubmit, reason: 'same_submit_key' };
      }
      if (dedupeWindowMs > 0) {
        const since = now() - dedupeWindowMs;
        const recent = jobs.find((job) => job.request_key === requestKey
          && job.status !== STATES.failed.id
          && Number(job.created_at_ms || 0) >= since);
        if (recent) return { job: recent, reason: 'recent_same_request' };
      }
      return null;
    };

    // 快路：先在锁外看一眼（省掉一次"其实不用画"的渲染）。
    const fast = await findReusable();
    if (fast) {
      logInfo('label_print.job.reused', { job_id: fast.job.job_id, request_key: requestKey, reason: fast.reason });
      return { job: summaryOf(fast.job), job_id: fast.job.job_id, total_labels: fast.job.total_labels, reused: true, reused_reason: fast.reason };
    }

    // ── 挑出要打的标签（**只读**「实时库存」+「货品信息」，与页面预览同一条 service）──────
    // ⚠️ 整段（挑标签 + 画产物）包进 `renderOnce`：同一份内容并发时**只画一次**（见它的注释）。
    let data;
    let rendered;
    let labels;
    const built = await (force
      ? (async () => {
        const value = await buildArtifact();
        return value;
      })()
      : renderOnce(requestKey, buildArtifact));
    ({ data, rendered, labels } = built);

    async function buildArtifact() {
    if (request.mode === 'single' && request.recordId) {
      // ⭐ 「扫码打印」：**按记录 ID 精确一张** —— 解编号那件事归 `labelPrintService`
      //   （本文件"不懂标签长什么样"那条边界不破 ✓）；解不出来/没库存 ⇒ 它抛 400 的人话。
      if (typeof labelPrint.labelForRecord !== 'function') {
        throw systemError('打印服务不支持「按记录 ID 打印」（部署的版本太旧）');
      }
      data = await labelPrint.labelForRecord(request.recordId);
      // 一张 = 一个编号；`labelForRecord` 已经筛到**恰好这一张**（多一张都算多打 ✗）。
      if ((data.labels || []).length !== 1) {
        throw systemError(`按记录 ID 应该恰好找到 1 张标签，实际 ${(data.labels || []).length} 张`);
      }
    } else if (request.mode === 'single') {
      const itemNo = request.number.split('|')[0];
      data = await labelPrint.listLabels({ keyword: itemNo || request.number });
      const exact = (data.labels || []).filter((label) => label.number === request.number);
      if (!exact.length) {
        // ⚠️ **不静默**：她扫的这一款可能一雙都没有（或所属状态为空被跳过）—— 如实说清。
        throw userError(`没有找到编号「${request.number}」的可打印标签（这一款现在可能没有库存）`);
      }
      data = { ...data, labels: exact, total_matched: exact.length, total_returned: exact.length };
    } else {
      data = await labelPrint.listLabels(request.filters);
    }

    const labels = data.labels || [];
    if (!labels.length) throw userError('这些条件下一张标签都没有，先换个条件再打');
    const maxLabels = Number(config.maxLabelsPerJob || 0);
    if (maxLabels > 0 && data.total_matched > maxLabels) {
      // ⚠️ **不静默截断**：少打了她根本不知道。宁可让她收窄条件（页面预览里也有一模一样的上限口径）。
      throw userError(`一次最多打 ${maxLabels} 张，当前条件匹配 ${data.total_matched} 张 —— 请先收窄条件（例如加上货号 / 状态 / 尺码）`);
    }

    // ── 画产物（**在服务器上画好**，电脑那边只负责送进打印机）────────────────────────
    let rendered;
    try {
      rendered = await render({ labels, layout: data.layout, config: renderConfig });
    } catch (error) {
      throw systemError(`打印文件生成失败：${error.message}`);
    }
    return { data, rendered, labels };
    }

    // ⚠️ **并发兜底**：两个一模一样的请求可能同时越过上面的快路（真·连点），
    //    所以"再查一次 + 建任务"这一段按 `request_key`/`submit_key` **串行**。
    // 🔴🔴 2026-10-12 真机事故（**同一秒 4 个 job**）的根因就在这一行：
    //      锁原来按 `submitKey || requestKey` 取 —— 而扫码页**每次 303 回来都会重新渲染出一个新的
    //      `submit_key`**（表单里的隐藏键），于是 4 次连点各自拿到**一把不同的锁**、谁也没挡住谁；
    //      4 次都在"第二次 findReusable"之前（画产物很慢）⇒ 4 条任务。
    //      ⇒ 锁必须按 **request_key（页面 + 内容指纹）**：同一页面同一内容串行执行，
    //        第 1 个建任务、第 2~N 个在锁里"再查一次"就命中短窗去重（`recent_same_request`）✓
    //      ⚠️ 用户明确要再打一张时走 `again=1`（`force`）⇒ 照旧**跳过**去重、建新任务（只是排队等锁）。
    return enqueueLock.run(`enqueue:${requestKey}`, async () => {
      const second = await findReusable();
      if (second) {
        logInfo('label_print.job.reused', {
          job_id: second.job.job_id, request_key: requestKey, reason: second.reason, phase: 'locked',
        });
        return {
          job: summaryOf(second.job),
          job_id: second.job.job_id,
          total_labels: second.job.total_labels,
          reused: true,
          reused_reason: second.reason,
        };
      }
      return createJob({ request, requestKey, labels, data, rendered, actor, source, submitKey: key, rotate: rendered.meta?.rotate });
    });
  };

  /** 真正建任务（**只在持锁的那一段里调**）。 */
  const createJob = async ({ request, requestKey, labels, data, rendered, actor, source, submitKey, rotate }) => {
    const jobId = idFactory();
    const enqueuedAtMs = now();
    let pdfName;
    let pngName;
    try {
      ({ pdfName, pngName } = await writeArtifacts(jobId, rendered));
    } catch (error) {
      throw systemError(`打印文件写盘失败：${error.message}`);
    }

    const job = {
      job_id: jobId,
      status: states.queued.id,
      source,
      request,
      // 这一批是哪些编号（页面显示 / 补打 / 排障都要它）。
      numbers: labels.map((label) => label.number),
      total_labels: labels.length,
      total_pairs: data.total_pairs ?? null,
      pages: rendered.pages,
      artifact: {
        pdf: pdfName,
        png: pngName,
        page_count: rendered.meta.page_count,
        pdf_bytes: rendered.meta.pdf_bytes,
        width_pt: rendered.meta.width_pt,
        height_pt: rendered.meta.height_pt,
        dpi: rendered.meta.dpi,
        width_mm: rendered.meta.width_mm,
        height_mm: rendered.meta.height_mm,
        // ⭐ 画布方向 / 是否被缩过 / 页面高度——排障时一眼能看出"这一张是不是小框"。
        canvas: rendered.meta.canvas,
        rotate: rendered.meta.rotate,
        scale: rendered.meta.scale,
        sha256: crypto.createHash('sha256').update(rendered.pdf).digest('hex'),
      },
      requested_by: actor || '',
      // ⭐ 去重用的两个键（补打/排障时也看得见"这一条是怎么被认出来的"）。
      request_key: requestKey,
      submit_key: submitKey || '',
      // 这一批是按哪个方向印的（试方向时一眼能看出"刚才那张是竖版还是横版 90°"）。
      rotate: rotate ?? null,
      canvas: rendered.meta?.canvas || null,
      created_at: ISO(enqueuedAtMs),
      created_at_ms: enqueuedAtMs,
    };

    try {
      await store.create(job);
    } catch (error) {
      // 任务没建起来 ⇒ 刚写的产物就是垃圾，删掉（不留孤儿文件）。
      await store.remove(jobId, [pdfName, pngName]).catch(() => undefined);
      throw systemError(`打印任务落盘失败：${error.message}`);
    }

    logInfo('label_print.job.enqueued', {
      job_id: jobId,
      source,
      mode: request.mode,
      // ⭐ 「扫码打印」按记录 ID 入队时留痕（排障时看得出"这一张是从哪个码来的"）。
      record_id: request.recordId || undefined,
      total_labels: labels.length,
      page_count: rendered.meta.page_count,
      pdf_bytes: rendered.meta.pdf_bytes,
      numbers: labels.map((label) => label.number).slice(0, 20),
    });
    notify({ type: 'job', payload: summaryOf(job) });

    // 顺手清理过期任务（**不是定时器**：每次入队试一次，有节流；小 VPS 不想多养一个 setInterval）。
    void cleanup().catch((error) => logWarn('label_print.cleanup.failed', { error: error.message }));

    return { job: summaryOf(job), job_id: jobId, total_labels: labels.length };
  };

  /** 手机侧：按**编号**打这一款（扫码页「货品」领域那颗【打印这一款】）。 */
  const enqueueSingle = (input = {}) => enqueue(
    // ⭐ 2026-10-14：「扫码打印」传 `recordId`（按记录 ID 精确一张）；不带就还是按编号（逐字照旧 ✓）。
    input.recordId
      ? { mode: 'single', recordId: input.recordId }
      : { mode: 'single', number: input.number },
    {
      actor: input.actor,
      source: input.source || SOURCES.scan,
      submitKey: input.submitKey,
      again: input.again,
      rotate: input.rotate,
      canvas: input.canvas,
    },
  );

  /** 手机侧：按条件打一批（标签打印页那颗「打印到店里那台电脑」）。 */
  const enqueueBatch = (input = {}) => enqueue(
    { mode: 'batch', filters: input.filters },
    {
      actor: input.actor,
      source: input.source || SOURCES.workbench,
      submitKey: input.submitKey,
      again: input.again,
      rotate: input.rotate,
      canvas: input.canvas,
    },
  );

  const getJob = (jobId) => store.get(jobId);

  /**
   * ⭐ 2026-10-12（同一秒 4 个 job 那件事的另一半）：**同一份内容的"挑标签 + 画产物"只跑一次**。
   *
   *   已经有一把按 `request_key` 的锁把"查重 + 建任务"串起来了（job 只会有一条 ✓），
   *   但**画产物在锁外**：5 次连点会各自画一遍（白画 4 次、还各占几十上百毫秒 CPU）。
   *   这里用一张"在途表"把同一个 `request_key` 的渲染**合并成同一个 Promise**：
   *     · 第 1 个真去画；第 2~N 个 `await` 同一个 Promise（拿到同一份产物）；
   *     · 画完（成功或失败）立刻从表里删掉 ⇒ **不会把"她已经打完又点一次"也合并掉**。
   *   ⚠️ `again=1`（她明确要重打）**不合并** —— 它走的是"再渲染一次"的老路（force 语义）。
   */
  const rendersInFlight = new Map();
  const renderOnce = (requestKey, work) => {
    const running = rendersInFlight.get(requestKey);
    if (running) return running;
    const promise = (async () => work())().finally(() => rendersInFlight.delete(requestKey));
    rendersInFlight.set(requestKey, promise);
    return promise;
  };

  /**
   * ⭐⭐ 2026-10-12：她在扫码页点完【打印这一款】要看到「**已下发到电脑（队列第 N 位）**」。
   *   N = 1 表示"下一条就轮到这一张"。
   *   口径 = **排在我前面、还没打完的任务条数 + 1**：
   *     · 前面 = `created_at` 更早（同一毫秒按 job_id 兜底，与 `listClaimable` 的排序一致）；
   *     · 只数**还在队列里**的（`queued` / `claimed` / `rendering`）—— `done` / `failed` 不算前面。
   *   ⚠️ 纯只读；读不到那一条任务 ⇒ 返回 `null`（页面就不显示这一句，**不编一个数**）。
   */
  const queuePositionOf = async (jobId) => {
    const target = await store.get(jobId);
    if (!target) return null;
    const active = [states.queued.id, states.claimed.id];
    const jobs = await store.listAll();
    const ahead = jobs.filter((job) => {
      if (!job || job.job_id === jobId) return false;
      if (!active.includes(job.status)) return false;
      const left = String(job.created_at || '');
      const right = String(target.created_at || '');
      if (left !== right) return left < right;
      return String(job.job_id) < String(jobId);
    }).length;
    return ahead + 1;
  };

  const listJobs = async ({ limit, status } = {}) => {
    const records = await store.listAll();
    const filtered = status ? records.filter((job) => job.status === status) : records;
    const max = Number(limit || config.listLimit || 10);
    return filtered.slice(0, max);
  };

  /**
   * ⭐ **小助手一启动就先调这个**（"补拉"）：把**现在就能打的**任务一次取回来。
   * 它**只列不认领**（认领由 `claimNext` 逐个做）——因为列的时候还没开始打，
   * 万一列完就崩了，任务应该还是"待打印"而不是"已取走"。
   */
  const listPending = async ({ deviceId } = {}) => {
    const jobs = await store.listClaimable({
      now: now(),
      claimTimeoutMs: config.claimTimeoutMs,
    });
    logInfo('label_print.job.pending_listed', {
      device_id: deviceId || config.device?.id || '',
      pending: jobs.length,
    });
    return jobs.map(summaryOf);
  };

  /**
   * 认领**最老的一条**可打任务（先进先出）。
   * 返回 `null` = 现在没有要打的（长轮询据此继续等；SSE 模式下由事件唤醒）。
   */
  const claimNext = async ({ deviceId } = {}) => {
    const device = String(deviceId || config.device?.id || '').trim();
    const candidates = await store.listClaimable({ now: now(), claimTimeoutMs: config.claimTimeoutMs });
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const result = await store.claim(candidate.job_id, {
        deviceId: device,
        now: now(),
        claimTimeoutMs: config.claimTimeoutMs,
      });
      if (result.claimed) {
        logInfo('label_print.job.claimed', {
          job_id: result.job.job_id,
          device_id: device,
          total_labels: result.job.total_labels,
          // 重投（上一次认领超时）要能一眼看出来：这正是"电脑在打的时候断电了"那种情况。
          redelivered: result.redelivered || undefined,
          claim_count: result.job.claim_count,
        });
        return result.job;
      }
      // 抢输了（别人刚拿走 / 状态变了）⇒ 试下一条。
    }
    return null;
  };

  /**
   * 回执。`done` / `failed` 两种；**失败必须带原因**（她要求"失败要给原因"）。
   * ⚠️ **幂等**：已经 `done` 的任务再收到 `done` ⇒ 原样返回，**不报错、不改时间**
   *    （小助手回执丢了会重发；重发不该把"已打印"变成"失败"或把时间刷新）。
   */
  const ack = async ({ jobId, status, reason, deviceId } = {}) => {
    const next = String(status || '').trim();
    if (![states.done.id, states.failed.id].includes(next)) {
      throw userError(`回执状态只能是 ${states.done.id} 或 ${states.failed.id}`);
    }
    const job = await store.get(jobId);
    if (!job) throw userError('没有这条打印任务');
    if (job.status === next) return { job: summaryOf(job), duplicate: true };
    if (job.status === states.done.id && next === states.failed.id) {
      // 已经打成功了，之后来的"失败"一律忽略（迟到的失败不能把成功改掉）。
      logWarn('label_print.job.late_failure_ignored', { job_id: job.job_id, reason: String(reason || '') });
      return { job: summaryOf(job), ignored: true };
    }

    const at = now();
    if (next === states.failed.id) {
      const text = String(reason || '').trim();
      if (!text) throw userError('失败回执必须带原因（她要在手机上看清为什么没打出来）');
      const failed = await store.ack(jobId, {
        status: states.failed.id,
        failed_at: ISO(at),
        failed_at_ms: at,
        failure_reason: text,
        printed_by: String(deviceId || job.claimed_by || '').trim(),
      });
      logWarn('label_print.job.failed', { job_id: jobId, device_id: deviceId || '', reason: text });
      notify({ type: 'job', payload: summaryOf(failed) });
      return { job: summaryOf(failed) };
    }

    const done = await store.ack(jobId, {
      status: states.done.id,
      printed_at: ISO(at),
      printed_at_ms: at,
      printed_by: String(deviceId || job.claimed_by || '').trim(),
      failure_reason: null,
    });
    logInfo('label_print.job.done', {
      job_id: jobId,
      device_id: deviceId || '',
      total_labels: job.total_labels,
      // 从入队到打完花了多久 —— 她"电脑没开时点了打印"的那次会是个大数（排队时长），这是对的。
      queue_ms: Number(job.created_at_ms) ? at - Number(job.created_at_ms) : undefined,
    });
    notify({ type: 'job', payload: summaryOf(done) });
    return { job: summaryOf(done) };
  };

  /**
   * 心跳：小助手活着就一直在刷（长连接的 ping 也走这里）。
   * ⚠️ 它是**唯一**判定"那台电脑在不在线"的依据（`status().online`）。
   */
  const heartbeat = ({ deviceId, info } = {}) => {
    const device = String(deviceId || config.device?.id || '').trim() || 'unknown';
    const at = now();
    const previous = devices.get(device);
    devices.set(device, {
      device_id: device,
      last_seen_at: ISO(at),
      last_seen_ms: at,
      // 小助手自报的信息（版本 / 打印机名 / 队列长度）—— 排障时能一眼看出它那侧的状态。
      info: info && typeof info === 'object' ? info : (previous?.info || null),
      first_seen_at: previous?.first_seen_at || ISO(at),
    });
    return { ok: true, device_id: device, last_seen_at: ISO(at) };
  };

  /**
   * 手机 / 小助手本地页面看的**在线状态**（她要求一眼看得见）。
   * `online` 的判据只有一条：**最近 `onlineTimeoutMs` 内有过心跳**。
   */
  const status = async () => {
    const at = now();
    const timeout = Number(config.onlineTimeoutMs || 0);
    const list = [...devices.values()].map((device) => ({
      ...device,
      online: timeout <= 0 ? true : at - device.last_seen_ms <= timeout,
      seconds_since_seen: Math.round((at - device.last_seen_ms) / 1000),
    }));
    const jobs = await store.listAll();
    const counts = { queued: 0, claimed: 0, done: 0, failed: 0 };
    for (const job of jobs) {
      if (counts[job.status] !== undefined) counts[job.status] += 1;
    }
    const primary = list.find((device) => device.device_id === String(config.device?.id || '')) || list[0] || null;
    return {
      online: Boolean(primary?.online),
      online_timeout_ms: timeout,
      last_seen_at: primary?.last_seen_at || '',
      seconds_since_seen: primary ? primary.seconds_since_seen : null,
      device_id: primary?.device_id || String(config.device?.id || ''),
      devices: list,
      counts,
      total_jobs: jobs.length,
      now: ISO(at),
    };
  };

  /**
   * 这一款**最近一次**打印任务（扫码页"零 JS"就靠它：POST 之后重渲染读它）。
   * 找不到返回 `null`（页面显示"还没打过"，不是错误）。
   */
  const latestJobForNumber = async (number) => {
    const target = String(number || '').trim();
    if (!target) return null;
    const jobs = await store.listAll();
    const hit = jobs.find((job) => Array.isArray(job.numbers) && job.numbers.includes(target));
    return hit ? summaryOf(hit) : null;
  };

  /**
   * ⭐ **补打**（人工点的，不是自动的）—— 生成**一条新任务**，原任务一个字都不改。
   *
   * 为什么新建而不是"把老任务改回待打印"：
   *   · 老任务的 `done` 是一条**事实**（那一刻确实打出来过），改它等于篡改历史；
   *   · 新老两条并存 ⇒ 她在页面上看得见"我补打过一次"，对账时不会被静默吃掉。
   * 产物**直接复制**（不重新查库存、不重新排版）⇒ **补打出来的和第一次一模一样**。
   * ⚠️ 原产物过了保留期已删 ⇒ **明确报错**（不静默重新生成一份"现在的"数据）。
   */
  const reprint = async ({ jobId, actor } = {}) => {
    const source = await store.get(jobId);
    if (!source) throw userError('没有这条打印任务（可能已过保留期被清理）');
    const pdfName = source.artifact?.pdf;
    const sourcePath = pdfName ? store.artifactPath(pdfName) : '';
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      throw userError('这条任务的打印文件已过期（超过保留期），请重新提交打印');
    }

    const jobIdNew = idFactory();
    const at = now();
    const pdfNameNew = `${jobIdNew}.pdf`;
    await fs.promises.copyFile(sourcePath, store.artifactPath(pdfNameNew));

    const job = {
      ...source,
      job_id: jobIdNew,
      status: states.queued.id,
      reprint_of: source.job_id,
      artifact: { ...source.artifact, pdf: pdfNameNew, png: '' },
      requested_by: actor || source.requested_by || '',
      created_at: ISO(at),
      created_at_ms: at,
      // 上一次的认领/回执痕迹一律清掉（新任务从"待打印"开始）。
      claimed_at: null,
      claimed_at_ms: 0,
      claimed_by: null,
      printed_at: null,
      failed_at: null,
      failure_reason: null,
      claim_count: 0,
    };
    delete job.updated_at;
    await store.create(job);
    logInfo('label_print.job.reprinted', {
      job_id: jobIdNew,
      reprint_of: source.job_id,
      total_labels: job.total_labels,
    });
    notify({ type: 'job', payload: summaryOf(job) });
    return { job: summaryOf(job), job_id: jobIdNew };
  };

  /**
   * 保留期清理：`done` / `failed` 过期的任务连产物一起删。
   * 🔴 **`queued` / `claimed` 永不清理** —— "电脑没开时任务排队保留"那条要求就是它们。
   */
  const cleanup = async ({ force } = {}) => {
    const at = now();
    const interval = Number(config.cleanupIntervalMs || 0);
    if (!force && interval > 0 && at - lastCleanupAt < interval) return { skipped: true, removed: 0 };
    lastCleanupAt = at;
    const retention = Number(config.retentionMs || 0);
    if (retention <= 0) return { removed: 0 };
    const jobs = await store.listAll();
    let removed = 0;
    const liveArtifacts = new Set();
    for (const job of jobs) {
      if (job.artifact?.pdf) liveArtifacts.add(path.basename(job.artifact.pdf));
      if (job.artifact?.png) liveArtifacts.add(path.basename(job.artifact.png));
      if (![states.done.id, states.failed.id].includes(job.status)) continue;
      const finishedAt = Number(job.printed_at_ms || job.failed_at_ms || job.created_at_ms || 0);
      if (!finishedAt || at - finishedAt < retention) continue;
      // eslint-disable-next-line no-await-in-loop
      await store.remove(job.job_id, [job.artifact?.pdf, job.artifact?.png]);
      removed += 1;
    }
    // 孤儿产物（任务记录早没了、文件还在）：一起清掉，免得磁盘只增不减。
    // 🔴 **两道保护**：① 任何**还在的任务**记过的产物文件名都不动；
    //    ② 文件名形如 `<job_id>.pdf` / `<job_id>.png` —— 只要那个 job_id 还在，就绝不删
    //       （哪怕它的 `artifact` 字段因为老版本数据缺了）。排队中的任务因此**永远不会被误删**。
    const files = await fs.promises.readdir(store.artifactsDir).catch(() => []);
    const knownJobIds = new Set(jobs.map((job) => job.job_id));
    let orphans = 0;
    for (const file of files) {
      if (file.endsWith('.tmp') || liveArtifacts.has(file)) continue;
      const stem = file.replace(/\.(pdf|png)$/i, '');
      if (knownJobIds.has(stem)) continue;
      const stat = await fs.promises.stat(store.artifactPath(file)).catch(() => null);
      if (!stat?.isFile()) continue;
      if (at - stat.mtimeMs < retention) continue;
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.rm(store.artifactPath(file), { force: true }).catch(() => undefined);
      orphans += 1;
    }
    if (removed || orphans) {
      logInfo('label_print.cleanup.done', { removed_jobs: removed, removed_orphan_files: orphans });
    }
    return { removed, orphans };
  };

  /** 订阅（SSE 长连接用）。返回**取消订阅**的函数。 */
  const subscribe = (listener) => {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  };

  return {
    queuePositionOf,
    enqueue,
    enqueueSingle,
    enqueueBatch,
    getJob,
    listJobs,
    listPending,
    claimNext,
    ack,
    heartbeat,
    status,
    latestJobForNumber,
    reprint,
    cleanup,
    subscribe,
    summaryOf,
    /** 这一条链路的显式开关（页面据此决定"出按钮"还是"如实说一句不可用"）。 */
    isEnabled: () => config.enabled !== false,
    /** 用户可见文案（**唯一真源**在 `config/labelPrintQueue.js`；页面不许抄第二份）。 */
    texts: () => ({ ...(config.texts || {}) }),
    /** 产物文件的**绝对路径**（电脑侧路由下载 PDF 用；文件名只从任务记录里取，不接受外部输入）。 */
    artifactPath: (fileName) => store.artifactPath(path.basename(String(fileName || ''))),
    /** 供测试/本地页面用：现在有几个订阅者。 */
    subscriberCount: () => subscribers.size,
  };
};

module.exports = { createLabelPrintQueueService, normalizeRequest, requestKeyOf };
