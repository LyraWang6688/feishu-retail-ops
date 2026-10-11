// 退换货第二期·第二步（接线 + 确认卡片）的配置。
//
// 为什么单独成文件（配置先行，与 config/afterSales.js 并列而不混在一起）：
//   ① 「她这句话是退 / 换 / 赔哪一种」是**模型输出**与**后端分支**之间的契约。
//      模型可能回英文、中文、简写（return / 退货 / 退），收敛规则只放一处，
//      加一种说法不去动 service 里的 if-else（和 config/saleIntents 的做法一致）。
//   ② 「退回来的鞋放哪」是契约，而且**有**业务默认值（默认原状态=门盒），运营改口径只改这里；
//      「钱怎么走」同样是契约，但**故意没有默认值**——业务红线是"钱不能猜"，
//      她没说就回一句问她，不替她决定（见下面「钱怎么走」一节的说明）。
//   ③ 卡片动作名（确认 / 取消 / 选回库状态）是卡片与后端之间的契约，测试要直接引用常量。
//
// ⚠️ 执行器自己的契约（动作枚举 AFTER_SALES_ACTIONS、库存行为编码、幂等键）在
//    config/afterSales.js，这里 import 复用，**不重复定义**，避免两处枚举漂移。

const crypto = require('node:crypto');
const { AFTER_SALES_ACTIONS } = require('./afterSales');

// 卡片按钮的 value.action。名字带 after_sales 前缀，与销售/采购的动作名不会撞。
const AFTER_SALES_CARD_ACTIONS = Object.freeze({
  CONFIRM: 'confirm_after_sales',
  CANCEL: 'cancel_after_sales',
  // 退回的鞋放哪儿：她话里没说时，卡片上给按钮让她点（默认原状态）。
  RESTOCK: 'choose_after_sales_restock',
});
// ⚠️ 这里**没有**"选资金走向"这个卡片动作：钱怎么走不用卡片按钮（业务负责人 2026-10-05 纠正：
//   「会说的，所以不用再有要卡片按钮的链路了」）。她没说就**回一句文字问**，她回一句我们照做。

const isAfterSalesCardAction = (action) =>
  Object.values(AFTER_SALES_CARD_ACTIONS).includes(String(action ?? '').trim());

// 本地任务状态（只写 data/lark_mvp_tasks，不写任何业务表）。
//   asking     —— 信息不够（没说退哪一双 / 序号上下文过期），已回话让她补充
//   confirming —— 确认卡片已发出，等她点确认/取消
//   running    —— 已收到确认，正在调执行器（防连点）
//   done       —— 执行器已返回成功
//   cancelled  —— 她点了取消，一个字节都没写
const AFTER_SALES_TASK_STATUS = Object.freeze({
  ASKING: 'after_sales_asking',
  CONFIRMING: 'after_sales_confirming',
  RUNNING: 'after_sales_running',
  DONE: 'after_sales_done',
  CANCELLED: 'after_sales_cancelled',
});

// 她说「第 2 笔」时模型给 ordinal；模型偶尔漏字段，所以再用一次确定性文本兜底。
const ORDINAL_TEXT_PATTERN = /第\s*(\d+)\s*笔/;

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

// 键统一按小写比较（中文不受影响）。赔货在**意图**注册表里被并进 exchange
// （第一期只判意图，赔货归到"换"这一类）；但执行必须分开——赔货不回库、不动钱，
// 与换货的库存和账完全不同（见 config/afterSales 的 AFTER_SALES_ACTION_SPECS）。
const AFTER_SALES_ACTION_ALIASES = Object.freeze({
  return: AFTER_SALES_ACTIONS.RETURN,
  退货: AFTER_SALES_ACTIONS.RETURN,
  退: AFTER_SALES_ACTIONS.RETURN,
  退款: AFTER_SALES_ACTIONS.RETURN,
  退钱: AFTER_SALES_ACTIONS.RETURN,
  exchange: AFTER_SALES_ACTIONS.EXCHANGE,
  换货: AFTER_SALES_ACTIONS.EXCHANGE,
  换: AFTER_SALES_ACTIONS.EXCHANGE,
  换一双: AFTER_SALES_ACTIONS.EXCHANGE,
  compensation: AFTER_SALES_ACTIONS.COMPENSATION,
  赔货: AFTER_SALES_ACTIONS.COMPENSATION,
  赔付: AFTER_SALES_ACTIONS.COMPENSATION,
  赔: AFTER_SALES_ACTIONS.COMPENSATION,
});

