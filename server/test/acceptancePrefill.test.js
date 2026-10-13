/**
 * ⭐⭐ 2026-10-12（业务负责人口述版，落档 `docs/acceptance-scan-design-2026-10-12.md`）：
 *   「用户点验收的时候，**先默认带出我们采购申请里的尺码和数量**。用户可以在**给定的区域里
 *     直接修改**，同时**也可以自定义**；**自定义的时候同样支持扫码**。」
 *
 * 本文件钉的就是这段：**进验收 ⇒ 明细预填成一张可编辑清单**（默认 = 报货数量）+ 可改 + 可自定义
 * + 扫码加一款 + 完成时写「实际数量（各行之和）」/「实际金额」+ **逐尺码加库存**（既有口径）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-AP1 进验收（`GET /s/accept?batch=…`）⇒ **明细逐字预填**（35×1 · 36×1 · 37×1 ⇒ 每个尺码一个
 *         数量输入框，`value` = **报货数量**）+ 实际金额输入框 + 确认完成验收（表单字段名来自配置）。
 *  AC-AP2 **改数量**（37 改成 2）⇒ 完成后写进去的 `scanLines` / 「实际数量」= **改后各行之和**。
 *  AC-AP3 **改成 0** ⇒ 那一行**不算到货**（不进 `scanLines`、不加库存）。
 *  AC-AP4 ⚠️ **自定义加一行**：**能加进清单（会话里看得见）**；但在"完成"这一步会被**既有**链路
 *         按「这一双不在本批」**如实拦住** —— 因为 `purchaseArrivalConversationService.buildPlan`
 *         只认"有采购明细的那几行"（该文件**不在本轮文件面**）。
 *         ⇒ 本条钉的是**不 500、不静默丢、有一句人话**；真正"自定义行也能入库"要等她拍业务口径
 *         （加到哪个款 / 未报货尺码怎么办）+ 授权改那个文件。（报告里单列 ✓）
 *  AC-AP5 ⭐ **扫码加一款**：走既有 `accept_add` 扫进来 ⇒ 该款**出现在清单里**（可继续改数量）。
 *  AC-AP6 **完成** ⇒ 既有口径一字不变：`actualAmount` 原样交给 `confirmBatchArrival` +
 *         **逐尺码** `scanLines`（每一行 货品/尺码/数量）。
 *  AC-AP7 没有采购明细的批次（开关打开）⇒ 页面仍 **200** + 仍能手输自定义 / 扫码加（**不崩**）。
 *  AC-AP8 回归：既有「加入本次验收」表单与自助块**逐字还在**（`name=accept_size` / `accept_quantity`）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_prefill';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_prefill_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-prefill-secret';
const NUMBER = 'YD6693-2|黑色|A';
const BATCH = 'CGD-20261012-0001';
const BATCH_ID = 'batch_a';
const SIZES = [35, 36, 37, 38, 39];
const T = SCAN_WRITE.texts;
const F = SCAN_WRITE.fields;
const A = SCAN_WRITE.actions;

const VIEW = {
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色', category_name: '休闲鞋',
  category_code: 'A', price_text: '¥399', total: 2, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '37', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-12 16:00',
  product_record_id: 'prod_1',
};
const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-prefill-${label}-`));

/** ⭐ 抓 `confirmBatchArrival` 的入参（= 写库那一刻的"实际数量 / 逐尺码清单 / 实际金额"）。 */
// ⚠️ 2026-10-13 加了 `successReturn`：`AC-AH1` 要**换一个配置值**看成功页跳转目标变不变（行为断言 ✓）
const createHarness = ({ rows = SIZES.map((size) => ({ size, quantity: 1 })), allowEmptyRows = false, twoProducts = false, successReturn = null } = {}) => {
  const records = {
    purchaseOrderBatch: [{ record_id: BATCH_ID, fields: { 报货批次号: BATCH, 到货状态: '未到货', 供应商: [{ text: '大发鞋厂' }] } }],
    purchaseRequest: [
      ...rows.map((row, index) => ({
        record_id: `pr_${index + 1}`,
        fields: { 报货批次号: [BATCH_ID], 编号: ['prod_1'], 尺码: [`size_${row.size}`], 数量: row.quantity },
      })),
      // 第二款（只在她要验"多款"那条 AC 时加）
      ...(twoProducts ? [{
        record_id: 'pr_other',
        fields: { 报货批次号: [BATCH_ID], 编号: ['prod_2'], 尺码: ['size_40'], 数量: 1 },
      }] : []),
    ],
    product: [
      { record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } },
      ...(twoProducts ? [{ record_id: 'prod_2', fields: { 编号: 'XHB8095|棕色|A', 货号: 'XHB8095', 颜色: { text: '棕色' } } }] : []),
    ],
    sizeManagement: SIZES.map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    behavior: [],
  };
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records[key] || [],
    get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
  };
  const confirmCalls = [];
  const conversation = new PurchaseArrivalConversationService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'task_id' }),
    sizeReferences: () => SIZE_STUB,
    confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
    markBatchArrived: async () => ({ updated: true }),
  });
  const originalConfirm = conversation.confirmBatchArrival.bind(conversation);
  conversation.confirmBatchArrival = async (input) => {
    confirmCalls.push(input);
    return originalConfirm(input);
  };
  const config = allowEmptyRows
    ? { ...SCAN_WRITE.acceptance, allowEmptyRows: true }
    : SCAN_WRITE.acceptance;
  const arrival = createScanArrivalService({
    gateway,
    config,
    texts: T,
    events: SCAN_WRITE.events,
    purchaseQuery: createPurchaseQueryService(gateway, { sizeReferences: SIZE_STUB }),
    arrivalConversation: conversation,
    store: new JsonTaskStore({ dir: tempDir('session'), idField: 'session_id' }),
  });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    // ⚠️ 只在 AC-AH1 里覆盖 `successReturn`（其余用例走真实配置 ✓）
    ...(successReturn ? { config: { ...SCAN_PAGE, successReturn: { ...SCAN_PAGE.successReturn, ...successReturn } } } : {}),
    service: { lookup: async () => VIEW },
    gateway: { table: () => ({ fields: {} }), listAll: async () => [], get: async () => null },
    // ⚠️ 逐码页的 POST 走的是"写入口"那道闸门 ⇒ 没它一律 503（与线上同一道闸门）。
    //    这里给一个最小的替身（本文件只验验收那一段，不碰销售写入）。
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'scan_sale:test:1' },
      addSaleLine: async () => ({ ok: false }),
      submitSale: async () => ({ ok: false }),
      clearDraft: async () => ({ ok: true }),
    },
    arrivalService: arrival,
    writeConfig: { ...SCAN_WRITE, acceptance: config },
  }));
  return { app, arrival, confirmCalls };
};

