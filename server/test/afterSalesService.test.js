// 退换货第二期·第一步：售后执行器 + 幂等 的测试。
//
// 覆盖：三种动作各一条 · 重复调用只写一次（本步最重要的用例）· 原主表/原明细逐字段未变 ·
//       差价正/负/0 · 资金 cash（prepaid **已下线**：落点「客户往来货款」被整表删除，
//       现在只验"在任何写入之前大声失败"）· 退回状态 门盒/样品 · 库存流水 1 行 / 2 行方向相反 ·
//       失败后重试成功 · 入参校验 · 总闸门（指纹不同就停 · 缺列大声失败）。
//
// 说明：库存那一侧默认已经接入真的 InventoryService（接线完成），
// 但本文件仍然**注入端口**跑业务断言——端口按真实服务的同一套幂等思路实现：
// 以 kind + sourceRecordId 作为操作身份（真实服务用 operationId(kind, sourceRecordId)
// + 远端「库存操作键」），重复调用不再写第二遍。
// 这样这些用例只验证执行器的业务行为，不受库存引擎内部实现变动影响；
// 真 InventoryService 的接线由 inventoryMvp.test.js 里的售后三条声明用例覆盖。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AfterSalesService } = require('../src/services/afterSalesService');
const { InventoryService } = require('../src/services/inventoryService');
const {
  AFTER_SALES_ACTION_SPECS,
  AFTER_SALES_FULFILLMENT,
  AFTER_SALES_PAYMENT_STATUS,
  AFTER_SALES_RETURN_FUNDS_MODES,
  afterSalesEventId,
  afterSalesOperationId,
  readAfterSalesConfig,
  resolveAfterSalesReturnFundsMode,
} = require('../src/config/afterSales');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');

const FIXED_NOW = Date.parse('2026-10-05T10:00:00+08:00');
const ORDER_NO = 'XSD-20261005-001';
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
  paymentMethod: [
    { record_id: 'method_wechat', fields: { 收款方式: '微信' } },
    // 原单是微信，但她说"退我现金"时要能写成现金（业务负责人 2026-10-06 拍板）。
    { record_id: 'method_cash', fields: { 收款方式: '现金' } },
  ],
  product: [
    { record_id: 'product_A', fields: { 货号: 'A100', 颜色: '黑' } },
    { record_id: 'product_B', fields: { 货号: 'B200', 颜色: '棕' } },
  ],
  salesEntry: [{
    record_id: 'order_old',
    fields: { 销售单号: ORDER_NO, 原话: '卖一双 A100 41 码', 销售状态: '已写入', 资金状态: '已写入' },
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
    {
      record_id: 'detail_old_3',
      fields: { 销售单号: ['order_old'], 编号: ['product_B'], 尺码: ['size_42'], 成交金额: 300, 履约状态: '已交付' },
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

/** 本地任务记录一律落在临时目录：测试不碰仓库里的 data/。 */
const tempStore = () => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'after-sales-')),
  idField: 'operation_id',
});

