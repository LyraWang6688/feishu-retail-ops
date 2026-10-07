const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const {
  DAY_MS,
  readSaleLookupConfig,
  isReturnedSalesStatus,
  isReturnTradeType,
} = require('../config/saleLookup');
const { MESSAGE_INTENTS } = require('../config/saleIntents');
const { salesStatusOf } = require('../config/salesStatusDimensions');
const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { normalizeColor, normalizeText } = require('./v1ReferenceResolver');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { saleLookupCard } = require('../utils/larkCards');
const { logInfo, logWarn } = require('../utils/logger');
const { skipNoGroupContext } = require('../utils/privateChatSend');

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 只读网关视图。
 *
 * 退换货第一期是「只查 + 只展示」，**绝不写任何业务表**。与其靠评审去盯，
 * 不如在这条链路的入口把写接口直接摘掉：SaleLookupService 拿到的网关没有
 * create / update / delete，以后谁顺手加一行写操作都会当场报错，而不是悄悄改到业务表。
 */
const readOnlyGateway = (gateway) => ({
  table: (tableKey) => gateway.table(tableKey),
  listAll: (tableKey) => gateway.listAll(tableKey),
});

const asDate = (value) => {
  if (value == null || value === '') return null;
  const raw = typeof value === 'number' ? value : textValue(value).trim();
  if (raw === '') return null;
  const timestamp = typeof raw === 'number' || /^\d{10,13}$/.test(raw) ? Number(raw) : null;
  const date = timestamp === null ? new Date(raw) : new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? null : date;
};

// 东八区日键：门店按上海时间营业，"最近几天"必须按上海的自然日算，
// 不能按服务器时区（线上是 UTC，会把凌晨的单算到前一天）。
const shanghaiDayKey = (date) =>
  new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);

const shanghaiDayStart = (date) => Date.parse(`${shanghaiDayKey(date)}T00:00:00+08:00`);

/**
 * 查询窗口 = 今天 + 往前 (days - 1) 个上海自然日。
 *
 * 为什么用自然日而不是「now - days×24h」：产品负责人说的是「最近 5 天内」，
 * 门店理解的是"今天和前几天"。写成滚动 24 小时的话，同一个上午查两次的窗口不一样，
 * 她没法预期"几天前那笔还在不在"。
 */
const lookupWindowStart = ({ now, days }) => shanghaiDayStart(now) - (days - 1) * DAY_MS;

const isWithinLookupWindow = (date, { now, days }) =>
  Boolean(date) && date.getTime() >= lookupWindowStart({ now, days });

const fieldValue = (schema, tableKey, record, semanticKey) => {
  const fieldName = schema.tables[tableKey]?.fields?.[semanticKey];
  return fieldName ? record?.fields?.[fieldName] : undefined;
};

const asText = (schema, tableKey, record, semanticKey) =>
  textValue(fieldValue(schema, tableKey, record, semanticKey)).trim();

