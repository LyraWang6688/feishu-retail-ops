/**
 * ⭐⭐ 2026-10-11（业务负责人，20:30 确认）：「**卖了样品、没有说把门盒变成谁的**」这件事，
 * 要在**工作台 → 销售 → 订单列表 →【待补充】**里作为一条**待办**，她点进去选"把哪个尺码的
 * 门盒挪一双变成样品" ⇒ 完成、待办消失。
 *
 * 🔴 **待办复用既有事实，不新造**：
 *    它就是 `SampleReplacementService.notifySampleReplacements` 早就落下的那批本地任务
 *      （`data/lark_mvp_tasks`，`type:'sample_replacement'`、`status:'pending'`；
 *      任务形状见 `sampleReplacementService.js:113-118`，task id = `sample_<hash(明细id)>` `:18-19`）。
 *    ⚠️ **工作台交付路径本来就在写它**（`routes/workbench.js:196-203`）——只是那边没有群上下文、
 *      卡片发不出去；本 service 只负责"**看见它** + **从工作台补掉**"。
 *
 * 🔴 **动作必须走 `InventoryService.promoteToSample`**（**不是** `transitionState`）：
 *    · 幂等键 = `samplePromotionId(salesDetailRecordId)` = `operationId('sample', …)`
 *      （`inventoryService.js:351`）⇒ 与**群卡片那条路共用同一个 operation** ⇒ **跨入口绝不重复挪**；
 *    · 流水**带「关联销售」**（`:920` / `:982`）、「变动数量」= 0（`:965`）；
 *    · **固定 1 双**（`:937` 只取 `liveRecords[0]`）—— 与群里那条同形（她确认"一次 1 双"）。
 *
 * ⚠️ **两条如实说明**（做不到的，不假装解决）：
 *   ① **不补历史**：上线后**新交付**才会产生待办（老单不会凭空出现待办）；
 *   ② **一次 1 双**：要一次补多双得改走 `transitionState`（`quantity` 支持 N），
 *      代价是丢「关联销售」与"跨入口同 operation"这两个优点 —— 她若要 N 双再另议。
 */
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { WORKBENCH_SAMPLE_FILL_TEXTS: TEXTS } = require('../config/workbenchOrders');
const { logInfo, logWarn } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');

/** 她填错/选错（HTTP 400）与系统没做成（5xx）要分开 —— 与工作台其它写入同一条纪律。 */
const userError = (message) => Object.assign(new Error(message), { statusCode: 400 });

