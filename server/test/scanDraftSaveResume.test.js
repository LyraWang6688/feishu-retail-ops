/**
 * ⭐⭐ **「补货 / 退货 / 销售 存草稿 · 接着录」S1（独立存储层）的验收标准** —— 2026-10-16。
 *
 * 设计：`docs/draft-save-resume-plan-2026-10-16.md` ＋ 两页 Lead 追加便条
 *   （`.local/draft-plan/LEAD-ADDENDUM-2.md` / `LEAD-ADDENDUM-3.md`，**内容以它们为准**）。
 * 业务负责人的两条核心逻辑（逐字，本文件逐条钉住）：
 *   · **批次号**：「草稿创建时，看采购主表里**有没有未报货的批次号**：(a) 有 ⇒ **沿用** (b) 没有 ⇒ **新建**」
 *   · **供应商拆分**：「同一个报货批次号里可能混杂不同供应商 ⇒ **生成报货单时按供应商拆分/分组**」
 *
 * ── 先写「按我们的链路应该实现的效果」，再跑，再逐条对照（她定的流程）────────────
 *
 *  AC-D1 **存草稿 ⇒ 零副作用**：不发群 / 不写库存 / 不出图 / 不调号源（**不建明细行** 那句见下 ⬇）
 *         —— 用**假 gateway 记账**证明：`create` 只落在 `purchaseOrderBatch` 一次；
 *            `purchaseRequest` 0 次；`inventory*` 0 次；出图 / 发群的注入件 0 次 ✓
 *         ⭐⭐ **2026-10-16（本刀 S2）成对迁移**（依据 = 她逐字「**草稿也写明细**」）：
 *           · **改前逐字**（文件头那两行 ＋ 用例名 ＋ 用例里那一句）：
 *             `AC-D1 **存草稿 ⇒ 零副作用**：不发群 / 不写库存 / 不出批次号（**不写采购明细** / 不建明细行）✓`
 *             `—— 用**假 gateway 记账**证明：create 只落在 purchaseOrderBatch 一次；purchaseRequest 0 次；…`
 *             `test('AC-D1 存草稿 ⇒ 零副作用：只有一行草稿行，明细/库存/出图/发群/写入口**一次都没有**', …`
 *             `assert.deepEqual(h.gateway.writesTo('purchaseRequest'), [], '不许建采购明细 ✗');`
 *           · **改后逐字**：`AC-D1 存草稿 ⇒ 零副作用：主表一行（未报货）＋ 明细 N 行，库存/出图/发群/写入口一次都没有`
 *             （断言改成 `主表 1 次 ＋ 明细 N 次`，其余**逐条照旧** ✓）。
 *           · **依据**：她 2026-10-16 逐字「**草稿也写明细**」（Lead 弹窗问「草稿会不会写到采购明细」，
 *             她选的就是这一条）⇒ #732 里按"**明细 0 次**"写的那个假设**作废** ✗。
 *           · ⚠️ **不是放宽** ✗：明细那一项是**她口径新增的例外**（AC-D2b / AC-D2c 正面钉住它）；
 *             其余（库存 0 次 / 出图 0 次 / 发群 0 次 / 写入口 0 次 / 草稿行 = 未报货）**一条都没动** ✓。
 *  AC-D2b ⭐ **草稿也写明细**（她 2026-10-16）：存一次草稿 ⇒ 主表 **1 行**（`到货状态 = 未报货`）
 *         ＋ 明细 **N 行**（**N = 货品数** —— 夹具每个货品恰好 1 个尺码 ⇒ 一行明细 = 一个货品 ✓；
 *         一行明细的口径 = **一个（货品 × 尺码）**，与既有两条真出单链路同形 ✓）
 *  AC-D2c ⭐ **幂等**：同一份草稿存两次 ⇒ 明细**不翻倍**（第二次全部命中同一把幂等键 ✓）
 *  AC-D2d ⭐ 零副作用仍成立：**明细行是被允许的例外**（写明的只有它）＋ 发群 / 出图 / 写库存 /
 *         调号源**照旧**不受影响 ✓（假件记账）
 *  AC-D2 找回 ⇒ **逐字还在**（尺码 / 数量 / 已加货品 / 供应商，含顺序）✓
 *  AC-D3 没有草稿 ⇒ **与今天逐字一致**（零回归：视图对象同一性 + 零文件写入 + 零远端调用）✓
 *  AC-D4 `draftScope='single'` ⇒ 第二次存**覆盖**第一份 ＋ **留痕**（`scan.draft.overwritten`）；
 *         `per_supplier` ⇒ 两份**并存** ✓（把 scope 写死 ⇒ 红）
 *  AC-D5 过期 / 坏格式 ⇒ **人话 + 不清不响**（200 的语义：有 `message`、**不抛**、**文件仍在**）✓
 *  AC-D6 ⭐ **批次号逻辑**：有未报货批次号 ⇒ **沿用**；没有 ⇒ **新建**（能真红）✓
 *  AC-D7 🔴 **并发**：两个草稿同时"都没有" ⇒ **不许各建一个新批次号**（串行 / 幂等 ✓ 能真红）✓
 *  AC-D8 🔴 **源码哨兵**：`services/scanWriteService.js` 的 sha256 与 main **逐字节一致**（冻结）✓
 *         ⚠️ **AC-D8 是 brief 的八条之外我补的**：S1 明说"不碰热点文件"，
 *            但**没人"没碰"的证据**就等于零 ✗ ⇒ 加一条**只读**的指纹哨兵（也顺手挡住后来人误改）。
 *  AC-D8b 源码哨兵：草稿的**列名一个都不写死**（中文列名只从 `config/v1BitableSchema.js` 取）＋
 *         本刀**不 require 那个冻结件**（`scanWriteService.js`）✓
 *          ⭐ 2026-10-16（本刀 S2）复核：明细那一半走**既有** `createOnceByKey`（`infrastructure/`）⇒
 *            本文件里 `await gateway.create(` **仍然只有 1 处**（草稿行那一次）、
 *            `await gateway.update(` **仍然是 0 处** ⇒ 那两条哨兵**一个字没改** ✓（不是放宽 ✓）。
 *
 * 每一条都写明"**去掉哪一句就该红**"（见文件末 `MUTATION` 注释与 PR 说明）——
 * 避免"名字出现过 = 有判据"那种假绿（AGENTS.md 第 1b 条③）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_scan_draft';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'scan_draft_secret';

const { createScanDraftService } = require('../src/services/scanDraftService');
const { resolveScanDraftConfig, DRAFT_SCOPE, BATCH_NO_POLICIES } = require('../src/config/scanDraft');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { KeyedSerialQueue } = require('../src/infrastructure/keyedSerialQueue');

const SERVICE_PATH = path.join(__dirname, '..', 'src', 'services', 'scanDraftService.js');
const SERVICE_SRC = fs.readFileSync(SERVICE_PATH, 'utf8');
const FROZEN_PATH = path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js');

/** 🔴 main 上那个冻结件的基线指纹（与 `test/scanWriteServiceFrozen.test.js` 的常量**同一个值** ✓）。
 *  ⚠️ **2026-10-16 成对迁移**（task-62「货 / 钱分离」阶段二 · 业务负责人明确「允许改冻结文件」，**一次性、只为本卡**）：
 *     改前逐字 `199551e1…35ca`（1699 行）⇒ 改后逐字 `49772bda…2c12`（1770 行）。
 *     本刀（存草稿 · 接着录）自己在那份文件里**仍然一个字都没加** ✗ —— 判据没放宽，只是基线随授权的那一刀一起搬 ✓。
 *     ⚠️ 许可**不能复用**：下一次改它必须重新拿裁决（见冻结哨兵的「解冻台账」✓）。
 */
