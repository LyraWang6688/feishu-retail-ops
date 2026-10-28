/**
 * 扫码页的「**领域切换**」配置（业务负责人 2026-10-09）—— 一个二维码，四个领域。
 *
 * 她的原话（逐字）：
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *   ＋ 首版口径：「扫描页（扫码入口）**保持 `GET /r/:recordId` 不变**，但**顶部加"领域切换"**：
 *     `?from=sales|inventory|purchase|product`（缺省=**销售**），切换后**只显示该领域的操作**」
 *
 * ⇒ 四个领域与**工作台一级 tab 一一对应**（销售 · 库存 · 采购 · 货品，顺序都一样）：
 *     · `sales`     → 销售建单（加入本单 / 提交这一单；资金等非必填、可后续补）
 *     · `inventory` → 库存查询（这一款按尺码 × 所属状态的库存表）
 *     · `purchase`  → 采购报货（勾选要补的尺码 → 生成采购申请）
 *     · `product`   → 货品标签（打这一款的 40×30mm 标签 / 去批量打印）
 *   ⚠️ **四个领域共用同一套业务处理层**（`services/scanWriteService.js` 与它的既有下游）：
 *      这里只决定"页面上先给她看哪一块"，**一行业务逻辑都没有**。
 *
 * ⭐⭐ 2026-10-09 真机反馈（**手机在飞书内置 webview 里扫码是一片空白**）之后的**改法**：
 *    **服务端按 `?from` 只渲染该领域那一块** —— 页面里**一行前端脚本都没有**
 *    （连 `<head>` 里那段读 `location.search` 的也删掉了），领域切换条是**真链接**
 *    （`<a href="?from=…">`，点一下就是一次新的服务端请求）。
 *
 *    为什么要把"四块全渲染 + CSS 显隐 + head 脚本"整层拿掉：
 *      · 那一版**所有领域块都在 HTML 里**，靠 `<html data-realm>` + CSS 只显示一块；
 *        只要那段内联脚本在飞书 webview 里没跑（被 CSP 拦、预加载阻断、老内核…），
 *        页面就多了一层"行为取决于脚本有没有执行"的不确定性 —— 而这一页的初衷
 *        本来就是"**一次请求就有完整内容、没有 JS**"；
 *      · 现在：请求什么领域、服务端就只拼那一块 ⇒ **没有 JS 也 100% 是对的**，
 *        页面上也不会有另外三块（内容更小、手机上首屏更快）。
 *    ⚠️ 兜底一条都不少：`<noscript>` 里再给一遍四条领域链接；任何领域块"没内容"时
 *      渲染的是**一张人话卡片**（标题 + 为什么 + 下一步），**绝不留空 div**。
 *
 * ⚠️ 为什么放在 `src/views/` 而不是 `src/config/`：这一份是**扫码页这个视图自己的展示参数**
 *    （跟 `views/scanPageRenderer.js` 一起看），所以与它同目录。
 *
 * ⭐⭐ 2026-10-09 下半场（业务负责人）：「一个码、三个领域扫出来**不一样**」——
 *   · `from=inventory` **就是现在这个页面，一个字不许变**（既有用例是哨兵）；
 *   · `from=sales`     尺码**分两组**：有货（样品 + 门盒）⇒ **现货**；其余 ⇒ **预订**
 *                     （判据与分组都在下面 `SELLABLE_STATES` / `saleSizeGroups`）；
 *   · `from=purchase`  列出各尺码的（样品 + 门盒）数量 + 【一键补货】（`purchaseSizeLines`）。
 *   ⚠️ 交易类型**不在这一层写编码**：写入口按 `config/salesTradeTypePolicy.salesTradeTypeForStock`
 *      （"有货 → 现货 / 没货 → 预订"的**唯一判据**）推出来，用的是**既有**行为编码。
 */
