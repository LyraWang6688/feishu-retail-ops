/**
 * ⭐⭐ 工作台**四个业务领域 tab** 的**子页面清单** —— **配置先行：加减 / 改名 / 换链接只改这一个文件**。
 *
 * 业务负责人 **2026-10-09** 定的结构（逐字）：
 *   「我们就按照**四个 tab 页**来规划：**销售、采购、库存和货品**……
 *    Tab 页的顺序从左往右是：**销售、库存、采购和货品**」
 *   「在 4 个 tab 页里面，我们**都能扫同一个二维码**，但是**点击的按钮不同，触发的逻辑就不一样**」
 *
 * ⭐⭐ **2026-10-10（业务负责人看了真机之后）**：
 *   「我就以采购这个页为例吧，**这些东西你都不需要**。我不知道这是注释文字吗？**都需要删掉**。
 *    比如说采购这个 tab 页下面，我已经点到了采购，**直接出来报货、退货、到货就行**，
 *    **下面的这些文字解释就不用了**，你理解吗？」
 *   ⇒ 本文件里**所有"解释我怎么用"的文字全部退场**：
 *     领域描述行 · 子页描述 · 使用步骤 · 提示句 · 卡片副标题（`desc`）· 占位页长说明（`note`）。
 *     界面只留"**能点、能做的事**"：一级 tab 名 · 子 tab 名 · 卡片**标题 + 动作** ·
 *     功能按钮 · 内嵌的验收台 · 状态小标签（例：占位页那一个「待建设」）。
 *   ⚠️ 因此下面每条配置里**只有**：`id` / `label`（子 tab 短名）/ `kind` / 目标（链接或模板）/
 *     卡片标题 + 动作 / 状态标记；**没有一句是写给用户看的说明文**。
 *   ⭐ 验收标准（先写后做）见 `test/workbenchNoManualText.test.js`。
 *
 * ⭐⭐ **2026-10-10（业务负责人真机反馈）：「验收到货」必须是独立子页，不是同页锚点** ——
 *   「目前你的"验收到货"子卡片，**并不是我点击完之后跳转到新页面，而是一点完之后，
 *    它直接在同一个 tab 页里下面出现了。我们不应该是跳转吗？**」
 *   ⇒ 采购那一栏从"一页三卡 + 内嵌验收台"改成 **① 报货 ② 验收到货（独立子页）③ 退货**
 *     ＋ 两个占位页；报货 / 退货页上**只剩一张"去飞书表单"的卡**，
 *     验收 = **独立页**（`kind: 'orders'` / `mode: 'purchase'`，复用既有订单模块）。
 *
 * ── 她要的映射（本文件逐条落实，渲染层只负责画）─────────────────────────────
 *   | Tab  | 子页面（子 tab 短名逐字）                                                |
 *   | 销售 | ① 订单列表 ② 销售查询（直跳）③ 客户往来款（占位）                         |
 *   | 库存 | ① 全仓查询（直跳）② 手工调整                                             |
 *   | 采购 | ① 订单列表（占位，原名「采购订单列表」）② 供应商往来款（占位）              |
 *   | 货品 | ① 货品上新（直跳）② 标签打印                                            |
 *   ⚠️ **2026-10-12 变更**（都是"**只删工作台入口**"，后端一条链路都没删）：
 *      · 销售不再有「销售建单」（录入统一走扫码页）；
 *      · 库存不再有「单款查询」（她用扫一扫）；
 *      · 采购不再有「验收到货」（扫码页已做）；「采购订单列表」**改名**成「订单列表」；
 *      · 「销售查询 / 全仓查询 / 货品上新」改成**点一次就到**（`directJump: true`）。
 *
 * ── 页面的 `kind`（渲染层按它挑实现，配置里**不写死 HTML**）─────────────────
 *   `entry`                —— 「输入编号 → 打开既有页面」的小入口（**只剩**标签打印「单个」）
 *   `orders`               —— 订单列表（复用既有 `features/orders`，`mode` 决定只看销售还是只看采购）
 *                            ⚠️ 2026-10-12 起工作台**不再挂** `mode: 'purchase'`（验收入口已删），
 *                            但这个 `kind` 与既有模块**保留**（`kind` 机制照旧，加回入口只需配置）
 *   `query`                —— 她配的多维表格 AI 页面外链卡（复用 `features/query` 的卡片渲染）
 *   `links`                —— 一组卡片（外链 / 跳到本 tab 里的另一个子页）
 *   `placeholder`          —— ⭐ **占位页**：只有一个小标记「待建设」
 *   `inventory-adjustment` —— 复用既有「库存手工调整」模块（内嵌，不再跳走）
 *
 * ⭐ `directJump: true` —— **点一次就到**：点这个子 tab 直接去它的外链，**不渲染中间卡片**
 *    （她 2026-10-12：「不需要让我再去点一下那个消息查询的卡片」）。目标 URL 从**现有配置**取：
 *    查询类 → `config/query.js` 板块的 href；其余 → 恰好一张卡时取那张卡的 href。
 *    总开关 / AppLink(乙) / 一键回落 都在 `config/links.js`（`LINK_DIRECT_JUMP_ENABLED` 等）。
 *
 * ⚠️ **外链与 URL 一律只从 `config/links.js` / `config/query.js` 取**（本文件不复制字面量）。
 * ⚠️ `label` = 子 tab 上的短名（**页内不再重复写一遍** —— 那正是 2026-10-10 删掉的那一类）。
 */

