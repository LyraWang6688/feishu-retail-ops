'use strict';

/**
 * ⭐ 2026-10-17（埋点第 2 刀）：日志轮转 + 每日汇总。
 *   ① 日报纯函数：分级 / Top 事件 / 未登记 / 错误 / 慢事件（时区 = 东八区）；
 *   ② CLI 端到端：给一份临时日志 ⇒ 生成 `observability-YYYY-MM-DD.{md,json}`；
 *   ③ 运维脚本：轮转/定时任务都**幂等**、取值全部可配（塞死一个值即红）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER_ROOT = path.join(__dirname, '..');
const { OBSERVABILITY } = require('../src/config/observability');
const script = path.join(SERVER_ROOT, 'scripts/observability-daily.mjs');

const line = (obj) => JSON.stringify(obj);

test('日报配置有默认值且可被环境变量覆盖（配置先行）', () => {
  assert.equal(OBSERVABILITY.daily.timeZone, 'Asia/Shanghai');
  assert.equal(OBSERVABILITY.daily.topN, 20);
  assert.equal(OBSERVABILITY.daily.slowMs, 3000);
  assert.equal(OBSERVABILITY.logrotate.maxSize, '10M');
  assert.equal(OBSERVABILITY.logrotate.retain, 14);
  assert.equal(OBSERVABILITY.logrotate.compress, true);
});

test('summarize / recordsOfDay：分级、Top、未登记、错误、慢事件、东八区边界', async () => {
  const { summarize, recordsOfDay } = await import(script);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-daily-'));
  const logFile = path.join(tmp, 'pm2-out.log');
  fs.writeFileSync(logFile, [
    line({ ts: '2026-10-17T01:00:00.000Z', level: 'info', event: 'scan.page.rendered', duration_ms: 12 }),
    line({ ts: '2026-10-17T01:01:00.000Z', level: 'info', event: 'scan.page.rendered', duration_ms: 5 }),
    line({ ts: '2026-10-17T01:02:00.000Z', level: 'warn', event: 'zzz.dynamic', unregistered: true }),
    line({ ts: '2026-10-17T01:03:00.000Z', level: 'error', event: 'bitable.record.create_failed', error: 'boom' }),
    line({ ts: '2026-10-17T01:04:00.000Z', level: 'info', event: 'slow.event', duration_ms: 5000 }),
    line({ ts: '2026-10-17T16:30:00.000Z', level: 'info', event: 'next.day.event' }), // +8 ⇒ 10-18
    'not json at all',
  ].join('\n'));

  const records = recordsOfDay([logFile], { date: '2026-10-17', timeZone: 'Asia/Shanghai' });
  assert.equal(records.length, 5, '东八区 10-17 的 5 条（16:30Z 属于 10-18）');
  const s = summarize(records, { topN: 3, slowMs: 3000 });
  assert.equal(s.total, 5);
  assert.equal(s.byLevel.info, 3);
  assert.equal(s.byLevel.warn, 1);
  assert.equal(s.byLevel.error, 1);
  assert.deepEqual(s.topEvents[0], { event: 'scan.page.rendered', count: 2 });
  assert.deepEqual(s.unregistered, [{ event: 'zzz.dynamic', count: 1 }]);
  assert.equal(s.errors[0].event, 'bitable.record.create_failed');
  assert.equal(s.errors[0].error, 'boom');
  assert.equal(s.slow[0].event, 'slow.event');
  assert.equal(s.slow[0].duration_ms, 5000);
});

test('CLI：给日志文件 ⇒ 生成日报 md/json（含未登记与慢事件）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cli-'));
  const logFile = path.join(tmp, 'box2bitable-server-out-1.log');
  fs.writeFileSync(logFile, [
    line({ ts: '2026-10-17T02:00:00.000Z', level: 'info', event: 'scan.page.rendered' }),
    line({ ts: '2026-10-17T02:01:00.000Z', level: 'warn', event: 'mystery.event', unregistered: true }),
    line({ ts: '2026-10-17T02:02:00.000Z', level: 'error', event: 'label.print.failed', error: 'printer offline' }),
    line({ ts: '2026-10-17T02:03:00.000Z', level: 'info', event: 'slow.event', duration_ms: 4200 }),
  ].join('\n'));
  execFileSync(process.execPath, [script, '--logs', path.join(tmp, '*.log'), '--out', path.join(tmp, 'reports'),
    '--date', '2026-10-17', '--slow-ms', '3000'], { encoding: 'utf8' });
  const md = fs.readFileSync(path.join(tmp, 'reports', 'observability-2026-10-17.md'), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(tmp, 'reports', 'observability-2026-10-17.json'), 'utf8'));
  assert.match(md, /scan\.page\.rendered/);
  assert.match(md, /mystery\.event/);
  assert.match(md, /printer offline/);
  assert.match(md, /slow\.event/);
  assert.equal(json.total, 4);
  assert.equal(json.time_zone, 'Asia/Shanghai');
});

test('运维脚本：轮转/定时任务都是幂等的，且取值可配（写死即红）', () => {
  const rotate = fs.readFileSync(path.join(SERVER_ROOT, 'scripts/setup-pm2-logrotate.sh'), 'utf8');
  assert.match(rotate, /set -euo pipefail/);
  assert.match(rotate, /\$\{PM2_LOGROTATE_MAX_SIZE:-10M\}/, '上限必须可配（不许写死）');
  assert.match(rotate, /pm2 list[^\n]*grep -q 'pm2-logrotate'/, '必须先检测已安装（幂等）');
  assert.match(rotate, /pm2 set pm2-logrotate:compress "\$COMPRESS"/);
  assert.match(fs.readFileSync(path.join(SERVER_ROOT, 'scripts/setup-observability-cron.sh'), 'utf8'),
    /grep -vF "\$MARK"/, 'crontab 必须按标记行替换（幂等）');
  for (const name of ['setup-pm2-logrotate.sh', 'setup-observability-cron.sh']) {
    const mode = fs.statSync(path.join(SERVER_ROOT, 'scripts', name)).mode;
    assert.ok((mode & 0o111) !== 0, `${name} 必须可执行`);
  }
  assert.ok(fs.existsSync(path.join(SERVER_ROOT, '..', 'docs/observability-daily.md')), '必须有使用文档');
});
