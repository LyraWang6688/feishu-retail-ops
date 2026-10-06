// 退换货第二期·第二步：接线与编排（消息 → 定位 → 解析 → 确认卡片 → 执行器）。
//
// 边界（刻意收窄，和 saleLookupService / afterSalesService 的分工对齐）：
//   · **不写业务数据**：所有业务写入都在 afterSalesService（执行器）里；
//     本层只把"她确认过的那一笔"组装成执行器要的请求对象。
//   · **不自己查候选**：定位一律调 saleLookupService（第一期，只读）。
//   · **不渲染卡片**：卡片一律调 utils/larkCards 里的纯函数。
//   · **不判断意图**：intent 由入口层（larkMvpService）收敛后传进来，这里只认规范值。
// 于是本层只剩编排：两条入口 → 出卡 → 她点确认 → 调执行器。
//
// 两条入口（业务负责人特意强调"不要假设退货之前一定有查询行为"）：
//
//   入口 A：她先查（"帮我查 6035 黑" → 无按钮候选卡片），再说
//           "第 2 笔，退货，钱先存着" —— 按序号取候选，出确认卡片。
//           序号要能跨消息对上，所以"她上一次查到哪几笔"按**人**记一条本地上下文
//           （rememberCandidates / afterSalesContextId，10 分钟有效）。
//
//   入口 B：她直接说"退那双 6035 黑" —— **不依赖她先查**，自己调 findCandidates：
//           命中 1 条直接出确认卡片；命中多条出候选卡片（无按钮、带序号）让她选；
//           命中 0 条明确告诉她没找到、问她大概是哪天买的（卡片文案在 saleLookupCard）。
//
// 幂等：由执行器负责（总闸门 + 远端业务事件ID）。本层只保证
//   · 同一张卡片重复点确认 → 第二次不会绕过闸门再写一遍；
//   · taskId 传给执行器（每次用户消息一个分片），所以"同一笔销售先退 A 再退 B"仍然可行。
//
// ⚠️ 钱怎么走**没有默认值**（业务红线：「退货不是默认现金啊，都有啊」）：
//   她说了就按她说的走（她每句话都会说清：退多少、微信还是现金、还是钱先留着）；
//   万一模型真没解析出钱怎么走，就**抛一个明确的错拦住这一笔**（业务表零写入），
//   既不默认也不追问——她纠正过：「为什么要做兜底呢？……都会说清楚的」。
//   规则与理由见 config/afterSalesFlow。

const { AFTER_SALES_ACTIONS, actionSpecOf } = require('../config/afterSales');
const {
  AFTER_SALES_CARD_ACTIONS,
  AFTER_SALES_TASK_STATUS,
  ORDINAL_TEXT_PATTERN,
  actionLabelOf,
  resolveAfterSalesAction,
  resolveAfterSalesSettlement,
  resolveAfterSalesPaymentMethod,
  resolveAfterSalesRestockState,
  DEFAULT_AFTER_SALES_RESTOCK_STATE,
  afterSalesContextId,
} = require('../config/afterSalesFlow');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { V1ReferenceResolver } = require('./v1ReferenceResolver');
const { textValue } = require('./v1BitableGateway');
const {
  saleLookupCard,
  afterSalesConfirmationCard,
  afterSalesResultCard,
  afterSalesRetryCard,
  afterSalesStatusCard,
  afterSalesSettlementLabel,
} = require('../utils/larkCards');
const { logError, logInfo, logWarn } = require('../utils/logger');

const round2 = (value) => Math.round(Number(value) * 100) / 100;

const positiveInteger = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const optionalMoney = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? round2(number) : null;
};

const hasItemInfo = (parsed = {}) =>
  Boolean(String(parsed.item_no || '').trim() || String(parsed.color || '').trim());

/**
 * 售后编排服务。
 *
 * options:
 *   store      必填，本地任务状态（data/lark_mvp_tasks，与销售/查询共用一套）
 *   lookup     必填，SaleLookupService（第一期，只读的定位能力）
 *   executor   必填，AfterSalesService（第二期第一步，执行器）
 *   gateway    只读用途（货品/尺码解析）；不传时必须注入 references / sizeReferences
 *   references / sizeReferences 可选，解析货品与尺码（测试注入用）
 *   replyCard / sendCard / sendText / updateCard  可选，飞书消息端口
 *   ⭐ replyCardToTask / sendCardToTask / sendTextToTask  可选，**带任务上下文**的消息端口：
 *      群话题里的售后任务走它们（回复回到**同一个话题**），私聊任务走它们时
 *      最终仍是原来的 `sendText(open_id)` / `sendCard(open_id)`，payload 逐字不变。
 *      不注入时**退回上面那三个旧的端口**（旧调用方与旧测试的行为一个字不变）。
 *   now        可选，测试注入固定时间
 */
