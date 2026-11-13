/**
 * 「批量打印」飞书表单 → 自动打印（2026-11-09 业务负责人定的链路）。
 *
 * 业务口径（本文件逐条钉住）：
 *   · 一条表单记录勾多个「打印货号」⇒ **每个货号各打各的**，一个失败不拖累其他；
 *   · 坏货号（没编号 / 没库存，队列回 400）⇒ **跳过**，其他照打；
 *   · 失败 / 跳过 ⇒ **同一条表单记录汇总成一条**通知（运营群）；
 *   · 临时错误**重试 3 次**（首次 + 3 次 = 最多 4 次尝试）；永久错误不重试；
 *   · 同一条表单记录事件重投 ⇒ 去重（不再打、不再通知）；
 *   · 「打印日」是飞书自动字段 —— 代码一行都不写（本链路没有写表路径）。
 */
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_test_app';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'test_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { LABEL_FORM_INTAKE } = require('../src/config/labelPrintForm');
const { resolveTransientRetryConfig, withTransientRetry } = require('../src/config/pushRetry');
const {
  createLabelPrintFormIntakeService, linkRecordIdsOf,
} = require('../src/services/labelPrintFormIntakeService');

const FORM_TABLE_ID = V1_BITABLE_SCHEMA.tables.labelPrintRequest.tableId;
const SOURCE_DIR = path.join(__dirname, '../src');

const linkValue = (ids) => [{ record_ids: ids, text: ids.join(',') }];

/** 假网关：只实现 `get('labelPrintRequest', id)`（本链路只读一条表单记录）。 */
const fakeGateway = (records = {}) => {
  const calls = [];
  return {
    calls,
    async get(tableKey, recordId) {
      calls.push({ tableKey, recordId });
      return records[recordId] || null;
    },
  };
};

/**
 * 假队列：按 productId 决定行为 ——
 *   'ok'（默认） / 'skip'（400 = 她的数据问题，跳过） / 'perm'（403 永久错误，失败不重试） /
 *   'temp:N'（前 N 次抛临时错误，之后成功）。
 */
const fakeQueue = (behavior = {}) => {
  const calls = [];
  const attempts = {};
  return {
    calls,
    attempts,
    async enqueueSingle(input) {
      calls.push(input);
      const mode = behavior[input.recordId] || 'ok';
      attempts[input.recordId] = (attempts[input.recordId] || 0) + 1;
      if (mode === 'skip') {
        throw Object.assign(new Error(`没有找到编号「${input.recordId}」的可打印标签（这一款现在可能没有库存）`), { statusCode: 400 });
      }
      if (mode === 'perm') {
        // 永久错误（不是 400 那种"她的数据问题"）：例如 403 / 飞书永久错误码 ⇒ 不重试、计失败。
        throw Object.assign(new Error('没有权限'), { statusCode: 403 });
      }
      if (mode.startsWith('temp:')) {
        const times = Number(mode.split(':')[1]);
        if (attempts[input.recordId] <= times) throw new Error('ECONNRESET');
      }
      return { job_id: `job_${input.recordId}`, reused: false, total_labels: 1, numbers: [`编号-${input.recordId}`] };
    },
  };
};

const fakeNotifications = () => {
  const sent = [];
  return { sent, async send(event, data) { sent.push({ event, data }); } };
};

const build = ({ records = {}, behavior = {}, config = {}, gateway: injectedGateway, transientRetry } = {}) => {
  const gateway = injectedGateway || fakeGateway(records);
  const queue = fakeQueue(behavior);
  const notifications = fakeNotifications();
  const sleeps = [];
  const service = createLabelPrintFormIntakeService({
    gateway,
    queue,
    notifications,
    config: { ...LABEL_FORM_INTAKE, ...config },
    transientRetry,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => Date.parse('2026-11-09T00:30:00Z'),
  });
  return { gateway, queue, notifications, sleeps, service };
};

const formRecord = (id, productIds) => ({
  record_id: id,
  fields: { [V1_BITABLE_SCHEMA.tables.labelPrintRequest.fields.product]: productIds ? linkValue(productIds) : [] },
});

