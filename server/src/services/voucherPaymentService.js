'use strict';

/**
 * ⭐⭐ 抖音团购券 · **把资金页那几行收款解析成"券行"**（2026-10-16 业务负责人口径）。
 *
 * 本文件只干一件事：**认券 + 一张券两个数各归各位**（配置先行 ✓ 只读 ✓ 不写任何表 ✗）。
 *
 * 券的判定（她 ④ + 生产真表只读核实）：`收款方式管理.「团购券管理」关联列**非空**` ⇒ 这条是券。
 * 三个数各用各的：
 *   · 券目录里那张券的「**面值**」        → 算**差额（未收款）**（`balanceDeltaCents` 交出去，见下）
 *   · 「**平台结算款**」                  → 写**收款明细那一笔的金额**（`payments[i].amount`）
 *   · 「**待平台结算**」                  → 那一笔的**状态**（状态那一半由收款写入层按同一判据落 ✓）
 *
 * ⚠️ 差额**不是本文件算的、也不由扫码侧落库**：差额的算法只有一个
 *    （`services/salesOrderService.js` 的 `outstandingCents = 累计 − 已收`），
 *    本文件只把"券抵扣了多少（面值）"翻译成 `balanceDeltaCents` 交给调用方 ✓。
 *
 * 🔴 **缺映射 ⇒ 大声 warn + 拦住**（既定事件名 `scan.write.voucher_method_unmapped`）：
 *    **不许静默把这条券当成普通收款** ✗（那会写一个错的金额进账，她事后对不上）。
 * 🔴 **读不到**（券目录 / 收款方式表）⇒ 同样**大声 warn + 拦住**（"读不到"与"没有券"是两件事 ✗）。
 */

const { linkedRecordIds } = require('./v1BitableGateway');
const { logWarn } = require('../utils/logger');
const {
  resolveVoucherPaymentConfig, VOUCHER_METHOD_UNMAPPED_EVENT, VOUCHER_CATALOG_UNREADABLE_EVENT,
} = require('../config/voucherPayment');

const toCents = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
};

/**
 * @param {{ gateway: object, paymentMethods: object, config?: object, log?: Function }} deps
 *   `paymentMethods` = `services/paymentMethodsService.js` 那份（`listWithVouchers()` 带券关联 ✓）
 */
