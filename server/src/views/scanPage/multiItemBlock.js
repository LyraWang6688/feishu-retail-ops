const { MULTI_ITEM_RENDER_TEXTS, fillText } = require('../../config/scanPage');
const { MULTI_ITEM_ORDER } = require('../../config/multiItemOrder');
const { realmScanConfigHtml } = require('../scanRealmScan');
const { escapeHtml } = require('./fields');
const { submitFeedbackAttrs } = require('./script');

const purchaseAmountRowHtml = (write) => {
  const texts = write?.texts || {};
  const fields = write?.fields || {};
  return `<div class="form-row"><label>${escapeHtml(texts.purchaseAmountLabel || '')}</label>`
    + `<input name="${escapeHtml(fields.purchaseAmount)}" inputmode="decimal"`
    + ` placeholder="${escapeHtml(texts.purchaseAmountPlaceholder || '')}"`
    + ` aria-label="${escapeHtml(texts.purchaseAmountLabel || '')}"></div>`;
};

/**
 * 补货表单：勾选缺的尺码 + 填数量 → 生成采购申请。
 *
 * ⭐ 2026-10-09（下半场）采购领域 = **先列各尺码（样品 + 门盒）数量** + 【**一键补货**】：
 *   · 一键补货 = 把**缺的尺码**默认勾上、**默认各 1 双**、数量可改（`<details>` 折叠，
 *     点一下 "一键补货" 就展开；没有一行 JS）；
 *   · 走的是**既有**补货写入口（`views/../services/scanWriteService.js` 的 `submitReplenish`）→
 *     既有采购免确认链路（`publishPurchaseRequest`；「信息填写」表变更那条入口
 *     已于 2026-10-09 退场，函数本身没变）—— 渲染层一行业务逻辑都没有。
 */

/**
 * ⭐⭐ 2026-10-16（**一单多货品 · 渲染半**）—— 补货 / 退货**共用**那一块。
 *
 * 她的口径（逐字）：「核心就是…**销售、补货、退货支持一单多货**」⇒ 补货/退货也要能**一单加多个货品** ✓。
 *   · 形状 = 设计 §4.3（`[{product_record_id, number, item_no, color, supplier_record_id, entries:[{size, quantity}]}]`）✓
 *   · 🔴 **N=1 与今天逐字不变**：开关 `MULTI_ITEM_ORDER.enabled === false` ⇒ 本函数返回 **空串** ⇒
 *     两个表单**一个字节都不变** ✓（既有断言原样绿 ✓）
 *   · 🔴 **不新开提交路径**：整块只是往**既有那个 `<form>`** 里加一个 hidden 字段 ＋ 一个按钮 ＋ 一段脚本；
 *     `action` / `submitKey` / 尺码字段 / 金额行 / 提交按钮**顺序与内容都不动** ✗
 *   · ⚠️ 允许 JS 动态交互（她 2026-10-12 明确「**我们是能够进行动态交互的**」✓）——
 *     这是**我方**的技术选择，**不是"她的要求"** ✗
 *
 * ⚠️ 载荷**键名只在这里定义一次**（`*_KEYS`）：服务端纯函数与页面脚本**共用同一份** ⇒ 不会两处写漂 ✓
 */
const MULTI_ITEM_ITEM_KEYS = Object.freeze([
  'product_record_id', 'number', 'item_no', 'color', 'supplier_record_id', 'entries',
]);
const MULTI_ITEM_ENTRY_KEYS = Object.freeze(['size', 'quantity']);

/** 一单多货品的载荷 JSON（**纯函数**，用例直接钉它 ✓；形状 = 设计 §4.3）。 */
const multiItemPayloadJson = (items = []) => JSON.stringify(
  (Array.isArray(items) ? items : []).map((item) => {
    const out = {};
    for (const key of MULTI_ITEM_ITEM_KEYS) {
      out[key] = key === 'entries' ? undefined : String((item || {})[key] ?? '');
    }
    out.entries = (Array.isArray((item || {}).entries) ? item.entries : []).map((entry) => {
      const line = {};
      for (const key of MULTI_ITEM_ENTRY_KEYS) {
        line[key] = key === 'quantity' ? Number((entry || {})[key]) : String((entry || {})[key] ?? '');
      }
      return line;
    });
    return out;
  }),
);

