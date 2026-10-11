const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { PaymentService, amount } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService, progressFromRecords, cents } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
// ⭐ 2026-10-11（C）：明细那一行"是鞋还是配品 / 要不要尺码"由**可售品配置**说了算
//    （`config/sellableKinds`），`itemLinkOfDetail` 是既有的事实解析（谁的关联字段有值）。
const { SELLABLE_KINDS } = require('../config/sellableKinds');
const { itemLinkOfDetail } = require('./salesDetailItemFacts');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { logWarn } = require('../utils/logger');

class SalesFollowupService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.progress = options.progress || new SalesProgressService({ gateway: this.gateway });
    // 「尺码」是关联字段：待交付列表里的尺码要走共享解析，不靠关联单元格的显示文本。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences: options.sizeReferences });
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/sales_followup_tasks'), idField: 'task_id',
    });
    // ⭐⭐ 2026-10-11：「卖了样品、没指定门盒」的**待办**（复用既有的 `sample_replacement` 任务，
    //    落在 `data/lark_mvp_tasks`；工作台交付路径本来就在写它）。
    //    ⚠️ 本 service 对它是**只读 + 一个补掉的动作**：订单列表据此挂 `sample_pending`。
    //    用例可注入 `options.samplePending`。
    // eslint-disable-next-line global-require
    const { createSamplePendingService } = require('./samplePendingService');
    this.samplePending = options.samplePending || createSamplePendingService({
      gateway: this.gateway,
      inventory: this.delivery.inventory,
      store: options.sampleTaskStore,
      taskDir: options.sampleTaskDir,
    });
    this.queue = Promise.resolve();
  }

  async listOrders() {
    // ⭐⭐ 2026-10-11：待补样品待办（**一次读表**，与下面几处取数并行不了 —— 它要看明细 id，
    //    但读任务本身与明细无关 ⇒ 先并行发出）。读失败**不打挂整页**：当成"没有待办"+ 一条 warn。
    const pendingSampleTasks = await this.samplePending.listPending().catch((error) => {
      logWarn('workbench.sales.sample_pending.tasks_unreadable', {
        error: error.message, hint: '这一次订单列表里不显示"待补样品"待办，其余照常',
      });
      return [];
    });
    const pendingSampleByDetail = new Map(
      pendingSampleTasks.map((task) => [task.sales_detail_record_id, task]),
    );
    // ⭐ 2026-10-11（C）：「其他配品」这张表是**可选配置**（没配时销售只支持鞋，见
    //    `LarkMvpService.listAccessories` 的注释）。这里先看 tableId 再读 ——
    //    未配置时**跳过**（配品行照样认得出来，只是没有名称），绝不把整页打成 500。
    const accessoryConfigured = Boolean(this.gateway.table?.('accessory')?.tableId);
    const [orders, details, methods, payments, products, accessories] = await Promise.all([
      this.gateway.listAll('salesEntry'), this.gateway.listAll('salesDetail'),
      this.gateway.listAll('paymentMethod'), this.gateway.listAll('paymentRecord'),
      this.gateway.listAll('product'),
      accessoryConfigured ? this.gateway.listAll('accessory') : Promise.resolve([]),
    ]);
    const orderFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const methodFields = this.gateway.table('paymentMethod').fields;
    const productFields = this.gateway.table('product').fields;
    const accessoryFields = this.gateway.table('accessory')?.fields || {};
    const methodById = new Map(methods.map((item) => [item.record_id, textValue(item.fields?.[methodFields.name])]));
    // ⚠️ 这里存的是**记录本身**（不是货号）：2026-10-11（C）起订单列表还要给出**颜色**
    //    （"货品信息 = 货号 / 颜色 / 尺码"），货号与颜色都从这一条记录上取，**零额外请求**。
    const productById = new Map(products.map((item) => [item.record_id, item]));
    const accessoryById = new Map(accessories.map((item) => [item.record_id, item]));
    return {
      methods: [...new Set(methodById.values())].filter(Boolean),
      // ⭐ 「账做完了没有」= 两代字面量都算（见 config/salesStatusDimensions 的 POSTED_VALUES）。
      orders: (await Promise.all(orders.filter((order) => isPosted(postedOf(order, orderFields)))
        .map(async (order) => {
          const orderNo = textValue(order.fields?.[orderFields.orderNo]) || order.record_id;
          try {
            const orderDetails = details.filter((detail) => linkedRecordIds(detail.fields?.[detailFields.salesEntry]).includes(order.record_id));
            const orderPayments = payments.filter((payment) => linkedRecordIds(payment.fields?.[paymentFields.salesEntry]).includes(order.record_id));
            const progress = progressFromRecords(orderDetails, orderPayments, detailFields, paymentFields);
            // ⭐⭐ 2026-10-11：先把明细那一行算完 —— 待补样品待办要拿**明细的 ID + 尺码**去对。
            const detailRows = await Promise.all(orderDetails
                .map(async (detail) => {
                  // ⭐ 2026-10-09（工作台订单列表要"点进去操作"）：
                  //   明细上多带两个**只读的关联 record_id**（货品 / 尺码），页面才能把
                  //   「换货同款换码」「售后指哪一条明细」原样交给既有业务层。
                  //   ⚠️ 纯新增字段：既有字段名与取值一个字节没动（既有用例仍逐条断言）。
                  //
                  // ⭐ 2026-10-11（C）：订单列表三态要按**新判据**分（货品信息 = 货号/颜色/尺码；
                  //   资金信息 = 收款方式 + 至少一笔收款），所以这里再补三样**只读**事实：
                  //     · `kind` / `requires_size` —— 这一行是哪种可售品、要不要尺码
                  //       （判据 = `config/sellableKinds` 的属性，**配品行天然不需要货品信息**）；
                  //     · `color` —— 颜色（货品信息三项之一；配品没有这一列，留空不编）；
                  //     · `accessory` / `accessory_record_id` —— 配品行显示哪一件（「其他配品.名称」）。
                  //   ⚠️ 一个字段都不新造：全部来自既有表与既有可售品配置。
                  const link = itemLinkOfDetail(detail.fields, detailFields);
                  const kind = link ? SELLABLE_KINDS[link.kindKey] : null;
                  // ⚠️ 尺码只有**需要尺码的可售品**才去解析：**配品行本来就没有尺码**，
                  //    照旧无脑解析会抛「尺码关联字段为空」⇒ 整个单被兜底跳过（那是错的）。
                  //    认不出是哪一种可售品的行**沿用既有行为**（大声抛 → 单条兜底跳过 + warn）。
                  let sizeEntry = { size: null, recordId: '' };
                  if (!kind || kind.requiresSize) {
                    sizeEntry = await this.getSizeReferences()
                      .resolveLinkedCell(detail.fields?.[detailFields.size]);
                  }
                  const linkedProduct = link && link.kindKey === 'shoe'
                    ? productById.get(link.recordId) : null;
                  const linkedAccessory = link && link.kindKey !== 'shoe'
                    ? accessoryById.get(link.recordId) : null;
                  return {
                    record_id: detail.record_id,
                    product: linkedProduct
                      ? (textValue(linkedProduct.fields?.[productFields.number]) || linkedProduct.record_id)
                      : '',
                    product_record_id: linkedProduct ? linkedProduct.record_id : '',
                    // 「颜色」：货品信息上的「颜色」列（单选关联，单元格文本就是颜色名）。
                    color: linkedProduct ? textValue(linkedProduct.fields?.[productFields.color]).trim() : '',
                    kind: kind ? link.kindKey : '',
                    // 认不出是哪一种可售品时按"需要货品信息"算（宁可让她补，也不静默放过）。
                    requires_size: kind ? kind.requiresSize : true,
                    accessory: linkedAccessory
                      ? textValue(linkedAccessory.fields?.[accessoryFields.name]).trim() : '',
                    accessory_record_id: linkedAccessory ? linkedAccessory.record_id : '',
                    size: sizeEntry.size,
                    size_record_id: sizeEntry.recordId || '',
                    quantity: 1,
                    delivered_quantity: textValue(detail.fields?.[detailFields.fulfillmentStatus]) === '已交付' ? 1 : 0,
                    fulfillment_status: textValue(detail.fields?.[detailFields.fulfillmentStatus]) || '未交付',
                    actual_amount: textValue(detail.fields?.[detailFields.actualAmount]) === '' ? null : Number(textValue(detail.fields?.[detailFields.actualAmount])),
                  };
                }));
            // ⭐⭐ 待补样品待办 → 每条待办一行：**哪条明细** + 这一款**还有哪些码有门盒**
            //    （她点进去就能选；与群里那条卡片同一个取数实现 `inventoryService.js:1308`）。
            //    ⚠️ 取候选失败**不打断整页**：这一行照给，候选为空 + 一条 warn。
            const samplePendingLines = (await Promise.all(orderDetails.map(async (detail) => {
              const task = pendingSampleByDetail.get(detail.record_id);
              if (!task) return null;
              let candidates = [];
              try {
                // ⚠️ 只列**还有门盒**的码：她选中一个码就是要拿它补 ⇒ 不给"门盒 0 双"的选项
                //    （群里那张卡片列全部码，是因为那边失败后会重发一张 —— 这里直接不给不能选的）。
                candidates = (await this.samplePending.candidatesFor(task.product_record_id,
                  { excludeRecordIds: task.consumed_live_record_ids || [] }))
                  .filter((candidate) => Number(candidate.doorBoxCount || 0) > 0);
              } catch (error) {
                logWarn('workbench.sales.sample_pending.candidates_unreadable', {
                  order_no: orderNo, sales_detail_record_id: detail.record_id, error: error.message,
                });
              }
              const row = detailRows.find((item) => item.record_id === detail.record_id);
              return {
                detail_record_id: detail.record_id,
                product_record_id: task.product_record_id,
                product_number: task.product_number || '',
                size: row?.size ?? null,
                candidates,
              };
            }))).filter(Boolean);
            return {
              record_id: order.record_id,
              order_no: orderNo,
              fulfillment_status: progress.fulfillmentStatus,
              payment_status: progress.paymentStatus,
              receivable_amount: progress.receivableAmount,
              paid_amount: progress.paidAmount,
              pending_amount: progress.pendingAmount,
              platform_pending_amount: progress.platformPendingAmount,
              pending_delivery_quantity: progress.pendingDeliveryQuantity,
              details: detailRows,
              // ⭐⭐ 待补样品待办（**只读字段**；判据在页面那一侧：`sample_pending` 为真 ⇒ 进「待补充」）。
              sample_pending: samplePendingLines.length > 0,
              sample_pending_lines: samplePendingLines,
              payments: orderPayments
                .map((payment) => ({
                  record_id: payment.record_id,
                  amount: Number(textValue(payment.fields?.[paymentFields.amount])),
                  status: textValue(payment.fields?.[paymentFields.status]) || '已收款',
                  received_at: payment.fields?.[paymentFields.receivedAt] || null,
                  method: methodById.get(linkedRecordIds(payment.fields?.[paymentFields.method])[0]) || '',
                })),
            };
          } catch (error) {
            // ⭐ 2026-10-08 小修（业务负责人批准的"小修"）：**单条订单出问题不许整页失败**。
            //   线上事实（2026-10-08 01:41 +8）：一条含「已换货」明细的销售单，让
            //   `GET /api/workbench/sales/orders` 整页 500（event=workbench.sales.orders.failed）。
            //   ⚠️ 语义层的缺口已经堵上（`progressFromRecords` 现在认 `已退货 / 已换货 / 已赔货`，
            //      判据 = config/afterSales.isAfterSalesFulfillment）；这一层管的是**剩下的**
            //      单条数据不自洽（例：收款状态是预期之外的取值、收款超过成交额、尺码关联解析不出来）
            //      —— 跳过该单、如实记一条 warn，其余订单**照常返回**。
            //   ⚠️ **不是静默吞错**：warn 带 `order_no` 与原因；计算器本身照旧大声抛
            //      （预期之外的状态不会在这里被当成已知）。
            logWarn('workbench.sales.orders.order_skipped', {
              order_no: orderNo,
              sales_entry_record_id: order.record_id,
              error: error.message,
              hint: '这一单的数据不自洽，已跳过；其余订单照常返回',
            });
            return null;
          }
        })))
        .filter(Boolean)
        .reverse(),
    };
  }

  /**
   * ⭐⭐ 2026-10-11：**补样品**（工作台 → 销售 → 订单列表 →【待补充】里那条待办）。
   *
   * 她把"卖了样品、没指定门盒"的那一单选一个尺码 ⇒ 那一双 **门盒 → 样品**（**1 双**）。
   * ⚠️ 真正的动作与幂等在 `SamplePendingService.fill` → `InventoryService.promoteToSample`
   *    （**与群卡片共用同一个 `operationId`** ⇒ 跨入口绝不重复挪）。
   */
  async fillSample(input = {}) {
    return this.samplePending.fill({
      detailRecordId: input.detailRecordId,
      size: input.size,
      operatorOpenId: input.operatorOpenId,
      requestId: input.requestId,
      correlation: { request_id: input.requestId },
    });
  }

  async addPayment(input) {
    const work = async () => {
      const requestId = String(input.requestId || '');
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('收款请求缺少有效 request_id');
      const taskId = `payment_${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
      const fingerprint = JSON.stringify([input.salesEntryRecordId, input.method, Number(input.amount), input.operatorOpenId]);
      const existing = await this.store.get(taskId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('request_id 对应的收款内容不一致');
        if (existing.status === 'completed') return existing.result;
        if (existing.status === 'recorded') {
          await this.progress.sync(input.salesEntryRecordId, { paymentRecordIds: [existing.result.recordId] });
          await this.store.update(taskId, { status: 'completed' });
          return existing.result;
        }
        throw new Error('这笔收款结果待核对，请勿重新提交');
      }
      const order = await this.gateway.get('salesEntry', input.salesEntryRecordId);
      const fields = this.gateway.table('salesEntry').fields;
      if (!isPosted(postedOf(order, fields))) throw new Error('销售订单尚未确认入账');
      amount(input.amount);
      const before = await this.progress.forOrder(input.salesEntryRecordId);
      if (before.pendingAmount === null) throw new Error('销售明细尚未填写实收金额，不能计算待收款');
      if (cents(input.amount, '收款金额') > cents(before.pendingAmount, '待收金额')) {
        throw new Error(`本次收款超过待收金额 ￥${before.pendingAmount}`);
      }
      if (!await this.payments.references.resolvePaymentMethod(input.method)) throw new Error('收款缺少支付方式');
      const pending = (await this.payments.recordsForSale(input.salesEntryRecordId)).filter((record) =>
        textValue(record.fields?.[this.gateway.table('paymentRecord').fields.status]) === '未收款');
      if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');
      if (pending.length && cents(input.amount, '收款金额') !== cents(
        textValue(pending[0].fields?.[this.gateway.table('paymentRecord').fields.amount]), '待收记录金额')) {
        throw new Error('本版请一次收清这条待收款记录；分笔补款暂不支持');
      }
      await this.store.create({ task_id: taskId, fingerprint, status: 'pending' });
      const result = pending.length
        ? { recordId: pending[0].record_id } : { recordId: (await this.payments.record(input)).recordId };
      if (pending.length) await this.payments.collectPendingReceipt(result.recordId, input);
      await this.store.update(taskId, { status: 'recorded', result });
      await this.progress.sync(input.salesEntryRecordId, { paymentRecordIds: [result.recordId] });
      await this.store.update(taskId, { status: 'completed', result });
      return result;
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * ⭐⭐ 2026-10-11（业务负责人选"方案甲"之后的**补充入口**）：工作台【订单列表】里**逐件补实收**。
   *
   * 为什么必须有一条**新的窄写入路径**（先只读核过）：全仓**没有**任何函数能改已写入明细的
   * 「实收金额」——`salesOrderService.confirm` 是"只建不改"（`:184` 要求逐行金额相等、
   * 不等就抛「与当前草稿不一致，已停止重试」），`salesDetail` 的两处 update 只写「履约状态」。
   *
   * 🔴 **两条红线**（都在**写任何一个字节之前**判）：
   *   ① **改后实收合计不许小于已收合计** —— 否则读侧 `salesProgressService.js:74-76`
   *      的"已收 > 实收 ⇒ 抛错"会让**这一单在订单列表里整单读不出来**（她 2026-10-08 报过的形态）。
   *      ⚠️ 只要有**任何一件**实收还是空、而已收 > 0 ⇒ 也算"算不出来" ⇒ 拦住。
   *   ② **同步那条【未收款】的金额**（= 改后实收合计 − 已收合计）—— 否则下一步"补收款"会按
   *      **旧差额**去"一次收清"，两边对不上 ⇒ 补款直接报错（`addPayment` 的既有判据）。
   *
   * ⚠️ **留空的件 = 这一件先不动**（不是"清空"）：服务端只写她真填了的那些。
   * ⚠️ 幂等与 `addPayment` 同一套：一个 `request_id` 一把键（`JsonTaskStore`），重放不写第二遍。
   *
   * @param {{salesEntryRecordId:string, amounts:Array<{detailRecordId:string, amount:string|number}>,
   *          requestId:string, operatorOpenId?:string}} input
   */
  async updateDetailAmounts(input) {
    const work = async () => {
      const requestId = String(input.requestId || '');
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('补实收请求缺少有效 request_id');
      const taskId = `detail_amount_${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 24)}`;
      const targets = (Array.isArray(input.amounts) ? input.amounts : [])
        .map((entry) => ({
          detailRecordId: String(entry?.detailRecordId || '').trim(),
          raw: String(entry?.amount ?? '').trim(),
        }))
        .filter((entry) => entry.raw !== '');
      const fingerprint = JSON.stringify([
        input.salesEntryRecordId,
        targets.map((entry) => [entry.detailRecordId, entry.raw]),
      ]);
      const existing = await this.store.get(taskId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new Error('request_id 对应的补实收内容不一致');
        if (existing.status === 'completed') return existing.result;
        throw new Error('这次补实收结果待核对，请勿重新提交');
      }
      if (!targets.length) throw new Error('还没有要补的实收金额');

      const order = await this.gateway.get('salesEntry', input.salesEntryRecordId);
      if (!order) throw new Error('销售订单不存在');
      const fields = this.gateway.table('salesEntry').fields;
      if (!isPosted(postedOf(order, fields))) throw new Error('销售订单尚未确认入账');

      const detailFields = this.gateway.table('salesDetail').fields;
      const details = (await this.gateway.listAll('salesDetail'))
        .filter((record) => linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(input.salesEntryRecordId));
      if (!details.length) throw new Error('这一张销售单没有明细');

      // ① 她填的那几件：必须属于这一张单、必须是大于 0 的两位小数金额。
      const wanted = new Map();
      for (const entry of targets) {
        if (!details.some((record) => record.record_id === entry.detailRecordId)) {
          throw new Error('要补的明细不属于这一张销售单');
        }
        if (!/^\d+(\.\d{1,2})?$/.test(entry.raw) || Number(entry.raw) <= 0) {
          throw new Error('实收金额要填大于 0 的数字（最多两位小数）');
        }
        wanted.set(entry.detailRecordId, Math.round(Number(entry.raw) * 100) / 100);
      }

      // ② 改后每一件的实收：她填了的用新值；**没填的沿用原值**（原值也可能是空 ⇒ 算不出来）。
      const amountOf = (record) => {
        const text = textValue(record.fields?.[detailFields.actualAmount]).trim();
        return text === '' ? null : Number(text);
      };
      const after = details.map((record) => ({
        detailRecordId: record.record_id,
        amount: wanted.has(record.record_id) ? wanted.get(record.record_id) : amountOf(record),
      }));
      const before = await this.progress.forOrder(input.salesEntryRecordId);
      const paidCents = Math.round(Number(before.paidAmount || 0) * 100);
      const unknown = after.filter((item) => item.amount === null || !Number.isFinite(item.amount));
      const totalCents = unknown.length
        ? null
        : after.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
      // 🔴 红线①
      if (totalCents === null) {
        if (paidCents > 0) {
          throw new Error(`这一单还有 ${unknown.length} 件没填实收金额，算不出够不够已经收到的钱；请一起填上`);
        }
      } else if (totalCents < paidCents) {
        throw new Error(`改完实收合计 ￥${totalCents / 100} 比已经收到的 ￥${paidCents / 100} 还少，请先核对`);
      }

      // ③ 那条【未收款】的现状（多条 ⇒ 人工核对；同一条要同步金额）—— 也在写之前查完。
      const statusField = this.gateway.table('paymentRecord').fields.status;
      const amountField = this.gateway.table('paymentRecord').fields.amount;
      const pendingRows = (await this.payments.recordsForSale(input.salesEntryRecordId))
        .filter((record) => textValue(record.fields?.[statusField]) === '未收款');
      if (pendingRows.length > 1) throw new Error('存在多条待收款记录，请先人工核对');

      await this.store.create({ task_id: taskId, fingerprint, status: 'pending' });
      const changed = [];
      for (const [detailRecordId, value] of wanted.entries()) {
        await this.gateway.update('salesDetail', detailRecordId, { actualAmount: value });
        changed.push({ record_id: detailRecordId, actual_amount: value });
      }
      // 🔴 红线②：差额（≥ 0）同步进那条【未收款】——下一步"补收款"才收得清。
      let owed = null;
      if (pendingRows.length === 1 && totalCents !== null) {
        const nextOwed = Math.max(0, totalCents - paidCents) / 100;
        await this.gateway.update('paymentRecord', pendingRows[0].record_id, { amount: nextOwed });
        owed = { record_id: pendingRows[0].record_id, amount: nextOwed };
      }
      const result = {
        changed,
        owed,
        total_amount: totalCents === null ? null : totalCents / 100,
        paid_amount: paidCents / 100,
      };
      await this.store.update(taskId, { status: 'completed', result });
      return result;
    };
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

module.exports = { SalesFollowupService };
