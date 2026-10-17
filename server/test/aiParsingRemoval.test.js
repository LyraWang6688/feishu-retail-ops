/**
 * ⭐⭐ 「与 AI 分析有关的都停掉」—— **删完之后的源码哨兵**（2026-10-16）。
 *
 * 【业务负责人的口径（逐字）】
 *   「**都停掉，与 AI 分析有关的都停掉**，目前我们就是**扫码和表单或者在前端 UI 交互**，
 *    **其余录入方式不支持**」
 *   追问后：① **停掉自动出单** ② **连代码一起删**（照她 2026-10-07 停私聊那次「代码里一行私聊都不留」）。
 *
 * 【为什么这一刀是"删死代码"而不是"停活链路"】（Lead 只读盘点，已核 ✓）
 *   · 采购「AI 解析 → 自动出单」**2026-10-09 就已删除**（PR #308）；
 *   · 群聊销售文字入口 **2026-10-12 已退场**（`acceptMessage` 群分支只记一条日志就 return）；
 *   · ⇒ **当前运行期没有任何可达的 AI 解析调用**。
 *
 * ⭐ 本文件把验收标准逐条钉住（断言名 = 验收标准；⚠️ 注释里写清"能真红"的那一刀）：
 *   ① AI 解析的**文件**在仓库里 0 残留（`doubaoService` / 五个 AI 专属 config）
 *   ② 代码侧（去注释后）**0 命中** AI 关键词：`parseSalesText` / `parseArrivalReconciliation` /
 *      `TEXT_LLM` / `recognizer` / `doubaoService` / `isSalesCandidate` / `normalizeSalesResult` …
 *   ③ `larkMvpService` 里**没有** recognizer 接线；`purchaseArrivalConversationService` 里**没有**
 *      `handleTopicMessage` / `trimTranscript`
 *   ④ `.env.example` 里 `TEXT_LLM_*` 族 0 残留
 *   ⑤ ⭐ **反方向（B 类保留清单，一个字都不许被误杀）**：采购发布链路 · 卡片动作骨架（含未知动作
 *      兜底）· `completeDealFromCard` · 扫码链路 · 共享落库层 · 9 点推送 全部**仍在**
 *   ⑥ ⚠️ **不碰冻结文件**：`scanWriteService.js` **逐字节未动**
 *
 * ⚠️ 本文件自己就是"抓这些词"的那把尺子 ⇒ 扫描时**跳过自己**
 *    （与 `purchaseIntakeRetired.test.js` ① / `prunedResidueSentinel.test.js` 同一个做法）。
 * ⚠️ 扫描前**去注释**：沿革要留在注释里（"那条链路 2026-10-09 退场"），那不算残留 ✗
 *    （与 `prunedResidueSentinel.test.js` 的"代码侧"口径一致）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(SERVER_ROOT, '..');
// ⚠️ 本文件自己就是那把尺子（字符串里必然出现这些词）⇒ 扫描时**按仓库根相对路径跳过自己**。
const SELF = path.join('server', 'test', 'aiParsingRemoval.test.js');

const exists = (rel) => fs.existsSync(path.join(REPO_ROOT, rel));
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** 去注释：沿革写在注释里是**应当的**，不算代码残留（口径同 prunedResidueSentinel）。 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

/**
 * 代码侧扫描面：src / test / scripts / public / tools + package.json。
 * ⚠️ **`.env.example` 刻意不在这一面里**：它是**配置模板**（沿革注释里写"那一族已删"是应当的，
 *    与 `docs/` 同一性质）⇒ 它的判据是 AC-6 的**配置行**（`KEY=` 形态），不是标识符 ✗
 */
const codeFiles = () => {
  const files = [];
  for (const dir of ['server/src', 'server/test', 'server/scripts', 'server/public', 'tools', 'server/package.json']) {
    const full = path.join(REPO_ROOT, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      walk(full, files);
    } else if (fs.existsSync(full)) {
      files.push(full);
    }
  }
  return files
    .filter((full) => !full.endsWith(SELF))
    .filter((full) => !full.includes('hardcodedChineseWhitelist.json'));
};