// ⭐⭐ 2026-10-11（业务负责人定）：**扫码"第一眼"改回「销售」**。
//   她的原话：「**默认打开是销售页**」（2026-10-11 改回）。
//   ⚠️ 历史：2026-10-09/10 她当时的口径是「第一眼看库存」，于是缺省一度是 `inventory`；
//      2026-10-11 她改回来了 —— 裸码扫开**先看到销售（建单）那一块**，
//      想查库存 / 补货 / 打标签 ⇒ 页面顶部点【库存】/【采购】/【货品】。
//   ⚠️ 领域切换（`?from=` 四个值）与「加入本单」303 回跳**都还照旧可用**：
//      回跳停在**本单所在的领域**（表单 action 由 `routes/scanPage.js` 的
//      `postActionFor(number, realm)` 带上 `?from=`，见那里的注释）。
const { SCAN_PAGE } = require('../config/scanPage');
// ⭐⭐ 2026-10-16 晚（业务负责人 20:5x 逐字）：「这个口径其实**也可以做一个配置**……
//   对于我们的销售、库存还有补货来说，**它们底层逻辑都是一样的**，只不过在**前端展示的方式不同**，
//   所以**完全可以抽象出来**」⇒ **「有货」怎么算 ＋ 尺码范围 ＋ 展示规则** 全部收敛到
//   `config/scanStockPolicy.js`（**口径的家** ✓）。本文件从此**只决定"怎么摆"** ✗ **不决定"算不算"** ✓。
const {
  SCAN_STOCK_POLICY, countInStockOf, specialSizesOf,
} = require('../config/scanStockPolicy');

// ⭐ 2026-10-09：男女两组尺码段**进配置**（`config/scanPage.js` 的 `sizeSegments`）——
//   页面上那句"这一组是男 38–48"与**缺码判定**用的是**同一份配置**（唯一真源）。
// ⭐ 2026-10-16 晚：取值改成**经新配置转发**（`SCAN_STOCK_POLICY.sizes.ranges` 就是**同一个对象**
//   `=== SCAN_PAGE.sizeSegments.ranges` ⇒ 仍然只有一份数据 ✓ 多一层只是让"尺码范围"有语义家 ✓）。
const SIZE_GROUP_RANGES = SCAN_STOCK_POLICY.sizes.ranges;

/**
 * ⭐⭐ 2026-10-11（业务负责人批准）：**扫码页六个领域**，顺序逐字 = 销售 · 补货 · 退货 · 验收 · 库存 · 货品。
 *
 * 与上一版（四个领域）的差别：
 *   · 原「**采购**」领域**去掉** —— 它里面的两个动作各自成领域：**补货**（原一键补货）与**退货**；
 *   · **验收**从"非 tab 的临时模式"升级成**正式领域**（有活跃验收会话时，裸扫仍会被自动切进来）；
 *   · 销售 / 库存 / 货品 照旧。
 *
 * ⚠️ **一个二维码、六个领域**：标签二维码内容**一个字没变**（`https://hm.bamamei.online/s/{编号}`，
 *    只含编号）⇒ 每个领域都是"同一个码扫开、点不同 tab / 带不同 `?from=`"。
 * ⚠️ `?from=purchase`（已退役的领域）**认不出来 ⇒ 回落缺省（销售）** —— 与"认不出的值一律回落"
 *    同一条既有口径；工作台那边指向它的入口已全部撤掉（见 `public/workbench/config/domains.js`）。
 */
