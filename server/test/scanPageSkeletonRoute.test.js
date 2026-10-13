'use strict';

/**
 * ⭐ 2026-10-13 骨架屏**上线开关**的验收标准（方案 A：默认关 ⇒ 默认路径一字不变 ✓）。
 *
 * 为什么要开关：`/s/<编号>` 原来是**同步整页**，一批既有 AC 直接断言那一页的 HTML ⇒
 * 一旦默认改成"先回骨架 + 前端填充"，它们全红 ✗。所以：
 *   · **默认关**（`SCAN_PAGE_SKELETON_ENABLED` 缺省 false）⇒ 与改动前**逐字相同** ✓（不假绿）
 *   · **打开** ⇒ 首屏立刻回骨架（不读表）+ 同一段脚本 `fetch('?data=1')` 拿数据
 *   · `?data=1` **落到原有的整页渲染**（同一个 `service.lookup` ✓ 不新增取数路径 ✓）
 * AC：AC-R1 关 = 整页（无骨架痕迹）· AC-R2 开 = 首屏骨架（居中卡片 + 数据加载中、**不含**数据）
 *     · AC-R3 `?data=1` = 与整页一致（数据等价）· AC-R4 `GET /`（新首页）不受骨架影响
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_skel_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'skel_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'skel_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');

const NUMBER = 'YD6693-2|黑色|A';
const cookieOf = () => {
  const payload = Buffer.from(JSON.stringify({
    open_id: 'ou_skel', name: '测试', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', 'skel_session_secret').update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const fakeGateway = () => ({
  table: (key) => require('../src/config/v1BitableSchema').V1_BITABLE_SCHEMA.tables[key],
  listAll: async () => [], listByFilter: async () => [],
  create: async () => { throw new Error('扫码页不许写'); },
  update: async () => { throw new Error('扫码页不许写'); },
  delete: async () => { throw new Error('扫码页不许写'); },
});
// ⚠️ `SCAN_PAGE` 是**冻结**的（配置不给运行时改 ✗）⇒ 开关用它的一份**浅拷贝**：`{ ...SCAN_PAGE, skeleton }`
const configWith = (enabled) => ({ ...SCAN_PAGE, skeleton: { enabled } });
const withServer = async (config, run) => {
  const app = express();
  app.use((req, res, next) => { req.requestId = 'req_skel'; next(); });
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({ gateway: fakeGateway(), config, startSnapshot: false }));
  const server = await new Promise((resolve) => { const instance = app.listen(0, () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const get = async (base, pathname) => (await fetch(`${base}${pathname}`, { headers: { cookie: cookieOf() } })).text();


test('AC-R1 开关**关** ⇒ `/s/<编号>` 还是整页（不带任何骨架痕迹）', async () => {
  await withServer(configWith(false), async (base) => {
    const html = await get(base, `/s/${encodeURIComponent(NUMBER)}`);
    assert.equal(html.includes('scan-skeleton'), false, '关着就不该出现骨架');
    // 2026-10-14 改指向（她：骨架改成居中卡片「数据加载中」）：**开关关**时仍是整页 ⇒
    //   页面里不许出现骨架那句主文案（能力不变 ✓ 不是放宽 ✗）。
    //   改前逐字：assert.equal(html.includes('正在读取…'), false);
    assert.equal(html.includes('数据加载中'), false);
    assert.match(html, /^<!doctype html>/, '还是整页');
  });
});

test('AC-R2 开关**开** ⇒ 首屏就是骨架（居中卡片 + 数据加载中、**不含**数据卡片）', async () => {
  await withServer(configWith(true), async (base) => {
    const html = await get(base, `/s/${encodeURIComponent(NUMBER)}`);
    assert.match(html, /data-view="scan-skeleton"/, '首屏是骨架');
    // ⚠️ 2026-10-14 改指向（她：「显示：数据加载中」✓）—— 改前逐字：`assert.match(html, /数据加载中/)`
  assert.match(html, /数据加载中/, '要有那句主文案（不许空白 ✗）');
  assert.equal(/正在读取/.test(html), false, '「正在读取」不许再出现 ✓');
    assert.match(html, /尺码/, '尺码区占位');
    assert.equal((html.match(/<script/g) || []).length, 1, '整页只有一段脚本');
    assert.equal(html.includes('data-view="draft-bar"'), false, '首屏**不该**含数据卡片（那正是它慢的原因）');
  });
});

test('AC-R3 `?data=1` ⇒ 落到原有的整页渲染（走同一个 lookup ✓ 数据等价）', async () => {
  await withServer(configWith(true), async (base) => {
    const viaData = await get(base, `/s/${encodeURIComponent(NUMBER)}?data=1`);
    assert.match(viaData, /^<!doctype html>/, '拿回来的是整页 HTML（骨架那段脚本会整页替换）');
    assert.equal(viaData.includes('data-view="scan-skeleton"'), false, '数据那一趟不该再是骨架');
    // 关掉开关那一版要**另起一个 app**（配置冻结 ⇒ 不能在同一个 app 里改）
    const off = await new Promise((resolve, reject) => {
      withServer(configWith(false), async (baseOff) => {
        try { resolve(await get(baseOff, `/s/${encodeURIComponent(NUMBER)}`)); } catch (error) { reject(error); }
      }).catch(reject);
    });
    // 数据等价（逐字比较时把请求号这类易变片段抹掉）
    const strip = (html) => html.replace(/req_skel/g, 'REQ');
    assert.equal(strip(viaData), strip(off), '开关开与关，`?data=1` 拿到的数据必须逐字一致');
  });
});

test('AC-R4 `GET /`（不带编号的新首页）不受骨架影响（回归）', async () => {
  await withServer(configWith(true), async (base) => {
    const home = await get(base, '/');
    assert.equal(home.includes('data-view="scan-skeleton"'), false, '新首页不许被骨架顶掉');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ AC-R5「真配置」哨兵（**先红后绿**；这条是上一版假绿的补丁）
//
// 上一版我把开关插进了**子配置对象**里 ⇒ `SCAN_PAGE.skeleton` 是 `undefined` ⇒
// 真进程里开关**根本没生效**（而我那 4 条 AC 用**自造配置浅拷贝** ⇒ 全绿 ⇒ **假绿** ✗）。
// ⇒ 这条**读真实模块导出**、并**用子进程真的设一遍 env**：env 关 ⇒ false；env 开 ⇒ true ✓
// ═══════════════════════════════════════════════════════════════════════════
test('AC-R5 真配置哨兵：`SCAN_PAGE.skeleton.enabled` 真的导出，且随 env 变（显式布尔）', () => {
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const read = (env) => {
    const out = execFileSync(process.execPath, ['-e',
      "process.env.SCAN_PAGE_SKELETON_ENABLED=" + (env === undefined ? "''" : JSON.stringify(env))
      + ";const {SCAN_PAGE}=require('./src/config/scanPage');"
      + "process.stdout.write(JSON.stringify(SCAN_PAGE.skeleton||null))",
    ], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    return JSON.parse(out);
  };
  // ⚠️ 2026-10-14：`skeleton` 多了 `firstEntryOnly`（骨架只服务"首次进入" ✓ 六格切换不出中间态 ✗）
  assert.deepEqual(read(undefined), { enabled: false, firstEntryOnly: true },
    '缺省：开关关 + 只首次进入 ✓（显式布尔 ✓）');
  assert.deepEqual(read('true'), { enabled: true, firstEntryOnly: true },
    '打开开关必须真的读到 true（不是 undefined ✗）');
  assert.deepEqual(read('false'), { enabled: false, firstEntryOnly: true });
  // 真的导出了吗（不是"在某个子对象里"）
  assert.ok(Object.prototype.hasOwnProperty.call(SCAN_PAGE, 'skeleton'), 'SCAN_PAGE 顶层必须有 skeleton');
});
