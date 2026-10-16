'use strict';

/**
 * ⭐⭐ 2026-10-16（业务负责人当天点名「**补货和验收两个都需要**」）——
 * **补货（报货）那条链的「明细攒批」** 的验收标准（**先写后做** ✓）。
 *
 * ── 为什么是这一处（逐行核过，不靠转述）────────────────────────────────────
 *   补货（报货）：`purchaseWebhookService.publishPurchaseRequest`（免确认，一行转发）
 *     → `confirmPurchaseRequest` → `for (const item of plan.items)` 里**逐条**
 *       `createOnceByKey('purchaseRequest', …)`
 *       ⇒ 每条要 **1 次整表读**（`listByKey` → `gateway.listAll('purchaseRequest')`）
 *         ＋ **1 次 create** ⇒ 5 条 = **5 次整表读 + 5 次 create**（飞书单次 RT 实测 8~11 秒）。
 *   ⚠️ 同一段里还有第 6 次整表读来自 `detailIds.open`（明细取号）—— 它读的**是同一张表**
 *      ⇒ 攒批时**与幂等回查共用这一次读**（否则就是"为了省请求，结果又多读一次"）。
 *   ⚠️ **验收那条不用动**：它 2026-10-13 已经批量化落进 main 了
 *      （`8077a73 release: acceptance batch write (31->5 calls, writes 10->2) (#425)`，
 *        `InventoryService.applyPurchaseBatch`）—— 本文件用 **AC-PB7** 把它现在的数字
 *        一起量出来当"没回退"的证据 ✓，**不改它一个字** ✗。
 *
 * ── 验收标准（每条都写明「去掉哪一句就该红」）──────────────────────────────
 *   AC-PB1  ⭐ 提速可量：5 条明细 ⇒ `listAll('purchaseRequest')` **恰好 1 次**（取号与幂等回查共用）、
 *           逐条 `create('purchaseRequest')` **0 次**、`createBatch('purchaseRequest')` **1 次**
 *           ／ 去掉"共用那一次读"或"批量建" ⇒ 红
 *   AC-PB1b 常绿对照（证明"为什么要攒批"）：同输入走**逐条基线** ⇒ 整表读 ≥6 次、逐条 create 5 次
 *           ／ 把基线改成批量 ⇒ 这条会跟着变，说明它真的在量 ✓
 *   AC-PB2  ⭐⭐ **结果逐字段等价（本文件最重要的一条）**：同样的输入 ⇒
 *           批 与 逐条 ⇒ **采购明细表 ＋ 报货批次表 ＋ 结果对象 ＋ 本地任务记录**
 *           四份**逐字节相同**（`deepEqual` 整张表，含 record_id / 物理列名 / 值 / 行序）
 *           ／ 少写一行、少一个字段、幂等键写错、明细 ID 漂了 ⇒ 红
 *   AC-PB3  ⭐ 幂等：同一 task 重放 ⇒ **零写**（`createBatch` 0 次）、行数不变、
 *           每行 `采购明细ID` 一字不变、`request_ids` 相同 ／ 去掉"先按幂等键回查" ⇒ 红
 *   AC-PB4  ⭐ 续跑：① 进度里有前 2 条（远端也有）⇒ 只补后 3 条；
 *           ② 远端有行、本地进度丢了（崩溃在落盘之前）⇒ **全部复用、零写**；
 *           ／ 去掉"按幂等键回查"或"按 plan.items 顺序取号" ⇒ 红
 *   AC-PB4b ⭐ 失败粒度与验收那条**同一档**（2026-10-13 的 AC-B4「整批一次写」）：
 *           明细那一次批量写失败 ⇒ 这几条**一条都不落**；重试 ⇒ 补齐、不重复
 *           ／ 失败后重试多写一行 ⇒ 红
 *   AC-PB4c 失败**文案**不变（只快、不改变"告诉人什么"）：重复幂等键 ⇒ 与逐条路径
 *           **同一句**错（`… 在远端命中 N 条记录，属于重复业务事实，已停止自动处理，请人工核对`）
 *           ／ 换一句文案 ⇒ 红
 *   AC-PB5  ⭐ 出图 / 发群不变：3 个供应商 ⇒ **每组一张图**、群消息**条数与改前相同**、
 *           附件名与逐条路径**逐字一致** ／ 少一组 / 多一条消息 / 附件名变形 ⇒ 红
 *   AC-PB6  ⭐ 库存：补货这条链**零库存写入**（`applyPurchase` / `applyPurchaseBatch` 都不许被调到）
 *           ／ 顺手"加个库存" ⇒ 红
 *   AC-PB7  ⭐ 两条链各自的数字（不是只快补给 ✗）：补货 = 整表读 1 / 写 1；
 *           验收 = 逐条 `create` **0 次**、批量写 **≤2 次**（它 10-13 已经批量，且**没被本刀弄回退**）
 *   AC-PB8  ⭐ **模块化哨兵：不许第二套批量形态** —— 补货这条链必须复用
 *           退货那一刀（#749）已经落进 main 的 `infrastructure/idempotencyKey.createOnceByKeys`，
 *           仓库里**不许**再出现与之并列的第二个"批量幂等创建"实现
 *           ／ 另起一个同功能的 helper ⇒ 红
 *   AC-PB8b 网关**没有批量口**（老替身 / 未接线）⇒ 退回逐条：与改动前**逐字节同形**
 *           （0 次 `createBatch`、N 次逐条 `create`、表内容与批那条路同一串明细 ID）
 *   AC-PB9  ⚠️ 边界如实说（不是"更快"的装饰）：重复幂等键 / 尺码解析不出来这类**前置判据**
 *           在攒批路径上**建行之前**就抛 ⇒ **一条明细都不建**（改前是"前面几条已建、到那条才抛"）。
 *           这条 AC 把它**钉成显式行为**，不许"悄悄变成半截批次" ✓
 *
 * 🔴 冻结件哨兵不在这里重复：`services/scanWriteService.js` 的逐字节冻结由
 *    `test/scanWriteServiceFrozen.test.js` 的 **AC-FRZ1** 钉住（本刀一个字节都没碰它 ✓）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_purchase_detail_batch';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'purchase_detail_batch_secret';
process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';
process.env.PURCHASE_CHAT_ID = process.env.PURCHASE_CHAT_ID || 'oc_test_purchase_group';

const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKeys } = require('../src/infrastructure/idempotencyKey');

const F = (key) => V1_BITABLE_SCHEMA.tables[key].fields;
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `purchase-detail-batch-${label}-`));

// ═══════════════════════════════════════════════════════════════════════════
// 计数假网关：每一次远端调用都留痕（判"调用次数"的**唯一依据**，不拿时间抖动当证据）
//   · `batchCapable: false` = 只实现逐条 `create`（= 改动前那条路 / 既有用例里的替身）
//   · `batchCapable: true`  = 额外实现 `createBatch`（= 真网关今天的样子）
//   ⚠️ 语义键 → 物理列名照真 schema 映射（写错语义键当场抛），否则"按幂等键回查"永远查不到。
// ═══════════════════════════════════════════════════════════════════════════
const createFakeGateway = ({
  seed = {}, batchCapable = true, failBatchAt = 0, batchRejected = false, partialWriteOnFail = 0,
} = {}) => {
  const tables = {};
  Object.entries(seed).forEach(([key, rows]) => {
    tables[key] = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      record_id: row?.record_id || `${key}_seed_${index + 1}`,
      fields: { ...(row?.fields || row || {}) },
    }));
  });
  const calls = [];
  let sequence = 0;
  let batchCount = 0;
  const physical = (key, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[key];
    if (!table) throw new Error(`未知表: ${key}`);
    const out = {};
    for (const [semanticKey, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[semanticKey];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${semanticKey}`);
      if (value !== undefined) out[name] = value;
    }
    return out;
  };
  const push = (key, values) => {
    sequence += 1;
    const record = { record_id: `${key}_${sequence}`, fields: physical(key, values) };
    tables[key] = [...(tables[key] || []), record];
    return record;
  };
  const gateway = {
    tables,
    calls,
    table: (key) => V1_BITABLE_SCHEMA.tables[key] || null,
    listAll: async (key) => {
      calls.push({ kind: 'listAll', table: key });
      return (tables[key] || []).map((record) => ({ ...record, fields: { ...record.fields } }));
    },
    listByFilter: async () => { throw new Error('假网关不支持 filter（本文件的链路不该用到它）'); },
    get: async (key, id) => (tables[key] || []).find((record) => record.record_id === id) || null,
    findOneByText: async (key, semanticKey, expected) => {
      const name = V1_BITABLE_SCHEMA.tables[key]?.fields?.[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find(
        (record) => String(record.fields?.[name] ?? '').trim() === target,
      ) || null;
    },
    create: async (key, values) => {
      calls.push({ kind: 'create', table: key, values });
      if (batchRejected) {
        // 真飞书的"字段不存在"这类拒绝**逐条也会被拒** ⇒ 假件必须两边都拒，
        // 否则"退回逐条"会假装成功（那就测不出真实行为了）
        const error = new Error('create rejected: 字段不存在（用例故意）');
        error.bitableRejected = true;
        throw error;
      }
      const record = push(key, values);
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      calls.push({ kind: 'update', table: key, record_id: id });
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      Object.assign(record.fields, physical(key, values));
      return record;
    },
    uploadAttachment: async (filePath) => {
      const name = path.basename(String(filePath || ''));
      calls.push({ kind: 'upload', table: '', file: name });
      // ⚠️ token 由**文件名**决定（不是"第几次调用"）⇒ 两条路径的附件单元格**逐字可比**
      //    （真飞书的 token 是不透明 id，这里只需"同一张图 ⇒ 同一个 token"这个语义 ✓）
      return `file_token:${name}`;
    },
  };
  if (batchCapable) {
    gateway.createBatch = async (key, rows) => {
      calls.push({ kind: 'createBatch', table: key, count: rows.length, values: rows });
      batchCount += 1;
      if (batchRejected) {
        // 飞书**结构化拒绝**（字段不存在这类）：可以确定没写 ⇒ 调用方必须原样抛、不回落
        const error = new Error('batch rejected: 字段不存在（用例故意）');
        error.bitableRejected = true;
        throw error;
      }
      if (failBatchAt && batchCount === failBatchAt) {
        // ⚠️ 非结构化失败（超时 / 5xx 这类"写入结果未知"）：可以**先落了一半**再炸 ——
        //    这正是"回落逐条时必须按幂等键回查"的那个现场 ✓（`partialWriteOnFail` 来控制写几行）
        if (key === 'purchaseRequest' && partialWriteOnFail > 0) {
          rows.slice(0, partialWriteOnFail).forEach((values) => push(key, values));
        }
        throw new Error('boom: 明细批量写失败（用例故意）');
      }
      return rows.map((values) => {
        const record = push(key, values);
        return { recordId: record.record_id, fields: record.fields };
      });
    };
  }
  return gateway;
};

// ═══════════════════════════════════════════════════════════════════════════
// 报货（补货）链的真 `PurchaseWebhookService`：假网关 ＋ 假出图 / 假飞书 / 数库存调用
// ═══════════════════════════════════════════════════════════════════════════
const SIZES = [40, 41, 42, 43, 44];
/** 12 个尺码都备着：**同一条链在 N=5 与 N=12 上的调用次数**要一起量出来（证明"常数级"而不是"少一点"）✓ */
const ALL_SIZES = Array.from({ length: 12 }, (_, index) => 40 + index);

