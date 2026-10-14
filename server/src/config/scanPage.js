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

const { readFlag, readInt, readList, readString } = require('./envValue');

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
  // ⭐ 2026-10-12：**验收落地页**的路径模板（**唯一来源**）—— 路由用它拼跳转与表单目标，
  //    渲染层用它给「未到货批次」那几条链接（两边各写一份必然漂）。
  //    `{batchNo}` 会被 URL 编码后填进去；手输兜底那个 GET 表单用 `acceptPath`。
  // ⭐⭐ 2026-10-12（治根）：**新二维码 = 记录 ID 直达** —— `GET/POST /r/{recordId}`。
  //
  // 起因（她今天的口径，逐字）：「如果必须得要一个完全不变的标识，那我们是不是可以用
  //   【记录 ID】呀？……虽然它的这些信息可能会变，但我还是用它**不变的记录 ID**」。
  // 根因：二维码里存的**编号**（`货号|颜色|类别`）是**会变的快照** —— 她打印时类别为空、
  //   之后补上 ⇒ 旧码对不上（今天的 400 事故就是这么来的）。
  // ⇒ **新二维码一律 `/r/{recordId}`**；**旧 `/s/{编号}` 照旧可用**（旧贴纸不重打也能扫）。
  // 🔴 `/r` 与 `/s` **必须是同一个 router 实例**（`app.js` 双挂载）——
  //    各建一个实例就会有两套写服务 / 两条按人串行队列 ⇒ **幂等可靠性直接破**。
  recordBasePath: '/r',
  recordPath: '/:recordId',
  // 「拿到 recordId 但那条货品读不到」时的**回退**：URL 上若还带着编号（`?number=`）就按编号再试。
  recordNumberQuery: 'number',
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
  // ⭐⭐ 2026-10-12：**编号兜底匹配**（业务负责人真机事故：二维码里编号 = `MK31-1|咖色|`
  //    —— **缺「类别」段** ⇒ 精确匹配查不到 ⇒ 页面回 400 / 原始错误页）。
  //    二维码那条已另行修复；**这一条是扫码页侧的兜底**（旧标签、以及任何"编号缺段"的扫码）。
  //
  //    口径（Lead 已批，逐条）：
  //      · **按分隔符拆段**，用（**货号 + 颜色**）再查一次（**类别为空就忽略它**）；
  //      · **唯一命中才采用**；**0 条 / 多条一律维持"找不到"**（不猜 ✗）；
  //      · 🔴 **不做任何 OCR 相似字符纠正**（二维码是机器码 —— "静默进错款"比"找不到"更坏）；
  //      · 🔴 **不整表读**（按「货号」过滤读一次；过滤读不可用时才走既有整表回退，
  //        与 `readProductsByNumber` 同一套兜底，不是"新加一次整表读"）；
  //      · 命中时给**一条轻提示**（不写说明书，见 texts.numberFallbackHint）。
  fallbackMatch: Object.freeze({
    enabled: true,
  }),
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
  // ⚠️ 2026-10-11：缺省领域改回**销售** ⇒ 这一页不再只叫"库存页"，标题改成与领域无关的
  //    （浏览器的标签页标题；她手机上是飞书 webview 的标题）。
  pageTitle: '{itemNo} · 扫码',
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

  // ⭐ 2026-10-13（她："开新单子系统挂一个 86900" ✗）：提交后回跳页顶部那条指引（配置先行 ✓）
  justSubmittedPrefix: '✅ 上一单已提交',
  justSubmitted: '✅ 上一单已提交（{orderNo}）· 请扫下一个标签',
  // ⭐ 2026-10-13：**销售领域入口页**（不带编号 ✓ = 她说的"销售首页"）的文案
  salesHomeTitle: '请扫下一个标签',
  salesHomeHint: '用飞书「扫一扫」扫下一个标签；也可以在手输框里填编号。',
  salesHomeJustSubmitted: '✅ 上一单已提交（{orderNo}）',
  salesHomeManualLabel: '编号（货号|颜色|尺码）',
  salesHomeManualSubmit: '打开这一款',
  // 降级与截断都**写在页面上**，不只在日志里（她看不到日志）。
  degradedSizesNote: '暂时读不到该类别在「尺码管理」里的全部尺码，本页只显示有库存的尺码。',
  unknownStateNote: '有 {count} 双的「所属状态」不在预期取值里，已按原值另列。',
  unknownSizeNote: '有 {count} 双读不出尺码，单独列在最后一行。',
  truncatedSizesNote: '该类别尺码过多，缺码判定只看前 {count} 个。',
  // ⭐⭐ 2026-10-12：**编号兜底**（(c)）命中时的轻提示 —— 一句话，不写说明书。
  numberFallbackHint: '二维码里的编号少了类别，建议重打标签（已按货号 + 颜色找到这一款）。',
  // ⭐⭐ 2026-10-12：兜底**也没找到**时的两句人话（0 条 / 多条）+ 下一步（回扫码页 / 再扫一次）。
  notFoundFallbackMissHint: '这个编号少了类别，按货号 + 颜色也没找到这一款 —— 请核对标签上的货号 / 颜色，或重打标签。',
  notFoundAmbiguousHint: '这个编号少了类别，按货号 + 颜色匹配到多款，没法确定是哪一双 —— 请核对标签，或重打标签。',
  notFoundBackLabel: '再扫一次',
  notFoundTitle: '没找到这个编号',
  notFoundBody: '可能已删除、或编号变了。',
  notFoundHint: '扫到的编号：',
  // ⭐ 2026-10-09（手机白屏之后加的）：领域块**没内容时也绝不留白** —— 一张人话卡片
  //（标题 + 为什么 + 一个下一步）。她那边看到空 div 就是"白屏"，这是最后一道体验兜底。
  realmEmptyTitle: '这一块现在没有可操作的内容',
  realmEmptySalesBody: '没能确认你的身份（或这一版还没开写入口），所以先不显示建单表单。',
  realmEmptyPurchaseBody: '这一款现在没有可补货的尺码清单。',
  // ⭐ 2026-10-11：**验收**领域的"空态"（她还没在工作台点【验收】，或那一场已结束/过期）——
  //    这是"下一步去哪儿"的事实，不是用法说明。
  // 🔴 2026-10-12（业务负责人）：「**验收还是只在扫码页**，我不需要在工作台」
  //    ⇒ 验收领域**没带批次号**时不再把她支去工作台，而是**自己列未到货的批次**（点一条就进）。
  //    这张人话卡只在"那两种情况"下出现：**一个未到货批次都没有**（或读表失败）——
  //    所以它只说事实 + 给下面那个手输框，不指路去别处。
  realmEmptyAcceptanceBody: '现在没有未到货的批次：可以直接填批次号进验收。',
  // ⭐ 2026-10-13（配品页）：这一块原来借用了「补货」那句（说的是尺码清单✗ 与配品无关）⇒ 单独一句 ✓
  // ⭐ 2026-10-14 晚：退货自己的人话（她截图里退货页显示配品 —— 那条口径已随配品搬走 ✗）
  realmEmptyReturnBody: '这一款现在没有可退的尺码。',
  // ⚠️ 下面那句留给配品（accessory 空态用；配品已搬去工作台「销售 → 配品」✓）
  realmEmptyPurchaseReturnBody: '现在没有可以加进本单的配品。',
  // ⭐ 2026-10-13：「上新」那一块（外链 tab的兵底）—— 不迷路、不冒充建单表单
  realmEmptyNewBody: '「上新」是一张飞书表单：点切换条上那一颗就直接去填。',
  // ⭐ 验收领域自己开工（她点【验收】时看到的那一块）：
  //    ① 列未到货批次（每条一行、点进 `/s/accept?batch=…`）；② 手输批次号兜底。
  //    ⚠️ 全是**功能名/事实**，没有说明书腔。
  // ⭐⭐ 2026-10-12 21:11（她真机）：输入框空着点【进入验收】⇒ 表单 GET 不带 batch ⇒ **原地重画同一页**
  //    ⇒ 她的感受是"点了之后里面啥也没有" ✗ ⇒ 空提交必须**即时给一句人话**（就在那颗按钮上方）。
  // ⭐⭐ 2026-10-12 21:20（她"一直点那个按钮"）：反馈脚本的**兜底文案**（属性为空时用它，**绝不许把按钮变空白**）。
  submitSubmittingFallback: '正在提交，请不要重复点…',
  // ⭐ 金额是必填（>0）：前端**即时**就能感知（点按钮就有提示，**不发请求**）。
  // 批次行上那个数量的前缀（她那边叫「录入数量」—— 与 9 点推送同一口径）。
  // 每一条批次行右边那句事实（供应商 / 录入数量，**读得到才显示**）。
  realmEmptyAction: '看看这一款的库存 →',
  // 空编号（`/s/` 或全是空白）与解码失败都回这一页。
  badNumberTitle: '这个链接不对',
  badNumberBody: '链接里的编号读不出来，请重新扫一次标签上的二维码。',
  // 2026-10-13：收款方式读表后，读不到时给她的人话（只加，不动既有键）
  paymentMethodsUnavailableTitle: '收款方式读不到',
  paymentMethodsUnavailableBody: '收款方式那张表现在读不到，这一单先别录；过一会儿再试，或找技术同事。',
  errorTitle: '暂时打不开，请稍后再试',
  // 2026-10-13 骨架屏的两句文案（她：加载到中间一直白屏）—— 见 renderScanSkeleton
  skeletonLoading: '数据加载中',
  // ⭐ 2026-10-14（她真机：「页面已经打开、但内容迟迟不出来」⇒ 骨架停住 ✗）：
  //   取数失败 / 拿回的还是骨架 ⇒ 给**一句人话 + 重试入口**（不再静默吞错 ✗ 也不自动死磕 ✗）
  skeletonErrorText: '这次没读到，点「重试」再来一次',
  skeletonRetryLabel: '重试',
  // ⭐ 2026-10-14（她："停留在「数据加载中」的时间太长"）：超时阈值 + 提示语
  //   · 到点还没回来 ⇒ 先给「还在读…」✓ 并**自动再取一次** ✓（只自动一次 ✓ 不自动死磕 ✗）
  //   · 阈值**显式数字**（缺变量时用 readInt 的默认值 ✓ 不写 `|| 兜底` ✗）
  skeletonSlowMs: readInt(process.env, 'SCAN_PAGE_SKELETON_SLOW_MS', 2500, { min: 0, max: 60000 }),
  skeletonSlowText: '还在读…',
  errorBody: '读库存时出错了。',
  busyTitle: '库存数据正在准备中',
  busyBody: '飞书那边还没准备好，请过几秒刷新这一页。',
  retryHint: '若反复出现，请把这一页截图发给运营。',
  requestIdLabel: '请求号',
  limitTitle: '这次读的库存太多了',
  limitBody: '为了避免显示不完整的库存，本页没有继续算。请稍后再试。',
  // ── ⭐ 2026-10-11「本单条」（一单多双 · 多次扫码）──────────────────────────
  // 她原话：「我们在扫码页卖了多双鞋的时候，怎么可以一双订单多次扫码呢？」
  // ⇒ 每个扫码页（任意领域）顶部固定一条：
  //    `本单：N 双` +（有草稿才出现）【提交这一单】+ 【继续扫下一个】。
  // ⚠️ 只留"能点、能做的事" + 状态：这里一句话都不解释"我为什么要这样用"。
  draftBarLabel: '本单',
  // 状态：本单现在累积了几双（数字来自扫码会话，**跨编号共用**）。
  draftBarCount: '本单：{count} 双',
  // 能点的：【继续扫下一个】（飞书客户端内 = AppLink 打开扫一扫，见下面的 `SCAN_NEXT`）；
  // **不是**飞书客户端（电脑浏览器 / 手机自带浏览器）时，这里只剩一句如实的状态 ——
  // 「这台设备没有扫码能力」，**绝不给一个点了没反应的按钮**。
  scanNextLabel: '继续扫下一个',
  scanNextHint: '这里不能扫码：请用飞书的「扫一扫」再扫下一个标签。',
});

