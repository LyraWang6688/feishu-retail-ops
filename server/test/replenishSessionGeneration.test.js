/**
 * 🔴 补货幂等键跨天撞车回归（业务负责人 2026-10-18 真机：成功页但零新写入）。
 *
 * 根因：会话 id = open_id 固定哈希，轮次在会话过期后从 1 重来；
 *   补货 task id 只由「会话 id + 轮次」推出 ⇒ 今天 `…:1` 与历史 `…:1` 相同，
 *   远端「采购批次」按幂等键把它当旧单重放（返回 10-12 的旧批次），**零新写入**。
 *
 * 判据：每个"提交窗口"（新会话 / 续期后的会话）必须有唯一代次，task id 带上它；
 *   同一窗口内重试代次不变。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanSessionService } = require('../src/services/scanSessionService');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-gen-'));
  let clock = Date.parse('2026-10-18T09:00:00+08:00');
  const now = () => clock;
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir, now });
  return {
    sessions,
    advance: (ms) => { clock += ms; },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

test('同一份未过期会话：代次不变（同一窗口内重试仍幂等）', async () => {
  const h = make();
  try {
    const a = await h.sessions.ensure('ou_generation_same');
    const b = await h.sessions.ensure('ou_generation_same');
    assert.ok(a.generation, '新会话必须有代次');
    assert.equal(a.generation, b.generation, '同一会话两次 ensure ⇒ 代次不变');
    assert.equal(
      h.sessions.submitKeyFor('ou_generation_same', a, 'replenish'),
      h.sessions.submitKeyFor('ou_generation_same', b, 'replenish'),
      '同一窗口内补货键不变（重试仍幂等）',
    );
  } finally { h.cleanup(); }
});

test('过期后新开 / 续期：代次必须轮换（跨天不再和历史键撞车）', async () => {
  const h = make();
  try {
    const first = await h.sessions.ensure('ou_generation_rotate');
    h.advance(SCAN_WRITE.session.ttlMs + 1000);
    const revived = await h.sessions.revive('ou_generation_rotate', { flow: 'replenish' });
    assert.ok(first.generation && revived.generation, '两次都要有代次');
    assert.notEqual(first.generation, revived.generation,
      '续期 = 新窗口 ⇒ 代次必须不同（否则 task id/采购幂等键仍会复用历史）');
  } finally { h.cleanup(); }
});

test('补货 task id 带代次（源码哨兵：塞回旧形状即红）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js'), 'utf8');
  assert.match(src, /const generation = String\(current\?\.generation/,
    'task id 必须读会话代次');
  assert.match(src, /`\$\{config\.replenish\.taskIdPrefix\}_\$\{key\.replace[^`]*\}_\$\{generation\}`/,
    'task id 必须以代次结尾');
});
