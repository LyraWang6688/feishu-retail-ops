// 「两条每日推送共用的重试 / 告警策略」的直盯用例（`config/pushRetry`）。
//
// 为什么单独一个文件：这份策略**两条链路共用**（9 点待处理单推送 + 二次交付每日提醒），
// 判据与状态机只有这一处实现；两条链路各自的行为用例分别在
// `pendingDealPushRetry.test.js` / `secondDeliveryRetry.test.js`。
// 本文件盯的是最容易静默坏掉的三件：
//   ① **哪些错误算瞬时**（1254607 / 5xx / 429 / 网络中断 ⇒ 重试；权限 / 参数 / 缺配置 ⇒ 绝不重试）；
//   ② 退避表与间隔上限**可配**（指数、封顶、`0` = 不重试、总跨度不许超过一天）；
//   ③ 按天状态机与告警文案的取值规则（显式布尔、占位符启动时校验）。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolvePushRetryConfig, resolveTransientRetryConfig, resolveDailyRetryConfig, resolvePushAlertConfig,
  isTransientLarkError, larkCodeOf, transientRetryDelays, withTransientRetry, resolveDailyAttempt,
  shouldSendFailureAlert, formatPushAlertText, pushFailureReason,
  DEFAULT_TRANSIENT_MAX_RETRIES, DEFAULT_DAILY_RETRY_INTERVAL_MS, DEFAULT_DAILY_RETRY_MAX_RETRIES,
  DEFAULT_ALERT_TEMPLATE, DEFAULT_PENDING_DEAL_PUSH_ALERT_NAME, DEFAULT_SECOND_DELIVERY_ALERT_NAME,
} = require('../src/config/pushRetry');

const withResponse = (status, data) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status, data },
});

test('瞬时判据：飞书"再等一下"类（1254607 / 5xx / 429 / 网络中断）算瞬时', () => {
  const config = resolveTransientRetryConfig({});
  // ① 真机抓到的那一个：HTTP 400 但体内是 1254607。
  assert.equal(isTransientLarkError(withResponse(400, {
    code: 1254607, msg: 'Data not ready, please try again later',
  }), config), true);
  // ② 网关 `assertSuccess` 那条路：不是 HTTP 错，而是响应体 code !== 0（挂在 bitableCode 上）。
  const bitable = Object.assign(new Error('读取“销售订单”记录列表失败: Data not ready (Code: 1254607)'),
    { bitableRejected: true, bitableCode: 1254607 });
  assert.equal(larkCodeOf(bitable), '1254607');
  assert.equal(isTransientLarkError(bitable, config), true);
  // ③ 我们自己 `larkResponseError` 挂的 larkData。
  assert.equal(isTransientLarkError({ larkData: { code: 1254607, msg: 'Data not ready' } }, config), true);
  // ④ HTTP 状态：429 与 5xx（没有 code 时按 HTTP 判）。
  assert.equal(isTransientLarkError(withResponse(429, undefined), config), true);
  assert.equal(isTransientLarkError(withResponse(503, undefined), config), true);
  // ⑤ 网络层：连接被重置 / 超时（请求根本没被处理，重试是安全的）。
  assert.equal(isTransientLarkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), config), true);
  assert.equal(isTransientLarkError(new Error('request timed out'), config), true);
  // ⑥ 人话兜底（有些接口只回一句 msg，没有 code）。
  assert.equal(isTransientLarkError(new Error('Data not ready, please try again later'), config), true);
  assert.equal(isTransientLarkError(new Error('system busy'), config), true);
});

test('瞬时判据：确定性错误（权限 / 参数 / 缺配置）**一个都不算瞬时**', () => {
  const config = resolveTransientRetryConfig({});
  // 权限不够（真机 2026-10-08 上传那次的形状）：重试一万次也不会好。
  assert.equal(isTransientLarkError(withResponse(403, {
    code: 99991672, msg: 'Access denied. One of the following scopes is required: [im:resource:upload]',
  }), config), false);
  // 参数错 / 字段不存在。
  assert.equal(isTransientLarkError(withResponse(400, { code: 1254005, msg: 'FieldNameNotFound' }), config), false);
  // 我们自己的配置错（缺群 id / 缺 client / 缺字段映射）——连飞书都没调到。
  assert.equal(isTransientLarkError(new Error('待处理单推送缺少飞书 client，无法发送群消息'), config), false);
  assert.equal(isTransientLarkError(new Error('未配置查询字段: salesEntry.orderNo'), config), false);
  // 干干净净的 400、什么线索都没有：**不猜**（宁可不重试，也不拿确定性错误反复打飞书）。
  assert.equal(isTransientLarkError(withResponse(400, undefined), config), false);
  assert.equal(isTransientLarkError(new Error('Request failed with status code 404'), config), false);
});

