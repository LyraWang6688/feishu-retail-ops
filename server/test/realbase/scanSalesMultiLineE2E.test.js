'use strict';

/**
 * 真实测试 Base E2E：**一单多货冒烟**（每单 2 行；A 男 / B 女 各 1 张）。
 *
 * 入口（与工作台前端完全同一条）：
 *   货品页 `/r/:recordId?from=sales` →「＋ 再加一双」`add_line`（只写会话）
 *   →「提交这一单」`submit_order`（→ 资金页）→ `payment_pay`（异步入队）→ worker 写四表。
 *
 * 断言（验收标准，先写后跑）：
 *   ① `payload.lines` 是**多行**（= 本单行数 2），逐行带 product_record_id / size / actual_amount；
 *   ② 销售主表 **1 条**（按销售单号回查到且只有 1 条），`总金额` = 各行实收之和；
 *   ③ 销售明细 **N 条**（N = 本单行数），每行 `实收金额` 与这一行填的一致；
 *   ④ 收款明细 = 本单填的收款行（2 行 × 100），合计 = 总金额，`收款方式` = 测试 Base 里读出来的真方式；
 *   ⑤ 库存流水 = N 条（每行一双现货 ⇒ 一条 -1），关联到本单的明细行。
 *
 * 边界：
 *   · 只在 `FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的测试 Base 上跑；目标 ≠ 测试 Base ⇒ 拒绝跑；
 *   · 不读生产 Base、不用飞书 CLI、不部署；
 *   · 每单唯一 `submit_key`（否则共用同一个异步 job）。
 *
 * 跑法：
 *   cd server
 *   FEISHU_TARGET_ENV=test node --env-file=<主工作区>/.env --test --test-concurrency=1 --test-force-exit \
 *     test/realbase/scanSalesMultiLineE2E.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..'); // server/test/realbase → 仓库根
for (const candidate of [path.join(repoRoot, '.env'), path.join(__dirname, '..', '..', '.env')]) {
  if (fs.existsSync(candidate)) { require('dotenv').config({ path: candidate, quiet: true }); break; }
}

/** ⚠️ 在注入假凭证之前判定真凭证存在（CI 缺 .env 时显式 skip，不算通过）。 */
const HAS_REAL_APP_CREDS = Boolean(process.env.LARK_AGENT_APP_ID && process.env.LARK_AGENT_APP_SECRET);

const SKIP = (() => {
  if (!process.env.FEISHU_V1_E2E_TEST_APP_TOKEN) return '缺 FEISHU_V1_E2E_TEST_APP_TOKEN（测试 Base）⇒ 明确跳过，不算通过';
  if (!process.env.FEISHU_V1_BITABLE_APP_TOKEN) return '缺 FEISHU_V1_BITABLE_APP_TOKEN ⇒ 明确跳过';
  if (process.env.FEISHU_V1_BITABLE_APP_TOKEN !== process.env.FEISHU_V1_E2E_TEST_APP_TOKEN) {
    return '目标 Base ≠ 授权测试 Base ⇒ 拒绝跑（安全闸门）';
  }
  if (!HAS_REAL_APP_CREDS) return '缺真实应用凭证（CI 没有 .env）⇒ 明确跳过，不算通过';
  return '';
})();

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_multiline_e2e_fake';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'multiline_e2e_fake_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'multiline_e2e_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const express = require('express');
const { V1_BITABLE_SCHEMA } = require('../../src/config/v1BitableSchema');
const { V1BitableGateway, textValue, linkedRecordIds } = require('../../src/services/v1BitableGateway');
const { SCAN_PAGE } = require('../../src/config/scanPage');
const { SCAN_WRITE } = require('../../src/config/scanWrite');
const { createScanPageRouter } = require('../../src/routes/scanPage');
const { waitForPendingSaleBackgrounds } = require('../../src/services/saleWriteBackgroundService');
const { createSalesJobStore, STATUS: JOB_STATUS } = require('../../src/services/salesJobStore');
const { createPaymentMethodsService } = require('../../src/services/paymentMethodsService');

