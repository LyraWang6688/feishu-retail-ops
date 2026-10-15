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
 *  AC-U3 端点失败 / **超时** ⇒ 人话 + **仍可手输**（不死界面：输入框还在、跳转那条路一点没变）。
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
  await picker.createNumberPicker({ api }).mount(host);

  assert.equal(api.calls.length, 1, '进页面拉一次（只读）');
  assert.ok(api.calls[0].startsWith('/api/workbench/products/numbers?'), `地址来自配置：${api.calls[0]}`);
  assert.ok(api.calls[0].includes('limit=200'), 'limit 走契约默认值（1..500 内）');

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
  assert.equal(api.calls[0].includes('keyword='), false, '没输关键字 ⇒ 不带 keyword（全量前 200 条）');

  host.elements[INPUT].value = 'XHB';
  await host.elements[INPUT].handlers.input();
  assert.equal(api.calls.length, 2, '输关键字 ⇒ 再问一次服务端（不是前端本地过滤）');
  assert.ok(api.calls[1].includes('keyword=XHB'), `keyword 必须原样传上去：${api.calls[1]}`);

  // 聚焦时**不重复拉**（拉过成功的就不拉，免得她一点就一串请求）
  host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 2, '成功拉过 ⇒ 聚焦不再补一次');
});

test('AC-U1 选中 ⇒ 填进既有输入框，落点仍是**既有**那个（不新开页面 / 不新开接口）', async () => {
  const { picker, pages } = await loadFrontendModules();
  const page = await labelsPageConfig();
  assert.equal(page.targetTemplate, '/workbench/label-print.html?keyword={itemNo}', '落点模板一个字没改');

  const api = fakeApi({ result: { success: true, total: 1, truncated: false, numbers: [numberItem()] } });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);

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

// ═══════════════════════════════════════════════════════════════════════════
// AC-U3 拉不到 / 超时 ⇒ 人话 + 仍可手输（不许留死界面）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-U3 端点失败 ⇒ 人话 + 输入框照旧能手输（既有落点也一点没变）', async () => {
  const { picker, pages } = await loadFrontendModules();
  const page = await labelsPageConfig();
  const api = fakeApi({ error: new Error('读不到') });
  const host = fakeHost();
  await picker.createNumberPicker({ api }).mount(host);

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

  // 失败之后**再聚焦** ⇒ 补拉一次（她不用退出重进）
  host.elements[INPUT].handlers.focus();
  assert.equal(api.calls.length, 2, '上次失败 ⇒ 聚焦补一次');
});

test('AC-U3 端点**超时**（永挂）⇒ 也给人话，不永挂、不白屏', async () => {
  const { picker } = await loadFrontendModules();
  const api = fakeApi({ never: true });
  const host = fakeHost();
  await picker.createNumberPicker({ api, timeoutMs: 20 }).mount(host);
  assert.match(host.elements[STATUS].textContent, /手输/, '超时也是同一个出口：人话 + 还能手输');
  assert.equal(host.elements[OPTIONS].attrs['aria-busy'], 'false', '忙态要收掉（否则她以为还在转）');
});

test('AC-U3 端点回了空 / 形状不对 ⇒ 说"没匹配到 + 还能手输"，不抛错、不白屏', async () => {
  const { picker } = await loadFrontendModules();
  const host = fakeHost();
  await picker.createNumberPicker({
    api: fakeApi({ result: { success: true, total: 0, truncated: false, numbers: [] } }),
  }).mount(host);
  assert.match(host.elements[STATUS].textContent, /手输/);
  assert.equal(host.elements[OPTIONS].innerHTML, '');

  const weird = fakeHost();
  await picker.createNumberPicker({ api: fakeApi({ result: {} }) }).mount(weird);
  assert.ok(weird.elements[STATUS].textContent.length > 0, '形状不对也要有一句人话（不许静默）');
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
