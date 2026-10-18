'use strict';

/**
 * 🔴 会话草稿数据安全（业务负责人 2026-10-18 复现）：
 *  ① 并发加货：两个请求都读到 [A] ⇒ 各自写 [A,B] / [A,C] ⇒ 后写覆盖 ⇒ B 丢；
 *  ② 过期后 ensure/addLine：原本 [A,C] 被新空会话替换 ⇒ 草稿丢。
 *
 * 判据：在**存储函数层**（不经过 HTTP 队列）并发调用 addLine 也不能丢行；
 *      过期后加货必须**保留**已有草稿（revive），只有显式 clearSale 才清空。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanSessionService } = require('../src/services/scanSessionService');
const { SCAN_WRITE } = require('../src/config/scanWrite');

const line = (size) => ({ kind: 'shoe', size, product_record_id: 'p', number: 'N', item_no: 'N', color: '黑' });

const make = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-safety-'));
  let clock = Date.parse('2026-10-18T10:00:00+08:00');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir, now: () => clock });
  return { sessions, advance: (ms) => { clock += ms; }, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

test('并发 addLine（同账号、不经 queue）：两次加货都要在，后写不许覆盖先写', async () => {
  const h = make();
  try {
    await h.sessions.addLine('ou_concurrent', line(38));
    // 模拟"两个请求都读到 [A]"：直接并发调存储函数（绕过路由层串行队列）
    await Promise.all([
      h.sessions.addLine('ou_concurrent', line(39)),
      h.sessions.addLine('ou_concurrent', line(40)),
    ]);
    const got = await h.sessions.get('ou_concurrent');
    assert.deepEqual((got.sale.lines || []).map((item) => item.size), [38, 39, 40],
      '并发加货后三双都要在（B/C 都不许被覆盖）');
  } finally { h.cleanup(); }
});

test('过期后 addLine：保留原草稿 [A,C]，再加 B ⇒ [A,C,B]（不是空会话）', async () => {
  const h = make();
  try {
    await h.sessions.addLine('ou_expired', line(38));
    await h.sessions.addLine('ou_expired', line(40));
    h.advance(SCAN_WRITE.session.ttlMs + 1000); // 会话过期
    const added = await h.sessions.addLine('ou_expired', line(39));
    assert.equal(added.ok, true);
    const got = await h.sessions.get('ou_expired');
    assert.deepEqual((got.sale.lines || []).map((item) => item.size), [38, 40, 39],
      '过期只续期，不许把未提交草稿换成空会话');
  } finally { h.cleanup(); }
});

test('只有显式 clearSale 才清空；过期本身不清空', async () => {
  const h = make();
  try {
    await h.sessions.addLine('ou_clear', line(38));
    h.advance(SCAN_WRITE.session.ttlMs + 1000);
    await h.sessions.clearSale('ou_clear');
    const got = await h.sessions.get('ou_clear');
    assert.deepEqual(got.sale.lines, [], '显式清空后才是空');
  } finally { h.cleanup(); }
});
