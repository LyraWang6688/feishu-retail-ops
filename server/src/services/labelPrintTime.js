'use strict';

/**
 * 鞋盒标签「打印时间」的唯一格式化入口。
 * 固定上海时区；格式 YYYY-MM-DD HH:mm（一行，年月日 + 具体时刻）。
 */
const formatPrintTime = (date = new Date(), config = {}) => {
  const timeZone = String(config?.timeZone || 'Asia/Shanghai');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const valueOf = (type) => parts.find((part) => part.type === type)?.value || '';
  const year = valueOf('year');
  const month = valueOf('month');
  const day = valueOf('day');
  const hour = valueOf('hour');
  const minute = valueOf('minute');
  if (!year || !month || !day || !hour || !minute) throw new Error('打印时间格式化失败');
  return year + '-' + month + '-' + day + ' ' + hour + ':' + minute;
};

module.exports = { formatPrintTime };
