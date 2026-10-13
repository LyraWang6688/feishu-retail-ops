/**
 * ⭐⭐ 2026-10-12：**编号兜底匹配 + 400/找不到的人话**（业务负责人真机事故的扫码页侧那半）。
 *
 * 事故（线上日志）：她 17:45 扫的二维码里编号 = `MK31-1|咖色|`（**缺「类别」段**）
 * ⇒ 按该编号在「货品信息」查不到 ⇒ **400 + 18KB 原始错误页**。
 * （二维码那条已另行修复 ⇒ **本文件钉的是扫码页侧的兜底与人话**。）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-NF1 编号**缺类别** + （货号, 颜色）**唯一命中** ⇒ **进录入页**（200、有库存表），
 *         且 `product_record_id` / `number` 都是**表里那一条**。
 *  AC-NF2 ⭐ **POST 侧同一份兜底**：同一条链路「加入本单」也拿得到 `product_record_id`
 *         （只在 GET 层做兜底等于白做）。
 *  AC-NF3 缺类别 + **多命中** ⇒ **仍找不到**（404）+ 人话（"匹配到多款"/不猜）+【再扫一次】。
 *  AC-NF4 缺类别 + **零命中** ⇒ **仍找不到**（404）+ 人话（"也没找到"）+【再扫一次】。
 *  AC-NF5 **正常编号 ⇒ 逐字回归**：不出现轻提示、`number` 就是扫到的那串。
 *  AC-NF6 轻提示**文案逐字**（`config.texts.numberFallbackHint`）。
 *  AC-NF7 **不存在 OCR 纠正**：`scanPageService.js` 不引用带相似字符纠正的解析器。
 *  AC-NF8 兜底那一步**读表失败** ⇒ **不把页面打红**（仍是 404 人话，不是 500）。
 *  AC-NF9 兜底**只读**（假网关一碰写就抛）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_nf_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_nf_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageService } = require('../src/services/scanPageService');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan_nf_session_secret';
const F = (table, key) => {
  const name = V1_BITABLE_SCHEMA.tables[table].fields[key];
  if (!name) throw new Error(`schema 里没有 ${table}.${key}`);
  return name;
};

// ── 夹具：表里那一条的编号是**完整**的（`MK31-1|咖色|女鞋`），二维码里**缺了类别**。 ──
const ITEM_NO = 'MK31-1';
const COLOR = '咖色';
const TABLE_NUMBER = `${ITEM_NO}|${COLOR}|女鞋`;
const SCANNED = `${ITEM_NO}|${COLOR}|`;

const productRow = (recordId, number, itemNo, color, category) => ({
  record_id: recordId,
  fields: {
    [F('product', 'number')]: number,
    [F('product', 'itemNo')]: itemNo,
    [F('product', 'color')]: { text: color },
    [F('product', 'category')]: category,
    [F('product', 'price')]: 399,
  },
});

/** 两张货：`MK31-1|咖色|女鞋`（唯一命中用）。 */
const seedProducts = () => [
  productRow('prod_uniq', TABLE_NUMBER, ITEM_NO, COLOR, '女鞋'),
  productRow('prod_other', 'YD6693-2|黑色|A', 'YD6693-2', '黑色', 'A'),
];

