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
    { tag: 'markdown', content: itemLines(draft.items) || '未识别到商品' },
    {
      tag: 'markdown',
      content: `**销售行为：** ${text(draft.sales_behavior)}\n**实收：** ￥${text(draft.total_paid)}\n**收款方式：** ${text(draft.payment_method)}`,
    },
    {
      tag: 'action',
      actions: [
        actionButton('确认入账', 'confirm_sale', draftId, 'primary'),
        actionButton('取消', 'cancel', draftId, 'danger'),
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
};
