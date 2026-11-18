'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_sample_tag_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'sample_tag_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'sample_tag_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { samplePromotionScriptHtml } = require('../src/views/scanPage/samplePromotion');

const cookie = (() => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_sample_tag', name: '测试', exp: Date.now() + 3600 * 1000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'sample_tag_session_secret').update(payload).digest('base64url');
  return `workbench_session=${payload}.${sig}`;
})();

const view = () => ({
  found: true,
  product_record_id: 'prod_sample_tag',
  number: '6606-373|黑色|女',
  item_no: '6606-373',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: '女',
  price_text: '¥210',
  total: 4,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '', label: '空状态' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '', count: 0 }], total: 2, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 1 }, { key: '', count: 0 }], total: 1, missing: false },
    { size_text: '42', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '', count: 1 }], total: 1, missing: false },
  ],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-11-18 11:30',
});

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, '127.0.0.1', () => resolve(i)); });
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

test('AC-SAMPLE-TAG1 尺码卡带状态标签；仅样品尺码带 data-sample-only=1；候选来自有库存的尺码', async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup: async () => view() },
    gateway: {},
    writeService: { sessions: { get: async () => null, submitKeyFor: () => 'scan_sale:test:1' } },
  }));
  await withServer(app, async (base) => {
    const response = await fetch(`${base}/r/rec_sample_tag?from=sales`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /data-sample-promotion/);
    assert.match(html, /data-sample-candidates="\[&quot;40&quot;,&quot;41&quot;,&quot;42&quot;\]"/);
    assert.match(html, /data-size="40"[^>]*data-sample-only="0"/);
    assert.match(html, /data-size="41"[^>]*data-sample-only="1"/);
    assert.match(html, /data-size="42"[^>]*data-sample-only="0"/);
    assert.match(html, />门盒</);
    assert.match(html, />样品</);
    assert.match(html, />空状态</);
    const script = samplePromotionScriptHtml().replace(/^<script>|<\/script>$/g, '');
    assert.doesNotThrow(() => new Function(script), '弹窗脚本必须能通过语法解析');
  });
});
