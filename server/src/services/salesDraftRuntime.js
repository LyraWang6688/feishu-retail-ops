'use strict';
const { createSalesDraftService } = require('./salesDraftService');

let singleton = null;

const getSalesDraftService = () => {
  if (!singleton) singleton = createSalesDraftService();
  return singleton;
};

const setSalesDraftServiceForTests = (service) => { singleton = service || null; };

module.exports = { getSalesDraftService, setSalesDraftServiceForTests };
