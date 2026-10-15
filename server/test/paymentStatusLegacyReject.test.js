'use strict';

/**
 * ⭐⭐ 2026-10-16（**A3：拒绝"带着旧档位"提交**）—— 她逐字：
 *   「那你**直接加个校验，别让他带着这三个单选提交**不就行了吗？**开关也不需要啊**」
 * ⇒ 最终行为：请求里**仍带着**旧档位（`payment_status` ＝ 全付 / 部分付 / 未付 之一）⇒
 *    **400 ＋ 一句人话 ＋ 零写入** ✓（判据草案见 `docs/payment-status-legacy-submit-migration-2026-10-16.md`）
 *
 * ⚠️ **本文件分两段**（照 AC-SP1 `successPageAcceptance.test.js` 的分阶段手法 ✓ **如实标注，不假装已覆盖** ✗）：
 *   · **第一段（今天就是真判据 ✓）**：**反向哨兵** —— 这条新校验**绝不能**误伤
 *     ① 幂等连点（同一把 `submit_key` 再点一次）② 重复提交 ③ 刷新 ④ 资金页那条正经动作 ✗
 *     （她最怕的就是"卡住 / 提交不了"：新校验**只许拦"带着旧档位"的请求** ✓ 别的一律不许拦 ✗）
 *   · **第二段（分阶段闸门 ✓）**：**源码里一旦出现"拒绝旧档位"的实现标志**（下面 `MARKERS`）⇒
 *     自动要求"带旧档位 ⇒ 400 ＋ 人话 ＋ 零写入" ✓
 *     ⇒ 今天**还没有那个实现** ⇒ 这一段**如实打 `[待激活]`** ⚠️（**不假装通过** ✗）——
 *       但**探针照样真跑**：构造一个"带旧档位"的请求，**要么当场被拒、要么当场证明闸门未启用** ✓（**不许空跑** ✗）
 *   🔴 **自检（AC-PR4）**：把"检测器"喂给**合成数据** ⇒ 必须**真能报红、也能放行** ✓
 *      （证明第二段不是摆设 —— 把探针改成"永真" ⇒ 本文件自己就会红 ✓）
 *
 * 🔴 只动 `server/test/**` ✓（`routes/scanPage.js` / `views/**` / `config/**` / `scanWriteService.js`
 *    一个字节没碰 ✓）· 未部署 ✓ · 生产 Base 只读 ✓
 * 🔴 本文件**不许**出现被 `scanSaleTwoLayerMoney.test.js:300/:1275` 钉住的那**两个词**
 *    （#659 就栽在它们上面 ✗）—— 本文件一个字都没出现 ✓（可用 `grep` 复核 ✓）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_pslr';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'pslr_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'pslr_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

/** 老三档的**取值真源**（配置先行 ✓ 本文件一个中文字面量都不另抄 ✗）。 */
const LEGACY_VALUES = [PAYMENT_STATUS.full, PAYMENT_STATUS.partial, PAYMENT_STATUS.unpaid];

/**
 * ⭐ **A3 的实现标志** —— 落地那一刀**请用其中之一**（本文件就是它的契约 ✓）：
 *   · `payment_status_rejected`（推荐：拒绝时的 reason / code / 日志事件名）
 *   · `paymentStatusRejectedBody`（或把它放进 `config/scanWrite.js` 的 `texts` —— 人话那一句）
 *   · `legacy_payment_status`（日志字段名）
 * ⚠️ 只认这三者之一：**别的写法 ⇒ 本闸门不会自动激活**（那就等于这一刀没被钉住 ✗）。
 */
const MARKERS = [/payment_status_rejected/, /paymentStatusRejectedBody/, /legacy_payment_status/];

/** 会承载"拒绝旧档位"的两个文件（路由 ＋ 文案配置 ✓ 都是 A3 的落点）。 */
const CARRIER_FILES = ['src/routes/scanPage.js', 'src/config/scanWrite.js'];
const readCarrier = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const CARRIERS = CARRIER_FILES.map((file) => ({ file, source: readCarrier(file) }));

/** 闸门是否已激活：任一载体里出现任一标志 ⇒ **已实现** ✓ */
const rejectGateOf = (carriers) => carriers.find(
  ({ source }) => MARKERS.some((marker) => marker.test(source)),
);

/**
 * ⭐ **判定器**（纯函数 ⇒ 可以被 AC-PR4 拿合成数据**真测** ✓）：
 * "按她口径**拒绝掉了**" = ① 400 ＋ ② 有话说（不是干巴巴一片空白 ✗）＋ ③ 零写入。
 */
