# 架构审计报告（2026-10-15）—— 「保留 / 待删 / 要她定」三类清单

> **性质：只读审计。本文件是本次任务**唯一**新增的东西；仓库里**没有删、没有改**任何一行代码/配置** ✗。
> 报告时间：上海 **2026-10-15 23:1x**（base = `main 5ac93e9`）。
> 依据（都是仓库里已落档的口径）：
> - `docs/workbench-architecture-rationale-2026-10-15.md`（一级 5 Tab + **两条判据**：发生频次高 / 符合真实业务链路）
> - `docs/workbench-tabs-and-subpages-2026-10-15.md`（各 Tab 子页 + ⭐**「占位 / 待开发 / 等她定」清单**）
> - `docs/scan-page-architecture-2026-10-15.md`（扫一扫页内 4 领域 + 三页销售流 + 异步）
> - `docs/scan-write-fields-audit-2026-10-15.md`（写入字段基准）
> - `docs/parallel-development-protocol-2026-10-15.md` **§6/§7**（判死代码的红线）

---

## 0. 方法（每条结论都能复核）

**引用图怎么算的**（只读脚本，跑在 worktree 根）：

1. **静态引用**：遍历全仓 `.js/.cjs/.mjs`，抽 `require('字面量')` / `import … from '字面量'` / `import('字面量')`，
   按**相对路径真实解析**成文件（含 `.js/.cjs/.mjs/.json/index.*`）⇒ 得到 1939 条边。
2. **前端资源**：HTML 的 `src=`/`href=`（**含 `/workbench/...` 绝对路径**）+ JS/CSS 里的**引号路径字符串**
   （`'/workbench/…'`、`'./x.js'`）⇒ 合并进同一条边表。
3. **可达性**：从**三个 HTML 入口**（`index.html` / `inventory-adjustment.html` / `label-print.html`）沿边做 BFS。
4. **文本提及**（只用来交叉验证，不用来定案）：全仓 781 个文本文件里搜**文件 basename / 去扩展名**，
   按来源分组（`server/src` / `server/test` / `server/scripts` / `server/public` / `docs` / `tools` / CI）。
5. **环境变量**：抽 `.env.example` 的 167 个键；对每个键在 `server/src` / `server/scripts` / `tools` / `print-helper`
   找**读取点**（`process.env.X`、`readString(env,'X',…)`、`getEnv('X',…)`）；
   ⚠️ 再单独找**按前缀动态拼**的读法（`PREFIX + 'SUFFIX'`、`process.env[变量]`）——**这一层不查就会误杀**。
6. **npm 脚本**：逐个解析 `server/package.json` 的 scripts，检查目标文件**真的存在**。

**🔴 红线遵守声明**：
- 协议 §6 的「已没人用但故意保留」清单（`purchaseArrivalIntake.js` / `purchaseSizeReader.js` / `writeTargetGuard.js`）
  **一条都没进"待删"** ✓；代码注释里点名"故意留着"的（`features/common` + `config/home.js`、`finance/douyin/platform`、
  `paymentMethodsService`、`v1WorkbenchService.getSalesReport/getTodaySales`…）同样**只进"保留"** ✓。
- 她点名的**占位 / 待开发 / 等她定**项（采购订单列表 · 供应商往来款 · 供应商名录 · 库存手工调整 · 销售订单列表 ·
  客户往来款）**一条都没进"待删"** ✓（见 §6）。
- **没有**用「`grep` 0 命中」单独定案：`.env.example` 的 43 个"字面量 0 读取点"里，**31 个**被查出是
  按前缀动态读的（**活的**：`SALES_MISSING_INFO_*` 28 + `PURCHASE_GROUP_NOTICE_*` 3），
  只有 **12 个**是真孤儿（`SALES_PROCESSING_CARD_*` 5 + `FEISHU_SYNC/RETRY_*` 4 + 3 个表 id）（见 §3.2 / §7）。
  ⚠️ 反向（"代码在读、模板里没有"）**只能算近似** —— 仓里有**经常量间接读**的写法（例
  `config/privateChatNotice.js` 用 `NOTICE_ENABLED_KEY` 常量）⇒ 字面量扫法会漏（§7.3 已注明）。
- **测试 / 脚本 / 文档里的引用都算"被使用"**（协议 §7）⇒ 只被测试或手动脚本引用的，一律**不判死**。

---

## 1. 架构基线（「架构上应该存在什么」）

### 1.1 一级 5 个 Tab + 两条判据
```
① 扫一扫   ② 销售   ③ 库存   ④ 采购   ⑤ 货品
```
- **判据一「发生频次高」**：高频（销售 / 补货 / 库存查询 / 退货）进**扫一扫**；低频（库存手工调整 · 换季调整）进**独立页**。
- **判据二「符合真实业务链路」**：标签打印的唯一途径**不是**扫一扫、且它在链路里属于**货品上新之后** ⇒ 归**货品**模块。
- 「资金」页将来放哪 —— **未定** ⇒ 不在本次审计范围内（她的口径也没定）。

### 1.2 扫一扫页内 4 个领域（一级 tab 的「扫一扫」是**另一个层级**，别混）
```
销售 · 补货 · 库存 · 退货      （＋「继续扫下一个」）
```
- 库存页三维度（样品 · 门盒 · 仓库库存）；男鞋 38–48 / 女鞋 34–43；普通码全展示、特殊码有货才展示。
- 销售页：一单多商品 · 一单多收款方式 · **三页流**（货品页 → 资金页 → 提交成功页）。
- 补货 / 退货：本质同一套逻辑；退货按**实时库存实际存在的尺码与数量**；补货支持**一键补普通码**（数量默认 1 可改）。
- **异步**：补货 / 销售 / 退货**都**要异步（前端先提示"单号已创建"，后端异步写表）。
- 🔴 她今晚点名的**大改**：一次补货单 / 退货单也要**支持多个货品**（尚未做）。

