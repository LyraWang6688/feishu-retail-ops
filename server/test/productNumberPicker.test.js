/**
 * ⭐⭐ 2026-10-15 业务负责人（逐字）：
 *   ①「编号对呀，我们的编号**只要它在货品信息里就行了**」
 *   ②「这个编号现在有个问题，**是否可以就让用户选择呢？然后它的选项是来自于货品信息里面的编号**」
 *   ⇒「货品 → 标签打印 → **选择编号打印**」那一格从"手输一个编号"升级成**可搜索的编号选择器**：
 *     选项**实时来自**只读端点（契约冻结在 task-9）：
 *       `GET /api/workbench/products/numbers?keyword=<str>&limit=<1..500，默认 200>`
 *       → `{ success, total, truncated, numbers: [{ number, itemNo, color, category, hasStock, recordId }] }`
 *     ⚠️ 服务端由 T1 并行实现 ⇒ **本文件一律用假 api**（不碰真网络、不依赖服务端进度）。
 *   ⚠️ 落点**一个字不改**：选中只是把编号填进既有的那个输入框，跳转仍走**既有表单提交**那一条
 *     （`targetTemplate = '/workbench/label-print.html?keyword={itemNo}'`）——**不新开页面、不新开接口** ✗。
 *   ⚠️ 拉不到 / 超时 ⇒ **人话 + 仍可手输**（她最恨"点了没反应" ✗）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-U1 选择器的选项**来自那个端点**（假 api 注入 ⇒ 选项 = 注入的编号）；
 *        `keyword` 会**传给服务端**（不在前端造第二份数据源 ✗）；选中 ⇒ 落点是**既有**那个。
 *  AC-U2 `hasStock:false` ⇒ 页面上有那句"还没入库 / 不印尺码行"的提示（**能真红**）。
 *  AC-U2b ⭐ task-15：`hasStock:null`（**未确认**）⇒ 既不报"没入库"、也不报"有库存"，
 *        而是"入库情况未确认"（三句文案都在 config 里）。
 *  AC-U3 端点失败 / **超时** ⇒ 人话 + **仍可手输**（不死界面：输入框还在、跳转那条路一点没变）。
 *  AC-U7 ⭐⭐ **懒加载**：**进页面一个请求都不发**；她"点开"（聚焦 / 点击）**才拉那一次**，
 *        且拉的那一刻**立刻**显示「正在读取…」，拉回来才填选项（她今天抱怨过"点开不友好"）。
 *        ⭐ task-15 追加：**空关键字点开 ⇒ 仍然零请求**。
 *        ⭐⭐ 2026-10-16 改后逐字（业务负责人**亲口**点的三处改动之二 · 逐字：「**那段文字说明删掉**」）：
 *        零请求时状态区**一个字都不写**（改前逐字：只显示"输入编号 / 货号，我就列出匹配的编号" ✗）
 *        —— 端点侧空关键字也是**零飞书读**（她逐字：「用户输入一个编号，然后系统再给出与这个模糊编号
 *        相关的选项」）⇒ 用例里"点开就拉"那一步现在必须**先有关键字**（助手 `typeAndFocus`）。
 *  AC-U8 ⭐⭐ **输入防抖**（`inputDebounceMs`，默认 400ms，可配；0 = 不防抖）：连敲 4 个字
 *        **只发 1 个请求**；**回车立即搜**（不等窗口）、Esc 取消挂起的那次。
 *  AC-U9 ⭐⭐ **超时阈值来自配置**（冷启动实测 ≈11.4s ⇒ 现 15s，不写死）；
 *        超时那条"人话 + 仍可手输"的出口**仍然有效**。
 *  AC-U6 🔴 扫码那一条（`?scan=1`）**一个字节没改** —— 源码哨兵（行为哨兵在 `scanToPrint.test.js`）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WORKBENCH = path.join(__dirname, '../public/workbench');
const read = (relative) => fs.readFileSync(path.join(WORKBENCH, relative), 'utf8');

/**
 * 把要跑的前端模块复制成 `.mjs` 平铺到一个临时目录（**只改 import 的文件名，逻辑一个字不改**）
 * —— 与 `labelPrintRender.test.js` / `workbenchFourTabs.test.js` 同一套做法。
 */
