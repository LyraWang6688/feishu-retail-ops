'use strict';

/**
 * ⭐⭐ 2026-10-16（⑫ · 业务负责人逐字）：
 *   「**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，才可以点击提交跳转到资金页，
 *    **不用做那个为空去单价的功能了**」
 *   ＋（#667 查实的事实）**补货与退货共用同一道闸门 + 同一套配置** ✗ ⇒ **不能靠关一个开关**分链路 ✗
 *     （一关把退货也放开 ✗）⇒ 正确做法 = **`PURCHASE_AMOUNT` 按链路分档**（旧键不改名 ✓）。
 *
 * 本文件钉**配置那一半**（`config/scanWrite.js`）—— 路由怎么用那一档是**下一刀**的事 ✓
 * （计划见 `docs/purchase-amount-and-label-plan-2026-10-16.md` 的 A1）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC-PA-T1 ⭐ **按链路分档**：`requiredByRealm` 三条链路都在、且都是**显式布尔**；
 *            旧键 `required` **仍在**（兼容用，**没改名** ✗）。
 *   AC-PA-T2 ⭐ **配置先行**：三个档位各有自己的 env 键（改一个值**不需要改代码** ✓）、
 *            且都走 `readFlag`（**显式布尔** ⇒ 清空/写 false 就真关掉，**不许 `||` 兜底** ✗）。
 *   AC-PA-T3 🔴 **文案与校验一致**：销售那行的标签**不再写「（可不填）」**（它是必填 ✓）、
 *            placeholder **不再承诺「留空按货品单价」**（那条兜底**不做了** ✗）。
 *            ⚠️ 只针对**销售那一行**：`giftLabel` 的「（可不填）」是**另一件事**，**保留** ✓。
 *   AC-PA-T4 ⭐ **「别动」哨兵**：她 2026-10-11 定的「**收款行预置 1 行**」**不许被本刀顺手改掉** ✗。
 *   AC-PA-T5 ⭐ **边界**：本刀只动**配置文案与新键** ⇒ 销售的**校验**一个字没改 ✓。
 * ─────────────────────────────────────────────────────────────────────────
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SCAN_WRITE } = require('../src/config/scanWrite');
const SOURCE = fs.readFileSync(path.join(__dirname, '../src/config/scanWrite.js'), 'utf8');

const REALMS = ['replenish', 'return', 'accept'];

test('AC-PA-T1 ⭐ 按链路分档：三条链路都在、都是显式布尔；旧键 `required` 仍在且没改名', () => {
  const tiers = SCAN_WRITE.purchaseAmount?.requiredByRealm;
  assert.ok(tiers && typeof tiers === 'object', '`purchaseAmount.requiredByRealm` 必须存在（按链路分档 ✓）');
  for (const realm of REALMS) {
    assert.equal(typeof tiers[realm], 'boolean',
      `「${realm}」那一档必须是**显式布尔**（不许 undefined / 字符串 —— 那会变成 `||` 兜底那类关不掉的写法 ✗）`);
  }
  // 旧键**不改名**：老 `.env` / 老用例仍读它 ✓
  assert.equal(typeof SCAN_WRITE.purchaseAmount.required, 'boolean', '旧键 `required` 必须**还在**（兼容 ✓ 不改名 ✗）');
  assert.ok(/^\s*required: readFlag\(process\.env, 'SCAN_PURCHASE_AMOUNT_REQUIRED', true\)/m.test(SOURCE),
    '旧键那一行**逐字不变**（改前逐字：`required: readFlag(process.env, \'SCAN_PURCHASE_AMOUNT_REQUIRED\', true),`）');
});

test('AC-PA-T2 ⭐ 配置先行：三档各有 env 键、都走 `readFlag`（改一个值不用改代码 ✓）', () => {
  for (const key of ['SCAN_PURCHASE_AMOUNT_REQUIRED_REPLENISH', 'SCAN_PURCHASE_AMOUNT_REQUIRED_RETURN',
    'SCAN_PURCHASE_AMOUNT_REQUIRED_ACCEPT']) {
    assert.ok(SOURCE.includes(`'${key}'`), `「${key}」必须在配置里点名（换值不改代码 ✓）`);
    assert.match(SOURCE, new RegExp(`readFlag\\(process\\.env, '${key}'`),
      `「${key}」必须走 readFlag（**显式布尔**：清空/写 false 就真关掉 ✓ 不许 \`||\` 兜底 ✗）`);
  }
  // 三档的读取一律 readFlag ⇒ 源码里**不许**出现 `process.env.SCAN_PURCHASE_AMOUNT_REQUIRED_* ||`
  assert.equal(/\|\|\s*(true|false)\b/.test(SOURCE), false,
    '配置里**不许** `|| true/false` 那种兜底（清空就关不掉了 ✗）');
});

test('AC-PA-T3 🔴 文案与校验一致：标签去掉「（可不填）」· placeholder 不再承诺「单价」兜底', () => {
  assert.equal(SCAN_WRITE.texts.amountLabel, '实收金额',
    '改前逐字 `实收金额（可不填）` ⇒ 改后逐字 `实收金额`（她 2026-10-16：「**用户必须填写**」✓）');
  assert.equal(SCAN_WRITE.texts.amountLabel.includes('可不填'), false, '标签里**不许**再出现「可不填」✗');
  assert.equal(String(SCAN_WRITE.texts.amountPlaceholder || '').includes('单价'), false,
    'placeholder **不许**再承诺「留空按货品单价」（她：「**不用做那个为空去单价的功能了**」✗）');
  // ⚠️ 只针对销售那一行：赠品那行的「（可不填）」是**另一件事**，**保留**（别误伤 ✗）
  assert.equal(SCAN_WRITE.texts.giftLabel, '赠品（可不填）', '赠品标签**保持逐字不变**（她 2026-10-12 拍的 ✓）');
});

test('AC-PA-T4 ⭐ 「别动」哨兵：她 2026-10-11 定的「收款行预置 1 行」不许被本刀顺手改掉', () => {
  assert.equal(SCAN_WRITE.sale.paymentRowCount, 1, '收款行预置 **1** 行（她：「一行都是一行啊，微信默认」✓）');
  assert.ok(SOURCE.includes('预置 **1** 行'),
    '那条 2026-10-11 的旧注释**原样还在**（本刀**不许动**它 ✗）');
});

test('AC-PA-T5 ⭐ 边界：本刀只动配置文案与新键 ⇒ 销售的**校验**一个字没改', () => {
  const codes = SCAN_WRITE.sale.formFailureCodes || [];
  for (const code of ['line_amount_invalid', 'accessory_amount_invalid']) {
    assert.ok(codes.includes(code), `销售的「每件实收」校验码「${code}」必须**仍在**（本刀没碰校验 ✓）`);
  }
  assert.equal(SCAN_WRITE.fields.amount, 'amount', '字段名没动 ✓（改文案 ≠ 改字段 ✗）');
  // 采购整单金额那个**字段名**也没动（只加档位）
  assert.equal(SCAN_WRITE.purchaseAmount.field, 'purchase_amount', '采购金额字段名没动 ✓');
});