### 1.3 录入的两条路
- **扫码录入**：扫一扫页（`/s/{编号}`、`/r/{记录ID}`）。
- **表单录入**：外置**飞书多维表格表单** ⇒ 我们只**接记录变更事件**（货品上新 → 出二维码；配品销售 → 成单）。
  ⚠️ 「扫一扫**不是**录入的唯一路径」（她原话）—— 面板上也可手改数量/尺码。

### 1.4 分析 · 处理 · 查询 · 分发
| 环节 | 架构上的形态 |
| --- | --- |
| 分析 | 查询类**外链**飞书多维表格 AI 页面（不自建接口）；订单列表这类"要处理"的才自建 |
| 处理 | 验收（扫码验收 + 采购页「验收」子 tab）· 售后（退换货）· 订单列表的单条操作（交付/收款/售后/二次交付）· 库存手工调整（**待开发**） |
| 查询 | 工作台订单列表（自建）· 销售查询 / 全仓查询 / 客户往来款 / 供应商往来款 / 供应商名录（**外链**） |
| 分发 | 每天 9 点待处理单推送（群）· 采购群提醒 · 销售卡片 · 事件心跳自检 |

### 1.5 打印的三种方式（由链路推出）
| 场景 | 怎么打 |
| --- | --- |
| 新品（还没有库存） | **按编号打印** |
| 库存/信息有更新 | **扫码打印** |
| 新上架一批 | **批量打印** |

---

## 2. 逐层对照：架构 ↔ 现有实现

### 2.1 服务端入口与事件（全在 `server/src/app.js`）
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 飞书事件回调 | `routes/larkEvents.js`（`createLarkEventsRouter`，挂 `/api/lark/events`） | ✅ 齐 |
| ├ 群聊/话题消息 | handler `im.message.receive_v1`（`:33`）→ `services/larkMvpService.js` | ✅ 齐 |
| ├ 卡片动作 | handler `card.action.trigger`（`:59`） | ✅ 齐 |
| └ 多维表格记录变更 | handler `drive.file.bitable_record_changed_v1`（`:100`）：**两条支路** = 货品信息→标签二维码（`tagQrCodes`）+ 配品销售→成单（`accessorySaleIntakeService`） | ✅ 齐 |
| 工作台身份认证 | `routes/feishuWebAuth.js`（`/api/auth/feishu/*`） | ✅ 齐 |
| 工作台接口 | `routes/workbench.js` + 子路由 `purchaseQuery.js` / `workbenchInventoryAdjustment.js` / `workbenchOrderActions.js` | ✅ 齐（4 个子路由**都被 workbench.js require**，没有"没挂载的路由文件"） |
| 扫码页 | `routes/scanPage.js`（`SCAN_PAGE.route.basePath` + `recordBasePath` 两处挂载） | ✅ 齐 |
| 打印：手机侧 / 电脑侧 | `routes/labelPrintQueue.js`（`/api/workbench/label-print`）· `routes/labelPrintDevice.js`（`/api/label-print`） | ✅ 齐 |
| API 鉴权 | `src/middleware/auth.js`（`/api` 兜底 `x-api-key`） | ✅ 齐 |
| 静态页 | `app.use('/workbench', express.static(...))` | ✅ 齐 |

### 2.2 扫一扫（页内 4 领域）
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 页内领域定义 | `views/scanPageRealm.js`（`REALMS`：`sales/replenish/inventory/purchase_return`，`accept` 已退场 `:87`） | ✅（**顺序仍是 销售·补货·库存·退货**，她要改成 **库存·销售·补货·退货** ⇒ **待做**） |
| 服务端渲染 | `views/scanPageRenderer.js`（纯函数） | ✅ 齐 |
| 取数与聚合 | `services/scanPageService.js` + `scanPageCache.js` + `services/liveInventorySnapshot.js` + `liveInventoryIndex.js` + `services/bitableFilterFormula.js` | ✅ 齐 |
| 会话草稿 | `services/scanSessionService.js`（独立目录/状态/幂等键） | ✅ 齐 |
| 三个写入口 | `services/scanWriteService.js`：销售建单 / 补货报单 / 采购退货（`submitReplenish` / `submitPurchaseReturn`） | ✅ 齐（**一单多货品**尚未做；**补货/退货异步**尚未做） |
| 销售异步闸门 | `services/saleWriteBackgroundService.js` + `config/scanWrite.js` 的 `SCAN_SALE_ASYNC_WRITE_ENABLED`（默认 `true`） | ✅ 齐（只销售有） |
| 交付 / 收款 | `services/salesDeliveryService.js` · `paymentService.js` · `salesRecordIds.js` · `salesRecordReader.js` · `salesReadRetry.js` | ✅ 齐 |
| 扫码验收 | `services/scanArrivalService.js` | ✅ 齐 |
| 扫码退货落库 | `services/purchaseReturnService.js` | ✅ 齐 |
| 登录跳转 | `config/scanAuthRedirect.js` + `services/larkJsapiService.js` + `config/larkJsapi.js` | ✅ 齐 |
| 点击埋点 | `config/uiTap.js` + `utils/uiTapReport.js` + `public/workbench/shared/ui-tap.js` | ✅ 齐 |

