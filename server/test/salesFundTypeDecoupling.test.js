// ⭐ 资金与类型**彻底解耦**：四种资金形态 × 两种类型（2026-10-07 业务负责人拍板）。
//
// 她的口径（逐字）：
//   「【类型 = 只看库存】库存里有这双 → 现货（当场交付 + 扣库存）；
//     库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）
//    【资金 = 只听你怎么说】（与类型完全无关）
//     全款 → 收款 1 条已收、欠款 0；付了一部分 → 已收那部分 + 待收剩余；
//     没付 → 0 条已收 + 全额待收」
//
// ⇒ 本文件对**同样一份资金原话**跑两次：一次库里**有**这双（→ 现货），
//   一次库里**没有**（→ 预定），断言**收款条数与欠款数字逐字相同** ——
//   这就是"资金与类型无关"的正证据（AC-3.1 ~ AC-3.6）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeSalesResult } = require('../src/services/doubaoService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { InventoryService } = require('../src/services/inventoryService');
const { SalesProgressService } = require('../src/services/salesProgressService');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const GROUP_CHAT_ID = 'oc_test_group';
const PRODUCT = 'p_black';
const ITEM_NO = 'B26002-52';

const fakeBase = ({ products, liveInventory }) => {
  const records = new Map([
    ['product', products],
    ['liveInventory', liveInventory],
    ['behavior', [
      { record_id: 'bhv_cash', fields: { 行为编码: 'SALE_CASH', 行为名称: '现货' } },
      { record_id: 'bhv_prepaid', fields: { 行为编码: 'SALE_PREPAID', 行为名称: '预定' } },
      { record_id: 'behavior_sale', fields: {
        行为编码: 'STOCK_SALE_DECREASE', 行为名称: '销售减少', 库存方向: '减少', 是否启用: true,
      } },
    ]],
    ['paymentMethod', [
      { record_id: 'pm_wechat', fields: { 收款方式: '微信' } },
      { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
    ]],
    ['sizeManagement', [37, 38, 39].map((size) => ({
      record_id: `size_${size}`, fields: { 尺码: size },
    }))],
    ['salesEntry', [{ record_id: 'order_1', fields: {} }]],
  ]);
  const write = (key, values) => Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => {
      const field = V1_BITABLE_SCHEMA.tables[key]?.fields?.[name];
      if (!field) throw new Error(`${key}: unknown field ${name}`);
      return [field, value];
    }));
  let seq = 0;
  return {
    records,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    validateTables: async () => [],
    listAll: async (key) => records.get(key) || [],
    get: async (key, id) => (records.get(key) || []).find((row) => row.record_id === id),
    create: async (key, values) => {
      const recordId = `${key}_${++seq}`;
      if (!records.has(key)) records.set(key, []);
      records.get(key).push({ record_id: recordId, fields: write(key, values) });
      return { recordId };
    },
    update: async (key, id, values) => {
      const record = (records.get(key) || []).find((row) => row.record_id === id);
      if (record) Object.assign(record.fields, write(key, values));
      return record;
    },
    delete: async (key, id) => {
      const rows = records.get(key) || [];
      const index = rows.findIndex((row) => row.record_id === id);
      if (index >= 0) rows.splice(index, 1);
      return true;
    },
  };
};

const productRow = () => ({
  record_id: PRODUCT,
  fields: { 编号: `${ITEM_NO}|黑色|B`, 货号: ITEM_NO, 颜色: '黑色', 货品状态: '在售' },
});
const liveRow = () => ({
  record_id: 'live_1',
  fields: {
    库存键: `${ITEM_NO}|黑色|女鞋|37`,
    所属状态: '门盒',
    编号: [{ id: PRODUCT }],
    尺码: ['size_37'],
  },
});

/**
 * 跑一笔：`modelOutput` = 模型按她的原话给出的结构化结果（真的走 `normalizeSalesResult`）。
 * `inStock` = 实时库存里有没有这一双 ⇒ **这一单的类型**（现货 / 预定）。
 */