const TAG = `multi${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const SAY = (...args) => console.log(`[${TAG}]`, ...args);

if (SKIP) console.log(`[${TAG}] 跳过：${SKIP}（有凭证时这条会真跑真表）`);

const LINE_AMOUNT = 100;
const LINES_PER_ORDER = 2;

const F = () => SCAN_WRITE.fields;
const resetSessions = () => {
  const dir = process.env.SCAN_SESSION_DIR || path.join(__dirname, '..', '..', 'data', 'scan_sessions');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
};

const cookieOf = (openId) => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 'E2E多货', exp: Date.now() + 36e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${sig}`;
};

/** 测试 Base 里取一个真实「录单人」open_id（人员字段不接受合成 id）。 */
const realOperator = async (gateway) => {
  const EF = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  for (const row of await gateway.listAll('salesEntry')) {
    const cell = row.fields?.[EF.sender];
    for (const item of (Array.isArray(cell) ? cell : [cell])) {
      const id = typeof item === 'string' ? item : item?.id;
      if (id && String(id).startsWith('ou_')) return String(id);
    }
  }
  return '';
};

/** 解析页面表单（只取 name/value；radio/checkbox 只取 checked 的）。 */
const parseForm = (pageHtml) => {
  const form = {};
  const add = (name, value) => {
    if (!name) return;
    if (form[name] === undefined) form[name] = value;
    else if (Array.isArray(form[name])) form[name].push(value);
    else form[name] = [form[name], value];
  };
  for (const m of pageHtml.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0];
    const type = (tag.match(/type="([^"]*)"/) || [])[1] || 'text';
    if (type === 'submit' || type === 'button') continue;
    const name = (tag.match(/name="([^"]*)"/) || [])[1];
    if (!name) continue;
    if ((type === 'radio' || type === 'checkbox') && !/\bchecked\b/.test(tag)) continue;
    add(name, (tag.match(/value="([^"]*)"/) || [])[1] || '');
  }
  for (const m of pageHtml.matchAll(/<select\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const selected = (m[2].match(/<option[^>]*selected[^>]*value="([^"]*)"/) || [])[1];
    add(m[1], selected || (m[2].match(/<option[^>]*value="([^"]*)"/) || [])[1] || '');
  }
  return form;
};

/**
 * 用「页面表单 + 显式覆盖」拼一份 POST body。
 * ⚠️ 覆盖键会**整键替换**页面上的同名值（多值用数组 append）—— 多笔收款就靠这个。
 */
const formBody = (pageHtml, overrides = {}) => {
  const params = new URLSearchParams();
  const overridden = new Set(Object.keys(overrides));
  for (const [key, value] of Object.entries(parseForm(pageHtml))) {
    if (overridden.has(key)) continue;
    for (const item of (Array.isArray(value) ? value : [value])) params.append(key, item ?? '');
  }
  for (const [key, value] of Object.entries(overrides)) {
    for (const item of (Array.isArray(value) ? value : [value])) params.append(key, item ?? '');
  }
  return params.toString();
};

const post = async (base, urlPath, cookie, bodyString) => {
  const response = await fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: bodyString,
  });
  return { status: response.status, html: await response.text(), location: response.headers.get('location') || '' };
};

const getPage = async (base, urlPath, cookie) => {
  const response = await fetch(`${base}${urlPath}`, { headers: { cookie }, redirect: 'manual' });
  return { status: response.status, html: await response.text(), location: response.headers.get('location') || '' };
};