const REALMS = Object.freeze([
  // ⭐⭐ 2026-10-14（业务负责人最终口径，逐字）：「销售 · 补货 · 库存 · 退货 · 配品 · 上新」
  Object.freeze({ id: 'sales', label: '销售' }),
  Object.freeze({ id: 'replenish', label: '补货' }),
  Object.freeze({ id: 'inventory', label: '库存' }),
  // ⭐ 「退货」**回到条上**（内部 id `purchase_return` 保留 ✓ 原来 label 被"配品"占着 ⇒ 改回"退货" ✓）
  Object.freeze({ id: 'purchase_return', label: '退货' }),
  // ⭐⭐ 2026-10-14（业务负责人逐字，最新口径 —— **覆盖 2026-10-13 那次**）：
  //    「**配品**给**迁移到工作台销售里**，新建一个子 tab，**整体都迁移过去**，**只是入口变了，逻辑没有变**」
  //    「把**上新 tab** 也给**去掉吧**」⇒ ⭐ 扫码页**只剩 4 个领域**：销售 · 补货 · 库存 · **退货**
  //    ⇒ `accessory`（配品）与 `new`（上新）**从这里撤掉** ✓
  //    ⚠️ 配品**不是删功能** ✓ —— 它**整体搬到工作台「销售 → 配品」子 tab**（逻辑一字不改 ✗）
  //    ⚠️ 旧 `?from=accessory` / `?from=new` ⇒ 按既有口径**认不出的值一律回落销售** ✓
  // ⚠️ 「标签」**整格撤下条**（只不上条 ✓ **功能不删** ✗ —— 与验收同样处理：
  //    留在 REALMS 里 ⇒ 旧 `?from=product` 链接照旧能开 ✓）
  Object.freeze({ id: 'product', label: '标签' }),
  // ⭐⭐ 2026-10-14 晚 **cut B：`accept`（验收）从 REALMS 退场** ——
  //   改前逐字：`Object.freeze({ id: 'accept', label: '验收' }),`
  //     ＋ 上面那句注释「⚠️ 「验收」仍在 REALMS（有活跃会话就切进来）⇒ 必须能解析 ✓ 只是**不上条** ✗」
  //   改后逐字：**这一格删掉**（REALMS 里没有 `accept`）
  //   依据：业务负责人 2026-10-14 晚逐字「**`/s/accept` 这条路要彻底拆掉**」
  //     ＋ Lead 切的 cut A（路由 / 渲染 / 会话入口先退场 ⇒ 已进 main）／cut B（**领域本身**退场，本刀）
  //   ⚠️ 旧 `?from=accept` ⇒ 按既有口径「**认不出的值一律回落缺省（销售）**」✓（与已退役的
  //      `?from=purchase` / `?from=accessory` / `?from=new` 同一条，不报错、不白屏 ✓）
  //   ⚠️ 能力**不是删功能** ✗：验收仍在**工作台**那条路上（`/api/workbench/purchase/arrivals/confirm` ✓）。
]);

/** ⭐ 切换条上的 tab —— 「标签」(`product`) **不在**条上 ✓（见上面那条注释）。 */
// ⭐⭐ 2026-10-14 晚 **cut B**（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：`REALMS.filter((realm) => realm.id !== 'accept' && realm.id !== 'product')`
//   改后逐字：`REALMS.filter((realm) => realm.id !== 'product')`
//   依据：`accept` 已**从 REALMS 退场**（见上面那一段）⇒ 这个 `!== 'accept'` 不再可能命中，
//        留着一个"永远为真"的条件只会让人以为 accept 还在（她自己那句话：「要彻底拆掉」）。
//   🔴 **`!== 'product'` 留着** ✗ —— 「标签」**仍在 REALMS**（旧 `?from=product` 照旧能开 ✓），
//      它只是**不上条**；把它一起删掉 = 条上多一格（判据：条上仍 **4 格**）。
const REALM_TABS = Object.freeze(REALMS.filter((realm) => realm.id !== 'product'));

/** 缺省领域 = **销售**（她 2026-10-11：「默认打开是销售页」；2026-10-09 曾一度是库存）。 */
const DEFAULT_REALM = 'inventory';

