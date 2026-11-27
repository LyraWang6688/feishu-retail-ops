'use strict';
const { assertSubmitToast } = require('./support/submitToastAssert');
/**
 * ⭐⭐ task-64 —— **退货链路：「一单多货品」＋「生成退货单按供应商分组」**的验收标准。
 *
 * ── 她的口径（逐字，**唯一权威**；别自己解释 ✗）────────────────────────────────
 *   · 2026-10-16 15:12（问"退货的多货品 + 供应商拆分为要不要做"）：
 *     「**退货的多货品 + 供应商拆分要做**」✓
 *   · 2026-10-16 14:32：⭐ 旧口径「同一批次号下按供应商分组」；
 *   · 2026-11-27：扫码退货改为**按供应商拆独立批次/单号**（本文件 AC-RS1/1b 钉新口径；
 *     直接调 service 的旧用例仍保留单批次 fallback 覆盖）
 *     （**不是** ⓑ「每个供应商各开一个新批次号」✗）
 *   ⇒ 组的那一半**复用** `services/supplierSplitService.js`（纯函数 ✓）＋
 *     `config/supplierSplit.js`（`batchNoPolicy: 'same_batch_no'` ✓）—— **不另造第二套** ✗。
 *
 * ── 本卡要做的四件事 ─────────────────────────────────────────────────────────
 *   ① **退货也支持一单多货**（复用补货那套：`multiItemOrderService` 的 `chains.return`）
 *      —— 先只读核清它**到底有没有真正接线**（结论在下面 AC-RS1 的注释里 ✓）；
 *   ② **退货按供应商拆独立批次**（2026-11-27 起）；每条退货明细的**供应商**从
 *      「**货品信息.供应商**」那条**既有关联列**由**代码**读出来（与单货品那条路同一个字段 ✓）——
 *      🔴 **不发明列、不写表** ✗；
 *   ③ **单货品退货 ⇒ 与今天逐字一致**（硬红线：本次提交给写入口的载荷 / 回给页面的话 /
 *      写出去的明细 / 出的图 / 本地计划文件，逐字钉住）；
 *   ④ **每组一张图 ⇒ 幂等**（发之前先判"这组已出过"；重放 ⇒ 图 +0 · 群消息 +0 · 附件 +0；
 *      探针：把「单据」里那张图拿掉 ⇒ **必须重出**）。
 *
 * ── 先写「按我们的链路应该实现的效果」（= 验收标准）→ 再跑 → 逐条对照（她定的流程）──
 *   AC-RS1 一单退货 **2 个货品（不同供应商）** ⇒ 出单**按供应商分成 2 组**（每组只含该供应商的行）✓
 *   AC-RS2 **单货品退货 ⇒ 与今天逐字一致**（载荷 `deepEqual` ＋ 渲染/主表/单据各 1 ＋ 明细幂等键逐字）✓
 *   AC-RS3 ⭐ **混供应商不再落到「未标注供应商」**（**能真红**：退回"只认批次级供应商"的旧写法 ⇒ 红）✓
 *   AC-RS4 **幂等**：同一组重复 ⇒ 图 +0 · 群消息 +0 · 附件 +0（探针：把单据里那张图拿掉 ⇒ 必须重出）✓
 *   AC-RS5 **库存**：多货品退货 ⇒ 扣库存**逐条正确**（与单货品同口径 ✓ 不漏不加倍 ✓）
 *   AC-RS6 既有判据**一条不删/skip/放宽** ＋ 🔴 冻结件 `services/scanWriteService.js` **逐字节没动** ✓
 *
 * ── ⭐ 只读核查结论：退货这条链现在**到底有没有真正接线**（写在这里，别再来回核 ✗）──────
 *   | 环节 | 现状（改动前） |
 *   | --- | --- |
 *   | 路由把 N>1 交给引擎 | ✅ **已接线**：`routes/scanPage/index.js` 的退货分支 `groups.length > 1` ⇒ `submitMultiItemOrder({chain:'return'})` |
 *   | 引擎配置 | ✅ `config/multiItemOrder.js` 的 `chains.return` 在（`writer: 'purchaseReturn'`） |
 *   | 写入件挂上 | ✅ `services/scanWriteService.js` 的 `multiItemWriters().purchaseReturn` 指向 `purchaseReturnService.submit` |
 *   | 🔴 **写入件本身** | ❌ **没接线**：`purchaseReturnService` 只认**批次级** `draft.product_record_id` / `draft.supplier_record_id`；
 *     引擎的多货品载荷里这两个**都是空串**（`planSubmission` 在 `single === false` 时留空）⇒
 *     ① 实时库存按空货品查 ⇒ 每行 `available = 0` ⇒ **`skipped: 'no_stock'`、一个字都不写**（而引擎照样把草稿标成 submitted ⇒ **她看到成功页、账上啥也没有** ✗）；
 *     ② 就算写进去，每行带的是**批次级**供应商（空）⇒ 整单落进「**未标注供应商**」那一张 ✗（**错账级后果**）。 |
 *   ⇒ 本卡把它接上：**逐行**货品 + **逐行**供应商（供应商由代码从「货品信息.供应商」读 ✓）。
 *
 * ── 判据为什么这样钉（"去掉哪一句就该红"见文件末 MUTATION 注释）─────────────────
 *   · AC-RS1 / AC-RS2 / AC-RS4 用**真链路**（真路由 → 真引擎 → 真写入件 →
 *     真 `PurchaseWebhookService.deliverSupplierImages` → 假出图 / 假飞书 / 假网关）；
 *   · 出图那一步的"分了几组、每组哪些行"从**渲染器的入参**看（`images.render` 的 `items`）——
 *     那就是"出单按供应商分组"的物理含义 ✓；
 *   · 库存那一段用真 `InventoryService`（扣的是真「实时库存」那几条记录）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

// `services/purchaseWebhookService` 在 require 阶段就要凭证（本文件**零真表调用**，凭证是哑值）。
process.env.LARK_AGENT_APP_ID = process.env.LARK_AGENT_APP_ID || 'cli_return_multi';
process.env.LARK_AGENT_APP_SECRET = process.env.LARK_AGENT_APP_SECRET || 'return_multi_secret';

const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { normalizeLinkFields } = require('./support/linkReadShape');
const { SCAN_PAGE } = require('../src/config/scanPage');
const { SCAN_WRITE } = require('../src/config/scanWrite');
const { MULTI_ITEM_ORDER } = require('../src/config/multiItemOrder');
const { SUPPLIER_SPLIT } = require('../src/config/supplierSplit');
const { createScanWriteService } = require('../src/services/scanWriteService');
// ⭐ 单货品那条退货路是**异步**的（她 2026-10-16：「补货、退货……都是异步的」）⇒ 回读前先等后台那一跑 ✓
const { waitForPendingPurchaseBackgrounds } = require('../src/services/purchaseWriteBackgroundService');
const { createPurchaseReturnService } = require('../src/services/purchaseReturnService');
const { PurchaseOrderBatchService, attachmentNames } = require('../src/services/purchaseOrderBatchService');
const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { InventoryService } = require('../src/services/inventoryService');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { createScanSessionService } = require('../src/services/scanSessionService');
const { createMultiItemOrderService } = require('../src/services/multiItemOrderService');
const { createScanPageRouter } = require('../src/routes/scanPage');
const { documentFileNameOf } = require('../src/services/supplierSplitService');

const SERVER_SRC = path.join(__dirname, '..', 'src');

/**
 * 🔴 冻结件基线指纹（与 `test/scanWriteServiceFrozen.test.js` / `test/supplierSplitAtGeneration.test.js`
 * 的常量**同一个值** ✓）—— AC-RS6 用它自证"本卡一个字都没碰那个文件"。
 * ⚠️ **2026-10-16 成对迁移**（task-62「货 / 钱分离」阶段二 · 业务负责人明确「允许改冻结文件」，
 *    **一次性、只为本卡**）：改前逐字 `199551e1…35ca`（1699 行）⇒ 改后逐字 `49772bda…2c12`（1770 行）。
 *    本卡（退货一单多货）自己在那份文件里**仍然一个字都没加** ✗ —— 判据没放宽，只是基线随授权的那一刀一起搬 ✓。
 *    ⚠️ 许可**不能复用**：下一次改它必须重新拿裁决（见冻结哨兵的「解冻台账」✓）。
 */
