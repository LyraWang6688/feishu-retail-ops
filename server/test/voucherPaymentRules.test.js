'use strict';

/**
 * ⭐⭐ 2026-10-16（业务负责人定案 · 逐字）：
 *   「**差额的计算按照面值来，但是收款明细里的收款金额按照平台结算款来**」
 *   「**是的，抖音团购券的是待平台结算**，你可以看到我们往群里推送抖音团购券的消息链路」
 *
 * ⇒ 三条口径（**配置点名 / 既有先例**，本文件照它们钉）：
 *   ① **差额（未收款）算** = 券的【**面值**】（截图真值 ¥100.00）
 *   ② **收款明细那一笔的金额** = 【**平台结算款**】（截图真值 ¥47.40；另一张 ¥85.40）
 *   ③ 那一笔的**状态** = 【**待平台结算**】
 *      ⭐ 先例：群聊那条链路的 `groupBuyVoucherPolicy.js`（已于 2026-10-18 按「无前端入口」删除）
 *        就是 `{ method: '抖音团购券', amount: voucher.settlementAmount, status: '待平台结算' }` ✓
 *   ④ 「券方式 ⇒ 金额可空」的判据 = 收款方式表里那个「**团购券管理**」**关联列非空** ✓
 *      （语义键在 `config/v1BitableSchema.js` 的 `voucher: '团购券管理'` ✓）
 *
 * ⭐⭐ **2026-10-16 迁移（分阶段判据体检）**：这里原有 **4 条"自足替身闸门"** —— 只测**文件内本地 lambda**、
 *   **不 import 任何实现** ⇒ **永远变不成真判据** ✗，却一直打"待激活"字样，让人误以为"这功能还没做" ✗。
 *   · 改前逐字（4 条，逐条）：`test('③ 待激活闸门：**差额按面值**…')` /
 *     `…('③ 待激活闸门：**明细金额 = 平台结算款**、**状态 = 待平台结算**…')` /
 *     `…('③ 待激活闸门：**券方式金额可空**…')` / `…('③ 待激活闸门 + 探针：**券没映射到方式…**')`
 *   · 改后逐字：**删掉这 4 条** ⇒ 换成 **`AC-VR-COVER` 机器可查的覆盖证明**（指到真判据的 AC 编号 ✓）
 *   · 依据：① 业务负责人 2026-10-16 逐字（差额按面值 / 明细按结算款 / 状态待平台结算）
 *           ② **#704 已落地** ⇒ 这 5 条规则的**真判据**已在 `voucherPaymentRoute.test.js`（路由级，**能真红** ✓）
 *           ③ 它们的真实实现都在**路由 / 服务内部**（**没有**导出成纯函数）⇒ **无法 import 成真判据** ✗
 *              ⇒ 按本仓纪律取**方案 B（删 + 覆盖证明）** ✓，**不留"永远变不真"的壳** ✗
 *
 * 🔴 只动 `server/test/**` ✓（`routes/**` / `views/**` / `config/**` / `scanWriteService.js` 一个字没改 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { findVoucher, voucherKey, toCents } = require('../src/config/groupBuyVouchers');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

/** ⭐ 她截图里的真值（两张券）：面值都是 100，平台结算款分别 47.40 / 85.40 ✓ */
const VOUCHER_ROWS = Object.freeze([
  Object.freeze({ purchasePrice: 47.4, faceValue: 100, settlementAmount: 47.4 }),
  Object.freeze({ purchasePrice: 85.4, faceValue: 100, settlementAmount: 85.4 }),
]);

/** ⭐ 收款方式表 4 行（两条抖音券：关联列分别指向上面两条券 ✓；两条普通方式：关联列为空 ✓） */
const PAYMENT_METHOD_ROWS = Object.freeze([
  Object.freeze({ name: '微信收款', voucher: null }),
  Object.freeze({ name: '现金收款', voucher: null }),
  Object.freeze({ name: '抖音团购券（47.40）', voucher: VOUCHER_ROWS[0] }),
  Object.freeze({ name: '抖音团购券（85.40）', voucher: VOUCHER_ROWS[1] }),
]);

/** 夹具：假网关（测试 Base **没有**那一列 ✗ ⇒ 必须用假的 ✓）——⑤ 接线那刀可直接拿去用 ✓ */
const voucherFixture = () => ({
  paymentMethods: PAYMENT_METHOD_ROWS.map((row) => ({ ...row })),
  vouchers: VOUCHER_ROWS.map((row) => ({ ...row })),
});

/** 「券方式」= 关联列非空那条（她 ④ 的判据 ✓）。 */
const isVoucherMethod = (row) => Boolean(row.voucher);
/** 「差额按面值」：货品累计 − Σ（券的**面值**）。 */
const unpaidByFaceValue = (goodsTotal, voucherRows) => goodsTotal
  - voucherRows.reduce((sum, row) => sum + Number(row.faceValue || 0), 0);