/** 补货 / 退货 两个领域的 id（渲染层与路由**不写字符串字面量**）。 */
// ⭐⭐ 2026-10-14 晚 cut B（改前逐字 → 改后逐字 → 依据）：
//   改前逐字：`const ACCEPTANCE_REALM = 'accept';`（上面那句注释写的是"补货 / 退货 / 验收 **三个**领域的 id"）
//   改后逐字：**这一行删掉**（注释同步改成"两个"）
//   依据：`accept` 已从 REALMS 退场（她：「`/s/accept` 这条路要彻底拆掉」）⇒ 这个常量**没有活引用**
//        （只在这句注释与一句测试注释里出现过）⇒ 留着就是"指向一个不存在的领域"✗。
const REPLENISH_REALM = 'replenish';
const PURCHASE_RETURN_REALM = 'purchase_return';
const NEW_REALM = 'new'; // ⭐ 2026-10-13：「上新」= **外链 tab**（不是页面领域）

/** 领域 id → 它"空态"时那句人话的配置键（`config/scanPage.js` 的文案）。 */
const REALM_EMPTY_TEXT_KEYS = Object.freeze({
  sales: 'realmEmptySalesBody',
  replenish: 'realmEmptyPurchaseBody',
  // ⭐ 2026-10-14 晚：退货用自己的人话 ✓（配品那句随配品一起搬去工作台 ✓）
  purchase_return: 'realmEmptyReturnBody',
  // ⭐ 2026-10-14：配品独立成领域 `accessory` ⇒ 复用上面那句**配品的人话**（零新增文案 ✓）
  accessory: 'realmEmptyPurchaseReturnBody',
  // ⭐⭐ 2026-10-14 晚 cut B：`accept: 'realmEmptyAcceptanceBody'` **删掉**（改前逐字即这一行）
  //   依据：`accept` 已从 REALMS 退场 ⇒ 这两个键都不可能再被取到（`realmEmptyHtml` 查不到键时
  //        走它自己的兜底 ✓）；留着 = 一条指向已退场领域的死映射 ✗。对应的文案
  //        （`config/scanPage.js` 的 `realmEmptyAcceptanceBody`）也一起删 ✓。
  new: 'realmEmptyNewBody', // ⭐ 2026-10-13 上新（外链 tab）的人话
});

/** 切换条与「货品标签」那一块的文案（页面上的每一个字都在这里，渲染层不写死句子）。
 *
 * ⭐⭐ **2026-10-10（业务负责人）：「只留能点、能做的事，删掉解释我怎么用的句子」** ——
 *   这里**只剩功能性的字**：领域名（`REALMS[].label`）· 无障碍用的条标签（`barLabel`）·
 *   货品标签页的标题与两颗按钮 · 销售两组的标题与状态小标签 · 采购那一列的三个小标签 ·
 *   以及压成最短的【一键补货】。
 *   ⇒ 退场的说明句（逐条）：`barHint`（「同一个二维码，四个领域都能扫；点一下切换」）·
 *     `noScriptHint`（「本页不需要 JavaScript…」）· `labelHint` · `saleInStockHint` /
 *     `salePrepaidHint`（「选这一组里的尺码 = 现货…」）· `purchaseSizesHint`（「只算可卖的…」）·
 *     `oneTapReplenish` 里那半句用法说明。
 *   ⚠️ **保留**：数据不全的如实说明（`config/scanPage.js` 的四条 note）· `⚠️ 缺` 高亮 ·
 *     状态小标签 · `noscript` **兜底链接**（没有脚本时四条领域链接照旧可点，只是不再解释）。
 */
