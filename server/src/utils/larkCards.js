// 飞书交互卡片的**渲染器**（本文件只排布，不写死业务中文；文案在各自的 config 里）。
//
// ⭐ 2026-10-28（群卡片残留清理）：本文件只保留**仍在生产使用**的 3 张卡 ——
//   · `purchaseStatusCard`          —— 报货链路（采购申请处理中 / 已生成 / 未完成）；
//   · `purchaseArrivalReconcileStatusCard` —— 到货验收的终态卡片（工作台 + 扫码验收在用）；
//   · `sampleReplacementCard`       —— 「样品已售出 → 请补选」提醒（工作台补样品链路在用）。
//
// ⛔ 本轮删除的（都只服务**已退场的交互卡片链路**，全仓已无调用方）：
//   · 销售终态卡 `salesStatusCard` 与它的【确认成交】按钮 / 补货品信息段落
//     （`confirmDealElements` / `confirmDealSettledElement` / `productInfoGapsElements`）；
//   · 销售草稿卡残留件（`salesColorPickers` / `salesSampleReplacementPicker` /
//     `salesCardFactElements` / `itemLines` / `itemSizeSegment`）；
//   · 「每日成交提醒卡」（`secondDeliveryCard` / `settleSecondDeliveryOrder` /
//     `SECOND_DELIVERY_ACTION` / `secondDeliveryOrderLines` / `shanghaiClock` / `yuanText`）；
//   · 补样品卡片的**按钮回执**两张（`sampleReplacementStatusCard` / `sampleReplacementProcessingCard`）；
//   · 群话题到货核对卡（`purchaseArrivalReconcileCard` / `arrivalReconcileLines`）；
//   · 通用收窄工具 `keepOnlyCardButton`（唯一使用者是已删的卡片动作链路）。
//   恢复其中任何一张 = **重新实现**（卡片 + 动作分派），不是翻一个开关。
//
// ⚠️ 会走 `im.v1.message.patch` 的卡片，`config` 一律从 `patchableCardConfig()` 出。

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
// ⚠️ 不走 patch 的卡片（`saleLookupCard`）**刻意不带**这个字段 —— 它只发不改。
//    （另一张 `purchaseRequestConfirmationCard` 已于 2026-10-08 删除。）
const patchableCardConfig = () => ({ wide_screen_mode: true, update_multi: true });

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
        // 货号+颜色（草稿里的 actual 明细），渲染时不额外查库。
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

module.exports = {
  purchaseStatusCard,
  // 「采购到货：扫码 / 工作台验收」的终态卡片（按钮已收掉，只剩一行说明）。
  purchaseArrivalReconcileStatusCard,
  // 「样品已售出 → 请补选」提醒卡（工作台补样品链路在用）。
  sampleReplacementCard,
};
