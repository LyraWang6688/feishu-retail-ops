'use strict';
const { assertSubmitToast } = require('./support/submitToastAssert');

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ task-52 剩余：**补货 / 退货 / 验收「接异步」的验收判据**（她 2026-10-16 逐字）：
 *   「对于我们**补货、退货还有验收，它都是异步的**……**用户提交之后都是一个成功页**，
 *    说'已提交成功，数据会更新'类似这类的话就行了。**都是一个异步的提醒**」
 *   ＋ 地基已合（`#664`）：`services/purchaseWriteBackgroundService.js`（**形状照销售那件** ✓）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 本文件只钉**三件**（其余归别的文件 ✓ 不重复造 ✗ —— 金额闸门本身在
 * `test/scanPurchaseAmountRequired.test.js` 的 AC-PA1..PA6 ✓ 后台件本身在
 * `test/purchaseWriteBackground.test.js` ✓）：
 *
 *  **AC-ASY1**（**分阶段 · 今天就能跑，接线后一个字都不用改** ✓）
 *      三条链路各提一次合法请求 ⇒ 页面拿到成功页（200）⇒ **先回她** ✓
 *      ⇒ `await waitForPendingPurchaseBackgrounds()` ⇒ **数据真落库**（写入口进过 ✓）
 *      —— 今天走同步写：登记簿为空、`await` 立即返回、写入口**已**进过 ⇒ 绿 ✓
 *        接线后走后台：登记簿里有在飞的一跑 ⇒ `await` **真等到**它跑完 ⇒ 仍绿 ✓
 *      🔴 所以这条**既不 skip、也不放宽** ✓（她就是"先回成功页 ⇒ 数据最终真落库"✓）
 *
 *  **AC-ASY2**（今天就是真判据 ✓）**校验仍当场同步拦** ✗
 *      金额**非法**（非数字）⇒ **当场 400 + 人话 + 写入口零调用**（补货 / 退货**两条都判** ✓）
 *      ＋ 源码哨兵：**校验与写库仍在"成功响应之前"的同步路径上** ✗
 *      （把写库那一步挪进后台 ⇒ 红 ✓ —— 那会把"填错了"变成"看起来成功其实没写"✗ 她最恨 ✓）
 *
 *  **AC-ASY3**（今天就是真判据 ✓）**后台失败 ⇒ 不许停在成功页当没事** ✗ ⇒ 可查 + 可重试 ✓
 *      注入失败的 `runRest`（`ok:false` / 抛异常 两种形状都判）⇒
 *      `markFailed` **被调用** ✓ · 返回 `ok:false` ✓（绝不吞成成功 ✗）· 日志留痕 ✓（warn 事件名走注入的 config ✓）
 *      ＋ **探针**：登记簿**不是空跑**（带延迟的 runRest ⇒ `await` 之后确实已跑完 ✓）
 *
 *  **AC-ASY4**（幂等不拆）同一把 `submitKey` 连点两次 ⇒ 本件**原样透传**同一把键 ✓
 *      （幂等责任在写层 ✓ 本件**一个字不拼、不改写、不加后缀** ✗）
 *
 * ⚠️ 本文件**只动 test/** ✓（`routes/**` · `views/**` · `config/**` · `services/**` 一律不改 ✗）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// 与 `scanPurchaseAmountRequired.test.js` 同一条做法：路由链在 require 期就要凭证 ⇒ 补一对**假**的
// （`||` 保证本机有真凭证时**绝不覆盖** ✓）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_purchase_async_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'purchase_async_test_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');
const {
  createPurchaseWriteBackgroundService,
  waitForPendingPurchaseBackgrounds,
} = require('../src/services/purchaseWriteBackgroundService');

const SESSION_SECRET = 'scan-purchase-async-test-secret';
const NUMBER = 'YD6693-2|黑色|A';
const SERVER_DIR = path.join(__dirname, '..');

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_purchase_async') => {
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

/** 替身写服务：既数"写入口进没进"，也把结果还给调用方（AC-ASY1 用它证"数据真落库"✓）。 */
const createWriteSpy = ({ ok = true, message = '' } = {}) => {
  const calls = [];
  const record = (flow) => async (args) => {
    calls.push({ flow, args });
    if (!ok) return { ok: false, message, code: 'write_failed' };
    return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 2 };
  };
  return {
    calls,
    sessions: {
      get: async () => null,
      submitKeyFor: () => 'scan_test:key:async',
      setLastRealm: async () => {},
    },
    submitReplenish: record('replenish'),
    submitPurchaseReturn: record('purchase_return'),
    acceptFinish: record('accept'),
  };
};