const sessionCookie = (openId = 'ou_accept_prefill') => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = async (base, target, openId = 'ou_accept_prefill') => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie(openId) } });
  return { response, html: await response.text() };
};
const post = (base, target, body, openId = 'ou_accept_prefill') => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
    else params.append(key, String(value));
  }
  return fetch(`${base}${target}`, {
    method: 'POST',
    headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};

// ── AC-AP1 ────────────────────────────────────────────────────────────────
test('AC-AP1 进验收 ⇒ 明细**逐字预填**（35×1…39×1）+ 实际金额 + 确认完成验收', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(response.status, 200);
    assert.ok(html.includes(`data-view="acceptance-rows"`), '要有"这次要核对的尺码和数量"那一块');
    // 每个报货尺码一行，默认值 = **报货数量**
    for (const size of SIZES) {
      assert.ok(new RegExp(`data-row-size="${size}"`).test(html), `清单里要有 ${size} 码那一行`);
      assert.ok(html.includes(`name="${F.acceptRowQty}" value="1"`), `${size} 码的默认值要带出报货数量 1`);
    }
    assert.ok(html.includes(`name="${F.acceptAmount}"`), '实际金额输入框仍在（既有口径：必填）');
    assert.ok(html.includes(T.acceptFinishSubmit), '确认完成验收那颗按钮');
    // 扫码加一款的入口（AppLink / 【继续扫下一个】那一套复用）
    assert.ok(html.includes(SCAN_PAGE.texts.scanNextHint) || html.includes(SCAN_PAGE.texts.scanNextLabel),
      '自定义扫码的入口必须在（非飞书 UA 下给的是那句人话 / 飞书里是真按钮）');
  });
});

