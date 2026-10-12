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

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_accept_ar';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'accept_ar_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const SESSION_SECRET = 'accept-ar-secret';
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
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `accept-ar-${label}-`));

/** ⭐ 抓 `confirmBatchArrival` 的入参（= 写库那一刻的"实际数量 / 逐尺码清单 / 实际金额"）。 */
const createHarness = ({ rows = SIZES.map((size) => ({ size, quantity: 1 })), allowEmptyRows = false, twoProducts = false } = {}) => {
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
  const updates = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => records[key] || [],
    get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    // ⭐ 真网关有 update（`markArrived` → `setArrivalStatus` 靠它）——这里记下来并**真的改数据**，
    //    这样"到货状态有没有被写"与"未到货列表里还在不在"都能断言。
    update: async (key, recordId, values) => {
      updates.push({ table: key, recordId, values });
      // ⚠️ 真网关收的是**语义键**（`arrivalStatus`），落表时要翻成**物理列名**（「到货状态」）——
      //    假网关也必须这么做，否则"到货状态到底写没写"就断不出来。
      const mapping = V1_BITABLE_SCHEMA.tables[key].fields;
      const row = (records[key] || []).find((record) => record.record_id === recordId);
      if (row) {
        for (const [semantic, value] of Object.entries(values || {})) {
          if (!mapping[semantic]) throw new Error(`未配置语义字段: ${semantic}`);
          row.fields[mapping[semantic]] = value;
        }
      }
      return { recordId };
    },
  };
  const confirmCalls = [];
  // eslint-disable-next-line global-require
  const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
  const orderBatches = new PurchaseOrderBatchService({ gateway, texts: SCAN_WRITE.texts, events: SCAN_WRITE.events });
  const conversation = new PurchaseArrivalConversationService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('conv'), idField: 'task_id' }),
    sizeReferences: () => SIZE_STUB,
    confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
    // ⭐ 与工作台 / 对话到货**同一条路**：既有 `PurchaseOrderBatchService.markArrived`
    //    （它就是"把批次行到货状态写成已到货"的唯一实现）。
    markBatchArrived: (batchNo, arrivalOptions) => orderBatches.markArrived(batchNo, arrivalOptions),
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
  return { app, arrival, confirmCalls, updates, orderBatches };
};

const sessionCookie = (openId = 'ou_accept_ar') => {
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
const get = async (base, target, openId = 'ou_accept_ar') => {
  const response = await fetch(`${base}${target}`, { headers: { cookie: sessionCookie(openId) } });
  return { response, html: await response.text() };
};
const post = (base, target, body, openId = 'ou_accept_ar') => {
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



// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-12 21:15（她真机验收成功，但暴露两个真问题）
//   ① 验收成功后那一批的**「到货状态」仍是「未到货」** ✗ ⇒ 它继续躺在"未到货批次"列表里
//      ⇒ 她会以为没生效 / 重复验收 ✗（口径应与"对话到货点【是】"那条**一致**）。
//   ② 「实际金额」是必填，但页面上看不出来 ⇒ 她第一次提交被拒；**被拒后她填的内容还丢了** ✗。
//
//  AC-AR1 完成验收（入库成功）⇒ 批次行**真的被写成「已到货」**（断言写入值 + 目标记录）。
//  AC-AR2 完成后再看「未到货批次」列表 ⇒ **它不在了**。
//  AC-AR3 幂等：同一批再提交 ⇒ **不重复加库存**，状态仍是「已到货」。
//  AC-AR4 金额是必填 ⇒ 页面上**看得出来**（label 标注必填 + 一句提示）。
//  AC-AR5 金额为空被拒 ⇒ **她还填着的数量/金额不许丢**（页面带着它们回来 + 一句人话）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR1 完成验收 ⇒ 批次行的「到货状态」被写成「已到货」（断言写入值）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '500',
    });
    assert.equal(done.status, 200, `完成验收要成（${done.status}）`);
    const updates = h.updates.filter((item) => item.table === 'purchaseOrderBatch');
    assert.ok(updates.length >= 1,
      `验收成功后必须写回批次行的到货状态（实际写入：${JSON.stringify(h.updates)}）`);
    assert.equal(updates[updates.length - 1].recordId, BATCH_ID, '写的是这一批那一行');
    assert.equal(updates[updates.length - 1].values.arrivalStatus, '已到货',
      `到货状态要写成「已到货」（口径与对话到货同一条）：${JSON.stringify(updates)}`);
  });
});

