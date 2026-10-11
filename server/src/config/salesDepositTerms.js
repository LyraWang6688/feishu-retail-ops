// 「定金 / 尾款」这套**资金说法**的词表与文案（**配置先行**：换一种说法不改代码）。
//
// ── 起因（业务负责人 2026-10-07 22:59 真机，逐字）──────────────────────────────
//   她发的：「定制一双 37 码的 26632，定金交了 100 元，微信，**下次收**120元」
//   改动前的解析（`sales.ai.parsed` 逐字）：
//     items: [{item_no:"26632", size:37, quantity:1, actual_amount:""}]
//     payments: [{method:"微信", amount:100}]
//     agreed_total: "" · owed: "" · missing_fields: []
//   ⇒ 「下次收 120」**没被认成尾款**，也没推出成交额。
//   对照（同一天、能认出来的反例）：「定金微信交了 100 元，**下次欠** 128 元」→ 解析全对。
//   ⇒ **差别只在「欠」vs「收」这个用词。**
//
// ── ⚠️ 口径：**方向词不改变性质** ─────────────────────────────────────────────
//   她说的是「下次**收**」—— 收款**方向**的词在这里等于「这笔钱**还没到手**、下次收」。
//   **不许**因为方向是"收"就把它算成这次已收到的钱。
//
// ── 这份文件里只有【词表 + 文案】，判定逻辑在 `services/doubaoService` ─────────
//   · 尾款正则 = 下面三组词拼出来的（见 `TAIL_PATTERNS`）；
//   · `FUTURE_MARKERS` = "她说了这笔钱以后再付"的判据（没有它就要问"尾款是否已支付"）；
//   · `CLAUSE_BOUNDARY_WORDS` = 找定金金额时**不许跨过**的词（跨过去会把尾款当定金）；
//   · `MONEY_NOT_SETTLED_WORDS` = "这单的钱还没结清"的说法（据此**不套用**"实收金额 = 实收"）。

/**
 * 「以后再收 / 再付」的**时间词**。她说了它 ⇒ 那笔钱是"还没到手"的。
 */
const TIME_WORDS = Object.freeze(['下次', '以后', '之后', '到货后', '取货时', '来拿时']);

/** 时间词与动词之间的**副词**（「下次**还要**付」里的「还要」）。 */
const AUX_WORDS = Object.freeze(['还要', '需要', '再', '还', '要', '需', '得']);

/**
 * 尾款那句话里的**动词**。
 * ⚠️ `收` 是这次补上的那一个（真机就是它漏了）——**收 / 付方向都算"还没收到的钱"**。
 */
const VERB_WORDS = Object.freeze(['欠', '差', '付', '给', '交', '补', '收']);

/** 「尾款」这类**名词说法**（不需要时间词也能自成一句）。 */
const TAIL_NOUN_WORDS = Object.freeze(['尾款', '余款', '剩下的', '剩余', '剩下']);

/** 没有时间词、直接以"还欠 / 还要 / 再 / 补"开头的说法（「**还差** 120」）。 */
const OWED_HEAD_WORDS = Object.freeze([
  '还欠', '还差', '还需要再', '还需再', '还要再', '还要', '再', '补',
]);

/**
 * ⭐ 「她说了这笔钱**以后再给**」的判据。
 * 没有它 ⇒ `depositTerms` 会追问「请说明尾款是否已支付」（既有行为，**没动**）。
 * ⚠️ 只加"明确表示尚未支付"的词：**不许**把光秃秃的「付」放进来
 *   ——「尾款付 140 元」这种说不清算没算付的说法，必须继续问一句。
 */
const FUTURE_MARKERS = Object.freeze([
  ...TIME_WORDS,
  '还要', '待付', '未付',
  // ⚠️ 「再付」必须在：既有的「100元微信定金，**还需要再付**140元」正是靠它
  //    （那句话里没有「还要」这两个连续字）。
  '再付', '再收', '补收', '补付',
  // 「还欠 / 还差」本身就表示"钱还没给清"，不需要再跟一个时间词。
  '还欠', '还差',
]);

/**
 * 找**定金金额**时不许跨过的词（跨过去就会把尾款/别的数字当定金）。
 * ⚠️ 只放"余额侧"的词 —— 时间词（以后 / 到货后 …）**不能**放进来：
 *   写「定金以后交100」时，那些词会把「100」挡在外面，于是明明说了金额却报"没说金额"。
 */
const CLAUSE_BOUNDARY_WORDS = Object.freeze([
  '尾款', '余款', '剩下的', '剩余', '剩下', '下次', '欠', '还差',
  '再付', '再收', '补收', '补付',
]);

