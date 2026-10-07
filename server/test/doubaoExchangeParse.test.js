// 「换货」解析层的回归：**两种换货**（换尺码 / 换另一双）在提示词里说清，
// 并且解析结果里**绝不混进销售字段**。
//
// 为什么单独一个文件：这一批用例测的是
//   ① 提示词第 13 条**逐字**写明了两种换货的字段契约（模型唯一能看到的规则）；
//   ② 规范化（normalizeSalesResult → normalizeAfterSalesResult）对换货字段的收敛。
// 两者都不需要读写任何表、也不发任何网络请求。
//
// 真机事实（2026-10-07 23:06，业务负责人原话）：
//   「6C98012-15L 换成41码」
//   ⇒ 解析逐字：intent="exchange" · action="" · new_item_no="" · new_color="" · new_size=""
//      · items=[{item_no:"6C98012-15L", size:""}]   ← 货号被填进了【销售字段 items】
//   根因：提示词里"换给她的那一双"只讲了 `new_*` 是"换给/赔给她的那一双"，
//        没有写明"她说『换成 41 码』就是**换尺码**，不是没说要换哪双"，
//        模型于是把它当成了"要换的那一双"塞进 items，new_size 留空 ——
//        接线层（afterSalesFlowService.resolveOutgoing）随即问「换成哪一双？」，
//        **同款换码这条路被拦死**（业务负责人：「1. 换尺码  2. 换另一双鞋」）。

const test = require('node:test');
const assert = require('node:assert/strict');

const doubaoService = require('../src/services/doubaoService');

// 配置齐了才过 `assertLlmConfigured`；值全是假的，且 `getClient` 会被下面的假 client 顶掉，
// 所以**一次网络请求都不会发**（CI 上没有模型可调）。
process.env.TEXT_LLM_API_KEY = process.env.TEXT_LLM_API_KEY || 'test_key';
process.env.TEXT_LLM_BASE_URL = process.env.TEXT_LLM_BASE_URL || 'https://llm.invalid';
process.env.TEXT_LLM_MODEL = process.env.TEXT_LLM_MODEL || 'test-model';

/**
 * 造一个"真的 DoubaoService"，只把**模型客户端**换成假实现：
 *   · 原型是仓库里那个类 → 跑的是真实方法（有未定义变量就会当场 ReferenceError）；
 *   · `clients.text` 预置好 → `getClient()` 直接返回它，不会 new OpenAI、不会发请求。
 */
