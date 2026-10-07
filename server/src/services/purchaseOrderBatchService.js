const { textValue } = require('./v1BitableGateway');
const {
  resolvePurchaseArrivalStatusConfig,
} = require('../config/purchaseArrivalStatus');
const {
  resolvePurchaseAcceptanceConfig,
} = require('../config/purchaseAcceptance');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { logInfo, logWarn } = require('../utils/logger');

// 「报货批次」**那一行**的读写（业务负责人 2026-10-07 把它定为"控制到货情况"的表）。
//
// 它只管这几件事，一件都不多：
//   · 按「报货批次号」把那一行**找出来**；
//   · **退货**批次也建那一行（2026-10-07 晚口径变更：只写 批次号 + 幂等键，
//     **不写「到货状态」** ⇒ 不进 9 点推送的「未到货」候选）；
//   · 到货状态（报货新建 = 未到货 / 到货确认成功 = 已到货）；
//   · 「单据」附件（出图之后把采购申请单 / 采购退货单的 PNG 回填到这里）；
//   · ⭐ **到货核对的落点**（2026-10-07 晚）：「验收原话」＋「确认状态」——
//     原来写在**已被业务负责人删除的**「到货验收」表那一行，现在写到这里。
//
// ⚠️ 「采购行为」这一列**此刻意不读、不写、不映射**（她的原话：
//    「报货批次里面的采购行为你不用管」）—— 不碰它就不可能"顺手"写坏它。
//
// ⚠️ 「到货日」「验收人」**不在这个 service 的读写范围里**：它们在真表上是飞书
//    **自动字段**（更新时间 / 创建人），代码一律不写（写了会被自动覆盖或直接报错）。
//
// ⚠️ 为什么单独一个 service（AGENTS.md《底层工程原则》的「模块化」）：
//    `PurchaseWebhookService` 已经背了"报货 → 出单 → 出图 → 发群"整条链路；
//    批次行怎么维护是另一件事，将来还会被 9 点推送 / 到货核对复用。
//
// ⚠️ 取值**不写死中文**：到货状态两个值来自 `config/purchaseArrivalStatus.js`
//    （并由部署闸门对着真表 `property.options` 核对 —— 往单选里写不存在的取值，
//    飞书会自动新建选项、把表污染掉，而 9 点推送按「未到货」查就静默查不到了）；
//    确认状态来自 `config/purchaseAcceptance.js`。

/**
 * 「报货批次」那一行的幂等键（业务负责人 2026-10-07 晚：「退货也落到报货批次表里」）。
 *
 * 与**报货那条同族**（同一个前缀 `purchase_batch:`，见 `ensurePostingPlan` 的
 * `batch_key`），但**身份取批次号**，不是 task_id：
 *   · 报货那条的键是 `purchase_batch:<批次 task_id>`——那一批的 task 是**冻结**的
 *     （`posting_plan` 落盘在它身上），所以取 task_id 也稳；
 *   · 退货这边不一样：一个退货批次重试时**领头的那条记录可能换人**
 *     （先投递 A 还是 B 不由我们定），取 task_id 会算出**另一个键**、给同一个批次
 *     多建一行；**批次号才是这一包的稳定身份**（归批键就是它）。
 */
const purchaseBatchRowKey = (batchNo) => `purchase_batch:${String(batchNo || '').trim()}`;

/** 附件单元格 → file_token 列表（飞书 GET 回来是 `[{ file_token, name }]`）。 */
const attachmentTokens = (value) => (Array.isArray(value) ? value : [])
  .map((item) => item?.file_token || item?.fileToken || item?.token || '')
  .filter(Boolean);

/** 附件单元格 → 文件名列表（用来判"这一张图是不是已经写过了"）。 */
const attachmentNames = (value) => (Array.isArray(value) ? value : [])
  .map((item) => String(item?.name || ''))
  .filter(Boolean);

