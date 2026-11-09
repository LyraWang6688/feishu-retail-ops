'use strict';

/**
 * 数据配置页的「同步团购券数据」按钮端点。
 *
 * AC-VS-R1 ⭐ POST 触发同步，返回写入条数；
 * AC-VS-R2 ⭐ 未配账号 ⇒ 400 + 人话（不写表）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createWorkbenchDouyinRoutes } = require('../src/routes/workbench/douyin');

const listen = (app) => new Promise((resolve) => {
  const server = app.listen(0, '127.0.0.1', () => {
    server.keepAliveTimeout = 1;
    resolve({ server, port: server.address().port });
  });
});

const fakeSync = (result) => ({ run: async () => result });

test('AC-VS-R1 ⭐ 按钮触发同步 ⇒ 200 + 写入条数', async () => {
  const app = express();
  app.use(express.json());
  app.use(createWorkbenchDouyinRoutes({
    voucherCatalogConfig: { accountId: 'a', statusMap: {}, texts: {} },
    gateway: { table: () => ({ fields: {} }), listAll: async () => [], update: async () => ({}) },
    laike: { fetchProductList: async () => ({ ok: true, data: { products: [] } }), fetchSkus: async () => ({ ok: true, data: {} }), fetchProduct: async () => ({ ok: true, data: {} }) },
  }));
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/douyin/voucher-catalog-sync`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.written, 0);
    assert.equal(body.voucherRows, 0);
  } finally {
    server.close();
  }
});

test('AC-VS-R2 ⭐ 未配账号 ⇒ 400（不写表）', async () => {
  const seen = [];
  const app = express();
  app.use(express.json());
  app.use(createWorkbenchDouyinRoutes({
    voucherCatalogConfig: { accountId: '', texts: { accountMissing: '没配账号' } },
    gateway: { table: () => ({ fields: {} }), listAll: async () => { seen.push('read'); return []; } },
    laike: { fetchProductList: async () => ({ ok: true, data: {} }), fetchSkus: async () => ({ ok: true, data: {} }), fetchProduct: async () => ({ ok: true, data: {} }) },
  }));
  const { server, port } = await listen(app);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/douyin/voucher-catalog-sync`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.success, false);
    assert.equal(seen.length, 0, '没配账号 ⇒ 表都不读');
  } finally {
    server.close();
  }
});
