# 「报货批次」自动时间列改名同步：创建时间 → 报货日（执行报告）

- 日期：2026-10-07（深夜）
- 分支：`fix/purchase-batch-time-field-rename`（从 `origin/main` `e2ec040` 开；PR base = `main`）
- 触发：部署闸门 `pnpm run v1:schema-check:all` 在**生产**上判红
  —— `“报货批次”缺少 V1 字段: 创建时间`
- 生产 Base：🔴 **全程只读**（本机 `.env` 指向测试 Base，够不着生产；本次**没有任何写表操作**）

---

## 0. 业务负责人在生产表做了什么（父代理在服务器上只读核过）

「报货批次」（`tblwezby9wRea9qi`）现在 11 列，其中两列是**改名后的自动字段**：

| 物理列名 | 类型 | 原来的名字 |
| --- | --- | --- |
| **报货日** | 创建时间 `type=1001`（飞书自动） | 「创建时间」 |
| **到货日** | 更新时间 `type=1002`（飞书自动） | 「更新时间」 |

⇒ 类型没变、还是自动字段，**只是名字变了**；schema 里按旧名 `创建时间` 找不到 ⇒ 闸门红。

## 1. ⭐ 验收标准（**先写，后动手**）

| # | 标准 | 判定 |
| --- | --- | --- |
| ① | `schema.tables.purchaseOrderBatch.fields.createdAt === '报货日'`（语义键名不变，只改字段名映射） | ✅ |
| ② | 「报货批次」那一段映射里**不再出现** `创建时间`；去注释后源码里 `'创建时间'` 这个**字段名字面量**为 0 | ✅ |
| ③ | ⭐ **不给「到货日」建映射**：它是自动字段（`type=1002`），AGENTS.md 口径「时间字段交给飞书自动生成」＋ 既有守门用例（A3③ / B4）都钉着"不许映射" | ✅ |
| ④ | ⭐ **没有任何写入点**写「报货日」/「到货日」：`src` + `public` + `scripts` 去注释后不含这两个**精确字段名字面量**；`createdAt` 语义键只出现在 schema 定义文件 | ✅ |
| ⑤ | 行为一行不变：`arrivalStatus` / `document` / `acceptanceText` / `confirmStatus` / `idempotencyKey` 映射与写入点**逐字不动**；「采购行为」仍不映射 | ✅ |
| ⑥ | 🔴 不碰：销售侧、采购退货解析（刚合并）、到货链路已合并行为、`pendingDealPush*`、`app.js` | ✅ |
| ⑦ | 全量 `node --test --test-concurrency=1` **连跑 2 次 `fail=0`**（在**独立 worktree** 里跑） | ✅ |
| ⑧ | PR 的 `gh pr checks` = **CLEAN**，**不用 `--admin`**；**不合并、不部署** | 见第 5 节 |

### ⚠️ 判不了的一条（如实标注）

- 生产闸门**最终**是否 GREEN，只能**在服务器上对着生产**跑 ——
  本机 `.env` 指向的那个 Base 的「报货批次」**只有 4 列**
  （`报货批次号[1] · 创建时间[5] · 幂等键[1] · 更新时间[1002]`，见第 5 节只读实测）：
  它**既没有**「到货状态 / 单据 / 验收原话 / 确认状态」，那一列的「创建时间」还是**普通 DateTime（type=5）**、
  不是生产的自动 `type=1001`。⇒ **本机闸门对这次改动没有判据**，而且它**在改动前也是红的**
  （报「缺少 V1 字段: 到货状态、单据、验收原话、确认状态」）。
  所以本次的「先红后绿」用**单测**做，不用本机闸门做。

## 2. 逐条对照

| # | 证据 |
| --- | --- |
| ① | `server/src/config/v1BitableSchema.js` 的 `purchaseOrderBatch.fields.createdAt` 改为 `'报货日'`；新用例 A4 断言 `=== '报货日'` |
| ② | A4 断言 `Object.values(batch)` 不含 `'创建时间'`；同一用例去注释扫描全仓，`/['"]创建时间['"]/` 命中即失败（当前 0 命中） |
| ③ | A3③ 原有断言 `updatedAt` / `arrivalAt` / `inspector` 都不建映射；A4 又显式断言 `hasOwnProperty(batch,'updatedAt') === false`、`Object.values(batch)` 不含 `'到货日'`；B4 断言**任何表**都不映射 `'到货日'` |
| ④ | A4 去注释扫描 `src` + `public` + `scripts`：`'报货日'`（schema 文件除外）、`'到货日'`、`'创建时间'`、以及 schema 之外的 `\bcreatedAt\b` —— 全部 0 命中 |
| ⑤ | 只改了 `v1BitableSchema.js` 一个字段名与注释；`purchaseOrderBatchService.js` / `purchaseWebhookService.js` / `purchaseQueryService.js` **一行未动**（`git diff --stat` = 2 files） |
| ⑥ | 改动文件只有 `server/src/config/v1BitableSchema.js` 与 `server/test/purchaseTableRenameSync.test.js`（＋本文件与 `docs/README.md` 索引） |
| ⑦ | 见第 5 节两次全量输出 |
| ⑧ | 见 PR 的 `gh pr checks`（本文件不重复贴，避免"贴的那次 ≠ head 那次"） |