const build = (options = {}) => {
  const gateway = fakeBase(options);
  const inventory = fakeInventory(gateway);
  const store = options.store || tempStore();
  const service = new AfterSalesService({ gateway, inventory, store, now: () => FIXED_NOW,
    ...(options.config ? { config: { ...readAfterSalesConfig(), ...options.config } } : {}) });
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

// 接线（父代理裁决①）：执行器不再要求调用方注入库存服务——不传就接真的 InventoryService；
// 同时保留端口注入（上面所有业务用例仍用端口）。这两点都在这里锁住。
test('接线：不注入端口时默认就是真的 InventoryService；注入真服务时引擎能落退货流水与实时库存', async () => {
  const gateway = fakeBase();
  // 真 InventoryService 会先校验尺码关联字段的结构；假 Base 没提供 listFields
  // 时它会按既有约定跳过结构校验（inventoryMvp 的假网关也是这样）。
  delete gateway.listFields;

  const defaultService = new AfterSalesService({ gateway, store: tempStore(), now: () => FIXED_NOW });
  assert.ok(defaultService.inventory instanceof InventoryService, '不注入时应默认接既有库存服务');

  const service = new AfterSalesService({
    gateway,
    inventory: new InventoryService({ gateway, store: tempStore() }),
    store: tempStore(),
    now: () => FIXED_NOW,
  });
  const result = await service.execute(request());

  assert.deepEqual(result.stock.map((item) => [item.behaviorCode, item.state, item.quantity]),
    [['SALE_RETURN', '门盒', 1]]);
  assert.deepEqual(rowsOf(gateway, 'inventoryLedger')[0].fields, {
    编号: ['product_A'], 尺码: ['size_41'], 变动数量: 1,
    库存行为: ['behavior_return'], 关联销售: [result.detailRecordIds[0]],
  });
  assert.equal(rowsOf(gateway, 'liveInventory').length, 3); // 原有 2 双 + 退回 1 双
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-08 退货收款口径（业务负责人**逐字**，权威；出处 docs/goods-and-money-flows-2026-10-08.md §2/§3）：
//
//   「**退货**：我们就在**原有的销售明细**里面操作：找到当时的销售单，
//    把那双鞋的状态改为"**已退货**"，然后把**收款改成"已退款"**就可以了，
//    如果是用户要资金，那就是**已退款**；用户留存，那就是**已留存**。」
//   「**收款明细表**：如果金额没变，就没有记录…」
//
// ⇒ 退货**不新建**收款记录：把**原销售单**下**原收款记录**的「收款状态」改掉。
//   旧行为（新建一条「交易方向=退回」的收款行）保留在 `returnFundsMode = newReturnRow`，
//   下面有专门的用例（配置翻回去即可回退）。
// ═══════════════════════════════════════════════════════════════════════════
test('退货（cash 退款）· 她的口径：原收款记录改成「已退款」（不新建记录），原主表只动「售后次数」', async () => {
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
  // 2026-10-06 起：只写四个状态维度（旧列已随 schema 删除，写它们会当场抛
  // 「未配置语义字段」——所以这里不需要、也无法再断言那两个旧列名）。
  // 售后主表只在她点过卡片「确认」之后才会被创建 → 「确认状态」= 已确认；
  // 明细 / 钱 / 库存随后都成功了 → 另外三维都是终态。
  assert.equal(masters[0].fields['确认状态'], '已确认');
  assert.equal(masters[0].fields['销售状态'], '已写入');
  assert.equal(masters[0].fields['资金状态'], '已写入');
  assert.equal(masters[0].fields['库存状态'], '已写入');
  assert.deepEqual(masters[0].fields['交易类型'], ['behavior_return']);

  // 2) 新「销售明细」：交易类型=行为 · 销售单号=原主表 · 成交金额=正数
  const details = detailRows(gateway);
  assert.equal(details.length, 1);
  assert.deepEqual(details[0].fields['销售单号'], ['order_old']);
  assert.deepEqual(details[0].fields['编号'], ['product_A']);
  assert.deepEqual(details[0].fields['尺码'], ['size_41']);
  assert.equal(details[0].fields['成交金额'], 250);
  assert.deepEqual(details[0].fields['交易类型'], ['behavior_return']);
  // 退货的复制行**不写**履约状态（"退回来的那双"由**原明细行=已退货**表达）
  assert.equal(details[0].fields['履约状态'], undefined);

  // 3) 原明细只改「履约状态」；原主表**除「售后次数」外**逐字段未变
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');
  assert.deepEqual({ ...rowsOf(gateway, 'salesDetail')[0].fields, 履约状态: '已交付' }, beforeDetail);
  const entryAfter = { ...rowsOf(gateway, 'salesEntry')[0].fields };
  delete entryAfter['售后次数'];
  assert.deepEqual(entryAfter, beforeEntry, '原主表除「售后次数」外逐字段未变');
  assert.deepEqual(result.originalDetailIdsMarked, ['detail_old_1']);

  // 4) 钱（**她的口径**）：**一笔新收款记录都不建**；原收款行的状态 已收款 → 已退款；
  //    金额/方向/交易方式/关联销售单**一个字节都不改**（她的口径只说"把收款改成已退款"）。
  assert.deepEqual(paymentRows(gateway), [], '退货不许新建收款记录');
  const originalPayment = rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1');
  assert.equal(originalPayment.fields['收款状态'], '已退款');
  assert.deepEqual(originalPayment.fields, {
    关联销售单: ['order_old'], 交易方式: ['method_wechat'], 收款金额: 280, 收款状态: '已退款',
  });
  assert.equal(result.money.route, 'originalPaymentStatus');
  assert.equal(result.money.status, '已退款');
  assert.deepEqual(result.money.recordIds, ['pay_old_1']);
  assert.equal(result.money.uncovered, 0, '退 250 ≤ 原收款 280：冲得完');

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

  // 每张表恰好写一次（收款明细是 **update**，不是 create）
  assert.deepEqual(gateway.writes.create, {
    salesEntry: 1, salesDetail: 1, inventoryLedger: 1, liveInventory: 1,
  });
  assert.equal(gateway.writes.create.paymentRecord, undefined, '她的口径：不新建收款记录');
  // salesEntry 两次 update：① 新售后主表的三个状态维度收口；② **原单「售后次数」+1**。
  assert.equal(gateway.writes.update.salesEntry, 2);
  assert.equal(gateway.writes.update.paymentRecord, 1, '只改原收款行的状态这一次');
  assert.equal(gateway.writes.update.salesDetail, 1);
  assert.deepEqual(gateway.writes.delete, {});
  // 本地闸门：记下"这一次做过"，并记住每个阶段的 record_id
  const progress = await service.store.get(result.operationId);
  assert.equal(progress.status, 'completed');
  assert.equal(progress.master_record_id, masters[0].record_id);
  assert.deepEqual(progress.detail_record_ids, [details[0].record_id]);
  assert.deepEqual(progress.original_details_marked, ['detail_old_1']);
  assert.equal(progress.payment_record_id, '', '这条腿不建收款记录，本地也没有 payment_record_id');
  assert.deepEqual(progress.original_payments_updated, ['pay_old_1']);
  assert.deepEqual(progress.after_sales_count, { record_id: 'order_old', before: 0, after: 1 });
});

test('⭐ 退货「用户留存」（settlement=prepaid）· 她的口径：原收款记录改成「已留存」（不新建、也不写已删的表）', async () => {
  const { gateway, service } = build();
  const result = await service.execute(request({
    settlement: 'prepaid',
    originalText: '把那双 A100 退了，钱先存着',
  }));

  const originalPayment = rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1');
  assert.equal(originalPayment.fields['收款状态'], '已留存',
    '她的口径：用户留存 → 收款状态 = 已留存');
  assert.deepEqual(paymentRows(gateway), [], '不新建收款记录');
  assert.equal(result.money.route, 'originalPaymentStatus');
  assert.equal(result.money.status, '已留存');
  // ⚠️ 「客户往来货款」表已被整表删除 ⇒ 这条路**一个字节都不写那张表**（连调用都没有）。
  assert.equal(gateway.writes.create.customerCredit, undefined);
});

test('⭐ 退货收款旧行为保留：returnFundsMode=newReturnRow → 新建一条「退回」收款行（与改动前逐字一致）', async () => {
  const { gateway, service } = build({ config: { returnFundsMode: 'newReturnRow' } });
  const result = await service.execute(request());

  const payments = paymentRows(gateway);
  assert.equal(payments.length, 1, '旧行为：新建一条收款记录');
  assert.equal(payments[0].fields['交易方向'], '退回');
  assert.equal(payments[0].fields['收款金额'], 250);
  // ⚠️ 回退模式下状态用**旧口径**（已收款）——不然"翻开关回退"就不是真的回退。
  assert.equal(payments[0].fields['收款状态'], '已收款');
  assert.deepEqual(payments[0].fields['关联销售单'], [masterRows(gateway)[0].record_id]);
  assert.deepEqual(payments[0].fields['交易方式'], ['method_wechat']);
  assert.equal(result.money.route, 'cash');
  // 原收款行**不动**
  assert.equal(
    rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
    '已收款',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 售后**不写原单**（业务负责人 2026-10-06 定过：「**原主表一字不动**」）
//
// 🔴 原「销售主表」的「销售状态」那一列语义是"明细写进去了没有"
//    （未写入 / 部分写入 / 已写入 / 写入失败），**没有「已退货」这个选项** ——
//    真写下去飞书会自动新建选项，把那一列搞乱。
// 「退过没退过」记在【销售明细·履约状态】＋【新建的退货单（交易类型=销售退货）】上。
// ⚠️ 曾经有一条"回写原单销售状态"的显式开关（默认关），已于 2026-10-06 整体删除：
//    删掉是**行为零变化**，而它的**默认行为**（原主表一字不动）由下面两条用例钉住。
// ═══════════════════════════════════════════════════════════════════════════

test('售后**不写**原单：退货执行完，原主表**只多一个「售后次数」**、其余逐字段未变', async () => {
  const { gateway, service } = build();
  const before = structuredClone(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields,
  );

  await service.execute(request());

  const entry = rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old');
  // ⭐ 「售后次数」是「原主表一字不动」的**唯一例外**（业务负责人 2026-10-08 明确要的）：
  //    「我增加了一个字段：**售后次数**，默认为 0……根据**售后行为去叠加**这个数量」。
  const entryAfter = { ...entry.fields };
  delete entryAfter['售后次数'];
  assert.deepEqual(entryAfter, before, '原主表除「售后次数」外逐字段未变');
  assert.equal(entry.fields['售后次数'], 1, '默认为 0，这一笔退完变成 1');
  assert.equal(entry.fields['销售状态'], '已写入',
    '原单「销售状态」保持原值 —— 那一列没有「已退货」这个选项，写了飞书会自动新建选项');
  // 退货事实记在别处（这正是现在唯一的行为）：原明细履约状态 + 新建的退货单
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');
  assert.equal(masterRows(gateway).length, 1, '新建了一条退货单（交易类型 = 销售退货）');
  assert.deepEqual(masterRows(gateway)[0].fields['交易类型'], ['behavior_return']);
});

test('售后**不写**原单：换货也不动原主表（逐字段未变）', async () => {
  const { gateway, service } = build();
  const before = structuredClone(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields,
  );

  await service.execute(request({
    action: 'exchange',
    originalText: '换一双 B200 42 码',
    originalSalesDetailRecordIds: ['detail_old_1'],
    newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
    diffAmount: 50,
    settlement: 'cash',
    restockState: '门盒',
  }));

  const entry = rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old');
  const entryAfter = { ...entry.fields };
  delete entryAfter['售后次数'];
  assert.deepEqual(entryAfter, before, '换货除「售后次数」外同样不动原主表');
  assert.equal(entry.fields['售后次数'], 1, '换一次也 +1（她的口径：换一次就是 1）');
  assert.equal(entry.fields['销售状态'], '已写入', '换货也不写原单「销售状态」');
});

test('重复执行两次：所有写入都只发生一次（第二次被总闸门整次跳过，售后次数也不会加到 2）', async () => {
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
  // ⭐ 幂等的关键一条：售后次数**不会**因为重放变成 2。
  assert.equal(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    1,
  );
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

// ⭐ 业务负责人 2026-10-06 拍板（AGENTS.md 第 16 条(2)）：
//   「钱退现金」→ 退款记录的「交易方式」写**她实际说的方式**，不沿用原单。
//
// ⚠️ 2026-10-08 起这条只对**新建收款行**那条腿（换货/赔货的差价、以及回退模式下的退货）成立：
//    退货默认走"改原收款状态"，那条腿**不写交易方式**（她的口径只说改状态）——
//    见下面「退货她的口径下不写交易方式」那条用例（**这是与 AGENTS.md 第 16 条(2) 的已知冲突**）。
test('⭐ 她说了「退我现金」（回退模式 newReturnRow）→ 新建的收款行交易方式写**现金**', async () => {
  const { gateway, service } = build({ config: { returnFundsMode: 'newReturnRow' } });
  // 原单的收款方式是微信（seed 里 pay_old_1 = method_wechat），她说的是现金。
  const result = await service.execute(request({ paymentMethod: '现金', originalText: '把那双 A100 退了，退我现金' }));

  const payments = paymentRows(gateway);
  assert.equal(payments.length, 1);
  assert.deepEqual(payments[0].fields['交易方式'], ['method_cash'],
    '写她说的现金，不是原单的微信');
  assert.equal(result.money.methodSource, 'spoken', '来源要说清是"她说的"');
  assert.equal(result.money.methodId, 'method_cash');
});

test('⭐ 退货（她的默认口径）：她说的收款方式**不写进任何记录**，但会解析、会记日志、会进结果', async () => {
  const { gateway, service } = build();
  const result = await service.execute(request({
    paymentMethod: '现金', originalText: '把那双 A100 退了，退我现金',
  }));

  // 不新建记录；原收款行的「交易方式」一个字节都不改（她的口径只说改状态）。
  assert.deepEqual(paymentRows(gateway), []);
  const originalPayment = rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1');
  assert.deepEqual(originalPayment.fields['交易方式'], ['method_wechat'],
    '原收款行的交易方式是历史事实，不许被这次售后再写一遍');
  // 但她说过什么必须留痕（结果 + 日志里都有），排查"钱到底怎么退的"能看到。
  assert.equal(result.money.declaredMethodId, 'method_cash');
  assert.equal(result.money.methodSource, 'spoken');
});

test('⭐ 她没说收款方式（回退模式 newReturnRow）→ 沿用原单的方式（现有逻辑不变，来源标 original）', async () => {
  const { gateway, service } = build({ config: { returnFundsMode: 'newReturnRow' } });
  // 原话里一个方式词都没有；请求里 paymentMethod 也是空。
  const result = await service.execute(request({ paymentMethod: '', originalText: '把那双 A100 退了' }));

  const payments = paymentRows(gateway);
  assert.deepEqual(payments[0].fields['交易方式'], ['method_wechat'], '她没说 → 沿用原单的微信');
  assert.equal(result.money.methodSource, 'original');
  assert.equal(result.money.methodId, 'method_wechat');
});

test('⭐ 指纹含收款方式：同一分片里"现金"改成"微信"是另一笔，不能被当成重试整次跳过', async () => {
  const { gateway, service } = build();
  await service.execute(request({ paymentMethod: '现金' }));
  const writesAfterFirst = countsOf(gateway);

  await assert.rejects(
    () => service.execute(request({ paymentMethod: '微信' })),
    /请求内容与上次不同/,
    '方式变了就不是同一次售后，不许静默复用上一次的结果',
  );
  assert.equal(countsOf(gateway), writesAfterFirst, '拒绝时不许再写一笔');
});

test('⭐ 她说的方式在「收款方式管理」里不存在 → 当场抛（不偷偷写回原单的方式）', async () => {
  const { gateway, service } = build();
  await assert.rejects(
    () => service.execute(request({ paymentMethod: '刷卡' })),
    /收款方式管理中找不到：刷卡/,
  );
  assert.deepEqual(paymentRows(gateway), [], '一个字节都不许写进收款明细');
});

test('给了 taskId 时，同一原单同一动作可以做第二次（每次用户消息一个分片）', async () => {
  const { gateway, service } = build();
  await service.execute(request({ taskId: 'om_task_a', originalText: '退第一双', diffAmount: -250 }));
  await service.execute(request({ taskId: 'om_task_b', originalText: '再退第二双', diffAmount: -200 }));
  assert.equal(masterRows(gateway).length, 2);
  assert.equal(detailRows(gateway).length, 2);
  // ⚠️ 她的口径下退货**不新建**收款记录；原收款行第一次就被改成「已退款」，
  //    第二次已经不在可改状态里了（见下面"已知局限"那一条用例）。
  assert.equal(paymentRows(gateway).length, 0);
  // ⭐ 两笔售后 ⇒ 原单「售后次数」= 2（"根据售后行为去叠加"）。
  assert.equal(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    2,
  );
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 2);
});

// 幂等键 = after_sales:<原主表id>:<action>:<原明细批次哈希>。
// 这里的三个性质就是"部分退货"能支持、而"重复退同一双"仍被挡住的原因。
test('幂等键构成：原单 + 动作 + 明细批次哈希（顺序无关、批次不同则键不同）', () => {
  const keyOf = (ids) => afterSalesEventId({
    originalSalesEntryRecordId: 'order_old', action: 'return', originalSalesDetailRecordIds: ids,
  });
  // 同一批明细，调用方换顺序 → 同一个键（同一批还是同一批）
  assert.equal(keyOf(['detail_old_1', 'detail_old_3']), keyOf(['detail_old_3', 'detail_old_1']));
  // 换一批明细 → 不同键（部分退货可以再做一次）
  assert.notEqual(keyOf(['detail_old_1']), keyOf(['detail_old_1', 'detail_old_3']));
  assert.match(keyOf(['detail_old_1']), /^after_sales:order_old:return:[0-9a-f]{12}$/);
  // 本地分片键同样带批次哈希，否则"先退 A 再退 B"会撞进同一分片被闸门拒绝
  assert.equal(
    afterSalesOperationId({
      originalSalesEntryRecordId: 'order_old', action: 'return', originalSalesDetailRecordIds: ['detail_old_1'],
    }),
    'after_sales_order_old_return_d5268040a9a4',
  );
  assert.equal(
    afterSalesOperationId({
      taskId: 'om_x!', originalSalesEntryRecordId: 'order_old', action: 'return',
      originalSalesDetailRecordIds: ['detail_old_1'],
    }),
    'after_sales_task_om_x_d5268040a9a4',
  );
  assert.throws(() => keyOf([]), /缺少被退\/被换的原明细/);
});

// 父代理拍板要支持的正常场景：同一笔销售分两次退不同的鞋。
// 批次哈希不同 → 两个分片 → 互不干扰；同一批重复调用 → 一个分片 → 只写一次。
test('部分退货：同一原单先退明细 A、再退明细 B，两笔都成功且互不干扰', async () => {
  const { gateway, inventory, service } = build();
  const first = await service.execute(request());
  const second = await service.execute(request({
    originalSalesDetailRecordIds: ['detail_old_3'],
    originalText: '另一双 B200 也退了',
    diffAmount: -300,
  }));

  assert.notEqual(first.operationId, second.operationId);
  assert.equal(masterRows(gateway).length, 2);
  assert.equal(detailRows(gateway).length, 2);
  // ⚠️ 她的口径下不新建收款记录；seed 里**只有一条**收款行（pay_old_1，已收款 280），
  //    第一笔退货就把它改成「已退款」了 ⇒ 第二笔没有可改的行（**已知局限**，见报告）。
  assert.equal(paymentRows(gateway).length, 0);
  assert.equal(
    rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
    '已退款',
  );
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 2);
  assert.equal(liveRows(gateway).length, 2);
  // 两条原明细各自被改成「已退货」，谁也没覆盖谁
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');
  assert.equal(rowsOf(gateway, 'salesDetail')[2].fields['履约状态'], '已退货');
  assert.deepEqual(first.originalDetailIdsMarked, ['detail_old_1']);
  assert.deepEqual(second.originalDetailIdsMarked, ['detail_old_3']);
  assert.equal(inventory.calls.length, 2);
  // ⭐ 两次售后 ⇒ 原单「售后次数」= 2。
  assert.equal(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    2,
  );
});

test('同一批明细重复调用只写一次；同一条明细再退一次仍被拦住', async () => {
  const { gateway, service } = build();
  const first = await service.execute(request());
  const before = countsOf(gateway);

  const again = await service.execute(request());

  assert.equal(countsOf(gateway), before, '同一批明细第二次不应再写任何东西');
  assert.deepEqual(again, first, '第二次直接返回上次的结果');
  assert.equal(masterRows(gateway).length, 1);
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 1);
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');
});

test('⛔ prepaid（钱存着）在**非退货**与**回退模式**下仍然大声失败：一个字节都不写', async () => {
  // 「客户往来货款」被业务负责人 2026-10-08 整表删除 ⇒ 那两条路仍只能"大声失败"，
  // 而且必须失败在**任何写入之前**（不能写一半，也不能偷偷改成写「收款明细」）。
  const expected = /「客户往来货款」表已被整表删除/;

  // ① 换货 + prepaid（她还欠我们 → 原意是记预存）：不在退货口径内 → 照旧拦住。
  const exchange = build();
  await assert.rejects(
    () => exchange.service.execute(request({
      action: 'exchange',
      newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
      settlement: 'prepaid',
      diffAmount: 50,
      restockState: '门盒',
    })),
    expected,
  );
  assert.deepEqual(exchange.gateway.writes.create, {}, '换货 prepaid 失败时不能写任何东西');
  assert.deepEqual(exchange.gateway.writes.update, {});

  // ② 回退模式（newReturnRow）下的退货 + prepaid：旧行为就是写那张已删的表 → 同样拦住。
  const legacy = build({ config: { returnFundsMode: 'newReturnRow' } });
  await assert.rejects(
    () => legacy.service.execute(request({
      originalSalesDetailRecordIds: ['detail_old_3'], settlement: 'prepaid',
      originalText: '另一双也退，钱存着', diffAmount: -300,
    })),
    expected,
  );
  assert.deepEqual(legacy.gateway.writes.create, {}, 'prepaid 失败时不能写任何东西');
  assert.deepEqual(legacy.gateway.writes.update, {});
  assert.deepEqual(legacy.gateway.writes.delete, {});
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

  // 钱：要收 50（收入）→ 新建一条收款记录，状态 = 已收款（她的口径：增加资金 → 已收款 · 收入）
  const payments = paymentRows(gateway);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].fields['交易方向'], '收入');
  assert.equal(payments[0].fields['收款金额'], 50);
  assert.equal(payments[0].fields['收款状态'], '已收款');
  assert.deepEqual(payments[0].fields['关联销售单'], [result.masterRecordId]);
  // 原收款行（pay_old_1）不动 —— 换货的差价走**新行**，不动原单的收款历史。
  assert.equal(
    rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
    '已收款',
  );
});

test('⭐ 换货「我们付差价」（退回）→ 新建的收款行状态 = 已退款（她的 2026-10-08 口径）', async () => {
  const { gateway, service } = build();
  // 新鞋 200 − 原鞋 250 = −50：我们退她 50。
  const result = await service.execute(exchangeRequest({
    newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 200 }],
    diffAmount: -50,
  }));

  const payments = paymentRows(gateway);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].fields['交易方向'], '退回');
  assert.equal(payments[0].fields['收款金额'], 50);
  assert.equal(payments[0].fields['收款状态'], '已退款',
    '她的口径：「如果是我们付差价的话，方向就是退回，状态是已退款」');
  assert.equal(result.money.status, '已退款');
});

