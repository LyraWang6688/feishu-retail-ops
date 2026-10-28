/** SKU = 货号 + 颜色 + 尺码（同 SKU 的交付互相锁）。 */
export const skuOfLine = (line = {}) => `${line.product || ''}|${line.color || ''}|${line.size || ''}`;

/** 页面级 SKU 在途锁（内存态；刷新/关闭页面自然消失）。 */
export const createSkuLock = (hostOf) => {
  const locked = new Set();
  return {
    has: (sku) => locked.has(sku),
    add: (sku) => { if (sku) locked.add(sku); },
    delete: (sku) => { locked.delete(sku); },
    apply: () => {
      const host = hostOf();
      if (!host) return;
      for (const button of host.querySelectorAll('[data-sd-sku]')) {
        button.disabled = locked.has(button.dataset.sdSku);
      }
    },
  };
};
