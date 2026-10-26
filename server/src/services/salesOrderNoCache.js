'use strict';

/**
 * 销售单号本地缓存（2026-10-27 · 异步销售链路）。
 *
 * 目标：资金页/货品页**不再为了取号读整张销售主表**。
 *   · 内存里保存当天 {date, lastSeq}；
 *   · 第一次用/跨天：读一次当天号段（gateway.listByFilter）作为起点；
 *   · 之后本地递增，持久化到本地 JSON；
 *   · 真撞号时调用方用 `bump` 递增重试。
 * 单号格式仍是 `XSD-YYYYMMDD-NNNN`（上海时区），与既有 salesOrderNo 同源。
 */
const fs = require('node:fs');
const path = require('node:path');
const { shanghaiDateStamp } = require('./salesOrderNo');

const DEFAULT_FILE = path.join(__dirname, '..', '..', 'data', 'sales_order_no_cache.json');

const readCache = (file) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.date === 'string' && Number.isInteger(parsed.lastSeq)) return parsed;
  } catch (error) { /* 不存在/损坏 ⇒ 按没有处理 */ }
  return null;
};

const writeCache = (file, value) => {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  } catch (error) {
    // 持久化失败不能阻断取号；内存值仍可继续，重启时重新从表里初始化。
  }
};

const createSalesOrderNoCache = ({ gateway, file = DEFAULT_FILE, now = () => Date.now() } = {}) => {
  if (!gateway) throw new Error('SalesOrderNoCache requires gateway');
  let state = readCache(file);

  const dayOf = (at) => shanghaiDateStamp(new Date(at));

  const initializeFromTable = async (dateStamp) => {
    const field = gateway.table('salesEntry').fields.orderNo;
    const expression = `CurrentValue.[${field}].contains("XSD-${dateStamp}")`;
    const records = typeof gateway.listByFilter === 'function'
      ? await gateway.listByFilter('salesEntry', expression)
      : await gateway.listAll('salesEntry');
    let max = 0;
    const pattern = /^XSD-\d{8}-(\d{4})$/;
    for (const record of records || []) {
      const raw = String(record?.fields?.[field] || '').trim();
      const matched = pattern.exec(raw);
      if (matched && raw.includes(`XSD-${dateStamp}`)) max = Math.max(max, Number(matched[1]));
    }
    return max;
  };

  const ensureDay = async () => {
    const date = dayOf(now());
    if (state && state.date === date) return state;
    const lastSeq = await initializeFromTable(date);
    state = { date, lastSeq };
    writeCache(file, state);
    return state;
  };

  const next = async () => {
    const current = await ensureDay();
    current.lastSeq += 1;
    writeCache(file, current);
    return {
      orderNo: `XSD-${current.date}-${String(current.lastSeq).padStart(4, '0')}`,
      sequence: current.lastSeq,
      date: current.date,
    };
  };

  /** 撞号后把本地序号推到这个值（至少比它大），下一次重新取号。 */
  const bump = (sequence) => {
    if (!state) state = { date: dayOf(now()), lastSeq: 0 };
    const value = Number(sequence);
    if (Number.isInteger(value) && value > state.lastSeq) {
      state.lastSeq = value;
      writeCache(file, state);
    }
  };

  return { next, bump, _state: () => state, file };
};

module.exports = { createSalesOrderNoCache, DEFAULT_FILE };
