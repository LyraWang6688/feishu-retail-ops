// 「销售信息还缺…」追问文案的守卫用例（2026-10-07 真机事故的回归）。
//
// 事故（业务负责人 18:38 收到的，逐字；她只回了一句「**这个提醒是什么意思？**」）：
//   「销售信息还缺：定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额、
//     items[0].actual_amount、items[1].actual_amount、payments[0].method、请逐件说明成交金额、
//     已收金额和待平台结算金额不能超过本单成交金额。请补充后重新发送完整销售信息。」
// 她的输入（一条消息两笔）：
//   「119 元，微信。 / 卖了 31678，40 码。 / 定制一双 6681-1，42 码，定金 50 元，下次付 39 元」
//
// 本文件钉四件事：
//   ① **绝不许**出现代码标识符形状（`items[0].actual_amount` / `payments[0].method` / 下划线字段名）；
//   ② **一次只说一件事**（一件事一行，行内不再用「；」把几句串起来）；
//   ③ 每条缺项都给**具体动作**（逐字断言，如「分开发送」）；
//   ④ **判据一个字没动**（`missing_fields` 逐字不变、仍然 `needs_info`、仍然不发卡片、仍然不入账）。
//
// ⚠️ 上面那条"她的输入 → 解析结果"的 fixture 是**从她真机收到的那条回复逐条反推**出来的
//    （六条缺项一一对得上，见 `docs/sales-missing-info-wording-2026-10-07.md` 第 3 节），
//    不是随手编的业务数据；它只用于**文案回归**，不代表任何生产口径。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { normalizeSalesResult } = require('../src/services/doubaoService');
const {
  KEYS,
  SALES_MISSING_INFO_DEFAULTS,
  SALES_MISSING_INFO_DEFAULTS_BY_KEY,
  resolveSalesMissingInfoConfig,
  renderSalesMissingInfo,
  formatItemLabel,
} = require('../src/config/salesMissingInfoText');

// 群里那条回复要走群上下文（私聊入口已移除）。
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
const GROUP_CHAT_ID = 'oc_missing_info_test';

// 🔴 「代码标识符形状」——她这次撞到的就是它。文案里出现这种形状就**失败**。
//    含：`items[0]…` / `payments[0]…` / 下划线小写字段名（`actual_amount`、`item_no`…）。
const CODE_IDENTIFIER_PATTERN = /items\[\d+\]|payments\[\d+\]|_[a-z]+/;
// 🔴 内部说法（她说的是"一双鞋 / 一件货"）。
const INTERNAL_WORD_PATTERN = /明细/;
// 🔴 "一句话里用「；」把几件事串起来"——本次要治的"堆成一段"。
const CHAINED_CLAUSE_PATTERN = /；/;

// ── 她那一条的真实形状（逐字）────────────────────────────────────────────────
const HER_TEXT = '119 元，微信。\n卖了 31678，40 码。\n定制一双 6681-1，42 码，定金 50 元，下次付 39 元';
const HER_PARSED = () => normalizeSalesResult({
  intent: 'sale',
  trade_type: '预付',
  items: [
    { item_no: '31678', size: 40, quantity: 1 },
    { item_no: '6681-1', size: 42, quantity: 1 },
  ],
  // 「119 元，微信」被模型当成一笔独立收款；定金 50 那一笔**没说方式** ⇒ 解析层把它挑成唯一一笔。
  payments: [{ amount: 119, method: '微信' }, { amount: 50, method: '' }],
  agreed_total: '',
}, HER_TEXT);

// 解析层给的那 4 条（**机器清单，改动前后逐字相同**）。
const HER_PARSED_MISSING_FIELDS = [
  '定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额',
  'items[0].actual_amount',
  'items[1].actual_amount',
  'payments[0].method',
];
// 接线层再追加 2 条（`processSalesTask`：缺金额泛化句 + 已收超过成交金额）。
const HER_ALL_MISSING_FIELDS = [
  ...HER_PARSED_MISSING_FIELDS,
  '请逐件说明成交金额',
  '已收金额和待平台结算金额不能超过本单成交金额',
];
const HER_ITEMS = [{ item_no: '31678', size: 40, quantity: 1 }, { item_no: '6681-1', size: 42, quantity: 1 }];

