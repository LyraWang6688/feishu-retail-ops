'use strict';

/**
 * ⭐ 骨架屏验收标准（2026-11-26 起：**没有开关，固定开启**）。
 *
 * 业务负责人 2026-11-26：「为什么这个还要开关呢，不需要这个开关」＋ 选 A：
 *   · 删掉 SCAN_PAGE_SKELETON_ENABLED / SCAN_PAGE_SKELETON_FIRST_ENTRY_ONLY 与代码里的开关判断；
 *   · 骨架**永远走**；仍只服务"首次进入"（不带 ?from=），点领域直接出整页。
 *
 * AC：AC-R1 裸扫首屏 = 骨架（居中卡片 + 数据加载中、**不含**数据）
 *     · AC-R2 带 ?from= 的首屏 = 整页（不出中间态）
 *     · AC-R3 ?data=1 = 原有的整页渲染（同一个 lookup）
 *     · AC-R4 GET /（新首页）不受骨架影响
 *     · AC-R5 反向哨兵：配置里**不许**再有 enabled / env 开关
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_skel_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'skel_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'skel_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');

const NUMBER = 'YD6693-2|黑色|男';
const RECORD_ID = 'prod_1';
const PRODUCT = { record_id: RECORD_ID, fields: { 编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色' }, 类别: '男', 品类: { text: '休闲鞋' }, 单价: 399 } };
const cookieOf = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: 'ou_skel', name: '测试', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', 'skel_session_secret').update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const fakeGateway = () => ({
  table: (key) => require('../src/config/v1BitableSchema').V1_BITABLE_SCHEMA.tables[key],
  get: async (key, id) => (key === 'product' && id === RECORD_ID ? PRODUCT : null),
  listAll: async (key) => (key === 'product' ? [PRODUCT] : []), listByFilter: async () => [],
  create: async () => { throw new Error('扫码页不许写'); },
  update: async () => { throw new Error('扫码页不许写'); },
  delete: async () => { throw new Error('扫码页不许写'); },
});
// ⚠️ SCAN_PAGE 是冻结的 ⇒ 用浅拷贝只覆盖 skeleton（测试"首次进入"这一个条件）
const configWith = (firstEntryOnly = true) => ({ ...SCAN_PAGE, skeleton: { firstEntryOnly } });
const withServer = async (config, run) => {
  const app = express();
  app.use((req, res, next) => { req.requestId = 'req_skel'; next(); });
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({ gateway: fakeGateway(), config, startSnapshot: false }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = async (base, pathname) => (await fetch(`${base}${pathname}`, { headers: { cookie: cookieOf() } })).text();

test('AC-R1 裸扫（不带 ?from=）首屏就是骨架：居中卡片 + 数据加载中、不含数据卡片', async () => {
  await withServer(configWith(), async (base) => {
    const html = await get(base, `/r/${RECORD_ID}`);
    assert.match(html, /data-view="scan-skeleton"/, '首屏是骨架');
    assert.match(html, /数据加载中/, '要有那句主文案（不许空白 ✗）');
    assert.equal(/正在读取/.test(html), false, '「正在读取」不许再出现 ✓');
    assert.match(html, /尺码/, '尺码区占位');
    assert.equal((html.match(/<script/g) || []).length, 1, '整页只有一段脚本');
    assert.equal(html.includes('data-view="draft-bar"'), false, '首屏**不该**含数据卡片（那正是它慢的原因）');
  });
});

test('AC-R2 带 ?from= 的首屏直接是整页（"首次进入才骨架" ✓ 点领域不出中间态）', async () => {
  await withServer(configWith(), async (base) => {
    const html = await get(base, `/r/${RECORD_ID}?from=inventory`);
    assert.match(html, /^<!doctype html>/, '整页');
    assert.equal(html.includes('data-view="scan-skeleton"'), false, '带 from 不许再出骨架');
    assert.match(html, /realm-block--inventory/, '直接给库存那一块');
    assert.ok(html.includes(NUMBER), '数据已经渲染（编号在页面上）');
  });
});

test('AC-R3 ?data=1 ⇒ 落到原有的整页渲染（走同一个 lookup ✓ 数据等价）', async () => {
  await withServer(configWith(), async (base) => {
    const viaData = await get(base, `/r/${RECORD_ID}?data=1`);
    assert.match(viaData, /^<!doctype html>/, '拿回来的是整页 HTML（骨架那段脚本会整页替换）');
    assert.equal(viaData.includes('data-view="scan-skeleton"'), false, '数据那一趟不该再是骨架');
    assert.match(viaData, /realm-block--inventory/, '库存那一块已经渲染出来');
    assert.ok(viaData.includes(NUMBER), '编号已经渲染出来');
    // 同一个 realm（库存）走"带 from"的整页 ⇒ 除请求号外应逐字一致
    const direct = await get(base, `/r/${RECORD_ID}?from=inventory`);
    const strip = (html) => html.replace(/req_skel/g, 'REQ');
    assert.equal(strip(viaData), strip(direct), '?data=1 与"直接整页"数据必须逐字一致');
  });
});

test('AC-R4 GET /（不带编号的新首页）不受骨架影响（回归）', async () => {
  await withServer(configWith(), async (base) => {
    const home = await get(base, '/');
    assert.equal(home.includes('data-view="scan-skeleton"'), false, '新首页不许被骨架顶掉');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R5 反向哨兵：开关已删除（她：「不需要这个开关」）
//   塞回 SCAN_PAGE_SKELETON_ENABLED / skeleton.enabled ⇒ 红 ✓
// ═══════════════════════════════════════════════════════════════════════════
test('AC-R5 配置里不再有开关：skeleton 只有 firstEntryOnly，env 不再影响它', () => {
  const { execFileSync } = require('node:child_process');
  const read = (env) => {
    const out = execFileSync(process.execPath, ['-e',
      'process.env.SCAN_PAGE_SKELETON_ENABLED=' + (env === undefined ? "''" : JSON.stringify(env))
      + ";const {SCAN_PAGE}=require('./src/config/scanPage');"
      + 'process.stdout.write(JSON.stringify(SCAN_PAGE.skeleton||null))',
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    return JSON.parse(out);
  };
  assert.deepEqual(read(undefined), { firstEntryOnly: true }, '缺省 = 固定开启 + 只首次进入');
  assert.deepEqual(read('true'), { firstEntryOnly: true }, 'env 不再改变配置（开关已删）');
  assert.deepEqual(read('false'), { firstEntryOnly: true }, 'env=false 也不许把骨架关掉 ✓');
  assert.equal(Object.prototype.hasOwnProperty.call(SCAN_PAGE.skeleton, 'enabled'), false,
    'skeleton.enabled 必须不存在（塞回即红）');
  assert.equal(JSON.stringify(SCAN_PAGE).includes('SCAN_PAGE_SKELETON'), false,
    '配置里不许再出现这个开关名');
  // 路由里也不许再读开关（只保留 data=1 / firstEntryOnly 两条条件）
  const pages = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'scanPage', 'pages.js'), 'utf8');
  assert.equal(/skeleton\?\.enabled/.test(pages), false, '路由不许再判断 skeleton.enabled');
});
