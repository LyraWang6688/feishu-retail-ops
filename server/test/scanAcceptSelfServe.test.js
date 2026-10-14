'use strict';

/**
 * ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「/s/accept 这条路要彻底拆掉」
 *
 * 本文件原测「无 batch 的自助落地页（列未到货批次 / 手输批次号 / 进验收模式）」那一屏。
 * 那一屏**已退场** ⇒ 按老口径**改指向**：**逐条保留 AC 名** ✓
 * 断言 = 「**入口没了**（源码哨兵，能真红）＋ **能力仍在**（工作台那条路 + 既有验收会话服务）」✓
 * 能力现在在哪：工作台 `GET /api/workbench/purchase/arrivals/detail` · `POST .../purchase/arrivals/accept`（#534 ✓）
 *   ＋ `services/scanArrivalService.js`（start / addScan / finish ✓）＋ `InventoryService.applyPurchase` ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/scanPage.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
const CONFIG = fs.readFileSync(path.join(__dirname, '../src/config/scanPage.js'), 'utf8');
const ARRIVAL = fs.readFileSync(path.join(__dirname, '../src/services/scanArrivalService.js'), 'utf8');
const WB_ROUTES = fs.readFileSync(path.join(__dirname, '../src/routes/workbench.js'), 'utf8');

const SCREEN_GONE = () => {
  assert.equal(RENDERER.includes('renderAcceptanceSelfServe'), false, '无 batch 的自助落地页渲染函数已退场');
  assert.equal(RENDERER.includes('accept-pending'), false, '未到货批次那一块已退场');
  assert.equal(RENDERER.includes('accept-manual'), false, '手输批次号兜底已退场');
  assert.equal(ROUTES.includes("router.get('/accept'"), false, 'GET /accept 路由已退场');
  assert.equal(ROUTES.includes("router.post('/accept'"), false, 'POST /accept 路由已退场');
};
const ABILITY_KEPT = () => {
  assert.match(WB_ROUTES, /purchase\/arrivals\/detail/, '工作台只读明细在');
  assert.match(WB_ROUTES, /purchase\/arrivals\/accept/, '工作台完成验收在');
  assert.match(ARRIVAL, /start/, '既有验收会话服务仍在（start）');
  assert.match(ARRIVAL, /addScan/, '既有会话仍能加行（addScan）');
  assert.match(ARRIVAL, /finish/, '既有会话仍能完成（finish）');
  assert.match(ARRIVAL, /applyPurchase/, '加库存仍走既有服务（绝不直连表）');
};

test('AC-AS1 自助落地页（列未到货批次）⇒ 改钉「入口没了 ＋ 能力仍在工作台那条路」', () => {
  SCREEN_GONE();
  assert.equal(RENDERER.includes('/s/accept?batch='), false, '那条进验收的链接已退场');
  ABILITY_KEPT();
});
test('AC-AS2 一个未到货都没有 ⇒ 人话 + 手输兜底 ⇒ 随屏退场（服务侧人话仍在）', () => {
  SCREEN_GONE();
  assert.match(ARRIVAL, /no_request_rows|acceptRowsUnreadableBody/, '服务端"读不到/没有明细"仍给人话');
});
test('AC-AS3 点一条未到货批次 ⇒ 进验收模式 ⇒ 改钉「工作台那条完成验收」', () => {
  SCREEN_GONE();
  assert.match(WB_ROUTES, /purchase\/arrivals\/accept/, '工作台那条（进验收 ⇒ 完成）在');
});
test('AC-AS4 手输批次号 ⇒ 同样进验收 ⇒ 改钉「工作台按批次读明细」', () => {
  SCREEN_GONE();
  assert.match(WB_ROUTES, /purchase\/arrivals\/detail/, '工作台按 batchNo 读该批明细在');
});
test('AC-AS5 读表失败 ⇒ 页面仍 200 + 兜底 ⇒ 改钉「失败如实给人话」（不许假成功）', () => {
  SCREEN_GONE();
  assert.match(ARRIVAL, /no_request_rows|request_rows_unreadable/, '失败有专门的人话分支');
  assert.match(CONFIG, /Unreadable|读不到|readable/i, '读不到时的人话文案仍在配置');
});
test('AC-AS7 哨兵：旧屏的块里不许出现「工作台」⇒ 随屏退场（新落点就在工作台 ✓）', () => {
  SCREEN_GONE();
  assert.match(WB_ROUTES, /purchase\/arrivals/, '新落点在工作台（与旧口径不冲突）');
});
