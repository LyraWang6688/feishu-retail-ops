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
 *   ⑥ 失败**如实**：金额缺失/≤0 · 数量非法（0/负/小数）· 关联为空 · 引擎报错 ⇒ **不成单** + 如实日志 ✗
 *   ⑦ 回写**列不在** ⇒ 捕获 + 只记日志（**不许假写 / 不许报错打断成单** ✗）
 *   ⑧ ⭐⭐ 2026-10-15（她逐字：「**销售明细里是一行一件，如果配品是两件，那就拆开，
 *      按照数量拆成对应的记录数**」）：**数量 = N ⇒ 拆成 N 条明细（一行一件）**，
 *      金额摊到 N 行、**Σ 严格 = 她填的总额**；收款明细**仍只有 1 行**（总额 ⇒ **Σ 不翻倍** ✗）✓
 *   ⑨ 录单人 = **她表里那个自动字段「录单人」（= 提交表单的人）** → 事件没带 ⇒ **只读那一列** →
 *      事件操作人 → 配置兜底 → **空（不写「销售主表.录单人」）**；🔴 **绝不编 id** ✗，
 *      也**绝不写回她表那个自动列** ✗（本入口对它只读）；
 *      会话键 = **前缀 + 记录 ID**（每行独立会话 ⇒ 第 2 条不会被上一单结果吸收 ✗）
 *   ⑩ 回写 patch 的 key **恰好 ⊆ {写入状态, 失败原因}**：她填的列与她的自动字段一律只读 ✗
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

/**
 * ⭐⭐ 2026-10-15：**人员（User）字段**的 open_id 取值 —— 专给「配品销售.录单人」这类列用。
 *
 * 飞书 User 字段在事件里可能长成好几种形状（同一语义，别因为包一层就取不到 ✗）：
 *   · `after_value[].field_value` = `[{ id: 'ou_…' }]`（她那张表的实测形状 ✓）
 *   · `[{ open_id: 'ou_…' }]` / `[{ user_id: { open_id: 'ou_…' } }]`
 *   · 官方 SDK 里另有一支 `field_identity_value.users[].user_id.open_id` ✓
 *   · 纯字符串 `'ou_…'`
 * ⚠️ **只认 open_id 系**（本仓所有 User 字段写入都用 open_id）；取不到 ⇒ 空数组，
 *   **不猜、不编** ✗（调用方按四级优先级继续往下走）。
 */
const userIdsOf = (value) => {
  const out = [];
  const push = (id) => {
    const text = textOf(id);
    if (text && !out.includes(text)) out.push(text);
  };
  const visit = (item) => {
    if (!item) return;
    if (typeof item === 'string') { push(item); return; }
    if (Array.isArray(item)) { item.forEach(visit); return; }
    push(item.user_id?.open_id);
    push(item.open_id);
    push(item.id);
    if (item.users) visit(item.users);
    if (item.field_identity_value) visit(item.field_identity_value.users);
  };
  visit(value);
  return out;
};

/**
 * ⭐⭐ 她 2026-10-15 逐字（Lead 转达）：「**我们销售明细里是一行一件，如果配品是两件，那就拆开，
 *   按照数量拆成对应的记录数**」⇒ 数量 = N ⇒ **N 条明细（一行一件）**，金额**摊到 N 行**。
 *
 * 分摊规则（`splitAmount`）：
 *   · 用**整数**运算（元 / 角 / 分），不拿浮点数摊（0.1+0.2 那类误差会让 Σ ≠ 总额）；
 *   · **分摊单位 = 她填的那个金额的最小单位**：整数元 ⇒ 按**整元**摊（100 ÷ 3 ⇒ 34/33/33，
 *     与 Lead 裁决里那条判据逐字一致 ✓）；带角分 ⇒ 按**分摊**（100.5 ÷ 3 ⇒ 33.50/33.50/33.50）
 *     —— 总之**不凭空造出她没填的精度**；
 *   · **前 r 行各 +1**，**最后一行 = 总额 − 前面之和**（兜底差额）⇒ **Σ 严格 = 她填的总额** ✓
 *     （Σ 必须准：引擎的「全付」闸门就是拿"每件实收合计"跟"收款合计"比分的，差一分就成不了单）。
 *   · 摊不开（金额的最小单位**比件数还少**）⇒ 如实返回 `ok:false`（调用方拒单，**零写入** ✗ 不静默记 1 件）。
 */
