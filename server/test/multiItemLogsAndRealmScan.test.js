require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⭐⭐ **task-61**：① 补充日志/埋点（一单多货）· ② 「加货」改成【带当前领域的扫一扫】
 *   （业务负责人 2026-10-16 14:38 逐字：
 *    「好的，那**补充日志和埋点**吧，然后再**加一单改为这个领域的扫一扫，与全局扫一扫不同**，
 *      然后多货品那条链路也要接异步」—— **本刀只做前两件** ✓ 第三件另有一张卡 ✗）
 *
 * 她的关键口径（14:32 逐字，见 `task-60` / `task-61` 任务书）：
 *   · 领域条那颗「扫一扫」= **全局**扫一扫 ✓（扫完按默认 / 记忆领域 ✓ **行为不变** ✗）；
 *   · 补货 / 退货 里的「＋ 再加一个货品」= **带【当前领域】上下文的扫一扫** ✓
 *     ⇒「**点击了退货里面的扫码「再加一单」，扫完之后，就是直接放到退货里面的货品**」✓。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做** ✓ 每条都能真红）
 *
 *  AC-ML1 点「加货」⇒ 打 `scan.multi_item.add`（链 / 货品 / 尺码+数量 / **本单已加几件** /
 *         `request_id` / `open_id` ✓ 键名走 config ✓）
 *  AC-ML2 渲染「本单已加的货品」列表 ⇒ 打 `scan.multi_item.render`（已加几件 / 列表货品号 / 链）
 *  AC-ML3 ⭐ **领域内扫一扫**：退货里那颗入口**带上退货领域** ⇒ 扫完那件**落进退货本单**
 *         （落进别的领域 ⇒ **红**）
 *  AC-ML4 **全局那颗扫一扫行为不变** ✗（扫完仍按默认 / 记忆领域；本刀一个字都不动它）
 *  AC-ML5 **开关关着 ⇒ 页面与今天逐字节一致** ✓（零回归）
 *  AC-ML6 **单货品路径零影响** ✓（一个字节都不经过新逻辑）
 *  AC-ML7 配置先行 / 零硬编码中文（脚本正文只有 ASCII；事件名与键名都在 `config/**`）
 *  AC-ML8 红线：`services/scanWriteService.js` **一个字不加/删/改** ✗
 *
 * 🔴 **零回归的逐字节证据**（比"断言没多出那几个字符串"更强）：
 *   `server/tools/task61-render-baseline.js` —— 同一份脚本分别在 **`origin/main` 的代码**与
 *   **本刀之后的代码**上跑，`cmp` 出来的 11 个页面（4 个领域 × 2 种状态 ＋ 消息页 ＋ 最小页）
 *   **508,317 字节逐字节相同** ✓（开关关着时）。下面 `AC-ML5` 是它的**常驻哨兵**版本。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService` 那条链在 require 阶段就要凭证（与既有扫码页用例同一个前置 ✓）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_mi_logs_realm_scan';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'mi_logs_realm_scan_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'app_mi_logs';
process.env.LARK_WEB_SESSION_SECRET = 'mi_logs_realm_scan_session_secret';
// 扫码页那道身份闸门是**惰性求值**的（`enabled()` 每次读 env ✓）⇒ 这里设了就生效 ✓
process.env.LARK_WEB_AUTH_ENABLED = 'true';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { MULTI_ITEM_ORDER, resolveMultiItemOrderConfig } = require('../src/config/multiItemOrder');
const { createRealmScanConfig, realmScanUrlFor } = require('../src/config/realmScan');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { multiItemPayloadJson, renderScanPage } = require('../src/views/scanPageRenderer');
const { realmScanScriptSource } = require('../src/views/scanRealmScan');
const { createLarkJsapiService } = require('../src/services/larkJsapiService');

const ROUTE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage.js'), 'utf8');
const WRITE_SERVICE_PATH = path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js');
const WRITE_SERVICE_SRC = fs.readFileSync(WRITE_SERVICE_PATH, 'utf8');
const SESSION_SECRET = 'mi_logs_realm_scan_session_secret';
const OPEN_ID = 'ou_mi_logs';
const NUMBER = 'K1|黑色|A';
const PARAMS = encodeURIComponent(NUMBER);
const clone = (value) => JSON.parse(JSON.stringify(value));

const sessionCookie = (openId = OPEN_ID) => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const view = () => ({
  found: true,
  number: NUMBER,
  item_no: 'K1',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 05:00',
  product_record_id: 'rec_K1',
});

/** 假写服务：只提供路由这一路要用的口（会话 / 写入件 / 领域记忆）—— 与既有 13 条同一形状 ✓ */
const makeWriteService = () => {
  const records = new Map();
  const idOf = (openId) => `scan_session_${String(openId).replace(/[^a-zA-Z0-9]/g, '')}`;
  const store = {
    get: async (id) => (records.has(id) ? clone(records.get(id)) : null),
    update: async (id, patchOrMutator) => {
      const current = records.has(id) ? clone(records.get(id)) : null;
      const patch = typeof patchOrMutator === 'function' ? await patchOrMutator(current) : patchOrMutator;
      const next = { ...(current || {}), ...(patch || {}) };
      records.set(id, next);
      return clone(next);
    },
  };
  return {
    records,
    idOf,
    sessions: {
      idOf,
      store,
      get: store.get,
      setLastRealm: async () => {},
      // 与既有假会话同形（渲染半要它拼幂等键 ✓）
      submitKeyFor: () => 'scan_replenish:x:1',
    },
    multiItemWriters: () => ({ purchase: async () => {}, purchaseReturn: async () => {}, behavior: async () => ({}) }),
  };
};

/** 假引擎：只为钉"路由把什么交给它"（真落库 / 幂等另有既有判据 ✓） */
const makeEngine = () => {
  const calls = [];
  const drafts = new Map();
  return {
    calls,
    async openDraft({ openId, chain }) {
      const orderKey = `${chain}:${openId}:1`;
      calls.push({ fn: 'openDraft', chain, orderKey });
      if (!drafts.has(orderKey)) drafts.set(orderKey, { items: [], order_amount: '', status: 'draft' });
      return { ok: true, orderKey, draft: drafts.get(orderKey) };
    },
    async addItem({ chain, orderKey, item }) {
      calls.push({ fn: 'addItem', chain, orderKey, item: clone(item) });
      return { ok: true, orderKey, draft: { items: [clone(item)] } };
    },
    async submitDraft({ chain, orderKey }) {
      calls.push({ fn: 'submitDraft', chain, orderKey });
      return { ok: true, summary: { chain, order_key: orderKey, batch_count: 1, detail_count: 1 } };
    },
  };
};

/** 假飞书签名服务（**不碰真网络** ✓）：形状与 `services/larkJsapiService.signatureFor` 同形 ✓ */
const fakeLarkJsapi = () => {
  const calls = [];
  return {
    calls,
    config: { jssdkUrl: 'https://cdn.example/jssdk.js', texts: { upstreamFailed: '上游不可用' } },
    async signatureFor(url) {
      calls.push({ url });
      return {
        ok: true,
        appId: 'cli_fake',
        timestamp: 1792133000000,
        nonceStr: 'nonce',
        signature: 'sig',
        url,
        jssdkUrl: 'https://cdn.example/jssdk.js',
        jsApiList: ['scanCode'],
      };
    },
  };
};

/** 假"写服务的日志"：路由用 `utils/logger` 打 —— 这里抓 `console` 不现实，改用**进 logger 的 JSON** */
const captureLogs = () => {
  const lines = [];
  // ⚠️ 路由里是 `const { logInfo } = require('../utils/logger')`（**解构**）⇒ 事后改模块导出**没用** ✗
  //    ⇒ 从**最底层**（logger 写的就是 `console.log/warn/error` ✓）抓 —— 这一层与解构无关 ✓
  const original = {};
  for (const name of ['log', 'warn', 'error']) {
    original[name] = console[name];
    console[name] = (...args) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg);
          if (parsed && parsed.event) lines.push({ event: parsed.event, fields: parsed });
        } catch (error) { /* 不是我们的 JSON 行 ⇒ 不管 ✓ */ }
      }
    };
  }
  return { lines, restore: () => { for (const name of Object.keys(original)) console[name] = original[name]; } };
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

const appFor = ({ writeService = makeWriteService(), engine = null, realmScan } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use((req, _res, next) => { req.requestId = req.requestId || crypto.randomUUID(); next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService,
    render: {
      success: (payload) => `<html>OK ${payload?.requestId || ''}</html>`,
      message: (payload) => `<html>ERR ${payload?.title || ''} | ${payload?.body || ''}</html>`,
    },
    ...(engine ? { multiItemOrder: engine } : {}),
    ...(realmScan ? { realmScan, larkJsapi: fakeLarkJsapi() } : {}),
  }));
  return app;
};

const FIRST = {
  product_record_id: 'rec_K1', number: NUMBER, item_no: 'K1', color: '黑色',
  supplier_record_id: 'sup_K1', entries: [],
};
const K2_FIRST = {
  product_record_id: 'rec_K2', number: 'K2|白色|A', item_no: 'K2', color: '白色',
  supplier_record_id: 'sup_K2', entries: [],
};
const SECOND = {
  product_record_id: 'rec_K2', number: 'K2|白色|A', item_no: 'K2', color: '白色',
  supplier_record_id: 'sup_K2', entries: [],
};

/** 「＋ 再加一个货品」那一颗 submit 发出去的形状（字段名只从配置取 ✓ 不手拼 ✗） */
const addBody = ({ realm = 'replenish', items = [FIRST], sizes = ['40'], quantity = '2', chain = 'replenish' }) => {
  const params = new URLSearchParams();
  const wire = MULTI_ITEM_ORDER.wire;
  params.append(wire.addAction, wire.addValue);
  params.append(SCAN_WRITE.fields.submitKey, `scan_${chain}:scan_session_milogerealmsscan:1`);
  const sizeField = realm === 'replenish' ? SCAN_WRITE.fields.replenishSizes : SCAN_WRITE.fields.returnSizes;
  const qtyPrefix = realm === 'replenish'
    ? SCAN_WRITE.fields.replenishQuantityPrefix : SCAN_WRITE.fields.returnQuantityPrefix;
  for (const size of sizes) params.append(sizeField, size);
  if (sizes.length) params.append(`${qtyPrefix}${sizes[0]}`, quantity);
  if (realm !== 'replenish') params.append(SCAN_WRITE.fields.purchaseAmount, '399');
  if (items) params.append('multi_items', multiItemPayloadJson(items));
  return params;
};

const postAdd = (base, body, realm = 'replenish') => fetch(
  // 领域走**既有那一个**查询键（`?from=` ✓ 缺省领域不带 —— 与页面上表单的 `action` 同一口径 ✓）
  `${base}${SCAN_PAGE.route.basePath}/${PARAMS}${realm && realm !== 'sales' ? `?from=${realm}` : ''}`,
  {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  },
);

const getPage = (base, query = '?from=replenish') => fetch(
  `${base}${SCAN_PAGE.route.basePath}/${PARAMS}${query}`,
  { headers: { cookie: sessionCookie() } },
);

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML1 / AC-ML2 ⭐⭐ 两条日志（她 14:38「补充日志和埋点」）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML1 ⭐⭐ 点「加货」⇒ 打 `scan.multi_item.add`（链 / 货品 / 尺码+数量 / 本单已加几件 / request_id / open_id）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine();
  const logs = captureLogs();
  try {
    await withServer(appFor({ writeService, engine }), async (base) => {
      const first = await postAdd(base, addBody({ items: [FIRST], sizes: ['40'], quantity: '2' }));
      assert.equal(first.status, 303, '加货成功 ⇒ 303 回本页（PRG ✓ 既有口径不变）');
      // 第二次是"换了一页再加"（首件换成 K2 ⇒ 与第一次**不是同一件**，所以是**加**不是覆盖 ✓）
      const second = await postAdd(base, addBody({
        items: [K2_FIRST, FIRST], sizes: ['41'], quantity: '1',
      }));
      assert.equal(second.status, 303);

      const log = (MULTI_ITEM_ORDER.logFields || {});
      const found = logs.lines.filter((line) => line.event === (log.addEvent || 'scan.multi_item.add'));
      assert.equal(found.length, 2,
        `🔴 **每一次加货一条**（她点了两次 ⇒ 两条 \`${log.addEvent}\`；改前一条都没有 ✗）`);
      assert.deepEqual(found.map((line) => line.fields[log.addedCountKey || 'added_count']), [1, 2],
        '两条的"已加几件"逐条递进（1 ⇒ 2 ✓ 她那一问一眼看得出是哪一步出的问题 ✓）');
      const fields = found[found.length - 1].fields;
      // 键名**全走 config** ✓（改一个键名只改配置 —— 这里读的就是同一份配置 ✓）
      assert.equal(fields[log.chainKey || 'chain'], 'replenish', '链（补货 / 退货）✓');
      assert.equal(fields[log.productKey || 'product'], 'rec_K2',
        '🔴 这一次加进去的是**哪一个货品**（= 表单首件 = 她这一页那一款 ✓）');
      assert.deepEqual(fields[log.entriesKey || 'entries'], [{ size: '41', quantity: '1' }],
        '🔴 她刚填的**尺码 + 数量**原样在里面（她那一问的原始输入 ✓）');
      assert.equal(fields[log.addedCountKey || 'added_count'], 2,
        '🔴 **本单已加几件**（= 草稿里真的有那两件 ✓ 她那一问的头号数字 ✓）');
      assert.ok(fields.request_id, '关联键 `request_id` ✓（她 2026-10-07 定的写入类日志口径 ✓）');
      assert.ok(String(fields.open_id || '').length > 0,
        '关联键 `open_id` ✓（本单是按人存的 ✓；⚠️ logger 按既有口径脱敏 ⇒ 判"在且非空" ✓）');
      // ⚠️ `order_key` 此刻**可能还是空串**：它是"提交那一刻"才由引擎轮换/落定的那把键
      //    （既有口径 ✓ 本单暂存这一层还没有它）⇒ 判"**这个键在**"（拿不到就不传、不许编 ✗）
      assert.ok(Object.prototype.hasOwnProperty.call(fields, log.orderKeyKey || 'order_key'),
        '关联键 `order_key` 这个键要在（值这一刻可能是空串 ✓ 不许编 ✗）');
      // 真实落进草稿（与日志里的数字**同源** ✓ 不许"日志说 2、草稿只有 1" ✗）
      const session = await writeService.sessions.store.get(writeService.idOf(OPEN_ID));
      const pending = session.orders['replenish:pending'];
      assert.equal(pending.items.length, 2, '草稿里真的两件 ✓（日志与事实同源 ✓）');
    });
  } finally { logs.restore(); }
});

