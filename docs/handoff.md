# 交接说明（Agent Handoff）

> 最后更新：2026-10-02
> 基线：`main @ f036d9123b68d64e2961ff9ea7795da3fe1fcf39`（PR #17、#18 合并后的 main）
> 文档性质：**面向下一个接手者（人或 AI）的当前状态说明 + 待办 + 边界**。
> 与本文冲突时，以代码和根目录 `AGENTS.md` 为准；本文不重复 `AGENTS.md` 已经写清的规范。
> 📌 **新增协作线（2026-10-04）**：抖音内容与经营共创（背景 / 资产索引 / 第一步请求）→ 见 [handoff-douyin-content-co-creation.md](handoff-douyin-content-co-creation.md)

---

## 1. 一分钟现状

| 项 | 值 |
|---|---|
| 仓库 | `LyraWang6688/feishu-retail-ops` |
| 正式入口 | 飞书机器人私聊（录入）＋ 飞书网页工作台（查询 / 收款 / 交付） |
| 运行时 | Node.js >= 20，包管理器 **pnpm**（不是 npm） |
| 测试 | `cd server && pnpm test` → **216 passed / 0 failed** |
| 部署 | 腾讯云轻量服务器 + Nginx + PM2（`server/scripts/deploy_build.sh` / `deploy_run.sh`） |
| 数据底座 | 飞书多维表格（既是数据库，也是人工核对界面） |

**接手第一件事**：本地分支很可能是旧的，先同步（不要 `reset --hard` / `rebase`）。

```bash
git fetch origin --prune
git switch main && git pull --ff-only origin main
```

---

## 2. 系统是什么

```
飞书机器人 / 网页工作台   = 用户入口
server/ 后端              = 解析、校验、可靠入账引擎（唯一写表入口）
飞书多维表格              = 数据底座
飞书自动化 / 工作流       = 只做提醒与审批，不复制库存与资金规则
```

销售在私聊里说自然语言、采购发到货图片 → 豆包解析 → 飞书卡片确认 → 后端统一入账 → 写多维表格并联动库存 / 资金。原微信小程序链路已于 2026-10-01 整体退役（见 `archive/legacy-wechat-retirement.md`）。

---

## 3. 关键文件在哪

```
server/src/
  app.js                      入口。挂载顺序：lark events → feishu auth → workbench → 静态页 → /health → API_KEY 中间件
  routes/                     larkEvents（飞书事件）/ feishuWebAuth / workbench / purchaseQuery
  services/
    larkMvpService.js         机器人销售与采购卡片的共享编排层。改它必须同时跑销售和采购回归
    doubaoService.js          豆包解析：parseSalesText / recognizeLabels
    purchaseWebhookService.js 采购主线（报单→申请→到货→入库），最复杂的一个
    salesOrderService.js      销售确认入账（明细 + 收款）
    salesDeliveryService.js   交付，扣减销售库存的唯一入口
    salesFollowupService.js   工作台的补款与交付
    inventoryService.js       库存流水 + 一双一条的实时库存
    v1BitableGateway.js       多维表格读写封装（字段名全部来自配置）
    sizeReferenceService.js   尺码关联读写（业务层用整数，表里是关联记录）
  config/v1BitableSchema.js   字段名与表 ID 的唯一定义处
  infrastructure/             jsonTaskStore / keyedSerialQueue / idempotencyKey
  utils/logger.js             结构化 JSON 日志
  utils/larkCards.js          卡片 JSON
server/public/workbench/      工作台前端。只展示后端返回值，不重算业务
docs/                         索引见 docs/README.md（现行 / 设计基线 / 历史三档）
```

---

## 4. 必须先知道的硬约束

### 4.1 数据模型

- 「销售明细」一条 = 一双鞋（`quantity` 固定 1）；配品（腰带 / 鞋油等）一条 = 一件，**无尺码、不跟踪库存、当场已交付**。
- 「实时库存」**一条记录 = 一双鞋**，按 `编号 + 尺码 + 所属状态` 操作；状态目前是 `门盒 / 样品 / 仓库`。
- 「尺码」字段是**关联「尺码管理」**，不是数字。写入用 `relation(recordId)`，读取必须走 `SizeReferenceService`；**不要直接读关联单元格的显示文本**。
- 库存动作由「行为管理」表的行为编码驱动（`STOCK_SALE_DECREASE` / `STOCK_PURCHASE_INCREASE` / `STOCK_DOORBOX_TO_SAMPLE`）。新增动作 = 表里加一条行为 + `inventoryService` 的 `STOCK_MOVEMENTS` 加一条声明，**不要写 if-else**。

