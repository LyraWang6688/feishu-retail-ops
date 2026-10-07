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
  const items = [];
  let unlabeledCount = 0;
  let missingSizeCount = 0;
  for (const detail of details) {
    const link = itemLinkOfDetail(detail?.fields, detailFields);
    if (!link) { unlabeledCount += 1; continue; }
    const { kindKey, kind, recordId } = link;
    const tableKey = kind.detailTableKey;
    const recordsById = itemIndex?.[tableKey]?.byId;
    const labelField = itemIndex?.[tableKey]?.labelField;
    const itemNo = textValue(recordsById?.get(recordId)?.fields?.[labelField]).trim();
    if (!itemNo) { unlabeledCount += 1; continue; }
    let size = '';
    if (kind.requiresSize) {
      size = String(await resolveSize?.(detail) || '').trim();
      if (!size) missingSizeCount += 1;
    }
    items.push({ kind: kindKey, itemNo, size });
  }
  return { items, unlabeledCount, missingSizeCount };
};

module.exports = { itemFactsForDetails, itemLinkOfDetail };
