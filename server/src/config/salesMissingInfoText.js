// 销售「销售信息还缺…」追问的**文案配置**（配置先行）。
//
// 背景（业务负责人 2026-10-07 18:38 真机，逐字）：
//   她的输入是一条消息两笔（119 元微信 / 31678 40码 / 定制 6681-1 42码定金 50 下次付 39），
//   收到的回复是：
//     「销售信息还缺：定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额、
//       items[0].actual_amount、items[1].actual_amount、payments[0].method、请逐件说明成交金额、
//       已收金额和待平台结算金额不能超过本单成交金额。请补充后重新发送完整销售信息。」
//   她只回了一句：「**这个提醒是什么意思？**」
//
// 三个问题（本文件专治后两个；第一个是渲染层的形状，见 `renderSalesMissingInfo`）：
//   ① 🔴 **内部技术字段名漏给用户看**（`items[0].actual_amount` / `payments[0].method`）；
//   ② 🔴 4~5 句不相干的话**堆成一段**（「、」「；」串起来），读不出"到底该做什么"；
//   ③ 🔴 结尾「请补充后重新发送完整销售信息」**没有具体动作**。
//
// ⚠️ 本文件**只管文案**。判据（什么情况下报缺项 / 不出卡片 / 不入账）**一个字都不在这里** ——
//    它在 `services/doubaoService` 的 `normalizeSalesResult`（解析层）
//    与 `services/larkMvpService.processSalesTask`（接线层），**本次一行未改**：
//    `draft.missing_fields` 仍然是改动前那串**机器清单**（`items[0].actual_amount` 还在里面），
//    它照旧写进 `解析结果摘要`（JSON）与本地任务 —— 改的只是**给她看的那一层**。
//
// ⭐ 为什么在渲染层做、而不是去改 `missing_fields` 的产生点：
//    `missing_fields` 是**机器契约**（既有用例逐字钉着它、`failureReason` 也用它），
//    改它等于动判据。渲染层只做「机器清单 → 人话」的翻译，判据与契约都不动。
//
// ⭐ 结构（她的话：**一次只说一件事**）：每条缺项 = **一行**，同类合并（见 `GENERIC_TOPICS`），
//    行内**不许**用「；」把几句串起来（`；` 只出现在生产者原话里，凡是有 `；` 的那几条
//    都在下面**逐条给了模板**，所以渲染结果里不会再有 `；` —— 有守门用例）。
//
// ⭐ 取值规则走 `config/envValue`（与 `salesColorChoice` / `salesProductRegistration` 同一套）：
//    · 变量**没设** → 默认值；
//    · 变量**设了** → 用设的值；**设成空串 / 只有空白 → 回落到默认值**
//      （理由与 `salesColorChoice.stockLookupFailedText` 完全相同：这是她那一刻**唯一能看到的解释**，
//       留空 = 她只看到"缺了几处"却说不出缺什么）。
// ⚠️ **调用时才解析**（`resolveSalesMissingInfoConfig(process.env)`），不在模块加载时求值
//    —— 2026-10-06 的 dotenv 加载顺序事故就是这么来的。

const { readRaw, readString } = require('./envValue');

const PREFIX = 'SALES_MISSING_INFO_';

