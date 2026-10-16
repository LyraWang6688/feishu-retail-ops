'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');

/**
 * replenishTrimThreeFixes.test.js —— **补货（报货）tab 那三处**的成对迁移判据（2026-10-16）。
 *
 * 依据（业务负责人 2026-10-16 **真机截图 · 补货（报货）tab · 货品 `832-500`** ＋ **逐字**）：
 *   「这个是**报货的页面，还是需要填写金额啊** ✗，以及**不需要的文字说明给删除** ✗，
 *     **生成报货订单按钮文字改为补货** ✗」
 *
 * ⭐ 与她**退货 tab** 那一次（`test/multiItemOrderReturnTrim.test.js`）**同一个形状、同一句依据**：
 *   那次她选的是「**说明 + 「本单已加的货品」那整块都删**」—— **这一次她点了补货** ⇒ **同样处理** ✓
 *   （所以本文件与那个文件是**成对**的：一个管退货、一个管补货，两边都留**正向**判据防"删过头" ✗）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *
 *   AC-RP1 🔴 补货块里**没有**「整单金额」那一块 —— **两处哨兵**（配置里的**字面量**
 *            ＋ 那个输入的**字段名** `name="purchase_amount"`）⇒ **塞回即红** ✓
 *   AC-RP2 🔴 补货的**校验仍不要求金额**：`requiredByRealm.replenish === false`（显式布尔）
 *            ＋ **行为**：一个空金额真的 POST 进去 ⇒ **200 + 真进写入口**（能真红 ✓）
 *            ＋ ⭐ **两半一致**（页面上没有的框，后端也不因为它空而拦 ✓）
 *   AC-RP3 🔴 说明段 / 「本单已加的货品」标题 / 空态提示 **都不渲染**（三处塞回即红）
 *            ＋ ⭐ **正向**（防"删过头" ✗）：**有第二个货品时列表仍要出现** ✓
 *   AC-RP4 🔴 按钮文案 = 「**补货**」（**配置**里 ✓ 旧文案 `生成报货订单` **塞回即红** ✓）
 *   AC-RP5 ⭐ **范围哨兵**：**退货 / 销售** 两个领域的块**逐字未动**（各取一块比对 ✓ 能真红 ✓）
 *            ＋ **验收**如实标注（`accept` **已从 `REALMS` 退场** ⇒ 没有"那一块"可比对 ✗
 *              —— 见下面 AC-RP5c 的说明与它**仍在**的那两处判据 ✓）
 *   AC-RP6 ⭐ **探针**：上面几条检测器**真能红** ✓（喂坏样本 ⇒ 必须报出来 ✓ 不空跑）
 *
 * ── ⭐⭐ 2026-10-16 **追加那一处**（补货尺码清单 **一行 3 组**）────────────────────────────
 * 依据（业务负责人真机截图 + 逐字 · 见工作树根的 `LEAD-ADDENDUM.md`，**该页不入库** ✗）：
 *   「我记得我要把**补货的尺码 × 数量，不用一行一个尺码，而是改为一行 3 组尺码 × 数量**这样的模式」
 * ⚠️ **这不是"没做"** —— 2026-10-14 就加了 `.purchase-size-grid` ＋ `--size-cols`（3 列），
 *   但那个 `<ul>` **同时挂着旧类 `purchase-sizes`**（旧一列版式的残留）⇒
 *   两条**同特异性**的单类选择器里**后出现的那条赢**（`.purchase-sizes` 在 `scanPageRenderer.js:256`）
 *   ⇒ 线上一直是**一行一个** ✗（**静默失效** ⇒ 她截图是对的 ✓）。
 *   修法 = **摘掉那个旧类**（`STYLE` 里一行 CSS 都没动 ✓）。
 *
 *   ⚠️ **编号映射**（追加要求里写的是 `AC-RP6..RP9` —— 但 `AC-RP6` 已被本文件前面的探针占了）：
 *     追加的 `AC-RP6 → 本文件 AC-RP7` · `AC-RP7 → AC-RP8` · `AC-RP8 → AC-RP9` · `AC-RP9 → AC-RP10`；
 *     本文件原来的探针让位改名为 **AC-RP11**（内容与口径**一个字没变** ✗ 只改名 ✓）。
 *
 *   AC-RP7  ⭐⭐ **补货尺码清单真的渲染成 3 列**（**CSS 级联**哨兵：同特异性取**最后一条** ✓
 *             ⇒ 把旧类塞回 / 再加一条更晚的一列规则 ⇒ **红** ✓）＋ `--size-cols: 3` 来自配置 ✓
 *   AC-RP8  ⭐⭐ **功能零变化**：同一个 POST 载荷的**字段名与顺序逐字相同**（fixture 比对 ✓ 能真红 ✓）
 *   AC-RP9  ⭐⭐ 组内元素（尺码字 + 数量 + 现货/缺码标记）**逐字仍在** ✓（删掉标记 ⇒ 红 ✓）
 *   AC-RP10 ⭐ **范围哨兵**：销售 / 退货 / 库存三个领域的清单**逐字未动** ✓
 *
 * ⚠️ **全部只读**：纯函数渲染 ＋ **真路由**（express 监听 0 端口，不联网、不写任何 Base）✓
 * 🔴 本刀**只碰** `views/scanPageRenderer.js` · `config/scanPage.js` · `test/**` ＋ 一份 `docs/**` ✓
 *   `config/scanWrite.js` / `routes/**` / `services/**` / `scanWriteService.js` **一个字没动** ✗
 *   （AC-RP4 结尾那条源码哨兵就是钉这个边界的 ✓）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_rp_trim';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'rp_trim_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'rp_trim_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE, MULTI_ITEM_RENDER_TEXTS } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
// ⭐ 2026-10-16 下半场：AC-RP8 的"控件名清单"要把多货品那两颗 **submitter** 排掉
//   ⇒ 它们的字段名**只从配置取**（不写死 ✗）
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const renderer = require('../src/views/scanPageRenderer');

const RENDERER_SRC = rendererSource();
const SCAN_WRITE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'config', 'scanWrite.js'), 'utf8');

// ── 改前逐字（她**点掉**的那三处 ＋ 那颗按钮的旧名 —— 判据拿它们当"塞回即红"的锚 ✓）─────
const OLD_AMOUNT_LABEL = '整单金额（必填）'; // 她截图里那个框的标签（配置里那一句 ✓）
const AMOUNT_FIELD = 'purchase_amount';      // 那个输入的字段名（配置里的唯一来源 ✓）
const OLD_HINT = '加进来的货品会和上面对着的这一个一起提交；每个货品的尺码与数量在它自己的块里填。';
const OLD_TITLE = '本单已加的货品';
const OLD_EMPTY = '还没有加第二个货品。';
const OLD_BUTTON = '生成报货订单';
const NEW_BUTTON = '补货';
const RETURN_BUTTON = '退货'; // 退货那一块**逐字未动**（她 2026-10-16 早前那次定的 ✓）

const NUMBER = '832-500|黑色|A';
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_rp', name: 'rp', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

/** 她的真实形状：有库存 ⇒ 尺码行画得出来 ⇒ 多货品块 + 提交按钮都在 ✓ */
const herView = (extra = {}) => ({
  found: true, number: NUMBER, item_no: '832-500', color: '黑色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }], missing_count: 0,
  sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 04:1x',
  rows: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'].map((size, index) => ({
    size_text: size, cells: index === 4 ? [{ count: 2 }] : [], total: index === 4 ? 2 : 0, missing: index !== 4,
  })),
  ...extra,
});