test('AC-FF1 一条表单勾多个货号 ⇒ 每个货号各排一次队（源 = form，幂等键按记录+货品各一把）', async () => {
  const { queue, service } = build({
    records: { rec_form1: formRecord('rec_form1', ['rec_p1', 'rec_p2', 'rec_p3']) },
  });
  const result = await service.processRecord('rec_form1');
  assert.equal(result.queued, 3);
  assert.deepEqual(queue.calls.map((call) => call.recordId), ['rec_p1', 'rec_p2', 'rec_p3']);
  assert.deepEqual(queue.calls.map((call) => call.submitKey), [
    'label_form:rec_form1:rec_p1', 'label_form:rec_form1:rec_p2', 'label_form:rec_form1:rec_p3',
  ]);
  assert.deepEqual([...new Set(queue.calls.map((call) => call.source))], ['form']);
  assert.equal(result.notified, false, '全成功 ⇒ 不打扰运营群');
});

test('AC-FF11 读表单记录遇到 1254607 ⇒ 复用 withTransientRetry 短重试后继续处理', async () => {
  const record = formRecord('rec_form1', ['rec_p1']);
  let reads = 0;
  const gateway = {
    async get(table, id, options = {}) {
      const work = async () => {
        reads += 1;
        if (reads === 1) {
          const error = new Error('Data not ready, please try again later');
          error.response = { status: 400, data: { code: 1254607, msg: 'Data not ready' } };
          throw error;
        }
        return record;
      };
      return options.retry ? withTransientRetry(work, { config: options.retry, sleep: async () => {} }) : work();
    },
  };
  const { service } = build({
    gateway,
    transientRetry: resolveTransientRetryConfig({
      PUSH_TRANSIENT_RETRY_MAX_RETRIES: '2',
      PUSH_TRANSIENT_RETRY_BASE_DELAY_MS: '0',
      PUSH_TRANSIENT_RETRY_MAX_DELAY_MS: '0',
    }),
  });
  const result = await service.processRecord('rec_form1');
  assert.equal(reads, 2, '第一次 1254607 后必须重试一次');
  assert.equal(result.queued, 1);
});

test('AC-FF2 坏货号（400 没编号/没库存）⇒ 跳过、其他照打；汇总一条通知里说清楚', async () => {
  const { queue, notifications, service } = build({
    records: { rec_form2: formRecord('rec_form2', ['rec_ok1', 'rec_bad', 'rec_ok2']) },
    behavior: { rec_bad: 'skip' },
  });
  const result = await service.processRecord('rec_form2');
  assert.equal(result.queued, 2, '两个好的照打');
  assert.equal(result.notified, true);
  assert.equal(queue.calls.length, 3);
  assert.equal(notifications.sent.length, 1, '⚠️ 同一条表单记录只发**一条**通知');
  const body = notifications.sent[0].data.lines.join('\n');
  assert.equal(notifications.sent[0].event, 'label_print_failed');
  assert.match(body, /表单记录 rec_form2/);
  assert.match(body, /已排队打印 2 个/);
  assert.match(body, /跳过 1 个/);
  assert.match(body, /rec_bad/, '跳过的是哪个货号要写出来');
  assert.match(body, /时间：/);
});

test('AC-FF3 临时错误重试 3 次后成功 ⇒ 共 4 次尝试、不通知；等间隔 0.8s → 1.6s → 3.2s', async () => {
  const { queue, notifications, sleeps, service } = build({
    records: { rec_form3: formRecord('rec_form3', ['rec_flaky']) },
    behavior: { rec_flaky: 'temp:3' },
  });
  const result = await service.processRecord('rec_form3');
  assert.equal(result.queued, 1);
  assert.equal(queue.attempts.rec_flaky, 4, '首次 + 重试 3 次');
  assert.deepEqual(sleeps, [800, 1600, 3200], '退避间隔复用异步任务那套（0.8/1.6/3.2 秒）');
  assert.equal(notifications.sent.length, 0, '最终成功 ⇒ 不通知');
});

test('AC-FF4 临时错误 3 次重试仍失败 ⇒ 失败汇总一条通知（含重试说明）', async () => {
  const { queue, notifications, service } = build({
    records: { rec_form4: formRecord('rec_form4', ['rec_down']) },
    behavior: { rec_down: 'temp:99' },
  });
  const result = await service.processRecord('rec_form4');
  assert.equal(result.queued, 0);
  assert.equal(queue.attempts.rec_down, 4);
  assert.equal(notifications.sent.length, 1);
  const body = notifications.sent[0].data.lines.join('\n');
  assert.match(body, /失败 1 个/);
  assert.match(body, /已重试 3 次仍失败/);
  assert.match(body, /ECONNRESET/);
});

