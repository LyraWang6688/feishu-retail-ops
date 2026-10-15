'use strict';

/**
 * scanWriteServiceFrozen.test.js —— **冻结反向哨兵**：谁动 `services/scanWriteService.js` 一个字就红 ✓
 *
 * ## 为什么要有它（task-58）
 * `services/scanWriteService.js` 是**余量 0 的冻结文件**（一个字不许加/删/改 ✗）——
 * 但在此之前"冻结"**只写在注释和口头里**，**没有任何判据**：
 * 谁把余量吃掉、谁顺手改一句注释，**都不会红** ✗（今晚就有一处注释与实现相反、
 * 差点据此判错方向 —— 见 `docs/open-risk-notes-2026-10-16.md` ①）。
 * ⇒ 本文件把"冻结"变成**可执行的判据** ✓
 *
 * ## 判据
 * - **AC-FRZ1** 🔴 指纹（sha256）＋ 行数与**基线**逐字一致 ⇒ 改/加/删**任意一个字节**就红 ✓
 * - **AC-FRZ2** ⭐ 探针：指纹函数**真能认出改动**（不是空跑）✓
 * - **AC-FRZ3** 🔴 冻结期内的**唯一合法动作**写在下面（解冻必须**显式**改本文件的常量 ✓）
 *
 * ## 🔴 解冻流程（要改那个文件时，**必须**按这个顺序）
 * 1. 先拿到 Lead / 业务负责人的**明确授权**（冻结是红线的产物 ✗ 不许自行解冻）
 * 2. 改完 `services/scanWriteService.js` 后，**同时**更新本文件的
 *    `FROZEN_SHA256` ＋ `FROZEN_LINES`（这一步是"解冻动作"的**显式闸门** ✓）
 * 3. 在 PR 描述里写「改前逐字 → 改后逐字 → 依据」（本仓口径 ✓）
 *
 * ⚠️ 本文件**只读**那个文件（`readFileSync`），**不写入、不改行为、不加开关** ✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js');

/** 🔴 基线指纹（`main 56b6550` 时实测）。
 *  · 改这一个常量 ⇒ 就是**一次显式解冻**（见文件头第 2 步 ✓）
 *  · ⚠️ `split('\n').length` = **1699**（`wc -l` 是 1698 —— 末行无换行符，两个数**都对**，别混用 ✓）
 */
const FROZEN_SHA256 = '199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca';
const FROZEN_LINES = 1699;

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const linesOf = (text) => String(text).split('\n').length;

test('AC-FRZ1 🔴 冻结：`scanWriteService.js` 与基线**逐字节一致**（谁改一个字就红）', () => {
  const raw = fs.readFileSync(TARGET);
  const actual = sha256Of(raw);
  assert.equal(raw.length > 0, true, '那个文件必须存在且非空 ✓');
  assert.equal(actual, FROZEN_SHA256,
    '🔴 冻结文件被改动了 ✗ —— 这是余量 0 的文件（含**注释** ✗）。\n'
    + '   若这是**授权过的解冻**：请**同时**更新本文件的 `FROZEN_SHA256`（见文件头"解冻流程"）✓\n'
    + '   若不是：请把那一个字节改回去 ✗');
  assert.equal(linesOf(raw.toString('utf8')), FROZEN_LINES,
    `行数也必须一致（基线 ${FROZEN_LINES}）—— 加/删一行同样算改 ✗`);
});

test('AC-FRZ2 ⭐ 探针：指纹**真能认出**改动（证明 AC-FRZ1 不是空跑 ✓）', () => {
  const raw = fs.readFileSync(TARGET);
  assert.equal(sha256Of(raw), FROZEN_SHA256, '原样 ⇒ 指纹一致 ✓');
  // ① 末尾多一个空字节 ⇒ 指纹必须变
  assert.notEqual(sha256Of(Buffer.concat([raw, Buffer.from(' ')])), FROZEN_SHA256,
    '多一个空格 ⇒ **必须**报红 ✓');
  // ② 中间**换一个字符** ⇒ 指纹必须变
  const text = raw.toString('utf8');
  const mutated = text.slice(0, 100) + (text[100] === 'x' ? 'y' : 'x') + text.slice(101);
  assert.notEqual(sha256Of(Buffer.from(mutated, 'utf8')), FROZEN_SHA256,
    '中间换一个字符 ⇒ **必须**报红 ✓');
  // ③ 只改**注释**一个字 ⇒ 也必须红（冻结包含注释 ✓）
  const commentMutated = text.replace('//', '// ', 1);
  assert.notEqual(sha256Of(Buffer.from(commentMutated, 'utf8')), FROZEN_SHA256,
    '只改注释一个字 ⇒ **必须**报红（冻结含注释 ✓）');
  // ④ 行数探测：加一行 ⇒ 行数必须变
  assert.notEqual(linesOf(`${text}\n`), FROZEN_LINES, '加一行 ⇒ 行数必须变 ✓');
});

test('AC-FRZ3 🔴 冻结的**唯一**合法出口 = 显式更新本文件的基线常量', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  assert.match(source, /const FROZEN_SHA256 = '[0-9a-f]{64}';/,
    '基线指纹必须是**写死的 64 位十六进制**（不是"读 git"这种会漂的写法 ✓）');
  assert.match(source, /const FROZEN_LINES = \d+;/,
    '行数基线也必须写死 ✓');
  assert.match(source, /解冻流程/, '文件头必须留着"怎么解冻"的说明 ✓（否则后人只会把常量改掉 ✗）');
});