const createVoucherPaymentService = ({ gateway, paymentMethods, config, log } = {}) => {
  if (!gateway) throw new Error('VoucherPaymentService requires gateway');
  const settings = config || resolveVoucherPaymentConfig();
  const warn = typeof log === 'function' ? log : logWarn;

  /**
   * 「团购券管理」目录（**认券按 record_id**；「在售」只用来判"这张券她点不点得到" ✓）。
   *
   * ⚠️ 认券**不过滤销售状态**：收款方式那条「团购券管理」关联列指到哪张就是哪张（关联就是事实 ✓）。
   *    若按"在售"过滤，一条陈旧关联（券下架了）会让她**提交不了**这一单 ✗ —— 那是两件事。
   * @returns {{ ok:boolean, vouchers:Array<{recordId:string,name:string,status:string,
   *            faceValueCents:number,settlementCents:number}>, reason:string, error?:string }}
   */
  const loadCatalog = async () => {
    const table = gateway.table?.(settings.voucherTableKey);
    if (!table?.tableId) {
      // 没配表 ⇒ 读不到（**不是**"没有券" ✗）：调用方拦 + warn。
      return { ok: false, vouchers: [], reason: 'voucher_table_unconfigured' };
    }
    const fields = settings.voucherFields || {};
    if (!fields.faceValue || !fields.settlementAmount) {
      return { ok: false, vouchers: [], reason: 'voucher_fields_unconfigured' };
    }
    try {
      const records = await gateway.listAll(settings.voucherTableKey);
      const vouchers = (records || []).map((record) => {
        const row = record?.fields || {};
        return {
          recordId: String(record?.record_id || ''),
          name: String(row[fields.name] ?? '').trim(),
          status: String(row[fields.status] ?? '').trim(),
          faceValueCents: toCents(row[fields.faceValue]),
          settlementCents: toCents(row[fields.settlementAmount]),
        };
      }).filter((voucher) => voucher.recordId
        && voucher.faceValueCents !== null
        && voucher.settlementCents !== null);
      return { ok: true, vouchers, reason: '' };
    } catch (error) {
      return { ok: false, vouchers: [], reason: 'voucher_catalog_unreadable', error: error?.message || 'unknown' };
    }
  };

  /** 收款方式那一列（带券关联）：读不到 ⇒ `ok:false`（不静默兜底 ✗）。 */
  const loadMethods = async () => {
    if (!paymentMethods?.listWithVouchers) return { ok: false, items: [], reason: 'payment_methods_unavailable' };
    const listed = await paymentMethods.listWithVouchers();
    return listed?.ok ? { ok: true, items: listed.items || [] } : {
      ok: false, items: [], reason: listed?.reason || 'payment_methods_unreadable',
    };
  };

  /**
   * ⭐ 解析资金页那几行收款。
   *
   * @param {Array<{method:string, amount:(string|number)}>} rows 表单/会话里那几行（金额可空 ✓）
   * @returns {Promise<{ok:boolean, reason:string, notices:Array, payments:Array,
   *   voucherRows:Array, unresolved:Array, balanceDeltaCents:number, faceValueCents:number}>}
   *   · `ok:false` ⇒ 调用方**拦住这一单**（人话 + 一个字都不写）+ 我们已 warn ✓
   *   · `payments`  = 交给写服务的那几行：**券行的金额已经换成「平台结算款」** ✓（其余原样）
   *   · `balanceDeltaCents` = Σ(面值 − 结算款)：差额要按**面值**算 ⇒ 调用方把它从"货品那一侧"扣掉
   *   · `voucherRows` = 认出来的券行（method / 面值 / 结算款 / 券记录 id，供日志与测试 ✓）
   *   · `unresolved` = 认不出那张券的券行（**不许当普通收款** ✗）
   */
  const resolveRows = async (rows = []) => {
    const empty = {
      ok: true, reason: '', notices: [], payments: [], voucherRows: [], unresolved: [],
      balanceDeltaCents: 0, faceValueCents: 0,
    };
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return empty;

    const methods = await loadMethods();
    // 🔴 收款方式表**读不到** ⇒ 认不出哪条是券。按"能不能静默出错"分两种（**不猜** ✗）：
    //   · 有行的**金额是空的**（可能是券 —— 券的金额本来就可以空 ✓）⇒ **拦住这一单**：
    //     放过去要么被写层当成"没填钱"整行丢掉（券的差额就变成"一分没付" ✗），要么写一个错金额 ✗；
    //   · 每行都有金额 ⇒ **原样放行** + **大声 warn** ✓
    //     （没有"金额可空"的行 ⇒ 没有"券被静默丢掉"这条风险；真写错也会被写层
    //      `resolvePaymentMethod` 那条"收款方式管理中找不到：X"当场拒掉 ✓ 不静默 ✗）。
    if (!methods.ok) {
      // ⚠️ 只看"**选了方式、但金额空**"的行：那才可能是券（券的金额本来就可以空 ✓）。
      //   一行**方式都没选**的行只是"她没用到的那一行"（既有口径：空行不用 ✓）——不许拿它拦人 ✗。
      const emptyAmountRows = list.filter((row) => String(row?.method ?? '').trim()
        && !String(row?.amount ?? '').trim());
      warn(settings.events.methodUnmapped, {
        reason: methods.reason,
        empty_amount_rows: emptyAmountRows.length,
        hint: settings.hints.methodsUnreadable,
      });
      if (emptyAmountRows.length) {
        return { ...empty, ok: false, reason: 'payment_methods_unreadable' };
      }
      return { ...empty, payments: list.map((row) => ({ ...row })) };
    }
    // 名字 → 券记录 id（**关联列非空**才是券 ✓；同一名字只在表里有一条 —— 与写层同一条口径）
    const linkByName = new Map();
    for (const item of methods.items) {
      const name = String(item?.name || '').trim();
      if (!name) continue;
      const recordId = String(item?.voucherRecordId || '').trim();
      if (recordId) linkByName.set(name, recordId);
    }
    const voucherNames = new Set(linkByName.keys());
    // 一行都不是券 ⇒ **原样返回**（券目录一次都不读 ✓ 既有链路逐字不变 ✓ 也不多打一次飞书 ✗）
    if (!list.some((row) => voucherNames.has(String(row?.method || '').trim()))) {
      return { ...empty, payments: list.map((row) => ({ ...row })) };
    }

    const catalog = await loadCatalog();
    if (!catalog.ok) {
      warn(settings.events.catalogUnreadable, {
        reason: catalog.reason, error: catalog.error,
        hint: settings.hints.catalogUnreadable,
      });
      return { ...empty, ok: false, reason: 'voucher_catalog_unreadable' };
    }
    const byRecordId = new Map(catalog.vouchers.map((voucher) => [voucher.recordId, voucher]));
    // ⭐ 另一个方向的"缺映射"（判据 `voucherPaymentRules.test.js` 的探针就是这个方向）：
    //   券目录里**在售**、却**没有任何收款方式**关联到它 ⇒ 她根本点不到这张券。
    //   ⚠️ 这一条**不拦单**（与她这一单无关），但**必须大声**（否则"券上了、没人点得到"没人知道 ✗）。
    const linkedIds = new Set(linkByName.values());
    const unreachable = catalog.vouchers
      .filter((voucher) => voucher.status === settings.onSaleStatus && !linkedIds.has(voucher.recordId));
    if (unreachable.length) {
      warn(VOUCHER_METHOD_UNMAPPED_EVENT, {
        count: unreachable.length,
        voucher_record_ids: unreachable.map((voucher) => voucher.recordId),
        hint: settings.hints.unreachable,
      });
    }

    const payments = [];
    const voucherRows = [];
    const unresolved = [];
    let balanceDeltaCents = 0;
    let faceValueCents = 0;
    for (const row of list) {
      const method = String(row?.method || '').trim();
      const recordId = linkByName.get(method);
      if (!recordId) {
        // 不是券（或没选方式）⇒ **原样**交给写层（写法与判据一个字都不动 ✓）
        payments.push({ ...row });
        continue;
      }
      const voucher = byRecordId.get(recordId);
      if (!voucher) {
        // 🔴 是券方式、却认不出那张券 ⇒ **大声 warn** + 拦住（**绝不**静默当普通收款 ✗）
        warn(VOUCHER_METHOD_UNMAPPED_EVENT, {
          method, voucher_record_id: recordId,
          hint: settings.hints.methodUnmapped,
        });
        unresolved.push({ method, voucherRecordId: recordId });
        continue;
      }
      voucherRows.push({
        method, voucherRecordId: recordId,
        faceValueCents: voucher.faceValueCents, settlementCents: voucher.settlementCents,
        name: voucher.name,
      });
      faceValueCents += voucher.faceValueCents;
      balanceDeltaCents += voucher.faceValueCents - voucher.settlementCents;
      // 领券那一行的金额 = 【平台结算款】（**不是面值** ✗）—— 这一行是这一笔收款的事实。
      payments.push({ ...row, amount: voucher.settlementCents / 100 });
    }
    if (unresolved.length) {
      return {
        ...empty, ok: false, reason: 'voucher_method_unmapped', payments, voucherRows, unresolved,
        balanceDeltaCents, faceValueCents,
      };
    }
    return {
      ok: true, reason: '', notices: [],
      payments, voucherRows, unresolved: [], balanceDeltaCents, faceValueCents,
    };
  };

  /**
   * ⭐⭐ 差额要按【**面值**】算 ⇒ 券的「面值 − 结算款」那一截（平台抽佣）必须从**货品那一侧**扣掉。
   *
   * 为什么：差额的算法全仓只有一个 —— `salesOrderService` 的 `outstandingCents = 累计 − 已收`
   *   （`scanWriteService` 里是 `owedCents = itemsCents − paymentsCents`）。而收款行那一笔的金额
   *   已经按口径换成【平台结算款】了 ⇒ 若不扣，差额会算成 `货品 − 结算款` ✗（她例：300 − 47.40
   *   = **252.60** ✗；口径是 **200** ✓）。
   *
   * 算式与**群聊先例逐字同形**（`services/groupBuyVoucherPolicy.js:83`）：
   *   `netCents = cashCents + settlementCents` ≡ `成交额 − 面值 + 结算款` ≡ `成交额 − (面值 − 结算款)` ✓
   *   ⇒ 「货品那一侧」= 成交额 − (面值 − 结算款) = 店里**实际拿到的净额**（客户补的 + 平台结算的）。
   *
   * 落法：从**第一行有金额的那一行**起逐行往下扣（券是**整单**级的、行是明细级的 ⇒ 谁先填谁先扣，
   *   顺序确定、总额不丢 ✓）；单行不够就继续扣下一行 ✓；**绝不扣成负数** ✗
   *   （扣不下的部分如实回传 `unappliedCents`，由调用方去说人话 —— **不静默丢一笔钱** ✗）。
   *
   * @returns {{ amounts:Array<string>, appliedCents:number, unappliedCents:number }}
   */
  const adjustLineAmounts = (lineAmounts = [], balanceDeltaCents = 0) => {
    const list = Array.isArray(lineAmounts) ? [...lineAmounts] : [];
    let remain = Math.max(0, Math.round(Number(balanceDeltaCents) || 0));
    const wanted = remain;
    for (let index = 0; index < list.length && remain > 0; index += 1) {
      const raw = String(list[index] ?? '').trim();
      if (!raw) continue;
      const cents = toCents(raw);
      if (cents === null || cents <= 0) continue;
      const take = Math.min(cents, remain);
      remain -= take;
      list[index] = String((cents - take) / 100);
    }
    return { amounts: list, appliedCents: wanted - remain, unappliedCents: remain };
  };

  return { resolveRows, adjustLineAmounts, loadCatalog, loadMethods, settings };
};

module.exports = { createVoucherPaymentService, VOUCHER_METHOD_UNMAPPED_EVENT, VOUCHER_CATALOG_UNREADABLE_EVENT };
