const { MODULES: SHARED_MODULES } = require('./modules.shared');

const MODULES = {
  purchase: {
    ...SHARED_MODULES.purchase,
    recognition: {
      ...SHARED_MODULES.purchase.recognition,
      // 「到货单」识别：供应商直接给一张出库单/送货单的表格照片。
      //
      // 提示词放在配置里而不是 service 里：不同供应商的单据格式会变，
      // 换格式只改这一段文案，不用动代码、不用重新走一遍代码评审。
      document: {
        label: '供应商到货单',
        prompt: `
你是鞋店采购助理。请识别图片中的**供应商到货单 / 出库单 / 送货单**（通常是一张表格的照片）。

表格每一行的列大致是：款号 | 颜色 | 尺码矩阵（如 35 36 37 38 39 40） | 数量 | 销售价 | 金额。
- 一个款号+颜色占一行，尺码那一排是表头；
- 行尾的「数量」「金额」是这一行的汇总，**不是**某个尺码的数量，不要当成尺码数量输出。

请把表格**摊平成一条条明细**，只回答「哪个款号、哪个颜色、哪个尺码、几双」：
[
  {"item_no":"1366-31","color":"棕色","size":36,"quantity":1},
  {"item_no":"1366-31","color":"棕色","size":37,"quantity":1}
]

规则：
1. 只输出数量为正整数的尺码；格子里是 0、空白或划掉的尺码不要输出。
2. 同一个款号+颜色+尺码如果在单据上出现多次，分别输出，由后端负责合并。
3. size 输出标准欧码正整数（本业务不使用半码）：
   - 单据上的尺码数值在 225–285 之间（如 240、250）视为毫米制，换算公式：欧码 = (数值 - 50) / 5。示例：240 → 38，250 → 40。
   - 在 34–48 之间（如 38、40）视为欧码，原样输出。
4. color 照抄单据上的颜色文字；单据上没有颜色就返回空字符串 ""，不要猜。
5. item_no 照抄款号，不要把颜色、尺码或数量拼进货号。
6. 看不清或者不确定的行宁可少输出，也不要猜。

请严格以 JSON 数组格式返回结果，不要包含任何解释性文字或 Markdown 代码块标记。`.trim(),
      },
    },
    sync: {
      ...SHARED_MODULES.purchase.sync,
      createFields: [
        { field: 'SKU_Code', source: 'skuCode' },
        { field: '货号', source: 'item_no' },
        { field: '颜色', source: 'color' },
        { field: '尺码', source: 'size', type: 'number' },
        { field: '供应商', source: 'supplier', fallback: '' },
        { field: '品类', source: 'category', fallback: '' },
        { field: '数量', source: 'quantity', type: 'number' },
        { field: '对应图片', source: 'attachment' },
      ],
      updateFields: [
        { field: '数量', source: 'accumulatedQuantity' },
        { field: '对应图片', source: 'attachment', omitWhenEmpty: true },
      ],
      carryForwardFields: [
        { field: '品类', source: 'category', conflictMessage: '品类与已存在记录不一致' },
      ],
    },
  },
  inventory: {
    ...SHARED_MODULES.inventory,
    sync: {
      ...SHARED_MODULES.inventory.sync,
      createFields: [
        { field: 'SKU_Code', source: 'skuCode' },
        { field: '货号', source: 'item_no' },
        { field: '颜色', source: 'color' },
        { field: '尺码', source: 'size', type: 'number' },
        { field: '数量', source: 'quantity', type: 'number' },
        { field: '对应图片', source: 'attachment' },
      ],
      updateFields: [
        { field: '数量', source: 'accumulatedQuantity' },
        { field: '对应图片', source: 'attachment', omitWhenEmpty: true },
      ],
      carryForwardFields: [],
    },
  },
  sales: {
    ...SHARED_MODULES.sales,
    sync: {
      ...SHARED_MODULES.sales.sync,
      createFields: [
        { field: '货号', source: 'item_no' },
        { field: '颜色', source: 'color' },
        { field: '尺码', source: 'size', type: 'number' },
        { field: '数量', source: 'quantity', type: 'number' },
        { field: '金额（元）', source: 'amount', type: 'number', omitWhenEmpty: true },
        { field: '支付方式', source: 'pay_method', omitWhenEmpty: true },
        { field: '备注', source: 'remark', fallback: '' },
        { field: '对应图片', source: 'attachment' },
      ],
      updateFields: [],
      carryForwardFields: [],
    },
  },
};

const normalizeModule = (moduleKey) => {
  const key = String(moduleKey || '').trim().toLowerCase();
  if (!key) return 'purchase';
  if (!MODULES[key]) {
    const supported = Object.keys(MODULES).join(', ');
    throw new Error(`Invalid module: ${key}. Supported: ${supported}`);
  }
  return key;
};

const getModuleDefinition = (moduleKey) => MODULES[normalizeModule(moduleKey)];

module.exports = {
  MODULES,
  normalizeModule,
  getModuleDefinition,
};
