// 「9 点待处理单推送」这张**卡片**的骨架（纯函数；只排布，不认识飞书、不认识表）。
//
// 为什么另立一个文件（而不是塞进 `utils/larkCards`）：
//   · `larkCards.js` 里那 14 张卡都被 `im.message.patch` 更新过，**必须**整体带
//     `config.update_multi:true`（见那份文件顶部的长注释）；这张推送卡**从不 patch**，
//     按仓库既有纪律（`saleLookupCard` / `purchaseRequestConfirmationCard`）**刻意不带**那个字段。
//     两张卡的硬前提不同 ⇒ 不放在同一处，免得将来有人"顺手统一"把 update_multi 加上去。
//   · 本文件**不含任何用户可见中文**：文案 / 颜色 / 标记骨架全在 `config/pendingDealPush`
//     （配置先行）；这里只把"已经渲染好的段"排成飞书卡片 JSON。
//
// 结构（业务负责人 2026-10-08 的口径）：
//   标题（含日期与总计）→ 【预定】区 → 分割线 → 【现货待收】区 → 分割线 → 【采购】区 → 脚注
//   ⭐ 分割线只出现在**相邻两个块之间**（首块之前、尾块之后都没有）；
//      `{ text }` 那种"大区标题"行**不算块**（不参与分割线，也不会顶掉它后面的块）。
//   ⭐ 空块连标题都不出现（调用方负责给空块 —— 本文件再兜一层，`lines` 为空就整块不要）。
//
// @param {object} input
// @param {string} input.header            标题文案（已渲染；空串 = 这张卡没有 header）
// @param {object} input.card              卡片标记骨架（`config/pendingDealPush` 的 `card`）
// @param {Array<{text:string}|{title:string, lines:string[][]}>} input.parts
//        每项要么是一行普通文本（大区标题），要么是一块（标题 + 若干行，每行是**已渲染的段**数组）
// @param {string[]} [input.footerLines]   脚注（深链缺失提示）；空数组 = 没有脚注元素
// 把一行的若干"段"拼起来。**空的段整段不要**（调用方已经滤过一遍，这里再兜一层），
// 并且：**只由序号组成的段（`1.`）不单独成段** —— 缺货号那种数据不全的行，
// 拼出来会是 `1. · 【预定】 · …`，那个多出来的 ` · ` 看着就是渲染坏了。
const joinLineSegments = (segments, separator = ' ') => {
  const parts = (segments || []).map((s) => String(s ?? '').trim()).filter(Boolean);
  const head = /^\d+\.$/.test(parts[0] || '') ? parts.shift() : '';
  const body = parts.join(separator);
  if (!head) return body;
  return body ? `${head} ${body}` : head;
};

const pendingDealPushCard = ({
  header = '', card = {}, parts = [], footerLines = [],
} = {}) => {
  const {
    headerColor = 'blue', sectionTitleTemplate = '**{title}**', lineSeparator = ' ',
  } = card;
  const fill = (template, values) => String(template ?? '')
    .replace(/\{([^{}]*)\}/g, (whole, key) => (
      values[key] === undefined || values[key] === null ? '' : String(values[key])));

  const elements = [];
  let renderedBlocks = 0;
  for (const part of parts || []) {
    if (!part) continue;
    if (part.text !== undefined) {
      const text = String(part.text ?? '').trim();
      if (text) elements.push({ tag: 'div', text: { tag: 'lark_md', content: text } });
      continue;
    }
    const title = String(part.title ?? '').trim();
    const lines = (part.lines || [])
      .map((segments) => joinLineSegments(segments, lineSeparator))
      .filter((line) => line.trim() !== '');
    // 空块**整块不要**（连它前面那条分割线也不出现）。
    if (!lines.length) continue;
    // 分割线只**夹在**两块之间：第一块之前没有，最后一块之后也没有。
    if (renderedBlocks > 0) elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: fill(sectionTitleTemplate, { title }) } });
    for (const line of lines) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: line } });
    }
    renderedBlocks += 1;
  }

  const footer = (footerLines || []).map((line) => String(line ?? '').trim()).filter(Boolean);
  if (footer.length) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: footer.join('\n') }] });
  }

  const result = {
    // ⚠️ 不 patch 的卡片**刻意不带** `update_multi`（理由见文件头）。
    config: { wide_screen_mode: true },
    elements,
  };
  if (String(header ?? '').trim()) {
    // 标题在最前面（飞书卡片 header 永远在 elements 之上）。
    result.header = { template: headerColor, title: { tag: 'plain_text', content: String(header) } };
  }
  return result;
};

// 「这张卡片里她看得见的字」（含标题）——把标记壳去掉，供测试与排查用（渲染层不加，只在测试里拼）。
// ⚠️ 放在本文件是为了让"卡片长什么样"只有一处定义；它不做业务判断。
const visibleCardText = (card) => {
  const header = String(card?.header?.title?.content || '').trim();
  const elements = (card?.elements || []).map((element) => {
    if (element.tag === 'note') {
      return String((element.elements || []).map((piece) => piece.content || '').join('\n'));
    }
    if (element.tag !== 'div') return '';
    return String(element.text?.content || '')
      .replace(/<\/?text_tag[^>]*>/g, '')
      .replace(/<\/?font[^>]*>/g, '')
      .replace(/\*\*/g, '')
      // 文字链接 → 「文案 URL」：纯文本降级里就是这个形状，比对时两边可逐字对齐。
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2');
  });
  return [header, ...elements].filter((line) => String(line).trim() !== '').join('\n');
};

module.exports = { pendingDealPushCard, visibleCardText, joinLineSegments };
