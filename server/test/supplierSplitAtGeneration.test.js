/**
 * ⭐⭐ **「生成报货单时按供应商拆分/分组」的验收标准** —— 2026-10-16（业务负责人当天拍板：**选 ⓐ** ✓）。
 *
 * ── 权威口径（逐字，**别自己解释** ✗）────────────────────────────────────────
 *   「在**同一个报货批次号**里面，有可能会**混杂着不同的供应商**。我们在**生成报货单**的时候，
 *    需要**按照供应商进行拆分和分组**。因为这个报货单是我们要**对接供应商**的，
 *    所以**必须按照供应商进行分组**。」
 *   ⭐ 追问后她明确 **ⓐ「同一批次号下按供应商分组」** ✓（**不是** ⓑ"每个供应商各开一个新批次号"✗）。
 *
 * ── 先写「按我们的链路应该实现的效果」，再跑，再逐条对照（她定的流程）────────────
 *
 *  AC-SS1 一个批次号下 **3 个供应商** ⇒ 生成时报货单**按供应商分成 3 组**（每组只含该供应商的行）✓
 *  AC-SS2 **单供应商** ⇒ 与今天**逐字一致**（生成前递给写入口的**载荷逐字相同** ＋ 出图/附件/主表行数不变）✓
 *  AC-SS3 分组**不新增批次号**（她选的 ⓐ）：**主表只 1 行**、号源**只取 1 次**（能真红：多一个号 ⇒ 红）✓
 *  AC-SS4 **幂等**：同一组重复生成 ⇒ **只出一次**（重放那一次 0 张图、0 条群消息、0 个新附件）✓
 *  AC-SS5 **存草稿阶段零副作用**：混 3 个供应商的草稿 ⇒ 不发群 / 不出图 / 不写库存 / 不出报货单 ✓
 *         （⚠️ **成对迁移过一次**：她 2026-10-16 另外拍了「**草稿也写明细**」⇒ 明细**会**写，
 *           判据改钉"草稿明细用**草稿专用**幂等键前缀" —— 见下面那一段的逐字留痕 ✓）
 *  AC-SS6 ⭐ **口径落定哨兵**：`scanDraft` 里那个 S1 留的 `supplierSplit.batchNoPolicy` **不再是
 *         `undecided`**，而是她选的 `same_batch_no`；ⓑ（每供应商一个新号）**不是可选项**（配了就抛 ✓）
 *  AC-SS7 🔴 **源码哨兵**：`services/scanWriteService.js`（余量 0 的冻结件）**逐字节没动**
 *         ＋ 新分组模块**不认识飞书**（不 require gateway / schema、不写表）✓
 *
 * 每条都写明"**去掉哪一句就该红**"（见文件末 `MUTATION` 注释与 PR 说明）——
 * 避免"名字出现过 = 有判据"那种假绿（AGENTS.md 第 1b 条③）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_supplier_split';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'supplier_split_secret';

const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseOrderBatchService, attachmentNames } = require('../src/services/purchaseOrderBatchService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const {
  splitBySupplier, documentFileNameOf, groupItemsBySupplier,
} = require('../src/services/supplierSplitService');
const { resolveSupplierSplitConfig, BATCH_NO_POLICIES, SPLIT_STAGE, SUPPLIER_SPLIT } = require('../src/config/supplierSplit');
// ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
//   改前逐字：`const { resolveScanDraftConfig } = require('../src/config/scanDraft');`
//             ＋ `const { createScanDraftService } = require('../src/services/scanDraftService');`
//   改后逐字：**两条 require 删掉**（两个模块已随"存草稿链整件退场"删除 ✗）；本文件的口径真源
//             改为**既有** `config/supplierSplit.js`（上面那一行 ✓）
//   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**存草稿的功能都删除吧，不需要了，前端和后端都不需要了，整个链路都删除**」✓

/** 🔴 main 上那个冻结件的基线指纹（与 `test/scanWriteServiceFrozen.test.js` 的常量**同一个值** ✓）。
 *  ⚠️ **2026-10-16 成对迁移**（task-62「货 / 钱分离」阶段二 · 业务负责人明确「允许改冻结文件」，**一次性、只为本卡**）：
 *     改前逐字 `199551e1…35ca`（1699 行）⇒ 改后逐字 `49772bda…2c12`（1770 行）。
 *     本刀（按供应商拆分）自己在那份文件里**仍然一个字都没加** ✗ —— 判据没放宽，只是基线随授权的那一刀一起搬 ✓。
 *     ⚠️ 许可**不能复用**：下一次改它必须重新拿裁决（见冻结哨兵的「解冻台账」✓）。
 */
