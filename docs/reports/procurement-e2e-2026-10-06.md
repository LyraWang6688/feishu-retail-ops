# 采购侧全流程测试报告（2026-10-06）

- 日期：2026-10-06（上海时间，+8）
- 执行人：AI（本地自测；业务负责人不需要在飞书里做任何操作）
- 代码版本：`origin/main` = `7563537`（先 `git fetch`，自检 `git rev-list --count HEAD..origin/main` = **0**）
- 写这份报告的 worktree：`/private/tmp/proc-e2e-report`（分支 `docs/procurement-e2e-report`，基于最新 `origin/main`）
  —— **本次只新增这一份文档：没改代码、没动表、没重启、没部署**
- 测试 Base：`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个（`FEISHU_TARGET_ENV=test`）
- 生产 Base：`FEISHU_V1_BITABLE_APP_TOKEN` 指向的那个 —— **一个字都没写**
- 测试飞书应用：`LARK_AGENT_APP_ID`（本机取值 `cli_aa3341b397389cd4`，即测试应用）
- 测试群：`PURCHASE_CHAT_ID` 指向的那个
- 🔴 **本文件不含任何 token / secret 的值**：一律只写变量名与 record_id

> **本报告的数字都是哪来的**：所有 record_id、行数、批次号、报错原文，都来自本地测试产物
> `server/data/selftest/runs/<记录id>/report.json` 与同目录 `task.json`（该目录被 `.gitignore` 忽略，
> 是本地测试产物、不进 git）；图片结论来自同目录真实生成的 `return-order.png`（逐张看过）。
> 凡**不是**我从这些文件里读出来的（例如"曾经落后 17 个提交"），文中都标了「引用」。

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

状态只有三种：**✅ 已验证** / **🔄 进行中** / **⚠️ 测不了（附原因）**

| # | 标准 | 状态 | 证据 / 卡在哪 |
| --- | --- | --- | --- |
| ① | 同一个批次号只用一张图片 | 🔄 进行中 | **要"两条同批号的记录"才验得了**：归批窗口逻辑已在 `origin/main`，但自测脚本还只会写 1 条。`--records/--gap-ms/--batch-no` 正在另一个 worktree 里改（未提交） |
| ② | 图片是最新格式 | ✅ 已验证 | `server/data/selftest/runs/reczz28K2VoBMctW/return-order.png`（900×450，29128 bytes）：按货号分组、3 列、合计 2 条/2 双 |
| ③ | 缺供应商也没问题 | ✅ 已验证 | 同一次 run（`reczz28K2VoBMctW`）：`draft.items[].supplier_record_id = ""`，图上**不画**「供应商：」那行，**照样出单** |
| ④ | 标题改了 | ✅ 已验证 | 图上是「**邯美皮鞋退货单**」（旧文案是「邯美皮鞋采购退货单」）；代码 `purchaseRequestImageService.js:36` = `RETURN_TITLE` |
| ⑤ | 退货后「单据信息 / 库存流水 / 实时库存」都减少 | ✅ 已验证 | 4 次 run 的 `report.json checks ①②③` 全 `pass`；本次取 `reczz28K2VoBMctW`：单据信息 +2 行、库存流水 +2 行（`STOCK_PURCHASE_DECREASE`）、实时库存 −2 行 |
| ⑥ | 采购申请数量非 1 时 AI 能识别、单据信息同步增加 | 🔄 进行中 | 模型 key 已配好（`TEXT_LLM_API_KEY` / `TEXT_LLM_BASE_URL=api.deepseek.com` / `TEXT_LLM_MODEL=deepseek-chat`）；入口脚本当前**没有**"采购申请"模式（只有 `setup` / `inspect` / `return`），正在测 |
| ⑦ | 在一个话题内，而不是单独的消息 | 🔄 进行中 | 要"真发到测试群"才算；已查出障碍：自测工具 `server/scripts/e2e-run.mjs` 的 IM 替身**缺 `reply` 方法** → `this.client.im.message.reply is not a function`（4/4 次 run 的 `task.json` 都记到了这条）。**正在修** |
| ⑧ | 环境隔离：不碰生产表 / 凭证 / 群聊，只用测试侧 | ✅ 已验证 | 4 次 run 的 `report.json.base_app_token` 都等于本机 `FEISHU_V1_E2E_TEST_APP_TOKEN`；本机 `LARK_AGENT_APP_ID` = 测试应用；群里发的是 `PURCHASE_CHAT_ID`（测试群）；脚本里还有"app_token 等于生产 → 拒绝运行"的代码级闸门 |

**一句话结论**：8 条里 **5 条已验证达标**（②③④⑤⑧），**3 条仍在进行中**（①⑥⑦），
**没有"测不了"的条目**；这 3 条卡的都是**测试工具/入口**，不是已跑出来的业务链路失败。

---

## ③ 已验证的 5 条 ＋ 证据

> 下面每个 record_id 都是从 `server/data/selftest/runs/<记录id>/report.json`、`task.json` 里读出来的**真实值**，
> 不是估计的。图片结论来自同目录真实生成并被我逐张打开看过的 `return-order.png`。

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

### ✅ ③ 缺供应商也没有问题

- 这条货品**没有供应商**：`reczz28K2VoBMctW` 的 `task.draft.items[]` 里 `supplier_record_id` 是**空字符串**；
  `task.json.image_delivery.failed[0].supplier` 也记成「**未标注供应商**」。
- → **表头【没有画「供应商：」那一行】** ✓ **照样出单** ✓（见上面那张图：标题下面只有"报货批次 ＋ 日期"，没有供应商）。
- **对照**（另一条有供应商的 run）：
  - `reczz28K2cCiKKbo` 的图上写了「**供应商：七匹狼/吉祥鸟**」✓
  - `reczz28K2Z8NZHD9` 的图上写了「**供应商：一代千金**」✓
- **代码侧**：`purchaseRequestImageService.js:288–293` 注释写明"没有供应商时不渲染「供应商：」这一段
  （业务负责人 2026-10-06：没维护供应商的货品也应该能正常出单）"，原来写的是「供应商：未填写」。

### ✅ ④ 标题

- 图上写的是「**邯美皮鞋退货单**」✓（旧的是「邯美皮鞋采购退货单」）。
- 代码：`purchaseRequestImageService.js:36` → `const RETURN_TITLE = '邯美皮鞋退货单';`
  （同文件第 284 行注释：默认是「邯美皮鞋采购单」，采购退货传「邯美皮鞋退货单」）。
- ⚠️ 一处**陈旧注释**（不影响行为）：`purchaseWebhookService.js:2129` 的注释里还写着
  "标题「邯美皮鞋采购退货单」" —— 那是没跟着改的注释，实际渲染用的是 `RETURN_TITLE`。

### ✅ ⑤ 三张表都减少

**一次退货（2 个尺码，各 1 双）**，以 `reczz28K2VoBMctW`（货品 `6C98012-15L|黑|B`，数量 2）为例：

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
    **没有保存当次 stdout**，所以"这三条日志确实打出来了"这一句属于**引用本轮交接记录**，
    我这边只核实了事件名与代码位置。

**同口径在另外 3 次 run 上也成立**（`report.json` 的 `checks ①②③` 都是 `pass`）：

| run（记录 id） | 货品 | 单据信息（row id / 尺码） | 库存流水（row id / 尺码） | 实时库存消失行 |
| --- | --- | --- | --- | --- |
| `reczz28K2RlJAwFU` | `YD6693-2｜黑色｜A` | `reczz28K2SmTOm3e`/40、`reczz28K2TJGGtb4`/42 | `reczz28K2TXLsBv2`/42、`reczz28K2T5B8wWU`/40 | `recvw7x87LjHl9`/40、`recvw7x9t3lkTe`/42 |
| `reczz28K2VoBMctW` | `6C98012-15L｜黑｜B` | `reczz28K2WndBbsH`/37、`reczz28K2XFVh31D`/41 | `reczz28K2XXNk5vS`/41、`reczz28K2X3evG3G`/37 | `recvw7x9t3l7PX`/37、`recvw7xao68Kw9`/41 |
| `reczz28K2Z8NZHD9` | `3F010C1229｜奶茶色｜B` | `reczz28K2aReNqAu`/37、`reczz28K2avgHdHy`/38 | `reczz28K2bCUpJCw`/38、`reczz28K2ahxlYM5`/37 | `recvw7x9WoNutQ`/37、`recvw7xao65cyd`/38 |
| `reczz28K2cCiKKbo` | `YD6693-2｜黑色｜A` | `reczz28K2dRQdb7A`/41、`reczz28K2dvJ3O4t`/44 | `reczz28K2eD4RgEz`/44、`reczz28K2diSuWvP`/41 | `recvw7x9t3U19S`/44、`recvw7x9t3Ul1N`/41 |

（每次都是"2 个尺码、各 1 双"的退货；`reczz28K2Z8NZHD9` 里 38 码原有 2 行，退掉 1 行后**还剩 1 行**，
`report.json` 的按尺码核对也记了 `after=1 / expectedAfter=1` —— 减到 0 才消失，减到 1 就留 1 行。）

### ✅ ⑧ 环境隔离

**全程只用**：

- **测试 Base**：`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个
  —— 4 次 run 的 `report.json.base_app_token` 与本机 `FEISHU_V1_E2E_TEST_APP_TOKEN` **同值**（只判等，不写值）；
