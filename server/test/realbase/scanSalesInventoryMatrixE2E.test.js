'use strict';

/**
 * 真实测试 Base E2E：**库存 · 单点查询** ＋ **销售 · 录单 · 鞋类**（男女各 10 双）。
 *
 * 入口（与工作台前端完全同一条）：
 *   · 库存 → 单点查询：扫描结果 URL = `/r/:recordId?from=inventory`（只读，不写表）
 *   · 销售 → 录单 → 鞋类：扫描结果 URL = `/r/:recordId?from=sales`，再走货品页 → 资金页提交
 *
 * 矩阵（共 20 双 = 10 次只读查询 + 10 张销售单）：
 *   · A 男鞋：5 双走库存单点查询（只读）＋ 5 双走销售录单（真实建单）
 *   · B 女鞋：5 双走库存单点查询（只读）＋ 5 双走销售录单（真实建单）
 *
 * 边界：
 *   · 只在 `FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的测试 Base 上跑；目标 ≠ 测试 Base ⇒ 拒绝跑；
 *   · 不读生产 Base、不用飞书 CLI、不部署；
 *   · 测试会真写测试 Base（销售主表/明细/收款/库存流水），测试数据不需删除。
 *
 * 跑法：
 *   cd server
 *   FEISHU_TARGET_ENV=test node --test --test-concurrency=1 --test-force-exit \
 *     test/realbase/scanSalesInventoryMatrixE2E.test.js
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

// 只为让 require 链通过；有没有真凭证由上面的 HAS_REAL_APP_CREDS 判。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_matrix_e2e_fake';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'matrix_e2e_fake_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'matrix_e2e_session_secret';
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

const TAG = `matrix${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const SAY = (...args) => console.log(`[${TAG}]`, ...args);

if (SKIP) console.log(`[${TAG}] 跳过：${SKIP}（有凭证时这条会真跑真表）`);

const LINE_AMOUNT = '100';

const resetSessions = () => {
  const dir = process.env.SCAN_SESSION_DIR || path.join(__dirname, '..', '..', 'data', 'scan_sessions');
  fs.rmSync(dir, { recursive: true, force: true });
  // worktree 里 data/ 可能整个不存在；JsonTaskStore 只写文件不建目录 ⇒ 必须先建回来。
  fs.mkdirSync(dir, { recursive: true });
};

const cookieOf = (openId) => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: 'E2E矩阵', exp: Date.now() + 36e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${sig}`;
};

/** 测试 Base 里取一个真实「录单人」open_id（人员字段不接受合成 id）。 */
const realOperator = async (gateway) => {
  const F = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  for (const row of await gateway.listAll('salesEntry')) {
    const cell = row.fields?.[F.sender];
    for (const item of (Array.isArray(cell) ? cell : [cell])) {
      const id = typeof item === 'string' ? item : item?.id;
      if (id && String(id).startsWith('ou_')) return String(id);
    }
  }
  return '';
};

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

/** 直接提交「已经拿到的这一页」上的表单 —— 不再 GET 一次（GET 会 reset 资金页会话）。 */
const submitHtml = async (base, urlPath, cookie, pageHtml, body) => {
  const effective = { ...parseForm(pageHtml), ...body };
  if (!effective.submit_key) {
    const real = (pageHtml.match(/name="submit_key" value="([^"]+)"/) || [])[1];
    if (real) effective.submit_key = real;
  }
  const response = await fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(effective).toString(),
  });
  return { status: response.status, html: await response.text(), location: response.headers.get('location') || '' };
};

/** 等异步销售 job 全部跑完（真实 Base 写库在 worker 里，不能只等响应）。 */
const waitForSaleJobs = async (orderNos, timeoutMs = 600000) => {
  const store = createSalesJobStore();
  const terminal = new Set([JOB_STATUS.succeeded, JOB_STATUS.partialFailed, JOB_STATUS.failed]);
  const wanted = new Set(orderNos.map(String));
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const jobs = await store.store.list();
    const mine = jobs.filter((job) => wanted.has(String(job.order_no || job.payload?.order_no || '')));
    if (mine.length >= wanted.size && mine.every((job) => terminal.has(job.status))) return mine;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`等待销售异步 job 超时（${orderNos.length} 单）`);
};

