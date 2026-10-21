'use strict';
const { tapIdFromRequest } = require('../../../utils/correlationFields');

/**
 * 扫码路由核心深拆 P1：资金处理（`payment_pay`）分支（从 `routes/scanPage/index.js` 搬出，**只搬不改**）。
 * 调用方只传显式 ctx；分支体逐字搬移，调用顺序/日志/文案/状态一个未动。
 */

async function handlePaymentPay(ctx) {
  const { SalesFollowupService, asList, backTargetFor, body, candidatePaymentMethods, config, fields, fillWriteText, invalidateInventorySnapshot, logError, logInfo, logWarn, markRealmUsed, openId, openIdOf, parsePaymentRows, realm, realmOfAction, req, requestId, res, respondSettlementBlock, respondWriteFailure, sellableSizeTexts, sendHuman, sendPaymentStep, sendSuccess, service, voucherPayments, writeConfig, writeService, options, successReturnFields, lookupInputOf } = ctx;
        // ⭐⭐ 2026-10-14（业务负责人口径，逐字）：「**确认状态是资金那页点击了按钮之后，才算是用户确认了**」
        //   ⇒ **建单就发生在这一刻** ✓（点「提交这一单」时只到资金页、一个字都没写 ✓）
        //   · 会话里记着 `paymentStep:'pending'` ⇒ 说明她刚点过「提交这一单」、还没建单 ✓ ⇒ **现在建** ✓
        //   · ⚠️ 不是 pending ⇒ 走**既有**老流程（一字不改 ✗）
        //   · 🔴 金额/收款不齐 ⇒ `submitSale` 自己会拒（**它才是那份校验的真源** ✓ 路由不重算 ✗）
        //      ⇒ 拒了 ⇒ ⭐ **原地重渲染资金页 + 那句人话** ✓ **一个字都不写表** ✗（不会假成功 ✓）
        const paySession = await writeService?.sessions?.get?.(openIdOf(req)).catch(() => null);
        const payPending = (paySession?.sale?.paymentStep || paySession?.paymentStep) === 'pending';
        let createdResult = null;
        // ⭐ 这一步的墙钟起点（打点用 ✓ 见下面那条 `scan.sale.timing`）
        //   ＋ ⭐⭐ 2026-10-15（⑨b-2）：**打点载体**要**留一个名字** —— 写服务把各分段**写进传进去的
        //   这个对象**（`submitSale({ timing })` ✓），而它**不把 timing 放回返回值** ✗。
        //   改前逐字：`timing: {}` 传进去、打点时却读 `createdResult.timing?.master_ms`
        //     ⇒ 取到 `undefined` ⇒ **七个分段全是 0**（`payment_pay` 这条**她最常走**的路上
        //       "卡在哪一步"其实**一直打不出来** ✗ —— 与"每个关键节点都要有日志"冲突）。
        //   改后逐字：`timing: payStepTiming` 传进去、打点时读 `payStepTiming.*` ⇒ **真的数** ✓。
        //   🔴 **只改读取口**：事件名 / 字段名 / 形状一个都没变 ✗，也不影响任何写入判据 ✓。
        const payStepStartedAt = Date.now();
        const payStepTiming = {};
        if (payPending) {
          const pendingLines = Array.isArray(paySession?.sale?.lines) ? paySession.sale.lines : [];
          const pendingInfo = paySession?.sale?.submitPending || paySession?.submitPending || {};
          // ⚠️ 与提交那一下**同一套**解析（`parsePaymentRows` / `asList` ✓ 不新造 ✗）
          //   ⭐ 资金页那张表单**不带**"每件实收"（`line_amount`）⇒ ⭐ **优先用她提交时就填好的那份** ✓
          //     （实测 `AC-E2E-8`："她填的实收照旧落表" 就是靠这一条 ✓ 拿不到就退回表单 ✓ 不编 ✗）
          // ⚠️ 先保留**原始表单行**（券解析要看原始行 ✓）；"金额 0 = 未付不写收款"在下面 `paidPayments` 再滤 ✓
          const formPayments = parsePaymentRows(body, fields);
          const pendingPayments = formPayments.length
            ? formPayments
            : (Array.isArray(pendingInfo.payments) ? pendingInfo.payments : []);
          // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）** —— ⭐ 2026-10-16 深夜 · 修「资金页那一按 500」✗：
          //   改前逐字：`asList(body[lineAmount]) 有值 ? 表单那份 : 会话那份`（**表单优先** ✗）
          //   改后逐字：**会话那份优先**（= ⭐ **货那一跑已经落下的那份金额** ✓），表单只作兜底 ✓
          //   依据 = 业务负责人 2026-10-16 23:4x 当次口径（ⓐ「**修**」）：
          //     「让**资金页那一步别自己重算金额** ⇒ **直接用货那一半已经写好的那份**」✓
          //   🔴 为什么必须同源：`services/salesOrderService.js:238` 那条守卫会拿
          //     「已记录的销售明细」与**本次推导的** expected **逐值比金额**（含「实收金额」）✗
          //     ⇒ 表单那份（例 `['150','130']`）与货那半落的（例 `['280']`）一比就 `sale_partial_failed` ⇒ **500** ✗
          const sessionLineAmounts = Array.isArray(pendingInfo.lineAmounts) ? pendingInfo.lineAmounts : [];
          const bodyLineAmounts = asList(body[fields.lineAmount]);
          const pendingLineAmounts = sessionLineAmounts.some((v) => String(v ?? '').trim())
            ? sessionLineAmounts
            : bodyLineAmounts;
          const pendingPaymentStatus = String(body[fields.paymentStatus] || pendingInfo.paymentStatus || '').trim();
          const pendingPaidAmount = body[fields.paidAmount] ?? pendingInfo.paidAmount ?? '';
          const pendingSize = String(pendingInfo.size || '').trim();
          // ⭐⭐⭐ 2026-10-16（task-57 · 抖音团购券 · 业务负责人逐字）：
          //   「**差额的计算按照面值来**，但是**收款明细里的收款金额按照平台结算款**来」
          //   「是的，抖音团购券的是**待平台结算**」
          //   ⇒ 一张券 = **两个数各归各位**（口径与算式见 `services/voucherPaymentService.js`）：
          //      · 收款行交给写层的金额 = 【**平台结算款**】（收款明细那一笔的事实 ✓）
          //      · 差额按【**面值**】算 ⇒ 把 (面值 − 结算款) 从**货品那一侧**扣掉
          //        （差额的全仓唯一算法是 `累计 − 已收`，不扣就变成 `货品 − 结算款` ✗）
          //   🔴 **认不出那张券 / 券目录读不到** ⇒ **大声 warn + 拦住这一单**（400 + 人话 + 零写入）——
          //      **绝不静默把一条券当成普通收款记一笔** ✗（那会写一个错的金额进账，她事后对不上）
          //   ⚠️ 一行券都没有 ⇒ 原样返回、**券目录一次都不读** ⇒ 既有链路逐字不变 ✓（`voucherRows` 空）
          const voucher = voucherPayments.settings.enabled
            ? await voucherPayments.resolveRows(pendingPayments).catch((error) => ({
              ok: false, reason: 'voucher_resolve_failed', error: error?.message || 'unknown',
            }))
            : { ok: true, payments: pendingPayments, voucherRows: [], balanceDeltaCents: 0, faceValueCents: 0 };
          if (voucher.ok !== true) {
            logWarn('scan.write.voucher_blocked', {
              request_id: requestId,
              reason: String(voucher.reason || 'voucher_unresolved'),
              unresolved: Array.isArray(voucher.unresolved) ? voucher.unresolved.map((row) => row.method) : [],
            });
            // ⚠️ 与既有那条"能改的 ⇒ 400 + 原样带回她填的"**同一形状**（`sendPaymentStep` ✓ 一份实现 ✗ 不另起）
            //   ⚠️ 不传 `paymentStatus` / `paidAmount`：那一组控件（三档 + 实付多少）**已从资金页退场**
            //      ⇒ 传旧值只会误导下一屏（与 A2a 那条注释同一个理由 ✓）
            return sendPaymentStep(res, req, {
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: body[fields.submitKey],
              count: pendingLines.length,
              notice: voucherPayments.settings.unresolvedText,
              // ⭐ 她刚填的钱**原样带回**（她改一下就能再点 ✓）—— **不是**解析后的那一份（那会替她改数 ✗）
              paymentRows: pendingPayments,
              status: 400,
            });
          }
          // ⭐⭐ 2026-10-18（业务负责人逐字）：「**资金页面也得填写了，必须填写**；但**不一定要等于
          //   货品合计的总金额**，**0 也可以填**，必须得填写金额」
          //   ⇒ **金额必填闸门**（同步拦、零写入）：非券行的金额必须是**非负数字**（`0` 合法）；
          //   ⚠️ **券行豁免**：券的金额 = **平台结算款**（自动算）⇒ 券行不要求手填金额 ✓。
          const voucherMethods = new Set((voucher.voucherRows || []).map((row) => String(row.method || '')));
          const invalidAmountRow = pendingPayments.find((row) => {
            if (voucherMethods.has(String(row.method || ''))) return false;
            const raw = String(row.amount ?? '').trim();
            if (!raw) return true;
            const value = Number(raw);
            return !Number.isFinite(value) || value < 0;
          });
          if (!pendingPayments.length || invalidAmountRow) {
            logWarn(writeConfig.events.paymentAmountRequired, {
              request_id: requestId,
              rows: pendingPayments.length,
              empty: Boolean(invalidAmountRow),
            });
            return sendPaymentStep(res, req, {
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: body[fields.submitKey],
              count: pendingLines.length,
              notice: config.paymentStep?.amountRequiredNote || '',
              // ⭐ 她刚填的那几行**原样带回**（不许替她改数 ✗）
              paymentRows: pendingPayments,
              status: 400,
            });
          }
          // ⭐ 交给写层的收款行：**金额 0 的行滤掉**（`0` = 这一单没收到钱 ⇒ 未付/待补充，不写收款明细 ✓）
          const paidPayments = voucher.payments.filter((row) => Number(row.amount) > 0);
          const effectiveLineAmounts = voucherPayments
            .adjustLineAmounts(pendingLineAmounts, voucher.balanceDeltaCents).amounts;
          if (voucher.voucherRows.length) {
            logInfo('scan.write.voucher_resolved', {
              request_id: requestId,
              voucher_count: voucher.voucherRows.length,
              voucher_methods: voucher.voucherRows.map((row) => row.method),
              face_value_cents: voucher.faceValueCents,
              balance_delta_cents: voucher.balanceDeltaCents,
              voucher_names: voucher.voucherRows.map((row) => row.name),
            });
          }
          // ⭐⭐ 2026-10-16 A2a（她：**页面去三档** ⇒ 档位**按金额自动定**）——
          //   改前逐字：档位 = `Object.keys(payStatusMap).find((key) => payStatusMap[key] === pendingPaymentStatus) || ''`
          //     （**从"请求体 / 已存档"反查** ✗）⇒ 页面去掉那三个单选框之后**必然查不到** ⇒ 被判 `unknown_mode` **拦住** ✓
          //   改后逐字：`autoModeOf({ itemsCents, paymentsCents })` —— **按金额推档**（纯函数 ＋ 配置表 ✓ 真源一份 ✓）
          //   依据 = 她 2026-10-16 逐字（"别让他带着这三个单选提交"）⇒ 本段是它的**前半刀**（页面 + 判据去档）✓
          //   🔴 **本段仍然接受** body 里的旧档位（**不拒绝** ✗ —— 拒绝留到 A3 ✓）；它只是**不再是判据**了 ✓
          //   ⭐ 券那一刀（2026-10-16）只换了**两个入参**（`effectiveLineAmounts` / `paidPayments`）——
          //      档位怎么算、后面怎么校验，**一个字没改** ✗
          const toCents = (value) => Math.round(Number(value || 0) * 100);
          const itemsCents = effectiveLineAmounts.reduce((sum, value) => sum + toCents(value), 0);
          const paymentsCents = paidPayments.reduce((sum, row) => sum + toCents(row.amount), 0);
          // eslint-disable-next-line global-require
          const { resolveSettlement, autoModeOf } = require('../../../config/saleSettlement');
          const auto = autoModeOf({ itemsCents, paymentsCents });
          // ⭐ 档位的真源仍在 `config/scanWrite.js` 的 `PAYMENT_STATUS`（语义键 ↔ 中文取值 ✓ 不另抄一份 ✗）——
          //   自动定档算出的是**语义键**；交给写服务时要换回**中文取值** ✓
          // eslint-disable-next-line global-require
          const { PAYMENT_STATUS } = require('../../../config/scanWrite');
          const payStatusMap = PAYMENT_STATUS || {};
          const pendingMode = auto.mode || '';
          // ⭐ 交给写服务的档位 = **自动定出来的那一档**（不是请求体里那个旧档位 ✗）——
          //   ⇒ "带着旧档位提交"也照新口径走 ⇒ 旧档位**不会**再把请求带进老分支 ✓（她 2026-10-16 口径 ✓）
          const effectivePaymentStatus = payStatusMap[pendingMode] || '';
          // ⭐⭐ 2026-10-16 A2a：交给写服务的「本次已收」（`paidAmount`）—— **就是收款行合计** ✓
          //   （与下面 `resolveSettlement` 的 `paidCents: paymentsCents` **同一个口径** ✗ 不两套算法）
          //   ⚠️ 一行收款都没有 ⇒ 用原来那个值（空串 ⇒ 不写；未付/全付两支**本来就不读它** ✓ 逐字同旧行为）
          const effectivePaidAmount = paymentsCents > 0 ? String(paymentsCents / 100) : pendingPaidAmount;
          // 收多了 ⇒ 纯函数已经给了 `block`（与既有 `amount_mismatch` **同一句话** ✓ 不新编中文 ✗）
          const settlement = auto.action === 'block' ? auto : resolveSettlement({
            mode: pendingMode,
            itemsCents,
            paymentsCents,
            // ⚠️ 这两处用**解析后**的那一份（券行已经有金额了 / 货品那一侧已扣掉券的抽佣）——
            //    判据形状一个字没变，只是喂给它的是**真正要落库的那两个数** ✓（不然"券金额可空"
            //    会把券行当成"没填钱"，与后面写进去的东西对不上 ✗）。
            hasPaymentRows: paidPayments.filter((row) => String(row.amount ?? '').trim()).length > 0,
            anyLineAmount: effectiveLineAmounts.some((value) => String(value ?? '').trim()),
            // ⭐ 新形状**页面上没有**「实付多少」这个框了（随三档一起去掉 ✓）⇒ "本次已收"**就是收款行合计** ✓
            //   ⚠️ 若传 `null` 会被判 `partial_amount_missing` —— 那是**旧形状**才有的失败 ✗ 不传 ✗
            paidCents: paymentsCents,
          });
          if (settlement.action === 'block') {
            // ⭐ 2026-10-14 晚（她批准埋点补充③：「失败日志带**人话原因码**」）——
            //   今天真机上她点了 6 次「提交整单付款」都只看到 400、日志里**没有任何原因** ✗ ⇒
            //   这里补一条：**只加打点** ✓ 状态码/人话/零写入**一个字都不改** ✗
            //   （她那天那次的原因就是 `amount_mismatch`：选了全付但「实付多少」空着 ✓）
            logWarn('scan.write.settlement_blocked', {
              request_id: requestId,
              code: String(settlement.code || ''),
              reason: String(settlement.reason || ''),
              mode: String(pendingMode || ''),
              items_cents: itemsCents,
              payments_cents: paymentsCents,
            });
            // ⚠️ 文案：**只用既有那几条模板**（`config/scanWrite.js` 的 texts ✓ **不编中文** ✗）
            //   ⭐「全付两边不等」那条要带上**差额金额**（她一眼看到"少多少/多多少"✓ 实测 AC-E2E-16 ✓）
            return respondSettlementBlock(res, req, {
              settlement, effectiveLineAmounts, paidPayments, realm, body, fields, pendingLines,
              effectivePaymentStatus, pendingPaidAmount,
            });
          }
          // ⭐⭐ 2026-10-18（第 4 步提速 · 资金页那一屏）：**跳过这一次"取货品"** ——
          //   改前逐字：无论本单有没有行，都先 `service.lookup(...)` 取一次货品（线上 ≈ 2–5 秒），
          //     只为了在"会话里一行都没有"时补一条 `pendingLine`。
          //   改后逐字：**只有本单真的没有行**才取（其余情况 `pendingView` 是 null ⇒ 同一个 `pendingLine: null`）。
          //   依据 = 第 4 步目标（资金页提交 → 成功页 87s → ~15s）；
          //     🔴 判据没放宽：`pendingLine` 只在本单为空时才被写服务使用（`scanWriteService` 里那条既有闸门）。
          const pendingHasLines = pendingLines.length > 0;
          const pendingView = (pendingSize && !pendingHasLines)
            ? await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null) : null;
          // eslint-disable-next-line no-await-in-loop
          // ⭐ 2026-10-18：资金页上的「赠品」也要落主表（之前被丢弃）。
          const payGift = String(body[fields.gift] || '').trim();
          createdResult = await writeService.submitSale({
            openId: openIdOf(req),
            requestId,
            // 🔴 **同一把 `submitKey`**（幂等不许拆 ✗）：连点两次 / 重试都走这一个键 ✓
            submitKey: body[fields.submitKey],
            // ⭐⭐⭐ 2026-10-18（第 4 步提速 · 资金页那一屏 = **一次跑完**）：
            //   明细 / 收款走**批量口** → 库存走 `applySaleBatch` 批量扣 → 履约=已交付
            //   → **一次收口**写 总金额 + 赠品 + 写入状态（`SalesOrderService.finalizeOneShot`）。
            //   成功判据 = 批量写返回 + 收口那一次 `update`（**不再额外读表校验** ✗）。
            //   改前逐字：这一发没有这个键 ⇒ 走"货/钱分离"的第二跑（同一把键续写，明细/收款逐条、
            //     收口分 3~4 次 PATCH、还再走一遍交付检查）—— 线上实测这一段 30.4s + 16.2s。
            //   依据 = 第 4 步目标（87s → ~15s）＋ `docs/issue-scan-sale-gift-ledger-latency-2026-10-18.md` §5。
            oneShot: true,
            // ⭐⭐ 券那一刀（2026-10-16）：交给写层的是**解析后**那一份 ——
            //   · `paidPayments`：券行的金额 = 【平台结算款】（收款明细那一笔的事实 ✓）
            //   · `effectiveLineAmounts`：货品那一侧已扣掉券的 (面值 − 结算款) ⇒ 差额按【面值】算 ✓
            //   ⚠️ 没有券时这两个变量与 `pendingPayments` / `pendingLineAmounts` **同一个对象内容** ✓
            payments: paidPayments,
            lineAmounts: effectiveLineAmounts,
            // ⭐⭐ 2026-10-16 A2a **接线**（改前逐字 → 改后逐字 → 依据）：
            //   改前逐字：`paymentStatus: pendingPaymentStatus,` —— 传的是**请求体 / 会话暂存里那个旧档位** ✗
            //     ⇒ 页面去掉那三个单选框之后，她这一下**必然不带档位** ⇒ 旧档位恒为 `''` ⇒
            //       写服务按配置默认档（未付）落库 —— 与"按金额自动定档"**对不上**（`partial` 会被落成未付 ✗）
            //   改后逐字：`paymentStatus: effectivePaymentStatus,` —— 传**上面刚按金额自动定出来的那一档** ✓
            //   依据 = 她 2026-10-16 逐字（"别让他带着这三个单选提交"）⇒ 档位**只认金额**（一份真源 ✓）
            paymentStatus: effectivePaymentStatus,
            // ⭐⭐ 同一条接线（**不传就等于把"部分付"堵死**）：写服务「部分付」那一支要的
            //   `paidAmount`（= **本次已收**）在旧形状里来自那个**已退场的「实付多少」输入框**；
            //   改前逐字：`paidAmount: pendingPaidAmount,` ⇒ 新形状下恒为 `''` ⇒ `positiveAmount('')`
            //     ⇒ `partial_amount_missing` ⇒ **她已经确认的这一单被自己的旧形状拦住** ✗
            //   改后逐字：`paidAmount: effectivePaidAmount,` —— 有收款行 ⇒ **收款行合计（元）**；
            //     一行都没有 ⇒ 沿用原来那个值（空 ⇒ 不写；未付/全付两支本来就**不看它** ✓）
            //   依据 = 同一个口径：「本次已收」**就是收款行合计**（与上面 `resolveSettlement` 的 `paidCents` 一致 ✓）
            paidAmount: effectivePaidAmount,
            // 资金页赠品（非空时覆盖本单赠品；空则保留销售页填的那份）
            ...(payGift ? { orderGift: payGift } : {}),
            timing: payStepTiming,
            pendingLine: pendingView?.found ? {
              productRecordId: pendingView.product_record_id,
              number: pendingView.number,
              itemNo: pendingView.item_no,
              color: pendingView.color,
              size: pendingSize,
              amount: String(pendingInfo.amount || ''),
              gift: String(pendingInfo.gift || ''),
              inStock: sellableSizeTexts(pendingView).has(pendingSize),
            } : null,
          }, { correlation: tapIdFromRequest(req) });
          if (!createdResult?.ok) {
            // ⭐ 校验类失败（金额/收款不齐那些 code ✓）⇒ **原地重渲染资金页**：人话挂上去、改一下再点 ✓
            if ((writeConfig.sale.formFailureCodes || []).includes(createdResult?.code)) {
              return sendPaymentStep(res, req, {
                paymentMethods: await candidatePaymentMethods(req),
                realm,
                submitKey: body[fields.submitKey],
                count: pendingLines.length,
                notice: createdResult.message,
              });
            }
            return respondWriteFailure(res, createdResult, requestId);
          }
          // ⭐ 建单成功 ⇒ 标记从「已到资金页」改成「**这一单已经建过**」✓
          //   🔴 **不能清成空串** ✗ —— 否则她**再点一次**时服务端就"忘了"，只会再渲染资金页 ✗，
          //      而她要的是「**这一单刚才已经交过了**」✓（幂等不许拆 ✓ 只写一次但要如实说 ✓）
          await writeService.saveDraftLines?.(openIdOf(req), { paymentStep: 'created' });
        }
        // ⭐⭐ 2026-10-14：**建单那一步的打点**要跟着挪到"点按钮"这里 ✓
        //   （旧流程在"点提交"那一段打 ✓ ⇒ 新流程里那一段不再建单 ✗ ⇒ 不打 ⇒ 她就看不到"卡在哪一段"✗
        //    实测 `AC-E2E-16/17/18/16b`：都要 `scan.sale.timing` ✓ 一条一条要 ✓ 事件名/形状**照旧** ✗）
        if (createdResult) {
          logInfo(writeConfig.events.saleTiming, {
            request_id: requestId,
            // ⭐⭐ 2026-10-15（⑨b-2）：**她那次请求**这一段（`request`）—— 与后台那一跑
            //   **同一事件名**、靠 `phase` 分得清（取值走配置 ✓ 不散写字符串 ✗）。
            phase: writeConfig.timing.phase.request,
            ok: createdResult.ok === true,
            code: createdResult.code || '',
            order_no: createdResult.order_no || '',
            reused: createdResult.reused === true,
            partial: createdResult.code === 'sale_partial_failed',
            lines: Number(createdResult.detail_count) || 0,
            // ⭐ 2026-10-18（第 4 步）：这一屏是**一次跑完**（明细/收款批量 + 库存批量 + 一次收口）
            one_shot: createdResult.one_shot === true,
            // ⚠️ 这一步的墙钟（含排队等前面的写 —— 她连点 14 次时这一段会明显变大 ✓）
            submit_ms: Math.max(0, Date.now() - payStepStartedAt),
            queue_wait_ms: Number(payStepTiming.queue_wait_ms) || 0,
            lookup_ms: Number(payStepTiming.lookup_ms) || 0,
            prepare_ms: Number(payStepTiming.prepare_ms) || 0,
            master_ms: Number(payStepTiming.master_ms) || 0,
            status_ms: Number(payStepTiming.status_ms) || 0,
            detail_ms: Number(payStepTiming.detail_ms) || 0,
            stock_ms: Number(payStepTiming.stock_ms) || 0,
            // ⭐ 2026-10-18（第 4 步）：一次收口那一下的耗时（成功/部分失败都有）
            finalize_ms: Number(payStepTiming.finalize_ms) || 0,
          });
        }
        // ⭐ 建单成功 ⇒ 记下"她刚在销售里干过活" ✓（下次**裸扫**默认还回销售 ✓）
        //   ⚠️ 旧流程在"点提交"那一段记 ✓ —— 新流程改成"**点按钮才建单**"⇒ 这一句也要跟着挪过来 ✗
        //      （实测 `AC-RF4`：写成功要记 `last_realm = sales` ✓ 不挪就丢了 ✓）
        if (createdResult) markRealmUsed(openIdOf(req), realmOfAction(writeConfig.actions.submitOrder));
        const payTarget = backTargetFor(req, decodeURIComponent(String(req.params.number || '')));
        // ⭐ 单号/双数：**优先用刚建单的返回值** ✓（没建单时退回表单里的那两个 ✓ 一律**不编** ✗）
        // ⚠️ **成对迁移（改前逐字 → 改后逐字 → 依据）** —— 2026-10-16 深夜 · 修「成功页看不到单号」✗：
        //   改前逐字：`const paidOrderNo = String(createdResult?.order_no || body.order_no || '').trim().slice(0, 40);`
        //   改后逐字：本行（多一层**会话回落** ✓）
        //   依据 = 业务负责人 2026-10-16 23:5x 逐字（她裁「**该带**」）：
        //     「我先点了，我再点完货品的时候，我就创建单号了。**那为什么我在成功页里面看不到呢？那我肯定能看到这个单号呀**」
        //   🔴 为什么需要回落：④ 永远开 ⇒ **货那一跑（第 1 步）就把单号出了**（`sales.order_no.generated` ✓）
        //     ⇒ 钱那一跑是**同一把 `submitKey` 的复用**（`scanWriteService` 里 `wasResume = true` ✗）
        //     ⇒ 那一次 `createdResult.order_no` **可能是空** ✗ ⇒ 页面就变成 `—`（她看不到号 ✗ = 真 bug ✓）
        //     ⇒ **回落到会话里那个号**（= 她第 1 步看到的那个 ✓）才是对的 ✓
        const sessionOrderNo = String(paySession?.sale?.order_no || paySession?.order_no || '').trim();
        const paidOrderNo = String(createdResult?.order_no || sessionOrderNo || body.order_no || '').trim().slice(0, 40);
        const paidCount = Number(String(createdResult?.detail_count ?? body.count ?? '').trim() || 0) || 0;
        // ⭐ 2026-10-17（C·去跳过）：与 skip 那条**逐字同口径** ——
        //   改前逐字：`const paidReused = String(body.reused || '') === '1';`（只看表单隐藏字段）
        //   改后逐字：**也看建单返回的 `reused`**（同一把 submitKey 再点一次 ⇒ `submitSale` 返回 reused ✓）
        //   依据 = 她 2026-10-17「去「跳过」」＋ 既有口径「这一单刚才已经交过了」（`submittedAgainTitle`）
        //   ⚠️ 不删断言、不放宽：重复提交仍然**只写一次**、但页面**如实**说"已经交过了" ✓
        const paidReused = String(body.reused || '') === '1' || createdResult?.reused === true;
        const paidDetails = [
          fillWriteText(writeConfig.texts.submittedOrderLine, { orderNo: paidOrderNo || '—' }),
          fillWriteText(writeConfig.texts.submittedDetailLine, { count: paidCount }),
        ];
        // ⭐⭐ 2026-10-15（⑨ B 异步）：成功页 payload **仍然只有一个来源**
        //   （成功页的自动回跳来源只在这一处调 `successReturnFields` —— `AC-SR4` 那条接线哨兵
        //     **一个字没动** ✓；⚠️ 注释里也**不写那个调用形状**，免得被源码计数哨兵当第 6 处 ✗）
        //   传了 `asyncSentence`（异步那一条）⇒ **只给她那一句**：
        //   她逐字「**统一文字改成：本单已创建成功（单号），其余文字不需要**，**销售和配品都这样**」
        //   ⇒ `title` = 那一句（含真单号 ✓）、`body` 空、`details` 空；其余照旧 ✓
        const paidPayload = (retryHint, asyncSentence = '') => ({
          ...successReturnFields(req, payTarget, paidOrderNo),
          title: asyncSentence || (paidReused
            ? writeConfig.texts.submittedAgainTitle : writeConfig.texts.submittedTitle),
          body: asyncSentence ? '' : (paidReused
            ? fillWriteText(writeConfig.texts.submittedAgainBody, { orderNo: paidOrderNo || '—' })
            : fillWriteText(writeConfig.texts.submittedBody, { orderNo: paidOrderNo || '—', count: paidCount })),
          order_no: paidOrderNo,
          details: asyncSentence ? [] : paidDetails,
          requestId,
          retryHint,
        });
        // 🔴 只认**填了金额**的行（PAY2 抓到的真 bug：空金额行也曾被当成「要记一笔」⇒ 会写出空账 ✗）
        // ⭐ 2026-10-18：金额必填之后 `0` = 未付（不写收款）⇒ 老流程同样只写 >0 的行 ✓
        const rowsToPay = parsePaymentRows(body, fields)
          .filter((row) => String(row.amount ?? '').trim() && Number(row.amount) > 0);
        // ⭐⭐ 2026-10-14（她：**点资金页按钮 = 确认 ⇒ 才建单**）：
        //   · 刚建单那一次（`createdResult` 有值 ✓）⇒ **这一单的收款已经由 `submitSale` 按同一份入参写好了** ✓
        //     ⇒ 🔴 **不能再走下面那条 `addPayment`** ✗（否则就是**第二遍写收款**✗ ——
        //       写库时会被如实拦住"本次收款超过待收金额 ￥0"✓ 这正是它该有的样子 ✓）
        //   · 而"**补记收款**"（工作台那条既有用法 / 老流程的 order_no 路径）⇒ 照旧走 `addPayment` ✓ **一字不改** ✗
        if (createdResult) {
          invalidateInventorySnapshot(requestId, 'scan_sale_paid');
          // ⭐⭐ 2026-10-15（⑰ B 异步）：**单号一出就回** ——
          //   她逐字：「**统一文字改成：本单已创建成功（单号），其余文字不需要**，
          //   **销售和配品都这样**」⇒ 页面只给**那一句**（含真单号 ✓），
          //   **不给**"明细/收款/进度"那些行 ✗（文案走配置 ✓ 不写死 ✗）。
          //   ⚠️ "再录一单 / 回扫码页"那些**能点的东西照旧** ✓（她说的"其余文字"指的是那句话之外的**描述性文字** ✗）。
          if (createdResult.deferred) {
            const asyncSentence = fillWriteText(
              writeConfig.sale.asyncWrite?.doneBodyTemplate || '',
              { orderNo: paidOrderNo || '—' },
            );
            // ⚠️ 走**同一个** `paidPayload`（不另起一份 payload ✗）⇒ 成功页来源仍只有一处 ✓
            return sendSuccess(res, 200, paidPayload('', asyncSentence), req);
          }
          // ⭐ 成功页那句人话：与"提交成功"那条**逐字同形**（她 2026-10-12 定的那一句 ✓）
          //   ⚠️ `paidPayload(retryHint)` 的参数就是**那句提示** ✓ 不是 note 文本 ✗
          return sendSuccess(res, 200, paidPayload(writeConfig.texts.submittedNextHint), req);
        }
        // ⭐ 没填金额（或行数为 0）⇒ **待补充**：**一个字都不写**、成功页照给、**不报错** ✓
        if (!rowsToPay.length) {
          return sendSuccess(res, 200, paidPayload(config.paymentStep?.payPendingNote), req);
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const followup = options.followup
            || new SalesFollowupService(options.gateway ? { gateway: options.gateway } : {});
          for (const row of rowsToPay) {
            // eslint-disable-next-line no-await-in-loop
            const paid = await followup.addPayment({
              // ⭐ 主表 record_id：**优先用刚建单的返回值** ✓（资金页那份表单里它是空的 —— 那时还没建单 ✗
              //   用空串去写收款 ⇒ 会撞"销售订单尚未确认入账"✗ 这正是新流程多出来的一处 ✓）
              salesEntryRecordId: String(createdResult?.sales_entry_record_id || body.sales_entry_record_id || '').trim(),
              method: row.method,
              amount: row.amount,
              requestId,
              operatorOpenId: openId,
            });
            if (!paid || paid.ok !== true) throw new Error(paid?.message || 'addPayment 未成功');
          }
        } catch (error) {
          // 🔴 写失败 ⇒ **明说失败 + 人话**，**绝不显示"已收"** ✗（她口径：状态不许撒谎 ✓）
          logError(config.events.failed, {
            request_id: requestId, reason: 'payment_add_failed', error: error.message,
          });
          return sendHuman(res, 200, {
            // ⚠️ `writeConfig.texts.errorTitle` 可能是空串 ⇒ 退回页级标题（失败页**不许**没有标题 ✗）
            title: writeConfig.texts.errorTitle || config.texts.errorTitle,
            body: config.paymentStep?.payFailedNote,
            requestId,
            retryHint: writeConfig.texts.submittedNextHint,
          });
        }
        // ✅ 写成功 ⇒ 这**才**能说"已收" ✓
        return sendSuccess(res, 200, paidPayload(config.paymentStep?.paidNote), req);
}

module.exports = { handlePaymentPay };
