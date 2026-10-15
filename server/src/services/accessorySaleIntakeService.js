'use strict';

/**
 * ⭐⭐ 2026-10-15（业务负责人逐字）：她新建了「**配品销售**」表当**输入入口** ——
 *   「这就相当于实际上我们只是换了一个让用户交互的入口。但是我们**一旦收到这样的一个请求，
 *    还是要做同样的处理：销售主表、销售明细以及收款明细**」
 *
 * ⇒ 本 service **不新开写库**：把一行「配品销售」翻译成**与工作台那条完全同一套**的调用
 *   （`scanWriteService.addSaleLine(kind:'accessory')` + `submitSale`，**同一把 `submitKey`**）✓
 *
 * 🔴 红线（逐条都钉在测试里）：
 *   ① **主路径零读取**：值从事件的 `actionItem.after_value` 取（`findFieldValue` 复用既有纯件 ✓）；
 *      取不到才用 `gateway.getByTableId` **兜底**，且**如实记一条 warn**（带 table_id / record_id / 缺哪列）✗ 不许静默
 *   ② **幂等键 = 记录 ID**（同一行重复触发 / 并发触发 ⇒ **只成一次单**）✓
 *   ③ **绝不直调 `_confirm`** ✗（走既有 `submitSale` 那条公开链路）
 *   ④ **回写只许写「写入状态 / 失败原因」两列** ✗ —— 她填的列（名称/数量/收款方式/金额/销售日）**一个都不许碰**
 *      （**手滑带上「金额」= 篡改她的输入** ✗ 比"少写一列"严重得多）
 *   ⑤ 🔴 **「销售日」零写入点**（她：「销售日不用管，自动字段」）✓
 *   ⑥ 失败**如实**：金额缺失/≤0 · 数量非法 · 关联为空 · 引擎报错 ⇒ **不成单** + 如实日志（**不许假成功** ✗）
 *   ⑦ 回写**列不在** ⇒ 捕获 + 只记日志（**不许假写 / 不许报错打断成单** ✗）
 */
const { logInfo, logWarn, logError } = require('../utils/logger');
const { findFieldValue } = require('./tagQrCodeService');
const { SCAN_WRITE } = require('../config/scanWrite');
const { sellableKindOf } = require('../config/sellableKinds');
const { resolveAccessorySaleIntakeConfig } = require('../config/accessorySaleIntake');

/** 关联列的形状兼容（与网关里那句 `nested = [value.record_ids, value.link_record_ids]` 同一思路 ✓）。 */
const linkIdsOf = (value) => {
  const nested = [value?.record_ids, value?.link_record_ids].find((ids) => Array.isArray(ids) && ids.length);
  if (Array.isArray(nested)) return nested.map((id) => String(id || '').trim()).filter(Boolean);
  if (Array.isArray(value)) {
    const fromArray = value.map((item) => String(item?.record_id || item?.record_ids?.[0] || item || '').trim())
      .filter(Boolean);
    if (fromArray.length) return fromArray;
  }
  const single = String(value?.record_id || (typeof value === 'string' ? value : '')).trim();
  return single ? [single] : [];
};

/** 关联列的**显示文本**（收款方式要的是名字/值；取不到 ⇒ 交给兜底读表，**不猜** ✗）。 */
const linkTextOf = (value) => {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = String(item?.text || item?.name || item?.en_name || '').trim();
      if (text) return text;
    }
    return '';
  }
  return String(value?.text || value?.name || '').trim();
};

const textOf = (value) => (value == null ? '' : String(value).trim());

