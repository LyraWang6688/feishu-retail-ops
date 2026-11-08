'use strict';

/**
 * 库存操作的用户可见文案（配置先行：服务层不写死中文）。
 */
const stateLabel = (states = [], liveInventoryTableName = '实时库存') => (
  Array.isArray(states) && (states.includes('') || states.includes(null) || states.includes('*'))
    ? String(liveInventoryTableName || '实时库存')
    : `${states.join('和')}库存`
);

const stockShortage = ({ states, liveInventoryTableName, productRecordId, size, quantity, currentQuantity }) => (
  `${stateLabel(states, liveInventoryTableName)}不足：${productRecordId} ${size}码，需 ${quantity} 双，现有 ${currentQuantity} 双`
);

module.exports = { stockShortage, stateLabel };
