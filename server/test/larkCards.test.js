const test = require('node:test');
const assert = require('node:assert/strict');
const {
  // ⚠️ 2026-10-12（3b + 售后卡片退场）：原来 import 的销售确认卡片、售后确认卡片都已退场；
  //    它们名下还活着的口径（逐件金额 / 按钮裁剪）都迁到**仍在跑**的销售状态卡片上 ✓
  salesStatusCard,
  purchaseStatusCard,
  sampleReplacementCard,
  keepOnlyCardButton,
} = require('../src/utils/larkCards');

// 这一组测试锁的是「移动端实测确认过的排版」，不是实现细节：
// 多按钮必须用 column_set（action 在手机上会堆成多行），销售确认卡片必须分字号层级。
// 详见 src/utils/larkCards.js 里 buttonColumns 的注释（原那张确认卡的注释已随它退场）。

// 卡片里所有 column_set 按钮（按出现顺序）。
const columnSetButtons = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .flatMap((element) => element.columns.flatMap((column) => column.elements))
  .filter((child) => child.tag === 'button');

// 卡片里遗留的 action 按钮（多按钮卡片应越来越少见）。
const actionButtons = (card) => card.elements
  .filter((element) => element.tag === 'action')
  .flatMap((element) => element.actions);

// 每个「按钮行」放几个按钮——用来断言"一行最多 3 个"。
const buttonRowWidths = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .map((element) => element.columns
    .filter((column) => column.elements.some((child) => child.tag === 'button')).length)
  .filter((width) => width > 0);

// 按钮行的列必须均分（weight: 1），且列里只放一个按钮。
const assertButtonRowsAreEqualWeight = (card) => {
  for (const element of card.elements.filter((item) => item.tag === 'column_set')) {
    if (!element.columns.some((column) => column.elements.some((child) => child.tag === 'button'))) continue;
    assert.equal(element.flex_mode, 'none');
    assert.equal(element.horizontal_spacing, '8px');
    for (const column of element.columns) {
      assert.equal(column.width, 'weighted');
      assert.equal(column.weight, 1);
      assert.equal(column.elements.length, 1, '每列只放一个按钮');
      assert.equal(column.elements[0].tag, 'button');
    }
  }
};

const saleDraft = (overrides = {}) => ({
  items: [{ item_no: '66356', size: 42, quantity: 1, actual_amount: 99 }],
  agreed_total: 99,
  payments: [{ method: '微信', amount: 99 }],
  trade_type: '现货',
  delivery_status: '已交付',
  ...overrides,
});

const sampleSizes = (sizes) => sizes.map((size) =>
  ({ size, doorBoxCount: 1, sampleCount: 0, warehouseCount: 0 }));

// —— 问题 1：多按钮一律 column_set ——



// 🔴 2026-10-07 口径（业务负责人逐字「甲 去掉」）：候选按钮**只显示颜色名**。
// ⚠️ 这条是**反向断言**（不是放宽）：旧断言是"等于 `黑（有货）`/`白（无货）`"，
//    现在①**逐字等于纯颜色名**（多一个字符就红），②再 `doesNotMatch` 显式禁止
//    「有货」「无货」出现在卡片上，③并且**故意让候选带上 `stock_status`** ——
//    证明渲染层已经完全不认识这个字段（加回去就会红）。




test('采购状态卡片：尺码网格走 column_set（不是 action）—— 共用同一套明细渲染器', () => {
  const card = purchaseStatusCard({ items: [{ item_no: 'A100', color: '黑', size: 40, quantity: 2 }] },
    '采购申请处理中', '已收到确认，正在生成采购申请；请勿重复点击。', 'blue');
  assert.deepEqual(actionButtons(card), [], '明细网格不许退化成 action（手机上会竖排）');
  const grid = sizeGridRows(card);
  assert.equal(grid.length, 1);
  assert.equal(grid[0].length, 6, '只有 1 个尺码也要铺成 6 列，否则最后一行宽度不齐');
  assert.equal(grid[0][0], '**40**\n×2');
  assertButtonRowsAreEqualWeight(card);
});


test('样品补选卡片：候选尺码用 column_set；单个「刷新」保持 action', () => {
  const card = sampleReplacementCard('task_1', {
    productNumber: 'A100', remainingSizes: sampleSizes([40, 41, 42]),
  });
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content),
    ['选 40 码', '选 41 码', '选 42 码']);
  assert.deepEqual(buttonRowWidths(card), [3]);
  // 单个按钮没有换行问题，刻意保持 action 元素。
  assert.deepEqual(actionButtons(card).map((button) => button.text.content), ['刷新可选尺码']);
  assertButtonRowsAreEqualWeight(card);
});


