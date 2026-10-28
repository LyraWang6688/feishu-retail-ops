# 采购页进入生产（供应 → 录单 → 采购）· AC / 数据表草稿 / handoff 方案

> 日期：2026-10-28
> 任务：task-8（`procurement-eng`）
> 工作区：`.local/wt-procurement`（分支 `feat/procurement-page-real`，基于 main `92fe2a9b`，HEAD `f3a8deb5` 保留「上架日期」映射）
> 视觉目标（业务负责人已确认）：`docs/prototypes/procurement-board-2026-10-27.html` = **生产目标视觉稿**
> 本文件：先写验收标准（AC）→ 再写代码 → 最后逐条对照。**数据表只出草稿，不写生产 Base（Lead 写）。**

---

## 0. 业务口径（2026-10-28 业务负责人逐条确认，以此为准）

```text
入口：供应 → 录单 → 采购（/workbench/procurement.html）
三个子 tab：补货 / 上新 / 扫一扫
tab 切换保留当前会话已选数据；点「提交」才统一写入
提交复用既有采购链路（多货品 → multiItemOrderService → PurchaseWebhookService.publishPurchaseRequest），
  不新建草稿表、不新建写库路径
页面只产出 items：product_record_id + size + quantity；供应商/采购行为/批次号/幂等键由既有链路处理
```

**补货**

- 数据源：**只查「销售明细」这一张表**（业务负责人 2026-10-28 纠正：不再改成实时库存）；
- 筛选：`库存数量`（销售明细里的公式列）== 0；
- 时间：`销售日` 按上海时区「今天 00:00 往前 3 个自然日」= `[今天-3 00:00, 今天 00:00)`，页面统计范围显示这 3 天；
- 分组：按 **货品信息 record_id（记录ID，内部主键）→ 尺码**；卡片标题只显示「货号 · 颜色」；
- 交易类型（现货 SALE_CASH / 预订 SALE_PREPAID）判据复用 `src/config/salesMovements.js`；
- 每尺码：现货已售 N / 预订待补 M；**一个数量框**：预订行默认选中、数量 = 预订数；现货行默认不选，勾选后数量 = 现货数；均可手改；
- 顶部统计：现货已售总双数 / 预订待补总双数 / 涉及货品数 + 统计范围（日期区间）。

**上新**

- 数据源：`货品信息`；筛选 `上架日期`（auto CreatedTime，schema 映射 `product.createdAt`）= 今天（上海时区）；
- 分组：按记录 ID（**只内部用，页面不展示**）；卡片标题「货号 · 颜色」，小字「今日 HH:mm 新增 · 供应商」；
- 尺码：类别（A/B）+ `SCAN_PAGE.SIZE_SEGMENTS` 的 normal/special；普通码默认 1 双，特殊码默认 0 且折叠；
- **顶部统计只保留「新增货品」一个**（业务负责人 2026-10-28 再确认；不做「新增颜色数 / 普通码待采购」）；
- **不展示 / 不筛选货品状态**（在售、停售都按视觉稿展示）；
- 不读「品类」，不加品类映射。

**扫一扫（本轮不做，业务负责人 2026-10-28 决定）**

- 只保留视觉入口：tab 存在但**禁用/占位**，点它不扫码、不开会话、不进提交；
- 本轮不实现扫码逻辑、不写扫一扫的页面数据行、不实现重复扫码处理；
- 扫一扫以后单独一轮处理（动作名 `procurement_scan_returned` 仍保留在服务端 ui-tap 允许清单里，本轮页面不调）。

**草稿 / 提交**

- 草稿：localStorage，key 带当前用户 `open_id`（来自 `/api/auth/feishu/me`；未登录按既有页面方式提示登录）；
- **补货 + 上新同一张草稿**；切 tab / 刷新 / 关掉重开都保留；只有提交成功才清空；提交失败保留；
- 同一 `product_record_id` + 尺码只留一行（重复来源数量相加，见 AC-P6）；
- 提交前 0 写入业务表；点提交只发 1 次 POST；服务端同步校验（空单 / 尺码 / 数量 / 重复 / 20 货品 / 50 行）→ 通过后走既有链路；
- 成功提示统一「已提交成功，数据会更新」（既有异步口径）；失败给人话、保留草稿；
- 客户端草稿持有稳定 `submitKey`（一次草稿一把，成功才换），服务端原样传给 `submitDraft` 做幂等重试；
- 不新增服务端草稿表（草稿种子写进**既有** `data/scan_sessions/` 那个 store，与引擎同一容器）；
- 不改退货 / 验收 / 标签打印 / 销售。

