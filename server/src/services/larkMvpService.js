const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const { larkLogger } = require('../utils/larkLogger');
const doubaoService = require('./doubaoService');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { updateInteractiveCard } = require('../infrastructure/interactiveCardFeedback');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1PostingService } = require('./v1PostingService');
const { createWorkbenchService } = require('./v1WorkbenchService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { SampleReplacementService } = require('./sampleReplacementService');
const { PurchaseDraftBuilder } = require('./purchaseDraftBuilder');
const { PurchaseWebhookService } = require('./purchaseWebhookService');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { LiveInventoryIndex, buildLiveInventoryIndex } = require('./liveInventoryIndex');
const { tradeTypeCodeFromLabel, deliveryForTradeType } = require('../config/salesMovements');
const { isDataNotReady } = require('./salesReadRetry');
const { purchaseConfirmationCard, salesConfirmationCard, salesStatusCard, todaySalesCard } = require('../utils/larkCards');
const { extractSalesMessageText } = require('../utils/larkMessageText');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { getLarkAgentCredentials } = require('../config/larkAgent');

// 交付与否以草稿的交易类型为准：现货/未付当场交付，预付（只付定金、货没拿走）不交付。
// 只有旧数据才没有明确的交付状态（待确认或缺失），那时退回按钮语义——
// 旧卡片上的「确认已交付 / 确认未交付」是用户显式做出的选择。
const shouldDeliverFor = (task, action) => {
  const declared = task?.draft?.delivery_status;
  if (declared === '已交付' || declared === '未交付') return declared === '已交付';
  return action === 'confirm_sale_delivered';
};

const idFor = (prefix, value) =>
  `${prefix}_${crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20)}`;

const parseContent = (content) => {
  try {
    return JSON.parse(content || '{}');
  } catch (_error) {
    return {};
  }
};

const timestamp = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
};

const aggregateRecognizedItems = (items) => {
  const map = new Map();
  for (const item of items) {
    const key = [item.item_no, item.color, item.size].map((value) => String(value || '').trim()).join('|');
    if (!map.has(key)) map.set(key, { ...item, quantity: 0 });
    map.get(key).quantity += Number(item.quantity || 1);
  }
  return [...map.values()];
};

const looksLikeSalesText = (text) => /\d/.test(String(text || ''));

const shanghaiDay = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const dateLabel = `${values.year}-${values.month}-${values.day}`;
  const start = Date.parse(`${dateLabel}T00:00:00+08:00`);
  return { dateLabel, start, end: start + 24 * 60 * 60 * 1000 };
};

class LarkMvpService {
  constructor(options = {}) {
    if (options.client) this.client = options.client;
    else {
      const { appId, appSecret } = getLarkAgentCredentials();
      this.client = new lark.Client({ appId, appSecret, logger: larkLogger });
    }
    this.gateway = options.gateway || new V1BitableGateway({ client: this.client });
    this.references = options.references || new V1ReferenceResolver(this.gateway);
    this.recognizer = options.recognizer || doubaoService;
    this.posting = options.posting || new V1PostingService({ gateway: this.gateway, references: this.references });
    this.delivery = options.delivery || new SalesDeliveryService({ gateway: this.gateway });
    this.draftBuilder = options.draftBuilder || new PurchaseDraftBuilder({ references: this.references });
    this.purchaseWebhooks = options.purchaseWebhooks || new PurchaseWebhookService({
      client: this.client,
      gateway: this.gateway,
      references: this.references,
      recognizer: this.recognizer,
    });
    this.store =
      options.store ||
      new JsonTaskStore({ dir: path.join(__dirname, '../../data/lark_mvp_tasks'), idField: 'task_id' });
    this.sampleReplacements = options.sampleReplacements || new SampleReplacementService({
      gateway: this.gateway, inventory: this.delivery.inventory, store: this.store, client: this.client,
      sendCard: (openId, card) => this.sendCard(openId, card),
      sendText: (openId, message) => this.sendText(openId, message),
      updateCard: (task, event, card, metadata) => this.updateSalesActionCard(task, event, card, metadata),
    });
    this.intakeSchemaValidation = new Map();
    this.senderQueues = new Map();
    this.cardActionQueue = new KeyedSerialQueue();
  }