// ── AC-AP2 / AC-AP3 / AC-AP6 ──────────────────────────────────────────────
test('AC-AP2/AP3/AP6 改数量（37→2）+ 一行改 0 ⇒ 实际数量 = 改后之和 + 逐尺码 scanLines + 实际金额原样', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    // 35×1 · 36×1 · 37→**2** · 38→**0** · 39×1
    const response = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows,
      batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '2', '0', '1'],
      [F.acceptAmount]: '500',
    });
    assert.equal(response.status, 200, `完成验收要成（${response.status}）`);
    assert.equal(h.confirmCalls.length, 1, '要真的走到"确认到货"那一步');
    const call = h.confirmCalls[0];
    // ① 实际数量 = 各行之和（1+1+2+0+1 = 5）：以逐尺码 scanLines 的形式给既有链路
    assert.deepEqual(call.scanLines, [
      { product_record_id: 'prod_1', size: 35, quantity: 1 },
      { product_record_id: 'prod_1', size: 36, quantity: 1 },
      { product_record_id: 'prod_1', size: 37, quantity: 2 },
      { product_record_id: 'prod_1', size: 39, quantity: 1 },
    ], '逐尺码清单：改后的数量 + **改 0 的那一行不算到货**');
    // ② 实际金额原样交下去（既有口径）
    assert.equal(call.actualAmount, '500');
    // ③ 验收原话 = 扫码事实的复述（既有模板）
    assert.ok(String(call.acceptanceText).includes('37 码 2 双'), `到货说明要复述实际数量：${call.acceptanceText}`);
    assert.equal(String(call.acceptanceText).includes('38 码'), false, '改 0 的那一行不许写进到货说明');
  });
});

// ── AC-AP4 ────────────────────────────────────────────────────────────────
test('AC-AP4 ⭐ 自定义尺码 + 归到"她扫进来的那一款" ⇒ 完成验收时**计入库存**', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const response = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows,
      batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'],
      // ⭐ 自定义：没报过的 41 码到了 2 双（本批只有一个款 ⇒ 归到那一款）
      [F.acceptCustomSize]: ['41'],
      [F.acceptCustomQuantity]: ['2'],
      [F.acceptAmount]: '800',
    });
    assert.equal(response.status, 200, `自定义行要能完成验收（${response.status}）`);
    assert.equal(h.confirmCalls.length, 1, '要真的走到"确认到货"那一步');
    const lines = h.confirmCalls[0].scanLines;
    // ① 自定义那一行进**逐尺码清单**（= 会逐尺码加库存的那份输入）
    const extra = lines.filter((line) => Number(line.size) === 41);
    assert.deepEqual(extra, [{ product_record_id: 'prod_1', size: 41, quantity: 2 }],
      `自定义行要归到"她扫进来的那一款"并计入：${JSON.stringify(lines)}`);
    // ② 报货行照旧（5 行 + 1 行自定义 = 6 行；改 0 的语义由 AC-AP2/AP3 钉着）
    assert.equal(lines.length, 6, '5 行报货 + 1 行自定义');
    // ③ 这一场验收**真的收尾了**（既有链路写成功才会落 `posted`）
    const session = await h.arrival.get('ou_accept_prefill');
    assert.equal(session.status, 'posted', '完成验收后会话必须收尾（= 既有的入库那一步走通了）');
    // ④ 「实际数量」= 各行之和（7 双）—— 由既有链路按 plan 求和，这里断言它算得到 7
    assert.equal(session.scanned, 7, '实际数量 = 5（报货行）+ 2（自定义行）');
  });
});

