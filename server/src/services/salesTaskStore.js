const path = require('path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');

const defaultTaskDir = path.join(__dirname, '../../data/sales_tasks');

// Legacy compatibility wrapper. New Feishu code depends on JsonTaskStore, so
// this file can later be removed together with the old mini-program sales API.
class SalesTaskStore extends JsonTaskStore {
  constructor(options = {}) {
    super({ dir: options.dir || defaultTaskDir, idField: 'task_id' });
  }
}

module.exports = {
  SalesTaskStore,
  defaultTaskDir,
};
