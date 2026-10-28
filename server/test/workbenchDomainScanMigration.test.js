'use strict';
/**
 * 2026-10-27 扫一扫按领域拆分后的新 IA 哨兵。
 * 旧测试（全局扫一扫 / 领域切换条 / 旧 tab 顺序）已随行为变更退役；
 * 本文件钉住新结构 + 领域扫码入口 + 裸扫码默认库存。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('新 IA：一级 tab = 销售 · 库存 · 供应 · 货品，没有全局扫一扫', () => {
  const tabs = read('public/workbench/config/tabs.js');
  for (const label of ["label: '销售'", "label: '库存'", "label: '供应'", "label: '货品'"]) {
    assert.ok(tabs.includes(label), `缺少一级 tab：${label}`);
  }
  assert.equal(tabs.includes("module: 'scan'"), false, '全局扫一扫一级 tab 必须退场');
  assert.equal(tabs.includes("label: '采购'"), false, '采购已改名为供应');
});

test('新 IA：销售/库存/供应录单入口存在，供应录单有三张卡', () => {
  const domains = read('public/workbench/config/domains.js');
  assert.ok(domains.includes("id: 'sales-entry'") && domains.includes("label: '录单'"), '销售缺录单');
  assert.ok(domains.includes("scanRealm: 'sales'"), '销售鞋类必须接领域扫码');
  assert.ok(domains.includes("scanRealm: 'inventory'"), '库存单点查询必须接领域扫码');
  assert.ok(domains.includes("title: '采购'") && domains.includes("href: '/workbench/procurement.html'"), '供应采购必须打开采购页');
  assert.match(read('public/workbench/features/domains/nav.js'), /data-tap-target=/, '领域子 tab 必须带点击埋点');
  assert.match(read('public/workbench/features/scan/launch.js'), /data-tap-target=/, '领域扫码卡片必须带点击埋点');
  // ⭐ 2026-10-28（采购页进入生产）：扫一扫本轮只占位/禁用（业务负责人口径），
  //    但**补货领域的埋点属性必须原样保留**（下一轮接扫一扫时不用再改埋点）——
  //    该属性已随页面模块化搬到渲染层（procurement.html 现在是薄壳）。
  assert.match(read('public/workbench/features/procurement/render.js'), /data-tap-target="\$\{escapeHtml\(tab\.tapTarget\)\}"/, '采购扫一扫必须带补货领域埋点');
  assert.match(read('public/workbench/features/procurement/render.js'), /data-pr-scan-disabled/, '采购扫一扫本轮必须是占位/禁用');
  assert.ok(domains.includes("scanRealm: 'purchase_return'"), '供应退货必须接领域扫码');
  assert.ok(domains.includes("jumpTo: 'purchase-acceptance'"), '验收卡必须复用既有验收页');
  assert.ok(domains.includes('id: \'purchase-acceptance\''), '验收页必须存在');
  assert.ok(domains.includes('hidden: true'), '验收页不能出现在子 tab 条上');
  assert.equal(domains.includes("id: 'sales-accessory'"), false, '配品不再是独立子 tab');
});

test('领域扫码入口：真实 JSAPI + 扫完带 from 跳转', () => {
  const launch = read('public/workbench/features/scan/launch.js');
  assert.ok(launch.includes('tt.scanCode'), '必须调用飞书 tt.scanCode');
  assert.ok(launch.includes("searchParams.set('from'"), '扫完必须把领域写进 from');
  assert.ok(launch.includes('jsapi-signature'), '必须走既有签名接口');
  assert.ok(read('public/workbench/config/domains.js').includes("kind: 'scan-direct'"), '单点查询使用直接扫码模式');
});

test('扫码页按领域显示：不再渲染全局领域切换条；裸扫码默认库存', () => {
  const page = read('src/views/scanPage/index.js');
  const realm = read('src/views/scanPageRealm.js');
  assert.equal(/\$\{realmBarHtml\(/.test(page), false, '页面不得再渲染领域切换条');
  assert.equal(/\$\{noScriptHtml\(\)\}/.test(page), false, '页面不得再渲染领域切换 noscript');
  assert.match(realm, /const DEFAULT_REALM = 'inventory';/, '裸扫码默认库存');
});