// ⭐⭐ 2026-10-16 成对迁移（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：sha `b82af5887b33ebe53d41eca20dab36abdde7c2b7bf08e4a8fd8ba3486d23f734`（1770 行 · 冻结件 `deferFunds` 那一版）
//   改后逐字：sha `b82af5887b33ebe53d41eca20dab36abdde7c2b7bf08e4a8fd8ba3486d23f734`（1770 行 · 货那一跑**照扣库存**）
//   依据 = 业务负责人 2026-10-16 22:0x 逐字：「**货就是货，资金就是资金，它俩是独立的呀**：…**如果是现货，就是要扣库存**；
//          如果是预订，就不扣库存，等二次交付的时候再扣库存」＋「**啥叫钱没入账就不许出库存？不用呀。**」
//          ⇒ 冻结件只动批准的 5 行（`deliverStockLines` 形参/转发 ＋ `:1318` 三元 ＋ 两处注释）✓
//          ＋ `salesDeliveryService._deliver` 的 `allowUnposted`（**只给货那一跑开门** ✗）✓
  // ⭐ 2026-10-18 · task-2「扫码会话按页面/设备隔离」（Lead **明确授权**：只允许在冻结件里加
  //   `sessionKey` 可选参数透传 / 小改调用）：
  //   改前逐字：sha `b82af5887b33ebe53d41eca20dab36abdde7c2b7bf08e4a8fd8ba3486d23f734`（1736 行）
  //   改后逐字：sha `0f52d5b1ec50bc3fcabae796ee34c3f7778dbbe4a8cd5be1545b52d72fdffaba`（1731 行）
  //   依据：`submitReplenish` / `submitPurchaseReturn` 各加一个**可选** `sessionKey`（不传 ⇒ 会话键 = openId
  //   ⇒ 与改前逐字同一个键、同一套行为）；写库逻辑 / 事件名 / 返回形状一个字节都没动 ✓
  // ⭐ 2026-10-29 · 扫码页「一单多货」补货假成功 P0（业务负责人授权解冻 · 见冻结哨兵台账）：
  //   改前逐字：sha `561d1fe9ea37822a6046268fcb1a6ae2609bfe0c4979f67414d2c50e04be3e12`（1728 行）
  //   改后逐字：sha `8025590dd79e10deaafe2d33506d0863004e3dd3b9d3320352a985b44612e69a`（1636 行）
  //   依据 = 业务负责人 2026-10-29「授权解冻 scanWriteService.js，修扫码页一单多货假成功」：
  //     `multiItemWriters().purchase` 把扁平 payload 先建/更新本地 task 再 publish（本卡未动本文件的其他部分）。
const FROZEN_SCAN_WRITE_SHA256 = '8025590dd79e10deaafe2d33506d0863004e3dd3b9d3320352a985b44612e69a';

const NUMBER_A = 'KA|黑色|男';
const NUMBER_B = 'KB|黑色|男';
const OPEN_ID = 'ou_return_multi';
const SESSION_SECRET = 'return-multi-test-session-secret';