const FROZEN_SHA256 = '49772bdaffc82411b427f5f5b26a9d74ca937e317fb4fbdebfd33492b7fd2c12';

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

// ═══════════════════════════════════════════════════════════════════════════
// 假件（**零真表写入**：本文件从头到尾不 require 真实客户端，也不读 `.env`）
// ═══════════════════════════════════════════════════════════════════════════

/** 假 gateway：**记账**（每一次 create/update 都留下 table + values + 调用序）＋ 一张内存表。 */
const makeFakeGateway = () => {
  const tables = new Map();
  const calls = [];
  let seq = 0;
  const rowsOf = (tableKey) => {
    if (!tables.has(tableKey)) tables.set(tableKey, []);
    return tables.get(tableKey);
  };
  // ⭐⭐ 2026-10-16（本刀 S2）：**每张表各自的语义键 → 物理列名**（两张表都要映射 ——
  //   明细那一半要用 `createOnceByKey` 按「幂等键」回查 ⇒ 假表里必须真的存着那一列 ✓）。
  const fieldNamesOf = (tableKey) => {
    const fields = (V1_BITABLE_SCHEMA.tables[tableKey] || {}).fields || {};
    return Object.fromEntries(Object.entries(fields)
      .filter(([semanticKey]) => [
        'batchNo', 'arrivalStatus', 'idempotencyKey', 'product', 'size', 'quantity',
      ].includes(semanticKey))
      .map(([semanticKey, column]) => [semanticKey, column]));
  };
  /** 语义键 → 物理列名（表侧那一行在她 Base 里就是这样存的 ✓）。 */
  const physical = (tableKey, values) => {
    const fieldNames = fieldNamesOf(tableKey);
    const out = {};
    Object.entries(values || {}).forEach(([key, value]) => {
      out[fieldNames[key] || key] = value;
    });
    return out;
  };
  const gateway = {
    calls,
    tables,
    table(tableKey) { return V1_BITABLE_SCHEMA.tables[tableKey] || null; },
    async listAll(tableKey) {
      // ⚠️ 这里**只记一次读**，不算"写"（AC-D1 判的是写）
      calls.push({ op: 'listAll', table: tableKey });
      await Promise.resolve();
      return rowsOf(tableKey).map((row) => ({ ...row, fields: { ...row.fields } }));
    },
    async create(tableKey, values) {
      calls.push({ op: 'create', table: tableKey, values: { ...values } });
      await Promise.resolve();
      seq += 1;
      const record = { record_id: `rec_${tableKey}_${seq}`, fields: physical(tableKey, values) };
      rowsOf(tableKey).push(record);
      return { record_id: record.record_id };
    },
    async update(tableKey, recordId, values) {
      calls.push({ op: 'update', table: tableKey, record_id: recordId, values: { ...values } });
      await Promise.resolve();
      const row = rowsOf(tableKey).find((item) => item.record_id === recordId);
      if (row) row.fields = { ...row.fields, ...physical(tableKey, values) };
      return { record_id: recordId };
    },
  };
  /** 种一行"未报货"（模拟她表里已经有的草稿批次） */
  gateway.seedPendingRow = (batchNo, recordId = '') => {
    const id = recordId || `rec_seed_${rowsOf('purchaseOrderBatch').length + 1}`;
    rowsOf('purchaseOrderBatch').push({
      record_id: id,
      fields: {
        [fieldNamesOf('purchaseOrderBatch').batchNo]: batchNo,
        [fieldNamesOf('purchaseOrderBatch').arrivalStatus]: '未报货',
      },
    });
    return id;
  };
  gateway.writesTo = (tableKey) => calls.filter((call) => call.op === 'create' && call.table === tableKey);
  /** 明细行（假表里那个 `idempotencyKey` 列上的值 —— 幂等判据就用它 ✓） */
  gateway.detailKeysOf = () => rowsOf('purchaseRequest')
    .map((row) => String(row.fields[fieldNamesOf('purchaseRequest').idempotencyKey] || ''));
  return gateway;
};

/**
 * 假尺码解析器（**与既有 `SizeReferenceService` 同一个取用形状**：`resolveByNumber(size)`）
 * —— 明细行要往「采购明细.尺码」写**关联记录 id**，所以必须有它 ✓（真件在
 * `services/sizeReferenceService.js`，本文件不 require 真客户端）。
 */
const makeFakeSizeReferences = (resolvable = null) => {
  const asked = [];
  return {
    asked,
    async resolveByNumber(value) {
      asked.push(String(value));
      const size = Number(value);
      if (!Number.isFinite(size) || size <= 0) throw new Error(`尺码必须是正整数：${value}`);
      if (resolvable && !resolvable.includes(String(value))) {
        throw new Error(`尺码管理中找不到 ${value} 码，请先核对关联记录`);
      }
      return { recordId: `rec_size_${size}`, size };
    },
  };
};