const makeService = (content, { calls = [] } = {}) => {
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

const promptOf = (calls) => calls[0]?.messages?.[0]?.content || '';

// ═══════════════════════════════════════════════════════════════════════════
// 甲：提示词第 13 条 —— 两种换货 + 逐字例子 + 不许把货号填进 items
// ═══════════════════════════════════════════════════════════════════════════

test('提示词第 13 条：逐字写明"换尺码（同款换码）"与"换另一双"两条规则', async () => {
  const calls = [];
  const service = makeService(JSON.stringify({ intent: 'exchange', action: 'exchange' }), { calls });

  await service.parseSalesText('6C98012-15L 换成41码', { taskId: 't_exchange_prompt' });

  const prompt = promptOf(calls);
  // ① 两种换货都要有名字（模型按名字分派）
  assert.ok(prompt.includes('换尺码（同款换码）'), '提示词要逐字写出「换尺码（同款换码）」这一种');
  assert.ok(prompt.includes('换另一双'), '提示词要逐字写出「换另一双」这一种');
  // ② 换尺码：new_item_no 可留空、new_size 必填
  assert.ok(prompt.includes('可以留空'), '要说清换尺码时 new_item_no 可以留空');
  assert.ok(prompt.includes('必须填 new_size'), '要说清换尺码时**必须**填 new_size');
  // ③ 真机那句的判据：她说「换成 41 码」＝换尺码，**不是**"没说要换哪双"
  assert.ok(prompt.includes('就是换尺码'), '要说清「她说『换成 41 码』就是换尺码」');
  assert.ok(prompt.includes('不是') && prompt.includes('没说要换哪双'),
    '要说清这**不是**"没说要换哪双"（这正是真机那次模型留空 new_size 的原因）');
  // ④ 两个逐字例子：她真机那句 + 一个"换另一双"
  assert.ok(prompt.includes('6C98012-15L 换成41码'), '要有她真机那句的逐字例子');
  assert.ok(prompt.includes('6035 黑 38 换成 1366-33 黑 40'), '要有一个"换另一双"的逐字例子');
  // ⑤ 重申：return / exchange 不许把货号填进 items（销售字段）
  assert.ok(prompt.includes('不许把货号填进 items'), '要重申：售后不许把货号填进销售字段 items');
});

// ═══════════════════════════════════════════════════════════════════════════
// ① 真机那句：new_size 有值 + ③ 守门：售后结果里没有销售字段 items
// ═══════════════════════════════════════════════════════════════════════════

test('真机那句「6C98012-15L 换成41码」：new_size=41，且规范化结果里没有销售字段 items', () => {
  const normalized = doubaoService.normalizeSalesResult({
    intent: 'exchange', action: 'exchange', item_no: '6C98012-15L', new_size: 41,
  }, '6C98012-15L 换成41码');

  assert.equal(normalized.intent, 'exchange');
  assert.equal(normalized.action, 'exchange');
  assert.equal(normalized.item_no, '6C98012-15L', 'item_no = 要换的那一双（原那双）');
  assert.equal(normalized.new_size, 41, 'new_size = 换给她的那一双的尺码');
  assert.equal(normalized.new_item_no, '', '同款换码允许留空（接线层按"原那双"处理）');
  assert.equal('items' in normalized, false, '守门：售后规范化结果里不许有销售字段 items');
  assert.equal('payments' in normalized, false);
  assert.equal('agreed_total' in normalized, false);
});

test('③ 守门：模型把货号塞进销售字段 items 时，规范化结果里也不许出现 items', () => {
  // 这正是真机那次的模型输出形状（货号被填进了 items）——
  // 规范化必须按意图分流，销售字段一个都不许漏进售后结果。
  const normalized = doubaoService.normalizeSalesResult({
    intent: 'exchange',
    action: 'exchange',
    items: [{ item_no: '6C98012-15L', size: '' }],
    new_size: 41,
  }, '6C98012-15L 换成41码');

  assert.equal(normalized.item_no, '6C98012-15L', '货号仍然认得出（从 items[0] 兜底读出）');
  assert.equal(normalized.new_size, 41);
  assert.equal('items' in normalized, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 换另一双：new_item_no / new_color / new_size 各就各位
// ═══════════════════════════════════════════════════════════════════════════

test('② 换另一双「把 6035 黑 38 换成 1366-33 黑 40」：三个 new_* 字段都对', () => {
  const normalized = doubaoService.normalizeSalesResult({
    intent: 'exchange', action: 'exchange',
    item_no: '6035', color: '黑', size: 38,
    new_item_no: '1366-33', new_color: '黑', new_size: 40, new_amount: 300,
    settlement: '微信',
  }, '把 6035 黑 38 换成 1366-33 黑 40，退我微信');

  assert.equal(normalized.item_no, '6035');
  assert.equal(normalized.color, '黑');
  assert.equal(normalized.size, 38);
  assert.equal(normalized.new_item_no, '1366-33');
  assert.equal(normalized.new_color, '黑');
  assert.equal(normalized.new_size, 40);
  assert.equal(normalized.new_amount, 300);
  assert.equal(normalized.settlement, 'cash');
  assert.equal('items' in normalized, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 排查用：`sales.ai.parsed` / `sales.ai.normalized` 要看得见 new_size
//   （真机那次日志里**只有 new_item_no**，"new_size 到底空没空"只能靠猜）
// ═══════════════════════════════════════════════════════════════════════════

test('排查日志带上 new_color / new_size / new_amount（下次真机不用猜）', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(JSON.parse(line));
  try {
    const service = makeService(JSON.stringify({
      intent: 'exchange', action: 'exchange', item_no: '6C98012-15L', new_size: 41,
    }), { calls: [] });
    await service.parseSalesText('6C98012-15L 换成41码', { taskId: 't_exchange_log' });
  } finally {
    console.log = originalLog;
  }

  const parsed = logs.find((entry) => entry.event === 'sales.ai.parsed');
  const normalized = logs.find((entry) => entry.event === 'sales.ai.normalized');
  assert.equal(parsed.new_size, 41, '模型给的 new_size 必须出现在解析日志里');
  assert.equal(parsed.new_item_no, '', '同款换码：new_item_no 就是空的（真机那次也能看到）');
  assert.equal(normalized.new_size, 41, '规范化之后的 new_size 同样要看得见');
});
