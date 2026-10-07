// 卡片上的按钮动作名从配置读：卡片和分派共用同一份常量，不会各写一份而慢慢写歪。
// （config 里只有纯常量，不 require 任何 service，所以不会形成循环依赖。）
const { ARRIVAL_CONVERSATION_ACTIONS } = require('../config/arrivalConversation');
// 「补货品信息」那一段的文案与上限（配置先行；取值规则同 config/envValue）。
const { resolveProductInfoGapsConfig } = require('../config/productInfoGaps');

const text = (value) => String(value ?? '').replace(/\n/g, ' ');

// ⭐ 会被 `im.v1.message.patch` 更新的卡片，config 一律从这里出（**唯一组装点**）。
//
// 为什么必须带 `update_multi: true`（这不是"顺手加的字段"，是 patch 能不能被看见的硬前提）：
//   飞书官方文档 `im-v1/message/patch`：
//     · 「你需在更新**前后**卡片的 `config` 属性中，均显式声明 `"update_multi":true`
//        （表示卡片为共享卡片，卡片的更新对所有接收的用户可见）」；
//     · 「不支持更新仅特定人可见的卡片」。
//   `card-configuration`：「`update_multi`：true=共享卡片…；false=独享卡片，
//    **仅操作用户可见卡片的更新内容**；**默认 false**」。
//   ⇒ 生产现象正是它：后端 patch **成功**（`lark.sales.card.update.succeeded`），
//     卡片发在群里、她不是"操作用户"，于是**界面上纹丝不动**（她原话：「我点了，
//     只是有个toast，卡片还是没有反应！」）。**"更新前"（首次发出的那份 builder 输出）
//     也必须带**，所以是渲染卡片的每个 builder 都要带，而不是只在 patch 时补。
//
// 为什么是**工厂函数**而不是共享的冻结常量 `Object.freeze({...})`：
//   共享常量会让 14 张卡**共用同一个对象引用** —— 将来某张卡要单独调 `card.config` 时，
//   改动会**串到所有卡片上**；而在非严格模式下对冻结属性赋值**既改不动、也不报错**，
//   是最难查的那种静默失效。工厂函数让每张卡拿到**自己的一份**，
//   "每张卡各自独立"成为语义；字段清单（`wide_screen_mode` + `update_multi`）
//   仍然只有这一处定义，DRY 不丢。
//
// ⚠️ 不走 patch 的卡片（`saleLookupCard` / `purchaseRequestConfirmationCard` /
//    `utils/salesDailyReportCard.js`）**刻意不带**这个字段 —— 它们只发不改。
const patchableCardConfig = () => ({ wide_screen_mode: true, update_multi: true });

// 明细行只写她需要核对的事实：货号、尺码、数量、金额、赠品。
//
// 库存分布**刻意不写在这里**：实时库存是录单时读的，只用来判断"这一双有没有货、
// 卖的是不是样品"。有货就不需要她看库存数字——那是噪音；只有她说了一个没有的尺码，
// 才回一句"这个货号现在有哪几个尺码"（见 larkMvpService 的没货追问）。
// `showAmount` 默认 true（结果卡片照旧逐件显示金额）。
// 销售确认卡片传 false：产品负责人用真实卡片在手机上实测确认的 V3 排版里，
// **一单只有一件时不显示这一件的金额**——它和下一行的「成交总额」完全重复，写两遍反而看不清重点。
// ⚠️ 例外（业务决定，不要"顺手统一"）：**一单超过一件时必须逐件显示金额**。
// 多件时她要在确认前逐件核对金额，不显示就会记错账。这个判断在 salesConfirmationCard 里。
const itemLines = (items, priceKey, options = {}) => {
  const showAmount = options.showAmount !== false;
  return (items || [])
    .map((item, index) => {
      // 配品没有货号，显示它自己的名称。
      const product = item.product_number || item.productNumber || item.item_no || item.itemNo
        || item.accessory_name || '未知货品';
      const price = showAmount ? (item[priceKey] ?? item.unitPrice ?? item.unitCost) : null;
      const gift = item.gift ? `\n   赠品：${text(item.gift_description || '有')}` : '';
      return `${index + 1}. ${text(product)} ${text(item.size)}码 × ${text(item.quantity || 1)}${price ? ` ￥${price}` : ''}${gift}`;
    })
    .join('\n');
};

/**
 * 采购明细的层级：供应商（可选）→ **货号** → **颜色** → 尺码网格。
 *
 * 产品负责人（2026-10-05）要求的三层结构：先按货号分组，同一货号下再按颜色分组，
 * 颜色下面是各尺码。货号做粗体一级标题，颜色做次级标题，尺码网格跟在颜色下面。
 *
 * 每一层的顺序都按**字典序**排（compareGroupLabel），保证同一份明细每次渲染的位置一致——
 * 不能依赖模型的返回顺序，否则重试一次卡片上的分组就跳一次位。
 */

// ⚠️ 每行 6 个尺码，而且**每一行都恰好 6 列**（最后一行不足时补空列）。
// 6 是产品负责人给的下限（"每行至少放 6 个"）。补空列不是装饰：
// column_set 把当行宽度按实际列数均分，不补齐的话最后一行的格子会比上面宽一截，
// 手机上看起来就是两套网格、对不齐。这是移动端排版，别"优化"掉。
const SIZE_GRID_COLUMNS = 6;

// 单元格最多 6 个字符。尺码格是 6 列并排，手机上单格宽度很有限：
// ⚠️ 移动端实测结论（产品负责人在手机上逐一核对过），写回 `37码 × 1` 这种一行长文本
// 会把格子撑到换行、网格变形；改成 `37` + `×1` 两行短文本在 6 列下不挤。别改回长写法。
const SIZE_CELL_MAX_CHARS = 6;

const truncateCellText = (value, max = SIZE_CELL_MAX_CHARS) => {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
};

/**
 * 尺码格内容：只放"核对这一格"必须看的两件事——尺码、数量。
 * 价格只在识别到的时候补一行小字（到货单不一定有价格列）。
 * 未匹配只留一个 ⚠：`（未匹配）` 在 6 列下必然换行；
 * 具体哪些货品没匹配上，卡片下方「未匹配货品」那一段才是权威说明。
 */
const sizeCellContent = (item) => {
  const lines = [`**${truncateCellText(item.size, 3)}**`, `×${truncateCellText(item.quantity || 1, 3)}`];
  if (item.unit_cost) lines.push(`￥${truncateCellText(item.unit_cost, 5)}`);
  if (item.match_error) lines.push('⚠');
  return lines.join('\n');
};

const sizeColumn = (content) => ({
  tag: 'column',
  width: 'weighted',
  weight: 1,
  vertical_align: 'center',
  elements: [{ tag: 'markdown', content, text_align: 'center' }],
});

// 尺码从小到大，每 6 个一行。行内不足 6 个时补空列（理由见 SIZE_GRID_COLUMNS 注释）。
const sizeGridElements = (items) => {
  const sorted = [...items].sort((a, b) => Number(a.size) - Number(b.size));
  const elements = [];
  for (let i = 0; i < sorted.length; i += SIZE_GRID_COLUMNS) {
    const rowItems = sorted.slice(i, i + SIZE_GRID_COLUMNS);
    const columns = rowItems.map((item) => sizeColumn(sizeCellContent(item)));
    while (columns.length < SIZE_GRID_COLUMNS) columns.push(sizeColumn(' '));
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'grey',
      horizontal_spacing: 'default',
      columns,
    });
  }
  return elements;
};

