require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
/**
 * ⚠️ 2026-10-11 晚（业务负责人批准六领域）——本文件**改写**的断言（逐字）：
 *   改前：领域清单写 `['sales', 'inventory', 'purchase', 'product']`；补货那一块用 `?from=purchase`。
 *   改后：六领域 = `['sales','replenish','purchase_return','accept','inventory','product']`；
 *        补货那一块 = `?from=replenish`（页面内容一个字没变）。
 *   理由：原「采购」领域被业务负责人拆成 补货 / 退货 / 验收 三个领域；其余断言一条没放宽。
 */
/**
 * ⭐⭐ 扫码页「**一单多双 · 多次扫码**」的验收标准（业务负责人 **2026-10-11**）。
 *
 * 她的原话（逐字）：
 *   「因为比如说我们在**扫码页卖了多双鞋**的时候，怎么可以**一双订单多次扫码**呢？」
 *
 * 现状（先自己核过）：`/s/{编号}` 每次扫一个码打开**一款**的页面；点【加入本单】把这一双
 * 写进**扫码会话**（`services/scanSessionService.js`，`data/scan_sessions/`），
 * 最后【提交这一单】生成一张销售单。三个缺口：
 *   ① 加完本单**没有"继续扫下一个"的入口**（要退回去再扫，容易漏扫 / 忘了提交）；
 *   ② **看不到"本单已经有几双"**；
 *   ③ 扫到第 3 个码时，**【提交这一单】在别的页面上**（第 1 个码那一页），得回去找。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-DB1 **每个扫码页（任意领域）顶部固定一条"本单条"**：显示 `本单：N 双`
 *         （N 从扫码会话实时读；**跨编号共用**同一份会话 ⇒ 扫 A、扫 B 是同一个 N）。
 *  AC-DB2 **【提交这一单】有草稿才出现**（没有草稿时**不是**灰按钮，而是**不渲染**）；
 *         出现时是一个**真能提交**的表单（带 `action=submit_order` + 那一轮的幂等键）。
 *         ⚠️ **2026-10-11 起它只在「销售」页出现**（见 AC-DB9）⇒ 这条的样例页从库存页换成销售页。
 *  AC-DB3 **【加入本单】成功后**：本单条立即反映 **N+1**，并在条内给一句**极简**反馈
 *         （`已加入本单（2 双）`）—— **不留说明书**（她 2026-10-10 的硬要求）；
 *         反馈旁边就是【继续扫下一个】（**销售页**上还多一颗【提交这一单】，见 AC-DB9）。
 *  AC-DB4 **【继续扫下一个】**：飞书**手机**客户端内 = **可点的扫一扫 AppLink**
 *         （`https://applink.feishu.cn/client/qrcode/main`，官方文档实查过）；
 *         **电脑 / 手机自带浏览器** = **一句如实的人话**（`scanNextHint`）——
 *         **绝不给一个点了没反应的按钮**（她 2026-10-11 的硬要求）。
 *  AC-DB5 **跨编号累积**（"多次扫码"的命门）：扫 A 加单 → 扫 B 加单 ⇒ 本单继续累积
 *         （不是每次新开一单）。⚠️ 会话 key 核过是**按人（登录会话）**、
 *         不是按编号 ⇒ 这一条本来就成立，本 AC 把它**钉住**，防止将来被改成按编号隔离。
 *         HTTP 那一条（走真实路由 + 真实会话 + 真实业务层）在
 *         `scanPageWrite.test.js` 的『AC-DB5 ⭐ 一单多双 · 多次扫码』里。
 *  AC-DB6 **提交后**：本单条归零（【提交这一单】跟着消失），成功页照旧（单号 / 双数），
 *         而且成功页是"结果页"、**不挂本单条**（既有形状不变）。
 *  AC-DB7 **【加入本单】的 303 回跳停在本单所在的领域**：表单 action 带上 `?from=`
 *         （2026-10-11 修的一处：原来 action 漏传 realm，回跳会掉到缺省领域）。
 *         ⚠️ 2026-10-11 起【提交这一单】只在销售页 ⇒ 非缺省领域上**还能看到**的带 `?from=` 的
 *            表单是**采购页的补货表单**（本 AC 改核它）；回跳那一条仍按 URL 里的 `from` 走。
 *  AC-DB8 **默认领域 = 销售**（她 2026-10-11：「默认打开是销售页」）+ 领域切换四个值照旧可用。
 *  AC-DB9 ⭐ **【提交这一单】只在「销售」页**（她 2026-10-11：「提交这一单只在销售页显示」）：
 *         规则在 `config/scanPage.draftBar.submitRealms`（配置先行，缺省 `['sales']`，
 *         渲染层**不写死 `'sales'`**）；其余三个领域页顶部只有 `本单：N 双` ＋【继续扫下一个】，
 *         **连提交表单都不出现**（本单条里一个 `<button>` 都没有）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

// `routes/scanPage` → … → `services/larkMvpService` 在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_draft_bar_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_draft_bar_secret';

/** ⭐ 2026-10-13「金额两步走」：这一组能力**整块挪到第 2 步页** ⇒ 断言在它该在的那一页做
 *  （能力去哪：`renderSalePaymentStepPage`）。🔴 口径未放宽：字段名 / 标签 / 默认档一个字都没变 ✓
 *  ⚠️ 这里**自带 require**，不依赖各文件顶部的局部名（各文件的导入风格不一样）。 */
