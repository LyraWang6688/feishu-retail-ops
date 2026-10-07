/**
 * 「采购到货核对」解析层（`DoubaoService.parseArrivalReconciliation`）的回归测试。
 *
 * 【为什么要有这个文件】2026-10-07 线上真事：这个方法的实现里用了**没有定义的 `text(...)`**
 *   → `ReferenceError: text is not defined` → 被上层 catch 成
 *   `purchase.arrival.reconcile.parse_failed` → 业务负责人在**采购单图片的话题里**回复
 *   到货情况之后，**没有卡片、没有下文**（服务器日志逐字：`"error":"text is not defined"`）。
 *
 *   之所以一路漏到线上：`test/arrivalConversation.test.js` 用的是**假 recognizer**
 *   （`async parseArrivalReconciliation(input) { … }`），把整个解析层顶掉了 ——
 *   **真实方法从来没有被任何用例执行过**，"用了没定义的变量"这种崩溃自然拦不住。
 *
 *   ⇒ 这里**用假 client 打桩真实方法**：不走网络、不碰真模型、不需要真 key，
 *     但跑的是**项目代码本体**（`Object.create` 取的是同一个原型上的那个方法）。
 *
 * 口径（业务负责人 2026-10-06 逐字定的，本文件**不改**、只钉住）：
 *   · 差异只有三类：完全一样 / 实际比申请多 / 实际比申请少（**没有"实际为 0"**）；
 *   · 「说完了没有」由**模型**判（`complete`），代码里没有任何关键词闸门。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const doubaoService = require('../src/services/doubaoService');

// 配置齐了才过 `assertLlmConfigured`；值全是假的，且 `getClient` 会被下面的假 client 顶掉，
// 所以**一次网络请求都不会发**（这一点很重要：CI 上没有模型可调）。
process.env.TEXT_LLM_API_KEY = process.env.TEXT_LLM_API_KEY || 'test_key';
process.env.TEXT_LLM_BASE_URL = process.env.TEXT_LLM_BASE_URL || 'https://llm.invalid';
process.env.TEXT_LLM_MODEL = process.env.TEXT_LLM_MODEL || 'test-model';

/** 这一批采购申请的明细（两个尺码，便于验证"只认她说的那一行"）。 */
const ROWS = () => [
  { item_no: 'XHB8095', color: '黑', size: 38, quantity: 2 },
  { item_no: 'XHB8095', color: '黑', size: 39, quantity: 2 },
];

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
// □ 正常路：模型返回合法 JSON → complete / same / differences（三类都在）
// ═══════════════════════════════════════════════════════════════════════════

test('正常路：三类差异（more/less/same）都解析出来，并把申请明细原样喂给模型', async () => {
  const calls = [];
  const service = makeService(JSON.stringify({
    complete: true,
    same: false,
    differences: [
      // 类型大小写不固定：归一化成小写（模型输出不可控）。
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'MORE', quantity: 2 },
      { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
      { item_no: 'XHB8095', color: '黑', size: 38, type: 'same' },
    ],
  }), { calls });

  const result = await service.parseArrivalReconciliation({
    rows: ROWS(),
    messages: ['39 码到了 4 双', '38 码少一双'],
    taskId: 'arrival_reconcile_test',
  });

  assert.equal(result.complete, true);
  assert.equal(result.same, false);
  assert.deepEqual(result.differences, [
    { item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 2 },
    { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
    // type="same" 的 quantity 一律归 0（她说"这一行就是一样的"，没有差异数）。
    { item_no: 'XHB8095', color: '黑', size: 38, type: 'same', quantity: 0 },
  ]);

  // ⭐ 这一段就是崩掉的那段代码：请求明细要用 `textValue` 拼进提示词。
  //    它一崩，模型根本收不到明细，整条到货核对就死在解析这一步。
  const prompt = promptOf(calls);
  assert.match(prompt, /XHB8095 \/ 黑 \/ 38 码 \/ 申请 2 双/, '提示词里必须有采购申请明细（经 textValue 归一）');
  assert.match(prompt, /XHB8095 \/ 黑 \/ 39 码 \/ 申请 2 双/);
  // 她分多次说的话，要**累积**着给模型（只看最后一条会把前面说的丢掉）。
  assert.match(prompt, /39 码到了 4 双/);
  assert.match(prompt, /38 码少一双/);
});

test('正常路②：模型返回 markdown 代码块包裹的 JSON 也能解析（既有行为，不许退化）', async () => {
  const service = makeService('```json\n{"complete":true,"same":true,"differences":[]}\n```');
  const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['都到了，完毕'] });
  assert.deepEqual(result, { complete: true, same: true, differences: [] });
});

