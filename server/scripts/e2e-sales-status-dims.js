// 四个状态维度的**真机端到端**验证（只写测试 Base，绝不碰生产）。
//
// 走的是项目自己的链路（不是手工拼表）：
//   LarkMvpService.createSalesEntryWithOrderNo   ① 确认状态 = 未确认
//     → LarkMvpService.handleCardAction('confirm_sale')   ① = 已确认
//       → V1PostingService → SalesOrderService         ② 销售明细 → 销售状态 = 已写入
//                                                      ③ 收款明细 → 资金状态 = 已写入
//         → SalesDeliveryService → InventoryService     ④ 库存流水+实时库存 → 库存状态 = 已扣减
//
// ⚠️ 只有两处是桩：AI 解析（不调模型，用固定草稿）与飞书 IM（不发卡片/不刷她的聊天）。
//    业务表的读写全部走真实服务与真实网关。
// ⚠️ 安全闸门（三道，任何一道不过就拒绝运行）：
//    1) FEISHU_TARGET_ENV 必须是 test；
//    2) schema 的 appToken 必须等于 FEISHU_V1_E2E_TEST_APP_TOKEN；
//    3) 禁止 FEISHU_ALLOW_PRODUCTION_WRITE。
// ⚠️ 严禁飞书 CLI：本脚本只走项目源码里的 V1BitableGateway。
//
// 用法：
//   node server/scripts/e2e-sales-status-dims.js            # 跑一条完整链路并打印四个字段
//   node server/scripts/e2e-sales-status-dims.js --seed-options
//        # 额外：先用一条临时记录把四个字段的选项**按业务顺序**写一遍（再删掉临时记录）。
//        # 为什么要它：飞书选项的显示顺序 = 第一次写入的顺序，所以第一次写要按业务顺序。
//        # 删记录不会删选项。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// dotenv 必须在任何业务模块之前加载（schema 的 tableId 是模块级求值）。
require('dotenv').config({ path: path.join(__dirname, '../../.env'), quiet: true });

const lark = require('@larksuiteoapi/node-sdk');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1BitableGateway, linkedRecordIds, textValue } = require('../src/services/v1BitableGateway');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { SALES_STATUS_VALUES: S } = require('../src/config/salesStatusDimensions');

const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
const say = (line) => console.log(line);

const guard = () => {
  const appToken = V1_BITABLE_SCHEMA.appToken;
  const testToken = process.env.FEISHU_V1_E2E_TEST_APP_TOKEN;
  assert.ok(appToken, '未配置 FEISHU_V1_BITABLE_APP_TOKEN，拒绝运行');
  assert.ok(testToken, '未配置 FEISHU_V1_E2E_TEST_APP_TOKEN，拒绝运行（不知道哪个才是测试 Base）');
  assert.equal(appToken, testToken, '当前 app_token 不是测试 Base —— 本脚本只允许写测试 Base，已拒绝运行');
  assert.equal(String(process.env.FEISHU_TARGET_ENV || '').trim().toLowerCase(), 'test',
    '必须显式声明 FEISHU_TARGET_ENV=test');
  assert.notEqual(String(process.env.FEISHU_ALLOW_PRODUCTION_WRITE || '').toLowerCase(), 'true',
    '检测到「允许写生产」的开闸，拒绝运行');
};

// 从实时库存里挑一双**门盒**的鞋：返回 { productRecordId, size, itemNo, color }。
const pickDoorBoxPair = async (gateway) => {
  const live = await gateway.listAll('liveInventory');
  const liveFields = gateway.table('liveInventory').fields;
  const sizes = await gateway.listAll('sizeManagement');
  const sizeFields = gateway.table('sizeManagement').fields;
  const sizeById = new Map(sizes.map((row) => [row.record_id, Number(textValue(row.fields?.[sizeFields.size]))]));
  for (const row of live) {
    if (textValue(row.fields?.[liveFields.state]) !== '门盒') continue;
    const productId = linkedRecordIds(row.fields?.[liveFields.product])[0];
    const sizeId = linkedRecordIds(row.fields?.[liveFields.size])[0];
    const size = sizeById.get(sizeId);
    // 「库存键」= 货号|颜色|档位|尺码（实时库存就是用这四个要素定位一双鞋）。
    const parts = String(textValue(row.fields?.[liveFields.stockKey]) || '').split('|');
    if (!productId || !Number.isInteger(size) || size <= 0 || parts.length < 4) continue;
    return { productRecordId: productId, size, itemNo: parts[0], color: parts[1], liveRecordId: row.record_id };
  }
  throw new Error('测试 Base 里找不到「门盒」的在库鞋，先补一条实时库存再跑');
};

