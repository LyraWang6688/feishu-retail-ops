'use strict';

/**
 * 扫码路由核心深拆 P2：销售提交（`submit_order`）分支（从 `routes/scanPage/index.js` 搬出，**只搬不改**）。
 * 调用方只传显式 ctx；分支体逐字搬移，调用顺序/日志/文案/状态一个未动。
 */

async function handleSubmitOrder(ctx) {
  const { asList, backTargetFor, body, buildWriteContext, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, lookupInputOf, markRealmUsed, openId, openIdOf, parsePaymentRows, postActionFor, realm, realmOfAction, renderScan, req, requestId, res, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, sendSuccess, service, successReturnFields, writeConfig, writeService } = ctx;
        // ⭐⭐ 2026-10-11（**最终口径**）：总单层 = ①每件实收（同名重复 ⇒ 有序数组，下标 = 明细行）
        //    + ②**「付款情况」三档**（整单：全付（默认）/ 部分付 / 未付）
        //    + ③多笔收款（同名重复 ⇒ 两个数组按下标对齐）+ 「部分付」的实付多少。
        //    **原样交给写服务**，校验（含"全付必须相等"那条）在写服务里做 —— 路由不判业务。
        const payments = parsePaymentRows(body, fields);
        // 🔴🔴 2026-10-16 P0（她真机：「货品信息里填了 240 ⇒ 资金页显示 0 ⇒ 提交没反应」）：
        //   这一步原来看**裸 body** ✗ —— 而货品页每行的「每件实收」是先写进**会话草稿行**的
        //   （`:1201/:1230` → `services/scanWriteService.js:512/554` 的 `amount` ✓），
        //   资金页那张表单**完全不带** `line_amount`（`:1274` 的注释早就写明 ✓）
        //   ⇒ 空数组 ⇒ ① 必填闸门对空数组恒不报（`.some()` ✗ = 静默 0 的第二个口子）
        //            ② 结算读点拿到 0 ⇒ 26 次 `amount_mismatch items_cents=0`（她的 240 丢在这 ✗）
        //   ⇒ **照 `:1281`/`:1561` 那两处一模一样的回落写法**（一份真源 = 会话草稿行 ✓ 不发明形状 ✗）
        const submitSession = await writeService.sessions?.get?.(openId).catch(() => null);
        const pendingDraftLines = Array.isArray(submitSession?.sale?.lines) ? submitSession.sale.lines
          : (Array.isArray(submitSession?.lines) ? submitSession.lines : []);
        const bodyLineAmounts = asList(body[fields.lineAmount]);
        const draftLineAmounts = pendingDraftLines
          .map((line) => String(line?.amount ?? '').trim()).filter(Boolean);
        // 第三档：**一单一笔那条默认路径**（草稿 0 行 ⇒ 她那一下填的就在 `fields.amount` ✓）
        const singleRowAmount = String(body[fields.amount] ?? '').trim();
        const lineAmounts = bodyLineAmounts.some((value) => String(value ?? '').trim())
          ? bodyLineAmounts
          : (draftLineAmounts.length ? draftLineAmounts : (singleRowAmount ? [singleRowAmount] : []));
        // ⭐⭐ 2026-10-14（她裁决 ⓐ）：**每一双都要填「实收金额」**（现货/预订**同一处判** ✓）
        //   🔴 有空 ⇒ **400 + 人话 + 一个字都不写表** ✗（幂等键/会话都不动 ✓ 不许假成功 ✓）
        //   ⚠️ **整单收款仍可全空** ✓（「待补充」那条老路保留 ✓）
        // 🔴 2026-10-16（裁决=甲）：闸门判**取值后的那份**；且**空数组也算缺** ——
        //   只要"这一单确实有东西要付"（草稿有行 ‖ 这次带了尺码 ⇒ 一单一笔默认路径 ✓）。
        //   依据：她 2026-10-14「每一双都要填「实收金额」」+ 她 2026-10-16 00:01「金额是必填的吧」。
        // 🔴🔴 2026-10-16 P0（定论 · 顺序修正）：**状态标记必须先写** ——
        //   闸门原来在这段之前返回 ⇒ `paymentStep:'pending'` 永远没被写上
        //   ⇒ `routes/scanPage.js:1542` 的 `payPending` 恒 false ⇒ 资金页那支整块被跳过
        //   ⇒ 拦住后她**再也走不动这一单**（页面 200、一条都不写）= 真机「点了提交没反应」✗
        //   ⇒ 标记照写（拦住时看到的仍是同一页 + 醒目人话 ✓）
await writeService.saveDraftLines?.(openId, {
          lines: pendingDraftLines,
          // ⭐ 她（或 GET）据此判断"已经走到资金这一步了" ⇒ 刷新仍停在资金页 ✓
          paymentStep: 'pending',
          // ⭐⭐ 2026-10-15 晚（task-22 · #598 引入的一处回退）：**这一单正在走 ⇒ status 落回 draft** ✓
          //   🔴 改前只写 `lines/paymentStep/submitPending`、**一个字都不写 `status`** ✗ ⇒ 上一单
          //      `completeSale` 落的 `status:'submitted'` 会**一直留着**（一单一笔的默认路径不点
          //      「加入本单」⇒ 不会重置）⇒ **第 2 单起，"刚提交、正停在资金页"的形状恰好长成
          //      #598 要清的那种残标记** ⇒ 她在资金页**刷新一下**就被打回录入页 ✗（更窄的一处回退）。
          //   ⇒ 补这一行：提交 = 这一单**正在走**，本来就是 draft 态 ✓ ⇒ 两个状态**彻底分开**：
          //      · 新一单刚提交 ⇒ `draft` ⇒ 刷新照旧给资金页 ✓
          //      · 她那次那种**没有新提交**的残标记（status 仍是上一单的 `submitted`）⇒ 照旧清 ✓
          //   ⚠️ 安全性：`status` 的另一批读点是"重启补跑"扫描（`scanSessionService` 的
          //      `findInterruptedSales` / `findUncertainInFlightSales`：**同时**要求 `draft` +
          //      `order_no` 非空 + `lines` 非空）⇒ 提交这一步**没有** `order_no`、`lines` 也可能为空
          //      ⇒ **两个条件都不满足 ⇒ 不会被当成待补跑** ✓（用例 `AC-SM10` 钉着）。
          // ⚠️ 配置路径是 `writeConfig.session.statuses`（= `config/scanWrite.js` 的 `SESSION.statuses`；
          //    `writeConfig.statuses` **不存在** ⇒ 写错了会当场 `Cannot read properties of undefined` ⇒ 500 ✗
          //    —— 我第一版就写错了，被全量/用例当场抓住 ✓ 现在按真路径取，并有用例钉着）。
          status: writeConfig.session.statuses.draft,
          // ⭐ 点按钮那一刻要写的那一双（尺码/金额/赠品）—— **从提交这一下原样存下来**（拿不到就不存 ✓ 不编 ✗）
          submitPending: {
            size: String(body[fields.size] ?? '').trim(),
            amount: String(body[fields.amount] ?? '').trim(),
            gift: String(body[fields.gift] ?? '').trim(),
            // ⭐⭐ 她在**销售页**填的"每件实收 / 收款行 / 付款情况 / 实付多少"也要一起存下来 ✓
            //   （资金页那张表单**不带**这些字段 ✗ ⇒ 不在这一步存 ⇒ 点按钮建单时它们就丢了 ✗
            //     实测：`AC-E2E-8` 的"她填的实收照旧落表"就是因为丢了这个 ✗）
            // ⭐⭐ 2026-10-16 P0（**写点一处收口**）：存**取值后的那一份**（不是裸 body ✗）——
            //   资金页两个读点（`:1281` pending / `:1561` skip）都回落到这里存的这份
            //   ⇒ 存空 ⇒ 它们也空 ⇒ `items_cents=0` ⇒ 拦住 ✗（= 她那个现场）
            lineAmounts,
            payments: parsePaymentRows(body, fields),
            paymentStatus: String(body[fields.paymentStatus] || '').trim(),
            paidAmount: String(body[fields.paidAmount] ?? ''),
          },
        });

        // ⚠️ 2026-10-16（裁决=甲 · **窄化**）：**提交步维持原状** —— 只判"她带着的那份"里的空项；
        //   "空数组也算缺"那条**只留在资金页（跳过）那一支** ✓
        //   （理由：拦下的**原因码/人话**是她真机看到的东西 ⇒ 不许在没问她之前换掉 ✗）
        if (writeConfig.lineAmountRequired !== false
          && lineAmounts.some((value) => String(value ?? '').trim() === '')) {
          logWarn('scan.write.line_amount_required', { request_id: requestId, lines: lineAmounts.length });

return sendPaymentStep(res, req, {
            paymentMethods: await candidatePaymentMethods(req),
            realm,
            status: 400,
            notice: String(writeConfig.texts.lineAmountRequiredNote || ''),
            totalAmountText: 0,
            submitKey: writeService?.sessions?.submitKeyFor?.(openId, false, 'sale') || '',
            count: lineAmounts.length,
          });
        }
        const paymentStatus = String(body[fields.paymentStatus] || '').trim();
        const paidAmount = body[fields.paidAmount] ?? '';
        // ⭐⭐ 2026-10-12：**提交这一步的分阶段耗时** —— 真机被卡住 / 收过 504 之后要的
        //    "一查日志就知道卡在哪一步"。`timing` 是写服务的**可选出参**（只读时间、不进业务入参）。
        const saleTiming = {};
        // ⭐ 2026-10-12：整页只有**一个表单** ⇒ 提交这一下**天然带着**她在尺码区选中的那一双。
        //    本单为空时 ⇒ 「选尺码 + 提交」两下就是一张单（一单一笔的默认路径）；
        //    本单已有几双 ⇒ 这一项**忽略**（多笔必须显式点【➕ 还要加一双】），
        //    判据在写服务里（`pendingLine` 只在本单为空时生效）。
        const submitLookupStartedAt = Date.now();
        const submitView = String(body[fields.size] ?? '').trim()
          ? await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null) : null;
        // `lookup_ms` = 提交前那一次"取商品"（缓存命中⇒很短；没命中⇒就是飞书那几读）。
        saleTiming.lookup_ms = Math.max(0, Date.now() - submitLookupStartedAt);
        // ⭐⭐⭐ 2026-10-16（task-53 · P0 **第二刀**）：「跳转资金页」的**前置判定** —— 缺尺码或金额 ⇒ 拦住。
        //
        // 业务负责人口径（逐字）：「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，
        //   才可以点击提交跳转到资金页，**不用做那个为空去单价的功能了**」
        //   ⇒ 判据 = **尺码已填 且 她填的实收金额已填**；缺任一 ⇒ **400 + 停在货品页 + 人话 + 零写入** ✓
        //
        // ⚠️ 落点三条理由（计划书 §1，都实测过）：
        //   ① **贴住那一个出口**（下面 `return sendPaymentStep(...)` 就是"点提交要跳资金页"的唯一出口）
        //      ⇒ 跳了就必须先过它，结构上不可能"跳了又拦" ✓；
        //   ② **不能往前挪**：`:1712` 起那几条更早的出口会连带罩住**幂等连点 / 重复提交 / 刷新 /
        //      资金页动作**（①刀那 6～13 条红就是挪早了 ✗）；
        //   ③ 仍在 `:1889` 那次 `service.lookup` **之后**（不挪动既有语句 ⇒ diff 最小 ✓）。
        //      ⚠️ 判定本体**不需要** `submitView` ⇒ **一次表都不读**（少一次飞书读 ✓）。
        //
        // ⚠️ 这是**独立的一块**：既有的那道闸门（`:1865` 的 `lineAmountRequired && lineAmounts.some(空)`）
        //    **一个字都没动**，新判定**没有**塞进那个 `if` 里 ✗（它是"她带着的那份里的空项"，
        //    与"缺尺码 / 缺金额 ⇒ 根本不许跳"是两件事）。
        //
        // ⚠️ 入口三条（缺一不进判定 ⇒ 不许拦）：
        //   ① `action === submitOrder`（资金页那颗是 `payAction` ⇒ 天然分开 ✓）；
        //   ② 这一发**不带收款字段**（带了 = 资金页那一跳 / 或本单流程还在往前走 ⇒ 不进 ✓）；
        //   ③ 会话标记 `paymentStep !== 'pending'`（她**再点一次** / 刷新与 ⑨ 同形 ⇒ 只能靠它
        //      区分"第一次点提交"与"已经放行过的重复提交" ✓）。
        const jumpGateHasPaymentField = asList(body[fields.paymentMethod]).length > 0
          || asList(body[fields.paymentAmount]).length > 0
          || asList(body[fields.lineAmount]).length > 0;
        const jumpGateIsFirstSubmit = String(submitSession?.sale?.paymentStep || '') !== 'pending';
        if (!jumpGateHasPaymentField && jumpGateIsFirstSubmit) {
          // 尺码 = 尺码区那一选（`body[fields.size]`）**或**本单草稿行里任一行有尺码
          //   （多行时这一发 body 不带 size ⇒ 必须看会话草稿行 ✓ 见 v2 计划 §3）。
          // ⚠️ 取舍（计划书 §6「配品行天生没有尺码」那一处）：本刀**按她字面**做 ——
          //   **尺码必须填**（不按 `requiresSize` 分叉）；"配品单"那条口子若要做，
          //   由她拍板后另开一刀（PR 里如实标注 ✓ 不擅自放宽 ✗）。
          const jumpGateHasSize = String(body[fields.size] ?? '').trim() !== ''
            || pendingDraftLines.some((line) => String(line?.size ?? '').trim() !== '');
          const jumpGateHasAmount = lineAmounts.some((value) => String(value ?? '').trim() !== '');
          if (!jumpGateHasSize || !jumpGateHasAmount) {
            // 日志：她（和我）"一查就知道卡在哪一段" ⇒ 与既有事件同一形状（不新造事件名 ✗）。
            logWarn('scan.write.jump_gate_blocked', {
              request_id: requestId, has_size: jumpGateHasSize, has_amount: jumpGateHasAmount,
            });
            return sendHuman(res, 400, {
              // 🔴 措辞从配置读（用户可见中文只许在 `src/config/**` ✗ 不许在本文件写死）：
              //   真源 = `config/scanPage.js` 的 `TEXTS.jumpGateNoticeTitle`（= 她这一刀的原话口径）。
              title: config.texts.jumpGateNoticeTitle,
              body: writeConfig.texts.lineAmountRequiredNote || '',
              requestId,
              // 「停在货品页」：回跳就是她自己扫的那一页（既有 `postActionFor` / `backTargetFor` ✓ 不新造 ✓）
              backPath: postActionFor(
                backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
              ),
              backLabel: writeConfig.texts.submittedRecordAnother,
            });
          }
        }
        const submitStartedAt = Date.now();
        // ⭐⭐ 2026-10-14（业务负责人口径，逐字）：「**确认状态是资金那页点击了按钮之后，才算是用户确认了**」
        //   ⇒ 点「提交这一单」**只到资金页、一个字都不写表** ✗（不建单 / 不写明细 / 不动库存 ✓）
        //   ⇒ 把"这一单要写什么"**记进服务端会话** ✓（第二小步：点资金页按钮时才据此建单 ✓；刷新时 GET 也认它 ✓）
        //   ⚠️ 用**既有**会话机制（`saveSaleProgress` 的薄透传 `saveDraftLines` ✓ 不新造 ✓）
        // ⚠️ 2026-10-16 P0：`submitSession` / `pendingDraftLines` **已上移**到本分支开头
        //   （`lineAmounts` 的回落要用它 ✓）—— **这里不许再声明一次** ✗（重复声明 = SyntaxError）
                // ⚠️ 2026-10-16 P0：这一段 `saveDraftLines({ paymentStep:'pending', … })` **已上移到闸门之前** —— **这里不许再写第二份** ✗

        // ⭐ 资金页：还没建单 ⇒ `orderNo: ''`（**不编** ✗）· `count` 用草稿行数 ✓
        // ⭐⭐ 2026-10-16 task-62（**货 / 钱分离** · 设计文档 §5 改动 A）：
        //   **没有开关了** ⇒ **就在这一刻建单** —— **只写「货」那一半**（主表总金额/赠品/交易类型 ＋ 明细 ＋ 销售状态 ✓
        //   **不扣库存** ✓ **不记 `completed`** ✓ 收款明细 0 行 ✓ —— 那是冻结件 `deferFunds: true` 的语义 ✓）。
        let goodsOrderNo = '';
        // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）**：
        //   改前逐字：`if (resolveSaleMoneySplit` ＋ `Config().enabled === true) { … }`（开关关着 ⇒ 这段一个字都不跑）
        //   改后逐字：**闸门删掉** ⇒ 这段**永远跑**（货品页建单 / 现货当场扣 / 钱待补 ✓）
        //   依据 = 业务负责人 2026-10-16 22:5x 逐字：「**把新功能都上了，不需要开关。**」✓
            const goods = await writeService.submitSale({
              openId,
              requestId,
              submitKey: body[fields.submitKey],
              payments: [],          // 🔴 货那一跑**不许带收款**（带了冻结件当场抛 ✓）
              deferFunds: true,      // ⭐ 阶段二（#763）已就位 ✓ 本刀只**接线** ✗ 不改冻结件 ✓
              lineAmounts,           // 与今天**同一个**取值口径 ✓
              // ⚠️ 成对迁移（改前逐字 → 改后逐字 → 依据）：④ 那刀把「货那一跑」从带 timing 的那段挪了出来 ⇒
              //   改前逐字：这一发 `submitSale({…})` **没有** `timing`（而带 timing 的那次成了**死代码** ✗）
              //   改后逐字：补回 `timing: saleTiming,`（`saleTiming` 声明在 `:2867` 活代码里，不重复声明 ✓）
              //   依据 = 她的硬口径「每个关键流程节点都要有日志和可排查路径」＋ ④ 货/钱分离口径 ✓
              timing: saleTiming,
              // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）** —— 2026-10-16 深夜 · 修 `session_empty`（400）✗：
              //   改前逐字：这段 `submitSale({…})` **没有** `pendingLine`（旧流程里它是靠下面那条【死代码】补的 ✗）
              //   改后逐字：本段末尾补上 `pendingLine`（**逐字照抄** 下面 :2948 那份既有形状 ✓ 不新造 ✗）
              //   依据 = 我逐层核到的事实：`scanWriteService.js:833` 拿行只有两条路（会话里已有行 ／ 传了 `pendingLine` 就当场 addLine ✗）
              //     ＋ ⭐ ④ 取消开关后，带 `pendingLine` 那条路（原 :2951）被这条货那一跑的 `return` 顶成了**死代码** ✗
              //     ⇒ 她「选尺码 ＋ 一次 POST 提交」这条流**行没被加进会话** ⇒ `:867 lines=[]` ⇒ `:868` 抛 `session_empty` ⇒ 400 ✗
              //   依据（业务口径）= 她 2026-10-16 23:5x 逐字：「我先点了，我再点完货品的时候，我就创建单号了。**那为什么我在成功页里面看不到呢？那我肯定能看到这个单号呀**」✓
              pendingLine: submitView?.found ? {
                productRecordId: submitView.product_record_id,
                number: submitView.number,
                itemNo: submitView.item_no,
                color: submitView.color,
                size: body[fields.size],
                amount: body[fields.amount],
                gift: body[fields.gift],
                // 「现货 / 预订」的判据与页面上那两个分组**同一份**（写服务按既有判据推编码）。
                inStock: sellableSizeTexts(submitView).has(String(body[fields.size] ?? '').trim()),
              } : null,
            });
            // 🔴 失败**如实**：绝不带着空单号继续去资金页当她"成功了" ✗
            if (!goods || goods.ok !== true) return respondWriteFailure(res, goods, requestId);
            goodsOrderNo = String(goods.order_no || '');
            logInfo(writeConfig.events.saleTiming, {
              request_id: requestId,
              // 2026-10-15（⑨b-2）：她那次请求这一段（后台那一跑另打一条，同事件名 + `phase`）。
              phase: writeConfig.timing.phase.request,
              ok: goods.ok === true,
              code: goods.code || '',
              order_no: goods.order_no || '',
              reused: goods.reused === true,
              partial: goods.code === 'sale_partial_failed',
              lines: lineAmounts.length,
              submit_ms: Math.max(0, Date.now() - submitStartedAt),
              queue_wait_ms: Number(saleTiming.queue_wait_ms) || 0,
              lookup_ms: Number(saleTiming.lookup_ms) || 0,
              prepare_ms: Number(saleTiming.prepare_ms) || 0,
              master_ms: Number(saleTiming.master_ms) || 0,
              status_ms: Number(saleTiming.status_ms) || 0,
              detail_ms: Number(saleTiming.detail_ms) || 0,
              stock_ms: Number(saleTiming.stock_ms) || 0,
            });
        return sendPaymentStep(res, req, {
          paymentMethods: await candidatePaymentMethods(req),
          realm,
          submitKey: body[fields.submitKey],
          count: pendingDraftLines.length,
          // ⭐ 2026-10-17 E（她逐字：「资金页要显示**总金额**」）：
          //   总金额 = 本单各行成交金额之和（**同一份 `lineAmounts`**，不另算一份钱 ✗）。
          //   拿不到（全空 / 非数字）⇒ 空串 ⇒ 页面不渲染那一行（不编 ✓）。
          totalAmountText: (() => {
            const cents = (Array.isArray(lineAmounts) ? lineAmounts : []).reduce(
              (sum, value) => sum + Math.round(Number(String(value ?? '').trim() || 0) * 100), 0,
            );
            return cents > 0 ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '';
          })(),
          // ⭐ 开着时如实给她单号；**关着 ⇒ 这个键根本不出现** ⇒ 页面逐字节不变 ✓
          ...(goodsOrderNo ? { orderNo: goodsOrderNo } : {}),
        });
        // eslint-disable-next-line no-unreachable
        const result = await writeService.submitSale({
          openId,
          requestId,
          submitKey: body[fields.submitKey],
          payments,
          lineAmounts,
          paymentStatus,
          paidAmount,
          timing: saleTiming,
          pendingLine: submitView?.found ? {
            productRecordId: submitView.product_record_id,
            number: submitView.number,
            itemNo: submitView.item_no,
            color: submitView.color,
            size: body[fields.size],
            amount: body[fields.amount],
            gift: body[fields.gift],
            // 「现货 / 预订」的判据与页面上那两个分组**同一份**（写服务按既有判据推编码）。
            inStock: sellableSizeTexts(submitView).has(String(body[fields.size] ?? '').trim()),
          } : null,
        });
        // ⭐⭐ **一条**汇总（与 `scan.lookup.timing` 同一形状）：她按 `scan.sale.timing` grep
        //    就能看出"这一次提交卡在哪一段"，不必再靠猜。
                if (!result.ok) {
          // ⭐⭐ 2026-10-12：**建单成功、后面某一步（明细 / 收款 / 进度）抛错** ⇒ 如实说"半成"。
          //    🔴 判据用的是**既有**那一条：会话里已经落了主表 record_id（= 重试接着写的那条判据，
          //       见 `scanWriteService.submitSale` 里"建完立刻把 record_id 落进会话"那段）。
          //    🔴 **绝不许**显示"提交已成功"（她会以为钱货都落了）；也**不许**跟"一个字都没写"
          //       混为一谈（主表那条记录是真的落库了）⇒ 这一页给她**单号** + 怎么出去。
          if (result.code === 'sale_partial_failed') {
            const orderLine = fillWriteText(writeConfig.texts.submittedOrderLine, {
              orderNo: result.order_no || '—',
            });
            return sendHuman(res, 500, {
              title: writeConfig.texts.partialFailedTitle,
              body: fillWriteText(writeConfig.texts.partialFailedBody, {
                orderNo: result.order_no || '—',
              }),
              requestId,
              details: [orderLine],
              retryHint: writeConfig.texts.partialFailedRetryHint,
              // 怎么出去：回扫码页再点一次提交 —— 会接着**同一张单**写（幂等键 / 主表 id 都在会话里）。
              // ⭐ `/r` 底下「再录一单 / 回去再提交」要回**记录 ID** 那一页。
              backPath: postActionFor(
                backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
              ),
              backLabel: writeConfig.texts.submittedRecordAnother,
            });
          }
          // ⭐⭐ 校验类失败（**核心那条：全付时每件实收合计 ≠ 收款合计**，以及付款情况 /
          //    收款行 / 每件实收本身的格式问题）⇒ **原地重渲染销售那一块**：
          //    差额人话挂在表单上方，她刚填的每件实收（在会话里）/ 付款情况 / 实付多少 /
          //    多笔收款（原样带回）都还在 —— 改一下再点提交即可。
          //    🔴 这一条**不写库**（写服务里那一段在校验之后才建主表），页面上也会把差额说清。
          if ((writeConfig.sale.formFailureCodes || []).includes(result.code)) {
            const view = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
            if (view?.found) {
              const write = await buildWriteContext(req, view, 'sales', {
                paymentRows: payments, paymentStatus, paidAmount, errorText: result.message,
              });
              const html = renderScan(view, config, write, 'sales', { userAgent: req.headers['user-agent'] });
              return sendHtml(res, 400, html);
            }
          }
          return respondWriteFailure(res, result, requestId);
        }
        // ⭐ 销售单写成功 ⇒ **立刻作废**「实时库存」快照（她：库存必须准确，不是等 30 秒）。
        invalidateInventorySnapshot(requestId, 'scan_sale_submitted');
    // ⭐ 写成功 ⇒ 记住"她刚在销售里干过活"（下次**裸扫**默认还回这儿，除非她提交了 ⇒ 回销售 ✓）
    markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitOrder));
        const texts = writeConfig.texts;
        const details = [
          fillWriteText(texts.submittedOrderLine, { orderNo: result.order_no || '—' }),
          fillWriteText(texts.submittedDetailLine, { count: result.detail_count || 0 }),
          // 🔴 2026-10-16（A2/A3）：原来这里还有**一句"下一步去哪"的提示**（她 2026-10-12 问过
          //   "那我接下来去哪补钱" ⇒ 当时加的）—— 她 2026-10-16 **逐字**：「（资金页那）三处提示
          //   【**全删**】……**全删就对了**」⇒ 那句**连键带两处引用一起删** ✓
          //   **塞回即红**：`test/saleSuccessHintRemoval.test.js` 的 AC-SNS1 / AC-SNS2
          //   ＋ 渲染面 = `test/scanSaleE2E.test.js` 的 AC-E2E-14 ✓。
        ];
        // ⑥ ⭐ 2026-10-11（A）：现货行"提交即交付 + 扣库存"**没扣成** ⇒ 给她一张**如实**的结果页
        //    （单子记上了 / 哪几双没扣成 / 怎么办），**不是**一句"没成功"把整件事说反。
        //    ⚠️ 这一单**没有**被记成"提交完成"（见 `scanWriteService.submitSale`）⇒
        //       照着重试那一句再点一次【提交这一单】，就会接着把没扣成的那几双扣掉。
        if (Number(result.stock?.failed || 0) > 0) {
          return sendHuman(res, 200, {
            title: texts.stockFailedTitle,
            body: fillWriteText(texts.stockFailedBody, {
              failed: result.stock.failed,
              reason: (result.stock.reasons || []).join('；'),
            }),
            requestId,
            details,
            retryHint: texts.stockFailedRetryHint,
          });
        }
        // ⚠️ 2026-10-10：原来钱没记时会补一句「这一单先记了货、还没记钱…」（`fundsPendingNote`）——
        //    那是**解释既有口径**的说明句，按业务负责人的口径删掉；写完的事实（单号 / 双数）照旧。
        // ⭐ 2026-10-11 晚：她**显式选了「全付」却一笔收款都没填** ⇒ 单子照**按未付**落
        //    （不拦她 —— 她真机就是被"资金不齐"卡住的），但结果页给她一句**指向能做的事**的人话。
        const submitHint = result.full_without_payments
          ? texts.fullWithoutPaymentsNote : texts.submittedNextHint;
        // ⭐⭐ 2026-10-12（业务负责人真机口径，逐字）：「点击提交之后**直接提示"您的提交已成功"**就行，
        //    **页面跳转到提交成功页**……给一个**链接**让我能回到扫码页。」
        //    ⇒ 从这里出去的是**成功页**（H1 逐字「您的提交已成功」+ 一颗【再录一单】回扫码页），
        //      **不再**渲染回原页、也不 303。⚠️ 连点的那一次（`reused`）同样给这一页 ——
        //      她**看到了成功**，才不会再狂点（真实事故：她点了 14 次）。
        const submitTarget = backTargetFor(req, decodeURIComponent(String(req.params.number || '')));
        // ⭐⭐ 2026-10-13「金额两步走」第 2 步（业务负责人：**可写可不写** ✓）：
        //    提交成功 ⇒ **先落「整单付款」页**（三档横向 + 收款多行 + 赠品，可填可不填）
        //    ⇒ 她点【提交整单付款】（不填金额 = 未付）⇒ 走 `payment_pay` 动作 ⇒ 成功页 ✓
        //    🔴 未付提交 = 记成「待补充的信息单」：**不写收款 / 不说已收 / 也不报失败** ✓
        //    ⚠️ 2026-10-14：渲染搬去 `sendPaymentStep`（逐字搬迁 ✓ 提交与按钮两处共用 ✓）
        try {
          return sendPaymentStep(res, req, {
            paymentMethods: await candidatePaymentMethods(req),
            realm,
            submitKey: body[fields.submitKey],
            orderNo: result.order_no || '',
            count: result.detail_count || 0,
            reused: result.reused,
            // ⭐ 第 2 步的付款要写「收款明细」⇒ 用**这次提交就有**的主表 record_id（不反查 ✓）
            salesEntryRecordId: result.sales_entry_record_id || '',
          });
        } catch (error) {
          logError(config.events.failed, {
            request_id: requestId, reason: 'payment_step_render_failed', error: error.message,
          });
        }
        return sendSuccess(res, 200, {
          // ⭐ 提交成功 ⇒ 自动回【销售】首页（+ 一颗【返回扫码】兜底，同一个 URL ✓）；「再录一单」照旧保留 ✓
          // ⭐ 提交这一单 ⇒ 回跳带它的单号（ⓑ 顶部指引的数据来源 ✓）
          ...successReturnFields(req, submitTarget, result.order_no || ''),
          title: result.reused ? texts.submittedAgainTitle : texts.submittedTitle,
          body: result.reused
            ? fillWriteText(texts.submittedAgainBody, { orderNo: result.order_no || '—' })
            : fillWriteText(texts.submittedBody, {
              orderNo: result.order_no || '—', count: result.detail_count || 0,
            }),
          requestId,
          details,
          retryHint: submitHint,
          // 「再录一单」= 回到**这一款**的扫码页（编号取自 URL；非缺省领域带上 `?from=`）。
          // ⭐ `/r` 底下「再录一单」回到**记录 ID** 那一页（不是 `/s/<记录id>`）。
          backPath: postActionFor(
            backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
          ),
          backLabel: texts.submittedRecordAnother,
          backHint: texts.submittedRecordAnotherHint,
        }, req);
}

module.exports = { handleSubmitOrder };
