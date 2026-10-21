'use strict';

/**
 * ⭐ 2026-10-20 方案 C（业务负责人拍板）：棘轮只惩罚**变大**，不惩罚**瘦身**。
 *   本文件用临时目录跑真实的 `scripts/check-file-size.mjs`，钉住三条：
 *   - 文件比基线小、但没降基线 ⇒ **只警告，exit 0**
 *   - 文件比基线大 ⇒ exit 1
 *   - 新文件超限 ⇒ exit 1
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-file-size.mjs');

const makeRepo = ({ lines, baselineLines }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'size-ratchet-'));
  const server = path.join(root, 'server');
  fs.mkdirSync(path.join(server, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(server, 'src'), { recursive: true });
  fs.mkdirSync(path.join(server, 'test'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(server, 'scripts', 'check-file-size.mjs'));
  const baseline = {
    updatedAt: '2026-10-20',
    limits: { source: 800, test: 1200 },
    maxNetIncrease: 100,
    files: baselineLines === undefined ? {} : { 'server/src/big.js': baselineLines },
  };
  fs.writeFileSync(path.join(server, 'scripts', 'size-baseline.json'), JSON.stringify(baseline, null, 2));
  fs.writeFileSync(path.join(server, 'src', 'big.js'), '// line\n'.repeat(lines));
  return { server, script: path.join(server, 'scripts', 'check-file-size.mjs') };
};

const run = (repo) => spawnSync(process.execPath, [repo.script, '--no-net-check'], {
  cwd: repo.server, encoding: 'utf8',
});

test('方案 C：文件变小但没降基线 ⇒ 只警告，exit 0', () => {
  const repo = makeRepo({ lines: 809, baselineLines: 810 });
  const out = run(repo);
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stdout, /已缩小 1 行/);
  assert.doesNotMatch(out.stderr, /\[红\]/);
});

test('方案 C：文件比基线大 ⇒ exit 1', () => {
  const repo = makeRepo({ lines: 811, baselineLines: 810 });
  const out = run(repo);
  assert.equal(out.status, 1, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /基线/);
});

test('方案 C：新文件超限 ⇒ exit 1', () => {
  const repo = makeRepo({ lines: 801 });
  const out = run(repo);
  assert.equal(out.status, 1, `${out.stdout}\n${out.stderr}`);
  assert.match(out.stderr, /新超限/);
});