// 用一条临时记录把四个字段的选项按业务顺序写一遍，然后删掉这条记录。
// 飞书：往 0 选项的单选字段写值会自动长选项；**选项的显示顺序 = 第一次写入的顺序**。
const seedOptions = async (gateway) => {
  say('\n── 预热选项顺序（临时记录，写完就删；选项会留下）');
  const { recordId } = await gateway.create('salesEntry', {
    originalText: '【选项预热】这条记录会被立即删除，只为了让四个单选字段的选项按业务顺序长出来',
    parseStatus: '解析中',
  });
  try {
    for (const [dimension, values] of Object.entries({
      userAction: Object.values(S.userAction),
      sales: Object.values(S.sales),
      funds: Object.values(S.funds),
      stock: Object.values(S.stock),
    })) {
      for (const value of values) await gateway.update('salesEntry', recordId, { [dimension]: value });
      say(`  ✓ ${dimension}: ${values.join(' / ')}`);
    }
  } finally {
    await gateway.delete('salesEntry', recordId);
    say(`  ✓ 临时记录已删除：${recordId}`);
  }
};

const printOptions = async (gateway) => {
  const fields = await gateway.listFields('salesEntry');
  say('\n── 四个字段在真表里的选项（顺序 = 第一次写入的顺序）');
  for (const name of ['确认状态', '销售状态', '资金状态', '库存状态']) {
    const field = fields.find((item) => item.field_name === name);
    const options = (field?.property?.options || []).map((option) => option.name);
    say(`  ${name}（${field?.ui_type || field?.type}）：${options.length ? options.join(' / ') : '(空)'}`);
  }
};