### 2.3 工作台（一级 5 Tab 前端）
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 一级 tab 定义 | `public/workbench/config/tabs.js` 的 `MAIN_TABS` = **扫一扫 · 销售 · 库存 · 采购 · 货品**（`:24-28`） | ✅ 与她的 5 Tab **逐字一致** |
| tab 渲染 | `core/tabs.js` + `main.js` 的 `modules` 表（`scan/sales/inventory/purchase/product`） | ✅ 齐 |
| 子页清单（配置先行） | `config/domains.js`：销售=订单列表/销售查询/客户往来款/配品 · 库存=全仓查询/手工调整 · 采购=验收/订单列表/供应商往来款/供应商名录 · 货品=货品上新/标签打印 · 扫一扫=scan-home | ✅ 与她的子页清单对齐（见 §6） |
| 领域骨架 | `features/domains/{index,nav,pages}.js` | ✅ 齐 |
| 订单列表 | `features/orders/`（`mode: 'purchase'` 供采购「验收」复用） | ✅ 齐 |
| 查询外链卡 | `features/query/index.js` + `config/query.js` + `config/links.js`（`directJump`） | ✅ 齐 |
| 占位页 | `features/shared/placeholder.js`（`finance/douyin/platform` 三个**故意隐去入口**的模块也在用它） | ✅ 齐 |
| 独立页（低频，判据一） | `inventory-adjustment.html` + `features/inventory/adjustment.js`；`label-print.html` + `features/labels/*` | ✅ 齐 |
| 扫码入口那一格 | `main.js` 的 `SCAN_APPLINK` / `/api/workbench/scan-entry`（PC 不支持 ⇒ 把那一格藏起来） | ✅ 齐 |

### 2.4 工作台（后端）
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 订单列表 / 交付 / 收款 | `routes/workbench.js` + `services/workbenchOrderActionService.js` + `workbenchOrderSections.js` + `workbenchOrdersCache.js` + `config/workbenchOrders.js` + `config/orderReadRetry.js` | ✅ 齐 |
| 人工库存调整（**待开发** = 方案未定） | `routes/workbenchInventoryAdjustment.js` + `services/inventoryAdjustmentService.js` + `config/inventoryAdjustment.js`（**现有实现**） | ⚠️ 她口径是"待开发/方案未定" ⇒ 现状与口径有差（**不是死代码**，见 §6） |
| 采购查询 | `routes/purchaseQuery.js` + `services/purchaseQueryService.js` + `services/workbenchPurchaseArrivalService.js` + `config/workbenchArrival.js` | ✅ 齐 |
| 老的销售/库存查询（已删接口） | `services/v1WorkbenchService.js` 的 `getSalesReport`/`getTodaySales` **刻意保留、无生产调用方**（`controllers/workbenchController.js:29` 注释点名） | ✅ 保留（协议 §6 同源） |

### 2.5 采购
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 报货 / 退货（扫码） | `services/scanWriteService.submitReplenish` → `purchaseWebhookService.publishPurchaseRequest`；`submitPurchaseReturn` → `purchaseReturnService` | ✅ 齐 |
| 批次号（**唯一身份**） | `services/purchaseBatchNo.js` + `purchaseBatchNoGenerator.js` + `config/purchaseBatchNo.js` | ✅ 齐 |
| 报货批次行 | `services/purchaseOrderBatchService.js` + `config/purchaseArrivalStatus.js` + `purchaseBatchQuantity.js` + `services/reportedAt.js` | ✅ 齐 |
| 验收（两条路，**共用一处**） | 扫码验收 `services/scanArrivalService.js`；工作台采购「验收」子 tab = `features/orders`（`mode:'purchase'`）→ `POST /purchase/arrivals/confirm` → `purchaseWebhookService.confirmArrival` | ✅ 齐 |
| 对话式到货核对 | `services/purchaseArrivalConversationService.js` + `config/arrivalConversation.js` + `services/doubaoService.js`（解析层） | ✅ 齐 |
| 采购单出图 | `services/purchaseRequestImageService.js` + `config/purchaseRequestImageLayout.js` | ✅ 齐 |
| 到货成本 / 建档 | `services/arrivalCostPolicy.js`（被 `purchaseWebhookService` require） | ✅ 齐 |
| 采购群话术 | `config/purchaseGroupNoticeText.js` + `utils/larkCards.js` | ✅ 齐 |

### 2.6 货品
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 货品上新（外置表单）⇒ 事件 ⇒ 出二维码 | `routes/larkEvents.js` 的货品支路 → `services/tagQrCodeService.js` + `config/tagQrCode.js` + `utils/tagQrSweepScheduler.js`（兜底巡检） | ✅ 齐 |
| 标签打印（三种方式） | 手机侧 `routes/labelPrintQueue.js` + `services/labelPrintQueueService.js` + `labelPrintQueueRuntime.js` + `labelPrintArtifactService.js` + `infrastructure/labelPrintJobStore.js` + `config/labelPrintQueue.js`；电脑侧 `routes/labelPrintDevice.js` + `print-helper/**` | ✅ 齐 |
| 单个/批量/编号打印 | `features/labels/{index,render,scan-print,queue,number-picker}.js` + `config/numberPicker.js` + 只读端点 `GET /api/workbench/products/numbers`（`routes/workbench.js:377`） | ✅ 齐 |

### 2.7 分发 / 定时 / 心跳
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 每天 9 点待处理单推送 | `services/pendingDealPushService.js` + `pendingPushCandidateService.js` + `voucherSettlementService.js` + `services/samplePendingNoticeService.js` + `utils/pendingDealPushCard.js` + `utils/shanghaiDailyScheduler.js` + `config/pendingDealPush.js` / `pendingPushCandidates.js` / `pushRetry.js` / `voucherSettlement.js` | ✅ 齐 |
| 二次交付提醒（9 点） | `utils/secondDeliveryReminder.js`（`app.js:32` 启动）+ `services/secondDeliveryService.js` | ✅ 齐（`shanghaiDailyScheduler` 是它的通用后继件，两份**都活着**） |
| 群消息置顶 | `services/larkMessagePinService.js` | ✅ 齐 |
| 事件心跳自检 | `infrastructure/larkEventHeartbeat.js` + `config/larkEventHeartbeat.js` + `scripts/check-lark-events.mjs` | ✅ 齐 |