/** 两个货品、**两个不同供应商**（AC-RS1/RS3 的输入）。 */
const PRODUCT_A = {
  record_id: 'prod_A',
  fields: { 编号: NUMBER_A, 货号: 'KA', 颜色: { text: '黑色', record_ids: ['c1'] }, 类别: '男', 单价: 399, 供应商: [{ record_ids: ['sup_a'] }] },
};
const PRODUCT_B = {
  record_id: 'prod_B',
  fields: { 编号: NUMBER_B, 货号: 'KB', 颜色: { text: '黑色', record_ids: ['c1'] }, 类别: '男', 单价: 359, 供应商: [{ record_ids: ['sup_b'] }] },
};
const SIZE_RECORDS = [40, 41, 42].map((size) => ({ record_id: `size_${size}`, fields: { 尺码: size } }));
const liveUnit = (id, product, size, state = '门盒') => ({
  record_id: id,
  fields: { 编号: [product], 尺码: [`size_${size}`], 所属状态: state },
});
const seedTables = (overrides = {}) => ({
  product: [PRODUCT_A, PRODUCT_B],
  sizeManagement: SIZE_RECORDS,
  supplier: [
    { record_id: 'sup_a', fields: { 供应商名称: '甲供应商' } },
    { record_id: 'sup_b', fields: { 供应商名称: '乙供应商' } },
  ],
  behavior: [
    { record_id: 'bh_return_purchase', fields: { 行为名称: '退货', 行为编码: 'PURCHASE_RETURN' } },
    {
      record_id: 'bh_return',
      fields: {
        行为名称: '采购减少', 行为编码: 'STOCK_PURCHASE_DECREASE', 库存方向: '减少', 是否启用: true,
      },
    },
  ],
  // 41 码：A 两双（门盒 + 样品）、B 一双；42 码：A 一双（AC-RS5 用它验"逐条只扣自己那一行"）
  liveInventory: [
    liveUnit('live_a41_box', 'prod_A', 41, '门盒'),
    liveUnit('live_a41_sample', 'prod_A', 41, '样品'),
    liveUnit('live_b41_box', 'prod_B', 41, '门盒'),
    liveUnit('live_a42_box', 'prod_A', 42, '门盒'),
  ],
  inventoryLedger: [],
  purchaseOrderBatch: [],
  purchaseRequest: [],
  ...overrides,
});

/**
 * 内存假网关：语义键 → 物理列名走真 schema（**写错语义键当场抛** ⇒ "发明列"会被立刻抓住 ✓）；
 * 附件列像飞书那样回填文件名（"这一组已经出过了"的物理基础 ✓）。
 */
const createFakeGateway = (tables = seedTables()) => {
  const calls = { create: [], update: [], upload: [], listAll: [] };
  let sequence = 0;
  const tokenNames = new Map();
  const physical = (tableKey, semanticValues) => {
    const table = V1_BITABLE_SCHEMA.tables[tableKey];
    const out = {};
    for (const [key, value] of Object.entries(semanticValues || {})) {
      const name = table.fields[key];
      if (!name) throw new Error(`“${table.tableName}”未配置语义字段: ${key}`);
      if (value !== undefined) out[name] = value;
    }
    const docField = table.fields.document;
    if (docField && Array.isArray(out[docField])) {
      out[docField] = out[docField].map((item) => ({
        file_token: item?.file_token, name: item?.name || tokenNames.get(item?.file_token) || '',
      }));
    }
    return out;
  };
  const gateway = {
    calls,
    _tables: tables,
    table: (key) => V1_BITABLE_SCHEMA.tables[key],
    listAll: async (key) => {
      calls.listAll.push(key);
      return (tables[key] || []).map((row) => ({ record_id: row.record_id, fields: normalizeLinkFields(row.fields) }));
    },
    get: async (key, id) => {
      const row = (tables[key] || []).find((record) => record.record_id === id);
      return row ? { record_id: row.record_id, fields: normalizeLinkFields(row.fields) } : null;
    },
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
      calls.create.push({ table: key, values: { ...values }, record_id: record.record_id });
      return { recordId: record.record_id, record };
    },
    update: async (key, id, values) => {
      const record = (tables[key] || []).find((item) => item.record_id === id);
      if (!record) throw new Error(`记录不存在: ${key}/${id}`);
      const fields = physical(key, values);
      Object.assign(record.fields, fields);
      calls.update.push({ table: key, record_id: id, fields });
      return record;
    },
    // 扣库存会把「实时库存」里那几条记录删掉（既有库存引擎的语义）；别的表不许删。
    delete: async (key, id) => {
      if (key !== 'liveInventory') throw new Error(`测试网关：不许删 ${key}`);
      const before = (tables[key] || []).length;
      tables[key] = (tables[key] || []).filter((record) => record.record_id !== id);
      return { deleted: before !== (tables[key]).length };
    },
    uploadAttachment: async (filePath) => {
      calls.upload.push(path.basename(String(filePath || '')));
      const token = `file_token_${calls.upload.length}`;
      tokenNames.set(token, path.basename(String(filePath || '')));
      return token;
    },
  };
  return gateway;
};

const tempDir = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `return-multi-${label}-`));
const rmDir = (dir) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ } };

/**
 * 一套"真的在跑"的退货链路：真写服务 + 真会话 + 真库存引擎 + 真批次服务 +
 * **真 `PurchaseWebhookService.deliverSupplierImages`**（出图 / 发群 / 回填附件那一整条），
 * 只有出图（sharp）、飞书 IM、批次号源是替身。**零真表调用**。
 */