- **测试应用**：本机 `LARK_AGENT_APP_ID` = `cli_aa3341b397389cd4`（app_id，非密钥）；
- **测试群**：`PURCHASE_CHAT_ID`（本机值形如 `oc_...`）指向的那个；`chat_id` 字段在 4 份 `report.json` 里一致。

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

## ④ 待验的 3 条 ＋ 卡在哪

### 🔄 ① 同一个批次号只用一张图片 —— **要"两条同批号的记录"才能验**

- 判据本身就是"同一批号的 N 条记录 → 只出 1 张图、只发一次群、后面的挂它的话题"，
  所以**必须先造出 2 条同批号记录**；现有 `e2e-run.mjs return` 只会写 1 条，验不出这条。
- 归批能力**已经在 `origin/main`**：`server/src/config/purchaseReturnBatchWindow.js`
  （退货归批窗口默认 **30000ms**，可用 `PURCHASE_RETURN_BATCH_WINDOW_MS` 覆盖），
  链路在 `purchaseWebhookService.js` 的 `handleReturnBatch` / `runReturnBatch`（退货自己一套窗口，
  与报货那套刻意分开）。
- **正在做**：另一个 worktree（`/private/tmp/e2e-reply`，分支 `fix/e2e-run-im-reply-and-batch-records`，
  改动**未提交**）给 `e2e-run.mjs` 加了 `--records <n>` / `--gap-ms <ms>` / `--batch-no`，
  两条记录共用同一个批次号（默认间隔 16 秒，复现生产那次"同一次提交被拆成两次推送"）。
  → **改完、跑完之前，这条不给 ✅。**