// 改完之后她**应该**看到的那段（逐字）。改文案 = 先改这里，再看测试是不是"红"。
const HER_EXPECTED_TEXT = [
  '销售信息还缺 4 处，请照着补一下～',
  '1. 带定金的单一次只能记一双，请把这两双分开发送～',
  '（例如第一条只说「31678 40码」，第二条只说「6681-1 42码」的定金）',
  '2. 请给每双鞋都说一个成交金额：31678 40码、6681-1 42码',
  '3. 收的那笔钱没说收款方式，请补一句是微信、现金还是支付宝～',
  '4. 已收的钱比这单成交金额还多，请核对一下收了多少～',
].join('\n');

const renderHer = (missingFields = HER_ALL_MISSING_FIELDS, items = HER_ITEMS) =>
  renderSalesMissingInfo({ missingFields, items, payments: [{ amount: 50, method: '' }] });

// ── ① 形状：她的场景 ─────────────────────────────────────────────────────────
test('① 她那条的回复不含任何代码标识符形状（items[..] / payments[..] / 下划线字段名）', () => {
  const { text } = renderHer();
  assert.doesNotMatch(text, CODE_IDENTIFIER_PATTERN, `文案里漏了代码标识符：\n${text}`);
  // 改动前那一句里的三个"元凶"逐个点名，防止将来又被拼回来。
  for (const leak of ['items[0]', 'items[1]', 'payments[0]', 'actual_amount', 'method']) {
    assert.ok(!text.includes(leak), `文案里不该出现「${leak}」：\n${text}`);
  }
});

test('① 她那条的回复 ≠ 改动前那串"、"拼接（防止回退）', () => {
  const oldText = `销售信息还缺：${HER_ALL_MISSING_FIELDS.join('、')}。请补充后重新发送完整销售信息。`;
  const { text } = renderHer();
  assert.notEqual(text, oldText);
  // 改动前那句确实含标识符 —— 证明这条断言不是空转。
  assert.match(oldText, CODE_IDENTIFIER_PATTERN);
});

// ── ② 结构：一件事一行 ───────────────────────────────────────────────────────
test('② 一次只说一件事：分行 + 行内不再用「；」串起来', () => {
  const { text, lines, intro } = renderHer();
  assert.equal(text, HER_EXPECTED_TEXT);
  assert.equal(intro, '销售信息还缺 4 处，请照着补一下～');
  assert.equal(lines.length, 4, '6 条缺项收成 4 件事（同类合并）');
  assert.doesNotMatch(text, CHAINED_CLAUSE_PATTERN, `文案里还有「；」串句：\n${text}`);
  // 结构：第一行是汇总，后面每件事一个编号行（多行的那件事只占一个编号）。
  const numbered = text.split('\n').filter((line) => /^\d+\. /.test(line));
  assert.equal(numbered.length, 4, `编号行数应为 4：\n${text}`);
  numbered.forEach((line, index) => {
    assert.ok(line.startsWith(`${index + 1}. `), `编号应连续递增：${line}`);
  });
  // 每一件事都必须能独立成行（没有"半个句子"漂在编号外面）。
  const continuation = text.split('\n').filter((line) => !/^\d+\. /.test(line));
  assert.deepEqual(continuation, ['销售信息还缺 4 处，请照着补一下～',
    '（例如第一条只说「31678 40码」，第二条只说「6681-1 42码」的定金）']);
});

