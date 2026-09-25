const { V1BitableGateway } = require('./v1BitableGateway');
const { V1ReferenceResolver } = require('./v1ReferenceResolver');
const { SalesOrderService } = require('./salesOrderService');
const { PurchasePostingService } = require('./purchasePostingService');

// Compatibility facade for the robot card handler. Sales and purchase posting
// have separate owners. Stock changes happen only through InventoryService:
// after explicit sales delivery or confirmed purchase arrival.
class V1PostingService {
  constructor(options = {}) {
    const gateway = options.gateway || new V1BitableGateway();
    const references = options.references || new V1ReferenceResolver(gateway);
    this.sales = options.sales || new SalesOrderService({ gateway, references });
    this.purchase = options.purchase || new PurchasePostingService({
      gateway, references, inventory: options.inventory,
      enablePurchaseInventory: options.enablePurchaseInventory,
    });
  }

  postSale(input) { return this.sales.confirm(input); }
  postPurchase(input) { return this.purchase.post(input); }
}

module.exports = { V1PostingService };
