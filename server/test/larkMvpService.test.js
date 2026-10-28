const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService, aggregateRecognizedItems } = require('../src/services/larkMvpService');
const { PurchaseBatchLocator } = require('../src/services/purchaseBatchLocator');
const { SalesGroupThreadLocator } = require('../src/services/salesGroupThreadLocator');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
// 「缺口算出来了 → 会挂到点确认之后的卡片上」这个衔接点用真实渲染器证一下
// （2026-10-07：段落从确认卡片挪到点确认之后的卡片 —— ⭐ 最终口径 = 处理中卡 ＋ 已入账终态卡
//   **都带**（她当天先"两边都放"、又纠正"只放2"、再改口"中间态也要"，原话见
//   test/productInfoGapsCardPlacement.test.js）；下面这几条断言一直用终态卡渲染器钉，
//   与处理中卡那一段不冲突，所以**一个字没改**）。

// 拼接「货品信息」的记录链接要读 Base token。测试里给一个占位值；
// 已配置时不覆盖（CI 或本地 .env 里可能已经有真值）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

// 群聊链路要的两个配置：机器人 open_id（判 @ 用）与采购群 id（发单用）。
// ⚠️ 真值是生产数据，**不写进测试**：这里用明显的测试值，证明代码是"从配置读"
// 而不是"写死了生产那个 open_id"。用赋值而不是 `|| 默认值`：显式赋值才能保证
// "配置为空时会怎样"这类用例被测到——`||` 会把空串当没配而回落成默认值。
const TEST_BOT_OPEN_ID = 'ou_test_bot_open_id';
const TEST_PURCHASE_CHAT_ID = 'oc_test_purchase_chat_id';
process.env.LARK_BOT_OPEN_ID = TEST_BOT_OPEN_ID;
// 主群「是否仍然要求 @」的开关：显式赋值成**空串 = 走默认**（默认放宽，= 新行为）。
// 要测老行为的用例**注入 `mainChatRequireMention: true`**，不靠改这个全局变量。
process.env.GROUP_MAIN_CHAT_REQUIRE_MENTION = '';

const GROUP_CHAT_ID = 'oc_test_group';

// 🔴 2026-10-07「私聊链路移除」：业务负责人拍板 **ⓐ：代码里一行私聊都不留**
//    （见 docs/private-chat-removal-decision-2026-10-07.md）——
//    本文件里原来那一批「拿私聊录单当输入」的历史用例**统一迁到群入口**。
//    下面这个 helper 造的就是**主群 @ 机器人**那条真入口的消息：
//    入口是 `LarkMvpService.acceptMessage` → `resolveMainChatAdmission`（@ 判据）
//    → `salesGroupFlowService.handleGroupSalesMessage` → 建任务 → 走销售链路。
//    断言也跟着改：群入口的回复是「**回到那条消息的话题**」。
const groupSaleEvent = (messageId, text, overrides = {}) => ({
  sender: { sender_id: { open_id: overrides.senderOpenId || 'ou_1' } },
  message: {
    message_id: messageId,
    chat_id: overrides.chatId || GROUP_CHAT_ID,
    chat_type: 'group',
    message_type: overrides.messageType || 'text',
    create_time: overrides.createTime || '1000',
    content: overrides.content || JSON.stringify({ text }),
    mentions: overrides.mentions === undefined
      ? [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }]
      : overrides.mentions,
    thread_id: overrides.threadId,
  },
});

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mvp-test-')), idField: 'task_id' });

