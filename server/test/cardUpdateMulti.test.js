// 「点了卡片没反应」根因修复的回归测试：卡片必须是**共享卡片**（`config.update_multi: true`）。
//
// 现场（真机）：她点销售卡片「确认」→ 后端 patch **成功**
//   （`lark.card.received` → `lark.sales.card.update.succeeded`，342ms），
//   但她界面上卡片**纹丝不动**。她原话：「我点了，只是有个toast，卡片还是没有反应！」
//
// 官方文档（`im-v1/message/patch`，2026-10-07 curl 逐字）：
//   · 「你需在更新**前后**卡片的 `config` 属性中，均显式声明 `"update_multi":true`
//      （表示卡片为共享卡片，卡片的更新对所有接收的用户可见）」；
//   · 「不支持更新仅特定人可见的卡片」。
//   `card-configuration`：「`update_multi`：true=共享卡片…；false=独享卡片，
//    **仅操作用户可见卡片的更新内容**；**默认 false**」。
//   ⇒ 卡片发在群里、她不是"操作用户"，于是 patch 成功也看不见。
//
// 本文件钉住六件事（验收标准见 docs/card-update-multi-2026-10-07.md 第三节）：
//   ① 会被 patch 的 **14 张卡** builder **直出**（= 首次发出的"更新前"那份）都带该字段；
//   ② **两条 patch 出口**（`updateInteractiveCard` / `updatePurchaseActionCard`）
//      **真实打到飞书**的 `data.content` 里也带 —— 用假 client 抓 payload；
//      （2026-10-08：第三条 `LarkMvpService.patchCardMessage` 已随"采购侧统一改用共享实现"删除，
//       采购到货核对现在接的就是 `updateInteractiveCard` —— 见下面"patch 出口 ①"。）
//   ③ `secondDeliveryCard` 经 `settleSecondDeliveryOrder` **深拷贝变换后**仍带（最易漏）；
//   ④ 刻意不 patch 的 **2 张卡**（`saleLookupCard` ×2 分支）
//      **不出现**该字段 —— 把"刻意不动"钉住，将来谁顺手加上会挂
//      （2026-10-08：`purchaseRequestConfirmationCard` 已整张删除，不再是这里的场景）；
//   ⑤ 卡片**可见内容零变化**：`header` / `elements` 与改动前（`origin/main`）逐字相同
//      （golden 见 `test-support/cardVisibleGolden.json`，生成方式见文件末尾注释）；
//   ⑥ 既有断言一条不放宽 —— 本文件是**新增**的，没有改动任何既有用例的判定强度。
//
// ⚠️ 为什么"更新前"也要带：patch 是**整卡替换**，飞书按**更新前后两份**的 config 判共享性。
//    所以修在**每个 builder**（首次发出的那份），而不是只在 patch 那一刻补字段。
//
// ⚠️ 老卡片仍可能不刷新：部署前已经躺在群里、发出时 `update_multi: false` 的那张，
//    按文档字面**可能仍然不动**。本修复只保证**部署后新发的卡**（见 docs 第七节）。

// 读表相关配置要在 require 服务之前就位（服务在模块级可能读它）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const larkCards = require('../src/utils/larkCards');
const { updateInteractiveCard } = require('../src/infrastructure/interactiveCardFeedback');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const {
  ITEMS, PAYMENTS, PATCHABLE_CARD_SCENARIOS, UNPATCHABLE_CARD_SCENARIOS,
} = require('../test-support/cardScenarios');
const VISIBLE_GOLDEN = require('../test-support/cardVisibleGolden.json');

// 共享卡片的 config。**逐字钉住**：多一个字段、少一个字段都要挂。
const PATCHABLE_CONFIG = { wide_screen_mode: true, update_multi: true };

const makeStore = () => new JsonTaskStore({
  dir: fs.mkdtempSync(path.join(os.tmpdir(), 'card-update-multi-')), idField: 'task_id',
});

// 假 client：把**真实 method 打到飞书的那份 payload** 原样抓下来（含 `data.content`）。
const capturePatch = () => {
  const payloads = [];
  const client = { im: { v1: { message: { patch: async (request) => {
    payloads.push(request);
    return { code: 0 };
  } } } } };
  return { client, payloads };
};

// ── ① "更新前"那份：14 张会被 patch 的卡片，builder 直出就是共享卡片 ────────────
test('14 张会被 patch 的卡片：builder 直出（"更新前"那份）的 config 就是共享卡片', () => {
  assert.equal(PATCHABLE_CARD_SCENARIOS.length, 14,
    '清单是 14 张卡（13 个 builder；afterSalesRetryCard 继承 afterSalesConfirmationCard 的 config）');
  for (const { name, build } of PATCHABLE_CARD_SCENARIOS) {
    assert.deepEqual(build(larkCards).config, PATCHABLE_CONFIG,
      `${name} 必须显式声明 update_multi:true，否则它的更新只有操作用户自己看得见`);
  }
});