const createHarness = (options = {}) => {
  const gateway = createFakeGateway(options.tables || seedTables());
  const sessionDir = tempDir('session');
  const inventoryDir = tempDir('inventory');
  const returnDir = tempDir('return-task');
  const webhookDir = tempDir('webhook');
  const sessions = createScanSessionService({ config: SCAN_WRITE, dir: sessionDir });
  const inventory = new InventoryService({
    gateway, store: new JsonTaskStore({ dir: inventoryDir, idField: 'operation_id' }),
  });
  const orderBatches = new PurchaseOrderBatchService({ gateway });
  const renders = [];
  const messages = [];
  let batchNoCalls = 0;
  const batchNoGenerator = options.batchNoGenerator || {
    runExclusive: async (work) => work(),
    next: async () => { batchNoCalls += 1; return { batchNo: `CGD-20261016-000${batchNoCalls}` }; },
  };
  const webhooks = new PurchaseWebhookService({
    gateway,
    store: new JsonTaskStore({ dir: webhookDir, idField: 'task_id' }),
    references: {
      resolveProduct: async () => null,
      resolveSupplier: async () => null,
      resolveBehavior: async () => ({ recordId: 'bh_any', record: { record_id: 'bh_any', fields: {} } }),
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
    // 假出图：**记下每一次渲染的入参**（哪一家、哪些行）—— 分组就从这里看 ✓
    images: {
      render: async (input) => {
        renders.push(input);
        return Buffer.from(`png:${input.supplierName || ''}`);
      },
    },
    orderBatches,
    batchLocator: { rememberGroupMessage: async () => ({ ok: true }) },
    batchNoGenerator,
    sandboxChatId: 'oc_return_multi_group',
  });
  const purchaseReturn = createPurchaseReturnService({
    gateway,
    config: SCAN_WRITE.purchaseReturn,
    store: new JsonTaskStore({ dir: returnDir, idField: 'task_id' }),
    inventory,
    orderBatches,
    webhooks,
    batchNoGenerator,
  });
  const write = createScanWriteService({
    gateway,
    sessions,
    purchaseReturnService: purchaseReturn,
    // 本文件不碰补货 / 销售那两条链路：给一对不会落盘的替身，免得误写工作区。
    purchase: {},
    purchaseStore: new JsonTaskStore({ dir: tempDir('replenish'), idField: 'task_id' }),
  });
  const engine = createMultiItemOrderService({
    sessions: write.sessions,
    config: MULTI_ITEM_ORDER,
    writers: write.multiItemWriters(),
  });
  // 出图那一步的**入参留痕**（只包一层，不改真件一个字节 ✓）—— AC-RS2 用它 deepEqual 载荷。
  const deliveries = [];
  const realDeliver = webhooks.deliverSupplierImages.bind(webhooks);
  webhooks.deliverSupplierImages = async (taskId, task, posting, options) => {
    const result = await realDeliver(taskId, task, posting, options);
    deliveries.push({
      taskId, posting, options, draft: task?.draft, requestIds: task?.request_ids, result,
    });
    return result;
  };
  return {
    gateway,
    sessions,
    inventory,
    orderBatches,
    webhooks,
    purchaseReturn,
    write,
    engine,
    renders,
    messages,
    deliveries,
    batchNoCalls: () => batchNoCalls,
    tables: gateway._tables,
    cleanup: () => {
      rmDir(sessionDir); rmDir(inventoryDir); rmDir(returnDir); rmDir(webhookDir);
    },
  };
};

const entriesOf = (harness, tableKey) => harness.tables[tableKey] || [];
const ledgerTotal = (harness) => entriesOf(harness, 'inventoryLedger')
  .reduce((sum, record) => sum + Number(record.fields['变动数量'] || 0), 0);
const liveIds = (harness) => entriesOf(harness, 'liveInventory').map((record) => record.record_id).sort();
const documentNamesOf = (harness) => entriesOf(harness, 'purchaseOrderBatch')
  .flatMap((batch) => attachmentNames(batch.fields?.['我方单据']));
/** 这一轮退货的幂等键（会话还没建时 = 第 1 轮那把，纯函数算出来 —— 与页面同一条口径）。 */
const returnKey = async (harness, openId = OPEN_ID) => harness.write.sessions
  .submitKeyFor(openId, await harness.sessions.get(openId), 'purchase_return');

// ── 路由夹具（AC-RS1/RS2 的"真链路"：路由 → 引擎 → 写入件 → 出图/发群/附件）─────────
const sessionCookie = (openId = OPEN_ID) => {
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
  server.keepAliveTimeout = 1;
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await run(base); } finally { await new Promise((resolve) => server.close(resolve)); }
};
const view = (overrides = {}) => ({
  found: true,
  number: NUMBER_A,
  item_no: 'KA',
  color: '黑色',
  category_name: '休闲鞋',
  category_code: '男',
  price_text: '¥399',
  total: 0,
  columns: [{ key: '门盒', label: '门盒' }],
  rows: [
    { size_text: '40', cells: [{ count: 0 }], total: 0, missing: true },
    { size_text: '41', cells: [{ count: 2 }], total: 2, missing: false },
    { size_text: '42', cells: [{ count: 1 }], total: 1, missing: false },
  ],
  missing_count: 1,
  sizes_degraded: false,
  notes: [],
  updated_at_text: '2026-10-16 15:12',
  product_record_id: 'prod_A',
  ...overrides,
});
const formApp = (harness, lookup = async () => view()) => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(SCAN_PAGE.route.recordBasePath, createScanPageRouter({
    service: { lookup },
    gateway: harness.gateway,
    writeService: harness.write,
  }));
  return app;
};
/** 渲染层那一份 hidden 载荷的**逐字形状**（设计 §4.3；`supplier_record_id` 由扫码页给 —— 见 AC-RS3）。 */
const multiItemsJson = (groups) => JSON.stringify(groups.map((group) => ({
  product_record_id: String(group.product_record_id || ''),
  number: String(group.number || ''),
  item_no: String(group.item_no || ''),
  color: String(group.color || ''),
  supplier_record_id: String(group.supplier_record_id || ''),
  ...(Number.isInteger(group.amount_cents) ? { amount_cents: group.amount_cents } : {}),
  entries: (group.entries || []).map((entry) => ({ size: String(entry.size), quantity: Number(entry.quantity) })),
})));
const postReturn = async (base, {
  number = NUMBER_A, openId = OPEN_ID, form = {}, multiItems = null,
} = {}) => {
  const body = new URLSearchParams({
    action: SCAN_WRITE.actions.purchaseReturn,
    submit_key: await form.submitKey,
    purchase_amount: '399',
    ...form,
  });
  if (multiItems) body.set(MULTI_ITEM_ORDER.field, multiItemsJson(multiItems));
  return fetch(`${base}/r/${encodeURIComponent(number)}?from=purchase_return`, {
    method: 'POST',
    redirect: 'manual',  // ⭐ 2026-10-29：提交成功 = 303 回工作台（不许被 fetch 自动跟随成 404）
    headers: { cookie: sessionCookie(openId), 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
};

const groupNames = (harness) => harness.renders.map((render) => render.supplierName).sort();
const documentSuffix = SCAN_WRITE.purchaseReturn.fileNameSuffix;

// ═══════════════════════════════════════════════════════════════════════════
// AC-RS1 一单退货 2 个货品（不同供应商）⇒ 出单按供应商分成 2 组
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RS1 ⭐⭐ 一单退货 2 个货品（不同供应商）⇒ **2 个独立退货批次/单号**（每批只含该供应商的行）', async () => {
  login();
  const h = createHarness();
  try {
    const submitKey = await returnKey(h);
    await withServer(formApp(h), async (base) => {
      const response = await postReturn(base, {
        form: { submitKey, return_qty_41: '1' },
        multiItems: [
          // ⚠️ 这是**扫码页真实给出的**形状：`supplier_record_id` 是空的（见 AC-RS3 的只读核查）
          {
            product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 39900, entries: [],
          },
          {
            product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_b', amount_cents: 10000, entries: [{ size: '41', quantity: '1' }],
          },
        ],
      });
      assertSubmitToast(response, '一单多货的退货照样先回统一回执 ✓');
      // ⭐ 2026-10-18（一单多货改异步）：先回成功页 ⇒ **写库在后台** ⇒ 端状态断言前先等它跑完 ✓
      //   🔴 判据没放宽：批次/明细/分组仍是逐字比，只是先等后台（与销售那条同一手法 ✓）
      await waitForPendingPurchaseBackgrounds();
    });

    // ① 2026-11-27：按供应商拆 ⇒ 两个独立批次号 / 两行主表
    const batches = entriesOf(h, 'purchaseOrderBatch');
    assert.equal(batches.length, 2, '2 个供应商 ⇒ 2 行主表');
    assert.equal(h.batchNoCalls(), 2, '号源取两次（每供应商一个号）');
    assert.equal(SCAN_WRITE.purchaseReturn.behaviorCode, 'PURCHASE_RETURN');
    for (const batch of batches) {
      assert.deepEqual(batch.fields['发生行为'], ['bh_return_purchase'],
        '每行退货批次都要有「采购行为」= 采购退货那一档');
    }
    const batchNos = new Set(batches.map((batch) => batch.fields['报货批次号']));
    assert.equal(batchNos.size, 2, '两个供应商不共用批次号');
    assert.deepEqual(
      batches.map((batch) => Number(batch.fields['货单金额'])).sort((a, b) => a - b),
      [100, 399],
      '每个批次只写本供应商 record ID 金额（399 / 100）',
    );

    // ② 2026-11-18：退货不写采购明细；批次保留，库存流水关联退货批次。
    assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '退货不写采购明细');
    const ledgers = entriesOf(h, 'inventoryLedger');
    assert.ok(ledgers.length > 0, '库存流水照常写');
    const batchRecordIds = new Set(batches.map((batch) => batch.record_id));
    for (const record of ledgers) {
      assert.equal(record.fields['关联采购'].length, 1, '库存流水只关联自己那一批');
      assert.ok(batchRecordIds.has(record.fields['关联采购'][0]), '关联的是本批批次行');
    }

    // ③ ⭐ 出单**分成 2 组**：每组只含该供应商的行
    assert.equal(h.renders.length, 2, '🔴 2 个供应商 ⇒ **2 张退货单**（1 张 = 混在一起 ⇒ 红）');
    const bySupplier = new Map(h.renders.map((render) => [render.supplierName, render]));
    assert.deepEqual([...bySupplier.keys()].sort(), ['乙供应商', '甲供应商'], '两家各一张、不重不漏');
    assert.deepEqual(
      bySupplier.get('甲供应商').items.map((item) => item.item_no), ['KA'],
      '每一组**只含该供应商的行**（混进去 ⇒ 红）',
    );
    assert.deepEqual(bySupplier.get('乙供应商').items.map((item) => item.item_no), ['KB']);
    for (const render of h.renders) {
      assert.ok(batchNos.has(render.batchNo), '每张图只属于自己那一批');
      assert.equal(render.items.length, 1);
      assert.equal(Number(render.items[0].quantity), 1, '图上写的是**实退数** ✓');
    }

    // ④ 「单据」两张（每组一张）、群消息 4 条（2 组 × 图 + 文字）
    assert.deepEqual(
      documentNamesOf(h).sort(),
      ['甲供应商', '乙供应商'].map((name) => documentFileNameOf(name, documentSuffix)).sort(),
      '「单据」里每组一张、文件名 = `documentFileNameOf`（唯一一处拼法 ✓）',
    );
    assert.equal(h.messages.length, 4, '2 组 ×（图 + @文字）');
    assert.equal(SCAN_WRITE.purchaseReturn.imageTitle, '邯美皮鞋退货单');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RS2 单货品退货 ⇒ 与今天逐字一致（硬红线）
// ═══════════════════════════════════════════════════════════════════════════


test('AC-RS1b ⭐ 未标注供应商单独一个退货批次（不塞进有供应商的批次）', async () => {
  login();
  const h = createHarness();
  try {
    const submitKey = await returnKey(h);
    await withServer(formApp(h), async (base) => {
      await postReturn(base, {
        form: { submitKey, return_qty_41: '1' },
        multiItems: [
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 39900, entries: [] },
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: '', amount_cents: 10000, entries: [{ size: '41', quantity: '1' }] },
        ],
      });
      await waitForPendingPurchaseBackgrounds();
    });
    const batches = entriesOf(h, 'purchaseOrderBatch');
    assert.equal(batches.length, 2, '有供应商 + 未标注 ⇒ 2 个独立批次');
    const supplierValues = batches.map((batch) => batch.fields['供应商']).filter(Boolean).flat();
    assert.deepEqual(supplierValues, ['sup_a'], '未标注那一批不写供应商，单独成批');
    assert.equal(h.renders.length, 2, '两批各自出图');
  } finally { h.cleanup(); }
});


test('AC-RS1c ⭐ 当前页最后一双直接提交：60 + 已加 120 = 180，图片逐件 60 / 120', async () => {
  login();
  const h = createHarness();
  try {
    const submitKey = await returnKey(h);
    await withServer(formApp(h), async (base) => {
      await postReturn(base, {
        form: { submitKey, return_qty_41: '1', purchase_amount: '60' },
        multiItems: [
          // 当前页（最后一双）不点加货；金额只来自 purchase_amount=60
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', entries: [] },
          // 之前加货时存的金额
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 12000, entries: [{ size: '41', quantity: '1' }] },
        ],
      });
      await waitForPendingPurchaseBackgrounds();
    });
    const batches = entriesOf(h, 'purchaseOrderBatch');
    assert.equal(batches.length, 1, '同一供应商 ⇒ 一个批次');
    assert.equal(Number(batches[0].fields['货单金额']), 180, '整批 = 当前页 60 + 已加 120');
    assert.equal(h.renders.length, 1);
    assert.deepEqual(
      h.renders[0].items.map((item) => [item.item_no, item.amount_cents]),
      [['KA', 6000], ['KB', 12000]],
      '图片逐件取自己的金额，不用整批金额兜底',
    );
  } finally { h.cleanup(); }
});

