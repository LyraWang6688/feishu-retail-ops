'use strict';

/** 货品组扫码页：只读组库存 + 需要写业务时选具体货品。 */
const GROUP_SCAN_PAGE = Object.freeze({
  title: '货品组',
  texts: Object.freeze({
    total: '全组共 {count} 双',
    noMembers: '这个货品组还没有关联货品',
    noStock: '无库存',
    delisted: '已下架',
    size: '尺码',
    doorbox: '门盒',
    sample: '样品',
    other: '其他',
    totalColumn: '合计',
    unit: '双',
    doorboxKey: '门盒',
    sampleKey: '样品',
    adjust: '库存调整',
    notFound: '没有找到这个货品组',
    readFailed: '货品组读取失败',
    missingGroupId: '缺少货品组记录 ID',
    unknownError: '未知错误',
    unknownState: '未标注',
    pickMember: '请选择货品',
    pickHint: '选具体货品后继续原流程',
    memberNoStock: '无库存',
    memberNoAction: '暂无可操作',
  }),
  // 组库存页 → 单双调整：带上具体 productRecordId，并带回组库存页。
  adjustmentUrl: '/workbench/?module=inventory&page=inventory-adjust',
  // 售后不是扫码页领域；选完货品直接进既有售后落地页。
  afterSalesPage: '/workbench/after-sales.html',
  workbenchInventoryUrl: '/workbench/?module=inventory',
});

module.exports = { GROUP_SCAN_PAGE };