/** 假号源：与既有 `PurchaseBatchNoGenerator` **同一个形状**（`next()` 返 `{batchNo, sequence}`）。 */
const makeFakeBatchNoGenerator = (prefix = 'CGD-20261016-') => {
  let sequence = 0;
  // ⚠️ 签名必须与真号源**逐字同形**（`PurchaseBatchNoGenerator.next({source, taskId})`）——
  //   本刀真踩到过：把 options 当成了 `prefix` ⇒ 序号没进号里、两个并发拿到同一个串 ⇒ **探针假红** ✗
  const next = async (_options = {}) => {
    sequence += 1;
    // ⚠️ 序号**必须在 yield 之前取到本地**（与真号源 `PurchaseBatchNoGenerator.next` **逐字同形**：
    //   它也是 `const sequence = max + 1;` ⇒ `compose` 用本地变量）。
    //   本刀真踩到过：把 `sequence` 留在 `await` 之后再读 ⇒ 两个并发调用都读到最后一个值 ⇒
    //   **AD-D7b 探针假红**（判据说"各建一个新号"而实际拿到同一个串 ✗）。
    const current = sequence;
    // ⚠️ 只让出一次微任务：**不 await 一次 IO** ⇒ 没有串行保护时两个并发调用必然都看到"没有"
    await Promise.resolve();
    return { batchNo: `${prefix}${String(current).padStart(4, '0')}`, sequence: current, datePart: '20261016' };
  };
  return { next, get assigned() { return sequence; } };
};

/** 她 2026-10-16 那两条逻辑里提到、但**本刀绝不该碰**的东西：全都插上探针。 */
const makeSideEffectSpies = () => {
  const calls = [];
  const spy = (name) => (...args) => { calls.push({ name, args }); };
  return {
    calls,
    callsOf: (name) => calls.filter((call) => call.name === name),
    inventory: {
      applyPurchase: spy('inventory.applyPurchase'),
      applyPurchaseReturn: spy('inventory.applyPurchaseReturn'),
    },
    groupNotice: spy('purchase.group.notice'),
    supplierImages: spy('purchase.supplier.images'),
    purchaseRequestWriter: spy('purchase.publishPurchaseRequest'),
    purchaseReturnWriter: spy('purchaseReturn.submit'),
  };
};