### 4.2 调用顺序与不变量（详见 `module-boundaries.md`）

- 销售确认：销售主表 → 明细 → 收款。**不扣库存。**
- 交付才扣库存，且**门盒优先、不足落样品、不扣仓库**。
- 同一明细当前**只支持一次性交付全部数量**（部分交付是已知限制）。
- 库存以「来源明细 ID」做幂等键；销售明细与采购入库明细是两种不同来源。**其他模块不要直接创建库存流水或实时库存记录。**

### 4.3 测试与真实数据边界

- 真实 E2E **禁止**把生产 Base 当测试环境；写库脚本默认拒写生产。
- `FEISHU_TARGET_ENV=test` 配合 `FEISHU_V1_E2E_*` 才是允许真实写入的姿势；写生产必须显式 `FEISHU_ALLOW_PRODUCTION_WRITE=true`。
- `pnpm run v1:schema-check:*` 是**只读结构校验**，不写任何数据；`deploy_build.sh` 拿它当部署闸门。
- 普通 Agent 不得自行对生产数据执行 E2E 写操作。

### 4.4 已经退役、不要试图恢复的部分

微信小程序链路已于 2026-10-01 整体退役：`miniprogram/`、`legacyWechat.js`、`ENABLE_LEGACY_WECHAT`、旧 `FEISHU_APP_*` / `FEISHU_BITABLE_*` 环境变量、Coze 配置 `.coze` 与 `server/.coze` **全部删除**，没有任何开关可以重新启用。环境变量的权威说明见根目录 `AGENTS.md`。

---

## 5. 幂等：现状与契约

> 契约文档：`idempotency-contract.md`
> 实现：`server/src/infrastructure/idempotencyKey.js`

### 5.1 三个远端幂等键

| 表 | 字段 | 值格式 |
|---|---|---|
| 报货批次 | 幂等键 | `purchase_batch:<taskId>` |
| 采购申请 | 幂等键 | `purchase_request:<taskId>:<index>` |
| 实时库存 | 库存操作键 | `<inventory_operation_id>:<sequence>` |

### 5.2 固定写入顺序

任何 create 都必须走这个顺序：

```
按幂等键回查远端
  ├─ 命中 1 条 → 复用，不再 create
  ├─ 命中 0 条 → 才允许 create
  └─ 命中 >1 条 → 数据已重复，停止自动处理，转人工
```

### 5.3 结果未知的分流

| create 返回 | 判定 | 处理 |
|---|---|---|
| `code != 0`（结构化拒绝） | 确定**没有写入** | 直接抛原始错误，保留可诊断信息 |
| 超时 / 连接重置 / 5xx | **结果未知** | 不重发 create，只在 read-after-write 窗口内按键回查；查不到就抛「创建结果未知，请人工核对」 |

### 5.4 并发保护与本地恢复日志

- `KeyedSerialQueue` 按 taskId 串行；库存按 `stockKey` 串行。**卡片上的「处理中」只是 UX，正确性靠后端。**
- `ensurePostingPlan()` 在任何远端写入**之前**落盘（`posting_plan` / `posting_progress` / `created_live_record_ids`）。它负责「让恢复更快」，**不负责「证明没写重」**——证明永远靠远端键回查。

> ⚠️ 本地任务文件在 `server/data/`（已 gitignore）。**不要用「删掉 data 目录重来」的方式排障**——那等于丢掉恢复线索。

---

## 6. 已完成 / 待办

### 6.1 销售线（`sales-line-plan.md` 是销售的唯一工作清单）

**已完成**：A1 尺码关联改造、A2 配品纳入销售、B1 颜色可选（解析器返回候选 → 卡片选色 → 未选不许确认）、C3 的「定金多行明确拒绝」；另有真实说法回归基线、示例库、部署门槛。

**待办**：

