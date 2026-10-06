// 「销售主表」四个状态字段的**唯一写入口**。
//
// 为什么要单独一个 service（模块化 / 解耦 / 配置先行）：
//   · 四个字段的**名字**在 config/salesStatusDimensions（SALES_STATUS_FIELDS）；
//   · 代码要**写**的值也在同一个配置文件（SALES_STATUS_WRITE_VALUES）——
//     所以「值域改了」「字段改名了」都只改配置，不动任何 service；
//   · **谁、在什么时候**写哪一列，仍由调用点决定（本类不猜业务顺序）。
//
// 🔴 一条硬边界：**状态列写失败绝不允许影响业务写入**。
//    这四列是"给人看的进度"，写不上去只记一条 warning（可排查），
//    绝不能让"记进度"把"记账/扣库存"带崩——顺序上它们是同一笔业务的
//    两个部分，但只有后者是业务事实。
const { logInfo, logWarn } = require('../utils/logger');

// 允许写的语义键（= v1BitableSchema.tables.salesEntry.fields 里的键名）。
// 白名单式：写错键名（例如把 funds 写成 legacyConfirm）当场被挡下，
// 不会静默写到"另一个同名字段"上去。
const STATUS_KEYS = Object.freeze(['userAction', 'sales', 'funds', 'stock']);

class SalesStatusWriter {
  constructor({ gateway } = {}) {
    if (!gateway) throw new Error('SalesStatusWriter requires gateway');
    this.gateway = gateway;
  }

  /**
   * 写一个或多个状态维度。
   *
   * @param {string} salesEntryRecordId 销售主表 record_id
   * @param {object} values 例：`{ userAction: '已确认', funds: '已写入' }`
   * @returns {Promise<boolean>} 是否真的写成功（失败只记日志，不抛）
   */
  async write(salesEntryRecordId, values = {}) {
    const recordId = String(salesEntryRecordId || '').trim();
    const payload = {};
    for (const key of STATUS_KEYS) {
      const value = values[key];
      // 空值 = "这一维这次不写"，不是"把它清空"：清空会让读那一侧的
      // 「新字段优先、空则退回旧字段」误判成"还没写过"。
      if (value === undefined || value === null || value === '') continue;
      payload[key] = value;
    }
    const keys = Object.keys(payload);
    if (!recordId || !keys.length) return false;
    try {
      await this.gateway.update('salesEntry', recordId, payload);
      logInfo('sales.status.written', { sales_entry_record_id: recordId, dimensions: keys });
      return true;
    } catch (error) {
      logWarn('sales.status.write_failed', {
        sales_entry_record_id: recordId, dimensions: keys, error: error.message,
      });
      return false;
    }
  }
}

module.exports = { SalesStatusWriter, STATUS_KEYS };