test('AC-AP9 多款批次：她**没指明哪一款**就提交自定义 ⇒ 拒 + 人话（不猜款 ✗）', async () => {
  login();
  const h = createHarness({ twoProducts: true });
  await withServer(h.app, async (base) => {
    const page = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(page.response.status, 200, '两款也能进验收页（清单照旧按明细预填）');
    const response = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1', '1'],
      [F.acceptCustomSize]: ['41'], [F.acceptCustomQuantity]: ['1'], [F.acceptAmount]: '100',
    });
    assert.equal(response.status, 400, '多款 + 没指明 ⇒ 不许猜着入到某一款上');
    const body = await response.text();
    assert.ok(body.includes(T.acceptCustomProductNeededBody), '要给人话：请扫这一款的标签');
    assert.equal(h.confirmCalls.length, 0, '被拦住 ⇒ 一次库都不许写');
    const session = await h.arrival.get('ou_accept_prefill');
    assert.equal(session.status, 'open', '这一场验收还开着（没记账）');
  });
});

// ── AC-AP5 ────────────────────────────────────────────────────────────────
test('AC-AP5 ⭐ 扫码加一款 ⇒ 该款出现在清单里（可继续改数量）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    // 她扫这一款的标签 ⇒ 逐码页上【加入本次验收】（既有 accept_add，一个字没改）
    const added = await post(base, `/s/${encodeURIComponent(NUMBER)}?from=accept`, {
      [F.action]: A.acceptAdd, [F.acceptSize]: '37', [F.acceptQuantity]: '2',
    });
    assert.equal(added.status, 200, `【加入本次验收】要能用（${added.status}）`);
    // 回到验收页 ⇒ 扫码那一行**在清单里**
    const { html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(html.includes('data-view="acceptance-rows"'), '清单还在');
    assert.ok(new RegExp(`data-row-size="37"[^>]*`).test(html) || html.includes('value="2"'),
      '扫到的那一双（37 码 2 双）要出现在清单里，并能继续改');
  });
});

// ── AC-AP7 ────────────────────────────────────────────────────────────────
test('AC-AP7 没有采购明细的批次（开关打开）⇒ 页面仍 200 + 仍能手输/扫码加（不崩）', async () => {
  login();
  const h = createHarness({ rows: [], allowEmptyRows: true });
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(response.status, 200, '没有明细也不是死路（开关打开时）');
    assert.ok(html.includes('data-view="acceptance-rows"'), '清单那一块照旧在（只是空的）');
    assert.ok(html.includes(`name="${F.acceptCustomSize}"`), '手输自定义仍在');
    // 手输一行 + 完成：**款从哪来不知道** ⇒ 不许猜、不许 500 —— 给一张"请扫标签"的人话页。
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptCustomSize]: ['40'], [F.acceptCustomQuantity]: ['1'], [F.acceptAmount]: '200',
    });
    assert.ok(done.status < 500, `不许 500（实际 ${done.status}）`);
    if (done.status !== 200) {
      const body = await done.text();
      assert.ok(body.includes(T.acceptCustomProductNeededBody),
        '要么做成，要么明确告诉她"这一批认不出是哪一款 ⇒ 请扫标签"（不猜款 ✗）');
    }
    assert.equal(h.confirmCalls.length, 0, '款都不知道时**一次库都不许写**');
  });
});

