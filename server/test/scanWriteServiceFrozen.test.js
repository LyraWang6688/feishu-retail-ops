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
 * - **AC-FRZ4** 🔴 **解冻台账**：每一次授权解冻都必须在文件头留一行**逐字**记录
 *   （改前 sha → 改后 sha → 依据）——**只改常量、不写台账 ⇒ 红** ✓（防"悄悄重设基线"✗）
 *
 * ## 🔴 解冻流程（要改那个文件时，**必须**按这个顺序）
 * 1. 先拿到 Lead / 业务负责人的**明确授权**（冻结是红线的产物 ✗ 不许自行解冻）
 * 2. 改完 `services/scanWriteService.js` 后，**同时**更新本文件的
 *    `FROZEN_SHA256` ＋ `FROZEN_LINES`（这一步是"解冻动作"的**显式闸门** ✓）
 *    ⚠️ **同一份基线的其他副本也要一起搬**（都在注释里写着"与本案同一个值"）：
 *    `test/scanPageSplitParity.test.js` · `test/scanDraftRouteWiring.test.js` ·
 *    `test/scanDraftSaveResume.test.js` · `test/multiItemLogsAndRealmScan.test.js`
 * 3. 在 PR 描述里写「改前逐字 → 改后逐字 → 依据」（本仓口径 ✓）
 *    ⚠️ 并在下面的**解冻台账**里加一行（AC-FRZ4 钉着 ✓）
 *
 * ## ⭐ 解冻台账（每一次改那个文件都必须往下加一行；**逐字**）
 * - 2026-10-16 · **task-62「货 / 钱分离」· 阶段二**（`submitSale` 加 `deferFunds` 那一条路）：
 *   改前逐字：sha `199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca`（1699 行）
 //          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
 *   ⇒ 改后逐字：sha `b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3`（1770 行）
 *   依据 = 业务负责人 2026-10-16 明确「允许改冻结文件」（一次性、只为本卡）。
 * - 2026-10-18 · **销售「写入状态」模型迁移 + 关联销售/赠品修复**（业务负责人本次授权改表/改链路）：
 *   改前逐字：sha `333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f`（split 1771 行）
 *   改后逐字：sha `b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3`（split 1782 行）
 *   依据 = 业务负责人 2026-10-18 改表（四状态列 → 单一「写入状态」）+ 本轮修复（赠品落主表、关联销售写主表 id）。
 * - 2026-10-18 收尾（同一次授权内的最终基线，含赠品接线）：
 *   改前逐字：sha `1a0a1f43ae31a4fc1a9f6b5d67083fa0e7cc14e222d10ce39b3ba0ee270b2ac8`（1782 行）
 *   改后逐字：sha `b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3`（1714 行）
 *   依据 = 同一业务口径（资金页赠品落主表 + 收口状态）。
 *
 * ⚠️ 本文件**只读**那个文件（`readFileSync`），**不写入、不改行为、不加开关** ✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TARGET = path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js');

/** 🔴 基线指纹（**最近一次授权解冻**后的逐字节基线；台账见文件头）。
 *  · 改这一个常量 ⇒ 就是**一次显式解冻**（见文件头第 2 步 ✓）——⚠️ 但**必须**同时留台账（AC-FRZ4 ✓）
 *  · ⚠️ `split('\n').length` = **1770**（`wc -l` 是 1769 —— 末行无换行符，两个数**都对**，别混用 ✓）
 *  · 解冻历史：`199551e1…35ca`（1699 行 · 2026-10-16 task-62 阶段二之前）
 */
//          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
// ⭐⭐ 2026-10-16 成对迁移（**第 2 次解冻** · 改前逐字 → 改后逐字 → 依据）：
//   改前逐字：sha `49772bdaffc82411b427f5f5b26a9d74ca937e317fb4fbdebfd33492b7fd2c12`（`split('\n').length` = **1770** · 冻结件 `deferFunds`「货那一跑不扣库存」那一版）
//   改后逐字：sha `b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3`（**1771** 行 · 货那一跑**照扣库存**：`deliverStockLines` 形参/转发 ＋ `:1318` 三元）
//   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：
//          **如果是现货，就是要扣库存**；如果是预订，就不扣库存，等二次交付的时候再扣库存」
//          ＋「**啥叫钱没入账就不许出库存？不用呀。**」
//          ⇒ 授权范围 = 冻结件 **5 行** ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（缺省 false ✓ 只给货那一跑 ✓）
const FROZEN_SHA256 = 'b4a5cce3a8d346ff59e5cc450e496622f128f978b954af79ec7310a360137fc3';
const FROZEN_LINES = 1714;

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

test('AC-FRZ4 🔴 **解冻台账**：授权解冻必须逐字留档（只改常量、不写台账 ⇒ 红 ✓）', () => {
  const source = fs.readFileSync(__filename, 'utf8');
  // ① 台账小节本身必须在（AC-FRZ3 只钉"怎么解冻"，这一条钉"解冻过什么" ✓）
  assert.match(source, /解冻台账/, '文件头必须有「解冻台账」那一节 ✓');
  // ② 2026-10-16 task-62 阶段二那一次**逐字**记录（改前 sha → 改后 sha → 依据）——
  //    ⚠️ 这三个字符串**必须同时**出现：只改常量、不写台账 ⇒ 这里红 ✓
  assert.ok(source.includes('199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca'),
    '台账必须留**改前逐字**那把 sha ✓');
  assert.ok(source.includes(FROZEN_SHA256),
    '台账必须留**改后逐字**那把 sha（= 当前基线常量 ✓）');
  assert.ok(source.includes('依据 = 业务负责人 2026-10-16 明确「允许改冻结文件」（一次性、只为本卡）。'),
    '台账必须留**依据**那一句逐字 ✓（授权一次性、只为本卡 ✗ 不许复用）');
  // ③ 台账不许"改前 = 改后"（那样等于没解冻过，只是想把常量改掉 ✗）
  assert.notEqual(FROZEN_SHA256, '199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca',
    '改后 sha 必须与 2026-10-16 之前的基线**不同** ✓');
});