const splitAmount = (total, count) => {
  const totalCents = Math.round(Number(total) * 100);
  const n = Math.max(1, Math.trunc(Number(count) || 1));
  const unit = totalCents % 100 === 0 ? 100 : 1;
  const minor = Math.round(totalCents / unit);
  if (minor < n) return { ok: false, reason: 'too_small', totalCents };
  const base = Math.floor(minor / n);
  const remainder = minor - base * n;
  const parts = [];
  let used = 0;
  for (let index = 0; index < n; index += 1) {
    const value = index === n - 1 ? minor - used : base + (index < remainder ? 1 : 0);
    used += value;
    parts.push(value * unit);
  }
  return { ok: true, parts };
};

/** 分 → 她填金额那套文本（整数不带小数点；带角分两位）—— 与 `scanWriteService` 的金额口径一致。 */
const centsToAmountText = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/**
 * ⭐ **谁填的表，谁就是录单人**（Lead 2026-10-15 裁决）——
 *   `drive.file.bitable_record_changed_v1` 的**官方事件形状**里操作人在**顶层**
 *   （`@larksuiteoapi/node-sdk` 的类型：`operator_id?: { union_id?, user_id?, open_id? }`）。
 *   ⚠️ 容错几种历史/卡片形状（同一个语义，别因为包一层就取不到）。
 *   ⚠️ **取不到就返回空串** —— **绝不编一个 id** ✗（配置兜底由调用方处理）。
 */
