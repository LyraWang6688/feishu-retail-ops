'use strict';

/**
 * 仓库数据卫生哨兵（2026-11-14，#59）：
 * `tools/write-sequence-trace/archive/` 里是**生产销售链路真实样例**（真实单号/金额/操作人），
 * 而仓库是 **PUBLIC** ⇒ 数据文件必须**不再被 git 跟踪**，只保留 README。
 *
 *   AC-RDH-1 该目录下没有 tracked 的 .json / .html
 *   AC-RDH-2 .gitignore 明确覆盖这些数据文件（防止下次又 add 进来）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const ARCHIVE = 'tools/write-sequence-trace/archive';

const tracked = () => execFileSync('git', ['ls-files', ARCHIVE], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').map((line) => line.trim()).filter(Boolean);

test('AC-RDH-1 归档目录里没有 tracked 的 json/html 数据文件', () => {
  const data = tracked().filter((file) => /\.(json|html)$/i.test(file));
  assert.deepEqual(data, [], `真实样例数据文件不许入库：\n${data.join('\n')}`);
});

test('AC-RDH-2 .gitignore 覆盖归档数据文件', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /tools\/write-sequence-trace\/archive\/\*\/\*\.json/);
  assert.match(ignore, /tools\/write-sequence-trace\/archive\/\*\/\*\.html/);
});
