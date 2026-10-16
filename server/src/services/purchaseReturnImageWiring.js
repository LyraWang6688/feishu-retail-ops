/**
 * 采购退货「**出图 / 发群 / 回填附件**」这一环的**装配件**（全仓唯一一处把出图链路接到退货写入件上）。
 *
 * ── 为什么需要它（这次是修一个线上真缺陷）─────────────────────────────────────
 *   退货写库那条链（`services/purchaseReturnService.js`）**不自己造**出图链路：它只认注入的
 *   `options.webhooks`（`:142`：`const webhooks = options.webhooks || null;`）——设计上就该由
 *   **装配处**给。而装配处（`routes/scanPage/index.js` → `createScanWriteService`）**从来没给过**
 *   （`services/scanWriteService.js:235` 的 `...(options.purchaseReturnOptions || {})` 是唯一的读取点，
 *   全仓没有第二个调用方传它）⇒ `webhooks` 恒为空 ⇒ 线上每一次退货都走
 *   `returnImageFailed` 的 `reason: 'no_image_pipeline'`：**账走了、图一张没发** ✗
 *   （她 2026-10-16 20:12 那次的线上日志就是这个；⚠️ 单货品退货**同样**受影响，是老缺口，
 *    不是多货品那一刀带进来的）。
 *
 * ── 为什么单独一个文件（而不是把 `new PurchaseWebhookService(…)` 写进路由）────────
 *   `routes/**` 有一条**既有哨兵**：`test/multiItemOrderRoute.test.js` 的 RT5 ——
 *   `routes/scanPage/index.js` 的**代码行**里不许出现
 *   `purchaseWebhookService` / `purchaseReturnService` / `PurchaseWebhookService` 这三个名字
 *   （`test/scanDraftRouteWiring.test.js` 的 AC-D3i2 也钉着"路由不许 require 它们"）。
 *   ⇒ 真名只在本文件里出现一次；路由只 require 这个**名字里不含那些服务名**的装配件 ✓。
 *
 * ── 与「已经能发图」的两条路**同构**（不发明新写法 ✓）──────────────────────────
 *   · 补货：`services/scanWriteService.js` 的 `purchase()` 自己 `new PurchaseWebhookService({…})`；
 *   · 验收：`services/scanArrivalService.js` 的 `arrivalConversationOf()` 自己
 *     `new PurchaseWebhookService({ gateway })`；
 *   · 退货（本文件）：装配处按同一个类、同一个方法（`deliverSupplierImages`：出图 → 发群 →
 *     回填「报货批次.单据」；**按供应商分组**在它内部，用 `services/supplierSplitService.js`
 *     那一处唯一的纯函数 ✓ 本文件不另造第二套 ✗）。
 *
 * ── 配置先行（零硬编码 ✓）──────────────────────────────────────────────────
 *   · 接不接 = `config/scanWrite.js` 的 `PURCHASE_RETURN.imageDelivery.enabled`
 *     （显式布尔：设成空串 = 关 ✓）；
 *   · 发到哪个群 = 既有 `PURCHASE_CHAT_ID`（`config/groupPurchase.js`，没配时出图链路自己
 *     "大声跳过" ✓ 本文件不读、不默认、不硬编码任何群 id ✗）；
 *   · 图上的标题 / 文件名后缀 = `PURCHASE_RETURN.imageTitle` / `fileNameSuffix`
 *     （由 `purchaseReturnService` 传给 `deliverSupplierImages` ✓ 本文件不碰）。
 *
 * ── 为什么 `webhooks` 是一个**惰性 getter**（不是一个当场构造好的实例）───────────
 *   本函数在**建 router 时**（`app.js` 启动那一刻 / 每个建 router 的用例）就被调用了。
 *   而 `new PurchaseWebhookService(…)` 的构造函数会 `getLarkAgentCredentials()` ——
 *   缺 `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` 时**当场抛错**（`config/larkAgent.js`）。
 *   若在这里立即构造：启动那一刻就会被凭证问题拖住，几十个"只读页面"的用例也会整片崩 ✗。
 *   ⇒ 用 `get webhooks()`：**真正被读到时**（`services/scanWriteService.js:235` 的对象展开发生在
 *     它**惰性建退货服务那一刻**，也就是**她真提交一次退货**时）才构造 ✓
 *     —— 启动零副作用、也只在她真要出图时才连接线。
 */

/**
 * 装配处要传给 `createScanWriteService` 的 `purchaseReturnOptions`。
 *
 * @param {object} input
 * @param {object} input.gateway    写库用的网关（装配处那一个，与补货/验收同一个来源 ✓）
 * @param {object} [input.config]   `PURCHASE_RETURN`（只读它的 `imageDelivery.enabled`）
 * @param {object} [input.overrides] 用例注入用：`{ webhooks }` 直接给一个现成实例，
 *                                   或 `{ webhookOptions }` 透传给 `PurchaseWebhookService`
 *                                   的构造入参（假 IM / 假出图 / 假 sandbox 群）。
 * @returns {{ webhooks?: object }} 关着（或没网关）时返回 `{}` ⇒ 写入口维持原状（并如常记 no_image_pipeline）。
 */
const resolvePurchaseReturnImageOptions = ({ gateway, config, overrides = {} } = {}) => {
  // ① 调用方直接给了一个现成的出图链路实例（与 `purchaseReturnService.options.webhooks` 同一个口 ✓）
  if (overrides && overrides.webhooks) return { webhooks: overrides.webhooks };
  // ② 配置关着（或没有网关）⇒ **什么都不接**（写入口照旧：事实落地 + 一条 no_image_pipeline 的 warn）
  if (!config || config.enabled !== true) return {};
  if (!gateway) return {};
  // ③ 默认那一份：真 `PurchaseWebhookService`（**惰性** —— 见文件头"为什么是 getter"）
  let built = null;
  return {
    get webhooks() {
      if (!built) {
        // eslint-disable-next-line global-require
        const { PurchaseWebhookService } = require('./purchaseWebhookService');
        built = new PurchaseWebhookService({ gateway, ...(overrides.webhookOptions || {}) });
      }
      return built;
    },
  };
};

module.exports = { resolvePurchaseReturnImageOptions };
