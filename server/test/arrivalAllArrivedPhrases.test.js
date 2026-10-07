/**
 * 「全到」类说法的**等价**与**兜底**回归（2026-10-07 真机 bug）。
 *
 * 【真机现场（业务负责人 2026-10-07 21:52 自己撞到的）】
 *   · 202610072 那个话题里发「**都到了**」   → 模型 `same:true` → 出卡片 → 确认后入库 12 行 ✅
 *   · 202610071 那个话题里发「**都到货了**」 → 模型 `same:false` / `differences:[]`
 *     → 撞上 `purchaseArrivalConversationService` 的 `hasArrivalContent` 判据
 *     → `purchase.arrival.reconcile.no_arrival_content` → **不出卡片** ❌
 *   两句话**意思完全一样**，只多了「货」两个字 ⇒ **说法差异导致的漏判**。
 *
 * 【这个文件钉住什么】
 *   · 正：多种「全到」说法 + 标点/空格/语气词/多条消息的变体 → **一律 `same:true`**；
 *   · 反：句子里有**具体数量 / 货号 / 否定 / 疑问** → **绝不被兜底吞掉**（仍 `same:false`）；
 *   · 兜底**只补漏、不覆盖**模型给出的具体差异；
 *   · 兜底真的能让**真实 service** 出卡片（真机症状本身），而含具体内容的说法仍然不出。
 *
 * ⚠️ 测试栈：
 *   · 解析层用**假 client 打桩真实方法**（`Object.create` 取的是同一个原型）——
 *     不联网、不碰真模型，但跑的是**项目代码本体**；
 *   · 集成那一组把**真实解析层**接进**真实 `PurchaseArrivalConversationService`**，
 *     只把多维表格 / 发送端口换成记录型假实现（写表就抛错 ⇒ "零业务表写入"是断言出来的）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 配置齐了才过 `assertLlmConfigured`；值全是假的，且 client 会被下面的假实现顶掉（零网络请求）。
process.env.TEXT_LLM_API_KEY = process.env.TEXT_LLM_API_KEY || 'test_key';
process.env.TEXT_LLM_BASE_URL = process.env.TEXT_LLM_BASE_URL || 'https://llm.invalid';
process.env.TEXT_LLM_MODEL = process.env.TEXT_LLM_MODEL || 'test-model';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const doubaoService = require('../src/services/doubaoService');
const {
  PurchaseArrivalConversationService,
  taskIdForBatch,
} = require('../src/services/purchaseArrivalConversationService');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const {
  ARRIVAL_ALL_PRESENT_PHRASES,
  ARRIVAL_BATCH_KINDS,
} = require('../src/config/arrivalConversation');
const { detectBareAllArrivedStatement } = require('../src/services/doubaoService');

/** 这一批采购申请的明细（两个尺码，便于验证"只认她说的那一行"）。 */
const ROWS = () => [
  { item_no: 'XHB8095', color: '黑', size: 38, quantity: 2 },
  { item_no: 'XHB8095', color: '黑', size: 39, quantity: 2 },
];

/**
 * 造一个"真的 DoubaoService"，只把**模型客户端**换成假实现：
 * 跑的是仓库里那个类的方法本体（同一份原型），不会 new OpenAI、不会发请求。
 */