test('样品补选卡片：候选尺码超过 3 个也折成多个 column_set', () => {
  const card = sampleReplacementCard('task_1', {
    productNumber: 'A100', remainingSizes: sampleSizes([40, 41, 42, 43, 44]),
  });
  assert.deepEqual(buttonRowWidths(card), [3, 2]);
  assert.deepEqual(columnSetButtons(card).map((button) => button.text.content),
    ['选 40 码', '选 41 码', '选 42 码', '选 43 码', '选 44 码']);
  assertButtonRowsAreEqualWeight(card);
});

// —— 问题 2：销售确认卡片的字号层级（V3） ——


// ⭐ 2026-10-07 口径大改：卡片把三件事**分开说**（业务负责人逐字：
//   「【卡片 = 分开说】类型 · 履约状态 · 收款情况（已收多少、还欠多少）」）。
//   ⚠️ 这条断言**不是放宽**：原来钉的是「交易类型：现货 · 已交付」**一行**，
//      现在钉的是**三行**（类型 / 履约 / 收款），信息量变多了。


// ⚠️ 2026-10-07 改写（**只因为"位置变了"，不是放宽**）：
//   业务负责人拍板把「补货品信息」段落从确认卡片挪到**点确认之后更新的卡片**：
//   ⭐ **最终口径 = 处理中卡 ＋ 已入账终态卡都带**（当天她改过两次：
//   先"两边都放"(#220) → 纠正「不是，是只放在2上！」(#221) → 再改口
//   「中间态也应该有提示」⇒ 加回处理中卡；逐字原话见
//   test/productInfoGapsCardPlacement.test.js 与 docs/product-info-gaps-card-move-2026-10-07.md）。
//   原断言钉的是"确认卡片上有这一段 note 小字"；现在钉的是**它的反面**：
//   有缺口时确认卡片上也**没有**这一段 —— 而且与"无缺口"那张卡**逐字相同**
//   （去掉之后连空壳都不留）。段落本身的字号 / 行格式 / 链接
//   在新增文件里按同一套标准钉着（note 小字 + 逐字行格式 + 逐字 url），覆盖面没有丢。



test('多件时必须逐件显示金额（原销售确认卡片退场 ⇒ 改用仍在跑的销售状态卡片钉同一条口径）', () => {
  // ⚠️ 2026-10-12（3b）：口径本身仍有效（她要逐件核对，不显示就会记错账）；
  //    `itemLines` 是**共用渲染器**，仍在跑的销售状态卡片（`larkMvpService` 的已成交出口）就走它
  //    ⇒ 换这个入口钉，覆盖面不减（与采购那条"卡片删了就换仍活的入口"同一套做法）。
  const card = salesStatusCard(saleDraft({
    items: [
      { item_no: '66356', size: 42, quantity: 1, actual_amount: 99 },
      { item_no: '66357', size: 40, quantity: 1, actual_amount: 128 },
    ],
    agreed_total: 227,
  }), '已成交', '已经写好了');
  const content = card.elements[0].content;
  assert.match(content, /1\. 66356 42码 × 1 ￥99/);
  assert.match(content, /2\. 66357 40码 × 1 ￥128/);
});

// —— 重试卡片：只收窄"含目标按钮"的那一组 ——

test('只留目标按钮：其余按钮组整组收窄（入口一路换到仍在跑的销售状态卡片上，通用行为不变）', () => {
  // ⚠️ 2026-10-12：`keepOnlyCardButton` 是**通用行为**（只留目标按钮、其余原样）——
  //    它先是搭在销售确认卡片的"颜色候选组"上、后来搭在售后确认卡片上，这两张卡都已退场；
  //    ⇒ 现在搭在**仍在跑**的销售状态卡片的「确认成交」按钮上。**能力一次都没退场** ✓
  const card = salesStatusCard({ items: [] }, '已入账', '已经写好了', 'blue',
    { confirmDeal: { salesEntryRecordId: 'rec_1', draftId: 'd' } });
  const actionsBefore = columnSetButtons(card).map((button) => button.value.action);
  assert.ok(actionsBefore.length >= 1, `这张卡本来就带按钮：${actionsBefore.join(',')}`);
  keepOnlyCardButton(card, actionsBefore[0]);
  assert.deepEqual(columnSetButtons(card).map((button) => button.value.action), [actionsBefore[0]],
    '只留目标按钮，其余按钮组整组收窄掉');
});

