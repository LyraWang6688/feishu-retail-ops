'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * ⭐⭐ 「**退货整单金额必填**」的验收用例（业务负责人 2026-10-14 晚**逐字**）：
 *   「**退货整单金额（必填），与补货同一套配置**」
 *   ＋同一晚另一句：「**只写一个整单金额**（一次填一个总额，**和补货一样**～）」
 *   ＋结构文档 `docs/scan-and-workbench-structure-2026-10-14.md` 第 5 节：
 *     · 退货表单加**一个整单金额**输入（**一次一个总额** ✓ **不按行分填** ✗）；
 *     · ⚠️ 补货那边**同样口径**（她："和补货一样"）⇒ **一次做成同一套**（配置先行）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-PA1 **一套配置**：字段名**唯一来源**（`PURCHASE_AMOUNT.field` ＝ `fields.purchaseAmount`）
 *         ＋**显式布尔开关**（`readFlag`：`false` / **空串** ⇒ 关掉；认不出的值 ⇒ 抛错）——
 *         用**子进程**真读一次，证明它**真的可配**（不是"写了变量名但读不到" ✗）。
 *  AC-PA2 两个表单（补货 / 退货）**各恰有一个**「整单金额」输入：`name` / 标签来自配置，
 *         且**两边 `name` 完全相同**（= 同一套配置 ✓ 不是两套 ✗）。
 *  AC-PA3 **空 ⇒ 400 + 人话 + 零写入**：补货 / 退货**两条动作都判**；页面 H1 / 正文 = **配置里的
 *         那两句**（人话走配置 ✓），且**写入口一次都没被调用**（= 结构性零写入：
 *         拦在**任何写之前**，不靠写服务配合 ✓）。
 *  AC-PA4 **非空 ⇒ 照旧提交**：闸门放行、写入口被调用、页面 200；
 *         ⭐ 2026-10-15（③）**翻新**：退货**必须**逐字带上 `orderAmount`（要落「发生金额」）；
 *            补货**不带**（⭐ 2026-10-15 晚她**已裁**：「**补货不会写金额**」⇒ 见 AC-PA6）✓
 *  AC-PA5 源码哨兵：两条动作**共用同一个闸门函数**（一处实现 ✓ 不复制 ✗）；
 *         开关读配置（`required === false` 可关）；配置用 `readFlag` 且**没有**
 *         `process.env... || fallback` 那种"清空关不掉"的写法；
 *         渲染层「整单金额」**只有一处定义**、两个表单都用它。
 *  AC-PA6 ⭐⭐ 2026-10-15 晚**再翻新**（依据 = **她的裁决**）：**没有待办 TODO** ——
 *         补货"不写金额"是一条**裁决**（她逐字：「补货不会写金额，只有到货的时候才会写金额，
 *         也是写进发生金额里」），不是待办；但那处注释**必须写清依据**
 *         （补货批次带「到货状态=未到货」⇒ 会被到货核对写同一行同一列）✓
 *
 * ⚠️ 两个"零写入"断言用的是**替身写服务**：它不是"表里没数据就算零写入"，
 *    而是"**连写入口都没进**"——比数表更强（数表会被别人写脏）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const express = require('express');

// `services/larkMvpService` / `controllers/workbenchController` 在 require 阶段就要凭证
// （`app.js` 的 require 链里有模块级 `new V1BitableGateway()`）⇒ 先补一对**假**凭证，
// 否则整个文件在加载期就崩（与 `scanPurchaseReturn.test.js` 同一条做法）。
// ⚠️ `||` 保证：本机有真凭证时**绝不覆盖**。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_purchase_amount_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'purchase_amount_test_secret';

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const SERVER_DIR = path.join(__dirname, '..');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PURCHASE_AMOUNT } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan-purchase-amount-test-secret';
const NUMBER = 'YD6693-2|黑色|A';

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_purchase_amount') => {
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
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

/** 她扫开的那一款（只在渲染层与取数层用到，够用即可）。 */
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
  updated_at_text: '2026-10-14 22:00',
  product_record_id: 'prod_1',
});