const appWith = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: write,
  }));
  return app;
};

const pageUrl = (base, realm) => `${base}/r/${encodeURIComponent(NUMBER)}?from=${realm}`;

const postForm = async (url, cookie, body) => fetch(url, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
  redirect: 'manual',
});

/**
 * 三条链路各一条**合法**请求（她填好了 ⇒ 该成 ✓）。
 *
 * ⭐⭐ 2026-10-16（口子收尾 · **最小必要补齐输入数据**，断言**一个字都没改** ✗）：
 *   「尺码 / 数量 / 空单」三类校验**搬回同步路径**之后，"合法请求"必须**真的带尺码** ——
 *   改前逐字（两条 `extra`，**都没有 `sizes` / `return_sizes`**）：
 *     `{ chain: 'replenish', realm: 'replenish', action: SCAN_WRITE.actions.replenish, extra: { [`${SCAN_WRITE.fields.purchaseAmount}`]: '1200', qty_41: '2' } },`
 *     `{ chain: 'purchase_return', realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, extra: { [`${SCAN_WRITE.fields.purchaseAmount}`]: '800', [`${SCAN_WRITE.fields.returnQuantityPrefix}41`]: '1' } },`
 *   改后逐字（各加一个尺码勾选 —— `sizes: '41'` / `return_sizes: '41'`）：
 *     `… extra: { [`${SCAN_WRITE.fields.purchaseAmount}`]: '1200', [`${SCAN_WRITE.fields.replenishSizes}`]: '41', qty_41: '2' } },`
 *     `… extra: { [`${SCAN_WRITE.fields.purchaseAmount}`]: '800', [`${SCAN_WRITE.fields.returnSizes}`]: '41', [`${SCAN_WRITE.fields.returnQuantityPrefix}41`]: '1' } },`
 *   依据：业务负责人 2026-10-16 逐字「**异步只针对"写库"**；**校验必须当场同步拦**」
 *     ⇒ `sizes` 空 = "一句明细都没有" = **空单** ⇒ 当场 400（本来就不该是"合法请求"✗）。
 *   ⚠️ 这不是"放宽判据"：**AC-ASY1 / AC-ASY2-补货 的断言一行未动**（本条只是把
 *     "她填好了"那份输入**真的填好** ✓ —— 改前它是"没填尺码"的数据 ✗）。
 */
const legalCases = () => ([
  { chain: 'replenish', realm: 'replenish', action: SCAN_WRITE.actions.replenish, extra: { [`${SCAN_WRITE.fields.purchaseAmount}`]: '1200', [`${SCAN_WRITE.fields.replenishSizes}`]: '41', qty_41: '2' } },
  { chain: 'purchase_return', realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, extra: { [`${SCAN_WRITE.fields.purchaseAmount}`]: '800', [`${SCAN_WRITE.fields.returnSizes}`]: '41', [`${SCAN_WRITE.fields.returnQuantityPrefix}41`]: '1' } },
  { chain: 'accept', realm: 'accept', action: SCAN_WRITE.actions.acceptFinish, extra: { accept_41: '2' } },
]);

// ── AC-ASY1：先回成功页 ⇒ 后台写完 ⇒ 数据真落库（**分阶段 · 接线前后同一个字** ✓）────────
test('AC-ASY1 ⭐⭐ 补货 / 退货：先回成功页，等后台那一跑落地后**数据真落库**（接线前后同一份判据 ✓）', async () => {
  login();
  for (const c of legalCases().filter((x) => x.chain !== 'accept')) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const res = await postForm(pageUrl(base, c.realm), sessionCookie(), {
        action: c.action, submit_key: 'scan_test:key:async', ...c.extra,
      });
      // ① **先回她**：303 + 统一 toast（2026-10-29：「以后就没有成功页了」）—— 不许把她挂在后台那一跑上 ✗
      assertSubmitToast(res, `${c.chain}：合法提交 ⇒ 先回她`);
      // ② ⭐ 等"在飞的后台那一跑"跑完（今天为空 ⇒ 立即返回；接线后 ⇒ 真等到 ✓）
      await waitForPendingPurchaseBackgrounds();
      // ③ **数据真落库**：写入口**进过**（不是"看起来成功其实没写" ✗）
      assert.equal(write.calls.length, 1, `${c.chain}：等后台跑完 ⇒ 写入口确实进过一次（数据落地 ✓）`);
      assert.equal(write.calls[0].flow, c.chain, `${c.chain}：进的是**这条链路**的写入口 ✓`);
    });
  }
});

