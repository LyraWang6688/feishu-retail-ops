/**
 * 「**手机点打印 ⇒ 店里那台电脑执行打印**」这条链路的**全部可配参数**（配置先行）。
 *
 * 业务负责人 2026-10-11 的口径（唯一权威，逐字）：
 *   「这个打印小助手，**不一定会常开着机，需要打标签的时候才会开**，所以**可以做事件触发吗**？」
 * ⇒ 本文件就是那条链路的旋钮盘：
 *   ① **事件推送**（`transport: 'sse'`，长连接；**不是**每 2-3 秒定时轮询）⇒ 一点打印、秒级出纸；
 *   ② **电脑没开时任务排队保留**，小助手一启动**先补拉**（`pending` 接口 = 启动补拉；SSE 连接时
 *      还会再推一遍 `backlog` 事件，两道保险）；
 *   ③ **在线状态**（心跳）⇒ 手机上显示「打印电脑在线」/「未连接（任务已排队…）」；
 *   ④ **任务状态** `待打(queued) → 已取走(claimed) → 已打印(done) / 失败(failed + 原因)`；
 *   ⑤ **幂等**：同一任务绝不重复打印（服务端 `claimTimeoutMs` 重投 + 小助手本地"已打印 id"台账）。
 *
 * ⚠️ **打印命令（exe 路径 / 参数）不在本文件**：那台电脑的 SumatraPDF 装在哪、默认打印机是哪台，
 *    只有**那台电脑自己**知道 ⇒ 那些旋钮在**小助手自己的 `print-helper/config.json`**（见该目录）。
 *    本文件只管**服务器这一侧**（队列、超时、产物、鉴权）。
 *
 * ⚠️ **开关一律显式布尔**（`readFlag`）：**不许**写 `process.env.X || fallback` ——
 *    `||` 会让"把变量清空"回退到默认值，于是**关不掉**（见 `config/envValue.js` 的说明）。
 */

const os = require('node:os');
const path = require('node:path');
const { readFlag, readInt, readString } = require('./envValue');
const { ROW_IDS } = require('./labelPrint');

/**
 * 任务数据（每个任务一个 JSON 文件）与**可打印产物**（PDF）放哪。
 * ⚠️ 默认落在 `server/data/` 下 —— `.gitignore` 已经忽略 `server/data/`（运行时数据不进版本库）。
 * ⚠️ 测试**必须**注入自己的临时目录（用例不碰这个默认值）。
 */
const DEFAULT_STORE_DIR = path.join(__dirname, '../../data/label_print_jobs');

/**
 * 任务状态机 —— 她定的四个状态（**语义键不写中文**：中文只在 `label` 里，手机上看的是它）。
 *
 * ```
 *   queued(待打印) ──claim──> claimed(已取走) ──ack done──> done(已打印)
 *                                    └──ack failed──> failed(失败 + 原因)
 * ```
 * ⚠️ `claimed` 超过 `claimTimeoutMs` 仍没有回执（电脑崩了 / 断网 / 打印机关了）⇒ **可以被重新领取**
 *    （否则任务永远卡在"已取走"、她那边什么都看不到）。**重投不等于重打**：小助手本地台账挡住重打。
 */
const STATES = Object.freeze({
  queued: Object.freeze({ id: 'queued', label: '待打印' }),
  claimed: Object.freeze({ id: 'claimed', label: '已取走' }),
  done: Object.freeze({ id: 'done', label: '已打印' }),
  failed: Object.freeze({ id: 'failed', label: '失败' }),
});

/** 状态展示顺序（手机上按它排：待打印在最上）。 */
const STATUS_ORDER = Object.freeze(['queued', 'claimed', 'failed', 'done']);

/** 一次打印请求的来源（只用于日志与页面提示，不参与任何判断）。 */
const SOURCES = Object.freeze({
  scan: 'scan',
  workbench: 'workbench',
});

