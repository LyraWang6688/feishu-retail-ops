// 退换货第二期·第一步：售后执行器（纯服务）。
//
// 边界（刻意收窄）：
//   · 不接消息、不接卡片、不判断意图——调用方（第二期第二步）把已经确认过的
//     action / 原单 / 新明细 / 差价 / 结算方式 / 退回状态传进来，这里只负责**落库**。
//   · 不生成单号：售后沿用**原销售单号**（退货/换货不建新单号）。
//   · 不另写库存逻辑：库存流水与实时库存一律走既有的 InventoryService（见下面 inventory 端口）。
//   · 不改生产表结构：不给销售主表 / 销售明细 / 收款明细加字段（见幂等一节）。
//
// 写入（默认口径：**售后不影响原单**）：
//   1) 新「销售主表」：原话 + 原销售单号 + 交易类型=行为(SALE_RETURN/EXCHANGE/COMPENSATION)
//   2) 新「销售明细」行：交易类型=行为 · 销售单号=**原主表**（关联）· 成交金额=正数
//   3) 原「销售明细」的「履约状态」→ 已退货 / 已换货 / 已赔货
//   4) 钱：cash → 「收款明细」一条（交易方向=收入/退回，金额正数，关联=新主表，
//          交易方式 = **她说的那个**；她没说才沿用原单的 —— 见 settleCash）；
//          prepaid → 「客户往来货款」一条（变动类型=退货退款，应收变化=带符号差价）
//   5) 「库存流水」：退货 1 行 / 赔货 1 行 / 换货 2 行（方向相反），数量都是正数
//   6) 「实时库存」：退货/换货把旧鞋加回 restockState；换货/赔货按声明从门盒减一行
//
//   ⭐ 原「销售主表」**一字不动**（业务负责人 2026-10-06 定过）：
//      「退过没退过」记在原「销售明细」的「履约状态 = 已退货/已换货/已赔货」＋
//      新建的那条退货单（交易类型 = 销售退货）上，**不写原单的「销售状态」** ——
//      那一列的语义是"明细写进去了没有"（未写入/部分写入/已写入/写入失败），
//      根本没有「已退货」这个选项，真写下去飞书会自动新建选项、把那一列搞乱。
//      （曾经有过一个"回写原单销售状态"的开关及其实现，已于 2026-10-06 整体删除，
//        查不到任何残留 —— 连名字都不再出现。）
//
// 幂等分两层（父代理 2026-10-05 的裁决：不给这三张表加幂等键列）：
//
//   ① 总闸门 = 「这一次售后做过没」，落在本地任务记录（JsonTaskStore，与库存的
//      data/inventory_operations 同一套机制）：
//        · 已完成 → **整次跳过**：不读业务表、不调用库存、一个字节都不写，直接返回上次的结果；
//        · 已完成但请求指纹不同 → **大声失败**（不能当成同一次，更不能重写一遍）；
//        · 做到一半 → 带着已写好的 record_id 继续（每个阶段写完就落盘），重试不重复写。
//      闸门分片键：调用方给 taskId 就用它，否则 after_sales_<原主表id>_<action>_<批次哈希>。
//      「批次哈希」= 本次涉及的原明细 record_id 排序后的短哈希（见 config/afterSales.js）：
//      同一批明细重复调用 → 同一个分片 → 幂等；不同批明细（部分退货）→ 不同分片 → 各做各的。
//
//   ② 「客户往来货款」用它自己的幂等键字段「业务事件ID」
//      = after_sales:<原主表id>:<action>:<批次哈希>，
//      走既有的 createOnceByKey（先按键回查远端，命中就复用）——本地记录丢了也能认出这一笔。
//
// 已知窗口：飞书 create 成功但本地落盘失败时，本地闸门看不出来，理论上会重复写。
// 要堵住这个窗口必须有远端键列（这一期明确不加）；库存那一侧不受影响——
// InventoryService 用「库存操作键」在远端兜住了。
//
// ⚠️ 库存接线（已完成）：inventoryService 的 STOCK_MOVEMENTS 已声明
//   SALE_RETURN（增加）/ SALE_COMPENSATION（减少·门盒）/ SALE_CASH（减少·门盒），
//   AfterSalesService 默认就用真的 InventoryService（见构造函数），
//   同时保留端口注入：测试与需要共享实例的调用方可以传自己的库存服务。

const path = require('node:path');
const {
  AFTER_SALES_ACTIONS,
  AFTER_SALES_CREDIT_KEY_FIELD,
  actionSpecOf,
  afterSalesEventId,
  afterSalesOperationId,
  readAfterSalesConfig,
} = require('../config/afterSales');
const { SELLABLE_KINDS, sellableKindOf } = require('../config/sellableKinds');
const { createOnceByKey, validateIdempotencyKeyFields } = require('../infrastructure/idempotencyKey');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { InventoryService } = require('./inventoryService');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { withSalesReadRetry } = require('./salesReadRetry');
const { cents } = require('./salesProgressService');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { logInfo, logWarn } = require('../utils/logger');

const DEFAULT_STORE_DIR = path.join(__dirname, '../../data/after_sales_operations');

const requiredText = (value, label) => {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
};

// 成交金额一律正数（业务负责人明确要求：金额都填正数，统计时按方向抵消）。
// 先判正负再交给 cents()（销售链路在用的同一个"两位小数"校验），
// 这样负数得到的是"必须大于 0"而不是"必须是非负的两位小数"这种绕的说法。
const positiveYuan = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return cents(number, label) / 100;
};

