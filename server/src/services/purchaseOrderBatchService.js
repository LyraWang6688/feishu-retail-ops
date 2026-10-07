const { textValue } = require('./v1BitableGateway');
const {
  resolvePurchaseArrivalStatusConfig,
} = require('../config/purchaseArrivalStatus');
const { logInfo, logWarn } = require('../utils/logger');

// 「报货批次」**那一行**的读写（业务负责人 2026-10-07 把它定为"控制到货情况"的表）。
//
// 它只管三件事，一件都不多：
//   · 按「报货批次号」把那一行**找出来**；
//   · 到货状态（新建 = 未到货 / 到货确认成功 = 已到货）；
//   · 「单据」附件（出图之后把采购申请单 / 采购退货单的 PNG 回填到这里）。
//
// ⚠️ 「采购行为」这一列**此刻意不读、不写、不映射**（她的原话：
//    「报货批次里面的采购行为你不用管」）—— 不碰它就不可能"顺手"写坏它。
//
// ⚠️ 为什么单独一个 service（AGENTS.md《底层工程原则》的「模块化」）：
//    `PurchaseWebhookService` 已经背了"报货 → 出单 → 出图 → 发群"整条链路；
//    批次行怎么维护是另一件事，将来还会被 9 点推送 / 到货核对复用。
//
// ⚠️ 取值**不写死中文**：到货状态两个值来自 `config/purchaseArrivalStatus.js`，
//    并由部署闸门对着真表 `property.options` 核对（往单选里写不存在的取值，
//    飞书会自动新建选项、把表污染掉，而 9 点推送按「未到货」查就静默查不到了）。

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

module.exports = { PurchaseOrderBatchService, attachmentTokens, attachmentNames };
