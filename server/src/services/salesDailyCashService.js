'use strict';

/**
 * 「销售 → 每日现金」读写服务。
 *
 * 口径（业务负责人 2026-11-21）：
 *   · 每天营业前填期初金额（写「开门现金」）；
 *   · 当天没有记录 ⇒ 创建一条，销售日 = 今天；
 *   · 当天已有记录 ⇒ 修改同一条（期初金额 / 关店时拿走现金）；
 *   · 「入账现金」是 lookup、「实时现金」是公式，只读展示，不写。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_DAILY_CASH } = require('../config/salesDailyCash');
const { textValue } = require('./v1BitableGateway');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');

const num = (value) => {
  const parsed = Number(textValue(value).replace(/,/g, '').replace(/¥/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};
const optionalNum = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(textValue(value).replace(/,/g, '').replace(/¥/g, '').trim());
  return Number.isFinite(parsed) ? parsed : null;
};
const dayKeyOf = (value, timeZone) => {
  if (value == null || value === '') return '';
  const date = value instanceof Date ? value : new Date(typeof value === 'number'
    ? (value < 1e12 ? value * 1000 : value) : String(value));
  if (Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const todayKeyOf = (now, timeZone) => dayKeyOf(now, timeZone);
const previousDayKeyOf = (day) => {
  const [year, month, date] = String(day || '').split('-').map(Number);
  if (!year || !month || !date) return '';
  const value = new Date(Date.UTC(year, month - 1, date));
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
};


const createSalesDailyCashService = ({
  gateway, config = SALES_DAILY_CASH, now = () => new Date(),
} = {}) => {
  if (!gateway) throw new Error('SalesDailyCashService requires gateway');
  const table = V1_BITABLE_SCHEMA.tables.salesSummary;
  const fields = table.fields;
  const readOnly = table.readOnlyFields || {};
  const queue = new KeyedSerialQueue();
  const fieldName = (semantic) => fields[semantic] || readOnly[semantic]?.name || '';

  const mapRecord = (record) => {
    if (!record) return null;
    const values = record.fields || {};
    const withdrawalRaw = values[fieldName('withdrawalCash')];
    return {
      opening_amount: num(values[fieldName('openingCash')]),
      withdrawal_amount: num(withdrawalRaw),
      // 空 = 还没保存过拿走金额；0 是用户明确保存过的值。
      withdrawal_saved: withdrawalRaw !== undefined && withdrawalRaw !== null
        && textValue(withdrawalRaw).trim() !== '',
      received_amount: num(values[fieldName('receivedCash')]),
      realtime_amount: num(values[fieldName('closingCash')]),
      retained_amount: optionalNum(values[fieldName('retainedCash')]),
      douyin_settlement_amount: num(values[fieldName('douyinSettlement')]),
      douyin_settlement_status: textValue(values[fieldName('settlementStatus')]).trim(),
    };
  };

  const findToday = async (day) => {
    const records = await gateway.listAll('salesSummary');
    return (records || []).find((record) => dayKeyOf(record?.fields?.[fieldName('saleDate')], config.timeZone) === day) || null;
  };

  const getToday = async () => {
    const day = todayKeyOf(now(), config.timeZone);
    const records = await gateway.listAll('salesSummary');
    const byDay = (wanted) => (records || []).find((record) => dayKeyOf(record?.fields?.[fieldName('saleDate')], config.timeZone) === wanted) || null;
    const record = byDay(day);
    const yesterday = previousDayKeyOf(day);
    const previous = yesterday ? byDay(yesterday) : null;
    const retained = previous ? optionalNum(previous.fields?.[fieldName('retainedCash')]) : null;
    return {
      date: day,
      record: mapRecord(record),
      reference: retained === null ? null : { date: yesterday, retained_amount: retained },
    };
  };

  const normalizeAmount = (value, label) => {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(String(value).replace(/,/g, '').replace(/¥/g, '').trim());
    if (!Number.isFinite(number) || number < 0 || number > config.maxAmount) {
      const error = new Error(`${label}_invalid`);
      error.statusCode = 400;
      throw error;
    }
    return Math.round(number * 100) / 100;
  };

  const save = async ({ openingAmount, withdrawalAmount } = {}) => {
    const opening = normalizeAmount(openingAmount, 'opening_amount');
    const withdrawal = normalizeAmount(withdrawalAmount, 'withdrawal_amount');
    if (opening === undefined && withdrawal === undefined) {
      const error = new Error('amount_required');
      error.statusCode = 400;
      throw error;
    }
    const day = todayKeyOf(now(), config.timeZone);
    return queue.run(`sales-daily-cash:${day}`, async () => {
      let record = await findToday(day);
      const patch = {};
      // 写库只传网关语义键；物理列名只用于读结果。
      if (opening !== undefined) patch.openingCash = opening;
      if (withdrawal !== undefined) patch.withdrawalCash = withdrawal;
      if (!record) {
        if (opening === undefined) {
          const error = new Error('opening_amount_required');
          error.statusCode = 400;
          throw error;
        }
        // 销售日由飞书自动生成，代码不写（写了会触发 DatetimeFieldConvFail）。
        const created = await gateway.create('salesSummary', { ...patch });
        record = { record_id: created.recordId || created.record_id };
      } else {
        await gateway.update('salesSummary', record.record_id, patch);
      }
      const fresh = await gateway.get('salesSummary', record.record_id);
      return { date: day, record: mapRecord(fresh || record) };
    });
  };

  return { getToday, save };
};

module.exports = { createSalesDailyCashService };
