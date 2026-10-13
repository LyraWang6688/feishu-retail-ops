/**
 * ⭐⭐ 2026-10-12（业务负责人拍板，逐字）：
 *   「② 「备注」还是「赠品」（表列名 / 页面标签）⇒ **赠品**」
 *
 * ⇒ **只改"给她看的那个标签"**（`config/scanWrite.js` 的 `texts.giftLabel`）；
 *   🔴 **映射与读写行为一个字不动**：
 *     · 语义键仍是 `gift`（`SCAN_WRITE.fields.gift`）；
 *     · 落点仍是「销售主表」的那一列「赠品」（`v1BitableSchema.tables.salesEntry.fields.gift`）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**测试名 = AC**）
 *
 *  AC-GL1 销售页上这一列的**标签** = 「赠品（可不填）」；页面**不再出现**「备注（可不填）」。
 *  AC-GL2 **映射与读写逐字不变**（回归）：语义键 = `gift`；表列名 = 「赠品」；表单字段名 = `gift`。
 *         （"真写进去"那一段由既有 E2E 钉着：`salesGiftOnEntry` ③ / `scanSaleAccessoryAndRemark` AC-B4）
 *  AC-GL3 源码哨兵：`giftLabel` 的值里**不许**出现「备注」。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_gift_label';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'gift_label_secret';

const { SCAN_WRITE } = require('../src/config/scanWrite');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const VIEW = {
  found: true, number: 'YD6693-2|黑色|A', item_no: 'YD6693-2', color: '黑色',
  category_name: '休闲鞋', category_code: 'A', price_text: '¥399', total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ key: '门盒', count: 2 }], total: 2, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: '2026-10-12 16:00',
  product_record_id: 'prod_1',
};
const WRITE = {
  enabled: true, texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: '/s/x', sizes: [{ size_text: '40', missing: false }], draft: { lines: [] },
  saleEnabled: true, replenishEnabled: true, returnEnabled: true,
  saleKey: 'scan_sale:test:1', replenishKey: 'scan_replenish:test:1', returnKey: 'scan_return:test:1',
  paymentMethods: ['微信'], defaultPaymentMethod: '微信', notice: '', acceptDefaultQuantity: 1,
};

test('AC-GL1 销售页这一列的标签 = 「赠品（可不填）」；不再出现「备注（可不填）」', () => {
  // 真渲染器 + 真配置：鞋表单与配品表单都在销售领域里 ⇒ 一次渲染覆盖两处 label。
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'sales', {});
  assert.ok(html.includes('赠品（可不填）'), '标签要写「赠品（可不填）」（她这次拍的）');
  assert.equal(html.includes('备注（可不填）'), false, '页面上**不许**再出现「备注（可不填）」');
  // ⚠️ 2026-10-13 **改写**（能力退场，不是放宽断言）：改前渲染层有**两处**读 `t.giftLabel`
  //    （鞋表单 + **配品表单**）；她的口径是「扫码页里的**配品逻辑拿掉**」（配品改到工作台）
  //    ⇒ 配品表单整块退场 ⇒ 现在**只剩下鞋表单那一处** ✓。口径本身没变：
  //    仍然只有**一个真源** `t.giftLabel`，渲染层**不许**写死「备注」✓
  const renderer = fs.readFileSync(path.join(__dirname, '../src/views/scanPageRenderer.js'), 'utf8');
  const labels = (renderer.match(/t\.giftLabel/g) || []).length;
  assert.equal(labels, 1, `配品表单退场后只剩鞋表单那一处（实际 ${labels} 处）`);
  assert.equal(/<label>[^<]*备注/.test(renderer), false, '渲染层不许有写死的「备注」标签');
});

test('AC-GL2 映射与读写逐字不变：语义键 gift · 表列名「赠品」· 表单字段名 gift', () => {
  assert.equal(SCAN_WRITE.fields.gift, 'gift', '语义键不许动（会话 / 写入链路都按它走）');
  assert.equal(V1_BITABLE_SCHEMA.tables.salesEntry.fields.gift, '赠品',
    '落点仍是「销售主表·赠品」那一列（表列名一个字都不动）');
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE, 'sales', {});
  assert.ok(html.includes(`name="${SCAN_WRITE.fields.gift}"`), '表单字段名不变（POST 的键还是 gift）');
});

test('AC-GL3 源码哨兵：`giftLabel` 的值里不许出现「备注」', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config/scanWrite.js'), 'utf8');
  assert.equal(/giftLabel:\s*'[^']*备注/.test(source), false, 'giftLabel 不许再叫「备注」');
  assert.ok(/giftLabel:\s*'赠品（可不填）'/.test(source), 'giftLabel = 赠品（可不填）');
});
