'use strict';

/**
 * ⭐⭐ 2026-10-15（task-39 · 她逐字：「这个是目前所有的功能了，**和这些功能无关的代码都可以删除了**」）
 *
 * 本文件 = **删完之后的源码哨兵**：删掉的符号 / 键 / 文件在仓库里**必须 0 残留** ✓
 *   （塞回一个 ⇒ 这里**真红** ✗ —— 每条断言后面都写了"能真红"的那一刀）
 * ⚠️ 同时钉住**反方向**：那几个「按前缀动态拼」的族**一个都不许被误杀** ✗（审计 §7.1）
 *
 * 依据：`docs/architecture-audit-2026-10-15.md` §3.2（待删-1/2/3）+ §7（前缀族）
 * 判据迁移（逐字）：
 *   · 待删-1 `sales:sample` ⇒ 指向**不存在**的文件 ⇒ 无业务判据（去掉一个坏入口）✓
 *   · 待删-2 12 个 .env 键 ⇒ 读取点 **全 0** ⇒ 无业务判据；**前缀 3 族必须留着** ✓
 *   · 待删-3 `V1ReferenceResolver.findLiveInventory` ⇒ 能力现由
 *     `InventoryService.findLiveInventory`（`inventoryService.js:1531`）承载 ✓ 判据没丢 ✗
 *   · 待删-4 `supabase/migrations/**` ⇒ 退役小程序的 SQL，全仓零引用 ✓
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('哨兵-1 `sales:sample` 坏引用已删（能真红：把那一行塞回 package.json ⇒ 红）', () => {
  const pkg = read('server/package.json');
  assert.equal(pkg.includes('sales:sample'), false, '⛔ 坏引用脚本不许留在 package.json ✗');
  // ⚠️ 判据范围 = **代码侧**（src / scripts / public / package.json / .env.example）——
  //    docs / AGENTS.md 里写"历史"是**应当的**（审计就记在那儿 ✓），不算残留 ✗
  const hits = require('node:child_process')
    .execSync('grep -rl "write_sales_sample" server/src server/scripts server/public tools server/package.json .env.example || true',
      { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(hits, '', '⛔ 代码侧不许再有 write_sales_sample 的提及 ✗');
});

test('哨兵-2 12 个零读取点键在 .env.example / 代码里 0 残留（能真红：塞回任一键 ⇒ 红）', () => {
  const env = read('.env.example');
  const keys = [
    'FEISHU_SYNC_CONCURRENCY', 'FEISHU_RETRY_MAX', 'FEISHU_RETRY_BASE_MS', 'FEISHU_RETRY_MAX_DELAY_MS',
    'FEISHU_V1_PURCHASE_BATCH_TABLE_ID', 'FEISHU_V1_MONEY_LEDGER_TABLE_ID', 'FEISHU_V1_SUPPLIER_PAYABLE_TABLE_ID',
    'SALES_PROCESSING_CARD_TITLE', 'SALES_PROCESSING_CARD_TEMPLATE', 'SALES_PROCESSING_CARD_ITEM_COLOR',
    'SALES_PROCESSING_CARD_PROGRESS_LINE', 'SALES_PROCESSING_CARD_NOTE',
  ];
  for (const key of keys) {
    assert.equal(new RegExp(`^${key}=`, 'm').test(env), false, `⛔ .env.example 不该再有 ${key} ✗`);
    const hits = require('node:child_process')
      .execSync(`grep -rl "${key}" server/src server/scripts tools server/public 2>/dev/null || true`,
        { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(hits, '', `⛔ ${key} 不该再被任何源码提及 ✗`);
  }
});

// 🔴 2026-10-16（「与 AI 分析有关的都停掉」）**成对迁移**（逐字留痕）——
//   · 改前逐字：`test('哨兵-3 ⭐ 反方向：\`SALES_MISSING_INFO_*\` / \`PURCHASE_GROUP_NOTICE_*\` / \`TEXT_LLM*\` 一族没被误杀（能真红：删掉一族 ⇒ 红）', …)`
//     其中三行断言：
//       `assert.ok((env.match(/^SALES_MISSING_INFO_/gm) || []).length >= 20, 'SALES_MISSING_INFO_* 族必须还在 ✓');`
//       `assert.ok((env.match(/^PURCHASE_GROUP_NOTICE_/gm) || []).length >= 3, 'PURCHASE_GROUP_NOTICE_* 族必须还在 ✓');`
//       `assert.ok((env.match(/^TEXT_LLM/gm) || []).length >= 3, 'TEXT_LLM* 族必须还在 ✓');`
//   · 为什么必须改：这三族里 `SALES_MISSING_INFO_*` 与 `TEXT_LLM*` 的**读取实现**
//     （`config/salesMissingInfoText.js` / `config/llmModels.js`）**本次已删** ——
//     它们服务的正是 AI 解析那条链路。**读取实现没了，配置族就不该"必须还在"** ✗
//     （留着 = 死配置 + 反向哨兵指着已删文件 ⇒ 文件一读就 ENOENT 假红）。
//   · 依据=业务负责人 2026-10-16 逐字：「**都停掉，与 AI 分析有关的都停掉**」＋「**连代码一起删**」。
//   · ⭐ **判据本意没丢**（反方向哨兵的责任 = 挡住"按前缀动态拼的族被误杀"）：
//     ① 保留下来、**仍在被读**的 `PURCHASE_GROUP_NOTICE_*` 族照旧 >= 3 ✓
//     ② 被删的两族改成**正方向**钉住（`test/aiParsingRemoval.test.js` AC-6："塞回即红"）✓
test('哨兵-3 ⭐ 反方向：`PURCHASE_GROUP_NOTICE_*` 一族没被误杀（能真红：删掉这一族 ⇒ 红）', () => {
  const env = read('.env.example');
  // 这一族是「按前缀动态拼」读的（审计 §7.1）⇒ 字面量 grep 0 命中**不代表没人读** ✗
  assert.ok((env.match(/^PURCHASE_GROUP_NOTICE_/gm) || []).length >= 3, 'PURCHASE_GROUP_NOTICE_* 族必须还在 ✓');
  const src = read('server/src/config/purchaseGroupNoticeText.js');
  assert.match(src, /PURCHASE_GROUP_NOTICE_/, '读取实现仍在 ✓');
  // ⚠️ 与它同批被判"必须还在"的另外两族**已随 AI 解析删除**（见上面的迁移留痕）：
  //    `SALES_MISSING_INFO_*`（缺项追问渲染，读它的配置模块已删）· `TEXT_LLM*`（文字模型）
  //    ⇒ 它们**不该**在这条反方向哨兵里；正方向的"塞回即红"在 aiParsingRemoval AC-6 ✓
});

test('哨兵-4 `V1ReferenceResolver.findLiveInventory` 已删、能力由 InventoryService 承载（能真红：塞回那个方法 ⇒ 红）', () => {
  const resolver = read('server/src/services/v1ReferenceResolver.js');
  assert.equal(/async findLiveInventory\s*\(/.test(resolver), false, '⛔ 旧实现（方法级零调用方 + 按数字读尺码）不许回来 ✗');
  const inventory = read('server/src/services/inventoryService.js');
  assert.match(inventory, /findLiveInventory\s*\(/, '⭐ 承载者 `InventoryService.findLiveInventory` 必须在 ✓');
  assert.match(inventory, /findLiveInventoryIn\s*\(/, '⭐ 它的内部实现也必须在 ✓');
});

test('哨兵-5 退役小程序 SQL 已删（能真红：把 supabase/migrations 放回 ⇒ 红）', () => {
  assert.equal(exists('supabase/migrations'), false, '⛔ supabase/migrations 不该还在 ✗');
  const hits = require('node:child_process')
    .execSync('grep -rl "supabase/migrations" server/src server/scripts server/public tools server/package.json || true',
      { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(hits, '', '⛔ 代码侧不许再有对 supabase/migrations 的引用 ✗');
});
