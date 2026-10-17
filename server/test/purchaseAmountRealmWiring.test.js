'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * ⭐⭐ 2026-10-16（A2/A3 ① · **接线那一刀**）：「**补货不问金额**」在**路由**上真正生效的判据。
 *
 * 依据（业务负责人**逐字**）：
 *   · 2026-10-16：「**补货不问金额**」（＋「不用做那个为空去单价的功能了」）；
 *   · 2026-10-14 晚：「**退货整单金额（必填），与补货同一套配置**」
 * ⇒ ① **补货那条链路不问金额** ✓；② **退货 / 验收一个字都不受影响** ✓。
 *
 * ─── 三层判据，各有各的文件（**不重复也不打架**）────────────────────────────
 *   · **配置**那一半 → `test/purchaseAmountRealmTiers.test.js`（三档都是显式布尔 ✓）；
 *   · **分阶段的端到端** → `test/purchaseAmountByRealm.test.js`
 *     （AC-AR5 / AC-AR6 **接线一落就自动从 [待激活] 变真判据** ✓ 那两个文件的期望值**没动** ✗）；
 *   · **本文件** = **接线**那一半：闸门**按链路取档**（源码哨兵）＋ 三条链路的**行为**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC-PAWIRE0 ⭐ **探针**：两个检测器**真能红**（喂坏样本 ⇒ 必须报出来 ✓）。
 *   AC-PAWIRE1 🔴 源码哨兵：闸门**按链路**取档 —— 路由里真的读 `requiredByRealm`、
 *             "按链路取档"的 helper **恰一处**实现、且里面**没有** `|| true/false` 兜底
 *             （`||` 正是"清空变量却关不掉"的形状 ✗）。
 *   AC-PAWIRE2 🔴 源码哨兵：**两个调用点各自逐字**传**自己那条链路**的档位键
 *             （补货 `'replenish'` / 退货 `'return'`）—— 传错 / 不传 / 传页面领域 id
 *             （`'purchase_return'`）都**报红** ✓。
 *   AC-PAWIRE3 🔴 行为：**补货**不填金额 ⇒ **照样能提交**（200 + **真的**进写入口）；
 *             同一轮里**退货**不填 ⇒ **拦住 + 配置人话 + 零写入**（一个人字都没放宽 ✓）。
 *   AC-PAWIRE4 🔴 行为：退货填了**非数字** ⇒ **仍**拦住 + 零写入（2026-10-15 那条收紧不许被接线碰掉 ✗）。
 *   AC-PAWIRE5 ⭐ **验收不受影响**：`requiredByRealm.accept` 仍是显式 `true`
 *             ＋ 路由里**没有**任何一处给验收链路加金额闸门（谁顺手加一道 ⇒ 红 ✓）。
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ "零写入"用的是**替身写服务**：断言的是"**写入口一次都没进**"（比"表里没数据"强 ——
 *    数表会被别人写脏）。与 `test/purchaseAmountByRealm.test.js` 同一条做法 ✓。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// require 链里有模块级 `new V1BitableGateway()` ⇒ 先补一对**假**凭证（`||` 保证本机真凭证绝不被覆盖 ✓）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_amount_wiring_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'amount_wiring_test_secret';

const SERVER_DIR = path.join(__dirname, '..');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PURCHASE_AMOUNT } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const ROUTE_SRC = fs.readFileSync(path.join(SERVER_DIR, 'src/routes/scanPage.js'), 'utf8');
const SESSION_SECRET = 'scan-amount-wiring-test-secret';
const NUMBER = 'YD6693-2|黑色|A';

// ═══════════════════════════════════════════════════════════════════════════
// 检测器（纯函数 —— 探针可以喂坏样本 ✓）
// ═══════════════════════════════════════════════════════════════════════════

/** 「按链路取档」那个 helper 的函数体（`||` 兜底只在**它里面**判 ⇒ 不误伤路由别处 ✓）。 */
const helperBodyOf = (src) => {
  const start = src.indexOf('const purchaseAmountRequiredFor = ');
  if (start < 0) return '';
  const end = src.indexOf('\n  };', start);
  return end > start ? src.slice(start, end) : src.slice(start, start + 1500);
};

