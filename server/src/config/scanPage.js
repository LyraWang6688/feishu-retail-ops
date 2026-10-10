/**
 * 扫码页（**第一版：只读查库存**）的全部可配参数 —— **配置先行**。
 *
 * 背景（业务负责人 2026-10-08 定的第一件事）：
 *   她给「货品信息」每一条出了**标签二维码**，码里的 URL 是
 *   `https://hm.bamamei.online/s/{编号}`（唯一真源在 `config/tagQrCode.js` 的
 *   `scanUrl.urlTemplate`，`编号` = `货号|颜色|类别`，做 URL 编码）。
 *   ⇒ **那些码今天扫开是 404** —— 这个文件配的就是"扫开以后那一页"。
 *
 * 本版**只读**：页面只回答"这个编号有多少双、都在哪儿、缺哪些码"，
 *   **一行都不写**（补货 / 销售 / 验收是下一版的事）。
 *
 * 放在这里的：路由挂载点 / 编号切分规则 / 三种「所属状态」的取值与列序 / 缺码文案 /
 * 取数上限 / 用户可见文案 / 价格格式 / 认哪个物理列读「品类 · 类别」。
 * 逻辑里**一个中文、一个数字都不写死** —— 改文案、换列名、调上限只动这个文件。
 *
 * ⚠️ 与 `config/labelPrint.js` 刻意**不合并**：那一份是"打印页"的排版参数
 *   （纸张 / 字号 / 每行几个尺码），这一份是"扫码看库存"的展示与取数参数。
 *   两者唯一共享的是二维码 URL 模板，而那个模板**不在这里**（在 `tagQrCode.js`）。
 */

const { readFlag, readInt } = require('./envValue');

/**
 * 路由挂载点：`GET /s/:number`。
 * ⚠️ **不放在 `/api/*` 下面**：那一段被 `API_KEY`（`x-api-key` 头）保护，
 *    而扫码的人是**手机浏览器直接打开**的，没有这个头 ⇒ 会被挡。
 *    挂到 `/s` 后走的是**工作台那一道飞书身份闸门**（未启用 503 / 未登录 401 / 白名单外 403）。
 */
const ROUTE = Object.freeze({
  // `app.js` 用 basePath 挂载，router 里用 path（两边不许各写一份）。
  basePath: '/s',
  path: '/:number',
});

/**
 * 「编号」= `货号|颜色|类别`（例：`YD6693-2|黑色|A`）。
 * 例外的形状（只有两段、或颜色里带 `|`）**不改判据**：
 * 一律按分隔符切，取前三段；切不出第 3 段就没有"类别"，缺码判定随之降级（见下）。
 */
const NUMBER = Object.freeze({
  separator: '|',
  segment: Object.freeze({ itemNo: 0, color: 1, category: 2 }),
  // 手输 URL（大小写与原表不一致）时的兜底匹配。二维码里的编号**原样就是表里的值**，
  // 正常情况下走精确匹配；这一条只为"她照着标签手打一遍"时不至于查不到。
  caseInsensitiveFallback: true,
  // 最多解几次百分号编码（Express 已经解过一次；这里容忍客户端**又编了一遍**的情况）。
  // ⚠️ 只有"还看得见 `%XX`"才继续解 —— 孤立 `%`（`50%OFF`）一个字都不动。
  decodePasses: 3,
  // 关联单元格（「实时库存.编号」）为空时，用「库存键」公式的前三段兜底认行。
  // 公式 = `货号|颜色|类别|尺码`，前三段就是「编号」+ 一个分隔符。
  stockKeyPrefixFallback: true,
});

/**
 * 「实时库存.所属状态」的三个取值 = 页面上的三列（顺序即列序）。
 * ⚠️ 她哪天在表里加/改状态：数据里出现配置外的取值**不丢、不猜**，
 *    按原值**追加一列**（列头就是原值）并记一条 warn ——
 *    否则"共 N 双"会与明细对不上（这是本页最不能出的错）。
 */
