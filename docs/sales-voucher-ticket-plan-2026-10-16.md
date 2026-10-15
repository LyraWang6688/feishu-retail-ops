# 销售凭证票据（可打印）—— 只读调研 + 判据草案（2026-10-16）

> **本文件是【第一步：只读调研】的产物**：核清「现有打印链路怎么把一张纸送到店里那台打印机上」＋
> 「资金页今天有什么」⇒ 给出**判据草案**与**要她拍板的问题清单**。
>
> 🔴 **本步不写任何 `server/src/**`** ✗（只读 + `docs/**` ✓）——
>    `services/scanWriteService.js` **一个字没碰**（余量 0 ✓）· 不碰别人 worktree ✗ ·
>    `views/**` / `routes/scanPage.js` **正被别人占着**（证据见 §5）⇒ 那一半**排期等让出** ✗。
>
> - **基准提交**：`origin/main = b7ba07e`（`docs: 总账补 R-26…R-30…` #715）
> - **worktree**：`.local/voucher-ticket`（分支 `docs/voucher-ticket-plan-20261016`，从 `origin/main` 开 ✓）
> - **核对时间**：2026-10-16 上午（上海）
> - **怎么核的**：`read` / `grep`（项目源码，只读）＋ `git worktree list` / `git status`（占用判定）。
>   **没有**飞书 CLI ✗ · **没有**连生产 Base ✗ · **没有**部署 ✗

---

## §0 她的口径（逐字，本任务的唯一需求来源）

### 0.1 原始需求（业务负责人 2026-10-16 逐字）

> 「另外，我们还需要做一个**销售凭证的标签设置**。它是一个**票据，需要打印**，包含：
>  · **邯美皮鞋的大 logo** · **邯美皮鞋销售凭证** · **货品类型与尺码**（品类如男鞋、单鞋等）
>  · **付款方式** · **付款金额** · **销售日期**，这些信息，**加在我们的资金页面**」

### 0.2 弹窗问出来的三条（逐字，**规格**）

| # | 她的原话 | ⇒ 落成的要求 |
|---|---|---|
| ① | 「**用现有的打印机打，支持票据打印**」 | ⭐ **复用现有那套打印链路**（= 打二维码标签那条：手机点 ⇒ 服务端出 PDF ⇒ 店里电脑送进打印机）✓ **不新开一套** ✗ |
| ② | 「因为是在资金页面，且**不需要具体货号信息**，所以就是**这个单子的累计金额**」 | ⭐ **一单一票** ✓（不是每件一张 ✗）· **票面不出现货号** ✗ · **金额 = 本单累计金额** ✓（多货品 ⇒ 合计 ✓） |
| ③ | 「**资金页上一颗「打印销售凭证」按钮**」 | ⭐ 入口 = **资金页一颗按钮** ✓ **点了才出** ✓（不自动弹 ✗） |

### 0.3 logo（🔴 她还没给）

> **她还没给 logo 图** ⇒ 先**用占位**（文字「邯美皮鞋」＋预留图片位 ✓），
> ⭐ **不许自己画一个假的 logo 冒充当成品** ✗ —— 本文件把"要她发一张 logo 图"写进问题清单（§6 ①）。

---

## §1 ⭐ 现有打印链路怎么工作（本任务最值钱的部分）

### 1.1 现在**有两条**打印路，别混

| 路 | 在哪 | 怎么出纸 | 是不是她说的"现有那套" |
|---|---|---|---|
| **A · 浏览器打印** | 工作台标签打印页 `server/public/workbench/label-print.html` ＋ `public/workbench/features/labels/*` | HTML + CSS 出图，页面上那颗按钮直接 `window.print()`（`features/labels/index.js:287`；打印样式 `features/labels/labels.css:178` 的 `@media print`） | ✗ **不是** —— 那条路要**人在电脑前点打印对话框**（`services/labelPrintArtifactService.js:22-26` 的注释把这条边界写明了） |
| **B · 队列 + 店里电脑**（`打印小助手`） | 手机点 ⇒ **服务端把 PDF 画好落盘** ⇒ 店里 Windows 小助手**认领** ⇒ SumatraPDF 静默送进打印机 | 全自动、电脑可以不开机（任务排队） | ✅ **是这条** —— 「就是打二维码标签那台」＝ 这条路 |

