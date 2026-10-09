/**
 * ⭐⭐ 采购「信息填写」入口退场（2026-10-09）的**验收标准 / 守门用例**。
 *
 * 业务事实（只读核实，不推翻）：
 *   · 业务负责人把「**信息填写**」表（语义键 `purchaseReport`，`tblo0ffzFt7vyQw2`）
 *     **整个从 Base 删掉了** ⇒ `TableIdNotFound (1254041)` ⇒ 部署闸门
 *     `deploy_build.sh`（`v1:schema-check:all`）持续红；
 *   · 她 2026-10-09 的口径：**「自然语言 ＋ AI 录入」整套退场**
 *     （《信息填写》就是"供应商用文字报单 → AI 解析"那条）⇒ **这条入口退场**。
 *
 * ⭐ **必须保留**的能力：「**生成采购申请 →「报货信息」**」——
 *   扫码补货报单与工作台都还在用（`publishPurchaseRequest` → `confirmPurchaseRequest`）。
 *
 * 本文件把验收标准逐条钉住（测试名 + 注释就是验收标准本身）：
 *   □ ① 「信息填写」不在 schema / 不在任何闸门范围里，全仓零读写点
 *   □ ② 报单入口退场：`accept` / `acceptMany` / 报货解析 / 采购退货那一串方法**不存在**
 *   □ ③ 关联键 `purchase_report_record_id` 从白名单删除（已无来源）
 *   □ ④ ⭐ **生成采购申请仍在**：写「报货批次」＋「报货信息」，并出图发群（功能级断言）
 *   □ ⑤ 「验收原话 / 确认状态」两列退场：映射 + 写入点 + 读取投影一起删
 *   □ ⑥ 9 点推送的供应商改读**「报货批次.供应商」**（真表新加的那一列）
 *   □ ⑦ 报货批次号的号源只剩「报货批次」一张表
 *   □ ⑧ 随入口退场的配置 / 策略模块**文件不存在**（不留死代码）
 *
 * ⚠️ 本文件自己就是"抓这些词"的那把尺子 ⇒ 扫描时**跳过自己**
 *    （与 `purchaseInboundRemoval.test.js` ① 同一个做法）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PurchaseWebhookService } = require('../src/services/purchaseWebhookService');
const { PurchaseOrderBatchService } = require('../src/services/purchaseOrderBatchService');
const { PurchasePendingBatchService } = require('../src/services/purchasePendingBatchService');
const { PurchaseBatchNoGenerator } = require('../src/services/purchaseBatchNoGenerator');
const { JsonTaskStore } = require('../src/infrastructure/jsonTaskStore');
const { V1_BITABLE_SCHEMA } = require('../src/config/v1BitableSchema');
const { V1_SCHEMA_SCOPES, getV1SelectOptionContracts } = require('../src/config/v1SchemaScopes');
const { CORRELATION_KEYS } = require('../src/utils/correlationFields');
const { resolvePurchaseBatchNoConfig } = require('../src/config/purchaseBatchNo');

process.env.FEISHU_V1_BITABLE_APP_TOKEN = process.env.FEISHU_V1_BITABLE_APP_TOKEN || 'test_app_token';

const SERVER_ROOT = path.join(__dirname, '..');
const DELETED_TABLE_KEY = 'purchaseReport';
const DELETED_TABLE_ENV = 'FEISHU_V1_PURCHASE_REPORT_TABLE_ID';
const DELETED_CORRELATION_KEY = 'purchase_report_record_id';

const table = (key) => V1_BITABLE_SCHEMA.tables[key];
const tempDir = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const walk = (dir, out = []) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

// 去注释后再扫：注释里要留沿革（"那张表以前叫…"），那不算引用。
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/([^:])\/\/.*$/gm, '$1');

/** 记录型 gateway（只实现本文件用得到的那几个方法）。 */
const makeGateway = (records = {}) => {
  const writes = [];
  const mapFields = (tableKey, semanticValues) => {
    const schema = table(tableKey);
    const out = {};
    Object.entries(semanticValues || {}).forEach(([key, value]) => {
      const fieldName = schema?.fields?.[key];
      if (!fieldName) throw new Error(`未配置语义字段: ${tableKey}.${key}`);
      if (value !== undefined) out[fieldName] = value;
    });
    return out;
  };
  return {
    writes,
    table,
    listFields: async () => [],
    get: async (tableKey, recordId) => (records[tableKey] || []).find((row) => row.record_id === recordId) || null,
    listAll: async (tableKey) => {
      if (tableKey === 'sizeManagement' && !records.sizeManagement) {
        return [{ record_id: 'size_36', fields: { 尺码: 36 } }];
      }
      if (tableKey === 'behavior' && !records.behavior) return [];
      return records[tableKey] || [];
    },
    create: async (tableKey, semanticValues) => {
      const fields = mapFields(tableKey, semanticValues);
      writes.push({ op: 'create', tableKey, fields });
      const record = { record_id: `new_${tableKey}_${(records[tableKey] || []).length + 1}`, fields };
      (records[tableKey] ||= []).push(record);
      return { recordId: record.record_id, record };
    },
    update: async (tableKey, recordId, semanticValues) => {
      const patch = mapFields(tableKey, semanticValues);
      writes.push({ op: 'update', tableKey, recordId, fields: patch });
      const record = (records[tableKey] || []).find((row) => row.record_id === recordId);
      if (record) record.fields = { ...record.fields, ...patch };
      return record || { record_id: recordId };
    },
    uploadAttachment: async () => 'file_token_1',
  };
};

