/**
 * 上新 panel：最近 7 天新增的货品（`货品信息.上架日期` 在今天 + 往前 6 天内），按记录 ID 分组。
 *
 * 卡片：标题「货号 · 颜色」，小字「M月D日 HH:mm 新增 · 供应商」；
 * 普通码 / 特殊码默认都 0，需手动选；特殊码仍默认折叠（尺码段来自服务端下发的 normal/special，不在页面猜类别）。
 * 顶部统计**只有「新增货品」**（业务负责人 2026-10-28 确认）。
 */
import { totalTemplateHtml } from './render.js';

const normalTotalOf = (group, draft, store) => (group.sizes?.normal || [])
  .reduce((sum, size) => sum + store.quantityOf(draft, group.productRecordId, size), 0);

export const createNewProductsPanel = (config) => {
  const load = async ({ api, store, draft, force = false }) => {
    const body = await api.loadNewProducts({ force });
    return { body, draft: store.seedDefaults(draft, 'new', body.groups || []) };
  };

  /** 局部刷新每个分组的「普通码 N 双」（只数普通码；特殊码没有合计）。 */
  const refresh = (root, { body, draft, store }) => {
    for (const group of body?.groups || []) {
      const target = root.querySelector(`[data-pr-group-total="${group.productRecordId}"]`);
      if (!target) continue;
      if (group.categoryMissing) continue;
      target.innerHTML = totalTemplateHtml(config.card.newNormalTotal, normalTotalOf(group, draft, store));
    }
  };

  return { load, refresh };
};