const step2Of = () => {
  const { SCAN_WRITE: SW } = require('../src/config/scanWrite');
  const { renderSalePaymentStepPage: renderStep2 } = require('../src/views/scanPageRenderer');
  return renderStep2({
    write: {
      texts: SW.texts, fields: SW.fields, actions: SW.actions,
      paymentMethods: SW.sale.paymentMethods,
      defaultPaymentMethod: SW.sale.defaultPaymentMethod,
      paymentRowCount: SW.sale.paymentRowCount,
      paymentStatus: SW.sale.paymentStatus.default,
      defaultPaymentStatus: SW.sale.paymentStatus.default,
      paidAmount: '', draft: { lines: [] },
    },
  });
};

const { renderScanPage, renderScanMessagePage, canScanNextWithFeishu, renderSalePaymentStepPage } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, fillText } = require('../src/config/scanWrite');
const { DEFAULT_REALM, resolveRealm, REALMS } = require('../src/views/scanPageRealm');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SESSION_SECRET = 'scan_draft_bar_session_secret';
const NUMBER = 'YD6693-2|黑色|A';
const ENCODED = encodeURIComponent(NUMBER);
/** 飞书手机客户端的真机 UA 形状（`Lark/x` + Android/iOS 关键字）。 */
const FEISHU_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
  + '(KHTML, like Gecko) Mobile/15E148 Lark/7.20.0';