// ── ③ 具体动作 ───────────────────────────────────────────────────────────────
test('③ 每条缺项都给具体动作（逐字）', () => {
  const { text } = renderHer();
  // 定金单那条：**分开发送** + 当场给例子（两个货号都点出来）。
  assert.match(text, /带定金的单一次只能记一双，请把这两双分开发送/);
  assert.ok(text.includes('31678') && text.includes('6681-1'), '例子要点出两个货号');
  // 缺金额：说清"每双各一个成交金额"，并把两双都列出来。
  assert.match(text, /请给每双鞋都说一个成交金额：31678 40码、6681-1 42码/);
  // 缺收款方式：给可选值（她自己会说到方式 —— AGENTS.md 第 16 条，所以这里只是问，不设默认）。
  assert.match(text, /没说收款方式，请补一句是微信、现金还是支付宝/);
  // 改动前那句"笼统"的结尾**不该**再出现。
  assert.ok(!text.includes('请补充后重新发送完整销售信息'));
});

test('④「定金单」那条用她的话（一双 / 一件货），不说「明细」', () => {
  const { text } = renderHer();
  assert.doesNotMatch(text, INTERNAL_WORD_PATTERN, `文案里还有内部说法：\n${text}`);
  assert.match(text, /一次只能记一双/);
});

// ── ④ 判据没变（端到端：走真实的 processSalesTask）───────────────────────────
const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'missing-info-test-')), idField: 'task_id' });

const runHerTask = async () => {
  const store = makeStore();
  const messages = [];
  const cards = [];
  const calls = [];
  const parsed = HER_PARSED();
  const service = new LarkMvpService({
    client: {},
    gateway: {
      table: () => ({ tableId: 'tbl_sales_entry', fields: {} }),
      listAll: async () => [],
      get: async () => null,
      validateTables: async () => [],
      create: async (tableKey, fields) => { calls.push({ op: 'create', tableKey, fields }); return { recordId: 'entry_her' }; },
      update: async (tableKey, recordId, fields) => { calls.push({ op: 'update', tableKey, recordId, fields }); },
    },
    references: {}, posting: {},
    recognizer: { parseSalesText: async () => parsed },
    store,
  });
  // 「缺项时就该在发卡片之前返回」——真的走到发卡片 / 入账就直接炸。
  service.sendTaskCard = async () => { cards.push('card'); throw new Error('缺项时不该发确认卡片'); };
  service.sendTaskText = async (_task, message) => { messages.push(message); };
  service.replyCard = async () => { throw new Error('不该走 replyCard'); };

  await store.create({
    task_id: 'sale_missing_info_her', type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: 'om_her',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: HER_TEXT,
  });
  await service.processSalesTask('sale_missing_info_her');
  const task = await store.get('sale_missing_info_her');
  return { task, messages, cards, calls };
};

test('④ 判据没变：她的输入仍然 needs_info、仍然不回卡片、仍然不入账', async () => {
  const { task, messages, cards, calls } = await runHerTask();
  assert.equal(task.status, 'needs_info');
  assert.deepEqual(cards, [], '缺项时不该发确认卡片');
  // 写库只有两笔：建销售记录 + 回填解析元数据（都是 salesEntry）——
  // 不许出现明细 / 收款 / 库存 的写入（即"没入账"）。
  assert.deepEqual(calls.map((call) => `${call.op}:${call.tableKey}`),
    ['create:salesEntry', 'update:salesEntry'],
    `不该有别的写入：${JSON.stringify(calls)}`);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], HER_EXPECTED_TEXT);
});

test('④ 判据没变：draft.missing_fields 与改动前**逐字相同**（机器契约一个字没动）', async () => {
  const { task } = await runHerTask();
  assert.deepEqual(task.draft.missing_fields, HER_ALL_MISSING_FIELDS);
});

test('④ 表里的「解析失败原因」也不漏代码标识符（同一份渲染器）', async () => {
  const { calls } = await runHerTask();
  const meta = calls.find((call) => call.op === 'update' && call.fields?.failureReason !== undefined);
  assert.ok(meta, '应当回填过解析失败原因');
  assert.doesNotMatch(String(meta.fields.failureReason), CODE_IDENTIFIER_PATTERN);
  assert.doesNotMatch(String(meta.fields.failureReason), INTERNAL_WORD_PATTERN);
  assert.doesNotMatch(String(meta.fields.failureReason), CHAINED_CLAUSE_PATTERN);
  // ⚠️ `解析结果摘要`（JSON）**仍是机器清单** —— 排查时要看得到原值，这里是有意保留的。
  assert.match(String(meta.fields.parseSummary), /items\[0\]\.actual_amount/);
});

