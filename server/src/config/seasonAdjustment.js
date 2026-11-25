'use strict';

/**
 * 扫码当季调整（2026-11-25）。
 * 只改实时库存的「当季」和「仓库员」，不改所属状态、不改数量。
 * 用本地 WAL 记录本次操作，失败后按 requestId 续跑。
 */
const path = require('node:path');
const { readInt, readString } = require('./envValue');

const SEASON_ADJUSTMENT = Object.freeze({
  dir: readString(process.env, 'SEASON_ADJUSTMENT_DIR', '')
    || path.join(__dirname, '../../data/season_adjustments'),
  maxChanges: readInt(process.env, 'SEASON_ADJUSTMENT_MAX_CHANGES', 200, { min: 1, max: 1000 }),
  behavior: Object.freeze({
    release: 'STOCK_RELEASE',
    freeze: 'STOCK_FREEZE',
  }),
});

module.exports = { SEASON_ADJUSTMENT };
