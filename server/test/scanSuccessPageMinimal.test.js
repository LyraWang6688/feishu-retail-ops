'use strict';

/**
 * ⭐⭐ **提交成功页 · 统一极简**的验收判据（task-52 收尾 · 业务负责人 2026-10-16 逐字）。
 *
 * 她的原话：
 *   「用户提交之后**都是一个成功页**，说"**已提交成功，数据会更新**"类似这类的话就行了。
 *     **都是一个异步的提醒**，告诉系统已经接收到用户提交的这单了」
 *   「**不需要做任何跳转，也不需要做任何链接**」
 *
 * 判据（**先写后做** ✓ 每条都能真红 ✓）：
 *   **AC-MS-P1**：⭐ **四条链**（销售 / 补货 / 退货 / 验收）在开关打开时 ⇒
 *     ① **同一句话**（`minimalText` ✓ 与链无关 ✓）② **一个 `<a>` / `<button>` 都没有** ✓
 *     ③ **没有 `<meta http-equiv="refresh">`**（**不跳转** ✓）
 *   **AC-MS-P2**：⭐ **零回归** ⇒ 开关关着（缺省 ✓）时，成功页**与改前的形状逐字一致**
 *     （那颗 `data-view="success-return"` 链接、`refresh`、她给的原句、追加动作块**都还在** ✓）
 *   **AC-MS-P3**：⭐ **配置先行** ⇒ 开关/文案只从 `config/scanSuccessPage.js` 来 ✓
 *     且**显式布尔 · 缺省 false** ✓、**没有 `process.env.X || 默认值` 那种"关不掉"的写法** ✗
 *
 * ⚠️ 四条链在这里是**同一族渲染调用**（`renderScanMessagePage({ tone:'success', … })` ✓）：
 *   标题/事实各异 ✓ 但"那一句 + 不跳不链接"**必须一致** ✓。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderScanMessagePage } = require('../src/views/scanPage');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_SUCCESS_PAGE, minimalSuccessOverrides, DEFAULT_MINIMAL_TEXT } = require('../src/config/scanSuccessPage');

/** 四条链各自"成功页现在的样子"（标题/事实各异 ✓ 链接与自动跳转**都有** ✓）。 */
const CHAINS = [
  {
    chain: '销售',
    params: {
      tone: 'success', title: '本单已提交成功', body: '本单已提交成功（销售）', number: 'XSD-20261016-001',
      details: ['2 双', '合计 1,960 元'], backPath: '/s/XSD-20261016-001', backLabel: '返回扫码页',
      returnPath: '/s/XSD-20261016-001', returnLabel: '返回扫码页', returnDelaySeconds: 3,
      autoReturnUrl: '/s/XSD-20261016-001', extraActionsHtml: '<a href="/workbench">去工作台补收款</a>',
    },
  },
  {
    chain: '补货',
    params: {
      tone: 'success', title: '补货已提交成功', body: '补货已提交成功', number: 'BH-20261016-0001',
      details: ['3 双'], backPath: '/p/BH-20261016-0001', backLabel: '返回扫码页',
      returnPath: '/p/BH-20261016-0001', returnLabel: '返回扫码页', returnDelaySeconds: 3,
      autoReturnUrl: '/p/BH-20261016-0001', extraActionsHtml: '<a href="/workbench">去工作台</a>',
    },
  },
  {
    chain: '退货',
    params: {
      tone: 'success', title: '退货已提交成功', body: '退货已提交成功', number: 'TH-20261016-0001',
      details: ['1 双'], backPath: '/r/TH-20261016-0001', backLabel: '返回扫码页',
      returnPath: '/r/TH-20261016-0001', returnLabel: '返回扫码页', returnDelaySeconds: 3,
      autoReturnUrl: '/r/TH-20261016-0001', extraActionsHtml: '<a href="/workbench">去工作台</a>',
    },
  },
  {
    chain: '验收',
    params: {
      tone: 'success', title: '验收已提交成功', body: '验收已提交成功', number: 'BH-20261016-0002',
      details: ['5 双'], backPath: '/a/BH-20261016-0002', backLabel: '返回扫码页',
      returnPath: '/a/BH-20261016-0002', returnLabel: '返回扫码页', returnDelaySeconds: 3,
      autoReturnUrl: '/a/BH-20261016-0002', extraActionsHtml: '<a href="/workbench">去工作台</a>',
    },
  },
];