// ── ⑤ 全形状守卫：仓库里**所有**缺项形状都不许漏标识符 / 「；」/「明细」──────────
// 清单来自各生产者的原话（`grep -n "missing.add(\|missingFields.push(\|issues.push(" src/`），
// ⚠️ **新加一种缺项形状时，把它加到这里** —— 这是唯一能拦住"新形状又漏标识符"的地方。
const KNOWN_MISSING_FIELD_SHAPES = [
  // 解析层：定金 / 尾款
  '请明确已经收到的定金金额',
  '请明确本次定金的支付方式',
  '定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额',
  '成交价与定金加尾款不一致，请核对',
  '请说明尾款是否已支付；若尚未支付，请写“尾款以后付”',
  // 解析层：items / payments 的机器字段
  'items[0].item_no', 'items[0].size', 'items[0].quantity', 'items[0].actual_amount',
  'items[0].accessory_name', 'items[1].item_no', 'items[1].size', 'items[1].quantity',
  'items[1].actual_amount',
  'payments[0].amount', 'payments[0].method', 'payments[1].amount', 'payments[1].method',
  // 解析层：一条里写了多双 / 总额对不上 / 意图
  '第1件请逐双列出成交金额；每条销售明细只能记录一双',
  '第2件请逐双列出成交金额；每条销售明细只能记录一双',
  '你说的总额 210 与各件金额之和 200 对不上，请确认每件多少钱～',
  '当前只支持商品销售录单',
  // 解析层：团购券政策
  '团购券暂只支持一单一双；多双鞋请逐双说明券后成交金额',
  '团购券暂只支持一单一张，请明确券种和数量',
  '未配置 89.9 元抵 100 元的团购券结算金额',
  '团购券与预付或未付款同时出现，请人工核对成交金额和待收款',
  '请说明团购券之外实际收到的金额和支付方式',
  '请确认是否只用团购券、没有补现金额',
  '实际支付金额无效',
  '明确说出的成交价与实际支付及团购券抵扣不一致，请核对',
  // 接线层：金额三连
  '请逐件说明成交金额',
  '逐件成交金额合计与整单成交金额不一致',
  '已收金额和待平台结算金额不能超过本单成交金额',
  // 接线层：配品定位 / 缺货 / 未建档 / 颜色全下架
  '第1件：其他配品里没有「袜子」这一件，请核对名称',
  '第1件：这一件没听清配品名称，请核对名称',
  '第1件：腰带 有 9 元、15 元 这几档，你卖的是哪一档？',
  '库存里没有 26632 37码（这个货号现在有 36码）',
  '库存里没有 26632 37码（这个货号现在一双都没有）',
  '货品信息里没有 26632，请先在「货品信息」建档或核对货号，再发一次～',
  '货品信息里 26632 的颜色都下架了，没有在售的颜色可选，请核实～',
];

// 其中**确定要被"翻译"**的（含代码标识符 / 内部说法 / 「；」串句）。
const MAPPED_MISSING_FIELD_SHAPES = [
  '请明确已经收到的定金金额',
  '请明确本次定金的支付方式',
  '定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额',
  '成交价与定金加尾款不一致，请核对',
  '请说明尾款是否已支付；若尚未支付，请写“尾款以后付”',
  'items[0].actual_amount', 'items[1].actual_amount', 'items[0].item_no', 'items[0].size',
  'items[0].quantity', 'items[0].accessory_name',
  'payments[0].amount', 'payments[0].method',
  '第1件请逐双列出成交金额；每条销售明细只能记录一双',
  '请逐件说明成交金额',
  '逐件成交金额合计与整单成交金额不一致',
  '已收金额和待平台结算金额不能超过本单成交金额',
  '当前只支持商品销售录单',
  '团购券暂只支持一单一双；多双鞋请逐双说明券后成交金额',
];