// ── ④ 刻意不动的卡片：不该出现该字段（"刻意不动"钉住，不是忘了）──────────────
test('刻意不 patch 的卡片：不出现 update_multi（只发不改）', () => {
  assert.equal(UNPATCHABLE_CARD_SCENARIOS.length, 2);
  for (const { name, build } of UNPATCHABLE_CARD_SCENARIOS) {
    const config = build(larkCards).config;
    assert.deepEqual(config, { wide_screen_mode: true }, `${name} 的 config 应当与改动前逐字相同`);
    assert.ok(!('update_multi' in config), `${name} 不被 patch，不该带 update_multi`);
  }
});

// ── ⑤ 可见内容零变化：header / elements 与改动前逐字相同 ──────────────────────
test('卡片可见内容零变化：header / elements 与改动前（origin/main）逐字相同', () => {
  const scenarios = [...PATCHABLE_CARD_SCENARIOS, ...UNPATCHABLE_CARD_SCENARIOS];
  assert.equal(Object.keys(VISIBLE_GOLDEN).length, scenarios.length, 'golden 与场景清单必须一一对应');
  for (const { name, build } of scenarios) {
    const card = build(larkCards);
    // 顶层只允许这三个键：多一个键（藏在别处的新字段）也要挂。
    assert.deepEqual(Object.keys(card).sort(), ['config', 'elements', 'header'], `${name} 顶层键变了`);
    // golden 是从 **origin/main 的 builder** 渲染出来冻结的（不是从改动后的代码"照抄"）。
    assert.deepEqual({ header: card.header, elements: card.elements }, VISIBLE_GOLDEN[name],
      `${name} 的可见内容变了 —— 这次修复只允许 config 变`);
  }
});

// ── ② 两条 patch 出口：真实 payload 里也带（用假 client 抓 data.content）────────
// ⭐ 2026-10-08（业务负责人逐条批准）：采购到货核对**统一改用销售那条共享实现**
//    `updateInteractiveCard`（原先走 `LarkMvpService.patchCardMessage`；它已删除）——
//    所以这里改成**走接线**验证：`arrivalConversation.updateCard` 打到飞书的就是共享出口，
//    而且 payload 里照样带 `update_multi`（否则她那边还是"点了没反应"）。
test('patch 出口 ①：采购到货核对接的 `updateCard` 走 updateInteractiveCard，payload 里带 update_multi', async () => {
  const { client, payloads } = capturePatch();
  const service = new LarkMvpService({
    client, gateway: {}, references: {}, recognizer: {}, store: makeStore(), posting: {},
  });
  const card = larkCards.purchaseArrivalReconcileStatusCard({
    batchNo: 'BH-20261007-0001', message: '已入库 2 双。', template: 'green',
  });

  // 走生产接线注入给到货核对的那个端口（不是直接调共享实现 —— 那样测不到接线）。
  assert.equal(await service.arrivalConversation.updateCard('om_arrival', card), true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].path.message_id, 'om_arrival');
  assert.deepEqual(JSON.parse(payloads[0].data.content).config, PATCHABLE_CONFIG);
});

test('patch 出口 ②：updateInteractiveCard（她点确认后第一次更新那张卡）payload 里带 update_multi', async () => {
  const { client, payloads } = capturePatch();
  // 就是线上出事的那一张：`salesProcessingCard`（stage=processing）。
  const card = larkCards.salesProcessingCard({ items: ITEMS }, {
    title: '⏳ 处理中，正在写入', template: 'blue', itemColor: 'grey',
    progressLine: '⏳ 正在写入销售记录与收款…', note: '已收到确认，请勿重复点击。',
  });

  const updated = await updateInteractiveCard({
    client, task: { task_id: 'sale_x', card_message_id: 'om_sale' }, event: {}, card,
    stage: 'processing', eventPrefix: 'lark.sales.card.update',
  });

  assert.equal(updated, true);
  assert.equal(payloads.length, 1);
  const sent = JSON.parse(payloads[0].data.content);
  assert.deepEqual(sent.config, PATCHABLE_CONFIG);
  // 顺手确认发出去的确实是那张"处理中"卡（不是别的卡串了）。
  assert.equal(sent.header.title.content, '⏳ 处理中，正在写入');
});

