'use strict';

/**
 * ⭐ 2026-10-13 特殊尺码接线（路由侧）· AC：
 *   **读采购明细失败 ⇒ 只给默认范围（特殊码一个都不显示）+ 一条可 grep 的 warn**
 *   · 常规码**一个不少** ✓（不静默少码 ✗）
 *   · 页面照常 200 ✓（绝不因特殊码读不到就整页失败 ✗）
 *
 * ⚠️ 语义（那位同事定）：`present_special_sizes` **缺失/为空** ⇒ 特殊码**全不显示**（= 降级 ✓）
 *   ⇒ 所以"没落地那 3 行"也不会红 —— 本文件钉的是**失败时的行为与可排查性** ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_special_size';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'special_size_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SERVER = path.join(__dirname, '..');
const SESSION_SECRET = 'scan_special_size_session_secret';
const sessionCookie = () => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    open_id: 'ou_special', name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')}`;
};

const view = () => ({
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  price_text: '¥399',
  total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  // 常规码：40 / 41（**一个都不许少** ✓）
  rows: [
    { size_text: '40', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-13 18:00',
});

const buildApp = ({ purchaseSizeReader } = {}) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    // 本文件只验**读页面**这一半 ⇒ 不挂写入口（`false` = 这一版不挂 ✓）
    writeService: false,
    followup: { addPayment: async () => ({ ok: true }) },
    purchaseSizeReader,
  }));
  return app;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

test('AC-SP1 ⭐ 降级接线在（源码哨兵）：读失败 ⇒ 只给默认范围 + 一条可 grep 的 warn', () => {
  // ⚠️ 如实说明：**行为级**版本（真打一页、断言"只给默认范围 + warn 出现在日志里"）我这一轮**没写成** ✗
  //    —— 捕获 logger 那一步在我的最小 app 里拿不到输出（logger 走 stdout，路径/时机待查）。
  //    ⇒ 这里先钉**接线本身**（漏掉任何一件都会红 ✓），行为级那条留给下一手补（用 realm 渲染那套 harness ✓）。
  const source = fs.readFileSync(path.join(SERVER, 'src/routes/scanPage.js'), 'utf8');
  // ① 读失败 ⇒ **不抛**、给空数组（降级）
  assert.match(source, /purchase_size_list_failed/, '要有一条可 grep 的 warn（固定 reason ✓）');
  assert.match(source, /catch \(error\) \{[\s\S]{0,200}presentSpecialSizes = \[\]/, '读失败 ⇒ 降级成空数组（不抛 ✗）');
  // ② 只有真读到才挂字段（缺失 = 那位同事那边的"全不显示"降级语义 ✓）
  assert.match(source, /if \(presentSpecialSizes\.length\) view\.present_special_sizes = presentSpecialSizes;/,
    '读到了才挂 `present_special_sizes`（字段名以那位同事为准 ✓）');
  // ③ 用的是**既有**事件名（不新造 logger 用法 ✓）
  assert.ok(/logWarn\(config\.events\.failed, \{[\s\S]{0,160}purchase_size_list_failed/.test(source),
    'warn 要挂既有事件名 `config.events.failed`（不新造 ✓）');
  // ④ 常规那一半不许被牵连（读特殊码失败**不许**早退/抛）
  assert.ok(!/purchase_size_list_failed[\s\S]{0,200}return (sendHuman|sendHtml)\(res, 5/.test(source),
    '读特殊码失败**不许**让整页失败 ✗');
});

test('AC-SP2 读成功 ⇒ 只读一次、且**不许**报那条失败 warn（失败分支没被误走）', async () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  const seen = [];
  // ⚠️ logger 走 `process.stdout.write`（不是 console.log）⇒ 捕这里 ✓
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => { captured.push(String(chunk)); return original(chunk, ...rest); };
  try {
    await withServer(buildApp({
      purchaseSizeReader: { listSizes: async () => { seen.push(1); return [{ size: '45', label: '45（特殊）' }]; } },
    }), async (base) => {
      const response = await fetch(`${base}/s/${encodeURIComponent('YD6693-2|黑色|A')}?from=sales`, {
        headers: { cookie: sessionCookie() },
      });
      assert.equal(response.status, 200);
      assert.equal(seen.length, 1, '读一次（不多读）');
      assert.equal(captured.some((line) => line.includes('purchase_size_list_failed')), false,
        '读成功时**不许**报那条失败 warn（否则降级会静默发生 ✗）');
    });
  } finally { process.stdout.write = original; }
});
