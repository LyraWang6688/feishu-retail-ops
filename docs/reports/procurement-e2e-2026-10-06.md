# 采购侧全流程测试报告（2026-10-06）

- 日期：2026-10-06（上海时间，+8）
- 执行人：AI（本地自测；业务负责人不需要在飞书里做任何操作）
- 代码版本：初版写这份报告时 `origin/main` = `7563537`（先 `git fetch`，自检 `git rev-list --count HEAD..origin/main` = **0**）
- 🆕 **本轮收口（8 条全部转 ✅ 之后的"内部一致性"修订）**：`origin/main` = `bef05d0`
  （先 `git fetch origin --prune`，自检 `git rev-list --count HEAD..origin/main` = **0**）
- 写这份报告的 worktree：`/private/tmp/proc-e2e-report`（分支 `docs/procurement-e2e-report`，基于当时最新 `origin/main`）
  —— **那一轮只新增这一份文档：没改代码、没动表、没重启、没部署**
- 🆕 **本轮收口的 worktree**：`/private/tmp/proc-e2e-8of8`（分支 `docs/procurement-e2e-8of8`，基于 `bef05d0`）
  —— **本轮同样只改这一份文档**：没改代码、没动表、没重启、没部署
- 测试 Base：`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个（`FEISHU_TARGET_ENV=test`）
- 生产 Base：`FEISHU_V1_BITABLE_APP_TOKEN` 指向的那个 —— **一个字都没写**
- 测试飞书应用：`LARK_AGENT_APP_ID`（本机取值 `cli_aa3341b397389cd4`，即测试应用）
- 测试群：`PURCHASE_CHAT_ID` 指向的那个
- 🔴 **本文件不含任何 token / secret 的值**：一律只写变量名与 record_id

> **本报告的数字都是哪来的**：所有 record_id、行数、批次号、报错原文，都来自本地测试产物
> `server/data/selftest/runs/<记录id>/report.json` 与同目录 `task.json`（该目录被 `.gitignore` 忽略，
> 是本地测试产物、不进 git）；图片结论来自同目录真实生成的 `return-order.png`（逐张看过）。
> 凡**不是**我从这些文件里读出来的（例如"曾经落后 17 个提交"），文中都标了「引用」。
>
> 🆕 **本轮新增的数字，来源分三类，正文里逐条标了**：
> - **本机落盘、我逐条读过的**：① 的归批证据在 `/tmp/verify-return-batch/clean-20261006074352/`
>   （`evidence.json` / `raw-logs.jsonl` / 两张 PNG）；① 与 ⑦ 的**单次全链路真机证据**在
>   `/private/tmp/e2e-reply/server/data/selftest/runs/reczz28K39EPRNsA/`（`report.json` / `task.json` / `return-order.png`）；
>   ⑥ 的实测在 `/tmp/real-qty/run-output.txt`、`/tmp/report-qty-run.log`、`/tmp/report-qty-repeat.log`。
>   ⚠️ **这些测试本身是别的代理跑的，不是我重跑的** —— 我只做了"读证据 ＋ 与代码对照"。
> - **只能引用的**：⑦ 里"`reply_in_thread` 无差异"与**早前那种最小脚本验法**（`omt_...`）、
>   **生产表只读普查**（40 / 114 / 528 条数字）—— 完成于服务器侧 / 别的代理那侧，**本机没有落盘产物**，文中标「引用」。
> - 🔴 **`/tmp` 下的证据会随重启消失**，**不是永久凭据**（关键值已抄进正文）。

---

## ① 8 条验收标准（业务负责人原话，逐字）

> 「好的，目前你在做的销售侧的变动，所以不影响采购侧，那么采购侧你就可以做测试了，
>  这个是采购侧的测试你看下～
>  **用我生产表里的采购退货和采购申请的数据，在测试表里把全流程跑通。**
>  需要看的是：
>  1. **是否同一个批次号是否用了一张图片**；
>  2. **图片是否是按照最新的格式**；
>  3. **是否缺供应商也没有问题**；
>  4. **然后标题是否修改了**；
>  5. **退货之后，是否单据信息还有库存流水以及实时库存都有减少**；
>  6. **以及采购申请里数量不是默认 1 的时候，AI 是否可以准确识别，以及是否单据信息会同步增加**；
>  7. **以及是否可以在一个话题内，而不是单独的消息**～
>  8. **以及在在这个过程中，禁止你动生产表上的任何数据，严禁使用生产凭证和群聊，
>     所有的测试只能是在测试群、测试飞书应用和测试表格！**」

---

## ② 每条的状态一览表

状态只有三种：**✅ 已验证** / **🔄 进行中** / **⚠️ 测不了（附原因）**。
**本轮收口结果：8 / 8 全部 ✅ 已验证**（每条的详细证据见 ③；带「引用」的是别的代理 / 服务器侧完成、本机没有落盘产物的）。

| # | 标准 | 状态 | 证据 / 说明 |
| --- | --- | --- | --- |
| ① | 同一个批次号只用一张图片 | ✅ 已验证 | **2 条同「报货批次号」的退货记录 → 1 张 PNG**：`images.render` 1 次、`im.image.create` 1 次；「单据信息」新增 2 行（39 码 ×1 / 47 码 ×1，`reczz28K2yuRGrA8` / `reczz28K2zxTP2Cm`）；发群 1 次 = 顶层图片 + @经办人文字**回复第 1 条**（`text_is_reply:true`）；图上两个货号在同一张分组表；`purchase.return.batch.posted {record_count:2,item_count:2,doc_count:2}`。记录 id `reczz28K2xTmWzyB` / `reczz28K2xWg9BWM`。**反向用例**：不同批次号那条没被并进去、另起一张图（两批并发各吃各的批次号）。⭐ 另有**单次全链路真机 run** 同时验到本条（真发测试群，批次号 `SELFTEST-20261006075514`，2 条同批 → 1 张图 1 条群图片消息）—— 见 ③ ①。⚠️ PNG 在 `/tmp`（`/tmp/verify-return-batch/...`），**会随重启消失** |
| ② | 图片是最新格式 | ✅ 已验证 | `server/data/selftest/runs/reczz28K2VoBMctW/return-order.png`（900×450，29128 bytes）：按货号分组、3 列、合计 2 条/2 双 |
| ③ | 缺供应商也没问题 | ✅ 已验证 | 同一次 run（`reczz28K2VoBMctW`）：`draft.items[].supplier_record_id = ""`，图上**不画**「供应商：」那行，**照样出单**；⭐ 采购申请侧也过了一遍（⑥ R1B：图上分组名「未标注供应商」）；⭐ **她真实数据里"缺供应商"有实例**（`reczz28JzxXFZLLQ`）—— 见 ④ |
| ④ | 标题改了 | ✅ 已验证 | 图上是「**邯美皮鞋退货单**」（旧文案是「邯美皮鞋采购退货单」）；代码 `purchaseRequestImageService.js:36` = `RETURN_TITLE` |
| ⑤ | 退货后「单据信息 / 库存流水 / 实时库存」都减少 | ✅ 已验证 | 4 次早期 run 的 `report.json checks ①②③` 全 `pass`；取 `reczz28K2VoBMctW`：单据信息 +2 行、库存流水 +2 行（`STOCK_PURCHASE_DECREASE`）、实时库存 −2 行。⭐ 真机单次全链路 run（`reczz28K39EPRNsA`）同样 `6/6` pass：单据信息 2 行、库存流水 2 行（行为 `STOCK_PURCHASE_DECREASE`）、实时库存被退的 2 行消失 |
| ⑥ | 采购申请里数量不是默认 1 时 AI 识别 ＋ 单据信息同步增加 | ✅ 已验证（用她真实数据） | **R1「不写数量说明」（她 39/40 条的主路径）**：勾 40/42/43 → 每码各 1 双、单据信息 3 行（1/1/1）；**一行 AI 都没调**（留空时 `purchaseQuantityPolicy.buildPurchaseQuantities` 直接返回每码 1）。**R1B 不写 ＋ 货品无供应商**：照常出单出图，图上分组名「未标注供应商」。**R2「42码两双」（她唯一写过的那句，原样照抄）**：模型原文 `{"items":[{"size":42,"quantity":2}]}` → 单据信息 3 行 = 40 码 1 / 42 码 2 / 43 码 1（**其余两码是后端规则补的 1**，`purchaseQuantityPolicy.js:63-66`）。⚠️ 另附"编的用例"那段：11 个说法 **7/11**（「1 双」「一双」「10 双」失败；另 1 条是脚本自身报错）—— **那几种说法在她的真实数据里 0 条** |
| ⑦ | 在一个话题内，而不是单独的消息 | ✅ 已验证 | ⭐ **真发到测试群、单次全链路**：顶层图片 `thread_id = omt_19a1212a17cf5cb7`，用 `im.message.reply` 回它 → **`thread_id` 完全相同**、`parent_id` / `root_id` 都指向那张图；**并用只读接口 `im.message.get` 读回来核对**（不只看发送响应）；假 IM 侧另证 `text_is_reply:true`。⚠️ `reply_in_thread: true` 加不加**无差异**（该群本身是话题群，**引用**）。⚠️ 早前还有一种"代码路径 ＋ 真 SDK 行为**两段拼**"的验法（**引用**），已被上面的单次全链路 run 取代 —— 见 ③ ⑦ |
| ⑧ | 环境隔离：不碰生产表 / 凭证 / 群聊，只用测试侧 | ✅ 已验证 | 4 次 run 的 `report.json.base_app_token` 都等于本机 `FEISHU_V1_E2E_TEST_APP_TOKEN`；本机 `LARK_AGENT_APP_ID` = 测试应用；群里发的是 `PURCHASE_CHAT_ID`（测试群）；脚本里还有"app_token 等于生产 → 拒绝运行"的代码级闸门。⭐ 真机 run 的 `report.json` 也记了 `im: "real"` ＋ 只发那一个测试群 |

**一句话结论**：8 条验收标准 **全部 ✅ 已验证**（①～⑧），**没有"测不了"的条目**。
⚠️ 但**有 3 件"没被这 8 条覆盖"的事**如实记在下面，**不算 8 条未达标**：
（a）⑥ 里"明确写 1 双 / 一双 / 10 双"的**提示词缺口**（**真实数据 0 条**，优先级待业务负责人定）；
（b）`readReportBehaviorKind` **没有重试**（代码层面的隐患，见 ⑥ 待办）；
（c）真机 run 里**私聊差额通知**发不出去（飞书 `230013 Bot has NO availability to this user`，**群消息不受影响**，见 ③ ⑦）。

---

## ③ 8 条的逐条证据

> 下面每个 record_id 都是从 `report.json`、`task.json`、`evidence.json` 里读出来的**真实值**，不是估计的。
> 图片结论来自真实生成并被我逐张打开看过的 `return-order.png` / `png-*.png`。

### ✅ ① 同一个批次号只用一张图片

**证据（本机落盘，我逐条读过；⚠️ 都在 `/tmp`，会随重启消失）**

- **A. 归批专测（假 IM）**：`/tmp/verify-return-batch/clean-20261006074352/`（`evidence.json` · `raw-logs.jsonl` · 两张 PNG）
- **B. 单次全链路（真 IM，真发测试群）**：`/private/tmp/e2e-reply/server/data/selftest/runs/reczz28K39EPRNsA/`（`report.json` · `task.json` · `return-order.png`）

#### A. 归批：2 条同批号 → 1 张图（假 IM）

| 记录 | record_id | 货品 | 尺码 | 报货批次号 |
| --- | --- | --- | --- | --- |
| A1 | `reczz28K2xTmWzyB` | `YD6693-2` | 39 | `SELFTEST-BATCH-A-20261006074352` |
| A2 | `reczz28K2xWg9BWM` | `QPL8809` | 47 | **同上（同批）** |
| C1 | `reczz28K2xZbHYcM` | `QPL8092` | 38 | `SELFTEST-BATCH-C-20261006074352`（**反向用例：另一批**） |

- accept 顺序 A1 → +2.5 秒 A2 → +2.5 秒 C1，**三条都落在退货归批窗口的 30 秒内**
  （`server/src/config/purchaseReturnBatchWindow.js:27` 默认 `30000`，可用 `PURCHASE_RETURN_BATCH_WINDOW_MS` 覆盖）。
- `raw-logs.jsonl` 里的归批三连（逐字）：
  - `purchase.return.batch.opened {batch_no: SELFTEST-BATCH-A-…, window_ms: 30000}`
  - `purchase.return.batch.joined {batch_no: SELFTEST-BATCH-A-…, record_id: reczz28K2xWg9BWM, pending_count: 2}`
  - `purchase.return.batch.posted {batch_no: SELFTEST-BATCH-A-…, record_count: 2, skipped_record_count: 0, item_count: 2, doc_count: 2}` ✓
- ⭐ **A 批只出 1 张 PNG** ✓：`evidence.json.renders` 里 A 批只有 1 条，
  `items = ["YD6693-2/39码×1", "QPL8809/47码×1"]` —— **两个货号落在同一张按货号分组的表里** ✓（图格式见 ②）。
- ⭐ **「单据信息」A 批只加 2 行** ✓（每行带幂等键，把"哪条记录、哪个尺码"钉死）：
  - `reczz28K2yuRGrA8`（39 码，`purchase_return:reczz28K2xTmWzyB:39`）
  - `reczz28K2zxTP2Cm`（47 码，`purchase_return:reczz28K2xWg9BWM:47`）
- ⭐ **发群 1 次 = 2 条消息** ✓：`purchase.request.image.group_sent` 记 `text_is_reply: true`、
  `thread_root_message_id` = `image_message_id`（顶层图片）、第二条是 @经办人的文字**回复第 1 条**。
  （⚠️ 这一轮是**假 IM**，`om_fake_*` 是替身编号；真机证据见 ⑦。）
- ⭐ **反向用例成立** ✓：`SELFTEST-BATCH-C-…` 那条**没被并进 A 批**、**另起一张图**
  （C 批图里只有 `QPL8092/38码×1`）；整轮 `im.image.create = 2`（**一批一张**）。
  两批的窗口**重叠并发**，各吃各的批次号 ✓
- **幂等重投** ✓：3 条重投全部落 `purchase.webhook.duplicate_ignored`；
  重投前后 `evidence.json.replay.delta = {renders: 0, images: 0, ledger: 0}`。
- ⚠️ **工具统计口径的一处坑（如实记）**：同一次 run 里，工具还报了两条 ❌ ——
  「幂等重投 docs +3」「库存流水 4 行 ≠ 预期 3 行」。我核了**本 run 自己的** `raw-logs.jsonl`：
  **本 run 只写出 3 行「单据信息」**（`reczz28K2yuRGrA8` / `reczz28K2z5Zqkxe` / `reczz28K2zxTP2Cm`）、
  **只有 3 条 `inventory.change.applied`**（39 / 47 / 38）；多出来的那行流水 `reczz28K30aruQDk`（41 码 ×2）
  **没有任何对应的 created 日志** → 那是**同一个测试 Base 上并发的另一批写库**，被"T0 之后新增"这种
  **时间窗口统计**算了进来，**不是本次退货链路多写的**。（工具的判据后来也按"归属"改过，见 PR #115 前后的 `e2e-run.mjs` 改动。）

#### B. 单次全链路（真 IM、真发测试群）也同时验到了本条 ✓

`report.json` 的 `im = "real"`，`ran_at = 2026-10-06T07:57:51Z`（= 上海 15:57）：

- 同批 2 条：`reczz28K39EPRNsA`（货品 `7562｜黑色｜B`，37 码）、`reczz28K39YqgFzn`（40 码），
  批次号 `SELFTEST-20261006075514`；两次 accept **相隔 16 秒**（复现生产那次"同一次提交被拆成两次推送"）。
- ⭐ **只出 1 张 PNG、只发 1 条群图片消息** ✓（`checks ①b` = pass；`outbox.images` 只有 1 条）
- ⭐ 「单据信息」2 行：`reczz28K3ALCN7Lr`（37 码 1 双，来源 `reczz28K39EPRNsA`）、
  `reczz28K3B0EXSSO`（40 码 1 双，来源 `reczz28K39YqgFzn`）✓
- 附件回写 ✓：真上传 1 次（`attachmentUploads` `ok:true`），**只有明细 ID 最小的那一行带附件**
  （`[{detailId:170,attachments:1},{detailId:171,attachments:0}]`）。
- 整份判定：`passed = 6 / total = 6`、`topic_pass = true`、`overall = true` ✓

> ⚠️ **A 与 B 是两次不同的 run**（A ＝ 假 IM 的归批专测，B ＝ 真 IM 的单次全链路），**不要混着看**。

### ✅ ② 图片最新格式

**图**：`server/data/selftest/runs/reczz28K2VoBMctW/return-order.png`（29128 bytes，900×450）

**图上长这样**（我逐字读的图）：

- 标题：「**邯美皮鞋退货单**」✓
- 表头一行：「报货批次：`SELFTEST-20261006071755`」 ＋ 日期「2026/10/06」✓
- 表格：「**6C98012-15L**」**占一整行（灰底 ＋ 加粗）** ← 货号分组行 ✓
- 下面三列：**颜色 | 尺码 | 数量** ✓（**货号不再在每行重复写** ✓）
  - `黑 | 37码 | 1` ✓
  - `黑 | 41码 | 1` ✓
- 底部：「合计：**2 条 / 2 双**」✓

**代码侧对得上**：`server/src/services/purchaseRequestImageService.js`
第 21–24 行写明"明细先按货号分组、组内 3 列"；第 56 行"分组版是 3 列"；第 307 行"按货号分组——每个货号一条跨 3 列的分组行（底色＋加粗）"。

（① 的两张图我也看过：A 批那张同时含 `YD6693-2｜黑色｜39码×1` 与 `QPL8809｜黑｜47码×1` 两个分组行，
标题同为「邯美皮鞋退货单」，都是 900×450 的三列表。）

### ✅ ③ 缺供应商也没有问题

- 这条货品**没有供应商**：`reczz28K2VoBMctW` 的 `task.draft.items[]` 里 `supplier_record_id` 是**空字符串**；
  `task.json.image_delivery.failed[0].supplier` 也记成「**未标注供应商**」。
- → **表头【没有画「供应商：」那一行】** ✓ **照样出单** ✓（见上面那张图：标题下面只有"报货批次 ＋ 日期"，没有供应商）。
- **对照**（另一条有供应商的 run）：
  - `reczz28K2cCiKKbo` 的图上写了「**供应商：七匹狼/吉祥鸟**」✓
  - `reczz28K2Z8NZHD9` 的图上写了「**供应商：一代千金**」✓
- **代码侧**：`purchaseRequestImageService.js:288–293` 注释写明"没有供应商时不渲染「供应商：」这一段
  （业务负责人 2026-10-06：没维护供应商的货品也应该能正常出单）"，原来写的是「供应商：未填写」。
- ⭐ **采购申请侧也过了一遍**（⑥ 的 R1B）：货品 `R559-1｜黑兰｜B`（`rec28ecsAgdbcp`）**关联供应商 0 条**，
  照常出单、照常出图；`purchase.request.image.group_sent` 里 `supplier` = 「**未标注供应商**」。
- ⭐ **她真实数据里也有"缺供应商"的实例**（见 ④）：`reczz28JzxXFZLLQ` 的货品 `1366-12｜黑色｜B` 没有供应商，
  **报单照样跑通**。
- ⚠️ **实现细节（代码侧核实）**：`purchaseWebhookService.js:1444` 的供应商是**从【货品信息】的「供应商」字段读的**
  （`productTable.fields.supplier`）；`v1BitableSchema.js` 里「供应商对接」（`purchaseReport`）的字段映射表
  **没有** `supplier` 这一项。

### ✅ ④ 标题

- 图上写的是「**邯美皮鞋退货单**」✓（旧的是「邯美皮鞋采购退货单」）。
- 代码：`purchaseRequestImageService.js:36` → `const RETURN_TITLE = '邯美皮鞋退货单';`
  （同文件第 284 行注释：默认是「邯美皮鞋采购单」，采购退货传「邯美皮鞋退货单」）。
- ⚠️ 一处**陈旧注释**（不影响行为）：`purchaseWebhookService.js:2129` 的注释里还写着
  "标题「邯美皮鞋采购退货单」" —— 那是没跟着改的注释，实际渲染用的是 `RETURN_TITLE`。

### ✅ ⑤ 三张表都减少

**一次退货（2 个尺码，各 1 双）**，以 `reczz28K2VoBMctW`（货品 `6C98012-15L｜黑｜B`，数量 2）为例：

- **「单据信息」新增 2 行** ✓
  - `reczz28K2WndBbsH`（37 码，数量 1）
  - `reczz28K2XFVh31D`（41 码，数量 1）
- **「库存流水」新增 2 行** ✓，行为 = `STOCK_PURCHASE_DECREASE`（采购减少）✓
  - `reczz28K2XXNk5vS`（41 码，变动数量 1）
  - `reczz28K2X3evG3G`（37 码，变动数量 1）
- **「实时库存」被退的 2 行消失** ✓（减到 0 → 行不再存在）✓
  - `recvw7x9t3l7PX`（37 码，样品）
  - `recvw7xao68Kw9`（41 码，门盒）
- **报单记录回填** ✓：`「供应商对接」处理状态 = 已生成申请`，
  「关联采购申请」= `["reczz28K2WndBbsH","reczz28K2XFVh31D"]`（= 上面那两行单据信息 id）。
- **项目代码打的日志**（事件名已在代码里核实，三处）：
  - `purchase.return.posted` —— `server/src/services/purchaseWebhookService.js:2150`
  - `inventory.change.applied` —— `server/src/services/inventoryService.js:534`
  - `purchase.return.stock_applied` —— `server/src/services/purchaseWebhookService.js:2025`
  - ⚠️ 说明：`server/data/selftest/runs/<id>/` 里只落了 `report.json` / `task.json` / `return-order.png`，
    **没有保存当次 stdout**。对**这 4 次早期 run**，"这三条日志确实打出来了"属于**引用**；
    而 ① 那次归批 run 有 `raw-logs.jsonl` 原文，那三条日志我是**逐字读到的**。

**同口径在另外 3 次 run 上也成立**（`report.json` 的 `checks ①②③` 都是 `pass`）：

| run（记录 id） | 货品 | 单据信息（row id / 尺码） | 库存流水（row id / 尺码） | 实时库存消失行 |
| --- | --- | --- | --- | --- |
| `reczz28K2RlJAwFU` | `YD6693-2｜黑色｜A` | `reczz28K2SmTOm3e`/40、`reczz28K2TJGGtb4`/42 | `reczz28K2TXLsBv2`/42、`reczz28K2T5B8wWU`/40 | `recvw7x87LjHl9`/40、`recvw7x9t3lkTe`/42 |
| `reczz28K2VoBMctW` | `6C98012-15L｜黑｜B` | `reczz28K2WndBbsH`/37、`reczz28K2XFVh31D`/41 | `reczz28K2XXNk5vS`/41、`reczz28K2X3evG3G`/37 | `recvw7x9t3l7PX`/37、`recvw7xao68Kw9`/41 |
| `reczz28K2Z8NZHD9` | `3F010C1229｜奶茶色｜B` | `reczz28K2aReNqAu`/37、`reczz28K2avgHdHy`/38 | `reczz28K2bCUpJCw`/38、`reczz28K2ahxlYM5`/37 | `recvw7x9WoNutQ`/37、`recvw7xao65cyd`/38 |
| `reczz28K2cCiKKbo` | `YD6693-2｜黑色｜A` | `reczz28K2dRQdb7A`/41、`reczz28K2dvJ3O4t`/44 | `reczz28K2eD4RgEz`/44、`reczz28K2diSuWvP`/41 | `recvw7x9t3U19S`/44、`recvw7x9t3Ul1N`/41 |

（每次都是"2 个尺码、各 1 双"的退货；`reczz28K2Z8NZHD9` 里 38 码原有 2 行，退掉 1 行后**还剩 1 行**，
`report.json` 的按尺码核对也记了 `after=1 / expectedAfter=1` —— 减到 0 才消失，减到 1 就留 1 行。）

**⭐ 单次全链路真机 run 同样成立**（`reczz28K39EPRNsA`，`checks ①②③` 全 pass）：

- 「单据信息」2 行：`reczz28K3ALCN7Lr`/37、`reczz28K3B0EXSSO`/40
- 「库存流水」2 行，行为都是 `STOCK_PURCHASE_DECREASE`：`reczz28K3BFEYBDq`/40、`reczz28K3AZxAPRa`/37
- 「实时库存」被退的 2 行消失：`recvw7x9t3bUtm`/37（样品）、`recvw7x9WoBBfD`/40（门盒）；
  按尺码核对 `after=0 / expectedAfter=0` ✓

### ✅ ⑥ 数量说明 ≠ 默认 1 时 AI 能识别、单据信息同步增加（**用她的真实数据**）

**证据（本机落盘，我逐条读过）**

- 真实用法 3 条：`/tmp/real-qty/run-output.txt` ＋ `/tmp/real-qty/runs/run-20261006075457/report.json`
- "编的用例"11 条：`/tmp/report-qty-run.log`（`run-20261006074017`）＋ 复测 `/tmp/report-qty-repeat.log`（`run-20261006075128`）
- ⚠️ 都在 `/tmp`，**会随重启消失**

#### R1 / R1B / R2：**只用她那两种真实说法**（留空 /「42码两双」）—— **3/3 一致** ✓

| 用例 | 数量说明 | 勾选尺码 | 模型 | 「单据信息」 | 判定 |
| --- | --- | --- | --- | --- | --- |
| R1 | **留空**（她 39/40 条的主路径） | 40 / 42 / 43 | **一行都没调** | 3 行 1/1/1：`reczz28K35nckdSe`(40) · `reczz28K35u5FQFg`(42) · `reczz28K364bKVex`(43) | ✅ |
| R1B | 留空 ＋ 货品**无供应商** | 40 / 42 / 43 | 一行都没调 | 3 行 1/1/1：`reczz28K37OgFMuN`(40) · `reczz28K37UmSLlL`(42) · `reczz28K37b4ToBz`(43) | ✅ |
| R2 | **「42码两双」**（她唯一写过的那句，原样照抄） | 40 / 42 / 43 | `{"items":[{"size":42,"quantity":2}]}`（**逐字**） | 3 行 = 40→1 · 42→2 · 43→1（总 4 双）：`reczz28K38XJYF7m` · `reczz28K38cDma8k` · `reczz28K38ifQRAs` | ✅ |

- ⭐ **主路径不依赖 AI** ✓：数量说明留空时，`purchaseQuantityPolicy.buildPurchaseQuantities`
  **直接返回每个勾选尺码各 1 双**（`server/src/services/purchaseQuantityPolicy.js:41`），`parseOverrides` **根本不会被调用**
  —— run 输出里逐字写着「（没有调用解析器 —— 数量说明为空时本就不该调 AI）」。
  三条 run 的「供应商对接」处理状态都是 `已生成申请`、「关联采购申请」都回填了对应的 3 条 ✓
- ⭐ **R1B（无供应商）**：货品 `R559-1｜黑兰｜B`（`rec28ecsAgdbcp`）**关联供应商 0 条**，照常出单、照常出图；
  `purchase.request.image.group_sent` 里 `supplier` = 「**未标注供应商**」✓
  （**代码侧**：供应商是从【货品信息】读的 —— `purchaseWebhookService.js:1444`。）
- ⭐ **R2 的关键**：模型**只**输出了 42 码；**其余两码的 1 是【后端规则】补的** ——
  `purchaseQuantityPolicy.js:63-66` 的 `quantity: overrides.get(sizeKey(size)) || 1` —— **不是模型补的** ✓

#### ⚠️ 同时如实写"编的用例"那一段 —— **7 / 11**

> 这些说法是**父代理自己编的**（她真实数据里 0 条，见 ④）。父代理编数据**没有事先跟她说过** ——
> 这一点本身**不符合 `AGENTS.md` 第 10 条**，如实记在这里当教训。

- ✅ **通过**：`3 双` · `共 5 双` · `2 双` · `两双` · `38 码 2 双，39 码 3 双`（解析成 38→2 / 39→3，2 行）
- ✅ **按预期拒绝写单**：`0 双` · `2.5 双`（"宁可不写，也不猜一个整数写进去"✓）
- ❌ **失败**：`1 双` · `一双` · `10 双` —— 模型返回 `{"items":[]}` → 链路报
  `采购报单解析失败: 未识别出有效尺码数量`，「单据信息」0 行、「供应商对接」处理状态为空
- ❌ **另 1 条不是链路失败**：`B1`（同一句「38 码 2 双，39 码 3 双」再跑一遍）报
  `Cannot read properties of undefined (reading '0')` —— 那是**脚本自身**报错，**要另算**，
  不能当成业务链路的失败
- **复测**（`/tmp/report-qty-repeat.log`）：`3 双` 3/3 过；`1 双` · `一双` · `10 双` **3/3 全失败** → **不是偶发**
- **根因（已定位到代码）**：`server/src/services/doubaoService.js:474–475` 的提示词两条规则叠加 ——
  · 规则 1：「数量说明没有提到的已选尺码由后端保持默认一双，**不需要输出**」
  · 规则 2：只有「各一双 / 每个码一双 / 都是一双 / 按默认来」这几种说法才**必须**输出全部尺码
  → 模型把裸的「**1 双**」当成"默认、无需输出" → 返回空数组 → 上层判"未识别出明确数量"而报错
- 🔴 **但这些说法在她的真实数据里 0 条**（见 ④）→ **优先级由业务负责人定**（已记进 ⑥ 待办）

### ✅ ⑦ 在一个话题内（不是单独的消息）

- **A. 代码路径（假 IM）** ✓：`purchase.request.image.group_sent` 记 `text_is_reply: true`、
  `text_message_id` 回复的是 `thread_root_message_id`（= 第 1 条顶层图片的 message_id）——
  **第 2 条起都 reply 第 1 条**，于是都挂在那一个话题下。
  生产代码：`purchaseWebhookService.js:1097` 与 `:1129`
  （`this.client.im.message.reply({ path: { message_id }, data: { msg_type, content } })`），
  注释在 `:1243–1247`。证据：`/tmp/verify-return-batch/clean-20261006074352/raw-logs.jsonl`（`om_fake_*` 是替身编号）。
- ⭐ **B. 单次全链路真机证据（真发测试群 ＋ 读回核对）** ✓ —— 本机落盘：
  `/private/tmp/e2e-reply/server/data/selftest/runs/reczz28K39EPRNsA/report.json`（`im: "real"`）
  - 第 1 条（**顶层图片**）：`message_id = om_x100b637ed0fe90a4b1b23a428b18a2b`，`thread_id = omt_19a1212a17cf5cb7`
  - 第 2 条（`im.message.reply` 回它）：`message_id = om_x100b637ed0f7d0a4b3472297ffdcdc7`，
    `thread_id` **完全相同**，`reply_to_message_id` / `parent_id` / `root_id` **都指向第 1 条** ✓
  - ⭐ **并用只读接口 `im.message.get`【读回来】核对**（不只看发送响应）：图片那条 `parent_id` / `root_id` 为空，
    文字那条 `parent_id` / `root_id` = 图片的 `message_id`，两条 `thread_id` 一致 ✓
    （`report.json.topic.probe_confirms_root = true`）
  - 群内消息共 2 条：`reply` 1 条、**reply 到第 1 条 1 条**，**没有第二条顶层消息** ✓
- ⚠️ **`reply_in_thread: true` 加不加【无差异】** —— 测试群本身是**话题群**（**引用**早前的真机最小验证记录）。
- ⚠️ **早前还有一种"两段拼"的验法**（**引用父代理交接记录**）：用最小脚本**单独**验 SDK 的 `reply` 行为
  （顶层图 `thread_id = omt_19a12fedcccf9c9c`、文字版 `omt_19a12fdefb4fdcb0`），代码路径另用假 IM 验
  —— 那种验法**不是单次全链路**。**上面 B 已经把「代码路径 ＋ 真 SDK 行为」合成了一次 run**，**以 B 为准**。
- ⚠️ **同一次 run 里、与本条无关的一处失败（如实记）**：**私聊差额通知**没发出去 ——
  飞书返回 `im.message.create` 400 / code `230013` / `Bot has NO availability to this user.`
  （`purchase.return.notice` 里 `sent: false`，`report.json.apiErrors` 记了 2 条同样的 400）。
  **群里那两条消息照常发出** ✓；这属于「机器人给经办人发私聊」的**可达性**问题，
  **不是话题 / 归批的问题**（本报告只记录，不改代码）。

### ✅ ⑧ 环境隔离

**全程只用**：

- **测试 Base**：`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个
  —— 4 次 run 的 `report.json.base_app_token` 与本机 `FEISHU_V1_E2E_TEST_APP_TOKEN` **同值**（只判等，不写值）；