test('AC-AR2 完成之后 ⇒ 「未到货批次」列表里不再有它', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const before = await get(base, '/s/accept');
    assert.ok(before.html.includes(`data-batch="${BATCH}"`), '完成前它应该在未到货列表里');
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '500',
    });
    const after = await get(base, '/s/accept');
    assert.equal(after.html.includes(`data-batch="${BATCH}"`), false,
      '验收完成后她不该再看到这一批（否则她会以为没生效 / 重复验收）');
  });
});

test('AC-AR3 幂等：同一批再提交 ⇒ 不重复加库存，状态仍是「已到货」', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '500',
    });
    const first = h.confirmCalls.length;
    const again = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '500',
    });
    assert.ok(again.status < 500, '重复提交不许炸');
    assert.equal(h.confirmCalls.length, first, '重复提交不许再走一遍入库');
    const updates = h.updates.filter((item) => item.table === 'purchaseOrderBatch' && item.values.arrivalStatus === '已到货');
    assert.ok(updates.length >= 1, '状态仍应是「已到货」');
  });
});

test('AC-AR4 金额必填 ⇒ 页面上看得出来（label 标注 + 一句提示）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(html.includes(T.acceptFinishAmountLabel), '金额那一栏要在');
    assert.ok(/实际金额（?必填）?|（必填）/.test(html), `要标明必填（实际 label：${T.acceptFinishAmountLabel}）`);
    assert.ok(html.includes('data-view="accept-amount-required"') || /required/.test(html),
      '输入框本身也要带 required（前端可感知）');
  });
});

test('AC-AR5 金额为空被拒 ⇒ 她填的数量/金额不许丢（页面带着它们回来）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    // 她改了数量（37 → 2）但金额忘填 ⇒ 后端人话拒绝（既有口径保留）
    const rejected = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '2', '1', '1'], [F.acceptAmount]: '',
    });
    assert.ok(rejected.status >= 400 && rejected.status < 500, `金额不合法要被拒（实际 ${rejected.status}）`);
    const body = await rejected.text();
    assert.ok(/实际金额|金额/.test(body), '要给人话（说清是金额的问题）');
    // ⭐ 关键：她改过的数量（37=2）与她已经输的内容**必须原样回来**，不许罚她重填
    assert.ok(/data-view="acceptance-rows"/.test(body) || /accept_row_qty/.test(body),
      '被拒时要回到那张清单（不是一张光秃秃的错页）');
    assert.ok(new RegExp(`name="accept_row_qty" value="2"`).test(body),
      '她改过的数量（37 码 = 2）要回显');
  });
});

test('AC-AR6 反馈脚本**永不产生空文案**（按钮绝不变空白）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const attrs = [...html.matchAll(/data-submit-feedback="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(attrs.length >= 1, '按钮要带反馈属性');
    for (const value of attrs) assert.ok(value.trim().length > 0, '反馈文案不许是空串（按钮才不会变空白）');
    const start = html.indexOf('<script data-view="submit-feedback">');
    const script = html.slice(start, html.indexOf('</script>', start));
    assert.ok(script.includes('button.textContent'), '脚本文案要有兜底（按钮原文案）');
    assert.ok(/disabled\s*=\s*true/.test(script), '点下去要置灰');
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'accept_amount']) {
      assert.equal(script.includes(forbidden), false, `这一段不许干别的：${forbidden}`);
    }
  });
});

test('AC-AR7 金额空/0 ⇒ 前端**看得出来**（label 标明必填 + required + 静态提示），后端人话仍在', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    const { html } = await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    assert.ok(html.includes('实际金额（必填）'), 'label 要标明必填');
    assert.ok(/name="accept_amount"[^>]*required/.test(html), '输入框要带 required');
    assert.ok(html.includes('data-view="accept-amount-required"'), '要有一句静态提示');
    assert.ok(html.includes(SCAN_PAGE.texts.acceptAmountRequiredHint), '提示文案来自配置（scanPage 的 texts）');
  });
});

