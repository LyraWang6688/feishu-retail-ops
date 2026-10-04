const text = (value) => String(value ?? '').replace(/\n/g, ' ');

// 明细行只写她需要核对的事实：货号、尺码、数量、金额、赠品。
//
// 库存分布**刻意不写在这里**：实时库存是录单时读的，只用来判断"这一双有没有货、
// 卖的是不是样品"。有货就不需要她看库存数字——那是噪音；只有她说了一个没有的尺码，
// 才回一句"这个货号现在有哪几个尺码"（见 larkMvpService 的没货追问）。
const itemLines = (items, priceKey) =>
  (items || [])
    .map((item, index) => {
      // 配品没有货号，显示它自己的名称。
      const product = item.product_number || item.productNumber || item.item_no || item.itemNo
        || item.accessory_name || '未知货品';
      const price = item[priceKey] ?? item.unitPrice ?? item.unitCost;
      const gift = item.gift ? `\n   赠品：${text(item.gift_description || '有')}` : '';
      return `${index + 1}. ${text(product)} ${text(item.size)}码 × ${text(item.quantity || 1)}${price ? ` ￥${price}` : ''}${gift}`;
    })
    .join('\n');

/**
 * 采购确认卡的分组展示：供应商 → 编号 → 尺码从小到大
 * 匹配成功的货品显示完整编号，匹配失败的标注"未匹配"
 */


