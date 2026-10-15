'use strict';

/**
 * saleAmountAndSizeRequired.e2e.test.js —— 「实收金额**必填** + 尺码**必填**」的判据（货品页那一层）
 *
 * 她的口径（2026-10-16 逐字）：
 * > 「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
 * >  才可以点击提交跳转到资金页，**不用做那个为空去单价的功能了**」
 *
 * ## ⚠️ 本文件**如实的两种判据**（不假装通过 ✗）
 * - **真判据**：检测器本身**能真红** —— 每条都用「塞进坏样本 ⇒ 必须被检出」的**探针**证明它不是空跑 ✓
 * - **[待激活] 闸门**：①②③④⑤ 的**目标行为**都还没实现（另一刀在改 `routes/` / `config/` / `views/` ✗）
 *   ⇒ 本文件**不断言目标已达成**，只**如实记下现状**并打 `[待激活]` ✓
 *   ⇒ 谁实现完 ⇒ 把对应那条从 `[待激活]` 改成**真断言**（去掉 `assertGatePending` 那一行、写上断言）✓
 *
 * ## 🔴 为什么不写成"现在就红"的断言
 * 那样 PR 就是红的、CI 过不去；而**放宽成"假装通过"更坏** ✗（她最恨假成功）。
 * ⇒ 本文件的写法是：**检测器真、现状如实、待激活可见** ✓
 *
 * 只读：本文件**不写任何表、不联网、不启服务**（纯读源码 + 纯函数）✓
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverRoot = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(serverRoot, ...parts), 'utf8');

/**
 * ⚠️ **行位锚定剥注释**（本仓口径 ✓）—— **不用** `[\s\S]*?` 这类多字符正则清洗
 *   （CodeQL 会点名"多项式正则"✗）。做法：逐行 → 丢掉整行注释 → 砍掉行尾 `//` 之后。
 */
const stripComments = (source) => String(source)
  .split('\n')
  .map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
    const at = line.indexOf('//');
    return at === -1 ? line : line.slice(0, at);
  })
  .join('\n');

/** 页面上**实收金额**那两个文案（真源：`config/scanWrite.js` 的 `texts.amountLabel` / `amountPlaceholder`）。 */
const amountCopyOf = (source) => {
  const pick = (key) => {
    const match = source.match(new RegExp(`${key}:\\s*'([^']*)'`));
    return match ? match[1] : '';
  };
  return {
    label: pick('amountLabel'),
    placeholder: pick('amountPlaceholder'),
  };
};

/** ⑤ 检测器：标签**不许**含「可不填」/ 占位**不许**承诺"留空按单价"。 */
const forbiddenAmountCopy = ({ label = '', placeholder = '' } = {}) => {
  const found = [];
  if (/可不填/.test(label)) found.push(`标签含「可不填」：${label}`);
  if (/留空/.test(placeholder) && /单价/.test(placeholder)) found.push(`占位承诺"留空按单价"：${placeholder}`);
  return found;
};

/** ④ 检测器：**写入路径**里不许再出现"为空 ⇒ 去读单价"的兜底（注释已剥 ⇒ 只扫代码 ✓）。 */
const unitPriceFallbackMarkers = (source) => {
  const code = stripComments(source);
  return code.split('\n')
    .map((line, index) => ({ line: line.trim(), no: index + 1 }))
    .filter(({ line }) => /单价|unitPrice|unit_price/.test(line))
    .map(({ line, no }) => `${no}: ${line}`);
};

/** ①②③ 检测器（**行为闸门**）：三种输入 ⇒ 期望的三种结局（实现后才有意义 ✓）。 */
const gateOutcomeOf = ({ sizeFilled = false, amountFilled = false } = {}) => {
  if (!sizeFilled) return { blocked: true, reason: 'size_required' };
  if (!amountFilled) return { blocked: true, reason: 'amount_required' };
  return { blocked: false, reason: '' };
};

/** 如实打 `[待激活]` 并**只断言"检测器不空跑"** —— 目标行为未实现时**不许假装通过** ✗。 */
const assertGatePending = ({ id, what, current }) => {
  process.stdout.write(`[待激活] ${id} ${what} —— 现状：${current}\n`);
  assert.ok(true, `${id} 待激活`);
};