// —— 采购明细的渲染规则：尺码网格每行 6 个 + 货号 → 颜色 → 尺码 三层分组 + 🆕 ——
//
// ⚠️ 这一段原先是用「采购到货明细卡片」（purchaseArrivalDetailCard）验证的。
// 2026-10-05 拍照识别链路退场、到货卡片删除，于是改用**仍在使用同一套渲染器**
// （purchaseItemElements）的「采购状态卡片」（`purchaseStatusCard`）来钉同样的排版规则——
// 渲染器没被削弱，只是换了个入口去测它。
// ⚠️ 2026-10-08：「采购申请确认卡片」（purchaseRequestConfirmationCard）也已删除，
// 上面那条"换入口"的结论不变：现在用的是 `purchaseStatusCard`（免确认链路在跑）。
// 锁的是产品负责人 2026-10-05 提的两条：
//   1. 尺码网格每行至少 6 个（现在是 6，超过换行，且每行都恰好 6 列）；
//   2. 明细先按货号、再按颜色、颜色下面是尺码，顺序稳定。
// 6 列 / 短文本 / column_set 都有移动端实测依据，见 src/utils/larkCards.js 的注释。

// 尺码网格行：6 列的 column_set（其它 column_set 是按钮行等）。
const sizeGridRows = (card) => card.elements
  .filter((element) => element.tag === 'column_set')
  .filter((element) => element.columns.length === 6)
  .map((element) => element.columns.map((column) => column.elements[0].content));

const markdownLines = (card) => card.elements
  .filter((element) => element.tag === 'markdown')
  .map((element) => element.content);

// 把卡片读成「分组骨架」：[货号:X, 颜色:Y, 尺码:36,37, ...]。
// 只关心排版结构，不关心每个格子里的数量/价格。
// ⚠️ 用 alternation 而不是字符类：🏷 是增补平面字符，塞进 [...] 只会匹配到半个代理对。
const ITEM_NO_HEADING = /^\*\*(?:🏷️?|⚠️?)/u;
const groupingSkeleton = (card) => {
  const layout = [];
  for (const element of card.elements) {
    if (element.tag === 'markdown' && ITEM_NO_HEADING.test(element.content)) {
      layout.push(`货号:${element.content.replace(/^\*\*(?:🏷️?|⚠️?)\s*/u, '').replace(/\*\*$/, '')}`);
      continue;
    }
    if (element.tag === 'markdown' && element.content.startsWith('▸ ')) {
      layout.push(`颜色:${element.content.slice(2)}`);
      continue;
    }
    if (element.tag === 'column_set' && element.columns.length === 6) {
      const sizes = element.columns
        .map((column) => column.elements[0].content)
        .filter((content) => content.trim() !== '')
        .map((content) => content.match(/\*\*(\d+)\*\*/)[1]);
      layout.push(`尺码:${sizes.join(',')}`);
    }
  }
  return layout;
};

// 明细行：渲染器只认 item_no / color / size / quantity / created_product 这些字段，
// 采购申请确认卡片 2026-10-08 删除后，改由仍在跑的「采购状态卡片」承载同样的输入形状。
const detailItem = (itemNo, color, size, quantity = 1, extra = {}) => ({
  product_record_id: `prod_${itemNo}_${color}`,
  item_no: itemNo,
  color,
  size,
  quantity,
  ...extra,
});

const detailCard = (items) => purchaseStatusCard({ items }, '采购申请处理中', '测试用状态卡', 'blue');

test('明细尺码网格：每行恰好 6 列，超过 6 个换行（产品负责人要求每行至少 6 个）', () => {
  const sizes = [36, 37, 38, 39, 40, 41, 42, 43];
  const card = detailCard(sizes.map((size) => detailItem('1366-31', '棕色', size)));
  const rows = sizeGridRows(card);
  assert.equal(rows.length, 2, '8 个尺码要折成 2 行');
  for (const row of rows) {
    assert.equal(row.length, 6, '每一行都必须是 6 列：不足要补空列，否则最后一行在手机上宽度对不齐');
  }
  assert.deepEqual(rows[0], ['**36**\n×1', '**37**\n×1', '**38**\n×1', '**39**\n×1', '**40**\n×1', '**41**\n×1']);
  assert.deepEqual(rows[1].slice(0, 2), ['**42**\n×1', '**43**\n×1']);
  assert.deepEqual(rows[1].slice(2), [' ', ' ', ' ', ' ', ' ', ' '].slice(0, 4), '第二行只剩 2 个尺码，补 4 个空列');
  // 尺码网格是纯文字 column_set，绝不能退化成 action（action 在手机上会竖向堆叠）。
  assert.deepEqual(actionButtons(card), []);
});