const rejectionOf = ({ status, html, writes }) => {
  const words = String(html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return {
    rejected: status === 400,
    hasWords: words.length > 0,
    noWrite: writes === 0,
    ok: status === 400 && words.length > 0 && writes === 0,
  };
};

const COOKIE = (() => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    open_id: 'ou_pslr', name: '自检', exp: Date.now() + 36e5,
  })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET).update(payload).digest('base64url')}`;
})();

const NUMBER = 'PS505|黑|A';
const ENCODED = encodeURIComponent(NUMBER);
const view = () => ({
  found: true, number: NUMBER, item_no: 'PS505', color: '黑', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});

/** 记录写库调用的假 writeService（只记不改 ✓）—— 会话停在"资金页待确认"那一步 ✓ */
const makeHarness = () => {
  const writes = [];
  const session = {
    session_id: 'sess_pslr', flow: 'sale', lines: [],
    sale: { key: 'scan_sale:sess_pslr:1', paymentStep: 'pending', lines: [], submitPending: { size: '40', lineAmounts: ['399'] } },
  };
  const writeService = {
    sessions: {
      get: async () => session,
      ensure: async () => session,
      submitKeyFor: () => 'scan_sale:sess_pslr:1',
      addLine: async () => ({ ok: true }),
      saveSaleProgress: async () => ({ ok: true }),
      revive: async () => session,
    },
    listAccessories: async () => [],
    addSaleLine: async () => ({ ok: true }),
    clearDraft: async () => ({ ok: true }),
    saveDraftLines: async () => ({ ok: true }),
    submitSale: async (input) => {
      writes.push({ kind: 'submitSale', submitKey: input?.submitKey, paymentStatus: input?.paymentStatus });
      return { ok: true, order_no: 'XSD-PSLR-1', sales_entry_record_id: 'rec_pslr_1', payment_count: 1 };
    },
  };
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() }, gateway: {}, config: SCAN_PAGE,
    writeService, purchaseSizeReader: { listSizes: async () => [] },
    followup: { addPayment: async () => ({ ok: true }) },
  }));
  return { app, writes };
};

const withServer = async (run) => {
  const { app, writes } = makeHarness();
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run({ base, writes }); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const post = async (base, body) => {
  const response = await fetch(`${base}${SCAN_PAGE.route.basePath}/${ENCODED}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return { status: response.status, html: await response.text() };
};

const getPage = async (base) => {
  const response = await fetch(`${base}${SCAN_PAGE.route.basePath}/${ENCODED}`, { redirect: 'manual', headers: { cookie: COOKIE } });
  return { status: response.status, html: await response.text() };
};

const fields = SCAN_WRITE.fields;
const submitBody = (extra = {}) => ({
  action: SCAN_WRITE.actions.submitOrder, submit_key: 'scan_sale:sess_pslr:1',
  [fields.size]: '40', [fields.amount]: '399', [fields.lineAmount]: '399', ...extra,
});
const payBody = (extra = {}) => ({
  action: 'payment_pay', submit_key: 'scan_sale:sess_pslr:1',
  [fields.paymentMethod]: '微信', [fields.paymentAmount]: '399', [fields.lineAmount]: '399', ...extra,
});

// ═══════════════════════════════════════════════════════════════════════════
// 第一段：**今天就是真判据** —— 反向哨兵（新校验只许拦"带旧档位"，别的一律不许拦 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PR1 ⭐ 反向哨兵·连点/重复提交：同一把 `submit_key` **再点一次** ⇒ 不许被拦成 400 ✗', async () => {
  await withServer(async ({ base, writes }) => {
    const first = await post(base, submitBody());
    const second = await post(base, submitBody());
    assert.notEqual(first.status, 400, `第一次点**不许**被拦（实际 ${first.status}）：${String(first.html).slice(0, 160)}`);
    assert.notEqual(second.status, 400, `再点一次**同样不许**被拦（实际 ${second.status}）— 她最怕"卡住/点不动" ✗`);
    assert.equal(writes.length, 0, '点「提交这一单」这一步**一个字都不写** ✓');
  });
});

test('AC-PR1b ⭐ 反向哨兵·**资金页那颗按钮**连点（分阶段：等"按金额自动定档"落地 ✓）', async () => {
  // ⚠️ 如实：今天资金页那颗按钮**还要求请求里带着档位**（旧形状 ✗）⇒ 不带档位它会被
  //   `resolveSettlement` 判 `unknown_mode` 挡住 ⇒ 这条判据要等 A2a 落地后才成立 ✓
  const autoModeLanded = /autoModeOf/.test(readCarrier('src/routes/scanPage.js'));
  await withServer(async ({ base, writes }) => {
    const first = await post(base, payBody());
    const second = await post(base, payBody());
    if (!autoModeLanded) {
      console.log(`[AC-PR1b] 待 A2a：资金页那条连点判据要等"按金额自动定档"落地后成立 —— `
        + `本次实测 status=${first.status} · 写入次数=${writes.length}`);
      assert.equal(writes.length, 0, '今天这条路**一个字都不许写** ✓（如实记录：它此刻被挡在别的原因上 ✗）');
      return;
    }
    assert.notEqual(first.status, 400, `A2a 落地后：第一次点资金页按钮**不许**被拦（实际 ${first.status}）`);
    assert.notEqual(second.status, 400, `A2a 落地后：连点第二次**同样不许**被拦（实际 ${second.status}）`);
    const keys = writes.map((item) => item.submitKey);
    assert.ok(keys.length >= 1, '至少真的走到建单那一步 ✓（否则这条判据是空跑 ✗）');
    assert.equal(new Set(keys).size, 1, `两次必须用**同一把** submit_key（幂等不许拆 ✗ 实际 ${JSON.stringify(keys)}）`);
  });
});

