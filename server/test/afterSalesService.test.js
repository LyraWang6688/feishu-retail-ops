// 退换货第二期·第一步：售后执行器 + 幂等 的测试。
//
// 覆盖：三种动作各一条 · 重复调用只写一次（本步最重要的用例）· 原主表/原明细逐字段未变 ·
//       差价正/负/0 · 资金 cash/prepaid · 退回状态 门盒/样品 · 库存流水 1 行 / 2 行方向相反 ·
//       失败后重试成功 · 入参校验 · 总闸门（指纹不同就停 · 缺列大声失败）。
//
// 说明：库存那一侧注入的是「与 InventoryService.applyChange 同签名的端口」。
// 原因是这一期不许改 inventoryService.js，而它的 STOCK_MOVEMENTS 是模块内 Object.freeze
// 且未导出，SALE_RETURN / SALE_COMPENSATION / SALE_CASH 还没在里面声明，
// 直接传真服务会抛「未在库存动作注册表中声明动作」（接线那一步由父代理补声明 + 补 fixture）。
// 端口按真实服务的同一套幂等思路实现：以 kind + sourceRecordId 作为操作身份
// （真实服务用 operationId(kind, sourceRecordId) + 远端「库存操作键」），重复调用不再写第二遍。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AfterSalesService } = require('../src/services/afterSalesService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const FIXED_NOW = Date.parse('2026-10-05T10:00:00+08:00');
const ORDER_NO = 'XSD-20261005-001';
const CREDIT_TABLE = 'customerCredit';

const behaviorRow = (recordId, code, name, direction) => ({
  record_id: recordId,
  fields: { 行为编码: code, 行为名称: name, 库存方向: direction, 是否启用: true },
});

const seed = () => ({
  sizeManagement: [
    { record_id: 'size_41', fields: { 尺码: 41 } },
    { record_id: 'size_42', fields: { 尺码: 42 } },
  ],
  behavior: [
    behaviorRow('behavior_return', 'SALE_RETURN', '销售退货', '增加'),
    behaviorRow('behavior_exchange', 'SALE_EXCHANGE', '销售换货', '不影响'),
    behaviorRow('behavior_compensation', 'SALE_COMPENSATION', '销售赔货', '减少'),
    behaviorRow('behavior_cash', 'SALE_CASH', '现货销售', '减少'),
  ],
  paymentMethod: [{ record_id: 'method_wechat', fields: { 收款方式: '微信' } }],
  product: [
    { record_id: 'product_A', fields: { 货号: 'A100', 颜色: '黑' } },
    { record_id: 'product_B', fields: { 货号: 'B200', 颜色: '棕' } },
  ],
  salesEntry: [{
    record_id: 'order_old',
    fields: { 销售单号: ORDER_NO, 原话: '卖一双 A100 41 码', 订单状态: '已完成', 确认状态: '已入账' },
  }],
  salesDetail: [
    {
      record_id: 'detail_old_1',
      fields: { 销售单号: ['order_old'], 编号: ['product_A'], 尺码: ['size_41'], 成交金额: 250, 履约状态: '已交付' },
    },
    {
      record_id: 'detail_old_2',
      fields: { 销售单号: ['order_old'], 配品: ['accessory_belt'], 成交金额: 30, 履约状态: '已交付' },
    },
  ],
  paymentRecord: [{
    record_id: 'pay_old_1',
    fields: { 关联销售单: ['order_old'], 交易方式: ['method_wechat'], 收款金额: 280, 收款状态: '已收款' },
  }],
  liveInventory: [
    { record_id: 'live_A_41', fields: { 编号: ['product_A'], 尺码: ['size_41'], 所属状态: '门盒' } },
    { record_id: 'live_B_42', fields: { 编号: ['product_B'], 尺码: ['size_42'], 所属状态: '门盒' } },
  ],
});

/**
 * 假 Base。字段按语义名（schema）→ 中文列名映射后落库，和真网关一致。
 * options.missingCreditKey：listFields 里不含「业务事件ID」，用来验证"缺列大声失败"。
 */