const STATES = Object.freeze({
  columns: Object.freeze(['门盒', '样品', '仓库']),
  unknownColumns: 'append',
  // 「所属状态」为空的行：同样不丢，列头用这个文案。
  emptyLabel: '未标状态',
});

/**
 * 缺码判定（设计稿上那行 `41 — — — ⚠️ 缺`）。
 *
 * 定义：**该编号的「类别」在「尺码管理」里有的尺码，在「实时库存」里数量为 0**。
 * ⚠️ 全部尺码来自「尺码管理」按**类别**（A/B，= 编号第 3 段）筛出来的那一组。
 *    · 拿不到「类别」列（列不存在 / 这个类别一条尺码都没有）⇒ **降级**：
 *      只显示有库存的尺码，**不编造缺码**，并在页面上写明"只显示有库存的尺码"+ 记 warn。
 */
const MISSING_SIZE = Object.freeze({
  enabled: true,
  // 缺码行上的标记（尺码格子里那一个小徽标）。
  badge: '缺',
  icon: '⚠️',
  // ⭐ 2026-10-10（业务负责人）：「标注「缺」的尺码 = …」那句**解释**退场 ——
  //    `⚠️ 缺` 高亮本身（`badge` / `icon`）留，它是"能看见的事"；解释"这行是什么意思"是说明书。
  // ⚠️ 遗留一处（**本任务不许改 `src/services/**`**）：`services/scanPageService.js` 仍有一行
  //    `notes.push(config.missingSize.hint)`，删掉这个 key 之后那一位是 `undefined`；
  //    渲染层 (`views/scanPageRenderer.js`) 已经把**空备注过滤掉** ⇒ 页面上不会出现空 `<li>`。
  //    等那个文件解冻，连那一行 push 一起删（TODO）。
});

/**
 * 用户可见文案。占位符用 `{...}`，由渲染层替换（**不留空段**）。
 * ⚠️ 页面是**手机上看**的，文案尽量短。
 */
const TEXTS = Object.freeze({
  pageTitle: '{itemNo} · 库存',
  priceLabel: '单价',
  identitySeparator: ' · ',
  stockHeading: '库存（共 {total} 双）',
  columnSize: '尺码',
  // 数量为 0 的格子：一个破折号（设计稿就是这么定的）。
  zero: '—',
  missingValue: '—',
  // 尺码格子里那个小徽标的 title（长按/悬停才看得到，移动端主要是给读屏用）。
  missingBadgeTitle: '缺码：这个尺码没有库存',
  unknownSizeLabel: '尺码未识别',
  updatedAtLabel: '库存更新时间',
  updatedAtUnknown: '—',
  footerNumberLabel: '编号',
  // 降级与截断都**写在页面上**，不只在日志里（她看不到日志）。
  degradedSizesNote: '暂时读不到该类别在「尺码管理」里的全部尺码，本页只显示有库存的尺码。',
  unknownStateNote: '有 {count} 双的「所属状态」不在预期取值里，已按原值另列。',
  unknownSizeNote: '有 {count} 双读不出尺码，单独列在最后一行。',
  truncatedSizesNote: '该类别尺码过多，缺码判定只看前 {count} 个。',
  notFoundTitle: '没找到这个编号',
  notFoundBody: '可能已删除、或编号变了。',
  notFoundHint: '扫到的编号：',
  // ⭐ 2026-10-09（手机白屏之后加的）：领域块**没内容时也绝不留白** —— 一张人话卡片
  //（标题 + 为什么 + 一个下一步）。她那边看到空 div 就是"白屏"，这是最后一道体验兜底。
  realmEmptyTitle: '这一块现在没有可操作的内容',
  realmEmptySalesBody: '没能确认你的身份（或这一版还没开写入口），所以先不显示建单表单。',
  realmEmptyPurchaseBody: '这一款现在没有可补货的尺码清单。',
  realmEmptyAction: '看看这一款的库存 →',
  // 空编号（`/s/` 或全是空白）与解码失败都回这一页。
  badNumberTitle: '这个链接不对',
  badNumberBody: '链接里的编号读不出来，请重新扫一次标签上的二维码。',
  errorTitle: '暂时打不开，请稍后再试',
  errorBody: '读库存时出错了。',
  busyTitle: '库存数据正在准备中',
  busyBody: '飞书那边还没准备好，请过几秒刷新这一页。',
  retryHint: '若反复出现，请把这一页截图发给运营。',
  requestIdLabel: '请求号',
  limitTitle: '这次读的库存太多了',
  limitBody: '为了避免显示不完整的库存，本页没有继续算。请稍后再试。',
});