// 环境变量键（一个文案一个键；`.env.example` 里给了默认值说明，不配也能跑）。
const KEYS = Object.freeze({
  intro: `${PREFIX}INTRO_TEXT`,
  itemAmount: `${PREFIX}ITEM_AMOUNT_TEXT`,
  itemAmountGeneric: `${PREFIX}ITEM_AMOUNT_GENERIC_TEXT`,
  itemFieldItemNo: `${PREFIX}ITEM_NO_TEXT`,
  itemFieldSize: `${PREFIX}ITEM_SIZE_TEXT`,
  itemFieldQuantity: `${PREFIX}ITEM_QUANTITY_TEXT`,
  itemFieldAccessoryName: `${PREFIX}ACCESSORY_NAME_TEXT`,
  itemFieldFallback: `${PREFIX}ITEM_FIELD_FALLBACK_TEXT`,
  paymentMethod: `${PREFIX}PAYMENT_METHOD_TEXT`,
  paymentAmount: `${PREFIX}PAYMENT_AMOUNT_TEXT`,
  depositMultiLine: `${PREFIX}DEPOSIT_MULTI_LINE_TEXT`,
  depositMultiLineExample: `${PREFIX}DEPOSIT_MULTI_LINE_EXAMPLE_TEXT`,
  depositTargetAmbiguous: `${PREFIX}DEPOSIT_TARGET_AMBIGUOUS_TEXT`,
  depositTargetAmbiguousGeneric: `${PREFIX}DEPOSIT_TARGET_AMBIGUOUS_GENERIC_TEXT`,
  depositAmount: `${PREFIX}DEPOSIT_AMOUNT_TEXT`,
  depositMethod: `${PREFIX}DEPOSIT_METHOD_TEXT`,
  depositTailUnclear: `${PREFIX}DEPOSIT_TAIL_TEXT`,
  depositPriceMismatch: `${PREFIX}DEPOSIT_PRICE_MISMATCH_TEXT`,
  itemQuantityMultiLine: `${PREFIX}ITEM_QUANTITY_MULTI_LINE_TEXT`,
  itemsTotalMismatch: `${PREFIX}ITEMS_TOTAL_MISMATCH_TEXT`,
  receivedExceedsTotal: `${PREFIX}RECEIVED_EXCEEDS_TOTAL_TEXT`,
  voucherOneOrderOnePair: `${PREFIX}VOUCHER_ONE_ORDER_ONE_PAIR_TEXT`,
  unsupportedIntent: `${PREFIX}UNSUPPORTED_INTENT_TEXT`,
  itemLabelWithSize: `${PREFIX}ITEM_LABEL_WITH_SIZE_TEXT`,
  itemLabelSizeOnly: `${PREFIX}ITEM_LABEL_SIZE_ONLY_TEXT`,
  itemLabelFallback: `${PREFIX}ITEM_LABEL_FALLBACK_TEXT`,
  linePrefix: `${PREFIX}LINE_PREFIX_TEXT`,
});

// 占位符（**只有这几个**；未知占位符原样留着，方便一眼看出模板写错了）。
const PLACEHOLDERS = Object.freeze({
  count: '缺了几件事（= 渲染后的行数）',
  index: '第几行（从 1 开始）',
  item: '**一件货**的说法，如 `31678 40码` / `腰带`；取不到就说"第 N 双"',
  items: '**多件货**的说法，用 `、` 连接',
  size: '尺码（只到"码"字之前的数字）',
  itemNo: '货号',
  accessoryName: '配品名称',
  firstItem: '第一件货的说法（定金分开发送的例子用）',
  secondItem: '第二件货的说法（定金分开发送的例子用）',
  quantity: '这一条里写的双数',
  received: '已收金额（有可能用不上；留着给将来）',
});

