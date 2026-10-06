const test = require('node:test');
const assert = require('node:assert/strict');
const doubaoService = require('../src/services/doubaoService');

// ── 采购数量说明提示词的回归锁（2026-10-06 实测出的问题①）──────────────────
//
// 现象（自测脚本 server/scripts/e2e-report-qty.mjs 的用例 C5 / C6 / C9）：
//   「1 双」「一双」「10 双」→ 模型返回空数组 → 链路报
//   「采购报单解析失败: 未识别出有效尺码数量」→ 整条报单不写单。
// 根因：提示词规则 1 说"没有提到的已选尺码由后端保持默认一双，不需要输出"，
//   规则 2 的"全部按默认一双"例子只列了「各一双」「每个码一双」，
//   于是模型把**她明确说的"1 双"**也当成了"默认一双、不用输出"。
//
// 修法（按业务负责人的要求）：**只改提示词，后端合并/校验逻辑一行不动**。
//
// ⚠️ 这个文件只能钉"提示词里写了什么"——模型的行为无法在单测里断言，
//   模型行为的证据是 e2e 脚本的 C5/C6/C9（已实测通过）。
//   但"提示词被改回去"是静默复发型事故，所以这里必须留一道锁。

const MODEL_ENV_KEYS = ['TEXT_LLM_API_KEY', 'TEXT_LLM_BASE_URL', 'TEXT_LLM_MODEL'];

/**
 * 把模型客户端换成"记录提示词、返回固定 JSON"的替身，并临时补齐模型环境变量。
 * 用完必须还原（doubaoService 是单例，别把替身留给后面的用例）。
 */
const withStubModel = async (content, run) => {
  const savedEnv = Object.fromEntries(MODEL_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of MODEL_ENV_KEYS) process.env[key] = process.env[key] || 'selftest';
  const hadClient = Object.prototype.hasOwnProperty.call(doubaoService.clients, 'text');
  const previousClient = doubaoService.clients.text;
  let captured = null;
  doubaoService.clients.text = {
    chat: {
      completions: {
        create: async (params) => {
          captured = params;
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
  try {
    return await run(() => captured);
  } finally {
    if (hadClient) doubaoService.clients.text = previousClient;
    else delete doubaoService.clients.text;
    for (const key of MODEL_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
};

test('规则 1 保住"没提到的尺码默认一双"，同时点明"明确说了数量"必须输出', async () => {
  await withStubModel('{"items":[{"size":38,"quantity":1}]}', async (promptOf) => {
    const items = await doubaoService.parsePurchaseReportText('1 双', { selectedSizes: [38] });
    const prompt = promptOf().messages[0].content;

    // 本意必须保住：没提到的尺码仍然默认一双、不必输出（否则每条都会输出全部尺码）。
    assert.match(prompt, /没有提到的已选尺码由后端保持默认一双/);
    // 例外：她明确说了数量（哪怕就是 1）不许当成"没提到"。
    assert.match(prompt, /明确说了数量/);
    assert.match(prompt, /不许当成“没提到”/);
    // 后端逻辑没动：数量 1 是合法结果，正常返回。
    assert.deepEqual(items, [{ size: 38, quantity: 1 }]);
  });
});

test('规则 2 的"全部按默认一双"例子覆盖「1 双」「一双」', async () => {
  await withStubModel('{"items":[{"size":38,"quantity":1}]}', async (promptOf) => {
    await doubaoService.parsePurchaseReportText('一双', { selectedSizes: [38] });
    const prompt = promptOf().messages[0].content;

    // 这两个例子就是问题①里被漏掉的说法：模型只认"各一双/每个码一双"，
    // 孤立地写"1 双""一双"就返回空数组。
    const rule2 = prompt.slice(prompt.indexOf('2. '), prompt.indexOf('3. '));
    assert.match(rule2, /1 双/);
    assert.match(rule2, /一双/);
  });
});

test('规则 5：0 / 小数不许四舍五入，必须返回空数组让后端拒绝', async () => {
  // 2026-10-06 实测到的连带回归：加了"明确说了数量就必须输出"之后，
  // 模型开始把"2.5 双"四舍五入成 3 写单——所以她明确要求"这种必须继续拒绝"。
  await withStubModel('{"items":[]}', async (promptOf) => {
    await assert.rejects(
      doubaoService.parsePurchaseReportText('2.5 双', { selectedSizes: [38] }),
      /未识别出有效尺码数量/,
    );
    const prompt = promptOf().messages[0].content;
    assert.match(prompt, /不要四舍五入/);
    assert.match(prompt, /“0 双”“2\.5 双”/);
  });
});

test('规则 3：两位数要看全（“10 双”= 10，数字里有 0 不等于数量是 0）', async () => {
  // 2026-10-06 实测：「10 双」**不稳定**——先 4/4 次解析出 10，又出现 1 次空数组。
  // 而"小数/0 必须返回空数组"那条规则里带了"0 双"这个例子，容易被模型套到 10 上，
  // 所以这里把"两位数要看全"单独写死。
  await withStubModel('{"items":[{"size":38,"quantity":10}]}', async (promptOf) => {
    const items = await doubaoService.parsePurchaseReportText('10 双', { selectedSizes: [38] });
    const prompt = promptOf().messages[0].content;

    assert.ok(prompt.includes('“10 双”= 10'), '规则 3 要点明 10 双就是 10');
    assert.ok(prompt.includes('数字里有 0'), '规则 3 要点明"数字里有 0 不等于数量是 0"');
    assert.ok(prompt.includes('是正常的两位数'), '规则 5 要点明两位数必须正常输出');
    assert.deepEqual(items, [{ size: 38, quantity: 10 }]);
  });
});

test('提示词仍然把已选尺码与"只输出 JSON"写清楚（解析契约没被改歪）', async () => {
  await withStubModel('{"items":[{"size":39,"quantity":2}]}', async (promptOf) => {
    const items = await doubaoService.parsePurchaseReportText('39 码 2 双', { selectedSizes: [39, 40] });
    const prompt = promptOf().messages[0].content;

    assert.match(prompt, /表单已经明确勾选尺码：39、40/);
    assert.match(prompt, /只输出 JSON/);
    assert.deepEqual(items, [{ size: 39, quantity: 2 }]);

    // 未勾选的尺码仍由解析层拒绝（提示词改的是"什么算明确说了数量"，不是放宽尺码校验）。
    await assert.rejects(
      doubaoService.parsePurchaseReportText('39 码 2 双', { selectedSizes: [40, 41] }),
      /数量说明包含未勾选或无效的尺码/,
    );
  });
});