test('AC-RS2 🔴 单货品退货 ⇒ 与今天**逐字一致**（载荷 `deepEqual` ＋ 渲染/主表/单据各 1 ＋ 明细幂等键逐字）', async () => {
  const h = createHarness();
  try {
    // 这一份 draft **逐字**就是 `scanWriteService.submitPurchaseReturn` 今天构造出来的那个形状
    // （单货品的唯一入口 ✓ —— N=1 **不走引擎**：路由只在 `groups.length > 1` 时才交给引擎）。
    const taskId = 'scan_return_legacy_1';
    const draft = {
      product_record_id: 'prod_A',
      product_number: NUMBER_A,
      item_no: 'KA',
      color: '黑色',
      supplier_record_id: 'sup_a',
      behavior_record_id: 'bh_return_purchase',
      operator_open_id: OPEN_ID,
      items: [{
        size: 41,
        quantity: 1,
        product_record_id: 'prod_A',
        product_number: NUMBER_A,
        item_no: 'KA',
        color: '黑色',
        supplier_record_id: 'sup_a',
      }],
      order_amount: '399',
    };
    const result = await h.purchaseReturn.submit(taskId, draft);
    assert.equal(result.ok === undefined || result.ok === true, true, JSON.stringify(result));
    assert.equal(result.taken_count, 1);
    assert.equal(result.shortfall, 0);

    // ① 回给调用方的那一份**逐字**不变（她的 `shortfalls` 形状；改成带 product 会破坏既有判据 ✗）
    assert.deepEqual(result.shortfalls, [{ size: 41, declared: 1, available: 2, taken: 1, shortfall: 0 }],
      '🔴 单货品 ⇒ `shortfalls` 还是那 5 个键（能真红：往里塞 product_record_id ⇒ 红 ✓）');

    // ② 本地计划文件也**逐字**不变（多出键 = 冻结形状变了，重放/排查都会跟着变 ✗）
    const task = await h.purchaseReturn.store.get(taskId);
    assert.deepEqual(Object.keys(task.plan).sort(), ['batch_no', 'items', 'version'],
      '🔴 单货品 ⇒ 计划里**不多**任何键（`behavior_record_id` / 逐行身份都不许有 ✓）');
    assert.deepEqual(task.plan.items, result.shortfalls, '计划里那几行就是回给调用方的那一份 ✓');

    // ③ 2026-11-18：退货不写采购明细（幂等仍由任务/库存操作键保证）。
    assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '退货不写采购明细');

    // ④ 主表 1 行 / 单据 1 张 / 图 1 张 / 群消息 2 条 / 号源 1 次
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1);
    assert.equal(h.batchNoCalls(), 1);
    assert.equal(h.renders.length, 1);
    assert.equal(h.renders[0].supplierName, '甲供应商');
    assert.equal(h.renders[0].title, SCAN_WRITE.purchaseReturn.imageTitle, '标题来自配置 ✓');
    assert.deepEqual(documentNamesOf(h), [documentFileNameOf('甲供应商', documentSuffix)]);
    assert.equal(h.messages.length, 2, '图 + @文字（与今天逐字一致 ✓）');
  } finally { h.cleanup(); }
});

