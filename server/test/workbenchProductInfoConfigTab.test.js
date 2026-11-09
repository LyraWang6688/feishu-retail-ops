'use strict';

/** 配置 → 数据配置：配品配置占位卡 + 两个同步动作卡。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');
const loadPages = async () => {
  const domains = await import(pathToFileURL(path.join(ROOT, 'server/public/workbench/config/domains.js')).href);
  return domains.domainById('product').pages;
};

test('货品页：标签打印右侧有「数据配置」，内含配品配置 + 两个同步动作卡', async () => {
  const pages = await loadPages();
  const labels = pages.findIndex((page) => page.id === 'product-labels');
  const config = pages.findIndex((page) => page.id === 'product-info-config');
  assert.ok(labels >= 0, '标签打印页仍在');
  assert.equal(config, labels + 1, '数据配置紧挨在标签打印右边');
  assert.equal(pages[config].label, '数据配置');
  assert.equal(pages[config].kind, 'action-cards', '数据配置是动作卡页');
  assert.equal(pages[config].cards?.[0]?.title, '配品配置');
  assert.equal(pages[config].cards?.[0]?.placeholder, true, '配品配置先占位');
  assert.equal(pages[config].cards?.[1]?.action, 'voucher-catalog-sync', '券目录同步动作');
  assert.equal(pages[config].cards?.[2]?.action, 'sample-image-sync', '样例图同步动作');
  assert.equal(fs.existsSync(path.join(ROOT, 'server/public/workbench/features/domains/pages.js')), true);
});

test('配置页：「消息通知」占位子 tab 在最右边（2026-11-09）', async () => {
  const pages = await loadPages();
  const last = pages[pages.length - 1];
  assert.equal(last.id, 'product-notifications');
  assert.equal(last.label, '消息通知');
  assert.equal(last.kind, 'placeholder', '先占位，后续接统一通知归集');
});
