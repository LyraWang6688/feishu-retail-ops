/**
 * 「话题里的二次处理识别」的**行为配置**（②：预定 / 现货待收的进展同步）。
 *
 * 为什么单独一个配置文件（AGENTS.md《底层工程原则》「配置先行」）：
 *   ② 的全部判据就是"哪些词算进展、哪些词算新原话、多少钱怎么认"——
 *   这些**全是业务口径**，换一个词不该改一行 service 逻辑。
 *   所以判据、正则、文案都放在这里；`services/salesThreadProgressService.js` 里
 *   一个关键词都不写死。
 *
 * ⚠️ 它**只服务于群话题里"已定位到某笔销售"之后的二次处理**：
 *   私聊的任务上没有 `chat_type`，走不到这里（私聊行为一个字不变）。
 *
 * ⚠️ 与「第二次交付」(`secondDeliveryService`) 的关系：
 *   那条链路是**卡片按钮**触发的（点「成交」）；本配置服务的是**她直接说话**触发的
 *   同一件事（"收到微信 500"）。两者写的都是同一套底层能力
 *   （PaymentService / SalesDeliveryService），不各写一套收钱/交货。
 */

const DEFAULTS = Object.freeze({
  // 开关。⚠️ 显式布尔（空串 = 没配 = 用默认），不用 `|| fallback`（那会让"清空变量"关不掉）。
  enabled: true,

  // ── 进展信号 ─────────────────────────────────────────────────────────────
  // 命中任一类 → "这条像是在同步那笔的进展"。两类都命中 = 分不清是钱还是货 → 问她。
  progressCues: Object.freeze({
    // 钱：她收到 / 付了 / 转了
    payment: Object.freeze([
      '收到', '收了', '收款', '到账', '付了', '付款', '转来', '转了', '打了',
      '结清', '付清', '补了', '补款', '给钱', '给了钱',
    ]),
    // 货：她拿走了 / 我们交了
    delivery: Object.freeze([
      '拿走', '提走', '取走', '拿货', '交付', '发货', '来拿了', '已经给了',
    ]),
    // ⭐ 整单完成：她直接回「已完毕 / 成交」——**等于点那张「成交」按钮**，
    //    同时把「未履约→履约」与「待收→已收（+ 收款时间）」做完。
    //    （业务负责人的原话：「然后在话题里回复，已完毕或者成交之类的话」；
    //      期望见 docs/e2e-sales-status-method.md。）
    //    ⚠️ 只在**没有**更具体的收款 / 交付线索时才成立：「好了，收到微信 500」
    //       仍按收款处理（"好了"只是口头语），不降级成整单完成。
    //    ⚠️ 「已完毕」必须排在「完毕」前面：firstCue 取数组顺序里**第一个**命中的。
    complete: Object.freeze([
      '已完毕', '完毕', '成交', '搞定', '好了', '完成',
    ]),
  }),

  // ── 新原话信号 ───────────────────────────────────────────────────────────
  // 命中即"这条又像是在描述一笔新销售"（卖什么、多少码、一双…）。
  // 与进展信号同时命中 → **不猜**，回一句问她（见 replies.ambiguous）。
  // ⚠️ 刻意**不写**裸的「双」「码」：她完全可能说「那双 1366-33 拿走了」——
  //    那是**交付进展**，不是新原话。裸字太容易把正常的进展句误判成"两条都在说"。
  //    只收"一定是在录一笔新销售"的说法。
  newSaleCues: Object.freeze([
    '卖', '买', '一双', '两双', '现货', '货号', '库存', '欠',
  ]),

  // ── 金额 ─────────────────────────────────────────────────────────────────
  // 先按这些正则把"不是钱"的数字**遮掉**（货号、尺码、批次号），再取剩下的数字当金额。
  // 遮罩的顺序就是数组顺序。
  ignoreNumberPatterns: Object.freeze([
    '[A-Za-z]{2,}-[0-9-]{2,}',   // BH-20261005-0009 这类单据号
    '[0-9]+-[0-9]+',             // 1366-33 这类"货号-颜色/款号"
    '[0-9]+\\s*(?:码|号)',        // 42码 / 42号
    '[0-9]{4,}\\s*(?:款|型)',     // 6603款
  ]),
  // 遮罩之后用这个正则找金额。刻意**不做**"最后一个数字"这种猜测：
  // 剩下一个才认，剩多个 = 说不清 → 问她。
  amountPattern: '[0-9]+(?:\\.[0-9]{1,2})?',

  // ── 支付方式 ─────────────────────────────────────────────────────────────
  // 她嘴里的说法（按数组顺序取第一个命中的）→ 交给 V1ReferenceResolver.resolvePaymentMethod
  // 去「收款方式管理」里核实。这里**不写死**record_id，也不自己造一个方式。
  paymentMethodAliases: Object.freeze([
    ['微信', '微信'],
    ['支付宝', '支付宝'],
    ['现金', '现金'],
    ['刷卡', '刷卡'],
    ['银行卡', '银行卡'],
    ['转账', '转账'],
  ]),

  // ── 文案（用户可见文案一律可配，改文案不碰逻辑）─────────────────────────────
  replies: Object.freeze({
    // 判断不了时**宁可问一句，也不猜**（业务负责人明确的口径）。
    ambiguous: '这是在说这笔的收款进展吗？如果是，把「收了多少、什么方式」说一遍（例：收到微信 500）。',
    needAmount: '收到多少？说个数我再记（例：收到微信 500）。',
    needMethod: '这笔钱是怎么收的？微信还是现金？',
    // 这一笔还没入账：先入账再记进展，否则钱会记两遍。
    notPosted: '这一笔还没入账，先把上面那张确认卡片点一下，我再记这笔进展。',
    paymentDone: '好，记上了：{method} 收 {amount}。',
    deliveryDone: '好，还没交的 {count} 双记成已交付了。',
    completeDone: '好，这一单成交了：{summary}。',
    completeAlready: '这一单已经是成交状态了，我没有重复写。',
    nothingPending: '这一笔的收款和交付都已经齐了，我没有重复写。',
    failed: '这次进展我没记上：{reason}',
    // ⭐ 「已完毕 / 成交」但**问不出收款方式**时的回话（业务负责人 2026-10-06 拍板，见 AGENTS.md 第 16 条）：
    //    货那一半**已经做掉**了，所以这句话必须如实写"记成已交付了" —— 不能让她以为啥也没干；
    //    钱那一半按她的口径（"用户会主动说方式"）回问一句，**不替她挑、也不设默认方式**。
    //    ⚠️ 与上面 needMethod 的分工：needMethod 是"什么都没做、只回问一句"的通用问法；
    //       这一条是"货已经做了、只差钱"的问法。
    completeAskMethod: '好，还没交的 {count} 双记成已交付了。'
      + '这笔钱是怎么收的？说一句（例：收到微信 500）我再记账。',
  }),
});

