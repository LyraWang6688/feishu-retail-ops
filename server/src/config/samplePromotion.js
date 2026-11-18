'use strict';

/**
 * 扫码销售：卖到「只有样品」的尺码时，补新样品的配置（2026-11-18）。
 *
 * 只声明字段名与文案；不在这里写业务判断（判断在视图/服务里）。
 */
const SAMPLE_PROMOTION = Object.freeze({
  field: 'sample_promotion_size',
  texts: Object.freeze({
    modalTitle: '这一双是样品',
    modalBody: '卖掉后这一款没有样品了。剩下的尺码里，哪个做样品？',
    confirm: '就选这个',
    cancel: '暂不选',
    noCandidates: '',
    candidateLabel: '{size} 码',
    tagDoorbox: '门盒',
    tagSample: '样品',
    tagEmpty: '空状态',
  }),
});

module.exports = { SAMPLE_PROMOTION };
