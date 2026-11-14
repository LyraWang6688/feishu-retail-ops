'use strict';

/**
 * AGENTS.md 体积与拆分哨兵（2026-11-14）。
 *
 * 起因（真实事故）：AGENTS.md 曾 **84,493 B > 65,536 B 注入预算**，被系统截到 65,243 B，
 * 被截掉的恰好是「必须走 CI / 结论必须取证 / 任务收尾」这些纪律 ⇒ agent 行为失准。
 * 现在 AGENTS 已拆分（纪律 → `docs/agent-discipline.md`；历史 → `docs/archive/AGENTS-retired-entrypoints.md`）。
 *
 * 判据：
 *   1. AGENTS.md ≤ 65,536 B（超过即会被截断，塞回长文 ⇒ 红）；
 *   2. 两个拆分件存在且被 AGENTS 明确引用（不是拆完就失联）；
 *   3. 关键活规则仍在 AGENTS 正文（不许把部署/写作用域/测试 Base 纪律也搬走）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const AGENTS = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const DISCIPLINE = path.join(ROOT, 'docs', 'agent-discipline.md');
const RETIRED = path.join(ROOT, 'docs', 'archive', 'AGENTS-retired-entrypoints.md');

test('AC-ASB-1 AGENTS.md 必须 ≤ 65,536 B（超预算会被截断）', () => {
  const bytes = Buffer.byteLength(AGENTS);
  assert.ok(bytes <= 65536, `AGENTS.md 现在 ${bytes} B > 65,536 B（会被系统截断）`);
});

test('AC-ASB-2 拆分件存在，且 AGENTS 里有指针（拆完不许失联）', () => {
  assert.ok(fs.existsSync(DISCIPLINE), 'docs/agent-discipline.md 必须存在');
  assert.ok(fs.existsSync(RETIRED), 'docs/archive/AGENTS-retired-entrypoints.md 必须存在');
  assert.match(AGENTS, /docs\/agent-discipline\.md/, 'AGENTS 必须指向纪律拆分件');
  assert.match(AGENTS, /docs\/archive\/AGENTS-retired-entrypoints\.md/, 'AGENTS 必须指向历史归档');
});

test('AC-ASB-3 关键活规则仍在 AGENTS 正文（不许全搬走）', () => {
  for (const needle of [
    '当前 V1 核心（缺一不可）',
    '已退场入口',
    '## 合并与部署的时机纪律',
    '## 多代理并行时的写作用域纪律',
    '## 与业务负责人的协作纪律',
    '测试 Base 与生产 Base 的边界',
  ]) {
    assert.ok(AGENTS.includes(needle), `AGENTS 必须保留「${needle}」`);
  }
});