> ⭐ **票据要插进的是【路 B】**。**路 A 一个字都不动** ✗。

### 1.2 路 B 的完整走法（每一步的文件:行）

```
 ①入口(手机)          ②入队+去重           ③画产物(服务器)        ④落盘
 routes/labelPrintQueue.js:55   labelPrintQueueService.js:191   labelPrintArtifactService.js:1276   labelPrintJobStore.js
   POST /jobs                    enqueue() → :264 buildArtifact    renderLabels() → SVG→PNG→JPEG     data/label_print_jobs/*.json
 （扫码页那一支：                 → :300 render(...)                → buildPdf:1182 (每页 MediaBox)   + artifacts/<jobId>.pdf|png
  routes/scanPage.js:1543）       → :329 createJob(:170 writeArtifacts)
        │                                                                                                  │
        │ ⑧状态回执                        ⑤事件推送(SSE)      ⑥电脑认领      ⑦出纸                      │
        └── ack → done/failed ◀────────── :155 notify ────────▶ labelPrintDevice.js:197/214 ──▶ print-helper/helper.js:773
            routes/labelPrintDevice.js:251                     :273 artifact(PDF)      sumatra -print-to-default -silent
```

**逐个锚点**：

| 环节 | 文件:行 | 说明 |
|---|---|---|
| 挂载 | `server/src/app.js:99-100` | 手机侧 `/api/workbench/label-print`（工作台身份闸门）· 电脑侧 `/api/label-print`（设备令牌） |
| 手机侧入口 | `server/src/routes/labelPrintQueue.js:55` `POST /jobs` · `:126` `GET /status` · `:160` `POST /jobs/:jobId/reprint` | 工作台标签打印页走它；**扫码页那条零 JS 表单**是另一条（`routes/scanPage.js:1543` 的 `print_label` 分支，**不写任何业务表** ⇒ 排在"写入口关着 ⇒ 503"**之前**） |
| 队列单例 | `server/src/services/labelPrintQueueRuntime.js:27` `getLabelPrintQueue` | ⚠️ **手机侧与电脑侧必须共用同一个实例**（订阅者集合与心跳都是**进程内状态**）—— 两个实例 ⇒ 入队了却推不到电脑 |
| 请求形状 | `server/src/services/labelPrintQueueService.js:47` `normalizeRequest` | 现在只有 `mode:'single'`（按 `number` / ⭐ 按 `recordId`）与 `mode:'batch'`（筛选条件） |
| 幂等键 | 同上 `:81` `requestKeyOf` | `single\|<编号>` / `batch\|<固定顺序的筛选条件>`（**含 rotate/canvas**） |
| 去重 | 同上 `:191` `enqueue` → `:227 findReusable` | ① `submit_key` 最硬 ② `request_key` + `dedupeWindowMs`（**默认 60s**，`config/labelPrintQueue.js:202`）；她**明确要再打**时带 `again: true` ⇒ 两道都绕过（`:223 force`） |
| 挑数据＋画产物 | 同上 `:264 buildArtifact`（**挑标签**）→ `:300 render(...)`（**画**） | ⚠️ **本文件"不懂标签长什么样"**（`:13-16`）：印什么来自 `labelPrintService`，长什么样来自 `labelPrintArtifactService` |
| 建任务（**先落盘、再建记录**） | 同上 `:329 createJob` → `:170 writeArtifacts` → `:340-375` | 顺序反了会让电脑领到一个**空任务**（`:166-168` 的注释）；产物名 = `<jobId>.pdf` / `<jobId>.png` |
| 产物渲染 | `server/src/services/labelPrintArtifactService.js:1276 renderLabels` | `labelSvg()` → `svgToPng:1157`（sharp）→ `pngToJpeg:1162` → `buildPdf:1182`；**每页 `/MediaBox` = 真实纸尺寸**（40×30mm ⇒ 113.39×85.04pt） |
| ⭐ 通用件（**可复用**） | 同上 `:1399-1436` 的导出区 | `buildPdf` / `svgToPng` / `pngToJpeg` / `mmToPt` / `mmToPx` / `escapeXml` / `textWidthMm` / `FONT_FAMILY` —— **它们不认识"标签"** ⇒ 票据可以直接复用 ✓ |
| 标签专用件（**别复用**） | `labelSvg:816` · `LABEL.widthMm/heightMm`（`config/labelPrint.js:54-63`）· `ROW_IDS:139` · `FIELDS:240` · `BRAND:260` | 这一整套是**标签内容形状**（二维码/货号/颜色/尺码区/价格）⇒ 票据**另写一个渲染器**，不往 `labelSvg` 里塞分支 ✗ |
| 任务落盘 | `server/src/infrastructure/labelPrintJobStore.js` | `server/data/label_print_jobs/<jobId>.json` + `artifacts/`（`.gitignore` 已忽略运行数据） |
| 在线判据 | `config/labelPrintQueue.js:75 onlineTimeoutMs`（90s）· `:81-85` ssePingMs / longPollWaitMs | 心跳活在内存；服务重启后"未连接"是**如实**的 |
| 电脑侧接口 | `server/src/routes/labelPrintDevice.js:109` heartbeat · `:118` `/stream`(SSE) · `:197` `/pending`(启动补拉) · `:214` `/jobs/next`(认领) · `:251` `/jobs/:jobId/ack` · `:273` `/jobs/:jobId/artifact` · `:296` reprint · `:309` `/status` | 鉴权 = **设备令牌** `x-label-print-token`（`config/labelPrintQueue.js:219-228`；没配 ⇒ 全 503 + error 日志） |
| 出纸 | `print-helper/helper.js:773` `buildPrintCommand` → `:1039-1043`（`spawn`）· `:102-117`（默认配置）· `print-helper/config.example.json` | `SumatraPDF.exe -print-to-default -silent <file>` ＋ `printSettings: ["disable-auto-rotation","center"]`；**打的是这台电脑的【默认打印机】**，纸型在**驱动**里（`README.md:79-103`） |
| 电脑侧界面 | `print-helper/README.md` | 小助手是**给爸妈用的一页说明**（装机/排障/睡眠） |