const DEFAULTS = Object.freeze({
  // 开头一句。⚠️ 保留「销售信息还缺」这几个字（她认得出这是哪件事；既有用例也钉着它）。
  // `{count}` = 下面**行数**（不是 `missing_fields` 的条数 —— 同类会被合并）。
  intro: '销售信息还缺 {count} 处，请照着补一下～',

  // 「这双没说成交金额」。她那条里 `items[0].actual_amount` / `items[1].actual_amount`
  // 与泛化的「请逐件说明成交金额」本来就是**同一件事**（每双各说一个金额）→ 合成这一行。
  itemAmount: '请给每双鞋都说一个成交金额：{items}',
  // 只有泛化那句、没有具体到某一件时用（正常场景走不到；留着兜底，不留空）。
  itemAmountGeneric: '请给每双鞋都说一个成交金额～',

  // 单件还缺某个字段（`items[i].<字段>`）。只说这一件、只说这一件事。
  itemFieldItemNo: '{item} 没说货号，请补一下货号～',
  itemFieldSize: '{item} 没说尺码，请补一下是多少码～',
  itemFieldQuantity: '{item} 没说几双，请补一下数量～',
  itemFieldAccessoryName: '有一件配品没说是什么，请补一下它的名字～',
  itemFieldFallback: '{item} 这条还缺一项信息，请核对后补一下～',

  // 「收的那笔钱没说方式」——业务负责人口径（AGENTS.md 第 16 条）：收款方式**她会主动说**，
  // 系统不猜、也不设默认；所以这里只是**问一句**，绝不写成"默认微信"。
  paymentMethod: '收的那笔钱没说收款方式，请补一句是微信、现金还是支付宝～',
  paymentAmount: '没说这单收了多少钱，请补一句收了多少钱～',

  // ⭐ 她那条里的第 1 句。生产者原话是「定金单暂只支持一条明细；多双请分开说明，或逐双给出成交金额」，
  //    两个毛病：①「明细」是内部说法（她说"一双鞋/一件货"）；② 没说**怎么办**。
  //    改后：人话（"一双"）+ **具体动作（分开发送）** + **当场给例子**（两个货号）。
  depositMultiLineExample: '带定金的单一次只能记一双，请把这两双分开发送～\n'
    + '（例如第一条只说「{firstItem}」，第二条只说「{secondItem}」的定金）',
  // 不是正好两件时的退路（只说动作，不给只有两件才成立的例子）。
  depositMultiLine: '带定金的单一次只能记一双，请把这几双分开发送～',
  depositAmount: '请说一句这次收了多少定金～',
  depositMethod: '请说一句这次定金是怎么收的（微信还是现金）～',
  // ⭐⭐ **上游已变（PR #234 合入，2026-10-07）**：`doubaoService` 现在会在
  //    「多明细 + 定金、但说不清定金属于哪一件」时产出**这一句新的**（定义在
  //    `config/salesTradeTypePolicy.SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS`，逐字）：
  //      「这一单里哪一件是付了定金的那件，我有点拿不准，请逐件说明哪双是预付、每双多少钱～」
  //    ⚠️ 它**不含**代码标识符、也不含「；」/「明细」，所以"原样透传"**不会**被守卫拦住 ——
  //       但那样就等于**没有映射**：不可配，也点不出到底是哪两双（逐双列出来才是她的读法）。
  //    所以这里给它一条模板，保留原话的两个要点（哪一件付了定金 + 每双多少钱），并把"哪几双"当场点出来。
  //    ⚠️ 措辞**只说钱的事** —— 类型是查完实时库存才有的结论（现货 / 预定），
  //      不该反过来问她"哪双是预付"（2026-10-07 口径大改）。
  //    ⚠️ 识别用的是**生产者原话的字头**（见 `TEXT_TOPIC_PATTERNS`），有守门用例钉住这个耦合。
  depositTargetAmbiguous:
    '这一单里哪一件是付了定金的那件，我有点拿不准～请对着「{items}」逐件说清楚哪一件付了定金、每双多少钱～',
  // 一件货都取不出来时的退路（`depositTargetIndex` 在 items 为空时也会走到"说不清"那一支）。
  depositTargetAmbiguousGeneric:
    '这一单里哪一件是付了定金的那件，我有点拿不准～请逐件说清楚哪一件付了定金、每双多少钱～',
  // 生产者原话带「；」。人话 + 具体动作：**把"该写哪一句"直接告诉她**。
  depositTailUnclear: '尾款还没付就请补一句「尾款以后付」，已经付了就补一句实收金额～',
  depositPriceMismatch: '成交价和「定金 + 尾款」对不上，请核对一下～',

  // 生产者原话：「第N件请逐双列出成交金额；每条销售明细只能记录一双」
  //（一条里写了 N 双）。动作 = **每一双各发一条**。
  itemQuantityMultiLine: '一双鞋只能记一条，请把这 {quantity} 双分开发送～（每双各发一条，写清货号、尺码和成交金额）',

  // 「总额 vs 各件之和」。⚠️ 解析层那条**带具体数字**的文案（#231 加的
  //    「你说的总额 210 与各件金额之和 200 对不上，请确认每件多少钱～」）**原样透传**；
  //    这一条只用于接线层那句**没有数字**的泛化版。
  itemsTotalMismatch: '每双鞋的成交金额加起来，和整单成交金额对不上，请核对一下～',
  receivedExceedsTotal: '已收的钱比这单成交金额还多，请核对一下收了多少～',

  // 团购券那条（生产者原话带「；」）：一次一双 + 分批。
  voucherOneOrderOnePair: '团购券一次只能用在一双鞋上，请分开发送并逐双说明券后成交金额～',

  // 非销售意图（她发的是查记录 / 退货之类时解析层会给这句）。给一句"该去哪儿"。
  unsupportedIntent: '这一条只支持商品销售录单，其他类型请先按对应方式发给我～',

  // ── 一件货的**说法**（渲染占位符用；不是句子，但同样是给她看的字，所以也进配置）──
  itemLabelWithSize: '{itemNo} {size}码',
  itemLabelSizeOnly: '{size}码',
  itemLabelFallback: '第 {index} 双',

  // 行首编号。改它 = 改"分行"的样式（例如换成 `· `）。
  linePrefix: '{index}. ',
});

