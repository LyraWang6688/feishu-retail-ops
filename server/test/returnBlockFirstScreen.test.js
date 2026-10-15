'use strict';

/**
 * ⭐⭐ 2026-10-16（task-47 · AC-RF1）：**进退货 tab，首屏就要看见表单** ✗ 不许先给一颗「退货」按钮
 *
 * 起因（她真机逐字）：「我首先是点击了退货的 tab 页，**然后只有一个退货按钮**，
 *   点击了退货按钮之后，才出现的下面的内容」
 * 代码级根因：退货块套在 `<details class="disclosure" data-view="purchase-return">` 里，
 *   **没有 `open`** ⇒ 默认收起 ⇒ 首屏只剩那颗 `<summary>`（实心主色、通栏、写着「退货」）
 *   —— 与 `:215` 的「.disclosure__summary」一致 ⇒ 就是她说的"一颗退货按钮" ✓
 * 修法：该 `<details>` 加 **`open`** ✓（保留 details 语义、零 JS ✓、只加一个属性 ✓）
 *
 * 判据（能真红）：
 *   AC-RF1a 🔴 渲染出来的退货块那个 `<details>` **必须带 `open`**（去掉 ⇒ 红 ✓）
 *   AC-RF1b 🔴 **首屏**就能在自己的板块里看到：尺码行 + 整单金额 + 生成按钮 ✓
 *   AC-RF1c ⭐ **不改别人**：`一键补货` 那个同形 `<details>` **仍按原样**（这一刀不动它 ✗）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_rf_first';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'rf_first_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = process.env.LARK_WEB_SESSION_SECRET || 'rf_first_session';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { createScanPageRouter } = require('../src/routes/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');

const NUMBER = 'JX2181-8|米色|B';
const COOKIE = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_rf', name: 'rf', exp: Date.now() + 36e5 }))
    .toString('base64url');
  return `workbench_session=${payload}.${crypto.createHmac('sha256', process.env.LARK_WEB_SESSION_SECRET)
    .update(payload).digest('base64url')}`;
})();

/** ⭐ 她的真实形状（日志：total:1 · sizes:10 · missing:9）⇒ 只 1 个尺码有数 ✓ */
const herView = () => ({
  found: true, number: NUMBER, item_no: 'JX2181-8', color: '米色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }], missing_count: 9,
  sizes_degraded: false, notes: [], updated_at_text: '2026-10-16 01:0x',
  rows: ['36', '37', '38', '39', '40', '41', '42', '43', '44', '45'].map((size, index) => ({
    size_text: size, cells: index === 4 ? [{ count: 1 }] : [], total: index === 4 ? 1 : 0, missing: index !== 4,
  })),
});

const blockOf = async () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => herView() }, gateway: {},
    writeService: {
      sessions: { get: async () => null, submitKeyFor: () => 'rf', saveSaleProgress: async () => ({ ok: true }) },
      listAccessories: async () => [],
    },
    startSnapshot: false,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  server.keepAliveTimeout = 1;
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/s/${encodeURIComponent(NUMBER)}?from=purchase_return`,
      { headers: { cookie: COOKIE } },
    );
    assert.equal(response.status, 200, '退货那一页要能打开 ✓');
    const html = await response.text();
    const at = html.indexOf('realm-block--purchase_return');
    assert.notEqual(at, -1, '退货块要在页面上 ✓');
    return html.slice(at, html.indexOf('</section>', at) + 10);
  } finally { await new Promise((resolve) => { server.close(resolve); }); }
};

test('AC-RF1a 🔴 退货那个 `<details>` **必须带 `open`**（去掉 ⇒ 首屏又只剩一颗「退货」按钮 ⇒ 红 ✓）', async () => {
  const block = await blockOf();
  assert.match(block, /<details class="disclosure" data-view="purchase-return" open>/,
    '🔴 退货块要 **open**（她："只有一个退货按钮，点它之后才出现下面的内容" ⇒ 不许再让她多点一次 ✗）');
});

test('AC-RF1b 🔴 **首屏**即见：尺码行 + 整单金额 + 生成按钮（都在退货块里）', async () => {
  const block = await blockOf();
  assert.equal((block.match(/class="size-row"/g) || []).length, 1, '她那款只 1 个尺码有数 ⇒ 就列 1 行 ✓');
  assert.match(block, /整单金额/, '整单金额（必填）在块里 ✓');
  assert.match(block, /生成采购退货/, '生成按钮在块里 ✓');
  assert.match(block, /data-view="return-stock"/, '每行那个"当前库存数量"列也在 ✓');
});

test('AC-RF1c ⭐ 这一刀**只动退货那一个**：一键补货的同形 `<details>` 仍按原样（不改它 ✗）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'views', 'scanPageRenderer.js'), 'utf8');
  assert.match(source, /<details class="disclosure" data-view="one-tap-replenish">/,
    '「一键补货」那个 `<details>` 这一刀**不许动** ✗（Lead 另去问她要不要一起改 ✓）');
  assert.match(source, /<details class="disclosure" data-view="purchase-return" open>/,
    '退货那个才是本刀改的 ✓');
});