---

## 1. 验收标准（AC）

### 1.1 数据与读模型

- **AC-P1 补货只查销售明细一张表**：读模型只调用「销售明细」的列表接口；**不得**出现对「实时库存」的读取（反向哨兵：代码里 `liveInventory` 表键出现即红）。
- **AC-P2 3 天窗口（上海时区）边界**：`今天 00:00 − 3 天 ≤ 销售日 < 今天 00:00`；
  - 边界内（昨天 23:59:59 上海）→ 计入；边界外（今天 00:00:00 整、今天-4 日 23:59:59）→ 不计入；
  - 统计范围文案 = `M月D日 – M月D日`（首尾两端都是这 3 天内）。
- **AC-P3 库存 = 0 过滤**：`库存数量` 读成数字；`0` 计入，`>0` / 空 / 认不出 一律不计入。
- **AC-P4 现货 / 预订计数**：交易类型按 `行为管理.行为编码`（`SALE_CASH` / `SALE_PREPAID`）映射；
  行为表编码缺失 / 认不出 ⇒ 该行**不计入任一侧**（不猜），并打 warn。
- **AC-P5 补货分组 / 排序 / 标题**：按货品 record_id 分组（同 record_id 合并），卡片标题 =「货号 · 颜色」（`货号` 缺失回落 `编号`）；
  组排序 = 预订待补总数降序 → 现货已售降序 → 货号升序；组内尺码升序；涉及货品数 = 组数。
- **AC-P6 上新今天过滤**：`上架日期` 落在 `[今天 00:00, 明天 00:00)`（上海时区）；昨天 23:59:59 不计入；分组键 = 记录 ID；
  **响应里不得包含品名字段以外的展示用途**：`recordId` 只作内部主键（页面不展示）。
- **AC-P7 上新尺码与默认值**：类别 A → 普通码 38–44 / 特殊码 45–48；类别 B → 普通码 36–40 / 特殊码 34/35/41/42/43；
  默认普通码 1 / 特殊码 0；**类别缺失 ⇒ 不猜**：`categoryMissing=true` + 空尺码 + 页面给人话（不默认 A）。
- **AC-P8 上新顶部统计只有「新增货品」**（记录数）；**不得**返回「新增颜色数 / 普通码待采购」两个统计（反向哨兵）。
- **AC-P9 扫一扫本轮占位**：`扫一扫` tab 视觉入口保留但**禁用/占位**（`disabled` + `aria-disabled` + 配置文案），
  点击不扫码、不发请求、不产生草稿/提交；页面不 import 扫码模块（反向哨兵）；本轮不实现扫码查货品接口。

### 1.2 提交与写入

- **AC-P10 端点契约**：
  ```text
  GET  /api/workbench/procurement/replenish
  GET  /api/workbench/procurement/new-products
  POST /api/workbench/procurement/submit  { submitKey, items:[{ productRecordId, entries:[{size,quantity}] }] }
  ```
- **AC-P11 提交前零写入**：三层都成立
  ① 两个 GET 与 product 查询只读（不出现 `gateway.create/update`）；
  ② `POST /submit` 在校验失败时**一次写都不发生**（引擎 0 次调用、后台 0 次排队）；
  ③ 页面在点提交之前**不发任何写请求**（Playwright 断言请求列表）。
- **AC-P12 同步校验**（全部在排后台之前，返回 400 + 人话 + 零写入）：空 items / 尺码非法（非 1..max 整数）/ 数量非法 / 同货品同尺码重复 /
  超过 20 货品 / 超过 50 行 / `submitKey` 缺失或非法 / 货品记录 ID 查不到。
- **AC-P13 复用既有链路**：校验通过后只调 `multiItemOrderService.submitDraft`（其内部 `writers.purchase` → `PurchaseWebhookService.publishPurchaseRequest`）；
  **不新增第二条写库路径**（源码哨兵：本域不得直接 `gateway.create('purchaseOrderBatch'|'purchaseRequest')`）。
- **AC-P14 异步成功口径**：HTTP 先回 `accepted:true` + 「已提交成功，数据会更新」；后台 `scheduleCustomRest` 跑 `submitDraft`；
  后台失败记 warn + 落会话 `last_error`（不假装成功），`submitKey` 原样透传（幂等重试同一把键）。
- **AC-P15 幂等 submitKey**：同一 `submitKey` 重复 POST ⇒ 第二次返回 `reused:true`，**不再排后台、不再写一次**；
  草稿已 `submitted` 时直接返回复用结果。