// 差价可正可负；cents() 只收非负，所以符号单独取。
const signedYuan = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label}必须是数字`);
  const sign = number < 0 ? -1 : 1;
  return (sign * cents(Math.abs(number), label)) / 100;
};

const cellText = (value) => textValue(value).trim();
const cellNumber = (value) => {
  const raw = cellText(value).replace(/,/g, '').replace(/¥/g, '');
  return raw === '' ? null : Number(raw);
};

/**
 * 请求指纹：同一个闸门分片（原单 + 动作）下的"这一次"到底是不是同一次请求。
 * 只放业务字段，不放 receivedAt / operatorOpenId 这类每次都可能不同的东西，
 * 否则重试会被误判成"另一次售后"。
 */
const fingerprintOf = (request) => JSON.stringify({
  action: request.action,
  originalSalesEntryRecordId: request.originalSalesEntryRecordId,
  originalSalesOrderNo: request.originalSalesOrderNo,
  originalText: request.originalText,
  originalDetailIds: [...request.originalSalesDetailRecordIds].sort(),
  newLines: request.newLines.map((line) => [line.productId, line.sizeId, line.amount]),
  restockState: request.restockState,
  settlement: request.settlement,
  // ⭐ 她说的收款方式也要进指纹：同一个分片上"退现金"改成"退微信"是**另一笔**，
  //    不能被当成同一次重试而整次跳过（那会把钱记成上一次那个方式）。
  paymentMethod: request.paymentMethod,
  diffAmount: request.diffAmount,
});

/**
 * 售后执行器。
 *
 * options:
 *   gateway    必填，V1BitableGateway（或同形态的实现）
 *   inventory  可选，库存服务端口；不传就用真的 InventoryService（接线后的默认路径）。
 *              只用到既有方法 applyChange({ kind, productRecordId, size, state, quantity, sourceRecordId })。
 *   store      可选，本地任务记录（默认 data/after_sales_operations）
 *   references / sizeReferences / queues / config / now 可选（测试注入用）
 */
class AfterSalesService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('AfterSalesService requires gateway');
    this.config = options.config || readAfterSalesConfig();
    this.gateway = options.gateway;
    // 接线：库存流水与实时库存一律复用既有的 InventoryService（它自己负责
    // 「库存操作键」回查、断点续做与实时库存增减），这里不另写一套库存逻辑。
    // 仍然允许注入端口：单元测试用它替换飞书写入，生产也可以传共享实例。
    this.inventory = options.inventory || new InventoryService({ gateway: this.gateway });
    this.store = options.store || new JsonTaskStore({ dir: DEFAULT_STORE_DIR, idField: 'operation_id' });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway,
      sizeReferences: options.sizeReferences,
    });
    this.queues = options.queues || new KeyedSerialQueue();
    // 四个状态维度的唯一写入口（名字与取值都在 config/salesStatusDimensions）。
    this.status = options.status || new SalesStatusWriter({ gateway: this.gateway });
    this.now = options.now || (() => Date.now());
    this.creditSchemaValidated = null;
  }

  tableOf(tableKey) {
    return this.gateway.table(tableKey);
  }

  /**
   * 执行一次售后。
   *
   * async 是为了让入参校验失败也走"被拒绝的 Promise"，调用方无论校验错还是写入错
   * 都能用同一套 await / catch 处理，不会出现"同步抛"漏到 try 外面的情况。
   * 同一个闸门分片串行：两次并发调用不能同时通过"还没做过"再各写一遍。
   */
  async execute(input = {}) {
    const request = this.normalizeRequest(input);
    return this.queues.run(request.operationId, () => this.runWithGate(request));
  }

  /** 入参规范化 + 校验。返回的 operationId / eventId / fingerprint 就是幂等用的三个标识。 */
  normalizeRequest(input) {
    const action = String(input.action || '').trim();
    const spec = actionSpecOf(action);
    const originalSalesEntryRecordId = requiredText(input.originalSalesEntryRecordId, '原销售主表记录 id');
    const originalSalesOrderNo = requiredText(input.originalSalesOrderNo, '原销售单号');
    const originalText = requiredText(input.originalText, '原话');
    const originalSalesDetailRecordIds = [
      ...new Set((input.originalSalesDetailRecordIds || []).map((id) => String(id ?? '').trim()).filter(Boolean)),
    ];
    if (!originalSalesDetailRecordIds.length) throw new Error('售后至少要指明一条被退/被换的原销售明细');

    const rawLines = Array.isArray(input.newLines) ? input.newLines : [];
    if (!spec.acceptsNewLines && rawLines.length) {
      throw new Error(`${spec.label}不应带新的出货商品（newLines 必须为空）`);
    }
    if (spec.acceptsNewLines && !rawLines.length) {
      throw new Error(`${spec.label}缺少新的出货商品（newLines）`);
    }
    const newLines = rawLines.map((line, index) => ({
      productId: requiredText(line?.productId, `第 ${index + 1} 条出货商品的货品 id`),
      sizeId: requiredText(line?.sizeId, `第 ${index + 1} 条出货商品的尺码 id`),
      amount: positiveYuan(line?.amount, `第 ${index + 1} 条出货商品的成交金额`),
    }));

    const restockState = String(input.restockState || '').trim();
    if (restockState && !this.config.restockStates.includes(restockState)) {
      throw new Error(`退回的鞋只能回「${this.config.restockStates.join(' / ')}」，收到的是：${restockState}`);
    }
    if (spec.requiresRestockState && !restockState) {
      throw new Error(`${spec.label}缺少「退回的鞋回哪儿」（restockState：${this.config.restockStates.join(' / ')}）`);
    }

    const settlementRaw = input.settlement == null || input.settlement === '' ? null : String(input.settlement);
    if (settlementRaw && !this.config.settlements.includes(settlementRaw)) {
      throw new Error(`未声明的资金走向：${settlementRaw}（只能是 ${this.config.settlements.join(' / ')} 或空）`);
    }
    const diffAmount = input.diffAmount == null || input.diffAmount === ''
      ? null
      : signedYuan(input.diffAmount, '差价');
    // 差价为 null / 0 → 不动钱（规格明确要求）。
    const movesMoney = settlementRaw !== null && diffAmount !== null && diffAmount !== 0;

    // 她说的收款方式（"退我现金" → 现金）：业务负责人 2026-10-06 定 —— 记录里要写**她说的**那个。
    // 空 = 她没说 → settleCash 沿用原单的方式（现有逻辑，见那里）。
    // ⚠️ 这里**不**校验它在不在「收款方式管理」里：接线层（afterSalesFlowService）已经在校验，
    //    而执行器要保持"只落库"的边界 —— 真到了写库那一刻找不到，resolvePaymentMethod 会当场抛。
    const paymentMethod = String(input.paymentMethod || '').trim();

    const operatorOpenId = String(input.operatorOpenId || '').trim();
    let receivedAt = null;
    if (movesMoney && input.receivedAt != null) {
      receivedAt = Number(input.receivedAt);
      if (!Number.isFinite(receivedAt) || receivedAt <= 0) throw new Error('收款时间无效');
    }

    const request = {
      action,
      spec,
      shoeKind: sellableKindOf({ kind: 'shoe' }),
      originalSalesEntryRecordId,
      originalSalesOrderNo,
      originalText,
      originalSalesDetailRecordIds,
      newLines,
      restockState: restockState || null,
      settlement: movesMoney ? settlementRaw : null,
      paymentMethod: movesMoney && settlementRaw === 'cash' ? paymentMethod : '',
      diffAmount: movesMoney ? diffAmount : 0,
      operatorOpenId,
      taskId: String(input.taskId || '').trim(),
      receivedAt,
    };
    request.operationId = afterSalesOperationId(request);
    request.eventId = afterSalesEventId(request);
    request.fingerprint = fingerprintOf(request);
    return request;
  }

  /**
   * 总闸门。
   *   · 已完成 + 指纹一致 → 整次跳过（不写任何东西，返回上次的结果）
   *   · 已经写过东西 + 指纹不同 → 停下来：同一次的分片里不能塞进另一笔售后
   *   · 没记录 / 上一次没写成 + 指纹一致 → 继续（没写过东西时分片可以被这次接管）
   */
  async runWithGate(request) {
    const existing = await this.store.get(request.operationId);
    // 「已经写进去过东西」才需要认指纹：主表/明细/状态/收款/往来货款任一落过盘，
    // 就说明这一个分片上已经产生业务事实，换一笔请求不能直接接管。
    const wroteSomething = Boolean(existing && (
      existing.master_record_id
      || (existing.detail_record_ids || []).length
      || (existing.original_details_marked || []).length
      || existing.payment_record_id
      || existing.credit_record_id
    ));
    if (wroteSomething && existing.request_fingerprint !== request.fingerprint) {
      throw new Error(
        `这次售后（${request.operationId}）在本地已有记录，但请求内容与上次不同：` +
        '不能当成同一次，也不能再写一遍，请人工核对',
      );
    }
    if (existing?.status === 'completed') {
      logInfo('after_sales.skipped.already_done', {
        operation_id: request.operationId,
        action: request.action,
        master_record_id: existing.master_record_id,
      });
      return existing.result;
    }
    // 上一次没写成功（例如入参错、原单号打错）：没留下任何业务事实，允许这次接管这个分片。
    if (existing && !wroteSomething) {
      await this.store.update(request.operationId, {
        request_fingerprint: request.fingerprint,
        action: request.action,
        original_sales_entry_record_id: request.originalSalesEntryRecordId,
        original_sales_order_no: request.originalSalesOrderNo,
      });
    }
    const progress = existing || await this.store.create({
      operation_id: request.operationId,
      type: 'after_sales',
      status: 'running',
      request_fingerprint: request.fingerprint,
      action: request.action,
      original_sales_entry_record_id: request.originalSalesEntryRecordId,
      original_sales_order_no: request.originalSalesOrderNo,
      master_record_id: '',
      detail_record_ids: [],
      original_details_marked: [],
      payment_record_id: '',
      credit_record_id: '',
    });
    return this.run(request, progress);
  }

  async saveProgress(request, patch) {
    return this.store.update(request.operationId, patch);
  }

  async run(request, progress) {
    const { spec } = request;
    // 这一次售后的业务时刻：只喂给「收款时间」(receivedAt) 与库存服务的本地任务记录，
    // **不写**任何飞书时间列（2026-10-06 起：「发生时间」不再写，「入库时间」「报单时间」
    // 已从生产表删除）。调用方给了时间就用它，否则用当前时间。
    request.occurredAt = request.receivedAt ?? this.now();
    // 要用「客户往来货款」的幂等键时先校验它真实存在：缺列要大声失败，而且要在任何写入之前。
    if (request.settlement === 'prepaid') await this.validateCreditKey();

    const original = await this.readOriginal(request);
    const master = await this.ensureMaster(request, spec, progress);
    const plan = this.buildPlan(request, original);
    const rows = await this.ensureDetailRows(request, plan, master, progress);
    const originalDetailIdsMarked = await this.markOriginalDetails(spec, original, progress);
    const money = await this.settleMoney(request, original, master, progress);
    // 「库存状态」：售后的回补 / 出库也走同一个维度。
    // ⚠️ applyStock 是**要么全成、要么抛**（它不逐条收集失败），所以这里只会出现
    //    「已扣减 / 扣减失败」两档；「部分扣减」在这一条链路上不会出现（不假装有）。
    let stock;
    try {
      stock = await this.applyStock(request, spec, plan);
    } catch (error) {
      await this.status.write(master.recordId, { stock: WRITE.stock.failed });
      throw error;
    }
    // 走到这里 = 主表 / 明细 / 钱 / 库存四件事都落完了 → 三个维度一起收口。
    await this.status.write(master.recordId, {
      sales: WRITE.sales.done, funds: WRITE.funds.done, stock: WRITE.stock.done,
    });
    // ⭐ 到这里就结束了：**原「销售主表」一字不动**（业务负责人 2026-10-06 定过）。
    //    "退过没退过"记在原「销售明细」的「履约状态」和新建的退货单上；
    //    原单的「销售状态」那一列语义是"明细写进去了没有"，没有「已退货」这个选项，
    //    写了飞书会自动新建选项。（回写原单「销售状态」的开关与实现已于 2026-10-06 整体删除。）

    const result = {
      action: request.action,
      label: spec.label,
      originalSalesOrderNo: request.originalSalesOrderNo,
      operationId: request.operationId,
      masterRecordId: master.recordId,
      detailRecordIds: rows.map((row) => row.recordId),
      originalDetailIdsMarked,
      money,
      stock,
    };
    await this.saveProgress(request, {
      status: 'completed',
      result,
      completed_at: new Date(this.now()).toISOString(),
    });
    logInfo('after_sales.executed', {
      operation_id: request.operationId,
      action: request.action,
      original_sales_entry_record_id: request.originalSalesEntryRecordId,
      original_sales_order_no: request.originalSalesOrderNo,
      master_record_id: master.recordId,
      detail_count: rows.length,
      original_details_marked: originalDetailIdsMarked.length,
      money_route: money.route,
      // 钱的交易方式是哪来的（spoken = 她说的 / original = 她没说、沿用原单）——
      // 这是"她说现金、账上写微信"这类问题的排查入口。
      money_method_source: money.methodSource || '',
      money_method_id: money.methodId || '',
      stock_rows: stock.map((item) => `${item.behaviorCode}:${item.state}:${item.quantity}`),
    });
    return result;
  }

  // --- 0) 读原单：原主表 + 被退被换的原明细行 + 原单的收款方式 ------------------------

  async readOriginal(request) {
    const entryFields = this.tableOf('salesEntry').fields;
    const entry = await withSalesReadRetry(
      () => this.gateway.get('salesEntry', request.originalSalesEntryRecordId),
      'after_sales_original_entry',
    );
    if (!entry) throw new Error(`找不到原销售主表记录：${request.originalSalesEntryRecordId}`);
    const orderNo = cellText(entry.fields?.[entryFields.orderNo]);
    // 原单号对不上说明调用方挑错了原单：停下来，别把售后写到别的单上。
    if (orderNo && orderNo !== request.originalSalesOrderNo) {
      throw new Error(`原单号对不上：主表记录上是「${orderNo}」，请求里是「${request.originalSalesOrderNo}」`);
    }

    const detailFields = this.tableOf('salesDetail').fields;
    const details = [];
    for (const recordId of request.originalSalesDetailRecordIds) {
      const record = await withSalesReadRetry(
        () => this.gateway.get('salesDetail', recordId),
        'after_sales_original_detail',
      );
      if (!record) throw new Error(`找不到原销售明细：${recordId}`);
      if (!linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(request.originalSalesEntryRecordId)) {
        throw new Error(`原销售明细 ${recordId} 不属于销售单 ${request.originalSalesEntryRecordId}，已停止售后`);
      }
      details.push(record);
    }

    return {
      entry,
      orderNo,
      details,
      paymentMethodRecordId: await this.readOriginalPaymentMethod(request.originalSalesEntryRecordId),
    };
  }

  /**
   * 售后收/退款沿用**原单的收款方式**。原单可能有多条收款记录（混合支付），
   * 取记录 id 最小的那条：同一份数据每次结果一致，不会因为列表顺序变化换方式。
   */
  async readOriginalPaymentMethod(salesEntryRecordId) {
    const fields = this.tableOf('paymentRecord').fields;
    if (!fields.method) return '';
    const records = await withSalesReadRetry(
      () => this.gateway.listAll('paymentRecord'), 'after_sales_original_payments',
    );
    const candidates = records
      .filter((record) => linkedRecordIds(record.fields?.[fields.salesEntry]).includes(salesEntryRecordId))
      .map((record) => ({ recordId: record.record_id, methodIds: linkedRecordIds(record.fields?.[fields.method]) }))
      .filter((item) => item.methodIds.length === 1)
      .sort((left, right) => String(left.recordId).localeCompare(String(right.recordId)));
    return candidates[0]?.methodIds[0] || '';
  }

  // --- 1) 新「销售主表」记录 ---------------------------------------------------------

  async ensureMaster(request, spec, progress) {
    // 交易类型必须能关联到行为：它既表达"这次是什么动作"，也是查单链路
    // （saleLookupService 判据二）排除已退单的依据，所以查不到就大声失败，
    // 不像销售链路那样只记警告继续（那边交易类型只是审计字段）。
    const behavior = await this.references.resolveBehavior(spec.tradeTypeCode);
    if (progress.master_record_id) {
      await this.verifyMaster(request, progress.master_record_id, behavior.recordId);
      return { recordId: progress.master_record_id, tradeTypeRecordId: behavior.recordId, reused: true };
    }
    const created = await this.gateway.create('salesEntry', {
      originalText: request.originalText,
      // 售后沿用原单号，不生成新号（退货/换货不建新单）。
      orderNo: request.originalSalesOrderNo,
      parseStatus: this.config.masterParseStatus,
      // 「确认状态」（用户那一维）：售后主表**只在她点过卡片「确认」之后**才会被创建
      // （execute 只从 AfterSalesFlowService 的确认动作进来），所以那一刻记为「已确认」。
      // ⚠️ 不写「未确认」：这张卡已经点过了，写「未确认」会让它永远停在"等她确认"上。
      // 「销售状态 / 资金状态」此刻一个字都还没写（明细 / 退款在后面几步）→ 未写入。
      // ⚠️ 旧「确认状态（旧）」那一列已被她整列删除（值不可恢复），四个维度是唯一入口。
      userAction: WRITE.userAction.confirmed,
      sales: WRITE.sales.none,
      funds: WRITE.funds.none,
      tradeType: relation(behavior.recordId),
      ...(request.operatorOpenId ? { sender: person(request.operatorOpenId) } : {}),
    });
    // 写一条就落一次盘：中途挂掉时重试能认出"主表已经写过了"。
    await this.saveProgress(request, { master_record_id: created.recordId });
    return { recordId: created.recordId, tradeTypeRecordId: behavior.recordId, reused: false };
  }

  async verifyMaster(request, recordId, tradeTypeRecordId) {
    const fields = this.tableOf('salesEntry').fields;
    const record = await this.gateway.get('salesEntry', recordId);
    let mismatch = '';
    if (!record) mismatch = '记录已不存在';
    else if (cellText(record.fields?.[fields.originalText]) !== request.originalText) mismatch = '原话不一致';
    else if (cellText(record.fields?.[fields.orderNo]) !== request.originalSalesOrderNo) mismatch = '销售单号不一致';
    else if (!linkedRecordIds(record.fields?.[fields.tradeType]).includes(tradeTypeRecordId)) mismatch = '交易类型不一致';
    if (mismatch) {
      throw new Error(`已记录的售后主表 ${recordId} 与当前请求不一致（${mismatch}），请人工核对，不能自动重试`);
    }
  }

  // --- 2) 新「销售明细」行 -----------------------------------------------------------

  /**
   * 一次售后要做的事，先落成一份**计划**再执行。计划的分片顺序是确定性的
   * （重试同样入参 → 同样计划 → 本地记录里的第 N 条对得上第 N 行）。
   *
   * 行序规范化：
   *   · 被退/被换的原明细行按 record_id 排序（调用方传参顺序变了也不换）
   *   · 出货商品按调用方给的顺序（它们没有稳定的业务 id，顺序就是请求的一部分）
   *
   * writeDetail 说明这一项要不要写「销售明细」：
   *   退货  → 写：退回商品的**复制明细行**（newLines 为空；退货"退回的那一行"就是它，金额取原值且为正）
   *   换货  → 旧鞋**不写**明细行（契约里 newLines 才是新增明细行），只有出货商品写
   *   赔货  → 坏鞋不回库也不写行，只有出货商品写
   */
  buildPlan(request, original) {
    const detailFields = this.tableOf('salesDetail').fields;
    const plan = [];
    if (request.action !== AFTER_SALES_ACTIONS.COMPENSATION) {
      const originals = [...original.details].sort((left, right) =>
        String(left.record_id).localeCompare(String(right.record_id)));
      for (const record of originals) {
        const fields = record.fields || {};
        const sellable = this.detailKindOf(fields, detailFields);
        plan.push({
          kind: 'returned',
          writeDetail: request.action === AFTER_SALES_ACTIONS.RETURN,
          sellable,
          linkField: sellable.detailLinkField,
          linkRecordId: sellable.recordId,
          sizeCell: fields?.[detailFields.size],
          sizeRecordId: sellable.requiresSize
            ? this.singleLink(fields?.[detailFields.size], `原销售明细 ${record.record_id} 的尺码`)
            : '',
          amount: positiveYuan(cellNumber(fields?.[detailFields.actualAmount]), '原销售明细成交金额'),
          originalRecordId: record.record_id,
          recordId: '',
        });
      }
    }
    for (const line of request.newLines) {
      plan.push({
        kind: 'new',
        writeDetail: true,
        sellable: request.shoeKind,
        linkField: request.shoeKind.detailLinkField,
        linkRecordId: line.productId,
        // 尺码单元格用关联 id 的形态，后面统一按关联解析成数字交给库存服务。
        sizeCell: [line.sizeId],
        sizeRecordId: line.sizeId,
        amount: line.amount,
        // ⭐ 新建明细行的「履约状态」——**取值只从动作配置来**（不在这里写中文字面量）：
        //   换货声明了 newLineFulfillmentStatus（新换出去的那双=已交付）；
        //   退货/赔货没声明 → 空 → 建行时不带这一列（既有行为一个字不改）。
        fulfillmentStatus: request.spec?.newLineFulfillmentStatus || '',
        originalRecordId: '',
        recordId: '',
      });
    }
    return plan;
  }

  /** 原明细行是鞋还是配品，由 sellableKinds 里声明的关联字段决定（不写死「编号」/「配品」）。 */
  detailKindOf(fields, detailFields) {
    for (const [key, declared] of Object.entries(SELLABLE_KINDS)) {
      const ids = linkedRecordIds(fields?.[detailFields[declared.detailLinkField]]);
      if (ids.length > 1) {
        throw new Error(`原销售明细的「${declared.label}」关联了 ${ids.length} 条记录，无法确定售后的是哪一件`);
      }
      if (ids.length === 1) return { ...sellableKindOf({ kind: key }), recordId: ids[0] };
    }
    throw new Error('原销售明细既没有「编号」也没有「配品」，无法生成售后明细行');
  }

  singleLink(cell, label) {
    const ids = linkedRecordIds(cell);
    if (ids.length !== 1) throw new Error(`${label}必须且只能关联一条记录`);
    return ids[0];
  }

  /**
   * 写「销售明细」的新行。只写 writeDetail=true 的计划项：
   * 换货里被换回的旧鞋不建行，它是靠**被改状态的原明细行** + 库存流水表达的。
   * 每一行写完就把 record_id 追加进本地记录，重试时按位置复用。
   *
   * ⭐ 「履约状态」与建行**同一次 create** 写下去（不是随后再 update）：
   *   ① 少一次远端调用；② 断点续做/重放时**不会**再写第二遍——
   *   复用已建好的行时只做核验（verifyDetailRow），一个字节都不改。
   */
  async ensureDetailRows(request, plan, master, progress) {
    const detailFields = this.tableOf('salesDetail').fields;
    const known = [...(progress.detail_record_ids || [])];
    const rows = [];
    for (const [index, row] of plan.filter((item) => item.writeDetail).entries()) {
      if (known[index]) {
        await this.verifyDetailRow(known[index], row, {
          originalSalesEntryRecordId: request.originalSalesEntryRecordId,
          tradeTypeRecordId: master.tradeTypeRecordId,
        }, detailFields);
        row.recordId = known[index];
        row.reused = true;
        rows.push(row);
        continue;
      }
      const created = await this.gateway.create('salesDetail', {
        // 「销售单号」关联**原主表**：查单链路（saleLookupService 判据二）就是按
        // "这条退货明细属于哪张单"把已退的单整单排除的；关联新主表会让旧单查不出来。
        salesEntry: relation(request.originalSalesEntryRecordId),
        [row.linkField]: relation(row.linkRecordId),
        actualAmount: row.amount,
        tradeType: relation(master.tradeTypeRecordId),
        ...(row.sizeRecordId ? { size: relation(row.sizeRecordId) } : {}),
        // 空 = 这个动作不写履约状态（退货/赔货），一个字节都不带 —— 不写空串、不写默认值。
        ...(row.fulfillmentStatus ? { fulfillmentStatus: row.fulfillmentStatus } : {}),
      });
      row.recordId = created.recordId;
      row.reused = false;
      known[index] = created.recordId;
      await this.saveProgress(request, { detail_record_ids: known });
      rows.push(row);
    }
    return rows;
  }

  /**
   * 按位置复用的行必须和当前计划对得上：内容不同 = 上一次写的东西和这次请求不是一回事，
   * 继续复用会把两笔业务混成一条。停下来让人核对。
   */
  async verifyDetailRow(recordId, row, expected, detailFields) {
    const record = await this.gateway.get('salesDetail', recordId);
    let mismatch = '';
    if (!record) mismatch = '记录已不存在';
    else if (!linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(expected.originalSalesEntryRecordId)) {
      mismatch = '销售单号关联不是原主表';
    } else if (!linkedRecordIds(record.fields?.[detailFields[row.linkField]]).includes(row.linkRecordId)) {
      mismatch = `「${row.linkField}」关联不一致`;
    } else if (row.sizeRecordId && !linkedRecordIds(record.fields?.[detailFields.size]).includes(row.sizeRecordId)) {
      mismatch = '尺码关联不一致';
    } else if (Number(cellNumber(record.fields?.[detailFields.actualAmount])) !== Number(row.amount)) {
      mismatch = '成交金额不一致';
    } else if (!linkedRecordIds(record.fields?.[detailFields.tradeType]).includes(expected.tradeTypeRecordId)) {
      mismatch = '交易类型不一致';
    }
    if (mismatch) {
      throw new Error(`已记录的售后明细 ${recordId} 与当前请求不一致（${mismatch}），请人工核对，不能自动重试`);
    }
  }

  // --- 3) 原「销售明细」的「履约状态」 ----------------------------------------------

  /**
   * 只改原「销售明细」的「履约状态」——**原「销售主表」一字不动**（业务负责人 2026-10-06 定过）。
   * 「退过没退过」就记在这里 ＋ 新建的那条退货单上；原单的「销售状态」语义是
   * "明细写进去了没有"（没有「已退货」这个选项，写了飞书会自动新建选项），不许写。
   * ⚠️ 原主表的「订单状态」那一列已被她 2026-10-06 整列删除，没有写入点。
   * 已经等于目标值就跳过；改过一条就把进度落盘，重试不会重复写同一条记录。
   */
  async markOriginalDetails(spec, original, progress) {
    const detailFields = this.tableOf('salesDetail').fields;
    const known = new Set(progress.original_details_marked || []);
    for (const record of original.details) {
      if (known.has(record.record_id)) continue;
      const current = cellText(record.fields?.[detailFields.fulfillmentStatus]);
      if (current === spec.originalFulfillmentStatus) continue;
      await this.gateway.update('salesDetail', record.record_id, {
        fulfillmentStatus: spec.originalFulfillmentStatus,
      });
      known.add(record.record_id);
      await this.store.update(progress.operation_id, { original_details_marked: [...known] });
    }
    // 返回"这一次售后一共改过哪些原明细行"（含前几次重试改的）：
    // 重试后的结果也要完整，不能只报本次新改的那几条。
    return [...known];
  }

  // --- 4) 钱 -------------------------------------------------------------------------

  async settleMoney(request, original, master, progress) {
    if (!request.settlement) return { route: 'none', recordId: '', direction: '', amount: 0 };
    if (request.settlement === 'cash') return this.settleCash(request, original, master, progress);
    return this.settlePrepaid(request, progress);
  }

  /**
   * 这次售后的钱写「收款明细」：**交易方式 = 她实际说的那个**（业务负责人 2026-10-06 定，见 AGENTS.md 第 16 条(2)）。
   *
   * ⭐ 为什么不再无条件沿用原单：她说「钱退现金」，账上却写成微信 —— 这是记错账。
   *    「说了现金就写现金」。
   *
   * ⚠️ **区别**（这一版之前是**无条件**取原单，所以要写清）：
   *   · `request.paymentMethod` 有值（她在原话里说了"现金/微信/…"）→ 用**她说的那个**，
   *     并在「收款方式管理」里查它的 record_id（查不到就当场抛，**绝不**偷偷换回原单的方式）；
   *   · `request.paymentMethod` 为空（她**没说**方式）→ **沿用原单的方式**（现有逻辑，保持不变）。
   *
   * ⭐ `methodId` 算好后**两个分支共用**（新建 / 断点续做的核验），所以续做时核验的也是同一个方式。
   */
  async settleCash(request, original, master, progress) {
    const fields = this.tableOf('paymentRecord').fields;
    const amount = Math.abs(request.diffAmount);
    const direction = request.diffAmount > 0
      ? this.config.moneyDirections.RECEIVE
      : this.config.moneyDirections.REFUND;
    // 她说了 → 用她说的；没说 → 沿用原单的。
    // 溯源写进日志（`after_sales.executed` / 结果对象），排查"账上为什么是这个方式"一眼能看到。
    const spokenMethodId = request.paymentMethod
      ? (await this.references.resolvePaymentMethod(request.paymentMethod))?.recordId || ''
      : '';
    const methodId = spokenMethodId || original.paymentMethodRecordId || '';
    const methodSource = spokenMethodId ? 'spoken' : (methodId ? 'original' : '');
    if (progress.payment_record_id) {
      await this.verifyPayment(progress.payment_record_id, { amount, direction, methodId }, fields);
      return {
        route: 'cash', recordId: progress.payment_record_id, direction, amount, changeType: '',
        methodId, methodSource,
      };
    }
    if (!methodId) {
      throw new Error('原单没有可用的收款方式，无法登记这次售后收/退款，请先补原单的收款方式');
    }
    const created = await this.gateway.create('paymentRecord', {
      // 关联销售单=新主表：这次收/退款属于售后这条记录，不属于原单。
      salesEntry: relation(master.recordId),
      method: relation(methodId),
      // 收款金额一律正数，方向由「交易方向」表达。
      tradeDirection: direction,
      amount,
      status: this.config.cashPaymentStatus,
      receivedAt: request.occurredAt,
    });
    await this.saveProgress(request, { payment_record_id: created.recordId });
    logInfo('after_sales.cash.method', {
      operation_id: request.operationId,
      // spoken = 写的是她说的方式；original = 她没说、沿用原单。
      method_source: methodSource,
      spoken_payment_method: request.paymentMethod || '',
      payment_record_id: created.recordId,
    });
    return {
      route: 'cash', recordId: created.recordId, direction, amount, changeType: '',
      methodId, methodSource,
    };
  }

  async verifyPayment(recordId, expected, fields) {
    const record = await this.gateway.get('paymentRecord', recordId);
    let mismatch = '';
    if (!record) mismatch = '记录已不存在';
    else if (Number(cellNumber(record.fields?.[fields.amount])) !== Number(expected.amount)) mismatch = '收款金额不一致';
    else if (cellText(record.fields?.[fields.tradeDirection]) !== expected.direction) mismatch = '交易方向不一致';
    else if (expected.methodId && !linkedRecordIds(record.fields?.[fields.method]).includes(expected.methodId)) {
      mismatch = '交易方式不一致';
    }
    if (mismatch) {
      throw new Error(`已记录的售后收款 ${recordId} 与当前请求不一致（${mismatch}），请人工核对，不能自动重试`);
    }
  }

  /**
   * 存预存：钱不进「收款明细」，而是记到「客户往来货款」上（变动类型=退货退款）。
   *
   * 「应收变化」写**带符号的差价**：正=客户还欠我们（要收），负=我们欠客户（要退，转成预存）。
   * 只写正数会把方向丢掉，而这一列正是用来算余额的。
   *
   * 客户字段**留空**：销售主表里没有"客人是谁"这个信息（父代理核对过），
   * 所以不编值、也不从原单取一个不存在的字段；追溯靠「来源单号」。
   */
  async settlePrepaid(request, progress) {
    if (progress.credit_record_id) {
      await this.verifyCredit(progress.credit_record_id, request);
      return {
        route: 'prepaid',
        recordId: progress.credit_record_id,
        direction: request.diffAmount > 0 ? '要收' : '要退',
        amount: Math.abs(request.diffAmount),
        changeType: this.config.prepaidChangeType,
      };
    }
    const { recordId } = await createOnceByKey({
      gateway: this.gateway,
      tableKey: 'customerCredit',
      keyField: AFTER_SALES_CREDIT_KEY_FIELD,
      keyValue: request.eventId,
      label: `客户往来货款（${request.action} ${request.diffAmount}）`,
      values: {
        changeType: this.config.prepaidChangeType,
        receivableChange: request.diffAmount,
        // ⚠️ 2026-10-06：不再写「发生时间」。
        // 业务负责人的口径：时间字段除了「收款时间」以外，飞书里都由自动字段负责
        //（表里的「创建时间」/「更新时间」），代码一律不写时间列。
        // ⚠️ 但这一列在生产真表「客户往来货款」里**还在**，而且是一次性的 DateTime
        // （type=5），不是自动的「创建时间」——所以从此这一列会是空的，等业务负责人
        // 确认是删掉它还是改成自动字段；在那之前 schema 里的映射刻意保留（见 v1BitableSchema）。
        sourceOrderNo: request.originalSalesOrderNo,
        // 这个字段就是这张表的幂等键：本地记录丢了也能按它回查认出这一笔。
        [AFTER_SALES_CREDIT_KEY_FIELD]: request.eventId,
        ...(request.operatorOpenId ? { operator: person(request.operatorOpenId) } : {}),
      },
    });
    await this.verifyCredit(recordId, request);
    await this.saveProgress(request, { credit_record_id: recordId });
    return {
      route: 'prepaid',
      recordId,
      direction: request.diffAmount > 0 ? '要收' : '要退',
      amount: Math.abs(request.diffAmount),
      changeType: this.config.prepaidChangeType,
    };
  }

  async verifyCredit(recordId, request) {
    const fields = this.tableOf('customerCredit').fields;
    const record = await this.gateway.get('customerCredit', recordId);
    let mismatch = '';
    if (!record) mismatch = '记录已不存在';
    else if (cellText(record.fields?.[fields.changeType]) !== this.config.prepaidChangeType) mismatch = '变动类型不一致';
    else if (Number(cellNumber(record.fields?.[fields.receivableChange])) !== Number(request.diffAmount)) {
      mismatch = '应收变化不一致';
    } else if (cellText(record.fields?.[fields.sourceOrderNo]) !== request.originalSalesOrderNo) {
      mismatch = '来源单号不一致';
    } else if (cellText(record.fields?.[fields[AFTER_SALES_CREDIT_KEY_FIELD]]) !== request.eventId) {
      mismatch = '业务事件ID不一致';
    }
    if (mismatch) {
      throw new Error(
        `已记录的客户往来货款 ${recordId} 与当前请求不一致（${mismatch}）：` +
        '同一批原明细只允许一笔，请人工核对，不能自动重试',
      );
    }
  }

  /** 「客户往来货款」的幂等键必须是真实存在的文本列（数字/关联字段存不下 after_sales:... 这种键）。 */
  async validateCreditKey() {
    if (!this.creditSchemaValidated) {
      const table = this.tableOf('customerCredit');
      if (!table?.tableId) throw new Error('「客户往来货款」未配置 table_id，无法登记预存退款');
      if (!table.fields?.[AFTER_SALES_CREDIT_KEY_FIELD]) {
        throw new Error(`「${table.tableName}」未在 v1BitableSchema 声明「业务事件ID」字段，无法做幂等写入`);
      }
      this.creditSchemaValidated = validateIdempotencyKeyFields({
        gateway: this.gateway,
        tables: [{ tableKey: 'customerCredit', keyField: AFTER_SALES_CREDIT_KEY_FIELD }],
      }).catch((error) => {
        this.creditSchemaValidated = null;
        throw new Error(`客户往来货款的幂等写入依赖「业务事件ID」文本列：${error.message}`);
      });
    }
    return this.creditSchemaValidated;
  }

  // --- 5) + 6) 库存流水 / 实时库存：交给既有 InventoryService ------------------------

  async applyStock(request, spec, plan) {
    const results = [];
    for (const movement of spec.movements) {
      for (const row of plan.filter((item) => item.kind === movement.source)) {
        if (!row.sellable.tracksInventory) {
          // 配品不跟踪库存（与销售链路一致：配品只记卖了什么、收了多少）。
          logWarn('after_sales.stock.skipped', {
            action: request.action, reason: 'sellable_kind_not_tracked', row_kind: row.kind,
          });
          continue;
        }
        const state = movement.state === 'restockState' ? request.restockState : movement.state;
        const size = (await this.getSizeReferences().resolveLinkedCell(row.sizeCell)).size;
        const sourceRecordId = this.stockSourceRecordIdOf(row);
        // 只调用既有签名：kind=行为编码，方向由「行为管理」+ 库存动作注册表决定，代码不自作主张。
        // 幂等由库存服务自己的 operationId(kind, sourceRecordId) 负责（远端「库存操作键」兜底）。
        const result = await this.inventory.applyChange({
          kind: movement.behaviorCode,
          productRecordId: row.linkRecordId,
          size,
          state,
          quantity: 1,
          sourceRecordId,
          occurredAt: request.occurredAt,
        });
        results.push({
          behaviorCode: movement.behaviorCode,
          state,
          quantity: 1,
          sourceRecordId,
          productRecordId: row.linkRecordId,
          result,
        });
      }
    }
    return results;
  }

  /**
   * 库存流水的「关联销售」指向这次售后的事实行：
   *   · 出货商品 → 它自己的新明细行；
   *   · 退货 → 退回商品的复制明细行（交易类型=销售退货，"这双退回来了"就是它）；
   *   · 换货 → 没有复制明细行（契约里 newLines 才是新增行），所以指向**被换回的原明细行**
   *     （它同时被改成"已换货"，本身就是这次退货事实）。
   */
  stockSourceRecordIdOf(row) {
    if (row.kind === 'new') return row.recordId;
    return row.recordId || row.originalRecordId;
  }
}

module.exports = { AfterSalesService };
