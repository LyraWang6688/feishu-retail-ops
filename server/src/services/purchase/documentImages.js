'use strict';

/**
 * 采购单出图 / 发群 / 回填「单据」附件 —— 2026-10-18 从 `services/purchaseWebhookService.js`
 * **原样搬出**（文件大小门禁，见 task-6）。顺序（先发图、后写附件）、文件名口径、
 * 幂等判据（已有同名图 ⇒ 跳过、连上传都不做）、日志事件名**全部逐字保留**。
 *
 * ⚠️ mixin：方法里的 `this` = `PurchaseWebhookService` 实例（facade 保留同名薄委托方法）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ARRIVAL_BATCH_KINDS } = require('../../config/arrivalConversation');
const {
  supplierLabel, resolvePurchaseGroupNoticeConfig, renderPurchaseGroupNoticeText,
} = require('../../config/purchaseGroupNoticeText');
const { documentFileNameOf } = require('../supplierSplitService');
const { logError, logInfo, logWarn } = require('../../utils/logger');
const { purchaseCorrelation } = require('./correlation');

/** 「单据」里那张图的**缺省**文件名后缀（退货那条链会传自己的后缀 ✓ 值没变）。 */
const DEFAULT_DOCUMENT_FILE_SUFFIX = '采购单';

const documentImages = {
  /**
   * 采购申请写完之后：按供应商出图 → 发给报单人 → 写回「采购申请单」附件。
   *
   * ⚠️ 顺序是有意为之：**先发图，再写回附件**。
   * 她已经拿到图才能转发给供应商，附件只是留档；写回失败绝不能让她收不到图。
   * 因此附件写入的异常只记警告，绝不向上抛。
   *
   * 这个方法也绝不向上抛异常：调用它的时候采购事实已经落地，
   * 抛出去会让 process() 把任务判成 failed、把报单记录标成「解析失败」，
   * 她会以为这批货没报上，而实际上已经报上了。
   */
  async deliverSupplierImages(taskId, task, posting = {}, options = {}) {
    try {
      return await this.deliverSupplierImagesInner(taskId, task, posting, options);
    } catch (error) {
      // 兜底：调用方是"采购事实已经写完"的收尾流程，这里漏出去的异常会把任务判成 failed。
      logError('purchase.request.image.delivery_failed', { task_id: taskId, error: error.message });
      return { sent: [], failed: [{ supplier: '', error: error.message }], thread_root_message_id: '' };
    }
  },

  // options.title / options.fileNameSuffix：采购退货单与采购申请单共用这一整条
  // 「按供应商出图 → 发到群 → 写回附件」的流程，只有标题和文件名不同（口径就是"格式一样"）。
  async deliverSupplierImagesInner(taskId, task, posting = {}, options = {}) {
    const draft = task?.draft || {};
    const items = draft.items || [];
    if (!items.length) return { sent: [], failed: [], thread_root_message_id: '' };
    // 这一层已经知道的关联键：task_id ＋ 批次号（只进日志）。
    // ⚠️ 报单记录 id **刻意不给**：批次草稿里它是**多条**（report_record_ids），
    //    挑一条当代表就是编 —— 每条记录自己那几次写入会各自带自己的 id。
    const batchNo = posting.batch_no || draft.batch_no || '';
    const correlation = purchaseCorrelation({ taskId, batchNo });
    // ⚠️ 采购单**只发群**（业务负责人：「不用再看经办人了」）。
    // operator_open_id 仍然留着——它是「这条记录是谁报的」，用于到货异常告知、
    // 以及权限判断，不再决定采购单发到哪儿。
    const operatorOpenId = draft.operator_open_id;
    // 构造入参里的 sandboxChatId 是**整条链路共用的测试群**（出图与提示发同一个群）：
    // 没配它、也没在读环境变量时（生产），这里等价于原来的 resolvePurchaseGroupTarget(options)。
    const target = this.resolvePurchaseGroupTarget({
      ...options,
      sandboxChatId: options.sandboxChatId || this.sandboxChatId,
    });
    if (!target.chatId) {
      // **大声跳过**：不静默、不回落到私聊。这条日志就是排查入口——
      // 线上看到它 = 环境变量 PURCHASE_CHAT_ID 没配，采购单已经写成但图没发出去。
      logWarn('purchase.request.image.skipped', {
        task_id: taskId,
        reason: 'purchase_chat_id_unconfigured',
        env: 'PURCHASE_CHAT_ID',
        operator_open_id: operatorOpenId,
        hint: '未配置采购群，采购申请已生成但图与说明未发送；配好后可按 task 补发',
      });
      return { sent: [], failed: [], skipped: 'chat_id_unconfigured', thread_root_message_id: '' };
    }
    const sent = [];
    const failed = [];
    // ⭐⭐ 2026-10-16（供应商拆分 · 她选的 ⓐ）：**某一组之前已经出过报货单** ⇒ 这一次跳过它
    //   （AC-SS4「同一组重复生成 ⇒ 只出一次」）。判据是**已经落库的那张图**
    //   （「单据」附件列里的文件名 = 这一组的报货单身份 ✓）——**不引新状态、不查第二张表** ✓。
    //   ⚠️ 顺序上它是**先发图、后写附件**（下面的既有顺序）：所以"附件里有这张图"就等价于
    //      "这一张已经发出去过了" ✓（图没发成功的那一组**不写附件** ⇒ 重试照旧会补发 ✓）。
    const alreadyReported = [];
    // 「这一组的报货单叫什么文件名」的**唯一一处解析** —— 下面的前置判据与
    // `writeSupplierImageAttachment` 必须**同一个名字**，否则"已经出过"永远判不出来 ✗。
    // ⚠️ 语义与改前逐字一致：**只有 `undefined` 才用缺省**（显式传空串 ⇒ 名字里就是空的 ✓ 不放宽）。
    const fileNameSuffix = options.fileNameSuffix === undefined
      ? DEFAULT_DOCUMENT_FILE_SUFFIX : options.fileNameSuffix;
    // 发到群里的每条消息的 message_id / thread_id：记进本地映射，
    // 供「话题里的消息 / 引用那条消息 → 是哪一批」反查。
    const groupMessages = [];
    // 这一批在群里发的**第 1 条消息**（图）的 message_id = 话题根。
    // 它之后的每条消息都回复它（见下），于是整批只占一个话题。
    let threadRootMessageId = '';
    if (!operatorOpenId) {
      // 经办人没解析出来（报单记录没填/字段映射缺失）：照发正文，只是不 @ 人。
      // 记 warn 是为了排查"为什么这批单子没 @到经办人"，绝不退回 @所有人。
      logWarn('purchase.request.image.operator_missing', {
        task_id: taskId, chat_id: target.chatId, hint: '未解析出经办人 open_id，这条群消息不会 @任何人',
      });
    }
    // 群里那条话术的**文案**（含 @ 标记 / 供应商占位 / 双数占位 / 未标注供应商的兜底写法）
    // 全在 `config/purchaseGroupNoticeText`：**调用时才解析**（不在模块加载时求值）。
    const noticeConfig = resolvePurchaseGroupNoticeConfig();
    // ⭐ 分组 = `supplierReportGroups`（**同一个批次号下的几组** ✓ 她选的 ⓐ）——
    //   组键 / 单据键优先取**生成报货单那一步冻结好的计划**（见 `ensurePostingPlan`）。
    const reportGroups = this.supplierReportGroups(task, posting);
    if (reportGroups.length > 1) {
      logInfo(this.supplierSplit.events.grouped, {
        task_id: taskId, batch_no: batchNo, batch_count: 1, group_count: reportGroups.length,
        supplier_keys: reportGroups.map((group) => group.key),
        group_keys: reportGroups.map((group) => group.groupKey),
        policy: this.supplierSplit.batchNoPolicy,
      });
    }
    for (const group of reportGroups) {
      const supplierName = await this.resolveSupplierName(group.supplierRecordId).catch(() => '');
      // 供应商名取不到 → 用配置里的兜底写法（默认「未标注供应商」），**绝不编**。
      const label = supplierLabel(supplierName, noticeConfig);
      // ⭐⭐ 这一组**已经出过报货单** ⇒ 跳过（连图都不渲染 ✓ AC-SS4）。
      //   ⚠️ 判据只认**已经落库的事实**（「单据」里那张同名图）；拿不到批次身份 / 查询失败
      //     ⇒ **当它没出过**（宁可多发一次，也绝不静默少发一家 ✗ —— 少发才是真事故）。
      const fileName = documentFileNameOf(label, fileNameSuffix);
      if (batchNo && typeof this.orderBatches?.findDocument === 'function') {
        const known = await this.orderBatches.findDocument(batchNo, fileName).catch(() => null);
        if (known?.exists) {
          logInfo(this.supplierSplit.events.groupAlreadyReported, {
            task_id: taskId, batch_no: batchNo, supplier: label,
            group_key: group.groupKey, document_key: group.documentKey,
            file_name: fileName, batch_record_id: known.recordId || '',
            detail_count: group.items.length,
          });
          alreadyReported.push(label);
          continue;
        }
      }
      // ⚠️ 双数口径**一个字没动**：还是这一组明细的 `quantity` 求和。
      //    2026-10-07 只改文案（删掉「N 条」）——`group.items.length`（条数）**不再要了**，
      //    连那个变量一起删（留着没人读的 `rowCount` 只会让下一个人以为文案里还有条数）。
      const totalPairs = group.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
      let png;
      try {
        png = await this.images.render({
          supplierName,
          batchNo: posting.batch_no || draft.batch_no || '',
          items: group.items,
          // 不传就是采购申请单（渲染器里的默认标题），退货传「邯美皮鞋采购退货单」。
          title: options.title,
        });
        // ⚠️ 一条开话题、后面的回复它（业务负责人 2026-10-06 拍板）：
        // 以前图一条、文字一条都是**顶层消息**，飞书里顶层消息各成一个话题，
        // 一次提交就变成 4 条消息 / 4 个话题（生产实测）。
        // 现在：**第 1 条（图）照常顶层发** → 后面每条（文字 @、多供应商时的第 2 张图…）
        // 都 `im.message.reply` 回复**第 1 条**，于是它们都挂在那一个话题下。
        // ⚠️ 固定回复第 1 条，不是回复上一条：飞书的话题 = 一条消息 + 回复它的消息，
        // 回复话题内任何一条都算同一个话题；固定成根消息归属最稳，也最好排查。
        //
        // 🔴 2026-10-07 关键修复（业务负责人真机测试后）：「@了经办人，但不是在同一个话题下
        // 回复的，而是发了两条消息」。根因：**飞书里"回复"≠"话题"** —— 只 `im.message.reply`
        // 是**引用回复**，要**再带 `reply_in_thread: true`** 才进话题（主群里我们这条回复
        // 会**创建**话题，响应才回带 `thread_id`）。
        // ⇒ 这一批里**凡是回复第 1 条图的消息**（第 2 张图、@文字）都带 `inThread: true`。
        // ⚠️ **第 1 条图仍然是顶层 `create`**：群里没有"她的那条消息"可以回复（这条链路是
        // 多维表格记录变更触发的），所以话题的根**只能是这张图** —— 我们自己的第一条消息。
        const imageResult = await this.sendImage(target.chatId, png, 'chat_id', {
          replyToMessageId: threadRootMessageId,
          inThread: Boolean(threadRootMessageId),
        });
        // 第 1 条消息就是这一批的话题根：它之后的每一条都回到它身上。
        if (!threadRootMessageId && imageResult.messageId) threadRootMessageId = imageResult.messageId;
        if (!threadRootMessageId) {
          // 拿不到第 1 条的 message_id 就没法回复它 → 后面的消息只能退回顶层发
          //（话题归属保证不了）。真出现这条日志说明飞书响应里没有 message_id，
          // 属于异常；但**不能因此不发**她那条 @，所以只记一条 warn。
          logWarn('purchase.request.image.thread_root_missing', {
            task_id: taskId, chat_id: target.chatId, supplier: label,
            hint: '发送图片的响应里没有 message_id，后续消息将退回顶层发送（话题归属无法保证）',
          });
        }
        // 图单独一条、文字带 @经办人 单独一条：飞书图片消息没有正文，
        // @ 只能挂在文字那条上（业务负责人明确要 @经办人，不再是 @所有人）。
        // ⚠️ `inThread`：这条必须**进话题**（回复第 1 条图 + `reply_in_thread`）——
        //    她要的就是"图与文字在同一个话题里"，而飞书单靠"回复"只会得到一条引用回复。
        // ⚠️ 第 1 条图没有 `threadRootMessageId`（它就是根）→ 那种情况 `textInThread` 自然是
        //    `false`：顶层 `create` 本来也没有"回复谁 / 进哪个话题"这回事。
        const textInThread = Boolean(threadRootMessageId);
        // ⚠️ 2026-10-07（业务负责人逐字：「不用说几条，只给出多少双就可以了」）：
        //    文案从配置渲染 —— `{supplier} 这批 {pairs} 双，图可以直接转给供应商。`
        //    **没有「N 条」、也没有「共」**；`{pairs}` = 上面那个 `totalPairs`（口径未动）。
        const textResult = await this.sendText(
          target.chatId,
          this.mentionOperatorText(
            operatorOpenId,
            renderPurchaseGroupNoticeText({ label, pairs: totalPairs }, noticeConfig),
            noticeConfig,
          ),
          'chat_id',
          { replyToMessageId: threadRootMessageId, inThread: textInThread },
        );
        groupMessages.push(
          { messageId: imageResult.messageId, threadId: imageResult.threadId },
          { messageId: textResult.messageId, threadId: textResult.threadId },
        );
        // 业务负责人要据此测试：发出去那一刻就把「哪个群 / 哪一批 / 哪条消息 / 哪个话题」记全。
        logInfo('purchase.request.image.group_sent', {
          task_id: taskId, chat_id: target.chatId,
          batch_no: posting.batch_no || draft.batch_no || '', supplier: label,
          operator_open_id: operatorOpenId || '',
          thread_root_message_id: threadRootMessageId,
          image_message_id: imageResult.messageId, image_thread_id: imageResult.threadId,
          text_message_id: textResult.messageId, text_thread_id: textResult.threadId,
          text_is_reply: Boolean(threadRootMessageId && textResult.messageId),
          // ⭐ 2026-10-07：她要能一眼看出"这次是不是真的进了话题"——把发出去时用的
          // `reply_in_thread` 一起记下来（排查"怎么还是两条消息"时，第一眼就看这个字段）。
          text_reply_in_thread: textInThread,
        });
      } catch (error) {
        failed.push({ supplier: label, error: error.message });
        logError('purchase.request.image.send_failed', {
          task_id: taskId, supplier: label, chat_id: target.chatId, error: error.message,
        });
        // 图没发出去就不写附件：保持"先发图、再写回"的顺序，留下人工补发的余地。
        continue;
      }
      try {
        const written = await this.writeSupplierImageAttachment({
          taskId, supplierName: label, png,
          // ⭐ 2026-10-07：附件改回填**「报货批次」的「单据」**（业务负责人：
          // 「把这些信息挪到我们的'报货批次'里面」）—— 原来写的「采购申请单」那一列
          // 已被她**从生产表删掉**，再往那儿写只会 FieldNameNotFound。
          batchNo: posting.batch_no || draft.batch_no || '',
          // ⚠️ 传**上面已经解析好的那一份**（前置判据与它是同一个名字 ✓）—— 别再各解析一次 ✗
          fileNameSuffix,
          // 附件写回也是写库：带上这一层的关联键（task_id ＋ batch_no）。
          correlation,
        });
        if (written?.written) {
          logInfo('purchase.request.image.attachment_written', { task_id: taskId, ...written, ...correlation });
        }
      } catch (error) {
        // 只告警：她已经有图了。
        logWarn('purchase.request.image.attachment_write_failed', { task_id: taskId, supplier: label, error: error.message });
      }
      sent.push(label);
    }

    // 「这条消息 / 这条话题 ↔ 是哪一批」的映射：**发完就记**，失败只告警。
    // 记不上只影响 C 的定位（她会被告知"认不出"），绝不能让采购单已经发出去之后
    // 再把任务判成失败。
    for (const { messageId, threadId } of groupMessages.filter((item) => item.messageId)) {
      try {
        await this.batchLocator.rememberGroupMessage({
          batchNo,
          messageId,
          threadId,
          chatId: target.chatId,
          suppliers: sent,
          requestIds: posting.request_ids || [],
          detailCount: items.length,
          // 采购申请单 / 采购退货单共用这一条"出图 → 发群 → 记映射"的路，
          // 所以映射里必须带上类型：话题里的到货核对只认采购申请单那一类。
          kind: options.kind || ARRIVAL_BATCH_KINDS.PURCHASE_REQUEST,
        });
      } catch (error) {
        logWarn('purchase.request.image.batch_mapping_failed', {
          task_id: taskId, message_id: messageId, chat_id: target.chatId,
          batch_no: batchNo, error: error.message,
        });
      }
    }

    // `thread_root_message_id`：这一批在群里发的**第 1 条消息**（图）= 话题根。
    // 把它交回给调用方，退货的差额提示才能**回复它**、落在同一个话题里
    //（业务负责人：「一律在话题群里，以后私聊路线就没有了」）。
    const summary = {
      sent, failed, chat_id: target.chatId, thread_root_message_id: threadRootMessageId,
      // ⭐ 2026-10-16（供应商拆分 · AC-SS4）：这一次**因为已经出过而跳过**的那几组。
      //   与 `sent` 分开报 ⇒ 日志里一眼看得出"是重复生成、不是又出了几张" ✓（不混为一谈 ✗）。
      already_reported: alreadyReported,
      // 这一次一共分了几组（她选的 ⓐ：**批次号仍然只有一个** ✓ `batch_count` 恒为 1）。
      group_count: reportGroups.length,
      batch_count: 1,
    };
    if (failed.length) {
      // 图没发出去（例如机器人缺 im:resource 图片上传权限）时把失败留在任务里：
      // 采购事实已经写成、任务已是 posted，重收 webhook 会被当成重复投递跳过，
      // 所以必须留下这条记录，运维才知道哪一批图欠着、补完权限按 task 补发。
      await this.store.update(taskId, { image_delivery: { ...summary, at: new Date().toISOString() } })
        .catch((error) => logWarn('purchase.request.image.delivery_persist_failed', { task_id: taskId, error: error.message }));
    }
    return summary;
  },

  /**
   * 把某个供应商的采购申请图（或采购退货单图）写进**「报货批次」的「单据」**。
   *
   * ⭐ 2026-10-07 业务负责人改的地方（逐字）：
   *   「你之前**下载完附件之后，不是要回填到那个供应商那边吗？现在不用往那边填写信息了，
   *     你需要把这些信息挪到我们的'报货批次'里面**」
   * ⇒ 目标从「报货信息（表名沿革：原「具体信息」/「单据信息」）.采购申请单」改成「**报货批次.单据**」。
   *   原来那一列她已**从生产表删掉**，再往那儿写只会 `FieldNameNotFound`。
   *
   * 规则（**沿用改动前的语义**，只是换了落点）：
   * - 按「报货批次号」定位那一行批次记录；
   * - **重复执行（重跑批次）不得写出第二条** → 同名的图已经在「单据」里就跳过，连上传都不做；
   * - 一批多供应商时**已有附件原样带上**再追加新的那张（不冲掉别人的图）。
   *
   * ⚠️ 本方法**抛错**由调用方 catch（"写回失败不阻塞主流程"这条既有行为不变）——
   *    她已经有图了，写不回附件只是"欠一次转发"，绝不是把已经发出去的采购单判成失败。
   */
  async writeSupplierImageAttachment({
    taskId, supplierName, png, batchNo = '', fileNameSuffix = DEFAULT_DOCUMENT_FILE_SUFFIX, correlation = {},
  }) {
    if (!String(batchNo || '').trim()) {
      logWarn('purchase.request.image.no_batch_no', { task_id: taskId, supplier: supplierName });
      return { written: false, reason: 'no_batch_no' };
    }
    if (typeof this.gateway.uploadAttachment !== 'function') {
      throw new Error('gateway 不支持附件上传（uploadAttachment）');
    }
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'purchase-request-image-'));
    try {
      // ⭐ 2026-10-16：文件名拼法**搬进** `services/supplierSplitService.js` 的
      //   `documentFileNameOf`（**唯一一处** ✓）—— 因为"这一组是不是已经出过了"的前置判据
      //   （`deliverSupplierImagesInner`）必须与这里**逐字同名**，两处各写一份必然会漂 ✗。
      //   取值规则与改前**逐字一致**（不安全字符去掉；去完为空 ⇒ `supplier` 兜底 ✓）。
      const fileName = documentFileNameOf(supplierName, fileNameSuffix);
      // ⚠️ **上传之前**先判"这张图是不是已经在这一批的「单据」里了"：
      //    既有的语义是「重复执行**连上传都不做**」（重跑批次不该白传一次素材）。
      const existing = await this.orderBatches.findDocument(batchNo, fileName);
      if (!existing.found) {
        // 这一批在「报货批次」里**没有行**。2026-10-07 晚起**报货与退货都会建行**
        // （退货那一行由 ensureReturnBatchRecord 在出图之前建），所以走到这里只剩两种
        // 真实可能：① 那一行的创建**失败**（建行那一步只 warn、不阻塞）；
        // ② 没有批次号的旧数据 / 入口没写回号（writeSupplierImageAttachment 的
        //    `no_batch_no` 已经先记了一条）。两种情况都**不白传一次素材**，
        // 只记这条 warn —— 图已经发到群里了。
        logWarn('purchase.batch.document.no_record', {
          task_id: taskId, batch_no: batchNo, file_name: fileName,
          hint: '这一批在「采购主表」里没有行（建行失败 / 没有批次号）→ 单据图暂时没有落点',
        });
        return {
          written: false, reason: 'no_batch_record', batch_no: batchNo, file_name: fileName,
        };
      }
      if (existing.exists) {
        // 既有日志语义保持不变（原本叫 `attachment_exists`）：重复执行时的"已经有了"。
        logInfo('purchase.request.image.attachment_exists', {
          task_id: taskId, record_id: existing.recordId, batch_no: batchNo, file_name: fileName,
        });
        return {
          written: false, skipped: true, record_id: existing.recordId, batch_no: batchNo, file_name: fileName,
        };
      }
      const filePath = path.join(tempDir, fileName);
      await fs.promises.writeFile(filePath, png);
      const fileToken = await this.gateway.uploadAttachment(filePath);
      const written = await this.orderBatches.writeDocument({
        batchNo, fileToken, fileName, correlation,
      });
      if (written?.skipped) {
        logInfo('purchase.request.image.attachment_exists', {
          task_id: taskId, record_id: written.record_id, batch_no: batchNo, file_name: fileName,
        });
      }
      return { ...written, supplier: supplierName };
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  },
};

module.exports = documentImages;
