/**
 * 扫码入口的**三个写入口**：销售建单（一单多明细）· 补货报单（采购申请）· **采购退货**（2026-10-11 加）。
 *
 * 🔴 这个文件最要紧的一条：**本文件自己不写任何业务表**。
 *   · 销售：主表记录走**共享处理层**的「全仓唯一创建销售主表记录」那个函数
 *     （`services/salesEntryService.createSalesEntryWithOrderNo`，含单号分配与撞号复查；
 *      2026-10-11 从 `larkMvpService` 剥出，群聊入口与扫码入口共用同一份）；
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
const { KeyedSerialQueue } = require('../../infrastructure/keyedSerialQueue');
const { JsonTaskStore } = require('../../infrastructure/jsonTaskStore');
const { V1ReferenceResolver } = require('../v1ReferenceResolver');
const { SalesOrderService } = require('../salesOrderService');
const { SalesStatusWriter } = require('../salesStatusWriter');
// ⭐ 2026-10-11（A）：现货 ⇒ **提交即交付 + 扣库存**，走的就是这一条**既有交付链路**
//   （`SalesDeliveryService.deliver`：写「履约状态」+ 扣「实时库存」+ 写「库存流水」+ 写「库存状态」）。
//   ⚠️ 本文件**不写任何库存**：不 construct InventoryService、不调 applySale、
//      不认识 liveInventory / inventoryLedger（源码哨兵钉着这一条）。
const { SalesDeliveryService } = require('../salesDeliveryService');
const { textValue } = require('../v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../../config/v1BitableSchema');
// ⭐⭐ 2026-10-15（⑤ 模块化）：**后台那一半**（调度 + 失败标记 + "等它跑完"的登记簿）已剥成独立一件。
//   ⚠️ 只**单向** require（新件不认识本文件 ⇒ **不会循环依赖** ✓）；
//   ⚠️ `waitForPendingSaleBackgrounds` 继续从**本模块**导出（用例的 import **一个字都没改** ✓）。
const {
  createSaleWriteBackgroundService,
  waitForPendingSaleBackgrounds,
} = require('../saleWriteBackgroundService');
// ⭐ 2026-10-09：扫码建单也要写**交易类型**（现货 / 预定），判据用既有的那一个：
//    「实时库存里有没有这一双」→ `salesTradeTypeForStock`（**唯一**判据，本文件不写死编码）。
// ⭐ 2026-10-11（A）：「**哪一种类型在提交这一刻就交付**」也来自既有注册表
//    （`deliversOnSubmit`，见 `config/salesMovements.js`）—— 本文件不写 'SALE_CASH' 字面量。
const { salesTradeTypeForStock } = require('../../config/salesTradeTypePolicy');
const { SCAN_WRITE } = require('../../config/scanWrite');
const { createScanSessionService } = require('../scanSessionService');
// ⭐ 2026-10-29：收款方式统一走 configTableCache（事件失效 + TTL + lastGood），
//   不再保留本文件自己的短 TTL 缓存。
const { getConfigRows } = require('../configTableCache');
// ⭐ 2026-10-18（第 4 步提速 · 文件大小门禁）：只读引用缓存 / 交付那一步 / 一次收口接线
//   都搬到 `services/sales/*`（本文件是存量超限件，基线只许变小）—— 纯搬家，逻辑未改 ✓
const { createReadOnlyReferenceCache } = require('../sales/referenceReadCache');
const { createDeliveryStep } = require('../sales/deliveryStep');
const { logError, logInfo, logWarn } = require('../../utils/logger');
const { createScanWriteHelpers } = require('./helpers');
const { createScanWriteSession } = require('./session');
const { createScanWriteSales } = require('./sales');
const { createScanWritePurchase } = require('./purchase');

/**
 * 「全仓唯一创建销售主表记录」的那个函数 —— **只 require 调用，不改它一个字**。
 *
 * ⚠️ 2026-10-11（清群聊入口 C0）：它原先长在 `LarkMvpService.prototype` 上，
 *   扫码页靠 `.prototype.call({gateway})` 借用 —— 于是"删群聊入口"会连扫码建单
 *   一起删掉（扫码被群聊入口绑住了）。现在这个函数搬进了**共享处理层**
 *   `services/salesEntryService.js`（群聊入口与扫码入口**共用**同一份建单/单号逻辑），
 *   扫码页直接 require 它。
 *   ⚠️ **不再经 `LarkMvpService`**：那个类的构造函数会连带构造采购 / 售后 / 样品 /
 *      本地任务存储等一整套**群聊入口**的东西，扫码页一个字都不需要。
 */
