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
// ⭐ 2026-10-08（第一步）：三块候选的**取数**单独一条（不给 9 点推送再复用
//   `listPendingDeliveries` —— 那个方法被「二次交付成交提醒」共用，改它两条都会变）。
const { PendingPushCandidateService } = require('./pendingPushCandidateService');
const { shanghaiDayKey } = require('./saleLookupService');
// ⭐ 2026-10-08 晚：采购那行的「报货日」怎么显示（上海自然日）—— 与取数那边**同一处实现**。
const { formatReportedAtText } = require('./reportedAt');
const { resolvePendingDealPushConfig } = require('../config/pendingDealPush');
// ⭐ 2026-10-08：卡片骨架（纯函数；只排布）+ 同一套"段与段怎么拼"的规矩（两处只留一处）。
const { pendingDealPushCard, joinLineSegments } = require('../utils/pendingDealPushCard');
// ⭐ 2026-10-08：飞书错误里的真实 code / msg / log_id / method_id（唯一取用口）。
const { larkErrorFields, larkResponseError } = require('../utils/larkError');
const { logInfo, logWarn } = require('../utils/logger');

// 「维度 1」：每天 9 点（北京时间）把**最近 7 天还没收齐**的销售单推到群里，
// **按【预定 / 现货待收】分区**，**一张销售单一行**：类型标签 + 货号 尺码 + 待收金额
// + 「查看原话」文字链接（业务负责人 2026-10-07 / 2026-10-08 两次拍板；
//   目标形状与卡片骨架见 config/pendingDealPush 与 utils/pendingDealPushCard）。
//
// ⭐ 2026-10-07 下半场：同一条消息里**加【采购】区**（业务负责人逐字：
//   「你每天 9 点发通知的时候，**看未到货的情况就直接去那个表里查**，然后再把消息**深链**发到用户群里」）：
//   · 候选 = 「报货批次」里 **到货状态 = 未到货**（`PurchasePendingBatchService`，直接查那张表）；
//   · 每行 = 批次号 + 供应商（从「信息填写」关联取，取不到就不显示）+ 深链（本地映射 → 话题深链）；
//   · **顺序可配**（默认 销售在前、采购在后）；**空区连标题都不出现**（卡片里连它前面那条分割线也不出现）；
//   · 两区都空 → 不发。
//
// ⭐ 2026-10-08（业务负责人逐字）：
//   「甲 **改成消息卡片**（interactive）……长链接改成「**查看原话**」这样的**文字链接**（URL 藏起来）·
//    分区块加分割线、采购区单独一块 · 客户端不支持时降级成纯文本」
//   「其实**不需要单号**，需要的是那个**编号和尺码信息**～……**不需要退货和换货的**」
//   「② **推送失败自动重试**：失败后隔 **5/15 分钟**各重试一次，别一次失败就整天不发」
//   ⇒ 默认发**卡片**；下面那套文本模板保留成**降级**（`PENDING_DEAL_PUSH_MESSAGE_FORMAT=text`
//     或卡片发送失败时自动回退）；行内容去掉单号；待收 0 → 「已付清」；金额读不出来 → 整段不渲染；
//     第一次失败**不算跑过**，按 `retryDelaysMs`（默认 5/15 分钟）各重试一次，成功即停、绝不重发。
//
// 🔴 2026-10-07 口径大改：交易类型 = **库存有没有**（现货 / 预定），「未付」不再是类型。
//   ⭐ 2026-10-08（第一步）这一层具体化成**行级**判据，见下面 `PendingPushCandidateService`：
//     【预定】= 销售明细里 **交易类型 = 预定（行为编码 `SALE_PREPAID`）** 且 **履约状态 ≠ 已交付** 的件；
//     【现货待收】= 收款明细里 **交易类型 = 现货（行为编码 `SALE_CASH`）** 且 **收款状态 = 未收款** 的记录。
//     ⭐ 2026-10-08 晚她**纠正了聚合单位**：「**直接按照销售单号去进行聚合**」⇒ 两块都是
//     **一张销售单一行**（多件 / 多条未收款并列在那一行里），金额 = **该销售单号的未收款合计**。
//   ⇒ 原来那个"整单是否已交付"的判据函数（`pendingDealPushCriterionFor`）**已不再被本链路使用**
//     （成交提醒那边也不看它）—— 判据现在长在**行**上。
//
// 三件事刻意**不复用第二遍**：
//   · 「哪些**行**要推」= ⭐ 2026-10-08（第一步）改成**自己那条取数**
//     （`PendingPushCandidateService`）：【预定】= 销售明细里 **交易类型 = 预定** 且
//     **履约状态 ≠ 已交付** 的那些件（按销售单聚合成一行）、
//     【现货待收】= 收款明细里 **交易类型 = 现货** 且 **收款状态 = 未收款** 的那些记录
//     （同样按销售单聚合成一行）。
//     🔴 **没有再复用** `SecondDeliveryService.listPendingDeliveries`（那个方法按**销售主表**聚合、
//     判据是整单履约状态，而且被「二次交付成交提醒」共用）——改它两条推送都会变，
//     所以 9 点推送**单独取一条候选**（`docs/push-blocks-caliber-2026-10-08.md` 第一步）。
//     ⚠️ 唯一**借用**的是它身上那两句既有实现：`loadItemIndex()`（货品/配品的整表索引）与
//     `resolveDetailSize()`（关联「尺码管理」的共享解析）—— 那两句在 `includeItems` 那条路上也读，
//     不抄第二份；替身没有它们时这一轮没有货号事实（给占位、**那行照出**）。
//     ⚠️ 两块的**判据**（明细是否预定且未交付 / 收款是否现货且未收款 / 金额怎么算）只在
//     `PendingPushCandidateService` + `config/pendingPushCandidates` 那一处；
//     这里只按行自己的 `criterion` **分组**，不重新判一遍。
//   · 「这笔单当初是哪条群消息」= `SalesGroupThreadLocator`（本地映射，不写业务表）。
//   · 「深链怎么来」= `LarkMessageLinkResolver`（**只认真链接**：本地存的 → 现查；
//     拿不到就返回空，**绝不自己拼 URL**——运营兜底模板那个口子 2026-10-06 已删）。
//     ⚠️ 深链今天**基本拿不到**，原因与后续方案见
//     `docs/reports/group-message-deep-link-2026-10-06.md`。
//     ⚠️ **一行一个链接**：同一单的多行共用同一条（按销售单 record id 去重解析）。
//
// 与「第二次交付」提醒（`secondDeliveryService.sendDailyReminder`）是**两条独立的推送**：
// 那一条发**群卡片**、带「成交」按钮、点了会写库；这一条只发**一条提醒**、点进去
// 由她去话题里处理。两条各有各的按天认领记录，互不影响（一条挂了不牵连另一条）。
// ⚠️ 2026-10-08：**失败自动重试只加在这一条**（业务负责人点名的就是它）；
//    那一条只同步修了"日志打真实错误"（见 secondDeliveryService 里的注释与说明）。
//
// ⚠️ **本文件里不写用户可见的中文**：表头 / 区块标题 / 行格式 / 分隔符 / 尺码后缀 / 金额段 /
//    链接文案 / 脚注 / 卡片标记全在 `config/pendingDealPush`（配置先行）——
//    她换说法、换顺序、换分隔符都不用碰这里。
//
// ⭐ 分区顺序为什么是「预定在前、现货待收在后」（不是随手排的）：
//   · 预定单**货还没交出去**——点「成交」要走完「补尾款 + 出货 + 扣库存」三步，
//     是链条最长、最容易被拖过 7 天窗口的那一类；
//   · 现货待收单的货**已经交出去了**，剩下的只是收款一步，处理动作单一；
//   · ⇒ 先看见"链条长的"，让她当天有时间把那三步走完。顺序可配
//     （`PENDING_DEAL_PUSH_BLOCK_ORDER`），不同意就改配置，不用改代码。