const makeService = (options = {}) => {
  const sent = [];
  const service = new LarkMvpService({
    client: options.client || {}, gateway: options.gateway || {}, references: options.references || {}, posting: options.posting || {}, store: options.store || makeStore(),
    // 群聊定位器指向临时目录：**不受**构造时默认的 data/purchase_group_messages 影响。
    purchaseBatchLocator: options.purchaseBatchLocator,
    purchaseBatchLocatorStore: options.purchaseBatchLocatorStore,
    // 销售那侧的「话题 ↔ 销售记录」映射同样指向临时目录：用例之间不共享映射，
    // 也不会往仓库的 server/data/sales_group_threads/ 里写东西。
    salesGroupThreads: options.salesGroupThreads || new SalesGroupThreadLocator({
      store: new JsonTaskStore({
        dir: fs.mkdtempSync(path.join(os.tmpdir(), 'group-sales-thread-')), idField: 'task_id',
      }),
    }), botOpenId: options.botOpenId === undefined ? TEST_BOT_OPEN_ID : options.botOpenId,
    // `undefined` → 走 config/groupAdmission 的默认（放宽）；显式 true/false → 钉死口径。
    mainChatRequireMention: options.mainChatRequireMention,
    groupPurchaseFlow: options.groupPurchaseFlow,
  });
  service.sendText = async (openId, message) => sent.push({ openId, message });
  // 表情/「已收到」这条反馈默认打桩：绝大多数用例只关心"进没进流程"。
  // 专门验证表情的用例会在拿到 service 之后把它解掉（见 `reactionSpyService`）。
  service.acknowledgeMessage = async () => undefined;
  service.processSalesTask = async () => undefined;
  return { service, sent };
};

// 用真实的 acknowledgeMessage + 假的飞书 client：断言的是**真实发生的远端调用**
// （emoji_type 到底传了什么），而不是"我们有没有调用 acknowledgeMessage"。
const makeReactionService = () => {
  const reactions = [];
  const client = {
    im: {
      messageReaction: {
        create: async ({ path, data }) => {
          reactions.push({ messageId: path.message_id, emoji: data.reaction_type.emoji_type });
          return { code: 0 };
        },
      },
    },
  };
  const { service } = makeService({ client });
  service.acknowledgeMessage = LarkMvpService.prototype.acknowledgeMessage;
  return { service, reactions };
};


// 主群准入（2026-10-06 业务负责人拍板：**不再要求 @**）。三条判据任一条就理：
// @ / 正文像销售 / 正文带采购批次号；都不满足 → 静默 + 零远端调用。
// 下面这组用例把「日常聊天绝不触发」这条红线钉死（含"像销售但其实是闲聊"的边界）。
const makeAdmissionSpyService = (options = {}) => {
  // 远端调用一律记账：主群闲聊必须**一个都不发生**。
  const calls = [];
  const client = {
    im: {
      message: { create: async () => { calls.push('message.create'); return { code: 0 }; } },
      messageReaction: { create: async () => { calls.push('reaction.create'); return { code: 0 }; } },
    },
  };
  const gateway = {
    table: () => { calls.push('gateway.table'); return {}; },
    listAll: async () => { calls.push('gateway.listAll'); return []; },
    get: async () => { calls.push('gateway.get'); return null; },
    create: async () => { calls.push('gateway.create'); throw new Error('群聊不该写业务表'); },
    update: async () => { calls.push('gateway.update'); throw new Error('群聊不该写业务表'); },
  };
  let recognized = 0;
  const { service } = makeService({
    ...options, client, gateway,
      });
  return { service, calls, recognized: () => recognized };
};










test('recognized purchase items with same SKU and size are aggregated', () => {
  assert.deepEqual(
    aggregateRecognizedItems([
      { item_no: 'A100', color: '黑', size: 38, quantity: 1 },
      { item_no: 'A100', color: '黑', size: 38, quantity: 2 },
    ]),
    [{ item_no: 'A100', color: '黑', size: 38, quantity: 3 }]
  );
});

