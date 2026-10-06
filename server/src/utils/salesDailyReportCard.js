// 「销售战报」那张卡片的**纯渲染**（不含任何取值逻辑，取数在 services/salesDailyReportService）。
//
// 为什么单独一个文件、不塞进 utils/larkCards.js：
//   · 那个文件是"全仓所有卡片"的大杂烩，别的链路正在改它（多代理并行时是纯冲突面）；
//   · 战报的样式会跟着她的口径改（"当日收官"怎么说、要不要加行），放自己文件里改起来不牵连别人。
//
// 口径以 `docs/sales-daily-report-push-2026-10-06.md` 为准：
//   · 形式是**消息卡片**；两个数字：销售的单数 / 销售的金额；
//   · ⚠️ 22 点那一条是**当日收官**，要和常规时段**一眼能分开**（标题 + 页眉色 + 一行说明）。

const money = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '¥—';
  return `¥${number.toFixed(2)}`;
};

const pad = (value) => String(value).padStart(2, '0');

/** 北京时间 `MM-DD HH:00`（卡片标题上给她的时间，一律按上海时间说）。 */
const slotLabel = ({ dayKey = '', hour = 0 } = {}) => {
  const monthDay = String(dayKey).slice(5) || '';
  return `${monthDay} ${pad(hour)}:00`;
};

/**
 * 销售战报卡片。
 *
 * @param {object} input
 * @param {string} input.dayKey 上海自然日 `YYYY-MM-DD`
 * @param {number} input.hour 这一条是哪个整点（北京时间）
 * @param {boolean} input.isSummary 是不是 22 点那条**当日收官**
 * @param {number} input.salesCount 销售的单数（销售明细「履约状态=已履约」条数）
 * @param {number} input.salesAmount 销售的金额（收款明细「已收款」且今天、截至此刻）
 * @param {number} [input.refundAmount] 今天「已收款」里**交易方向=退回**的金额（有才提示，见下）
 * @param {string} [input.generatedAt] 生成时刻（上海时间 `HH:mm`），放页脚便于排查
 * @param {string} [input.countNote] 单数那一条的口径说明（默认按已履约口径写）
 */
const salesDailyReportCard = ({
  dayKey = '', hour = 0, isSummary = false, salesCount = 0, salesAmount = 0,
  refundAmount = 0, generatedAt = '', fulfilledLabel = '已履约', paymentStatus = '已收款',
  countNote = '',
} = {}) => {
  const label = slotLabel({ dayKey, hour });
  const title = isSummary
    ? `📊 销售战报 · ${label} 当日收官`
    : `📊 销售战报 · ${label}`;

  const lines = [
    `**销售单数**：${salesCount} 单`,
    `**销售金额**：${money(salesAmount)}`,
  ];
  // ⚠️ 退回（交易方向=退回）在「收款明细」里也是「已收款」，所以按她的字面口径它**会被算进**
  //    "今天收到的钱"。这个提示只在**真有退回**时出现（平常卡片一个字都不多），
  //    免得她以为金额算错了却查不出原因。
  if (Number(refundAmount) > 0) {
    lines.push(`（其中含「退回」${money(refundAmount)}，按她的口径**未冲抵**）`);
  }

  const footNotes = [
    countNote || `单数 = 销售明细「履约状态 = ${fulfilledLabel}」的条数（一条明细 = 一双鞋 = 一个单子）`,
    // ⚠️ 口径是"截止到**推送那一刻**"（她的原话），所以这里写**生成时刻**，
    //    不写整点：服务 21:39 才起来时，钱是算到 21:39 的，写"截至 21:00"就是假话。
    `金额 = 收款明细「${paymentStatus}」且收款时间是今天、截至推送那一刻${generatedAt ? `（${generatedAt}）` : ''}`,
  ];
  if (isSummary) footNotes.push(`✅ 今日收官 · 以上为当天累计（截至${generatedAt ? ` ${generatedAt}` : '此刻'}）`);
  if (generatedAt) footNotes.push(`生成于 ${dayKey} ${generatedAt}（北京时间）`);

  return {
    config: { wide_screen_mode: true },
    header: {
      // 常规 = 蓝、收官 = 紫：她一眼能分出"这是最后那条总结"。
      template: isSummary ? 'violet' : 'blue',
      title: { tag: 'plain_text', content: title },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n') } },
      { tag: 'hr' },
      { tag: 'note', elements: [{ tag: 'plain_text', content: footNotes.join('\n') }] },
    ],
  };
};

/** 卡片里**她要看的那两行**的纯文本版（日志 / 自测 / 排查时贴给人看用，别再手抄一遍）。 */
const salesDailyReportCardText = (card) => {
  const title = card?.header?.title?.content || '';
  const body = (card?.elements || [])
    .map((element) => {
      if (element.tag === 'div') return element.text?.content || '';
      if (element.tag === 'note') return (element.elements || []).map((item) => item.content).join('\n');
      return '';
    })
    .filter(Boolean)
    .join('\n');
  return `${title}\n${body}`;
};

module.exports = { salesDailyReportCard, salesDailyReportCardText, slotLabel };
