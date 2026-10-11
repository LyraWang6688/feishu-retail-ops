/**
 * 扫码页「**货品**」领域 →【**打印这一款**】的验收标准（业务负责人 2026-10-11）。
 *
 * 她的原话（逐字）：「**扫码页应该是有货品的吧？你不是有六个领域吗？**」
 * ⇒ 扫到某款 ⇒「货品」领域 ⇒【打印这一款】⇒ **送到店里那台 Windows 电脑打出来**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *   AC-S1  那一颗按钮是**原生表单 POST**（`<form method="post">` + 隐藏的 `action`），
 *          页面里**一行 `<script>` 都没有**（这一页的硬约束：零 JS）；
 *   AC-S2  状态徽标：电脑在线 ⇒「打印电脑在线」；没连过 ⇒ 她定的那句
 *          「未连接（任务已排队，打开小助手就会打）」——**两句都来自配置，渲染层不写死**；
 *   AC-S3  「最近一次：<状态>」；**失败时同一行带原因**（她要"失败要给原因"）；
 *   AC-S4  POST `print_label` ⇒ 把**URL 里那个编号**排进队列 + **303** 回本领域（PRG，刷新不重复提交）；
 *   AC-S5  303 回来那一页（`printed=1`）出现「已提交打印」；
 *   AC-S6  ⭐ 打印**不受"扫码写入口关着"影响**（它不写任何业务表）——`writeService=false` 也能打；
 *   AC-S7  队列坏了 ⇒ 这一页**绝不留空白**：一句"打印服务暂时不可用" + 原来那两条链接，HTTP 200；
 *   AC-S8  打不出来 ⇒ 一张**人话页**（400 = 她这一款没库存，原因原样；系统坏 = 502）；
 *   AC-S9  编号**只认 URL 里的那个**（表单里没有编号字段）⇒ 手改表单打不了别的款；
 *   AC-S10 别的领域**一次都不碰**打印队列（不能因为接了打印就拖慢库存/销售那些领域）；
 *   AC-S11 那一页仍然**零脚本**（这条链路一个字节的前端 JS 都不许加）；
 *   AC-S12 移动端：按钮是 `.btn`（整行 + ≥44px 命中区）、不新增横向滚动。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_label_scan_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'label_scan_secret';

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { LABEL_PRINT_QUEUE } = require('../src/config/labelPrintQueue');

const SESSION_SECRET = 'label_scan_entry_secret';
const NUMBER = 'XHB8095|棕色|A';
const ENCODED = encodeURIComponent(NUMBER);
const TEXTS = LABEL_PRINT_QUEUE.texts;

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_label_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'XHB8095',
  color: '棕色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥198',
  total: 2,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [{ size_text: '36', cells: [{ key: '门盒', count: 2 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 2, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-11 20:00',
  product_record_id: 'prod_1',
};

/** 一个"记账式"的假队列：把调用都记下来，想让它回什么就回什么。 */
const fakeQueue = (options = {}) => {
  const calls = { status: 0, latest: [], enqueue: [] };
  return {
    calls,
    isEnabled: () => options.enabled !== false,
    status: async () => {
      calls.status += 1;
      if (options.statusError) throw new Error(options.statusError);
      return {
        online: options.online === true,
        last_seen_at: '2026-10-11T12:00:00.000Z',
        counts: { queued: 0, claimed: 0, done: 0, failed: 0 },
      };
    },
    latestJobForNumber: async (number) => {
      calls.latest.push(number);
      return options.job || null;
    },
    enqueueSingle: async (input) => {
      calls.enqueue.push(input);
      if (options.enqueueError) throw options.enqueueError;
      return { job_id: 'job-1', total_labels: 1, job: { job_id: 'job-1', status: 'queued', status_label: '待打印' } };
    },
  };
};

const JOB = (patch = {}) => ({
  job_id: 'job-9', status: 'queued', status_label: '待打印', total_labels: 1, numbers: [NUMBER],
  failure_reason: '', created_at: '2026-10-11T12:00:00.000Z', ...patch,
});