const createSalesEntryWithOrderNo = async (gateway, task, options = {}) => {
  // 延迟 require：与原来同一个理由（把扫码页模块加载路径上的依赖树压到最小）。
  // eslint-disable-next-line global-require
  const { createSalesEntryWithOrderNo: createEntry } = require('../salesEntryService');
  return createEntry({ gateway }, task, options);
};

const createScanWriteService = (options = {}) => {
  if (!options.gateway) throw new Error('ScanWriteService requires gateway');
  const gateway = options.gateway;
  const schema = options.schema || V1_BITABLE_SCHEMA;
  const config = options.config || SCAN_WRITE;
  const texts = config.texts;
  const {
    fieldOf, fail, userMessageFor, positiveAmount, toCents, moneyText,
    amountMismatchMessage, amountList, positiveInteger, sessionKeyOf,
  } = createScanWriteHelpers({ schema, config, logError });
  // ⭐⭐ 2026-10-15（⑰ 异步）：异步开关的取值口（默认 = 配置 `config.sale.asyncWrite`）——
  //   ⚠️ 可注入（`options.saleAsyncWrite`）**为的是用例**：同一个文件里要同时验"开着（异步）"
  //   与"关着（老路径逐字同形）"两种行为 ✓（配置对象是 frozen 的，改不了 ✗）。
  const saleAsync = options.saleAsyncWrite || config.sale.asyncWrite || {};
  const now = options.now || (() => Date.now());
  // ⭐⭐ 2026-10-12：**只读引用缓存**只喂给"会读引用表"的那几个**延迟构造**的业务服务。
  //    🔴 不做全局替换：写判据那几张表（主表 / 明细 / 收款 / 实时库存 / 库存流水）
  //       本来就不在白名单里，进不进这条网关都是直通。
  //    ⚠️ `options.readCache === false` = 显式关掉（用例可以关；`config.readCache.enabled` 也可以）。
  const readGateway = options.readCache === false
    ? gateway
    : createReadOnlyReferenceCache(gateway, options.readCache || config.readCache, now);
  const sessions = options.sessions || createScanSessionService({
    config, dir: options.sessionDir, store: options.sessionStore, now,
  });
  const references = options.references || new V1ReferenceResolver(readGateway);
  const createEntry = options.createSalesEntry || createSalesEntryWithOrderNo;
  // 按录单人串行（同一部手机连点 / 重放会落在同一个 key 上）。
  const queue = options.queue || new KeyedSerialQueue();
  const {
    addSaleLine, clearDraft, saveDraftLines,
  } = createScanWriteSession({
    queue, sessions, config, fail, userMessageFor,
    positiveAmount, positiveInteger, sessionKeyOf, logInfo, now,
  });

  // 业务层实例**延迟构造**：扫码页第一版是只读的，绝大多数请求（看库存）不该因为
  // 构造销售 / 采购那一整套依赖而变慢。用到才建。
  let salesInstance = options.sales || null;
  const sales = () => {
    if (!salesInstance) salesInstance = new SalesOrderService({ gateway: readGateway });
    return salesInstance;
  };
  let statusInstance = options.status || null;
  const status = () => {
    if (!statusInstance) statusInstance = new SalesStatusWriter({ gateway: readGateway });
    return statusInstance;
  };
  // 收口写「写入状态」：兼容注入的假 writer（测试里有的只实现 write）。
  const writeFinalStatus = (writer, id, value, correlation) => (
    typeof writer?.writeFinal === 'function'
      ? writer.writeFinal(id, value, correlation)
      : writer.write(id, { writeStatus: value }, correlation)
  );

  // ⭐⭐ 2026-10-15（⑤ 模块化 · 外部评审建议 · 业务负责人定的「重中之重」）：
  //   **后台那一半**（`scheduleSaleRest` 调度 + `markSaleWriteFailed` 失败标记
  //   + "等它跑完"的登记簿）已剥成独立一件 `services/saleWriteBackgroundService.js`
  //   ⇒ 本文件**只管提交** ✓（以后改后台调度**不再碰主链路** ✓）。
  //   🔴 **只挪不改**：接口 / 日志事件名与字段 / `submitKey` 幂等 / 状态值域 / `_confirm`
  //      （仍然绝不许直调）**逐字未动** ✗；`scheduleSaleRest` 与 `markSaleWriteFailed`
  //      这两个名字在本文件里**照旧可用**（下面解构出来）⇒ 调用点与用例**一个字都没改** ✓
  let submitSale = null;
  const { scheduleSaleRest, markSaleWriteFailed } = createSaleWriteBackgroundService({
    // ⚠️ **延迟**引用：`submitSale` 在本函数**下面**才定义 ⇒ 传 lambda（真正调用发生在请求期 ✓）
    submitSale: (input, options) => submitSale(input, options),
    saleAsync,
    config,
    status,
  });

  // ⭐ 交付（A）：现货行"提交即交付 + 扣库存"走的是**既有** `SalesDeliveryService.deliver`。
  //    同样延迟构造（只有真的提交了现货单才会用到它，连带它的库存引擎）。
  //    ⚠️ 用例可以注入 `options.delivery`（本文件不认识库存引擎，注入点只在这一处）。
  let deliveryInstance = options.delivery || null;
  const delivery = () => {
    if (!deliveryInstance) deliveryInstance = new SalesDeliveryService({ gateway: readGateway });
    return deliveryInstance;
  };
  // ⭐ 2026-10-18（第 4 步提速）：交付那一步（现货 ⇒ 提交即交付 + 扣库存）在 `services/sales/deliveryStep.js`
  //   —— 纯搬家（判据/顺序/日志/返回值一个字没改）；这里只把它装配起来 ✓
  const { deliverStockLines } = createDeliveryStep({
    delivery, now, events: config.events, logError,
  });
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
        const { PurchaseWebhookService } = require('../purchaseWebhookService');
        purchaseInstance = new PurchaseWebhookService({ gateway, store: purchaseStore, references });
      }
    }
    return purchaseInstance;
  };

  // ⭐ 2026-10-11：**采购退货**（扫码页采购领域第二个动作）—— 与补货**同一个形状的接线**：
  //    本文件只做"会话 + 幂等 + 校验 + 说人话"，写库/扣库存/出图全在
  //    `services/purchaseReturnService.js` 里（而它又只调既有的批次服务 / createOnceByKey /
  //    InventoryService / 出图链路）⇒ 扫码侧**没有第二套写库**。
  //    ⚠️ 用例可以注入 `options.purchaseReturnService`（一个真/假的服务实例）。
  let purchaseReturnInstance = options.purchaseReturnService || null;
  const purchaseReturn = () => {
    if (!purchaseReturnInstance) {
      // eslint-disable-next-line global-require
      const { createPurchaseReturnService } = require('../purchaseReturnService');
      purchaseReturnInstance = createPurchaseReturnService({
        gateway,
        config: config.purchaseReturn,
        events: config.events,
        references,
        store: options.purchaseReturnStore,
        ...(options.purchaseReturnOptions || {}),
      });
    }
    return purchaseReturnInstance;
  };

  let multiItemWritersInstance = null;
  const multiItemWriters = () => {
    /* eslint-disable-next-line global-require */ const { publishMultiItemPurchase } = require('../scanMultiItemPurchaseWriter');
    multiItemWritersInstance = multiItemWritersInstance || Object.freeze({
      // 2026-10-29 P0：扁平 payload 先包成 task（适配层 `scanMultiItemPurchaseWriter.js`）
      purchase: (taskId, payload, options = {}) => publishMultiItemPurchase({
        taskId, payload, options, purchaseStore, purchase,
      }),
      purchaseReturn: (taskId, draft) => purchaseReturn().submit(taskId, draft),
      behavior: (chain) => references.resolveBehavior((chain === 'return' ? config.purchaseReturn : config.replenish).behaviorCode),
    });
    return multiItemWritersInstance;
  };
  /**
   * ⭐⭐ **收款方式清单**（「收款方式管理」表 = **唯一真源**）。
   *
   * 业务负责人 2026-10-13 的原话：
   *   「你当前页面上这笔可选择的支付方式，**也不是我交易行为管理里面的那些可选项**，
   *    比如说**抖音团购券就没有**啊」
   * ⇒ 下拉的选项**必须**来自这张表（`v1BitableSchema.tables.paymentMethod` · 字段「收款方式」），
   *   **不再**来自环境变量清单（`SCAN_SALE_PAYMENT_METHODS` 只留给单测注入 ✓）。
   * 🔴 与 `listAccessories` 的**唯一不同**：读不到 ⇒ **抛**（不吞 ✗）——
   *   她的口径是"**不许静默回落**"：宁可不渲染这一页，也不给她一个**少了几项**的下拉。
   * 形状照抄 `listAccessories`：`options.listPaymentMethods` 可注入（单测）· 统一 configTableCache · 记 warn ✓
   */
  const listPaymentMethods = async () => {
    if (typeof options.listPaymentMethods === 'function') return options.listPaymentMethods();
    try {
      // 与资金页候选共用同一份快照：飞书 record_changed 会 invalidate，下一次读取重读。
      const records = await getConfigRows({ gateway, tableKey: 'paymentMethod' });
      const field = fieldOf('paymentMethod', 'name');
      return [...new Set((records || [])
        .map((record) => textValue(record?.fields?.[field]).trim())
        .filter(Boolean))];
    } catch (error) {
      logWarn(config.events.failed, {
        reason: 'payment_method_list_failed', error: String(error.message || error),
      });
      throw error; // ⭐ **明确失败**：调用方负责给人话，绝不回落 env
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
    const records = await getConfigRows({ gateway, tableKey: 'product' });
    return records.find((record) => textValue(record?.fields?.[numberField]).trim() === String(number).trim()) || null;
  };

  const salesEntryOrderNo = async (recordId, created) => {
    const field = fieldOf('salesEntry', 'orderNo');
    const fromCreate = textValue(created?.record?.fields?.[field]).trim();
    if (fromCreate) return fromCreate;
    const record = await gateway.get('salesEntry', recordId).catch(() => null);
    return textValue(record?.fields?.[field]).trim();
  };

  /**
   * ⭐⭐ 2026-10-15（task-19 ② · Lead 批准的口子）：**会话键**与**操作人**拆成两个概念 ——
   *   · `openId`     = **录单人 / 操作人**：会写进「录单人」「操作人」这些 **User 字段**，
   *                    所以**必须是真 open_id**（假字符串会被飞书判非法 id ⇒ 写库报错）；
   *   · `sessionKey` = **本地草稿会话的身份**，**可选、默认 = openId** ⇒
   *                    **工作台 / 扫码两条既有链路一个字都不变** ✓。
   * 为什么两个必须能分开：「配品销售」表那条入口**没有飞书登录态**，一行 = 一次独立成单 ——
   *   若所有行都拿同一个人当会话键，第 2 条记录会撞上 `submitSale` 里"键对不上 ⇒ 把上一单的结果
   *   还给你"那条分支（**拿到上一条的单号、自己一个字都没写 = 假成功** ✗）；
   *   而那个会话键又**不能**当 open_id 写进 User 字段。⇒ 两个概念各走各的 ✓。
   */
  // ── 销售：提交整单（**唯一的写库时机**）──────────────────────────────────
  /**
   * 提交"本单"：**一张销售主表 + N 条明细（一单一双一行）**。
   *
   * ⭐⭐ 2026-10-11（业务负责人**最终口径**，唯一权威）：这一层是"**总单层**"——
   *   ① **每件实收**（`lineAmounts`，按下标对应本单的明细行）→ 落**销售明细.「实收金额」**；
   *      没填（空）⇒ 读那张表的「单价」当落点；两边都取不到 ⇒ 人话拦住，**绝不写 0**。
   *      🔴 **没有第二个金额概念**（她只填「实收金额」，代码里也不再提旧列名）。
   *   ② **「付款情况」三档**（`paymentStatus`，整单口径，**默认「未付」**，见 `config/scanWrite`）：
   *      · **全付** —— 按**收款方式**写收款明细（1 条或多条）；
   *        🔴 **收款合计必须 == 每件实收合计**；不等 ⇒ **拦住、一个字都不写** + 人话说明差额；
   *        ⚠️ **只有在「她真的填了收款行」时才走到这条校验** —— 她选了全付却一笔收款都没填
   *        ⇒ **不拦整单**（按未付落库 + 页面给一句人话：`fullWithoutPaymentsNote`）；
   *      · **部分付** —— 资金区填**实付多少**（`paidAmount`）⇒ 按方式写已收的那几条
   *        （状态 = 既有「已收款」）＋ ⭐ **差额写一条【未收款】**（金额 = 每件实收合计 − 已收合计）；
   *      · **未付**（默认）—— 不用填 ⇒ **只记货**：不写【未收款】、她填过的收款行照写。
   *        ⚠️ 2026-10-11 晚改：原来是「未付 ⇒ 写一条【未收款】」，但她真机被「资金不齐」卡住之后
   *        改掉了 —— 她一个字都没提欠款时替她生成一条【未收款】等于**替她记了一笔账**；
   *        「还差多少钱」由读侧**现算**（`salesProgressService`），不需要那条占位行。
   *
   * ⭐⭐ **建单门槛 = 只要「货品信息」齐**（业务负责人 2026-10-11 晚）：
   *    **资金类（每件实收 / 收款行）不构成"不能建单"的理由**，可以全空 ⇒ 照样成单
   *    （明细实收按「单价」落、资金状态 = 既有「未写入」⇒ 那张单进工作台「待补充」，事后在
   *    订单列表里逐件补实收 + 补收款）。⇒ 缺省档「全付」的相等校验**只在她填了资金时**才跑。
   *    ⚠️ **例外**：显式选了「部分付」却一分钱不填 = 自相矛盾的输入，仍请她填"实付多少"
   *       （既有口径，见 `partial_amount_missing`）。
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
  ({ submitSale } = createScanWriteSales({
    config, texts, gateway, readGateway, sessions, queue, now, saleAsync, references, createEntry,
    sales, status, delivery, purchase, purchaseReturn, multiItemWriters, writeFinalStatus,
    listPaymentMethods, productNumber, resolveProductRecord, salesEntryOrderNo, deliverStockLines,
    fail, userMessageFor, positiveAmount, toCents, moneyText, amountMismatchMessage, amountList,
    positiveInteger, sessionKeyOf, scheduleSaleRest, markSaleWriteFailed,
  }));

  const {
    replenishFingerprint, submitReplenish, submitPurchaseReturn,
  } = createScanWritePurchase({
    config, texts, schema, sessionKeyOf, queue, sessions, fail, userMessageFor,
    positiveInteger, resolveProductRecord, productNumber, references, purchaseStore,
    purchase, purchaseReturn,
  });

  return {
    sessions,
    addSaleLine,
    clearDraft,
    // 2026-10-14 资金页前置：只加一个薄透传（内部仍是既有 saveSaleProgress ✓）
    saveDraftLines,
    submitSale,
    submitReplenish,
    // ⭐ 采购退货（与补货同形；业务负责人 2026-10-11 定的「和"报货"逻辑一样，也走扫码」）
    submitPurchaseReturn,
    purchaseReturn,
    // 收款方式下拉的来源（表 = 唯一真源；读不到会抛，调用方要给人话）
    listPaymentMethods,
    // 给用例 / 排查用：这次提交的幂等键是怎么算出来的（与 purchaseWebhookService 的
    // `purchaseTaskId` 同一个思路：**确定性推导**，两端不必各写一份公式）。
    taskIdFor: (key) => `${config.replenish.taskIdPrefix}_${String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    // 退货那条链的 task id 同一个算法（前缀来自配置）。
    returnTaskIdFor: (key) => `${config.purchaseReturn.taskIdPrefix}_${String(key || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`,
    // ⭐ 只读：**同一批**既有写入件（引用相等 ✓ 见上面的注释）——「一单多货品」引擎用它当 `writers`
    multiItemWriters,
  };
};


module.exports = {
  createScanWriteService,
  createSalesEntryWithOrderNo,
};