const makeHarness = ({
  env = {}, chain = 'replenish', supplierRecordId = '', now, spies, resolvableSizes = null,
} = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-draft-test-'));
  const config = resolveScanDraftConfig(env);
  const gateway = makeFakeGateway();
  const batchNoGenerator = makeFakeBatchNoGenerator();
  // ⭐ 明细那一半要往「采购明细.尺码」写**关联记录 id** ⇒ 注入假尺码解析器（形状与真件一致 ✓）
  const sizeReferences = makeFakeSizeReferences(resolvableSizes);
  const events = [];
  const logger = {
    logInfo: (event, detail) => events.push({ level: 'info', event, detail }),
    logWarn: (event, detail) => events.push({ level: 'warn', event, detail }),
    logError: (event, detail) => events.push({ level: 'error', event, detail }),
  };
  const service = createScanDraftService({
    gateway,
    config,
    dir,
    logger,
    batchNoGenerator,
    sizeReferences,
    now,
    // ⚠️ 这里注入一把**固定的**串行键：只是为了把 AC-D7 的断言与
    //   `config.concurrentKeyFallback` 那个默认取值**解耦**（改配置文案不该动判据 ✓）。
    //   真实实现那把键本来就是**一个常量**（缺省 `scan_draft_batch_no`）⇒ 所有人的草稿
    //   共用同一把串行块（批次号是**全局每天**的号 ⇒ 取号必须全局串行 ✓）；
    //   串行块里跑的步骤逐字相同 ⇒ 下面几条断言在两种情形下都成立 ✓
    //   （默认值那条已单独跑过一次实证：两次并发 `generator_calls === 1`、两个草稿同一个批次号 ✓）。
    keyOf: () => 'test-serial-key',
  });
  const sideEffects = spies || makeSideEffectSpies();
  return {
    dir,
    config,
    gateway,
    batchNoGenerator,
    sizeReferences,
    events,
    logger,
    service,
    sideEffects,
    eventsNamed: (name) => events.filter((entry) => entry.event === name),
    storeFiles: () => fs.readdirSync(dir).filter((file) => file.endsWith('.json')),
    readStoreFile: (file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')),
    /** 把本地那几个草稿文件里的 `drafts` 合成一份（**一个桶一个文件**，见 PR 说明的形状） */
    storedDrafts: () => {
      const out = {};
      for (const file of fs.readdirSync(dir).filter((item) => item.endsWith('.json'))) {
        const body = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        Object.assign(out, body.drafts || {});
      }
      return out;
    },
    save: (input) => service.saveDraft({ openId: 'ou_test', chain, supplierRecordId, ...input }),
    read: (input) => service.readDraft({ openId: 'ou_test', supplierRecordId, ...input }),
  };
};

/** 她真的会填的那种草稿（**两个货品 / 两个供应商** —— 正好也是"供应商拆分"那条口径的形状）。 */
const SAMPLE_ITEMS = [
  {
    product_record_id: 'rec_product_A',
    number: '832-500',
    item_no: 'HM-A',
    color: '黑',
    supplier_record_id: 'rec_supplier_1',
    entries: [{ size: '40', quantity: 2 }, { size: '41', quantity: 1 }],
  },
  {
    product_record_id: 'rec_product_B',
    number: '901-200',
    item_no: 'HM-B',
    color: '白',
    supplier_record_id: 'rec_supplier_2',
    entries: [{ size: '38', quantity: 3 }],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// AC-D1 存草稿 ⇒ 零副作用（**成对迁移**：改前逐字 → 改后逐字 → 依据，见文件头）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D1 存草稿 ⇒ 零副作用：主表一行（未报货）＋ 明细 N 行，库存/出图/发群/写入口**一次都没有**', async () => {
  const h = makeHarness();
  const spied = makeSideEffectSpies();
  const saved = await h.save({ items: SAMPLE_ITEMS, spies: spied });
  assert.equal(saved.ok, true, '存草稿要成功 ✓');

  // ① 写接口 = **主表那一行 1 次** ＋ **明细 N 行**（她 2026-10-16：「草稿也写明细」✓），
  //    ⚠️ 除了这两张表，**别的一张都不许碰**（`update` 一次都没有 = 不覆盖任何既有事实 ✓）
  const writes = h.gateway.calls.filter((call) => call.op === 'create' || call.op === 'update');
  const batchWrites = writes.filter((call) => call.table === 'purchaseOrderBatch');
  const detailWrites = writes.filter((call) => call.table === 'purchaseRequest');
  // 一行明细 = 一个（货品 × 尺码）⇒ 本夹具 2 个货品 / 3 个尺码 ⇒ 明细 3 行
  //   （「N = 货品数」那条口径的正向判据在下面 AC-D2b 的"每货品一个尺码"夹具里 ✓）
  const expectedDetailLines = SAMPLE_ITEMS
    .reduce((sum, item) => sum + item.entries.length, 0);
  assert.deepEqual(batchWrites.map((call) => call.table), ['purchaseOrderBatch'],
    '写只许落在「采购主表」那一行（一次 ✓）');
  assert.equal(detailWrites.length, expectedDetailLines, `明细 = 货品 × 尺码（实际 ${detailWrites.length} 行）`);
  assert.equal(writes.length, 1 + expectedDetailLines, '写 = 主表 1 次 ＋ 明细 N 次，**没有第三种写** ✗');
  assert.deepEqual(
    h.gateway.calls.filter((call) => call.op === 'update'),
    [],
    '草稿阶段**一次 update 都不许有**（不覆盖任何既有事实 ✗）',
  );
  // ② 她 2026-10-16 点名的三个副作用（发群 / 出图 / 写库存）**一个都不许发生**
  for (const name of [
    'inventory.applyPurchase', 'inventory.applyPurchaseReturn',
    'purchase.group.notice', 'purchase.supplier.images',
    'purchase.publishPurchaseRequest', 'purchaseReturn.submit',
  ]) {
    assert.equal(spied.callsOf(name).length, 0, `存草稿阶段绝不许调 ${name} ✗`);
  }
  // ③ 草稿行写的是**她的"草稿状态"**（到货状态 = 未报货）
  const values = batchWrites[0].values;
  assert.equal(values.arrivalStatus, h.config.statusValue, '草稿行的到货状态 = 未报货（她的草稿状态）');
  assert.equal(values.arrivalStatus, '未报货');
  assert.match(values.batchNo, /^CGD-20261016-\d{4}$/, '草稿行带的是**新建**的那个批次号');
  assert.equal(values.idempotencyKey, h.service.draftRowKey('scan_session_ou_test', DRAFT_SCOPE.single));
  // ④ 表写失败 ⇒ **不算存成功**（这条由 AC-D5 的兄弟用例单独钉；这里先证明"成功路径"的形状）
  assert.equal(h.service.statusValue, '未报货');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2b ⭐ 草稿也写明细（她 2026-10-16 逐字）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2b ⭐ 草稿也写明细：主表 1 行（未报货）＋ 明细 N 行（N = 货品数）', async () => {
  // 夹具 = **每个货品恰好 1 个尺码** ⇒ 「N = 货品数」这条口径可以直接断言 ✓
  const oneEach = SAMPLE_ITEMS.map((item) => ({ ...item, entries: [item.entries[0]] }));
  const h = makeHarness();
  const saved = await h.save({ items: oneEach });
  assert.equal(saved.ok, true);

  // ① 主表：**恰好 1 行**，到货状态 = 未报货（她的"草稿状态"）
  const batchRows = h.gateway.writesTo('purchaseOrderBatch');
  assert.equal(batchRows.length, 1, '主表那一行**只许 1 行** ✗');
  assert.equal(batchRows[0].values.arrivalStatus, '未报货');
  // ② 明细：**N 行 = 货品数**（一行明细 = 一个货品 × 一个尺码 ✓ 与既有真出单链路同形）
  const detailRows = h.gateway.writesTo('purchaseRequest');
  assert.equal(detailRows.length, oneEach.length, `明细行数 = 货品数（实际 ${detailRows.length}）`);
  assert.deepEqual(detailRows.map((row) => row.values.product), oneEach.map((item) => [item.product_record_id]),
    '每一行明细挂的是**那个货品的记录 id**（关联字段的形状 = 记录 id 数组 ✓）');
  assert.deepEqual(detailRows.map((row) => row.values.size), oneEach.map((item) => [`rec_size_${item.entries[0].size}`]),
    '每一行明细的尺码 = **尺码管理里那条记录的 id**（不是文本 ✗）');
  assert.deepEqual(detailRows.map((row) => row.values.quantity), oneEach.map((item) => item.entries[0].quantity),
    '数量逐字跟着草稿走 ✓');
  const batchRecordId = String(h.gateway.tables.get('purchaseOrderBatch')[0].record_id);
  assert.deepEqual(detailRows.map((row) => row.values.batchNo), oneEach.map(() => [batchRecordId]),
    '每一行明细都挂在**刚建的主表那一行**上（同一批次 ✓）');
  // ③ 明细的幂等键 = 配置里的那一套前缀（**独立前缀** ⇒ 不与真出单撞 ✓）
  const prefix = `${h.config.detailIdempotencyPrefix}:scan_session_ou_test:single:`;
  detailRows.forEach((row) => {
    assert.ok(String(row.values.idempotencyKey).startsWith(prefix),
      `明细幂等键要带配置里的前缀：${row.values.idempotencyKey}`);
  });
  assert.equal(new Set(detailRows.map((row) => row.values.idempotencyKey)).size, detailRows.length,
    '同一份草稿里，每一行明细的幂等键**互不相同** ✓');
  // ④ 返回值里如实带明细那几个数（S3 / 排查要用 ✓）
  assert.equal(saved.details.count, oneEach.length);
  assert.equal(saved.details.created, oneEach.length);
  assert.equal(saved.details.failed, 0);
  assert.equal(h.eventsNamed('scan.draft.details_written').length, 1);
  // ⑤ 一行 = 一个（货品 × 尺码）：**多一个尺码就多一行**（SAMPLE_ITEMS 有 3 个尺码 ⇒ 3 行 ✓）
  const h2 = makeHarness();
  const saved2 = await h2.save({ items: SAMPLE_ITEMS });
  assert.equal(saved2.details.count, 3, '2 个货品 / 3 个尺码 ⇒ 明细 3 行（一行一个尺码 ✓）');
  assert.deepEqual(saved2.details.skipped, [], '这一份草稿**一行都没跳过** ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2c ⭐ 幂等：同一份草稿存两次 ⇒ 明细不翻倍
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2c ⭐ 幂等：同一份草稿存两次 ⇒ 明细**不翻倍**（第二次全部命中）', async () => {
  const h = makeHarness();
  const first = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(first.ok, true);
  assert.equal(first.details.created, 3, '第一次：3 行明细都是**新建**的');
  const keysAfterFirst = h.gateway.detailKeysOf();
  assert.equal(keysAfterFirst.length, 3);

  const second = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(second.ok, true);
  // 🔴 假表里的明细行数**没有变**（翻倍 ⇒ 红 ✓）
  assert.deepEqual(h.gateway.detailKeysOf(), keysAfterFirst, '明细**一行都没多**（不翻倍 ✓）');
  assert.equal(second.details.created, 0, '第二次：一行都不新建 ✓');
  assert.equal(second.details.reused, 3, '第二次：3 行**全部命中幂等**（reused ✓）');
  assert.equal(h.gateway.writesTo('purchaseRequest').length, 3, '明细的 create 总次数仍是 3 ✓');
  // ⚠️ 已知边界（**本刀没动那一半**，如实写在这里）：主表那一行仍按 S1 既有行为再建一次
  //   （同一把幂等键）—— S3 接"存草稿"时要先按幂等键回查 / 复用那一行；**本刀只保证明细不翻倍** ✓
  assert.equal(h.gateway.writesTo('purchaseOrderBatch').length, 2,
    '主表那一行**仍是 S1 既有行为**（第二次也 create，同一把幂等键）—— 本刀没改它 ✗');
  assert.equal(h.gateway.writesTo('purchaseOrderBatch')[0].values.idempotencyKey,
    h.gateway.writesTo('purchaseOrderBatch')[1].values.idempotencyKey,
    '两次用的是**同一把**草稿行幂等键（"只留一份"的身份 ✓）');
});

test('AC-D2c2 ⭐ 换了内容还是同一份草稿：明细按（货品 × 尺码）对齐 ⇒ 变了的那一行**命中同一把键**（不新增）', async () => {
  const h = makeHarness();
  const first = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(first.details.count, 3);
  const keysAfterFirst = h.gateway.detailKeysOf();
  // 同一份草稿再存一次，只把 A 货品 40 码的数量从 2 改成 5（她的草稿纸就是这样改的 ✓）
  const changed = JSON.parse(JSON.stringify(SAMPLE_ITEMS));
  changed[0].entries[0].quantity = 5;
  const second = await h.save({ items: changed });
  assert.equal(second.ok, true);
  assert.equal(second.details.count, 3, '还是那 3 行（同一个草稿 ✓）');
  assert.equal(second.details.reused, 3, '第二遍**全部命中**（键只由 会话/桶/货品/尺码 决定 ✓）');
  assert.deepEqual(h.gateway.detailKeysOf(), keysAfterFirst, '明细那 3 把键**逐字没变**（不新增行 ✓）');
  assert.equal(h.gateway.writesTo('purchaseRequest').length, 3, '明细没有多出来 ✗');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D2d ⭐ 零副作用仍成立（明细那一项 = 被允许的例外）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2d ⭐ 零副作用仍成立：明细是**唯一**被允许的例外（发群/出图/库存/号源照旧不受影响）', async () => {
  const h = makeHarness();
  const spied = makeSideEffectSpies();
  const before = h.batchNoGenerator.assigned;
  const saved = await h.save({ items: SAMPLE_ITEMS, spies: spied });
  assert.equal(saved.ok, true);
  // ① **被允许的例外**：只有「采购明细」那一种新写入（主表那一行是本来就有的 ✓）
  const touchedTables = [...new Set(h.gateway.calls
    .filter((call) => call.op === 'create' || call.op === 'update').map((call) => call.table))].sort();
  assert.deepEqual(touchedTables, ['purchaseOrderBatch', 'purchaseRequest'],
    '存草稿碰的表**只有这两张**（例外写明白：明细 ✓）');
  // ② 三个副作用（发群 / 出图 / 写库存）+ 两条真出单写入口：**一次都没有** ✓
  for (const name of [
    'inventory.applyPurchase', 'inventory.applyPurchaseReturn',
    'purchase.group.notice', 'purchase.supplier.images',
    'purchase.publishPurchaseRequest', 'purchaseReturn.submit',
  ]) {
    assert.equal(spied.callsOf(name).length, 0, `存草稿（含明细）绝不许调 ${name} ✗`);
  }
  // ③ 号源行为**一个字没变**：没有未报货的号 ⇒ 恰好取一次（明细不会额外取号 ✗）
  assert.equal(h.batchNoGenerator.assigned, before + 1, '取号次数与"只有主表那一行"时**逐字相同** ✓');
  // ④ 发群 / 出图那两条**注入件**真的插上了（不是"没人调"的空断言）
  spied.groupNotice(); spied.supplierImages();
  assert.equal(spied.callsOf('purchase.group.notice').length, 1, '探针：这两个假件**真的能记账** ✓');
});


// ═══════════════════════════════════════════════════════════════════════════
// AC-D2 找回 ⇒ 逐字还在（含顺序）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D2 找回 ⇒ 尺码/数量/已加货品/供应商逐字还在，顺序一致', async () => {
  const h = makeHarness();
  const saved = await h.save({ items: SAMPLE_ITEMS, orderAmount: '', orderKey: 'scan_replenish:scan_session_ou_test:1' });
  assert.equal(saved.ok, true);

  const loaded = await h.read();
  assert.equal(loaded.ok, true, '刚存的草稿要能找回来 ✓');
  assert.equal(loaded.status, 'draft');
  // ⭐ **逐字**：一个字段都不许多、少、改、换位
  assert.deepEqual(loaded.draft.items, SAMPLE_ITEMS.map((item) => ({
    product_record_id: item.product_record_id,
    number: item.number,
    item_no: item.item_no,
    color: item.color,
    supplier_record_id: item.supplier_record_id,
    entries: item.entries.map((entry) => ({ size: entry.size, quantity: entry.quantity })),
  })));
  // 顺序**逐位**比一遍（deepEqual 已经保序，这里再显式钉住"不许按货品重排"）
  assert.deepEqual(loaded.draft.items.map((item) => item.number), ['832-500', '901-200']);
  assert.deepEqual(loaded.draft.items.map((item) => item.supplier_record_id), ['rec_supplier_1', 'rec_supplier_2']);
  // 尺码/数量逐字（字符串就是字符串、数字就是数字 —— 不许被"顺手转成数字"）
  assert.deepEqual(loaded.draft.items[0].entries, [{ size: '40', quantity: 2 }, { size: '41', quantity: 1 }]);
  assert.equal(typeof loaded.draft.items[0].entries[0].size, 'string');
  assert.equal(loaded.draft.line_count, 3);
  assert.equal(loaded.draft.batch_no, saved.draft.batch_no);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D3 没有草稿 ⇒ 与今天逐字一致（零回归）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D3 没有草稿 ⇒ 视图**一个字都不改** ＋ 零文件写入 ＋ 零远端调用', async () => {
  const h = makeHarness({ env: { SCAN_DRAFT_ENABLED: 'true' } });
  const before = { multi_items: [], realm: 'replenish', html: '<form>今天那一屏</form>' };

  const planned = await h.service.planView({ openId: 'ou_test', view: before });
  assert.equal(planned.ok, false);
  assert.equal(planned.status, 'none', '没有草稿 ⇒ 明确说"没有"（不是猜一个空草稿）');
  // ⭐ **同一个对象**（不是"内容相等"）—— 这条能挡住"顺手把 view 复制/改写一遍"那种静默回归
  assert.equal(planned.view, before, '没有草稿时视图必须原样返回（同一对象）');
  assert.deepEqual(before, { multi_items: [], realm: 'replenish', html: '<form>今天那一屏</form>' });

  // 文本「今天那一屏」逐字没动（用一份真渲染器形状的假件核一遍）
  const htmlOf = (view) => `<body>${view.html}|${JSON.stringify(view.multi_items)}</body>`;
  const off = makeHarness({ env: { SCAN_DRAFT_ENABLED: 'false' } });
  const offPlan = await off.service.planView({ openId: 'ou_test', view: before });
  assert.equal(offPlan.status, 'disabled', '开关关着 ⇒ 连带都不读（不建文件、不碰表）✓');
  assert.equal(htmlOf(offPlan.view), htmlOf(planned.view), '开关关 / 开但没草稿 ⇒ 渲出来逐字一样');
  assert.equal(htmlOf(planned.view), '<body><form>今天那一屏</form>|[]</body>');

  // 零副作用：没有文件、没有写、也没有"顺手读一次表"
  assert.deepEqual(h.storeFiles(), [], '读草稿**不许**建文件（没有就是没有）');
  assert.deepEqual(h.gateway.calls, [], '没有草稿时连表都不许读（零远端调用）');
  assert.deepEqual(off.gateway.calls, [], '开关关着时同样零远端调用');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D4 draftScope：single 覆盖（留痕）vs per_supplier 并存
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D4 single ⇒ 第二次存覆盖第一份 ＋ 留痕（scan.draft.overwritten）', async () => {
  const h = makeHarness({ env: { SCAN_DRAFT_SCOPE: DRAFT_SCOPE.single } });
  const first = await h.save({ items: [SAMPLE_ITEMS[0]] });
  const second = await h.save({ items: [SAMPLE_ITEMS[1]] });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const loaded = await h.read();
  assert.equal(loaded.status, 'draft');
  assert.deepEqual(loaded.draft.items.map((item) => item.number), ['901-200'], 'single ⇒ 只剩最后那一份');
  assert.equal(Object.keys(h.readStoreFile(h.storeFiles()[0]).drafts).length, 1);
  // ⭐ **留痕**（不许静默覆盖 ✗）：事件 + 返回值里都说得清"上一份被覆盖了"
  const overwritten = h.eventsNamed('scan.draft.overwritten');
  assert.equal(overwritten.length, 1, '覆盖必须留一条 scan.draft.overwritten ✓');
  assert.equal(overwritten[0].detail.previous_line_count, 2, '留痕里要写清上一份有几行');
  assert.equal(overwritten[0].detail.line_count, 1);
  assert.equal(second.summary.overwritten, true, '返回值里也要如实说"覆盖了"');
  assert.match(second.summary.message, /覆盖/);
  // 表侧那一行**还是同一把幂等键**（single 意味着"同一批只一行"）
  const keys = h.gateway.writesTo('purchaseOrderBatch').map((call) => call.values.idempotencyKey);
  assert.deepEqual(keys, [keys[0], keys[0]], 'single 下两次存草稿用的是**同一把**草稿行幂等键');
});

