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

// 解析层给的那 4 条（**机器清单**）。
// ⚠️⚠️ **上游已变（PR #234 合入，2026-10-07）—— 这 4 条跟着真实解析层走了**：
//   · 「定金单暂只支持一条明细…」生产者已**删除**（#234 放开了「多明细 + 定金」）⇒ 不再出现；
//   · 换成了 #234 **新增**的那句（`哪一件是付了定金的那件…`）；
//   · 多明细时定金那笔**不再独占 `payments`** ⇒ 缺的是 `payments[1].method`（**不再是 `[0]`**）。
// ⭐ 下面有一条用例把这份手抄清单与**真实** `normalizeSalesResult` 的输出 `deepEqual` 钉住
//   （比"手抄一份"更严：上游改了字，这里立刻红）。
const HER_PARSED_MISSING_FIELDS = [
  '这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪一件付了定金、每双多少钱～',
  'items[0].actual_amount',
  'items[1].actual_amount',
  'payments[1].method',
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
  '1. 这一单里哪一件是付了定金的那件，我有点拿不准～请对着「31678 40码、6681-1 42码」逐件说清楚哪一件付了定金、每双多少钱～',
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
  // ⚠️ #234 之后这一支**只有开头那句汇总**在外面 —— 旧那句"分开发送"带一行例子（续行），
  //    它已经随生产者一起退场（见本文件 `HISTORICAL_MISSING_FIELD_SHAPES`）。
  const continuation = text.split('\n').filter((line) => !/^\d+\. /.test(line));
  assert.deepEqual(continuation, ['销售信息还缺 4 处，请照着补一下～']);
});

// ── ③ 具体动作 ───────────────────────────────────────────────────────────────
test('③ 每条缺项都给具体动作（逐字）', () => {
  const { text } = renderHer();
  // #234 新增那句：必须把"这一单到底是哪几双"点出来（两个货号都在），并问清"哪一件付了定金、每双多少钱"。
  assert.match(text, /请对着「31678 40码、6681-1 42码」逐件说清楚哪一件付了定金、每双多少钱/);
  // 缺金额：说清"每双各一个成交金额"，并把两双都列出来。
  assert.match(text, /请给每双鞋都说一个成交金额：31678 40码、6681-1 42码/);
  // 缺收款方式：给可选值（她自己会说到方式 —— AGENTS.md 第 16 条，所以这里只是问，不设默认）。
  assert.match(text, /没说收款方式，请补一句是微信、现金还是支付宝/);
  // 改动前那句"笼统"的结尾**不该**再出现。
  assert.ok(!text.includes('请补充后重新发送完整销售信息'));
});