// ⭐⭐ 2026-10-16 成对迁移（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：sha `333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f`（1770 行 · 冻结件 `deferFunds` 那一版）
//   改后逐字：sha `333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f`（1770 行 · 货那一跑**照扣库存**）
//   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：…**如果是现货，就是要扣库存**；
//          如果是预订，就不扣库存，等二次交付的时候再扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」
//          ⇒ 冻结件只动批准的 5 行（`deliverStockLines` 形参/转发 ＋ `:1318` 三元 ＋ 两处注释）✓
//          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
const FROZEN_SHA256 = '333ae53b9b89abcecfa82c61aad0eefd8266630d3524e5a25d9f6afb994ff92f';

const SPLIT_SERVICE_PATH = path.join(__dirname, '..', 'src', 'services', 'supplierSplitService.js');
const SPLIT_SERVICE_SRC = fs.readFileSync(SPLIT_SERVICE_PATH, 'utf8');

const sha256Of = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `supplier-split-${label}-`));

// ═══════════════════════════════════════════════════════════════════════════
// 假件（**零真表写入**：本文件从头到尾不 require 真实客户端，也不读 `.env`）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 假 gateway：一张内存表 ＋ **记账**（create / update / 附件上传每一次都留痕）。
 *
 * ⚠️ 附件列要**像飞书那样回填文件名**：真飞书把 `{file_token}` 写进附件列之后，
 *    读回来是 `{file_token, name}`（名字来自上传时那个文件）。假件按
 *    `uploadAttachment(filePath)` 的 base name 记下 token→name，`update` 时补上 ✓
 *    —— 这正是"这一组的报货单已经出过了"能被判出来的物理基础（`AC-SS4`）。
 */
const createFakeGateway = (seed = {}) => {
  const tables = {};
  Object.entries(seed).forEach(([key, rows]) => {
    tables[key] = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      record_id: row?.record_id || `${key}_seed_${index + 1}`,
      fields: { ...(row?.fields || row || {}) },
    }));
  });
  let sequence = 0;
  const tokenNames = new Map();
  const calls = { create: [], update: [], listAll: [], upload: [] };
  const documentFieldOf = (key) => V1_BITABLE_SCHEMA.tables[key]?.fields?.document || '';
  const physical = (key, values) => {
    const map = V1_BITABLE_SCHEMA.tables[key]?.fields || {};
    const out = {};
    Object.entries(values || {}).forEach(([semanticKey, value]) => {
      if (value === undefined) return;
      out[map[semanticKey] || semanticKey] = value;
    });
    // 附件列：飞书回读时带 `name`（假件按上传时那个文件名补上 ✓）
    const docField = documentFieldOf(key);
    if (docField && Array.isArray(out[docField])) {
      out[docField] = out[docField].map((item) => ({
        file_token: item?.file_token, name: item?.name || tokenNames.get(item?.file_token) || '',
      }));
    }
    return out;
  };
  const gateway = {
    tables,
    calls,
    table(key) { return V1_BITABLE_SCHEMA.tables[key] || null; },
    async listAll(key) {
      calls.listAll.push(key);
      return (tables[key] || []).map((record) => ({ ...record, fields: { ...record.fields } }));
    },
    async get(key, id) { return (tables[key] || []).find((record) => record.record_id === id) || null; },
    async findOneByText(key, semanticKey, expected) {
      const name = V1_BITABLE_SCHEMA.tables[key]?.fields?.[semanticKey];
      const target = String(expected ?? '').trim();
      return (tables[key] || []).find(
        (record) => String(record.fields?.[name] ?? '').trim() === target,
      ) || null;
    },
    async create(key, values) {
      sequence += 1;
      const fields = physical(key, values);
      const record = { record_id: `${key}_${sequence}`, fields };
      tables[key] = [...(tables[key] || []), record];
      calls.create.push({ table: key, values: { ...values }, record_id: record.record_id });
      return { recordId: record.record_id, record };
    },
    async update(key, id, values) {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      Object.assign(record.fields, physical(key, values));
      calls.update.push({ table: key, record_id: id, values: { ...values } });
      return record;
    },
    async uploadAttachment(filePath) {
      calls.upload.push(path.basename(String(filePath || '')));
      const token = `file_token_${calls.upload.length}`;
      tokenNames.set(token, path.basename(String(filePath || '')));
      return token;
    },
  };
  gateway.createdIn = (table) => calls.create.filter((call) => call.table === table);
  return gateway;
};