test('patch 出口 ③：PurchaseWebhookService.updatePurchaseActionCard 打到飞书的 payload 里带 update_multi', async () => {
  const { client, payloads } = capturePatch();
  const service = new PurchaseWebhookService({ client, gateway: {}, references: {}, recognizer: {} });
  const card = larkCards.purchaseStatusCard({ items: ITEMS }, '采购申请处理中',
    '已收到确认，正在生成采购申请；请勿重复点击。', 'blue');

  const updated = await service.updatePurchaseActionCard(
    { task_id: 'purchase_x', card_message_id: 'om_purchase' }, {}, card);

  assert.equal(updated, true);
  assert.equal(payloads.length, 1);
  assert.deepEqual(JSON.parse(payloads[0].data.content).config, PATCHABLE_CONFIG);
});

// ── ③ 第二次交付：patch 打的是"深拷贝变换后"那份（最易漏）────────────────────
test('secondDeliveryCard 经 settleSecondDeliveryOrder 变换后仍带 update_multi（含真实 payload）', async () => {
  const issued = larkCards.secondDeliveryCard({
    orders: [{ orderNo: 'XSD-001', salesEntryRecordId: 'rec_1', tradeTypeLabel: '已付',
      quantity: 2, pendingAmount: 99, pendingDeliveryQuantity: 1 }],
    methods: ['微信', '现金'], dayKey: '2026-10-07',
  });
  // 变换内部走 `JSON.parse(JSON.stringify(card))` 深拷贝重建 —— 字段必须被带过去。
  const settled = larkCards.settleSecondDeliveryOrder(issued, { salesEntryRecordId: 'rec_1' });
  assert.ok(settled, '这一单在卡里，应当能换成"已成交"');
  assert.notEqual(settled, issued, '是重建的一份，不是原对象');
  assert.deepEqual(settled.config, PATCHABLE_CONFIG);
  // 变换**只动 elements**（把那一单的按钮换成灰字）：header 逐字不变。
  assert.deepEqual(settled.header, issued.header);

  // 再走一次真实出口（`secondDeliveryService.markCardSettled` 用的就是它）。
  const { client, payloads } = capturePatch();
  const updated = await updateInteractiveCard({
    client, task: { task_id: 'day_2026-10-07', card_message_id: 'om_day' }, card: settled,
    stage: 'second_delivery_settled', eventPrefix: 'sales.second_delivery.card.update',
  });
  assert.equal(updated, true);
  assert.deepEqual(JSON.parse(payloads[0].data.content).config, PATCHABLE_CONFIG);
});

// ── 现场复现：她点一次「确认」，两次真实 patch payload 都带该字段 ───────────────
// 这条不是"再测一遍 builder"，而是走**她那条真实链路**：
//   handleCardAction → patch「处理中」→ 入账 → patch「已入账」，
// 用假 client 抓两次真实 payload，断言飞书拿到的那份确实声明了共享卡片。
test('现场复现：她点「确认」后两次真实 patch 的 payload 都带 update_multi', async () => {
  const store = makeStore();
  await store.create({ task_id: 'sale_incident', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1', card_message_id: 'om_card',
    draft: { items: ITEMS, payments: PAYMENTS } });
  const { client, payloads } = capturePatch();
  const service = new LarkMvpService({
    client, gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => ({ sourceNo: 'XSD-001', detailRecordIds: ['detail_1', 'detail_2'] }) },
  });

  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_incident' } },
  });

  assert.equal(result.toast.type, 'success');
  assert.equal(payloads.length, 2, '她点一次应恰好更新两张卡：先「处理中」，后「已入账」');
  for (const [index, payload] of payloads.entries()) {
    assert.deepEqual(JSON.parse(payload.data.content).config, PATCHABLE_CONFIG,
      `第 ${index + 1} 次 patch 的 payload 少了 update_multi —— 她那边就会"点了没反应"`);
  }
  assert.equal(await store.get('sale_incident').then((task) => task.status), 'posted');
});

// golden 的来源（**不是**从改动后的代码照抄，而是从改动前的代码渲染后冻结）：
//   1. `git show origin/main:server/src/utils/larkCards.js` 取改动前那份模块；
//   2. 用 `test-support/cardScenarios.js` 里**同一批输入**分别渲染改动前 / 改动后，
//      `assert.deepEqual({header, elements})` 逐张断言相同（17 张全过）；
//   3. 把改动前那份的 `{header, elements}` 写成 `test-support/cardVisibleGolden.json`。
// 卡片文案有意变更时，同步更新 golden 即可（改的是 golden，不是断言强度）。
//
// ⭐ 2026-10-07 **口径变更**（交易类型 = 库存有没有；卡片分三段说）——
//    两张卡的可见内容**有意**变了，golden 已同步（改的是 golden，不是断言强度）：
//      · `salesConfirmationCard`：原来是「交易类型：…」一行，现在是
//        「类型 / 履约状态 / 收款情况」三行（业务负责人：「【卡片 = 分开说】…」）；
//      · `secondDeliveryCard`：标题从「待成交：未付 / 预付」改成「待成交 / 待收款」
//        （「未付」不再是交易类型）。