## 3. ⭐ 旧字段名全仓扫描（`server/src` + `server/test`；public/scripts 一并看过）

### 3.1 改了（**只有 1 处**）

| 位置 | 改动 | 语义键 |
| --- | --- | --- |
| `server/src/config/v1BitableSchema.js:333`（`purchaseOrderBatch.fields`） | `'创建时间'` → **`'报货日'`** | `createdAt` **不变** |

### 3.2 没改（逐条 + 原因）

| # | 位置 | 名字 | 为什么**不改** |
| --- | --- | --- | --- |
| 1 | `v1BitableSchema.js` `liveInventory.fields.updatedAt` | `'更新时间'` | 是**「实时库存」**的列，不是「报货批次」；它是**只读投影**（`v1WorkbenchService:325` 读它显示"最后变动时间"），2026-10-06 的时间字段收口报告已核过"只读不写"并**明确保留**。🔴 顺手改它 = 改错表 |
| 2 | `v1BitableSchema.js` `purchaseRequest.fields.quantity` | `'数量'` | 是**「具体信息」**的列（采购申请/退货明细的双数）。她删掉的是**「信息填写」**的「数量」（那次已同步删映射，见 :263-274 注释），**不是这一张**。🔴 不许误删 |
| 3 | `v1BitableSchema.js` `purchaseInbound.fields.quantity` | `'数量'` | 是**「采购入库」**的入库数量，仍在。🔴 同上 |
| 4 | `server/src/config/modules.js` ×3 | `field: '数量'` | 是**已退役微信链路**的 `sync` 模块配置（同一份里还有 `SKU_Code` / `对应图片`），跟 V1 多维表格 schema 无关。🔴 不在范围 |
| 5 | `v1BitableSchema.js` 注释 ×4（:219/:256/:374/:399 附近）· `inventoryService` / `afterSalesService` / `purchaseWebhookService` 的多处注释 · `server/scripts/list-v1-fields.js:39`（类型名表）· `e2e-*.mjs`（字段筛选正则）· 各测试的注释 | `创建时间` | **全是注释 / 类型标签 / 测试筛选用**，不是字段映射。去注释后源码里 `'创建时间'` 字面量 **0 命中**（守门用例 A4 钉住）。注释里的沿革要留着 —— 下一次改名的人得知道它以前叫什么 |
| 6 | `purchaseOrderBatchService` / `purchaseQueryService` 注释 · `inventoryMvp.test.js:91` 断言 | `更新时间` | 注释 + 断言（"实时库存不许写更新时间"）。源码里 `'更新时间'` 字面量**只剩** `liveInventory` 那一处映射（= 第 1 条）；「报货批次」这一段里**从来没有过** `updatedAt` 映射 |
| 7 | `v1BitableSchema.js` :306-322 / :374-382 注释 · `arrivalConversation.js` 文案 · `purchaseArrival*` 系列 service/config 名 · 各测试 | `到货验收` / `采购到货` / `采购到货批次` | **已有改动早已落地**：schema 里 `purchaseArrival` 整段已删、「采购入库.采购到货批次」映射已删；剩下的只有**注释里的历史沿革**和**「到货核对」这条链路自己的 service/config 名字**（`config/purchaseArrivalStatus.js`、`config/purchaseArrivalIntake.js`、`purchaseArrivalConversationService` 等 —— AGENTS.md 明确保留）。测试 A3 / B5 已钉住。🔴 不动 |
| 8 | — | `到货日` | 真表上是**自动字段**（更新时间 `1002`）⇒ **不建映射、不写**（既有 A3③ / B4 钉住；A4 继续钉） |

> ⭐ 一句话：**「报货批次」只有 `创建时间` 这一处需要改**；
> 名字里带这些字样的其它出现，**要么是别的表（实时库存/具体信息/采购入库）、要么是注释/标签/退役链路**。

## 4. ⚠️ 「闸门还会有下一条吗」——可疑清单（**按代码推、不硬猜生产**）

**机制（读代码得到，可自证）**：`validateTables` 是**顺序 await** 且 `validateTable` 在
**第一张缺字段的表就 `throw`** ⇒ 整轮 `all` 在那一张**断掉**，**后面的表一个都没核**
（`server/src/services/v1BitableGateway.js` 的 `validateTable` / `validateTables`）。

`all` 的实际校验顺序（`getV1SchemaScope('all')` 展开，实跑打印过）：