### 1.3 ⭐ 要加一张新票据，得在哪几步插进去（**三步 + 一颗按钮**）

| 步 | 插哪 | 具体做什么 | 现在能不能开工 |
|---|---|---|---|
| **① 配置** | **新文件** `server/src/config/salesVoucherTicket.js` | 票据尺寸（mm）/ 六项内容的字与开关 / **logo 路径与占位** / 是否启用。写法照 `config/labelPrint.js:54-63`（尺寸）＋ `:260-263`（品牌文案）＋ `config/labelPrintQueue.js:60-271`（整包配置）；🔴 **开关一律显式布尔**，不写 `process.env.X \|\| fallback`（`config/labelPrintQueue.js:18-19`） | ✅ **现在就能做**（新文件，零冲突） |
| **② 产物渲染** | **新文件** `server/src/services/salesVoucherTicketService.js`：`renderSalesVoucherTicket({voucher, layout, config})` | 出**一张**票据的 PDF：内部复用 `labelPrintArtifactService` 导出区的通用件（`buildPdf` / `svgToPng` / `pngToJpeg` / `mmToPt` / `mmToPx` / `escapeXml` / `textWidthMm` / `FONT_FAMILY`）。⚠️ `buildPdf` 的页**只吃 JPEG** ⇒ logo 位图要先经 sharp 转 JPEG（或先 `composite` 合成整页再进 PDF） | ✅ **现在就能做** |
| **③ 队列接线** | `server/src/services/labelPrintQueueService.js` **并列新增三处**：`normalizeRequest:47` 加 `mode:'voucher'` · `requestKeyOf:81` 加 `voucher\|<键>` · `buildArtifact:264` 加一支（取票面数据 → 调 ② 的渲染器） | 🔴 **既有 `single` / `batch` 语义一个字不动** ✗（照 `recordId` 那次"**并列新增一种 single**"的做法，`:41-45`）⇒ 之后 `createJob` / 落盘 / `claimNext:506` / artifact / ack / reprint / SSE **零改动**（任务与 PDF 的形状本来就是通用的 ✓） | ✅ **现在就能做**（这三份打印件**现在没人占**，见 §5） |
| **④ 入口那颗按钮** | `config/scanWrite.js:65 ACTIONS` 加 `printVoucher` · `views/scanPageRenderer.js:1862 renderSalePaymentStepPage` 加一颗按钮（照 `:599 labelBlockHtml` + `:655/:680` 的隐藏 `action` 形状）· `routes/scanPage.js` 加一支（照 `:1543 print_label`：**排在"写入口关着 ⇒ 503"之前**，因为它不写业务表）· 路由把**会话草稿 + 收款行**交给票据 | ⛔ **必须等让出**（`views/scanPageRenderer.js` / `routes/scanPage.js` 现在有未提交的改动，见 §5） |

