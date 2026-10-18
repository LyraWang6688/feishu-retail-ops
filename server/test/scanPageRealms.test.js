require('./support/scanPageReadRedirect');   // ⭐ 拆分后：把'按旧路径读 routes/scanPage.js'重定向到聚合文本 ✓（断言不动 ✓）
const { rendererSource } = require('./support/rendererSource');
/** ⚠️ 2026-10-12 旧断言改写（"**零 JS**"口径按业务负责人的要求改了）：
 *  改前（逐字）：`assert.equal(/<script[\s>]/i.
test(html), false, '页面里一行前端脚本都没有');`
 *  改后（逐字）：**有提交按钮的页面**（销售提交 / 打印这一款）= 整页**只有那一段**
 *    `<script data-view="submit-feedback">`（只做"置灰 + 换文案 + 计时"）；其余页面仍然 **0 段**。
 *  理由：她真机（逐字）「点完之后**没有 Toast、按键置灰**之类的提示……**我就会一直狂点**」
 *    ⇒ 她**明确要置灰**；"置灰"没有零 JS 的等价物 ⇒ 多了**唯一一段**内联 JS。
 *    ⚠️ 被保护的不变量收窄成：**只有这一段、只做这件事、不做网络/DOM 副作用**。
 */
/**
 * ⚠️ 2026-10-11 晚（业务负责人批准六领域）——本文件**改写**的断言（逐字）：
 *   改前：`blockOf(htmlFor('purchase'), 'purchase')`

test('AC3 \`from=purchase\`：…')` /
 *        `for (const id of ['sales', 'inventory', 'purchase'])` /
 *        `['sales', 'inventory', 'purchase', 'product']`
 *   改后：领域换成 **`replenish`**（原「采购」领域里的补货那半），六领域清单
 *        `['sales','replenish','purchase_return','accept','inventory','product']`。
 *   理由：原「采购」领域被业务负责人拆成 **补货 / 退货 / 验收** 三个领域（其一就是本文件在验的补货），
 *        页面上的补货块、尺码清单、一键补货表单**一个字没变** —— 只是它现在挂在 `from=replenish` 下。
 *   ⚠️ 其余断言（尺码分组 / 数量 / 预勾 / 幂等键 / 零 JS …）一条都没放宽。
 */
/**
 * ⭐⭐ 扫码页「**一个码、三个领域扫出来不一样**」的验收标准（业务负责人 **2026-10-09**）。
 *
 * 她的口径（逐字要点）：
 *   · **同一个二维码**（`/s/{编号}?from=…`）在三个领域里**做三件不同的事**；
 *   · **`from=inventory`（单款查询）就是现在这个页面 —— 一个字不许变**（既有用例是哨兵）；
 *   · **`from=sales`（销售建单）**：尺码**分两组** ——
 *       第一组 = **有货（样品 + 门盒）**的尺码 ⇒ 选中它 = **现货**；
 *       第二组 = 该组（男 A = 38–48 / 女 B = 34–43）**目前没有的** ⇒ 选中它 = **预订**；
 *       提交走**既有**销售建单链路，交易类型用**既有**行为编码（`SALE_CASH` / `SALE_PREPAID`）；
 *   · **`from=replenish`（补货；2026-10-11 前叫 `from=purchase`）**：列出该编号下**各尺码及数量（样品 + 门盒）** + 【**一键补货**】——
 *       一键补货 = 列出**缺的尺码**、**默认各 1 双**、**数量可改** ⇒ 走**既有**
 *       `purchaseWebhookService` 那条链路生成采购申请。
 *   · 三个领域**共用业务处理层**、各自**独立的状态 / 出口**（入口隔离不变）。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC1 **库存领域一个字不变**：从 `<div class="realm-block realm-block--inventory">` 到它的
 *      `</div>` 与身份区**逐字**等于既有实现（库存表 / 缺码高亮 / 0 用「—」/ 备注）。
 *  AC2 **销售领域尺码分两组**：有货（样品 + 门盒 ＞ 0）= 第一组（现货）、
 *      其余 = 第二组（预订）；两组各自可选中（radio 的 `name="size"`），
 *      「仓库」有货**不算**有货（她 2026-10-09：「可卖 = 样品 + 门盒」）。
 *  AC2b ⭐ **尺码区一行 4 个码、不显示数量**（业务负责人 2026-10-11：「从"一行一码"改成
 *      "一行 4 个"」「**你不用管数量，只要它实时库存表里面有，你显示就行**」，
 *      目标是手机上**一屏不下滑**看全）：四列网格（`minmax(0, 1fr)` ⇒ 窄屏不横向滚动）；
 *      3 个码排一行、5 个码排 4+1；**现货组 / 预订组的判据一个字不变**；命中区仍 ≥44px；
 *      数量只在「库存」页看，**采购页的数量不受影响**；改版**不许引入前端脚本**。
 *  AC3 **采购领域**：先列该编号各尺码的（样品 + 门盒）数量；【一键补货】列出缺的尺码、
 *      默认各 1 双、数量可改；「仓库」有货的尺码**不预勾**（既有缺码口径不变）。
 *  AC4 **三个领域共用业务处理层、各自独立出口**（源码哨兵）：渲染层不认识业务写入；
 *      三块各自带 `realm-block--<领域>` 标记，**服务端按 `?from` 只把当前那一块拼进 HTML**
 *      （2026-10-09 真机「手机在飞书 webview 里白屏」之后改的：不再靠 CSS 显隐 +
 *      `<head>` 内联脚本，整页**一行前端脚本都没有** ⇒ 没 JS 也 100% 正确）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/** ⭐ 2026-10-13「金额两步走」：这一组能力**整块挪到第 2 步页** ⇒ 断言在它该在的那一页做
 *  （能力去哪：`renderSalePaymentStepPage`）。🔴 口径未放宽：字段名 / 标签 / 默认档一个字都没变 ✓
 *  ⚠️ 这里**自带 require**，不依赖各文件顶部的局部名（各文件的导入风格不一样）。 */