/** 「报货」那条链的真 `PurchaseWebhookService`（免确认路径）＋ 假出图 / 假飞书。 */
const reportHarness = () => {
  const gateway = createFakeGateway({
    // 尺码管理：报货明细的「尺码」是关联字段，写明细要按号换 record_id ✓
    sizeManagement: [40, 41, 42, 43].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } })),
    // 供应商名录：出图那句"@经办人 甲供应商 这批 N 双"要按 record_id 换名字 ✓
    supplier: [
      { record_id: 'sup_a', fields: { 供应商名称: '甲供应商' } },
      { record_id: 'sup_b', fields: { 供应商名称: '乙供应商' } },
      { record_id: 'sup_c', fields: { 供应商名称: '丙供应商' } },
      { record_id: 'sup_only', fields: { 供应商名称: '独供应商' } },
    ],
  });
  const renders = [];
  const messages = [];
  let batchNoCalls = 0;
  const service = new PurchaseWebhookService({
    gateway,
    store: new JsonTaskStore({ dir: tempDir('webhook'), idField: 'task_id' }),
    references: {
      resolveProduct: async () => ({ recordId: 'prod_1', record: { record_id: 'prod_1', fields: {} } }),
      resolveSupplier: async () => null,
      resolveBehavior: async () => ({ recordId: 'bh_request', record: { record_id: 'bh_request', fields: {} } }),
    },
    inventory: { applyPurchase: async () => ({}) },
    client: {
      im: {
        image: {
          create: async () => ({ image_key: 'img_key' }),
        },
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
    // 假出图：**记下每一次渲染的入参**（哪几家、每组哪些行 ✓）—— 从图形库那一层看分组
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
    gateway, service, renders, messages,
    batchNoCalls: () => batchNoCalls,
  };
};

/**
 * 一份「一单多货品」的报货任务（= 引擎 `planSubmission` 出来那个载荷的形状 ✓）：
 * 每条明细**自带自己的供应商**（`AC-SS1` 靠它分组）。
 */
const reportTask = ({ items, supplierRecordId = '', isBatch = true } = {}) => ({
  is_batch: isBatch,
  operator_open_id: 'ou_1',
  supplier_record_id: supplierRecordId,
  behavior_record_id: 'bh_request',
  items,
});

const line = (supplier, size, quantity, product = 'prod_1') => ({
  product_record_id: product, item_no: product, color: '黑色',
  size, quantity, supplier_record_id: supplier, behavior_record_id: 'bh_request',
});

const seedTask = async (service, taskId, draft) => service.store.create({
  task_id: taskId, kind: 'scan_replenish', status: 'posting', draft,
});

const BATCH_FIELD = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.batchNo;
const DOCUMENT_FIELD = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.document;

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS1 一个批次号下 3 个供应商 ⇒ 3 组（每组只含该供应商的行）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS1 ⭐⭐ 一个批次号下 3 个供应商 ⇒ 报货单**按供应商分成 3 组**（每组只含该供应商的行）', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_ss1', reportTask({
    // 批次级供应商按"一单多货品"的形状留空（N>1 时没有"一个供应商"可言 ✓）
    supplierRecordId: '',
    items: [
      line('sup_a', 40, 2), line('sup_a', 41, 1),
      line('sup_b', 40, 3),
      line('sup_c', 42, 1), line('sup_c', 43, 2),
    ],
  }));
  const result = await h.service.publishPurchaseRequest('t_ss1', task);

  // ① 出图那一步**分成 3 组**（每一组只含该供应商的行 ✓）
  assert.equal(h.renders.length, 3, '3 个供应商 ⇒ 3 张报货单（能真红：不分组 ⇒ 只渲染 1 次）');
  const bySupplier = h.renders.map((render) => ({
    suppliers: new Set(render.items.map((item) => item.supplier_record_id)),
    lines: render.items.length,
  }));
  for (const render of bySupplier) {
    assert.equal(render.suppliers.size, 1, '每一组**只含一个供应商**的行（混进去 ⇒ 红）');
  }
  assert.deepEqual(
    bySupplier.map((render) => [...render.suppliers][0]).sort(), ['sup_a', 'sup_b', 'sup_c'],
    '3 个供应商各出一张、一个不多一个不少 ✓',
  );
  assert.deepEqual(bySupplier.map((render) => render.lines), [2, 1, 2], '每组只带自己的行（顺序 = 明细里第一次出现的顺序）');
  // ② 三张图都挂在**同一个批次号**的主表行上（「单据」是附件列，支持多文件 ✓）
  assert.equal(h.gateway.tables.purchaseOrderBatch.length, 1, '主表只有一行 ✓');
  const cell = h.gateway.tables.purchaseOrderBatch[0].fields[DOCUMENT_FIELD];
  assert.equal(attachmentNames(cell).length, 3, '「单据」里 3 张（每家一张）✓');
  // ③ 群消息也是每家一套（图 + @经办人那句）
  assert.equal(h.messages.length, 6, '3 家 × （1 张图 + 1 条 @文字）= 6 条 ✓');
  assert.equal(result.image_delivery.sent.length, 3, '3 组都发出去了 ✓');
  assert.equal(result.image_delivery.group_count, 3);
  assert.equal(result.image_delivery.batch_count, 1, '她选的 ⓐ：**批次号仍然只有一个** ✓');
  // 计划里冻结的那 3 组也随结果交出来（"生成那一步就算好了"的证据 ✓）
  assert.equal(result.supplier_groups.length, 3);
  assert.deepEqual(result.supplier_groups.map((group) => group.supplier_key), ['sup_a', 'sup_b', 'sup_c']);
  assert.equal(new Set(result.supplier_groups.map((group) => group.group_key)).size, 3, '每组一把组级幂等键 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS2 单供应商 ⇒ 与今天逐字一致
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS2 ⭐⭐ 单供应商 ⇒ 递给写入口的**载荷逐字相同**（分组不往载荷里加一个字段）', () => {
  const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');
  const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
  // 引擎不认识 store 以外的东西：这里只调**纯函数** `planSubmission`（零 IO ✓）
  const engine = createMultiItemOrderService({
    sessions: { ensure: async () => ({}), store: {}, idOf: (openId) => `scan_session_${openId}` },
    config: MULTI_ITEM_ORDER,
    writers: {},
  });
  const draft = {
    open_id: 'ou_me', order_key: 'scan_replenish:s:1', order_amount: '',
    items: [
      { product_record_id: 'rec_K1', number: 'K1|黑色|A', item_no: 'K1', color: '黑色', supplier_record_id: 'sup_K1', entries: [{ size: 40, quantity: 2 }] },
      { product_record_id: 'rec_K2', number: 'K2|黑色|A', item_no: 'K2', color: '黑色', supplier_record_id: 'sup_K1', entries: [{ size: 40, quantity: 3 }] },
    ],
  };
  const plan = engine.planSubmission({
    draft, chainConfig: MULTI_ITEM_ORDER.chains.replenish, submitKey: 'scan_replenish:s:1',
    behavior: { recordId: 'bh_1', kind: 'purchase_request' },
  });
  // ⚠️ 期望值**逐字抄自** `test/multiItemOrderStep1.test.js` 里那份"与旧路径逐字等价"的载荷
  //    （那一条是 N=1；这里 N=2 同供应商 —— **分组前后必须一个字节都不差** ✓）
  assert.deepEqual(plan.payload, {
    is_batch: true,
    product_record_id: '',
    product_number: '',
    item_no: '',
    color: '',
    supplier_record_id: '',
    behavior_record_id: 'bh_1',
    operator_open_id: 'ou_me',
    items: [
      {
        product_record_id: 'rec_K1', product_number: 'K1|黑色|A', item_no: 'K1', color: '黑色',
        supplier_record_id: 'sup_K1', size: 40, quantity: 2,
        behavior_record_id: 'bh_1', behavior_kind: 'purchase_request',
      },
      {
        product_record_id: 'rec_K2', product_number: 'K2|黑色|A', item_no: 'K2', color: '黑色',
        supplier_record_id: 'sup_K1', size: 40, quantity: 3,
        behavior_record_id: 'bh_1', behavior_kind: 'purchase_request',
      },
    ],
  }, '载荷必须**逐字不变**（能真红：往载荷里塞一个 supplier_groups ⇒ 红 ✓）');
  // 分组只有 1 组（= 今天那种情况），且**批次号只有 1 个**
  assert.equal(plan.supplierGroups.length, 1, '单供应商 ⇒ 只有 1 组 ✓');
  assert.equal(plan.batchCount, 1);
  assert.equal(plan.summary.supplier_group_count, 1);
});