### 2.8 基础设施 / 运维
| 架构项 | 现有实现 | 状态 |
| --- | --- | --- |
| 任务存储 / 串行队列 / 幂等 | `infrastructure/{jsonTaskStore,keyedSerialQueue,idempotencyKey,interactiveCardFeedback}.js` | ✅ 齐 |
| 网关与写库 | `services/v1BitableGateway.js` + `v1ReferenceResolver.js` + `v1PostingService.js`(facade) + `config/v1BitableSchema.js` + `config/v1SchemaScopes.js` | ✅ 齐 |
| 关系/引用 | `services/salesOrderService.js` · `salesStatusWriter.js` · `salesProgressService.js` · `accessoryMatchPolicy.js` · `sizeReferenceService.js` | ✅ 齐 |
| LLM | `services/doubaoService.js`（名字是历史名，**用的是一组文字模型** `config/llmModels.js`） | ✅ 齐（**命名债**，不是死代码） |
| 部署 | `scripts/deploy_build.sh` / `deploy_run.sh` + `server/ecosystem.config.js` + `server/ops/nginx/**` | ✅ 齐 |
| 运维/开发者工具 | `server/scripts/**`（23）· `tools/**`（5）· `server/e2e/**` · `server/test-support/**` | 见 §3.3 |

### 2.9 观察：**架构 ↔ 代码 对齐度很高**
- 173 个 `server/src/**` 文件里，**只有 8 个**没有任何 `src` 内引用者；其中 **3 个**是协议 §6 点名的"故意保留"，
  1 个是入口 `app.js`，其余 4 个都有**测试或手动脚本**在用（协议 §7 ⇒ **不是死代码**）。
- 前端 41 个文件里，从三个 HTML 入口**可达 38**；不可达 3 = 1 个 README + 2 个**代码注释已点名"先留着没删"**的。
- 9 个 `routes/*.js` **全部**被挂载（4 个是 `workbench.js` 的子路由）。

---

## 3. 三类清单

### 3.1 ✅ 保留

**A. 架构主干** —— 即 §2 里所有标 ✅/⚠️ 的实现文件（含扫一扫 4 领域、工作台 5 Tab、采购验收、货品二维码与打印、
分发/定时/心跳、基础设施、运维）。**总计 200+ 文件，不逐个列出**；判据 = §2 的逐层对照。

**B. 🔴「已没人用 / 无读取点，但**故意保留**」—— 一律不许当死代码删**（协议 §6 + 代码注释点名）

| 文件 / 项 | 证据（谁点名"故意留着"） | 活引用检查 |
| --- | --- | --- |
| `server/src/config/purchaseArrivalIntake.js` | 协议 §6 第 1 条；`AGENTS.md`「模块**刻意保留**、已无读取点」；文件头注释 | 仅 `test/` 1 处（**测试在钉它**） |
| `server/src/services/purchaseSizeReader.js` | 协议 §6 第 2 条；文件头「⚠️ 当前无生产引用（2026-10-14）…」 | 仅 `test/`（多条） |
| `server/src/utils/writeTargetGuard.js` | 协议 §6 第 3 条（写库脚本的防误写闸门） | `scripts/` 2 处 + `test/` 2 处 |
| `public/workbench/features/common/index.js` + `config/home.js` | `public/workbench/main.js:48-49`「**当前没有任何页面挂载**…只是先留着没删」（配套的 `common.css` **仍在用**：`index.html:12`） | 前端**不可达**（BFS 证实） |
| `finance` / `douyin` / `platform` 三个占位模块 | `main.js:50`「⚠️ HIDDEN（入口隐去、**代码保留**）」 | `main.js` 的 `modules` 表**仍在注册** |
| `services/paymentMethodsService.js` | `routes/workbench.js:568`「⚠️ **保留**（它有自己的用例）—— 这一刀只删工作台自建那套，**不删业务模块** ✗」 | 仅 `test/paymentMethodsService.test.js` |
| `v1WorkbenchService.getSalesReport` / `getTodaySales` | `controllers/workbenchController.js:29`「**保留**…但**已没有任何生产调用方**」 | `test/` 在用 |
| `features/orders` 的 `mode: 'purchase'` | `config/domains.js:26` 附近「这个 `kind` 与既有模块**保留**（加回入口只需配置）」 | **现在就用着**（采购「验收」子页 = `kind:'orders'` `mode:'purchase'`，`:193-198`） |
| 前端 `kind`/`directJump`/`placeholder` 三类机制 | `config/domains.js` 头注释 | 都在用 |
| `server/scripts/*` 手动脚本（`list-v1-fields` / `backfill-*` / `render-purchase-image-prototype` / `test_inventory_e2e` / `audit-purchase-behavior` …） | 协议 §7「`docs/**`/`package.json`/`*.sh` 提到的手工脚本 = 活的」 | 见 §3.3 |

**C. 历史留档与工程工具（不是业务代码，按"留档"处理）**
`docs/**`（162 篇，含 `docs/archive/`、`docs/reports/`、`docs/prototypes/`、`docs/branch-salvage-2026-10-06/`）·
`CHANGELOG.md` · `README.md` · `AGENTS.md` · `tools/**`（5 个测试稳定性探针）· `server/test-support/**` ·
`server/e2e/**` · `server/ops/nginx/**`（部署配置，`ops/nginx/README.md` 逐条说明用法）。

### 3.2 🚩 待删（**与架构无关 + 无活引用 + 能说清是哪一轮的残留**）

> 共 **3 组**。每组给：证据 · 活引用检查 · 归属轮次 · **判据迁移**（§4）。

