// 把「销售主表」四个状态维度的**达成情况**写进飞书（配置见 config/salesStatusDimensions）。
//
// 为什么单独一个 service（而不是在每个调用点各写一行 gateway.update）：
//   · 值域校验只有一处（`assertStatusValue`）——**写错的值会永久留在飞书选项里**，
//     所以"值从哪来"必须收敛；
//   · 「写失败怎么算」只有一处口径：**不许静默**；
//   · 一次写入留一条 `sales.status.marked` 日志 = 她问「这一步到底做到没有」时的证据链。
//
// ⚠️ 四个维度写的都是**销售主表同一行的四个不同列**，彼此不覆盖（不是状态机的前后态，
//    所以不存在"后一个值盖掉前一个"的问题，可以各自独立地写、重试也幂等）。
//
// ⚠️ 幂等：`gateway.update` 写的是**确定值**（不是自增、不是时间），重复调用结果相同。

const {
  SALES_STATUS_FIELDS,
  assertStatusValue,
  dimensionFieldName,
  statusPatch,
} = require('../config/salesStatusDimensions');
const { logInfo, logWarn } = require('../utils/logger');

class SalesStatusService {
  constructor({ gateway } = {}) {
    if (!gateway) throw new Error('SalesStatusService requires gateway');
    this.gateway = gateway;
  }

  /**
   * 写一个维度。**失败会抛**（交给调用点决定：就地失败，还是降级成 markQuietly）。
   *
   * @param {string} salesEntryRecordId 销售主表记录 id
   * @param {'userAction'|'sales'|'funds'|'stock'} dimension 维度
   * @param {string} value 值域内的值（空串 = 不写，"留空"本身是合法状态）
   * @param {object} [context] 额外日志字段（task_id / 单号 之类，便于排查）
   */
  async mark(salesEntryRecordId, dimension, value, context = {}) {
    const next = assertStatusValue(dimension, value);
    if (!next) return { dimension, value: '' };
    if (!salesEntryRecordId) throw new Error(`写「${dimensionFieldName(dimension)}」缺少销售主表 record_id`);
    await this.gateway.update('salesEntry', salesEntryRecordId, statusPatch(dimension, next));
    logInfo('sales.status.marked', {
      sales_entry_record_id: salesEntryRecordId,
      dimension,
      // 字段名一起打出来：排查时不用再去翻配置。
      field: SALES_STATUS_FIELDS[dimension],
      value: next,
      ...context,
    });
    return { dimension, value: next };
  }

  /**
   * 同上，但**把"抛"降级成"记 warn 并返回 false"**。
   *
   * 用在"业务事实已经写成、状态列写不进去也不该把它整个判失败"的地方
   * （用户点确认 / 扣完库存 / 售后回补）。⚠️ 这不是静默：
   * 每次失败都会留一条 `sales.status.write_failed` 的 warn 日志。
   */
  async markQuietly(salesEntryRecordId, dimension, value, context = {}) {
    try {
      return await this.mark(salesEntryRecordId, dimension, value, context);
    } catch (error) {
      logWarn('sales.status.write_failed', {
        sales_entry_record_id: salesEntryRecordId,
        dimension,
        field: SALES_STATUS_FIELDS[dimension],
        value: String(value ?? ''),
        error: error.message,
        ...context,
      });
      return false;
    }
  }
}

module.exports = { SalesStatusService };