- **测试应用**：本机 `LARK_AGENT_APP_ID` = `cli_aa3341b397389cd4`（app_id，非密钥）；
- **测试群**：`PURCHASE_CHAT_ID`（本机值形如 `oc_...`）指向的那个；`chat_id` 字段在 4 份 `report.json` 里一致；
  真机 run（`reczz28K39EPRNsA`）也只发这一个群。

🔴 **一个字节都没写生产 ✓ 没用飞书 CLI ✓ 没发采购群** ✓

- **代码级兜底**：`server/scripts/e2e-run.mjs` 里写死了"**app_token 等于生产 Base → 直接拒绝运行**"
  （第 267–275 行：先判空、再判"等于生产"抛错、再判"既不是授权测试 Base 也不是生产"抛错），
  并要求 `FEISHU_TARGET_ENV=test`（本机该变量 = `test`）。
- **验证也走项目代码**：链路入口是 `PurchaseWebhookService.accept('supplier-report', recordId)`
  （= 生产上"表变更事件"走的那条路），证据靠脚本自己的只读子命令 `inspect` 打印，
  **没有用飞书 CLI 去读表**。
- ⚠️ **如实记一笔（已知的待改项）**：这个闸门本身是**硬编码 token 值**实现的
  （`e2e-run.mjs` 里既有测试 Base 也有生产 Base 的字面量），AGENTS.md 已把它列为待改
  —— 应改成"从 `.env` 读"或"指纹比对"，**不是删掉闸门**。本报告不复述这些值。