// ── AC-AP8 回归 ───────────────────────────────────────────────────────────
test('AC-AP8 回归：既有「加入本次验收」表单字段与文案逐字还在', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    // ⚠️ 真实入口是这样的（既有口径，一字未改）：正开着一场验收时**裸扫**一个标签
    //    （不带 `?from=`）⇒ 服务端认出"她在验收" ⇒ 这一页就是验收模式那一块。
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const { response, html } = await get(base, `/s/${encodeURIComponent(NUMBER)}`);
    assert.equal(response.status, 200);
    assert.ok(html.includes(`name="${F.acceptSize}"`), '既有尺码单选名不许改');
    assert.ok(html.includes(`name="${F.acceptQuantity}"`), '既有数量字段名不许改');
    assert.ok(html.includes(T.acceptAddButton), '【加入本次验收】文案逐字还在');
    assert.ok(html.includes(`data-view="acceptance"`), '验收那一块还在');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12（她选的方案 A，逐字）：
//   「系统把 40、41 列出来（标注"未报货"）⇒ 你**点一下就加到货** ✓（少打字）」
//
//  AC-AP10 候选 = 应有尺码 − 已报尺码：逐个渲染（`data-candidate-size`）+ 标注"未报货"。
//  AC-AP11 点一下 ⇒ **302 回清单** + 该尺码进"已加"（数量默认 1、归到这一款）。
//  AC-AP12 ⭐ 点它就等于到货 ⇒ 完成验收时**计入库存**（走自定义行同一条路）。
//  AC-AP13 再点一下 ⇒ **取消**（从"已加"里消失，合计同步变化）。
//  AC-AP14 没有"款"可归 ⇒ **不渲染该区** + 一句引导（列了也没用）。
//  AC-AP15 一个候选都没有（该类别全报过了）⇒ **整块不渲染**（不给空标题）。
//  AC-AP16 回归：候选口径**只来自配置**（同一份缺码口径），扫码页那三条路不受影响。
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORY_A_SIZES = [38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48];

const candidatesOf = (html) => {
  const block = (html.match(/<div class="size-chips" data-view="accept-unreported">([\s\S]*?)<\/div>/) || [])[1];
  return block ? [...block.matchAll(/data-candidate-size="(\d+)"/g)].map((m) => Number(m[1])) : [];
};
// ⚠️ 必须 `redirect: 'manual'`：点一下是 **303 回清单**，不 manual 的话 fetch 会把重定向跟完，
//    看到的是最终页面（200）而不是那条 303 本身。
const postToggle = (base, sizes, body = {}, openId = 'ou_accept_prefill') => fetch(`${base}/s/accept`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(Object.entries({
  [F.action]: A.acceptToggleSize,
  batch: BATCH,
  [F.acceptRowQty]: ['1', '1', '1', '1', '1'],
  [F.acceptToggleSize]: sizes,
  [F.acceptAmount]: '500',
  ...body,
}).flatMap(([key, value]) => (Array.isArray(value) ? value.map((item) => [key, String(item)]) : [[key, String(value)]]))).toString(),
});

test('AC-AP10 "没报货的尺码"候选 = 应有尺码 − 已报（逐个渲染 + 标注"未报货"）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(html.includes('data-view="accept-unreported"'), '要有"没报货的尺码"那一区');
    const found = candidatesOf(html);
    const expected = CATEGORY_A_SIZES.filter((size) => !SIZES.includes(size));
    assert.deepEqual(found, expected,
      `候选 = 该类别应有尺码(${CATEGORY_A_SIZES.join(',')}) − 已报(${SIZES.join(',')})`);
    assert.ok(html.includes(T.acceptUnreportedBadge), '每个候选要标注「未报货」');
    for (const size of found) {
      assert.ok(new RegExp(`data-candidate-size="${size}"`).test(html), `${size} 码要在候选里`);
    }
  });
});

test('AC-AP11 点一下 ⇒ 302 回清单 + 该尺码进"已加"（数量默认 1）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const response = await postToggle(base, ['41']);
    assert.equal(response.status, 303, `点一下应当是 302/303 回清单（实际 ${response.status}）`);
    assert.ok(String(response.headers.get('location') || '').includes(encodeURIComponent(BATCH)),
      '回的是这一批的验收页');
    const after = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(new RegExp(`data-row-size="41"[^>]*data-custom-row="1"`).test(after.html)
      || /data-custom-row="1"[\s\S]{0,200}data-row-size="41"/.test(after.html),
      '41 码要出现在"已加"里');
    // 数量默认 1：会话里那一行 = 41 码 1 双，归到这一款
    const session = await h.arrival.get('ou_accept_prefill');
    // 会话里存的是**整张清单**（5 行报货 + 刚点进来的 41）——点一下没冲掉她已经填的数量 ✓
    assert.deepEqual(session.scans.find((line) => Number(line.size) === 41),
      { product_record_id: 'prod_1', size: 41, quantity: 1 },
      `点一下要记一行（数量默认 1、归到这一款）：${JSON.stringify(session.scans)}`);
    assert.equal(session.scans.length, 6, '整张清单 = 5 行报货 + 1 行点进来的（她的改动没丢）');
    assert.equal(candidatesOf(after.html).includes(41), false, '已经加进来的不再当候选');
    assert.equal(session.scanned, 6, '合计同步（5 行报货 + 1 双点进来的）');
  });
});