const makeService = (options = {}) => {
  const gateway = options.gateway || makeGateway();
  const store = options.store || new JsonTaskStore({ dir: tempDir('purchase-intake-retired-') });
  const inventoryCalls = [];
  const sent = [];
  const service = new PurchaseWebhookService({
    gateway,
    store,
    references: options.references || {
      resolveProduct: async () => ({
        recordId: 'prod_1',
        record: { record_id: 'prod_1', fields: { 编号: '8088黑', 货号: '8088', 颜色: [{ text: '黑色' }], 供应商: ['sup_1'] } },
      }),
      resolveSupplier: async () => ({ recordId: 'sup_1', record: { record_id: 'sup_1', fields: { 供应商名称: '金猴' } } }),
    },
    inventory: { applyPurchase: async (payload) => { inventoryCalls.push(payload); return {}; } },
    client: {
      im: {
        image: { create: async () => ({ image_key: 'img_key' }) },
        message: {
          create: async (params) => { sent.push(params); return { code: 0, data: { message_id: `om_${sent.length}`, thread_id: '' } }; },
          reply: async (params) => { sent.push(params); return { code: 0, data: { message_id: `om_${sent.length}`, thread_id: 'omt_1' } }; },
        },
      },
    },
    images: { render: async () => Buffer.from('fake-png') },
    sandboxChatId: 'oc_test_purchase_group',
  });
  return { service, store, gateway, inventoryCalls, sent };
};

// ═══════════════════════════════════════════════════════════════════════════
// □ ① schema / 闸门范围 / 全仓读写点
// ═══════════════════════════════════════════════════════════════════════════

test('① schema 与闸门范围里都没有「信息填写」了（部署闸门红的那一行被拔掉）', () => {
  assert.equal(V1_BITABLE_SCHEMA.tables[DELETED_TABLE_KEY], undefined,
    '「信息填写」表已被业务负责人整个删除 ⇒ schema 里不许再有这一段');
  for (const scope of ['purchase', 'all']) {
    assert.equal(V1_SCHEMA_SCOPES[scope].includes(DELETED_TABLE_KEY), false,
      `范围 ${scope} 里不许再有它（否则闸门会去问一张不存在的表 → TableIdNotFound）`);
  }
  // 单选取值契约里也不许再指它的任何列（到货状态那条契约属于「报货批次」）。
  for (const contract of getV1SelectOptionContracts('purchase')) {
    assert.equal(contract.tableKey, 'purchaseOrderBatch');
  }
  // ⛔ 那两个"已删除的列"的契约也不许回来。
  assert.equal(getV1SelectOptionContracts('purchase')
    .some((item) => ['confirmStatus', 'acceptanceText'].includes(item.fieldKey)), false);
});

