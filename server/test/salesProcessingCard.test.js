// 「点了确认必须一眼看得出来」这张卡片的回归测试（业务负责人 2026-10-07 拍板的 ⓐ 方案）。
//
// 起因（她原话）：「我点击了确认后，卡片其实没变化，就会很让我迷惑，到底点击没点击」
// ⇒ 点确认后**那一次立即更新**的卡片要：标题醒目「处理中/正在写入」＋ 明细区明显不同。
//
// 本文件钉住的是**可见结果**（文案 / 颜色 / 结构），不是实现细节：
//   ① 标题 = 配置里的处理中文案；② 明细区与确认卡片不同（整段变灰 + 多一行"正在写入"）；
//   ③ note 逐字不变；④ 没有按钮；⑤ `stage` 仍是 `processing`；
//   ⑥ `posted` 终态卡逐字未变；⑦ 配置四项都可覆盖。
//
// ⚠️ 既有断言一条都不放宽：本文件是**新增**的；`test/larkMvpService.test.js` 里
//   原来那两条 `/处理中/` 断言（`:409` 样品链路 / `:744` 销售确认链路）**原样保留**，
//   默认标题因此刻意同时含「处理中」与「正在写入」，不需要改它们。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { salesConfirmationCard, salesStatusCard, salesProcessingCard } = require('../src/utils/larkCards');
const {
  SALES_PROCESSING_CARD_DEFAULTS,
  resolveSalesProcessingCardConfig,
} = require('../src/config/salesProcessingCard');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'sales-processing-card-')), idField: 'task_id' });

// 两件明细：确认卡片这时**逐件显示金额**（`items.length > 1`），
// 所以「明细文字」与处理中卡片完全相同 —— 唯一差别就是那层 `<font color='grey'>`。
// 这样才能证明"看起来不一样"是**变灰**带来的，而不是别的巧合。
const TWO_ITEMS = [
  { item_no: 'A100', size: 38, quantity: 1, actual_amount: 99 },
  { item_no: 'A100', size: 39, quantity: 1, actual_amount: 99 },
];

const elementTexts = (card) => card.elements.map((element) =>
  element.content || element.text?.content || element.elements?.map((inner) => inner.content).join('') || '');

test('处理中卡片的默认配置就是她要求的那张（标题醒目、明细变灰、note 逐字保留）', () => {
  const config = resolveSalesProcessingCardConfig({});
  assert.deepEqual(config, { ...SALES_PROCESSING_CARD_DEFAULTS });
  // ① 标题必须一眼看出"已经点上了、正在写入"。
  assert.match(config.title, /处理中/);
  assert.match(config.title, /正在写入/);
  // ② 明细变灰 + 一行醒目的处理中提示（两个都做，她要求"不仔细看标题也能看出变了"）。
  assert.equal(config.itemColor, 'grey');
  assert.equal(config.progressLine, '⏳ 正在写入销售记录与收款…');
  // ③ note 逐字保留。
  assert.equal(config.note, '已收到确认，正在写入销售记录和收款；请勿重复点击。');
});

test('四项显示配置（标题 / 卡片头颜色 / 明细颜色 / 处理中行 / note）都能被环境变量覆盖', () => {
  const config = resolveSalesProcessingCardConfig({
    SALES_PROCESSING_CARD_TITLE: '⏳ 正在写入…',
    SALES_PROCESSING_CARD_TEMPLATE: 'orange',
    SALES_PROCESSING_CARD_ITEM_COLOR: 'red',
    SALES_PROCESSING_CARD_PROGRESS_LINE: '马上就好',
    SALES_PROCESSING_CARD_NOTE: '别重复点',
  });
  assert.deepEqual(config, {
    title: '⏳ 正在写入…',
    template: 'orange',
    itemColor: 'red',
    progressLine: '马上就好',
    note: '别重复点',
  });
  // 设成空串 = 显式"不要这一项"（不回退默认）——与 config/envValue 的总体规矩一致。
  const blank = resolveSalesProcessingCardConfig({
    SALES_PROCESSING_CARD_ITEM_COLOR: '',
    SALES_PROCESSING_CARD_PROGRESS_LINE: '',
  });
  assert.equal(blank.itemColor, '');
  assert.equal(blank.progressLine, '');
});

test('处理中卡片：明细整段变灰、多一行"正在写入"、note 与确认卡片一致、没有任何按钮', () => {
  const config = resolveSalesProcessingCardConfig({});
  const card = salesProcessingCard({ items: TWO_ITEMS }, config);
  const texts = elementTexts(card);

  // ① 标题来自配置。
  assert.equal(card.header.title.content, config.title);
  assert.equal(card.header.template, config.template);
  // ② 明细区与确认卡片**明显不同**：整段被 `<font color='grey'>` 包住。
  const detail = card.elements[1].text.content;
  assert.ok(detail.startsWith("<font color='grey'>"));
  assert.ok(detail.endsWith('</font>'));
  assert.ok(detail.includes('1. A100 38码 × 1 ￥99'));
  assert.ok(detail.includes('2. A100 39码 × 1 ￥99'));
  // 去掉颜色标记之后，这两张卡片的明细文字**本来就一样** ⇒ 差别确实来自"变灰"。
  const plainDetail = detail.replace(/^<font color='[^']*'>/, '').replace(/<\/font>$/, '');
  const confirmationTexts = elementTexts(salesConfirmationCard('sale_x', { items: TWO_ITEMS }));
  assert.ok(confirmationTexts.includes(plainDetail), '两边明细文字应当相同，差别只在颜色');
  assert.notEqual(detail, plainDetail);
  // 多出来的一行"正在写入"提示（在明细之前，第一眼就看到）。
  assert.equal(card.elements[0].text.content, config.progressLine);
  assert.ok(texts.includes(config.progressLine));
  // ③ note 逐字不变（结构与 salesStatusCard 一致）。
  const note = card.elements.at(-1);
  assert.equal(note.tag, 'note');
  assert.equal(note.elements[0].content, '已收到确认，正在写入销售记录和收款；请勿重复点击。');
  // ④ 处理中卡片**不给任何按钮**（她点过了，不能重复点）。
  assert.ok(!card.elements.some((element) => ['action', 'column_set'].includes(element.tag)));
});

