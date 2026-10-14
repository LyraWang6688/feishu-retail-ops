# 独立复核报告 · 资金页前置（#516）＋ 特殊码折叠（#515 / #517）

> **复核人**：teammate `e2e-verifier`（固定角色 = 独立复核 + 挑假绿；**不是**复述作者结论）
> **版本**：worktree `.local/verify-1014` · 复核基线 **`5da504f` = origin/main**；**修 CI 时已 rebase 到 `b56c5a4`**（behind = 0）
> **时间**：2026-10-14 12:18–12:50（+8）；**CI 修复 + rebase 复跑：15:1x（+8）**
> **边界**：只写**测试 Base**（`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个）· 生产 Base 未碰 · 未部署 · 未用飞书 CLI · **未改产品代码**（发现只报不修 ✓）

---

## 0. 「无凭证 ⇒ 跳过」的正确做法（**PR #520 CI 红 → 已修**，2026-10-14 15:1x）

| | |
|---|---|
| **改前（CI 无 `.env`）** | `routes/scanPage.js` 的 require 链在**模块加载期**就构造 `V1BitableGateway`（`src/controllers/workbenchController.js:5` 是模块级 `new`）⇒ 缺 `LARK_AGENT_*` ⇒ **顶层抛** `新飞书应用必须同时配置 LARK_AGENT_APP_ID 和 LARK_AGENT_APP_SECRET` ⇒ **整份文件失败**（CI：`tests 1 / fail 1`、`testCodeFailure`）——**"没凭证就 skip" 根本轮不到** ✗ |
| **本机复现** | 把 `server/.env` 临时移走再跑：`EXIT=1 · tests 1 / pass 0 / fail 1`（逐字同上） |
| **改后** | require 之前补一对**假**凭证（只为让 require 通过）；用**注入前**取的 `HAS_REAL_APP_CREDS` 判"本机有没有真凭证" ⇒ 无 ⇒ `{ skip: '缺真实应用凭证（CI 没有 .env）⇒ 明确跳过，不算通过' }`，并在输出里打一行 **`[verify] 跳过：…`**（**看得见** ✓ 不静默 ✗） |
| **改后（本机模拟 CI）** | `EXIT=0 · tests 3 / skipped 3`，三条都带 `# 缺真实应用凭证…` 的 skip 原因 ✓ |
| **有凭证时（真跑真表）** | `EXIT=0 · tests 3 / pass 3`（零写入 / 并发幂等 / 400 / V5 判定**一条都没松** ✓）；rebase 到 `b56c5a4` 后**复跑仍 3/3** ✓（把 `server/.env` 放回即可复现） |
| **保留"能真红"** | `AC-PF*` 那批是别人的；**我这条的断言**：① 四表前后**逐字相等**（零写入）② 点按钮后 entry/detail/ledger 各 **+1**、单号唯一 ③ **并发**两枪各 +1、单号唯一 ④ 金额不齐 ⇒ **400 + 四表不动** ⑤ V5 读回「关联销售」cell 并**打出**指向判定 |

---

## 0b. 三件套（全量，`--test-force-exit`）

| 项 | 结果 |
|---|---|
| 命令 | `cd server && node --test --test-concurrency=1 --test-force-exit` |
| EXIT | **0**（**连跑两遍**都 0 —— push 前的门槛 ✓） |
| tests / pass / fail | **2338 / 2334 / 0**（另有 4 条 skip；rebase 到 `b56c5a4` 后复跑两遍同数） |

⚠️ **skip 的 4 条是什么**（"跳过必须说清"）：都是**环境类**跳过（本报告新增的 3 条在**没有**真凭证时明确 skip ⇒ **CI 就是这种情况**；另 1 条是既有的环境类跳过）。
**本机**（`.env` 在、凭证齐）⇒ 我新加的 3 条**真的跑**（本机 2338 含它们 ✓），在真测试 Base 上写 3 张单（约 2 分钟）；
**CI**（无凭证）⇒ 3 条明确 skip、不写任何表 ⇒ 套件照常绿（**见 §0 的做法与复现**）。

---

## 1. ① 资金页前置（#516）—— **真实测试 Base 端到端**（我自己的探针，不是复述作者 AC）

新增探针：`server/test/scanMoneyPageTwoStepVerify.test.js`（可跳过；走**项目代码**：真 `createScanPageRouter()` + 真 `V1BitableGateway` + 真 `createScanWriteService`，只写测试 Base）

跑法：`cd server && FEISHU_TARGET_ENV=test node --test --test-concurrency=1 --test-force-exit test/scanMoneyPageTwoStepVerify.test.js` ⇒ **EXIT 0 · 3/3 通过**