test('selling a sample sends a per-order size choice card (提醒本身仍活着；卡片按钮回调已退场)', async () => {
  const store = makeStore();
  const cards = [];
  const promoted = [];
  const delivery = { inventory: {
    sampleReplacementCandidates: async () => [
      { size: 40, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 },
      { size: 41, doorBoxCount: 0, sampleCount: 0, warehouseCount: 1 },
    ],
    promoteToSample: async (input) => { promoted.push(input); return { liveRecordId: 'door_40' }; },
  } };
  const service = new LarkMvpService({ client: {}, store, gateway: { table: () => ({ fields: { number: '编号' } }),
      get: async () => ({ fields: { 编号: 'A100黑' } }) }, references: {}, posting: {}, purchaseWebhooks: {}, delivery });
  service.updateSalesActionCard = async (_task, _event, card) => { cards.push(card); return true; };
  // ⚠️ 这条用例测的是**补样品提醒本身**（不是入口），所以渠道用"群销售那条任务"显式给出来，
  //    发送出口打桩记账 —— 传输层（`reply_in_thread`）由 groupThreadReplyRouting /
  //    salesGroupThread 那几份用例钉住。私聊链路已移除，没有群上下文 = 没有去处。
  service.sendTaskCard = async (_task, card) => { cards.push(card); return 'om_sample_card'; };
  const delivered = { sampleReplacements: [{ salesDetailRecordId: 'detail_1',
    productRecordId: 'product_1', sampleConsumedQuantity: 1 }] };
  const channelTask = { task_id: 'sale_group_sample', type: 'sale', chat_type: 'group',
    chat_id: GROUP_CHAT_ID, message_id: 'om_her_sale', sender_open_id: 'ou_seller',
    sales_entry_record_id: 'entry_1' };
  await service.notifySampleReplacements(delivered, 'ou_seller', { channelTask });
  await service.notifySampleReplacements(delivered, 'ou_seller', { channelTask });
  assert.equal(cards.length, 1);
  assert.match(JSON.stringify(cards[0]), /A100黑/);
  assert.match(JSON.stringify(cards[0]), /40码：门盒 1/);
  assert.ok(!JSON.stringify(cards[0]).includes('选 41 码'));
  // ⛔ 2026-10-28：这一段原先还接着点卡片按钮（`handleCardAction` → 只有收件人能补、重复点幂等）。
  //   卡片按钮回调已随「没有旧卡片」整体删除 ⇒ 那几条断言一起退场。
  //   ⚠️ 本用例**保留**的部分是"补样品提醒本身"（`notifySampleReplacements`）——
  //     它仍然活着（工作台补样品链路会调它），判据一个字没放宽。
  assert.equal(promoted.length, 0, '提醒阶段一个写库动作都不该发生（她还没选门盒）');
});

// ⛔ 2026-10-28：这里原先还有两条**卡片按钮**用例 ——
//   ①「并发选两个尺码只补一双、终态卡回执」②「刷新尺码失败换一张可重试卡」。
//   它们的入口（`LarkMvpService.handleCardAction` → `SampleReplacementService.handleCardAction`）
//   随「没有旧卡片」整体删除 ⇒ 一起退场（补样品**提醒**的用例在上面保留）。

// 销售入口按「实时库存」匹配：一条实时库存记录 = 一双鞋。
// 「库存键」是飞书侧公式（货号|颜色|类别|尺码），「所属状态」是门盒/样品/仓库；
// 「编号」「尺码」是关联，写销售明细时直接用它们，不必再读货品资料。
const liveRow = ({ itemNo, color = '黑', size, state = '门盒', productRecordId, sizeRecordId, recordId }) => ({
  record_id: recordId || `live_${itemNo}_${color}_${size}_${state}`,
  fields: {
    库存键: `${itemNo}|${color}|女鞋|${size}`,
    所属状态: state,
    编号: [{ id: productRecordId }],
    尺码: [{ id: sizeRecordId || `size_${size}` }],
  },
});

const liveInventoryGateway = (rows, { vouchers = [], products = [] } = {}) => ({
  table: (key) => {
    if (key === 'liveInventory') {
      return { tableId: 'tbl_live', fields: { stockKey: '库存键', product: '编号', size: '尺码', state: '所属状态' } };
    }
    if (key === 'groupBuyVoucher') {
      return { tableId: 'tbl_voucher', fields: { name: '券名称', purchasePrice: '售价', faceValue: '面值',
        settlementAmount: '平台结算款', status: '销售状态' } };
    }
    return { fields: { number: '编号' } };
  },
  listAll: async (key) => {
    if (key === 'liveInventory') return rows;
    if (key === 'groupBuyVoucher') return vouchers;
    if (key === 'product') return products;
    return [];
  },
});

// 券目录来自「团购券管理」表（只取在售），测试里给等价的两档。
const VOUCHER_CATALOG = [
  { purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4, name: '100元代金券（89.9元·9折）', status: '在售' },
  { purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4, name: '100元代金券（49.9元·5折）', status: '在售' },
];

// 「团购券管理」表里的一行：售价 89.9 抵 100，平台结算 85.4。
const voucherRow = ({ purchasePrice, faceValue, settlementAmount, status = '在售' }) => ({
  record_id: `voucher_${purchasePrice}`,
  fields: { 券名称: `${faceValue}元代金券`, 售价: purchasePrice, 面值: faceValue,
    平台结算款: settlementAmount, 销售状态: [status] },
});