const makeRealParser = (content, { calls = [] } = {}) => {
  const service = Object.create(Object.getPrototypeOf(doubaoService));
  service.clients = Object.create(null);
  service.clients.text = {
    chat: {
      completions: {
        create: async (payload) => {
          calls.push(payload);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  return service;
};

/** 真机那次模型的形状：什么内容都没给出来。 */
const MODEL_GAVE_NOTHING = JSON.stringify({ complete: false, same: false, differences: [] });

// ═══════════════════════════════════════════════════════════════════════════
// □ AC-3 正：多种「全到」说法 + 变体 → 一律 same:true（真机那句必须在）
// ═══════════════════════════════════════════════════════════════════════════

/** 业务负责人会说 / 已经说过的「全到」说法（**这条清单就是验收标准 AC-3 的落地**）。 */
const ALL_PRESENT_PHRASES = [
  '都到了',       // ⭐ 真机 202610072：模型认出来了（既有行为，钉住别回退）
  '都到货了',     // ⭐ 真机 202610071：本次要修的漏判
  '全部到货',
  '都到齐了',
  '都齐了',
  '全到了',
  '都收到了',
  '全部到齐',
  '齐了',
  '全都到了',
  '到齐了',
  '全齐了',       // 「别只做这几个」：同族的另一种说法
  '都收齐了',
  '都到了啦',     // 带语气词
  '都到货了。',   // 带标点
  '都 到 货 了',  // 带空格
];

test('AC-3 正①：16 种「全到」说法（含真机那两句）模型什么都没给出来时 → 一律 same:true', async () => {
  for (const phrase of ALL_PRESENT_PHRASES) {
    const service = makeRealParser(MODEL_GAVE_NOTHING);
    const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: [phrase] });
    assert.equal(result.same, true, `「${phrase}」必须解析成"全部到齐"：${JSON.stringify(result)}`);
    assert.deepEqual(result.differences, [], `「${phrase}」是"全到"，不许编出差异：${JSON.stringify(result)}`);
    assert.equal(result.complete, true, `「${phrase}」是一句说得清的话：${JSON.stringify(result)}`);
  }
});

test('AC-3 正②（真机原句单钉）：「都到货了」→ same:true（本次新增的那条）', async () => {
  const service = makeRealParser(MODEL_GAVE_NOTHING);
  const result = await service.parseArrivalReconciliation({
    rows: ROWS(), messages: ['都到货了'], taskId: 'arrival_reconcile_real_machine',
  });
  assert.deepEqual(result, { complete: true, same: true, differences: [] });
});

test('AC-3 正③：话题里先有闲聊、再发「都到货了」→ 最新一句是"全到"也算（真机话题里的形状）', async () => {
  const service = makeRealParser(MODEL_GAVE_NOTHING);
  const result = await service.parseArrivalReconciliation({
    rows: ROWS(), messages: ['你好 小来财', '都到货了'],
  });
  assert.equal(result.same, true, '话题里前面那句闲聊不该把后面的「都到货了」顶掉');
  assert.deepEqual(result.differences, []);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 🔴 AC-4 反：有具体数量 / 货号 / 否定 / 疑问 → 兜底**绝不允许**生效
// ═══════════════════════════════════════════════════════════════════════════

/** 逐条钉住的"不许被吞"（业务负责人任务书里点名的那三条在最前面）。 */
const MUST_NOT_BE_ALL_PRESENT = [
  '到了 2 双',
  '8230 到了 1 双',
  '还有一双没到',
  '有一双没到',
  '38 码少一双',
  '39 码到了 4 双',
  '没到',
  '都到了吗',
  '都到货了吗？',
  '都到了，XHB8095 差一双',
  '嗯，我看看',
  '你好',
];

test('AC-4 反①：有具体内容的说法**不许**被判成 same:true（逐条钉住）', async () => {
  for (const phrase of MUST_NOT_BE_ALL_PRESENT) {
    const service = makeRealParser(MODEL_GAVE_NOTHING);
    const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: [phrase] });
    assert.equal(result.same, false, `「${phrase}」不许被兜底吞成"全部到齐"：${JSON.stringify(result)}`);
    assert.deepEqual(result.differences, [], `「${phrase}」没解析出差异是模型的事，兜底不许编：${JSON.stringify(result)}`);
    assert.equal(result.complete, false, `「${phrase}」不许被兜底改成 complete:true`);
  }
});

test('AC-4 反②：多条消息里夹着具体内容时，最新一句是「都到货了」也**不许**兜底', async () => {
  const service = makeRealParser(MODEL_GAVE_NOTHING);
  const result = await service.parseArrivalReconciliation({
    rows: ROWS(), messages: ['39 码多一双', '都到货了'],
  });
  assert.equal(result.same, false, '前面那句是具体差异：模型没解析出来时必须让她重说，绝不能按申请数整单入库');
  assert.equal(result.complete, false);
});

test('AC-4 反③：兜底不生效的**原因**可查（日志/排查口径）', () => {
  const reasonOf = (text) => detectBareAllArrivedStatement(text, ARRIVAL_ALL_PRESENT_PHRASES);
  assert.equal(reasonOf('都到货了').matched, true);
  assert.equal(reasonOf('都到货了').reason, 'bare_all_arrived');
  assert.equal(reasonOf('到了 2 双').reason, 'concrete_content');
  assert.equal(reasonOf('8230 到了 1 双').reason, 'concrete_content');
  assert.equal(reasonOf('还有一双没到').reason, 'negation');
  assert.equal(reasonOf('都到了吗').reason, 'question');
  assert.equal(reasonOf('嗯，我看看').reason, 'out_of_vocabulary');
  assert.equal(reasonOf('到了').reason, 'no_complete_word', '光说「到了」不是"全到"（可能只说了一件）');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ AC-5：兜底**只补漏、不覆盖**模型给出的具体结论
// ═══════════════════════════════════════════════════════════════════════════

test('AC-5 ①：模型给出了具体差异 → 一条都不许被兜底清掉', async () => {
  const service = makeRealParser(JSON.stringify({
    complete: true,
    same: false,
    differences: [{ item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 }],
  }));
  const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['都到货了'] });
  assert.equal(result.same, false, '模型认出了具体差异 → 兜底不许把它改成"全到"');
  assert.deepEqual(result.differences, [
    { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
  ]);
});

test('AC-5 ②：模型自己说了 same:true → 行为与改动前一模一样', async () => {
  const service = makeRealParser('```json\n{"complete":true,"same":true,"differences":[]}\n```');
  const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['都到了，完毕'] });
  assert.deepEqual(result, { complete: true, same: true, differences: [] });
});

// ═══════════════════════════════════════════════════════════════════════════
// □ AC-7：配置先行（词组清单在 config/，换清单不改代码）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7 ①：词组清单在 config/arrivalConversation.js，且注释写明"为了兜住模型的漏判"', () => {
  assert.ok(ARRIVAL_ALL_PRESENT_PHRASES, '清单必须从 config 导出（配置先行）');
  for (const key of ['completeWords', 'arrivalWords', 'fillerWords', 'negationWords', 'questionMarkers', 'numberWords', 'quantityUnitWords']) {
    assert.ok(Array.isArray(ARRIVAL_ALL_PRESENT_PHRASES[key]) && ARRIVAL_ALL_PRESENT_PHRASES[key].length,
      `config 的 ${key} 必须是非空数组`);
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/config/arrivalConversation.js'), 'utf8');
  assert.match(source, /兜住模型的漏判/, '注释里要写明这层是干什么的（不然下一个人会以为它是"关键词匹配"）');
  assert.match(source, /绝不放宽/);
});