| # | 判据 | 实测（四表 = 主表/明细/收款/库存流水；**rebase 到 `b56c5a4` 后的那一遍**） | 结论 |
|---|---|---|---|
| V1 | 点「提交这一单」⇒ **零写入** | `440/474/455/629` → **`440/474/455/629`**（前后逐字相同）· HTTP **200** · 页面是资金页 ✓ | ✅ 过 |
| V2 | 点资金页按钮 ⇒ **才建单** | → `441/475/455/630`（主表 +1 · 明细 +1 · 流水 +1）· HTTP **200** · 单号 **`XSD-20261014-0018`** · 主表**只有 1 行**、明细**1 行**、**确认状态 = 已确认** ✓ | ✅ 过 |
| V3 | 同一把 `submitKey` **并发**两枪（`Promise.all`）⇒ 只写一次 | → `441/475/630` → **`442/476/631`**（各 +1）· 两枪都 200 · 单号 **`XSD-20261014-0019`** 在主表**只有 1 行** · 明细 1 行 ✓ | ✅ 过 |
| V4 | 金额不齐（部分付 + 空金额）⇒ **零写入** | 四表不动 · HTTP **400** · **仍渲染资金页**（带差额人话 ✓） | ✅ 过 |
| — | 红线：**不许直调 `salesOrderService._confirm`** | `grep -rn "_confirm" src/` ⇒ 扫码路由**零直调**（唯一一处在 `secondDeliveryService.js:218` 的**服务内部队列**，与本次批次无关） | ✅ 过 |

**⚠️ 观察（不是 bug，但要你/她拍板口径）**：她填 **未付** ⇒ **一条收款行都不写**（`payment 455 → 455`）。
这是**扫码页**的既有口径（"没填就留空 ⇒ 不写未收款"，`scanPageWrite.test.js:318`），**与群聊口径不同**
（群聊："她说了未付 ⇒ 写一条未收款"——那条口径在第三轮的对照表里被明确标过"**不是等价覆盖**"）。
⇒ 我**不改**，只报；若她要的是"说了未付就写一条"，这是**扫码页要补的那半**。
（另：`全付` 但**不带金额** ⇒ HTTP **400** 金额不齐 ⇒ 验证"收款按她填的写"必须**带金额**；资金页那一格默认是空的。）

**我踩到的坑（写进测试注释，省下一个人）**：
用**合成的 open_id**（`ou_fake_…`）建单会被飞书拒：`bitable.record.create_failed … UserFieldConvFail (Code: 1254066)`、HTTP **500**
——「录单人」是**人员字段**，必须是租户里的**真用户**。⇒ 探针改成从测试 Base 已有销售单里**取一个真 open_id**（只读）。
⭐ **顺带拿到一条有价值的负面证据**：那次 500 时**四张表一行都没写**，页面是「这一步没成功…请再点一次」（**不谎报成功** ✓）。

## 2. ⭐⭐ 头号发现（V5）：`库存流水.关联销售` 写进去的是【销售明细】的 id，而该列对端 = **销售主表**

**只读核对（测试 Base，与生产同形状）**：
```
库存流水.关联销售 = type 21 (DuplexLink) · 对端表 tblchUNgfH7o0ydr = 销售主表 · 反向字段「库存流水」· multiple=false
收款明细.关联销售单 = type 21 → 销售主表（同形，正确）
```
**真跑一单后读回该 cell**（我在 V2 那单上读的）：
```
[{"record_ids":["reczz28N9zvcpths"],"table_id":"tblchUNgfH7o0ydr","text_arr":[],"type":"text"}]
判定：{"指向主表": false, "指向明细": true, "cell为空": false}
```
⇒ 飞书**接受**了这个写入（不报错 ✓ 也不会红），但 `record_ids` 里装的是**销售明细行的 id**，
而字段的对端表是**销售主表** ⇒ **这条关联指向的记录不在对端表里**（她/工作台按主表筛这一单**关联不上**）。

**代码依据**：
- `src/services/inventoryService.js:1160` → `source_record_id: salesDetailRecordId`（= **明细** id）
- `src/services/inventoryService.js:1207` → `salesDetail: relation(operation.source_record_id)`（写进「关联销售」）
- 同一份值还用于**幂等回查**（`ledgerMatchesOperation({ sourceField: 'salesDetail' })`）⇒ **写与查同源**，
  所以**幂等本身是自洽的**（不会重复写），但**表上这一列指不到主表**。

**为什么难发现**：`v1BitableSchema` 里这个语义键叫 **`salesDetail`**（听起来就是"关联明细"），
而**真表字段名是「关联销售」、对端是主表** ⇒ **键名与真表对端不一致**，只读 schema 看不出来，必须读真字段 + 真跑一单。

**建议（我只报，归你/她定）**：二选一——
① 把该列的对端表**改成「销售明细」**（改表；与键名 `salesDetail` 一致）；或
② 把写入值换成**主表 record id**（改代码；`inventoryService` 里其实已预留 `ledgerLink`（只写不查的关联列）这个概念，注释见 `:158-169`）。
⚠️ 无论选哪条，都要**同一批**处理"历史流水行的这一列"（存量指不到 ⇒ 她按主表查会看不到那几笔的流水）。

---

## 3. ② 特殊码折叠（#515 销售 / #517 库存 + 补货）—— **过**

**作者测试**：`scanSpecialSizeFold` **6/6** · `scanSpecialSizeFoldMore` **8/8** · `sizeDisplayWiring` **4/4**（EXIT 均为 0）

**我自己动手核的（不只看他们的测试名）**：