test('正常路③：归一化用的是仓库既有的 textValue —— 飞书单元格形状（对象/数组）也能读成文字', async () => {
  const calls = [];
  const service = makeService(JSON.stringify({ complete: false, same: false, differences: [] }), { calls });

  await service.parseArrivalReconciliation({
    // 网关读回来的单元格可能是对象/数组形状（`{text}` / `[{text}]`）：
    // `textValue` 认这些形状，裸 `String()` 会得到 "[object Object]"。
    rows: [{ item_no: { text: 'XHB8095' }, color: [{ text: '黑' }], size: 39, quantity: 2 }],
    messages: ['39 码多一双'],
  });

  assert.match(promptOf(calls), /XHB8095 \/ 黑 \/ 39 码 \/ 申请 2 双/);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 脏数据路：如实报「到货核对解析失败」，**不许**是 ReferenceError
// ═══════════════════════════════════════════════════════════════════════════

/** 断言错误是"解析失败"，而且**不是**"变量没定义"——后者正是线上崩的形状。 */
const assertParseFailed = (error) => {
  assert.ok(!(error instanceof ReferenceError), `不能是 ReferenceError（线上崩的就是它）：${error}`);
  assert.doesNotMatch(String(error?.message || ''), /text is not defined/);
  assert.match(String(error?.message || ''), /^到货核对解析失败/, '要明确告诉上层"是解析失败"，不是别的');
  return true;
};

test('脏数据路①：模型返回非 JSON → 抛「到货核对解析失败」，不是 ReferenceError', async () => {
  const service = makeService('这不是 JSON，我说了句人话');
  await assert.rejects(
    () => service.parseArrivalReconciliation({ rows: ROWS(), messages: ['38 码少一双'] }),
    assertParseFailed,
  );
});

test('脏数据路②：模型回复为空（截断/被拦）→ 同样是「到货核对解析失败」', async () => {
  const service = makeService('');
  await assert.rejects(
    () => service.parseArrivalReconciliation({ rows: ROWS(), messages: ['38 码少一双'] }),
    assertParseFailed,
  );
});

test('脏数据路③：缺输入（原话为空 / 明细为空）→ 明确报缺什么，且不崩', async () => {
  const service = makeService('{}');
  await assert.rejects(
    () => service.parseArrivalReconciliation({ rows: ROWS(), messages: [] }),
    /到货核对原话不能为空/,
  );
  await assert.rejects(
    () => service.parseArrivalReconciliation({ rows: [], messages: ['38 码少一双'] }),
    /到货核对缺少采购申请明细/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// □ 字段缺失 / 非法字段：按缺省收敛、把非法条目滤掉（不写错账）
// ═══════════════════════════════════════════════════════════════════════════

test('字段缺失路①：{} / null → 不崩，complete/same 缺省 false、differences 空', async () => {
  for (const content of ['{}', 'null']) {
    const service = makeService(content);
    const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['嗯，我看看'] });
    assert.deepEqual(result, { complete: false, same: false, differences: [] }, `content=${content}`);
  }
});

test('字段缺失路②：非法差异条目被过滤掉（不猜、不写错账）', async () => {
  const service = makeService(JSON.stringify({
    complete: true,
    same: false,
    differences: [
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 0 },   // 多 0 双 = 没说清
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'less' },                // 缺 quantity
      { item_no: 'XHB8095', color: '黑', size: '三十九', type: 'more', quantity: 2 }, // size 不是数字
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'more', quantity: 1.5 }, // 不是整数
      { item_no: 'XHB8095', color: '黑', size: 0, type: 'less', quantity: 1 },    // size<=0
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'unknown', quantity: 1 }, // 类型只有三类
      { item_no: 'XHB8095', color: '黑', size: 39, type: 'same', quantity: 5 },   // 说"一样"却带差异数
      { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },   // ✅ 唯一合法的一条
      null,                                                                        // 空条目
    ],
  }));

  const result = await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['38 码少一双，完毕'] });

  assert.equal(result.complete, true);
  assert.deepEqual(result.differences, [
    { item_no: 'XHB8095', color: '黑', size: 38, type: 'less', quantity: 1 },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 红线：这个 bug 再犯，CI 必须立刻红
// ═══════════════════════════════════════════════════════════════════════════

test('⭐ 防复发①（运行时）：调用 parseArrivalReconciliation 不会抛 "text is not defined"', async () => {
  // 这是最小的那一条：只要实现里再出现未定义的 `text(...)`，
  // 这次调用就会以 `ReferenceError: text is not defined` 失败。
  const service = makeService(JSON.stringify({ complete: true, same: true, differences: [] }));
  const result = await service.parseArrivalReconciliation({
    rows: ROWS(), messages: ['都到了，跟单子一样，完毕'], taskId: 'arrival_reconcile_regression',
  });
  assert.deepEqual(result, { complete: true, same: true, differences: [] });
});

test('⭐ 防复发②（源码级）：doubaoService 里不许再出现裸 `text(`，归一化必须用既有的 textValue', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/doubaoService.js'), 'utf8');
  // 只看代码，不看注释（注释里会提到历史写法，那是给人看的说明）。
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/([^:])\/\/.*$/gm, '$1');

  assert.ok(
    !/(?<![.\w$])text\s*\(/.test(codeOnly),
    '出现了裸 `text(`：doubaoService 里没有定义它（2026-10-07 线上就是它崩的），'
    + '请改用 ./v1BitableGateway 的 textValue',
  );
  assert.match(
    source,
    /const \{ textValue \} = require\('\.\/v1BitableGateway'\);/,
    'textValue 必须来自仓库里唯一的那个实现（v1BitableGateway），不要新造一份 helper',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⭐ 提示词口径（2026-10-07 业务负责人批准改的两条，见
//    docs/arrival-trigger-and-prompt-2026-10-07.md）
//    ⚠️ 这几条**只钉提示词原文**（模型行为没法在 CI 里跑真模型验证），
//       作用是"以后有人把这两条删掉，CI 立刻红"。
// ═══════════════════════════════════════════════════════════════════════════

test('提示词①：不再要求她说「完毕」才处理 —— `complete` 的定义改成"信息够不够算"', async () => {
  const calls = [];
  const service = makeService(JSON.stringify({ complete: true, same: false, differences: [] }), { calls });
  await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['38 码少一双'] });
  const prompt = promptOf(calls);

  // 🔴 旧口径必须消失：以前是"她明确说了完了才 complete=true"。
  assert.doesNotMatch(prompt, /明确\*\*表示这次核对说完了/,
    '旧的「她明确表示说完了才填 true」必须删掉（业务负责人 2026-10-07 拍板）');
  assert.doesNotMatch(prompt, /说完之后会说一句表示/,
    '旧文案里"说完之后会说一句表示核对完了的话"必须删掉');
  assert.doesNotMatch(prompt, /不要\*\*因为内容看起来齐了就填 true/,
    '旧的「不要因为内容看起来齐了就填 true」与"信息够就算"的新口径相反，必须改掉');
  // ⭐ 新口径：complete 表示"信息够不够算"，且明确它不是"要不要处理"的开关。
  assert.match(prompt, /只表示"她给的信息够不够算"/);
  assert.match(prompt, /信息足以算清差异[\s\S]{0,80}填 true/);
  assert.match(prompt, /不是\*\*"要不要处理"的开关/);
  // 但要保留那个**体感**：不需要她说「完毕」。
  assert.match(prompt, /不需要\*\*她说「完毕 \/ 核对完了」这类话才处理/);
});

test('提示词②：新增「某行一双都没到 / 没到 / 没来」→ 必须按 less + 申请数量输出（漏了就写错账）', async () => {
  const calls = [];
  const service = makeService(JSON.stringify({ complete: true, same: false, differences: [] }), { calls });
  await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['38 码一双都没到'] });
  const prompt = promptOf(calls);

  assert.match(prompt, /一双都没到 \/ 没到 \/ 没来 \/ 一双没来/, '要逐字写出她可能说的那几种说法');
  assert.match(prompt, /这一行必须输出/);
  assert.match(prompt, /quantity = \*\*该行的申请数量\*\*/);
  assert.match(prompt, /明明没到却入库，就是写错账/, '要说清漏掉它的后果');
  // ⚠️ 仍然是三类里的 `less`，**没有**新增第四种差异类型（与既有口径一致）。
  assert.match(prompt, /type="less"/);
  assert.doesNotMatch(prompt, /"zero"/, '不许新增第四种差异类型');
});