/**
 * 本地任务记录上的状态（⚠️ 只写 `data/lark_mvp_tasks`，**一个字都不写业务表**）。
 *
 * 为什么单独抽出来：业务负责人 2026-10-06 明确要求 **状态如实** ——
 * 「什么都没写就不要记 `progress_applied`」（那会"看起来成功了，其实什么都没做"）。
 * 状态名是排查口径，放配置里：改名字不用动 service 逻辑。
 */
const PROGRESS_TASK_STATUS = Object.freeze({
  // 进展**真的落库了**（收了一笔钱 / 记了交付 / 成交了）。
  APPLIED: 'progress_applied',
  // 只**回问了一句**、业务表一个字没写 —— 用它，别用 APPLIED 假装成功。
  ASKING: 'progress_asking',
  // 判不清（像进展又像新原话），同样只回问一句。
  ASKED_UNKNOWN: 'ignored',
  // 尝试写入但失败了（原因写在 progress_reason）。
  FAILED: 'progress_failed',
});

// 「显式布尔」解析：空串 = 没配 = 用默认。见 AGENTS.md 里"开关必须是显式布尔"那条。
const parseExplicitBoolean = (raw, fallback, label = 'SALES_PROGRESS_INTAKE_ENABLED') => {
  if (raw === undefined || raw === null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (value === '') return fallback;
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  throw new Error(`${label} 必须是 true/false，收到：${raw}`);
};

/**
 * 组装本次运行的配置。`options` 可覆盖任意一项（测试用；生产走环境变量）。
 * 环境变量在**每次调用时**读，不在模块加载时求值（避免 dotenv 顺序问题）。
 */
const resolveSalesProgressIntakeConfig = (options = {}) => {
  const env = options.env || process.env;
  const replies = { ...DEFAULTS.replies, ...(options.replies || {}) };
  return {
    enabled: options.enabled ?? parseExplicitBoolean(env.SALES_PROGRESS_INTAKE_ENABLED, DEFAULTS.enabled),
    // 词表现读：测试可以覆盖成更短的词表，把判据本身测干净。
    progressCues: {
      payment: options.progressCues?.payment || DEFAULTS.progressCues.payment,
      delivery: options.progressCues?.delivery || DEFAULTS.progressCues.delivery,
      complete: options.progressCues?.complete || DEFAULTS.progressCues.complete,
    },
    newSaleCues: options.newSaleCues || DEFAULTS.newSaleCues,
    ignoreNumberPatterns: options.ignoreNumberPatterns || DEFAULTS.ignoreNumberPatterns,
    amountPattern: options.amountPattern || DEFAULTS.amountPattern,
    paymentMethodAliases: options.paymentMethodAliases || DEFAULTS.paymentMethodAliases,
    replies,
  };
};

// 判据的三种结果（配置里的"取值"，与逻辑里的分支一一对应）。
const PROGRESS_KINDS = Object.freeze({
  PAYMENT: 'payment',
  DELIVERY: 'delivery',
  COMPLETE: 'complete',
  AMBIGUOUS: 'ambiguous',
  NONE: 'none',
});

module.exports = {
  SALES_PROGRESS_INTAKE_DEFAULTS: DEFAULTS,
  PROGRESS_KINDS,
  PROGRESS_TASK_STATUS,
  resolveSalesProgressIntakeConfig,
  parseExplicitBoolean,
};