const fakeBase = (options = {}) => {
  const records = new Map(Object.entries(seed()).map(([key, rows]) => [
    key, rows.map((row) => ({ record_id: row.record_id, fields: { ...row.fields } })),
  ]));
  const writes = { create: {}, update: {}, delete: {} };
  let sequence = 0;
  const gateway = {
    schema: V1_BITABLE_SCHEMA,
    records,
    writes,
    table(key) {
      const table = this.schema.tables[key];
      if (!table) throw new Error(`Unknown table: ${key}`);
      return table;
    },
    fieldName(key, semantic) {
      const name = this.table(key).fields?.[semantic];
      if (!name) throw new Error(`${key}: unknown field ${semantic}`);
      return name;
    },
    validateTables: async () => [],
    async listFields(key) {
      return Object.entries(this.table(key).fields)
        .filter(([semantic]) => !(options.missingCreditKey && key === CREDIT_TABLE && semantic === 'businessEventId'))
        .map(([, fieldName]) => ({ field_name: fieldName, type: 1 }));
    },
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id) || null,
    async findOneByText(key, semantic, expected) {
      const name = this.fieldName(key, semantic);
      const target = String(expected ?? '').trim();
      return (records.get(key) || []).find((row) => String(row.fields[name] ?? '').trim() === target) || null;
    },
    async create(key, values) {
      writes.create[key] = (writes.create[key] || 0) + 1;
      const fields = {};
      for (const [semantic, value] of Object.entries(values)) {
        if (value !== undefined) fields[this.fieldName(key, semantic)] = value;
      }
      const record = { record_id: `rec_${++sequence}`, fields };
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record);
      return { recordId: record.record_id };
    },
    async update(key, id, values) {
      writes.update[key] = (writes.update[key] || 0) + 1;
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      if (!record) throw new Error(`${key} ${id} not found`);
      for (const [semantic, value] of Object.entries(values)) record.fields[this.fieldName(key, semantic)] = value;
      return record;
    },
    async delete(key, id) {
      writes.delete[key] = (writes.delete[key] || 0) + 1;
      records.set(key, (records.get(key) || []).filter((row) => row.record_id !== id));
      return true;
    },
  };
  return gateway;
};

/** 与 InventoryService.applyChange 同签名的库存端口（见文件头说明）。 */
const fakeInventory = (gateway) => {
  const directions = new Map(
    gateway.records.get('behavior').map((row) => [row.fields['行为编码'], row.fields['库存方向']]),
  );
  const done = new Map();
  return {
    calls: [],
    async applyChange(input) {
      this.calls.push({ ...input });
      const operationId = `${input.kind}|${input.sourceRecordId}`;
      if (done.has(operationId)) return done.get(operationId);
      const direction = directions.get(input.kind);
      if (!direction) throw new Error(`未在库存动作注册表中声明动作「${input.kind}」`);
      const behavior = gateway.records.get('behavior').find((row) => row.fields['行为编码'] === input.kind);
      const sizeRecordId = `size_${input.size}`;
      const ledger = await gateway.create('inventoryLedger', {
        product: [input.productRecordId],
        size: [sizeRecordId],
        quantityChange: input.quantity,
        behavior: [behavior.record_id],
        salesDetail: [input.sourceRecordId],
      });
      const liveRecordIds = [];
      if (direction === '增加') {
        for (let index = 0; index < input.quantity; index += 1) {
          const created = await gateway.create('liveInventory', {
            product: [input.productRecordId],
            size: [sizeRecordId],
            state: input.state,
            operationItemKey: `${operationId}:${index + 1}`,
          });
          liveRecordIds.push(created.recordId);
        }
      } else if (direction === '减少') {
        // 规格要求"新鞋从门盒减一行"：真实服务按注册表 consumes 决定扣哪些状态，
        // 三条售后声明都是 ['门盒']，所以这里也只从门盒扣。
        const pool = (gateway.records.get('liveInventory') || []).filter((row) =>
          (row.fields['编号'] || []).includes(input.productRecordId) &&
          (row.fields['尺码'] || []).includes(sizeRecordId) &&
          row.fields['所属状态'] === '门盒');
        if (pool.length < input.quantity) throw new Error('门盒库存不足');
        for (const row of pool.slice(0, input.quantity)) {
          await gateway.delete('liveInventory', row.record_id);
          liveRecordIds.push(row.record_id);
        }
      } else {
        throw new Error(`库存方向「${direction}」不会改变实时库存`);
      }
      const result = { direction, ledgerRecordId: ledger.recordId, liveRecordIds, quantity: input.quantity };
      done.set(operationId, result);
      return result;
    },
  };
};

