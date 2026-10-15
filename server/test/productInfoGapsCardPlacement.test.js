// 「补货品信息」段落**位置**的回归测试（业务负责人 2026-10-07 拍板；同一天她改过两次口径）。
//
// 起因（她原话，逐字）：「我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了。
//   所以我们在销售信息确认卡片里不需要放这个信息；等用户点击确认之后，卡片不是会更新吗？
//   更新时再补这个信息。」
// ⇒ 这一段从「请确认销售订单」卡挪到**点确认之后更新的卡片**（那张确认卡已于 2026-10-12 退场）。
//
// 🔴 她要的是**哪几张**：同一天改了两次，**本文件钉的是【最后一次】**（别再翻回去）：
//   ① 第一版（PR #220）：**处理中卡 + 已入账终态卡都放**；
//   ② 她随后**纠正**（逐字）：「**不是，是只放在2上！**」
//      她的编号：① =「销售订单处理中」卡（`salesProcessingCard`，stage=processing，
//      点确认后 0.3 秒出现、只停留 1~2 分钟就被终态卡 patch 覆盖）；
//      ② = 绿色「销售订单已入账」终态卡（`salesStatusCard` 的 posted 分支，长期留着）。
//      ⇒ PR #221 收窄成**只放 ②**（处理中卡那一行删掉）；
//   ③ 她当天**再改口**（逐字，**这是最新口径**）：
//      「我要说一下，我刚才跟你说我们的补货品信息提示只在终态，其实还有一个中间态。
//        我现在觉得，中间态也应该有提示。是的，中间态也应该有，所以也需要你补充下～」
//      ⇒ **最终 = ① 和 ② 都要有**（处理中卡那一行已加回来）。
//   🔴 2026-10-15（业务负责人拍板「**清掉吧**」）：**中间态那一刀随「处理中卡」退场而**
//      **无载体**（那张卡生产侧没人发 ⇒ 她永远看不到它）⇒ 判据落到**她真能看到的**
//      **toast** 上：点卡片按钮后 `larkMvpService.completeDealFromCard` 回的那三种 toast
//      （`shortStock` / `askingToast` / `successToast`），**已由
//      `test/terminalCardConfirmDeal.test.js`（`:498` `:563` `:772` 逐字）钉住** ✓
//      ⇒ **口径一个字都没丢**，只是从"死卡的排布"搬到了"她真能看到的 toast"上 ✓
//   ⚠️ 从头到尾**没变**的一条：**确认卡片（点之前）不要**。
//
// 验收标准（逐条钉在这里；括号里是钉它的用例）：
//   ① 确认卡片**不含**该段落 —— 有缺口不含，无缺口**也不留空壳**（1）
//   ② ~~处理中卡**含**该段落…~~ **2026-10-15 起作废**：处理中卡随死代码清理退场
//      （她的口径改由 toast 承载，见文件头）⇒ 原来钉"这张死卡排布"的两条**已删**
//      —— **删的是无载体的死卡排布，不是她的口径** ✓；"这一段逐字 + 链接 url 逐字"
//      仍由 ③（终态卡）与下面"链接 url"那条（两张活卡对照）钉着 ✓（判据没放宽 ✗）
//   ③ 终态「已入账」卡**含**该段落，行格式逐字、链接 url 逐字（4、9；一条不许放宽）
//   ④ 无缺口时，三张卡都**不出现**该段落（1、5）
//   ⑤ 链接仍是那条货品记录的飞书 url（3、4、9；url 直接来自 `draft.product_info_gaps[].url`）
//   ⑥ 段落文案走 `config/productInfoGaps`，每项可覆盖（6、7）
//   ⑦ 覆盖分支：posted / delivery_partial / delivery_failed / duplicate_terminal(已入账) 带，
//      cancelled / awaiting_correction / duplicate_terminal(已取消) **不带**（8、9、10、11）
//   ⑧ 点确认这条链路上**没有**为了这段文字再读一次「货品信息」表（9）
//
// ⚠️ 本文件是**新增**的；既有断言只在"位置变了"的地方改（见 larkCards.test.js /
//   larkMvpService.test.js 的对应注释），**没有一条是放宽** —— 处理中卡那几条被 #221 翻成
//   "不含"（反向断言）、本次按 ③ 的最新口径又翻回"含"；**终态卡那几条从始至终一条都没动**。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { LarkMvpService } = require('../src/services/larkMvpService');
// ⚠️ 2026-10-15：`salesProcessingCard`（处理中卡）已随死代码清理删除（生产侧没人发 ✗）
const { salesStatusCard, productInfoGapsElements } =
  require('../src/utils/larkCards');
