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
const { correlationFields } = require('../utils/correlationFields');

// 允许写的语义键（= v1BitableSchema.tables.salesEntry.fields 里的键名）。
// 白名单式：写错键名（例如把 funds 写成 founds）当场被挡下，
// 不会静默写到"另一个同名字段"上去。
// ⚠️ 旧字段（confirmStatus / orderStatus）不在白名单里，而且它们的映射已从 schema 删除
//    （业务负责人 2026-10-06 把这两列整列删掉）——旧字段彻底没有写入口。
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
   * @param {object} [correlation] 关联键（`task_id` / `order_no` / `sales_entry_record_id`）——
   *   只进日志，不改任何写入内容。`sales.status.written` 是"一条销售被劈成两半"里
   *   不带任何任务/单号的那半之一（2026-10-07 业务负责人拍板「日志改下吧！」）。
   * @returns {Promise<boolean>} 是否真的写成功（失败只记日志，不抛）
   */
  async write(salesEntryRecordId, values = {}, correlation = {}) {
    const recordId = String(salesEntryRecordId || '').trim();
    const payload = {};
    for (const key of STATUS_KEYS) {
      const value = values[key];
      // 空值 = "这一维这次不写"，不是"把它清空"。
      // ⚠️ 现在是**单读新字段**（旧字段那两列已被业务负责人删除，没有回退可言）：
      //    清空只会让这一维看起来"没有值"，没有任何补偿来源。
      if (value === undefined || value === null || value === '') continue;
      payload[key] = value;
    }
    const keys = Object.keys(payload);
    if (!recordId || !keys.length) return false;
    // 关联键只在日志里用；`correlationFields` 会把非白名单键与空值滤掉。
    const context = correlationFields(correlation);
    try {
      await this.gateway.update('salesEntry', recordId, payload, { correlation });
      logInfo('sales.status.written', { sales_entry_record_id: recordId, dimensions: keys, ...context });
      return true;
    } catch (error) {
      logWarn('sales.status.write_failed', {
        sales_entry_record_id: recordId, dimensions: keys, error: error.message, ...context,
      });
      return false;
    }
  }
}

module.exports = { SalesStatusWriter, STATUS_KEYS };
