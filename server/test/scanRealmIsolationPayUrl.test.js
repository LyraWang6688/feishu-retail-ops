'use strict';

/**
 * 2026-11-27 大改的验收：URL 决定页面 + 领域隔离 + 资金页独立地址。
 *   · 裸扫 = 库存页，不显示销售「本单」、不进资金页；
 *   · /r/{id}/pay 有 pending ⇒ 资金页；无 pending ⇒ 303 货品页；刷新仍资金页；
 *   · 重扫销售入口清 pending，但售后换款式不清；
 *   · 付款步草稿 ⇒ 303 /pay。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_iso';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'iso_secret';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'iso_session_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const { SCAN_PAGE } = require('../src/config/scanPage');
const { createScanPageRouter } = require('../src/routes/scanPage');

const NUMBER = 'JX505|咖色|女';
const PRODUCT = { record_id: 'prod_1', fields: { 编号: NUMBER, 货号: 'JX505', 颜色: { text: '咖色' }, 类别: '女', 品类: { text: '休闲鞋' }, 单价: 399 } };
const VIEW = () => ({
  found: true, number: NUMBER, item_no: 'JX505', color: '咖色', category_name: '休闲鞋',
  price_text: '¥399', total: 1, columns: [{ key: '门盒', label: '门盒' }],
  rows: [{ size_text: '40', cells: [{ count: 1 }], total: 1, missing: false }],
  missing_count: 0, sizes_degraded: false, notes: [], updated_at_text: 't',
});
const cookie = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_iso', name: 'iso', exp: Date.now() + 36e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'iso_session_secret').update(payload).digest('base64url');
  return 'workbench_session=' + payload + '.' + sig;
})();

let session;
const makeSession = () => ({
  sale: { paymentStep: 'pending', lines: [{ item_no: 'JX505', size: '40', amount: '100' }] },
});
const gateway = {
  table: (key) => require('../src/config/v1BitableSchema').V1_BITABLE_SCHEMA.tables[key],
  get: async (key, id) => (key === 'product' && id === 'prod_1' ? PRODUCT : null),
  listAll: async (key) => (key === 'product' ? [PRODUCT] : []),
  listByFilter: async () => [],
};
const withServer = async (run) => {
  session = makeSession();
  const cleared = [];
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/r', createScanPageRouter({
    gateway, config: SCAN_PAGE, startSnapshot: false,
    service: { lookup: async () => VIEW() },
    writeService: {
      sessions: {
        get: async () => session,
        saveDraftLines: async (id, patch) => {
          cleared.push(patch);
          if (Object.prototype.hasOwnProperty.call(patch, 'paymentStep')) {
            session = { ...session, sale: { ...session.sale, paymentStep: patch.paymentStep, submitPending: undefined } };
          }
        },
        submitKeyFor: () => 'scan_sale:iso:1',
        ensure: async () => ({ session_id: 'sess_iso' }),
        store: { update: async () => {} },
      },
    },
  }));
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    const base = 'http://127.0.0.1:' + server.address().port;
    run(base, cleared).catch(() => {}).finally(() => server.close());
  });
};

const get = async (base, path, redirect = 'follow') =>
  fetch(base + path, { headers: { cookie }, redirect });

test('裸扫=库存页：不显示销售本单、不进资金页', async () => {
  await withServer(async (base) => {
    const skel = await get(base, '/r/prod_1');
    assert.match(await skel.text(), /data-view="scan-skeleton"/, '首屏骨架');
    const res = await get(base, '/r/prod_1?data=1');
    const html = await res.text();
    assert.match(html, /realm-block--inventory/, '落到库存块');
    assert.equal(html.includes('data-view="draft-bar"'), false, '库存页不许出现销售本单条');
    assert.equal(html.includes('data-view="payment-step"'), false, '库存页不许出现资金页');
  });
});

test('/pay：有 pending ⇒ 资金页；刷新仍是资金页；没有 pending ⇒ 303 货品页', async () => {
  await withServer(async (base) => {
    const pay1 = await get(base, '/r/prod_1/pay');
    assert.equal(pay1.status, 200);
    assert.match(await pay1.text(), /data-view="payment-step"/, '独立地址直接渲染资金页');
    const pay2 = await get(base, '/r/prod_1/pay');
    assert.equal(pay2.status, 200, '刷新 /pay 仍是资金页');
    session = { sale: { lines: [] } };
    const back = await get(base, '/r/prod_1/pay', 'manual');
    assert.equal(back.status, 303, '没有 pending 必须 303');
    assert.match(String(back.headers.get('location')), /\/r\/prod_1\?from=sales$/, '回销售货品页');
  });
});

test('/pay 保留货品页确认的下架 ID（否则付款提交会丢空）', async () => {
  await withServer(async (base) => {
    session.sale.delist_product_ids = ['prod_1'];
    const pay = await get(base, '/r/prod_1/pay');
    assert.equal(pay.status, 200);
    assert.match(await pay.text(), /name="delist_product_ids" value="prod_1"/, '资金页必须原样带下架 ID');
  });
});

test('销售入口重扫清 pending；售后换款式不清', async () => {
  await withServer(async (base, cleared) => {
    const sales = await get(base, '/r/prod_1?from=sales');
    assert.match(await sales.text(), /realm-block--sales/);
    assert.ok(cleared.some((p) => Object.prototype.hasOwnProperty.call(p, 'paymentStep')),
      '销售建单入口要清未完成支付');
    cleared.length = 0;
    const exchange = await get(base, '/r/prod_1?from=sales&flow=afterSalesExchange&salesEntryRecordId=e1&detailRecordId=d1&originalAmount=100');
    const html = await exchange.text();
    assert.match(html, /realm-block--sales/, '售后换款式仍是销售块');
    assert.equal(html.includes('data-view="draft-bar"'), false, '售后换款式不许显示销售本单条');
    assert.equal(cleared.length, 0, '售后换款式扫新鞋不许清销售 pending');
  });
});

test('付款步草稿 ⇒ 303 /pay（货品步草稿不变）', async () => {
  const draftRuntimePath = require.resolve('../src/services/salesDraftRuntime');
  const original = require.cache[draftRuntimePath];
  require.cache[draftRuntimePath] = {
    id: draftRuntimePath, filename: draftRuntimePath, loaded: true,
    exports: { getSalesDraftService: () => ({ get: async () => ({ lines: [{ item_no: 'JX505', size: '40', amount: '100' }], step: 'payment' }) }) },
  };
  try {
    await withServer(async (base) => {
      const res = await get(base, '/r/prod_1?from=sales&draft=d1', 'manual');
      assert.equal(res.status, 303, '付款步草稿要跳独立资金页');
      assert.match(String(res.headers.get('location')), /\/r\/prod_1\/pay$/, '落点是 /pay');
    });
  } finally {
    if (original) require.cache[draftRuntimePath] = original;
    else delete require.cache[draftRuntimePath];
  }
});
