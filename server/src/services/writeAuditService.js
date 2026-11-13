'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WRITE_AUDIT, auditDomainEnabled, auditDomainForCorrelation } = require('../config/writeAudit');
const { logWarn } = require('../utils/logger');

const SENSITIVE_KEY = /token|secret|password|authorization|open_id|chat_id/i;
const appendQueues = new Map();
let seq = 0;

const textOf = (value, maxLength) => {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  text = String(text ?? '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};

const safeFields = (fields) => {
  const entries = Object.entries(fields || {}).slice(0, WRITE_AUDIT.maxFieldCount);
  return Object.fromEntries(entries.map(([name, value]) => [
    name,
    SENSITIVE_KEY.test(name) ? '[redacted]' : textOf(value, WRITE_AUDIT.maxValueLength),
  ]));
};

const dayOf = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const auditFileOf = (date, dir = WRITE_AUDIT.dir) => path.join(dir, `${dayOf(date)}.jsonl`);

const appendEvent = (event) => {
  const file = auditFileOf(new Date(event.at));
  const previous = appendQueues.get(file) || Promise.resolve();
  const next = previous.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
  }).catch((error) => {
    logWarn('write_audit.append_failed', {
      file,
      error: String(error?.message || error).slice(0, 200),
    });
  });
  appendQueues.set(file, next);
  return next;
};

/**
 * 记录一次成功写入；best-effort，绝不抛给业务。
 * @param {object} input {domain, correlation, tableKey, tableId, operation, recordId, fields, batchId, traceId}
 */
const recordWrite = (input = {}) => {
  const domain = String(input.domain || '').trim();
  if (!auditDomainEnabled(domain)) return Promise.resolve(null);
  const now = input.now instanceof Date ? input.now : new Date();
  const event = {
    event: 'write_audit',
    at: now.toISOString(),
    seq: ++seq,
    trace_id: String(input.traceId || input.correlation?.trace_id || input.correlation?.task_id || '').trim(),
    domain,
    table_key: String(input.tableKey || '').trim(),
    table_id: String(input.tableId || '').trim(),
    operation: String(input.operation || '').trim(),
    record_id: String(input.recordId || '').trim(),
    batch_id: String(input.batchId || '').trim() || undefined,
    batch_index: Number.isInteger(input.batchIndex) ? input.batchIndex : undefined,
    correlation: Object.fromEntries(Object.entries(input.correlation || {})
      .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
      .map(([key, value]) => [key, String(value)])),
    fields: safeFields(input.fields),
  };
  return appendEvent(event);
};

/**
 * 按业务键查询审计（默认按 order_no / trace_id）。
 * 单进程、低数据量；一次读取时间范围内的 JSONL。
 */
const queryWriteAudit = async ({
  orderNo = '', traceId = '', domain = '', limit = 500, dir = WRITE_AUDIT.dir,
} = {}) => {
  const wantedOrder = String(orderNo || '').trim();
  const wantedTrace = String(traceId || '').trim();
  if (!wantedOrder && !wantedTrace) return [];
  let files = [];
  try {
    files = (await fs.promises.readdir(dir)).filter((name) => name.endsWith('.jsonl')).sort().slice(-30);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const file of files) {
    const content = await fs.promises.readFile(path.join(dir, file), 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (domain && event.domain !== domain) continue;
      if (wantedOrder && event.correlation?.order_no !== wantedOrder) continue;
      if (wantedTrace && event.trace_id !== wantedTrace) continue;
      rows.push(event);
    }
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq - b.seq)).slice(0, limit);
};

/** 网关写成功后调用：按 options/correlation 决定域，best-effort。 */
const auditGatewayWrite = ({ options = {}, correlation = {}, tableKey, tableId, operation, recordId, fields, batchId, batchIndex } = {}) => {
  const explicit = options.audit;
  const domain = explicit
    ? (typeof explicit === 'string' ? explicit : String(explicit.domain || '').trim())
    : auditDomainForCorrelation(correlation);
  if (!domain) return;
  void recordWrite({
    domain, correlation, tableKey, tableId, operation, recordId, fields, batchId, batchIndex,
    traceId: typeof explicit === 'object' ? explicit.traceId : '',
  });
};

module.exports = { recordWrite, queryWriteAudit, auditGatewayWrite };