// ⚠️ 2026-10-11（业务负责人批准）：采购的「报货 / 退货」两个子页**已隐藏**（那两个动作现在都在
//   扫码页各自的领域里）⇒ 本文件**不 import 任何采购飞书表单 URL**（它们写的「信息填写」表
//   已被业务负责人整表删除 ⇒ 是死链）。本文件里只留货品上新那一个表单外链。
//      已经没有任何地方再引用它们了）。
import { SUPPLIER_DIRECTORY_URL, PRODUCT_NEW_FORM_URL, ACCESSORY_SALE_FORM_URL, LABEL_BATCH_FORM_URL } from './links.js';

export const DOMAIN_TABS = [
  // ── ① 销售 ────────────────────────────────────────────────────────────────
  {
    id: 'sales',
    label: '销售',
    pages: [
      {
        id: 'sales-entry',
        label: '录单',
        kind: 'scan-cards',
        cards: [
          { icon: '👟', title: '鞋类', scanRealm: 'sales' },
          { icon: '🛒', title: '配品', href: ACCESSORY_SALE_FORM_URL },
        ],
      },
      {
        id: 'sales-orders',
        label: '订单列表',
        kind: 'orders',
        mode: 'sales',
      },
      {
        id: 'sales-query',
        label: '销售查询',
        kind: 'query',
        sectionId: 'sales-query',
        directJump: true,
      },
      {
        id: 'sales-customer-money',
        label: '客户往来款',
        kind: 'placeholder',
      },
    ],
  },

  // ── ② 库存 ────────────────────────────────────────────────────────────────
  {
    id: 'inventory',
    label: '库存',
    pages: [
      {
        id: 'inventory-point',
        label: '单点查询',
        kind: 'scan-direct',
        scanRealm: 'inventory',
      },
      {
        id: 'inventory-all',
        label: '全仓查询',
        kind: 'query',
        sectionId: 'inventory-query',
        directJump: true,
      },
      {
        id: 'inventory-adjust',
        label: '手工调整',
        kind: 'inventory-adjustment',
      },
    ],
  },

  // ── ③ 供应（原采购）────────────────────────────────────────────────────────
  {
    id: 'purchase',
    label: '供应',
    pages: [
      {
        id: 'purchase-entry',
        label: '录单',
        kind: 'scan-cards',
        cards: [
          // ⭐ 2026-11-09（业务负责人）：录单卡片顺序 = 采购 → **验收** → **退货**
          { icon: '📦', title: '采购', href: '/workbench/procurement.html' },
          { icon: '✅', title: '验收', href: '/workbench/purchase-acceptance.html' },
          { icon: '↩️', title: '退货', scanRealm: 'purchase_return' },
        ],
      },
      {
        id: 'purchase-orders',
        label: '订单列表',
        kind: 'placeholder',
      },
      {
        id: 'purchase-supplier-money',
        label: '供应商往来款',
        kind: 'placeholder',
      },
      {
        id: 'purchase-suppliers',
        label: '供应商名录',
        kind: 'links',
        directJump: true,
        cards: [
          { icon: '📇', title: '供应商名录', href: SUPPLIER_DIRECTORY_URL },
        ],
      },
    ],
  },

  // ── ⑤ 资金（独立领域；先占位，后续独立加功能）──────────────────────────────
  {
    id: 'funds',
    label: '资金',
    pages: [
      {
        id: 'funds-overview',
        label: '资金总览',
        kind: 'placeholder',
      },
    ],
  },

  // ── ④ 配置（原「货品」）────────────────────────────────────────────────────
  {
    id: 'product',
    label: '配置',
    pages: [
      {
        id: 'product-new',
        label: '货品上新',
        kind: 'links',
        // ⭐ 2026-10-12（业务负责人逐字）：「我们『货品』的 tab 页里面不是有一个『**货品上新**』的
        //    子页面吗？也希望点击『货品上新』之后，**它能直接跳转到我的表单链接**，
        //    **不用我再去点击那个消息卡片了**」
        //    ⇒ **点一次就到**：目标 = 下面那张卡的 href（唯一来源仍是 `config/links.js` 的
        //      `PRODUCT_NEW_FORM_URL`，本文件不复制字面量）。
        // ⭐⭐ 2026-10-16（业务负责人**亲口**点的"最后三处"之三 · 逐字）：
        //   「**我也没看到，可以删除**」——
        //   改前逐字：这一格里有 `arrow: '去填写 →',`
        //   改后逐字：**整行删掉**（与「配品销售」「供应商名录」同一判据、同一形状）
        //   依据：卡片本体是 `<a class="entry-card" href=…>`（整张可点）⇒ 那行箭头纯多余 ⇒ 删。
        //   ⚠️ **只删这一行箭头** ✗ —— `href` / `icon` / `title` 一个字不动。
        directJump: true,
        cards: [
          {
            icon: '🆕',
            title: '货品上新',
            href: PRODUCT_NEW_FORM_URL,
          },
        ],
      },
      {
        id: 'product-labels',
        label: '标签打印',
        // 🔴 2026-11-09（业务负责人）：
        //   ① 「点「批量打印」进的是飞书表单链接，后续就只用这个了」⇒ 批量打印 = 飞书表单；
        //   ② 「**选择编号打印**那个页面也不需要了，可以直接删除，因为点击批量打印的时候，
        //      只选择一个就可以了」⇒ 单品打印的入口 / 页面 / 前端渲染 / 后端批量查询端点**全部删除**；
        //   ③ 2026-11-09 更早一句：「入口就保持这 3 个卡片，其余都删除」—— 现在「选择编号打印」
        //      也退了 ⇒ 这一页只剩**两颗卡**：扫码打印 · 批量打印（表单）。
        //   ⚠️ 旧的筛选批量页 / 编号选择器 / `targetTemplate` 都已物理删除，不再有表单入口。
        kind: 'links',
        cards: [
          {
            icon: '📷',
            // 「扫码打印」：进标签打印页的**聚焦屏**（`scan=1` ⇒ 进页面就弹扫一扫，扫到直接排进队列）。
            title: '扫码打印',
            href: '/workbench/label-print.html?scan=1',
          },
          {
            icon: '🖨️',
            // 「批量打印」= 飞书表单（URL 唯一来源 = `config/links.js` 的 `LABEL_BATCH_FORM_URL`）。
            // 表单写「标签打印」表；后端监听新增记录自动打印（另一条链路）。
            title: '批量打印',
            href: LABEL_BATCH_FORM_URL,
          },
        ],
      },
      {
        id: 'product-info-config',
        label: '数据配置',
        // ⭐ 2026-11-10 业务负责人：这里放**一颗按钮**「同步团购券数据」——
        //   点一下才去读抖音商品接口、把接口返回的字段写回「团购券管理」（不是定时任务）。
        kind: 'voucher-sync',
      },
      {
        id: 'product-notifications',
        label: '消息通知',
        // 2026-11-09 业务负责人：放在「配置」子 tab 最右边，先占位；
        // 后续做统一通知（群聊 / 私聊）的归集页。
        kind: 'placeholder',
      },
    ],
  },

  // ── ⑥ 创作（2026-11-07 业务负责人新增；抖音创作入口）──────────────────────
  {
    id: 'creation',
    label: '创作',
    pages: [
      {
        id: 'creation-douyin',
        label: '抖音创作',
        // 先占位：具体创作工具/外链待业务负责人给。
        kind: 'placeholder',
      },
    ],
  },
];

/** 按 id 取一个领域（认不出来时**明确抛错**，不静默给一个空 tab）。 */
export const domainById = (id) => {
  const domain = DOMAIN_TABS.find((item) => item.id === id);
  if (!domain) throw new Error(`config/domains.js 找不到领域：${id}`);
  return domain;
};
