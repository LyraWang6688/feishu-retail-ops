'use strict';

/**
 * ⭐⭐ 2026-10-13「金额两步走」第 2 步：**提交整单付款**（业务负责人逐字：「**当然啊，可以写也可以不写啊**」）。
 *
 * 口径：
 *   · 填了 ⇒ **当场**走**既有那条诚实钱路** `followup.addPayment(...)`（= 工作台「补记收款」同一条链）
 *   · 没填 / 跳过 ⇒ **零写入** + 记成「**待补充的信息包**」（**不是失败** ✗ 不报错 ✓）
 *   · 🔴 三条红线：**写成功才说"已收"** ✓ · **失败就明说失败**（不假装 ✓）· **幂等沿既有 `requestId`**（**不许自造** ✗）
 *
 * ⚠️ 实现先于本文件落地（如实说明 ✓）；但 PAY3 用的是**会抛错的假件** ⇒ 若产品把失败吞掉/装成功，它**会红** ✓
 *    ⇒ 这几条**测的是真行为**，不是走过场。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_pay_step';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'pay_step_secret';

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { createScanPageRouter } = require('../src/routes/scanPage');

const SERVER = path.join(__dirname, '..');
const ROUTE_SRC = fs.readFileSync(path.join(SERVER, 'src/routes/scanPage.js'), 'utf8');

const SESSION_SECRET = 'scan_pay_step_session_secret';
const sessionCookie = (openId = 'ou_pay_step') => {
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};

/** 假的钱路替身：记下每一次 `addPayment` 的入参（并可按需抛错 / 返回 !ok）。 */
const makeFakeFollowup = ({ fail = false, notOk = false } = {}) => {
  const calls = [];
  return {
    calls,
    async addPayment(input) {
      calls.push(input);
      if (fail) throw new Error('假的写入失败');
      if (notOk) return { ok: false, message: '假的未成功' };
      return { ok: true };
    },
  };
};

const view = () => ({
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 1,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-13 18:00',
});

const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const i = app.listen(0, () => resolve(i)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const post = (base, cookie, body) => fetch(`${base}/s/${encodeURIComponent('YD6693-2|黑色|A')}?from=sales`, {
  method: 'POST',
  redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

const formFieldsOf = (html, marker) => {
  const form = (html.match(/<form[^>]*>[\s\S]*?<\/form>/g) || []).find((item) => item.includes(marker)) || '';
  const out = {};
  for (const input of form.match(/<input[^>]*>/g) || []) {
    const name = (input.match(/name="([^"]*)"/) || [])[1];
    const value = (input.match(/value="([^"]*)"/) || [])[1] || '';
    if (name) out[name] = value.replace(/&amp;/g, '&');
  }
  return { form, fields: out };
};

const buildApp = (followup) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup: async () => view() },
    // 付款这条路**只用钱路替身**（不读表、不碰草稿）⇒ 网关/写服务给最小形状即可 ✓
    gateway: {},
    writeService: {},
    followup,
  }));
  return app;
};

/** 直接打第 2 步【提交整单付款】（那张表单的隐藏字段 + 她填的方式/金额）。 */
const payAt = (base, cookie, extra = {}) => post(base, cookie, {
  action: SCAN_PAGE.paymentStep.payAction,
  submit_key: 'scan_sale:test:1',
  order_no: 'XSD-20261013-0001',
  count: '1',
  sales_entry_record_id: 'rec_sales_entry_1',
  ...extra,
});

const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};

test('PAY1 ⭐ 填了付款 ⇒ 走**既有那条链** `addPayment` 一次，参数逐字（方式/金额）', async () => {
  login();
  const followup = makeFakeFollowup();
  await withServer(buildApp(followup), async (base) => {
      const cookie = sessionCookie();
      const paid = await payAt(base, cookie, {
        [SCAN_WRITE.fields.paymentMethod]: '现金',
        [SCAN_WRITE.fields.paymentAmount]: '399',
      });
      assert.equal(paid.status, 200);
      assert.equal(followup.calls.length, 1, '只调一次 addPayment');
      assert.equal(followup.calls[0].method, '现金', '方式逐字');
      assert.equal(String(followup.calls[0].amount), '399', '金额逐字');
      // ⚠️ 合成 POST 没有会话上下文 ⇒ requestId 可能为空串；这里只钉「键在、且由路由统一给」 ✓
      //    真正要钉的「两次同一个键、不许自造」见 PAY4
      assert.ok('requestId' in followup.calls[0], '要带既有那个 requestId 键（幂等沿既有 ✓ 不自造 ✗）');
      assert.ok('salesEntryRecordId' in followup.calls[0], '要带上刚提交那张主表的 record_id');
  });
});