/**
 * ⚠️ 检测器只看**代码行**，不看**整行注释** —— `routes/scanPage.js` 里那些「改前逐字」的注记
 *   **故意**写着旧调用形状（`purchaseAmountMissing(body)`）⇒ 不剥掉就会把自己的注记
 *   骗成"还有裸调用" ✗。
 *   ⚠️ 这里**只剥"整行注释"**（行首空白之后紧跟两个斜杠的那种行）：**不碰块注释** ——
 *   路由源码里有**字符串/正则里的假块注释起始符**（起始符 41 处、收尾符 38 处 ⇒ 多出来的
 *   3 处就是那些假的），用「起始符 … 收尾符」那条正则去剥会**吞掉真代码**
 *   （实测：吞掉后连 `purchaseAmountMissing(body, 'replenish')` 都找不到了 ✗ —— 那就成了"检测器自己瞎"）。
 */
const stripLineComments = (src) => src.replace(/^\s*\/\/.*$/gm, '');

/** 同一个路由文件、**剥掉整行注释**后的那份 —— 两个接线检测器都只看它 ✓。 */
// ⭐ 2026-10-18 成对迁移（拆分第 1 刀）：金额闸门实现搬进 `routes/scanPage/actions.js`
//   ⇒ "源码哨兵"看「路由 + actions」两处；判定语义一项没放宽（塞回/漏传仍红 ✓）。
const ACTIONS_SRC = fs.readFileSync(path.join(SERVER_DIR, 'src', 'routes', 'scanPage', 'actions.js'), 'utf8');
const ACTIONS_CODE = stripLineComments(ACTIONS_SRC);
const ROUTE_CODE = stripLineComments(ROUTE_SRC + '\n' + ACTIONS_SRC);

/** 检测器 ①：闸门**真的按链路取档**吗？（缺 → 报红；有 `||` 兜底 → 报红 ✓） */
const tierWiringViolations = (src) => {
  const out = [];
  const impls = (src.match(/const purchaseAmountRequiredFor = /g) || []).length;
  if (impls !== 1) out.push(`"按链路取档"的 helper 必须**恰一处**实现（实际 ${impls} 处 ✗）`);
  // ⚠️ 判**函数体里**（= 真代码）有没有读那一档 —— **不看注释** ✗：
  //   否则"注记里提过 `requiredByRealm`、代码却退回"一个开关管两条链路""会**假绿**
  //   （本文件第一版就是这个形状，变异测试当场抓到 ✓）。
  const body = helperBodyOf(src);
  if (!/requiredByRealm/.test(body)) out.push('helper 的**函数体**里没读 `requiredByRealm`（按链路分档没接线 ✗）');
  if (!/\brealm\b/.test(body)) out.push('helper 的**函数体**里没用到「当前链路」参数（`realm` ✗）');
  if (/\|\|\s*(true|false)\b/.test(body)) {
    out.push('取档那里出现 `|| true/false` 兜底（清空变量就关不掉了 ✗）');
  }
  return out;
};

/** 检测器 ②：两处调用点**各自逐字**传自己那条链路的**档位键**吗？ */
const callRealmViolations = (src) => {
  const out = [];
  const count = (re) => (src.match(re) || []).length;
  const replenish = count(/purchaseAmount(?:Missing|Invalid)\(body, 'replenish'\)/g);
  const ret = count(/purchaseAmount(?:Missing|Invalid)\(body, 'return'\)/g);
  const bare = count(/purchaseAmount(?:Missing|Invalid)\(body\)/g);
  const wrongId = count(/purchaseAmount(?:Missing|Invalid)\(body, 'purchase_return'\)/g);
  if (replenish !== 2) out.push(`补货那两处调用点没逐字传档位键 'replenish'（实际 ${replenish} 处 ✗）`);
  if (ret !== 2) out.push(`退货那两处调用点没逐字传档位键 'return'（实际 ${ret} 处 ✗）`);
  if (bare !== 0) out.push(`${bare} 处调用**没带链路**（会退化回"一个开关管两条链路" ✗）`);
  if (wrongId !== 0) out.push(`${wrongId} 处把**页面领域 id** 'purchase_return' 当档位键传（拿错档位 ✗）`);
  return out;
};

