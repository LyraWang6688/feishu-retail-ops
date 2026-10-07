# 采购群那条话术：去掉「N 条」，只说「多少双」（2026-10-07）

## 1. 业务负责人的话（逐字）

> 「我需要你改一下机器人的话术，就是**不用说几条，只给出多少双就可以了**～」

她在群里看到的（逐字）：

```
@王颖 未标注供应商 这批 5 条（共 5 双），图可以直接转给供应商。
@王颖 三星 这批 12 条（共 13 双），图可以直接转给供应商。
```

## 2. 验收标准（**动手之前先写**，逐条对照见第 7 节）

| 编号 | 验收标准（改完之后应该是什么样） |
| --- | --- |
| AC-1 | 有供应商名：群里那条文字**逐字**为 `@… 三星 这批 13 双，图可以直接转给供应商。`（飞书文本消息里 @ 是 `<at user_id="ou_x"></at> 三星 这批 13 双，图可以直接转给供应商。`） |
| AC-2 | 未标注供应商：逐字为 `@… 未标注供应商 这批 5 双，图可以直接转给供应商。` |
| AC-3 | 双数为 1 时：`@… 金猴 这批 1 双，图可以直接转给供应商。`（不加「1 双」以外的任何量词） |
| AC-4 | 文案里**不含「条」**（「N 条」整段删掉）；也不再有「共」 |
| AC-5 | 双数口径**一个字没改**：仍是 `sum(items[].quantity)`（与改前同一个字段、同一个求和）——2 条明细 2+1 双 ⇒ 「这批 3 双」 |
| AC-6 | 保留：@经办人（拿不到 open_id 时不 @、绝不 @所有人）· 供应商名 · 「图可以直接转给供应商」 |
| AC-7 | 文案（含 @ 模板、供应商名占位、双数占位、未标注供应商兜底写法）**全部进 `server/src/config/purchaseGroupNoticeText.js`**，可用环境变量覆盖；service 里**一个中文字符都不写** |
| AC-8 | 发送方式不变：仍是 `chat_id` + 回复第 1 条图 + `reply_in_thread`（话题），不改群/话题机制 |
| AC-9 | 不动出图（PNG 内容）· 不动采购申请写入 · 不动数量口径 · 不碰销售侧 / `pendingDealPush*` / `dailyReport*` / 工作台首页 |
| AC-10 | 既有断言**不许放宽**：改动前那 4 处逐字断言（3 处 `assert.equal` + 退货 2 处 `assert.match`）**逐字更新**为改后文案，不许改成宽松正则或删掉 |
| AC-11 | `.env.example` 与配置默认值逐字一致（新加文案忘了写文档 → 测试红） |

## 3. 那句话在哪儿拼的

`server/src/services/purchaseWebhookService.js`（改动前行号）：

- **`:1585`** —— 唯一的拼接点：
  `` this.mentionOperatorText(operatorOpenId, `${label} 这批 ${rowCount} 条（共 ${totalPairs} 双），图可以直接转给供应商。`) ``
- `:1535` / `:1536` —— 两个数字的来源：
  - `rowCount = group.items.length`（= 「N 条」，**删掉**）；
  - `totalPairs = group.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0)`
    （= 「多少双」，**口径一个字没动**）。
- `:1534` —— `label = supplierName || '未标注供应商'`（供应商名占位 / 兜底写法）。
- `:1203` —— `mentionOperatorText(operatorOpenId, content)`（@ 经办人的那段飞书标记，**唯一一处**）。

**双数取的是哪个字段**：`item.quantity`（报单「数量说明」解析出来的每一件的双数），
按**同一供应商这一组**求和 ⇒ `totalPairs`。**不是** `item_count` / `items.length`
（那个是「N 条」）。本次只改文案，**不动这个求和**。

## 4. 配置先行

新增 `server/src/config/purchaseGroupNoticeText.js`（照 `config/*.js` 既有模式：占位符 + 环境变量 + 默认值）：

| 环境变量 | 默认值（逐字） | 占位符 |
| --- | --- | --- |
| `PURCHASE_GROUP_NOTICE_TEXT` | `{supplier} 这批 {pairs} 双，图可以直接转给供应商。` | `{supplier}` 供应商名（取不到时用下面的兜底）· `{pairs}` 双数 |
| `PURCHASE_GROUP_NOTICE_MENTION_TEXT` | `<at user_id="{openId}"></at> ` | `{openId}` 经办人 open_id |
| `PURCHASE_GROUP_NOTICE_UNKNOWN_SUPPLIER_TEXT` | `未标注供应商` | —— |

取值规则走 `config/envValue`（没设 → 默认；设了 → 用设的值；设成空串/空白 → 回落默认，
与 `salesMissingInfoText` / `salesColorChoice` 同一套），并且**调用时才解析**，不在模块加载时求值。

## 5. 同类文案排查（全仓 grep「图可以直接转给供应商」/「共 … 双」/「这批」）

