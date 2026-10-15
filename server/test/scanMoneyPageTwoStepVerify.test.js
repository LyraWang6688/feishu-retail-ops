'use strict';

/**
 * 独立复核（teammate `e2e-verifier`）—— **#516 资金页前置的真实测试 Base 端到端**（可跳过）。
 *
 * CI 没有测试 Base 凭证 ⇒ 缺凭证时**明确 skip**（打印原因，不算通过 ✓）。跑的入口：
 *   `FEISHU_TARGET_ENV=test node --test --test-concurrency=1 --test-force-exit test/scanMoneyPageTwoStepVerify.test.js`
 *
 * ⚠️ 两个坑（**我第一版都踩了**，写这儿省得下一个人再踩）：
 *   ① `open_id` 必须是**租户里真实存在的用户**（「录单人」是人员字段）——合成 `ou_fake_xxx`
 *      建单会被飞书拒：`UserFieldConvFail (1254066)`、HTTP 500 ⇒ 从测试 Base 已有销售单里**取一个真 open_id**（只读）。
 *   ② 会话是**本地落盘**的（`server/data/scan_sessions`）——不复位的话，第二轮会命中上一张单的
 *      `status=posted` ⇒ **并发测试会假通过** ⇒ 每个用例先 `resetSessions()`。
 *
 * 验的是我自己要问的五件事（不是复述作者 AC）：
 *   V1 点「提交这一单」⇒ 四张表一行都不许多（主表/明细/收款/库存流水）
 *   V2 点资金页按钮 ⇒ 才建单：主表 +1（单号）· 明细 +1 · **收款按她填的**（全付 ⇒ 1 条已收款）· 现货 ⇒ 流水 +1
 *   V3 同一把 submitKey 连点两次（含并发）⇒ 只写一次
 *   V4 **金额不齐 ⇒ 零写入 + 差额人话 + 原地重渲染**（2026-10-16 迁移：
 *      · 改前逐字：`{ action:'payment_pay', payment_status:'部分付', payment_method:'微信', payment_amount:'' }`
 *        —— 用的是**已退场的档位字段** ✗（她 2026-10-16：「**去掉三个单选、按金额自动算**」）
 *      · 改后逐字：`{ action:'payment_pay', payment_method:'微信', payment_amount:'' }`
 *        —— **不带档位字段**（档位由金额自动算 ✓）；差额仍必须**拦住 + 人话 + 零写入** ✓
 *      · 依据 = 她 2026-10-16 逐字 ×2：「**去掉三个单选、按金额自动算**」
 *        ＋「**实收金额用户必须填写**……**不用做那个为空去单价的功能了**」）
 *   V5 写进「库存流水.关联销售」的 id 属于**哪张表**（该字段对端 = 销售主表，type=21 双向）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
for (const candidate of [path.join(repoRoot, '.env'), path.join(__dirname, '..', '.env')]) {
  if (fs.existsSync(candidate)) { require('dotenv').config({ path: candidate, quiet: true }); break; }
}

const express = require('express');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, textValue, linkedRecordIds } = require('../src/services/v1BitableGateway');

/** ⚠️ 在**注入假凭证之前**判定"本机有没有真凭证" —— 否则 CI 里判不出来（见下）。 */
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

/**
 * 🔴 **CI 假绿/假红的分界线（2026-10-14 真实事故 · PR #520 CI 红）**：
 *   CI **没有** `.env` ⇒ `routes/scanPage.js` 的 require 链里会在**模块加载期**构造
 *   `V1BitableGateway`（`controllers/workbenchController.js:5` 就是模块级 `new`）
 *   ⇒ 缺 `LARK_AGENT_*` 会**顶层抛** `新飞书应用必须同时配置 LARK_AGENT_APP_ID 和 LARK_AGENT_APP_SECRET`
 *   ⇒ **整份文件失败**（`tests 1 / fail 1`），"没凭证就 skip"**根本轮不到** ✗。
 *   ⇒ 所以在 require 之前先补一对**假**凭证（只为让 require 通过）；**有没有真凭证**由上面的
 *     `HAS_REAL_APP_CREDS` 判、无则**显式 skip**（原因可见 ✓，不是静默 ✗）。
 *   ⚠️ `||` 保证：本机有真凭证时**绝不覆盖**（真跑真表，一条断言都不松 ✓）。
 */
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_verify_money_fake';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'verify_money_fake_secret';