#### 待删-1. `server/package.json:17` 的 `"sales:sample"` 脚本 —— **目标文件不存在**（坏引用）
- **证据**：`"sales:sample": "node scripts/write_sales_sample.js"`；`ls server/scripts/write_sales_sample.js`
  → **不存在**。逐个解析 `package.json` 里 **11 条**指向 `.js/.mjs` 的脚本，**只有这一条**指向不存在的文件。
- **活引用检查**：`scripts/write_sales_sample.js` 全仓 **0 提及**；`sales:sample` 除了这一行本身**无人调用**
  （CI 只跑 `pnpm test`；部署脚本不碰它；docs 无引用）。
- **归属轮次**：小程序/早期样例数据阶段（`docs/reports/doc-code-drift-2026-10-07.md:151` 已记「脚本不存在」，**至今未修**）。
- **判据迁移**：无业务判据（它只是一个**指向空气的入口**）⇒ 直接删那一行即可，不影响任何能力。

#### 待删-2. `.env.example` 里 **12 个零读取点**的键（三族）
- **A 族（7 个，2026-10-07 报告已记、仍未修）**：`FEISHU_SYNC_CONCURRENCY`(`:22`) · `FEISHU_RETRY_MAX`(`:23`) ·
  `FEISHU_RETRY_BASE_MS`(`:24`) · `FEISHU_RETRY_MAX_DELAY_MS`(`:25`) · `FEISHU_V1_PURCHASE_BATCH_TABLE_ID`(`:93`) ·
  `FEISHU_V1_MONEY_LEDGER_TABLE_ID`(`:703`) · `FEISHU_V1_SUPPLIER_PAYABLE_TABLE_ID`(`:704`)。
  出处：`docs/reports/doc-code-drift-2026-10-07.md:148`（「`.env.example` 7 个孤儿变量 … **仍未修**」）。
  ⚠️ `:93` 那个值 `tblvLOXKESNTbZ7v` 就是**已被她整表删除**的「到货验收」表 id（`docs` 里到处可见它的退役记录）。
- **B 族（5 个，**本次新发现**）**：`SALES_PROCESSING_CARD_TITLE`(`:461`) / `_TEMPLATE`(`:463`) /
  `_ITEM_COLOR`(`:465`) / `_PROGRESS_LINE`(`:467`) / `_NOTE`(`:469`)。
  出处：**#587**（`3cb6d8d`，2026-10-15「清理死代码 —— 删『处理中卡』(salesProcessingCard + 其配置…)，
  判据**迁到仍在用的卡**」）删了代码与 `config/salesProcessingCard.js`，**但 `.env.example` 里这 5 个键没跟着清**。
- **活引用检查**：对 12 个键在 `server/src` / `server/scripts` / `tools` / `print-helper` 逐个找读取点 ⇒ **全 0**。
  ⚠️ **重点排除误杀**：本仓有 **3 组前缀动态读法**（`SALES_MISSING_INFO_`、`PURCHASE_GROUP_NOTICE_`、`TEXT_LLM`）
  和若干 `process.env[变量]`；**这 12 个键不属于任何前缀族** ⇒ 不是"grep 不到"的冤案（详见 §7）。
- **归属轮次**：A 族 = `/api/sync`（小程序时代）+「采购批次」表（2026-10-04 删）+ 两张**从未进过 schema** 的资金表；
  B 族 = #587（2026-10-15）。
- **判据迁移**：见 §4。

#### 待删-3. `server/src/services/v1ReferenceResolver.js:249` 的 `findLiveInventory()` —— **方法级**零调用方
- **证据**：全仓搜 `findLiveInventory`：
  - `InventoryService.findLiveInventory`（`services/inventoryService.js:1531`）**才是活的**（4 处 src 调用点：
    `inventoryService.js:1148` · `samplePendingService.js:96` · `inventoryAdjustmentService.js:125` …）；
  - `V1ReferenceResolver` 上的同名方法 **没有任何调用方**（`references.findLiveInventory` / `resolver.findLiveInventory`
    全仓 0 命中；`test/` 里那处是同名的**假件**，不是调它）。
- **活引用检查**：连测试都没有直接调它（`grep -rn findLiveInventory server/test` 只剩 `purchaseWebhookService.test.js:144`
  的一个**替身定义**）。
- **归属轮次**：`liveInventory` 内存快照 / 索引改造之前（`services/liveInventorySnapshot.js`、`liveInventoryIndex.js`
  一上线，"按编号+尺码去 liveInventory 里找"就统一由 `InventoryService` 承载）。
  `docs/reports/doc-code-drift-2026-10-07.md:104` 已记「`findLiveInventory` 死代码仍按数字读尺码（无调用方）」。
- **判据迁移**：**"货品 + 尺码 ⇒ 实时库存那一行"**这个能力**现在由 `InventoryService.findLiveInventory`
  （`inventoryService.js:1531` → `findLiveInventoryIn`）承载** ✓ —— 删掉的只是**第二份、且按数字读尺码**的旧实现。

> **为什么"待删"只有 3 组**：按协议 §7（测试/脚本/文档算被使用）与 §6（故意保留清单），
> 其余所有"看起来没人用"的都**够不上"待删"**（它们要么有测试钉着，要么是刻意保留）。
> 这本身是个**好消息**：多轮迭代后仓库里**真死代码很少**。

### 3.3 ⚠️ 要她定（判不准的 —— 尤其"看起来没人用、但可能故意保留"）