// 🔴 2026-10-07「私聊链路移除」：原来这里有一条
//    `today sales menu returns only confirmed detail rows from the Shanghai calendar day`
//    —— 它测的是 `sendTodaySales`（机器人菜单「今日销售」，**只有私聊点得到**）。
//    那个方法连同菜单事件 handler 已随私聊入口一起删除，所以这条用例**一并删除**：
//    留着它就只能靠"删掉入口再断言旧行为"来维持，那是自己骗自己。
//    要看今日销售 → 飞书网页工作台「销售查询」（`GET /api/workbench/sales/today`）。

// ─── 颜色从必填变为可选 ───
//
// 用户现在不说颜色：货号能确定唯一颜色就直接用；确定不了就在确认卡片上给候选让用户点。



// ─── 配品的解析：用户说的「分类」优先，其次才是「名称」精确匹配 ───

// 每一行可以是名称字符串（只测名称匹配的老写法），也可以是 { name, category }。
// 「种类」按真实表返回单选数组，与线上读回来的形状一致。
const accessoryService = (accessoryRows, parsedItem) => {
  const store = makeStore();
  const cards = [];
  const service = new LarkMvpService({
    client: {}, gateway: {
      validateTables: async () => [],
      table: (key) => (key === 'accessory'
        ? { tableId: 'tbl_acc', fields: { name: '名称', category: '种类' } }
        : { fields: { number: '编号' } }),
      listAll: async (key) => (key === 'accessory'
        ? accessoryRows.map((entry, index) => {
            const row = typeof entry === 'string' ? { name: entry } : entry;
            return {
              record_id: `acc_${index}`,
              fields: {
                ...(row.name ? { 名称: row.name } : {}),
                ...(row.category ? { 种类: [row.category] } : {}),
              },
            };
          })
        : []),
      create: async () => ({ recordId: 'rec_sales_entry' }),
      update: async () => {},
    }, references: {}, posting: {},
        store,
  });
  // 卡片出口 = **渠道感知**那条（生产同款）：群任务回到那条销售话题。
  service.sendTaskCard = async (task, card) => { cards.push({ messageId: task.message_id, card }); return 'card_reply'; };
  service.sendText = async () => {};
  return { store, cards, service };
};



// 腰带在真实表里有 9 档价位，名称只差一个数字——正好用来验证"多档按金额对"。
const BELT_TIERS = [39, 49, 79, 99, 119, 128, 139, 159, 189];
const beltRows = () => BELT_TIERS.map((price) => ({ name: `${price}元腰带`, category: '腰带' }));









// ─── ⭐ 真机案例（2026-10-07）：各件金额之和 与 她说的总额 对不上 ─────────────────
//
// 她的原话（逐字）：
//   「400 元微信卖了一双 6A637-7，43码（赠了一双袜子，260 元），然后 140 元微信卖了一条 158 元的腰带」
// 她本人的澄清（逐字）：
//   「其实是这笔一共成交 400 元，鞋是 260 元，腰带是 140 元，为什么理解不了呢？」
//
// 这一条钉的是**改前的错法**：整单实收 400 被当成鞋的实收金额、140 又被数成第二笔付款
// ⇒ 各件之和 540 ≠ 总额 400。口径：**对不上就走缺项追问、不入账**，
// 绝不许静默按错数写账（也不许按标价分摊去凑）。

// ─── 入口按「实时库存」匹配：卖的是实物，不是配置 ───


// ─── **类型 = 实时库存里有没有这一双**（2026-10-07 口径大改）───────────────────
// 业务负责人的原话（逐字）：
//   「【类型 = 只看库存】库存里有这双 → 现货（当场交付 + 扣库存）
//     库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）
//     ⭐ 所以：**每次都必须查库存**（这就是判据本身）→ '预定跳过库存检查'那条配置要删」
// 设计落档：docs/sales-type-by-stock-2026-10-07.md（AC-1 / AC-2）
//   解析 A「货品信息」→ 颜色 / 商品记录 id：候选给**全部颜色**
//   解析 B「实时库存」→ 有没有这一双 / 门盒样品：**两种类型都跑**（它就是类型判据）
//   有货 → SALE_CASH（已交付）；没货 → SALE_PREPAID（未交付）
// ⚠️ 「没货」**不再是缺项 / 不再是拦截** —— 它就是「预定」，照出确认卡片。
// ⚠️ 交付 / 扣库存的底层写入口径一个字没动：仍由 SALES_MOVEMENTS.delivery 从类型推。

