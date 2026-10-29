/**
 * 售后**扫一扫落地页**的配置（只放文案 / 路径 / 动作，不放业务判断）。
 *
 * 页面口径（业务负责人 2026-10-29，逐字）：
 *   「用户扫码后会出现一个售后页面 …… 基于二维码里的信息（里面应该包含货品颜色），
 *     去查找 7 天内满足条件的销售情况，呈现出具体的**销售日、尺码，以及销售主表里的总金额**，
 *     并给到用户几个备选项。用户点击选择后，下面会有 **3 个按钮**，
 *     水平顺序依次是：1 **换货** 2 **退货** 3 **赔货**」
 *
 * ⚠️ 这一版只做**页面**（选销售 + 选动作）；点按钮之后各自的处理逻辑**还没接**
 *    （她：等页面确认没问题再谈触发逻辑）⇒ 按钮只给出"待接入"的如实提示，不做任何写库。
 * ⚠️ 动作枚举的 `value` 必须与后端 `server/src/config/afterSales.js` 的动作枚举逐字一致
 *    （`return` / `exchange` / `compensation`）—— 接写入时直接用，不在这里另造一套。
 */

export const AFTER_SALES_PAGE = {
  title: '售后单',
  back: '← 返回工作台',
  // 只读候选接口（后端 `server/src/routes/workbenchOrderActions.js` 的 scan-candidates）
  scanCandidatesApi: '/api/workbench/sales/after-sales/scan-candidates',
  // 换尺码：按销售扫码页口径取「现货 / 预定 / 特殊码」三组尺码的只读接口（本地预览由 preview 服务提供；
  // 正式后端路由在接写库那一步一起加）。
  stockSizesApi: '/api/workbench/sales/after-sales/stock-sizes',
  sizeGroupInStock: '现货',
  sizeGroupReserve: '预订',
  sizeGroupSpecial: '特殊码',
  sizesLoading: '正在读取尺码…',
  sizesFailed: '尺码读取失败，请返回重试。',
  areaTagInStock: '现货',
  areaTagReserve: '预订',
  days: 7,
  loading: '正在查找近 7 天的销售记录…',
  productLoading: '正在读取货品…',
  productMissing: '没有扫到货品记录，请重新扫码。',
  failed: '销售记录读取失败，请返回重试。',
  empty: '近 7 天没有这款货品的销售记录。',
  // ⭐ 2026-10-29（HTML 批注，逐字）：这句提示现在是「请选择售后单」
  //   （她先改成「请选择要售后单」，随后又批注「去掉要」⇒ 去掉那个「要」字）。
  chooseHint: '请选择售后单',
  // ⭐ 2026-10-29（业务负责人定的交互）：选中哪条记录，就在**那条卡片上**变成三个按钮
  //   （换货 / 退货 / 赔货，**只有这三个词、不做解释**）；这个只用于读屏 group 的 aria-label。
  actionLabel: '售后处理方式',
  // 字段名（页面上一律从这取，不在渲染代码里写死）
  // ⭐ 2026-10-29（HTML 批注）：卡片上**不再显示销售单号** ⇒ `orderLabel` 一起删掉（不留无用配置）。
  //   三个字段名现在只用在候选卡的 `aria-label`（读屏/自动化要能读出"这是销售日 / 尺码 / 总金额"）。
  dateLabel: '销售日',
  sizeLabel: '尺码',
  totalLabel: '总金额',
  amountEmpty: '—',
  sizeEmpty: '—',
  dateEmpty: '—',
  // ⭐ 2026-10-29 第二步（业务负责人：「先把页面做好」）：点按钮之后是**弹窗**（原型）。
  //   ⚠️ 这一版只做前端原型：确认按钮只 toast，不发任何写请求（源码哨兵钉住"没有 api.post"）。
  modalDemoHint: '原型演示：确认后只做提示，不会写库',
  // 退货弹窗
  returnTitle: '退货',
  returnProductLabel: '这双鞋',
  returnAmountLabel: '金额',
  returnModeLabel: '钱怎么走',
  returnRefund: '直接退款',
  returnRetain: '货款留存',
  returnMethodLabel: '退款方式',
  // 换货弹窗
  exchangeTitle: '换货',
  exchangeModeLabel: '怎么换',
  exchangeSameItem: '换尺码',
  exchangeNewItem: '换款式',
  exchangeSizeLabel: '新尺码',
  exchangeNewItemHint: '扫一扫选新鞋（原型：点下面的按钮模拟扫到一双新鞋）',
  exchangeScan: '扫一扫选新鞋',
  exchangeScanFailed: '扫一扫没有成功，请再试一次。',
  exchangeNewItemLabel: '新鞋',
  exchangeDiffLabel: '差价',
  exchangeDiffNone: '没有差价',
  exchangeDiffMethodLabel: '差价方式',
  // 弹窗通用
  select: '请选择',
  cancel: '取消',
  confirm: '确认',
  // ⭐ 退货提交成功 / 换货提交成功 的两句话（业务负责人逐字）
  toastReturnDone: '数据提交成功',
  toastExchangeDone: '信息提交成功',
  // 赔货：只占位（按钮灰置不可点）
  compensationDisabled: '赔货暂未开放',
  // 原型用的兜底：换尺码下拉（真实接接口后由库存尺码接口给）
  demoSizes: [36, 37, 38, 39, 40, 41, 42, 43, 44],
  // 原型用的兜底：退款方式 / 差价方式（真实运行读「支付方式管理」统一配置）
  demoPaymentMethods: ['微信扫码', '微信转账', '现金', '支付宝', '工商银行'],
  // 原型用的兜底：换款式模拟扫到的新鞋（真实运行走销售扫码货品页）
  demoNewItem: { itemNo: 'XHB8096', color: '全黑', price: 190 },
};

/**
 * 售后动作 —— 顺序就是她定的**水平顺序**：换货 · 退货 · 赔货。
 * ⭐ 2026-10-29：按钮上**只有这三个词**（她：「那三个按钮就是单纯的换货、退货和赔货，你不用做解释」）
 *   ⇒ 原先那行解释小字（hint）已删掉，不留在配置里。
 */
export const AFTER_SALES_ACTIONS = [
  { value: 'exchange', label: '换货' },
  { value: 'return', label: '退货' },
  // 赔货：只做展示占位 —— 灰置、不可点（业务负责人 2026-10-29：「先不开发任何功能」）。
  { value: 'compensation', label: '赔货', disabled: true },
];
