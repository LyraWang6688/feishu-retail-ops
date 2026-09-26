const getEnv = (key, fallback = '') => process.env[key] || fallback;

const V1_BITABLE_SCHEMA = {
  appToken: getEnv('FEISHU_V1_BITABLE_APP_TOKEN', 'QrXlbwXMLaJ2TNsxSfFcIA3rnwh'),
  tables: {
    product: {
      tableName: '货品信息',
      tableId: getEnv('FEISHU_V1_PRODUCT_TABLE_ID', 'tbl9z4Oi8Vc57Kin'),
      fields: {
        number: '编号',
        itemNo: '货号',
        color: '颜色',
        price: '单价',
        cost: '成本',
        status: '货品状态',
        supplier: '供应商',
      },
    },
    behavior: {
      tableName: '行为管理',
      tableId: getEnv('FEISHU_V1_BEHAVIOR_TABLE_ID', 'tblbTvUT4AFsCK4K'),
      fields: {
        name: '行为名称',
        code: '行为编码',
        stockDirection: '库存方向',
        moneyDirection: '资金方向',
        enabled: '是否启用',
      },
    },
    paymentMethod: {
      tableName: '收款方式管理',
      tableId: getEnv('FEISHU_V1_PAYMENT_METHOD_TABLE_ID', 'tblH7YzA1v5vJzEi'),
      fields: {
        name: '收款方式',
      },
    },
    supplier: {
      tableName: '供应商管理',
      tableId: getEnv('FEISHU_V1_SUPPLIER_TABLE_ID', 'tblFfXkLct2ZIGGq'),
      fields: {
        name: '供应商名称',
      },
    },
    salesEntry: {
      tableName: '销售主表',
      tableId: getEnv('FEISHU_V1_SALES_ENTRY_TABLE_ID', 'tblLjFe3NjU61xKB'),
      fields: {
        orderNo: '销售单号',
        originalText: '原文',
        sender: '发送人',
        sentAt: '发送时间',
        parseStatus: '解析状态',
        confirmStatus: '确认状态',
        parseSummary: '解析结果摘要',
        failureReason: '失败原因',
        orderStatus: '订单状态',
        fulfillmentStatus: '履约状态',
        paymentStatus: '收款状态',
      },
    },
    salesDetail: {
      tableName: '销售明细',
      tableId: getEnv('FEISHU_V1_SALES_DETAIL_TABLE_ID', 'tblxW5WMKDULyolA'),
      fields: {
        detailId: '销售明细ID',
        product: '编号',
        quantity: '数量',
        size: '尺码',
        gift: '赠品',
        soldAt: '销售日',
        salesEntry: '销售单号',
        deliveredQuantity: '交付数量',
        actualAmount: '成交金额',
        receivableAmount: '应收金额',
      },
    },
    paymentRecord: {
      tableName: '收款记录',
      tableId: getEnv('FEISHU_V1_PAYMENT_RECORD_TABLE_ID', 'tblTpLOtTLhWxXvm'),
      fields: {
        recordNo: '收款记录ID',
        salesEntry: '关联销售单',
        method: '支付方式',
        amount: '收款金额',
        status: '收款状态',
        receivedAt: '收款时间',
        operator: '操作人',
      },
    },
    // Legacy private-chat purchase intake table. Kept for the frozen path.
    purchaseBatch: {
      tableName: '采购到货批次',
      tableId: getEnv('FEISHU_V1_PURCHASE_BATCH_TABLE_ID', 'tblvLOXKESNTbZ7v'),
      fields: {
        batchNo: '到货批次号',
        originalImages: '原始图片',
        sender: '发送人',
        recognitionStatus: '识别状态',
        confirmStatus: '确认状态',
        arrivalDate: '到货日',
        supplier: '供应商',
        failureReason: '识别失败原因',
        messageIds: '飞书消息ID列表',
      },
    },
    purchaseReport: {
      tableName: '供应商报单',
      tableId: getEnv('FEISHU_V1_PURCHASE_REPORT_TABLE_ID', 'tblo0ffzFt7vyQw2'),
      fields: {
        batchNoText: '报货批次号', detailId: '明细ID', behavior: '采购行为',
        product: '编号', description: '报单说明', reportedAt: '报单时间', operator: '经办人',
        status: '处理状态', failureReason: '解析失败原因', request: '关联采购申请',
      },
    },
    purchaseRequest: {
      tableName: '采购申请',
      tableId: getEnv('FEISHU_V1_PURCHASE_REQUEST_TABLE_ID', 'tbli1ygPtss5CWCH'),
      fields: {
        batchNo: '报货批次号', behavior: '采购行为', product: '编号', size: '尺码', quantity: '数量',
        arrivalStatus: '到货状态',
      },
    },
    purchaseArrival: {
      tableName: '采购到货',
      tableId: getEnv('FEISHU_V1_PURCHASE_ARRIVAL_TABLE_ID', 'tblvLOXKESNTbZ7v'),
      fields: {
        arrivalAt: '到货日', images: '鞋盒图片', batch: '报货批次号', inspector: '验收人',
        recognitionStatus: '识别状态', confirmStatus: '确认状态', failureReason: '识别失败原因',
      },
    },
    purchaseOrderBatch: {
      tableName: '报货批次',
      // Current V1 tenant default; forks can override it with the environment variable.
      tableId: getEnv('FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID', 'tblwezby9wRea9qi'),
      fields: { batchNo: '报货批次号', createdAt: '创建时间', creator: '创建人' },
    },
    purchaseInbound: {
      tableName: '采购入库',
      tableId: getEnv('FEISHU_V1_PURCHASE_INBOUND_TABLE_ID', 'tblK3Uzd0nN1GJrr'),
      fields: {
        detailId: '入库明细ID',
        behavior: '采购行为',
        size: '尺码',
        quantity: '数量',
        batch: '采购到货批次',
        supplierOrder: '采购申请',
        product: '编号',
        inboundAt: '入库时间',
        unitCost: '入库单价',
        amount: '入库金额',
      },
    },
    inventoryLedger: {
      tableName: '库存流水',
      tableId: getEnv('FEISHU_V1_INVENTORY_LEDGER_TABLE_ID', 'tbl7Xo4OPmaN2NdP'),
      fields: {
        ledgerNo: '库存流水号',
        product: '编号',
        size: '尺码',
        quantityChange: '变动数量',
        behavior: '库存行为',
        salesDetail: '关联销售',
        purchaseInbound: '关联采购',
        occurredAt: '发生时间',
        stockKey: '库存键',
      },
    },
    liveInventory: {
      tableName: '实时库存',
      tableId: getEnv('FEISHU_V1_LIVE_INVENTORY_TABLE_ID', 'tblTr5qgiZXPADLP'),
      fields: {
        stockKey: '库存键',
        product: '编号',
        size: '尺码',
        updatedAt: '更新时间',
        state: '所属状态',
      },
    },
  },
};

const getV1Table = (tableKey) => {
  const table = V1_BITABLE_SCHEMA.tables[tableKey];
  if (!table) throw new Error(`Unknown V1 table: ${tableKey}`);
  return table;
};

module.exports = {
  V1_BITABLE_SCHEMA,
  getV1Table,
};
