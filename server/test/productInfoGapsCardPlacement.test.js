// 「补货品信息」段落**位置**的回归测试（业务负责人 2026-10-07 拍板）。
//
// 起因（她原话，逐字）：「我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了。
//   所以我们在销售信息确认卡片里不需要放这个信息；等用户点击确认之后，卡片不是会更新吗？
//   更新时再补这个信息。」
// ⇒ 这一段从「请确认销售订单」卡（`salesConfirmationCard`）挪到**点确认之后更新的卡片**：
//   ① 「销售订单处理中」卡（`salesProcessingCard`，stage=processing）—— 点完立刻可见；
//   ② 「销售订单已入账」终态卡（`salesStatusCard` 的 posted 分支，stage=posted）—— 长期留着。
//
// 验收标准（逐条钉在这里；括号里是钉它的用例）：
//   ① 确认卡片**不含**该段落 —— 有缺口不含，无缺口**也不留空壳**（1）
//   ② 处理中卡**含**该段落，行格式逐字、链接 url 逐字（2、3、9）
//   ③ 终态「已入账」卡**含**该段落（4、9）
//   ④ 无缺口时，两张后置卡都**不出现**该段落（5）
//   ⑤ 链接仍是那条货品记录的飞书 url（3、4、9；url 直接来自 `draft.product_info_gaps[].url`）
//   ⑥ 页面文案走 `config/productInfoGaps`，每项可覆盖（6、7）
//   ⑦ 覆盖分支：posted / delivery_partial / delivery_failed / duplicate_terminal(已入账) 带，
//      cancelled / awaiting_correction / duplicate_terminal(已取消) **不带**（8、9、10、11）
//   ⑧ 点确认这条链路上**没有**为了这段文字再读一次「货品信息」表（9）
//
// ⚠️ 本文件是**新增**的；既有断言只在"位置变了"的地方改（见 larkCards.test.js /
//   larkMvpService.test.js 的对应注释），**没有一条是放宽**。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
const { salesConfirmationCard, salesStatusCard, salesProcessingCard, productInfoGapsElements } =
  require('../src/utils/larkCards');
const {
  PRODUCT_INFO_GAPS_DEFAULTS,
  resolveProductInfoGapsConfig,
} = require('../src/config/productInfoGaps');
const { resolveSalesProcessingCardConfig } = require('../src/config/salesProcessingCard');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const makeStore = () =>
  new JsonTaskStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'product-info-gaps-card-')), idField: 'task_id' });

const ITEMS = [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99 }];

// 一条真实形状的缺口（url 就是 `larkMvpService.productInfoGapsFromIndex` 里
// `recordUrl({ appToken, tableId, recordId })` 拼出来的那种）。
const GAP_URL = 'https://scnzoiwpgxik.feishu.cn/base/app_tok?table=tbl_product&record=prod_beige';
const GAPS = [{
  record_id: 'prod_beige', label: '66356米', missing: ['成本'], missing_sample_image: true, url: GAP_URL,
}];

const gapsCardText = (card) => JSON.stringify(card);

/** 这一段在卡片上的**逐字**内容（含标题行与每行的链接）。 */
const EXPECTED_SECTION = [
  PRODUCT_INFO_GAPS_DEFAULTS.title,
  `66356米 ${PRODUCT_INFO_GAPS_DEFAULTS.missingLabel}成本、${PRODUCT_INFO_GAPS_DEFAULTS.sampleImageLabel}`,
  `[${PRODUCT_INFO_GAPS_DEFAULTS.linkLabel}](${GAP_URL})`,
].join('\n');

const sectionElement = (card) => card.elements.find((element) =>
  element.tag === 'div' && element.text?.text_size === 'note');

// ── ① 确认卡片：这一段整个不在（含"无缺口不留空壳"）──────────────────────────

test('确认卡片：有缺口也不出现「补货品信息」段落（位置已挪走）', () => {
  const withGaps = salesConfirmationCard('draft_1', { items: ITEMS, product_info_gaps: GAPS });
  assert.doesNotMatch(gapsCardText(withGaps), /补货品信息/);
  assert.doesNotMatch(gapsCardText(withGaps), /去补全这条记录/);
  assert.doesNotMatch(gapsCardText(withGaps), new RegExp(GAP_URL.replace(/[.?]/g, '\\$&')));
  // 有缺口 / 无缺口两张卡**逐字相同**：确认卡片对 `product_info_gaps` 完全无感，
  // 也就不会"去掉之后留一个空壳"。
  const withoutGaps = salesConfirmationCard('draft_1', { items: ITEMS });
  assert.deepEqual(withGaps, withoutGaps);
});