| 位置 | 内容 | 处理 |
| --- | --- | --- |
| `server/src/services/purchaseWebhookService.js:1585` | 采购群那条（唯一拼接点） | ✅ **改** |
| `server/test/purchaseWebhookService.test.js:318 / 428 / 462 / 463` | 同一句的逐字断言 | ✅ **跟着改**（不放宽） |
| `server/test/purchaseReturn.test.js:294 / 337` | 同一句的断言（**退货单走的就是这一行**） | ✅ **跟着改**（同一条文案的两个分支，必须一致） |
| `server/src/services/purchaseRequestImageService.js:478` | 只是一句注释提到「这批 N 条」 | ✅ 改注释（图上本来就不出现，避免误导） |
| `server/public/workbench/features/inventory/adjustment.js:387` | 工作台「库存调整」结果：「已把 N 条（共 M 双）改成…」 | ❌ **不同一条话术，不动**（她只说采购群那一句） |
| `server/scripts/ws-selftest.mjs:368` | 自测脚本打印：「实时库存：N 个库存键 · 共 M 双」 | ❌ 自测脚本输出，不动 |
| `docs/reports/**`（含 `purchase-image-layout-and-group-thread-2026-10-07.md:225`、`selftest-e2e-2026-10-06/evidence/**`） | **历史证据**（当时真实收到的原文） | ❌ 不动（改历史证据 = 篡改记录） |

⚠️ **退货单这条一并变**：`deliverReturnImages` → `deliverSupplierImages` → `deliverSupplierImagesInner`
**就是同一行代码**，采购申请单与退货单共用这一整条「按供应商出图 → 发群 → 写回附件」流程
（只有标题 / 文件名后缀不同）。⇒ 改这一行**两个分支一起变、且逐字一致**；
若刻意只改一个分支，反而会造出"同一句话两种写法"的不一致。

## 6. 不在范围内（明确不动）

- 出图内容（PNG 本身）· 采购申请写入 · 数量口径 · 群/话题发送方式（仍是话题）
- `pendingDealPush*` · `dailyReport*` · 工作台首页入口 · 销售侧任何东西
- 🔴 **不部署**（业务负责人明令：每次都要她当次命令）

## 7. 逐条对照（验收标准 → 证据）

| 编号 | 证据 |
| --- | --- |
| AC-1 | `server/test/purchaseWebhookService.test.js`（`金猴 这批 3 双` 逐字 `assert.equal`） |
| AC-2 | `server/test/purchaseReturn.test.js`（`未标注供应商 这批 1 双`） |
| AC-3 | `server/test/purchaseGroupNoticeText.test.js`（双数 = 1 的渲染 + service 层 1 双逐字） |
| AC-4 | `server/test/purchaseGroupNoticeText.test.js`（`!text.includes('条')`，service 层也断言） |
| AC-5 | `server/test/purchaseWebhookService.test.js`（2 条明细 2+1 双 ⇒ 「这批 3 双」） |
| AC-6 | 同上（@ 挂在文字上、无 open_id 时不 @、供应商名与尾句保留） |
| AC-7 | `server/test/purchaseGroupNoticeText.test.js`（env 覆盖 + 默认值 + 逻辑里无中文） |
| AC-8 | 既有话题用例不变（本次一行未动发送方式） |
| AC-9 | diff 里没有这些文件 |
| AC-10 | 4 处逐字断言按新文案更新（`git diff` 可核，无正则放宽） |
| AC-11 | `server/test/purchaseGroupNoticeText.test.js`（`.env.example` ↔ 默认值逐字） |

## 8. 测试与 CI 证据

| 项 | 命令 / 位置 | 结果 |
| --- | --- | --- |
| 定向：新守卫用例（单独） | `.local/purchase-notice-wording/server`：`node --test --test-concurrency=1 test/purchaseGroupNoticeText.test.js` | **9 pass / 0 fail** |
| 定向：受影响链路（5 个文件） | 同上：`purchaseGroupNoticeText` ＋ `purchaseWebhookService` ＋ `purchaseReturn` ＋ `purchaseReturnBatch` ＋ `purchaseRequestImageService` | **143 pass / 0 fail**（4.1s） |
| 全量（第 1 次） | 同上 worktree：`node --test --test-concurrency=1` | **1154 pass / 0 fail**（exit 0，29.6s） |
| 全量（第 2 次） | 同上 | **1154 pass / 0 fail**（exit 0，33.7s） |
| 跑测试前的版本自检 | `git rev-parse --short HEAD` = `f999efa`；`git rev-list --count HEAD..origin/main` = **0** | ✅ |
| CI（PR #237，`gh pr checks 237`） | head `f999efa` | `test` **pass** 50s · `Analyze (javascript-typescript)` **pass** 1m6s · `CodeQL` **pass** 2s |
| 合并状态 | `gh pr view 237 --json mergeStateStatus,headRefOid` | **`CLEAN`**（head `f999efa`） |

⚠️ 全部跑在**自己的 worktree** `.local/purchase-notice-wording/server`（**不在主工作区跑全量**）；
每次跑前先自检代码版本。⭐ 分支已 **rebase 到最新 `origin/main`（`792d639`，含 PR #236 工作台首页那条）**
⇒ `behind = 0`，所以上面这些全量结果是**合并后的树**上跑出来的（含 workbench 的新用例）。
⚠️ 本地全量跑的是"CI 之前的证据"，**CI 结论以 `gh pr checks` 为准**。
⚠️ 本文件是**它自己那次全量之后**回填的证据（docs-only 提交）：上表 CI 三项取自 `f999efa` 那次
`gh pr checks` 的当次实返；docs-only 提交会让 CI **各自重跑，结果同形**。
🔴 **本次没有部署**（业务负责人 2026-10-07 明令：禁止自行部署，必须她当次命令）。
🔴 **PR 只开不合**（合并由业务负责人做）。