test('AC-ASY1b ⭐⭐ 验收（第三条链路）：**要么**成功页＋真的写了 —— **要么**如实不给她成功页＋**零写入** ✗ 绝不许"假成功"', async () => {
  login();
  const c = legalCases().find((x) => x.chain === 'accept');
  const write = createWriteSpy();
  await withServer(appWith(write), async (base) => {
    const res = await postForm(pageUrl(base, c.realm), sessionCookie(), {
      action: c.action, submit_key: 'scan_test:key:async', ...c.extra,
    });
    await waitForPendingPurchaseBackgrounds();
    // ⚠️ 2026-10-29：验收动作已随扫码验收页退场（`routes/scanPage/actions.js` 里那条注释）——
    //   所以这里的期望是"**没有成功回执**（不是 303）且零写入"；判据没放宽：
    //   **给回执就必须真写了**（假成功 ⇒ 红），**没给回执就一个字都不许写**（两边一致 ✓ 不骗她 ✓）。
    const hasToast = res.status === 303;
    if (hasToast) {
      assert.equal(write.calls.length, 1,
        '验收：**给了回执就必须真的写了** ✗（不许假成功 —— 她最恨的那条 ✓）');
      assert.equal(write.calls[0].flow, 'accept', '验收：进的是验收那条写入口 ✓');
    } else {
      assert.equal(write.calls.length, 0, '验收：没给回执 ⇒ **零写入** ✓（两边一致 ✓ 不骗她 ✓）');
      assert.notEqual(res.status, 200, '验收：非成功情形**不许**回 200 成功页（已退场 ✗）');
    }
  });
});

// ── AC-ASY2：校验仍**【当场同步】拦** ✗（绝不许被顺手挪进后台）────────────────────────
test('AC-ASY2 🔴 金额非法/空 ⇒ **当场 400 + 人话 + 写入口零调用**（**退货**那条 —— 判据一字未放宽）', async () => {
  login();
  // ⭐⭐ 2026-10-16（A2/A3 接线）**成对迁移**（依据 = 她 2026-10-16 逐字「**补货不问金额**」）：
  //   改前逐字（四条，补货 + 退货**都判**）：
  //     `const cases = [`
  //       `{ realm: 'replenish', action: SCAN_WRITE.actions.replenish, amount: 'abc', why: '非数字' },`
  //       `{ realm: 'replenish', action: SCAN_WRITE.actions.replenish, amount: '', why: '空' },`
  //       `{ realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, amount: 'abc', why: '非数字' },`
  //       `{ realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, amount: '', why: '空' },`
  //     `];`
  //   改后逐字（两条，**只留退货**）：
  //     `const cases = [`
  //       `{ realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, amount: 'abc', why: '非数字' },`
  //       `{ realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, amount: '', why: '空' },`
  //     `];`
  //   依据：她 2026-10-16 逐字「**补货不问金额**」（＋ 2026-10-14「退货整单金额（必填），与补货同一套配置」）
  //     ⇒ **退货**那条闸门**照旧**（本用例的"当场同步拦 + 零写入"**一个字都没放宽** ✓）；
  //     补货那条**不再有**金额校验 ⇒ 它的判据**按新口径反向钉住**（见下面 AC-ASY2-补货 ✓
  //     ＋ `test/purchaseAmountRealmWiring.test.js` 的 AC-PAWIRE3 ＋ `test/purchaseAmountByRealm.test.js`
  //     的 AC-AR5 也在真判 ✓）—— 判据**没有消失**，只是**换了个方向** ✓。
  const cases = [
    { realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, amount: 'abc', why: '非数字' },
    { realm: 'purchase_return', action: SCAN_WRITE.actions.purchaseReturn, amount: '', why: '空' },
  ];
  for (const c of cases) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const res = await postForm(pageUrl(base, c.realm), sessionCookie(), {
        action: c.action, submit_key: 'scan_test:key:async', [SCAN_WRITE.fields.purchaseAmount]: c.amount,
      });
      assert.equal(res.status, 400, `${c.realm} · 金额${c.why} ⇒ **当场** 400（不是成功页 ✗）`);
      const html = await res.text();
      assert.ok(html.trim().length > 0, `${c.realm}：拦住时**必须给她人话**（不许干巴巴 400 ✗）`);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(write.calls.length, 0, `${c.realm} · 金额${c.why} ⇒ **写入口一次都没进**（零写入 ✓ 且**同步**拦 ✓）`);
    });
  }
});

