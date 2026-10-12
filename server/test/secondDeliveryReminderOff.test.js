'use strict';

/**
 * ⭐ 2026-10-12（业务负责人：「**2 不需要了**」）——
 *    **每日二次交付提醒卡**整条链路退场，但**它里面的「成交」业务动作必须留**（工作台在用 ✗）。
 *
 * 这一批就是那件事的**验收标准**（先写、先红，再删）：
 *   AC-1 不再有每日二次交付卡（定时器不拉起 / 提醒模块不存在 ⇒ 结构上零群调用）
 *   AC-2 群里点**旧**提醒卡 ⇒ 回一句人话（不静默）、**业务表零写入**
 *   AC-3 ⭐ 回归：**工作台的成交**仍然走 `SecondDeliveryService.confirm`
 *   AC-4 ⭐ 回归：**9 点推送**的候选仍然出来（它用的是 `loadItemIndex` / `resolveDetailSize`）
 *   AC-5 退场符号 grep = 0 + `larkCards.js` 导出数 15 → 11
 *   AC-6 兜底那句**逐字**把她指到工作台
 *   AC-7 ⭐ 回归：群里**文字**那条成交（`salesThreadProgressService`）仍在（护栏换锚到活入口）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 这几个是"构造期"要用到的（网关构造函数只读凭证，不联网）
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_e2e_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'secret_e2e_test';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_base_token';

const serverRoot = path.resolve(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(serverRoot, rel), 'utf8');
const GONE = ['sendDailyReminder', '_sendDailyReminder', 'markCardSettled', 'secondDeliveryCard',
  'secondDeliveryOrderLines', 'settleSecondDeliveryOrder', 'startSecondDeliveryReminder',
  'secondDeliveryReminder', 'reminder_day', 'SECOND_DELIVERY_ACTION',
  'handleSecondDeliveryAction', 'config/secondDeliveryCard'];
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
  return /\.(js|cjs|mjs|json)$/.test(entry.name) ? [full] : [];
});
const readAll = (dir) => walk(dir).map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }));

test('AC-1 不再有每日二次交付卡：定时器不拉起、提醒模块不存在（结构上不可能再发群）', () => {
  const app = src('src/app.js');
  assert.equal(/secondDeliveryReminder|startSecondDeliveryReminder/.test(app), false,
    'app.js 里不许再有"每日提醒"的拉起');
  assert.equal(/sendDailyReminder/.test(app), false, 'app.js 里不许再调每日提醒');
  assert.equal(fs.existsSync(path.join(serverRoot, 'src/utils/secondDeliveryReminder.js')), false,
    '提醒模块本身必须已删除');
  // ⭐ 零群调用：那个模块连 require 都做不到（不是"跑了但没发"）
  assert.throws(() => require('../src/utils/secondDeliveryReminder'), /Cannot find module/);
});

test('AC-2 群里点**旧**提醒卡 ⇒ 回一句人话（不静默）、业务表零写入', async () => {
  const { LarkMvpService } = require('../src/services/larkMvpService');
  const { UNKNOWN_CARD_ACTION_TOAST } = require('../src/config/unknownCardAction');
  assert.equal('handleSecondDeliveryAction' in LarkMvpService.prototype, false,
    '那条卡片动作分派必须已经退场');
  const writes = [];
  const gateway = new Proxy({}, { get: (_t, key) => (...args) => { writes.push([String(key), args]); return {}; } });
  const service = new LarkMvpService({
    client: { im: { message: { create: async () => { writes.push(['im.message.create', []]); return {}; } } } },
    gateway, references: {}, recognizer: {}, store: {}, posting: {}, afterSales: {}, delivery: {},
  });
  // 老卡片的按钮取值就是这些（没有 draft_id —— 卡不是"销售草稿"）
  const out = await service.handleCardAction({
    action: { value: { action: 'confirm_second_delivery', sales_entry_record_id: 'rec_old', method: '微信' } },
    operator: { operator_id: { open_id: 'ou_old' } },
  });
  assert.equal(out?.toast?.content, UNKNOWN_CARD_ACTION_TOAST, '必须回那句兜底人话（不静默）');
  assert.deepEqual(writes, [], '一个字都不许写、也不许发消息');
});

test('AC-3 ⭐ 回归：工作台的成交仍然走 SecondDeliveryService.confirm（护栏换锚到活入口）', async () => {
  const { WorkbenchOrderActionService } = require('../src/services/workbenchOrderActionService');
  const calls = [];
  const service = new WorkbenchOrderActionService({
    secondDelivery: { confirm: async (input) => { calls.push(input); return { collectedAmount: 199 }; } },
    config: { secondDeliveryEnabled: true, defaultCollectionMethod: '微信' },
  });
  const result = await service.secondDelivery({ salesEntryRecordId: 'rec_1', operatorOpenId: 'ou_1' });
  assert.deepEqual(calls, [{ salesEntryRecordId: 'rec_1', method: '微信', operatorOpenId: 'ou_1' }],
    '工作台的成交必须原样交给 confirm');
  assert.equal(result.collectedAmount, 199);
});

test('AC-4 ⭐ 回归：9 点推送仍用 loadItemIndex / resolveDetailSize（别把它的依赖删了）', () => {
  const { SecondDeliveryService } = require('../src/services/secondDeliveryService');
  for (const name of ['loadItemIndex', 'resolveDetailSize', 'confirm', 'listPendingDeliveries']) {
    assert.equal(typeof SecondDeliveryService.prototype[name], 'function', `${name} 被别的链路用着 ⇒ 必须在`);
  }
  const push = src('src/services/pendingDealPushService.js');
  assert.match(push, /this\.secondDelivery/, '9 点推送仍会取那个 service');
  assert.match(push, /loadItemIndex|resolveDetailSize/, '9 点推送仍用它的两个取数方法');
});

test('AC-5 退场符号 grep = 0 + `larkCards.js` 导出数 15 → 12', () => {
  const hits = [];
  for (const { file, text } of readAll(path.join(serverRoot, 'src')).concat(readAll(path.join(serverRoot, 'test')))) {
    // ⚠️ 这两个文件本身就是「证明它没了」的哨兵（必须写出符号名才能断言不存在）
    if (/secondDeliveryReminderOff\.test\.js$|larkMvpService\.test\.js$|larkCards\.test\.js$/.test(file)) continue;
    for (const symbol of GONE) if (text.includes(symbol)) hits.push(`${path.relative(serverRoot, file)} → ${symbol}`);
  }
  assert.deepEqual(hits, [], `这些符号必须全部消失：\n${hits.join('\n')}`);
  const cards = require('../src/utils/larkCards');
  assert.equal(Object.keys(cards).length, 12, '导出数 = 12（退场前是 15：少了 SECOND_DELIVERY_ACTION / secondDeliveryCard / settleSecondDeliveryOrder 三个）');
  for (const gone of ['secondDeliveryCard', 'SECOND_DELIVERY_ACTION', 'settleSecondDeliveryOrder']) {
    assert.equal(gone in cards, false, `${gone} 不该还在导出里`);
  }
});

test('AC-6 兜底那句**逐字**把她指到工作台（她用得上）', () => {
  const { UNKNOWN_CARD_ACTION_TOAST } = require('../src/config/unknownCardAction');
  assert.equal(UNKNOWN_CARD_ACTION_TOAST,
    '这张卡片已经不适用了哦～现在录入请用扫码页，查询和售后请到工作台～');
  assert.match(UNKNOWN_CARD_ACTION_TOAST, /工作台/, '必须把她指到工作台');
});

test('AC-7 ⭐ 回归：群里**文字**那条成交仍在（salesThreadProgressService → confirm）', () => {
  const flow = src('src/services/salesThreadProgressService.js');
  assert.match(flow, /this\.secondDelivery\.confirm\(/, '群聊文字那条成交不许被牵连');
  const lark = src('src/services/larkMvpService.js');
  assert.equal(/handleSecondDeliveryAction/.test(lark), false, '卡片那条才该退场');
});
