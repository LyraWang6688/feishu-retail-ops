/**
 * ⭐⭐ 2026-10-12 热修（业务负责人当天把「采购明细.采购行为」改成 **Lookup**）：
 * **这一列是只读的 ⇒ 代码一律不许再往它写值；读取照旧保留。**
 *
 * 现场（`scan-sales` 的 5 张表只读字段审计）：生产真表里
 *   「采购明细.采购行为」= **Lookup(19)**（`target_table=tblwezby9wRea9qi`、`target_field=采购行为`，
 *   按「报货批次号」关联）—— 而她今天才改成 Lookup 的；
 * 而代码建明细行时**还在写这一列** ⇒ 轻则白写被忽略、**重则整条明细 create 失败**
 *   （那样"这批报货一条明细都建不出来"）。
 *
 * 处理：**只撤写入、保留读取**
 *   · 撤：`purchaseWebhookService.js`（报货/采购申请那条）与 `purchaseReturnService.js`
 *     （扫码采购退货那条）里 `tableKey: 'purchaseRequest'` 的 create payload **都不再有** `behavior:`；
 *   · 留：`v1BitableSchema` 的映射 `purchaseRequest.fields.behavior = '采购行为'` 仍在
 *     （工作台采购查询的分流判据 `purchaseQueryService.classifyReportBehavior` 还在**读**它）。
 *
 * ⭐⭐ **她 2026-10-12 已确认「采购主表.采购行为」要写**（原话逐字：
 *   「**采购主表里面的采购行为确实是需要的，因为一个是报货，一个是退货**」）：
 *   · **报货**（`purchaseWebhookService.confirmPurchaseRequest` 建主表行）⇒ 写**采购申请**那一档；
 *   · **退货**（`purchaseOrderBatchService.createForReturnBatch` 建主表行）⇒ 写**采购退货**那一档；
 *   · 值一律用**行为记录 id** + `relation(...)`（不写中文名/编码字面量）；
 *   · 明细那列是主表按「报货批次号」关联的 **Lookup（只读）** ⇒ 明细侧**一律不写**，
 *     值由主表**带出来**（语义不变）。
 *   ⚠️ 旧的「不用管」（她 2026-10-07 说的）**已作废**。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 验收标准（**先写后做**）
 *
 *  AC-B1 **源码哨兵**：两个 service 里 `tableKey: 'purchaseRequest'` 的 create payload
 *         不许再出现 `behavior:`（也不许再出现 `relation(item.behavior_record_id)` 那种写法）。
 *  AC-B2 **读取必须还在**：schema 映射 + 工作台分流判据的读取点一个字不动。
 *  AC-B3 ⭐ **主表必须有写入点**（她 2026-10-12 确认要写）：报货建的 `purchaseOrderBatch` payload
 *         必须含 `behavior: relation(...)`；退货的 `createForReturnBatch` 同样；**值必须是
 *         行为记录 id 的 `relation(...)`**（不许写中文名/编码字面量），空 id 时由 `relation` 返 `undefined`
 *         让网关跳过（不写空值）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (relative) => fs.readFileSync(path.join(SRC, relative), 'utf8');

/** 从 `tableKey: '<key>'` 起截一段窗口（到那次调用结束），用于看那一处 create 的 payload。 */
const payloadWindow = (source, tableKey, length = 900) => {
  const windows = [];
  let at = 0;
  while (true) {
    const index = source.indexOf(`tableKey: '${tableKey}'`, at);
    if (index < 0) break;
    const end = source.indexOf('});', index);
    windows.push(source.slice(index, end < 0 ? index + length : end));
    at = index + 1;
  }
  return windows;
};

const ON = { purchaseRequest: '采购明细', purchaseOrderBatch: '采购主表' };