/** 价格格式（来自「货品信息.单价」）。整数不补零：`¥399`；带角分才显示小数。 */
const PRICE = Object.freeze({
  prefix: '¥',
  decimals: 2,
});

/**
 * ⚠️ **只有这一处物理列名不在 `v1BitableSchema.js` 里**（与该文件"字段映射只有一个真源"的
 * 规矩有偏差，**这是有意的临时取舍**）：
 *   · 本轮 `config/v1BitableSchema.js` 正被**另一个子代理**改动（本任务明确不许碰它）；
 *   · 加进 schema 的映射会被 `v1:schema-check:*` 当成契约 ——
 *     而这两列在**生产 Base 上是否都叫这个名字，本机核不到**（本机 .env 指向测试 Base）。
 *     加错了 = 部署闸门直接判红、而这一版是"最急的一件事"。
 *   ⇒ 先放在这里，**读不到就降级**（缺码判定退化成"只显示有库存的尺码" + warn），
 *     绝不会因为这一列对不上而让整页打不开。
 *   ⇒ TODO（等 `v1BitableSchema.js` 解冻）：把这两条并进 schema 的
 *     `product.fields` / `sizeManagement.fields`，然后删掉这一段。
 *
 * 证据：
 *   · `product.categoryName`（「品类」，关联「品类管理」）：**生产只读核对过**
 *     （`docs/production-base-changes-2026-10-08.md` 第 55 行：货品信息 15 列里有「品类(关联)」）；
 *   · `sizeManagement.category`（「类别」）：**本机测试 Base 只读实测有这一列，而且是
 *     **多选**（`type=4`，选项 A/B）—— 一条尺码可以同时属于 A 与 B（38–43 就是 `['A','B']`）。
 *     ⇒ 判定"这个尺码属不属于这个编号的类别"必须用**成员判断**（见 service 的 `categoryValues`），
 *     不能拿整格文本做等号比较。生产那一列本机核不到。
 */
const FIELD_NAMES_PENDING_SCHEMA = Object.freeze({
  productCategoryName: '品类',
  sizeCategory: '类别',
});

/**
 * 取数上限 —— **宁可明说"这次读的太多"，也不显示一张不完整的库存表**。
 * 超限时页面给一句人话（`texts.limitTitle/Body`）+ 记一条 warn，不是静默截断。
 */
const LIMITS = Object.freeze({
  // ⚠️ 下面三条是**回退整表读**时的上限（语义与提速前一字不差）。
  // 整张「实时库存」的记录数上限（一双一条）。
  inventoryRecords: 20000,
  // 整张「货品信息」的记录数上限（按「编号」找那一条）。
  productRecords: 20000,
  // 整张「尺码管理」的记录数上限（缺码判定用）。
  sizeRecords: 5000,
  // ⭐ 下面两条是**按条件读**的单次结果上限：正常远小于它
  // （一款货品的库存行 ≤ 尺码数 × 3 种状态；一个编号 1 条）。
  // 超了说明"条件没起到过滤作用"（数据或接口异常）⇒ 同样**明确报错**，不显示半张表。
  inventoryRowsPerNumber: 1000,
  productRowsPerNumber: 200,
  // 一个类别的尺码清单超过这个数：缺码判定只看前 N 个（页面上写明）。
  sizesPerNumber: 100,
});

