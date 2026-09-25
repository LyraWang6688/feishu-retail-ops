const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const doubaoService = require('./doubaoService');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1PostingService } = require('./v1PostingService');
const { createWorkbenchService } = require('./v1WorkbenchService');
const { SalesDeliveryService } = require('./salesDeliveryService');
const { PurchaseDraftBuilder } = require('./purchaseDraftBuilder');
const { PurchaseWebhookService } = require('./purchaseWebhookService');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { purchaseConfirmationCard, salesConfirmationCard, salesStatusCard, todaySalesCard } = require('../utils/larkCards');
const { logError, logInfo, logWarn } = require('../utils/logger');
const { getLarkAgentCredentials } = require('../config/larkAgent');

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
      this.client = new lark.Client({ appId, appSecret });
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
    this.intakeSchemaValidation = new Map();
    this.senderQueues = new Map();
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

  async updateSalesActionCard(task, event, card) {
    const messageId = event?.context?.open_message_id || event?.open_message_id || task.card_message_id;
    if (!messageId) {
      logWarn('lark.sales.card.update.skipped', { task_id: task.task_id, reason: 'missing_message_id' });
      return false;
    }
    try {
      const patch = this.client.im?.v1?.message?.patch || this.client.im?.message?.patch;
      if (!patch) throw new Error('飞书客户端不支持更新消息卡片');
      const response = await patch.call(this.client.im?.v1?.message || this.client.im.message, {
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
      if (response.code !== 0) throw new Error(`${response.msg} (Code: ${response.code})`);
      return true;
    } catch (error) {
      logWarn('lark.sales.card.update.failed', { task_id: task.task_id, error: error.message });
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

    if (message.message_type === 'image') {
      return this.acceptPurchaseImage({ message, senderOpenId });
    }
    if (message.message_type !== 'text') {
      await this.sendText(senderOpenId, '当前支持销售文字和采购到货图片。');
      return { accepted: false, reason: 'unsupported_message_type' };
    }

    const originalText = String(parseContent(message.content).text || '').trim();
    if (originalText === '采购完成') return this.finishPurchaseImages(senderOpenId);
    if (await this.tryCompletePurchaseDraft(senderOpenId, originalText)) return { accepted: true, type: 'purchase_supplement' };
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

  async processSalesTask(taskId) {
    const startedAt = Date.now();
    logInfo('lark.sales.processing.started', { task_id: taskId });
    const task = await this.store.get(taskId);
    const parsed = await this.recognizer.parseSalesText(task.original_text);
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
      sentAt: task.sent_at,
      parseStatus: '解析中',
      confirmStatus: '待确认',
    });
    const salesEntryRecordId = created?.recordId;
    if (!salesEntryRecordId) throw new Error('销售主表未返回 record_id');
    await this.store.update(taskId, { sales_entry_record_id: salesEntryRecordId, status: 'parsing' });

    const productTable = this.gateway.table?.('product');
    const missingFields = [...(parsed.missing_fields || [])];
    const items = [];
    for (const [index, item] of (parsed.items?.length ? parsed.items : [parsed]).entries()) {
      let product;
      if (item.item_no && item.size) {
        try { product = await this.references.resolveProduct({ itemNo: item.item_no, color: item.color }); }
        catch (error) { missingFields.push(`第${index + 1}件：${error.message}`); }
      }
      const configuredNumber = product
        ? textValue(product.record?.fields?.[productTable?.fields?.number]) || item.item_no
        : '';
      items.push({ ...item, product_record_id: product?.recordId || '', product_number: configuredNumber });
    }
    const actualTotal = Math.round(items.reduce((sum, item) => sum + Number(item.actual_amount || 0), 0) * 100) / 100;
    if (items.some((item) => !Number(item.actual_amount))) missingFields.push('请逐件说明成交金额');
    if (parsed.agreed_total && Math.abs(actualTotal - Number(parsed.agreed_total)) > 0.005) {
      missingFields.push('逐件成交金额合计与整单成交金额不一致');
    }
    if (Number(parsed.total_paid || 0) > actualTotal) missingFields.push('已收金额不能超过本单成交金额');

    const draft = {
      ...parsed,
      product_number: items[0]?.product_number || '',
      items,
      missing_fields: missingFields,
    };
    await this.gateway.update('salesEntry', salesEntryRecordId, {
      parseStatus: draft.missing_fields?.length ? '需补充' : '解析成功',
      parseSummary: JSON.stringify(draft),
      failureReason: draft.missing_fields?.length ? draft.missing_fields.join('、') : '',
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

  async handleCardAction(event) {
    const value = event?.action?.value || event?.event?.action?.value || {};
    const draftId = value.draft_id;
    const action = value.action;
    const operatorOpenId =
      event?.operator?.operator_id?.open_id || event?.operator?.open_id || event?.event?.operator?.operator_id?.open_id;
    const procurementResult = await this.purchaseWebhooks.handleCardAction(value, operatorOpenId);
    if (procurementResult) return procurementResult;
    const task = await this.store.get(draftId);
    if (!task) throw new Error('确认草稿不存在或已过期');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由原始发送人确认该草稿');
    if (['posted', 'posted_delivery_pending', 'cancelled'].includes(task.status)) return { toast: { type: 'info', content: '该草稿已处理' } };
    if (task.status === 'posting') return { toast: { type: 'info', content: '正在入账，请勿重复点击' } };
    if (task.status === 'awaiting_correction' && action !== 'cancel') {
      return { toast: { type: 'info', content: '该草稿正在等待修正，请重新发送完整销售信息' } };
    }

    if (action === 'cancel') {
      await this.store.update(draftId, { status: 'cancelled' });
      if (task.type === 'sale' && task.sales_entry_record_id) {
        await this.gateway.update('salesEntry', task.sales_entry_record_id, { confirmStatus: '已取消' });
        await this.updateSalesActionCard(task, event, salesStatusCard(task.draft, '销售录单已取消', '原草稿不会入账。'));
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
      await this.updateSalesActionCard(task, event, salesStatusCard(task.draft, '等待重新发送', '原草稿不会入账；请重新发送完整销售信息。', 'orange'));
      await this.sendText(operatorOpenId, '请重新发送一条完整、正确的销售信息；原草稿不会入账。');
      return { toast: { type: 'info', content: '请重新发送修正后的完整销售信息' } };
    }

    await this.store.update(draftId, { status: 'posting' });
    try {
    if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
      const cardUpdated = await this.updateSalesActionCard(task, event,
        salesStatusCard(task.draft, '销售订单处理中', '已收到确认，正在写入销售记录和收款；请勿重复点击。'));
      if (!cardUpdated) await this.sendText(operatorOpenId, '已收到确认，正在写入销售记录和收款，请稍候。').catch(() => undefined);
      const startedAt = Date.now();
      const result = await this.posting.postSale({
        salesEntryRecordId: task.sales_entry_record_id,
        operatorOpenId,
        paymentMethod: task.draft.payment_method,
        totalPaid: task.draft.total_paid,
        payments: (task.draft.payments || []).map((payment) => ({
          amount: payment.amount, method: payment.method, operatorOpenId,
        })),
        items: task.draft.items.map((item) => ({
          productRecordId: item.product_record_id,
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
      if (action === 'confirm_sale_delivered') {
        try {
          await this.delivery.deliver({ salesEntryRecordId: task.sales_entry_record_id,
            detailRecordIds: result.detailRecordIds, state: '门盒', operatorOpenId });
        } catch (error) {
          await this.updateSalesActionCard(task, event, salesStatusCard(task.draft,
            '订单已入账，交付待处理', `销售单号：${result.sourceNo}。库存交付未完成：${error.message}。请在工作台待交付列表核对并处理。`, 'orange'));
          logError('lark.sales.delivery.failed', { task_id: draftId, error: error.message });
          return { toast: { type: 'warning', content: '订单已入账，库存交付待处理' } };
        }
      }
      await this.store.update(draftId, { status: 'posted', posting_result: result });
      await this.updateSalesActionCard(task, event, salesStatusCard(task.draft,
        '销售订单已入账', `销售单号：${result.sourceNo}；${result.detailRecordIds?.length || 0} 条明细已写入。${action === 'confirm_sale_delivered' ? '已交付并扣库存。' : '尚未交付，库存未扣减。'}`, 'green'));
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
          content: action === 'confirm_sale_delivered' ? '销售已确认并交付，库存已更新' : '销售已确认，交付时再扣库存',
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
      await this.store
        .update(draftId, { status: 'ready_to_confirm', posting_error: error.message })
        .catch(() => undefined);
      if (['confirm_sale', 'confirm_sale_pending', 'confirm_sale_delivered'].includes(action) && task.type === 'sale') {
        const retryCard = salesConfirmationCard(draftId, task.draft);
        retryCard.elements.splice(1, 0, { tag: 'note', elements: [
          { tag: 'plain_text', content: `入账失败：${error.message}。请核对后重试。` },
        ] });
        await this.updateSalesActionCard(task, event, retryCard);
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
