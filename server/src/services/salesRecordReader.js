const { linkedRecordIds } = require('./v1BitableGateway');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// A just-created Bitable relation can be temporarily absent from a read.
// Validate the exact record ID, with a small bounded retry, instead of using
// a whole-table list as proof that a newly written row belongs to an order.
const readSaleLinkedRecord = async (gateway, tableKey, recordId, linkField, salesEntryRecordId) => {
  let lastError;
  for (const delay of [0, 250, 750]) {
    if (delay) await wait(delay);
    try {
      const record = await gateway.get(tableKey, recordId);
      if (record && linkedRecordIds(record.fields?.[linkField]).includes(salesEntryRecordId)) return record;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  throw new Error(`${gateway.table(tableKey).tableName} ${recordId} 不属于此订单`);
};

module.exports = { readSaleLinkedRecord };