> ⚠️ **两张纸尺寸不同**这件事必须一次说清：服务器只能决定 **PDF 的 `/MediaBox`**；
>    **纸上真正出来多大 / 什么方向，由店里那台电脑的【默认打印机 + 驱动纸型】决定**
>   （`print-helper/README.md:79-103` 就是为这件事写的）。
>   ⇒ **票据尺寸是问题清单 ③（上线阻塞项）**，不是服务器单方面能定的。

---

## §2 资金页今天有什么（按钮 / 数据 / 出口）

### 2.1 页面本体

| 件 | 文件:行 |
|---|---|
| 渲染器（唯一实现） | `server/src/views/scanPageRenderer.js:1862-1930` `renderSalePaymentStepPage` |
| 路由唯一出口 | `server/src/routes/scanPage.js:224-248` `sendPaymentStep`（**三个调用点共用**：GET 刷新认标记 `:1353` · 提交后 `:1732/:1844/:1906/:2395` · 按钮回来 `:2536`） |
| 视图模型 | `server/src/routes/scanPage.js:184-199` `step2WriteOf` |
| 文案真源 | `server/src/config/scanPage.js:669-696` `PAYMENT_STEP` |
| 收款行 | `server/src/views/scanPageRenderer.js:1038-1051` `paymentRowsHtml` |
| 字段名真源 | `server/src/config/scanWrite.js:208`（`payment_method` / `payment_amount` / `payment_status` / `paid_amount`）· `:286-295`（默认方式「微信」＋候选方式） |

### 2.2 今天页面上的按钮：**两颗**

| 按钮 | 位置 | POST 的 `action` | 干什么 |
|---|---|---|---|
| 「提交整单付款」 | `views/scanPageRenderer.js:1899` | `config/scanPage.js:684` `payAction = payment_pay` | ⭐ **建单就发生在这一刻**（`:1673-1680`：会话里 `paymentStep:'pending'` ⇒ 现在建）；金额/收款不齐 ⇒ `submitSale` 拒 ⇒ **原地重渲染资金页 + 人话 + 一张表都不写** |
| 「跳过」 | `views/scanPageRenderer.js:1926` | `:680` `skipAction = payment_skip` | 同样**先把单建出来**（`:2047` 注释），再走成功页 |

> 🔴 她 2026-10-16 的逐字：「资金页实际上就应该有**两个按钮**」＝ 提交 / 跳过；
>    页面**已无任何链接/跳转**（`views/scanPageRenderer.js:1916-1919` 那两条注释就是这一刀的留痕）。
> ⚠️ 票据要在这一页加**第三颗按钮** ⇒ 与那句话**表面冲突**（她这次点名要的）⇒ 见问题清单 §6 ⑥ 的确认项。

### 2.3 数据从哪来（今天的真实形状）

