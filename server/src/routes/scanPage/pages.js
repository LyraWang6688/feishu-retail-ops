'use strict';

/** 扫码页 GET 页面处理（P4-2b 从 routes.js 搬出）。 */
const { SCAN_DELISTED } = require('../../config/scanPageDelisted');
const { resolveActor } = require('../../services/authorizationService');
const { costTextOf } = require('../../services/scanPageCost');
const { can } = require('../../config/permissions');

const installScanPageGetRoutes = ({ router, ctx }) => {
  const {
    buildWriteContext, PURCHASE_RETURN_REALM, SCAN_PAGE,
    SUBMIT_TOAST, badNumberPage, candidatePaymentMethods, config, gateway, logInfo, logRendered,
    logWarn, lookupInputOf, notFoundPage, openIdOf, readMultiItemPending, realmScanPageConfig,
    renderFlowOf, renderScan, renderScanSkeleton, resolveRealm, respondFailure,
    scanTargetOf, sendHtml, sendHuman, sendPaymentStep, service, sessionIdOf, writeConfig, writeService,
  } = ctx;

  const ROUTE_PATTERNS = [config.route.recordPath].filter(Boolean);

  // 2026-11-27：资金页独立地址 /r/{id}/pay —— 刷新/回退都只认它，不再靠会话劫持其它 GET。
  //   只认「会话里确实在付款步」；否则 303 回销售货品页（不报错、不白屏）。
  router.get(config.route.payPath, async (req, res) => {
    const requestId = req.requestId;
    const recordId = decodeURIComponent(String(req.params.recordId || ''));
    const goodsUrl = `${req.baseUrl}/${encodeURIComponent(recordId)}?from=sales`;
    const session = await writeService?.sessions?.get?.(sessionIdOf(req)).catch(() => null);
    const sale = session?.sale || {};
    const lines = Array.isArray(sale.lines) ? sale.lines : [];
    const hasOrder = Boolean(String(sale.order_no || '').trim()) || Boolean(String(sale.master_record_id || '').trim());
    const submittedStatus = String(writeConfig?.session?.statuses?.submitted || 'submitted');
    const saleStatus = String(sale.status || '').trim();
    const hasSomethingToPay = lines.length > 0 || hasOrder || saleStatus !== submittedStatus;
    if (String(sale.paymentStep || '') !== 'pending' || !hasSomethingToPay) {
      return res.redirect(303, goodsUrl);
    }
    const cents = lines.reduce((sum, line) => sum + Math.round(Number(String(line?.amount ?? '').trim() || 0) * 100), 0);
    // /pay 是销售资金页：漏斗/渲染日志按 sales 记（地址本身不带 from）。
    req.query.from = 'sales';
    return sendPaymentStep(res, req, {
      paymentMethods: await candidatePaymentMethods(req),
      realm: 'sales',
      submitKey: writeService?.sessions?.submitKeyFor?.(sessionIdOf(req), session, 'sale') || '',
      count: lines.length,
      lines,
      totalAmountText: cents > 0 ? (cents / 100).toFixed(2).replace(/\.00$/, '') : '',
      // 2026-11-27：货品页确认的下架 ID 必须从会话带回资金页，否则付款提交时丢空。
      delistProductIds: Array.isArray(sale.delist_product_ids) ? sale.delist_product_ids : [],
      paymentRows: Array.isArray(sale.draft_payment?.paymentRows) ? sale.draft_payment.paymentRows : undefined,
      gift: sale.draft_payment?.gift || '',
      accessory: sale.draft_payment?.accessory || '',
      accessoryTotal: sale.draft_payment?.accessoryTotal || '',
      accessoryRows: Array.isArray(sale.draft_payment?.accessoryRows) ? sale.draft_payment.accessoryRows : [],
      renderedTrigger: 'pay_route',
    });
  });

  router.get(ROUTE_PATTERNS, async (req, res) => {
    const requestId = req.requestId;
    // ⚠️ 领域来自查询串（她给的参数名就是 `from`）；认不出来一律回落缺省，**不报错**。
    //    ⭐ 2026-10-11：六个领域（销售 · 补货 · 退货 · 验收 · 库存 · 货品）都是**真领域**，
    //      统一走 `resolveRealm` 就够；已退役的 `purchase` 认不出来 ⇒ 回落缺省（库存）。
    //    ⚠️ `explicit` 区分"**裸扫**（一个 `from` 都没有，标签二维码就是这样）"与
    //      "她**点**了某个领域 tab（链接一定带 `?from=`）" —— 下面验收接管只对**裸扫**生效，
    //      这样"她点销售/库存…就能离开验收"才真的成立（`?from=sales` 不能被接管）。
    const askedRaw = String(req.query?.from ?? '').trim();
    const explicitRealm = askedRaw !== '';
    let realm = resolveRealm(askedRaw);
    // ⭐ task-58：**这一页的领域是怎么来的**（只为那条 `scan.page.rendered` 日志，不参与任何判定 ✗）：
    //   `explicit` —— URL 上带了 `?from=`（工作台各领域入口 / 303 回跳）
    //   `default`  —— 裸扫（不带 `?from=`）⇒ 缺省领域（库存）
    //   （`remembered` 已于 2026-10-18 退场：不再按"上次用过的领域"记忆）
    let realmSource = explicitRealm ? 'explicit' : 'default';
    // 打开销售草稿：把快照灌回本页会话；资金页草稿保留 paymentStep 让她回到资金页。
    const draftId = String(req.query?.draft || '').trim();
    let draftOpened = false;
    if (draftId && realm === 'sales' && writeService?.sessions) {
      try {
        const { getSalesDraftService } = require('../../services/salesDraftRuntime');
        const draft = await getSalesDraftService().get({ openId: openIdOf(req), draftId });
        if (draft && Array.isArray(draft.lines) && draft.lines.length) {
          const session = await writeService.sessions.ensure(sessionIdOf(req));
          const draftLineAmounts = Array.isArray(draft.payment?.lineAmounts) ? draft.payment.lineAmounts : [];
          const draftLines = draft.lines.map((line, index) => (
            draftLineAmounts[index] === undefined ? line : { ...line, amount: draftLineAmounts[index] }
          ));
          await writeService.sessions.store.update(session.session_id, (current) => ({
            sale: {
              ...(current?.sale || {}),
              lines: draftLines,
              status: 'draft',
              paymentStep: draft.step === 'payment' ? 'pending' : undefined,
              draft_payment: draft.step === 'payment' ? (draft.payment || {}) : undefined,
              draft_form: draft.currentForm || null,
              draft_id: draftId,
            },
          }));
          draftOpened = true;
          // 2026-11-27：付款步草稿直接去独立资金页（刷新也稳）；货品步草稿照旧留在货品页。
          if (draft.step === 'payment') {
            return res.redirect(303, `${req.baseUrl}/${encodeURIComponent(lookupInputOf(req).recordId)}/pay`);
          }
        }
      } catch (error) {
        logWarn('scan.sales_draft.open_failed', { request_id: requestId, draft_id: draftId, error: String(error?.message || error).slice(0, 200) });
      }
    }

    // ⭐ 分阶段耗时（出参）：失败 / 找不到时同样能看出卡在哪一步。
    // ⭐⭐ 2026-10-13（她：加载到中间一直白屏）：**骨架屏开关**（默认关 ⇒ 这一页与改动前逐字相同）。
    //   打开时：**先回骨架**（不读任何表）⇒ 她立刻有东西看；数据由骨架里那**同一段脚本**
    //   再 `fetch('?data=1')` 拿回来 —— ⚠️ `data=1` 一路落到下面**原有的整页渲染**（同一个
    //   `service.lookup` ✓ 不新增取数路径 ✓），所以两条路径的数据必然一致 ✓。
    //   ⚠️ 只覆盖**编号页/记录 ID 页**这一条；`GET /`（新首页）与所有写入口一个字不动 ✓
    // ⭐ 2026-10-14：骨架**只服务"首次进入"**（不带 `?from=`）——
    //   她「六格没问题、不要改动」+「中间态数据加载中」✗ ⇒ 点六格（带 `?from=`）**直接出整页** ✓
    //   ⛔ 2026-11-26（她：「不需要这个开关」）：骨架**固定开启**，不再读 `SCAN_PAGE_SKELETON_ENABLED`。
    const skeletonFirstEntryOnly = config.skeleton?.firstEntryOnly === true;
    const hasRealmQuery = String(req.query?.from || '') !== '';
    if (String(req.query?.data || '') !== '1'
      && !(skeletonFirstEntryOnly && hasRealmQuery)
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      logInfo(SCAN_PAGE.events?.skeletonServed || 'scan.page.skeleton', { request_id: requestId });
      // ⭐ task-58：骨架屏也是一个落点（她那一发 `?data=1` 才是真正的货品页）——
      //   两条都留痕，才分得出"这一发只是骨架"与"这一发已经出货品页" ✓
      logRendered(req, {
        page: 'skeleton',
        trigger: 'skeleton_first_entry',
        number: String(lookupInputOf(req).recordId || ''),
      });
      return sendHtml(res, 200, renderScanSkeleton(lookupInputOf(req), config));
    }
    // 2026-11-27：支付中接管整块删除（资金页只走 /r/{id}/pay）。
    //   仅保留「重扫销售建单入口 ⇒ 清未完成支付」，且只认 sales flow（售后换款式不清）。
    if (String(req.query?.data || '') !== '1'
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      const pendingSession = await writeService?.sessions?.get?.(sessionIdOf(req)).catch(() => null);
      const pendingMark = pendingSession?.sale?.paymentStep || pendingSession?.paymentStep;
      const { flow: scanFlowForReset } = renderFlowOf(req.query);
      const explicitSalesScan = String(req.query?.from || '') === 'sales'
        && scanFlowForReset.id === 'sales';
      // 打开草稿是“回到她保存前那一页”，不是“重扫销售”；不能清掉草稿刚写入的 paymentStep。
      if (pendingMark === 'pending' && explicitSalesScan && !draftOpened) {
        const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);
        let reset = false;
        try {
          // ⚠️ `undefined` = "这个键不在"（`services/scanSessionService.js` 默认 `sale` 的形状 ✓
          //    既有表示、**不新造状态值** ✗）—— 与下面那条残标记清理**同一种清法** ✓。
          await Promise.resolve(writeService.saveDraftLines?.(
            sessionIdOf(req), { paymentStep: undefined, submitPending: undefined },
          ));
          reset = true;
        } catch (error) {
          // 清失败**不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出整页 ✓
          logWarn(config.events?.paymentStepResetFailed || 'scan.payment_step.reset_failed', {
            request_id: requestId, error: error.message,
          });
        }
        // **不静默**：真机排查时这一条说明"那条未完成是**按她选的 ②** 清掉的"，并如实带旧状态 ✓
        logInfo(config.events?.paymentStepResetOnScan || 'scan.payment_step.reset_on_scan', {
          request_id: requestId,
          open_id: openIdOf(req),
          raw: String(pendingMark).slice(0, 32),
          lines: Array.isArray(pendingSession?.sale?.lines) ? pendingSession.sale.lines.length : 0,
          has_order: Boolean(String(pendingSession?.sale?.order_no || '').trim())
            || Boolean(String(pendingSession?.sale?.master_record_id || '').trim()),
          sale_status: String(pendingSession?.sale?.status || '').trim(),
          had_submit_pending: hadSubmitPending,
          reset,
        });
        // 2026-11-27：只清标记；不再有"支付中接管"，这一发正常渲染货品页。
      }
    }
    const timing = {};
    // ⭐ 2026-10-13：`session_ms` = **从进这个处理函数到真正开始取数**这一段（认证 / 读会话 /
    //    路由开销）。实测它正是"total 减去各分段之后那 1.0~2.6 秒"的主要来源 ✗ ——
    //    现在把它也归到一段里，`stages_gap_ms` 才说明得了问题。
    const handlerStartedAt = Date.now();
    try {
      // ⚠️ Express 已经把路由参数解码过一次（`%7C` → `|`，未编码的中文也照收）；
      //    service 里再解一次是为了容忍双重编码，并且对孤立 `%` 的输入不抛。
      timing.session_ms = Math.max(0, Date.now() - handlerStartedAt);
      const view = await service.lookup({ ...lookupInputOf(req), requestId, timing });
      // ⭐⭐ 2026-10-14 她拍板：「把采购明细给删除了，把特殊码给去掉」⇒ 这里原来那次
      //   `purchaseSizeReader.listSizes()`（**1.7 秒**）**整块删除** ✓；尺码显示只按**实时库存**
      //   （`view.rows` = 内存快照 ✓）：库存里有 ⇒ 显示 ✓ 没有 ⇒ 不显示、不计缺码 ✓
      if (!view.found) {
        if (view.reason === 'empty') {
          logWarn(config.events.badNumber, { request_id: requestId, reason: 'empty_number' });
          service.logTiming?.(timing, { requestId, found: false });
          // ⭐ task-58：**没渲染出货品页**这件事也要留痕（否则"扫了但一条 rendered 都没有"）
          logRendered(req, {
            page: 'bad_number',
            trigger: 'lookup_bad_number',
            number: String(view.number || lookupInputOf(req).recordId || ''),
          });
          return badNumberPage(res, 400, requestId);
        }
        if (view.reason === 'delisted') {
          service.logTiming?.(timing, { requestId, found: false });
          logRendered(req, {
            page: 'delisted',
            trigger: 'lookup_delisted',
            number: String(view.number || lookupInputOf(req).recordId || ''),
          });
          return sendHuman(res, 409, {
            title: SCAN_DELISTED.title,
            body: SCAN_DELISTED.body,
            requestId,
          });
        }
        service.logTiming?.(timing, { requestId, found: false });
        // ⭐ `/r/{recordId}` 那条路读不到记录（记录被删 / 跨 Base）⇒ **同一条人话出口**，不是 500。
        logRendered(req, {
          page: 'not_found',
          trigger: 'lookup_not_found',
          number: String(view.number || lookupInputOf(req).recordId || ''),
        });
        return notFoundPage(res, requestId, {
          number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
        });
      }
      // ⭐⭐ 2026-10-18 修正（业务负责人：「全局和领域内的扫一扫逻辑不一样」）：
      //   五处扫一扫登记表（config/scanEntries.js）已经把两种入口分开：
      //     · 领域条【扫一扫】= standalone / AppLink
      //     · 领域内【再加一单】= JSAPI，扫完回跳 URL **显式带 `?from=<领域>&scan=1`**
      //   ⇒ 裸扫（无 `from=`）就是**全局入口**，固定落**缺省领域（库存，DEFAULT_REALM）**，
      //     不能再按 `last_realm` 记忆回补货 —— 那样全局入口会被上一笔补货"带偏"。
      //   ⚠️ 领域内回跳仍由 `?from=` 显式表达（不改）；`realmSource` 保持 default。
      // ⛔ 2026-11-26（业务负责人选 B）：「扫完自动清上一单草稿」已整块退场
      //   （清草稿函数与 keepDraft 配置一起删除）——这里不再有清草稿的调用。
      const write = await buildWriteContext(req, view, realm);
      // ⭐ 2026-10-29：扫码「流程」（配置驱动；换款式等差异都进配置，路由只接薄模块）
      const { flow: scanFlow, flowContext } = renderFlowOf(req.query);
      // ⚠️ 验收模式那一块**只用到文案 / 字段名 / 动作名**（它们都在配置里）——
      //    所以即使扫码写入口整个关着（`write` 为 null），验收模式照旧可用：
      //    这里给它一个最小的上下文（不构造销售 / 补货那两条链的任何东西）。
      const writeForRender = write;  // ⭐ 2026-10-14 晚：验收模式的"最小上下文"随验收退场 ✓
      const renderStartedAt = Date.now();
      // ⭐⭐ 2026-10-16（task-59 · **加/删货那一半**）：把草稿里**已经加进来的那几个货品**
      //   喂给渲染层（`view.multi_items`）—— 渲染层据此渲「已加货品」列表 **＋** 把它并进
      //   那个 hidden 字段（`[首件, ...已加]`）⇒ 她**点一下"加"、前面加的不丢** ✓。
      //   🔴 **只在采购那两块**（补货 / 退货）读 —— 别的领域一次都不碰这段（她那句"一次扫码 0~1 次飞书"的同一条口径 ✓）。
      //   🔴 **取不到 / 没有 ⇒ 就是今天的空态**（`view.multi_items` 一个字都不加 ⇒ 页面逐字不变 ✓）。
      //   ⚠️ **绝不含当前这一件**：当前这件是表单里那个**首件** ✓（含了 ⇒ 提交时用它那份旧 `entries`
      //     覆盖她刚填的 = **静默丢值** ✗）。
      //   ⚠️ 位置在**渲染之前**（`readMultiItemPending` 是工厂里上面的 `const` ⇒ 这里已初始化 ✓）。
      const multiItemChain = realm === 'replenish' ? 'replenish'
        : (realm === PURCHASE_RETURN_REALM ? 'return' : '');
      if (multiItemChain && writeService?.sessions) {
        const pending = await readMultiItemPending(sessionIdOf(req), multiItemChain).catch(() => ({ items: [] }));
        if (pending.items.length) view.multi_items = pending.items;
      }
      // ⭐ 2026-10-11：把 UA 交给渲染层 —— 它只用来决定本单条上【继续扫下一个】
      //    是"飞书客户端内的扫一扫 AppLink"还是那句如实的人话（`canScanNextWithFeishu`）。
      // ⭐⭐ 2026-10-16（task-61 · ① 日志）：`renderLogs` 是渲染层**只读登记**用的（见下）。
      const renderLogs = [];
      // 2026-11-27：库存裸扫页的成本只给有权限的角色；在共享 cache 之外按请求补，店员响应里不会有值。
      let viewForRender = view;
      if (view.found && realm === 'inventory' && view.product_record_id) {
        try {
          const actor = req.workbenchActor
            || (gateway ? await resolveActor({ gateway, openId: openIdOf(req) }) : null);
          if (actor && can(actor.role, config.inventoryCost.permission)) {
            const costText = await costTextOf({ gateway, productRecordId: view.product_record_id });
            if (costText) viewForRender = { ...view, cost_text: costText };
          }
        } catch (error) {
          logWarn('scan.inventory.cost.read_failed', { request_id: requestId, error: String(error?.message || error).slice(0, 200) });
        }
      }
      const html = renderScan(viewForRender, config, writeForRender, realm, {
        userAgent: req.headers['user-agent'],
        // ⭐⭐ 2026-10-13：提交后回跳带过来的单号 ⇒ 顶部那条"上一单已提交"的指引（没有就不显示 ✓）
        justSubmittedOrderNo: String(req.query?.[SUBMIT_TOAST.noticeKey || 'done'] || '').slice(0, 40),
        // ⭐ 这一页挂在哪个前缀上（`/s` 或 `/r`）—— 自助块里的批次链接/手输表单必须**留在同一前缀**。
        basePath: req.baseUrl,
        // ⭐⭐ 2026-10-16（task-61 · 领域内扫一扫）：**只有"加货刚成功、303 回来这一发"才给**
        //   （`?scan=1` ✓）—— 其它任何时候都是 `null` ⇒ 页面上一个字都不多（`AC-ML5` ✓）。
        realmScan: realmScanPageConfig(req, realm),
        // ⭐ 2026-10-29：流程配置（换款式：不加一双 / 不显示金额 / 提交文案 / 上下文隐藏字段）
        flow: scanFlow,
        flowContext,
        // ⭐⭐ 2026-10-16（task-61 · ① 日志）：渲染层把"**本单已加的货品**"那一笔**只读**登记在这里
        //   （渲染层是纯函数 ⇒ 它自己不打日志 ✗；**由本路由在渲染之后统一打** ✓ —— 与既有
        //   `logRendered` 同一处，且**失败也绝不会影响她的页面** ✗）。
        logs: renderLogs,
      });
      // ⭐⭐ 2026-10-16（task-61 · ① 第二条日志）：**渲染"本单已加的货品"列表**那一刻 ——
      //   与加货那条（`…add`）一比就能答她那句「**扫了 B 但没看到 A**」：
      //   `add` 说有（`added_count` ≥ 1）而 `render` 说没有（`item_nos` 里没有 A）⇒ 是**读出来那半边** ✗✓
      //   🔴 纯 additive：**没有那一笔就一条都不打**（今天她看不到这个列表时，日志与今天逐字一致 ✓）。
      for (const entry of renderLogs) {
        const log = entry.fields || {};
        logInfo(entry.event || 'scan.multi_item.render', {
          request_id: requestId,
          open_id: openIdOf(req),
          [log.chainKey || 'chain']: String(entry.chain || ''),
          [log.addedCountKey || 'added_count']: Number(entry.count) || 0,
          [log.itemNosKey || 'item_nos']: (Array.isArray(entry.itemNos) ? entry.itemNos : []).slice(0, 50),
          [log.modeKey || 'mode']: String(entry.chain || ''),
        });
      }
      timing.render_ms = Math.max(0, Date.now() - renderStartedAt);
      // ⭐⭐ task-58：**这就是"她最后看到货品页"那条正证据** —— 与资金页那条（`page:'pay'`）
      //   在日志里一眼分得开 ✓（改前两条都只打 `scan.page.viewed`，长得一模一样 ✗）
      logRendered(req, {
        page: 'goods',
        // `realm:<领域>:<explicit|default>` —— 说得出"这一页是哪个领域、怎么来的"
        trigger: `realm:${realm}:${realmSource}`,
        number: String(view.number || lookupInputOf(req).recordId || ''),
      });
      // `total_ms` = 取数 + 渲染（整条链路的墙钟）—— 她要的是"这一页到底花了多久"。
      timing.total_ms = (Number(timing.total_ms) || 0) + timing.render_ms;
      service.logTiming?.(timing, { requestId, found: true });
      return sendHtml(res, 200, html);
    } catch (error) {
      // ⭐ task-58：**没渲染出页面**也要留痕（不然"扫了、日志里一条 rendered 都没有"）
      logRendered(req, {
        page: 'failed',
        trigger: 'render_failed',
        number: String(lookupInputOf(req).recordId || ''),
      });
      return respondFailure(res, error, requestId, timing);
    }
  });

  /**
   * **写入口**：页面上那两个表单都 POST 到同一个地址，靠 `action` 字段分派。
   *
   * 四个动作：
   *   · `add_line`     —— 把这一双加进"本单"（**只写本地会话**，业务表一字不写）；
   *   · `submit_order` —— 提交整单（**唯一的销售写库时机**）；
   *   · `clear_draft`  —— 清空本单；
   *   · `replenish`    —— 按勾选的尺码 + 数量生成采购申请。
   *
   * ⚠️ **成功的"加一双 / 清空"走 303 回原页**（Post-Redirect-Get）：
   *    刷新不会重复提交，页面上也会带上"本单现在几双"。**提交订单**直接渲染结果页。
   * ⚠️ 失败一律**渲染一张人话页**（不静默、不只写日志）。
   */

};

module.exports = { installScanPageGetRoutes };