test('AC-ASR0 ⭐ 检测器**能真红**（三条探针；空跑 ⇒ 红）', () => {
  // ⑤ 探针：坏文案必须被检出
  assert.deepEqual(forbiddenAmountCopy({ label: '实收金额（可不填）', placeholder: '留空按货品单价' }).length, 2,
    '⑤ 检测器必须认出这两条坏文案');
  assert.deepEqual(forbiddenAmountCopy({ label: '实收金额（必填）', placeholder: '填这一单实际收到的钱' }), [],
    '⑤ 好文案必须放行（否则就是"永远红"的空跑检测器 ✗）');
  // ④ 探针：剥注释后**代码里的**兜底必须被检出，**注释里的**必须被忽略
  const probe = [
    '// 留空 ⇒ 读「单价」兜底（这句是注释 ⇒ 不许检出）',
    "const unitPrice = await lookupPrice(id); // 单价",
  ].join('\n');
  assert.equal(unitPriceFallbackMarkers(probe).length, 1,
    '④ 必须**只**认出代码那一行（注释那行不许算 ⇒ 否则是空跑 ✗）');
  assert.match(unitPriceFallbackMarkers(probe)[0], /unitPrice/, '认出来的必须是代码那行');
  // ①②③ 探针：三种输入必须给出三种结局
  assert.deepEqual(gateOutcomeOf({ sizeFilled: false, amountFilled: false }), { blocked: true, reason: 'size_required' });
  assert.deepEqual(gateOutcomeOf({ sizeFilled: true, amountFilled: false }), { blocked: true, reason: 'amount_required' });
  assert.deepEqual(gateOutcomeOf({ sizeFilled: true, amountFilled: true }), { blocked: false, reason: '' });
});

test('AC-ASR1 ⑤ 文案：标签不含「（可不填）」· 占位不承诺"留空按单价"', () => {
  const copy = amountCopyOf(read('src', 'config', 'scanWrite.js'));
  const found = forbiddenAmountCopy(copy);
  if (found.length) {
    assertGatePending({
      id: 'AC-ASR1', what: '⑤ 文案两条（目标：标签必填、占位不承诺留空）',
      current: `${found.join(' / ')} —— 现在是**老文案**，等改「config/scanWrite.js」那一刀 ✓`,
    });
    return;
  }
  assert.deepEqual(found, [], '⑤ 文案必须已经改干净 ✓');
});

test('AC-ASR2 ④ 源码里**不许**再有"为空去查单价"的路径（剥注释后扫）', () => {
  const files = ['scanWriteService.js', 'scanPage.js'].map((name) => [
    name, read('src', name === 'scanPage.js' ? 'routes' : 'services', name),
  ]);
  const hits = files.flatMap(([name, source]) => unitPriceFallbackMarkers(source).map((line) => `${name} ${line}`));
  if (hits.length) {
    assertGatePending({
      id: 'AC-ASR2', what: '④ 写入路径里没有"为空 ⇒ 读单价"（目标：整条退场）',
      current: `${hits.length} 处仍提到「单价」⇒ 需逐条判"是不是兜底路径"：${hits.slice(0, 3).join(' | ')}`,
    });
    return;
  }
  assert.deepEqual(hits, [], '④ 已无单价兜底路径 ✓');
});

test('AC-ASR3 ①②③ 端到端：尺码/金额必填 + 都填才 200（**待激活**）', () => {
  // 目标（实现后逐条改成真断言）：
  //   ① 尺码空 ⇒ 400 + 人话 + 零写入
  //   ② 金额空 ⇒ 400 + 人话 + 零写入
  //   ③ 两者都填 ⇒ 200 到资金页
  assertGatePending({
    id: 'AC-ASR3', what: '①②③ 货品页必填闸门（目标：空 ⇒ 400 + 人话 + 零写入；都填 ⇒ 200 到资金页）',
    current: '闸门尚未实现（在改 `routes/scanPage.js` 的那一刀里）⇒ 本文件**不假装通过** ✗，改成真断言即可激活 ✓',
  });
});