// ⭐⭐ 2026-10-08 赔付口径（业务负责人**逐字**，权威；出处 docs/goods-and-money-flows-2026-10-08.md §2）：
//   「**赔付**：如果是赔货，我们就**直接在销售明细里面创建一个赔付对应颜色和编号、尺码**的信息，
//    **成交金额记为 0**，**标记为赔货**」
// ⇒ 赔出去的那双新建一条明细行：编号/尺码 = 赔的那双（颜色由「编号」关联的货品自带）、
//    **成交金额 = 0**、**履约状态 = 已赔货**。
test('赔货 · 她的口径：新建明细行 成交金额=0 + 履约状态=已赔货；坏鞋不回库，不动钱', async () => {
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
  // ⭐ 赔货的成交金额 = 0（口径逐字），**不是**新鞋的挂牌价 300；
  //    挂牌价只在调用方算差价时用，绝不写进明细行（那会凭空多一笔销售额）。
  assert.equal(details[0].fields['成交金额'], 0);
  // ⭐ 赔出去的那双「履约状态」= 已赔货。
  assert.equal(details[0].fields['履约状态'], AFTER_SALES_FULFILLMENT.COMPENSATED);
  assert.equal(details[0].fields['履约状态'], '已赔货');
  // 原那双（被赔的坏鞋）同样标「已赔货」（既有行为，一个字不改）。
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
});