// 分组排序用字典序（UTF-16 码点序），刻意**不用** localeCompare：
// 后者的结果依赖运行环境的 ICU 版本，本地和服务器可能给出不同顺序，
// 那正是"每次渲染顺序乱跳"的来源。码点序在所有环境里都一致。
const compareGroupLabel = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 供应商内部的二层分组：货号 → 颜色，各自按字典序稳定排序。
 *
 * 货号取 item_no（产品负责人说的"货号"）；历史/识别数据缺货号时退回 product_number，
 * 两者都没有才写「未知货号」——不编一个看起来像货号的值出来。
 */
const groupByItemNoAndColor = (items) => {
  const byItemNo = new Map();
  for (const item of items) {
    const itemNo = text(item.item_no || item.product_number || '未知货号');
    if (!byItemNo.has(itemNo)) byItemNo.set(itemNo, new Map());
    const byColor = byItemNo.get(itemNo);
    const color = text(item.color);
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push(item);
  }
  return [...byItemNo.entries()]
    .sort((a, b) => compareGroupLabel(a[0], b[0]))
    .map(([itemNo, byColor]) => {
      const rows = [...byColor.values()].flat();
      return {
        itemNo,
        // 只要有一条匹配上货品表，这个货号就算匹配上（未被匹配的标 ⚠️，与旧卡片一致）。
        matched: rows.some((item) => item.product_record_id),
        // 新品是**货号级**判断（产品负责人 2026-10-05：新品按货号看，不细到颜色）：
        // 同一货号下只要有一行是新品，这个货号就标一次 🆕，多行不重复标。
        // 数据直接用明细里早就有的 created_product——匹配阶段就知道货品表里没有这个
        // 货号+颜色（见 purchaseWebhookService 的 pending_creation），渲染时不额外查库。
        hasNew: rows.some((item) => item.created_product === true),
        colors: [...byColor.entries()]
          .sort((a, b) => compareGroupLabel(a[0], b[0]))
          .map(([color, colorItems]) => ({ color, items: colorItems })),
      };
    });
};

/**
 * 采购商品明细 - 网格布局。
 * 层级：供应商（skipSupplierGroup 时跳过）→ 货号 → 颜色 → 尺码网格（每行 6 个）。
 * 返回飞书卡片元素数组。
 *
 * ⚠️ 尺码网格必须是 `column_set`（每列 width: 'weighted' / weight: 1），不能用 `action`：
 * 苹果/安卓飞书客户端上 `action` 里的元素会**竖向堆叠**，只有 column_set 才是真正的一行多列
 * （同 buttonColumns 的注释，是移动端实测结论）。尺码是纯文字，但排版约束和按钮一样。
 */
const purchaseItemElements = (items, options = {}) => {
  if (!items?.length) return [{ tag: 'markdown', content: '未识别到商品' }];
  const skipSupplierGroup = options.skipSupplierGroup === true;

  // 第一层：按供应商分组（批量模式跳过，直接归到一组）
  const bySupplier = new Map();
  for (const item of items) {
    const supplier = skipSupplierGroup ? '__batch__' : (item.supplier || '待补充供应商');
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
    bySupplier.get(supplier).push(item);
  }

  const elements = [];
  let isFirstSupplier = true;
  let isFirstProduct = true;

  for (const [supplier, supplierItems] of bySupplier) {
    if (!skipSupplierGroup) {
      // 供应商之间用一条 hr 分隔：这个 hr 由**下一个**供应商标题负责，
      // 不在段落末尾再补一条（旧代码那样会连出两条 hr）。
      if (!isFirstSupplier) elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: `**━━━ 供应商：${text(supplier)} ━━━**` });
      isFirstSupplier = false;
    }

    for (const product of groupByItemNoAndColor(supplierItems)) {
      if (!isFirstProduct) elements.push({ tag: 'hr' });
      isFirstProduct = false;

      // 货号：一级标题（粗体）。
      //
      // 🆕 新品标在**货号**上（产品负责人 2026-10-05：新品按货号级别判断，不细到颜色），
      // 同一货号多行只标一次（hasNew 已经按货号聚合过）。
      // ⚠️ 2026-10-05：原先这里写的是"新品发卡片时还没建档（见 purchaseWebhookService.processArrival）"。
      // 那条链路与它的卡片已整体退场；这段渲染规则保留下来（采购申请卡片仍在用同一套渲染器），
      // 只是现在没有任何卡片会带 created_product 的明细（数据字段与规则原样留着，将来要用时不必重写）。
      // 没有 product_record_id 的行仍然给 🏷 而不是 ⚠️：⚠️ 只留给"货品表里找不到、也不会入库"的行。
      const marked = product.matched || product.hasNew;
      elements.push({
        tag: 'markdown',
        content: `**${marked ? '🏷' : '⚠️'} ${text(product.itemNo)}${product.hasNew ? ' · 🆕 新品' : ''}**`,
      });

      for (const group of product.colors) {
        // 颜色：次级标题。只有单据上真的有颜色才写这一行；没颜色就不编一个"未标注"。
        if (group.color) elements.push({ tag: 'markdown', content: `▸ ${text(group.color)}` });
        elements.push(...sizeGridElements(group.items));
      }
    }
  }

  return elements;
};

const actionButton = (label, action, draftId, type = 'default', extra = {}) => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type,
  value: { action, draft_id: draftId, ...extra },
});

// ⚠️ 移动端实测的结果，不要改回 `{ tag: 'action', actions: [...] }`。
//
// 现象：`action` 元素在 PC 上是一行三列，在**手机上每个按钮各占一行**（用户真实截图确认，
// 门店主要用手机）。产品负责人拿 4 种排版在手机上逐一试过，只有下面这种
// `column_set`（flex_mode: 'none' + 每列 weight: 1）在手机上也是一行多列。
// 谁把它改回 action，手机端就会重新堆成多行。
const buttonColumns = (buttons) => ({
  tag: 'column_set',
  flex_mode: 'none',
  horizontal_spacing: '8px',
  columns: buttons.map((button) => ({
    tag: 'column',
    width: 'weighted',
    weight: 1,
    elements: [button],
  })),
});

// 手机一行的宽度最多放得下 3 个按钮（同样是真机实测）。
// 颜色、补样品这类候选按钮数量不定（2~6 个），超过 3 个就必须另起一个 column_set：
// column_set 之间是纵向排列的，所以"每 3 个一个 column_set、连续排布"就是"每行最多 3 个"。
const MAX_BUTTONS_PER_ROW = 3;
const buttonRows = (buttons) => {
  const rows = [];
  for (let index = 0; index < buttons.length; index += MAX_BUTTONS_PER_ROW) {
    rows.push(buttonColumns(buttons.slice(index, index + MAX_BUTTONS_PER_ROW)));
  }
  return rows;
};

// 重试卡片要"只留继续处理这一单的那一个按钮"。
// 卡片按钮从 `action` 换成 `column_set` 之后（原因见 buttonColumns 的注释），
// 调用方不能再按 `element.tag === 'action'` 去找按钮；这里按新结构遍历，
// 规则和以前完全一致：**只有"包含目标按钮的那一组"会被收窄**，
// 颜色/补样品这类不含目标按钮的选择组原样保留。
const keepOnlyCardButton = (card, action) => {
  const matches = (child) => child.tag === 'button' && child.value?.action === action;
  for (const element of card.elements || []) {
    if (element.tag === 'action') {
      const sameAction = element.actions.filter(matches);
      if (sameAction.length) element.actions = sameAction;
      continue;
    }
    if (element.tag === 'column_set') {
      const buttons = (element.columns || [])
        .flatMap((column) => column.elements || [])
        .filter((child) => child.tag === 'button');
      if (!buttons.some(matches)) continue;
      element.columns = element.columns
        .map((column) => ({ ...column,
          elements: column.elements.filter((child) => child.tag !== 'button' || matches(child)) }))
        .filter((column) => column.elements.length);
    }
  }
  return card;
};