test('AC-FF5 永久错误（400 参数类）**不重试**，直接计入失败并通知一次', async () => {
  const { queue, notifications, service } = build({
    records: { rec_form5: formRecord('rec_form5', ['rec_perm']) },
    behavior: { rec_perm: 'perm' },
  });
  const result = await service.processRecord('rec_form5');
  assert.equal(result.queued, 0);
  assert.equal(queue.attempts.rec_perm, 1, '永久错误（403）⇒ 不重试');
  assert.equal(notifications.sent.length, 1);
  assert.match(notifications.sent[0].data.lines.join('\n'), /失败 1 个/);
});

test('AC-FF6 同一条表单记录事件重投 ⇒ 去重（不再排队、不再通知）', async () => {
  const { queue, notifications, service } = build({
    records: { rec_form6: formRecord('rec_form6', ['rec_p1']) },
    behavior: { rec_p1: 'skip' },
  });
  await service.processRecord('rec_form6');
  const callsAfterFirst = queue.calls.length;
  const sentAfterFirst = notifications.sent.length;
  const second = await service.processRecord('rec_form6');
  assert.equal(second.duplicate, true);
  assert.equal(queue.calls.length, callsAfterFirst, '重投不许再打一次');
  assert.equal(notifications.sent.length, sentAfterFirst, '重投不许再发一条');
});

test('AC-FF7 只认「新增」动作：record_edited / record_deleted 不触发；record_added 各处理一次', async () => {
  const { queue, service } = build({
    records: { rec_new: formRecord('rec_new', ['rec_p1']) },
  });
  await service.handleTableChanges([
    { action: 'record_edited', record_id: 'rec_edited' },
    { action: 'record_deleted', record_id: 'rec_deleted' },
    { action: 'record_added', record_id: 'rec_new' },
  ]);
  assert.deepEqual(queue.calls.map((call) => call.recordId), ['rec_p1']);
});

test('AC-FF8 「打印日」是飞书自动字段：schema 不映射、本链路没有任何写表路径', () => {
  const table = V1_BITABLE_SCHEMA.tables.labelPrintRequest;
  assert.equal(table.tableName, '标签打印');
  assert.deepEqual(Object.keys(table.fields), ['product'], '只映射「打印货号」；「打印日」刻意不映射');
  const source = fs.readFileSync(path.join(SOURCE_DIR, 'services/labelPrintFormIntakeService.js'), 'utf8');
  for (const forbidden of ['gateway.update', 'gateway.create', 'bitable.record.created', 'bitable.record.updated']) {
    assert.equal(source.includes(forbidden), false, `本链路只读 + 入队，不许出现 ${forbidden}`);
  }
});

test('AC-FF9 关联字段解析：数组对象 / 字符串 / recordId / 嵌套数组都认；认不出的不猜', () => {
  assert.deepEqual(linkRecordIdsOf([{ record_ids: ['rec_a', 'rec_b'] }, { recordId: 'rec_c' }, 'rec_d']),
    ['rec_a', 'rec_b', 'rec_c', 'rec_d']);
  assert.deepEqual(linkRecordIdsOf([['rec_e'], { record_ids: ['rec_a'] }]), ['rec_e', 'rec_a']);
  assert.deepEqual(linkRecordIdsOf(null), []);
  assert.deepEqual(linkRecordIdsOf([{ text: '没有 id' }]), []);
});

test('AC-FF10 飞书表变更分派：按 schema 的「标签打印」table_id 交给本链路（不是写死表 ID）', async () => {
  const { createLarkEventHandlers } = require('../src/routes/larkEvents');
  const calls = [];
  const handlers = createLarkEventHandlers({
    tagQrCodes: { handleTableChanges: async () => {} },
    labelPrintFormIntake: { handleTableChanges: async (actionList) => { calls.push(actionList); } },
  });
  handlers['drive.file.bitable_record_changed_v1']({
    file_token: V1_BITABLE_SCHEMA.appToken,
    table_id: FORM_TABLE_ID,
    action_list: [{ action: 'record_added', record_id: 'rec_form_dispatch' }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ action: 'record_added', record_id: 'rec_form_dispatch' }]);
});