/**
 * 🔴 **零 JS**（既有哨兵钉着：扫码页 HTML 里**一行 `<script>` 都不许有** —— `AC-W2` / `AC-6R5`）⇒
 *   这一块**不用任何前端脚本**：
 *   · `multi_items` 的**首件**由**服务端**渲进 hidden 字段（形状 = 设计 §4.3；`entries` 由路由在提交时合并 ✓）
 *   · 「再加一个货品」是一颗**链接**（同一路径带参数 ⇒ 路由侧去记草稿；**路由没接前 = 能点、但没人读** ✓ 自洽）
 *   · 「已加货品」列表**由服务端**从 `view.multi_items` 渲染（拿不到 ⇒ 按下面的口径处理 ✓ 不编 ✗）
 *
 * ⭐⭐ 2026-10-16（`mode` 参数 · 业务负责人真机截图 + 逐字）—— **两个领域先后各点了一次，同一个形状**：
 *   · **退货 tab**（第一次）：「退货确实没有了那个退货按钮，需要你**删除不必要的文字提示**」
 *     ＋ 弹窗确认她选的是「**说明 + 「本单已加的货品」那整块都删**」（逐字在 lead 的弹窗记录里 ✓）；
 *   · **补货 tab**（第二次 · 她 2026-10-16）：「这个是**报货的页面，还是需要填写金额啊**，以及
 *     **不需要的文字说明给删除**，**生成报货订单按钮文字改为补货**」
 *     ⇒ 「不需要的文字说明」= **与退货同一条**（那次她选的是"说明 + 整块都删"）⇒ 这里**同样处理** ✓。
 *     ⚠️ 她那次的选择**只对退货生效过**（补货那块当时**一个字没动** ✗）；**这一次她才点了补货** ✓
 *       ⇒ 现在两块**都进精简档**（**依据 = 她 2026-10-16 补货 tab 的截图 + 逐字** ✓）。
 *
 *   ⚠️ **改前**这一块在**补货 / 退货两块共用同一份 DOM**（`t.hint` 那一段 + `t.title` 那个 `<h3>`
 *     + 空态那句 `t.empty` **无条件**渲染）。
 *
 *   ⇒ **`mode === 'return'` / `mode === 'replenish'`（两块各自显式传自己那一档）**：
 *     · 🔴 **删** `t.hint` 那一段说明（她逐字：「删除不必要的文字提示」）；
 *     · 🔴 **删** `t.title` 那个标题 ＋ 空态那句 `t.empty`（弹窗：**"说明 + 整块都删"**）；
 *     · ⭐ **但"已加的货品列表"本身要保留** —— **只有真的加了第二个货品时才出现**
 *       ⇒ 空的时候 `data-view="multi-item-list"` 那个 `<ul>` **整块不渲染** ✓（有内容才显示 ✓）；
 *     · 🔴 **一个字都不动**：`data-multi-add` 那颗「＋ 再加一个货品」、那个 hidden `multi_items`
 *       字段、`data-view="multi-item"` 容器、以及 `attr(...)` 那几个 `data-product-*`（表单行为 ✓）。
 *   ⇒ **`mode` 缺省（`''`）仍逐字不变** ✓ —— 走**老分支**（`t.hint` / `t.title` / `t.empty` / 列表照旧）✓
 *     （= 本函数被直接调用时的老形状；探针 AC-RT7 靠它 ✓ **不许把缺省也一起精简** ✗）。
 *
 *   📌 判据（成对迁移，改前逐字 → 改后逐字 → 依据 = 她 2026-10-16 真机截图 + 逐字
 *     ＋ 弹窗选择「说明 + 整块都删」）：
 *     · 退货那三处 → `test/multiItemOrderReturnTrim.test.js`（AC-RT1..RT5）；
 *     · 补货那三处 → `test/replenishTrimThreeFixes.test.js`（**本刀新增** AC-RP1 / AC-RP3）；
 *     · 两块都：**有第二个货品时列表仍要出现** ✓（**正向**判据 —— 防"删过头" ✗）。
 */