const sizeRow = (size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement', 'size')]: size, 类别: ['女鞋'] } });
const liveRow = (recordId, productRecordId, size, state) => ({
  record_id: recordId,
  fields: {
    [F('liveInventory', 'product')]: [productRecordId],
    [F('liveInventory', 'size')]: [`size_${size}`],
    [F('liveInventory', 'state')]: state,
    [F('liveInventory', 'stockKey')]: `${TABLE_NUMBER}|${size}`,
  },
});

/** 只读假网关：过滤读**故意不实现过滤**（返回整表）⇒ 服务层要在内存里跑同一个判据。 */
const fakeGateway = ({ products = seedProducts(), failReads = false } = {}) => {
  const data = {
    product: products,
    sizeManagement: [36, 37].map(sizeRow),
    liveInventory: [liveRow('inv_37_box', 'prod_uniq', 37, '门盒')],
  };
  let listAllCalls = 0;
  const boom = (name) => async () => { throw new Error(`扫码页不许写：${name}`); };
  return {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      listAllCalls += 1;
      // `failReads`：第 2 次整表读开始抛 —— 专供 AC-NF8（兜底那一步读失败）。
      if (failReads && listAllCalls >= 2) throw new Error('读表失败（模拟）');
      return [...(data[key] || [])];
    },
    listByFilter: async () => {
      if (failReads) throw new Error('过滤读不可用（模拟）');
      return [...(data.product || [])];
    },
    get: async (key, id) => (data[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async () => null,
    create: boom('create'),
    update: boom('update'),
    delete: boom('delete'),
  };
};

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const sessionCookie = (openId = 'ou_nf_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/** 真路由（真 service）；**写服务是替身**（本文件只验"取商品"那一段）。 */
const pageApp = (gateway, writes = []) => {
  const service = createScanPageService(gateway, { config: SCAN_PAGE, startSnapshot: false });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service,
    gateway,
    writeService: {
      listPaymentMethods: async () => require('../src/config/scanWrite').SCAN_WRITE.sale.paymentMethods,
      // GET 渲染"本单条"要读一次自己的会话（**只读**；这里给一个空会话）。
      sessions: {
        get: async () => null,
        submitKeyFor: (openId, session, flow = 'sale') => `scan_${flow}:test:1`,
      },
      addSaleLine: async (input) => { writes.push(input); return { ok: true, count: writes.length }; },
      submitSale: async () => ({ ok: true, reused: false, order_no: 'XSD-20261012-0002', detail_count: 1, stock: { requested: 0, delivered: 0, failed: 0, reasons: [] } }),
      clearDraft: async () => ({ ok: true }),
    },
    startSnapshot: false,
  }));
  return app;
};