// ═══════════════════════════════════════════════════════════════════════════
// 换货：新换出去的那条明细要写「履约状态 = 已交付」（2026-10-08）
//
// 真机事实（业务负责人只读核过，2026-10-08 00:02）：原单 XSD-20261007-0054 换货
// 新写入的那条明细（record reczz28KZzAY4BBi）交易类型=换货、金额对，但
// **「履约状态」是空的**。她的口径（逐字）：「好的，是的就叫**已交付**～」。
//
// 🔴 边界：只补这一处 —— 原那双仍是「已换货」；退货的复制行 / 赔货的出货行
//    既有行为**一个字不改**（下面第二条哨兵钉住）。取值走 config/afterSales.js 的枚举。
// ═══════════════════════════════════════════════════════════════════════════

const exchangeRequest = (overrides = {}) => request({
  action: 'exchange',
  originalText: '那双 A100 换一双 B200 42 码，补 50',
  newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
  diffAmount: 50,
  settlement: 'cash',
  restockState: '门盒',
  ...overrides,
});

test('换货：新换出去的那条明细「履约状态」= 已交付（原那双仍是已换货）', async () => {
  const { gateway, service } = build();
  await service.execute(exchangeRequest());

  const details = detailRows(gateway);
  assert.equal(details.length, 1);
  // 值来自配置枚举（不是执行器里的中文字面量），同时钉住它就是她说的那三个字。
  assert.equal(details[0].fields['履约状态'], AFTER_SALES_FULFILLMENT.DELIVERED);
  assert.equal(details[0].fields['履约状态'], '已交付');
  // 原那双：既有正确行为，一个字不改。
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], AFTER_SALES_FULFILLMENT.EXCHANGED);
  // 只补履约状态这一处：别的字段与真机一致（交易类型=换货 · 销售单号=原主表 · 金额=出货金额）。
  assert.deepEqual(details[0].fields['交易类型'], ['behavior_exchange']);
  assert.deepEqual(details[0].fields['销售单号'], ['order_old']);
  assert.deepEqual(details[0].fields['编号'], ['product_B']);
  assert.deepEqual(details[0].fields['尺码'], ['size_42']);
  assert.equal(details[0].fields['成交金额'], 300);
});