test('提示词③：保守原则还在 —— 判断不出就不要瞎猜（宁可让她再说一遍）', async () => {
  const calls = [];
  const service = makeService(JSON.stringify({ complete: false, same: false, differences: [] }), { calls });
  await service.parseArrivalReconciliation({ rows: ROWS(), messages: ['嗯，我看看'] });
  const prompt = promptOf(calls);

  assert.match(prompt, /判断不出她说的是差异还是实际数量时，\*\*不要输出这一行\*\*/);
  assert.match(prompt, /货号、尺码都不在单子上[\s\S]{0,40}不要输出那一行，也不要猜/);
  // ⚠️ 2026-10-07 晚：这条里的**说法清单**跟着「全到说法等价」一起补了
  //    （原句只有「都到了 / 一件不差 / 没有差异」—— 真机那次模型就是没认出「都到货了」）。
  //    它钉住的**意图没变**：same 仍然是"完全一样"这一类，**没有**新增第四类差异。
  //    逐字清单由 test/arrivalAllArrivedPhrases.test.js 的 AC-1 钉。
  assert.match(
    prompt,
    /她说「完全一样 \/ 都到了 \/ 都到货了[\s\S]{0,120}没有差异」时填 true/,
    'same 那一句必须还在，且仍然把「完全一样」放在第一位（清单可扩，类别不许加）',
  );
});