/**
 * 「这一单的钱**还没结清**」的说法。
 * ⚠️ 唯一的用途：出现这些词时**不套用**「实收金额 = 实收」那条还价口径
 *   —— 否则"下次收的那 120"会被当成"这单就值 100"。
 * ⚠️ 这份清单是**既有清单 + 新增的尾款说法**（既有行为一个字没改，只往后追加）。
 */
const MONEY_NOT_SETTLED_WORDS = Object.freeze([
  '定金', '预付', '预定', '尾款', '余款', '剩下的', '剩余',
  '未付', '欠款', '还欠', '欠着', '赊账',
  '下次给', '下次再给', '先给', '先付', '先交',
  // ── 本次新增：尾款的同义说法（她说"下次收"同样是"钱还没结清"）──
  '下次收', '下次付', '还要收', '还要付', '再收', '再付', '补收', '补付', '还差',
]);

/**
 * ⭐ 「成交额压根没解析出来」时给她的那句（**生产者原话**，机器清单里就是这一串）。
 *
 * 用在：她**只说了定金、没说尾款** ⇒ 成交额还没定。
 * ⚠️ 这时**绝不许**再报"已收的钱比实收金额还多" —— 成交额是**空的**，那句话是误导。
 * 她看到的那一层由 `config/salesMissingInfoText` 负责翻成人话（并把"哪一双"带上）。
 */
const SALES_DEPOSIT_TOTAL_UNKNOWN = '请说明这单实收金额或定金加尾款分别是多少';

/** 长词优先（`剩下的` 不许被拆成 `剩下` + `的`；`还要` 不许被 `还` 抢走）。 */
const alternation = (words) => [...words].sort((left, right) => right.length - left.length)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

/** 金额：`120` / `120 元` / `¥120`（尾款允许不带单位，她说「下次收120」时就是这样）。 */
const AMOUNT = '[¥￥]?\\s*(\\d+(?:\\.\\d{1,2})?)\\s*(?:元|块)?';

/**
 * 尾款的三个正则（顺序即优先级；**第一组在原话上找，后两组只在「定金」之后找**
 * —— 定金前面的数字属于上一句，把「上次还欠 200」当成本单尾款会把成交额算错）。
 */
const TAIL_PATTERNS = Object.freeze([
  // ① 名词说法：尾款 / 余款 / 剩下（的） [+ 时间词] [+ 副词] [+ 动词] + 金额
  new RegExp(`(?:${alternation(TAIL_NOUN_WORDS)})\\s*(?:${alternation(TIME_WORDS)})?`
    + `\\s*(?:${alternation(AUX_WORDS)})?\\s*(?:${alternation(VERB_WORDS)})?\\s*${AMOUNT}`),
  // ② 时间词开头：下次收 / 下次付 / 以后给 / 到货后补 …
  new RegExp(`(?:${alternation(TIME_WORDS)})\\s*(?:${alternation(AUX_WORDS)})?`
    + `\\s*(?:${alternation(VERB_WORDS)})?\\s*${AMOUNT}`),
  // ③ 没有时间词：还欠 / 还差 / 还要收 / 再付 / 补收 …
  new RegExp(`(?:${alternation(OWED_HEAD_WORDS)})\\s*(?:${alternation(VERB_WORDS)})?\\s*${AMOUNT}`),
]);

/** 「她说了以后再付」的判据（正则）。 */
const FUTURE_MARKER_PATTERN = new RegExp(alternation(FUTURE_MARKERS));

/** 定金金额的**小句边界**：标点 + 余额侧的词。 */
const CLAUSE_BOUNDARY_PATTERN = new RegExp(`[，,。；;、！!？?\\n]|${alternation(CLAUSE_BOUNDARY_WORDS)}`);

/** 「钱还没结清」的判据（正则）。 */
const MONEY_NOT_SETTLED_PATTERN = new RegExp(alternation(MONEY_NOT_SETTLED_WORDS));

module.exports = {
  TIME_WORDS,
  AUX_WORDS,
  VERB_WORDS,
  TAIL_NOUN_WORDS,
  OWED_HEAD_WORDS,
  FUTURE_MARKERS,
  CLAUSE_BOUNDARY_WORDS,
  MONEY_NOT_SETTLED_WORDS,
  SALES_DEPOSIT_TOTAL_UNKNOWN,
  TAIL_PATTERNS,
  FUTURE_MARKER_PATTERN,
  CLAUSE_BOUNDARY_PATTERN,
  MONEY_NOT_SETTLED_PATTERN,
};