// 模型没给 action 时的确定性兜底。**顺序有意义**：先「赔」再「换」最后「退」，
// 因为"赔"最具体（"赔一双"里没有退/换），而"换"优先于"退"是因为
// "换一双，旧的退了"这类话主体是换货。
const AFTER_SALES_ACTION_HINTS = Object.freeze([
  Object.freeze({ action: AFTER_SALES_ACTIONS.COMPENSATION, words: Object.freeze(['赔']) }),
  Object.freeze({ action: AFTER_SALES_ACTIONS.EXCHANGE, words: Object.freeze(['换']) }),
  Object.freeze({ action: AFTER_SALES_ACTIONS.RETURN, words: Object.freeze(['退']) }),
]);

/**
 * 收敛「她这句话要做什么」。
 * 优先信模型给的 action 字段（它读了整句话）；没给就按原话关键词兜底；
 * 再没有就退回意图（return→退货、exchange→换货——赔货没有独立意图，只能靠上面两步）。
 * 全认不出来返回空串，由调用方回一句"没听懂"，**绝不猜成退货去动账**。
 */
const resolveAfterSalesAction = ({ action, intent, text } = {}) => {
  const key = String(action ?? '').trim().toLowerCase();
  if (AFTER_SALES_ACTION_ALIASES[key]) return AFTER_SALES_ACTION_ALIASES[key];
  const source = String(text ?? '');
  for (const hint of AFTER_SALES_ACTION_HINTS) {
    if (hint.words.some((word) => source.includes(word))) return hint.action;
  }
  if (intent === 'return') return AFTER_SALES_ACTIONS.RETURN;
  if (intent === 'exchange') return AFTER_SALES_ACTIONS.EXCHANGE;
  return '';
};

const AFTER_SALES_ACTION_LABELS = Object.freeze({
  [AFTER_SALES_ACTIONS.RETURN]: '退货',
  [AFTER_SALES_ACTIONS.EXCHANGE]: '换货',
  [AFTER_SALES_ACTIONS.COMPENSATION]: '赔货',
});

const actionLabelOf = (action) => AFTER_SALES_ACTION_LABELS[action] || '售后';

// ---------------------------------------------------------------------------
// 钱怎么走
// ---------------------------------------------------------------------------

// 执行器只认 cash / prepaid（config/afterSales.settlements）：
//   cash    —— 钱真收/真退：写「收款明细」，收款方式 = **她说的那个**（她没说才沿用原单）
//   prepaid —— 钱存着：写「客户往来货款」，变动类型=退货退款
// 「微信 / 支付宝」也归 cash：它们共用"收款明细"这条腿，这一层只回答
// "走收款明细还是走预存"；**具体写哪个收款方式**由下面的
// `resolveAfterSalesPaymentMethod` + 执行器负责（见那一节）。
const AFTER_SALES_SETTLEMENT_ALIASES = Object.freeze({
  cash: 'cash',
  现金: 'cash',
  退现金: 'cash',
  收现金: 'cash',
  微信: 'cash',
  支付宝: 'cash',
  prepaid: 'prepaid',
  预存: 'prepaid',
  预存款: 'prepaid',
  存预存: 'prepaid',
  存着: 'prepaid',
  先存着: 'prepaid',
  存起来: 'prepaid',
});

// 她说的是自然语言，整串未必正好等于表里的词（业务负责人的原话就是「退我现金」）。
// 所以先查整串别名表，查不到再按关键词收一道——**关键词只用来认出她说了哪种走法，
// 绝不用来"补"出一个走法**：两族关键词都出现（说法自相矛盾）时返回空，
// 按"没解析出钱怎么走"大声拦住（见下面），不猜。
const AFTER_SALES_SETTLEMENT_HINTS = Object.freeze([
  Object.freeze({ settlement: 'prepaid', words: Object.freeze(['预存', '存着', '存起来', '先存', '存上']) }),
  Object.freeze({ settlement: 'cash', words: Object.freeze(['现金', '微信', '支付宝']) }),
]);

const resolveAfterSalesSettlement = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (AFTER_SALES_SETTLEMENT_ALIASES[raw]) return AFTER_SALES_SETTLEMENT_ALIASES[raw];
  const matched = AFTER_SALES_SETTLEMENT_HINTS
    .filter((hint) => hint.words.some((word) => raw.includes(word)))
    .map((hint) => hint.settlement);
  return matched.length === 1 ? matched[0] : '';
};