/**
 * ⭐ 替身写服务：**只数"写入口进没进"**（零写入那条判据的核心）。
 * 站得住的原因：闸门发生在**调用写服务之前**，所以"写入口一次都没被调用" =
 * "一个字都没写"（不是"这次恰好没写成功"）。
 */
const createWriteSpy = () => {
  const calls = [];
  return {
    calls,
    sessions: {
      get: async () => null,
      submitKeyFor: () => 'scan_test:key:1',
      setLastRealm: async () => {},
    },
    submitReplenish: async (args) => {
      calls.push({ flow: 'replenish', args });
      return { ok: true, reused: false, batch_no: 'CGD-20261014-0001', request_count: 2 };
    },
    submitPurchaseReturn: async (args) => {
      calls.push({ flow: 'purchase_return', args });
      return { ok: true, reused: false, batch_no: 'CGD-20261014-0001', request_count: 1 };
    },
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

/** 提一次那个动作（`amount` = `null` ⇒ **整个字段都不带**，模拟"她一个字没填"）。 */
const postAction = async (base, realm, action, amount, openId = 'ou_purchase_amount') => {
  const body = {
    action,
    submit_key: 'scan_test:key:1',
  };
  if (realm === 'purchase_return') {
    body.return_sizes = '41';
    body.return_qty_41 = '1';
  } else {
    body.sizes = '41';
    body.qty_41 = '1';
  }
  if (amount !== null) body[SCAN_WRITE.fields.purchaseAmount] = amount;
  return fetch(pageUrl(base, realm), {
    method: 'POST',
    headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-PA1 一套配置：字段名唯一来源 + 显式布尔开关（真可配）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PA1 「整单金额」是**一套**配置：字段名唯一来源 + 显式布尔开关（false / 空串都真的关掉）', () => {
  // ① 字段名只有一个来源：`PURCHASE_AMOUNT.field` ⇒ `fields.purchaseAmount`（不抄两份）
  assert.equal(typeof PURCHASE_AMOUNT.field, 'string');
  assert.ok(PURCHASE_AMOUNT.field.length > 0);
  assert.equal(SCAN_WRITE.fields.purchaseAmount, PURCHASE_AMOUNT.field);
  // ② 必备文案都在配置里（人话走配置 ✓ 不写死在逻辑里）
  for (const key of ['purchaseAmountLabel', 'purchaseAmountPlaceholder',
    'purchaseAmountMissingTitle', 'purchaseAmountMissingBody', 'purchaseAmountBackLabel']) {
    assert.equal(typeof SCAN_WRITE.texts[key], 'string', `texts.${key} 必须在配置里`);
    assert.ok(SCAN_WRITE.texts[key].length > 0, `texts.${key} 不许是空串`);
  }
  // 她说的"必填"：默认就是必填（一个开关管退货 + 补货）
  assert.equal(SCAN_WRITE.purchaseAmount.required, true);

  // ③ **真读一次**：开关可配、且遵守 `readFlag` 那套语义（空串 = 关；认不出 ⇒ 抛错）
  const inChild = (env) => JSON.parse(execFileSync(process.execPath, ['-e',
    "const c=require('./src/config/scanWrite');"
    + 'process.stdout.write(JSON.stringify({ required: c.PURCHASE_AMOUNT.required,'
    + ' field: c.PURCHASE_AMOUNT.field, fields: c.SCAN_WRITE.fields.purchaseAmount }));',
  ], { cwd: SERVER_DIR, env: { ...process.env, ...env }, encoding: 'utf8' }));
  assert.equal(inChild({ SCAN_PURCHASE_AMOUNT_REQUIRED: 'false' }).required, false,
    '设成 false ⇒ 闸门关掉（她哪天说"不用必填了"，改环境变量就行）');
  assert.equal(inChild({ SCAN_PURCHASE_AMOUNT_REQUIRED: '' }).required, false,
    '**空串 = 关掉**（不是"回退默认值" ⇒ 没有 `|| 兜底` 那种关不掉的写法）');
  assert.equal(inChild({ SCAN_PURCHASE_AMOUNT_REQUIRED: 'yes' }).required, true);
  const renamed = inChild({ SCAN_PURCHASE_AMOUNT_FIELD: 'custom_total' });
  assert.equal(renamed.field, 'custom_total', '字段名可配');
  assert.equal(renamed.fields, 'custom_total', '字段名改一处、两边一起跟着变（唯一来源 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PA2 **退货**表单恰有一个「整单金额」输入 ＋ **补货那块一个都没有**（同一个 name / 同一套配置）
//
// ⭐⭐ 2026-10-16 **成对迁移**（依据 = 业务负责人真机截图 + 逐字：
//   「这个是**报货的页面，还是需要填写金额啊**」✗）：
//   改前逐字：`补货 / 退货两个表单各**恰有一个**「整单金额」输入`（两块**都**画 ⇒ 各 1 ✓）；
//   改后逐字：**补货那一块翻成 0**（她的话 ⇒ 页面上不再画那个框 ✓）、**退货那一半一个字没动**（仍 1 ✓）。
//   ⚠️ **不是放宽**：补货那两条从「必须有 1 个」翻成「**必须一个都没有**」= **变强** ✓；
//     更强的**反向哨兵**（连字段名 / 标签都塞回即红）在
//     `test/replenishTrimThreeFixes.test.js` 的 **AC-RP1** ✓。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PA2 **退货**表单恰有一个「整单金额」输入 · **补货那块一个都没有**（同一个 name，标签来自配置）', async () => {
  login();
  const write = createWriteSpy();
  const field = SCAN_WRITE.fields.purchaseAmount;
  const label = SCAN_WRITE.texts.purchaseAmountLabel;
  const occurrences = (html) => (html.match(new RegExp(`name="${field}"`, 'g')) || []).length;

  await withServer(appWith(write), async (base) => {
    const replenish = await (await fetch(pageUrl(base, 'replenish'), { headers: { cookie: sessionCookie() } })).text();
    const returns = await (await fetch(pageUrl(base, 'purchase_return'), { headers: { cookie: sessionCookie() } })).text();

    // 两块表单都在；**退货**恰有一个整单金额（"一次一个总额" ✓ 不是按行分填 ✗）
    assert.ok(replenish.includes('data-view="one-tap-replenish"'), '补货表单在');
    assert.ok(returns.includes('data-view="purchase-return"'), '退货表单在');
    // 改前逐字：`assert.equal(occurrences(replenish), 1, '补货表单里恰有一个「整单金额」输入');`
    // 改后逐字：下面这一行（**反向**钉住 ⇒ 变强 ✓）
    assert.equal(occurrences(replenish), 0,
      '⭐ 补货表单里**一个「整单金额」输入都没有**（她 2026-10-16 逐字：报货页不该还要填金额 ✗）');
    assert.equal(occurrences(returns), 1, '退货表单里恰有一个「整单金额」输入（本刀一个字没动 ✗）');
    // 标签来自配置（改配置两处一起变 —— 同一套 ✓）
    // 改前逐字：`assert.equal((replenish.match(new RegExp(`<label>${label}</label>`, 'g')) || []).length, 1);`
    // 改后逐字：下面这一行（补货 ⇒ 0 ✓ 连那个标签都不画 ✓）
    assert.equal((replenish.match(new RegExp(`<label>${label}</label>`, 'g')) || []).length, 0,
      '⭐ 补货那块连那个标签都不画（塞回即红 —— 强判据在 replenishTrimThreeFixes.test.js AC-RP1 ✓）');
    assert.equal((returns.match(new RegExp(`<label>${label}</label>`, 'g')) || []).length, 1,
      '退货那块标签仍来自配置 ✓（逐字未动 ✗）');
    // 且**两边的 name 完全相同**（同一套配置，不是各写各的 ✗）
    assert.equal(field, SCAN_WRITE.fields.purchaseAmount);
    void write;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PA3 空 ⇒ 400 + 人话（配置里那两句）+ **零写入**（写入口一次都没进）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PA3 整单金额为空 ⇒ 400 + 配置人话 + **零写入**（**退货**那条 —— 判据一字未放宽）', async () => {
  // ⭐⭐ 2026-10-16（A2/A3 接线）**成对迁移**（依据 = 她 2026-10-16 逐字「**补货不问金额**」）：
  //   改前逐字：
  //     `for (const [realm, action] of [`
  //       `['purchase_return', SCAN_WRITE.actions.purchaseReturn],`
  //       `['replenish', SCAN_WRITE.actions.replenish],`
  //     `]) { … assert.equal(missingField.status, 400, \`${realm}：空金额 ⇒ 400\`); … }`
  //   改后逐字：
  //     · **退货那一半一个字没动**（空 ⇒ 400 + 配置三句人话 + **零写入** ✓）；
  //     · **补货那一半**移出本用例 ⇒ 按**新口径反向**钉在下面的 **AC-PA3b**（空金额 ⇒ **200 + 真进写入口** ✓）。
  //   依据：她 2026-10-16 逐字「**补货不问金额**」＋ 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」
  //     ⇒ **退货不受影响** ✓（本用例仍是 400 + 三句人话 + 零写入 ⇒ 判据**没放宽、没删** ✗）；
  //     补货那条判据**没有消失**，只是**换了个方向**（AC-PA3b ＋ `purchaseAmountByRealm.test.js` 的
  //     AC-AR5 ＋ `purchaseAmountRealmWiring.test.js` 的 AC-PAWIRE3 —— **三处真判** ✓）。
  login();
  const realm = 'purchase_return';
  const action = SCAN_WRITE.actions.purchaseReturn;
  const write = createWriteSpy();
  await withServer(appWith(write), async (base) => {
    // ① **一个字都没填**（整个字段都不带）—— 最真实的那种"她忘了"
    const missingField = await postAction(base, realm, action, null);
    assert.equal(missingField.status, 400, `${realm}：空金额 ⇒ 400`);
    const html = await missingField.text();
    assert.ok(html.includes(SCAN_WRITE.texts.purchaseAmountMissingTitle), 'H1 = 配置里的人话');
    assert.ok(html.includes(SCAN_WRITE.texts.purchaseAmountMissingBody), '正文 = 配置里的人话（说清怎么填）');
    assert.ok(html.includes(SCAN_WRITE.texts.purchaseAmountBackLabel), '给了"回上一页填金额"的出口');

    // ② 空白串（她点了输入框又没打字 / 手改表单）
    const blank = await postAction(base, realm, action, '   ');
    assert.equal(blank.status, 400, `${realm}：空白串 ⇒ 400（不许当"填了"）`);

    // ③ **零写入**：那道闸门在**任何写之前** ⇒ 写入口**一次都没被调用**
    assert.deepEqual(write.calls, [], `${realm}：空金额 ⇒ 写入口一次都不许进（结构性零写入）`);
  });
});

// ── AC-PA3b ⭐⭐ 2026-10-16 新口径：**补货不问金额** ⇒ 空 / 空白串都**照样能提交** ──────────
test('AC-PA3b ⭐⭐ 补货不问金额：空金额 ⇒ **照样提交**（200 + 真进写入口；她 2026-10-16 逐字）', async () => {
  login();
  // ⚠️ 这一条是 AC-PA3 那半**迁过来的**（不是新加判据）：旧期望值（补货空 ⇒ 400）已**不再是**正确行为 ✗
  //    ⇒ 按她 2026-10-16「**补货不问金额**」**反向**钉住；退货那条仍在 AC-PA3 里**原样**判 ✓。
  for (const [amount, why] of [[null, '整个字段都不带'], ['   ', '空白串']]) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const res = await postAction(base, 'replenish', SCAN_WRITE.actions.replenish, amount);
      assert.equal(res.status, 200, `补货空金额（${why}）⇒ **200**（她 2026-10-16 逐字「补货不问金额」✓）`);
      assert.equal(write.calls.length, 1, `补货（${why}）要**真的**进写入口一次 ✓（不是被别的东西拦下 ✗）`);
      assert.equal(write.calls[0].flow, 'replenish');
      assert.equal('orderAmount' in write.calls[0].args, false,
        '补货**仍然不写金额** ✓（她 2026-10-15 的裁决：补货不写、只有到货才写「发生金额」✓）');
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PA4 非空 ⇒ 照旧提交（判据不许被新闸门收窄），且**入参形状一个字没变**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PA4 整单金额非空 ⇒ 照旧提交（200）：退货**逐字带上**金额 · 补货**先不带**（待她裁）', async () => {
  login();
  // ⭐⭐ 2026-10-16（task-52 · ②-⑭ 接线）**成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字（cases 带第三列"结果页标题"，断言它出现在成功页上）：
  //     `const cases = [`
  //       `['purchase_return', SCAN_WRITE.actions.purchaseReturn, '采购退货已生成'],`
  //       `['replenish', SCAN_WRITE.actions.replenish, '采购申请已生成'],`
  //     `];`
  //     `` `assert.ok(html.includes(doneTitle), \`${realm}：照旧给她结果页\`);` ``
  //   改后逐字（cases 只留两列；断言换成**统一成功页那一句**）：
  //     `const cases = [`
  //       `['purchase_return', SCAN_WRITE.actions.purchaseReturn],`
  //       `['replenish', SCAN_WRITE.actions.replenish],`
  //     `];`
  //     `` `assert.ok(html.includes(SCAN_PAGE.saleSuccess.message), \`${realm}：成功页 = 统一那一句\`);` ``
  //   依据：业务负责人 2026-10-16 逐字「**补货、退货还有验收，它都是异步的**……
  //     用户提交之后**都是一个成功页**，说『**已提交成功，数据会更新**』」——
  //     "批次号 / 已生成"那两句要等**后台那一跑**（写入口已进过一次=数据会更新 ✓），
  //     所以本用例把"哪句文案"改指向统一那一句 ⇒ **判据没放宽**（写入口仍须恰进一次 +
  //     入参形状两条断言**逐字未动** ✗）。
  const cases = [
    ['purchase_return', SCAN_WRITE.actions.purchaseReturn],
    ['replenish', SCAN_WRITE.actions.replenish],
  ];
  for (const [realm, action] of cases) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const response = await postAction(base, realm, action, '399');
      assert.equal(response.status, 200, `${realm}：非空 ⇒ 照旧提交`);
      const html = await response.text();
      assert.ok(html.includes(SCAN_PAGE.saleSuccess.message),
        `${realm}：成功页 = 配置里那一句统一文案（异步：批次号要等后台 ✓）`);
      assert.equal(write.calls.length, 1, `${realm}：写入口恰被调用一次`);
      assert.equal(write.calls[0].flow, realm === 'replenish' ? 'replenish' : 'purchase_return');
      // ⚠️ **入参形状一个字没变**：金额**不在**传给写服务的那个对象里
      //    （她还没裁"落到哪一列" ⇒ 本版**不落表** ✓，见 AC-PA6 的 TODO）
      const args = write.calls[0].args;
      // ⭐⭐ 2026-10-15（③ 写入 · 她裁决 ⓐ「复用「发生金额」」）**成对翻新**：
      //   改前逐字：`assert.equal(keys.includes('amount'), false, `…不许把金额塞给写服务…`);`
      //     ⚠️ 那条**本来就虚**（`'orderAmount'.includes('amount')` 是 **false** —— 大写 A ⇒
      //       大小写敏感 ⇒ 它从来没真正判过"有没有把金额给写服务" ✗ 我今晚抓到的）
      //   改后逐字：把两件事**分开钉死** ——
      //     · **退货**：金额**必须**逐字传给写服务（`orderAmount === '399'`）⇒ 它要落「发生金额」✓
      //     · **补货**：**不许**带任何金额入参（`orderAmount` 缺席）⇒ 这一列先不写（待她裁）✓
      //   依据：她 2026-10-14 晚「退货整单金额（必填），与补货同一套配置」＋ 2026-10-15 裁决 ⓐ
      //     ＋ Lead 的 ⓐ+ⓓ（退货现在写、补货那一列先不写、`TODO` 留着）。
      //   判据**没放宽**：而是把一个假绿换成两条能真红的（`assert.equal` 逐字值 + `in` 判缺席）✓
      if (realm === 'purchase_return') {
        assert.equal(args.orderAmount, '399', '退货：整单金额必须逐字透传给写服务（要落「发生金额」✓）');
      } else {
        assert.equal('orderAmount' in args, false, '补货：这一列**先不写** ⇒ 不许带金额入参（待她裁 ✓）');
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PA5 源码哨兵：一处闸门管两条动作 · 开关可关 · 渲染只有一处定义
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PA5 源码哨兵：补货 / 退货共用同一个闸门；开关读配置；金额输入只有一处定义', () => {
  const routeSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8');
  const configSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'config', 'scanWrite.js'), 'utf8');
  const viewSrc = rendererSource();

  // ① 一处实现：判空 + 400 页面各只有一个定义，两条动作各调一次（不复制 ✗）
  // ⭐⭐ 2026-10-16（A2/A3 接线）**成对迁移**（依据 = 她 2026-10-16 逐字「**补货不问金额**」）：
  //   改前逐字：
  //     `assert.equal((routeSrc.match(/purchaseAmountMissing\(body\)\) return purchaseAmountMissingPage\(/g) || []).length, 2, '补货 + 退货两条动作都走**同一个**闸门');`
  //   改后逐字：
  //     `assert.equal((routeSrc.match(/purchaseAmountMissing\(body, '(?:replenish|return)'\)\) return purchaseAmountMissingPage\(/g) || []).length, 2, '补货 + 退货两条动作都走**同一个**闸门（各自逐字带自己那条链路的**档位键** ✓）');`
  //   依据：闸门改成**按链路分档**（`requiredByRealm`）⇒ 调用点必须显式告诉它「当前是哪条链路」。
  //     ⚠️ 判据**没放宽**：仍是"数两处调用"，只是把签名换成**带档位键**的那种（更严 ✓）。
  //     ⭐ 更强的**逐字**哨兵（补货 `'replenish'` / 退货 `'return'` 各 2 处 = 判空 + 非数字、
  //       且**不许**再有"不带链路"的裸调用）在 `test/purchaseAmountRealmWiring.test.js` 的 **AC-PAWIRE2**
  //       —— 那里对**剥掉整行注释**后的源码判（免得被本文件/路由里"改前逐字"的注记误伤 ✓）。
  assert.equal((routeSrc.match(/const purchaseAmountMissing = /g) || []).length, 1);
  assert.equal((routeSrc.match(/const purchaseAmountMissingPage = /g) || []).length, 1);
  assert.equal((routeSrc.match(/purchaseAmountMissing\(body, '(?:replenish|return)'\)\) return purchaseAmountMissingPage\(/g) || []).length, 2,
    '补货 + 退货两条动作都走**同一个**闸门（各自逐字带自己那条链路的**档位键** ✓）');
  // ② 开关可关（`required === false` ⇒ 不拦）
  assert.ok(routeSrc.includes('writeConfig.purchaseAmount?.required === false'),
    '闸门必须能被配置关掉');
  // ③ 配置用 `readFlag`（显式布尔）+ 绝不用 `|| 兜底`（那种"清空关不掉"）
  assert.ok(configSrc.includes("readFlag(process.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED', true)"));
  assert.equal(configSrc.includes("'SCAN_PURCHASE_AMOUNT_REQUIRED') ||"), false,
    '不许 `process.env.X || fallback`（清空变量会静默回退 ⇒ 关不掉）');
  // ④ 渲染层：那一行**只有一处定义**；两处引用各自的**画法**逐字钉住
  //   ⭐⭐ 2026-10-16 **成对迁移**（依据 = 她真机截图 + 逐字「这个是报货的页面，**还是需要填写金额啊**」）：
  //     改前逐字（**一行**）：
  //       `assert.equal((viewSrc.match(/purchaseAmountRowHtml\(write\)/g) || []).length, 2,`
  //         `'补货表单 + 退货表单各用一次（共用同一个片段）');`
  //     改后逐字（**三行** —— 把"两次调用"拆成"各自的画法"来钉 ⇒ 比原来更严 ✓）：
  //       · 定义仍**恰一处** ✓；
  //       · **退货**那一处仍是**无条件**的那一行 ✓（本刀一个字没动 ✗）；
  //       · **补货**那一处改成**按配置**（`rp.amountRow` 三元）✓ —— 缺省 false ⇒ 那个框不再画 ✓。
  //     ⚠️ **不是放宽**：从"两处都无条件画"改成"退货无条件画 + 补货按配置画"，
  //       并且**新增**了更严的反向判据（`test/replenishTrimThreeFixes.test.js` AC-RP1：
  //       **连字段名 / 标签都塞回即红** ✓）。
  //     ⚠️ 顺带记一笔踩过的坑：注释里**抄一遍那两处代码原文**会让这个计数**凭空多出来**
  //       （我第一版就在 `views/scanPageRenderer.js` 的注释里抄了 ⇒ 计数变 4 ⇒ 假红 ✗）
  //       ⇒ 渲染层那段注释**刻意不抄代码原文** ✓。
  assert.equal((viewSrc.match(/const purchaseAmountRowHtml = /g) || []).length, 1,
    '那个片段仍**只有一处定义**（改一处两边一起变 ✓）');
  assert.equal((viewSrc.match(/\$\{purchaseAmountRowHtml\(write\)\}/g) || []).length, 1,
    '⭐ **退货**那一处仍是**无条件**的（逐字未动 ✓ 谁给它也加开关 ⇒ 红 ✓）');
  assert.equal((viewSrc.match(/rp\.amountRow \? purchaseAmountRowHtml\(write\) : ''/g) || []).length, 1,
    '⭐ **补货**那一处**按配置**决定画不画（缺省 false = 她这次要的终态 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PA6 ⭐⭐ 2026-10-15 晚：她**已裁** ⇒ 没有待办 TODO，但依据必须写清（含她的原话）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PA6 落表：**退货已落（③）**；补货**已裁"不写金额"** ⇒ **没有待办**，依据写清', () => {
  const routeSrc = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8');
  // ⭐⭐ 2026-10-15 晚 **成对翻新**（依据 = **她当次裁决**，逐字：
  //   「退货批次的整单金额 ⇒ 写进「发生金额」，**补货不会写金额**，
  //     **只有到货的时候才会写金额**，也是写进发生金额里」）：
  //   改前逐字：`assert.equal((routeSrc.match(/^\s*\/\/ TODO\(purchase-amount\):/gm) || []).length, 1,
  //               '只剩补货那一处真 TODO（那一列先不写 —— 待她裁 ✓）');`
  //   改后逐字：`… .length, 0, '她已裁 ⇒ **没有待办 TODO**（补货不写金额 = 一条裁决，不是待办）');`
  //   ⚠️ 判据**没有放宽**：从"必须留着 1 处 TODO"改成"必须**没有** TODO"（更严 ✓）；
  //     下面那串"必须写清依据"的关键词检查**一条不少**（只把「待她裁」换成**她的裁决原话**）。
  assert.equal((routeSrc.match(/^\s*\/\/ TODO\(purchase-amount\):/gm) || []).length, 0,
    '她已裁 ⇒ **没有待办 TODO**（补货不写金额 = 一条裁决，不是待办 ✓）');
  // 干注释不行 ✗：必须写清"为什么"（附只读核出来的代码点 + **她的裁决原话**）
  const anchor = routeSrc.indexOf('补货这一条不写金额');
  assert.ok(anchor > -1, '那处注释要在（写上她的裁决）');
  const block = routeSrc.slice(anchor, anchor + 2600);
  for (const needle of [
    'confirmPurchaseRequest', '未到货', 'writeAcceptance',
    '补货不会写金额', '只有到货的时候才会写金额',
  ]) {
    assert.ok(block.includes(needle), `补货那处注释要写清为什么（缺「${needle}」）`);
  }
  // 老链路那笔账**不许被碰**：核实过的两个事实要能在注释里看到（下一个接棒的人不用再核一遍）
  assert.ok(routeSrc.includes('发生金额'), '要写清"唯一那个金额列"是哪一个（发生金额）');
});