/** 等**这一单**的异步 job 到终态（真实写库在 worker 里，不能只等 HTTP 303）。 */
const waitForSaleJob = async (orderNo, timeoutMs = 300000) => {
  const store = createSalesJobStore();
  const terminal = new Set([JOB_STATUS.succeeded, JOB_STATUS.partialFailed, JOB_STATUS.failed]);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const jobs = await store.store.list();
    const mine = jobs.filter((job) => String(job.order_no || job.payload?.order_no || '') === String(orderNo));
    if (mine.some((job) => terminal.has(job.status))) return mine.find((job) => terminal.has(job.status));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待销售异步 job 超时（order_no=${orderNo}）`);
};

const withServer = async (run) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.set('x-request-id', req.requestId);
    next();
  });
  const router = createScanPageRouter({ startSnapshot: false });
  app.use(SCAN_PAGE.route.recordBasePath, router);
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const counts = async (gateway) => {
  const [entry, detail, payment, ledger] = await Promise.all([
    gateway.listAll('salesEntry'), gateway.listAll('salesDetail'),
    gateway.listAll('paymentRecord'), gateway.listAll('inventoryLedger'),
  ]);
  return { entry: entry.length, detail: detail.length, payment: payment.length, ledger: ledger.length };
};

/**
 * 测试 Base 里挑候选货品（按类别 A/B 分组，带实时库存行数与可售尺码）。只读。
 */
const loadCandidates = async (gateway) => {
  const LF = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
  const PF = V1_BITABLE_SCHEMA.tables.product.fields;
  const [live, products] = await Promise.all([gateway.listAll('liveInventory'), gateway.listAll('product')]);
  const byId = new Map(products.map((p) => [p.record_id, p]));
  const groups = new Map();
  for (const row of live) {
    const pid = linkedRecordIds(row.fields[LF.product])[0];
    const product = byId.get(pid);
    const size = textValue(row.fields[LF.size]).trim();
    if (!product || !size) continue;
    const itemNo = textValue(product.fields[PF.itemNo]).trim();
    const color = textValue(product.fields[PF.color]).trim();
    const category = textValue(product.fields[PF.category]).trim().toUpperCase();
    if (!itemNo || !color || !['A', 'B'].includes(category)) continue;
    if (!groups.has(pid)) {
      groups.set(pid, { recordId: pid, number: `${itemNo}|${color}|${category}`, itemNo, color, category, total: 0, sizes: new Set(), sellableSizes: new Set() });
    }
    const group = groups.get(pid);
    group.total += 1;
    group.sizes.add(size);
    if (['门盒', '样品'].includes(textValue(row.fields[LF.state]).trim())) group.sellableSizes.add(size);
  }
  return [...groups.values()].filter((group) => group.sellableSizes.size > 0);
};

const sizeOf = (candidate) => [...candidate.sellableSizes].sort((a, b) => Number(a) - Number(b))[0];

test(`AC-ML ⭐ 真实测试 Base：一单多货冒烟（A/B 各 1 张，每单 ${LINES_PER_ORDER} 行）`, { skip: SKIP || false, timeout: 900000 }, async () => {
  const gateway = new V1BitableGateway();
  const operator = await realOperator(gateway);
  assert.ok(operator, '测试 Base 里找不到真实「录单人」open_id ⇒ 无法建单');
  const candidates = await loadCandidates(gateway);
  const listOf = (category) => candidates
    .filter((candidate) => candidate.category === category)
    .sort((a, b) => `${a.itemNo}|${a.color}`.localeCompare(`${b.itemNo}|${b.color}`));
  const poolA = listOf('A');
  const poolB = listOf('B');
  assert.ok(poolA.length >= LINES_PER_ORDER, `A 类可售货品不足 ${LINES_PER_ORDER} 个（实际 ${poolA.length}）`);
  assert.ok(poolB.length >= LINES_PER_ORDER, `B 类可售货品不足 ${LINES_PER_ORDER} 个（实际 ${poolB.length}）`);
  // ⚠️ 支付方式必须用「收款方式管理」表里**真实存在**的那条（默认数组不是真源）。
  const methods = await createPaymentMethodsService(gateway).listWithVouchers();
  assert.equal(methods.ok, true, `收款方式管理读取失败：${methods.reason || ''}`);
  const payMethod = (methods.items || []).find((item) => !item.voucherRecordId)?.name || '';
  assert.ok(payMethod, '测试 Base 的「收款方式管理」里没有非券支付方式 ⇒ 无法完成付款');
  SAY('支付方式 =', payMethod, '（来自收款方式管理表）· 操作人 =', operator);

  const orders = [
    { label: 'A·男·一单两货', items: poolA.slice(0, LINES_PER_ORDER) },
    { label: 'B·女·一单两货', items: poolB.slice(0, LINES_PER_ORDER) },
  ];
  for (const order of orders) {
    SAY(`候选 ${order.label} =`, order.items.map((c) => `${c.number}(${sizeOf(c)})`).join(' , '));
  }

  const cookie = cookieOf(operator);
  const failures = [];
  const evidence = [];
  const before = await counts(gateway);

  await withServer(async (base) => {
    for (const [orderIndex, order] of orders.entries()) {
      const key = `${TAG}-multi-${orderIndex}`;
      try {
        // 一单一货用的「连续扫码」等价物：货品页 → ＋再加一双（只写会话，不写业务表）
        resetSessions();
        for (const item of order.items) {
          const itemPath = `${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(item.recordId)}?from=sales`;
          const page = await getPage(base, itemPath, cookie);
          assert.equal(page.status, 200, `${item.number} 货品页 GET 应 200（实际 ${page.status}）`);
          const added = await post(base, itemPath, cookie, formBody(page.html, {
            action: SCAN_WRITE.actions.addLine,
            [F().size]: sizeOf(item),
            [F().amount]: String(LINE_AMOUNT),
            [F().lineAmount]: '',
            [F().submitKey]: '',
          }));
          assert.equal(added.status, 303, `${item.number} add_line 应 303（实际 ${added.status}）`);
        }
        // 本单已有两行 ⇒ 提交这一步**不带尺码/金额**（否则会被当成"再加一行"）
        const lastPath = `${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(order.items.at(-1).recordId)}?from=sales`;
        const pageForSubmit = await getPage(base, lastPath, cookie);
        const step1 = await post(base, lastPath, cookie, formBody(pageForSubmit.html, {
          action: SCAN_WRITE.actions.submitOrder,
          [F().submitKey]: key,
          [F().size]: '',
          [F().amount]: '',
          [F().lineAmount]: '',
          [F().gift]: '',
        }));
        await waitForPendingSaleBackgrounds();
        assert.equal(step1.status, 200, `${order.label} 提交整单应 200（实际 ${step1.status}）`);
        assert.match(step1.html, /payment_pay/, `${order.label} 提交后应到资金页`);
        // 资金页：两笔收款（各 100）⇒ 收款合计 = 两行实收合计
        const total = LINE_AMOUNT * order.items.length;
        const step2 = await post(base, lastPath, cookie, formBody(step1.html, {
          action: SCAN_PAGE.paymentStep.payAction,
          [F().submitKey]: key,
          [F().paymentMethod]: Array.from({ length: order.items.length }, () => payMethod),
          [F().paymentAmount]: Array.from({ length: order.items.length }, () => String(LINE_AMOUNT)),
        }));
        await waitForPendingSaleBackgrounds();
        assert.ok([200, 303].includes(step2.status), `${order.label} 资金页提交应 200/303（实际 ${step2.status}）`);
        const orderNo = (step2.html.match(/XSD-\d{8}-\d{4}/) || step2.location.match(/XSD-\d{8}-\d{4}/) || [])[0] || '';
        assert.ok(orderNo, `${order.label} 成功页 / 跳转地址应出现单号 XSD-…`);

        const job = await waitForSaleJob(orderNo);
        const payloadLines = job.payload?.lines || [];
        const payloadPayments = job.payload?.payments || [];
        assert.equal(job.status, JOB_STATUS.succeeded, `${order.label} job 终态应 succeeded（实际 ${job.status} ${job.last_error || ''}）`);
        assert.equal(payloadLines.length, order.items.length, `${order.label} payload.lines 应 ${order.items.length} 行`);
        assert.equal(payloadPayments.length, order.items.length, `${order.label} payload.payments 应 ${order.items.length} 行`);
        assert.deepEqual(payloadLines.map((line) => Number(line.size)), order.items.map((item) => Number(sizeOf(item))), `${order.label} payload 尺码应与本单一致`);
        assert.deepEqual(payloadLines.map((line) => Number(line.actual_amount)), order.items.map(() => LINE_AMOUNT), `${order.label} payload 逐行实收应为 ${LINE_AMOUNT}`);
        assert.equal(Math.round(payloadPayments.reduce((s, p) => s + Number(p.amount || 0) * 100, 0)), total * 100, `${order.label} payload 收款合计应为 ${total}`);
        assert.ok(payloadLines.every((line) => /^rec/.test(String(line.product_record_id || ''))), `${order.label} payload 每行都应有 product_record_id`);

        const record = await inspectOrder(gateway, orderNo, order, { key });
        assert.equal(record.entry.length, 1, `${order.label} 销售主表应 1 条（实际 ${record.entry.length}）`);
        assert.equal(record.details.length, order.items.length, `${order.label} 销售明细应 ${order.items.length} 条（实际 ${record.details.length}）`);
        assert.equal(record.ledger.length, order.items.length, `${order.label} 库存流水应 ${order.items.length} 条（实际 ${record.ledger.length}）`);
        assert.equal(record.entry[0].totalAmount, total, `${order.label} 销售主表「总金额」应为 ${total}（实际 ${record.entry[0].totalAmount}）`);
        assert.deepEqual(record.details.map((d) => d.amount), order.items.map(() => LINE_AMOUNT), `${order.label} 明细「实收金额」应逐行 ${LINE_AMOUNT}`);
        assert.deepEqual(record.details.map((d) => d.size).sort(), order.items.map((item) => sizeOf(item)).sort(), `${order.label} 明细「尺码」应与本单一致`);
        assert.ok(record.payments.length >= 1, `${order.label} 应有收款明细`);
        assert.equal(record.paymentTotal, total, `${order.label} 收款合计应 = 总金额 ${total}（实际 ${record.paymentTotal}）`);
        assert.ok(record.payments.every((p) => p.method === payMethod), `${order.label} 收款方式应 = ${payMethod}（实际 ${record.payments.map((p) => p.method).join(',')}）`);
        assert.equal(record.ledger.every((l) => l.quantityChange === 1), true, `${order.label} 每条库存流水「变动数量」应为 1（绝对值，方向看「库存行为」）`);
        assert.equal(record.ledger.every((l) => l.behavior === '销售减少'), true, `${order.label} 每条库存流水「库存行为」应为「销售减少」（实际 ${record.ledger.map((l) => l.behavior).join(',')}）`);
        assert.equal(record.ledger.length, record.details.length, `${order.label} 库存流水应逐行一条`);
        assert.equal(record.ledger.every((l) => l.salesEntry === record.entry[0].record_id), true, `${order.label} 每条库存流水「关联销售」应指向本单销售主表`);
        evidence.push({ label: order.label, orderNo, job: { job_id: job.job_id, status: job.status, payloadLines: payloadLines.map((l) => ({ number: l.number, size: l.size, actual_amount: l.actual_amount, product_record_id: l.product_record_id })), payloadPayments }, record });
        SAY(`✅ ${order.label}：单号 ${orderNo} · 行数 ${payloadLines.length} · 明细 ${record.details.length} · 收款 ${record.payments.length}(合计 ${record.paymentTotal}) · 流水 ${record.ledger.length} · 总金额 ${record.entry[0].totalAmount}`);
      } catch (error) {
        failures.push(`${order.label}: ${error.message}`);
        SAY(`❌ ${order.label}：${error.message}`);
      }
    }
  });

  const after = await counts(gateway);
  const delta = {
    entry: after.entry - before.entry,
    detail: after.detail - before.detail,
    payment: after.payment - before.payment,
    ledger: after.ledger - before.ledger,
  };
  SAY('四表增量 =', JSON.stringify(delta));
  const expectedDetails = evidence.length * LINES_PER_ORDER;
  if (delta.entry !== evidence.length) failures.push(`销售主表增量 ${delta.entry}，期望 ${evidence.length}`);
  if (delta.detail !== expectedDetails) failures.push(`销售明细增量 ${delta.detail}，期望 ${expectedDetails}`);
  if (delta.ledger !== expectedDetails) failures.push(`库存流水增量 ${delta.ledger}，期望 ${expectedDetails}`);
  const expectedPayments = evidence.reduce((sum, item) => sum + item.record.payments.length, 0);
  if (delta.payment !== expectedPayments) failures.push(`收款增量 ${delta.payment}，期望 ${expectedPayments}`);

  SAY('汇总：一单多货成功 =', evidence.length, '/', orders.length, '· 明细总行数 =', expectedDetails);
  if (failures.length) SAY('失败项：\n- ' + failures.join('\n- '));
  // 证据原样打印（报告引用；不含任何凭证）
  SAY('证据 =', JSON.stringify(evidence));
  assert.deepEqual(failures, [], `一单多货 E2E 有 ${failures.length} 项失败`);
});

/** 按销售单号回查四表，返回可断言的扁平结构。 */
const inspectOrder = async (gateway, orderNo, order, { key } = {}) => {
  const EF = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  const DF = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
  const PF = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
  const LF = V1_BITABLE_SCHEMA.tables.inventoryLedger.fields;
  const [entries, details, payments, ledger] = await Promise.all([
    gateway.listAll('salesEntry'), gateway.listAll('salesDetail'),
    gateway.listAll('paymentRecord'), gateway.listAll('inventoryLedger'),
  ]);
  const entryRows = entries.filter((row) => textValue(row.fields[EF.orderNo]) === orderNo);
  const entryIds = new Set(entryRows.map((row) => row.record_id));
  const detailRows = details.filter((row) => linkedRecordIds(row.fields[DF.salesEntry]).some((id) => entryIds.has(id)));
  const detailIds = new Set(detailRows.map((row) => row.record_id));
  const paymentRows = payments.filter((row) => linkedRecordIds(row.fields[PF.salesEntry]).some((id) => entryIds.has(id)));
  // ⚠️ 2026-10-18 生产改表：「库存流水.关联销售」远端指向**销售主表**（`ledgerLink`），
  //    本地幂等仍用明细 id ⇒ 两种 id 都要认（与 `scanSalesInventoryMatrixE2E` 同一写法）。
  const ledgerRows = ledger.filter((row) => linkedRecordIds(row.fields[LF.salesDetail])
    .some((id) => entryIds.has(id) || detailIds.has(id)));
  return {
    submitKey: key || '',
    entry: entryRows.map((row) => ({
      record_id: row.record_id,
      orderNo: textValue(row.fields[EF.orderNo]),
      totalAmount: Number(textValue(row.fields[EF.totalAmount]) || 0),
      gift: textValue(row.fields[EF.gift]),
      writeStatus: textValue(row.fields[EF.writeStatus]),
      sender: linkedRecordIds(row.fields[EF.sender])[0] || (Array.isArray(row.fields[EF.sender]) ? row.fields[EF.sender]?.[0]?.id : ''),
      recordedAt: row.fields[EF.recordedAt],
    })),
    details: detailRows.map((row) => ({
      record_id: row.record_id,
      detailId: textValue(row.fields[DF.detailId]),
      product: linkedRecordIds(row.fields[DF.product])[0] || '',
      size: textValue(row.fields[DF.size]),
      amount: Number(textValue(row.fields[DF.actualAmount]) || 0),
      tradeType: textValue(row.fields[DF.tradeType]),
      fulfillmentStatus: textValue(row.fields[DF.fulfillmentStatus]),
    })),
    payments: paymentRows.map((row) => ({
      record_id: row.record_id,
      receiptId: textValue(row.fields[PF.receiptId]),
      method: textValue(row.fields[PF.method]),
      amount: Number(textValue(row.fields[PF.amount]) || 0),
      status: textValue(row.fields[PF.status]),
      tradeDirection: textValue(row.fields[PF.tradeDirection]),
      receivedAt: row.fields[PF.receivedAt],
    })),
    ledger: ledgerRows.map((row) => ({
      record_id: row.record_id,
      product: linkedRecordIds(row.fields[LF.product])[0] || '',
      size: textValue(row.fields[LF.size]),
      quantityChange: Number(textValue(row.fields[LF.quantityChange]) || 0),
      behavior: textValue(row.fields[LF.behavior]),
      salesEntry: linkedRecordIds(row.fields[LF.salesDetail])[0] || '',
      behaviorRecordId: linkedRecordIds(row.fields[LF.behavior])[0] || '',
    })),
    paymentTotal: paymentRows.reduce((sum, row) => sum + Number(textValue(row.fields[PF.amount]) || 0), 0),
    expectedLines: order.items.length,
  };
};
