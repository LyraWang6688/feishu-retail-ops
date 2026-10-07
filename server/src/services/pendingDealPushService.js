const path = require('node:path');
const { JsonTaskStore } = require('../infrastructure/jsonTaskStore');
const { V1BitableGateway } = require('./v1BitableGateway');
const { SecondDeliveryService } = require('./secondDeliveryService');
const { SalesGroupThreadLocator } = require('./salesGroupThreadLocator');
const { LarkMessageLinkResolver } = require('./larkMessageLinkResolver');
const { LarkMessagePinService } = require('./larkMessagePinService');
// ⭐ 2026-10-07：【采购】区的候选（「报货批次」里 到货状态 = 未到货）与它的深链。
// 抽成独立 service：本类只管"这条推送长什么样"，"哪些批次该推"是另一件事。
const { PurchasePendingBatchService } = require('./purchasePendingBatchService');
const { PurchaseBatchLocator } = require('./purchaseBatchLocator');
const { shanghaiDayKey } = require('./saleLookupService');
const { resolvePendingDealPushConfig, pendingDealPushCriterionFor } = require('../config/pendingDealPush');
const { logInfo, logWarn } = require('../utils/logger');

// 「维度 1」：每天 9 点（北京时间）把**最近 7 天还没收齐**的销售单推到群里，
// **按【预定 / 现货待收】分区**，**每笔一行**：单号 + 【预定/现货待收】 + 货号 尺码
// + 待收金额 + 那条群消息的深链（业务负责人 2026-10-07 拍板；目标形状见 config/pendingDealPush）。
//
// ⭐ 2026-10-07 下半场：同一条消息里**加【采购】区**（业务负责人逐字：
//   「你每天 9 点发通知的时候，**看未到货的情况就直接去那个表里查**，然后再把消息**深链**发到用户群里」）：
//   · 候选 = 「报货批次」里 **到货状态 = 未到货**（`PurchasePendingBatchService`，直接查那张表）；
//   · 每行 = 批次号 + 供应商（从「信息填写」关联取，取不到就不显示）+ 深链（本地映射 → 话题深链）；
//   · **顺序可配**（默认 销售在前、采购在后）；**空区连标题都不出现**；两区都空 → 不发；
//   · 🔴 **销售区逐字不变**（销售区的大区标题默认是**空串** —— 这就是"逐字不变"的实现方式）。
//
// 🔴 2026-10-07 口径大改：交易类型 = **库存有没有**（现货 / 预定），「未付」不再是类型。
//   ⇒ 候选源 = 「**预定（未交付）**」＋「**现货但钱没结清**」（= 尚未完成履约）；
//     分区**不再按交易类型编码**，改按**履约状态**判（`pendingDealPushCriterionFor`）。
//
// 三件事刻意**不复用第二遍**：
//   · 「哪些单要推」= **直接复用** `SecondDeliveryService.listPendingDeliveries`
//     （最近 7 天里**尚未完成履约**的已入账销售单）。口径只有一处实现，
//     这里一个字都不重写——将来口径变了（比如窗口从 7 天改成 10 天），改那一处即可。
//     ⚠️ 2026-10-07 只向它**多要了两样既有数据的投影**：`fulfillmentStatus`（分区判据）与
//     `items`（货号 + 尺码的事实，走 `includeItems: true`）；**筛选与金额口径一个字没动**。
//   · 「这笔单当初是哪条群消息」= `SalesGroupThreadLocator`（本地映射，不写业务表）。
//   · 「深链怎么来」= `LarkMessageLinkResolver`（**只认真链接**：本地存的 → 现查；
//     拿不到就返回空，**绝不自己拼 URL**——运营兜底模板那个口子 2026-10-06 已删）。
//     ⚠️ 深链今天**基本拿不到**，原因与后续方案见
//     `docs/reports/group-message-deep-link-2026-10-06.md`。
//
// 与「第二次交付」提醒（`secondDeliveryService.sendDailyReminder`）是**两条独立的推送**：
// 那一条发**群卡片**、带「成交」按钮、点了会写库；这一条只发**一条文字**、纯提醒、点进去
// 由她去话题里处理。两条各有各的按天认领记录，互不影响（一条挂了不牵连另一条）。
//
// ⚠️ **本文件里不写用户可见的中文**：表头 / 区块标题 / 行格式 / 分隔符 / 尺码后缀 / 脚注
//    全在 `config/pendingDealPush`（配置先行）——她换说法、换顺序、换分隔符都不用碰这里。
//
// ⭐ 分区顺序为什么是「预定在前、现货待收在后」（不是随手排的）：
//   · 预定单**货还没交出去**——点「成交」要走完「补尾款 + 出货 + 扣库存」三步，
//     是链条最长、最容易被拖过 7 天窗口的那一类；
//   · 现货待收单的货**已经交出去了**，剩下的只是收款一步，处理动作单一；
//   · ⇒ 先看见"链条长的"，让她当天有时间把那三步走完。顺序可配
//     （`PENDING_DEAL_PUSH_BLOCK_ORDER`），不同意就改配置，不用改代码。