process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'verify_ship_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

// ⭐ 跳过必须**看得见**（在输出里明说一次，别让人以为"跑了 0 条 = 绿"）
if (SKIP) console.log(`[verify] 跳过：${SKIP}（有凭证时这条会真跑真表）`);

const TAG = `v${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const SAY = (...args) => console.log(`[verify ${TAG}]`, ...args);

const resetSessions = () => {
  const dir = process.env.SCAN_SESSION_DIR || path.join(__dirname, '..', 'data', 'scan_sessions');
  fs.rmSync(dir, { recursive: true, force: true });
};

const cookieOf = (openId) => {
  const payload = Buffer.from(JSON.stringify({ open_id: openId, name: '复核', exp: Date.now() + 36e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${sig}`;
};

/** 从测试 Base 已有销售单里取一个**真** open_id（「录单人」是人员字段，合成 id 会被飞书拒）。 */
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

/** 找一个**真·有货**的 (货号|颜色|类别, 尺码)：读【实时库存】+ 货品信息（只读）。 */
const findInStock = async (gateway) => {
  const LF = V1_BITABLE_SCHEMA.tables.liveInventory.fields;
  const F = V1_BITABLE_SCHEMA.tables.product.fields;
  const [live, products] = await Promise.all([gateway.listAll('liveInventory'), gateway.listAll('product')]);
  const byId = new Map(products.map((p) => [p.record_id, p]));
  for (const row of live) {
    const state = textValue(row.fields[LF.state]);
    const size = textValue(row.fields[LF.size]);
    const product = byId.get(linkedRecordIds(row.fields[LF.product])[0]);
    if (!product || !['门盒', '样品'].includes(state) || !size) continue;
    const no = textValue(product.fields[F.itemNo]);
    const color = textValue(product.fields[F.color]);
    const category = textValue(product.fields[F.category]);
    if (no && color && category) return { number: `${no}|${color}|${category}`, size, productRecordId: product.record_id };
  }
  return null;
};

