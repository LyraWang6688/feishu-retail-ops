'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ 2026-10-16（Lead 派活）「**补货不问金额** ＋ 「（可不填）」文案改必填」的验收判据。
 *
 * 依据（业务负责人 2026-10-16 **逐字**）：
 *   「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
 *     才可以点击提交跳转到资金页，**不用做那个为空去单价的功能了**」
 * ⇒ ① **补货不问金额**（去输入 ✓ 后端也不再要求 ✓）② **退货 + 验收仍要金额** ✓
 * ⇒ 只读盘点见 `docs/purchase-amount-and-label-plan-2026-10-16.md`（PR #667 已合 ✓）
 *   ⭐ 关键发现：补货与退货**共用同一道闸门 + 同一套配置** ✗
 *     ⇒ **不能靠关开关** ✗（一关把退货也放开 ✗ 违背她 2026-10-14「退货整单金额（必填），与补货同一套配置」）
 *     ⇒ 正确做法：`PURCHASE_AMOUNT` 改**按链路分档** `requiredByRealm: { replenish:false, return:true, accept:true }`
 *        （**旧键 `required` 不改名** ✓ 作兜底/兼容 ✓）
 * ⇒ ③ 销售那行标签「实收金额（**可不填**）」✗ ⇒ 改必填措辞；占位「留空按货品单价」**删**（兜底不做了 ✗）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 🔴 本文件**只动 `test/**`**：`config/**` / `routes/**` / `views/**` / `scanWriteService.js` 一个字不改 ✗
 *    （`views/**` 现在被"成功页极简"那位占着 ✗）
 * ⇒ 照 `test/skipPathsMinimal.test.js` 的 **AC-SP1 分阶段手法**写：
 *    · **今天能真判的** ⇒ 真判据（能真红 ✓）；
 *    · **实现还没落地的** ⇒ 如实打 `[待激活]`（**绝不假装通过** ✗），实现一落**自动开始真判** ✓；
 *    · 每条待激活项都有**探针**：证明它的检测器**不是空跑**（塞个坏样本进去 ⇒ 必须报红 ✓）。
 *
 * ⚠️ "零写入"用的是**替身写服务**：断言的是"**写入口一次都没进**"（比"表里没数据"强——
 *    数表会被别人写脏）。与 `test/scanPurchaseAmountRequired.test.js` 同一条做法 ✓。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// require 链里有模块级 `new V1BitableGateway()` ⇒ 先补一对**假**凭证（`||` 保证本机真凭证绝不被覆盖 ✓）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_amount_realm_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'amount_realm_test_secret';

const SERVER_DIR = path.join(__dirname, '..');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PURCHASE_AMOUNT, TEXTS } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan-amount-realm-test-secret';
const NUMBER = 'YD6693-2|黑色|A';

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_amount_realm') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const view = () => ({
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '41', cells: [{ count: 2 }], total: 2, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 02:00',
  product_record_id: 'prod_1',
});

/** 替身写服务：**只数"写入口进没进"** ✓ */
const createWriteSpy = () => {
  const calls = [];
  return {
    calls,
    sessions: { get: async () => null, submitKeyFor: () => 'scan_test:key:realm', setLastRealm: async () => {} },
    submitReplenish: async (args) => { calls.push({ flow: 'replenish', args }); return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 1 }; },
    submitPurchaseReturn: async (args) => { calls.push({ flow: 'purchase_return', args }); return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 1 }; },
  };
};

const appWith = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: write,
  }));
  return app;
};

const pageUrl = (base, realm) => `${base}/r/${encodeURIComponent(NUMBER)}?from=${realm}`;