test('明细尺码格：用「尺码 + ×数量」短文本，不写会撑破 6 列格子的「码」字', () => {
  const card = detailCard([detailItem('1366-31', '棕色', 37, 2, { unit_cost: 199 })]);
  const row = sizeGridRows(card)[0];
  assert.equal(row[0], '**37**\n×2\n￥199');
  assert.doesNotMatch(row[0], /码/, '6 列下「37码 × 2」会换行撑破格子（移动端实测），别改回长写法');
  // 只有 1 个尺码也要 6 列
  assert.equal(row.length, 6);
});

test('明细分組：货号 → 颜色 → 尺码，各组按字典序稳定排序、内容正确归位', () => {
  const items = [
    detailItem('B200', '白', 39),
    detailItem('A100', '黑', 40),
    detailItem('B200', '白', 38),
    detailItem('A100', '黑', 38),
    detailItem('A100', '红', 41),
    detailItem('A100', '红', 40),
  ];
  const card = detailCard(items);
  assert.deepEqual(groupingSkeleton(card), [
    '货号:A100',
    '颜色:红',
    '尺码:40,41',
    '颜色:黑',
    '尺码:38,40',
    '货号:B200',
    '颜色:白',
    '尺码:38,39',
  ]);
  // 同一份输入渲染两次，顺序必须完全一样（不能跟着模型返回的顺序跳）。
  const again = detailCard([...items].reverse());
  assert.deepEqual(groupingSkeleton(again), groupingSkeleton(card), '分组顺序必须与输入顺序无关');
});

test('明细分組：没匹配到货品表的货号标 ⚠️；单据上没颜色就不编一个颜色标题', () => {
  const card = detailCard([
    { product_record_id: '', item_no: 'A100', color: '', size: 38, quantity: 1 },
  ]);
  const lines = markdownLines(card);
  assert.ok(lines.some((line) => line.includes('⚠️') && line.includes('A100')), '未匹配的货号要用 ⚠️ 标出来');
  assert.equal(lines.filter((line) => line.startsWith('▸ ')).length, 0, '没有颜色就不要写颜色小标题');
  assert.deepEqual(sizeGridRows(card), [['**38**\n×1', ' ', ' ', ' ', ' ', ' ']]);
});

test('采购状态卡片：供应商分组保留，供应商内也是 货号 → 颜色 → 尺码', () => {
  const card = detailCard([
    { item_no: 'A1', color: '黑', size: 40, quantity: 1, supplier: '金猴' },
    { item_no: 'A1', color: '黑', size: 41, quantity: 1, supplier: '金猴' },
    { item_no: 'B1', color: '白', size: 38, quantity: 1, supplier: '奥康' },
  ]);
  const lines = markdownLines(card);
  assert.ok(lines.some((line) => line.includes('供应商：金猴')), '非批量卡片仍要按供应商分区');
  assert.ok(lines.some((line) => line.includes('供应商：奥康')));
  assert.deepEqual(groupingSkeleton(card), [
    '货号:A1', '颜色:黑', '尺码:40,41',
    '货号:B1', '颜色:白', '尺码:38',
  ]);
});

// 原「到货明细卡片：不再有独立的「🆕 有 N 个新品」那段」与「到货结果卡片：确认之后给创建好的
// 链接」两条用例整条删除：它们断言的都是 purchaseArrivalDetailCard / newProductResultElements
// 这两张**已删除**的卡片（"已建好基础资料"那句、"正在入库，如有新品，稍后把链接给你"那段、
// 以及 open 开关才给链接的行为）。到货确认这一步整体退场，没有卡片可断言；
// 建档能力本身的断言在 purchaseWebhookService.test.js 里保留（ensureArrivalProducts）。