const appFor = ({ queue, writeService, realmWrite = true } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => ({ ...VIEW }) },
    writeService: writeService === undefined ? false : writeService,
    arrivalService: false,
    startSnapshot: false,
    labelPrintQueue: queue,
    writeConfig: realmWrite ? SCAN_WRITE : SCAN_WRITE,
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const getProduct = (base, query = '?from=product') => fetch(`${base}/s/${ENCODED}${query}`, {
  headers: { cookie: sessionCookie() },
});

const postPrint = (base, body = {}) => fetch(`${base}/s/${ENCODED}?from=product`, {
  method: 'POST',
  headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ action: SCAN_WRITE.actions.printLabel, ...body }).toString(),
  redirect: 'manual',
});

/** 「货品」领域那一块（用来断言"这一块里有什么"，不受页头影响）。 */
const productBlock = (html) => {
  const start = html.indexOf('realm-block--product');
  assert.ok(start >= 0, '页面上必须有「货品」那一块');
  return html.slice(start);
};

// ── AC-S1 / AC-S11 / AC-S12 ───────────────────────────────────────────────

test('AC-S1【打印这一款】= 原生表单 POST（隐藏 action），且 AC-S11 这一页零脚本', async () => {
  login();
  const queue = fakeQueue({ online: true });
  await withServer(appFor({ queue }), async (base) => {
    const response = await getProduct(base);
    assert.equal(response.status, 200);
    const html = await response.text();
    const block = productBlock(html);

    assert.ok(block.includes(`<form class="label-print-form" method="post" action="/s/${ENCODED}?from=product">`),
      '必须是 POST 到本领域的原生表单');
    assert.ok(block.includes(`name="${SCAN_WRITE.fields.action}" value="${SCAN_WRITE.actions.printLabel}"`),
      '隐藏字段名与动作值都来自配置（渲染层不写死）');
    assert.ok(block.includes(`>${TEXTS.printSingle}</button>`), `按钮文案 = ${TEXTS.printSingle}`);
    assert.match(block, /<button class="btn btn--primary" type="submit">/);

    // 零 JS：整个页面一个 <script> 都不许有（这条链路不引入任何前端脚本）。
    assert.equal(/<script[\s>]/i.test(html), false, '扫码页必须零脚本');
    assert.equal(html.includes('location.search'), false);
  });
});

test('AC-S12 移动端：按钮是整行 `.btn`（≥44px 命中区由 tokens 的 --control-height 给），没有横向滚动容器', async () => {
  login();
  await withServer(appFor({ queue: fakeQueue({ online: true }) }), async (base) => {
    const html = await (await getProduct(base)).text();
    assert.ok(html.includes('.btn { display: block; width: 100%; min-height: var(--control-height);'),
      '.btn 本身就是整行 + ≥44px 命中区（这条链路的按钮复用它，不新写一套）');
    const block = productBlock(html);
    assert.equal(/overflow-x\s*:\s*(auto|scroll)/.test(block), false, '这一块不许出现横向滚动');
  });
});

// ── AC-S2 / AC-S3 ─────────────────────────────────────────────────────────

test('AC-S2 电脑在线 ⇒ 徽标「打印电脑在线」；没连过 ⇒ 她定那句「未连接（任务已排队，打开小助手就会打）」', async () => {
  login();
  // ① 在线
  await withServer(appFor({ queue: fakeQueue({ online: true }) }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    assert.ok(block.includes(TEXTS.online), '在线那句必须原样出现');
    assert.ok(block.includes('label-print-badge--online'));
    assert.equal(block.includes(TEXTS.offline), false);
  });
  // ② 没连过（默认 offline）
  await withServer(appFor({ queue: fakeQueue({ online: false }) }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    assert.ok(block.includes(TEXTS.offline), '未连接那句必须原样出现（她要求手机上明确显示）');
    assert.ok(block.includes('label-print-badge--offline'));
  });
});

test('AC-S3 最近一次任务：已打印 / 失败 + 原因（原因同一行看得见）', async () => {
  login();
  await withServer(appFor({ queue: fakeQueue({ online: true, job: JOB({ status: 'done', status_label: '已打印' }) }) }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    assert.ok(block.includes(`${TEXTS.lastJobPrefix}已打印`), '最近一次要看得见');
  });
  await withServer(appFor({
    queue: fakeQueue({ online: true, job: JOB({ status: 'failed', status_label: '失败', failure_reason: '打印机没开' }) }),
  }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    assert.ok(block.includes(`${TEXTS.lastJobPrefix}失败`));
    assert.ok(block.includes('打印机没开'), '失败必须给原因');
  });
});