test('哨兵：**退货**的复制行「履约状态」仍不写（"退回来的那双"由原明细行=已退货表达）', async () => {
  const returned = build();
  await returned.service.execute(request());
  assert.equal(detailRows(returned.gateway)[0].fields['履约状态'], undefined,
    '退货的复制行不写履约状态（既有行为）');
  assert.equal(rowsOf(returned.gateway, 'salesDetail')[0].fields['履约状态'], '已退货');
});

test('配置先行：三个动作各自声明新明细行的「履约状态」与「成交金额」（不在执行器里写死）', () => {
  assert.equal(AFTER_SALES_FULFILLMENT.DELIVERED, '已交付');
  assert.equal(AFTER_SALES_FULFILLMENT.COMPENSATED, '已赔货');
  // 换货：新换出去的那双 = 已交付；金额用调用方给的（配置里**不**声明固定金额）。
  assert.equal(
    AFTER_SALES_ACTION_SPECS.exchange.newLineFulfillmentStatus,
    AFTER_SALES_FULFILLMENT.DELIVERED,
  );
  assert.equal(AFTER_SALES_ACTION_SPECS.exchange.newLineAmount, undefined);
  // 赔货：赔出去的那双 = 已赔货，且**成交金额固定 0**（她的口径逐字）。
  assert.equal(
    AFTER_SALES_ACTION_SPECS.compensation.newLineFulfillmentStatus,
    AFTER_SALES_FULFILLMENT.COMPENSATED,
  );
  assert.equal(AFTER_SALES_ACTION_SPECS.compensation.newLineAmount, 0);
  // 退货：复制行不写履约状态、金额取原值。
  assert.equal(AFTER_SALES_ACTION_SPECS.return.newLineFulfillmentStatus, undefined);
  assert.equal(AFTER_SALES_ACTION_SPECS.return.newLineAmount, undefined);
});