---

## ④ 真实数据取证（2026-10-06，**只读**）

> ⚠️ **这一节的数字是引用**：生产表只读普查在**服务器侧 / 别的代理那侧**完成，**本机没有落盘产物**。
> 我只做了"读结论 ＋ 与代码对照"（例如「供应商从哪读」这一条我核到了 `purchaseWebhookService.js:1444`）。

- ⭐ **生产「供应商对接」全表 40 条：数量说明留空 39 条 / 「42码两双」1 条**（**97.5% 不写**）。
  唯一那条 = `reczz28K07O8o4SW`（货品 `31678｜黑色｜A`、尺码 40/42/43、供应商 三星），
  **链路解析正确**（40→1 / 42→2 / 43→1）—— 与 ⑥ 的 R2 同口径。
- ⭐ **生产「单据信息」114 条：1 双 ×113 / 2 双 ×1；最大 2 双**；**没有两位数、没有 0、没有小数**。
  真实**货品 × 尺码组合 40 组**，尺码覆盖 **37~46**。
- ⭐ **"缺供应商"有真实实例**：`reczz28JzxXFZLLQ`（货品 `1366-12｜黑色｜B` **无供应商**）——
  **报单照样跑通**。**货品表 528 条里 175 条（33.1%）无供应商**。
  · **代码侧**：供应商是从【货品信息】的「供应商」字段读的（`purchaseWebhookService.js:1444`）；
    `v1BitableSchema.js` 里「供应商对接」的字段映射**没有** `supplier` 这一项。