// 「货品信息」里的一行（解析 A 的输入）。
const productRow = (itemNo, color, recordId) => ({ itemNo, color, recordId });

// 解析 A 走的就是入账时同一个 `resolveProduct`（按货号找颜色），这里给等价实现。
const productInfoResolver = (products) => ({
  resolveProduct: async ({ itemNo, matchMode }) => {
    const same = products.filter((product) => product.itemNo === itemNo);
    if (!same.length) throw new Error(`找不到货品：${itemNo}`);
    if (same.length === 1) {
      return { recordId: same[0].recordId, record: { fields: { 颜色: same[0].color } } };
    }
    // 一个货号多个颜色：不猜，候选交给确认卡片（与实时库存那条候选同形状）。
    return {
      needsColor: true, itemNo,
      options: same.map((product) => ({
        recordId: product.recordId, color: product.color, number: `${itemNo}${product.color}`,
      })),
    };
  },
});
test('团购券目录只认「在售」的券：下架的券不能拿来算结算金额', async () => {
  const store = makeStore();
  const service = new LarkMvpService({ client: {}, gateway: liveInventoryGateway([], {
      vouchers: [
        voucherRow({ purchasePrice: 89.9, faceValue: 100, settlementAmount: 85.4, status: '已下架' }),
        voucherRow({ purchasePrice: 49.9, faceValue: 100, settlementAmount: 47.4, status: '在售' }),
      ],
    }), references: {}, posting: {}, store });
  const vouchers = await service.listGroupBuyVouchers();
  assert.deepEqual(vouchers.map((voucher) => voucher.purchasePrice), [49.9]);
});

test('券表读不到时返回空目录，让券的说法落到"未配置"追问，而不是算一个错的金额', async () => {
  const store = makeStore();
  const service = new LarkMvpService({ client: {}, gateway: {
      table: (key) => (key === 'groupBuyVoucher' ? { tableId: 'tbl_voucher', fields: {} } : {}),
      listAll: async () => { throw new Error('飞书暂时不可用'); },
    }, references: {}, posting: {}, store });
  assert.deepEqual(await service.listGroupBuyVouchers(), []);
});


// ⚠️ 2026-10-07 改写（**只因为"位置变了"，不是放宽**）：她拍板把「补货品信息」段落
//   从确认卡片挪到**点确认之后的卡片**。⭐ 最终口径 = 处理中卡 ＋ 已入账终态卡**都带**
//   （她当天先"两边都放"、又纠正「不是，是只放在2上！」、再改口「中间态也应该有提示」；
//   原话见 `test/productInfoGapsCardPlacement.test.js`）。
//   本用例的**数据断言一字未动**（缺口怎么算、url 怎么拼，全部原样钉着）；
//   只把"确认卡片上看得见这一段"翻成它的反面 —— 而且段落本身的逐字渲染
//   （标题 / 行格式 / note 小字 / 逐字 url / 上限）在
//   `test/productInfoGapsCardPlacement.test.js` 里按同一套标准钉着，覆盖面没有丢。
//   ⚠️ 下面"用终态卡渲染器钉同一句话"这条**本次一个字没改**（终态卡口径从未变过）。


// ⚠️ 2026-10-07 改写（**只因为"位置变了"**）：数据断言（齐备但缺样例图 ⇒ 记成缺口）一字未动，
//   原先把"卡片上看得见 `还差：样例图`"钉在**确认卡片**上；现在那一段挂在**点确认之后的卡片**上
//   （⭐ 最终口径 = 处理中卡 ＋ 已入账终态卡都带；见 placement 测试与
//   `docs/product-info-gaps-card-move-2026-10-07.md` 的口径变更时间线），
//   所以这里改成在同一份 draft 上用**真实的终态卡渲染器 + 那个显式开关**去钉同一句话
//   —— 这条断言**本次一个字没改**（终态卡口径从未变过）。