// ⭐ 「泛化句」被「具体句」取代的表：同一件事**只留一条**（她抱怨的"堆成一段"就包括这种重复）。
//   · `请逐件说明成交金额`（接线层，不知道是哪一件）→ 被 `items[i].actual_amount` 取代
//     （知道是哪几双，还能把两个货号报出来）；
//   · `逐件成交金额合计与整单成交金额不一致`（接线层，没有数字）→ 被解析层那句**带数字**的取代
//     （#231 加的，**保留**）。
// ⚠️ 只影响"给她看的那一层"：`missing_fields` 里两条**都还在**（判据没动）。
const GENERIC_SUPERSEDED_BY = Object.freeze({
  item_amount_generic: Object.freeze({ kind: 'item_amount' }),
  items_total_mismatch_generic: Object.freeze({ kind: 'text', key: 'items_total_mismatch_specific' }),
});

// 带「；」的生产者原话 → 认出来走模板（否则「；」会漏进她的文案里）。
// ⚠️ 这是**按生产者原话的字头**识别的：生产者哪天改了字，这里会退化成"原样透传"
//    （**不会崩、也不会漏信息**，只是文案回到改动前的样子）—— 守门用例会盯着这一点。
const TEXT_TOPIC_PATTERNS = Object.freeze([
  // 解析层（services/doubaoService.normalizeSalesResult / depositTerms / groupBuyVoucherPolicy）
  { key: 'deposit_amount', pattern: /^请明确已经收到的定金金额/ },
  { key: 'deposit_method', pattern: /^请明确本次定金的支付方式/ },
  { key: 'deposit_tail', pattern: /^请说明尾款是否已支付/ },
  { key: 'deposit_price_mismatch', pattern: /^成交价与定金加尾款不一致/ },
  // ⭐⭐ **上游已删除（PR #234，2026-10-07）：这条句子的生产者已经没了，映射刻意保留。**
  //    #234 删除了 `doubaoService` 里那句整单护栏（原 `:281-284`）：
  //      `if (deposit.tailAmount && items.length !== 1) { deposit.issues.push('定金单暂只支持…') }`
  //    ⇒「多明细 + 定金」现在是**合法输入**，**这句话再也不会被生产出来**。
  //    ⭐ 保留（而不是删掉）的**理由**：`missing_fields` 会被**落盘持久化** ——
  //       ① 本地任务 `server/data/lark_mvp_tasks/*.json` 的 `draft.missing_fields`；
  //       ② 业务表「解析结果摘要」(`parseSummary`) 那份 JSON 快照。
  //       部署之后，一条**改动前就存着的** `needs_info` 任务若被**重放**
  //       （`resumePending` / 手工重跑），渲染器还会读到这句**历史原文**；
  //       删了映射 ⇒ 它退化成"原样透传" ⇒ 她**又会看到「明细」和「；」**（本次专治的两个毛病）。
  //    ⇒ 所以这条是**历史形状兜底**：只防历史任务重放，**当前链路永远不会走到它**。
  //      成本为零、收益是"老任务重放也不退化"，所以选择保留。
  //    ⚠️ 「上游已删除，仅防历史任务重放」—— 这句话是本条存在的**唯一**理由，改动它请先读
  //       `docs/sales-missing-info-wording-2026-10-07.md` 第 14 节（AC-S3）。
  //    ⚠️ `KNOWN_MISSING_FIELD_SHAPES` 之外它被单列进 `HISTORICAL_MISSING_FIELD_SHAPES`，
  //       并有守门用例钉住"**当前解析层不再产出这一句**"（AC-S3）。
  //    ⚠️ 它也是 `server/test/salesMultiLineTradeType.test.js` 的 AC-11 白名单里**唯一带
  //       「上游已删除」标记的那一处残留**（那里按"标记"判定，不是硬编码文件名）。
  { key: 'deposit_multi_line', pattern: /^定金单暂只支持一条明细/ },
  // ⭐ #234 **新增**的那一句（`config/salesTradeTypePolicy.SALES_MULTI_LINE_DEPOSIT_TARGET_AMBIGUOUS`）。
  //    字头按**生产者原话**认：`这一单里哪一件是付了定金的那件…`（注意是"件"，不是"双"）。
  //    ⚠️ 有守门用例直接拿那个配置常量喂进来断言"必须被映射、不许原样透传" —— 生产者改了字会立刻红。
  { key: 'deposit_target_ambiguous', pattern: /^这一单里哪一件是付了定金的那件/ },
  { key: 'item_amount_generic', pattern: /^请逐件说明成交金额/ },
  { key: 'items_total_mismatch_generic', pattern: /^逐件成交金额合计与整单成交金额不一致/ },
  // 解析层那句**带数字**的（#231）：本模块**不改写它**，只把它当成"具体句"占位 → 原样透传。
  { key: 'items_total_mismatch_specific', pattern: /^你说的总额 .+ 与各件金额之和 .+ 对不上/ },
  { key: 'received_exceeds_total', pattern: /^已收金额和待平台结算金额不能超过本单成交金额/ },
  { key: 'voucher_one_order_one_pair', pattern: /^团购券暂只支持一单一双/ },
  { key: 'unsupported_intent', pattern: /^当前只支持商品销售录单/ },
]);