| 判据 | 我怎么核的 | 结论 |
|---|---|---|
| 缺货**普通码**照旧在「预订」 | 读 `views/scanPageRealm.saleSizeGroups`：`count>0 ⇒ 现货`、否则 ⇒ 预订；普通码的展示范围由 `sizesForCategory` 给 | ✅ |
| 缺货**特殊码** ⇒ **默认收起**的折叠块 | `renderer` 用原生 `<details>/<summary>`，`AC-MF2` 断言**不带 `open`**；折叠块位置 `foldStart > tableEnd`（**在库存表之外** ✓） | ✅ |
| 按**男女各一块** | `AC-MF4`：女鞋页折叠块**不含 46**、男鞋页含 46/47/48 | ✅ |
| 补货页**恒 3 列** | `SCAN_PAGE.purchaseSizes.columnsPerRow = 3`（显式数字，无 `||` 兜底）→ 渲染出 `--size-cols: 3` → CSS `repeat(var(--size-cols, 3), minmax(0,1fr))` | ✅ |
| 🔴 **禁用 `auto-fit / auto-fill`** | `.purchase-size-grid` 规则里**没有**（全文件里只出现在注释"不用它 ✓"） | ✅ |
| 每格 **≥44px** | `--control-height: 44px` 定义在 `public/workbench/styles/tokens.css:96`；⭐ 我**真渲染了一次骨架页**验证它会**内联进 `:root`**（不是"注释里写了 44px"） | ✅ |
| 每格「**尺码 × 数量**」 | `renderer:1016` 的 `<span class="size-fold__times">×</span>` + `.size-fold__item{min-height:var(--control-height)}` | ✅ |
| **缺码仍默认勾** | `purchaseSizeLines`：`checked: behavior.checkMissingByDefault ? Boolean(row.missing) : false`（配置驱动，未改口径） | ✅ |
| 库存表**本身**逐字不变 | ⚠️ **弱一档**：`AC-MF2` 的实测断言是「折叠块在表外 + 缺货普通码仍在表内」，**不是**对 `<table>` 子串做**逐字 diff** ⇒ 表内文案若被改，这条**不会红**（属"护栏强度"问题，不是假绿） | ⚠️ 建议加一条 diff 断言 |

---

## 4. 我**没找到**的假绿 + 我试过的角度（诚实清单）

**没找到**（下面每条都是我实际跑/读过的，不是"看起来没问题"）：
- 资金页前置的"零写入"只有**行为**能证⇒ 我在真表上**数了四张表**（前后逐字相等）✓
- 幂等没被拆：**并发**两枪也只用一把键、只建一张单 ✓（不是"串行两次"这种弱验证）
- 金额不齐：**400 + 零写入**（不是"回句话但已经写了"）✓
- 折叠块：**默认收起**（无 `open`）、**在库存表之外**、**男女各一块** ✓
- `auto-fit/auto-fill`、44px、3 列、`×`：都是**真规则/真渲染值**，不是注释 ✓

**我试过但没能证伪的角度**（如果你们想继续挖，从这儿下手）：
1. 资金页的"她填的**全付金额**要照原样落表"——我**没验成**：资金页那一格默认空，不带金额直接 400；要验得先在销售页填 `paid_amount` 再让资金页带出来（需要她的真机语义）。
2. "刷新 ⇒ 仍停在资金页"我只核了**源码路径**（`paymentStep:'pending'` + GET 分支），**没在真 Base 上刷一次**（作者的 AC-PF4 是假写的 store）。
3. 折叠块的**视觉**（真的收起了吗、手机上点得到吗）⇒ **只能人工**（见 §5）。
4. 生产 Base 的字段结构 ⇒ **本机做不到**（无生产凭证，AGENTS 第 8 条）；生产上请跑一次只读的 `appTableField.list` 对一遍 `关联销售` 的对端。

## 5. 🔴 只能人工确认的项（请转给她）

1. **资金页那一步的手感**：她说"点了提交这一单只到资金页"，请她在**手机上**真点一遍——按钮在哪儿、要不要滚动、余额/欠款那句看不看得懂。
2. **特殊码折叠块**：她要的是"**有就显示、没有不收起**"吗？现在是"**缺货的特殊码收进折叠块（默认收起）**"——**她打开折叠块才看得到**；请她确认这正是她要的（不是"干脆别显示"）。
3. **44px 命中区**在真机上点得准吗（她"只在手机上用"）。
4. **「关联销售」那一列**：她按主表查某笔单的库存流水时，**现在关联不上**（§2）⇒ 这是她能不能看见"这一单的流水"的关键，请她拍板走 ① 还是 ②。

---

## 6. 附：本次新增/改动的文件（只含测试与文档）

| 文件 | 说明 |
|---|---|
| `server/test/scanMoneyPageTwoStepVerify.test.js` | 新增：资金页前置的**真实测试 Base**端到端探针（V1–V5；无凭证⇒明确 skip） |
| `docs/verify-2026-10-14-money-page-and-fold.md` | 本报告 |

⚠️ 我**没改**任何产品代码；worktree 内 `git status` 只有这两个文件（`.env` / `data/` 已 gitignore）。