test('换货重放/重试：明细行只建一次，履约状态不被二次写', async () => {
  // ① 整次重放：总闸门命中 → 一个字节都不写，结果与第一次逐字相同。
  const replay = build();
  const first = await replay.service.execute(exchangeRequest());
  const writesAfterFirst = countsOf(replay.gateway);
  const recordsAfterFirst = snapshot(replay.gateway);

  const second = await replay.service.execute(exchangeRequest());

  assert.deepEqual(second, first, '整次重放直接返回上次的结果');
  assert.equal(countsOf(replay.gateway), writesAfterFirst, '重放不再产生任何 create/update/delete');
  assert.deepEqual(snapshot(replay.gateway), recordsAfterFirst, '重放后所有表内容不变');
  assert.equal(detailRows(replay.gateway)[0].fields['履约状态'], '已交付');

  // ② 中途失败后重试（写收款明细时失败）：复用已建好的明细行 ——
  //    不建第二行，也不把履约状态再写一遍。
  const retried = build();
  const originalCreate = retried.gateway.create;
  let failed = false;
  retried.gateway.create = async function create(key, values) {
    if (key === 'paymentRecord' && !failed) {
      failed = true;
      const error = new Error('新增“收款明细”记录失败: FieldNameNotFound (Code: 1254045)');
      error.bitableRejected = true;
      throw error;
    }
    return originalCreate.call(this, key, values);
  };

  await assert.rejects(() => retried.service.execute(exchangeRequest()), /FieldNameNotFound/);
  assert.equal(detailRows(retried.gateway).length, 1);
  const detailAfterFailure = structuredClone(detailRows(retried.gateway)[0].fields);
  assert.equal(detailAfterFailure['履约状态'], '已交付');

  await retried.service.execute(exchangeRequest());

  assert.equal(retried.gateway.writes.create.salesDetail, 1, '重试不该再建第二条明细行');
  assert.equal(detailRows(retried.gateway).length, 1);
  assert.deepEqual(detailRows(retried.gateway)[0].fields, detailAfterFailure,
    '履约状态不被二次写，整行逐字段不变');
  assert.equal(retried.gateway.writes.create.salesEntry, 1);
  assert.equal(retried.gateway.writes.create.paymentRecord, 1);
  assert.equal(retried.gateway.writes.create.inventoryLedger, 2, '换货两条流水各一次');
});