// 其中**已经是人话**的：一律**原样透传**（不归这次改，也绝不许丢）。
const PASSTHROUGH_MISSING_FIELD_SHAPES = [
  '你说的总额 210 与各件金额之和 200 对不上，请确认每件多少钱～',
  '团购券暂只支持一单一张，请明确券种和数量',
  '未配置 89.9 元抵 100 元的团购券结算金额',
  '团购券与预付或未付款同时出现，请人工核对成交金额和待收款',
  '请说明团购券之外实际收到的金额和支付方式',
  '请确认是否只用团购券、没有补现金额',
  '实际支付金额无效',
  '明确说出的成交价与实际支付及团购券抵扣不一致，请核对',
  '第1件：其他配品里没有「袜子」这一件，请核对名称',
  '第1件：这一件没听清配品名称，请核对名称',
  '第1件：腰带 有 9 元、15 元 这几档，你卖的是哪一档？',
  '库存里没有 26632 37码（这个货号现在有 36码）',
  '库存里没有 26632 37码（这个货号现在一双都没有）',
  '货品信息里没有 26632，请先在「货品信息」建档或核对货号，再发一次～',
  '货品信息里 26632 的颜色都下架了，没有在售的颜色可选，请核实～',
];

test('⑤ 守卫：所有已知缺项形状渲染后都不含标识符 / 「；」/「明细」，且一句都不丢', () => {
  const items = [
    { item_no: '31678', size: 40, quantity: 2 },
    { item_no: '6681-1', size: 42, quantity: 1 },
    { kind: 'accessory', accessory_name: '腰带', quantity: 1 },
  ];
  // (a) 一次性全喂进去（她要面对的最坏情况）
  const all = renderSalesMissingInfo({
    missingFields: KNOWN_MISSING_FIELD_SHAPES,
    items,
    payments: [{ amount: 50, method: '' }, { amount: 119, method: '' }],
  });
  assert.ok(all.lines.length > 0);
  assert.doesNotMatch(all.text, CODE_IDENTIFIER_PATTERN, `全形状下漏了标识符：\n${all.text}`);
  assert.doesNotMatch(all.text, CHAINED_CLAUSE_PATTERN, `全形状下还有「；」：\n${all.text}`);
  assert.doesNotMatch(all.text, INTERNAL_WORD_PATTERN, `全形状下还有「明细」：\n${all.text}`);
  all.lines.forEach((line) => assert.ok(String(line).trim(), '空行 = 那条缺项被吃掉了'));

  // (b) 逐条单独喂：**每一条**都要渲染出非空文案（绝不许静默吞掉一条缺项）
  for (const shape of KNOWN_MISSING_FIELD_SHAPES) {
    const one = renderSalesMissingInfo({ missingFields: [shape], items, payments: [{ amount: 50, method: '' }] });
    assert.ok(one.lines.length >= 1, `这条缺项被吃掉了：${shape}`);
    assert.equal(one.text, [one.intro, `1. ${one.lines[0]}`].join('\n'), '结构必须是"汇总 + 编号行"');
    assert.doesNotMatch(one.text, CODE_IDENTIFIER_PATTERN, `单独渲染漏标识符：${shape}\n${one.text}`);
    assert.doesNotMatch(one.text, CHAINED_CLAUSE_PATTERN, `单独渲染还有「；」：${shape}\n${one.text}`);
    assert.doesNotMatch(one.text, INTERNAL_WORD_PATTERN, `单独渲染还有「明细」：${shape}\n${one.text}`);
  }

  // (c) 「已经是人话、不归我们改」的那些必须**逐字透传**（信息一个字都不许丢 / 不许被改写）。
  for (const shape of PASSTHROUGH_MISSING_FIELD_SHAPES) {
    assert.ok(KNOWN_MISSING_FIELD_SHAPES.includes(shape), `透传清单里的这条不在全形状清单里：${shape}`);
    const one = renderSalesMissingInfo({ missingFields: [shape], items, payments: [] });
    assert.equal(one.lines[0], shape, `这条应当原样透传：${shape}`);
  }
  // (d) 反过来：确定被"映射"的那些**不许**再原样出现（否则等于没改）。
  for (const shape of MAPPED_MISSING_FIELD_SHAPES) {
    assert.ok(KNOWN_MISSING_FIELD_SHAPES.includes(shape), `映射清单里的这条不在全形状清单里：${shape}`);
    const one = renderSalesMissingInfo({ missingFields: [shape], items, payments: [{ amount: 50, method: '' }] });
    assert.notEqual(one.lines[0], shape, `这条应当被改成模板文案，而不是原样透传：${shape}`);
  }
});