async function loadFrontendModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'number-picker-'));
  const copy = (from, to, replacements = []) => {
    let source = read(from);
    for (const [needle, replacement] of replacements) {
      assert.ok(source.includes(needle), `${from} 里没有找到要改的 import：${needle}`);
      source = source.split(needle).join(replacement);
    }
    fs.writeFileSync(path.join(dir, to), source, 'utf8');
  };
  copy('core/formatters.js', 'formatters.mjs');
  copy('core/api-client.js', 'api-client.mjs');
  copy('config/numberPicker.js', 'number-picker-config.mjs');
  copy('config/links.js', 'links.mjs');
  copy('config/domains.js', 'domains.mjs', [["from './links.js'", "from './links.mjs'"]]);
  copy('features/shared/placeholder.js', 'placeholder.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
  ]);
  copy('features/domains/pages.js', 'domains-pages.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../shared/placeholder.js'", "from './placeholder.mjs'"],
  ]);
  copy('features/labels/number-picker.js', 'number-picker.mjs', [
    ["from '../../core/formatters.js'", "from './formatters.mjs'"],
    ["from '../../core/api-client.js'", "from './api-client.mjs'"],
    ["from '../../config/numberPicker.js'", "from './number-picker-config.mjs'"],
  ]);
  const load = (name) => import(pathToFileURL(path.join(dir, `${name}.mjs`)).href);
  return {
    picker: await load('number-picker'),
    pickerConfig: await load('number-picker-config'),
    domains: await load('domains'),
    pages: await load('domains-pages'),
    apiClient: await load('api-client'),
  };
}

/** 「货品 → 标签打印」那一页的配置（落点的唯一真源）。 */
async function labelsPageConfig() {
  const { domains } = await loadFrontendModules();
  return domains.domainById('product').pages.find((page) => page.id === 'product-labels');
}

/**
 * 一个够用的假 DOM：只实现选择器真正用到的那几样
 * （`querySelector` / `value` / `textContent` / `innerHTML` / `setAttribute` / `addEventListener`）。
 */
const fakeElement = (init = {}) => {
  const element = {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    attrs: {},
    handlers: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name]; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    ...init,
  };
  return element;
};

const INPUT = 'input[name="number"]';
const OPTIONS = '[data-view="number-options"]';
const STATUS = '[data-view="number-status"]';

const fakeHost = () => {
  const elements = {
    [INPUT]: fakeElement(),
    [OPTIONS]: fakeElement(),
    [STATUS]: fakeElement(),
  };
  return { elements, querySelector: (selector) => elements[selector] || null };
};

/** 一条契约形状的编号（`hasStock` 由服务端按「实时库存」判）。 */
const numberItem = (patch = {}) => ({
  number: 'XHB8095|棕色|A',
  itemNo: 'XHB8095',
  color: '棕色',
  category: 'A',
  hasStock: true,
  recordId: 'rec-1',
  ...patch,
});

/** 假 api：记下每次 GET 的地址；可按用例注入"回什么 / 抛什么 / 永挂"。 */
const fakeApi = (options = {}) => {
  const calls = [];
  return {
    calls,
    async get(url) {
      calls.push(url);
      if (options.never) return new Promise(() => {});
      if (options.error) throw options.error;
      return options.result || { success: true, total: 2, truncated: false, numbers: [] };
    },
  };
};

/**
 * ⭐⭐ task-15 的**触发方式**（不改任何业务判据，只改"她怎么点"）：
 *   端点改成了**服务端模糊查询** —— **空关键字一次飞书都不读**（服务端侧也是零读）
 *   ⇒ 前端**空关键字也不再发请求**；⭐ 2026-10-16 起**状态区也不再写那句提示语**（改后逐字 = 空）。
 * 所以下面这些用例里"点开就拉"那一步，现在必须先有关键字：这个助手把"输入 + 点开"一次做完。
 * ⚠️ 依据：她逐字「**用户输入一个编号，然后系统再给出与这个模糊编号相关的选项**」（task-15）。
 */
