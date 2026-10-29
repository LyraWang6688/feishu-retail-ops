'use strict';

/**
 * ⭐⭐ 2026-10-16 晚（业务负责人**裁定** · 弹窗逐字确认过）：
 *   「**客户少付 ⇒ 自动记一条【未收款】（差额）**」
 *   例：货品 300、客户只付 100 ⇒ **系统自动**写一条【未收款 200】✓
 *   我问的原话：「客户少付钱时…那 200 差额**要不要系统自动**写一条【未收款】？」
 *   ⇒ 她选 **「A：自动记（差额⇒未收款）」**。
 *
 * 依据（她 2026-10-14 逐字两条）：
 *   ① 「**只要本次付的金额小于累计的，那么差额都是未收款，包括本次付款为 0**」
 *   ② 「**去掉三个单选、按金额自动算**」
 *
 * 生效范围（**按代码实际**核出来的，不是按草案抄的）：
 *   · **销售** — 适用 ✓：`SalesOrderService.confirm` 是销售入账的**唯一落库口**
 *     （扫码页 `services/scanWriteService.js` 与工作台都经它），也是全仓**唯一**挂
 *     【未收款】的地方（`PaymentService.recordInitialBatch` 只负责按给定状态落行）。
 *   · **采购（补货 / 退货 / 验收）** — **不适用** ✗：那三条链路没有"收款明细 / 未收款"
 *     这条口径（金额闸门在 `config/scanWrite.js` 的 `PURCHASE_AMOUNT`，落点是到货核对的
 *     「发生金额」）—— 它们**不经过** `SalesOrderService`。
 *   · **售后（退货 / 换货 / 赔货）** — **不适用** ✗：`config/afterSales.js` 明确
 *     「未收款」**不在可改状态里**（那笔钱根本没收到，没有"退款"可言）。
 *
 * 金额口径（本用例钉的就是它，**不许另写第二个算法** ✗）：
 *   `差额（分） = 每件实收合计 − 已收合计`（整数分相减，落库时 ÷100 还原成元），
 *   与 `config/saleSettlement.js` 的纯函数 `autoModeOf()` **同一套语义**
 *   （累计不可知 ⇒ **不编**差额）。
 *
 * AC 清单：
 *   AC-OWED-1 少付（货品 300 / 已收 100）⇒ **自动**补一条【未收款 200】（她没提"欠"也补）
 *   AC-OWED-2 一分没付 ⇒ 差额 = 每件实收合计（全额）⇒ 照样补
 *   AC-OWED-3 收齐 ⇒ **一条【未收款】都不写**（反向钉住：不许借"自动"乱挂）
 *   AC-OWED-4 她**明说**欠款：与差额一致 ⇒ 照旧一条；对不上 ⇒ **仍然拦住**（判据不放宽）
 *   AC-OWED-5 明细实收金额不齐 ⇒ **不编**差额（不挂【未收款】）
 *   AC-OWED-6 同一单重试 ⇒ 那条【未收款】不重复挂（既有幂等，形状不变）
 *   AC-OWED-7 源码哨兵：旧**决策行**逐字消失（**塞回即红**）+ 新决策行在位
 *   AC-OWED-8 注释哨兵：`scanWrite.js` 未付档那句"不再自动补"的**活跃行**消失（塞回即红）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SalesOrderService } = require('../src/services/salesOrderService');
const { SalesProgressService } = require('../src/services/salesProgressService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

// 与 `salesMvp.test.js` 同源的假 Base（尺码走关联、字段名走 schema ⇒ 写错字段名当场抛）。
const fake = () => {
  const sizes = [38, 39, 40, 41, 42, 43, 44].map((size) => ({
    record_id: `size_${size}`, fields: { 尺码: size },
  }));
  const records = new Map([
    ['salesEntry', [{ record_id: 'order_1', fields: { 销售单号: 'XSD-001' } }]],
    ['sizeManagement', sizes],
  ]);
  let seq = 0;
  const gateway = {
    records, table: (key) => V1_BITABLE_SCHEMA.tables[key], validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `rec_${++seq}`;
      const fields = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)
        .map(([name, value]) => {
          const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
          if (!field) throw new Error(`${key}: unknown field ${name}`);
          return [field, value];
        }));
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = await gateway.get(key, id);
      Object.assign(record.fields, Object.fromEntries(Object.entries(values)
        .map(([name, value]) => {
          const field = V1_BITABLE_SCHEMA.tables[key].fields[name];
          if (!field) throw new Error(`${key}: unknown field ${name}`);
          return [field, value];
        })));
      return record;
    },
    delete: async (key, id) => records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id)),
  };
  return gateway;
};

const references = {
  resolveProduct: async (item) => ({ recordId: `product_${item.itemNo}` }),
  resolvePaymentMethod: async (method) => ({ recordId: `method_${method}` }),
};

/** 该单的收款行（形状：金额 / 状态 / 方式 / 收款日）—— 断言都用它，别写第二套读法。 */
const receiptsOf = (gateway) => (gateway.records.get('paymentRecord') || []).map((row) => ({
  amount: row.fields['交易金额'],
  status: row.fields['钱款状态'],
  method: row.fields['交易方式'],
  receivedAt: row.fields['收付日'],
}));

