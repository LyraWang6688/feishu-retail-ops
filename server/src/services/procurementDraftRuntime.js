'use strict';
const { createProcurementDraftService } = require('./procurementDraftService');

let singleton = null;

const getProcurementDraftService = () => {
  if (!singleton) singleton = createProcurementDraftService();
  return singleton;
};
const setProcurementDraftServiceForTests = (service) => { singleton = service || null; };

module.exports = { getProcurementDraftService, setProcurementDraftServiceForTests };
