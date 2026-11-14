'use strict';

/** 手工「单双调整」的选项与页面文案（唯一来源；service / route 不写第二份）。 */
const PAIR_STATES = Object.freeze(['门盒', '样品']);

const PAIR_ADJUSTMENT_TEXTS = Object.freeze({
  pairFailed: '库存调整失败',
  seasonFlagFailed: '当季调整失败',
  printIntentMissingJob: '缺少任务编号',
  printIntentNotFound: '找不到这次库存调整任务',
  printIntentJobFailed: '库存调整没有成功，本次不会打印',
});

module.exports = { PAIR_STATES, PAIR_ADJUSTMENT_TEXTS };