// 「一条里写了 N 双」：生产者原话是 `第N件请逐双列出成交金额；每条销售明细只能记录一双`。
const ITEM_QUANTITY_PATTERN = /^第(\d+)件请逐双列出成交金额/;

// 机器形状（**绝不许**出现在她看到的那一层）。
const ITEM_FIELD_PATTERN = /^items\[(\d+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/;
const PAYMENT_FIELD_PATTERN = /^payments\[(\d+)\]\.([A-Za-z_][A-Za-z0-9_]*)$/;

/** 把 `{name}` 换成值。用 split/join 而不是拼正则（值里可能出现 `$&` 这类字符）。 */
const format = (template, values = {}) =>
  String(template ?? '').replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole
  ));

// ⭐ **键 → 默认值**的唯一定义（`resolveSalesMissingInfoConfig` 就按它逐个读）。
//    ⚠️ 同时与 `.env.example` 里那一段**逐字对应**，有守门用例（`salesMissingInfoText.test.js` ⑥）
//    —— 新加一条文案却忘了写进 `.env.example`、或两处默认值改歪了，测试会红。
const DEFAULTS_BY_KEY = Object.freeze({
  [KEYS.intro]: DEFAULTS.intro,
  [KEYS.itemAmount]: DEFAULTS.itemAmount,
  [KEYS.itemAmountGeneric]: DEFAULTS.itemAmountGeneric,
  [KEYS.itemFieldItemNo]: DEFAULTS.itemFieldItemNo,
  [KEYS.itemFieldSize]: DEFAULTS.itemFieldSize,
  [KEYS.itemFieldQuantity]: DEFAULTS.itemFieldQuantity,
  [KEYS.itemFieldAccessoryName]: DEFAULTS.itemFieldAccessoryName,
  [KEYS.itemFieldFallback]: DEFAULTS.itemFieldFallback,
  [KEYS.paymentMethod]: DEFAULTS.paymentMethod,
  [KEYS.paymentAmount]: DEFAULTS.paymentAmount,
  [KEYS.depositMultiLine]: DEFAULTS.depositMultiLine,
  [KEYS.depositMultiLineExample]: DEFAULTS.depositMultiLineExample,
  [KEYS.depositTargetAmbiguous]: DEFAULTS.depositTargetAmbiguous,
  [KEYS.depositTargetAmbiguousGeneric]: DEFAULTS.depositTargetAmbiguousGeneric,
  [KEYS.depositAmount]: DEFAULTS.depositAmount,
  [KEYS.depositMethod]: DEFAULTS.depositMethod,
  [KEYS.depositTailUnclear]: DEFAULTS.depositTailUnclear,
  [KEYS.depositPriceMismatch]: DEFAULTS.depositPriceMismatch,
  [KEYS.itemQuantityMultiLine]: DEFAULTS.itemQuantityMultiLine,
  [KEYS.itemsTotalMismatch]: DEFAULTS.itemsTotalMismatch,
  [KEYS.receivedExceedsTotal]: DEFAULTS.receivedExceedsTotal,
  [KEYS.voucherOneOrderOnePair]: DEFAULTS.voucherOneOrderOnePair,
  [KEYS.unsupportedIntent]: DEFAULTS.unsupportedIntent,
  [KEYS.itemLabelWithSize]: DEFAULTS.itemLabelWithSize,
  [KEYS.itemLabelSizeOnly]: DEFAULTS.itemLabelSizeOnly,
  [KEYS.itemLabelFallback]: DEFAULTS.itemLabelFallback,
  [KEYS.linePrefix]: DEFAULTS.linePrefix,
});

