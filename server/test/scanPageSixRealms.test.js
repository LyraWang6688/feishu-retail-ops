/** ⚠️ 2026-10-12 旧断言改写（"**零 JS**"口径按业务负责人的要求改了）：
 *  改前（逐字）：`assert.equal(/<script[\s>]/i.test(html), false, '页面里一行前端脚本都没有');`
 *  改后（逐字）：**有提交按钮的页面**（销售提交 / 打印这一款）= 整页**只有那一段**
 *    `<script data-view="submit-feedback">`（只做"置灰 + 换文案 + 计时"）；其余页面仍然 **0 段**。
 *  理由：她真机（逐字）「点完之后**没有 Toast、按键置灰**之类的提示……**我就会一直狂点**」
 *    ⇒ 她**明确要置灰**；"置灰"没有零 JS 的等价物 ⇒ 多了**唯一一段**内联 JS。
 *    ⚠️ 被保护的不变量收窄成：**只有这一段、只做这件事、不做网络/DOM 副作用**。
 */
/** ⚠️ 2026-10-12 旧断言改写（**验收领域改成"扫码页自己开工"**）：
 *  改前（逐字）：`assert.ok(blockOf(html, 'accept').includes(SCAN_PAGE.texts.realmEmptyTitle));`
 *                （以及 `accept: { has: [SCAN_PAGE.texts.realmEmptyTitle], … }` 那一处）
 *  改后（逐字）：断言**新的自助块** —— `data-view="accept-pending"` + `SCAN_PAGE.texts.acceptPendingTitle`
 *                （未到货批次列表 / 手输兜底都在它里面）。
 *  理由：业务负责人 2026-10-12 明确「**验收还是只在扫码页**，我不需要在工作台」⇒ 验收领域
 *        在没有活跃会话时**不再是一张"回工作台"的人话卡**，而是**自己列未到货批次 + 手输批次号**。
 *        ⚠️ 被保护的不变量没变（仍是"验收领域要有内容、不回落销售、不白屏"），只是内容换了。
 */
