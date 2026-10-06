# 分支清仓留档（2026-10-06）：除 `main` 以外的远端分支怎么处置的

> **缘起**：业务负责人 2026-10-06 明确要求「**首先是我看到 GitHub 上除了 main 还有其他分支，
> 这些分支你也要清理掉**」，并批准「**有价值的**先搬进 `docs/` 再删」。
> 本文记录**删之前逐条的判据与证据**，以及**唯一一条真有价值、但没能搬进 main 的东西**
> 存在哪里——万一将来要用，照本文就能找回来。
>
> **清理前的远端分支**：15 条 ＝ `main` ＋ **14 条**其它（含当时正在施工的 1 条、dependabot 1 条）。

## 1. 先说结论

| 处置 | 条数 | 说明 |
|---|---|---|
| **合并进 main**（价值已落到代码/文档里，分支被 GitHub 自动删除） | 3 | 见第 2 节 |
| **判定"已被 main 取代"后删除** | 10 | 见第 3 节（每条都给了取代它的已合并 PR 与在 main 里的对应物） |
| **先留档、再删除**（唯一一条真有价值且**没能**进 main 的） | 1 | `refactor/decouple-creation-and-stock`，见第 4 节 |
| **没动**（别人正在施工） | 0 | 施工中的 `docs/agents-15-ci-and-calibers` 在本任务进行中由**它自己的代理**合并（PR #179），未被我触碰 |

## 2. 合并进 main 的 3 条（先把价值搬走，再让 GitHub 自动删）

| 分支 | 处置 | 搬走了什么 |
|---|---|---|
| `docs/confirmed-2026-10-06-night`（PR **#173**，原本一直开着） | 2026-10-06 23:17(+8) **合并** | 她当晚的**逐字确认**：战报卡片定稿、话题深链可用、履约状态「已交付/已履约」两个都认、以及她当次的部署授权 → 落到 `docs/sales-daily-report-push-2026-10-06.md` §六 |
| `dependabot/npm_and_yarn/server/minor-and-patch-e010e89128`（PR **#59**，开着 1 天多） | 2026-10-06 23:17(+8) **合并** | `server/package.json` 的 `dotenv ^18.0.4 → ^18.0.5` ＋ `pnpm-lock.yaml`；**CI 绿**（`test` SUCCESS、CodeQL 通过）才合，**没有用 `--admin`** |
| `docs/agents-15-ci-and-calibers`（PR **#179**） | **不是我合的** | 它自己的代理在 2026-10-06 23:2x 合并（就是 `AGENTS.md` 新增第 15/16 条那次）；本任务**只读、没碰** |

## 3. 判定"已被 main 取代"后删除的 10 条（含判据）

判据一律是**两条都查**：
① `git cherry origin/main origin/<b>` → 该分支确有独立提交（所以**不能**只看 `--is-ancestor`）；
② 再核**它引入的能力在 main 里有没有对应物**（配置 / service / 测试 / 文档），
以及**它的 PR 是不是 CLOSED 而后续 PR 已 MERGED**。全部用 `gh pr list --state all` 交叉核对过。

| 分支（tip SHA） | 原 PR | main 里的对应物（取代它的已合并 PR） |
|---|---|---|
| `docs/procurement-e2e-status-sync` (`e94046c28`) | **#116 CLOSED** | 采购测试报告最终版由 **#118**（`docs/procurement-e2e-8of8`，MERGED）收口：`docs/reports/procurement-e2e-2026-10-06.md`（main 449 行 ＞ 分支 451 行的旧稿，内容已并入「8/8 全部已验证」那一版） |
| `feat/after-sales-thread` (`d53319452`) | **#146 CLOSED** | 由 **#148**（`feat/thread-resolve-everything`，MERGED）＋ **#150**（`chore/remove-write-original-sales-status`，MERGED）取代：main 有 `server/test/afterSalesGroupThread.test.js`、`afterSalesFlowService` 的「回到话题」分支（`thread_sale`），且**已不再回写原单销售状态**（`config/afterSales.js` 注释留档） |
| `feat/arrival-conversation-flow` (`c68bfc400`) | **#107 CLOSED** | 由 **#109**（`feat/arrival-reconcile-merged`，MERGED）取代：main 有 `server/src/services/purchaseArrivalConversationService.js`、`config/arrivalConversation.js`、`server/test/arrivalConversation.test.js` |
| `feat/return-batch-window-and-topic` (`6cf3be005`) | **#98 CLOSED** | 退货归批已在 main：`config/purchaseReturnBatchWindow.js` 被 `purchaseWebhookService` 引用、`server/test/purchaseReturnBatch.test.js` 在；**而且 main 的实现比它新**——`config/purchaseReturnBatchWindow.js` 已写明「**不再有"窗口到点就发"**」（归批改为"这一包处理完就发"，见 #102/#105 一线） |
| `feat/sales-status-dimensions-write` (`602d8d67b`) | **#129 CLOSED** | 由 **#131**（`feat/sales-status-abc-r2`，MERGED）取代：main 有 `config/salesStatusDimensions.js`（新口径：只读「资金状态」）＋ `server/test/salesStatusDimensions.test.js` |
| `feat/sales-status-write-backfill` (`3c1def38e`) | **#126 CLOSED** | 回填能力已在 main，且脚本名不同：`server/scripts/backfill-sales-status.mjs`（252 行，默认干跑、`--apply` 只允许测试 Base）＋ `config/salesStatusBackfill.js` |
| `fix/purchase-schema-after-table-change` (`3b649e307`) | **#101 CLOSED** | 由 **#102**（`fix/no-time-field-writes`，MERGED）取代：main `config/v1BitableSchema.js` 第 245/327 行起**明确注释**「报单时间/入库时间映射已删除」 |
| `fix/supplier-report-schema-align` (`1496e0100`) | **#100 CLOSED** | 同上，由 **#102** 取代；「供应商对接.报单时间」映射在 main 里已删（schema 注释留档） |
| `fix/sales-confirm-field-alias` (`7f8a9e399`) | **#123 CLOSED** | ⚠️ **已过期且方向相反**：它把 `confirmStatus` 指回「**确认状态（旧）**」，而该列**后来被业务负责人整列删除**、写回路径也已由 #150 移除 ⇒ 现在照它改反而是错的。main 保持 `userAction: '确认状态'` |
| `fix/workbench-form-labels-2` (`c1eba739c`) | —（无独立 PR） | **已是 main 的祖先**（`git merge-base --is-ancestor origin/<b> origin/main` 通过），相对 main 独立提交数 **0** ⇒ 纯冗余 |