- **AC-P16 一个采购批次**：一次提交 = 1 个采购批次（引擎 `batchCount:1`），不按供应商拆批次（既有 supplierSplit 口径不变）。

### 1.3 前端页面

- **AC-P17 薄壳 + 模块化**：`procurement.html` 只做壳（引 CSS/模块、挂载根节点，≤200 行）；业务逻辑全在
  `features/procurement/**`；文案/默认值/尺码规则/端点/刷新参数全在 `config/procurement.js`；
  新文件每个 ≤200 行；**不往旧 398 行演示页补逻辑，整体替换**。
- **AC-P18 视觉 = 原型**：三 tab（补货 / 上新 / 扫一扫）、顶部统计卡、统计范围、图例、分组卡、尺码行、底部固定提交条
  与 `docs/prototypes/procurement-board-2026-10-27.html` 一致；**颜色只引用 `styles/tokens.css` 的 token，
  不写 hex/rgb，不写内联 style**（反向哨兵：新文件里 `#rrggbb` / `rgb(` / `style="` 出现即红）。
- **AC-P19 会话保留**：切 tab / 刷新 / 扫码往返 / 关掉重开（同用户同浏览器）后，已选货品、尺码、数量、选中状态都在；
  只有提交成功才清空；提交失败保留；localStorage key 含 `open_id`（不同用户互不串）。
- **AC-P20 懒加载 / 请求数**：首屏只请求 `replenish` 一次；点上新 tab 才请求 `new-products`；切回补货不重复请求（同一会话内缓存）；
  两个 GET 都只在成功后才写缓存，失败可重试。
- **AC-P21 扫一扫占位**：`扫一扫` tab 渲染为禁用入口（配置文案说明本轮未开放），点击无副作用：
  不打开相机、不发任何请求、不报错、不白屏、不影响补货/上新草稿与提交（Playwright 断言请求数不变）。
- **AC-P22 提交交互**：点「提交」只发 1 次 POST（连点 / 提交中也只 1 次）；成功后清空草稿 + 统一成功提示；
  失败给配置里的错误文案 + 草稿保留；已选合计（总双数 + 补货/上新拆分）实时更新。
- **AC-P23 移动端**：390×844 / 604×900 无横向滚动；点击区 ≥44px；底部提交条不被安全区遮挡。

### 1.4 工程与验证

- **AC-P24 测试**：`cd server && pnpm test` 0 fail；`pnpm run size:check` 绿；`pnpm run test:e2e` 绿；
  `git diff --check` 干净；新增单测覆盖 AC-P1..P16 与前端纯函数；Playwright（mock API）覆盖 AC-P19/P20/P22 + 390/604 截图。
- **AC-P25 不写生产 Base / 不部署**：代码与测试不写任何生产 Base 业务表；数据表草稿见 §5/§6（Lead 写）；不部署。
- **AC-P26 不碰其他领域**：只改采购页/采购路由/采购服务/采购测试/采购文档；销售、库存、货品、资金、验收、标签打印文件零改动。

---

## 2. 代码落点（实际方案）

```text
server/public/workbench/procurement.html                        薄壳（替换旧 398 行演示页）
server/public/workbench/procurement.css                         采购页样式（只用 tokens，无 hex/rgb）
server/public/workbench/config/procurement.js                   前端配置（文案/端点/默认值/尺码/刷新）
server/public/workbench/features/procurement/index.js           mount/facade
server/public/workbench/features/procurement/store.js           会话草稿（localStorage）+ 选中合计纯函数
server/public/workbench/features/procurement/api.js             只读/提交端点封装 + 懒加载缓存
server/public/workbench/features/procurement/render.js          通用渲染器（统计卡/分组卡/尺码行/步进器/空错态/toast）
server/public/workbench/features/procurement/replenish.js       补货 panel
server/public/workbench/features/procurement/newProducts.js     上新 panel
server/public/workbench/features/procurement/submit.js          提交动作 + 底部合计条
server/src/config/procurementPage.js                            服务端配置（端点/文案/窗口/上限/事件/默认值）
server/src/services/procurementPageData.js                      只读读模型纯函数（窗口 / 归一化 / 补货分组统计）
server/src/services/procurementPageNewProductsData.js          上新纯函数（今天窗口 / 尺寸 / 统计）
server/src/services/procurementPageService.js                   只读读模型 I/O（补货 / 上新；只查销售明细 + 货品信息）
server/src/services/procurementPageSubmitService.js             提交（同步校验 → 种子草稿 → 后台 submitDraft）
server/src/routes/workbench/purchase.js                         只加 4 个采购页端点（共享父 router 不改）
```

