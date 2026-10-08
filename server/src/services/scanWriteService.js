/**
 * 扫码入口的**两个写入口**：销售建单（一单多明细）与补货报单（采购申请）。
 *
 * 🔴 这个文件最要紧的一条：**本文件自己不写任何业务表**。
 *   · 销售：主表记录走**既有的**「全仓唯一创建销售主表记录」那个函数
 *     （`LarkMvpService.createSalesEntryWithOrderNo`，含单号分配与撞号复查）；
 *     明细 / 收款 / 四个状态维度 / 进度全部走**既有的** `SalesOrderService.confirm`
 *     （地址簿：`services/salesOrderService.js`）——与群聊入口、工作台入口**同一个函数**；
 *   · 采购：采购申请走**既有的** `PurchaseWebhookService.publishPurchaseRequest`
 *     （就是「信息填写」表变更事件走的那条免确认路径），本文件只把"这次要补什么"给它。
 *   ⇒ 换一个入口不会多出一本账：扫码侧**没有第二套写库逻辑**（`scanPageWrite.test.js`
 *     有一条源码哨兵钉住"本文件里没有 create/update/delete"）。
 *
 * 🔴 入口隔离（`docs/entry-isolation-2026-10-08.md`）：
 *   本文件只做"扫码页这一次操作 → 交给业务层"的**翻译**：
 *   · 会话/草稿状态在**我们自己的**会话文件里（`services/scanSessionService.js`），
 *     绝不读写 `data/lark_mvp_tasks/`；
 *   · 输入不是自然语言（是页面表单），所以**不碰**任何 AI 解析 / 群聊文案；
 *   · 失败文案在 `config/scanWrite.js`，与群聊那条链路的文案**各管各的**。
 *
 * 🔴 幂等（业务负责人 2026-10-08：连点两次 / 重放 ⇒ 只写一次）——**三道**，都用仓库既有设施：
 *   ① **会话里的幂等键**（`<前缀>:<会话 id>:<轮次>`）：同一轮里连点两次是**同一把键**
 *      ⇒ 第二次直接把她上一次的结果还给她，一次远端写入都不发生；
 *   ② **进程内串行**（`infrastructure/keyedSerialQueue`，按录单人串）：两个请求真的同时到达时，
 *      后一个会等前一个跑完再判 —— 判据读到的是"已经写完了"，不会各写一遍；
 *   ③ **业务层自己的幂等**（既有，未改）：`SalesOrderService.confirm` 会先按
 *      `knownRecordIds` 回查已经写过的明细 / 收款（`PaymentService.recordInitialBatch` 同源），
 *      采购那条更硬 —— `createOnceByKey` 按远端「幂等键」列回查（主键由 task id 推出，
 *      而 task id 由**这一次提交的幂等键**推出）。
 */
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1ReferenceResolver } = require('./v1ReferenceResolver');
const { SalesOrderService } = require('./salesOrderService');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { REPORT_BEHAVIOR } = require('./purchaseReportBehaviorPolicy');
const { SCAN_WRITE, fillText } = require('../config/scanWrite');
const { createScanSessionService } = require('./scanSessionService');
const { logError, logInfo } = require('../utils/logger');

/**
 * 「全仓唯一创建销售主表记录」的那个函数 —— **只 require 调用，不改它一个字**。
 *
 * ⚠️ 为什么是 `.prototype.call(...)` 而不是 `new LarkMvpService(...)`：
 *   `LarkMvpService` 的构造函数会连带构造采购 / 售后 / 样品 / 本地任务存储等一整套
 *   群聊入口的东西，而我们需要**只是**这一个方法（它是纯的：只读网关 + 写主表）。
 *   借一个最小接收者调它，既不构造群聊那一整套、也不碰 `data/lark_mvp_tasks/`。
 *   方法内部只用到 `this.gateway` 与 `this.listSalesOrderNos`（两者都在这里给它）。
 */
