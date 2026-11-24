'use strict';

/**
 * 自建配品销售建单（2026-11-24）。
 *
 * 结构：
 *   1 条 S交易明细（整单金额 / 收款方式 / 实际录单人）
 *   N 条「配品销售」明细（名称 / 数量 / 交易明细关联 / 录单人 / 销售日）
 *
 * 编号：
 *   S交易明细号 PX-YYYYMMDD-NNNN（复用 salesOrderNo 的日期 + 当天序号 + 撞号重试）
 *   明细号 = S交易明细号-01/-02（不单独取号）
 */
const { allocateSalesOrderNo } = require('./salesOrderNo');
const { personPatch } = require('./personFieldService');
const { relation } = require('./v1ReferenceResolver');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { textValue } = require('./v1BitableGateway');
const { ACCESSORY_SALE } = require('../config/accessorySale');

const POSITIVE_INT = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const createAccessorySaleOrderService = ({ gateway, now = () => Date.now() } = {}) => {
  if (!gateway) throw new Error('AccessorySaleOrderService requires gateway');
  const payment = V1_BITABLE_SCHEMA.tables.paymentRecord;
  const detail = V1_BITABLE_SCHEMA.tables.accessorySale;
  if (!payment?.tableId || !detail?.tableId) throw new Error('配品销售表未配置');

  const listReceiptIds = async () => {
    const records = await gateway.listAll('paymentRecord');
    return (records || []).map((record) => textValue(record.fields?.[payment.fields.receiptId])).filter(Boolean);
  };

  const create = async ({
    items = [], amount, methodRecordId = '', saleDate = 0, operatorOpenId = '', correlation = {},
  } = {}) => {
    const list = (Array.isArray(items) ? items : []).map((item) => ({
      accessoryRecordId: String(item?.accessoryRecordId || '').trim(),
      quantity: POSITIVE_INT(item?.quantity),
    }));
    if (!list.length || list.some((item) => !item.accessoryRecordId || !item.quantity)) {
      return { ok: false, code: 'invalid_items' };
    }
    const unique = new Set(list.map((item) => item.accessoryRecordId));
    if (unique.size !== list.length) return { ok: false, code: 'duplicate_item' };
    const total = Number(amount);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, code: 'invalid_amount' };
    if (!methodRecordId) return { ok: false, code: 'method_missing' };
    const occurredAt = Number(saleDate) > 0 ? Number(saleDate) : now();

    let paymentRecordId = '';
    let orderNo = '';
    const allocation = await allocateSalesOrderNo({
      prefix: 'PX',
      now: new Date(now()),
      readExistingNos: listReceiptIds,
      writeOrderNo: async (candidate) => {
        if (!paymentRecordId) {
          const created = await gateway.create('paymentRecord', {
            method: relation(methodRecordId),
            amount: total,
            tradeDirection: ACCESSORY_SALE.direction,
            status: ACCESSORY_SALE.status,
            receivedAt: occurredAt,
            receiptId: candidate,
          }, { correlation });
          paymentRecordId = String(created?.recordId || '').trim();
          orderNo = candidate;
          return;
        }
        await gateway.update('paymentRecord', paymentRecordId, { receiptId: candidate }, { correlation });
        orderNo = candidate;
      },
    });
    if (!paymentRecordId) return { ok: false, code: 'payment_create_failed' };

    const rows = list.map((item, index) => ({
      orderNo: orderNo + '-' + String(index + 1).padStart(2, '0'),
      item: relation(item.accessoryRecordId),
      quantity: item.quantity,
      payment: relation(paymentRecordId),
      saleDate: occurredAt,
      ...personPatch({
        tableKey: 'accessorySale', fieldKey: 'operator', operatorOpenId,
      }),
    }));
    let created;
    try {
      created = await gateway.createBatch('accessorySale', rows, { correlation });
    } catch (error) {
      return {
        ok: false, code: 'detail_create_failed', orderNo, paymentRecordId,
        error: String(error?.message || error),
      };
    }
    return {
      ok: true,
      orderNo,
      paymentRecordId,
      details: (created || []).map((row, index) => ({
        recordId: row?.recordId || '',
        orderNo: rows[index].orderNo,
      })),
      sequence: allocation.sequence,
    };
  };

  return { create };
};

module.exports = { createAccessorySaleOrderService };