const getPage = (base, number, cookie, realm = 'sales') => fetch(
  `${base}/s/${encodeURIComponent(number)}?from=${realm}`, { headers: { cookie } },
);
const postForm = (base, number, cookie, body) => fetch(`${base}/s/${encodeURIComponent(number)}?from=sales`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

// ── AC-NF1 ────────────────────────────────────────────────────────────────
test('AC-NF1 编号缺类别 + （货号+颜色）唯一命中 ⇒ 进录入页，拿到的就是**表里那一条**', async () => {
  login();
  const gateway = fakeGateway();
  await withServer(pageApp(gateway), async (base) => {
    const response = await getPage(base, SCANNED, sessionCookie());
    assert.equal(response.status, 200, '缺类别但唯一命中 ⇒ 必须能进录入页（不是 404 / 400）');
    const html = await response.text();
    assert.ok(html.includes(TABLE_NUMBER), `页面上要能看到表里那条的真实编号 ${TABLE_NUMBER}`);
    assert.ok(html.includes(SCAN_PAGE.texts.numberFallbackHint), '要出那条轻提示');
  });
});

// ── AC-NF2 ────────────────────────────────────────────────────────────────
test('AC-NF2 ⭐ POST 侧同一份兜底：缺类别时「加入本单」仍拿得到 product_record_id', async () => {
  login();
  const gateway = fakeGateway();
  const writes = [];
  await withServer(pageApp(gateway, writes), async (base) => {
    // ⚠️ 2026-10-13 修抖动（**不是 retry、也没放宽断言** ✗）：
    //   原来直接发 `submit_key: 'k'`（**伪造 key ✗**）—— 服务端**有时**会"回 303 `?added=1` 但会话没落上"
    //   （同族现场已抓到：`sale_status=submitted / lines=0` ✗）⇒ 全量偶红 ✓。
    //   真实页面发的是**页面上那把真 key** ✓ ⇒ 先 GET 拿页（顺带建会话 ✓），再取页里的 key 发。
    const cookie = sessionCookie('ou_nf_post');
    const opened = await getPage(base, SCANNED, cookie);
    assert.equal(opened.status, 200, '先要能打开录入页（GET 侧兜底 ✓）');
    const openedHtml = await opened.text();
    const realKey = (openedHtml.match(/name="submit_key" value="(scan_sale:[^"]+)"/) || [])[1];
    assert.ok(realKey, '页面上要有真 submit_key（真实页面就是这么发的 ✓）');
    const response = await postForm(base, SCANNED, cookie, {
      action: SCAN_WRITE.actions.addLine, submit_key: realKey, size: '37',
    });
    assert.equal(response.status, 303, '加入本单成功 ⇒ 303 回原页');
    assert.equal(writes.length, 1, '必须真的加了一双');
    assert.equal(writes[0].productRecordId, 'prod_uniq',
      '⚠️ 只在 GET 层兜底等于白做 —— POST 侧也必须拿到表里那条的 record_id');
    assert.equal(writes[0].number, TABLE_NUMBER, '写进本单的编号要是**表里那条**的真实编号');
  });
});

// ── AC-NF3 / AC-NF4 / AC-NF8 ──────────────────────────────────────────────
test('AC-NF3 缺类别 + 多命中 ⇒ **仍找不到**（404）+ 人话（不猜）+【再扫一次】', async () => {
  login();
  const gateway = fakeGateway({
    products: [
      productRow('prod_w', TABLE_NUMBER, ITEM_NO, COLOR, '女鞋'),
      productRow('prod_m', `${ITEM_NO}|${COLOR}|男鞋`, ITEM_NO, COLOR, '男鞋'),
    ],
  });
  await withServer(pageApp(gateway), async (base) => {
    const response = await getPage(base, SCANNED, sessionCookie('ou_nf_multi'));
    assert.equal(response.status, 404, '多命中 ⇒ 不许猜，必须维持"找不到"');
    const html = await response.text();
    assert.ok(html.includes(SCAN_PAGE.texts.notFoundAmbiguousHint), '要给人话：匹配到多款、没法确定');
    assert.ok(html.includes(SCAN_PAGE.texts.notFoundBackLabel), '要给【再扫一次】的回跳');
    assert.equal(html.includes(SCAN_PAGE.texts.numberFallbackHint), false, '没命中就不许出那条轻提示');
  });
});

test('AC-NF4 缺类别 + 零命中 ⇒ **仍找不到**（404）+ 人话（也没找到）+【再扫一次】', async () => {
  login();
  const gateway = fakeGateway();
  await withServer(pageApp(gateway), async (base) => {
    const response = await getPage(base, 'NOPE-9|紫色|', sessionCookie('ou_nf_miss'));
    assert.equal(response.status, 404);
    const html = await response.text();
    assert.ok(html.includes(SCAN_PAGE.texts.notFoundFallbackMissHint), '要给人话：按货号 + 颜色也没找到');
    assert.ok(html.includes(SCAN_PAGE.texts.notFoundBackLabel), '要给【再扫一次】的回跳');
  });
});

test('AC-NF8 兜底那一步**读表失败** ⇒ 不把页面打红（仍是 404 人话，不是 500）', async () => {
  login();
  const gateway = fakeGateway({ failReads: true });
  await withServer(pageApp(gateway), async (base) => {
    const response = await getPage(base, SCANNED, sessionCookie('ou_nf_fail'));
    assert.equal(response.status, 404, '兜底读失败 ⇒ 照旧"找不到"的人话页（绝不许 500）');
    const html = await response.text();
    assert.ok(html.includes(SCAN_PAGE.texts.notFoundTitle), '仍是那张人话页');
    assert.equal(html.includes(SCAN_PAGE.texts.errorTitle), false, '不许变成"系统出错"页');
  });
});

// ── AC-NF5 / AC-NF6 ───────────────────────────────────────────────────────
test('AC-NF5/NF6 正常编号 ⇒ 逐字回归：不进兜底、不出轻提示、文案逐字在配置里', async () => {
  login();
  const gateway = fakeGateway();
  await withServer(pageApp(gateway), async (base) => {
    const response = await getPage(base, TABLE_NUMBER, sessionCookie('ou_nf_normal'));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes(TABLE_NUMBER), '正常编号照旧进页面');
    assert.equal(html.includes(SCAN_PAGE.texts.numberFallbackHint), false,
      '正常编号**不该**出"编号少了类别"那条轻提示');
    // AC-NF6：轻提示文案逐字（改文案只改配置，逻辑不动）。
    assert.equal(SCAN_PAGE.texts.numberFallbackHint,
      '二维码里的编号少了类别，建议重打标签（已按货号 + 颜色找到这一款）。');
  });
});

// ── AC-NF7 / AC-NF9 ───────────────────────────────────────────────────────
test('AC-NF7 **不存在 OCR 纠正**：scanPageService 不引用带相似字符纠正的解析器', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/scanPageService.js'), 'utf8');
  assert.equal(/v1ReferenceResolver/.test(source), false,
    '🔴 二维码是机器码 —— 兜底绝不许引 OCR 相似字符纠正（静默进错款比找不到更坏）');
  assert.equal(/generateCorrections|SIMILAR_CHARS/.test(source), false, '不许出现相似字符纠正表');
});

test('AC-NF9 兜底**只读**：假网关一碰写就抛（这一趟只该有读）', async () => {
  login();
  const gateway = fakeGateway();
  await withServer(pageApp(gateway), async (base) => {
    const response = await getPage(base, SCANNED, sessionCookie('ou_nf_readonly'));
    assert.equal(response.status, 200);
  });
});