const operatorOpenIdOf = (event) => {
  const candidates = [
    event?.operator_id?.open_id,
    event?.operator?.operator_id?.open_id,
    event?.operator?.open_id,
    event?.event?.operator_id?.open_id,
    event?.event?.operator?.operator_id?.open_id,
  ];
  for (const candidate of candidates) {
    const value = textOf(candidate);
    if (value) return value;
  }
  return '';
};

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
  /** 销售那几列（**不含**「录单人」—— 那个是**只读**的自动字段，见 `readOperatorByFallback`）。 */
  const saleFieldNames = [fields.name, fields.quantity, fields.paymentMethod, fields.amount].filter(Boolean);
  const readFromEvent = (afterValue) => ({
    nameIds: linkIdsOf(findFieldValue(afterValue, eventKey('name'))),
    quantity: findFieldValue(afterValue, eventKey('quantity')),
    methodText: linkTextOf(findFieldValue(afterValue, eventKey('paymentMethod'))),
    amount: findFieldValue(afterValue, eventKey('amount')),
    // ⭐ 她表里那个**自动字段**「录单人」（= 提交表单的人）—— 主路径就把它当录单人 ✓
    operatorIds: userIdsOf(findFieldValue(afterValue, eventKey('operator'))),
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
      tableId: config.tableId, recordId,
      // 销售那 4 列 + 「录单人」那一列（**都是点名的列**，不是整行 ✗）
      fieldNames: [...saleFieldNames, fields.operator].filter(Boolean),
      reason: 'accessory_sale_intake.fallback',
    });
    const recordFields = record?.fields || {};
    return {
      nameIds: linkIdsOf(recordFields[fields.name]),
      quantity: recordFields[fields.quantity],
      methodText: linkTextOf(recordFields[fields.paymentMethod]),
      amount: recordFields[fields.amount],
      operatorIds: userIdsOf(recordFields[fields.operator]),
    };
  };

  /**
   * ⭐⭐ 录单人的**第二级**：事件没带「录单人」那一列 ⇒ **只读那一列**（Lead 点名：别读整行 ✗）。
   *   ⚠️ 读不到 **不是错**：如实记一条 warn，然后继续往下一级走（事件操作人 ⇒ 配置 ⇒ 空）✓
   *   ⚠️ **绝不**因为读不到就编一个 id ✗
   */
  const readOperatorByFallback = async (recordId, reasonLabel) => {
    if (!gateway || typeof gateway.getByTableId !== 'function') return '';
    const operatorField = fields.operator;
    if (!operatorField) return '';
    logWarn('accessory_sale_intake.operator_fallback_read', {
      table_id: config.tableId, record_id: recordId, field: operatorField, why: reasonLabel,
      hint: `事件没带「${operatorField}」⇒ **只读这一列**兜底（读不到就往下一级走，绝不编 id）`,
    });
    try {
      const record = await gateway.getByTableId({
        tableId: config.tableId, recordId, fieldNames: [operatorField],
        reason: 'accessory_sale_intake.operator_fallback',
      });
      return userIdsOf(record?.fields?.[operatorField])[0] || '';
    } catch (error) {
      logWarn('accessory_sale_intake.operator_fallback_failed', {
        table_id: config.tableId, record_id: recordId, error: error.message,
      });
      return '';
    }
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
    // 🔴 2026-10-15 口径**已更新**（Lead 转达她逐字：「销售明细里是一行一件，如果配品是两件，
    //   那就拆开，按照数量拆成对应的记录数」）⇒ 数量 = N **不再拒单**，改成**拆 N 行**（见下面 handleOne）。
    //   ⚠️ 改前逐字（本刀第一次实现）：`if (quantityNumber > 1) return { ok:false, reason: reasons.quantityMultiple(...) }`
    //      改后逐字：删掉那一段，改为"件数只做上限校验（引擎的 `config.session.maxLines`），
    //      金额摊不开才拒"。
    //      依据：她的口径从"这一版一次只记 1 件"升级为"按数量拆成对应的记录数"✓
    // 上限：引擎每单最多 `maxLines` 行（既有配置）⇒ 超过就**如实拒单**（零写入），
    //   而不是加到一半被引擎拒（那会在本地草稿里留下半截 ✗）
    const maxLines = Number(SCAN_WRITE?.session?.maxLines) || 0;
    if (maxLines && quantityNumber > maxLines) {
      return { ok: false, reason: reasons.quantityOverLineLimit(quantityNumber, maxLines) };
    }
    if (!methodText) return { ok: false, reason: reasons.paymentMethodMissing };
    return { ok: true, quantity: quantityNumber, amountText: String(amountNumber), amountNumber };
  };

  /**
   * 回写（**只许这两列** ✗ 其它列一个都不许碰；她表那个「录单人」自动字段更是**只读** ✗；
   * 列不在 ⇒ 只记日志、不报错、不假写）。
   */
  const writeBackStatus = async (recordId, payload) => {
    if (!writeBack.enabled) return { written: false, reason: 'disabled' };
    const patch = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === writeBack.statusField || key === writeBack.reasonField) patch[key] = value;
    }
    // 🔴 双保险：即使上面被改坏，也只可能带出这两列（业务列永不出现在这里）
    const allowed = new Set([writeBack.statusField, writeBack.reasonField].filter(Boolean));
    // 🔴 她填的列 + 她的**自动字段**一律**只读**：就算配置被写歪（比如有人把「写入状态」配成「录单人」），
    //    这两列也**绝不许**出现在回写 patch 里 ✗（「录单人」是飞书自动字段：写了就是篡改她表里的事实）
    const neverWrite = new Set([fields.operator, fields.saleDate].filter(Boolean));
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key) || neverWrite.has(key)) {
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

  /**
   * 办一行。
   * @param {object} actionItem 飞书事件里的一条（`record_id` / `action` / `after_value`）
   * @param {{eventOperatorOpenId?:string, operatorOverride?:string}} [input]
   *        `eventOperatorOpenId` = 事件里的操作人（`operator_id.open_id`，**第三级**）；
   *        `operatorOverride`    = **显式点名**（用例 / 别的入口用，**最优先**）
   *
   * ⭐ 录单人的**四级**优先级（Lead 2026-10-15 裁决）：
   *    ① 显式点名 → ② 她表**自动字段「录单人」**（事件带的那一列）
   *    → ③ **只读那一列**兜底（事件没带）→ ④ 事件操作人 → ⑤ 配置出口 → ⑥ **空（不写）**
   *    ⚠️ 任何一级都**不许编一个 id** ✗
   */
  const handleOne = async (actionItem, { eventOperatorOpenId = '', operatorOverride = '' } = {}) => {
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
    // ⚠️ 会话键 = **前缀 + 记录 ID**（每行一个**独立会话**）：绝不能用 openId 当会话键 ——
    //    所有行共用一个人做会话键时，第 2 条记录会被引擎的 `reused/stale` 分支**吸收成假成功** ✗
    const requestId = `${config.sessionKeyPrefix || 'accessory_sale:'}${recordId}`;
    const sessionKey = requestId;
    // ⭐ 录单人：四级优先级（见 handleOne 的注释）——**任何一级都不许编一个 id** ✗
    const fromRecord = (values.operatorIds || []).map(textOf).find(Boolean);
    const operatorOpenId = textOf(operatorOverride)
      || fromRecord
      // ⚠️ 第二参是**机器可读的原因码**（不是文案）——中文只能出现在 logX 那一行里
      //    （`test/noHardcodedChinese.test.js` 的守门口径：`src/services/**` 不许新增硬编码用户可见中文）
      || await readOperatorByFallback(recordId, 'operator_column_absent_in_event')
      || textOf(eventOperatorOpenId)
      || textOf(config.operatorOpenId);
    if (!operatorOpenId) {
      logWarn('accessory_sale_intake.operator_missing', {
        record_id: recordId,
        hint: '她表「录单人」/ 事件操作人 / 配置 都没有 ⇒ **不写「销售主表.录单人」**（绝不编 id ✗）',
      });
    }
    // 金额按件数摊到 N 行（一行一件）；摊不开 ⇒ 如实拒单（**零写入** ✗）
    const split = splitAmount(checked.amountNumber, checked.quantity);
    if (!split.ok) {
      const reason = reasons.amountTooSmallForSplit(checked.amountText, checked.quantity);
      logError('accessory_sale_intake.rejected', { record_id: recordId, reason });
      await writeBackStatus(recordId, {
        [writeBack.statusField]: writeBack.failedValue, [writeBack.reasonField]: reason,
      });
      return { ok: false, record_id: recordId, reason };
    }
    const lineAmounts = split.parts.map(centsToAmountText);
    try {
      for (const lineAmount of lineAmounts) {
        // eslint-disable-next-line no-await-in-loop
        const line = await scanWrite.addSaleLine({
          openId: operatorOpenId,
          sessionKey,
          requestId,
          kind: 'accessory',
          accessoryRecordId: values.nameIds[0],
          // ⭐ 2026-10-14 她的口径（与工作台**同源**）：配品默认现货来自**可售品配置**（不散写 if ✗）
          inStock: sellableKindOf({ kind: 'accessory' }).defaultInStock === true,
          // ⭐ 这一行的**实收金额**（分摊后的那一份）；引擎一行 = 一件 ⇒ 调 N 次就是 N 行 ✓
          amount: lineAmount,
        });
        if (!line?.ok) throw new Error(line?.message || '明细行没记上');
      }
      const result = await scanWrite.submitSale({
        openId: operatorOpenId,
        sessionKey,
        requestId,
        submitKey: recordId,
        // ⚠️ 收款明细**只有 1 行**、金额 = **她填的总额**（明细那 N 行的和 = 总额 ⇒ **Σ 不翻倍** ✗）
        payments: [{ method: values.methodText || SCAN_WRITE.sale.defaultPaymentMethod, amount: checked.amountText }],
        paymentStatus: SCAN_WRITE.sale.paymentStatus.full,
        paidAmount: checked.amountText,
      });
      if (!result?.ok) throw new Error(result?.message || '成单失败');
      // ⚠️⚠️ 2026-10-15（⑰ 异步**默认开**）：`submitSale` 在"主表刚落"时会**先把单号回出来**，
      //   把明细 / 收款 / 库存交给**后台那一跑**（`result.background` 是它的句柄）。
      //   工作台那条**故意不等**（她盯着页面，单号先出是她的口径 ✓）；
      //   而本入口是**表变更事件**、没有人在等 ⇒ **等它跑完**再回写「已写入」：
      //   否则后台失败时她那张表里写着「已写入」、单子其实只写了一半 —— 那正是**假成功** ✗。
      //   ⚠️ 后台句柄**抛异常时**解析成 `undefined`（`saleWriteBackgroundService` 里 catch 掉了）
      //   ⇒ 所以 `!settled` 也算失败（它那边已经如实把主表落成「写入失败」）。
      const settled = typeof result.background?.then === 'function' ? await result.background : result;
      if (!settled || settled.ok === false) throw new Error(settled?.message || '明细/收款那一跑没成');
      const finalResult = settled || result;
      logInfo('accessory_sale_intake.posted', {
        record_id: recordId, order_no: finalResult.order_no || result.order_no || '',
        reused: finalResult.reused === true || result.reused === true,
        amount: checked.amountText, quantity: checked.quantity, line_count: lineAmounts.length,
        line_amounts: lineAmounts.join(','), operator_open_id: operatorOpenId || '',
      });
      await writeBackStatus(recordId, { [writeBack.statusField]: writeBack.doneValue });
      return {
        ok: true, record_id: recordId, order_no: finalResult.order_no || result.order_no || '',
        reused: finalResult.reused === true || result.reused === true, line_count: lineAmounts.length,
      };
    } catch (error) {
      logError('accessory_sale_intake.failed', { record_id: recordId, error: error.message });
      await writeBackStatus(recordId, {
        [writeBack.statusField]: writeBack.failedValue, [writeBack.reasonField]: error.message,
      });
      return { ok: false, record_id: recordId, reason: error.message };
    }
  };

  /**
   * 办一个事件包。
   * @param {Array} actionList 飞书事件的 `action_list`（原样传进来，不在路由层筛）
   * @param {{event?:object, operatorOpenId?:string}} [intakeOptions]
   *        `event` = 原始事件（① 取她表「录单人」那一列用的是**每条 action 的 after_value**；
   *        ② 第三级"事件操作人"取的是 `event.operator_id.open_id`）；
   *        `operatorOpenId` = **显式点名**（最优先，用例 / 别的入口用）
   */
  const handleTableChanges = async (actionList, intakeOptions = {}) => {
    if (!config.enabled) {
      logInfo('accessory_sale_intake.disabled', { action_count: (actionList || []).length });
      return { enabled: false, results: [] };
    }
    // 事件里的**操作人**（第三级兜底）；她表那个自动「录单人」在每条 action 的 `after_value` 里（第一级）
    const eventOperatorOpenId = operatorOpenIdOf(intakeOptions.event);
    const results = [];
    for (const actionItem of Array.isArray(actionList) ? actionList : []) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await handleOne(actionItem, {
        eventOperatorOpenId, operatorOverride: intakeOptions.operatorOpenId,
      }));
    }
    return { enabled: true, event_operator_open_id: eventOperatorOpenId || '', results };
  };

  return { handleTableChanges, handleOne, config };
};

module.exports = {
  createAccessorySaleIntakeService, linkIdsOf, linkTextOf, splitAmount, centsToAmountText, operatorOpenIdOf,
};