const LABEL_PRINT_QUEUE = Object.freeze({
  // 打印任务队列的**显式开关**：关掉时两条新入口都回 503 + 人话（不静默 404）。
  enabled: true,
  states: STATES,
  statusOrder: STATUS_ORDER,
  sources: SOURCES,

  // ── 落盘 ──────────────────────────────────────────────────────────────────
  storeDir: DEFAULT_STORE_DIR,
  // 产物（PDF）放在 storeDir/artifacts 下（同目录 => 清理时一起扫，不会漏）。
  artifactsSubdir: 'artifacts',

  // ── 在线判据（心跳）──────────────────────────────────────────────────────
  // 小助手每次心跳 / 每次长连接 ping 都刷新 `last_seen`；超过这么久没动静 = **未连接**。
  // ⚠️ 她是"要打标签才开机"⇒ **未连接是常态**，页面文案必须不吓人（见 texts.offlineBody）。
  onlineTimeoutMs: 90 * 1000,

  // ── 传输（事件推送）────────────────────────────────────────────────────
  // `sse` = Server-Sent Events 长连接（默认，事件驱动）；`longpoll` = 长轮询（备选，走不通时用）。
  // ⚠️ 两种都**不是**"每 2-3 秒定时轮询"：都是服务端一有任务就立刻回包。
  transport: 'sse',
  // SSE 的注释心跳（`: ping`）：顶住 Nginx `proxy_read_timeout`（默认 60s）与中间设备的空闲断链。
  // ⚠️ 它同时**兼作心跳**（刷新 last_seen）—— 长连接活着 = 电脑在线。
  ssePingMs: 20 * 1000,
  // 长轮询最长挂多久。Nginx `proxy_read_timeout` 默认 60s ⇒ 25s 留足余量，**不需要改服务器配置**。
  longPollWaitMs: 25 * 1000,

  // ── 认领与重投 ───────────────────────────────────────────────────────────
  // 领取后多久没回执 ⇒ 允许**重新领取**（电脑崩了 / 断网 / 打印机关了）。
  // ⚠️ 与"绝不重复打印"不冲突：重投由**小助手本地台账**挡住重打（见 print-helper/README.md）。
  claimTimeoutMs: 2 * 60 * 1000,
  // 领取时把 `claimed_by` 写上：多台电脑/多开实例时能看出是谁拿走的（现在只有一台，先留痕）。
  defaultDeviceId: 'store-pc',

  // ── 一次打多少 ───────────────────────────────────────────────────────────
  // 一个任务最多打几张标签（**一张 = 一个编号 = PDF 里的一页**）。
  // ⚠️ 超了**明确报错**（400 + 人话"请缩小条件"），**不静默截断**——静默截断她根本不知道自己少打了。
  maxLabelsPerJob: 100,
  // 手机上"最近任务"列几条（她只需要看到自己刚点的那几条）。
  listLimit: 10,

  // ── 产物（服务器生成，小助手只负责送进打印机）──────────────────────────
  artifact: Object.freeze({
    // 标签纸 203dpi ⇒ 8 点/mm ⇒ 40×30mm = **320×240 px**。
    // ⚠️ 这个数字同时决定 PDF 的 `/MediaBox`（mm→pt：mm/25.4×72）与光栅像素（mm/25.4×dpi）。
    dpi: 203,
    // 塞进 PDF 的 JPEG 质量：标签是黑白文字 + 二维码，92 足够、体积小。
    jpegQuality: 92,
    // ⚠️ PNG 是给"测试打印 / 排障 / 本地页面预览"用的（PDF 才是送打印机那一份）：
    //    有的驱动对 PDF 的页面尺寸挑食，PNG 让她能一眼看出"图对不对"。
    keepPng: true,
    /**
     * ⭐⭐ **排版画布方向**（业务负责人 2026-10-11 真机三组对照之后的**最终修法**）。
     *
     * 她的三组实测（都有照片）：
     *   A. `rotate:0 + 不换页面`      ⇒ ❌ 平行于**短边**（不是她要的）
     *   B. `rotate:90 + 不换页面`      ⇒ ✅ **平行于长边（她要的）**，但 ❌ 缩到 **75%**（四周留白的小框）
     *   C. `rotate:90 + 换页面(30×40)` ⇒ ❌ 方向又反了，✅ 铺满
     * ⇒ **要的是"B 的方向 + C 的铺满"**。做法：**旋转【布局画布】**——
     *   `portrait` = 按转过之后的画布（30 宽 × 40 高）**重新排版**，再整幅**按 1:1** 转进 40×30 的页面。
     *   这样：方向 = B ✅、**原尺寸铺满** ✅、页面仍是 40×30 ✅、二维码仍 15mm ✅。
     *
     *   · `landscape`（**默认**）—— 老版式（画布 40×30）。**线上/浏览器打印那条路一个字没变**；
     *   · `portrait`            —— **旋转画布**（画布 30×40；行序走 `body.portraitRows`，二维码自己占一行）。
     *
     * ⇒ **建议的线上取值**：`LABEL_PRINT_CANVAS=portrait` + `LABEL_PRINT_ROTATE=0`
     *   + `LABEL_PRINT_ROTATE_PAGE=false`（后两个保持默认即可）。
     */
    canvas: 'landscape',
    // 🔴 `'fitting'`（可配，但**只作对照/证据**）：逻辑画布 30×40（读向沿 40mm 边）+ 整体转 90° 进
    //    40×30 页面 —— 两步互相抵消 ⇒ 页面内容 = 原构图本身 ⇒ **与 landscape+rotate:0 逐像素相同**
    //    ⇒ 纸上就是真机 A 那一档（品牌平行于短边）。**不是"方向对 + 铺满"**，别上线。
    /**
     * ⚠️ **更底层的两个旋钮（保留，但别当默认）**：
     *   · `rotate` —— 把**已渲染的内容**整体转（0/90/180/270），**默认 0**。
     *     横版转 90° 时 40×30 的图会占成 30×40 ⇒ **塞不进同一张纸**，只能等比缩到 75%
     *     ⇒ 那就是真机 **B**（方向对、小一圈）。**线上现在跑的就是它**，所以这条路原样保留。
     *   · `rotatePageWithContent` —— 让**页面尺寸也跟着转**（40×30 ⇒ 30×40）。
     *     🔴 **实测：它会让打印驱动把整页再转 90° ⇒ 方向又变回"平行于短边"（真机 C）**
     *     ⇒ **不推荐**、别再当默认；只作为万一换机器时的一条备用路。
     *     ⚠️ 在 `canvas: 'portrait'` 下这个旋钮**被忽略**（并如实回报 false）。
     */
    rotate: 0,
    rotatePageWithContent: false,
    /**
     * ⭐⭐ **整幅内容在页面内的平移**（mm；只平移内容，**裁切线留在纸边**）。
     *
     * 为什么要有它（业务负责人 2026-10-12：「方向对了，但沿长边没有居中」）：
     *   我先量了产物（横版 40×30、无裁切线）：**左右是对称的**（左 1.50mm / 右 1.63mm，差 −0.13mm），
     *   但**上下不对称**（上 1.63mm / 下 5.88mm，差 −4.25mm）。
     *   ⇒ 若她说的"长边"是页面的**竖轴**，用 `contentOffsetYMm = 2` 就正（上下各 3.75mm）；
     *     是横轴的话本来就正，保持 0。
     * ⚠️ 步进 0.5mm、范围 ±5mm，越界/非法**当场抛**（不许静默按 0 处理 —— 那等于她白调了）。
     * ⚠️ 只平移，**不改字号与二维码尺寸**（她已确认过这两点）。
     */
    contentOffsetXMm: 0,
    contentOffsetYMm: 0,
    /**
     * ⭐⭐ **左留白**（mm；默认 `null` = 用 `label.paddingMm`，即与右留白对称）。
     *
     * 为什么加它（业务负责人 2026-10-12）：「还是偏左，可以再挪 2mm」——
     *   但**纯平移**会让最宽那一行被裁（右留白 1.75 − 3 = **−1.25mm** ✗ 超出页面）。
     *   ⇒ 正解是**把左留白本身调大**（挪的同时腾出空间）。
     * 与右留白的关系（恒等式，有 AC 钉着）：
     *   `左留白 + 二维码列 + 信息栏 + 右留白 = 页宽`（信息栏吃剩下的）
     * ⇒ **左留白 +2mm 而信息栏不变**的唯一办法是**二维码同时缩 2mm**（方案①：15 → 13mm）。
     * ⭐ **2026-10-12 她拍板方案①：默认就是 `3.5`**（"再挪 2mm"，且靠下面的二维码缩到 13mm 腾空间）。
     * ⚠️ 只影响**打印产物**（`artifact`），不动 `label.paddingMm` 的语义、也不动浏览器出图那条路。
     * ⚠️ 因此**左右是有意不对称的**（左 3.5 / 右 1.5）—— 别再写"左右相等"的断言（会和设计打架）。
     */
    leftPaddingMm: 3.5,
    /**
     * ⭐ **二维码尺寸**（mm；默认 `null` = 用 `typography.qrSizeMm`）。方案①：**13**（15 → 13）。
     * 为什么缩它：`左留白 + 二维码列 + 信息栏 + 右留白 = 页宽` —— 左留白 +2mm 而**信息栏不变**，
     * 只能让二维码同时让出 2mm ✅（这样货号不缩字、不被裁；13mm 仍好扫）。
     */
    qrSizeMm: 13,
    /**
     * ⭐⭐ **裁切线宽度**（mm；默认 `0` = **不画**）。
     *
     * 她的原话（2026-10-12）：「我看到在打印的时候，**上下会有横杠**」—— 那就是这圈裁切线
     * （成卷标签上，上下两条看起来就是横杠）⇒ 默认关掉。
     * 保留能力：设成正数（例如 `0.2`）就画回来（要做裁切定位时用）。
     * ⚠️ 它也参与几何：线宽 0 ⇒ 内容盒左右各多 0.2mm（信息栏 20.1 → 20.5mm）。
     */
    cutLineMm: 0,
    /**
     * ⭐⭐ **右栏行序**（默认 `null` = 用 `body.rows`，也就是**老版式**）。
     * 想切"货号一行 · 颜色+市价一行 · 尺码区"（新排法）⇒ 用 env `LABEL_PRINT_ROWS`
     * （例如 `brand,itemNo,colorPrice,sizes`）—— **不用改代码、一条 env 启用/回退** ✓
     * ⚠️ 只认 `config/labelPrint.js` 的 `ROW_IDS` 白名单；非法/重复 ⇒ 启动就抛 ✓
     */
    rows: null,
  }),

  // ── ⭐ 防连点（业务负责人 2026-10-11 真机反馈：「点完没有反馈 ⇒ 她以为没点上、
  //    连点几次 ⇒ 多打了好几张」）────────────────────────────────────────────
  // 同一份请求（同编号 / 同筛选条件）在这个窗口内**只建一个任务**：
  //   · 手机扫码页那一颗是**零 JS** ⇒ 连点 2~3 次会发出 2~3 个一模一样的 POST，
  //     靠的就是"同一个 `request_key` + 窗口内复用同一个任务"；
  //   · 她**真想再打一张**的路没被堵死：窗口内再点 ⇒ 页面**明确二次确认**并给【再打一张】
  //     （那个按钮带 `again=1`，**绕过**窗口）；过了窗口再点就是一次全新提交。
  dedupeWindowMs: 60 * 1000,
  // 表单带回来的幂等键（可选）：**同一次提交同 key ⇒ 复用**（比窗口更硬的一道）。
  // ⚠️ 扫码页零 JS、不强依赖它；工作台那一页会带（同一批查询结果一个 key）。
  submitKeyField: 'submit_key',
  // 「再打一张 / 再打一份」按钮带的字段（**明确表达"我知道刚打过，还要再打"**）。
  againField: 'again',

  // ── 保留期（小 VPS 磁盘有限）────────────────────────────────────────────
  // `done` / `failed` 超过这么久 ⇒ 任务 JSON 与产物一起清掉。
  // 🔴 **`queued` / `claimed` 永不被清理**（那正是"电脑没开时排队保留"那条要求）。
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  // 清理的最小间隔（每次 enqueue 顺带试一次，不是定时器）。
  cleanupIntervalMs: 10 * 60 * 1000,

  // ── 电脑侧（小助手）鉴权 ─────────────────────────────────────────────────
  // ⚠️ 小助手是**没有飞书登录的无头电脑**，用不了工作台那道身份闸门 ⇒ 独立令牌。
  //    令牌**只从环境变量读**（不许硬编码、不许进仓库）。
  device: Object.freeze({
    // 空串 = 没配 ⇒ 电脑侧全部接口回 503 + 人话，**并打一条 error 日志**（绝不静默放行）。
    tokenEnv: 'LABEL_PRINT_DEVICE_TOKEN',
    // 令牌从哪个请求头来（`EventSource` 设不了自定义头 ⇒ 小助手用 fetch 流式读，能带头）。
    header: 'x-label-print-token',
    // 哪台电脑（可选；不传就用下面这个 id）。
    idHeader: 'x-label-print-device',
    // 多台电脑时用来区分；现在只有店里那一台。
    id: 'store-pc',
  }),

  // ── 手机上看到的字（页面不写死句子）────────────────────────────────────
  texts: Object.freeze({
    online: '打印电脑在线',
    offline: '未连接（任务已排队，打开小助手就会打）',
    // ⭐⭐ 2026-10-11 真机反馈后加的：**提交完必须"显眼地"说清楚**
    //   （她的现象：点完没反馈 ⇒ 以为没点上 ⇒ 连点几次 ⇒ 多打了好几张）。
    //   `{count}` = 本次几张。
    submittedBanner: '✅ 已发送给打印电脑：本次 {count} 张',
    submittedOnline: '打印电脑在线 —— 马上打',
    submittedOffline: '未连接 —— 已排队，开机自动补打',
    submittedNoRepeat: '已提交，不用重复点',
    // 连点去重（窗口内第二次提交）⇒ **明确二次确认**，并给【再打一张】的路。
    duplicatedBanner: '刚刚已经发过一次：本次 {count} 张（没有重复提交）',
    duplicatedHint: '确实要再打一张，点下面的按钮',
    printAgain: '再打一张',
    queued: '已排队，等打印电脑取走',
    enqueuedTitle: '已提交打印',
    enqueueFailed: '提交打印失败',
    printSingle: '打印这一款',
    printBatch: '打印到店里那台电脑',
    // 「再打一份」= 工作台那一页**明确要再打一份**的路（带 `again`，绕过防连点窗口）。
    printBatchAgain: '再打一份',
    reprint: '补打',
    refresh: '刷新状态',
    // 「最近一次：已打印」—— 扫码页「货品」领域那一行（失败时后面接 `— 原因`）。
    lastJobPrefix: '最近一次：',
    // 打印服务不可用（队列坏了 / 明确关掉）—— 那一页**绝不留空白**，用这句如实顶一下。
    unavailable: '打印服务暂时不可用，稍后再试',
    // 扫码页零 JS：提交打印失败 ⇒ 渲染一张人话页（标题 + 原因原样）。
    enqueueFailedTitle: '打不出来这一款',
    unavailableTitle: '打印服务暂时不可用',
    // 状态徽标旁边那句"最近一次心跳"。
    lastSeenPrefix: '最近心跳：',
    neverSeen: '这台电脑还从没连过',
  }),
});