/** 只用来数"跳走/链接"的痕迹 ✓（⚠️ 不用正则吞注释那类写法 ✗ —— 这里数的是真实标签 ✓）。 */
const linkCount = (html) => (html.match(/<a\s/g) || []).length;
const buttonCount = (html) => (html.match(/<button/g) || []).length;
const refreshCount = (html) => (html.match(/http-equiv="refresh"/g) || []).length;

const MINIMAL = { minimalEnabled: true, minimalText: '已提交成功，数据会更新' };

test('AC-MS-P1 ⭐⭐ 四条链：同一句话 ＋ **零链接零按钮零跳转**', () => {
  const bodies = new Set();
  for (const { chain, params } of CHAINS) {
    const html = renderScanMessagePage({ ...params, successPage: MINIMAL });
    assert.ok(html.includes(MINIMAL.minimalText), `${chain}：必须有那一句「${MINIMAL.minimalText}」✗`);
    assert.equal(linkCount(html), 0, `${chain}：不许有任何 <a> ✗（她："不需要做任何链接"）`);
    assert.equal(buttonCount(html), 0, `${chain}：不许有任何 <button> ✗`);
    assert.equal(refreshCount(html), 0, `${chain}：不许自动跳转（meta refresh）✗（她："不需要做任何跳转"）`);
    // ⭐ 她给的那几样"事实"不再占成功页（进日志 ✓ 不占页面 ✗）
    assert.equal(html.includes(params.number), false, `${chain}：极简成功页不该再渲染单号 ✗`);
    assert.equal(html.includes(params.extraActionsHtml), false, `${chain}：追加动作块也清 ✗`);
    assert.ok(html.includes(params.title), `${chain}：标题照旧保留 ✓（她要统一的是"那句话"✓ 不是标题 ✗）`);
    bodies.add(new RegExp(`<p>([^<]*)</p>`).exec(html)[1]);
  }
  assert.equal(bodies.size, 1, `四条链的那句话必须是**同一句** ✗（实得 ${bodies.size} 种）`);
  assert.equal([...bodies][0], MINIMAL.minimalText);
});

test('AC-MS-P2 ⭐⭐ 迁移后：**成功页永远极简**（没有开关 ✓ 只剩一条路 ✓）', () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`AC-MS-P2 ⭐⭐ 零回归：开关关着（缺省）⇒ 成功页形状逐字不变`
  //     （`renderScanMessagePage(params)` 与"显式关"两种调用逐字相同 ＋ 断言"那颗链接 / refresh / 她给的原句**都还在**"）
  //   改后逐字：本用例 —— 开关退场 ⇒ 改钉"**默认渲染 = 显式配极简**（只剩一条路 ✓）＋ 零链接零跳转 ＋ 统一那一句"
  //   依据 = 业务负责人 2026-10-16 22:5x 逐字：「**……把新功能都上了，不需要开关。**」✓
  //   ⚠️ **强度不降**：仍是**整页逐字**（`assert.equal` 两个方向的渲染）＋ 行为断言（零 offender）✓
  for (const { chain, params } of CHAINS) {
    const byDefault = renderScanMessagePage(params);
    const byExplicit = renderScanMessagePage({ ...params, successPage: { minimalText: SCAN_SUCCESS_PAGE.minimalText } });
    assert.equal(byDefault, byExplicit, `${chain}：默认渲染与"显式配极简"必须**逐字相同**（只剩一条路 ✓）`);
    assert.ok(byDefault.includes(DEFAULT_MINIMAL_TEXT), `${chain}：必须有那句统一的「${DEFAULT_MINIMAL_TEXT}」✓`);
    assert.equal(byDefault.includes('data-view="success-return"'), false, `${chain}：那颗回跳链接**不许在** ✗`);
    assert.equal(refreshCount(byDefault), 0, `${chain}：自动跳转**不许在** ✗`);
    assert.equal(/<a\s[^>]*href=/i.test(byDefault), false, `${chain}：一个 a-href 都不许有 ✗`);
    assert.equal(/<button\b/i.test(byDefault), false, `${chain}：一个 button 都不许有 ✗`);
    // ⭐ 更强的一条（不靠"某句是不是子串"）：**payload 里的 body 被统一那句覆盖**
    //   ⇒ 塞一个哨兵正文进去，页面必须**逐字不变** ✓（她给的原句不再决定这一页 ✓）
    const withSentinelBody = renderScanMessagePage({ ...params, body: 'ZZ-哨兵正文' }, SCAN_PAGE);
    assert.equal(withSentinelBody, byDefault,
      `${chain}：成功页的正文=统一那句（payload 里的 body 已不起作用 ✓）`);
  }
});