const createAccessorySaleIntakeService = (options = {}) => {
  const gateway = options.gateway || null;
  const config = options.config || resolveAccessorySaleIntakeConfig();
  // ⚠️ 写服务**注入优先**（用例替身；生产由路由现场建 ⇒ 不碰 `app.js` ✓）
  const scanWrite = options.scanWrite || null;
  const fields = config.fields || {};
  const writeBack = config.writeBack || {};
  // ⚠️ 拒单原因（写回「失败原因」那一列的**用户可见文案**）**一律从配置取** ✗ 不许写死在这里
  //   —— 这是 `test/noHardcodedChinese.test.js` 的守门口径（`src/services/**` 不许新增硬编码中文）。
  //   注入的 config 少给这一段时，回落到**同一份默认配置**（不写第二份文案 ✗）。
  const reasons = config.reasons || resolveAccessorySaleIntakeConfig().reasons;

  /**
   * ⚠️ 事件里 `after_value` 的 `field_id` 是**飞书列 id**（形如 `fldxxxx`），不是列名 ⇒
   *   配置里 `fieldIds`（可配 ✓）优先，列名次之（两条都给 ⇒ 哪边能认就认哪边 ✓ 不猜 ✗）。
   *   两个都对不上 ⇒ 该列按"没带"处理 ⇒ 走兜底读表（**如实 warn** ✓）。
   */
  const fieldIds = config.fieldIds || {};
  const eventKey = (key) => fieldIds[key] || fields[key];
  const readFromEvent = (afterValue) => ({
    nameIds: linkIdsOf(findFieldValue(afterValue, eventKey('name'))),
    quantity: findFieldValue(afterValue, eventKey('quantity')),
    methodText: linkTextOf(findFieldValue(afterValue, eventKey('paymentMethod'))),
    amount: findFieldValue(afterValue, eventKey('amount')),
  });

  /** 兜底：事件没带全 ⇒ 按原始 table_id 读那一条（**如实记 warn** ✗ 不许静默）。 */
  const readByFallback = async (recordId, missing) => {
    if (!gateway || typeof gateway.getByTableId !== 'function') {
      throw new Error(reasons.fallbackUnavailable(missing));
    }
    logWarn('accessory_sale_intake.fallback_read', {
      table_id: config.tableId, record_id: recordId, missing,
      hint: '事件没带全这几列 ⇒ 回退按 table_id 读一次（读取失败即拒单）',
    });
    const record = await gateway.getByTableId({
      tableId: config.tableId, recordId, fieldNames: Object.values(fields).filter(Boolean),
      reason: 'accessory_sale_intake.fallback',
    });
    const recordFields = record?.fields || {};
    return {
      nameIds: linkIdsOf(recordFields[fields.name]),
      quantity: recordFields[fields.quantity],
      methodText: linkTextOf(recordFields[fields.paymentMethod]),
      amount: recordFields[fields.amount],
    };
  };

  /** 校验（失败 ⇒ 人话原因；**不成单** ✗）。原因原文全部来自 `config.reasons` ✓ */
  const validate = ({ nameIds, quantity, amount, methodText }) => {
    if (!nameIds.length) return { ok: false, reason: reasons.nameMissing };
    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      return { ok: false, reason: reasons.amountInvalid(amount) };
    }
    const quantityNumber = quantity == null || quantity === '' ? 1 : Number(quantity);
    if (!Number.isFinite(quantityNumber) || !Number.isInteger(quantityNumber) || quantityNumber <= 0) {
      return { ok: false, reason: reasons.quantityInvalid(quantity) };
    }
    // 🔴 2026-10-15（Lead 裁决 · **有证据**）：工作台那条配品成单就是「**一次 1 件**」
    //   —— 引擎写明细是 `quantity: 1`，而且「销售明细」表**根本没有「数量」列** ✓
    //   ⇒ 她逐字要的是"**同样的处理**" ⇒ 这里也只认 1 件 ✓
    //   🔴 数量 > 1 ⇒ **如实拒单**（**绝不静默按 1 记** ✗ —— 她填 3 件你记 1 件 = 假成功，比拒单坏得多）；
    //     多件怎么落明细（一行+总金额？N 行？单价×数量）等她的口径，**这一刀不做** ✓
    if (quantityNumber > 1) {
      return { ok: false, reason: reasons.quantityMultiple(quantityNumber) };
    }
    if (!methodText) return { ok: false, reason: reasons.paymentMethodMissing };
    return { ok: true, quantity: quantityNumber, amountText: String(amountNumber) };
  };

  /** 回写（**只许这两列** ✗ 其它列一个都不许碰；列不在 ⇒ 只记日志）。 */
  const writeBackStatus = async (recordId, payload) => {
    if (!writeBack.enabled) return { written: false, reason: 'disabled' };
    const patch = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === writeBack.statusField || key === writeBack.reasonField) patch[key] = value;
    }
    // 🔴 双保险：即使上面被改坏，也只可能带出这两列（业务列永不出现在这里）
    const allowed = new Set([writeBack.statusField, writeBack.reasonField].filter(Boolean));
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        logError('accessory_sale_intake.writeback.refused', { record_id: recordId, key });
        delete patch[key];
      }
    }
    if (!Object.keys(patch).length) return { written: false, reason: 'nothing_to_write' };
    if (!gateway || typeof gateway.updateByTableId !== 'function') return { written: false, reason: 'no_gateway' };
    try {
      await gateway.updateByTableId({
        tableId: config.tableId, recordId, fields: patch, reason: 'accessory_sale_intake.writeback',
      });
      return { written: true };
    } catch (error) {
      // ⚠️ 列不在（她还没加）/ 权限不足 ⇒ **只记日志**（不许假写 ✗、也不许打断成单 ✗）
      logWarn('accessory_sale_intake.writeback.failed', {
        table_id: config.tableId, record_id: recordId, fields: Object.keys(patch),
        error: error.message, hint: '多半是那两列还没建 ⇒ 只记日志，不重试、不假写',
      });
      return { written: false, reason: 'failed' };
    }
  };

  /** 办一行。 */
  const handleOne = async (actionItem) => {
    const recordId = textOf(actionItem?.record_id);
    const action = textOf(actionItem?.action);
    if (!recordId) return { ok: false, skipped: 'no_record_id' };
    if (!(config.events?.created || []).includes(action)) {
      return { ok: false, skipped: `action:${action || 'unknown'}` };
    }
    if (!scanWrite) {
      logWarn('accessory_sale_intake.not_wired', { record_id: recordId, hint: '没有写服务 ⇒ 这一行不处理' });
      return { ok: false, skipped: 'not_wired' };
    }
    let values = readFromEvent(actionItem?.after_value);
    const missing = [
      values.nameIds.length ? '' : 'name', values.amount == null || values.amount === '' ? 'amount' : '',
      values.quantity == null || values.quantity === '' ? 'quantity' : '',
      values.methodText ? '' : 'paymentMethod',
    ].filter(Boolean);
    if (missing.length) {
      try {
        values = await readByFallback(recordId, missing);
      } catch (error) {
        logError('accessory_sale_intake.rejected', { record_id: recordId, reason: error.message });
        await writeBackStatus(recordId, { [writeBack.statusField]: writeBack.failedValue, [writeBack.reasonField]: error.message });
        return { ok: false, record_id: recordId, reason: error.message };
      }
    }
    const checked = validate(values);
    if (!checked.ok) {
      logError('accessory_sale_intake.rejected', { record_id: recordId, reason: checked.reason });
      await writeBackStatus(recordId, {
        [writeBack.statusField]: writeBack.failedValue, [writeBack.reasonField]: checked.reason,
      });
      return { ok: false, record_id: recordId, reason: checked.reason };
    }
    // ⚠️ 幂等键 = **记录 ID**（同一行重复/并发触发只成一次单 ✓ —— 引擎按 `submitKey` 认旧结果）
    const openId = 'accessory-sale-intake';
    const requestId = `accessory_sale:${recordId}`;
    try {
      const line = await scanWrite.addSaleLine({
        openId,
        requestId,
        kind: 'accessory',
        accessoryRecordId: values.nameIds[0],
        // ⭐ 2026-10-14 她的口径（与工作台**同源**）：配品默认现货来自**可售品配置**（不散写 if ✗）
        inStock: sellableKindOf({ kind: 'accessory' }).defaultInStock === true,
        amount: checked.amountText,
        quantity: checked.quantity,
      });
      if (!line?.ok) throw new Error(line?.message || '明细行没记上');
      const result = await scanWrite.submitSale({
        openId,
        requestId,
        submitKey: recordId,
        payments: [{ method: values.methodText || SCAN_WRITE.sale.defaultPaymentMethod, amount: checked.amountText }],
        paymentStatus: SCAN_WRITE.sale.paymentStatus.full,
        paidAmount: checked.amountText,
      });
      if (!result?.ok) throw new Error(result?.message || '成单失败');
      logInfo('accessory_sale_intake.posted', {
        record_id: recordId, order_no: result.order_no || '', reused: result.reused === true,
        amount: checked.amountText, quantity: checked.quantity,
      });
      await writeBackStatus(recordId, { [writeBack.statusField]: writeBack.doneValue });
      return { ok: true, record_id: recordId, order_no: result.order_no || '', reused: result.reused === true };
    } catch (error) {
      logError('accessory_sale_intake.failed', { record_id: recordId, error: error.message });
      await writeBackStatus(recordId, {
        [writeBack.statusField]: writeBack.failedValue, [writeBack.reasonField]: error.message,
      });
      return { ok: false, record_id: recordId, reason: error.message };
    }
  };

  const handleTableChanges = async (actionList) => {
    if (!config.enabled) {
      logInfo('accessory_sale_intake.disabled', { action_count: (actionList || []).length });
      return { enabled: false, results: [] };
    }
    const results = [];
    for (const actionItem of Array.isArray(actionList) ? actionList : []) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await handleOne(actionItem));
    }
    return { enabled: true, results };
  };

  return { handleTableChanges, handleOne, config };
};

module.exports = { createAccessorySaleIntakeService, linkIdsOf, linkTextOf };