// 颜色待选的明细：每双一组按钮。
// 提示行用 note（最小字）：V3 的层级里它排在明细/成交大字之下；候选颜色由按钮表达——
// 再把颜色名列一遍就是跟按钮重复了。
// 已经确定颜色的明细（单色货号、或用户说对了）不出按钮，只在上面的明细行里显示。
const salesColorPickers = (draftId, draft) => {
  const elements = [];
  (draft.items || []).forEach((item, index) => {
    const options = item.color_options || [];
    if (!item.needs_color || !options.length) return;
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `第 ${index + 1} 双请选择颜色`, text_size: 'note' },
    });
    // 颜色可能有 2~6 个：超过 3 个就折成多个 column_set（手机一行最多放 3 个，真机实测）。
    elements.push(...buttonRows(options.map((option) => actionButton(option.color || '未命名颜色',
      'choose_sale_color', draftId, 'primary', { item_index: index, record_id: option.recordId,
        product_number: option.number, color_name: option.color }))));
  });
  return elements;
};

// 卖的是样品时：告诉她这一双卖掉要补一个门盒，并**在这张卡片上就选完**。
// 合并进确认卡片的原因：否则她点完确认，还要再收一张卡、再点一次——
// 而"卖样品要补哪个门盒"这件事，出卡片时就已经能算出来了（实时库存已经读过）。
const salesSampleReplacementPicker = (draftId, draft) => {
  const elements = [];
  (draft.items || []).forEach((item, index) => {
    if (!item.uses_sample) return;
    const label = text(item.product_number || item.item_no || '这一双');
    const options = item.sample_replacement_options || [];
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `第 ${index + 1} 双是样品，卖掉后要补一个门盒（${label}）\n` +
          (options.length ? '请选一个门盒来补样品：' : '同货号的门盒已经没有余量，需要另行调拨。'),
        // V3：这类提示是 note（最小字），层级低于明细/成交大字。
        text_size: 'note',
      },
    });
    if (options.length) {
      // 门盒尺码数量不定，超过 3 个就折成多个 column_set（手机一行最多放 3 个，真机实测）。
      elements.push(...buttonRows(options.map((row) => actionButton(
        item.sample_replacement_size === row.size ? `已选 ${row.size}码` : `选 ${row.size}码`,
        'choose_sale_sample_replacement', draftId,
        item.sample_replacement_size === row.size ? 'primary' : 'default',
        { item_index: index, size: row.size },
      ))));
    }
  });
  return elements;
};

// 交易类型是脚本按注册表从 AI 识别的性质推出来的，卡片只**展示**，不再让用户选。
// 确认这个动作的含义因此变得单一：她核对的是"AI 听对了没有"，不是替系统决定交付方式。
const tradeTypeLine = (draft) => {
  const label = text(draft?.trade_type || '').trim();
  const delivery = text(draft?.delivery_status || '').trim();
  if (!label) return delivery || '—';
  return delivery ? `${label} · ${delivery}` : label;
};

// 第三区：货品资料不全时，把"还差哪几项"和记录链接放进**点确认之后的【终态卡】**。
//
// ⭐ 2026-10-07（业务负责人拍板，逐字）：「我们的卡片能够实时更新，更新完之后，
//   用户要补的链接其实就看不到了。所以我们在销售信息确认卡片里不需要放这个信息；
//   等用户点击确认之后，卡片不是会更新吗？更新时再补这个信息。」
//   ⇒ 这一段**不在**确认卡片上（`salesConfirmationCard`），**只在**
//     `salesStatusCard` 的**已入账终态卡**上（会长期留着，是她补资料的入口）。
//   ⚠️ 位置变了，**文案与行格式一个字不改**；文案在 `config/productInfoGaps`，本函数只排布。
//
// 🔴 2026-10-07 她的**最终口径**（先把位置说成"两边都放"，随后明确**纠正**，逐字）：
//   「**不是，是只放在2上！**」
//   她给两张卡的编号：① =「销售订单处理中」卡（点确认后 0.3 秒出现、只停留 1~2 分钟）；
//   ② = 绿色「销售订单已入账」终态卡（长期留着）。**她只要 ② 有。**
//   ⇒ ① 也就是 `salesProcessingCard`，**刻意不再挂这一段**：
//     它 1~2 分钟后照样被终态卡 patch 覆盖，链接一样会消失 —— 那正是她要解决的问题；
//     把它放在一张"很快就没了"的卡上等于没放。
//   ⚠️ 这条是**收窄**（`salesProcessingCard` 里**不许**再出现本函数），不是"两边都放"。
//
// 为什么放在卡片里而不是另发一条消息：她本来就在看这张卡片，顺手就能点去补；
// 另发一条消息只会多一次打扰，也容易漏看。
//
// 「信息是否齐备」是飞书公式，缺哪项它就写哪项（单一数据源在表里）；
// 「样例图」是附件字段，公式管不到，所以在这里单独补上。
//
// 缺口为空 → 返回**空数组**（不留空壳）：没缺口的单子上不该多出一个空段落。
const productInfoGapsElements = (draft, config = resolveProductInfoGapsConfig()) => {
  const gaps = draft?.product_info_gaps || [];
  if (!gaps.length || config.maxLines <= 0) return [];
  const shown = gaps.slice(0, config.maxLines);
  const lines = shown.map((gap) => {
    const label = text(gap.label || gap.record_id);
    const lacks = [...(gap.missing || []),
      ...(gap.missing_sample_image ? [config.sampleImageLabel] : [])];
    return `${label} ${config.missingLabel}${lacks.map(text).join('、')}\n[${config.linkLabel}](${gap.url})`;
  });
  if (gaps.length > shown.length) {
    lines.push(config.overflowText.replace('{count}', String(gaps.length - shown.length)));
  }
  // V3（移动端实测确认）：这一块是 note（最小字、层级最低）——
  // 它是"要不要去补资料"的提醒，不是这一单的金额事实，不该跟明细/成交抢视线。
  return [{ tag: 'div',
    text: { tag: 'lark_md', content: `${config.title}\n${lines.join('\n')}`, text_size: 'note' } }];
};