test('AC-MS-P3 ⭐⭐ 反向哨兵：**没有开关了**（开关名/`readFlag` 回来即红 ✓）＋ 禁 `||` 兜底', () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`assert.ok(/readFlag\(env, 'SCAN_SUCCESS_PAGE_MINIMAL_ENABLED', false\)/.test(src), '开关必须是 readFlag …')`
  //   改后逐字：本用例 —— **钉"开关不许回来"** ＋ 钉"永远极简"的行为（强度不降 ✓）
  //   依据 = 业务负责人 2026-10-16 22:5x 逐字：「**以后你不用有"开关"的这个思维……把新功能都上了，不需要开关。**」✓
  const file = path.join(__dirname, '..', 'src', 'config', 'scanSuccessPage.js');
  const raw = fs.readFileSync(file, 'utf8');
  // ⚠️ **先去掉注释**再判 ✗ —— 本文件的头部注释里**逐字引用了**那个开关名（留痕 ✓）
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const SWITCH_NAME = ['SCAN', 'SUCCESS', 'PAGE', 'MINIMAL', 'ENABLED'].join('_');
  assert.equal(src.includes(SWITCH_NAME), false,
    '🔴 开关名**不许回来**（她 22:5x：「不需要开关」）');
  assert.equal(/readFlag\(/.test(src), false, '🔴 这里不再有开关 ⇒ 也不该再有 `readFlag` ✗');
  assert.equal(/process\.env\.[A-Z_]+\s*\|\|/.test(src), false,
    '不许 `process.env.X || 默认值` ✗（`||` 会让"清空变量"回退默认 ⇒ 关不掉 ✗）');
  assert.ok(DEFAULT_MINIMAL_TEXT.length > 0 && src.includes(DEFAULT_MINIMAL_TEXT),
    '缺省那句必须在配置真源里 ✓（别处不许再抄一份 ✗）');
});

test('AC-MS-P3b ⭐⭐ 正向钉：**没有任何开关也能生效**（极简覆盖值永远返回 ✓）', () => {
  // eslint-disable-next-line global-require
  const { minimalSuccessOverrides } = require('../src/config/scanSuccessPage');
  const overrides = minimalSuccessOverrides({ minimalText: 'XX' });
  assert.equal(overrides.body, 'XX', '传了文案 ⇒ 用它 ✓');
  for (const key of ['backPath', 'backLabel', 'backHint', 'returnPath', 'returnLabel', 'autoReturnUrl', 'extraActionsHtml']) {
    assert.equal(overrides[key], '', `${key} 必须被清空（她不跳走、不链接 ✓）`);
  }
  assert.deepEqual(overrides.details, [], '`details` 清空（"就一句话" ✓）');
  assert.equal(overrides.returnDelaySeconds, 0, '不自动回跳 ✓');
  assert.equal(minimalSuccessOverrides({}).body, '已提交成功，数据会更新', '没给文案 ⇒ 缺省那句 ✓');
});
