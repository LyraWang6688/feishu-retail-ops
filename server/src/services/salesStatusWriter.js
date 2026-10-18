// 「销售主表」写入状态的**唯一写入口**。
//
// ⭐ 2026-10-18（业务负责人改表）：四个状态列（确认/销售/资金/库存）已删除，
//   统一换成「写入状态」（成功 / 失败 / 部分失败 / 未完成）。
//   · 建单时写「未完成」；
//   · 最终收口（批量写入成功/部分失败/失败）时再写一次；
//   · **旧维度写入（userAction/sales/funds/stock）一律忽略**（那四列已不存在）。
//
// 🔴 一条硬边界：**状态列写失败绝不允许影响业务写入**。
//    写不上去只记一条 warning（可排查），绝不能让"记进度"把"记账/扣库存"带崩。
const { logInfo, logWarn } = require('../utils/logger');
const { correlationFields } = require('../utils/correlationFields');
const {
  SALES_STATUS_WRITE_VALUES: WRITE,
  WRITE_STATUS_VALUES,
} = require('../config/salesStatusDimensions');

const STATUS_KEY = 'writeStatus';
const STATUS_KEYS = Object.freeze([STATUS_KEY]);

class SalesStatusWriter {
  constructor({ gateway } = {}) {
    if (!gateway) throw new Error('SalesStatusWriter requires gateway');
    this.gateway = gateway;
  }

  /**
   * 写「写入状态」。
   * @param {string} salesEntryRecordId 销售主表 record_id
   * @param {object} values `{ writeStatus: '成功' }`（旧维度键会被忽略）
   * @param {object} [correlation] 只进日志
   * @returns {Promise<boolean>} 是否真的写成功（失败只记日志，不抛）
   */
  async write(salesEntryRecordId, values = {}, correlation = {}) {
    const recordId = String(salesEntryRecordId || '').trim();
    const raw = values?.[STATUS_KEY];
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!recordId || !value) return false;
    if (!WRITE_STATUS_VALUES.includes(value)) {
      logWarn('sales.status.write_failed', {
        sales_entry_record_id: recordId,
        error: `写入状态值不在值域内：${value}`,
      });
      return false;
    }
    const context = correlationFields(correlation);
    try {
      await this.gateway.update('salesEntry', recordId, { [STATUS_KEY]: value }, { correlation });
      logInfo('sales.status.written', {
        sales_entry_record_id: recordId, dimensions: ['writeStatus'], value, ...context,
      });
      return true;
    } catch (error) {
      logWarn('sales.status.write_failed', {
        sales_entry_record_id: recordId, dimensions: ['writeStatus'],
        error: error.message, ...context,
      });
      return false;
    }
  }

  /** 建单时写「未完成」。 */
  writePending(recordId, correlation = {}) {
    return this.write(recordId, { writeStatus: WRITE.writeStatus.pending }, correlation);
  }

  /** 收口：成功 / 部分失败 / 失败。 */
  writeFinal(recordId, status, correlation = {}) {
    const allowed = [WRITE.writeStatus.done, WRITE.writeStatus.partial, WRITE.writeStatus.failed];
    if (!allowed.includes(status)) {
      return Promise.resolve(false);
    }
    return this.write(recordId, { writeStatus: status }, correlation);
  }
}

module.exports = { SalesStatusWriter, STATUS_KEYS };