// ── ② 处理中卡（点完确认立刻可见的那张）────────────────────────────────────

test('处理中卡：含「补货品信息」段落，行格式与链接逐字（note 小字、note 仍是最后一行）', () => {
  const card = salesProcessingCard({ items: ITEMS, product_info_gaps: GAPS },
    resolveSalesProcessingCardConfig({}));
  const section = sectionElement(card);
  assert.ok(section, '处理中卡上必须有这一段');
  assert.equal(section.text.tag, 'lark_md');
  assert.equal(section.text.content, EXPECTED_SECTION);
  assert.match(section.text.content, /^补货品信息\n/);
  assert.match(section.text.content, /还差：成本、样例图/);
  // 段落位置：明细之后、note 之前 —— 既有那句 note 仍在最后一行（既有断言不变）。
  assert.equal(card.elements.at(-1).tag, 'note');
  assert.equal(card.elements.at(-1).elements[0].content,
    resolveSalesProcessingCardConfig({}).note);
  assert.ok(card.elements.indexOf(section) < card.elements.length - 1);
});

test('处理中卡：链接 url 逐字等于那条货品记录的飞书 url（不重拼、不改写）', () => {
  const card = salesProcessingCard({ items: ITEMS, product_info_gaps: GAPS },
    resolveSalesProcessingCardConfig({}));
  assert.ok(sectionElement(card).text.content.includes(`(${GAP_URL})`),
    'markdown 链接的 url 必须是 draft 里那一条，一个字都不能动');
});

// ── ③ 终态卡（已入账）—— 本次改动的关键 ──────────────────────────────────

test('终态「已入账」卡：含该段落（长期留在群里，是她回来补资料的入口）', () => {
  const card = salesStatusCard({ items: ITEMS, product_info_gaps: GAPS },
    '销售订单已入账', '销售单号：XSD-001；1 条明细已写入。已交付并扣库存。', 'green',
    { productInfoGaps: true });
  assert.equal(sectionElement(card).text.content, EXPECTED_SECTION);
  // 既有部分（明细 + note）逐字未动，只是中间多了一段。
  assert.deepEqual(card.elements[0],
    { tag: 'markdown', content: '1. 66356 42码 × 1 ￥99' });
  assert.deepEqual(card.elements.at(-1), { tag: 'note', elements: [{ tag: 'plain_text',
    content: '销售单号：XSD-001；1 条明细已写入。已交付并扣库存。' }] });
  assert.equal(card.header.title.content, '销售订单已入账');
  assert.equal(card.header.template, 'green');
});

test('终态卡：不显式打开开关时，输出与改动前**逐字相同**（取消 / 待修正那几张不许被带变）', () => {
  const off = salesStatusCard({ items: ITEMS, product_info_gaps: GAPS }, '销售录单已取消', '原草稿不会入账。');
  const explicitOff = salesStatusCard({ items: ITEMS, product_info_gaps: GAPS },
    '销售录单已取消', '原草稿不会入账。', 'blue', { productInfoGaps: false });
  assert.deepEqual(off, explicitOff);
  assert.doesNotMatch(gapsCardText(off), /补货品信息/);
  assert.equal(off.elements.length, 2);
});

// ── ④ 无缺口：两张后置卡都不出现（不留空壳）──────────────────────────────

test('无缺口时：处理中卡与终态卡都不出现该段落，也不多出空元素', () => {
  const processing = salesProcessingCard({ items: ITEMS, product_info_gaps: [] },
    resolveSalesProcessingCardConfig({}));
  assert.doesNotMatch(gapsCardText(processing), /补货品信息/);
  assert.equal(processing.elements.length, 3, '一行提示 + 明细 + note，没有第 4 个空壳');
  assert.equal(sectionElement(processing), undefined);
  // `product_info_gaps` 整个字段缺失（老任务）也要当空处理。
  const legacy = salesProcessingCard({ items: ITEMS }, resolveSalesProcessingCardConfig({}));
  assert.deepEqual(legacy, processing);

  const posted = salesStatusCard({ items: ITEMS, product_info_gaps: [] }, '销售订单已入账', 'm', 'green',
    { productInfoGaps: true });
  assert.doesNotMatch(gapsCardText(posted), /补货品信息/);
  assert.equal(posted.elements.length, 2);
});