test('① 全仓（src/public/scripts/test）不再引用「信息填写」表键 / 环境变量 / schema 取表', () => {
  const roots = ['src', 'public', 'scripts', 'test'].map((dir) => path.join(SERVER_ROOT, dir));
  const guardFile = path.basename(__filename);
  const offenders = [];
  for (const file of roots.flatMap((root) => walk(root))) {
    if (!/\.(js|mjs|cjs|html)$/.test(file)) continue;
    // ⚠️ 跳过**本文件自己** —— 它就是"抓这个词"的那把尺子。
    if (path.basename(file) === guardFile) continue;
    const codeOnly = stripComments(fs.readFileSync(file, 'utf8'));
    // ⚠️ **"断言它不存在"的那几行要放过**：
    //   `assert.equal(V1_BITABLE_SCHEMA.tables.<key>, undefined)` 这类守门断言
    //   恰恰是"它不许回来"的哨兵，不是引用（本文件之外的守门用例里就有这种写法）。
    const refOnly = codeOnly.split('\n')
      .filter((line) => !/undefined|hasOwnProperty/.test(line))
      .join('\n');
    const hits = [];
    if (new RegExp(`['"]${DELETED_TABLE_KEY}['"]`).test(refOnly)) hits.push('表键字符串');
    if (new RegExp(`tables\\.${DELETED_TABLE_KEY}\\b`).test(refOnly)) hits.push('schema 取表');
    if (new RegExp(`fields\\.${DELETED_TABLE_KEY}\\b`).test(refOnly)) hits.push('读/写它的字段映射');
    if (new RegExp(DELETED_TABLE_ENV).test(refOnly)) hits.push('表 ID 环境变量');
    if (hits.length) offenders.push(`${path.relative(SERVER_ROOT, file)}（${hits.join('、')}）`);
  }
  assert.deepEqual(offenders, [], `已删除的表不许再被引用：\n${offenders.join('\n')}`);
});