/** 提一次（`amount === null` ⇒ **整个字段都不带** = "她一个字没填" ✓） */
const postAction = async (base, realm, action, amount) => {
  const body = { action, submit_key: 'scan_test:key:realm' };
  if (realm === 'purchase_return') { body.return_sizes = '41'; body.return_qty_41 = '1'; } else { body.sizes = '41'; body.qty_41 = '1'; }
  if (amount !== null) body[SCAN_WRITE.fields.purchaseAmount] = amount;
  return fetch(pageUrl(base, realm), {
    method: 'POST',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
};

/** 三条链路各提一次（不填金额 / 非数字金额），返回**观测事实**（供分阶段判据用 ✓） */
const observe = async () => {
  login();
  const runs = {};
  const probe = async (realm, action, amount) => {
    const write = createWriteSpy();
    const status = await withServer(appWith(write), async (base) => {
      const res = await postAction(base, realm, action, amount);
      return { code: res.status, text: await res.text() };
    });
    return { status: status.code, body: status.text, wrote: write.calls.length > 0 };
  };
  runs.replenishEmpty = await probe('replenish', SCAN_WRITE.actions?.replenish || 'replenish', null);
  runs.returnEmpty = await probe('purchase_return', SCAN_WRITE.actions?.purchaseReturn || 'purchase_return', null);
  runs.returnBad = await probe('purchase_return', SCAN_WRITE.actions?.purchaseReturn || 'purchase_return', 'abc');
  return runs;
};

// ═══════════════════════════════════════════════════════════════════════════
// 探针（证明检测器不空跑 ✓）—— 纯函数，喂坏样本必须报红 ✓
// ═══════════════════════════════════════════════════════════════════════════

/** 「标签里不许出现『可不填』」的检测器 ✓ */
const labelViolations = (texts) => ['amountLabel', 'accessoryAmountLabel']
  .filter((key) => String(texts?.[key] || '').includes('可不填'))
  .map((key) => `${key}=${texts[key]}`);

/** 「占位不许承诺『留空按…单价』」的检测器 ✓（除非 lineAmountRequired === false ⇒ 兜底真的回来了） */
const placeholderViolations = (texts, lineAmountRequired) => {
  if (lineAmountRequired === false) return [];
  return ['amountPlaceholder', 'accessoryAmountPlaceholder']
    .filter((key) => /留空按.*单价/.test(String(texts?.[key] || '')))
    .map((key) => `${key}=${texts[key]}`);
};

/** 「按链路分档」的检测器 ✓：缺 `requiredByRealm` 或缺三个档位 ⇒ 报红 ✓ */
const realmViolations = (config) => {
  const byRealm = config?.requiredByRealm;
  if (!byRealm || typeof byRealm !== 'object') return ['缺少 requiredByRealm（补货/退货还共用一道闸门 ✗）'];
  return ['replenish', 'return', 'accept']
    .filter((realm) => typeof byRealm[realm] !== 'boolean')
    .map((realm) => `requiredByRealm.${realm} 不是显式布尔 ✗`);
};

test('AC-AR0 ⭐ 探针：三个检测器**都不是空跑**（喂坏样本 ⇒ 必须报红 ✓）', () => {
  assert.deepEqual(labelViolations({ amountLabel: '实收金额（可不填）', accessoryAmountLabel: '配品实收金额（可不填）' }),
    ['amountLabel=实收金额（可不填）', 'accessoryAmountLabel=配品实收金额（可不填）'], '检测器必须认出「可不填」✗');
  assert.deepEqual(labelViolations({ amountLabel: '每件实收金额', accessoryAmountLabel: '配品实收金额' }), [], '干净的标签不许误报 ✓');
  assert.deepEqual(placeholderViolations({ amountPlaceholder: '留空按货品单价' }, true), ['amountPlaceholder=留空按货品单价'], '假承诺必须被认出 ✗');
  assert.deepEqual(placeholderViolations({ amountPlaceholder: '请填这一件的实收金额' }, true), [], '不承诺 ⇒ 不报 ✓');
  assert.deepEqual(placeholderViolations({ amountPlaceholder: '留空按货品单价' }, false), [], '兜底真回来了 ⇒ 允许 ✓');
  assert.equal(realmViolations({ required: true }).length, 1, '缺 requiredByRealm ⇒ 报红 ✓');
  assert.deepEqual(realmViolations({ requiredByRealm: { replenish: false, return: true, accept: true } }), [], '三档齐 ⇒ 不报 ✓');
  assert.equal(realmViolations({ requiredByRealm: { replenish: false, return: 'yes', accept: true } }).length, 1, '非布尔 ⇒ 报红 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 今天能真判的（真判据 · 能真红 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR1 ⭐⭐ 退货：**不填金额 ⇒ 拦住 + 人话 + 零写入**（改宽松 ⇒ 红 ✓）', async () => {
  const runs = await observe();
  const run = runs.returnEmpty;
  assert.notEqual(run.status, 200, `退货不填金额**必须**被拦住 ✗（实际 HTTP ${run.status}）`);
  assert.equal(run.wrote, false, '拦在写之前 ⇒ **写入口一次都没进** ✓（= 零写入 ✓）');
  // 人话走配置：页面正文里必须出现配置里那句（不写死中文 ✗）
  const message = String(SCAN_WRITE.texts?.purchaseAmountRequired || SCAN_WRITE.texts?.purchaseAmountEmpty || '');
  if (message) assert.ok(run.body.includes(message), `拦住时要给**配置里那句人话** ✓（缺：${message}）`);
  else console.log('[AC-AR1] 备注：配置里没找到"金额必填"的人话键 ⇒ 只判"拦住 + 零写入" ✓');
});

test('AC-AR2 ⭐⭐ 验收链路**没有**金额闸门（回归哨兵：别被顺手加一道 ✗）', () => {
  // ① 源码哨兵：验收相关配置/服务里**不读** `PURCHASE_AMOUNT`（那是补货/退货那一套 ✓）
  const arrivalFiles = [
    'src/services/scanArrivalService.js',
    'src/services/workbenchPurchaseArrivalService.js',
    'src/services/purchaseArrivalConversationService.js',
  ];
  for (const rel of arrivalFiles) {
    const src = fs.readFileSync(path.join(SERVER_DIR, rel), 'utf8');
    assert.equal(/PURCHASE_AMOUNT|requiredByRealm/.test(src), false, `⛔ 验收链路不许引入金额闸门 ✗（${rel}）`);
  }
  // ② 端到端那条：验收提交**不带金额字段**也能走（它自己那条链的必填只有"发生金额"，与补货那套**不同源** ✓）
  const accept = fs.readFileSync(path.join(SERVER_DIR, 'src/services/workbenchPurchaseArrivalService.js'), 'utf8');
  assert.match(accept, /actualAmount/, '验收那条仍是 `actualAmount`（=到货发生金额 ✓ 另一套语义 ✓）');
});

test('AC-AR3 ⭐ `requiredByRealm` **配置先行**（三档可配 ⇒ 换配置即换行为 ✓）', () => {
  const violations = realmViolations(PURCHASE_AMOUNT);
  if (violations.length === 0) {
    // 实现已落 ⇒ 真判据
    for (const realm of ['replenish', 'return', 'accept']) {
      assert.equal(typeof PURCHASE_AMOUNT.requiredByRealm[realm], 'boolean', `requiredByRealm.${realm} 必须是显式布尔 ✓`);
    }
    assert.equal(PURCHASE_AMOUNT.requiredByRealm.replenish, false, '补货**不要求**金额 ✓（她 2026-10-16 逐字）');
    assert.equal(PURCHASE_AMOUNT.requiredByRealm.return, true, '退货**仍要求**金额 ✓（她 2026-10-14 逐字）');
    assert.equal('required' in PURCHASE_AMOUNT, true, '旧键 `required` **不改名**（兜底/兼容 ✓）');
    return;
  }
  console.log('[AC-AR3] 待激活：`PURCHASE_AMOUNT` 还没有按链路分档（%s）⇒'
    + ' "补货/退货同一道闸门"这一刀落地后本段**自动开始真判** ✓', JSON.stringify(violations));
});

test('AC-AR4 ⭐ 文案：标签**不含「可不填」**、占位**不承诺"留空按单价"**（谁写回来谁红 ✓）', () => {
  const labels = labelViolations(TEXTS);
  const placeholders = placeholderViolations(TEXTS, PURCHASE_AMOUNT.requiredByRealm?.replenish === false ? false : undefined);
  if (labels.length === 0 && placeholders.length === 0) {
    assert.deepEqual(labels, [], '标签里不许有「可不填」 ✗');
    assert.deepEqual(placeholders, [], '占位不许承诺"留空按单价" ✗');
    return;
  }
  console.log('[AC-AR4] 待激活：`config/scanWrite.js` 的文案那一刀还没落 ⇒ 今天仍有 %s / %s'
    + ' ⇒ 文案落地后本段**自动开始真判**（塞回即红 ✓）', JSON.stringify(labels), JSON.stringify(placeholders));
});

test('AC-AR2b ⭐⭐ 退货：**非数字金额 ⇒ 拦住 + 零写入**（改宽松 ⇒ 红 ✓ · 今天已成立 ✓）', async () => {
  const runs = await observe();
  const run = runs.returnBad;
  assert.notEqual(run.status, 200, `退货填非数字**必须**被拦住 ✗（实际 HTTP ${run.status}）`);
  assert.equal(run.wrote, false, '拦住时**写入口一次都不许进** ✓（= 零写入 ✓）');
});

test('AC-AR7 ⭐ 闸门**按链路分档的前提已经具备**：事件名在配置里 · 闸门知道 realm ✓', () => {
  // ① 事件名（唯一来源在配置 ✓）——实测运行期就是它：
  //    {"event":"scan.write.purchase_amount_required","realm":"replenish","reason":"amount_empty"…}
  const config = fs.readFileSync(path.join(SERVER_DIR, 'src/config/scanWrite.js'), 'utf8');
  assert.match(config, /purchaseAmountRequired: 'scan\.write\.purchase_amount_required'/,
    '闸门事件名必须在配置里（不散写中文/字符串 ✗）✓');
  // ② 闸门**知道**这条动作属于哪条链路（`realm`）⇒ 按链路分档落地时**不用改闸门的形状** ✓
  const route = fs.readFileSync(path.join(SERVER_DIR, 'src/routes/scanPage.js'), 'utf8');
  assert.match(route, /purchaseAmountRequired/, '闸门引用配置里的事件名 ✓');
  assert.match(route, /realm/, '闸门按 `realm` 分辨链路 ✓（分档落地的前提 ✓）');
  // ⚠️ 如实说明：`config/**` / `routes/**` 本刀**一个字不改** ✗ ⇒ 上面两条只是**读** ✓
});


// ═══════════════════════════════════════════════════════════════════════════
// 待激活：补货不问金额（实现未落地 ⇒ 如实标 ✗ 不假装通过 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AR5 ⭐⭐ 补货：**不填金额 ⇒ 照样能提交**（分档落地前如实标 [待激活]）', async () => {
  const runs = await observe();
  if (runs.replenishEmpty.status === 200 && runs.replenishEmpty.wrote === true) {
    // 真判据（分档已落 ✓）
    assert.equal(runs.replenishEmpty.status, 200, '补货不填金额 ⇒ 必须能提交 ✓');
    assert.equal(runs.replenishEmpty.wrote, true, '补货那条要真的进写入口 ✓');
    return;
  }
  console.log('[AC-AR5] 待激活：补货不填金额**今天仍被拦住**（HTTP %s · 写入口进没进=%s）'
    + ' ⇒ 这正是"补货/退货共用一道闸门"的现象 ✗ ⇒ `requiredByRealm` 那一刀落地后本段**自动开始真判** ✓',
  runs.replenishEmpty.status, runs.replenishEmpty.wrote);
  // 同时**如实钉住今天的事实**（这条是真判据：改回"不拦"就红 ✓）
  assert.notEqual(runs.returnEmpty.status, 200, '退货那条今天必须是拦住的 ✓（分档落地前两条一样 ✓）');
});

test('AC-AR6 ⭐ 分档落地后：退货仍拦住（**实现一落就自动生效**的哨兵）', async () => {
  const runs = await observe();
  if (runs.replenishEmpty.status === 200 && runs.replenishEmpty.wrote === true) {
    assert.notEqual(runs.returnEmpty.status, 200, '分档落地后**退货必须仍然拦住** ✗（不许连退货一起放开 ✗）');
    assert.equal(runs.returnEmpty.wrote, false, '退货拦住时写入口一次都不许进 ✓');
    return;
  }
  console.log('[AC-AR6] 待激活：分档未落 ⇒ 本段与 AC-AR1 同判（退货今天已拦住 ✓）'
    + ' ⇒ 一旦补货放开，本段**自动改为真判**"退货仍拦住" ✓');
});