const multiItemBlockHtml = (write, view = {}, mode = '', page = {}) => {
  if (!MULTI_ITEM_ORDER.enabled) return ''; // 🔴 开关关 ⇒ 空串 ⇒ 既有页面逐字不变 ✓
  const t = MULTI_ITEM_RENDER_TEXTS;
  const field = String(MULTI_ITEM_ORDER.field || '');
  if (!field) return ''; // 字段名空 ⇒ 宁可不渲染，也不发一个没人认的键 ✗
  // ⭐ 精简那一版 = **退货 / 补货两块各自显式传自己的 `mode`** ✓
  //   ⚠️ **缺省 `''` 仍是"照旧那一版"**（= 本函数被直接调用时的老形状 ✓ 探针 AC-RT7 靠它 ✓）——
  //     所以这里**必须按显式 mode 分叉**，不能把缺省也一起精简 ✗（那会动到"没人认的调用方"）。
  //   ⭐⭐ 2026-10-16（补货那三处 · 她真机截图 + 逐字）⇒ `'replenish'` 也进精简档 ✓
  //     依据：她这次点的是**补货**（退货那次她已点过 ✓）—— 两边**同一个形状**、同一句依据 ✓。
  const trimmed = mode === 'return' || mode === 'replenish';
  // ⭐⭐ 2026-10-16（task-59 · **表单半**）：加/删货那一套**只在路由半接住那个 POST 时才开** ✓
  //   —— 接线位由路由半经 `buildWriteContext` 传进来（`write.multiItem`）；
  //   🔴 缺一个键就**不接线**（退回今天那颗链接）—— **宁可不给按钮，也不发一个没人接的动作** ✗。
  //   ⚠️ 与"精简档"是**两件事**（一个是删文案、一个是那颗入口是按钮还是链接）⇒ 各读各的位 ✓。
  const wire = (write && write.multiItem) || null;
  const addAction = String((wire && wire.addAction) || '');
  const addValue = String((wire && wire.addValue) || '');
  const removeField = String((wire && wire.removeField) || '');
  const wired = Boolean(addAction && addValue);
  const first = {
    product_record_id: view.product_record_id, number: view.number, item_no: view.item_no,
    color: view.color, supplier_record_id: view.supplier_record_id, entries: [],
  };
  const already = Array.isArray(view.multi_items) ? view.multi_items : [];
  const attr = (name, value) => (value === undefined || value === null || value === ''
    ? '' : ` ${name}="${escapeHtml(value)}"`);
  // 列表行：两种 mode **共用同一份拼法**（一处定义 ✓ 不各抄一份 ✗）
  //   ⭐ 表单半：每行多一颗**删除**按钮（`name` = 接线字段 · `value` = 该件 `product_record_id`）；
  //     接线关 ⇒ **一个字都不加**（既有判据原样绿 ✓）。
  const listRows = already.map((item) => {
    const rows = Array.isArray(item?.entries) ? item.entries.length : 0;
    const removeButton = removeField && item?.product_record_id
      ? `<button type="submit" class="btn btn--ghost" data-multi-remove name="${escapeHtml(removeField)}" value="${escapeHtml(String(item.product_record_id))}"${submitFeedbackAttrs(write)}>${escapeHtml(t.remove)}</button>`
      : '';
    return `<li class="multi-item-row">${escapeHtml(String(item?.number || item?.item_no || ''))}`
      + ` <span class="hint">${escapeHtml(fillText(t.rowsTemplate, { count: rows }))}</span>${removeButton}</li>`;
  }).join('');
  // 🔴 精简档（退货 / **补货**）：**空 ⇒ 整块（含 <ul>）不渲染** ✓；缺省档：**空 ⇒ 保留那句空态人话** ✓
  const listHtml = trimmed
    ? (already.length ? `<ul class="multi-item__list" data-view="multi-item-list">${listRows}</ul>` : '')
    : `<ul class="multi-item__list" data-view="multi-item-list">`
      + `${already.length ? listRows : `<li class="hint">${escapeHtml(t.empty)}</li>`}</ul>`;
  // 「再加一个货品」：
  //   · **接线关**（今天）⇒ 一颗指向本页的**链接**（`?add=1`）—— 既有判据 `Render:73` / `ReturnTrim:166`
  //     逐字钉着它，本刀**不动**它 ✓；
  //   · **接线开** ⇒ 改成**同一张表单里的第二颗 submit**：🔴 这是"她填的尺码/数量不丢"的**唯一**办法
  //     （GET 链接天生带不走表单字段 ✗ —— 只有 POST 会把她填的那些一起发出去 ✓）。
  const addHref = `${escapeHtml(write.postAction || '')}${String(write.postAction || '').includes('?') ? '&' : '?'}add=1`;
  const addEntry = wired
    ? `<button type="submit" class="btn btn--primary" data-multi-add name="${escapeHtml(addAction)}" value="${escapeHtml(addValue)}"${submitFeedbackAttrs(write)}>${escapeHtml(t.addButton)}</button>`
    : `<a class="btn btn--primary" data-multi-add href="${addHref}">${escapeHtml(t.addButton)}</a>`;
  // ⭐⭐ 隐藏字段：**首件 + 已加的每一件**（每件**带着它自己的 `entries`**）✓
  //   🔴 为什么要带上已加的：她点「＋ 再加一个货品」时，表单里**只有当前这一件**的尺码/数量控件
  //     ⇒ 已加那几件的数量**只能靠这个字段带走**（不然点一下"加"，前面加的就全丢 ✗）。
  //   🔴 为什么首件的 `entries` 仍是空：本次表单的尺码/数量由**路由在提交时合并进首件**
  //     （`mergeFirstItemEntries` 是**赋值**语义 ⇒ 只生效一次、**不会翻倍** ✓ —— 既有判据不放宽 ✗）。
  //   🔴🔴 **必须把"当前这一件"从已加列表里排掉**（改前逐字：`const payload = wired ? [first, ...already] : [first];`）
  //     —— 因为 `view.multi_items` 是**草稿里的全部 items**（`routes/scanPage.js` 的
  //     `readMultiItemPending` 只拿到 `(openId, chain)`，**它不知道"当前是哪一件"** ⇒ **排不掉** ✗；
  //     那段注释里写的"由路由半保证不含当前这一件"**当时并没有实现**）。
  //     ⇒ 不排的话，当前这件会在载荷里**出现两次**：首件（她刚填的）＋ 草稿那份**旧的**
  //       ⇒ 提交时 `addItem` 按顺序跑、**后写的赢** ⇒ 她刚填的尺码/数量被**静默覆盖成旧值** ✗✗
  //       （`test/multiItemCurrentItemDup.test.js` 用**真引擎**把这条证了一遍 ✓）；
  //       而且"同一个货品出现两次"还会让 `groups.length` 平白多 1（本该 N=1 的那一单被当成多货品 ✗）。
  //   ⚠️ **列表照旧画全部 `already`**（她刚加的那一件**必须看得见** ✓ —— 只排**载荷**、不排列表 ✗）。
  //   ⚠️ 身份取不到（空串）⇒ **一个都不排**：宁可让引擎按 `product_missing` 当场拒单，也别误删别人 ✗。
  //   ⚠️ 身份口径**与引擎 `productKeyOf` 同一条优先级**（`product_record_id` → `number` → `item_no`）✓。
  const keyOf = (item) => String(
    (item || {}).product_record_id || (item || {}).number || (item || {}).item_no || '',
  ).trim();
  const currentKey = keyOf(first);
  const others = currentKey ? already.filter((item) => keyOf(item) !== currentKey) : already;
  //   ⚠️ 接线关 ⇒ 逐字仍是 `[first]`（既有判据 AC-MIR1 读的就是它 ✓ 零迁移 ✓）。
  const payload = wired ? [first, ...others] : [first];
  // 🔴 说明那一段 + 标题：**精简档（退货 / 补货）不渲染**（她那句"不必要的文字提示"）✓
  //   ⚠️ 拼法上把"删掉的行"做成**整行**（不是行内空串）—— 空串留在模板里会多出空行，
  //     "删掉"就应该是**那一行不在**（也让她截图里不会看到一段莫名的空隙 ✓）。
  const lines = [];
  if (!trimmed) lines.push(`<p class="hint">${escapeHtml(t.hint)}</p>`);
  lines.push(addEntry);
  lines.push(`<input type="hidden" name="${escapeHtml(field)}" value="${escapeHtml(multiItemPayloadJson(payload))}">`);
  if (!trimmed) lines.push(`<h3 class="multi-item__title">${escapeHtml(t.title)}</h3>`);
  // ⭐⭐ 2026-10-16（task-61 · 「本单已加的货品」列表）。**列表 + 载荷**两处都从那同一份 `already` 来
  //   ⇒ 只报一次即可（列表上看得见的货品号 ✓ 与她眼睛看到的那一份逐字同源 ✓）。
  //   🔴 纯 additive：只在**真的渲染这个块**时才产生；一个判定都不动 ✗。
  if (Array.isArray(page.logs) && MULTI_ITEM_ORDER.enabled) {
    page.logs.push({
      event: (MULTI_ITEM_ORDER.logFields || {}).renderEvent || 'scan.multi_item.render',
      fields: MULTI_ITEM_ORDER.logFields || {},
      chain: String(mode || ''),
      count: already.length,
      itemNos: already.map((item) => String((item || {}).number || (item || {}).item_no || '')),
    });
  }
  if (listHtml) lines.push(listHtml);
  // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：这一块的**扫一扫上下文**（只在开关开、且路由喂了才出 ✓）。
  //   它**不是第二颗按钮**（那颗「＋ 再加一个货品」一个字都不动 ✗）—— 它只告诉
  //   `views/scanRealmScan.js` 那一段脚本："加货回来这一发，接着扫、并落回**这个领域**" ✓。
  const realmScanBlock = realmScanConfigHtml({
    // 🔴 2026-10-16 修复（Lead 亲自改 · CodeQL 规则 `js/incomplete-sanitization` 挡的正是下面这一处 ✓）
    //   改前逐字：`escapeHtml(JSON.stringify({ … }))`
    //     ⇒ `escapeHtml`（`:48`）只转 `& < > " '` ✗ —— **不处理反斜杠 `\`** ✗
    //       ⇒ CodeQL 判「This does not escape backslash characters in the input」⇒ **PR 的 CodeQL 红** ✗（本地绿、CI 红）
    //   改后逐字：先把 `<` 换成 `\u003c`（**JSON 里 `<` 只可能出现在字符串内** ✓ ⇒ 解析回原值 **行为不变** ✓），再过 escapeHtml
    //   依据：CodeQL 官方对这条规则的推荐修法（把危险字符换成 `\uXXXX` 序列 ⇒ 与反斜杠转义无冲突 ✓）
    //   ⭐ 不是放宽：转义**更完整**（原来漏了反斜杠场景 ✓）；且**只动这一处** ✓（`escapeHtml` 本身一个字不动 ✗ 全仓共用 ✓）
    configJson: (page.realmScan
      ? escapeHtml(JSON.stringify({
        realm: String(page.realmScan.realm || ''),
        // ⭐ 落点是**扫完那一刻现算**的（"扫到的是哪一件"服务端此刻不可能知道 ✗）——
        //   所以这里只给**参数**：领域键 / 记录路径段 / 本页来源 ＋ 认不出的上限 ✓
        origin: String(page.realmScan.origin || ''),
        realmQueryKey: String(page.realmScan.realmQueryKey || ''),
        recordBasePath: String(page.realmScan.recordBasePath || ''),
        maxScannedLength: Number(page.realmScan.maxScannedLength) || 0,
        signaturePath: String(page.realmScan.signaturePath || ''),
        reportPath: String(page.realmScan.reportPath || ''),
        sdkTimeoutMs: Number(page.realmScan.sdkTimeoutMs) || 0,
        scanTimeoutMs: Number(page.realmScan.scanTimeoutMs) || 0,
        texts: page.realmScan.texts || {},
      }).replace(/</g, '\\u003c'))
      : ''),
    scanNow: page.realmScan?.scanNow === true,
  });
  if (realmScanBlock) lines.push(realmScanBlock);
  return `<div class="card multi-item" data-view="multi-item"${attr('data-product-record-id', view.product_record_id)}${attr('data-product-number', view.number)}${attr('data-product-item-no', view.item_no)}${attr('data-product-color', view.color)}${attr('data-product-supplier-record-id', view.supplier_record_id)}>
${lines.join('\n')}
</div>`;
};


module.exports = {
  multiItemBlockHtml,
  multiItemPayloadJson,
  MULTI_ITEM_ITEM_KEYS,
  MULTI_ITEM_ENTRY_KEYS,
  purchaseAmountRowHtml,
};
