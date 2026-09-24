const text = (value) => String(value ?? '').replace(/\n/g, ' ');

const itemLines = (items, priceKey) =>
  (items || [])
    .map((item, index) => {
      const product = item.product_number || item.productNumber || item.item_no || item.itemNo || '未知货品';
      const price = item[priceKey] ?? item.unitPrice ?? item.unitCost;
      const gift = item.gift ? `\n   赠品：${text(item.gift_description || '有')}` : '';
      return `${index + 1}. ${text(product)} ${text(item.size)}码 × ${text(item.quantity || 1)}${price ? ` ￥${price}` : ''}${gift}`;
    })
    .join('\n');

const actionButton = (label, action, draftId, type = 'default') => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type,
  value: { action, draft_id: draftId },
});

const salesConfirmationCard = (draftId, draft) => ({
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: '请确认销售录单' } },
  elements: [
    {
      tag: 'markdown',
      content: `**销售行为：** ${text(draft.sales_behavior)}\n**编号：** ${text(draft.product_number)}\n**尺码：** ${text(draft.size)}\n**数量：** ${text(draft.quantity)}\n**金额：** ￥${text(draft.total_paid)}\n**支付方式：** ${text(draft.payment_method)}${draft.gift ? `\n**赠品：** ${text(draft.gift_description || '有')}` : ''}`,
    },
    {
      tag: 'action',
      actions: [
        actionButton('确认入账', 'confirm_sale', draftId, 'primary'),
        actionButton('修改', 'modify_sale', draftId),
        actionButton('取消', 'cancel', draftId, 'danger'),
      ],
    },
  ],
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
                `${index + 1}. **${text(row.product)}**｜${text(row.size)}码｜×${text(row.quantity)}｜￥${text(row.amount)}｜${text(row.paymentMethod)}｜${text(row.behavior)}`
            )
            .join('\n')
        : '今天还没有已确认的销售明细。',
    },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `共 ${rows.length} 条明细，${text(totalQuantity)} 件，实收合计 ￥${text(totalAmount)}`,
        },
      ],
    },
  ],
});

const purchaseConfirmationCard = (draftId, draft) => {
  const missing = draft.missing_fields || [];
  const elements = [
    { tag: 'markdown', content: itemLines(draft.items, 'unit_cost') || '未识别到商品' },
    { tag: 'markdown', content: `**供应商：** ${text(draft.supplier || '待补充')}` },
  ];
  if (draft.payment?.amount) {
    elements.push({
      tag: 'markdown',
      content: `**本次已付：** ￥${text(draft.payment.amount)}\n**付款方式：** ${text(draft.payment.method)}`,
    });
  }
  if (missing.length) {
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `需补充：${missing.join('、')}` }] });
  } else {
    elements.push({
      tag: 'action',
      actions: [
        actionButton('确认入库', 'confirm_purchase', draftId, 'primary'),
        actionButton('取消', 'cancel', draftId, 'danger'),
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请确认采购入库' } },
    elements,
  };
};

module.exports = {
  purchaseConfirmationCard,
  salesConfirmationCard,
  todaySalesCard,
};