const typeAndFocus = async (host, keyword = 'XHB') => {
  host.elements[INPUT].value = keyword;
  return host.elements[INPUT].handlers.focus();
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-U1 选项来自端点 / keyword 传给服务端 / 选中 ⇒ 落点是既有的那一个
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U1 选项来自只读端点（假 api 注入 ⇒ 选项 = 注入的编号），不是页面上造的第二份数据', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({
    result: {
      success: true,
      total: 2,
      truncated: false,
      numbers: [
        numberItem(),
        numberItem({ number: '0225|黑色|B', itemNo: '0225', color: '黑色', category: 'B', hasStock: false, recordId: 'rec-2' }),
      ],
    },
  });
  const host = fakeHost();
  // ⚠️ 2026-10-15 晚**改后逐字**（懒加载，见 AC-U7；判据一个字没放宽）：
  //   改前逐字：`await picker.createNumberPicker({ api }).mount(host);`
  //             `assert.equal(api.calls.length, 1, '进页面拉一次（只读）');`
  //             `assert.ok(api.calls[0].startsWith(...))`
  //   改后逐字：下面这三句 —— mount 之后**一个请求都没有**，聚焦（= 她真的点开选择器）才拉那一次；
  //             紧接着的"地址来自配置 / limit=200"两句**原样不动**。
  //   依据：Lead 2026-10-15 晚的口径 —— 这个端点要读整张「货品信息」+ 整张「实时库存」
  //        （正是今天量到 23.6 秒那次读的来源）⇒ 进页面就拉 = 她点开选择器先干等十几秒，
  //        那正是她今天抱怨的"不友好 / 点了没反应"✗。**懒加载**：进页不拉、聚焦/点开才拉。
  await picker.createNumberPicker({ api }).mount(host);
  assert.equal(api.calls.length, 0, '进页面**一个请求都不发**（懒加载，见 AC-U7）');
  // ⚠️ task-15 改（**只改触发：先输入关键字；下面的判据只多了"keyword 一定带上"这一层**）：
  //   改前逐字：`await host.elements[INPUT].handlers.focus();`（空关键字也发一次 —— 那是"读全表"时代的口径）
  //   改后逐字：`await typeAndFocus(host, 'XHB8095');` ＋ `assert.ok(api.calls[0].includes('keyword=XHB8095'))`
  //   依据：task-15 第 2 条（空关键字 ⇒ 零读、前端显示提示语）⇒ 要拉就必须有关键字。
  await typeAndFocus(host, 'XHB8095');
  assert.equal(api.calls.length, 1, '输入关键字 + 点开 ⇒ 才拉这一次（只读）');
  assert.ok(api.calls[0].startsWith('/api/workbench/products/numbers?'), `地址来自配置：${api.calls[0]}`);
  assert.ok(api.calls[0].includes('limit=200'), 'limit 走契约默认值（1..500 内）');
  assert.ok(api.calls[0].includes('keyword=XHB8095'), '关键字原样传给服务端');

  const options = host.elements[OPTIONS].innerHTML;
  assert.ok(options.includes('XHB8095|棕色|A'), '注入的编号原样成为选项');
  assert.ok(options.includes('0225|黑色|B'), '两个编号都在（选项 = 端点回的那一份）');
  assert.ok(options.includes('data-number="XHB8095|棕色|A"'), '每个选项都带得回编号（选中靠它）');
  // 无障碍：选择器要有 combobox 语义（她手机上用，读屏 / 键盘都要能用）
  const input = host.elements[INPUT];
  assert.equal(input.attrs.role, 'combobox');
  assert.equal(input.attrs['aria-expanded'], 'true');
  assert.ok(input.attrs['aria-autocomplete'], '有自动补全语义');
  assert.equal(host.elements[OPTIONS].attrs.role, 'listbox');

  // ⚠️ 前端**不许**自己造数据源（造了就会与服务端慢慢走歪）：模块里没有别的取数出口
  const source = read('features/labels/number-picker.js');
  assert.ok(/createNumberPicker|pickerNumbersUrl/.test(source));
});

test('AC-U1 输入关键字 ⇒ `keyword` 传给服务端（选项始终由服务端过滤）', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  // ⚠️ task-15 **改写**（口径翻转，逐字写了改前/改后/依据；判据没放宽）：
  //   改前逐字：`await host.elements[INPUT].handlers.focus();`
  //             `assert.equal(api.calls[0].includes('keyword='), false, '没输关键字 ⇒ 不带 keyword（全量前 200 条）');`
  //   改后逐字：空关键字聚焦 ⇒ `api.calls.length === 0` **＋ 状态行一个字都没有**（零请求、零飞书读）；
  //             然后 `value='XHB'` + 一次 input（防抖 400ms 后）⇒ 1 个请求且带 `keyword=XHB`。
  //   依据：task-15 第 2 条 —— **空关键字不再有"全量前 200 条"这回事**（她要从"输入编号"开始）；
  //         所以这一条从"空关键字也拉"翻成"空关键字不拉、有字才拉"。**"选项始终由服务端过滤"没变** ✓。
  // ⭐⭐ 2026-10-16 **再改写一次**（业务负责人**亲口**点的三处改动之二 · 逐字：「**那段文字说明删掉**」）：
  //   改前逐字：`assert.match(String(host.elements[STATUS].textContent), /输入编号/, '只把"你输入、我就列"那句提示摆出来');`
  //   改后逐字：下面这一句 —— 零请求 ⇔ 状态区**一个字符都不写**（`role="status"` 只装真实状态）✓
  //   依据：她 2026-10-16 的截图 + 逐字（那一格是 `aria-live` 状态区，**不装"怎么用"** ✗）。
  //   🔴 **不是放宽** ✗：判据从"必须写那句提示语"翻成"**必须不写**" ✓（塞回去就红，见
  //      `workbenchTrimThreeFixes20261016.test.js` 的反向哨兵）。
  await host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 0, '⭐ 空关键字 ⇒ **一个请求都不发**（服务端那边也是零读）');
  assert.equal(String(host.elements[STATUS].textContent), '', '⭐ 零请求 ⇒ 状态区**一个字都不写**（她那句使用说明已删）');
  assert.equal(host.elements[OPTIONS].innerHTML, '', '也没有选项（上一次的清掉）');

  host.elements[INPUT].value = 'XHB';
  await host.elements[INPUT].handlers.input();
  assert.equal(api.calls.length, 1, '输关键字 ⇒ 问一次服务端（不是前端本地过滤）');
  assert.ok(api.calls[0].includes('keyword=XHB'), `keyword 必须原样传上去：${api.calls[0]}`);

  // 聚焦时**不重复拉**（拉过成功的就不拉，免得她一点就一串请求）
  await host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 1, '成功拉过 ⇒ 聚焦不再补一次');
});

