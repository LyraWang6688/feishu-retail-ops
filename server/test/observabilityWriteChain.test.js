'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { V1BitableGateway } = require('../src/services/v1BitableGateway');
const { addLogListener } = require('../src/utils/logger');
const { OBSERVABILITY_ALERTS } = require('../src/config/alerts');
const { createAlertMonitor } = require('../src/services/alertMonitor');
const { resolveTimingChain } = require('../src/config/timing');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { UI_TAP } = require('../src/config/uiTap');
const { handleUiTap } = require('../src/utils/uiTapReport');
const { withPageSession } = require('../src/routes/scanPage/pageToken');
const { createSaleWriteBackgroundService } = require('../src/services/saleWriteBackgroundService');
const { requestTiming } = require('../src/utils/requestTiming');
const schema = { appToken: 'test', tables: { sample: { tableId: 'tbl_test', tableName: 'test', fields: { value: 'Value' } } } };
const capture = async (fn) => {
  const logs = []; const stop = addLogListener(x => logs.push(x));
  try { await fn(logs); } finally { stop(); }
  return logs;
};
const monitor = () => createAlertMonitor({ config: { ...OBSERVABILITY_ALERTS, enabled: true,
  errorRate: { minTotal: 1000, minErrors: 3, thresholdPct: 5 } }, now: () => 100000 });

