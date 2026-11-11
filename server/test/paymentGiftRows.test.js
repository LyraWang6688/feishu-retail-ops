'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderSalePaymentStepPage } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const write = {
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  paymentMethods: ['微信扫码'],
  defaultPaymentMethod: '微信扫码',
  paymentRowCount: 1,
  draft: { lines: [] },
};

test('AC-GF3 资金页赠品：默认零行、添加按钮、隐藏 gift 字段', () => {
  const html = renderSalePaymentStepPage({
    write, orderNo: 'XSD-TEST', config: SCAN_PAGE, postAction: '/pay', totalAmountText: '300',
  });
  assert.match(html, /data-gift-section/);
  assert.match(html, /data-gift-add/);
  assert.match(html, /data-gift-rows/);
  assert.match(html, /data-gift-template/);
  assert.match(html, /data-gift-value/);
  assert.match(html, new RegExp(`name="${SCAN_WRITE.fields.gift}"`), '仍提交既有 gift 字段');
  assert.match(html, /data-gift-placeholder="请选择赠品"/);
  assert.match(html, /还没有赠品/);
  assert.match(html, /添加赠品/);
  assert.match(html, /data-view="gift-rows"/);
  // 模板里只有一份赠品行；页面容器默认不渲染任何赠品行
  const beforeTemplate = html.slice(0, html.indexOf('data-gift-template'));
  assert.equal(/data-gift-row(?![s-])/.test(beforeTemplate), false, '初始没有默认赠品行');
});

test('AC-GF4 赠品候选接口路径/序列化规则钉在源码里', () => {
  const script = fs.readFileSync(path.join(__dirname, '../src/views/scanPage/script.js'), 'utf8');
  assert.match(script, /\/api\/workbench\/accessories\/gifts/);
  assert.match(script, /parts\.push\(name \+ '×' \+ n\)/);
  assert.match(script, /value\.value = parts\.join\('、'\)/);
  assert.match(script, /qty\.value = '1'/);
});