const build = (options = {}) => {
  const gateway = fakeBase(options);
  const inventory = fakeInventory(gateway);
  const store = options.store || new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-')),
    idField: 'operation_id',
  });
  const service = new AfterSalesService({ gateway, inventory, store, now: () => FIXED_NOW });
  return { gateway, inventory, store, service };
};

const countsOf = (gateway) => JSON.stringify(gateway.writes);
const snapshot = (gateway) => Object.fromEntries(
  [...gateway.records.entries()].map(([key, rows]) => [
    key, rows.map((row) => `${row.record_id}:${JSON.stringify(row.fields)}`),
  ]),
);
const rowsOf = (gateway, key) => gateway.records.get(key) || [];
const masterRows = (gateway) => rowsOf(gateway, 'salesEntry').filter((row) => row.record_id !== 'order_old');
const detailRows = (gateway) => rowsOf(gateway, 'salesDetail').filter((row) => !row.record_id.startsWith('detail_old'));
const paymentRows = (gateway) => rowsOf(gateway, 'paymentRecord').filter((row) => row.record_id !== 'pay_old_1');
const liveRows = (gateway) => rowsOf(gateway, 'liveInventory')
  .filter((row) => !['live_A_41', 'live_B_42'].includes(row.record_id));

const request = (overrides = {}) => ({
  action: 'return',
  originalText: '把那双 A100 退了，鞋没穿过',
  originalSalesEntryRecordId: 'order_old',
  originalSalesOrderNo: ORDER_NO,
  originalSalesDetailRecordIds: ['detail_old_1'],
  newLines: [],
  diffAmount: -250,
  settlement: 'cash',
  restockState: '门盒',
  ...overrides,
});

test('退货（cash 退款）：六处写入各一次，原主表一字未动，原明细只改履约状态', async () => {
  const { gateway, inventory, service } = build();
  const beforeEntry = structuredClone(rowsOf(gateway, 'salesEntry')[0].fields);
  const beforeDetail = structuredClone(rowsOf(gateway, 'salesDetail')[0].fields);

  const result = await service.execute(request());

  // 1) 新「销售主表」：原话 + 原单号 + 与销售链路同口径的状态 + 交易类型=行为
  const masters = masterRows(gateway);
  assert.equal(masters.length, 1);
  assert.equal(masters[0].fields['原话'], '把那双 A100 退了，鞋没穿过');
  assert.equal(masters[0].fields['销售单号'], ORDER_NO);
  assert.equal(masters[0].fields['解析状态'], '解析成功');
  assert.equal(masters[0].fields['确认状态'], '已入账');
  assert.deepEqual(masters[0].fields['交易类型'], ['behavior_return']);

  // 2) 新「销售明细」：交易类型=行为 · 销售单号=原主表 · 成交金额=正数
  const details = detailRows(gateway);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['销售单号'], ['order_old']);
  assert.deepEqual(details[0].fields['编号'], ['product_A']);
  assert.deepEqual(details[0].fields['尺码'], ['size_41']);
  assert.equal(details[0].fields['成交金额'], 250);
  assert.deepEqual(details[0].fields['交易类型'], ['behavior_return']);

  // 3) 原明细只改「履约状态」；原主表（含订单状态）逐字段未变
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');
  assert.deepEqual({ ...rowsOf(gateway, 'salesDetail')[0].fields, 履约状态: '已交付' }, beforeDetail);
  assert.deepEqual(rowsOf(gateway, 'salesEntry')[0].fields, beforeEntry);
  assert.deepEqual(result.originalDetailIdsMarked, ['detail_old_1']);

  // 4) 钱：退回 250，金额正数，方向=退回，关联新主表，交易方式=原单
  const payments = paymentRows(gateway);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].fields['交易方向'], '退回');
  assert.equal(payments[0].fields['收款金额'], 250);
  assert.equal(payments[0].fields['收款状态'], '已收款');
  assert.deepEqual(payments[0].fields['关联销售单'], [masters[0].record_id]);
  assert.deepEqual(payments[0].fields['交易方式'], ['method_wechat']);

  // 5) 库存流水：1 行，行为=销售退货，数量正数，关联销售指向售后明细行
  const ledgers = rowsOf(gateway, 'inventoryLedger');
  assert.equal(ledgers.length, 1);
  assert.deepEqual(ledgers[0].fields['库存行为'], ['behavior_return']);
  assert.equal(ledgers[0].fields['变动数量'], 1);
  assert.deepEqual(ledgers[0].fields['关联销售'], [details[0].record_id]);

  // 6) 实时库存：退回的鞋加一行（门盒）
  const live = liveRows(gateway);
  assert.equal(live.length, 1);
  assert.equal(live[0].fields['所属状态'], '门盒');
  assert.deepEqual(live[0].fields['编号'], ['product_A']);
  assert.deepEqual(live[0].fields['尺码'], ['size_41']);
  // 库存那一侧是"注入既有库存服务"的调用：行为编码 + 目标状态 + 数量 + 来源明细
  assert.deepEqual(inventory.calls, [{
    kind: 'SALE_RETURN',
    productRecordId: 'product_A',
    size: 41,
    state: '门盒',
    quantity: 1,
    sourceRecordId: details[0].record_id,
    occurredAt: FIXED_NOW,
  }]);

  // 每张表恰好写一次
  assert.deepEqual(gateway.writes.create, {
    salesEntry: 1, salesDetail: 1, paymentRecord: 1, inventoryLedger: 1, liveInventory: 1,
  });
  assert.deepEqual(gateway.writes.update, { salesDetail: 1 });
  assert.deepEqual(gateway.writes.delete, {});
  // 本地闸门：记下"这一次做过"，并记住每个阶段的 record_id
  const progress = await service.store.get(result.operationId);
  assert.equal(progress.status, 'completed');
  assert.equal(progress.master_record_id, masters[0].record_id);
  assert.deepEqual(progress.detail_record_ids, [details[0].record_id]);
  assert.deepEqual(progress.original_details_marked, ['detail_old_1']);
  assert.equal(progress.payment_record_id, payments[0].record_id);
});