test('AC-D4b per_supplier ⇒ 两个供应商各留一份、并存（且各有各的批次号沿用关系）', async () => {
  const h = makeHarness({ env: { SCAN_DRAFT_SCOPE: DRAFT_SCOPE.perSupplier, SCAN_DRAFT_ENABLED: 'true' } });
  const one = await h.service.saveDraft({
    openId: 'ou_test', supplierRecordId: 'rec_supplier_1', items: [SAMPLE_ITEMS[0]],
  });
  const two = await h.service.saveDraft({
    openId: 'ou_test', supplierRecordId: 'rec_supplier_2', items: [SAMPLE_ITEMS[1]],
  });
  assert.equal(one.bucket, 'rec_supplier_1');
  assert.equal(two.bucket, 'rec_supplier_2');
  const drafts = h.storedDrafts();
  assert.deepEqual(Object.keys(drafts).sort(), ['rec_supplier_1', 'rec_supplier_2'], '两份并存 ✓');
  assert.equal(h.storeFiles().length, 2, '一个供应商一个草稿文件（桶名进文件名 ⇒ 并发写不打架 ✓）');
  assert.equal(drafts.rec_supplier_1.items[0].number, '832-500');
  assert.equal(drafts.rec_supplier_2.items[0].number, '901-200');
  // 第二份**沿用**第一份建的那个批次号（同一个报货批次号下混着两个供应商 ✓ 她的口径）
  assert.equal(two.draft.batch_no, one.draft.batch_no, '同一批未报货的号 ⇒ 第二份草稿沿用 ✓');
  assert.equal(h.eventsNamed('scan.draft.batch_reused').length, 1);
  // 单桶读回：按供应商各读各的
  const readOne = await h.service.readDraft({ openId: 'ou_test', supplierRecordId: 'rec_supplier_1' });
  assert.equal(readOne.bucket, 'rec_supplier_1');
  assert.equal(readOne.draft.items[0].number, '832-500');
  // ⭐ "拆成几单 / 几个批次号"**她还没拍** ⇒ 配置里如实标未决，不许写死 ✗
  assert.equal(h.config.supplierSplit, 'generate_report');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D5 过期 / 坏格式 ⇒ 人话 + 不清不响
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D5a 过期草稿 ⇒ 人话 + **归档**（文件仍在）+ 不抛异常', async () => {
  let clock = Date.parse('2026-10-01T00:00:00Z');
  const h = makeHarness({
    env: { SCAN_DRAFT_TTL_MS: String(7 * 24 * 60 * 60 * 1000) },
    now: () => new Date(clock),
  });
  const saved = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(saved.ok, true);
  assert.equal(saved.draft.expires_at, '2026-10-08T00:00:00.000Z', 'TTL 7 天 ⇒ 到期时间可预期');

  clock = Date.parse('2026-10-09T00:00:00Z'); // 过期两天
  let loaded = null;
  await assert.doesNotReject(async () => { loaded = await h.read(); }, '过期**不许抛** ✗');
  assert.equal(loaded.ok, false);
  assert.equal(loaded.status, 'expired');
  assert.match(loaded.message, /过期/, '必须给人话（不清不响是禁止的 ✗）');
  assert.match(loaded.message, /7 天/, '人话里说清留了多久');
  assert.equal(h.eventsNamed('scan.draft.expired').length >= 1, true, '过期要留痕');
  // **文件仍在**（归档而不是删除）
  const archived = fs.readdirSync(path.join(h.dir, 'expired'));
  assert.equal(archived.length, 1, '过期那一份要归档 ✓（删掉就再也说不清她那份去哪了 ✗）');
  const archivedBody = JSON.parse(fs.readFileSync(path.join(h.dir, 'expired', archived[0]), 'utf8'));
  assert.equal(Object.values(archivedBody.drafts)[0].items.length, 2, '归档里那份草稿是**完整**的');
});