/**
 * 采购商品明细 - 网格布局（按编号分区，尺码每行4个）
 * 返回飞书卡片元素数组
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

  for (const [supplier, supplierItems] of bySupplier) {
    if (!skipSupplierGroup) {
      if (!isFirstSupplier) elements.push({ tag: 'hr' });
      elements.push({ tag: 'markdown', content: `**━━━ 供应商：${text(supplier)} ━━━**` });
      isFirstSupplier = false;
    }

    // 第二层：按编号分组
    const byProduct = new Map();
    for (const item of supplierItems) {
      const productLabel = item.product_number || `${item.item_no}${item.color ? ' ' + item.color : ''}`;
      const key = item.product_record_id || `unmatched:${item.item_no}|${item.color}`;
      if (!byProduct.has(key)) byProduct.set(key, { label: productLabel, items: [] });
      byProduct.get(key).items.push(item);
    }

    let isFirstProduct = true;
    for (const [, product] of byProduct) {
      // 编号分区之间的分隔
      if (!isFirstProduct || (!skipSupplierGroup && !isFirstSupplier)) {
        elements.push({ tag: 'hr' });
      }
      isFirstProduct = false;

      const hasMatch = product.items.some((item) => item.product_record_id);
      const prefix = hasMatch ? '🏷' : '⚠️';

      // 编号标题
      elements.push({
        tag: 'markdown',
        content: `**${prefix} ${text(product.label)}**`,
      });

      // 第三层：按尺码从小到大排序
      const sorted = [...product.items].sort((a, b) => Number(a.size) - Number(b.size));

      // 每4个尺码一行，生成 column_set
      for (let i = 0; i < sorted.length; i += 4) {
        const rowItems = sorted.slice(i, i + 4);
        const columns = rowItems.map((item) => {
          const price = item.unit_cost ? ` ￥${item.unit_cost}/双` : '';
          const matchNote = item.match_error ? `（未匹配）` : '';
          return {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            elements: [
              {
                tag: 'markdown',
                content: `**${text(item.size)}码**\n× ${text(item.quantity || 1)}${price}${matchNote}`,
                text_align: 'center',
              },
            ],
          };
        });
        elements.push({
          tag: 'column_set',
          flex_mode: 'none',
          background_style: 'grey',
          horizontal_spacing: 'default',
          columns,
        });
      }
    }
    if (!skipSupplierGroup) elements.push({ tag: 'hr' }); // 供应商之间分隔
  }

  return elements;
};

const actionButton = (label, action, draftId, type = 'default', extra = {}) => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type,
  value: { action, draft_id: draftId, ...extra },
});

// 颜色待选的明细：每双一组按钮。横排——颜色少时一行放得下，颜色多时飞书卡片自动换行。
// 已经确定颜色的明细（单色货号、或用户说对了）不出按钮，只在上面的明细行里显示。
const salesColorPickers = (draftId, draft) => {
  const elements = [];
  (draft.items || []).forEach((item, index) => {
    const options = item.color_options || [];
    if (!item.needs_color || !options.length) return;
    // 只写一句"请选择颜色"，候选颜色由下面的按钮表达——
    // 再把颜色名列一遍就是跟按钮重复了。
    elements.push({
      tag: 'markdown',
      content: `**第 ${index + 1} 双请选择颜色**`,
    });
    elements.push({
      tag: 'action',
      actions: options.map((option) => actionButton(option.color || '未命名颜色', 'choose_sale_color',
        draftId, 'primary', { item_index: index, record_id: option.recordId,
          product_number: option.number, color_name: option.color })),
    });
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
      tag: 'markdown',
      content: `**第 ${index + 1} 双是样品，卖掉后要补一个门盒**（${label}）\n` +
        (options.length ? '请选一个门盒来补样品：' : '同货号的门盒已经没有余量，需要另行调拨。'),
    });
    if (options.length) {
      elements.push({
        tag: 'action',
        actions: options.map((row) => actionButton(
          item.sample_replacement_size === row.size ? `已选 ${row.size}码` : `选 ${row.size}码`,
          'choose_sale_sample_replacement', draftId,
          item.sample_replacement_size === row.size ? 'primary' : 'default',
          { item_index: index, size: row.size },
        )),
      });
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

// 第三区：货品资料不全时，把"还差哪几项"和记录链接放进**同一张确认卡片**。
//
// 为什么放在这张卡片里而不是另发一条消息：录入时她本来就在看这张卡片，
// 顺手就能点去补；另发一条消息只会多一次打扰，也容易漏看。
//
// 「信息是否齐备」是飞书公式，缺哪项它就写哪项（单一数据源在表里）；
// 「样例图」是附件字段，公式管不到，所以在这里单独补上。
const salesProductInfoGaps = (draft) => {
  const gaps = draft.product_info_gaps || [];
  if (!gaps.length) return [];
  const lines = gaps.map((gap) => {
    const label = text(gap.label || gap.record_id);
    const lacks = [...(gap.missing || []), ...(gap.missing_sample_image ? ['样例图'] : [])];
    return `**${label}** 还差：${lacks.map(text).join('、')}\n[去补全这条记录](${gap.url})`;
  });
  return [{ tag: 'markdown', content: `**补货品信息**\n${lines.join('\n')}` }];
};

const salesConfirmationCard = (draftId, draft) => ({
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: '请确认销售订单' } },
  elements: [
    {
      tag: 'markdown',
      content: `${itemLines(draft.items || [], 'actual_amount')}\n**成交总额：** ￥${text(draft.agreed_total)}` +
        (draft.voucher ? `\n**团购券：** ￥${text(draft.voucher.purchase_price)} 抵 ￥${text(draft.voucher.face_value)}；平台预计结算 ￥${text(draft.voucher.settlement_amount)}` : '') +
        `\n**本次已收：** ${(draft.payments || []).filter((payment) => payment.status !== '待平台结算').length ?
          draft.payments.filter((payment) => payment.status !== '待平台结算').map((payment) => `${text(payment.method)} ￥${text(payment.amount)}`).join('；') : '尚未收款'}` +
        ((draft.payments || []).some((payment) => payment.status === '待平台结算') ?
          `\n**待平台结算：** ${draft.payments.filter((payment) => payment.status === '待平台结算').map((payment) => `${text(payment.method)} ￥${text(payment.amount)}`).join('；')}` : '') +
        `\n**交易类型：** ${tradeTypeLine(draft)}`,
    },
    ...salesColorPickers(draftId, draft),
    ...salesSampleReplacementPicker(draftId, draft),
    ...salesProductInfoGaps(draft),
    {
      tag: 'action',
      actions: [
        actionButton('确认', 'confirm_sale', draftId, 'primary'),
        actionButton('修改', 'modify_sale', draftId),
        actionButton('取消', 'cancel', draftId, 'danger'),
      ],
    },
  ],
});

const salesStatusCard = (draft, title, message, template = 'blue') => ({
  config: { wide_screen_mode: true },
  header: { template, title: { tag: 'plain_text', content: title } },
  elements: [
    { tag: 'markdown', content: itemLines(draft?.items || [], 'actual_amount') || '销售订单' },
    { tag: 'note', elements: [{ tag: 'plain_text', content: message }] },
  ],
});

const sampleReplacementCard = (taskId, { productNumber, remainingSizes = [], lookupFailed = false } = {}) => {
  const lines = remainingSizes.map((item) =>
    `${text(item.size)}码：门盒 ${text(item.doorBoxCount)}、样品 ${text(item.sampleCount)}、仓库 ${text(item.warehouseCount)}`);
  const choices = remainingSizes.filter((item) => item.doorBoxCount > 0);
  const elements = [{ tag: 'markdown', content:
    `**${text(productNumber || '该货品')} 的样品已售出。**\n请选择同货号现有门盒中的一个尺码补作样品；仓库鞋需另行调拨。\n${lines.join('\n') || (lookupFailed ? '可选尺码暂时无法读取，库存已扣减；请点击刷新重试。' : '目前没有剩余库存。')}` }];
  for (let index = 0; index < choices.length; index += 4) {
    elements.push({ tag: 'action', actions: choices.slice(index, index + 4).map((item) => ({
      ...actionButton(`选 ${text(item.size)} 码`, 'choose_sample_replacement', taskId),
      value: { action: 'choose_sample_replacement', draft_id: taskId, size: item.size },
    })) });
  }
  elements.push({ tag: 'action', actions: [actionButton('刷新可选尺码', 'refresh_sample_replacement', taskId)] });
  return { config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请补选展示样品' } }, elements };
};

const sampleReplacementStatusCard = (productNumber, message) => ({
  config: { wide_screen_mode: true },
  header: { template: 'green', title: { tag: 'plain_text', content: '样品已补选' } },
  elements: [{ tag: 'markdown', content: `${text(productNumber || '该货品')}：${text(message)}` }],
});

const sampleReplacementProcessingCard = (productNumber, message) => ({
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: '样品补选处理中' } },
  elements: [{ tag: 'markdown', content: `${text(productNumber || '该货品')}：${text(message)}` }],
});

const todaySalesCard = ({ dateLabel, rows, totalQuantity, totalAmount }) => ({
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: `${dateLabel} 销售明细` } },
  elements: [
    {
      tag: 'markdown',
      content: rows.length
        ? rows
            .map(
              (row, index) =>
                `${index + 1}. **${text(row.product)}**｜${text(row.size)}码｜×${text(row.quantity)}｜成交金额 ${row.amount == null ? '待录入' : `￥${text(row.amount)}`}｜订单收款方式 ${text(row.paymentMethod)}`
            )
            .join('\n')
        : '今天还没有已确认的销售明细。',
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `共 ${rows.length} 条明细，${text(totalQuantity)} 件；这些订单截至当前累计已收 ￥${text(totalAmount)}`,
        },
      ],
    },
  ],
});

const purchaseRequestConfirmationCard = (draftId, draft) => {
  const isBatch = draft.is_batch === true;
  const headerTitle = isBatch ? '请确认采购申请（批次）' : '请确认采购申请';
  const elements = [];
  if (isBatch) {
    elements.push({ tag: 'markdown', content: `**报货批次号：** ${text(draft.batch_no)}\n**明细数量：** ${text(draft.items?.length || 0)} 条` });
  }
  elements.push(...purchaseItemElements(draft.items || [], { skipSupplierGroup: isBatch }));
  elements.push({
    tag: 'action',
    actions: [
      actionButton('确认生成采购申请', 'confirm_purchase_request', draftId, 'primary'),
      actionButton('取消', 'cancel_purchase_request', draftId, 'danger'),
    ],
  });
  return { config: { wide_screen_mode: true }, header: { template: 'orange', title: { tag: 'plain_text', content: headerTitle } }, elements };
};

const purchaseArrivalComparisonCard = (draftId, draft) => {
  const lines = (draft.differences || []).map((item) =>
    `${item.product_number || item.item_no}｜${item.size}码：申请${item.requested}，实到${item.actual}，${item.label}`
  );
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请确认采购到货差异' } },
    elements: [
      { tag: 'markdown', content: `**报货批次号：** ${text(draft.batch_no)}\n${lines.join('\n') || '申请与实际到货一致'}` },
      {
        tag: 'action',
        actions: [
          actionButton('确认入库', 'confirm_purchase_arrival', draftId, 'primary'),
          actionButton('取消', 'cancel_purchase_arrival', draftId, 'danger'),
        ],
      },
    ],
  };
};


/**
 * 第一步：采购到货明细确认卡片
 * 显示实际到货明细（按编号分区）+ 未匹配货品 + 鞋盒总数统计
 */
