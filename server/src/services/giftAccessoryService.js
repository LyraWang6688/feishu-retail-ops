'use strict';

/**
 * 「其他配品」里勾选了「配品」的候选清单（资金页赠品下拉）。
 *
 * 口径（2026-11-11）：赠品候选只缓存「配品 = true」的记录，未勾选的不进入
 * 赠品缓存；缓存仍走统一 configTableCache（24h TTL、lastGood），
 * 「其他配品」record_changed 时同时失效 `giftAccessory`。
 *
 * 只读：本模块不写飞书。
 */
const { getConfigRows } = require('./configTableCache');
const { textValue } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { logWarn } = require('../utils/logger');

const createGiftAccessoryService = ({ gateway, table: tableOverride } = {}) => {
  if (!gateway) throw new Error('giftAccessoryService 需要 gateway');
  const table = tableOverride || V1_BITABLE_SCHEMA.tables.accessory;
  const enabled = Boolean(table?.tableId && table?.fields?.isAccessory);

  const list = async () => {
    if (!enabled) return [];
    try {
      const records = await getConfigRows({
        gateway,
        tableKey: 'giftAccessory',
        loader: async () => {
          const all = await gateway.listAll('accessory');
          return (all || []).filter((record) => record?.fields?.[table.fields.isAccessory] === true);
        },
      });
      return (records || []).map((record) => ({
        record_id: record.record_id,
        name: textValue(record.fields?.[table.fields.name]).trim(),
        category: textValue(record.fields?.[table.fields.category]).trim(),
      })).filter((item) => item.name);
    } catch (error) {
      logWarn('workbench.accessories.gift_options_failed', {
        error: String(error?.message || error).slice(0, 200),
      });
      return [];
    }
  };

  return { list };
};

module.exports = { createGiftAccessoryService };