// ── AC-ASY2-补货：⭐ 2026-10-16 新口径「补货不问金额」⇒ 金额**空 / 非数字都不再拦** ────────────
test('AC-ASY2-补货 ⭐⭐ 补货不问金额：金额空 / 非数字**都不再拦**（照样 200 + 后台真写一次 ✓）', async () => {
  login();
  // 依据 = 她 2026-10-16 逐字「**补货不问金额**」＋「不用做那个为空去单价的功能了」
  //   ⇒ 补货这条链路上**没有**金额校验（填了也不看、不落表 —— 那是到货核对那一列的事 ✓）。
  //   ⚠️ 这条**不是** AC-ASY2 的放宽：退货那两条照旧 400 + 零写入（上面那条 ✓）；
  //     补货这一侧的期望值只是**跟着业务口径反向**了（旧"必须 400"已不再是正确行为 ✗）。
  // ⭐⭐ 2026-10-16（口子收尾 · **最小必要补齐输入数据**，断言**一个字都没改** ✗）：
  //   改前逐字（`body` 只有 `action` / `submit_key` / 金额 —— **没有尺码**）：
  //     `action: SCAN_WRITE.actions.replenish, submit_key: 'scan_test:key:async', [SCAN_WRITE.fields.purchaseAmount]: amount,`
  //   改后逐字（补上"她确实勾了一个尺码"那一格）：
  //     `action: SCAN_WRITE.actions.replenish, submit_key: 'scan_test:key:async', [`${SCAN_WRITE.fields.replenishSizes}`]: '41', qty_41: '2', [SCAN_WRITE.fields.purchaseAmount]: amount,`
  //   依据：本用例测的是"**补货不问金额**"（金额空 / 非数字 ⇒ 照样 200）——
  //     它**不是**在测"空单也放行" ✗；尺码空 = 空单 ⇒ 按她 2026-10-16 的
  //     「**异步只针对"写库"**；校验必须**当场同步拦**」**理应 400** ✓（不是这条用例的题 ✗）。
  for (const amount of ['abc', '']) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const res = await postForm(pageUrl(base, 'replenish'), sessionCookie(), {
        action: SCAN_WRITE.actions.replenish, submit_key: 'scan_test:key:async',
        [`${SCAN_WRITE.fields.replenishSizes}`]: '41', qty_41: '2',
        [SCAN_WRITE.fields.purchaseAmount]: amount,
      });
      assertSubmitToast(res, `补货填「${amount || '(空)'}」⇒ 照样交出去 ✓（她 2026-10-16：「补货不问金额」）`);
      await waitForPendingPurchaseBackgrounds();
      assert.equal(write.calls.length, 1, '补货那条要**真的**走完写入口一次 ✓（不是被别的东西拦下 ✗）');
      assert.equal(write.calls[0].flow, 'replenish');
      assert.equal('orderAmount' in write.calls[0].args, false,
        '补货**仍然不写金额** ✓（她 2026-10-15 的裁决：补货不写、只有到货才写「发生金额」✓）');
    });
  }
});