test('① 关联键白名单里不再有 purchase_report_record_id（已无来源）', () => {
  assert.equal(CORRELATION_KEYS.includes(DELETED_CORRELATION_KEY), false,
    '那条报单记录不存在了 ⇒ 白名单键一起删（留下只会让日志永远缺一个"本该有值"的键）');
  // 保留的采购键仍然是那两个（批次号 + 批次记录 id）。
  assert.ok(CORRELATION_KEYS.includes('batch_no'));
  assert.ok(CORRELATION_KEYS.includes('purchase_batch_record_id'));
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ② 报单入口（与采购退货那条链）整块退场
// ═══════════════════════════════════════════════════════════════════════════

test('② 报单/退货入口的方法**不存在**（不是"留着不用"）；路由层也不再分派采购', () => {
  const retired = [
    'accept', 'acceptMany', 'process', 'handleReportBatch', 'runReportBatch',
    'processSupplierBatch', 'processSupplierReport', 'readReportBatchNo',
    'ensureIntakeBatchNo', 'ensureReportBatchNo', 'writeReportBatchNo',
    'parseReportQuantities', 'loadBehaviorIndex', 'notifyQuantityMismatches',
    'processSupplierReturn', 'runReturnBatch', 'prepareSupplierReturn', 'applySupplierReturn',
    'recoverPendingReturnBatches', 'deliverReturnImages', 'sendReturnNotice',
  ];
  for (const name of retired) {
    assert.equal(PurchaseWebhookService.prototype[name], undefined,
      `报单/退货入口的方法 ${name} 必须整个删除（留着就是"一条走不通的路"）`);
  }
  // 路由层：`supplier-report` 这个 kind 与 `acceptMany` 调用一起删掉。
  const routeSource = stripComments(
    fs.readFileSync(path.join(SERVER_ROOT, 'src/routes/larkEvents.js'), 'utf8'),
  );
  assert.equal(routeSource.includes('supplier-report'), false, '路由里不许再有报单 kind');
  assert.equal(routeSource.includes('acceptMany'), false, '路由里不许再调 acceptMany');
  assert.equal(routeSource.includes('purchaseIntake'), false, '分派表整个删除');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ④ ⭐ 必须保留：「生成采购申请」这条能力（功能级断言，不是"代码还在"）
// ═══════════════════════════════════════════════════════════════════════════

test('④ ⭐ 生成采购申请仍在：写「报货批次」＋「报货信息」，并出图发群（扫码补货那条免确认路径）', async () => {
  const { service, store, gateway, sent } = makeService();
  const taskId = 'scan_replenish_acceptance';
  const task = await store.create({
    task_id: taskId,
    kind: 'scan_replenish',
    status: 'posting',
    draft: {
      is_batch: true,
      operator_open_id: 'ou_user_1',
      supplier_record_id: 'sup_1',
      items: [{
        product_record_id: 'prod_1', item_no: '8088', color: '黑色',
        size: 36, quantity: 2, behavior_record_id: 'beh_1', supplier_record_id: 'sup_1',
      }],
    },
  });

  const result = await service.publishPurchaseRequest(taskId, task);

  // a. 「报货批次」那一行建成（到货状态默认「未到货」）。
  const batches = await gateway.listAll('purchaseOrderBatch');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].fields['报货批次号'], result.batch_no);
  assert.equal(batches[0].fields['到货状态'], '未到货');
  // b. 「报货信息」（采购申请落点，**保留**）逐条写成：批次关联 + 货品 + 尺码 + 数量 + 幂等键。
  const requests = await gateway.listAll('purchaseRequest');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].fields['报货批次号'][0], batches[0].record_id);
  assert.equal(requests[0].fields['编号'][0], 'prod_1');
  assert.equal(requests[0].fields['尺码'][0], 'size_36');
  assert.equal(requests[0].fields['数量'], 2);
  assert.ok(requests[0].fields['幂等键']);
  // c. 一个业务表都没多写：只碰这两张（＋出图那条 IM 调用）。
  const touched = [...new Set(gateway.writes.map((write) => write.tableKey))].sort();
  assert.deepEqual(touched, ['purchaseOrderBatch', 'purchaseRequest']);
  // d. 图发到了采购群（`sandboxChatId`），文案里带批次号。
  assert.ok(sent.length >= 1, '至少发了一条群消息（图 + @经办人的文字）');
  assert.ok(sent.some((item) => item.data?.msg_type === 'image'), '图必须发出去');
  // e. 任务进入终态，且返回体里带着批次号/条数（扫码页就靠它显示结果）。
  assert.equal((await store.get(taskId)).status, 'posted');
  assert.equal(result.request_ids.length, 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑤ 「验收原话 / 确认状态」两列退场（映射 + 写入点 + 投影一起删）
// ═══════════════════════════════════════════════════════════════════════════

test('⑤ 「报货批次」不再映射「验收原话 / 确认状态」；写确认状态的方法与投影都不在了', async () => {
  const fields = table('purchaseOrderBatch').fields;
  assert.equal(fields.acceptanceText, undefined);
  assert.equal(fields.confirmStatus, undefined);
  // ⭐ 保留下来的结构化验收：到货状态 + 实际数量 + 实际金额（一个字都没动）。
  assert.equal(fields.arrivalStatus, '到货状态');
  assert.equal(fields.actualQuantity, '实际数量');
  assert.equal(fields.actualAmount, '实际金额');

  assert.equal(PurchaseOrderBatchService.prototype.markConfirmed, undefined, '写「确认状态」的方法整个删除');
  assert.equal(PurchaseOrderBatchService.prototype.createForReturnBatch, undefined, '退货批次建行随退货入口删除');

  // 写入点：`writeAcceptance` 只写实际数量 / 实际金额（行为级断言）。
  const gateway = makeGateway({ purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'BH-1' } }] });
  const batches = new PurchaseOrderBatchService({ gateway });
  const written = await batches.writeAcceptance({
    batchNo: 'BH-1', actualQuantity: 3, actualAmount: 990, correlation: {},
  });
  assert.equal(written.updated, true);
  const write = gateway.writes.at(-1);
  assert.deepEqual(Object.keys(write.fields).sort(), ['实际金额', '实际数量'].sort());

  // 读取投影：工作台「到货验收情况」面板不再投影那两列。
  const querySource = stripComments(
    fs.readFileSync(path.join(SERVER_ROOT, 'src/services/purchaseQueryService.js'), 'utf8'),
  );
  assert.equal(/confirm_status/.test(querySource), false);
  assert.equal(/acceptance_text/.test(querySource), false);
  assert.match(querySource, /arrival_status/);
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑥ 9 点推送的供应商改读「报货批次.供应商」
// ═══════════════════════════════════════════════════════════════════════════

test('⑥ 9 点推送：供应商取自「报货批次.供应商」那一列（零额外请求），一格多个去重', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [
      {
        record_id: 'bat_1',
        fields: {
          报货批次号: 'BH-1', 到货状态: '未到货',
          // 关联单元格自带被关联记录的主字段文本 ⇒ 不需要再读第二张表。
          供应商: [{ text: '金猴' }, { text: '奥康' }, { text: '金猴' }],
        },
      },
      { record_id: 'bat_2', fields: { 报货批次号: 'BH-2', 到货状态: '未到货' } },
    ],
  });
  const service = new PurchasePendingBatchService({ gateway });
  const pending = await service.listPendingBatches();
  assert.deepEqual(pending.map((item) => item.batchNo), ['BH-1', 'BH-2']);
  assert.deepEqual(pending[0].suppliers, ['金猴', '奥康'], '去重、保序');
  assert.deepEqual(pending[1].suppliers, [], '取不到就空数组（绝不编）');
  assert.equal(PurchasePendingBatchService.prototype.loadSupplierIndex, undefined,
    '原来那个"整表读「信息填写」建索引"的方法已删除');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑦ 号源只剩「报货批次」一张表
// ═══════════════════════════════════════════════════════════════════════════

test('⑦ 报货批次号：号源只有「报货批次」，别的表一被读就抛', async () => {
  const gateway = makeGateway({
    purchaseOrderBatch: [{ record_id: 'bat_1', fields: { 报货批次号: 'CGD-20261007-0001' } }],
  });
  const originalListAll = gateway.listAll;
  gateway.listAll = async (tableKey) => {
    if (tableKey !== 'purchaseOrderBatch') throw new Error(`取号只许读「报货批次」，实际读了：${tableKey}`);
    return originalListAll(tableKey);
  };
  const generator = new PurchaseBatchNoGenerator({
    gateway,
    now: () => new Date('2026-10-07T02:00:00Z'),
    settings: resolvePurchaseBatchNoConfig({}),
  });
  const next = await generator.next();
  assert.equal(next.batchNo, 'CGD-20261007-0002');
});

// ═══════════════════════════════════════════════════════════════════════════
// □ ⑧ 随入口退场的模块 / 配置：文件不存在（不留死代码）
// ═══════════════════════════════════════════════════════════════════════════

test('⑧ 随入口退场的模块 / 配置都不在了（schema 段 + 读写点 + 配置一起删）', () => {
  const gone = [
    'src/services/purchaseQuantityPolicy.js', // 「数量说明」解析（唯一调用方是报单入口）
    'src/config/reportBatchWindow.js', // 报货归批窗口
    'src/config/reportReadRetry.js', // 读报单记录的重试
    'src/config/purchaseReturnBatchWindow.js', // 退货归批窗口
    'src/config/purchaseAcceptance.js', // 「确认状态」取值
  ];
  for (const rel of gone) {
    assert.equal(fs.existsSync(path.join(SERVER_ROOT, rel)), false, `${rel} 应随入口一起退场`);
  }
  // ⚠️ 「采购行为」分流策略**还在**（改名成 purchaseBehaviorPolicy），
  //    它现在的调用方是工作台采购查询（按「报货信息.采购行为」分流）。
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src/services/purchaseBehaviorPolicy.js')), true);
  assert.equal(fs.existsSync(path.join(SERVER_ROOT, 'src/services/purchaseReportBehaviorPolicy.js')), false,
    '旧文件名带着那张已删除的表名 ⇒ 改名，别让守门用例的扫描命中它');
});
