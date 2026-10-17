'use strict';

/**
 * 扫码页「动作分派」相关的纯逻辑（拆分第 1 刀：从 `routes/scanPage/index.js` 搬出，**只搬不改**）。
 *
 * 为什么单独一个文件：动作 → 领域映射、补货/退货的「整单金额」三道闸门、以及"记住最近用的领域"
 * 这三件事与路由/渲染无关，混在 3400 行里每次都得翻。搬出来之后：
 *   · 纯函数（`realmOfAction` / `purchaseAmount*`）**直接单测**，不用起 HTTP；
 *   · 行为对照点只有一处（路由里的薄包装），页面字节一个字不动。
 *
 * 🔴 纪律：本文件**不碰页面 HTML / 会话存储 / 写库**；`writeConfig` 由调用方注入（默认 `SCAN_WRITE`）。
 */
const { SCAN_WRITE } = require('../../config/scanWrite');

/** 动作 → 领域（"她刚在哪个领域干过活"）——整份代码只有这一处映射。 */
const realmOfAction = (action, writeConfig = SCAN_WRITE) => {
  const a = String(action || '');
  if (a === writeConfig.actions.submitOrder) return 'sales';
  // ⚠️ 原实现引用 `submitReplenish` / `submitPurchaseReturn`，但 `SCAN_WRITE.actions` 里**没有**这两个键
  //    ⇒ 原来这两条永远不命中（补货/退货的"记住最近领域"一直没生效）。搬移时发现，按真实动作名修正：
  if (a === writeConfig.actions.replenish) return 'replenish';
  if (a === writeConfig.actions.purchaseReturn) return 'purchase_return';
  // `accept` 系列（历史动作名 `acceptFinish` / `acceptFinishRows`）已随扫码验收页退场（切 A/B）
  // ⇒ 认不出就返回空串，由调用方决定不记。
  return '';
};

/** 补货 / 退货的「整单金额必填」是否适用于这个领域（配置先行：总开关 + 按链路）。 */
const purchaseAmountRequiredFor = (realm, writeConfig = SCAN_WRITE) => {
  if (writeConfig.purchaseAmount?.required === false) return false;
  const tiers = writeConfig.purchaseAmount?.requiredByRealm;
  if (tiers && tiers[realm] === false) return false;
  return true;
};

/** 整单金额是否"没填"（空 ⇒ true；不需要判的链路 ⇒ false）。 */
const purchaseAmountMissing = (body, realm, writeConfig = SCAN_WRITE) => {
  if (purchaseAmountRequiredFor(realm, writeConfig) === false) return false;
  return String(body?.[writeConfig.fields.purchaseAmount] ?? '').trim() === '';
};

/** 整单金额"填了但不是数字"（空的那条归 `purchaseAmountMissing` 管，两者各有各的人话）。 */
const purchaseAmountInvalid = (body, realm, writeConfig = SCAN_WRITE) => {
  if (purchaseAmountRequiredFor(realm, writeConfig) === false) return false;
  const raw = String(body?.[writeConfig.fields.purchaseAmount] ?? '').trim();
  if (raw === '') return false;
  return !Number.isFinite(Number(raw));
};

/**
 * 写成功之后记住"这个领域她刚用过"（她："继续扫 ⇒ 自动还是补货"）。
 * 失败一律吞掉（记不住领域不该影响这一单）；只在写成功那几条路上调。
 */
const markRealmUsed = ({ writeService, openId, realm, event, logWarn }) => {
  if (!writeService || !openId) return;
  const sessions = writeService.sessions;
  if (!sessions || typeof sessions.setLastRealm !== 'function') return;
  Promise.resolve(sessions.setLastRealm(openId, realm)).catch((error) => {
    if (typeof logWarn === 'function') logWarn(event, { reason: 'last_realm_write_failed', error: error.message });
  });
};

module.exports = {
  realmOfAction,
  purchaseAmountRequiredFor,
  purchaseAmountMissing,
  purchaseAmountInvalid,
  markRealmUsed,
};