test('重复执行两次：六处写入都只发生一次（第二次被总闸门整次跳过）', async () => {
  const { gateway, inventory, service } = build();
  const first = await service.execute(request());
  const writesAfterFirst = countsOf(gateway);
  const recordsAfterFirst = snapshot(gateway);
  const callsAfterFirst = inventory.calls.length;

  const second = await service.execute(request());

  assert.equal(countsOf(gateway), writesAfterFirst, '第二次执行不应再产生任何 create/update/delete');
  assert.deepEqual(snapshot(gateway), recordsAfterFirst, '第二次执行后所有表的内容都不应变');
  assert.equal(inventory.calls.length, callsAfterFirst, '整次跳过时连库存服务都不调用');
  assert.deepEqual(second, first, '第二次直接返回上次的结果');
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 1);
  assert.equal(rowsOf(gateway, 'liveInventory').length, 3); // 原有 2 双 + 退回 1 双
});

test('总闸门按请求指纹认人：同一次分片里塞另一笔售后 → 大声失败，不写任何东西', async () => {
  const { gateway, service } = build();
  await service.execute(request());
  const writesAfterFirst = countsOf(gateway);
  const recordsAfterFirst = snapshot(gateway);

  await assert.rejects(
    () => service.execute(request({ diffAmount: -200 })),
    /请求内容与上次不同/,
  );
  assert.equal(countsOf(gateway), writesAfterFirst);
  assert.deepEqual(snapshot(gateway), recordsAfterFirst);
});

test('给了 taskId 时，同一原单同一动作可以做第二次（每次用户消息一个分片）', async () => {
  const { gateway, service } = build();
  await service.execute(request({ taskId: 'om_task_a', originalText: '退第一双', diffAmount: -250 }));
  await service.execute(request({ taskId: 'om_task_b', originalText: '再退第二双', diffAmount: -200 }));
  assert.equal(masterRows(gateway).length, 2);
  assert.equal(detailRows(gateway).length, 2);
  assert.equal(paymentRows(gateway).length, 2);
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 2);
});