test('AC-SS2b 单供应商走真链路 ⇒ 只出 1 张图、主表 1 行、单据 1 个（与今天逐字一致）', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_ss2b', reportTask({
    supplierRecordId: 'sup_only',
    items: [line('sup_only', 40, 2), line('sup_only', 41, 1)],
  }));
  const result = await h.service.publishPurchaseRequest('t_ss2b', task);
  assert.equal(h.renders.length, 1, '单供应商 ⇒ 只渲染 1 次 ✓');
  assert.equal(h.renders[0].items.length, 2, '这一组就是全部 2 行 ✓');
  assert.equal(h.gateway.tables.purchaseOrderBatch.length, 1);
  assert.equal(attachmentNames(h.gateway.tables.purchaseOrderBatch[0].fields[DOCUMENT_FIELD]).length, 1);
  assert.equal(h.messages.length, 2, '图 + @文字（与今天逐字一致 ✓）');
  assert.equal(result.image_delivery.batch_count, 1);
  assert.equal(result.image_delivery.group_count, 1);
  assert.equal(result.supplier_groups.length, 1, '单供应商 ⇒ 计划里也只有 1 组 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS3 分组**不新增批次号**（她选的 ⓐ）
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS3 🔴 分组**不新增批次号**：3 个供应商 ⇒ 主表只 1 行、号源只取 1 次（能真红：多一个号 ⇒ 红）', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_ss3', reportTask({
    supplierRecordId: '',
    items: [line('sup_a', 40, 1), line('sup_b', 40, 1), line('sup_c', 40, 1)],
  }));
  const result = await h.service.publishPurchaseRequest('t_ss3', task);
  assert.equal(h.gateway.tables.purchaseOrderBatch.length, 1, '🔴 只许有**一行**主表（ⓑ 会变成 3 行 ⇒ 红）');
  assert.equal(h.batchNoCalls(), 1, '🔴 号源**只许取一次**（每个供应商各开一个新号 = 她没选的 ⓑ ✗）');
  const rows = h.gateway.tables.purchaseOrderBatch;
  assert.equal(String(rows[0].fields[BATCH_FIELD]), result.batch_no, '那一个批次号就是计划的号 ✓');
  // 明细行的「报货批次号」都指向**同一个**批次记录（一批多供应商，明细各带自己的供应商 ✓）
  const detailLinks = new Set(
    (h.gateway.tables.purchaseRequest || []).map((record) => JSON.stringify(record.fields['报货批次号'])),
  );
  assert.equal(detailLinks.size, 1, '3 行明细挂在**同一个批次行**上 ✓');
  // 纯函数那一层也钉住：`batchCount` 恒为 1（ⓐ 的物理含义）
  const split = splitBySupplier({
    items: [{ supplier_record_id: 'a' }, { supplier_record_id: 'b' }], batchNo: 'CGD-1', batchKey: 'purchase_batch:t',
  });
  assert.equal(split.batchCount, 1);
  assert.equal(split.batchNo, 'CGD-1');
  assert.equal(split.groups.length, 2, '同一个批次号下的 2 组 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS4 幂等：同一组重复生成 ⇒ 只出一次
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS4 🔴 幂等：同一组重复生成 ⇒ **只出一次**（重放 0 张图 / 0 条群消息 / 0 个新附件）', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_ss4', reportTask({
    supplierRecordId: '',
    items: [line('sup_a', 40, 1), line('sup_b', 40, 1), line('sup_c', 40, 1)],
  }));
  await h.service.publishPurchaseRequest('t_ss4', task);
  const rendersAfterFirst = h.renders.length;
  const messagesAfterFirst = h.messages.length;
  const uploadsAfterFirst = h.gateway.calls.upload.length;
  const documentsAfterFirst = attachmentNames(
    h.gateway.tables.purchaseOrderBatch[0].fields[DOCUMENT_FIELD],
  ).length;
  assert.deepEqual([rendersAfterFirst, messagesAfterFirst, uploadsAfterFirst, documentsAfterFirst], [3, 6, 3, 3]);

  // 重放同一次提交（同一个 task ⇒ 同一份计划；与 `test/purchaseDetailId.test.js` 的 AC-ID4 同形）
  const again = await h.service.store.get('t_ss4');
  const replay = await h.service.publishPurchaseRequest('t_ss4', again);
  assert.equal(h.renders.length, rendersAfterFirst, '🔴 重放**一张图都不许再出**（能真红：去掉"已经出过"那一步 ⇒ 红）');
  assert.equal(h.messages.length, messagesAfterFirst, '🔴 群里也不许再发一遍 ✗');
  assert.equal(h.gateway.calls.upload.length, uploadsAfterFirst, '附件也不用再传一次 ✓');
  assert.equal(
    attachmentNames(h.gateway.tables.purchaseOrderBatch[0].fields[DOCUMENT_FIELD]).length,
    documentsAfterFirst, '「单据」里还是那 3 张、不重复 ✗',
  );
  assert.deepEqual(replay.image_delivery.sent, [], '这一次一组都没发 ✓');
  assert.deepEqual(replay.image_delivery.already_reported.slice().sort(), ['丙供应商', '乙供应商', '甲供应商'].sort(),
    '如实报"这三组都已经出过"（`already_reported` 与 `sent` **分开报** ✓ 不混为一谈 ✗）');
  assert.equal(h.gateway.tables.purchaseOrderBatch.length, 1, '重放也不会多一行主表 ✓');
  assert.equal(h.batchNoCalls(), 1, '重放不取新号 ✓');
});