const postPage = async (base, urlPath, cookie, body) => {
  const pageHtml = await (await fetch(`${base}${urlPath}`, { headers: { cookie } })).text();
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
  const effective = { ...form, ...body };
  if (!effective.submit_key) {
    const real = (pageHtml.match(/name="submit_key" value="([^"]+)"/) || [])[1];
    if (real) effective.submit_key = real;
  }
  const response = await fetch(`${base}${urlPath}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(effective).toString(),
  });
  return { status: response.status, html: await response.text(), submitKey: String(effective.submit_key || '') };
};

const withServer = async (run) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  const router = createScanPageRouter({ startSnapshot: false }); // 生产同款接线（真 gateway + 真写服务）
  app.use(SCAN_PAGE.route.basePath, router);
  app.use(SCAN_PAGE.route.recordBasePath, router);
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
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

const rowsOfOrder = async (gateway, orderNo) => {
  const EF = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
  const DF = V1_BITABLE_SCHEMA.tables.salesDetail.fields;
  const [entries, details] = await Promise.all([gateway.listAll('salesEntry'), gateway.listAll('salesDetail')]);
  const mine = entries.filter((r) => textValue(r.fields[EF.orderNo]) === orderNo);
  const entryIds = new Set(mine.map((r) => r.record_id));
  return {
    entryRows: mine,
    entryId: mine[0]?.record_id || '',
    detailRows: details.filter((r) => linkedRecordIds(r.fields[DF.salesEntry]).some((id) => entryIds.has(id))),
  };
};

const prepare = async () => {
  resetSessions();
  const gateway = new V1BitableGateway();
  const operator = await realOperator(gateway);
  assert.ok(operator, '测试 Base 里找不到真实「录单人」open_id ⇒ 无法建单（人员字段要真用户）');
  const pick = await findInStock(gateway);
  assert.ok(pick, '测试 Base 里没有可用现货 ⇒ 无法做真实端到端');
  return { gateway, operator, cookie: cookieOf(operator), pick };
};

test(`V1/V2/V5 · 点提交=零写入 ⇒ 点资金页按钮才建单（+ 读回「关联销售」指向哪张表）`, { skip: SKIP || false }, async () => {
  const { gateway, operator, cookie, pick } = await prepare();
  SAY('操作人 =', operator, '· 候选 =', JSON.stringify(pick));
  const urlPath = `${SCAN_PAGE.route.basePath}/${encodeURIComponent(pick.number)}`;
  await withServer(async (base) => {
    const before = await counts(gateway);
    SAY('① 点提交前四表 =', JSON.stringify(before));
    const step1 = await postPage(base, urlPath, cookie, { action: SCAN_WRITE.actions.submitOrder, [SCAN_WRITE.fields.size]: pick.size });
    const afterStep1 = await counts(gateway);
    SAY('① 点提交 HTTP', step1.status, '后四表 =', JSON.stringify(afterStep1), '| 是资金页?', /payment_pay/.test(step1.html));
    assert.deepEqual(afterStep1, before, '点「提交这一单」**不许**写任何一张表');
    assert.match(step1.html, /payment_pay/, '应当渲染资金页');

    const step2 = await postPage(base, urlPath, cookie, { action: 'payment_pay', payment_status: '未付' });
    const afterStep2 = await counts(gateway);
    const orderNo = (step2.html.match(/XSD-\d{8}-\d{4}/) || [])[0] || '';
    SAY('② 点资金页按钮 HTTP', step2.status, '后四表 =', JSON.stringify(afterStep2), '· 单号 =', orderNo || '(无)');
    assert.equal(afterStep2.entry - before.entry, 1, '点按钮那一刻**才**建单（主表 +1）');
    assert.equal(afterStep2.detail - before.detail, 1, '明细 +1');
    assert.equal(afterStep2.ledger - before.ledger, 1, '现货 ⇒ 库存流水 +1');
    assert.ok(orderNo, '成功页要给她单号（XSD-…）');

    const mine = await rowsOfOrder(gateway, orderNo);
    const EF = V1_BITABLE_SCHEMA.tables.salesEntry.fields;
    const PF = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
    const payments = (await gateway.listAll('paymentRecord'))
      .filter((r) => linkedRecordIds(r.fields?.[PF.salesEntry]).includes(mine.entryId));
    SAY('② 该单：主表', mine.entryRows.length, '行 · 明细', mine.detailRows.length, '行 · 确认状态 =',
      textValue(mine.entryRows[0]?.fields?.[EF.userAction]), '· 收款行 =',
      JSON.stringify(payments.map((r) => ({ 金额: textValue(r.fields?.[PF.amount]), 状态: textValue(r.fields?.[PF.status]), 方式: textValue(r.fields?.[PF.method]) }))));
    assert.equal(mine.entryRows.length, 1, '单号唯一（只建一张单）');
    assert.equal(mine.detailRows.length, 1, '这一单只有一条明细');
    assert.equal(afterStep2.payment - before.payment, 0, '扫码页口径：她填【未付】⇒ **不写**未收款行（与群聊口径不同，见报告）');
    assert.equal(payments.length, 0, '未付 ⇒ 这一单不该有收款行');
    

    // ── V5：「库存流水.关联销售」写进去的 id 属于哪张表 ──────────────────────
    const LF = V1_BITABLE_SCHEMA.tables.inventoryLedger.fields;
    const linkFieldName = LF.salesDetail; // 字段名「关联销售」（对端 = 销售主表）
    const detailIds = new Set(mine.detailRows.map((r) => r.record_id));
    const entryIds = new Set(mine.entryRows.map((r) => r.record_id));
    const related = (await gateway.listAll('inventoryLedger')).filter((row) => {
      const ids = linkedRecordIds(row.fields?.[linkFieldName]);
      return ids.some((id) => detailIds.has(id) || entryIds.has(id));
    });
    const ledgerCell = related[0]?.fields?.[linkFieldName];
    const idsInCell = linkedRecordIds(ledgerCell);
    SAY('V5 与本单相关的流水行数 =', related.length, '·「关联销售」cell =', JSON.stringify(ledgerCell).slice(0, 200));
    SAY('V5 判定 =', JSON.stringify({
      指向主表: idsInCell.some((id) => entryIds.has(id)),
      指向明细: idsInCell.some((id) => detailIds.has(id)),
      cell为空: !ledgerCell || (Array.isArray(ledgerCell) && ledgerCell.length === 0),
    }));
    SAY('V5 期望（Lead 口径）：该列对端 = 销售主表(tblchUNgfH7o0ydr) type=21 双向');
  });
});

test(`V3 · 同一把 submitKey 连点两次（含并发）⇒ 只写一次`, { skip: SKIP || false }, async () => {
  const { gateway, cookie, pick } = await prepare();
  const urlPath = `${SCAN_PAGE.route.basePath}/${encodeURIComponent(pick.number)}`;
  await withServer(async (base) => {
    const before = await counts(gateway);
    await postPage(base, urlPath, cookie, { action: SCAN_WRITE.actions.submitOrder, [SCAN_WRITE.fields.size]: pick.size });
    const afterSubmit = await counts(gateway);
    assert.deepEqual(afterSubmit, before, '点提交仍然零写入');
    const [a, b] = await Promise.all([
      postPage(base, urlPath, cookie, { action: 'payment_pay', payment_status: '未付' }),
      postPage(base, urlPath, cookie, { action: 'payment_pay', payment_status: '未付' }),
    ]);
    const after = await counts(gateway);
    const orderNo = ((a.html + b.html).match(/XSD-\d{8}-\d{4}/) || [])[0] || '';
    SAY('V3 并发两枪 HTTP', a.status, '/', b.status, '· 四表', JSON.stringify(before), '→', JSON.stringify(after), '· 单号 =', orderNo || '(无)');
    assert.equal(after.entry - before.entry, 1, '并发两枪**只许建一张单**');
    assert.equal(after.detail - before.detail, 1, '明细只 +1');
    assert.equal(after.ledger - before.ledger, 1, '库存只扣一次（流水只 +1）');
    assert.equal(after.payment - before.payment, 0, '未付 ⇒ 收款行不增（同上口径）');
    if (orderNo) {
      const mine = await rowsOfOrder(gateway, orderNo);
      SAY('V3 该单号在主表有', mine.entryRows.length, '行 · 明细', mine.detailRows.length, '行');
      assert.equal(mine.entryRows.length, 1, '单号必须唯一');
    }
  });
});

test(`V4 · 金额不齐 ⇒ 零写入（如实记状态码）`, { skip: SKIP || false }, async () => {
  const { gateway, cookie, pick } = await prepare();
  const urlPath = `${SCAN_PAGE.route.basePath}/${encodeURIComponent(pick.number)}`;
  await withServer(async (base) => {
    await postPage(base, urlPath, cookie, { action: SCAN_WRITE.actions.submitOrder, [SCAN_WRITE.fields.size]: pick.size });
    const before = await counts(gateway);
    // ⭐ 2026-10-16 迁移（改前逐字 → 改后逐字 → 依据）：
    //   改前逐字：`{ action: 'payment_pay', payment_status: '部分付', payment_method: '微信', payment_amount: '' }`
    //     —— 档位字段**已退场** ✗（她：「**去掉三个单选、按金额自动算**」）⇒ 带真凭证跑**会红** ✗
    //   改后逐字：`{ action: 'payment_pay', payment_method: '微信', payment_amount: '' }`
    //     —— **不带档位**（档位由「实收 / 收款」金额自动算 ✓）；差额仍必须**拦住 + 人话 + 零写入** ✓
    //   依据 = 她 2026-10-16 逐字 ×2：「去掉三个单选、按金额自动算」
    //          ＋「实收金额用户必须填写……不用做那个为空去单价的功能了」
    const bad = await postPage(base, urlPath, cookie, {
      action: 'payment_pay',
      [SCAN_WRITE.fields.paymentMethod]: '微信', [SCAN_WRITE.fields.paymentAmount]: '',
    });
    const after = await counts(gateway);
    SAY('V4 金额不齐 HTTP', bad.status, '· 四表', JSON.stringify(before), '→', JSON.stringify(after),
      '| 仍资金页?', /payment_pay/.test(bad.html), '| 有差额人话?', /差|不符|对不上|金额/.test(bad.html));
    assert.deepEqual(after, before, '金额不齐 ⇒ 零写入（不许假成功 ✗）');
    assert.match(bad.html, /payment_pay/, '应当原地重渲染资金页（她能改 ✓）');
    // ⭐ 迁移时**加固**（不是放宽 ✓）：差额必须**给她一句人话** —— 她真机抱怨过"只看到 400、没有原因" ✓
    assert.match(bad.html, /差|不符|对不上|金额|没提交成功/, '差额必须给她人话（不许干巴巴 400 ✗）');
  });
});