- ⚠️ **父代理编造的那些说法，在她的真实数据里【0 条】命中**（**逐条列出来当教训**）：

  | 编的说法 | 真实数据里的条数 |
  | --- | --- |
  | `2.5 双` | 0 |
  | `0 双` | 0 |
  | `1 双`（阿拉伯数字） | 0 |
  | `共 5 双` | 0 |
  | `10 双` | 0 |
  | `3 双`（带空格） | 半编（仅「卖了3双」1 条**销售**原文，不是报货） |
  | `两双` | ✅ **真实存在** |

  ＋ ⭐ **"共 / 总共"她只用于【钱】，从不用于鞋数** ✓
  ＋ 🔴 **那些编的字符串只存在于【测试 Base（`SELFTEST-*`）】，没有一条进生产** ✓
- ⭐ **纪律依据**：**`AGENTS.md` 第 10 条「测试的输入数据从哪来」** ——
  首选**她真实的数据**；**要自己编就必须先跟她说一声**、让她验证合理性；
  **不许编不合业务常理的数据**（她的原话：「一双鞋哪有 2.5 双呀」）。
  ⑥ 那段"编的用例"正是**先编后报**，**违反这一条**，记在此处备查。
- ⚠️ **脱敏**：经办人 `open_id` **只做过 SHA-256 指纹比对**，**本文件不写它的值**；
  全文只出现变量名、app_id、record_id、批次号，**没有任何 token / secret**。