const seedTables = (overrides = {}) => ({
  sizeManagement: ALL_SIZES.map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
  supplier: [
    { record_id: 'sup_a', fields: { 供应商名称: '甲供应商' } },
    { record_id: 'sup_b', fields: { 供应商名称: '乙供应商' } },
  ],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  ...overrides,
});

const reportHarness = ({
  batchCapable = true, failBatchAt = 0, batchRejected = false, partialWriteOnFail = 0, tables,
} = {}) => {
  const gateway = createFakeGateway({
    seed: seedTables(tables || {}), batchCapable, failBatchAt, batchRejected, partialWriteOnFail,
  });
  const renders = [];
  const messages = [];
  const inventoryCalls = [];
  let batchNoCalls = 0;
  const service = new PurchaseWebhookService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('webhook'), idField: 'task_id' }),
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1', record: { record_id: 'prod_1', fields: {} } }),
      resolveSupplier: async () => null,
      resolveBehavior: async () => ({ recordId: 'bh_request', record: { record_id: 'bh_request', fields: {} } }),
    },
    inventory: {
      applyPurchase: async (payload) => { inventoryCalls.push({ kind: 'applyPurchase', payload }); return {}; },
      applyPurchaseBatch: async (payload) => { inventoryCalls.push({ kind: 'applyPurchaseBatch', payload }); return []; },
    },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'img_key' }) },
        message: {
          create: async (payload) => {
            messages.push({ kind: 'create', ...payload });
            return { code: 0, data: { message_id: `m_${messages.length}`, thread_id: 'th_1' } };
          },
          reply: async (payload) => {
            messages.push({ kind: 'reply', ...payload });
            return { code: 0, data: { message_id: `m_${messages.length}`, thread_id: 'th_1' } };
          },
        },
      },
    },
    images: {
      render: async (input) => {
        renders.push(input);
        return Buffer.from(`png:${input.supplierName || ''}`);
      },
    },
    orderBatches: new PurchaseOrderBatchService({ gateway }),
    batchLocator: { rememberGroupMessage: async () => ({ ok: true }) },
    batchNoGenerator: {
      runExclusive: async (work) => work(),
      next: async () => { batchNoCalls += 1; return { batchNo: 'CGD-20261016-0001' }; },
    },
    sandboxChatId: 'oc_test_group',
  });
  return {
    gateway, service, renders, messages, inventoryCalls,
    batchNoCalls: () => batchNoCalls,
  };
};