const postPage = async (base, urlPath, cookie, body) => {
  const pageHtml = await (await fetch(`${base}${urlPath}`, { headers: { cookie } })).text();
  return submitHtml(base, urlPath, cookie, pageHtml, body);
};

const withServer = async (run) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  // 生产同款：app.js 里由中间件给每个请求发 requestId；测试 app 也必须补，
  // 否则资金页会抛「收款请求缺少有效 request_id」（2026-10-28 实测）。
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
 * 测试 Base 里挑候选货品：按类别 A/B 分组，记录每个产品的实时库存行数、可售尺码。
 * 只读；不写任何表。
 */
const loadCandidates = async (gateway) => {
  const LF = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
  const F = V1_BITABLE_SCHEMA.tables.product.fields;
  const [live, products] = await Promise.all([gateway.listAll('liveInventory'), gateway.listAll('product')]);
  const byId = new Map(products.map((p) => [p.record_id, p]));
  const groups = new Map();
  for (const row of live) {
    const pid = linkedRecordIds(row.fields[LF.product])[0];
    const product = byId.get(pid);
    const size = textValue(row.fields[LF.size]).trim();
    if (!product || !size) continue;
    const itemNo = textValue(product.fields[F.itemNo]).trim();
    const color = textValue(product.fields[F.color]).trim();
    const category = textValue(product.fields[F.category]).trim().toUpperCase();
    if (!itemNo || !color || !['A', 'B'].includes(category)) continue;
    if (!groups.has(pid)) {
      groups.set(pid, { recordId: pid, number: `${itemNo}|${color}|${category}`, itemNo, color, category, total: 0, sizes: new Set(), sellableSizes: new Set() });
    }
    const group = groups.get(pid);
    group.total += 1;
    group.sizes.add(size);
    const state = textValue(row.fields[LF.state]).trim();
    if (['门盒', '样品'].includes(state)) group.sellableSizes.add(size);
  }
  return [...groups.values()].filter((g) => g.sellableSizes.size > 0);
};

const matrixOf = (candidates) => {
  const out = { inventory: [], sales: [] };
  for (const category of ['A', 'B']) {
    const list = candidates
      .filter((c) => c.category === category)
      .sort((a, b) => `${a.itemNo}|${a.color}`.localeCompare(`${b.itemNo}|${b.color}`));
    assert.ok(list.length >= 10, `${category} 类测试 Base 可售货品不足 10 个（实际 ${list.length}）`);
    out.inventory.push(...list.slice(0, 5));
    out.sales.push(...list.slice(5, 10));
  }
  return out;
};