// ---------------------------------------------------------------------------
// 收款方式（她说的**渠道**：现金 / 微信 / …）
// ---------------------------------------------------------------------------
//
// ⚠️ 与上面「钱怎么走」是**两件事**，别混：
//   · 「钱怎么走」（settlement）回答"走收款明细还是走预存"（cash / prepaid）；
//   · 「收款方式」（这里）回答"走收款明细时，「收款明细.收款方式」那一列写哪个"。
// 上面那张别名表把「现金 / 微信 / 支付宝」**都**收敛成 cash —— 具体渠道在那一层被抹掉了，
// 所以"记录里要写她实际说的方式"就必须在**原话**上再认一次（见 `resolveAfterSalesPaymentMethod`）。
//
// ⭐ 取**最后**一个命中的：她描述退款方式时方式一般在钱的后面
//   （"退我现金" / "退给她 230，微信退"）。首命中会在
//   "那双原来微信买的，现在退现金" 上写错成微信 —— 末命中不会。
//
// ⚠️ 这份词表与销售话题链路的 `config/salesProgressIntake.paymentMethodAliases` 是同一批业务说法。
//    **两处各自持有一份是刻意的**（解耦：任一条链路被拿掉，另一条还活着）——
//    改收款方式的说法时**两处都要改**（`server/test/afterSalesFlow.test.js` 有一条用例钉住这份表）。
//
// ⚠️ 这里**只认她说出来的方式**；认不出就返回空 → 执行器沿用原单的方式
//   （业务负责人 2026-10-06：「钱退现金」写现金；没说方式再按现有逻辑处理）。
const AFTER_SALES_PAYMENT_METHOD_HINTS = Object.freeze([
  Object.freeze({ method: '微信', words: Object.freeze(['微信']) }),
  Object.freeze({ method: '支付宝', words: Object.freeze(['支付宝']) }),
  Object.freeze({ method: '现金', words: Object.freeze(['现金']) }),
  Object.freeze({ method: '刷卡', words: Object.freeze(['刷卡', '刷信用卡']) }),
  Object.freeze({ method: '银行卡', words: Object.freeze(['银行卡']) }),
  Object.freeze({ method: '转账', words: Object.freeze(['转账']) }),
]);

const resolveAfterSalesPaymentMethod = (text) => {
  const source = String(text ?? '');
  if (!source) return '';
  let found = { method: '', index: -1 };
  for (const hint of AFTER_SALES_PAYMENT_METHOD_HINTS) {
    for (const word of hint.words) {
      const index = source.lastIndexOf(word);
      if (index >= 0 && index > found.index) found = { method: hint.method, index };
    }
  }
  return found.method;
};

// ⚠️ 这里**故意没有**「默认资金走向」这个常量。
//
// 2026-10-05 删掉了原来的 `DEFAULT_AFTER_SALES_SETTLEMENT = 'cash'`，起因是业务负责人的原话：
//   「不是啊，退货不是默认现金啊，都有啊！只不过是分为是不是当前退钱还是先预存着而已」
//
// 为什么钱不能有默认值：
//   ① 「退现金」和「存为预存额度」在她店里**都是常规做法**，不存在"绝大多数是现金"这回事。
//      原来那个默认值等于**系统替她决定钱怎么走**：猜错了就是账目错，而且她在卡片上看到的是
//      一个"已经定好"的走向，根本看不出这是我们猜的。
//   ② 钱是这一整条链路里**唯一不可静默**的部分：货、库存写错了还能看出来，钱少了一笔没人会发现。
//   ③ 所以规则只有两句：
//        · 她说了（"钱先存着" / "退我现金" / "退了多少、微信还是现金"）→ 按她说的走
//          （resolveAfterSalesSettlement）；
//        · 差价 = 0（不动钱）→ 不存在资金走向，卡片上直接写「不动钱」。
//   ④ 只有"不动钱"才允许留空。执行器（afterSalesService.normalizeRequest）的口径是
//      「settlement 为空 = 不动钱」——所以接线层**绝不能**把"没解析出钱怎么走"直接透传给
//      执行器，否则会静默地一分钱都不动。**大声拦住，绝不猜**（见下面⑤）。
//   ⑤ 万一模型真的没解析出钱怎么走 → 不默认、也不设计任何"兜底/追问"链路，
//      直接**抛一个明确的错**拦住这一笔（业务表零写入），让她重发一次。
//
// 为什么不给卡片按钮、也不做"追问一句"的兜底（2026-10-05 业务负责人的两次纠正）：
//   · 「会说的，所以不用再有要卡片按钮的链路了」——不要 `[退现金] [存为预存额度]` 那组按钮；
//   · 「不用啊，你为什么要做兜底呢？……他会说退回了多少钱、退给多少钱、是以微信的形式
//     还是什么样的一个形式，都会说清楚的。以及说那个钱先留着，这些都会说清楚的呀。
//     所以，为什么你还要再去做兜底呢？」——**"她没说钱"这个场景不存在**，
//     所以不为它设计交互（不做追问、不记待回答的计划、不在入口层续接）。
//   留一个"没解析出来就大声报错"的缺口提示是允许的（否则就是静默漏钱），
//   但不能因此长出一条新的交互链路——她说的话本来就是唯一输入。