/**
 * 从环境变量解析一份**运行期**配置（默认值来自上面的 `LABEL_PRINT_QUEUE`）。
 * ⚠️ 用例直接传 env 进来（不碰全局 `process.env`），并发跑不会互相污染。
 */
/**
 * 解析"毫米微调"环境变量（内容平移）：**没设/空串 ⇒ 用默认**；非法/越界**当场抛**。
 * ⚠️ 步进 0.5mm、范围 ±5mm —— 与 `artifact` service 的 `normalizeOffsetMm` 同一套口径。
 */
const readMmOffset = (env, key, fallback) => {
  const raw = String(env?.[key] ?? '').trim();
  if (!raw) return fallback ?? null; // 未设/空 ⇒ null（= 用 body.rows 老版式）
  const mm = Number(raw);
  if (!Number.isFinite(mm) || Math.abs(mm) > 5 || Math.abs(mm / 0.5 - Math.round(mm / 0.5)) > 1e-9) {
    throw new Error(`${key} 只能是 ±5mm 内、0.5 的整数倍（当前是「${raw}」）`);
  }
  return mm;
};

/** 解析"左留白"（0~10mm、0.5 步进）；**没设/空串 ⇒ 用默认（null = 与右留白对称）**；非法当场抛。 */
const readOptionalMm = (env, key, fallback, { min = 0, max = 10, step = 0.5 } = {}) => {
  const raw = String(env?.[key] ?? '').trim();
  if (!raw) return fallback ?? null; // 未设/空 ⇒ null（= 用 body.rows 老版式）
  const mm = Number(raw);
  if (!Number.isFinite(mm) || mm < min || mm > max || Math.abs(mm / step - Math.round(mm / step)) > 1e-9) {
    throw new Error(`${key} 只能是 ${min}~${max}mm 之间、${step} 的整数倍（当前是「${raw}」）`);
  }
  return mm;
};

