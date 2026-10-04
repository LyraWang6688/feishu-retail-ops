const { textValue, linkedRecordIds } = require('./v1BitableGateway');

// 「实时库存」是"店里实际有什么"，「货品信息」是"配置过什么"。
// 销售录单卖的是实物，所以入口按实时库存匹配，而不是先查货品资料。
//
// 实时库存表里没有「颜色」字段，但飞书侧的「库存键」公式是
// `货号|颜色|类别|尺码`（生产库 1086/1086 条都是 4 段），
// 一张表读一次就能同时拿到货号、颜色、尺码和所属状态。
const STOCK_KEY_SEPARATOR = '|';
const STOCK_KEY_SEGMENTS = 4;

// 库存键格式不符的记录必须被跳过并计数，不能猜。
// 按错的键匹配等于把这一双记到别的款上——宁可少一双候选，也不要记错账。
const parseStockKey = (value) => {
  const raw = textValue(value);
  if (!raw) return null;
  const parts = String(raw).split(STOCK_KEY_SEPARATOR);
  if (parts.length !== STOCK_KEY_SEGMENTS) return null;
  const [itemNo, color, category, sizeText] = parts.map((part) => part.trim());
  if (!itemNo) return null;
  const size = Number(sizeText);
  if (!Number.isFinite(size) || size <= 0) return null;
  return { itemNo, color, category, size };
};

const STATES = ['门盒', '样品', '仓库'];

const emptyColorEntry = ({ productRecordId, sizeRecordId, color }) => ({
  color,
  productRecordId,
  sizeRecordId,
  // 一条实时库存记录 = 一双鞋。这里保存 record_id，补样品时要按它精确操作。
  records: { 门盒: [], 样品: [], 仓库: [] },
});

// 关联单元格的形状有**两种**，必须都认：
//   · 飞书原始 API：[{ record_ids: ['rec...'], table_id: '...', text: '...' }]
//   · 简写/CLI 导出：[{ id: 'rec...' }] 或 'rec...'
// 复用网关里的 linkedRecordIds（它已经处理了这几种），不要自己写一份——
// 少认一种形状的后果是"整表记录被静默跳过"，线上表现为每一单都说没货。
const linkedId = (cell) => linkedRecordIds(cell)[0] || '';

const countsOf = (entry) => ({
  doorBox: entry.records['门盒'].length,
  sample: entry.records['样品'].length,
  warehouse: entry.records['仓库'].length,
});

class LiveInventoryIndex {
  constructor({ records = [], stateField = '所属状态', productField = '编号', sizeField = '尺码', stockKeyField = '库存键' } = {}) {
    this.skippedRecords = 0;
    this.byItemNo = new Map();
    for (const record of records) {
      const key = parseStockKey(record?.fields?.[stockKeyField]);
      if (!key) {
        this.skippedRecords += 1;
        continue;
      }
      const state = textValue(record?.fields?.[stateField]);
      if (!STATES.includes(state)) {
        this.skippedRecords += 1;
        continue;
      }
      const productRecordId = linkedId(record?.fields?.[productField]);
      const sizeRecordId = linkedId(record?.fields?.[sizeField]);
      if (!productRecordId || !sizeRecordId) {
        this.skippedRecords += 1;
        continue;
      }
      if (!this.byItemNo.has(key.itemNo)) this.byItemNo.set(key.itemNo, new Map());
      const bySize = this.byItemNo.get(key.itemNo);
      if (!bySize.has(key.size)) bySize.set(key.size, new Map());
      const byColor = bySize.get(key.size);
      if (!byColor.has(key.color)) {
        byColor.set(key.color, emptyColorEntry({ productRecordId, sizeRecordId, color: key.color }));
      }
      byColor.get(key.color).records[state].push(record.record_id);
    }
  }