test('AC-U1 选中 ⇒ 填进既有输入框，落点仍是**既有**那个（不新开页面 / 不新开接口）', async () => {
  const { picker, pages } = await loadFrontendModules();
  const page = await labelsPageConfig();
  assert.equal(page.targetTemplate, '/workbench/label-print.html?keyword={itemNo}', '落点模板一个字没改');

  const api = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  // ⚠️ 2026-10-15 晚新增这一行（懒加载）：有选项的前提是"她点开过" ⇒ 先聚焦再点选项。
  //   **本用例的判据（填进既有输入框 + 既有落点 + 模块里不含落点）原样不动**。
  await host.elements[INPUT].handlers.focus();

  host.elements[OPTIONS].handlers.click({
    target: { closest: () => ({ dataset: { number: 'XHB8095|棕色|A' } }) },
  });
  assert.equal(host.elements[INPUT].value, 'XHB8095|棕色|A', '选中的编号落进既有输入框');
  // 既有表单提交那一条：模板 + 输入框的值 ⇒ 还是那个落点（渲染层一个字没改）
  assert.equal(pages.entryTarget(page.targetTemplate, host.elements[INPUT].value),
    '/workbench/label-print.html?keyword=XHB8095', '选择完走既有提交 ⇒ 既有落点');
  // ⚠️ 选择器模块自己**不许**知道任何落点（否则就是第二条路 ✗）
  assert.equal(read('features/labels/number-picker.js').includes('label-print'), false,
    '选择器模块里不许出现落点（落点的唯一真源是 config/domains.js 的 targetTemplate）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-U2 没入库 ⇒ 如实提示一句（她 2026-10-15 的口径：无库存那张不印尺码行）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U2 hasStock:false ⇒ 提示"还没入库 / 不印尺码行"；有库存的那一款给的是另一句', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({
    result: {
      success: true,
      total: 2,
      truncated: false,
      numbers: [numberItem(), numberItem({ number: '0225|黑色|B', hasStock: false })],
    },
  });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  // ⚠️ task-15：先输入关键字再点开（空关键字现在**不发请求**）—— 本用例的判据
  //   （选项带「还没入库」小标记 + 选中后那句提示正反两面）**原样不动** ✓。
  await typeAndFocus(host, 'XHB');

  // 选项上就看得见（不用等点下去）
  assert.ok(host.elements[OPTIONS].innerHTML.includes('还没入库'), '没库存的选项自己带小标记');

  host.elements[OPTIONS].handlers.click({
    target: { closest: () => ({ dataset: { number: '0225|黑色|B' } }) },
  });
  const noStock = host.elements[STATUS].textContent;
  assert.match(noStock, /还没入库/, `没库存要如实说一句：${noStock}`);
  assert.match(noStock, /尺码/, '并说清后果（标签上不印尺码那一行）');

  // 有库存的那一款不能再报"没入库"（判据要能翻面）
  host.elements[OPTIONS].handlers.click({
    target: { closest: () => ({ dataset: { number: 'XHB8095|棕色|A' } }) },
  });
  const hasStock = host.elements[STATUS].textContent;
  assert.equal(/还没入库/.test(hasStock), false, `有库存不许报"没入库"：${hasStock}`);
  assert.equal(host.elements[INPUT].value, 'XHB8095|棕色|A');
});

test('AC-U2b ⭐ task-15：`hasStock: null`（**未确认**）⇒ 既不报"没入库"、也不报"有库存"，而是"入库情况未确认"', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({
    result: {
      success: true,
      total: 2,
      truncated: false,
      numbers: [
        numberItem({ number: 'UNKNOWN|黑|A', hasStock: null, recordId: 'rec-3' }),
        numberItem({ number: '0225|黑色|B', hasStock: false, recordId: 'rec-2' }),
      ],
    },
  });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  await typeAndFocus(host, 'UNKNOWN');
  const options = host.elements[OPTIONS].innerHTML;
  assert.ok(options.includes('入库情况未确认'), '⭐ 选项上就标明"未确认"（服务端没读成 / 撞扫描上限）');
  assert.equal(/UNKNOWN[\s\S]{0,200}还没入库/.test(options), false, '未确认**不许**说成"还没入库"（不猜 ✗）');

  // 选中它 ⇒ 状态行也是"未确认"，且**不冒充**另外两句
  host.elements[OPTIONS].handlers.click({
    target: { closest: () => ({ dataset: { number: 'UNKNOWN|黑|A' } }) },
  });
  const status = host.elements[STATUS].textContent;
  assert.match(status, /未确认/, `未确认要如实说：${status}`);
  assert.equal(/还没入库/.test(status), false, '未确认 ≠ 没入库 ✗');
  assert.equal(/有库存/.test(status), false, '未确认 ≠ 有库存 ✗');

  // 三句话都在**配置**里（配置先行：改文案不用改代码）
  const { NUMBER_PICKER } = await loadFrontendModules().then((m) => m.pickerConfig);
  assert.ok(String(NUMBER_PICKER.texts.optionUnknown || '').includes('未确认'));
  assert.ok(String(NUMBER_PICKER.texts.pickedUnknown || '').includes('未确认'));
  // ⭐⭐ 2026-10-16 **成对迁移**（业务负责人**亲口**点的三处改动之二 · 逐字：「**那段文字说明删掉**」）：
  //   改前逐字：`assert.ok(String(NUMBER_PICKER.texts.idle || '').includes('输入编号'), '空关键字的提示语也在配置里');`
  //   改后逐字：下面这一句 —— 配置里那一句**必须正好是空串**（那种"使用说明"配置里也不许再有）✓
  //   依据：她 2026-10-16 的截图 + 逐字。🔴 **不是放宽** ✗：从"必须含"翻成"**必须为空**" ✓。
  assert.equal(NUMBER_PICKER.texts.idle, '', '⭐ 零请求那一档 = **空串**（那句使用说明配置里也不许再有）✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-U3 拉不到 / 超时 ⇒ 人话 + 仍可手输（不许留死界面）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U3 端点失败 ⇒ 人话 + 输入框照旧能手输（既有落点也一点没变）', async () => {
  const { picker, pages } = await loadFrontendModules();
  const page = await labelsPageConfig();
  const api = fakeApi({ error: new Error('读不到') });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  // ⚠️ 2026-10-15 晚**改后逐字**（懒加载；判据一个字没放宽）：
  //   改前逐字：mount 就拉了 ⇒ 下面直接断言失败后的那几句；结尾"再聚焦 ⇒ 补拉一次"是 `calls.length === 2`。
  //   改后逐字：mount 之后先聚焦（= 她点开）**才**发生第一次拉取 —— 失败后的那几句**原样不动**，
  //             结尾那句仍是 `calls.length === 2`（第一次 = 聚焦那一下，第二次 = 失败后再聚焦补拉）。
  //   依据：Lead 2026-10-15 晚的懒加载口径（见 AC-U7）。
  //   ⚠️ task-15 再补一句：**空关键字不发请求** ⇒ 先输入关键字（否则第一拉根本不发生）。
  await typeAndFocus(host, 'XHB');

  const status = host.elements[STATUS].textContent;
  assert.ok(status.length > 0, '失败必须说人话（不许只留一个空界面）');
  assert.match(status, /手输/, `要明确"还能手输"：${status}`);
  assert.equal(host.elements[OPTIONS].innerHTML, '', '拿不到选项就不画选项');
  assert.equal(host.elements[INPUT].disabled, false, '输入框不许被禁用（手输这条路要活着）');
  assert.equal(host.elements[OPTIONS].attrs['aria-busy'], 'false');

  // 手输之后走**既有**提交 ⇒ 既有落点（与选择器无关的那条路一个字没变）
  host.elements[INPUT].value = 'XHB8095';
  assert.equal(pages.entryTarget(page.targetTemplate, host.elements[INPUT].value),
    '/workbench/label-print.html?keyword=XHB8095');

  // 失败之后**再聚焦** ⇒ 补拉一次（她不用退出重进；此时输入框里仍有上一次那个关键字）
  await host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 2, '上次失败 ⇒ 聚焦补一次');
});

test('AC-U3 端点**超时**（永挂）⇒ 也给人话，不永挂、不白屏', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({ never: true });
  const host = fakeHost();
  await picker.createNumberPicker({ api, timeoutMs: 20 }).mount(host);
  // ⚠️ 2026-10-15 晚新增这一行（懒加载）：**点开才拉** ⇒ 这一拉就是永不回的那一次，超时后走同一出口。
  //   ⚠️ task-15：空关键字不发请求 ⇒ 先输入关键字。
  await typeAndFocus(host, 'XHB');
  assert.match(host.elements[STATUS].textContent, /手输/, '超时也是同一个出口：人话 + 还能手输');
  assert.equal(host.elements[OPTIONS].attrs['aria-busy'], 'false', '忙态要收掉（否则她以为还在转）');
});