// 「同一天只推一次」的认领键。与第二次交付同一个思路：跨天照推（只要那笔单还在窗口里、
// 还没成交），防的只是"同一天因为重启 / 重复 tick 推两遍"。
const dayMarkerId = (dayKey) => `pending_deal_push_day_${dayKey}`;

// 金额只在**显示**这一层格式化；业务计算一律用 listPendingDeliveries 给的分。
// ⚠️ `null` = "这一单的成交金额读不出来"（progressFromRecords 的 amountKnown=false），
// 必须显示成占位符 —— 绝不能让它变成 `¥0.00`：那是在告诉她"这单不用收钱"。
const money = (value) => {
  if (value === null || value === undefined || value === '') return '¥—';
  const number = Number(value);
  return Number.isFinite(number) ? `¥${number.toFixed(2)}` : '¥—';
};

/** 把 `{名字}` 换成值（认不出来的占位符在 config 里**启动时**就拦下了）。 */
const fillTemplate = (template, values) => String(template ?? '')
  .replace(/\{([^{}]*)\}/g, (whole, key) => (
    values[key] === undefined || values[key] === null ? '' : String(values[key])));

// 行里的**一段**：替换后把多余空白收掉。于是 `{itemNo} {size}` 在尺码为空时
// 变成 `B26002-52`（而不是 `B26002-52 `，更不会出现「 码」这种残句）。
const fillLinePart = (template, values) => fillTemplate(template, values).replace(/\s+/g, ' ').trim();