test('AC-S3 没有打印过 ⇒ 不显示"最近一次"那一行（不是空话）', async () => {
  login();
  await withServer(appFor({ queue: fakeQueue({ online: true, job: null }) }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    assert.equal(block.includes(TEXTS.lastJobPrefix), false);
  });
});

// ── AC-S4 / AC-S5 / AC-S9 ─────────────────────────────────────────────────

test('AC-S4 POST print_label ⇒ 把 URL 里那个编号排进队列 + 303 回本领域（PRG）', async () => {
  login();
  const queue = fakeQueue({ online: true });
  await withServer(appFor({ queue }), async (base) => {
    const response = await postPrint(base);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `/s/${ENCODED}?from=product&printed=1`);
    assert.equal(queue.calls.enqueue.length, 1);
    assert.equal(queue.calls.enqueue[0].number, NUMBER);
    assert.equal(queue.calls.enqueue[0].source, 'scan');
    assert.equal(queue.calls.enqueue[0].actor, 'ou_label_user', '谁点的要留痕（open_id）');
  });
});

test('AC-S9 编号只认 URL：表单里没有编号字段，改表单也打不了别的款', async () => {
  login();
  const queue = fakeQueue({ online: true });
  await withServer(appFor({ queue }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    const form = block.slice(block.indexOf('<form'), block.indexOf('</form>'));
    const inputs = form.match(/<input[^>]*>/g) || [];
    assert.equal(inputs.length, 1, '表单里只有一个隐藏字段（action）—— 编号只从 URL 来');
    assert.equal(/name="number"/.test(form), false);

    // 就算有人篡改表单塞一个别的编号，服务端也只用 URL 里的那个。
    const response = await postPrint(base, { number: 'OTHER|黑色|B' });
    assert.equal(response.status, 303);
    assert.equal(queue.calls.enqueue[0].number, NUMBER, '以 URL 为准');
  });
});

test('AC-S5 303 回来那一页（printed=1）出现「已提交打印」；不带参数则不出现', async () => {
  login();
  const queue = fakeQueue({ online: true });
  await withServer(appFor({ queue }), async (base) => {
    const submitted = productBlock(await (await getProduct(base, '?from=product&printed=1')).text());
    assert.ok(submitted.includes(TEXTS.enqueuedTitle), `要出现「${TEXTS.enqueuedTitle}」`);
    const plain = productBlock(await (await getProduct(base)).text());
    assert.equal(plain.includes(TEXTS.enqueuedTitle), false);
  });
});

// ── AC-S6 ─────────────────────────────────────────────────────────────────

test('AC-S6 ⭐ 打印不受"扫码写入口关着"影响（它不写任何业务表）—— writeService=false 也能打', async () => {
  login();
  const queue = fakeQueue({ online: true });
  await withServer(appFor({ queue, writeService: false }), async (base) => {
    // 销售那一块（写入口）此时是"人话卡"
    const sales = await (await fetch(`${base}/s/${ENCODED}?from=sales`, { headers: { cookie: sessionCookie() } })).text();
    assert.equal(sales.includes(SCAN_WRITE.actions.submitOrder), false, '写入口关着 ⇒ 销售表单不出现');

    // 但【打印这一款】照常可用（它在 503 那道闸门之前）。
    const response = await postPrint(base);
    assert.equal(response.status, 303, '打印不该被写入口的开关挡住');
    assert.equal(queue.calls.enqueue.length, 1);
  });
});

// ── AC-S7 ─────────────────────────────────────────────────────────────────