/**
 * ⭐ 2026-10-11：【继续扫下一个】的手段（**飞书官方文档实查过**，见本次任务报告）。
 *
 * 两条官方路子都查了 `open.feishu.cn` 的官方文档（`.md?lang=zh-CN`，规矩：不许 web_search）：
 *   ① **H5 JSAPI `tt.scanCode`**（`/document/client-docs/gadget/-web-app-api/device/scan-code/scancode`）：
 *      官方写明"该接口支持小程序和**网页应用**调用"，网页应用 Android/iOS **V3.44.0+**、**PC ✗**；
 *      但用它要引入 JSSDK ＋ 走 JSAPI 鉴权（`h5sdk.config`：appId/timestamp/nonceStr/signature，
 *      签名要服务端拿 access_token → jsapi_ticket 现算）＋ 配 **H5 可信域名**；
 *      ⚠️ 而这一页的硬性设计是"**一行前端脚本都没有**"（2026-10-09 手机白屏之后定的，
 *      有用例当哨兵）—— 为它引入 `<script>`/JSSDK 会把这层不确定性又装回来。
 *   ② **AppLink 打开扫一扫**（`/document/common-capabilities/applink-protocol/supported-protocol/open-scan-function`）：
 *      `https://applink.feishu.cn/client/qrcode/main`，**飞书 5.7.0+**、**PC 端不支持**，无参数。
 *      ⇒ **就是"点一下直接扫下一个"**，而且只是一个**真链接**（零 JS、零鉴权、零新请求）。
 *
 * ⇒ 选 ②：同一个用户结果（点一下进飞书扫一扫 → 扫下一张标签 → 回到同一浏览器会话继续加单），
 *   代价最小、且不破坏"没有 JS 也 100% 正确"那条底线。
 *   设备能力判据 = **服务端看 UA**（`views/scanPageRenderer.js` 的 `canScanNextWithFeishu`）：
 *   飞书客户端（Android/iOS）才给按钮；电脑 / 手机自带浏览器给 `scanNextHint` 那句人话。
 */
