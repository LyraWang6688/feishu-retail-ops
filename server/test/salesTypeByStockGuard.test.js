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
const { SALES_CARD_FACTS_DEFAULTS } = require('../src/config/salesCardFacts');
const { SALES_MISSING_INFO_DEFAULTS, renderSalesMissingInfo } = require('../src/config/salesMissingInfoText');
const { SALES_MOVEMENTS, SALES_TRADE_TYPE_CODES, tradeTypeCodeFromLabel } = require('../src/config/salesMovements');

const FORBIDDEN = ['未付', '预付', 'SALE_UNPAID'];
const FORBIDDEN_IN_TEXT = ['未付', '预付'];

const ITEMS = [{ item_no: 'A100', size: 38, quantity: 1, actual_amount: 99, trade_type_code: 'SALE_CASH' }];

test('① 卡片渲染 0 命中「未付 / 预付」：处理中卡 / 终态卡 / 成交提醒卡（原确认卡已退场，红线口径照旧）', () => {
  const cards = [
    larkCards.salesProcessingCard({ items: ITEMS }, {
      title: '⏳ 处理中', template: 'blue', itemColor: 'grey', progressLine: '正在写入…', note: '请勿重复点击',
    }),
    larkCards.salesStatusCard({ items: ITEMS }, '销售订单已入账', '销售单号：XSD-1。', 'green'),
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

test('① 「销售信息还缺…」追问渲染 0 命中「未付 / 预付」（含"哪一件付了定金"那句）', () => {
  const { SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS } = require('../src/config/salesTradeTypePolicy');
  const rendered = renderSalesMissingInfo({
    missingFields: [SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS, 'items[0].actual_amount', '请明确已经收到的定金金额'],
    items: [{ item_no: 'A100', size: 38 }, { item_no: 'B200', size: 40 }],
  });
  const text = [rendered.text, ...rendered.lines].join('\n');
  for (const word of FORBIDDEN_IN_TEXT) {
    assert.ok(!text.includes(word), `追问文案里出现了「${word}」：\n${text}`);
  }
  assert.match(text, /哪一件付了定金/);
});

test('② 配置默认值 0 命中：三段文案 / 颜色候选 / 待处理单推送 / 成交提醒卡 / 追问文案', () => {
  const blobs = [
    JSON.stringify(SALES_CARD_FACTS_DEFAULTS),
    JSON.stringify(resolveSalesColorChoiceConfig({})),
    JSON.stringify(resolvePendingDealPushConfig({})),
    JSON.stringify(SALES_MISSING_INFO_DEFAULTS),
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