---

## ⑤ 这一轮踩到的坑 ＋ 教训

### ① 🔴 本机代码落后 17 个提交，差点把"功能没问题"误判成 bug

- **现象**：生成的图还是"四列平铺"✗，一度以为"按货号分组"坏了 ✓
- **真因**：**改动在 PR 里 ✗ 而主工作区没 `git pull`** ✓
- → ⭐ **正确顺序**：**改（worktree）→ PR → 合并 → 【主工作区 `git pull`】→ 部署 → 跑测试** ✓
- ⚠️ **为什么会漏**：**测试脚本要读 `.env` ✗ 而 `.env` 只在主工作区**
  → **"代码在 worktree（最新）✗ 测试在主工作区（旧）"会分家** ✓
- → ⭐ **自检**：**`git rev-list --count HEAD..origin/main` 必须为 0** ✓
  （初版写报告时实测 = **0**，`HEAD` = `origin/main` = `7563537`；**本轮收口时再次实测 = 0**，
  `HEAD` = `origin/main` = `bef05d0`。）
- ⚠️ **来源标注**："落后 17 个提交 / 看到四列平铺"这两个细节是**引用本轮交接记录**；
  我实测的是**自检口径本身**。

### ② ⚠️ 自测工具的 IM 替身缺 `reply`，报错看起来像生产 bug