```
 会话文件(server/data/scan_sessions/*)              ← 真数据在这儿
   session.sale.lines[]       每行 { kind, number, item_no, color, product_record_id,
                                      size, amount, gift, trade_type_code }
        │  写入点：services/scanSessionService.js:208 addLine（**由 scanWriteService 调**）
        │  ⚠️ services/scanWriteService.js **余量 0** ⇒ 不许动 ✗
        │
        ├── sale.submitPending  「刚点过提交、正停在资金页」那一档的尺码/金额/收款
        │      写入点 routes/scanPage.js:2282-2296 · 读点 :1695-1707
        ▼
 路由(scanPage.js) ── step2WriteOf(:184) ──▶ 渲染器(scanPageRenderer.js:1862)
   今天交给页面的：texts / fields / actions / paymentMethods / defaultPaymentMethod /
                   paymentRowCount / paymentStatus / paidAmount / paymentRows /
                   draft:{ lines: [] }   ← 🔴 **固定空数组：草稿行根本没进这一页**
   另有：orderNo（⚠️ 资金页阶段**通常是空串** —— 因为**还没建单**）、submitKey、count、notice
```

- **收款方式的候选** = 读「收款方式管理」那张表（`routes/scanPage.js:160-176 candidatePaymentMethods`：读不到 ⇒ **退回配置里的四种** + 一条 warn）。
- ⚠️ **一个既有残留（不是可用接口）**：`routes/scanPage.js:2311` 给 `sendPaymentStep` 传了 `totalAmountText: 0`，
  但 `step2WriteOf` 与渲染器**都不认这个键**（全仓仅此一处命中）⇒ **是死参数**。
  ⇒ 票据要的「**本单累计金额**」**得自己算**（口径见 §3 AC-V3），**别指望这个键**。

### 2.4 「本单累计」在代码里的既有口径（**照抄，不发明**）

- 写库那一步的累计 = `services/scanWriteService.js:909` `itemsCents` = **Σ 每件实收**（空 = 0）；
  与收款比对、与「差额 ⇒ 未收款」**都用同一个数**（`:1053 owedCents = itemsCents - paidCents`）。
- ⇒ 票据上的「付款金额 = 本单累计」**必须与 `itemsCents` 同口径**，否则票与账面会各说各话。
- ⚠️ **「每件实收」留空时不再用「单价」兜底**（`services/scanWriteService.js:874-883`：方案甲，她 2026-10-11 拍板）
  ⇒ 有留空 ⇒ 累计会**偏小**，这是**既有事实**，票据要**如实**（不许自己补单价 ✗）—— 见问题清单 ④。
- **销售日期**：`config/v1BitableSchema.js:244` `soldAt: '销售日'` —— 全仓**只有这一个映射、零写入点**
  ⇒ 与 `config/accessorySaleIntake.js:47/122` 记的口径一致（她：「**销售日不用管，自动字段**」）。
  ⚠️ 本机**够不着生产 Base**（纪律第 8 条）⇒ **"是不是飞书自动字段"这一条没有只读核过真表**，
  实现时**必须先在服务器上只读核一次**再决定票据上的销售日期从哪取。

---

## §3 ⭐ 判据草案（AC-V1…AC-V13 · 先写、后跑、逐条对照）

> 每条尽量写成**能真红**的判据（去掉实现那一句 ⇒ 红），并标出**怎么核**。

### 内容（六项）

- **AC-V1** 票面上**六项都在**（逐项断言，不是"出现了一个"）：
  ① **logo 位** ② **「邯美皮鞋销售凭证」** ③ **货品类型与尺码** ④ **付款方式** ⑤ **付款金额** ⑥ **销售日期**。
  *怎么核*：渲染器单测（快照/字段断言）＋ 产物 PDF 的文本或位图比对。
- **AC-V2** ⭐ **logo 现在是【占位】**：文字「邯美皮鞋」＋**预留图片位**；
  `config/salesVoucherTicket.js` 的 `logoPath` 默认**空/占位**；
  🔴 **源码哨兵：仓库里不许出现任何"看起来像 logo"的自制图形/SVG**（她给了图 ⇒ **只换文件、不改代码**）。
  *怎么核*：`logoPath` 为空时渲染不抛 + 断言票面上有文字占位；grep 哨兵（无内联 logo 图形）。