/** 替身写服务：只数"写入口进没进"（= 结构性零写入 / 真进了那一次 ✓）。 */
const createWriteSpy = () => {
  const calls = [];
  return {
    calls,
    sessions: {
      get: async () => null, submitKeyFor: () => 'rp_test:key:1', setLastRealm: async () => {},
      saveSaleProgress: async () => ({ ok: true }),
    },
    listAccessories: async () => [],
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

const appWith = (write, viewExtra = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => herView(viewExtra) },
    gateway: {},
    writeService: write,
    startSnapshot: false,
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

/**
 * 真路由取那一块（与 `multiItemOrderReturnTrim.test.js` 同一套夹具口径 ✓）。
 * `from` 决定去哪一块；`extra.multi_items` 有值 = 她**真的加了第二个货品** ✓。
 */
const fetchRealm = async (from, extra = {}) => {
  let out = null;
  await withServer(appWith(createWriteSpy(), extra), async (base) => {
    const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=${from}`,
      { headers: { cookie: COOKIE } });
    assert.equal(response.status, 200, `?from=${from} 那一页要能打开 ✓`);
    out = await response.text();
  });
  return out;
};

const blockOf = (html, realm) => {
  const at = html.indexOf(`realm-block--${realm}`);
  assert.notEqual(at, -1, `页面上要有 realm-block--${realm} 那一块 ✓`);
  return html.slice(at, html.indexOf('</section>', at) + 10);
};

const submitButtonTextOf = (block) => {
  // ⭐ 2026-10-16 下半场（Lead 裁决"手术刀 ①" ⇒ `SCAN_MULTI_ITEM_ADD_WIRE` 缺省 `true`）**成对迁移**：
  //   改前逐字：`const button = block.match(/<button type="submit" class="btn btn--primary"[^>]*>([^<]*)<\/button>/);`
  //     ＋ `return button[1];` —— 那时开关关着，这一块里**只有一颗**这样的按钮 ✓。
  //   改后逐字：下面这两行 —— 取**最后一颗**（同一张表单里现在还有多货品那颗"＋ 再加一个货品"，
  //     它在上面 ✓）。**不是放宽**：AC-RP4 / AC-RP5a 的原话就是"**最下面那颗**蓝色按钮" ⇒ 取末颗正是它 ✓；
  //     多出来的那一颗由 `multiItemOrderFormHalf` 的 AC-MI-F1/F2 单独钉着 ✓。
  const buttons = [...block.matchAll(/<button type="submit" class="btn btn--primary"[^>]*>([^<]*)<\/button>/g)];
  assert.ok(buttons.length, '这一块里要有一颗提交按钮 ✓');
  return buttons[buttons.length - 1][1];
};

// ═══════════════════════════════════════════════════════════════════════════
// ① AC-RP1 🔴 补货块里**没有**「整单金额」那一块（两处哨兵 ⇒ 塞回即红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP1 🔴 补货（报货）块里**不许**再有「整单金额」那一块（她逐字：还是需要填写金额啊）', async () => {
  const html = await fetchRealm('replenish');
  const block = blockOf(html, 'replenish');
  // ⭐ 哨兵一：**字面量**（配置里那一句 —— 她截图里看到的就是它 ✗）
  assert.equal(block.includes(OLD_AMOUNT_LABEL), false,
    `🔴 那个框必须不再画（塞回即红）：${OLD_AMOUNT_LABEL}`);
  assert.equal(block.includes(SCAN_WRITE.texts.purchaseAmountLabel), false,
    '⭐ 配置里的标签也**一个字都不该出现**在补货块里 ✓');
  // ⭐ 哨兵二：那个输入的**字段名**（塞回即红 ✓ 改标签也躲不过这一条 ✓）
  assert.equal(block.includes(`name="${AMOUNT_FIELD}"`), false,
    `🔴 那个输入必须不再画（字段名哨兵，塞回即红）：name="${AMOUNT_FIELD}"`);
  assert.equal(block.includes(`name="${SCAN_WRITE.fields.purchaseAmount}"`), false,
    '⭐ 配置里的字段名也在补货块里一个字都不该出现 ✓');
  // 连那一行 `form-row` 的壳都不该在（不是"画出来但为空" ✗）
  assert.equal(block.includes('class="form-row"'), false,
    '⭐ 整行**不在**（不留空壳 / 不留一段莫名的空隙 ✓）');
  // ⚠️ 配置先行：那个开关走 `readFlag`（**显式布尔** ⇒ 清空 / 写 false 就真关掉 ✓ 不许 `||` 兜底 ✗）
  assert.equal(typeof SCAN_PAGE.replenishForm.amountRow, 'boolean',
    '`SCAN_PAGE.replenishForm.amountRow` 必须是**显式布尔**（不许 undefined ⇒ 那是关不掉的形状 ✗）');
  assert.equal(SCAN_PAGE.replenishForm.amountRow, false,
    '缺省必须是 **false** = 她这次要的终态（补货页上没有那个框 ✓）');
  const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'scanPage.js'), 'utf8');
  assert.match(CONFIG_SRC, /readFlag\(process\.env, 'SCAN_PAGE_REPLENISH_AMOUNT_ROW_ENABLED', false\)/,
    '⭐ 走配置：`SCAN_PAGE_REPLENISH_AMOUNT_ROW_ENABLED`（换值**不用改代码** ✓ 配置先行 ✓）');
  assert.equal(/\|\|\s*(true|false)\b/.test(CONFIG_SRC), false,
    '配置里**不许** `|| true/false` 那种兜底（清空就关不掉了 ✗）');
  // ⭐ 唯一决定点：补货那一处**按配置**决定画不画（不是"顺手删掉那一行"、也没写死布尔 ✗）
  assert.equal(RENDERER_SRC.includes("${rp.amountRow ? purchaseAmountRowHtml(write) : ''}"), true,
    '⭐ 补货那一处必须**按 `rp.amountRow`** 决定（配置驱动 ✓ 一处决定 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ② AC-RP2 🔴 补货的**校验仍不要求金额**（两半一致；空金额真的能提交 ✓）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP2a 🔴 校验那一半：`requiredByRealm.replenish === false`（显式布尔）· 退货/验收仍 true', () => {
  const tiers = SCAN_WRITE.purchaseAmount.requiredByRealm;
  for (const realm of ['replenish', 'return', 'accept']) {
    assert.equal(typeof tiers[realm], 'boolean', `「${realm}」那一档必须是**显式布尔** ✓`);
  }
  assert.equal(tiers.replenish, false, '🔴 补货**不要求**金额（她 2026-10-16 早定的「补货不问金额」✓）');
  assert.equal(tiers.return, true, '🔴 退货**仍要**金额（一个字没动 ✗）');
  assert.equal(tiers.accept, true, '🔴 验收**仍要**金额（一个字没动 ✗）');
});

test('AC-RP2b 🔴 行为：补货**一个空金额**真的能提交（200 + **真进写入口** ⇒ 能真红 ✓）', async () => {
  // ⚠️ 与 `scanPurchaseAmountRequired.test.js` 的 AC-PA3b 是**同一个口径**、不同的一层：
  //   那一条钉"路由的闸门按链路分档"，本一条钉"**这一刀没有把校验碰坏**"（她这次只点渲染 ✗）。
  for (const [amount, why] of [[null, '整个字段都不带'], ['   ', '空白串']]) {
    const write = createWriteSpy();
    await withServer(appWith(write), async (base) => {
      const body = { action: SCAN_WRITE.actions.replenish, submit_key: 'rp_test:key:1', sizes: '41', qty_41: '1' };
      if (amount !== null) body[SCAN_WRITE.fields.purchaseAmount] = amount;
      const response = await fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=replenish`, {
        method: 'POST',
        headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      assert.equal(response.status, 200,
        `补货空金额（${why}）⇒ **200**（她 2026-10-16 逐字「补货不问金额」✓ —— 这里返回 400 ⇒ 红 ✓）`);
      assert.equal(write.calls.length, 1, `补货（${why}）要**真的**进写入口一次 ✓（被拦下 ⇒ 红 ✓）`);
      assert.equal(write.calls[0].flow, 'replenish');
    });
  }
});

test('AC-RP2c ⭐ **两半一致**：页面上没有那个框 ＋ 后端不因为它空而拦（她截图里那个矛盾不再存在 ✓）', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  const pageDrawsAmountRow = block.includes(`name="${SCAN_WRITE.fields.purchaseAmount}"`);
  const backendRequiresAmount = SCAN_WRITE.purchaseAmount.requiredByRealm.replenish === true;
  assert.equal(pageDrawsAmountRow, false, '页面：**不画**那个框 ✓');
  assert.equal(backendRequiresAmount, false, '后端：**不要求**它 ✓');
  assert.equal(pageDrawsAmountRow, backendRequiresAmount,
    '⭐ 两半必须**一致**：页面画那个框 ⟺ 后端要求它 —— '
    + '她截图里那个矛盾（页面还在画、后端已经不要求）正是 `false !== true` 的形状 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// ③ AC-RP3 🔴 那三处**删掉**了（塞回即红）＋ ⭐ 正向：有第二个货品时列表仍在
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP3a 🔴 补货块里**不许**再有那句说明（她逐字：不需要的文字说明给删除）', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  assert.equal(block.includes(OLD_HINT), false, `🔴 那句说明必须删掉（塞回即红）：${OLD_HINT}`);
  assert.equal(block.includes(MULTI_ITEM_RENDER_TEXTS.hint), false,
    '⭐ 配置里那句也**一个字都不该出现**在补货块里 ✓');
});

test('AC-RP3b 🔴 补货块里**不许**再有「本单已加的货品」那个标题', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  assert.equal(block.includes(OLD_TITLE), false, `🔴 那个标题必须删掉（塞回即红）：${OLD_TITLE}`);
  assert.equal(block.includes('multi-item__title'), false, '连那个标题元素一起删 ✓');
});

