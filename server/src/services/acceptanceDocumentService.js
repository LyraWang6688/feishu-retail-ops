'use strict';

/**
 * 验收完成后：生成验收单 → 追加我方单据 → 发原采购话题 → 同步云盘。
 *
 * ⚠️ 本 service 不写库存、不改验收事实；只在 finish 成功之后做单据副作用。
 * 失败由调用方告警，不回滚已经完成的入库。
 */
const LAYOUT = require('../config/acceptanceDocumentImageLayout');
const { renderAcceptanceDocumentPng } = require('./acceptanceDocumentImageService');
const { summarize } = require('./acceptanceDocumentImageService');
const { logWarn } = require('../utils/logger');

const formatAcceptedAt = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
};

const createAcceptanceDocumentService = ({
  purchaseWebhooks,
  batchLocator,
  supplyDocumentSync,
  render = renderAcceptanceDocumentPng,
  now = () => new Date(),
  config = LAYOUT,
} = {}) => {
  if (!purchaseWebhooks) throw new Error('acceptanceDocumentService requires purchaseWebhooks');
  if (!batchLocator) throw new Error('acceptanceDocumentService requires batchLocator');

  const deliver = async ({
    batchNo = '', batchRecordId = '', taskId = '', task = null, supplierName = '', correlation = {},
  } = {}) => {
    const wantedNo = String(batchNo || task?.batch_no || '').trim();
    if (!wantedNo) return { ok: false, reason: 'no_batch_no' };
    const rows = Array.isArray(task?.plan) ? task.plan : [];
    if (!rows.length) return { ok: false, reason: 'no_plan_rows' };
    const png = await render({
      batchNo: wantedNo,
      supplierName,
      acceptedAt: formatAcceptedAt(task?.accepted_at || now().toISOString()),
      rows,
    });
    if (!Buffer.isBuffer(png) || !png.length) return { ok: false, reason: 'empty_image' };

    // 先追加我方单据；同名文件已存在时 writeSupplierImageAttachment 会跳过上传/追加。
    const written = await purchaseWebhooks.writeSupplierImageAttachment({
      taskId, supplierName, png, batchNo: wantedNo,
      fileNameSuffix: config.fileNameSuffix, correlation,
    });
    if (!written || (!written.written && !written.skipped)) {
      return { ok: false, reason: written?.reason || 'document_not_written', written };
    }

    // 发到原采购申请话题。找不到映射只告警，不新开话题。
    let sent = false;
    let sendError = '';
    const messages = await batchLocator.findByBatchNo(wantedNo).catch(() => []);
    const root = (Array.isArray(messages) ? messages : []).find((item) => item?.message_id && item?.chat_id);
    const current = taskId && purchaseWebhooks.store?.get
      ? await purchaseWebhooks.store.get(taskId).catch(() => null) : null;
    if (root && current?.acceptance_document?.sent !== true) {
      const totals = summarize(rows);
      const text = LAYOUT.labels.completion
        .replace('{batchNo}', wantedNo)
        .replace('{expected}', totals.expected)
        .replace('{actual}', totals.actual)
        .replace('{extra}', totals.extra);
      try {
        await purchaseWebhooks.sendImage(root.chat_id, png, 'chat_id', {
          replyToMessageId: root.message_id, inThread: true,
        });
        // 图片已经发出 ⇒ 先记 sent，避免重试重复发图；文字失败只告警。
        sent = true;
        if (taskId && purchaseWebhooks.store?.update) {
          await purchaseWebhooks.store.update(taskId, {
            acceptance_document: { sent: true, at: now().toISOString(), batch_no: wantedNo },
          }).catch(() => null);
        }
        if (typeof purchaseWebhooks.sendText === 'function') {
          try {
            await purchaseWebhooks.sendText(root.chat_id, text, 'chat_id', {
              replyToMessageId: root.message_id, inThread: true,
            });
          } catch (error) {
            sendError = String(error?.message || error).slice(0, 300);
          }
        }
      } catch (error) {
        sendError = String(error?.message || error).slice(0, 300);
      }
    }

    let sync = null;
    let syncError = '';
    if (supplyDocumentSync && typeof supplyDocumentSync.syncBatch === 'function') {
      try {
        sync = await supplyDocumentSync.syncBatch({
          batchNo: wantedNo, batchRecordId, supplierName,
        });
      } catch (error) {
        syncError = String(error?.message || error).slice(0, 300);
      }
    }
    if (sendError) {
      logWarn('purchase.acceptance_document.group_send_failed', {
        batch_no: wantedNo, error: sendError,
      });
    }
    if (syncError) {
      logWarn('purchase.acceptance_document.sync_failed', {
        batch_no: wantedNo, error: syncError,
      });
    }
    return {
      ok: true, written, sent, sync,
      ...(sendError ? { sendError } : {}),
      ...(syncError ? { syncError } : {}),
    };
  };

  /** 验收后台入口：取 task / 供应商名后执行；任何异常只告警，不回滚验收。 */
  const deliverForTask = async ({ requestId = '', batchNo = '', batchRecordId = '', taskId = '', correlation = {} } = {}) => {
    try {
      const task = taskId && purchaseWebhooks.store?.get
        ? await purchaseWebhooks.store.get(taskId).catch(() => null) : null;
      const supplierName = task?.supplier_record_id && typeof purchaseWebhooks.resolveSupplierName === 'function'
        ? await purchaseWebhooks.resolveSupplierName(task.supplier_record_id).catch(() => '') : '';
      const result = await deliver({
        batchNo, batchRecordId, taskId, task, supplierName, correlation,
      });
      if (!result.ok) {
        logWarn('purchase.acceptance_document.sync_skipped', {
          request_id: requestId, batch_no: batchNo, reason: result.reason || 'not_ready',
        });
      }
      return result;
    } catch (error) {
      logWarn('purchase.acceptance_document.failed', {
        request_id: requestId, batch_no: batchNo, error: String(error?.message || error).slice(0, 200),
      });
      return { ok: false, reason: 'failed' };
    }
  };

  return { deliver, deliverForTask };
};

module.exports = { createAcceptanceDocumentService, formatAcceptedAt };
