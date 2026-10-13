/**
 * ⭐⭐ 2026-10-13（她已确认"必须排查清楚" · 事故尾巴）：
 *  会话 `…44bd9863896a41e8` 的 `sale`：`status=draft` + `order_no=XSD-20261013-0003` + `lines=1`
 *  **且 `completed[]` 里已经登记了这一笔** ⇒ **明细/收款都写了，草稿没清** ✗（12:44:16 重启打断）
 *  ⇒ 现象：她之后每次扫码都看到"本单已加 1 双"✗，且**再提交有重复下单风险** ✗
 *
 *  ① 「清空本单」入口：**只清草稿**（绝不碰已提交的明细/收款/库存 ✗）· 二次确认 · 幂等 · 无草稿不给死按钮
 *  ② 启动识别"半截提交"：`status=draft` **且** `completed[]` 里已有该 `order_no` ⇒ 只清草稿那一半 + warn；
 *     ⚠️ **判据保守**：拿不准 ⇒ **只记日志、不动数据** ✗
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createScanSessionService } = require('../src/services/scanSessionService');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-draft-${label}-`));
const newSessions = (label) => createScanSessionService({ config: SCAN_WRITE, dir: tempDir(label) });

test('AC-CL1 清空本单 ⇒ 只清草稿：本单 0 双，**已提交的 completed 一条不动** ✓', async () => {
  const sessions = newSessions('cl1');
  const openId = 'ou_cl1';
  await sessions.ensure(openId);
  await sessions.addLine(openId, { size: '41', amount: '99' });
  await sessions.completeSale(openId, { key: 'k1', result: { order_no: 'XSD-20261013-0003' } });
  await sessions.addLine(openId, { size: '41', amount: '99' }); // 半截：草稿又有了
  const before = await sessions.get(openId);
  assert.equal((before.sale.completed || []).length, 1, '夹具：completed 里应已有 1 笔');
  await sessions.clearSale(openId);
  const after = await sessions.get(openId);
  assert.equal((after.sale.lines || []).length, 0, '草稿要清空 ✓');
  assert.equal(after.sale.order_no, '', '草稿里的单号要清掉 ✓');
  assert.deepEqual(after.sale.completed, before.sale.completed, '⭐ 已提交的登记**一条都不许动** ✗');
});

test('AC-CL2 清空是**幂等**的：连点两次结果一致 ✓', async () => {
  const sessions = newSessions('cl2');
  const openId = 'ou_cl2';
  await sessions.ensure(openId);
  await sessions.addLine(openId, { size: '40', amount: '10' });
  const once = await sessions.clearSale(openId);
  const twice = await sessions.clearSale(openId);
  assert.deepEqual(twice.sale.lines, [], '两次都空 ✓');
  assert.equal(twice.sale.seq, once.sale.seq, 'seq 不被清空改动 ✓');
  assert.deepEqual(twice.sale.completed, once.sale.completed, 'completed 不动 ✓');
});

test('AC-CL3 清空**不写任何业务表**（只读断言：假网关零 create/update/delete ✓）', async () => {
  const calls = [];
  const gateway = {
    table: () => ({
      create: async (...a) => { calls.push(['create', ...a]); },
      update: async (...a) => { calls.push(['update', ...a]); },
      delete: async (...a) => { calls.push(['delete', ...a]); },
    }),
    listAll: async () => [],
    get: async () => null,
  };
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: tempDir('cl3'), gateway });
  const openId = 'ou_cl3';
  await sessions.ensure(openId);
  await sessions.addLine(openId, { size: '40' });
  await sessions.clearSale(openId);
  assert.deepEqual(calls, [], '清空**一个业务表请求都不许发** ✗（账是账 ✓）');
});

test('AC-IN1 半截会话（draft + completed 里已有该单号）⇒ 识别出来 + **只清草稿那一半** ✓', async () => {
  // ⚠️ 夹具要点：service 用的是**测试自己的临时目录** ⇒ 手工写 `order_no` 也必须写**同一个目录** ✓
  const dir1 = tempDir('in1');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: dir1 });
  const openId = 'ou_in1';
  await sessions.ensure(openId);
  await sessions.addLine(openId, { size: '41', amount: '99' });
  await sessions.completeSale(openId, { key: 'k1', result: { order_no: 'XSD-20261013-0003' } });
  // ⭐ 按**真实事故快照**造：被打断的那一单 ⇒ 草稿里**留着 order_no + 一行**（恢复提交前那份草稿 ✓）
  await sessions.addLine(openId, { size: '41', amount: '99' });
  const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
  const idField1 = SCAN_WRITE.session.idField;
  const rec1 = await sessions.get(openId);
  await new JsonTaskStore({ dir: dir1, idField: idField1 })
    .update(rec1[idField1], { sale: { ...rec1.sale, order_no: 'XSD-20261013-0003' } });
  const interrupted = await sessions.findInterruptedSales();
  console.log('DIAG-IN1 findInterruptedSales=', JSON.stringify(interrupted),
    '| uncertain=', JSON.stringify(await sessions.findUncertainInFlightSales()));
  assert.equal(interrupted.length, 1, `要识别出 1 个半截会话（实际 ${interrupted.length}）`);
  assert.equal(interrupted[0].orderNo, 'XSD-20261013-0003', '要带出那一笔的单号 ✓');
  assert.equal(interrupted[0].sessionId.includes('scan_session_'), true, '要带 session_id ✓');
  const fixed = await sessions.clearInterruptedSale(interrupted[0].openId);
  assert.equal((fixed.sale.lines || []).length, 0, '只清草稿 ✓');
  assert.equal((fixed.sale.completed || []).length, 1, '⭐ 账（completed）**一条不动** ✗');
  assert.equal((await sessions.findInterruptedSales()).length, 0, '清完后再扫 ⇒ 不再报 ✓');
});

test('AC-IN2 正常会话（草稿里有行、completed 里没有它）⇒ **一律不动** ✓', async () => {
  const sessions = newSessions('in2');
  const openId = 'ou_in2';
  await sessions.ensure(openId);
  await sessions.addLine(openId, { size: '40', amount: '10' });
  const before = await sessions.get(openId);
  const found = await sessions.findInterruptedSales();
  assert.equal(found.length, 0, '正在录入的单**不是**半截 ✓');
  const after = await sessions.get(openId);
  assert.deepEqual(after.sale.lines, before.sale.lines, '一律不动 ✓');
});

test('AC-IN3 判据不确定（草稿有单号但 completed 里查不到）⇒ **只记日志、不动数据** ✓', async () => {
  const sessions = newSessions('in3');
  const openId = 'ou_in3';
  await sessions.ensure(openId);
  await sessions.addLine(openId, { size: '40', amount: '10' });
  // 手工制造"不确定"：草稿带一个 completed 里没有的单号（用同一个目录自建 store ✓ 不依赖产品内部 ✓）
  const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'scan-draft-in3b-'));
  const s2 = createScanSessionService({ config: SCAN_WRITE, dir: tmp });
  await s2.ensure(openId);
  await s2.addLine(openId, { size: '40', amount: '10' });
  const rec = await s2.get(openId);
  const idField = SCAN_WRITE.session.idField;   // ⚠️ 我删旧块时把这个定义一起删过 ✗（已补）
  await new JsonTaskStore({ dir: tmp, idField }).update(rec[idField], { sale: { ...rec.sale, order_no: 'XSD-29990101-9999' } });
  const uncertain2 = await s2.findUncertainInFlightSales();
  assert.ok(uncertain2.length >= 1, '但要在"不确定"清单里可见（记日志用 ✓）');
  const before2 = await s2.get(openId);
  assert.deepEqual((await s2.findInterruptedSales()).length, 0, '不确定 ⇒ **不进**待修清单（保守 ✓）');
  const after2 = await s2.get(openId);
  assert.deepEqual(after2.sale.lines, before2.sale.lines, '⚠️ 数据**一个字都不许动** ✗');
  return;
  const before = await sessions.get(openId);
  const found = await sessions.findInterruptedSales();
  assert.equal(found.length, 0, '不确定 ⇒ **不进**待修清单（保守 ✓）');
  const uncertain = await sessions.findUncertainInFlightSales();
  assert.ok(uncertain.length >= 1, '但要在"不确定"清单里可见（记日志用 ✓）');
  const after = await sessions.get(openId);
  assert.deepEqual(after.sale.lines, before.sale.lines, '⚠️ 数据**一个字都不许动** ✗');
});
