/**
 * 工作台【订单列表】的单条操作**接线层**（业务负责人 2026-10-09）。
 *
 * 它只干三件事：
 *   ① 把页面表单的入参**规范化 + 校验**（她填错了就当场说清楚，带 statusCode=400）；
 *   ② 把「工作台这一页的结构化入参」翻译成**既有业务处理层**要的形状；
 *   ③ 调既有服务，把结果原样返回。
 *
 * 🔴 **一次写库都不做**：这里出现的 `gateway.get` 全是**只读**（读销售单号 / 读原明细的
 *    货品与成交金额）—— 销售明细、收款、库存、售后单全部由既有服务去写：
 *      · 补收款 → `SalesFollowupService.addPayment`（路由里直接调，不在这里）
 *      · 交付   → `SalesFollowupService.delivery.deliver`（同上）
 *      · 售后   → **`AfterSalesService.execute`**（退 / 换 / 赔三种动作都走它）
 *      · 二次交付 → **`SecondDeliveryService.confirm`**（收尾款 + 交付）
 *    ⇒ 有一条源码哨兵钉着"这里没有新写库实现"（`test/workbenchOrders.test.js` 的 AC5c）。
 *
 * ⚠️ **入口隔离**（`docs/entry-isolation-2026-10-08.md`）：工作台入口与群聊入口
 *    只共享**业务处理层**；本文件属于工作台入口自己的接线，群聊链路一行都不碰。
 *
 * ⚠️ **状态 / 取值不自己造**：动作枚举取自 `config/afterSales`（`actionSpecOf`），
 *    资金走向取自同一份配置的 `settlements`，退货回库状态取自 `restockStates`。
 *    这里**没有**任何中文业务字面量（除了"原话"前缀，见 `config/workbenchOrders`）。
 */
const { V1BitableGateway, linkedRecordIds, textValue } = require('./v1BitableGateway');
const { AfterSalesService } = require('./afterSalesService');
const { SecondDeliveryService } = require('./secondDeliveryService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const {
  AFTER_SALES_ACTIONS, actionSpecOf, readAfterSalesConfig,
} = require('../config/afterSales');
const {
  readWorkbenchOrdersConfig, WORKBENCH_ORDERS_TEXTS: TEXTS,
} = require('../config/workbenchOrders');
const { logInfo } = require('../utils/logger');

/** 她填错的入参 → 400（与 `InventoryAdjustmentService` / `v1WorkbenchService` 同一套约定）。 */
const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

const requiredText = (value, message) => {
  const text = String(value ?? '').trim();
  if (!text) throw badRequest(message);
  return text;
};

/** 页面每次提交生成的幂等标识（重试必须复用同一个）。形状与补收款那一条一致。 */
const REQUEST_ID_PATTERN = /^[0-9a-f-]{36}$/i;

const parseOptionalNumber = (value, message) => {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(message);
  return number;
};

const parseOptionalPositive = (value, message) => {
  const number = parseOptionalNumber(value, message);
  if (number == null) return null;
  if (number <= 0) throw badRequest(message);
  return number;
};

