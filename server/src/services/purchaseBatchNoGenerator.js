const { textValue } = require('./v1BitableGateway');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const {
  resolvePurchaseBatchNoConfig,
  escapeRegExp,
  formatBatchDate,
} = require('../config/purchaseBatchNo');
const { logInfo, logWarn } = require('../utils/logger');

// 「报货批次号」的**生成器**（业务负责人 2026-10-07 拍板）。
//
// 她的口径（逐字）：
//   「我们之前的**报货批次号是用手工填写的，后续要改为由后端代码来填写**」
//   「**就不会让用户自己填了，自动生成就可以了**」
// 格式样例：**`CGD-20261007-0003`**（前缀 + 上海日期 + 4 位补零序号，每天归零）。
//
// ── 三条设计约束（都不是随手写的）────────────────────────────────────────────
//
// ① **序号从哪数**：只数「**同前缀 + 同一天 + 后接正好 N 位数字**」的号，取 **max+1**
//    —— **不是"条数 + 1"**。她表里今天已有的旧号（`202610071` / `202610072`，手填的纯数字）
//    **不匹配、不参与**，所以今天下一个新号仍然是 `CGD-20261007-0001`。
//    取 max+1 而不是条数+1 还有一个好处：中间有空洞（例如某号作废）也不会撞号。
//
// ② **两张表求并集**（`信息填写` ＋ `报货批次`）：
//    · 入口写回把号写在「信息填写」那一列；
//    · 出单时把同一个号写进「报货批次」；
//    · 而"入口写回失败"的兜底路径只在「报货批次」有号。
//    ⇒ **只数其中一张表都会漏**，漏了就会撞号（尤其**采购退货也会消耗号**：
//      只数「报货批次」时，退货占掉的号下一次报货会再发一遍）。
//
// ③ **并发保护不能照抄销售**：销售的判据是"同一个号出现两次 = 撞号"，而采购
//    **一个号天然对应 N 条记录**（一次提交 N 个货品），照抄会把正常的 N 条误报成撞号。
//    这里用 `KeyedSerialQueue` 把"算号 + 写回"串起来（PM2 单实例，进程内串行即可）。
//    另外本进程内再留一份 `assigned` 集合：万一串行保护被绕过（多实例 / 手滑），
//    也**不会**把同一个号发第二遍，而是重算并记 `purchase.batch_no.collision`。
class PurchaseBatchNoGenerator {
  constructor({ gateway, settings, now, queue } = {}) {
    if (!gateway) throw new Error('PurchaseBatchNoGenerator 需要 gateway');
    this.gateway = gateway;
    // 配置在构造时读一次（app.js 启动时构造）——写错要在服务起来的那一刻就吵。
    this.settings = settings || resolvePurchaseBatchNoConfig();
    this.now = now || (() => new Date());
    this.queue = queue || new KeyedSerialQueue();
    // 本进程发出去过的号（防"串行被绕过"的第二道）。
    this.assigned = new Set();
  }

  /** 串行键：算号 + 写回必须整体互斥（见文件头 ③）。 */
  static get QUEUE_KEY() {
    return 'purchase_report_batch_no';
  }

  /** 今天的日期部分（上海时区，见 config/purchaseBatchNo）。 */
  todayPart(date = this.now()) {
    return formatBatchDate(date, this.settings);
  }

  /**
   * 「同前缀 + 同一天 + 正好 N 位」的匹配式。**锚定**两端：
   * `202610071`（9 位纯数字）与 `CGD-20261007-00012`（5 位）都不匹配。
   */
  patternFor(datePart) {
    const { prefix, digits } = this.settings;
    return new RegExp(`^${escapeRegExp(prefix)}${escapeRegExp(datePart)}-(\\d{${digits}})$`);
  }

  /** 把两张表里符合"今天 + 本前缀 + 正好 N 位"的号都收上来（含所在表，便于排查）。 */
  async collectTodayNumbers(datePart) {
    const pattern = this.patternFor(datePart);
    const found = [];
    const sources = [
      ['purchaseOrderBatch', (table) => table?.fields?.batchNo],
      ['purchaseReport', (table) => table?.fields?.batchNoText],
    ];
    for (const [tableKey, fieldOf] of sources) {
      const fieldName = fieldOf(this.gateway.table(tableKey));
      if (!fieldName) continue;
      const records = await this.gateway.listAll(tableKey);
      for (const record of records || []) {
        const value = textValue(record?.fields?.[fieldName]);
        if (pattern.test(value)) found.push({ batchNo: value, tableKey, recordId: record?.record_id || '' });
      }
    }
    return found;
  }

  /**
   * 取下一个号。**只负责算号**（写回由调用方在同一个串行块里做，见 PurchaseWebhookService）。
   *
   * @param {{ source?: string, taskId?: string }} options
   *   `source` 只进日志：`intake`（入口按包生成）/ `fallback`（入口写回失败后的兜底）。
   * @returns {Promise<{ batchNo: string, sequence: number, todayCount: number, attempts: number, datePart: string }>}
   */
  async next({ source = 'intake', taskId = '' } = {}) {
    const datePart = this.todayPart();
    const existing = await this.collectTodayNumbers(datePart);
    const pattern = this.patternFor(datePart);
    const todayCount = existing.length;
    let max = 0;
    for (const item of existing) {
      const match = item.batchNo.match(pattern);
      if (match) max = Math.max(max, Number(match[1]));
    }
    let attempts = 1;
    let sequence = max + 1;
    let batchNo = this.compose(datePart, sequence);
    // ⚠️ 第二道：本进程内同一个号绝不发第二遍（见文件头 ③）。
    // 正常路径永远进不来（串行 + max+1）；进来就说明有人绕过了串行（多实例 / 手滑）。
    while (this.assigned.has(batchNo) && attempts <= 5) {
      logWarn('purchase.batch_no.collision', {
        batch_no: batchNo, sequence, today_count: todayCount, task_id: taskId || undefined,
        source, attempts, reason: 'already_assigned_in_process',
      });
      attempts += 1;
      sequence += 1;
      batchNo = this.compose(datePart, sequence);
    }
    this.assigned.add(batchNo);
    logInfo('purchase.batch_no.generated', {
      batch_no: batchNo,
      sequence,
      today_count: todayCount,
      // `task_id` 拿不到就不传（`correlationFields` 那套白名单会丢掉空值，这里显式写成 undefined）。
      task_id: taskId || undefined,
      source,
      attempts,
      date_part: datePart,
    });
    return { batchNo, sequence, todayCount, attempts, datePart };
  }

  compose(datePart, sequence) {
    const { prefix, digits } = this.settings;
    return `${prefix}${datePart}-${String(sequence).padStart(digits, '0')}`;
  }

  /** 在串行队列里跑一段"算号 + 写回"（见文件头 ③）。 */
  runExclusive(work) {
    return this.queue.run(PurchaseBatchNoGenerator.QUEUE_KEY, work);
  }
}

module.exports = { PurchaseBatchNoGenerator };