test('明细卡片：新品按货号级标一次（多行/多颜色不重复），颜色级不标', () => {
  const card = detailCard([
    // 同一货号：两个颜色、三个尺码，全部是新品 → 只在货号标题上标一次。
    { item_no: '6035', color: '黑', size: 36, quantity: 1, created_product: true },
    { item_no: '6035', color: '黑', size: 37, quantity: 1, created_product: true },
    { item_no: '6035', color: '白', size: 36, quantity: 1, created_product: true },
    // 该货号只有一行是新品（另一行已匹配上老货品）→ 货号照标一次。
    { item_no: '6036', color: '灰', size: 36, quantity: 1, product_record_id: 'prod_6036' },
    { item_no: '6036', color: '黑', size: 36, quantity: 1, created_product: true },
    // 老货品不带 🆕。
    { item_no: '8088', color: '灰', size: 36, quantity: 1, product_record_id: 'prod_8088' },
  ]);
  const lines = markdownLines(card);
  const marked = lines.filter((line) => line.includes('🆕 新品'));
  assert.deepEqual(marked, ['**🏷 6035 · 🆕 新品**', '**🏷 6036 · 🆕 新品**'],
    `🆕 是货号级判断，一个货号只标一次：${JSON.stringify(marked)}`);
  // 待建档的新品没有 product_record_id，但它不是"没匹配上"，仍然用 🏷 而不是 ⚠️。
  assert.ok(!marked.some((line) => line.includes('⚠️')), '待建档的新品不是"未匹配"，不能标 ⚠️');
  assert.ok(lines.includes('**🏷 8088**'), '老货品不带 🆕');
  // 颜色行只有颜色本身，不夹带新品标记。
  const colors = lines.filter((line) => line.startsWith('▸ '));
  assert.ok(colors.length > 0);
  assert.ok(colors.every((line) => !line.includes('🆕')), '新品不细到颜色：颜色级不能标 🆕');
});


/** ⭐ 2026-10-15：`larkMvpService` 里是否还提到处理中卡（import / 调用都算）——摘干净了就该是 false ✓ */
const salesProcessingCardWiring = (source) => /salesProcessingCard/.test(source);

test('AC-退场哨兵 · 销售确认卡 + 售后 5 张卡 + 处理中卡都已退场（导出里没有它们；导出数 21 → 13）', () => {
  // ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
  //   改前逐字：`…（导出里没有它们；导出数 21 → 14）` ＋ `assert.equal(Object.keys(cards).length, 14, '导出数 = 14（… → 14 再删 saleLookupCard）')`
  //   改后逐字：`…（导出里没有它们；导出数 21 → 13）` ＋ `assert.equal(Object.keys(cards).length, 13, '… → 13 再删处理中卡（salesProcessingCard）')`
  //   依据：`salesProcessingCard` 已随 2026-10-15 的死代码清理删除（`src/` 生产侧 0 调用 ⇒ 它不是"还在用"）
  //     ⇒ 导出少一个；**并且**下面把它加进"**真的没了**"的名单（判据是**加强**，不是放宽 ✓）
  const cards = require('../src/utils/larkCards');
  assert.equal('salesConfirmationCard' in cards, false, '它必须已经从导出里消失');
  assert.equal(Object.keys(cards).length, 13, '导出数 = 13（21 → 20 删销售确认卡 → 15 再删售后 5 张 → 14 再删 saleLookupCard → 13 再删处理中卡）');
  // ⚠️ 2026-10-12（售后卡片链路退场）：原来这里断言"6 个都在" —— 售后那 5 个已随链路退场
  //    ⇒ 现在只断言**唯一还活着的那个**在；并逐个证明那 5 个**真的没了**（能力不是靠"忘了"活着）。
  assert.equal(typeof cards.salesStatusCard, 'function', '销售状态卡片有活调用方 ⇒ 必须在');
  // ⭐ 2026-10-15 追加：处理中卡（`salesProcessingCard`）也**真的没了**（不是靠"忘了"活着）✓
  for (const gone of ['afterSalesConfirmationCard', 'afterSalesResultCard', 'afterSalesRetryCard',
    'afterSalesStatusCard', 'afterSalesSettlementLabel', 'salesProcessingCard']) {
    assert.equal(gone in cards, false, `${gone} 已随售后卡片链路退场 ⇒ 不该还在导出里`);
  }
  const wiring = require('node:fs').readFileSync(require('node:path')
    .join(__dirname, '..', 'src', 'services', 'larkMvpService.js'), 'utf8');
  assert.equal(/salesConfirmationCard\s*[,}]/.test(wiring), false, '那行死 import 里的名字必须摘掉');
  // ⭐ 2026-10-15：那两处**没用的 import** 也必须真的摘掉（`larkMvpService` 里不再出现这个名字）✓
  assert.equal(salesProcessingCardWiring(wiring), false, '`salesProcessingCard` 的 import/调用必须摘干净');
});