const step2Of = () => {
  const { SCAN_WRITE: SW } = require('../src/config/scanWrite');
  const { renderSalePaymentStepPage: renderStep2 } = require('../src/views/scanPageRenderer');
  return renderStep2({
    write: {
      texts: SW.texts, fields: SW.fields, actions: SW.actions,
      paymentMethods: SW.sale.paymentMethods,
      defaultPaymentMethod: SW.sale.defaultPaymentMethod,
      paymentRowCount: SW.sale.paymentRowCount,
      paymentStatus: SW.sale.paymentStatus.default,
      defaultPaymentStatus: SW.sale.paymentStatus.default,
      paidAmount: '', draft: { lines: [] },
    },
  });
};

const { renderScanPage, STYLE, renderSalePaymentStepPage } = require('../src/views/scanPageRenderer');
const { SCAN_PAGE } = require('../src/config/scanPage');
/**
 * ⭐⭐ 2026-10-16 **成对迁移**（依据 = 业务负责人 2026-10-12 逐字「我可没有说过，
 *   **我们是能够进行动态交互的**」＋ 她 2026-10-16 亲口点的「页面标注模式」（扫码页 + 工作台都做 ✓））：
 *
 *   改前逐字（本文件两处）：
 *     `assert.equal((inventoryHtml.match(/<script[\s>]/gi) || []).length, 0, '库存页没有提交按钮 ⇒ 仍然是零脚本');`
 *     `assert.equal((htmlFor('sales').match(/<script[\s>]/gi) || []).length, 1, '销售页只该有那一段提交反馈脚本');`
 *   改后逐字：同上，但正则换成 `<script(?! data-view="annotate")[\s>]`（只数**业务**脚本），
 *     并把"库存页 0 段"读作"**业务**脚本 0 段"＋"那一段标注脚本必须在且**必须早退**"。
 *
 *   依据：「扫码页零 JS」是**我方（agent 侧）**的约束、**不是她的口径**；而"带 `?annotate=1`
 *     才出现"这道闸门**只能落在脚本内部** —— 查询串只有 `routes/scanPage.js` 拿得到，
 *     那个文件**不在本任务写作用域内**（另有主）。
 *   ⚠️ **没放宽**：段数上限照旧，且**新增**一条"那一段不许做事（不带参数就 return）"的判据 ✓
 */
const ANNOTATE_MARK = '<script data-view="annotate">';
const businessScriptCountOf = (html) => (html.match(/<script(?! data-view="annotate")[\s>]/gi) || []).length;
const annotateScriptOnlyEarlyExits = (html) => {
  const at = html.indexOf(ANNOTATE_MARK);
  if (at < 0) return false;
  const body = html.slice(at, html.indexOf('</scr' + 'ipt>', at));
  return body.includes('location.search') && body.includes('if (!enabled()) return');
};
const {
  SELLABLE_STATES, SIZE_GROUP_RANGES, REALM_TEXTS, DEFAULT_REALM,
  sellableCountOf, saleSizeGroups, purchaseSizeLines,
  REALMS,
} = require('../src/views/scanPageRealm');

const SRC = path.join(__dirname, '..', 'src');
const readSrc = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

/**
 * 视图模型夹具（**照测试 Base 的真实列形状**写）：
 *   40 = 门盒 1                ⇒ 有货（现货）
 *   41 = 三种状态都没有         ⇒ 缺码（预订）
 *   42 = 门盒 1 + 样品 1        ⇒ 有货（现货）
 *   43 = 只有仓库 2            ⇒ **不算有货**（她：可卖 = 样品 + 门盒）⇒ 预订
 *   44 = 三种状态都没有         ⇒ 缺码（预订）
 */
const VIEW = {
  found: true,
  number: 'YD6693-2|黑色|A',
  item_no: 'YD6693-2',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: 'A',
  price_text: '¥399',
  total: 5,
  columns: [{ key: '门盒', label: '门盒' }, { key: '样品', label: '样品' }, { key: '仓库', label: '仓库' }],
  rows: [
    { size_text: '40', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 1, missing: false },
    { size_text: '41', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
    { size_text: '42', cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 1 }, { key: '仓库', count: 0 }], total: 2, missing: false },
    { size_text: '43', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 2 }], total: 2, missing: false },
    { size_text: '44', cells: [{ key: '门盒', count: 0 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }], total: 0, missing: true },
  ],
  missing_count: 2,
  sizes_degraded: false,
  notes: ['缺码说明'],
  updated_at_text: '2026-10-08 20:30',
  product_record_id: 'prod_1',
};

