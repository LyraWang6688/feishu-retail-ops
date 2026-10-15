'use strict';

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：「我新增了一个数据表，叫做**配品销售**……
 *   **这就相当于实际上我们只是换了一个让用户交互的入口**。但是我们**一旦收到这样的一个请求，
 *   还是要做同样的处理：销售主表、销售明细以及收款明细**」
 *
 * 本文件钉「配品销售」入口那一刀（`services/accessorySaleIntakeService`）：
 *   **AC-AS1** 关联齐全 + 金额 > 0 + 数量 = 1 ⇒ 走既有引擎成单（**同形**：`addSaleLine(kind:'accessory')` + `submitSale`）✓
 *   **AC-AS2** **同一记录 ID** ⇒ `submitKey` **逐字相同**（幂等靠引擎的"认旧键"⇒ 只成一次单）✓
 *   **AC-AS3** 🔴 源码哨兵：**没有任何路径直调 `_confirm`** ✗
 *   **AC-AS4** 金额缺失/≤0 · **数量 > 1** · 数量非法 · 关联为空 ⇒ **不成单** + 回写 `写入失败` + 人话原因 ✓
 *   **AC-AS6** 字段名/开关**全可配**（注入不同 config ⇒ 行为跟着变）✓
 *   **AC-AS7** 回写：开关**关** ⇒ **一次写都不发**；**列不在** ⇒ 捕获 + 只记日志（**不假写** ✗）✓
 *   ⭐ **Lead 2026-10-15 加的硬约束**：回写 `fields` 的 key **恰好 ⊆ {写入状态, 失败原因}**（多带一列 ⇒ 红）✗
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const logger = require('../src/utils/logger');
const logs = [];
const originalWarn = logger.logWarn;
const originalError = logger.logError;
const originalInfo = logger.logInfo;
logger.logWarn = (event, fields) => { logs.push({ level: 'warn', event, fields }); };
logger.logError = (event, fields) => { logs.push({ level: 'error', event, fields }); };
logger.logInfo = (event, fields) => { logs.push({ level: 'info', event, fields }); };
test.after(() => { logger.logWarn = originalWarn; logger.logError = originalError; logger.logInfo = originalInfo; });

const { createAccessorySaleIntakeService } = require('../src/services/accessorySaleIntakeService');
const { resolveAccessorySaleIntakeConfig, ACCESSORY_SALE_FIELDS } = require('../src/config/accessorySaleIntake');

const RECORD_ID = 'rec_accessory_sale_1';
const NAME_ID = 'rec_acc_oil';
const FIELD = { name: 'fld_name', quantity: 'fld_qty', method: 'fld_method', amount: 'fld_amount' };

/** 事件里 `action_item` 的形状（`after_value` 是 `[{field_id, field_value}]` ✓）。 */
const actionItem = (values = {}) => ({
  record_id: RECORD_ID,
  action: 'record_added',
  after_value: [
    { field_id: FIELD.name, field_value: [{ record_ids: [NAME_ID] }] },
    { field_id: FIELD.quantity, field_value: values.quantity ?? 1 },
    { field_id: FIELD.method, field_value: [{ text: values.method ?? '微信' }] },
    // ⚠️ 显式给了 key ⇒ 就用它（**哪怕是 null**）；没给才用默认 128
    //   （原来是 `values.amount ?? 128` ⇒ `null` 也被换成 128 ⇒ "金额为空"那条根本造不出来 ✗）
    { field_id: FIELD.amount, field_value: 'amount' in values ? values.amount : 128 },
  ].filter((item) => item.field_value !== undefined),
});

/** 假引擎：只记调用（真引擎的幂等/写库口径由它自己的用例钉着 ✓）。 */
const fakeEngine = ({ lineOk = true, saleOk = true, saleReused = false } = {}) => {
  const lines = [];
  const sales = [];
  return {
    lines, sales,
    engine: {
      addSaleLine: async (input) => { lines.push(input); return lineOk ? { ok: true } : { ok: false, message: '明细没记上' }; },
      submitSale: async (input) => {
        sales.push(input);
        return saleOk ? { ok: true, order_no: `XSD-${sales.length}`, reused: saleReused } : { ok: false, message: '成单失败' };
      },
    },
  };
};

/** 假网关：**只**记 `updateByTableId` 收到的 `fields`（用来钉"只许写那两列" ✓）。 */
const fakeGateway = ({ failWrite = null } = {}) => {
  const writes = [];
  const reads = [];
  return {
    writes, reads,
    gateway: {
      getByTableId: async (input) => { reads.push(input); return { record_id: input.recordId, fields: {} }; },
      updateByTableId: async (input) => {
        writes.push(input);
        if (failWrite) throw new Error(failWrite);
        return { record_id: input.recordId };
      },
    },
  };
};