// ── AC-OWED-1 少付 ⇒ 自动【未收款】差额 ─────────────────────────────────────

test('AC-OWED-1 ⭐⭐ 少付（货品 300 / 只付 100）⇒ **自动**补一条【未收款 200】（她没提"欠"也补）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const posted = await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 300 }],
    payments: [{ method: '微信', amount: 100 }],
    // 🔴 刻意**不带** `owed`：新口径下差额自己会算出来（改前这种单一条【未收款】都不挂 ✗）。
  });

  assert.deepEqual(receiptsOf(gateway).map((row) => [row.amount, row.status]),
    [[100, '已收款'], [200, '未收款']],
    '货品 300、只付 100 ⇒ 系统自动写一条【未收款 200】');
  // 那一条【未收款】的**形状**沿用既有业务层：方式留空、不写收款日、不写交易方向。
  assert.equal(receiptsOf(gateway)[1].method, undefined, '【未收款】不填收款方式');
  assert.equal(receiptsOf(gateway)[1].receivedAt, undefined, '【未收款】不填收款日（钱还没到）');
  assert.equal(gateway.records.get('paymentRecord')[1].fields['交易方向'], undefined,
    '【未收款】不写交易方向（只有真收到钱的那条才有）');

  // 读侧跟着对：还欠 200、状态 = 部分收款。
  const progress = await new SalesProgressService({ gateway }).forOrder('order_1',
    { detailRecordIds: posted.detailRecordIds, paymentRecordIds: posted.paymentRecordIds });
  assert.equal(progress.pendingAmount, 200, '还欠 200');
  assert.equal(progress.paymentStatus, '部分收款');
});

// ── AC-OWED-2 一分没付 ⇒ 差额 = 全额 ────────────────────────────────────────

test('AC-OWED-2 ⭐ 一分钱都没收到 ⇒ 差额 = 每件实收合计（全额）⇒ 照样补一条【未收款】', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 300 }],
    payments: [],
  });

  assert.deepEqual(receiptsOf(gateway).map((row) => [row.amount, row.status]), [[300, '未收款']],
    '0 收款 ⇒ 差额 = 累计 = 300（她 2026-10-14 逐字：「包括本次付款为 0」）');
});

// ── AC-OWED-3 收齐 ⇒ 一条都不写（反向钉住）──────────────────────────────────

test('AC-OWED-3 🔴 收齐（300 收 300）⇒ **一条【未收款】都不写**（不许借"自动"乱挂）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 300 }],
    payments: [{ method: '微信', amount: 300 }],
  });

  assert.deepEqual(receiptsOf(gateway).map((row) => [row.amount, row.status]), [[300, '已收款']],
    '差额 0 ⇒ 没有【未收款】这回事（反向：把"自动"做成"一律挂"这条会红）');
});

// ── AC-OWED-4 她明说欠款：一致 ⇒ 照旧；对不上 ⇒ 仍然拦住 ────────────────────

test('AC-OWED-4 她明说"还欠 19"且与差额一致 ⇒ 照旧一条 19（旧行为一个字没改）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 119 }],
    payments: [{ method: '微信', amount: 100 }], owed: 19,
  });

  assert.deepEqual(receiptsOf(gateway).map((row) => [row.amount, row.status]),
    [[100, '已收款'], [19, '未收款']]);
});

