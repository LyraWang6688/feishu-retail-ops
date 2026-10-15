'use strict';

/**
 * ⭐⭐ 2026-10-16（task-52 · ②-⑭ **口子收尾**）：**补货 / 退货的「尺码 / 数量 / 空单」三类校验
 *   必须当场同步拦** —— 拦住 + **人话** + **零写入** + **不调度后台** ✓。
 *
 * 起因（本刀要补的口子）：#695 把「写库」挪进后台之后，写层那三类**输入校验**跟着进了后台 ✗
 *   ⇒ 她真填错时**先看到成功页**、失败只在后台 warn（不静默 ✓ 但**体验错了** ✗）。
 * 业务负责人口径：**异步只针对「写库」** ✓；**校验必须当场同步拦** ✓
 *   （这正是既有 `purchaseAsyncAcceptance.test.js` 的 **AC-ASY2 精神** ✓ 本文件**不重复造** ✗）。
 *
 * 本文件钉四件事：
 *  **AC-SV1**（行为 · 补货）**尺码空 / 数量非法 / 空单** ⇒ 400 + **写层那一句人话** + 零写入 + 不调度
 *  **AC-SV2**（行为 · 退货）同上三条
 *  **AC-SV3**（反例 · 防删过头）**填对了** ⇒ 200 成功页 + **后台被调度一次** ＋ 统一文案
 *  **AC-SV4**（同源哨兵）路由的判定**指向同一份纯函数 / 配置**（塞回手抄版 ⇒ 红 ✗）
 *  **AC-SV5**（真红 · 可复现）同一份配置改 `maxQuantity` ⇒ 人话跟着变（硬编码 ⇒ 红 ✗）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// 与 `purchaseAsyncAcceptance.test.js` 同一条做法：路由链在 require 期就要凭证 ⇒ 补一对**假**的
// （`||` 保证本机有真凭证时**绝不覆盖** ✓）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sync_validate_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sync_validate_test_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, TEXTS } = require('../src/config/scanWrite');
const {
  RULES_SOURCE, ENTRY_RULE_CODES, ENTRY_RULE_CHAINS, ENTRY_RULE_TEXTS, purchaseEntryViolation,
} = require('../src/config/scanPurchaseEntryRules');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');

const SESSION_SECRET = 'scan-sync-validate-test-secret';
const NUMBER = 'YD6693-2|黑色|A';
const SERVER_DIR = path.join(__dirname, '..');
const ROUTE_SRC = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8');

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_sync_validate') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
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
  total: 0,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 0 }], total: 0, missing: true },
    { size_text: '41', cells: [{ count: 2 }], total: 2, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 10:00',
  product_record_id: 'prod_1',
});

/**
 * 替身写服务：**既数"写入口进没进"**，也如实回一条成功（AC-SV3 用它证"后台真的被调度过"✓）。
 * ⚠️ 带 25ms 延迟 —— 它让"**后台真在飞**"与"**根本没排**"在时间上**分得开**（探针思路 ✓）。
 */
const createWriteSpy = ({ delayMs = 25 } = {}) => {
  const calls = [];
  const record = (flow) => async (args) => {
    if (delayMs > 0) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    calls.push({ flow, args });
    return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 1 };
  };
  return {
    calls,
    sessions: { get: async () => null, submitKeyFor: () => 'scan_test:key:sv', setLastRealm: async () => {} },
    submitReplenish: record('replenish'),
    submitPurchaseReturn: record('purchase_return'),
  };
};

const appWith = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: write,
  }));
  return app;
};

const pageUrl = (base, realm) => `${base}/s/${encodeURIComponent(NUMBER)}?from=${realm}`;

const postForm = (url, cookie, body) => fetch(url, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
  redirect: 'manual',
});

const F = SCAN_WRITE.fields;
const A = SCAN_WRITE.actions;

// ─────────────────────────────────────────────────────────────────────────
// 三类坏输入（补货 / 退货**各一套**，字段名走配置 ✓ 不写死 ✗）
// ─────────────────────────────────────────────────────────────────────────

const replenishCases = () => ([
  {
    // ⚠️ 表单里的"尺码"是一个**认不出的值**（`abc` ⇒ 落成 `entry.size = 'abc'`）——
    //    若**整格不勾 / 空串**，`parseReplenishEntries` 会给出**空数组** ⇒ 那是"空单"那一条，
    //    走 `replenish_empty`（两条都在本文件判 ✓ 但**不是同一个错** —— 别混 ✗）。
    why: '尺码空 / 认不出',
    body: { action: A.replenish, submit_key: 'k', [`${F.replenishSizes}`]: 'abc' },
    code: ENTRY_RULE_CODES.sizeUnknown,
    said: TEXTS.sizeUnknownBody,
  },
  {
    why: '数量非法（认不出）',
    body: {
      action: A.replenish, submit_key: 'k', [`${F.replenishSizes}`]: '41',
      [`${F.replenishQuantityPrefix}41`]: 'abc',
    },
    code: ENTRY_RULE_CODES.quantityInvalid,
    said: '数量要填 1 ~ 99',
  },
  {
    why: '空单（没有任何明细）',
    body: { action: A.replenish, submit_key: 'k' },
    code: ENTRY_RULE_CODES.replenishEmpty,
    said: TEXTS.replenishNoneBody,
  },
]);