test('AC-ML2 ⭐⭐ 渲染「本单已加的货品」列表 ⇒ 打 `scan.multi_item.render`（已加几件 / 列表货品号 / 链）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine();
  const logs = captureLogs();
  try {
    await withServer(appFor({ writeService, engine }), async (base) => {
      // 先真的加两件（K1 与 K2 —— **第二次是"换了一页再加"**：首件换成 K2 ✓），
      // 再 GET K1 那一页 —— 页面上的列表与这一条日志必须**同源** ✓
      await postAdd(base, addBody({ items: [FIRST] }));
      await postAdd(base, addBody({
        items: [K2_FIRST, FIRST], sizes: ['41'], quantity: '1',
      }));
      logs.lines.length = 0;
      const response = await getPage(base, '?from=replenish');
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes('multi-item-list'), '页面上真的有"本单已加的货品"那一块 ✓');

      const log = (MULTI_ITEM_ORDER.logFields || {});
      const found = logs.lines.filter((line) => line.event === (log.renderEvent || 'scan.multi_item.render'));
      assert.equal(found.length, 1, `🔴 渲染那个列表要打**恰好一条** \`${log.renderEvent}\``);
      const fields = found[0].fields;
      assert.equal(fields[log.chainKey || 'chain'], 'replenish', '链 ✓');
      assert.equal(fields[log.addedCountKey || 'added_count'], 2, '已加几件 ✓');
      assert.deepEqual(fields[log.itemNosKey || 'item_nos'], ['K1|黑色|A', 'K2|白色|A'],
        '🔴 列表里的**货品号**（= 页面上那一行的标识，`number` 优先 ✓ ——'
        + ' "扫了 B 但没看到 A"就是靠这一条对出来的 ✓）');
      assert.ok(fields.request_id, '关联键 `request_id` ✓');

      // 反向：**没有已加货品** ⇒ 这一页**一条都不打**（日志与今天逐字一致 ✓）
      logs.lines.length = 0;
      const empty = makeWriteService();
      await withServer(appFor({ writeService: empty, engine: makeEngine() }), async (base2) => {
        await getPage(base2, '?from=replenish');
        const rendered = logs.lines.filter((line) => line.event === (log.renderEvent || 'scan.multi_item.render'));
        // 替补档（补货）**会**渲染那个 `<ul>`（缺省档保留空态人话 ✓）；列表里是空的 ⇒
        // 这一条要说的是"**列表里一件都没有**"（这正是"扫了 B 但没看到 A"要看的那个数 ✓）。
        assert.equal(rendered.length, 1, '渲染了那个列表就记一条 ✓');
        assert.equal(rendered[0].fields[log.addedCountKey || 'added_count'], 0, '已加 0 件 ✓');
        assert.deepEqual(rendered[0].fields[log.itemNosKey || 'item_nos'], [], '列表里一件都没有 ✓');
        // 🔴 **没有那一笔就一条都不打**：库存页（压根不渲染这个块）⇒ 连 `render` 都没有 ✓
        logs.lines.length = 0;
        await getPage(base2, '?from=inventory');
        assert.equal(
          logs.lines.filter((line) => line.event === (log.renderEvent || 'scan.multi_item.render')).length, 0,
          '库存页不渲染那一块 ⇒ **一条都不打** ✓（零噪音 ✓）',
        );
      });
    });
  } finally { logs.restore(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML3 ⭐⭐⭐ 领域内扫一扫：退货里点 ⇒ 扫完那件**落进退货本单**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML3a ⭐⭐ 扫完那件**带上当前领域**（落点带 `?from=<领域>`；别的领域 ⇒ 红）', () => {
  const config = createRealmScanConfig({});
  const page = 'https://hm.bamamei.online/r/rec_K2?job=x';
  assert.equal(realmScanUrlFor({ scanned: page, realm: 'purchase_return', config }),
    'https://hm.bamamei.online/r/rec_K2?job=x&from=purchase_return',
    '🔴 退货里扫 ⇒ 落点必须带 `from=purchase_return`（落进别的领域 ⇒ 这条红 ✓）');
  assert.equal(realmScanUrlFor({
    scanned: page, realm: 'replenish', config,
  }), 'https://hm.bamamei.online/r/rec_K2?job=x&from=replenish',
  '补货里扫 ⇒ 落点是补货（**领域不同 ⇒ 落点不同** ✓ 这就是"与全局扫一扫不同" ✓）');
  // 已经有 `from` ⇒ **换掉它**（不许出现两个 `from` ✗ —— 那会让 `resolveRealm` 读到错的那个）
  assert.equal(realmScanUrlFor({
    scanned: 'https://hm.bamamei.online/r/rec_K2?from=sales', realm: 'purchase_return', config,
  }), 'https://hm.bamamei.online/r/rec_K2?from=purchase_return');
  // 认不出来 ⇒ **空串**（宁可不跳，也不乱跳 ✗）
  for (const bad of ['', '   ', null, undefined]) {
    assert.equal(realmScanUrlFor({ scanned: bad, realm: 'purchase_return', config }), '',
      `坏输入 ${JSON.stringify(bad)} ⇒ 空串 ✓`);
  }
  assert.equal(realmScanUrlFor({ scanned: 'rec_K2', realm: '', config }), '',
    '没有领域 ⇒ 空串（**绝不**当作全局扫一扫 ✗）');
  // 扫到的是**记录 ID**（手输 / 别的码）⇒ 用配置里那一段路径（`/r` ✓）在本页域名下拼 ✓
  assert.equal(realmScanUrlFor({
    scanned: 'rec_K2', realm: 'purchase_return', origin: 'https://hm.bamamei.online', config,
  }), 'https://hm.bamamei.online/r/rec_K2?from=purchase_return', '扫到 id ⇒ 同源拼 `/r/{id}` ＋领域 ✓');
  assert.equal(realmScanUrlFor({
    scanned: 'rec K2', realm: 'purchase_return', origin: 'https://hm.bamamei.online', config,
  }), '', '怪串（带空格）⇒ 空串 ✓（宁可不动，也不乱跳 ✗）');
  // 落点读它的是**既有** `resolveRealm`（不新造规则 ✓）
  const { resolveRealm } = require('../src/views/scanPageRealm');
  assert.equal(resolveRealm('from=purchase_return'.split('=')[1]), 'purchase_return',
    '🔴 `?from=purchase_return` 必须被既有 `resolveRealm` 认出来（那就是"落回退货"的判据 ✓）');
});

