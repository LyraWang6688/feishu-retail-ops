const getEnv = (key, fallback = '') => process.env[key] || fallback;

// 目标多维表格不再有硬编码兜底：读不到就明确报错。此前默认值指向生产 Base，
// 任何漏配环境变量的场合都会静默写到生产，比如本地脚本和自动化测试。
// 这里用取值函数而不是模块级常量，是为了不在 import 阶段就抛错——只有真正
// 要访问多维表格的调用路径才需要这个变量。
const readAppToken = (env = process.env) => {
  const token = String(env.FEISHU_V1_BITABLE_APP_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      '缺少环境变量 FEISHU_V1_BITABLE_APP_TOKEN：无法确定目标多维表格。' +
      '请在 .env 中显式配置该 Base，本配置不再回退到任何默认值。',
    );
  }
  return token;
};

const V1_BITABLE_SCHEMA = {
  get appToken() {
    return readAppToken();
  },
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
        // 「类别」是单选，选项就是 A（男鞋）/ B（女鞋）两个字。
        // 到货识别出新品时按标签上的「品名」填；识别不出留空——默认成 A 会把女鞋
        // 写进男鞋，比空着更难发现。
        category: '类别',
        // 「信息是否齐备」是飞书里的公式：齐备时返回「齐备」，否则返回缺的字段名
        // （例如「成本」或「单价、成本、品类」）。销售确认卡片据此提示她补资料。
        //
        // ⚠️ 字段一旦改名，这里必须跟着改成新名，否则**静默读不到**、第三区永远不出现。
        // 这个字段曾叫「信息是否齐备」，2026-10-05 被改名为「缺失信息说明」，
        // 记录 API 返回的 fields 键和 schema 校验比较的都是**当前字段名**。
        // 那次改名正是被 deploy_build.sh 的 schema 校验拦下的（报「缺少 V1 字段」），
        // 所以改字段名以后一定要重跑一遍闸门。
        completeness: '缺失信息说明',
        // 「样例图」是附件字段，不在齐备公式里，要单独判断"有没有图"。
        sampleImage: '样例图',
      },
    },
    // 「颜色管理」：货品信息的「颜色」是**关联字段**，不是文本。
    // 给新品自动建档时必须按颜色名找到对应记录；颜色表里没有的颜色要先新建一条
    // （并告知用户），否则新品建不了档。
    color: {
      tableName: '颜色管理',
      tableId: getEnv('FEISHU_V1_COLOR_TABLE_ID', 'tblZ947YJkRwgo3k'),
      fields: { name: '颜色' },
    },
    // 「品类管理」：货品信息的「品类」也是关联字段。
    // 「类别」是它的适用类别（A=男鞋 / B=女鞋），建档时可用作参考。
    category: {
      tableName: '品类管理',
      tableId: getEnv('FEISHU_V1_CATEGORY_TABLE_ID', 'tbleM3qxsw8s8jAI'),
      fields: { name: '品类', category: '类别' },
    },
    // 配品（腰带、鞋油、袜子、包等）：没有尺码、不跟踪库存，销售明细里用它自己的关联字段。
    // 表 ID 没有默认值：不同租户这张表不同，未配置时销售只支持鞋。
    accessory: {
      tableName: '其他配品',
      tableId: getEnv('FEISHU_V1_ACCESSORY_TABLE_ID'),
      fields: {
        name: '名称',
        category: '种类',
        price: '单价',
        cost: '成本',
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
    sizeManagement: {
      tableName: '尺码管理',
      tableId: getEnv('FEISHU_V1_SIZE_TABLE_ID'),
      fields: { size: '尺码' },
    },
    // 团购券的售价 / 面值 / 平台结算款由运营在飞书里维护，代码不写死券种。
    // 刻意不放进 V1_SCHEMA_SCOPES：它是**可选**配置，未配置或读不到时券的说法会落到
    // "未配置结算金额，请补充"的追问上（不会写一个错的金额），不该把部署闸门拦下来。
    groupBuyVoucher: {
      tableName: '团购券管理',
      tableId: getEnv('FEISHU_V1_GROUP_BUY_VOUCHER_TABLE_ID', 'tblz2kM1CIGkcWsM'),
      fields: {
        name: '券名称',
        purchasePrice: '售价',
        faceValue: '面值',
        settlementAmount: '平台结算款',
        status: '销售状态',
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
        // 真实表里的字段名是「原话」（schema-check 抓出来的漂移：代码一直写成「原文」，
        // 线上写销售主表就会 FieldNameNotFound）。
        originalText: '原话',
        sender: '录单人',
        // Automatic creation time: read-only fallback for workbench date filters.
        recordedAt: '录单日',
        parseStatus: '解析状态',
        confirmStatus: '确认状态',
        parseSummary: '解析结果摘要',
        failureReason: '失败原因',
        orderStatus: '订单状态',
        // 关联「行为管理」里的现货销售 / 未付销售 / 预付销售。交易类型决定交付状态；
        // 落成关联是为了可筛可查、可对账，也让销售与库存行为共用同一张配置表。
        tradeType: '交易类型',
      },
    },
    salesDetail: {
      tableName: '销售明细',
      tableId: getEnv('FEISHU_V1_SALES_DETAIL_TABLE_ID', 'tblxW5WMKDULyolA'),
      fields: {
        detailId: '销售明细ID',
        product: '编号',
        // 配品（腰带、鞋油、袜子、包等）：与「编号」二选一，配品行不写尺码。
        accessory: '配品',
        size: '尺码',
        gift: '赠品',
        soldAt: '销售日',
        salesEntry: '销售单号',
        fulfillmentStatus: '履约状态',
        actualAmount: '成交金额',
        // Formula field (unit list price), never written by the backend.
        listUnitPrice: '销售单价',
        // 「交易类型」（单选关联「行为管理」，2026-10-05 新增）是给退换货链路预留的：
        // 明细行要能自己说明"这一行是卖出去的还是退回来的"。本次只建立映射、不实现逻辑，
        // 提前落映射是为了让 schema 闸门从今天起就盯住这个名字——名字漂移要当场失败，
        // 而不是等退换货上线时才在写入时静默 FieldNameNotFound。
        tradeType: '交易类型',
      },
    },
    paymentRecord: {
      tableName: '收款明细',
      tableId: getEnv('FEISHU_V1_PAYMENT_RECORD_TABLE_ID', 'tblTpLOtTLhWxXvm'),
      fields: {
        salesEntry: '关联销售单',
        // 产品负责人 2026-10-05 把这张表的「支付方式」改名为「交易方式」（字段本身不变，
        // 仍是单选关联「收款方式管理」）。schema 没跟上就会用飞书里已不存在的字段名写入，
        // 收款记录静默失败——正是 deploy_build.sh 的 schema 闸门拦住的那次。
        method: '交易方式',
        // 「交易方向」（单选：收入 / 退回，2026-10-05 新增）同样为退换货链路预留：
        // 本次只建立映射、不实现逻辑，理由同上。
        tradeDirection: '交易方向',
        amount: '收款金额',
        status: '收款状态',
        receivedAt: '收款时间',
      },
    },
    // 「客户往来货款」：客户存在店里的钱（预存 / 退款转预存）。
    //
    // 退换货第二期的 settlement=prepaid 走这张表：钱不进收款明细，而是记一笔往来货款。
    // 它自带一个幂等键字段「业务事件ID」——售后执行器用它做"先回查再创建"，
    // 即使本地任务记录丢了，也能按 `after_sales:<原主表id>:<action>:<原明细批次哈希>` 认出这一笔
    // （批次哈希让"同一笔销售分两次退不同鞋"各是一笔，同时同一批明细重复调用仍然幂等）。
    //
    // 字段名 2026-10-05 由产品负责人核对过（含「退货退款」选项已在「变动类型」里）。
    customerCredit: {
      tableName: '客户往来货款',
      tableId: getEnv('FEISHU_V1_CUSTOMER_CREDIT_TABLE_ID', 'tblm86T60yAHD6pR'),
      fields: {
        changeType: '变动类型',
        receivableChange: '应收变化',
        customer: '客户',
        occurredAt: '发生时间',
        detailSequence: '明细序号',
        entryStatus: '入账状态',
        // 幂等键（文本）：售后写入靠它回查，缺列时执行器大声失败。
        businessEventId: '业务事件ID',
        sourceOrderNo: '来源单号',
        operator: '经办人',
        creditFlowId: '客户往来流水ID',
      },
    },
    // Legacy private-chat purchase intake table. Kept for the frozen path.
    purchaseReport: {
      tableName: '供应商报单',
      tableId: getEnv('FEISHU_V1_PURCHASE_REPORT_TABLE_ID', 'tblo0ffzFt7vyQw2'),
      fields: {
        batchNoText: '报货批次号', detailId: '明细ID', behavior: '采购行为',
        product: '编号', size: '尺码', quantityDescription: '数量说明', reportedAt: '报单时间', operator: '经办人',
        // 「合计数量」是产品负责人在表单里自己填的一批报货总双数（number 字段，
        // 2026-10-05 用 lark-cli +field-list 只读核对过字段名与类型）。
        // 它是报货「到齐」判据的输入：Σ(每条明细解析出的双数) >= 合计数量 才处理
        // （见 reportCompletenessPolicy + purchaseWebhookService.handleReportBatch）。
        totalQuantity: '合计数量',
        status: '处理状态', failureReason: '解析失败原因', request: '关联采购申请',
      },
    },
    purchaseRequest: {
      tableName: '采购申请',
      tableId: getEnv('FEISHU_V1_PURCHASE_REQUEST_TABLE_ID', 'tbli1ygPtss5CWCH'),
      fields: {
        batchNo: '报货批次号', behavior: '采购行为', product: '编号', size: '尺码', quantity: '数量',
        arrivalStatus: '到货状态',
        // 幂等键必须落成真实文本列：本地任务记录丢失时，只能靠远端这个值
        // 判断「这条采购申请是不是已经写过」，否则重试会写出第二笔采购事实。
        idempotencyKey: '幂等键',
        // 「明细ID」是飞书自动编号：写入顺序 = 编号顺序，所以「同一批次+同一供应商
        // 只留一条附件」时用它挑最早的那条，而不是靠数组下标——下标在重试后会变。
        detailId: '明细ID',
        // 供应商要的采购申请 PNG 写回这里，产品负责人再自己转发。
        // ⚠️ 字段真实名是「采购申请单」（2026-10-05 用 lark-cli +field-list 只读核对过），
        // 不是口头说的「采购申请附件」；写错字段名飞书会直接 FieldNameNotFound。
        attachment: '采购申请单',
      },
    },
    purchaseArrival: {
      tableName: '采购到货',
      tableId: getEnv('FEISHU_V1_PURCHASE_ARRIVAL_TABLE_ID', 'tblvLOXKESNTbZ7v'),
      fields: {
        arrivalAt: '到货日',
        // 「图片」是**当前字段名**（2026-10-05 用 lark-cli +field-list / fields API 核对过）：
        // 以前这里写的是「鞋盒图片」，改名后映射没跟上，到货链路会静默读不到附件、
        // 每条记录都报"没有鞋盒图片附件"。字段改名后必须重跑 v1:schema-check 闸门。
        images: '图片',
        // 「类型」决定用哪种识别：鞋盒（一张张拍鞋盒）还是到货单（供应商单据的表格照片）。
        // 空值按鞋盒处理，兼容这张字段上线前录入的历史记录。
        type: '类型',
        batch: '报货批次号', inspector: '验收人',
        recognitionStatus: '识别状态', confirmStatus: '确认状态', failureReason: '识别失败原因',
      },
    },
    purchaseOrderBatch: {
      tableName: '报货批次',
      // Current V1 tenant default; forks can override it with the environment variable.
      tableId: getEnv('FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID', 'tblwezby9wRea9qi'),
      fields: { batchNo: '报货批次号', createdAt: '创建时间', idempotencyKey: '幂等键' },
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
        // 「这一双是某次库存操作创建的第 N 双」。实时库存是一双一条，
        // 没有这个键就无法在 create 结果未知时判断该不该补建。
        operationItemKey: '库存操作键',
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
  readAppToken,
};
