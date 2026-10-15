/**
 * ⭐⭐ 2026-10-12 真机事故（业务负责人，逐字）：
 *   「点完之后**没有 Toast、按键置灰**之类的提示，页面完全没有及时的交互反馈
 *     ⇒ **我不知道指令到底有没有到达，就会一直狂点**」
 *   我量到的硬数字：**同一秒 4 个 job** ⇒ 4 张标签**串行打** ⇒ 20~47 秒。
 *
 * 本轮（A + B）：
 *   · **A1 短窗去重真的生效**：同一页面 / 同一内容的连续点击 ⇒ **只保留一个 job**，给她一句人话；
 *     ⚠️ 根因 = 那把"再查一次 + 建任务"的锁原来按 `submitKey` 取，而扫码页**每次 303 回来都会
 *        重新生成一个 submitKey** ⇒ 4 次点击各拿一把不同的锁、谁也没挡住谁。
 *   · **B 即时反馈**：点下去**立刻**按钮置灰 + 文案「正在下发…」；收到响应后横幅上
 *     「**已下发到电脑 · 队列第 N 位**」。
 *     ⚠️ "置灰"没有零 JS 的等价物 ⇒ 这一页**多了唯一一段内联 JS**（取舍见 AC-PF3 与报告）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-PF1 **同一页面/同一内容 5 次并发提交 ⇒ job 数 == 1**（第 2~5 次 `reused`，
 *         理由 = 短窗内同一份请求），且**只画一次产物**。
 *  AC-PF2 **【再打一张】（`again=1`）⇒ 真的建新 job**（她明确要重打时不被去重挡住）。
 *  AC-PF3 **即时反馈**：提交按钮带 `data-submitting`（文案来自配置）；整页**只有一段** `<script>`
 *         且它只做"置灰 + 换文案"（不发请求、不碰别处）；⚠️ **其余五个领域仍然零脚本**。
 *  AC-PF4 **队列位次**：横幅上出现「已下发到电脑 · 队列第 N 位」（文案在配置里）；
 *         真路由走一遍：POST 打印 ⇒ 303 ⇒ 带 `printed=1&job=` 的 GET 页面上有那一句。
 *  AC-PF5 **回归**：提交成功那条横幅（本次 N 张）与 `dup=1` 那条（+【再打一张】）逐字还在。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_print_feedback';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'print_feedback_secret';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');
const { LabelPrintJobStore } = require('../src/infrastructure/labelPrintJobStore');
const { createLabelPrintQueueService } = require('../src/services/labelPrintQueueService');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const SESSION_SECRET = 'print_feedback_secret';
const NUMBER = 'XHB8095|棕色|A';
const ENCODED = encodeURIComponent(NUMBER);
const TEXTS = LABEL_PRINT_QUEUE.texts;

/**
 * ⭐⭐ 2026-10-16 **成对迁移**（依据 = 业务负责人 2026-10-12 逐字「我可没有说过，
 *   **我们是能够进行动态交互的**」＋ 她 2026-10-16 亲口点的「页面标注模式」）：
 *   本文件里"整页只有一段脚本"的那几条，改成数**业务脚本**（`businessScriptCountOf`）＋
 *   另加一条"那一段标注脚本必须在且**必须早退**"（`ANNOTATE_MARK` / `annotateScriptOnlyEarlyExits`）。
 *
 *   改前逐字（以 AC-PF3 那处为例）：
 *     `const scripts = html.match(/<script[\s>]/gi) || [];`
 *     `assert.equal(scripts.length, 1, \`整页只该有 1 段脚本（实际 ${scripts.length} 段）\`);`
 *   改后逐字：
 *     `const scripts = html.match(/<script(?! data-view="annotate")[\s>]/gi) || [];`
 *     `assert.equal(scripts.length, 1, \`整页只该有 1 段**业务**脚本（实际 ${scripts.length} 段）\`);`
 *     ＋ `assert.equal(html.includes(ANNOTATE_MARK), true, …)` ＋ 早退那一条。
 *
 *   依据：「扫码页零 JS」是**我方（agent 侧）**的约束、**不是她的口径**；而"带 `?annotate=1`
 *     才出现"这道闸门**只能落在脚本内部** —— 查询串只有 `routes/scanPage.js` 拿得到，
 *     那个文件**不在本任务写作用域内**（另有主）。
 *   ⚠️ **没放宽**：原来数"全部脚本 = 1"，现在数"业务脚本 = 1" ＋ "多出来的那一段必须早退" ✓
 */
