const { textValue } = require('./v1BitableGateway');
const {
  resolvePurchaseArrivalStatusConfig,
} = require('../config/purchaseArrivalStatus');
const { IDEMPOTENCY_KEY_FIELD, createOnceByKey } = require('../infrastructure/idempotencyKey');
const { relation } = require('./v1ReferenceResolver');
const { batchQuantityFields } = require('../config/purchaseBatchQuantity');
const { logInfo, logWarn } = require('../utils/logger');

/**
 * 数字列的唯一判据（`undefined` / `null` / 空串 ⇒ `null` = **这一列不写**；
 * 认不出数字 ⇒ `null`）。
 *
 * ⚠️ **绝不往数字列写空值**（"往表里塞东西"，而且让"谁写的"变得看不出来）；
 *   原来的写法是 `writeAcceptance` 里的一个局部 lambda（2026-10-15 上移到模块级，
 *   因为退货整单金额那条路也要用**同一个**判据 ⇒ 不抄第二份 ✗）。
 */
const numericOrNull = (value) => (value === undefined || value === null || value === ''
  ? null
  : (Number.isFinite(Number(value)) ? Number(value) : null));

// 「报货批次」**那一行**的读写（业务负责人 2026-10-07 把它定为"控制到货情况"的表）。
//
// 它只管这几件事，一件都不多：
//   · 按「报货批次号」把那一行**找出来**；
//   · **退货**批次也建那一行（2026-10-07 晚口径变更：只写 批次号 + 幂等键，
//     **不写「到货状态」** ⇒ 不进 9 点推送的「未到货」候选）；
//   · 到货状态（报货新建 = 未到货 / 到货确认成功 = 已到货）；
//   · 「单据」附件（出图之后把采购申请单 / 采购退货单的 PNG 回填到这里）；
//   · ⭐ **到货核对的落点**（2026-10-07 晚 → 2026-10-09 收窄）：
//     原先写「到货文字说明（该列已从真表退场）」＋「确认状态」两列；**2026-10-09 只读核对生产真表：
//     这两列也没有了**（报货批次真表 12 列里找不到）⇒ 按"映射 ＋ 写入点一起删"：
//       · `writeAcceptance` **只再写**「实际数量」「发生金额」（结构化验收照写）；
//       · `markConfirmed`（写确认状态）**整个删除**；
//       · `createForReturnBatch`（采购退货批次建行）随采购退货入口一起删除
//         —— ⭐ **2026-10-11 已恢复**：退货入口改走扫码页（业务负责人当天定），
//           批次行仍按老口径建（**只写 批次号 + 幂等键、不写「到货状态」**）；
//       · `config/purchaseAcceptance.js` 与它的单选取值契约一并退场。
//
// 🔄 「采购行为」这一列的**口径 2026-10-12 反转**（业务负责人新原话（逐字）：
//    「**采购主表里面的采购行为确实是需要的，因为一个是报货，一个是退货**」）：
//    · **建行时写**（值 = 行为记录 id；报货走 `purchaseWebhookService` 那条，
//      退货走本文件的 `createForReturnBatch(batchNo, { behaviorRecordId })`）；
//    · **「采购明细.采购行为」是它的 Lookup（只读）** ⇒ 明细侧**一律不写**（2026-10-12 热修已撤两处写入）。
//    （旧口径「不用管」写在 2026-10-07，已作废 —— 她今天明确要它。）
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
//    飞书会自动新建选项、把表污染掉，而 9 点推送按「未到货」查就静默查不到了）。

