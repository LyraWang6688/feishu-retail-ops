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

/**
 * 采购确认卡的分组展示：供应商 → 编号 → 尺码从小到大
 * 匹配成功的货品显示完整编号，匹配失败的标注"未匹配"
 */
const purchaseItemLinesGrouped = (items) => {
  if (!items?.length) return '未识别到商品';

  // 第一层：按供应商分组（供应商为空的归到"待补充供应商"）
  const bySupplier = new Map();
  for (const item of items) {
    const supplier = item.supplier || '待补充供应商';
    if (!bySupplier.has(supplier)) bySupplier.set(supplier, []);
    bySupplier.get(supplier).push(item);
  }

  const lines = [];
  for (const [supplier, supplierItems] of bySupplier) {
    lines.push(`**━━━ 供应商：${text(supplier)} ━━━**`);

    // 第二层：按编号分组（匹配成功用 product_record_id 做 key，匹配失败用货号+颜色）
    const byProduct = new Map();
    for (const item of supplierItems) {
      const productLabel = item.product_number || `${item.item_no}${item.color ? ' ' + item.color : ''}`;
      const key = item.product_record_id || `unmatched:${item.item_no}|${item.color}`;
      if (!byProduct.has(key)) byProduct.set(key, { label: productLabel, items: [] });
      byProduct.get(key).items.push(item);
    }

    for (const [, product] of byProduct) {
      const hasMatch = product.items.some((item) => item.product_record_id);
      const prefix = hasMatch ? '🏷' : '⚠️';
      lines.push(`${prefix} ${text(product.label)}`);

      // 第三层：按尺码从小到大排序
      const sorted = [...product.items].sort((a, b) => Number(a.size) - Number(b.size));
      for (const item of sorted) {
        const price = item.unit_cost ? ` ￥${item.unit_cost}/双` : '';
        const matchNote = item.match_error ? `（未匹配：${text(item.match_error)}）` : '';
        lines.push(`  ${text(item.size)}码 × ${text(item.quantity || 1)}${price}${matchNote}`);
      }
    }
    lines.push(''); // 供应商之间空行分隔
  }

  return lines.join('\n');
};

const actionButton = (label, action, draftId, type = 'default') => ({
  tag: 'button',
  text: { tag: 'plain_text', content: label },
  type,
  value: { action, draft_id: draftId },
});

const salesConfirmationCard = (draftId, draft) => ({
  config: { wide_screen_mode: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: '请确认销售订单' } },
  elements: [
    {
      tag: 'markdown',
      content: `${itemLines(draft.items || [], 'actual_amount')}\n**成交总额：** ￥${text(draft.agreed_total)}\n**本次收款：** ${(draft.payments || []).length ? draft.payments.map((payment) => `${text(payment.method)} ￥${text(payment.amount)}`).join('；') : '尚未收款'}\n**交付：** ${text(draft.delivery_status || '待确认')}（请按实际情况选择）`,
    },
    {
      tag: 'action',
      actions: [
        actionButton('确认已交付（扣库存）', 'confirm_sale_delivered', draftId, draft.delivery_status === '已交付' ? 'primary' : 'default'),
        actionButton('确认未交付', 'confirm_sale_pending', draftId, draft.delivery_status === '已交付' ? 'default' : 'primary'),
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

const purchaseConfirmationCard = (draftId, draft) => {
  const missing = draft.missing_fields || [];
  const items = draft.items || [];

  // 合计：总件数、总金额（只算有单价的）
  const totalQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  const totalAmount = items.reduce(
    (sum, item) => sum + Number(item.quantity || 0) * Number(item.unit_cost || 0),
    0
  );

  const elements = [
    { tag: 'markdown', content: purchaseItemLinesGrouped(items) },
    {
      tag: 'note',
      elements: [
        {
          tag: 'plain_text',
          content: `合计：${totalQuantity} 件${totalAmount ? `，￥${totalAmount}` : ''}${draft.supplier_count > 1 ? `，共 ${draft.supplier_count} 个供应商` : ''}`,
        },
      ],
    },
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

const purchaseRequestConfirmationCard = (draftId, draft) => ({
  config: { wide_screen_mode: true },
  header: { template: 'orange', title: { tag: 'plain_text', content: '请确认采购申请' } },
  elements: [
    { tag: 'markdown', content: purchaseItemLinesGrouped(draft.items || []) },
    {
      tag: 'action',
      actions: [
        actionButton('确认生成采购申请', 'confirm_purchase_request', draftId, 'primary'),
        actionButton('取消', 'cancel_purchase_request', draftId, 'danger'),
      ],
    },
  ],
});

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

module.exports = {
  purchaseConfirmationCard,
  purchaseRequestConfirmationCard,
  purchaseArrivalComparisonCard,
  salesConfirmationCard,
  salesStatusCard,
  todaySalesCard,
};