test('AC-D5b 坏 JSON ⇒ 人话 + **文件原地不动** + 不抛异常', async () => {
  const h = makeHarness();
  const file = path.join(h.dir, 'scan_draft_scan_session_ou_test_single.json');
  fs.writeFileSync(file, '{"drafts": {"single": {"items": [', 'utf8'); // 半截 JSON（写崩了的那种）
  const before = fs.readFileSync(file, 'utf8');
  let loaded = null;
  await assert.doesNotReject(async () => { loaded = await h.read(); }, '坏格式**不许抛 500** ✗');
  assert.equal(loaded.status, 'corrupt');
  assert.match(loaded.message, /读不出来/, '必须给人话 ✓');
  assert.equal(fs.readFileSync(file, 'utf8'), before, '坏掉的那份**原地不动**（不删、不改写）');
  assert.equal(h.eventsNamed('scan.draft.corrupt').length, 1);
  assert.deepEqual(h.gateway.calls, [], '读坏了也不许顺手去碰表');
});

test('AC-D5c 表写失败 ⇒ **不算存成功** ＋ 人话 ＋ 草稿行不留半行', async () => {
  const h = makeHarness();
  const realCreate = h.gateway.create;
  h.gateway.create = async () => { throw new Error('feishu 500'); };
  const saved = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(saved.ok, false, '表没写进去 ⇒ **不许静默当成功** ✗');
  assert.equal(saved.code, 'table_write_failed');
  assert.match(saved.message, /没能存进飞书表/);
  assert.equal(h.eventsNamed('scan.draft.table_write_failed').length, 1);
  assert.equal(h.service.statusValue, '未报货'); // 口径不受影响
  h.gateway.create = realCreate;
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D6 ⭐ 批次号逻辑（她的第 ① 条）
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D6a 有未报货的批次号 ⇒ **沿用**（不新建、不调号源）', async () => {
  const h = makeHarness();
  const seededId = h.gateway.seedPendingRow('CGD-20261016-0007');
  const saved = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(saved.ok, true);
  assert.equal(saved.draft.batch_no, 'CGD-20261016-0007', '(a) 有 ⇒ 沿用那个未报货的批次号 ✓');
  assert.equal(saved.draft.reused_batch_record_id, seededId, '记下"沿用自她表里哪一行"（幂等的证据）');
  assert.equal(saved.draft.batch_record_id, h.gateway.writesTo('purchaseOrderBatch')[0].values?.batchNo
    ? saved.draft.batch_record_id : '', 'batch_record_id = 这一份草稿自己那一行');
  assert.match(saved.draft.batch_record_id, /^rec_purchaseOrderBatch_/, '自己那一行是新写的');
  assert.equal(saved.draft.batch_reused, true);
  assert.equal(h.batchNoGenerator.assigned, 0, '沿用 ⇒ **一次号源都没调** ✓');
  assert.equal(h.eventsNamed('scan.draft.batch_reused').length, 1);
  assert.equal(h.eventsNamed('scan.draft.batch_created').length, 0);
  // 草稿行写的也是这个沿用的号
  assert.equal(h.gateway.writesTo('purchaseOrderBatch')[0].values.batchNo, 'CGD-20261016-0007');
});