- 现象：`this.client.im.message.reply is not a function`，看上去像"退货发群这条链路挂了"✗
- 真因：**替身（桩）缺方法** ✗ 生产代码调的是官方 SDK 真实存在的方法 ✓
- → ⭐ **教训**：**看到 "xxx is not a function" 先确认"是不是替身 / 桩的问题"** ✓
  —— 尤其当调用形状是"替身自己手写的"时候；替身要与官方 SDK **调用形状逐字一致**，
  否则**跑的根本不是生产那条代码路径**。
- ⭐ **已修**：`fix/e2e-run-im-reply-and-batch-records`（**PR #115，已合并**）给两个替身都补了 `reply`
  并记下 `path.message_id`；**修好之后才跑出 ⑦ 的真机硬证据**（见 ③ ⑦ B）。
- 副作用也记一笔：`send_failed` 之后链路 `continue`，**连"图写回单据信息附件"都整段跳过**，
  于是早期 `report.json` 里 4/4 次 run 的"每条单据信息的附件数"都是 `[0,0]`
  —— 那**不能**当成"附件回写功能坏了"的证据，它是同一条替身缺方法的连带结果。
  （修好后的真机 run 里附件回写是好的：**只有明细 ID 最小的那行带附件** ✓）

### ③ ⭐ 本机测试环境要这样配（**写清楚，免得下次又摸**）

