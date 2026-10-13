/**
 * 用户可见文案：**供应商报单 / 采购申请 / 入库确认**（群消息 · 卡片 · 页面 toast）。
 * ⚠️ 只放常量与填参拼装，零逻辑；文案**逐字**从 `purchaseWebhookService.js` 搬来（原始字面量整段照搬）。
 * ⚠️ `inventoryToast.m1` / `m2` 是那句**三元二选一**的两条：**各留一个 key**（不参数化）。
 */

const purchaseMessage = {
  // 原行 :1711
  m1: '采购申请已生成',
  // 原行 :1711
  m2: ({ plan, requestIds }) => `报货批次号：${plan.batch_no}；共 ${requestIds.length} 条明细已写入。`,
};

const purchaseToast = {
  // 原行 :1713
  m1: ({ plan, requestIds }) => `采购申请已生成：${plan.batch_no}（共${requestIds.length}条明细）`,
};

const arrivalToast = {
  // 原行 :1764
  m1: '这一批已入库',
};

const inventoryToast = {
  // 原行 :1926
  m1: '采购已入库，库存已更新',
  // 原行 :1926
  m2: '采购入库已确认',
};


/**
 * 采购退货**告知**（群里/卡片上给她看的人话）—— ⚠️ 整段表达式**原样照搬**，`+` 拼接结构保持不动。
 * 参数只取 `${}` 的**根标识符**（`sizeText` 是服务里的局部函数 ⇒ 当参数传进来）。
 */
const returnNotice = {
  unknownItem: '这个货品',
  sizeText: ({ size }) => `（${size} 码）`,
  zeroTaken: ({ label, sizeNames }) => `采购退货没处理：${label}${sizeNames ? `（${sizeNames}）` : ''}在实时库存里一双都没有，` +
      '我没有扣库存，也没有把这条记录标成已处理。库存补上之后再提交一条退货记录就好～',
  shortfallLine: ({ entry, label, sizeText }) => `${label}${sizeText(entry.size)} 你说要退 ${entry.declared} 双，实时库存里只有 ${entry.available} 双 —— ` +
      `我先按能对上的 ${entry.taken} 双处理了，差的 ${entry.shortfall} 双对不上。` +
      '要我一起退的话，把数量改成能对上的数再提交一条～',
  surplusLine: ({ entry, label, sizeText }) => `⚠️ ${label}${sizeText(entry.size)} 在实时库存里还剩 ${entry.surplus} 双没退（总数是 ${entry.available} 双）——` +
      '要一起退就把数量改成总数再提交一条～',
};

module.exports = { returnNotice, purchaseMessage, purchaseToast, arrivalToast, inventoryToast };
