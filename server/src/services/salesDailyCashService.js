'use strict';

/**
 * 「销售 → 每日现金」读写服务。
 *
 * 口径（业务负责人 2026-11-21）：
 *   · 每天营业前填期初金额（写「开门零钱」）；
 *   · 当天没有记录 ⇒ 创建一条，销售日 = 今天；
 *   · 当天已有记录 ⇒ 修改同一条（期初金额 / 关店时拿走现金）；
 *   · 「关门零钱」是公式，「销售金额」是 lookup，只读展示，不写。
 */
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { SALES_DAILY_CASH } = require('../config/salesDailyCash');
const { textValue } = require('./v1BitableGateway');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');

const num = (value) => {
  const parsed = Number(textValue(value).replace(/,/g, '').replace(/¥/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
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
const startOfDayIso = (day) => `${day}T00:00:00+08:00`;

const createSalesDailyCashService = ({
  gateway, config = SALES_DAILY_CASH, now = () => new Date(),
} = {}) => {
  if (!gateway) throw new Error('SalesDailyCashService requires gateway');
  const table = V1_BITABLE_SCHEMA.tables.salesSummary;
  const fields = table.fields;
  const readOnly = table.readOnlyFields || {};
  const queue = new KeyedSerialQueue();
  const fieldName = (semantic) => fields[semantic] || readOnly[semantic]?.name || '';

  const mapRecord = (record, date) => {
    if (!record) return null;
    const values = record.fields || {};
    return {
      record_id: record.record_id,
      date,
      opening_amount: num(values[fieldName('openingCash')]),
      withdrawal_amount: num(values[fieldName('withdrawalCash')]),
      realtime_amount: num(values[fieldName('closingCash')]),
      sales_amount: num(values[fieldName('salesAmount')]),
    };
  };

  const findToday = async (day) => {
    const records = await gateway.listAll('salesSummary');
    return (records || []).find((record) => dayKeyOf(record?.fields?.[fieldName('saleDate')], config.timeZone) === day) || null;
  };

  const getToday = async () => {
    const day = todayKeyOf(now(), config.timeZone);
    const record = await findToday(day);
    return { date: day, record: mapRecord(record, day) };
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
      if (opening !== undefined) patch[fieldName('openingCash')] = opening;
      if (withdrawal !== undefined) patch[fieldName('withdrawalCash')] = withdrawal;
      if (!record) {
        if (opening === undefined) {
          const error = new Error('opening_amount_required');
          error.statusCode = 400;
          throw error;
        }
        const created = await gateway.create('salesSummary', {
          [fieldName('saleDate')]: startOfDayIso(day),
          ...patch,
        });
        record = { record_id: created.recordId || created.record_id };
      } else {
        await gateway.update('salesSummary', record.record_id, patch);
      }
      const fresh = await gateway.get('salesSummary', record.record_id);
      return { date: day, record: mapRecord(fresh || record, day) };
    });
  };

  return { getToday, save };
};

module.exports = { createSalesDailyCashService };