const purchaseArrivalDetailCard = (draftId, draft) => {
  const elements = [];

  // 报货批次号
  elements.push({ tag: 'markdown', content: `**报货批次号：** ${text(draft.batch_no)}` });

  // 实际到货明细（按编号分区显示）
  const matchedItems = (draft.actual || []).map(item => ({
    ...item,
    product_number: item.product_number,
    product_record_id: item.product_record_id,
  }));
  if (matchedItems.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `**📦 实际到货明细（共 ${matchedItems.length} 条）**` });
    elements.push(...purchaseItemElements(matchedItems, { skipSupplierGroup: true }));
  }

  // 未匹配货品
  const unrecognized = draft.unrecognized || [];
  if (unrecognized.length > 0) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'markdown', content: `**⚠️ 未匹配货品（共 ${unrecognized.length} 个，无法在货品表中找到）**` });
    const unrecognizedLines = unrecognized.map(u =>
      `- ${text(u.item_no || '未知')} ${text(u.color || '')} ${text(u.size || '')}码 ×${text(u.quantity || 1)}`
    );
    elements.push({ tag: 'markdown', content: unrecognizedLines.join('\n') });
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: '提示：未匹配的货品不会入库，可能是 OCR 识别错误，请核对鞋盒标签' }] });
  }

  // 鞋盒总数统计
  const totalBoxes = matchedItems.length + unrecognized.length;
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'column_set',
    flex_mode: 'none',
    background_style: 'grey',
    horizontal_spacing: 'default',
    columns: [
      {
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [{ tag: 'markdown', content: `**识别鞋盒总数**\n${totalBoxes} 个`, text_align: 'center' }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [{ tag: 'markdown', content: `**匹配成功**\n${matchedItems.length} 个`, text_align: 'center' }],
      },
      {
        tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
        elements: [{ tag: 'markdown', content: `**未匹配**\n${unrecognized.length} 个`, text_align: 'center' }],
      },
    ],
  });

  // 确认/取消按钮
  elements.push({
    tag: 'action',
    actions: [
      actionButton('确认入库', 'confirm_purchase_arrival', draftId, 'primary'),
      actionButton('取消', 'cancel_purchase_arrival', draftId, 'danger'),
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请确认采购到货明细' } },
    elements,
  };
};

const purchaseStatusCard = (draft, title, message, template = 'blue') => {
  const isBatch = draft?.is_batch === true;
  const elements = [];
  if (isBatch && draft?.batch_no) {
    elements.push({ tag: 'markdown', content: `**报货批次号：** ${text(draft.batch_no)}` });
  }
  elements.push(...purchaseItemElements(draft?.items || draft?.actual || [], { skipSupplierGroup: isBatch }));
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: message }] });
  return { config: { wide_screen_mode: true }, header: { template, title: { tag: 'plain_text', content: title } }, elements };
};

module.exports = {
  purchaseRequestConfirmationCard,
  purchaseArrivalComparisonCard,
  purchaseArrivalDetailCard,
  purchaseStatusCard,
  salesConfirmationCard,
  salesStatusCard,
  sampleReplacementCard,
  sampleReplacementStatusCard,
  sampleReplacementProcessingCard,
  todaySalesCard,
};