test('AC-U3 端点回了空 / 形状不对 ⇒ 说"没匹配到 + 还能手输"，不抛错、不白屏', async () => {
  const { picker } = await loadFrontendModules();
  const host = fakeHost();
  await picker.createNumberPicker({
    api: fakeApi({ result: { success: true, total: 0, truncated: false, numbers: [] } }),
  }).mount(host);
  // ⚠️ 2026-10-15 晚新增（懒加载）：两处都先"点开"再断言（判据原样不动）。
  //   ⚠️ task-15：空关键字不发请求 ⇒ 先输入关键字（否则下面两句测的是"提示语"而不是"没匹配到"）。
  await typeAndFocus(host, 'XHB');
  assert.match(host.elements[STATUS].textContent, /手输/);
  assert.equal(host.elements[OPTIONS].innerHTML, '');

  const weird = fakeHost();
  await picker.createNumberPicker({ api: fakeApi({ result: {} }) }).mount(weird);
  await typeAndFocus(weird, 'XHB');
  assert.ok(weird.elements[STATUS].textContent.length > 0, '形状不对也要有一句人话（不许静默）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-U7 ⭐⭐ 懒加载：**进页面一个请求都不发**；她"点开"（聚焦）才拉那一次
//   （Lead 2026-10-15 晚定的口径 —— 这个端点要读整张「货品信息」+ 整张「实时库存」，
//    正是今天量到 **23.6 秒** 那次读的来源 ⇒ 进页就拉 = 她点开选择器先干等十几秒，
//    正好撞在她今天抱怨的"不友好 / 点了没反应"上 ✗）
//   ⚠️ 拉的那一刻必须**立刻**有「正在读取…」（不然她还是会以为没反应）；拉回来才填选项。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U7 进页零请求 + 点开才拉 + 拉的那一刻立刻显示「正在读取…」+ 拉回来才填选项', async () => {
  const { picker } = await loadFrontendModules();
  // 一个"卡住不回"的假 api：用来**停在拉取那一刻**看页面说了什么（真机上那一下可能十几秒）。
  let release;
  const api = {
    calls: [],
    get(url) {
      this.calls.push(url);
      return new Promise((resolve) => { release = resolve; });
    },
  };
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);

  assert.equal(api.calls.length, 0, '🔴 进页面**一个请求都不发**（不许把整表读压在她没点开的时候）');
  assert.equal(host.elements[OPTIONS].innerHTML, '', '进页面没有选项（也没在转）');
  // ⭐⭐ 2026-10-16 **成对迁移**（业务负责人**亲口**点的三处改动之二 · 逐字：「**那段文字说明删掉**」）：
  //   改前逐字：`assert.ok(String(host.elements[STATUS].textContent).length > 0, '进页面先给一句人话（不白屏）');`
  //   改后逐字：下面这一句 —— 进页面时状态区**是空的**（不是"不白屏"，而是"状态区只装真实状态"）✓
  //   依据：她 2026-10-16 的截图 + 逐字。🔴 **不是放宽** ✗：从"必须有字"翻成"**必须没字**" ✓。
  assert.equal(String(host.elements[STATUS].textContent), '', '⭐ 进页面状态区**一个字都不写**（那句使用说明已删）✓');

  // ⭐⭐ task-15：**空关键字点开 ⇒ 仍然零请求**（端点那边也是零飞书读）——
  //    ⭐ 2026-10-16 起**状态区也不再写那句提示语**（她逐字：「用户输入一个编号，
  //    然后系统再给出与这个模糊编号相关的选项」＋「**那段文字说明删掉**」）。
  //    改前逐字：`const pending = host.elements[INPUT].handlers.focus();`（空关键字就发请求）
  //    改后逐字：先断言"空关键字 ⇒ 仍是 0 个请求 + 状态区为空"，**再**输入关键字才拿到那一次请求。
  await host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 0, '⭐ 空关键字 ⇒ 一次请求都不发（服务端那边也是零读）');
  assert.equal(String(host.elements[STATUS].textContent), '', '零请求 ⇒ 状态区**一个字都不写**（她那句使用说明已删）');

  // 她**输入关键字**（手机上 tap = 聚焦；这里输入后点开）⇒ 这一下才发请求
  host.elements[INPUT].value = 'XHB';
  const pending = host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 1, '输入关键字 + 点开 ⇒ 才拉这一次');
  assert.ok(api.calls[0].includes('keyword=XHB'), '关键字原样传给服务端');
  assert.equal(api.calls[0].startsWith('/api/workbench/products/numbers?'), true, '还是那个只读端点');
  assert.match(String(host.elements[STATUS].textContent), /正在读取/,
    '🔴 拉的那一刻**立刻**显示「正在读取…」（她不会以为点了没反应）');
  assert.equal(host.elements[OPTIONS].attrs['aria-busy'], 'true', '忙态也要标出来（读屏可用）');
  assert.equal(host.elements[OPTIONS].innerHTML, '', '还没回来 ⇒ 不画选项');

  release({ success: true, total: 1, truncated: false, numbers: [numberItem()] });
  await pending;
  assert.ok(host.elements[OPTIONS].innerHTML.includes('XHB8095|棕色|A'), '拉回来**才**填选项');
  assert.equal(host.elements[OPTIONS].attrs['aria-busy'], 'false', '忙态收掉');

  // 已经拉过 ⇒ 她再点开 / 再点一下也不刷请求（免得一串重复请求）
  await host.elements[INPUT].handlers.focus();
  host.elements[INPUT].handlers.click();
  assert.equal(api.calls.length, 1, '拉过就不再拉（聚焦 / 点开都算同一条路）');
});

