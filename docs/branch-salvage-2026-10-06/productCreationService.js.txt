const { relation, normalizeColor } = require('./v1ReferenceResolver');
const { textValue } = require('./v1BitableGateway');
const { V1_BITABLE_SCHEMA } = require('../config/v1BitableSchema');
const { recordUrl } = require('../utils/feishuLinks');
const { isBlankCost, costValueOf } = require('./arrivalCostPolicy');
const { KeyedSerialQueue } = require('../infrastructure/keyedSerialQueue');
const { logInfo, logWarn } = require('../utils/logger');

/**
 * 新品建档 + 写成本。
 *
 * 为什么单独成一个 service：这两件事和「拍照识别」没有任何关系——
 *   - 建档需要的输入是纯结构化字段：货号、颜色、性别/品类、供应商、成本；
 *   - 写成本的输入也只是「货号 + 可信成本」。
 * 它们此前长在采购到货的 webhook 服务里（那条链路是**临时**的「拍照识别 → 入库」），
 * 于是出现两个问题：① 将来拿掉拍照识别时，会顺手把建档/成本一起拿掉；② 将来
 * 「货品上新提前」/「采购申请提前填」想复用建档，只能去调用到货 webhook。
 * 剥出来之后：到货链路继续用它（行为一字不变），别的入口也能直接喂结构化明细。
 *
 * ⚠️ 本 service **不认识** OCR / 图片 / 「采购到货任务」：
 *   - 待建档明细、成本、已匹配老货品都由调用方算好传进来；
 *   - 「进度存在哪里」由调用方通过 journal 端口提供（到货链路存在任务里）。
 *
 * 幂等（三道，缺一不可，原样保留自到货链路）：
 *   ① 同一个 journal.scope 的两次调用走 creationQueue **串行**——后台那次和她点确认
 *      那次不会同时从存储里读到"还没建"然后各建一条；
 *   ② journal.read() 在**锁内**读进度（到货链路读的就是任务里已落盘的 record_id），
 *      重试时 ensureProduct 命中缓存直接返回，**不建第二条货品**；
 *   ③ 颜色的去重靠颜色表整表读一次 + normalizeColor（同名颜色只建一条）。
 *
 * 失败处理：单条建档失败**不抛**（只有 journal.read()/store 坏了才抛），失败原因
 * 收集进 failures 返回给调用方，由调用方决定怎么告诉人（到货链路写进草稿）。
 * 成本写失败**不算建档失败**（既有规则：成本写不进去不挡入库，只记 warn）。
 */
class ProductCreationService {
  constructor({ gateway, references, creationQueue } = {}) {
    if (!gateway) throw new Error('ProductCreationService 需要 gateway');
    this.gateway = gateway;
    // 供应商查询走调用方传进来的 resolver（到货链路传的是它自己的 references，
    // 保证和剥离前用的是同一个引用、同一套报错口径）。
    this.references = references;
    // 串行队列由调用方注入：到货链路必须和它原有的 creationQueue 是**同一个实例**，
    // 否则「发完卡片后台建」和「她点确认兜底建」会并行、各建一条。
    this.creationQueue = creationQueue || new KeyedSerialQueue();
  }