| 事项 | 状态 | 备注 |
|---|---|---|
| B2 定金语序 | 已决策 | **并入 B3**，不要单独改正则 |
| B3 结构化交接 | 已决策，未做 | 让 AI 只输出结构化事实，规则层不再认「定金」两个字 |
| **C1 销售动作注册表** | 已决策，**未做** | 现货 / 预付 / 未付 / 团购 是同一个状态机的四种初始组合，不是四条流程 |
| **C2 第二次确认** | 已决策，未做 | 拆开只有「交付确认」和「收款确认」两个动作，两个入口都已存在 |
| C3 剩余部分 | 部分完成 | 券与定金**只作用于鞋行**；配品是行内优惠，不参与整单分摊 |
| **C4 退换货** | 已决策，**最后做** | 见下 |

**C4 退换货的前提**：退货 = 反向动作（库存 +1、资金 −1、引用原单）；换货 = 退货 + 一笔新销售。
表结构要先改：「退换赔货交易」表的 `原销售单号 / 原销售明细` 现在是**文本字段，应改成关联**，否则追溯与对账很脆；该表目前只有 `编号 + 尺码`（鞋形），**退配品还要加 `配品` 字段**。

### 6.2 采购线

用户已提出两条新需求，**尚未开工**，方案见第 8 节：

1. 新品必须检验（或「货到再上新」）。
2. 支持「不提申请、直接到货验收」的直采链路。

### 6.3 需要人工在飞书 / 服务器完成的事

这些没做，部署闸门会直接拦下来：

| 事项 | 环境 |
|---|---|
| 加三个文本字段：报货批次.`幂等键`、采购申请.`幂等键`、实时库存.`库存操作键` | 生产 Base |
| 「销售明细」加 `配品` 关联字段（关联「其他配品」） | 测试 + 生产（测试已加） |
| 服务器 `.env` 加 `FEISHU_V1_ACCESSORY_TABLE_ID` | 服务器 |
| 行为管理编码补齐并修正 | 生产（测试已补） |

---

## 7. 已知问题

### 7.1 文档漂移（读文档时以代码为准）

1. `feishu-v1-operations.md` 第 1 节说「库存联动默认关闭，用 `ENABLE_SALES_INVENTORY` / `ENABLE_PURCHASE_INVENTORY` 启用」——**这两个变量在代码里没有任何读取点**：`purchaseWebhookService` 里是 `this.enablePurchaseInventory = true` 硬编码，销售交付也直接调库存。设了没用，文档待修。
2. `sales-line-plan.md` 变更记录里登记的 `v1ReferenceResolver.findLiveInventory` 死代码**仍然存在**，且仍按数字读尺码。
3. `sales-line-plan.md` 第 5 节说「服务器上的代码版本比集成分支旧」——main 已合并，**这条需要重新确认部署版本**。
4. `lark-agent-technical-design.md` 是**原始设计基线**（顶部有状态分区），其中大量内容是设计推演而非现状，不要当成当前实现。

### 7.2 不稳定测试与写入顺序观察

`purchaseWebhookService.test.js` 里 "arrival with no images throws recognition failure" 曾经偶发失败（CI 上出现 `'识别中' !== '识别失败'`），已由 PR #18 修掉：**只改测试**，改成等「到货记录」本身，而不是只等到「任务状态」。

但根因还在，属于**尚未评估的硬化项**：

```js
// server/src/services/purchaseWebhookService.js → process() 的 catch
await this.store.update(taskId, { status: 'failed', error });              // ① 先写本地任务终态
if (kind === 'arrival')
  await this.gateway.update('purchaseArrival', { 识别状态: '识别失败' });   // ② 再写远端记录
```

如果在 ①② 之间崩溃或中断，本地任务文件说 `failed`，多维表格里的那条到货记录却永远停在「识别中」——不会有人再去修它。

可选硬化：把顺序反过来，先补完远端记录、最后写本地任务终态，让「任务 = failed」成为一个可信信号。这会动采购服务的簿记顺序，所以没有跟着测试修复一起做，需要单独评估。

方法记一笔：验证这类竞态时，可以在两步之间临时插一个延迟把窗口放大——插 60ms 后旧断言 100% 失败、新断言仍然通过，据此就能区分「是竞态」还是「某一处写漏了」。**延迟验证完必须删掉。**

---

## 8. 采购线改造方案（待拍板）

### 8.1 现状卡点（读代码得到）

- `purchaseWebhookService.js`：`if (batchIds.length !== 1) throw '采购到货必须选择一个报货批次号'` → **没有采购申请就没有批次，就没有到货**。
- 同文件：识别不到的货号进 `unrecognized`，全都不认识就整单抛错 → **新品进不了库**。