/** 她那张表的列 id（把"主路径零读取"这条路打通 ⇒ 事件里的 `field_id` 就是它们 ✓）。 */
const FIELD_IDS = {
  name: FIELD.name, quantity: FIELD.quantity, paymentMethod: FIELD.method, amount: FIELD.amount,
};
const configWithIds = (over = {}) => ({
  ...resolveAccessorySaleIntakeConfig({}), fieldIds: FIELD_IDS, ...over,
});

const build = ({ config, engineOpts, gatewayOpts } = {}) => {
  const fake = fakeEngine(engineOpts);
  const gw = fakeGateway(gatewayOpts);
  const service = createAccessorySaleIntakeService({
    gateway: gw.gateway,
    scanWrite: fake.engine,
    config: config || configWithIds(),
  });
  return { service, ...fake, ...gw };
};

const WRITE_KEYS = new Set(['写入状态', '失败原因']);

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS1 正常一行 ⇒ 走既有引擎成单（同形）+ 回写"已写入"
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS1 ⭐ 关联齐全 + 金额 > 0 + 数量 = 1 ⇒ **走既有引擎成单**（同形）＋ 回写「已写入」', async () => {
  logs.length = 0;
  const h = build();
  const result = await h.service.handleTableChanges([actionItem()]);
  assert.equal(result.results[0].ok, true, '这一行办成了 ✓');
  assert.equal(h.lines.length, 1, '明细行走**既有** `addSaleLine` ✓');
  assert.equal(h.lines[0].kind, 'accessory', '配品那条 kind ✓（与工作台同形）');
  assert.equal(h.lines[0].accessoryRecordId, NAME_ID, '「名称」关联的 **record_id** 直接用（不按名字反查 ✓）');
  assert.equal(h.lines[0].amount, '128');
  assert.equal(h.sales.length, 1, '成单走**既有** `submitSale` ✓');
  assert.equal(h.sales[0].submitKey, RECORD_ID, '🔴 **幂等键 = 记录 ID** ✓');
  assert.deepEqual(h.sales[0].payments, [{ method: '微信', amount: '128' }], '「收款方式」取的是**那一行的值** ✓');
  assert.equal(h.writes.length, 1, '回写恰好一次 ✓');
  assert.deepEqual(Object.keys(h.writes[0].fields), ['写入状态'], '成功 ⇒ 只写状态那一列 ✓');
  assert.equal(h.writes[0].fields['写入状态'], '已写入');
  assert.equal(h.writes[0].tableId, 'tblkT1QTUsESnl5b', '回写到**她那张表** ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS2 同一记录 ID（串行 + 并发）⇒ `submitKey` 逐字相同（引擎认旧键 ⇒ 只成一次单）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS2 🔴 同一记录 ID 重复触发（串行两跑 + 并发两跑）⇒ **`submitKey` 逐字相同** ✓', async () => {
  logs.length = 0;
  const serial = build();
  await serial.service.handleTableChanges([actionItem()]);
  await serial.service.handleTableChanges([actionItem()]);
  assert.equal(serial.sales.length, 2);
  assert.equal(serial.sales[0].submitKey, serial.sales[1].submitKey, '串行两跑同一把键 ✓');

  const concurrent = build();
  await Promise.all([
    concurrent.service.handleTableChanges([actionItem()]),
    concurrent.service.handleTableChanges([actionItem()]),
  ]);
  assert.equal(concurrent.sales.length, 2);
  assert.equal(new Set(concurrent.sales.map((sale) => sale.submitKey)).size, 1, '并发两跑也是同一把键 ✓');
  assert.deepEqual(concurrent.sales.map((sale) => sale.submitKey), [RECORD_ID, RECORD_ID]);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS3 源码哨兵：没有任何路径直调 `_confirm`
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS3 🔴 源码哨兵：本刀**没有任何路径直调 `_confirm`** ✗（只走公开的 `submitSale`）', () => {
  // ⚠️ 只扫**本刀新增/新增那半**的文件（`larkEvents.js` 里别处的历史注释不归本刀管 ✗）
  const files = ['src/services/accessorySaleIntakeService.js', 'src/config/accessorySaleIntake.js'];
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    // ⚠️ 只查**代码行**：注释里写「绝不直调 `_confirm`」是**留痕**，要留着 ✓
    const codeLines = source.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'));
    assert.equal(codeLines.some((line) => line.includes('_confirm')), false,
      `${file} 的**代码**里不许出现 \`_confirm\` ✗`);
  }
  const service = fs.readFileSync(path.join(__dirname, '..', 'src/services/accessorySaleIntakeService.js'), 'utf8');
  assert.match(service, /submitSale\(\{/, '只走 `submitSale` 那条公开链路 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS4 失败如实（**不成单** ✗ 不许假成功）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS4 🔴 金额缺失/≤0 ⇒ **不成单** + 回写「写入失败」+ 人话原因', async () => {
  logs.length = 0;
  // ⚠️ 用 `null`（**列在、值是空**）而不是 `undefined` —— `actionItem` 里 `?? 128` 会把
  //    `undefined` 变成 128 ⇒ 那条"缺失"根本没被造出来（我第一版就是这个 bug ✗）。
  //    "**整列没带** ⇒ 走兜底读表"那条路由 AS6 覆盖 ✓
  for (const amount of [null, 0, -5]) {
    const h = build();
    const result = await h.service.handleTableChanges([actionItem({ amount })]);
    assert.equal(result.results[0].ok, false, `金额 ${amount} 必须拒单 ✓`);
    assert.equal(h.lines.length + h.sales.length, 0, '🔴 **一个写调用都没有**（不成单 ✓）');
    assert.deepEqual(Object.keys(h.writes[0].fields).sort(), ['写入状态', '失败原因'], '失败 ⇒ 两列都写 ✓');
    assert.equal(h.writes[0].fields['写入状态'], '写入失败');
    // ⚠️ 两条不同的拒单路径（我第一版混在一起了 ✗）：
    //   · `amount` **没带** ⇒ 事件不全 ⇒ 走**兜底读表**（兜底也读不出 ⇒ 原因是"哪一列缺"）✓
    //   · `amount = 0 / -5` ⇒ 事件带了、值不合法 ⇒ 原因是「金额」✓
    assert.ok(h.writes[0].fields['失败原因'].length > 0, '原因必须是人话（非空）✓');
    if (amount !== null) {
      assert.match(h.writes[0].fields['失败原因'], /金额/, '金额不合法 ⇒ 原因里要写清「金额」✓');
    }
    assert.equal(logs.some((entry) => entry.event === 'accessory_sale_intake.rejected'), true, '如实记日志 ✓');
  }
});

test('AC-AS4b 🔴 **数量 > 1 ⇒ 如实拒单**（**绝不静默按 1 记** ✗）—— 原因里要说清"1 件"', async () => {
  logs.length = 0;
  const h = build();
  const result = await h.service.handleTableChanges([actionItem({ quantity: 3 })]);
  assert.equal(result.results[0].ok, false, '3 件必须拒 ✓');
  assert.equal(h.lines.length + h.sales.length, 0, '🔴 **零写入**（不静默记 1 件 ✗）');
  assert.equal(h.writes[0].fields['写入状态'], '写入失败');
  assert.match(h.writes[0].fields['失败原因'], /1 件/, '人话原因必须说清"一次只记 1 件" ✓');
});

test('AC-AS4c 🔴 数量非法（0 / 负数 / 小数）⇒ 拒单；**数量不填 ⇒ 按 1 正常成单** ✓', async () => {
  logs.length = 0;
  for (const quantity of [0, -2, 1.5]) {
    const bad = build();
    const result = await bad.service.handleTableChanges([actionItem({ quantity })]);
    assert.equal(result.results[0].ok, false, `数量 ${quantity} 必须拒 ✓`);
    assert.equal(bad.lines.length + bad.sales.length, 0, '零写入 ✓');
  }
  const ok = build();
  const result = await ok.service.handleTableChanges([actionItem({ quantity: undefined })]);
  assert.equal(result.results[0].ok, true, '不填数量 ⇒ 按 1 办（与工作台同形 ✓）');
});

test('AC-AS4d 🔴 「名称」关联为空 ⇒ 拒单（不知道卖的是哪件配品）', async () => {
  logs.length = 0;
  const h = build();
  const item = { ...actionItem(), after_value: actionItem().after_value.filter((f) => f.field_id !== FIELD.name) };
  const result = await h.service.handleTableChanges([item]);
  assert.equal(result.results[0].ok, false);
  assert.equal(h.lines.length + h.sales.length, 0, '零写入 ✓');
  assert.equal(h.writes[0].fields['写入状态'], '写入失败');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS6 字段名 / 开关**全可配**
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS6 ⭐ 字段名可配（她改列名 ⇒ 行为跟着变）＋ 总开关关 ⇒ 一行都不办', async () => {
  logs.length = 0;
  const renamed = resolveAccessorySaleIntakeConfig({});
  const config = {
    ...renamed,
    fields: { ...ACCESSORY_SALE_FIELDS, name: '配品', amount: '实收', quantity: '件数', paymentMethod: '收法' },
    fieldIds: {}, // 故意不给列 id（模拟"她改了列名、事件里认不出"）⇒ 应走兜底读表 ✓
  };
  const item = {
    record_id: RECORD_ID, action: 'record_added',
    after_value: [
      { field_id: 'fld_name2', field_value: [{ record_ids: [NAME_ID] }] },
      { field_id: 'fld_qty2', field_value: 1 },
      { field_id: 'fld_method2', field_value: [{ text: '现金' }] },
      { field_id: 'fld_amount2', field_value: 88 },
      { field_id: 'fld_x', field_value: 'ignore' },
    ],
  };
  // ⚠️ 事件里的 field_id 是**列 id**；按列名取值的映射由配置给的列名 + 事件里的 field_id 决定
  //   ⇒ 这里模拟"她改了列名"：配置换名后，事件仍按 field_id 送 ⇒ 取不到 ⇒ 走兜底读表（如实 warn）
  const h = build({ config });
  const result = await h.service.handleTableChanges([item]);
  assert.equal(result.results[0].ok, false, '列名对不上 ⇒ **拒单**（不猜 ✗）');
  assert.equal(h.reads.length, 1, '取不到 ⇒ 走 `getByTableId` **兜底读表** ✓（路径打通）');
  assert.equal(logs.some((entry) => entry.event === 'accessory_sale_intake.fallback_read'), true,
    '🔴 兜底必须**如实记一条 warn**（"事件没带全 ⇒ 回退读表"）✗ 不许静默');

  const off = build({ config: configWithIds({ enabled: false }) });
  const disabled = await off.service.handleTableChanges([actionItem()]);
  assert.equal(disabled.enabled, false);
  assert.equal(off.lines.length + off.sales.length + off.writes.length, 0, '关掉 ⇒ **零动作** ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-AS7 回写：开关关 ⇒ 0 次；列不在 ⇒ 只记日志（**不假写** ✗）；⭐ 只许写那两列
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS7 🔴 回写开关**关** ⇒ **一次写都不发**（假网关写调用 0 次）', async () => {
  logs.length = 0;
  const config = configWithIds();
  const h = build({ config: { ...config, writeBack: { ...config.writeBack, enabled: false } } });
  const result = await h.service.handleTableChanges([actionItem()]);
  assert.equal(result.results[0].ok, true, '成单照办 ✓');
  assert.equal(h.writes.length, 0, '🔴 回写关掉 ⇒ **一个写请求都没有** ✓');
});

test('AC-AS7b 🔴 列不在（飞书报错）⇒ **不报错、只记日志**（**绝不假写** ✗，成单结果不受影响）', async () => {
  logs.length = 0;
  const h = build({ gatewayOpts: { failWrite: 'FieldNameNotFound: 写入状态' } });
  const result = await h.service.handleTableChanges([actionItem()]);
  assert.equal(result.results[0].ok, true, '回写失败**不许**把成单改成失败 ✓');
  assert.equal(h.writes.length, 1, '试写过一次 ✓');
  const warned = logs.find((entry) => entry.event === 'accessory_sale_intake.writeback.failed');
  assert.ok(warned, '必须**如实记一条 warn**（含原因）✓');
  assert.match(warned.fields.error, /FieldNameNotFound/);
});

test('AC-AS7c ⭐⭐ **Lead 加的硬约束**：回写 `fields` 的 key **恰好 ⊆ {写入状态, 失败原因}**（多一列 ⇒ 红）', async () => {
  logs.length = 0;
  const done = build();
  await done.service.handleTableChanges([actionItem()]);
  const failed = build();
  await failed.service.handleTableChanges([actionItem({ amount: 0 })]);
  for (const write of [...done.writes, ...failed.writes]) {
    for (const key of Object.keys(write.fields)) {
      assert.equal(WRITE_KEYS.has(key), true,
        `🔴 回写只许写那两列 ✗ —— 它填的列（名称/数量/收款方式/金额/销售日）一个都不许碰（实际带了 \`${key}\`）`);
    }
    for (const forbidden of ['名称', '数量', '收款方式', '金额', '销售日']) {
      assert.equal(Object.keys(write.fields).includes(forbidden), false, `🔴 不许把「${forbidden}」写回去 ✗`);
    }
  }
});

test('AC-AS7d 🔴 `updateByTableId` 空 `fields` ⇒ **当场抛**（白跑一次调用 ✗）', async () => {
  const { V1BitableGateway } = require('../src/services/v1BitableGateway');
  const gateway = new V1BitableGateway({ client: { bitable: { appTableRecord: { update: async () => ({ code: 0 }) } } } });
  await assert.rejects(() => gateway.updateByTableId({ tableId: 'tbl_a', recordId: 'rec_a', fields: {} }), /需要 fields/);
  await assert.rejects(() => gateway.updateByTableId({ tableId: '', recordId: 'rec_a', fields: { 写入状态: 'x' } }), /需要 tableId/);
});