/**
 * ⭐ 逐张表的**取数方式**（2026-10-08 提速）—— 配置先行，一键可退回。
 *
 * 背景：提速前这一页**每次扫码整表读三张表**（货品信息 + 实时库存 + 尺码管理），
 * 其中「实时库存」随库存增长越来越慢（真机实测 5~9 秒）。
 * 改成"只读这一次真正需要的那几行"。
 *
 * 逐张表的判据（**都已在本机 Base 上只读实测过**）：
 *   · 「实时库存」→ 走 `filter` 公式
 *     `OR(CurrentValue.[编号]="<这一款的编号文本>", CurrentValue.[库存键].contains("<编号>|"))`
 *     —— 与内存里 `belongsToNumber` 的判据同源（关联命中 ∪ 公式前缀兜底），
 *       读回来**仍然过一遍 `belongsToNumber`** ⇒ 结果集与提速前逐字一致；
 *   · 「货品信息」→ `CurrentValue.[编号]="<编号>"` **精确匹配**（正常 1 条），
 *       再在内存里跑同一个 `findProduct`（大小写兜底也在里面）；
 *   · 「尺码管理」→ **保持整表读**：一共 15 条、一次请求就回来，按类别过滤省不下请求，
 *       而缺码判定的降级路径（读不到「类别」列）反而需要整表 ⟹ 不值得多一条分支。
 *
 * 🔴 **用 GET `list` 的 `filter` 公式，不用官方更推荐的 `POST .../records/search`**：
 *    本机只读实测两个接口**返回的记录形状不一样** ——
 *    GET 的公式列是 `[{text:"…"}]`、关联列**带显示文本**（与 `listAll` 逐字同形状）；
 *    search 的公式列是 `{type:1,value:[{text:"…"}]}`、关联列只有 `link_record_ids`
 *    （**没有显示文本**，会让「品类」「颜色」掉成空 ⇒ 页面内容变）。详见
 *    `services/v1BitableGateway.listByFilter` 的注释。
 *    ⚠️ 代价：GET 的 filter **区分大小写**（实测 `编号="xhb8095|黑色|A"` 匹配不到大写那条）
 *      —— 手打的大小写不一致走下面的整表回退（慢一次，结论不变）。
 *
 * ⚠️ 两种情况**自动回退整表读**（行为与提速前逐字一致，只是慢）：
 *   ① 网关没有"按条件读"这个能力（测试桩 / 注入实现）/ 关掉了本开关 /
 *      编号里带 `"` `\` `[` `]` 这类没法安全拼进公式的字符；
 *   ② 飞书不认这个公式（字段改名、权限不足…）—— 记一条 warn。
 * ⚠️ 「货品信息」按条件读**一条都没命中**时也会回退整表再找一次：
 *   宁可慢这一次，也不许把"有货"判成"没这条编号"。
 */
const READS = Object.freeze({
  // 总开关（**显式布尔**：空串 = 关掉，见 config/envValue 的规矩）。
  // 关掉 = 回到提速前的"整表读"，用于线上出问题时一键退回。
  filterEnabled: readFlag(process.env, 'SCAN_PAGE_FILTER_READ_ENABLED', true),
  // ⚠️ 按条件读的结果**一条都没有**时记一条 warn（见 events.filteredEmpty）：
  //    "库存真的为 0" 与 "filter 悄悄不生效" 在返回体上长得一样，
  //    所以这里留一条可 grep 的日志，不当成静默的成功。
  warnOnEmptyFilteredRead: true,
});