/** 读一份文案：任何一项 —— 没设 → 默认；设了但只有空白 → 也用默认（见文件头注释）。 */
const resolveSalesMissingInfoConfig = (env = process.env) => {
  const read = (key, fallback) => {
    const raw = readRaw(env, key);
    if (raw === null) return fallback;
    const value = readString(env, key, fallback);
    if (!String(value).trim()) return fallback;
    // `.env` 文件里没法直接写换行 ⇒ 允许用 `\n` 两个字符表示换行
    //（多行文案只有「定金分开发送」那一条的例子，别的用不上）。
    return String(value).split('\\n').join('\n');
  };
  const text = Object.create(null);
  for (const [key, fallback] of Object.entries(DEFAULTS_BY_KEY)) text[key] = read(key, fallback);
  return {
    intro: text[KEYS.intro],
    itemAmount: text[KEYS.itemAmount],
    itemAmountGeneric: text[KEYS.itemAmountGeneric],
    itemField: {
      item_no: text[KEYS.itemFieldItemNo],
      size: text[KEYS.itemFieldSize],
      quantity: text[KEYS.itemFieldQuantity],
      accessory_name: text[KEYS.itemFieldAccessoryName],
      fallback: text[KEYS.itemFieldFallback],
    },
    paymentMethod: text[KEYS.paymentMethod],
    paymentAmount: text[KEYS.paymentAmount],
    depositMultiLine: text[KEYS.depositMultiLine],
    depositMultiLineExample: text[KEYS.depositMultiLineExample],
    depositTargetAmbiguous: text[KEYS.depositTargetAmbiguous],
    depositTargetAmbiguousGeneric: text[KEYS.depositTargetAmbiguousGeneric],
    depositAmount: text[KEYS.depositAmount],
    depositMethod: text[KEYS.depositMethod],
    depositTailUnclear: text[KEYS.depositTailUnclear],
    depositPriceMismatch: text[KEYS.depositPriceMismatch],
    itemQuantityMultiLine: text[KEYS.itemQuantityMultiLine],
    itemsTotalMismatch: text[KEYS.itemsTotalMismatch],
    receivedExceedsTotal: text[KEYS.receivedExceedsTotal],
    voucherOneOrderOnePair: text[KEYS.voucherOneOrderOnePair],
    unsupportedIntent: text[KEYS.unsupportedIntent],
    itemLabelWithSize: text[KEYS.itemLabelWithSize],
    itemLabelSizeOnly: text[KEYS.itemLabelSizeOnly],
    itemLabelFallback: text[KEYS.itemLabelFallback],
    linePrefix: text[KEYS.linePrefix],
  };
};

