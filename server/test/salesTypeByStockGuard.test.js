// ⭐ 守门用例（2026-10-07 口径大改）：「未付」/「预付」/ `SALE_UNPAID` **不许**再出现在
//    任何**用户可见文案**或**代码判据 / 配置**里。
//
// 背景（业务负责人逐字）：
//   「【类型 = 只看库存】（行为表里就两条：现货 SALE_CASH / 预定 SALE_PREPAID）
//    ⇒「未付」不再是类型（**她已从行为表删掉那条**），它只是"现货 + 钱没结清"的状态」
//   「她已把「预付」改名成「预定」」
//
// ⇒ 本文件钉三件事：
//   ① 卡片 / 推送 / 追问这些**用户可见**的渲染结果里 0 命中「未付 / 预付 / SALE_UNPAID」；
//   ② 配置默认值里 0 命中（改文案改错了这里会红）；
//   ③ `src/` 的**代码与配置字面量**里 0 命中 `SALE_UNPAID`（注释里的历史说明允许 —— 说明"为什么
//      不再按它筛"是有价值的；判据里出现才是回退）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const larkCards = require('../src/utils/larkCards');
const { PATCHABLE_CARD_SCENARIOS } = require('../test-support/cardScenarios');
const { resolveSalesColorChoiceConfig } = require('../src/config/salesColorChoice');
const { SALES_CARD_FACTS_DEFAULTS } = require('../src/config/salesCardFacts');
const { SALES_MOVEMENTS, SALES_TRADE_TYPE_CODES, tradeTypeCodeFromLabel } = require('../src/config/salesMovements');

const FORBIDDEN = ['未付', '预付', 'SALE_UNPAID'];
const FORBIDDEN_IN_TEXT = ['未付', '预付'];

const ITEMS = [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 99, trade_type_code: 'SALE_CASH' }];

// ⭐ 2026-10-28（群卡片残留清理）**成对改指向**：
//   改前逐字：这段逐张断言 `salesStatusCard` + `secondDeliveryCard`（"+ 到货核对卡"）。
//   改后逐字：两**张卡都已随「没有旧卡片 / 9 点推送不再需要」删除** ⇒ 改成扫**全部仍在生产使用**
//     的卡片（`test-support/cardScenarios.js` 的 `PATCHABLE_CARD_SCENARIOS`，现为 3 张：
//     样品补选卡 / 到货验收终态卡 / 采购状态卡）。
//   判据本意不变：**在用的每一张卡**都 0 命中「未付 / 预付」。卡多了会自动进这个循环。
test('① 卡片渲染 0 命中「未付 / 预付」：仍在用的每一张卡（红线口径照旧）', () => {
  assert.ok(PATCHABLE_CARD_SCENARIOS.length >= 3, '至少要有 3 张在用卡参与扫描');
  for (const { name, build } of PATCHABLE_CARD_SCENARIOS) {
    const text = JSON.stringify(build(larkCards));
    for (const word of FORBIDDEN_IN_TEXT) {
      assert.ok(!text.includes(word), `${name} 里出现了「${word}」：${text}`);
    }
  }
});

// ⛔ 2026-10-28：原「① 待处理单推送渲染 0 命中『未付 / 预付』」那条已退场 ——
//   9 点群推送（`PendingDealPushService.buildText` / `buildSections`）整体删除
//   （业务负责人：「9 点群推送不再需要」）。**红线本身没有放宽**：
//   ① 逐张扫在用的卡片、② 扫在用的配置默认值、③ 扫 `src/` 字面量 —— 三条照旧。

test('② 配置默认值 0 命中：三段文案 / 颜色候选（待处理单推送与成交提醒卡的配置已随推送删除）', () => {
  // ⭐ 2026-10-28：原来还扫 `resolvePendingDealPushConfig` / `resolveSecondDeliveryCardConfig`
  //   —— 那两份配置已随 9 点群推送整体删除，没有可扫的对象了。
  //   ⚠️ 这不是放宽：**仍存在**的每一份用户可见文案配置照旧逐份扫（下面是全部剩余项）。
  const blobs = [
    JSON.stringify(SALES_CARD_FACTS_DEFAULTS),
    JSON.stringify(resolveSalesColorChoiceConfig({})),
  ];
  for (const [index, blob] of blobs.entries()) {
    for (const word of FORBIDDEN_IN_TEXT) {
      assert.ok(!blob.includes(word), `第 ${index + 1} 份配置默认值里出现了「${word}」：${blob}`);
    }
  }
});

test('③ 代码 / 配置字面量里 0 命中 `SALE_UNPAID`（注释里的历史说明不算）', () => {
  const offenders = [];
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') && stripComments(fs.readFileSync(full, 'utf8')).includes('SALE_UNPAID')) {
        offenders.push(path.relative(path.join(__dirname, '..'), full));
      }
    }
  };
  walk(path.join(__dirname, '../src'));
  assert.deepEqual(offenders, [], '`SALE_UNPAID` 只能出现在"为什么不再用它"的注释里，不许回到判据 / 配置');
  // 注册表里也只有两个编码，且「未付」/「预付」都取不出新编码。
  assert.deepEqual([...SALES_TRADE_TYPE_CODES].sort(), ['SALE_CASH', 'SALE_PREPAID']);
  assert.deepEqual(Object.keys(SALES_MOVEMENTS).sort(), ['SALE_CASH', 'SALE_PREPAID']);
  assert.equal(tradeTypeCodeFromLabel('未付'), '');
  assert.equal(tradeTypeCodeFromLabel('预付'), 'SALE_PREPAID', '旧说法映射到同一条记录（编码不变）');
});

test('③ .env.example 的**配置值行**（非注释）也 0 命中「未付 / 预付」', () => {
  const text = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
  const valueLines = text.split('\n').filter((line) => /^[A-Z0-9_]+=/.test(line));
  for (const line of valueLines) {
    for (const word of FORBIDDEN_IN_TEXT) {
      assert.ok(!line.includes(word), `.env.example 的配置值里出现了「${word}」：${line}`);
    }
  }
});
