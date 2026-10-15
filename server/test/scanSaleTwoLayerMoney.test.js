// ⭐⭐ 2026-10-14（业务负责人逐字）：「只要本次付的金额小于累计的，那么差额都是未收款，
//   包括本次付款为 0」⇒ 本条断言从「不写」翻成「**恰写一条**」（判据没放宽 ✗ 依据见 PR 说明）
// ⭐⭐ 2026-10-14（她裁决 ①）：「销售货品页的**每件金额必须填**，只有资金页可以不填」
//   ⇒ 本文件里两处「提交时每件实收留空」的夹具，按新口径补上真实价格 399（改动仅夹具 ✓ 判据没放宽 ✗）
/** ⚠️ 2026-10-12 旧断言改写（"**零 JS**"口径按业务负责人的要求改了）：
 *  改前（逐字）：`assert.equal(/<script[\s>]/i.test(html), false, '页面里一行前端脚本都没有');`
 *  改后（逐字）：**有提交按钮的页面**（销售提交 / 打印这一款）= 整页**只有那一段**
 *    `<script data-view="submit-feedback">`（只做"置灰 + 换文案 + 计时"）；其余页面仍然 **0 段**。
 *  理由：她真机（逐字）「点完之后**没有 Toast、按键置灰**之类的提示……**我就会一直狂点**」
 *    ⇒ 她**明确要置灰**；"置灰"没有零 JS 的等价物 ⇒ 多了**唯一一段**内联 JS。
 *    ⚠️ 被保护的不变量收窄成：**只有这一段、只做这件事、不做网络/DOM 副作用**。
 */
/**
 * ⭐⭐ 销售建单**两层结构 + 整单「付款情况」三档**的验收标准
 * （业务负责人 **2026-10-11** 最终口径，**唯一权威**）。
 *
 * 她的最终口径（逐字要点）：
 * ```
 * ① 每件（子单/明细）维度：「实收金额」= 这一件实际收到多少 → 人填
 *    （这就是落到【销售明细.实收金额】的数）
 * ② 整单维度（资金区）：「付款情况」= 全付（默认）/ 部分付 / 未付 ← 整单的收款情况
 *    全付   ⇒ 收款合计 必须 == 每件实收合计 ⇒ 根据收款方式写收款明细
 *    部分付 ⇒ 只填写付的（资金区填实付多少）⇒ 根据收款方式写收款明细，
 *             差额在收款明细里写一条是未收款
 *    未付   ⇒ 不用填 ⇒ 差额在收款明细里写一条是未收款
 *    「只有全付时必须相等」「只跟"这个单子所有的实收金额加起来"比，不跟应收/单价相比」
 * ```
 *
 * ⚠️ 「**实收金额**」= **物理列名**（main 已同步：旧名「成交金额」在生产表里已不存在）；
 *    页面上 / 代码里都只有**这一个金额概念**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**；下面每条 test 的名字 = 这条 AC）
 *
 *  AC-1  **表单只有这两层**：页面上**没有**别的金额输入框；每件只填「实收金额」；
 *        资金区有**「付款情况」三档**（全付（默认）/ 部分付 / 未付）+「实付多少」；
 *        收款明细**预置 1 行**（方式 + 金额），第一行默认「微信」。
 *  AC-2  ⭐⭐ **每件实收金额 → 销售明细.「实收金额」**（业务负责人 2026-10-11 **方案甲**）：
 *        **填了 ⇒ 写她填的那个数**（> 0）；**没填 ⇒ 那一列就留空**（**不再读「单价」兜底**、
 *        也**不写 0**）—— 表里因此不出现"按单价顶上去的假数字"，她事后去工作台订单列表补。
 *  AC-3  **【全付】两边相等 ⇒ 成单**：`Σ每件实收 === Σ多笔收款` ⇒ 收款明细**如实写多笔、多方式**
 *        （500 = 微信 200 + 现金 300），**一条未收款都不写**。
 *  AC-4  **【全付】不等 ⇒ 拦住 + 一个字都不写 + 人话说清差额**（收款多了 / 少了两种）。
 *  AC-5  **【全付】的边界**：只填收款（AC-5b）/ 部分填了但合计不等（AC-5c）⇒ 拦住；
 *        ⭐ **只填每件实收、一笔收款都没填（AC-5a）⇒ 不拦**（默认档「未付」⇒ 只记货、进待补充）；
 *        显式选了「全付」却没填收款（AC-5a2）⇒ **不拦整单**，按未付落库 + 一句人话提示。
 *        （**没填的那一件计 0** —— 它不再被"单价"顶成 399。）
 *  AC-6  ⭐ **【未付】只记货**：不写任何收款明细（**包括不再自动写那条【未收款】**——
 *        2026-10-11 晚她真机被卡住之后改的；"还差多少"由读侧现算，见 AC-6b）。
 *  AC-7  ⭐ **【部分付】⇒ 已收的那几条（状态「已收款」）+ 差额一条【未收款】**：
 *        `已收款合计 == 她填的实付多少`；差额 = 每件实收合计 − 已收合计；
 *        「未收款」那一条**方式留空、不写交易方向**。
 *  AC-7x **【部分付】的校验**：实付多少没填 / 与收款行合计不一致 / 实付超过每件实收合计
 *        ⇒ 人话拦住、**一个字都不写**。
 *  AC-7y ⭐ **【未收款】那一条的真实字段形状**（照 `PaymentService.record` 的既有写入口径）：
 *        字段 = 「关联销售单」+「收款金额」+「收款状态」，**不含**「收款方式」/「收款时间」/「交易方向」；
 *        「收款状态」用**表里既有的取值**（`config/salesConfirmDeal.PAYMENT_STATUS_UNPAID`），**不新造选项**。
 *  AC-8  **校验的落点**：服务端是权威；页面上**原地**把差额说给她听
 *        （400 + 销售那一块 + 差额人话 + 她刚填的每件实收 / 付款情况 / 实付多少 / 收款行原样还在）。
 *  AC-9  **幂等不变**：拦住那一次**不轮换幂等键、不记账**；她改对后用**同一把键**再提交
 *        ⇒ 只写一次（连点两次仍然只写一次）。**未付 / 部分付 两档同样幂等**。
 *  AC-10 **现货"提交即交付 + 扣库存"照旧**：三档都不许改坏它。
 *  AC-11 **配置先行 + 无说明书**：行数 / 前缀 / 校验错误码 / 三档取值 / 文案全在
 *        `config/scanWrite.js`；页面上不出现说明句。
 *  AC-12 ⭐ **订单列表判据没被破坏**：「资金信息齐」= **有收款方式 + 至少一笔收款**
 *        ⇒ 「未付」的单（**一条收款都没有**）与「部分付」的单都**仍然**落在**待补充**。
 *
 * ⭐⭐ **2026-10-11 晚补充口径（业务负责人）：「建单门槛 = 只要「货品信息」齐」+「方案甲」** ——
 *    「**资金类（实收 / 收款）不拦**、可以全空」；「**全付必须相等**」这条
 *    **只在她填了资金时才生效**；**没填实收 ⇒ 那一列留空**（不读单价、不写 0）。
 *  AC-13 ⭐ **资金全空（默认「全付」）⇒ 成单**：明细那一列**留空**、
 *        **一条收款明细都不写**（资金状态 = 既有「已写入」⇒ 那张单进「待补充」）。
 *  AC-13b ⭐ 同上，但**走真路由**（销售页什么都不填 ⇒ 提交 200 + 结果页，不是 400 差额页）。
 *  AC-14 ⭐【未付】+ 差额 0（她什么都没填）⇒ **绝不写"金额 0"的【未收款】**、单照建成。
 *  AC-16 ⭐ **付款情况默认档 = 「未付」**（她不动它 ⇒ 建单放行、进待补充；
 *        改前默认「全付」正是她真机卡住的根因）。
 *  AC-15 ⭐ **方案甲的两条边界**：她**填了 0** ⇒ 照旧拦住（放宽只针对"缺省"）；
 *        货品**有单价也不许顶上去**（表里那一格是空，不是 399）；读侧遇空值安全
 *        （`salesProgressService` 现算：应收 / 待收为 null、收款状态为空、**不触发"已收 > 实收"红线**）。
 * ─────────────────────────────────────────────────────────────────────────
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/larkMvpService`（被复用的主表创建函数所在模块）在 require 阶段就要凭证。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_two_layer_test';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_two_layer_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE, PAYMENT_STATUS } = require('../src/config/scanWrite');
const { PAYMENT_STATUS_UNPAID } = require('../src/config/salesConfirmDeal');
const { createScanWriteService } = require('../src/services/scanWriteService');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { SalesDeliveryService } = require('../src/services/salesDeliveryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanPageRouter, parsePaymentRows } = require('../src/routes/scanPage');
const { renderScanPage, buildPaymentRows } = require('../src/views/scanPageRenderer');

const SERVER_SRC = path.join(__dirname, '..', 'src');
const WORKBENCH = path.join(__dirname, '..', 'public', 'workbench');
const NUMBER = 'YD6693-2|黑色|A';

// ── 夹具（照测试 Base 的真实列形状）────────────────────────────────────────
const PRODUCT = {
  record_id: 'prod_1',
  fields: {
    编号: NUMBER, 货号: 'YD6693-2', 颜色: { text: '黑色', record_ids: ['color_black'] },
    类别: 'A', 品类: { text: '休闲鞋', record_ids: ['cat_casual'] }, 单价: 399, 供应商: ['sup_1'],
  },
};
/** 这一款**没有单价**（AC-2 用它：留空又取不到 ⇒ 拦住，绝不写 0）。 */
const PRODUCT_NO_PRICE = {
  record_id: 'prod_2',
  fields: { 编号: 'YD1111|白色|A', 货号: 'YD1111', 颜色: { text: '白色' }, 类别: 'A', 单价: null, 供应商: ['sup_1'] },
};
/** 「其他配品」：`15元鞋油` 有单价 15；`赠品鞋垫` 没有单价。 */
const ACCESSORIES = [
  { record_id: 'acc_oil', fields: { 名称: '15元鞋油', 种类: '鞋油', 单价: 15 } },
  { record_id: 'acc_insole', fields: { 名称: '赠品鞋垫', 种类: '鞋垫' } },
];
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
/** 40 有一双门盒（现货）；41 / 42 没有（预订）。 */
const liveUnit = (id, size) => ({
  record_id: id, fields: { 编号: ['prod_1'], 尺码: [`size_${size}`], 所属状态: '门盒' },
});

const seedTables = (overrides = {}) => ({
  product: [PRODUCT, PRODUCT_NO_PRICE],
  accessory: ACCESSORIES,
  sizeManagement: SIZE_RECORDS,
  liveInventory: [liveUnit('live_40_box', 40)],
  inventoryLedger: [],
  behavior: [
    { record_id: 'bh_cash', fields: { 行为名称: '现货', 行为编码: 'SALE_CASH' } },
    { record_id: 'bh_prepaid', fields: { 行为名称: '预定', 行为编码: 'SALE_PREPAID' } },
  ],
  paymentMethod: [
    { record_id: 'pm_wechat', fields: { 收款方式: '微信' } },
    { record_id: 'pm_cash', fields: { 收款方式: '现金' } },
  ],
  salesEntry: [],
  salesDetail: [],
  paymentRecord: [],
  ...overrides,
});