当前链路：报单表单 → `processSupplierReport` → 申请确认卡 → `confirmPurchaseRequest` 建「报货批次 + 采购申请」；到货表单（图片 + 必选批次）→ `processArrival` 识别 + `compareArrival` 比对 → 到货明细卡 → `confirmArrival` 建「采购入库」+ `applyPurchase` 加库存 + 回写采购申请的到货状态。

### 8.2 方案二：无申请直采到货（改动小，建议先做）

1. `采购到货.batch` 从必选改为可选，表单上给「有采购申请 / 直接到货」二选一。
2. 无批次时走 `direct` 分支：跳过 `compareArrival`，`requests = []`，卡片把差异区换成「直采到货（无采购申请）」提示。
3. 到货确认时**自动补建一个报货批次**（来源标「直采」，批次号沿用 `nextBatchNo()`，幂等键 `purchase_batch:arrival:<arrivalRecordId>`），保持查询与追溯口径统一。
4. `confirmArrival` 中「回写采购申请到货状态」的循环遇到空 `requests` 自然跳过，其余（建入库、加库存、幂等）**完全复用**。
5. ⚠️ 到货表需要新增「供应商」字段：现在供应商是从「货品信息」的关联推出来的，直采 + 新品时货品还不存在。
6. 风险：直采绕过了「申请确认」这道复核。建议明确把到货卡片的确认作为唯一复核点，并在卡片上标注「无申请直采」。

### 8.3 方案一：新品必须检验（要动库存语义，建议第二步）

关键洞察：**销售扣库存只消耗 `门盒` 和 `样品`**（`MOVEMENT_SALE_DECREASE.consumes`）。所以只要给未检验的新品一个第三状态，**销售侧一行都不用改**。

```
货到了
  ├─ 已是可售货品 → 落「样品」（该货品还没样品时）或「门盒」（已有样品）  ← 现有逻辑
  └─ 新品（货品主数据不存在）
       ├─ 卡片提示「这是新品，需要先建档」→ 去「货品上新」表单（或卡片直接收字段）
       ├─ 建档后货品默认「待检」
       └─ 入库落到「待检」实时库存                ← 新状态
                ↓ 检验通过（工作台 / 卡片）
             待检 → 门盒；货品转「可售」
```

| 层 | 要加什么 |
|---|---|
| 飞书表 | 「货品信息」加「上架状态」单选（待检 / 可售）；「实时库存」所属状态加「待检」；「行为管理」加编码 `STOCK_PENDING_TO_DOORBOX`、方向「不影响」 |
| 配置 | `inventoryService` 的 `STOCK_MOVEMENTS` 加一条声明 |
| 校验 | `applyChange` 状态白名单加「待检」；`resolvePurchaseInboundState` 改成先看货品「上架状态」 |
| 入口 | 工作台加「待检 → 门盒」动作（与现有 `promoteToSample` 对称） |
| 销售 | **不用改** |

### 8.4 需要先拍板的三个问题

1. 新品是「**必须先建档才能入库**」，还是「**允许先入待检、后补建档**」？前者数据干净但要跳一次表单，后者顺手但可能留下没有主数据的库存记录。
2. 检验门槛放**货品**还是**到货批次**？放货品只有一次首检；放批次则每次进货都要检。
3. 直采要不要**强制事后补申请**？不补的话采购申请表会缺一块，将来算供应商应付会缺数据。

---

## 9. 幂等：可借鉴的 5 点

姊妹项目 `wechat-article-pilot` 的幂等是「外部副作用 + 单进程」模型，核心是**在第一次外部副作用之前，先把 `processing` 写进一份只增不删的账本**，并把失败明确分成可重试与不可重试（`409 DELIVERY_OUTCOME_UNKNOWN`，禁止自动重试）。它的账本加载是整体 fail-closed：文件损坏、**重复幂等键**、语义非法记录一律拒绝加载，绝不退化成空状态。

本项目的骨架与它同源（键回查、命中多条转人工、结构化拒绝 vs 结果未知、串行队列都已对齐）。**可借鉴的 5 点**：