/** 最小写上下文（字段名 / 动作 / 文案都照 `config/scanWrite.js` 的形状）。
 *  ⭐ 2026-10-10：`saleHeading` / `replenishHeading` / `fundsPendingNote` / `replenishHint`
 *     四个**说明句**已从配置里退场 ⇒ 这里也不再放（放进来就是在钉一个不存在的文案）。 */
const WRITE = {
  enabled: true,
  texts: {
    draftHeading: '本单现在 {count} 双',
    draftEmpty: '本单还没有鞋',
    draftItem: '{itemNo} {size} 码',
    sizeLabel: '尺码',
    sizePlaceholder: '这一款没有可用尺码',
    amountLabel: '实收金额',
    amountPlaceholder: '不填按单价算',
    giftLabel: '赠品',
    addButton: '加入本单',
    paymentLabel: '收款方式',
    paymentAmountLabel: '收款金额',
    paymentAmountPlaceholder: '不填就是还没收钱',
    submitButton: '提交这一单',
    clearButton: '清空本单',
    replenishQuantityLabel: '数量',
    replenishButton: '生成采购申请',
  },
  fields: {
    action: 'action',
    submitKey: 'submit_key',
    size: 'size',
    amount: 'amount',
    gift: 'gift',
    paymentMethod: 'payment_method',
    paymentAmount: 'payment_amount',
    replenishSizes: 'sizes',
    replenishQuantityPrefix: 'qty_',
  },
  actions: { addLine: 'add_line', submitOrder: 'submit_order', clearDraft: 'clear_draft', replenish: 'replenish' },
  postAction: '/s/YD6693-2%7C%E9%BB%91%E8%89%B2%7CA',
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_0123456789abcdef:1',
  replenishKey: 'scan_replenish:scan_session_0123456789abcdef:1',
  paymentMethods: ['微信', '现金'],
  defaultPaymentMethod: '微信',
  notice: '',
};

/**
 * ⭐ 2026-10-09 之后：**渲染是按领域来的** —— 每个领域单独渲染一份 HTML，
 * 里面**只有当前那一块**（另外三块连字符串都不拼）。
 */
const htmlFor = (realm) => renderScanPage(VIEW, SCAN_PAGE, WRITE, realm);

/** 取某一份 HTML 里领域那一块（收在页脚 `<p class="foot">` 之前，含它自己的 `</div>`）。 */
const blockOf = (htmlText, id) => {
  const page = htmlText.slice(htmlText.indexOf('</head>'));
  const start = page.indexOf(`realm-block--${id}"`);
  assert.ok(start > -1, `缺 ${id} 块`);
  const foot = page.indexOf('<p class="foot">', start);
  return page.slice(start, foot > -1 ? foot : page.length);
};

