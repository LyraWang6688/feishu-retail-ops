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
const { SCAN_WRITE } = require('../config/scanWrite');
const { dayStart } = require('./procurementPageData');

const DEFAULT_DIR = path.join(__dirname, '../../data/procurement_submissions');
const idOf = (openId, batchNo) => 'procsub_'
  + crypto.createHash('sha256').update(String(openId || '') + '|' + String(batchNo || '')).digest('hex').slice(0, 24);

const createProcurementSubmissionIndex = (options = {}) => {
  const store = options.store || new JsonTaskStore({ dir: DEFAULT_DIR, idField: 'submission_id' });
  // 2026-11-22 之前提交的采购批次没有归属索引；从既有采购任务目录补读。
  // 采购页任务 id 含 `procurement_`，扫码补货任务也在这个目录，必须按它排除。
  const replenishTaskStore = options.replenishTaskStore || new JsonTaskStore({
    dir: SCAN_WRITE.replenish.taskDir, idField: 'task_id',
  });
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
    const rows = (await store.list())
      .filter((row) => String(row?.open_id || '') === open)
      .filter((row) => {
        const at = Date.parse(String(row?.submitted_at || ''));
        return Number.isFinite(at) && at >= start && at < end;
      });
    const seen = new Set(rows.map((row) => String(row.batch_no)));
    for (const task of await replenishTaskStore.list().catch(() => [])) {
      const draft = task?.draft || {};
      if (String(draft.open_id || draft.operator_open_id || '') !== open) continue;
      if (!String(task?.task_id || '').includes('procurement_')) continue;
      if (task?.status !== 'posted' || !task?.batch_no) continue;
      const at = Date.parse(String(task.updated_at || task.created_at || ''));
      if (!Number.isFinite(at) || at < start || at >= end || seen.has(String(task.batch_no))) continue;
      seen.add(String(task.batch_no));
      rows.push({ open_id: open, batch_no: task.batch_no, submitted_at: new Date(at).toISOString(), request_ids: task.request_ids || [] });
    }
    return rows.sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
  };

  return { record, listToday };
};

module.exports = { createProcurementSubmissionIndex };
