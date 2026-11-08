'use strict';

/**
 * 2026-11-08：扫码路由 ctx 收窄后的反向哨兵。
 * routes.js 只许解构**实际引用**的依赖；上层 routeContext 也不许夹带未使用项。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src', 'routes', 'scanPage');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const strip = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

const destructured = () => {
  const source = read('routes.js');
  const m = /const installScanPageRoutes[\s\S]*?const \{\n([\s\S]*?)\n  \} = ctx;/.exec(source);
  assert.ok(m, 'routes.js 必须从 ctx 解构');
  return m[1].replace(/\n/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
};

test('routes.js 的 ctx 解构项必须全部被实际使用', () => {
  const source = read('routes.js');
  const m = /const installScanPageRoutes[\s\S]*?const \{\n[\s\S]*?\n  \} = ctx;/.exec(source);
  const rest = strip(source.slice(m.index + m[0].length));
  const unused = destructured().filter((name) => !new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(rest));
  assert.deepEqual(unused, [], `routes.js 里存在只解构不使用的依赖：${unused.join(', ')}`);
});

test('index.js 的 routeContext 只包含 routes.js 实际使用的依赖', () => {
  const source = read('index.js');
  const m = /const routeContext = \{([\s\S]*?)\};/.exec(source);
  assert.ok(m, 'index.js 必须组装 routeContext');
  const keys = m[1].replace(/\n/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
  const used = new Set(destructured());
  const extra = keys.filter((key) => !used.has(key));
  assert.deepEqual(extra, [], `routeContext 夹带了 routes.js 不用的键：${extra.join(', ')}`);
});