test('颜色 / 处理中行配成空串时，那一项就不出现（不是渲染出一个空壳）', () => {
  const card = salesProcessingCard({ items: TWO_ITEMS }, {
    title: '处理中', template: 'blue', itemColor: '', progressLine: '', note: 'note',
  });
  assert.equal(card.elements.length, 2);
  assert.equal(card.elements[0].text.content, '1. A100 38码 × 1 ￥99\n2. A100 39码 × 1 ￥99');
});

test('「已入账」终态卡（salesStatusCard）逐字未变 —— 这是她满意的那张，不许动', () => {
  const card = salesStatusCard({ items: TWO_ITEMS }, '销售订单已入账',
    '销售单号：XSD-001；2 条明细已写入。尚未交付，库存未扣减。', 'green');
  // 逐字钉住：元素类型仍是 markdown（没有 <font> 包裹）、note 仍是她熟悉的那句。
  assert.deepEqual(card, {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '销售订单已入账' } },
    elements: [
      { tag: 'markdown', content: '1. A100 38码 × 1 ￥99\n2. A100 39码 × 1 ￥99' },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: '销售单号：XSD-001；2 条明细已写入。尚未交付，库存未扣减。' }] },
    ],
  });
  // 处理中卡片与终态卡**结构上就不是一张卡**（一个有 <font>、一个没有）。
  const processing = salesProcessingCard({ items: TWO_ITEMS }, resolveSalesProcessingCardConfig({}));
  assert.notDeepEqual(processing, card);
});

// ── 走一遍真实链路（不是只测渲染函数）──────────────────────────────────────
// 她点「确认」→ `handleCardAction` → 立即 patch 一次卡片（stage=processing）
// → 入账 → 再 patch 一次终态卡（stage=posted）。
// 用真实的 `updateInteractiveCard`（只打桩飞书 SDK 的 patch），并把结构化日志抓下来 ——
// `stage` 就在日志里，这既是验收标准 ⑤，也是线上排查时看到的同一行。
const captureLogs = async (run) => {
  const lines = [];
  const original = console.log;
  console.log = (line) => { lines.push(line); };
  try {
    const result = await run();
    return { result, lines };
  } finally {
    console.log = original;
  }
};

const parseLogs = (lines) => lines.map((line) => {
  try { return JSON.parse(line); } catch (_error) { return null; }
}).filter(Boolean);

test('点确认后的第一次卡片更新：标题=处理中、明细变灰、note 不变、无按钮、stage 仍是 processing', async () => {
  const store = makeStore();
  const cards = [];
  await store.create({ task_id: 'sale_visible_processing', type: 'sale', status: 'ready_to_confirm',
    sender_open_id: 'ou_1', sales_entry_record_id: 'entry_1', card_message_id: 'om_card',
    draft: { items: TWO_ITEMS, payments: [] } });
  const service = new LarkMvpService({
    client: { im: { v1: { message: { patch: async ({ data }) => {
      cards.push(JSON.parse(data.content));
      return { code: 0 };
    } } } } },
    gateway: {}, references: {}, recognizer: {}, store,
    posting: { postSale: async () => ({ sourceNo: 'XSD-001', detailRecordIds: ['detail_1', 'detail_2'] }) },
  });

  const { result, lines } = await captureLogs(() => service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action: 'confirm_sale', draft_id: 'sale_visible_processing' } },
  }));

  assert.equal(result.toast.type, 'success');
  assert.equal(cards.length, 2, '她点一次应恰好更新两张卡：先「处理中」，后「已入账」');

  const config = resolveSalesProcessingCardConfig({});
  const processing = cards[0];
  // ① 标题
  assert.equal(processing.header.title.content, config.title);
  assert.match(processing.header.title.content, /处理中/);
  // ② 明细区与确认卡片明显不同：变灰 + 多一行提示
  const detail = processing.elements[1].text.content;
  assert.equal(detail, `<font color='grey'>1. A100 38码 × 1 ￥99\n2. A100 39码 × 1 ￥99</font>`);
  assert.equal(processing.elements[0].text.content, config.progressLine);
  // ③ note 逐字不变
  assert.equal(processing.elements.at(-1).elements[0].content,
    '已收到确认，正在写入销售记录和收款；请勿重复点击。');
  // ④ 无按钮
  assert.ok(!processing.elements.some((element) => ['action', 'column_set'].includes(element.tag)));

  // ⑥ 终态卡逐字未变（走的是老的 salesStatusCard 形状：markdown + note）。
  const posted = cards[1];
  assert.deepEqual(posted, salesStatusCard({ items: TWO_ITEMS }, '销售订单已入账',
    '销售单号：XSD-001；2 条明细已写入。尚未交付，库存未扣减。', 'green'));
  assert.equal((await store.get('sale_visible_processing')).status, 'posted');

  // ⑤ stage 仍是 processing —— 日志里逐字如此（线上排查看到的就是这一行）。
  const updates = parseLogs(lines).filter((entry) => entry.event === 'lark.sales.card.update.succeeded');
  assert.deepEqual(updates.map((entry) => entry.stage), ['processing', 'posted']);
  // 卡片刻变这件事发生在**入账之前**：第一次更新就是 processing，不是等流程跑完才变。
  assert.equal(updates[0].stage, 'processing');
});