test('AC-RP3c 🔴 补货块里**不许**再有「还没有加第二个货品。」那句空态', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  assert.equal(block.includes(OLD_EMPTY), false, `🔴 那句空态必须删掉（塞回即红）：${OLD_EMPTY}`);
  // ⭐ 空态是**整块不渲染**（不是"渲染出来但为空" ✗）—— 没有第二个货品时那个 <ul> 根本不在 ✓
  assert.equal(block.includes('data-view="multi-item-list"'), false,
    '⭐ 没有第二个货品 ⇒ 那个列表元素**整块不渲染**（不留空壳 ✓）');
});

test('AC-RP3d ⭐⭐ **有第二个货品时列表仍要出现**（她删的是"提示"，不是"列表" ✗）', async () => {
  const block = blockOf(await fetchRealm('replenish', {
    multi_items: [
      { number: 'HL92006|黑色|A', item_no: 'HL92006', color: '黑色', entries: [{ size: '41', quantity: 1 }, { size: '42', quantity: 2 }] },
    ],
  }), 'replenish');
  assert.match(block, /data-view="multi-item-list"/,
    '🔴 **有内容时必须出现列表** —— 去掉它 ⇒ 她加了第二个货品却看不见 ⇒ 红 ✓（防"删过头" ✗）');
  assert.match(block, /<li class="multi-item-row">HL92006\|黑色\|A/,
    '那一行必须是**已加的那个货品**（编号逐字 ✓）');
  assert.match(block, /2 行/, '行数照旧（`{count} 行` 模板 ✓）');
  // ⚠️ 那三句**仍然**不该回来（哪怕有内容 ✓）
  assert.equal(block.includes(OLD_HINT), false, '说明仍不许回来 ✓');
  assert.equal(block.includes(OLD_TITLE), false, '标题仍不许回来 ✓');
  assert.equal(block.includes(OLD_EMPTY), false, '空态仍不许回来 ✓');
});