const runSale = async ({ taskId, text, modelOutput, inStock }) => {
  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'fund-type-')), idField: 'task_id',
  });
  const gateway = fakeBase({ products: [productRow()], liveInventory: inStock ? [liveRow()] : [] });
  const service = new LarkMvpService({
    client: {}, gateway, store,
    recognizer: { parseSalesText: async () => normalizeSalesResult(modelOutput, text) },
    delivery: new SalesDeliveryService({
      gateway,
      inventory: new InventoryService({
        gateway,
        store: new JsonTaskStore({
          dir: fs.mkdtempSync(path.join(os.tmpdir(), 'inv-ops-')), idField: 'operation_id',
        }),
      }),
    }),
  });
  service.sendTaskCard = async () => 'om_card';
  service.sendTaskText = async () => {};
  await store.create({ task_id: taskId, type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: `om_${taskId}`,
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: text });
  await service.processSalesTask(taskId);
  const draftTask = await store.get(taskId);
  assert.deepEqual(draftTask.draft.missing_fields, [], '这四种资金形态都是完整输入');
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: taskId } },
  });
  assert.equal(result.toast.type, 'success', result.toast.content);
  const posted = await store.get(taskId);
  const receipts = (gateway.records.get('paymentRecord') || [])
    .map((row) => [row.fields['收款金额'], row.fields['收款状态']]);
  const progress = await new SalesProgressService({ gateway }).forOrder(posted.sales_entry_record_id);
  return { draft: draftTask.draft, posted, gateway, receipts, progress,
    item: posted.draft.items[0] };
};

const baseItem = () => ({
  item_no: ITEM_NO, color: '黑色', size: 37, quantity: 1, actual_amount: 228,
});

// ── 四种资金形态（她的原话 → 模型输出）────────────────────────────────────
const SHAPES = [
  {
    key: 'full',
    label: '全款：228 元微信',
    text: `${ITEM_NO} 37 码，228 元微信`,
    modelOutput: { intent: 'sale', trade_type: '现货', items: [baseItem()],
      payments: [{ amount: 228, method: '微信' }], agreed_total: 228 },
    receipts: [[228, '已收款']],
    pendingAmount: 0,
    paymentStatus: '已收款',
  },
  {
    key: 'partial',
    label: '部分：先给 100、还欠 128',
    text: `${ITEM_NO} 37 码，卖了 228，先给 100，还欠 128`,
    modelOutput: { intent: 'sale', trade_type: '现货', items: [baseItem()],
      payments: [{ amount: 100, method: '微信' }], owed: 128, agreed_total: 228 },
    receipts: [[100, '已收款'], [128, '未收款']],
    pendingAmount: 128,
    paymentStatus: '部分收款',
  },
  {
    key: 'unpaid',
    label: '没付：整单未付',
    text: `${ITEM_NO} 37 码，228 元未付`,
    modelOutput: { intent: 'sale', trade_type: '现货', items: [baseItem()],
      payments: [], owed: 228, agreed_total: 228 },
    receipts: [[228, '未收款']],
    pendingAmount: 228,
    paymentStatus: '未收款',
  },
  {
    key: 'deposit',
    label: '定金 100 + 尾款 128（她明说欠）',
    text: `${ITEM_NO} 37 码，定金微信交了 100 元，下次欠 128 元`,
    modelOutput: { intent: 'sale', trade_type: '预定', items: [baseItem()],
      payments: [{ amount: 100, method: '微信' }], agreed_total: 228 },
    receipts: [[100, '已收款'], [128, '未收款']],
    pendingAmount: 128,
    paymentStatus: '部分收款',
  },
];