test('AC-AP12 ⭐ 点它就等于到货 ⇒ 完成验收时**计入库存**（自定义行同一条路）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    await postToggle(base, ['41']);
    const response = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'],
      [F.acceptCustomSize]: ['41'], [F.acceptCustomQuantity]: ['1'],
      [F.acceptAmount]: '600',
    });
    assert.equal(response.status, 200, `完成验收要成（${response.status}）`);
    const lines = h.confirmCalls[0].scanLines;
    assert.ok(lines.some((line) => line.size === 41 && line.quantity === 1),
      `点进来的那一码要计入库存：${JSON.stringify(lines)}`);
    assert.equal(h.confirmCalls[0].actualAmount, '600', '实际金额照旧原样交下去');
  });
});

test('AC-AP13 再点一下 ⇒ 取消（从"已加"消失、合计同步变化）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    await postToggle(base, ['41']);
    assert.equal((await h.arrival.get('ou_accept_prefill')).scanned, 6);
    const second = await postToggle(base, ['41']);
    assert.equal(second.status, 303, '再点一下同样回清单');
    const session = await h.arrival.get('ou_accept_prefill');
    assert.equal(session.scans.some((line) => Number(line.size) === 41), false,
      `再点一下要取消那一行：${JSON.stringify(session.scans)}`);
    assert.equal(session.scanned, 5, '合计同步退回 5（只剩报货那几行）');
    const after = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(candidatesOf(after.html).includes(41), '取消之后 41 又回到候选里（可以再点）');
  });
});

test('AC-AP14 没有"款"可归 ⇒ 不渲染该区 + 一句引导（列了也没用）', async () => {
  login();
  const h = createHarness({ rows: [], allowEmptyRows: true });
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(response.status, 200);
    assert.equal(html.includes('data-view="accept-unreported"'), false, '没有款 ⇒ 不许列候选');
    assert.ok(html.includes(T.acceptUnreportedNoProductBody), '要给她一句"先扫这一款的标签"');
  });
});