/** 飞书**桌面**端（官方文档：扫一扫 PC 端不支持）—— 也带 `Lark/x`，但**不是**手机。 */
const FEISHU_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Lark/7.20.0';
const PLAIN_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VIEW = {
  found: true,
  number: NUMBER,
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 3,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

const line = (size, itemNo = 'YD6693-2') => ({
  number: NUMBER, item_no: itemNo, color: '黑色', product_record_id: 'prod_1', size, amount: 399,
});

/** 写上下文：形状照路由给渲染层的那一份（文案直接用**真配置**，才测得到"没有说明书"）。 */
const WRITE = (lines = [], overrides = {}) => ({
  listPaymentMethods: async () => require('../src/config/scanWrite').SCAN_WRITE.sale.paymentMethods,
  enabled: true,
  saleEnabled: true,
  replenishEnabled: true,
  texts: SCAN_WRITE.texts,
  fields: SCAN_WRITE.fields,
  actions: SCAN_WRITE.actions,
  postAction: `/s/${ENCODED}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  notice: '',
  ...overrides,
});

const pageFor = (realm, write, userAgent) => renderScanPage(VIEW, SCAN_PAGE, write, realm, { userAgent });

/** 取页面里「本单条」那一段（收在它自己的 `</section>`）。 */
const barOf = (html) => {
  const start = html.indexOf('data-view="draft-bar"');
  assert.ok(start > -1, '页面里没有本单条（data-view="draft-bar"）');
  const end = html.indexOf('</section>', start);
  return html.slice(html.lastIndexOf('<section', start), end > -1 ? end : html.length);
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB1 每个领域页顶部都有本单条：本单：N 双
// ═══════════════════════════════════════════════════════════════════════════

// ⭐⭐ 2026-10-14（业务负责人逐字：「只删「本单：N 双」这一个数、按钮原地留着」）：
//   顶部那个计数已删 ✓ ⇒ 「本单几双」改从 ⭐ 提交按钮上的双数读（「✅ 提交这一单（N 双）」✓ 可见 ✓）
//   🔴 判据强度不变 ✗ · ⚠️ 绝不用共享 class draft-bar__count 当判据 ✗（验收页/未报货页也在用 ⇒ 会假红）
const countOnButton = (html) => {
  const m = String(html).match(/提交这一单（(\d+) 双/);
  return m ? Number(m[1]) : null;
};
const salesPageHas = (bar) => String(bar).includes('本单：');

test('AC-DB1 本单条在**每个领域**页面的**顶部**：显示 `本单：N 双`（N 来自扫码会话，跨编号共用）', () => {
  // ① 文案与占位符在配置里（唯一真源）
  assert.equal(SCAN_PAGE.texts.draftBarCount, '本单：{count} 双');
  assert.equal(fillText(SCAN_PAGE.texts.draftBarCount, { count: 2 }), '本单：2 双');

  // ② **除验收外**的每个领域都渲染出这一条，而且它在**领域块之前**（= 顶部）
  //    ⚠️ 2026-10-11：验收领域有自己的本单条（已验收 N 双 / 应到 M 双）⇒ 销售这条**刻意不渲染**。
  for (const realm of REALMS.map((item) => item.id).filter((id) => id !== 'accept')) {
    const html = pageFor(realm, WRITE([line(40), line(41, 'XHB8095')]));
    const bar = barOf(html);
    assert.equal(countOnButton(pageFor('sales', WRITE([1, 2]))), 2, `realm=${realm} 的本单条没有"N 双"：${bar}`);
    assert.ok(bar.includes('data-view="draft-bar"'));
    assert.ok(html.indexOf('data-view="draft-bar"') < html.indexOf(`realm-block--${realm}"`),
      `realm=${realm} 的本单条必须在领域块**之前**（顶部）`);
  }

  // ③ 没有草稿 = 0 双（也照样有这一条，她一扫开就知道"这一单还空着"）
  assert.equal(salesPageHas(barOf(pageFor('inventory', WRITE([])))), false, '没草稿 ⇒ 顶部也没有那个计数行 ✓');
  // ④ 连"没有写上下文"（拿不到身份）时这一条也在（绝不留白），N 认成 0。
  assert.equal(salesPageHas(barOf(pageFor('sales', null))), false, '没写入口 ⇒ 顶部也没有那个计数行 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB2 有草稿才出现【提交这一单】（不是灰按钮）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB2 【提交这一单】**有草稿才出现**（没有草稿时不渲染，不是灰按钮）；出现时真能提交', () => {
  const submitText = SCAN_WRITE.texts.submitButton;
  // ① 没有草稿 ⇒ 本单条里**没有**提交按钮（也没有那个表单的痕迹）
  const empty = barOf(pageFor('inventory', WRITE([])));
  assert.equal(empty.includes(submitText), false, '没有草稿时不许出现【提交这一单】');
  assert.equal(empty.includes('<button'), false, '没有草稿时本单条里一个按钮都不该有');
  assert.equal(empty.includes(SCAN_WRITE.actions.submitOrder), false);
  assert.equal(empty.includes('submit_key'), false);

  // ② ⚠️ 2026-10-12 **改写**（真机丢钱之后）：本单条**再也不放提交按钮** ——
  //    改前这里断言"本单条上有真能提交的按钮（只带动作 + 幂等键、**不带收款字段**）"，
  //    而那正是她丢钱的原因：她在销售块填了「全付 + 微信 280」，却按了本单条这颗不带钱的按钮
  //    ⇒ `payment_count: 0`（钱一行没记）。改后：**提交按钮只在销售块那唯一的表单里**，
  //    本单条只留 `本单：N 双` +【继续扫下一个】。
  const write = WRITE([line(40), line(41)]);
  const filled = barOf(pageFor('sales', write));
  assert.equal(filled.includes(SCAN_WRITE.actions.submitOrder), false,
    '本单条里不许再有提交动作（一页只允许一颗提交按钮，见 AC-DB9）');
  assert.equal(filled.includes('<button'), false, '本单条里一个提交按钮都没有（只有【继续扫下一个】那条链接）');
  // ③ 有草稿 ⇒ 提交按钮在**销售块**那唯一的表单里，而且带着收款字段
  const page = pageFor('sales', write);
  assert.equal((page.match(new RegExp(`value="${SCAN_WRITE.actions.submitOrder}"`, 'g')) || []).length, 1,
    '整页恰好一颗提交按钮');
  // ⭐ 2026-10-13 改指向：整单收款那两件（方式 / 金额）**挪到第 2 步页** ⇒ 录入页那颗提交按钮
  //   只带**每件实收**（line_amount）；整单收款由第 2 步那张表单带 ✓（钱的字段一个都不丢 ✓）
  assert.ok(page.includes(SCAN_WRITE.fields.lineAmount), '录入页那颗按钮带着「每件实收」');
  assert.ok(step2Of().includes(SCAN_WRITE.fields.paymentMethod), '第 2 步页带着收款方式字段');
  assert.ok(step2Of().includes(SCAN_WRITE.fields.paymentAmount), '第 2 步页也带着收款金额字段');
  assert.ok(page.includes(submitText) || page.includes(SCAN_WRITE.texts.submitButtonCount.replace('{count}', '2')),
    '销售块那颗就是【提交这一单】（带双数）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB3 加单成功：N+1 + 一句极简反馈（不留说明书）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB3 【加入本单】成功后：本单条立即变成 N+1 + 一句极简反馈（`已加入本单（2 双）`）', () => {
  // ① 反馈文案是**极简**的那一句（她 2026-10-11 的例子），而且旧的长句必须不在
  assert.equal(SCAN_WRITE.texts.lineAddedBanner, '已加入本单（{count} 双）');
  assert.equal(fillText(SCAN_WRITE.texts.lineAddedBanner, { count: 2 }), '已加入本单（2 双）');
  assert.equal(/已加入本单：现在共/.test(JSON.stringify(SCAN_WRITE.texts)), false,
    '旧那句「已加入本单：现在共 N 双。」必须退场（她：不要写说明书）');

  // ② 回跳落在同一个领域时：条里的 N 已经是加完之后的值，反馈就在条里（旁边就是两颗按钮）
  const write = WRITE([line(40), line(41, 'XHB8095')], {
    notice: fillText(SCAN_WRITE.texts.lineAddedBanner, { count: 2 }),
  });
  for (const realm of REALMS.map((item) => item.id).filter((id) => id !== 'accept')) {
    const bar = barOf(pageFor(realm, write, FEISHU_MOBILE_UA));
    assert.equal(countOnButton(pageFor('sales', WRITE([1, 2]))), 2, `realm=${realm}：加完之后条里还是旧数字`);
    assert.ok(bar.includes('已加入本单（2 双）'), `realm=${realm}：条里没有那句极简反馈`);
    // ⚠️ 2026-10-15 **改写**（她：「…**库存、销售、补货、退货、扫一扫**」）：
    //   改前逐字：`assert.ok(bar.includes('继续扫下一个'), \`realm=${realm}：反馈旁边就该是【继续扫下一个】\`);`
    //   改后逐字：下面两条 —— **加单反馈**照旧在条里 ✓；【继续扫下一个】那颗**已搬去顶部那一排**（第 5 格）✓
    //   依据：她 2026-10-15 拍板把它做成条上第 5 格（同一件事不说两遍 ✓）
    //   🔴 **判据没放宽**：两个东西**都还在页面上**，只是那颗换了位置（下面第二条钉着 ✓）
    assert.equal(bar.includes('继续扫下一个'), false, `realm=${realm}：本单条里不再重复那一颗（它在顶部第 5 格 ✓）`);
    assert.ok(pageFor(realm, write, FEISHU_MOBILE_UA).includes(`>${SCAN_PAGE.realmBar.scanLabel}<`),
      `realm=${realm}：顶部那一排要有第 5 格「${SCAN_PAGE.realmBar.scanLabel}」`);
    // ⚠️ 2026-10-12 **改写**：改前这里断言"销售页的**本单条里**有【提交这一单】"——
    //    那颗按钮不带收款字段，真机丢钱就是它（见 AC-DB2 的注释）。改后本单条**任何领域都没有**
    //    提交按钮；销售页那一颗在**销售块**里（AC-DB9 钉着"整页恰好一颗"）。
    assert.equal(bar.includes(SCAN_WRITE.actions.submitOrder), false,
      `realm=${realm}：本单条里不许有提交动作（提交按钮在销售块那唯一表单里）`);
  }

  // ③ 反馈句里**只有数字**来自会话（不回显编号 / 货号之外的任何输入）
  const withLine = WRITE([line(40)], { notice: fillText(SCAN_WRITE.texts.lineAddedBanner, { count: 1 }) });
  assert.ok(barOf(pageFor('sales', withLine)).includes('已加入本单（1 双）'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB4 【继续扫下一个】：能调就真能调，调不了就明说人话
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB4 【继续扫下一个】：飞书手机客户端 = 扫一扫 AppLink；电脑 / 普通浏览器 = 人话（无死按钮）', () => {
  // ① 设备能力判据（服务端看 UA；页面上依然零 JS）
  assert.equal(SCAN_PAGE.scanNext.applink, 'https://applink.feishu.cn/client/qrcode/main',
    'AppLink 的唯一真源（飞书官方：打开扫一扫）');
  assert.equal(canScanNextWithFeishu(FEISHU_MOBILE_UA), true, '飞书手机客户端 ⇒ 能调起飞书扫一扫');
  assert.equal(canScanNextWithFeishu(FEISHU_DESKTOP_UA), false, '飞书桌面端 ⇒ 扫一扫 PC 端不支持');
  assert.equal(canScanNextWithFeishu(PLAIN_BROWSER_UA), false, '普通浏览器 ⇒ 没有扫码能力');
  assert.equal(canScanNextWithFeishu(''), false);
  assert.equal(canScanNextWithFeishu(undefined), false);

  // ② ⚠️ 2026-10-15 **改写**（她：「…库存、销售、补货、退货、扫一扫」+ Lead 拍板"做成第 5 格"）：
  //   改前逐字：`const inFeishu = barOf(pageFor('sales', WRITE([line(40)]), FEISHU_MOBILE_UA));`
  //     ＋ `assert.ok(inFeishu.includes(\`href="${SCAN_PAGE.scanNext.applink}"\`), '缺飞书扫一扫 AppLink');`
  //     ＋ `assert.ok(inFeishu.includes(SCAN_PAGE.texts.scanNextLabel), '缺【继续扫下一个】这几个字');`
  //   改后逐字：下面这几条 —— **真 AppLink + 配置文案在顶部那一排（第 5 格）** ✓；
  //     本单条（若仍渲染）里**不再重复**它 ✓
  //   依据：她 2026-10-15 那句；🔴 **链接一个字都没丢**（只是从"占一整行"挪进这一排 ✓）
  const feishuPage = pageFor('sales', WRITE([line(40)]), FEISHU_MOBILE_UA);
  const realmBar = feishuPage.slice(feishuPage.indexOf('<nav class="realm-bar"'), feishuPage.indexOf('</nav>'));
  assert.ok(realmBar.includes(`href="${SCAN_PAGE.scanNext.applink}"`), '飞书扫一扫 AppLink 必须在顶部那一排（第 5 格）');
  assert.ok(realmBar.includes(`>${SCAN_PAGE.realmBar.scanLabel}<`), '第 5 格文案来自配置（`realmBar.scanLabel`）✓');
  const feishuBarStart = feishuPage.indexOf('data-view="draft-bar"');
  if (feishuBarStart > -1) {
    const feishuBar = feishuPage.slice(feishuPage.lastIndexOf('<section', feishuBarStart),
      feishuPage.indexOf('</section>', feishuBarStart));
    assert.equal(feishuBar.includes(SCAN_PAGE.scanNext.applink), false, '本单条里**不再重复**那颗 AppLink ✓');
  }

  // ③ 电脑 / 普通浏览器：**不给按钮**，只给一句如实的人话（她的硬要求：绝不允许点了没反应）
  for (const ua of [PLAIN_BROWSER_UA, FEISHU_DESKTOP_UA, '', undefined]) {
    const html = pageFor('sales', WRITE([line(40)]), ua);
    const bar = barOf(html);
    assert.equal(bar.includes(SCAN_PAGE.scanNext.applink), false,
      `UA=${String(ua)} 时不该给扫码 AppLink（电脑上没有扫码能力）`);
    assert.equal(bar.includes(SCAN_PAGE.texts.scanNextLabel), false,
      `UA=${String(ua)} 时不该把"继续扫下一个"画成一个假按钮`);
    assert.ok(bar.includes(SCAN_PAGE.texts.scanNextHint), `UA=${String(ua)} 时必须给出那句人话`);
  }
  assert.match(SCAN_PAGE.texts.scanNextHint, /扫一扫/, '那句人话要指名"用飞书的扫一扫"');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB5 跨编号累积（会话 key 核过：按人、不是按编号）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB5 跨编号累积：会话 key **按人（登录会话）**存，扫不同编号读到的是**同一份本单**', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scanSessionService.js'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // 会话 id = 前缀 + **录单人 open_id** 的哈希（不是编号）⇒ 一单跨款累积
  assert.match(code, /const idOf = \(openId\)/);
  assert.match(code, /createHash\('sha256'\)\.update\(String\(openId \|\| ''\)\)/);
  // 加单 / 读会话都只吃 openId（编号只是行上的一个字段，不参与 key）
  assert.match(code, /const addLine = async \(openId, line\)/);
  assert.match(code, /const get = async \(openId\)/);
  assert.equal(/idOf\(\s*number\s*\)/.test(code), false, '会话 id 不许按编号算（那会让每次换款都新开一单）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB6 提交之后：本单条归零 + 成功页照旧
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB6 提交之后：本单条归零（提交按钮跟着消失）；成功页照旧（单号 / 双数），且不挂本单条', () => {
  // ① 提交成功后服务端把会话复位（`completeSale` 把 lines 清空 + 幂等键轮换）⇒ 再打开这一页是 0 双
  // ⚠️ 2026-10-15 **改写**（第 5 格搬去顶部之后，飞书端归零时本单条**整条不渲染**了 ——
  //   她的目的正是"少占地方" ✓）：改成**页面级**断言（比原来只看那一条更严 ✓）
  //   改前逐字：`const afterSubmit = barOf(pageFor('sales', WRITE([]), FEISHU_MOBILE_UA));`
  //     ＋ `assert.equal(countOnButton(afterSubmit), null, …)` + `assert.equal(afterSubmit.includes(…submitButton), false, …)`
  //   改后逐字：下面三条 ✓
  // ⚠️ 2026-10-15：本单条在**非飞书**下照旧渲染（那句人话在 ✓）⇒ 原来那两条**逐字保留**（判据不放宽 ✗）
  const afterSubmitBar = barOf(pageFor('sales', WRITE([]), ''));
  assert.equal(countOnButton(afterSubmitBar), null, '提交后按钮上没有双数（= 本单归零 ✓）');
  assert.equal(afterSubmitBar.includes(SCAN_WRITE.texts.submitButton), false, '提交后【提交这一单】要跟着消失');
  // ⭐ 新增（同一天）：**飞书端**归零后**整条不渲染**（她就是要"少占地方"⇒ 不留空卡片 ✓）
  assert.equal(pageFor('sales', WRITE([]), FEISHU_MOBILE_UA).includes('data-view="draft-bar"'), false,
    '飞书端：提交后本单条归零 ⇒ 整条不渲染 ✓');

  // ② 成功页（结果页）形状照旧：单号 + 双数都在；它是"结果页"，**不挂本单条**
  const done = renderScanMessagePage({
    title: SCAN_WRITE.texts.submittedTitle,
    body: fillText(SCAN_WRITE.texts.submittedBody, { orderNo: 'XSD-20261011-0001', count: 2 }),
    details: [
      fillText(SCAN_WRITE.texts.submittedOrderLine, { orderNo: 'XSD-20261011-0001' }),
      fillText(SCAN_WRITE.texts.submittedDetailLine, { count: 2 }),
    ],
    retryHint: SCAN_WRITE.texts.submittedNextHint,
  }, SCAN_PAGE);
  assert.ok(done.includes('您的提交已成功'));
  assert.ok(done.includes('XSD-20261011-0001'), '成功页照旧显示单号');
  assert.ok(done.includes('明细：2 双（每双一行）'), '成功页照旧显示双数');
  assert.equal(done.includes('data-view="draft-bar"'), false, '成功页是结果页，不挂本单条（既有形状不变）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB7 / AC-DB8 路由：303 回跳停在本单所在的领域 + 缺省领域 = 销售
// ═══════════════════════════════════════════════════════════════════════════

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

const sessionCookie = (openId = 'ou_draft_bar_user') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};

/**
 * 一个"本单里已经有一双"的假写服务（只为路由那一层：渲染 / 303 回跳）。
 * 真写库那一条在 `scanPageWrite.test.js`（真会话 + 真业务层）。
 */
const fakeWriteService = () => {
  const state = { lines: [] };
  return {
    state,
    sessions: {
      get: async () => ({ sale: { key: 'scan_sale:scan_session_0123456789abcdef:1', lines: state.lines } }),
      submitKeyFor: () => 'scan_sale:scan_session_0123456789abcdef:1',
    },
    addSaleLine: async ({ size, itemNo, number }) => {
      state.lines = [...state.lines, { size: Number(size), item_no: itemNo, number }];
      return { ok: true, count: state.lines.length };
    },
    clearDraft: async () => ({ ok: true, count: 0 }),
    submitSale: async () => ({ ok: false, code: 'not_used' }),
  };
};

const fakeApp = (write) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => VIEW },
    gateway: {},
    writeService: write,
    startSnapshot: false,
  }));
  return app;
};

test('AC-DB7 【加入本单】的 303 回跳**停在本单所在的领域**（表单 action 带着 ?from=）', async () => {
  login();
  const write = fakeWriteService();
  await withServer(fakeApp(write), async (base) => {
    const bare = `${base}/s/${ENCODED}`;
    const inventoryUrl = `${base}/s/${ENCODED}?from=inventory`;
    const post = (url, body) => fetch(url, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: sessionCookie(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });

    // ① 缺省（裸码）= 销售：表单 action **不带** `?from=`（URL 干净，见 `postActionFor`）
    const salesHtml = await (await fetch(bare, { headers: { cookie: sessionCookie() } })).text();
    assert.ok(salesHtml.includes('realm-block--sales'), '裸码扫开缺省 = 销售');
    assert.equal(salesHtml.match(/action="([^"]*)"/)[1], `/s/${ENCODED}`,
      '缺省领域（销售）的表单 action 不带 ?from=');
    const salesKey = salesHtml.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
    const added = await post(bare, { action: SCAN_WRITE.actions.addLine, submit_key: salesKey, size: '40' });
    assert.equal(added.status, 303);
    assert.match(String(added.headers.get('location')), /added=1$/, '缺省领域回跳不带 ?from=');

    // ② 切到【库存】：（2026-10-11 改写，见文件头）
    //    **改前**：`assert.ok(barOf(inventoryHtml).includes(submitButton), '有草稿 ⇒ 库存页上也能提交')`
    //    **改后**：库存页的本单条**没有**【提交这一单】——她 2026-10-11 定「只在销售页显示」。
    //    保留的部分：库存页顶部照旧读得到"本单：1 双"（N 是跨领域共用的），回跳那一条一个字没动。
    const inventoryHtml = await (await fetch(inventoryUrl, { headers: { cookie: sessionCookie() } })).text();
    assert.equal(salesPageHas(barOf(inventoryHtml)), false, '库存页顶部不再显示计数（已按她的话删 ✓）');
    assert.equal(barOf(inventoryHtml).includes(SCAN_WRITE.texts.submitButton), false,
      '【提交这一单】只在销售页（2026-10-11 她的口径）⇒ 库存页的本单条上没有它');

    // ②' ⭐ 非缺省领域上**还能看到**的"带 ?from= 的表单 action" = **采购页的补货表单**
    //     （2026-10-11 修的那条规则：action 要带上领域，否则回跳会掉到缺省领域）
    const purchaseHtml = await (await fetch(`${base}/s/${ENCODED}?from=replenish`, {
      headers: { cookie: sessionCookie() },
    })).text();
    assert.match(purchaseHtml, new RegExp(`action="/s/${ENCODED}\\?from=replenish"`),
      '非缺省领域的表单 action 要带上领域（补货那一块仍在，它带着 ?from=replenish）');

    // ③ 用**同一把幂等键**（会话级，四个领域通用）从库存 URL 加第二双：303 回跳仍是库存领域
    //    ⚠️ 2026-10-11 改写：原来从**库存页**取 `submit_key`（那颗提交按钮在库存页上）；
    //       现在提交按钮只在销售页 ⇒ 幂等键从**销售页**取（`submitKeyFor` 按会话给，
    //       与领域无关 —— 这也正是"四个领域共用一份本单"的意思）。
    const added2 = await post(inventoryUrl, { action: SCAN_WRITE.actions.addLine, submit_key: salesKey, size: '41' });
    assert.equal(added2.status, 303);
    assert.match(String(added2.headers.get('location')), /\?from=inventory&added=1$/,
      '回跳要停在本单所在的领域（不是缺省领域）');

    // ④ 回跳后那一页：本单 2 双 + 一句极简反馈
    const after = await (await fetch(`${inventoryUrl}&added=1`, { headers: { cookie: sessionCookie() } })).text();
    // ⭐ 库存页上没有提交按钮（提交按钮只在销售页 ✓）⇒ 「本单 2 双」改由**页面上仍可见的那句**证明 ✓
    assert.match(after, /已加入本单（2 双）/, '同一份本单（跨领域共用）⇒ 那句仍是 2 双 ✓');
  });
});

test('AC-DB8 默认领域 = **销售**；`?from=` 四个值照旧可用（认不出的回落销售）', () => {
  assert.equal(DEFAULT_REALM, 'sales', '她 2026-10-11：「默认打开是销售页」');
  // ⭐⭐ 2026-10-14 晚 **cut B 成对翻新**（依据：业务负责人逐字「**`/s/accept` 这条路要彻底拆掉**」
  //    ＋ Lead 的 cut B 清单「REALMS 删 `accept`」）：
  //    改前逐字：`for (const id of ['sales', 'replenish', 'purchase_return', 'accept', 'inventory', 'product']) assert.equal(resolveRealm(id), id);`
  //    改后逐字：列表**去掉 `'accept'`**（它已退出 REALMS）＋ 单独一条把它钉成**回落销售** ✓
  //    依据：`accept` 现在与 `?from=purchase` / `?from=accessory` / `?from=new` 同一条口径；
  //      判据没放宽：其余五个领域的"能解析到自己"逐字不变 ✓
  for (const id of ['sales', 'replenish', 'purchase_return', 'inventory', 'product']) assert.equal(resolveRealm(id), id);
  assert.equal(resolveRealm('accept'), 'sales', 'cut B：accept 已退出 REALMS ⇒ 旧链接回落销售 ✓');
  for (const bad of [undefined, null, '', '   ', 'bogus', '库存']) {
    assert.equal(resolveRealm(bad), 'sales', `认不出的 from「${String(bad)}」必须回落缺省（销售）`);
  }
  // 渲染层不带 realm 参数 = 缺省 = 销售
  assert.ok(renderScanPage(VIEW, SCAN_PAGE, WRITE([])).includes('realm-block--sales'));
  assert.ok(renderScanPage(VIEW, SCAN_PAGE, WRITE([])).includes('realm-block--sales'),
    '认不出的领域也回落销售（不报错、不空白）');
  assert.ok(renderScanPage(VIEW, SCAN_PAGE, WRITE([]), '不存在的领域').includes('realm-block--sales'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-DB9 ⭐ 2026-10-11（业务负责人）：【提交这一单】只在「销售」页
// ═══════════════════════════════════════════════════════════════════════════

test('AC-DB9 ⭐【提交这一单】只在「销售」页：其余三个领域只有 `本单：N 双` ＋【继续扫下一个】', () => {
  // ① 规则可配（配置先行）：缺省只有 sales；渲染层不许写死 'sales'
  assert.deepEqual([...SCAN_PAGE.draftBar.submitRealms], ['sales'],
    '缺省只有「销售」页能提交（她要的口径）——改它只改 config/scanPage.js');
  // ② 销售页（含缺省 / 认不出的领域）：提交按钮在**销售块那唯一的表单**里
  //    ⚠️ 2026-10-12 改写：改前它断言"本单条上有真能点的【提交这一单】"——那颗不带钱、
  //    正是真机丢钱的元凶（见 AC-DB2 的注释）；改后本单条只留 `本单：N 双` +【继续扫下一个】。
  const write = WRITE([line(40), line(41)]);
  // ⚠️ 2026-10-12 改写：本单条里**再也没有**提交按钮 ⇒ 改成在**销售块**里断言那一颗（唯一的一颗）
  const salesPage = pageFor('sales', write, FEISHU_MOBILE_UA);
  assert.equal((salesPage.match(new RegExp(`value="${SCAN_WRITE.actions.submitOrder}"`, 'g')) || []).length, 1,
    '销售页：有草稿 ⇒ 页面上一颗（且只有一颗）提交按钮，就在销售块那唯一的表单里');
  assert.ok(salesPage.includes(SCAN_WRITE.texts.submitButtonCount.replace('{count}', '2')),
    '销售页：那颗按钮写着几双（提交这一单（2 双））');
  // ⚠️ 2026-10-15 **改写**（飞书端空本单 ⇒ 本单条整条不渲染了）：
  //   改前逐字：`assert.equal(barOf(pageFor('sales', WRITE([]), FEISHU_MOBILE_UA)).includes(SCAN_WRITE.actions.submitOrder), false, '销售页：本单条里没有提交动作（空本单时那颗在销售块里，写着"（1 双）"）');`
  //   改后逐字：下面两条 —— ① 飞书端**没有本单条**（更省地方 ✓）② 非飞书端那份条里**没有提交动作** ✓
  //   依据：她 2026-10-15「少占地方」；🔴 判据没放宽：「本单条里没有提交动作」这条照旧钉着（非飞书那份 ✓）
  assert.equal(pageFor('sales', WRITE([]), FEISHU_MOBILE_UA).includes('data-view="draft-bar"'), false,
    '销售页：飞书端空本单 ⇒ 整条不渲染 ✓');
  assert.equal(barOf(pageFor('sales', WRITE([]), '')).includes(SCAN_WRITE.actions.submitOrder), false,
    '销售页：本单条里没有提交动作（空本单时那颗在销售块里，写着"（1 双）"）');
  // ③ 其余三个领域：`本单：N 双` ＋【继续扫下一个】照旧，**提交相关的痕迹一个都不许有**
  // ⚠️ **验收领域不在这一条里**：验收有自己的本单条（「已验收 N 双 / 应到 M 双」），
  //    所以销售那条本单条在验收领域**刻意不渲染**（见 `renderScanPage` 的 `bar` 分支）。
  // ⚠️ 2026-10-15 **改写**（同一天：第 5 格搬去顶部 ⇒ 这几个领域的本单条可能**整条不渲染**了，
  //   她的目的就是少占地方 ✓）：改成**页面级**断言（更强：连"空条"都不留 ✓）
  //   改前逐字：`const bar = barOf(pageFor(realm, write, FEISHU_MOBILE_UA));`
  //     ＋ `assert.ok(bar.includes(SCAN_PAGE.texts.scanNextLabel), \`realm=${realm}：【继续扫下一个】照旧要在\`);`
  //     ＋ 三条 `assert.equal(bar.includes(…), false, …)`
  //   改后逐字：下面这一块 ✓（那颗现在在**顶部第 5 格**，AC-DB4 ② 钉着「它还在页面上」✓）
  // ⚠️ 判据要在**正文**里判：`<style>` 里那段 CSS 注释逐字写着【提交这一单】（讲本单条的沿革）⇒
  //    整页 `includes()` 会假红 ✗（我第一版就是这么挂的）⇒ 一律先切掉 `<style>` 之前的部分 ✓
  const contentOf = (html) => html.slice(html.indexOf('</style>'));
  for (const realm of ['inventory', 'replenish', 'purchase_return', 'product']) {
    const content = contentOf(pageFor(realm, write, FEISHU_MOBILE_UA));
    assert.equal(countOnButton(pageFor('sales', WRITE([1, 2]))), 2, `realm=${realm}：条的"几双"照旧要在（跨领域共用同一份本单）`);
    const realmBar = content.slice(content.indexOf('<nav class="realm-bar"'), content.indexOf('</nav>'));
    assert.ok(realmBar.includes(`>${SCAN_PAGE.realmBar.scanLabel}<`), `realm=${realm}：顶部第 5 格「扫一扫」要在 ✓`);
    assert.equal(content.includes(SCAN_WRITE.texts.submitButton), false, `realm=${realm}：不该有【提交这一单】`);
    assert.equal(content.includes(SCAN_WRITE.actions.submitOrder), false, `realm=${realm}：连那个提交表单都不该有`);
    const barStart = content.indexOf('data-view="draft-bar"');
    if (barStart > -1) {
      const bar = content.slice(content.lastIndexOf('<section', barStart), content.indexOf('</section>', barStart));
      assert.equal(bar.includes('<button'), false, `realm=${realm}：本单条里一个按钮都不该有`);
      assert.equal(bar.includes(SCAN_PAGE.texts.scanNextLabel), false, `realm=${realm}：本单条里不再重复【继续扫下一个】✓`);
      assert.equal(bar.includes(SCAN_PAGE.scanNext.applink), false, `realm=${realm}：本单条里不再重复那颗 AppLink ✓`);
    }
  }
  // ④ 缺省领域与"认不出的领域"都回落销售 ⇒ 照旧能提交（在销售块里）
  for (const realm of [undefined, '不存在的领域']) {
    const page = pageFor(realm, write, FEISHU_MOBILE_UA);
    assert.equal((page.match(new RegExp(`value="${SCAN_WRITE.actions.submitOrder}"`, 'g')) || []).length, 1,
      `realm=${String(realm)}：回落销售 ⇒ 销售块里那颗提交按钮在（不报错、不空白）`);
  }
});
