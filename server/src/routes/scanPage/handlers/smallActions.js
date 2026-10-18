'use strict';

/**
 * 扫码路由深拆 P3a：剩余小动作分支（打印/加货/配品/清空）——从 `routes/scanPage/index.js` 搬出，**只搬不改**。
 */

async function handlePrintLabel(ctx) {
  const { req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService, sendHuman, notFoundPage, isRecordBase, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, resolveLabelPrintQueue, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM } = ctx;
      let number = decodeURIComponent(String(req.params.number || '')).trim();
      // ⭐⭐ 2026-10-12：`/r/{recordId}` 底下 URL 里是**记录 ID**，而打印队列认的是**编号**
      //    ⇒ 先把它解出来（读不到就给"这一款现在打不了"的人话，不是 500）。
      if (isRecordBase(req)) {
        const printView = await service.lookup({ ...lookupInputOf(req), requestId }).catch(() => null);
        number = String(printView?.number || '').trim();
        if (!number) {
          logWarn('scan.label_print.number_unresolved', {
            request_id: requestId, product_record_id: scanTargetOf(req).value,
          });
          return notFoundPage(res, requestId, { target: scanTargetOf(req), realm });
        }
      }
      // ⭐ 连点去重 / 二次确认：
      //   · `submit_key`（表单里带回来的幂等键）—— 同一个 key 只会有一个任务；
      //   · `again=1`（横幅上那颗【再打一张】）—— **明确表达"我知道刚打过，还要再打"** ⇒ 绕过两道去重。
      const submitKey = String(body[LABEL_PRINT_QUEUE.submitKeyField] || '').trim();
      const again = String(body[LABEL_PRINT_QUEUE.againField] || '').trim() === '1';
      try {
        const queue = resolveLabelPrintQueue();
        const result = await queue.enqueueSingle({ number, actor: openId, source: 'scan', submitKey, again });
        logInfo('scan.label_print.enqueued', {
          request_id: requestId,
          number,
          job_id: result.job_id,
          total_labels: result.total_labels,
          again: again || undefined,
          // ⭐ 去重命中（她连点了 / 换了个页面又来点）—— 排障时一眼能看出来。
          reused: result.reused || undefined,
          reused_reason: result.reused_reason || undefined,
        });
        // Post-Redirect-Get：刷新不会重复提交；页面上那句**显眼横幅**由 GET 重新渲染。
        // `printed=1` = 这次真的新建了任务；`dup=1` = 命中去重（没有重复提交）。
        const flag = result.reused ? 'dup=1' : 'printed=1';
        // ⭐ `/r` 底下回跳要带**记录 ID**（不是编号）。
        return res.redirect(303, `${postActionFor(backTargetFor(req, number), realm)}&${flag}&job=${encodeURIComponent(result.job_id)}`);
      } catch (error) {
        // 她这一款没库存 / 条件是打不出来 ⇒ 400（**原因原样给她**，她要能看懂为什么）；
        // 系统这一侧坏了（产物画不出来 / 队列写不进盘）⇒ 502/503，**只给一句人话**，
        // 内部细节只进日志（与工作台其它接口同一条口径：5xx 不回显内部细节）。
        const status = error?.statusCode === 400 ? 400 : (error?.statusCode === 503 ? 503 : 502);
        logError('scan.label_print.failed', {
          request_id: requestId, number, status, error: error.message,
        });
        const texts = LABEL_PRINT_QUEUE.texts;
        return sendHuman(res, status, {
          title: status === 400 ? texts.enqueueFailedTitle : texts.unavailableTitle,
          body: status === 400 ? error.message : texts.unavailable,
          number,
          requestId,
        });
      }
}

async function handleAddLine(ctx) {
  const { req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService, addBackPath, notFoundPage, respondWriteFailure, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM } = ctx;
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const result = await writeService.addSaleLine({
          openId,
          requestId,
          productRecordId: view.product_record_id,
          number: view.number,
          itemNo: view.item_no,
          color: view.color,
          size: body[fields.size],
          amount: body[fields.amount],
          gift: body[fields.gift],
          // ⭐ 2026-10-09（**本文件唯一的一处新增**）：「选中的这一双是现货还是预订」——
          //    判据与页面上那两个分组**同一份**（所选尺码在「样品 + 门盒」有没有货，
          //    纯函数在 `views/scanPageRealm.js`）。交易类型**编码**不在这里写死：
          //    写服务按既有判据 `salesTradeTypeForStock` 推出来（现货 / 预订）。
          inStock: sellableSizeTexts(view).has(String(body[fields.size] ?? '').trim()),
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        logInfo(writeConfig.events.lineAdded, {
          request_id: requestId, number: view.number, count: result.count,
        });
        // ⭐⭐ 2026-10-16 21:1x（本卡 ·「**销售也弹扫码框**」）：
        //   **销售这一条**「加货成功之后」的回跳，与补货 / 退货**同一个动作** ⇒ 也要**接着扫**。
        //   依据 = 业务负责人当天 21:1x 弹窗拍板「**要，销售也弹扫码框**」✓
        //     ＋ 14:32 逐字「**补货 / 销售 / 退货**里那颗『＋ 再加一个货品』**实际上也是扫一扫**」✓。
        //   🔴 **复用同一处** `addBackPath`（不另写一套 ✗）；页路径那一段**逐字没动** ✗
        //     （`?added=1` 那个既有反馈照旧 ✓）——只在它后面**多一个触发参数**：
        //     `?added=1&scan=1` ⇒ 回来的那一页去调飞书扫一扫、扫到的那件带 `?from=sales`
        //     落回**销售本单**（既有 `session.sale.lines` ✓ 落点不新造 ✗）。
        //   🔴 开关关着 / 领域没配链 ⇒ `addBackPath` **原样返回** ⇒ Location 与今天**逐字节相同** ✓。
        const addedBackPage = `${postActionFor(backTargetFor(req, view.number), realm)}${realm === DEFAULT_REALM ? '?' : '&'}added=1`;
        return res.redirect(303, addBackPath(addedBackPage, realm));
}

async function handleAddAccessory(ctx) {
  const { req, res, requestId, body, fields, realm, action, openId, service, writeService, notFoundPage, respondWriteFailure, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM } = ctx;
        const view = await service.lookup({ ...lookupInputOf(req), requestId });
        if (!view.found) {
          return notFoundPage(res, requestId, {
            number: view.number, fallback: view.fallback, realm, target: scanTargetOf(req),
          });
        }
        const result = await writeService.addSaleLine({
          openId,
          requestId,
          // ⚠️ `kind` **由路由按动作给**，不取表单里的值（手改表单也换不了可售品类型）。
          kind: 'accessory',
          accessoryRecordId: body[fields.accessory],
          amount: body[fields.amount],
          gift: body[fields.gift],
        });
        if (!result.ok) return respondWriteFailure(res, result, requestId);
        // 与「加入本单」同一条回跳（Post-Redirect-Get）：刷新不会重复提交、本单看得见。
        return res.redirect(303, `${postActionFor(backTargetFor(req, view.number), realm)}${realm === DEFAULT_REALM ? '?' : '&'}added=1`);
}

async function handleClearDraft(ctx) {
  const { req, res, requestId, body, fields, realm, action, openId, writeService, backTargetFor, postActionFor, logInfo, logWarn, logError, LABEL_PRINT_QUEUE, sellableSizeTexts, DEFAULT_REALM } = ctx;
        await writeService.clearDraft({ openId, requestId });
        return res.redirect(303, postActionFor(
          backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
        ));
}

module.exports = { handlePrintLabel, handleAddLine, handleAddAccessory, handleClearDraft };
