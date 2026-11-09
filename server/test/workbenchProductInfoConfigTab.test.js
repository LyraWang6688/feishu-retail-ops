'use strict';

/**
 * 2026-11-08 业务负责人：
 * 货品配置页增加子 tab「数据配置」，放在「标签打印」右边，先做占位符。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', '..');

test('货品页：标签打印右侧有「数据配置」子 tab（同步按钮）', async () => {
  const domains = await import(pathToFileURL(path.join(ROOT, 'server/public/workbench/config/domains.js')).href);
  const pages = domains.domainById('product').pages;
  const labels = pages.findIndex((page) => page.id === 'product-labels');
  const config = pages.findIndex((page) => page.id === 'product-info-config');
  assert.ok(labels >= 0, '标签打印页仍在');
  assert.equal(config, labels + 1, '数据配置紧挨在标签打印右边');
  assert.equal(pages[config].label, '数据配置');
  // 2026-11-10：占位改成**一颗同步按钮**（点击触发券目录同步，不是定时任务）。
  assert.equal(pages[config].kind, 'voucher-sync', '数据配置 = 同步按钮页');
  assert.equal(fs.existsSync(path.join(ROOT, 'server/public/workbench/features/domains/pages.js')), true);
});

test('配置页：「消息通知」占位子 tab 在最右边（2026-11-09）', async () => {
  const domains = await import(pathToFileURL(path.join(ROOT, 'server/public/workbench/config/domains.js')).href);
  const pages = domains.domainById('product').pages;
  const last = pages[pages.length - 1];
  assert.equal(last.id, 'product-notifications');
  assert.equal(last.label, '消息通知');
  assert.equal(last.kind, 'placeholder', '先占位，后续接统一通知归集');
});