test('AC-7 ②：换一份清单（不 hack 代码）就能识别新说法 —— 纯函数按注入的清单工作', () => {
  const extended = {
    ...ARRIVAL_ALL_PRESENT_PHRASES,
    completeWords: [...ARRIVAL_ALL_PRESENT_PHRASES.completeWords, '满'],
    arrivalWords: [...ARRIVAL_ALL_PRESENT_PHRASES.arrivalWords, '进了'],
  };
  assert.equal(detectBareAllArrivedStatement('满进了', ARRIVAL_ALL_PRESENT_PHRASES).matched, false);
  assert.equal(detectBareAllArrivedStatement('满进了', extended).matched, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ AC-1：提示词层也把「全到」的多种说法写成等价（两层都要有）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-1：提示词列出「全到」的多种说法，并说明"多了到货/齐/收到这些字眼不算差异"', async () => {
  const calls = [];
  const service = makeRealParser(MODEL_GAVE_NOTHING, { calls });
  await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['都到货了'] });
  const prompt = calls[0]?.messages?.[0]?.content || '';

  for (const phrase of ['都到货了', '全部到货', '都到齐了', '都齐了', '全到了', '都收到了', '全部到齐', '齐了']) {
    assert.ok(prompt.includes(phrase), `提示词里必须逐字列出「${phrase}」`);
  }
  assert.match(prompt, /同一个意思（整批全到）/, '要说清它们是同一个意思，不许因为多了两个字就换一类');
  assert.match(prompt, /不算差异/, '要说清"多了『到货 / 齐 / 收到』这些字眼不算差异"');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ AC-8：真机症状本身 —— 真实解析层 + 真实 service：「都到货了」出卡片
// ═══════════════════════════════════════════════════════════════════════════

const BATCH_NO = 'BH-20261007-0001';
const BATCH_RECORD_ID = 'batch_1';
const PRODUCT_1 = 'prod_1';

const requestTable = () => V1_BITABLE_SCHEMA.tables.purchaseRequest;
const productTable = () => V1_BITABLE_SCHEMA.tables.product;

const defaultRecords = () => ({
  purchaseRequest: [
    { record_id: 'req_38', fields: { [requestTable().fields.batchNo]: [BATCH_RECORD_ID], [requestTable().fields.product]: [PRODUCT_1], [requestTable().fields.size]: ['size_38'], [requestTable().fields.quantity]: 2 } },
    { record_id: 'req_39', fields: { [requestTable().fields.batchNo]: [BATCH_RECORD_ID], [requestTable().fields.product]: [PRODUCT_1], [requestTable().fields.size]: ['size_39'], [requestTable().fields.quantity]: 2 } },
  ],
  product: [{ record_id: PRODUCT_1, fields: { [productTable().fields.itemNo]: 'XHB8095', [productTable().fields.color]: '黑' } }],
});

/**
 * 真 service 的集成夹具：
 *   · gateway **写就抛错** —— "零业务表写入"是断言出来的，不是靠"我没看见"；
 *   · recognizer = **真实解析层**（假 client 供模型回复）；
 *   · replyCard / replyText 记录到底发了什么。
 */
const makeServiceHarness = (modelContent) => {
  const records = defaultRecords();
  const written = [];
  const gateway = {
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    get: async (tableKey, recordId) => (records[tableKey] || []).find((item) => item.record_id === recordId) || null,
    listAll: async (tableKey) => records[tableKey] || [],
    create: async (tableKey) => { written.push({ op: 'create', tableKey }); throw new Error('本用例不该写表'); },
    update: async (tableKey) => { written.push({ op: 'update', tableKey }); throw new Error('本用例不该写表'); },
    delete: async (tableKey) => { written.push({ op: 'delete', tableKey }); throw new Error('本用例不该写表'); },
  };
  const store = new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'arrival-all-present-')), idField: 'task_id' });
  const cards = [];
  const replied = [];
  const service = new PurchaseArrivalConversationService({
    gateway,
    store,
    recognizer: makeRealParser(modelContent),
    // ⚠️ 这个依赖的**形状是"取尺码解析器的函数"**（`webhook.getSizeReferences` 就是个函数），
    //    不是解析器本身 —— 传错了会在读明细那一步静默变成 `request_row_without_size`。
    sizeReferences: () => ({
      async resolveLinkedCell(cell) {
        const first = Array.isArray(cell) ? cell[0] : cell;
        const raw = typeof first === 'string' ? first : String(first?.record_id || first?.text || '');
        const size = Number(raw.replace('size_', ''));
        return Number.isSafeInteger(size) && size > 0 ? { size } : null;
      },
    }),
    replyText: async (messageId, content, options) => { replied.push({ messageId, content, options }); return 'om_reply'; },
    replyCard: async (messageId, card, options) => { cards.push({ messageId, card, options }); return `om_card_${cards.length}`; },
    updateCard: async () => true,
  });
  return { service, store, cards, replied, written };
};