test('AC-U7 「点开」走的是同一条路：没拉过时 `click` 也会拉（tap 上 focus/click 都来时只发一个请求）', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);

  // ⚠️ task-15：空关键字不发请求 ⇒ 先有关键字（下面"只发一个"的判据原文没动）。
  host.elements[INPUT].value = 'XHB';
  const pending = host.elements[INPUT].handlers.click();
  // tap 真机上 focus 与 click 都会来 ⇒ 第二次进来时必须在飞（`state.loading`）⇒ **不重复发**
  host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 1, '在飞的那一下不许再发第二个请求');
  await pending;
  assert.ok(host.elements[OPTIONS].innerHTML.includes('XHB8095|棕色|A'));
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-U8 ⭐⭐ 输入防抖（`inputDebounceMs`，默认 400ms，可配；0 = 不防抖）
//   Lead 2026-10-15 晚批准：在 ≈11.4s/次（561 行 + 1362 行两张整表读）面前，
//   "每敲一个字发一个请求"意味着敲 4 个字 ≈ 4 次整表读 ✗ ⇒ 她**停下来**才发那一次。
//   ⚠️ **回车立即搜**（不等窗口）；**聚焦 / 点开那一次也不走防抖**（立刻发）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U8 防抖：连敲 4 个字只发 1 个请求（停下才发最后那一次）；0 = 不防抖；点开那一次不走防抖', async () => {
  const { picker, pickerConfig } = await loadFrontendModules();
  assert.equal(pickerConfig.NUMBER_PICKER.inputDebounceMs, 400, '默认 400ms 在配置里（配置先行，不写死）');

  const api = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  // ⚠️ task-15：空关键字不发请求 ⇒ 先有关键字；「点开」那一次**不**走防抖 ⇒ 立刻发。
  const input = host.elements[INPUT];
  input.value = 'XHB';
  await input.handlers.focus();
  assert.equal(api.calls.length, 1, '点开（聚焦）那一次不走防抖：立刻发');
  assert.ok(api.calls[0].includes('keyword=XHB'), '关键字已经带上（不是空关键字那次全量读）');
  // 她连敲 4 下（不等前一次回来）—— 防抖窗口里**一个请求都不发**
  const typing = ['X', 'XH', 'XHB', 'XHB8'].map((value) => {
    input.value = value;
    return input.handlers.input();
  });
  assert.equal(api.calls.length, 1, '正在打字 ⇒ 一个请求都不发（还在防抖窗口里）');
  await Promise.all(typing);
  assert.equal(api.calls.length, 2, '🔴 停下之后只发 1 个请求（4 次敲字合计 1 个，不是 4 个）');
  assert.ok(api.calls[1].includes('keyword=XHB8'), `发的是**最后**那个关键字：${api.calls[1]}`);

  // 配置可关：`inputDebounceMs: 0` ⇒ 输入立刻发
  const fastApi = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const fastHost = fakeHost();
  await picker.createNumberPicker({ api: fastApi, inputDebounceMs: 0 }).mount(fastHost);
  // ⚠️ task-15：空关键字那一下**不发**了 ⇒ 这里只剩"输入立刻发"这一次（原来空聚焦算一次）。
  fastHost.elements[INPUT].value = 'XHB';
  await fastHost.elements[INPUT].handlers.input();
  assert.equal(fastApi.calls.length, 1, 'inputDebounceMs = 0 ⇒ 输入立刻发（防抖可关）');
});