test('AC-RS2b 🔴 单货品退货（**真链路**：扫码页 POST）⇒ 递给出图那一步的载荷 deepEqual（新增金额键）', async () => {
  login();
  const h = createHarness();
  try {
    const submitKey = await returnKey(h);
    await withServer(formApp(h), async (base) => {
      const response = await postReturn(base, {
        form: { submitKey, return_qty_41: '1' },
        // 没有 hidden 多货品载荷 ⇒ 走**今天那条**老路径（真正的"单货品退货"）
      });
      assertSubmitToast(response, '单货品退货 ⇒ 统一回执');
      // ⚠️ 单货品那条路是**异步**的（她 2026-10-16：「补货、退货……都是异步的」）⇒ 等后台那一跑 ✓
      await waitForPendingPurchaseBackgrounds();
      assert.equal(h.renders.length, 1, '单货品 ⇒ 只出 1 张 ✓');
      assert.equal(h.messages.length, 2, '图 + @文字 ✓');
      assert.deepEqual(documentNamesOf(h), [documentFileNameOf('甲供应商', documentSuffix)]);
      // 🔴 **递给写入口的那一份**（= 出图那一步拿到的 `draft`）逐字 deepEqual：
      //    既有判据（`scanPurchaseReturn.test.js` 的 AC-R10）就钉着 `items[].quantity` 与批次级供应商。
      const delivery = h.deliveries[0];
      assert.ok(delivery, '真出图链路的入参要留痕（本用例只包了一层记录 ✓）');
      assert.deepEqual(delivery.draft.items, [{
        product_record_id: 'prod_A',
        product_number: NUMBER_A,
        item_no: 'KA',
        color: '黑色',
        size: 41,
        quantity: 1,
        amount_cents: 39900,
        supplier_record_id: 'sup_a',
      }], '🔴 `drawItems` 新增 amount_cents（单货品取整单金额）；其余键逐字不变 ✓');
      assert.equal(delivery.draft.supplier_record_id, 'sup_a', '批次级供应商照旧在（既有判据钉着 ✓）');
    });
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RS3 ⭐ 混供应商不再落到「未标注供应商」
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RS3 🔴 直接调用 service 混供应商 ⇒ 拒绝（扫码路由已按供应商拆批）', async () => {
  const h = createHarness();
  try {
    const plan = h.engine.planSubmission({
      draft: {
        open_id: OPEN_ID,
        order_key: 'scan_return:x:1',
        order_amount: '399',
        items: [
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', entries: [{ size: 41, quantity: 1 }] },
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_b', entries: [{ size: 41, quantity: 1 }] },
        ],
      },
      chainConfig: MULTI_ITEM_ORDER.chains.return,
      submitKey: 'scan_return:x:1',
    });
    await assert.rejects(() => h.purchaseReturn.submit(plan.taskId, plan.payload),
      /只能包含一个供应商/, '旧“同批多供应商”分支已删：直接调用也必须按供应商拆开');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 0, '拒绝 ⇒ 零批次');
    assert.equal(h.renders.length, 0, '拒绝 ⇒ 零出图');
    assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '退货仍不写采购明细');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RS4 幂等：同一组重复 ⇒ 图 +0 / 群消息 +0 / 附件 +0
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RS4 🔴 幂等：同一组重复生成 ⇒ 图 +0 · 群消息 +0 · 附件 +0（重放读**已经落库的事实**）', async () => {
  const h = createHarness();
  try {
    const plan = h.engine.planSubmission({
      draft: {
        open_id: OPEN_ID,
        order_key: 'scan_return:x:rs4',
        order_amount: '399',
        items: [
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 19900, entries: [{ size: 41, quantity: 1 }] },
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 20000, entries: [{ size: 41, quantity: 1 }] },
        ],
      },
      chainConfig: MULTI_ITEM_ORDER.chains.return,
      submitKey: 'scan_return:x:rs4',
    });
    await h.purchaseReturn.submit(plan.taskId, plan.payload);
    const rendersAfter = h.renders.length;
    const messagesAfter = h.messages.length;
    const uploadsAfter = h.gateway.calls.upload.length;
    const documentsAfter = documentNamesOf(h).length;
    assert.deepEqual([rendersAfter, messagesAfter, uploadsAfter, documentsAfter], [1, 2, 1, 1],
      '一个批次一个供应商：1 张图 / 2 条群消息 / 1 个附件 / 1 张单据');
    const liveAfterFirst = liveIds(h);

    // 重放同一次提交（同一个 task ⇒ 同一份冻结计划；与 `supplierSplitAtGeneration.test.js` 的 AC-SS4 同形）
    await h.purchaseReturn.submit(plan.taskId, plan.payload);
    assert.equal(h.renders.length, rendersAfter, '🔴 重放**一张图都不许再出**（去掉"已经出过"那一步 ⇒ 红）');
    assert.equal(h.messages.length, messagesAfter, '🔴 群里也不许再发一遍 ✗');
    assert.equal(h.gateway.calls.upload.length, uploadsAfter, '附件也不用再传一次 ✓');
    assert.equal(documentNamesOf(h).length, documentsAfter, '「单据」里还是那 1 张、不重复 ✗');
    assert.deepEqual(liveIds(h), liveAfterFirst, '库存也不重复扣 ✓');
    assert.equal(entriesOf(h, 'purchaseOrderBatch').length, 1, '重放也不会多一行主表 ✓');
    assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '退货不写采购明细');
    assert.equal(h.batchNoCalls(), 1, '重放不取新号 ✓');
  } finally { h.cleanup(); }
});