/**
 * ⭐⭐ 2026-10-11（业务负责人批准）：扫码页**六个领域** + "服务器记住她正在做什么"。
 *
 * 她的口径（逐字要点）：
 *   · 领域顺序 = **销售 · 补货 · 退货 · 验收 · 库存 · 货品**（**缺省领域仍 = 销售**）；
 *   · 原「**采购**」领域**去掉** —— 里面的**补货 / 退货 / 验收 拆成三个独立领域**；
 *   · 「**领域切换条 6 个 ⇒ 做成"紧凑两行网格"**」（**不横滑**、每格都好点、≥44px）；
 *   · 「**一个二维码、6 个领域**：二维码内容**不变**（只含编号）」；
 *   · ⭐ 「**我觉得这个很好**」（服务器记住她正在做什么）⇒ **验收期间扫标签 = 自动进【验收】领域**
 *     （TTL 30 分钟 / 完成即结束）**保留**；⚠️ **本轮只做验收接管**（退货 / 补货不接管）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-6R1 领域清单逐字 = 销售 · 补货 · 退货 · 验收 · 库存 · 货品（id 与 label 都对；
 *         **`purchase` 不在清单里**）；缺省领域仍 = 销售。
 *  AC-6R2 切换条：6 条**真链接**（`?from=<id>`，服务端决定选中态，零 JS）；
 *         样式 = **紧凑两行网格**（`grid` 3 列、**没有 `overflow-x`**）、
 *         每格 `min-height: var(--control-height)`（≥44px 复用既有可点高度）。
 *  AC-6R3 认不出的 `?from=`（含**已退役的 `purchase`**）⇒ 回落**销售**（既有口径，不报错、不白屏）。
 *  AC-6R4 三个新领域各自的块：`replenish` = 补货表单、`purchase_return` = 退货表单、
 *         `accept` = 验收（没有活跃会话时给人话卡）；**每页只有当前那一块**（另外五块连字符串都不拼）。
 *  AC-6R5 零 JS 哨兵：整页 HTML 里**没有 `<script`**（这一页的既有硬要求）。
 *  AC-6R6 `noscript` 兜底那一排领域链接 = **6 条**（没有脚本时六个领域也都点得到）。
 *  AC-6R7 ⭐ **验收接管保留**：有活跃验收会话时，**裸扫**（不带 `?from=`）⇒ `realm-block--accept`；
 *         她显式点别的领域（如 `?from=sales`）**不被接管**；会话完成后裸扫 ⇒ 回到**销售**。
 *  AC-6R8 `?from=accept` 在没有活跃会话时也是**验收领域**（一张人话卡说明下一步去哪），
 *         **不回落销售**（URL 说什么就是什么）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_six_realms';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'six_realms_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { REALMS, DEFAULT_REALM, resolveRealm } = require('../src/views/scanPageRealm');
const { renderScanPage } = require('../src/views/scanPageRenderer');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { createScanArrivalService } = require('../src/services/scanArrivalService');
const { createPurchaseQueryService } = require('../src/services/purchaseQueryService');
const { PurchaseArrivalConversationService } = require('../src/services/purchaseArrivalConversationService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const RENDERER_SRC = path.join(__dirname, '../src/views/scanPageRenderer.js');
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
const SESSION_SECRET = 'six-realms-session-secret';
const BATCH = 'CGD-20261011-0001';
const BATCH_RECORD_ID = 'batch_rec_1';

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-11 18:00',
  product_record_id: 'prod_1',
};

const WRITE = {
  enabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: `/s/${ENCODED}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  returnKey: 'scan_return:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  saleEnabled: true,
  replenishEnabled: true,
  returnEnabled: true,
  notice: '',
};

const htmlFor = (realm, page = {}) => renderScanPage(VIEW, SCAN_PAGE, WRITE, realm, page);
const blockOf = (htmlText, id) => {
  const page = htmlText.slice(htmlText.indexOf('</head>'));
  const start = page.indexOf(`realm-block--${id}"`);
  assert.ok(start > -1, `缺 ${id} 块`);
  const foot = page.indexOf('<p class="foot">', start);
  return page.slice(start, foot > -1 ? foot : page.length);
};

// ── 路由夹具（AC-6R7 / AC-6R8：真跑一次"验收接管"）─────────────────────────
const fakeGateway = (records) => ({
  table: (key) => V1_BITABLE_SCHEMA.tables[key],
  listAll: async (key) => records[key] || [],
  get: async (key, id) => (records[key] || []).find((record) => record.record_id === id) || null,
  listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
});
const SIZE_STUB = {
  resolveLinkedCell: async (cell) => {
    const id = Array.isArray(cell) ? cell[0] : cell;
    return { recordId: id, size: Number(String(id).replace('size_', '')) };
  },
  resolveByNumber: async (value) => ({ recordId: `size_${value}`, size: Number(value) }),
};
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `six-realms-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

const createArrivalHarness = () => {
  const gateway = fakeGateway({
    purchaseRequest: [
      { record_id: 'pr_40', fields: { 报货批次号: [BATCH_RECORD_ID], 编号: ['prod_1'], 尺码: ['size_40'], 数量: 2 } },
    ],
    product: [{ record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' } } }],
    sizeManagement: [{ record_id: 'size_40', fields: { 尺码: 40 } }],
    purchaseOrderBatch: [{ record_id: BATCH_RECORD_ID, fields: { 报货批次号: BATCH, 到货状态: '未到货' } }],
    behavior: [],
  });
  const store = new JsonTaskStore({ dir: tempDir('arrival'), idField: 'task_id' });
  const arrival = createScanArrivalService({
    gateway,
    config: SCAN_WRITE.acceptance,
    purchaseQuery: createPurchaseQueryService(gateway, { sizeReferences: SIZE_STUB }),
    arrivalConversation: new PurchaseArrivalConversationService({
      gateway,
      store,
      sizeReferences: () => SIZE_STUB,
      confirmArrival: async () => ({ toast: { type: 'success', content: 'ok' } }),
      markBatchArrived: async () => ({ updated: true }),
    }),
    store: new JsonTaskStore({ dir: tempDir('accept-session'), idField: 'session_id' }),
  });
  return arrival;
};

const sessionCookie = (openId = 'ou_six_realms') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const sixRealmApp = (arrival) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: fakeGateway({}),
    writeService: false,
    arrivalService: arrival,
    writeConfig: SCAN_WRITE,
  }));
  return app;
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R1 领域清单
// ═══════════════════════════════════════════════════════════════════════════

const scriptCountOf = (html) => (html.match(/<script[\s>]/gi) || []).length;

test('AC-6R1 六个领域逐字 = 销售 · 补货 · 退货 · 验收 · 库存 · 货品（purchase 不在清单里）', () => {
  assert.deepEqual(REALMS.map((realm) => realm.id),
    ['sales', 'replenish', 'purchase_return', 'accept', 'inventory', 'product']);
  assert.deepEqual(REALMS.map((realm) => realm.label),
    ['销售', '补货', '退货', '验收', '库存', '货品']);
  assert.equal(REALMS.some((realm) => realm.id === 'purchase'), false, '原「采购」领域已去掉');
  assert.equal(DEFAULT_REALM, 'sales', '缺省领域仍 = 销售');
});

test('AC-6R2 切换条：6 条真链接 + 紧凑两行网格（不横滑、每格 ≥44px、零 JS）', () => {
  const html = htmlFor('sales');
  const bar = html.slice(html.indexOf('<nav class="realm-bar"'), html.indexOf('</nav>'));
  // 6 条真链接，顺序与 id 都对
  const links = [...bar.matchAll(/<a class="realm-tab[^"]*" data-realm-id="([^"]+)" href="\?from=([^"]+)"/g)]
    .map((match) => ({ id: match[1], from: match[2] }));
  assert.deepEqual(links.map((item) => item.id),
    ['sales', 'replenish', 'purchase_return', 'accept', 'inventory', 'product']);
  assert.deepEqual(links.map((item) => item.from), links.map((item) => item.id), 'href = ?from=<id>');
  // 选中态由**服务端**给（零 JS）
  assert.match(bar, /class="realm-tab realm-tab--active" data-realm-id="sales"[^>]*aria-current="page"/);
  assert.equal((bar.match(/realm-tab--active/g) || []).length, 1, '只有当前领域高亮');

  // 样式哨兵：grid 三列（6 格 = 两行）、**不许横滑**、每格 ≥44px（既有 --control-height）
  const style = fs.readFileSync(RENDERER_SRC, 'utf8');
  const barRule = style.match(/\.realm-bar \{[^}]*\}/)[0];
  assert.match(barRule, /display:\s*grid/, '紧凑两行网格 = grid');
  assert.match(barRule, /grid-template-columns:\s*repeat\(3,/, '三列 × 两行');
  assert.equal(/overflow-x/.test(barRule), false, '切换条不许横滑');
  const tabRule = style.match(/\n\.realm-tab \{[^}]*\}/)[0];
  assert.match(tabRule, /min-height:\s*var\(--control-height\)/, '每格 ≥44px（复用既有可点高度）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R3 认不出的领域回落销售
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R3 认不出的 ?from=（含已退役的 purchase）⇒ 回落销售；不报错、不白屏', () => {
  for (const value of [undefined, '', 'nonsense', 'purchase', 'PURCHASE', '采购', 'accept2']) {
    assert.equal(resolveRealm(value), 'sales', `?from=${value} 应回落销售`);
  }
  // 六个真领域各自认得出来
  for (const realm of REALMS) assert.equal(resolveRealm(realm.id), realm.id);
  // 渲染层也不许抛：认不出的领域渲染的是**销售**那一块（有正文）
  const html = htmlFor('purchase');
  assert.ok(html.includes('realm-block--sales"'), '已退役的领域名渲染成缺省领域');
  assert.ok(!html.includes('realm-block--purchase"'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R4 三个新领域各自的块（每页只有一块）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R4 补货 / 退货 / 验收 三块各自独立；每页**只有当前那一块**', () => {
  const replenish = htmlFor('replenish');
  assert.ok(blockOf(replenish, 'replenish').includes('data-view="one-tap-replenish"'), '补货 = 一键补货表单');
  assert.ok(blockOf(replenish, 'replenish').includes('生成采购申请'));

  const purchaseReturn = htmlFor('purchase_return');
  assert.ok(blockOf(purchaseReturn, 'purchase_return').includes('data-view="purchase-return"'), '退货 = 退货表单');
  assert.ok(blockOf(purchaseReturn, 'purchase_return').includes('生成采购退货'));

  // 验收：没有活跃会话 ⇒ 一张人话卡（标题 + 下一步），不是白屏
  const accept = htmlFor('accept');
  const acceptBlock = blockOf(accept, 'accept');
  // ⭐ 2026-10-12：没有活跃会话时 = **她自己开工那一块**（列未到货批次 + 手输兜底）
  assert.ok(acceptBlock.includes('data-view="accept-pending"'), '验收领域自己有内容');
  assert.ok(acceptBlock.includes(SCAN_PAGE.texts.acceptPendingTitle));
  assert.ok(acceptBlock.includes('data-view="accept-manual"'), '手输批次号兜底在');
  // 🔴 她 2026-10-12：「验收还是只在扫码页呀，我不需要在工作台」⇒ 这一块里**不许**出现「工作台」
  assert.equal(acceptBlock.includes('工作台'), false, '不许把她支去工作台');

  // 每页只有当前那一块（另外五块连字符串都不拼）
  for (const [realm, html] of [['replenish', replenish], ['purchase_return', purchaseReturn], ['accept', accept]]) {
    for (const other of REALMS.map((item) => item.id).filter((id) => id !== realm)) {
      assert.equal(html.includes(`realm-block--${other}"`), false, `${realm} 页上不该有 ${other} 块`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R5 / AC-6R6 零 JS + noscript 兜底
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R5 零 JS：六个领域渲染出来的 HTML 里都没有 <script', () => {
  for (const realm of REALMS.map((item) => item.id)) {
    const html = htmlFor(realm);
        // ⭐ 2026-10-12（她拍板：交互反馈是硬要求）：
        //    页面上**只要有带反馈属性的写按钮** ⇒ 恰好那一段脚本；没有写按钮的页面（纯库存）仍然 0 段。
        const feedbackScripts = scriptCountOf(html);
        assert.ok(feedbackScripts <= 1, `最多只该有那一段反馈脚本（实际 ${feedbackScripts}）`);
        assert.equal(feedbackScripts, html.includes('data-submit-feedback=') ? 1 : 0,
          '有写按钮 ⇒ 1 段；没有 ⇒ 0 段');
  }
});

test('AC-6R6 noscript 兜底：六条领域链接一条不少', () => {
  const html = htmlFor('sales');
  const noscript = html.slice(html.indexOf('<noscript>'), html.indexOf('</noscript>'));
  for (const realm of REALMS) {
    assert.ok(noscript.includes(`href="?from=${realm.id}"`), `noscript 里缺 ${realm.id}`);
  }
  assert.equal((noscript.match(/realm-link/g) || []).length, 6, '兜底那一排正好 6 条');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6R7 / AC-6R8 服务器记住她正在做什么（只接管验收）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6R7 有活跃验收会话时：裸扫 ⇒ 验收领域；显式点其它领域 ⇒ 不被接管；完成后 ⇒ 回到销售', async () => {
  login();
  const arrival = createArrivalHarness();
  const openId = 'ou_six_realms';
  const cookie = { cookie: sessionCookie(openId), 'user-agent': 'Mozilla/5.0 (iPhone) Lark/7.5' };
  try {
    await withServer(sixRealmApp(arrival), async (base) => {
      const pageUrl = `${base}/s/${ENCODED}`;
      // 还没有验收会话：裸扫 = 销售
      const before = await (await fetch(pageUrl, { headers: cookie })).text();
      assert.ok(before.includes('realm-block--sales"'), '没在验收时裸扫 = 销售');

      // 工作台那一步：开会话
      const started = await arrival.start({
        openId, batchNo: BATCH, batchRecordId: BATCH_RECORD_ID, operatorOpenId: openId,
      });
      assert.equal(started.ok, true, JSON.stringify(started));

      // 裸扫 ⇒ **验收领域**（服务器记得她正在验收）
      const during = await (await fetch(pageUrl, { headers: cookie })).text();
      assert.ok(during.includes('realm-block--accept"'), '验收期间裸扫 ⇒ 验收领域');
      assert.ok(during.includes('已验收 0 双 / 应到 2 双'), '本单条照旧');
      // 她显式点别的领域 ⇒ 不被接管
      for (const realm of ['sales', 'replenish', 'purchase_return', 'inventory', 'product']) {
        const html = await (await fetch(`${pageUrl}?from=${realm}`, { headers: cookie })).text();
        assert.ok(html.includes(`realm-block--${realm}"`), `?from=${realm} 不许被验收接管`);
        assert.equal(html.includes('realm-block--accept"'), false);
      }
      // 点【验收】tab 自己 ⇒ 验收领域（会话还在）
      const acceptTab = await (await fetch(`${pageUrl}?from=accept`, { headers: cookie })).text();
      assert.ok(acceptTab.includes('realm-block--accept"'));

      // 完成验收（用扫描行 + 金额走既有链路）⇒ 会话结束 ⇒ 裸扫回到销售
      await arrival.addScan({ openId, productRecordId: 'prod_1', size: 40, quantity: 2 });
      const finished = await arrival.finish({ openId, actualAmount: 999, operatorOpenId: openId });
      assert.equal(finished.ok, true, JSON.stringify(finished));
      const after = await (await fetch(pageUrl, { headers: cookie })).text();
      assert.ok(after.includes('realm-block--sales"'), '验收完成后裸扫 ⇒ 回到销售');
    });
  } finally { rmDir(path.join(os.tmpdir(), 'six-realms-noop')); }
});

test('AC-6R8 ?from=accept 没有活跃会话时仍是验收领域（人话卡），不回落销售', () => {
  login();
  const arrival = createArrivalHarness();
  return withServer(sixRealmApp(arrival), async (base) => {
    const html = await (await fetch(`${base}/s/${ENCODED}?from=accept`, {
      headers: { cookie: sessionCookie('ou_six_realms_8') },
    })).text();
    assert.ok(html.includes('realm-block--accept"'), 'URL 说什么就是什么');
    // ⭐ 2026-10-12：仍是验收领域，内容是**自助块**（列未到货批次 / 手输兜底）
    assert.ok(blockOf(html, 'accept').includes('data-view="accept-pending"'));
    assert.equal(html.includes('realm-block--sales"'), false);
  });
});