/**
 * ⭐ 进程内**短 TTL 缓存**（编号 → 视图模型）—— 兜底 + 连续扫码更快。
 *
 * 为什么 TTL 必须短且可配：这条链路本身只读，但**库存会变**
 * （销售 / 到货 / 手工调整都会动「实时库存」）——缓存只是"同一款连着扫几次不再重复读"
 * 的兜底，不是数据源。写操作**不会**主动清它（那要跨模块耦合），
 * 所以"脏窗口"就等于 `ttlMs`：默认 45 秒，进 config、可用环境变量调。
 *
 * ⚠️ 实现**不引新依赖**（`services/scanPageCache.js`：一个 Map + 时间戳）。
 * ⚠️ 只缓存 `found: true` 的视图，**不缓存"没找到"**（新品刚建档就该立刻扫得到）。
 */
const CACHE = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_PAGE_CACHE_ENABLED', true),
  // 30~60 秒是业务侧认可的窗口：短到"库存变了肉眼几乎撞不上"，
  // 长到"她连着扫同一款几次"不再打飞书。
  ttlMs: readInt(process.env, 'SCAN_PAGE_CACHE_TTL_MS', 45000, { min: 1000, max: 600000 }),
  // 最多缓存多少个编号（LRU 近似：满了先清过期的，再淘汰最久没被用到的）。
  maxEntries: readInt(process.env, 'SCAN_PAGE_CACHE_MAX_ENTRIES', 200, { min: 1, max: 10000 }),
});

/**
 * ⭐ **「实时库存」内存快照**（业务负责人 2026-10-09 同意的第二项优化）。
 *
 * 她的原话（要点）：「**首屏毫秒级，不再依赖 filter、也不会回退整表**」——
 * 前提是她要的「**库存准确**」⇒ **任何写操作必须立刻失效**（不是等 30 秒）。
 *
 * 为什么：每次扫码都要打飞书读「实时库存」（按条件读 2~5 秒；条件没命中/接口不认时
 * **回退整表读 20 秒以上** —— 线上就有一次 25 秒还没回来，她在飞书 webview 里等成白页，
 * nginx 记 499）。快照把这**整张表**搬进内存（后台每 30 秒一拍），扫码时直接查内存。
 *
 * 🔴 三条不许破的边界：
 *   ① **只读**：快照只调 `gateway.listAll`，一个字都不写（写入口的失效是另一件事）；
 *   ② **不改业务语义**：命中快照时用的是**同一份内存判据**（`belongsToNumber`），
 *      行集与"按编号过滤读"逐字一致（用例 `AC-S1` 钉着）；
 *   ③ **未就绪 / 过期 / 刷新失败一律回退**老路径，并记一条可 grep 的日志 —— 不静默。
 *
 * ⚠️ 刷新失败时**当场作废**（不是留着旧数据）：宁可慢一次（走回退真读），
 *    也不给她看一份"我们不确定还是不是最新"的库存。
 * ⚠️ 三个旋钮全部可配（开关 / 间隔 / 上限 / 过期阈值）—— 线上出问题一键退回。
 */
const SNAPSHOT = Object.freeze({
  // 总开关（**显式布尔**）。关掉 = 回到"每次扫码都去飞书读"，行为与提速后逐字一致。
  enabled: readFlag(process.env, 'SCAN_PAGE_SNAPSHOT_ENABLED', true),
  // 后台每一拍把整表拉进内存（她说 30 秒；可调）。
  refreshIntervalMs: readInt(process.env, 'SCAN_PAGE_SNAPSHOT_REFRESH_MS', 30000, { min: 1000, max: 600000 }),
  // 超过这个年龄就不再吃快照（回退真读）。默认 3 拍：连着两次刷新失败还能顶一下，
  // 再久就宁可慢也不要旧数据。
  maxAgeMs: readInt(process.env, 'SCAN_PAGE_SNAPSHOT_MAX_AGE_MS', 90000, { min: 1000, max: 3600000 }),
  // 整表上限：超了**不作快照**（回退老路径 + 记 warn）——绝不截断出一张错的库存表。
  maxRecords: readInt(process.env, 'SCAN_PAGE_SNAPSHOT_MAX_RECORDS', 20000, { min: 1, max: 500000 }),
  // 失效之后立刻重拉一次（下一次扫码尽量还能吃到快照）；关掉就只有 30 秒那一拍。
  refreshOnInvalidate: readFlag(process.env, 'SCAN_PAGE_SNAPSHOT_REFRESH_ON_INVALIDATE', true),
});