**复用（不重写）**

```text
只读：V1BitableGateway.listByFilter / listAll / getBatch / get；V1_BITABLE_SCHEMA（字段映射唯一来源）
交易类型：config/salesMovements.js（SALE_CASH / SALE_PREPAID）
尺码：config/scanPage.js 的 SIZE_SEGMENTS（normal / special）
草稿/提交：services/multiItemOrderService.js（validateDraft / planSubmission / submitDraft）
写入：services/purchaseWebhookService.js 的 publishPurchaseRequest（经 multiItemWriters().purchase）
后台：services/purchaseWriteBackgroundService.js 的 scheduleCustomRest（不另造后台件）
会话：services/scanWriteService.js 的 sessions（既有 data/scan_sessions/ store，不新建草稿表）
前端：core/api-client、core/auth、core/formatters、shared/ui-tap、features/scan/launch.js、shared/toast
```

**提交时序**

```text
点击提交
 → POST /procurement/submit { submitKey, items }
 → 同步校验（提交键 / items 形状 / 尺码 / 数量 / 重复 / 20 货品 / 50 行 / 货品存在）
 → 用货品记录 ID 反查货品（编号/货号/颜色/供应商，服务端权威）
 → engine.validateDraft（同一套配置上限）
 → 把草稿种子写进既有 scan_sessions store（key = procurement:<submitKey>）
 → scheduleCustomRest(run = engine.submitDraft({submitKey}))
 → 立刻返回 accepted（「已提交成功，数据会更新」）
 → 后台：submitDraft → planSubmission → publishPurchaseRequest（既有采购批次 + 明细）
```

---

## 3. 未确认 / 需业务负责人拍板

1. **补货「库存数量 = 0」的公式语义**：按 2026-10-28 纠正只查销售明细的公式列；若该公式以后改口径，页面跟着变（不另算）。
2. **补货统计范围**：当前按「今天 00:00 往前 3 个自然日」= 最近 3 个完整自然日（不含今天），与原型「10月25日 – 10月27日」一致。
   若业务要含今天，改 `config/procurementPage.js` 的 `window.includeToday` 即可（默认 false）。
3. **扫一扫整块**：业务负责人 2026-10-28 决定本轮不做（tab 占位/禁用），下一轮单独处理。
4. **上新是否限制货品状态**：业务负责人已确认不展示/不筛选，保持。
5. **字段清单定位**（页面所有字段 vs 只记写入 payload）：草稿按「两种都列、并标注」出，待确认后裁剪。

---

## 4. 验收方式（交付时逐条对照）

```text
cd server && pnpm test           → tests / pass / fail
cd server && pnpm run size:check → 绿
cd server && pnpm run test:e2e   → 绿（mobile 390 + tablet 604）
Playwright 截图 → docs/procurement-page-real-shots/
git diff --check → 干净
```

---

## 5. 「页面数据」表逐行草稿（表 `tblNZlaBTX4UpFCr`，Lead 写）

> 列口径：一级tab / 页面tab / 来源数据表 / 使用字段 / 字段作用 / 显示位置（沿用现有列；需要新增列先问 Lead，不擅自加）。

### 5.1 表结构选项补充

| 类型 | 值 | 理由 |
| --- | --- | --- |
| 页面tab（选项） | **扫一扫** | 三 tab 之一（本轮 tab 占位，**不写扫一扫数据行**） |
| 来源数据表（选项） | **供应商管理** | 上新/扫码卡片「供应商」名称来源 |
| 来源数据表（选项） | **尺码管理** | 普通/特殊码划分依据（经 `SCAN_PAGE.SIZE_SEGMENTS`） |
| 来源数据表（选项） | **行为管理** | 补货「交易类型（现货/预订）」的编码来源 |
| 来源数据表（选项） | **页面计算** | 统计、合计、选中状态、HH:mm 派生等页面计算字段 |
| 来源数据表（选项） | **货品信息** | 上新/扫码的货号、颜色、类别、供应商、上架日期、记录ID |

### 5.2 补货（页面tab = 补货）