### 🔄 ⑥ 采购申请里数量不是默认 1 时 AI 识别 ＋ 单据信息同步增加 —— **要模型 key**

- **模型 key 已配好**（本机 `.env`，只报变量名与是否非空）：
  `TEXT_LLM_API_KEY`（非空）· `TEXT_LLM_BASE_URL` = `https://api.deepseek.com` · `TEXT_LLM_MODEL` = `deepseek-chat`
  （照 `.env.example`）—— **正在测**。
- 这条走的是**采购申请**分支（勾选尺码 + 「数量说明」文字），解析链路是
  `parseReportQuantities` → `buildPurchaseQuantities` + `recognizer.parsePurchaseReportText`
  （`purchaseWebhookService.js:303–318`）；默认"勾选的尺码各一双"，说明里只写例外。
- **卡点**：`e2e-run.mjs` 目前只有 `setup` / `inspect` / `return` 三个子命令，**没有"采购申请"入口**，
  所以要新写一个入口（或手工按同一条 `accept('supplier-report')` 调）才能跑"数量说明 = 非 1"。
  → **跑完前不给 ✅。**

### 🔄 ⑦ 一个话题内（不是单独的消息）—— **要"真发到测试群"**

- ⚠️ **已查出的障碍**：`server/scripts/e2e-run.mjs` 的 IM 替身**缺 `reply` 方法** ✗
  → 报 `this.client.im.message.reply is not a function` ✓
  → 4/4 次 run 的 `server/data/selftest/runs/<id>/task.json` 里
  `image_delivery.failed[0].error` 都是这一条，且 `image_delivery.sent = []`。
- ⭐ **已核实：官方 SDK 的 `reply` 是有的 ✓ 生产代码调用【是对的】✗ 是【自测工具】缺方法** ✓
  - 生产代码确实在调：`purchaseWebhookService.js:1097` 与 `:1129`
    （`this.client.im.message.reply({ path: { message_id }, data: { msg_type, content } })`），
    第 1243–1247 行注释写明"第 2 条起都 reply 第 1 条，于是都挂在那一个话题下"。
  - 所以这是**自测替身**与官方 SDK **调用形状不一致**，不是生产 bug。