const SCAN_NEXT = Object.freeze({
  // 飞书官方 AppLink：打开「扫一扫」（改它只改这一处）。
  applink: readString(process.env, 'SCAN_NEXT_APPLINK', 'https://applink.feishu.cn/client/qrcode/main'),
});

/**
 * ⭐⭐ 2026-10-11（业务负责人）：「**提交这一单只在销售页显示**」。
 *
 * 那条【本单：N 双】在每个领域页顶部都有（她一单跨编号累积时随时看得到几双）；
 * 但**那颗真正的提交按钮**只在**她点名的领域**里出现 —— 其余领域页顶部只有
 * `本单：N 双` ＋【继续扫下一个】。
 *
 * ⚠️ 为什么进配置而不是在渲染层写死 `'sales'`：领域是活的（加减领域、哪个领域能提交都可能变），
 *    改它**不该动渲染层**（配置先行）。取值必须是 `views/scanPageRealm.js` 里 `REALMS[].id`；
 *    认不出的取值 = 那个领域页上不显示（**绝不猜**）。
 * ⚠️ 环境变量给了值就用它（逗号分隔）；**没给** = 只有 `sales`。
 */
const DRAFT_BAR = Object.freeze({
  submitRealms: readList(process.env, 'SCAN_DRAFT_BAR_SUBMIT_REALMS') || ['sales'],
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
  // ⭐ 2026-10-13（她：加载到中间一直白屏）：**骨架屏开关**。
  //   · **默认 false** ⇒ `/s/<编号>` 与改动前**逐字相同**（既有整页 AC 一条都不动 ✓ 不假绿 ✓）；
  //   · 打开（线上 `.env` 由 Lead 拿到她授权后设 `SCAN_PAGE_SKELETON_ENABLED=true`）⇒
  //     首屏立刻回骨架（占位 + 正在读取…），数据由**同一段脚本** `fetch('?data=1')` 拿回来；
  //     ⚠️ `?data=1` **走的还是同一个 `service.lookup`**（不新增取数路径 ✗）。
  //   ⚠️ **显式布尔**（`readFlag` 给缺省值），不写 `||` 兜底 —— 否则"清空变量"关不掉 ✗

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
  // ⭐ 2026-10-14（她逐字：「那份**按款缓存**：**去掉**（永远最新 ✓ 每次真读 ✓）」）：
  //   ⇒ **默认关闭**——同一个编号连扫两次也**真的重新读**（不再拿 45 秒前的视图 ✗）
  //   ⚠️ 两个**快照**（实时库存 / 货品信息）**都保留** ✗（她同日明确：「两个快照都留」✓）
  //   ⇒ 想开回来是**显式**开（`SCAN_PAGE_CACHE_ENABLED=true` ✓ 不是靠默认值兜底 ✓）
  enabled: readFlag(process.env, 'SCAN_PAGE_CACHE_ENABLED', false),
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
/**
 * ⭐⭐ 2026-10-12（她拍板 · 方案 A）：「**提交完 ⇒ 自动回首页，而首页 = 销售页** ✓」
 * 成功页的"回哪儿 / 停多久 / 按钮叫什么"**只在这里定义**（三路共用 ✓）。
 */
/**
 * ⭐⭐ 2026-10-12（她真机 `POST …` ⇒ 400 / 1ms、无法判断"她手上是不是旧页面" ✗）：
 * **页面的构建标识**——由**渲染那一页的进程**写进每个写表单的隐藏字段，
 * 她提交时随 body 带回来 ⇒ 日志里就能回答"她点的是**旧构建渲染的页面**吗" ✓
 */
const PAGE_BUILD = [
  String(process.env.APP_VERSION || (() => { try { return require('../../package.json').version; } catch (_) { return ''; } })() || 'unknown'),
  String(process.env.APP_COMMIT || '').slice(0, 7),
].filter(Boolean).join('@');

const SUCCESS_RETURN = Object.freeze({
  enabled: true,
  // 先让她**看到结果**，约 2 秒后再跳（不许秒跳 ✗）
  delaySeconds: 2,
  // ⭐ 三路（销售 / 补货 / 退货）成功后回哪个领域：**销售**（"把扫码页的首页当作销售页"）
  homeRealm: 'sales',
  // ⭐⭐ 她 2026-10-12 又拍：**验收成功 ⇒ 回【未到货批次列表】**（= 验收自己的首页 ✓，别"顺手统一"改掉 ✗）
  //    ⚠️ 两类都在**这一处**区分（别散在各 handler 里 ✗）。
  acceptHome: 'pendingBatches',
  // ⭐⭐ 2026-10-13（她："我开新单子的时候，系统会挂一个 86900" ✗）：
  //   提交成功后自动回跳的目标是 **`/s/<她刚提交的那个编号>`** ⇒ 页面上下文仍是上一单那个产品 ✗
  //   ⇒ 回跳 URL 上带一个**无状态**的标记（`?done=<单号>`），编号页据此在顶部给一条明确指引 ✓
  noticeKey: 'done',
  // ⭐⭐ 2026-10-13（她的口径：「"提交这一单"就说明**这一单已经结了**呀，如果我再操作的话，
  //   **应该就跟这一单没关系了**，除非我是选"**再加一双**"呀」）：
  //   ⇒ 销售领域的"首页"必须是**产品无关**的页（`/s` 空编号无效 ✗ ⇒ 用挂载前缀本身 ✓）
  //   ⇒ 提交成功后回跳**这里**（不再回 `/s/<刚提交的编号>` ✗）
  homePath: '/',
  label: '返回扫码',
});

// ─────────────────────────────────────────────────────────────────────────────
// ⭐⭐ 2026-10-13 纯函数（**无 IO**）—— 判据单一来源，谁接 scanPageRealm.js 都能直接调
//   ⚠️ 缺码判据**只算 default**：special（女 34/43 · 男 46/47/48）**不参与** ✓
// ─────────────────────────────────────────────────────────────────────────────
const expandRange = (segment) => {
  const [a, b] = Array.isArray(segment) ? segment : [segment?.from, segment?.to];
  const from = Number(a);
  const to = Number(b);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
};

/** 缺码判断 = **default − 已有**（special 不参与 ✓）。返回缺的那些码（升序）。 */
const missingSizes = (category, existingSizes = []) => {
  const range = SIZE_SEGMENTS.ranges[category] || SIZE_SEGMENTS.ranges[
    Object.keys(SIZE_SEGMENTS.ranges).find((k) => SIZE_SEGMENTS.ranges[k].label === category) || ''
  ];
  if (!range) return [];
  const have = new Set((existingSizes || []).map((s) => Number(s)));
  return expandRange(range.default).filter((size) => !have.has(size));
};

/** 展示清单 = **default ∪ 采购明细里出现过的 special**（没出现过 ⇒ 不展示 ✓）。 */
const displaySizes = (category, presentSpecialSizes = []) => {
  const range = SIZE_SEGMENTS.ranges[category];
  if (!range) return { base: [], extra: [] };
  const present = new Set((presentSpecialSizes || []).map((s) => Number(s)));
  return {
    base: expandRange(range.default),
    extra: Array.from(range.special).filter((size) => present.has(size)),
  };
};

// ⭐ 2026-10-14：特殊码折叠块（**显式布尔** —— 不许 `|| 兜底`：那样"清空变量"会关不掉 ✗）
// ⭐ 2026-10-14：补货列表版式（每格「尺码 × 数量」· 一行几格**走配置** ✓）
const PURCHASE_SIZES = Object.freeze({
  columnsPerRow: 3,
});

const SPECIAL_SIZES = Object.freeze({
  foldable: true,             // 缺货的特殊码收进折叠块
  collapsedByDefault: true,   // 默认收起（原生 `<details>` 不带 `open`）✓
  toggleLabel: '特殊码',       // 文案走配置（渲染层不写死中文 ✗）
});

const SIZE_SEGMENTS = Object.freeze({
  // ⭐⭐ 2026-10-13（业务负责人逐字确认 · 见 docs/size-range-special-sizes-2026-10-13.md）
  //   每个类别**显式三段**，一处定义（渲染层与缺码判断**都读它** ✗ 不许各写一份）：
  //   · enterable = **可录范围**（女 34–43 / 男 38–48）—— 都能录 ✓
  //   · default   = **默认展示 + 缺码判断**（女 35–42 / 男 38–45）✓
  //   · special   = **特殊码**（女 34,43 / 男 46,47,48）——
  //                 ⚠️ **只在「采购明细」里出现过才展示**（不看实时库存 ✗），
  //                 没出现 ⇒ 不显示、**也不算缺码** ✓（不天天提示她"缺 43 / 缺 48"）
  //   ⚠️ from/to **保留作兼容**（= enterable 的两端）：
  //      既有渲染层（views/scanPageRealm.js:151）按 from/to 取值 ⇒ **语义不变** ✓
  //      **新代码请读 enterable / default / special** ✓
  ranges: Object.freeze({
    A: Object.freeze({
      label: '男', from: 38, to: 48,
      enterable: Object.freeze([38, 48]),
      // ⭐ 2026-10-14 她的命名：`normal`（普通码）= ①库存缺码判据 ②销售页预订范围 ✓
      //   `default` 保留为**兼容别名**（同一个数组 ✓ 一份真源 ✗ 不是第二份）
      normal: Object.freeze([38, 45]),
      default: Object.freeze([38, 45]),
      special: Object.freeze([46, 47, 48]),
    }),
    B: Object.freeze({
      label: '女', from: 34, to: 43,
      enterable: Object.freeze([34, 43]),
      // ⭐ 2026-10-14 她**两次**改口径，以**最后一次**为准（逐字）：
      //   「男鞋的范围就是 38-45，女鞋就是 36-41 …… 如果这些没有就是缺码，
      //    以及在销售页的预定逻辑，就是让这个范围**扣减已有的库存**，
      //    其余的特殊码，如果有就显示，没有不会做缺码显示」
      //   ⇒ 默认段 = 缺码判据 = 销售页「预订」的候选（预订 = 段内 − 有货）。
      //   ⇒ 特殊码**不参与缺码**（有就显示 ✓ 没有不显示、也不算缺 ✓）。
      //   ⇒ 见 docs/scan-size-scope-ruling-2026-10-14.md（改前：36-42 / 更早 35-42）
      // ⭐ 2026-10-14 她的最终口径：「女鞋就是 **36-41**」⇒ normal = 缺码判据 + 预订范围 ✓
      normal: Object.freeze([36, 41]),
      default: Object.freeze([36, 41]),
      // ⭐ 2026-10-14 她逐字：女码特殊码 = **34 · 42 · 43**（42 现在也算特殊码 ✓ 普通码是 36–41 ✓）
      special: Object.freeze([34, 35, 42, 43]),
    }),
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
    // ⭐ 2026-10-13：`/accept`（批次列表页）的分段耗时（她点 4、5 次才过去 ✗）
    // ⭐ 2026-10-13：销售首页（不带编号）被打开过（手输编号那条也记一条 ✓）
    salesHomeOpened: 'scan.sales_home.opened',
  viewed: 'scan.page.viewed',
  notFound: 'scan.page.not_found',
  // ⭐⭐ 2026-10-12：`/r/{recordId}` 这条路的正向证据 / 失败证据。
  recordViewed: 'scan.page.record_viewed',
  recordMissing: 'scan.page.record_missing',
  recordLookupFailed: 'scan.page.record_lookup_failed',
  // ⭐⭐ 2026-10-12：编号兜底匹配（唯一命中 / 多命中 / 读失败）各一条。
  numberFallback: 'scan.page.number_fallback',
  // ⭐⭐ 2026-10-12：`/r/{recordId}` 取商品那一段（记录 id 直查）失败 —— **回退按编号**，不 500。
  recordFallback: 'scan.page.record_fallback',
  numberFallbackAmbiguous: 'scan.page.number_fallback_ambiguous',
  numberFallbackFailed: 'scan.page.number_fallback_failed',
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

/** 「货品上新」飞书表单（**与工作台同一份 URL** —— 那边在 `public/workbench/config/links.js`）。
 *  ⚠️ 它只做一件事：把用户送过去 ⇒ **空值 / 非 http(s) 一律当场报错**（静默的话那一颗点不动 ✗）。 */
const PRODUCT_NEW_FORM_URL_DEFAULT =
  'https://scnzoiwpgxik.feishu.cn/share/base/form/shrcnX0GlNcSOujePgWOLTTWr4m';
const resolveProductNewFormUrl = (env = process.env) => {
  const raw = readString(env, 'PRODUCT_NEW_FORM_URL', PRODUCT_NEW_FORM_URL_DEFAULT).trim();
  if (!/^https?:\/\/\S+$/.test(raw)) {
    throw new Error('「上新」外链（PRODUCT_NEW_FORM_URL）必须是 http(s) 链接：'
      + '留空或写错会让扫码页那颗「上新」点不动（不静默）');
  }
  return raw;
};

/**
 * ⭐⭐ 2026-10-13「金额两步走」（业务负责人逐字口径，见 docs/scan-sales-payment-flow-2026-10-13.md）：
 *   第 2 步（**提交后**）= 整单付款：三档横向一排 + 付款方式可加多行 + 赠品 + 「跳过」。
 *   ⭐ **可填可不填**：不填 = **待补充的信息单**（**不是失败** ✗ 不许报错拦人）。
 */
const PAYMENT_STEP = Object.freeze({
  heading: '整单付款（可填可不填）',
  statusLabel: '付款情况',
  methodLabel: '收款方式',
  amountLabel: '实付多少',
  submitButton: '提交整单付款',
  // ⚠️ 这一句是"跳过不是失败"的口径落点（AC-2S3 按「待补充」这个词钉住）。
  // ⚠️ 措辞注意：这一组的注释与文案里**不要**出现那个 f-word（有 AC 用 /skip.{0,80}…/ 钉
  //    "跳过照常算提交成功"，写了就自己把自己打红）。
  pendingNote: '不填也提交成功：这一单先记成「待补充」的信息单，之后去工作台补收款即可（照常算这一单已提交）。',
  // ⭐ 2026-10-13：【跳过】= **一个 POST 动作**（走既有动作分发 ⇒ 复用成功页渲染 ✓ 零 JS ✓）
  skipAction: 'payment_skip',
  // ⭐ 2026-10-13（她点头：「**当然啊，可以写也可以不写啊**」）：
  //    第 2 步【提交整单付款】= 一个 POST 动作 ⇒ 走**既有那条诚实钱路**
  //    （`routes/workbench.js:215` 的 `followup.addPayment(...)`，写同一张「收款明细」✓）
  payAction: 'payment_pay',
  payButton: '提交整单付款',
  // 三种结果的人话（三条红线：写成功才说已收 ✓ / 跳过=待补充 ✓ / 失败就说失败 ✓）
  paidNote: '已记下这笔收款。',
  payPendingNote: '没填金额 ⇒ 这一单先记成「待补充」的信息单，之后去工作台补收款即可。',
  payFailedNote: '这笔收款**没记上**（不是"已收"）。请重试一次，或去工作台「销售」那一页补。',
  skipButton: '跳过（稍后去工作台补）',
  workbenchHint: '要补实收 / 收款：去工作台「销售」那一页。',
});

/** ⭐ 成功页三入口（AC-2S4）：主入口 = 继续录下一单；次入口 = 去工作台看这一单 / 补整单付款。 */
const SALE_SUCCESS = Object.freeze({
  title: '✅ 本单提交成功',
  continueButton: '继续录下一单（去扫码）',
  workbenchButton: '去工作台看这一单',
  fillPaymentButton: '补整单付款',
});

const SCAN_PAGE = Object.freeze({
  route: ROUTE,
  // ⭐⭐ 2026-10-13（她：加载到中间一直白屏）：**骨架屏开关**（**显式布尔**，缺省 false）。
  //   · false（默认）⇒ `/s/<编号>` 与改动前**逐字相同** ⇒ 既有整页 AC 一条不用改 ✓（不假绿）
  //   · true（线上 `.env`：`SCAN_PAGE_SKELETON_ENABLED=true`，由 Lead 拿到她授权后打开）⇒
  //     首屏立刻回骨架（占位 + 正在读取…），数据由骨架里**同一段脚本** `fetch('?data=1')` 拿回来；
  //     ⚠️ `?data=1` 走的还是**同一个 `service.lookup`**（不新增取数路径 ✗）
  //   ⚠️ 必须放在**这个**对象里 —— 上一版我插到了子配置对象里 ⇒ `SCAN_PAGE.skeleton` 是 undefined
  //      ⇒ 真进程开关**根本没生效**（真墙钟那次因此作废 ✗）。这条教训由下面那条"真配置"AC 钉住 ✓
  // ⭐ 2026-10-14（她：「六格没问题、不要改动」+「增加了一个新毛病…有中间态数据加载中」✗）：
  //   骨架**只服务"首次进入"**（不带 `?from=`）；**点六格（带 `?from=`）直接出整页** ✗ 不再有中间态 ✓
  //   **显式布尔**（缺省 true = 我们要的行为 ✓），不写 `||` 兜底 ✗
  skeleton: {
    enabled: readFlag(process.env, 'SCAN_PAGE_SKELETON_ENABLED', false),
    firstEntryOnly: readFlag(process.env, 'SCAN_PAGE_SKELETON_FIRST_ENTRY_ONLY', true),
  },
  // ⭐⭐ 2026-10-13（她最终顺序）：「上新」tab = **直达外链**（不是一个页面领域）。
  //   ⚠️ 工作台那份在 `public/workbench/config/links.js`（**我不碰那个文件** ✗ 只读它 ✓）——
  //      这里**另存一份**，并有**"不许漂移"测试**（两边逐字一致 ✓ 见
  //      `test/scanPageRealmTabs.test.js` 的 AC-RB5）。
  //   🔴 2026-10-13：**空值 / 写错 ⇒ 在配置解析时当场报错**（不是静默渲染成一颗点不动的死链 ✗）。
  //      与工作台那份逐字同源（`public/workbench/config/links.js` 的 `PRODUCT_NEW_FORM_URL` ✓）。
  // 2026-10-14：**三个领域"怎么列尺码"的唯一来源**（业务负责人：「需要做配置～」）。
  //   只收代码里**真实存在**的轴：`sizeRowsOf` 的 special 规则已经是一份真源 ⇒ 不动 ✗；
  //   库存 0 占位的真源在 `views/scanPageRenderer.js` ⇒ 不入表 ✗；`product` 真源未定位 ⇒ 不入表 ✓。
  SIZE_ROW_GROUPS: Object.freeze({ GROUPED: 'instock+reserve' }),
  REALM_SIZE_BEHAVIOR: Object.freeze({
    sales: Object.freeze({ group: 'instock+reserve', groupWhenDegraded: false, missing: false, checkMissingByDefault: false }),
    inventory: Object.freeze({ group: null, groupWhenDegraded: false, missing: false, checkMissingByDefault: false }),
    replenish: Object.freeze({ group: null, groupWhenDegraded: false, missing: true, checkMissingByDefault: true }),
  }),
  realmBar: { newFormUrl: resolveProductNewFormUrl(process.env) },
  paymentStep: PAYMENT_STEP,
  saleSuccess: SALE_SUCCESS,
  number: NUMBER,
  states: STATES,
  missingSize: MISSING_SIZE,
  // ⭐ 2026-10-14（她的最终口径 · docs/special-size-fold-and-enterable-base-2026-10-14.md）：
  //   缺货的**特殊码**收进「特殊码」折叠块（原生 details ⇒ 默认收起、不占高度 ✓ 零 JS ✓）
  specialSizes: SPECIAL_SIZES,
  // ⭐ 2026-10-14（她：「按照**尺码×数量**的形式……**一行 3 个**，多了就换行，保持一行 3 个」）：
  //   补货列表版式 —— 列数**走配置**（以后改 2/4 只改这里 ✓ 显式数字 ✓ 不许 `|| 兜底` ✗）
  purchaseSizes: PURCHASE_SIZES,
  texts: TEXTS,
  price: PRICE,
  fieldNamesPendingSchema: FIELD_NAMES_PENDING_SCHEMA,
  limits: LIMITS,
  reads: READS,
  cache: CACHE,
  snapshot: SNAPSHOT,
  // ⭐ 2026-10-09 新增两块（都由她在 2026-10-09 拍板）：
  sizeSegments: SIZE_SEGMENTS,
  // ⭐ 2026-10-12：页面构建标识（渲染层写进写表单的隐藏字段；日志用它判断"旧页面"）
  pageBuild: PAGE_BUILD,
  pageBuildField: 'page_build',
  // ⭐⭐ 2026-10-13（她："领域/批次**要点 4、5 次**才切换、跳转" + "我想查我点了几次"）：
  //   · `label`      = 点下去**立刻**显示的文案（"正在打开…"）
  //   · `reportPath` = 埋点上报路径（挂在**扫码路由**下 ⇒ 不动全局中间件 ✓ 见注释）
  tapFeedback: Object.freeze({
    enabled: true,
    label: process.env.SCAN_TAP_FEEDBACK_LABEL || '正在打开…',
    // ⚠️ 为什么是 `/<prefix>/ui-tap` 而**不是** `/api/ui-tap`：扫码路由自带前缀（`/s` `/r`）且
    //    **不动 `app.js` 的鉴权/挂载** ⇒ 埋点跟着扫码页走最省事、风险最小 ✓
    reportPath: '/ui-tap',
  }),
  // ⭐⭐ 2026-10-12（业务负责人拍板 · 方案 A，逐字）：「**提交完 ⇒ 自动回首页，而首页 = 销售页**」
  //   ⇒ 三路（销售 / 补货 / 验收）**写成功之后**都回【销售】领域的扫码首页：
  //     · 成功页**先显示结果**（单号 / 实际数量 / 实际金额）⇒ 约 2 秒后**自动跳**；
  //     · 再留一颗【返回扫码】兜底（href 与自动跳转**同一个 URL** ✓ 唯一来源就是这里）；
  //     · **"还没提交、点【继续扫下一个】"不在此列** ⇒ 那种情况仍按她上次用的领域走 ✓（不冲突）。
  //   ⚠️ 唯一来源：她哪天要改回"回补货"，**只改这一处**（别散在两处 ✗）。
  successReturn: SUCCESS_RETURN,
  // ⭐ 2026-10-13：验收成功页的落点映射（**函数声明** ⇒ 提升 ✓ 不会 TDZ）
  productSnapshot: PRODUCT_SNAPSHOT,
  events: EVENTS,
  // ⭐ 2026-10-11：【继续扫下一个】的手段（飞书扫一扫 AppLink，见上面的长注释）。
  scanNext: SCAN_NEXT,
  // ⭐ 2026-10-11：【提交这一单】出现在哪些领域（她：「只在「销售」页显示」）。
  draftBar: DRAFT_BAR,
});

/** `{name}` 占位符替换（缺的值用 `missing` 顶，**不留空段**）。 */
const fillText = (template, values = {}, missing = TEXTS.missingValue) => String(template ?? '')
  .replace(/\{(\w+)\}/g, (match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? missing : String(value);
  });

module.exports = {
  SIZE_SEGMENTS,
  expandRange,
  missingSizes,
  displaySizes,
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
  SCAN_NEXT,
  fillText,
};