test('AC-U8 回车立即搜（不等防抖窗口）· Esc 取消挂起的那次 · 「回车提交表单」那条路没动', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);
  // ⚠️ task-15：空关键字不发请求 ⇒ 先有关键字（下面的回车 / Esc 判据原文没动）。
  const input = host.elements[INPUT];
  input.value = 'XHB';
  await input.handlers.focus();
  assert.equal(api.calls.length, 1);
  assert.ok(api.calls[0].includes('keyword=XHB'));

  input.value = 'XHB8';
  const pending = input.handlers.input(); // 防抖挂起（400ms 窗口）
  assert.equal(api.calls.length, 1, '防抖窗口里还没发');
  input.handlers.keydown({ key: 'Enter' }); // 回车 ⇒ 立刻，不等 400ms
  assert.equal(api.calls.length, 2, '🔴 回车**立刻**发（不等防抖窗口）');
  assert.ok(api.calls[1].includes('keyword=XHB8'), `发的是框里那一刻的值：${api.calls[1]}`);
  await pending; // 被回车接管的那一次**当场了结**（不悬着）
  assert.equal(api.calls.length, 2, '回车之后防抖那次不再重复发');

  // Esc：只收起列表，不发请求、也不悬着
  input.value = 'XH';
  const escPending = input.handlers.input();
  input.handlers.keydown({ key: 'Escape' });
  await escPending;
  assert.equal(api.calls.length, 2, 'Esc 不发请求（只收起列表）');

  // ⚠️ 回车那条"提交表单 ⇒ 打开既有落点"的路一个字没改：选择器**不 preventDefault、也不碰落点**
  //    （判据先**剥掉注释**再判 —— 注释里说明"不 preventDefault"不算实现，与其它用例同一口径）
  const pickerSource = read('features/labels/number-picker.js');
  const pickerCode = pickerSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/preventDefault/.test(pickerCode), false, '选择器不许拦回车的默认提交');
  assert.equal(pickerSource.includes('label-print'), false, '落点仍只有 config/domains.js 一处');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-U9 ⭐⭐ 超时阈值**来自配置**（冷启动 ≈11.4s ⇒ 15s）＋ 超时那条人话路径仍有效
