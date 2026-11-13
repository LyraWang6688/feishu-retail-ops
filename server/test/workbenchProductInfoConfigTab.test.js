'use strict';

/** 配置 → 货品资料 / 数据配置 的页面结构。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const loadPages = async () => {
  const domains = await import(pathToFileURL(path.join(ROOT, 'server/public/workbench/config/domains.js')).href);
  return domains.domainById('product').pages;
};

test('货品页：标签打印左边是「货品资料」，数据配置有券同步和产品特点配置', async () => {
  const pages = await loadPages();
  const labels = pages.findIndex((page) => page.id === 'product-labels');
  const profile = pages.findIndex((page) => page.id === 'product-new');
  const config = pages.findIndex((page) => page.id === 'product-info-config');
  assert.ok(labels >= 0, '标签打印页仍在');
  assert.equal(profile, 0, '货品资料是配置下第一页');
  assert.equal(pages[profile].label, '货品资料');
  assert.equal(pages[profile].kind, 'product-profile');
  assert.equal(pages[config].label, '数据配置');
  assert.equal(pages[config].kind, 'action-cards');
  assert.deepEqual(pages[config].cards.map((card) => card.action), ['voucher-catalog-sync', 'product-feature-config']);
});

test('配置页：「消息通知」占位子 tab 在最右边（2026-11-09）', async () => {
  const pages = await loadPages();
  const last = pages[pages.length - 1];
  assert.equal(last.id, 'product-notifications');
  assert.equal(last.label, '消息通知');
  assert.equal(last.kind, 'placeholder', '先占位，后续接统一通知归集');
});
