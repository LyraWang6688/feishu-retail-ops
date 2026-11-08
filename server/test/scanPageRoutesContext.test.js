'use strict';

/** 2026-11-08：扫码路由 ctx 收窄后的反向哨兵（P4-2a：routes + public）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src', 'routes', 'scanPage');
const FILES = ['routes.js', 'public.js', 'pages.js', 'actionRoutes.js', 'errors.js'];
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');
const strip = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const destructuredOf = (source) => {
  const m = /const installScanPage[\s\S]*?const \{\n([\s\S]*?)\n  \} = ctx;/.exec(source);
  assert.ok(m, '分组必须从 ctx 解构');
  return m[1].replace(/\n/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
};

test('每个路由文件的 ctx 解构项必须全部被实际使用', () => {
  for (const file of FILES) {
    const source = read(file);
    const m = /const installScanPage[\s\S]*?const \{\n[\s\S]*?\n  \} = ctx;/.exec(source);
    const rest = strip(source.slice(m.index + m[0].length));
    const unused = destructuredOf(source)
      .filter((name) => !new RegExp(`\\b${escapeRegExp(name)}\\b`).test(rest));
    assert.deepEqual(unused, [], `${file} 里存在只解构不使用的依赖：${unused.join(', ')}`);
  }
});

test('index.js 的 routeContext 只包含路由实际使用的依赖', () => {
  const source = read('index.js');
  const m = /const routeContext = \{([\s\S]*?)\n  \};/.exec(source);
  assert.ok(m, 'index.js 必须组装 routeContext');
  const keys = m[1].replace(/\n/g, ' ').split(',').map((x) => x.trim()).filter(Boolean);
  const used = new Set(FILES.flatMap((file) => destructuredOf(read(file))));
  const extra = keys.filter((key) => !used.has(key));
  assert.deepEqual(extra, [], `routeContext 夹带了路由不用的键：${extra.join(', ')}`);
});