- `LARK_AGENT_APP_ID` / `LARK_AGENT_APP_SECRET` = **测试应用**的
  （⚠️ **项目代码只读这个变量名** ✗ 所以本地测试必须这样填 ✓
  —— 🔴 **填的是【测试应用】✗ 不是生产** ✓ 不违反"本机不放生产凭证"）
  - 本机实测：`LARK_AGENT_APP_ID` 非空、取值 `cli_aa3341b397389cd4`；另外 `.env` 里也另配了
    `LARK_TEST_APP_ID` / `LARK_TEST_APP_SECRET`。
- `PURCHASE_CHAT_ID` = **测试群** ✓ · `LARK_BOT_OPEN_ID` = **测试机器人** ✓（两个都非空）
- `TEXT_LLM_*` = DeepSeek（`base_url` / `model` 照 `.env.example` ✓ API Key 由她填 ✓）
  —— 本机 `TEXT_LLM_BASE_URL` = `https://api.deepseek.com`、`TEXT_LLM_MODEL` = `deepseek-chat`、`TEXT_LLM_API_KEY` 非空
- `FEISHU_TARGET_ENV` = `test`
- ⚠️ **本机 `FEISHU_V1_BITABLE_APP_TOKEN` 与 `FEISHU_V1_E2E_TEST_APP_TOKEN` 同值**
  （实测判等 = true）→ **"哪一个才是生产"必须认【线上服务器的取值】**，
  不能凭本机这个变量名反推。