test('AC-RS4b 探针：判据不是空跑 —— 把「单据」里那张图拿掉 ⇒ 这一组**就会再出一次**', async () => {
  const h = createHarness();
  try {
    const plan = h.engine.planSubmission({
      draft: {
        open_id: OPEN_ID,
        order_key: 'scan_return:x:rs4b',
        order_amount: '399',
        items: [
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 19900, entries: [{ size: 41, quantity: 1 }] },
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 20000, entries: [{ size: 41, quantity: 1 }] },
        ],
      },
      chainConfig: MULTI_ITEM_ORDER.chains.return,
      submitKey: 'scan_return:x:rs4b',
    });
    await h.purchaseReturn.submit(plan.taskId, plan.payload);
    assert.equal(h.renders.length, 1);
    const rendersBefore = h.renders.length;
    // 手动把"已经出过"的证据拿掉（= 其实那一张根本没出过）⇒ 必须重出，否则就是静默少发 ✗
    const batch = entriesOf(h, 'purchaseOrderBatch')[0];
    batch.fields['我方单据'] = [];
    await h.purchaseReturn.submit(plan.taskId, plan.payload);
    assert.equal(h.renders.length, rendersBefore + 1, '证据不在了 ⇒ 照旧要出（判据读的是**已经落库的事实** ✓）');
    assert.deepEqual(h.renders.slice(rendersBefore).map((render) => render.supplierName), ['甲供应商'],
      '只补这一组（单据没了 ⇒ 重出 ✓）');
    assert.equal(documentNamesOf(h).length, 1, '补回来之后单据还是 1 张（不重复 ✗）');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RS5 库存：多货品退货 ⇒ 扣库存逐条正确
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RS5 🔴 多货品退货 ⇒ 扣库存**逐条正确**（每个货品只扣自己那几行；不漏不加倍）', async () => {
  const h = createHarness();
  try {
    const plan = h.engine.planSubmission({
      draft: {
        open_id: OPEN_ID,
        order_key: 'scan_return:x:rs5',
        order_amount: '399',
        items: [
          // A：41 码退 2（库存恰好 2）、42 码退 1（库存 1）；B：41 码退 1（库存 1）
          // 2026-11-27：一个批次一个供应商 ⇒ 两个货品同属甲供应商。
          { product_record_id: 'prod_A', number: NUMBER_A, item_no: 'KA', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 20000, entries: [{ size: 41, quantity: 2 }, { size: 42, quantity: 1 }] },
          { product_record_id: 'prod_B', number: NUMBER_B, item_no: 'KB', color: '黑色', supplier_record_id: 'sup_a', amount_cents: 10000, entries: [{ size: 41, quantity: 1 }] },
        ],
      },
      chainConfig: MULTI_ITEM_ORDER.chains.return,
      submitKey: 'scan_return:x:rs5',
    });
    const result = await h.purchaseReturn.submit(plan.taskId, plan.payload);
    assert.equal(result.taken_count, 4, '2 + 1 + 1 = 4 双');
    assert.equal(result.shortfall, 0);
    // 逐条：每一行扣的都是**它自己那个货品那个尺码**的库存
    assert.deepEqual(liveIds(h), [], '两条 41 码全空 + A 的 42 码也空了 ⇒ 实时库存一条不剩');
    const ledger = entriesOf(h, 'inventoryLedger')
      .map((record) => {
        const raw = record.fields['编号'];
        const product = String(Array.isArray(raw) ? raw[0] : (raw || ''));
        return `${product}|${Number(record.fields['变动数量'])}`;
      }).sort();
    assert.deepEqual(ledger, ['prod_A|1', 'prod_A|2', 'prod_B|1'],
      '🔴 三条流水、逐行数量正确（漏一条 / 加倍 ⇒ 红）');
    assert.equal(ledgerTotal(h), 4);

    // 2026-11-18：退货不写采购明细；库存流水逐行正确即可。
    assert.equal(entriesOf(h, 'purchaseRequest').length, 0, '退货不写采购明细');
  } finally { h.cleanup(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// AC-RS6 既有判据一条不删/skip/放宽 ＋ 冻结件逐字节没动
// ═══════════════════════════════════════════════════════════════════════════

test('AC-RS6 🔴 冻结件 `services/scanWriteService.js` **逐字节没动**（本卡一个字都没碰它）', () => {
  const raw = fs.readFileSync(path.join(SERVER_SRC, 'services', 'scanWriteService.js'));
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), FROZEN_SCAN_WRITE_SHA256,
    '🔴 scanWriteService.js 的 sha256 必须与 main 一致（改一个字节 ⇒ 红 ✓）');
  // 退货这条链的"多货品"必须复用既有引擎（不是另写一套）
  assert.equal(MULTI_ITEM_ORDER.chains.return.writer, 'purchaseReturn');
  assert.equal(SUPPLIER_SPLIT.batchNoPolicy, 'same_batch_no', '供应商分组配置仍供采购申请使用（退货扫码已按供应商拆批，不复用该批次策略）');
});

test('AC-RS6b 🔴 退货 service 仍然**不直连写库**，分组也**只用那一处**（不另造第二套口径）', () => {
  const service = fs.readFileSync(path.join(SERVER_SRC, 'services', 'purchaseReturnService.js'), 'utf8');
  assert.equal(/gateway\.(update|delete)\s*\(/.test(service), false,
    '退货 service 自己不 update/delete 业务表 ✓');
  for (const pattern of [
    /applyPurchaseReturn/, /createForReturnBatch/, /deliverSupplierImages/,
  ]) {
    assert.match(service, pattern, `复用点必须在：${pattern}`);
  }
  // 分组那件事**只在** `deliverSupplierImages` → `supplierSplitService` 一处：
  // 退货 service 的**代码**里**不许**出现"没标注供应商"这个桶 / 自己分桶（出现 = 第二套口径 ✗）
  const code = service
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(code.includes('未标注供应商'), false, '「未标注供应商」这个桶只在出图那一处 ✓');
  const splitService = fs.readFileSync(path.join(SERVER_SRC, 'services', 'supplierSplitService.js'), 'utf8');
  assert.match(splitService, /const groupItemsBySupplier = /, '分桶口径的唯一一处还在 ✓');
});