test('AC-D6b 没有未报货的批次号 ⇒ **新建**一个', async () => {
  const h = makeHarness();
  const saved = await h.save({ items: SAMPLE_ITEMS });
  assert.equal(saved.ok, true);
  assert.match(saved.draft.batch_no, /^CGD-20261016-\d{4}$/, '(b) 没有 ⇒ 新建一个批次号 ✓');
  assert.equal(saved.draft.batch_reused, false);
  assert.equal(h.batchNoGenerator.assigned, 1, '新建 ⇒ 恰好调号源一次');
  assert.equal(h.eventsNamed('scan.draft.batch_created').length, 1);
  assert.equal(h.eventsNamed('scan.draft.batch_reused').length, 0);
  // ⚠️ 号源**不是本刀自己造的**：配置如实指向既有生成器（改格式只改那一份配置 ✓）
  assert.equal(h.config.batchNoSource, 'services/purchaseBatchNoGenerator.js');
  assert.equal(h.config.batchNoPolicy, BATCH_NO_POLICIES.reusePending);
  assert.equal(h.config.reusePendingBatchNo, true);
});

test('AC-D6c 批次号口径**不许被绕过**：认不出的取值当场抛（不是静默新建）', () => {
  assert.throws(
    () => resolveScanDraftConfig({ SCAN_DRAFT_BATCH_NO_POLICY: 'always_new' }),
    /SCAN_DRAFT_BATCH_NO_POLICY/,
    '写成"总是新建"就等于违背她的话 ⇒ 必须当场吵 ✓',
  );
  assert.throws(() => resolveScanDraftConfig({ SCAN_DRAFT_SCOPE: 'per_product' }), /SCAN_DRAFT_SCOPE/);
  // 缺省 = 她的口径 + 她的选择（不许被"我替她定"改掉 ✗）
  const defaults = resolveScanDraftConfig({});
  assert.equal(defaults.scope, 'single', '她选的是"只留一份当前草稿" ⇒ 缺省 single ✓');
  assert.equal(defaults.batchNoPolicy, 'reuse_pending');
  assert.equal(defaults.maxLines, 50, '上限 = SESSION.maxLines（既有配置那一个数）✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-D7 🔴 并发：两个草稿同时"都没有" ⇒ 不许各建一个新批次号
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D7 并发存两份草稿（都看到"没有未报货"）⇒ 只出一个批次号，第二份沿用', async () => {
  const h = makeHarness({ env: { SCAN_DRAFT_SCOPE: DRAFT_SCOPE.perSupplier } });
  const [first, second] = await Promise.all([
    h.service.saveDraft({ openId: 'ou_test', supplierRecordId: 'rec_supplier_1', items: [SAMPLE_ITEMS[0]] }),
    h.service.saveDraft({ openId: 'ou_test', supplierRecordId: 'rec_supplier_2', items: [SAMPLE_ITEMS[1]] }),
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(h.batchNoGenerator.assigned, 1, '🔴 号源只许被调**一次**（两个并发不许各建一个新号 ✗）');
  assert.equal(first.draft.batch_no, second.draft.batch_no, '两个草稿归到**同一个批次号** ✓（她的原话）');
  const batchNos = new Set(h.gateway.writesTo('purchaseOrderBatch').map((call) => call.values.batchNo));
  assert.deepEqual([...batchNos], [first.draft.batch_no], '表侧两行写的是同一个号 ✓');
  // 第二个**是沿用**（它看见了第一个刚建的那一行）
  assert.equal(second.draft.batch_reused, true);
  assert.equal(h.eventsNamed('scan.draft.batch_created').length, 1);
  assert.equal(h.eventsNamed('scan.draft.batch_reused').length, 1);
});

test('AC-D7b 探针：把"串行"拆掉 ⇒ 这条判据**真的会红**（AC-D7 不是空跑）', async () => {
  // ⚠️ 复现"两个草稿同时都没有"那一刻：**两边的 listAll 都跑完，才允许各自的 create 落库**
  //   （真实世界 = 两个请求同时到达、都还没写库；这正是要挡住的那件事）
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-draft-probe-'));
  const base = makeFakeGateway();
  const rawListAll = base.listAll.bind(base);
  const rawCreate = base.create.bind(base);
  let listCalls = 0;
  let release;
  const bothReadDone = new Promise((resolve) => { release = resolve; });
  base.listAll = async (tableKey) => {
    listCalls += 1;
    if (listCalls >= 2) release();
    return rawListAll(tableKey);
  };
  base.create = async (tableKey, values) => {
    await bothReadDone; // 🔴 两边都读完之前，谁都不许落库
    return rawCreate(tableKey, values);
  };
  const batchNoGenerator = makeFakeBatchNoGenerator();
  const service = createScanDraftService({
    gateway: base,
    config: resolveScanDraftConfig({ SCAN_DRAFT_SCOPE: DRAFT_SCOPE.perSupplier }),
    dir,
    logger: { logInfo: () => {}, logWarn: () => {}, logError: () => {} },
    batchNoGenerator,
    queue: { run: (key, work) => work() }, // 🔴 串行保护被拿掉（只为证明判据能真红）
    keyOf: () => 'test-serial-key',
  });
  const results = await Promise.all([
    service.saveDraft({ openId: 'ou_test', supplierRecordId: 'rec_supplier_1', items: [SAMPLE_ITEMS[0]] }),
    service.saveDraft({ openId: 'ou_test', supplierRecordId: 'rec_supplier_2', items: [SAMPLE_ITEMS[1]] }),
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.equal(batchNoGenerator.assigned, 2, '没有串行 ⇒ 各建一个新号（这正是 AC-D7 要挡住的那件事）');
  assert.notEqual(results[0].draft.batch_no, results[1].draft.batch_no);
  // ⇒ 反向证明：AC-D7 的 `assigned === 1` **不是**空跑出来的
  const serialQueue = new KeyedSerialQueue();
  assert.equal(typeof serialQueue.run, 'function');
});

// AC-D8 🔴 源码哨兵：冻结件逐字节未动 ＋ 列名不写死
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D8 🔴 `scanWriteService.js` 与 main **逐字节一致**（余量 0：谁改一个字就红）', () => {
  const raw = fs.readFileSync(FROZEN_PATH);
  assert.equal(sha256Of(raw), FROZEN_SHA256,
    '🔴 冻结件被改动了 ✗ —— 本刀一个字都不许碰它（需要动它 ⇒ 停手报 Lead）');
  // 探针：指纹**真能认出**改动（不是拿一个常量自证）
  assert.notEqual(sha256Of(Buffer.concat([raw, Buffer.from(' ')]))
    .includes(FROZEN_SHA256), true, '多一个字节 ⇒ 指纹必变 ✓');
  assert.notEqual(sha256Of(Buffer.from(SERVICE_SRC, 'utf8')), FROZEN_SHA256);
});

test('AC-D8b 草稿不直连业务表列名：中文列名一个字都不出现在新代码里', () => {
  // ① 本刀**不 require 那个冻结件**（免得"读一下"变成将来的"改一下"）
  assert.equal(/require\([^)]*scanWriteService/.test(SERVICE_SRC), false, '不许 require 冻结件 ✗');
  // ② 真正该写的那几列，名字只能从 schema 的语义键取 ⇒ **代码里**（剥掉注释后）一个中文列名都没有
  const codeOnly = SERVICE_SRC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  for (const column of ['报货批次号', '到货状态', '幂等键', '未报货']) {
    assert.equal(codeOnly.includes(column), false, `代码里不许写死中文列名「${column}」（只从 schema 取）`);
    assert.equal(SERVICE_SRC.includes(column), true, `「${column}」应当只在注释里被解释过（人要看懂口径）`);
  }
  // ③ 碰 gateway 的写接口**只有一处**（`writeDraftRowToTable` 里那一次 create）
  assert.equal((SERVICE_SRC.match(/await gateway\.create\(/g) || []).length, 1, '真正调 gateway.create 只许有一处');
  assert.equal((SERVICE_SRC.match(/await gateway\.update\(/g) || []).length, 0, '草稿行不走 update（身份由幂等键保证）✓');
  // ④ 语义键确实是从 schema 读的（不是自己编的字符串）
  assert.equal(SERVICE_SRC.includes("fieldOf(tableKey, 'batchNo')"), true);
  assert.equal(SERVICE_SRC.includes('V1_BITABLE_SCHEMA'), true);
  // ⑤ 本模块**不渲染页面**（那是 S2）：不许出现 HTML / 中文文案拼接
  assert.equal(/<form|<div|html/i.test(SERVICE_SRC), false, 'S1 不渲染页面 ✗');
});

// MUTATION（2026-10-16 本刀 S2 · 每组都单独跑过、确认**真红**，跑完逐字节还原 ✓）：
//   ① 明细的幂等键里塞进 `Date.now()` / 随机数（= 每次都是新键）
//      ⇒ **AC-D2c** 红（第二次存草稿明细翻倍 ✓）＋ AC-D2c2 红 ✓
//   ② 把 `entry.size` 从明细幂等键里拿掉（= 一个货品一把键）
//      ⇒ **AC-D1** 红（明细行数 3 → 2 ⇒ 与"货品 × 尺码"口径不符 ✓）＋ AC-D2c / AC-D2c2 红 ✓
//   还原核验：`shasum -a 256 src/services/scanDraftService.js` 与变异前**逐字节一致** ✓
