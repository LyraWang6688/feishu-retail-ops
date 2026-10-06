// 「采购到货：群话题对话式核对」的配置（配置先行）。
//
// 业务负责人 2026-10-06 定稿的规格见 `docs/arrival-conversation-flow.md`。
// 这份文件只放**会变的量**：开关、时区、意图判定的提示词、卡片与回复文案。
// 逻辑里不许再出现这些字面量——换一句话、换一个开关值，只动这一个文件。
//
// 为什么单独一个文件、而不是散在服务里读 process.env：
//   · 判据（提示词）、模型调用、文案都是"业务口径"，她要改的是这几样，不是代码；
//   · 单测可以直接把值传进服务，不用改全局 process.env（并发跑用例时不会互相污染）。

// ── 入口开关 ────────────────────────────────────────────────────────────────
//
// ⚠️ 这条链路的开关**就是** `PURCHASE_ARRIVAL_INTAKE_ENABLED`
// （`src/config/purchaseArrivalIntake.js`）——**刻意不新加第二个开关**。
// 项目当初把那个模块"保留但无读取点"就是为了这一刻：AGENTS.md 原文写着
// 「将来恢复「对话到货」时它是一个现成的、语义明确的开关（已钉住"空字符串不等于关闭"那个坑）」。
// 两个开关并存的后果是"她关了 A、链路还在跑"，属于最难查的静默失效。
//
// 判定规则（由 purchaseArrivalIntake.js 提供，本文件不复制一份）：
//   · 去掉首尾空白、忽略大小写后**恰好等于 'false'** → 关闭；
//   · 其它一切（undefined / '' / 'true' / '1' / 写错的值） → 开启。
//
// ⚠️ 为什么必须有开关：「对话到货」是一条**会写四张业务表**的新链路
// （采购到货 / 采购入库 / 库存流水 / 实时库存）。她要能在半夜用一个环境变量停掉它，
// 而不是等一次"改代码 + 部署"。

// ── 业务口径（未定项的"保守默认"，逐条都在 PR 里标注了"这处待你确认"）────────

// ④「到货日」：取**她点「是」那一刻**的日期，按上海时区。
// 存进「到货日」的是那一刻的时间戳本身（字段是日期字段），日志里另外给一个
// 上海时区的 `arrival_date`（yyyy-mm-dd），排查时不用自己换算。
const ARRIVAL_TIMEZONE = 'Asia/Shanghai';

/** 一个时间戳在上海时区是哪一天（yyyy-mm-dd）。只用于日志与测试断言。 */
const arrivalDateOf = (timestamp) => {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: ARRIVAL_TIMEZONE }).format(new Date(value));
};

// ⑤「卡片按钮」：只「是」一个。规格正文写的就是「确认入库吗？」→「是」，
// **不加**「否 / 再想想」——没要求的东西不发明。
// 动作名沿用被删掉的那一个（`confirm_purchase_arrival`）：语义没变，卡片与分派共用这一个常量。
const ARRIVAL_CONFIRM_ACTION = 'confirm_purchase_arrival';

// 对话可以很长（她可以一条一条说）。只留最近这些条给模型，避免提示词无限膨胀；
// 超过之后仍会被记进本地记录，只是不再进提示词。
const MAX_TRANSCRIPT_MESSAGES = 60;
// 已处理过的 message_id 单独记一份（去重用）：飞书会把同一条消息重投多次。
const MAX_SEEN_MESSAGE_IDS = 500;

// ── 文案（她能看到的话，全部集中在这里）────────────────────────────────────

const CONFIRM_CARD_TITLE = '本次到货核对完毕，确认入库吗？';
const CONFIRM_BUTTON_LABEL = '是';
const POSTED_CARD_TITLE = '已入库';

// ② 实际到货 = 0（全没到）的**规则性**回复。
// ⚠️ 这不是错误，是规则：`inventory.applyPurchase` 不接受 0，而且"全没到"到底是
// 真没到还是要取消/改数量，只有她改表才能表达。所以这里既不猜、也不写任何表。
const ZERO_ARRIVAL_REPLY =
  '这次一双都没到 —— 如果是要取消/改数量，请改表再发一次。';
const ZERO_ARRIVAL_LOG_REASON = 'zero_arrival_is_a_rule_not_an_error';

/** ① 实际到货 > 申请数量：照实际入库，但要在群里让她知道多在哪。 */
const overageNotice = (overage) =>
  `⚠️ 这次比申请多了 ${overage} 双，我按**实际到的数量**入库（采购申请表没有改动）。`;

/** 入库成功的群里回执。 */
const postedReply = ({ batchNo = '', inboundCount = 0, quantity = 0, arrivalDate = '' } = {}) => {
  const parts = [];
  if (batchNo) parts.push(`批次 ${batchNo}`);
  parts.push(`按实际到的数量入库 ${quantity} 双（${inboundCount} 条入库明细）`);
  if (arrivalDate) parts.push(`到货日 ${arrivalDate}`);
  return `✅ 已入库：${parts.join('，')}。采购申请表一个字都没有改。`;
};

