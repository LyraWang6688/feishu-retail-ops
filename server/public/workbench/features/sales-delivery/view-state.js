/** 页面视图状态：货号筛选 → 排序 →（货未清按库存）分区域 → 按录单日分组。 */
import {
  SALES_DELIVERY_CONFIG, SALES_DELIVERY_REGIONS, SALES_DELIVERY_TABS, SALES_DELIVERY_TEXTS,
} from '../../config/sales-delivery.js';
import { filterItemsByProduct } from './filter.js';
import { groupItemsBySoldDate } from './group.js';
import { sortDeliveryGroups } from './sort.js';

const CONFIG = SALES_DELIVERY_CONFIG;
const T = SALES_DELIVERY_TEXTS;

export const viewState = (state) => {
  const filtered = filterItemsByProduct(state.itemsByTab[state.activeTab] || [], state.productFilter);
  const sorted = sortDeliveryGroups(filtered, CONFIG.sortDirection);
  const activeTab = SALES_DELIVERY_TABS.find((tab) => tab.key === state.activeTab);
  if (activeTab?.regionGrouping) {
    const regions = SALES_DELIVERY_REGIONS.map((region) => ({
      ...region,
      groups: groupItemsBySoldDate(sorted.filter((item) => item.region === region.key), T.soldAtMissing),
    })).filter((region) => region.groups.length);
    return { ...state, groups: [], regions };
  }
  return { ...state, groups: groupItemsBySoldDate(sorted, T.soldAtMissing) };
};