// ⚠️ V3 排版（产品负责人用真实卡片在手机上实测确认），只改"长什么样"，不改任何金额/文案事实。
//
// 为什么必须换元素：飞书的 `markdown` 元素**不能自定义字号**，要做出"大字/小字"的层级，
// 只能用 `{ tag: 'div', text: { tag: 'lark_md', content, text_size } }`，
// text_size 取 'heading'（大字）/ 'normal' / 'note'（小字）；这一步已在用户真机上验证生效。
// 层级：明细行、成交/收款行、交易类型行 = heading；颜色/补样品选择 = note。
// ⚠️ 2026-10-07：「补货品信息」那块**已从确认卡片挪走**（改挂**已入账终态卡**，
//    见 `productInfoGapsElements` 的注释）——它仍是 note 小字，只是不在这一张上了。
// 成交/收款行与交易类型行**不加粗**（内容里不写 `**`）——大字本身已经是重点，
// 再加粗在手机上会糊成一团。
const salesConfirmationCard = (draftId, draft) => {
  const items = draft.items || [];
  const payments = draft.payments || [];
  const received = payments.filter((payment) => payment.status !== '待平台结算');
  const pendingSettlement = payments.filter((payment) => payment.status === '待平台结算');

  const moneyLines = [
    // V3：成交总额和本次已收并成一行，中间用「·」分隔，都是 heading 大字、都不加粗。
    `成交总额 ￥${text(draft.agreed_total)}　·　本次已收 ${received.length
      ? received.map((payment) => `${text(payment.method)} ￥${text(payment.amount)}`).join('；')
      : '尚未收款'}`,
  ];
  if (draft.voucher) {
    moneyLines.push(`团购券：￥${text(draft.voucher.purchase_price)} 抵 ￥${text(draft.voucher.face_value)}；平台预计结算 ￥${text(draft.voucher.settlement_amount)}`);
  }
  if (pendingSettlement.length) {
    moneyLines.push(`待平台结算：${pendingSettlement.map((payment) => `${text(payment.method)} ￥${text(payment.amount)}`).join('；')}`);
  }

  return {
    config: patchableCardConfig(),
    header: { template: 'blue', title: { tag: 'plain_text', content: '请确认销售订单' } },
    elements: [
      {
        tag: 'div',
        // 单件不显示金额、多件必须逐件显示金额（业务决定，理由见 itemLines 的注释）。
        text: { tag: 'lark_md', content: itemLines(items, 'actual_amount', { showAmount: items.length > 1 }),
          text_size: 'heading' },
      },
      { tag: 'div', text: { tag: 'lark_md', content: moneyLines.join('\n'), text_size: 'heading' } },
      { tag: 'div',
        text: { tag: 'lark_md', content: `交易类型：${tradeTypeLine(draft)}`, text_size: 'heading' } },
      ...salesColorPickers(draftId, draft),
      ...salesSampleReplacementPicker(draftId, draft),
      // ⚠️ 这里**刻意没有** `productInfoGapsElements(draft)`：
      //   这张卡会被点确认后的 patch 覆盖，放这里等于"她永远看不到补资料的链接"。
      //   2026-10-07 起该段落只挂在**已入账终态卡**上（见 `productInfoGapsElements`）。
      //   三个按钮走 column_set：移动端实测一行三列（见 buttonColumns 的注释）。
      buttonColumns([
        actionButton('确认', 'confirm_sale', draftId, 'primary'),
        actionButton('修改', 'modify_sale', draftId),
        actionButton('取消', 'cancel', draftId, 'danger'),
      ]),
    ],
  };
};

// ⭐ 2026-10-07：这张通用结果卡多了一个**可选**开关 `options.productInfoGaps`（默认关）。
//
//   为什么是**可选开关**、而不是"有缺口就自动带上"：这张渲染器同时服务
//   取消 / 待修正 / 已入账 / 部分交付 / 交付失败 / 重复终态 **六个分支**。
//   只有"**这单已经入账、卡片会长期留着**"的分支才该带补货品信息段落
//   （取消 / 待修正 = 原草稿不会入账 ⇒ 不带）。默认关 ⇒
//   没显式打开的调用点，输出与改动前**逐字节相同**（既有 deepEqual 断言就是这条的哨兵）。
//
// ⚠️ 2026-10-07 收窄（业务负责人逐字：「**不是，是只放在2上！**」）：
//   **这里是这一段唯一的出现位置** —— 处理中卡（`salesProcessingCard`）**刻意不带**
//   （见 `productInfoGapsElements` 的注释）。
const salesStatusCard = (draft, title, message, template = 'blue', options = {}) => ({
  config: patchableCardConfig(),
  header: { template, title: { tag: 'plain_text', content: title } },
  elements: [
    { tag: 'markdown', content: itemLines(draft?.items || [], 'actual_amount') || '销售订单' },
    ...(options.productInfoGaps ? productInfoGapsElements(draft) : []),
    { tag: 'note', elements: [{ tag: 'plain_text', content: message }] },
  ],
});

// ⭐ 2026-10-07「点了确认必须一眼看得出来」的**专用**渲染（业务负责人拍板的 ⓐ 方案）。
//
// 为什么另起一个函数、**不去改 `salesStatusCard`**：
//   `salesStatusCard` 是通用结果卡渲染器 —— 取消 / 待修正 / 部分交付 / 已入账 / 重复终态
//   全走它。在它里加"处理中样式"会让那些卡片的字节级输出**一起变**，
//   而她**明确满意**「已入账」那张终态卡（一个字都不许动）。
//   另起一个、只给确认链路那一次立即更新用 ⇒ 其余卡片的输出**可证不变**。
//
// 视觉上做两件事（她的目标：「不仔细看标题也能看出变了」）：
//   ① 明细区整段套 `<font color='…'>` **变灰** —— 颜色写法用仓库既有的那种
//      （`utils/salesDailyReportCard.js` 的 `<font color='grey'>`，`lark_md` 元素支持），
//      **不自己发明 HTML**；
//   ② 明细**上方**多一行醒目的「⏳ 正在写入…」提示（第一眼就能看到）。
//
// 文案 / 颜色**全部来自 `config/salesProcessingCard`**（配置先行）——本函数只排布，不写死字面量。
// 传空串 = 那一项不要（例：`progressLine: ''` 不出提示行、`itemColor: ''` 不套颜色）。
// 🔴 这里**刻意没有**「补货品信息」段落（业务负责人 2026-10-07 最终口径：
//    「**不是，是只放在2上！**」—— 2 = 已入账终态卡）。这一张只停留 1~2 分钟就被终态卡覆盖，
//    挂在这儿链接照样会消失 ⇒ 那一段只挂在 `salesStatusCard` 的已入账终态卡上，
//    见 `productInfoGapsElements` 的注释。**不要**在这里加回来。
const salesProcessingCard = (draft, { title, template = 'blue', itemColor, progressLine, note } = {}) => {
  const items = itemLines(draft?.items || [], 'actual_amount') || '销售订单';
  const elements = [];
  if (progressLine) elements.push({ tag: 'div', text: { tag: 'lark_md', content: progressLine } });
  elements.push({
    tag: 'div',
    text: { tag: 'lark_md', content: itemColor ? `<font color='${itemColor}'>${items}</font>` : items },
  });
  // 既有那句 note：**逐字保留**，结构与 `salesStatusCard` 一致（只是内容来自配置）。
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: note }] });
  return {
    config: patchableCardConfig(),
    header: { template, title: { tag: 'plain_text', content: title } },
    elements,
  };
};

const sampleReplacementCard = (taskId, { productNumber, remainingSizes = [], lookupFailed = false } = {}) => {
  const lines = remainingSizes.map((item) =>
    `${text(item.size)}码：门盒 ${text(item.doorBoxCount)}、样品 ${text(item.sampleCount)}、仓库 ${text(item.warehouseCount)}`);
  const choices = remainingSizes.filter((item) => item.doorBoxCount > 0);
  const elements = [{ tag: 'markdown', content:
    `**${text(productNumber || '该货品')} 的样品已售出。**\n请选择同货号现有门盒中的一个尺码补作样品；仓库鞋需另行调拨。\n${lines.join('\n') || (lookupFailed ? '可选尺码暂时无法读取，库存已扣减；请点击刷新重试。' : '目前没有剩余库存。')}` }];
  // 一行最多 3 个按钮（手机真机实测），超过就折成多个 column_set——以前是每行 4 个。
  elements.push(...buttonRows(choices.map((item) => ({
    ...actionButton(`选 ${text(item.size)} 码`, 'choose_sample_replacement', taskId),
    value: { action: 'choose_sample_replacement', draft_id: taskId, size: item.size },
  }))));
  // 单个按钮不存在换行问题，保持 action 元素原样。
  elements.push({ tag: 'action', actions: [actionButton('刷新可选尺码', 'refresh_sample_replacement', taskId)] });
  return { config: patchableCardConfig(),
    header: { template: 'orange', title: { tag: 'plain_text', content: '请补选展示样品' } }, elements };
};