test('AC-AR8 成功后**明确成功页**：实际数量 + 实际金额 + 回列表链接', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.action_placeholder || F.action]: A.acceptFinishRows,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '10',
    });
    assert.equal(done.status, 200);
    const body = await done.text();
    assert.ok(body.includes('验收已完成'), `成功后要有明确成功页：${(body.match(/<p>[^<]*<\/p>/) || [])[1]}`);
    assert.ok(/5/.test(body), '要带**实际数量**（5）');
    assert.ok(/10/.test(body), '要带**实际金额**（10）');
    assert.ok(/href="[^"]*\/accept"/.test(body), '要有【回到未到货批次】的链接');
  });
});

test('AC-AR9 ⭐ 部分到货（报 5 双只到 3 双）⇒ 状态**同样是「已到货」**（她 2026-10-12 拍的口径）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    // 她的口径（逐字）：「只要用户验收了，状态就会变成「已到货」」——部分到货也算 ✓
    const done = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '0', '0'], [F.acceptAmount]: '300',
    });
    assert.equal(done.status, 200, `部分到货也要能完成验收（${done.status}）`);
    const lines = h.confirmCalls[0].scanLines;
    assert.equal(lines.reduce((sum, line) => sum + line.quantity, 0), 3, '实际到货 = 3 双');
    const updates = h.updates.filter((item) => item.table === 'purchaseOrderBatch' && item.values.arrivalStatus);
    assert.ok(updates.length >= 1, '部分到货也要写到货状态');
    assert.equal(updates[updates.length - 1].values.arrivalStatus, '已到货',
      '部分到货 ⇒ 照样「已到货」（实际数量另记 3）');
    // 而且它不该再躺在"未到货批次"里
    const after = await get(base, '/s/accept');
    assert.equal(after.html.includes(`data-batch="${BATCH}"`), false, '部分到货验收完也不该再出现在未到货列表');
  });
});

test('AC-AR10 失败（金额非法 / 没会话）⇒ **不许**写「已到货」✗（只在该成功时写）', async () => {
  login();
  const h = createHarness();
  await withServer(h.app, async (base) => {
    await get(base, `/s/accept?batch=${encodeURIComponent(BATCH)}`);
    // ① 金额为空 ⇒ 被拒（人话页把她的内容带回来）——但**状态一个都不许写**
    const rejected = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1', '1', '1', '1', '1'], [F.acceptAmount]: '',
    });
    assert.ok(rejected.status >= 400 && rejected.status < 500, '金额不合法要被拒');
    assert.equal(h.updates.filter((item) => item.values && item.values.arrivalStatus).length, 0,
      '被拒时**不许**写「已到货」（否则她表上就是假的"已到货"）');
    // ⚠️ `confirmBatchArrival` 会**进到校验入口**（金额不合法在那里当场拒）⇒ 断"没入库"要看
    //    **会话没被标成 posted** + **一张业务表都没写**，不是"没调那个函数"。
    const session = await h.arrival.get('ou_accept_ar');
    assert.equal(session.status, 'open', '被拒时这一场验收还开着（= 没入库）');
    // 它仍然躺在"未到货批次"列表里（本来就是未到货）
    const still = await get(base, '/s/accept');
    assert.ok(still.html.includes(`data-batch="${BATCH}"`), '失败 ⇒ 它当然还在未到货列表里');
    // ② 没有会话时提交（另一个 openId）⇒ 同样不许写到货状态
    const stranger = await post(base, '/s/accept', {
      [F.action]: A.acceptFinishRows, batch: BATCH,
      [F.acceptRowQty]: ['1'], [F.acceptAmount]: '100',
    }, 'ou_nobody');
    assert.ok(stranger.status >= 400, '没会话要被人话拒绝');
    assert.equal(h.updates.filter((item) => item.values && item.values.arrivalStatus).length, 0,
      '没会话时也不许写到货状态');
  });
});
