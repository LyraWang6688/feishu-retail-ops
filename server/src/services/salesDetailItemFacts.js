// 「这一笔待处理单里卖的是什么」——**只给事实**：货号（鞋）/ 配品名称 + 尺码。
//
// 为什么单独一个模块：这段逻辑既不属于「第二次交付」的成交动作，也不属于展示文案，
// 它只回答一件事——**一条销售明细行指的是哪一件、那一件叫什么、什么尺码**。
// 文案（`货号 37码` 怎么拼、多件之间用什么分隔符）在 `config/pendingDealPush`，
// 本模块里**一行中文业务文案都没有**。
//
// ⚠️ 数据来源：调用方把「货品信息」「其他配品」两张表**整表读一次**后的索引传进来，
//    本模块自己**不读表**（否则 N 条明细就会变成 N 次请求）。
// ⚠️ 尺码走调用方注入的 `resolveSize`（「尺码管理」是关联字段，要走共享的尺码解析；
//    见 services/sizeReferenceService：它有 30 秒缓存，整轮推送只读一次）。
//
// ⚠️ 缺货号 / 缺配品名称的行 → **不产出条目**（宁可这一件不显示，也不要在群里
//    拼出 ` 码` 这种残句）；只把计数还给调用方去记日志。
//
// ⚠️ **已知边界（故意不处理的）**：售后写回的「销售退货」明细行是**关联在原单上**的
//    （见 afterSalesService 的 `salesEntry: relation(originalSalesEntryRecordId)`），
//    所以它也会出现在这里的货号尺码里。这与上面那个「待收金额」用的是**同一批明细行**
//    （金额口径一个字没动）；「只列没退过的货」属于**新的业务口径**，要业务负责人点头才能改。

const { linkedRecordIds, textValue } = require('./v1BitableGateway');
const { SELLABLE_KINDS } = require('../config/sellableKinds');

/**
 * 明细行指向的是**哪一种可售品**：字段由 `config/sellableKinds` 声明，
 * 这里不写死「编号」/「配品」。查不到返回 null（这条明细我们不认识它是什么）。
 */
const itemLinkOfDetail = (fields, detailFields) => {
  for (const [kindKey, kind] of Object.entries(SELLABLE_KINDS)) {
    const linkField = kind.detailLinkField;
    if (!detailFields?.[linkField]) continue;
    const ids = linkedRecordIds(fields?.[detailFields[linkField]]);
    if (ids.length) return { kindKey, kind, recordId: ids[0] };
  }
  return null;
};

/**
 * 明细行 → 事实列表 `[{ kind, itemNo, size }]`。
 *
 * `itemNo`：鞋 = 「货品信息.货号」；配品 = 「其他配品.名称」（配品没有货号，这串就是她的叫法）。
 * `size` ：只有 `requiresSize` 的可售品才去解析；解析不到就留空串（**不是** `undefined`，
 *          调用方据此决定拼不拼 `码` 这个后缀）。配品永远留空。
 */
const itemFactsForDetails = async ({
  details = [],
  detailFields = {},
  itemIndex = {},
  resolveSize,
} = {}) => {
  // ⭐ 逐条明细产出、**按明细记录 id 对齐**（不是按数组下标）：
  //    取不到货号的那一件**不产出条目**，按下标对齐会把后面每一件都错位挂到前一行上。
  //    这条不变式由 `itemFactsByDetail` 一处实现，9 点推送那条候选直接复用它。
  const byDetail = await itemFactsByDetail({ details, detailFields, itemIndex, resolveSize });
  const items = [];
  let unlabeledCount = 0;
  let missingSizeCount = 0;
  for (const detail of details) {
    const entry = byDetail.get(detail?.record_id);
    if (!entry || !entry.item) { unlabeledCount += 1; continue; }
    if (entry.missingSize) missingSizeCount += 1;
    items.push(entry.item);
  }
  return { items, unlabeledCount, missingSizeCount };
};

/**
 * 同一条口径，但返回**明细记录 id → 事实**的 Map（`{ item, missingSize }`）。
 *
 * 为什么要有这个入口：9 点推送【预定】是**逐件一行**、【现货待收】要"取它关联销售单下的明细"，
 * 两处都得把"这一条明细是哪一件"对准**那一条明细**本身。用 Map 对齐就不会因为
 * 某一件缺货号而把后面的件错位（这是按下标对齐时的真实错误形态）。
 */
const itemFactsByDetail = async ({
  details = [],
  detailFields = {},
  itemIndex = {},
  resolveSize,
} = {}) => {
  const byDetail = new Map();
  for (const detail of details) {
    const link = itemLinkOfDetail(detail?.fields, detailFields);
    if (!link) continue;
    const { kindKey, kind, recordId } = link;
    const tableKey = kind.detailTableKey;
    const recordsById = itemIndex?.[tableKey]?.byId;
    const labelField = itemIndex?.[tableKey]?.labelField;
    const itemNo = textValue(recordsById?.get(recordId)?.fields?.[labelField]).trim();
    if (!itemNo) continue;
    // ⭐ 2026-10-08 晚（业务负责人：「**还需要在货号和尺码中间加上颜色**」）：
    //    颜色取自**货品信息**上的「颜色」列（单选关联「颜色管理」；单元格文本就是颜色名）。
    //    ⚠️ 只用于**显示**（9 点推送那行「货号 颜色 尺码」）；取不到就留空，
    //    由 `itemTemplate` 自己把多余空格收掉（不会出现「货号  41码」）。
    //    ⚠️ 配品（其他配品表）没有「颜色」列 ⇒ `colorField` 为空 ⇒ color 为空，**不编值**。
    const colorField = itemIndex?.[tableKey]?.colorField;
    const color = colorField
      ? textValue(recordsById?.get(recordId)?.fields?.[colorField]).trim()
      : '';
    let size = '';
    if (kind.requiresSize) {
      size = String(await resolveSize?.(detail) || '').trim();
    }
    byDetail.set(detail.record_id, {
      item: { kind: kindKey, itemNo, color, size },
      // 「鞋缺尺码」= 关联了「尺码管理」但解析不出来（不是错误，是要能查的数据问题）。
      missingSize: Boolean(kind.requiresSize && !size),
    });
  }
  return byDetail;
};

module.exports = { itemFactsForDetails, itemFactsByDetail, itemLinkOfDetail };