const REALM_TEXTS = Object.freeze({
  barLabel: '这一页要做什么',
  // ⭐ 2026-10-13：**货品 → 标签**（她改名 ✓ 内部 id `product` 保留）；标题跟着改，页面上不再出现「货品」✗
  labelHeading: '标签',
  // ⚠️ 2026-10-11 改文案（业务负责人：「扫到某款 ⇒ 货品领域 ⇒【打印这一款】」）：
  //    改前 = '打印这一款的标签 →'，改后 = '打开标签打印页 →'。
  //    理由：「打印这一款」这五个字现在归**新的队列按钮**（`printSingle`，来自
  //    `config/labelPrintQueue.js`）—— 一点就把这一款**送到店里那台电脑打**；
  //    这一条链接仍然是**去工作台标签打印页**（在那里改条件 / 用浏览器打印），
  //    两颗按钮写同一个动作用词会让她点错。⚠️ key 名保留（用例钉着它必须是非空文案）。
  labelSingleButton: '打开标签打印页 →',
  labelBatchButton: '批量打印（按条件挑货）→',
  // ── 销售（`from=sales`）：尺码**分两组** —— 有货 ⇒ 现货 / 其余 ⇒ 预订 ──────────
  saleInStockHeading: '有货（样品 + 门盒）',
  salePrepaidHeading: '现在没有（预订）',
  saleInStockTag: '现货',
  salePrepaidTag: '预订',
  saleSizeEmpty: '这一款现在没有可选的尺码',
  saleCountTemplate: '{count} 双',
  // ── 采购（`from=purchase`）：各尺码（样品 + 门盒）数量 + 一键补货 ──────────────
  purchaseSizesHeading: '这一款各尺码现在有多少（样品 + 门盒）',
  purchaseInStockTag: '现货',
  purchaseMissingTag: '缺码',
  purchaseNoneTag: '无',
  // ⭐ 2026-10-10：原来那句「一键补货（缺的尺码已勾上，默认各 1 双）」是**用法说明**，压成功能名。
  oneTapReplenish: '一键补货',
  // ⭐ 2026-10-11：采购领域的第二个动作 —— 【退货】（业务负责人：「和"报货"逻辑一样，也走扫码」）。
  //    这里只放**功能名**（折叠头那两个字），不是一个句子。
  // ⭐ 2026-10-14 晚（她：配品搬去工作台）⇒ 这一格回到「退货」✓（10-13 临时叫配品那版退场 ✗）
  purchaseReturn: '退货',
});

/**
 * ⭐⭐ 2026-10-16 晚（业务负责人 20:5x 逐字）：**「有货」的判定搬进配置** ——
 *   改前逐字：本行 = `const SELLABLE_STATES = Object.freeze(['门盒', '样品']);`
 *     （写死在**渲染层** ⇒ 她说的「前端展示的方式不同」被当成了"算不算"的来源 ✗）
 *   改后逐字：`SELLABLE_STATES` **只是"开关关着时的旧口径"的别名** ——
 *     真源 = `config/scanStockPolicy.js` 的 `LEGACY_SELLABLE_STATES`（全仓只有一份 ✓）；
 *     「有货」的数量判据 = 同一份配置的 `countInStockOf`（**唯一判据** ✓）。
 *   依据：她 2026-10-16 20:5x「这个口径其实**也可以做一个配置**」
 *     ＋「**统一不用看状态**，只要在实时库存里**这个编号有尺码记录，就都是有货**」。
 *   ⚠️ 名字保留（既有判据 `test/scanPageRealms.test.js` / `test/stockStateConsistency.test.js`
 *     直接 import 它 ⇒ **一条判据都不用改** ✓）；语义 = **开关关着时的可卖状态清单** ✓。
 */

// （`SIZE_GROUP_RANGES` 已上移到文件顶部：从 `config/scanPage.js` 的 `sizeSegments` 取，
//   与缺码判定**同源**——2026-10-09 之前这里另有一份内联的硬编码副本。）

/** 这一款的类别（编号第 3 段）属于哪一组（认不出返回 null，不猜）。 */
const sizeGroupOf = (categoryCode) => {
  const key = String(categoryCode ?? '').trim().toUpperCase();
  const range = SIZE_GROUP_RANGES[key];
  return range ? { key, label: range.label, from: range.from, to: range.to } : null;
};

