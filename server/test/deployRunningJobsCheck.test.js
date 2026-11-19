'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check_running_async_jobs.js');
const { scanJobs } = require(SCRIPT);

const tempJobs = (jobs) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'async-jobs-'));
  jobs.forEach((job, index) => fs.writeFileSync(
    path.join(dir, `${String(index).padStart(3, '0')}.json`),
    typeof job === 'string' ? job : JSON.stringify(job),
  ));
  return dir;
};

test('没有 queued/running ⇒ 放行（succeeded / failed / partial_failed 算终态）', () => {
  const dir = tempJobs([
    { job_id: 'j_ok', status: 'succeeded' },
    { job_id: 'j_failed', status: 'failed' },
    { job_id: 'j_partial', status: 'partial_failed' },
  ]);
  const out = scanJobs(dir);
  assert.deepEqual(out.active, []);
  assert.deepEqual(out.unreadable, []);
});

test('有 queued / running ⇒ 阻塞，并带出任务信息', () => {
  const dir = tempJobs([
    { job_id: 'j_queued', type: 'sales', status: 'queued' },
    { job_id: 'j_running', type: 'inventory_adjustment', status: 'running', operator_name: '赵瑞玲' },
  ]);
  const out = scanJobs(dir);
  assert.deepEqual(out.active.map((item) => item.job.job_id), ['j_queued', 'j_running']);
});

test('JSON 损坏 / 未知状态 ⇒ fail closed，不允许猜放行', () => {
  const dir = tempJobs([
    '{not-json',
    { job_id: 'j_unknown', status: 'paused' },
    { status: 'succeeded' },
  ]);
  const out = scanJobs(dir);
  assert.equal(out.active.length, 0);
  assert.equal(out.unreadable.length, 3);
});

test('CLI：running ⇒ 退出码 1；没有目录 ⇒ 退出码 0', () => {
  const runningDir = tempJobs([{ job_id: 'j_running', status: 'running' }]);
  const blocked = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ASYNC_JOBS_DIR: runningDir }, encoding: 'utf8' });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /j_running/);
  assert.match(blocked.stderr, /部署已中止/);

  const emptyDir = path.join(os.tmpdir(), `async-jobs-empty-${Date.now()}`);
  const allowed = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ASYNC_JOBS_DIR: emptyDir }, encoding: 'utf8' });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /可以部署/);
});

test('deploy_run.sh 在 pm2 重启前调用 running-jobs 检查', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'deploy_run.sh'), 'utf8');
  const checkAt = source.indexOf('check_running_async_jobs.js');
  const pm2At = source.lastIndexOf('pm2 startOrReload ecosystem.config.js');
  assert.ok(checkAt > 0, '必须调用部署前检查脚本');
  assert.ok(pm2At > checkAt, '检查必须在 pm2 重启之前');
  assert.match(source, /部署已中止/);
  assert.match(source, /不得强行重启|不要强行重启/);
});
