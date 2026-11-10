'use strict';

/** 手工「单双调整」的选项与页面文案（唯一来源；service / route 不写第二份）。 */
const PAIR_STATES = Object.freeze(['门盒', '样品']);

const PAIR_ADJUSTMENT_TEXTS = Object.freeze({
  pairFailed: '库存调整失败',
  seasonFlagFailed: '当季调整失败',
});

module.exports = { PAIR_STATES, PAIR_ADJUSTMENT_TEXTS };
