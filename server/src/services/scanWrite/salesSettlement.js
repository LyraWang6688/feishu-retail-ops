'use strict';

/**
 * 销售提交的金额 / 收款 / 付款状态解析（P4 从 sales.js 搬出，只搬不改）。
 * 返回 ok:false + result 时，调用方直接返回 result（与搬出前逐字一致）。
 */
const { SELLABLE_KINDS } = require('../../config/sellableKinds');
const { fillText } = require('../../config/scanWrite');
const { logWarn } = require('../../utils/logger');

const resolveSaleSettlement = async ({
  lines, lineAmounts, paymentRows, paymentStatus, paidAmount, openId,
  sessionId, key, requestId, config, texts, sessions, fundsDeferred, goodsOnly,
  fail, userMessageFor, positiveAmount, toCents, moneyText, amountMismatchMessage, amountList,
}) => {
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
      await sessions.saveSaleProgress(sessionId, { lines: resolvedLines });
    }

    // ── ①' ⭐⭐ 每件实收**不再兜底读「单价」**（业务负责人 2026-10-11 选"方案甲"）──────────
    //    她没填 ⇒ **那一列就留空**（`salesOrderService` 里空值 = **不写这一列**），
    //    表里因此**不会出现"按单价顶上去的假数字"** —— 她事后在工作台订单列表里逐件补真值。
    //    🔴 **放宽只针对"缺省"**：她**填了**就必须 `> 0`（填 0 / 负数在 ① 那一步已经被拦）。
    //    ⚠️ 曾经的实现（2026-10-11 上半场、已退场）：留空 ⇒ 读「货品信息.单价 / 其他配品.单价」顶上，
    //       两边都读不到就人话拦住。那条路已删 —— 它正是"表里出现假数字"的来源。
    //    ⇒ 本段现在**一个飞书请求都不打**（只读也没了）。

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

    // ⭐⭐ 2026-10-16（task-62「货 / 钱分离」）：**货那一跑不许带收款** ——
    //   带了就是"两个口都能写钱"（迟早写出两遍账 ✗）⇒ **当场抛**（这是**调用方契约错**，
    //   不是她的输入错 ⇒ 不给她一张人话失败页，而是让写错的那一方立刻炸掉）。
    //   ⚠️ 与业务层那条闸门**同一条口径**（`salesOrderService._confirm` 的 `fundsDeferred` 段 ✓）；
    //      这里先拦的用处：**连主表都不建**（一个字都不写表 ✓）—— 判据 AC-MSD6 真红 ✓。
    if (fundsDeferred && usedPayments.length > 0) {
      throw new Error('「货 / 钱分离」的货那一跑不许带收款：钱那一半由资金页那一跑写');
    }
    // ⭐⭐ 2026-10-18（第 4 步提速）：货品页那一屏**只建主表** —— 它也不许带收款
    //   （收款是资金页那一屏的事；带了就是"两个口都能写钱"，与上一条同一个理由）。
    if (goodsOnly && usedPayments.length > 0) {
      throw new Error('「只建主表」那一跑不许带收款：收款只在资金页那一跑写');
    }

    // ── ③ ⭐⭐ 「付款情况」（整单）→ 收款明细的写法 ──────────────────────────────
    //    她 2026-10-11 的最终口径（唯一权威），三档：
    //      · **全付**（默认）：收款合计 **必须 ==** 每件实收合计；
    //      · **部分付**：只写她填的那几条（状态 = 既有「已收款」）＋差额一条【未收款】；
    //      · **未付（默认）**：只记货 —— **不写【未收款】**（见下面 2026-10-11 晚那段）。
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
    // ⭐⭐ 2026-10-11（业务负责人）：「**建单门槛 = 只要「货品信息」齐（选了尺码）**」——
    //    ⇒ 资金类（每件实收 / 收款行）**不构成"不能建单"的理由**。
    // 🔴🔴 2026-10-11 **晚（她真机被卡住之后改的，唯一权威）**：
    //    线上日志 `scan.sale.amount_mismatch payment_status="全付" items_cents=9900
    //    payments_cents=0`，她「只有一笔单子，一直提交不了」。
    //    ⇒ 两条改动（config 里默认档已改成**未付**，这里是逻辑那一半）：
    //      ① **「全付」必须相等**这条校验，**只在她真的填了收款行时**才生效
    //         （她选了全付却一笔收款都没填 ⇒ **不拦整单**，给一句人话提示，**按未付落库**）；
    //      ② **「未付」不再自动写那条【未收款】** —— 只有她**明说欠多少**（部分付的差额）才写
    //         （与既有原则一致：「她说欠才算欠」，见 `salesOrderService.js` 的 `owed` 注释）。
    //    ⚠️ 两条都**不会写出错账**：没填收款 = 一条收款明细都不写；差额也从来不由我们猜。
    const hasPaymentRows = usedPayments.length > 0;
    // 🔴🔴 2026-10-12（真机丢钱之后加的兜底）：她**显式选了「全付」**，却
    //    ① 一笔收款都没填 **且** ② 每件实收也全空 ⇒ 这一单**哪儿都没有钱**，与"全付"直接矛盾。
    //    真机现场（`scan.sale.submitted payment_count: 0`）：页面写着全付、收款明细一行没有，
    //    她自己都看出来"钱没进去"。⇒ 这里**拦住 + 人话**，绝不再静默落一张"零元全付单"。
    //    ⚠️ 只拦这一种组合：全付 + 没收款但**实收有值** ⇒ 仍走既有口径（按未付落库 + 提示），
    //       那是 2026-10-11 她点头过的行为，一个字不改。
    const anyLineAmount = resolvedLines.some((line) => line.explicit_amount);
    if (payMode === statusMode.full && !hasPaymentRows && !anyLineAmount) {
      logWarn(config.events.failed, {
        session_id: current.session_id, submit_key: key, reason: 'full_without_money',
        detail_count: resolvedLines.length, payment_count: 0, request_id: requestId,
      });
      const error = new Error(texts.fullWithoutMoneyBody);
      error.scanUserMessage = texts.fullWithoutMoneyBody;
      return fail({
        code: 'full_without_money', message: texts.fullWithoutMoneyBody, requestId, error,
      });
    }
    // 「她显式选了全付、但一笔收款都没填」⇒ 按**未付**落库 + 页面给一句人话（不是失败）。
    const fullWithoutPayments = payMode === statusMode.full && !hasPaymentRows;
    const effectiveMode = fullWithoutPayments ? statusMode.unpaid : payMode;
    if (effectiveMode === statusMode.full) {
      // ── 全付：两边必须相等（走到这里说明**她填了收款行**）──────────────────────
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
      const partial = effectiveMode === statusMode.partial;
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
      // ⭐ 差额 ⇒ 一条【未收款】——**只有「部分付」会写**（她明说"先付 X、还欠 Y"）。
      //    🔴 2026-10-11 晚改写：**「未付」不再自动写那一条** —— 她真机就是被"资金不齐"卡住的，
      //       而"她一个字都没提欠款"时替她生成一条【未收款】等于**替她记了一笔账**；
      //       既有原则也是"**她说欠才算欠**"（`salesOrderService.js` 的 `owed` 注释）。
      //       ⇒ 未付只记货：`payments` 本来就空、`owed = 0`；"还差多少钱"由读侧**现算**
      //         （`salesProgressService`），不需要那条占位行。
      //    ⚠️ 那一条**不由本文件拼**：只把差额（`owed`）交给既有业务层，它自己写
      //       「收款金额」「关联销售单」与那个**既有的**收款状态取值 —— 连那个取值的中文
      //       都不在本文件里（源码哨兵：扫码侧不许把状态取值写死，见 AC-7y）。
      // ⭐⭐ 2026-10-14（业务负责人逐字 · 最新权威）：「**只要本次付的金额小于累计的，那么差额都是未收款，
      //   包括本次付款为 0**」
      //   ⚠️ 改前逐字（她 2026-10-11 的老口径）：**只有「部分付」才写那一条**【未收款】✗
      //   ⇒ 改后逐字：**只看差额** ✗ 不看档位 —— `累计 − 已收` > 0 ⇒ 就交给既有业务层补一条 ✓
      //     （0 收款 ⇒ 差额 = 累计 ⇒ **照写** ✓；与旧注释那句「她没说欠就不写」相反 ⇒ 以今晚为准 ✓）
      //   🔴 仍**不由本文件拼**那一条（形状归既有业务层 ✓）；幂等仍由同一把 `submitKey` 兜 ✓
      if (itemsCents - paidCents > 0) owedCents = itemsCents - paidCents;
      // 🔴 2026-10-11 晚（默认档改成「未付」之后**必须跟着改的一处**）：
      //    **不再把收款行丢掉**。改前 `payments = []` 是"她显式选了未付 ⇒ 资金区整个忽略"；
      //    可现在**未付是默认档** ⇒ 她可能填了收款行却忘了把单选框从「未付」挑到「全付」——
      //    那种情况下丢行 = **静默把真收到的钱记没了**（账少一笔、她事后对不上）。
      //    ⇒ 「未付」这一档**只决定**要不要写那条【未收款】（= 不写，见上面），
      //      她真填了的收款行**如实落**（如实记钱永远比替她判断更安全）。
    }

    // ⭐⭐ 2026-10-16（task-62「货 / 钱分离」）：**货那一跑没有"钱"的结论** ✗ ——
    //   上面 ③ 那段（差额 = 累计 − 已收）只属于**资金页那一跑**；这一跑不许把它带进 `confirm`：
    //   带了 ⇒ 业务层就会替她记一条【未收款】（那是**替她记了一笔账** ✗），
    //   而且那条占位会把资金页那一跑**整表比对拦死**（反向证据 = `saleMoneySplitGoodsHalf.test.js`
    //   的 AC-MSG5 ✓）。⇒ 这一跑 `owed` 恒不传（下面那一行本来就是 `owedCents > 0` 才带）。
    if (fundsDeferred || goodsOnly) owedCents = 0;


  return {
    ok: true,
    resolvedLines, payments, owedCents, payMode, effectiveMode, fullWithoutPayments,
  };
};

module.exports = { resolveSaleSettlement };