class AfterSalesFlowService {
  constructor(options = {}) {
    if (!options.store) throw new Error('AfterSalesFlowService requires store');
    if (!options.lookup) throw new Error('AfterSalesFlowService requires lookup');
    if (!options.executor) throw new Error('AfterSalesFlowService requires executor');
    this.store = options.store;
    this.lookup = options.lookup;
    this.executor = options.executor;
    this.references = options.references || new V1ReferenceResolver(options.gateway);
    this.getSizeReferences = createSizeReferenceAccess({
      gateway: options.gateway,
      sizeReferences: options.sizeReferences,
    });
    this.now = options.now || (() => new Date());
    this.replyCard = options.replyCard || (async () => '');
    this.sendCard = options.sendCard || (async () => '');
    this.sendText = options.sendText || (async () => undefined);
    this.updateCard = options.updateCard || (async () => false);
    // 渠道感知的三个出口。默认实现 = "没有渠道信息时的旧行为"：
    // 回复到任务自己那条消息（`replyCard`），主动发卡/发文字发给发送人私聊。
    // ⚠️ 只有调用方注入时才会"回到话题"——本类不认识 chat_type，也不认识 reply_in_thread。
    this.replyCardToTask = options.replyCardToTask
      || (async (task, card) => this.replyCard(task.message_id, card));
    this.sendCardToTask = options.sendCardToTask
      || (async (task, card) => this.sendCard(task.sender_open_id, card));
    this.sendTextToTask = options.sendTextToTask
      || (async (task, message) => this.sendText(task.sender_open_id, message));
  }

  // -------------------------------------------------------------------------
  // 消息入口
  // -------------------------------------------------------------------------

