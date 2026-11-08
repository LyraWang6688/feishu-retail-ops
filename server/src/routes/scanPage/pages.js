'use strict';

/** 扫码页 GET 页面处理（P4-2b 从 routes.js 搬出）。 */
const installScanPageGetRoutes = ({ router, ctx }) => {
  const {
    buildPrintContext, buildWriteContext, clearDraftForScanIfNeeded, PURCHASE_RETURN_REALM, SCAN_PAGE,
    SUBMIT_TOAST, backTargetFor, badNumberPage, candidatePaymentMethods, config, logInfo, logRendered,
    logWarn, lookupInputOf, notFoundPage, openIdOf, readMultiItemPending, realmScanPageConfig,
    realmScanTriggered, renderFlowOf, renderScan, renderScanSkeleton, resolveRealm, respondFailure,
    scanTargetOf, sendHtml, sendPaymentStep, service, sessionIdOf, writeConfig, writeService,
  } = ctx;

  const ROUTE_PATTERNS = [config.route.recordPath].filter(Boolean);

  router.get(ROUTE_PATTERNS, async (req, res) => {
    const requestId = req.requestId;
    // ⚠️ 领域来自查询串（她给的参数名就是 `from`）；认不出来一律回落缺省，**不报错**。
    //    ⭐ 2026-10-11：六个领域（销售 · 补货 · 退货 · 验收 · 库存 · 货品）都是**真领域**，
    //      统一走 `resolveRealm` 就够；已退役的 `purchase` 认不出来 ⇒ 回落销售（既有口径）。
    //    ⚠️ `explicit` 区分"**裸扫**（一个 `from` 都没有，标签二维码就是这样）"与
    //      "她**点**了某个领域 tab（链接一定带 `?from=`）" —— 下面验收接管只对**裸扫**生效，
    //      这样"她点销售/库存…就能离开验收"才真的成立（`?from=sales` 不能被接管）。
    const askedRaw = String(req.query?.from ?? '').trim();
    const explicitRealm = askedRaw !== '';
    let realm = resolveRealm(askedRaw);
    // ⭐ task-58：**这一页的领域是怎么来的**（只为那条 `scan.page.rendered` 日志，不参与任何判定 ✗）：
    //   `explicit`   —— URL 上带了 `?from=`（她点的那个 tab）
    //   `remembered` —— 裸扫 + 她最近一次做过写操作的领域（下面那一支）
    //   `default`    —— 裸扫且从没记过 ⇒ 缺省（销售）
    let realmSource = explicitRealm ? 'explicit' : 'default';
    // ⭐ 分阶段耗时（出参）：失败 / 找不到时同样能看出卡在哪一步。
    // ⭐⭐ 2026-10-13（她：加载到中间一直白屏）：**骨架屏开关**（默认关 ⇒ 这一页与改动前逐字相同）。
    //   打开时：**先回骨架**（不读任何表）⇒ 她立刻有东西看；数据由骨架里那**同一段脚本**
    //   再 `fetch('?data=1')` 拿回来 —— ⚠️ `data=1` 一路落到下面**原有的整页渲染**（同一个
    //   `service.lookup` ✓ 不新增取数路径 ✓），所以两条路径的数据必然一致 ✓。
    //   ⚠️ 只覆盖**编号页/记录 ID 页**这一条；`GET /`（新首页）与所有写入口一个字不动 ✓
    // ⭐ 2026-10-14：骨架**只服务"首次进入"**（不带 `?from=`）——
    //   她「六格没问题、不要改动」+「中间态数据加载中」✗ ⇒ 点六格（带 `?from=`）**直接出整页** ✓
    //   判据在配置里（`config.skeleton.firstEntryOnly` ✓ 显式布尔 ✓ 不写 `||` 兜底 ✗）
    const skeletonFirstEntryOnly = config.skeleton?.firstEntryOnly === true;
    const hasRealmQuery = String(req.query?.from || '') !== '';
    if (config.skeleton?.enabled === true && String(req.query?.data || '') !== '1'
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
    // ⭐⭐ 2026-10-14（业务负责人：**点「提交这一单」只到资金页**）：她**刷新**这一页时，
    //   如果会话里记着"已经走到资金这一步"（`paymentStep === 'pending'`）⇒ ⭐ **仍给资金页** ✓
    //   （否则刷新会掉回普通录入页 ⇒ 她会以为"白填了"✗）。其它情况**一个字都不改** ✓走老逻辑。
    //   ⚠️ 只认会话标记（**不认任何查询串** ✗）⇒ 别人/别的情况下拿不到这一页 ✓
    if (String(req.query?.data || '') !== '1'
      && (lookupInputOf(req).number || lookupInputOf(req).recordId)) {
      const pendingSession = await writeService?.sessions?.get?.(sessionIdOf(req)).catch(() => null);
      // ⚠️ task-60：`const` → **`let`** —— 她选的 ② 要在下面把这条标记**清成"没有"**
      //    （`pendingMark = ''`）⇒ 那条既有接管**不再命中**（它的那一行**逐字未动** ✓）。
      let pendingMark = pendingSession?.sale?.paymentStep || pendingSession?.paymentStep;
      // 🔴 2026-10-14 晚（她真机：扫了码之后点「库存 / 补货 / 退货」**全都变成资金页**）：
      //   ⭐ 根因 = 上面这段"刷新仍给资金页"**没按领域限制** ✗ ⇒ 只要会话里还有 `pending`，
      //     她点**任何**领域都被资金页接管 ✗。
      //   ⇒ 修法（**只收紧、不改别的** ✓）：只在**销售**这一块才允许接管 ——
      //     · `from=sales`（她刷新销售页 ⇒ 仍给资金页 ✓ 不丢她刚填的 ✓）
      //     · 或**没带 `from`**（裸扫通常就是销售入口 ✓ 保持原有体验 ✓）
      //     · **其它领域**（库存/补货/退货/…）⇒ ⭐ **一律不接管**（照旧给那一块 ✓）
      const salesContext = renderFlowOf(req.query).flow.id === 'sales'
        && (String(req.query?.from || '') === '' || String(req.query?.from) === 'sales');
      /**
       * ⭐⭐ 2026-10-16（task-60 · 她真机 05:34「扫货品码却出现资金页」＋ **她当日亲口选的方案 ②**）：
       *   我给的选项（逐字）：「① 接管前先核对"是不是这个货品" 还是 ② 重扫同一个货品就从头开始
       *   （清掉那条未完成）？」⇒ 她答（逐字）：**「② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）」**。
       *
       * ⇒ **扫到货品、点「销售」那一发**（= 显式 `?from=sales`；realm tab 的链接就是它，
       *   `views/scanPageRenderer.js` 的 `href="?from=<领域>"` ✓）**先把那条"未完成"的标记清掉**
       *   ⇒ 这一发**从货品页开始** ✓（不再被"上一单的资金页"顶掉 ✗ —— 那正是她的截图）。
       *
       * 🔴 **清的范围（她逐字"清掉那条未完成"，别清过头 ✗）**：
       *   · 只清 **`paymentStep`** ＋ 与它同笔的 **`submitPending`**（那是她 2026-10-15 定下的
       *     "点按钮那一刻要写的那一双"pay 载荷 ⇒ `paymentStep` 一清它就没有读点，同笔清是纯卫生 ✓）；
       *   · **`lines` / `order_no` / `master_record_id` / `status` / `completed` / `seq` 一个字都不碰** ✗
       *     ⇒ 会话里那笔"已建单 / 已提交"的事实**原样留着**（她还能在工作台查到那一单 ✓）；
       *   · **只写她这条会话**（`openIdOf(req)` 来自**签名 cookie** ⇒ 别人的会话碰不到 ✗）；
       *   · **零业务表写入**：这一段只调 `sessions.saveDraftLines`（本地会话）—— 飞书一个字节都不写 ✓。
       *
       * ⚠️ **为什么只认显式 `?from=sales`、**裸扫不清** ✗**（这是本刀最容易做错的一处）：
       *   裸扫那条路挂着她 2026-10-14 定的**「资金页刷新不丢」**（"点提交 ⇒ 到资金页 ⇒ 刷新仍在资金页"）
       *   —— 判据是 `test/scanSalePayFront.test.js` 的 AC-PF4 ＋ `test/scanPaymentStepStale.test.js` 的
       *   AC-SM2/SM3/SM7/SM8（那几条**一条都没改** ✓）。在裸扫上清 ⇒ 把她**刚填完、正停在资金页**
       *   的那一单打回录入页 ✗ = **清过头**。
       *   ⭐ **线上（骨架屏开 + `firstEntryOnly`）裸扫先回骨架、`?data=1` 又绕过接管**
       *     ⇒ 能落到资金页的入口**只有她点「销售」这一发** ✓ ⇒ **就在这一发清** = 正好治她那一下 ✓
       *     （上一任的只读诊断 §2.3/§3.1 已证；骨架屏**关**时裸扫也会到资金页，那也照旧不动 ✓）。
       *   ⚠️ 与"**残标记自清理**"（下面那一段，**逐字未动** ✓）**各司其职**：
       *     那条治"有 pending 但**没东西要付**"（2026-10-15 的 #598/#601）；这条治"**她主动重扫**"。
       */
      const explicitSalesScan = String(req.query?.from || '') === 'sales';
      if (pendingMark === 'pending' && explicitSalesScan) {
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
        // ⚠️ **这一句才是"别再接管"的开关**：把本地那份标记置空 ⇒ 下面那条
        //    "刷新仍给资金页"的接管（`pendingMark === 'pending' && salesContext`，**逐字未动** ✓）
        //    **不再命中** ⇒ 这一发继续走**正常整页渲染** ⇒ `page:'goods'` ✓（正是她选的 ②）。
        pendingMark = '';
      }
      if (pendingMark === 'pending' && salesContext) {
        const pendingView = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
        if (pendingView?.found) {
          const pendingLines = Array.isArray(pendingSession?.sale?.lines) ? pendingSession.sale.lines : [];
          // ⭐⭐ 2026-10-15 晚（task-21 · 她真机 20:22：「我扫码一双鞋点击销售，出来的是**资金页面**」）：
          //   🔴 上面那半（10-14 晚）只把接管**限到销售上下文**，**没看"有没有东西要付"** ✗ ——
          //      她那次的会话是 `paymentStep:'pending'` + 草稿 **0 行** + 没有已建单号
          //      ＋ **`sale.status:'submitted'`**（**那一单早就交出去了**）⇒ 照样被顶到
          //      「整单付款（可填可不填）」，而且**之后每次扫码都这样** ✗✗。
          //   ⚠️ **光看"0 行"是不够的**（我第一版就是"0 行 + 没单号 ⇒ 残标记"，被全量挡下 ✓）：
          //      **刚点过「提交这一单」、正停在资金页**时，草稿**本来就是 0 行** —— 扫码那一双是走
          //      `submitPending`（提交那一步存下来的尺码/金额/收款）在**点按钮时**才落单的
          //      （见上面提交分支的 `lines: pendingDraftLines` ＋ 下面 pay 分支用 `pendingInfo`）✓
          //      ⇒ 拿"0 行"判残标记会把**正常**的资金页清掉 ⇒ 她点按钮就建不了单 ✗
          //        （`test/scanSalePayFront.test.js` 的 AC-PF1/PF2/PF4 正是这么挡住我的第一版 ✓）。
          //   ⇒ 判据收成她**真机那个状态**才有的特征：0 行 + 没单号 + **这一单已经 `submitted`**
          //      （`completeSale` 把 `status` 落成 submitted，它清的是 `lines`/`order_no`，
          //       **没清** `paymentStep` ⇒ 标记留成了残的 —— 正是她那次的形状 ✓）。
          const hasOrder = Boolean(String(pendingSession?.sale?.order_no || '').trim())
            || Boolean(String(pendingSession?.sale?.master_record_id || '').trim());
          const saleStatus = String(pendingSession?.sale?.status || '').trim();
          // ⚠️ 2026-10-15 晚（task-22 顺带修正）：改前逐字 `writeConfig?.statuses?.submitted || 'submitted'`
          //    —— `writeConfig.statuses` **不存在**（真路径是 `writeConfig.session.statuses`）⇒ 一直靠
          //    **字面量兜底**在跑（值恰好相同 ⇒ 行为没变 ✓，但那是"配置先行"没做到 ✗）。
          //    改后逐字：读**真路径**，兜底只在"配置竟然缺了"时保命（不改变任何现有行为 ✓）。
          const submittedStatus = String(writeConfig?.session?.statuses?.submitted || 'submitted');
          // 「有东西要付」= 草稿有行 ∨ **已经建过单**（order_no / master_record_id）∨
          //                **这一单还没交出去**（status 不是 submitted ⇒ 她刚点过提交、正停在资金页 ✓）
          if (pendingLines.length > 0 || hasOrder || saleStatus !== submittedStatus) {
            return sendPaymentStep(res, req, {
              // ⭐ 2026-10-16 A2a ③：候选收款方式 = 读表那一份（读不到 ⇒ 退回配置 + warn ✓ 见工厂里那份注释）
              paymentMethods: await candidatePaymentMethods(req),
              realm,
              submitKey: writeService?.sessions?.submitKeyFor?.(sessionIdOf(req), pendingSession, 'sale') || '',
              count: pendingLines.length,
              // ⭐⭐ task-58：**哪一条判据把她顶到了资金页** —— 就是上面那个三选一。
              //   （她真机再出现这个现象时，grep `scan.page.rendered` 一眼看出是哪种形状 ✓）
              renderedTrigger: pendingLines.length > 0
                ? 'pending_mark:lines'
                : (hasOrder ? 'pending_mark:order' : 'pending_mark:status_not_submitted'),
            });
          }
          // 🔴 **残标记**（0 行 + 没单号 + 已 `submitted`）⇒ **不给资金页**，并把标记清成"**没走到资金这一步**"
          //   的**既有表示** = 这个键**不在**（`services/scanSessionService.js` 的默认 `sale` 里就**没有**
          //   `paymentStep` ✓）⇒ 清成 `undefined`：`saveSaleProgress` 是 `{...当前 sale, ...patch}`、
          //   store 是 `JSON.stringify`（`jsonTaskStore`）⇒ 这个键就**没了** ✓。
          //   ⚠️ **不是** `'created'`（那是"**这一单已经建过**"的既有含义，写上去就是撒谎 ✗）；
          //   ⚠️ **不是**空串（那是**另造一个值**，注释里也点名过不许 ✗）；
          //   ⚠️ 清标记**失败不许破她的页面**（这是 GET 渲染路径）⇒ 只 warn，照旧出正常页 ✓。
          //   ⭐⭐ 2026-10-15 晚（task-22）：**`submitPending` 同一笔清掉**（纯卫生 ✓）——
          //      `paymentStep` 一清，它在代码里就**再没有读点**（pay / skip 两处都在
          //      `paymentStep === 'pending'` 的门内 ⇒ 这颗残留 payload 只会误导下次真机排查；
          //      Lead 手工清她会话时也把它一起清了 ✓）。
          //      🔴 **顺序不能反**：必须在"提交那一步把 `status` 落回 `draft`"（见提交分支）**之后**才敢这么清 ✗
          //         —— 否则第 2 单刚提交那一下也会命中这条残标记分支 ⇒ 把她**点按钮要写的那一双**抹掉 ⇒ 建不了单 ✗。
          const hadSubmitPending = Boolean(pendingSession?.sale?.submitPending);
          const clearing = writeService.saveDraftLines?.(
            sessionIdOf(req), { paymentStep: undefined, submitPending: undefined },
          );
          await Promise.resolve(clearing).catch((error) => {
            logWarn('scan.payment_step.stale_clear_failed', {
              request_id: requestId, error: error.message,
            });
          });
          // **不静默**：真机排查时这一条说明"那次残标记是被我们清掉的，不是她自己清掉的"。
          logWarn('scan.payment_step.stale_cleared', {
            request_id: requestId,
            open_id: openIdOf(req),
            raw: String(pendingMark).slice(0, 32),
            lines: pendingLines.length,
            has_order: hasOrder,
            sale_status: saleStatus,
            had_submit_pending: hadSubmitPending,
          });
        }
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
      //     · 领域条【扫一扫】= standalone / AppLink，**不带历史数据**（keepDraft=false）
      //     · 领域内【再加一单】= JSAPI，扫完回跳 URL **显式带 `?from=<领域>&scan=1`**
      //   ⇒ 裸扫（无 `from=`）就是**全局入口**，必须固定落缺省领域（销售），
      //     不能再按 `last_realm` 记忆回补货 —— 那样全局入口会被上一笔补货"带偏"。
      //   ⚠️ 领域内回跳仍由 `?from=` 显式表达（不改）；`realmSource` 保持 default。
      // ⭐ 2026-10-17（假配置接线）：扫完回来的这一发、且这一处登记 keepDraft=false ⇒ 先清旧草稿
      if (realmScanTriggered(req, realm)) await clearDraftForScanIfNeeded(sessionIdOf(req), realm);
      const write = await buildWriteContext(req, view, realm);
      // ⭐ 2026-10-29：扫码「流程」（配置驱动；换款式等差异都进配置，路由只接薄模块）
      const { flow: scanFlow, flowContext } = renderFlowOf(req.query);
      // ⚠️ 验收模式那一块**只用到文案 / 字段名 / 动作名**（它们都在配置里）——
      //    所以即使扫码写入口整个关着（`write` 为 null），验收模式照旧可用：
      //    这里给它一个最小的上下文（不构造销售 / 补货那两条链的任何东西）。
      const writeForRender = write;  // ⭐ 2026-10-14 晚：验收模式的"最小上下文"随验收退场 ✓
      const renderStartedAt = Date.now();
      // ⭐ 2026-10-11「货品」领域：把**打印队列的真实状态**带进渲染层（在线 / 未连接 +
      //    这一款最近一次任务）。⚠️ 只在这个领域取 —— 别的领域一次都不碰打印那条链路。
      //    `printed=1` = 刚提交完（303 回来的），页面上给一句"已提交打印"。
      const printContext = realm === 'product'
        ? await buildPrintContext(view.number, realm, {
          requestId,
          submitted: String(req.query?.printed || '') === '1',
          duplicated: String(req.query?.dup || '') === '1',
          jobId: String(req.query?.job || '').trim(),
          // `/r` 底下表单要 POST 回 `/r/{recordId}`；`/s` 底下与改前逐字相同。
          target: backTargetFor(req, view.number),
        })
        : null;
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
      const html = renderScan(view, config, writeForRender, realm, {
        userAgent: req.headers['user-agent'],
        // ⭐⭐ 2026-10-13：提交后回跳带过来的单号 ⇒ 顶部那条"上一单已提交"的指引（没有就不显示 ✓）
        justSubmittedOrderNo: String(req.query?.[SUBMIT_TOAST.noticeKey || 'done'] || '').slice(0, 40),
        // ⭐ 这一页挂在哪个前缀上（`/s` 或 `/r`）—— 自助块里的批次链接/手输表单必须**留在同一前缀**。
        basePath: req.baseUrl,
        print: printContext,
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
        // `realm:<领域>:<explicit|remembered|default>` —— 说得出"这一页是哪个领域、怎么来的"
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