test('⑤ 同一件事只留一条：泛化句被具体句取代（但机器清单里两条都还在）', () => {
  const specificAmount = renderSalesMissingInfo({
    missingFields: ['items[0].actual_amount', 'items[1].actual_amount', '请逐件说明成交金额'],
    items: HER_ITEMS,
  });
  assert.equal(specificAmount.lines.length, 1, '两边都是"每双各说一个金额" ⇒ 合成一条');
  assert.match(specificAmount.lines[0], /31678 40码、6681-1 42码/);
  // 只有泛化句时仍然要说出来（不留空）。
  const genericOnly = renderSalesMissingInfo({ missingFields: ['请逐件说明成交金额'], items: HER_ITEMS });
  assert.equal(genericOnly.lines.length, 1);
  assert.match(genericOnly.lines[0], /成交金额/);
});

test('⑤ #231 那句带数字的「总额 vs 各件之和」原样保留，只压掉没有数字的泛化版', () => {
  const detailed = '你说的总额 210 与各件金额之和 200 对不上，请确认每件多少钱～';
  const both = renderSalesMissingInfo({
    missingFields: ['逐件成交金额合计与整单成交金额不一致', detailed],
    items: HER_ITEMS,
  });
  assert.equal(both.lines.length, 1);
  assert.equal(both.lines[0], detailed, '#231 的文案一个字都不许改（含具体数字）');
  // 只有泛化版时给一句人话。
  const genericOnly = renderSalesMissingInfo({
    missingFields: ['逐件成交金额合计与整单成交金额不一致'], items: HER_ITEMS,
  });
  assert.equal(genericOnly.lines.length, 1);
  assert.match(genericOnly.lines[0], /对不上，请核对一下/);
});

// ── ⑥ 配置先行 ───────────────────────────────────────────────────────────────
test('⑥ 文案全部可配：改环境变量就改文案（含空串回落默认）', () => {
  // 行首编号那条文案在配置里带一个尾随空格；⚠️ 环境变量层的值会被 `trim()`
  //（`config/envValue` 的既有规矩）—— 所以从 env 配的行首末尾不会留空格，
  // 要空格就用默认值、或把分隔符写进模板本体（这里就换成 `1、` 这种写法）。
  const config = resolveSalesMissingInfoConfig({
    [KEYS.intro]: '还差 {count} 件事：',
    [KEYS.itemAmount]: '成交金额还没说：{items}',
    [KEYS.depositMultiLineExample]: '定金单一次一双，分开发～（{firstItem} / {secondItem}）',
    [KEYS.linePrefix]: '{index}、',
    [KEYS.depositAmount]: '   ', // 只有空白 → 回落默认（这是她唯一能看到的解释，不许变空）
  });
  const result = renderSalesMissingInfo({
    missingFields: [
      '定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额',
      'items[0].actual_amount',
      '请明确已经收到的定金金额',
    ],
    items: HER_ITEMS,
  }, config);
  assert.equal(result.intro, '还差 3 件事：');
  assert.match(result.text, /^还差 3 件事：\n1、定金单一次一双，分开发～（31678 40码 \/ 6681-1 42码）/);
  assert.match(result.text, /2、成交金额还没说：31678 40码/);
  assert.match(result.text, new RegExp(`3、${SALES_MISSING_INFO_DEFAULTS.depositAmount}`));
  // 默认配置（不传 env）不受影响。
  assert.match(renderHer().text, /^销售信息还缺 4 处，请照着补一下～/);
});

