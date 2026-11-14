'use strict';

/**
 * 团购券结算 · 通知接线（2026-11-14 审计修复）。
 *
 * 真实缺口：app.js 里 `createNotificationService()` 不传 client ⇒ 发 Card 时
 * 拿不到 `client.cardkit`，结算通知**必失败**（而且只 warn，运营群收不到）。
 * 判据：必须用 `createDefaultNotificationService()`（内部 `createDefaultClient()`）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
const notificationSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'notificationService.js'), 'utf8',
);

test('AC-VWA-1 团购券结算通知必须用带默认客户端的工厂', () => {
  assert.match(appSource, /const voucherNotifications = createDefaultNotificationService\(\);/,
    'app.js 必须用 createDefaultNotificationService() 构造结算通知');
  assert.doesNotMatch(appSource, /const voucherNotifications = createNotificationService\(\);/,
    'app.js 不许用无 client 的 createNotificationService() 构造结算通知');
});

test('AC-VWA-2 工厂必须真实存在且内部创建客户端', () => {
  assert.match(notificationSource, /const createDefaultNotificationService = \(\) => createNotificationService\(\{ client: createDefaultClient\(\) \}\)/,
    'notificationService 必须导出 createDefaultNotificationService（内部 createDefaultClient）');
});