const line = (supplier, size, quantity, product = 'prod_1') => ({
  product_record_id: product, item_no: product, color: '黑色',
  size, quantity, supplier_record_id: supplier, behavior_record_id: 'bh_request',
});

/** 「一单多货品」的报货草稿（3 家 A ÷ 2 家 B ⇒ 顺便覆盖 AC-PB5 的分组）。 */
const reportDraft = (items) => ({
  is_batch: true,
  operator_open_id: 'ou_1',
  supplier_record_id: '',
  behavior_record_id: 'bh_request',
  items: items || [
    line('sup_a', 40, 2), line('sup_a', 41, 1), line('sup_a', 42, 3),
    line('sup_b', 43, 1), line('sup_b', 44, 2),
  ],
});

const seedTask = (service, taskId, draft) => service.store.create({
  task_id: taskId, kind: 'scan_replenish', status: 'posting', draft,
});

/** 调用次数汇总（报告里的"改前/改后"就用它打出来的数）✓ */
const callCounts = (gateway) => gateway.calls.reduce((acc, call) => {
  const key = `${call.kind}:${call.table || '-'}`;
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

const physicalRows = (gateway, tableKey) => (gateway.tables[tableKey] || []).map((record) => ({
  record_id: record.record_id,
  fields: record.fields,
}));

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB1 / AC-PB1b 提速可量（补货那条链）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB1 ⭐ N 条明细 ⇒ 整表读**恰好 1 次**（与 N 无关）、逐条 create **0 次**、批量 create **1 次**', async () => {
  for (const count of [5, 12]) {
    const h = reportHarness({ batchCapable: true });
    const task = await seedTask(h.service, `t_pb1_${count}`, reportDraft(
      ALL_SIZES.slice(0, count).map((size, index) => line(index % 2 ? 'sup_b' : 'sup_a', size, index % 3 + 1)),
    ));
    const result = await h.service.publishPurchaseRequest(`t_pb1_${count}`, task);
    const counts = callCounts(h.gateway);
    console.log(`   [攒批 N=${count}] 明细那一处：整表读`, counts['listAll:purchaseRequest'] || 0,
      '次 · 批量写', counts['createBatch:purchaseRequest'] || 0,
      '次 · 逐条写', counts['create:purchaseRequest'] || 0,
      '次 · 整条链远端调用合计 =', h.gateway.calls.length);

    // ① 明细取号 与 幂等回查 **共用同一次整表读** ⇒ 与 N 无关，恒为 1（去掉共用 ⇒ 变成 2 ⇒ 红）
    assert.equal(counts['listAll:purchaseRequest'] || 0, 1,
      `N=${count}：采购明细表的整表读必须**恰好一次**（取号 + 幂等回查共用），实际 ${counts['listAll:purchaseRequest'] || 0} 次`);
    // ② 明细**不再逐条 create**（那是 N 次 ≈ N×8 秒 的来源）
    assert.equal(counts['create:purchaseRequest'] || 0, 0,
      `N=${count}：攒批通路里**不许**再逐条 create 采购明细`);
    // ③ 一次批量建（也与 N 无关：N≤500 时就是 1 次）
    assert.equal(counts['createBatch:purchaseRequest'] || 0, 1,
      `N=${count}：明细必须**一次批量**建完（实际 ${counts['createBatch:purchaseRequest'] || 0} 次）`);
    // ④ 业务结果没少：N 条明细一条不少
    assert.equal((h.gateway.tables.purchaseRequest || []).length, count, `N=${count}：明细一条都不能少`);
    assert.equal(result.request_ids.length, count);
  }
});

