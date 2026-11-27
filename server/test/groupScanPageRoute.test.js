'use strict';

/**
 * 2026-11-27：货品组扫码页
 *   · 限流器换成项目自己的 createRateLimit（Nginx X-Forwarded-For 不再触发
 *     express-rate-limit 的 ERR_ERL_UNEXPECTED_X_FORWARDED_FOR）；
 *   · 成功打开组页记一条 group.scan.viewed（group_id / from / member_count / mode）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

process.env.LARK_AGENT_APP_ID = 'cli_group';
process.env.LARK_AGENT_APP_SECRET = 'group_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = 'test_group_base';
process.env.LARK_WEB_AUTH_ENABLED = 'true';
process.env.LARK_WEB_SESSION_SECRET = 'group_scan_secret';
delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;

const logger = require('../src/utils/logger');
const events = [];
const originalLogInfo = logger.logInfo;
logger.logInfo = (event, meta) => events.push({ event, meta });

const { createGroupScanPageRouter } = require('../src/routes/groupScanPage');

const GROUP = {
  recordId: 'rec_g1',
  name: 'JXN9573',
  total: 2,
  members: [
    { recordId: 'rec_a', number: '9573-28|黑色|女', total: 2 },
    { recordId: 'rec_b', number: '9573-45|黑色|女', total: 0 },
  ],
};

const cookie = (() => {
  const payload = Buffer.from(JSON.stringify({ open_id: 'ou_group', name: 'group', exp: Date.now() + 36e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'group_scan_secret').update(payload).digest('base64url');
  return 'workbench_session=' + payload + '.' + sig;
})();

const withServer = async (run) => {
  const app = express();
  app.use('/g', createGroupScanPageRouter({
    gateway: {},
    service: { get: async (id) => (id === 'rec_g1' ? GROUP : null) },
    scanPageService: { lookup: async () => null },
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

test('组页带 X-Forwarded-For 不再 500，并记 group.scan.viewed', async () => {
  events.length = 0;
  try {
    await withServer(async (base) => {
      const res = await fetch(base + '/g/rec_g1?from=sales', {
        headers: { cookie, 'x-forwarded-for': '36.143.174.87' },
      });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /请选择货品/);
      assert.equal(events.length, 1);
      assert.equal(events[0].event, 'group.scan.viewed');
      assert.deepEqual(events[0].meta, {
        group_id: 'rec_g1', from: 'sales', member_count: 2, mode: 'picker',
      });
    });
  } finally {
    logger.logInfo = originalLogInfo;
  }
});

test('源码哨兵：组路由必须用项目限流器，且保留 group.scan.viewed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'groupScanPage.js'), 'utf8');
  assert.equal(src.includes("require('express-rate-limit')"), false, '不许再用裸 express-rate-limit');
  assert.match(src, /createRateLimit\(/);
  assert.match(src, /group\.scan\.viewed/);
});