| 一级tab | 页面tab | 来源数据表 | 使用字段 | 字段作用 | 显示位置 |
| --- | --- | --- | --- | --- | --- |
| 供应 | 补货 | 销售明细 | 销售日 | 近 3 天窗口筛选（今天 00:00 往前 3 个自然日） | 顶部统计范围 |
| 供应 | 补货 | 销售明细 | 编号 | 关联货品信息（取记录ID/货号/颜色/类别） | 分组卡片 |
| 供应 | 补货 | 销售明细 | 尺码 | 按尺码聚合现货/预订数量 | 尺码行 |
| 供应 | 补货 | 销售明细 | 库存数量（公式） | 只保留 = 0 的行（补货判据） | 不展示（筛选条件） |
| 供应 | 补货 | 销售明细 | 交易类型 | 关联行为管理 → SALE_CASH 现货 / SALE_PREPAID 预订 | 尺码行标签 |
| 供应 | 补货 | 销售明细 | 编号 | 计数：同编号同尺码行数（现货已售 / 预订待补） | 尺码行数量 |
| 供应 | 补货 | 行为管理 | 行为编码 | 交易类型判据（现货 SALE_CASH / 预订 SALE_PREPAID） | 不展示（判据） |
| 供应 | 补货 | 货品信息 | 记录ID（record_id） | 分组主键 + 提交 payload 的 product_record_id | 数据主键（页面不直接展示） |
| 供应 | 补货 | 货品信息 | 货号 | 卡片标题「货号 · 颜色」 | 分组标题 |
| 供应 | 补货 | 货品信息 | 编号 | 货号缺失时的回退标题 | 分组标题（回退） |
| 供应 | 补货 | 货品信息 | 颜色 | 卡片标题「货号 · 颜色」 | 分组标题 |
| 供应 | 补货 | 货品信息 | 类别 | 特殊码/普通码参考（补货按销售尺码显示，不用它造尺码） | 不展示（参考） |
| 供应 | 补货 | 货品信息 | 供应商 | 随 items 交给既有采购链路（批次供应商分组） | 不展示（payload） |
| 供应 | 补货 | 页面计算 | 现货已售 / 预订待补 | 每尺码计数汇总 + 顶部统计 | 顶部统计 + 尺码行 |
| 供应 | 补货 | 页面计算 | 涉及货品 | 分组数 | 顶部统计 |
| 供应 | 补货 | 页面计算 | 采购数量 | 默认值：预订=预订数、现货勾选后=现货数，可手改 | 尺码行数量框 |
| 供应 | 补货 | 页面计算 | 选中状态 | 预订默认选中；现货默认不选 | 尺码行勾选/数量框 |
| 供应 | 补货 | 页面计算 | 已选合计 / 补货合计 | 底部条（已选采购总数 + 补货合计） | 底部提交条 |
| 供应 | 补货 | 页面计算 | 统计范围 | 3 天窗口首尾日期文案 | 顶部统计卡底部 |

### 5.3 上新（页面tab = 上新）

| 一级tab | 页面tab | 来源数据表 | 使用字段 | 字段作用 | 显示位置 |
| --- | --- | --- | --- | --- | --- |
| 供应 | 上新 | 货品信息 | 上架日期 | 只取今天 00:00 之后新增的记录 | 筛选条件 + 卡片小字 |
| 供应 | 上新 | 货品信息 | 记录ID（record_id） | 分组主键 + 提交 payload 的 product_record_id | 数据主键（页面不直接展示） |
| 供应 | 上新 | 货品信息 | 货号 | 卡片标题「货号 · 颜色」 | 分组标题 |
| 供应 | 上新 | 货品信息 | 颜色 | 卡片标题「货号 · 颜色」 | 分组标题 |
| 供应 | 上新 | 货品信息 | 类别 | 普通码 / 特殊码划分（A/B） | 不展示（判据） |
| 供应 | 上新 | 货品信息 | 供应商 | 卡片小字「今日 HH:mm 新增 · 供应商」+ payload | 卡片小字 |
| 供应 | 上新 | 货品信息 | 上架日期 | 派生「今日 HH:mm」 | 卡片小字 |
| 供应 | 上新 | 尺码管理 | 尺码 | 普通码/特殊码清单来源（经 SIZE_SEGMENTS） | 尺码行 |
| 供应 | 上新 | 供应商管理 | 供应商名称 | 供应商名称显示（货品信息.供应商关联回填） | 卡片小字 |
| 供应 | 上新 | 页面计算 | 普通码 / 特殊码划分 | 类别 → SIZE_SEGMENTS.normal / special | 尺码行 / 折叠块 |
| 供应 | 上新 | 页面计算 | 普通码默认 1 / 特殊码默认 0 | 采购数量初值（可手改） | 尺码行数量框 |
| 供应 | 上新 | 页面计算 | 采购数量 | 可手改的数量 | 尺码行数量框 |
| 供应 | 上新 | 页面计算 | 选中 / 展开状态 | 特殊码默认折叠；有数量的行视为已选 | 折叠块 / 尺码行 |
| 供应 | 上新 | 页面计算 | 上架时间 HH:mm | 由上架日期派生（上海时区） | 卡片小字 |
| 供应 | 上新 | 页面计算 | 新增货品 | 顶部统计（唯一统计项：今天新增记录数） | 顶部统计 |
| 供应 | 上新 | 页面计算 | 已选合计 / 上新合计 | 底部条（已选采购总数 + 上新合计） | 底部提交条 |
| 供应 | 上新 | 页面计算 | 统计范围 | 「今日 00:00 – 现在」 | 顶部统计卡底部 |