test('AC-PB1b 常绿对照：同输入走**逐条基线** ⇒ 整表读 = N+1、逐条 create = N（这就是要攒批的理由）', async () => {
  for (const count of [5, 12]) {
    const h = reportHarness({ batchCapable: false });
    const task = await seedTask(h.service, `t_pb1b_${count}`, reportDraft(
      ALL_SIZES.slice(0, count).map((size, index) => line(index % 2 ? 'sup_b' : 'sup_a', size, index % 3 + 1)),
    ));
    await h.service.publishPurchaseRequest(`t_pb1b_${count}`, task);
    const counts = callCounts(h.gateway);
    console.log(`   [逐条基线 N=${count}] 明细那一处：整表读`, counts['listAll:purchaseRequest'] || 0,
      '次 · 逐条写', counts['create:purchaseRequest'] || 0,
      '次 · 整条链远端调用合计 =', h.gateway.calls.length);

    assert.equal(counts['create:purchaseRequest'] || 0, count, `逐条基线 = ${count} 次 create（一个一个建）`);
    assert.equal(counts['createBatch:purchaseRequest'] || 0, 0, '逐条基线没有批量口');
    assert.equal(counts['listAll:purchaseRequest'] || 0, count + 1,
      `逐条基线 = 1 次取号 + 每条 1 次幂等回查 = ${count + 1} 次整表读（实际 ${counts['listAll:purchaseRequest'] || 0}）`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB2 ⭐⭐ 结果逐字段等价（本文件最重要的一条）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB2 ⭐⭐ 同样的输入 ⇒ 批 与 逐条 ⇒ 四份结果**逐字节相同**', async () => {
  const legacy = reportHarness({ batchCapable: false });
  const legacyTask = await seedTask(legacy.service, 't_pb2', reportDraft());
  const legacyResult = await legacy.service.publishPurchaseRequest('t_pb2', legacyTask);

  const batched = reportHarness({ batchCapable: true });
  const batchedTask = await seedTask(batched.service, 't_pb2', reportDraft());
  const batchedResult = await batched.service.publishPurchaseRequest('t_pb2', batchedTask);

  // ① 采购明细表：整张表逐字节相同（record_id / 物理列名 / 值 / **行序**）
  assert.deepEqual(physicalRows(batched.gateway, 'purchaseRequest'),
    physicalRows(legacy.gateway, 'purchaseRequest'),
    '采购明细表必须逐字节相同（少一行 / 少一列 / 幂等键或明细ID 漂了 ⇒ 红）');
  // ② 报货批次表（含「录入数量」「采购行为」「单据」附件列）
  assert.deepEqual(physicalRows(batched.gateway, 'purchaseOrderBatch'),
    physicalRows(legacy.gateway, 'purchaseOrderBatch'),
    '报货批次那一行必须逐字节相同');
  // ③ 返回给调用方的结果对象（request_ids / request_id_by_item_key / batch_no / image_delivery…）
  assert.deepEqual(batchedResult, legacyResult, '服务返回值必须逐字相同');
  // ④ 本地任务记录（posting_progress / posting_stage 的**逐条落盘顺序**也照旧）
  //    ⚠️ 只排掉两个**时间戳**（`created_at` / `updated_at` 是"什么时候跑的"，不是业务内容；
  //       两条路各跑一次必然不同）—— 其余每一个键都参与逐字节比较 ✓
  const taskWithoutTimestamps = (task) => {
    const { created_at: _c, updated_at: _u, ...rest } = task || {};
    return rest;
  };
  assert.deepEqual(
    taskWithoutTimestamps(await batched.service.store.get('t_pb2')),
    taskWithoutTimestamps(await legacy.service.store.get('t_pb2')),
    '本地任务记录（进度 / 阶段 / 明细 id 表）必须逐字相同',
  );

  // ⑤ 逐字段点名核一遍（不是"整表相同"一句话糊过去 —— 这几列是她真正看的）
  const rows = batched.gateway.tables.purchaseRequest;
  assert.deepEqual(rows.map((row) => row.fields[F('purchaseRequest').detailId]),
    ['CGD-20261016-0001-01', 'CGD-20261016-0001-02', 'CGD-20261016-0001-03',
      'CGD-20261016-0001-04', 'CGD-20261016-0001-05'],
    '「采购明细ID」按明细顺序 01..05（不重号、不跳号）');
  assert.deepEqual(rows.map((row) => row.fields[F('purchaseRequest').quantity]), [2, 1, 3, 1, 2],
    '「数量」逐条相同');
  assert.deepEqual(rows.map((row) => row.fields[F('purchaseRequest').size]),
    SIZES.map((size) => [`size_${size}`]), '「尺码」关联逐条相同');
  assert.deepEqual(rows.map((row) => row.fields[F('purchaseRequest').idempotencyKey]),
    SIZES.map((_, index) => `purchase_request:t_pb2:${index}`), '「幂等键」逐条相同（重放的唯一依据）');
  assert.deepEqual(rows.map((row) => row.fields[F('purchaseRequest').batchNo]),
    Array(5).fill([batched.gateway.tables.purchaseOrderBatch[0].record_id]),
    '每条明细都挂在**同一个批次行**上');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB3 / AC-PB4 幂等 与 续跑
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB3 ⭐ 重放同一个 task ⇒ **零写**、行数不变、明细 ID 与 request_ids 一字不变', async () => {
  const h = reportHarness({ batchCapable: true });
  const task = await seedTask(h.service, 't_pb3', reportDraft());
  const first = await h.service.publishPurchaseRequest('t_pb3', task);
  const detailIdsBefore = h.gateway.tables.purchaseRequest.map((row) => row.fields[F('purchaseRequest').detailId]);
  const before = h.gateway.calls.length;

  // 重放（拿同一份 task —— 与"崩溃后重试"同形）
  const again = await h.service.publishPurchaseRequest('t_pb3', await h.service.store.get('t_pb3'));
  const writesAfter = h.gateway.calls.slice(before)
    .filter((call) => ['create', 'createBatch', 'update', 'updateBatch', 'delete'].includes(call.kind));

  assert.equal((h.gateway.tables.purchaseRequest || []).length, 5, '重放不许把明细翻倍');
  assert.deepEqual(h.gateway.tables.purchaseRequest.map((row) => row.fields[F('purchaseRequest').detailId]),
    detailIdsBefore, '重放不许重排 / 重占明细 ID');
  assert.deepEqual(again.request_ids, first.request_ids, '重放返回同一批明细记录 id');
  assert.equal(writesAfter.filter((call) => call.kind === 'createBatch').length, 0,
    `重放必须零写（实际 ${writesAfter.length} 次写：${JSON.stringify(writesAfter.map((c) => `${c.kind}:${c.table}`))}）`);

  // ② ⭐⭐ **真正的"幂等"那一层**：把本地进度清掉（远端那几行还在）⇒ 必须**按幂等键回查**、零写。
  //    ⚠️ 为什么必须有这一条：只靠"进度还在"那种重放**抓不住"回查被删掉"**这个变异
  //       （进度在 ⇒ 根本不会走到建行那一步）—— 变异测试 M2 就是这么发现这条 AC 原来是假绿的 ✓
  const cleared = await h.service.store.update('t_pb3', { posting_progress: { requests: {} } });
  const callsBeforeCleared = h.gateway.calls.length;
  const replayed = await h.service.publishPurchaseRequest('t_pb3', cleared);
  const writesAfterCleared = h.gateway.calls.slice(callsBeforeCleared)
    .filter((call) => ['create', 'createBatch', 'update', 'updateBatch', 'delete'].includes(call.kind)
      && call.table === 'purchaseRequest');
  assert.equal((h.gateway.tables.purchaseRequest || []).length, 5,
    '本地进度丢了、远端还在 ⇒ 只能靠**幂等键回查**兜住（再建一次 ⇒ 红）');
  assert.equal(writesAfterCleared.length, 0,
    `进度丢了也不许重复建行（实际又写了 ${writesAfterCleared.length} 次：${JSON.stringify(writesAfterCleared.map((c) => c.kind))}）`);
  assert.deepEqual(replayed.request_ids, first.request_ids, '回查命中的就是原来那几行（记录 id 不变）');
  assert.deepEqual(h.gateway.tables.purchaseRequest.map((row) => row.fields[F('purchaseRequest').detailId]),
    detailIdsBefore, '明细 ID 仍然是原来那一串（不被重排 / 不被重占）');
});

test('AC-PB4 ⭐ 续跑：进度有前 2 条 ⇒ 只补后 3 条；远端有行但进度丢了 ⇒ 全部复用、零写', async () => {
  // ① 本地进度里有前 2 条（远端确实也有那两行）⇒ 只补后 3 条
  const h = reportHarness({
    batchCapable: true,
    tables: {
      purchaseOrderBatch: [], purchaseRequest: [],
    },
  });
  const task = await seedTask(h.service, 't_pb4', reportDraft());
  // 先真跑一次拿到"前 2 条"的远端身份，再模拟"只落了前 2 条进度"的中断现场
  await h.service.publishPurchaseRequest('t_pb4', task);
  const allRows = h.gateway.tables.purchaseRequest.slice();
  assert.equal(allRows.length, 5);
  // 把后 3 行从远端"撤掉"，并把本地进度回退成只有前 2 条 —— 就是"跑到一半断了"的形状
  h.gateway.tables.purchaseRequest = allRows.slice(0, 2);
  const partial = await h.service.store.get('t_pb4');
  const plan = partial.posting_plan;
  await h.service.store.update('t_pb4', {
    posting_progress: {
      batch_record_id: partial.posting_progress.batch_record_id,
      requests: {
        [plan.items[0].item_key]: allRows[0].record_id,
        [plan.items[1].item_key]: allRows[1].record_id,
      },
    },
    posting_stage: 'request_created:1',
    status: 'posting',
  });
  const callsBefore = h.gateway.calls.length;
  const resumed = await h.service.publishPurchaseRequest('t_pb4', await h.service.store.get('t_pb4'));
  const batchCalls = h.gateway.calls.slice(callsBefore).filter((call) => call.kind === 'createBatch');
  assert.equal((h.gateway.tables.purchaseRequest || []).length, 5, '续跑补齐到 5 条（不重不漏）');
  assert.equal(batchCalls.length, 1, '续跑只发一次批量建');
  assert.equal(batchCalls[0].count, 3, '续跑**只补**后 3 条（前 2 条按幂等键命中 ⇒ 不再建）');
  assert.deepEqual(resumed.request_ids.slice(0, 2), allRows.slice(0, 2).map((row) => row.record_id),
    '已有的那两条**复用**原来的记录 id');
  // 明细 ID 接着排（不改已有两行）
  assert.deepEqual(h.gateway.tables.purchaseRequest.map((row) => row.fields[F('purchaseRequest').detailId]),
    ['CGD-20261016-0001-01', 'CGD-20261016-0001-02', 'CGD-20261016-0001-03',
      'CGD-20261016-0001-04', 'CGD-20261016-0001-05'],
    '后补的接着排、已有行不重排 ✓');

  // ② 远端有行、本地进度**丢了**（崩在落盘之前）⇒ 全部复用 ⇒ **零写**
  const lost = reportHarness({ batchCapable: true });
  const seedRows = SIZES.map((size, index) => ({
    record_id: `remote_${index + 1}`,
    fields: {
      [F('purchaseRequest').batchNo]: [],
      [F('purchaseRequest').product]: ['prod_1'],
      [F('purchaseRequest').size]: [`size_${size}`],
      [F('purchaseRequest').quantity]: 1,
      [F('purchaseRequest').detailId]: `CGD-20261016-0001-0${index + 1}`,
      [F('purchaseRequest').idempotencyKey]: `purchase_request:t_pb4b:${index}`,
    },
  }));
  const lostTask = await seedTask(lost.service, 't_pb4b', reportDraft());
  lost.gateway.tables.purchaseRequest = seedRows;
  await lost.service.publishPurchaseRequest('t_pb4b', lostTask);
  const lostWrites = lost.gateway.calls
    .filter((call) => ['create', 'createBatch'].includes(call.kind) && call.table === 'purchaseRequest');
  assert.equal(lostWrites.length, 0,
    `远端已有的行必须按幂等键**全部复用**（实际又写了 ${lostWrites.length} 次）`);
});

test('AC-PB4b ⭐ 批量那条路失败 ⇒ **回落逐条**（行为与改前逐条完全一致：补齐、不重复）', async () => {
  // ① 非结构化失败（超时 / 5xx 这类"写入结果未知"）⇒ **不重发批量**，回落逐条 ⇒ 补齐 5 条
  const h = reportHarness({ batchCapable: true, failBatchAt: 1 });
  const task = await seedTask(h.service, 't_pb4c', reportDraft());
  const result = await h.service.publishPurchaseRequest('t_pb4c', task);
  assert.equal((h.gateway.tables.purchaseRequest || []).length, 5, '回落逐条 ⇒ 5 条全补齐（少了 ⇒ 红）');
  assert.equal(new Set(result.request_ids).size, 5, '5 条记录 id 互不相同（没有重复建行）');
  assert.equal(callCounts(h.gateway)['createBatch:purchaseRequest'], 1, '批量只试一次（不许重发）');
  assert.equal(callCounts(h.gateway)['create:purchaseRequest'], 5, '一条都没写进去 ⇒ 回落逐条补 5 次');
  assert.deepEqual((h.gateway.tables.purchaseRequest || [])
    .map((row) => row.fields[F('purchaseRequest').detailId]),
  ['CGD-20261016-0001-01', 'CGD-20261016-0001-02', 'CGD-20261016-0001-03',
    'CGD-20261016-0001-04', 'CGD-20261016-0001-05'], '补出来的明细 ID 仍按顺序 01..05');

  // ② 批量"写了一半才失败"（远端其实落了 2 行）⇒ 回落逐条 + **按幂等键回查** ⇒ 只补剩下 3 条、不重复
  const half = reportHarness({ batchCapable: true, failBatchAt: 1, partialWriteOnFail: 2 });
  const halfTask = await seedTask(half.service, 't_pb4c2', reportDraft());
  const halfResult = await half.service.publishPurchaseRequest('t_pb4c2', halfTask);
  assert.equal((half.gateway.tables.purchaseRequest || []).length, 5, '半截 + 补齐 = 5 条（翻倍 ⇒ 红）');
  assert.equal(new Set(halfResult.request_ids).size, 5, '每条明细只对应一行');
  assert.equal(callCounts(half.gateway)['create:purchaseRequest'], 3,
    '前 2 条已被批量写进去 ⇒ 回落逐条只补剩下 3 条（不重复建行）');
  assert.deepEqual((half.gateway.tables.purchaseRequest || [])
    .map((row) => row.fields[F('purchaseRequest').detailId]).sort(),
  ['CGD-20261016-0001-01', 'CGD-20261016-0001-02', 'CGD-20261016-0001-03',
    'CGD-20261016-0001-04', 'CGD-20261016-0001-05'], '不重号、不跳号');

  // ③ 飞书**结构化拒绝**（字段不存在这类，可以确定没写）⇒ 如实抛、**一行都不许落**
  //    （批量件把任何失败都退回逐条；逐条那一条会当场抛 ⇒ 落表 0 行、不静默、不半截）
  const rejected = reportHarness({ batchCapable: true, batchRejected: true });
  const rejectedTask = await seedTask(rejected.service, 't_pb4c3', reportDraft());
  const error = await rejected.service.publishPurchaseRequest('t_pb4c3', rejectedTask)
    .then(() => null, (e) => e);
  assert.ok(error, '结构化拒绝必须抛（不许静默吞掉）');
  assert.equal(error.bitableRejected, true, '标记照旧（上层据它区分"被拒"与"结果未知"）');
  assert.equal((rejected.gateway.tables.purchaseRequest || []).length, 0,
    '被拒 ⇒ 一行都不许落（半截批次比"没写"更难查）');
});

test('AC-PB4c 失败**文案**不变：重复幂等键 ⇒ 与逐条路径同一句「重复业务事实…请人工核对」', async () => {
  const duplicated = () => ([
    { record_id: 'dup_1', fields: { [F('purchaseRequest').idempotencyKey]: 'purchase_request:t_pb4d:0' } },
    { record_id: 'dup_2', fields: { [F('purchaseRequest').idempotencyKey]: 'purchase_request:t_pb4d:0' } },
  ]);
  const legacy = reportHarness({ batchCapable: false, tables: { purchaseRequest: duplicated() } });
  const legacyTask = await seedTask(legacy.service, 't_pb4d', reportDraft());
  const legacyError = await legacy.service.publishPurchaseRequest('t_pb4d', legacyTask).then(
    () => null, (error) => error,
  );
  const batched = reportHarness({ batchCapable: true, tables: { purchaseRequest: duplicated() } });
  const batchedTask = await seedTask(batched.service, 't_pb4d', reportDraft());
  const batchedError = await batched.service.publishPurchaseRequest('t_pb4d', batchedTask).then(
    () => null, (error) => error,
  );
  assert.ok(legacyError && batchedError, '两条路都必须抛（不许静默挑一条）');
  assert.equal(batchedError.message, legacyError.message, '同一句错，一个字都不改（快不等于换说辞）');
  assert.equal(batchedError.duplicateBusinessFact, true, '标记照旧（回查循环不许把它吞掉）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB5 出图 / 发群不变
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB5 ⭐ 3 个供应商 ⇒ 每组一张图、群消息条数与改前相同、附件名逐字一致', async () => {
  const draft = reportDraft([
    line('sup_a', 40, 2), line('sup_a', 41, 1),
    line('sup_b', 42, 3), line('sup_a', 43, 1), line('sup_b', 44, 2),
  ]);
  const legacy = reportHarness({ batchCapable: false });
  const legacyTask = await seedTask(legacy.service, 't_pb5', draft);
  const legacyResult = await legacy.service.publishPurchaseRequest('t_pb5', legacyTask);

  const batched = reportHarness({ batchCapable: true });
  const batchedTask = await seedTask(batched.service, 't_pb5', draft);
  const batchedResult = await batched.service.publishPurchaseRequest('t_pb5', batchedTask);

  assert.equal(batched.renders.length, 2, '2 个供应商 ⇒ 2 张报货单（不分组 ⇒ 只 1 张 ⇒ 红）');
  for (const render of batched.renders) {
    assert.equal(new Set(render.items.map((item) => item.supplier_record_id)).size, 1,
      '每一组只含一个供应商的行');
  }
  assert.deepEqual(batched.renders.map((render) => render.items.length),
    legacy.renders.map((render) => render.items.length), '每组的行数与改前相同');
  assert.deepEqual(batched.renders.map((render) => render.supplierName),
    legacy.renders.map((render) => render.supplierName), '组名与顺序与改前相同');
  assert.equal(batched.messages.length, legacy.messages.length,
    `群消息条数必须与改前**相同**（改前 ${legacy.messages.length} / 改后 ${batched.messages.length}）`);
  assert.equal(batched.messages.length, 4, '2 组 × （1 张图 + 1 条 @文字）= 4 条');
  // 「单据」附件列（文件名 = 这一组的报货单身份）也要逐字一致
  assert.deepEqual(batched.gateway.tables.purchaseOrderBatch[0].fields[F('purchaseOrderBatch').document],
    legacy.gateway.tables.purchaseOrderBatch[0].fields[F('purchaseOrderBatch').document],
    '「单据」附件列逐字相同（每组一张、文件名不变）');
  assert.equal(batchedResult.image_delivery.group_count, legacyResult.image_delivery.group_count);
  assert.equal(batchedResult.image_delivery.sent.length, legacyResult.image_delivery.sent.length);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB6 库存：补货这条链一个字都不写库存
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB6 ⭐ 补货这条链**零库存写入**（一个字都不许顺手加库存）', async () => {
  const h = reportHarness({ batchCapable: true });
  const task = await seedTask(h.service, 't_pb6', reportDraft());
  await h.service.publishPurchaseRequest('t_pb6', task);
  assert.deepEqual(h.inventoryCalls, [],
    '补货 = 建单；加库存是**验收**那一步的事（这里被调到一次 ⇒ 红）');
  assert.equal(callCounts(h.gateway)['create:liveInventory'] || 0, 0, '实时库存零写入');
  assert.equal(callCounts(h.gateway)['create:inventoryLedger'] || 0, 0, '库存流水零写入');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB7 两条链各自的数字（不是只快补给 ✗）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB7 ⭐ 两条链各自的数字：补货 = 读 1 / 写 1；验收 = 逐条 create 0、批量写 ≤2', async () => {
  // ── ① 补货（本刀改的就是它）──
  const purchase = reportHarness({ batchCapable: true });
  const task = await seedTask(purchase.service, 't_pb7', reportDraft());
  await purchase.service.publishPurchaseRequest('t_pb7', task);
  const purchaseCounts = callCounts(purchase.gateway);
  const purchaseWrites = Object.entries(purchaseCounts)
    .filter(([key]) => /^(create|createBatch|update):purchaseRequest$/.test(key))
    .reduce((sum, [, value]) => sum + value, 0);
  console.log('   [补货] 明细那一处：整表读', purchaseCounts['listAll:purchaseRequest'] || 0,
    '次 · 写', purchaseWrites, '次（createBatch 1 次）');

  // ── ② 验收（2026-10-13 已经批量；这里量的是"它现在还是批量的"）──
  const calls = [];
  const data = {
    behavior: [{
      record_id: 'beh_in',
      fields: {
        [F('behavior').code]: 'STOCK_PURCHASE_INCREASE',
        [F('behavior').name]: '采购入库',
        [F('behavior').stockDirection]: '增加',
        [F('behavior').enabled]: true,
      },
    }],
    sizeManagement: SIZES.map((size) => ({ record_id: `size_${size}`, fields: { [F('sizeManagement').size]: size } })),
    liveInventory: [],
    inventoryLedger: [],
  };
  const physical = (tableKey, values) => {
    const map = V1_BITABLE_SCHEMA.tables[tableKey].fields;
    const out = {};
    for (const [key, value] of Object.entries(values || {})) out[map[key] || key] = value;
    return out;
  };
  const pushRow = (key, values) => {
    const record = { record_id: `${key}_${data[key].length + 1}`, fields: physical(key, values) };
    data[key].push(record);
    return record.record_id;
  };
  const inventory = new InventoryService({
    gateway: {
      table: (key) => V1_BITABLE_SCHEMA.tables[key],
      listAll: async (key) => { calls.push({ kind: 'listAll', table: key }); return data[key] || []; },
      create: async (key, values) => { calls.push({ kind: 'create', table: key }); return { recordId: pushRow(key, values) }; },
      createBatch: async (key, rows) => {
        calls.push({ kind: 'createBatch', table: key, count: rows.length });
        return rows.map((values) => ({ recordId: pushRow(key, values), fields: physical(key, values) }));
      },
      updateBatch: async (key, patches) => {
        calls.push({ kind: 'updateBatch', table: key, count: patches.length });
        return patches.map((patch) => ({ recordId: patch.recordId, fields: {} }));
      },
      update: async (key, id, values) => { calls.push({ kind: 'update', table: key, id }); return { recordId: id, fields: physical(key, values) }; },
    },
    store: new JsonTaskStore({ dir: tempDir('inventory'), idField: 'operation_id' }),
  });
  assert.equal(typeof inventory.applyPurchaseBatch, 'function',
    '验收那条的批量口必须还在（2026-10-13 落的 #425，本刀不许把它弄回退）');
  const results = await inventory.applyPurchaseBatch(SIZES.map((size) => ({
    purchaseBatchRecordId: 'rec_batch_row',
    purchaseBatchNo: 'CGD-20261016-0001',
    arrivalTaskId: 'arrival_task_1',
    productRecordId: 'prod_1',
    size,
    quantity: 1,
    state: '门盒',
  })));
  const acceptCounts = calls.reduce((acc, call) => {
    const key = `${call.kind}:${call.table}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  console.log('   [验收] 5 码 · 远端调用逐项 =', JSON.stringify(acceptCounts));
  assert.equal(results.length, 5);
  assert.equal(acceptCounts['create:inventoryLedger'] || 0, 0, '验收：流水不许逐条 create');
  assert.equal(acceptCounts['create:liveInventory'] || 0, 0, '验收：实时库存不许逐条 create');
  assert.ok((acceptCounts['createBatch:inventoryLedger'] || 0) + (acceptCounts['createBatch:liveInventory'] || 0) <= 2,
    '验收：批量写 ≤2 次');
  // 两条链的目标口径一致：明细那一处 / 库存那一处都 ≤2 次写
  assert.ok(purchaseWrites <= 2, `补货明细那一处写 ≤2 次（实际 ${purchaseWrites}）`);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB8 模块化：复用退货那一刀落进 main 的批量件（不许第二套）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB8 ⭐ 补货与退货**共用同一个批量件**（仓库里不许出现第二套"批量幂等创建"）', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'purchaseWebhookService.js'), 'utf8',
  );
  assert.match(source, /createOnceByKeys/,
    '补货那条链必须调 `infrastructure/idempotencyKey.createOnceByKeys`（与退货同一个）');
  assert.equal(typeof createOnceByKeys, 'function',
    '那个批量件必须存在（退货那一刀 #749 落的；本刀只是复用它）');
  // 服务层不许绕过批量件自己拼第二套（幂等回查会一起被绕过 ✗）
  assert.equal(/gateway\.createBatch\(/.test(source), false,
    '服务层不许直接 gateway.createBatch(...)（幂等回查会一起被绕过）');
  // `infrastructure/` 里"按幂等键 + 批量建"只许有一处实现
  const infraDir = path.join(__dirname, '..', 'src', 'infrastructure');
  const offenders = fs.readdirSync(infraDir)
    .filter((name) => name.endsWith('.js') && name !== 'idempotencyKey.js')
    .filter((name) => {
      const text = fs.readFileSync(path.join(infraDir, name), 'utf8');
      return /createBatch\s*\(/.test(text) && /幂等键/.test(text);
    });
  assert.deepEqual(offenders, [],
    `批量幂等创建只许有 idempotencyKey.js 一处（实际还有：${offenders.join('、')}）—— 别发明第二套 ✗`);
});

test('AC-PB8b 网关**没有批量口** ⇒ 退回逐条（与改动前**逐字节同形**）', async () => {
  const noBatchPort = reportHarness({ batchCapable: false });
  const noBatchTask = await seedTask(noBatchPort.service, 't_pb8', reportDraft());
  const result = await noBatchPort.service.publishPurchaseRequest('t_pb8', noBatchTask);
  const counts = callCounts(noBatchPort.gateway);
  assert.equal(counts['createBatch:purchaseRequest'] || 0, 0, '没有批量口 ⇒ 一次批量都不发');
  assert.equal(counts['create:purchaseRequest'], 5, '退回逐条 = 5 次 create（改动前就是这条路）');
  assert.equal((noBatchPort.gateway.tables.purchaseRequest || []).length, 5);
  assert.equal(result.request_ids.length, 5);
  assert.deepEqual((noBatchPort.gateway.tables.purchaseRequest || [])
    .map((row) => row.fields[F('purchaseRequest').detailId]),
  ['CGD-20261016-0001-01', 'CGD-20261016-0001-02', 'CGD-20261016-0001-03',
    'CGD-20261016-0001-04', 'CGD-20261016-0001-05'], '逐条那条路的明细 ID 与攒批那条路同一串');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-PB9 边界如实说：前置判据在**建行之前**抛 ⇒ 一条明细都不建
// ═══════════════════════════════════════════════════════════════════════════

test('AC-PB9 尺码解析不出来 ⇒ 攒批路径**一条明细都不建**（前置判据先跑；改前是半截）', async () => {
  const h = reportHarness({ batchCapable: true });
  const task = await seedTask(h.service, 't_pb9', reportDraft([
    line('sup_a', 40, 1), line('sup_a', 41, 1), line('sup_a', 99, 1),
  ]));
  const error = await h.service.publishPurchaseRequest('t_pb9', task).then(() => null, (e) => e);
  assert.ok(error, '尺码管理里没有 99 码 ⇒ 必须抛（不静默写半截）');
  assert.match(error.message, /99/);
  assert.equal((h.gateway.tables.purchaseRequest || []).length, 0,
    '攒批路径：前置判据没过 ⇒ 一条明细都不建（**这是与改前的唯一差别**，如实钉住）');
});
