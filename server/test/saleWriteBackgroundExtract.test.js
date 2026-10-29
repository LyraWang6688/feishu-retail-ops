'use strict';

/**
 * ⭐⭐ ⑤ 模块化（外部评审建议 · 业务负责人定的「重中之重」）
 *   **把 `scanWriteService` 的"后台那一半"剥成 `saleWriteBackgroundService`** 的验收用例。
 *
 * 本刀的性质：**只挪不改**（零行为变化）——
 *   · 日志事件名与字段 / `submitKey` 幂等 / 状态值域 / `_confirm`（绝不许直调）**逐字未动** ✗
 *   · 对外接口**一模一样**（`require('…/scanWriteService')` 的既有导出照旧可用）✓
 *
 * AC：
 *   · **AC-R1** 剥离后旧文件**行数明显下降**（本用例钉住"旧文件里不再有那两处实现" ＋ 记录前后数字）
 *             ⚠️ 2026-10-16：task-62 阶段二（**授权**改冻结件）让旧文件 +72 行 ⇒ 原来那句
 *             `oldLines < 1700` 的**代理指标**换成**登记确切行数 1770**（真判据仍是"实现只在新文件里" ✓）
 *   · **AC-R2** 行为零变化（由既有的那 6 个用例文件覆盖 ⇒ 见 PR 证据；本文件钉"形状"那一半）
 *   · **AC-R3** 源码哨兵：后台那一半**只在新文件里定义**；旧文件只 **re-export**；
 *            且 **两边都没有任何 `_confirm` 直调**
 *   · **AC-R4** **不循环依赖**：真起一个子进程 `require('…/scanWriteService')` 能加载 ✓
 */

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_extract_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'extract_secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER_DIR = path.join(__dirname, '..');
const OLD = path.join(SERVER_DIR, 'src', 'services', 'scanWriteService.js');
const NEW = path.join(SERVER_DIR, 'src', 'services', 'saleWriteBackgroundService.js');

const readOld = () => fs.readFileSync(OLD, 'utf8');
const readNew = () => fs.readFileSync(NEW, 'utf8');
const countLines = (file) => fs.readFileSync(file, 'utf8').split('\n').length;

// ═══════════════════════════════════════════════════════════════════════════
// AC-R1 / AC-R3 源码哨兵：实现只在新文件；旧文件只解构 + re-export
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R1 ⭐ 剥离后旧文件**行数明显下降**，且那两处**实现**已不在旧文件里', () => {
  const oldSrc = readOld();
  // ⭐⭐ 2026-10-16 第 2 次解冻 · 成对迁移：改前逐字 `1770` ⇒ 改后逐字 `1736`
  //    依据 = 业务负责人 22:0x「现货就是要扣库存」＋「啥叫钱没入账就不许出库存？不用呀。」
  //    （冻结件只动批准的 5 行 ✓）
  const oldLines = countLines(OLD);
  const newLines = countLines(NEW);
  // 🔴 判据（可复算）：**实现**（`const Xxx = ...` 那两行）只许在新文件出现
  for (const name of ['scheduleSaleRest', 'markSaleWriteFailed']) {
    assert.equal(
      new RegExp(`const ${name} = `).test(oldSrc), false,
      `旧文件里不该再有 \`${name}\` 的**实现**（已挪走 ✗）`,
    );
    assert.equal(
      new RegExp(`const ${name} = `).test(readNew()), true,
      `\`${name}\` 的实现在新文件里 ✓`,
    );
    // ⭐ 旧文件仍然**解构**出这个名字 ⇒ 既有调用点/用例**一个字都不用改** ✓
    assert.ok(oldSrc.includes(name), `旧文件里要保留 \`${name}\` 这个名字（解构/调用 ✓）`);
  }
  // 登记簿那套也只许在新文件里
  assert.equal(/const pendingSaleBackgrounds = new Set\(\);/.test(oldSrc), false,
    '登记簿不该再定义在旧文件里 ✗');
  assert.ok(/const pendingSaleBackgrounds = new Set\(\);/.test(readNew()), '登记簿在新文件里 ✓');
  // 剥离确实让旧文件变小（实现搬走了 ⇒ 旧 < 新 + 原基线）；这里只钉"旧文件里已无实现"这个**可复算**的判据
  // ⚠️ **2026-10-16 成对迁移**（task-62「货 / 钱分离」阶段二 · 业务负责人明确「允许改冻结文件」，
  //    **一次性、只为本卡**）：旧文件 1698 → **1736** 行（那条 `deferFunds` 路 + 它的注释）。
  //    ⇒ 原来那句 `oldLines < 1700`（**剥离效果的代理指标**，不是本刀的真判据 —— 真判据是上面
  //       "那两处实现只在新文件里" ✓）在授权新增之后**不再成立** ⇒ 改成**登记确切行数**：
  //       多一行 / 少一行都要**显式**改这一行（与冻结哨兵的 AC-FRZ1 同一份基线 ✓ **不是放宽** ✗）。
  // ⭐ 2026-10-18 · task-2：冻结件加了两处**可选** sessionKey 透传 ⇒ 登记行数 1736 → 1748（见冻结哨兵台账 ✓）
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`assert.equal(oldLines, 1748, …应等于登记值 1748…）`
  //   改后逐字：`assert.equal(oldLines, 1728, …应等于登记值 1728…）`
  //   依据 = 2026-10-18 第 4 步提速（货品页只建主表 / 资金页一次跑完）—— 冻结件加了
  //     `masterOnly` / `oneShot` 两条**显式布尔**开关与收口调用，登记行数跟着显式登记 ✓
  //   2026-10-29 · 扫码页「一单多货」补货假成功 P0（业务负责人授权解冻 · 见冻结哨兵台账）：
  //     改前逐字：1728 → 改后逐字：1732（多货品写入件增加「扁平 payload → 本地 task → publish」那段）
  assert.equal(oldLines, 1732, `旧文件行数（${oldLines}）应等于登记值 1732（2026-10-29 修扫码页一单多货 P0 · 见冻结哨兵台账 ✓）`);
  assert.ok(newLines > 100, `新文件应是"一件实事"（实际 ${newLines} 行）`);
});