test('AC-AP15 一个候选都没有（该类别全报过）⇒ 整块不渲染（不给空标题）', async () => {
  login();
  const all = CATEGORY_A_SIZES.map((size) => ({ size, quantity: 1 }));
  const h = createHarness({ rows: all });
  await withServer(h.app, async (base) => {
    const { response, html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.equal(response.status, 200);
    assert.equal(html.includes('data-view="accept-unreported"'), false,
      '全都报过了 ⇒ 那一区整块不渲染（也不许留一个空标题）');
    assert.equal(html.includes(T.acceptUnreportedBadge), false, '「未报货」那几个字也不许露出来');
  });
});

test('AC-AP16 候选口径**只来自配置**（与缺码同一份；不另发明一套、不读表）', () => {
  const service = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
  // 只有两处读那个段配置：① `sizesForCategory`（唯一实现，缺码与验收候选共用）
  //                              ② 既有的"配置与尺码管理一致性" warn（2026-10-09 就在，不属本批）
  assert.equal((service.match(/sizeSegments\?\.ranges/g) || []).length, 2,
    '"应有尺码"只该有**一处实现**（`sizesForCategory`）——缺码与验收候选共用它');
  assert.ok(/const loadSizeScope = async \(\{ categoryCode \}\) => sizesForCategory\(categoryCode, config\)/.test(service),
    '缺码判定必须**委托**给那个共用件（不许自己再拼一遍尺码段）');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.ok(/unreportedSizesFor[\s\S]{0,800}sizesForCategory\(/.test(route),
    '验收候选必须调那一个共用件（不许自己拼尺码段）');
  assert.equal(/sizeManagement/.test(route.slice(route.indexOf('unreportedSizesFor'), route.indexOf('const acceptanceContext'))), false,
    '候选**零读表**（纯配置）⇒ "读表失败"这条路天然不存在');
});

// ── AC-AH1 ⭐⭐ 2026-10-13（独立复核：`acceptHome` 原来是**假配置** —— 有定义、有注释、**零读取点** ✗）
//    行为断言：**换一个配置值 ⇒ 验收成功页的跳转目标必须随之变**（改配置零变化 ⇒ 这条就红 ✗）
test('AC-AH1 ⭐ acceptHome 是**真配置**：pendingBatches ⇒ 批次列表；lastBatch ⇒ 刚验完那一批', async () => {
  login();
  // 默认（`pendingBatches`）：回**未到货批次列表**（她 2026-10-12 选的 ① ✓）
  const h1 = createHarness();
  await withServer(h1.app, async (base) => {
    // ⚠️ 先 GET 一下：这一场验收要**开着**（预填就是那一步落下的 ✓ 漏了会 400 ✗ 我踩过）
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: SIZES.map(() => '1'), [F.acceptAmount]: '200',
    });
    assert.equal(done.status, 200, `要出成功页（实际 ${done.status}）`);
    const html = await done.text();
    const meta = (html.match(/http-equiv="refresh"[^>]*url=([^">]+)/) || [])[1] || '';
    assert.ok(meta.endsWith('/s/accept'), `默认落点 = 批次列表（实际 ${meta}）`);
    assert.equal(meta.includes('?batch='), false, '默认**不带** batch（带了她又回到刚做完那一批 ✗）');
  });
  // 换成 `lastBatch`：落点**必须变**（这条就是"能不能抓到假配置"的判据 ✓）
  const h2 = createHarness({ successReturn: { acceptHome: 'lastBatch' } });
  await withServer(h2.app, async (base) => {
    // ⚠️ 先 GET 一下：这一场验收要**开着**（预填就是那一步落下的 ✓ 漏了会 400 ✗ 我踩过）
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: SIZES.map(() => '1'), [F.acceptAmount]: '200',
    });
    assert.equal(done.status, 200);
    const html = await done.text();
    const meta = (html.match(/http-equiv="refresh"[^>]*url=([^">]+)/) || [])[1] || '';
    assert.ok(meta.includes(`?batch=${encodeURIComponent(BATCH)}`),
      `换成 lastBatch ⇒ 落点要变成"刚验完那一批"（实际 ${meta}）—— 假配置下这里会是 /s/accept ✗`);
    // 返回按钮与自动跳转**同一个 URL**（唯一来源 ✓）
    assert.ok(html.includes(`href="${meta}"`) || html.includes(`href="${meta.replace(/&/g, '&amp;')}"`),
      '返回按钮与自动跳转要一致（一处改 ✓）');
  });
});

// ── AC-AH2 源码哨兵：路由**真读**配置 + 那句不实注释已删 ──────────────────
test('AC-AH2 源码哨兵：验收成功页真读 `successReturn.acceptHome`（不再写死）+ 注释不再骗人', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const route = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
  assert.match(route, /resolveAcceptHomePath\(/, '要走映射表（一处改 ✓）');
  assert.match(route, /config\.successReturn && config\.successReturn\.acceptHome/, '要真读配置值');
  assert.equal(/走配置 `SUCCESS_RETURN\.acceptHome`/.test(route), false, '那句"走配置"的不实注释要改掉 ✗');
  const cfg = fs.readFileSync(path.join(__dirname, '../src/config/scanPage.js'), 'utf8');
  assert.match(cfg, /function resolveAcceptHomePath/, '⚠️ 必须用**函数声明**（const 箭头会撞 TDZ ✗）');
  assert.match(cfg, /lastBatch:/, '映射表至少两个**不同且有效**的值（否则抓不到假配置 ✗）');
});