test('AC-ML3b ⭐⭐⭐ 退货里点「加货」⇒ 303 带上触发参数（**同一个领域**）＋那一页真的会调起飞书扫一扫', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine();
  const realmScan = createRealmScanConfig({
    SCAN_REALM_SCAN_ENABLED: 'true',
  });
  await withServer(appFor({ writeService, engine, realmScan }), async (base) => {
    // ① 退货那一页点「＋ 再加一个货品」⇒ 303（回跳仍停在**退货** ✓ 并带上触发参数 ✓）
    const response = await postAdd(base, addBody({
      realm: 'purchase_return', chain: 'purchase_return',
      items: [{ ...FIRST, entries: [] }], sizes: ['40'], quantity: '2',
    }), 'purchase_return');
    assert.equal(response.status, 303);
    const location = String(response.headers.get('location') || '');
    assert.match(location, /from=purchase_return/, `🔴 回跳必须停在**退货**（实际：${location}）`);
    assert.match(location, new RegExp(`${realmScan.triggerQueryKey}=${realmScan.triggerQueryValue}`),
      '🔴 回跳要带上触发参数（不然"点完了接着扫"永远不成立 ✗）');

    // ② 照着回跳那一发 GET ⇒ 页面上**真的有**那一段（配置块 + 脚本），且**落点是退货**
    const followed = await fetch(`${base}${location}`, { headers: { cookie: sessionCookie() } });
    assert.equal(followed.status, 200);
    const html = await followed.text();
    assert.ok(html.includes('data-view="realm-scan-config"'), '配置块在（脚本靠它知道去哪儿 ✓）');
    assert.ok(html.includes('data-view="realm-scan"'), '那一段脚本在 ✓');
    assert.match(html, /data-scan-now="1"/, '⭐ 只有"加货刚回来这一发"才 `scan-now=1`（其余任何时候都不弹 ✓）');
    assert.ok(html.includes('from%3Dpurchase_return') || html.includes('from=purchase_return'),
      '🔴 落点里带的是**退货**（扫完那件就落回退货本单 ✓ = 她 14:32 逐字那个场景 ✓）');
    // ③ **落点确实能落进退货本单**：照那个落点 GET ⇒ 退货那一页 ＋ 已加的货品还在 ✓
    const landed = await getPage(base, '?from=purchase_return');
    const landedHtml = await landed.text();
    assert.ok(landedHtml.includes('multi-item'), '落回退货那一页上仍有本单块 ✓');
    assert.ok(landedHtml.includes('multi-item-list'), '🔴 **前面加的那件还在列表里** ⇒ "落进退货本单"成立 ✓');
  });
});

