const { V1BitableGateway } = require('./v1BitableGateway');
const { V1ReferenceResolver } = require('./v1ReferenceResolver');
const { SalesOrderService } = require('./salesOrderService');

// Compatibility facade for the robot card handler. Stock changes happen only
// through InventoryService: after explicit sales delivery or confirmed purchase arrival.
// 采购入库由 PurchaseWebhookService 自己负责（记录变更事件驱动），不经过这里。
class V1PostingService {
  constructor(options = {}) {
    const gateway = options.gateway || new V1BitableGateway();
    const references = options.references || new V1ReferenceResolver(gateway);
    this.sales = options.sales || new SalesOrderService({ gateway, references });
  }

  postSale(input) { return this.sales.confirm(input); }
}

module.exports = { V1PostingService };
