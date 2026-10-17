'use strict';

/**
 * 扫码页「会话 / 后台 / 幂等」（拆分第 3 刀，从 `routes/scanPage/index.js` 搬出，**只搬不改**）：
 *   · 多货品「还没开放提交的那一单」的暂存：读 / 写 / 清（落在**引擎同一份会话**里，按链分段）
 *   · 「后台那一跑」的排程（幂等键原样透传）
 *
 * 存储/后台件由调用方注入（`writeService` / `multiItemOrderConfig` / `purchaseBackground`），
 * 本文件不 new 任何东西、不碰业务表。
 */

/** 多货品暂存（与引擎同一容器、不同键 ⇒ 不会互相覆盖）。 */
const createMultiItemPending = ({ writeService, multiItemOrderConfig }) => {
  const multiItemPendingKey = (chain) => `${String(chain || '')}:pending`;

  const readMultiItemPending = async (openId, chain) => {
    if (!writeService || !writeService.sessions || !openId) return { orderKey: '', items: [] };
    const { store, idOf } = writeService.sessions;
    if (!store || typeof store.get !== 'function' || typeof idOf !== 'function') return { orderKey: '', items: [] };
    const session = await store.get(idOf(openId)).catch(() => null);
    const block = (session || {})[multiItemOrderConfig.session.ordersField] || {};
    const entry = block[multiItemPendingKey(chain)] || {};
    return {
      orderKey: String(entry.orderKey || ''),
      items: Array.isArray(entry.items) ? entry.items : [],
    };
  };

  const writeMultiItemPending = async (openId, chain, { orderKey, items }) => {
    if (!writeService || !writeService.sessions || !openId) return;
    const { store, idOf } = writeService.sessions;
    if (!store || typeof store.update !== 'function' || typeof idOf !== 'function') return;
    // ⚠️ 这一发**就是**一次写 ⇒ 会话还不存在时先建出来；`ensure` 是既有会话入口。
    if (typeof writeService.sessions.ensure === 'function') {
      await writeService.sessions.ensure(openId).catch(() => null);
    }
    const ordersField = multiItemOrderConfig.session.ordersField;
    await store.update(idOf(openId), (session) => {
      const orders = { ...((session || {})[ordersField] || {}) };
      const key = multiItemPendingKey(chain);
      const next = { ...(orders[key] || {}), items: Array.isArray(items) ? items : [] };
      // ⚠️ 只在**真的拿到** `orderKey` 时写它 —— 否则会把先前那份**抹掉** ✗
      if (orderKey) next.orderKey = String(orderKey);
      orders[key] = next;
      return { [ordersField]: orders };
    });
  };

  /** 清掉那一段暂存（提交走掉 / 这一单结束时叫）—— 不留残留，免得下一单看见上一单的 ✓。 */
  const clearMultiItemPending = async (openId, chain) => {
    if (!writeService || !writeService.sessions || !openId) return;
    const { store, idOf } = writeService.sessions;
    if (!store || typeof store.update !== 'function' || typeof idOf !== 'function') return;
    const ordersField = multiItemOrderConfig.session.ordersField;
    await store.update(idOf(openId), (session) => {
      const orders = { ...((session || {})[ordersField] || {}) };
      delete orders[multiItemPendingKey(chain)];
      return { [ordersField]: orders };
    });
  };

  return { multiItemPendingKey, readMultiItemPending, writeMultiItemPending, clearMultiItemPending };
};

/** 「后台那一跑」的排程（共用件登记在册；用例可以等它）。 */
const createPurchaseScheduler = ({ purchaseBackground }) => ({
  schedulePurchaseWrite: ({ chain, requestId, submitKey, context, restInput }) =>
    purchaseBackground.schedulePurchaseRest({ chain, requestId, submitKey, context, restInput }),
});

module.exports = { createMultiItemPending, createPurchaseScheduler };
