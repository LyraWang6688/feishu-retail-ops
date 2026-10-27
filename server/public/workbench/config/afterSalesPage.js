/** 售后扫一扫页面的配置（只放文案/路径/动作，不放业务规则）。 */
export const AFTER_SALES_PAGE = {
  title: '售后单',
  candidatesApi: '/api/workbench/sales/after-sales/candidates',
  days: 7,
  loading: '正在查找近 7 天的销售单…',
  empty: '近 7 天没有包含这款货品的销售单。',
  failed: '销售单查找失败，请返回重试。',
  chooseOrder: '选择要售后的销售单',
  chooseAction: '选择售后动作',
  back: '← 返回',
};

export const AFTER_SALES_ACTIONS = [
  { value: 'return', label: '退货' },
  { value: 'exchange', label: '换货' },
  { value: 'compensation', label: '赔货' },
];