test('④ 不说内部说法「明细」；#234 那句把"哪几双"点出来', () => {
  const { text } = renderHer();
  assert.doesNotMatch(text, INTERNAL_WORD_PATTERN, `文案里还有内部说法：\n${text}`);
  assert.match(text, /哪一件是付了定金的那件/);
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

// ⭐⭐ **上游同步的哨兵（AC-S7）**：手抄的那份"解析层应该给这 4 条"必须与**真实**
//    `normalizeSalesResult` 的输出**逐字相同**。上游谁改了 `missing_fields` 的字，
//    这条**立刻红** —— 逼着来同步（映射表 + 形状清单 + 本 fixture），而不是让它悄悄退化成原样透传。
//    ⚠️ 这条比"手抄一份、只跟接线层对上"更严：它把**手抄件锚在解析层真身**上。
test('④ fixture 与真实解析层输出逐字同步（上游改了字 → 这条红）', () => {
  assert.deepEqual(HER_PARSED_MISSING_FIELDS, HER_PARSED().missing_fields,
    '手抄的 fixture 与真实 normalizeSalesResult 输出不一致 —— 上游变了，来同步映射表');
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
// ⚠️ 同时要把它**正好**归入下面 `MAPPED` / `PASSTHROUGH` 里的一个 ——
//    "映射表 ⇄ 形状守卫双向一致"有一条专门的守门用例（⑤-一致性），缺一个就红。
const KNOWN_MISSING_FIELD_SHAPES = [
  // 解析层：定金 / 尾款
  '请明确已经收到的定金金额',
  '请明确本次定金的支付方式',
  '成交价与定金加尾款不一致，请核对',
  '请说明尾款是否已支付；若尚未支付，请写“尾款以后付”',
  // 解析层：**#234 新增**（`config/salesTradeTypePolicy.SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS`，
  // 逐字 = 那个常量本身；⑤-#234 那条用例直接拿常量来 compare，保证这里不是手抄的近似句）。
  '这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪一件付了定金、每双多少钱～',
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

// ⭐⭐ **历史形状**（**上游已变** —— PR #234 合入，2026-10-07）：生产者**已经删掉**、
//    当前链路**永远不会再产出**的句子。
//    保留（而不是从守卫里删掉）的**理由**：`missing_fields` 会被**落盘持久化** ——
//      ① 本地任务 `server/data/lark_mvp_tasks/*.json` 的 `draft.missing_fields`；
//      ② 业务表「解析结果摘要」(`parseSummary`) 那份 JSON 快照。
//    部署之后，一条**改动前就存着的** `needs_info` 任务若被**重放**（`resumePending` / 手工重跑），
//    渲染器仍会读到这句历史原文 ⇒ **它的映射必须留着**
//    （`config/salesMissingInfoText.TEXT_TOPIC_PATTERNS` 里 `deposit_multi_line` 那条带
//      「上游已删除，仅防历史任务重放」注释），否则重放会退化成"原样透传"，
//    她**又会看到「明细」和「；」**（正是本次专治的两个毛病）。
//    ⇒ 它是**历史形状兜底，成本为零**；当前的"多明细 + 定金"是**合法输入**，走不到它。
//    见 `docs/sales-missing-info-wording-2026-10-07.md` 第 14 节（AC-S3）。
const HISTORICAL_MISSING_FIELD_SHAPES = [
  '定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额', // #234 删除了这个生产者
];

// 守卫要盖住**【当前 + 历史】两者**：历史形状当前不产生，但"老任务重放"仍会渲染到它。
const ALL_GUARDED_MISSING_FIELD_SHAPES = [
  ...KNOWN_MISSING_FIELD_SHAPES,
  ...HISTORICAL_MISSING_FIELD_SHAPES,
];

// 其中**确定要被"翻译"**的（含代码标识符 / 内部说法 / 「；」串句）。
// ⚠️ 凡是"渲染后 ≠ 原文"的形状都必须在这里 —— 包括 index=1 那些（结构与 index=0 同类，
//    但以前**一条都没列**，等于漏了守卫；本次补齐）。
const MAPPED_MISSING_FIELD_SHAPES = [
  // 解析层：定金 / 尾款（含 #234 新增那句）
  '请明确已经收到的定金金额',
  '请明确本次定金的支付方式',
  '成交价与定金加尾款不一致，请核对',
  '请说明尾款是否已支付；若尚未支付，请写“尾款以后付”',
  '这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪一件付了定金、每双多少钱～',
  // ⭐ **历史形状**（生产者已删）—— 它的映射是**有意保留**的兜底，所以仍属"被翻译"那一类。
  '定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额',
  // 解析层：items / payments 的机器字段（**index 0 与 1 都在**）
  'items[0].item_no', 'items[0].size', 'items[0].quantity', 'items[0].actual_amount',
  'items[0].accessory_name',
  'items[1].item_no', 'items[1].size', 'items[1].quantity', 'items[1].actual_amount',
  'payments[0].amount', 'payments[0].method', 'payments[1].amount', 'payments[1].method',
  // 解析层：一条里写了多双（第 1 件 / 第 2 件都在）
  '第1件请逐双列出成交金额；每条销售明细只能记录一双',
  '第2件请逐双列出成交金额；每条销售明细只能记录一双',
  // 解析层：意图 / 团购券
  '当前只支持商品销售录单',
  '团购券暂只支持一单一双；多双鞋请逐双说明券后成交金额',
  // 接线层：金额三连
  '请逐件说明成交金额',
  '逐件成交金额合计与整单成交金额不一致',
  '已收金额和待平台结算金额不能超过本单成交金额',
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
  // (a) 一次性全喂进去（她要面对的最坏情况）—— **当前形状 + 历史形状**都盖住
  const all = renderSalesMissingInfo({
    missingFields: ALL_GUARDED_MISSING_FIELD_SHAPES,
    items,
    payments: [{ amount: 50, method: '' }, { amount: 119, method: '' }],
  });
  assert.ok(all.lines.length > 0);
  assert.doesNotMatch(all.text, CODE_IDENTIFIER_PATTERN, `全形状下漏了标识符：\n${all.text}`);
  assert.doesNotMatch(all.text, CHAINED_CLAUSE_PATTERN, `全形状下还有「；」：\n${all.text}`);
  assert.doesNotMatch(all.text, INTERNAL_WORD_PATTERN, `全形状下还有「明细」：\n${all.text}`);
  all.lines.forEach((line) => assert.ok(String(line).trim(), '空行 = 那条缺项被吃掉了'));

  // (b) 逐条单独喂：**每一条**都要渲染出非空文案（绝不许静默吞掉一条缺项）
  for (const shape of ALL_GUARDED_MISSING_FIELD_SHAPES) {
    const one = renderSalesMissingInfo({ missingFields: [shape], items, payments: [{ amount: 50, method: '' }] });
    assert.ok(one.lines.length >= 1, `这条缺项被吃掉了：${shape}`);
    assert.equal(one.text, [one.intro, `1. ${one.lines[0]}`].join('\n'), '结构必须是"汇总 + 编号行"');
    assert.doesNotMatch(one.text, CODE_IDENTIFIER_PATTERN, `单独渲染漏标识符：${shape}\n${one.text}`);
    assert.doesNotMatch(one.text, CHAINED_CLAUSE_PATTERN, `单独渲染还有「；」：${shape}\n${one.text}`);
    assert.doesNotMatch(one.text, INTERNAL_WORD_PATTERN, `单独渲染还有「明细」：${shape}\n${one.text}`);
  }

  // (c) 「已经是人话、不归我们改」的那些必须**逐字透传**（信息一个字都不许丢 / 不许被改写）。
  for (const shape of PASSTHROUGH_MISSING_FIELD_SHAPES) {
    assert.ok(ALL_GUARDED_MISSING_FIELD_SHAPES.includes(shape), `透传清单里的这条不在全形状清单里：${shape}`);
    const one = renderSalesMissingInfo({ missingFields: [shape], items, payments: [] });
    assert.equal(one.lines[0], shape, `这条应当原样透传：${shape}`);
  }
  // (d) 反过来：确定被"映射"的那些**不许**再原样出现（否则等于没改）。
  for (const shape of MAPPED_MISSING_FIELD_SHAPES) {
    assert.ok(ALL_GUARDED_MISSING_FIELD_SHAPES.includes(shape), `映射清单里的这条不在全形状清单里：${shape}`);
    const one = renderSalesMissingInfo({ missingFields: [shape], items, payments: [{ amount: 50, method: '' }] });
    assert.notEqual(one.lines[0], shape, `这条应当被改成模板文案，而不是原样透传：${shape}`);
  }
});

// ⭐⭐ **映射表 ⇄ 形状守卫：双向一致**（AC-S5）。她明令：不许出现
//    "映射里有、形状列表里没有"，也不许"形状列表里有、映射里没有"（那等于漏了守卫）。
test('⑤-一致性：MAPPED ∪ PASSTHROUGH == 全部守卫形状，且两边不重叠、无重复', () => {
  // (a) 形状清单本身不许有重复（重复 = 有一条其实没被单独守卫）
  for (const [name, list] of [['KNOWN', KNOWN_MISSING_FIELD_SHAPES],
    ['HISTORICAL', HISTORICAL_MISSING_FIELD_SHAPES],
    ['MAPPED', MAPPED_MISSING_FIELD_SHAPES],
    ['PASSTHROUGH', PASSTHROUGH_MISSING_FIELD_SHAPES]]) {
    assert.equal(new Set(list).size, list.length, `${name} 清单里有重复条目`);
  }
  // (b) "当前形状"与"历史形状"**不许重叠** —— 重叠说明它其实还在生产（那就不该进历史）
  const known = new Set(KNOWN_MISSING_FIELD_SHAPES);
  HISTORICAL_MISSING_FIELD_SHAPES.forEach((shape) => {
    assert.ok(!known.has(shape), `历史形状不该再算作"当前形状"：${shape}`);
  });
  // (c) 两个映射清单都必须**是**形状清单的子集（防"映射里有、形状列表里没有"）
  for (const [name, list] of [['MAPPED', MAPPED_MISSING_FIELD_SHAPES],
    ['PASSTHROUGH', PASSTHROUGH_MISSING_FIELD_SHAPES]]) {
    list.forEach((shape) => {
      assert.ok(ALL_GUARDED_MISSING_FIELD_SHAPES.includes(shape),
        `${name} 里的这条**不在**形状清单里（映射表与守卫不一致）：${shape}`);
    });
  }
  // (d) 不许一条形状同时属于两边（同时属于两边 = 断言自相矛盾，等于没守卫）
  const both = MAPPED_MISSING_FIELD_SHAPES.filter((shape) => PASSTHROUGH_MISSING_FIELD_SHAPES.includes(shape));
  assert.deepEqual(both, [], `这些形状同时出现在 MAPPED 与 PASSTHROUGH 里：${both.join(' / ')}`);
  // (e) **反过来**：每一条形状都必须**正好**归入 MAPPED 或 PASSTHROUGH 之一
  //     （防"形状列表里有、映射表里没有" —— 那一条等于没人守）
  const uncovered = ALL_GUARDED_MISSING_FIELD_SHAPES.filter((shape) =>
    !MAPPED_MISSING_FIELD_SHAPES.includes(shape) && !PASSTHROUGH_MISSING_FIELD_SHAPES.includes(shape));
  assert.deepEqual(uncovered, [],
    `这些形状既不在 MAPPED 也不在 PASSTHROUGH（形状列表里有、映射表里没有）：${uncovered.join(' / ')}`);
  // 合起来**正好等于**全部守卫形状（穷尽 + 不重复）
  assert.deepEqual(
    [...MAPPED_MISSING_FIELD_SHAPES, ...PASSTHROUGH_MISSING_FIELD_SHAPES].slice().sort(),
    ALL_GUARDED_MISSING_FIELD_SHAPES.slice().sort(),
    'MAPPED ∪ PASSTHROUGH 必须**不多不少**正好等于全部守卫形状');
});

// ⭐⭐ **上游已变（AC-S3 / AC-S4）：#234 的"一增一删"逐条钉住** ─────────────────────
test('⑤ 上游已变（删）：那条整单护栏**当前解析层不再产出**，但历史映射仍在（防老任务重放）', () => {
  const historical = HISTORICAL_MISSING_FIELD_SHAPES[0];
  // ① 反向证据：这句原本是"多明细 + 定金"触发的 —— 现在**正是**这个输入，且它是**合法**的。
  assert.ok(!HER_PARSED().missing_fields.includes(historical),
    `#234 已放开「多明细 + 定金」，不该再产出这句：${historical}`);
  // ② 它的**历史兜底映射**不能丢：老任务重放时仍必须被翻成人话（否则退化成原样透传，
  //    她**又会看到「明细」和「；」** —— 正是本次专治的两个毛病）。
  const one = renderSalesMissingInfo({ missingFields: [historical], items: HER_ITEMS });
  assert.notEqual(one.lines[0], historical, '历史兜底映射丢了：老任务重放会退化成原样透传');
  assert.doesNotMatch(one.text, INTERNAL_WORD_PATTERN, '历史形状渲染后不该还有「明细」');
  assert.doesNotMatch(one.text, CHAINED_CLAUSE_PATTERN, '历史形状渲染后不该还有「；」');
});

test('⑤ 上游已变（增）：#234 新增那句**跟着生产者常量走**（不是手抄的近似句）', () => {
  const { SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS } = require('../src/config/salesTradeTypePolicy');
  // ① 形状清单里必须是**生产者常量本身**（逐字）—— 生产者改了字，这条立刻红，逼着来同步。
  assert.ok(ALL_GUARDED_MISSING_FIELD_SHAPES.includes(SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS),
    '#234 那句（逐字 = config/salesTradeTypePolicy 的常量）不在形状清单里 —— 守卫会漏');
  assert.ok(MAPPED_MISSING_FIELD_SHAPES.includes(SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS),
    '#234 那句没归入"被映射"清单 —— 它会退化成原样透传');
  // ② 真的被映射（≠ 原文），且把"这一单的每一双"当场点出来。
  const one = renderSalesMissingInfo({
    missingFields: [SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS],
    items: HER_ITEMS,
  });
  assert.notEqual(one.lines[0], SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS,
    '#234 那句退化成原样透传了（等于没给它映射）');
  assert.match(one.lines[0], /31678 40码、6681-1 42码/, '映射后要把这一单的每一双都点出来');
  // ⚠️ 2026-10-07 口径变更：这句话**只说钱的事**（哪一件付了定金）——
  //    类型是查完库存才有的结论，不该反过来问她"哪双是预付"。
  assert.match(one.lines[0], /哪一件付了定金/);
  // ③ 一件货都取不出来时也有话说（不留空行 / 不留半句）。
  const empty = renderSalesMissingInfo({ missingFields: [SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS], items: [] });
  assert.equal(empty.lines[0], SALES_MISSING_INFO_DEFAULTS.depositTargetAmbiguousGeneric);
  assert.ok(String(empty.lines[0]).trim());
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
  // ⚠️ 这条用的是**历史形状**那句（`HISTORICAL_MISSING_FIELD_SHAPES[0]`）——
  //    #234 之后它当前**不再产生**，但它的**映射与两行默认值仍是有意保留的兜底**
  //    （防"改动前落盘的老任务重放"时退化），所以这里照样能验"多行文案"这件事。
  const config = resolveSalesMissingInfoConfig({
    [KEYS.depositMultiLineExample]: '定金单一次一双～\\n（{firstItem} / {secondItem}）',
  });
  const result = renderSalesMissingInfo({
    missingFields: [HISTORICAL_MISSING_FIELD_SHAPES[0]],
    items: HER_ITEMS,
  }, config);
  assert.equal(result.lines[0], '定金单一次一双～\n（31678 40码 / 6681-1 42码）');
  // 默认值里的真换行照旧（不受影响）—— 同一条历史兜底文案，换回默认配置渲染。
  const withDefaults = renderSalesMissingInfo({
    missingFields: [HISTORICAL_MISSING_FIELD_SHAPES[0]],
    items: HER_ITEMS,
  });
  assert.equal(withDefaults.lines[0].split('\n').length, 2);
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
test('⑦ 「缺货」不再是缺项：没有实时库存 ⇒ 记**预定**、照出确认卡片（不再回"请核实"）', async () => {
  const store = makeStore();
  const messages = [];
  const cards = [];
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
    recognizer: { parseSalesText: async () => normalizeSalesResult({
      intent: 'sale',
      items: [{ item_no: '26632', color: '黑', size: 37, quantity: 1, actual_amount: 210 }],
      payments: [{ method: '微信', amount: 210 }],
      agreed_total: 210,
    }, '26632黑37一双210微信') },
    store,
  });
  // 出货卡片是**必须**的（没货 = 预定，是合法输入）。
  service.sendTaskCard = async (_task, card) => { cards.push(card); return 'om_card'; };
  service.sendTaskText = async (_task, message) => { messages.push(message); };
  await store.create({
    task_id: 'sale_shortage_only', type: 'sale', status: 'received',
    chat_type: 'group', chat_id: GROUP_CHAT_ID, message_id: 'om_shortage',
    sender_open_id: 'ou_1', sent_at: Date.now(), original_text: '26632黑37一双210微信',
  });
  await service.processSalesTask('sale_shortage_only');
  const task = await store.get('sale_shortage_only');
  assert.deepEqual(task.draft.missing_fields, [], '没货不再是缺项');
  assert.equal(cards.length, 1, '照出确认卡片');
  assert.deepEqual(messages, [], '不再回"库存里没有…请核实"');
  assert.equal(task.draft.items[0].trade_type_code, 'SALE_PREPAID', '没货 → 预定');
});