/**
 * ⭐⭐ 2026-10-16 晚（**成对迁移 · 改前逐字 → 改后逐字 → 依据**）：
 *   改前逐字：本处有 `isSellableCell` ＋ `sellableCountOf` **两个函数体**（判定逻辑在渲染层）
 *   改后逐字：两个都**删掉**，只留**一处转发**到 `config/scanStockPolicy.countInStockOf`
 *     （门盒/样品那套算法**逐字搬进配置**；开关开着时改走"实时库存里有记录" ✓）
 *   依据：她 2026-10-16 20:5x「**完全可以抽象出来**」＋
 *     「对于我们的销售、库存还有补货来说，它们**底层逻辑都是一样的**」⇒
 *     **口径只能有一处**（配置），本文件**一个 if 都不再写** ✗。
 *
 * ⚠️ 签名与返回值**逐字不变**（`row, columns` ⇒ 数字）：既有调用方
 *   （`realmBlock.js:61` / `replenishBlock` / `returnBlock` / `routes/scanPage/index.js` 经
 *   `sellableSizeTexts`）与既有用例**一个字都不用改** ✓。
 */
const sellableCountOf = (row, columns = []) => countInStockOf(row, columns);

/**
 * ⭐⭐ 2026-10-28 口径收口（现行）：
 *   · **特殊码** = 配置 `SIZE_SEGMENTS.ranges[code].special`
 *     （女 34/35/41/42/43 · 男 45/46/47/48，离散清单）；
 *   · 判断**必须按类别**（编号第 3 段 `A`/`B`）—— `43` 对女是特殊码、对男是普通码，
 *     用并集会把男装 43 误伤掉；
 *   · 缺货的特殊码 ⇒ 收进「特殊码」折叠块；有货的特殊码照旧在现货区。
 *
 * ⚠️ 旧注释里的“采购明细里出现过才展示 / `present_special_sizes` / `purchaseSizeReader`”
 *    已于 2026-10-14 整条退场，**不要再按旧注释理解** ✗。
 */
/** 这一款的类别码（编号第 3 段）——「编号|颜色|类别」。认不出 ⇒ 空串。 */
const categoryCodeOf = (view) => String(view?.number ?? '').split('|')[2] || '';

/**
 * ⚠️⚠️ **必须按类别判**，不能用并集 ✗ ——
 *   `43` 对**女**是特殊码（B.special），对**男**却是**普通码**（A.normal = 38–44 含 43）
 *   ⇒ 并集会把男装的 43 **误伤掉**（真机回归哨兵抓到过 ✓）。
 *   认不出类别 ⇒ **一个都不过滤**（宁可多显示，也不把能录的码藏掉 ✓）。
 */
/**
 * 视图模型里"这一款的尺码行"：读不出尺码的那一行不算（它不是一个能选的码）。
 *
 * ⭐⭐ 2026-10-14 她拍板：「**我们把采购明细给删除了，我们把特殊码给去掉吧**」＋
 *   「**其他码如果有，就写，没有不做缺码范围**」⇒ 本函数**不再有任何特殊码过滤** ✗：
 *   · `view.rows` 本来就来**实时库存**（内存快照 ✓ `scanPageService.readInventoryRows`）
 *     ⇒ **库存里有 ⇒ 就显示** ✓；没有 ⇒ 不显示、不计缺码 ✓（**零新增读** ✓）
 *   · 特殊码的“折叠”只发生在**展示分组**（`saleSizeGroups` / `purchaseSizeGroups`），
 *     不改变缺码基准（基准 = 可录范围，含特殊码）。
 */
const sizeRowsOf = (view) => (Array.isArray(view?.rows) ? view.rows : [])
  .filter((row) => !row?.unknown_size && String(row?.size_text ?? '').trim());