/**
 * ⭐⭐ 解析**行序开关**（`LABEL_PRINT_ROWS`）：逗号/分号/空白分隔。
 *   · 未设 / 空串 ⇒ **回退默认**（`artifact.rows`，默认 null = 用 `body.rows` 老版式）；
 *   · 非法（不在白名单）/ 重复 ⇒ **当场抛并指出字段名**（部署时就炸，不要静默切成别的版式）。
 * ⚠️ 白名单唯一真源 = `config/labelPrint.js` 的 `ROW_IDS`（与 `artifact.rows` 同一份）。
 */
const readRows = (env, key, fallback) => {
  const raw = String(env?.[key] ?? '').trim();
  if (!raw) return fallback ?? null; // 未设/空 ⇒ null（= 用 body.rows 老版式）
  const items = raw.split(/[,，;；\s]+/).map((item) => item.trim()).filter(Boolean);
  if (!items.length) return fallback ?? null;
  const seen = new Set();
  for (const id of items) {
    if (!ROW_IDS.includes(id)) {
      throw new Error(`${key} 里有不认识的行「${id}」—— 可选：${ROW_IDS.join(',')}`);
    }
    if (seen.has(id)) throw new Error(`${key} 里「${id}」重复了（同一行只能出现一次）`);
    seen.add(id);
  }
  return items;
};

