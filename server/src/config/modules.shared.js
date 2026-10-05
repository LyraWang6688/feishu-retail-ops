const MODULES = {
  "purchase": {
    "key": "purchase",
    "label": "采购",
    "writeMode": "upsert_accumulate",
    "fields": {
      "hasSupplier": true,
      "hasSalesManual": false,
      "includeSkuCode": true
    },
    "sync": {
      "payloadMode": "aggregate_by_sku"
    }
  },
  "sales": {
    "key": "sales",
    "label": "销售",
    "writeMode": "create_detail",
    "fields": {
      "hasSupplier": false,
      "hasSalesManual": true,
      "includeSkuCode": false
    },
    "sync": {
      "payloadMode": "detail_rows"
    }
  },
  "inventory": {
    "key": "inventory",
    "label": "库存",
    "writeMode": "upsert_accumulate",
    "fields": {
      "hasSupplier": false,
      "hasSalesManual": false,
      "includeSkuCode": true
    },
    "sync": {
      "payloadMode": "aggregate_by_sku"
    }
  }
};

module.exports = { MODULES };