  /**
   * 建档 + 写成本。
   *
   * @param {object} params
   * @param {object} params.journal 进度落盘端口（「进度存在哪里」由调用方实现）
   * @param {string} params.journal.scope 串行键（同一键串行；到货链路 = taskId）
   * @param {() => Promise<{items: Array, costItems: Array, progress: object}>} params.journal.read
   *   在**锁内**读一次最新状态：本次要建的明细 + 待补成本的老货品 + 上次已落盘的进度。
   * @param {(progress: {products: Array, colors: Array, costWritten: Array}) => Promise<void>} params.journal.save
   *   增量落盘。**必须自己吞掉存储错误并记 warn**（与剥离前的 persistArrivalCreation 一致）：
   *   落盘失败不该把建档判失败。
   * @param {(creation: object) => Promise<void>} [params.journal.writeBack]
   *   锁内收尾（到货链路：把 created_products / creation_state 合并进最新草稿）。
   * @param {string} [params.reason] 只用于日志（到货链路传 'card_sent' / 'confirm'）。
   * @returns {Promise<{state: 'done'|'failed', created: number, cost_written_count: number, failures: Array}>}
   */
  async ensureProducts({ journal, reason = 'unknown' } = {}) {
    if (!journal || typeof journal.read !== 'function') {
      throw new Error('建档缺少进度落盘端口（journal.read）');
    }
    return this.creationQueue.run(journal.scope, async () => {
      // read() 必须在锁内：上一个持锁者可能刚把进度落盘，锁外读会拿到旧快照，
      // 于是"上次已经建好的货品"被判成没建过，重复建一条。
      const { items = [], costItems = [], progress = null } = (await journal.read()) || {};
      const productTable = this.gateway.table('product');
      const context = this.buildContext(progress, journal);

      const failures = [];
      for (const entry of items) {
        try {
          await this.ensureProduct(entry, context);
        } catch (error) {
          failures.push({ item_no: entry.itemNo, color: entry.color, error: error.message });
          logWarn('purchase.arrival.product_create_failed', {
            task_id: journal.scope, item_no: entry.itemNo, color: entry.color, error: error.message,
          });
        }
      }

      // 已经匹配到老货品的行：成本同样只在卡片发出之后写（"发卡片之前不写成本"）。
      // 明细已在调用方按 货号+颜色+货品 去重，这里只负责按顺序写。
      for (const item of costItems) {
        try {
          const record = await this.gateway.get('product', item.productRecordId).catch(() => null);
          await this.applyCost(item, { recordId: item.productRecordId, record }, productTable, context);
        } catch (error) {
          // 成本这条线故意不算进 failures：写不进去不该把她挡在入库外面（见 applyCost 注释）。
          logWarn('purchase.arrival.cost_write_failed', {
            task_id: journal.scope, item_no: item.itemNo, product_record_id: item.productRecordId,
            error: error.message,
          });
        }
      }

      // 建档结果直接从缓存取（含上一次重试已经建好、本次识别里不再出现的条目）。
      // 恢复出来的条目没有回读数据：缺口按"读不到"处理（这些字段现在只进日志/草稿）。
      const createdEntries = [...context.productCache.values()];
      for (const entry of createdEntries) {
        if (!entry.gaps) entry.gaps = productInfoGaps(entry.record, productTable);
      }
      const createdProducts = createdEntries.map((entry) => ({
        product_record_id: entry.recordId,
        item_no: entry.item_no,
        color: entry.color,
        supplier: entry.supplier,
        label: entry.label,
        color_created: entry.color_created,
        missing: entry.gaps.missing,
        missing_sample_image: entry.gaps.missingSampleImage,
        completeness_readable: entry.gaps.completeness_readable,
        // 链接回填给调用方：她点确认之后的结果卡片就用它（她点进去补资料）。
        url: productRecordUrl(productTable.tableId, entry.recordId),
      }));
      const creation = {
        state: failures.length ? 'failed' : 'done',
        created: createdProducts.length,
        cost_written_count: context.costWritten.length,
        failures,
        createdProducts,
        createdColors: context.createdColors.map((item) => ({ name: item.name, colorRecordId: item.colorRecordId })),
      };

      // 收尾（到货链路：合并进**最新**草稿）必须在锁内、且在下面那条日志之前，
      // 与剥离前的顺序一致（先写草稿、再记 creation.finished）。
      if (typeof journal.writeBack === 'function') await journal.writeBack(creation);
      logInfo('purchase.arrival.creation.finished', {
        task_id: journal.scope, reason, state: creation.state,
        pending_count: items.length, created_product_count: createdProducts.length,
        created_color_count: creation.createdColors.length,
        cost_written_count: creation.cost_written_count, failure_count: failures.length,
      });
      return {
        state: creation.state,
        created: creation.created,
        cost_written_count: creation.cost_written_count,
        failures,
      };
    });
  }

  /**
   * 从已落盘的进度恢复建档上下文，重试时直接复用，不再重复建。
   *
   * 进度用**驼峰**字段（products / colors / costWritten）传入，和落盘格式解耦：
   * 到货链路自己负责把它映射到任务里的 arrival_created_products 等字段。
   */
  buildContext(progress, journal = null) {
    const products = Array.isArray(progress?.products) ? progress.products : [];
    const colors = Array.isArray(progress?.colors) ? progress.colors : [];
    const costWritten = Array.isArray(progress?.costWritten) ? progress.costWritten : [];
    const context = {
      journal,
      productCache: new Map(),
      colorIndex: new Map(),
      createdColors: colors.map((item) => ({ ...item })),
      createdLog: products.map((item) => ({ ...item })),
      colorTableLoaded: false,
      // 已经处理过成本的货品（写成功，或已判定"不覆盖"）：重试时直接跳过，不重复写。
      costApplied: new Map(costWritten.map((item) => [item.productRecordId, item.cost])),
      costWritten: costWritten.map((item) => ({ ...item })),
    };
    // 上次已经建好的颜色先占位：重试时同一个颜色名不会再建第二条。
    for (const item of context.createdColors) {
      if (item?.name) context.colorIndex.set(normalizeColor(item.name), item.colorRecordId);
    }
    for (const item of context.createdLog) {
      context.productCache.set(`${item.itemNo}|${item.color}`, {
        is_new: true,
        recordId: item.productRecordId,
        record: null,
        item_no: item.itemNo,
        color: item.color,
        supplier: item.supplier || '',
        label: `${item.itemNo}${item.color}`,
        color_created: Boolean(item.colorCreated),
        gaps: null,
      });
    }
    return context;
  }

