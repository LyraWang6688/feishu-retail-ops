const { rendererSource } = require('./support/rendererSource');
/**
 * ⭐⭐ 「页面标注模式」—— 业务负责人 2026-10-16 亲口点的功能（逐字）：
 *   「我在**页面上**加一个小开关：你打开后，**点页面上的哪一块，那一块就高亮**，
 *     并弹出它的**名字**（比如"退货折叠条"/"整单金额输入框"）⇒ 你截给我，我就**不用猜**了」
 *   她选的范围（逐字）：**扫码页 + 工作台都做** ✓
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 先说**闸门**（这一条是整件事的地基）：**只有 URL 带上 `?annotate=1` 才出现** ✓，
 *   不带参数 ⇒ 真实用户**看不到**：脚本**开头就判、判完立刻早退**（零 DOM / 零监听 / 零改动）✓。
 *
 * ⚠️ **为什么闸门落在脚本内部**（而不是服务端按查询串决定注不注入）：
 *   查询串只有 `routes/scanPage.js` 拿得到，而那个文件**不在本任务写作用域内**（另有主）⇒
 *   扫码页只能无条件带上这一段脚本、由它自己判。⇒ 下面 `AC-M1` 钉的就是"**不带参数时
 *   运行时逐字无痕**"（渲染输出里那一段脚本标签照旧在，但它**早退**，什么都不做）✓
 *
 * ⚠️ **零 JS 哨兵的成对迁移**（不是放宽 ✗）：`AC-W2` / `AC-6R5` 两条哨兵原来钉
 *   「扫码页一行 `<script>` 都不许有」。那是**我方（agent 侧）**的约束，**不是她的口径** ——
 *   她 2026-10-12 两次纠正：「我可没有说过，**我们是能够进行动态交互的**」。
 *   ⇒ 两条哨兵按「改前逐字 → 改后逐字 → 依据」成对迁移为
 *     「**不带 `?annotate=1` 时仍然零业务脚本；那一段标注脚本必须开头早退**」✓
 *     （迁移的逐字记录写在那两个测试里；本文件是**新**判据，不替代它们 ✓）
 *
 * ───────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-M1 **不带 `?annotate=1` ⇒ 逐字不变**：渲染出来的 HTML 里**没有**那一层浮层/描边结构，
 *         脚本**早退**（不建 DOM、不绑监听）；源码里那道"读 query 的闸门"必须在 ✓
 *  AC-M1b ⭐ **真红探针**：把闸门那一句删掉 ⇒ `enabled()` 变 true ⇒ AC-M1 红 ✓
 *  AC-M2 **带 `?annotate=1` ⇒ 页面里有**标注脚本（`data-view="annotate"`）**＋一个有名字的浮层结构** ✓
 *  AC-M3 **取名字逻辑**：`data-view` 优先、`class` 兜底（源码哨兵；删掉任一分支 ⇒ 红）✓
 *  AC-M4 **浮层**：`position: fixed`（不挡正常页面结构）+ **复制按钮** + **关闭按钮** ✓
 *  AC-M5 **不打扰**：脚本里不碰提交 / 不改表单行为（它是**新增**一段，不动既有那一段）✓
 *  AC-M6 **工作台侧**：`index.html` 引**同一个文件**（不是第二份实现）✓
 *  AC-M7 ⭐ **探针**：删「复制按钮」/「浮层关闭」任一 ⇒ 对应判据红 ✓（能真红的自证）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SERVER = path.join(__dirname, '..');
const RENDERER_PATH = path.join(SERVER, 'src', 'views', 'scanPageRenderer.js');
const SHARED_PATH = path.join(SERVER, 'public', 'workbench', 'shared', 'annotate.js');
const WORKBENCH_INDEX = path.join(SERVER, 'public', 'workbench', 'index.html');

const RENDERER = rendererSource();
const SHARED = fs.readFileSync(SHARED_PATH, 'utf8');
const INDEX_HTML = fs.readFileSync(WORKBENCH_INDEX, 'utf8');

const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { renderScanPage } = require('../src/views/scanPageRenderer');

const VIEW = {
  found: true, number: 'XHB8095|棕色|A', item_no: 'XHB8095', color: '棕色', category_name: '休闲鞋',
  category_code: 'A', price_text: '￥299', updated_at_text: '2026-10-16 09:00', number_fallback: false,
  rows: [{ size_text: '41', cells: [{ key: '门盒', count: 0 }], total: 0, missing: true }],
  missing_count: 1, sizes_degraded: false, notes: [], product_record_id: 'prod_1',
};
const WRITE = {
  enabled: true, saleEnabled: true, replenishEnabled: true, returnEnabled: true,
  texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: '/s/K1?from=sales', saleKey: 'k', replenishKey: 'k2', returnKey: 'k3',
  sizes: [{ size_text: '41', missing: false }], draft: { lines: [] }, accessories: [],
  notice: '', errorText: '', paymentStatus: '', defaultPaymentStatus: '',
  paymentMethods: ['微信'], defaultPaymentMethod: '微信', acceptDefaultQuantity: 1,
};

/** 渲染一页（扫码页）—— 判据都对着**真渲染结果**跑，不对着注释跑 ✓ */
const pageOf = (realm = 'sales') => renderScanPage(VIEW, SCAN_PAGE, WRITE, realm, {});