test('AC-PAWIRE0 ⭐ 探针：两个检测器**真能红**（喂坏样本 ⇒ 必须报出来 ✓）', () => {
  // ① 取档检测器
  assert.ok(tierWiringViolations('const unrelated = 1;').length >= 2,
    '既没有 helper、函数体里也没有取档 ⇒ 必须报 ✓');
  assert.deepEqual(tierWiringViolations(
    'const purchaseAmountRequiredFor = (realm) => {\n    return requiredByRealm[realm] || true;\n  };',
  ), ['取档那里出现 `|| true/false` 兜底（清空变量就关不掉了 ✗）'], '`|| true` 兜底必须被认出 ✗');
  assert.deepEqual(tierWiringViolations(
    'const purchaseAmountRequiredFor = (realm) => {\n    if (requiredByRealm[realm] === false) return false;\n  };',
  ), [], '干净的取档不许误报 ✓');
  // ⚠️ 关键那条：**注释里提过** `requiredByRealm`、代码却退回"一个开关" ⇒ 必须报红（不能假绿 ✗）
  assert.equal(tierWiringViolations(
    '/** 注记里提过 requiredByRealm（诱饵 ✗） */\n'
    + 'const purchaseAmountRequiredFor = (realm) => {\n    if (required === false) return false;\n  };',
  ).length, 1, '注释里有 `requiredByRealm` 但**函数体里没有** ⇒ 必须报红（假绿是我实测踩过的坑 ✗）');
  // ② 调用点检测器
  assert.deepEqual(callRealmViolations(
    "purchaseAmountMissing(body, 'replenish');\npurchaseAmountInvalid(body, 'replenish');\n"
    + "purchaseAmountMissing(body, 'return');\npurchaseAmountInvalid(body, 'return');",
  ), [], '两处各传对的档位键 ⇒ 不报 ✓');
  const bad = callRealmViolations(
    "purchaseAmountMissing(body);\npurchaseAmountInvalid(body, 'purchase_return');",
  );
  assert.equal(bad.length, 4, `坏样本（不带链路 + 传领域 id）⇒ 四条全报 ✓（实际 ${JSON.stringify(bad)}）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAWIRE1 / AC-PAWIRE2 源码哨兵（塞回即红 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAWIRE1 🔴 源码哨兵：闸门**按链路取档**（`requiredByRealm` · 一处实现 · 无 `||` 兜底）', () => {
  // 实现只在 actions.js 里 ⇒ 这一条只看 actions（路由里那行是薄包装，不重复算实现）
  assert.deepEqual(tierWiringViolations(ACTIONS_CODE), [],
    '改前逐字（两个闸门各自）：`if (writeConfig.purchaseAmount?.required === false) return false;`\n'
    + '改后逐字：`if (purchaseAmountRequiredFor(realm) === false) return false;`\n'
    + '（`purchaseAmountRequiredFor` 里读 `requiredByRealm[realm]`，按链路取**显式布尔** ✓）\n'
    + '依据：业务负责人 2026-10-16 逐字「补货不问金额」＋ 2026-10-14「退货整单金额（必填），与补货同一套配置」');
});

test('AC-PAWIRE2 🔴 源码哨兵：两处调用点**逐字**传自己那条链路的档位键', () => {
  assert.deepEqual(callRealmViolations(ROUTE_CODE), [],
    "改前逐字：`if (purchaseAmountMissing(body)) return purchaseAmountMissingPage(…)`（两处**都不带链路**）\n"
    + "改后逐字：`if (purchaseAmountMissing(body, 'replenish')) …`（补货）／"
    + "`if (purchaseAmountMissing(body, 'return')) …`（退货）\n"
    + '依据：闸门要**按链路分档** ⇒ 调用点必须显式告诉它「当前是哪条链路」；'
    + "⚠️ 退货那处传的是**档位键** `'return'`，**不是**页面领域 id `'purchase_return'`（两者故意不同名）");
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAWIRE3 / AC-PAWIRE4 行为（真路由 + 替身写服务）
// ═══════════════════════════════════════════════════════════════════════════

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_amount_wiring') => {
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
  updated_at_text: '2026-10-16 03:00',
  product_record_id: 'prod_1',
});

/** 替身写服务：**只数"写入口进没进"** ✓ */
const createWriteSpy = () => {
  const calls = [];
  return {
    calls,
    sessions: { get: async () => null, submitKeyFor: () => 'scan_test:key:wiring', setLastRealm: async () => {} },
    submitReplenish: async (args) => {
      calls.push({ flow: 'replenish', args });
      return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 1 };
    },
    submitPurchaseReturn: async (args) => {
      calls.push({ flow: 'purchase_return', args });
      return { ok: true, reused: false, batch_no: 'CGD-20261016-0001', request_count: 1 };
    },
  };
};

const appWith = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, writeService: write,
  }));
  return app;
};

const pageUrl = (base, realm) => `${base}/s/${encodeURIComponent(NUMBER)}?from=${realm}`;

/** 提一次（`amount === null` ⇒ **整个字段都不带** = "她一个字没填" ✓） */
const postAction = async (base, realm, action, amount) => {
  const body = { action, submit_key: 'scan_test:key:wiring' };
  if (realm === 'purchase_return') { body.return_sizes = '41'; body.return_qty_41 = '1'; } else { body.sizes = '41'; body.qty_41 = '1'; }
  if (amount !== null) body[SCAN_WRITE.fields.purchaseAmount] = amount;
  return fetch(pageUrl(base, realm), {
    method: 'POST',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
};

test('AC-PAWIRE3 🔴 补货不填金额 ⇒ **照样能提交**；同一轮里退货不填 ⇒ **拦住 + 人话 + 零写入**', async () => {
  login();

  // ① 补货：她**一个字都没填** ⇒ 必须照旧提交（200）＋ **真的**进写入口
  const replenishWrite = createWriteSpy();
  await withServer(appWith(replenishWrite), async (base) => {
    const res = await postAction(base, 'replenish', SCAN_WRITE.actions.replenish, null);
    const html = await res.text();
    assert.equal(res.status, 200,
      '改前逐字（现象）：补货不填金额 ⇒ **400 + 「整单金额还没填」**（与退货共用一道闸门 ✗）\n'
      + '改后逐字：**200**（她 2026-10-16 逐字「补货不问金额」✓）\n'
      + `（实际 HTTP ${res.status}）`);
    assert.equal(replenishWrite.calls.length, 1, '补货那条要**真的**进写入口一次 ✓（不是被别的东西拦下）');
    assert.equal(replenishWrite.calls[0].flow, 'replenish');
    assert.equal('orderAmount' in replenishWrite.calls[0].args, false,
      '补货**仍然不写金额** ✓（她 2026-10-15 的裁决：补货不写、只有到货才写「发生金额」✓）');
    assert.equal(html.includes(SCAN_WRITE.texts.purchaseAmountMissingTitle), false,
      '补货这条路上**不许**再出现"还没填金额"那张页 ✗');
  });

  // ② 退货：同一轮里**照旧拦住**（一个人字都没放宽 ✓）
  const returnWrite = createWriteSpy();
  await withServer(appWith(returnWrite), async (base) => {
    const res = await postAction(base, 'purchase_return', SCAN_WRITE.actions.purchaseReturn, null);
    const html = await res.text();
    assert.equal(res.status, 400, `退货不填金额 ⇒ **必须**拦住（实际 HTTP ${res.status}）✗`);
    assert.ok(html.includes(SCAN_WRITE.texts.purchaseAmountMissingTitle), '人话来自配置（H1）✓');
    assert.ok(html.includes(SCAN_WRITE.texts.purchaseAmountMissingBody), '人话来自配置（说清怎么填）✓');
    assert.deepEqual(returnWrite.calls, [], '拦在**任何写之前** ⇒ 写入口一次都不许进（= 零写入 ✓）');
  });
});

test('AC-PAWIRE4 🔴 退货填了**非数字** ⇒ **仍**拦住 + 零写入（那条收紧不许被接线碰掉 ✗）', async () => {
  login();
  for (const bad of ['abc', '¥399']) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const res = await postAction(base, 'purchase_return', SCAN_WRITE.actions.purchaseReturn, bad);
      assert.equal(res.status, 400, `退货填「${bad}」⇒ 必须拦住（要落数字列 ⇒ 放过去就是假成功 ✗）`);
      assert.ok((await res.text()).includes(SCAN_WRITE.texts.purchaseAmountInvalidTitle), '人话来自配置 ✓');
      assert.deepEqual(write.calls, [], '拦住时写入口一次都不许进 ✓');
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PAWIRE5 验收不受影响（她 2026-10-14「与补货同一套配置」只管退货/补货两条）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PAWIRE5 ⭐ 验收不受影响：那一档仍是显式 `true` ＋ 路由里**没有**给验收加金额闸门', () => {
  assert.equal(typeof PURCHASE_AMOUNT.requiredByRealm.accept, 'boolean', '`accept` 必须是**显式布尔** ✓');
  assert.equal(PURCHASE_AMOUNT.requiredByRealm.accept, true,
    '验收那一档**没被本刀顺手放开** ✓（今天它本来就没有金额闸门 ⇒ 先钉 `true`）');
  assert.equal((ROUTE_CODE.match(/purchaseAmount(?:Missing|Invalid)\(body, 'accept'\)/g) || []).length, 0,
    '🔴 验收链路上**不许**出现金额闸门（她没要求过；谁顺手加一道 ⇒ 本条红 ✓）');
});