test('AC-RP3e ⭐ 源码：那三句中文**只有一处家**（渲染层不许散写 ✗）；补货那一处**显式传** `\'replenish\'`', () => {
  // ⚠️ 配置一处定义：那三句中文只该在 **config** 里
  assert.equal(RENDERER_SRC.includes(OLD_HINT), false, '渲染层不许散写那句说明 ✗（走配置 ✓）');
  assert.equal(RENDERER_SRC.includes(OLD_EMPTY), false, '渲染层不许散写那句空态 ✗（走配置 ✓）');
  assert.equal(MULTI_ITEM_RENDER_TEXTS.hint, OLD_HINT, '配置里那句说明**仍在**（一处定义 ✓ 只是补货不渲染它 ✓）');
  assert.equal(MULTI_ITEM_RENDER_TEXTS.title, OLD_TITLE, '配置里那个标题**仍在** ✓');
  assert.equal(MULTI_ITEM_RENDER_TEXTS.empty, OLD_EMPTY, '配置里那句空态**仍在** ✓');
  // ⭐ 两处调用各自**显式传自己那一档**（缺省 `''` 仍 = 老形状 ✓ 探针 AC-RP6 靠它 ✓）
  const calls = RENDERER_SRC.match(/multiItemBlockHtml\(write, view[^)]*\)/g) || [];
  // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）**成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.deepEqual(calls, ["multiItemBlockHtml(write, view, 'replenish')", "…'return')"])`
  //   改后逐字：下面这一行（第三个 `mode` **逐字不变** ✓ 只多一个 `page` 实参 ✓）
  //   依据 = 她 2026-10-16 14:38 逐字「加一单改为这个领域的扫一扫」；**不是放宽** ✓
  assert.deepEqual(calls,
    ["multiItemBlockHtml(write, view, 'replenish', page)", "multiItemBlockHtml(write, view, 'return', page)"],
    '补货 / 退货各自显式传自己那一档 ✓ —— 谁把补货那一处改回"不传"（= 又画那三句）⇒ 红 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// ④ AC-RP4 🔴 最下面那颗蓝色按钮 = 「补货」（旧名塞回即红）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP4 🔴 最下面那颗蓝色按钮的文字 = 「补货」（改前逐字 `生成报货订单` ⇒ 塞回即红）', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  assert.equal(submitButtonTextOf(block), NEW_BUTTON,
    `改前逐字「${OLD_BUTTON}」⇒ 改后逐字「${NEW_BUTTON}」（依据 = 她 2026-10-16 真机截图 + 逐字）`);
  assert.equal(block.includes(OLD_BUTTON), false, `🔴 旧按钮名塞回即红：${OLD_BUTTON}`);
  // ⭐ 配置先行：那颗按钮的文字**只来自这一处**（她下次改字只改配置 ✓ 不散写成中文字面量 ✗）
  assert.equal(SCAN_PAGE.replenishForm.submitLabel, NEW_BUTTON, '配置里那一句 = 「补货」✓');
  assert.equal(block.includes(SCAN_PAGE.replenishForm.submitLabel), true,
    '⚠️ 那颗按钮的文字必须来自 `SCAN_PAGE.replenishForm.submitLabel`（配置先行 ✓）');
  assert.equal(RENDERER_SRC.includes('>${escapeHtml(rp.submitLabel)}</button>'), true,
    '⭐ 渲染层读的是 `rp.submitLabel`（配置 ✓）不是中文字面量 ✗');
  // 🔴 红线：写侧那句 `replenishButton` **一个字不动** ✗（`config/scanWrite.js` 不在本刀写作用域内）
  assert.match(SCAN_WRITE_SRC, /replenishButton: '生成报货订单',/,
    '🔴 写侧 `config/scanWrite.js` 的 `replenishButton` 不许动（它不在本任务写作用域内 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ AC-RP5 ⭐ 范围哨兵：退货 / 销售**逐字未动**；验收如实标注
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP5a 🔴 退货那一块**逐字未动**（含它仍要「整单金额」✓ —— 她这次没点它 ✗）', async () => {
  const block = blockOf(await fetchRealm('purchase_return'), 'purchase_return');
  // ① 金额那一块**仍在**（她 2026-10-14 晚定的「退货整单金额（必填）」✓ 本刀一个字没动 ✗）
  assert.equal(block.includes(OLD_AMOUNT_LABEL), true, '退货块里「整单金额（必填）」**必须还在** ✓');
  assert.equal(block.includes(`name="${SCAN_WRITE.fields.purchaseAmount}"`), true,
    '退货块里那个输入**必须还在** ✓（本刀只关补货那一处 ✗）');
  // ② 那颗按钮仍是「退货」（她 2026-10-16 早前那次定的 ✓）
  assert.equal(submitButtonTextOf(block), RETURN_BUTTON, '退货那颗按钮 = 「退货」（逐字未动 ✓）');
  assert.equal(block.includes('生成采购退货'), false, '旧名仍不许回来 ✓');
  // ③ 退货那三处**仍不渲染**（她早前那次的选择 ✓ 本刀**没有**把它改回去 ✗）
  assert.equal(block.includes(OLD_HINT), false, '退货：说明仍不在 ✓');
  assert.equal(block.includes(OLD_TITLE), false, '退货：标题仍不在 ✓');
  assert.equal(block.includes(OLD_EMPTY), false, '退货：空态仍不在 ✓');
  assert.equal(block.includes('data-view="multi-item-list"'), false, '退货：空的时候列表仍不渲染 ✓');
  // ④ ⭐ 源码：退货那一处**无条件**调那个片段（谁给它也加上开关 ⇒ 红 ✓）
  assert.equal(RENDERER_SRC.includes('${purchaseAmountRowHtml(write)}'), true,
    '⭐ 退货那一处必须仍是**无条件**的那一行（`${purchaseAmountRowHtml(write)}` ✓ 逐字未动 ✗）');
});

test('AC-RP5b 🔴 销售那一块**逐字未动**（她这次只点补货 ✗）', async () => {
  const block = blockOf(await fetchRealm('sales'), 'sales');
  // 销售那一块的稳定标记（那把尺码 chip 的分组 ＋ 两颗提交键 ✓ —— 逐字取自真实渲染 ✓）
  assert.match(block, /data-stock-group="in_stock"/, '销售：现货那一组照旧在 ✓');
  assert.match(block, /data-stock-group="prepaid"/, '销售：预订那一组照旧在 ✓');
  assert.match(block, /<button type="submit" class="btn btn--primary" name="action" value="submit_order"/,
    '销售：提交那一颗照旧（`submit_order` ✓ 逐字未动 ✗）');
  assert.equal(block.includes('整单金额'), false, '销售：本来就没有整单金额（本刀也没给它加 ✗）');
  assert.equal(block.includes(OLD_BUTTON), false, '销售：不许出现补货那颗按钮的旧名 ✓');
  assert.equal(block.includes(OLD_HINT), false, '销售：不许出现补货块那句说明 ✓');
  // ⭐ 销售那一块**不经**多货品那一块（补货/退货才有）——
  //   谁把 `multiItemBlockHtml` 顺手接到销售上 ⇒ 红 ✓
  assert.equal(block.includes('data-view="multi-item"'), false, '销售块里没有多货品那一块 ✓（本刀没接 ✗）');
});

test('AC-RP5c ⭐ **验收如实标注**：`accept` 已从 `REALMS` 退场 ⇒ 没有"那一块"可比对（不假装比对 ✓）', async () => {
  const realm = require('../src/views/scanPageRealm');
  // ⚠️ 依据（逐字，仓库已落档）：业务负责人「**`/s/accept` 这条路要彻底拆掉**」⇒ `accept` 不在 `REALMS` 里。
  assert.equal(realm.REALMS.some((item) => item.id === 'accept'), false,
    '`accept` **不在** `REALMS` 里（已退场 ✓）—— 所以 AC-RP5 的"验收那一块"**不存在**，本文件不假装比对它 ✓'
    + '（若哪天它回来了 ⇒ 这一条红 ⇒ 提醒补上真正的块比对 ✓）');
  assert.equal(realm.resolveRealm('accept'), realm.DEFAULT_REALM,
    '旧 `?from=accept` 仍按**缺省领域**（销售）渲染 ✓ 逐字未动 ✗');
  // ⭐ 可核对的那一半：旧 `?from=accept` 渲染出来的**就是销售那一块**（逐字相同 ✓ 能真红 ✓）
  const viaAccept = blockOf(await fetchRealm('accept'), 'sales');
  const viaSales = blockOf(await fetchRealm('sales'), 'sales');
  assert.equal(viaAccept.includes('realm-block--accept'), false, '页面上**没有**验收那一块 ✓（已退场 ✓）');
  assert.equal(viaAccept, viaSales,
    '⭐ `?from=accept` ⇒ 与 `?from=sales` **逐字相同的那一块**（退场后的既有行为 ✓ 本刀没碰它 ✗）');
  // ⭐ 验收**仍在**的那处判据：校验档位（AC-RP2a 已逐字判 ✓）—— 这里再核一次它的显式布尔形状 ✓
  assert.equal(SCAN_WRITE.purchaseAmount.requiredByRealm.accept, true, '验收仍要金额 ✓（一个字没动 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ AC-RP7 ⭐⭐ 补货尺码清单**真的**渲染成一行 3 列（CSS 级联哨兵 ⇒ 塞回旧类即红）
// ═══════════════════════════════════════════════════════════════════════════

/** 取补货那个尺码清单 `<ul>` 上的**真实类列表**（`data-view="purchase-sizes"` 是稳定锚 ✓）。 */
const stockListClassesOf = (block) => {
  const tag = block.match(/<ul class="([^"]*)" data-view="purchase-sizes"/);
  return tag ? tag[1].split(/\s+/).filter(Boolean) : null;
};

/**
 * ⭐ 极简 CSS 级联：在 `STYLE` 里**按源码顺序**找出所有「单类选择器 = 该元素某个类」的
 * `grid-template-columns` 声明 ⇒ **最后一条赢**（它们特异性相同 —— 这正是这次 bug 的机制本身 ✓）。
 * ⚠️ 它**只认单类选择器**（`.x { … }`）：本刀涉及的两条恰好都是单类 ✓；不假装是个完整 CSS 引擎 ✗。
 */
const resolvedColumnsOf = (style, classes) => {
  let winner = null;
  // ⚠️ 要求那个类名是**一条选择器的第一个东西**（`^` / 换行 / `}` / `,` 之后紧跟 `.类名 {`）——
  //   否则 `.a.b { … }` 这种复合选择器会被误当成"单类 `.b`"（本仓现在没有，但不靠"现在没有" ✗）。
  for (const rule of style.matchAll(/(?:^|[\n},])\s*\.([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g)) {
    if (!classes.includes(rule[1])) continue;
    const decl = (rule[2].match(/grid-template-columns\s*:\s*([^;]+)/) || [])[1];
    if (decl) winner = { cls: rule[1], decl: decl.trim() };
  }
  return winner;
};

test('AC-RP7 ⭐⭐ 补货的尺码清单**实际生效的列数 = 3**（她逐字：不用一行一个，改为一行 3 组）', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  const classes = stockListClassesOf(block);
  assert.ok(classes, '补货那一块里要有 `data-view="purchase-sizes"` 那个清单 ✓');
  // 🔎 根因哨兵：**那条会把列数压成 1 的旧类不许在**（塞回即红 ✓ 这一条就是抓这次静默失效的 ✓）
  assert.equal(classes.includes('purchase-sizes'), false,
    '🔴 那个 `<ul>` 上**不许再挂旧类 `purchase-sizes`**（它的规则是 `minmax(0, 1fr)` = 1 列，'
    + '且**在 `.purchase-size-grid` 之后** ⇒ 同特异性下它赢 ⇒ 一行一个 ✗ 这正是线上那条静默失效 ✓）');
  // ⭐ 用**真实的级联结果**判：不是"有没有那个类"，而是"最后赢的那条规则说的几列" ✓
  const winner = resolvedColumnsOf(renderer.STYLE, classes);
  assert.ok(winner, '该元素至少要被一条单类规则写上 `grid-template-columns` ✓');
  assert.equal(winner.cls, 'purchase-size-grid',
    `⭐ 生效的那条规则必须是 \`.purchase-size-grid\`（实际生效的是 \`.${winner.cls}\` ✗ ⇒ 红 ✓）`);
  assert.equal(winner.decl, 'repeat(var(--size-cols, 3), minmax(0, 1fr))',
    '⭐ 生效的列数 = `repeat(var(--size-cols, 3), …)` ⇒ **一行 3 组**（她逐字「一行 3 组尺码 × 数量」✓）');
  assert.equal(/auto-fit|auto-fill/.test(winner.decl), false,
    '🔴 不许用 auto-fit / auto-fill（那会随宽度变 2/4 列 ✗ —— 她 2026-10-14 定的"保持一行 3 个"✓）');
  // ⭐ 列数来自**配置**（改一个值不用改代码 ✓）
  assert.equal(SCAN_PAGE.purchaseSizes.columnsPerRow, 3, '列数配置 = 3 ✓（配置先行 ✓）');
  assert.match(block, /--size-cols:\s*3/, '渲染出来的 CSS 变量来自那份配置（`--size-cols: 3`）✓');
  // ⭐⭐ **结构断言（Lead ④ 的硬要求：不许只查配置 ⇒ 要看"真实渲染出来的那一行到底几组"）**：
  //   ① 清单里**真的有 ≥3 组**（否则"一行 3 组"无从谈起 ⇒ 空清单也会假绿 ✗）；
  //   ② 生效的列数 = 3 ⇒ 于是**第 1~3 组落在同一行**（`grid` 的**行优先**填充是 CSS 规范行为 ✓）；
  //   ③ 组数不是 3 的整数倍 ⇒ 最后一行**不满**（本例 10 组 = 3+3+3+1 ✓ 正是"一行 3 组、多了换行"）。
  const cells = [...block.matchAll(/<li class="purchase-size-cell(?: [^"]*)?" data-purchase-size="([^"]+)"/g)]
    .map((m) => m[1]);
  assert.equal(cells.length, 10, `补货清单要有 10 组（她的 36–45 十个码），实得 ${cells.length} ✗`);
  const perRow = Number((winner.decl.match(/repeat\(var\(--size-cols,\s*(\d+)\)/) || [])[1]);
  assert.equal(perRow, 3, '⭐ 生效的**每行组数 = 3**（从那条生效规则的声明里解出来 ✓ 不是照抄配置 ✗）');
  assert.deepEqual(cells, ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'],
    '组**按尺码升序**排 ⇒ 同一行的前 3 组 = 36 / 37 / 38（她截图里那种"一行 3 组尺码 × 数量"✓）');
  assert.notEqual(cells.length % perRow, 0,
    '⭐ 组数**不是**每行组数的整数倍 ⇒ 最后一行不满（"多了就换行" ✓ 正是 grid 的行优先行为 ✓）');
  // ⭐ 折叠块（特殊码）那一份**同一条口径**（两处都是 3 列 ✓ 别只修一处 ✗）
  const foldedClasses = (block.match(/<ul class="([^"]*)" data-view="purchase-sizes-folded"/) || [])[1];
  if (foldedClasses) {
    const foldedWinner = resolvedColumnsOf(renderer.STYLE, foldedClasses.split(/\s+/).filter(Boolean));
    assert.equal(foldedWinner.cls, 'purchase-size-grid', '折叠块那一份也要走 3 列那条规则 ✓');
    assert.equal(foldedWinner.decl, winner.decl, '折叠块与主清单**同一条列数口径**（一处配置 ✓）');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑧ AC-RP8 ⭐⭐ 功能零变化：POST 载荷的**字段名与顺序逐字相同**（fixture 比对）
// ═══════════════════════════════════════════════════════════════════════════

/** 表单控件在 DOM 里的**出现顺序**（`name="…"` 逐个抽 ✓ 重复的也保留 ⇒ 顺序真被钉住 ✓）。
 *  ⚠️ 用**后行断言**排除 `data-qty-name="…"`（它是勾选框上的辅助属性，不是提交字段 ✗）——
 *    否则 `qty_<码>` 会被数两遍。
 *  ⭐ 2026-10-16 下半场（`SCAN_MULTI_ITEM_ADD_WIRE` 缺省 `true`）**成对迁移**（**改指向、不放宽** ✓）：
 *    多货品那两颗 **submit 按钮**（`＋ 再加一个货品` / 每行一颗"移除"）也是 `name="…"`，
 *    但它们**不是这张表单"提交"时的字段** —— 点最下面那颗「补货」时浏览器**根本不送**它们
 *    （按钮的 name/value 只有**它自己被点**才送 ✓）。⇒ 从"控件名清单"里**排掉那两个 submitter 的名字**
 *    （名字**只从配置取** ✓ 不写死 ✗），留下的仍是她真正提交的那些字段、**顺序逐字不变** ✓
 *    （改名前 / 调序 / 漏一个尺码 ⇒ 照旧红 ✓）。 */
const controlNamesOf = (block) => {
  const submitters = new Set([
    MULTI_ITEM_ORDER.wire.addAction, MULTI_ITEM_ORDER.wire.removeField,
  ].filter(Boolean));
  return [...block.matchAll(/(?<![\w-])name="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((name) => !submitters.has(name));
};

test('AC-RP8 ⭐⭐ 功能零变化：补货表单的**字段名与顺序**逐字未动（改版式不许碰提交 ✓）', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  const names = controlNamesOf(block);
  // 改前逐字（本刀之前、且**本刀之后仍是**这一串 —— 依据 = 她只要求"一行 3 组"的**版式**，
  // 明确"功能零变化"✗）：
  //   `action` → `page_build` → `submit_key` → `sizes`(×10 个尺码，各自紧跟自己的 `qty_<码>`)
  //   → `multi_items`
  // ⚠️ 这一条**能真红**：谁把字段改名 / 调序 / 漏一个尺码 ⇒ 立刻红 ✓
  const expected = [
    'action', 'page_build', 'submit_key',
    ...['36', '37', '38', '39', '40', '41', '42', '43', '44', '45']
      .flatMap((size) => ['sizes', `qty_${size}`]),
    'multi_items',
  ];
  assert.deepEqual(names, expected,
    '🔴 补货表单的控件**名字与出现顺序**必须与改版式之前**逐字相同**（她："功能零变化" ✗）');
  // ⭐ 每一个尺码都还是"勾选框 + 自己的数量框"两件套（顺序：勾选框在前、数量在后 ✓）
  for (const size of ['36', '45']) {
    assert.match(block, new RegExp(`name="sizes" value="${size}"[^>]*>[^<]*</label>\\s*<input class="size-qty" name="qty_${size}"`),
      `${size} 码仍是「勾选框 → 自己的数量框」（逐字未动 ✓）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ AC-RP9 ⭐⭐ 组内元素逐字仍在（尺码字 + 数量 + 现货/缺码标记）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP9 ⭐⭐ 每一组仍是「尺码 ＋ ×数量 ＋ 现货/缺码」三件（删掉标记 ⇒ 红 ✓）', async () => {
  const block = blockOf(await fetchRealm('replenish'), 'replenish');
  // 她的真实形状：40 码有 2 双（现货）· 41 码缺码 —— 两组各自逐字
  assert.match(block, /<li class="purchase-size-cell" data-purchase-size="40">\s*<span class="purchase-size__size">40 码<\/span>\s*<span class="purchase-size__amount">[\s\S]*?<\/span>\s*<span class="tag tag--success">现货<\/span>/,
    '40 码那一组逐字：尺码字 + 数量 + 「现货」标记 ✓（少一件 ⇒ 红 ✓）');
  assert.match(block, /data-purchase-size="41"[\s\S]*?41 码[\s\S]*?<span class="tag tag--warning">缺码<\/span>/,
    '41 码那一组逐字：尺码字 + 「缺码」标记 ✓');
  assert.match(block, /<span class="purchase-size__times">\u00d7<\/span>/, '数量前面那个「×」照旧 ✓');
  assert.match(block, /2 双/, '数量照旧按配置模板渲染（`{count} 双` ✓）');
  // ⭐ 每格 ≥44px（她 2026-10-15 的老规矩 ✓ 本刀没碰 ✓）
  assert.match(RENDERER_SRC, /\.purchase-size-cell \{[^}]*min-height: var\(--control-height\)/,
    '每格仍是 ≥44px 命中区（`--control-height` ✓ 逐字未动 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑩ AC-RP10 ⭐ 范围哨兵：销售 / 退货 / 库存三个领域的清单**逐字未动**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP10 ⭐ 这一刀**只动补货**：销售 / 退货 / 库存的清单既没有 3 列网格、也没有被动过', async () => {
  for (const realm of ['sales', 'purchase_return', 'inventory']) {
    const block = blockOf(await fetchRealm(realm), realm);
    assert.equal(block.includes('purchase-size-grid'), false,
      `🔴 ${realm}：不许出现补货那套 3 列网格类（谁顺手接过去 ⇒ 红 ✓）`);
    assert.equal(block.includes('--size-cols'), false, `${realm}：不许出现那个列数变量 ✓`);
    assert.equal(block.includes('purchase-size-cell'), false, `${realm}：不许出现补货的格子元素 ✓`);
  }
  // 各领域自己的清单**仍在**（不是"被我删空了" ✗）
  assert.match(blockOf(await fetchRealm('sales'), 'sales'), /data-stock-group="in_stock"/, '销售：现货组仍在 ✓');
  assert.match(blockOf(await fetchRealm('purchase_return'), 'purchase_return'), /data-return-sizes-field/, '退货：尺码字段仍在 ✓');
  assert.match(blockOf(await fetchRealm('inventory'), 'inventory'), /<table class="stock"/, '库存：那张表仍在 ✓');
  // ⭐ 源码哨兵：`purchase-size-grid` **只在补货那两处**出现（谁复制到别处 ⇒ 红 ✓）
  const gridUses = RENDERER_SRC.match(/class="purchase-size-grid[^"]*"/g) || [];
  assert.equal(gridUses.length, 2, `3 列网格类只该在补货那两处（清单 + 折叠块），实际 ${gridUses.length} 处 ✗`);
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑪ AC-RP11 ⭐ 探针：上面几条检测器**真能红** ✓（不空跑）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RP11 ⭐ 探针：三处"塞回"与"删过头"都**必须**被检出（证明上面几条不空跑）', () => {
  const offenders = {
    amountRow: (html) => html.includes(OLD_AMOUNT_LABEL) || html.includes(`name="${AMOUNT_FIELD}"`),
    hint: (html) => html.includes(OLD_HINT),
    title: (html) => html.includes(OLD_TITLE),
    empty: (html) => html.includes(OLD_EMPTY),
    listMissing: (html) => !/data-view="multi-item-list"/.test(html),
    oldButton: (html) => html.includes(OLD_BUTTON),
  };
  // ① 干净的精简档（补货 / 退货同形状）⇒ 五个检测器都**不误报**
  const clean = renderer.multiItemBlockHtml({ postAction: '/s/K1', texts: {} }, { number: 'K1' }, 'replenish');
  assert.equal(offenders.hint(clean), false, '干净的补货块 ⇒ 说明不误报 ✓');
  assert.equal(offenders.title(clean), false, '干净的补货块 ⇒ 标题不误报 ✓');
  assert.equal(offenders.empty(clean), false, '干净的补货块 ⇒ 空态不误报 ✓');
  assert.equal(offenders.listMissing(clean), true, '⚠️ 空的时候列表本就该不在（这条只对"有内容"那一次有意义 ✓）');
  assert.equal(offenders.oldButton(`<button>${OLD_BUTTON}</button>`), true, '旧按钮名 ⇒ **必须**报红 ✓');
  assert.equal(offenders.amountRow(`<label>${OLD_AMOUNT_LABEL}</label><input name="${AMOUNT_FIELD}">`), true,
    '塞回那个框（标签 / 字段名任一）⇒ **必须**报红 ✓');
  // ② 缺省那一档（`mode=''`）= **老形状** ⇒ 三个检测器同时报红 ✓
  //    （这正是"旧文案塞回"的等价样本 —— 也证明缺省档**没有被顺手精简掉** ✓）
  const oldShape = renderer.multiItemBlockHtml({ postAction: '/s/K1', texts: {} }, { number: 'K1' });
  assert.equal(offenders.hint(oldShape), true, '塞回说明 ⇒ **必须**报红 ✓');
  assert.equal(offenders.title(oldShape), true, '塞回标题 ⇒ **必须**报红 ✓');
  assert.equal(offenders.empty(oldShape), true, '塞回空态 ⇒ **必须**报红 ✓');
  // ③ "删过头"（连列表一起删）⇒ listMissing 报红 ✓
  assert.equal(offenders.listMissing(
    renderer.multiItemBlockHtml({ postAction: '/s/K1', texts: {} },
      { number: 'K1', multi_items: [{ number: 'HL1', entries: [{ size: '41', quantity: 1 }] }] }, 'replenish')), false,
  '⭐ 有内容 ⇒ 列表必须在 ⇒ "删过头"会被这条抓住 ✓');
  // ④ 按钮文案检测器本身也要能红（配置那一层 ✓）
  assert.notEqual(SCAN_PAGE.replenishForm.submitLabel, OLD_BUTTON,
    '配置里若又变回旧名 ⇒ AC-RP4 的那两条**当场红** ✓（本行是它的探针 ✓）');
});