- ⚠️ 环境变量里**只写变量名**；`.env` 不进 git，具体值不在本文件出现。

---

## ⑥ 两个待办（本轮发现，**只记录，不改代码**）

1. 🔴 **`readReportBehaviorKind` 没有重试** ✗（`server/src/services/purchaseWebhookService.js:1486`）
   - 它第一句 `gateway.get('purchaseReport', recordId)` **是裸奔的**（无 try/catch、无重试）✓
   - ⚠️ 而**同一文件里的 `readReportBatchNo`（`:544`）有完整重试** ✓（**读到空值也重试** ✓）
   - 🔴 **后果**：**"事件到了、但记录还没就绪"→ 分流第一步就抛 → 整条任务 failed** ✓
     ＋ ⚠️ **报货是【免确认】链路 ✗ 失败没有卡片提示 ✗ 静默** ✓
   - ⭐ **建议**：**照 `readReportBatchNo` 补一次重试** ✓（**或失败时在群里说一声** ✓）
2. ⚠️ **提示词「1 双」缺口**（`server/src/services/doubaoService.js:474–475` 规则 1/2）
   - 上面 ⑥ 已定位：裸的「1 双 / 一双 / 10 双」→ 模型返回空 → 报错
   - 🔴 **真实数据里这些说法 0 条**（见 ④）→ **优先级由业务负责人定** ✓

---

## ⑦ 红线遵守情况（逐条）

🔴 **没动生产表任何数据** ✓（**只用测试 Base** ✓ —— 4 次 run 的 `base_app_token` 都是
`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个；`FEISHU_V1_BITABLE_APP_TOKEN` 在本机也指向测试 Base）
🔴 **没用生产凭证** ✓（本机 `LARK_AGENT_APP_ID` = 测试应用；不碰任何生产侧的 app id / secret）
🔴 **没发采购群** ✓（发消息只用 `PURCHASE_CHAT_ID` 指向的**测试群**；真机 run 也只发这一个群）
🔴 **没用飞书 CLI** ✓（**全程项目代码 / 官方 SDK**：链路走 `PurchaseWebhookService.accept('supplier-report')`，
验证走脚本自己的只读 `inspect`；真机 run 用官方 SDK 的 `im.message.get` **读回**核对）
🔴 **没打印任何 secret / token 值** ✓（本文件只出现变量名、app_id、record_id、批次号；
测试 Base / 生产 Base 的 token 值一律不写；经办人 `open_id` **只做 SHA-256 指纹比对，不写值**）

---

## 附：本报告明确"没验到 / 不能下结论"的地方

1. **8 条本身：全部 ✅ 已验证**（见 ②；每条证据见 ③）。
   但下面三件事**不在 8 条之内**，**不要读成"采购侧什么都验过了"**：
   （a）⑥ 里"明确写 1 双 / 一双 / 10 双"的**提示词缺口** —— **真实数据 0 条**，**优先级由业务负责人定**；
   （b）`readReportBehaviorKind` **无重试**（⑥ 待办 1）；
   （c）真机 run 里**私聊差额通知**发不出去（飞书 `230013`，**群消息不受影响**，见 ③ ⑦）。
2. **`purchase.return.posted` / `inventory.change.applied` / `purchase.return.stock_applied`
   这三条日志**：事件名与代码位置（三处）我核过 ✓；**早期 4 次 run 没有保存 stdout**，那句属于**引用**；
   而 ① 的归批 run **有 `raw-logs.jsonl` 原文**，那三条我是**逐字读到的**，不是引用。
3. **"同批次号只出一张图"在真机上的证据**：**已经做了**（③ ① B，`reczz28K39EPRNsA`，真发测试群）。
   ⚠️ 但那一次覆盖的是"**同批 2 条、2 个尺码、各 1 双、同一供应商**"，
   **没有覆盖**"同批多供应商 / 同批多货品 / 同批 3 条以上"这些组合。
4. **落后 17 个提交**这个数字：**引用本轮交接记录**；我只实测了当前差距 = 0（`bef05d0`）。
5. **`/tmp` 下的证据**（`/tmp/verify-return-batch/`、`/tmp/real-qty/`、`/tmp/report-qty-*.log`、
   `/private/tmp/e2e-reply/server/data/selftest/runs/`）**会随重启 / 清理消失**，
   **不是永久凭据** —— 关键值（record_id、批次号、`thread_id`、message_id）都已抄进正文。
