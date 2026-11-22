/**
 * 补货 panel：近 3 天销售 + 库存数量=0 的货品，加采购明细未到货，按「货品 · 尺码」选数量。
 *
 * 数据来自 `GET /api/workbench/procurement/replenish`（服务端只读，销售 + 采购明细）；
 * 会话草稿在 `store.js`（同一张草稿给补货 + 上新共用）。
 * 默认选中口径（2026-11-17 业务负责人）：**补货所有尺码默认 0，不自动填数量**
 * （预订 / 现货一致，与上新相同）；数量由她手填 / 点 ± 决定。
 */
import { totalTemplateHtml } from './render.js';

export const createReplenishPanel = (config) => {
  /** 拉数据 + 把「默认选中」并进草稿（只补不覆盖已改过的数量/勾选）。 */
  const load = async ({ api, store, draft, force = false }) => {
    const body = await api.loadReplenish({ force });
    return { body, draft: store.seedDefaults(draft, 'replenish', body.groups || []) };
  };

  /** 局部刷新每个分组的「需补 N 双」（不整块重渲染，避免输入框失焦）。 */
  const refresh = (root, { body, draft, store }) => {
    for (const group of body?.groups || []) {
      const target = root.querySelector(`[data-pr-group-total="${group.productRecordId}"]`);
      if (!target) continue;
      const customs = typeof store.customSizesOf === 'function' ? store.customSizesOf(draft, group.productRecordId) : [];
      const total = (group.sizes || []).reduce(
        (sum, row) => sum + store.quantityOf(draft, group.productRecordId, row.size), 0,
      ) + customs.reduce((sum, size) => sum + store.quantityOf(draft, group.productRecordId, size), 0);
      target.innerHTML = totalTemplateHtml(config.card.replenishTotal, total);
    }
  };

  return { load, refresh };
};