- **AC-V3** 付款金额 = **本单累计**（**Σ 每件实收**，与 `scanWriteService` 的 `itemsCents` **同口径**）：
  **不是**单件金额 ✗ · **不是**货号级 ✗ · 多货品 ⇒ **合计** ✓。
  *怎么核*：3 件不同金额 ⇒ 票面金额 = 3 者之和（用例直接钉数）。
- **AC-V4** 🔴 **票面不出现货号**：不得出现 `item_no` / 「货号」字样 / 编号串（`货号|颜色|类别`）。
  *怎么核*：渲染单测对文本断言"不含"；**源码哨兵**（票据渲染器不 import/不读 `item_no` 以外的货号字段——
  以**渲染入参的 keys** 收窄到白名单，塞回即红）。
- **AC-V5** ⭐ **一单一票**：本单有几个货品都只出一张 ⇒ `total_labels === 1` 且 PDF `page_count === 1`；
  多货品时**品类/尺码按她拍板的摆法**呈现（见 §6 ②，**她没说之前这条标 [待她拍板]**，实现按选项走）。
- **AC-V6** 销售日期：**资金页阶段 = 打印当天（上海时区 `Asia/Shanghai`）**；
  若她选"建单后才给打"那一档 ⇒ 取**销售明细.销售日**（自动字段，只读）。
  *怎么核*：注入固定 `now()` ⇒ 断言票面日期逐字。

### 入口与时机

- **AC-V7** 入口 = **资金页一颗按钮**（「打印销售凭证」）：`action=print_voucher` 的**原生表单 POST**（零 JS 可行 ✓）。
- **AC-V8** 🔴 **不点不出**：页面加载 / 提交 / 跳过**都不触发**任何票据任务（源码哨兵：票据入队**只**出现在那一个分支里）。
- **AC-V9** **不写业务表**：点这颗按钮**只入队**（零 `bitable.record.*` / 零库存动作 / 零会话写入以外的副作用）——
  与既有 `print_label`（`routes/scanPage.js:1543-1600` 的注释）**同一条边界** ✓。

### 走哪条链路（她口径 ①）

- **AC-V10** 走**现有链路**：票据任务进的是**同一个** `getLabelPrintQueue()` 单例（`services/labelPrintQueueRuntime.js:27`），
  电脑侧接口（`routes/labelPrintDevice.js`）与 `print-helper/**` **零改动**；
  🔴 **源码哨兵：不新增打印接口、不新建第二个队列、不改电脑侧协议**（她："复用现有那套"）。
- **AC-V11** 电脑没开 / 打印失败 ⇒ **如实**（复用既有 `config/labelPrintQueue.js:231-270` 的 texts：在线/未连接/排队/失败+原因），
  **绝不假成功** ✗；同一份请求 60s 窗口内**只建一个任务**（`:202 dedupeWindowMs`），
  她**真要再打一张**时走 `again`（`:206-207`）。
- **AC-V12** 纸型：PDF **每页 `/MediaBox` = 配置的票据尺寸**（mm→pt，照 `buildPdf:1182`）；
  🔴 **真机判据**：纸上尺寸/方向对 —— 前提是**驱动纸型与之一致**（⇒ 问题清单 ③）。

### 不回归 + 配置先行

- **AC-V13** **配置先行**：尺寸/文案/字段开关/logo 路径全在 `config/salesVoucherTicket.js`
  （改尺寸、改一句话**都不用改代码**；显式布尔开关）；**并且不回归**：
  标签打印（单张 / 批量 / 扫码打印 / 补打）与资金页**既有两颗按钮**（提交 / 跳过）行为**一字不动** ✓。

---

## §4 建议实现顺序（等哪个文件让出 ⇒ 先做哪块）