/** 「明细那一笔」：金额取**结算款**、状态取**待平台结算**（既有先例的形状 ✓）。 */
const paymentLineOf = (row) => ({ amount: row.voucher.settlementAmount, status: '待平台结算' });

test('⭐ 今天能钉（真判据）：目录查表按「采购价｜面值」认券 —— 她两张券都能认出来 ✓', () => {
  const { vouchers } = voucherFixture();
  assert.equal(findVoucher(vouchers, { purchasePrice: 47.4, faceValue: 100 }), vouchers[0], '47.40 那张 ✓');
  assert.equal(findVoucher(vouchers, { purchasePrice: 85.4, faceValue: 100 }), vouchers[1], '85.40 那张 ✓');
  assert.equal(findVoucher(vouchers, { purchasePrice: 47.4, faceValue: 99 }), undefined, '面值对不上 ⇒ 不认（返回 undefined ✓ 调用方给追问 ✓）');
  assert.equal(voucherKey({ purchasePrice: 47.4, faceValue: 100 }), `${toCents(47.4)}|${toCents(100)}`, '键口径 ✓');
});

test('⭐ 今天能钉（真判据）：语义键 `voucher` 仍指向「团购券管理」（谁改名 ⇒ 红 ✓）', () => {
  const paymentMethod = V1_BITABLE_SCHEMA.tables.paymentMethod || V1_BITABLE_SCHEMA.tables.paymentMethods;
  assert.ok(paymentMethod?.fields?.voucher, '收款方式表上必须有 `voucher` 语义键 ✓');
  assert.equal(paymentMethod.fields.voucher, '团购券管理', '🔴 它指向的列名就是「团购券管理」（她 ④ 的判据靠它 ✓）');
});

test('⭐ 今天能钉（真判据）：夹具本身 —— 4 行方式里**恰两条**是券方式（关联列非空 ✓）', () => {
  const { paymentMethods } = voucherFixture();
  const voucherMethods = paymentMethods.filter(isVoucherMethod);
  assert.equal(paymentMethods.length, 4, '4 行 ✓');
  assert.equal(voucherMethods.length, 2, '恰两条抖音券 ✓');
  assert.deepEqual(voucherMethods.map((row) => row.voucher.settlementAmount), [47.4, 85.4], '两条券的结算款逐字 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 迁移落点：4 条"自足替身闸门"**已删** ⇒ 换成**机器可查的覆盖证明**
// ═══════════════════════════════════════════════════════════════════════════
/**
 * 这 5 条规则**各有**真判据（`voucherPaymentRoute.test.js` 路由级 ✓ 能真红 ✓）——
 * ⚠️ 覆盖者**写死在这里**：谁把那边的判据**改名 / 删掉** ⇒ 本文件**红** ✓（覆盖关系不是口头承诺 ✗）
 */
const COVERAGE = Object.freeze([
  ['① 差额 = 券的【面值】（未收款 = 货品 − (面值 − 结算款)）', ['AC-VP1', 'AC-VP2b']],
  ['② 收款明细那一笔 = 【平台结算款】', ['AC-VP1', 'AC-VP4b']],
  ['③ 那一笔的状态 = 【待平台结算】', ['AC-VP3']],
  ['④ 券方式 ⇒ 金额可空（关联列非空 ✓）', ['AC-VP2b', 'AC-VP7']],
  ['⑤ 券没映射到收款方式 ⇒ `scan.write.voucher_method_unmapped`', ['AC-VP5', 'AC-VP6']],
]);

test('AC-VR-COVER 🔴 覆盖证明：上面 5 条规则**各有**真判据（覆盖者改名/删掉 ⇒ 红 ✓）', () => {
  const routeTests = fs.readFileSync(path.join(__dirname, 'voucherPaymentRoute.test.js'), 'utf8');
  // ⚠️ 三种引号都匹配（`voucherPaymentRoute` 里有反引号模板写法的用例名 ✓）
  const ids = new Set([...routeTests.matchAll(/test\(['"`](AC-VP\w+)/g)].map((match) => match[1]));
  assert.ok(ids.size >= 10, `路由级真判据应当有 10+ 条（实得 ${ids.size}）✓`);
  for (const [rule, covers] of COVERAGE) {
    assert.ok(covers.length > 0, `${rule} 必须至少有一个覆盖者 ✓`);
    for (const id of covers) {
      assert.ok(ids.has(id), `🔴 ${rule} 的覆盖者 ${id} 在 voucherPaymentRoute.test.js 里**不存在** ✗（删错/改名 ⇒ 红 ✓）`);
    }
  }
  // 🔴 本文件不许再有**打印**「待激活」的壳（正文里引用旧写法作历史记录是允许的 ✓）
  const self = fs.readFileSync(__filename, 'utf8');
  assert.equal(/^\s*console\.log\('[^']*待激活/m.test(self), false, '不许再有打印「待激活」的 console.log ✗');
  assert.equal(/^test\('[^']*待激活/m.test(self), false, '不许再有名字里带「待激活」的用例 ✗');
});
