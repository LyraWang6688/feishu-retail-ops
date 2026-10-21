/**
 * 销售主表建单 + 单号分配 + 配品清单（**共享处理层**）。
 *
 * 为什么把这三个方法从 `larkMvpService` 剥出来（2026-10-11 清群聊入口 C0）：
 *   · 它们**只有 `this.gateway` 一个依赖**（`createSalesEntryWithOrderNo` 只用到
 *     `this.gateway` 与 `this.listSalesOrderNos`），与"群消息 / 话题 / AI 解析"毫无关系；
 *   · 但**扫码页在用它们** —— `scanWriteService` 建单（sales）与配品下拉（listAccessories）
 *     都是借 `LarkMvpService.prototype.xxx.call({ gateway })` 调的；
 *   · 群入口层要被整体删掉，如果它们还长在 `LarkMvpService` 上，扫码页就被"群聊入口"
 *     绑住了 —— 删群入口会连扫码一起删掉。剥出来之后：**删入口不影响扫码**。
 *
 * ⚠️ 这里的每一行都从 `larkMvpService` **原样搬过来**（含注释与日志事件名），
 *    行为一个字都没改。`larkMvpService` 里保留同名薄方法转发到这里，
 *    等群入口那几条调用点退场后再删（见 C3/C4）。
 *
 * 🔴 这个文件属于**共享处理层**（`docs/entry-isolation-2026-10-08.md` 第 2 节）：
 *    群聊入口与扫码入口**都**该走这里；不许在入口层另写一套建单 / 单号逻辑。
 */
const { textValue } = require('./v1BitableGateway');
const { person } = require('./v1ReferenceResolver');
const { withSalesReadRetry } = require('./salesReadRetry');
const { allocateSalesOrderNo } = require('./salesOrderNo');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
const { logInfo, logWarn } = require('../utils/logger');
const { mergeCorrelation } = require('../utils/correlationFields');

/**
 * 「销售主表 · 销售单号」这一列的现有取值（只读；读不到映射时返回空列表）。
 *
 * 字段映射缺失时读不到号；此时返回空列表，后续写单号会因
 *「未配置语义字段: orderNo」直接报错，而不是静默写一个空号。
 *
 * @param {{gateway: object}} receiver
 * @returns {Promise<string[]>}
 */
const listSalesOrderNos = async ({ gateway } = {}) => {
  const field = gateway.table?.('salesEntry')?.fields?.orderNo;
  if (!field) return [];
  const records = await withSalesReadRetry(
    () => gateway.listAll('salesEntry'), 'sales_order_no_list',
  );
  return records.map((record) => textValue(record.fields?.[field])).filter(Boolean);
};

/**
 * 创建销售主表记录，并在**同一处**生成 + 写入「销售单号」。
 *
 * 为什么集中在这一处：这是全仓库唯一创建销售主表记录的地方（退货/换货不建新单，
 * 它们沿用原销售单号）。单号只在这里生成一次，规则就不会散成两套；
 * 以后新增入口也必须走这里，否则又会回到"飞书不生成、代码也不生成"的空号状态。
 *
 * 为什么拿了号才建记录、撞号时改自己这条：createSalesEntryWithOrderNo 内部
 * 由 allocateSalesOrderNo 负责"读→算→写→写后复查"；真撞上并发时它会把号 +1 后
 * update 回**同一条**记录，不留下第二条记录，也不给退货/换货留下两个同号的"原单"。
 *
 * @param {{gateway: object}} receiver
 * @param {{task_id?: string, sender_open_id?: string}} task
 * @returns {Promise<{recordId: string}|null>}
 */
const createSalesEntryWithOrderNo = async ({ gateway } = {}, task = {}, options = {}) => {
  const correlation = mergeCorrelation(options.correlation, { task_id: task.task_id });
  let created = null;
  const allocation = await allocateSalesOrderNo({
    readExistingNos: () => listSalesOrderNos({ gateway }),
    writeOrderNo: async (orderNo) => {
      if (created) {
        await gateway.update('salesEntry', created.recordId, { orderNo }, { correlation });
        return;
      }
      created = await gateway.create('salesEntry', {
        // ⚠️ 2026-10-09：原话（`originalText`）与解析状态（`parseStatus='解析中'`）**不再写** ——
        //    这两列被业务负责人从生产「销售主表」里删掉了（她的口径：「我们要用扫码」、
        //    「解析状态就是我们对于原话的解析」）。映射与写入点**一起删**，见
        //    `config/v1BitableSchema.js` 的 `salesEntry` 段。
        //    ⚠️ `task.original_text`（**本地**任务里她那句话）照旧留着：解析要读它、
        //      缺项文案要读它；只是**不再落业务表**。
        sender: person(task.sender_open_id),
        // ⭐ 2026-10-18：建单 = 流程还没走完（还没到资金页提交/批量写入）⇒「写入状态=未完成」。
        //   成功/部分失败/失败由最终收口写（scanWriteService / afterSalesService）。
        writeStatus: WRITE.writeStatus.pending,
        orderNo,
      }, { correlation });
    },
    onCollision: ({ attempt, order_no: orderNo }) =>
      logWarn('sales.order_no.collision', { ...correlation, task_id: task.task_id, attempt, order_no: orderNo }),
  });
  logInfo('sales.order_no.generated', {
    ...correlation,
    task_id: task.task_id,
    sales_entry_record_id: created?.recordId,
    order_no: allocation.orderNo,
    sequence: allocation.sequence,
    // 当天已有单号的条数（只数「日期段 == 今天」的）：排查"这个号从哪来"时看它。
    today_count: allocation.todayCount,
    attempts: allocation.attempts,
  });
  return created;
};

/**
 * 「其他配品」清单。没配置这张表时返回空——那种部署下销售只支持鞋，
 * 配品说法会被当成未知货号处理，而不是报配置错误。
 *
 * @param {{gateway: object}} receiver
 * @returns {Promise<Array<{record_id: string, name: string, category: string}>>}
 */
const listAccessories = async ({ gateway } = {}) => {
  const table = gateway.table?.('accessory');
  if (!table?.tableId) return [];
  try {
    const records = await gateway.listAll('accessory');
    return records
      .map((record) => ({
        record_id: record.record_id,
        name: textValue(record.fields?.[table.fields.name]).trim(),
        // 「种类」是配品的品类（鞋油、腰带…），用户嘴里说的通常就是它。
        // 单选字段读回来是数组，textValue 会归一成「鞋油」这样的字符串。
        // 部署里没配这个字段映射（或某条没填）时留空：那种情况下只按名称匹配，
        // 与改动前的行为完全一致，不会因为缺分类就匹配失败。
        category: table.fields.category
          ? textValue(record.fields?.[table.fields.category]).trim()
          : '',
      }))
      .filter((item) => item.name);
  } catch (error) {
    logWarn('lark.sales.accessory.list_failed', { error: error.message });
    return [];
  }
};

module.exports = {
  listSalesOrderNos,
  createSalesEntryWithOrderNo,
  listAccessories,
};