  /**
   * 增量落盘：把「已经写出去的远端记录」及时交给调用方持久化。
   * 为什么必须及时：建档是远端写入，崩溃 / 响应丢失后重收 webhook 会重跑一次，
   * 那时飞书列表可能还没读到刚建的货品，只靠"再查一遍"不足以防重复。
   *
   * ⚠️ 不 try/catch：吞异常是 journal.save **实现方**的约定（到货链路在那里记 warn），
   * 这样"落盘失败"的日志口径留在知道存储长什么样的那一侧。
   */
  persistCreation(context) {
    if (!context?.journal) return Promise.resolve();
    return context.journal.save({
      products: context.createdLog,
      colors: context.createdColors,
      costWritten: context.costWritten,
    });
  }

  /**
   * 按颜色名找「颜色管理」的记录，找不到就新建一条并记下来。
   *
   * 颜色表是**共享主数据**：OCR 抖一下（「棕色」/「棕」）就多建一条，以后同一个颜色
   * 会散成好几条，所以比对用 normalizeColor（去空白、去末尾「色」），
   * 并且整张表只读一次、同一次建档里同名颜色只建一条。
   */
  async ensureColor(color, context) {
    const colorTable = this.gateway.table('color');
    if (!context.colorTableLoaded) {
      for (const record of await this.gateway.listAll('color')) {
        const name = normalizeColor(textValue(record?.fields?.[colorTable.fields.name]));
        if (name && !context.colorIndex.has(name)) context.colorIndex.set(name, record.record_id);
      }
      context.colorTableLoaded = true;
    }
    const key = normalizeColor(color);
    if (context.colorIndex.has(key)) return { recordId: context.colorIndex.get(key), created: false };

    const created = await this.gateway.create('color', { name: color });
    const recordId = created?.recordId || '';
    if (!recordId) throw new Error(`颜色「${color}」新建失败`);
    context.colorIndex.set(key, recordId);
    context.createdColors.push({ name: color, colorRecordId: recordId });
    await this.persistCreation(context);
    logInfo('purchase.arrival.color_created', { color, color_record_id: recordId });
    return { recordId, created: true };
  }

