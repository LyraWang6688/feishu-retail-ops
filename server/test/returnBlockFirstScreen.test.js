'use strict';
const { rendererSource } = require('./support/rendererSource');

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

// ⚠️ 2026-10-16 深夜（成对迁移）：本文件原来那一行草稿前置（那一族的显式开关）**已随 `config/scanDraft.js` 整件退场而作废** ⇒ 删除。
//   依据 = 业务负责人 2026-10-16 22:0x「**存草稿的功能都删除吧……整个链路都删除**」· 断言一条没删、没放宽 ✓

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

test('AC-RF1a 🔴 退货块**不再是折叠块**：没有 `<details>` / `<summary>`，表单首屏直接可见', async () => {
  const block = await blockOf();
  // 改前逐字（上一刀）：
  //   assert.match(block, /<details class="disclosure" data-view="purchase-return" open>/,
  //     '🔴 退货块要 **open**（她："只有一个退货按钮，点它之后才出现下面的内容" ⇒ 不许再让她多点一次 ✗）');
  // 改后逐字：下面三条
  // 依据：她 **2026-10-16 真机截图 + 逐字**「但是那个**退货按钮为什么还有呢，不需要了**」
  //   ⇒ 上一刀加 `open` 之后表单**已经首屏可见** ✓，那颗 summary 纯多余 ⇒ **连 `<details>` 一起去掉** ✓
  assert.equal(/<details/i.test(block), false, '🔴 退货块里不许再有 `<details>` ✗（塞回即红 ✓）');
  assert.equal(/<\/details>/i.test(block), false,
    '🔴 也不许留一个孤零零的 `</details>`（只删开始标签 ⇒ 标签不配对 ✗；2026-10-16 晚收尾真的抓到过这一处 ✓）');
  assert.equal(/disclosure__summary/.test(block), false, '🔴 也不许再有那颗 `<summary>`（她截图指的就是它 ✗）');
  assert.match(block, /<form method="post"/, '表单**直接在块里** ⇒ 首屏可见 ✓（不靠 open ✗）');
});

test('AC-RF1b 🔴 **首屏**即见：尺码行 + 整单金额 + 生成按钮（都在退货块里）', async () => {
  const block = await blockOf();
  assert.equal((block.match(/class="size-row"/g) || []).length, 1, '她那款只 1 个尺码有数 ⇒ 就列 1 行 ✓');
  assert.match(block, /整单金额/, '整单金额（必填）在块里 ✓');
  // ⭐⭐ 2026-10-16 **成对迁移**（依据：业务负责人真机截图 + 逐字「把**最下面的蓝色按钮**改为「**退货**」」）：
  //   改前逐字：`assert.match(block, /生成采购退货/, '生成按钮在块里 ✓');`
  //   改后逐字：下面这两行（**改指向、不放宽** ✓）
  //   依据：她 2026-10-16 真机截图（退货 tab · 货品 832-500）＋ 逐字「最下面的蓝色按钮改为「退货」」
  //   ⚠️ 判的仍是**同一件事**（"首屏那颗提交按钮在不在"）—— 只是把它**逐字钉死**成配置里那一句 ✓
  //     （原来那条 `/生成采购退货/` 是**写侧**文案；现在那颗按钮的文字来自
  //      `SCAN_PAGE.returnForm.submitLabel`，见 `config/scanPage.js` ✓）
  assert.match(block, new RegExp(`<button type="submit"[^>]*>${SCAN_PAGE.returnForm.submitLabel}</button>`),
    '最下面那颗提交按钮 = 配置里那句（现为「退货」）✓');
  assert.equal(block.includes('生成采购退货'), false, '🔴 旧按钮名不许回来（塞回即红 ✓）');
  assert.match(block, /data-view="return-stock"/, '每行那个"当前库存数量"列也在 ✓');
});

test('AC-RF1c ⭐ 这一刀**只动退货那一个**：一键补货的同形 `<details>` 仍按原样（不改它 ✗）', () => {
  const source = rendererSource();
  assert.match(source, /<details class="disclosure" data-view="one-tap-replenish">/,
    '「一键补货」那个 `<details>` 这一刀**不许动** ✗（Lead 另去问她要不要一起改 ✓）');
  // 改前逐字（上一刀）：assert.match(source, /<details class="disclosure" data-view="purchase-return" open>/,
  //   '退货那个才是本刀改的 ✓');
  // 改前逐字（本刀第一版 · **假红**）：
  //   assert.equal(codeOnly.includes('data-view="purchase-return"'), false, '退货那个 `<details>` 本刀已删 ✓…');
  //   —— 标记**迁到 `<form>` 上**之后这一句**恒为 true** ⇒ 红得没有信息量 ✗（它钉的是"标记在不在"，
  //      而本刀**刻意不删标记**：全仓 6+ 处用例拿它当"退货表单从哪开始"的锚 ✓）
  // 改后逐字：下面两条（**改指向、不放宽** ✓）
  // 依据：业务负责人 **2026-10-16 真机截图 + 逐字**「那个**退货按钮为什么还有呢，不需要了**」
  //   ⇒ 退货块的 `<details class="disclosure" data-view="purchase-return" open>` + `<summary>` 两行**删掉** ✓；
  //     ⭐ 标记 `data-view="purchase-return"` **迁到 `<form>` 自己的属性行上**（标记**不许删** ✗：
  //       删了 ⇒ 6+ 处 `indexOf('data-view="purchase-return"')` 变 -1 ⇒ **空切片的静默假绿**，比红更坏 ✗）
  // ⚠️ **必须【剥注释后】判** —— 本文件/渲染器里为了写「改前逐字」**引用了那串标记**，
  //    不剥注释就会**假红** ✗（与 `test/multiItemOrderRoute.test.js` 的 RT5 同一个老教训 ✓）
  //    剥法用**行位锚定**（只丢"整行是注释"的行）—— 不用 `[\s\S]*?` 多字符清洗（CodeQL 会点名 ✗）
  const codeOnly = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.equal(/<details[^>]*data-view="purchase-return"/.test(codeOnly), false,
    '退货那个 `<details>` 本刀已删 ✓（把 `<details … data-view="purchase-return">` 塞回代码 ⇒ 红 ✓）');
  assert.match(codeOnly, /<form[^>]*data-view="purchase-return"/,
    '⭐ 标记**迁到 `<form>` 上**、一个字没删 ✓（全仓 6+ 处用例拿它当退货表单起点的锚 ⇒ 删了就是 -1 空切片的静默假绿 ✗）');
});

test('AC-RF1d ⭐ **探针**：把 `<details>` / `<summary>` 塞回退货块 ⇒ 检测器**必须报红** ✓（证明 AC-RF1a 不空跑）', () => {
  const offenders = (html) => /<details/i.test(html) || /<\/details>/i.test(html) || /disclosure__summary/.test(html);
  assert.equal(offenders('<section class="card"><form method="post" class="write-form"></form></section>'), false,
    '干净的表单块 ⇒ 不报红 ✓');
  assert.equal(offenders('<details class="disclosure" data-view="purchase-return" open>'), true,
    '塞回 `<details>` ⇒ **必须**报红 ✓');
  assert.equal(offenders('</details>'), true,
    '只留一个孤零零的 `</details>`（标签不配对）⇒ **必须**报红 ✓');
  assert.equal(offenders('<summary class="disclosure__summary">退货</summary>'), true,
    '塞回那颗 `<summary>` ⇒ **必须**报红 ✓');
});