test('换货：旧鞋回库 + 新鞋出门盒，两条流水方向相反且数量都是正数', async () => {
  const { gateway, service } = build();
  const result = await service.execute(request({
    action: 'exchange',
    originalText: '那双 A100 换一双 B200 42 码，补 50',
    newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
    diffAmount: 50,
    settlement: 'cash',
    restockState: '样品',
  }));

  // 新明细行只有出货商品（被换回的旧鞋不另建行，靠原明细行 + 库存流水表达）
  const details = detailRows(gateway);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['编号'], ['product_B']);
  assert.deepEqual(details[0].fields['尺码'], ['size_42']);
  assert.equal(details[0].fields['成交金额'], 300);
  assert.deepEqual(details[0].fields['交易类型'], ['behavior_exchange']);
  assert.deepEqual(details[0].fields['销售单号'], ['order_old']);

  // 原明细：已换货
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已换货');

  // 库存流水：2 行，方向相反（增加/减少由行为决定），数量都是正数
  const ledgers = rowsOf(gateway, 'inventoryLedger');
  assert.equal(ledgers.length, 2);
  const byBehavior = Object.fromEntries(ledgers.map((row) => [row.fields['库存行为'][0], row.fields]));
  assert.deepEqual(byBehavior.behavior_return['编号'], ['product_A']);
  assert.equal(byBehavior.behavior_return['变动数量'], 1);
  assert.deepEqual(byBehavior.behavior_return['关联销售'], ['detail_old_1']);
  assert.deepEqual(byBehavior.behavior_cash['编号'], ['product_B']);
  assert.equal(byBehavior.behavior_cash['变动数量'], 1);
  assert.deepEqual(byBehavior.behavior_cash['关联销售'], [details[0].record_id]);

  // 实时库存：旧鞋加一行（样品）+ 新鞋从门盒减一行
  assert.equal(rowsOf(gateway, 'liveInventory').length, 2); // 2 + 1 - 1
  const added = liveRows(gateway);
  assert.equal(added.length, 1);
  assert.equal(added[0].fields['所属状态'], '样品');
  assert.deepEqual(added[0].fields['编号'], ['product_A']);
  assert.equal(rowsOf(gateway, 'liveInventory').some((row) => row.record_id === 'live_B_42'), false);

  // 钱：要收 50（收入）
  const payments = paymentRows(gateway);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].fields['交易方向'], '收入');
  assert.equal(payments[0].fields['收款金额'], 50);
  assert.deepEqual(payments[0].fields['关联销售单'], [result.masterRecordId]);
});

test('赔货：只出货（销售赔货·减少），坏鞋不回库，不动钱', async () => {
  const { gateway, service } = build();
  await service.execute(request({
    action: 'compensation',
    originalText: '那双 A100 开胶了，赔一双 B200 42 码',
    newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
    diffAmount: null,
    settlement: null,
    restockState: null,
  }));

  const details = detailRows(gateway);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['编号'], ['product_B']);
  assert.deepEqual(details[0].fields['交易类型'], ['behavior_compensation']);
  assert.equal(details[0].fields['成交金额'], 300);
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已赔货');

  const ledgers = rowsOf(gateway, 'inventoryLedger');
  assert.equal(ledgers.length, 1);
  assert.deepEqual(ledgers[0].fields['库存行为'], ['behavior_compensation']);
  assert.equal(ledgers[0].fields['变动数量'], 1);
  assert.deepEqual(ledgers[0].fields['关联销售'], [details[0].record_id]);

  // 实时库存：新鞋从门盒减一行（坏鞋不回库）
  assert.equal(rowsOf(gateway, 'liveInventory').length, 1);
  assert.equal(rowsOf(gateway, 'liveInventory').some((row) => row.record_id === 'live_B_42'), false);
  assert.equal(liveRows(gateway).length, 0);

  // 不动钱
  assert.equal(paymentRows(gateway).length, 0);
  assert.equal(rowsOf(gateway, CREDIT_TABLE).length, 0);
});