  /**
   * 建一条「货品信息」，然后原样返回新记录。
   *
   * ⚠️ 只由 ensureProducts 调用，调到它就意味着已经过了"发确认卡片"那一步
   *（产品负责人 2026-10-05 定的顺序："发卡片之前不做创建"）。别把它挪到匹配那一步。
   *
   * 只写确定知道的字段（产品负责人 2026-10-05 定稿的建档内容）：
   * 货号、颜色（关联）、供应商（关联，找不到就留空）、类别（识别出男/女才填，
   * 认不出留空——默认成 A 会把女鞋写进男鞋）、成本（有可信价格才填，否则留空）。
   * 刻意不写「编号」「货品状态」「缺失信息说明」——这三个在飞书里是公式字段，
   * 写进去会直接 FieldNameNotFound，而且它们的值本来就该由表自己算。
   * 也刻意不写「单价」：建档时看到的价格是采购成本，不是销售单价。
   *
   * @param {{itemNo: string, color: string, gender?: string, category?: string,
   *   supplier?: string, cost?: number|null}} item 结构化明细；cost 为 null/缺省 = 不写成本
   */
  async ensureProduct(item, context) {
    const itemNo = String(item.itemNo || '').trim();
    const color = String(item.color || '').trim();
    const cacheKey = `${itemNo}|${color}`;
    const cached = context.productCache.get(cacheKey);
    // 同一个「货号+颜色」会有多个尺码：复用第一条建好的记录（含上次重试建的），
    // 不要再建第二条——这就是"重复建档只建一条"的落点。
    if (cached) {
      // 从上次重试恢复出来的条目还没有回读数据：补一次回读（只有日志/草稿用得上）。
      if (!cached.gaps) {
        cached.record = (await this.gateway.get('product', cached.recordId).catch(() => null)) || cached.record;
        cached.gaps = productInfoGaps(cached.record, this.gateway.table('product'));
      }
      return { ...cached };
    }

    const productTable = this.gateway.table('product');
    const values = { itemNo };
    if (color) values.color = relation((await this.ensureColor(color, context)).recordId);

    // 供应商也只在识别到名字、且供应商表里确实有这条时才关联；找不到留空，不新建、不猜。
    const supplierName = String(item.supplier || '').trim();
    if (supplierName) {
      try {
        const supplier = await this.references.resolveSupplier(supplierName);
        if (supplier?.recordId) values.supplier = relation(supplier.recordId);
      } catch (error) {
        logWarn('purchase.arrival.supplier_not_found', { item_no: itemNo, supplier: supplierName, error: error.message });
      }
    }
    const category = genderToCategory(item.gender || item.category);
    if (category) values.category = category;

    // 成本：调用方已经按「同货号价格冲突就整条不给值」的口径算好放进 item.cost
    //（null / 缺省 = 没有可信价格）。建档只会新建记录，不存在覆盖已有成本的问题——
    //命中的老货品一律原样使用、不改动。
    const createdAtCost = item.cost ?? null;
    if (createdAtCost !== null) values.cost = createdAtCost;

    const created = await this.gateway.create('product', values);
    const recordId = created?.recordId || created?.record_id || '';
    if (!recordId) throw new Error(`新品建档失败：${itemNo}${color}`);

    const entry = {
      is_new: true,
      recordId,
      record: created?.record || null,
      item_no: itemNo,
      color,
      supplier: supplierName,
      label: `${itemNo}${color}`,
      color_created: context.createdColors.some((colorItem) =>
        normalizeColor(colorItem.name) === normalizeColor(color)),
      gaps: null,
    };
    context.productCache.set(cacheKey, entry);
    context.createdLog.push({
      itemNo, color, productRecordId: recordId, supplier: supplierName, colorCreated: entry.color_created,
    });
    // 建档时已经把成本写进去了：登记成"已处理"，applyCost 就不会再对它走一次
    //"成本为空 → 写"的判断（重试也不会）。
    if (createdAtCost !== null) {
      context.costApplied.set(recordId, createdAtCost);
      context.costWritten.push({
        itemNo, color, productRecordId: recordId, cost: createdAtCost, source: 'create',
      });
      logInfo('purchase.arrival.cost_written', {
        item_no: itemNo, color, product_record_id: recordId, cost: createdAtCost, source: 'create',
      });
    }
    // 先落盘再回读：哪怕回读或后续步骤失败，重试也能凭这条记录跳过重复建档。
    await this.persistCreation(context);

    // 建档后回读一次：公式（缺失信息说明）是飞书算的，创建响应里通常还没有值。
    // 回读失败不影响入库（产品负责人：卡片上不写"还差什么字段"）。
    try {
      entry.record = (await this.gateway.get('product', recordId)) || entry.record;
    } catch (error) {
      logWarn('purchase.arrival.created_product_readback_failed', { product_record_id: recordId, error: error.message });
    }
    entry.gaps = productInfoGaps(entry.record, productTable);
    logInfo('purchase.arrival.product_created', {
      item_no: itemNo, color, product_record_id: recordId, color_created: entry.color_created,
      missing: entry.gaps.missing, missing_sample_image: entry.gaps.missingSampleImage,
    });
    return entry;
  }

