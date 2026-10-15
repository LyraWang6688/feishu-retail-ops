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
 *   **AC-AS4** 金额缺失/≤0 · 数量非法（0/负/小数）· 关联为空 ⇒ **不成单** + 回写 `写入失败` + 人话原因 ✓
 *   **AC-AS4b** ⭐ 数量 = N ⇒ **拆成 N 行**（她 2026-10-15：「销售明细里是一行一件…按数量拆成对应的记录数」）
 *              ＋ 金额摊到 N 行（整元按整元摊：100/3 ⇒ 34/33/33；Σ **严格** = 总额）＋ 收款明细只有 1 行 ✓
 *   **AC-AS9** 录单人 = **事件里的操作人**（谁填的表谁是录单人）；会话键 = 前缀 + 记录 ID（每行独立会话）✓
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
const fakeEngine = ({
  lineOk = true, saleOk = true, saleReused = false, backgroundOf = null,
} = {}) => {
  const lines = [];
  const sales = [];
  return {
    lines, sales,
    engine: {
      addSaleLine: async (input) => { lines.push(input); return lineOk ? { ok: true } : { ok: false, message: '明细没记上' }; },
      submitSale: async (input) => {
        sales.push(input);
        if (!saleOk) return { ok: false, message: '成单失败' };
        const result = { ok: true, order_no: `XSD-${sales.length}`, reused: saleReused };
        // ⚠️ 异步那一跑（⑰ 默认开）：真引擎会回一个 `background` 句柄
        if (backgroundOf) result.background = backgroundOf(sales.length);
        return result;
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
  // ⭐⭐ 2026-10-15（Lead 裁决）：**会话键**与**操作人**是两个概念 ——
  //   会话键 = 前缀 + 记录 ID（每行独立会话）；操作人 = 事件里的操作人（没有 ⇒ 配置兜底 ⇒ 空 = 不写那一列）
  assert.equal(h.lines[0].sessionKey, `accessory_sale:${RECORD_ID}`, '⭐ 会话键 = 前缀 + 记录 ID ✓');
  assert.equal(h.sales[0].sessionKey, `accessory_sale:${RECORD_ID}`, '提交也走**同一个**会话 ✓');
  assert.equal(h.lines[0].openId, '', '没带操作人 / 没配 ⇒ 录单人**留空**（绝不编一个 id ✗）');
  assert.equal(h.sales[0].openId, '', '同上 ✓');
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

// ⭐⭐ 2026-10-15 **口径更新**（Lead 转达业务负责人逐字）：
//   「**我们销售明细里是一行一件，如果配品是两件，那就拆开，按照数量拆成对应的记录数**」
//   ⇒ 数量 = N ⇒ **拆成 N 条明细**（不再是"数量 > 1 就拒单"）。
//
//   改前逐字（本刀第一版）：`assert.equal(result.results[0].ok, false, '3 件必须拒 ✓')`
//     ＋ `assert.match(h.writes[0].fields['失败原因'], /1 件/, '…一次只记 1 件…')`
//   改后逐字：`assert.equal(h.lines.length, 3, 'N 件 ⇒ **恰好 N 行**（一行一件）')`
//     ＋ `assert.equal(sum(金额), 300, '🔴 Σ = 她填的总额（不许翻倍 ✗）')`
//   依据：她的口径从"这一版一次只记 1 件"升级为"**按数量拆成对应的记录数**" ✓
//         改判据这件事本身**只这一次**，且是**跟着她的口径走**（不是为了让测试变绿 ✗）。

test('AC-AS4b ⭐ 数量 = 3 ⇒ **明细恰好 3 行**（一行一件），金额摊成 34/33/33、Σ = 100、收款明细只有 1 行', async () => {
  logs.length = 0;
  const h = build();
  const result = await h.service.handleTableChanges([actionItem({ quantity: 3, amount: 100 })]);
  assert.equal(result.results[0].ok, true, '3 件要**办得成**（拆行，不再拒单 ✓）');
  assert.equal(h.lines.length, 3, '🔴 **恰好 3 行**（不是 1 行 ✗）');
  assert.deepEqual(h.lines.map((line) => line.amount), ['34', '33', '33'],
    '⭐ 金额摊到 3 行：前 r 行各 +1、最后一行 = 总额 − 前和（100 ⇒ 34/33/33）✓');
  assert.equal(h.lines.reduce((sum, line) => sum + Number(line.amount), 0), 100,
    '🔴 **Σ = 她填的总额**（不许翻倍 / 不许少 ✗）');
  assert.deepEqual(h.lines.map((line) => line.accessoryRecordId), [NAME_ID, NAME_ID, NAME_ID], '每行都是那件配品 ✓');
  assert.equal(h.sales.length, 1, '只提交**一次** ✓');
  assert.equal(h.sales[0].submitKey, RECORD_ID, '幂等键一个字没变（= 记录 ID）✓');
  // ⚠️ 收款明细**只有 1 行**、金额 = 总额（否则 Σ 会翻倍 ✗）
  assert.deepEqual(h.sales[0].payments, [{ method: '微信', amount: '100' }], '🔴 收款明细 1 行 = 总额 ✓');
  assert.equal(h.sales[0].paidAmount, '100');
  // 每一行都走同一个会话（同一把会话键）
  assert.deepEqual([...new Set(h.lines.map((line) => line.sessionKey))], [`accessory_sale:${RECORD_ID}`]);
});

test('AC-AS4b2 ⭐ 金额 100 / 数量 1 ⇒ 仍是 1 行、金额 = 全额（回归）', async () => {
  logs.length = 0;
  const h = build();
  await h.service.handleTableChanges([actionItem({ quantity: 1, amount: 100 })]);
  assert.equal(h.lines.length, 1, '1 件 ⇒ 1 行 ✓');
  assert.deepEqual(h.lines.map((line) => line.amount), ['100']);
});

test('AC-AS4b3 ⭐ 金额带角分 ⇒ 按**分**摊（100.5 / 3 ⇒ 33.50 × 3，Σ 一分不差）', async () => {
  logs.length = 0;
  const h = build();
  await h.service.handleTableChanges([actionItem({ quantity: 3, amount: 100.5 })]);
  assert.deepEqual(h.lines.map((line) => line.amount), ['33.50', '33.50', '33.50'],
    '她填到角 ⇒ 按分摊（不凭空造出整元 ✗）✓');
  assert.equal(h.lines.reduce((sum, line) => sum + Number(line.amount), 0), 100.5, 'Σ = 100.5 ✓');
  assert.deepEqual(h.sales[0].payments, [{ method: '微信', amount: '100.5' }], '收款明细仍是 1 行 = 总额 ✓');
});

test('AC-AS4b4 🔴 金额摊不开（1 元 / 3 件）⇒ 拒单 + 零写入（**绝不静默记 1 件** ✗）', async () => {
  logs.length = 0;
  const h = build();
  const result = await h.service.handleTableChanges([actionItem({ quantity: 3, amount: 1 })]);
  assert.equal(result.results[0].ok, false, '摊不成 3 行（一行至少 1 元）⇒ 拒 ✓');
  assert.equal(h.lines.length + h.sales.length, 0, '🔴 **零写入**（不许只加一行、也不许记 1 件 ✗）');
  assert.equal(h.writes[0].fields['写入状态'], '写入失败');
  assert.match(h.writes[0].fields['失败原因'], /摊不成/, '人要能看懂为什么拒 ✓');
});

test('AC-AS4b5 🔴 数量超过引擎的单据行数上限 ⇒ 拒单 + 零写入（不是加到一半被引擎拒）', async () => {
  logs.length = 0;
  const { SCAN_WRITE } = require('../src/config/scanWrite');
  const over = Number(SCAN_WRITE.session.maxLines) + 1;
  const h = build();
  const result = await h.service.handleTableChanges([actionItem({ quantity: over, amount: over * 10 })]);
  assert.equal(result.results[0].ok, false, `${over} 件超过上限 ⇒ 拒 ✓`);
  assert.equal(h.lines.length + h.sales.length, 0, '🔴 零写入（本地草稿里也不留半截 ✗）');
  assert.match(h.writes[0].fields['失败原因'], /上限/);
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
  assert.equal(ok.lines.length, 1, '1 件 ⇒ 1 行 ✓');
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
// AC-AS9 录单人 = **事件里的操作人**（谁填的表谁是录单人）；会话键 = 前缀 + 记录 ID
// ═══════════════════════════════════════════════════════════════════════════

test('AC-AS9 ⭐ 录单人 = 事件里的操作人（官方事件形状 `operator_id.open_id`）⇒ 就是引擎的 openId', async () => {
  logs.length = 0;
  const h = build();
  // ⚠️ `drive.file.bitable_record_changed_v1` 的官方形状：操作人在**顶层** `operator_id`
  const event = { operator_id: { union_id: 'on_x', open_id: 'ou_who_filled' } };
  const result = await h.service.handleTableChanges([actionItem()], { event });
  assert.equal(result.results[0].ok, true);
  assert.equal(h.lines[0].openId, 'ou_who_filled', '⭐ 谁填的表，谁就是「录单人」✓');
  assert.equal(h.sales[0].openId, 'ou_who_filled', '提交那一跑也是他 ✓');
  assert.equal(result.operator_open_id, 'ou_who_filled', '结果里如实带出来（可排查 ✓）');
});

test('AC-AS9b ⭐ 事件没带操作人 ⇒ 配置出口；配置也没有 ⇒ **空**（不写这一列，绝不编 id ✗）', async () => {
  logs.length = 0;
  const configured = build({ config: configWithIds({ operatorOpenId: 'ou_configured' }) });
  await configured.service.handleTableChanges([actionItem()], { event: { operator_id: {} } });
  assert.equal(configured.lines[0].openId, 'ou_configured', '事件没带 ⇒ 用配置出口 ✓');

  const empty = build({ config: configWithIds({ operatorOpenId: '' }) });
  await empty.service.handleTableChanges([actionItem()], { event: {} });
  assert.equal(empty.lines[0].openId, '', '两处都没有 ⇒ **空**（空 id = 这一列不写 ✓，绝不编 ✗）');

  const explicit = build();
  await explicit.service.handleTableChanges([actionItem()], { operatorOpenId: 'ou_explicit', event: {} });
  assert.equal(explicit.lines[0].openId, 'ou_explicit', '显式注入优先（用例/其它入口可以点名）✓');
});

test('AC-AS9c ⭐ 会话键**与操作人无关**（同一行换谁操作 ⇒ 还是**同一个会话** ⇒ 幂等不许被拆开）', async () => {
  logs.length = 0;
  const a = build();
  await a.service.handleTableChanges([actionItem()], { event: { operator_id: { open_id: 'ou_a' } } });
  const b = build();
  await b.service.handleTableChanges([actionItem()], { event: { operator_id: { open_id: 'ou_b' } } });
  assert.equal(a.lines[0].sessionKey, b.lines[0].sessionKey, '会话键只认**记录 ID** ✓（换人不变）');
  assert.equal(a.sales[0].submitKey, b.sales[0].submitKey, '幂等键同样只认记录 ID ✓');
});

test('AC-AS10 ⭐ `splitAmount` 纯件：整元按整元摊 / 带角分按分摊 / **Σ 永远 = 总额**', () => {
  const { splitAmount, centsToAmountText } = require('../src/services/accessorySaleIntakeService');
  const text = (total, n) => splitAmount(total, n).parts.map(centsToAmountText);
  assert.deepEqual(text(100, 3), ['34', '33', '33'], '整元 ⇒ 34/33/33（Lead 裁决的那条判据）✓');
  assert.deepEqual(text(100, 1), ['100']);
  assert.deepEqual(text(101, 3), ['34', '34', '33']);
  assert.deepEqual(text(100.5, 3), ['33.50', '33.50', '33.50'], '带角分 ⇒ 按分摊 ✓');
  assert.deepEqual(text(0.03, 3), ['0.01', '0.01', '0.01']);
  for (const [total, n] of [[100, 3], [101, 3], [100.5, 3], [0.03, 3], [999.99, 7], [1, 1]]) {
    const sum = splitAmount(total, n).parts.reduce((acc, cents) => acc + cents, 0);
    assert.equal(sum, Math.round(total * 100), `${total} / ${n}：Σ 必须 = 总额（分）✓`);
    assert.ok(splitAmount(total, n).parts.every((cents) => cents > 0), `${total} / ${n}：每行都 > 0 ✓`);
  }
  assert.equal(splitAmount(1, 3).ok, false, '1 元 / 3 件摊不开 ⇒ 如实 false ✓');
  assert.equal(splitAmount(0.02, 3).ok, false, '2 分 / 3 件也摊不开 ⇒ 如实 false ✓');
});

test('AC-AS11 ⭐⭐ 异步那一跑（**默认开**）⇒ **等它跑完**再回写：跑成 ⇒ 已写入；没跑成 ⇒ **写入失败**（不假成功 ✗）', async () => {
  logs.length = 0;
  // ① 后台跑成 ⇒ 已写入（而且要等它 —— 用"跑完才 resolve"的 promise 钉住）
  let settled = false;
  const okRun = build({
    engineOpts: {
      backgroundOf: () => new Promise((resolve) => {
        setImmediate(() => { settled = true; resolve({ ok: true, order_no: 'XSD-1' }); });
      }),
    },
  });
  const okResult = await okRun.service.handleTableChanges([actionItem()]);
  assert.equal(settled, true, '必须**等后台那一跑**跑完才继续 ✓');
  assert.equal(okResult.results[0].ok, true);
  assert.equal(okRun.writes[0].fields['写入状态'], '已写入');

  // ② 后台**抛了**（句柄解析成 undefined，引擎那边已把主表落「写入失败」）⇒ 我们也不许写"已写入"
  const threw = build({ engineOpts: { backgroundOf: () => Promise.resolve(undefined) } });
  const threwResult = await threw.service.handleTableChanges([actionItem()]);
  assert.equal(threwResult.results[0].ok, false, '🔴 后台没跑成 ⇒ 这一行**不许算成功** ✗');
  assert.equal(threw.writes[0].fields['写入状态'], '写入失败');
  assert.ok(logs.some((entry) => entry.event === 'accessory_sale_intake.failed'), '如实记日志 ✓');

  // ③ 后台**回了 ok:false** ⇒ 把它的原因写回「失败原因」
  const failed = build({ engineOpts: { backgroundOf: () => Promise.resolve({ ok: false, message: '明细没记上' }) } });
  const failedResult = await failed.service.handleTableChanges([actionItem()]);
  assert.equal(failedResult.results[0].ok, false);
  assert.equal(failed.writes[0].fields['写入状态'], '写入失败');
  assert.match(failed.writes[0].fields['失败原因'], /明细没记上/);
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