/** 从 HTML 里切出标注那一段脚本的**源码**（后续源码哨兵都对着它读）。 */
const annotateScriptOf = (html) => {
  const open = html.indexOf('<script data-view="annotate">');
  assert.ok(open >= 0, '页面里必须有 `<script data-view="annotate">`（AC-M2 的前提）');
  const start = html.indexOf('>', open) + 1;
  const end = html.indexOf('</scr' + 'ipt>', start);
  assert.ok(end > start, '那一段脚本必须闭合');
  return html.slice(start, end);
};

/**
 * 在**最小 DOM 沙箱**里真跑一遍那一段脚本（不是只看字符串 ✗）。
 * 记录它建了几个元素、绑了几个监听、往 body 挂了几次 ⇒ "早退"这件事**行为上**可证 ✓
 */
const runAnnotateInSandbox = (search) => {
  const created = [];
  const listeners = [];
  const appended = [];
  const makeElement = () => {
    const element = {
      style: {}, attributes: {}, children: [],
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
      appendChild(child) { this.children.push(child); return child; },
      addEventListener(type) { listeners.push(type); },
      contains() { return false; },
      select() {},
    };
    created.push(element);
    return element;
  };
  const sandbox = {
    location: { search },
    document: {
      readyState: 'complete',
      addEventListener(type) { listeners.push(type); },
      createElement: () => makeElement(),
      execCommand: () => true,
      body: { appendChild: (node) => { appended.push(node); return node; } },
    },
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type) => { listeners.push(type); };
  vm.runInNewContext(SHARED, sandbox, { filename: 'shared/annotate.js' });
  return { sandbox, api: sandbox.dshAnnotate, created, listeners, appended };
};