/** 一件货的说法：`31678 40码` / `腰带` / `第 2 双`（取不到货号也取不到尺码时）。 */
const formatItemLabel = (item = {}, index = 0, config = resolveSalesMissingInfoConfig()) => {
  const fallback = format(config.itemLabelFallback, { index: index + 1 });
  const accessoryName = String(item.accessory_name || '').trim();
  if (item.kind === 'accessory' && accessoryName) return accessoryName;
  const itemNo = String(item.item_no || '').trim();
  const size = Number(item.size) > 0 ? String(Number(item.size)) : '';
  if (itemNo && size) return format(config.itemLabelWithSize, { itemNo, size });
  if (itemNo) return itemNo;
  if (size) return format(config.itemLabelSizeOnly, { size });
  return accessoryName || fallback;
};

/**
 * 把 `missing_fields`（**机器清单**）收成"一件事一行"的**话题**列表。
 * 纯函数、不碰任何业务判据：只认形状，不改内容。
 */
const collectMissingTopics = (missingFields = []) => {
  const topics = [];
  const byKey = new Map();
  const ensure = (key, factory) => {
    if (!byKey.has(key)) {
      const topic = factory();
      byKey.set(key, topic);
      topics.push(topic);
    }
    return byKey.get(key);
  };
  for (const raw of Array.isArray(missingFields) ? missingFields : []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const itemField = text.match(ITEM_FIELD_PATTERN);
    if (itemField) {
      const index = Number(itemField[1]);
      const field = itemField[2];
      if (field === 'actual_amount') {
        const topic = ensure('item_amount', () => ({ kind: 'item_amount', indices: [] }));
        if (!topic.indices.includes(index)) topic.indices.push(index);
        continue;
      }
      ensure(`item_field:${field}:${index}`, () => ({ kind: 'item_field', field, index }));
      continue;
    }
    const paymentField = text.match(PAYMENT_FIELD_PATTERN);
    if (paymentField) {
      const field = paymentField[2];
      const topic = ensure(`payment_field:${field}`, () => ({ kind: 'payment_field', field, indices: [] }));
      if (!topic.indices.includes(Number(paymentField[1]))) topic.indices.push(Number(paymentField[1]));
      continue;
    }
    const quantity = text.match(ITEM_QUANTITY_PATTERN);
    if (quantity) {
      const topic = ensure('item_quantity_multi_line', () => ({ kind: 'item_quantity_multi_line', indices: [] }));
      const index = Number(quantity[1]) - 1;
      if (!topic.indices.includes(index)) topic.indices.push(index);
      continue;
    }
    const known = TEXT_TOPIC_PATTERNS.find((entry) => entry.pattern.test(text));
    // 认不出来的中文句子 → **原样透传**（宁可少美化，也绝不漏她要做的这件事）。
    ensure(`text:${known ? known.key : text}`, () => ({ kind: 'text', text, key: known ? known.key : '' }));
  }
  // 「泛化句」被「具体句」取代（同一件事只留一条）。
  for (const [genericKey, specific] of Object.entries(GENERIC_SUPERSEDED_BY)) {
    const hasSpecific = topics.some((topic) => topic.kind === specific.kind
      && (specific.key === undefined || topic.key === specific.key));
    if (!hasSpecific) continue;
    const at = topics.findIndex((topic) => topic.kind === 'text' && topic.key === genericKey);
    if (at >= 0) topics.splice(at, 1);
  }
  return topics;
};