const createFakeGateway = (tables = seedTables()) => {
  const writes = [];
  let sequence = 0;
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  return {
    writes,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => [...(tables[key] || [])],
    listByFilter: async () => { throw new Error('fake gateway 不支持 filter'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key].fields[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find((record) => String(record.fields?.[name] ?? '').trim() === target) || null;
    },
    create: async (key, values) => {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      writes.push({ op: 'create', table: key, record_id: record.record_id, fields });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      writes.push({ op: 'update', table: key, record_id: id, fields });
      return record;
    },
    delete: async () => { throw new Error('测试网关：扫码侧不许删记录'); },
  };
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `scan-two-layer-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的链路：真 service + 真业务层（SalesOrderService / SalesDeliveryService），
 * 只有飞书那一层是内存替身；库存引擎只记账（AC-10 只验"交付那一步被调了"）。
 */
const createHarness = (options = {}) => {
  const gateway = options.gateway || createFakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const taskDir = tempDir('task');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const stockCalls = [];
  const delivery = new SalesDeliveryService({
    gateway,
    inventory: {
      applySale: async (input) => { stockCalls.push(input); return { sampleConsumedQuantity: 0 }; },
      getSaleResult: async () => null,
    },
  });
  const write = createScanWriteService({
    gateway, sessions, delivery, now: options.now,
    purchase: {}, purchaseStore: new JsonTaskStore({ dir: taskDir, idField: 'task_id' }),
  });
  // ⭐⭐ 2026-10-15（⑨b-2）：开关默认翻成 `true` 之后，`submitSale` 变成"**单号先出、余下转后台**"——
  //   ⇒ 用例要**先等后台那一跑跑完**再回读端状态（不然读到的是"还没写完"的那一刻 ✗）。
  //   ⭐ 在这里**包一层** ⇒ 本文件**所有** `write.submitSale(...)` 调用点**一个字都不用动** ✓
  //   （改前逐字：`write` 直接用服务实例；改后逐字：包成"等后台 + 把它那半结果合回来" ✓）
  //   依据：她 2026-10-15「**单号一出立刻回**…明细/库存/交付转后台」⇒ 端状态在后台跑完才齐 ✓
  //   🔴 **判据没放宽**：仍是"端状态逐字比"，只是**先等它跑完** ✓（不是我替它放宽 ✗）
  const rawSubmitSale = write.submitSale;
  write.submitSale = async (input) => {
    const result = await rawSubmitSale(input);
    if (!result?.background) return result;
    const rest = await result.background;
    const defined = Object.fromEntries(
      Object.entries(rest || {}).filter(([, value]) => value !== undefined),
    );
    return { ...result, ...defined };
  };
  return {
    gateway, sessions, write, stockCalls, tables: gateway._tables,
    cleanup: () => { rmDir(sessionDir); rmDir(taskDir); },
  };
};

const entriesOf = (h, tableKey) => h.tables[tableKey] || [];
const currentKey = async (h, openId) => (await h.sessions.get(openId)).sale.key;
const addShoe = (h, openId, overrides = {}) => h.write.addSaleLine({
  openId, requestId: 'req_add', productRecordId: 'prod_1', number: NUMBER, itemNo: 'YD6693-2',
  color: '黑色', size: 40, inStock: true, ...overrides,
});
const addAccessory = (h, openId, overrides = {}) => h.write.addSaleLine({
  openId, requestId: 'req_add', kind: 'accessory', accessoryRecordId: 'acc_oil', ...overrides,
});
const methodField = () => V1_BITABLE_SCHEMA.tables.paymentRecord.fields.method;
const statusField = () => V1_BITABLE_SCHEMA.tables.paymentRecord.fields.status;
const MONEY = SCAN_WRITE.sale.moneyPrefix;
/** 收款明细里那一条【未收款】（方式留空的那条）；`收款状态` 的取值本身就是中文语义值。 */
const unpaidRows = (h) => entriesOf(h, 'paymentRecord').filter((row) => row.fields[statusField()] === PAYMENT_STATUS_UNPAID);
const paidRows = (h) => entriesOf(h, 'paymentRecord').filter((row) => row.fields[statusField()] === '已收款');

// ═══════════════════════════════════════════════════════════════════════════
// AC-1 表单只有两层 + 付款情况三档 + 收款行预置 1 行
// ═══════════════════════════════════════════════════════════════════════════

const VIEW = {
  found: true, number: NUMBER, item_no: 'YD6693-2', color: '黑色',
  category_name: '休闲鞋', category_code: 'A', price_text: '¥399', total: 2,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 1 }], total: 1, missing: false },
    { size_text: '41', cells: [{ count: 0 }], total: 0, missing: true },
  ],
  missing_count: 1, sizes_degraded: false, notes: [], updated_at_text: '2026-10-11 10:00',
  product_record_id: 'prod_1',
};
const WRITE = (overrides = {}) => ({
  enabled: true, saleEnabled: true, replenishEnabled: true,
  texts: SCAN_WRITE.texts, fields: SCAN_WRITE.fields, actions: SCAN_WRITE.actions,
  postAction: `/s/${encodeURIComponent(NUMBER)}`,
  sizes: [{ size_text: '40', missing: false }, { size_text: '41', missing: true }],
  draft: { lines: [] },
  saleKey: 'scan_sale:scan_session_x:1',
  replenishKey: 'scan_replenish:scan_session_x:1',
  paymentMethods: SCAN_WRITE.sale.paymentMethods,
  defaultPaymentMethod: SCAN_WRITE.sale.defaultPaymentMethod,
  paymentRowCount: SCAN_WRITE.sale.paymentRowCount,
  paymentStatus: SCAN_WRITE.sale.paymentStatus.default,
  defaultPaymentStatus: SCAN_WRITE.sale.paymentStatus.default,
  paidAmount: '',
  accessories: [{ record_id: 'acc_oil', name: '15元鞋油' }],
  notice: '',
  ...overrides,
});

const scriptCountOf = (html) => (html.match(/<script[\s>]/gi) || []).length;

test('AC-1 销售页只有两层：每件填「实收金额」；资金区有「付款情况」三档；收款行预置 1 行', () => {
  const write0 = WRITE();
  const html = renderScanPage(VIEW, SCAN_PAGE, write0, 'sales');
  // ① 页面上**没有**第二个金额概念（旧名整体退场）
  assert.equal(html.includes('成交金额'), false, '「成交金额」整体退场（鞋与配品都不许再让用户填）');
  // ② 每件层：鞋表单 + 配品表单各有一个「实收金额」输入框
  assert.ok(html.includes(SCAN_WRITE.texts.amountLabel), `鞋那一行要有「${SCAN_WRITE.texts.amountLabel}」`);
  // ⚠️ 2026-10-13 **改写**（能力退场）：原来这里断言"配品那一行要有配品实收金额"——
  //    她的口径是「扫码页里的**配品逻辑拿掉**」（配品改到工作台）⇒ 那一块整块退场
  //    ⇒ 改成断言**页面上不再有**它（能力仍在服务层 ✓ 见 AC-B6）
  assert.equal(html.includes(SCAN_WRITE.texts.accessoryAmountLabel), false,
    '配品实收金额不再出现在扫码页（能力改到工作台 ✓）');
  assert.ok(html.includes(`name="${SCAN_WRITE.fields.amount}"`), '加单表单里的金额位就是「实收金额」');
  // ③④ ⭐⭐ 2026-10-13 **改指向**（她定的「金额两步走」）：整单那一组（付款情况三档 / 实付多少 /
  //    收款行）**从录入页整块挪到第 2 步的「整单付款」屏** ⇒ 能力去哪：`renderSalePaymentStepPage`
  //    （**不是删掉、也不是放宽** —— 下面每一条断言都还在，只是换了它该在的那一页 ✓）。
  assert.equal(html.includes(`name="${SCAN_WRITE.fields.paymentStatus}"`), false,
    '录入页（第 1 步）不许再有整单付款控件（AC-2S1 同口径）');
  const { renderSalePaymentStepPage } = require('../src/views/scanPageRenderer');
  const stepHtml = renderSalePaymentStepPage({ write: write0, config: SCAN_PAGE });
  assert.match(stepHtml, new RegExp(`name="${SCAN_WRITE.fields.paymentStatus}"`), '第 2 步要有「付款情况」这个控件');
  assert.ok(stepHtml.includes(SCAN_WRITE.texts.paymentStatusLabel), '组名来自配置');
  for (const option of SCAN_WRITE.texts.paymentStatusOptions) {
    assert.ok(stepHtml.includes(`value="${option.value}"`), `三档里少了「${option.value}」`);
  }
  // ⚠️ 默认档「未付」的契约**原样保留**（她真机被"全付必须相等"卡住过）
  assert.match(stepHtml, new RegExp(`value="${PAYMENT_STATUS.unpaid}" checked`), '默认选中「未付」');
  assert.match(stepHtml, new RegExp(`name="${SCAN_WRITE.fields.paidAmount}"`), '要有「实付多少」输入框');
  const methods = stepHtml.match(new RegExp(`name="${SCAN_WRITE.fields.paymentMethod}"`, 'g')) || [];
  const amounts = stepHtml.match(new RegExp(`name="${SCAN_WRITE.fields.paymentAmount}"`, 'g')) || [];
  assert.equal(methods.length, SCAN_WRITE.sale.paymentRowCount, '收款行数 = 配置的预置行数');
  assert.equal(SCAN_WRITE.sale.paymentRowCount, 1, '她 2026-10-11：**收款行预置 1 行**');
  assert.equal(amounts.length, SCAN_WRITE.sale.paymentRowCount);
  assert.ok(stepHtml.includes('<option value="微信" selected>微信</option>'), '第一行默认选中「微信」');
  // ⭐ 出错要改时，那一组**回到录入页**（她填的值原样在 ⇒ 能原地改，不用重打）
  const withError = WRITE({ errorText: '每件实收合计 ¥500，收款合计 ¥200；收款比每件实收少 ¥300' });
  const errorHtml = renderScanPage(VIEW, SCAN_PAGE, withError, 'sales');
  assert.match(errorHtml, new RegExp(`name="${SCAN_WRITE.fields.paymentStatus}"`),
    '校验失败原地重渲染时，整单那一组要带回来（否则她改不了）');
  // ⑤ 提交表单里**逐行**一个「每件实收」（同名重复 ⇒ POST 上来是有序数组）
  const withLines = WRITE({ draft: { lines: [{ item_no: 'YD6693-2', size: 40, amount: 350 }] } });
  const lineHtml = renderScanPage(VIEW, SCAN_PAGE, withLines, 'sales');
  assert.equal((lineHtml.match(new RegExp(`name="${SCAN_WRITE.fields.lineAmount}"`, 'g')) || []).length, 1);
  assert.match(lineHtml, /value="350"/, '她填过的每件实收要回填出来（提交前能核对）');
  // ⑥ ≥44px 命中区（她 2026-10-11 的硬要求）：新控件都吃 `--control-height`
  const { STYLE } = require('../src/views/scanPageRenderer');
  assert.match(STYLE, /\.draft-line__amount\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
  assert.match(STYLE, /\.pay-status__option\s*\{[^}]*min-height:\s*var\(--control-height\)/s);
  assert.match(STYLE, /\.form-row--pay/);
  // ⑦ 零 JS 的底线不许破（2026-10-09 白屏事故之后的既有约束）
  // ⭐ 2026-10-12：销售页只允许那一段提交反馈脚本
  assert.equal(scriptCountOf(html), 1, '销售页只该有那一段提交反馈脚本');
  assert.equal(/on(click|load|submit)\s*=/i.test(html), false, '不许有内联事件');
});

test('AC-1b 收款行的预置规则（配置先行）：预置 1 行、第一行默认微信；回填时不替她选', () => {
  assert.equal(SCAN_WRITE.sale.paymentRowCount, 1, '预置行数可配（SCAN_SALE_PAYMENT_ROWS），默认 1');
  assert.deepEqual(buildPaymentRows({ count: 1, defaultMethod: '微信' }), [{ method: '微信', amount: '' }]);
  assert.deepEqual(buildPaymentRows({ count: 2, defaultMethod: '微信' }), [
    { method: '微信', amount: '' }, { method: '', amount: '' },
  ]);
  assert.deepEqual(
    buildPaymentRows({ count: 3, defaultMethod: '微信', rows: [{ method: '现金', amount: '300' }] }),
    [{ method: '现金', amount: '300' }, { method: '', amount: '' }, { method: '', amount: '' }],
    '校验失败回填：她填的那一行原样带回来，补齐的行**不注入默认方式**',
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-2 每件实收金额 → 销售明细.「实收金额」（留空 ⇒ 读单价；取不到 ⇒ 人话拦住）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-2a 每件实收 = 销售明细「实收金额」的落点：**填了就写她填的那个数**（鞋 / 配品同规则）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_amount';
    await addShoe(h, openId, { size: 40, amount: 350 });       // 她填了实收 → 350（不是单价 399）
    await addAccessory(h, openId, { amount: 12 });             // 配品填了实收 → 12（不是单价 15）
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 362 }],             // 350 + 12 = 362
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const details = entriesOf(h, 'salesDetail');
    const shoe = details.find((row) => !row.fields[accessoryField]);
    const accessory = details.find((row) => row.fields[accessoryField]);
    assert.equal(shoe.fields['实收金额'], 350, '她填的实收就是「销售明细.实收金额」');
    assert.equal(accessory.fields['实收金额'], 12, '配品行同一条规则（与鞋一致）');
  } finally { h.cleanup(); }
});

test('AC-2b ⭐ 方案甲：**没填 ⇒ 那一列留空**（不再读「单价」、更不写 0）—— 连"货品没有单价"也照样能建单', async () => {
  const h = createHarness();
  try {
    // 鞋：这一款**没有单价**（`PRODUCT_NO_PRICE`）；她一分钱都没填
    const openId = 'ou_two_layer_nomoney';
    await addShoe(h, openId, { productRecordId: 'prod_2', number: 'YD1111|白色|A', itemNo: 'YD1111', size: 40, amount: '' });
    const ok = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId) });
    assert.equal(ok.ok, true, `没填实收不该拦住建单：${JSON.stringify(ok)}`);
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '主表建出来了');
    const shoe = entriesOf(h, 'salesDetail')[0];
    assert.equal('实收金额' in shoe.fields, false, '她没填 ⇒ **这一列不写**（既不拿单价顶、也不写 0）');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '一笔收款都不写');

    // 配品：这一件也没有单价
    const openId2 = 'ou_two_layer_nomoney_acc';
    await addAccessory(h, openId2, { accessoryRecordId: 'acc_insole', amount: '' });
    const ok2 = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2) });
    assert.equal(ok2.ok, true, JSON.stringify(ok2));
    const accessoryField = V1_BITABLE_SCHEMA.tables.salesDetail.fields.accessory;
    const acc = entriesOf(h, 'salesDetail').find((row) => row.fields[accessoryField]);
    assert.equal('实收金额' in acc.fields, false, '配品行同规则：没填 ⇒ 那一列留空');
  } finally { h.cleanup(); }
});

test('AC-2c 取不到单价、但她在本单里补填了实收 ⇒ 用她填的（不必去改货品表）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_fill_missing';
    await addShoe(h, openId, { productRecordId: 'prod_2', number: 'YD1111|白色|A', itemNo: 'YD1111', size: 40, amount: '' });
    const key = await currentKey(h, openId);
    // 提交表单里那一排「每件实收」= 她当场补填的 260
    const ok = await h.write.submitSale({
      openId, submitKey: key, lineAmounts: ['260'], payments: [{ method: '现金', amount: 260 }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(entriesOf(h, 'salesDetail')[0].fields['实收金额'], 260);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-3 【全付】两边相等 ⇒ 成单 + 多笔多方式如实写收款明细
// ═══════════════════════════════════════════════════════════════════════════

test('AC-3 【全付】Σ每件实收 === Σ多笔收款 ⇒ 成单；收款明细如实写多笔、多方式（500 = 微信 200 + 现金 300）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_equal';
    await addShoe(h, openId, { size: 40, amount: 200 });
    await addShoe(h, openId, { size: 41, amount: 300 });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: '200' }, { method: '现金', amount: '300' }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.detail_count, 2, '一单一双一行');
    assert.equal(ok.payment_count, 2, '两笔收款 → 两条「收款明细」');
    const paymentField = methodField();
    const rows = entriesOf(h, 'paymentRecord');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => [row.fields[paymentField][0], row.fields['收款金额']]),
      [['pm_wechat', 200], ['pm_cash', 300]], '方式按她说的写（微信 200 + 现金 300）');
    assert.equal(rows[0].fields['收款状态'], '已收款');
    for (const row of rows) assert.ok(row.fields['收款日'], '收款时间照旧写（既有口径）');
    assert.equal(unpaidRows(h).length, 0, '全付：**一条未收款都不写**');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-4 【全付】不等 ⇒ 拦住 + 一个字都不写 + 说清差额
// ═══════════════════════════════════════════════════════════════════════════

test('AC-4a 【全付】收款比每件实收**多** ⇒ 拦住（一个字都不写）+ 人话说清差多少', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_over';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: 400 }],
    });
    assert.equal(result.ok, false, '不等必须拦住');
    assert.equal(result.code, 'amount_mismatch');
    assert.match(result.message, new RegExp(`每件实收合计 ${MONEY}350`), '人话要给两边的合计');
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}400`));
    assert.match(result.message, new RegExp(`收款比每件实收多 ${MONEY}50`), '说清哪边多了、差多少');
    // 🔴 **一个字都不写**（钱货都不动）
    assert.equal(entriesOf(h, 'salesEntry').length, 0, '主表不建');
    assert.equal(entriesOf(h, 'salesDetail').length, 0, '明细不写');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '收款明细不写');
    // 幂等键还在（同一把键可以重试）—— AC-9 细验
    assert.equal((await h.sessions.get(openId)).sale.key, await currentKey(h, openId));
  } finally { h.cleanup(); }
});

