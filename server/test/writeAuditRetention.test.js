'use strict';

/**
 * #57：写入审计保留期清理（2026-11-14）。
 *   AC-WAR-1 超过保留期的 `YYYY-MM-DD.jsonl` 被删；近期文件与其它文件保留
 *   AC-WAR-2 `retentionDays <= 0` ⇒ 不清理（skipped）
 *   AC-WAR-3 目录不存在 ⇒ 不抛（deleted 0）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanupWriteAuditFiles } = require('../src/services/writeAuditService');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'write-audit-retention-'));

test('AC-WAR-1 超期文件删除、近期/非日期文件保留', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '2026-01-01.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, '2026-11-13.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep');
  const now = Date.parse('2026-11-14T10:00:00+08:00');
  const out = await cleanupWriteAuditFiles({ dir, retentionDays: 30, now });
  assert.equal(out.deleted, 1);
  assert.equal(fs.existsSync(path.join(dir, '2026-01-01.jsonl')), false);
  assert.equal(fs.existsSync(path.join(dir, '2026-11-13.jsonl')), true);
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true);
});

test('AC-WAR-2 retentionDays<=0 ⇒ 不清理', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
  const out = await cleanupWriteAuditFiles({ dir, retentionDays: 0 });
  assert.equal(out.skipped, 'disabled');
  assert.equal(fs.existsSync(path.join(dir, '2020-01-01.jsonl')), true);
});

test('AC-WAR-3 目录不存在 ⇒ 不抛', async () => {
  const out = await cleanupWriteAuditFiles({ dir: path.join(os.tmpdir(), 'no-such-audit-dir-xyz'), retentionDays: 30 });
  assert.equal(out.deleted, 0);
});
