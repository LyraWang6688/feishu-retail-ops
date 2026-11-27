'use strict';

/**
 * 2026-11-27：print-intent 的 catch 里用了 logError，但文件只 import 了 logWarn。
 * 本用例让 service 真抛错：必须返回 502 JSON + 记 inventory.print.intent.request_failed，
 * 不允许 catch 自己再抛 ReferenceError 变成 500。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const logger = require('../src/utils/logger');
const events = [];
const originalLogError = logger.logError;
logger.logError = (event, meta) => events.push({ event, meta });

const runtimePath = require.resolve('../src/services/inventoryPrintIntentRuntime');
require.cache[runtimePath] = {
  id: runtimePath,
  filename: runtimePath,
  loaded: true,
  exports: {
    getInventoryPrintIntentService: () => ({
      request: async () => { throw new Error('print intent boom'); },
    }),
  },
};

const { createInventoryAdjustmentRouter } = require('../src/routes/workbenchInventoryAdjustment');
const { PAIR_ADJUSTMENT_TEXTS } = require('../src/config/inventoryPairAdjustment');

const withServer = async (run) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.workbenchUser = { open_id: 'ou_print' }; next(); });
  app.use('/adjust', createInventoryAdjustmentRouter({
    inventory: {}, pairService: {}, seasonAdjustment: {}, asyncJobs: {},
  }));
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  server.keepAliveTimeout = 1;
  try {
    await run('http://127.0.0.1:' + server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

test('print-intent 异常：返回 502 JSON，并记 request_failed（不是 500 / ReferenceError）', async () => {
  events.length = 0;
  try {
    await withServer(async (base) => {
      const res = await fetch(base + '/adjust/pairs/job_print/print-intent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.error, PAIR_ADJUSTMENT_TEXTS.printIntentNotFound);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'inventory.print.intent.request_failed');
      assert.equal(events[0].meta.job_id, 'job_print');
    });
  } finally {
    logger.logError = originalLogError;
  }
});