for (const shape of SHAPES) {
  test(`③ ${shape.label}：**现货**（库里有）→ 收款 ${JSON.stringify(shape.receipts)}、欠款 ${shape.pendingAmount}`, async () => {
    const run = await runSale({
      taskId: `cash_${shape.key}`, text: shape.text, modelOutput: shape.modelOutput, inStock: true,
    });
    assert.equal(run.item.trade_type_code, 'SALE_CASH', '库里有 → 现货');
    assert.deepEqual(run.receipts, shape.receipts);
    assert.equal(run.progress.pendingAmount, shape.pendingAmount);
    assert.equal(run.progress.paymentStatus, shape.paymentStatus);
    // 现货 → 已交付 + 扣了库存（这四种资金形态都交付，钱没结清也交付）。
    assert.equal((run.gateway.records.get('salesDetail') || [])[0].fields['履约状态'], '已交付');
    assert.ok((run.gateway.records.get('inventoryLedger') || []).length >= 1);
    assert.equal(run.posted.status, 'posted');
  });

  test(`③ ${shape.label}：**预定**（库里没有）→ 收款条数与欠款数字**逐字相同**；不交付、不扣库存`, async () => {
    const run = await runSale({
      taskId: `prepaid_${shape.key}`, text: shape.text, modelOutput: shape.modelOutput, inStock: false,
    });
    assert.equal(run.item.trade_type_code, 'SALE_PREPAID', '库里没有 → 预定');
    // ⭐ 这就是"资金与类型无关"：**同样一串收款**，一字不差。
    assert.deepEqual(run.receipts, shape.receipts);
    assert.equal(run.progress.pendingAmount, shape.pendingAmount);
    // 预定 → 不交付、不扣库存。
    assert.equal((run.gateway.records.get('salesDetail') || [])[0].fields['履约状态'], '未交付');
    assert.equal(run.gateway.records.get('inventoryLedger'), undefined);
    assert.equal(run.posted.status, 'posted', '预定照样入账（只是未交付）');
  });
}

// ── AC-3.6：预定 + 全款 / 预定 + 没付都是**合法输入**（没有"预付必须有定金"那种前提）──
test('③ 预定 + 全款 / 预定 + 没付都能入账（"预定必须有定金"那条隐含前提已清掉）', async () => {
  const paidFull = await runSale({
    taskId: 'prepaid_full', text: `${ITEM_NO} 37 码，228 元微信`,
    modelOutput: { intent: 'sale', trade_type: '现货', items: [baseItem()],
      payments: [{ amount: 228, method: '微信' }], agreed_total: 228 },
    inStock: false,
  });
  assert.equal(paidFull.item.trade_type_code, 'SALE_PREPAID');
  assert.deepEqual(paidFull.receipts, [[228, '已收款']], '预定也可以全款收清');
  assert.equal(paidFull.progress.pendingAmount, 0);
  assert.equal(paidFull.progress.paymentStatus, '已收款');
  assert.equal(paidFull.progress.orderStatus, '已确认', '钱齐了但货没交 ⇒ 还没完成履约');

  const nothingPaid = await runSale({
    taskId: 'prepaid_nothing', text: `${ITEM_NO} 37 码，228 元未付`,
    modelOutput: { intent: 'sale', trade_type: '现货', items: [baseItem()],
      payments: [], owed: 228, agreed_total: 228 },
    inStock: false,
  });
  assert.equal(nothingPaid.item.trade_type_code, 'SALE_PREPAID');
  assert.deepEqual(nothingPaid.receipts, [[228, '未收款']], '一分没付 = 0 条已收 + 全额待收');
  assert.equal(nothingPaid.progress.paymentStatus, '未收款');
});

// ── 类型只看库存：同一份资金原话、只有库存不同 → 只差"类型 / 交付"，收款完全一致 ──
test('③ 同一份资金原话：库里有 / 没有，两次的收款记录**逐字相同**（类型不影响钱）', async () => {
  const shape = SHAPES.find((row) => row.key === 'phase') || SHAPES[1];
  const withStock = await runSale({
    taskId: 'same_money_in', text: shape.text, modelOutput: shape.modelOutput, inStock: true,
  });
  const withoutStock = await runSale({
    taskId: 'same_money_out', text: shape.text, modelOutput: shape.modelOutput, inStock: false,
  });
  assert.deepEqual(withStock.receipts, withoutStock.receipts);
  assert.equal(withStock.progress.pendingAmount, withoutStock.progress.pendingAmount);
  assert.notEqual(withStock.item.trade_type_code, withoutStock.item.trade_type_code);
});
