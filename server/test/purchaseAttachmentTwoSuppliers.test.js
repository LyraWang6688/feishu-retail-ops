/**
 * 采购「单据」附件多文件追加 —— **两个供应商**的验收形状（**test-only 覆盖补强**）。
 *
 * ── 这一条钉的是什么（业务负责人已确认的 **A 方案**，逐字）──────────────────────
 *   「一次补货出现多个供应商 ⇒ **同一张采购主表**，但「单据」附件要**追加多张采购单图片**，
 *    不能后写覆盖。」
 *
 * ── 为什么提这个 PR（改前逐字 → 改后逐字 → 依据）────────────────────────────────
 *   改前逐字：`#736 feat(purchase): 「生成报货单时按供应商拆分/分组」—— 落定她选的 ⓐ（同一批次号下分组）`
 *             ＋ `#761 feat(return): 退货一单多货 + 出单按供应商分组（task-64）`
 *             —— 业务代码**已经**是"读已有附件 + 追加"：
 *                `services/purchaseOrderBatchService.js` 的 `writeDocument`
 *                （已有 token 原样带上 + `Set` 合并去重）＋ `findDocument`（按文件名判"这一张出过没"）；
 *                `services/purchaseWebhookService.js` 的 `deliverSupplierImagesInner`
 *                （按供应商分组循环 → 出图 → `writeSupplierImageAttachment` → `writeDocument`）。
 *             ⇒ **本 PR 不加任何业务代码**（不重复造轮子 ✓）。
 *   改后逐字：本文件 —— 把 A 方案的验收形状**逐条钉成回归**：
 *             ① 两个供应商、**同一批次号** ⇒ 采购主表**恰好 1 条**；
 *             ② 采购明细**恰好 2 条**，且**都挂在同一批次行**；
 *             ③ 「单据」里**恰好 2 个 file_token**，文件名分别对应两张采购单；
 *             ④ 同一请求**重放** ⇒ 主表 / 明细不新增、附件不重复、**上传次数不增加**（不重复上传）；
 *             ⑤ 其中一张同名图**已存在** ⇒ **只补缺的那张**，另一张 token 原样保留、不重复上传。
 *   依据 = 业务负责人 2026-10-18 确认 A 方案；既有 `test/supplierSplitAtGeneration.test.js` 只钉了
 *          **3 个供应商**那版，且"明细恰好 2 条"没有任何用例钉住（AC-SS3 只钉了明细都指向同一批次行，
 *          没钉条数）⇒ 这是真实覆盖缺口；Lead 裁决选 ②（test-only），不动 src、不动 scan / sales ✓。
 *
 * ── MUTATION（"改哪一处就该红"；**三条都真跑过**，跑完 `git checkout -- <该文件>` 还原 ✓）──────
 *  ① `purchaseOrderBatchService.writeDocument` 去掉"已有附件原样带上"：
 *     把 `const tokens = [...new Set([...existingTokens, fileToken])];` 改成 `const tokens = [fileToken];`
 *     ⇒ **3 条全红**（用例 1 第二次写之后「单据」只剩 1 个 token；用例 2/3 的 token 断言也红）。
 *  ② `purchaseOrderBatchService.findDocument` 的 `exists` 改成恒 `false`（"已存在 ⇒ 跳过"判据失效）
 *     ⇒ **用例 2 / 3 红**（重放会重新出图 + 重新上传；用例 1 仍绿 —— 它证的是另一件事 ✓）。
 *  ③ `findDocument` 的 `exists` 只看"这一批有没有任何附件"
 *     （`attachmentNames(cell).includes(fileName)` → `attachmentNames(cell).length > 0`，
 *      = 从"按组判"退化成"整批跳过"）⇒ **3 条全红**（用例 3 的缺图补不上；1/2 也因预检误跳过而红）。
 *  ⚠️ 变异的前提：**本 PR 不加任何 src 代码** ⇒ 变异只为证明断言能真红，跑完立即还原；
 *     `git status` 的最终结果只有本文件一个新增 ✓。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_purchase_attach_two';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'purchase_attach_two_secret';

const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const {
  PurchaseOrderBatchService, attachmentTokens, attachmentNames,
} = require('../src/services/purchaseOrderBatchService');
const { documentFileNameOf } = require('../src/services/supplierSplitService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `purchase-attach-${label}-`));

// 语义键 → 物理列名**只从 schema 取**（列名一处定义 ✓；不在用例里再写一份中文字面量）。
const BATCH_NO_FIELD = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.batchNo;
const DOCUMENT_FIELD = V1_BITABLE_SCHEMA.tables.purchaseOrderBatch.fields.document;
const DETAIL_BATCH_FIELD = V1_BITABLE_SCHEMA.tables.purchaseRequest.fields.batchNo;
const DOCUMENT_FILE_SUFFIX = '采购单';

// ═══════════════════════════════════════════════════════════════════════════
// 假件（**零真表写入**：本文件从头到尾不 require 真实客户端，也不读 `.env`）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 假 gateway：一张内存表 ＋ **记账**（create / update / 附件上传每一次都留痕）。
 *
 * ⚠️ 附件列要**像飞书那样回填文件名**：真飞书把 `{file_token}` 写进附件列之后，读回来是
 *    `{file_token, name}`（名字来自上传时那个文件）。假件按 `uploadAttachment(filePath)` 的
 *    base name 记下 token→name，`update` 时补上 ✓ —— 这正是"这一组的采购单已经出过了"能被
 *    判出来的物理基础（与 `test/supplierSplitAtGeneration.test.js` 的假件同形状 ✓）。
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
    ],
  });
  const renders = [];
  const messages = [];
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
    // 假出图：**记下每一次渲染的入参**（哪家供应商、哪一批 ✓）
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
      next: async () => ({ batchNo: 'CGD-20261018-0001' }),
    },
    sandboxChatId: 'oc_test_group',
  });
  return {
    gateway, service, renders, messages,
  };
};

/** 一份「两个供应商」的报货任务（= 引擎 `planSubmission` 出来那个载荷的形状 ✓）。 */
const twoSupplierTask = () => ({
  is_batch: true,
  operator_open_id: 'ou_1',
  supplier_record_id: '',
  behavior_record_id: 'bh_request',
  items: [
    line('sup_a', 40, 2),
    line('sup_b', 41, 1),
  ],
});