test('差价 0 / null：不动钱（不写收款明细，也不写客户往来货款）', async () => {
  for (const diffAmount of [0, null]) {
    const { gateway, service } = build();
    const result = await service.execute(request({ diffAmount, settlement: 'cash' }));
    assert.equal(result.money.route, 'none');
    assert.equal(paymentRows(gateway).length, 0);
    assert.equal(rowsOf(gateway, CREDIT_TABLE).length, 0);
    assert.equal(gateway.writes.create.paymentRecord, undefined);
    // 钱不动，但货照退（库存与明细照写）
    assert.equal(rowsOf(gateway, 'inventoryLedger').length, 1);
  }
});

test('资金 prepaid：走「客户往来货款」，用「业务事件ID」做远端幂等键，客户留空', async () => {
  const refund = build();
  const refundResult = await refund.service.execute(request({ settlement: 'prepaid', diffAmount: -250 }));
  const rows = rowsOf(refund.gateway, CREDIT_TABLE);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields['变动类型'], '退货退款');
  assert.equal(rows[0].fields['应收变化'], -250); // 负=我们欠客户（转成预存）
  assert.equal(rows[0].fields['来源单号'], ORDER_NO);
  assert.equal(rows[0].fields['业务事件ID'], 'after_sales:order_old:return');
  assert.equal(rows[0].fields['发生时间'], FIXED_NOW);
  // 销售主表里没有"客人是谁"这个信息 → 不编值、不从原单取不存在的字段
  assert.equal(rows[0].fields['客户'], undefined);
  assert.equal(refundResult.money.route, 'prepaid');
  // prepaid 不写「收款明细」
  assert.equal(paymentRows(refund.gateway).length, 0);

  const charge = build();
  await charge.service.execute(request({
    action: 'exchange',
    newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
    settlement: 'prepaid',
    diffAmount: 50,
    restockState: '门盒',
  }));
  const chargeRows = rowsOf(charge.gateway, CREDIT_TABLE);
  assert.equal(chargeRows.length, 1);
  assert.equal(chargeRows[0].fields['应收变化'], 50); // 正=客户还欠我们
  assert.equal(paymentRows(charge.gateway).length, 0);

  // 重复执行只写一次
  const before = countsOf(refund.gateway);
  await refund.service.execute(request({ settlement: 'prepaid', diffAmount: -250 }));
  assert.equal(countsOf(refund.gateway), before);
  assert.equal(rowsOf(refund.gateway, CREDIT_TABLE).length, 1);
});

test('prepaid 的幂等键不含内容：同原单同动作第二次（金额不同）→ 大声失败，不写第二笔', async () => {
  const { gateway, service } = build();
  await service.execute(request({ taskId: 'om_a', settlement: 'prepaid', diffAmount: -250 }));
  await assert.rejects(
    () => service.execute(request({ taskId: 'om_b', settlement: 'prepaid', diffAmount: -200 })),
    /客户往来货款 .* 与当前请求不一致（应收变化不一致）/,
  );
  assert.equal(rowsOf(gateway, CREDIT_TABLE).length, 1);
});

test('退回的鞋：门盒 / 样品两种状态都按她说的落库', async () => {
  for (const restockState of ['门盒', '样品']) {
    const { gateway, service } = build();
    await service.execute(request({ restockState }));
    const live = liveRows(gateway);
    assert.equal(live.length, 1);
    assert.equal(live[0].fields['所属状态'], restockState);
  }
});

test('原明细是配品：只记明细行，不写库存流水 / 实时库存（与销售链路一致）', async () => {
  const { gateway, inventory, service } = build();
  await service.execute(request({
    originalSalesDetailRecordIds: ['detail_old_2'],
    diffAmount: -30,
    settlement: 'cash',
  }));
  const details = detailRows(gateway);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['配品'], ['accessory_belt']);
  assert.equal(details[0].fields['尺码'], undefined);
  assert.equal(details[0].fields['成交金额'], 30);
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 0);
  assert.equal(liveRows(gateway).length, 0);
  assert.equal(inventory.calls.length, 0);
  assert.equal(rowsOf(gateway, 'salesDetail')[1].fields['履约状态'], '已退货');
});