const resolveLabelPrintQueueConfig = (env = process.env, base = LABEL_PRINT_QUEUE) => ({
  ...base,
  enabled: readFlag(env, 'LABEL_PRINT_QUEUE_ENABLED', base.enabled),
  storeDir: readString(env, 'LABEL_PRINT_QUEUE_DIR', base.storeDir) || base.storeDir,
  transport: (() => {
    const value = readString(env, 'LABEL_PRINT_TRANSPORT', base.transport);
    if (!['sse', 'longpoll'].includes(value)) {
      throw new Error('LABEL_PRINT_TRANSPORT 只能是 sse 或 longpoll');
    }
    return value;
  })(),
  ssePingMs: readInt(env, 'LABEL_PRINT_SSE_PING_MS', base.ssePingMs, { min: 1000, max: 10 * 60 * 1000 }),
  longPollWaitMs: readInt(env, 'LABEL_PRINT_LONG_POLL_MS', base.longPollWaitMs, { min: 1000, max: 55 * 1000 }),
  onlineTimeoutMs: readInt(env, 'LABEL_PRINT_ONLINE_TIMEOUT_MS', base.onlineTimeoutMs, { min: 5000, max: 60 * 60 * 1000 }),
  claimTimeoutMs: readInt(env, 'LABEL_PRINT_CLAIM_TIMEOUT_MS', base.claimTimeoutMs, { min: 10 * 1000, max: 24 * 60 * 60 * 1000 }),
  maxLabelsPerJob: readInt(env, 'LABEL_PRINT_MAX_LABELS_PER_JOB', base.maxLabelsPerJob, { min: 1, max: 1000 }),
  retentionMs: readInt(env, 'LABEL_PRINT_RETENTION_MS', base.retentionMs, { min: 60 * 1000, max: 365 * 24 * 60 * 60 * 1000 }),
  // ⭐ 连点去重窗口：设成 0 = 关掉"按内容复用"那一道（幂等键那一道仍在）。
  dedupeWindowMs: readInt(env, 'LABEL_PRINT_DEDUPE_WINDOW_MS', base.dedupeWindowMs, { min: 0, max: 60 * 60 * 1000 }),
  // ⭐ 打印方向：`rotate` 只认 0/90/180/270（**认不出的值当场抛错**，不许静默按 0 处理）；
  //   `rotatePageWithContent` = 页面尺寸要不要跟着转（见 `artifact.rotate` 那一段说明）。
  artifact: {
    ...base.artifact,
    canvas: (() => {
      const value = readString(env, 'LABEL_PRINT_CANVAS', base.artifact.canvas);
      if (!['landscape', 'portrait', 'fitting'].includes(value)) {
        throw new Error('LABEL_PRINT_CANVAS 只能是 landscape / portrait / fitting');
      }
      return value;
    })(),
    rotate: (() => {
      const value = readInt(env, 'LABEL_PRINT_ROTATE', base.artifact.rotate, { min: 0, max: 270 });
      if (![0, 90, 180, 270].includes(value)) {
        throw new Error('LABEL_PRINT_ROTATE 只能是 0 / 90 / 180 / 270');
      }
      return value;
    })(),
    rotatePageWithContent: readFlag(env, 'LABEL_PRINT_ROTATE_PAGE', base.artifact.rotatePageWithContent),
    // ⭐ 内容平移（±5mm、0.5mm 步进）——校验在 artifact service 的 `normalizeOffsetMm`
    //   （renderLabels 里会调它 ⇒ 越界/非法当场抛，不静默）
    contentOffsetXMm: readMmOffset(env, 'LABEL_PRINT_CONTENT_OFFSET_X_MM', base.artifact.contentOffsetXMm),
    contentOffsetYMm: readMmOffset(env, 'LABEL_PRINT_CONTENT_OFFSET_Y_MM', base.artifact.contentOffsetYMm),
    // ⭐ 左留白（0~10mm；没设/空串 ⇒ 默认值，现在是 3.5 = 方案①）
    leftPaddingMm: readOptionalMm(env, 'LABEL_PRINT_LEFT_PADDING_MM', base.artifact.leftPaddingMm),
    // ⭐ 二维码尺寸（5~25mm）/ 裁切线宽度（0~1mm，0 = 不画）
    qrSizeMm: readOptionalMm(env, 'LABEL_PRINT_QR_SIZE_MM', base.artifact.qrSizeMm, { min: 5, max: 25 }),
    cutLineMm: readOptionalMm(env, 'LABEL_PRINT_CUT_LINE_MM', base.artifact.cutLineMm, { min: 0, max: 1, step: 0.1 }),
    // ⭐⭐ 行序开关（`LABEL_PRINT_ROWS`，逗号分隔，例如 `brand,itemNo,colorPrice,sizes`）：
    //   **未设/空串 ⇒ 用默认（`body.rows` = 老版式）** ⇒ 行为一字不变、一条 env 可回退 ✓
    rows: readRows(env, 'LABEL_PRINT_ROWS', base.artifact.rows),
  },
  device: {
    ...base.device,
    // ⚠️ 空串 = 显式的"没配"（readString 的语义）⇒ 电脑侧接口一律 503，**不回退到任何默认令牌**。
    token: readString(env, base.device.tokenEnv, ''),
    id: readString(env, 'LABEL_PRINT_DEVICE_ID', base.device.id) || base.device.id,
  },
});

/** 产物目录（= `storeDir/artifacts`）。 */
const artifactsDirOf = (config = LABEL_PRINT_QUEUE) =>
  path.join(config.storeDir, config.artifactsSubdir);

/** 这台机器的名字（日志里用；她那边只有一台，填不出也不报错）。 */
const hostname = () => {
  try {
    return os.hostname();
  } catch {
    return 'unknown-host';
  }
};

module.exports = {
  LABEL_PRINT_QUEUE,
  STATES,
  STATUS_ORDER,
  SOURCES,
  DEFAULT_STORE_DIR,
  resolveLabelPrintQueueConfig,
  artifactsDirOf,
  hostname,
};