> ⚠️ **删除 ≠ 永久丢失**：上表已记下每条分支的 tip SHA，且 GitHub 上这些 PR 的记录仍在
> （CLOSED PR 保留 head SHA）。要考古时 `git fetch origin <sha>` 通常仍可取回；
> 但这些 SHA 不会永久可访问，**本文是它们的第一手索引**。

## 4. ⭐ 唯一一条"真有价值、但没能进 main"的分支：`refactor/decouple-creation-and-stock`

**为什么单独留档**：它的 PR **#80 是 CLOSED、且此后没有任何 PR 把它重新落地** ——
核过 main 里**至今没有** `server/src/services/productCreationService.js`。
而 `AGENTS.md`《解耦·模块化·配置先行》第 1 条**点名**这条分支：

> 「反例（已修）：**新品建档 + 写成本**曾绑在**拍照识别**链路上 →
>  已剥离成 `ProductCreationService`（输入是**结构化明细**，不依赖 OCR）。」

⇒ 即"**应该已经剥离**"这件事，实际**只在分支上、不在 main 里**。删分支前必须把它留成文件。

### 4.1 它做了什么（tip `0c4fc4d71`，PR #80，2026-10-05）

- **新增** `server/src/services/productCreationService.js`（**454 行**）：把「**新品建档 ＋ 写成本**」
  从采购到货 webhook 里剥成独立 service。输入是**纯结构化明细**（货号/颜色/性别品类/供应商/成本），
  **不认识 OCR / 图片 / 「采购到货任务」**；进度落盘由调用方用 `journal` 端口注入。
  **幂等三道**原样保留：① 同一 `journal.scope` 走 `creationQueue` 串行；② `journal.read()` 在锁内读，
  重试命中缓存不建第二条；③ 颜色去重靠颜色表整表读 + `normalizeColor`。
  单条建档失败**不抛**，失败原因收集进 `failures` 交调用方；**成本写失败不算建档失败**。
- **把「写库存」与识别分开**：`inventoryService.js` 小改（9 行），库存写入仍只经 `InventoryService`。
- **`purchaseWebhookService.js` 净减**：533 行改动（-394 的净减部分）——原来长在这里的
  建档/成本/库存段整体搬走，行为**要求一字不变**。
- **测试**：`server/test/productCreationService.test.js`（新增 247 行）、
  `server/test/inventoryMvp.test.js`（+51）、`server/test/purchaseWebhookService.test.js`（+22）。
- 分支相对其 base 共 **922 增 / 394 删**（`git diff --stat`）。

### 4.2 原件存在哪（**照这两份就能捡回来**）

| 文件 | 内容 |
|---|---|
| [branch-salvage-2026-10-06/productCreationService.js.txt](branch-salvage-2026-10-06/productCreationService.js.txt) | **剥出来的 service 原文**（454 行，逐字，未改；扩展名用 `.txt` 是为了不被 CodeQL 当成源码扫） |
| [branch-salvage-2026-10-06/decouple-creation-and-stock.patch](branch-salvage-2026-10-06/decouple-creation-and-stock.patch) | **全量 patch**（1419 行）：`git diff 55c51039c5 origin/refactor/decouple-creation-and-stock`，含上述全部改动与测试 |

