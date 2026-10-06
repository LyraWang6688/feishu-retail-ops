const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { PaymentService, amount } = require('./paymentService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SalesProgressService, progressFromRecords } = require('./salesProgressService');
const { asDate, isWithinLookupWindow, shanghaiDayKey } = require('./saleLookupService');
const { resolvePurchaseChatId } = require('../config/groupPurchase');
const { postedOf, isPosted } = require('../config/salesStatusDimensions');
const { secondDeliveryCard, settleSecondDeliveryOrder } = require('../utils/larkCards');
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { logInfo, logWarn } = require('../utils/logger');

// 「第二次交付」= 已入账之后的那次收尾：把还没收到的钱收掉、把还没交的货交掉。
//
// 一句话业务口径（业务负责人逐字说的）：未付单第一次录单时货已经交付、库存已经扣过，
// 点「成交」**只补收款**；预付单第一次录单时货还没拿走，点「成交」要
// ① 明细未交付 → 已交付 ② 补收款 ③ 扣库存流水与实时库存。
//
// ⚠️ 这个类**不自己实现任何库存或收款逻辑**：
//   · 收款走 PaymentService.collectPendingReceipt（"补收款"专用，校验必须是未收款、金额必须等于该记录）；
//   · 交付与扣库存走 SalesDeliveryService.deliver（全仓唯一的销售扣库存入口）。
// 它只负责"先收钱、再交货"这个**顺序**和"哪些单要提醒"这个**筛选**。

// 定时推送只看这两类交易类型（行为编码，见 config/salesMovements）。
// 现货当场钱货两清，不进提醒；退货 / 换货那些行为编码不是交易类型，也不进。
const REMINDER_TRADE_TYPE_CODES = Object.freeze(['SALE_UNPAID', 'SALE_PREPAID']);

// 「最近 7 天」：今天 + 往前 6 个上海自然日（复用查找链路的窗口口径，含边界）。
const REMINDER_WINDOW_DAYS = 7;

// 「每日只推一次」的认领键。⚠️ 只有这一层：业务负责人明确否掉了"按单只推一次"
// （"只要他还在 7 天范围内，你就继续发"），所以同一笔单**跨天照发**，不做任何按单标记。
const dayMarkerId = (dayKey) => `reminder_day_${dayKey}`;

class SecondDeliveryService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.payments = options.payments || new PaymentService({ gateway: this.gateway });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.progress = options.progress || new SalesProgressService({ gateway: this.gateway });
    // 发群卡片用的飞书 client：网关本来就持有一个（app 凭证建的），默认复用它，
    // 不再为发一条消息另建一个 client。
    this.client = options.client || this.gateway.client;
    // 群 id：测试可以注入；**不注入（undefined）时按 config/groupPurchase 的规则每次现读
    // 环境变量**（未配置返回空串，调用方据此跳过发送并记日志，绝不回落到私聊）。
    // 显式传空串 = "就是没有群"，同样跳过。
    this.chatId = options.chatId;
    // 幂等记录只用在这一处：定时推送的**按天认领**（见 sendDailyReminder）。
    // 「成交」本身的幂等由底层两个复用方法保证（未收款状态 + 已交付状态），不需要多一层。
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/second_delivery_reminder'), idField: 'task_id',
    });
    // 同一张单连点两次「成交」排成一前一后：第二次进来时状态已经是已收款 / 已交付，
    // 会走到"这一单已成交"那条分支，而不是各写一遍。
    this.queue = new KeyedSerialQueue();
    this.reminderRun = Promise.resolve();
  }

  /**
   * 「成交」：补收款 + 交付。卡片按钮一次点击的全部后端动作都在这里。
   *
   * 顺序是**先收钱、再交货**：钱没记上就不该把货记成已交付（预付单的货是收了钱才给）。
   * 任一步失败会向上抛，卡片回调层把她能看懂的原因回给她；底层两个写操作都是幂等的，
   * 所以她照着原卡片再点一次是安全的。
   *
   * `cardMessageId` / `reminderDay` 是卡片回调带上来的（点的是哪条群消息、哪天的卡），
   * 成交成功后用它们把那张卡的这一单变灰，见 markCardSettled。
   */
  confirm(input = {}) {
    const salesEntryRecordId = String(input.salesEntryRecordId || '').trim();
    if (!salesEntryRecordId) throw new Error('成交缺少销售主表 record_id');
    return this.queue.run(salesEntryRecordId, () => this._confirm({ ...input, salesEntryRecordId }));
  }

  async _confirm({ salesEntryRecordId, method, operatorOpenId, cardMessageId, reminderDay, settledAt }) {
    await this.gateway.validateTables?.(['salesEntry', 'salesDetail', 'paymentRecord']);
    const entryFields = this.gateway.table('salesEntry').fields;
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry) throw new Error('销售主表记录不存在');
    if (!isPosted(postedOf(entry, entryFields))) throw new Error('销售订单尚未确认入账');

    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const [allDetails, allPayments] = await Promise.all([
      this.gateway.listAll('salesDetail'), this.gateway.listAll('paymentRecord'),
    ]);
    const orderDetails = allDetails.filter((record) =>
      linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(salesEntryRecordId));
    const orderPayments = allPayments.filter((record) =>
      linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(salesEntryRecordId));

    const pending = orderPayments.filter((record) =>
      textValue(record.fields?.[paymentFields.status]) === '未收款');
    // 只把**未交付**的明细交给交付服务。未付单的明细在第一次录单时就已是「已交付」，
    // 这里天然是空列表——所以这条链路根本走不到扣库存那一步，不存在"扣两次"。
    const undeliveredIds = orderDetails
      .filter((record) => textValue(record.fields?.[detailFields.fulfillmentStatus]) !== '已交付')
      .map((record) => record.record_id);

    if (pending.length > 1) throw new Error('存在多条待收款记录，请先人工核对');
    if (!pending.length && !undeliveredIds.length) {
      // 两次点击、或者钱和货都齐了：不重复写，回一句可判断的结果。
      // ⚠️ 这里也要把卡片变灰：那一单**已经是成交状态**了，不该留在"能点"的样子上。
      // （正常路径上第一次点击就变灰了，走不到这儿；能走到，说明上次 patch 失败了，
      //   这里是那张卡唯一一次自愈的机会。）
      await this.markCardSettled({ reminderDay, cardMessageId, salesEntryRecordId, settledAt });
      return {
        salesEntryRecordId, alreadyCompleted: true, method,
        collectedPaymentIds: [], collectedAmount: 0, delivery: null, progress: null,
      };
    }

    // ① 只补收款：那条「未收款」→「已收款」，收款时间 = 点击时间。
    //    金额**原样取记录上的数**，不在这里算差额（collectPendingReceipt 自己会校验相等）；
    //    收款方式必须由点击带上来，缺了就报错——不能替她猜一个方式写进账里。
    const collectedIds = [];
    let collectedCents = 0;
    for (const record of pending) {
      const raw = textValue(record.fields?.[paymentFields.amount]);
      await this.payments.collectPendingReceipt(record.record_id, {
        salesEntryRecordId, amount: raw, method, receivedAt: Date.now(),
      });
      collectedIds.push(record.record_id);
      collectedCents += Math.round(amount(raw) * 100);
    }

    // ② 交付：有未交付明细才交给 deliver（它写「已交付」+ 扣库存流水 + 扣实时库存，
    //    并在内部同步「订单状态」）。没有未交付明细时只做进度同步，一样不碰库存。
    let deliveryResult = null;
    let progress = null;
    if (undeliveredIds.length) {
      deliveryResult = await this.delivery.deliver({
        salesEntryRecordId, detailRecordIds: undeliveredIds, paymentRecordIds: collectedIds,
      });
    } else {
      progress = await this.progress.sync(salesEntryRecordId, { paymentRecordIds: collectedIds });
    }

    const result = {
      salesEntryRecordId,
      alreadyCompleted: false,
      method,
      collectedPaymentIds: collectedIds,
      collectedAmount: collectedCents / 100,
      delivery: deliveryResult,
      progress,
    };
    // ③ 成交写完了 → 把被点的那张卡的这一单变灰（只换成一行说明，别处不动）。
    //    ⚠️ 交付只成了一半时**绝不能变灰**：灰了她就没法再点，那几双没交出去的货
    //    就永远卡在"看起来已经处理完"的卡片上了。钱货都齐（failedCount === 0）才变灰。
    if (!(deliveryResult?.failures?.length)) {
      await this.markCardSettled({ reminderDay, cardMessageId, salesEntryRecordId, settledAt });
    }
    logInfo('sales.second_delivery.completed', {
      sales_entry_record_id: salesEntryRecordId,
      operator_open_id: operatorOpenId || '',
      method: method || '',
      collected_payment_ids: collectedIds,
      collected_amount: result.collectedAmount,
      delivered_detail_ids: undeliveredIds,
      delivery_failed_count: deliveryResult?.failures?.length || 0,
      fulfillment_status: deliveryResult?.fulfillmentStatus || progress?.fulfillmentStatus || '',
      order_status: progress?.orderStatus || '',
    });
    return result;
  }

  /**
   * 把被点的那张提醒卡片上的这一单改成「已成交」：只把那一单的按钮换成一行灰字
   * （渲染规则见 larkCards.settleSecondDeliveryOrder），卡片其余内容原样保留。
   *
   * 为什么必须读"当初发出去的那张卡"来改：patch 是**整张卡替换**，只有拿原卡来改，
   * 才能保证其他单的明细和按钮一个字都不变。所以发卡时把卡一起落在当天的认领记录里
   * （见 _sendDailyReminder），这里按按钮带回来的 `reminder_day` 取回来。
   *
   * ⚠️ 这个方法**永远不会抛、也永远不改成交结果**：账这时已经写完了，卡片只是呈现层，
   * 更新失败最多是那张卡还能点（再点会被幂等挡成"已经成交"），绝不能反过来把成交弄失败。
   * 失败只记一条 warn，排查时能看到是"卡片没变灰"而不是"成交没成功"。
   */
  async markCardSettled({ reminderDay, cardMessageId, salesEntryRecordId, settledAt } = {}) {
    const meta = {
      day: reminderDay || '', sales_entry_record_id: salesEntryRecordId || '',
      card_message_id: cardMessageId || '',
    };
    try {
      if (!reminderDay) {
        // 老卡片（这次改动之前发出去的）按钮里没有 reminder_day：跳过并记一条，
        // 不猜、也不去扫全部记录找那张卡。
        logWarn('sales.second_delivery.card_settled.skipped', { ...meta, reason: 'missing_reminder_day' });
        return false;
      }
      const day = await this.store.get(dayMarkerId(reminderDay));
      const card = settleSecondDeliveryOrder(day?.card, { salesEntryRecordId, settledAt });
      const messageId = cardMessageId || day?.message_id || '';
      if (!card || !messageId) {
        logWarn('sales.second_delivery.card_settled.skipped', { ...meta,
          reason: messageId ? 'order_not_in_card' : 'missing_message_id' });
        return false;
      }
      // 复用基础设施里那个 patch 封装（larkMvpService / sampleReplacementService 都走它）：
      // im.message.patch 的调用细节与失败日志只该有一处实现。
      const patched = await updateInteractiveCard({
        client: this.client,
        task: { task_id: dayMarkerId(reminderDay), card_message_id: messageId },
        card, stage: 'second_delivery_settled',
        eventPrefix: 'sales.second_delivery.card.update',
      });
      // 把改完的卡写回当天的记录：**一张卡里可能有好几单**，先点的那单已经灰了，
      // 再点同卡里另一单时必须基于"这张已经改过的卡"继续改；否则会拿最初那张卡整张替换，
      // 把先灰掉的那单又变回能点（而且那条已经成交的收款不会再走一遍）。
      if (patched) {
        await this.store.update(dayMarkerId(reminderDay), { card }).catch((error) => {
          logWarn('sales.second_delivery.card_settled.store_failed', { ...meta, error: error.message });
        });
      }
      return patched;
    } catch (error) {
      logWarn('sales.second_delivery.card_settled.failed', { ...meta, error: error.message });
      return false;
    }
  }

  /**
   * 候选单：最近 7 天里「未付 / 预付」且**尚未完成履约**的已入账销售单。
   *
   * 「尚未完成履约」的判据是"我们交货、用户付钱"这两件事有没有都做到，
   * 也就是进度里的「订单状态」还没到「已完成」——货没交完算没完成，钱没收清算没完成。
   * 进度是**现算**的（复用销售进度那套纯函数），不看主表上可能过期的派生值。
   */
  async listPendingDeliveries({ now = new Date() } = {}) {
    const [entries, allDetails, allPayments, behaviors] = await Promise.all([
      this.gateway.listAll('salesEntry'), this.gateway.listAll('salesDetail'),
      this.gateway.listAll('paymentRecord'), this.gateway.listAll('behavior'),
    ]);
    const entryFields = this.gateway.table('salesEntry').fields;
    const detailFields = this.gateway.table('salesDetail').fields;
    const paymentFields = this.gateway.table('paymentRecord').fields;
    const behaviorFields = this.gateway.table('behavior').fields;

    // 「交易类型」是关联「行为管理」的字段，所以先把两类行为的 record_id 找出来。
    const behaviorLabels = new Map(behaviors
      .filter((record) => REMINDER_TRADE_TYPE_CODES.includes(textValue(record.fields?.[behaviorFields.code])))
      .map((record) => [record.record_id, textValue(record.fields?.[behaviorFields.name]) || '']));

    const orders = [];
    for (const entry of entries) {
      if (!isPosted(postedOf(entry, entryFields))) continue;
      const tradeTypeIds = linkedRecordIds(entry.fields?.[entryFields.tradeType]);
      const tradeTypeRecordId = tradeTypeIds.find((id) => behaviorLabels.has(id));
      if (!tradeTypeRecordId) continue;
      const orderDetails = allDetails.filter((record) =>
        linkedRecordIds(record.fields?.[detailFields.salesEntry]).includes(entry.record_id));
      const orderPayments = allPayments.filter((record) =>
        linkedRecordIds(record.fields?.[paymentFields.salesEntry]).includes(entry.record_id));
      // 「这一单是哪天的」：明细「销售日」优先，退回主表「录单日」——和查单链路
      // （saleLookupService）用同一条口径，两边不能对同一张单给出两个日期。
      // ⚠️ 两个都读不到时必须**大声跳过**：悄悄按"太老了"处理会让这张单永远收不到提醒，
      // 属于最难查的静默失效。
      const detailDates = orderDetails
        .map((record) => asDate(record.fields?.[detailFields.soldAt]))
        .filter(Boolean);
      const orderDate = detailDates.length
        ? new Date(Math.min(...detailDates.map((date) => date.getTime())))
        : asDate(entry.fields?.[entryFields.recordedAt]);
      if (!orderDate) {
        logWarn('sales.second_delivery.reminder.order_skipped', {
          sales_entry_record_id: entry.record_id, reason: 'no_sale_date',
          hint: '「销售日」和「录单日」都读不到，无法判断是否在最近 7 天内',
        });
        continue;
      }
      // 「最近 7 天」按上海自然日算（线上服务器是 UTC，用本地时区会把凌晨的单算错一天）。
      if (!isWithinLookupWindow(orderDate, { now, days: REMINDER_WINDOW_DAYS })) continue;
      let progress;
      try {
        progress = progressFromRecords(orderDetails, orderPayments, detailFields, paymentFields);
      } catch (error) {
        // 单条数据不自洽（比如收款超过成交额）不能让整轮提醒挂掉：
        // 跳过它、大声记一条，其余单照推。
        logWarn('sales.second_delivery.reminder.order_skipped', {
          sales_entry_record_id: entry.record_id, error: error.message,
        });
        continue;
      }
      if (progress.orderStatus === '已完成') continue;
      orders.push({
        salesEntryRecordId: entry.record_id,
        orderNo: textValue(entry.fields?.[entryFields.orderNo]) || entry.record_id,
        tradeTypeLabel: behaviorLabels.get(tradeTypeRecordId),
        saleDate: orderDate.toISOString(),
        pendingAmount: progress.pendingAmount,
        platformPendingAmount: progress.platformPendingAmount,
        pendingDeliveryQuantity: progress.pendingDeliveryQuantity,
        quantity: progress.quantity,
        fulfillmentStatus: progress.fulfillmentStatus,
        paymentStatus: progress.paymentStatus,
      });
    }
    // 最早的单排最前：越久没成交的越该先被看见。
    return orders.sort((left, right) => String(left.saleDate).localeCompare(String(right.saleDate)));
  }

  async paymentMethodNames() {
    const fields = this.gateway.table('paymentMethod').fields;
    const records = await this.gateway.listAll('paymentMethod');
    return [...new Set(records
      .map((record) => textValue(record.fields?.[fields.name]).trim())
      .filter(Boolean))];
  }

  /**
   * 发一张**群卡片**。段与 purchaseWebhookService 的 sendText / sendImage 是同一段：
   * `params: { receive_id_type: receiveIdType }` 参数化，群聊传 chat_id，不写死 open_id。
   * 群 id 来自 PURCHASE_CHAT_ID（config/groupPurchase，未配置返回空串）。
   */
  async sendCardToChat(card) {
    const chatId = this.chatId === undefined ? resolvePurchaseChatId() : this.chatId;
    if (!chatId) {
      // 没配群 = 不知道发哪儿。绝不回落到发给某个人（业务负责人明确说"不用再看经办人了"）。
      logWarn('sales.second_delivery.reminder.chat_missing', {
        env: 'PURCHASE_CHAT_ID', hint: '未配置成交提醒群 id，本次不推送',
      });
      return '';
    }
    if (!this.client?.im?.message?.create) throw new Error('成交提醒缺少飞书 client，无法发送群卡片');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`发送成交提醒卡片失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  /** 每日推送。定时器每个 tick 都会调它，能不能真跑由"今天推过没有"决定。 */
  sendDailyReminder({ now = new Date() } = {}) {
    // interval 可能在上一次还没跑完时又触发（比如网关变慢）：串行化，
    // 免得同一天两次扫描并发跑，把"按天只推一次"判成都没推过。
    const next = this.reminderRun.then(
      () => this._sendDailyReminder({ now }),
      () => this._sendDailyReminder({ now }),
    );
    this.reminderRun = next.catch(() => undefined);
    return next;
  }

  async _sendDailyReminder({ now }) {
    const dayKey = shanghaiDayKey(now);
    const dayTaskId = dayMarkerId(dayKey);
    // 防「同一天因为重启 / 重复轮询而发两遍」的**唯一一层：按天认领**。这一天只要已经有
    // 记录（无论成败），这个 tick 就什么都不做——线上 PM2 reload 之后 interval 会立刻
    // 再 tick 一次，靠它挡住第二次推送。
    //
    // ⚠️ 业务负责人明确否掉了"按单只推一次"：「只要他还在 7 天的时间范围内，你就继续发」。
    // 所以**没有按单标记**：同一笔单只要还在窗口里且还没成交，**每天都会重新进候选、
    // 每天都会再发一次**。这一层防的不是"同一笔推第二遍"，而是"同一天推第二遍"。
    //
    // 为什么先落记录再发、而不是发完再落：崩溃在"已认领、还没发出去"之间只会
    // **少推一次**（这一天没有卡，第二天照常进候选，可自愈），而不会重复刷屏。
    // 反过来的顺序在同一个崩溃点会产生第二张卡。
    if (await this.store.get(dayTaskId)) {
      logInfo('sales.second_delivery.reminder.skipped', { day: dayKey, reason: 'already_ran_today' });
      return { day: dayKey, skipped: true, pushedOrderCount: 0, reason: 'already_ran_today' };
    }
    await this.store.create({ task_id: dayTaskId, day: dayKey, status: 'running' });
    try {
      // 候选就是**全部**要推的单：没有任何"推过就跳过"的过滤（跨天照发）。
      const candidates = await this.listPendingDeliveries({ now });
      if (!candidates.length) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_pending_order' });
        logInfo('sales.second_delivery.reminder.empty', { day: dayKey, candidate_count: 0 });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_pending_order' };
      }
      // 没有收款方式 = 卡片上的「成交」按钮没法表达"这笔钱是怎么收的"。
      // 宁可今天不推并大声记日志，也不能替她猜一个方式写进收款明细；
      // 配置好之后的第二天会照常推。
      const methods = await this.paymentMethodNames();
      if (!methods.length) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_payment_method' });
        logWarn('sales.second_delivery.reminder.methods_missing', {
          day: dayKey, order_count: candidates.length, hint: '「收款方式管理」里没有可选的收款方式，未推送成交卡片',
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_payment_method' };
      }
      // 日期键写进按钮取值（见 larkCards.secondDeliveryCard）：点完之后要靠它把这张卡
      // 取回来改成「已成交」。
      const card = secondDeliveryCard({ orders: candidates, methods, dayKey });
      const messageId = await this.sendCardToChat(card);
      if (!messageId) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_chat' });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_chat' };
      }
      // 卡片本身也存进当天的记录：patch 是整张卡替换，点完变灰时必须拿"当初发出去的
      // 这张卡"来改，才能保证别的单一个字都不变（见 markCardSettled）。
      await this.store.update(dayTaskId, {
        status: 'completed', message_id: messageId, card,
        pushed: candidates.map((order) => order.salesEntryRecordId),
      });
      logInfo('sales.second_delivery.reminder.sent', {
        day: dayKey, order_count: candidates.length,
        order_ids: candidates.map((order) => order.salesEntryRecordId),
        candidate_count: candidates.length, message_id: messageId,
      });
      return { day: dayKey, pushedOrderCount: candidates.length, messageId };
    } catch (error) {
      // 这一天不再重试（按天认领已经落盘），但把失败写进记录里，排查时能看到是哪一步、
      // 哪一天掉的；第二天会重新进候选。
      await this.store.update(dayTaskId, { status: 'failed', error: error.message }).catch(() => undefined);
      logWarn('sales.second_delivery.reminder.failed', { day: dayKey, error: error.message });
      throw error;
    }
  }
}

module.exports = { SecondDeliveryService };
