#!/usr/bin/env node
/**
 * Deploy self-check (routes + workbench assets) -- READ ONLY, safe to run right after a restart.
 *
 * Why this exists (2026-10-13, a real miss): after a deploy we only checked "the process is up",
 * so two classes of breakage shipped unnoticed and the store saw them first:
 *   1. the login redirect lost its `next=...` (any scan link bounced to the home page), and
 *   2. a workbench page returned 200 while one of its referenced JS/CSS files 404'd
 *      => the browser rendered a blank page (200 + a dead <script> looks "green" to a status check).
 *
 * This script therefore asserts behavior, not liveness:
 *   1. unauthenticated GET /r/<recordId>      => 302 and Location contains next=%2Fr%2F<recordId>
 *   2. unauthenticated GET /s/<number>?from=sales => 302 and next contains the encoded /s/...?from=sales
 *   3. GET /workbench/                        => every referenced JS/CSS responds 200
 * It prints the ACTUAL values it saw (no bare "OK"), and exits non-zero on any failure.
 *
 * Usage:
 *   node scripts/deploy-selfcheck-routes.mjs                     # defaults to http://127.0.0.1:5000
 *   SELFCHECK_BASE_URL=http://127.0.0.1:5000 node scripts/deploy-selfcheck-routes.mjs
 *   SELFCHECK_RECORD_ID=recXXXX node scripts/deploy-selfcheck-routes.mjs
 *
 * READ ONLY: it only issues GETs; it never writes to any table.
 */
const BASE = String(process.env.SELFCHECK_BASE_URL || 'http://127.0.0.1:5000').replace(/\/+$/, '');
const RECORD_ID = String(process.env.SELFCHECK_RECORD_ID || 'rec_selfcheck_0001');
const NUMBER = String(process.env.SELFCHECK_NUMBER || 'YD6693-2|黑色|A');
const TIMEOUT_MS = Number(process.env.SELFCHECK_TIMEOUT_MS || 10000);

const results = [];
const AUTH_OFF_HINT = '（503 = 这一份部署没开飞书认证 LARK_WEB_AUTH_ENABLED；服务器上应当是开着的）';
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`      ${detail}`);
};

const get = async (path) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual', signal: controller.signal });
    const text = await res.text().catch(() => '');
    return { status: res.status, location: res.headers.get('location') || '', text };
  } finally {
    clearTimeout(timer);
  }
};

/** 1) /r/<recordId> 未登录 => 302 + next 逐字含 %2Fr%2F<recordId> */
const checkRecordIdRedirect = async () => {
  const expected = `next=${encodeURIComponent(`/r/${RECORD_ID}`)}`;
  const res = await get(`/r/${encodeURIComponent(RECORD_ID)}`);
  const ok = res.status === 302 && res.location.includes(expected);
  record(ok, `GET /r/${RECORD_ID}（未登录）=> 302 且 Location 含 next=%2Fr%2F…`,
    `status=${res.status} · Location=${res.location || '(空)'} · 期望含 ${expected}`
    + (res.status === 503 ? AUTH_OFF_HINT : ''));
};

/** 2) /s/<编号>?from=sales 未登录 => 302 + next 含编码后的 /s/…?from=sales（回归） */
const checkScanRedirect = async () => {
  const path = `/s/${encodeURIComponent(NUMBER)}?from=sales`;
  const expected = `next=${encodeURIComponent(path)}`;
  const res = await get(path);
  const ok = res.status === 302 && res.location.includes(expected);
  record(ok, 'GET /s/<编号>?from=sales（未登录）=> 302 且 next 含 %2Fs%2F…%3Ffrom%3Dsales',
    `status=${res.status} · Location=${res.location || '(空)'} · 期望含 ${expected}`
    + (res.status === 503 ? AUTH_OFF_HINT : ''));
};

/** 3) /workbench/ 里引用的每个 JS/CSS 都要 200（"页面 200 但脚本 404" => 整页空白） */
const checkWorkbenchAssets = async () => {
  const page = await get('/workbench/');
  const refs = [...page.text.matchAll(/(?:src|href)="([^"]+\.(?:js|css))(?:\?[^"]*)?"/g)].map((m) => m[1]);
  const unique = [...new Set(refs)];
  if (page.status !== 200) {
    record(false, 'GET /workbench/ => 200', `status=${page.status}`);
    return;
  }
  if (!unique.length) {
    record(false, 'GET /workbench/ 引用的 JS/CSS', '页面上一个 JS/CSS 引用都没抓到（引用坏了？）');
    return;
  }
  const checks = [];
  for (const ref of unique) {
    const url = ref.startsWith('http') ? ref : ref.startsWith('/') ? ref : `/workbench/${ref}`;
    // eslint-disable-next-line no-await-in-loop
    const res = await get(url);
    checks.push({ url, status: res.status });
  }
  const bad = checks.filter((item) => item.status !== 200);
  record(bad.length === 0, `GET /workbench/ 引用的 ${unique.length} 个 JS/CSS 都要 200`,
    bad.length
      ? `坏的：${bad.map((item) => `${item.url} => ${item.status}`).join(' · ')}`
      : checks.map((item) => `${item.url} => ${item.status}`).join(' · '));
};

const main = async () => {
  console.log(`部署自检（只读）· 目标 ${BASE} · 开始 ${new Date().toISOString()}`);
  const steps = [checkRecordIdRedirect, checkScanRedirect, checkWorkbenchAssets];
  for (const step of steps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await step();
    } catch (error) {
      record(false, step.name, `抛错：${String(error?.message || error)}`);
    }
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\n汇总：${results.length - failed.length}/${results.length} 通过${failed.length ? ` · ${failed.length} 条失败` : ''}`);
  if (failed.length) {
    for (const item of failed) console.log(`  FAIL ${item.label} :: ${item.detail}`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(`自检本身炸了：${String(error?.message || error)}`);
  process.exitCode = 1;
});