test('workbench initial page beacon uses mounted endpoint and emits client page view', async () => {
  let url;
  const window = { navigator: { sendBeacon: value => { url = value; return true; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/workbench/shared/funnel.js'), 'utf8'), { window });
  window.dshFunnel.view('workbench', { step: 'home' });
  const parsed = new URL(url, 'https://test.invalid');
  assert.equal(parsed.pathname, UI_TAP.paths.workbenchFull);
  const logs = await capture(async () => {
    let status;
    handleUiTap({ req: { query: Object.fromEntries(parsed.searchParams) }, scope: 'workbench',
      res: { status(code) { status = code; return this; }, end() {} } });
    assert.equal(status, 204);
  });
  assert.equal(logs[0].event, 'ui.page.view');
  assert.equal(logs[0].view_source, 'client_beacon');
});

test('sales goods and funds requests enter timing monitor on both QR paths', () => {
  for (const base of ['/r/rec_a', '/s/product']) {
    assert.equal(resolveTimingChain({ method: 'POST', path: base, body: { action: SCAN_WRITE.actions.submitOrder } }), 'scan.sale.submit');
    assert.equal(resolveTimingChain({ method: 'POST', path: base, body: { action: SCAN_PAGE.paymentStep.payAction } }), 'scan.sale.payment');
  }
});

test('request timing includes same request and click ID without form content', async () => {
  const logs = await capture(async () => {
    const res = new EventEmitter(); res.statusCode = 200;
    requestTiming()({ method: 'POST', path: '/r/rec_a', requestId: 'request-a',
      body: { action: SCAN_WRITE.actions.submitOrder, tap_id: 'tap-a', payment_amount: '999' } }, res, () => {});
    res.emit('finish');
  });
  assert.equal(logs[0].tap_id, 'tap-a');
  assert.equal(logs[0].request_id, 'request-a');
  assert.equal('payment_amount' in logs[0], false);
});

for (const operation of ['create', 'update', 'delete']) {
  test(`batch ${operation}: 501 rows retain one batch identity and verified counts across shards`, async () => {
    let calls = 0;
    const records = { [({ create: 'batchCreate', update: 'batchUpdate', delete: 'batchDelete' })[operation]]: async ({ data }) => {
      calls++;
      return { code: 0, data: { records: data.records.map((v, i) => operation === 'delete'
        ? { record_id: v, deleted: true } : { record_id: v.record_id || `rec_${calls}_${i}`, fields: v.fields }) } };
    } };
    const gateway = new V1BitableGateway({ schema, client: { bitable: { appTableRecord: records } } });
    const input = Array.from({ length: 501 }, (_, i) => operation === 'delete' ? `rec_${i}`
      : operation === 'update' ? { recordId: `rec_${i}`, values: { value: i } } : { value: i });
    const logs = await capture(async () => {
      const result = await gateway[`${operation}Batch`]('sample', input, { correlation: { task_id: 'order-task', tap_id: 'tap-a' } });
      assert.equal(result.length, 501);
    });
    const ends = logs.filter(x => x.outcome === 'confirmed');
    assert.equal(calls, 2);
    assert.equal(ends.length, 2);
    assert.equal(ends[0].batch_id, ends[1].batch_id);
    assert.deepEqual(ends.map(x => x.requested), [500, 1]);
    assert.deepEqual(ends.map(x => x.confirmed_count), [500, 501]);
    assert.equal(ends[0].batch_complete, false);
    assert.equal(ends[1].batch_complete, true);
    assert.equal(ends[1].tap_id, 'tap-a');
    assert.equal(ends[1].task_id, 'order-task');
    assert.equal(ends[1].batch_index, 2);
    assert.equal(ends[1].batch_count, 2);
    assert.ok(ends[1].total_duration_ms >= ends[1].duration_ms);
  });
}

test('batch timeout after first shard preserves confirmed 500 and reports unknown, not zero written', async () => {
  let calls = 0;
  const gateway = new V1BitableGateway({ schema, client: { bitable: { appTableRecord: {
    batchCreate: async ({ data }) => {
      if (++calls === 2) { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; throw e; }
      return { code: 0, data: { records: data.records.map((_, i) => ({ record_id: `rec_${i}` })) } };
    },
  } } } });
  const logs = await capture(async () => {
    await assert.rejects(gateway.createBatch('sample', Array.from({ length: 501 }, () => ({ value: 1 }))), /timeout/);
  });
  const failure = logs.find(x => x.outcome === 'unknown');
  assert.equal(failure.confirmed_count, 500);
  assert.equal(failure.requested, 1);
  assert.equal(failure.total_count, 501);
  assert.equal(failure.error_code, 'ETIMEDOUT');
  assert.equal('returned' in failure, false);
  assert.ok(Number.isInteger(failure.duration_ms));
  assert.equal(monitor().record(failure)[0].rule, 'critical');
});

test('explicit rejection records structured code and log ID; mismatch is never marked complete', async () => {
  const gateway = new V1BitableGateway({ schema, client: { bitable: { appTableRecord: {
    batchCreate: async () => ({ code: 1254066, msg: 'rejected', log_id: 'feishu-log' }),
  } } } });
  const logs = await capture(async () => { await assert.rejects(gateway.createBatch('sample', [{ value: 1 }])); });
  const failure = logs.find(x => x.outcome === 'rejected');
  assert.equal(failure.error_code, 1254066);
  assert.equal(failure.log_id, 'feishu-log');
  assert.equal(failure.confirmed_count, 0);
  assert.equal(monitor().record({ event: 'bitable.record.batch_write_mismatch', level: 'warn' })[0].rule, 'critical');
});

test('slow batch, sale timing and background warn failures are observable with default rules', () => {
  for (const event of ['bitable.record.batch_created', 'bitable.record.batch_updated', 'bitable.record.batch_deleted', 'scan.purchase.background.timing']) {
    assert.equal(monitor().record({ event, duration_ms: OBSERVABILITY_ALERTS.slowMs + 1 })[0].rule, 'slow');
  }
  assert.equal(monitor().record({ event: 'scan.sale.timing', submit_ms: OBSERVABILITY_ALERTS.slowMs + 1 })[0].rule, 'slow');
  for (const event of ['scan.sale.background_failed', 'scan.purchase.background_failed']) {
    assert.equal(monitor().record({ event, level: 'warn' })[0].rule, 'critical');
  }
});

test('page token wrapper and background replay forward correlation through tail options', async () => {
  const seen = [];
  const correlation = { tap_id: 'tap-origin', task_id: 'task-origin', order_no: 'order-origin' };
  const service = { submitSale: async (input, options) => { seen.push({ input, options }); return { ok: true }; } };
  await withPageSession(service, 'page-token').submitSale({ openId: 'operator' }, { correlation });
  assert.equal(seen[0].options.correlation, correlation);
  assert.match(seen[0].input.sessionKey, /page-token/);
  const logs = await capture(async () => {
    const background = createSaleWriteBackgroundService({ submitSale: service.submitSale,
      config: { events: { saleTiming: 'scan.sale.timing', saleBackgroundDone: 'scan.sale.background_done' } } });
    await background.scheduleSaleRest({ requestId: 'request-origin', salesEntryRecordId: 'rec_main',
      orderNo: 'order-origin', correlation, restInput: { openId: 'operator' } });
  });
  assert.equal(seen[1].options.correlation, correlation);
  assert.equal(logs.find(x => x.event === 'scan.sale.timing').tap_id, 'tap-origin');
});


test('alert list defaults are applied only when unset; explicit empty disables those rules', () => {
  const { execFileSync } = require('node:child_process');
  const code = "const c=require('./src/config/alerts').OBSERVABILITY_ALERTS;process.stdout.write(JSON.stringify({critical:c.criticalEvents,slow:c.slowEvents,warn:c.warningCriticalEvents}));";
  const env = { ...process.env };
  for (const k of ['OBSERVABILITY_ALERT_CRITICAL_EVENTS','OBSERVABILITY_ALERTS_SLOW_EVENTS','OBSERVABILITY_ALERT_CRITICAL_WARN_EVENTS']) delete env[k];
  const cwd = path.join(__dirname,'..');
  const read = () => JSON.parse(execFileSync(process.execPath,['-e',code],{env,cwd,encoding:'utf8'}));
  assert(read().critical.includes('bitable.record.batch_create_failed'));
  assert(read().slow.includes('scan.sale.timing'));
  env.OBSERVABILITY_ALERT_CRITICAL_EVENTS='';env.OBSERVABILITY_ALERTS_SLOW_EVENTS='';env.OBSERVABILITY_ALERT_CRITICAL_WARN_EVENTS='';
  assert.deepEqual(read(),{critical:[],slow:[],warn:[]});
});

test('critical alert retains business and batch identifiers without payload contents', () => {
  const alert = monitor().record({event:'bitable.record.batch_create_failed',level:'error',
    task_id:'task-1',order_no:'order-1',batch_id:'batch-1',confirmed_count:500,total_count:501,
    error_code:'ETIMEDOUT',app_secret:'must-not-forward'})[0];
  assert.match(alert.text,/order_no=order-1/);
  assert.match(alert.text,/confirmed_count=500/);
  assert.equal('app_secret' in alert.context,false);
});


test('partial delete retains explicitly confirmed deletions; mismatch shares the batch identity', async () => {
  const gateway = new V1BitableGateway({schema,client:{bitable:{appTableRecord:{
    batchDelete:async()=>({code:0,data:{records:[{record_id:'rec_a',deleted:true},{record_id:'rec_b',deleted:false}]}}),
  }}}});
  const logs = await capture(async()=>{await assert.rejects(gateway.deleteBatch('sample',['rec_a','rec_b']));});
  const failed=logs.find(x=>x.event==='bitable.record.batch_delete_failed');
  assert.equal(failed.confirmed_count,1);
  assert.equal(failed.partial_confirmed_count,1);
  assert.equal(failed.returned,2);
  assert.equal(failed.batch_complete,false);
  assert.equal(failed.outcome,'unknown');
  assert.equal(logs.find(x=>x.event==='bitable.record.batch_write_mismatch').batch_id,failed.batch_id);
});
