'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public', 'workbench');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('AC-PF3 数据配置有「产品特点配置」卡片，点击打开三个维度', () => {
  const domains = read('config/domains.js');
  assert.match(domains, /title: '产品特点配置', action: 'product-feature-config'/);
  const action = read('features/domains/dataConfigAction.js');
  assert.ok(action.includes('data-domain-action="product-feature-config"'));
  assert.ok(action.includes('openProductFeatureConfig(host)'));
  const page = read('features/domains/productFeatureConfig.js');
  assert.ok(page.includes('data-feature-key'));
  assert.ok(page.includes('data-feature-input'));
  assert.ok(page.includes('data-feature-add'));
  assert.ok(page.includes('tag.toLowerCase() === value.toLowerCase()'), '前端先做重复校验');
  assert.ok(page.includes('PRODUCT_FEATURES_API.add'), '新增走接口');
  assert.ok(page.includes("cards.classList.add('hidden')"), '打开配置时隐藏入口卡片');
  assert.ok(page.includes('data-feature-tab'), '三个维度用 tab 切换');
  assert.ok(page.includes('activeKey'), '只渲染当前 tab');
  assert.ok(page.includes('PRODUCT_FEATURES_API.update'), '修改走接口');
  assert.ok(page.includes('PRODUCT_FEATURES_API.remove'), '删除走接口');
  assert.ok(page.includes('item.usage'), '展示使用次数');
  assert.ok(page.includes('data-feature-edit'), '行内修改');
  assert.ok(page.includes('data-feature-delete-confirm'), '删除确认');
});