/**
 * ⭐ 销售建单的**两个分组**（她 2026-10-09）：
 *   · 第一组 = **有货（样品 + 门盒 ＞ 0）**的尺码 ⇒ 选中它 = **现货**；
 *   · 第二组 = 该组（类别）**目前没有的**尺码 ⇒ 选中它 = **预订**。
 *
 * ⚠️ 第二组的尺码来自**同一份视图模型**（= 该编号在「尺码管理」里有的那些码）——
 *    这样"页面上能选的码"与"提交时写得进去的码"**是同一个集合**
 *    （写入口会按「尺码管理」解析尺码，清单里没有的码提交时会被拦下）。
 * ⚠️ 降级（拿不到该类别在「尺码管理」里的清单）时**第二组为空**：
 *    只显示有库存的尺码，**绝不编造**"没有的尺码"（与既有缺码判定的降级口径一致）。
 */
/**
 * ⭐ 2026-10-14（她的最终口径）：这一款的**特殊码集合**（按编号第 3 段的类别取 `ranges[code].special`）
 *   —— 只读配置 ⇒ 零飞书读 ✓；认不出类别 / 关掉折叠 ⇒ 空集合（一条都不折 ✓ 不猜 ✗）
 * ⭐ 2026-10-16 晚：取值改从 `config/scanStockPolicy.js` 的 `specialSizesOf(categoryCode)` 来
 *   （它内部读的仍是**既有那一处** `config/scanPage.js#sizeSegments.ranges[code].special` ⇒
 *    **不是第二份** ✗；`config/scanPage.js` 里那份 `special` 才是数据）。
 */
const specialSizesOfView = (view) => {
  const cfg = SCAN_PAGE.specialSizes || {};
  if (cfg.foldable === false) return new Set();
  const separator = SCAN_PAGE.number?.separator || '|';
  const parts = String(view?.number || '').split(separator);
  const categoryCode = String(parts[2] || '').trim().toUpperCase();
  return new Set(specialSizesOf(categoryCode).map((size) => String(size)));
};

const saleSizeGroups = (view, behavior = SCAN_PAGE.REALM_SIZE_BEHAVIOR.sales) => {
  // 分组口径来自配置（`group` 不是配置里的枚举值 ⇒ 平表、不分组）；
  // ⚠️ 库存页的 0 占位是**渲染层**的事（真源在 `views/scanPageRenderer.js`），这里不管。
  const grouped = behavior.group === SCAN_PAGE.SIZE_ROW_GROUPS.GROUPED;
  const inStock = [];
  const prepaid = [];
  // ⭐ 2026-10-14：缺货的**特殊码**单独归到 `folded`（**按男女各自一块**：类别取自编号第 3 段 ✓）
  const folded = [];
  const specialSet = specialSizesOfView(view);
  for (const row of sizeRowsOf(view)) {
    const item = { size_text: String(row.size_text), count: sellableCountOf(row, view?.columns) };
    if (item.count > 0 || !grouped) inStock.push(item);
    else if (!view?.sizes_degraded || behavior.groupWhenDegraded) {
      if (specialSet.has(item.size_text)) folded.push(item);
      else prepaid.push(item);
    }
  }
  return { inStock, prepaid, folded };
};

/** 「有货」的那些尺码（写入口要按它判"这一双是现货还是预订"）。 */
const sellableSizeTexts = (view) => new Set(saleSizeGroups(view).inStock.map((item) => item.size_text));

/**
 * ⭐ 采购（补货）那一边的尺码清单：每个尺码的（样品 + 门盒）数量 +
 * 是不是"缺码"（既有口径：该类别在「尺码管理」里有、但**三种状态都没有** ⇒ 默认勾上要补）。
 * 「仓库」里有货的尺码**不预勾**（仓库能出，不必补）—— 与既有缺码口径一致。
 */