// ---------------------------------------------------------------------------
// 换货的"新的一双"：追问话术（**用户可见文案，一律放这里**，配置先行）
// ---------------------------------------------------------------------------
//
// 背景（业务负责人 2026-10-07 的口径，逐字）：
//   「我们一般换货的情况是这样子：1. 换尺码（尺码不合适）  2. 换另一双鞋
//    （这双鞋可能不太喜欢，又换了另一双）」。
//
// ⇒ 换货有**两种**，接线层只按"她有没有说换给她的那一双的任何信息"分档问：
//   · 三种字段（new_item_no / new_color / new_size）**全空** → `needNewItem`（她什么都没说）
//   · 有货号/颜色、只缺尺码 → `needNewSize`（补全这个模板，逐字沿用改动前的问法）
//   ⚠️ 一个字段都不许替她猜：`needNewAmount` 用在两种情形 ——
//      "同款换码但原明细没有实收金额"（不许拿标价顶）与"换另一双、货品表连单价都读不到"。
//
// ⚠️ 缺"要退/要换的原那双"（`no_item_info` / `action_unresolved` 那两句）**没进这张表**：
//    它们是"整条售后还没定位到那一笔"的问法，与这次换货放宽判据无关 —— 保持原样、一个字没动。
const AFTER_SALES_ASK_TEXTS = Object.freeze({
  // 她**什么都没说**（新货号 / 新颜色 / 新尺码三者全空）→ 除了货号，明确告诉她"只说新尺码也行"
  //（同款换码本来就没有新货号 —— 这正是真机那次被问懵的地方）。
  needNewItem: '换成哪一双？发我货号，或者只说新尺码也行。',
  // 有了货号/颜色、只缺尺码：逐字沿用改动前的问法（她一眼知道还缺哪一项）。
  needNewSize: ({ itemNo = '', color = '' } = {}) => `换的那双 ${itemNo}${color} 多大码？`,
  // 「货品信息」里找不到她说的新货号（不猜、也不拿别的货顶）。
  newProductNotFound: ({ itemNo = '', color = '' } = {}) => `货品表里找不到 ${itemNo}${color}，核对一下货号。`,
  // 连「货品信息.单价」都读不到、她又没说金额 → 必须问，不许猜一个数。
  needNewAmount: ({ itemNo = '', color = '' } = {}) => `换的那双 ${itemNo}${color} 多少钱？`,
});

// ---------------------------------------------------------------------------
// 退回的鞋放哪
// ---------------------------------------------------------------------------

// 执行器的 restockStates 只允许这两个；「原状态」在本店口径下就是**门盒**
// （退回来的鞋回到门盒，样品是陈列品）。她可以在卡片上改。
const DEFAULT_AFTER_SALES_RESTOCK_STATE = '门盒';

const resolveAfterSalesRestockState = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw.includes('样')) return '样品';
  if (raw.includes('门') || raw.includes('盒')) return '门盒';
  return '';
};

// ---------------------------------------------------------------------------
// 多轮上下文
// ---------------------------------------------------------------------------

// 「她上一次查到的是哪几笔」按**人**记一条本地记录（跨消息、10 分钟有效）。
// 为什么按人不按消息：每条用户消息都会新建一个任务，下一句「第 2 笔，退货」
// 是**另一条消息**，从它自己的任务里看不到上一句的候选。
// 只是本地缓存（data/lark_mvp_tasks），不是业务事实——过期就请她重新查。
const afterSalesContextId = (senderOpenId) => {
  const hash = crypto.createHash('sha256').update(String(senderOpenId || '')).digest('hex').slice(0, 20);
  return `after_sales_ctx_${hash}`;
};

module.exports = {
  AFTER_SALES_CARD_ACTIONS,
  isAfterSalesCardAction,
  AFTER_SALES_TASK_STATUS,
  ORDINAL_TEXT_PATTERN,
  AFTER_SALES_ACTION_ALIASES,
  AFTER_SALES_ACTION_LABELS,
  actionLabelOf,
  resolveAfterSalesAction,
  AFTER_SALES_SETTLEMENT_ALIASES,
  AFTER_SALES_PAYMENT_METHOD_HINTS,
  resolveAfterSalesSettlement,
  resolveAfterSalesPaymentMethod,
  AFTER_SALES_ASK_TEXTS,
  DEFAULT_AFTER_SALES_RESTOCK_STATE,
  resolveAfterSalesRestockState,
  afterSalesContextId,
};