const ANNOTATE_MARK = '<script data-view="annotate">';
const businessScriptCountOf = (html) => (html.match(/<script(?! data-view="annotate")[\s>]/gi) || []).length;
const annotateScriptOnlyEarlyExits = (html) => {
  const at = html.indexOf(ANNOTATE_MARK);
  if (at < 0) return false;
  const body = html.slice(at, html.indexOf('</scr' + 'ipt>', at));
  return body.includes('location.search') && body.includes('if (!enabled()) return');
};

const label = (patch = {}) => ({
  key: NUMBER, number: NUMBER, item_no: 'XHB8095', color: '棕色', category: '休闲鞋', category_code: 'A',
  sizes: [{ size: 36, qty: 1 }], size_lines: [[{ size: 36, qty: 1 }]], size_overflow: false, total_qty: 1,
  ...patch,
});
const tempDir = (labelText) => fs.mkdtempSync(path.join(os.tmpdir(), `print-feedback-${labelText}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/** 真队列服务（假"画产物"——**故意慢**，才能制造"4 次点击挤在一起"的并发窗口）。 */
const queueFor = ({ labels = [label()], renderDelayMs = 0 } = {}) => {
  const dir = tempDir('queue');
  const store = new LabelPrintJobStore({ dir, artifactsDir: path.join(dir, 'artifacts') });
  let renders = 0;
  return {
    dir,
    get renders() { return renders; },
    queue: createLabelPrintQueueService({
      store,
      labelPrint: {
        listLabels: async () => ({ labels, layout: { columns: 3 }, total_pairs: 1, total_matched: labels.length }),
      },
      // ⚠️ 注入点是 `renderLabels`（不是 `render`）—— 写错了会**真的去画 PDF**（慢且量不到次数）
      renderLabels: async () => {
        renders += 1;
        if (renderDelayMs) await new Promise((resolve) => setTimeout(resolve, renderDelayMs));
        return {
          pdf: Buffer.from('%PDF-1.4 feedback'), png: Buffer.from('png'), pages: 1,
          meta: {
            page_count: 1, pdf_bytes: 20, width_pt: 100, height_pt: 100, dpi: 300,
            width_mm: 40, height_mm: 40, canvas: 'default', rotate: null, scale: 1,
          },
        };
      },
      config: { ...LABEL_PRINT_QUEUE, dedupeWindowMs: 60_000 },
    }),
  };
};

const fakeQueue = (options = {}) => ({
  isEnabled: () => options.enabled !== false,
  status: async () => ({
    online: true, last_seen_at: '2026-10-12T09:00:00.000Z', counts: { queued: 1, claimed: 0, done: 0, failed: 0 },
  }),
  latestJobForNumber: async () => options.job || null,
  enqueueSingle: async (input) => {
    options.calls?.push(input);
    return {
      job_id: 'job-1', total_labels: 1,
      job: { job_id: 'job-1', status: 'queued', status_label: '待打印' },
      reused: Boolean(options.reused),
      ...(options.reused ? { reused_reason: 'recent_same_request' } : {}),
    };
  },
  summaryOf: (job) => job,
  getJob: async (jobId) => ({
    job_id: jobId, status: 'queued', status_label: '待打印', total_labels: 1, numbers: [NUMBER],
  }),
  queuePositionOf: async () => options.position ?? 1,
});

const VIEW = {
  found: true, number: NUMBER, item_no: 'XHB8095', color: '棕色', category_name: '休闲鞋',
  category_code: 'A', price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '36', cells: [{ key: '门盒', count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-12 17:30',
  product_record_id: 'prod_1',
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_print_feedback') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};
const appFor = (queue) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ ...VIEW }) },
    writeService: false,
    arrivalService: false,
    startSnapshot: false,
    labelPrintQueue: queue,
    writeConfig: SCAN_WRITE,
  }));
  return app;
};
const productBlock = (html) => {
  const marker = 'class="realm-block realm-block--product"';
  const start = html.indexOf(marker);
  assert.ok(start >= 0, '页面上必须有「货品」那一块');
  return html.slice(start);
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-PF1 / AC-PF2 去重（A1）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PF1 同一页面同一内容 5 次并发提交 ⇒ 只建 1 个 job（短窗去重生效）', async () => {
  const h = queueFor({ renderDelayMs: 30 }); // 画产物慢 ⇒ 5 次点击真的挤在同一窗口里
  try {
    // ⚠️ 扫码页每次 303 回来都会给出**新的** submitKey ⇒ 这里故意每次传不同的 submitKey，
    //    模拟她的"狂点"（这正是线上 4 个 job 的成因）。
    const results = await Promise.all(Array.from({ length: 5 }, (_, index) => h.queue.enqueueSingle({
      number: NUMBER, actor: 'ou_print_feedback', source: 'scan', submitKey: `scan_print_${index}`,
    })));
    const jobs = await h.queue.listJobs({ limit: 50 });
    assert.equal(jobs.length, 1, `5 次点击只该有 1 个 job（实际 ${jobs.length} 个）`);
    assert.equal(h.renders, 1, '产物只该画一次（画完才发现去重 = 白画 4 次）');
    assert.equal(results.filter((item) => item.reused).length, 4, '另外 4 次都是"命中去重"');
    for (const item of results) {
      assert.equal(item.job_id, jobs[0].job_id, '5 次拿到的都是同一条任务');
    }
    // 给她的人话里能看出"没有重复提交"（横幅那条 `dup=1` 走的就是 `reused`）
    assert.ok(results.some((item) => item.reused_reason === 'recent_same_request'));
  } finally { rmDir(h.dir); }
});

test('AC-PF2 【再打一张】(`again=1`) ⇒ 真的建新 job（明确要重打时不被去重挡住）', async () => {
  const h = queueFor();
  try {
    const first = await h.queue.enqueueSingle({ number: NUMBER, source: 'scan', submitKey: 'k1' });
    const again = await h.queue.enqueueSingle({ number: NUMBER, source: 'scan', submitKey: 'k2', again: true });
    assert.equal(first.reused, undefined);
    assert.equal(again.reused, undefined, 'again=1 必须绕过窗口去重');
    assert.notEqual(again.job_id, first.job_id, '重打是**新**任务');
    assert.equal((await h.queue.listJobs({ limit: 50 })).length, 2);
  } finally { rmDir(h.dir); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PF3 即时反馈（B）：置灰 + 文案；且只有这一段脚本
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PF3 点下去立刻置灰：提交按钮带反馈属性；整页**只有一段**脚本（页面级，六个领域各一页一次）', async () => {
  login();
  const queue = fakeQueue();
  await withServer(appFor(queue), async (base) => {
    const html = await (await fetch(`${base}/s/${ENCODED}?from=product`, {
      headers: { cookie: sessionCookie() },
    })).text();
    const block = productBlock(html);
    // ① 打印按钮带"下发中"文案（来自配置；JS 里不写死中文）
    assert.ok(block.includes(`data-submit-feedback="${TEXTS.printSubmitting}"`),
      `打印按钮要带 data-submit-feedback=${TEXTS.printSubmitting}`);
    // ② 整页只有这一段**业务**脚本（**页面级一次**），它只做"置灰 + 换文案 + 计时"
    //    （⭐ 2026-10-16 成对迁移：另有一段标注脚本，逐字对照见本文件顶部那段注释）
    const scripts = html.match(/<script(?! data-view="annotate")[\s>]/gi) || [];
    assert.equal(scripts.length, 1, `整页只该有 1 段**业务**脚本（实际 ${scripts.length} 段）`);
    assert.ok(html.includes('<script data-view="submit-feedback">'), '就是提交反馈那一段');
    assert.equal(html.includes(ANNOTATE_MARK), true, '标注脚本照旧在（`?annotate=1` 时才做事 ✓）');
    assert.equal(annotateScriptOnlyEarlyExits(html), true, '它必须早退（不带参数时页面逐字不变 ✓）');
    const script = html.slice(html.indexOf('<script data-view="submit-feedback">'),
      html.indexOf('</script>', html.indexOf('<script data-view="submit-feedback">')));
    assert.ok(script.includes('button.disabled = true'), '它做"置灰"');
    assert.ok(script.includes('data-submit-feedback'), '文案从按钮/表单属性读（配置来的）');
    assert.ok(script.includes('setInterval'), '服务端慢时每秒刷新"已 N 秒"（不许看起来没反应）');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'localStorage', 'location.href']) {
      assert.equal(script.includes(forbidden), false, `这一段不许干别的：${forbidden}`);
    }
    // ③ 每个领域都只有这一段（**同一段**：它只挂在带反馈属性的按钮上，其余表单不受影响）
    for (const realm of ['sales', 'replenish', 'purchase_return', 'accept', 'inventory']) {
      const other = await (await fetch(`${base}/s/${ENCODED}?from=${realm}`, {
        headers: { cookie: sessionCookie() },
      })).text();
      // 只有"有提交按钮"的页面才有那一段（销售提交 / 打印这一款）；其余领域仍然**零业务脚本**
      const count = businessScriptCountOf(other);
      assert.equal(count, 0, `${realm} 领域没有提交按钮 ⇒ 仍然零**业务**脚本（实际 ${count}）`);
    }
  });
});

test('AC-PF6 ⭐ 销售【提交这一单】也有即时反馈：置灰 + 「正在提交，请不要重复点…」+ 已 N 秒', async () => {
  login();
  // 这一条要**真的渲染出销售那块**（带钱的提交表单）⇒ 需要一个最小的写入口上下文
  const writeService = {
    listPaymentMethods: async () => require('../src/config/scanWrite').SCAN_WRITE.sale.paymentMethods,
    sessions: {
      get: async () => ({
        session_id: 'scan_session_0123456789abcdef', expired: false,
        sale: { key: 'scan_sale:scan_session_0123456789abcdef:1', seq: 1, status: 'draft', lines: [
          { product_number: 'XHB8095', size: 36, quantity: 1, sale_unit_price: 399 },
        ] },
      }),
      submitKeyFor: () => 'scan_sale:scan_session_0123456789abcdef:1',
    },
    listAccessories: async () => [],
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ ...VIEW }) },
    writeService,
    arrivalService: false,
    startSnapshot: false,
    labelPrintQueue: fakeQueue(),
    writeConfig: SCAN_WRITE,
  }));
  await withServer(app, async (base) => {
    const html = await (await fetch(`${base}/s/${ENCODED}?from=sales`, {
      headers: { cookie: sessionCookie() },
    })).text();
    // 提交按钮带两句文案：立刻那句 + 带 {seconds} 的计时模板
    assert.ok(html.includes(`data-submit-feedback="${SCAN_WRITE.texts.submitSubmitting}"`),
      '销售提交按钮要有"正在提交，请不要重复点…"');
    assert.ok(html.includes(`data-submitting-elapsed="${SCAN_WRITE.texts.submitSubmittingElapsed}"`),
      '还要有"已 N 秒"的模板（{seconds} 占位）');
    assert.ok(String(SCAN_WRITE.texts.submitSubmittingElapsed).includes('{seconds}'));
    // 页面里那段脚本照旧只有一段（⭐ 2026-10-16 成对迁移：数**业务**脚本 ＋ 标注脚本必须早退 ✓）
    assert.equal(businessScriptCountOf(html), 1);
    assert.equal(/<script(?! data-view="(annotate|submit-feedback)")/i.test(html), false,
      '没有第三段别的脚本');
    assert.equal(annotateScriptOnlyEarlyExits(html), true, '那段标注脚本必须早退（不带参数时零痕迹 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PF4 队列位次（B）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PF4 收到响应后横幅给「已下发到电脑 · 队列第 N 位」（真路由走一遍）', async () => {
  login();
  const calls = [];
  const queue = fakeQueue({ calls, position: 3 });
  await withServer(appFor(queue), async (base) => {
    // ① POST 打印 ⇒ 303 回本领域（带 printed=1 与 job id）
    const posted = await fetch(`${base}/s/${ENCODED}?from=product`, {
      method: 'POST',
      headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: SCAN_WRITE.actions.printLabel }).toString(),
      redirect: 'manual',
    });
    assert.equal(posted.status, 303);
    const location = posted.headers.get('location');
    assert.ok(location.includes('printed=1') && location.includes('job=job-1'), location);
    // ② 跟着这一跳回去 GET ⇒ 横幅上有"队列第 N 位"
    const page = await (await fetch(`${base}${location}`, { headers: { cookie: sessionCookie() } })).text();
    assert.ok(page.includes('data-view="print-queue-position"'), '横幅要给"排在第几位"');
    assert.ok(page.includes('已下发到电脑 · 队列第 3 位'), '文案逐字（位置来自队列）');
    assert.ok(page.includes(LABEL_PRINT_QUEUE.texts.submittedNoRepeat), '既有那句"不用重复点"仍在');
  });
});

test('AC-PF7 ⭐ 逐按钮：**每一个写操作按钮**点下去都会置灰 + 换文案（静态断言，六个领域全覆盖）', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
  // 渲染层里"会发起写操作的提交按钮"必须**统一**走 `submitFeedbackAttrs`（一处定义）
  const submitButtons = renderer.match(/<button[^>]*type="submit"[^>]*>/g) || [];
  assert.ok(submitButtons.length >= 8, `提交按钮总得有几个（实际 ${submitButtons.length}）`);
  // ⭐⭐ 2026-10-14 晚 **改指向**（依据：她「`/s/accept` 这条路要彻底拆掉」）：
  //   改前逐字：`assert.equal(navButtons.length, 1, '手输批次号那个 GET 导航按钮要在（且只有它豁免）')`
  //   改后：那颗「手输批次号 → 进入验收」的按钮**随验收页退场** ⇒ 现在**一个豁免都没有** ✓
  //    ⇒ 判据反而**更严**：渲染层里每一个 `type="submit"` 都必须有即时反馈 ✓（没放宽 ✗）
  const navButtons = (renderer.match(/<button[^>]*type="submit"[^>]*>\$\{escapeHtml\(t\.acceptPendingManualSubmit\)\}<\/button>/g) || []);
  assert.equal(navButtons.length, 0, '那颗 GET 导航按钮已随验收页退场（豁免数必须是 0 ✓）');
  const missing = submitButtons.filter((tag) => !tag.includes('submitFeedbackAttrs')
    && !tag.includes('data-submit-feedback')
    && !tag.includes('class="btn btn--primary">'));
  assert.deepEqual(missing, [], `这些提交按钮还没有即时反馈：${missing.join(' | ')}`);
  // 属性值来自配置（不写死中文）
  assert.match(renderer, /const submitFeedbackAttrs = \(writeLike = \{\}\) => \{/);
  assert.ok(renderer.includes('texts.submitSubmitting'), '文案取自配置');
  assert.ok(renderer.includes('texts.submitSubmittingElapsed'), '计时模板取自配置');
  // 六个领域的页面：有写按钮 ⇒ 恰好 1 段脚本（逐领域静态核）
  const pageWith = (realm) => renderScanPage({ ...VIEW }, SCAN_PAGE, {
    enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
    postAction: `/s/${ENCODED}`, sizes: [{ size_text: '36', missing: false }],
    draft: { lines: [{ product_number: 'XHB8095', size: 36, quantity: 1, sale_unit_price: 399 }] },
    saleKey: 'k', replenishKey: 'k2', returnKey: 'k3', paymentMethods: ['微信'],
    defaultPaymentMethod: '微信', saleEnabled: true, replenishEnabled: true, returnEnabled: true,
    acceptDefaultQuantity: 1,
  }, realm, {});
  for (const realm of ['sales', 'replenish', 'purchase_return', 'accept', 'inventory', 'product']) {
    const html = pageWith(realm);
    // ⭐ 2026-10-16 成对迁移（逐字对照见本文件顶部那段注释）：这里数**业务**脚本
    const count = businessScriptCountOf(html);
    const hasWrite = html.includes('data-submit-feedback=');
    assert.equal(count, hasWrite ? 1 : 0, `${realm}：有写按钮 ⇒ 1 段，否则 0 段（实际 ${count}）`);
    assert.equal(annotateScriptOnlyEarlyExits(html), true, `${realm}：标注脚本必须早退 ✓`);
    // 命中区 ≥44px：按钮沿用既有 `.btn`（`min-height: var(--control-height)`）
    assert.ok(/min-height: var\(--control-height\)/.test(html), '按钮高度仍走既有令牌');
    // 不许出现说明书文字
    for (const manual of ['点击下方按钮即可', '操作说明', '使用说明']) {
      assert.equal(html.includes(manual), false, `不许写说明书：${manual}`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PF5 回归：两条既有横幅逐字还在
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PF5 回归：提交成功那条（本次 N 张）与 dup=1 那条（+【再打一张】）逐字还在', async () => {
  login();
  const queue = fakeQueue();
  await withServer(appFor(queue), async (base) => {
    const submitted = await (await fetch(`${base}/s/${ENCODED}?from=product&printed=1&job=job-1`, {
      headers: { cookie: sessionCookie() },
    })).text();
    assert.ok(submitted.includes(TEXTS.submittedBanner.replace('{count}', '1')), '成功横幅逐字在');
    assert.ok(submitted.includes(TEXTS.submittedNoRepeat), '"已提交，不用重复点"在');
    const dup = await (await fetch(`${base}/s/${ENCODED}?from=product&dup=1&job=job-1`, {
      headers: { cookie: sessionCookie() },
    })).text();
    assert.ok(dup.includes(TEXTS.duplicatedBanner.replace('{count}', '1')), '去重横幅逐字在');
    assert.ok(dup.includes(TEXTS.duplicatedHint), '去重提示在');
    assert.ok(dup.includes(TEXTS.printAgain), '【再打一张】在');
    // 纯渲染层的位次断言（真 service 的队列位次由 AC-PF4 覆盖）
    const rendered = renderScanPage({ ...VIEW }, SCAN_PAGE, null, 'product', {
      print: {
        enabled: true, texts: TEXTS, submitted: true, postAction: '/s/x?from=product',
        actionField: SCAN_WRITE.fields.action, actionValue: SCAN_WRITE.actions.printLabel,
        queue_position: 2, count_queued: 1, banner_job: { total_labels: 1 }, job: null,
      },
    });
    assert.ok(rendered.includes('队列第 2 位'));
  });
});
