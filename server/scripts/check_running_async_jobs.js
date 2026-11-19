#!/usr/bin/env node
/**
 * 部署前检查：还有没有 queued / running 的异步任务。
 *
 * 背景（2026-11-19 真实事故）：
 *   一笔库存手工调整从 17:29 跑到 17:35，部署在 17:35:38 重启进程，
 *   任务仍在 running ⇒ 30 分钟后被 recovery 置为 failed，只能人工核对。
 *
 * 本脚本只读 `server/data/async_jobs/*.json`，不写任何文件。
 * 退出码：
 *   0 = 没有 queued/running，可以部署
 *   1 = 有活跃任务 / 任务文件读不懂（fail closed）
 *
 * 环境变量：
 *   ASYNC_JOBS_DIR  任务目录（默认 server/data/async_jobs）
 */
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE_STATUSES = Object.freeze(['queued', 'running']);
const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'partial_failed']);
const DEFAULT_JOBS_DIR = path.join(__dirname, '..', 'data', 'async_jobs');

const statusOf = (job) => String(job?.status || '').trim();
const isActive = (job) => ACTIVE_STATUSES.includes(statusOf(job));
const isTerminal = (job) => TERMINAL_STATUSES.includes(statusOf(job));

const scanJobs = (dir = process.env.ASYNC_JOBS_DIR || DEFAULT_JOBS_DIR) => {
  const active = [];
  const unreadable = [];
  const resolved = path.resolve(String(dir || DEFAULT_JOBS_DIR));
  if (!fs.existsSync(resolved)) return { dir: resolved, active, unreadable };
  const names = fs.readdirSync(resolved).filter((name) => name.endsWith('.json')).sort();
  for (const name of names) {
    const file = path.join(resolved, name);
    let job;
    try {
      job = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      unreadable.push({ file, reason: String(error?.message || error).slice(0, 200) });
      continue;
    }
    if (!job || typeof job !== 'object' || !job.job_id) {
      unreadable.push({ file, reason: 'missing_job_id' });
      continue;
    }
    if (isActive(job)) active.push({ file, job });
    else if (!isTerminal(job)) unreadable.push({ file, reason: `unknown_status:${statusOf(job) || '(empty)'}` });
  }
  return { dir: resolved, active, unreadable };
};

const describe = ({ job }) => [
  String(job.job_id || ''),
  String(job.type || ''),
  statusOf(job) || '(empty)',
  String(job.operator_name || ''),
  String(job.started_at || job.created_at || ''),
].filter(Boolean).join(' | ');

const main = () => {
  const result = scanJobs();
  console.log(`部署前检查：异步任务目录 ${result.dir}`);
  if (result.unreadable.length) {
    console.error(`❌ 有 ${result.unreadable.length} 个任务文件无法确认状态，禁止部署（fail closed）：`);
    for (const item of result.unreadable) console.error(`  - ${item.file} | ${item.reason}`);
    process.exit(1);
  }
  if (result.active.length) {
    console.error(`❌ 有 ${result.active.length} 个 queued/running 异步任务，部署已中止，未重启进程：`);
    for (const item of result.active) console.error(`  - ${describe(item)}`);
    console.error('  等任务结束后重新执行部署；不要强行重启。');
    process.exit(1);
  }
  console.log('✅ 没有 queued/running 异步任务，可以部署。');
  process.exit(0);
};

if (require.main === module) main();

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DEFAULT_JOBS_DIR,
  scanJobs,
};