> ⚠️ 业务负责人 2026-10-28 再确认：上新顶部**只保留「新增货品」**，不写「新增颜色数 / 普通码待采购」两行。
> 业务负责人 2026-10-28 确认：「页面数据」表**要包含页面计算 / UI 状态字段**，来源列一律写 `页面计算`，不伪装成 Base 字段。

### 5.4 扫一扫（本轮暂缓，不写行）

业务负责人 2026-10-28 决定：扫一扫本轮先不做（tab 仅占位/禁用），
**「页面数据」表本轮不补任何扫一扫行**；扫一扫的记录ID/编号/颜色/类别/尺码/默认数量/已选状态/重复扫码等待单独一轮处理。

### 5.5 提交（页面tab = 补货/上新 共用底部条）

| 一级tab | 页面tab | 来源数据表 | 使用字段 | 字段作用 | 显示位置 |
| --- | --- | --- | --- | --- | --- |
| 供应 | 补货/上新 | 页面计算 | 已选采购总数 | 底部条 b 值 | 底部提交条 |
| 供应 | 补货/上新 | 页面计算 | 补货合计 / 上新合计 | 底部条小字拆分 | 底部提交条 |
| 供应 | 补货/上新 | 页面计算 | 逐货品 + 尺码 + 采购数量 | 提交 payload items | 不展示（payload） |
| 供应 | 补货/上新 | 货品信息 | 记录ID | payload 的 product_record_id | 不展示（payload） |
| 供应 | 补货/上新 | 货品信息 | 供应商 | 批次供应商分组（既有 supplierSplit） | 不展示（payload） |
| 供应 | 补货/上新 | 页面计算 | 提交按钮 / 成功提示 / 失败提示 | 「已提交成功，数据会更新」/ 人话错误 | 底部提交条 |
| 供应 | 补货/上新 | 页面计算 | 幂等键 submitKey | 一次草稿一把；草稿存 localStorage，键含 open_id | 不展示（payload） |

---

## 6. 「字段清单」表逐行草稿（表 `tblZYD5jlXZEVzPM`，Lead 写）

> 「是否进入服务端payload」按**采购页**口径：`true` = 进 `/procurement/submit` 的 items 或由服务端反查后进采购写入 payload；
> 只读展示字段 = `false`（并标注「页面只读」）。

### 6.1 直接读表 / 写入 payload（字段清单只记这两类；页面计算只进「页面数据」）