test('AC-PR2 ⭐ 反向哨兵·刷新 / 重复提交：刷新**仍是那一页**、零写入 ⇒ 不许被新校验拦 ✗', async () => {
  await withServer(async ({ base, writes }) => {
    const fresh = await getPage(base);
    assert.equal(fresh.status, 200, `刷新页面必须是 200（实际 ${fresh.status}）`);
    assert.equal(writes.length, 0, '刷新**一个字都不许写** ✓');
    // 不带旧档位的正经提交 ⇒ 也不许被拦（新校验**只针对"带着旧档位"** ✗）
    const normal = await post(base, submitBody());
    assert.notEqual(normal.status, 400, `不带旧档位的提交**不许**被拦（实际 ${normal.status}）— 拦错了就是把她卡住 ✗`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 第二段：**分阶段闸门** —— 源码里出现实现标志之后，这一半自动变成真判据 ✓
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PR3 🔴 分阶段闸门：带旧档位提交 ⇒ 【已实现则】必须 400 ＋ 人话 ＋ 零写入；【未实现则】如实待激活', async () => {
  const gate = rejectGateOf(CARRIERS);
  for (const legacy of LEGACY_VALUES) {
    await withServer(async ({ base, writes }) => {
      const money = await post(base, submitBody({ [fields.paymentStatus]: legacy }));
      const verdict = rejectionOf({ status: money.status, html: money.html, writes: writes.length });
      if (!gate) {
        // ⚠️ **如实**：这一半今天还没条件成立 ⇒ **不假装通过** ✗
        //   但探针**真跑**：当场证明"闸门还没启用"（请求没被这条还不存在的校验拦掉）✓
        console.log(`[AC-PR3] 待激活：源码里还没有拒绝旧档位的实现标志（${MARKERS.map(String).join(' / ')}）`
          + ` —— 本次探针实测：带「${legacy}」提交 ⇒ status=${money.status} · 写入次数=${writes.length}`);
        assert.notEqual(money.status, 400,
          `[待激活] 既然还没实现，带旧档位的请求**不该**已经被拦（实际 400 ⇒ 说明别的东西在拦，需排查 ✗）`);
        assert.equal(writes.length, 0, '[待激活] 点「提交这一单」这一步**一个字都不写** ✓');
        return;
      }
      // 一落地 ⇒ 从这里开始就是**真判据** ✓
      assert.equal(verdict.rejected, true, `🔴 带旧档位「${legacy}」必须**拒绝**（400）—— 实际 ${money.status}`);
      assert.equal(verdict.hasWords, true, '🔴 拒绝时必须给她**一句人话**（不许只剩干巴巴的 400 ✗）');
      assert.equal(verdict.noWrite, true, `🔴 拒绝时**一个字都不许写**（实际写了 ${writes.length} 次 ✗）`);
    });
  }
});

test('AC-PR4 ⭐ 探针自检：检测器**真能报红、也能放行**（把探针改成永真 ⇒ 本文件自己就会红 ✓）', () => {
  // ① 判定器：合格 / 不合格，各判对一次
  assert.equal(rejectionOf({ status: 400, html: '<p>请刷新这一页再操作。</p>', writes: 0 }).ok, true,
    '合格样本必须判"拒绝成功" ✓');
  assert.equal(rejectionOf({ status: 400, html: '', writes: 0 }).ok, false,
    '干巴巴的 400（没有人话）⇒ **必须**判不合格 ✓');
  assert.equal(rejectionOf({ status: 400, html: '<p>人话</p>', writes: 1 }).ok, false,
    '拒绝了却写了库 ⇒ **必须**判不合格 ✓');
  assert.equal(rejectionOf({ status: 200, html: '<p>成功</p>', writes: 0 }).ok, false,
    '没拒绝（200）⇒ **必须**判不合格 ✓');
  // ② 标志检测器：**合成源码**里塞/不塞标志，各判对一次（证明闸门**真会**开）
  const synthetic = (extra) => [{ file: 'x.js', source: `// ${extra}` }];
  assert.equal(rejectGateOf(synthetic('没有任何拒绝实现')), undefined, '没有标志 ⇒ 闸门**不许**激活 ✓');
  for (const marker of MARKERS) {
    assert.ok(rejectGateOf(synthetic(`reason: '${marker.source.replace(/[\\/]/g, '')}'`)),
      `合成源码里塞 ${marker} ⇒ 闸门**必须**激活 ✓（否则 AC-PR3 永远是待激活 ⇒ 等于没钉住 ✗）`);
  }
  // ③ 今天这两个载体确实**都还没有**标志（如实：这一刀还没落地 ✓）
  assert.equal(rejectGateOf(CARRIERS), undefined,
    '今天源码里**不该**已有拒绝标志（若已有 ⇒ 请把 AC-PR3 的待激活分支删掉 ✓ 并跑真判据 ✓）');
});
