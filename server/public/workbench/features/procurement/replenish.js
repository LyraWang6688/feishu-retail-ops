/**
 * 补货 panel：近 3 天销售 + 库存数量=0 的货品，按「货品 · 尺码」选数量。
 *
 * 数据来自 `GET /api/workbench/procurement/replenish`（服务端只读，只查销售明细）；
 * 会话草稿在 `store.js`（同一张草稿给补货 + 上新共用）。
 * 默认选中口径：**预订必补、默认已选（数量 = 预订数）**；只有现货的尺码默认不选。
 */
import { statsHtml, legendHtml, replenishGroupHtml, emptyHtml, totalTemplateHtml } from './render.js';

export const createReplenishPanel = (config) => {
  /** 拉数据 + 把「默认选中」并进草稿（只补不覆盖已改过的数量/勾选）。 */
  const load = async ({ api, store, draft }) => {
    const body = await api.loadReplenish();
    return { body, draft: store.seedDefaults(draft, 'replenish', body.groups || []) };
  };

  const render = ({ body, draft, store }) => {
    if (!body) return '';
    const groups = body.groups || [];
    const list = groups.length
      ? groups.map((group) => replenishGroupHtml(group, draft, store, config)).join('')
      : emptyHtml(config.texts.replenishEmpty);
    return `${statsHtml('replenish', body, config)}${legendHtml('replenish', config)}${list}`;
  };

  /** 局部刷新每个分组的「需补 N 双」（不整块重渲染，避免输入框失焦）。 */
  const refresh = (root, { body, draft, store }) => {
    for (const group of body?.groups || []) {
      const target = root.querySelector(`[data-pr-group-total="${group.productRecordId}"]`);
      if (!target) continue;
      const total = (group.sizes || []).reduce(
        (sum, row) => sum + store.quantityOf(draft, group.productRecordId, row.size), 0,
      );
      target.innerHTML = totalTemplateHtml(config.card.replenishTotal, total);
    }
  };

  return { load, render, refresh };
};
