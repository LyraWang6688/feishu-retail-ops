'use strict';

require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）

/**
 * saleAmountAndSizeRequired.e2e.test.js —— 「实收金额**必填** + 尺码**必填**」的判据（货品页那一层）
 *
 * 她的口径（2026-10-16 逐字）：
 * > 「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
 * >  才可以点击提交跳转到资金页，**不用做那个为空去单价的功能了**」
 *
 * ⭐⭐ **2026-10-16 迁移**：原来 ①②③⑤ 是 **4 条"自足替身闸门"**（只打 `[待激活]` 的 `assertGatePending(...)`，
 *   **不 import 实现、不读真配置** ⇒ **永远不会变真** ✗）——
 *   · 改前逐字：`assertGatePending({ id: 'AC-ASR1' … })` ／ `assertGatePending({ id: 'AC-ASR3' … })`
 *   · 改后逐字：**删掉那两个 `[待激活]` 壳** ⇒ 换成**对真实产物**的断言（真配置 `SCAN_WRITE.texts` /
 *     `MULTI_ITEM_ORDER.chains` / `services/scanWriteService.js` 真源码）＋ **覆盖证明**（覆盖者的 AC 名必须存在 ✓）
 *   · 依据：① 她 **2026-10-16** 逐字（「实收金额必须填写」「填了尺码和金额才可以提交」「不用做那个为空去单价的功能了」
 *     ＋「补货不需要金额」）② 实现**已落地**（`config/scanWrite.js` 文案已改 / `chains[*].amountRequired` 已分档 /
 *     `scanWriteService` 的 `size_missing` 路径在）③ 行为覆盖者在 `test/purchaseAmountByRealm.test.js`（`AC-AR5`/`AC-AR6`）✓
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
/** ⭐ 迁移后：**真读真实产物**（配置 + 源码）—— 不再是"文件内自造 lambda" ✓ */
const { SCAN_WRITE } = require(path.join(serverRoot, 'src', 'config', 'scanWrite.js'));
const { MULTI_ITEM_ORDER } = require(path.join(serverRoot, 'src', 'config', 'multiItemOrder.js'));
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

test('AC-ASR1 🔴 ⑤ 真判据：真实配置里**不再有**那句旧文案（标签必填、占位不承诺留空 ✓）', () => {
  const copy = { label: SCAN_WRITE.texts.amountLabel, placeholder: SCAN_WRITE.texts.amountPlaceholder };
  assert.deepEqual(forbiddenAmountCopy(copy), [],
    '🔴 真实配置的 `amountLabel` / `amountPlaceholder` 里不许再有「可不填」或"留空按单价" ✗（她 2026-10-16「不用做那个为空去单价的功能了」）');
  assert.equal(/可不填/.test(copy.label), false, '标签不许再写「（可不填）」✓');
});

test('AC-ASR2 ④ 源码里**不许**再有"为空去查单价"的路径（剥注释后扫）', () => {
  const files = ['scanWriteService.js', 'scanPage.js'].map((name) => [
    name, read('src', name === 'scanPage.js' ? 'routes' : 'services', name),
  ]);
  const hits = files.flatMap(([name, source]) => unitPriceFallbackMarkers(source).map((line) => `${name} ${line}`));
  // ⭐ 迁移后：**硬断言**（实测真实源码 0 处 ⇒ 不是空跑 ✓）
  assert.deepEqual(hits, [], '🔴 写入路径里不许再有「单价」兜底（她 2026-10-16「不用做那个为空去单价的功能了」）');
});

test('AC-ASR3 🔴 ①②③ 真判据：分档/必填**读真实配置与真实源码** ＋ 覆盖证明', () => {
  // ① 金额必填按链路分档（她口径：**补货不需要金额** ✓ / 退货需要 ✓）
  const chains = MULTI_ITEM_ORDER.chains || {};
  assert.equal(chains.replenish?.amountRequired, false, '补货：**不要求金额**（她：「补货不需要金额」✓）');
  assert.equal(chains.return?.amountRequired, true, '退货：**要求金额** ✓');
  // ② 尺码必填：真实写服务里有 `size_missing` 的**拦截路径**（不是自造物 ✓）
  const writeService = fs.readFileSync(path.join(serverRoot, 'src', 'services', 'scanWriteService.js'), 'utf8');
  assert.match(writeService, /size_missing/, '真实写服务里必须有 `size_missing` 的拦截 ✓');
  // ③ 覆盖证明：**行为**覆盖者必须真的存在（改名/删掉 ⇒ 红 ✓）
  const COVERAGE = Object.freeze([
    ['① 尺码/金额必填的端到端（补货不拦金额）', ['AC-AR5']],
    ['② 退货金额必填仍拦住', ['AC-AR6']],
    ['③ 不再读单价兜底', ['AC-ASR2']],
  ]);
  const byRealm = fs.readFileSync(path.join(serverRoot, 'test', 'purchaseAmountByRealm.test.js'), 'utf8');
  const self = fs.readFileSync(__filename, 'utf8');
  for (const [rule, covers] of COVERAGE) {
    for (const id of covers) {
      const source = id === 'AC-ASR2' ? self : byRealm;
      assert.ok(new RegExp(`test\\(['"\`]${id}\\b`).test(source),
        `🔴 ${rule} 的覆盖者 ${id} 不存在 ✗（改名/删掉 ⇒ 红 ✓）`);
    }
  }
  // 🔴 本文件不许再有打印「待激活」的壳（正文引历史写法允许 ✓）
  assert.equal(/^\s*console\.log\('[^']*待激活/m.test(self), false, '不许再有打印「待激活」的 console.log ✗');
  assert.equal(/^\s*assertGatePending\(/m.test(self), false, '不许再有 `assertGatePending(` 的壳 ✗');
});