test('PAY2 ⭐ 没填 / 跳过 ⇒ **零写入** + 记成「待补充」（不是失败 ✗）', async () => {
  login();
  const followup = makeFakeFollowup();
  await withServer(buildApp(followup), async (base) => {
    const cookie = sessionCookie();
    // ① 付款那一下：金额留空 ⇒ 待补充
    const paid = await payAt(base, cookie, {
      [SCAN_WRITE.fields.paymentMethod]: '', [SCAN_WRITE.fields.paymentAmount]: '',
    });
    const paidHtml = await paid.text();
    assert.equal(paid.status, 200, '不填**不是**失败 ✓');
    assert.equal(followup.calls.length, 0, '不填 ⇒ **一个字都不写** ✓');
    assert.ok(paidHtml.includes(SCAN_PAGE.paymentStep.payPendingNote), '要给她「待补充」那句话');
    assert.equal(/没记上/.test(paidHtml), false, '待补充**不许**说成失败 ✗');
    // ② 走【跳过】⇒ 同样零写入 + 到成功页
    const skipped = await post(base, cookie, {
      action: SCAN_PAGE.paymentStep.skipAction, submit_key: 'scan_sale:test:1',
      order_no: 'XSD-20261013-0001', count: '1',
    });
    const skippedHtml = await skipped.text();
    assert.equal(skipped.status, 200);
    assert.equal(followup.calls.length, 0, '跳过 ⇒ 也一个字都不写 ✓');
    assert.ok(skippedHtml.includes(SCAN_WRITE.texts.submittedTitle), '跳过 ⇒ 成功页 ✓');
  });
});

test('PAY3 🔴 写失败 ⇒ **明说失败** 且 **绝不显示"已收"**（假件抛错 ⇒ 这条一定会红那一路 ✓）', async () => {
  login();
  const followup = makeFakeFollowup({ fail: true });
  await withServer(buildApp(followup), async (base) => {
    const cookie = sessionCookie();
    const paid = await payAt(base, cookie, {
      [SCAN_WRITE.fields.paymentMethod]: '微信', [SCAN_WRITE.fields.paymentAmount]: '399',
    });
    const html = await paid.text();
    assert.equal(followup.calls.length, 1, '确实尝试写了');
    // ⚠️ 别拿配置原串比（页面会把 `"` 转成 `&quot;` ⇒ 原串比必然假红 ✗）⇒ 钉**稳定子串** ✓
    assert.ok(html.includes('没记上'), '要**明说**这笔没记上');
    assert.equal(html.includes(SCAN_PAGE.paymentStep.paidNote), false,
      '🔴 写失败时**不许**出现"已记下这笔收款"（状态不许撒谎 ✗）');
  });
});

test('PAY4 ⭐ 同一 `requestId` 重复提交 ⇒ 幂等沿既有机制（不许自造第二套幂等 ✗）', async () => {
  login();
  const followup = makeFakeFollowup();
  await withServer(buildApp(followup), async (base) => {
    const cookie = sessionCookie();
    const body = {
      [SCAN_WRITE.fields.paymentMethod]: '微信', [SCAN_WRITE.fields.paymentAmount]: '399',
    };
    const first = await payAt(base, cookie, body);
    const second = await payAt(base, cookie, body);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, '第二次也给她一个正常结果（不是报错 ✗）');
    const ids = [...new Set(followup.calls.map((call) => String(call.requestId || '')))];
    assert.equal(ids.length, 1, `requestId 必须是同一个（幂等沿既有 ✓ 不许自造 ✗）实际 ${JSON.stringify(ids)}`);
    assert.equal(followup.calls.length, 2, '两次都真的走了同一条钱路');
  });
});

test('PAY5 源码哨兵：同一条服务链（`SalesFollowupService` + `followup.addPayment(`），无自造写钱路径', () => {
  assert.ok(ROUTE_SRC.includes("require('../services/salesFollowupService')"),
    '必须用既有的 SalesFollowupService（不许自己写一套钱路 ✗）');
  assert.ok(ROUTE_SRC.includes('followup.addPayment('), '必须走既有那条 addPayment ✓');
  assert.ok(!/\.create\(\s*'paymentRecord'/.test(ROUTE_SRC),
    '扫码路由里**不许**直接往「收款明细」建行（那是自造第二条账 ✗）');
  assert.ok(!/new PaymentService\(/.test(ROUTE_SRC), '不许自己 new 一个收款 service（自造钱路 ✗）');
});