test('AC-R3 🔴 源码哨兵：旧文件只 **re-export** · 新文件**不反向 require**（无循环）· 两边都无 `_confirm` 直调', () => {
  const oldSrc = readOld();
  const newSrc = readNew();
  // ① 旧文件单向 require 新件
  assert.ok(oldSrc.includes("require('./saleWriteBackgroundService')"),
    '旧文件要 require 新件（只单向 ✓）');
  // ② 新件**不许** require 旧件（否则循环依赖 ✗）
  assert.equal(/require\(['"]\.\/scanWriteService['"]\)/.test(newSrc), false,
    '新件**不许**反向 require 旧件 ✗（会造成循环依赖）');
  // ③ 对外接口一模一样：`waitForPendingSaleBackgrounds` 仍从**旧模块**导出（用例 import 一个字没改 ✓）
  assert.ok(/waitForPendingSaleBackgrounds,/.test(oldSrc), '旧模块继续导出它 ✓');
  assert.ok(/waitForPendingSaleBackgrounds/.test(newSrc), '实现（登记簿的等）在新模块里 ✓');
  // ④ `_confirm` 仍然没有任何直调（既有哨兵的口径：`. _confirm(` 这种**调用**形状）
  for (const [label, src] of [['旧文件', oldSrc], ['新文件', newSrc]]) {
    assert.equal(/\.\s*_confirm\s*\(/.test(src), false, `${label}里不许直调 \`_confirm\` ✗`);
  }
  // ⑤ 幂等那一半必须**仍是同一把键**：新件里那行 `noDefer: true` + `restInput` **逐字还在**
  assert.ok(newSrc.includes('submitSale({ ...restInput, noDefer: true, requestId, timing }, { correlation })'),
    '后台那一跑仍然是"同一把 key 的第二次 submitSale" ✓（幂等一字没拆 ✗）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-R4 不循环依赖：**真起子进程** require 一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-R4 ⭐ 真起子进程 `require("…/scanWriteService")` ⇒ 能加载、导出照旧（无循环依赖）', () => {
  const out = execFileSync(process.execPath, ['-e', [
    "const m = require('./src/services/scanWriteService');",
    "console.log(JSON.stringify({",
    "  hasFactory: typeof m.createScanWriteService === 'function',",
    "  hasEntry: typeof m.createSalesEntryWithOrderNo === 'function',",
    "  hasReadCache: typeof m.createReadOnlyReferenceCache === 'function',",
    "  wait: typeof m.waitForPendingSaleBackgrounds,",
    "}));",
  ].join('\n')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      LARK_AGENT_APP_ID: process.env.LARK_AGENT_APP_ID || 'cli_extract_test',
      LARK_AGENT_APP_SECRET: process.env.LARK_AGENT_APP_SECRET || 'extract_secret',
    },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(parsed, {
    hasFactory: true, hasEntry: true, hasReadCache: true, wait: 'function',
  }, '既有导出一个都不许少 ✓（新件实现、旧件 re-export）');
});
