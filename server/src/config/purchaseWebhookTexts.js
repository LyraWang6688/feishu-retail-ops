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

module.exports = { purchaseMessage, purchaseToast, arrivalToast, inventoryToast };
