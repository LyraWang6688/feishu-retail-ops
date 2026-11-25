'use strict';

/**
 * 工作台深链（2026-11-17）：扫码页「库存调整」按钮要能带着货品直达
 *   库存 → 手工调整 → 单双调整。
 *
 * 工作台原来**完全不读 URL**（永远打开销售 tab）⇒ 这里钉住三件事：
 *   ① main.js 读 module/page/product 并把 deepLink 交给模块；
 *   ② domains/index.js 认 page，并把 product 传给库存手工调整模块；
 *   ③ adjustment.js 只认 record_id 形状，并调用既有 selectProduct 展开这一款。
 *
 * 都是**源码哨兵**（与仓库里其它前端模块用例同一套写法）：前端没有 DOM 测试环境。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

test('AC-DL1 main.js：读 module/page/product，module 必须真实存在，deepLink 交给 mount', () => {
  const src = read('public/workbench/main.js');
  assert.ok(src.includes('new URLSearchParams(window.location.search'), '必须读 URL 参数');
  assert.ok(src.includes("params.get('module')"), 'module 参数');
  assert.ok(src.includes("params.get('page')"), 'page 参数');
  assert.ok(src.includes("params.get('product')"), 'product 参数');
  assert.ok(src.includes('modules.has(deepLink.module)'), 'module 必须是真实存在的 tab');
  assert.ok(src.includes('activateModule(initialModule, { deepLink })'), 'deepLink 要交给模块');
  assert.ok(src.includes('module.mount(container, deepLink || {})'), 'mount 要收到 deepLink');
});

test('AC-DL2 domains/index.js：page 只在 domain.pages 里取，product 传给库存手工调整', () => {
  const src = read('public/workbench/features/domains/index.js');
  assert.ok(src.includes('mount(container, initial = {})'), 'mount 接受深链参数');
  assert.ok(src.includes("domain.pages.find((item) => item.id === String(initial.page || '').trim())"),
    'page 必须按 domain.pages 校验');
  assert.ok(src.includes('state.active = wantedPage ? wantedPage.id : domain.pages[0].id'),
    '认不出 page ⇒ 回落第一个子页');
  assert.ok(src.includes('createInventoryAdjustmentModule({ initialProductId: state.initialProductId, returnTo: state.returnTo })'),
    'product / returnTo 要传给库存手工调整模块');
});

test('AC-DL3 adjustment.js：record_id 形状校验 + 只调既有 selectProduct（不新造入口）', () => {
  const src = read('public/workbench/features/inventory/adjustment.js');
  assert.ok(src.includes('const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/'), 'record_id 形状校验');
  assert.ok(src.includes("createInventoryAdjustmentModule({ initialProductId = '', returnTo = '' } = {})"), '模块接受初始货品与返回路径');
  assert.ok(src.includes('if (PRODUCT_ID_PATTERN.test(deepLinkProductId))'), '形状不对就不打接口');
  assert.ok(src.includes('void selectProduct(deepLinkProductId)'), '复用既有 selectProduct');
});