const returnCases = () => ([
  {
    why: '尺码空 / 认不出',
    body: { action: A.purchaseReturn, submit_key: 'k', [`${F.returnSizes}`]: 'abc', [F.purchaseAmount]: '800' },
    code: ENTRY_RULE_CODES.sizeUnknown,
    said: TEXTS.sizeUnknownBody,
  },
  {
    why: '数量非法（认不出）',
    body: {
      action: A.purchaseReturn, submit_key: 'k', [`${F.returnSizes}`]: '41',
      [`${F.returnQuantityPrefix}41`]: '0', [F.purchaseAmount]: '800',
    },
    code: ENTRY_RULE_CODES.quantityInvalid,
    said: '数量要填 1 ~ 99',
  },
  {
    why: '空单（没有任何明细）',
    body: { action: A.purchaseReturn, submit_key: 'k', [F.purchaseAmount]: '800' },
    code: ENTRY_RULE_CODES.returnEmpty,
    said: TEXTS.returnNoneBody,
  },
]);

/**
 * 一条坏输入的**四件套**判据（补货 / 退货共用，形状照金额那两张页的既有用例 ✓）：
 *   ① 当场 **400**（不是成功页 ✗）；② 有**人话**且就是**写层那一句** ✓；
 *   ③ **零写入**（写入口一次都没进 ✓）；④ **一次后台都没排**（登记簿为空 ✓）。
 */
const assertBlocked = async ({ realm, kase }) => {
  const write = createWriteSpy();
  await withServer(appWith(write), async (base) => {
    const res = await postForm(pageUrl(base, realm), sessionCookie(), kase.body);
    // ① 当场 400（她还没看到成功页）
    assert.equal(res.status, 400,
      `${realm} · ${kase.why} ⇒ **当场** 400（不是成功页 ✗）`);
    const html = await res.text();
    // ② 人话 = **写层那一句**（配置里那一句 ✓ 不是第二句 ✗）
    assert.ok(html.includes(ENTRY_RULE_TEXTS.entryInvalidTitle),
      `${realm} · ${kase.why}：H1 那句配置抬头要在 ✓`);
    assert.ok(html.includes(kase.said),
      `${realm} · ${kase.why}：必须给她**写层那一句人话**（期望含「${kase.said}」）`);
    // ③ **不调度后台**：登记簿这一瞬必须是空的（坏输入不许排任何后台那一跑 ✗）
    //    ⚠️ 顺序说明：命中三类校验 ⇒ 早于 `schedulePurchaseWrite(…)` **return** 掉了
    //       ⇒ 它**一次都没排**（本断言就是对这条的证明 ✓）。
    assert.equal(write.calls.length, 0, `${realm} · ${kase.why}：这一刻**写入口零调用** ✓`);
    // ④ 等干净（万一排了，这里会等到它跑完 ⇒ 下面那条会红 ⇒ 不留假绿）
    await waitForPendingPurchaseBackgrounds();
    assert.equal(write.calls.length, 0,
      `${realm} · ${kase.why} ⇒ **零写入**（拦在任何写之前 ✓）＋ **一次后台都没被调度** ✓`);
  });
};

// ── AC-SV1 / AC-SV2：三条坏输入，补货 / 退货各一遍 ────────────────────────────
test('AC-SV1 🔴 补货：尺码空 / 数量非法 / 空单 ⇒ **当场 400 + 写层那一句人话 + 零写入 + 不调度后台** ✗', async () => {
  login();
  for (const kase of replenishCases()) {
    await assertBlocked({ realm: 'replenish', kase });
  }
});

test('AC-SV2 🔴 退货：尺码空 / 数量非法 / 空单 ⇒ **当场 400 + 写层那一句人话 + 零写入 + 不调度后台** ✗', async () => {
  login();
  for (const kase of returnCases()) {
    await assertBlocked({ realm: 'purchase_return', kase });
  }
});