const createSalesEntryWithOrderNo = async (gateway, task) => {
  // 延迟 require：避免把群聊入口那一整棵模块树拖进"扫码页模块加载"这条路径。
  // eslint-disable-next-line global-require
  const { LarkMvpService } = require('./larkMvpService');
  return LarkMvpService.prototype.createSalesEntryWithOrderNo.call({
    gateway,
    listSalesOrderNos: LarkMvpService.prototype.listSalesOrderNos,
  }, task);
};

const createScanWriteService = (options = {}) => {
  if (!options.gateway) throw new Error('ScanWriteService requires gateway');
  const gateway = options.gateway;
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const config = options.config || SCAN_WRITE;
  const texts = config.texts;
  const now = options.now || (() => Date.now());
  const sessions = options.sessions || createScanSessionService({
    config, dir: options.sessionDir, store: options.sessionStore, now,
  });
  const references = options.references || new V1ReferenceResolver(gateway);
  const createEntry = options.createSalesEntry || createSalesEntryWithOrderNo;
  // 按录单人串行（同一部手机连点 / 重放会落在同一个 key 上）。
  const queue = options.queue || new KeyedSerialQueue();

  // 业务层实例**延迟构造**：扫码页第一版是只读的，绝大多数请求（看库存）不该因为
  // 构造销售 / 采购那一整套依赖而变慢。用到才建。
  let salesInstance = options.sales || null;
  const sales = () => {
    if (!salesInstance) salesInstance = new SalesOrderService({ gateway });
    return salesInstance;
  };
  let statusInstance = options.status || null;
  const status = () => {
    if (!statusInstance) statusInstance = new SalesStatusWriter({ gateway });
    return statusInstance;
  };
  let purchaseInstance = options.purchase || null;
  const purchaseStore = options.purchaseStore || new JsonTaskStore({
    dir: options.purchaseTaskDir || config.replenish.taskDir, idField: 'task_id',
  });
  const purchase = () => {
    if (!purchaseInstance) {
      if (typeof options.createPurchaseService === 'function') {
        purchaseInstance = options.createPurchaseService({ gateway, store: purchaseStore, references });
      } else if (options.purchaseServiceClass) {
        purchaseInstance = new options.purchaseServiceClass({ gateway, store: purchaseStore, references });
      } else {
        // eslint-disable-next-line global-require
        const { PurchaseWebhookService } = require('./purchaseWebhookService');
        purchaseInstance = new PurchaseWebhookService({ gateway, store: purchaseStore, references });
      }
    }
    return purchaseInstance;
  };

  const fieldOf = (tableKey, semanticKey) => schema?.tables?.[tableKey]?.fields?.[semanticKey] || '';

  // ── 小工具 ────────────────────────────────────────────────────────────────
  const fail = ({ code, message, requestId, error, extra = {} }) => {
    const detail = error ? String(error.message || error) : '';
    if (error) {
      logError(config.events.failed, {
        request_id: requestId, code, error: detail, ...(extra.log || {}),
      });
    }
    return { ok: false, code, message, failure_reason: detail, ...extra.result };
  };

  /**
   * 业务层抛出来的错误 → **给她看的人话**。
   * · 我们的校验错误（`scanUserMessage`）直接用；
   * · 业务层自己的中文业务话（例：「本次收款超过本单成交金额」「尺码管理中找不到 41 码」）
   *   原样给她 —— 她照着改一下就能再提交；
   * · 命中 `sale.unsafeErrorMarkers` 的**内部错误**（飞书错误码 / 表名字段名 / 配置缺失）
   *   只给通用人话，原文只进日志（与第一版只读页"内部细节不回显"同一条规矩）。
   */
  const userMessageFor = (error) => {
    const raw = String(error?.message || error || '').trim();
    if (error?.scanUserMessage) return error.scanUserMessage;
    if (!raw) return texts.internalFailedBody;
    const unsafe = (config.sale.unsafeErrorMarkers || []).some((marker) => raw.includes(marker));
    if (unsafe) return texts.internalFailedBody;
    return fillText(texts.businessFailedBody, { reason: raw });
  };

  const positiveAmount = (raw) => {
    const text = String(raw ?? '').trim().replace(/[¥￥,\s]/g, '');
    if (!text) return { ok: true, value: null };
    const decimals = Number.isInteger(config.sale.amountDecimals) ? config.sale.amountDecimals : 2;
    const pattern = new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
    if (!pattern.test(text)) return { ok: false };
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return { ok: false };
    return { ok: true, value: Math.round(value * 100) / 100 };
  };

  const positiveInteger = (raw) => {
    const text = String(raw ?? '').trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : null;
  };

  /** 「货品信息.单价」——她"钱可以先不填"时的兜底（取不到就让她填，绝不写 0）。 */
  const productPrice = async (productRecordId) => {
    const field = fieldOf('product', 'price');
    if (!field) return null;
    const record = await gateway.get('product', productRecordId).catch(() => null);
    const value = Number(textValue(record?.fields?.[field]));
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  const productNumber = (record) => textValue(record?.fields?.[fieldOf('product', 'number')]).trim();

  const resolveProductRecord = async ({ productRecordId, number }) => {
    const id = String(productRecordId || '').trim();
    if (id) {
      const record = await gateway.get('product', id).catch(() => null);
      if (record) return record;
    }
    if (!number) return null;
    const numberField = fieldOf('product', 'number');
    if (!numberField) return null;
    const records = await gateway.listAll('product');
    return records.find((record) => textValue(record?.fields?.[numberField]).trim() === String(number).trim()) || null;
  };

  const salesEntryOrderNo = async (recordId, created) => {
    const field = fieldOf('salesEntry', 'orderNo');
    const fromCreate = textValue(created?.record?.fields?.[field]).trim();
    if (fromCreate) return fromCreate;
    const record = await gateway.get('salesEntry', recordId).catch(() => null);
    return textValue(record?.fields?.[field]).trim();
  };

  // ── 销售：加入本单（**只写本地会话**）────────────────────────────────────
  /**
   * 加一双进"本单"。**业务表一个字都不写** —— 她说"点【提交】才写"。
   * @returns {Promise<{ok:boolean, code?:string, message?:string, count?:number, limit?:number}>}
   */
  const addSaleLine = async ({ openId, productRecordId = '', number = '', itemNo = '', color = '', size, amount = '', gift = '', requestId = '' }) => {
    if (!config.sale.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    const parsedSize = positiveInteger(size);
    if (parsedSize === null) {
      const error = new Error(texts.sizeMissingBody);
      error.scanUserMessage = texts.sizeMissingBody;
      return fail({ code: 'size_missing', message: userMessageFor(error), requestId, error });
    }
    const parsedAmount = positiveAmount(amount);
    if (!parsedAmount.ok) {
      const error = new Error(texts.amountInvalidBody);
      error.scanUserMessage = texts.amountInvalidBody;
      return fail({ code: 'amount_invalid', message: userMessageFor(error), requestId, error });
    }
    const giftText = String(gift ?? '').trim().slice(0, config.sale.giftMaxLength);
    const added = await queue.run(`sale:${openId}`, () => sessions.addLine(openId, {
      number: String(number || '').trim(),
      item_no: String(itemNo || '').trim(),
      color: String(color || '').trim(),
      product_record_id: String(productRecordId || '').trim(),
      size: parsedSize,
      // 金额留空就是 null（提交时按「货品信息.单价」兜底）——**不在加单这一刻读表**，
      // 这样连扫几次不会因为读价格而变慢。
      amount: parsedAmount.value,
      gift: giftText,
      added_at: new Date(now()).toISOString(),
    }));
    if (!added.ok) {
      return fail({
        code: added.code,
        message: fillText(texts.tooManyLinesBody, { max: added.limit }),
        requestId,
        extra: { result: { limit: added.limit } },
      });
    }
    logInfo(config.events.lineAdded, {
      session_id: added.session.session_id,
      number: String(number || ''),
      product_record_id: String(productRecordId || ''),
      size: parsedSize,
      count: added.count,
      request_id: requestId,
    });
    return { ok: true, count: added.count, limit: config.session.maxLines, session: added.session };
  };

  /** 清空本单（她加错了一双时的退路）。 */
  const clearDraft = async ({ openId, requestId = '' }) => {
    const session = await queue.run(`sale:${openId}`, () => sessions.clearSale(openId));
    return { ok: true, count: 0, session, request_id: requestId };
  };

  // ── 销售：提交整单（**唯一的写库时机**）──────────────────────────────────
  /**
   * 提交"本单"：**一张销售主表 + N 条明细（一单一双一行）**。
   *
   * @param {object} input
   * @param {string} input.openId   录单人（会话按他分）
   * @param {string} input.submitKey 表单带回来的幂等键（连点两次 = 同一把）
   * @param {string} [input.paymentMethod] 收款方式（**默认「微信」由 config 给**，可改）
   * @param {string} [input.paymentAmount] 这次收到的钱；**留空 = 先货后钱（不写收款明细）**
   */
  const submitSale = async ({ openId, submitKey, paymentMethod = '', paymentAmount = '', requestId = '' }) => queue.run(`sale:${openId}`, async () => {
    if (!config.sale.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    let current = await sessions.get(openId);
    // 会话还没建（她扫开就看、什么都没加过）：页面上那把键就是**第 1 轮**的键，
    // 这里把会话建出来即可对上 —— 否则她第一次提交会被判成"页面过期"，莫名其妙。
    if (!current) current = await sessions.ensure(openId);
    if (current.expired) {
      return fail({ code: 'session_expired', message: texts.sessionExpiredBody, requestId });
    }
    const sale = current.sale || {};
    const key = String(submitKey || '').trim();
    const completed = sale.completed || [];
    // ① 这一把键已经提交过 ⇒ **把上一次的结果还给她**（连点第二次走的就是这里）。
    const done = completed.find((item) => item.key === key);
    if (done) {
      logInfo(config.events.saleReused, {
        session_id: current.session_id, submit_key: key,
        order_no: done.order_no, sales_entry_record_id: done.sales_entry_record_id,
        request_id: requestId,
      });
      return {
        ok: true,
        reused: true,
        order_no: done.order_no,
        sales_entry_record_id: done.sales_entry_record_id,
        detail_count: done.detail_count,
        payment_count: done.payment_count,
        paid_amount: done.paid_amount,
      };
    }
    // ② 键对不上：多半是"上一单提交成功后这一页还开着"⇒ 还给她上一单的结果，**不写第二遍**。
    if (sale.key !== key) {
      const last = completed[completed.length - 1];
      if (last) {
        logInfo(config.events.saleReused, {
          session_id: current.session_id, submit_key: key, stale: true,
          order_no: last.order_no, sales_entry_record_id: last.sales_entry_record_id,
          request_id: requestId,
        });
        return {
          ok: true,
          reused: true,
          stale: true,
          order_no: last.order_no,
          sales_entry_record_id: last.sales_entry_record_id,
          detail_count: last.detail_count,
          payment_count: last.payment_count,
          paid_amount: last.paid_amount,
        };
      }
      return fail({ code: 'session_expired', message: texts.sessionExpiredBody, requestId });
    }
    const lines = sale.lines || [];
    if (!lines.length) {
      return fail({ code: 'session_empty', message: texts.sessionEmptyBody, requestId });
    }
    const parsedPayment = positiveAmount(paymentAmount);
    if (!parsedPayment.ok) {
      const error = new Error(texts.paymentAmountInvalidBody);
      error.scanUserMessage = texts.paymentAmountInvalidBody;
      return fail({ code: 'payment_amount_invalid', message: userMessageFor(error), requestId, error });
    }
    // 「钱可以先不填」：没填收款金额 ⇒ **不写任何收款明细**，
    // 表里那一单的「资金状态」就停在既有的「未写入」（= 她说的"待补资金"，不新造状态）。
    const payments = parsedPayment.value === null ? [] : [{
      amount: parsedPayment.value,
      // 收款方式：她页面上选的（默认「微信」由 config 给）；这里只兜底"没传"那一种。
      method: String(paymentMethod || '').trim() || config.sale.defaultPaymentMethod,
      operatorOpenId: openId,
    }];

    // ③ 逐行把明细准备好（金额留空 → 用「货品信息.单价」；取不到就让她填，绝不写 0）。
    const items = [];
    for (const line of lines) {
      const productRecordId = String(line.product_record_id || '').trim();
      if (!productRecordId) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'line_product_missing', message: userMessageFor(error), requestId, error });
      }
      const size = positiveInteger(line.size);
      if (size === null) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'line_size_missing', message: userMessageFor(error), requestId, error });
      }
      let actualAmount = line.amount === null || line.amount === undefined ? null : Number(line.amount);
      if (!Number.isFinite(actualAmount) || actualAmount <= 0) {
        actualAmount = await productPrice(productRecordId);
      }
      if (!Number.isFinite(actualAmount) || actualAmount <= 0) {
        const message = fillText(texts.amountMissingBody, { itemNo: line.item_no || line.number || '' });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'line_amount_missing', message, requestId, error });
      }
      items.push({
        kind: 'shoe',
        productRecordId,
        size,
        quantity: 1,
        actualAmount: Math.round(actualAmount * 100) / 100,
        // ⭐ 赠品：一件明细的赠品文本 —— 落点是**销售主表**那一列（合并规则在
        //    `config/salesGift` + `salesOrderService`，这里只把她的输入传下去）。
        giftDescription: String(line.gift || '').trim(),
      });
    }

    logInfo(config.events.saleSubmitting, {
      session_id: current.session_id, submit_key: key, line_count: items.length,
      payment_count: payments.length, request_id: requestId,
    });

    try {
      // ④ 主表记录：走既有函数（单号生成 + 撞号复查都在里面），**只在第一次建**。
      //    建完立刻把 record_id 落进会话 —— 后面任何一步失败，重试都接着**同一张**单写。
      let salesEntryRecordId = String(sale.master_record_id || '').trim();
      let orderNo = String(sale.order_no || '').trim();
      if (!salesEntryRecordId) {
        const created = await createEntry(gateway, {
          // 主表「原话」那一列：扫码来的单也留一句人话（模板在 config）。
          original_text: fillText(config.sale.originalTextTemplate, {
            count: items.length,
            products: lines.map((line) => line.item_no || line.number).filter(Boolean).join('、'),
          }),
          sender_open_id: openId,
          task_id: key,
        });
        salesEntryRecordId = String(created?.recordId || '').trim();
        if (!salesEntryRecordId) throw new Error('创建销售主表后没有拿到 record_id');
        orderNo = await salesEntryOrderNo(salesEntryRecordId, created);
        await sessions.saveSaleProgress(openId, {
          master_record_id: salesEntryRecordId, order_no: orderNo,
        });
      }
      const correlation = { task_id: key, sales_entry_record_id: salesEntryRecordId, order_no: orderNo };
      // 「点【提交】才写」= 她**在页面上确认过**了 ⇒ 「确认状态」记「已确认」
      //（走四个状态维度的**唯一写入口** SalesStatusWriter；值来自 config/salesStatusDimensions）。
      // ⚠️ 只有第一次建单时才补这一下（重试时不必重复写）。
      if (!sale.master_record_id) {
        await status().write(salesEntryRecordId, { userAction: WRITE.userAction.confirmed }, correlation);
      }
      // ⑤ 明细 / 收款 / 进度：**既有业务函数**（与群聊、工作台是同一条路）。
      //    `knownRecordIds` + `onRecordPersisted` = 既有链路那套"写到一半崩了也能接着写"的协议。
      const result = await sales().confirm({
        salesEntryRecordId,
        items,
        payments,
        operatorOpenId: openId,
        knownRecordIds: {
          details: sale.detail_ids || [],
          payments: sale.payment_ids || [],
        },
        onRecordPersisted: async (kind, index, recordId) => {
          const fresh = await sessions.get(openId);
          const key2 = kind === 'payments' ? 'payment_ids' : 'detail_ids';
          const ids = [...((fresh?.sale?.[key2]) || [])];
          ids[index] = recordId;
          await sessions.saveSaleProgress(openId, { [key2]: ids });
        },
      }, { correlation });
      const detailCount = (result.detailRecordIds || []).length || items.length;
      const paymentCount = (result.paymentRecordIds || []).length;
      const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const summary = {
        order_no: result.sourceNo || orderNo,
        sales_entry_record_id: salesEntryRecordId,
        detail_count: detailCount,
        payment_count: paymentCount,
        paid_amount: paidAmount,
      };
      await sessions.completeSale(openId, { key, result: summary });
      logInfo(config.events.saleSubmitted, {
        session_id: current.session_id, submit_key: key, ...summary,
        funds_recorded: paymentCount > 0, request_id: requestId,
      });
      return { ok: true, reused: false, ...summary };
    } catch (error) {
      const message = userMessageFor(error);
      await sessions.markSaleFailed(openId, String(error.message || error)).catch(() => undefined);
      return fail({ code: 'sale_write_failed', message, requestId, error });
    }
  });

  // ── 补货报单：勾尺码 + 数量 → 采购申请 ────────────────────────────────────
  /**
   * 生成采购申请（走既有采购链路的免确认路径）。
   *
   * @param {object} input
   * @param {Array<{size:number|string, quantity:number|string}>} input.entries 勾选的尺码与数量
   */
  const submitReplenish = async ({ openId, submitKey, productRecordId = '', number = '', entries = [], requestId = '' }) => queue.run(`sale:${openId}`, async () => {
    if (!config.replenish.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    let current = await sessions.get(openId);
    // ⚠️ **扫开就直接补货**是完全正常的用法（她从没点过「加入本单」）⇒ 会话还没建。
    //    这时页面上的补货键就是第 1 轮那把（`submitKeyFor` 纯函数算出来的），建出来即对上。
    if (!current) current = await sessions.ensure(openId);
    if (current.expired) {
      return fail({ code: 'session_expired', message: texts.sessionExpiredBody, requestId });
    }
    const replenish = current.replenish || {};
    const key = String(submitKey || '').trim();
    const completed = replenish.completed || [];
    const done = completed.find((item) => item.key === key);
    if (done) {
      logInfo(config.events.replenishReused, {
        session_id: current.session_id, submit_key: key, batch_no: done.batch_no, request_id: requestId,
      });
      return {
        ok: true, reused: true, batch_no: done.batch_no, request_count: done.request_count,
      };
    }
    if (replenish.key !== key) {
      const last = completed[completed.length - 1];
      if (last) {
        logInfo(config.events.replenishReused, {
          session_id: current.session_id, submit_key: key, stale: true, batch_no: last.batch_no,
          request_id: requestId,
        });
        return { ok: true, reused: true, stale: true, batch_no: last.batch_no, request_count: last.request_count };
      }
      return fail({ code: 'session_expired', message: texts.replenishAgainBody, requestId });
    }

    // ① 校验：勾了哪些尺码、每个几双（勾了不填数量按 1 双，与「信息填写」报单那条口径一致）。
    const picked = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const size = positiveInteger(entry?.size);
      if (size === null) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'size_unknown', message: userMessageFor(error), requestId, error });
      }
      const rawQuantity = String(entry?.quantity ?? '').trim();
      const quantity = rawQuantity ? positiveInteger(rawQuantity) : config.replenish.defaultQuantity;
      if (quantity === null || quantity > config.replenish.maxQuantity) {
        const message = fillText(texts.quantityInvalidBody, { max: config.replenish.maxQuantity });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'quantity_invalid', message, requestId, error });
      }
      picked.push({ size, quantity });
    }
    if (!picked.length) {
      const error = new Error(texts.replenishNoneBody);
      error.scanUserMessage = texts.replenishNoneBody;
      return fail({ code: 'replenish_empty', message: userMessageFor(error), requestId, error });
    }
    if (picked.length > config.replenish.maxSizes) {
      const message = fillText(texts.replenishTooManyBody, { max: config.replenish.maxSizes });
      const error = new Error(message);
      error.scanUserMessage = message;
      return fail({ code: 'replenish_too_many', message, requestId, error });
    }

    try {
      // ② 货品 + 供应商 + 采购行为：**全部来自既有表**（供应商取「货品信息.供应商」，
      //    与「信息填写」报单那条链路在 `processSupplierReport` 里取的是**同一个字段**）。
      const product = await resolveProductRecord({ productRecordId, number });
      if (!product) {
        const error = new Error(texts.sizeUnknownBody);
        error.scanUserMessage = texts.sizeUnknownBody;
        return fail({ code: 'product_missing', message: userMessageFor(error), requestId, error });
      }
      const productId = product.record_id || productRecordId;
      const productFields = schema.tables.product.fields;
      const supplierRecordId = linkedRecordIds(product.fields?.[productFields.supplier])[0] || '';
      const behavior = await references.resolveBehavior(config.replenish.behaviorCode);
      const itemNo = textValue(product.fields?.[productFields.itemNo]).trim();
      const color = textValue(product.fields?.[productFields.color]).trim();
      const items = picked.map(({ size, quantity }) => ({
        product_record_id: productId,
        product_number: productNumber(product),
        item_no: itemNo,
        color,
        size,
        quantity,
        // 供应商只用于"按供应商出图"（既有链路的分组依据），不从扫码页另立一套。
        supplier_record_id: supplierRecordId,
        // 扫码补货**没有报单记录**（不是「信息填写」触发的）⇒ 如实留空、不编一个 id。
        report_record_id: '',
        behavior_record_id: behavior.recordId,
        behavior_kind: REPORT_BEHAVIOR.PURCHASE_REQUEST,
      }));
      const draft = {
        // 不是"多记录归批"，但走同一条计划/幂等代码：`is_batch: true` + 空的报单记录清单
        // ⇒ 既有链路里"回写报单记录状态"那一步自然跳过（我们**没有**报单记录可写）。
        is_batch: true,
        report_record_id: '',
        report_record_ids: [],
        product_record_id: productId,
        product_number: productNumber(product),
        supplier_record_id: supplierRecordId,
        behavior_record_id: behavior.recordId,
        operator_open_id: openId,
        items,
      };
      // task id 由**这一次提交的幂等键**推出来 ⇒ 重放同一个键 = 同一个 task
      // ⇒ 采购申请 / 报货批次在主键上命中既有记录（`createOnceByKey`），只写一次。
      const taskId = `${config.replenish.taskIdPrefix}_${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const existingTask = await purchaseStore.get(taskId).catch(() => null);
      const task = existingTask || await purchaseStore.create({
        task_id: taskId, kind: 'scan_replenish', status: 'posting', draft,
      });
      logInfo(config.events.replenishSubmitting, {
        session_id: current.session_id, submit_key: key, task_id: taskId,
        line_count: items.length, supplier_record_id: supplierRecordId, request_id: requestId,
      });
      const result = await purchase().publishPurchaseRequest(taskId, task);
      const summary = {
        batch_no: result?.batch_no || '',
        batch_record_id: result?.batch_record_id || '',
        request_count: (result?.request_ids || []).length,
      };
      await sessions.completeReplenish(openId, { key, result: summary });
      logInfo(config.events.replenishSubmitted, {
        session_id: current.session_id, submit_key: key, task_id: taskId, ...summary,
        request_id: requestId,
      });
      return { ok: true, reused: false, ...summary };
    } catch (error) {
      const message = userMessageFor(error);
      await sessions.markReplenishFailed(openId, String(error.message || error)).catch(() => undefined);
      return fail({ code: 'replenish_write_failed', message, requestId, error });
    }
  });

  return {
    sessions,
    addSaleLine,
    clearDraft,
    submitSale,
    submitReplenish,
    // 给用例 / 排查用：这次提交的幂等键是怎么算出来的（与 purchaseWebhookService 的
    // `purchaseTaskId` 同一个思路：**确定性推导**，两端不必各写一份公式）。
    taskIdFor: (key) => `${config.replenish.taskIdPrefix}_${String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  };
};

module.exports = { createScanWriteService, createSalesEntryWithOrderNo };