| 阶段 | 内容 | 依赖 | 能否现在开工 |
|---|---|---|---|
| **P0** | `config/salesVoucherTicket.js` ＋ `services/salesVoucherTicketService.js`（纯函数 + 单测；先只做**文字占位版**的票据） | 无（**全是新文件**） | ✅ **现在就能做** |
| **P1** | 队列接线：`services/labelPrintQueueService.js` 加 `mode:'voucher'`（三处并列新增） | 无（打印链路**现在空闲**，见 §5 证据） | ✅ **现在就能做**（与 P0 并行 ✓） |
| **P2** | 资金页那颗按钮 ＋ 路由那一支 ＋ 把**会话草稿/`submitPending`/收款行**交给票据 | ⛔ **等 `views/scanPageRenderer.js` ＋ `routes/scanPage.js` 让出** | ⛔ 等排期 |
| **P3** | 纸型/方向**真机**确认（她 + 店里那台电脑的驱动）⇒ 定 `salesVoucherTicket` 的最终尺寸默认值 | ⛔ 她的答复（§6 ③） | ⛔ 等她 |
| **P4** | logo 换成她发的图（**只换文件**，不改代码） | ⛔ 她的图（§6 ①） | ⛔ 等她 |

> ⚠️ **P2 之前建议先把 §6 的 ②④⑤⑥ 拿到答复**：票据"长什么样"取决于那几条，
>    先写死再改 = 返工两张纸的事（而且她可能已经贴在墙上/给顾客了）。

---

## §5 🔴 前置：文件占用（本步只读的**证据**）

```
$ git worktree list            （节选：有未提交改动的才列）
.local/multi-item3    M server/src/routes/scanPage.js
                      M server/src/views/scanPageRenderer.js
                      M server/src/config/multiItemOrder.js
                      M server/test/multiItemOrderRender.test.js
                      M server/test/multiItemOrderReturnTrim.test.js
.local/vcol           M docs/test-base-voucher-column-2026-10-16.md
                      R server/scripts/…-add-voucher-column.mjs
.local/texts-webhook2 M server/src/config/purchaseWebhookTexts.js
.local/speed2         M server/src/services/v1BitableGateway.js
```

⇒ **`views/scanPageRenderer.js` 与 `routes/scanPage.js` 现在确实被占着**（`multi-item3` 的**未提交**改动）✓
⇒ **打印链路那几份（`config/labelPrint*.js` · `services/labelPrint*.js` · `routes/labelPrint*.js` · `print-helper/**`）
  没有任何 worktree 处于脏状态** ⇒ **P0/P1 现在开工不会和别人打架** ✓
⇒ ⭐ **本步一个字都没写 `server/src/**`** ✓（只读 + 本文件 + 索引登记）

---

## §6 ⭐ 需要她拍板的问题清单（**这就是要回报给她的**）

