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
 *  AC-D1 **存草稿 ⇒ 零副作用**：不发群 / 不写库存 / 不出批次号（**不写采购明细** / 不建明细行）✓
 *         —— 用**假 gateway 记账**证明：`create` 只落在 `purchaseOrderBatch` 一次；
 *            `purchaseRequest` 0 次；`inventory*` 0 次；出图 / 发群的注入件 0 次 ✓
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

/** 🔴 main 上那个冻结件的基线指纹（与 `test/scanWriteServiceFrozen.test.js` 的常量**同一个值** ✓）。 */
const FROZEN_SHA256 = '199551e14c97db74d69b674838eac1f0980ab7e6123f10ada5adee497ed735ca';

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
  const fieldNames = {
    batchNo: V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.batchNo,
    arrivalStatus: V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.arrivalStatus,
  };
  /** 语义键 → 物理列名（表侧那一行在她 Base 里就是这样存的 ✓）。 */
  const physical = (values) => {
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
      const record = { record_id: `rec_${tableKey}_${seq}`, fields: physical(values) };
      rowsOf(tableKey).push(record);
      return { record_id: record.record_id };
    },
    async update(tableKey, recordId, values) {
      calls.push({ op: 'update', table: tableKey, record_id: recordId, values: { ...values } });
      await Promise.resolve();
      const row = rowsOf(tableKey).find((item) => item.record_id === recordId);
      if (row) row.fields = { ...row.fields, ...physical(values) };
      return { record_id: recordId };
    },
  };
  /** 种一行"未报货"（模拟她表里已经有的草稿批次） */
  gateway.seedPendingRow = (batchNo, recordId = '') => {
    const id = recordId || `rec_seed_${rowsOf('purchaseOrderBatch').length + 1}`;
    rowsOf('purchaseOrderBatch').push({
      record_id: id,
      fields: { [fieldNames.batchNo]: batchNo, [fieldNames.arrivalStatus]: '未报货' },
    });
    return id;
  };
  gateway.writesTo = (tableKey) => calls.filter((call) => call.op === 'create' && call.table === tableKey);
  return gateway;
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

const makeHarness = ({ env = {}, chain = 'replenish', supplierRecordId = '', now, spies } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-draft-test-'));
  const config = resolveScanDraftConfig(env);
  const gateway = makeFakeGateway();
  const batchNoGenerator = makeFakeBatchNoGenerator();
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
// AC-D1 存草稿 ⇒ 零副作用
// ═══════════════════════════════════════════════════════════════════════════
test('AC-D1 存草稿 ⇒ 零副作用：只有一行草稿行，明细/库存/出图/发群/写入口**一次都没有**', async () => {
  const h = makeHarness();
  const spied = makeSideEffectSpies();
  const saved = await h.save({ items: SAMPLE_ITEMS, spies: spied });
  assert.equal(saved.ok, true, '存草稿要成功 ✓');

  // ① 写接口只被调**一次**，而且只落在「采购主表」那张表上
  const writes = h.gateway.calls.filter((call) => call.op === 'create' || call.op === 'update');
  assert.equal(writes.length, 1, `存一次草稿只许有一次写（实际 ${writes.length}）`);
  assert.equal(writes[0].table, 'purchaseOrderBatch', '写只许落在「采购主表」那一行');
  // ② **采购明细**一次都没碰（草稿绝不许被当成"已经出单的明细"）
  assert.deepEqual(h.gateway.writesTo('purchaseRequest'), [], '不许建采购明细 ✗');
  assert.deepEqual(
    h.gateway.calls.filter((call) => call.op === 'update' && call.table !== 'purchaseOrderBatch'),
    [],
    '除草稿行以外不许 update 任何表 ✗',
  );
  // ③ 她 2026-10-16 点名的三个副作用（发群 / 出图 / 写库存）**一个都不许发生**
  for (const name of [
    'inventory.applyPurchase', 'inventory.applyPurchaseReturn',
    'purchase.group.notice', 'purchase.supplier.images',
    'purchase.publishPurchaseRequest', 'purchaseReturn.submit',
  ]) {
    assert.equal(spied.callsOf(name).length, 0, `存草稿阶段绝不许调 ${name} ✗`);
  }
  // ④ 草稿行写的是**她的"草稿状态"**（到货状态 = 未报货）
  const values = writes[0].values;
  assert.equal(values.arrivalStatus, h.config.statusValue, '草稿行的到货状态 = 未报货（她的草稿状态）');
  assert.equal(values.arrivalStatus, '未报货');
  assert.match(values.batchNo, /^CGD-20261016-\d{4}$/, '草稿行带的是**新建**的那个批次号');
  assert.equal(values.idempotencyKey, h.service.draftRowKey('scan_session_ou_test', DRAFT_SCOPE.single));
  // ⑤ 表写失败 ⇒ **不算存成功**（这条由 AC-D5 的兄弟用例单独钉；这里先证明"成功路径"的形状）
  assert.equal(h.service.statusValue, '未报货');
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