  /**
   * 把可信成本写进货品「成本」。
   *
   * 产品负责人的口径：「如果有的到货单上有价格的，那就是成本。」
   * 单据上的「销售价 / 单价」列 → 「货品信息」的「成本」字段（number 字段，直接写数字）。
   *
   * 写入规则刻意保守（谁改这里都要先读一遍）：
   *   1. 只在成本**为空**时写（含数字 0 都算已有值，见 arrivalCostPolicy.isBlankCost）；
   *   2. 已有成本 → 不覆盖，记一条 warn（带 货号 / 已有值 / 识别到的值）；
   *   3. 同一货号多行价格不一致 → 整条不写（调用方在算 item.cost 时已经折成 null）；
   *   4. 价格转不成正数 → 不写（item.cost 就是 null）；
   *   5. 重试不重复写：写成功的货品记进 context.costApplied 并落盘，重试直接跳过。
   *
   * 写失败**不抛错**：成本写不进去不该把整批到货卡住（货已经到了，入库优先）；
   * 记 warn 后由下一次重试再试（赋值幂等，重复写同一个值无害）。
   *
   * @returns {Promise<{applied: boolean, reason: string}|null>} 只用于日志/测试断言
   */
  async applyCost(item, product, productTable, context) {
    const itemNo = String(item?.itemNo || '').trim();
    const cost = item?.cost ?? null;
    if (cost === null) return null;
    const recordId = product.recordId;
    if (!recordId) return null;

    // 本次（或上次重试）已经处理过这条货品：直接跳过，不重复写、也不再打日志。
    if (context.costApplied.has(recordId)) return { applied: false, reason: 'already_applied' };

    const existing = product.record?.fields?.[productTable.fields.cost];
    if (!isBlankCost(existing)) {
      // 已有成本一律不覆盖；只有「值真的不一样」才 warn。
      // 值相同说明是上一次重试已经写成功了（这就是为什么必须先记账再往下走）。
      if (costValueOf(existing) === cost) {
        context.costApplied.set(recordId, cost);
        logInfo('purchase.arrival.cost_already_set', {
          item_no: itemNo, product_record_id: recordId, cost,
        });
      } else {
        context.costApplied.set(recordId, cost);
        logWarn('purchase.arrival.cost_kept', {
          item_no: itemNo,
          product_record_id: recordId,
          existing_cost: textValue(existing),
          recognized_cost: cost,
          reason: '货品已有成本，识别到的到货单价不覆盖',
        });
      }
      return { applied: false, reason: 'existing_cost' };
    }

    try {
      await this.gateway.update('product', recordId, { cost });
    } catch (error) {
      logWarn('purchase.arrival.cost_write_failed', {
        item_no: itemNo, product_record_id: recordId, cost, error: error.message,
      });
      return { applied: false, reason: 'write_failed' };
    }

    context.costApplied.set(recordId, cost);
    context.costWritten.push({
      itemNo, color: String(item?.color || '').trim(), productRecordId: recordId, cost, source: 'update',
    });
    await this.persistCreation(context);
    logInfo('purchase.arrival.cost_written', {
      item_no: itemNo, product_record_id: recordId, cost, source: 'update',
    });
    return { applied: true, reason: 'written' };
  }
}

// 鞋盒/吊牌上的「品名」：女鞋 → B、男鞋 → A。单选选项就是 A/B 两个字。
// 识别不出性别就留空：默认成 A 会把女鞋写进男鞋，比空着更难发现。
const genderToCategory = (value) => {
  const label = String(value || '').trim();
  if (/女/.test(label)) return 'B';
  if (/男/.test(label)) return 'A';
  return '';
};

/**
 * 从货品记录里读「还缺哪些资料」。
 *
 * 「缺失信息说明」是飞书公式：齐备时返回「齐备」，否则返回缺的字段名（如「成本、品类」）。
 * 和销售侧 loadProductIndex 同一个思路——不自己逐字段判断，单一数据源留在表里。
 * 「样例图」是附件字段，不在公式里，要单独看有没有图。
 *
 * 公式刚建完记录时可能还没算出来，所以 readable 要区分「齐备」和「读不到」，
 * 读不到时只敢说"还没齐、去补"，不敢说"齐备"。
 */
const productInfoGaps = (record, productTable) => {
  const fields = record?.fields || {};
  const completeness = textValue(fields[productTable.fields.completeness]).trim();
  const sampleImages = fields[productTable.fields.sampleImage];
  return {
    missing: completeness && completeness !== '齐备'
      ? completeness.split('、').map((name) => name.trim()).filter(Boolean)
      : [],
    missingSampleImage: !(Array.isArray(sampleImages) && sampleImages.length > 0),
    completeness_readable: Boolean(completeness),
  };
};

// 记录链接只是给她点进去补资料用的：读不到 app token（本地/测试）时给不出链接，
// 但绝不能因此打断建档和入库——货已经在仓库里了。
const productRecordUrl = (tableId, recordId) => {
  let appToken = '';
  try { appToken = V1_BITABLE_SCHEMA.appToken; } catch { appToken = ''; }
  return recordUrl({ appToken, tableId, recordId });
};

module.exports = {
  ProductCreationService,
  genderToCategory,
  productInfoGaps,
  productRecordUrl,
};