class WorkbenchOrderActionService {
  constructor(options = {}) {
    this.gateway = options.gateway || new V1BitableGateway();
    this.config = options.config || readWorkbenchOrdersConfig();
    this.afterSalesConfig = options.afterSalesConfig || readAfterSalesConfig();
    // 既有业务处理层：售后执行器 / 二次交付。不传就按默认接线建一个（共用同一个网关）。
    // ⚠️ 端口字段**不能叫 `afterSales` / `secondDelivery`**：那是本类的两个方法名，
    //    实例属性会把原型方法**静默覆盖**掉（合并/新增方法时最容易踩的一个坑）。
    this.afterSalesExecutor = options.afterSales || new AfterSalesService({ gateway: this.gateway });
    this.secondDeliveryExecutor = options.secondDelivery
      || new SecondDeliveryService({ gateway: this.gateway });
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway, sizeReferences: options.sizeReferences,
    });
  }

  // ── 售后：退 / 换 / 赔 ────────────────────────────────────────────────────
  /**
   * `AfterSalesService.execute` 的**入参拼装**（它才是唯一的写库实现）。
   *
   * 入参形状（页面 → 这里）：
   *   {
   *     action: 'return' | 'exchange' | 'compensation',
   *     salesEntryRecordId,              原销售主表 record_id
   *     detailRecordIds: [...],          被退 / 被换 / 被赔的原销售明细
   *     restockState: '门盒' | '样品',    退 / 换必填（取自 config/afterSales 的 restockStates）
   *     newLine: [{ productRecordId | sameItem, size, amount }],  换 / 赔必填
   *     diffAmount, settlement, paymentMethod,  钱那一半（差价 0 / 留空 = 不动钱）
   *     requestId,                       幂等分片（重试复用同一个）
   *   }
   */
  async afterSales(input = {}) {
    if (!this.config.afterSalesEnabled) throw badRequest(TEXTS.afterSalesDisabled);
    // ⚠️ 动作枚举只认 `config/afterSales`：未声明的动作 `actionSpecOf` 会当场抛。
    const action = String(input.action || '').trim();
    const spec = actionSpecOf(action);

    const salesEntryRecordId = requiredText(input.salesEntryRecordId, TEXTS.needOrder);
    const detailRecordIds = [...new Set((Array.isArray(input.detailRecordIds) ? input.detailRecordIds : [])
      .map((id) => String(id ?? '').trim()).filter(Boolean))];
    if (!detailRecordIds.length) throw badRequest(TEXTS.needDetails);

    const requestId = String(input.requestId || '').trim();
    if (!REQUEST_ID_PATTERN.test(requestId)) throw badRequest(TEXTS.needRequestId);

    // 单号从**已经读到的**主表记录上来（执行器要拿它校验"是不是同一张单"）。
    const entry = await this.gateway.get('salesEntry', salesEntryRecordId);
    if (!entry) throw badRequest(TEXTS.orderNotFound);
    const orderNo = textValue(entry.fields?.[this.gateway.table('salesEntry').fields.orderNo]).trim();
    if (!orderNo) throw badRequest(TEXTS.orderNoMissing);

    // 「退回的鞋回哪儿」——只有需要它的动作才要，取值只从既有配置来。
    const restockState = spec.requiresRestockState
      ? requiredText(input.restockState, TEXTS.needRestockState) : '';
    if (restockState && !this.afterSalesConfig.restockStates.includes(restockState)) {
      throw badRequest(`退回的鞋只能回「${this.afterSalesConfig.restockStates.join(' / ')}」`);
    }

    // 换 / 赔：出货商品那一行（货品 + 尺码 + 成交金额）。
    // ⚠️ 「同款」是**她明确点的一个选项**：那一双的货品取自"她勾的原明细"，
    //    所以必须**恰好一条**明细 —— 勾了多条时"取哪一条的货品"没有唯一答案，
    //    这里当场问清楚，而不是悄悄拿第一条（那正是"猜"）。
    const sameItemRequested = input.newLine?.sameItem === true
      || String(input.newLine?.sameItem || '') === 'true';
    if (spec.acceptsNewLines && sameItemRequested && detailRecordIds.length !== 1) {
      throw badRequest(TEXTS.needSingleDetailForSameItem);
    }
    const newLines = spec.acceptsNewLines
      ? [await this.resolveNewLine(input.newLine || {}, detailRecordIds[0])]
      : [];

    // ── 钱那一半 ────────────────────────────────────────────────────────────
    const diffAmount = parseOptionalNumber(
      input.diffAmount, '差价必须是数字（正数 = 她补给我们，负数 = 我们退给她）',
    );
    const rawSettlement = String(input.settlement || '').trim();
    if (rawSettlement && !this.afterSalesConfig.settlements.includes(rawSettlement)) {
      throw badRequest(`未声明的资金走向：${rawSettlement}`);
    }
    // 与执行器**同一口径**：差价 0 / 空 ⇒ 不动钱（于是 settlement 也不落）。
    const movesMoney = rawSettlement !== '' && diffAmount !== null && diffAmount !== 0;
    const paymentMethod = String(input.paymentMethod || '').trim();
    // ⚠️ 退款 / 补差价的**方式必须她自己选**（业务负责人 2026-10-06：记录里要写她说的那个，
    //    不沿用原单）——所以这里**不给默认值**，没选就拦住。
    if (movesMoney && rawSettlement === 'cash' && !paymentMethod) {
      throw badRequest(TEXTS.needRefundMethod);
    }

    // 「原话」列：执行器要求非空，而且**必须由这次请求确定性地拼出来**
    //（同一次重试必须得到同一句话，否则 `verifyMaster` 会判"原话不一致"）。
    const originalText = [
      `${this.config.originalTextPrefix}：${spec.label}`,
      orderNo,
      `明细 ${[...detailRecordIds].sort().join('、')}`,
    ].join(' ');

    const result = await this.afterSalesExecutor.execute({
      action,
      originalText,
      originalSalesEntryRecordId: salesEntryRecordId,
      originalSalesOrderNo: orderNo,
      originalSalesDetailRecordIds: detailRecordIds,
      newLines,
      restockState: spec.requiresRestockState ? restockState : null,
      settlement: movesMoney ? rawSettlement : null,
      paymentMethod: movesMoney && rawSettlement === 'cash' ? paymentMethod : '',
      diffAmount: movesMoney ? diffAmount : 0,
      // 幂等分片：工作台一次提交一个 requestId（重试复用同一个，与补收款同一套做法）。
      taskId: `workbench_${requestId}`,
      operatorOpenId: String(input.operatorOpenId || '').trim(),
      receivedAt: input.receivedAt,
    });
    logInfo('workbench.orders.after_sales.completed', {
      sales_entry_record_id: salesEntryRecordId,
      order_no: orderNo,
      action,
      detail_ids: detailRecordIds,
      master_record_id: result?.masterRecordId || '',
      operator_open_id: String(input.operatorOpenId || ''),
    });
    return result;
  }

  /**
   * 换 / 赔出去的那一双：货品 + 尺码 + 成交金额。
   *
   * · **货品**：页面点了货号就用它；页面明确选了「同款」（`sameItem: true`，**她的选择**，
   *   不是我们猜的）就用**原明细那一双**的货品 —— 与群聊链路
   *   `afterSalesFlowService.resolveOutgoing` 的既有口径一致（「换尺码 = 货号/颜色/金额
   *   都从原明细上取」）。两者都没有就**问她**（不拿别的货号顶）。
   * · **尺码**：走共享的 `sizeReferenceService`（不靠关联单元格的显示文本），解析成关联 record_id。
   * · **成交金额**：页面填了就用（执行器的 `positiveYuan` 会再校验一次两位小数）；
   *   没填就按既有口径取**原明细的成交金额**（同款）或**货品单价**（另一双）；
   *   两者都取不到就**问她**，不拿别的数顶。
   * ⚠️ 赔货的成交金额最终由**既有动作配置**固定成 0（`config/afterSales` 的
   *    `newLineAmount`），这里给的只是执行器要求的"大于 0 的占位"。
   */
  async resolveNewLine(raw = {}, fallbackDetailRecordId) {
    const size = raw.size;
    if (size == null || String(size).trim() === '') throw badRequest(TEXTS.needNewSize);
    const sizeEntry = await this.getSizeReferences().resolveByNumber(size);

    const sameItem = raw.sameItem === true || String(raw.sameItem || '') === 'true';
    const askedProductId = String(raw.productRecordId || '').trim();
    const askedAmount = parseOptionalPositive(raw.amount, TEXTS.needNewAmount);
    // 只读地取一次原明细：同款要它的货品，没填金额时要它的成交金额（两者都可能用到）。
    const needOriginal = sameItem || !askedProductId || askedAmount == null;
    const original = needOriginal ? await this.originalDetail(fallbackDetailRecordId) : null;

    const productRecordId = askedProductId || original?.productRecordId || '';
    if (!productRecordId) throw badRequest(TEXTS.needNewProduct);

    let amount = askedAmount;
    if (amount == null) {
      // 同款 → 用原明细的成交金额（同一双鞋换个码，钱不变）；
      // 另一双 → 用「货品信息.单价」当占位（与群聊链路同一条既有口径）。
      amount = sameItem ? original?.amount ?? null : await this.productPrice(productRecordId);
      if (amount == null) amount = original?.amount ?? null;
    }
    if (amount == null) throw badRequest(TEXTS.needNewAmount);

    return { productId: productRecordId, sizeId: sizeEntry.recordId, amount };
  }

  /** 读一条原销售明细的**只读**信息：货品 record_id + 成交金额（写库不在这里）。 */
  async originalDetail(detailRecordId) {
    const id = String(detailRecordId || '').trim();
    if (!id) throw badRequest(TEXTS.needDetails);
    const record = await this.gateway.get('salesDetail', id);
    if (!record) throw badRequest('原销售明细不存在（可能已被删除）');
    const fields = this.gateway.table('salesDetail').fields;
    const productIds = linkedRecordIds(record.fields?.[fields.product]);
    const rawAmount = textValue(record.fields?.[fields.actualAmount]).trim();
    const amount = rawAmount === '' ? null : Number(rawAmount);
    return {
      productRecordId: productIds.length === 1 ? productIds[0] : '',
      amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    };
  }

  /** 「货品信息.单价」——只读；取不到就返回 null（调用方会**问她**，不猜）。 */
  async productPrice(productRecordId) {
    const record = await this.gateway.get('product', productRecordId);
    if (!record) return null;
    const priceField = this.gateway.table('product').fields.price;
    const price = Number(textValue(record.fields?.[priceField]));
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  // ── 二次交付：收尾款 + 交付 ──────────────────────────────────────────────
  /**
   * 直接复用 `SecondDeliveryService.confirm`（群聊里那张"成交提醒卡"点一下走的就是它）：
   * 把还没收的尾款记成已收，再把还没交的货交付（写履约状态 + 扣库存）。
   *
   * ⚠️ 收款方式缺省用**工作台这一页**的默认值（`DEFAULT_COLLECTION_METHOD`，默认微信）；
   *    有「未收款」记录时才真的用到它 —— 没有待收款时它是无意义的。
   */
  async secondDelivery(input = {}) {
    if (!this.config.secondDeliveryEnabled) throw badRequest(TEXTS.secondDeliveryDisabled);
    const salesEntryRecordId = requiredText(input.salesEntryRecordId, TEXTS.needOrder);
    const method = String(input.method || '').trim() || this.config.defaultCollectionMethod;
    const result = await this.secondDeliveryExecutor.confirm({
      salesEntryRecordId,
      method,
      operatorOpenId: String(input.operatorOpenId || '').trim(),
    });
    logInfo('workbench.orders.second_delivery.completed', {
      sales_entry_record_id: salesEntryRecordId,
      method,
      collected_payment_ids: result?.collectedPaymentIds || [],
      collected_amount: result?.collectedAmount || 0,
      operator_open_id: String(input.operatorOpenId || ''),
    });
    return result;
  }
}

module.exports = { WorkbenchOrderActionService };
