/**
 * 扫码入口的**两个写入口**：销售建单（一单多明细）与补货报单（采购申请）。
 *
 * 🔴 这个文件最要紧的一条：**本文件自己不写任何业务表**。
 *   · 销售：主表记录走**既有的**「全仓唯一创建销售主表记录」那个函数
 *     （`LarkMvpService.createSalesEntryWithOrderNo`，含单号分配与撞号复查）；
 *     明细 / 收款 / 四个状态维度 / 进度全部走**既有的** `SalesOrderService.confirm`
 *     （地址簿：`services/salesOrderService.js`）——与群聊入口、工作台入口**同一个函数**；
 *   · 采购：采购申请走**既有的** `PurchaseWebhookService.publishPurchaseRequest`
 *     （**免确认**那条路：写「报货批次」＋「报货信息」；它原先也是「信息填写」表变更
 *      事件走的那条路，那条入口已于 2026-10-09 退场、本函数一行没变），
 *     本文件只把"这次要补什么"给它。
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
// ⭐ 2026-10-11（A）：现货 ⇒ **提交即交付 + 扣库存**，走的就是这一条**既有交付链路**
//   （`SalesDeliveryService.deliver`：写「履约状态」+ 扣「实时库存」+ 写「库存流水」+ 写「库存状态」）。
//   ⚠️ 本文件**不写任何库存**：不 construct InventoryService、不调 applySale、
//      不认识 liveInventory / inventoryLedger（源码哨兵钉着这一条）。
const { SalesDeliveryService } = require('./salesDeliveryService');
const { textValue, linkedRecordIds } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { REPORT_BEHAVIOR } = require('./purchaseBehaviorPolicy');
// ⭐ 2026-10-09：扫码建单也要写**交易类型**（现货 / 预定），判据用既有的那一个：
//    「实时库存里有没有这一双」→ `salesTradeTypeForStock`（**唯一**判据，本文件不写死编码）。
// ⭐ 2026-10-11（A）：「**哪一种类型在提交这一刻就交付**」也来自既有注册表
//    （`deliversOnSubmit`，见 `config/salesMovements.js`）—— 本文件不写 'SALE_CASH' 字面量。
const { salesTradeTypeForStock } = require('../config/salesTradeTypePolicy');
const { deliversOnSubmit } = require('../config/salesMovements');
// 「这一件要不要尺码 / 要不要跟踪库存 / 要不要履约」——可售品的属性（配品：三样都不要）。
const { SELLABLE_KINDS, sellableKindOf } = require('../config/sellableKinds');
const { SCAN_WRITE, fillText } = require('../config/scanWrite');
const { createScanSessionService } = require('./scanSessionService');
const { logError, logInfo, logWarn } = require('../utils/logger');

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
  // ⭐ 交付（A）：现货行"提交即交付 + 扣库存"走的是**既有** `SalesDeliveryService.deliver`。
  //    同样延迟构造（只有真的提交了现货单才会用到它，连带它的库存引擎）。
  //    ⚠️ 用例可以注入 `options.delivery`（本文件不认识库存引擎，注入点只在这一处）。
  let deliveryInstance = options.delivery || null;
  const delivery = () => {
    if (!deliveryInstance) deliveryInstance = new SalesDeliveryService({ gateway });
    return deliveryInstance;
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
   * · 业务层自己的中文业务话（例：「本次收款超过本单实收金额」「尺码管理中找不到 41 码」）
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

  /** 金额 → 分（整数运算，**不拿浮点数比大小**：0.1 + 0.2 那类误差会误报）。 */
  const toCents = (value) => Math.round(Number(value || 0) * 100);

  /**
   * 分 → 她看的人话金额（整数不带小数点；带角分才给两位）。
   * 前缀（`¥`）在 `config/scanWrite.sale.moneyPrefix` —— 逻辑里不写死。
   */
  const moneyText = (value) => {
    const number = Number(value || 0);
    const text = Number.isInteger(number) ? String(number) : number.toFixed(2);
    return `${config.sale.moneyPrefix || ''}${text}`;
  };

  /**
   * ⭐⭐ **核心校验的人话**（业务负责人 2026-10-11：「必须相等，所以系统需要校验！」）。
   *
   * 说清三件事：① 每件实收合计多少 ② 收款合计多少 ③ **哪边多了 / 少了、差多少** ——
   * 她照着改一下就能再提交（不是"校验失败"四个字）。
   */
  /**
   * 「全付」那一档的人话：**每件实收合计 ≠ 收款合计**。
   *
   * @param {object} input
   * @param {number} input.itemsCents    每件实收合计（分）
   * @param {number} input.paymentsCents 收款行合计（分）
   * @param {boolean} [input.strict]     `true` = **全付档**（两边必须相等，包括"两边都是 0"）。
   *   ⚠️ 只有全付档才传 `strict`：部分付 / 未付两档**允许差一条【未收款】**，
   *      走各自的人话（部分付那句在 `partialAmountMismatchBody`）。
   */
  const amountMismatchMessage = ({ itemsCents, paymentsCents, strict = false }) => {
    const diffCents = Math.abs(paymentsCents - itemsCents);
    const side = itemsCents === 0 && !strict
      ? fillText(texts.amountMismatchNoItems, { diff: moneyText(diffCents / 100) })
      : fillText(
        paymentsCents > itemsCents ? texts.amountMismatchOver : texts.amountMismatchShort,
        { diff: moneyText(diffCents / 100) },
      );
    return fillText(texts.amountMismatchBody, {
      items: moneyText(itemsCents / 100),
      payments: moneyText(paymentsCents / 100),
      side,
    });
  };

  /** 一串原始金额（`line_amount` / `payment_amount` 同名重复 ⇒ 数组）→ 逐项原始字符串。 */
  const amountList = (value) => {
    if (Array.isArray(value)) return value.map((item) => (item === undefined || item === null ? '' : String(item)));
    if (value === undefined || value === null) return [];
    return [String(value)];
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

  /**
   * 「**其他配品**.单价」—— 配品行金额留空时的兜底（与鞋那一行的口径**同一条**：
   * 取那张表自己的「单价」；取不到就让她填，**绝不写 0**）。
   * ⚠️ 这是"现状口径的平移"，不是新规则：字段名来自 `v1BitableSchema`（`accessory.price`）。
   */
  const accessoryPrice = async (accessoryRecordId) => {
    const field = fieldOf('accessory', 'price');
    if (!field) return null;
    const record = await gateway.get('accessory', accessoryRecordId).catch(() => null);
    const value = Number(textValue(record?.fields?.[field]));
    return Number.isFinite(value) && value > 0 ? value : null;
  };

  /** 「其他配品.名称」——本单里要能看出加的是哪一件（只用于展示 / 会话）。 */
  const accessoryName = (record) => textValue(record?.fields?.[fieldOf('accessory', 'name')]).trim();

  /**
   * 「其他配品」清单（**只读 + 可缓存**）——用于页面上那个配品下拉。
   *
   * ⚠️ 复用**既有** `LarkMvpService.listAccessories`（它已经在做这件事：名称 / 种类、
   *    过滤掉没名字的）—— 与 `createSalesEntryWithOrderNo` 同一个手法：
   *    只借那**一个方法**（`.prototype.call`），不构造群聊入口那一整套依赖；
   *    延迟 require，避免把群聊那条链路的模块树拖进扫码页。
   * ⚠️ 缓存只影响"下拉里能选到哪几件"（`SCAN_SALE_ACCESSORY_CACHE_TTL_MS`，默认 30 秒），
   *    **不影响任何写库判据** —— 提交时以她选中的**记录 id** 为准（存不存在当场查）。
   * ⚠️ 读不到配品表**不该把整页拖垮**（她还能正常卖鞋）：记一条 warn、给空清单，**不缓存失败**。
   */
  let accessoryCache = { at: 0, value: null };
  const listAccessories = async () => {
    if (typeof options.listAccessories === 'function') return options.listAccessories();
    const ttl = Number(config.sale.accessoryCacheTtlMs) || 0;
    if (ttl > 0 && accessoryCache.value && now() - accessoryCache.at < ttl) return accessoryCache.value;
    try {
      // eslint-disable-next-line global-require
      const { LarkMvpService } = require('./larkMvpService');
      const value = await LarkMvpService.prototype.listAccessories.call({ gateway });
      accessoryCache = { at: now(), value };
      return value;
    } catch (error) {
      logWarn(config.events.failed, {
        reason: 'accessory_list_failed', error: String(error.message || error),
      });
      return [];
    }
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
   *
   * ⭐ 2026-10-09：「选的是库存里面的 → 现货；不是 → 预订」——
   *    调用方（路由）按**页面上那两个分组**给出 `inStock`（= 所选尺码在「样品 + 门盒」有没有货），
   *    这里用**既有判据** `salesTradeTypeForStock` 推成**既有行为编码**
   *    （`SALE_CASH` / `SALE_PREPAID`，取值在 `config/salesMovements.js`），
   *    落在会话的这一行上；提交时逐行写进「销售明细.交易类型」（既有业务层本来就支持逐行类型）。
   *    ⚠️ `inStock` 不是布尔（老页面 / 没传）时**留空**，不猜 —— 空着比写错方向好。
   *
   * @returns {Promise<{ok:boolean, code?:string, message?:string, count?:number, limit?:number}>}
   */
  const addSaleLine = async ({
    openId, kind = '', productRecordId = '', number = '', itemNo = '', color = '',
    size, amount = '', gift = '', accessoryRecordId = '', inStock, requestId = '',
  }) => {
    if (!config.sale.enabled) {
      return fail({ code: 'disabled', message: texts.writeDisabledBody, requestId });
    }
    // ⭐ 2026-10-11（B）：这一行是**鞋**还是**配品** —— 由调用方（路由按动作）给，
    //    **不取表单里的值**（手改表单也换不了可售品类型）。默认「鞋」= 既有调用点逐字不变。
    const kindKey = String(kind || '').trim() || 'shoe';
    const sellableKind = SELLABLE_KINDS[kindKey];
    if (!sellableKind) {
      return fail({ code: 'unknown_kind', message: texts.internalFailedBody, requestId });
    }
    const parsedAmount = positiveAmount(amount);
    if (!parsedAmount.ok) {
      const error = new Error(sellableKind.requiresSize ? texts.amountInvalidBody : texts.accessoryAmountInvalidBody);
      error.scanUserMessage = error.message;
      return fail({ code: 'amount_invalid', message: userMessageFor(error), requestId, error });
    }
    const giftText = String(gift ?? '').trim().slice(0, config.sale.giftMaxLength);

    // ── 配品这一行（B）：没有尺码、没有货号，实收金额单列（编号/尺码留空由业务层保证）──
    if (!sellableKind.requiresSize) {
      const accessoryId = String(accessoryRecordId || '').trim();
      if (!accessoryId) {
        const error = new Error(texts.accessoryMissingBody);
        error.scanUserMessage = texts.accessoryMissingBody;
        return fail({ code: 'accessory_missing', message: userMessageFor(error), requestId, error });
      }
      const record = await gateway.get('accessory', accessoryId).catch(() => null);
      if (!record) {
        const error = new Error(texts.accessoryUnknownBody);
        error.scanUserMessage = texts.accessoryUnknownBody;
        return fail({ code: 'accessory_unknown', message: userMessageFor(error), requestId, error });
      }
      const added = await queue.run(`sale:${openId}`, () => sessions.addLine(openId, {
        kind: kindKey,
        accessory_record_id: accessoryId,
        // 本单里要能看出是哪一件（**只落本地会话**；业务表那边由既有业务层按关联写）。
        accessory_name: accessoryName(record),
        // 金额留空就是 null（提交时按「其他配品.单价」兜底，与鞋那一行同一条口径）。
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
        kind: kindKey,
        accessory_record_id: accessoryId,
        count: added.count,
        request_id: requestId,
      });
      return { ok: true, count: added.count, limit: config.session.maxLines, session: added.session };
    }

    // ── 鞋（既有那一段，逐字不动）────────────────────────────────────────────
    const parsedSize = positiveInteger(size);
    if (parsedSize === null) {
      const error = new Error(texts.sizeMissingBody);
      error.scanUserMessage = texts.sizeMissingBody;
      return fail({ code: 'size_missing', message: userMessageFor(error), requestId, error });
    }
    // ⭐ 「现货 / 预订」：判据是**既有**的 `salesTradeTypeForStock`（有货 → 现货 / 没货 → 预订）。
    const tradeTypeCode = typeof inStock === 'boolean' ? salesTradeTypeForStock({ inStock }) : '';
    const added = await queue.run(`sale:${openId}`, () => sessions.addLine(openId, {
      kind: kindKey,
      number: String(number || '').trim(),
      item_no: String(itemNo || '').trim(),
      color: String(color || '').trim(),
      product_record_id: String(productRecordId || '').trim(),
      size: parsedSize,
      // ⭐ 这一行自己的交易类型编码（提交时写进「销售明细.交易类型」；空串 = 还没定，不猜）。
      trade_type_code: tradeTypeCode,
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
      kind: kindKey,
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

  /**
   * 「这一行要不要在**提交这一刻**交付并扣库存」——A 的唯一判据处，两个判据都来自既有配置：
   *   · 可售品属性（`config/sellableKinds`）：**配品没有鞋、不跟踪库存 ⇒ 天然不参与交付**；
   *   · 交易类型（`config/salesMovements.deliversOnSubmit`）：**现货 ⇒ 提交即交付**，
   *     预定 / 认不出的编码 ⇒ 不交付（预定等货到了再交付、那时才扣库存）。
   * ⚠️ 这里**不写** `'SALE_CASH'` / `'shoe'` 这类字面量（散落出去就会与配置漂移）。
   */
  const lineDeliversOnSubmit = (item) => {
    const kind = sellableKindOf(item);
    if (!(kind.requiresFulfillment && kind.tracksInventory)) return false;
    return deliversOnSubmit(String(item.tradeTypeCode || '').trim());
  };

  /**
   * 现货行：提交即交付 + 扣库存 —— 走**既有** `SalesDeliveryService.deliver` 那一条**唯一**通路。
   *
   * ⚠️ 本函数自己不写任何一个库存字段：它只把"哪几条明细"交给既有交付服务，
   *    把结果**如实**折成 `{ requested, delivered, failed, reasons }`。
   * ⚠️ 失败**不吞**：逐条的失败（`invoice.failures`）与整段抛出的失败都回到 `reasons` 里，
   *    由上层（路由 / 页面）如实说出来；明细的「履约状态」由交付服务决定（没扣成就不会写已交付）。
   *
   * @returns {Promise<{requested:number, delivered:number, failed:number, reasons:string[]}>}
   */
  const deliverStockLines = async ({ items, detailRecordIds, paymentRecordIds, salesEntryRecordId, correlation }) => {
    const deliverable = items
      .map((item, index) => ({ item, detailRecordId: String(detailRecordIds?.[index] || '') }))
      .filter(({ item, detailRecordId }) => detailRecordId && lineDeliversOnSubmit(item));
    if (!deliverable.length) return { requested: 0, delivered: 0, failed: 0, reasons: [] };
    const detailIds = deliverable.map(({ detailRecordId }) => detailRecordId);
    try {
      const invoice = await delivery().deliver({
        salesEntryRecordId,
        detailRecordIds: detailIds,
        paymentRecordIds,
        occurredAt: now(),
      }, { correlation });
      const failures = invoice?.failures || [];
      return {
        requested: detailIds.length,
        delivered: detailIds.length - failures.length,
        failed: failures.length,
        reasons: failures.map((failure) => String(failure?.error || '').trim()).filter(Boolean),
      };
    } catch (error) {
      // 交付这一段**整体抛**（例：明细不属于这一单 / 主表还没入账 / 库存校验失败）：
      // 同样如实报"这几双没交付"，绝不吞掉、也绝不假装成功。
      logError(config.events.stockFailed, {
        sales_entry_record_id: salesEntryRecordId, detail_ids: detailIds,
        error: String(error.message || error), ...correlation,
      });
      return {
        requested: detailIds.length,
        delivered: 0,
        failed: detailIds.length,
        reasons: [String(error.message || error)],
      };
    }
  };

  // ── 销售：提交整单（**唯一的写库时机**）──────────────────────────────────
  /**
   * 提交"本单"：**一张销售主表 + N 条明细（一单一双一行）**。
   *
   * ⭐⭐ 2026-10-11（业务负责人**最终口径**，唯一权威）：这一层是"**总单层**"——
   *   ① **每件实收**（`lineAmounts`，按下标对应本单的明细行）→ 落**销售明细.「实收金额」**；
   *      没填（空）⇒ 读那张表的「单价」当落点；两边都取不到 ⇒ 人话拦住，**绝不写 0**。
   *      🔴 **没有第二个金额概念**（她只填「实收金额」，代码里也不再提旧列名）。
   *   ② **「付款情况」三档**（`paymentStatus`，整单口径，默认**全付**）：
   *      · **全付** —— 按**收款方式**写收款明细（1 条或多条）；
   *        🔴 **收款合计必须 == 每件实收合计**；不等 ⇒ **拦住、一个字都不写** + 人话说明差额；
   *      · **部分付** —— 资金区填**实付多少**（`paidAmount`）⇒ 按方式写已收的那几条
   *        （状态 = 既有「已收款」）＋ ⭐ **差额写一条【未收款】**（金额 = 每件实收合计 − 已收合计）；
   *      · **未付** —— 不用填 ⇒ ⭐ **写一条【未收款】**（金额 = 每件实收合计）。
   *
   * ⚠️ **三档都只跟"这个单子所有的实收金额加起来"比**，
   *    **绝不引入"应收 / 单价"当判据**（她逐字：「只跟"这个单子所有的实收金额加起来"比，
   *    不跟应收/单价相比」）—— 「单价」只出现在"她没填实收时的落点"那一步（在比对**之前**
   *    就已经算进 `itemsCents`，所以比对仍然只对着"每件实收金额"）。
   * ⚠️ 那一条【未收款】**不是扫码侧自己拼出来的**：本文件算出差额 → 交给**既有业务层**
   *    `SalesOrderService.confirm({ owed })`，由它按既有协议追加
   *    （`PaymentService.recordInitialBatch` → 状态「未收款」、**方式留空**、关联既有销售单）。
   *    🔴 本文件因此仍然**不写任何业务表**（源码哨兵钉着）。
   *
   * @param {object} input
   * @param {string} input.openId   录单人（会话按他分）
   * @param {string} input.submitKey 表单带回来的幂等键（连点两次 = 同一把）
   * @param {Array<{method:string, amount:string|number}>} [input.payments]
   *        多笔收款（表单里同名重复的 `payment_method` / `payment_amount` 按行拼出来的）。
   *        ⚠️ 某一行**金额空** ⇒ 这一行不用（方式选了也不算）；填了金额 ⇒ **方式必填**。
   * @param {Array<string|number>} [input.lineAmounts]
   *        **每件实收**（提交表单里那一排输入框，顺序 = 本单的明细行顺序）。
   *        这一项没带（例：本单条上那颗快捷提交）⇒ 用会话里已经记下的值。
   * @param {string} [input.paymentStatus] **「付款情况」**（整单）：`全付` / `部分付` / `未付`；
   *        没带（老页面 / 直接调服务）⇒ 按配置的默认档（**全付**）走。
   * @param {string|number} [input.paidAmount] 「部分付」时资金区填的**实付多少**。
   */
  const submitSale = async ({
    openId, submitKey, payments: paymentRows = [], lineAmounts = [],
    paymentStatus = '', paidAmount = '', requestId = '',
  }) => queue.run(`sale:${openId}`, async () => {
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

    // ── ① 每件实收（**总单层那一排输入框**；没带这一项就用会话里已经记下的值）────────
    //    ⚠️ 这一项**先落回本地会话**（只动 `data/scan_sessions/` 那一份草稿，**不碰业务表**）：
    //       · 差额页要把她刚填的数回显出来（不用重打）；
    //       · "写了一半崩掉"的**重试**要接着同一份草稿写（与 `master_record_id` 同一个道理）。
    const postedLineAmounts = amountList(lineAmounts);
    const hasPostedLineAmounts = postedLineAmounts.length > 0;
    const resolvedLines = [];
    for (const [index, line] of lines.entries()) {
      const raw = hasPostedLineAmounts && index < postedLineAmounts.length
        ? postedLineAmounts[index]
        : (line.amount === null || line.amount === undefined ? '' : String(line.amount));
      const parsed = positiveAmount(raw);
      if (!parsed.ok) {
        const sellableKind = SELLABLE_KINDS[String(line.kind || '').trim() || 'shoe'];
        const message = sellableKind && !sellableKind.requiresSize
          ? texts.accessoryAmountInvalidBody : texts.amountInvalidBody;
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'line_amount_invalid', message, requestId, error });
      }
      resolvedLines.push({ ...line, amount: parsed.value, explicit_amount: parsed.value !== null });
    }
    if (hasPostedLineAmounts) {
      await sessions.saveSaleProgress(openId, { lines: resolvedLines });
    }

    // ── ①' ⭐⭐ 每件实收的**落点**：留空的那些先补上（鞋读「货品信息.单价」/ 配品读「其他配品.单价」）。
    //    🔴 为什么必须**在比对之前**做（2026-10-11 修正的一处真 bug）：
    //       「付款情况」三档都只跟"每件实收金额加起来"比 —— 而"每件实收"的**落点**
    //       就是明细上那一个数。留空时若等到建明细那一步才读单价，
    //       比对就会拿着 **0** 去算，「未付 / 部分付」两档的【未收款】差额会算成 0，等于没记。
    //    ⚠️ 取不到单价 ⇒ **当场人话拦住**（绝不写 0、也绝不写一条金额为 0 的未收款）。
    //    ⚠️ 这一步**只读**（`gateway.get('product' / 'accessory')`）—— 一个字节都不写库。
    for (const line of resolvedLines) {
      if (line.explicit_amount) continue;                 // 她填了 ⇒ 就用她填的
      if (config.sale.amountFallback !== 'product_price') continue; // 兜底方式可配（关掉就不兜底）
      const kindKey = String(line.kind || '').trim() || 'shoe';
      const sellableKind = SELLABLE_KINDS[kindKey];
      const isAccessory = Boolean(sellableKind && !sellableKind.requiresSize);
      const fallback = isAccessory
        ? await accessoryPrice(String(line.accessory_record_id || '').trim())
        : await productPrice(String(line.product_record_id || '').trim());
      if (!Number.isFinite(fallback) || fallback <= 0) {
        const message = isAccessory
          ? fillText(texts.accessoryAmountMissingBody, { name: line.accessory_name || '' })
          : fillText(texts.amountMissingBody, { itemNo: line.item_no || line.number || '' });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({
          code: isAccessory ? 'accessory_amount_missing' : 'line_amount_missing', message, requestId, error,
        });
      }
      line.amount = Math.round(fallback * 100) / 100;
    }

    // ── ② 多笔收款（可增删行：**填了金额的行才算一笔**）────────────────────────────
    const usedPayments = [];
    for (const row of (Array.isArray(paymentRows) ? paymentRows : [])) {
      const parsed = positiveAmount(row?.amount);
      if (!parsed.ok) {
        const error = new Error(texts.paymentAmountInvalidBody);
        error.scanUserMessage = texts.paymentAmountInvalidBody;
        return fail({ code: 'payment_amount_invalid', message: userMessageFor(error), requestId, error });
      }
      // 金额空 ⇒ 这一行不用（方式选了也不算）；**金额填了就必须有方式**。
      if (parsed.value === null) continue;
      const method = String(row?.method || '').trim();
      if (!method) {
        const error = new Error(texts.paymentRowIncompleteBody);
        error.scanUserMessage = texts.paymentRowIncompleteBody;
        return fail({ code: 'payment_row_incomplete', message: userMessageFor(error), requestId, error });
      }
      usedPayments.push({ amount: parsed.value, method, operatorOpenId: openId });
    }

    // ── ③ ⭐⭐ 「付款情况」（整单）→ 收款明细的写法 ──────────────────────────────
    //    她 2026-10-11 的最终口径（唯一权威），三档：
    //      · **全付**（默认）：收款合计 **必须 ==** 每件实收合计；
    //      · **部分付**：只写她填的那几条（状态 = 既有「已收款」）＋差额一条【未收款】；
    //      · **未付**：不填 ⇒ 一条【未收款】（金额 = 每件实收合计）。
    //    ⚠️ 三档都**只跟"每件实收金额加起来"比**（`itemsCents`）—— 这里没有"应收/单价"这个判据。
    //    ⚠️ 比大小用**分**（整数），不拿浮点数比：0.1 + 0.2 ≠ 0.3 那类误差会误报。
    const itemsCents = resolvedLines.reduce((sum, line) => sum
      + (line.amount === null || line.amount === undefined ? 0 : toCents(line.amount)), 0);
    const paymentsCents = usedPayments.reduce((sum, payment) => sum + toCents(payment.amount), 0);
    const statusValues = (config.sale.paymentStatus?.values) || [];
    const statusDefault = config.sale.paymentStatus?.default || '';
    // ⚠️ 逻辑里**只认语义键**（`mode.full` / `mode.partial` / `mode.unpaid`）——
    //    取值本身是可配的中文（改一句话、换一个说法都不该动逻辑）。
    const statusMode = config.sale.paymentStatus?.mode || {};
    // 老页面 / 直接调服务时**没带**这一项 ⇒ 用配置的默认档（她定的「全付（默认）」）。
    const statusRaw = String(paymentStatus ?? '').trim();
    const payMode = statusRaw || statusDefault;
    if (!statusValues.includes(payMode)) {
      // 手改表单塞了第四种取值 ⇒ 人话拦住（**不静默当成某一档**：猜错档位会写错账）。
      logWarn(config.events.failed, {
        session_id: current.session_id, submit_key: key, reason: 'payment_status_invalid',
        payment_status: statusRaw, request_id: requestId,
      });
      const error = new Error(texts.paymentStatusInvalidBody);
      error.scanUserMessage = texts.paymentStatusInvalidBody;
      return fail({
        code: 'payment_status_invalid', message: texts.paymentStatusInvalidBody, requestId, error,
      });
    }
    // 这一步之后要交给既有业务层的**收款那一半**：
    //   · `payments` = 真收到钱的那几条（状态由业务层落成既有「已收款」）；
    //   · `owed`     = 差额（> 0 时业务层按既有协议补一条【未收款】，**方式留空**）。
    //     走 `owed` 而不是让扫码侧自己拼一条「未收款」：那一条的形状（状态取值 / 方式留空 /
    //     不写「交易方向」）是既有业务层的口径，这里一个字段都不重复实现。
    let payments = usedPayments;
    let owedCents = 0;
    if (payMode === statusMode.full) {
      // ── 全付：**只有这一档必须相等**（连"两边都是 0"也算不等：全付 0 元不成话）──
      if (itemsCents !== paymentsCents) {
        const message = amountMismatchMessage({ itemsCents, paymentsCents, strict: true });
        logWarn(config.events.amountMismatch, {
          session_id: current.session_id, submit_key: key, payment_status: payMode,
          items_cents: itemsCents, payments_cents: paymentsCents,
          detail_count: resolvedLines.length, payment_count: payments.length, request_id: requestId,
        });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'amount_mismatch', message, requestId, error, extra: { result: { amount: {
          items: itemsCents, payments: paymentsCents, diff: paymentsCents - itemsCents,
        } } } });
      }
    } else {
      const partial = payMode === statusMode.partial;
      let paidCents = paymentsCents;
      if (partial) {
        // ── 部分付：资金区填的"实付多少"与收款行合计**必须一致**（都是"已经收到的钱"）──
        const parsedPaid = positiveAmount(paidAmount);
        if (!parsedPaid.ok) {
          const error = new Error(texts.paymentAmountInvalidBody);
          error.scanUserMessage = texts.paymentAmountInvalidBody;
          return fail({ code: 'payment_amount_invalid', message: userMessageFor(error), requestId, error });
        }
        if (parsedPaid.value === null) {
          const message = fillText(texts.partialAmountMissingBody, { payments: moneyText(paymentsCents / 100) });
          logWarn(config.events.failed, {
            session_id: current.session_id, submit_key: key, reason: 'partial_amount_missing',
            payments_cents: paymentsCents, request_id: requestId,
          });
          const error = new Error(message);
          error.scanUserMessage = message;
          return fail({ code: 'partial_amount_missing', message, requestId, error });
        }
        paidCents = toCents(parsedPaid.value);
        if (paidCents !== paymentsCents) {
          const message = fillText(texts.partialAmountMismatchBody, {
            paid: moneyText(paidCents / 100), payments: moneyText(paymentsCents / 100),
          });
          logWarn(config.events.amountMismatch, {
            session_id: current.session_id, submit_key: key, payment_status: payMode,
            items_cents: itemsCents, paid_cents: paidCents, payments_cents: paymentsCents,
            request_id: requestId,
          });
          const error = new Error(message);
          error.scanUserMessage = message;
          return fail({ code: 'partial_amount_mismatch', message, requestId, error });
        }
      }
      // 已收的钱**不许超过**每件实收合计（部分付填多了 / 未付却带了收款行）——
      // 既有业务层也会拦（「本次收款超过本单实收金额」），这里先拦是为了给她**带差额的人话**，
      // 而且**一个字都不写库**（拦在建主表之前）。
      if (paidCents > itemsCents) {
        const message = amountMismatchMessage({ itemsCents, paymentsCents: paidCents });
        logWarn(config.events.amountMismatch, {
          session_id: current.session_id, submit_key: key, payment_status: payMode,
          items_cents: itemsCents, payments_cents: paidCents, request_id: requestId,
        });
        const error = new Error(message);
        error.scanUserMessage = message;
        return fail({ code: 'amount_mismatch', message, requestId, error, extra: { result: { amount: {
          items: itemsCents, payments: paidCents, diff: paidCents - itemsCents,
        } } } });
      }
      // ⭐ 差额 ⇒ 一条【未收款】。她 2026-10-11 原话：
      //    · 部分付「差额在收款明细里写一条是未收款」；
      //    · 未付  「差额在收款明细里写一条是未收款」。
      //    ⇒ 两档**同一个落点**，只是 未付 的"已收"天然是 0。
      //    ⚠️ 那一条**不由本文件拼**：只把差额（`owed`）交给既有业务层，它自己写
      //       「收款金额」「关联销售单」与那个**既有的**收款状态取值 —— 连那个取值的中文
      //       都不在本文件里（源码哨兵：扫码侧不许把状态取值写死，见 AC-7y）。
      owedCents = itemsCents - paidCents;
      if (payMode === statusMode.unpaid) payments = [];
    }

    // ④ 逐行把明细准备好（每件实收留空 → 用那张表自己的「单价」；取不到就让她填，绝不写 0）。
    const items = [];
    for (const line of resolvedLines) {
      // ⚠️ `SELLABLE_KINDS` 里的一行**没有 `key`**（`key` 是 `sellableKindOf` 补上去的）
      //    —— 这里自己补上，别拿 `undefined` 当 kind 传给业务层（那会被当成"鞋"）。
      const kindKey = String(line.kind || '').trim() || 'shoe';
      const sellableKind = SELLABLE_KINDS[kindKey]
        ? { key: kindKey, ...SELLABLE_KINDS[kindKey] }
        : { key: 'shoe', ...SELLABLE_KINDS.shoe };
      // ── 配品那一行（B）：`配品` 有值、**编号 / 尺码留空**、实收金额单列 ──────────
      //    ⚠️ 它不参与交付 / 库存扣减（没有鞋）—— 交付那一步按可售品属性天然跳过（见 A 段）。
      if (sellableKind && !sellableKind.requiresSize) {
        const accessoryRecordId = String(line.accessory_record_id || '').trim();
        if (!accessoryRecordId) {
          const error = new Error(texts.accessoryMissingBody);
          error.scanUserMessage = texts.accessoryMissingBody;
          return fail({ code: 'line_accessory_missing', message: userMessageFor(error), requestId, error });
        }
        // ⚠️ 金额**已经在 ①' 那一步定稿**（她填的 / 留空读单价的落点都在那里算完）
        //    —— 这里不再兜底读一次价（同一个数算两遍 = 两处口径）。
        const accessoryAmount = Number(line.amount);
        items.push({
          kind: sellableKind.key,
          // 既有业务层按可售品配置决定落哪个字段（「销售明细.配品」）——本文件不写字段名。
          accessoryRecordId,
          quantity: 1,
          actualAmount: Math.round(accessoryAmount * 100) / 100,
          giftDescription: String(line.gift || '').trim(),
          // 配品没有货号 / 尺码 ⇒ 没有"现货 / 预订"这回事：**不写**交易类型（空着比写错好）。
          tradeTypeCode: '',
        });
        continue;
      }
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
      // ⚠️ 同上：金额已经定稿（见 ①'）。
      const actualAmount = Number(line.amount);
      items.push({
        kind: (sellableKind && sellableKind.key) || 'shoe',
        productRecordId,
        size,
        quantity: 1,
        actualAmount: Math.round(actualAmount * 100) / 100,
        // ⭐ 赠品：一件明细的赠品文本 —— 落点是**销售主表**那一列（合并规则在
        //    `config/salesGift` + `salesOrderService`，这里只把她的输入传下去）。
        giftDescription: String(line.gift || '').trim(),
        // ⭐ 这一行自己的交易类型（现货 / 预订，既有行为编码）。
        //    既有业务层按它解析「行为管理」记录、写进「销售明细.交易类型」；
        //    解析不到不阻塞入账（退回主表那条 / 留空），与它原来的口径一字不差。
        tradeTypeCode: String(line.trade_type_code || '').trim(),
      });
    }

    logInfo(config.events.saleSubmitting, {
      session_id: current.session_id, submit_key: key, line_count: items.length,
      payment_count: payments.length, payment_status: payMode, owed: owedCents / 100,
      request_id: requestId,
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
      //    ⭐ `owed`（元）= 上面算出来的差额 ⇒ 既有业务层**按既有协议**补那一条【未收款】
      //       （状态「未收款」、**方式留空**、关联既有销售单、**不写交易方向**）。
      //       为 0 ⇒ 不传（`0` 与"没说欠"在业务层是同一个意思，见 salesOrderService 的 owed 段）。
      const result = await sales().confirm({
        salesEntryRecordId,
        items,
        payments,
        ...(owedCents > 0 ? { owed: owedCents / 100 } : {}),
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
      // ⭐ `paid_amount` = **真收到钱的那几条**（她填的收款行）之和；
      //    `owed_amount` = 那一条【未收款】的差额（部分付 / 未付两档才有）。
      //    ⚠️ 两笔数**分开报**，不合成一个"收款合计"：合成之后她就分不清
      //       "这单收了多少现金"和"这单还欠多少"。
      const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
      const summary = {
        order_no: result.sourceNo || orderNo,
        sales_entry_record_id: salesEntryRecordId,
        detail_count: detailCount,
        payment_count: paymentCount,
        paid_amount: paidAmount,
        owed_amount: owedCents / 100,
        payment_status: payMode,
      };
      // ⑥ ⭐ 2026-10-11（A）：**现货 ⇒ 提交即交付 + 扣库存**。
      //    她 2026-10-09 的原话：「选现货 ⇒ 提交就直接当已交付并扣库存，这个肯定是的」。
      //    ⚠️ 交付**只走既有那一条**（`SalesDeliveryService.deliver`）—— 本文件不写一个库存字段。
      //    ⚠️ 逐行判：现货行交付、预定行不交付（`deliversOnSubmit` 读的是既有注册表）；
      //       配品行（没有鞋、不跟踪库存）**天然被排除**在交付之外（可售品属性说了算）。
      //    ⚠️ 明细 id 与 `items` **一一对应**（既有 `confirm` 就是按这个顺序建行的，群聊链路
      //       的 `deliverableItemIndexes` 也是同一个约定），所以这里按下标取。
      const stock = await deliverStockLines({
        items, detailRecordIds: result.detailRecordIds || [], paymentRecordIds: result.paymentRecordIds || [],
        salesEntryRecordId, correlation,
      });
      if (stock.failed > 0) {
        // 🔴 **失败要如实报错**：单子写了（货 / 钱是事实），但库存没扣成这件事必须回给她，
        //    而且**不许**把这一单记成"提交完成"—— 否则重试入口就没了，那一双永远扣不掉。
        //    ⚠️ 这里的 ok 仍是 true（销售主表 / 明细 / 收款确实写成了）；"哪一半没成"
        //       由 `stock` 如实表达，页面按 `stock.failed > 0` 渲染一张如实的结果页。
        logError(config.events.stockFailed, {
          session_id: current.session_id, submit_key: key, ...summary,
          stock_requested: stock.requested, stock_failed: stock.failed,
          reasons: stock.reasons.join(' | '), request_id: requestId,
        });
        return { ok: true, reused: false, stock, ...summary, order_no: summary.order_no };
      }
      await sessions.completeSale(openId, { key, result: summary });
      logInfo(config.events.saleSubmitted, {
        session_id: current.session_id, submit_key: key, ...summary,
        funds_recorded: paymentCount > 0,
        stock_requested: stock.requested, stock_delivered: stock.delivered, request_id: requestId,
      });
      return { ok: true, reused: false, stock, ...summary };
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

    // ① 校验：勾了哪些尺码、每个几双（勾了不填数量按 1 双 —— 每条明细至少一双）。
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
      //    那条文字报单链路退场之前取的也是**同一个字段** ⇒ 出图分组口径没变）。
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
        // ⛔ 2026-10-09：这里原有 `report_record_id: ''`（"扫码补货没有报单记录 ⇒ 留空"）
        //   —— 「信息填写」整表被删之后，**报单记录这个身份彻底不存在了**，
        //   计划（`ensurePostingPlan`）里那个字段也一起删了 ⇒ 不再往下传。
        behavior_record_id: behavior.recordId,
        behavior_kind: REPORT_BEHAVIOR.PURCHASE_REQUEST,
      }));
      const draft = {
        // ⚠️ 2026-10-09：`is_batch: true` 保留着 —— 它只是"这一次提交是**一批**明细"的标记，
        //   走同一条计划/幂等代码；原先那两行 `report_record_id` / `report_record_ids`
        //   （报单记录清单）**已删除**：报单记录这个身份随「信息填写」退场消失了，
        //   "回写报单记录状态"那一步在 `confirmPurchaseRequest` 里也整段删掉了。
        is_batch: true,
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
    // ⭐ 页面上的配品下拉要的清单（只读；复用既有 LarkMvpService.listAccessories + 短缓存）。
    listAccessories,
    // 给用例 / 排查用：这次提交的幂等键是怎么算出来的（与 purchaseWebhookService 的
    // `purchaseTaskId` 同一个思路：**确定性推导**，两端不必各写一份公式）。
    taskIdFor: (key) => `${config.replenish.taskIdPrefix}_${String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
  };
};

module.exports = { createScanWriteService, createSalesEntryWithOrderNo };