// ── ⑦ 只读一眼"这条消息是什么"（`im.v1.message.get`）────────────────────────────
// 2026-10-07 晚真机：日志说 `card_updated`、她那边**一张卡都没有**。根因之一是
// `im.v1.message.patch` 的**唯一成功判据是 `code === 0`** —— 官方文档写着该接口
// "**仅支持更新卡片（消息类型为 `interactive`）**"，可错误码表里**没有**
// "目标不是卡片"这一条 ⇒ 对一条文字/图片消息可能回 `code 0` 却什么都没改。
// ⇒ 到货核对那条链路改成"先读一眼确认它真是卡片，才 patch；改完再读一眼校验"，
//   这个只读口子就是 `LarkMvpService.getMessageMeta`。这里把它的**payload 形状**
//   与**永不抛**的契约钉住（读不到 = 拿不准 = 不动手，绝不影响业务）。
const captureMessageGet = (response) => {
  const payloads = [];
  const client = { im: { v1: { message: { get: async (request) => {
    payloads.push(request);
    if (response instanceof Error) throw response;
    return response;
  } } } } };
  return { client, payloads };
};

test('getMessageMeta：payload 只有 message_id，并把 msg_type / deleted / updated / thread_id 原样交回', async () => {
  const { client, payloads } = captureMessageGet({
    code: 0,
    data: { items: [{
      message_id: 'om_x100b636b253ca430c453e956f10f224',
      msg_type: 'interactive', deleted: false, updated: true,
      thread_id: 'omt_abc', update_time: '1759800000000',
    }] },
  });
  const service = new LarkMvpService({
    client, gateway: {}, references: {}, recognizer: {}, store: makeStore(), posting: {},
  });

  const meta = await service.getMessageMeta('om_x100b636b253ca430c453e956f10f224');

  assert.deepEqual(meta, {
    ok: true, msgType: 'interactive', deleted: false, updated: true,
    threadId: 'omt_abc', updateTime: '1759800000000',
  });
  assert.deepEqual(payloads, [{ path: { message_id: 'om_x100b636b253ca430c453e956f10f224' } }],
    '只读接口：payload 里不许出现别的东西（尤其不许带 patch 的 content）');
});

test('getMessageMeta：非 0 / 抛错 / 没接线 一律 `{ok:false}`，**永不抛**（调用方据此"拿不准就不动手"）', async () => {
  const cases = [
    ['业务码非 0', { code: 230027, msg: 'Lack of necessary permissions.' }, 'code_230027'],
    ['接口抛错', new Error('socket hang up'), 'call_failed'],
    ['没回 items', { code: 0, data: {} }, ''],
  ];
  for (const [label, response, reason] of cases) {
    const { client } = captureMessageGet(response);
    const service = new LarkMvpService({
      client, gateway: {}, references: {}, recognizer: {}, store: makeStore(), posting: {},
    });
    const meta = await service.getMessageMeta('om_x');
    assert.equal(meta.ok, false, label);
    if (reason) assert.equal(meta.reason, reason, label);
  }

  // 没接线（SDK 里没有 get）/ 空 id：同样只是"读不到"，不许抛。
  const bare = new LarkMvpService({
    client: {}, gateway: {}, references: {}, recognizer: {}, store: makeStore(), posting: {},
  });
  assert.deepEqual(await bare.getMessageMeta('om_x'), { ok: false, reason: 'sdk_missing' });
  assert.deepEqual(await bare.getMessageMeta(''), { ok: false, reason: 'no_message_id' });
});

test('接线：到货核对的 `getMessageMeta` 端口**真的接到了** LarkMvpService 上（不是永远 not_wired）', async () => {
  const { client, payloads } = captureMessageGet({
    code: 0, data: { items: [{ message_id: 'om_card_1', msg_type: 'text', deleted: false }] },
  });
  const service = new LarkMvpService({
    client, gateway: {}, references: {}, recognizer: {}, store: makeStore(), posting: {},
  });

  const meta = await service.arrivalConversation.getMessageMeta('om_card_1');

  assert.equal(meta.ok, true);
  assert.equal(meta.msgType, 'text', '真机那次那个 om_x100b… 到底是不是卡片，就靠这条路只读核出来');
  assert.equal(payloads.length, 1, '接到了真东西上（没接的话这里会是 0 次调用 + not_wired）');
});
