const { linkedRecordIds, singleLinked, textValue } = require('./v1BitableGateway');
const { V1ReferenceResolver, relation } = require('./v1ReferenceResolver');
const { readSaleLinkedRecord } = require('./salesRecordReader');
const { nextId, createState } = require('./salesRecordIds');
const { withSalesReadRetry } = require('./salesReadRetry');
const { PaymentService } = require('./paymentService');
const { SalesProgressService, cents } = require('./salesProgressService');
const { createSizeReferenceAccess } = require('./sizeReferenceService');
const { sellableKindOf } = require('../config/sellableKinds');
const { SALES_STATUS_WRITE_VALUES: WRITE } = require('../config/salesStatusDimensions');
// ⭐ 赠品的落点/归一（业务负责人 2026-10-08：落点从「销售明细」搬到「销售主表」）。
//   分隔符与占位文案都在那份 config 里；这里只负责按它的规则算与写。
const { giftTextOfItem, mergeGiftTexts } = require('../config/salesGift');
const { SalesStatusWriter } = require('./salesStatusWriter');
const { logInfo, logWarn, logError } = require('../utils/logger');
const { mergeCorrelation } = require('../utils/correlationFields');

const positiveInteger = (value, label) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label}必须是正整数`);
  return number;
};

class SalesOrderService {
  constructor({ gateway, references, payments, progress, sizeReferences, status } = {}) {
    if (!gateway) throw new Error('SalesOrderService requires gateway');
    this.gateway = gateway;
    this.references = references || new V1ReferenceResolver(gateway);
    this.payments = payments || new PaymentService({ gateway, references: this.references });
    this.progress = progress || new SalesProgressService({ gateway });
    // 四个状态维度的唯一写入口（名字与取值都在 config/salesStatusDimensions）。
    this.status = status || new SalesStatusWriter({ gateway });
    // 「尺码」已改为关联「尺码管理」：写入前要解析出关联记录，幂等比对也要按关联记录比。
    this.getSizeReferences = createSizeReferenceAccess({ gateway: this.gateway, sizeReferences });
    this.queue = Promise.resolve();
  }

  // ⚠️ 关联键走**尾部可选参数**（`options.correlation`），**不塞进 `input`**。
  //    统一约定：既有业务入参对象的形状一个字段都不变（哪天真被谁改坏了，
  //    既有测试里的逐字 deepEqual 会当场挂掉）。
  confirm(input, options = {}) {
    const next = this.queue.then(() => this._confirm(input, options), () => this._confirm(input, options));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async _confirm(input, options = {}) {
    const salesEntryRecordId = input.salesEntryRecordId;
    if (!salesEntryRecordId) throw new Error('缺少销售主表 record_id');
    if (!Array.isArray(input.items) || !input.items.length) throw new Error('至少需要一条销售明细');
    await this.gateway.validateTables?.(['product', 'paymentMethod', 'salesEntry', 'salesDetail', 'paymentRecord']);
    // ⭐ 关联键（2026-10-07 业务负责人拍板「日志改下吧！」）：
    //   这一整段（写主表状态 → 写销售明细 → 写收款明细 → 落表日志）以前**一个键都没有**，
    //   按 task_id grep 只能看到卡片那半，看不到明细 / 收款。
    //   ⚠️ 它只是**每次调用显式传下去的普通对象**，不落在 service 实例上
    //      （这些 service 是启动时构造的单例，放实例上会跨请求串台）。
    //   `sales_entry_record_id` 这一层自己就知道；`task_id` 由调用方（本地任务层）给；
    //   `order_no` 下面读过主表就补上（**不额外请求**：那条记录本来就要读）。
    let correlation = mergeCorrelation(options.correlation, { sales_entry_record_id: salesEntryRecordId });
    // 「入账中」落在四个维度字段上（旧「确认状态（旧）」那一列已被她整列删除）：
    //   · 销售状态 = 未写入（销售明细还没开始写）
    //   · 资金状态 = 未写入（收款明细还没开始写）
    // 显式写这两列（而不是留空），是为了让"到哪一步了"在表里看得见。
    // ⚠️ 2026-10-09：这里原来还有一句 `update(..., { failureReason: '' })`（重试时先清空
    //    「失败原因」）—— 那一列被她从生产表删掉了，**写入点随列一起删**
    //    （见 `config/v1BitableSchema.salesEntry` 段）。下游 catch 里那次回填同样删掉：
    //    失败现在只落在**状态维度**（销售/资金状态）＋ `v1.sale.post_failed` /
    //    `v1.sale.sync_pending` 日志上。
    await this.status.write(salesEntryRecordId, {
      sales: WRITE.sales.none, funds: WRITE.funds.none,
    }, correlation);
    // A previous attempt may have completed all detail/receipt writes before a read failed.
    // The persisted task is the source of that stage on the next card callback.
    let financialRecorded = input.knownFinancialComplete === true;
    // 进度计数的口径：明细/收款**各写成功几条**（失败时用来区分"部分写入"和"全败"）。
    // 放在 try 外面，catch 里才能读到。
    let detailPlan = 0;
    let detailsPersisted = 0;
    try {
      // 销售明细的「交易类型」要表明这一行**自己**是哪种交易（业务负责人 2026-10-07）：
      // 「**但是实际到我们的销售明细里面，就这一单它是什么，那就是什么**」
      // —— 一张单可以同时有现货行与预付行，所以**逐行**写、每行单选。
      //
      // 取值优先级：
      //   ① 这一行自己的编码（`item.tradeTypeCode`，接线层从解析草稿带下来）
      //      → 解析成「行为管理」记录；同一个编码只解析一次（本地缓存，不重复读表）；
      //   ② 解析不出来 / 这一行没带编码 → **退回读主表已经写好的那条关联**
      //      （既有行为：主表写哪条，明细就写哪条 —— 单类型单走的就是这一条，逐字不变）。
      // 主表没解析出交易类型时（AI 没认出来）留空——空着比写错方向好。
      const entryFields = this.gateway.table('salesEntry').fields;
      const entry = await withSalesReadRetry(
        () => this.gateway.get('salesEntry', salesEntryRecordId), 'sale_entry_trade_type',
      );
      const tradeTypeRecordId = linkedRecordIds(entry?.fields?.[entryFields.tradeType])[0] || '';
      // 单号就在这条**已经读到的**主表记录上 ⇒ 零额外请求地补进关联键。
      // 读不到（AI 还没生成 / 老单）就不写这个键，不是写一个空串。
      correlation = mergeCorrelation(correlation, { order_no: textValue(entry?.fields?.[entryFields.orderNo]) });
      // 编码 → 「行为管理」记录 id 的**一次解析、逐行复用**（同一编码不重复读表）。
      const tradeTypeByCode = new Map();
      const tradeTypeRecordIdForItem = async (code) => {
        const wanted = String(code || '').trim();
        if (!wanted) return tradeTypeRecordId;
        if (tradeTypeByCode.has(wanted)) return tradeTypeByCode.get(wanted);
        let resolved = tradeTypeRecordId;
        if (typeof this.references.resolveSalesTradeType === 'function') {
          try {
            resolved = (await this.references.resolveSalesTradeType(wanted)).recordId || tradeTypeRecordId;
          } catch (error) {
            // 解析不到**不阻塞入账**：退回主表那条（与接线层的口径一致：它只是审计字段）。
            logWarn('lark.sales.detail.trade_type.resolve_failed', {
              sales_entry_record_id: salesEntryRecordId, code: wanted, error: error.message,
            });
          }
        }
        tradeTypeByCode.set(wanted, resolved);
        return resolved;
      };
      const expected = [];
      for (const item of input.items) {
        // 可售品按属性走：鞋才需要解析尺码和跟踪库存，配品只记「卖了什么、收了多少」。
        const kind = sellableKindOf(item);
        // ⭐⭐ 2026-10-11（业务负责人选"方案甲"）：「**实收金额可以是空的**」——
        //   扫码建单允许"先只记货"（她什么钱都没填），她事后再去工作台订单列表逐件补。
        //   ⇒ **空 ⇒ 不写这一列、不计入合计**；
        //   🔴 **放宽只针对"缺省"**：**填了就必须 > 0**（0 / 负数照旧拦住）。
        //   ⚠️ **「0」与「空」是两件事**：赔货那条路写的是**明确的 0**
        //      （`config/afterSales` 的 `newLineAmount: 0`），它走的是 `afterSalesService`
        //      自己的 `create`、**不经本函数**；读侧 `salesProgressService` 也用
        //      `textValue` 判真值 ⇒ `0` 仍算"已填"、空才算"没填"（两处口径一致）。
        const rawAmount = item.actualAmount;
        const amountKnown = !(rawAmount === undefined || rawAmount === null
          || String(rawAmount).trim() === '');
        const actualAmountCents = amountKnown ? cents(rawAmount, '销售明细实收金额') : 0;
        if (amountKnown && actualAmountCents <= 0) throw new Error('销售明细实收金额必须大于 0');
        if (positiveInteger(item.quantity, '销售数量') !== 1) {
          throw new Error(kind.requiresSize
            ? '一条销售明细只能记录一双鞋；请逐双说明实收金额'
            : '一条销售明细只能记录一件配品');
        }
        const row = {
          kind: kind.key,
          linkField: kind.detailLinkField,
          amountKnown,
          actualAmount: amountKnown ? actualAmountCents / 100 : null,
          // ⭐ 一件明细自己的赠品文本（有描述用描述；`gift=true` 没描述用占位；否则空）。
          //   ⚠️ 它**不再写进明细**（那一列已被她删掉），只在下面合并成**主表那一列**。
          gift: giftTextOfItem(item),
          // 配品当场结清、不跟踪交付，直接写成已交付，不会进待交付列表也不会扣库存。
          fulfillmentStatus: kind.requiresFulfillment ? '未交付' : '已交付',
          // **这一行自己的**交易类型关联（单选）。
          tradeTypeRecordId: await tradeTypeRecordIdForItem(item.tradeTypeCode),
        };
        if (!kind.requiresSize) {
          const accessoryRecordId = String(item.accessoryRecordId || '').trim();
          if (!accessoryRecordId) throw new Error('配品明细缺少配品记录，请先在「其他配品」里确认这一件');
          expected.push({ ...row, linkRecordId: accessoryRecordId, size: null, sizeRecordId: '' });
          continue;
        }
        const product = await this.references.resolveProduct({ ...item, matchMode: 'sales' });
        const size = positiveInteger(item.size, '尺码');
        const sizeReference = await this.getSizeReferences().resolveByNumber(size);
        expected.push({ ...row, linkRecordId: product.recordId, size, sizeRecordId: sizeReference.recordId });
      }
      const payments = input.payments || (input.totalPaid && input.paymentMethod
        ? [{ amount: input.totalPaid, method: input.paymentMethod, operatorOpenId: input.operatorOpenId }]
        : []);
      if (payments.some((payment) => payment.status === '未收款')) {
        throw new Error('待收款记录由销售入账自动生成，请勿作为实际收款提交');
      }
      // ⚠️ 2026-10-11：**空的实收不计入合计**（`amountKnown` 为假 ⇒ 贡献 0），
      //    它不该被当成"卖了 0 元"，也不该让 `paidCents > totalCents` 的护栏永远触发。
      const totalCents = expected.reduce((sum, item) => (
        sum + (item.amountKnown ? cents(item.actualAmount, '实收金额') : 0)
      ), 0);
      const paidCents = payments.reduce((sum, payment) => sum + cents(payment.amount, '收款金额'), 0);
      if (paidCents > totalCents) throw new Error('本次收款超过本单实收金额');
      if ((input.knownRecordIds?.details || []).slice(expected.length).some(Boolean)) {
        throw new Error('已保存的销售明细数量超过当前草稿，已停止重试');
      }
      const table = this.gateway.table('salesDetail').fields;
      const existing = (await withSalesReadRetry(() => this.gateway.listAll('salesDetail'), 'sale_detail_list')).filter((record) =>
        linkedRecordIds(record.fields?.[table.salesEntry]).includes(salesEntryRecordId));
      for (const id of input.knownRecordIds?.details || []) {
        if (!id || existing.some((record) => record.record_id === id)) continue;
        existing.push(await withSalesReadRetry(
          () => readSaleLinkedRecord(this.gateway, 'salesDetail', id, table.salesEntry, salesEntryRecordId),
          'sale_detail_by_id',
        ));
      }
      const used = new Set();
      const reserved = new Set((input.knownRecordIds?.details || []).filter(Boolean));
      const rows = expected.map((item, index) => {
        const knownId = input.knownRecordIds?.details?.[index];
        // ⚠️ 「实收金额」的比对必须认**「空对空」**（2026-10-11 方案甲）：
        //    她什么都没填时写进去的就是**空**，重试时"空 vs 空"要算**一致**，
        //    否则一次普通重试会被误判成「与当前草稿不一致，已停止重试」。
        const amountMatches = (record) => {
          const cell = textValue(record.fields?.[table.actualAmount]).trim();
          if (cell === '') return !item.amountKnown;
          return item.amountKnown && Number(cell) === item.actualAmount;
        };
        const match = existing.find((record) => !used.has(record.record_id) &&
          (knownId ? record.record_id === knownId : !reserved.has(record.record_id)) &&
          linkedRecordIds(record.fields?.[table[item.linkField]]).includes(item.linkRecordId) &&
          // 尺码是单选关联：鞋必须正好是这一条；配品没有尺码，关联必须为空。
          (item.sizeRecordId
            ? singleLinked(record.fields?.[table.size], item.sizeRecordId)
            : linkedRecordIds(record.fields?.[table.size]).length === 0) &&
          amountMatches(record));
        // ⚠️ 明细这一侧**不再比赠品**（2026-10-08）：那一列已被她删除，
        //   赠品现在是**整单一条**、比在销售主表上（见下面的 gift 段）。
        if (knownId && !match) throw new Error(`已记录的销售明细 ${knownId} 与当前草稿不一致，已停止重试`);
        if (match) {
          used.add(match.record_id);
        }
        return { item, recordId: match?.record_id || '', index };
      });
      if (existing.some((record) => !used.has(record.record_id))) {
        throw new Error('销售主表已有与当前草稿不一致的明细，已停止自动重试');
      }
      // ⭐ 赠品：一单一条，落在**销售主表那一行**（2026-10-08）。
      //   合并规则（按明细顺序 / 拆单个赠品 / 去重 / 用「、」连）见 `config/salesGift`。
      //   幂等/回读比对也从"明细的赠品列"改成"主表的赠品串"：
      //   主表已有非空、且与这次草稿算出来的**不同** ⇒ 判不一致、停止重试（草稿变了要能被识别）。
      const orderGift = mergeGiftTexts(expected.map((item) => item.gift));
      const existingGift = textValue(entry?.fields?.[entryFields.gift]).trim();
      if (existingGift && existingGift !== orderGift) {
        throw new Error('销售主表已记录的赠品与当前草稿不一致，已停止重试');
      }
      // ⚠️⚠️ 2026-10-12：这里**试过**"值没变就不写"（省掉那次空串 PATCH），**已回退**——
      //    理由（诚实纪律，逐条）：`salesGiftOnEntry` / `scanSaleAccessoryAndRemark` 有 **3 条**
      //    既有用例钉的正是"**这一列被写一次**（没有赠品 ⇒ 写空串）"这个行为；
      //    在生产表上"写空串"与"压根不写"肉眼一样，但**哨兵**把"这一列被写过"当成了语义。
      //    ⇒ 为了省 1 次 PATCH 去改别人 3 条哨兵，是**坏的交换**。要省它必须先与 Lead 对齐
      //      "赠品列被写过的痕迹算不算语义"。
      // 写空也要写（与 2026-10-08 之前的明细语义一致：没有赠品 ⇒ 这一列是**空串**）。
      await this.gateway.update('salesEntry', salesEntryRecordId, { gift: orderGift }, { correlation });
      detailPlan = rows.length;
      // ⭐ 2026-10-12：**销售明细ID** = `{销售单号}-{两位序号}`（业务负责人定的格式）。
      //    序号的来源 = **这一单已有的行**（`existing` 上面刚读过，零额外请求）⇒
      //    **按创建顺序往下排、绝不重排已有行**（后补的行接着排；那张单是售后单时，
      //    它的明细行关联的是**原主表** ⇒ 排号也接着原单来，不会从 -01 重来）。
      const saleOrderNo = textValue(entry?.fields?.[entryFields.orderNo]).trim();
      const detailIdState = createState(existing, table.detailId);
      if (!saleOrderNo) {
        logWarn('sales.detail_id.skipped', {
          sales_entry_record_id: salesEntryRecordId, reason: 'order_no_missing', ...correlation,
        });
      }
      for (const row of rows) {
        if (!row.recordId) {
          const detailId = saleOrderNo
            ? nextId({ state: detailIdState, orderNo: saleOrderNo, kind: 'detail' }) : '';
          const created = await this.gateway.create('salesDetail', {
            salesEntry: relation(salesEntryRecordId),
            ...(detailId ? { detailId } : {}),
            // 鞋写「编号」，配品写「配品」——字段由可售品配置声明。
            [row.item.linkField]: relation(row.item.linkRecordId),
            ...(row.item.sizeRecordId ? { size: relation(row.item.sizeRecordId) } : {}),
            // 🔴 明细**不带**赠品（那一列 2026-10-08 已被她整列删除；带了会抛「未配置语义字段」）。
            //    赠品写在上面那段：销售主表那一行，一单一条。
            // ⭐ 2026-10-11（方案甲）：实收**没填就不带这一列**（那一格留空，不写 0）。
            ...(row.item.amountKnown ? { actualAmount: row.item.actualAmount } : {}),
            fulfillmentStatus: row.item.fulfillmentStatus,
            // ⭐ 这一行**自己的**「行为管理」记录（单选）；解析不到时退回主表那条。
            ...(row.item.tradeTypeRecordId ? { tradeType: relation(row.item.tradeTypeRecordId) } : {}),
          }, { correlation });
          row.recordId = created.recordId;
        }
        detailsPersisted += 1;
        await input.onRecordPersisted?.('details', row.index, row.recordId);
      }
      // ⭐ 2026-10-12：主表「交易类型」= 这一单**明细的交易类型**（她：「看实时库存里有没有」）。
      //    🔴 这一列是**多选**关联（只读核过生产真表：`type=18 / ui_type=SingleLink`，
      //       但 `property = {"multiple":true,"table_id":"tblbTvUT4AFsCK4K"}` ⇒ **允许多选**）——
      //       所以**混合单写多个值**（她：「我们之前是可以多选的，所以混合单它可以多选」）。
      //    · 去重（多行都是现货 ⇒ 只写一个现货记录）；
      //    · 顺序 = **明细里首次出现的顺序**（她看表时与明细顺序一致，不用记"现货一定在前"）；
      //    · 写入形状走既有 `relation()`：它**本来就认数组**（多选关联 = 记录 id 数组）。
      //    幂等：已有值且与本次**同一集合** ⇒ 不重复写；不一致 ⇒ 判草稿变了、停止重试（与赠品同一套）。
      const tradeTypeIds = [...new Set(expected
        .map((item) => String(item.tradeTypeRecordId || '').trim())
        .filter(Boolean))];
      if (tradeTypeIds.length) {
        const existingTradeType = linkedRecordIds(entry?.fields?.[entryFields.tradeType]);
        const sameSet = existingTradeType.length === tradeTypeIds.length
          && existingTradeType.every((id) => tradeTypeIds.includes(id));
        if (existingTradeType.length && !sameSet) {
          throw new Error('销售主表已记录的交易类型与当前草稿不一致，已停止重试');
        }
        if (!existingTradeType.length) {
          await this.gateway.update('salesEntry', salesEntryRecordId,
            { tradeType: relation(tradeTypeIds) }, { correlation });
          logInfo('sales.trade_type.resolved', {
            sales_entry_record_id: salesEntryRecordId,
            order_no: textValue(entry?.fields?.[entryFields.orderNo]),
            trade_type_count: tradeTypeIds.length,
            multiple: tradeTypeIds.length > 1,
            ...correlation,
          });
        }
      }
      // 「货」这一维写完了（收款还没开始）：先落「已写入」，这样后面收款失败时
      // 她也能从表里一眼看出"明细是好的、坏在钱那一列"。
      await this.status.write(salesEntryRecordId, { sales: WRITE.sales.done }, correlation);
      const detailRecordIds = rows.map((row) => row.recordId);
      // ⭐ **差额（分）** = 「每件实收合计 − 已收合计」—— 全仓**只有这一个**差额算法
      //   （整数分相减，落库时 ÷100 还原成元）。这里**不新写**一个 ✗。
      const outstandingCents = totalCents - paidCents;
      // ⭐⭐ 2026-10-16 晚（业务负责人**裁定** · 她亲口选的「A」，弹窗逐字确认过）：
      //   「**客户少付 ⇒ 自动记一条【未收款】（差额）**」
      //   例：货品 300、客户只付 100 ⇒ **系统自动**写一条【未收款 200】✓
      //   ⚠️ **改后逐字**：差额 > 0 ⇒ **自动补**那条【未收款】—— **不必等她明说欠** ✓
      //   ⚠️ **改前逐字**（老口径，已作废）✗：
      //      「未收款只在**她明说欠**时才补（业务负责人口径：「如果用户说欠多少钱，你再做欠款，
      //       用户又没说呀」）…… 后端不拿「成交 − 已收」的差额去猜是还价还是欠款：她说欠才算欠。」
      //   依据 = ① 她 2026-10-16 晚裁定 —— 我问的原话：
      //            「客户少付钱时…那 200 差额**要不要系统自动**写一条【未收款】？」
      //            ⇒ 她选「**A：自动记（差额⇒未收款）**」；
      //          ② 她 2026-10-16 晚**追加逐字**：「那个还是**群聊文字识别**的时候，
      //             **现在已经不需要，直接对比金额就可以了**」
      //             ⇒ 老口径（"她明说欠才算欠"）是**群聊文字识别那个时代**的产物，**已不需要** ✗；
      //               现在的口径 = **直接对比金额**（收款合计 vs 货品/应收合计）✓；
      //          ③ 她 2026-10-14 逐字：「**只要本次付的金额小于累计的，那么差额都是未收款，
      //             包括本次付款为 0**」；
      //          ④ 她 2026-10-14 逐字：「**去掉三个单选、按金额自动算**」
      //             （档位不再由她选 ⇒ 钱只能按差额算，没有"她明说欠"这个动作了）。
      //   ⚠️ 与 `config/saleSettlement.js` 的纯函数 `autoModeOf()` **同一套语义**
      //      （差额 = 累计 − 已收；**累计不可知 ⇒ 不编差额** ✗）。
      const owedStated = !(input.owed === undefined || input.owed === null
        || String(input.owed).trim() === '');
      // 她**明说**的欠款金额（AI 解析出来的）：新口径下它**只是交叉校验**，不再是唯一依据。
      //   · 「卖了 119，先给 100，还欠 19」→ owed=19，与差额一致 ⇒ 照旧补一条 19 ✓
      //   · 「卖 300、收到 100」（她没提欠）   → owed 空 ⇒ **自动**按差额补一条 200 ✓（本次改动）
      const statedOwedCents = owedStated ? cents(input.owed, '欠款金额') : 0;
      // 🔴 2026-10-11（方案甲）：**只要有明细没填「实收金额」，差额就算不出来** ⇒
      //    这时**不许**下"差额"的结论（宁可拦住 / 不挂，也不写一条金额算错的欠款）。
      const amountsKnown = expected.every((item) => item.amountKnown);
      if (statedOwedCents > 0 && !amountsKnown) {
        throw new Error('还有明细没填「实收金额」，算不出欠款差额；请先补上实收金额再确认');
      }
      if (statedOwedCents > 0 && statedOwedCents !== outstandingCents) {
        // 说出的欠款和「成交 − 已收」对不上：宁可拦下来人工核对，也不静默写一条错账。
        throw new Error('她说的欠款与「实收金额−已收金额」不一致，请核对后再确认');
      }
      // 差额 > 0 且明细金额都齐 ⇒ **自动**挂那条【未收款】（金额 = 差额，方式留空、
      // 状态 = 表里既有的「未收款」—— 形状由 `PaymentService.recordInitialBatch` 决定）。
      //   ⚠️ 明细金额不齐 ⇒ **不编**差额（与 `autoModeOf()` 的 `no_known_total` 同一口径 ✓）。
      const owedCents = statedOwedCents > 0
        ? statedOwedCents
        : (amountsKnown ? outstandingCents : 0);
      const expectedPayments = owedCents > 0
        ? [...payments, { amount: outstandingCents / 100, status: '未收款' }] : payments;
      const paymentRecordIds = await this.payments.recordInitialBatch(salesEntryRecordId, expectedPayments, {
        knownRecordIds: input.knownRecordIds?.payments,
        onRecordPersisted: (index, id) => input.onRecordPersisted?.('payments', index, id),
        correlation,
      });
      financialRecorded = true;
      // 「钱」这一维写完了。⚠️ 这正是 6 处闸门判据读的那一列：
      // 闸门认的是**两代字面量**（旧「已入账」/ 新「已写入」），见 config/salesStatusDimensions。
      await this.status.write(salesEntryRecordId, { funds: WRITE.funds.done }, correlation);
      await this.progress.sync(salesEntryRecordId, { detailRecordIds, paymentRecordIds });
      // ⭐⭐ 2026-10-12（提速）：**不再"写完再读一遍主表"** —— 单号在 `_confirm` 开头就已经读到
      //    （上面那次 `get('salesEntry')` 的 `entry`），而这一段里**没有任何一步会改单号**
      //    （只写状态维度 / 赠品 / 交易类型 / 明细 / 收款）。
      //    ⇒ 直接用它，少打一次 `get:salesEntry`；`sourceNo`（给她的单号）的取值口径**逐字不变**
      //      （读不到照旧回落到 `salesEntryRecordId`）。
      const sourceNo = textValue(entry?.fields?.[entryFields.orderNo]) || salesEntryRecordId;
      // ⚠️ 这条日志只回答【落表这一步】做了什么，**不是**"整单扣没扣库存"。
      //    2026-10-07 的真实误判：有人把 `inventory_applied: false` 读成了"整单没扣库存"，
      //    其实库存在**交付那一步**（SalesDeliveryService）才扣，而且那单已经扣了。
      //    ⇒ 字段名一律带**范围**（`inventory_applied_by_this_step`），并写明**下一步做什么**
      //      （`inventory_planned` / `inventory_step`）。库存真扣完时的**正向证据**是
      //      `sales.inventory.applied`（见 salesDeliveryService），不要拿这条当日志判据。
      logInfo('v1.sale.posted', { sales_entry_record_id: salesEntryRecordId, detail_count: detailRecordIds.length,
        payment_count: paymentRecordIds.length, step: 'posting', inventory_applied_by_this_step: false,
        inventory_planned: true, inventory_step: 'after_delivery', ...correlation });
      // 返回值里的 inventoryApplied 与上面那条日志**逐字同义**：本步不动库存。
      return { sourceNo, detailRecordIds, paymentRecordIds, inventoryApplied: false };
    } catch (error) {
      error.saleRecordsWritten = financialRecorded;
      // 失败时把两个维度写到**它能被看懂的那一档**：
      //   · 销售状态：没开始写 = 未写入；写了但没写全 = 部分写入；全写上了 = 已写入；一条都没成 = 写入失败
      //   · 资金状态：收款明细全部记上了 = 已写入；否则 = 写入失败（这一维的值域里没有"部分"）
      const salesStatus = detailPlan === 0 ? WRITE.sales.none
        : detailsPersisted === 0 ? WRITE.sales.failed
          : detailsPersisted >= detailPlan ? WRITE.sales.done : WRITE.sales.partial;
      await this.status.write(salesEntryRecordId, {
        sales: salesStatus,
        funds: financialRecorded ? WRITE.funds.done : WRITE.funds.failed,
      }, correlation);
      // ⚠️ 2026-10-09：这里原来会把失败的**人话**回填进「失败原因」列（她照着改就能重试）。
      //    那一列被业务负责人从生产表删掉了 ⇒ **写入点随列一起删**（见
      //    `config/v1BitableSchema.salesEntry` 段）。失败的可见落点现在是：
      //      · 状态维度（上面那次 `status.write`：写入失败 / 部分写入）；
      //      · 日志 `v1.sale.post_failed`（一条都没成）/ `v1.sale.sync_pending`（明细已写、
      //        后续同步待恢复，带 `error.message`）；
      //      · 她在群里看到的卡片 / 文案（那条链路一个字没动）。
      logError(financialRecorded ? 'v1.sale.sync_pending' : 'v1.sale.post_failed', {
        sales_entry_record_id: salesEntryRecordId, error: error.message, ...correlation,
      });
      throw error;
    }
  }
}

module.exports = { SalesOrderService };