| # | 项 | 事实（证据） | 为什么我不拍 |
| --- | --- | --- | --- |
| 1 | **`Dockerfile` + `.dockerignore`** | 部署**实际走** PM2 + Nginx（`scripts/deploy_run.sh` 读 `ecosystem.config.js`、`ops/nginx/**`）；`Dockerfile` 只被 `README.md:56`/`AGENTS.md:129` 的**目录树注释**提到，**CI/脚本都不用它**。⚠️ `.dockerignore` 里还有两条**指向不存在路径**的忽略项（`.trae`、`server/test_feishu.js` ⇒ 两个都不在仓库里） | 「怎么部署」是她的地盘；而且万一她哪天要容器化，删了就白删 |
| 2 | **`config/modules.js` + `config/modules.shared.js` + 根 `config/module-manifest.json` + `scripts/generate_modules.js` + `npm run generate:modules`（＋`test/modules.test.js`、`test/moduleGeneration.test.js`）** | 整条链**生产零消费者**：`MODULES` / `getModuleDefinition` / `normalizeModule` 在 `server/src` 里**没有任何 require 点**（唯一 require 者 = `test/modules.test.js`）；`generate_modules.js` 的唯一产物 `modules.shared.js` 也只被 `modules.js` 用。它服务的是 **`/api/sync` 时代**的"模块化录入字段映射"（`docs/handoff.md:300` 已记：「`/api/sync` 时代遗留、已无读取方的 … 以及 `MODULES[*].sync` 段，仍留在仓库里」） | **协议 §7 说"测试里的引用 = 被使用"** ⇒ 按判据它不是死代码；要删必须**连 2 个测试 + 生成器 + manifest 一起删**，这是"要不要留一套历史录入映射"的产品决定 |
| 3 | **`supabase/migrations/**`（3 个 SQL）** | `init_tables.sql` / `add_feishu_token.sql` / `add_anomaly_fields.sql`：全仓**零代码/CI/Dockerfile 引用**；`README.md:53`/`AGENTS.md:126` 把它标成「**历史**数据库迁移脚本」；`docs/handoff.md:295` 提到它是退役小程序的遗留 | 它确实是历史留档，但"留档要不要留"她说了算（删了 git 历史里也还在） |
| 4 | **根目录 `手机里跟-AI-助手聊天-需求说明-2026-10-08.md`** | 文里**自己写着**：「⚠️ 这是**个人工具接入**需求，**与 feishu-retail-ops 业务项目无关** —— 不要改动那个仓库的业务代码与生产数据」 | 它是"误放进业务仓"的**个人需求文档** ⇒ 建议挪走/删除，但**不许我替她处理文档归属** |
| 5 | **`server/scripts/audit-purchase-behavior.mjs`** | **只读**审计脚本（"报货批次.采购行为"有没有写成库存行为，源于 2026-10-12 真机 bug）；全仓**零提及**（package.json 里也没有它的 script） | 一次性工具，但**她/我们可能还想复跑**（它输出的就是"历史上哪几行要改"的清单） |
| 6 | **`tools/**`（5 个探针）** | `flaky-suite-loop.mjs` / `repro-missing-tests.mjs` / `probe-clock-dependence.mjs` / `probe-git-state-invariance.mjs` / `sentinel-loop.sh`：测试稳定性排查工具；`sentinel-loop.sh` 全仓零提及（其余各有 1 篇 docs 提到） | 属"开发者工具"、不属业务架构；留着不碍事，删了下次排查要重写 |
| 7 | **`server/scripts/ws-*.mjs/cjs`（4 个）** | 飞书事件订阅/调试工具（`ws-listen` / `ws-selftest` / `ws-poke-event` / `ws-subscribe`）；`docs/**` 有 4-5 处引用。⚠️ `ws-poke-event.cjs` / `ws-subscribe.cjs` / `e2e-run.mjs` 里**硬编码生产 token 当闸门**（`AGENTS.md` 已记为**待改**：改成从 `.env` 读或指纹比对，**不是删闸门**） | 工具本身是活的（排查事件用）；但那条**已知违规**要不要现在修，得她/Lead 排期 |

> 🔁 **后续状态（2026-10-15 晚 · 复核后更正；上面的**原结论保留以留痕**）**
> 上表第 7 项里「**硬编码生产 token**」这半句**经复核为误** ✗ —— 它是**照抄 `AGENTS.md` 第 7 条的措辞、
> 没有先核脚本**（写这份审计时的疏漏，如实记在这里）。
> **实测事实（只读 grep + 真跑闸门）**：
> · **零明文 token**：`cli_…` / `ou_…` / `oc_…` / `app_token: '…'` / 32+ 位引号串 ⇒ 三个脚本**全 0**；
> · **闸门本来就"从 env 读"**：`FEISHU_V1_FORBIDDEN_APP_TOKENS`（或单数 `FEISHU_V1_PROD_APP_TOKEN`）
>   —— 取值那一行：`e2e-run.mjs:111` · `ws-poke-event.cjs:49` · `ws-subscribe.cjs:53`；
> · `e2e-run.mjs` 的闸门还是**保守**的（取不到 `FEISHU_V1_E2E_TEST_APP_TOKEN` ⇒ **拒绝运行**）。
> ⇒ **第 7 项"工具是活的、不用删"这个判断不变** ✓，但**"已知违规"这个理由不成立**；
> `AGENTS.md` 第 7 条那句**已同步成事实**（脚本从 env 读 ＋ 本机刻意不配 ⇒ 该闸门在本机**空转**，
> `ws-*` 运行期会如实 warn 说这件事）；判据已钉进 `server/test/scriptProductionGate.test.js`
> （零明文 ＋ 键名逐字从 env 读 ＋ 命中清单**拒绝执行** ＋ 没配清单**如实 warn**）。

---

## 4. 判据迁移表（删之前先确认"这条判据现在由谁承载"）