| 来源数据表 | 字段名 | 语义键（代码） | 是否进入服务端payload | 所属页面 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 销售明细 | 编号 | salesDetail.product | true（服务端以记录ID为准） | 补货 | 关联货品 |
| 销售明细 | 尺码 | salesDetail.size | true | 补货 | items.entries[].size |
| 销售明细 | 销售日 | salesDetail.soldAt | false | 补货 | 3 天窗口筛选（只读） |
| 销售明细 | 交易类型 | salesDetail.tradeType | false | 补货 | 现货/预订判据（只读） |
| 销售明细 | 库存数量（公式） | salesDetail.stockQuantity | false | 补货 | =0 筛选（只读；**来源表保持销售明细**） |
| 货品信息 | 记录ID | record_id（接口值） | true | 补货/上新 | product_record_id（数据主键，页面不展示） |
| 货品信息 | 编号 | product.number | false | 上新（+补货标题回退） | 标题回退 |
| 货品信息 | 货号 | product.itemNo | false | 补货/上新 | 卡片标题 |
| 货品信息 | 颜色 | product.color | false | 补货/上新 | 卡片标题 |
| 货品信息 | 类别 | product.category | false | 上新 | 普通/特殊码判据（补货不用它造尺码） |
| 货品信息 | 供应商 | product.supplier | true（服务端反查） | 补货/上新 | 批次供应商分组 |
| 货品信息 | 上架日期 | product.createdAt | false | 上新 | 今天筛选 + HH:mm 派生 |
| 行为管理 | 行为编码 | behavior.code | false | 补货 | SALE_CASH / SALE_PREPAID |
| 尺码管理 | 尺码 | sizeManagement.size | false | 上新 | 经 SIZE_SEGMENTS 划分普通/特殊 |
| 供应商管理 | 供应商名称 | supplier.name | false | 上新 | 卡片小字显示 |
| 采购主表 | 报货批次号 | purchaseOrderBatch.batchNo | true（既有链路生成） | 提交 | `PurchaseBatchNoGenerator` 生成，页面不填 |
| 采购主表 | 发生行为 | purchaseOrderBatch.behavior | true（既有链路解析） | 提交 | 行为管理 `PURCHASE_ORDER`，既有 `resolveBehavior` |
| 采购明细 | 数量 | purchaseRequest.quantity | true | 提交 | 采购数量 |
| 采购明细 | 幂等键 | purchaseRequest.idempotencyKey | true（既有链路生成） | 提交 | `purchase_request:{taskId}:{productKey}:{size}` |
| 采购明细 | 采购明细ID | purchaseRequest.detailId | false（服务端生成） | 提交 | `{批次号}-{两位序号}`，页面不填 |
| 采购明细 | 供应商 | purchaseRequest.supplier（公式） | false（只读公式） | 提交 | 生产真表是「采购明细」自动公式，由货品信息.供应商带出；**采购主表没有供应商列**，页面/服务端不写 |

> ⚠️ 边界（Lead 2026-10-28 确认）：**页面计算 / UI 状态只进「页面数据」，不要塞进「字段清单」**；
> 本表只记 Base 字段 / 写入 payload 字段。
> ⚠️ 扫一扫本轮暂缓 ⇒ 本表不补扫一扫行。

## 7. handoff #3 / #8 / #9 实际方案草稿（给 Lead 写 handoff 表）

### #3 `procurement.html` 静态演示页整体替换

```text
结论：本轮完全解决（页面已生产化，不再是演示页）。
实际方案：
- procurement.html 整体替换为薄壳（引 procurement.css + features/procurement/index.js，挂载根节点）；
  旧 398 行演示数据/内联色值/内联业务逻辑全部删除，不保留兼容层。
- 三 tab：补货 / 上新 / 扫一扫（扫一扫本轮仅占位/禁用，业务负责人 2026-10-28 决定）；
  切 tab/刷新/关掉重开保留同一张草稿（localStorage，键含 open_id）；
  点「提交」才统一写入；提交前零写库。
- 数据：GET /api/workbench/procurement/replenish | new-products；提交 POST .../submit（扫一扫接口本轮不做）。
- 提交复用既有链路：multiItemOrderService.submitDraft → publishPurchaseRequest（不新建草稿表/写库路径）；
  后台用 purchaseWriteBackgroundService.scheduleCustomRest；HTTP 先回「已提交成功，数据会更新」。
- 遗留（非本轮）：扫一扫整块（扫码选尺码加入同一草稿、重复扫码口径）下一轮单独处理。
```

### #8 独立页 tokens / 禁止内联色值

```text
结论：本轮解决采购页（页面 + CSS 全部只用 styles/tokens.css 的 token）。
实际方案：
- 新文件样式集中在 procurement.css，颜色/圆角/阴影/字号一律 var(--…)，不写 hex/rgb，不写 HTML 内联 style；
- 反向哨兵（测试）：新页面文件里出现 #rrggbb/rgb(/style=" 即红；
- 视觉目标 = docs/prototypes/procurement-board-2026-10-27.html（其内联 :root 色值不复制，映射到 tokens）。
- 遗留（非本轮）：销售新页同样口径，由销售侧页面负责；是否加前端 size/style 门禁由 Lead/业务负责人另定。
```

### #9 配置拆分：新配置独立小文件

```text
结论：本轮部分解决（采购页配置独立；既有大配置不动）。
实际方案：
- 新增 server/src/config/procurementPage.js：端点、文案、3 天窗口/时区、20 货品/50 行上限（复用 multiItemOrder 配置不抄第二份）、
  普通码 1/特殊码 0 默认值、现货/预订行为编码、筛选公式模板、事件名、submitKey 规则；
- 新增 server/public/workbench/config/procurement.js：页面文案、tab 定义、统计标签、图例、端点、默认值、localStorage 前缀；
- 既有大配置（scanWrite / scanPage / v1BitableSchema / multiItemOrder）一个字段不改，只读复用。
- 遗留：orders/index.js 等前端大文件拆分不在本轮（handoff #1 部分推进）。
```