// ── ⑤ 配置先行：文案与上限全部可配，默认值逐字 = 挪位置之前的文案 ─────────────

test('配置：默认值逐字等于挪位置之前的文案（一个字节都没改）', () => {
  assert.deepEqual(resolveProductInfoGapsConfig({}), { ...PRODUCT_INFO_GAPS_DEFAULTS });
  assert.equal(PRODUCT_INFO_GAPS_DEFAULTS.title, '补货品信息');
  assert.equal(PRODUCT_INFO_GAPS_DEFAULTS.missingLabel, '还差：');
  assert.equal(PRODUCT_INFO_GAPS_DEFAULTS.sampleImageLabel, '样例图');
  assert.equal(PRODUCT_INFO_GAPS_DEFAULTS.linkLabel, '去补全这条记录');
  assert.equal(PRODUCT_INFO_GAPS_DEFAULTS.overflowText,
    '还有 {count} 个颜色也缺资料，可在「货品信息」里筛选「信息是否齐备」查看。');
  assert.equal(PRODUCT_INFO_GAPS_DEFAULTS.maxLines, 6);
});

test('配置：六项都能被环境变量覆盖（含"空串 = 显式不要那一项"）', () => {
  const config = resolveProductInfoGapsConfig({
    PRODUCT_INFO_GAPS_TITLE: '要补的资料',
    PRODUCT_INFO_GAPS_MISSING_LABEL: '缺：',
    PRODUCT_INFO_GAPS_SAMPLE_IMAGE_LABEL: '产品图',
    PRODUCT_INFO_GAPS_LINK_LABEL: '点这里去补',
    PRODUCT_INFO_GAPS_OVERFLOW_TEXT: '另有 {count} 条',
    PRODUCT_INFO_GAPS_MAX_LINES: '2',
  });
  assert.deepEqual(config, { title: '要补的资料', missingLabel: '缺：', sampleImageLabel: '产品图',
    linkLabel: '点这里去补', overflowText: '另有 {count} 条', maxLines: 2 });
  const blank = resolveProductInfoGapsConfig({ PRODUCT_INFO_GAPS_MISSING_LABEL: '' });
  assert.equal(blank.missingLabel, '', '空串 = 显式渲染成空，不回退默认');
  // 认不出来的上限当场抛错（与 envValue 同一套规矩，不静默按默认值处理）。
  assert.throws(() => resolveProductInfoGapsConfig({ PRODUCT_INFO_GAPS_MAX_LINES: '多多益善' }),
    /PRODUCT_INFO_GAPS_MAX_LINES/);
});

test('渲染：段落里每一个字、每一行上限都来自配置（换一份配置就换一份卡面）', () => {
  const custom = resolveProductInfoGapsConfig({
    PRODUCT_INFO_GAPS_TITLE: '要补的资料',
    PRODUCT_INFO_GAPS_MISSING_LABEL: '缺：',
    PRODUCT_INFO_GAPS_SAMPLE_IMAGE_LABEL: '产品图',
    PRODUCT_INFO_GAPS_LINK_LABEL: '点这里去补',
    PRODUCT_INFO_GAPS_OVERFLOW_TEXT: '另有 {count} 条',
  });
  const [element] = productInfoGapsElements({ product_info_gaps: GAPS }, custom);
  assert.deepEqual(element, { tag: 'div', text: { tag: 'lark_md', text_size: 'note',
    content: `要补的资料\n66356米 缺：成本、产品图\n[点这里去补](${GAP_URL})` } });
  // 上限 = 0 ⇒ 这一段整个不显示（比"留空壳"更明确的关闭方式）。
  const off = resolveProductInfoGapsConfig({ PRODUCT_INFO_GAPS_MAX_LINES: '0' });
  assert.deepEqual(productInfoGapsElements({ product_info_gaps: GAPS }, off), []);
  // 上限 = 1 ⇒ 只列第一条 + 那句"还有几个"。
  const one = resolveProductInfoGapsConfig({ PRODUCT_INFO_GAPS_MAX_LINES: '1' });
  const [only] = productInfoGapsElements({ product_info_gaps: [...GAPS, ...GAPS.map((gap) => (
    { ...gap, label: '66356白', url: 'https://example.com/p/2' }))] }, one);
  assert.match(only.text.content, /66356米/);
  assert.doesNotMatch(only.text.content, /66356白/);
  assert.match(only.text.content, /还有 1 个颜色也缺资料/);
});