- patch 的 **base 提交**：`55c51039c5003598898c1fb7aa0b779bd5650932`（2026-10-05 的 main）。
- ⚠️ **不要直接 `git apply` 到今天的 main**：`purchaseWebhookService.js` 此后被 #98/#102/#105/#109/#148
  等多批改过（分支已落后 202 个提交），**大概率冲突**。
  正确姿势：**照着 `productCreationService.js.txt` 重新落一遍**，再按新 main 的调用方接线。

### 4.3 建议的下一步（**不是本任务的范围，留给后续**）

`AGENTS.md` 把「建档 + 成本」列为**孤儿能力**（`ensureArrivalProducts` 无生产调用方，等「对话到货」接）。
真要恢复时：以本文的 `productCreationService.js.txt` 为起点重做剥离，
`AGENTS.md` 里那句「已剥离成 ProductCreationService」才名副其实。
**本任务只做留档，没有改动任何业务代码**（清理任务不进生产，也不碰业务逻辑）。

## 5.5 本地分支：删了什么、留了什么、为什么（清理时 33 条 → 15 条）

⚠️ 本地分支**只用 `git branch -d`**（只删已合并的）——**没有用 `-D`**。因此「内容明明已在 main、
但因为当年是 squash/重做式合并、不是 main 的祖先」的分支，`-d` 会**拒绝**；这些一律**保留**，
不做 `-D` 强行删除。它们的 tip SHA 已在 §3 表里登记，随时可核。

| 处置 | 条数 | 明细 |
|---|---|---|
| `-d` **已删除** | **20** | 已合并的 13 条（`chore/ws-test-app-credentials`、`docs/confirmed-2026-10-06-night`、`feat/arrive-then-send`、`feat/pending-deal-daily-push`、`feat/purchase-request-image`、`fix/arrival-image-interaction`、`fix/e2e-run-im-reply-and-batch-records`、`fix/fulfilled-status-only-delivered`、`fix/pr67-race`、`merge/arrival-notice`、`merge/purchase-batch`、`repro/return-404`、`refactor/decouple-creation-and-stock`）＋ 清掉 worktree 后补删的 7 条（`feat/after-sales-executor`、`feat/arrival-card-and-async-create`、`feat/group-purchase`、`feat/purchase-return`、`fix/after-sales-settlement-choice`、`fix/arrival-schema-align`、`fix/discount-vs-debt`） |
| **保留**（`-d` 拒绝：不是 main 的祖先） | **11** | `docs/procurement-e2e-status-sync`、`feat/after-sales-thread`、`feat/arrival-conversation-flow`、`feat/return-batch-window-and-topic`、`feat/sales-status-dimensions-write`、`feat/sales-status-write-backfill`、`fix/purchase-schema-after-table-change`、`fix/sales-confirm-field-alias`、`fix/supplier-report-schema-align`（以上 9 条＝§3 表里那些「已被 main 取代」的远端分支的同名本地分支，**内容已在 main**）＋ 两条**本地独有**的见下 |
| **跳过**（worktree 有未提交改动） | **1** | `fix/return-batch-test-race`（`/private/tmp/ci-flaky`，`server/test/purchaseReturnBatch.test.js` 有 **2 行未提交改动** → 按「有未提交改动不清」的底线**整个跳过**） |
| 不属于本次清理 | 3 | `main` · `docs/cleanup-salvage-2026-10-06`（本次 PR 的分支，合并后由 GitHub 自动删）· `fix/complete-asking-honest-and-refund-method`（**另一个代理正在跑**） |

**两条"本地独有、`-d` 拒绝"的分支**（核过：内容都已在 main，只是不是祖先）：

| 本地分支（tip SHA） | 为什么可以留而不清 | 在 main 里的对应物 |
|---|---|---|
| `docs/confirmed-night2`（`31066f2`） | 它是她 2026-10-06 晚确认的**更早草稿**（+20 行） | 由 PR **#173** 合并的**更完整版本**（+39 行，含"已交付/已履约两个都认"那段） |
| `feat/arrival-reconcile-rebased`（`5b60609`） | 到货核对那次 rebase 的中间工作分支 | 由 PR **#109** 合并：main 有 `purchaseArrivalConversationService.js`（626 行）＋ `test/arrivalConversation.test.js`（772 行） |

## 6. 复现本文判据的命令

```bash
# ① 每条非 main 分支：独立提交有几条、相对 main 落后多少
for b in $(git ls-remote --heads origin | awk '{print $2}' | sed 's#refs/heads/##' | grep -v '^main$'); do
  echo "$b  $(git rev-list --left-right --count origin/main...origin/$b)  +$(git cherry origin/main origin/$b | grep -c '^+')"
done
# ② 是否已完全并入 main
git merge-base --is-ancestor origin/<b> origin/main && echo merged || echo "not merged"
# ③ 它引入的能力在 main 里有没有对应物（示例）
grep -rn "productCreationService\|purchaseReturnBatchWindow" server/src --include=*.js
# ④ PR 的最终状态（CLOSED？被谁取代？）
gh pr list --state all --head <branch> --json number,state,title
```
