'use strict';

/**
 * 扫码路由「写上下文 / 多货品提交 / 打印上下文」helpers（深拆 P3c：从 `routes/scanPage/index.js` 搬出，**只搬不改**）。
 */

const createFlowHelpers = ({
  DEFAULT_REALM, LABEL_PRINT_QUEUE, arrival, backTargetFor, buildPaymentRows, candidatePaymentMethods, clearMultiItemPending, config, fillWriteText, invalidateLiveInventorySnapshot, logError, logInfo, logRendered, logWarn, markRealmUsed, multiItemOrder, multiItemOrderConfig, multiItemWire, openIdOf, postActionFor, purchaseBackground, realmEntryParams, realmOfAction, realmScanConfig, renderMinimalPage, renderSuccess, resolveLabelPrintQueue, respondWriteFailure, router, scanTargetOf, sendHtml, setDraftOrderAmount, successReturnFields, writeConfig, writeService,
}) => {
    const submitMultiItemOrder = async ({
      req, res, requestId, chain, groups, action,
    }) => {
      const engine = multiItemOrder();
      if (!engine) {
        // 引擎不可用（写服务没挂 / 多货品开关关）：**宁可给人话 + 零写入**，
        // 也**绝不**回落老路径 —— 那会把"其余货品"静默丢掉 ✗（她最恨的那种假成功）。
        return respondWriteFailure(
          res, { code: 'disabled', message: writeConfig.texts.writeDisabledBody }, requestId,
        );
      }
      const openId = openIdOf(req);
      const opened = await engine.openDraft({ openId, chain, requestId });
      if (!opened.ok) return respondWriteFailure(res, opened, requestId);
      const orderKey = opened.orderKey;
      // 退货那条链：整单金额**先进草稿**（引擎的校验 `amountRequired` 与载荷 `order_amount` 都读它 ✓）。
      // ⚠️ 空 / 非数字**已经在上面同步拦过**（`purchaseAmount*Page` ⇒ 400 + 人话 + 零写入 ✓），
      //   这里原样透传、**不重算** ✗。
      // ⚠️ **判据来自配置**（`chains[chain].amountRequired` ✓）—— 路由里**不写 `if (补货) … else …`** ✗
      //   （与引擎同一条口径：两条链**只差配置** ✓）。
      if (multiItemOrderConfig.chains[chain]?.amountRequired === true) {
        await setDraftOrderAmount(openId, orderKey, String(req?.body?.[writeConfig.fields.purchaseAmount] ?? ''));
      }
      for (const group of groups) {
        const added = await engine.addItem({ openId, chain, orderKey, item: group, requestId });
        if (!added.ok) return respondWriteFailure(res, added, requestId);
      }
      // 🔴 幂等键 = **本单的 `orderKey`**（一单一把；提交成功后引擎**轮换**它 ✓）——
      //    **不传**表单里那把 key：页面上的 key 在提交后仍是旧值，重放旧页面会把**第 2 单**
      //    算成第 1 单的同一个 `taskId` ⇒ 被第 1 单吸收 ✗（设计 §4.2 的动机）。
      // ⭐⭐ 2026-10-18（业务负责人：「一单多货也要异步」）：
      //   **校验同步、写库后台、先回成功页** ✓；老引擎/假引擎（没有 readDraft/validateDraft）
      //   ⇒ 退回**同步**跑（行为与改前逐字一致 ✓，不让"有没有异步"取决于注入的是什么）。
      const supportsAsync = typeof engine.readDraft === 'function' && typeof engine.validateDraft === 'function';
      if (supportsAsync) {
        // ① 先**同步**校验（拒单 ⇒ 400 + 人话 + 零写入；**绝不能挪后台** ✗）
        const loaded = await engine.readDraft({ openId, chain, orderKey });
        if (!loaded.ok) return respondWriteFailure(res, loaded, requestId);
        const checked = engine.validateDraft({
          draft: loaded.draft,
          chainConfig: multiItemOrderConfig.chains[chain],
        });
        if (!checked.ok) return respondWriteFailure(res, checked, requestId);
        // ② 后台那一跑（与单货品同一套登记簿/日志/失败落痕 ✓）：先回成功页 ✓
        const runMultiItemSubmit = () => engine.submitDraft({
          openId, chain, orderKey, submitKey: orderKey, requestId,
        });
        const markMultiItemFailed = async ({ result, error } = {}) => {
          const message = String(result?.message || error?.message || '').trim();
          try {
            const sessions = writeService && writeService.sessions;
            if (chain === 'replenish' && typeof sessions?.markReplenishFailed === 'function') {
              await sessions.markReplenishFailed(openId, message);
            } else if (chain === 'purchase_return' && typeof sessions?.markPurchaseReturnFailed === 'function') {
              await sessions.markPurchaseReturnFailed(openId, message);
            }
          } catch (markError) {
            logWarn(writeConfig.events.purchaseBackgroundMarkFailed, {
              request_id: requestId, chain, error: String(markError?.message || markError).slice(0, 200),
            });
          }
        };
        if (typeof purchaseBackground.scheduleCustomRest === 'function') {
          purchaseBackground.scheduleCustomRest({
            chain, requestId, submitKey: orderKey,
            context: { openId, requestId },
            run: runMultiItemSubmit,
            markFailed: markMultiItemFailed,
          });
        } else {
          const result = await runMultiItemSubmit();
          if (!result.ok) return respondWriteFailure(res, result, requestId);
        }
      } else {
        const result = await engine.submitDraft({
          openId, chain, orderKey, submitKey: orderKey, requestId,
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
      }
      // ⚠️ 理由串**只从配置取**（`config/multiItemOrder.js` 的 `invalidateReasons`；值与单货品那条路
      //   逐字同一串 ✓）—— **不在源码里再写一遍那两个既有字面量**：它们是既有邻近哨兵 `AC-SR4`
      //   的锚点，在前面多一处就把锚点挤开 ✗（本刀真踩到过 ✓）。
      invalidateInventorySnapshot(requestId, multiItemOrderConfig.invalidateReasons[chain]);
      markRealmUsed(openId, realmOfAction(action));
      // ⭐⭐ 2026-10-16（加/删货那一半）：这一单**已经交出去了** ⇒ 把"已加的货品"那段暂存清掉 ✓
      //   （不清 ⇒ 下一单会看见上一单加的那些 ⇒ 凭空多货 ✗）。⚠️ 只在**成功之后**清：
      //   拒单 / 失败那条路要留着，让她改一改再点（同一 `orderKey` 重试 ✓）。
      await clearMultiItemPending(openId, chain).catch(() => {});
      // ⚠️ task-60：`req` 作**第 4 个实参**传进去 ⇒ 这条成功页的 `scan.page.rendered`
      //    也带得上 `number`（字段齐 ✓）；🔴 **页面本身一个字都不受影响** ✗（那个参数只喂日志）。
      return sendSuccess(res, 200, {
        ...successReturnFields(req, backTargetFor(req, decodeURIComponent(String(req.params.number || '')))),
        requestId,
      }, req);
    };

    const buildWriteContext = async (req, view, realm = DEFAULT_REALM, extra = {}) => {
      if (!writeService) return null;
      const openId = openIdOf(req);
      if (!openId) return null;
      const texts = writeConfig.texts;
      const fields = writeConfig.fields;
      // ⭐ 本单是**按人（登录会话）**存的（`scanSessionService.idOf(openId)`），
      //    **不是按编号** ⇒ 扫 A 加一双、再扫 B 加一双，读到的**是同一份本单**
      //    （"一单跨款累积"就是这么成立的；见 `services/scanSessionService.js` 的文件头）。
      const session = await writeService.sessions.get(openId).catch((error) => {
        // 读自己的会话失败**不影响看库存**：把表单退化成"还没加任何一双"，
        // 她照样能加单（加的时候会重建）。只记一条 warn，不给她报错。
        logWarn(writeConfig.events.failed, {
          request_id: req.requestId, reason: 'session_read_failed', error: error.message,
        });
        return null;
      });
      const sizes = (view.rows || [])
        .filter((row) => !row.unknown_size)
        .map((row) => ({ size_text: row.size_text, missing: Boolean(row.missing) }));
      const defaultPaymentMethod = writeConfig.sale.defaultPaymentMethod;
      // ⭐⭐ 2026-10-16 A2a ③（改前逐字 → 改后逐字 → 依据）：
      //   改前逐字：`const paymentMethods = [...new Set([defaultPaymentMethod, ...(writeConfig.sale.paymentMethods || [])].filter(Boolean))];`
      //     —— 候选**只从配置拼**（表里真实那几条看不到 ✗）
      //   改后逐字：`const paymentMethods = await candidatePaymentMethods(req);`
      //     —— **读「收款方式管理」表**（只读 + TTL 缓存 ✓）；读不到 ⇒ 大声 warn + **退回配置**（见上面那份注释）
      //   依据 = 她 2026-10-14 逐字「**付款方式用交易方式管理，可选择**」
      const paymentMethods = await candidatePaymentMethods(req);
      const lines = session?.sale?.lines || [];
      return {
        enabled: true,
        saleEnabled: writeConfig.sale.enabled !== false,
        replenishEnabled: writeConfig.replenish.enabled !== false,
        // ⭐ 2026-10-11：采购领域的第二个动作（退货）—— 关掉它，那一块就不渲染（与补货同一条口径）。
        returnEnabled: writeConfig.purchaseReturn?.enabled !== false,
        texts,
        fields,
        actions: writeConfig.actions,
        // ⭐⭐ 2026-10-16（task-59 · 表单半）：加/删货那两颗 submit 的接线位（缺省 `null` ⇒ 今天那颗链接 ✓）
        //   ⚠️ 形状见 `views/scanPageRenderer.js` 的 `multiItemBlockHtml`（渲染层缺一个键就不接线 ✓）。
        multiItem: multiItemWire,
        // ⭐⭐ `/r/{recordId}` 底下表单必须 POST 回 `/r/{recordId}`（否则提交会落到"按编号"那条路）。
        postAction: postActionFor(backTargetFor(req, view.number), realm),
        sizes,
        draft: { lines },
        saleKey: writeService.sessions.submitKeyFor(openId, session, 'sale'),
        replenishKey: writeService.sessions.submitKeyFor(openId, session, 'replenish'),
        // ⭐ 退货那把键（第三条链；与销售 / 补货**互不覆盖** —— 会话语义见 scanSessionService）
        returnKey: writeService.sessions.submitKeyFor(openId, session, 'purchase_return'),
        paymentMethods,
        defaultPaymentMethod,
        // ⭐⭐ 总单层的**「付款情况」**（整单三档）：默认档来自配置（**全付**）；
        //     校验失败原地重渲染时，用**她刚才选的那一档**（`extra.paymentStatus`）。
        paymentStatus: String(extra.paymentStatus || writeConfig.sale.paymentStatus?.default || ''),
        defaultPaymentStatus: writeConfig.sale.paymentStatus?.default || '',
        // ⭐ 「部分付」时资金区填的**实付多少**（另外两档服务端不看它）；同样原样回填。
        paidAmount: extra.paidAmount === undefined || extra.paidAmount === null
          ? '' : String(extra.paidAmount),
        // ⭐⭐ 总单层的多笔收款行：预置 N 行（第一行默认「微信」）；校验失败重渲染时
        //     用**她刚填的那几行**（值原样带回来，她改一改就能再提交）。
        paymentRows: buildPaymentRows({
          count: writeConfig.sale.paymentRowCount,
          defaultMethod: defaultPaymentMethod,
          rows: extra.paymentRows,
        }),
        // 校验失败时挂在表单上方的那句人话（差额）；成功路径上是空串。
        errorText: String(extra.errorText || ''),
        // 「刚加入本单」那一句（**文案来自配置**，只有数字来自会话 ⇒ 没有回显注入面）。
        notice: String(req.query?.added || '') === '1' && lines.length
          ? fillWriteText(texts.lineAddedBanner, { count: lines.length })
          : '',
      };
    };

    const loadPendingBatches = async (requestId, timing = null) => {
      if (!arrival()) return null;
      return arrival().pendingBatches({ timing }).catch((error) => {
        logWarn(writeConfig.events.failed, {
          request_id: requestId, reason: 'accept_pending_batches_failed', error: error.message,
        });
        return { ok: false, batches: [] };
      });
    };

    const sendSuccess = (res, status, payload, req = null) => {
      // ⭐ 成功页 = 她看到的落点之一（先记，再渲染 ⇒ "她看到的"与"日志记的"一致 ✓）
      //    `number` 与资金页那条**同一口径**（`scanTargetOf` ⇒ `/s` 用编号、`/r` 用记录 ID ✓）
      logRendered(req, {
        page: 'success',
        trigger: 'write_ok',
        number: String(scanTargetOf(req)?.value || ''),
      });
      try {
        return sendHtml(res, status, renderSuccess(payload, config));
      } catch (error) {
        logError(config.events.failed, {
          request_id: payload?.requestId, reason: 'success_render_failed', error: error.message,
        });
        return sendHtml(res, status, renderMinimalPage({
          title: payload?.title || config.texts.errorTitle,
          body: payload?.body || config.texts.errorBody,
          requestId: payload?.requestId,
        }));
      }
    };

    const invalidateInventorySnapshot = (requestId, reason) => {
      try {
        invalidateLiveInventorySnapshot(reason);
      } catch (error) {
        // 失效失败**不许**把已经写成功的业务打成 500（那才是最坏的）：记一条 warn 就够了。
        logWarn(config.events.failed, {
          request_id: requestId, reason: 'snapshot_invalidate_failed', error: error.message,
        });
      }
    };

    const clearDraftForScanIfNeeded = async (openId, realm) => {
      const params = realmEntryParams(realm, realmScanConfig);
      if (params.keepDraft !== false) return;
      try {
        if (realm === DEFAULT_REALM) {
          if (writeService && typeof writeService.clearDraft === 'function') {
            await writeService.clearDraft({ openId });
          }
          return;
        }
        const chain = String((realmScanConfig.realms && realmScanConfig.realms[realm]) || '').trim();
        if (chain) await clearMultiItemPending(openId, chain);
      } catch (error) {
        logWarn('scan.entry.keep_draft_clear_failed', {
          realm, error: String((error && error.message) || error).slice(0, 200),
        });
      }
    };

    const buildPrintContext = async (number, realm, { requestId, submitted, duplicated, jobId, target = null } = {}) => {
      const texts = LABEL_PRINT_QUEUE.texts;
      // ⭐ 表单 action 落在哪条路上：`/r` 底下是**记录 ID**（`target` 由调用方给），
      //    缺省 `{mode:'number'}` = 与改前**逐字相同**。
      //    ⚠️ `number` 这个入参仍然是**编号**（打印队列按编号找"这一款最近一次"），不要混。
      const base = {
        enabled: true,
        submitted: Boolean(submitted),
        duplicated: Boolean(duplicated),
        postAction: postActionFor(target || { mode: 'number', value: number }, realm),
        actionField: writeConfig.fields.action,
        actionValue: writeConfig.actions.printLabel,
        submitKeyField: LABEL_PRINT_QUEUE.submitKeyField,
        againField: LABEL_PRINT_QUEUE.againField,
        texts,
      };
      try {
        const queue = resolveLabelPrintQueue();
        if (typeof queue.isEnabled === 'function' && !queue.isEnabled()) {
          return { ...base, enabled: false };
        }
        const [status, latest] = await Promise.all([
          queue.status(),
          queue.latestJobForNumber(number),
        ]);
        // 本次（刚提交的那一条）优先：横幅上的"N 张"要跟**她刚点的那一次**对得上。
        const justNow = jobId ? await queue.getJob(jobId).catch(() => null) : null;
        // ⚠️ 只认"这一条任务确实是这一款"的 —— URL 里的 job 参数是手改得了的，不许拿来显示别的款。
        const mine = justNow && Array.isArray(justNow.numbers) && justNow.numbers.includes(number) ? justNow : null;
        // ⭐⭐ 2026-10-12（她：「点完之后没有 Toast、按键置灰之类的提示，页面完全没有及时的交互反馈
        //    ⇒ 我不知道指令到底有没有到达，就会一直狂点」）⇒ 横幅上要回答"**排在第几位**"。
        //    ⚠️ 只读一次；**读不到就不显示这一句**（宁可不说，也不编一个数给她）。
        const queuePosition = mine && typeof queue.queuePositionOf === 'function'
          ? await queue.queuePositionOf(mine.job_id).catch(() => null)
          : null;
        return {
          ...base,
          online: Boolean(status.online),
          last_seen_at: status.last_seen_at || '',
          count_queued: status.counts?.queued || 0,
          // 横幅用"刚提交的那一条"（拿不到就退回最近一次 —— 至少不是空白）。
          banner_job: mine ? queue.summaryOf(mine) : null,
          queue_position: queuePosition,
          job: mine ? queue.summaryOf(mine) : latest,
        };
      } catch (error) {
        logError('scan.label_print.ready_failed', { request_id: requestId, error: error.message });
        return { ...base, enabled: false };
      }
    };
  return { submitMultiItemOrder, buildWriteContext, loadPendingBatches, sendSuccess, invalidateInventorySnapshot, clearDraftForScanIfNeeded, buildPrintContext };
};

module.exports = { createFlowHelpers };