| # | 问题 | 选项 / 我的建议 | 为什么非问不可 |
|---|---|---|---|
| **①** | **logo 图**（🔴 必需） | 请她发一张 **PNG/JPG（尽量高清、纯色/透明底都行）**；不给我就先上**文字占位**（「邯美皮鞋」＋预留图片位），**绝不自己画一个** ✗ | 她说"大 logo"是**票面最显眼的一格**；假 logo 一旦被她当成成品就白做 |
| **②** | **品类与尺码怎么摆**（一单一票、多货品时） | ⓐ **品类去重并列 + 尺码合并**（例：`男鞋 41·42 ｜ 单鞋 38`）ⓑ **一个品类一行**，行尾列该品类下的尺码 ⓒ 逐件一列（不合并，最啰嗦但最不易误读）ⓓ 尺码只写**件数**（如"2 双"）。**我倾向 ⓑ**（一单一票时最好读） | 这条**我定不了**（她点名要我列成选项）✗ —— 而且"品类"到底指**类别（男鞋/女鞋，A/B）**还是**品类（休闲鞋/单鞋，公式列）**也得她一句话（她举例"男鞋、单鞋"正好**两边都沾**） |
| **③** | **票据尺寸 + 打在哪台机器**（🔴 **上线阻塞项**） | ① 票据纸多大（例：`57×40mm` / `80mm 小票` / A4）② 用**现在这台标签机**还是**另一台票据机** ③ 纸型在这台电脑的驱动里怎么设（`SumatraPDF` 打的是**默认打印机**） | 40×30mm 的标签纸**放不下这六项**（现在标签只有货号/颜色/尺码/二维码）；服务器只能定 PDF 的 `/MediaBox`，**纸上多大在驱动里** |
| **④** | **「付款金额 = 本单累计」的准确含义** | 这单**只收了 200**（部分付）/ **一分没付** 时，票面写：ⓐ **本单累计 500**（她的原话字面）ⓑ **本次实收 200** ⓒ **两行都写**（`累计 500 ／ 已收 200`）。**我倾向 ⓒ** | 只写 500 会被**读成"已付清"**；而"每件实收留空"时累计还会偏小（既有事实）；这是**票面语义**问题，不是我们能替她定的 |
| **⑤** | **付款方式有多笔时怎么显示** | 资金页的收款行**本来就可以多行**（她 2026-10-11 的例子：`500 = 微信 200 + 现金 300`）⇒ ⓐ 方式**去重并列**（`微信／现金`）ⓑ **一笔一行**（方式+金额，最忠实）ⓒ 只写第一笔。**我倾向 ⓑ** | 她原话是"付款方式"（单数），与页面上的**多笔**形状对不上 |
| **⑥** | **打印时机：资金页那颗按钮点下去时，这一单还没落库** | 这符合她"③资金页一颗按钮"的原话；代价是 ⓐ 票上的**销售日期只能是"打印当天"**、票上**没有单号**（她六项里也确实没要单号）；她点了打印又**没提交** ⇒ 会存在一张**系统里没有对应单**的票。⇒ 确认按 ⓐ 来；还是要 ⓑ "提交成功后才给打（成功页那颗按钮）"？ | 顺带：她 2026-10-16 说过「资金页**实际上就应该有两个按钮**」——加这颗**就是第三颗**，得让她知道并确认 ✓ |
| **⑦** | 一单要打几张 / 要不要「再打一张」 | 默认 **一单一票**；60s 内重复点**不重复出纸**（既有防连点）；要补打 ⇒ 点【再打一张】（`again`）✓ | 防的是"点完没反馈 ⇒ 狂点 ⇒ 多出纸"（2026-10-11/12 真机踩过） |
| **⑧** | 票面**要不要**单号/流水号 | 她说的是六项，**没有单号** ⇒ 默认**不加** ✗；若要加，资金页阶段还**没有单号**（未建单）⇒ 得改成"建单后打" | 免得我们"顺手加一个"（她没要） |

---

## §7 诚实标注：未做 / 未核

**未做（有意 ✗）**
- 未写任何 `server/src/**`（本步只读 + docs ✓）；`services/scanWriteService.js` **零改动**（余量 0 ✓）。
- 未碰 `config/scanWrite.js` · 未碰任何人 worktree · **未部署** · **未用飞书 CLI** · **未合并 PR**。
- 未登记 `docs/pending-confirmations.md` / `docs/owner-requests-backlog.md`
  —— 那两份是 **Lead 单写者**维护的；§6 的问题清单就在本文件里，**Lead 可直接抬进去** ✓。

**未核（本机够不着 / 不属本步）**
- 「销售明细.**销售日**」在生产真表里**是不是飞书自动字段**：代码里**只有映射、零写入点**，
  与既有口径一致，但**没有只读核过真表**（本机不配生产凭证 —— 纪律第 8 条）⇒ **实现前必须在服务器上只读核一次**。
- 店里那台电脑**现在的驱动纸型**、有没有**第二台票据打印机** ⇒ 问题 ③，**只能她/现场回答**。

---

## §8 一句话总结

> 打印链路（手机点 ⇒ 服务端出 PDF ⇒ 店里电脑 SumatraPDF 送进打印机）**是通的、且现在没人占** ⇒
> 票据只要在 **①配置 ②产物渲染 ③队列 `mode:'voucher'`** 三处**并列新增**就能复用到底，
> 电脑侧一行都不用改 ✓；**卡住的两件事**是：
> **(a)** 资金页那颗按钮要落在 `views/**` + `routes/scanPage.js`（**正被别人占着 ⇒ 排期**）；
> **(b)** **票据尺寸/纸型**与**logo 图**都在她手里 ⇒ **先拿到答复再动手** ✓。