/** 一个话题 → 一句（或两行）给她看的话。 */
const renderMissingTopic = (topic, { items = [], config }) => {
  const label = (index) => formatItemLabel(items[index], index, config);
  const labels = (indices) => (indices || []).map(label).join('、');
  switch (topic.kind) {
    case 'item_amount': {
      const text = topic.indices.length
        ? format(config.itemAmount, { items: labels(topic.indices) })
        : config.itemAmountGeneric;
      return text;
    }
    case 'item_field': {
      const template = config.itemField[topic.field] || config.itemField.fallback;
      return format(template, { item: label(topic.index) });
    }
    case 'payment_field':
      return topic.field === 'amount' ? config.paymentAmount : config.paymentMethod;
    case 'item_quantity_multi_line': {
      const indices = topic.indices.length ? topic.indices : [0];
      const quantity = indices
        .map((index) => Number(items[index]?.quantity || 0) || 1)
        .reduce((sum, value) => sum + value, 0);
      return format(config.itemQuantityMultiLine, { quantity, items: labels(indices) });
    }
    case 'text':
      break;
    default:
      return '';
  }
  switch (topic.key) {
    case 'deposit_multi_line': {
      // 例子只对"正好两件"成立（"第一条 / 第二条"）；其余件数只说动作。
      const first = items.length === 2 ? label(0) : '';
      const second = items.length === 2 ? label(1) : '';
      return first && second
        ? format(config.depositMultiLineExample, { firstItem: first, secondItem: second })
        : config.depositMultiLine;
    }
    case 'deposit_amount': return config.depositAmount;
    case 'deposit_method': return config.depositMethod;
    // ⭐ #234 新增那句：把"这一单到底是哪几双"当场点出来（点不出来就用不带清单的退路）。
    //    取 **全部** items（`topic.indices` 不适用 —— 缺的不是某一项，是"哪一项"这件事本身）。
    case 'deposit_target_ambiguous': {
      const all = (items || []).map((_, index) => label(index)).filter((text) => String(text || '').trim());
      return all.length
        ? format(config.depositTargetAmbiguous, { items: all.join('、') })
        : config.depositTargetAmbiguousGeneric;
    }
    case 'deposit_tail': return config.depositTailUnclear;
    case 'deposit_price_mismatch': return config.depositPriceMismatch;
    case 'item_amount_generic': return config.itemAmountGeneric;
    case 'items_total_mismatch_generic': return config.itemsTotalMismatch;
    case 'received_exceeds_total': return config.receivedExceedsTotal;
    case 'voucher_one_order_one_pair': return config.voucherOneOrderOnePair;
    case 'unsupported_intent': return config.unsupportedIntent;
    default:
      // `items_total_mismatch_specific`（#231 带数字那句）与一切认不出来的句子：**原样透传**。
      return topic.text;
  }
};

/**
 * ⭐ 唯一入口：`missing_fields` + 草稿里的 items/payments → **给她看的那段话**。
 *
 * 返回 `{ intro, lines, text }`：
 *   · `lines` —— 每行一件事（**没有行首编号**，方便单测逐条断言、也给别的出口复用）；
 *   · `text`  —— `intro` + 编号后的各行（`\n` 连接）= 真正发出去的那段。
 *
 * ⚠️ 返回值里的**所有字**都来自配置；本函数里**一个中文字符都没有**（只有分类正则）。
 */
const renderSalesMissingInfo = ({ missingFields = [], items = [], payments = [] } = {},
  config = resolveSalesMissingInfoConfig()) => {
  const topics = collectMissingTopics(missingFields);
  const lines = topics
    .map((topic) => renderMissingTopic(topic, { items, payments, config }))
    .filter((line) => String(line ?? '').trim());
  if (!lines.length) return { intro: '', lines: [], text: '' };
  const intro = format(config.intro, { count: lines.length });
  const numbered = lines.map((line, index) => `${format(config.linePrefix, { index: index + 1 })}${line}`);
  return { intro, lines, text: [intro, ...numbered].join('\n') };
};

/** 只取"发出去的那段话"（调用方最常用的那一个）。 */
const salesMissingInfoText = (input = {}, config = resolveSalesMissingInfoConfig()) =>
  renderSalesMissingInfo(input, config).text;

module.exports = {
  PREFIX,
  KEYS,
  PLACEHOLDERS,
  SALES_MISSING_INFO_DEFAULTS: DEFAULTS,
  SALES_MISSING_INFO_DEFAULTS_BY_KEY: DEFAULTS_BY_KEY,
  GENERIC_SUPERSEDED_BY,
  TEXT_TOPIC_PATTERNS,
  ITEM_QUANTITY_PATTERN,
  ITEM_FIELD_PATTERN,
  PAYMENT_FIELD_PATTERN,
  resolveSalesMissingInfoConfig,
  formatItemLabel,
  collectMissingTopics,
  renderSalesMissingInfo,
  salesMissingInfoText,
};
