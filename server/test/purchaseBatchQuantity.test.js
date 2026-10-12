/**
 * ⭐⭐ 2026-10-12 业务负责人测出来的缺口（逐字）：
 *   「她在扫码页「补货」报了 5 双……采购申请建好了 ✓ 图也发群 + 写回附件 ✓
 *     但「报货批次」那一行的【录入数量】是【空】✗」
 *   「这**录入数量**里面应该是 5 啊，但是对于我们的这个数据表里面，它是记录为空呀」
 *
 * 她的口径（2026-10-08 就说过）：「**录入数量**：我们报单时候的数量；
 *   **实际数量**：我们到货的数量；**实际金额**：这一次供应商的金额」
 * ⇒ 所以这一列**应该由报货自动填**（不是"她在表上维护的"）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**）
 *
 *  AC-PQ1 `报货路 ⇒ 报货批次那一行的「录入数量」== 这一批的数量合计`（逐字：5 双 ⇒ 5）
 *  AC-PQ2 `扫码页补货路 ⇒ 同上`（两条入口都汇到**同一个建行点**，见下）
 *  AC-PQ3 `重复处理同一批 ⇒ 值不变`（幂等：不累加、不翻倍）
 *  AC-PQ4 `数量缺失 / 0 ⇒ 那一列不写`（不写空值、也不写 0 ✗）
 *  AC-PQ5 `9 点推送读它 ⇒ 能读到这次的数字`（回归）
 *  AC-PQ6 `既有「实际数量 / 实际金额」两条路不回归`（到货核对那条写入点一行没动）
 *  AC-PQ7 哨兵：值类型**按配置**（默认数字；`text` 档才写字符串），口径写在一处、不散落
 *
 * ⚠️ **真表列类型**：本机**读不到**（没有生产凭证 / 也没有 `.env`，AGENTS 第 8 条）
 *   ⇒ 默认按仓库既有先例写 **Number**；真机若 `*ConvFail` ⇒ **停下来报告**
 *   （不许自己改成写字符串 —— 会与数字列冲突）。详见 `config/purchaseBatchQuantity.js`。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolvePurchaseBatchQuantityConfig,
  toBatchQuantityValue,
  totalQuantityOf,
  batchQuantityFields,
} = require('../src/config/purchaseBatchQuantity');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const QUANTITY_FIELD = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.quantity;
const BATCH_NO = 'CGD-20261012-0001';

/** 假网关：记下每一次 create 的 fields（真 service 走的是同一条 `createOnceByKey`）。 */
const fakeGateway = () => {
  const created = [];
  const rows = [];
  return {
    created,
    rows,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async () => rows,
    listByFilter: async (key, field, value) => rows.filter((row) => String(row.fields?.[field]) === String(value)),
    create: async (key, values) => {
      // ⚠️ 记的是**翻成中文列名之后**的那一份（与真网关实际发出去的一致）——
      //    断言要看的正是"表上那一列收到了什么"。

      // ⚠️⚠️ 夹具要**像真网关那样把"语义键"翻成表上的中文列名**（`v1BitableSchema` 的映射）——
      //    真网关就是这么干的，而 `listByKey` 回查时读的也是中文列名。
      //    （第一版夹具直接存语义键 ⇒ 回查永远查不到 ⇒ 幂等用例假红。）
      const map = V1_BITABLE_SCHEMA.tables[key].fields;
      const fields = {};
      for (const [name, value] of Object.entries(values)) {
        if (value === undefined) continue;
        fields[map[name] || name] = value;
      }
      // ⚠️ 真网关回的是 **camelCase 的 `recordId`**（`createOnceByKey` 读的就是它）。
      created.push(fields);
      const row = { record_id: `rec_${rows.length + 1}`, recordId: `rec_${rows.length + 1}`, fields };
      rows.push(row);
      return row;
    },
    update: async (key, recordId, fields) => {
      const row = rows.find((item) => item.record_id === recordId);
      if (row) Object.assign(row.fields, fields);
      return row;
    },
  };
};

const serviceFor = (gateway) => new PurchaseOrderBatchService({ gateway, config: {} });

test('AC-PQ1 报货路：报货批次那一行的「录入数量」== 这一批的数量合计（逐字：5 双 ⇒ 5）', async () => {
  const gateway = fakeGateway();
  const service = serviceFor(gateway);
  // 她这次的形状：一个编号、5 行明细（我们按同一批的合计口径）
  const result = await service.createForReturnBatch(BATCH_NO, {
    quantity: 5, behaviorRecordId: 'rec_behavior',
  });
  assert.ok(result.recordId, '这一行必须建成');
  const fields = gateway.created[0];
  assert.equal(fields[QUANTITY_FIELD], 5, `「${QUANTITY_FIELD}」要写 5`);
  assert.equal(typeof fields[QUANTITY_FIELD], 'number', '默认写**数字**（真表类型未核实，按仓库先例）');
  assert.equal(fields[V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.idempotencyKey], `purchase_batch:${BATCH_NO}`,
    '幂等键照旧');
  assert.equal(fields[V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.batchNo], BATCH_NO, '批次号照旧');
});

test('AC-PQ1b 报货路的字段是按「明细数量合计」算出来的（plan.items ⇒ 合计）', () => {
  const items = [{ quantity: 2 }, { quantity: '2' }, { quantity: 1 }, { quantity: 0 }, { quantity: null }];
  assert.equal(totalQuantityOf(items), 5, '2 + 2 + 1 + 0 + 认不出的 = 5（0 / 空不计）');
  assert.deepEqual(batchQuantityFields(items), { quantity: 5 });
});

