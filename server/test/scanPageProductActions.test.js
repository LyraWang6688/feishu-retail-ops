'use strict';

/**
 * 扫码页「货品卡」两个入口（2026-11-17 业务负责人）：
 *   · 「库存调整」按钮 —— 只在 sales / purchase_return 两个领域出现；
 *   · 「信息完善」链接 —— 只在资料不齐时出现，齐备时不留空壳；不再拼接缺失明细。
 *
 * 判据用 data-view 钩子（不要用 CSS 类名：STYLE 里也有 identity__actions，会假绿）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { renderScanPage } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');

const VIEW = {
  found: true,
  number: 'HL55173-1|黑色|男',
  item_no: 'HL55173-1',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: '男',
  price_text: '¥299',
  total: 0,
  columns: [],
  rows: [],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '—',
  product_record_id: 'rec_prod_1',
  product_missing_text: '缺商品信息：成本、单价',
  product_record_url: 'https://tenant.feishu.cn/base/app?table=tbl&record=rec_prod_1',
  product_adjust_url: '/workbench/?module=inventory&page=inventory-adjust&product=rec_prod_1',
};

const render = (realm, view = VIEW) => renderScanPage(view, SCAN_PAGE, null, realm, {});

test('AC-PA1 销售 / 供应退货：两个入口都出现（库存调整 + 信息完善）', () => {
  for (const realm of ['sales', 'purchase_return']) {
    const html = render(realm);
    assert.ok(html.includes('data-view="product-adjust"'), realm + ' 必须有库存调整入口');
    assert.ok(html.includes('data-view="product-info"'), realm + ' 必须有信息完善入口');
    assert.ok(html.includes('库存调整'), realm + ' 按钮文案来自配置');
    assert.ok(html.includes('信息完善'), realm + ' 信息完善是固定文案');
    assert.equal(html.includes('资料不齐：'), false, realm + ' 不再拼接缺失明细');
    assert.ok(html.includes('module=inventory') && html.includes('product=rec_prod_1'), '库存调整要带这一款');
    assert.ok(html.includes('rec_prod_1') && html.includes('record='), '资料链接要指向这条货品记录');
  }
});

test('AC-PA2 其他领域逐字不多：库存 / 补货 / 货品页不出现这两个入口', () => {
  for (const realm of ['inventory', 'replenish', 'product']) {
    const html = render(realm);
    assert.equal(html.includes('data-view="product-adjust"'), false, realm + ' 不许有库存调整');
    assert.equal(html.includes('data-view="product-info"'), false, realm + ' 不许有信息完善链接');
  }
});

test('AC-PA3 资料齐备：不出现「信息完善」（不留空壳），库存调整仍在', () => {
  const html = render('sales', { ...VIEW, product_missing_text: '' });
  assert.ok(html.includes('data-view="product-adjust"'), '库存调整与资料是否齐备无关');
  assert.equal(html.includes('data-view="product-info"'), false, '齐备时不许出现空壳');
});

test('AC-PA4 没有 record_id（兜底命中 / 读不到货品）：两个入口都不渲染，不给死链', () => {
  const html = render('sales', {
    ...VIEW, product_record_id: '', product_record_url: '', product_adjust_url: '',
  });
  assert.equal(html.includes('data-view="product-adjust"'), false);
  assert.equal(html.includes('data-view="product-info"'), false);
});

test('AC-PA5 按钮 / 链接文案全部取配置（改配置即改页面，渲染层不写死）', () => {
  const config = {
    ...SCAN_PAGE,
    productActions: {
      ...SCAN_PAGE.productActions,
      adjustLabel: '去调库存',
      infoLabel: '补资料',
    },
  };
  const html = renderScanPage(VIEW, config, null, 'sales', {});
  assert.ok(html.includes('去调库存'));
  assert.ok(html.includes('补资料'));
});