test('AC-OWED-4b 🔴 她说的欠款与差额**对不上** ⇒ 仍然拦住、一个字都不写（判据不许放宽）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await assert.rejects(sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 100 }],
    payments: [{ method: '微信', amount: 100 }], owed: 19,
  }), /欠款与「实收金额−已收金额」不一致/);
  assert.equal(gateway.records.get('paymentRecord'), undefined, '拦住了就不该写任何收款记录');
});

// ── AC-OWED-5 明细实收不齐 ⇒ 不编差额 ───────────────────────────────────────

test('AC-OWED-5 🔴 有明细没填「实收金额」⇒ 差额算不出来 ⇒ **不编**（不挂【未收款】）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  await sales.confirm({
    salesEntryRecordId: 'order_1',
    items: [
      { itemNo: 'A100', size: 38, quantity: 1, actualAmount: 300 },
      { itemNo: 'B200', size: 39, quantity: 1 }, // 实收金额留空 ⇒ 累计不可知
    ],
    payments: [{ method: '微信', amount: 100 }],
  });

  assert.deepEqual(receiptsOf(gateway).map((row) => [row.amount, row.status]), [[100, '已收款']],
    '累计不可知 ⇒ **不编**差额（与 autoModeOf() 的 no_known_total 同一口径）');
});

// ── AC-OWED-6 重试幂等 ─────────────────────────────────────────────────────

test('AC-OWED-6 同一单重试两次 ⇒ 那条【未收款】不重复挂（既有幂等，形状不变）', async () => {
  const gateway = fake();
  const sales = new SalesOrderService({ gateway, references });
  const input = {
    salesEntryRecordId: 'order_1',
    items: [{ itemNo: 'A100', size: 38, quantity: 1, actualAmount: 300 }],
    payments: [{ method: '微信', amount: 100 }],
  };
  const first = await sales.confirm(input);
  const retry = await sales.confirm(input);

  assert.deepEqual(retry.paymentRecordIds, first.paymentRecordIds, '重试拿到同一批收款 id');
  assert.equal(gateway.records.get('paymentRecord').length, 2, '不重复挂那条【未收款】');
  assert.equal(gateway.records.get('salesDetail').length, 1, '明细也不重复');
});

// ── AC-OWED-7/8 源码哨兵（改前逐字消失 ⇒ 塞回即红）─────────────────────────

test('AC-OWED-7 源码哨兵：旧决策行逐字消失、新决策行在位（塞回即红）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/salesOrderService.js'), 'utf8');
  // 改前逐字（**已作废**）：`owed` 为空 ⇒ 一条都不挂。
  assert.ok(!source.includes("const owedCents = input.owed ? cents(input.owed, '欠款金额') : 0;"),
    '旧决策行必须消失（塞回 ⇒ 少付的单又不挂【未收款】了 ⇒ 红）');
  // 旧注释的**活跃行**（不是"改前逐字"引文那一行）必须消失。
  assert.ok(!/^      \/\/ 未收款只在\*\*她明说欠\*\*时才补（业务负责人口径：/m.test(source),
    '旧口径的活跃注释行必须消失（塞回即红）');
  // 新决策行在位：差额 = 已收为空的兜底。
  assert.ok(source.includes('const owedCents = statedOwedCents > 0'), '新决策行必须在位');
  assert.ok(source.includes('(amountsKnown ? outstandingCents : 0)'), '不编差额那一支必须在位');
  // 借的是**既有**差额算法（不新写一个）。
  assert.ok(source.includes('const outstandingCents = totalCents - paidCents;'),
    '差额必须仍来自既有的 `totalCents - paidCents`（不许另写第二个算法）');
});

test('AC-OWED-8 注释哨兵：`scanWrite.js` 未付档"不再自动补"的活跃行消失（塞回即红）', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/config/scanWrite.js'), 'utf8');
  // 改前逐字的那一行**原来**是活跃注释（`  // ⚠️ **不再**自动补…`）⇒ 现在只能作为引文出现。
  assert.ok(!/^  \/\/ ⚠️ \*\*不再\*\*自动补那条【未收款】/m.test(source),
    '那句与实现相反的活跃注释必须消失（塞回即红：它会把下一个人带回老口径 ✗）');
  assert.ok(source.includes('**但差额照写**'), '未付档的新注释必须在位（与实现一致）');
  assert.ok(source.includes('**客户少付 ⇒ 自动记一条【未收款】（差额）**'), '裁定逐字必须在注释里');
});