const line = (supplier, size, quantity, product = 'prod_1') => ({
  product_record_id: product, item_no: product, color: '黑色',
  size, quantity, supplier_record_id: supplier, behavior_record_id: 'bh_request',
});

const seedTask = async (service, taskId, draft) => service.store.create({
  task_id: taskId, kind: 'scan_replenish', status: 'posting', draft,
});

// ── 读数小工具（只看落表结果 / 记账，不重复业务逻辑）──────────────────────────
const batchRows = (h) => h.gateway.tables.purchaseOrderBatch || [];
const detailRows = (h) => h.gateway.tables.purchaseRequest || [];
const documentCell = (h) => batchRows(h)[0]?.fields?.[DOCUMENT_FIELD];
const createsOf = (h, table) => h.gateway.calls.create.filter((call) => call.table === table).length;

// ═══════════════════════════════════════════════════════════════════════════
// 用例 1：两个供应商的验收形状（1 主表 + 恰好 2 明细 + 恰好 2 附件）
// ═══════════════════════════════════════════════════════════════════════════

test('A-ATTACH-1 ⭐⭐ 两个供应商、同一批次号 ⇒ 主表 1 条 + 明细 2 条（同挂一批）+「单据」2 个附件', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_attach_two', twoSupplierTask());
  const result = await h.service.publishPurchaseRequest('t_attach_two', task);

  // ① 同一批次号：出图那两次拿到的是**同一个号**（能真红：每供应商一个新号 ⇒ 两个 batchNo ✗）
  assert.equal(h.renders.length, 2, '两个供应商 ⇒ 出 2 张采购单（不拆 ⇒ 只 1 张 ✗）');
  assert.deepEqual(
    [...new Set(h.renders.map((render) => render.batchNo))],
    [result.batch_no],
    '两张图上的批次号都是**同一个**（A 方案：同一张采购主表 ✓）',
  );
  assert.equal(result.image_delivery.batch_count, 1, '只允许一个批次 ✓');

  // ② 采购主表**恰好 1 条**，且批次号就是结果里那个
  assert.equal(batchRows(h).length, 1, '🔴 主表**恰好 1 条**（A 方案：同一张主表；2 条 ⇒ 红）');
  assert.equal(createsOf(h, 'purchaseOrderBatch'), 1, '主表只 create 过 1 次 ✓');
  assert.equal(
    String(batchRows(h)[0].fields[BATCH_NO_FIELD] ?? ''), String(result.batch_no),
    '主表那一行的「报货批次号」= 这一次的批次号 ✓',
  );
  const batchRecordId = batchRows(h)[0].record_id;

  // ③ 采购明细**恰好 2 条**，且**都挂在同一批次行**
  assert.equal(detailRows(h).length, 2, '🔴 明细**恰好 2 条**（一个供应商一条；3 条 / 1 条 ⇒ 红）');
  assert.equal(createsOf(h, 'purchaseRequest'), 2, '明细只 create 过 2 次 ✓');
  const detailBatchLinks = detailRows(h).map((record) => record.fields[DETAIL_BATCH_FIELD]);
  for (const link of detailBatchLinks) {
    assert.deepEqual(link, [batchRecordId], `每条明细的「${DETAIL_BATCH_FIELD}」都指向**那唯一一条**主表行 ✓`);
  }
  assert.equal(
    new Set(detailBatchLinks.map((link) => JSON.stringify(link))).size, 1,
    '2 条明细挂在**同一个**批次行上（不是各挂各的 ⇒ 那是 ⓑ ✗）',
  );

  // ④ 「单据」里**恰好 2 个 file_token**，文件名分别对应两张采购单
  const cell = documentCell(h);
  const tokens = attachmentTokens(cell);
  const names = attachmentNames(cell).slice().sort();
  assert.equal(tokens.length, 2, '🔴 「单据」**恰好 2 个 file_token**（后写覆盖 ⇒ 只剩 1 个 ✗）');
  assert.equal(new Set(tokens).size, 2, '两个 token 互不相同（不是同一张图写了两遍）');
  assert.deepEqual(
    names,
    [
      documentFileNameOf('甲供应商', DOCUMENT_FILE_SUFFIX),
      documentFileNameOf('乙供应商', DOCUMENT_FILE_SUFFIX),
    ].sort(),
    '文件名分别对应两家供应商的采购单 ✓',
  );
  assert.equal(result.image_delivery.sent.length, 2, '两家都发出去了 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 用例 2：同一请求重放 ⇒ 主表 / 明细不新增、附件不重复、**零上传**
// ═══════════════════════════════════════════════════════════════════════════

test('A-ATTACH-2 🔴 同一请求重放 ⇒ 主表 1 / 明细 2 / 附件 2 不变，且**上传次数不增加**', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_attach_replay', twoSupplierTask());
  await h.service.publishPurchaseRequest('t_attach_replay', task);

  // 第一次跑完的账
  const uploadsAfterFirst = h.gateway.calls.upload.length;
  const rendersAfterFirst = h.renders.length;
  const messagesAfterFirst = h.messages.length;
  const tokensAfterFirst = attachmentTokens(documentCell(h));
  assert.deepEqual(
    [batchRows(h).length, detailRows(h).length, tokensAfterFirst.length, uploadsAfterFirst],
    [1, 2, 2, 2],
    '第一次跑完：主表 1 / 明细 2 / 附件 2 / 上传 2 ✓',
  );

  // 重放**同一次提交**（同一个 task ⇒ 同一份计划；与 `test/purchaseDetailId.test.js` 的 AC-ID4 同形）
  const again = await h.service.store.get('t_attach_replay');
  await h.service.publishPurchaseRequest('t_attach_replay', again);

  assert.equal(batchRows(h).length, 1, '🔴 重放不新增主表 ✓');
  assert.equal(createsOf(h, 'purchaseOrderBatch'), 1, '🔴 主表 create 次数不变 ✓');
  assert.equal(detailRows(h).length, 2, '🔴 重放不新增明细 ✓');
  assert.equal(createsOf(h, 'purchaseRequest'), 2, '🔴 明细 create 次数不变 ✓');
  assert.deepEqual(
    attachmentTokens(documentCell(h)), tokensAfterFirst,
    '🔴 「单据」还是那 2 个 token、一个不多一个不少（能真红：去掉"已存在 ⇒ 跳过"⇒ 变 4 个）',
  );
  assert.equal(
    h.gateway.calls.upload.length, uploadsAfterFirst,
    '🔴 **零上传**：同名图已存在 ⇒ 连素材都不再传一次（能真红：去掉跳过判据 ⇒ 4 次）',
  );
  assert.equal(h.renders.length, rendersAfterFirst, '重放不重新出图 ✓');
  assert.equal(h.messages.length, messagesAfterFirst, '重放不再往群里发 ✓');
});

// ═══════════════════════════════════════════════════════════════════════════
// 用例 3：其中一张同名图已存在 ⇒ **只补缺的那张**、另一张 token 原样保留
// ═══════════════════════════════════════════════════════════════════════════

test('A-ATTACH-3 🔴 一张已存在 ⇒ 只补缺的那张（另一张 token 原样保留、不重复上传）', async () => {
  const h = reportHarness();
  const task = await seedTask(h.service, 't_attach_partial', twoSupplierTask());
  await h.service.publishPurchaseRequest('t_attach_partial', task);

  const uploadsAfterFirst = h.gateway.calls.upload.length;
  const rendersAfterFirst = h.renders.length;
  const [firstToken, secondToken] = attachmentTokens(documentCell(h));
  assert.equal(uploadsAfterFirst, 2);
  assert.deepEqual([firstToken, secondToken], ['file_token_1', 'file_token_2'], '第一轮两家各传一次 ✓');

  // 模拟「甲供应商那张已经在了、乙供应商那张不在」（例：上一次只回填成功了一张）
  const keptName = documentFileNameOf('甲供应商', DOCUMENT_FILE_SUFFIX);
  const missingName = documentFileNameOf('乙供应商', DOCUMENT_FILE_SUFFIX);
  const kept = documentCell(h).find((item) => item?.name === keptName);
  assert.ok(kept, '前提：甲供应商那张在「单据」里 ✓');
  h.gateway.tables.purchaseOrderBatch[0].fields[DOCUMENT_FIELD] = [kept];

  const again = await h.service.store.get('t_attach_partial');
  await h.service.publishPurchaseRequest('t_attach_partial', again);

  // ① 只补缺的那张：**恰好再多渲染 1 次、多上传 1 次**
  assert.equal(h.renders.length, rendersAfterFirst + 1, '只重新出**缺的那一张**（另一家不算"没出过" ✗）');
  assert.equal(h.renders[rendersAfterFirst].supplierName, '乙供应商', '补的是缺的乙供应商那张 ✓');
  assert.equal(h.gateway.calls.upload.length, uploadsAfterFirst + 1, '🔴 只多上传**1**次（能真红：整批重传 ⇒ 3 次）');
  assert.equal(h.gateway.calls.upload[uploadsAfterFirst], missingName, '这一次上传的就是缺的那张 ✓');
  assert.deepEqual(
    h.gateway.calls.upload.filter((name) => name === keptName),
    [keptName],
    '🔴 已经在的那张**不重复上传**（能真红：重传 ⇒ 出现两次）',
  );

  // ② 结果仍是 2 个附件：已存在那个 token **原样保留**，新补的那个是**新 token**
  const tokensAfter = attachmentTokens(documentCell(h));
  assert.equal(tokensAfter.length, 2, '补完仍是 2 个附件 ✓');
  assert.equal(tokensAfter[0], kept.file_token, '已存在那张的 token **原样保留**（没被冲掉、没被重传换掉）✓');
  assert.notEqual(tokensAfter[1], kept.file_token, '补进来的是另一个 token ✓');
  assert.deepEqual(
    attachmentNames(documentCell(h)).slice().sort(),
    [keptName, missingName].sort(),
    '两张采购单都在、文件名对得上 ✓',
  );

  // ③ 主表 / 明细一行都不新增（仍是同一张主表、同 2 条明细）
  assert.equal(batchRows(h).length, 1, '仍是同一张主表 ✓');
  assert.equal(detailRows(h).length, 2, '明细仍是 2 条、不重复 ✓');
});