test(`AC-SM ⭐ 真实测试 Base：库存单点查询 10 双 ＋ 销售录单 10 双（男女各 10）`, { skip: SKIP || false, timeout: 900000 }, async () => {
  const gateway = new V1BitableGateway();
  const operator = await realOperator(gateway);
  assert.ok(operator, '测试 Base 里找不到真实「录单人」open_id ⇒ 无法建单');
  const candidates = await loadCandidates(gateway);
  const matrix = matrixOf(candidates);
  // ⚠️ 支付方式必须用「收款方式管理」表里**真实存在**的那条（默认数组不是真源）。
  const methods = await createPaymentMethodsService(gateway).listWithVouchers();
  assert.equal(methods.ok, true, `收款方式管理读取失败：${methods.reason || ''}`);
  const payMethod = (methods.items || []).find((item) => !item.voucherRecordId)?.name || '';
  assert.ok(payMethod, '测试 Base 的「收款方式管理」里没有非券支付方式 ⇒ 无法完成付款');
  SAY('支付方式 =', payMethod, '（来自收款方式管理表）');
  SAY('操作人 =', operator);
  SAY('库存查询候选 =', matrix.inventory.map((c) => c.number).join(' , '));
  SAY('销售录单候选 =', matrix.sales.map((c) => c.number).join(' , '));

  const cookie = cookieOf(operator);
  const failures = [];
  const sold = [];
  const before = await counts(gateway);

  await withServer(async (base) => {
    // ── ① 库存 · 单点查询：只读 ──────────────────────────────────────────────
    for (const c of matrix.inventory) {
      try {
        const url = `${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(c.recordId)}?from=inventory`;
        const response = await fetch(`${base}${url}`, { headers: { cookie }, redirect: 'manual' });
        const html = await response.text();
        assert.equal(response.status, 200, `${c.number} GET ${url} 应 200`);
        assert.match(html, /realm-block--inventory/, `${c.number} 应渲染库存领域块`);
        assert.ok(html.includes(c.itemNo), `${c.number} 页面应出现货号 ${c.itemNo}`);
        assert.ok(html.includes(c.color), `${c.number} 页面应出现颜色 ${c.color}`);
        assert.ok(html.includes(`库存（共 ${c.total} 双）`), `${c.number} 库存总数应为 ${c.total}（实时库存记录条数）`);
        for (const size of c.sizes) {
          assert.ok(html.includes(`<th scope="row">${size}`), `${c.number} 库存表应有 ${size} 行`);
        }
        SAY(`✅ 库存单点查询 ${c.number}：共 ${c.total} 双，尺码 ${[...c.sizes].sort((a, b) => Number(a) - Number(b)).join('/')}`);
      } catch (error) {
        failures.push(`库存 ${c.number}: ${error.message}`);
        SAY(`❌ 库存单点查询 ${c.number}：${error.message}`);
      }
    }

    // ── ② 销售 · 录单 · 鞋类：真实建单 ──────────────────────────────────────
    for (const [saleIndex, c] of matrix.sales.entries()) {
      const size = [...c.sellableSizes].sort((a, b) => Number(a) - Number(b))[0];
      const url = `${SCAN_PAGE.route.recordBasePath}/${encodeURIComponent(c.recordId)}?from=sales`;
      // 每双一把唯一 submit_key：否则 10 双会共用同一个异步 job（job_id = hash(submit_key)）。
      const saleKey = `${TAG}-sale-${saleIndex}`;
      try {
        resetSessions();
        const step1 = await postPage(base, url, cookie, {
          action: SCAN_WRITE.actions.submitOrder,
          [SCAN_WRITE.fields.submitKey]: saleKey,
          [SCAN_WRITE.fields.size]: size,
          [SCAN_WRITE.fields.lineAmount]: LINE_AMOUNT,
        });
        await waitForPendingSaleBackgrounds();
        assert.equal(step1.status, 200, `${c.number} 货品页提交应 200`);
        assert.match(step1.html, /payment_pay/, `${c.number} 货品页提交后应到资金页`);

        const step2 = await submitHtml(base, url, cookie, step1.html, {
          action: 'payment_pay',
          [SCAN_WRITE.fields.submitKey]: saleKey,
          [SCAN_WRITE.fields.paymentMethod]: payMethod,
          [SCAN_WRITE.fields.paymentAmount]: LINE_AMOUNT,
        });
        await waitForPendingSaleBackgrounds();
        assert.ok([200, 303].includes(step2.status), `${c.number} 资金页提交应 200/303（实际 ${step2.status}）`);
        const orderNo = (step2.html.match(/XSD-\d{8}-\d{4}/) || step2.location.match(/XSD-\d{8}-\d{4}/) || [])[0] || '';
        assert.ok(orderNo, `${c.number} 成功页 / 跳转地址应出现单号 XSD-…`);
        sold.push({ candidate: c, size, orderNo });
        SAY(`✅ 销售录单 ${c.number}：尺码 ${size} · 单号 ${orderNo}`);
      } catch (error) {
        failures.push(`销售 ${c.number}: ${error.message}`);
        SAY(`❌ 销售录单 ${c.number}：${error.message}`);
      }
    }
  });

  // 异步销售：HTTP 只是入队；真实写库在 worker 里，等 job 到终态后再核对四表。
  if (sold.length) {
    const jobs = await waitForSaleJobs(sold.map((x) => x.orderNo));
    const failedJobs = jobs.filter((job) => job.status === JOB_STATUS.failed || job.status === JOB_STATUS.partialFailed);
    for (const job of failedJobs) failures.push(`销售 job ${job.order_no}: ${job.status} ${job.last_error || ''}`);
    SAY('异步 job 终态 =', JSON.stringify(jobs.map((job) => ({ order_no: job.order_no, status: job.status }))));
  }

  // ── ③ 汇总核对：销售单写完后的四表增量 + 每单结构 ──────────────────────────
  const after = await counts(gateway);
  const EF = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  const DF = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
  const PF = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
  const LF = V1_BITABLE_SCHEMA.tables.inventoryLedger.fields;
  const [entries, details, payments, ledger] = await Promise.all([
    gateway.listAll('salesEntry'), gateway.listAll('salesDetail'),
    gateway.listAll('paymentRecord'), gateway.listAll('inventoryLedger'),
  ]);
  const orderSet = new Set(sold.map((x) => x.orderNo));
  const mineEntries = entries.filter((r) => orderSet.has(textValue(r.fields[EF.orderNo])));
  const entryIds = new Set(mineEntries.map((r) => r.record_id));
  const mineDetails = details.filter((r) => linkedRecordIds(r.fields[DF.salesEntry]).some((id) => entryIds.has(id)));
  const detailIds = new Set(mineDetails.map((r) => r.record_id));
  const minePayments = payments.filter((r) => linkedRecordIds(r.fields[PF.salesEntry]).some((id) => entryIds.has(id)));
  const mineLedger = ledger.filter((r) => {
    const ids = linkedRecordIds(r.fields[LF.salesDetail]);
    return ids.some((id) => detailIds.has(id) || entryIds.has(id));
  });

  const expected = sold.length;
  if (after.entry - before.entry !== expected) failures.push(`销售主表增量 ${after.entry - before.entry}，期望 ${expected}`);
  if (after.detail - before.detail !== expected) failures.push(`销售明细增量 ${after.detail - before.detail}，期望 ${expected}`);
  if (after.payment - before.payment !== expected) failures.push(`收款增量 ${after.payment - before.payment}，期望 ${expected}`);
  if (after.ledger - before.ledger !== expected) failures.push(`库存流水增量 ${after.ledger - before.ledger}，期望 ${expected}`);
  if (mineEntries.length !== expected) failures.push(`按单号回查销售主表 ${mineEntries.length} 行，期望 ${expected}`);
  if (mineDetails.length !== expected) failures.push(`回查销售明细 ${mineDetails.length} 行，期望每单 1 行共 ${expected}`);
  if (minePayments.length !== expected) failures.push(`回查收款 ${minePayments.length} 行，期望每单 1 行共 ${expected}`);
  if (mineLedger.length !== expected) failures.push(`回查库存流水 ${mineLedger.length} 行，期望每单 1 行共 ${expected}`);

  // 每单唯一、单号不重复
  if (new Set(sold.map((x) => x.orderNo)).size !== sold.length) failures.push('销售单号出现重复');

  SAY('汇总：库存查询 =', matrix.inventory.length,
    '· 销售成功 =', sold.length,
    '· 主表回查 =', mineEntries.length,
    '· 明细回查 =', mineDetails.length,
    '· 收款回查 =', minePayments.length,
    '· 流水回查 =', mineLedger.length);
  if (failures.length) SAY('失败项：\n- ' + failures.join('\n- '));

  assert.deepEqual(failures, [], `真实 Base E2E 有 ${failures.length} 项失败`);
});