test('中途失败后重试：带着本地进度继续，已写的部分不重复写', async () => {
  const { gateway, inventory, service } = build();
  const originalCreate = gateway.create;
  let failed = false;
  gateway.create = async function create(key, values) {
    // 飞书结构化拒绝（确定没写进去）：第一次写收款明细时失败。
    if (key === 'paymentRecord' && !failed) {
      failed = true;
      const error = new Error('新增“收款明细”记录失败: FieldNameNotFound (Code: 1254045)');
      error.bitableRejected = true;
      throw error;
    }
    return originalCreate.call(this, key, values);
  };

  await assert.rejects(() => service.execute(request()), /FieldNameNotFound/);
  // 失败时已经写下的部分：主表 1 条 + 明细 1 条 + 原明细已改状态
  assert.equal(masterRows(gateway).length, 1);
  assert.equal(detailRows(gateway).length, 1);
  assert.equal(paymentRows(gateway).length, 0);
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');

  const result = await service.execute(request());
  assert.equal(gateway.writes.create.salesEntry, 1);
  assert.equal(gateway.writes.create.salesDetail, 1);
  assert.equal(gateway.writes.create.paymentRecord, 1);
  assert.equal(gateway.writes.create.inventoryLedger, 1);
  assert.equal(gateway.writes.create.liveInventory, 1);
  assert.equal(gateway.writes.update.salesDetail, 1);
  assert.equal(masterRows(gateway).length, 1);
  assert.equal(detailRows(gateway).length, 1);
  assert.equal(paymentRows(gateway).length, 1);
  assert.equal(inventory.calls.length, 1);
  assert.equal(result.money.route, 'cash');
});

test('重试时发现已写入的远端记录被改动/删除 → 停下来让人核对（不静默重写）', async () => {
  const { gateway, service } = build();
  const originalCreate = gateway.create;
  let failed = false;
  gateway.create = async function create(key, values) {
    if (key === 'paymentRecord' && !failed) {
      failed = true;
      const error = new Error('新增“收款明细”记录失败: FieldNameNotFound (Code: 1254045)');
      error.bitableRejected = true;
      throw error;
    }
    return originalCreate.call(this, key, values);
  };
  await assert.rejects(() => service.execute(request()), /FieldNameNotFound/);

  // 把上次写入的售后主表记录删掉（模拟人工动了数据）
  const masterId = masterRows(gateway)[0].record_id;
  gateway.records.set('salesEntry', rowsOf(gateway, 'salesEntry').filter((row) => row.record_id !== masterId));
  await assert.rejects(() => service.execute(request()), /已记录的售后主表 .*记录已不存在/);
});

test('缺「业务事件ID」列：prepaid 在任何写入之前就大声失败', async () => {
  const { gateway, service } = build({ missingCreditKey: true });
  await assert.rejects(
    () => service.execute(request({ settlement: 'prepaid' })),
    /依赖「业务事件ID」文本列/,
  );
  // 一个字节都没写（失败发生在写主表之前）
  assert.equal(masterRows(gateway).length, 0);
  assert.deepEqual(gateway.writes.create, {});
});

test('入参校验：动作 / newLines / restockState / 原单号 / 原明细归属', async () => {
  const { gateway, service } = build();
  await assert.rejects(() => service.execute(request({ action: 'repair' })), /未声明的售后动作/);
  await assert.rejects(
    () => service.execute(request({ newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }] })),
    /退货不应带新的出货商品/,
  );
  await assert.rejects(() => service.execute(request({ restockState: null })), /缺少「退回的鞋回哪儿」/);
  await assert.rejects(() => service.execute(request({ restockState: '仓库' })), /只能回/);
  await assert.rejects(() => service.execute(request({ originalSalesOrderNo: 'XSD-OTHER' })), /原单号对不上/);
  await assert.rejects(
    () => service.execute(request({ action: 'exchange' })),
    /换货缺少新的出货商品/,
  );
  await assert.rejects(
    () => service.execute(request({
      action: 'compensation',
      newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: -1 }],
    })),
    /必须大于 0/,
  );
  await assert.rejects(
    () => service.execute(request({ originalSalesDetailRecordIds: ['pay_old_1'] })),
    /找不到原销售明细/,
  );
  // 没有被写入任何业务表
  assert.equal(masterRows(gateway).length, 0);
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 0);
  assert.deepEqual(gateway.writes.create, {});
});