1. **远端缺一个「处理中」状态标记**。`purchaseRequest` / `purchaseOrderBatch` 没有任何状态字段；本地 `posting_plan` 丢了就没了。建议加入账状态，在第一次 create 之前写「入账中」。（旧的采购到货链路反而有 `confirmStatus='入账中'`，新的采购申请没有。）
2. **给 `server/data/` 一份「禁止清理」的明文清单**，写进 `AGENTS.md`：它是 DELIVERY_STATE，不是缓存；禁止用删除的方式解锁。
3. **把错误的 `retryable` 显式建模并传到卡片**。现在 `unknownOutcome` / `duplicateBusinessFact` 只控制代码分支，卡片文案是手写的——手滑把「结果未知」写成「请重试」，就是重复写一笔的前奏。
4. **补本地账本完整性**。`JsonTaskStore.list()` 坏一个文件会整体抛错（意外正确），但没有**重复键检测**，`create()` 是直接覆盖。建议补上。
5. **幂等键的 canonical 校验**。当前键里的变量都是自己生成的，风险低；**一旦键里掺入用户或表单输入（货号、批次号），必须补格式校验**，否则「同一个东西因写法不同形成两个键」。

---

## 10. 建议的下一步（按性价比排序）

1. **先修第 7.1 节的 4 条文档漂移**：成本极低，避免下一个人被误导。
2. **上线验收**：先对生产 Base 跑 `pnpm run v1:schema-check:all`（部署闸门，先确认第 6.3 节的字段都在），再按「现货销售 → 交付扣库存 → 补款 → 采购报单 / 申请 / 到货 / 入库」的顺序做真实链路验收，**重点压幂等**：重复点击、事件重投、确认中途重启进程。
3. **采购方案二（直采到货）**：改动小、不动库存语义，当天能验。
4. **采购方案一（新品待检）**：要动表结构 + 库存状态 + 新行为编码。
5. 再做销售 **C1 / C2**（预付 / 未付 / 团购的金额模型），最后 **C4 退换货**。
6. 第 9 节的 5 点可以先出 `idempotency-contract.md` 的文档提案，不动代码。
7. **（可选）第 7.2 节的写入顺序硬化**：把 `process()` 改成先补远端记录、最后写本地任务终态，消除「本地说失败、远端停在识别中」的窗口。要动采购簿记顺序，单独评估后再做。

---

## 11. 待清理（不属于业务，但会绊人）

- ✅ **分支与 worktree 已于 2026-10-02 清理完毕，不要重复做**：
  - 远端分支 14 条 → 只剩 `main`；本地分支 20 条 → 只剩 `main`。
  - PR #1（`security-hardening`）已关闭：落后 162 个提交、已 CONFLICTING，意图已被现有代码覆盖，且大量 diff 针对已退役的 `miniprogram/` 与 `supabase/`；需要时从 `b1f483b8542e2b8eef625f54eb2f159ce0ef5ba2` 取回它的 18 个独有提交。
  - 19 个 worktree（1 主 + 5 项目内 + 14 孤儿）全部移除，`.git/worktrees` 登记从 19 归零，约释放 280M。
  - 那 14 个孤儿的 `.git` 指向已不存在的 `/Users/wangying/Documents/workplace/box2bitable`，`git worktree remove` 会报 *is not a .git file*；正确做法是先删目录、再 `git worktree prune`。
- **PM2 进程名 `box2bitable-server`** 与**部署路径 `/opt/box2bitable`** 仍是旧名，属独立的 Deployment Migration。
- `.gitignore` 里仍留有 `小程序码.jpg`、`project.private.config.json`、`unpackage/` 与 `# Mini Program` 段标题（退役收尾遗漏）。
- `/api/sync` 时代遗留、已无读取方的 `FEISHU_SYNC_CONCURRENCY` / `FEISHU_RETRY_*`，以及 `MODULES[*].sync` 段，仍留在仓库里。

---

## 12. 命令速查

```bash
cd server
pnpm test                                   # 216 passed / 0 failed
pnpm run dev                                # 本地开发
pnpm start                                  # 生产模式启动
pnpm run v1:schema-check:all                # 只读结构校验（部署闸门用的就是它）
pnpm run v1:schema-check:sales|purchase|inventory
pnpm run generate:modules                   # 由 config/module-manifest.json 重生成 modules.shared.js
```

GitHub 状态：`gh pr view <n> --json state,headRefOid,mergeable,statusCheckRollup`。
CI：`.github/workflows/server-tests.yml`，job 名 `test`。