const purchaseSizeLines = (view, behavior = SCAN_PAGE.REALM_SIZE_BEHAVIOR.replenish) => {
  // ⭐⭐ 2026-10-14 晚（业务负责人逐字）：「一键补货的时候，**特殊码不能默认勾选，但是可录尺码还是显示**」
  //   ⇒ ⭐ **特殊码照样列出**（可手动勾 ✓）**只是默认不勾** ✗
  //   ⇒ 判定复用**既有那一处** helper（`specialSizesOfView` ✓ 三处共用 ✓ **不在这里再写一遍 if** ✗）
  const specialSet = specialSizesOfView(view);
  return sizeRowsOf(view).map((row) => {
    const isSpecial = specialSet.has(String(row.size_text));
    return {
      size_text: String(row.size_text),
      sellable: sellableCountOf(row, view?.columns),
      // 两个领域差别（要不要标缺码 / 缺码要不要默认勾）**全部来自配置** ✓
      missing: behavior.missing ? Boolean(row.missing) : false,
      // ⭐ 缺码才默认勾；**特殊码再缺也不默认勾**（但仍在这一行里 ✓ 她能自己勾 ✓）
      checked: behavior.checkMissingByDefault ? (Boolean(row.missing) && !isSpecial) : false,
      special: isSpecial,
    };
  });
};

/**
 * ⭐⭐ 2026-10-14：**缺货 ∩ 特殊码** —— 销售 / 库存 / 补货**三处共用这一处判据** ✓
 *   🔴 不许三处各写一遍 if ✗（她定的"配置先行 · 解耦 · 模块化"）
 *   ⚠️ 只认**已标缺货**的行（`row.missing` 来自服务层：缺货 = 可录范围 − 有货 ✓ 含特殊码 ✓）
 */
const foldedSpecialRowsOf = (view) => {
  const specialSet = specialSizesOfView(view);
  if (!specialSet.size) return [];
  return sizeRowsOf(view).filter((row) => Boolean(row.missing) && specialSet.has(String(row.size_text)));
};

/** 补货那一边：**缺货的特殊码单独一组**（⇒ 折叠块 ✓）· 其余照旧（缺码/默认勾语义不变 ✗） */
const purchaseSizeGroups = (view, behavior = SCAN_PAGE.REALM_SIZE_BEHAVIOR.replenish) => {
  const foldedSizes = new Set(foldedSpecialRowsOf(view).map((row) => String(row.size_text)));
  const lines = purchaseSizeLines(view, behavior);
  return {
    lines: lines.filter((item) => !foldedSizes.has(item.size_text)),
    folded: lines.filter((item) => foldedSizes.has(item.size_text)),
  };
};



/** 「货品标签」的去处（工作台里那个**既有**标签打印页；本文件只拼 URL，不实现打印）。 */
const LABEL_PRINT_PATH = '/workbench/label-print.html';

/** `?from=` 的取值 → 领域 id（**认不出来的一律回落缺省**，不报错、不白屏）。 */
const resolveRealm = (value) => {
  const raw = String(value ?? '').trim().toLowerCase();
  return REALMS.some((realm) => realm.id === raw) ? raw : DEFAULT_REALM;
};

/**
 * 这一款的标签打印链接：**单个** = 带上货号（标签打印页的 `keyword` 认货号，见 `labelPrintService`），
 * **批量** = 不带条件直接开那一页（她再按货号 / 状态 / 最近新增挑货）。
 */
const labelPrintUrls = (view = {}) => {
  const itemNo = String(view.item_no || String(view.number || '').split('|')[0] || '').trim();
  return {
    single: itemNo ? `${LABEL_PRINT_PATH}?keyword=${encodeURIComponent(itemNo)}` : LABEL_PRINT_PATH,
    batch: LABEL_PRINT_PATH,
  };
};

module.exports = {
  REALMS,
  DEFAULT_REALM,
  REPLENISH_REALM,
  PURCHASE_RETURN_REALM,
  REALM_TABS,
  NEW_REALM,
  REALM_EMPTY_TEXT_KEYS,
  REALM_TEXTS,
  LABEL_PRINT_PATH,
  SIZE_GROUP_RANGES,
  resolveRealm,
  labelPrintUrls,
  sizeGroupOf,
  sellableCountOf,
  saleSizeGroups,
  sellableSizeTexts,
  purchaseSizeLines,
  purchaseSizeGroups,
  foldedSpecialRowsOf,
};