// ⛔ `purchaseBatchRowKey` 曾在 2026-10-09 随 `createForReturnBatch` 一起删除；
//    **2026-10-11 随退货入口（改走扫码页）一起恢复** —— 报货那条链路的批次键仍在
//    `ensurePostingPlan` 里（`purchase_batch:<task_id>`），不走这个函数。
/** 按批次号算「报货批次」行的幂等键（同一批只建一行）。 */
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
  constructor({ gateway, settings } = {}) {
    if (!gateway) throw new Error('PurchaseOrderBatchService 需要 gateway');
    this.gateway = gateway;
    // 配置读一次（启动时）：取值写错要在服务起来那一刻就吵，而不是等她第一次提交报单。
    // ⚠️ 2026-10-09：`acceptance`（确认状态取值）随「确认状态」那一列一起退场，
    //    这里**只**再读「到货状态」一份配置。
    this.settings = settings || resolvePurchaseArrivalStatusConfig();
  }

  /** 新建批次记录时要写的那个取值（她说的字段默认值「未到货」）。 */
  get pendingStatus() {
    return this.settings.pending;
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
   * ⭐ 2026-10-11：**采购退货批次**也在「报货批次」建一行（只写 批次号 + 幂等键）。
   *
   * 为什么必须建：退货单的 PNG 要有落点（「报货批次.单据」），否则附件回填那一步只会记一条
   * `purchase.batch.document.no_record` 的 warn（图的落点没了）。
   * 🔴 **刻意不写「到货状态」**（业务负责人 2026-10-07 的退货口径）：留空 ⇒ 每天 9 点那条
   *    「未到货」推送与工作台待验收列表**都看不见退货批次**。
   *    ⚠️ 不许"顺手写个空串"：往单选里写空串同样是往表里塞东西。
   *
   * 幂等（两步，缺一不可）：
   *   ① **先按批次号回查**（`findByBatchNo`）：命中就**原样复用**那一行，且**绝不改它的
   *      「到货状态」**（万一同一个批次号上先建过报货那半边，那个「未到货」必须原样保留）；
   *   ② 没有才 `createOnceByKey`，键 = `purchase_batch:<批次号>`。
   *
   * ⚠️ 2026-10-09 这个方法曾随「信息填写」入口退场一起删除；2026-10-11 退货入口改走扫码页
   *    ⇒ **按原实现恢复**（只写两列 + 两步幂等），报货那条链路的批次键仍在
   *    `ensurePostingPlan`（`purchase_batch:<task_id>`），两者互不影响。
   */
  async createForReturnBatch(batchNo, { correlation = {}, behaviorRecordId = '', quantity = 0 } = {}) {
    const wanted = String(batchNo || '').trim();
    if (!wanted) {
      // 没有号就**不编**：调用方自己决定怎么提示。
      return { created: false, reason: 'no_batch_no', batch_no: '' };
    }
    const key = purchaseBatchRowKey(wanted);
    const existing = await this.findByBatchNo(wanted);
    if (existing) {
      logInfo('purchase.return.batch.record_ensured', {
        batch_no: wanted,
        batch_record_id: existing.record_id,
        reused: true,
        matched_by: 'batch_no',
      });
      return {
        created: false, reused: true, recordId: existing.record_id, batch_no: wanted, idempotency_key: key,
      };
    }
    const batch = await createOnceByKey({
      gateway: this.gateway,
      tableKey: 'purchaseOrderBatch',
      keyField: IDEMPOTENCY_KEY_FIELD,
      keyValue: key,
      label: `退货批次 ${wanted}`,
      correlation,
      // ⚠️ **没有** arrivalStatus（见上面的 🔴：退货批次行不写「到货状态」）。
      // ⭐⭐ 2026-10-12（业务负责人）：「采购主表里面的采购行为确实是需要的，一个是报货、一个是退货」
      //    ⇒ 建主表行时写「**采购行为**」（**退货这一路 = 采购退货那一档**）。
      //    值 = 调用方从 `draft.behavior_record_id` 传进来的**行为记录 id**；
      //    空值 ⇒ `relation` 返 `undefined` ⇒ 网关跳过，不会写空。
      //    ⚠️ 「采购明细.采购行为」是这一列的 **Lookup（只读）** ⇒ 明细侧不许写（已撤）。
      values: {
        batchNo: wanted,
        idempotencyKey: key,
        behavior: relation(behaviorRecordId),
        // ⭐⭐ 2026-10-12（她测出来的缺口）：「录入数量」= 这一批的**录入数量合计**。
        //    ⚠️ 拿不到 / 0 ⇒ `batchQuantityFields` 返空对象 ⇒ **这一列不写**（不写空、也不写 0）。
        ...batchQuantityFields([{ quantity }]),
      },
    });
    logInfo('purchase.return.batch.record_ensured', {
      batch_no: wanted,
      batch_record_id: batch.recordId,
      reused: batch.reused === true,
      idempotency_key: key,
    });
    return {
      created: true, reused: batch.reused === true, recordId: batch.recordId, batch_no: wanted, idempotency_key: key,
    };
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
  // ⛔ 2026-10-09：`confirmedStatus`（确认状态取值）与 `markConfirmed`（写确认状态）
  //    **已删除**：那一列在真表上没有了（生产 12 列里没有「确认状态」）。

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
   * ⭐⭐ 2026-10-15（业务负责人裁决）：**退货这一批的「整单金额」**
   *   写到这一行的「**发生金额**」（`actualAmount`）。
   *
   * 依据（**都在文件里**）：
   *   · 她 2026-10-14 晚逐字：「**退货整单金额（必填），与补货同一套配置**」
   *     （落地在 `config/scanWrite.js` 的 `PURCHASE_AMOUNT` + PR #561）；
   *   · 她 **2026-10-15 裁决ⓐ**：列名 = **复用「发生金额」**
   *     （`config/v1BitableSchema.js` 的 `purchaseOrderBatch.fields.actualAmount`，**不用改 schema**）。
   *
   * 🔴 **只有退货走这里——补货（报货）那条不写这一列**：
   *   我在 2026-10-15 只读核出的事实（不凭印象 ✗）：
   *   · 补货那条：`services/purchaseWebhookService.js` 的 `confirmPurchaseRequest`
   *     建行时**显式写 `arrivalStatus = 未到货`**（那里的 `:1603`；注释逐字：
   *     「她走的两条入口（供应商报单 webhook / 扫码页补货）都汇到这一处建行点」）
   *     ⇒ 这条批次**会**进到货验收清单（`services/purchasePendingBatchService.js`
   *     按 `到货状态 = 未到货` 过滤）⇒ 她之后**到货核对**填的「发生金额」
   *     会经本文件的 `writeAcceptance`（下面那个方法）**写同一行的同一列**，
   *     而且**没有「已有值不覆盖」的保护** ⇒ 两边都写 = **同一个单元格两个写入者** ✗；
   *   · 退货那条：`createForReturnBatch`（上面）建行时**不写「到货状态」** ⇒
   *     不进到货清单、不会被到货核对写到 ⇒ **独占这一列** ✓。
   *   ⇒ 补货那半**待她裁**（Lead 已在问：「报货时填的那个金额，和到货时填的
   *     「发生金额」是同一个数吗？」）；本方法**只给退货用** ✗。
   *
   * ⚠️ 语义提醒：「发生金额」在她 2026-10-08 的口径里是「**这一次供应商的金额**」
   *   （见 `writeAcceptance` 的方法头）；退货这一批**没有「到货」那一步** ⇒
   *   这里写的就是她**提交退货时填的那个整单金额** ✓（不是"到货金额"）。
   *
   * 🔴 **只写这一列** ✗：不动「实际数量」、不动「到货状态」（后者是到货核对那条链路的事）。
   * ⚠️ 幂等：写的是**同一个值**（整批一个数）⇒ 重复执行结果一致（**不新建行、不累加**）✓。
   *
   * @returns {Promise<{updated: boolean, reason?: string, record_id?: string, actual_amount?: number}>}
   *   找不到行 / 值不是数字 ⇒ `updated:false` + `reason`（**不抛**）——
   *   调用方（`purchaseReturnService`）据此**如实报失败**（**不许假成功** ✗）。
   */
  async writeOrderAmount({ batchNo = '', batchRecordId = '', actualAmount, correlation = {} } = {}) {
    // 没有批次身份（两个都空）= "孤儿调用"（与 `writeAcceptance` 同一条口径）。
    if (!String(batchNo || '').trim() && !String(batchRecordId || '').trim()) {
      return { updated: false, reason: 'no_batch_identity', batch_no: '' };
    }
    const target = await this.locate({ batchNo, batchRecordId });
    if (!target) {
      logWarn('purchase.batch.order_amount.no_record', { batch_no: batchNo, batch_record_id: batchRecordId });
      return { updated: false, reason: 'no_batch_record', batch_no: batchNo };
    }
    const amount = numericOrNull(actualAmount);
    if (amount === null) {
      // ↙️ 这里**不是"没填就不写"**：调用方只在**非空**时才会进来（页面那道闸门已经拦了空与非数字）
      //   ⇒ 走到这里说明值认不出 ⇒ **如实报失败**（不能当"没填"滑过去 ✗）。
      logWarn('purchase.batch.order_amount.not_a_number', {
        batch_no: batchNo, batch_record_id: target.record_id,
      });
      return { updated: false, reason: 'not_a_number', record_id: target.record_id, batch_no: batchNo };
    }
    // ⚠️ **写失败一律不抛**：返回 `updated:false` + `reason`，由调用方（退货那条路）**如实报失败** ——
    //    "落表失败 ⇒ 如实报写入失败、**不许假成功**"是业务负责人的硬要求 ✗；
    //    原始错误只进日志（不进她看得见的页面）。
    try {
      await this.gateway.update('purchaseOrderBatch', target.record_id, { actualAmount: amount }, { correlation });
    } catch (error) {
      logWarn('purchase.batch.order_amount.update_failed', {
        batch_no: batchNo, batch_record_id: target.record_id, error: error?.message,
      });
      return { updated: false, reason: 'update_failed', record_id: target.record_id, batch_no: batchNo };
    }
    logInfo('purchase.batch.order_amount.written', {
      batch_no: batchNo,
      batch_record_id: target.record_id,
      matched_by: target.matched_by,
      actual_amount: amount,
      source: 'scan_return_submit',
      // 明写"没动别的列"：这是口径，也是将来别人改这段代码时的绊线。
      wrote_actual_quantity: false,
      wrote_arrival_status: false,
    });
    return {
      updated: true, record_id: target.record_id, matched_by: target.matched_by,
      batch_no: batchNo, actual_amount: amount,
    };
  }

  /**
   * ⭐ 把**结构化验收结果**写到这一批的批次行上（**到货确认的第一步**，在入库之前）。
   *
   * ⭐⭐ 2026-10-08（业务负责人亲自批准）：「**实际数量**」「**发生金额**」两个值
   *   在**同一次 update** 里一起写（她的口径：「录入数量：我们报单时候的数量；
   *   实际数量：我们到货的数量；发生金额：这一次供应商的金额」）：
   *     · `actualQuantity` = **代码算出来的**实际到货数合计（`actual = 0` 的行加 0
   *       ⇒ 与库存口径一致）；
   *     · `actualAmount`   = 她在卡片表单里填的**整批金额**（提交时已校验：非空、数字、非负）。
   *   ⚠️ 本方法**只照传进来的值写，不重算**（算/校验是到货核对那一步的职责）。
   *   ⚠️ 值为 `undefined` / `null` / 非数字时**那一列不写**（绝不写空值进去：
   *      往数字列写空串是"往表里塞东西"，而且会让"谁写的"变得看不出来）。
   *   ⚠️ 幂等：写的是**同一个值**（整批一个数），重复执行结果一致（不新建行、不累加）。
   *
   * ⛔ **2026-10-09**：原先这里还写「到货文字说明（该列已从真表退场）」(`acceptanceText`)；那一列在真表上
   *   **没有了**（生产 12 列里找不到）⇒ 写入点删除，本方法只再写上面两列。
   *   ⚠️ 调用方仍然把她的原话留在本地草稿（`draft.acceptance_text`）里 —— 那是
   *      **解析实际到货情况的输入**，与"要不要往表里落一列"是两件事。
   *
   * 为什么要单独一步、而且在入库之前：
   *   · 她的口径是"到货信息的落点搬到报货批次"——这两个数是这次核对**唯一的人工输入**，
   *     先落上，后续入库失败重试时也不用她再说一遍。
   *
   * @returns {Promise<{updated: boolean, record_id?: string, reason?: string, matched_by?: string}>}
   *   找不到批次行时**返回 updated:false**（不抛）——调用方决定要不要因此中断（当前会中断，
   *   因为"到货信息没有落点"等于她这次确认没被记下来）。
   */
  async writeAcceptance({
    batchNo = '', batchRecordId = '', actualQuantity, actualAmount, correlation = {},
  }) {
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
    // ⚠️ 「实际数量」「发生金额」**只在拿得到有效数字时才进 values**（见方法头的 ⚠️）。
    // ⭐ 2026-10-15：那个数值判据**上移到模块级**（`numericOrNull`）—— 本文件现在有两处
    //    写数字列的地方（到货核对的 `writeAcceptance` / 退货整单金额的 `writeOrderAmount`），
    //    **判据只有一处** ✓（行为一个字没变：同一个 lambda 原样搬走）。
    const quantityValue = numericOrNull(actualQuantity);
    const amountValue = numericOrNull(actualAmount);
    const values = {};
    if (quantityValue !== null) values.actualQuantity = quantityValue;
    if (amountValue !== null) values.actualAmount = amountValue;
    // 两列都没值 = 这一次没有任何结构化验收结果可落（老草稿 / 只说话没填数）：
    // **不发那次空的 update**（往飞书写一个空对象是白跑一次调用，还可能被当异常）。
    if (Object.keys(values).length === 0) {
      logWarn('purchase.batch.acceptance.nothing_to_write', {
        batch_no: batchNo, batch_record_id: target.record_id, matched_by: target.matched_by,
      });
      return { updated: true, skipped: true, reason: 'no_actual_values', record_id: target.record_id, batch_no: batchNo };
    }
    await this.gateway.update('purchaseOrderBatch', target.record_id, values, { correlation });
    logInfo('purchase.batch.acceptance.written', {
      batch_no: batchNo,
      batch_record_id: target.record_id,
      matched_by: target.matched_by,
      // ⭐ 2026-10-08：这两个值写在同一行（`null` = 这一列这次没写）。
      actual_quantity: quantityValue,
      actual_amount: amountValue,
      wrote_actual_quantity: quantityValue !== null,
      wrote_actual_amount: amountValue !== null,
      // 明写"没写到货日 / 验收人"：这是口径，也是将来别人改这段代码时的绊线
      //（后两者是飞书自动字段；那条文字说明列 2026-10-09 已从真表消失）。
      wrote_arrival_date: false,
      wrote_inspector: false,
    });
    return {
      updated: true,
      record_id: target.record_id,
      matched_by: target.matched_by,
      batch_no: batchNo,
      actual_quantity: quantityValue,
      actual_amount: amountValue,
    };
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
    if (!field) throw new Error('「采购主表」未配置「单据」字段映射');
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
  PurchaseOrderBatchService, attachmentTokens, attachmentNames,
};