// ═══════════════════════════════════════════════════════════════════════════
// AC1 库存领域一个字不变（既有页面就是哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC1 `from=inventory` 就是现在这个页面：库存领域那一块 + 身份区**逐字不变**', () => {
  const inventoryHtml = htmlFor('inventory');
  const inventoryBody = inventoryHtml.slice(inventoryHtml.indexOf('</head>'));
  // ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「`category_name` ⇒ 品类 · `category_code` ⇒ 类别，**两个都显示**，
  //   有就显示，没有就不显示」＋「需要做个映射，**A 等于男，B 等于女**」
  //   ⚠️ 改前逐字：`黑色 · 休闲鞋`（`品类 || 类别` **二选一** ✗）；改后逐字：`黑色 · 休闲鞋 · 男`（三段 ✓）
  //   ⇒ 这条 AC 的**库存领域那一块**仍逐字不变 ✓，只有**身份区**按她的新口径改 ✓（不是放宽 ✗）
  assert.ok(inventoryBody.includes(`<header class="card identity">
<div class="identity__main">
<h1 class="identity__item">YD6693-2</h1>
<p class="identity__meta">黑色 · 休闲鞋 · 男</p>
</div>
<div class="price">
<span class="price__label">单价</span>
<span class="price__value">¥399</span>
</div>
</header>`), '身份区（货号 / 颜色 · 品类 / 单价）逐字不变');

  // 库存领域那一块 = 库存表（逐字）+ 备注，外面只有 realm-block 那一层 div
  const golden = `realm-block--inventory">
<section class="card">
<h2 class="stock__heading">库存（共 5 双）</h2>
<table class="stock">
<thead><tr><th>尺码</th><th>门盒</th><th>样品</th><th>仓库</th></tr></thead>
<tbody>
<tr><th scope="row">40</th><td>1</td><td class="zero">—</td><td class="zero">—</td></tr>
<tr class="missing"><th scope="row">41<span class="badge" title="缺码：这个尺码没有库存">⚠️ 缺</span></th><td class="zero">—</td><td class="zero">—</td><td class="zero">—</td></tr>
<tr><th scope="row">42</th><td>1</td><td>1</td><td class="zero">—</td></tr>
<tr><th scope="row">43</th><td class="zero">—</td><td class="zero">—</td><td>2</td></tr>
<tr class="missing"><th scope="row">44<span class="badge" title="缺码：这个尺码没有库存">⚠️ 缺</span></th><td class="zero">—</td><td class="zero">—</td><td class="zero">—</td></tr>
</tbody>
</table>
<ul class="notes"><li>缺码说明</li></ul>
</section>
</div>
`;
  assert.equal(blockOf(inventoryHtml, 'inventory'), golden,
    '库存领域那一块一个字都不许变（她是既有用例的哨兵）');

  // 库存块里不许混进销售 / 采购的新东西
  for (const forbidden of ['data-stock-group', 'data-view="one-tap-replenish"', 'purchase-sizes', 'size-chip']) {
    assert.equal(blockOf(inventoryHtml, 'inventory').includes(forbidden), false, `库存块里混进了 ${forbidden}`);
  }
  // 领域切换条照旧（四个真链接）；
  // 🔴 但"靠 CSS 显隐 + `<head>` 脚本"那一层**整层拿掉**了（手机白屏之后的改法）
  assert.ok(inventoryHtml.includes('href="?from=inventory"'));
  assert.equal(STYLE.includes('data-realm'), false, 'CSS 不许再依赖 data-realm');
  assert.equal(/display:\s*none/.test(STYLE), false, '不许再出现"默认藏起来"的写法（那是白屏的形状）');
  // ⭐ 2026-10-16 成对迁移（逐字对照见本文件顶部那段注释）：数**业务**脚本 ＋ 标注脚本必须早退 ✓
  assert.equal(businessScriptCountOf(inventoryHtml), 0, '库存页没有提交按钮 ⇒ 仍然零**业务**脚本');
  assert.equal(annotateScriptOnlyEarlyExits(inventoryHtml), true, '那段标注脚本必须在且必须早退 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 销售领域：尺码分两组（有货 = 现货 / 其余 = 预订）
// ═══════════════════════════════════════════════════════════════════════════

test('AC2 `from=sales` 尺码分两组：有货（样品+门盒）⇒ 现货；其余 ⇒ 预订', () => {
  // ① 判据在视图层，且**只认「样品 + 门盒」**（仓库不算可卖）
  // ⭐⭐ 2026-10-16 晚（本刀）**成对迁移（注释级 · 断言一条没动）**：
  //   改前逐字：这条说的是"**当前**可卖口径 = 样品 + 门盒"。
  //   改后逐字：它说的是"**开关关着（缺省 = 今天）**时可卖 = 样品 + 门盒"——
  //     口径的家已搬到 `config/scanStockPolicy.js`（`LEGACY_SELLABLE_STATES` / `countInStockOf`）；
  //     开关**开着**时（"实时库存里有记录 = 有货"）见 `test/scanStockPolicyUnifiedOn.test.js`。
  //   依据：业务负责人 2026-10-16 20:5x「**统一不用看状态**……这个口径其实也可以做一个配置」。
  //   ⚠️ 断言值与强度**都没变**（本文件跑的进程 = 缺省关着 ✓）。
  // ⭐⭐ 2026-10-16 22:5x **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.deepEqual([...SELLABLE_STATES], ['门盒', '样品'], '开关关着时：可卖 = 样品 + 门盒（她 2026-10-09 的口径）');`
  //   改后逐字：⭐ **该名单已随老口径退场** ✓（`SELLABLE_STATES === undefined` ✓）——
  //     ⚠️ 原句 `[...SELLABLE_STATES]` 在名字退场后会**当场抛** ✗ ⇒ ⭐ 整条 AC2 就断在这里（后面根本没跑到 ✗）
  //   依据 = 她 20:5x「**统一不用看状态**，只要在实时库存里这个编号有尺码记录，就都是有货」＋ 22:5x「**不需要开关**」✓
  assert.equal(SELLABLE_STATES, undefined, '⭐ 老口径名单已退场 ✓ 永远按实时库存口径 ✓（谁加回来 ⇒ 红 ✓）');
  assert.equal(sellableCountOf(VIEW.rows[0], VIEW.columns), 1, '40：门盒 1');
  assert.equal(sellableCountOf(VIEW.rows[2], VIEW.columns), 2, '42：门盒 1 + 样品 1');
  // 改前逐字：`…, 0, '43：只有仓库 2 → 不算有货（开关关着时）'` ⇒ 改后：**2**（新口径：实时库存里有记录 = 有货 ✓）
  assert.equal(sellableCountOf(VIEW.rows[3], VIEW.columns), 2, '43：仓库里有 2 双 ⇒ **算有货**（她 20:5x 新口径 ✓）');
  // 「老形状」（cells 上没有 key，既有夹具就是这种）也认 —— 按视图模型的列序取
  const legacyShape = {
    columns: VIEW.columns,
    rows: [
      { size_text: '40', cells: [{ count: 1 }, { count: 0 }, { count: 0 }], total: 1, missing: false },
      { size_text: '43', cells: [{ count: 0 }, { count: 0 }, { count: 2 }], total: 2, missing: false },
    ],
  };
  // ⭐⭐ 2026-10-16 22:5x **成对迁移**（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`assert.deepEqual(… .inStock.map((item) => item.size_text), ['40'], '没有 key 时按列序取（仓库那 2 双不算有货）');`
  //   改后逐字：⭐ **`['40', '43']`** ✓（实测 ✓）—— ⭐ 老形状里 43 那一行是「仓库 2 双」⇒ **新口径算有货** ✓
  //   依据 = 她 20:5x「**统一不用看状态**，只要在实时库存里这个编号有尺码记录，就都是有货」＋ 22:5x「不需要开关」✓
  assert.deepEqual(saleSizeGroups(legacyShape).inStock.map((item) => item.size_text), ['40', '43'],
    '没有 key 时按列序取 ✓（⭐ 新口径：仓库那 2 双**也算有货** ⇒ 43 进第一组 ✓）');
  // ⭐ 2026-10-14 改指向：`saleSizeGroups` 多返回一组 `folded`（**缺货 ∩ 特殊码** ⇒ 「特殊码」折叠块 ✓）
  //   本例的 VIEW 是男鞋 A 段、缺货的是 41/43/44（**都在可录范围内、且都不是特殊码 46/47/48**）
  //   ⇒ `folded` 为空 ✓（"第一组/第二组"的语义一个字没变 ✓）
  assert.deepEqual(saleSizeGroups(VIEW), {
    // ⭐ 2026-10-16 23:2x 成对迁移（依据 = 她 20:5x「统一不用看状态」＋ 22:5x「不需要开关」）：
    //   改前逐字：`inStock: [{ '40', 1 }, { '42', 2 }]`（旧口径：43 只有仓库 ⇒ 不算有货）
    //   改后逐字：⭐ 43（只有仓库 2 双）新口径**算有货** ⇒ 进 `inStock`
    //   ⚠️ 实测 `actual` 已含 `{ count: 2, size_text: '43' }` ✓（本处是【上一手漏迁的一处】✗ 已补 ✓）
    inStock: [{ size_text: '40', count: 1 }, { size_text: '42', count: 2 }, { size_text: '43', count: 2 }],
    // 改前逐字：`prepaid: [{'41',0},{'43',0},{'44',0}]` ⇒ 改后：**43 已算有货 ⇒ 从预订组移走** ✓
    prepaid: [{ size_text: '41', count: 0 }, { size_text: '44', count: 0 }],
    folded: [],
  }, '⭐ 新口径：第一组 = 有货（现货）40 / 42 / **43**（43 只有仓库 ⇒ 也算有货 ✓）；第二组 = 其余 41 / **44**（预订）；第三组 = 缺货的特殊码（本例为空 ✓）');

  // ② 男女两组（A = 男 38–48 / B = 女 34–43）——她去 2026-10-09 给的范围
  assert.deepEqual(SIZE_GROUP_RANGES.A, { label: '男', from: 38, to: 48, enterable: [38, 48], normal: [38, 44], default: [38, 44], special: [45, 46, 47, 48] });
  // ⚠️ 2026-10-14 改指向（她「按照 **36-42**」✓）—— 改前逐字：`default: [35, 42]`
  assert.deepEqual(SIZE_GROUP_RANGES.B, { label: '女', from: 34, to: 43, enterable: [34, 43], normal: [36, 40], default: [36, 40], special: [34, 35, 41, 42, 43] });

  // ③ 页面上真的分了两组：两组各自的可选项 / 组标题 / 状态标签
  const sales = blockOf(htmlFor('sales'), 'sales');
  const groupOf = (id) => {
    const start = sales.indexOf(`data-stock-group="${id}"`);
    assert.ok(start > -1, `销售块里缺 ${id} 那一组`);
    const next = sales.indexOf('</fieldset>', start);
    return sales.slice(start, next);
  };
  const inStock = groupOf('in_stock');
  const prepaid = groupOf('prepaid');
  // ⭐ 成对迁移（改前逐字 → 改后逐字 → 依据）：
  //   改前逐字：`for (const size of ['40', '42'])`（现货组只有 40 / 42）
  //   改后逐字：⭐ **`['40', '42', '43']`** ✓ —— ⭐ 43（只有仓库 2 双）在新口径下**也算有货** ✓
  //   依据 = 她 20:5x「**统一不用看状态**，只要在实时库存里这个编号有尺码记录，就都是有货」＋ 22:5x「不需要开关」✓
  for (const size of ['40', '42', '43']) {
    assert.ok(inStock.includes(`name="size" value="${size}"`), `现货组缺尺码 ${size}`);
    assert.equal(prepaid.includes(`name="size" value="${size}"`), false, `${size} 有货，不该出现在预订组`);
  }
  // 改前逐字：`['41','43','44']`（43 不算有货）⇒ 改后：**只剩 41 / 44**（43 已入现货组 ✓）
  for (const size of ['41', '44']) {
    assert.ok(prepaid.includes(`name="size" value="${size}"`), `预订组缺尺码 ${size}`);
    assert.equal(inStock.includes(`name="size" value="${size}"`), false, `${size} 没货，不该出现在现货组`);
  }
  assert.ok(sales.includes(REALM_TEXTS.saleInStockHeading), '第一组的标题 = 现货');
  assert.ok(sales.includes(REALM_TEXTS.salePrepaidHeading), '第二组的标题 = 预订');
  assert.ok(/tag[^>]*>\s*现货/.test(sales), '现货 = 彩色小标签');
  assert.ok(/tag[^>]*>\s*预订/.test(sales), '预订 = 彩色小标签');
  // 每个可选项都是一整块可点的（≥44px 命中区）
  assert.ok(inStock.includes('size-chip') && prepaid.includes('size-chip'), '每个尺码 = 一整块可点');
  assert.match(STYLE, /\.size-chip\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '尺码卡片的命中区 ≥44px（手机上好点）');
  // 销售建单该有的东西一样不少（提交走既有链路）
  assert.ok(sales.includes('加入本单') && sales.includes('value="submit_order"'));
  // ⚠️ 2026-10-10 断言翻转（她：「删掉解释我怎么用的句子」）：
  //    原先这里钉着「资金不是必填…」那句（`fundsPendingNote`）**要在页面上写着**；
  //    现在它必须不存在。**不放宽**：能填能点的（尺码 / 实收金额 / 收款方式 + 两颗按钮）照旧。
  assert.equal(/资金不是必填|这一单先记了货/.test(sales), false, '资金那句说明必须删掉');
  // ⭐ 2026-10-13 改指向：默认微信那一行**挪到第 2 步页**（能力去哪：renderSalePaymentStepPage）✓
  assert.ok(step2Of().includes('<option value="微信" selected>微信</option>'));

  // ④ 降级（拿不到该类别尺码）时：第二组为空、页面上说明只显示有库存的尺码
  const degraded = saleSizeGroups({ ...VIEW, sizes_degraded: true });
  assert.deepEqual(degraded.prepaid, [], '降级时不许编造"没有的尺码"');
  // ⭐ 2026-10-16 23:2x 成对迁移（依据 = 她 20:5x「统一不用看状态」＋ 22:5x「不需要开关」）：
  //   改前逐字：`assert.deepEqual(degraded.inStock.map(…), ['40', '42']);`
  //   改后逐字：⭐ 43（只有仓库 2 双）新口径**算有货** ⇒ 也在 `inStock`（实测 `actual: ['40','42','43']` ✓）
  //   ⚠️ 这是 `AC2` 里**第二处**期望 `['40','42']` 的地方 ✗（同一判据多处 ⇒ 今晚第 5 次同型 ✓）
  assert.deepEqual(degraded.inStock.map((item) => item.size_text), ['40', '42', '43'],
    '⭐ 降级时 `inStock` 仍是新口径那一组：40 / 42 / 43（43 = 仓库 2 双 ⇒ 算有货 ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2b ⭐ 2026-10-11（业务负责人）：销售尺码区**一行 4 个码**、**不显示数量**
// ═══════════════════════════════════════════════════════════════════════════

test('AC2b 尺码区一行 4 个：3 个码排一行、5 个码排 4+1；**不显示数量**、命中区仍 ≥44px', () => {
  // ── ① 布局：四列网格；列宽用 `minmax(0, 1fr)` ⇒ 窄屏可压缩、不横向滚动 ────────
  assert.match(STYLE, /\.size-chips\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/,
    '尺码区必须是一行 4 个（四列网格；`minmax(0, 1fr)` 保证窄屏不横向滚动）');
  // ── ② 命中区一个字不减（≥44px）——「紧凑」不等于「缩小命中区」──────────────────
  assert.match(STYLE, /\.size-chip\s*\{[^}]*min-height:\s*var\(--control-height\)/s,
    '尺码卡片仍是 ≥44px 的命中区（手机上好点）');

  const sales = blockOf(htmlFor('sales'), 'sales');
  const groupOf = (id) => {
    const start = sales.indexOf(`data-stock-group="${id}"`);
    assert.ok(start > -1, `销售块里缺 ${id} 那一组`);
    return sales.slice(start, sales.indexOf('</fieldset>', start));
  };
  const chipsOf = (group) => (group.match(/class="size-chip"/g) || []).length;
  const inStock = groupOf('in_stock');
  const prepaid = groupOf('prepaid');
  // ── ③ 分组与判据一个字不变：40 / 42 = 现货；41 / 43 / 44 = 预订 ─────────────────
  assert.equal(chipsOf(inStock), 3, '现货组：**40 / 42 / 43** 三个码（43 = 仓库 2 双 ⇒ 新口径算有货 ✓）');
  // 改前逐字：`chipsOf(prepaid), 3, '预订组：41 / 43 / 44 三个码…'` ⇒ 改后：**2**（43 已算有货 ⇒ 入现货组 ✓）
  assert.equal(chipsOf(prepaid), 2, '预订组：**41 / 44** 两个码（43 已算有货 ✓ 依据 = 她 20:5x ✓）');
  // ── ④ 不显示数量：两组里一个「双」字都没有 ────────────────────────────────────
  for (const [name, group] of [['现货组', inStock], ['预订组', prepaid]]) {
    assert.equal(group.includes('size-chip__meta'), false, `${name}里还留着数量那一格`);
    assert.equal(group.includes('双'), false, `${name}里还显示着数量（她：「你不用管数量」）`);
  }
  // ── ⑤ 数量没有消失，只是换地方看：同一份视图模型在「库存」页照旧逐格显示 ───────
  const inventory = blockOf(htmlFor('inventory'), 'inventory');
  assert.match(inventory, /<td[^>]*>\d+<\/td>/, '库存页照旧有数量');
  // ── ⑥ 采购页的数量**不许**跟着一起删（那是补货的依据）────────────────────────
  assert.ok(blockOf(htmlFor('replenish'), 'replenish').includes('2 双'), '采购页仍按尺码显示数量');
  // ── ⑦ 5 个码 ⇒ 排成 4+1：五个 chip 都在同一组里（换行由四列网格决定）──────────
  const fiveInStock = {
    ...VIEW,
    rows: ['40', '41', '42', '43', '44'].map((size) => ({
      size_text: size,
      cells: [{ key: '门盒', count: 1 }, { key: '样品', count: 0 }, { key: '仓库', count: 0 }],
      total: 1,
      missing: false,
    })),
  };
  const fiveSales = blockOf(renderScanPage(fiveInStock, SCAN_PAGE, WRITE, 'sales'), 'sales');
  const fiveStart = fiveSales.indexOf('data-stock-group="in_stock"');
  const fiveGroup = fiveSales.slice(fiveStart, fiveSales.indexOf('</fieldset>', fiveStart));
  assert.equal(chipsOf(fiveGroup), 5, '5 个码全在同一组里（四列 ⇒ 4+1 两行）');
  assert.equal(fiveGroup.includes('size-chip__meta'), false, '5 个码时也不显示数量');
  // ── ⑧ 改版不许引入前端脚本（这一页的底线）────────────────────────────────────
  // ⚠️ 2026-10-18 成对迁移（第 4 步提速）：销售页业务脚本 1 → 2（多的是提交进度遮罩 `submit-progress`）；
  //   标注脚本仍必须早退 ✓（依据 = 第 4 步目标 #4：提交改 fetch + 全屏进度遮罩，避免白屏）。
  assert.equal(businessScriptCountOf(htmlFor('sales')), 2, '销售页业务脚本 = 提交反馈 ＋ 提交进度（2 段）');
  assert.equal(annotateScriptOnlyEarlyExits(htmlFor('sales')), true, '那段标注脚本必须在且必须早退 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC3 采购领域：各尺码（样品+门盒）数量 + 一键补货
// ═══════════════════════════════════════════════════════════════════════════

test('AC3 `from=replenish`：列出各尺码（样品+门盒）数量 + 【一键补货】列出缺的尺码、默认各 1 双', () => {
  // ① 取数：每个尺码的（样品 + 门盒）数量 + 是不是"三种状态都没有"（既有缺码口径）
  // 2026-10-14 晚（她逐字）：「一键补货的时候，特殊码不能默认勾选，但是可录尺码还是显示」
  //   ⇒ 这里多一个 `special` 字段（**判据加强**：缺码默认勾只对**非特殊码**成立 ✓ 没放宽 ✗）
  assert.deepEqual(purchaseSizeLines(VIEW), [
    { size_text: '40', sellable: 1, missing: false, checked: false, special: false },
    { size_text: '41', sellable: 0, missing: true, checked: true, special: false },
    { size_text: '42', sellable: 2, missing: false, checked: false, special: false },
    // 改前逐字：`{ size_text: '43', sellable: 0, … }` ⇒ 改后：**sellable: 2**（仓库 2 双 ⇒ 新口径算有货 ✓）
    { size_text: '43', sellable: 2, missing: false, checked: false, special: false },
    { size_text: '44', sellable: 0, missing: true, checked: true, special: false },
  ], '缺码（三种状态都没有）默认勾上；43 只有仓库 → 不预勾；这个夹具的类别没有特殊码 ⇒ special 全 false ✓');

  const purchase = blockOf(htmlFor('replenish'), 'replenish');
  // ② 先给她看"各尺码现在有多少"
  assert.ok(purchase.includes('data-view="purchase-sizes"'), '要先列出各尺码的（样品 + 门盒）数量');
  for (const size of ['40', '41', '42', '43', '44']) {
    assert.ok(purchase.includes(`data-purchase-size="${size}"`), `尺码清单缺 ${size}`);
  }
  assert.ok(/data-purchase-size="42"[\s\S]*?2 双/.test(purchase), '42 要显示 2 双（门盒 1 + 样品 1）');
  // ③ 【一键补货】：缺的尺码默认勾上、默认各 1 双、数量可改
  assert.ok(purchase.includes('data-view="one-tap-replenish"'), '要有【一键补货】');
  assert.ok(purchase.includes('一键补货'));
  assert.ok(purchase.includes('name="sizes" value="41" checked'));
  assert.ok(purchase.includes('name="sizes" value="44" checked'));
  assert.equal(/name="sizes" value="40" checked/.test(purchase), false, '40 有货 → 不预勾');
  assert.equal(/name="sizes" value="43" checked/.test(purchase), false, '43 有仓库货 → 不预勾');
  for (const size of ['40', '41', '42', '43', '44']) {
    assert.ok(purchase.includes(`name="qty_${size}"`), `数量输入框缺 ${size}（数量可改）`);
  }
  assert.match(purchase, /name="qty_41"[^>]*value="1"/, '默认各 1 双');
  // ⭐⭐ 2026-10-16 **成对迁移**（依据 = 业务负责人真机截图 · 补货 tab · 货品 832-500 ＋ 逐字：
  //   「这个是报货的页面，还是需要填写金额啊，以及不需要的文字说明给删除，
  //     **生成报货订单按钮文字改为补货**」）：
  //   改前逐字（本行）：
  //     `assert.ok(purchase.includes('生成采购申请'), '生成采购申请 = 既有链路（既有写入口）');`
  //     ⚠️ 那串字来自**本文件夹具**的 `WRITE.texts.replenishButton = '生成采购申请'`
  //       （照抄写侧键名）—— 意思是"渲染层把写侧给的那句话摆出来了"。
  //   改后逐字（下面两行）：
  //     那颗按钮的文字**不再来自写侧夹具**，而是来自**渲染侧**配置
  //     `SCAN_PAGE.replenishForm.submitLabel`（= `'补货'` ✓ 见 `config/scanPage.js`）✓
  //   依据：她 2026-10-16 逐字「生成报货订单按钮文字改为补货」
  //     （＋她 2026-10-14 晚定过的「生成采购申请的文字变为生成报货订单」那条已被她这次改掉 ✓）。
  //   ⚠️ **不是放宽**：从"**裸词**出现在整页里"（弱 —— 夹具给什么就绿什么）改成
  //     ①「**逐字**钉那颗按钮的收尾 `<label></button>`」＋ ②「**写侧夹具那个旧值绝不许出现在页面上**」
  //     （两处都是**反向**可红的 ✓ 更严 ✓）。
  //   ⚠️ 夹具里那行 `replenishButton: '生成采购申请',` **保留**（它现在是**哨兵的反例样本**：
  //     拿它证明"那颗按钮**不再读写侧**" ✓ —— 不是"没人读的静默假绿" ✗）。
  assert.ok(purchase.includes(`${SCAN_PAGE.replenishForm.submitLabel}</button>`),
    '⭐ 补货那颗按钮的文字来自**渲染侧配置** `SCAN_PAGE.replenishForm.submitLabel` ✓');
  assert.equal(purchase.includes(WRITE.texts.replenishButton), false,
    `🔴 写侧夹具那句「${WRITE.texts.replenishButton}」**不再出现在页面上**（那颗按钮已改指向 ⇒ 塞回即红 ✓）`);
  assert.ok(purchase.includes(WRITE.replenishKey), '幂等键照旧在表单里');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC4 三个领域共用业务处理层 / 各自独立出口（源码哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC4 三个领域共用业务处理层、各自独立出口（渲染层不认识业务写入）', () => {
  const renderer = stripComments(rendererSource());
  // 渲染层一个写库调用都没有（写入口在 scanWriteService，路由只做接线）
  for (const pattern of [/gateway\.(create|update|delete)\s*\(/, /appTableRecord\.(create|update|delete)/,
    /(applySale|applyPurchase|applyChange|applyReturn)\s*\(/, /inventoryService|salesOrderService|purchaseWebhookService/]) {
    assert.equal(pattern.test(renderer), false, `scanPageRenderer.js 出现了业务写入：${pattern}`);
  }
  // 三块各自带领域标记，而且是**服务端按领域单独渲染**的（一份 HTML 里只有当前那一块）
  for (const id of REALMS.map((realm) => realm.id)) {
    const htmlText = htmlFor(id);
    assert.ok(blockOf(htmlText, id).length > 0, `缺 ${id} 领域块`);
    for (const other of REALMS.map((realm) => realm.id).filter((item) => item !== id)) {
      assert.equal(htmlText.includes(`realm-block--${other}"`), false,
        `渲染 ${id} 时不该把 ${other} 块也拼进来`);
    }
  }
  // 三块共用**同一份视图模型**（渲染层不自己查表：分组 / 补货清单都是纯函数算的）
  const source = rendererSource();
  assert.match(source, /require\('\.\/scanPageRealm'\)/, '分组 / 补货清单来自视图层的同一份配置');
  assert.ok(source.includes('saleSizeGroups(view)') && source.includes('purchaseSizeLines(view)'),
    '销售与采购两块都拿同一份视图模型算（没有各领域自己再查一次表）');
  // 2026-10-14 晚（她：「库存的表格里还是没有排除特殊码」）⇒ 库存表改成**排除缺货的特殊码**后
  //   调用的**形状**变了（`{ ...view, rows: tableRows }`）—— 仍是**同一份视图模型** ✓（只是少了几行 ✓）
  assert.ok(source.includes('stockTableHtml({ ...view, rows: tableRows }, config)'),
    '库存那一块也是同一份视图模型（行 = 视图行 − 缺货的特殊码 ✓）');
  // 交易类型 / 缺码判据都在**既有配置**里，视图层不写死编码
  const realm = stripComments(readSrc('views/scanPageRealm.js'));
  assert.equal(/SALE_CASH|SALE_PREPAID/.test(realm), false, '视图层不许写死交易类型编码（用既有判据）');
});