test('⑥ 一件货的说法也可配（货号 + 尺码 / 只有货号 / 只有尺码 / 都取不到）', () => {
  const config = resolveSalesMissingInfoConfig({});
  assert.equal(formatItemLabel({ item_no: '31678', size: 40 }, 0, config), '31678 40码');
  assert.equal(formatItemLabel({ item_no: '31678' }, 0, config), '31678');
  assert.equal(formatItemLabel({ size: 40 }, 1, config), '40码');
  assert.equal(formatItemLabel({}, 2, config), '第 3 双');
  assert.equal(formatItemLabel({ kind: 'accessory', accessory_name: '腰带' }, 0, config), '腰带');
});

test('⑥ 多行文案：`.env` 里用 `\\n` 表示换行（.env 文件里没法写真换行）', () => {
  const config = resolveSalesMissingInfoConfig({
    [KEYS.depositMultiLineExample]: '定金单一次一双～\\n（{firstItem} / {secondItem}）',
  });
  const result = renderSalesMissingInfo({
    missingFields: ['定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额'],
    items: HER_ITEMS,
  }, config);
  assert.equal(result.lines[0], '定金单一次一双～\n（31678 40码 / 6681-1 42码）');
  // 默认值里的真换行照旧（不受影响）。
  assert.equal(renderHer().lines[0].split('\n').length, 2);
});

test('⑥ `.env.example` 里那一段与配置默认值逐字一致（新加文案忘了写文档 → 红）', () => {
  const envExample = fs.readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
  const documented = new Map();
  for (const line of envExample.split('\n')) {
    const match = line.match(/^(SALES_MISSING_INFO_[A-Z0-9_]+)=(.*)$/);
    if (match) documented.set(match[1], match[2]);
  }
  assert.deepEqual([...documented.keys()].sort(), Object.keys(SALES_MISSING_INFO_DEFAULTS_BY_KEY).sort(),
    '`.env.example` 的键集合与配置的键集合必须一致');
  for (const [key, fallback] of Object.entries(SALES_MISSING_INFO_DEFAULTS_BY_KEY)) {
    // `.env` 里用 `\n` 两个字符表示换行（读进来时会换成真换行）—— 比较前先按同一规则还原。
    assert.equal(documented.get(key).split('\\n').join('\n'), fallback,
      `${key} 的默认值与 .env.example 里写的不一致`);
  }
});

// ── ⑦ 其它出口没被牵连 ───────────────────────────────────────────────────────
test('⑦ 缺货 / 未建档 / 颜色全下架三条"独立成句"的路径**逐字不变**（不套渲染器）', async () => {
  // 判据：`onlyStandalone` 那一支仍然直接回那一句（只有"夹杂别的问题"时才走渲染器）。
  const store = makeStore();
  const messages = [];
  const service = new LarkMvpService({
    client: {},
    gateway: {
      table: () => ({ tableId: 'tbl', fields: {} }),
      listAll: async () => [],
      get: async () => null,
      validateTables: async () => [],
      create: async () => ({ recordId: 'entry_shortage' }),
      update: async () => undefined,
    },
    references: {}, posting: {},
    // 唯一的问题就是"这个尺码没货"（`missing_fields` 里也只有这一句）。
    recognizer: { parseSalesText: async () => normalizeSalesResult({
      intent: 'sale',
      items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 210 }],
      payments: [{ method: '微信', amount: 210 }],
      agreed_total: 210,
    }, '26632黑37一双210微信') },
    store,
  });
  service.sendTaskCard = async () => { throw new Error('缺货时不该发确认卡片'); };
  service.sendTaskText = async (_task, message) => { messages.push(message); };
  await store.create({
    task_id: 'sale_shortage_only', type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: 'om_shortage',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双210微信',
  });
  await service.processSalesTask('sale_shortage_only');
  assert.equal(messages.length, 1);
  assert.equal(messages[0], '库存里没有 26632 37码（这个货号现在一双都没有），请核实～');
});
