'use strict';

/**
 * 「是否打印」轻页的**一次性令牌**（2026-11-17）。
 *
 * 为什么要有它：
 *   · 销售资金页 / 验收提交后，先回一张「是否打印」页；
 *   · 页面只拿到一个短令牌，不把「货品记录 ID 列表」裸露在 URL 里；
 *   · 令牌一次性、默认 15 分钟过期；提交后不能再用。
 *
 * ⚠️ 内存存储：页面是**提交后几秒到几分钟**内用的；进程重启后旧页面失效可接受
 *    （她重新提交/重新打印即可）。不落盘、不新增运行时数据。
 */
const crypto = require('node:crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

const cleanProducts = (products = []) => {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(products) ? products : []) {
    const recordId = String(item?.recordId || '').trim();
    if (!recordId || seen.has(recordId)) continue;
    seen.add(recordId);
    out.push({
      recordId,
      itemNo: String(item?.itemNo || '').trim(),
      color: String(item?.color || '').trim(),
      number: String(item?.number || '').trim(),
    });
  }
  return out;
};

const createPrintPromptService = ({
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  idFactory = () => crypto.randomUUID(),
} = {}) => {
  const prompts = new Map();

  const cleanup = (at) => {
    for (const [token, prompt] of prompts) {
      if (prompt.usedAt || at >= prompt.expiresAt) prompts.delete(token);
    }
    while (prompts.size >= maxEntries) {
      const oldest = prompts.keys().next().value;
      prompts.delete(oldest);
    }
  };

  /**
   * @param {object} input
   * @param {string} input.kind sale | acceptance
   * @param {string} input.source SOURCES.sale / SOURCES.acceptance
   * @param {string} input.operationId 销售主表 record_id / 验收 job_id
   * @param {string} input.ownerOpenId
   * @param {Array} input.products [{ recordId, itemNo, color, number }]
   * @param {string} input.returnUrl 打印/不打印后回哪
   */
  const create = (input = {}) => {
    const at = now();
    cleanup(at);
    const products = cleanProducts(input.products);
    if (!products.length) return null;
    const token = String(idFactory() || '').trim();
    if (!token) return null;
    const prompt = {
      token,
      kind: String(input.kind || ''),
      source: String(input.source || ''),
      operationId: String(input.operationId || ''),
      ownerOpenId: String(input.ownerOpenId || ''),
      returnUrl: String(input.returnUrl || '/workbench/'),
      products,
      issuedAt: new Date(at).toISOString(),
      expiresAt: at + Math.max(1000, Number(ttlMs) || DEFAULT_TTL_MS),
      usedAt: '',
    };
    prompts.set(token, prompt);
    return prompt;
  };

  const get = (token) => {
    const key = String(token || '').trim();
    const prompt = prompts.get(key);
    if (!prompt) return null;
    if (prompt.usedAt || now() >= prompt.expiresAt) {
      prompts.delete(key);
      return null;
    }
    return { ...prompt, products: prompt.products.map((item) => ({ ...item })) };
  };

  /** 一次性消费；只接受令牌里存在的货品。返回 { prompt, selected } 或 null。 */
  const consume = (token, selectedRecordIds = []) => {
    const prompt = get(token);
    if (!prompt) return null;
    const wanted = new Set((Array.isArray(selectedRecordIds) ? selectedRecordIds : [selectedRecordIds])
      .map((id) => String(id || '').trim()).filter(Boolean));
    const selected = prompt.products.filter((item) => wanted.has(item.recordId));
    prompt.usedAt = new Date(now()).toISOString();
    prompts.set(prompt.token, prompt);
    return { prompt, selected };
  };

  return { create, get, consume };
};

// ⚠️ 令牌放 query，不放路径：全局请求日志会记 path（token 会进日志），query 只记键名。
const printPromptUrlOf = (token) => '/print-prompt?token=' + encodeURIComponent(String(token || ''));

module.exports = {
  createPrintPromptService,
  printPromptUrlOf,
  DEFAULT_TTL_MS,
};