test('瞬时判据可配：认哪些 code 可换、空串 = 一个都不认；退避表可配（指数 / 封顶 / 0 = 不重试）', () => {
  assert.deepEqual(resolveTransientRetryConfig({}).larkCodes, ['1254607']);
  assert.deepEqual(resolveTransientRetryConfig({ PUSH_TRANSIENT_RETRY_LARK_CODES: '1254607,1254291' }).larkCodes,
    ['1254607', '1254291']);
  assert.deepEqual(resolveTransientRetryConfig({ PUSH_TRANSIENT_RETRY_LARK_CODES: '' }).larkCodes, [],
    '空串 = 显式"一个都不认"（不是回退默认）');
  const custom = resolveTransientRetryConfig({
    PUSH_TRANSIENT_RETRY_LARK_CODES: '1254291',
  });
  assert.equal(isTransientLarkError(withResponse(400, { code: 1254607 }), custom), false,
    '换了认的 code 之后，老的那个就不再重试');

  // 退避表：指数 + 封顶；默认 1s → 2s（2 次重试 = 共 3 次尝试）。
  assert.equal(DEFAULT_TRANSIENT_MAX_RETRIES, 2);
  assert.deepEqual(transientRetryDelays(resolveTransientRetryConfig({})), [1000, 2000]);
  assert.deepEqual(transientRetryDelays(resolveTransientRetryConfig({
    PUSH_TRANSIENT_RETRY_MAX_RETRIES: '3', PUSH_TRANSIENT_RETRY_BASE_DELAY_MS: '500',
    PUSH_TRANSIENT_RETRY_FACTOR: '3', PUSH_TRANSIENT_RETRY_MAX_DELAY_MS: '3000',
  })), [500, 1500, 3000], '指数 500 → 1500 → 4500 被 3000 封顶');
  assert.deepEqual(transientRetryDelays(resolveTransientRetryConfig({ PUSH_TRANSIENT_RETRY_MAX_RETRIES: '0' })), [],
    '显式 0 = 不重试（瞬时层关掉）');
});