const BATCH = {
  batch_no: BATCH_NO,
  batch_kind: ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
  request_ids: ['req_38', 'req_39'],
  chat_id: 'oc_test_group',
};

test('AC-8 ①（真机症状）：「都到货了」→ 出卡片（改动前：no_arrival_content、一张卡片都没有）', async () => {
  const harness = makeServiceHarness(MODEL_GAVE_NOTHING);
  const result = await harness.service.handleTopicMessage({
    batch: BATCH, text: '都到货了', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.card, true, '「都到货了」必须出卡片');
  assert.equal(harness.cards.length, 1);
  assert.equal(harness.cards[0].options.threadId, 'omt_1', '卡片要回到她说话的那个话题');
  // 计划 = 按申请数（"全部到齐"的含义）——与「都到了」逐字同一条路径。
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.equal(task.status, 'awaiting_confirmation');
  assert.deepEqual(task.plan.map((row) => [row.size, row.quantity, row.actual]), [[38, 2, 2], [39, 2, 2]]);
  assert.deepEqual(harness.written, [], '出卡片不是写表：零业务表写入');
});

test('AC-8 ②（红线对照）：含具体内容的「还有一双没到」→ 仍然不出卡片、零写入', async () => {
  const harness = makeServiceHarness(MODEL_GAVE_NOTHING);
  const result = await harness.service.handleTopicMessage({
    batch: BATCH, text: '还有一双没到', messageId: 'om_1', threadId: 'omt_1', senderOpenId: 'ou_1',
  });

  assert.equal(result.reason, 'no_arrival_content', '兜底**不许**把"还有一双没到"吞成"全部到齐"');
  assert.equal(harness.cards.length, 0, '没有到货内容就不许发卡片');
  assert.deepEqual(harness.written, []);
  const task = await harness.store.get(taskIdForBatch(BATCH_NO));
  assert.ok(!task.plan, '不许替她算出一份"全部到货"的计划');
});