---

## 7.1 真测试 Base 集成验证之后的两处修复（2026-10-28 晚 · PR #904 内）

真测试 Base 集成验证（只读 + 真提交）发现并修复了两个问题（详细证据见工作区报告
`.local/wt-procurement/reports/procurement-testbase-verification-2026-10-28.md`，不入库）：

1. **Bug-1（P0 · 假成功）**：`multiItemOrderService.submitDraft` 给写入件的是**扁平 payload**，
   而既有 `publishPurchaseRequest(taskId, task)` 要的是**本地任务记录**（`task.draft`）⇒
   后台 `Cannot read properties of undefined (reading 'is_batch')`，HTTP 却已回「已提交成功」。
   - 修复：新增 `services/procurementPurchaseWriters.js`（引擎 payload → 本地 task → 既有发布），
     `procurementPageSubmitService` 默认注入；**不碰冻结件 `scanWriteService.js`**、不新开写库路径。
   - 判据：`test/procurementPurchaseWriters.test.js`（假 publisher 硬断言 `task.draft.is_batch`；
     旧形状反向探针必须抛；旧形状接 submit ⇒ 后台失败落 `failed`）。
2. **Bug-2（P1 · 展示/载荷）**：`getBatch`（batch_get）的单元格形状与列表接口不同
   （公式 `{type,value:[{text}]}`、关联 `{link_record_ids}` 无显示文本）⇒ 补货卡片颜色为空、
   payload `product_number = "[object Object]"`。
   - 修复：新增 `services/procurementProductEnricher.js`（batch 形状归一化 + 颜色按关联 ID 读
     `getBatch('color')` 解析显示名），读模型与提交服务共用；`procurementPageData.textOf` 解包 batch 形状。
   - 判据：`test/procurementProductEnricher.test.js` + `procurementPageSubmit.test.js`（payload 出现
     `[object Object]` 或颜色为空即红）。

测试 Base 复验（修复后默认代码，无垫片）：采购主表 +1（`CGD-20261028-0002`）、采购明细 +4（尺码/数量/货品关联
全对，含 1 条**今日新增货品**）、同 submitKey 二次 `reused:true` 且 +0/+0、后台无 `write_failed`；
测试记录保留。为补「上新有数据」路径在**测试 Base** 新建 2 条今日货品（`TB1326081/TB1326082`）。

## 8. 逐条对照（2026-10-28 实际结果）

| AC | 判据（测试文件 / 命令） | 结果 |
| --- | --- | --- |
| AC-P1..P9 | `test/procurementPageData.test.js`（11 条）`test/procurementPageService.test.js`（6 条） | ✅ 全绿（含反向哨兵：读模型不碰实时库存、不写表） |
| AC-P10..P16 | `test/procurementPageSubmit.test.js`（9 条）`test/procurementPageRoutes.test.js`（7 条） | ✅ 全绿（零写入 / 一条既有写入件 / 幂等 / 后台失败如实） |
| AC-P17/P18 | `test/procurementPageFrontend.test.js`（6 条：薄壳/行数/无 hex/rgb/内联 style/配置先行/扫一扫占位/草稿纯函数） | ✅ 全绿 |
| AC-P19..P23 | `test/e2e/procurement.spec.js`：mobile(iPhone13) + tablet(604) 共 12 条 | ✅ 12 passed（**Chromium + static-server，仅作前置回归**；最终验收由 Lead 用真实 Chrome + 真实 Express 跑） |
| AC-P24 | 全量 `node --require ./test/support/table-id-env.js --test --test-concurrency=1 test/*.test.js` | ✅ tests 2251 / pass 2250 / fail 0 |
| AC-P24 | `node scripts/check-file-size.mjs` | ✅ 绿：0 条违规 |
| AC-P24 | `node scripts/observability-events.mjs --check` | ✅ 新鲜（新增 8 个事件后已重新生成） |
| AC-P24 | `git diff --check` | ✅ 干净 |
| AC-P25/P26 | `git status` 审文件边界：只动采购页/采购路由/采购服务/采购测试/采购文档；`routes/workbench.js`、`app.js`、`main.js`、`tabs.js`、`core/**`、`styles/**` **零改动** | ✅ |
| 新文件行数 | 页面/CSS/config/features/**（≤200）：22 / 90 / 96 / 40–190；服务端新文件 69–186；测试 134–181 | ✅ |