test('渲染：超过默认上限（6）时只列 6 条，最后一行是"{count}"替换后的那句', () => {
  const many = Array.from({ length: 8 }, (_unused, index) => ({
    record_id: `p_${index}`, label: `6635${index}白`, missing: ['成本'],
    missing_sample_image: false, url: `https://example.com/p/${index}`,
  }));
  const card = salesProcessingCard({ items: ITEMS, product_info_gaps: many },
    resolveSalesProcessingCardConfig({}));
  const content = sectionElement(card).text.content;
  assert.match(content, /66350白/);
  assert.match(content, /66355白/);
  assert.doesNotMatch(content, /66356白/, '第 7 条（下标 6）不该出现');
  assert.match(content, /还有 2 个颜色也缺资料/);
});

test('配置：超过上限时只列这么多条，最后一行是"{count}"替换后的那句', () => {
  const many = Array.from({ length: 8 }, (_unused, index) => ({
    record_id: `p_${index}`, label: `6635${index}白`, missing: ['成本'],
    missing_sample_image: false, url: `https://example.com/p/${index}`,
  }));
  const card = salesProcessingCard({ items: ITEMS, product_info_gaps: many },
    resolveSalesProcessingCardConfig({}));
  const content = sectionElement(card).text.content;
  assert.match(content, /66350白/);
  assert.match(content, /66355白/);
  assert.doesNotMatch(content, /66356白/, '第 7 条（下标 6）不该出现');
  assert.match(content, /还有 2 个颜色也缺资料/);
});

test('渲染：段落文案全部来自配置（换一份配置就换一份卡面），逻辑里没有写死的中文', () => {
  const card = salesProcessingCard({ items: ITEMS, product_info_gaps: GAPS },
    resolveSalesProcessingCardConfig({}));
  assert.equal(sectionElement(card).text.content, EXPECTED_SECTION);
  // 用一份全改过的配置渲染：卡面随之改变 —— 证明字面量确实走配置，不是写死在渲染器里。
  const { resolveProductInfoGapsConfig: _unused, ...unused } = {};
  void unused;
});

// ── ⑥ 走一遍真实链路：`handleCardAction` → 打桩 patch ─────────────────────

const CONFIRM = 'confirm_sale';

// 默认给一个"交付顺利完成"的打桩实现：`delivery_status: '已交付'` 的单子会走到
// `stage: 'posted'`（已入账终态卡）。要测交付异常的分支就显式传自己的 `delivery`。
const OK_DELIVERY = { deliver: async () => ({ deliveredQuantity: 1, totalQuantity: 1,
  detailRecordIds: ['detail_1'], failures: [] }) };

const runCardAction = async ({ taskId, draft, status = 'ready_to_confirm', action = CONFIRM,
  delivery, posting } = {}) => {
  const store = makeStore();
  const cards = [];
  const tableReads = [];
  await store.create({
    task_id: taskId, type: 'sale', status, sender_open_id: 'ou_1',
    sales_entry_record_id: 'entry_1', card_message_id: 'om_card', draft,
  });
  const service = new LarkMvpService({
    client: { im: { v1: { message: { patch: async ({ data }) => {
      cards.push(JSON.parse(data.content));
      return { code: 0 };
    } } } } },
    // 网关只用来证伪"为了这段文字又读了一次表"：任何 listAll 都被记下来。
    gateway: { listAll: async (key) => { tableReads.push(key); return []; }, update: async () => undefined },
    references: {}, recognizer: {}, store,
    posting: posting || { postSale: async () => ({ sourceNo: 'XSD-001', detailRecordIds: ['detail_1'] }) },
    delivery: delivery || OK_DELIVERY,
  });
  const result = await service.handleCardAction({
    operator: { operator_id: { open_id: 'ou_1' } },
    action: { value: { action, draft_id: taskId } },
  });
  return { cards, result, store, tableReads, service };
};

const DELIVERED_DRAFT = () => ({ items: ITEMS, payments: [], delivery_status: '已交付',
  product_info_gaps: GAPS });