  /**
   * 处理一条售后诉求：定位原明细 → 组装方案 → 出确认卡片。
   * 出卡片**不等于执行**：她点确认后才调执行器（有副作用要人确认）。
   */
  async handle(task, parsed = {}) {
    const action = resolveAfterSalesAction({
      action: parsed.action, intent: parsed.intent, text: task.original_text,
    });
    if (!action) {
      await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.ASKING });
      await this.sendTextToTask(task, '我没分清是退货、换货还是赔货，再说一次好吗？');
      logWarn('after_sales.action.unresolved', {
        task_id: task.task_id, intent: parsed.intent, action: parsed.action,
      });
      return { handled: true, action: '', located: false, reason: 'action_unresolved' };
    }
    const located = await this.locateOriginal(task, parsed);
    if (!located.ok) {
      return { handled: true, action, located: false, reason: located.reason };
    }
    const planned = await this.buildPlan(task, parsed, action, located);
    if (!planned.ok) {
      return { handled: true, action, located: true, reason: planned.reason };
    }
    const plan = planned.plan;

    // 钱怎么走没解析出来 → **大声拦住**（业务表零写入），不默认、不追问、不出卡片。
    // 她的口径是"每句话都会说清钱怎么走"，所以这不该发生；真发生了就如实报错让她重发一次。
    // 为什么不能放过去交给执行器：执行器的口径是「settlement 空 = 不动钱」，
    // 放过去这一笔就会**静默地一分钱都不动**——明细/库存都写好了，账上少一笔，谁也看不出来。
    if (plan.requires_settlement) {
      logError('after_sales.settlement.unparsed', {
        task_id: task.task_id,
        action,
        diff_amount: plan.diff_amount,
        original_text: plan.original_text,
      });
      throw new Error(`没解析出这次的钱怎么走（${afterSalesSettlementLabel('cash')} / `
        + `${afterSalesSettlementLabel('prepaid')}），这一笔没有执行；请把"钱怎么走"一起说一遍，重发一次`);
    }

    await this.store.update(task.task_id, {
      status: AFTER_SALES_TASK_STATUS.CONFIRMING,
      after_sales_action: action,
      after_sales_plan: plan,
      after_sales_error: '',
    });
    await this.replyCardByTask(task, afterSalesConfirmationCard(task.task_id, plan));
    logInfo('after_sales.plan.confirming', {
      task_id: task.task_id,
      action,
      source: plan.source,
      original_sales_entry_record_id: plan.original_sales_entry_record_id,
      original_sales_detail_record_ids: plan.original_sales_detail_record_ids,
      settlement: plan.settlement,
      requires_settlement: plan.requires_settlement,
      // 她说的收款方式（空 = 她没说 → 执行器沿用原单）——排查"账上为什么写这个方式"看它。
      payment_method: plan.payment_method || '',
      diff_amount: plan.diff_amount,
      restock_state: plan.restock_state,
      restock_state_explicit: plan.restock_state_explicit,
      new_line_count: plan.new_lines.length,
    });
    return { handled: true, action, located: true, source: plan.source, plan };
  }

  /**
   * 定位"要退/要换的那一笔"。
   *
   * 先看序号（她说「第 2 笔」）：先看当前这条消息的任务，再看按人记的上下文
   * （入口 A 的跨消息场景）。序号用不了、而这句话里又带了货号颜色时，
   * 不放弃——继续按货号走入口 B，能救回来就别让她重发。
   *
   * 没序号就走入口 B（findCandidates），单条直接返回；多条/0 条出候选卡片。
   */
  async locateOriginal(task, parsed = {}) {
    // ⭐ ③ 售后跟销售**同话题**（业务负责人："因为是同一笔的售后"）。
    //    群话题里进来的售后任务带着**本地映射定位到的那笔销售**（`task.sales_entry_record_id`）：
    //    有它时，"要退/要换的那一笔"只能落在这笔销售上 —— 不去别的单子里捞。
    //    ⚠️ 私聊的任务上没有这个字段（`undefined`）→ `boundSaleRecordId` 为空 →
    //       下面每一步的判据与改动之前逐字相同。
    const boundSaleRecordId = String(task.sales_entry_record_id || '').trim();
    const inBoundSale = (candidate) => !boundSaleRecordId
      || String(candidate?.sales_entry_record_id || '') === boundSaleRecordId;

    const ordinal = positiveInteger(parsed.ordinal) || this.ordinalFromText(task.original_text);
    if (ordinal) {
      const sameMessage = this.lookup.resolvePendingCandidate(task, ordinal, { now: this.now() });
      if (sameMessage.status === 'ok' && inBoundSale(sameMessage.candidate)) {
        return { ok: true, candidate: sameMessage.candidate, source: 'ordinal' };
      }
      const remembered = await this.store.get(afterSalesContextId(task.sender_open_id));
      const previous = this.lookup.resolvePendingCandidate(remembered || {}, ordinal, { now: this.now() });
      if (previous.status === 'ok' && inBoundSale(previous.candidate)) {
        return { ok: true, candidate: previous.candidate, source: 'ordinal' };
      }
      if (!hasItemInfo(parsed)) {
        // 上下文没了（过期/她从没查过）或序号越界：明确告诉她，不要拿旧列表猜。
        const candidates = previous.candidates || [];
        const message = previous.message
          || `我这儿只有 ${candidates.length} 笔，没有你说的第 ${ordinal} 笔。`;
        await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.ASKING });
        await this.sendTextToTask(task, message);
        logInfo('after_sales.locate.ordinal_unusable', {
          task_id: task.task_id, ordinal, status: previous.status, candidate_count: candidates.length,
          bound_sales_entry_record_id: boundSaleRecordId || undefined,
        });
        return { ok: false, reason: `ordinal_${previous.status}` };
      }
    }

    // 入口 B：直接说（"退那双 6035 黑"）。不依赖她先查过。
    const itemNo = String(parsed.item_no || '').trim();
    const color = String(parsed.color || '').trim();
    if (!itemNo && !color) {
      await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.ASKING });
      await this.sendTextToTask(task, '退哪一双？发我货号，比如"6035 黑"。');
      return { ok: false, reason: 'no_item_info' };
    }

    // ⚠️ 话题里（boundSaleRecordId 非空）时，候选查询**限定在这一笔销售**上：
    //    查不到就是"这一笔里没有那双"，绝不跨单去捞别的销售（那是猜）。
    let candidates = await this.lookup.findCandidates({
      itemNo, color, now: this.now(), salesEntryRecordId: boundSaleRecordId,
    });
    // 她说了尺码就再收一道：同一货号同色常有多个尺码，不收就会出多张候选，
    // 甚至把 39 码当成她要的 40 码。尺码读不出来的候选保留（卡片上如实显示为空），
    // 不因为一个字段读不到就让这条记录消失。
    const size = positiveInteger(parsed.size);
    if (size) candidates = candidates.filter((row) => !row.size || Number(row.size) === size);

    if (!candidates.length) {
      // 0 条：复用查询域的候选卡片（它已经写着"没查到 + 你记得大概是哪天买的吗"），
      // 不另写一套文案。**不清空**按人记的旧上下文：这一次没找到不代表上一次那几笔不算。
      await this.replyCardByTask(task, saleLookupCard({ days: this.lookup.days, itemNo, color, candidates: [] }));
      await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.ASKING });
      logInfo('after_sales.locate.not_found', {
        task_id: task.task_id, item_no: itemNo, color,
        bound_sales_entry_record_id: boundSaleRecordId || undefined,
      });
      return { ok: false, reason: 'no_match' };
    }
    if (candidates.length > 1) {
      // 多条：出候选卡片（**无按钮**、带序号），并把候选按顺序存好——
      // 她说「第 1 笔」时才对得上号。同时记进按人上下文（跨消息）。
      await this.lookup.storePendingCandidates(task.task_id, candidates, { now: this.now() });
      await this.rememberCandidates(task.sender_open_id, candidates);
      await this.replyCardByTask(task, saleLookupCard({ days: this.lookup.days, itemNo, color, candidates }));
      await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.ASKING });
      logInfo('after_sales.locate.ambiguous', {
        task_id: task.task_id, item_no: itemNo, color, candidate_count: candidates.length,
      });
      return { ok: false, reason: 'ambiguous' };
    }
    // 话题里定位到的（source = 'thread_sale'）与私聊里按货号找到的（source = 'direct'）
    // 在卡片与执行器看来是同一件事：都是一个 candidate。区分只为了排查。
    return { ok: true, candidate: candidates[0], source: boundSaleRecordId ? 'thread_sale' : 'direct' };
  }

  // -------------------------------------------------------------------------
  // 方案（执行器要的请求对象，只是先落成"待确认"的计划）
  // -------------------------------------------------------------------------

  async buildPlan(task, parsed, action, located) {
    const spec = actionSpecOf(action);
    const candidate = located.candidate;
    const originalAmount = optionalMoney(candidate.actual_amount);

    // 退回的鞋回哪儿：她说就按她说的（explicit），没说就用默认（原状态=门盒）。
    // 默认值先填好，所以她不点按钮也能直接确认；按钮只是给她改。
    //
    // ⚠️ 钱怎么走**不适用**这套"先填默认值"的做法（见下面）。
    const spokenRestock = resolveAfterSalesRestockState(parsed.restock_state);
    const restockState = spec.requiresRestockState
      ? (spokenRestock || DEFAULT_AFTER_SALES_RESTOCK_STATE)
      : null;

    const newLines = [];
    if (spec.acceptsNewLines) {
      const outgoing = await this.resolveOutgoing(parsed);
      if (!outgoing.ok) {
        await this.ask(task, outgoing.message);
        return { ok: false, reason: outgoing.reason };
      }
      newLines.push(outgoing.line);
    }

    let diffAmount = optionalMoney(parsed.diff_amount);
    if (diffAmount == null) {
      // 建议差价：退货 = 原价退回（负）；换货/赔货 = 新鞋价 - 原价。
      // 只是建议值——卡片上会写明"差价：X（退给她/她补）"，她核对后才点确认。
      if (action === AFTER_SALES_ACTIONS.RETURN) {
        diffAmount = originalAmount == null ? null : round2(-originalAmount);
      }
      else diffAmount = round2((newLines[0]?.amount || 0) - (originalAmount || 0));
    }
    if (action === AFTER_SALES_ACTIONS.RETURN && diffAmount == null) {
      // 原明细没有成交金额，又没说她退多少钱：不猜。猜错就是账目错。
      await this.ask(task, '这一笔没有成交金额，退多少钱？');
      return { ok: false, reason: 'need_diff_amount' };
    }

    // 钱怎么走：**没有默认值**（业务红线，见 config/afterSalesFlow 的说明）。
    //   · 她说了（"钱先存着"/"退我现金"）→ 按她说的走；
    //   · 她没说、而这次要动钱（差价 ≠ 0）→ settlement 留空、requires_settlement = true：
    //     handle 会**抛明确的错**拦住这一笔（不默认、不追问、不出卡片）；
    //   · 差价 = 0 → settlement 留空且 requires_settlement = false（不动钱，没什么可定的）。
    const spokenSettlement = resolveAfterSalesSettlement(parsed.settlement);
    const movesMoney = Number.isFinite(diffAmount) && diffAmount !== 0;
    const settlement = movesMoney ? (spokenSettlement || null) : null;

    // ⭐ 收款方式（**她实际说的那个渠道**）：业务负责人 2026-10-06 定 ——
    //    「钱退现金」记录里的「交易方式」就要写**现金**，不沿用原单（见 AGENTS.md 第 16 条(2)）。
    //    承认不出来（她没说）→ 留空，执行器**沿用原单的方式**（那就是"现有逻辑"）。
    //    ⚠️ 只在 cash 这条腿上才有意义：prepaid 走「客户往来货款」，根本没有"交易方式"列。
    //    ⚠️ 从 `task.original_text` 上认，不从 `parsed.settlement` 认：settlement 已经被
    //       `resolveAfterSalesSettlement` 收敛成 cash/prepaid，具体渠道在那一步就丢了。
    const paymentMethod = settlement === 'cash' ? resolveAfterSalesPaymentMethod(task.original_text) : '';
    if (paymentMethod) {
      // 她说了方式，但「收款方式管理」里没有这一个 → **大声拦住**（业务表零写入、不出卡片）。
      // 为什么不能"没查到就沿用原单"：那正是这次要修的 bug —— 她说现金、账上写微信。
      try {
        await this.references.resolvePaymentMethod(paymentMethod);
      } catch (error) {
        logError('after_sales.payment_method.unknown', {
          task_id: task.task_id,
          payment_method: paymentMethod,
          original_text: String(task.original_text || ''),
        });
        await this.ask(task,
          `「收款方式管理」里没有「${paymentMethod}」这个收款方式，先把它加上（或换个说法）再说一次。`);
        return { ok: false, reason: 'payment_method_unknown' };
      }
    }

    return {
      ok: true,
      plan: {
        action,
        action_label: actionLabelOf(action),
        source: located.source,
        original_text: String(task.original_text || '').trim(),
        candidate: { ...candidate },
        original_sales_entry_record_id: candidate.sales_entry_record_id,
        original_sales_order_no: candidate.sales_order_no,
        original_sales_detail_record_ids: [candidate.record_id],
        new_lines: newLines,
        settlement,
        // 她话里说清楚了才为 true（没解析出来就是 false——那正是要大声拦住的情形）。
        settlement_explicit: Boolean(movesMoney && spokenSettlement),
        // 这一次"钱怎么走"没解析出来：要动钱却不知道往哪条腿走时要**拦住**，不许静默放过。
        requires_settlement: movesMoney && !spokenSettlement,
        // 她说的收款方式（"退我现金" → 现金）；空 = 她没说 → 执行器沿用原单的方式。
        payment_method: paymentMethod || null,
        payment_method_explicit: Boolean(paymentMethod),
        diff_amount: diffAmount,
        restock_state: restockState,
        restock_state_explicit: Boolean(spec.requiresRestockState && spokenRestock),
        requires_restock_state: spec.requiresRestockState,
        created_at: this.now().toISOString(),
      },
    };
  }

  /**
   * 换货/赔货的"新的一双"：货号 + 颜色 + 尺码 + 成交金额。
   * 货品走既有 V1ReferenceResolver（和采购/销售同一套匹配），尺码走共享的尺码解析。
   * 缺哪一项就明确问她要哪一项——不拿标价猜、不拿第一个尺码顶。
   */
  async resolveOutgoing(parsed = {}) {
    const itemNo = String(parsed.new_item_no || '').trim();
    const color = String(parsed.new_color || '').trim();
    if (!itemNo) return { ok: false, reason: 'need_new_item', message: '换成哪一双？发我货号和颜色。' };
    const size = positiveInteger(parsed.new_size);
    if (!size) return { ok: false, reason: 'need_new_size', message: `换的那双 ${itemNo}${color} 多大码？` };
    if (typeof this.references?.resolveProduct !== 'function') {
      throw new Error('售后需要货品解析能力（references.resolveProduct）才能处理换货/赔货');
    }
    let product;
    try {
      product = await this.references.resolveProduct({ itemNo, color });
    } catch (error) {
      return { ok: false, reason: 'new_product_not_found',
        message: `货品表里找不到 ${itemNo}${color}，核对一下货号。` };
    }
    const sizeEntry = await this.getSizeReferences().resolveByNumber(size);
    // 成交金额：她说多少就多少；没说时用「货品信息.单价」做建议值（卡片上她会核对）。
    // 一个都拿不到就问她——执行器要求出货明细必须有正数金额，猜不得。
    let amount = optionalMoney(parsed.new_amount);
    if (amount == null) {
      const priceField = this.references?.gateway?.table?.('product')?.fields?.price;
      const price = priceField ? Number(textValue(product.record?.fields?.[priceField])) : NaN;
      amount = Number.isFinite(price) && price > 0 ? round2(price) : null;
    }
    if (amount == null) {
      return { ok: false, reason: 'need_new_amount', message: `换的那双 ${itemNo}${color} 多少钱？` };
    }
    return {
      ok: true,
      line: {
        productId: product.recordId,
        sizeId: sizeEntry.recordId,
        amount,
        label: `${itemNo}${color} ${size}码`.trim(),
        // 货号+颜色在货品表命中多条（男/女鞋常共用）：执行器会取第一条继续，
        // 但要在卡片上让人看见，别悄悄替她决定。
        ambiguous_count: Number(product.ambiguousCount || 0),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 卡片动作
  // -------------------------------------------------------------------------

  /**
   * 返回 null = "这不是售后的卡片动作"，交给入口层继续走销售/采购分支。
   * 只有确认/取消/选回库状态三种动作会被这里接住。
   *
   * ⚠️ 没有"选资金走向"这个卡片动作：钱怎么走**不用卡片按钮**（业务负责人纠正：
   *   「会说的，所以不用再有要卡片按钮的链路了」），而是回一句文字问她。
   */
  async handleCardAction(value = {}, event, operatorOpenId, context = {}) {
    const action = String(value.action || '').trim();
    if (!Object.values(AFTER_SALES_CARD_ACTIONS).includes(action)) return null;
    const taskId = String(value.draft_id || '').trim();
    if (!taskId) throw new Error('售后卡片缺少任务 ID');
    const task = await this.store.get(taskId);
    if (!task) throw new Error('这次售后已经过期，请重新描述一次');
    if (task.sender_open_id !== operatorOpenId) throw new Error('只能由原始发送人确认该售后');
    if (action === AFTER_SALES_CARD_ACTIONS.RESTOCK) return this.chooseRestock(task, value, event, context);
    if (action === AFTER_SALES_CARD_ACTIONS.CANCEL) return this.cancelAfterSales(task, event, context);
    return this.confirmAfterSales(task, event, operatorOpenId, context);
  }

  async chooseRestock(task, value, event, context = {}) {
    if (task.status !== AFTER_SALES_TASK_STATUS.CONFIRMING) {
      return { toast: { type: 'info', content: '这张卡片已经处理过了' } };
    }
    const state = resolveAfterSalesRestockState(value.state);
    if (!state) throw new Error('退回的鞋只能选「门盒」或「样品」');
    const plan = { ...(task.after_sales_plan || {}), restock_state: state, restock_state_explicit: true };
    await this.store.update(task.task_id, { after_sales_plan: plan });
    await this.publishCard({ ...task, after_sales_plan: plan }, event,
      afterSalesConfirmationCard(task.task_id, plan), { stage: 'restock_chosen', ...context });
    logInfo('after_sales.restock.chosen', { task_id: task.task_id, restock_state: state });
    return { toast: { type: 'success', content: `退回的鞋将放到「${state}」` } };
  }

  /** 取消：只改本地任务状态，**不调执行器、不写任何业务表**。 */
  async cancelAfterSales(task, event, context = {}) {
    if (task.status === AFTER_SALES_TASK_STATUS.DONE) {
      return { toast: { type: 'warning', content: '这一笔已经做完了，不能取消；要退的话请重新说一次' } };
    }
    await this.store.update(task.task_id, {
      status: AFTER_SALES_TASK_STATUS.CANCELLED, cancelled_at: this.now().toISOString(),
    });
    await this.publishCard(task, event, afterSalesStatusCard({
      title: '已取消售后',
      message: '这一笔没有执行，也没有写任何记录。',
    }), { stage: 'cancelled', ...context });
    logInfo('after_sales.cancelled', { task_id: task.task_id });
    return { toast: { type: 'info', content: '已取消' } };
  }

  /**
   * 确认 → 调执行器。
   *
   * ⚠️ 第一道关是**钱**：万一有一份方案还没定钱怎么走就点到了确认，
   * 这里**直接抛明确的错**拦住——不调执行器、不改本地状态、不写任何业务表。
   * 正常流程下这种方案发不出卡片（handle 在出卡片之前就抛错了），
   * 这一关只是兜住"历史卡片 / 别处拼出来的方案"。
   *
   * 为什么必须拦住，不能"让执行器看着办"：
   *   执行器（afterSalesService.normalizeRequest）的口径是「settlement 为空 = 不动钱」，
   *   把"没解析出钱怎么走"直接透传过去，这一笔就会**静默地一分钱都不动**——账上少一笔，
   *   明细和库存却都写好了，谁也看不出错在哪。这正是业务负责人说的"钱不能猜"的反面：
   *   不是猜错，而是猜都算不上、直接把钱漏掉。
   *
   * 重复点确认是安全的，有两层：
   *   ① 这里：任务已经是 done 就直接回结果卡，不再调执行器；
   *   ② 执行器：总闸门按"这一次售后做过没"整次跳过（连飞书读都不做）。
   * 所以即使本地状态没落盘（比如进程刚重启），第二层仍然拦得住重复写。
   */
  async confirmAfterSales(task, event, operatorOpenId, context = {}) {
    if (task.status === AFTER_SALES_TASK_STATUS.DONE) {
      await this.publishCard(task, event,
        afterSalesResultCard(task.after_sales_plan || {}, task.after_sales_result || {}),
        { stage: 'duplicate_done', ...context });
      return { toast: { type: 'info', content: '这一笔售后已经做完了，不会重复写' } };
    }
    if (task.status === AFTER_SALES_TASK_STATUS.RUNNING) {
      return { toast: { type: 'info', content: '正在写入，请稍候' } };
    }
    if (task.status === AFTER_SALES_TASK_STATUS.CANCELLED) {
      return { toast: { type: 'info', content: '这一笔已经取消了，要退的话请重新说一次' } };
    }
    const plan = task.after_sales_plan;
    if (!plan) throw new Error('这次售后没有可执行的方案，请重新描述一次');

    if (plan.requires_settlement && !plan.settlement) {
      logError('after_sales.settlement.missing', {
        task_id: task.task_id, action: plan.action, diff_amount: plan.diff_amount,
      });
      throw new Error(`这一笔还没确定钱怎么走（${afterSalesSettlementLabel('cash')} / `
        + `${afterSalesSettlementLabel('prepaid')}），不能执行；请把"钱怎么走"一起说一遍，重新说一次`);
    }

    await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.RUNNING });
    try {
      const result = await this.executor.execute(this.executorRequest(task, plan, operatorOpenId));
      await this.store.update(task.task_id, {
        status: AFTER_SALES_TASK_STATUS.DONE, after_sales_result: result,
      });
      await this.publishCard(task, event, afterSalesResultCard(plan, result),
        { stage: 'completed', ...context });
      logInfo('after_sales.confirmed', {
        task_id: task.task_id,
        action: plan.action,
        master_record_id: result.masterRecordId,
        detail_count: (result.detailRecordIds || []).length,
        money_route: result.money?.route,
        stock_rows: (result.stock || []).length,
      });
      return { toast: { type: 'success', content: `${plan.action_label}已完成` } };
    } catch (error) {
      // 失败必须让她看见原因，别静默。状态退回"待确认"，让她能在原卡片上重试
      // （执行器自带断点续做 + 总闸门，重试不会重复写已经写好的部分）。
      await this.store.update(task.task_id, {
        status: AFTER_SALES_TASK_STATUS.CONFIRMING, after_sales_error: error.message,
      });
      // 失败也**保留确认按钮**（afterSalesRetryCard = 确认卡片 + 原因），
      // 否则我们让她"在原卡片重试"就成了空话——按钮已经被换掉了。
      await this.publishCard(task, event, afterSalesRetryCard(task.task_id, plan, error.message),
        { stage: 'failed', ...context });
      logError('after_sales.failed', {
        task_id: task.task_id, action: plan.action, error: error.message,
      });
      return { toast: { type: 'warning', content: `${plan.action_label}没做成：${error.message}` } };
    }
  }

  /** 组装执行器的入参（契约见 config/afterSales.js 顶部与 afterSalesService.normalizeRequest）。 */
  executorRequest(task, plan, operatorOpenId) {
    return {
      action: plan.action,
      originalText: plan.original_text || task.original_text,
      originalSalesEntryRecordId: plan.original_sales_entry_record_id,
      originalSalesOrderNo: plan.original_sales_order_no,
      originalSalesDetailRecordIds: plan.original_sales_detail_record_ids,
      newLines: (plan.new_lines || []).map((line) => ({
        productId: line.productId, sizeId: line.sizeId, amount: line.amount,
      })),
      diffAmount: plan.diff_amount,
      settlement: plan.settlement,
      // 她说的收款方式（"退我现金" → 现金）；空 = 她没说 → 执行器沿用原单的方式。
      paymentMethod: plan.payment_method || '',
      restockState: plan.restock_state,
      // taskId = 每次用户消息一个分片：同一笔销售分两次退不同的鞋互不干扰，
      // 而同一条消息重复确认会撞进同一个分片被总闸门整次跳过。
      taskId: task.task_id,
      operatorOpenId,
    };
  }

  // -------------------------------------------------------------------------
  // 跨消息上下文 / 消息端口
  // -------------------------------------------------------------------------

  /**
   * 记住"她上一次查到的是哪几笔"（入口 A 的跨消息上下文）。
   * 按人记一条本地记录，10 分钟有效（复用查询域的 TTL 口径）。
   */
  async rememberCandidates(senderOpenId, candidates = []) {
    const sender = String(senderOpenId || '').trim();
    if (!sender) return;
    const now = this.now();
    const patch = {
      type: 'after_sales_context',
      status: 'after_sales_context',
      sender_open_id: sender,
      pending_candidates: candidates,
      pending_candidates_at: now.toISOString(),
      pending_candidates_expires_at: new Date(now.getTime() + this.lookup.ttlMs).toISOString(),
    };
    const id = afterSalesContextId(sender);
    const existing = await this.store.get(id);
    if (existing) await this.store.update(id, patch);
    else await this.store.create({ task_id: id, ...patch });
  }

  ordinalFromText(text) {
    const match = String(text || '').match(ORDINAL_TEXT_PATTERN);
    return match ? positiveInteger(match[1]) : null;
  }

  async ask(task, message) {
    await this.store.update(task.task_id, { status: AFTER_SALES_TASK_STATUS.ASKING });
    await this.sendTextToTask(task, message);
    logInfo('after_sales.plan.needs_info', {
      task_id: task.task_id, message_length: String(message || '').length,
    });
  }

  // 优先在原消息下回复（她能立刻看到对应的那张卡）；回复失败退回主动发卡，
  // 免得"说了却没反应"。
  //
  // ⚠️ 两个出口都是**渠道感知**的（`replyCardToTask` / `sendCardToTask`）：
  //    群话题里的售后任务回复回到**同一个话题**，私聊任务仍是原来的
  //    `replyCard(message_id)` / `sendCard(open_id)`，payload 逐字不变。
  async replyCardByTask(task, card) {
    try {
      const messageId = await this.replyCardToTask(task, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      return messageId || '';
    } catch (error) {
      logWarn('after_sales.card.reply_failed', { task_id: task.task_id, error: error.message });
      const messageId = await this.sendCardToTask(task, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      return messageId || '';
    }
  }

  // 卡片动作的反馈：优先更新原卡片；更新不了（缺 message_id）就另发一张，
  // 保证她总能看到结果，而不是"点了没反应"。
  async publishCard(task, event, card, metadata = {}) {
    try {
      if (await this.updateCard(task, event, card, metadata)) return true;
    } catch (error) {
      logWarn('after_sales.card.update_failed', {
        task_id: task.task_id, stage: metadata.stage, error: error.message,
      });
    }
    try {
      const messageId = await this.sendCardToTask(task, card);
      if (messageId) await this.store.update(task.task_id, { card_message_id: messageId });
      logInfo('after_sales.card.fallback.sent', {
        task_id: task.task_id, stage: metadata.stage, card_message_id: messageId,
      });
      return true;
    } catch (error) {
      logWarn('after_sales.card.fallback.failed', {
        task_id: task.task_id, stage: metadata.stage, error: error.message,
      });
      return false;
    }
  }
}

module.exports = { AfterSalesFlowService };