/** 某个词在**代码侧（去注释）**的命中清单。 */
const codeHits = (needle) => {
  const hits = [];
  for (const full of codeFiles()) {
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    if (!raw.includes(needle)) continue;
    const stripped = stripComments(raw);
    if (!stripped.includes(needle)) continue;
    const rel = path.relative(REPO_ROOT, full);
    stripped.split('\n').forEach((line, index) => {
      if (line.includes(needle)) hits.push(`${rel}:${index + 1}  ${line.trim()}`);
    });
  }
  return hits;
};

const sha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, rel))).digest('hex');

// ═══════════════════════════════════════════════════════════════════════════
// ① AI 解析的**文件**在仓库里 0 残留
// ═══════════════════════════════════════════════════════════════════════════

test('AC-1 ⭐ AI 解析的六个文件已删（能真红：把任一个文件放回 ⇒ 红）', () => {
  const deleted = [
    'server/src/services/doubaoService.js',
    'server/src/config/messageGate.js',
    'server/src/config/saleIntents.js',
    'server/src/config/salesDepositTerms.js',
    'server/src/config/salesMissingInfoText.js',
    'server/src/config/llmModels.js',
  ];
  for (const rel of deleted) {
    assert.equal(exists(rel), false, `⛔ ${rel} 不该还在（依据=她 2026-10-16 逐字「连代码一起删」）✗`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 代码侧（去注释后）0 命中 AI 关键词
// ═══════════════════════════════════════════════════════════════════════════

test('AC-2 ⭐ AI 解析入口 / 模型配置在代码侧 0 残留（能真红：任塞回一个词 ⇒ 红）', () => {
  const needles = [
    'parseSalesText',
    'parseArrivalReconciliation',
    'parsePurchaseReportText',
    'doubaoService',
    'normalizeSalesResult',
    'normalizeAfterSalesResult',
    'isSalesCandidate',
    'detectBareAllArrivedStatement',
    'detectBareAllArrivedTranscript',
  ];
  // ⚠️ 上面的词是**代码标识符**（塞回一句就红 ✓）。
  //    下面这三个是**文件路径**：沿革注释里写"那个文件已删"是**应当的**（照 `.env.example`
  //    与 `docs/` 的先例）⇒ 只在**出现可执行引用**的形态上判红（`require(...)`）。
  const requiredPaths = [
    'config/messageGate',
    'config/saleIntents',
    'config/salesDepositTerms',
    'config/salesMissingInfoText',
    'config/llmModels',
    'services/doubaoService',
  ];
  const failures = [];
  for (const needle of needles) {
    const hits = codeHits(needle);
    if (hits.length) failures.push(`⛔ 「${needle}」还有 ${hits.length} 处：\n    ${hits.slice(0, 6).join('\n    ')}`);
  }
  for (const rel of requiredPaths) {
    const hits = codeHits(`'${rel}'`).concat(codeHits(`"${rel}"`));
    if (hits.length) failures.push(`⛔ 还有人 require 已删的 ${rel} ✗：\n    ${hits.slice(0, 4).join('\n    ')}`);
  }
  assert.equal(failures.length, 0, `AI 解析残留（依据=她 2026-10-16「连代码一起删」）：\n${failures.join('\n')}`);
});

test('AC-3 ⭐ `recognizer` 注入点已清零（能真红：把哪个 constructor 的 recognizer 塞回 ⇒ 红）', () => {
  const hits = codeHits('recognizer');
  assert.equal(hits.length, 0, `⛔ 不该再有 recognizer 接线：\n    ${hits.slice(0, 10).join('\n    ')}`);
});

test('AC-4 ⭐ `larkMvpService` 不再 require / 接线 AI（能真红：把那一行 require 塞回 ⇒ 红）', () => {
  const source = stripComments(read('server/src/services/larkMvpService.js'));
  assert.equal(source.includes('doubaoService'), false, '⛔ 不许再 require doubaoService ✗');
  assert.equal(source.includes('recognizer'), false, '⛔ 不许再把 recognizer 传给别人 ✗');
  // ⚠️ 这三个 import 在删之前就已经**没有任何调用方**（清群聊入口后成了孤儿）
  //    ⇒ 文件删掉后它们必须一起消失，否则 require 会直接抛 MODULE_NOT_FOUND。
  for (const dead of ['renderSalesMissingInfo', 'UNSUPPORTED_INTENT_REPLY', 'isAfterSalesIntent', 'normalizeMessageIntent']) {
    assert.equal(source.includes(dead), false, `⛔ 孤儿 import 不许留：${dead} ✗`);
  }
});

test('AC-5 ⭐ 到货会话 service 只留"确认"那一半：话题解析方法已删（能真红：塞回 handleTopicMessage ⇒ 红）', () => {
  const source = stripComments(read('server/src/services/purchaseArrivalConversationService.js'));
  for (const gone of ['handleTopicMessage', 'handleTopicMessageLocked', 'trimTranscript']) {
    assert.equal(source.includes(gone), false, `⛔ 「${gone}」是话题文字解析那一半，必须随 AI 解析一起删 ✗`);
  }
  // ⭐ 保留清单（B 类）：确认链路本体与它读请求行的能力**必须还在**。
  for (const kept of ['confirmLocked', 'confirmBatchArrival', 'buildPlan', 'loadRequestRows']) {
    assert.equal(source.includes(kept), true, `⛔ 保留清单里的「${kept}」被误删了 ✗`);
  }
});

test('AC-6 `.env.example` 的 `TEXT_LLM_*` 族已删（能真红：把那一行塞回 ⇒ 红）', () => {
  const env = read('.env.example');
  // ⚠️ 只钉**可执行的配置行**（`KEY=` 形态）—— 沿革注释里写"这一族已删、变量名不再列出"
  //    是**应当的**（与 `.env.example` 其余"已删除"注释同一写法）⇒ 不拿裸词判红 ✗
  assert.equal(/^TEXT_LLM[A-Z_]*=/m.test(env), false, '⛔ .env.example 不该再有 TEXT_LLM* 的配置行 ✗');
  // ⭐ 反方向：`SALES_MISSING_INFO_*` 那一族（服务 AI 解析缺项追问）同样**配置行**清零 ✓
  assert.equal(/^SALES_MISSING_INFO[A-Z_]*=/m.test(env), false,
    '⛔ SALES_MISSING_INFO_* 的配置行也该清零（渲染它的配置模块已删）✗');
  // ⭐ 保留清单（B 类）：采购群通知那一族**仍在**（它服务的是现役出图/发群链路）
  assert.ok((env.match(/^PURCHASE_GROUP_NOTICE_/gm) || []).length >= 3, 'PURCHASE_GROUP_NOTICE_* 族必须还在 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ ⭐ 反方向：B 类保留清单一个字都不许被误杀
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7 ⭐⭐ 反方向：采购发布链路 / 表变更入口仍在（能真红：删掉 publishPurchaseRequest ⇒ 红）', () => {
  const webhook = read('server/src/services/purchaseWebhookService.js');
  // 采购申请的人工入口 = 扫码页「补货」；它调的仍是这条现役链路，**免确认**。
  assert.match(webhook, /publishPurchaseRequest\s*\(/, '⛔ 采购发布链路必须还在（扫码补货在用）✗');
  assert.match(webhook, /confirmArrival\s*\(/, '⛔ 到货确认本体必须还在 ✗');
  // 表变更事件入口本身
  const events = read('server/src/routes/larkEvents.js');
  assert.match(events, /bitable_record_changed/, '⛔ 表变更事件入口本身必须还在 ✗');
});

test('AC-8 ⭐⭐ 反方向：卡片动作骨架（含未知动作兜底人话）仍在（能真红：删掉 unknownCardAction ⇒ 红）', () => {
  const lark = read('server/src/services/larkMvpService.js');
  assert.match(lark, /handleCardAction\s*\(/, '⛔ 卡片动作骨架必须还在 ✗');
  assert.equal(exists('server/src/config/unknownCardAction.js'), true, '⛔ 未知动作兜底人话必须还在 ✗');
  const unknown = read('server/src/config/unknownCardAction.js');
  assert.match(unknown, /UNKNOWN_CARD_ACTION_TOAST/, '⛔ 兜底文案常量必须还在 ✗');
  // 「确认成交」卡的按钮动作（她 2026-10-07 拍板的甲）
  assert.match(lark, /completeDealFromCard|confirm_deal/, '⛔ 确认成交那条卡动作必须还在 ✗');
});

test('AC-9 ⭐⭐ 反方向：`salesThreadProgressService.completeDealFromCard` 仍在（能真红：删掉它 ⇒ 红）', () => {
  const source = read('server/src/services/salesThreadProgressService.js');
  assert.match(source, /completeDealFromCard\s*\(/, '⛔ 确认成交（卡片按钮那条可达链路）必须还在 ✗');
});

test('AC-10 ⭐⭐ 反方向：扫码链路 / 共享落库层 / 9 点推送 / 配品销售仍在（能真红：删掉任一个 ⇒ 红）', () => {
  const mustExist = [
    'server/src/services/scanArrivalService.js',
    'server/src/services/scanWriteService.js',
    'server/src/services/v1PostingService.js',
    'server/src/services/v1BitableGateway.js',
    'server/src/services/accessorySaleIntakeService.js',
    'server/src/config/salesMovements.js',
    'server/src/config/salesTradeTypePolicy.js',
    'server/src/services/pendingDealPushService.js',
  ];
  for (const rel of mustExist) assert.equal(exists(rel), true, `⛔ 保留清单里的 ${rel} 被误删了 ✗`);
  // ⭐ 2026-10-17 迁移（业务负责人：「到货单已经不用了」＋「货品建档唯一路径 = 工作台货品上新表单」）：
  //   改前逐字：断言到货链路仍挂着「建档 + 成本」（`ensureArrivalProducts` 必须还在）。
  //   改后逐字：两者**已按 A 方案整条删除** ⇒ 这里反过来钉"不许复活"（塞回即红）。
  //   依据：到货单/价格识别退场后 `task.recognized` 无生产写入点、`pending_creation` 恒空；
  //   判据见 `server/test/arrivalCostRemoved.test.js`。本条其余保留项一个字没动 ✗（不是放宽）。
  const webhook = read('server/src/services/purchaseWebhookService.js');
  assert.equal(/ensureArrivalProducts\s*\(/.test(webhook), false, '⛔ 到货建档死代码不许复活 ✗');
  assert.equal(/applyArrivalCost\s*\(/.test(webhook), false, '⛔ 到货成本死代码不许复活 ✗');
  // 配品销售的两条链路
  assert.equal(exists('server/src/services/accessoryMatchPolicy.js'), true, '⛔ 配品匹配必须还在 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ ⚠️ 冻结文件：逐字节未动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-12 🔴 依赖侧也不许把 AI SDK 带回来（能真红：把 openai 塞回 dependencies ⇒ 红）', () => {
  // ⚠️ 任务书写的是"补 AC-11"，但 AC-11 已被上面的冻结文件用例占用 ⇒ 顺延为 AC-12。
  //   为什么要有这条：既有哨兵扫的是**代码标识符**（`doubaoService` / `parseSalesText` …），
  //   抓不到**包名** —— `package.json` 里留着 `openai` 这种依赖，谁哪天 import 就复活了一条 AI 链路。
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'server/package.json'), 'utf8'));
  const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const banned of ['openai', 'doubao', 'volcengine-sdk', 'langchain']) {
    assert.equal(Object.prototype.hasOwnProperty.call(all, banned), false,
      `⛔ 依赖里不许出现 AI SDK 包名「${banned}」（塞回 ⇒ 红）`);
  }
});

test('AC-11 🔴 冻结文件 `scanWriteService.js` 逐字节未动（能真红：改一个字 ⇒ 红）', () => {
  // 基线 = **本次任务开工时的 origin/main** 内容（2026-10-16，`git show HEAD:` 读得到）。
  // ⚠️ 这条同时挡住"顺手把里面的注释也改了" —— 她的口径是**一个字都不许碰** ✗
  // ⚠️ 用 git 读取而**不是**把哈希写死在测试里：写死的话"改文件 + 改哈希"就能一起过 ✗
  const { execFileSync } = require('node:child_process');
  const head = execFileSync('git', ['show', 'HEAD:server/src/services/scanWriteService.js'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
  const worktree = fs.readFileSync(path.join(REPO_ROOT, 'server/src/services/scanWriteService.js'), 'utf8');
  assert.equal(worktree, head, '⛔ scanWriteService.js 与 HEAD 不一致 ⇒ 谁改了一个字 ✗');
  assert.equal(sha256('server/src/services/scanWriteService.js'), crypto.createHash('sha256').update(head).digest('hex'));
  // ⚠️ 它里面**本来就没有 AI 代码**（只有 `:21` 一句注释）⇒ 本任务根本不需要碰它 ✓
  assert.equal(/doubaoService|recognizer|parseSalesText/.test(worktree.replace(/^\s*\/\/.*$/gm, '')), false,
    '⛔ scanWriteService.js 里从来不该有 AI 代码 ✗');
});