/**
 * ⭐⭐ 2026-10-09（业务负责人定）：**尺码段进配置**，缺码判定不再每次读「尺码管理」。
 *
 *   · A（**男**）= 38–48 · B（**女**）= 34–43 —— 这两段就是"这个类别应该有哪些码"；
 *   · 缺码判定 = 该编号的**类别**（编号第 3 段）对应的**配置段**里、库存为 0 的那些码；
 *   · ⚠️ **类别为空 / 配置里没有这个类别** ⇒ **降级**：只显示有货的尺码、**不做缺码提示**
 *     （现状保持，别改坏），并记一条可 grep 的 `scan.sizes.scope_unavailable`（带 reason）。
 *
 * ⭐ **一致性保险**（`consistencyCheck`）：定期拿**配置**与「尺码管理」表比对，
 *    不一致就 `logWarn('scan.size_consistency.mismatch')`（例如表里加了 49 码而配置没跟）。
 *    ⚠️ 它是**定期**的（TTL 内一次都不读那张表），不是每次扫码都读 ——
 *    否则这次提速就白做了（真机一次往返 1.5~2.5 秒）。
 */
const SIZE_SEGMENTS = Object.freeze({
  ranges: Object.freeze({
    A: Object.freeze({ label: '男', from: 38, to: 48 }),
    B: Object.freeze({ label: '女', from: 34, to: 43 }),
  }),
  consistencyCheck: Object.freeze({
    enabled: readFlag(process.env, 'SCAN_PAGE_SIZE_CONSISTENCY_CHECK_ENABLED', true),
    // 两次比对之间的最小间隔（默认 10 分钟）。`0` = 每次都查（只建议排查时用）。
    ttlMs: readInt(process.env, 'SCAN_PAGE_SIZE_CONSISTENCY_TTL_MS', 600000, { min: 0, max: 86400000 }),
  }),
});

/**
 * ⭐⭐ 2026-10-09（业务负责人定）：**单价以「货品信息」为唯一真源**，
 *   把「货品信息」整表进内存索引（按编号）⇒ 扫码时单价**零飞书调用**。
 *
 * ⚠️ 与她否掉的方案的区别：**不是**改成读「实时库存」的单价列
 *    （那会造成同一款多份单价、改价要批量改、容易不一致）。
 *
 * 机制与「实时库存」快照**完全同一套**（`services/liveInventorySnapshot.js` 那个工厂，
 * 传 `tableKey: 'product'`）：后台定期整表拉一次 + **写操作立刻失效**；
 * 未就绪 / 过期 / 刷新失败 ⇒ **回退现有过滤读**（行为与提速前逐字一致）。
 */
const PRODUCT_SNAPSHOT = Object.freeze({
  enabled: readFlag(process.env, 'SCAN_PAGE_PRODUCT_SNAPSHOT_ENABLED', true),
  refreshIntervalMs: readInt(process.env, 'SCAN_PAGE_PRODUCT_SNAPSHOT_REFRESH_MS', 60000, { min: 1000, max: 3600000 }),
  maxAgeMs: readInt(process.env, 'SCAN_PAGE_PRODUCT_SNAPSHOT_MAX_AGE_MS', 300000, { min: 1000, max: 7200000 }),
  // 整张「货品信息」的记录数上限（线上约 2 万行）：超了**不作快照**（回退过滤读 + warn）。
  maxRecords: readInt(process.env, 'SCAN_PAGE_PRODUCT_SNAPSHOT_MAX_RECORDS', 50000, { min: 1, max: 1000000 }),
  refreshOnInvalidate: readFlag(process.env, 'SCAN_PAGE_PRODUCT_SNAPSHOT_REFRESH_ON_INVALIDATE', true),
});

