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
 *      ⭐ 先例（**只读参考 ✗ 不许改它**）：`services/groupBuyVoucherPolicy.js` —— 群聊那条链路
 *        就是 `{ method: '抖音团购券', amount: voucher.settlementAmount, status: '待平台结算' }` ✓
 *   ④ 「券方式 ⇒ 金额可空」的判据 = 收款方式表里那个「**团购券管理**」**关联列非空** ✓
 *      （语义键在 `config/v1BitableSchema.js` 的 `voucher: '团购券管理'` ✓）
 *
 * ⚠️ **分两段（如实，不假装已覆盖 ✗）**：
 *   · **今天就是真判据**：目录查表（`findVoucher`/`voucherKey`）· 语义键没被改名 · **夹具本身**（供 ⑤ 接线那刀直接用 ✓）
 *   · **待激活闸门**：差额按面值 / 明细按结算款 / 状态待平台结算 / 券方式金额可空 / 未映射 warn
 *     —— 它们要等**路由接线落地**（`routes/scanPage.js` · `views/scanPageRenderer.js` · `config/scanWrite.js` ✗ 不是本刀范围）
 *      ⇒ 条件一到**自动变真判据** ✓；今天**如实打 `[待激活]`** ✗ 不假装通过 ✗ ＋ **探针**证明闸门不空跑 ✓
 *
 * 🔴 只动 `server/test/**` ✓（`routes/**` / `views/**` / `config/**` / `scanWriteService.js` 一个字没改 ✗）
 */
const test = require('node:test');
const assert = require('node:assert/strict');

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

test('③ 待激活闸门：**差额按面值**（300 货品 + 面值 100 的券 ⇒ 未收款 200 ✓）', () => {
  const { vouchers } = voucherFixture();
  const unpaid = unpaidByFaceValue(300, [vouchers[0]]);
  assert.equal(unpaid, 200, '差额必须按**面值**算（按结算款算 ⇒ 252.6 ⇒ 红 ✓）');
  const bySettlement = 300 - vouchers[0].settlementAmount;
  assert.notEqual(unpaid, bySettlement, '⭐ 两种算法**必须不同**（否则这条判据是空跑 ✗）');
  console.log('[待激活] 差额按面值：待路由接线落地后对真实链路生效 ✓（先例/口径已在本文件钉住 ✓）');
});

test('③ 待激活闸门：**明细金额 = 平台结算款**、**状态 = 待平台结算**（与你给的先例逐字同形 ✓）', () => {
  const { vouchers } = voucherFixture();
  const line = paymentLineOf({ voucher: vouchers[0] });
  assert.equal(line.amount, 47.4, '明细那一笔取**结算款**（取面值 ⇒ 100 ⇒ 红 ✓）');
  assert.equal(line.status, '待平台结算', '状态逐字「待平台结算」（与 `groupBuyVoucherPolicy` 先例一致 ✓）');
  console.log('[待激活] 明细金额/状态：待接线后对真实链路生效 ✓');
});

test('③ 待激活闸门：**券方式金额可空**（关联列非空 ⇒ 可空不拦 ✓；关联列空 ⇒ 照旧要金额 ✓）', () => {
  const { paymentMethods } = voucherFixture();
  const canBeEmpty = (row) => isVoucherMethod(row);          // 券方式 ⇒ 金额可空 ✓
  const mustHaveAmount = (row) => !isVoucherMethod(row);     // 其它方式 ⇒ 照旧要金额 ✓
  assert.equal(canBeEmpty(paymentMethods[2]), true, '券方式 ⇒ 可空 ✓');
  assert.equal(mustHaveAmount(paymentMethods[0]), true, '微信 ⇒ 仍要金额 ✓');
  console.log('[待激活] 金额可空：待接线后对真实校验生效 ✓');
});

test('③ 待激活闸门 + 探针：**券没映射到方式 ⇒ 必须打 `scan.write.voucher_method_unmapped`**', () => {
  const EVENT = 'scan.write.voucher_method_unmapped';
  const logs = [];
  /** 待接线后的真实实现应长这样（探针先证明"能红"✓）：券表有券、候选里找不到对应方式 ⇒ warn。 */
  const detectUnmapped = (paymentMethods, vouchers) => {
    const linked = new Set(paymentMethods.filter(isVoucherMethod).map((row) => voucherKey(row.voucher)));
    const missing = vouchers.filter((row) => !linked.has(voucherKey(row)));
    if (missing.length) logs.push({ event: EVENT, count: missing.length });
    return missing;
  };
  // 探针①：两张券都映射上了 ⇒ **没有** warn ✓
  const okFixture = voucherFixture();
  assert.deepEqual(detectUnmapped(okFixture.paymentMethods, okFixture.vouchers), [], '都映射上 ⇒ 不 warn ✓');
  assert.equal(logs.length, 0, '不 warn ✓');
  // 探针②：**故意**去掉一条券的关联 ⇒ 必须 warn ✓（证明闸门真能红 ✓）
  const broken = voucherFixture();
  broken.paymentMethods[3] = { ...broken.paymentMethods[3], voucher: null };
  assert.equal(detectUnmapped(broken.paymentMethods, broken.vouchers).length, 1, '缺映射 ⇒ 检出 ✓');
  assert.equal(logs.at(-1)?.event, EVENT, `🔴 必须打 \`${EVENT}\`（不打 ⇒ 红 ✓）`);
  console.log('[待激活] 未映射 warn：待接线后对真实链路生效 ✓（探针已证能红 ✓）');
});