const main = async () => {
  guard();
  const client = new lark.Client({
    appId: process.env.LARK_AGENT_APP_ID,
    appSecret: process.env.LARK_AGENT_APP_SECRET,
    logger: silentLogger,
  });
  const gateway = new V1BitableGateway({ client });
  say(`测试 Base app_token：${V1_BITABLE_SCHEMA.appToken}（FEISHU_TARGET_ENV=${process.env.FEISHU_TARGET_ENV}）`);

  if (process.argv.includes('--seed-options')) await seedOptions(gateway);

  const pair = await pickDoorBoxPair(gateway);
  say(`\n── 挑一双门盒鞋：${pair.itemNo} ${pair.color} ${pair.size}码`
    + `（货品 ${pair.productRecordId}，实时库存 ${pair.liveRecordId}）`);

  const store = new JsonTaskStore({
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-status-dims-')), idField: 'task_id',
  });
  const service = new LarkMvpService({ client, gateway, store });
  // 只桩 IM：不发卡片、不刷她的聊天。业务写入全走真实服务。
  service.replyCard = async () => 'om_e2e_stub';
  service.sendText = async () => undefined;
  service.sendCard = async () => undefined;
  const cards = [];
  service.publishSalesResultCard = async (_task, _event, card) => { cards.push(card); return true; };
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };

  // 「录单人」是 User 字段，必须是一个**真实存在的 open_id**：随便编一个会 UserFieldConvFail。
  // 本机没有她的 open_id，所以退而用机器人自己的（LARK_BOT_OPEN_ID）；两个都没有就留空
  // （person('') → undefined → 字段不写，而不是写一个假 id）。
  const operatorOpenId = process.env.FEISHU_V1_E2E_OPERATOR_OPEN_ID || process.env.LARK_BOT_OPEN_ID || '';
  const task = await store.create({
    task_id: `e2e_status_${Date.now()}`,
    type: 'sale',
    status: 'received',
    message_id: 'om_e2e_stub',
    sender_open_id: operatorOpenId,
    sent_at: Date.now(),
    original_text: `卖一双 ${pair.itemNo} ${pair.color} ${pair.size}码 100元微信`,
  });

  // ① 建单：这一步就该落「未确认」（她还没点按钮）。
  const created = await service.createSalesEntryWithOrderNo(task);
  const entryId = created.recordId;
  await store.update(task.task_id, { sales_entry_record_id: entryId, status: 'ready_to_confirm' });
  const readEntry = async () => gateway.get('salesEntry', entryId);
  const dims = async () => {
    const fields = (await readEntry()).fields;
    return {
      确认状态: textValue(fields['确认状态']) || '(空)',
      销售状态: textValue(fields['销售状态']) || '(空)',
      资金状态: textValue(fields['资金状态']) || '(空)',
      库存状态: textValue(fields['库存状态']) || '(空)',
    };
  };
  say(`\n── ① 建单后（记录 ${entryId}）：${JSON.stringify(await dims())}`);

  // 给她确认卡片用的草稿：形状与 processSalesTask 写进任务的草稿一致。
  // delivery_status='已交付' = 现货当场交付（真实链路由交易类型推出这一项）。
  await store.update(task.task_id, {
    draft: {
      delivery_status: '已交付',
      trade_type: '现货',
      payment_method: '微信',
      total_paid: 100,
      agreed_total: 100,
      items: [{
        kind: 'shoe',
        item_no: pair.itemNo,
        color: pair.color,
        product_record_id: pair.productRecordId,
        product_number: `${pair.itemNo}${pair.color}`,
        size: pair.size,
        quantity: 1,
        actual_amount: 100,
        gift: false,
      }],
      payments: [{ amount: 100, method: '微信', status: '已收款' }],
    },
  });

  // ②③④ 她点「确认」：确认状态 → 销售明细 → 收款明细 → 扣库存。
  await service.handleCardAction({
    operator: { operator_id: { open_id: operatorOpenId } },
    action: { value: { action: 'confirm_sale', draft_id: task.task_id } },
  });

  const after = await dims();
  const orderNo = textValue((await readEntry()).fields['销售单号']);
  const details = (await gateway.listAll('salesDetail'))
    .filter((row) => linkedRecordIds(row.fields?.['销售单号']).includes(entryId));
  const receipts = (await gateway.listAll('paymentRecord'))
    .filter((row) => linkedRecordIds(row.fields?.['关联销售单']).includes(entryId));
  const ledgers = (await gateway.listAll('inventoryLedger'))
    .filter((row) => details.some((detail) => linkedRecordIds(row.fields?.['关联销售']).includes(detail.record_id)));

  say('\n══════ 结果 ══════');
  say(`销售主表记录 id：${entryId}    销售单号：${orderNo}`);
  say(`销售明细 ${details.length} 条：${details.map((row) => row.record_id).join(', ')}`);
  say(`收款明细 ${receipts.length} 条：${receipts.map((row) => row.record_id).join(', ')}`);
  say(`库存流水 ${ledgers.length} 条（这一单的明细关联）：${ledgers.map((row) => row.record_id).join(', ')}`);
  say(`\n四个字段的实际值：`);
  for (const [name, value] of Object.entries(after)) say(`  ${name} = ${value}`);

  await printOptions(gateway);

  const expected = {
    确认状态: S.userAction.CONFIRMED,
    销售状态: S.sales.WRITTEN,
    资金状态: S.funds.WRITTEN,
    库存状态: S.stock.DONE,
  };
  const mismatched = Object.entries(expected).filter(([name, value]) => after[name] !== value);
  if (mismatched.length) {
    say(`\n❌ 未达标：${mismatched.map(([name, value]) => `${name} 期望 ${value} 实际 ${after[name]}`).join('；')}`);
    process.exitCode = 1;
    return;
  }
  say('\n✅ 四个字段全部按预期写进去了');
};

main().catch((error) => {
  console.error(`\n❌ 失败：${error?.message || error}`);
  process.exitCode = 1;
});