test('AC-ASY2b 🔴 源码哨兵：**校验与写库仍在"成功响应之前"的同步路径上**（挪进后台 ⇒ 红 ✗）', () => {
  // ⭐ 2026-10-18 成对迁移（拆分第 1 刀：动作分派搬进 `routes/scanPage/actions.js`）：
  //   改前逐字：只看聚合后的 `routes/scanPage.js` 文本。
  //   改后逐字：聚合文本 ＋ `routes/scanPage/actions.js`（同一批实现在两处，判据跟着看两处）。
  //   依据：拆分是**纯搬运**；"写库入口仍在同步路径"的语义一个字没变（塞回/挪走仍会红 ✓）。
  const source = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage', 'actions.js'), 'utf8');
  // ① 三条链路的写入口调用必须在路由里（不是"只在后台件里"✗）
  for (const fn of ['submitReplenish', 'submitPurchaseReturn', 'acceptFinish']) {
    assert.ok(source.includes(fn), `路由里必须仍能看见 \`${fn}\`（写库那一步 ✗ 不许只活在后台件里）`);
  }
  // ② 后台件**只接"写库那一步"**：它不该出现任何"校验"字样（金额 / 尺码 / 库存）
  const bg = fs.readFileSync(path.join(SERVER_DIR, 'src', 'services', 'purchaseWriteBackgroundService.js'), 'utf8');
  for (const forbidden of ['purchaseAmountMissing', 'sizes', 'inventory.apply']) {
    assert.equal(bg.includes(forbidden), false,
      `后台件里**不该**出现校验/库存相关的东西（\`${forbidden}\`）✗ —— 校验必须留在【同步】那一半 ✓`);
  }
  // ③ 幂等键**原样透传**（本件不拼、不加后缀 ✗）—— 见 AC-ASY4 的行为判据 ✓ 这里先钉"没有拼"的写法
  assert.equal(/submitKey\s*[:=]\s*[`'"][^`'"]*\$\{/.test(bg), false,
    '后台件里**不许**对 submitKey 做字符串拼接（幂等键必须原样透传 ✗）');
});

// ── AC-ASY3：后台失败 ⇒ 不许假装成功 ✗ ⇒ 可查 + 可重试 ────────────────────────────────
test('AC-ASY3 ⭐⭐ 后台失败（`ok:false` / 抛异常）⇒ `markFailed` 被调用 + 返回 `ok:false`（绝不吞成成功 ✗）', async () => {
  const shapes = [
    { why: '返回 ok:false', runRest: async () => ({ ok: false, message: '飞书 500' }) },
    { why: '抛异常', runRest: async () => { throw new Error('boom'); } },
  ];
  for (const s of shapes) {
    const failed = [];
    const svc = createPurchaseWriteBackgroundService({
      runRest: s.runRest,
      markFailed: async (info) => { failed.push(info); },
      purchaseAsync: { backgroundTimeoutMs: 5000 },
      config: { events: { restTiming: 'purchase.write.rest.timing', restFailed: 'purchase.write.rest.failed' } },
    });
    const result = await svc.schedulePurchaseRest({ chain: 'replenish', requestId: 'req_async', submitKey: 'scan_test:key:async' });
    assert.equal(result?.ok, false, `${s.why} ⇒ **返回 ok:false**（绝不假装成功 ✗）`);
    assert.equal(failed.length, 1, `${s.why} ⇒ **markFailed 被调用一次**（状态可查、可重试 ✓）`);
    assert.equal(failed[0].chain, 'replenish', 'markFailed 拿到链路名 ✓（谁失败看得出 ✓）');
    assert.equal(failed[0].submitKey, 'scan_test:key:async', 'markFailed 拿到**同一把** submitKey ✓（重试走同一把 ✓）');
  }
});

test('AC-ASY3b ⭐ 探针：登记簿**不是空跑** —— 带延迟的后台那一跑 ⇒ `await` 之后确实已跑完', async () => {
  let finished = false;
  const svc = createPurchaseWriteBackgroundService({
    runRest: async () => { await new Promise((r) => setTimeout(r, 25)); finished = true; return { ok: true }; },
    config: { events: {} },
  });
  const promise = svc.schedulePurchaseRest({ chain: 'accept', requestId: 'req_probe', submitKey: 'k1' });
  assert.equal(finished, false, '刚排下去时**还没跑完**（= 真的在飞 ✓ 不是同步跑完的空转 ✗）');
  await waitForPendingPurchaseBackgrounds();
  assert.equal(finished, true, '`await waitForPendingPurchaseBackgrounds()` 之后**确实跑完了** ✓（探针证明它真等 ✓）');
  await promise;
});

// ── AC-ASY4：幂等不拆（同一把 submitKey 连点两次 ⇒ 原样透传）──────────────────────────
test('AC-ASY4 ⭐ 幂等：同一把 `submitKey` 连点两次 ⇒ 本件**原样透传**同一把键（不拼、不改写 ✗）', async () => {
  const seen = [];
  const svc = createPurchaseWriteBackgroundService({
    runRest: async ({ submitKey, chain, context }) => { seen.push({ submitKey, chain, context }); return { ok: true }; },
    config: { events: {} },
  });
  const key = 'scan_test:key:same';
  await svc.schedulePurchaseRest({ chain: 'replenish', requestId: 'r1', submitKey: key, context: { a: 1 } });
  await svc.schedulePurchaseRest({ chain: 'replenish', requestId: 'r2', submitKey: key, context: { a: 1 } });
  assert.equal(seen.length, 2, '两次都真的排了下去 ✓（本件不做去重 ✗ —— 幂等由**写层**用这同一把键保证 ✓）');
  assert.deepEqual(seen.map((s) => s.submitKey), [key, key], '两次拿到的都是**同一把原样**键 ✓（没有加后缀/时间戳 ✗）');
  assert.deepEqual(seen.map((s) => s.chain), ['replenish', 'replenish'], '链路名原样 ✓');
});