  enqueueForSender(senderOpenId, work) {
    const previous = this.senderQueues.get(senderOpenId) || Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.senderQueues.set(senderOpenId, next);
    const cleanup = () => {
      if (this.senderQueues.get(senderOpenId) === next) this.senderQueues.delete(senderOpenId);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  async ensureIntakeSchema(scope, tableKeys) {
    if (typeof this.gateway.validateTables !== 'function') return;
    if (!this.intakeSchemaValidation.has(scope)) {
      this.intakeSchemaValidation.set(scope, this.gateway.validateTables(tableKeys));
    }
    return this.intakeSchemaValidation.get(scope);
  }

  async sendText(openId, message) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'text',
        content: JSON.stringify({ text: message }),
      },
    });
    if (response.code !== 0) throw new Error(`发送飞书消息失败: ${response.msg} (Code: ${response.code})`);
  }

  async sendCard(openId, card) {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: {
        receive_id: openId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    if (response.code !== 0) throw new Error(`发送飞书卡片失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  async notifySampleReplacements(deliveryResult, operatorOpenId) {
    return this.sampleReplacements.notifySampleReplacements(deliveryResult, operatorOpenId);
  }

  async sendTodaySales(openId, now = new Date()) {
    const { dateLabel } = shanghaiDay(now);
    const report = await createWorkbenchService(this.gateway).getTodaySales({ date: dateLabel });
    const rows = report.rows.map((row) => ({
      product: row.product_number || '未知编号', size: row.size, quantity: row.quantity,
      amount: row.receivable_amount, paymentMethod: row.payment_method,
    }));
    const totalQuantity = report.summary.quantity;
    const totalAmount = report.summary.paid_amount;
    await this.sendCard(openId, todaySalesCard({ dateLabel, rows, totalQuantity, totalAmount }));
    logInfo('lark.sales.today.sent', {
      operator_open_id: openId,
      date: dateLabel,
      detail_count: rows.length,
      total_quantity: totalQuantity,
      total_amount: totalAmount,
    });
    return { rows, totalQuantity, totalAmount };
  }

  async handleBotMenu(event) {
    const eventKey = event?.event_key || event?.event?.event_key;
    const openId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    if (!openId) throw new Error('机器人菜单事件缺少用户 open_id');
    if (eventKey !== 'query_today_sales') throw new Error(`不支持的机器人菜单事件: ${eventKey}`);
    return this.sendTodaySales(openId);
  }

  async replyText(messageId, message) {
    const response = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'text', content: JSON.stringify({ text: message }) },
    });
    if (response.code !== 0) throw new Error(`回复飞书消息失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  async replyCard(messageId, card) {
    const response = await this.client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw new Error(`回复飞书卡片失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  async updateSalesActionCard(task, event, card, metadata = {}) {
    return updateInteractiveCard({ client: this.client, task, event, card,
      stage: metadata.stage, interactionId: metadata.interactionId,
      eventPrefix: task.type === 'sample_replacement' ? 'lark.sales.sample_card.update' : 'lark.sales.card.update' });
  }

  async publishSalesResultCard(task, event, card, metadata = {}) {
    if (await this.updateSalesActionCard(task, event, card, metadata)) return true;
    try {
      const messageId = await this.sendCard(task.sender_open_id, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      logInfo('lark.sales.card.fallback.sent', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, card_message_id: messageId });
      return true;
    } catch (error) {
      logWarn('lark.sales.card.fallback.failed', { task_id: task.task_id,
        interaction_id: metadata.interactionId, stage: metadata.stage, error: error.message });
      return false;
    }
  }

  async acknowledgeMessage(messageId) {
    const results = await Promise.allSettled([
      this.client.im.messageReaction
        .create({
          path: { message_id: messageId },
          data: { reaction_type: { emoji_type: 'OK' } },
        })
        .then((response) => {
          if (response.code !== 0) {
            throw new Error(`添加飞书表情回复失败: ${response.msg} (Code: ${response.code})`);
          }
        }),
      this.replyText(messageId, '👀 已收到，正在识别销售信息，请稍候…'),
    ]);
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logWarn('lark.sales.acknowledgement.failed', {
          message_id: messageId,
          channel: index === 0 ? 'reaction' : 'reply',
          error: result.reason?.message || String(result.reason),
        });
      }
    });
  }

  async acceptMessage(event) {
    const message = event?.message;
    const senderOpenId = event?.sender?.sender_id?.open_id;
    if (!message?.message_id || !senderOpenId) return { accepted: false, reason: 'missing_identity' };
    if (message.chat_type !== 'p2p') {
      logWarn('lark.mvp.message.ignored', { message_id: message.message_id, reason: 'not_p2p' });
      return { accepted: false, reason: 'not_p2p' };
    }

    if (!['text', 'post'].includes(message.message_type)) {
      await this.sendText(senderOpenId, '机器人当前只接收销售文字；采购请使用采购表单。');
      return { accepted: false, reason: 'unsupported_message_type' };
    }

    const originalText = extractSalesMessageText(message);
    if (!originalText) {
      await this.sendText(senderOpenId, '没有读到销售文字，请发送普通文字或带文字的富文本消息。');
      return { accepted: false, reason: 'empty_sales_text' };
    }
    logInfo('lark.sales.message.normalized', { message_id: message.message_id,
      message_type: message.message_type, sender_open_id: senderOpenId,
      text_length: originalText.length, line_count: originalText.split('\n').length });
    return this.acceptSalesText({ message, senderOpenId, originalText });
  }

  async acceptSalesText({ message, senderOpenId, originalText }) {
    if (!looksLikeSalesText(originalText)) {
      logInfo('lark.message.ignored', {
        message_id: message.message_id,
        sender_open_id: senderOpenId,
        reason: 'not_sales_candidate',
        text_length: originalText.length,
      });
      return { accepted: false, reason: 'not_sales_candidate' };
    }
    const taskId = idFor('sale', message.message_id);
    if (await this.store.get(taskId)) return { accepted: false, reason: 'duplicate', taskId };
    const task = await this.store.create({
      task_id: taskId,
      type: 'sale',
      status: 'received',
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      sent_at: timestamp(message.create_time),
      original_text: originalText,
    });
    logInfo('lark.sales.accepted', {
      task_id: taskId,
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      text_length: originalText.length,
    });
    await this.acknowledgeMessage(message.message_id);
    setImmediate(() =>
      this.enqueueForSender(senderOpenId, () => this.processSalesTask(taskId)).catch((error) =>
        this.handleTaskFailure(taskId, error)
      )
    );
    return { accepted: true, type: 'sale', taskId: task.task_id };
  }

  async acceptPurchaseImage({ message, senderOpenId }) {
    const imageKey = parseContent(message.content).image_key;
    if (!imageKey) throw new Error('采购图片消息缺少 image_key');
    const taskId = idFor('purchase_open', senderOpenId);
    const current = await this.store.get(taskId);
    if (current && ['recognizing', 'needs_info', 'ready_to_confirm', 'posting'].includes(current.status)) {
      await this.sendText(senderOpenId, '当前采购批次尚未完成，请先补充或确认当前批次。');
      return { accepted: false, reason: 'purchase_in_progress', taskId };
    }
    const reusable = current?.status === 'collecting_images';
    const images = reusable ? current.images || [] : [];
    if (images.some((item) => item.message_id === message.message_id)) {
      return { accepted: false, reason: 'duplicate', taskId };
    }
    const next = {
      task_id: taskId,
      type: 'purchase',
      status: 'collecting_images',
      sender_open_id: senderOpenId,
      images: [...images, { message_id: message.message_id, image_key: imageKey, sent_at: timestamp(message.create_time) }],
    };
    if (current) await this.store.update(taskId, next);
    else await this.store.create(next);
    logInfo('lark.purchase.image.accepted', {
      task_id: taskId,
      message_id: message.message_id,
      sender_open_id: senderOpenId,
      image_count: next.images.length,
    });
    await this.sendText(senderOpenId, `已收到第 ${next.images.length} 张采购图片。继续发图，发完后请回复“采购完成”。`);
    return { accepted: true, type: 'purchase_image', taskId };
  }

  async finishPurchaseImages(senderOpenId) {
    const taskId = idFor('purchase_open', senderOpenId);
    const task = await this.store.get(taskId);
    if (!task || task.status !== 'collecting_images' || !task.images?.length) {
      await this.sendText(senderOpenId, '还没有收到待识别的采购图片。');
      return { accepted: false, reason: 'no_open_purchase' };
    }
    await this.store.update(taskId, { status: 'recognizing' });
    setImmediate(() => this.processPurchaseTask(taskId).catch((error) => this.handleTaskFailure(taskId, error)));
    await this.sendText(senderOpenId, `已收到，正在识别 ${task.images.length} 张采购图片。`);
    return { accepted: true, type: 'purchase_finish', taskId };
  }

  /**
   * 「其他配品」清单。没配置这张表时返回空——那种部署下销售只支持鞋，
   * 配品说法会被当成未知货号处理，而不是报配置错误。
   */
  async listAccessories() {
    const table = this.gateway.table?.('accessory');
    if (!table?.tableId) return [];
    try {
      const records = await this.gateway.listAll('accessory');
      return records
        .map((record) => ({
          record_id: record.record_id,
          name: textValue(record.fields?.[table.fields.name]).trim(),
        }))
        .filter((item) => item.name);
    } catch (error) {
      logWarn('lark.sales.accessory.list_failed', { error: error.message });
      return [];
    }
  }

  /**
   * 团购券目录：只取「在售」的券，按「售价 + 面值」匹配结算金额。
   *
   * 读不到就当没有券目录——她对券的说法会落到"未配置该券的结算金额，请补充"的追问上，
   * 而不是拿别的券顶替、写一个错的收款金额。
   */
  async listGroupBuyVouchers() {
    const table = this.gateway.table?.('groupBuyVoucher');
    if (!table?.tableId) return [];
    try {
      const records = await this.gateway.listAll('groupBuyVoucher');
      return records
        .map((record) => ({
          record_id: record.record_id,
          name: textValue(record.fields?.[table.fields.name]).trim(),
          status: textValue(record.fields?.[table.fields.status]).trim(),
          purchasePrice: Number(record.fields?.[table.fields.purchasePrice]),
          faceValue: Number(record.fields?.[table.fields.faceValue]),
          settlementAmount: Number(record.fields?.[table.fields.settlementAmount]),
        }))
        .filter((voucher) => voucher.status === '在售'
          && Number.isFinite(voucher.purchasePrice)
          && Number.isFinite(voucher.faceValue)
          && Number.isFinite(voucher.settlementAmount));
    } catch (error) {
      logWarn('lark.sales.group_buy_vouchers.list_failed', { error: error.message });
      return [];
    }
  }

  /**
   * 读一次「实时库存」，按 `货号 + 尺码` 建索引。
   *
   * 为什么以实时库存为准：它是"店里实际有什么"，「货品信息」只是"配置过什么"。
   * 销售卖的是实物，所以颜色、有没有货、是门盒还是样品，都该从这里回答；
   * 而且一张表读一次就够，不必每双鞋各查一遍货品资料。
   */
  async loadLiveInventoryIndex() {
    const table = this.gateway.table?.('liveInventory');
    if (!table?.tableId) return new LiveInventoryIndex({ records: [] });
    const startedAt = Date.now();
    const records = await this.gateway.listAll('liveInventory');
    const index = buildLiveInventoryIndex({ records, table });
    logInfo('lark.sales.live_inventory.loaded', {
      task_id: null,
      record_count: records.length,
      skipped_records: index.skippedRecords,
      duration_ms: Date.now() - startedAt,
    });
    return index;
  }

  async processSalesTask(taskId) {
    const startedAt = Date.now();
    logInfo('lark.sales.processing.started', { task_id: taskId });
    const task = await this.store.get(taskId);
    // 两张配置表都很小（配品十几条、在售券几条），先并行拿齐：
    // 配品清单交给 AI 是为了让它知道「39元腰带」这类说法不是鞋；
    // 券目录交给后端是为了按表里的平台结算款算钱，不再写死券种。
    const [accessories, vouchers] = await Promise.all([
      this.listAccessories(),
      this.listGroupBuyVouchers(),
    ]);
    // AI 解析是最慢的一段（十几秒），读实时库存不依赖它的结果，所以两件事并行：
    // 读表的时间藏在 AI 后面，不额外增加用户等待。
    const [parsed, liveInventory] = await Promise.all([
      this.recognizer.parseSalesText(task.original_text, {
        taskId, accessoryNames: accessories.map((item) => item.name), vouchers,
      }),
      this.loadLiveInventoryIndex(),
    ]);
    if (parsed.intent !== 'sale') {
      await this.store.update(taskId, { status: 'ignored', draft: parsed });
      logInfo('lark.sales.processing.ignored', {
        task_id: taskId,
        sender_open_id: task.sender_open_id,
        duration_ms: Date.now() - startedAt,
        reason: 'unsupported_intent',
      });
      await this.sendText(task.sender_open_id, '未识别为当前支持的现货销售，未写入销售主表。');
      return;
    }

    await this.ensureIntakeSchema('sales_intake', ['salesEntry']);
    const created = await this.gateway.create('salesEntry', {
      originalText: task.original_text,
      sender: person(task.sender_open_id),
      parseStatus: '解析中',
      confirmStatus: '待确认',
    });
    const salesEntryRecordId = created?.recordId;
    if (!salesEntryRecordId) throw new Error('销售主表未返回 record_id');
    await this.store.update(taskId, { sales_entry_record_id: salesEntryRecordId, status: 'parsing' });

    const missingFields = [...(parsed.missing_fields || [])];
    const items = [];
    for (const [index, item] of (parsed.items?.length ? parsed.items : [parsed]).entries()) {
      const itemQuantity = Number(item.quantity || 1);
      const quantityIssue = `第${index + 1}件请逐双列出成交金额；每条销售明细只能记录一双`;
      if (itemQuantity !== 1 && !missingFields.includes(quantityIssue)) missingFields.push(quantityIssue);
      if (item.kind === 'accessory') {
        // 配品只有名字和金额：按名称在「其他配品」里**精确**查找。
        // 不模糊匹配——「39元腰带」和「49元腰带」只差一个字，模糊就是串货。
        const name = String(item.accessory_name || '').trim();
        const match = accessories.find((candidate) => candidate.name === name);
        if (!match) {
          missingFields.push(`第${index + 1}件：其他配品里没有「${name}」这一件，请核对名称`);
        }
        items.push({ ...item, quantity: itemQuantity, accessory_record_id: match?.record_id || '' });
        continue;
      }
      // 鞋按「实时库存」匹配：颜色、有没有货、是门盒还是样品，都从"店里实际有什么"回答，
      // 而不是先看货品资料——货品资料只是"配置过什么"，卖的是实物。
      let productRecordId = '';
      let color = '';
      let colorOptions = null;
      let stock = null;
      if (item.item_no && item.size) {
        const found = liveInventory.find({ itemNo: item.item_no, size: item.size });
        if (!found.colors.length) {
          // 库存里没有这一双。告诉她这个货号实际有什么尺码，比只说"没找到"有用。
          const inStock = found.otherSizes.length
            ? `这个货号现在有 ${found.otherSizes.map((entry) => `${entry.size}码`).join('、')}`
            : '这个货号在实时库存里一双都没有';
          missingFields.push(`第${index + 1}件：库存里没有 ${item.item_no} ${item.size}码（${inStock}）`);
        } else if (found.colors.length === 1) {
          const [only] = found.colors;
          productRecordId = only.productRecordId;
          color = only.color;
          stock = { doorBox: only.doorBox, sample: only.sample, warehouse: only.warehouse };
        } else {
          // 这个货号在这个尺码上有多个颜色：不猜，把候选交给确认卡片让用户点。
          colorOptions = found.colors.map((entry) => ({
            recordId: entry.productRecordId,
            color: entry.color,
            number: `${item.item_no}${entry.color}`,
            stock: { doorBox: entry.doorBox, sample: entry.sample, warehouse: entry.warehouse },
          }));
        }
      }
      items.push({
        ...item,
        quantity: itemQuantity,
        product_record_id: productRecordId,
        color,
        // 展示用编号：货号 + 颜色——实时库存里就是用这两个要素定位一双鞋。
        product_number: productRecordId ? `${item.item_no}${color}` : '',
        ...(colorOptions ? { needs_color: true, color_options: colorOptions } : {}),
        ...(stock ? { stock } : {}),
      });
    }
    const actualTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount || 0), 0) * 100) / 100;
    if (!parsed.voucher_policy_blocked && items.some((item) => !Number(item.actual_amount))) missingFields.push('请逐件说明成交金额');
    if (parsed.agreed_total && Math.abs(actualTotal - Number(parsed.agreed_total)) > 0.005) {
      missingFields.push('逐件成交金额合计与整单成交金额不一致');
    }
    if (!parsed.voucher_policy_blocked && Number(parsed.total_covered ?? parsed.total_paid ?? 0) > actualTotal) {
      missingFields.push('已收金额和待平台结算金额不能超过本单成交金额');
    }

    // 交易类型由 AI 从原话判断；**交付状态由注册表从交易类型推出来**，
    // 不再让用户在卡片上选。现货/未付当场交付，只有预付（只付定金、货没拿走）是未交付。
    const tradeTypeCode = tradeTypeCodeFromLabel(parsed.trade_type);
    const draft = {
      ...parsed,
      trade_type: parsed.trade_type,
      trade_type_code: tradeTypeCode,
      delivery_status: deliveryForTradeType(tradeTypeCode) || '已交付',
      product_number: items[0]?.product_number || '',
      items,
      missing_fields: missingFields,
    };
    // 交易类型落成关联「行为管理」的记录，便于以后筛选和对账。
    // 解析不到时记警告但**不阻塞入账**：它只是审计字段，业务事实（交付与收款）
    // 已经由 trade_type 决定，不该因为一个关联查不到就让门店录不进单。
    let tradeTypeRecordId = '';
    if (tradeTypeCode && typeof this.references.resolveSalesTradeType === 'function') {
      try {
        tradeTypeRecordId = (await this.references.resolveSalesTradeType(tradeTypeCode)).recordId;
      } catch (error) {
        logWarn('lark.sales.trade_type.resolve_failed', {
          task_id: taskId, code: tradeTypeCode, error: error.message,
        });
      }
    }
    await this.gateway.update('salesEntry', salesEntryRecordId, {
      parseStatus: draft.missing_fields?.length ? '需补充' : '解析成功',
      parseSummary: JSON.stringify(draft),
      failureReason: draft.missing_fields?.length ? draft.missing_fields.join('、') : '',
      ...(tradeTypeRecordId ? { tradeType: relation(tradeTypeRecordId) } : {}),
    });
    await this.store.update(taskId, {
      status: draft.missing_fields?.length ? 'needs_info' : 'ready_to_confirm',
      draft,
    });
    if (draft.missing_fields?.length) {
      await this.sendText(task.sender_open_id, `销售信息还缺：${draft.missing_fields.join('、')}。请补充后重新发送完整销售信息。`);
      return;
    }
    const cardMessageId = await this.replyCard(task.message_id, salesConfirmationCard(taskId, draft));
    if (cardMessageId) await this.store.update(taskId, { card_message_id: cardMessageId });
    logInfo('lark.sales.processing.completed', {
      task_id: taskId,
      sales_entry_record_id: salesEntryRecordId,
      item_count: items.length,
      duration_ms: Date.now() - startedAt,
      result: 'awaiting_confirmation',
    });
  }

  async processPurchaseTask(taskId) {
    const startedAt = Date.now();
    logInfo('lark.purchase.processing.started', { task_id: taskId });
    await this.ensureIntakeSchema('purchase_intake', ['purchaseBatch']);
    const task = await this.store.get(taskId);
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lark-purchase-'));
    const attachments = [];
    const localFiles = [];
    const recognized = [];
    let batchRecordId = '';
    try {
      for (let index = 0; index < task.images.length; index += 1) {
        const image = task.images[index];
        const filePath = path.join(tempDir, `${index + 1}.jpg`);
        const resource = await this.client.im.messageResource.get({
          path: { message_id: image.message_id, file_key: image.image_key },
          params: { type: 'image' },
        });
        await resource.writeFile(filePath);
        localFiles.push(filePath);
        const fileToken = await this.gateway.uploadAttachment(filePath);
        attachments.push({ file_token: fileToken });
      }

      const batch = await this.gateway.create('purchaseBatch', {
        originalImages: attachments,
        sender: person(task.sender_open_id),
        recognitionStatus: '识别中',
        confirmStatus: '待确认',
        arrivalDate: Date.now(),
        messageIds: task.images.map((item) => item.message_id).join('\n'),
      });
      batchRecordId = batch.recordId;
      await this.store.update(taskId, { batch_record_id: batchRecordId });

      for (const filePath of localFiles) {
        const items = await this.recognizer.recognizeLabels(filePath, 'purchase');
        recognized.push(...items);
      }
      await this.gateway.update('purchaseBatch', batchRecordId, {
        recognitionStatus: '识别成功',
        failureReason: '',
      });
    } catch (error) {
      if (batchRecordId) {
        await this.gateway
          .update('purchaseBatch', batchRecordId, {
            recognitionStatus: '识别失败',
            failureReason: error.message,
          })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }

    // PurchaseDraftBuilder 完成：聚合相同SKU → 货品匹配（货号+颜色→完整编号）→ 供应商匹配 → 缺失字段校验
    // 货品匹配提前到这里完成，用户在确认卡上就能看到匹配结果，匹配失败提前知道要去上架
    const draft = await this.draftBuilder.buildDraft(recognized);
    await this.store.update(taskId, {
      status: draft.missing_fields.length ? 'needs_info' : 'ready_to_confirm',
      batch_record_id: batchRecordId,
      draft,
    });
    await this.sendCard(task.sender_open_id, purchaseConfirmationCard(taskId, draft));
    if (draft.missing_fields.length) {
      await this.sendText(task.sender_open_id, '请回复”供应商 XXX，入库单价 100”。如果已付款，可加上”已付款 500，微信”。货品未匹配的请先到货品信息表上架。');
    }
    logInfo('lark.purchase.processing.completed', {
      task_id: taskId,
      purchase_batch_record_id: batchRecordId,
      item_count: draft.items.length,
      missing_field_count: draft.missing_fields.length,
      duration_ms: Date.now() - startedAt,
      result: draft.missing_fields.length ? 'needs_info' : 'awaiting_confirmation',
    });
  }

  async tryCompletePurchaseDraft(senderOpenId, originalText) {
    const taskId = idFor('purchase_open', senderOpenId);
    const task = await this.store.get(taskId);
    if (!task || task.status !== 'needs_info' || !task.draft) return false;
    const supplierMatch = originalText.match(/供应商\s*[:：]?\s*([^,，\s]+)/);
    const priceMatch = originalText.match(/(?:入库单价|单价)\s*[:：]?\s*(\d+(?:\.\d+)?)/);
    const paidMatch = originalText.match(/(?:已付款|付款)\s*[:：]?\s*(\d+(?:\.\d+)?)/);
    const methodMatch = originalText.match(/(微信|支付宝|现金|工商银行)/);
    if (!supplierMatch && !priceMatch && !paidMatch) return false;

    // 从已有 draft 提取原始识别字段，应用用户补充后重新走 DraftBuilder（聚合→货品匹配→供应商匹配→校验）
    // 这样补充供应商后会重新匹配供应商 record_id，补充单价后会重新校验缺失字段
    const recognizedItems = task.draft.items.map((item) => ({
      item_no: item.item_no,
      color: item.color,
      size: item.size,
      quantity: item.quantity,
      unit_cost: priceMatch ? Number(priceMatch[1]) : item.unit_cost,
      supplier: supplierMatch ? supplierMatch[1] : item.supplier,
    }));
    const payment = paidMatch
      ? { amount: Number(paidMatch[1]), method: methodMatch?.[1] || '' }
      : task.draft.payment;

    const draft = await this.draftBuilder.buildDraft(recognizedItems, { payment });
    await this.store.update(taskId, {
      status: draft.missing_fields.length ? 'needs_info' : 'ready_to_confirm',
      draft,
    });
    await this.sendCard(senderOpenId, purchaseConfirmationCard(taskId, draft));
    return true;
  }

  async handleCardAction(event, context = {}) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    if (['choose_sample_replacement', 'refresh_sample_replacement'].includes(action)) {
      return this.sampleReplacements.handleCardAction(value, event, operatorOpenId, context);
    }
    const procurementResult = await this.purchaseWebhooks.handleCardAction(value, operatorOpenId, event);
    if (procurementResult) return procurementResult;
    if (!draftId) throw new Error('卡片缺少草稿 ID');
    return this.cardActionQueue.run(draftId, () => this.handleSalesOrLegacyCardAction(event, context));
  }

  async handleSalesOrLegacyCardAction(event, context = {}) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    const task = await this.store.get(draftId);
    if (!task) throw new Error('确认草稿不存在或已过期');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由原始发送人确认该草稿');
    if (['posted', 'posted_delivery_pending', 'cancelled'].includes(task.status)) {
      if (task.type === 'sale') {
        const completed = task.status === 'posted';
        const card = salesStatusCard(task.draft,
          task.status === 'cancelled' ? '销售录单已取消' : completed ? '销售订单已入账' : '订单已入账，交付待核对',
          task.status === 'cancelled' ? '原草稿不会入账。' :
            `销售单号：${task.posting_result?.sourceNo || '请在销售主表核对'}；${completed
              ? shouldDeliverFor(task, task.posting_requested_action) ? '已交付并扣库存。' : '尚未交付，库存未扣减。'
              : '交付结果尚未确认，请到工作台核对。'}`,
          task.status === 'cancelled' ? 'blue' : completed ? 'green' : 'orange');
        await this.publishSalesResultCard(task, event, card,
          { stage: 'duplicate_terminal', interactionId: context.interactionId });
      }
      return { toast: { type: 'info', content: task.status === 'posted_delivery_pending'
        ? '订单已入账，交付结果请在工作台核对' : '该草稿已处理' } };
    }
    if (task.status === 'posting') return { toast: { type: 'info', content: '正在入账，请勿重复点击' } };
    if (task.status === 'awaiting_correction' && action !== 'cancel') {
      return { toast: { type: 'info', content: '该草稿正在等待修正，请重新发送完整销售信息' } };
    }
    const hasWrittenSaleRecords = task.type === 'sale' && (task.posting_records_written === true ||
      Object.values(task.posting_record_ids || {}).some((ids) => Array.isArray(ids) && ids.some(Boolean)));
    if (hasWrittenSaleRecords && ['cancel', 'modify_sale'].includes(action)) {
      return { toast: { type: 'warning', content: '这张销售单已有明细或收款，不能直接取消或修改；请先核对现有记录' } };
    }
    if (hasWrittenSaleRecords && ['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      task.posting_requested_action && action !== task.posting_requested_action) {
      return { toast: { type: 'warning', content: '请沿用原来的交付选择继续处理这张销售单' } };
    }

    if (action === 'cancel') {
      await this.store.update(draftId, { status: 'cancelled' });
      if (task.type === 'sale' && task.sales_entry_record_id) {
        await this.gateway.update('salesEntry', task.sales_entry_record_id, { confirmStatus: '已取消' });
        await this.publishSalesResultCard(task, event, salesStatusCard(task.draft, '销售录单已取消', '原草稿不会入账。'),
          { stage: 'cancelled', interactionId: context.interactionId });
      }
      if (task.type === 'purchase' && task.batch_record_id) {
        await this.gateway.update('purchaseBatch', task.batch_record_id, { confirmStatus: '已取消' });
      }
      return { toast: { type: 'info', content: '已取消' } };
    }

    if (action === 'modify_sale' && task.type === 'sale') {
      await this.store.update(draftId, { status: 'awaiting_correction' });
      if (task.sales_entry_record_id) {
        await this.gateway.update('salesEntry', task.sales_entry_record_id, { confirmStatus: '待修改' });
      }
      await this.publishSalesResultCard(task, event, salesStatusCard(task.draft, '等待重新发送', '原草稿不会入账；请重新发送完整销售信息。', 'orange'),
        { stage: 'awaiting_correction', interactionId: context.interactionId });
      await this.sendText(operatorOpenId, '请重新发送一条完整、正确的销售信息；原草稿不会入账。').catch((error) =>
        logWarn('lark.sales.feedback.failed', { task_id: draftId, interaction_id: context.interactionId, error: error.message }));
      return { toast: { type: 'info', content: '请重新发送修正后的完整销售信息' } };
    }

    if (action === 'choose_sale_color' && task.type === 'sale') {
      const itemIndex = Number(value.item_index);
      const items = (task.draft?.items || []).map((item) => ({ ...item }));
      const item = items[itemIndex];
      if (!item) throw new Error('找不到要设置颜色的明细');
      if (!value.record_id) throw new Error('卡片里缺少颜色记录 ID');
      // 用户在卡片上选定颜色：这一条明细的货品就此确定，不再需要选色。
      // 库存分布也跟着候选一起带过来——颜色定了，才知道这个颜色在店里有几双。
      const chosen = (item.color_options || []).find((option) => option.recordId === value.record_id);
      items[itemIndex] = {
        ...item,
        product_record_id: value.record_id,
        product_number: value.product_number || item.product_number || item.item_no || '',
        ...(chosen?.stock ? { stock: chosen.stock } : {}),
        needs_color: false,
        color_options: [],
      };
      const draft = { ...task.draft, items };
      await this.store.update(draftId, { draft, status: 'ready_to_confirm' });
      await this.publishSalesResultCard({ ...task, draft }, event, salesConfirmationCard(draftId, draft),
        { stage: 'color_chosen', interactionId: context.interactionId });
      logInfo('lark.sales.color.chosen', { task_id: draftId, item_index: itemIndex,
        product_record_id: value.record_id, color: value.color_name });
      return { toast: { type: 'success', content: `第 ${itemIndex + 1} 双的颜色已设为「${value.color_name || ''}」` } };
    }

    // 颜色是入账的必要信息：还有明细没选颜色就不许确认。卡片上会给出候选让用户点选。
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) &&
      (task.draft?.items || []).some((item) => item.needs_color)) {
      return { toast: { type: 'warning', content: '还有明细没选颜色，请先在卡片上选择颜色，再确认订单' } };
    }

    await this.store.update(draftId, { status: 'posting',
      ...(task.type === 'sale' ? { posting_requested_action: hasWrittenSaleRecords
        ? task.posting_requested_action || action : action } : {}) });
    try {
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
      // 交付与否由**交易类型**决定，不由用户点哪个按钮决定。
      // 卡片上只留一个「确认」；旧卡片上的 confirm_sale_delivered / _pending 仍然兼容。
      const shouldDeliver = shouldDeliverFor(task, action);
      const cardUpdated = await this.updateSalesActionCard(task, event,
        salesStatusCard(task.draft, '销售订单处理中', '已收到确认，正在写入销售记录和收款；请勿重复点击。'),
        { stage: 'processing', interactionId: context.interactionId });
      if (!cardUpdated) await this.sendText(operatorOpenId, '已收到确认，正在写入销售记录和收款，请稍候。').catch((error) =>
        logWarn('lark.sales.feedback.failed', { task_id: draftId, interaction_id: context.interactionId, error: error.message }));
      const startedAt = Date.now();
      const result = await this.posting.postSale({
        salesEntryRecordId: task.sales_entry_record_id,
        knownRecordIds: task.posting_record_ids,
        knownFinancialComplete: task.posting_records_written === true,
        onRecordPersisted: async (kind, index, recordId) => {
          const current = await this.store.get(draftId);
          const ids = { ...(current?.posting_record_ids || {}) };
          const kindIds = [...(ids[kind] || [])];
          kindIds[index] = recordId;
          await this.store.update(draftId, { posting_record_ids: { ...ids, [kind]: kindIds } });
        },
        operatorOpenId,
        paymentMethod: task.draft.payment_method,
        totalPaid: task.draft.total_paid,
        payments: (task.draft.payments || []).map((payment) => ({
          amount: payment.amount, method: payment.method, status: payment.status, operatorOpenId,
        })),
        items: task.draft.items.map((item) => ({
          kind: item.kind,
          productRecordId: item.product_record_id,
          accessoryRecordId: item.accessory_record_id,
          itemNo: item.item_no,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          actualAmount: item.actual_amount,
          gift: item.gift,
          giftDescription: item.gift_description,
        })),
      });
      await this.store.update(draftId, { status: 'posted_delivery_pending', posting_result: result });
      if (shouldDeliver) {
        try {
          const deliveryResult = await this.delivery.deliver({ salesEntryRecordId: task.sales_entry_record_id,
            detailRecordIds: result.detailRecordIds, paymentRecordIds: result.paymentRecordIds });
          await this.notifySampleReplacements(deliveryResult, operatorOpenId).catch((error) =>
            logWarn('lark.sales.sample_notice.failed', { task_id: draftId, error: error.message }));
          if (deliveryResult.failures?.length) {
            await this.store.update(draftId, { delivery_failures: deliveryResult.failures });
            const failedLines = deliveryResult.failures.map((failure) => {
              const item = task.draft.items[failure.lineNumber - 1] || {};
              const label = `${item.product_number || `${item.item_no || '货品'}${item.color || ''}`}${failure.size}码`;
              return `第${failure.lineNumber}双 ${label}：${failure.error}`;
            }).join('；');
            await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
              deliveryResult.deliveredQuantity ? '订单已入账，部分交付' : '订单已入账，交付待处理',
              `销售单号：${result.sourceNo}。已交付 ${deliveryResult.deliveredQuantity}/${deliveryResult.totalQuantity} 双；未交付：${failedLines}。请到工作台待交付列表核对并处理。`, 'orange'),
            { stage: 'delivery_partial', interactionId: context.interactionId });
            logWarn('lark.sales.delivery.partial', { task_id: draftId, source_no: result.sourceNo,
              delivered_quantity: deliveryResult.deliveredQuantity, total_quantity: deliveryResult.totalQuantity,
              failed_detail_ids: deliveryResult.failures.map((failure) => failure.detailRecordId) });
            return { toast: { type: 'warning', content:
              `订单已入账，已交付 ${deliveryResult.deliveredQuantity}/${deliveryResult.totalQuantity} 双；其余待处理` } };
          }
        } catch (error) {
          await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
            '订单已入账，交付待处理', `销售单号：${result.sourceNo}。库存交付未完成：${error.message}。请在工作台待交付列表核对并处理。`, 'orange'),
          { stage: 'delivery_failed', interactionId: context.interactionId });
          logError('lark.sales.delivery.failed', { task_id: draftId, error: error.message });
          return { toast: { type: 'warning', content: '订单已入账，库存交付待处理' } };
        }
      }
      await this.store.update(draftId, { status: 'posted', posting_result: result });
      await this.publishSalesResultCard(task, event, salesStatusCard(task.draft,
        '销售订单已入账', `销售单号：${result.sourceNo}；${result.detailRecordIds?.length || 0} 条明细已写入。${shouldDeliver ? '已交付并扣库存。' : '尚未交付，库存未扣减。'}`, 'green'),
      { stage: 'posted', interactionId: context.interactionId });
      logInfo('lark.sales.posting.completed', {
        task_id: draftId,
        source_no: result.sourceNo,
        detail_count: result.detailRecordIds?.length || 0,
        duration_ms: Date.now() - startedAt,
        result: 'posted',
      });
      return {
        toast: {
          type: 'success',
          content: shouldDeliver ? '销售已确认并交付，库存已更新' : '销售已确认；预付单尚未交付，库存未扣减',
        },
      };
    }

    if (action === 'confirm_purchase' && task.type === 'purchase') {
      const startedAt = Date.now();
      // draft 在构建阶段已经完成货品匹配和供应商匹配，直接使用 record_id，不重复 resolve
      const result = await this.posting.postPurchase({
        batchRecordId: task.batch_record_id,
        operatorOpenId,
        supplierRecordId: task.draft.supplier_record_id,
        items: task.draft.items.map((item) => ({
          productRecordId: item.product_record_id,
          itemNo: item.item_no,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
          unitCost: item.unit_cost,
        })),
        payment: task.draft.payment,
      });
      await this.store.update(draftId, { status: 'posted', posting_result: result });
      logInfo('lark.purchase.posting.completed', {
        task_id: draftId,
        source_no: result.sourceNo,
        detail_count: result.inboundRecordIds?.length || 0,
        duration_ms: Date.now() - startedAt,
        result: 'posted',
      });
      return {
        toast: {
          type: 'success',
          content: result.inventoryApplied ? '采购已入库，库存已更新' : '采购入库明细已确认',
        },
      };
    }
    throw new Error(`不支持的卡片动作: ${action}`);
    } catch (error) {
      // Posting services are idempotent. Restore the draft so a corrected configuration or
      // transient Feishu failure can be retried from the same card instead of staying stuck.
      const waitingForSync = error.saleRecordsWritten === true || task.posting_records_written === true;
      await this.store
        .update(draftId, { status: 'ready_to_confirm', posting_error: error.message,
          posting_records_written: waitingForSync })
        .catch(() => undefined);
      if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
        const retryCard = salesConfirmationCard(draftId, task.draft);
        const reason = isDataNotReady(error) ? '飞书数据暂未就绪' : error.message;
        const current = await this.store.get(draftId);
        const hasWrittenRecords = waitingForSync || Object.values(current?.posting_record_ids || {})
          .some((ids) => Array.isArray(ids) && ids.some(Boolean));
        if (hasWrittenRecords) {
          // 重试卡片只留"继续处理这一单"那一个按钮。旧卡片上的交付动作名
          // （confirm_sale_delivered / _pending）现在统一对应新的「确认」。
          const requestedAction = current?.posting_requested_action || action;
          const retryAction = ['confirm_sale_delivered', 'confirm_sale_pending'].includes(requestedAction)
            ? 'confirm_sale' : requestedAction;
          retryCard.elements.filter((element) => element.tag === 'action').forEach((element) => {
            const sameAction = element.actions.filter((button) => button.value?.action === retryAction);
            if (sameAction.length) element.actions = sameAction;
          });
        }
        retryCard.elements.splice(1, 0, { tag: 'note', elements: [
          { tag: 'plain_text', content: waitingForSync
            ? `销售明细和收款已记录，但进度同步尚未完成，库存未扣。${reason}；请稍后在原卡片重试，不要重新发送销售。`
            : `入账失败；可能已有部分记录，库存未扣。${reason}；请核对后在原卡片重试，不要重新发送销售。` },
        ] });
        await this.publishSalesResultCard(task, event, retryCard,
          { stage: 'retryable', interactionId: context.interactionId });
        logError('lark.sales.posting.retryable', { task_id: draftId,
          records_written: waitingForSync, error: error.message });
        return { toast: { type: 'warning', content: waitingForSync
          ? '销售记录已写入，进度待同步；库存未扣，请稍后在原卡片重试'
          : '销售尚未完成，请核对原卡片后重试；不要重新发送销售' } };
      }
      throw error;
    }
  }

  async handleTaskFailure(taskId, error) {
    const task = await this.store.get(taskId);
    if (task) {
      await this.store.update(taskId, { status: 'failed', error: error.message }).catch(() => undefined);
      await this.sendText(task.sender_open_id, `处理失败：${error.message}`).catch(() => undefined);
    }
    logError('lark.mvp.task.failed', { task_id: taskId, error: error.message });
  }
}

module.exports = {
  LarkMvpService,
  aggregateRecognizedItems,
  idFor,
  looksLikeSalesText,
  parseContent,
};