// ═══════════════════════════════════════════════════════════════════════════
// AC-M1 不带 `?annotate=1` ⇒ 逐字不变（真实用户看不到）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M1 ⭐ 不带 `?annotate=1` ⇒ 页面上没有浮层/描边结构，脚本**立刻早退**（零 DOM / 零监听）', () => {
  const html = pageOf();
  // ① 渲染输出里**没有**那一层结构（浮层 / 描边都是脚本**运行时**才建的 ⇒ 不带参数时永远不存在 ✓）
  for (const needle of ['data-view="annotate-panel"', 'data-view="annotate-highlight"',
    'data-view="annotate-name"', 'data-view="annotate-copy"', 'data-view="annotate-close"']) {
    assert.equal(html.includes(needle), false, `不带 ?annotate=1 时不该有「${needle}」（那是标注层 ✗）`);
  }
  // ② 脚本源码里那道闸门**必须在**（它就是这个"看不到"的实现）
  const source = annotateScriptOf(html);
  assert.ok(source.includes('location.search'), '闸门要读 URL 的 query（未带参数时早退 ✓）');
  assert.ok(/annotate/.test(source), '闸门判的就是 annotate 这个参数 ✓');
  assert.ok(source.includes('if (!enabled()) return'), '没带参数 ⇒ **当场 return**（这一句就是"无痕" ✓）');
  // ③ ⭐ **行为**上真跑一遍：不带参数 ⇒ 一个元素都不建、一个监听都不绑、body 一次都不挂 ✓
  const plain = runAnnotateInSandbox('?from=sales');
  assert.equal(plain.api.enabled(), false, '不带参数 ⇒ 标注模式是关的 ✓');
  assert.equal(plain.created.length, 0, `不带参数时**一个 DOM 都不许建**（实际建了 ${plain.created.length} 个 ✗）`);
  assert.equal(plain.appended.length, 0, '不带参数时**不许往 body 挂任何东西** ✗');
  assert.equal(plain.listeners.length, 0, `不带参数时**一个监听都不许绑**（实际 ${plain.listeners.length} 个 ✗）`);
});