- **正在修** ✓：`/private/tmp/e2e-reply` 里给两个替身（真发记录型、假客户端型）都补了 `reply`，
  并记 `path.message_id` / 返回的 `thread_id` 用来判"是不是同一个话题"（改动**未提交**）。
- 另外这条的"真机证据"要求"**真发到测试群**"，所以最终确认要带 `--real-im` 跑一次测试群。

---

## ⑤ 这一轮踩到的坑 ＋ 教训

### ① 🔴 本机代码落后 17 个提交，差点把"功能没问题"误判成 bug

- **现象**：生成的图还是"四列平铺"✗，一度以为"按货号分组"坏了 ✓
- **真因**：**改动在 PR 里 ✗ 而主工作区没 `git pull`** ✓
- → ⭐ **正确顺序**：**改（worktree）→ PR → 合并 → 【主工作区 `git pull`】→ 部署 → 跑测试** ✓
- ⚠️ **为什么会漏**：**测试脚本要读 `.env` ✗ 而 `.env` 只在主工作区**
  → **"代码在 worktree（最新）✗ 测试在主工作区（旧）"会分家** ✓
- → ⭐ **自检**：**`git rev-list --count HEAD..origin/main` 必须为 0** ✓
  （写这份报告时实测 = **0**；`HEAD` = `origin/main` = `7563537`。）
- ⚠️ **来源标注**："落后 17 个提交 / 看到四列平铺"这两个细节是**引用本轮交接记录**；
  我这次实测的是**自检口径本身**（`git fetch` 后 `HEAD..origin/main` = 0）。

### ② ⚠️ 自测工具的 IM 替身缺 `reply`，报错看起来像生产 bug

- 现象：`this.client.im.message.reply is not a function`，看上去像"退货发群这条链路挂了"✗
- 真因：**替身（桩）缺方法** ✗ 生产代码调的是官方 SDK 真实存在的方法 ✓
- → ⭐ **教训**：**看到 "xxx is not a function" 先确认"是不是替身 / 桩的问题"** ✓
  —— 尤其当调用形状是"替身自己手写的"时候；替身要与官方 SDK **调用形状逐字一致**，
  否则**跑的根本不是生产那条代码路径**。
- 副作用也记一笔：`send_failed` 之后链路 `continue`，**连"图写回单据信息附件"都整段跳过**，
  于是 `report.json` 里 4/4 次 run 的"每条单据信息的附件数"都是 `[0,0]`
  —— 那**不能**当成"附件回写功能坏了"的证据，它是同一条替身缺方法的连带结果。

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

## ⑥ 红线遵守情况（逐条）

🔴 **没动生产表任何数据** ✓（**只用测试 Base** ✓ —— 4 次 run 的 `base_app_token` 都是
`FEISHU_V1_E2E_TEST_APP_TOKEN` 指向的那个；`FEISHU_V1_BITABLE_APP_TOKEN` 在本机也指向测试 Base）
🔴 **没用生产凭证** ✓（本机 `LARK_AGENT_APP_ID` = 测试应用；不碰任何生产侧的 app id / secret）
🔴 **没发采购群** ✓（发消息只用 `PURCHASE_CHAT_ID` 指向的**测试群**）
🔴 **没用飞书 CLI** ✓（**全程项目代码 / 官方 SDK**：链路走 `PurchaseWebhookService.accept('supplier-report')`，
验证走脚本自己的只读 `inspect`）
🔴 **没打印任何 secret / token 值** ✓（本文件只出现变量名、app_id、record_id、批次号；
测试 Base / 生产 Base 的 token 值一律不写）

---

## 附：本报告明确"没验到 / 不能下结论"的地方

1. **①⑥⑦ 三条没有结论**——见第 ④ 节，卡点分别是"要两条同批号记录 / 要采购申请入口 / 要真发到测试群"。
   在这三条跑完之前，**不说"采购侧全流程已跑通"**。
2. **`purchase.return.posted` / `inventory.change.applied` / `purchase.return.stock_applied`
   这三条日志"当次确实打过"**：我只核实了事件名与代码位置（三处），
   `server/data/selftest/runs/` 里**没有保存 stdout**，所以这句是**引用**，不是我这次抓到的日志。
3. **"同批次号只出一张图"在真机上的最终证据**：要用测试群真发一次才算，本轮**未做**。
4. **落后 17 个提交**这个数字：**引用本轮交接记录**；我只实测了当前差距 = 0。
