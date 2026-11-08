'use strict';

/**
 * 售后（衍生单模型）· **退货** 写入配置（2026-10-29 业务负责人定稿，2026-11-08 落库接线）。
 *
 * 口径（逐字要点）：
 *   · 售后是**衍生单**：不新建销售主表/售后单，只在**原销售主表**上丰富
 *     （售后类型多选累加 + 售后次数 +1）；
 *   · **货 / 钱分开**：
 *       货：原销售明细「履约状态」→ 已退货；库存流水新增一笔（行为=「销售增加」）；
 *           实时库存 +1，默认落**门盒**（不再让用户选样品/门盒）；
 *       钱：**新建一条 S交易明细**（不改原行）——
 *           直接退款：`{单号}-退款-NN` · 支付方式=她选的 · 收支方向=退回 · 钱款状态=已退款；
 *           货款留存：`{单号}-留存-NN` · 支付方式/收支方向**不填** · 钱款状态=已留存；
 *           两者：交易金额=这双鞋在销售明细里的金额（只读）、收付日=点击当天、关联原销售单；
 *   · 异步：表单 POST → 入队 → 统一 toast（303）→ 后台写库，失败自动重试。
 *
 * 生产表只读核对（2026-10-29，用业务负责人飞书 CLI，只读）：
 *   · 「行为管理」里「销售增加」的行为编码 = `STOCK_SALE_INCREASE`（库存方向=增加）；
 *   · 「销售主表.售后类型」= **多选**，选项：退货 / 换货 / 赔货；
 *   · 「S交易明细.收支方向」选项：收入 / 退回；「钱款状态」选项含 已退款 / 已留存。
 */
const AFTER_SALES_DERIVED_ACTIONS = Object.freeze({
  RETURN: 'return',
  EXCHANGE: 'exchange',
});

const AFTER_SALES_DERIVED = Object.freeze({
  actions: AFTER_SALES_DERIVED_ACTIONS,
  // 退货允许操作的原明细状态：只有「已交付」的才谈得上退回。
  returnableFulfillmentStatuses: Object.freeze(['已交付']),
  detailFulfillment: Object.freeze({ RETURNED: '已退货' }),
  // 货：退回的鞋默认回门盒（业务负责人 2026-10-29：不用再问样品/门盒）。
  defaultRestockState: '门盒',
  // 货流行为编码：生产「行为管理」里她新增的「销售增加」（可用 env 覆盖）。
  stockBehaviorCode: String(process.env.AFTER_SALES_RETURN_BEHAVIOR_CODE || 'STOCK_SALE_INCREASE').trim(),
  // 原销售主表上的"字段丰富"落点。
  master: Object.freeze({
    typeField: 'afterSalesType',
    typeValueByAction: Object.freeze({ return: '退货', exchange: '换货' }),
    countField: 'afterSalesCount',
    countDelta: 1,
  }),
  // 钱：两种都**新建一条 S交易明细**（不改原行）。
  money: Object.freeze({
    modes: Object.freeze({ REFUND: 'refund', RETAINED: 'retained' }),
    kindMarkByMode: Object.freeze({ refund: '退款', retained: '留存' }),
    statusByMode: Object.freeze({ refund: '已退款', retained: '已留存' }),
    // 退款行的收支方向（生产选项只有 收入 / 退回）
    refundDirection: '退回',
    // 留存行：支付方式与收支方向**不填**
    retainedSkipsMethodAndDirection: true,
  }),
  // 异步任务存储目录（本地 JSON 任务记录；与交割单页同一套 JsonTaskStore）。
  jobsDir: process.env.AFTER_SALES_JOBS_DIR || '',
  // ⭐ 2026-11-08（#948）：重试配置**向统一层收敛** —— 优先 `ASYNC_JOB_*`，旧 `AFTER_SALES_JOB_*`
  //   仍生效（不破坏线上已有 env）；两边都没配 = 3 次 / 800ms（与统一层缺省一致）。
  job: Object.freeze({
    retryAttempts: Number(process.env.AFTER_SALES_JOB_MAX_ATTEMPTS
      || process.env.ASYNC_JOB_MAX_ATTEMPTS || 3),
    retryBaseMs: Number(process.env.AFTER_SALES_JOB_RETRY_MS
      || process.env.ASYNC_JOB_RETRY_BASE_MS || 800),
  }),
  // 人话（配置先行；路由/服务不写死中文）
  texts: Object.freeze({
    needRequestId: '缺少请求标识（request_id）',
    needEntry: '缺少销售单记录',
    needDetail: '请选择要退的那一条销售明细',
    needMoneyMode: '请选择钱怎么走（直接退款 / 货款留存）',
    invalidMoneyMode: '钱怎么走只能是 refund（直接退款）或 retained（货款留存）',
    needPaymentMethod: '直接退款时要选退款方式',
    unknownPaymentMethod: '支付方式管理里找不到这个方式',
    methodNotRefundable: '这个支付方式不能用于退款（「支付方式管理」里没勾「可用于退款」）',
    entryNotFound: '找不到这张销售单',
    detailNotFound: '找不到这条销售明细',
    detailNotInEntry: '这条销售明细不属于这张销售单',
    detailNotReturnable: '这条明细当前状态不能退货（只有「已交付」可以退）',
    alreadyReturned: '这条明细已经退过货了',
    amountMissing: '这一单还没补「实收金额」，先去工作台把它补上，再做退货',
    amountInvalid: '这双鞋的金额无效，无法退款',
    missingProduct: '这条明细没有关联货品',
    missingSize: '这条明细没有关联尺码',
    sizeUnreadable: '这条明细的尺码读不到',
    submitFailed: '售后提交失败，请稍后重试',
  }),
});

module.exports = { AFTER_SALES_DERIVED_ACTIONS, AFTER_SALES_DERIVED };