const createSamplePendingService = (options = {}) => {
  if (!options.gateway) throw new Error('SamplePendingService 需要 gateway');
  const gateway = options.gateway;
  // ⚠️ 默认就是**群聊入口那份任务目录**（`data/lark_mvp_tasks`）——这是"复用既有事实"的前提；
  //    用例可以注入一个临时目录（`options.store`）。
  const store = options.store || new JsonTaskStore({
    dir: options.taskDir || path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id',
  });
  const inventory = options.inventory;
  if (!inventory) throw new Error('SamplePendingService 需要 inventory');
  const texts = { ...TEXTS, ...(options.texts || {}) };

  const fillText = (template, values = {}) => String(template ?? '')
    .replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined || values[key] === null ? match : String(values[key])));

  /** 所有**还没补掉**的补样品任务（`status !== 'completed'`；`pending` 是它的常态）。 */
  const listPending = async () => (await store.list()).filter(
    (task) => task?.type === 'sample_replacement' && task.status !== 'completed',
  );

  /** 按**销售明细**把待办找出来（一条明细最多一条补样品任务 —— task id 就是按明细推出来的）。 */
  const findByDetail = async (detailRecordId) => {
    const wanted = String(detailRecordId || '').trim();
    if (!wanted) return null;
    return (await store.list()).find(
      (task) => task?.type === 'sample_replacement' && task.sales_detail_record_id === wanted,
    ) || null;
  };

  /** 待办明细 id 集合（订单列表用它挂 `sample_pending`；只读）。 */
  const pendingDetailIds = async () => new Set((await listPending()).map((task) => task.sales_detail_record_id));

  /**
   * 「这一款还有哪些码有门盒」——与群里那条卡片**同一个取数实现**（`inventoryService.js:1308`）。
   *
   * ⭐ 2026-10-16（性能）：**可选的 `liveRecords`** —— 调用方**已经**把「实时库存」整表读进来的那一次
   *   快照，原样透传给 `InventoryService.sampleReplacementCandidates`（**一个字节都不再看那张表**）。
   *   为什么要有这条路：订单列表**每条待补样品**都会问一次候选，问一次就是一次整表读
   *   ⇒ 几条待办 = 几次串行整表读（线上 27~42 秒的真凶）。
   *   ⚠️ **不传就与以前逐字同行为**（`InventoryService` 那一侧自己读）；本层的 `fill()` 也**不传**
   *     （它要的是"此刻"的真实库存，不是别处传进来的快照）。
   */
  const candidatesFor = async (productRecordId, { excludeRecordIds = [], liveRecords = null } = {}) =>
    inventory.sampleReplacementCandidates(productRecordId, { excludeRecordIds, liveRecords });

  /**
   * 补掉一条待办：**门盒 → 样品**（1 双）。
   *
   * @returns {Promise<{ok: boolean, reused: boolean, size: number, ledger_record_id: string, message: string}>}
   * @throws {Error} `statusCode = 400` 表示"她选的不对/这一条不是待办"（**一个字都没写**）
   */
  const fill = async ({ detailRecordId, size, operatorOpenId = '', requestId = '', correlation = {} } = {}) => {
    const wantedSize = Number(size);
    if (!Number.isSafeInteger(wantedSize) || wantedSize <= 0) throw userError(texts.needSize);
    const task = await findByDetail(detailRecordId);
    if (!task) throw userError(texts.notPending);
    if (task.status === 'completed') {
      const doneSize = Number(task.result?.size || wantedSize);
      logInfo('workbench.sales.sample_fill.reused', {
        task_id: task.task_id, sales_detail_record_id: task.sales_detail_record_id, size: doneSize,
        ...correlationFields(correlation),
      });
      return {
        ok: true,
        reused: true,
        size: doneSize,
        ledger_record_id: task.result?.ledger_record_id || '',
        task_id: task.task_id,
        message: fillText(texts.reused, { size: doneSize }),
      };
    }
    // 先自己数一次门盒：这样拦住她的是**不带任何内部 id**的人话（引擎那句话里带货品 record_id）
    const doorBox = await inventory.findLiveInventory(task.product_record_id, wantedSize, '门盒');
    if (!doorBox.length) {
      logWarn('workbench.sales.sample_fill.no_doorbox', {
        task_id: task.task_id, sales_detail_record_id: task.sales_detail_record_id,
        product_record_id: task.product_record_id, size: wantedSize,
      });
      throw userError(fillText(texts.noDoorBox, { size: wantedSize }));
    }
    const result = await inventory.promoteToSample({
      salesDetailRecordId: task.sales_detail_record_id,
      productRecordId: task.product_record_id,
      size: wantedSize,
    }, { correlation: { ...correlationFields(correlation), task_id: task.task_id } });
    await store.update(task.task_id, {
      status: 'completed',
      operator_open_id: String(operatorOpenId || ''),
      completed_at: new Date().toISOString(),
      result: {
        size: wantedSize,
        live_record_id: result.liveRecordId,
        ledger_record_id: result.ledgerRecordId,
        request_id: String(requestId || ''),
        source: 'workbench',
      },
    });
    logInfo('workbench.sales.sample_fill.applied', {
      task_id: task.task_id, sales_detail_record_id: task.sales_detail_record_id,
      product_record_id: task.product_record_id, size: wantedSize,
      ledger_record_id: result.ledgerRecordId, live_record_id: result.liveRecordId,
      operator_open_id: String(operatorOpenId || ''),
      note: '门盒 → 样品（总量不变）；流水带「关联销售」；与群卡片共用同一个 operationId',
      ...correlationFields(correlation),
    });
    return {
      ok: true,
      reused: false,
      size: wantedSize,
      ledger_record_id: result.ledgerRecordId,
      task_id: task.task_id,
      message: fillText(texts.done, { size: wantedSize }),
    };
  };

  return { listPending, pendingDetailIds, findByDetail, candidatesFor, fill, store, gateway };
};

module.exports = { createSamplePendingService, userError };