const sampleReplacementStatusCard = (productNumber, message) => ({
  config: patchableCardConfig(),
  header: { template: 'green', title: { tag: 'plain_text', content: '样品已补选' } },
  elements: [{ tag: 'markdown', content: `${text(productNumber || '该货品')}：${text(message)}` }],
});

const sampleReplacementProcessingCard = (productNumber, message) => ({
  config: patchableCardConfig(),
  header: { template: 'blue', title: { tag: 'plain_text', content: '样品补选处理中' } },
  elements: [{ tag: 'markdown', content: `${text(productNumber || '该货品')}：${text(message)}` }],
});

// 🔴 2026-10-07「私聊链路移除」：`todaySalesCard`（机器人菜单「今日销售」那张卡）**已删除**。
//    它只有**私聊**一个入口（`larkMvpService.sendTodaySales` ← `application.bot.menu_v6` 菜单事件），
//    两者都已随私聊入口一起删掉；全仓再无调用方。
//    要看今日销售 → 飞书网页工作台「销售查询」。要用回来：`git log -S 'todaySalesCard'`。

/**
 * 「最近 N 天的销售记录」候选卡片（退换货第一期：只查 + 只展示）。
 *
 * ⚠️ 这张卡片**刻意没有任何按钮**：产品负责人明确要求本期卡片只展示、不做交互，
 * 她要用自然语言回「第 2 笔」。所以这里不引入 buttonColumns / actionButton；
 * 谁"顺手加个按钮"都违背需求（也违背本期"只读"的边界）。
 *
 * 字号：飞书的 `markdown` 元素不能自定义字号（详见 salesConfirmationCard 的注释），
 * 所以候选行用 `div` + `lark_md` + `text_size: 'heading'`——手机上这是正文大字。
 * 每行带序号（1/2/3），她说「第 2 笔」才对得上 task.pending_candidates 的下标。
 *
 * 0 条时不给"再试一次"的按钮，只把话说明白：没查到 + 给一条出路（问她大概哪天买的）。
 */