// ── AC-SV3：⭐ 反例（防删过头）**填对了** ⇒ 200 ＋ 后台被调度一次 ＋ 统一文案 ────────────
test('AC-SV3 ⭐ 反例：**填对了** ⇒ 200 成功页（统一那一句）＋ **后台被调度一次**（真写入口进过一次 ✓）', async () => {
  login();
  const LEGAL = [
    {
      chain: 'replenish', realm: 'replenish',
      body: { action: A.replenish, submit_key: 'k', [`${F.replenishSizes}`]: '41', [`${F.replenishQuantityPrefix}41`]: '2' },
    },
    {
      chain: 'purchase_return', realm: 'purchase_return',
      body: {
        action: A.purchaseReturn, submit_key: 'k', [`${F.returnSizes}`]: '41',
        [`${F.returnQuantityPrefix}41`]: '1', [F.purchaseAmount]: '800',
      },
    },
  ];
  for (const kase of LEGAL) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const res = await postForm(pageUrl(base, kase.realm), sessionCookie(), kase.body);
      // ① 先回她：200 ＋ 统一那一句（配置里的 `saleSuccess.message` ✓ 不新造 ✗）
      assert.equal(res.status, 200, `${kase.chain}：填对了 ⇒ 200（先回她 ✓）`);
      const html = await res.text();
      assert.ok(html.includes(SCAN_PAGE.saleSuccess.message),
        `${kase.chain}：成功页 = 配置里那一句统一文案 ✓`);
      // ② **后台被调度一次**（不是"看起来成功其实没排" ✗）——
      //    ⚠️ 这一刻**还没跑完**（写入口那 25ms 延迟）：它证明"真的排下去了" ✓
      //       （若被误拦 ⇒ 这里 `length === 0` ⇒ 红 ✓）
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.equal(write.calls.length, 0, `${kase.chain}：刚回她那一刻后台**还在飞**（= 真排下去了 ✓）`);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(write.calls.length, 1, `${kase.chain}：等后台跑完 ⇒ 写入口**恰好进过一次** ✓`);
      assert.equal(write.calls[0].flow, kase.chain, `${kase.chain}：进的是**这条链路**的写入口 ✓`);
    });
  }
});

// ── AC-SV4：⭐⭐ 规则同源哨兵（**塞回手抄版 ⇒ 红** ✗）───────────────────────────
test('AC-SV4a 🔴 同源哨兵：路由**调的是那一份纯函数**（唯一真源）—— 手抄 if-else 版 ⇒ 红 ✗', () => {
  // ① 真源件在（判据 + 出处行号）
  assert.equal(typeof purchaseEntryViolation, 'function', '纯函数必须在（唯一真源 ✓）');
  assert.equal(RULES_SOURCE.replenish, 'services/scanWriteService.js:1397-1426');
  assert.equal(RULES_SOURCE.purchaseReturn, 'services/scanWriteService.js:1556-1585');
  // ② 路由**import 的就是它**（不是自己再写一份 ✗）
  assert.ok(ROUTE_SRC.includes("require('../config/scanPurchaseEntryRules')"),
    '路由必须从 **这一份配置** require（不许在路由里另立一份判据 ✗）');
  assert.ok(ROUTE_SRC.includes('purchaseEntryViolation('),
    '路由必须**调** `purchaseEntryViolation(…)`（唯一真源 ✓）');
  // ③ **手抄签名**一件都不许出现在路由里（塞回手抄版 ⇒ 这几条红 ✓）
  //    ⚠️ 签名取"抄一份就必须重写一遍"的那些：四个错误码 ＋ 写层那**四句人话**
  //       （`sizeUnknownBody` / `quantityInvalidBody` / `replenishNoneBody` / `returnNoneBody`）。
  //    ⚠️ **刻意不含**两个"路由本来就有"的东西（避免误报 —— 扫全文件必然命中 ✗）：
  //       · `^[1-9]\d*$`：既有 `positiveSize`（`:2563`，与这三类校验**无关**）；
  //       · `replenish.defaultQuantity` / `purchaseReturn.defaultQuantity`：既有
  //         `parseReplenishEntries` / `parseReturnEntries`（`:2534` / `:2548`）里的
  //         "勾了不填数量 ⇒ 交给写服务按默认值算" —— 那是**形状转换**、不是校验 ✓。
  //       ⇒ 判"路由有没有自己判"看 ① ②（**它调没调那份纯函数** ✓）；
  //         手抄版会**自带**下面这几个**只属于这三类校验**的标记 ✓。
  const handCopiedSignatures = [
    ENTRY_RULE_CODES.sizeUnknown,        // 'size_unknown'（写层 :1404 / :1563）
    ENTRY_RULE_CODES.quantityInvalid,    // 'quantity_invalid'（写层 :1412 / :1571）
    ENTRY_RULE_CODES.replenishEmpty,     // 'replenish_empty'（写层 :1419）
    ENTRY_RULE_CODES.returnEmpty,        // 'return_empty'（写层 :1578）
    TEXTS.sizeUnknownBody,               // 写层 :1402 / :1561 那一句
    TEXTS.quantityInvalidBody,           // 写层 :1409 / :1568 那一句（模板）
    TEXTS.replenishNoneBody,             // 写层 :1418 那一句
    TEXTS.returnNoneBody,                // 写层 :1576 那一句
  ];
  for (const signature of handCopiedSignatures) {
    assert.equal(ROUTE_SRC.includes(signature), false,
      `路由里**不许**出现手抄的判据签名 \`${signature}\` ✗（那正是"两份真源"的形状 —— 移到配置里去 ✓）`);
  }
});