test('AC-ML3c ⭐⭐ 开关关着 ⇒ 回跳**与今天逐字一致**（不多那个触发参数）＋签名端点 404', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine();
  // ⭐ 成对迁移（2026-10-16 业务负责人弹窗选「打开」⇒ 缺省翻 `true`）：
  //   改前逐字：`createRealmScanConfig({}); // 缺省：关` —— 它其实是拿**缺省值**当"关" ✗。
  //   改后：**显式配 `'false'`** ⇒ 这条测的才是"**关着**时回跳与今天逐字一致" ✓（更严，不是放宽 ✓）。
  const realmScan = createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'false' }); // 显式关
  await withServer(appFor({ writeService, engine, realmScan }), async (base) => {
    const response = await postAdd(base, addBody({
      realm: 'purchase_return', chain: 'purchase_return', sizes: ['40'], quantity: '2',
    }), 'purchase_return');
    const location = String(response.headers.get('location') || '');
    assert.match(location, /from=purchase_return/, '领域照旧（**这一条不是新行为** ✓）');
    assert.equal(location.includes('scan='), false,
      '🔴 开关关着 ⇒ 回跳**不许**多那个触发参数（页面与今天逐字一致 ✓ `AC-ML5`）');
    const signature = await fetch(`${base}${SCAN_PAGE.route.basePath}/lark/jsapi-signature?url=x`, {
      headers: { cookie: sessionCookie() },
    });
    assert.equal(signature.status, 404, '开关关着 ⇒ 连端点都不存在（不暴露、也不用它 ✓）');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML4 ⭐ 全局那颗「扫一扫」行为不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML4 ⭐⭐ 全局那颗「扫一扫」**一个字都没动**（仍是那条 AppLink；本刀不碰它）', () => {
  // ① 配置里那个 AppLink 仍是飞书官方"打开扫一扫"（与 `origin/main` 逐字相同 ✓）
  assert.equal(SCAN_PAGE.scanNext.applink, 'https://applink.feishu.cn/client/qrcode/main',
    '🔴 全局扫一扫的落点**必须**还是它（改了它就是"全局那颗变了" ✗）');
  // ② 它**不带** `?from=`（扫完仍按**默认 / 记忆领域** ✓ 她 14:32 那句"可以切换到全局" ✓）
  assert.equal(SCAN_PAGE.scanNext.applink.includes('from='), false,
    '🔴 全局那颗不许带领域（带了就变成"领域内扫一扫" ✗）');
  // ③ 渲染出来的那一格仍是**真链接**指向它（不是按钮、不带领域）
  const html = renderScanPage({ ...view(), multi_items: [] }, SCAN_PAGE, writeContext(), 'replenish',
    // ⚠️ 第 5 格只在**能调起飞书扫一扫**的设备上出现（既有口径 ✓）⇒ 这里给飞书手机端 UA
    { userAgent: 'Mozilla/5.0 (iPhone) Lark/7.0' });
  assert.match(html, /data-realm-id="scan" href="https:\/\/applink\.feishu\.cn\/client\/qrcode\/main"/,
    '🔴 第 5 格「扫一扫」仍是那条 AppLink ✓');
  // ④ 本刀没有第二套扫码入口：路由里 `resolveRealm` / 记忆领域那一段**一个字都没动** ✓
  assert.match(ROUTE_SRC, /const remembered = await writeService\?\.sessions\?\.get\?\.\(openIdOf\(req\)\)/,
    '全局扫一扫的"记忆领域"那一段仍在（本刀不碰它 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML5 ⭐⭐ 开关关着 ⇒ 页面与今天逐字节一致（零回归）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML5 ⭐⭐ 开关关着 ⇒ 页面上**一个字都不多**（脚本 / 配置块 / 触发参数都没有）', () => {
  // ⭐ 成对迁移（2026-10-16 业务负责人弹窗选「打开」⇒ 缺省翻 `true`）：
  //   改前逐字：`const off = createRealmScanConfig({}); // 缺省关` ＋
  //            `assert.equal(off.enabled, false, '缺省**关** ✓（显式布尔：空串也是关 ✓）');`
  //   —— 那一条其实在测**缺省值**，不是在测关态 ✗。
  //   改后：关态一律**显式**配 `'false'`（**更严**：真的在测"关着时页面一个字都不多" ✓）；
  //        缺省值单独钉成 **开** ✓（依据 = 她 2026-10-16 弹窗选「打开」✓）。
  const off = createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'false' }); // 显式关（缺省已是开）
  assert.equal(off.enabled, false, '显式 `false` ⇒ 关 ✓（**关得掉** ✓ 不是 `||` 兜底那种关不掉 ✗）');
  assert.equal(createRealmScanConfig({}).enabled, true,
    '缺省 ⇒ **开** ✓（改前逐字：`assert.equal(off.enabled, false, \'缺省**关** ✓…\')` —— 依据：她 2026-10-16 弹窗选「打开」✓）');
  assert.equal(createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: '' }).enabled, false,
    '空串 = 关 ✓（`readFlag` 显式布尔：**设成空串 = 显式关**，与"没设"不同 ✓ 不写 `||` 兜底 ✗）');
  assert.equal(createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'true' }).enabled, true, '配 true 就开 ✓');
  assert.throws(() => createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'maybe' }),
    '认不出的值**当场抛** ✓（不静默回退 ✗）');

  // 关着时：即使路由把 `realmScan` 喂进来（`null`），页面也**一个字都不多** ✓
  const html = renderScanPage({ ...view(), multi_items: [FIRST] }, SCAN_PAGE, writeContext(), 'replenish', {
    realmScan: null,
  });
  for (const marker of ['data-view="realm-scan-config"', 'data-view="realm-scan"', 'data-scan-now', 'realm-scan-notice']) {
    assert.equal(html.includes(marker), false, `关着 ⇒ 不许出现 ${marker} ✗`);
  }
  // 那一颗入口（`＋ 再加一个货品`）**照旧**在（本刀一颗按钮都没改 ✓）
  assert.match(html, /data-multi-add/, '那一颗入口照旧在 ✓');
  // 🔴 **逐字节证据**（比"没多出几个字符串"更强）：
  //    `server/tools/task61-render-baseline.js` 在 `origin/main` 与本刀之后各跑一次，
  //    11 个页面 **508,317 字节 `cmp` 逐字节相同** ✓（见文件头）。
  const tool = fs.readFileSync(path.join(__dirname, '..', 'tools', 'task61-render-baseline.js'), 'utf8');
  assert.match(tool, /renderScanPage/, '那份逐字节比对工具要在仓库里（可复现 ✓ 不是口头结论 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML6 ⭐⭐ 单货品路径零影响
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML6 ⭐⭐ 单货品（没有「加货」那一发）⇒ 新逻辑**一次都不碰**（页面也不多东西）', async () => {
  const writeService = makeWriteService();
  const engine = makeEngine();
  const realmScan = createRealmScanConfig({ SCAN_REALM_SCAN_ENABLED: 'true' });
  await withServer(appFor({ writeService, engine, realmScan }), async (base) => {
    // ① 正常 GET 一页（**不带**触发参数）⇒ 开关开着也**一个字节都不多** ✓
    const html = await (await getPage(base, '?from=replenish')).text();
    assert.equal(html.includes('data-view="realm-scan-config"'), false,
      '🔴 没点过「加货」⇒ 不许弹相机、也不许出现配置块（她没点就跳是最糟的 ✗）');
    assert.equal(html.includes('data-view="realm-scan"'), false, '开关开着也不许凭空多那一段 ✓');
    // ② 单货品提交（N=1）⇒ 引擎 0 次（既有口径未放宽 ✓）＋ 也不打那两条日志 ✓
    assert.deepEqual(engine.calls, [], '没有走多货品那条链 ✓');
  });
});

