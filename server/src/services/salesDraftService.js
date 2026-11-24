'use strict';

/**
 * 销售扫码草稿快照（只存本地 JSON）：
 *   · 只有用户点「保存」才写；
 *   · 同一用户可以有多份；
 *   · 列表只返回本人的草稿；
 *   · 不写飞书销售表、不扣库存、不触发打印。
 */
const crypto = require('node:crypto');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { SALES_DRAFT } = require('../config/salesDraft');

const text = (value) => String(value ?? '').trim();
const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

const createSalesDraftService = ({ store, config = SALES_DRAFT, now = () => Date.now() } = {}) => {
  const taskStore = store || new JsonTaskStore({ dir: config.dir, idField: 'draft_id' });
  const ownerKey = (openId) => crypto.createHash('sha256').update(text(openId)).digest('hex').slice(0, 16);
  const draftIdOf = (openId) => 'sd_' + ownerKey(openId) + '_' + now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  const expired = (record) => {
    const ttlMs = Number(config.ttlDays) * 24 * 60 * 60 * 1000;
    return ttlMs > 0 && now() - Date.parse(String(record.updated_at || record.created_at || '')) > ttlMs;
  };
  const summaryOf = (record) => ({
    draftId: record.draft_id,
    step: record.step,
    productRecordId: record.product_record_id || '',
    number: record.number || '',
    itemNo: record.item_no || '',
    color: record.color || '',
    itemCount: Array.isArray(record.lines) ? record.lines.length : 0,
    updatedAt: record.updated_at,
  });

  const save = async ({ openId, draftId = '', step = 'goods', snapshot = {} } = {}) => {
    const owner = text(openId);
    if (!config.enabled || !owner) return { ok: false, code: 'disabled' };
    const id = text(draftId);
    if (id) {
      const existing = await taskStore.get(id);
      if (!existing || existing.owner_open_id !== owner) return { ok: false, code: 'not_found' };
      const next = await taskStore.update(id, {
        ...clone(snapshot),
        draft_id: id,
        owner_open_id: owner,
        step: step === config.steps.payment ? config.steps.payment : config.steps.goods,
        status: 'draft',
      });
      return { ok: true, draft: next };
    }
    const all = (await taskStore.list()).filter((record) => record.owner_open_id === owner && !expired(record));
    if (all.length >= Number(config.maxDrafts)) return { ok: false, code: 'too_many' };
    const draft = await taskStore.create({
      ...clone(snapshot),
      draft_id: draftIdOf(owner),
      owner_open_id: owner,
      step: step === config.steps.payment ? config.steps.payment : config.steps.goods,
      status: 'draft',
    });
    return { ok: true, draft };
  };

  const list = async ({ openId } = {}) => {
    const owner = text(openId);
    if (!config.enabled || !owner) return [];
    const all = await taskStore.list();
    const active = [];
    for (const record of all) {
      if (record.owner_open_id !== owner) continue;
      if (expired(record)) { await taskStore.remove(record.draft_id).catch(() => {}); continue; }
      active.push(summaryOf(record));
    }
    return active.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  };

  const get = async ({ openId, draftId } = {}) => {
    const owner = text(openId);
    const id = text(draftId);
    if (!config.enabled || !owner || !id) return null;
    const record = await taskStore.get(id);
    if (!record || record.owner_open_id !== owner || expired(record)) return null;
    return clone(record);
  };

  const remove = async ({ openId, draftId } = {}) => {
    const owner = text(openId);
    const id = text(draftId);
    if (!config.enabled || !owner || !id) return false;
    const record = await taskStore.get(id);
    if (!record || record.owner_open_id !== owner) return false;
    await taskStore.remove(id);
    return true;
  };

  return { save, list, get, remove, summaryOf };
};

module.exports = { createSalesDraftService };