test('AC-PQ2 扫码页补货路 ⇒ 同一个建行点（源码级：两条入口汇到一处，值同源）', () => {
  const webhook = fs.readFileSync(path.join(__dirname, '../src/services/purchaseWebhookService.js'), 'utf8');
  const ret = fs.readFileSync(path.join(__dirname, '../src/services/purchaseReturnService.js'), 'utf8');
  // ① 报货主表建行处必须展开这一份字段（扫码补货与供应商报单都走 `confirmPurchaseRequest`）
  assert.ok(webhook.includes('...batchQuantityFields(plan.items)'),
    '报货建行点要写「录入数量」（两条报货入口共用这一处）');
  assert.ok(webhook.includes("require('../config/purchaseBatchQuantity')"), '取值口径来自配置模块');
  // ② 退货路（同一列，另一个建行点）也要写，且值用已算好的 takenCount
  assert.ok(ret.includes('quantity: takenCount'), '退货路把这一批的合计传下去');
  const orderBatches = fs.readFileSync(path.join(__dirname, '../src/services/purchaseOrderBatchService.js'), 'utf8');
  assert.ok(orderBatches.includes('...batchQuantityFields([{ quantity }])'), '退货建行点展开同一份字段');
});

test('AC-PQ3 重复处理同一批 ⇒ 值不变（幂等，不累加、不翻倍）', async () => {
  const gateway = fakeGateway();
  const service = serviceFor(gateway);
  const first = await service.createForReturnBatch(BATCH_NO, { quantity: 5 });
  const second = await service.createForReturnBatch(BATCH_NO, { quantity: 5 });
  assert.equal(first.recordId, second.recordId, '同一批只有一个记录');
  assert.equal(second.reused, true, '第二次是"命中已有行"');
  assert.equal(gateway.created.length, 1, '只 create 了一次（重放不会重发 values）');
  assert.equal(gateway.created[0][QUANTITY_FIELD], 5, '值还是 5，没有变成 10');
});

test('AC-PQ4 数量缺失 / 0 ⇒ 那一列不写（不写空值、也不写 0）', async () => {
  for (const bad of [0, undefined, null, '', 'abc', -3, NaN]) {
    assert.equal(toBatchQuantityValue(bad), undefined, `${String(bad)} ⇒ 不写`);
    assert.deepEqual(batchQuantityFields([{ quantity: bad }]), {}, `${String(bad)} ⇒ 空对象（不写这一列）`);
  }
  const gateway = fakeGateway();
  const service = serviceFor(gateway);
  await service.createForReturnBatch(`${BATCH_NO}-ZERO`, { quantity: 0 });
  const fields = gateway.created[0];
  assert.equal(Object.prototype.hasOwnProperty.call(fields, QUANTITY_FIELD), false,
    '这一列**一个字段都不该出现**（不是写空串、也不是写 0）');
  assert.equal(fields[V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.batchNo], `${BATCH_NO}-ZERO`,
    '其它字段照旧（夹具记的是中文列名之后的那一份）');
});

test('AC-PQ5 9 点推送读它 ⇒ 能读到这次的数字（回归：读取口径没变）', () => {
  const reader = fs.readFileSync(path.join(__dirname, '../src/services/purchasePendingBatchService.js'), 'utf8');
  assert.ok(reader.includes('table?.fields?.quantity'), '9 点推送仍从同一个语义键读「录入数量」');
  assert.ok(reader.includes('textValue('), '读取侧对数字 / 文本都能读（textValue）');
  // 映射本身没改名（闸门按名字核）
  assert.equal(QUANTITY_FIELD, '录入数量');
});

test('AC-PQ6 既有「实际数量 / 实际金额」两条路不回归（到货核对那条写入点一行没动）', () => {
  const orderBatches = fs.readFileSync(path.join(__dirname, '../src/services/purchaseOrderBatchService.js'), 'utf8');
  for (const key of ['writeAcceptance', 'actualQuantity', 'actualAmount']) {
    assert.ok(orderBatches.includes(key), `到货那条链路仍在：${key}`);
  }
  // 「录入数量」的写入点**只有**退货建行那一处（不许散到到货链路里）
  const hits = (orderBatches.match(/batchQuantityFields\(\[\{ quantity \}\]\)/g) || []).length;
  assert.equal(hits, 1, `退货建行只有一个展开点（实际 ${hits}）`);
  assert.equal(orderBatches.includes('writeAcceptance') && /writeAcceptance[\s\S]{0,400}batchQuantityFields/.test(orderBatches),
    false, '到货核对那条写入点不许碰「录入数量」');
});

test('AC-PQ7 哨兵：值类型按配置（默认数字；`text` 档才写字符串），口径只在一处', () => {
  assert.equal(resolvePurchaseBatchQuantityConfig({}).valueType, 'number', '默认数字');
  assert.equal(resolvePurchaseBatchQuantityConfig({ PURCHASE_BATCH_QUANTITY_TYPE: '' }).valueType, 'number',
    '空串 ⇒ 默认（不因为清空变量就变成别的）');
  assert.equal(resolvePurchaseBatchQuantityConfig({ PURCHASE_BATCH_QUANTITY_TYPE: 'text' }).valueType, 'text');
  assert.equal(toBatchQuantityValue(5, { valueType: 'text' }), '5');
  assert.equal(toBatchQuantityValue(5, { valueType: 'number' }), 5);
  // ⚠️ 类型还没在真表上核过 —— 这个事实要能被代码读出来（报告里也要说清）
  assert.equal(resolvePurchaseBatchQuantityConfig({}).typeVerified, false);
});