test('⭐ 金额不变（差价 0 / null）→ 一笔收款记录都不写，原收款行也不改状态', async () => {
  // 她的口径逐字：「**收款明细表**：如果金额没变，就没有记录」。
  for (const diffAmount of [0, null]) {
    const { gateway, service } = build();
    const result = await service.execute(request({ diffAmount, settlement: 'cash' }));
    assert.equal(result.money.route, 'none');
    assert.equal(paymentRows(gateway).length, 0, '不建收款记录');
    assert.equal(gateway.writes.create.paymentRecord, undefined);
    assert.equal(gateway.writes.update.paymentRecord, undefined, '连"改状态"也不做');
    assert.equal(
      rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
      '已收款',
      '金额没变 → 收款状态原样不动',
    );
    // 钱不动，但货照退（库存与明细照写），售后次数照 +1
    assert.equal(rowsOf(gateway, 'inventoryLedger').length, 1);
    assert.equal(
      rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
      1,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 退货「改原收款状态」的两个边界（口径先写清：**最简单且可解释**，不发明复杂规则）
//
//   ① 多笔收款：退款金额按「**后进先出**」从最近一笔往前冲抵，被冲抵到的行整行改状态；
//   ② 已知局限：「收款状态」是单选、**没有"部分退款"**这一档 ⇒ 被**部分**冲抵的行也会整行
//      显示成 已退款/已留存；冲不完的差额只记 warning（`uncovered`），**不新建行**。
//   ③ 「未收款」占位（她明说欠款时那条）**不在可改状态里**：那笔钱没收到，没有"退款"可言。
// ═══════════════════════════════════════════════════════════════════════════

/** 给原单再加一笔收款（用「创建时间」定先后），返回新行 record_id。 */
const addOriginalPayment = (gateway, { recordId, amount, status = '已收款', createdAt }) => {
  gateway.records.get('paymentRecord').push({
    record_id: recordId,
    fields: {
      关联销售单: ['order_old'], 交易方式: ['method_cash'], 收款金额: amount, 收款状态: status, 创建时间: createdAt,
    },
  });
  return recordId;
};

test('⭐ 多笔收款：退款金额按「后进先出」只冲抵到最近那一笔（更早的那笔不动）', async () => {
  const { gateway, service } = build();
  // 定金 100（早，pay_old_1 改成 100）+ 尾款 200（晚，pay_old_2）
  rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['创建时间'] = 1000;
  rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款金额'] = 100;
  addOriginalPayment(gateway, { recordId: 'pay_old_2', amount: 200, createdAt: 2000 });

  // 退 150 ≤ 尾款 200 ⇒ 只动尾款那一笔
  const result = await service.execute(request({ diffAmount: -150 }));

  const byId = Object.fromEntries(rowsOf(gateway, 'paymentRecord').map((row) => [row.record_id, row.fields]));
  assert.equal(byId.pay_old_2['收款状态'], '已退款', '最近一笔先被冲抵');
  assert.equal(byId.pay_old_1['收款状态'], '已收款', '更早那一笔没被冲到，不许动');
  assert.deepEqual(result.money.recordIds, ['pay_old_2']);
  assert.equal(result.money.uncovered, 0);
});

test('⭐ 多笔收款：退得比最近一笔多 → 继续往前冲抵（两笔都改成已退款）', async () => {
  const { gateway, service } = build();
  rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['创建时间'] = 1000;
  rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款金额'] = 100;
  addOriginalPayment(gateway, { recordId: 'pay_old_2', amount: 200, createdAt: 2000 });

  const result = await service.execute(request({ diffAmount: -350 }));

  const byId = Object.fromEntries(rowsOf(gateway, 'paymentRecord').map((row) => [row.record_id, row.fields]));
  assert.equal(byId.pay_old_2['收款状态'], '已退款');
  assert.equal(byId.pay_old_1['收款状态'], '已退款');
  assert.deepEqual(result.money.recordIds, ['pay_old_2', 'pay_old_1']);
  assert.equal(result.money.uncovered, 50, '100 + 200 = 300 < 350：差 50 冲不完（只报数，不建行）');
  assert.equal(gateway.writes.create.paymentRecord, undefined, '冲不完也**不新建**收款记录（她的口径是"改收款"）');
});

test('⭐ 边界：「未收款」占位不在可改状态里（那笔钱没收到，没有"退款"可言）', async () => {
  const { gateway, service } = build();
  // 未收款占位（她明说欠款时那条）：200，比原收款行更晚
  rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['创建时间'] = 1000;
  addOriginalPayment(gateway, { recordId: 'pay_old_unpaid', amount: 200, status: '未收款', createdAt: 2000 });

  const result = await service.execute(request({ diffAmount: -150 }));

  const byId = Object.fromEntries(rowsOf(gateway, 'paymentRecord').map((row) => [row.record_id, row.fields]));
  assert.equal(byId.pay_old_unpaid['收款状态'], '未收款', '未收款占位不许被改成已退款');
  assert.equal(byId.pay_old_1['收款状态'], '已退款', '跳过占位后，钱从真收到的那一笔上退');
  assert.deepEqual(result.money.recordIds, ['pay_old_1']);
});

test('⭐ 边界：原单一条可改的收款行都没有 → 不报错、不建行，只记 warning（业务不停）', async () => {
  const { gateway, service } = build();
  // 原单那一条是「未收款」占位（钱还没收到）
  rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'] = '未收款';

  const result = await service.execute(request({ diffAmount: -250 }));

  assert.equal(result.money.route, 'originalPaymentStatus');
  assert.deepEqual(result.money.recordIds, []);
  assert.equal(result.money.uncovered, 250);
  assert.equal(
    rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
    '未收款',
  );
  assert.equal(paymentRows(gateway).length, 0);
  // 货照退（库存 / 明细 / 售后次数都正常）
  assert.equal(rowsOf(gateway, 'inventoryLedger').length, 1);
  assert.equal(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    1,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 「售后次数」（业务负责人 2026-10-08 逐字；出处 docs/goods-and-money-flows-2026-10-08.md）
//   「我增加了一个字段：**售后次数**，默认为 0。如果他来换一次鞋就是 1，
//    来退一次鞋也是 1，就是根据**售后行为去叠加**这个数量」
// ⇒ 每做成一笔售后（退/换/赔各一次），**原销售主表**那一单的「售后次数」+1。
//   这是「原主表一字不动」的**唯一例外**。
// ═══════════════════════════════════════════════════════════════════════════

test('⭐ 售后次数：原值是 3 → 这一笔退完变成 4（不是覆盖成 1）', async () => {
  const { gateway, service } = build();
  rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'] = 3;

  const result = await service.execute(request());

  assert.equal(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    4,
  );
  assert.deepEqual(result.afterSalesCount, { before: 3, after: 4, written: true });
  // 只写这一列（不碰别的）
  const entry = rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old');
  assert.equal(entry.fields['销售状态'], '已写入');
  assert.equal(entry.fields['原话'], '卖一双 A100 41 码');
});

test('⭐ 售后次数：三个动作（退 / 换 / 赔）各 +1（"根据售后行为去叠加"）', async () => {
  const cases = [
    ['return', request()],
    ['exchange', exchangeRequest()],
    ['compensation', request({
      action: 'compensation',
      newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
      diffAmount: null,
      settlement: null,
      restockState: null,
    })],
  ];
  for (const [label, req] of cases) {
    const { gateway, service } = build();
    const result = await service.execute(req);
    assert.equal(result.afterSalesCount.after, 1, `${label} 这一笔要 +1`);
    assert.equal(
      rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
      1,
      `${label}：原单「售后次数」= 1`,
    );
  }
});

test('⭐ 售后次数：单元格空（默认 0）→ 1；填了非数字 → 当场抛，不把脏数据 +1 写回去', async () => {
  const empty = build();
  // seed 里原单没有「售后次数」这一格（= 她说的"默认为 0"）
  await empty.service.execute(request());
  assert.equal(
    rowsOf(empty.gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    1,
  );

  const dirty = build();
  rowsOf(dirty.gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'] = '三次';
  await assert.rejects(() => dirty.service.execute(request()), /「售后次数」不是有效数字/);
  assert.equal(
    rowsOf(dirty.gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    '三次',
    '停下时不许改这一列',
  );
});

// ⭐ 配置先行：退货收款走哪种实现，是**显式枚举**（默认她的口径），认不出的值当场抛。
test('配置先行：退货收款模式是显式枚举（默认 updateStatus = 她的口径），认不出的值当场抛', () => {
  assert.deepEqual(AFTER_SALES_RETURN_FUNDS_MODES, {
    UPDATE_STATUS: 'updateStatus',
    NEW_RETURN_ROW: 'newReturnRow',
  });
  assert.equal(readAfterSalesConfig({}).returnFundsMode, 'updateStatus', '默认走她的口径');
  assert.equal(resolveAfterSalesReturnFundsMode({}), 'updateStatus');
  assert.equal(resolveAfterSalesReturnFundsMode({ AFTER_SALES_RETURN_FUNDS_MODE: 'newReturnRow' }), 'newReturnRow');
  assert.equal(resolveAfterSalesReturnFundsMode({ AFTER_SALES_RETURN_FUNDS_MODE: '' }), 'updateStatus');
  assert.throws(
    () => resolveAfterSalesReturnFundsMode({ AFTER_SALES_RETURN_FUNDS_MODE: 'update_status' }),
    /只接受 updateStatus \/ newReturnRow/,
  );
  // 收款状态口径（真表选项里都已有，代码不新建选项）
  assert.deepEqual(AFTER_SALES_PAYMENT_STATUS, {
    RECEIVED: '已收款', REFUNDED: '已退款', RETAINED: '已留存',
  });
  const config = readAfterSalesConfig({});
  assert.deepEqual(config.paymentStatus, {
    received: '已收款', refunded: '已退款', retained: '已留存', legacyReturnRow: '已收款',
  });
  assert.deepEqual(config.refundablePaymentStatuses, ['已收款', '待平台结算']);
});

test('⛔ 资金 prepaid（非退货 / 回退模式）：表已被删 → 在任何写入之前大声失败，并说清"下一步怎么办"', async () => {
  // 换货 + prepaid（她还欠我们 → 原意是记预存）：不在"退货改原收款状态"这条腿里 → 照旧拦住。
  const charge = build();
  await assert.rejects(
    () => charge.service.execute(request({
      action: 'exchange',
      newLines: [{ productId: 'product_B', sizeId: 'size_42', amount: 300 }],
      settlement: 'prepaid',
      diffAmount: 50,
      restockState: '门盒',
    })),
    (error) => {
      assert.match(error.message, /「客户往来货款」表已被整表删除/);
      assert.match(error.message, /不会写任何记录/);
      assert.match(error.message, /退现金/, '要告诉她现在该怎么办，而不是只报一个表名');
      return true;
    },
  );
  assert.deepEqual(charge.gateway.writes.create, {}, 'prepaid 不写任何记录');
  assert.deepEqual(charge.gateway.writes.update, {});
  assert.equal(paymentRows(charge.gateway).length, 0, '更不能偷偷改成写「收款明细」');
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

// ⭐ 幂等的关键用例：她默认口径下"改原收款状态"这一步中途失败 → 重试**不重复冲抵**、
//    「售后次数」也**只 +1**。
test('中途失败后重试：改原收款状态失败 → 目标行意图已落盘，重试接着改（不会改错行、不会改两次）', async () => {
  const { gateway, inventory, service } = build();
  const originalUpdate = gateway.update;
  let failed = false;
  gateway.update = async function update(key, id, values) {
    // 飞书结构化拒绝（确定没写进去）：第一次改「收款状态」时失败。
    if (key === 'paymentRecord' && !failed) {
      failed = true;
      const error = new Error('更新“收款明细”记录失败: FieldNameNotFound (Code: 1254045)');
      error.bitableRejected = true;
      throw error;
    }
    return originalUpdate.call(this, key, id, values);
  };

  await assert.rejects(() => service.execute(request()), /FieldNameNotFound/);
  // 失败时已经写下的部分：主表 1 条 + 明细 1 条 + 原明细已改状态；**收款状态还没改**
  assert.equal(masterRows(gateway).length, 1);
  assert.equal(detailRows(gateway).length, 1);
  assert.equal(
    rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
    '已收款',
  );
  assert.equal(rowsOf(gateway, 'salesDetail')[0].fields['履约状态'], '已退货');

  const result = await service.execute(request());
  assert.equal(gateway.writes.create.salesEntry, 1);
  assert.equal(gateway.writes.create.salesDetail, 1);
  assert.equal(gateway.writes.create.paymentRecord, undefined, '她的口径下不建收款记录');
  assert.equal(gateway.writes.create.inventoryLedger, 1);
  assert.equal(gateway.writes.create.liveInventory, 1);
  assert.equal(gateway.writes.update.salesDetail, 1);
  assert.equal(masterRows(gateway).length, 1);
  assert.equal(detailRows(gateway).length, 1);
  assert.equal(
    rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1').fields['收款状态'],
    '已退款',
  );
  assert.equal(inventory.calls.length, 1);
  assert.equal(result.money.route, 'originalPaymentStatus');
  // ⭐ 原单「售后次数」只 +1（重试不许加到 2）：
  //    第一次失败时意图已经落盘（before=0/after=1），重试按意图核对，不重新 +1。
  assert.equal(
    rowsOf(gateway, 'salesEntry').find((row) => row.record_id === 'order_old').fields['售后次数'],
    1,
  );
  assert.equal(gateway.writes.update.salesEntry, 2, '一次是新主表状态收口，一次是原单售后次数');
});

test('重试时发现已写入的远端记录被改动/删除 → 停下来让人核对（不静默重写）', async () => {
  const { gateway, service } = build();
  const originalUpdate = gateway.update;
  let failed = false;
  gateway.update = async function update(key, id, values) {
    if (key === 'paymentRecord' && !failed) {
      failed = true;
      const error = new Error('更新“收款明细”记录失败: FieldNameNotFound (Code: 1254045)');
      error.bitableRejected = true;
      throw error;
    }
    return originalUpdate.call(this, key, id, values);
  };
  await assert.rejects(() => service.execute(request()), /FieldNameNotFound/);

  // 把上次写入的售后主表记录删掉（模拟人工动了数据）
  const masterId = masterRows(gateway)[0].record_id;
  gateway.records.set('salesEntry', rowsOf(gateway, 'salesEntry').filter((row) => row.record_id !== masterId));
  await assert.rejects(() => service.execute(request()), /已记录的售后主表 .*记录已不存在/);
});

// ⭐ 幂等（她的口径下"改原收款状态"这一支）：有人**手工动过**那一笔 → 停下，不许覆盖。
test('⭐ 改状态前发现原收款行被人工改成了别的状态 → 大声失败，不覆盖', async () => {
  const { gateway, service } = build();
  const originalUpdate = gateway.update;
  let failed = false;
  gateway.update = async function update(key, id, values) {
    if (key === 'paymentRecord' && !failed) {
      failed = true;
      const error = new Error('更新“收款明细”记录失败: FieldNameNotFound (Code: 1254045)');
      error.bitableRejected = true;
      throw error;
    }
    return originalUpdate.call(this, key, id, values);
  };
  await assert.rejects(() => service.execute(request()), /FieldNameNotFound/);

  // 人工把那一行改成了别的状态（既不是"改动前"的已收款，也不是目标的已退款）
  const payment = rowsOf(gateway, 'paymentRecord').find((row) => row.record_id === 'pay_old_1');
  payment.fields['收款状态'] = '未收款';
  await assert.rejects(
    () => service.execute(request()),
    /「收款状态」现在是「未收款」.*请人工核对/,
  );
  assert.equal(payment.fields['收款状态'], '未收款', '停下时不许覆盖人工改过的值');
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
