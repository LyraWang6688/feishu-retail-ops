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
        // 建档（ensureArrivalProducts）时按明细带的「品名」填；没有就留空——
        // 默认成 A 会把女鞋写进男鞋，比空着更难发现。
        // ⚠️ 原先这个值是「到货拍图识别」从标签上认出来的；那条链路 2026-10-05 退场后
        // 由新的「对话到货」流程提供同样的字段。
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
        // 四个状态维度：业务负责人 2026-10-06 在生产表新建，2026-10-06 晚又**把两个旧字段
        // 整个删掉**（「确认状态（旧）」「订单状态」——飞书删字段 = 删值，不可恢复）。
        // 所以这里只保留这四个映射，读写都走它们（取值规则见 config/salesStatusDimensions.js）。
        // 🔴 不要再把旧字段名加回来：生产表里已经没有这两列，闸门会当场报「缺少 V1 字段」。
        userAction: '确认状态',
        sales: '销售状态',
        // ⚠️「资金状态」在真表里是**文本字段**（type=1），不是单选。
        funds: '资金状态',
        stock: '库存状态',
        parseSummary: '解析结果摘要',
        failureReason: '失败原因',
        // 关联「行为管理」里的**现货 / 预定**（2026-10-07 起只有这两条）。交易类型决定交付状态；
        // 落成关联是为了可筛可查、可对账，也让销售与库存行为共用同一张配置表。
        tradeType: '交易类型',
        // ⭐「消息链接」（业务负责人 2026-10-06 在生产表**新建**，逐字：「我在多维表格的
        // 销售主表里加了一列叫做**消息链接**，可以写入这里～」）。
        // 存的是什么：这条销售当初在群里那条**机器人回复消息的深链**（`message_app_link`）。
        // ⚠️ 链接只可能出现在**发送响应**里，历史消息取不回来（见
        // docs/reports/group-message-deep-link-2026-10-06.md；⚠️ 该文档"实测四"记着：
        // 本应用**当前连发送响应都不回带** ⇒ 这一列现在仍是空的，代码待命不伪造）。
        // ⇒ 老单这一列**留空**；新建的单在"发卡片那一刻"拿到就写（SalesMessageLinkService）。
        // ⚠️ 字段类型由**生产表那一列**决定（她建的）：代码运行时读一次字段元数据，
        // 文本写字符串 / 超链接（type=15）写 `{ text, link }`——不假设类型。
        messageLink: '消息链接',
        // ⭐ 2026-10-08：**赠品的落点从「销售明细」搬到「销售主表」**（业务负责人口径，逐字）：
        //   「好的，**写入的落点放在销售主表里的赠品**，**销售明细没有赠品了**」
        //   她在生产表里新加了这一列（文本），并**把「销售明细.赠品」整列删掉**。
        // 语义：**一单一条** —— 多件各有赠品时按明细顺序用「、」连起来并去重；
        //       合并规则的字面量（分隔符 / 占位文案）在 `config/salesGift.js`（配置先行），
        //       写入与幂等比对在 `services/salesOrderService.js`。
        // 🔴 明细那一侧的 `gift` 映射**必须一起删**（见下面 salesDetail 段）：
        //   只删写入、留映射 → 那一列永远空着（而且闸门不报错，静默）；
        //   只删映射、留写入 → 写库时抛「未配置语义字段」。
        gift: '赠品',
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
        // 🔴 「赠品」映射**已删除（2026-10-08）**：业务负责人在生产表里把这一列**整列删掉**了 ——
        //   赠品的落点搬到**销售主表**（见上面 `salesEntry.gift`，她逐字：
        //   「写入的落点放在销售主表里的赠品，销售明细没有赠品了」）。
        //   映射留着 = 写库时抛「未配置语义字段」（明细行一个字都写不进去）；
        //   而写入点也已同步删掉（"两个都要删，只删一个会留坑"）。
        //   ⚠️ 这个语义键 `gift` 现在**只属于销售主表**；若哪天又要在明细上记赠品，
        //      是**重新加一列 + 重新加映射**，不是把这一行加回来。
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
        // ⭐ 2026-10-08：9 点推送【现货待收】那块的时间窗按**收款明细的创建时间**算
        //   （业务负责人的口径：「抖音团购券是从收款明细里的**创建时间**开始算」，
        //    同一条口径也适用于这块的 7 天窗；见 `config/pendingPushCandidates`）。
        //   ⚠️ 它是飞书**自动**字段（type 1001）⇒ **代码只读、一行都不写**。
        //   ⚠️ 建映射的另一个理由：9 点推送按它筛，名字漂移要让**部署闸门**当场报红，
        //      而不是静默筛出空块（那正是"最难查的一类"）。
        createdAt: '创建时间',
        // ⭐ 2026-10-08：9 点推送【现货待收】那块要按**这一条收款明细的交易类型**筛
        //   （业务负责人的口径：「**现货待收款**的是**收款明细**里**未收款且交易类型是现货**的记录」）。
        //   那一列是**查表引用**（指向销售单那一侧的「交易类型」= 现货 / 预定），
        //   一格可能写着多个 ⇒ 判据是「含」，取值与匹配规则在 `config/pendingPushCandidates`。
        //   ⚠️ 只**读**、不写：它是引用列，写它等于替她改交易类型。
        tradeType: '交易类型',
      },
    },
    // ⛔ 「客户往来货款」整段已删除（2026-10-08）。
    //
    // 事实：业务负责人把这张表**整表删掉了** —— 2026-10-08 只读核对生产 Base 的 46 张表，
    //       `tblm86T60yAHD6pR` 不存在、也没有任何同名表（其余 17 张契约表名字与 id 全部一致）。
    //       ⇒ 部署闸门 `v1:schema-check:all` 当时报 `读取“客户往来货款”字段失败: TableIdNotFound (1254041)`。
    //
    // 处置：契约照着**真表现状**删掉这一段（她 2026-10-08 的指令：「更新 schema 到我目前这个生产表的状态」）；
    //       依赖它的 `services/afterSalesService.assertPrepaidAvailable`（原 settlePrepaid）随之**下线**：
    //       `settlement=prepaid`（"钱留在我们这里"，即「已留存」）现在会在**任何写入之前大声失败**，
    //       而不是抛一句看不懂的 `Unknown V1 table`，更不会静默改成写「收款明细」（那是记错账）。
    //
    // 🔧 接回来时要做三件事（等她说清「已留存」落在哪张表 / 哪些列）：
    //   ① 这一节按新表重建映射（变动类型 / 应收变化 / 来源单号 / 幂等键…）；
    //   ② `v1SchemaScopes` 的 sales 范围 + V1_IDEMPOTENCY_KEY_TABLES.sales 各加一条；
    //   ③ `afterSalesService` 恢复 settlePrepaid（`git log` 里这一版的实现可直接取用）。
    //
    // 历史（写给人看）：这张表原先是退换货 `settlement=prepaid` 的唯一落点，
    //   自带幂等键字段「业务事件ID」= `after_sales:<原主表id>:<action>:<原明细批次哈希>`；
    //   2026-10-06 她删过它的「发生时间」列；2026-10-08 整表删除。
    // 供应商填表入口。⚠️ 表名沿革：「供应商报货」→（2026-10-05）「供应商对接」→
    //（2026-10-07）**「信息填写」**（业务负责人当天在生产表改的名）。
    // 这里只跟着改 tableName（用户可见文案用得到）；分流与读写一律按 tableId 走，
    // 所以改名不影响任何触发链路。
    // ⚠️ 闸门（v1:schema-check）按 **tableId** 校验字段名、**不校验表名** ——
    //    表改名它**拦不住**，只能靠这里与各处用户可见文案自己同步。
    purchaseReport: {
      tableName: '信息填写',
      tableId: getEnv('FEISHU_V1_PURCHASE_REPORT_TABLE_ID', 'tblo0ffzFt7vyQw2'),
      fields: {
        batchNoText: '报货批次号', detailId: '明细ID', behavior: '采购行为',
        product: '编号', size: '尺码', quantityDescription: '数量说明', operator: '经办人',
        // 「供应商」：**只读**投影（生产/测试真表里是 Lookup，目标 = 货品信息.供应商名）。
        // 用途只有一个：9 点推送的【采购】区要显示"这批是谁家的"——批次表 7 列里没有供应商，
        // 只能从「信息填写」这一条上取。
        // 🔴 **代码绝不写它**（Lookup 是飞书算出来的；写它会 FieldNameNotFound）——
        //    映射存在的意义是"读它"与"闸门盯住这个名字"。
        supplier: '供应商',
        // ⚠️ 「报单时间」(reportedAt) 映射已删除（2026-10-06）。
        // 业务负责人的口径：时间字段除了「收款时间」以外，**飞书里都设成了自动字段**
        //（表里的「创建时间」type=1001 / CreatedTime），代码不要再写、也不必再映射。
        // 生产真表核对（2026-10-06，服务器上只读、用项目自己的 gateway.listFields）：
        // 「信息填写」真表 14 列里**没有**「报单时间」，映射留着 = 部署闸门
        // v1:schema-check:all 直接判红（该表缺少 V1 字段: 报单时间）。
        // grep 全仓：reportedAt 这个语义键在 server/src 里**没有任何读方与写方**
        //（工作台「报货信息」页那一列读的是 row.reported_at，接口自 2026-09-26 起就不返回，
        //  属于已知历史遗留，不在本次改动内），删除不会留下悬空引用。
        // ⚠️ 「数量」映射**已删除（2026-10-07）**：业务负责人在生产表里把「信息填写」的
        //    「数量」列**整列删掉了**（她给的只读核对结果：真表 14 列里没有它）。
        //    她的口径（逐字）：「不分报货还是退货，都是按照同样的逻辑：
        //    如果数量说明不写，数量就默认为一双。你需要把退货原有的那个解析路线删掉，
        //    然后再把采购的那个加上退货就可以了」。
        //    ⇒ 数量一律从「数量说明」解析（不写 = 每个勾选尺码 1 双）；
        //      尺码一律来自「尺码」（关联「尺码管理」，multiple = true 多选）。
        //    映射留着 = 部署闸门 v1:schema-check:purchase 直接判红（该表缺少 V1 字段: 数量），
        //    而且代码里两处读它（报货解析 / 退货解析）都只会读到 undefined。
        //    读它的两处已随本次改动一起删除（全仓零引用，守门用例
        //    `purchaseReturnUnifiedParsing.test.js` 的 ③ 钉住）。
        //    ⚠️ 「报货信息.数量」（原「具体信息」）是**另一张表**的列，仍在（那是采购申请/退货明细的双数）。
        // ⚠️ 「合计数量」已删除：业务负责人 2026-10-05 把这一列从表里去掉了，
        // 并明确说「目前核心的字段就不要了，我们现在也不加判断的逻辑」——不再判「到齐」。
        // 这个映射留着的话，schema 闸门（validateTable 校验字段存在性）会直接判部署失败，
        // 而且读到的永远是 undefined，会让整批记录永远停在"未处理"。
        status: '处理状态', failureReason: '解析失败原因', request: '关联采购申请',
      },
    },
    // ⚠️ 表名沿革：「采购申请」→（2026-10-05）「单据信息」→（2026-10-07）「具体信息」
    //   →（同日深夜）**「报货信息」**（业务负责人当天的第三次改名，她只改名字、tableId 不变）。
    // 定位不变：**给供应商开图片的依据**的明细表
    //（采购申请 / 采购退货的**明细行**都写在这张表里）。
    // ⚠️ 只改 tableName：闸门与链路都按 tableId 走，改名不影响它们；
    //    语义键 `purchaseRequest` 也**刻意不动**（它指的是"报货信息/采购申请"这件事，不是表名）。
    purchaseRequest: {
      tableName: '报货信息',
      tableId: getEnv('FEISHU_V1_PURCHASE_REQUEST_TABLE_ID', 'tbli1ygPtss5CWCH'),
      fields: {
        batchNo: '报货批次号', behavior: '采购行为', product: '编号', size: '尺码', quantity: '数量',
        // ⚠️ 「到货状态」(arrivalStatus) 与「采购申请单」(attachment) 两行映射**已删除**：
        // 业务负责人 2026-10-07 把这两列从生产表**删掉了**（到货状态改挂「报货批次」，
        // 附件改回填「报货批次.单据」）。删映射是两件事的**一半**，另一半是删写入点
        //（`writeSupplierImageAttachment` 的附件更新、`purchaseQueryService` 的到货状态读取、
        // `routes/purchaseQuery.js` 的筛选）——只删一半的话：
        //   · 只删写入、留映射 → 那一列永远空着（而且闸门不报错，静默）；
        //   · 只删映射、留写入 → 写库时抛「未配置语义字段」。
        // 幂等键必须落成真实文本列：本地任务记录丢失时，只能靠远端这个值
        // 判断「这条采购申请是不是已经写过」，否则重试会写出第二笔采购事实。
        idempotencyKey: '幂等键',
        // 「明细ID」是飞书自动编号：写入顺序 = 编号顺序，用它挑最早的那条、
        // 而不是靠数组下标——下标在重试后会变。
        detailId: '明细ID',
      },
    },
    // ⚠️ 这里原先有 `purchaseArrival`（表名「到货验收」，原「采购到货」，
    //    tableId `tblvLOXKESNTbZ7v`）——**整段已删除（2026-10-07 晚）**。
    //    业务负责人的口径（逐字）：
    //      「我们到货验收数据表需要写入的点**变到了报货批次里面**……
    //        也就是说，我们要把原来到货信息数据表里的落点改写到报货批次里面」
    //    她在生产 Base 里**把这张表整个删掉了**（Base 里已没有任何名字含「到货」/「验收」的表，
    //    `tblvLOXKESNTbZ7v` 不再存在）。映射留着会有两个后果，**两个都躲不掉**：
    //      · 部署闸门 `v1:schema-check:*` 按 tableId 去问这张表 → 表都没了，直接判红；
    //      · 代码里任何一次 create/update 都会打到不存在的表。
    //    ⇒ 落点搬到「报货批次」那一行（见下面的 `purchaseOrderBatch` 与
    //      `services/purchaseOrderBatchService.js`）；「验收原话」「确认状态」两个语义键随之下移。
    //    ⚠️ 另外两条**不许**跟着搬过来：
    //      · 「到货日」= 飞书**更新时间**（自动字段，type 1002）；
    //        ⚠️ 2026-10-07 深夜她把这一列**从「更新时间」改名为「到货日」**——
    //           类型没变、还是自动字段 ⇒ **仍然不建映射、不写**（旧名/新名各表都不映射）。
    //      · 「验收人」= 飞书**创建人**（自动字段，type 1003）。
    //      两者都是飞书自动字段 ⇒ **代码不许写、也不建映射**（口径：时间字段一律交给飞书；
    //      创建人同理不由代码写）。将来只读需要时再加，加的时候也要认清"它是自动的"。
    //    ⚠️ 历史沿革（写给人看）：「采购到货」→（2026-10-07）「到货验收」→（同日稍晚）**删除**。
    // 「报货批次」：业务负责人 2026-10-07 明确它现在的定位 ——
    //   「**采购批次这个数据表主要控制的是该批次的到货情况**」。
    // 生产真表当天从 4 列变成 7 列（新增「到货状态」「单据」「采购行为」），
    // 这里同步加映射；**「采购行为」刻意不映射**（她的原话：「报货批次里面的采购行为你不用管」）
    // —— 不映射就自然读不到、写不了，也就不可能"顺手"写坏它。
    purchaseOrderBatch: {
      tableName: '报货批次',
      // Current V1 tenant default; forks can override it with the environment variable.
      tableId: getEnv('FEISHU_V1_PURCHASE_ORDER_BATCH_TABLE_ID', 'tblwezby9wRea9qi'),
      fields: {
        batchNo: '报货批次号',
        // ⭐ 2026-10-07 深夜：业务负责人在生产表把这一列**改名**了 ——
        //   「创建时间」→ **「报货日」**（类型没变：仍是创建时间 `type=1001`，飞书自动字段）。
        //   语义键 `createdAt` 保持不变，只换物理列名；旧名留着 = 部署闸门判红
        //  （`“报货批次”缺少 V1 字段: 创建时间`）。
        //   ⚠️ 自动字段 ⇒ **代码一行都不写**：这个映射的用途只有一个 —— 让闸门盯住这个名字。
        createdAt: '报货日',
        idempotencyKey: '幂等键',
        // 到货状态（单选）：新建批次记录时显式写「未到货」；到货核对确认成功后改「已到货」。
        // 取值**不写死在代码里** —— 语义键在这里、字面量在 `config/purchaseArrivalStatus.js`，
        // 并由部署闸门（`validate_v1_schema.js`）对着真表 `property.options` 核对。
        arrivalStatus: '到货状态',
        // 「单据」：**附件字段**，出图之后把采购申请单 / 采购退货单的 PNG 回填到这里
        //（她的原话：「把这些信息挪到我们的'报货批次'里面」）。
        // ⚠️ 语义键叫 `document`，物理列名是她给的「单据」。
        // ⚠️ 类型以**真表字段元数据**为准：必须是 Attachment（type 17）。
        //    若不是附件（文本 / 关联 / 公式），写回会失败 —— 那种情况**停下来报告**，
        //    不要改写成别的写库方式。
        document: '单据',
        // ⭐ 2026-10-07 晚：到货核对的落点从**已删除的「到货验收」表**搬到这里（她的口径见文件头）。
        //  「验收原话」= 她在群话题里说过的原话（多句按 config 的连接符归集成一个文本）。
        //  ⚠️ **2026-10-07 深夜更新：「确认状态」在真表上已经从【文本】改成【单选】**
        //     （业务负责人在生产表里改的）⇒ 取值除了放在 `config/purchaseAcceptance.js`
        //     之外，还必须进**部署闸门的单选取值契约**（往单选写不存在的取值，飞书会**自动建选项**）。
        //  ⚠️ **到货日 / 验收人不在这个映射里**：它们在真表上是**自动字段**
        //    （到货日=更新时间 type 1002、验收人=创建人 type 1003），代码不读不写。
        //    ⚠️ 「到货日」这个**新名字**是 2026-10-07 深夜从「更新时间」改来的 ⇒
        //       不许因为"名字变了、像业务字段"就补一个映射进来。
        acceptanceText: '验收原话',
        confirmStatus: '确认状态',
        // ⭐ 2026-10-08：9 点推送【采购】那行的文字要带**录入数量**
        //   （业务负责人的补充口径，逐字：「**采购数量用「录入数量」**」；
        //    同日的只读实测也确认了「报货批次」上有这一列）。
        //   ⚠️ 只**读**、不写：代码里没有任何写入点（这一列是她在表上维护的）。
        //   ⚠️ 名字漂移由闸门拦：`v1:schema-check:purchase` 会对不上就判红。
        quantity: '录入数量',
        // ⭐⭐ 2026-10-08（业务负责人亲自批准的口径）：「实际数量」「实际金额」两列都落在
        //   **「报货批次」那一行**。语义（她的原话）：
        //     「**录入数量**：我们报单时候的数量；**实际数量**：我们到货的数量；
        //      **实际金额**：这一次供应商的金额」。
        //   · 「实际数量」= **代码算出来的**实际到货数合计（`plan.rows` 的 `actual` 求和，
        //     `actual = 0` 的行加 0 ⇒ 与库存口径一致）。
        //   · 「实际金额」= **她在卡片表单里填的整批金额**（必填；服务端再校验一次数字）。
        //   ⚠️ 写入点**只有一处**：到货核对点「是」→ `PurchaseWebhookService.confirmArrival`
        //     → `PurchaseOrderBatchService.writeAcceptance`（与「验收原话」同一次 update）。
        //     「录入数量」在上面**只读不写**，两列不是一回事，别混。
        //   ⚠️ 真表上的列类型未在本机核实（本机 .env 指向的测试 Base 与生产**不对齐**，
        //     那张「报货批次」只有 4 列）；按仓库既有金额列的先例（「成交金额」）写 **Number**。
        //     若真表是文本列，写数值可能被判 `*ConvFail` —— 那种情况**停下来报告**，
        //     不要改成"写字符串"了事（会与数字列冲突）。
        actualQuantity: '实际数量',
        actualAmount: '实际金额',
      },
    },
    // ⚠️ 这里原先有 `purchaseInbound`（表名「采购入库」，tableId `tblK3Uzd0nN1GJrr`）
    //    ——**整段已删除（2026-10-07 深夜）**。业务负责人的口径（逐字）：
    //      「甲 **不再写任何入库明细**：只更新「报货批次」（到货状态=已到货 + 验收原话 + 确认状态）
    //       + **加库存**（库存流水 / 实时库存照写）—— 也就是"**入库明细表整个不要了**"」
    //    她在生产 Base 里**把这张表整个删掉了**。删除的理由与后果（与「到货验收」那次同一形状）：
    //      · 留着映射 ⇒ 部署闸门 `v1:schema-check:*` 按 tableId 去问一张不存在的表，直接判红；
    //      · 代码里任何一次 create/update 都会打到不存在的表。
    //    ⇒ 到货链路现在只做两件事：**更新「报货批次」那一行**（验收原话 / 确认状态 / 到货状态）
    //      ＋ **逐条 `inventory.applyPurchase`**（「库存流水」+「实时库存」）。
    //    ⚠️ 连带清理（"两个都删才不留坑"）：
    //      · `inventoryLedger.purchaseInbound`（「关联采购」）**也没了** —— 对端关联列随表一起删，
    //        所以映射与写入点（`STOCK_MOVEMENTS[采购增加].ledgerSource`）两个都删；
    //      · `v1SchemaScopes` 的 purchase / inventory 范围与尺码关联清单同步去掉这张表；
    //      · `config/purchaseBehaviors.js`（采购环节 `PURCHASE_IN`）的唯一消费者就是
    //        入库行的「采购行为」⇒ 一并退场（代码从 git history 可查，别再凭空发明一份）。
    //    ⚠️ 历史沿革（写给人看）：到货明细曾写在 temp 链路「鞋盒/报货单 → 采购到货 → 采购入库」上，
    //      那条链路 2026-10-05 退场、2026-10-07 晚「到货验收」表被删、**深夜「采购入库」表也被删**。
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
        // ⭐ 2026-10-08 补刀（业务负责人口径，逐字）：
        //   「【库存流水.关联采购】**还在**（关联类型），指向 已删除的「采购入库」⇒ 所以它的处置
        //    （删掉这个映射、不再传关联 id）是对的，继续写必然失败，**改成了报货批次**」
        //   ⇒ 她在生产真表里把这一列**改成了指向「报货批次」(`tblwezby9wRea9qi`)**，
        //     所以映射**加回来**，采购加库存的流水**写批次那一行的 record id**。
        // ⚠️ **语义键名换成 `purchaseBatch`（不再是 `purchaseInbound`）**：老名字说的是那张
        //   **已被整表删除**的「采购入库」表 —— 留着它，"这一列指向哪张表"永远是错的；
        //   新名字与表键 `purchaseOrderBatch`（报货批次）同源，一眼能看出对端是谁。
        // ⚠️ 它**只写不查**：不参与任何幂等判据（`source_record_id` 仍是
        //   `purchase_increase:<批次身份>|<货品>|<尺码>` 三元组）。与"按来源回查"那个
        //   `ledgerSource` 的分工见 `inventoryService.STOCK_MOVEMENTS[采购增加].ledgerLink`。
        // ⚠️ 历史沿革（写给人看）：本映射 2026-10-07 深夜随「采购入库」表被删过一次
        //   （那次是对的：继续指向那张表必然失败）；2026-10-08 她改成指向「报货批次」后补回。
        purchaseBatch: '关联采购',
        // 「操作人」= 飞书【人员】字段（type=11）。业务负责人 2026-10-06 在生产表新增。
        // ⚠️ 只有【人工调整】会写它（谁点的）；自动链路（销售扣减 / 采购入库）留空——
        //    这样"有值 = 人干的，空 = 系统干的"，人员字段也写不了"系统"这种字符串。
        operator: '操作人',
          // ⚠️ 「发生时间」已由业务负责人 2026-10-05 从生产表删除（表里现在只有「创建时间」）；
          // 映射留着会让部署闸门 v1:schema-check 直接红，因此同步删掉。
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
        // 「品类」是飞书**公式**列（2026-10-06 只读核过测试 Base：liveInventory.品类
        // type=20，取值就是品类名，如「休闲鞋」「单鞋」；生产真表同一份形状见
        // docs/inventory-adjustment-plan-2026-10-06.md 的只读实测）。
        // 工作台「换季调整（按品类批量）」用它分组；代码只读、不写。
        // ⚠️ 若哪天它被删掉或改名，`v1:schema-check:inventory` 会当场判红。
        category: '品类',
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