//   依据：线上只读实测「货品信息」561 行 5.5s ＋「实时库存」1362 行 5.9s ≈ **11.4s**；
//   原 8000 < 11.4s ⇒ 她**第一次（冷）点开**会看到"读不到编号 + 手输"，而不是真名单 ✗。
//   （服务端已有 60s TTL 缓存 ⇒ 第二次起秒开；这个阈值管的是冷启动那一次。）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U9 超时阈值走配置（冷启动 ≈11.4s ⇒ ≥15s，不写死）+ 超时那条人话路径仍有效', async () => {
  const { picker, pickerConfig } = await loadFrontendModules();
  const { NUMBER_PICKER } = pickerConfig;
  assert.ok(Number(NUMBER_PICKER.timeoutMs) >= 15000,
    `冷启动实测 ≈11.4s（561 行 5.5s + 1362 行 5.9s）⇒ 阈值必须 > 它：${NUMBER_PICKER.timeoutMs}`);

  // **可配**：只换 config（不传 `options.timeoutMs`）⇒ 立刻按新阈值超时，并走同一条人话出口
  const api = fakeApi({ never: true });
  const host = fakeHost();
  const started = Date.now();
  await picker.createNumberPicker({ api, config: { ...NUMBER_PICKER, timeoutMs: 25 } }).mount(host);
  await typeAndFocus(host, 'XHB');   // task-15：空关键字不发请求 ⇒ 先输入关键字
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000,
    `超时阈值必须来自 config（这里配的 25ms）—— 写死成 15 秒的话这一条要等 15 秒才红：${elapsed}ms`);
  assert.match(String(host.elements[STATUS].textContent), /手输/, '超时仍然走"人话 + 还能手输"那一条');
  assert.equal(host.elements[OPTIONS].attrs['aria-busy'], 'false', '忙态收掉（她不会以为还在转）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-U6 🔴 扫码那一条（`?scan=1`）一个字节没改 —— 源码哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U6 🔴 扫码那一条（`?scan=1`）没被这次改动碰过：源码哨兵', () => {
  const page = read('features/labels/index.js');
  // ① 命中 `?scan=1` ⇒ **只挂聚焦页并立刻 return**（那条 23.6 秒的批量查询不会跑）—— 逐字不变
  assert.match(page, /if \(wantsScanFromSearch\([\s\S]{0,80}?\)\) \{\s*mountScanOnlyPage\(container, scanPrint\);\s*return;/,
    '扫码聚焦页那条早退**逐字没动**');
  assert.match(page, /import \{[^}]*mountScanOnlyPage[^}]*\} from '\.\/scan-print\.js';/,
    '聚焦页挂载器仍从 `./scan-print.js` 引（不新开一套）');
  assert.match(page, /scanPrintBarHtml\(\)/, '批量页上那一块照旧画出来');
  assert.match(page, /scanPrint\.mount\(panel\(\)\)/, '扫码块照旧挂载');
  // ② 选择器模块**不许**碰扫码那一条（新代码与它零交集）
  const picker = read('features/labels/number-picker.js');
  assert.equal(/scan/i.test(picker), false, '选择器里不许出现 scan（不许绕到扫码那条路上）');
  // ③ 扫码专属文件这次**一行都没改**（改了它会连带动了行为哨兵，见 scanToPrint.test.js）
  const scanPrint = read('features/labels/scan-print.js');
  assert.ok(scanPrint.includes("'/api/workbench/label-print/jobs'"), '扫码打印走的仍是既有队列接口');
  assert.ok(scanPrint.includes('wantsScanFromSearch'));
});
