const { logWarn } = require('../utils/logger');

const isDataNotReady = (error) => {
  const code = error?.response?.data?.code ?? error?.data?.code ?? error?.code;
  if (Number(code) === 1254607) return true;
  return /1254607|data not ready|数据未准备好/i.test(String(
    error?.response?.data?.msg || error?.message || error || '',
  ));
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// Only retry reads. Retrying an ambiguous create/delete response could write twice.
const withSalesReadRetry = async (read, operation, options = {}) => {
  const delays = options.delays || [0, 1000, 3000];
  const sleep = options.sleep || wait;
  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) await sleep(delays[attempt]);
    try {
      return await read();
    } catch (error) {
      if (!isDataNotReady(error) || attempt === delays.length - 1) throw error;
      logWarn('sales.read.retry', { operation, attempt: attempt + 1, delay_ms: delays[attempt + 1] });
    }
  }
};

module.exports = { isDataNotReady, withSalesReadRetry };