test('瞬时执行器：瞬时错误按表重试后成功；确定性错误一次都不重试；用完了抛出', async () => {
  const delays = [];
  const config = resolveTransientRetryConfig({});
  let attempts = 0;
  const succeeded = await withTransientRetry(async () => {
    attempts += 1;
    if (attempts <= 2) throw withResponse(400, { code: 1254607, msg: 'Data not ready' });
    return 'ok';
  }, { operation: 'test.read', config, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(succeeded, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);

  // 确定性：只调用一次，且不留睡眠。
  const delays2 = [];
  let deterministicAttempts = 0;
  await assert.rejects(() => withTransientRetry(async () => {
    deterministicAttempts += 1;
    throw withResponse(403, { code: 99991672, msg: 'Access denied' });
  }, { operation: 'test.send', config, sleep: async (ms) => { delays2.push(ms); } }), /status code 403/);
  assert.equal(deterministicAttempts, 1);
  assert.deepEqual(delays2, []);

  // 用完了：仍然抛出最后一个错误（交给按天层 / 告警兜底）。
  let exhaustedAttempts = 0;
  await assert.rejects(() => withTransientRetry(async () => {
    exhaustedAttempts += 1;
    throw withResponse(500, undefined);
  }, { operation: 'test.read', config, sleep: async () => {} }), /status code 500/);
  assert.equal(exhaustedAttempts, 3);
});

test('按天状态机：没有记录 → 第一次；出门在外（completed/running）→ 不发；failed → 按偏移等 / 用完', () => {
  const delays = [10 * 60 * 1000, 20 * 60 * 1000];
  const nowMs = Date.parse('2026-10-08T01:05:00.000Z');
  assert.deepEqual(resolveDailyAttempt({ record: null, nowMs, retryDelaysMs: delays }),
    { attempt: true, attemptNumber: 1, reason: '' });
  assert.equal(resolveDailyAttempt({
    record: { status: 'completed', sent: true }, nowMs, retryDelaysMs: delays,
  }).reason, 'already_ran_today');
  assert.equal(resolveDailyAttempt({
    record: { status: 'running', attempts: 1 }, nowMs, retryDelaysMs: delays,
  }).reason, 'in_progress');
  assert.equal(resolveDailyAttempt({
    record: { status: 'failed', attempts: 1 }, nowMs, retryDelaysMs: [],
  }).reason, 'retry_disabled');

  const failedAt = '2026-10-08T01:05:00.000Z';
  // 没到点。
  const waiting = resolveDailyAttempt({
    record: { status: 'failed', attempts: 1, first_failed_at: failedAt }, nowMs: nowMs + 9 * 60 * 1000, retryDelaysMs: delays,
  });
  assert.equal(waiting.attempt, false);
  assert.equal(waiting.reason, 'retry_waiting');
  assert.equal(waiting.nextRetryAt, '2026-10-08T01:15:00.000Z');
  // 到点 ⇒ 第 2 次（偏移按**首次失败**算，不是"上一次失败之后再等"）。
  const due = resolveDailyAttempt({
    record: { status: 'failed', attempts: 1, first_failed_at: failedAt }, nowMs: nowMs + 10 * 60 * 1000, retryDelaysMs: delays,
  });
  assert.deepEqual(due, { attempt: true, attemptNumber: 2, reason: '' });
  // 次数用完（attempts > 窗口长度）。
  assert.equal(resolveDailyAttempt({
    record: { status: 'failed', attempts: 3, first_failed_at: failedAt }, nowMs: nowMs + 60 * 60 * 1000, retryDelaysMs: delays,
  }).reason, 'retries_exhausted');
});

test('按天策略：默认每 10 分钟 × 6；总跨度不许超过一天；告警开关/群/名字/文案都可配', () => {
  assert.equal(DEFAULT_DAILY_RETRY_INTERVAL_MS, 10 * 60 * 1000);
  assert.equal(DEFAULT_DAILY_RETRY_MAX_RETRIES, 6);
  assert.deepEqual(resolveDailyRetryConfig({}).retryDelaysMs, [600000, 1200000, 1800000, 2400000, 3000000, 3600000]);
  assert.deepEqual(resolveDailyRetryConfig({ PUSH_DAILY_RETRY_MAX_RETRIES: '0' }).retryDelaysMs, []);
  assert.throws(() => resolveDailyRetryConfig({
    PUSH_DAILY_RETRY_INTERVAL_MS: '86400000', PUSH_DAILY_RETRY_MAX_RETRIES: '2',
  }), /不能超过一天/);

  const alert = resolvePushAlertConfig({});
  assert.equal(alert.enabled, true, '默认开 —— "不静默"是这次的 P0 目标');
  assert.equal(alert.chatId, '', '空串 = 用该条推送自己的群');
  assert.equal(alert.template, DEFAULT_ALERT_TEMPLATE);
  assert.equal(alert.names.pendingDealPush, DEFAULT_PENDING_DEAL_PUSH_ALERT_NAME);
  assert.equal(alert.names.secondDelivery, DEFAULT_SECOND_DELIVERY_ALERT_NAME);
  assert.equal(resolvePushAlertConfig({ PUSH_RETRY_ALERT_ENABLED: '' }).enabled, false, '显式布尔：空串 = 关');
  assert.throws(() => resolvePushAlertConfig({ PUSH_RETRY_ALERT_ENABLED: 'on maybe' }), /显式布尔/);
  // 文案必须在**启动时**就把写错的名字拦住（不认识的占位符会被渲染成空串 = 悄悄少一段信息）。
  assert.throws(() => resolvePushAlertConfig({ PUSH_RETRY_ALERT_TEMPLATE: '' }), /不能是空的/);
  assert.throws(() => resolvePushAlertConfig({ PUSH_RETRY_ALERT_TEMPLATE: '{day} 失败了' }), /必须带 \{push\}/);
  assert.throws(() => resolvePushAlertConfig({ PUSH_RETRY_ALERT_TEMPLATE: '{push} {pus}' }), /无法识别的占位符/);
  assert.throws(() => resolvePushAlertConfig({ PUSH_RETRY_ALERT_TEMPLATE: '{push} 失败了 }' }), /没有闭合/);
});

test('告警文案与原因：{push}/{day}/{reason}/{code}/{msg} 填值；原因带飞书真实 code', () => {
  const alert = resolvePushRetryConfig({}).alert;
  const error = withResponse(400, { code: 1254607, msg: 'Data not ready, please try again later' });
  assert.equal(pushFailureReason(error), 'Data not ready, please try again later (Code: 1254607)');
  const text = formatPushAlertText(alert.template, {
    push: alert.names.secondDelivery, day: '2026-10-05', attempt: 7, maxAttempts: 7,
    reason: pushFailureReason(error), code: 1254607, msg: 'Data not ready, please try again later',
  });
  assert.match(text, /^⚠️【二次交付每日提醒】2026-10-05 推送失败，今天不会再自动重试/);
  assert.match(text, /Data not ready, please try again later \(Code: 1254607\)/);
  assert.match(text, /已试 7\/7 次/);
  // 告警一天最多一句：只有"开关开着 + 这一天还没试过"才发。
  assert.equal(shouldSendFailureAlert({ status: 'failed' }, alert), true);
  assert.equal(shouldSendFailureAlert({ status: 'failed', alert_attempted: true }, alert), false);
  assert.equal(shouldSendFailureAlert({ status: 'failed' }, { ...alert, enabled: false }), false);
});