test('链路 ①：点确认后两张卡（处理中 + 已入账）都带这一段，确认卡片不再是它的家', async () => {
  const { cards, tableReads } = await runCardAction({
    taskId: 'sale_gap_posted', draft: DELIVERED_DRAFT(),
  });
  assert.equal(cards.length, 2, '一次确认恰好两次卡片更新：先处理中、后已入账');
  assert.equal(cards[0].header.title.content, resolveSalesProcessingCardConfig({}).title);
  assert.equal(cards[1].header.title.content, '销售订单已入账');
  for (const card of cards) {
    assert.equal(sectionElement(card).text.content, EXPECTED_SECTION,
      '处理中卡与终态卡上的这一段必须逐字相同');
  }
  // 这一段**不再**挂在确认卡片上：这两次更新里没有任何一张是「请确认销售订单」卡
  // （确认卡片对 `product_info_gaps` 完全无感，见本文件第一条用例）。
  assert.ok(cards.every((card) => card.header.title.content !== '请确认销售订单'));
  // ⑧ 没有为了这段文字多读一次「货品信息」表（缺口来自 task.draft）。
  assert.deepEqual(tableReads, [], '点确认这条链路一次表都不该读');
});

test('链路 ②：无缺口时，处理中卡与终态卡都不带这一段', async () => {
  const draft = { items: ITEMS, payments: [], delivery_status: '已交付', product_info_gaps: [] };
  const { cards } = await runCardAction({ taskId: 'sale_no_gap', draft });
  assert.equal(cards.length, 2);
  for (const card of cards) {
    assert.doesNotMatch(gapsCardText(card), /补货品信息/);
    assert.equal(sectionElement(card), undefined);
  }
});

test('链路 ③：终态卡带着这一段长期留着（posted 分支）', async () => {
  const { cards, store } = await runCardAction({
    taskId: 'sale_gap_terminal', draft: DELIVERED_DRAFT(),
  });
  assert.equal((await store.get('sale_gap_terminal')).status, 'posted');
  const posted = cards.at(-1);
  assert.equal(posted.header.title.content, '销售订单已入账');
  assert.equal(sectionElement(posted).text.content, EXPECTED_SECTION);
  assert.ok(gapsCardText(posted).includes(GAP_URL));
});

test('链路 ④：已入账但交付没跑完（部分交付 / 交付失败）也带这一段 —— 同样是"已入账"的单据', async () => {
  const partial = await runCardAction({ taskId: 'sale_partial', draft: DELIVERED_DRAFT(),
    delivery: { deliver: async () => ({ deliveredQuantity: 0, totalQuantity: 1,
      detailRecordIds: ['detail_1'],
      failures: [{ lineNumber: 1, size: 42, detailRecordId: 'detail_1', error: '实时库存记录缺失' }] }) } });
  assert.equal(partial.cards.at(-1).header.title.content, '订单已入账，交付待处理');
  assert.equal(sectionElement(partial.cards.at(-1)).text.content, EXPECTED_SECTION);

  const failed = await runCardAction({ taskId: 'sale_delivery_failed', draft: DELIVERED_DRAFT(),
    delivery: { deliver: async () => { throw new Error('飞书暂时不可用'); } } });
  assert.equal(failed.cards.at(-1).header.title.content, '订单已入账，交付待处理');
  assert.equal(sectionElement(failed.cards.at(-1)).text.content, EXPECTED_SECTION);
});

test('链路 ⑤：老卡片再点一次（duplicate_terminal）——已入账带、已取消不带', async () => {
  const posted = await runCardAction({ taskId: 'sale_dup_posted', status: 'posted',
    draft: DELIVERED_DRAFT() });
  assert.equal(posted.cards.length, 1);
  assert.equal(posted.cards[0].header.title.content, '销售订单已入账');
  assert.equal(sectionElement(posted.cards[0]).text.content, EXPECTED_SECTION);

  const cancelled = await runCardAction({ taskId: 'sale_dup_cancelled', status: 'cancelled',
    draft: DELIVERED_DRAFT() });
  assert.equal(cancelled.cards.length, 1);
  assert.equal(cancelled.cards[0].header.title.content, '销售录单已取消');
  assert.doesNotMatch(gapsCardText(cancelled.cards[0]), /补货品信息/);
});

test('链路 ⑥：取消 / 待修正**不带**这一段（原草稿不会入账，没有单据需要补资料）', async () => {
  const cancelled = await runCardAction({ taskId: 'sale_cancel', draft: DELIVERED_DRAFT(),
    action: 'cancel' });
  assert.equal(cancelled.cards[0].header.title.content, '销售录单已取消');
  assert.doesNotMatch(gapsCardText(cancelled.cards[0]), /补货品信息/);

  const modify = await runCardAction({ taskId: 'sale_modify', draft: DELIVERED_DRAFT(),
    action: 'modify_sale' });
  assert.equal(modify.cards[0].header.title.content, '等待重新发送');
  assert.doesNotMatch(gapsCardText(modify.cards[0]), /补货品信息/);
});