test('AC-SV4b ⭐ 同源哨兵（真源侧）：纯函数的错误码 / 人话 / 出处**逐字**对齐写层那两段', () => {
  // 错误码逐字（写层 `fail({ code: … })` 的那几个）
  assert.equal(ENTRY_RULE_CODES.sizeUnknown, 'size_unknown');
  assert.equal(ENTRY_RULE_CODES.quantityInvalid, 'quantity_invalid');
  assert.equal(ENTRY_RULE_CODES.replenishEmpty, 'replenish_empty');
  assert.equal(ENTRY_RULE_CODES.returnEmpty, 'return_empty');
  // 人话逐字（= 写层用的那几个 `texts.*`；本件只读配置、不抄第二句 ✓）
  assert.equal(ENTRY_RULE_CHAINS.replenish, 'replenish');
  assert.equal(ENTRY_RULE_CHAINS.purchaseReturn, 'purchase_return');
  assert.equal(purchaseEntryViolation({ chain: 'replenish', entries: [] }).message, TEXTS.replenishNoneBody);
  assert.equal(purchaseEntryViolation({ chain: 'purchase_return', entries: [] }).message, TEXTS.returnNoneBody);
  assert.equal(
    purchaseEntryViolation({ chain: 'replenish', entries: [{ size: '', quantity: '1' }] }).message,
    TEXTS.sizeUnknownBody,
  );
  assert.equal(
    purchaseEntryViolation({ chain: 'replenish', entries: [{ size: '41', quantity: 'x' }] }).message,
    `数量要填 1 ~ ${SCAN_WRITE.replenish.maxQuantity} 之间的整数。`,
  );
  // 通过（含"勾了不填数量 ⇒ 走该链路的默认值"这条既有语义 ✓）
  assert.equal(purchaseEntryViolation({ chain: 'replenish', entries: [{ size: '41', quantity: '2' }] }), null);
  assert.equal(purchaseEntryViolation({ chain: 'replenish', entries: [{ size: '41', quantity: '' }] }), null);
  assert.equal(purchaseEntryViolation({ chain: 'purchase_return', entries: [{ size: 41, quantity: 1 }] }), null);
  // ③ **出处标记**：每个拦截都带"抄自写层哪一段"（塞回手抄版 ⇒ 标不出来 ⇒ 红 ✓）
  const v = purchaseEntryViolation({ chain: 'replenish', entries: [] });
  assert.equal(v.rulesTag, RULES_SOURCE.replenish, '补货那条的判据出处 === 写层补货段 ✓');
  const r = purchaseEntryViolation({ chain: 'purchase_return', entries: [] });
  assert.equal(r.rulesTag, RULES_SOURCE.purchaseReturn, '退货那条的判据出处 === 写层退货段 ✓');
});

// ── AC-SV5：真红（可复现）—— 同一份配置改 `maxQuantity` ⇒ 人话跟着变（硬编码 ⇒ 红 ✗）──────
test('AC-SV5 ⭐ 真红：`SCAN_REPLENISH_MAX_QUANTITY` 改一个值 ⇒ 人话里的上限**跟着变**（硬编码 ⇒ 红 ✗）', () => {
  const { execFileSync } = require('node:child_process');
  const probe = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
    "const {purchaseEntryViolation} = require('./src/config/scanPurchaseEntryRules');"
    + 'process.stdout.write(JSON.stringify(purchaseEntryViolation('
    + "{ chain: 'replenish', entries: [{ size: '41', quantity: '9999' }] })));",
  ], { cwd: SERVER_DIR, env: { ...process.env, ...env }, encoding: 'utf8' }));
  // 默认 99
  assert.equal(probe({}).message, '数量要填 1 ~ 99 之间的整数。');
  // 改配置 ⇒ **人话跟着变**（证明它读的是**同一份配置**，不是路由/写层里的硬编码 ✓）
  assert.equal(probe({ SCAN_REPLENISH_MAX_QUANTITY: '150' }).message, '数量要填 1 ~ 150 之间的整数。',
    '上限改了 ⇒ 人话必须跟着改（这才是"配置先行"；硬编码那句话这里会红 ✗）');
});