test('AC-SS4b 探针：判据不是空跑 —— 把"单据"里那张图去掉 ⇒ 这一组**就会再出一次**', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_ss4b', reportTask({
    supplierRecordId: '', items: [line('sup_a', 40, 1)],
  }));
  await h.service.publishPurchaseRequest('t_ss4b', task);
  assert.equal(h.renders.length, 1);
  // 手动把"已经出过"的证据拿掉（= 模拟"其实没出过"）⇒ 必须**重出**（否则就是静默少发一家 ✗）
  h.gateway.tables.purchaseOrderBatch[0].fields[DOCUMENT_FIELD] = [];
  await h.service.publishPurchaseRequest('t_ss4b', await h.service.store.get('t_ss4b'));
  assert.equal(h.renders.length, 2, '证据不在了 ⇒ 照旧要出（判据读的是**已经落库的事实** ✓）');
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS5 存草稿阶段**零副作用**（混 3 个供应商也一样）
//   ⚠️ **成对迁移（2026-10-16 下半场 · main 上的 #735 S2）** —— 这一条**改过一次**，逐字留痕：
//     · **改前逐字**：`assert.equal((gateway.tables.purchaseRequest || []).length, 0, '🔴 **不建采购明细**（草稿不是报货单 ✗）');`
//     · **改后逐字**：下面那两段（① 明细**会**写但用的是**草稿专用**幂等键前缀；② 她点名的三个副作用仍为零）
//     · **依据**：她 2026-10-16 逐字「**草稿也写明细**」（Lead 弹窗问"草稿会不会写到采购明细"时她选的）
//       ⇒ #735 已把 S1 的 `AC-D1`（"采购明细 0 次"）**成对迁移**掉 ⇒ 本文件**不许**再钉"0 行" ✗
//       （旧断言会与 main 上那条口径**打架**，而且它本来就**不是**她点名的那三个副作用之一 ✓）。
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS5 ⭐ 混 3 个供应商 ⇒ 拆分发生在【生成报货单】那一步（她选的 ⓐ：同一批次号）', async () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`AC-SS5 ⭐ 存草稿（混 3 个供应商）⇒ 不发群 / 不出图 / 不写库存 / 不出报货单（明细按 #735 的新口径会写）`
  //     —— 它证的是"**存草稿阶段不拆**"；而**存草稿那条链已整件退场** ✗ ⇒ 被测对象不存在了
  //   改后逐字：本行 —— **改钉同一条语义的另一半**：拆分发生在**生成**那一步、且**不新增批次号** ✓
  //   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**存草稿的功能都删除吧，不需要了，前端和后端都不需要了，整个链路都删除**」✓
  const cfg = resolveSupplierSplitConfig({});
  assert.equal(cfg.stage, SPLIT_STAGE, '拆的那一步 = 生成报货单 ✓');
  assert.equal(cfg.batchNoPolicy, BATCH_NO_POLICIES.sameBatchNo, '同一批次号下按供应商分组（她选的 ⓐ）✓');

  // ① 行为（**既有生成链**，与 AC-SS1 同一套夹具）：混 3 个供应商 ⇒ **生成时**分成 3 组
  const h = reportHarness();
  const task = await seedTask(h.service, 't_ss5', reportTask({
    supplierRecordId: '',
    items: [line('sup_a', 40, 2), line('sup_b', 41, 1), line('sup_c', 42, 1)],
  }));
  await h.service.publishPurchaseRequest('t_ss5', task);
  assert.equal(h.renders.length, 3, '生成那一步才拆：3 个供应商 ⇒ 3 张（能真红：不拆 ⇒ 只 1 张 ✗）');
  const suppliers = h.renders.map((render) => [...new Set(render.items.map((item) => item.supplier_record_id))].join(','));
  assert.deepEqual(suppliers.sort(), ['sup_a', 'sup_b', 'sup_c'], '每组只含自己那个供应商的行 ✓');

  // ② ⭐ 源码哨兵：**拆分只在服务端生成那条路上**（页面 / 路由那条"装配 · 草稿"的路**一个调用点都不许有** ✗）
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      if (/splitBySupplier\s*\(/.test(fs.readFileSync(full, 'utf8'))) {
        callers.push(path.relative(path.join(__dirname, '..'), full));
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.ok(callers.some((file) => file.startsWith('src/services/')), `拆分要在服务端那条路上 ✓（实际：${callers.join(' / ')}）`);
  assert.ok(!callers.some((file) => file.startsWith('src/routes/') || file.startsWith('src/views/')),
    `拆分的调用点不许落在路由/页面（装配 · 草稿那条路）✗（实际：${callers.join(' / ')}）`);
});