class PendingDealPushService {
  constructor(options = {}) {
    // 配置在这里**读一次**（启动时）：写错要在服务起来的那一刻就吵，而不是等第二天 9 点。
    this.settings = options.settings || resolvePendingDealPushConfig();
    this.secondDelivery = options.secondDelivery || new SecondDeliveryService();
    this.locator = options.locator || new SalesGroupThreadLocator();
    this.client = options.client || this.secondDelivery.client;
    this.resolver = options.resolver || new LarkMessageLinkResolver({
      client: this.client,
      lookupEnabled: this.settings.linkLookupEnabled,
    });
    // 群 id：显式传了就用它（测试注入）；传 `undefined` = 按配置每次现读。
    this.chatId = options.chatId;
    // ⭐ 【采购】区（2026-10-07）：候选 = 「报货批次」里 到货状态 = 未到货。
    // ⚠️ gateway **按需自建**（复用本类已有的那个飞书 client，与销售侧同一个应用）：
    //   `app.js` 只传 `settings` 进来，所以这里不能要求外部必须注入 gateway
    //   （那条链路的起法一行都不用改）。要注入时传 `options.gateway` 即可。
    this.purchasePending = options.purchasePending || new PurchasePendingBatchService({
      gateway: options.gateway || new V1BitableGateway({ client: this.client }),
      batchLocator: options.batchLocator || new PurchaseBatchLocator(),
      settings: options.arrivalStatus,
    });
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/pending_deal_push'), idField: 'task_id',
    });
    // 发完之后**把那条消息置顶**（业务负责人 2026-10-07 单独提的那个动作）。
    // ⚠️ 复用**同一个 store**：置顶状态与按天认领记录同目录（data/pending_deal_push），
    //    排查时一个目录看全；也复用同一个飞书 client，不为置顶另建连接。
    // ⚠️ 它**只干置顶这一件事**，而且内部把所有失败都吞成 warn（见 larkMessagePinService）。
    this.pin = options.pin || new LarkMessagePinService({ client: this.client, store: this.store });
    // interval 可能在上一次还没跑完时又触发：串行化，免得同一天两次扫描并发跑，
    // 把"按天只推一次"判成都没推过（与第二次交付同款处理）。
    this.run = Promise.resolve();
  }

  /**
   * 候选单：**复用**第二次交付那套筛选，不重写口径。
   * ⚠️ `includeItems: true` = 顺带把「货号 + 尺码」的事实要回来。它**不改筛选**：
   *    只是把本轮已经读进来的销售明细投影成 `items`（外加整表读一次「货品信息」）。
   */
  listPendingOrders({ now }) {
    return this.secondDelivery.listPendingDeliveries({ now, includeItems: true });
  }

  /**
   * 每笔单 → 它当初那条群消息 → 深链。
   *
   * 映射查不到 / 深链拿不到都**不抛**：这两种都不是致命错误（业务负责人要的是"单号 + 金额"
   * 先看得见），但要**留下可排查的计数**，见 `missingLinkCount` 与那两条日志。
   */
  async attachLinks(orders) {
    const linked = [];
    let missingLinkCount = 0;
    for (const order of orders) {
      const record = await this.locator.findBySalesEntryRecordId(order.salesEntryRecordId)
        .catch((error) => {
          logWarn('sales.pending_deal_push.mapping.lookup_failed', {
            sales_entry_record_id: order.salesEntryRecordId, error: error.message,
          });
          return null;
        });
      const { url, source } = await this.resolver.resolve({
        // 飞书深链优先；没有就用**按她给的话题格式拼的那条**（今天真正管用的一条）。
        storedAppLink: record?.app_link,
        storedThreadLink: record?.thread_link,
        messageId: record?.message_id,
        threadId: record?.thread_id,
        chatId: record?.chat_id,
      });
      if (!url) missingLinkCount += 1;
      linked.push({
        ...order,
        messageId: record?.message_id || '',
        threadId: record?.thread_id || '',
        url,
        linkSource: source,
      });
    }
    return { orders: linked, missingLinkCount };
  }

  /**
   * ⭐【采购】区：每批 → 它当初发进群的那条消息 → 深链。
   *
   * 与 `attachLinks` **同一套**取值链（`LarkMessageLinkResolver`）：
   *   · 本地映射里存着的飞书深链（采购映射里没有这个字段 → 空）；
   *   · 按她给的话题格式拼的**话题深链**（`chat_id` + `thread_id`，见 config/salesThreadLink）
   *     —— **今天真正管用**的那一条；
   *   · 现查 `im.message.get` 的 `message_app_link`（飞书哪天开始返回就自动生效）。
   *
   * ⚠️ 拿不到就留空 URL：渲染层会"照发 + 脚注"，**绝不因此漏掉候选**（她的口径）。
   */
  async attachPurchaseLinks(batches = []) {
    const linkIndex = await this.purchasePending.loadLinkIndex();
    const linked = [];
    let missingLinkCount = 0;
    for (const batch of batches) {
      const materials = this.purchasePending.resolveThreadLinkFrom(linkIndex, batch.batchNo);
      const { url, source } = await this.resolver.resolve({
        storedAppLink: '',
        storedThreadLink: materials.threadLink,
        messageId: materials.messageId,
      });
      if (!url) missingLinkCount += 1;
      linked.push({
        ...batch,
        messageId: materials.messageId,
        threadId: materials.threadId,
        url,
        linkSource: source,
      });
    }
    return { batches: linked, missingLinkCount };
  }

  /**
   * 分区：把候选单按**履约判据**分进配置声明的区块，**按配置顺序**返回。
   *   · 只返回**有单**的区块（空区块不显示，全空时根本走不到这里）；
   *   · 判据不认得已声明区块的单，落进兜底区块（`otherTitle`）——**宁可多显示一块，
   *     也不让任何一笔单从清单里静默消失**。
   */
  buildSections(orders = []) {
    const { blocks = [], otherTitle = '' } = this.settings;
    const byKey = new Map(blocks.map((block) => [block.key, []]));
    const unclassified = [];
    for (const order of orders) {
      const criterion = pendingDealPushCriterionFor(order);
      const block = blocks.find((candidate) => candidate.criterion && candidate.criterion === criterion);
      if (block) byKey.get(block.key).push(order);
      else unclassified.push(order);
    }
    const sections = blocks
      .map((block) => ({ title: block.title, orders: byKey.get(block.key) }))
      .filter((section) => section.orders.length);
    if (unclassified.length) sections.push({ title: otherTitle, orders: unclassified });
    return sections;
  }

  /** 一件商品：`货号 尺码码`。**配品没有尺码 → 不拼「码」**（`{size}` 是空串，整段只剩名称）。 */
  buildItemText(items = []) {
    const { itemTemplate, itemSeparator = '', sizeTemplate } = this.settings;
    return (items || [])
      .map((item) => fillLinePart(itemTemplate, {
        itemNo: item.itemNo || '',
        size: item.size ? fillTemplate(sizeTemplate, { size: item.size }) : '',
      }))
      .filter(Boolean)
      .join(itemSeparator);
  }

  /**
   * 一笔单一行：序号 + 单号 + 【预定/现货待收】 + 货号 尺码 + 待收金额 + 深链。
   * 逐段拼、**空的段整段不要** —— 没货号尺码 / 没深链时不会留下 ` · ` 或空壳。
   */
  buildLine(order, index, tag) {
    const { lineParts = [], lineSeparator = ' ' } = this.settings;
    const values = {
      index: index + 1,
      orderNo: order.orderNo || '',
      tag: tag || '',
      item: this.buildItemText(order.items),
      amount: money(order.pendingAmount),
      link: order.url || '',
    };
    return lineParts
      .map((part) => fillLinePart(part, values))
      .filter(Boolean)
      .join(lineSeparator);
  }

  /**
   * **销售区**（2026-10-07 之前那条推送的正文，逐字不变）：
   * 表头（总数 + 分区计数）→ 每个有单的区块（标题 + 每单一行）→ 深链缺失脚注。
   * 文案形状全在 `config/pendingDealPush`，这里只做拼装。
   *
   * ⚠️ `salesAreaTitle` 默认**空串**（不渲染）—— 这是"销售区逐字不变"的实现方式。
   *    她哪天要给它加大区标题，只改配置，本方法一行都不用动。
   */
  buildSalesArea({ orders = [], missingLinkCount = 0, dayKey = '' } = {}) {
    const {
      headerTemplate, blockCountsTemplate, blockCountTemplate = '', blockCountSeparator = '',
      sectionTemplate, footerTemplate, salesAreaTitle = '',
    } = this.settings;
    const sections = this.buildSections(orders);
    const blockCounts = sections
      .map((section) => fillTemplate(blockCountTemplate, { title: section.title, count: section.orders.length }))
      .join(blockCountSeparator);
    const header = fillTemplate(headerTemplate, {
      day: dayKey,
      total: orders.length,
      blockCounts: sections.length ? fillTemplate(blockCountsTemplate, { counts: blockCounts }) : '',
    });
    const body = sections.map((section) => fillTemplate(sectionTemplate, {
      title: section.title,
      count: section.orders.length,
      lines: section.orders.map((order, index) => this.buildLine(order, index, section.title)).join('\n'),
    }));
    // 深链缺失是**已知的**（见 larkMessageLinkResolver 的实测结论），
    // 在消息里说一句，免得她以为是漏发了。
    const footer = missingLinkCount ? fillTemplate(footerTemplate, { count: missingLinkCount }) : '';
    // 大区标题：空串 = **整行都不出现**（默认就是空串，所以销售区逐字不变）。
    const title = salesAreaTitle ? fillTemplate(salesAreaTitle, { count: orders.length }) : '';
    return [title, header, ...body, footer]
      .map((part) => String(part ?? ''))
      .filter((part) => part.trim() !== '')
      .join('\n');
  }

  /**
   * **采购区**（2026-10-07 新增）：大区标题（含几批）+ 每批一行 + 深链缺失脚注。
   *
   * 一行 = 批次号 + 供应商（**取不到就没有这一段，不编**）+ 深链（拿不到就没有这一段）。
   * 逐段拼、空的段整段不要 —— 与销售区同一套规矩（不会留下 ` · ` 或空壳）。
   */
  buildPurchaseArea({ batches = [], missingLinkCount = 0 } = {}) {
    const {
      purchaseAreaTitle = '', purchaseLineParts = [], purchaseLineSeparator = ' ',
      purchaseFooterTemplate = '', purchaseSupplierSeparator = '、',
    } = this.settings;
    if (!batches.length) return '';
    const lines = batches.map((batch, index) => {
      const values = {
        index: index + 1,
        batchNo: batch.batchNo || '',
        supplier: (batch.suppliers || []).join(purchaseSupplierSeparator),
        link: batch.url || '',
      };
      return purchaseLineParts
        .map((part) => fillLinePart(part, values))
        .filter(Boolean)
        .join(purchaseLineSeparator);
    });
    const title = purchaseAreaTitle
      ? fillTemplate(purchaseAreaTitle, { count: batches.length })
      : '';
    const footer = missingLinkCount
      ? fillTemplate(purchaseFooterTemplate, { count: missingLinkCount })
      : '';
    return [title, ...lines, footer]
      .map((part) => String(part ?? ''))
      .filter((part) => part.trim() !== '')
      .join('\n');
  }

  /**
   * 整条推送 = 各区按**配置顺序**拼起来（默认 销售 → 采购）。
   *
   * ⚠️ **空区连标题都不出现**（`buildXxxArea` 在候选为空时返回空串）。
   * ⚠️ 两个区都空时**不发** —— 但那时根本走不到这里（`_sendDailyPush` 会早退，
   *    与改动前"没有待处理单就不推"的行为一致）。
   * ⚠️ 不传 `purchaseBatches` 时输出与改动前**逐字相同**（既有用例是这条的哨兵）。
   */
  buildText({
    orders = [], missingLinkCount = 0, dayKey = '',
    purchaseBatches = [], purchaseMissingLinkCount = 0,
  } = {}) {
    const { areas = ['sales', 'purchase'] } = this.settings;
    const renderers = {
      // 空区返回空串 ⇒ 连标题都不出现。
      sales: () => (orders.length ? this.buildSalesArea({ orders, missingLinkCount, dayKey }) : ''),
      purchase: () => this.buildPurchaseArea({
        batches: purchaseBatches, missingLinkCount: purchaseMissingLinkCount,
      }),
    };
    return areas
      .map((key) => (renderers[key] ? renderers[key]() : ''))
      .map((part) => String(part ?? ''))
      .filter((part) => part.trim() !== '')
      .join('\n');
  }

  /**
   * 发到**群的主聊天**（不是话题）：话题是"每笔单一条讨论"，这条推送是"今日待办清单"，
   * 挂在主聊天里才看得见全貌。所以**不带** `reply_in_thread`、也不引用任何消息。
   */
  async sendTextToChat(text, chatId) {
    if (!chatId) {
      // 没配群 = 不知道发哪儿。绝不回落到发给某个人（与采购 / 成交提醒同一条纪律）。
      logWarn('sales.pending_deal_push.chat_missing', {
        env: 'PENDING_DEAL_PUSH_CHAT_ID', hint: '未配置待处理单推送群 id，本次不推送',
      });
      return '';
    }
    if (!this.client?.im?.message?.create) throw new Error('待处理单推送缺少飞书 client，无法发送群消息');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
    });
    if (response.code !== 0) throw new Error(`发送待处理单推送失败: ${response.msg} (Code: ${response.code})`);
    return response.data?.message_id || '';
  }

  /**
   * 发出后**把那条消息置顶**（业务负责人 2026-10-07 单独提的那个动作）。
   *
   * 两道闸门：
   *   · `PENDING_DEAL_PUSH_PIN_ENABLED` 关着（默认）→ **一次远端调用都不发**；
   *   · 开着 → 交给 `LarkMessagePinService`（它保证"先取消上一条、再置顶这一条"）。
   *
   * 🔴 **本方法永不抛**：置顶只是增强，消息已经发出去了。万一 pinLatest 意外抛了，
   *    这里也必须吞掉并记 warn —— 绝不能让置顶把整轮推送判成失败。
   */
  async pinMessage({ messageId, chatId, dayKey }) {
    if (!this.settings.pinEnabled) return { pinned: false, reason: 'pin_disabled', previousMessageId: '' };
    try {
      return await this.pin.pinLatest({ messageId, chatId, day: dayKey });
    } catch (error) {
      logWarn('sales.pending_deal_push.pin.failed', {
        day: dayKey, message_id: messageId, error: error.message,
        hint: '置顶抛了异常（本不该发生）；已吞掉，推送本身不受影响',
      });
      return { pinned: false, reason: 'pin_failed', previousMessageId: '' };
    }
  }

  /** 每日推送。定时器每个 tick 都会调它，能不能真跑由"今天推过没有"决定。 */
  sendDailyPush({ now = new Date() } = {}) {
    const next = this.run.then(
      () => this._sendDailyPush({ now }),
      () => this._sendDailyPush({ now }),
    );
    this.run = next.catch(() => undefined);
    return next;
  }

  async _sendDailyPush({ now }) {
    const { enabled, linkRequired } = this.settings;
    if (!enabled) {
      // 兜底闸门：app.js 不开定时器时其实走不到这里，但显式写出来，
      // 免得将来有人别的地方直接调它、把开关绕过。
      return { skipped: true, reason: 'disabled', pushedOrderCount: 0 };
    }
    const dayKey = shanghaiDayKey(now);
    const dayTaskId = dayMarkerId(dayKey);
    // 先落记录再发（与第二次交付同一条理由）：崩在"已认领、还没发出去"之间只会**少推一天**，
    // 第二天照常进候选、可自愈；反过来会在同一个崩溃点产生**第二条**消息。
    if (await this.store.get(dayTaskId)) {
      logInfo('sales.pending_deal_push.skipped', { day: dayKey, reason: 'already_ran_today' });
      return { day: dayKey, skipped: true, reason: 'already_ran_today', pushedOrderCount: 0 };
    }
    await this.store.create({ task_id: dayTaskId, day: dayKey, status: 'running' });
    try {
      const candidates = await this.listPendingOrders({ now });
      // ⭐ 【采购】区（2026-10-07）：候选 = 「报货批次」里 到货状态 = 未到货。
      // ⚠️ 采购那半边**读表失败不许拖垮销售那半边**（销售是既有的、每天都在用的那条）：
      //    读失败只记 warn，当成"今天没有采购候选"。
      let purchaseCandidates = [];
      try {
        purchaseCandidates = await this.purchasePending.listPendingBatches();
      } catch (error) {
        logWarn('sales.pending_deal_push.purchase_candidates_failed', {
          day: dayKey, error: error.message,
        });
      }
      // 两区都空 → 与改动前一样：**不发**（只留一条记录）。
      if (!candidates.length && !purchaseCandidates.length) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_pending_order' });
        logInfo('sales.pending_deal_push.empty', {
          day: dayKey, candidate_count: 0, purchase_candidate_count: 0,
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_pending_order' };
      }

      const { orders, missingLinkCount } = await this.attachLinks(candidates);
      if (missingLinkCount) {
        // 一次推送只记**一条**汇总（不是每笔一条），否则日志会被刷满。
        logWarn('sales.pending_deal_push.link.missing', {
          day: dayKey, order_count: orders.length, missing_link_count: missingLinkCount,
          hint: 'im.message.get 未返回 message_app_link；深链只能靠发消息时存进 sales_group_threads 的 app_link',
        });
      }
      // 采购区的深链：本地映射（`data/purchase_group_messages` 的 chat_id + thread_id）→
      // 话题深链（与销售侧**同一个** `buildSalesThreadLink`）。
      // ⚠️ 拿不到就留空 —— 由渲染层"照发 + 脚注"，**绝不因此漏掉候选**。
      const { batches: purchaseBatches, missingLinkCount: purchaseMissingLinkCount } = await this.attachPurchaseLinks(purchaseCandidates);
      if (purchaseMissingLinkCount) {
        logWarn('sales.pending_deal_push.purchase_link.missing', {
          day: dayKey, batch_count: purchaseBatches.length, missing_link_count: purchaseMissingLinkCount,
          hint: '本地映射（data/purchase_group_messages）里这一批没有 chat_id + thread_id；深链只能靠发采购单时记下的那条映射',
        });
      }
      // 「没有深链就不推」是配置项（默认**不**这样）：深链是增强，单号 + 金额本身就该看得见。
      // ⚠️ 这条闸门**只管销售区**：采购区拿不到深链时**照推**（她的口径是"不许因此漏掉候选"）。
      if (linkRequired && missingLinkCount && orders.length) {
        await this.store.update(dayTaskId, {
          status: 'completed', pushed: [], reason: 'link_unavailable',
          missing_link_count: missingLinkCount,
        });
        logWarn('sales.pending_deal_push.skipped', {
          day: dayKey, reason: 'link_unavailable', missing_link_count: missingLinkCount,
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'link_unavailable', missingLinkCount };
      }

      const chatId = this.chatId === undefined ? this.settings.chatId : this.chatId;
      const text = this.buildText({
        orders, missingLinkCount, dayKey, purchaseBatches, purchaseMissingLinkCount,
      });
      const messageId = await this.sendTextToChat(text, chatId);
      if (!messageId) {
        await this.store.update(dayTaskId, { status: 'completed', pushed: [], reason: 'no_chat' });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_chat', missingLinkCount };
      }
      // ⭐ 发出去了 → 顺手把**这一条**置顶（业务负责人 2026-10-07）。
      // 🔴 置顶在**推送记录落盘之前**执行，但它永不抛、永不改推送结果（见 pinMessage）：
      //    置顶挂掉只留一条 warn，下面这段"今天推过了"的记账照常进行。
      const pin = await this.pinMessage({ messageId, chatId, dayKey });
      await this.store.update(dayTaskId, {
        status: 'completed', message_id: messageId, text,
        pushed: orders.map((order) => order.salesEntryRecordId),
        missing_link_count: missingLinkCount,
        link_sources: orders.map((order) => order.linkSource),
        // 采购区的落盘字段（新增键，不改既有键的含义/形状）。
        purchase_pushed: purchaseBatches.map((batch) => batch.batchNo),
        purchase_missing_link_count: purchaseMissingLinkCount,
        purchase_link_sources: purchaseBatches.map((batch) => batch.linkSource),
        pinned: pin.pinned,
        pin_reason: pin.reason,
      });
      logInfo('sales.pending_deal_push.sent', {
        day: dayKey, order_count: orders.length, missing_link_count: missingLinkCount,
        order_ids: orders.map((order) => order.salesEntryRecordId),
        purchase_batch_count: purchaseBatches.length,
        purchase_missing_link_count: purchaseMissingLinkCount,
        purchase_batch_nos: purchaseBatches.map((batch) => batch.batchNo),
        message_id: messageId,
        pinned: pin.pinned, pin_reason: pin.reason,
      });
      return {
        day: dayKey, pushedOrderCount: orders.length, messageId, missingLinkCount, reason: '',
        purchaseBatchCount: purchaseBatches.length,
        purchaseMissingLinkCount,
        pinned: pin.pinned, pinReason: pin.reason,
      };
    } catch (error) {
      // 这一天不再重试（按天认领已经落盘），但把失败写进记录里，排查时能看到是哪一天掉的；
      // 第二天会重新进候选、照常再推一次。
      await this.store.update(dayTaskId, { status: 'failed', error: error.message }).catch(() => undefined);
      logWarn('sales.pending_deal_push.failed', { day: dayKey, error: error.message });
      throw error;
    }
  }
}

module.exports = { PendingDealPushService, dayMarkerId, money };
