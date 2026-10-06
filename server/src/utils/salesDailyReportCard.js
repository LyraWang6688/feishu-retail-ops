// 「销售战报」那张卡片的**纯渲染**（不含任何取值逻辑，取数在 services/salesDailyReportService）。
//
// 样式以她看完初版之后的逐字要求为准（docs/sales-report-card-design-2026-10-06.md）：
//   「**我觉得这个不太好看**。**你不用把我们的那个计算逻辑写到里面**……
//     然后用**两个比较大的、类似按钮形式的板块**：左边显示**销售单数**、右边显示**销售金额**，
//     这样就可以了，**非常醒目地起到提醒作用就行**」
// ⇒ 卡片上：**只有两个大数字块**（左右并排）＋ 标题。
//   ❌ 不写口径 / 公式 / 字段名；❌ 不做表格或长文本；❌ 不超过两个数字块。
//   （口径本身没变，只是**不写在卡片上**——口径在 docs/sales-daily-report-push-2026-10-06.md。）
//
// 为什么单独一个文件、不塞进 utils/larkCards.js：
//   · 那个文件是全仓所有卡片的大杂烩，别的链路正在改它（多代理并行时是纯冲突面）；
//   · 战报样式会跟着她的反馈改，放自己文件里改起来不牵连别人。

const money = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '¥—';
  return `¥${number.toFixed(2)}`;
};

const pad = (value) => String(value).padStart(2, '0');

/** 标题里的时间：`截止 15:00`（她给的例子就是这个写法）。 */
const slotLabel = (hour) => `截止 ${pad(hour)}:00`;

/**
 * 一个大数字块（列容器里的一列）：上面一行小字标签，下面一个**特大字号**的数字。
 *
 * `text_size` 用飞书卡片支持的字号枚举，`xxxx-large` = 30px（她要求"数字大、一眼看到数字"）。
 * ⚠️ 老实说一句验证边界：`xxxx-large` 这类特大字号是**飞书卡片 2.0 组件文档**里列的
 *   （本仓库现有卡片全是 1.0 结构，1.0 里只有 `heading` 被真机验证过）。
 *   万一她的客户端把它当成未知值 → 会退回正文字号（那就只剩"加粗"这一层强调）。
 *   数字外面还包了一层 `**...**`，认不出字号时仍然是粗体、仍然比标签醒目。
 *   ⇒ 她看一眼若觉得还不够大，改用卡片 2.0 就是**改这一个文件**的事（不动业务逻辑）。
 */
const bigNumberBlock = ({ label = '', value = '', labelColor = 'grey' } = {}) => ({
  tag: 'column',
  width: 'weighted',
  weight: 1,
  vertical_align: 'center',
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `<font color='${labelColor}'>${label}</font>`,
        text_size: 'notation',
        text_align: 'center',
      },
    },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${value}**`,
        text_size: 'xxxx-large',
        text_align: 'center',
      },
    },
  ],
});

/**
 * 销售战报卡片。
 *
 * @param {object} input
 * @param {string} input.dayKey 上海自然日 `YYYY-MM-DD`（只进日志 / 记录，不进卡片正文）
 * @param {number} input.hour 这一条是哪个整点（北京时间）
 * @param {boolean} input.isSummary 是不是 22 点那条**当日收官**
 * @param {number} input.salesCount 销售的单数
 * @param {number} input.salesAmount 销售的金额
 */
const salesDailyReportCard = ({
  hour = 0, isSummary = false, salesCount = 0, salesAmount = 0,
} = {}) => ({
  config: { wide_screen_mode: true },
  header: {
    // 常规 = 蓝、收官 = 紫：她一眼能分出"这是最后那条总结"。
    template: isSummary ? 'violet' : 'blue',
    title: {
      tag: 'plain_text',
      content: `销售战报 · ${slotLabel(hour)}${isSummary ? ' · 今日收官' : ''}`,
    },
  },
  elements: [
    {
      tag: 'column_set',
      flex_mode: 'bisect',
      horizontal_spacing: 'default',
      // 灰底让两个数字像两块"面板"（她说的"类似按钮形式的板块"）。
      background_style: 'grey',
      columns: [
        bigNumberBlock({ label: '销售单数', value: `${Number(salesCount) || 0} 单` }),
        bigNumberBlock({ label: '销售金额', value: money(salesAmount) }),
      ],
    },
  ],
});

/**
 * 卡片的**纯文本预览**（日志 / 自测 / 排查时贴给人看；从同一张卡渲染，不手抄一份免得走样）。
 */
const salesDailyReportCardText = (card) => {
  const title = card?.header?.title?.content || '';
  const blocks = [];
  const walk = (elements) => {
    (elements || []).forEach((element) => {
      if (element.tag === 'div') {
        const content = element.text?.content || '';
        if (content) blocks.push(content.replace(/\*\*/g, '').replace(/<[^>]+>/g, ''));
      } else if (element.tag === 'note') {
        blocks.push((element.elements || []).map((item) => item.content).join(' '));
      } else if (element.tag === 'column_set') {
        const columns = (element.columns || []).map((column) => {
          const parts = [];
          (column.elements || []).forEach((child) => {
            if (child.tag === 'div' && child.text?.content) {
              parts.push(child.text.content.replace(/\*\*/g, '').replace(/<[^>]+>/g, ''));
            }
          });
          return parts.join(' ');
        });
        blocks.push(columns.filter(Boolean).join('  |  '));
      }
    });
  };
  walk(card?.elements);
  return [title, ...blocks].filter(Boolean).join('\n');
};

module.exports = { salesDailyReportCard, salesDailyReportCardText, slotLabel };