// ═══════════════════════════════════════════════════════════════════════════
// AC-B1 源码哨兵：明细行的 payload 里不再有「采购行为」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B1 源码哨兵：建「采购明细」行的 payload 里不许再写「采购行为」（报货 + 退货两条路）', () => {
  for (const rel of ['services/purchaseWebhookService.js', 'services/purchaseReturnService.js']) {
    const source = read(rel);
    const windows = payloadWindow(source, 'purchaseRequest');
    assert.ok(windows.length > 0, `${rel} 里应当有建「${ON.purchaseRequest}」行的地方（否则这条哨兵是空的）`);
    for (const window of windows) {
      assert.equal(/\bbehavior\s*:/.test(window), false,
        `${rel}：建「${ON.purchaseRequest}」行的 payload 里不许再出现 behavior（Lookup 只读）`);
      assert.equal(/behavior_record_id\s*\)/.test(window), false,
        `${rel}：不许再把 behavior_record_id 关联进这一列`);
    }
  }
  // ⚠️ 反向：也不许"换个写法偷偷写"（例：先建再 update 那一列）
  for (const rel of ['services/purchaseWebhookService.js', 'services/purchaseReturnService.js']) {
    const source = read(rel);
    assert.equal(/update\(\s*'purchaseRequest'[^)]*behavior/.test(source), false,
      `${rel}：不许用 update 往「${ON.purchaseRequest}.采购行为」补写`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B2 读取必须还在（只撤写入）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B2 读取照旧：schema 映射还在，工作台采购查询仍按这一列分流报货 / 退货', () => {
  const schema = read('config/v1BitableSchema.js');
  // ⭐ 2026-10-17 成对迁移（依据 = 她逐字「采购主表里面的采购行为，目前字段名称改为了发生行为」）：
  //   改前逐字：`/behavior: '采购行为'/`；改后逐字：`/behavior: '发生行为'/`（真表已改名）。
  assert.match(schema, /behavior: '发生行为'/, 'schema 映射必须留着（读取靠它；真表列名 = 发生行为）');
  // 分流判据的读取点（`purchaseQueryService`）：按关联 id 读行为记录，再 classifyReportBehavior
  const query = read('services/purchaseQueryService.js');
  // ⭐ 2026-10-17 成对迁移（依据 = 她逐字「直接去看采购主表里面的采购行为…只筛选出报货的状态」）：
  //   改前逐字：`asLinks('purchaseRequest', record, 'behavior')`（明细行 Lookup，一直空 ⇒ 全默认报货 ✗）
  //   改后逐字：`asLinks('purchaseOrderBatch', batch, 'behavior')`（读主表那一行的「发生行为」✓）
  assert.match(query, /asLinks\('purchaseOrderBatch', batch, 'behavior'\)/, '分流读取点 = 主表「发生行为」');
  assert.equal(/asLinks\('purchaseRequest', record, 'behavior'\)/.test(query), false, '不再读明细行那个 Lookup（它一直是空 ✗）');
  assert.match(query, /classifyReportBehavior\(/, '分流判据还在');
  assert.match(query, /report_behavior: classifyReportBehavior/, '分流的落点字段还在');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-B3 待定项如实钉住：主表那一列现在没有写入点
// ═══════════════════════════════════════════════════════════════════════════

test('AC-B3 主表必须有写入点：报货 / 退货建主表行都写「采购行为」（值 = 行为记录 id）', () => {
  // ① 报货那一路（`confirmPurchaseRequest` 里建 `purchaseOrderBatch` 的那次 create）
  const webhook = read('services/purchaseWebhookService.js');
  const webhookBatch = payloadWindow(webhook, 'purchaseOrderBatch');
  assert.ok(webhookBatch.length > 0, '报货链路里应当有建主表行的地方（否则这条哨兵是空的）');
  assert.ok(webhookBatch.some((window) => /\bbehavior:\s*relation\(/.test(window)),
    '报货建主表行必须写「采购行为」（她 2026-10-12：「一个是报货，一个是退货」）');
  // ② 退货那一路（`createForReturnBatch`）
  const batches = read('services/purchaseOrderBatchService.js');
  const returnBatch = payloadWindow(batches, 'purchaseOrderBatch');
  assert.ok(returnBatch.some((window) => /\bbehavior:\s*relation\(behaviorRecordId\)/.test(window)),
    '退货建主表行也必须写「采购行为」');
  assert.equal(returnBatch.some((window) => /behavior:\s*relation\(\s*\)/.test(window)), false,
    '不许写空值（空 id 应该由 relation 返 undefined、让网关跳过）');
  // ③ 值必须是**行为记录 id**（不是中文名 / 编码字面量）
  assert.equal(/behavior:\s*relation\(\s*['"]/.test(webhook + batches), false,
    '「采购行为」要写行为记录 id，不许写中文名或编码字面量');
  // ④ 调用方把 id 传给了退货那条（否则永远是空）
  assert.match(read('services/purchaseReturnService.js'),
    /createForReturnBatch\(plan\.batch_no,\s*\{[^}]*behaviorRecordId:\s*draft\.behavior_record_id/,
    '退货调用点必须把 draft.behavior_record_id 传下去');
  // ⑤ 旧口径的注释必须已经改掉（否则以后有人照着旧注释又把写入删掉）
  assert.equal(batches.includes('「采购行为」这一列**此刻意不读、不写、不映射**'), false,
    '文件头那句"不用管"的口径已被她 2026-10-12 推翻，注释要同步');
});
