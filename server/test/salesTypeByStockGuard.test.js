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
const { PendingDealPushService } = require('../src/services/pendingDealPushService');
const { resolvePendingDealPushConfig } = require('../src/config/pendingDealPush');
const { resolveSalesColorChoiceConfig } = require('../src/config/salesColorChoice');
const { resolveSecondDeliveryCardConfig } = require('../src/config/secondDeliveryCard');
const { SALES_CARD_FACTS_DEFAULTS } = require('../src/config/salesCardFacts');
const { SALES_MOVEMENTS, SALES_TRADE_TYPE_CODES, tradeTypeCodeFromLabel } = require('../src/config/salesMovements');

const FORBIDDEN = ['未付', '预付', 'SALE_UNPAID'];
const FORBIDDEN_IN_TEXT = ['未付', '预付'];

const ITEMS = [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 99, trade_type_code: 'SALE_CASH' }];

// ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
//   改前逐字：`'① 卡片渲染 0 命中「未付 / 预付」：处理中卡 / 终态卡 / 成交提醒卡（原确认卡已退场，红线口径照旧）'`
//   改后逐字：`'① 卡片渲染 0 命中「未付 / 预付」：终态卡 / 成交提醒卡（原确认卡与处理中卡已退场，红线口径照旧）'`
//   依据：这条是**她定的红线**（卡面上不许出现「未付 / 预付」那种词）⇒ 判据本意 = "**在用的每一张卡**都 0 命中"
//     ⇒ 处理中卡退场后，**终态卡 + 成交提醒卡**（＋ 到货核对卡）照旧逐张断言 ✓（判据没放宽 ✗）
test('① 卡片渲染 0 命中「未付 / 预付」：终态卡 / 成交提醒卡（原确认卡与处理中卡已退场，红线口径照旧）', () => {
  const cards = [
    larkCards.salesStatusCard({ items: ITEMS }, '销售订单已入账', '销售单号：XSD-1。', 'green'),
    larkCards.secondDeliveryCard({
      orders: [{ orderNo: 'XSD-1', salesEntryRecordId: 'rec_1', tradeTypeLabel: '现货',
        quantity: 1, pendingAmount: 99, pendingDeliveryQuantity: 0 }],
      methods: ['微信'], dayKey: '2026-10-07',
    }),
  ];
  for (const [index, card] of cards.entries()) {
    const text = JSON.stringify(card);
    for (const word of FORBIDDEN_IN_TEXT) {
      assert.ok(!text.includes(word), `第 ${index + 1} 张卡片里出现了「${word}」：${text}`);
    }
  }
  // ⚠️ 2026-10-12（3b）：原来这里还有一条正例 —— 「三段（类型 / 履约 / 收款）说清了」，
  //    它钉的是**已退场那张确认卡片**的 `salesCardFactElements`（那三段只有它一个调用方
  //    ⇒ 没有活的卡片需要它）⇒ 正例随卡片一起退场。**红线那一半（0 命中「未付 / 预付」）照旧**：
  //    仍在跑的处理中卡 / 终态卡 / 成交提醒卡都在上面那个循环里逐张扫过。
});

test('① 待处理单推送渲染 0 命中「未付 / 预付」（分区标题就是【预定】/【现货待收】）', () => {
  const settings = { ...resolvePendingDealPushConfig({}), enabled: true };
  const service = new PendingDealPushService({
    settings,
    secondDelivery: { client: {}, listPendingDeliveries: async () => [] },
    locator: {}, resolver: {}, client: {}, chatId: 'oc_x', store: {}, pin: {},
  });
  // ⚠️ 2026-10-08（第一步）：入口是**行**（`{ sections, rows }`），判据由取数那一处给。
  const rows = [
    { rowId: 'd1', salesEntryRecordId: 'a', criterion: 'undelivered', facts: [], pendingAmount: 128, url: '' },
    { rowId: 'p1', salesEntryRecordId: 'b', criterion: 'delivered_unpaid', facts: [], pendingAmount: 228, url: '' },
  ];
  const text = service.buildText({
    dayKey: '2026-10-07',
    missingLinkCount: 0,
    sections: service.buildSections(rows),
    rows,
  });
  for (const word of FORBIDDEN_IN_TEXT) {
    assert.ok(!text.includes(word), `推送文案里出现了「${word}」：\n${text}`);
  }
  assert.match(text, /【预定】1 笔/);
  assert.match(text, /【现货待收】1 笔/);
});

// 🔴 2026-10-16（「与 AI 分析有关的都停掉」）：**删掉一条**（判据迁移，逐字留痕）——
//   · 删前逐字：`test('① 「销售信息还缺…」追问渲染 0 命中「未付 / 预付」（含"哪一件付了定金"那句）', …)`
//   · 为什么删：它断言的**渲染结果**由 `config/salesMissingInfoText.renderSalesMissingInfo` 产出，
//     而那正是**"销售文字录单缺项追问"那一层文案**（AI 解析输出 `missing_fields` → 翻人话）；
//     该配置随 AI 解析整体删除 ⇒ 这条判据**没有可断言的对象**了 ✗
//   · 依据=业务负责人 2026-10-16 逐字：「**都停掉，与 AI 分析有关的都停掉**」＋「**连代码一起删**」
//   · ⭐ 它的**红线本意**（用户可见文案里不许出现「未付 / 预付」）**没有被放宽**：
//     ① ② ③ 三条照旧逐条断言**在用的**卡片 / 推送 / 配置 / 源码字面量 ✓
//   · ⚠️ 同一条判据的**残留哨兵**已迁到 `test/aiParsingRemoval.test.js` AC-2（塞回即红）✓
test('② 配置默认值 0 命中：三段文案 / 颜色候选 / 待处理单推送 / 成交提醒卡（追问文案那份配置 2026-10-16 已随 AI 解析删除）', () => {
  const blobs = [
    JSON.stringify(SALES_CARD_FACTS_DEFAULTS),
    JSON.stringify(resolveSalesColorChoiceConfig({})),
    JSON.stringify(resolvePendingDealPushConfig({})),
    JSON.stringify(resolveSecondDeliveryCardConfig({})),
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