test('AC-4b 【全付】收款比每件实收**少** ⇒ 拦住（一个字都不写）+ 人话说清差多少', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_short';
    await addShoe(h, openId, { size: 40, amount: 350 });
    await addShoe(h, openId, { size: 41, amount: 349 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: 500 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'amount_mismatch');
    assert.match(result.message, new RegExp(`每件实收合计 ${MONEY}699`));
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}500`));
    assert.match(result.message, new RegExp(`收款比每件实收少 ${MONEY}199`));
    assert.equal(entriesOf(h, 'salesEntry').length + entriesOf(h, 'salesDetail').length
      + entriesOf(h, 'paymentRecord').length, 0, '一个字都不写');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-5 【全付】的边界：只填一边 / 部分填了但不等
// ═══════════════════════════════════════════════════════════════════════════

test('AC-5a ⭐ 只填了每件实收、收款一行都没填 ⇒ **不拦**（默认档「未付」⇒ 按未付落库、进待补充）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_items_only';
    await addShoe(h, openId, { size: 40, amount: 350 });
    // ⚠️ 2026-10-11 晚**改写**（她真机卡住的那一步，线上日志
    //    `scan.sale.amount_mismatch payment_status="全付" items_cents=9900 payments_cents=0`）：
    //    改前：默认档「全付」+ 她填了实收 ⇒ 按"全付必须相等"拦住；
    //    改后：默认档 = **未付** ⇒ 只记货、钱待补充 ⇒ **放行**。
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId) });
    assert.equal(result.ok, true, `只填实收也必须能提交：${JSON.stringify(result)}`);
    assert.equal(result.code, undefined, '不是任何失败码');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '单子建出来了');
    assert.equal(entriesOf(h, 'salesDetail')[0].fields['实收金额'], 350, '实收照旧落表');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '未付 ⇒ 差额>0 ⇒ **恰写一条**【未收款】（含本次付款为 0）');
    // 改前逐字：`assert.equal(result.owed_amount, 0)`（她 2026-10-11 老口径：未付不记欠款）
    // 改后逐字：`350`（= 累计 350 − 本次已收 0）· 依据 = 她 2026-10-14
    //   「**只要本次付的金额小于累计的，那么差额都是未收款，包括本次付款为 0**」· 单位 = 元
    assert.equal(result.owed_amount, 350, '欠款 = 累计 − 本次已收 = 350');
  } finally { h.cleanup(); }
});

test('AC-5a2 ⭐ 显式选「全付」但收款一行没填 ⇒ **不拦整单**（按未付落库）+ 一句人话提示', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_full_no_rows';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
    });
    assert.equal(result.ok, true, `选全付但没填收款也不该拦整单：${JSON.stringify(result)}`);
    assert.equal(result.full_without_payments, true, '如实告诉页面"全付但没填收款"（页面据此给她一句人话）');
    assert.match(SCAN_WRITE.texts.fullWithoutPaymentsNote, /全付/);
    assert.match(SCAN_WRITE.texts.fullWithoutPaymentsNote, /未付/, '提示要指得出"钱还没收就选未付"');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '单子照建（按未付落库）');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '差额>0 ⇒ **恰写一条**【未收款】');
  } finally { h.cleanup(); }
});

test('AC-16 ⭐ 付款情况**默认档 = 未付**（她不动它 ⇒ 建单放行、进待补充）', async () => {
  // 配置先行：默认档在 config 里，页面 / 服务端都从这一处取
  assert.equal(SCAN_WRITE.sale.paymentStatus.default, PAYMENT_STATUS.unpaid,
    '扫码建单时钱通常还没收 ⇒ 默认档必须是「未付」（改前是「全付」，正是她被卡住的根因）');
  assert.deepEqual([...SCAN_WRITE.sale.paymentStatus.values],
    [PAYMENT_STATUS.full, PAYMENT_STATUS.partial, PAYMENT_STATUS.unpaid], '三档取值不变');
  // 服务端：**不传** paymentStatus（= 她没动过那个单选框）⇒ 按未付走
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_default_unpaid';
    await addShoe(h, openId, { size: 40, amount: 99 });
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), lineAmounts: ['99'] });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(entriesOf(h, 'salesEntry').length, 1);
    // 改前逐字：`assert.equal(entriesOf(h, 'paymentRecord').length, 0)`
    //   （她 2026-10-11 老口径「未付 ⇒ 不替她记【未收款】」）
    // 改后逐字：`1` ＋ 金额逐字 99（= 累计 99 − 本次已收 0）· 依据 = 她 2026-10-14 裁决②
    const owedRows = entriesOf(h, 'paymentRecord');
    assert.equal(owedRows.length, 1, '差额>0 ⇒ **恰写一条**【未收款】（含本次付款为 0）');
    assert.equal(owedRows[0].fields['收款金额'], 99, '那一条的金额 = 差额 99');
    assert.equal(owedRows[0].fields['收款状态'], '未收款', '状态逐字「未收款」');
  } finally { h.cleanup(); }
});

test('AC-5b 【全付】只填了收款、每件实收全空 ⇒ 拦住（说清两边合计）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_pay_only';
    await addShoe(h, openId, { size: 40, amount: '' });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: 500 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'amount_mismatch');
    // ⚠️ 2026-10-11（方案甲）改写：留空的每件实收**不再按「单价」定稿** ⇒ 合计是 **¥0**
    //    （改前：`每件实收合计 ¥399` / `收款比每件实收多 ¥101`；现在 0 / 多 ¥500）。
    assert.match(result.message, new RegExp(`每件实收合计 ${MONEY}0`));
    assert.match(result.message, new RegExp(`收款合计 ${MONEY}500`));
    assert.match(result.message, new RegExp(`收款比每件实收多 ${MONEY}500`));
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

test('AC-5c 【全付】部分填了但合计不等 ⇒ 拦住；两边相等才放行', async () => {
  const h = createHarness();
  try {
    // ① 两双：只填了第一双（350），第二双留空（**那一列留空 ⇒ 计 0**）⇒ 合计 350，收款 500 ⇒ 拦住
    const openId = 'ou_two_layer_partial';
    await addShoe(h, openId, { size: 40, amount: 350 });
    await addShoe(h, openId, { size: 41, amount: '' });   // 第二双没填 ⇒ 不参与合计
    const blocked = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: 500 }],
    });
    assert.equal(blocked.ok, false, '两边合计对不上（500 ≠ 350 + 0）');
    assert.equal(blocked.code, 'amount_mismatch');
    // ⚠️ 2026-10-11（方案甲）改写：改前是 ¥749（第二双按单价 399 顶上去）⇒ 少 ¥249；
    //    现在那一列留空、计 0 ⇒ 合计 ¥350、收款**多了** ¥150。
    assert.match(blocked.message, new RegExp(`每件实收合计 ${MONEY}350`));
    assert.match(blocked.message, new RegExp(`收款比每件实收多 ${MONEY}150`));
    assert.equal(entriesOf(h, 'salesEntry').length, 0);

    // ② 两双各自的实收都填了、合计 750，收款也 750 ⇒ 放行（**这才是"合计相等"**）
    const openId2 = 'ou_two_layer_partial_equal';
    await addShoe(h, openId2, { size: 40, amount: 350 });
    await addShoe(h, openId2, { size: 41, amount: 400 });
    const ok = await h.write.submitSale({
      openId: openId2, submitKey: await currentKey(h, openId2), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: 750 }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const amounts = entriesOf(h, 'salesDetail').map((row) => row.fields['实收金额']);
    assert.deepEqual(amounts, [350, 400], '两件各自的实收如实落表');
    assert.equal(unpaidRows(h).length, 0, '全付：不写未收款');
  } finally { h.cleanup(); }
});

test('AC-5d 小数也按**分**比：0.1 + 0.2 不误报（浮点误差不算数）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_decimal';
    await addShoe(h, openId, { size: 40, amount: '0.1' });
    await addShoe(h, openId, { size: 41, amount: '0.2' });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: '0.3' }],
    });
    assert.equal(ok.ok, true, `0.1 + 0.2 === 0.3 不该被浮点误差拦下：${JSON.stringify(ok)}`);
    assert.equal(entriesOf(h, 'paymentRecord').length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-6 ⭐【未付】⇒ 一条【未收款】（金额 = 每件实收合计）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-6 ⭐【未付】什么都不填 ⇒ 成单 + **一条【未收款】都不写**（差额 0 写它没意义）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_unpaid';
    await addShoe(h, openId, { size: 40, amount: '' });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(ok.ok, true, `未付也要能提交：${JSON.stringify(ok)}`);
    // ⚠️ 2026-10-11（方案甲）**改写**：改前"留空按单价定稿 399 ⇒ 写一条 399 的【未收款】"；
    //    现在**没填就留空** ⇒ 每件实收合计 = 0 ⇒ 差额 0 ⇒ **不写【未收款】**（她 2 的③）。
    assert.equal('实收金额' in entriesOf(h, 'salesDetail')[0].fields, false, '没填 ⇒ 那一列留空');
    assert.equal(unpaidRows(h).length, 0, '差额 0 ⇒ **一条【未收款】都不写**');
    assert.equal(paidRows(h).length, 0, '一笔已收款都没有');
    assert.equal(ok.owed_amount, 0, '差额如实回给页面（0）');
    // 单子本身照旧：销售状态 / 资金状态都是既有业务层写的
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['销售状态'], '已写入');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['资金状态'], '已写入');
  } finally { h.cleanup(); }
});

test('AC-6b ⭐ 2026-10-14 改写：「未付」（本次付 0）**照写那条【未收款】**（差额 = 累计）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_unpaid_filled';
    await addShoe(h, openId, { size: 40, amount: 399 });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    // 改前逐字（她 2026-10-11 老口径，本条当时逐字这么写）：
    //   「改后 **不写** —— 只有她**明说欠多少**（部分付的差额）才写那一条」
    //   ＋ `assert.equal(ok.owed_amount, 0)`、`unpaidRows(h).length === 0`
    // 改后逐字（她 2026-10-14 最新权威 · 覆盖 10-11 那句）：
    //   「**只要本次付的金额小于累计的，那么差额都是未收款，包括本次付款为 0**」
    //   ⇒ 本次付 0 < 累计 399 ⇒ **恰写一条**【未收款】，金额 = 差额 399；`owed_amount` = 399
    assert.equal(unpaidRows(h).length, 1, '未付 ⇒ **差额自动生成一条**【未收款】');
    assert.equal(ok.owed_amount, 399, '差额如实回给页面 = 累计 399 − 本次已收 0');
    // 这一单还没收钱 —— 那条【未收款】落表之后，读侧算出来的仍然是同一个数
    const { SalesProgressService } = require('../src/services/salesProgressService');
    const progress = await new SalesProgressService({ gateway: h.gateway })
      .forOrder(ok.sales_entry_record_id);
    assert.equal(progress.paymentStatus, '未收款', '读侧现算仍然是"未收款"');
    assert.equal(progress.pendingAmount, 399, '"还差多少"也照旧算得出来');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-7 ⭐【部分付】⇒ 已收的那几条 + 差额一条【未收款】
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7a 【部分付】只写付了的那几条（已收款）+ 差额一条【未收款】（方式留空）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_partial_pay';
    await addShoe(h, openId, { size: 40, amount: 200 });
    await addShoe(h, openId, { size: 41, amount: 300 });   // 每件实收合计 = 500
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.partial,
      paidAmount: '200',
      payments: [{ method: '微信', amount: '200' }],       // 已收 200 ⇒ 差额 300
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.paid_amount, 200);
    assert.equal(ok.owed_amount, 300, '差额 = 每件实收合计 − 已收合计');
    assert.equal(ok.payment_count, 2, '已收 1 条 + 未收款 1 条');
    const paid = paidRows(h);
    assert.equal(paid.length, 1);
    assert.deepEqual(paid[0].fields[methodField()], ['pm_wechat'], '已收的那条按收款方式写');
    assert.equal(paid[0].fields['收款金额'], 200);
    assert.ok(paid[0].fields['收款日'], '已收款照旧有收款时间');
    const unpaid = unpaidRows(h);
    assert.equal(unpaid.length, 1);
    assert.equal(unpaid[0].fields['收款金额'], 300, '差额写在【未收款】那一条上');
    assert.equal(unpaid[0].fields[methodField()], undefined, '未收款**没有方式**');
  } finally { h.cleanup(); }
});

test('AC-7b 【部分付】多方式已收（微信 200 + 现金 100）+ 差额 200 一条未收款', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_partial_multi';
    await addShoe(h, openId, { size: 40, amount: 300 });
    await addShoe(h, openId, { size: 41, amount: 200 });   // 合计 500
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.partial,
      paidAmount: '300',
      payments: [{ method: '微信', amount: '200' }, { method: '现金', amount: '100' }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const paymentField = methodField();
    assert.deepEqual(paidRows(h).map((row) => [row.fields[paymentField][0], row.fields['收款金额']]),
      [['pm_wechat', 200], ['pm_cash', 100]], '付了的每条按方式各写一行');
    assert.deepEqual(unpaidRows(h).map((row) => row.fields['收款金额']), [200]);
  } finally { h.cleanup(); }
});

test('AC-7x 【部分付】实付没填 / 与收款行不一致 / 超过每件实收 ⇒ 人话拦住、一个字都不写', async () => {
  const h = createHarness();
  try {
    // ① 没填实付多少（收款行也没填）⇒ 人话拦住
    const openId = 'ou_two_layer_partial_missing';
    await addShoe(h, openId, { size: 40, amount: 500 });
    const missing = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.partial,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'partial_amount_missing');
    assert.match(missing.message, /实付/);
    assert.equal(entriesOf(h, 'salesEntry').length, 0);

    // ② 实付多少 ≠ 收款行合计
    const openId2 = 'ou_two_layer_partial_mismatch';
    await addShoe(h, openId2, { size: 40, amount: 500 });
    const mismatch = await h.write.submitSale({
      openId: openId2, submitKey: await currentKey(h, openId2), paymentStatus: PAYMENT_STATUS.partial,
      paidAmount: '300', payments: [{ method: '微信', amount: '200' }],
    });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.code, 'partial_amount_mismatch');
    assert.match(mismatch.message, new RegExp(`实付填的是 ${MONEY}300`));
    assert.match(mismatch.message, new RegExp(`收款行加起来是 ${MONEY}200`));
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '不等 ⇒ 一个字都不写');

    // ③ 实付超过每件实收合计
    const openId3 = 'ou_two_layer_partial_over';
    await addShoe(h, openId3, { size: 40, amount: 300 });
    const over = await h.write.submitSale({
      openId: openId3, submitKey: await currentKey(h, openId3), paymentStatus: PAYMENT_STATUS.partial,
      paidAmount: '400', payments: [{ method: '微信', amount: '400' }],
    });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'amount_mismatch');
    assert.match(over.message, new RegExp(`每件实收合计 ${MONEY}300`));
    assert.match(over.message, new RegExp(`收款比每件实收多 ${MONEY}100`));
    assert.equal(entriesOf(h, 'paymentRecord').length, 0);
  } finally { h.cleanup(); }
});

test('AC-7y ⭐【未收款】那一条的真实字段形状：只有 关联销售单 + 收款金额 + 收款状态', async () => {
  const h = createHarness();
  try {
    // ⚠️ 2026-10-11 晚改写：样例改成**部分付**（未付不再自动写【未收款】）；
    //    这一条钉的是"那一条长什么样"，与哪一档写它无关。
    const openId = 'ou_two_layer_unpaid_shape';
    await addShoe(h, openId, { size: 40, amount: 399 });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.partial,
      paidAmount: '200', payments: [{ method: '微信', amount: '200' }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const row = unpaidRows(h)[0];
    const table = V1_BITABLE_SCHEMA.tables.paymentRecord.fields;
    // ⚠️ 2026-10-12 **改写**（业务负责人定了「收款明细ID」这个格式）：
    //    改前 = 只有 3 列（关联销售单 / 收款金额 / 收款状态）；
    //    改后 = 多一列 **「收款明细ID」**（`{销售单号}-收款-{两位序号}`，占位行**也占号**）。
    //    理由：她也明说「收款明细里那条【未收款】占位行**也算一个号**」⇒ 占位行从建单那一刻
    //    就带号（它被"收清"时是**同一条记录**改状态 ⇒ 号必须一开始就有）。
    //    ⚠️ 其余三列与三条"不写"的判据**一个字没动**（下面照旧钉着）。
    assert.deepEqual(Object.keys(row.fields).sort(),
      [table.amount, table.receiptId, table.salesEntry, table.status].sort(),
      '写这四列：关联销售单 / 收款金额 / 收款状态 / **收款明细ID**');
    assert.equal(row.fields[table.status], PAYMENT_STATUS_UNPAID, '状态取值来自配置（表里既有选项）');
    assert.deepEqual(row.fields[table.salesEntry], [ok.sales_entry_record_id], '关联 = 既有「关联销售单」');
    assert.equal(row.fields[table.receivedAt], undefined, '未到账 ⇒ 不写收款时间（既有口径）');
    assert.equal(row.fields[table.tradeDirection], undefined, '未到账 ⇒ 不写交易方向（既有口径）');
    // 源码哨兵：扫码侧**不许**新造收款状态取值 —— 连那个中文串都不许出现在**字符串字面量**里
    //（注释里为了把口径说清楚当然可以提；判据只看真正的字面量）。
    const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8');
    const literals = source.match(/'[^'\n]*'|"[^"\n]*"/g) || [];
    assert.equal(literals.some((item) => item.includes(PAYMENT_STATUS_UNPAID)), false,
      '扫码侧不许把「未收款」写成字面量（那一条由既有业务层落）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-7z 付款情况取值不认识（手改表单）⇒ 人话拦住
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7z 付款情况传了第四种取值 ⇒ 人话拦住（不静默当成某一档）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_bad_status';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: '先欠着',
      payments: [{ method: '微信', amount: 350 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'payment_status_invalid');
    assert.equal(result.message, SCAN_WRITE.texts.paymentStatusInvalidBody);
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-7w 收款行：金额填了就必须有方式；只选方式不填金额 = 这一行不用
// ═══════════════════════════════════════════════════════════════════════════

test('AC-7w-1 填了金额没选收款方式 ⇒ 人话拦住（不写库）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_no_method';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '', amount: 350 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'payment_row_incomplete');
    assert.equal(result.message, SCAN_WRITE.texts.paymentRowIncompleteBody);
    assert.equal(entriesOf(h, 'paymentRecord').length, 0);
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

test('AC-7w-2 只选了方式、没填金额 = 这一行不用（不算一笔，也不报错）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_empty_row';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: 350 }, { method: '现金', amount: '' }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    // ⚠️ 2026-10-11 晚：默认档是「未付」，但**她真填了的那一行照写**（不再被丢弃 ——
    //    丢弃她填过的钱 = 静默丢账）。「未付」这条档位只决定"写不写那条【未收款】"。
    assert.equal(ok.payment_count, 1, '金额空的那一行不算一笔');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1);
    assert.deepEqual(entriesOf(h, 'paymentRecord')[0].fields[methodField()], ['pm_wechat']);
  } finally { h.cleanup(); }
});

test('AC-7w-3 金额不是数字 ⇒ 人话拦住（收款行 / 每件实收 两种都验）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_bad_amount';
    await addShoe(h, openId, { size: 40, amount: '' });
    const badPay = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId),
      payments: [{ method: '微信', amount: '一百' }],
    });
    assert.equal(badPay.ok, false);
    assert.equal(badPay.code, 'payment_amount_invalid');
    const badLine = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), lineAmounts: ['3.999'],
    });
    assert.equal(badLine.ok, false);
    assert.equal(badLine.code, 'line_amount_invalid');
    assert.equal(entriesOf(h, 'salesEntry').length, 0);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-8 校验的落点：服务端权威 + 页面上原地给差额（她改一下就能再提交）
// ═══════════════════════════════════════════════════════════════════════════

const SESSION_SECRET = 'scan_two_layer_session_secret';
const sessionCookie = (openId = 'ou_two_layer_route') => {
  const payload = Buffer.from(JSON.stringify({
    open_id: openId, name: '测试用户', exp: Date.now() + 3600 * 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `workbench_session=${payload}.${signature}`;
};
const login = () => {
  process.env.LARK_WEB_AUTH_ENABLED = 'true';
  process.env.LARK_WEB_SESSION_SECRET = SESSION_SECRET;
  delete process.env.WORKBENCH_ALLOWED_OPEN_IDS;
};
const withServer = async (app, run) => {
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  // 2026-10-15 task-17：测试服务器不保持 keep-alive（根因与实测见 test/stabilityRepro.cjs）
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const formApp = (harness, lookup = async () => VIEW) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.basePath, createScanPageRouter({
    service: { lookup }, gateway: harness.gateway, writeService: harness.write,
  }));
  return app;
};
/**
 * 表单体（**同名重复的字段要真的重复出现** —— 数组必须逐项 `append`）。
 * ⚠️ 不能写成 `new URLSearchParams({ line_amount: ['1','2'] })`：那会拼成 `1,2` 一个值。
 */
const formBody = (entries) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    for (const item of (Array.isArray(value) ? value : [value])) {
      body.append(key, item === undefined || item === null ? '' : String(item));
    }
  }
  return body.toString();
};
const formPost = (base, cookie, body) => fetch(`${base}/s/${encodeURIComponent(NUMBER)}?from=sales`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: formBody(body),
});

test('AC-8a 【全付】不等 ⇒ 400 + **还是销售那一块** + 差额人话 + 她刚填的值原样还在', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_route';
    const cookie = sessionCookie(openId);
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const html = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      // 加两双（每件实收 200 / 300）
      for (const [size, amount] of [['40', '200'], ['41', '300']]) {
        const added = await fetch(pageUrl, {
          method: 'POST', redirect: 'manual',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size, amount }).toString(),
        });
        assert.equal(added.status, 303);
      }
      // ⭐⭐ 2026-10-14（业务负责人逐字：「**确认状态是资金那页点击了按钮之后，才算是用户确认了，
      //    然后就是单号创建成功的页面**」）⇒ 这条用例改成**两段**：
      //    ① 点「提交这一单」⇒ **只到资金页、一个字都不写表** ✓
      //    ② 点资金页那颗【提交整单付款】⇒ **这时才校验钱**：不齐 ⇒ 400 + 原地重渲染资金页 + 零写入 ✓
      const moneyPage = await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey,
      });
      assert.equal(moneyPage.status, 200, '第一步只到资金页（200）');
      const moneyHtml = await moneyPage.text();
      assert.ok(moneyHtml.includes('data-view="payment-step"'), '第一步到的是**资金页**');
      assert.equal(entriesOf(h, 'salesEntry').length, 0, '第一步**一个字都不写**（主表 0）');
      assert.equal(entriesOf(h, 'salesDetail').length, 0, '第一步**一个字都不写**（明细 0）');
      assert.equal(entriesOf(h, 'paymentRecord').length, 0, '第一步**一个字都不写**（收款 0）');
      // 全付 + 总单只记了 200（少 300）⇒ 第二步（点那颗按钮）**拦住**
      const failed = await formPost(base, cookie, {
        action: SCAN_PAGE.paymentStep.payAction, submit_key: saleKey,
        payment_status: PAYMENT_STATUS.full,
        payment_method: '现金', payment_amount: '200',
        line_amount: ['200', '300'],
      });
      assert.equal(failed.status, 400, '校验失败是"她能改"的那一类 ⇒ 400 而不是 500');
      const failedHtml = await failed.text();
      assert.ok(failedHtml.includes('data-view="payment-step"'), '原地**重渲染资金页**（不是一张干巴巴的失败页）');
      // 她刚填的钱还在（不用重打）：她选的方式 / 金额
      assert.match(failedHtml, /<option value="现金" selected>现金<\/option>/);
      assert.match(failedHtml, /name="payment_amount"[^>]*value="200"/);
      // **一个字都没写库**
      assert.equal(entriesOf(h, 'salesEntry').length, 0);
      assert.equal(entriesOf(h, 'salesDetail').length, 0);
      assert.equal(entriesOf(h, 'paymentRecord').length, 0);
      // 改对 ⇒ 同一把键**再点一次那颗按钮** ⇒ 成单（只写一次）
      const fixed = await formPost(base, cookie, {
        action: SCAN_PAGE.paymentStep.payAction, submit_key: saleKey,
        payment_status: PAYMENT_STATUS.full,
        payment_method: ['微信', '现金'], payment_amount: ['200', '300'],
        line_amount: ['200', '300'],
      });
      assert.equal(fixed.status, 200, await fixed.text());
      assert.equal(entriesOf(h, 'salesEntry').length, 1);
      assert.equal(entriesOf(h, 'salesDetail').length, 2);
      assert.equal(entriesOf(h, 'paymentRecord').length, 2, '两笔收款写两条');
    });
  } finally { h.cleanup(); }
});

test('AC-8b 路由把表单的**同名重复**字段拼成有序的多笔收款（形式解析，不判业务）', () => {
  const fields = SCAN_WRITE.fields;
  assert.deepEqual(parsePaymentRows({ [fields.paymentMethod]: ['微信', '现金'], [fields.paymentAmount]: ['200', '300'] }, fields),
    [{ method: '微信', amount: '200' }, { method: '现金', amount: '300' }]);
  // 只出现一次时是字符串（express 的形状）
  assert.deepEqual(parsePaymentRows({ [fields.paymentMethod]: '微信', [fields.paymentAmount]: '200' }, fields),
    [{ method: '微信', amount: '200' }]);
  // 缺一位也照拼（服务端那边才判"方式必填 / 金额必填"）
  assert.deepEqual(parsePaymentRows({ [fields.paymentAmount]: ['200', '300'] }, fields),
    [{ method: '', amount: '200' }, { method: '', amount: '300' }]);
  assert.deepEqual(parsePaymentRows({}, fields), []);
});

test('AC-8c ⭐【未付】走真路由：页面上什么都不填 ⇒ 直接成单（**一条未收款都不写**，差额 0）', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_route_unpaid';
    const cookie = sessionCookie(openId);
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const html = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      await fetch(pageUrl, {
        method: 'POST', redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size: '40' }).toString(),
      });
      const done = await followPaymentStep(base, cookie, await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey,
        payment_status: PAYMENT_STATUS.unpaid, line_amount: ['399'],
      }));
      assert.equal(done.status, 200);
      assert.match(await done.text(), /您的提交已成功/);
      assert.equal(paidRows(h).length, 0);
      // ⭐⭐ 2026-10-14（她裁决 ①）：「**销售货品页的每件金额必须填**，只有资金页可以不填」
      //   ⚠️ 改前逐字：这条走真路由的用例**每件实收留空**也提交 ⇒ 那一列留空、差额 0、不写未收款
      //   ⇒ 改后逐字：**每件实收必填**（本用例已填 399 ✓）⇒ 那一列**落下 399** ✓
      //      ⚠️ 收款仍全空 ⇒ 差额按**既有**口径（尚未接她今晚那句"一律补未收款"）⇒ 此刻 0 条 ✓
      //   ⇒ 判据**没放宽** ✗（"留空"换成"逐字 399"也是断言 ✓）；②接线时这里会再改成"补一条未收款" ✓
      assert.equal(entriesOf(h, 'salesDetail')[0].fields['实收金额'], 399, '她填的每件实收落下 399 ✓');
      assert.equal(unpaidRows(h).length, 1, '此刻差额 0 ⇒ 不写未收款（②接线后按新口径改）');
    });
  } finally { h.cleanup(); }
});

test('AC-8d ⭐【部分付】走真路由：实付 200 + 差额 300 落在收款明细里', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_route_partial';
    const cookie = sessionCookie(openId);
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const html = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      for (const [size, amount] of [['40', '200'], ['41', '300']]) {
        await fetch(pageUrl, {
          method: 'POST', redirect: 'manual',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size, amount }).toString(),
        });
      }
      // ⭐⭐ 2026-10-14（她逐字：「**确认状态是资金那页点击了按钮之后，才算是用户确认了**」）：
      //    ⇒ 钱（部分付 / 实付 200）要填在**第二步**（点资金页那颗按钮）✓，
      //      第一步（点提交）**不看钱** ✓ 只到资金页、零写入 ✓
      const moneyPage = await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder, submit_key: saleKey,
      });
      assert.equal(moneyPage.status, 200, await moneyPage.text());
      assert.equal(entriesOf(h, 'salesEntry').length, 0, '第一步零写入（主表 0）');
      const done = await formPost(base, cookie, {
        action: SCAN_PAGE.paymentStep.payAction, submit_key: saleKey,
        payment_status: PAYMENT_STATUS.partial, paid_amount: '200',
        payment_method: '微信', payment_amount: '200',
        line_amount: ['200', '300'],
      });
      assert.equal(done.status, 200, await done.text());
      assert.deepEqual(paidRows(h).map((row) => row.fields['收款金额']), [200]);
      assert.deepEqual(unpaidRows(h).map((row) => row.fields['收款金额']), [300]);
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-9 幂等不变（三档都只写一次）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-9a 【全付】拦住不轮换幂等键；改对后同一把键提交 ⇒ 只写一次（连点两次也只写一次）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_idem';
    await addShoe(h, openId, { size: 40, amount: 350 });
    const key = await currentKey(h, openId);
    const blocked = await h.write.submitSale({
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.full, payments: [{ method: '微信', amount: 100 }],
    });
    assert.equal(blocked.ok, false);
    const session = await h.sessions.get(openId);
    assert.equal(session.sale.key, key, '拦住那一次不许轮换幂等键（否则她没法用同一把键重试）');
    assert.equal(session.sale.completed.length, 0, '拦住那一次不算"已提交过"');
    assert.deepEqual(entriesOf(h, 'salesEntry'), []);

    const fixed = await h.write.submitSale({
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.full, payments: [{ method: '现金', amount: 350 }],
    });
    assert.equal(fixed.ok, true, JSON.stringify(fixed));
    const again = await h.write.submitSale({
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.full, payments: [{ method: '现金', amount: 350 }],
    });
    assert.equal(again.ok, true);
    assert.equal(again.reused, true, '同一把键第二次 = 把她上一次的结果还给她');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '只写一次');
    assert.equal(entriesOf(h, 'salesDetail').length, 1);
    assert.equal(entriesOf(h, 'paymentRecord').length, 1);
  } finally { h.cleanup(); }
});

test('AC-9b ⭐【未付】连点两次 / 重放 ⇒ 只建一张单，且【未收款】**只写一条**', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_idem_unpaid';
    await addShoe(h, openId, { size: 40, amount: 399 });
    const key = await currentKey(h, openId);
    const first = await h.write.submitSale({
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(first.ok, true, JSON.stringify(first));
    const again = await h.write.submitSale({
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(again.reused, true);
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '只有一张单');
    // 改前逐字（她 2026-10-11 老口径）：`未付**不再**自动写【未收款】⇒ 这里钉"一条都没有"`
    //   ＋ `assert.equal(entriesOf(h, 'paymentRecord').length, 0)`
    // 改后逐字（她 2026-10-14 最新权威）：未付（本次付 0）**照写一条**【未收款】
    //   ⇒ `unpaidRows === 1`；`paymentRecord` 总数 **1**（**重放不许多出第二条** —— 幂等这条判据不变 ✓）
    //   依据 = 她 2026-10-14「差额都是未收款，包括本次付款为 0」
    assert.equal(unpaidRows(h).length, 1, '未付 ⇒ **恰一条**【未收款】');
    assert.equal(entriesOf(h, 'paymentRecord').length, 1,
      '重放（同一把 submitKey）⇒【未收款】**仍然只有一条**（幂等没被破坏）');
  } finally { h.cleanup(); }
});

test('AC-9c ⭐【部分付】重放同一把键 ⇒ 已收 + 未收款都只写一次', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_idem_partial';
    await addShoe(h, openId, { size: 40, amount: 500 });
    const key = await currentKey(h, openId);
    const input = {
      openId, submitKey: key, paymentStatus: PAYMENT_STATUS.partial, paidAmount: '200',
      payments: [{ method: '微信', amount: '200' }],
    };
    const first = await h.write.submitSale(input);
    assert.equal(first.ok, true, JSON.stringify(first));
    // ⚠️ 第二次是**重放**：她可能已经离开这一页（`reused` 分支）——
    //    无论走哪条分支，收款明细都不许多出来。
    const again = await h.write.submitSale(input);
    assert.equal(again.ok, true);
    assert.equal(entriesOf(h, 'salesEntry').length, 1);
    assert.equal(paidRows(h).length, 1);
    assert.equal(unpaidRows(h).length, 1);
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-10 现货"提交即交付 + 扣库存"照旧（刚上线那套一个字不许改坏）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-10a 【全付】通过后：现货行仍然提交即交付 + 扣库存 + 写「库存状态」', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_deliver';
    await addShoe(h, openId, { size: 40, amount: 399, inStock: true });   // 40 有货 ⇒ 现货
    await addShoe(h, openId, { size: 41, amount: 399, inStock: false });  // 41 没货 ⇒ 预订
    const ok = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.full,
      payments: [{ method: '微信', amount: 798 }],
    });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.stock.requested, 1, '只有现货那一行进交付');
    assert.equal(ok.stock.failed, 0, `现货那一双必须扣成功：${JSON.stringify(ok.stock)}`);
    assert.equal(h.stockCalls.length, 1, '库存引擎只被调了一次（预订那一行不许碰库存）');
    const details = entriesOf(h, 'salesDetail');
    const bySize = new Map(details.map((row) => [row.fields['尺码'][0], row.fields['履约状态']]));
    assert.equal(bySize.get('size_40'), '已交付', '现货 ⇒ 提交即交付');
    assert.equal(bySize.get('size_41'), '未交付', '预订 ⇒ 不交付');
    assert.equal(entriesOf(h, 'salesEntry')[0].fields['库存状态'], '已写入');
  } finally { h.cleanup(); }
});

test('AC-10b ⭐【未付】/【部分付】两档同样"提交即交付 + 扣库存"（钱那一半不影响货）', async () => {
  for (const [label, input] of [
    [PAYMENT_STATUS.unpaid, { paymentStatus: PAYMENT_STATUS.unpaid }],
    [PAYMENT_STATUS.partial, {
      paymentStatus: PAYMENT_STATUS.partial, paidAmount: '200', payments: [{ method: '现金', amount: '200' }],
    }],
  ]) {
    const h = createHarness();
    try {
      const openId = `ou_two_layer_deliver_${label}`;
      await addShoe(h, openId, { size: 40, amount: 399, inStock: true });
      const ok = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId), ...input });
      assert.equal(ok.ok, true, `${label}: ${JSON.stringify(ok)}`);
      assert.equal(ok.stock.requested, 1, `${label}: 现货行照旧进交付`);
      assert.equal(ok.stock.failed, 0, `${label}: ${JSON.stringify(ok.stock)}`);
      assert.equal(entriesOf(h, 'salesDetail')[0].fields['履约状态'], '已交付', `${label}: 提交即交付`);
    } finally { h.cleanup(); }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-11 配置先行 + 无说明书（源码/文案哨兵）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-11 配置先行：行数 / 三档取值 / 前缀 / 校验错误码 / 文案都在 config；页面无说明书', () => {
  // ① 旋钮全在 config（换一个值不必改代码）
  for (const key of ['paymentRowCount', 'moneyPrefix', 'amountDecimals', 'formFailureCodes', 'paymentStatus']) {
    assert.ok(SCAN_WRITE.sale[key] !== undefined, `config/scanWrite.sale.${key} 必须在`);
  }
  assert.deepEqual(SCAN_WRITE.sale.paymentStatus.values,
    [PAYMENT_STATUS.full, PAYMENT_STATUS.partial, PAYMENT_STATUS.unpaid], '三档取值来自配置');
  assert.deepEqual(SCAN_WRITE.sale.paymentStatus.mode,
    { full: PAYMENT_STATUS.full, partial: PAYMENT_STATUS.partial, unpaid: PAYMENT_STATUS.unpaid },
    '逻辑里只认语义键（mode.*），不拿字面量/下标去比');
  // ⚠️ 2026-10-11 晚改写：默认档 = **未付**（扫码建单时钱通常还没收；改前"全付"是她被卡的根因）
  assert.equal(SCAN_WRITE.sale.paymentStatus.default, PAYMENT_STATUS.unpaid, '默认 = 未付');
  assert.equal(typeof SCAN_WRITE.texts.fullWithoutPaymentsNote, 'string',
    '「选了全付却没填收款」那句人话在配置里');
  for (const code of ['amount_mismatch', 'partial_amount_mismatch', 'partial_amount_missing', 'payment_status_invalid']) {
    assert.ok(SCAN_WRITE.sale.formFailureCodes.includes(code), `${code} 要进"原地重渲染"那一组`);
  }
  for (const key of ['amountMismatchBody', 'amountMismatchShort', 'amountMismatchOver',
    'amountMismatchNoItems', 'partialAmountMismatchBody', 'partialAmountMissingBody',
    'paymentStatusLabel', 'paidAmountLabel', 'paymentRowIncompleteBody', 'amountInvalidBody']) {
    assert.equal(typeof SCAN_WRITE.texts[key], 'string', `config/scanWrite.texts.${key} 必须在`);
  }
  // ② 收款行 / 每件实收 / 付款情况 的字段名都在 config（渲染层与路由都不写死）
  assert.equal(SCAN_WRITE.fields.lineAmount, 'line_amount');
  assert.equal(SCAN_WRITE.fields.paymentMethod, 'payment_method');
  assert.equal(SCAN_WRITE.fields.paymentAmount, 'payment_amount');
  assert.equal(SCAN_WRITE.fields.paymentStatus, 'payment_status');
  assert.equal(SCAN_WRITE.fields.paidAmount, 'paid_amount');
  // ③ 页面上没有说明书（她 2026-10-10 的硬要求）—— 逐句扫一遍
  const html = renderScanPage(VIEW, SCAN_PAGE, WRITE({
    draft: { lines: [{ item_no: 'YD6693-2', size: 40, amount: 350 }] },
    errorText: SCAN_WRITE.texts.amountMismatchBody,
  }), 'sales');
  for (const gone of ['怎么用', '使用说明', '说明：', '你可以', '资金不是必填']) {
    assert.equal(html.includes(gone), false, `页面上不该出现说明句：「${gone}」`);
  }
  // ④ 差额那句人话的源码哨兵：绝不能"只写日志、页面上不说"
  const source = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'), 'utf8');
  assert.match(source, /amount_mismatch/, '服务端必须有这条校验');
  assert.match(source, /config\.events\.amountMismatch/, '拦下来要有可 grep 的日志');
  const route = fs.readFileSync(path.join(SERVER_SRC, 'routes', 'scanPage.js'), 'utf8');
  assert.match(route, /formFailureCodes/, '路由要按配置把校验失败"原地"渲染回销售那一块');
  // ⑤ 列名字面量对齐（main 的 schema 已是新名）：**字符串字面量**里不许再有旧列名
  //    （注释里为了说明历史可以提旧名，但**代码里当列名用**的字面量必须已经是新名）。
  for (const file of ['config/scanWrite.js', 'services/scanWriteService.js',
    'views/scanPageRenderer.js', 'routes/scanPage.js']) {
    const text = fs.readFileSync(path.join(SERVER_SRC, file), 'utf8');
    const items = text.match(/'[^'\n]*'|"[^"\n]*"/g) || [];
    for (const old of ['成交金额', '交易方式']) {
      assert.equal(items.some((item) => item.includes(old)), false,
        `${file} 里不该再有旧列名的字面量「${old}」`);
    }
  }
  assert.equal(V1_BITABLE_SCHEMA.tables.salesDetail.fields.actualAmount, '实收金额');
  assert.equal(V1_BITABLE_SCHEMA.tables.paymentRecord.fields.method, '收款方式');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-12 ⭐ 订单列表判据没被破坏：未付 / 部分付 ⇒ 仍然"资金信息不齐" ⇒ 待补充
// ═══════════════════════════════════════════════════════════════════════════

/** 把工作台的订单列表判据模块真跑起来（与 orderThreeStates2026_10_11.test.js 同一套做法）。 */
const loadOrdersLogic = () => {
  const source = fs.readFileSync(path.join(WORKBENCH, 'features', 'orders', 'index.js'), 'utf8');
  const start = source.indexOf('export function salesInfoOf');
  const end = source.indexOf('export function salesSectionOf');
  assert.ok(start > 0 && end > start, 'features/orders/index.js 里找不到那两段判据');
  const slice = source.slice(start, end);
  // 判据本体是**纯函数**（只读入参），没有任何 import 依赖 ⇒ 可以直接求值。
  const body = `${slice.replace(/export /g, '')}
return { salesInfoOf };`;
  // eslint-disable-next-line no-new-func
  return new Function(body)();
};
/**
 * ⭐ 2026-10-13「金额两步走」：提交成功后**先落到第 2 步「整单付款」页**
 * （能力去哪：`renderSalePaymentStepPage`），她点【跳过（稍后去工作台补）】才到**成功页**。
 * ⇒ 原本"提交后看到成功页"的用例，顺着这一步再走一次 ✓（**成功页的内容断言一条没放宽** ✓）。
 * 🔴 第 2 步页**没有**"提交整单付款"按钮（没有诚实落库出口）⇒ 这里只可能点【跳过】✓
 */
const followPaymentStep = async (base, cookie, response) => {
  const html = await response.clone().text().catch(() => '');
  if (!html.includes('data-view="payment-step"')) return response;
  // ⭐ 2026-10-13：「跳过」= **一个 POST 动作**（`payment_skip` ⇒ 走既有动作分发 ⇒ 成功页）✓
  //    ⇒ 这里把那一颗按钮所在的表单**原样提交一次**（模拟她点【跳过】✓ 零 JS ✓）
  const form = (html.match(/<form[^>]*>[\s\S]*?<\/form>/g) || [])
    .find((item) => item.includes('payment_skip'));
  if (!form) return new Response(html, { status: response.status, headers: { 'content-type': 'text/html' } });
  const actionUrl = (form.match(/action="([^"]*)"/) || [])[1] || '';
  const params = new URLSearchParams();
  for (const input of form.match(/<input[^>]*>/g) || []) {
    const name = (input.match(/name="([^"]*)"/) || [])[1];
    const value = (input.match(/value="([^"]*)"/) || [])[1] || '';
    if (name) params.append(name.replace(/&amp;/g, '&'), value.replace(/&amp;/g, '&'));
  }
  const url = actionUrl.startsWith('http') ? actionUrl : `${base}${actionUrl.replace(/&amp;/g, '&')}`;
  return fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
};

test('AC-12 订单列表判据：未付 / 部分付 的单**仍然**是"资金信息不齐"⇒ 待补充（不会跑进售后列表）', async () => {
  const { salesInfoOf } = loadOrdersLogic();
  const h = createHarness();
  try {
    // ① 未付：主表 + 明细 + **恰一条**【未收款】（= 差额 399 · 方式留空）
    //    （她 2026-10-14 裁决②：差额一律补一条，含本次付款为 0）
    const openId = 'ou_two_layer_list_unpaid';
    await addShoe(h, openId, { size: 40, amount: 399 });
    const unpaidOrder = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(unpaidOrder.ok, true, JSON.stringify(unpaidOrder));
    // ② 部分付：已收 1 条（有方式）+ 未收款 1 条（无方式）
    const openId2 = 'ou_two_layer_list_partial';
    await addShoe(h, openId2, { size: 41, amount: 500 });
    const partialOrder = await h.write.submitSale({
      openId: openId2, submitKey: await currentKey(h, openId2), paymentStatus: PAYMENT_STATUS.partial,
      paidAmount: '200', payments: [{ method: '微信', amount: '200' }],
    });
    assert.equal(partialOrder.ok, true, JSON.stringify(partialOrder));

    // 页面上判据吃的形状：`payments: [{ method, amount }]`（`GET /api/workbench/sales/orders` 的形状）。
    // ⚠️ `method` 在真接口里是**收款方式的显示文本**（关联列读出来的人话）；本用例的替身网关
    //    给的是关联的记录 id —— 对判据（"这一格空不空"）来说**同义**：空 = 没方式。
    const paymentField = methodField();
    // 关联列在真接口里带**显示文本**（「微信」）；替身网关只有 record_id ⇒ 这里把
    // 「收款方式管理」里的名字查回来（与真接口读出来的人话同义；查不到就退回 record_id）。
    const methodNameOf = (recordId) => {
      const row = entriesOf(h, 'paymentMethod').find((item) => item.record_id === recordId);
      return String(row?.fields?.['收款方式'] || recordId || '').trim();
    };
    const asListPayments = (entryId) => entriesOf(h, 'paymentRecord')
      .filter((row) => (row.fields['关联销售单'] || []).includes(entryId))
      .map((row) => {
        const links = row.fields[paymentField] || [];
        return {
          method: links.length ? methodNameOf(links[0]) : '',
          amount: Number(row.fields['收款金额']),
          status: row.fields['收款状态'],
        };
      });
    const unpaidList = asListPayments(unpaidOrder.sales_entry_record_id);
    // 改前逐字（她 2026-10-11 老口径）：`assert.deepEqual(unpaidList, [], '一条收款都没有')`
    //   ＋ 注释「未付不再自动写【未收款】」
    // 改后逐字（她 2026-10-14 裁决②）：**恰一条**【未收款】（方式留空 · 金额 = 差额 399）
    //   ⚠️ 而"资金信息不齐 ⇒ 待补充"这个**结论一个字没变** ✓
    //      —— 判据是"有没有**带方式**的收款行"（那条【未收款】本来就不带方式）。
    assert.deepEqual(unpaidList, [{ method: '', amount: 399, status: PAYMENT_STATUS_UNPAID }],
      '未付 ⇒ **恰一条**【未收款】（方式留空 · 金额 = 差额）');
    assert.equal(salesInfoOf({ payments: unpaidList }).fundsMissing, true,
      '未付 ⇒ 资金信息不齐 ⇒ 落在**待补充**（不会跑进售后列表）');
    const partialList = asListPayments(partialOrder.sales_entry_record_id);
    assert.deepEqual(partialList.map((row) => row.status).sort(), ['已收款', PAYMENT_STATUS_UNPAID].sort());
    assert.equal(partialList.find((row) => row.status === '已收款').method, '微信',
      '已收的那条**带收款方式**（那一条【未收款】不带）');
    assert.equal(salesInfoOf({ payments: partialList }).fundsMissing, false,
      '部分付 ⇒ 已收那条带方式 ⇒ 资金信息算齐（她 2026-10-09 的判据："有收款方式 + 至少一笔收款"）'
      + ' ⇒ 落在**待交割**而不是待补充；两种都不会进售后列表');

    // 判据源码哨兵：它读的就是 `method`（收款方式）—— 扫码侧没有为了对齐而改它
    const source = fs.readFileSync(path.join(WORKBENCH, 'features', 'orders', 'index.js'), 'utf8');
    assert.match(source, /payment\?\.method|payment\.method/, '判据读的仍是收款方式那一列');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-11 晚补充口径：「建单门槛 = 只要「货品信息」齐」——
//     资金类（实收 / 收款）**不拦**、可以全空；
//     「全付必须相等」只在她**填了资金**时才生效（填了就照旧一条都不放过）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-13 建单门槛 = 货品信息齐：**资金全空**（默认「全付」）⇒ 成单；那一列留空、一条收款都不写', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_blank_money';
    await addShoe(h, openId, { size: 40 });            // 「实收金额」留空
    // ⚠️ 完全按"她什么都没填"的形状提交：**不传** paymentStatus / paidAmount / payments / lineAmounts
    //    ⇒ 服务端按默认档「全付」走，而全付的相等校验**只在她填了资金时才生效**。
    const result = await h.write.submitSale({ openId, submitKey: await currentKey(h, openId) });
    assert.equal(result.ok, true, `资金全空也要能建单（门槛 = 货品信息齐）：${JSON.stringify(result)}`);
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '主表一条');
    assert.equal(entriesOf(h, 'salesDetail').length, 1, '明细一条');
    // ⚠️ 2026-10-11（方案甲）**改写**：改前"实收按货品信息.单价自动落 399"；
    //    现在**没填 ⇒ 那一列留空**（表里不出现按单价顶上去的假数字）。
    assert.equal('实收金额' in entriesOf(h, 'salesDetail')[0].fields, false, '没填 ⇒ 那一列留空');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '资金全空 ⇒ 一条收款明细都不写');
    assert.equal(unpaidRows(h).length, 0, '也没写【未收款】（她一个字都没说欠钱）');
    assert.equal(h.stockCalls.length, 1, '现货行照旧"提交即交付 + 扣库存"（钱那一半不影响货）');
  } finally { h.cleanup(); }
});

test('AC-13b ⭐ 走真路由：**只填每件实收、收款行全空** ⇒ 提交成单（200 + 结果页），不是 400 差额页', async () => {
  login();
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_route_blank';
    const cookie = sessionCookie(openId);
    await withServer(formApp(h), async (base) => {
      const pageUrl = `${base}/s/${encodeURIComponent(NUMBER)}?from=sales`;
      const html = await (await fetch(pageUrl, { headers: { cookie } })).text();
      const saleKey = html.match(/name="submit_key" value="(scan_sale:[^"]+)"/)[1];
      await fetch(pageUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ action: SCAN_WRITE.actions.addLine, submit_key: saleKey, size: '40' }).toString(),
      });
      // 表单**原样**提交：**每件实收填了 399**、收款行是空的、付款情况 = **页面默认那一档**。
      // ⚠️ 2026-10-12 **改写**：这里原来写 `PAYMENT_STATUS.full` ——
      //    改前口径：「全付」+ 一笔收款都不填 ⇒ 按「未付」落库（她 2026-10-11 点头过）；
      //    改后口径：**全付 + 收款 0 笔 + 每件实收也全空** ⇒ **拦住**（零元全付单，
      //    见 `scanWriteService` 的 `full_without_money`；起因是她真机丢钱那次）。
      //    这一条要钉的是"**收款全空也能建单**"⇒ 用页面默认那一档（未付）才对应真实页面。
      // ⭐⭐ 2026-10-14 再改（她裁决①「销售货品页的每件金额必须填，只有资金页可以不填」）：
      //    ⇒ **每件实收必须填**（本用例名字随之从"什么都不填"改成"只填每件实收、收款行全空"）；
      //      整单收款那一层**仍然可以全空** —— 这就是本用例要钉的那条边界 ✓
      const done = await followPaymentStep(base, cookie, await formPost(base, cookie, {
        action: SCAN_WRITE.actions.submitOrder,
        submit_key: saleKey,
        payment_status: PAYMENT_STATUS.unpaid,
        payment_method: '',
        payment_amount: '',
        line_amount: ['399'],
      }));
      assert.equal(done.status, 200, `收款全空应该直接成单，而不是 400：${await done.text()}`);
      assert.equal(entriesOf(h, 'salesEntry').length, 1);
      assert.equal(entriesOf(h, 'salesDetail').length, 1);
      // 改前逐字：`assert.equal(entriesOf(h, 'paymentRecord').length, 0)`
      //   （她 2026-10-11 老口径：未付不替她记【未收款】）
      // 改后逐字：`1` ＋ 金额/状态逐字（= 累计 399 − 本次已收 0）· 依据 = 她 2026-10-14 裁决②
      const owedRows = entriesOf(h, 'paymentRecord');
      assert.equal(owedRows.length, 1, '差额>0 ⇒ **恰写一条**【未收款】');
      assert.equal(owedRows[0].fields['收款金额'], 399, '那一条的金额 = 差额 399');
      assert.equal(owedRows[0].fields['收款状态'], '未收款', '状态逐字「未收款」');
    });
  } finally { h.cleanup(); }
});

test('AC-14 ⭐【未付】+ 差额 0（她什么都没填）⇒ **绝不写"金额 0"的【未收款】**、单照建成', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_two_layer_no_price_unpaid';
    // 这一款**连单价都没有**（`PRODUCT_NO_PRICE`）—— 2026-10-11（方案甲）之后它**不再是阻碍**：
    // 没填实收 ⇒ 那一列留空 ⇒ 每件实收合计 = 0 ⇒ 差额 0 ⇒ **一条未收款都不写**。
    // ⚠️ **改写**（改前：`code = 'line_amount_missing'`、一个字都不写）：
    //    那时"留空 ⇒ 读单价"还在，读不到单价就只能拦住；现在"留空"本身是合法的。
    await h.write.addSaleLine({
      openId,
      requestId: 'req_add',
      productRecordId: 'prod_2',
      number: 'YD1111|白色|A',
      itemNo: 'YD1111',
      color: '白色',
      size: 40,
    });
    const result = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), paymentStatus: PAYMENT_STATUS.unpaid,
    });
    assert.equal(result.ok, true, `没填实收也能建单：${JSON.stringify(result)}`);
    assert.equal(result.owed_amount, 0, '差额 0');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '单子照旧建成');
    assert.equal('实收金额' in entriesOf(h, 'salesDetail')[0].fields, false, '那一列留空');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '**绝不写一条金额 0 的【未收款】**');
  } finally { h.cleanup(); }
});

test('AC-15 ⭐ 方案甲的两条边界：**填了 0 照旧拦住**；货品有单价也**不许顶上去**', async () => {
  const h = createHarness();
  try {
    // ① 她**填了 0** ⇒ 照旧拦住（放宽只针对"缺省"，不放松"填了的值"）
    const openId = 'ou_two_layer_zero_amount';
    await addShoe(h, openId, { size: 40 });                 // 加单时不填
    const zero = await h.write.submitSale({
      openId, submitKey: await currentKey(h, openId), lineAmounts: ['0'],
      payments: [{ method: '微信', amount: 0 }],
    });
    assert.equal(zero.ok, false, '填 0 不是"没填" ⇒ 拦住');
    assert.equal(zero.code, 'line_amount_invalid');
    assert.equal(entriesOf(h, 'salesEntry').length, 0, '一个字都不写');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0);

    // ② 同款货品的「单价」是 399（`PRODUCT`），但她没填 ⇒ 表里那一格**也是空**，不是 399
    const openId2 = 'ou_two_layer_no_fake_number';
    await addShoe(h, openId2, { size: 40, amount: '' });
    const ok = await h.write.submitSale({ openId: openId2, submitKey: await currentKey(h, openId2) });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const shoe = entriesOf(h, 'salesDetail')[0];
    assert.equal('实收金额' in shoe.fields, false, '有单价也不许顶上去（表里不出现假数字）');
    assert.equal(shoe.fields['实收金额'], undefined, '读出来就是空');

    // ③ 读侧安全（`salesProgressService.progressFromRecords` 现算）：空 ⇒ 状态空、待收为 null，
    //    **不会**触发"已收 > 实收"那条硬红线、整单照样读得出来。
    const { SalesProgressService } = require('../src/services/salesProgressService');
    const progress = await new SalesProgressService({ gateway: h.gateway }).forOrder(
      ok.sales_entry_record_id,
    );
    assert.equal(progress.receivableAmount, null, '没填 ⇒ 应收为 null（不是 0）');
    assert.equal(progress.pendingAmount, null, '没填 ⇒ 待收为 null');
    assert.equal(progress.paymentStatus, '', '没填 ⇒ 收款状态为空（不是"未收款"）');
    assert.equal(progress.fulfillmentStatus, '已交付', '货那一维照旧（现货提交即交付）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ⭐⭐ 2026-10-16（业务负责人逐字 · 资金页两点之一）：
//    「**1. 未付、全付的差额怎么进未收款**」
//    ＋ 她 2026-10-14 那句权威口径：「**只要本次付的金额小于累计的，那么差额都是未收款，
//      包括本次付款为 0**」（`services/scanWriteService.js` 的 `:1047-1053` 就是它）
//
// ⇒ 资金页**不再让她选档**：档位由 `config/saleSettlement.js` 的纯函数 `autoModeOf(累计, 本次已收)`
//    自动定出来（她 2026-10-16 逐字：「**不用用户选择是全付、部分付或者未付**」，
//    见 `docs/money-page-v2-spec-2026-10-14.md` 第 3-6 行）。
//
// 下面这几条钉的是「**定档结果 ⇒ 真落库几行**」——**真网关 + 真业务层**，
// 断的是「收款明细」表里的**行数 + 那一行的金额 / 状态 / 方式**（不是"页面上显示了什么" ✗）。
// ⚠️ 依据（她逐字）：「差额**怎么进**未收款」⇒ **进不去就是没做到** ✗ —— 所以判据必须落在表上 ✓。
// ⚠️ 这一批**不改任何既有 AC**（既有三档那几条一个字没动）；只**新增**"自动定档"这一层。
// ═══════════════════════════════════════════════════════════════════════════

// `autoModeOf` = 她的"自动定档"（配置先行；语义键 full/partial/unpaid 的真源仍在 scanWrite）
// eslint-disable-next-line global-require
const { autoModeOf } = require('../src/config/saleSettlement');

/** 语义键 → 表里那个中文档位（真源：`config/scanWrite.js` 的 `PAYMENT_STATUS`）。 */
const modeValueOf = (key) => SCAN_WRITE.sale.paymentStatus.mode[key];

const amountField = () => V1_BITABLE_SCHEMA.tables.paymentRecord.fields.amount;

/**
 * 「她在资金页填了什么」⇒ 自动定档 ⇒ 用**既有** `submitSale` 的入参形状提交
 * （这一步就是路由要做的：档位由金额推出来，「实付多少」那个输入框不再存在 ⇒ 由收款合计顶上）。
 */
const submitAuto = async (h, openId, { itemsYuan, payments = [], submitKey } = {}) => {
  const toCents = (value) => Math.round(Number(value || 0) * 100);
  const itemsCents = toCents(itemsYuan);
  const paymentsCents = payments.reduce((sum, row) => sum + toCents(row.amount), 0);
  const auto = autoModeOf({ itemsCents, paymentsCents });
  const result = await h.write.submitSale({
    openId,
    submitKey: submitKey || await currentKey(h, openId),
    paymentStatus: auto.mode ? modeValueOf(auto.mode) : '',
    payments,
    paidAmount: auto.mode === 'partial' ? String(paymentsCents / 100) : '',
  });
  return { auto, result };
};

test('AC-AM-E2E-1 ⭐⭐ 累计 ¥300 + 本次只填「微信 100」⇒ 定成部分付 ⇒ **真落库两行**：微信 100 已收款 ＋ 未收款 200', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_auto_partial';
    await addShoe(h, openId, { size: 40, amount: 300 });

    const { auto, result } = await submitAuto(h, openId, {
      itemsYuan: 300, payments: [{ method: '微信', amount: 100 }],
    });

    // ① 自动定档（不问她）
    assert.equal(auto.action, 'allow', '这一单不该被拦住');
    assert.equal(auto.mode, 'partial', '0 < 已收 < 累计 ⇒ **部分付**（她自己没选过）');
    assert.equal(auto.owedCents, 20000, '差额 = ¥200（分：20000）');

    // ② 她点完之后**表里真的多出两行**（这才是"差额进未收款"）
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(entriesOf(h, 'paymentRecord').length, 2, '**恰两行**：一条已收款 + 一条未收款');
    const paid = paidRows(h);
    const owed = unpaidRows(h);
    assert.equal(paid.length, 1, '微信那 100 是「已收款」一行');
    assert.equal(String(paid[0].fields[amountField()]), '100', '那一行的金额 = ¥100（她填的数）');
    assert.deepEqual(paid[0].fields[methodField()], ['pm_wechat'], '方式 = 微信（关联字段：她在页面上选的那个）');
    assert.equal(owed.length, 1, '差额那一条是【未收款】');
    assert.equal(String(owed[0].fields[amountField()]), '200', '**未收款 = ¥200**（差额，不是 0、也不是全额）');
    assert.equal(result.owed_amount, 200, '端上如实回报差额（元）');
    // ③ 方式留空（那一条的形状归既有业务层，2026-10-11 口径）
    assert.equal(owed[0].fields[methodField()], undefined, '【未收款】那一条**方式留空**');
  } finally { h.cleanup(); }
});

test('AC-AM-E2E-2 ⭐ 一分没填 ⇒ 定成未付 ⇒ **一条【未收款】= 累计**（她逐字「包括本次付款为 0」）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_auto_unpaid';
    await addShoe(h, openId, { size: 40, amount: 300 });

    const { auto, result } = await submitAuto(h, openId, { itemsYuan: 300, payments: [] });

    assert.equal(auto.mode, 'unpaid', '一分没付 ⇒ 未付');
    assert.equal(auto.owedCents, 30000, '差额 = 累计（¥300）');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '恰一条【未收款】');
    assert.equal(paidRows(h).length, 0, '没有「已收款」那一行（她一分钱都没填）');
    assert.equal(String(unpaidRows(h)[0].fields[amountField()]), '300', '那一条的金额 = 累计 ¥300');
  } finally { h.cleanup(); }
});

test('AC-AM-E2E-3 ⭐ 填满 ⇒ 定成全付 ⇒ 只有那一条已收款、**一条【未收款】都不写**', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_auto_full';
    await addShoe(h, openId, { size: 40, amount: 300 });

    const { auto, result } = await submitAuto(h, openId, {
      itemsYuan: 300, payments: [{ method: '微信', amount: 300 }],
    });

    assert.equal(auto.mode, 'full', '已收 = 累计 ⇒ 全付');
    assert.equal(auto.owedCents, 0, '收齐了 ⇒ 没有差额');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(entriesOf(h, 'paymentRecord').length, 1, '只有她填的那一条');
    assert.equal(paidRows(h).length, 1);
    assert.equal(unpaidRows(h).length, 0, '**一条【未收款】都不写**（收齐了）');
  } finally { h.cleanup(); }
});

test('AC-AM-E2E-4 🔴 收多了（本次 > 累计）⇒ 自动定档**就是拦住** ⇒ 一个字都不写（既有口径不放宽 ✗）', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_auto_over';
    await addShoe(h, openId, { size: 40, amount: 300 });

    const auto = autoModeOf({ itemsCents: 30000, paymentsCents: 40000 });
    assert.equal(auto.action, 'block', '"收多了"必须拦住（她没说过"多收的算预存" ✗）');
    assert.equal(auto.code, 'amount_mismatch', '复用既有错误码 ⇒ 路由直接取既有那句人话 ✓');
    assert.equal(auto.mode, null, '拦住的这一次**不定档**（不许拿一个档位去写库 ✗）');

    // 服务层同一条口径（双保险）：未付档 + 已收 > 累计 ⇒ 也拦住、零写入
    const { result } = await submitAuto(h, openId, {
      itemsYuan: 300, payments: [{ method: '微信', amount: 400 }],
    });
    assert.equal(result.ok, false, '服务层也必须拦住');
    assert.equal(result.code, 'amount_mismatch');
    assert.equal(entriesOf(h, 'salesEntry').length, 0, '主表一个字都不写');
    assert.equal(entriesOf(h, 'paymentRecord').length, 0, '收款明细一个字都不写');
  } finally { h.cleanup(); }
});

test('AC-AM-E2E-5 ⭐ 幂等不变：同一把 `submitKey` 连点两次 ⇒ 收款行 / 未收款行**都不重复**', async () => {
  const h = createHarness();
  try {
    const openId = 'ou_auto_idempotent';
    await addShoe(h, openId, { size: 40, amount: 300 });
    const key = await currentKey(h, openId);

    const first = await submitAuto(h, openId, {
      itemsYuan: 300, payments: [{ method: '微信', amount: 100 }], submitKey: key,
    });
    assert.equal(first.result.ok, true, JSON.stringify(first.result));
    assert.equal(entriesOf(h, 'paymentRecord').length, 2, '第一跑：两行');

    // 她连点 / 刷新又点了一次（**同一把键** —— 幂等一字没拆）
    const second = await submitAuto(h, openId, {
      itemsYuan: 300, payments: [{ method: '微信', amount: 100 }], submitKey: key,
    });
    assert.equal(second.result.reused, true, '第二跑 = 把上一次的结果还给她（不重复记账）');
    assert.equal(entriesOf(h, 'paymentRecord').length, 2, '收款明细**还是两行**（没写第二遍）');
    assert.equal(paidRows(h).length, 1, '「已收款」那一条只有一条');
    assert.equal(unpaidRows(h).length, 1, '【未收款】那一条也只有一条');
    assert.equal(entriesOf(h, 'salesEntry').length, 1, '主表也没有建第二张');
  } finally { h.cleanup(); }
});
