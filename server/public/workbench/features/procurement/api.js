/**
 * 采购页的**唯一**网络入口：两个只读端点 + 一个提交端点（端点配置在 `config/procurement.js`）。
 *
 * · 只读端点带**会话内缓存**：首屏只请求补货一次；切回补货不重复请求；失败不缓存（可重试）；
 * · 提交只 POST 一次（提交中的去重由调用方 `submit.js` 保证）；
 * · 错误统一抛 `ApiError`（core/api-client），页面给人话。
 */
import { api } from '../../core/api-client.js';

export const createApi = (config) => {
  const cache = { replenish: null, newProducts: null };

  const loadReplenish = async ({ force = false } = {}) => {
    if (!force && cache.replenish) return cache.replenish;
    const body = await api.get(config.endpoints.replenish);
    cache.replenish = body;
    return body;
  };
  const loadNewProducts = async ({ force = false } = {}) => {
    if (!force && cache.newProducts) return cache.newProducts;
    const body = await api.get(config.endpoints.newProducts);
    cache.newProducts = body;
    return body;
  };
  const loadSubmitted = async ({ offset = 0, limit = 20 } = {}) => api.get(`${config.endpoints.submitted}?offset=${encodeURIComponent(offset)}&limit=${encodeURIComponent(limit)}`);
  const loadSubmittedDetail = async (batchNo) => api.get(`${config.endpoints.submitted}/${encodeURIComponent(batchNo)}`);
  const submit = async ({ submitKey, items }) => api.post(config.endpoints.submit, { submitKey, items });
  const modify = async ({ batchNo, submitKey, items }) => api.post(config.endpoints.modify, { batchNo, submitKey, items });
  const loadDraft = async () => api.get(config.endpoints.draft);
  const saveDraft = async (snapshot) => api.post(config.endpoints.draft, { snapshot });
  const deleteDraft = async () => api.delete(config.endpoints.draft);

  return {
    loadReplenish,
    loadNewProducts,
    loadSubmitted,
    loadSubmittedDetail,
    submit,
    modify,
    loadDraft,
    saveDraft,
    deleteDraft,
    invalidate: (tab) => {
      if (tab === 'replenish') cache.replenish = null;
      if (tab === 'new') cache.newProducts = null;
      if (!tab) {
        cache.replenish = null;
        cache.newProducts = null;
      }
    },
  };
};