  /**
   * 补样品候选：**同一个货品记录**（= 货号 + 颜色）下，门盒还有余量的尺码。
   *
   * 这一块存在的理由：卖掉的如果是样品，就得从门盒里转一双回去补样品。
   * 补偿必须在**同一个货品记录**内完成（换颜色就是换了一款鞋），
   * 而且只能用门盒——仓库鞋需另行调拨，不参与补样品。
   */
  sampleReplacementCandidatesForProduct(productRecordId, { excludeRecordIds = [] } = {}) {
    const wanted = String(productRecordId || '');
    if (!wanted) return [];
    const excluded = new Set(excludeRecordIds);
    const rows = [];
    for (const bySize of this.byItemNo.values()) {
      for (const [size, byColor] of bySize.entries()) {
        for (const entry of byColor.values()) {
          if (entry.productRecordId !== wanted) continue;
          const keep = (ids) => ids.filter((id) => !excluded.has(id)).length;
          rows.push({
            size,
            doorBoxCount: keep(entry.records['门盒']),
            sampleCount: keep(entry.records['样品']),
            warehouseCount: keep(entry.records['仓库']),
          });
        }
      }
    }
    return rows.sort((left, right) => left.size - right.size);
  }

  /**
   * 某个货号在店里有哪些尺码，每个尺码有几双（用于"没货"时告诉她有什么）。
   */
  sizesOf(itemNo) {
    const bySize = this.byItemNo.get(String(itemNo || '').trim());
    if (!bySize) return [];
    return [...bySize.entries()]
      .map(([size, byColor]) => {
        const total = [...byColor.values()].reduce((sum, entry) => {
          const counts = countsOf(entry);
          return sum + counts.doorBox + counts.sample + counts.warehouse;
        }, 0);
        return { size, total };
      })
      .filter((item) => item.total > 0)
      .sort((left, right) => left.size - right.size);
  }

  /**
   * 某个货号 + 尺码在店里的实物分布，按颜色分组。
   * 颜色不唯一时交给确认卡片让用户选；颜色从库存读，不是从货品资料读。
   */
  find({ itemNo, size } = {}) {
    const wantedItemNo = String(itemNo || '').trim();
    const wantedSize = Number(size);
    const bySize = this.byItemNo.get(wantedItemNo);
    if (!bySize || !Number.isFinite(wantedSize)) {
      return { itemNo: wantedItemNo, size: wantedSize, colors: [], otherSizes: this.sizesOf(wantedItemNo) };
    }
    const byColor = bySize.get(wantedSize);
    const colors = byColor
      ? [...byColor.values()].map((entry) => ({ ...entry, ...countsOf(entry) }))
      : [];
    return {
      itemNo: wantedItemNo,
      size: wantedSize,
      colors,
      // 同货号其他有货的尺码：没货时告诉她"这个货号现在有 36、38 码"，比只说"没找到"有用。
      otherSizes: this.sizesOf(wantedItemNo).filter((item) => item.size !== wantedSize),
    };
  }

  /**
   * 补样品的候选：同货号、门盒还有余量的尺码（可按尺码从小到大）。
   * 卖掉的样品要由某个门盒补回来，仓库鞋不参与（需另行调拨）。
   */
  sampleReplacementCandidates(itemNo, { excludeRecordIds = [] } = {}) {
    const excluded = new Set(excludeRecordIds);
    const bySize = this.byItemNo.get(String(itemNo || '').trim());
    if (!bySize) return [];
    const rows = [];
    for (const [size, byColor] of bySize.entries()) {
      let doorBoxCount = 0;
      let sampleCount = 0;
      let warehouseCount = 0;
      for (const entry of byColor.values()) {
        doorBoxCount += entry.records['门盒'].filter((id) => !excluded.has(id)).length;
        sampleCount += entry.records['样品'].filter((id) => !excluded.has(id)).length;
        warehouseCount += entry.records['仓库'].filter((id) => !excluded.has(id)).length;
      }
      if (!doorBoxCount && !sampleCount && !warehouseCount) continue;
      rows.push({ size, doorBoxCount, sampleCount, warehouseCount });
    }
    return rows.sort((left, right) => left.size - right.size);
  }
}

const buildLiveInventoryIndex = ({ records, table } = {}) => new LiveInventoryIndex({
  records,
  stateField: table?.fields?.state || '所属状态',
  productField: table?.fields?.product || '编号',
  sizeField: table?.fields?.size || '尺码',
  stockKeyField: table?.fields?.stockKey || '库存键',
});

module.exports = { LiveInventoryIndex, buildLiveInventoryIndex, parseStockKey };