const {
  PRODUCT_INFO_GAPS_DEFAULTS,
  resolveProductInfoGapsConfig,
} = require('../src/config/productInfoGaps');

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

test('状态卡片：有缺口也不出现「补货品信息」段落（位置已挪走）——原确认卡退场后换这个入口', () => {
  // ⚠️ 2026-10-12（3b）：原来钉在「请确认销售订单」那张卡上；它随销售草稿卡片退场 ⇒
  //    换到**仍在跑**的销售状态卡片（larkMvpService 的已成交出口）钉同一条口径。
  const withGaps = salesStatusCard({ items: ITEMS, product_info_gaps: GAPS }, '已成交', '已经写好了');
  assert.doesNotMatch(gapsCardText(withGaps), /补货品信息/);
  assert.doesNotMatch(gapsCardText(withGaps), /去补全这条记录/);
  // 链接 url 也一个字都不许出现在确认卡片上（按**字面量**比，不用 RegExp 转义 ——
  // 手工拼正则容易漏转义，CodeQL 会（正确地）报 Incomplete string escaping）。
  assert.ok(!gapsCardText(withGaps).includes(GAP_URL));
  // 有缺口 / 无缺口两张卡**逐字相同**：确认卡片对 `product_info_gaps` 完全无感，
  // 也就不会"去掉之后留一个空壳"。
  const withoutGaps = salesStatusCard({ items: ITEMS }, '已成交', '已经写好了');
  assert.deepEqual(withGaps, withoutGaps);
});

// ── ② 中间态（原「处理中卡」）：**那一刀随卡退场而无载体**（2026-10-15 拍板清理）──
//     🔴 **删掉的是"无载体的死卡排布"，不是她的口径**：
//        · 她 2026-10-07 ③「**中间态也应该有提示**」现在由**她真能看到的 toast** 承载
//          （`completeDealFromCard` 的 `shortStock` / `askingToast` / `successToast`）
//        · **已由活用例钉住**：`test/terminalCardConfirmDeal.test.js` `:498` `:563`（同一断言）
//          ＋ `:772`（逐字断言 `config.shortStock === '这批还没到，先去入库再回来点'`）✓
//        · 原来这条钉的是**那张死卡独有的排布**（`elements` 逐字 = 进度行 + 明细 + 这一段 + note
//          ＋"note 仍是最后一行"）—— 卡没了 ⇒ 排布无从表达；**这一段本身**的逐字格式仍由
//          下面 ③ 的终态卡用例（`:143`）与配置那几条（`:190` 起）钉着 ✓（一条都没放宽 ✗）

// ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
//   改前逐字：`const processing = salesProcessingCard(…)` ⇒ 再与终态卡比"这一段逐字相同"
//   改后逐字：两张**活卡**（已入账 / 部分交付）比"这一段逐字相同"
//   依据：这条判据的本意 =「**这一段的拼法只有一处、跟挂在哪张卡上无关**」⇒
//     处理中卡退场后，用两张她**真能看到**的活卡钉**同一件事**（覆盖面不减 ✓ 判据没放宽 ✗）
test('链接 url 逐字等于那条货品记录的飞书 url（不重拼、不改写）——两张活卡上的这一段逐字相同', () => {
  const posted = salesStatusCard({ items: ITEMS, product_info_gaps: GAPS },
    '销售订单已入账', 'm', 'green', { productInfoGaps: true });
  assert.ok(sectionElement(posted).text.content.includes(`(${GAP_URL})`),
    'markdown 链接的 url 必须是 draft 里那一条，一个字都不能动');
  // 另一张**活卡**（部分交付）上的同一段必须**逐字相同**（这一段只有一处拼法 ✓）
  const partial = salesStatusCard({ items: ITEMS, product_info_gaps: GAPS },
    '部分已交付', 'm', 'blue', { productInfoGaps: true });
  assert.equal(sectionElement(posted).text.content, sectionElement(partial).text.content,
    '两张活卡上的这一段必须逐字相同（拼法只一处 ✓）');
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

// ── ④ 无缺口：三张卡都不出现（不留空壳）──────────────────────────────────

// ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
//   改前逐字：`'确认卡 / 处理中卡 / 终态卡**三张**都不出现该段落，也不多出空元素'`
//   改后逐字：`'确认卡 / 终态卡（已入账 + 部分交付两张）都不出现该段落，也不多出空元素'`
//   依据：判据本意 =「**没有缺口时哪张卡都不许留空壳 / 不许出现那一段**」⇒
//     处理中卡退场后改成**两张活卡的不同分支**（已入账 + 部分交付）⇒ 覆盖面不减 ✓
test('无缺口时：确认卡 / 终态卡（已入账 + 部分交付）都不出现该段落，也不多出空元素', () => {
  const draft = { items: ITEMS, product_info_gaps: [] };
  const posted = salesStatusCard(draft, '销售订单已入账', 'm', 'green', { productInfoGaps: true });
  assert.doesNotMatch(gapsCardText(posted), /补货品信息/);
  assert.equal(posted.elements.length, 2);
  assert.equal(sectionElement(posted), undefined, '没有第 3 个空壳');
  // `product_info_gaps` 整个字段缺失（老任务）也要当空处理 ⇒ 与"空数组"那张**逐字相同**。
  const legacy = salesStatusCard({ items: ITEMS }, '销售订单已入账', 'm', 'green', { productInfoGaps: true });
  assert.deepEqual(legacy, posted);
  // 另一张**活卡**分支（部分交付）同样：不出现那一段、也不多出空元素。
  const partial = salesStatusCard(draft, '部分已交付', 'm', 'blue', { productInfoGaps: true });
  assert.doesNotMatch(gapsCardText(partial), /补货品信息/);
  assert.equal(sectionElement(partial), undefined, '部分交付那张也不许有空壳 ✓');

  // 确认卡片（第一张）：无缺口时同样不留空壳 —— 与"有缺口"那张逐字相同。
  const confirmation = salesStatusCard(draft, '已成交', '已经写好了');
  assert.doesNotMatch(gapsCardText(confirmation), /补货品信息/);
  assert.deepEqual(confirmation, salesStatusCard({ items: ITEMS }, '已成交', '已经写好了'));
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

// ⚠️ 下面三条原来经「处理中卡」渲染这一段来钉上限 / 文案；#221 收窄到"只终态卡"时
//   改成用**真正的渲染器**（`productInfoGapsElements`）与**终态卡**来钉。
//   本次按她最新口径把处理中卡加回来，于是**再补一条**（处理中卡上也钉一次上限），
//   原来的三条**一条都没动**；钉的还是同一件事，没有放宽。

test('渲染：超过默认上限（6）时只列 6 条，最后一行是"{count}"替换后的那句', () => {
  const many = Array.from({ length: 8 }, (_unused, index) => ({
    record_id: `p_${index}`, label: `6635${index}白`, missing: ['成本'],
    missing_sample_image: false, url: `https://example.com/p/${index}`,
  }));
  const [section] = productInfoGapsElements({ items: ITEMS, product_info_gaps: many },
    resolveProductInfoGapsConfig({}));
  const content = section.text.content;
  assert.match(content, /66350白/);
  assert.match(content, /66355白/);
  assert.doesNotMatch(content, /66356白/, '第 7 条（下标 6）不该出现');
  assert.match(content, /还有 2 个颜色也缺资料/);
});

// ⭐⭐ 2026-10-15（清理死代码）**成对改指向**：
//   改前逐字：`test('处理中卡：缺口超过上限时同样只列这么多条…')`（钉"处理中卡也吃同一套上限"）
//   改后逐字：`test('活卡（部分交付）：缺口超过上限时同样只列这么多条…')`
//   依据：这条的本意 =「**上限 / 溢出那句跟挂在哪张卡上无关**（同一个渲染器、不是另抄一份）」
//     ⇒ 处理中卡退场后换成**另一张活卡**（部分交付）钉**同一件事** ✓（判据没放宽 ✗）
test('活卡（部分交付）：缺口超过上限时同样只列这么多条，最后一行是"{count}"替换后的那句', () => {
  const many = Array.from({ length: 8 }, (_unused, index) => ({
    record_id: `p_${index}`, label: `6635${index}白`, missing: ['成本'],
    missing_sample_image: false, url: `https://example.com/p/${index}`,
  }));
  const card = salesStatusCard({ items: ITEMS, product_info_gaps: many },
    '部分已交付', 'm', 'blue', { productInfoGaps: true });
  const content = sectionElement(card).text.content;
  assert.match(content, /66350白/);
  assert.match(content, /66355白/);
  assert.doesNotMatch(content, /66356白/, '第 7 条（下标 6）不该出现');
  assert.match(content, /还有 2 个颜色也缺资料/);
});

test('终态卡：缺口超过上限时只列这么多条，最后一行是"{count}"替换后的那句', () => {
  const many = Array.from({ length: 8 }, (_unused, index) => ({
    record_id: `p_${index}`, label: `6635${index}白`, missing: ['成本'],
    missing_sample_image: false, url: `https://example.com/p/${index}`,
  }));
  // 走终态卡（她最初点名要长期留着的那一张）：说明上限也照样在这张卡上生效。
  // ⚠️ 2026-10-15：处理中卡已随死代码清理退场（她的口径改由 toast 承载，见文件头）
  //    ⇒ 这一段现在**就是**挂在终态卡（`options.productInfoGaps`）上；上面那条"部分交付
  //    也吃同一套上限"是**另一张活卡**的对照 ✓
  const card = salesStatusCard({ items: ITEMS, product_info_gaps: many },
    '销售订单已入账', 'm', 'green', { productInfoGaps: true });
  const content = sectionElement(card).text.content;
  assert.match(content, /66350白/);
  assert.match(content, /66355白/);
  assert.doesNotMatch(content, /66356白/, '第 7 条（下标 6）不该出现');
  assert.match(content, /还有 2 个颜色也缺资料/);
});

test('渲染：段落文案全部来自配置（换一份配置就换一份卡面），逻辑里没有写死的中文', () => {
  // 默认配置下：逐字 = 挪位置之前那张确认卡片上的原文（一个字节都没改）。
  assert.equal(productInfoGapsElements({ product_info_gaps: GAPS },
    resolveProductInfoGapsConfig({}))[0].text.content, EXPECTED_SECTION);
  // 换一份全改过的配置：卡面随之改变，而且**默认那套中文一个字都不出现**
  // —— 证明字面量确实走配置，不是写死在渲染器里。
  const custom = resolveProductInfoGapsConfig({
    PRODUCT_INFO_GAPS_TITLE: '要补的资料',
    PRODUCT_INFO_GAPS_MISSING_LABEL: '缺：',
    PRODUCT_INFO_GAPS_SAMPLE_IMAGE_LABEL: '产品图',
    PRODUCT_INFO_GAPS_LINK_LABEL: '点这里去补',
    PRODUCT_INFO_GAPS_OVERFLOW_TEXT: '另有 {count} 条',
  });
  const [element] = productInfoGapsElements({ product_info_gaps: GAPS }, custom);
  assert.equal(element.text.content,
    `要补的资料\n66356米 缺：成本、产品图\n[点这里去补](${GAP_URL})`);
  assert.doesNotMatch(element.text.content, /补货品信息|还差：|样例图|去补全这条记录/);
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
    references: {}, store,
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