// 「同一天只推一次」的认领键。⭐ 2026-10-08 起它同时是**重试的状态机**：
//   running（正在发）→ completed（发出去了，或今天本来就没有可推的 / 没群）| failed（失败，等重试）
// ⚠️ **失败不再等于"今天跑过了"** —— 这正是 2026-10-08 那次"09:05 失败 ⇒ 一整天不再发"的坑。
const dayMarkerId = (dayKey) => `pending_deal_push_day_${dayKey}`;

// 金额：**只在显示这一层**格式化；业务计算在**取数那一处**
// （两块共用一个口径：`PendingPushCandidateService.sumUnpaidAmount` = **该销售单号下
//  所有 `收款状态 = 未收款` 的金额之和**）。
// ⚠️ 三个分支各有各的口径（业务负责人 2026-10-08 点名的两条 nit）：
//   · `0`        → 「已付清」（不再渲染「待收 ¥0.00」——那笔其实已付清）；
//   · 读不出来    → `known:false` ⇒ 调用方**整段不要**（绝不渲染 `¥—`，更不能变成 `¥0.00`：
//                  那是在告诉她"这单不用收钱"）；
//   · 其它        → `¥128.00`。
const amountValueOf = (value, paidUpText) => {
  if (value === null || value === undefined || value === '') return { known: false, paidUp: false, text: '' };
  const number = Number(value);
  if (!Number.isFinite(number)) return { known: false, paidUp: false, text: '' };
  if (Math.round(number * 100) === 0) return { known: true, paidUp: true, text: paidUpText };
  return { known: true, paidUp: false, text: `¥${number.toFixed(2)}` };
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
    // ⚠️ 惰性解析（只解析一次）：注入候选取数的用例不必把整份文案配置读出来 ——
    //    与 2026-10-08 之前"构造时就 `resolvePendingDealPushConfig()`"的行为对调用方一致。
    this._settings = options.settings || null;
    // ⚠️ 依赖**全部惰性自建**（只建一次、只在该用到时）：
    //   · 生产那条路（`app.js` 只传 settings）第一次推送时按需建；
    //   · 单测里的替身一律走 `options.*`（例：`candidates` / `purchasePending`），
    //     于是**连飞书 client 都不会去建**（构造时建会要凭证 → 既有用例会红）。
    this._secondDelivery = options.secondDelivery || null;
    this._gateway = options.gateway || null;
    this._purchasePending = options.purchasePending || null;
    this._candidates = options.candidates || null;
    this._client = options.client || null;
    // 采购区的两个可选注入（惰性自建时要转交给 `PurchasePendingBatchService`）。
    this._batchLocator = options.batchLocator || null;
    this._arrivalStatus = options.arrivalStatus;
    this._candidateSettings = options.candidateSettings;
    this.locator = options.locator || new SalesGroupThreadLocator();
    this.resolver = options.resolver || new LarkMessageLinkResolver({
      client: this.client,
      lookupEnabled: this.settings.linkLookupEnabled,
    });
    // 群 id：显式传了就用它（测试注入）；传 `undefined` = 按配置每次现读。
    this.chatId = options.chatId;
    this.store = options.store || new JsonTaskStore({
      dir: path.join(__dirname, '../../data/pending_deal_push'), idField: 'task_id',
    });
    // 发完之后**把那条消息置顶**（业务负责人 2026-10-07 单独提的那个动作）。
    // ⚠️ 复用**同一个 store**：置顶状态与按天认领记录同目录（data/pending_deal_push），
    //    排查时一个目录看全；也复用同一个飞书 client，不为置顶另建连接。
    // ⚠️ 它**只干置顶这一件事**，而且内部把所有失败都吞成 warn（见 larkMessagePinService）。
    this.pin = options.pin || new LarkMessagePinService({ client: this.client, store: this.store });
    // ⭐ 失败后的**定时重试**（业务负责人 2026-10-08：隔 5/15 分钟各重试一次）。
    //   默认 = setTimeout（unref，不阻止进程退出）；单测注入假的，直接把
    //   「5 分钟 / 15 分钟」钉成断言，不需要真等。
    // ⚠️ 定时器只是"到点叫她"；**该不该发**由当天记录（`resolveAttempt`）说了算，
    //    所以进程重启丢了定时器也不会漏（下一次 tick 会按 `next_retry_at` 补上），
    //    更不会重复发（成功过就是 `completed` + `sent:true`）。
    this.scheduleRetry = options.scheduleRetry || ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
      return timer;
    });
    // interval 可能在上一次还没跑完时又触发：串行化，免得同一天两次扫描并发跑，
    // 把"按天只推一次"判成都没推过（与第二次交付同款处理）。
    this.run = Promise.resolve();
  }

  /** 配置（**只解析一次**；显式注入的以注入的为准）。读取成本与"构造时读一次"等价。 */
  get settings() {
    if (!this._settings) this._settings = resolvePendingDealPushConfig();
    return this._settings;
  }

  /**
   * 飞书 client：显式注入的优先；否则用「第二次交付」那个 service 身上的
   * （它本来就持有网关与 client —— 不为这条推送另建一个应用连接）。
   */
  get client() {
    if (this._client) return this._client;
    this._client = this.secondDelivery?.client || undefined;
    return this._client;
  }

  /** 读表网关（**全仓共享一个「网关」概念**；这里只按 client 建一次）。 */
  get gateway() {
    if (!this._gateway) this._gateway = new V1BitableGateway({ client: this.client });
    return this._gateway;
  }

  /**
   * 「第二次交付」service：**只借用**它身上那两句既有实现
   * （`loadItemIndex()` / `resolveDetailSize()`，见 `candidates` 的注释），
   * 以及它的网关 / client。⚠️ 它的 `listPendingDeliveries` 本链路**一次都不调**
   * （那个方法被「二次交付成交提醒」共用，一个字都不许改）。
   */
  get secondDelivery() {
    if (!this._secondDelivery) this._secondDelivery = new SecondDeliveryService();
    return this._secondDelivery;
  }

  /**
   * ⭐【采购】区（2026-10-07）：候选 = 「报货批次」里 到货状态 = 未到货。
   * ⚠️ gateway **按需自建**（复用本类已有的那个飞书 client，与销售侧同一个应用）：
   *   `app.js` 只传 `settings` 进来，所以这里不能要求外部必须注入 gateway
   *   （那条链路的起法一行都不用改）。要注入时传 `options.gateway` 即可。
   */
  get purchasePending() {
    if (!this._purchasePending) {
      this._purchasePending = new PurchasePendingBatchService({
        gateway: this.gateway,
        batchLocator: this._batchLocator || (this._batchLocator = new PurchaseBatchLocator()),
        settings: this._arrivalStatus,
      });
    }
    return this._purchasePending;
  }

  /**
   * ⭐ 2026-10-08（第一步）：三块候选（【预定】【现货待收】【采购】）**单独取数**。
   *   · 只给这条路用；**没有**复用 `SecondDeliveryService.listPendingDeliveries`；
   *   · 拿到本类已有的那个采购 service（它只干"哪些批次该推"），不重复建一个；
   *   · 货号/颜色/尺码复用 `secondDelivery.loadItemIndex` / `resolveDetailSize`
   *     —— 那两句的实现在第二交付那边（`includeItems` 那条路也读它们），不抄第二份。
   *   · 只有生产那个 `SecondDeliveryService` 身上有这两个方法；替身（旧用例的 stub）
   *     没有 → 那一轮没有货号事实，渲染层给占位、**那一行照出**（绝不静默丢单）。
   */
  get candidates() {
    if (!this._candidates) {
      this._candidates = new PendingPushCandidateService({
        gateway: this.gateway,
        // ⚠️ 尺码那一路由那个 service 自己从 `secondDelivery.resolveDetailSize` 取
        //   （它构造时就接了；替身没有那个方法时会退回自建的共享尺码解析）。
        secondDelivery: this.secondDelivery,
        purchasePending: this.purchasePending,
        settings: this._candidateSettings,
      });
    }
    return this._candidates;
  }

  /**
   * 三块候选（**自己那条取数**，见 `PendingPushCandidateService`）：
   *   · `sections` —— 【预定】/【现货待收】两块按**配置顺序**排好、空块已经不在里面；
   *   · `rows`     —— 上面那些行的**扁平视图**（深链、计数、落盘、脚注都按它算）。
   * ⚠️ 这是**唯一**的候选入口：渲染层不认识"销售单聚合"，只认识"一行"。
   */
  async listPendingOrders({ now } = {}) {
    const { sales = [], cash = [], purchase = [] } = await this.candidates.listCandidates({ now });
    const sections = this.buildSections([...sales, ...cash]);
    const rows = sections.flatMap((section) => section.rows);
    return { sections, rows, purchase };
  }

  /**
   * 分区：把候选**行**按行自己的 `criterion`（= 配置里的判据）分进配置声明的区块，
   * **按配置顺序**返回。
   *   · 只返回**有行**的区块（空区块不显示，全空时根本走不到这里）；
   *   · 判据不认得已声明区块的行，落进兜底区块（`otherTitle`）——**宁可多显示一块，
   *     也不让任何一行从清单里静默消失**；
   *   · `tagColor` 供卡片上的彩色标签用（文本渲染不看它）。
   * ⚠️ 判据由**取数那一处**给（`PendingPushCandidateService`：明细是否预定且未交付 / 收款是否现货且未收款），
   *    这里只做分组，**不重新判一遍**（两处判迟早走歪）。
   */
  buildSections(rows = []) {
    const { blocks = [], otherTitle = '' } = this.settings;
    const byKey = new Map(blocks.map((block) => [block.key, []]));
    const unclassified = [];
    for (const row of rows) {
      const block = blocks.find((candidate) => candidate.criterion && candidate.criterion === row.criterion);
      if (block) byKey.get(block.key).push(row);
      else unclassified.push(row);
    }
    const sections = blocks
      .map((block) => ({ key: block.key, title: block.title, tagColor: block.tagColor, rows: byKey.get(block.key) }))
      .filter((section) => section.rows.length);
    if (unclassified.length) sections.push({ key: 'other', title: otherTitle, tagColor: '', rows: unclassified });
    return sections;
  }

  /**
   * 每笔单 → 它当初那条群消息 → 深链。
   *
   * ⚠️ **一行一个链接**：同一单可能**在两块里各有一行**（预定 / 现货未收）⇒ 那两行
   *    **共用同一条**深链 —— 查映射、解析都按**销售单 record id** 去重（一张单只查一次），行只拿结果。
   *
   * 映射查不到 / 深链拿不到都**不抛**：这两种都不是致命错误（业务负责人要的是"货号颜色尺码 + 金额"
   * 先看得见），但要**留下可排查的计数**，见 `missingLinkCount` 与那两条日志。
   */
  async attachLinks(rows = []) {
    const linked = [];
    const cache = new Map();
    let missingLinkCount = 0;
    for (const row of rows) {
      const salesEntryRecordId = row.salesEntryRecordId || '';
      if (!cache.has(salesEntryRecordId)) {
        cache.set(salesEntryRecordId, await this.resolveLinkForOrder(salesEntryRecordId));
      }
      const resolved = cache.get(salesEntryRecordId);
      if (!resolved.url) missingLinkCount += 1;
      linked.push({ ...row, ...resolved, url: resolved.url });
    }
    return { rows: linked, missingLinkCount };
  }

  /** 一笔销售单的深链素材（同一条单只解析一次；`attachLinks` 负责去重）。 */
  async resolveLinkForOrder(salesEntryRecordId) {
    const record = await this.locator.findBySalesEntryRecordId(salesEntryRecordId)
      .catch((error) => {
        logWarn('sales.pending_deal_push.mapping.lookup_failed', {
          sales_entry_record_id: salesEntryRecordId, error: error.message,
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
    return {
      messageId: record?.message_id || '',
      threadId: record?.thread_id || '',
      url,
      linkSource: source,
    };
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
   * 一件商品：`货号 [颜色] 尺码码`。
   * ⭐ 2026-10-08 晚（业务负责人：「还需要在**货号和尺码中间**加上**颜色**」）⇒ `{color}` 进模板。
   * ⚠️ 颜色取不到（配品没有颜色列、或货品信息那一列为空）时 `{color}` 是空串，
   *    由 `fillLinePart` 收掉多余空格 —— 不会出现「货号  41码」。
   * ⚠️ 配品没有尺码 → **不拼「码」**（`{size}` 是空串，整段只剩名称）。
   */
  buildItemText(items = []) {
    const { itemTemplate, itemSeparator = '', sizeTemplate } = this.settings;
    return (items || [])
      .map((item) => fillLinePart(itemTemplate, {
        itemNo: item.itemNo || '',
        color: item.color || '',
        size: item.size ? fillTemplate(sizeTemplate, { size: item.size }) : '',
      }))
      .filter(Boolean)
      .join(itemSeparator);
  }

  /** 一行（销售侧）的待收金额（三态：已付清 / 有数 / 读不出来）。 */
  amountOf(row = {}) {
    return amountValueOf(row.pendingAmount, this.settings.paidUpText);
  }

  /** 纯文本降级里的**链接段**：`查看原话 https://…`（纯文本藏不住 URL，但至少不再是一行裸链接）。 */
  textLinkOf(url) {
    if (!url) return '';
    return fillLinePart(this.settings.linkTextTemplate, { text: this.settings.linkText, url });
  }

  /** 这一行的事实 → `货号 颜色 尺码`（配品没有尺码 ⇒ 不拼「码」；取不到 ⇒ 空串）。 */
  itemsTextOf(row = {}) {
    const facts = Array.isArray(row.facts) ? row.facts : (row.facts ? [row.facts] : []);
    return this.buildItemText(facts.filter(Boolean));
  }

  /**
   * **一行**（纯文本降级版）：序号 + 【预定/现货待收】 + 货号 颜色 尺码 + 待收金额 + 查看话题。
   * 逐段拼、**空的段整段不要** —— 没货号尺码 / 没深链 / 金额读不出来时不会留下 ` · ` 或空壳。
   * ⚠️ 2026-10-08：**不再出现单号**（她明确说不需要）。
   * ⚠️ 一行 = **一张销售单**（【预定】/【现货未收】各按行的 `criterion` 分组），多行**各自**一行。
   */
  buildLine(row, index, tag) {
    const { lineParts = [], lineSeparator = ' ', amountTemplate = '' } = this.settings;
    const amount = this.amountOf(row);
    const values = {
      index: index + 1,
      orderNo: row.orderNo || '',
      tag: tag || '',
      item: this.itemsTextOf(row),
      amount: amount.known
        ? (amount.paidUp ? amount.text : fillTemplate(amountTemplate, { amount: amount.text }))
        : '',
      link: this.textLinkOf(row.url),
    };
    return joinLineSegments(
      lineParts.map((part) => fillLinePart(part, values)),
      lineSeparator,
    );
  }

  /**
   * **一行**（卡片·两栏版，2026-10-08 晚她的口径）：
   *   第 1 栏 = **文字说明**（加粗货号颜色尺码 · 待收金额 / 已付清）；第 2 栏 = 「查看话题」按钮。
   * ⚠️ 与上一版（div 平铺：序号 + 标签 + 金额 + 文字链接）相比：
   *   · **去掉了序号、类型彩色标签、文字链接** —— 类型由**区域标题**（【预定】…）表达，
   *     链接由**按钮**表达（`utils/pendingDealPushCard` 渲染 open_url）；
   *   · 货号/尺码读不出来时给 `card.missingItemText` 占位，**绝不静默丢掉这一行**。
   */
  buildCardRow(row = {}) {
    const { card = {} } = this.settings;
    const amount = this.amountOf(row);
    const item = this.itemsTextOf(row);
    const values = {
      tag: '',
      index: '',
      item: item ? fillLinePart(card.itemTemplate, { item }) : '',
      amount: amount.known
        ? (amount.paidUp
          ? fillLinePart(amount.text, {})
          : fillLinePart(card.amountTemplate, { color: card.amountColor || '', amount: amount.text }))
        : '',
    };
    const segments = (card.rowTextParts || ['{item}'])
      .map((part) => fillLinePart(part, values))
      .filter(Boolean);
    if (!item && card.missingItemText) segments.unshift(String(card.missingItemText));
    return {
      text: segments.join(card.rowTextSeparator ?? ' · '),
      url: row.url || '',
    };
  }

  /**
   * 采购区一行（**同一套两栏**）：第 1 栏 = 批次号 · 供应商 · 报货日 · 录入数量；第 2 栏 = 「查看话题」。
   * ⭐ 2026-10-08 晚：加了她点名的两样（「供应商和**创建时间**以及**报货数量**」；
   *    数量取「录入数量」）。两个字段**读不到就给占位**（`card.missingXxxText`），
   *    占位设成空串则整段不出现 —— 两种都**不会**让这一批消失。
   */
  buildCardPurchaseRow(batch = {}, index = 0) {
    const { card = {}, purchaseSupplierSeparator = '、' } = this.settings;
    const reportedAt = formatReportedAtText(batch.reportedAt);
    const values = {
      index: index + 1,
      batchNo: batch.batchNo || '',
      supplier: (batch.suppliers || []).join(purchaseSupplierSeparator),
      reportedAt: reportedAt || card.missingReportedAtText || '',
      quantity: String(batch.quantity ?? '').trim() || card.missingQuantityText || '',
    };
    const text = (card.purchaseRowTextParts || ['{batchNo}'])
      .map((part) => fillLinePart(part, values))
      .filter(Boolean)
      .join(card.rowTextSeparator ?? ' · ');
    return { text, url: batch.url || '' };
  }

  /**
   * 表头文案（含**日期**与**总计**）：销售区与卡片标题**共用同一份**，不会两处慢慢走歪。
   * ⚠️ 2026-10-08 文案 nit：**只有一个区块时不补分区计数** ——
   *    她真机看到的「…：5 笔（【预定】5 笔）」把同一件事说了两遍。
   */
  buildHeader({ dayKey = '', rows = [], sections = [] } = {}) {
    const {
      headerTemplate, blockCountsTemplate, blockCountTemplate = '', blockCountSeparator = '',
    } = this.settings;
    const counts = sections.length > 1
      ? sections
        .map((section) => fillTemplate(blockCountTemplate, { title: section.title, count: section.rows.length }))
        .join(blockCountSeparator)
      : '';
    return fillTemplate(headerTemplate, {
      day: dayKey,
      total: rows.length,
      blockCounts: counts ? fillTemplate(blockCountsTemplate, { counts }) : '',
    });
  }

  /**
   * **销售区**（纯文本降级版）：表头（总数 + 分区计数）→ 每个有行的区块（标题 + 每行一行）
   * → 深链缺失脚注。文案形状全在 `config/pendingDealPush`，这里只做拼装。
   *
   * ⚠️ `salesAreaTitle` 默认**空串**（不渲染）—— 她哪天要给它加大区标题，只改配置。
   */
  buildSalesArea({ sections = [], rows = [], missingLinkCount = 0, dayKey = '' } = {}) {
    const { sectionTemplate, footerTemplate, salesAreaTitle = '' } = this.settings;
    const resolved = sections || this.buildSections(rows);
    const header = this.buildHeader({ dayKey, rows, sections: resolved });
    const body = resolved.map((section) => fillTemplate(sectionTemplate, {
      title: section.title,
      count: section.rows.length,
      lines: section.rows.map((row, index) => this.buildLine(row, index, section.title)).join('\n'),
    }));
    // 深链缺失是**已知的**（见 larkMessageLinkResolver 的实测结论），
    // 在消息里说一句，免得她以为是漏发了。
    const footer = missingLinkCount ? fillTemplate(footerTemplate, { count: missingLinkCount }) : '';
    // 大区标题：空串 = **整行都不出现**。
    const title = salesAreaTitle ? fillTemplate(salesAreaTitle, { count: rows.length }) : '';
    return [title, header, ...body, footer]
      .map((part) => String(part ?? ''))
      .filter((part) => part.trim() !== '')
      .join('\n');
  }

  /**
   * **采购区**（纯文本降级版）：大区标题（含几批）+ 每批一行 + 深链缺失脚注。
   *
   * 一行 = 批次号 + 供应商（**取不到就没有这一段，不编**）+ 报货日 + 录入数量
   * + 深链（拿不到就没有这一段）。逐段拼、空的段整段不要 —— 与销售区同一套规矩。
   * ⚠️ 报货日 / 录入数量读不到时给 `card.missingXxxText` 占位（**这一批照出**）；
   *    占位设成空串则整段不出现（与卡片那半**同一套取值**，不两处各写一遍）。
   */
  buildPurchaseArea({ batches = [], missingLinkCount = 0 } = {}) {
    const {
      purchaseAreaTitle = '', purchaseLineParts = [], purchaseLineSeparator = ' ',
      purchaseFooterTemplate = '', purchaseSupplierSeparator = '、', card = {},
    } = this.settings;
    if (!batches.length) return '';
    const lines = batches.map((batch, index) => {
      const values = {
        index: index + 1,
        batchNo: batch.batchNo || '',
        supplier: (batch.suppliers || []).join(purchaseSupplierSeparator),
        reportedAt: formatReportedAtText(batch.reportedAt) || card.missingReportedAtText || '',
        quantity: String(batch.quantity ?? '').trim() || card.missingQuantityText || '',
        link: this.textLinkOf(batch.url),
      };
      return joinLineSegments(
        purchaseLineParts.map((part) => fillLinePart(part, values)),
        purchaseLineSeparator,
      );
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
   * 整条推送（**纯文本降级**）= 各区按**配置顺序**拼起来（默认 销售 → 采购）。
   *
   * ⚠️ **空区连标题都不出现**（`buildXxxArea` 在候选为空时返回空串）。
   * ⚠️ 两个区都空时**不发** —— 但那时根本走不到这里（`_sendDailyPush` 会早退）。
   * ⚠️ 它现在是**降级出口**（`PENDING_DEAL_PUSH_MESSAGE_FORMAT=text`，或卡片发送失败时兜底）：
   *    **内容与卡片同口径**（分区 / 货号尺码 / 类型 / 待收或已付清 / 查看原话），只是没有卡片样式。
   */
  buildText({
    sections = [], rows = [], missingLinkCount = 0, dayKey = '',
    purchaseBatches = [], purchaseMissingLinkCount = 0,
  } = {}) {
    const { areas = ['sales', 'purchase'] } = this.settings;
    const renderers = {
      // 空区返回空串 ⇒ 连标题都不出现。
      sales: () => (rows.length
        ? this.buildSalesArea({ sections, rows, missingLinkCount, dayKey })
        : ''),
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
   * 整条推送（**卡片版**，默认形态）= 标题 → 各区块（块间一条分割线）→ 脚注。
   *
   * 区块顺序 = `areas`（默认 销售 → 采购）+ 销售区内部的区块顺序（配置给）。
   * ⚠️ 空块整块不出现（连它前面那条分割线也不出现）。
   * ⚠️ 只有采购候选时**没有卡片标题**：表头那句写的是"待处理的**销售单**"，
   *    销售一笔都没有时套用它是在说假话；采购区自己的块标题就是那一屏的抬头。
   */
  buildCard({
    sections, rows = [], missingLinkCount = 0, dayKey = '',
    purchaseBatches = [], purchaseMissingLinkCount = 0,
  } = {}) {
    const {
      areas = ['sales', 'purchase'], card = {},
      blockCountTemplate = '', purchaseAreaTitle = '', salesAreaTitle = '',
      footerTemplate = '', purchaseFooterTemplate = '',
    } = this.settings;
    const resolvedSections = sections || this.buildSections(rows);
    const parts = [];
    for (const key of areas) {
      if (key === 'sales' && rows.length) {
        if (salesAreaTitle) parts.push({ text: fillTemplate(salesAreaTitle, { count: rows.length }) });
        for (const section of resolvedSections) {
          parts.push({
            title: fillTemplate(blockCountTemplate, { title: section.title, count: section.rows.length }),
            // ⭐ 每行 = 两栏（文字说明 | 查看话题）；区域标题就是它的"块标题"。
            rows: section.rows.map((row) => this.buildCardRow(row)),
          });
        }
      }
      if (key === 'purchase' && purchaseBatches.length) {
        parts.push({
          title: purchaseAreaTitle
            ? fillTemplate(purchaseAreaTitle, { count: purchaseBatches.length })
            : '',
          rows: purchaseBatches.map((batch, index) => this.buildCardPurchaseRow(batch, index)),
        });
      }
    }
    const footerLines = [
      missingLinkCount ? fillTemplate(footerTemplate, { count: missingLinkCount }) : '',
      purchaseMissingLinkCount
        ? fillTemplate(purchaseFooterTemplate, { count: purchaseMissingLinkCount }) : '',
    ].filter(Boolean);
    return pendingDealPushCard({
      // ⚠️ 卡片标题 = 销售表头，**只在销售区排在最前面时才给**：
      //    表头那句写的是"待处理的**销售单**"，销售区排在采购区后面（`areas` 可配）时
      //    把它顶在卡片最上面会读成"这一屏是销售单" —— 那一屏其实是采购；没有销售一笔时同理。
      //    没有标题时由各块自己的加粗块标题当抬头。
      header: (rows.length && areas[0] === 'sales')
        ? this.buildHeader({ dayKey, rows, sections: resolvedSections })
        : '',
      card,
      parts,
      footerLines,
    });
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
    if (response.code !== 0) throw larkResponseError('发送待处理单推送失败', response);
    return response.data?.message_id || '';
  }

  /** 同一条消息的**卡片**形态（默认）。失败向上抛，由 `deliver` 决定降级 / 重试。 */
  async sendCardToChat(card, chatId) {
    if (!chatId) {
      logWarn('sales.pending_deal_push.chat_missing', {
        env: 'PENDING_DEAL_PUSH_CHAT_ID', hint: '未配置待处理单推送群 id，本次不推送',
      });
      return '';
    }
    if (!this.client?.im?.message?.create) throw new Error('待处理单推送缺少飞书 client，无法发送群消息');
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, msg_type: 'interactive', content: JSON.stringify(card) },
    });
    if (response.code !== 0) throw larkResponseError('发送待处理单推送卡片失败', response);
    return response.data?.message_id || '';
  }

  /**
   * 发送（含**降级**）：默认发卡片；卡片发不出去就用**同一份内容的纯文本**兜底一次。
   *
   * ⚠️ 为什么降级要落在代码里、而不是只靠飞书的 `fallback` 字段：官方文档写明
   *    `fallback` 触发时**只展示它自己的占位图**「请升级客户端至最新版本后查看」，
   *    **承载不了我们的文本**（见 docs/pending-push-card-and-retry-2026-10-08.md 1.1）。
   * ⇒ 真正的降级是这两个出口：
   *    ① `PENDING_DEAL_PUSH_MESSAGE_FORMAT=text`（显式要纯文本）；
   *    ② 卡片发送失败 → 自动改发纯文本（`degraded:true`，日志带飞书真实 code/msg）。
   * ⚠️ 兜底也失败时**把错抛上去** → 交给重试（而不会把这一天的推送吞掉）。
   */
  async deliver({ chatId, dayKey, card, text }) {
    if (this.settings.messageFormat === 'text') {
      return { messageId: await this.sendTextToChat(text, chatId), format: 'text', degraded: false };
    }
    try {
      return { messageId: await this.sendCardToChat(card, chatId), format: 'card', degraded: false };
    } catch (error) {
      logWarn('sales.pending_deal_push.card.fallback', {
        day: dayKey, error: error.message, ...larkErrorFields(error),
        hint: '卡片没发出去（客户端/租户不支持卡片、或接口报错）→ 改用同一份内容的纯文本兜底',
      });
      return { messageId: await this.sendTextToChat(text, chatId), format: 'text', degraded: true };
    }
  }

  /**
   * 发出后**把那条消息置顶**（业务负责人 2026-10-07 单独提的那个动作）。
   *
   * 两道闸门：
   *   · `PENDING_DEAL_PUSH_PIN_ENABLED` 关着（默认）→ **一次远端调用都不发**；
   *   · 开着 → 交给 `LarkMessagePinService`（它保证"先取消上一条、再置顶这一条"）。
   *
   * 🔴 **本方法永不抛**：置顶只是增强，消息已经发出去了。万一 pinLatest 意外抛了，
   *    这里也必须吞掉并记 warn —— 绝不能让置顶把整轮推送判成失败（那会触发一次重发）。
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

  /**
   * ⭐ 今天这一次调用**该不该真发**（唯一的判据；定时器与重试回调都走它）。
   *
   *   · 没有记录                → 第一次尝试
   *   · `sent:true` / completed → `already_ran_today`（**幂等的根据**）
   *   · `running`               → `in_progress`（进程崩在两次写之间：与改动前一致，当天不再发，
   *                               第二天照常进候选；宁可少推一天，也绝不重复发）
   *   · `failed`                → 按 `retryDelaysMs`（默认 5/15 分钟）判：没到点 `retry_waiting`、
   *                               次数用完 `retries_exhausted` / `retry_disabled`、到点则**重试**
   */
  resolveAttempt({ record, nowMs, retryDelaysMs = [] }) {
    if (!record) return { attempt: true, attemptNumber: 1, reason: '' };
    if (record.sent || record.status === 'completed') return { attempt: false, reason: 'already_ran_today' };
    if (record.status === 'running') return { attempt: false, reason: 'in_progress' };
    if (!retryDelaysMs.length) return { attempt: false, reason: 'retry_disabled' };
    const attempts = Number(record.attempts) || 1;
    if (attempts > retryDelaysMs.length) return { attempt: false, reason: 'retries_exhausted' };
    const delay = retryDelaysMs[attempts - 1];
    const failedAtMs = Date.parse(record.first_failed_at || record.failed_at || '');
    const dueAtMs = Number.isFinite(failedAtMs) ? failedAtMs + delay : NaN;
    if (Number.isFinite(dueAtMs) && nowMs < dueAtMs) {
      return {
        attempt: false, reason: 'retry_waiting', nextRetryAt: new Date(dueAtMs).toISOString(),
      };
    }
    return { attempt: true, attemptNumber: attempts + 1, reason: '' };
  }

  /** 每日推送。定时器每个 tick 都会调它，能不能真跑由"今天发出去没有 / 该不该重试"决定。 */
  sendDailyPush({ now = new Date() } = {}) {
    const next = this.run.then(
      () => this._sendDailyPush({ now }),
      () => this._sendDailyPush({ now }),
    );
    this.run = next.catch(() => undefined);
    return next;
  }

  async _sendDailyPush({ now }) {
    const { enabled, linkRequired, retryDelaysMs = [] } = this.settings;
    if (!enabled) {
      // 兜底闸门：app.js 不开定时器时其实走不到这里，但显式写出来，
      // 免得将来有人别的地方直接调它、把开关绕过。
      return { skipped: true, reason: 'disabled', pushedOrderCount: 0 };
    }
    const dayKey = shanghaiDayKey(now);
    const dayTaskId = dayMarkerId(dayKey);
    const nowMs = now.getTime();
    const record = await this.store.get(dayTaskId);
    const decision = this.resolveAttempt({ record, nowMs, retryDelaysMs });
    if (!decision.attempt) {
      logInfo('sales.pending_deal_push.skipped', {
        day: dayKey, reason: decision.reason,
        attempts: Number(record?.attempts) || 0,
        ...(decision.nextRetryAt ? { next_retry_at: decision.nextRetryAt } : {}),
      });
      return {
        day: dayKey, skipped: true, reason: decision.reason, pushedOrderCount: 0,
        attemptCount: Number(record?.attempts) || 0,
      };
    }
    const attempt = decision.attemptNumber;
    // ⚠️ 先把"正在发 + 第几次"落盘（与改动前同一条理由）：崩在"已认领、还没发出去"之间
    //    只会**少推一天**（第二天照常进候选、可自愈）；反过来会在同一个崩溃点**重复发**。
    // 🔴 但**失败不再等于跑过**：失败会把 `status` 改成 `failed` + `next_retry_at`，等重试。
    if (record) await this.store.update(dayTaskId, { status: 'running', attempts: attempt });
    else {
      await this.store.create({
        task_id: dayTaskId, day: dayKey, status: 'running', attempts: attempt, sent: false,
      });
    }
    try {
      // ⭐ 2026-10-08（第一步）：三块候选都从**这一条**来（【预定】/【现货待收】逐行 +
      //   「报货批次」里未到货的批次）。`listPendingOrders` 是唯一入口 ——
      //   `SecondDeliveryService.listPendingDeliveries` 一个字都没改（它还供着成交提醒）。
      const { sections, rows: candidateRows, purchase: purchaseCandidates = [] } =
        await this.listPendingOrders({ now });
      // 两区都空 → 与改动前一样：**不发**（只留一条记录，当天不再试）。
      if (!candidateRows.length && !purchaseCandidates.length) {
        await this.store.update(dayTaskId, {
          status: 'completed', sent: false, attempts: attempt, pushed: [], reason: 'no_pending_order',
        });
        logInfo('sales.pending_deal_push.empty', {
          day: dayKey, candidate_count: 0, purchase_candidate_count: 0, attempt,
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_pending_order' };
      }

      // ⚠️ 销售侧与采购侧的深链**各自算各自的计数**（口径不同、脚注也不同）。
      const { rows, missingLinkCount } = await this.attachLinks(candidateRows);
      if (missingLinkCount) {
        // 一次推送只记**一条**汇总（不是每行一条），否则日志会被刷满。
        logWarn('sales.pending_deal_push.link.missing', {
          day: dayKey, row_count: rows.length, missing_link_count: missingLinkCount,
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
      // 「没有深链就不推」是配置项（默认**不**这样）：深链是增强，货号颜色尺码 + 金额本身就该看得见。
      // ⚠️ 这条闸门**只管销售区**：采购区拿不到深链时**照推**（她的口径是"不许因此漏掉候选"）。
      if (linkRequired && missingLinkCount && rows.length) {
        await this.store.update(dayTaskId, {
          status: 'completed', sent: false, attempts: attempt, pushed: [], reason: 'link_unavailable',
          missing_link_count: missingLinkCount,
        });
        logWarn('sales.pending_deal_push.skipped', {
          day: dayKey, reason: 'link_unavailable', missing_link_count: missingLinkCount, attempt,
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'link_unavailable', missingLinkCount };
      }

      const chatId = this.chatId === undefined ? this.settings.chatId : this.chatId;
      // ⚠️ 区块要**带着深链**重建（`attachLinks` 之后的行才有 `url`）：
      //    `listPendingOrders` 那一份是**没有深链**的候选形状，不能拿来渲染。
      const linkedSections = this.buildSections(rows);
      const card = this.buildCard({
        sections: linkedSections, rows, missingLinkCount, dayKey, purchaseBatches, purchaseMissingLinkCount,
      });
      const text = this.buildText({
        sections: linkedSections, rows, missingLinkCount, dayKey, purchaseBatches, purchaseMissingLinkCount,
      });
      const delivery = await this.deliver({ chatId, dayKey, card, text });
      const messageId = delivery.messageId;
      if (!messageId) {
        await this.store.update(dayTaskId, {
          status: 'completed', sent: false, attempts: attempt, pushed: [], reason: 'no_chat',
        });
        return { day: dayKey, pushedOrderCount: 0, messageId: '', reason: 'no_chat', missingLinkCount };
      }
      // ⭐ 发出去了 → 顺手把**这一条**置顶（业务负责人 2026-10-07）。
      // 🔴 置顶在**推送记录落盘之前**执行，但它永不抛、永不改推送结果（见 pinMessage）：
      //    置顶挂掉只留一条 warn，下面这段"今天推过了"的记账照常进行。
      const pin = await this.pinMessage({ messageId, chatId, dayKey });
      await this.store.update(dayTaskId, {
        status: 'completed', sent: true, attempts: attempt, message_id: messageId, text, card,
        message_format: delivery.format, degraded: delivery.degraded,
        retry_delays_ms: retryDelaysMs,
        // ⚠️ 落盘的"推了哪些"仍然是**销售单 record id**（跨天/跨轮的既有排查口径；
        //    同一单的多行会重复出现 —— 那是"这一单推了几行"，不是笔数）。
        pushed: rows.map((row) => row.salesEntryRecordId),
        missing_link_count: missingLinkCount,
        link_sources: rows.map((row) => row.linkSource),
        // ⭐ 2026-10-08（第一步）：新增两块的**行身份**（明细记录 id / 收款明细 id），
        //   排查"这一行到底推没推"时不必再去猜。（追加键，不改上面那些既有键的含义。）
        pushed_rows: rows.map((row) => row.rowId),
        pushed_row_count: rows.length,
        // 采购区的落盘字段（新增键，不改既有键的含义/形状）。
        purchase_pushed: purchaseBatches.map((batch) => batch.batchNo),
        purchase_missing_link_count: purchaseMissingLinkCount,
        purchase_link_sources: purchaseBatches.map((batch) => batch.linkSource),
        pinned: pin.pinned,
        pin_reason: pin.reason,
      });
      logInfo('sales.pending_deal_push.sent', {
        day: dayKey, order_count: rows.length, missing_link_count: missingLinkCount,
        order_ids: [...new Set(rows.map((row) => row.salesEntryRecordId))],
        row_ids: rows.map((row) => row.rowId),
        purchase_batch_count: purchaseBatches.length,
        purchase_missing_link_count: purchaseMissingLinkCount,
        purchase_batch_nos: purchaseBatches.map((batch) => batch.batchNo),
        message_id: messageId,
        message_format: delivery.format, degraded: delivery.degraded, attempt,
        pinned: pin.pinned, pin_reason: pin.reason,
      });
      return {
        day: dayKey, pushedOrderCount: rows.length, messageId, missingLinkCount, reason: '',
        purchaseBatchCount: purchaseBatches.length,
        purchaseMissingLinkCount,
        messageFormat: delivery.format, degraded: delivery.degraded, attemptCount: attempt,
        pinned: pin.pinned, pinReason: pin.reason,
      };
    } catch (error) {
      // 🔴 2026-10-08：**失败不再等于"今天跑过了"** —— 记下第几次、下次什么时候再试，
      //    并把飞书返回的**真实四项**（code / msg / log_id / method_id）落进日志与记录。
      //    两次重试都用完才认输（`will_retry:false`），当天不再试，第二天照常进候选。
      const fields = larkErrorFields(error);
      const firstFailedAt = record?.first_failed_at || now.toISOString();
      const delay = retryDelaysMs[attempt - 1];
      const nextRetryAt = delay === undefined
        ? ''
        : new Date(Date.parse(firstFailedAt) + delay).toISOString();
      await this.store.update(dayTaskId, {
        status: 'failed', sent: false, attempts: attempt,
        first_failed_at: firstFailedAt, failed_at: now.toISOString(),
        next_retry_at: nextRetryAt, retry_delays_ms: retryDelaysMs,
        error: fields.msg || error.message, lark_error: fields,
      }).catch(() => undefined);
      logWarn('sales.pending_deal_push.failed', {
        day: dayKey, attempt, max_attempts: 1 + retryDelaysMs.length,
        will_retry: delay !== undefined, next_retry_at: nextRetryAt,
        error: error.message, ...fields,
      });
      if (delay !== undefined) {
        // 定时器只负责"到点叫她"；该不该发由 `resolveAttempt` 说了算（所以丢了也不会重发）。
        // ⚠️ 回调里吞掉异常：定时任务不该产生 unhandledRejection（与 shanghaiDailyScheduler 同款）。
        this.scheduleRetry(delay, () => {
          this.sendDailyPush({ now: new Date() }).catch(() => undefined);
        });
      }
      throw error;
    }
  }
}

module.exports = { PendingDealPushService, dayMarkerId, amountValueOf };
