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
      tableName: '销售录单',
      tableId: getEnv('FEISHU_V1_SALES_ENTRY_TABLE_ID', 'tblLjFe3NjU61xKB'),
      fields: {
        orderNo: '销售单号',
        originalText: '原文',
        sender: '发送人',
        sentAt: '发送时间',
        parseStatus: '解析状态',
        confirmStatus: '确认状态',
        editedAt: '消息编辑时间',
        parseSummary: '解析结果摘要',
        failureReason: '失败原因',
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
        paidAmount: '实付金额',
        gift: '赠品',
        paymentMethod: '支付方式',
        soldAt: '销售日',
        salesEntry: '销售单号',
        behavior: '销售行为',
      },
    },
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
    purchaseInbound: {
      tableName: '采购入库',
      tableId: getEnv('FEISHU_V1_PURCHASE_INBOUND_TABLE_ID', 'tblK3Uzd0nN1GJrr'),
      fields: {
        detailId: '入库明细ID',
        size: '尺码',
        quantity: '数量',
        operator: '录入人员',
        confirmed: '入库确认',
        batch: '采购到货批次',
        supplierOrder: '关联供应商报单',
        product: '编号',
        inboundAt: '实际入库时间',
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
        quantityChange: '数量变化',
        salesDetail: '关联销售明细',
        purchaseInbound: '关联采购入库',
        occurredAt: '发生时间',
      },
    },
    liveInventory: {
      tableName: '实时库存',
      tableId: getEnv('FEISHU_V1_LIVE_INVENTORY_TABLE_ID', 'tblTr5qgiZXPADLP'),
      fields: {
        stockKey: '库存键',
        product: '编号',
        size: '尺码',
        quantity: '数量',
        updatedAt: '更新时间',
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