| 顺序 | 表 | 这轮结论 |
| --- | --- | --- |
| 1–7 | 货品信息 · 其他配品 · 收款方式管理 · 销售主表 · 销售明细 · 收款明细 · 客户往来货款 | ✅ **已核过、都绿**（断点在 11） |
| 8–10 | 供应商管理 · 信息填写 · 具体信息 | ✅ **已核过、都绿** |
| **11** | **报货批次** | ❌ **就是这里抛的**（本轮改动修的就是它） |
| 12–16 | **采购入库 · 行为管理 · 尺码管理 · 库存流水 · 实时库存** | ⚠️ **这轮从未被核到** |

⇒ **可疑清单（= 第 12–16 张，按可疑度排）**：

1. ⭐ **`liveInventory.fields.updatedAt = '更新时间'`（实时库存）** —— **最可疑**：
   她这次改的两列就是**自动时间列**（`1001`/`1002`），而这是全 schema 里**仅剩的一处**
   指向「更新时间」这个名字的映射，且实时库存是她天天在动的表。若她也把它改名了，
   下一轮闸门会红在**同名的地方**。（⚠️ 只读核过本机那个 Base，**核不到生产**，所以这里只列清单）
2. **`purchaseInbound`「采购入库」** —— 就在断点下一张；她**刚刚**才从这张表删掉「采购到货批次」，
   同一批动作里再动别的列完全可能。
3. **`inventoryLedger`「库存流水」** —— 她之前删过这一张的「发生时间」，说明她在这张表上动过手。
4. **`behavior`「行为管理」/ `sizeManagement`「尺码管理」** —— 都排在断点之后，这轮没核到
   （本机跑 `inventory` scope 时它报的是「行为管理.销售赔货 的库存方向」= **内容**问题，
   而这台机器的 Base 是旧的，不能据此推断生产）。
5. 「信息填写」「具体信息」（顺序 9/10）**不是**嫌疑 —— 这轮已经核过了。

**⭐ 建议（只读、在服务器上做）**：因为闸门"一断就停"，**三个 scope 分开跑**能把断点错开 ——
`v1:schema-check:inventory` **不必等「报货批次」通过**就会去核 实时库存 / 库存流水 / 采购入库 / 行为管理 / 尺码管理；
或用项目自带的只读列清单脚本 `server/scripts/list-v1-fields.js` 把这几张表逐列打出来与 schema 并排看。
🔴 我本机**够不着生产**，以上**只是清单**，不是结论。

## 5. 证据

### 5.1 先红后绿（同一份用例：`server/test/purchaseTableRenameSync.test.js` 新增 **A4**）

红（**改代码之前**，HEAD = `e2ec040`，schema 还是 `'创建时间'`）：

```
✖ A4 schema 同步「创建时间」→「报货日」；两个自动时间列都没有写入点 (0.868333ms)
  AssertionError [ERR_ASSERTION]: 「创建时间」已被业务负责人改名为「报货日」
  '创建时间' !== '报货日'
  at test/purchaseTableRenameSync.test.js:154:10
ℹ tests 11  ℹ pass 10  ℹ fail 1
```

绿（改完 schema 之后，**只改了那一个字段名**）：

```
✔ A4 schema 同步「创建时间」→「报货日」；两个自动时间列都没有写入点 (20.425125ms)
ℹ tests 11  ℹ pass 11  ℹ fail 0
```

### 5.2 全量两次（独立 worktree `.local/worktrees/purchase-batch-time-rename`，`node --test --test-concurrency=1`）

```
第 1 次：ℹ tests 1281  ℹ pass 1281  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0   (exit 0, 37.1s)
第 2 次：ℹ tests 1281  ℹ pass 1281  ℹ fail 0  ℹ cancelled 0  ℹ skipped 0   (exit 0)
```

### 5.3 本机闸门（**测试 Base**，只读）—— 如实记录，**不作为判据**

```
$ node scripts/validate_v1_schema.js purchase
“报货批次”缺少 V1 字段: 报货日、到货状态、单据、验收原话、确认状态
```

```
$ node scripts/validate_v1_schema.js inventory
请将行为管理「销售赔货」(SALE_COMPENSATION) 的库存方向设置为“减少”
```

只读核本机 `.env` 指向的那个 Base 的「报货批次」（用**项目自己的 gateway**，不是飞书 CLI）：

```
本机 .env 指向的那个 Base 的「报货批次」: 4 列
报货批次号[type=1] · 创建时间[type=5] · 幂等键[type=1] · 更新时间[type=1002]
```

⇒ 那个 Base **落后于生产好几步**（缺「到货状态/单据/验收原话/确认状态」，
`创建时间` 还是普通 `type=5`）。**本机闸门对本次改动没有判据**，
最终 GREEN 必须**在服务器上对着生产**跑。
