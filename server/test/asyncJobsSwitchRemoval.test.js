'use strict';

/**
 * ⭐ 2026-11-10（业务负责人）：「**不需要加开关**，就是这个功能」——统一异步层
 * **固定常开**，删掉全局开关 `ASYNC_JOB_ENABLED`。
 *
 * 这条用例是**反向哨兵**：把开关塞回来 ⇒ 红（包括：
 *   · 代码里再出现 `ASYNC_JOB_ENABLED`；· 配置里再出现顶层 `enabled`；
 *   · `.env.example` 再列这个变量；· runtime 再按配置决定"要不要建 service"）。
 * 注释里说明"曾删过"是允许的（与仓库其它哨兵一致：先剥注释再断言）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const ROOT = path.join(SERVER, '..');
const stripComments = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '');

const read = (rel) => stripComments(fs.readFileSync(path.join(SERVER, rel), 'utf8'));

test('AC-AS0 ⭐ 统一异步层没有全局开关：源码/.env 里不再出现 ASYNC_JOB_ENABLED', () => {
  const configSrc = read('src/config/asyncJobs.js');
  const runtimeSrc = read('src/services/asyncJobRuntime.js');
  assert.equal(/ASYNC_JOB_ENABLED/.test(configSrc + runtimeSrc), false,
    '开关名不许再出现在代码里（业务负责人：「不需要加开关」）');
  const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.equal(/ASYNC_JOB_ENABLED/.test(envExample), false, '.env.example 不许再列这个变量');
  assert.equal(/async_job\.disabled/.test(runtimeSrc), false, '"disabled" 分支/日志不许回来');
});

test('AC-AS1 ⭐ 配置里没有顶层 enabled（通知开关 ASYNC_JOB_NOTIFY_ENABLED 不属于本条，保留）', () => {
  const configSrc = read('src/config/asyncJobs.js');
  // 顶层缩进 2 的 `enabled:` = 整个异步层的开关；嵌套（notify）里的缩进更深，不算
  assert.equal(/^ {2}enabled\s*:/m.test(configSrc), false, '异步层配置里不许再有顶层 enabled');
  const built = require('../src/config/asyncJobs').buildAsyncJobsConfig({});
  assert.equal(Object.prototype.hasOwnProperty.call(built, 'enabled'), false,
    'buildAsyncJobsConfig 的返回值里不许有 enabled');
});

test('AC-AS2 ⭐ runtime 固定建 service（没有"按开关决定建不建"的分支）', () => {
  const runtimeSrc = read('src/services/asyncJobRuntime.js');
  assert.equal(/ASYNC_JOBS\.enabled/.test(runtimeSrc), false, 'runtime 不许再读 ASYNC_JOBS.enabled');
  assert.match(runtimeSrc, /instance = createAsyncJobService\(\{ config: ASYNC_JOBS \}\)/,
    '固定创建：没有条件分支');
  // 单例管理 API 仍在（用例注入/恢复要用）
  const runtime = require('../src/services/asyncJobRuntime');
  assert.equal(typeof runtime.getAsyncJobService, 'function');
  assert.equal(typeof runtime.setAsyncJobServiceForTests, 'function');
});