| 待删项 | 它当年承载的判据 | 现在由谁承载 | 删了会不会丢判据 |
| --- | --- | --- | --- |
| `package.json:17` `sales:sample` | （无业务判据；只是一个样例数据入口） | —— | ❌ 不会 |
| `.env.example` A 族 7 键 | ① `/api/sync` 的并发/重试旋钮 ② 「采购批次」表 id ③ 两张资金表的 id | ① 已随小程序退役（`/api/sync` 路由早已删除）② 批次身份改由 `config/purchaseBatchNo.js` + `services/purchaseOrderBatchService.js` 承载 ③ 这两张表**从未进 `v1BitableSchema`**（`docs/reports/doc-code-drift-2026-10-07.md:112` 已核） | ❌ 不会 |
| `.env.example` B 族 5 键 | 「销售订单处理中」那张卡片的文案/模板/颜色 | #587 已把判据**迁到仍在用的卡**（`utils/larkCards.js` + `test-support/cardVisibleGolden.json`） | ❌ 不会（#587 已完成迁移） |
| `V1ReferenceResolver.findLiveInventory` | 「按 货品 + 尺码 找实时库存那一行」（**旧实现按数字读尺码**） | `InventoryService.findLiveInventory`（`inventoryService.js:1531`）→ `findLiveInventoryIn`（`:1521`），并已被 `samplePendingService` / `inventoryAdjustmentService` / `inventoryService` 自身调用 | ❌ 不会（是**第二份**实现） |

---

## 5. `public/workbench/**` 的活引用清单（**删任何前端资源前必须先摘**）

### 5.1 三个 HTML 入口的**直接**活引用

| HTML | 活引用（逐条） |
| --- | --- |
| `index.html`（主工作台） | `<link>` → `features/common/common.css` · `features/domains/domains.css` · `features/orders/orders.css` · `styles/base.css` · `styles/tokens.css`；`<script src>` → `main.js` · `shared/ui-tap.js` |
| `inventory-adjustment.html`（独立页 ①） | `<link>` → `features/inventory/inventory.css` · `styles/base.css` · `styles/tokens.css` · `/workbench/`；`<script src>` → `shared/ui-tap.js` · `standalone.js`；页内跳 `label-print.html` |
| `label-print.html`（独立页 ②） | `<link>` → `features/labels/labels.css` · `styles/base.css` · `styles/tokens.css` · `/workbench/`；`<script src>` → `shared/ui-tap.js` · `standalone.js`；页内跳 `inventory-adjustment.html` |

### 5.2 可达性结论
- **可达 38 / 41**（从三个入口沿 `import`/`<script>`/`<link>`/字符串路径 BFS）。
- **不可达 3**：
  | 文件 | 结论 |
  | --- | --- |
  | `public/workbench/README.md` | 文档（不是资源） |
  | `public/workbench/config/home.js` | **故意保留**（`main.js:48-49`「当前没有任何页面挂载…只是先留着没删」） |
  | `public/workbench/features/common/index.js` | **故意保留**（同上；它的 `common.css` **仍在用**，见 §5.1） |
- ⚠️ **注意**：`features/*` 走的是 **ES `import`**（没有动态 import、没有按字符串加载模块），
  所以"可达"= "真被加载"；**不存在"可达但其实没人实例化"的模块**（我核过 `features/domains/index.js`
  的 5 个领域都由 `config/domains.js` 的 `pages` 驱动，`features/{orders,query,scan,inventory,labels}` 各有入口）。

---

## 6. 架构已定但**代码未做** —— **不是死代码** ✗（她点名的占位/待办）

| 位置 | 她的口径 | 代码现状（本次核实） | 结论 |
| --- | --- | --- | --- |
| 采购 · 订单列表（`purchase-orders`） | **占位**（等多维表格 AI 页面 ⇒ 挂链接） | `config/domains.js:210-216` `kind:'placeholder'` ✓ 与口径一致 | ✅ 保留（**不许删**） |
| 采购 · 供应商往来款（`purchase-supplier-money`） | **占位** | `:217-221` `kind:'placeholder'` ✓ | ✅ 保留 |
| 采购 · 供应商名录（`purchase-suppliers`） | **后续外链**（她给链接） | `:226-239` `kind:'links'` + `directJump` → `config/links.js` 的 `SUPPLIER_DIRECTORY_URL` ⇒ **已实现** | ✅ 保留 |
| 库存 · 全仓查询（`inventory-all`） | **已外链** | `:153-159` `kind:'query'` ✓ | ✅ 保留 |
| 库存 · 手工调整（`inventory-adjust`） | **待开发**（方案未定 ⇒ issue #595） | `:161-170` `kind:'inventory-adjustment'` ⇒ **已有内嵌实现**（`features/inventory/adjustment.js` + 后端 `inventoryAdjustmentService`） | ⚠️ **口径 vs 现状有差**：她有"方案未定"的口径、代码里已有一套 ⇒ **要她定**（是不是就是她要的那套），**绝不当死代码** |
| 销售 · 订单列表（`sales-orders`） | **等她定改法** ⇒ issue #602 | `:91-97` `kind:'orders'`（自建） | ✅ 保留 |
| 销售 · 客户往来款（`sales-customer-money`） | **后续外链** | `:109-114` `kind:'placeholder'` ✓ | ✅ 保留 |
| 销售 · 配品（`sales-accessory`） | 入口改**跳飞书表单**（task-20） | `:124-126` `kind:'links'`（已改成跳表单 ✓ 见 #618） | ✅ 保留（**已完成**） |
| 货品 · 货品上新（`product-new`） | **已是外置表单 ⇒ 事件 ⇒ 实时生成二维码** | `:249-251` `kind:'links'` + `directJump`；事件支路在 `routes/larkEvents.js` → `tagQrCodeService` ✓ | ✅ 保留 |
| 扫一扫页领域顺序 | **改成 库存 · 销售 · 补货 · 退货 · 扫一扫** | `views/scanPageRealm.js:72-76` 仍是 **销售 · 补货 · 库存 · 退货** | 🚧 **待做**（不是死代码） |
| 补货/退货 · 一单多货品 | 她今晚点名的"重中之重" | `submitReplenish` / `submitPurchaseReturn` 仍是**单货品**入参 | 🚧 **待做（大改）** |
| 补货/退货 · 异步 | 三个都要异步 | 只有销售有异步闸门（`SCAN_SALE_ASYNC_WRITE_ENABLED`） | 🚧 **待做** |
| 扫一扫页第一个卡片 | `销售 · 补货 · 库存 · 退货` ＋「继续扫下一个」**合并卡片** | 「继续扫下一个」已有；四领域合并卡片未按此落地 | 🚧 **待做** |
| 两个新待办（issue #616） | 「样品卖了怎么办」「货品信息不全怎么分发」 | 未实现 | 🚧 **待办** |