class PurchaseOrderBatchService {
  constructor({ gateway, settings, acceptance } = {}) {
    if (!gateway) throw new Error('PurchaseOrderBatchService 需要 gateway');
    this.gateway = gateway;
    // 配置读一次（启动时）：取值写错要在服务起来那一刻就吵，而不是等她第一次提交报单。
    this.settings = settings || resolvePurchaseArrivalStatusConfig();
    this.acceptance = acceptance || resolvePurchaseAcceptanceConfig();
  }

  /** 新建批次记录时要写的那个取值（她说的字段默认值「未到货」）。 */
  get pendingStatus() {
    return this.settings.pending;
  }

  /**
   * **退货**批次也建那一行（业务负责人 2026-10-07 晚的口径变更，逐字：
   *   「为什么退货批次不可以像申请一样，也自动生成呢？并且也落到报货批次表里呢？
   *     …如果退货申请也要落到报货批次的话，那么到货状态，就需要你在报货的时候，写入未到货，
   *     然后**退货，不用写**」）。
   *
   * 只写两样：**报货批次号 + 幂等键**。
   * 🔴 **刻意不写「到货状态」**（`arrivalStatus` 这个语义键**不进 values**）——
   *    留空 ⇒ 每天 9 点那条推送（只认字面量「未到货」）**看不见退货批次**。
   *    ⚠️ **不许"顺手写个空串"**：往单选里写空串同样是往表里塞东西，
   *       而且一旦哪天有人把空串当取值，飞书就会多出一个空选项。
   *
   * 幂等：**两步** ——
   *   ① **先按批次号回查**（`findByBatchNo`）：命中就**原样复用**那一行
   *      （同一批已经在「报货批次」里了，例如同一包里的"采购申请"那半边先建过）；
   *   ② 没有才 `createOnceByKey`，键 = `purchase_batch:<批次号>`
   *      （与报货那条**同族**，见 `purchaseBatchRowKey` 的说明）。
   *   ⇒ 重投 / 重试拿到的是**同一行**，同一批不会出现两行。
   */
  async createForReturnBatch(batchNo, { correlation = {} } = {}) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) {
      // 没有号就**不编**（旧数据 / 入口写回失败那条路）：调用方自己决定怎么提示。
      return { created: false, reason: 'no_batch_no', batch_no: '' };
    }
    const key = purchaseBatchRowKey(wanted);
    // ⚠️ **先按批次号回查一次**：一次提交里**混着"采购申请"和"采购退货"**时，
    //    两边的归批是**两个批次**（各自一个处理者），但**批次号是同一个**
    //    （号在入口按包生成、写在每一条记录上）。
    //    只按幂等键回查的话，报货那条用 `purchase_batch:<它的 task_id>`、
    //    退货这条用 `purchase_batch:<批次号>` —— 两个键**互相看不见**，
    //    同一批就会多出一行（她的表里一个批次号出现两行）。
    //    ⇒ 「一批一行」由这一步保证；命中就**原样复用**那一行
    //    （**绝不改它的「到货状态」**：报货行该是「未到货」就还是「未到货」）。
    const existing = await this.findByBatchNo(wanted);
    if (existing) {
      logInfo('purchase.return.batch.record_ensured', {
        batch_no: wanted,
        batch_record_id: existing.record_id,
        reused: true,
        idempotency_key: textValue(existing.fields?.[this.gateway.table('purchaseOrderBatch')?.fields?.idempotencyKey]),
        matched_by: 'batch_no',
      });
      return {
        created: false,
        reused: true,
        recordId: existing.record_id,
        batch_no: wanted,
        idempotency_key: key,
      };
    }
    const batch = await createOnceByKey({
      gateway: this.gateway,
      tableKey: 'purchaseOrderBatch',
      keyField: IDEMPOTENCY_KEY_FIELD,
      keyValue: key,
      label: `退货批次 ${wanted}`,
      correlation,
      // ⚠️ 只有这两列。**没有** arrivalStatus（见上面的 🔴）。
      values: { batchNo: wanted, idempotencyKey: key },
    });
    logInfo('purchase.return.batch.record_ensured', {
      batch_no: wanted,
      batch_record_id: batch.recordId,
      reused: batch.reused === true,
      idempotency_key: key,
    });
    return {
      created: true,
      reused: batch.reused === true,
      recordId: batch.recordId,
      batch_no: wanted,
      idempotency_key: key,
    };
  }

  /** 到货核对确认成功之后要写的那个取值。 */
  get arrivedStatus() {
    return this.settings.arrived;
  }

  /**
   * 按「报货批次号」找那一行。
   *
   * 为什么整表读而不是按某列查：飞书的 `appTableRecord.search` 需要额外的
   * "字段索引"配置，而这张表是**每天几十行**量级的小表 —— 整表读一次既简单又稳。
   * 找不到就返回 null（调用方各自决定是 warn 还是抛）。
   */
  async findByBatchNo(batchNo) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) return null;
    const table = this.gateway.table('purchaseOrderBatch');
    const field = table?.fields?.batchNo;
    if (!field) return null;
    const records = await this.gateway.listAll('purchaseOrderBatch');
    return (records || []).find(
      (record) => textValue(record?.fields?.[field]).trim() === wanted,
    ) || null;
  }

  /**
   * 到货核对**确认成功之后**：把这一批的到货状态改成「已到货」。
   *
   * ⚠️ 调用方必须把它当**增强**：入库事实已经落地，这一步失败**不能**把整单判失败
   *    （与"附件写失败不阻塞主流程"同一条纪律）。所以这里只把错误往上抛给调用方
   *    去 catch + warn，自己**不吞**（吞掉的话调用方连日志都写不了）。
   */
  async markArrived(batchNo, { correlation = {} } = {}) {
    return this.setArrivalStatus(batchNo, this.arrivedStatus, { correlation, event: 'purchase.batch.arrival_status.arrived' });
  }

  /** 建批次记录之后（或任何需要时）显式写「未到货」。 */
  async markPending(batchNo, { correlation = {} } = {}) {
    return this.setArrivalStatus(batchNo, this.pendingStatus, { correlation, event: 'purchase.batch.arrival_status.pending' });
  }

  async setArrivalStatus(batchNo, status, { correlation = {}, event = '' } = {}) {
    const record = await this.findByBatchNo(batchNo);
    if (!record) {
      logWarn('purchase.batch.arrival_status.no_record', { batch_no: batchNo, status });
      return { updated: false, reason: 'no_batch_record', batch_no: batchNo };
    }
    await this.gateway.update('purchaseOrderBatch', record.record_id, { arrivalStatus: status }, { correlation });
    logInfo(event || 'purchase.batch.arrival_status.updated', {
      batch_no: batchNo, record_id: record.record_id, arrival_status: status,
    });
    return { updated: true, record_id: record.record_id, batch_no: batchNo, arrival_status: status };
  }

  // ── 到货核对的落点（2026-10-07 晚：从已删除的「到货验收」表搬到这里）───────────

  /** 到货核对**确认成功之后**要写的那个取值（配置来的，不是中文字面量）。 */
  get confirmedStatus() {
    return this.acceptance.confirmed;
  }

  /**
   * 定位这一批在「报货批次」里的**那一行**。
   *
   * 优先用**批次 record id**（调用方从采购申请行的「报货批次号」关联上读到的，最准、零额外请求）；
   * 拿不到才按**批次号**整表回查（`findByBatchNo`）。
   *
   * @returns {Promise<{record_id: string, matched_by: 'record_id'|'batch_no'}|null>}
   */
  async locate({ batchNo = '', batchRecordId = '' } = {}) {
    const wantedId = String(batchRecordId || '').trim();
    if (wantedId) return { record_id: wantedId, matched_by: 'record_id' };
    const record = await this.findByBatchNo(batchNo);
    return record ? { record_id: record.record_id, matched_by: 'batch_no' } : null;
  }

  /**
   * ⭐ 把「验收原话」写到这一批的批次行上（**到货确认的第一步**，在入库之前）。
   *
   * 为什么要单独一步、而且在入库之前：
   *   · 她的口径是"到货信息的落点搬到报货批次"——原话是这次核对**唯一的人工输入**，
   *     先落上，后续入库失败重试时也不用她再说一遍；
   *   · 「确认状态」刻意**不在这里**写（见 `markConfirmed`）：入库才是事实，
   *     确认状态是它的投影，两处都写早晚会写歪。
   *
   * 幂等：写的是同一个文本值，重复执行结果一致（不新建行）。
   *
   * @returns {Promise<{updated: boolean, record_id?: string, reason?: string, matched_by?: string}>}
   *   找不到批次行时**返回 updated:false**（不抛）——调用方决定要不要因此中断（当前会中断，
   *   因为"到货信息没有落点"等于她这次确认没被记下来）。
   */
  async writeAcceptance({
    batchNo = '', batchRecordId = '', acceptanceText = '', correlation = {},
  }) {
    const text = String(acceptanceText == null ? '' : acceptanceText);
    // 没有批次身份（两个都空）= "孤儿调用"（历史草稿 / 手工种的测试任务）：
    // 明确区分于"有身份但找不到行"，调用方对两者的处置不同（前者不阻塞、后者要报）。
    if (!String(batchNo || '').trim() && !String(batchRecordId || '').trim()) {
      return { updated: false, reason: 'no_batch_identity', batch_no: '' };
    }
    const target = await this.locate({ batchNo, batchRecordId });
    if (!target) {
      logWarn('purchase.batch.acceptance.no_record', { batch_no: batchNo, batch_record_id: batchRecordId });
      return { updated: false, reason: 'no_batch_record', batch_no: batchNo };
    }
    await this.gateway.update('purchaseOrderBatch', target.record_id, { acceptanceText: text }, { correlation });
    logInfo('purchase.batch.acceptance_text.written', {
      batch_no: batchNo,
      batch_record_id: target.record_id,
      matched_by: target.matched_by,
      acceptance_text_length: text.length,
      // 明写"没写到货日 / 验收人"：这是口径，也是将来别人改这段代码时的绊线
      //（两者在真表上是飞书自动字段：到货日=更新时间、验收人=创建人）。
      wrote_arrival_date: false,
      wrote_inspector: false,
    });
    return { updated: true, record_id: target.record_id, matched_by: target.matched_by, batch_no: batchNo };
  }

  /**
   * ⭐ 入库成功之后：把这一批的「确认状态」改成「已确认」（取值来自 config）。
   *
   * ⚠️ 与 `markArrived`（到货状态）是**两列两件事**：
   *    · 「确认状态」= 这次**核对**确认过（文本列，配置在 `config/purchaseAcceptance.js`）；
   *    · 「到货状态」= 这一批**到货了**（单选列，配置在 `config/purchaseArrivalStatus.js`）。
   *
   * ⚠️ 语义与改动前**逐字一致**：改动前这一句是
   *    `gateway.update('purchaseArrival', … , { confirmStatus: '已确认' })`，
   *    位于入库循环**之后**；那时若它抛错，整次确认会失败、状态停在 `posting`、
   *    她再点一次「是」会重跑（入库本身有幂等兜底）。这里保持同一语义，只是换成批次行。
   *    找不到批次行时**返回 updated:false**（不抛）——与 `writeAcceptance` 同理。
   */
  async markConfirmed({ batchNo = '', batchRecordId = '', correlation = {} } = {}) {
    // 与 `writeAcceptance` 同形：没有批次身份 = 孤儿调用（不阻塞）；有身份找不到行 = 要报。
    if (!String(batchNo || '').trim() && !String(batchRecordId || '').trim()) {
      return { updated: false, reason: 'no_batch_identity', batch_no: '' };
    }
    const target = await this.locate({ batchNo, batchRecordId });
    if (!target) {
      logWarn('purchase.batch.confirm_status.no_record', { batch_no: batchNo, batch_record_id: batchRecordId });
      return { updated: false, reason: 'no_batch_record', batch_no: batchNo };
    }
    const status = this.confirmedStatus;
    await this.gateway.update('purchaseOrderBatch', target.record_id, { confirmStatus: status }, { correlation });
    logInfo('purchase.batch.confirm_status.updated', {
      batch_no: batchNo,
      batch_record_id: target.record_id,
      matched_by: target.matched_by,
      confirm_status: status,
    });
    return { updated: true, record_id: target.record_id, batch_no: batchNo, confirm_status: status };
  }

  /**
   * 「这一批的「单据」里是不是已经有这张图了」——**上传之前**先问一次。
   *
   * 为什么单列一个前置判据（而不是只在 `writeDocument` 里判）：被替换掉的
   * `writeSupplierImageAttachment` 的既有语义是「重复执行**连上传都不做**」。
   * 只在写完再判的话，第二次执行会白传一次素材（真金白银的一次飞书调用），
   * 而"上传"这一步在生产上还会因为缺 `im:resource` 权限而失败——那就把一次
   * **本该跳过的重复执行**变成了一条刺眼的失败日志。
   */
  async findDocument(batchNo, fileName = '') {
    const record = await this.findByBatchNo(batchNo);
    if (!record) return { found: false, recordId: '', exists: false, record: null };
    const field = this.gateway.table('purchaseOrderBatch')?.fields?.document;
    const cell = field ? record.fields?.[field] : undefined;
    return {
      found: true,
      recordId: record.record_id || '',
      exists: Boolean(fileName) && attachmentNames(cell).includes(fileName),
      record,
    };
  }

  /**
   * 把一张单据图（采购申请单 / 采购退货单 PNG）写进「报货批次」的「单据」。
   *
   * 规则（沿用被替换掉的 `writeSupplierImageAttachment` 的既有语义）：
   *   · **重复执行不得写出第二条** —— 同一批 + 同一个文件名已经在了就跳过（连上传都不做）；
   *   · 一批**多供应商**时各写各的图：**已有附件原样带上**再追加新的那张
   *     （飞书附件字段支持多个文件；只传新 token 会把别人的图冲掉）。
   *
   * ⚠️ 本方法**抛错**由调用方 catch（"失败不阻塞主流程"的既有行为不变）。
   */
  async writeDocument({
    batchNo, fileToken, fileName = '', correlation = {},
  }) {
    const table = this.gateway.table('purchaseOrderBatch');
    const field = table?.fields?.document;
    if (!field) throw new Error('「报货批次」未配置「单据」字段映射');
    const record = await this.findByBatchNo(batchNo);
    if (!record) {
      logWarn('purchase.batch.document.no_record', { batch_no: batchNo, file_name: fileName });
      return { written: false, reason: 'no_batch_record', batch_no: batchNo };
    }
    const cell = record.fields?.[field];
    const existingTokens = attachmentTokens(cell);
    if (fileName && attachmentNames(cell).includes(fileName)) {
      logInfo('purchase.batch.document.exists', {
        batch_no: batchNo, record_id: record.record_id, file_name: fileName,
      });
      return { written: false, skipped: true, record_id: record.record_id, batch_no: batchNo };
    }
    // ⚠️ **已有附件原样带上**：飞书附件字段在写入时以"这次给的列表"为准，
    //    只传新的那一个 token 会把同批其它供应商的图冲掉。
    const tokens = [...new Set([...existingTokens, fileToken])];
    await this.gateway.update('purchaseOrderBatch', record.record_id, {
      document: tokens.map((token) => ({ file_token: token })),
    }, { correlation });
    return {
      written: true,
      record_id: record.record_id,
      batch_no: batchNo,
      file_name: fileName,
      file_token: fileToken,
      document_count: tokens.length,
    };
  }
}

module.exports = {
  PurchaseOrderBatchService, attachmentTokens, attachmentNames, purchaseBatchRowKey,
};