const asOptionalNumber = (value) => {
  const raw = textValue(value).replace(/,/g, '').replace(/¥/g, '').trim();
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * 销售记录查询服务（退换货第一期）。
 *
 * 边界：这一层只做四件事，彼此可分可测——
 *   1. 候选查询（findCandidates）：读销售明细 + 销售主表 + 货品信息，按窗口和货号颜色筛，排除已退
 *   2. 卡片渲染：交给 utils/larkCards.saleLookupCard（纯函数）
 *   3. 上下文（pending candidates）：按卡片顺序存进任务状态，10 分钟过期
 *   4. 编排（handleQuery）：查 → 存上下文 → 回卡片
 * 不碰：写入、收款、库存、单号生成。
 */
class SaleLookupService {
  constructor(options = {}) {
    if (!options.gateway) throw new Error('SaleLookupService requires gateway');
    if (!options.store) throw new Error('SaleLookupService requires store');
    this.schema = options.schema || V1_BITABLE_SCHEMA;
    // 双保险：构造时再包一层只读视图，即使调用方直接传了完整网关也写不了。
    this.gateway = readOnlyGateway(options.gateway);
    this.store = options.store;
    this.config = options.config || readSaleLookupConfig();
    this.now = options.now || (() => new Date());
    this.replyCard = options.replyCard || (async () => '');
    // ⭐ 渠道感知的出口（可选）。**没有缺省"发到某个人"这回事** ——
    // 🔴 2026-10-07「私聊链路移除」：原来这里的缺省是
    // `(task, card) => this.sendCard(task?.sender_open_id, card)`（偷偷发私聊），
    // 与它底下的 `this.sendCard(open_id, card)` 一起**整体删除**。
    // 现在没有群上下文 = **没有去处** → 只记一条 `lark.private_chat.send_skipped`、返 `null`。
    // 生产在 `larkMvpService` 里注入 `sendTaskCard`（群 → 回到那个话题）。
    // 见 docs/private-chat-removal-decision-2026-10-07.md。
    this.sendCardToTask = options.sendCardToTask
      || (async (task) => skipNoGroupContext('card', task));
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: this.gateway,
      sizeReferences: options.sizeReferences,
    });
  }

  get days() {
    return this.config.days;
  }

  get ttlMs() {
    return this.config.ttlMs;
  }

  /**
   * 尺码在「销售明细」里是关联「尺码管理」，不能只靠关联单元格的显示文本
   * （部分接口只回 record_ids 不回 text）。走共享的尺码解析；老数据或未配置
   * 「尺码管理」时退回单元格自带文本，读不到就留空——查记录不该因为一个字段
   * 关联不完整就整条消失。
   */
  async resolveDetailSize(record, fields) {
    try {
      const entry = await this.getSizeReferences().resolveLinkedCell(fields[this.schema.tables.salesDetail.fields.size]);
      return entry.size;
    } catch (error) {
      const fallback = textValue(fields[this.schema.tables.salesDetail.fields.size]).trim();
      if (fallback) return fallback;
      logWarn('sale_lookup.size.unresolved', { record_id: record?.record_id, error: error.message });
      return '';
    }
  }

  /**
   * 候选查询。
   *
   * 输入：货号 / 颜色（都可选）+ 可选「只在某一笔销售里找」（salesEntryRecordId）+ 时间窗口
   *   ⚠️ 货号、颜色、salesEntryRecordId **三者不能全空**：全空 = 想查"全部销售记录"，
   *      那不是这个功能要回答的问题（最近 5 天全店可能有几十条）。
   *   ⭐ salesEntryRecordId 是**群话题**那条路用的：话题本身已经定位到某一笔销售，
   *      售后就绑着那一笔找 —— 业务负责人的口径是「**同一笔的售后，绝不跨单去捞**」。
   * 输出：[{ record_id, date, sold_at, item_no, color, size, actual_amount, sales_order_no, sales_entry_record_id }]
   *
   * 「日期」用销售明细的「销售日」，缺失时退回销售主表的「录单日」——和
   * 网页工作台的取值口径一致（v1WorkbenchService.getTodaySales），两处不能各算一套。
   *
   * ⚠️ 参数名统一为 `salesEntryRecordId`：调用方 afterSalesFlowService 与测试桩都用它。
   *    改动前签名里没有这个参数 → 传进来被**静默忽略** → 售后仍按货号颜色在全表捞
   *    （跨单抓到别的销售）。这里收住它，只在那一笔里找。
   */
  async findCandidates({ itemNo = '', color = '', salesEntryRecordId = '',
    now = this.now(), days = this.days } = {}) {
    const wantedItemNo = normalizeText(itemNo);
    const wantedColor = normalizeColor(color);
    const wantedEntryRecordId = String(salesEntryRecordId || '').trim();
    // 三个限定条件一个都没给 = 想查"全部销售记录"，直接回空，让上层提示她补货号。
    if (!wantedItemNo && !wantedColor && !wantedEntryRecordId) return [];

    const [details, entries, products] = await Promise.all([
      this.gateway.listAll('salesDetail'),
      this.gateway.listAll('salesEntry'),
      this.gateway.listAll('product'),
    ]);

    const productsById = new Map(products.map((record) => [record.record_id, record]));
    const entriesById = new Map(entries.map((record) => [record.record_id, record]));

    // 判据一：销售主表.销售状态 = 已退货 / 部分退货
    //
    // ⚠️ 2026-10-06 晚，业务负责人**把「订单状态」整列删掉**（值一起没，不可恢复），
    //    判据一因此从「订单状态」**迁到「销售状态」**——销售那一维的新家
    //    （字段名与取值见 config/salesStatusDimensions）。
    //    `salesProgressService.sync` 从 2026-10-06 起就只算不写「订单状态」了。
    //
    // ⚠️ 写入端**默认是关的**：业务负责人 2026-10-06 晚更正的口径是「售后不影响原单」，
    //    所以 afterSalesService 回写原单「销售状态 = 已退货 / 部分退货」做成显式开关
    //    （config/afterSales 的 writeOriginalSalesStatus，默认 false；取值见
    //     AFTER_SALES_ORIGINAL_SALES_STATUS）。
    //    ⇒ 判据一今天多半仍读不到退货标记，**真正兜底的是下面的判据二**
    //      （销售明细.交易类型 = 销售退货），它不依赖任何开关。
    //    这里保留一层**保守**：
    //      · 值 = 已退货 / 部分退货                    → 排除（判据本体）
    //      · 值取不到（字段没配 / 单元格空）           → **当成"退过"，排除 ＋ logWarn**
    //        —— 「销售状态」既不是退货、也不代表任何写入进度时，我们其实**不认识**这条记录
    //           （老单就是这样：旧字段被删、历史值丢失，这些维度全空）。
    //           两个维度都告诉不了我们这单退没退过时，宁可少给她一条候选，
    //           也不能把"可能已经退过"的单再拿出来退一次（多退一次就是钱）。
    //      · 值是别的合法进度（未写入/部分写入/已写入/写入失败）→ 不排除（新单）。
    const entryFieldsOfLookup = this.schema.tables.salesEntry?.fields;
    const returnedOrderIds = new Set();
    for (const entry of entries) {
      const salesStatus = salesStatusOf(entry, entryFieldsOfLookup);
      if (isReturnedSalesStatus(salesStatus)) {
        returnedOrderIds.add(entry.record_id);
        continue;
      }
      if (salesStatus) continue;
      logWarn('sale_lookup.sales_status.unreadable', {
        record_id: entry.record_id,
        sales_status_field: entryFieldsOfLookup?.sales || '',
        reason: entryFieldsOfLookup?.sales ? 'sales_status_blank' : 'sales_status_field_not_configured',
      });
      returnedOrderIds.add(entry.record_id);
    }
    // 判据二：销售明细里已有「交易类型」= 销售退货的行 → 它所属的整单都排除。
    // 「单」的粒度是销售主表记录：已经退过一笔的单，不能再让她从那一条里挑第二笔去退。
    for (const detail of details) {
      if (!isReturnTradeType(asText(this.schema, 'salesDetail', detail, 'tradeType'))) continue;
      for (const orderId of linkedRecordIds(fieldValue(this.schema, 'salesDetail', detail, 'salesEntry'))) {
        returnedOrderIds.add(orderId);
      }
    }

    const candidates = [];
    for (const detail of details) {
      const fields = detail.fields || {};
      const orderIds = linkedRecordIds(fieldValue(this.schema, 'salesDetail', detail, 'salesEntry'));
      const orderId = orderIds[0] || '';
      // ⭐ 群话题那条路：只在话题对应的那一笔销售里找（「同一笔的售后，绝不跨单去捞」）。
      //    改动前这个限定被静默忽略，售后会按货号颜色抓到**别的单**。
      if (wantedEntryRecordId && orderId !== wantedEntryRecordId) continue;
      if (orderId && returnedOrderIds.has(orderId)) continue;
      // 明细自己就是一条退货行：即使主表「销售状态」还没写成「已退货」，也不能拿它当"可退的销售"。
      if (isReturnTradeType(asText(this.schema, 'salesDetail', detail, 'tradeType'))) continue;

      const productIds = linkedRecordIds(fieldValue(this.schema, 'salesDetail', detail, 'product'));
      const product = productsById.get(productIds[0]);
      // 配品（腰带、鞋油…）没有货号颜色，不在这次"按货号查鞋"的范围里。
      if (!product) continue;

      const saleItemNo = asText(this.schema, 'product', product, 'itemNo');
      const saleColor = asText(this.schema, 'product', product, 'color');
      if (wantedItemNo && normalizeText(saleItemNo) !== wantedItemNo) continue;
      // 颜色复用 normalizeColor：「棕」=「棕色」。她嘴里说的和表里存的不必逐字相同。
      if (wantedColor && normalizeColor(saleColor) !== wantedColor) continue;

      const entry = entriesById.get(orderId);
      const soldAt = asDate(fieldValue(this.schema, 'salesDetail', detail, 'soldAt'))
        || asDate(fieldValue(this.schema, 'salesEntry', entry, 'recordedAt'));
      if (!isWithinLookupWindow(soldAt, { now, days })) continue;

      candidates.push({
        record_id: detail.record_id,
        sold_at: soldAt.toISOString(),
        date: shanghaiDayKey(soldAt),
        item_no: saleItemNo,
        color: saleColor,
        size: await this.resolveDetailSize(detail, fields),
        actual_amount: asOptionalNumber(fieldValue(this.schema, 'salesDetail', detail, 'actualAmount')),
        sales_order_no: entry ? asText(this.schema, 'salesEntry', entry, 'orderNo') : '',
        sales_entry_record_id: orderId,
      });
    }

    // 最近的排前面。同一天的按销售单号再按记录 ID 兜底，保证**同一份数据每次顺序一致**
    // ——卡片顺序和 task.pending_candidates 的顺序必须对得上，她说「第 2 笔」才不会串。
    candidates.sort((left, right) => {
      if (left.date !== right.date) return right.date.localeCompare(left.date);
      const leftNo = left.sales_order_no || '';
      const rightNo = right.sales_order_no || '';
      if (leftNo !== rightNo) return rightNo.localeCompare(leftNo);
      return String(left.record_id).localeCompare(String(right.record_id));
    });

    logInfo('sale_lookup.candidates', {
      item_no: wantedItemNo,
      color: wantedColor,
      days,
      candidate_count: candidates.length,
      excluded_returned_orders: returnedOrderIds.size,
    });
    return candidates;
  }

  /**
   * 把候选按卡片顺序存进任务状态（复用现有 data/lark_mvp_tasks 存储，不新起一套）。
   * 有效期由 pending_candidates_expires_at 表达；过了就要求重新查。
   */
  async storePendingCandidates(taskId, candidates, { now = this.now() } = {}) {
    const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();
    await this.store.update(taskId, {
      status: 'query_answered',
      pending_candidates: candidates,
      pending_candidates_at: now.toISOString(),
      pending_candidates_expires_at: expiresAt,
    });
    return { expiresAt };
  }

  /**
   * 读上下文。返回 status:
   *   · ok      —— 候选有效，按卡片顺序返回
   *   · empty   —— 没有候选（她从没查过，或查出来就是 0 条）
   *   · expired —— 超过有效期，必须重新查（明确告诉她，不要拿旧列表猜）
   * message 是给用户看的一句话（过期就提示重新查）；第二期执行退换货时直接发它。
   */
  resolvePendingCandidates(task, { now = this.now() } = {}) {
    const candidates = Array.isArray(task?.pending_candidates) ? task.pending_candidates : [];
    if (!candidates.length) {
      return { status: 'empty', candidates: [], message: '我这儿还没有可选的销售记录，先发我货号，我帮你查一下。' };
    }
    const expiresAt = Date.parse(task?.pending_candidates_expires_at || '');
    if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
      return { status: 'expired', candidates: [],
        message: '这次查询已经超过 10 分钟了，请重新发我货号，我再查一次。' };
    }
    return { status: 'ok', candidates, message: '' };
  }

  /**
   * 按序号取候选（她说「第 2 笔」）。序号就是卡片上的 1/2/3。
   * 本期只提供这个定位能力（供第二期执行退换货），本期不触发任何业务动作。
   */
  resolvePendingCandidate(task, ordinal, { now = this.now() } = {}) {
    const resolved = this.resolvePendingCandidates(task, { now });
    if (resolved.status !== 'ok') return { ...resolved, candidate: null };
    const index = Number(ordinal) - 1;
    const candidate = Number.isInteger(index) && index >= 0 && index < resolved.candidates.length
      ? resolved.candidates[index]
      : null;
    return { status: candidate ? 'ok' : 'out_of_range', candidates: resolved.candidates, candidate };
  }

  /**
   * 处理「查销售记录」：查候选 → 存上下文 → 回一张**没有按钮**的卡片。
   *
   * 卡片只展示；她说「第 2 笔」是第二期的事。这里把候选按卡片顺序存好，
   * 就是为了第二期能直接对上号，而不是去翻聊天记录猜。
   */
  async handleQuery(task, parsed = {}) {
    const itemNo = String(parsed.item_no || parsed.items?.[0]?.item_no || '').trim();
    const color = String(parsed.color || parsed.items?.[0]?.color || '').trim();
    const now = this.now();
    const candidates = await this.findCandidates({ itemNo, color, now });
    await this.storePendingCandidates(task.task_id, candidates, { now });
    const card = saleLookupCard({ days: this.days, itemNo, color, candidates });
    await this.replyCardByTask(task, card);
    logInfo('sale_lookup.card.sent', {
      task_id: task.task_id,
      item_no: itemNo,
      color,
      candidate_count: candidates.length,
      ttl_ms: this.ttlMs,
    });
    return { handled: true, intent: MESSAGE_INTENTS.SALE_QUERY, itemNo, color,
      candidateCount: candidates.length, candidates };
  }

  // 退货 / 换货 / 赔货从第二期第二步起**真执行**（先出确认卡片，她点确认才写账），
  // 编排在 AfterSalesFlowService；本类只保留只读的查询/定位能力。
  // 这里刻意**不再**提供"我还没上线"的占位方法：留一个没人调用的旧入口，
  // 以后很容易被误接回去，静默吞掉她的退货诉求（测试里锁住了它不存在）。

  // 优先在原消息下回复（她能立刻看到对应的那张卡）；回复失败再兜底发一张。
  //
  // ⭐ 兜底**按渠道分流**（业务负责人 2026-10-06：「一律在话题群里，以后私聊路线就没有了」）：
  //   · 群任务（`chat_type === 'group'`）→ 走**渠道感知出口**，回到**那个话题**；
  //     ⚠️ **绝不回落私聊** —— 群里回复失败就如实失败（只记日志、返回空串），
  //     偷偷发一条私聊会让她以为"群里没人管"，也掩盖了群通道的故障。
  //   · 非群任务（`chat_type !== 'group'`）→ 🔴 2026-10-07「私聊链路移除」：
  //     **没有去处** —— 只记一条 `lark.private_chat.send_skipped`、返 `null`。
  //     改动前这里是 `sendCard(task.sender_open_id, card)`（偷偷发私聊），那行已整体删除
  //     （业务负责人拍板的 ⓐ：「代码里一行私聊都不留」，
  //      见 docs/private-chat-removal-decision-2026-10-07.md）。
  async replyCardByTask(task, card) {
    try {
      const messageId = await this.replyCard(task.message_id, card);
      if (messageId) {
        await this.store.update(task.task_id, { card_message_id: messageId });
      }
      return messageId || '';
    } catch (error) {
      logWarn('sale_lookup.card.reply_failed', { task_id: task.task_id, error: error.message });
    }
    if (task?.chat_type === 'group') {
      try {
        const messageId = await this.sendCardToTask(task, card);
        if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
        return messageId || '';
      } catch (fallbackError) {
        // 不静默、也不掉进私聊：留一条能排查的日志，调用方按"这次没发出去"处理。
        logWarn('sale_lookup.card.topic_fallback_failed', {
          task_id: task.task_id, chat_id: task.chat_id, error: fallbackError.message,
        });
        return '';
      }
    }
    // 没有群上下文 → 没有去处：记 skip + 明确返"没发出去"（调用方不该记 card_message_id）。
    return skipNoGroupContext('card', task);
  }
}

module.exports = {
  SaleLookupService,
  readOnlyGateway,
  asDate,
  shanghaiDayKey,
  lookupWindowStart,
  isWithinLookupWindow,
};
