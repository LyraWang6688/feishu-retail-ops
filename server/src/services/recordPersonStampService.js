'use strict';

const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { PERSON_FIELDS } = require('../config/personFields');
const { personPatch, normalizeOpenId } = require('./personFieldService');
const { person } = require('./v1ReferenceResolver');

const LEGACY_PERSON_FIELDS = Object.freeze({
  // 产品上新员不在本次 7 个字段内；保留既有事件补写，不影响本次统一范围。
  product: Object.freeze({ newStaff: Object.freeze({ field: 'newStaff', mode: 'set' }) }),
});



const operatorOf = (action) => normalizeOpenId(
  action?.operator_id || action?.operatorId || action?.operator,
);

/** 表单/事件创建记录时，把飞书事件里的实际操作人写到人员字段。 */
const createRecordPersonStampService = ({ gateway } = {}) => {
  const handle = async (tableKey, actionList = []) => {
    const fields = PERSON_FIELDS[tableKey] || LEGACY_PERSON_FIELDS[tableKey];
    if (!fields) return [];
    const table = V1_BITABLE_SCHEMA.tables?.[tableKey];
    if (!gateway || !table) return [];
    const written = [];
    for (const action of Array.isArray(actionList) ? actionList : []) {
      if (action?.action !== 'record_added' || !action?.record_id) continue;
      const operatorOpenId = operatorOf(action);
      if (!operatorOpenId) continue;
      for (const [fieldKey, policy] of Object.entries(fields)) {
        const patch = PERSON_FIELDS[tableKey]
          ? personPatch({ tableKey, fieldKey, operatorOpenId })
          : { [fieldKey]: person(operatorOpenId) };
        if (!Object.keys(patch).length) continue;
        await gateway.update(tableKey, action.record_id, patch);
        written.push({
          tableKey,
          recordId: action.record_id,
          field: table.fields?.[policy.field] || policy.field,
          operatorOpenId,
        });
      }
    }
    return written;
  };
  return { handle };
};

module.exports = { createRecordPersonStampService, operatorOf };