// ─────────────────────────────────────────────────────────────────────────────
// 群聊链路（B / C）：话题免 @ / 主群 @ + 引用定位 + 剥 @ 占位符 + 收到表情
// ─────────────────────────────────────────────────────────────────────────────

// 群聊定位器指向临时目录，并可选地预置「消息 ↔ 批次」「话题 ↔ 批次」映射
// （生产上由 PurchaseWebhookService 发完采购单后写入，见 purchaseWebhookService.test.js）。
const makeGroupContext = async (options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'group-purchase-locator-'));
  const store = new JsonTaskStore({ dir, idField: 'task_id' });
  const locator = new PurchaseBatchLocator({ store });
  if (options.mappingMessageId || options.mappingThreadId) {
    await locator.rememberGroupMessage({
      batchNo: options.batchNo || 'BH-20261005-0001',
      messageId: options.mappingMessageId || options.mappingThreadId,
      threadId: options.mappingThreadId || '',
      chatId: TEST_PURCHASE_CHAT_ID,
      suppliers: ['金猴'],
      requestIds: ['req_1'],
      detailCount: 2,
    });
  }
  return { store, locator };
};

const groupEvent = (overrides = {}) => ({
  sender: { sender_id: { open_id: 'ou_sender' } },
  message: {
    message_id: overrides.messageId || 'om_group_1',
    chat_id: TEST_PURCHASE_CHAT_ID,
    chat_type: 'group',
    message_type: 'text',
    create_time: '1000',
    content: JSON.stringify({ text: overrides.text || '' }),
    // 默认 @ 了机器人（主群那条路）；传 mention=false 模拟"话题里没 @"。
    mentions: overrides.mentions || [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '测试机器人' }],
    parent_id: overrides.parentId,
    // thread_id 有值 = 话题里的消息（免 @）；不传 = 主群消息（必须 @）。
    thread_id: overrides.threadId,
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 群聊入口已退场（业务负责人 2026-10-12：「清理群聊那个也得做呀」）
//
// 这是**整条群入口的验收哨兵**：群消息（文字 / 图片 / 话题里不 @ / 主群里 @）
// 一律 `{accepted:false, reason:'group_chat_removed'}`，且**零远端调用、零本地副作用**。
// 动手前先写预期（AGENTS.md 协作纪律第 2 条）；判据是"有没有任何调用"，不是"日志说了什么"。
// ═══════════════════════════════════════════════════════════════════════════

/** 记录"有没有发生任何调用"的 service（client / gateway / store / AI / 表情全记）。 */
const makeSpyService = () => {
  const calls = [];
  const spy = (label, value) => async (...args) => { calls.push(label); return value; };
  const service = new LarkMvpService({
    client: {
      im: {
        // ⚠️ 真实路径是 `client.im.message.create`（不带 `v1`）—— 见 `sendText`。
        message: {
          create: spy('im.message.create', { code: 0, data: { message_id: 'om_x' } }),
          reply: spy('im.message.reply', { code: 0, data: { message_id: 'om_x' } }),
          patch: spy('im.message.patch', { code: 0, data: {} }),
        },
        v1: {
          message: {
            create: spy('im.v1.message.create', { code: 0, data: { message_id: 'om_x' } }),
            reply: spy('im.v1.message.reply', { code: 0, data: { message_id: 'om_x' } }),
            patch: spy('im.v1.message.patch', { code: 0, data: {} }),
          },
        },
        messageReaction: { create: spy('im.messageReaction.create', { code: 0, data: {} }) },
      },
    }, gateway: {
      table: () => ({}),
      listAll: spy('gateway.listAll', []),
      get: spy('gateway.get', null),
      create: spy('gateway.create', { recordId: 'rec_x' }),
      update: spy('gateway.update', {}),
    }, references: {}, posting: {}, store: {
      get: spy('store.get', null),
      create: spy('store.create', { task_id: 't' }),
      update: spy('store.update', {}),
      list: spy('store.list', []),
    },
  });
  return { service, calls };
};

test('⭐⭐ 群聊入口已退场：文字 / 图片 / 话题免 @ / 主群 @ → 一律不受理，且零调用', async () => {
  const cases = [
    { name: '话题里（thread_id 有值）不 @', message: { thread_id: 'omt_1', mentions: [] }, text: '你好 小来财' },
    { name: '话题里像销售的一句', message: { thread_id: 'omt_1', mentions: [] }, text: '卖一双 XHB8095 黑 38 码 500' },
    { name: '主群里 @ 了机器人', message: { mentions: [{ key: '@_user_1', id: TEST_BOT_OPEN_ID, name: '机器人' }] }, text: '这批到了' },
    { name: '主群里带采购批次号', message: { mentions: [] }, text: 'BH-20261005-0009 这批到哪了' },
    { name: '群里的图片消息', message: { thread_id: 'omt_1', mentions: [], message_type: 'image' }, text: '' },
  ];
  for (const item of cases) {
    const { service, calls } = makeSpyService();
    const result = await service.acceptMessage({
      sender: { sender_id: { open_id: 'ou_sender' } },
      message: {
        message_id: 'om_group_entry', chat_id: TEST_PURCHASE_CHAT_ID,
        chat_type: 'group', message_type: item.message.message_type || 'text',
        content: JSON.stringify({ text: item.text }), ...item.message,
      },
    });
    assert.deepEqual(result, { accepted: false, reason: 'group_chat_removed' },
      `${item.name}：群消息必须被明确回绝（不是静默成功）`);
    assert.deepEqual(calls, [], `${item.name}：不接受 ⇒ 一个远端/本地调用都不许有（实际：${calls.join(',')}）`);
  }
});

test('⭐⭐ 群入口退场**不影响私聊那条路**：非群消息仍走「私聊已移除」的既有回执', async () => {
  const { service, calls } = makeSpyService();
  const result = await service.acceptMessage({
    sender: { sender_id: { open_id: 'ou_sender' } },
    message: {
      message_id: 'om_p2p', chat_id: 'oc_p2p', chat_type: 'p2p', message_type: 'text',
      content: JSON.stringify({ text: '卖一双 500' }),
    },
  });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'private_chat_removed');
  assert.deepEqual(calls, ['im.message.create'],
    '私聊唯一保留的动作还是那一句 notice（不建任务、不进 AI、不读表、不写表）');
});

test('⭐⭐ 源码哨兵：群入口那条链路的符号**一个都不许回来**', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/services/larkMvpService.js'), 'utf8',
  );
  // ⚠️ 用**代码形态**匹配，不匹配裸词：C3 的注释里会写"原先有 resolveMainChatAdmission"
  //    这类历史说明（注释不产生行为），裸词匹配会被注释误伤（C1 踩过一次）。
  for (const gone of [
    /^ {2}resolveMainChatAdmission\(/m,
    /^ {2}async acceptGroupMessage\(/m,
    /^ {2}async handleGroupSaleMessage\(/m,
    /require\(['"]\.\/salesGroupFlowService['"]\)/,
    /require\(['"]\.\.\/config\/groupAdmission['"]\)/,
    /resolveMainChatRequireMention\(/,
    /this\.botOpenId =/,
  ]) {
    assert.equal(gone.test(source), false, `群入口的符号不该再出现（代码形态）: ${gone}`);
  }
  for (const removedFile of [
    '../src/services/salesGroupFlowService.js', '../src/config/groupAdmission.js',
  ]) {
    assert.equal(fs.existsSync(path.join(__dirname, removedFile)), false,
      `${removedFile} 应已删除（群入口专属件）`);
  }
  // ⭐ 2026-10-28：原来这里是两条「死保项」（`handleSecondDeliveryAction` / `confirmVoucherSettlement`
  //   必须还在）。业务负责人确认「9 点群推送不再需要」「现在没有群聊入口，也没有旧卡片」
  //   ⇒ 两个卡片回调都已删除 ⇒ **翻成反方向**（塞回即红），判据没有放宽。
  assert.equal(/^ {2}(async )?handleSecondDeliveryAction\(/m.test(source), false,
    '二次交付的卡片回调不许复活');
  assert.equal(/confirmVoucherSettlement\s*\(/.test(source), false,
    '团购券「确认到账」不许复活（9 点推送已退场）');
  // ✅ 真正的死保项：工作台那条「二次交付」的实现在 service 里，一行没动。
  const secondDelivery = fs.readFileSync(
    path.join(__dirname, '../src/services/secondDeliveryService.js'), 'utf8',
  );
  assert.match(secondDelivery, /async _confirm\(/, '二次交付（补收款 + 交付）本体必须还在（工作台在用）');
});

