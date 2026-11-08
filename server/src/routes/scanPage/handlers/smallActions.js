'use strict';

/**
 * 扫码路由深拆 P3a：剩余小动作分支（加货 / 清空）——从 `routes/scanPage/index.js` 搬出，**只搬不改**。
 *
 * 🔴 2026-11-09（业务负责人：「隐藏的旧「标签」领域块，可以删除」）：
 *   扫码页「标签」领域整块删除 ⇒ 这里的【打印这一款】（`handlePrintLabel`）**物理删除**。
 */

async function handleAddLine(ctx) {
  const { req, res, requestId, body, fields, realm, action, openId, writeConfig, service, writeService, addBackPath, notFoundPage, respondWriteFailure, scanTargetOf, backTargetFor, lookupInputOf, postActionFor, logInfo, logWarn, logError, sellableSizeTexts, DEFAULT_REALM } = ctx;
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

async function handleClearDraft(ctx) {
  const { req, res, requestId, body, fields, realm, action, openId, writeService, backTargetFor, postActionFor, logInfo, logWarn, logError, sellableSizeTexts, DEFAULT_REALM } = ctx;
        await writeService.clearDraft({ openId, requestId });
        return res.redirect(303, postActionFor(
          backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm,
        ));
}

module.exports = { handleAddLine, handleClearDraft };
