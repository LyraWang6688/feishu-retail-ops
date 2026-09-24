const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lark = require('@larksuiteoapi/node-sdk');
const doubaoService = require('./doubaoService');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway, textValue } = require('./v1BitableGateway');
const { V1PostingService } = require('./v1PostingService');
const { V1ReferenceResolver, person, relation } = require('./v1ReferenceResolver');
const { purchaseConfirmationCard, salesConfirmationCard, todaySalesCard } = require('../utils/larkCards');
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
    this.posting = options.posting || new V1PostingService({ gateway: this.gateway, references: this.references });
    this.recognizer = options.recognizer || doubaoService;
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
    await this.ensureIntakeSchema('today_sales', ['salesDetail']);
    const { dateLabel, start, end } = shanghaiDay(now);
    const table = this.gateway.table('salesDetail');
    const records = await this.gateway.listAll('salesDetail');
    const rows = records
      .filter((record) => {
        const soldAt = Number(textValue(record?.fields?.[table.fields.soldAt]));
        return soldAt >= start && soldAt < end;
      })
      .map((record) => ({
        product: textValue(record.fields?.[table.fields.product]) || '未知编号',
        size: textValue(record.fields?.[table.fields.size]),
        quantity: Number(textValue(record.fields?.[table.fields.quantity]) || 0),
        amount: Number(textValue(record.fields?.[table.fields.paidAmount]) || 0),
        paymentMethod: textValue(record.fields?.[table.fields.paymentMethod]) || '未填写',
        behavior: textValue(record.fields?.[table.fields.behavior]) || '未填写',
      }));
    const totalQuantity = rows.reduce((sum, row) => sum + row.quantity, 0);
    const totalAmount = Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 100) / 100;
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

  async acknowledgeMessage(messageId) {
    const results = await Promise.allSettled([
      this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'OK' } },
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
      await this.sendText(task.sender_open_id, '未识别为当前支持的现货销售，未写入销售录单。');
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
    if (!salesEntryRecordId) throw new Error('销售录单未返回 record_id');
    await this.store.update(taskId, { sales_entry_record_id: salesEntryRecordId, status: 'parsing' });

    const draft = {
      ...parsed,
      items: [
        {
          product_number: parsed.product_number,
          size: parsed.size,
          quantity: parsed.quantity,
          gift: parsed.gift,
          gift_description: parsed.gift_description,
        },
      ],
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
    await this.replyCard(task.message_id, salesConfirmationCard(taskId, draft));
    logInfo('lark.sales.processing.completed', {
      task_id: taskId,
      sales_entry_record_id: salesEntryRecordId,
      item_count: 1,
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

    const items = aggregateRecognizedItems(recognized).map((item) => ({
      item_no: item.item_no || '',
      color: item.color || '',
      size: item.size,
      quantity: item.quantity || 1,
      unit_cost: item.unit_cost,
    }));
    const suppliers = [...new Set(recognized.map((item) => item.supplier).filter(Boolean))];
    const supplier = suppliers.length === 1 ? suppliers[0] : '';
    const missingFields = [];
    if (!supplier) missingFields.push('供应商');
    if (items.some((item) => !item.unit_cost)) missingFields.push('入库单价');
    const draft = { items, supplier, missing_fields: missingFields };
    await this.store.update(taskId, {
      status: missingFields.length ? 'needs_info' : 'ready_to_confirm',
      batch_record_id: batchRecordId,
      draft,
    });
    await this.sendCard(task.sender_open_id, purchaseConfirmationCard(taskId, draft));
    if (missingFields.length) {
      await this.sendText(task.sender_open_id, '请回复“供应商 XXX，入库单价 100”。如果已付款，可加上“已付款 500，微信”。');
    }
    logInfo('lark.purchase.processing.completed', {
      task_id: taskId,
      purchase_batch_record_id: batchRecordId,
      item_count: items.length,
      missing_field_count: missingFields.length,
      duration_ms: Date.now() - startedAt,
      result: missingFields.length ? 'needs_info' : 'awaiting_confirmation',
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
    const draft = { ...task.draft, items: task.draft.items.map((item) => ({ ...item })) };
    if (supplierMatch) draft.supplier = supplierMatch[1];
    if (priceMatch) draft.items.forEach((item) => (item.unit_cost = Number(priceMatch[1])));
    if (paidMatch) draft.payment = { amount: Number(paidMatch[1]), method: methodMatch?.[1] || '' };
    draft.missing_fields = [];
    if (!draft.supplier) draft.missing_fields.push('供应商');
    if (draft.items.some((item) => !item.unit_cost)) draft.missing_fields.push('入库单价');
    if (draft.payment?.amount && !draft.payment.method) draft.missing_fields.push('付款方式');
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
    const task = await this.store.get(draftId);
    if (!task) throw new Error('确认草稿不存在或已过期');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由原始发送人确认该草稿');
    if (['posted', 'cancelled'].includes(task.status)) return { toast: { type: 'info', content: '该草稿已处理' } };
    if (task.status === 'posting') return { toast: { type: 'info', content: '正在入账，请勿重复点击' } };

    if (action === 'cancel') {
      await this.store.update(draftId, { status: 'cancelled' });
      if (task.type === 'sale' && task.sales_entry_record_id) {
        await this.gateway.update('salesEntry', task.sales_entry_record_id, { confirmStatus: '已取消' });
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
      await this.sendText(operatorOpenId, '请重新发送一条完整、正确的销售信息；原草稿不会入账。');
      return { toast: { type: 'info', content: '请重新发送修正后的完整销售信息' } };
    }

    await this.store.update(draftId, { status: 'posting' });
    if (action === 'confirm_sale' && task.type === 'sale') {
      const startedAt = Date.now();
      const result = await this.posting.postSale({
        salesEntryRecordId: task.sales_entry_record_id,
        operatorOpenId,
        behaviorCode: task.draft.behavior_code,
        paymentMethod: task.draft.payment_method,
        totalPaid: task.draft.total_paid,
        items: task.draft.items.map((item) => ({
          productNumber: item.product_number,
          size: item.size,
          quantity: item.quantity,
          gift: item.gift,
        })),
      });
      await this.store.update(draftId, { status: 'posted', posting_result: result });
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
          content: result.sideEffectsApplied ? '销售已入账，库存已更新' : '销售明细已确认',
        },
      };
    }

    if (action === 'confirm_purchase' && task.type === 'purchase') {
      const startedAt = Date.now();
      const supplier = await this.references.resolveSupplier(task.draft.supplier);
      const result = await this.posting.postPurchase({
        batchRecordId: task.batch_record_id,
        operatorOpenId,
        supplierRecordId: supplier.recordId,
        items: task.draft.items.map((item) => ({
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
      return { toast: { type: 'success', content: '采购已入库，库存与应付已更新' } };
    }
    throw new Error(`不支持的卡片动作: ${action}`);
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