test('AC-M1b ⭐ **探针**：把闸门那一句删掉 ⇒ 不带参数也进标注模式（AC-M1 必须红）', () => {
  const mutant = SHARED.replace('if (!enabled()) return;', '/* 闸门被删（探针） */');
  assert.notEqual(mutant, SHARED, '（前提）探针确实改到了那一段');
  const created = [];
  const sandbox = {
    location: { search: '?from=sales' },
    document: {
      readyState: 'complete',
      addEventListener() {},
      createElement: () => { const el = { style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, contains: () => false }; created.push(el); return el; },
      body: { appendChild() {} },
    },
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  vm.runInNewContext(mutant, sandbox, { filename: 'annotate.mutant.js' });
  assert.ok(created.length > 0, '闸门一删 ⇒ 不带参数也会去建 DOM ⇒ AC-M1 的"逐字不变"立刻红 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-M2 带 `?annotate=1` ⇒ 有标注脚本 + 一个有名字的浮层结构
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M2 ⭐ 带 `?annotate=1` ⇒ 页面里有标注脚本 + 浮层结构（删掉任一处 ⇒ 红）', () => {
  for (const realm of ['sales', 'inventory', 'replenish']) {
    const html = pageOf(realm);
    assert.ok(html.includes('<script data-view="annotate">'),
      `realm=${realm}：必须注入标注脚本（不带参数时它自己早退 ✓）`);
    // 那一层是脚本建出来的 ⇒ 源码里必须有它的**结构定义**（名字 / 复制 / 关闭 / 描边）
    const source = annotateScriptOf(html);
    assert.ok(source.includes("'data-view', 'annotate-panel'"), '浮层要在（它承载"这一块叫什么" ✓）');
    assert.ok(source.includes("'data-view', 'annotate-name'"), '浮层里要有一行**名字**（她要看的就是它 ✓）');
    assert.ok(source.includes("'data-view', 'annotate-highlight'"), '要有高亮描边那一个块 ✓');
    assert.ok(source.includes('window.dshAnnotate'), '那一段要把 API 挂出来（便于自证与排障 ✓）');
  }
  // 行为：带上参数 ⇒ 真的建了 DOM、真的挂了监听
  const on = runAnnotateInSandbox('?annotate=1');
  assert.equal(on.api.enabled(), true, '带上参数 ⇒ 标注模式必须开 ✓');
  assert.ok(on.appended.length >= 2, `要往 body 挂上描边 + 浮层（实际 ${on.appended.length} 个 ✗）`);
  assert.ok(on.listeners.length >= 3, `至少要有悬停 / 点击 / 滚动这几条（实际 ${on.listeners.length} ✗）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-M3 「点哪块取哪块名字」：data-view 优先、class 兜底（源码哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M3 ⭐ 取名字：`data-view` 优先 ⇒ `class` 兜底（删掉任一分支 ⇒ 红）', () => {
  const source = SHARED;
  // ① 优先用 data-view（**这一块自己的**）
  assert.ok(source.includes("element.getAttribute('data-view')"),
    '必须优先读这一块自己的 `data-view`（她举例的「退货折叠条」就是它 ✓）');
  // ② 往上找最近的 data-view（点的是块里的一格 ⇒ 报它属于哪一块）
  assert.ok(/ancestorView/.test(source) && /parentElement/.test(source),
    '往上一层找 `data-view` 的分支要在（点里面的格子也要说得出"哪一块" ✓）');
  // ③ class 兜底（`div.disclosure` 那种形状）
  assert.ok(source.includes("getAttribute('class')"), '`class` 兜底分支要在（例如 div.disclosure ✓）');
  assert.ok(source.includes('tagClassOf'), '`tag + class` 的拼装要在 ✓');
  // ④ 绝不返回空串（浮层永远有东西给她看）
  assert.ok(/return tagClass/.test(source), '最后要退回标签名（不许返回空串 ⇒ 浮层不许空着 ✗）');
  // ⑤ 行为：沙箱里真取一次名字
  const on = runAnnotateInSandbox('?annotate=1');
  const withView = { tagName: 'DIV', getAttribute: (name) => (name === 'data-view' ? 'purchase-return' : null) };
  assert.equal(on.api.nameOf(withView), 'data-view="purchase-return"',
    '有 data-view ⇒ 报 data-view（优先 ✓）');
  const withClass = { tagName: 'DIV', getAttribute: (name) => (name === 'class' ? 'disclosure' : null), parentElement: null, attributes: [] };
  assert.equal(on.api.nameOf(withClass), 'div.disclosure', '没有 data-view ⇒ 报 div.disclosure（兜底 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-M4 浮层：position: fixed + 复制按钮 + 关闭按钮
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M4 ⭐ 浮层是 `position: fixed`（不挡页面结构）+ **复制按钮** + **关闭按钮**', () => {
  const source = SHARED;
  assert.ok(source.includes("'position: fixed'"), '浮层/描边都要 `position: fixed`（不挤动、不挡正常结构 ✓）');
  assert.ok(source.includes('navigator.clipboard.writeText'), '复制按钮要真往剪贴板写（她"截给我"之前先复制名字 ✓）');
  assert.ok(source.includes('execCommand'), '取不到 clipboard API 时的兜底复制也要在 ✓');
  // ⚠️ 判据钉的是**真的建了那两个按钮**（`setAttribute('data-view', 'annotate-copy')`）——
  //    只 `includes('annotate-copy')` 是不够的：`OWN_MARKERS` 白名单里也有这串字面量
  //    （变异 A 实测：删掉整块复制按钮，那条**假绿**了 ⇒ 已收紧 ✓）
  assert.ok(source.includes("setAttribute('data-view', 'annotate-copy')"), '复制按钮要**真的建出来** ✓');
  assert.ok(source.includes("setAttribute('data-view', 'annotate-close')"), '关闭按钮要**真的建出来** ✓');
  assert.ok(source.includes('panel.close.addEventListener'), '关闭按钮要真绑上行为（不是画一个死按钮 ✗）');
  assert.ok(source.includes('panel.copy.addEventListener'), '复制按钮也要真绑上行为（不是画一个死按钮 ✗）');
  const on = runAnnotateInSandbox('?annotate=1');
  assert.ok(on.created.length >= 5, `浮层至少要有 面板 / 名字 / 复制 / 关闭（实际建了 ${on.created.length} 个 ✗）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-M5 不打扰：不动既有表单那一段、不改提交
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M5 ⭐ 不打扰：标注是**新增**一段，既有反馈脚本与表单提交一个字不动', () => {
  const html = pageOf('sales');
  // 既有那一段照旧在，且**在标注这一段之前**（顺序：既有行为先、标注后加 ✓）
  const feedbackAt = html.indexOf('<script data-view="submit-feedback">');
  const annotateAt = html.indexOf('<script data-view="annotate">');
  assert.ok(feedbackAt >= 0 && annotateAt > feedbackAt,
    '既有的提交反馈脚本必须还在、且在标注脚本之前 ✓（两段各司其职 ✓）');
  // 标注脚本里不碰表单提交
  assert.equal(/addEventListener\('submit'/.test(SHARED), false, '标注脚本不许改提交行为 ✗');
  assert.equal(SHARED.includes('form.submit()'), false, '不许替她提交 ✗');
  assert.equal(SHARED.includes('location.href'), false, '不许替她跳转 ✗');
  // 而且它**不改**既有那一段的源码（两段互不污染）
  assert.equal(annotateScriptOf(html).includes('dshUiTap'), false, '标注脚本里不许混进埋点那一份 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-M6 工作台侧：引**同一个文件**（不是第二份实现）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M6 ⭐ 工作台：`index.html` 引**同一份** annotate.js（且不早于解析到 body ✓）', () => {
  assert.ok(INDEX_HTML.includes('<script src="/workbench/shared/annotate.js" defer>'),
    '工作台要引那一份共享实现（唯一真源 ✓）');
  const annotateAt = INDEX_HTML.indexOf('/workbench/shared/annotate.js');
  const moduleAt = INDEX_HTML.indexOf('<script type="module"');
  assert.ok(annotateAt < moduleAt, '标注脚本要在模块脚本之前声明（顺序读了就懂 ✓）');
  // 同一份实现：扫码页内联的**逐字等于**那个文件（防"两边各抄一份"漂移 ✗）
  assert.equal(annotateScriptOf(pageOf()).trim(), SHARED.trim(),
    '扫码页内联的必须是**同一个文件**逐字一致（不许各抄一份 ✗）');
  // 工作台那一段也带同一个闸门（它同样只在 ?annotate=1 时做事 ✓）
  assert.ok(SHARED.includes('if (!enabled()) return'), '共享实现的闸门对两端同时生效 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-M7 ⭐ 探针：删「复制按钮」/「浮层关闭」⇒ 对应判据红（能真红的自证）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-M7 ⭐ **探针**：删掉复制按钮 / 浮层关闭 ⇒ 对应判据**当场变红**', () => {
  // ⭐ 2026-10-16：第一版这里只 `includes('annotate-copy')` —— 变异实测**假绿**了
  //   （`OWN_MARKERS` 白名单里也有这串字面量）⇒ AC-M4 已收紧成"真的建了那个按钮"，
  //   下面这个探针也跟着用**同一条判据**（删掉整块复制按钮 ⇒ 必须红 ✓）
  const copyStart = SHARED.indexOf('// "copy"');
  const closeStart = SHARED.indexOf('// "close"');
  assert.ok(copyStart > 0 && closeStart > copyStart, '（前提）复制按钮那一块确实在，且后面紧跟关闭那一块');
  const withoutCopy = SHARED.slice(0, copyStart) + SHARED.slice(closeStart);
  assert.equal(withoutCopy.includes("setAttribute('data-view', 'annotate-copy')"), false,
    'AC-M4 的"复制按钮要真的建出来"必须红 ✓');
  assert.equal(withoutCopy.includes("setAttribute('data-view', 'annotate-close')"), true,
    '（对照）关闭按钮不该被误删 ✓');

  const withoutClose = SHARED.replace('panel.close.addEventListener', 'panel.close.setAttribute');
  assert.notEqual(withoutClose, SHARED, '（前提）关闭行为确实被摘掉了');
  assert.equal(withoutClose.includes('panel.close.addEventListener'), false,
    'AC-M4 的"关闭按钮要真绑上行为"必须红 ✓');

  const withoutGate = SHARED.replace('if (!enabled()) return;', '');
  assert.equal(withoutGate.includes('if (!enabled()) return'), false,
    'AC-M1 的"早退"那一句必须红 ✓');
});