const saleLookupCard = ({ days, itemNo = '', color = '', candidates = [] } = {}) => {
  const label = `${text(itemNo)}${text(color)}`;
  const title = `最近 ${text(days)} 天的销售记录`;
  if (!candidates.length) {
    return {
      config: { wide_screen_mode: true },
      header: { template: 'orange', title: { tag: 'plain_text', content: title } },
      elements: [{
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${text(days)} 天内没查到 ${label} 的销售记录。\n你记得大概是哪天买的吗？`,
          text_size: 'heading',
        },
      }],
    };
  }
  const lines = candidates.map((candidate, index) => {
    const amount = candidate.actual_amount == null || candidate.actual_amount === ''
      ? '金额待录入'
      : `￥${text(candidate.actual_amount)}`;
    return `${index + 1}. ${text(candidate.date)} · ${text(candidate.item_no)}${text(candidate.color)}`
      + ` · ${text(candidate.size)}码 · ${amount}`;
  });
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: lines.join('\n'), text_size: 'heading' } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: candidates.length > 1
        ? `共 ${candidates.length} 笔。回我「第 2 笔」就能指到具体某一笔。`
        : '只有这 1 笔。' }] },
    ],
  };
};

const purchaseRequestConfirmationCard = (draftId, draft) => {
  const isBatch = draft.is_batch === true;
  const headerTitle = isBatch ? '请确认采购申请（批次）' : '请确认采购申请';
  const elements = [];
  if (isBatch) {
    elements.push({ tag: 'markdown', content: `**报货批次号：** ${text(draft.batch_no)}\n**明细数量：** ${text(draft.items?.length || 0)} 条` });
  }
  elements.push(...purchaseItemElements(draft.items || [], { skipSupplierGroup: isBatch }));
  // 两个按钮走 column_set：移动端实测一行两列（见 buttonColumns 的注释）。
  elements.push(buttonColumns([
    actionButton('确认生成采购申请', 'confirm_purchase_request', draftId, 'primary'),
    actionButton('取消', 'cancel_purchase_request', draftId, 'danger'),
  ]));
  return { config: { wide_screen_mode: true }, header: { template: 'orange', title: { tag: 'plain_text', content: headerTitle } }, elements };
};

// 原「采购到货差异确认卡片」（purchaseArrivalComparisonCard）已删除：产品负责人 2026-10-05
// 确认采购差异这块不用了（未来架构改成"到货在采购申请基础上修改"，不再比对差异），
// 对应的差异计算也一并移除，留着就是没人调用的死代码。
// 原「采购到货明细确认卡片」（purchaseArrivalDetailCard）与原「确认后的新品建档结果」
// （newProductResultElements）已删除：产品负责人 2026-10-05 删掉了「采购到货」表的
// 「类型」「识别状态」「识别失败原因」三个识别字段，并决定「拍照 → 识别 → 卡片确认」
// 这条链路整体退场（改成纯对话驱动）。没有识别结果要确认，也就没有这张卡片；
// 卡片上的两个动作 confirm_purchase_arrival / cancel_purchase_arrival 也一并从
// purchaseWebhookService 的 PURCHASE_CARD_ACTIONS 里摘掉了。
//
// ⚠️ 保留 purchaseStatusCard：报货链路（采购申请处理中/已生成/未完成）还在用它。

// ---------------------------------------------------------------------------
// 采购到货：群话题对话式核对的确认卡片
// ---------------------------------------------------------------------------
//
// 业务负责人 2026-10-06 的原话：「你就要发一个消息卡片，卡片里面要有「是」和「否」」。
// 所以这张卡片**两个按钮都要有**（不是只有「是」）。
// 卡片只是"她说了「完毕」之后的回执 + 触发点"：真正的入库要等她点「是」。
//
// `rounds` 是她说的原话（按时间顺序），`rows` 是按她的话算出来的**实际到货**明细
// （货号 / 颜色 / 尺码 / 实际双数）。卡片上把差异写清楚，她点「是」之前还能核对一遍。
// 文案从配置读（见 config/arrivalConversation.js），改文案不碰逻辑。
//
// ⭐ 2026-10-07 业务负责人纠正：「**如果这个尺码算下来为 0，那么就不用入库啊！**」
//   ⇒ `实际 = 0` 的行**不再是错误**：卡片上如实写「申请 N 双 → 实际 0 双（这双没到）」
//     （那句 `zeroActualNote` 可配），并在有 0 行时补一句 `zeroRowsNote` 说明它们不入库。
const arrivalReconcileLines = (rows = [], differences = [], copy = {}) => {
  // 差异说明按「货号+颜色+尺码」索引：同一行可能既有多又有少，逐条写出来。
  const diffByKey = new Map();
  for (const item of differences) {
    const key = `${text(item.item_no)}|${text(item.color)}|${Number(item.size)}`;
    if (!diffByKey.has(key)) diffByKey.set(key, []);
    diffByKey.get(key).push(item);
  }
  const zeroNote = text(copy.zeroActualNote) || '这双没到，不入库';
  return rows.map((row) => {
    const key = `${text(row.item_no)}|${text(row.color)}|${Number(row.size)}`;
    const diffs = diffByKey.get(key) || [];
    const actual = Number(row.actual);
    const head = `**${text(row.item_no) || '（未知货号）'}** ${text(row.color)} ${Number(row.size)} 码：申请 ${Number(row.quantity)} 双 → 实际 ${actual} 双`;
    // 0 双的行不写"实际比申请少 N 双"那句差异说明 —— 对她说的是"这双没到"，
    // 说了几句都一样的意思反而看不清（她要一眼看出"哪双没到"）。
    if (actual === 0) return `${head}（${zeroNote}）`;
    const parts = diffs.map((item) => {
      if (item.type === 'more') return `实际比申请多 ${item.quantity} 双`;
      if (item.type === 'less') return `实际比申请少 ${item.quantity} 双`;
      return '实际与申请一致';
    });
    const detail = parts.length ? parts.join('；') : '（未特别说明，按申请数）';
    return `${head}（${detail}）`;
  });
};

const purchaseArrivalReconcileCard = ({ taskId, batchNo = '', rows = [], differences = [], copy = {} } = {}) => {
  const elements = [];
  if (batchNo) elements.push({ tag: 'markdown', content: `**报货批次号：** ${text(batchNo)}` });
  elements.push({ tag: 'markdown', content: `**${text(copy.summaryHeading) || '按你说的实际到货'}**` });
  const lines = arrivalReconcileLines(rows, differences, copy);
  elements.push({ tag: 'markdown', content: lines.length ? lines.join('\n') : '（这批没有可核对的申请明细）' });
  // ⭐ 有 `实际 = 0` 的行时补一句说明（说清"这些行不入库"）—— 只在真的有 0 行时出现，
  //    没有 0 行的卡片与改动前逐字一致（既有断言不受影响）。
  if (rows.some((row) => Number(row.actual) === 0) && copy.zeroRowsNote) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: text(copy.zeroRowsNote) }] });
  }
  // 「是」「否」两个按钮走 column_set：手机上一行两列（见 buttonColumns 的注释）。
  elements.push(buttonColumns([
    actionButton(text(copy.confirmLabel) || '是', ARRIVAL_CONVERSATION_ACTIONS.CONFIRM, taskId, 'primary'),
    actionButton(text(copy.rejectLabel) || '否', ARRIVAL_CONVERSATION_ACTIONS.REJECT, taskId, 'default'),
  ]));
  if (copy.hint) elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: text(copy.hint) }] });
  return {
    config: patchableCardConfig(),
    header: { template: 'orange', title: { tag: 'plain_text', content: text(copy.title) || '本次到货核对完毕，确认入库吗？' } },
    elements,
  };
};

// 点完「是」/「否」之后把卡片改成终态：按钮收掉，只留一行说明
//（不给她在同一张卡上再点一次的机会；重复点击在后端仍然幂等）。
//
// ⚠️ 2026-10-07：终态**不只表示成功**。入库失败也必须把这张卡改成终态（`template: 'red'`）
//    —— 业务负责人连着两次反馈「卡片点击后也是没有任何反应」，根因就是失败时卡片不动。
//    所以这里多一个可配的 `title`（不传时与改动前逐字相同）。
const purchaseArrivalReconcileStatusCard = ({ batchNo = '', message = '', template = 'green', title = '' } = {}) => ({
  config: patchableCardConfig(),
  header: { template, title: { tag: 'plain_text', content: text(title) || '采购到货核对' } },
  elements: [
    ...(batchNo ? [{ tag: 'markdown', content: `**报货批次号：** ${text(batchNo)}` }] : []),
    { tag: 'note', elements: [{ tag: 'plain_text', content: text(message) }] },
  ],
});


// options.showNewProducts：原「采购到货确认」结果卡片用它挂新品建档链接。
// ⚠️ 到货卡片退场后已经没有任何调用方传它了（newProductResultElements 也已删除），
// 所以那个分支一并摘掉，不留一个永远为假的开关。
const purchaseStatusCard = (draft, title, message, template = 'blue', options = {}) => {
  const isBatch = draft?.is_batch === true;
  const elements = [];
  if (isBatch && draft?.batch_no) {
    elements.push({ tag: 'markdown', content: `**报货批次号：** ${text(draft.batch_no)}` });
  }
  elements.push(...purchaseItemElements(draft?.items || draft?.actual || [], { skipSupplierGroup: isBatch }));
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: message }] });
  return { config: patchableCardConfig(), header: { template, title: { tag: 'plain_text', content: title } }, elements };
};

// ---------------------------------------------------------------------------
// 退换货第二期：确认卡片 / 结果卡片 / 状态卡片
// ---------------------------------------------------------------------------
//
// ⚠️ 两张已踩过的坑（与 salesConfirmationCard 同一套结论，别"顺手统一"掉）：
//   ① 飞书的 `markdown` 元素**不能设字号**：要字号只能用
//      `{tag:'div', text:{tag:'lark_md', content, text_size:'heading'|'normal'|'note'}}`；
//   ② 一行多个按钮必须用 `column_set`（见 buttonColumns 的注释），
//      用 `action` 在手机上会竖排。
// 售后卡片**必须有按钮**：它要动账（写明细/收款/库存），"有副作用要人确认"是红线。

const yuanText = (value) => (value == null || value === '' ? '待录入' : `￥${text(value)}`);

// 她这一眼要核对的"处理的是哪一笔"：日期 · 货号颜色 · 尺码 · 金额。
const afterSalesOriginalLine = (candidate = {}) => [
  text(candidate.date) || '日期未知',
  `${text(candidate.item_no)}${text(candidate.color)}`.trim() || '货号未识别',
  candidate.size ? `${text(candidate.size)}码` : '尺码未识别',
  candidate.actual_amount == null || candidate.actual_amount === ''
    ? '金额待录入'
    : `￥${text(candidate.actual_amount)}`,
].join(' · ');

// 「钱怎么走」的两种走法在卡片上的说法（金额行 / 接线层追问的提示语都引用它，
// 同一件事不要在两处写成两种字）。执行器的编码契约在 config/afterSales.js。
const afterSalesSettlementLabels = Object.freeze({ cash: '退现金', prepaid: '存为预存额度' });
const afterSalesSettlementLabel = (settlement) =>
  afterSalesSettlementLabels[String(settlement ?? '').trim()] || '';

// 「钱怎么走」与「差价多少」分两行写：她说的是"钱先存着"（走哪条腿），
// 差价是金额事实；合成一行时金额容易被看漏，而这张卡片是要她核对金额的。
//
// ⚠️ 差价 ≠ 0 而没有 settlement 时**不能**写「不动钱」：钱确实要动，只是走向没解析出来。
// 写成"不动钱"会让她以为这一笔不动账，点确认后账上真的少一笔（静默的账目错）。
// 正常流程下这种卡片根本发不出去（接线层会直接抛错拦住这一笔，见 afterSalesFlowService），
// 这里只是"万一还有一张在途卡片"时的如实兜底。
const afterSalesMoneyLine = ({ settlement, diff_amount: diffAmount } = {}) => {
  const diff = Number(diffAmount);
  if (!Number.isFinite(diff) || diff === 0) return '不动钱';
  if (!settlement) return '还没定（回我一句：退现金 / 或先存着）';
  if (settlement === 'prepaid') {
    return diff < 0 ? afterSalesSettlementLabels.prepaid : '记入预存（她还欠）';
  }
  return diff < 0 ? afterSalesSettlementLabels.cash : '收现金';
};

const afterSalesDiffLine = ({ diff_amount: diffAmount } = {}) => {
  const diff = Number(diffAmount);
  if (!Number.isFinite(diff) || diff === 0) return '￥0';
  return `${yuanText(Math.abs(diff))}（${diff < 0 ? '退给她' : '她补'}）`;
};

// 退回的鞋放哪儿：她说了就按她说的写；没说就写默认值并注明可在下面改。
const afterSalesRestockLine = (plan = {}) => {
  if (!plan.requires_restock_state) return '不回库';
  const state = text(plan.restock_state) || '门盒';
  return plan.restock_state_explicit ? state : `${state}（默认，可在下面改）`;
};

const afterSalesActionLine = (plan = {}) => {
  const label = text(plan.action_label) || '售后';
  const lines = (plan.new_lines || []).map((line) => text(line.label)).filter(Boolean);
  return lines.length ? `${label}（换成 ${lines.join('、')}）` : label;
};

/**
 * 售后确认卡片。内容分四行大字（处理哪一笔 / 动作 / 钱 / 退回的鞋）+ 可选的回库状态按钮
 * + 确认/取消按钮。
 *
 * 回库状态只在动作需要时出现（退货、换货需要；赔货不回库，不给按钮）；
 * 她话里没说时默认值已经填好（默认原状态=门盒），所以**不点也能直接确认**，
 * 按钮只是给她一个"改一下"的出口。
 *
 * ⚠️ 钱怎么走与回库状态**规则相反**：钱没有默认值（业务红线），而且**不用卡片按钮**
 * （业务负责人 2026-10-05 纠正：「会说的，所以不用再有要卡片按钮的链路了」）。
 *   · 她说了 → 卡片上直接写她说的走向；
 *   · 差价 = 0（不动钱）→ 写「不动钱」；
 *   · **没有**"她没说钱"这条交互：她每句话都会说清钱怎么走，真没解析出来时接线层直接
 *     抛错拦住（不发这张卡片）。
 *   ⇒ 这张卡片上**没有资金选择按钮**，也不要再为它加任何"追问/选择"的入口。
 */
const afterSalesConfirmationCard = (taskId, plan = {}) => {
  const elements = [
    { tag: 'div', text: { tag: 'lark_md',
      content: `处理这一笔\n${afterSalesOriginalLine(plan.candidate)}`, text_size: 'heading' } },
    { tag: 'div', text: { tag: 'lark_md',
      content: `动作：${afterSalesActionLine(plan)}\n`
        + `钱：${afterSalesMoneyLine(plan)}\n`
        + `差价：${afterSalesDiffLine(plan)}\n`
        + `退回的鞋放：${afterSalesRestockLine(plan)}`, text_size: 'heading' } },
  ];
  if (plan.requires_restock_state) {
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: '退回的鞋放哪儿？', text_size: 'note' } });
    elements.push(buttonColumns(['门盒', '样品'].map((state) => actionButton(
      plan.restock_state === state ? `${state}（已选）` : state,
      'choose_after_sales_restock', taskId,
      plan.restock_state === state ? 'primary' : 'default', { state },
    ))));
  }
  // 出货货品在货品表里命中多条（男/女鞋常共用同一货号+颜色）：执行器取第一条继续，
  // 但这件事要**看得见**——不能悄悄替她决定换的是哪一条。
  if ((plan.new_lines || []).some((line) => Number(line.ambiguous_count || 0) > 1)) {
    elements.push({ tag: 'div', text: { tag: 'lark_md',
      content: '⚠️ 换的那双在货品表里匹配到多条，已取第一条，请核对', text_size: 'note' } });
  }
  elements.push(buttonColumns([
    actionButton('确认', 'confirm_after_sales', taskId, 'primary'),
    actionButton('取消', 'cancel_after_sales', taskId, 'danger'),
  ]));
  return { config: patchableCardConfig(),
    header: { template: 'orange', title: { tag: 'plain_text', content: '请确认售后' } }, elements };
};

// 库存流水的行为编码 → 人话（编码契约在 config/afterSales.js；这里只是展示文案）。
const AFTER_SALES_STOCK_LABELS = Object.freeze({
  SALE_RETURN: '退回入库',
  SALE_CASH: '新鞋出库',
  SALE_COMPENSATION: '赔货出库',
});

const afterSalesStockLines = (stock = []) => stock.map((row) => {
  const label = AFTER_SALES_STOCK_LABELS[row.behaviorCode] || text(row.behaviorCode);
  return `${label} ${text(row.state)} ×${text(row.quantity || 1)}`;
});

// 「已经写进去了什么」——她做完之后要能一眼核对：明细 / 钱 / 库存。
// 只写真写进去的：不动钱时不写"收款 0 笔"。
const afterSalesWrittenLines = (result = {}) => {
  const lines = [];
  const detailCount = (result.detailRecordIds || []).length;
  lines.push(`明细 ${detailCount} 条`);
  const money = result.money || {};
  if (money.route === 'cash') lines.push(`收款明细 1 笔（${text(money.direction)} ${yuanText(money.amount)}）`);
  else if (money.route === 'prepaid') lines.push(`客户往来货款 1 笔（${text(money.changeType)} ${yuanText(money.amount)}）`);
  else lines.push('没动钱');
  const stockLines = afterSalesStockLines(result.stock);
  lines.push(stockLines.length ? `库存：${stockLines.join('、')}` : '库存未变（配品不跟踪库存）');
  return lines;
};

const afterSalesResultCard = (plan = {}, result = {}) => ({
  config: patchableCardConfig(),
  header: { template: 'green', title: { tag: 'plain_text',
    content: `${text(plan.action_label) || '售后'}已完成` } },
  elements: [
    { tag: 'div', text: { tag: 'lark_md',
      content: `处理这一笔\n${afterSalesOriginalLine(plan.candidate)}`, text_size: 'heading' } },
    { tag: 'div', text: { tag: 'lark_md',
      content: `动作：${afterSalesActionLine(plan)}\n`
        + `钱：${afterSalesMoneyLine(plan)}\n`
        + `差价：${afterSalesDiffLine(plan)}\n`
        + `退回的鞋放：${afterSalesRestockLine(plan)}`, text_size: 'heading' } },
    { tag: 'div', text: { tag: 'lark_md',
      content: `已写入\n${afterSalesWrittenLines(result).join('\n')}`, text_size: 'normal' } },
  ],
});

// 失败卡片必须**明确说原因**（别静默），而且必须**保留可重试的按钮**：
// 如果失败后把卡片换成一张没有按钮的说明卡，我们让她"在原卡片重试"就成了空话——
// 按钮已经被自己换掉了。所以这里是"确认卡片 + 原因"：原因在最上面，确认/取消还在。
// 只承诺"同一笔不会重复写"，不承诺"什么都没写"（执行器可能已经写了部分记录）。
const afterSalesRetryCard = (taskId, plan = {}, reason) => {
  const card = afterSalesConfirmationCard(taskId, plan);
  card.header = { template: 'red', title: { tag: 'plain_text',
    content: `${text(plan.action_label) || '售后'}没做成` } };
  card.elements.splice(0, 0, { tag: 'div', text: { tag: 'lark_md',
    content: `原因：${text(reason) || '未知错误'}`, text_size: 'heading' } });
  card.elements.push({ tag: 'note', elements: [{ tag: 'plain_text',
    content: '核对后点「确认」重试；同一笔不会重复写。' }] });
  return card;
};

const afterSalesStatusCard = ({ title, message, template = 'blue' } = {}) => ({
  config: patchableCardConfig(),
  header: { template, title: { tag: 'plain_text', content: text(title) || '售后' } },
  elements: [{ tag: 'div', text: { tag: 'lark_md', content: text(message), text_size: 'heading' } }],
});

// ---------------------------------------------------------------------------
// 第二次交付：每日「成交」提醒卡片
// ---------------------------------------------------------------------------

// 这条链路的动作名。机器人侧按**销售单号 + 这个动作**分派
// （见 LarkMvpService.handleCardAction），不走"草稿"那条路。
const SECOND_DELIVERY_ACTION = 'confirm_second_delivery';

// 卡片上写给门店看的时间必须是上海时间（线上服务器是 UTC，直接取 ISO 会差 8 小时）。
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const shanghaiClock = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(11, 16);
};

const secondDeliveryOrderLines = (order = {}) => {
  const lines = [`${text(order.orderNo) || '（无单号）'}　·　${text(order.tradeTypeLabel) || '未付 / 预付'}`];
  const facts = [];
  if (Number(order.pendingAmount) > 0) facts.push(`未收 ${yuanText(order.pendingAmount)}`);
  if (Number(order.pendingDeliveryQuantity) > 0) {
    facts.push(`未交付 ${Number(order.pendingDeliveryQuantity)}/${Number(order.quantity) || 0} 双`);
  }
  // 钱货看着都齐了却还在候选里（进度没到「已完成」）：如实写"待核对"，不写一个像成功的说法。
  if (!facts.length) facts.push('待核对');
  lines.push(facts.join('　·　'));
  return lines.join('\n');
};

/**
 * 每日成交提醒卡片：列未付 / 预付且尚未完成履约的单，每单下面一行「成交」按钮。
 *
 * 为什么按钮上要带收款方式（业务规则只说"带「成交」按钮"）：
 * 补收款必须写明这笔钱是怎么收的——「交易方式」是关联字段，
 * collectPendingReceipt 拿不到方式会直接报错；工作台那条路也是让人在表单里选。
 * 群里只有一次点击，所以把收款方式放进按钮取值：点「成交·微信」就是"这笔记微信收到"。
 * 换成不带方式的单个「成交」按钮，后端只能替她猜一个收款方式写进账里，
 * 那是**写错业务事实**，比多点一个带方式的按钮严重得多。
 * 只配了一种收款方式时按钮就只写「成交」（没有第二种可选，不必重复写方式）。
 *
 * `actionButton` 的第三个参数是 draft_id：这里传空串，是为了让这条链路在机器人侧
 * 落到"按销售单号分派"那一支，而不是被当成某个销售草稿的卡片。
 *
 * `dayKey` 会写进按钮取值（`reminder_day`）：点完之后要拿"当初发出去的那张卡"来改成
 * 「已成交」，而卡片是跟着当天的认领记录落盘的，得靠这个日期键把它取回来（见
 * SecondDeliveryService.markCardSettled）。
 */
const secondDeliveryCard = ({ orders = [], methods = [], dayKey = '' } = {}) => {
  const elements = [];
  orders.forEach((order) => {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: secondDeliveryOrderLines(order), text_size: 'heading' },
    });
    elements.push(...buttonRows(methods.map((method) => actionButton(
      methods.length === 1 ? '成交' : `成交·${method}`, SECOND_DELIVERY_ACTION, '',
      'primary', { sales_entry_record_id: order.salesEntryRecordId, method, reminder_day: dayKey },
    ))));
  });
  return {
    config: patchableCardConfig(),
    header: { template: 'blue', title: { tag: 'plain_text', content: '待成交：未付 / 预付' } },
    elements: elements.length
      ? elements
      : [{ tag: 'div', text: { tag: 'lark_md', content: '今天没有待成交的单', text_size: 'heading' } }],
  };
};

// 「已成交」那一行灰字。为什么是"换掉按钮"而不是"禁用按钮"：
// 飞书卡片按钮**没有 disabled 参数**，唯一能表达"这里点不了了"的办法，
// 就是让那个位置不再有按钮、只剩一句说明。
const secondDeliverySettledElement = ({ settledAt } = {}) => {
  const clock = shanghaiClock(settledAt || Date.now());
  return {
    tag: 'div',
    text: { tag: 'lark_md', content: `✅ 已成交${clock ? `（${clock} 点击）` : ''}`, text_size: 'note' },
  };
};

/**
 * 把「已成交」那一单的按钮整段换成上面那行灰字，**卡片其余内容一个字都不动**
 * （别的单的明细行和按钮原样保留——一张卡里可能有好几单，点掉一单不能连累其他单）。
 *
 * patch 是整张卡替换，所以调用方必须拿"当初发出去的那张卡"进来改（见
 * SecondDeliveryService.markCardSettled），不能在这里重新渲染一张——重渲染会把
 * 期间已经变化的单也一起改掉。
 *
 * 返回 null 表示这张卡里没有这一单的按钮（卡片不是这张 / 已经换过了），
 * 调用方据此跳过 patch：不要拿一张没变的卡去打一次无意义的 patch。
 */
const settleSecondDeliveryOrder = (card, { salesEntryRecordId, settledAt } = {}) => {
  const target = String(salesEntryRecordId || '');
  if (!card || !target) return null;
  const next = JSON.parse(JSON.stringify(card));
  const elements = [];
  let replaced = false;
  for (const element of next.elements || []) {
    // 按 column_set/action 结构找按钮，规则与 keepOnlyCardButton 一致。
    const buttons = element.tag === 'column_set'
      ? (element.columns || []).flatMap((column) => column.elements || [])
        .filter((child) => child.tag === 'button')
      : [];
    const belongsToOrder = buttons.some((button) => button.value?.action === SECOND_DELIVERY_ACTION &&
      String(button.value?.sales_entry_record_id || '') === target);
    if (!belongsToOrder) {
      elements.push(element);
      continue;
    }
    // 收款方式超过 3 个时这一单有多行按钮：只在第一行的位置放一行灰字，其余整行丢掉。
    if (!replaced) {
      elements.push(secondDeliverySettledElement({ settledAt }));
      replaced = true;
    }
  }
  if (!replaced) return null;
  next.elements = elements;
  return next;
};

module.exports = {
  // 重试卡片收窄按钮用（按 column_set/action 结构遍历，见 keepOnlyCardButton）。
  keepOnlyCardButton,
  purchaseRequestConfirmationCard,
  purchaseStatusCard,
  // 「采购到货：群话题对话式核对」的确认卡片（是 / 否）与终态卡片。
  purchaseArrivalReconcileCard,
  purchaseArrivalReconcileStatusCard,
  salesConfirmationCard,
  salesStatusCard,
  // 「补货品信息」那一段（2026-10-07 从确认卡片挪到**已入账终态卡**；导出是为了单独测配置）。
  // ⚠️ 现在生产调用点只剩 `salesStatusCard` 一处 —— **仍然保持可复用**（带 config 形参，
  //   将来别处要用直接接；见函数注释）。**不要**因为它"只有一个调用点"就改签名或内联。
  productInfoGapsElements,
  // 「点确认后立刻看得出变了」那张（只给确认链路那一次立即更新用，见函数注释）。
  salesProcessingCard,
  sampleReplacementCard,
  sampleReplacementStatusCard,
  sampleReplacementProcessingCard,
  saleLookupCard,
  afterSalesConfirmationCard,
  afterSalesResultCard,
  afterSalesRetryCard,
  afterSalesStatusCard,
  // 「退现金 / 存为预存额度」这两个说法只有一处定义（接线层回的那句追问也用它）。
  afterSalesSettlementLabel,
  secondDeliveryCard,
  // 「成交」点完之后把那一单的按钮换成灰字说明（只在成交成功后调，见 secondDeliveryService）。
  settleSecondDeliveryOrder,
  SECOND_DELIVERY_ACTION,
};