test('AC-SS6 ⭐⭐ `supplierSplit` 不再是 `undecided`：落成她选的 ⓐ `same_batch_no`（ⓑ 配了就抛）', () => {
  // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
  //   改前逐字：`const draftConfig = resolveScanDraftConfig({}); assert.equal(draftConfig.supplierSplit, 'generate_report', …)`
  //             ＋ `const { SUPPLIER_SPLIT: DRAFT_SUPPLIER_SPLIT } = require('../src/config/scanDraft');`
  //   改后逐字：下面这三行 —— 真源改为**既有** `config/supplierSplit.js`（草稿那一份已整件退场 ✗）
  //   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**整个链路都删除**」✓
  assert.equal(SUPPLIER_SPLIT.stage, SPLIT_STAGE, '拆的那一步 = 生成报货单 ✓（不是存草稿 ✗）');
  assert.equal(SUPPLIER_SPLIT.batchNoPolicy, 'same_batch_no', '她选的 ␐（不许回 `undecided` ✗）');
  assert.equal(resolveSupplierSplitConfig({}).stage, 'generate_report');
  const splitConfig = resolveSupplierSplitConfig({});
  assert.equal(splitConfig.batchNoPolicy, BATCH_NO_POLICIES.sameBatchNo);
  assert.equal(splitConfig.batchNoPolicy, 'same_batch_no');
  // ⓑ「每个供应商各开一个新批次号」**不是可选项**：配上就**当场抛**（不静默按 ⓐ 走 ✗）
  assert.throws(
    () => resolveSupplierSplitConfig({ SUPPLIER_SPLIT_BATCH_NO_POLICY: 'new_batch_no_per_supplier' }),
    /SUPPLIER_SPLIT_BATCH_NO_POLICY/,
    '她没选的 ⓑ 必须是**认不出的值**（能真红：把这个校验删掉 ⇒ 红 ✓）',
  );
  // 每组的幂等键**稳定可算**（同一批 + 同一供应商 ⇒ 永远同一把键 ✓）
  const one = splitBySupplier({ items: [{ supplier_record_id: 'sup_a' }], batchNo: 'CGD-1', batchKey: 'purchase_batch:t1' });
  const two = splitBySupplier({ items: [{ supplier_record_id: 'sup_a' }], batchNo: 'CGD-1', batchKey: 'purchase_batch:t1' });
  assert.equal(one.groups[0].group_key, two.groups[0].group_key, '组键稳定 ⇒ 重复生成不会多出一组 ✓');
  assert.match(one.groups[0].group_key, /^supplier_group:purchase_batch:t1:sup_a$/);
  assert.match(one.groups[0].document_key, /^supplier_document:CGD-1:sup_a$/);
  // 拿不到供应商 ⇒ 落**明确的**"没标注"桶（不猜、也不把这些行丢掉 ✗）
  const noSupplier = splitBySupplier({ items: [{}, {}], batchNo: 'CGD-1' });
  assert.equal(noSupplier.groups.length, 1);
  assert.equal(noSupplier.groups[0].supplier_key, 'unspecified');
  assert.equal(noSupplier.groups[0].detail_count, 2);
  // 文件名拼法**唯一一处**（"已经出过"的判据与落点必须同名 ✓）
  assert.equal(documentFileNameOf('三星', '采购单'), '三星-采购单.png');
  assert.equal(documentFileNameOf('', '采购单'), 'supplier-采购单.png');
  // 分桶口径与出图那边**同一个纯函数**（老形状逐字兼容：`supplierRecordId` / `items` / `indexes`）
  const groups = groupItemsBySupplier([{ supplier_record_id: 'a' }, { supplier_record_id: 'b' }, { supplier_record_id: 'a' }]);
  assert.deepEqual(groups, [
    { key: 'a', supplierRecordId: 'a', items: [{ supplier_record_id: 'a' }, { supplier_record_id: 'a' }], indexes: [0, 2] },
    { key: 'b', supplierRecordId: 'b', items: [{ supplier_record_id: 'b' }], indexes: [1] },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-SS7 源码哨兵
// ═══════════════════════════════════════════════════════════════════════════

test('AC-SS7 🔴 `scanWriteService.js` 与 main **逐字节一致**（余量 0：谁改一个字就红）', () => {
  const frozen = path.join(__dirname, '..', 'src', 'services', 'scanWriteService.js');
  assert.equal(sha256Of(fs.readFileSync(frozen)), FROZEN_SHA256, '冻结件被改过一个字节 ✗');
});

test('AC-SS7b 源码哨兵：分组模块**不认识飞书**（不写表、不 require 网关/schema/冻结件）', () => {
  const code = SPLIT_SERVICE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['gateway', 'v1BitableSchema', 'scanWriteService', 'createOnceByKey', 'store.update']) {
    assert.equal(code.includes(forbidden), false, `分组模块里不许出现 ${forbidden}（纯函数 ✓ 写表是别人的事 ✗）`);
  }
  // 中文列名一个字都不许写死（列名只有 `config/v1BitableSchema.js` 一处 ✓）
  assert.equal(/[\u4e00-\u9fa5]/.test(code), false, '分组模块的逻辑里不许有中文字面量（配置先行 ✓）');
});

/**
 * ── MUTATION（每一组都**真跑过**：改一处 ⇒ 指定用例红；改回来 ⇒ 逐字节一致）────────
 *  ① 去掉 `deliverSupplierImagesInner` 里"这一组已经出过 ⇒ 跳过"那一段（前置 `findDocument` 判据）
 *     ⇒ AC-SS4 红（重放又渲染 3 次）；AC-SS4b 仍绿（那一条证的是相反方向 ✓）。
 *  ② 把 `splitBySupplier` 的 `batchCount` 改成 `groups.length`（= ⓑ 的口径）
 *     ⇒ AC-SS3 红（`batchCount` 不再是 1）。
 *  ③ 往 `planSubmission` 的 `payload` 里塞一个 `supplier_groups`
 *     ⇒ AC-SS2 红（载荷不再逐字相同）。
 *  ④ 把 `resolveSupplierSplitConfig` 的取值校验删掉（允许 `new_batch_no_per_supplier`）
 *     ⇒ AC-SS6 红（"ⓑ 配了就抛"那一条不再成立）。
 */
