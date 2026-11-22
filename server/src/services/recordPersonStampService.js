'use strict';

const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { person } = require('./v1ReferenceResolver');

const PERSON_FIELDS = Object.freeze({
  product: 'newStaff',
  labelPrintRequest: 'printedBy',
});

const operatorOf = (action) => {
  const value = action?.operator_id || action?.operatorId || action?.operator;
  if (typeof value === 'string') return value.trim();
  return String(value?.open_id || value?.openId || '').trim();
};

/** 表单/事件创建记录时，把飞书事件里的实际操作人写到人员字段。 */
const createRecordPersonStampService = ({ gateway } = {}) => {
  const handle = async (tableKey, actionList = []) => {
    const semanticKey = PERSON_FIELDS[tableKey];
    const field = V1_BITABLE_SCHEMA.tables?.[tableKey]?.fields?.[semanticKey];
    if (!gateway || !field) return [];
    const written = [];
    for (const action of Array.isArray(actionList) ? actionList : []) {
      if (action?.action !== 'record_added' || !action?.record_id) continue;
      const operatorOpenId = operatorOf(action);
      if (!operatorOpenId) continue;
      // gateway 的 values 用**语义键**，由 v1BitableSchema 映射成物理列名。
      // 这里传「上新员 / 打印者」会被 gateway 判成未配置语义字段。
      await gateway.update(tableKey, action.record_id, { [semanticKey]: person(operatorOpenId) });
      written.push({ tableKey, recordId: action.record_id, field, operatorOpenId });
    }
    return written;
  };
  return { handle };
};

module.exports = { createRecordPersonStampService, operatorOf };