/**
 * 结构化日志事件名（**只读**链路：只有"看了 / 没找到 / 降级 / 出错"，没有任何写入事件）。
 * 取值放这里，是为了让她那边的现象能在 PM2 日志里按一个词 grep 到。
 * `cacheHit` / `cacheMiss` 是 2026-10-08 提速时加的：一条 `cache_hit: true/false` 就能回答
 * "这次扫码到底有没有省掉飞书请求"。
 * `lookupTiming` / `snapshot*` 是 2026-10-09 加的（她：「以后一查日志就知道卡在哪一步」）。
 */
const EVENTS = Object.freeze({
  viewed: 'scan.page.viewed',
  notFound: 'scan.page.not_found',
  badNumber: 'scan.page.bad_number',
  sizesDegraded: 'scan.sizes.scope_unavailable',
  unknownState: 'scan.state.unexpected',
  unknownSize: 'scan.size.unresolved',
  limitExceeded: 'scan.data.limit_exceeded',
  failed: 'scan.page.failed',
  cacheHit: 'scan.page.cache_hit',
  cacheMiss: 'scan.page.cache_miss',
  // 按条件读用不了 / 飞书不认这个 filter ⇒ 回退整表读（慢，但对）。
  filterFallback: 'scan.data.filter_fallback',
  // 按条件读**一条都没读到**（可能是库存真的为 0，也可能是 filter 没生效）。
  filteredEmpty: 'scan.data.filtered_empty',
  // ⭐ 一次扫码**只打一条**的分阶段耗时汇总（她：「一查日志就知道卡在哪一步」）。
  lookupTiming: 'scan.lookup.timing',
  // 内存快照的四条（命中不必单独记：「耗时行里 inventory_ms ≈ 0 且 snapshot_hit=true」就是它）。
  snapshotRefreshed: 'scan.snapshot.refreshed',
  snapshotFailed: 'scan.snapshot.refresh_failed',
  snapshotMiss: 'scan.snapshot.miss',
  snapshotInvalidated: 'scan.snapshot.invalidated',
  // ⭐ 2026-10-09：**配置里的尺码段**与「尺码管理」表比对不一致（例如表里加了 49 码）——
  //    只 warn，不改配置、不改表（配置先行；这条日志是给她/我们的排查线索）。
  sizeConsistencyMismatch: 'scan.size_consistency.mismatch',
});

const SCAN_PAGE = Object.freeze({
  route: ROUTE,
  number: NUMBER,
  states: STATES,
  missingSize: MISSING_SIZE,
  texts: TEXTS,
  price: PRICE,
  fieldNamesPendingSchema: FIELD_NAMES_PENDING_SCHEMA,
  limits: LIMITS,
  reads: READS,
  cache: CACHE,
  snapshot: SNAPSHOT,
  // ⭐ 2026-10-09 新增两块（都由她在 2026-10-09 拍板）：
  sizeSegments: SIZE_SEGMENTS,
  productSnapshot: PRODUCT_SNAPSHOT,
  events: EVENTS,
});

/** `{name}` 占位符替换（缺的值用 `missing` 顶，**不留空段**）。 */
const fillText = (template, values = {}, missing = TEXTS.missingValue) => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? missing : String(value);
  });

module.exports = {
  SCAN_PAGE,
  ROUTE,
  NUMBER,
  STATES,
  MISSING_SIZE,
  TEXTS,
  PRICE,
  FIELD_NAMES_PENDING_SCHEMA,
  LIMITS,
  READS,
  CACHE,
  SNAPSHOT,
  EVENTS,
  fillText,
};
