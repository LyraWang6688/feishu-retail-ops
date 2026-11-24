'use strict';

/**
 * 采购报货草稿（单份、按 open_id 隔离）。
 *
 * 复用销售草稿的本地快照思路：JsonTaskStore + owner hash + TTL；
 * 但采购是「一个人一份」，所以不提供草稿列表，只做 save/get/remove。
 */
const crypto = require('node:crypto');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { PROCUREMENT_DRAFT } = require('../config/procurementDraft');

const text = (value) => String(value ?? '').trim();
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));
const ownerKey = (openId) => crypto.createHash('sha256').update(text(openId)).digest('hex').slice(0, 16);
const draftIdOf = (openId) => 'pd_' + ownerKey(openId);

const createProcurementDraftService = ({ store, config = PROCUREMENT_DRAFT, now = () => Date.now() } = {}) => {
  const taskStore = store || new JsonTaskStore({ dir: config.dir, idField: 'draft_id' });
  const expired = (record) => {
    const ttlMs = Number(config.ttlDays) * 24 * 60 * 60 * 1000;
    return ttlMs > 0 && now() - Date.parse(String(record.updated_at || record.created_at || '')) > ttlMs;
  };
  const clean = async (openId) => {
    const owner = text(openId);
    if (!owner) return null;
    const id = draftIdOf(owner);
    const record = await taskStore.get(id);
    if (!record || record.owner_open_id !== owner) return null;
    if (expired(record)) { await taskStore.remove(id).catch(() => {}); return null; }
    return record;
  };

  const get = async ({ openId } = {}) => {
    if (!config.enabled) return null;
    const record = await clean(openId);
    return record ? clone(record) : null;
  };

  const save = async ({ openId, snapshot = {} } = {}) => {
    const owner = text(openId);
    if (!config.enabled || !owner) return { ok: false, code: 'disabled' };
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.products || typeof snapshot.products !== 'object') {
      return { ok: false, code: 'invalid_snapshot' };
    }
    const id = draftIdOf(owner);
    const existing = await taskStore.get(id);
    const body = {
      draft_id: id,
      owner_open_id: owner,
      status: 'draft',
      snapshot: clone(snapshot),
      saved_at: new Date(now()).toISOString(),
    };
    const record = existing && existing.owner_open_id === owner
      ? await taskStore.update(id, body)
      : await taskStore.create(body);
    return { ok: true, draft: record };
  };

  const remove = async ({ openId } = {}) => {
    const owner = text(openId);
    if (!config.enabled || !owner) return false;
    const record = await clean(owner);
    if (!record) return false;
    await taskStore.remove(record.draft_id);
    return true;
  };

  return { save, get, remove, draftIdOf };
};

module.exports = { createProcurementDraftService };
