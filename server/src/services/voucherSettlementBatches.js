'use strict';

/**
 * 团购券结算的**对账进度**（2026-11-14）。
 *
 * 为什么需要它（真实缺口）：团购券按「创建日整批」对平后才逐笔改「已收款」，
 * 但首轮可能**部分成功**（100 元里 50 元成功、50 元失败）。下一轮我方只剩未结的
 * 50 元，平台账单/提现仍是整天的 100 元 ⇒ **永远对不上、永不再结**。
 *
 * ⇒ 对平通过时先把这一批的「记录 id → 金额」落盘（**再开始逐笔结算**）：
 *   · 下一轮把批次里**已结清**的记录也计入我方金额 ⇒ 100 = 100 ✓；
 *   · 只对**当前仍待结算**的记录续做 ⇒ 不会重复结清；
 *   · 全部结清后把批次标记 `done`（文件保留，不再参与对账）。
 *
 * 存储用 `infrastructure/jsonTaskStore`（tmp+rename 原子写 + 同 id 写互斥）。
 * `dir` 不传时用**进程内 Map**（单测用，避免测试写真实 data 目录）。
 */

const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');

const BATCH_ID_FIELD = 'batch_id';

const createMemoryStore = () => {
  const map = new Map();
  return {
    async get(batchId) {
      const value = map.get(String(batchId));
      return value ? { ...value } : null;
    },
    async save(batch) {
      map.set(String(batch.batch_id), { ...batch });
      return { ...batch };
    },
    async markDone(batchId, doneAt) {
      const current = map.get(String(batchId));
      if (current) map.set(String(batchId), { ...current, done: true, done_at: doneAt });
    },
    async list() {
      return [...map.values()].map((value) => ({ ...value }));
    },
  };
};

const createVoucherSettlementBatchStore = ({ dir } = {}) => {
  if (!dir) return createMemoryStore();
  const store = new JsonTaskStore({ dir, idField: BATCH_ID_FIELD });
  return {
    async get(batchId) {
      return store.get(String(batchId));
    },
    /** 已存在则整条覆盖（同一批的进度只会前进，不会回退）。 */
    async save(batch) {
      const payload = { ...batch, batch_id: String(batch.batch_id) };
      const { created } = await store.createIfAbsent(payload);
      if (!created) await store.update(payload.batch_id, payload);
      return payload;
    },
    async markDone(batchId, doneAt) {
      const id = String(batchId);
      const current = await store.get(id);
      if (!current) return;
      await store.update(id, { done: true, done_at: String(doneAt || '') });
    },
    async list() {
      return store.list();
    },
  };
};

/** 读「未完成」批次；读失败只 warn（下一轮再试，不阻塞业务）。 */
const loadActiveBatches = async (store, logger = { logWarn: () => {} }) => {
  try {
    const rows = await store.list();
    return (Array.isArray(rows) ? rows : []).filter((row) => row && row.batch_id && !row.done);
  } catch (error) {
    logger.logWarn('voucher.settlement.batch_read_failed', { error: String(error?.message || error).slice(0, 200) });
    return [];
  }
};

module.exports = { createVoucherSettlementBatchStore, loadActiveBatches, BATCH_ID_FIELD };