---

## 7. 附：环境变量模板体检（`.env.example` 167 个键）

### 7.1 🔴 别误杀：**32 个键是"按前缀动态拼"读的**（`grep` 字面量 0 命中 ≠ 没人读）
| 前缀族 | 键数 | 读取实现 | 证据 |
| --- | --- | --- | --- |
| `SALES_MISSING_INFO_*` | 28 | `config/salesMissingInfoText.js:47` `const PREFIX = 'SALES_MISSING_INFO_'` + `${PREFIX}INTRO_TEXT` 等 | 协议 §7 专门点过这个坑 |
| `PURCHASE_GROUP_NOTICE_*` | 3 | `config/purchaseGroupNoticeText.js:35` `PREFIX` | 同上 |
| `TEXT_LLM*` | 1 | `config/llmModels.js` 的 `prefix: 'TEXT_LLM'` | 同上 |

### 7.2 🚩 真孤儿 **12 个**（= §3.2 待删-2：A 族 7 + B 族 5）

### 7.3 反向：**代码在读、模板里没有的键** —— 不是死代码，是**模板缺项**
- ⚠️ **这个方向的口径只能算"近似"**：仓里有**经常量间接读**的写法（例：`config/privateChatNotice.js:13-14`
  用 `NOTICE_ENABLED_KEY` 常量再 `readFlag(env, NOTICE_ENABLED_KEY, …)`）⇒ 纯字面量扫法会**漏报**。
  所以下面只列**已核过**的几族（不作全量声明）：
  | 族 | 键数 | 说明 |
  | --- | --- | --- |
  | `TAG_QR_SWEEP_*` | 6 | 二维码兜底巡检（开关/小时/间隔/上限/最短间隔/干跑） |
  | `LABEL_PRINT_*` | 6 | 打印小助手（device / long-poll / claim-timeout / retention / SSE ping / transport） |
  | `WORKBENCH_ORDERS_*` | 3 | 订单列表（缓存毫秒 / 售后开关 / 二次交付开关） |
  | `LARK_JSAPI_*` | 4 | 网页扫一扫签名（jssdk url / ticket ttl / timeout / token ttl） |
  | `ACCESSORY_SALE_INTAKE_FIELD_ID_*` | 6 | 配品销售的**列 id 覆盖口**（默认值已在 `config/accessorySaleIntake.js` ⇒ 只在"她改列"时才要用） |
  | `SELFCHECK_*` | 4 | 部署后自检（base url / number / record id / timeout） |
- ⚠️ **`PRIVATE_CHAT_DISABLED_NOTICE_ENABLED` / `_TEXT`（2 个）代码在读、模板里没有**：
  `.env.example:186-192`（关键那句在 `:190`）只有一段**注释**说"**不要**加 `PRIVATE_CHAT_INTAKE_ENABLED` 之类的变量"，
  这两个**真旋钮**本身没写进模板 —— `docs/reports/doc-code-drift-2026-10-07.md:153` 已记过一次
  （「新增配置，**未写入 `.env.example`**」），**至今仍在**。
- **不该进模板**（凭证/运行时注入）：`LARK_TEST_APP_ID/SECRET` · `APP_VERSION/COMMIT/DEPLOYED_AT` · `NODE_ENV` ·
  `NODE_TEST_CONTEXT` · `VERCEL` · `FEISHU_V1_PROD_APP_TOKEN` / `FEISHU_V1_FORBIDDEN_APP_TOKENS`（防误写闸门）等。

---

## 8. 建议的下一步（**等她点头**，一类一个 PR）

> 🔴 本报告**只给清单**。下面是"如果她点头"的执行顺序建议（每步都要：两遍全量 EXIT=0 ×2 + 判据迁移表 + 她点头）。

| 顺序 | 一类 | 内容 | 风险 |
| --- | --- | --- | --- |
| 1 | **零风险清理** | 待删-1（坏 script 行）· 待删-2（12 个孤儿键）· 待删-3（1 个死方法） | 极低（判据迁移表已确认"能力另有承载"） |
| 2 | **模板补全** | §7.3 里"值得补"的那批键 + `PRIVATE_CHAT_DISABLED_NOTICE_*` | 低（只动 `.env.example` 注释与默认值） |
| 3 | **要她定**（逐项问） | Dockerfile/.dockerignore · `modules` 生成链 · `supabase/` · 根个人需求 md · 一次性脚本/探针 | 需要她逐条点头 |
| 4 | **不属本次审计** | 架构待做项（§6：领域顺序 / 一单多货品 / 补货退货异步 / 合并卡片） | 是**新功能**，另开任务 |

---

## 9. 本次审计"没做什么"（自证）

- ❌ 没有删任何文件/代码/配置/键；❌ 没有改任何业务文件；✅ 只**新增**本报告一个文件。
- ❌ 没有跑部署/部署闸门/`pm2`；❌ 没有用飞书 CLI；❌ 没有读写任何 Base（生产或测试）。
- ✅ 全程只读：`git log/show`、`grep`、`ls/find`、`node`/`python3` **只读脚本**（产出 JSON 在 `/tmp`）。
- 📌 本报告里的**"待删"只是清单**：真删要**另开任务、按类分 PR、并拿到她的点头** ✓。
