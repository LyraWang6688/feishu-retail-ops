'use strict';

/**
 * 🔴🔴 2026-10-16（A2/A3 ② · 业务负责人**逐字**）：
 *   「（资金页那）三处提示【**全删**】……**全删就对了**」
 * ⇒ 结果页那句「要补实收 / 收款：去工作台「销售」那一页。」**连键带两处引用一起删** ✓
 *   · **键** = `config/scanWrite.js` 的 `texts.submittedNextSteps`（**已删** ⇒ 运行时 `undefined`）；
 *   · **两处引用** = `routes/scanPage.js` 的**跳过那条成功页**与**提交那条成功页**的 `details`（**已删**）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（下面每条 test 的名字 = 一条 AC）
 *   AC-SNS0 ⭐ **探针**：两个检测器**真能红**（喂"塞回来"的坏样本 ⇒ 必须报出来 ✓ 证明不是空跑）。
 *   AC-SNS1 🔴 **源码哨兵（路由）**：`routes/scanPage.js` 里**不许**再出现那个键名
 *           —— **塞回即红** ✓（Lead brief 里点名要的正是这一条）。
 *   AC-SNS2 🔴 **源码哨兵（路由）**：那句**中文**也不许再出现在路由里（塞回即红 ✓）。
 *   AC-SNS3 🔴 **配置哨兵**：运行时 `SCAN_WRITE.texts.submittedNextSteps === undefined`
 *           （键**真的**删了 —— 不是改成空串、更不是留个空壳 ✗：
 *            留空串 = 将来一句 `|| ''` 就能悄悄复活它 ✗）。
 * ─────────────────────────────────────────────────────────────────────────
 * ⚠️ 本文件**只读** `src/**`（只跑哨兵，不改实现 ✓）。
 * ⚠️ **同句还有一个落点**（`config/scanPage.js` 的 `paymentStep.workbenchHint`）**不在 A2/A3 写作用域**
 *   ⇒ 本文件**刻意不判它**（那是"成功页极简"那一刀的事 ✓；那边由 `test/skipPathsMinimal.test.js` 的
 *   AC-SK1 分阶段钉着 ⇒ 仍如实停在 [待激活]）—— 报在 PR 说明里，**不越界改** ✗。
 * ⚠️ **渲染面**（成功页 HTML 里真的不再出现那句）由 `test/scanSaleE2E.test.js` 的 **AC-E2E-14** 真判 ✓。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..');
const ROUTE_SRC = fs.readFileSync(path.join(SERVER, 'src/routes/scanPage.js'), 'utf8');

const { SCAN_WRITE } = require('../src/config/scanWrite');

/** 那个**已删**的文案键（键名**逐字**）。 */
const REMOVED_KEY = 'submittedNextSteps';
/** 那句**已删**的中文（逐字 —— 与 `config/scanWrite.js` 里"改前逐字"注记里引的**同一串**）。 */
const REMOVED_SENTENCE = '要补实收 / 收款：去工作台「销售」那一页。';

/** 检测器 ①：那个键名还出现在这份源码里吗？ */
const keySurvivors = (src) => (src.includes(REMOVED_KEY) ? [REMOVED_KEY] : []);
/** 检测器 ②：那句中文还出现在这份源码里吗？ */
const sentenceSurvivors = (src) => (src.includes(REMOVED_SENTENCE) ? [REMOVED_SENTENCE] : []);

test('AC-SNS0 ⭐ 探针：两个检测器**真能红**（塞回坏样本 ⇒ 必须报出来 ✓）', () => {
  assert.deepEqual(keySurvivors(`const ${REMOVED_KEY} = 'x';`), [REMOVED_KEY], '塞回键名 ⇒ 必须报红 ✓');
  assert.deepEqual(keySurvivors('const other = 1;'), [], '干净样本不许误报 ✓');
  assert.deepEqual(sentenceSurvivors(`details.push('${REMOVED_SENTENCE}')`), [REMOVED_SENTENCE],
    '塞回那句 ⇒ 必须报红 ✓');
  assert.deepEqual(sentenceSurvivors('details.push("别的");'), [], '干净样本不许误报 ✓');
});

test('AC-SNS1 🔴 源码哨兵：路由里**不再出现**那个文案键（塞回即红 ✓）', () => {
  assert.deepEqual(keySurvivors(ROUTE_SRC), [],
    '改前逐字（**两处**，都在 `routes/scanPage.js` 的 `details` 里）：\n'
    + `  \`...(writeConfig.texts.${REMOVED_KEY} ? [writeConfig.texts.${REMOVED_KEY}] : []),\`（跳过那条成功页）\n`
    + `  \`...(texts.${REMOVED_KEY} ? [texts.${REMOVED_KEY}] : []),\`（提交那条成功页）\n`
    + '改后逐字：**两处都删了**（各留一条说明"为什么删"的注记 ✓ 注记里**不引**这个键名 ✗）\n'
    + '依据：业务负责人 2026-10-16 逐字「（资金页那）三处提示【全删】……全删就对了」');
});

test('AC-SNS2 🔴 源码哨兵：路由里**不再出现**那句中文（塞回即红 ✓）', () => {
  assert.deepEqual(sentenceSurvivors(ROUTE_SRC), [],
    `改前逐字（配置里的那句，只经路由渲染到成功页）：\`${REMOVED_SENTENCE}\`\n`
    + '改后逐字：路由里**一个字都不剩**（键已删 ⇒ 两处引用也无处可取 ✓）\n'
    + '依据：同上（她点名"全删"）；**渲染面**另有判据 = `test/scanSaleE2E.test.js` 的 AC-E2E-14 ✓');
});

test('AC-SNS3 🔴 配置哨兵：`texts` 里那个键**真的没了**（不是空串、不是空壳 ✗）', () => {
  assert.equal(SCAN_WRITE.texts[REMOVED_KEY], undefined,
    `改前逐字：\`${REMOVED_KEY}: '${REMOVED_SENTENCE}',\`\n`
    + '改后逐字：**键不存在**（`undefined`）—— ⚠️ 留空串等于"留个壳"：将来一句 `|| \'\'` 就能复活它 ✗\n'
    + '依据：业务负责人 2026-10-16 逐字「全删就对了」');
});