/** 重复点「是」/ 重复投递：明确告诉她"已经入过库了"，不给"卡住了"的错觉。 */
const alreadyPostedReply = ({ batchNo = '' } = {}) =>
  `✅ 这批${batchNo ? `（${batchNo}）` : ''}已经入过库了，我没有重复入库。`;

/** 「核对完了」被判出来了、但实际到货一条都对不上时的兜底（不猜、不写）。 */
const UNMATCHED_ARRIVAL_REPLY =
  '这次说的到货我在采购申请里找不到对应的明细，我没有入库 —— 核对一下货号/尺码再说一次，或者改表。';

// 我们的模型判断失败（网络 / 配置 / 返回不是 JSON）时的**内部**原因，
// 只进日志：她还在核对过程中，没有可执行的动作，主动追问只会刷屏。
const UNDERSTAND_FAILED_REASON = 'intent_judgement_failed';

// ── AI 判「核对完毕」的提示词（③ 靠 AI 理解意图，不是关键词匹配）──────────

/**
 * 把「采购申请基准 + 话题里的原话」交给文字模型，让它回答两件事：
 *   ① 她是不是表达了"这次核对完了"（**字眼不固定**：复核完了 / 核对完了 / 就这样吧…）；
 *   ② 实际到货数量是多少（以申请单为基准做校准）。
 *
 * ⚠️ 输出用**基准行号**（index）而不是货号+颜色+尺码：让模型做字符串匹配会导致
 * 「同一个货号两个颜色」这类数据上静默错配；行号是确定的。
 *
 * @param {{baseline: Array, transcript: Array, batchNo?: string}} input
 */
const buildArrivalConversationPrompt = ({ baseline = [], transcript = [], batchNo = '' } = {}) => {
  const baselineLines = baseline.map((row, index) => {
    const requested = Number(row.requested_quantity);
    return `[${index}] 货号 ${row.item_no || '（未知）'} / 颜色 ${row.color || '（未知）'} / 尺码 ${row.size} / 申请 ${Number.isFinite(requested) ? requested : 0} 双`;
  });
  const transcriptLines = transcript.map((message) => `- ${message.text}`);
  return `
你是鞋店的到货核对助手。业务负责人在飞书群的一个话题里，用自然语言核对**这一批采购到货**
到底到了多少。机器人**不主动追问**，只把她说过的话记下来。

这一批的采购申请（**历史基准，不会改**）：
${baselineLines.join('\n') || '（空）'}
${batchNo ? `\n报货批次号：${batchNo}` : ''}

她在话题里说过的话（按时间先后）：
${transcriptLines.join('\n') || '（空）'}

请回答两个问题，只输出严格 JSON：

{
  "finalized": false,
  "items": [{"index": 0, "quantity": 2}],
  "reason": ""
}

1. finalized：她**是不是表达了"这次核对完了"**。字眼不固定——
   「核对完了」「复核完了」「就这样吧」「对完了」「没问题了」都算；只是描述到货情况、
   还在补充数量、问别的事情都**不算**。判断不出来就填 false。
   ⚠️ 只在**她的最后一句**表现出"收尾"的意思时才填 true；中间的补充说明不算。
2. items：**实际到货的数量**，以申请单为基准校准：
   · 每条用基准里的行号 index（[] 里的数字），**不要自己编货号或尺码**；
   · quantity 是这个尺码**实际到了几双**（整数，可以是 0）；
   · 她没说到的行 → 按申请的尺码和数量全到了（quantity = 申请数量）；
   · 她说"少了两双 38 码" → 该行 38 码的数量 = 申请数量 - 2（最低 0）；
   · 她说"一双都没到 / 都没到" → 所有行 quantity = 0；
   · 她说"多到了两双" → 对应行数量 = 申请数量 + 2；
   · 说不清某一行到底到了多少 → **不要猜**，按申请数量填，并在 reason 里说明；
   · 基准里没有的行不要输出。
3. reason：一句话说明你怎么理解的（可以为空字符串）。

只输出 JSON，不输出 Markdown 或说明。
  `.trim();
};

module.exports = {
  ARRIVAL_TIMEZONE,
  arrivalDateOf,
  ARRIVAL_CONFIRM_ACTION,
  MAX_TRANSCRIPT_MESSAGES,
  MAX_SEEN_MESSAGE_IDS,
  CONFIRM_CARD_TITLE,
  CONFIRM_BUTTON_LABEL,
  POSTED_CARD_TITLE,
  ZERO_ARRIVAL_REPLY,
  ZERO_ARRIVAL_LOG_REASON,
  UNMATCHED_ARRIVAL_REPLY,
  UNDERSTAND_FAILED_REASON,
  overageNotice,
  postedReply,
  alreadyPostedReply,
  buildArrivalConversationPrompt,
};