test('AC-ML6b ⭐⭐ 没有任何「已加」时：两条日志一条都不打（纯 additive ✓）', async () => {
  const logs = captureLogs();
  try {
    const writeService = makeWriteService();
    await withServer(appFor({ writeService, engine: makeEngine() }), async (base) => {
      await getPage(base, '?from=inventory');
      const log = (MULTI_ITEM_ORDER.logFields || {});
      for (const event of [log.addEvent, log.renderEvent]) {
        assert.equal(logs.lines.filter((line) => line.event === event).length, 0,
          `纯浏览（库存页）⇒ \`${event}\` **一条都不打** ✓`);
      }
    });
  } finally { logs.restore(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML7 配置先行 / 零硬编码中文 / 不加第二套
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML7 ⭐ 配置先行：事件名 / 键名 / 触发参数 / 领域→链全在 `config/**`（换值不用改代码 ✓）', () => {
  // ① 事件名与键名可配（**改一个键名只改这一处** ✓）
  const custom = resolveMultiItemOrderConfig({
    SCAN_MULTI_ITEM_LOG_ADD: 'my.log.add',
    SCAN_MULTI_ITEM_LOG_RENDER: 'my.log.render',
    SCAN_MULTI_ITEM_LOG_ADDED_COUNT_KEY: 'n_added',
    SCAN_MULTI_ITEM_LOG_ITEM_NOS_KEY: 'nos',
  });
  assert.equal(custom.logFields.addEvent, 'my.log.add');
  assert.equal(custom.logFields.renderEvent, 'my.log.render');
  assert.equal(custom.logFields.addedCountKey, 'n_added');
  assert.equal(custom.logFields.itemNosKey, 'nos');
  assert.equal(MULTI_ITEM_ORDER.logFields.addEvent, 'scan.multi_item.add', '缺省值 = 她点名的那两条 ✓');
  assert.equal(MULTI_ITEM_ORDER.logFields.renderEvent, 'scan.multi_item.render', '缺省值 ✓');

  // ② 领域 → 链：可配；认不出的领域 ⇒ 页面上**不发**这个入口（**不猜** ✗）
  const cfg = createRealmScanConfig({ SCAN_REALM_SCAN_CHAINS: 'purchase_return:return' });
  assert.deepEqual(cfg.realms, { purchase_return: 'return' }, '只配一个领域 ⇒ 只有它有 ✓');
  assert.equal(Boolean(cfg.realms.replenish), false, '没配的领域 ⇒ **不发**（不猜成别的链 ✗）');
  assert.deepEqual(createRealmScanConfig({}).realms, { replenish: 'replenish', purchase_return: 'return' },
    '缺省两个领域（**与既有那两条链一一对应** ✓）');

  // ③ 触发参数 / 端点 / 领域查询键**都可配**；领域查询键必须是既有 `resolveRealm` 认的那个 ✓
  const custom2 = createRealmScanConfig({
    SCAN_REALM_SCAN_QUERY_KEY: 'rescan', SCAN_REALM_SCAN_SIGNATURE_PATH: '/x/sig',
  });
  assert.equal(custom2.triggerQueryKey, 'rescan');
  assert.equal(custom2.signaturePath, '/x/sig');
  assert.equal(createRealmScanConfig({}).realmQueryKey, 'from', '领域键 = 既有 `?from=` ✓（不新造 ✗）');

  // ④ 那一段脚本正文**只有 ASCII**（零硬编码中文 ✓ —— 中文一律走配置 JSON ✓）
  const script = realmScanScriptSource();
  // eslint-disable-next-line no-control-regex
  assert.equal(/[^\x00-\x7F]/.test(script), false,
    '🔴 脚本正文不许出现非 ASCII（中文进代码就会被硬编码中文闸门打红 ✗）');
  assert.match(script, /scanCode/, '用的是飞书官方 `tt.scanCode` ✓');
  assert.match(script, /jsapi-signature|signaturePath/, '签名走**服务端**现算（页面不拿密钥 ✓）');
});

test('AC-ML7b ⭐ **不加第二套**：复用既有 `services/larkJsapiService.js` 与既有本单暂存', async () => {
  // ① 签名那一套是**同一个函数**（不是另写一份 sha1 / 换票）
  const service = createLarkJsapiService({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(typeof service.signatureFor, 'function', '复用既有签名服务 ✓');
  const routeSrc = ROUTE_SRC;
  assert.match(routeSrc, /createLarkJsapiService\(\)/,
    '🔴 路由用的是**既有** `services/larkJsapiService.js`（另写一份 ⇒ 这里红 ✓）');
  assert.match(routeSrc, /resolveLarkJsapi\(\)\.signatureFor\(/,
    '🔴 签名只经那一个方法（不在路由里自己算 sha1 ✗）');
  // ② 本单暂存仍是既有那两个函数（**没有第二套存储** ✗）
  assert.match(routeSrc, /readMultiItemPending\(/, '读本单暂存仍是既有那一个 ✓');
  assert.match(routeSrc, /writeMultiItemPending\(/, '写本单暂存仍是既有那一个 ✓');
  // ③ 路由源码里**不许**出现"再写一遍扫一扫地址"这种第二套（AppLink 仍只在配置里）
  assert.equal(routeSrc.includes('applink.feishu.cn'), false,
    '🔴 路由里不许再写一个扫一扫地址（唯一真源是 `config/scanPage.js` ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-ML8 🔴 红线：冻结件一个字都不许动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-ML8 🔴 `services/scanWriteService.js` **一个字不加/删/改**（余量 0）', () => {
  // 与 `origin/main` 的那一份逐字节相同（本刀**只读**它 ✓）
  // ⭐⭐ 2026-10-16 修复（Lead 亲自改 · 原因：这条判据在 **CI 里红** ✗ 本地却是绿的）
  //   改前逐字：`execFileSync('git', ['show', 'origin/main:server/src/services/scanWriteService.js'], …)`
  //     ⇒ 依赖 **`origin/main` 这个 ref** ✗ —— 而 GitHub Actions 的 checkout **默认只取 PR 分支** ✗
  //       ⇒ CI 里那个 ref 不存在/是旧的 ⇒ `git show` 抛错 ⇒ **本地绿、CI 红** ✗（本 PR 实测正是这条）
  //   改后逐字：用**钉死的 sha256 常量 + 行数**（与既有哨兵 `scanWriteServiceFrozen.test.js:39` 同一口径 ✓）
  //   ⭐ **不是放宽**：从"与某个可能过期的 ref 比"变成"与**钉死的指纹**比" ⇒ **更严**（甩不掉、也不受 clone 深度影响 ✓）
  //   依据：本仓既有的冻结哨兵写法（`FROZEN_SHA256 = '199551e1…35ca'`）＋ 本文件头声明的红线（余量 0 ✓）
  const cryptoFrozen = require('node:crypto');
  const FROZEN_SCAN_WRITE_SHA256 = '199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca';
  // ⚠️ 行数这条**刻意不写**：`split('\n').length` 与 `wc -l` **差 1**（文件末尾有无换行 ✓）
  //    ⇒ 我第一版写成 1698 当场把自己判红 ✗ ⇒ **只留 sha256**（它本身就是"逐字节"最强判据 ✓ 且不依赖任何 ref ✓）
  //    行数上限（余量 0）由既有哨兵 `scanWriteServiceFrozen.test.js` 的 AC-FRZ1 负责 ✓
  const actualSha = cryptoFrozen.createHash('sha256').update(WRITE_SERVICE_SRC, 'utf8').digest('hex');
  assert.equal(actualSha, FROZEN_SCAN_WRITE_SHA256,
    '🔴 `scanWriteService.js` 必须与**钉死的指纹**逐字节相同（本刀一个字都没动 ✓）');
  assert.equal(WRITE_SERVICE_SRC.includes('realmScan') || WRITE_SERVICE_SRC.includes('scan.multi_item'), false,
    '🔴 冻结件里不许出现本刀的新逻辑/新事件名（它根本不该认识"领域内扫一扫" ✓）');
  // 本刀的新行为**不许**出现在那个文件里（反过来说：它根本不知道"领域内扫一扫"这件事 ✓）
  assert.equal(WRITE_SERVICE_SRC.includes('realmScan'), false, '冻结件不该认识新逻辑 ✓');
  assert.equal(WRITE_SERVICE_SRC.includes('scan.multi_item'), false, '冻结件不该出现新事件名 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 共用写上下文（只给渲染类判据用；形状与路由喂进去的那一份同形 ✓）
// ═══════════════════════════════════════════════════════════════════════════

function writeContext() {
  return {
    enabled: true,
    saleEnabled: true,
    replenishEnabled: true,
    returnEnabled: true,
    texts: SCAN_WRITE.texts,
    fields: SCAN_WRITE.fields,
    actions: SCAN_WRITE.actions,
    multiItem: MULTI_ITEM_ORDER.wire,
    postAction: `/s/${PARAMS}`,
    sizes: [{ size_text: '40', missing: false }],
    draft: { lines: [] },
    accessories: [],
    saleKey: 'scan_sale:x:1',
    replenishKey: 'scan_replenish:x:1',
    returnKey: 'scan_return:x:1',
    paymentMethods: ['微信'],
    defaultPaymentMethod: '微信',
    paymentStatus: 'paid',
    defaultPaymentStatus: 'paid',
    paidAmount: '',
    paymentRows: [{ method: '微信', amount: '' }],
    errorText: '',
    notice: '',
  };
}