test('AC-S7 队列坏了 ⇒ 一句"打印服务暂时不可用" + 保留两条链接，绝不空白、也不 500', async () => {
  login();
  const queue = fakeQueue({ statusError: '磁盘满了' });
  await withServer(appFor({ queue }), async (base) => {
    const response = await getProduct(base);
    assert.equal(response.status, 200, '打印链路坏掉不该把这一页也弄坏');
    const html = await response.text();
    const block = productBlock(html);
    assert.ok(block.includes(TEXTS.unavailable), '如实说一句不可用');
    assert.equal(block.includes(TEXTS.printSingle), false, '不可用时不出那颗按钮');
    assert.ok(block.includes('href="/workbench/label-print.html"'), '原来那两条链接照旧');
    assert.ok(html.replace(/<[^>]*>/g, '').trim().length > 0, '去掉标签也必须有字（不空白）');
    assert.equal(html.includes('磁盘满了'), false, '内部错误细节不许回显');
  });
});

test('AC-S7 队列被显式关掉（isEnabled=false）⇒ 同样如实说一句 + 保留链接', async () => {
  login();
  await withServer(appFor({ queue: fakeQueue({ enabled: false }) }), async (base) => {
    const block = productBlock(await (await getProduct(base)).text());
    assert.ok(block.includes(TEXTS.unavailable));
    assert.equal(block.includes(TEXTS.printSingle), false);
  });
});

// ── AC-S8 ─────────────────────────────────────────────────────────────────

test('AC-S8 打不出来 ⇒ 人话页：她这一款没库存（400）原因原样；系统坏 502', async () => {
  login();
  await withServer(appFor({
    queue: fakeQueue({ enqueueError: Object.assign(new Error(`没有找到编号「${NUMBER}」的可打印标签（这一款现在可能没有库存）`), { statusCode: 400 }) }),
  }), async (base) => {
    const response = await postPrint(base);
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.ok(html.includes(TEXTS.enqueueFailedTitle), '要有标题');
    assert.ok(html.includes('这一款现在可能没有库存'), '原因原样给她');
    // ⚠️ 只断言**正文**没有脚本（head 里那一段是这一页既有的，与打印无关）——
    //    与 `scanPageRealmServerSide.test.js` 里那条既有断言同一口径。
    const messageBody = html.slice(html.indexOf('</head>'));
    assert.equal(/<script[\s>]/i.test(messageBody), false, '结果页正文也零脚本');
  });

  await withServer(appFor({ queue: fakeQueue({ enqueueError: new Error('打印文件生成失败：sharp 崩了') }) }), async (base) => {
    const response = await postPrint(base);
    assert.equal(response.status, 502);
    const html = await response.text();
    assert.ok(html.includes(TEXTS.unavailableTitle));
    // ⚠️ 5xx 那一侧不回显内部细节（与工作台其它接口同一条口径）。
    assert.equal(html.includes('sharp 崩了'), false);
  });
});

// ── AC-S10 ────────────────────────────────────────────────────────────────

test('AC-S10 别的领域一次都不碰打印队列（接了打印不许拖慢库存/销售）', async () => {
  login();
  const queue = fakeQueue({ online: true });
  await withServer(appFor({ queue }), async (base) => {
    for (const realm of ['sales', 'replenish', 'purchase_return', 'inventory']) {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(`${base}/s/${ENCODED}?from=${realm}`, { headers: { cookie: sessionCookie() } });
      assert.equal(response.status, 200);
    }
    assert.equal(queue.calls.status, 0, '这些领域不许读打印状态');
    assert.deepEqual(queue.calls.latest, [], '也不许查最近任务');
  });
});

test('AC-S1 别的领域里不出现【打印这一款】的表单（只在「货品」领域）', async () => {
  login();
  await withServer(appFor({ queue: fakeQueue({ online: true }) }), async (base) => {
    // ⚠️ 断言的是**表单元素**（样式 `.label-print-form` 本来就在整页 STYLE 里，那不是内容）。
    for (const realm of ['sales', 'inventory', 'replenish', 'purchase_return']) {
      // eslint-disable-next-line no-await-in-loop
      const html = await (await fetch(`${base}/s/${ENCODED}?from=${realm}`, { headers: { cookie: sessionCookie() } })).text();
      assert.equal(html.includes('<form class="label-print-form"'), false, `${realm} 领域不该有打印表单`);
    }
    const product = await (await getProduct(base)).text();
    assert.ok(product.includes('<form class="label-print-form"'), '「货品」领域必须有它');
  });
});
