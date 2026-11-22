'use strict';

/**
 * 采购页提交归属索引（本地）。
 *
 * 飞书「供应主表」没有提交人字段；采购页要按“当前登录人今天提交”筛选，
 * 只能在提交成功后记一条本地归属记录。**只记归属，不记来源**：
 * 来源由修改页当前选择 / 双向关联负责，不再另存 source。
 */
const crypto = require('node:crypto');
const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { dayStart } = require('./procurementPageData');

const DEFAULT_DIR = path.join(__dirname, '../../data/procurement_submissions');
const idOf = (openId, batchNo) => 'procsub_'
  + crypto.createHash('sha256').update(String(openId || '') + '|' + String(batchNo || '')).digest('hex').slice(0, 24);

const createProcurementSubmissionIndex = (options = {}) => {
  const store = options.store || new JsonTaskStore({ dir: DEFAULT_DIR, idField: 'submission_id' });
  const now = options.now || (() => Date.now());

  const record = async ({ openId, batchNo, submittedAt = '', requestIds = [] } = {}) => {
    const open = String(openId || '').trim();
    const batch = String(batchNo || '').trim();
    if (!open || !batch) return { ok: false, reason: 'missing_identity' };
    const at = submittedAt ? new Date(submittedAt).toISOString() : new Date(now()).toISOString();
    const recordId = idOf(open, batch);
    const existing = await store.get(recordId);
    const ids = Array.isArray(requestIds) ? requestIds.filter(Boolean) : [];
    const body = {
      submission_id: recordId,
      open_id: open,
      batch_no: batch,
      submitted_at: at,
      request_ids: ids.length ? ids : (existing?.request_ids || []),
      status: 'submitted',
    };
    const saved = existing ? await store.update(recordId, body) : await store.create(body);
    return { ok: true, record: saved };
  };

  const listToday = async (openId) => {
    const open = String(openId || '').trim();
    if (!open) return [];
    const offset = Number(options.offsetMinutes ?? 480);
    const start = dayStart(now(), offset);
    const end = start + 24 * 60 * 60 * 1000;
    const rows = await store.list();
    return rows
      .filter((row) => String(row?.open_id || '') === open)
      .filter((row) => {
        const at = Date.parse(String(row?.submitted_at || ''));
        return Number.isFinite(at) && at >= start && at < end;
      })
      .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  };

  return { record, listToday };
};

module.exports = { createProcurementSubmissionIndex };
