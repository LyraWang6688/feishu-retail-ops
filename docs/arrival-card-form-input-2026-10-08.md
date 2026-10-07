# 到货核对卡片改成「表单填写 + 提交」（业务负责人 2026-10-07 深夜定，2026-10-08 做）

> 她的原话（逐字）：
> 「我们的消息卡片是否支持**输入一段文字**？……我们对于采购这一块，也是像销售一样发到群里一个卡片，
>  等到货之后，**请在卡片里填写实际到货情况**。也就是给到用户卡片，**用户填写内容之后，再点击提交**。
>  以这个来作为**触发后续的到货验收**」

待办原文见 `docs/todo-arrival-card-form-input.md`（**未入库，只在主工作区**）。

---

## 0. 官方能力（curl 实查，2026-10-08；两个 `.md?lang=zh-CN` 原文）

| 事实 | 出处 | 原文要点 |
| --- | --- | --- |
| 输入框做内容收集 | `feishu-cards/card-components/interactive-components/input` | 「在使用卡片进行**内容收集**的场景下…你可以使用输入框组件，实现简单的**文本内容收集**的场景」 |
| **必须**与按钮一起内嵌进表单容器 | 同上「注意事项」 | 「要结合使用输入框组件与按钮组件，你需将输入框组件与按钮组件内嵌于**表单容器**中」 |
| 表单容器只能放卡片**根节点** | `feishu-cards/card-components/containers/form-container` | 「表单容器组件**不可被内嵌在其它组件内**，只可放在卡片根节点下」 |
| 输入框需 **V6.8+**；表单容器需 **V6.6+** | 两篇的「注意事项」 | 「输入框仅支持飞书 V6.8 及以上版本的客户端」；「表单容器支持飞书 V6.6 及以上版本」 |
| 降级可自定义 | input 的 `fallback` 字段 | 不填 = 系统默认占位；`"drop"` = 直接丢弃；也可给 text 对象自定义 |
| 多行文本 | input 的 `input_type` / `rows` | `multiline_text` = 可输入含换行符的多行内容，「换行符在回调中以 `\n` 返回」 |
| 提交按钮 | form-container 的扩展字段 | 按钮加 `"action_type": "form_submit"`，「用户点击后，将触发表单容器的提交事件，异步提交所有已填写的表单项内容」 |
| 回调带 `form_value` | form-container「回调结构」 | `event.action.form_value = { "<表单项 name>": "<值>" }`（官方示例 `"Input_lf4fmxwfrd9": "1234"`） |
| 表单内交互组件必须有**唯一 `name`** | 两篇的「字段说明」 | 「该字段必填且需在**卡片全局内唯一**」；否则数据发送失败（飞书报 200530） |
| 必填在前端拦 | input 的 `required` | `true` 时「未填写输入框，则前端提示"有必填项未填写"，**不会向开发者的服务端发起回传请求**」 |

⇒ **服务端仍必须自己兜一层空值**：`required` 只是前端拦截，重放 / 模拟 / 降级都可能把空串送进来。

---

## 1. 验收标准（**先写这个，再写代码**）

### A. 卡片结构（可断言）
1. 到货核对卡片是在**卡片根节点**上多一个 `tag:"form"` 的表单容器；
2. 表单容器内**恰好**两项：`tag:"input"`（多行）与 `tag:"button"`（`action_type:"form_submit"`）；
3. 输入框 `name` = 配置值（默认 `actual_arrival`），`required:true`，`input_type:"multiline_text"`，
   `label` / `placeholder` / `fallback` 文案全部来自 `config/`；
4. 提交按钮 `name` 唯一、`text.content` 来自配置（默认「提交」）、`value` 里带
   `{action:"submit_arrival_reconcile", draft_id:<到货核对任务 id>}`；
5. **卡片全局内所有交互组件的 `name` 互不相同**（输入框 / 提交按钮 / 既有「是」「否」按钮）；
6. 既有「是」「否」两个按钮**一个都没有少**（入库闸门不动）。

### B. 提交 = 触发到货验收（**逐字一致**）
7. 提交带文字 `T` → 走的是**同一条** `parseArrivalReconciliation` → 差异比对 → 计划 → 卡片；
8. ⭐ **与"在话题里说同一句 `T`"的结果逐字一致**：模型入参（`messages`、`rows`）**深度相等**，
   算出的 `plan` / `differences` / 发出去的卡片 JSON（除消息 id / taskId 这类身份字段）**深度相等**；
9. 提交**不新增任何解析实现**（没有第二套差异/数量逻辑，也不放宽既有闸门）。

### C. 提交之后
10. 提交**成功算出结果并出了新卡** → 把**她提交的那张卡** patch 成「已提交」终态
    （表单收掉 ⇒ 点不了第二次；文案可配）；
11. 提交**没算出结果**（这句里没有到货内容 / 解析失败 / 对不上明细）→ **行为与"在话题里说同一句"完全一致**
    （该不发卡就不发卡、该回话就回话），**卡片保持可编辑**（她能在输入框里改一句再提交，或照旧在话题里说）；
    🔴 **绝不放宽**「解析不了就不发卡 / 不写表」。

### D. 幂等
12. 同一次提交被飞书**重投** → `duplicate_message`：**不重复喂模型、不重复发卡、不重复入库**；
13. 重复提交 / 重复点「是」→ 库存**不重复加**（既有 `status === 'posted'` 闸门 + 库存自身幂等）。

### E. 空提交
14. `form_value` 里没有该字段 / 只有空白 → **明确提示**（toast + 卡片上一条可配的提醒）+
    **零业务表写入** + **不喂模型** + **不发卡片** + 本地 transcript 一个字都不加。

### F. 老客户端降级（**老路必须留着**）
15. 卡片上的输入框带**可配的降级文案**，明说"老版本用不了，直接在话题里回一句"；
16. ⭐ **"在话题里说话"这条入口原样保留**：`handleTopicMessage` 的行为、文案、卡片**逐字不变**；
    本改动**没有**给到货链路加"只留按钮"那种闸门（她说的"只留按钮"是**销售**方向）。

### G. 配置先行
17. 输入框 `name` / `label` / `placeholder` / 必填 / 提交按钮文案 / 已提交文案 / 空提交提示 /
    降级文案 **全部**在 `server/src/config/arrivalConversation.js`；改文案不碰 service 与卡片渲染。

### H. 红线
18. 🔴 不写**任何**业务表（提交本身也不写；入库仍然只由点「是」触发）；
19. 🔴 不碰销售侧、`pendingDealPush*`、`app.js`、`confirmArrivalLocked` 的库存循环、`inventoryService` 幂等。

---

## 2. 实现（改完之后长什么样）

### 2.1 配置（`server/src/config/arrivalConversation.js`）
- 动作名多一个 `SUBMIT: 'submit_arrival_reconcile'`（与卡片渲染共用同一份常量）。
- `card.form` 一整块（含输入框 + 提交按钮 + 降级文案 + 空提交提醒）；
- `card.submitted*`（提交成功之后那张卡的两句）；
- `replies.submitMissing` / `replies.submitReceived` / `replies.submitDuplicate`。
- ⚠️ `card.form` 走**嵌套合并**（与 `replies` / `summary` 同一套写法），
  否则测试只覆盖一项时会把其余项变 `undefined`。

### 2.2 卡片（`server/src/utils/larkCards.js`）
- 新 `arrivalReconcileForm(copy.form, taskId)`：`form` 容器 → `[input, button(form_submit)]`；
- `purchaseArrivalReconcileCard` 在**明细行之后、「是/否」之前**插入这个表单容器，
  并在有 `copy.formError` 时把一句提醒放在表单之前；
- 终态卡（`purchaseArrivalReconcileStatusCard`）**不含**表单 —— 提交过 / 入库过就收掉。

### 2.3 服务（`server/src/services/purchaseArrivalConversationService.js`）
- `handleCardFormSubmit(value, formValue, event, operatorOpenId)`：**唯一**的提交入口
  （空值 → 提示 + 零写；非空 → 进 `queue.run(taskId, …)`）。
- `handleFormSubmitLocked`：任务不存在 / 已入库 → 走既有 `visibleFailure` / 已入库回执；
  否则把 `{text, messageId: 被提交卡片的 open_message_id}` **原样喂给 `handleTopicMessageLocked`**
  —— 这就是"当作她在话题里说的那句话"的落地，**没有第二套解析**。
- `batchFromTask(task)`：从本地会话任务还原"是哪一批"（`request_ids` 取任务上的；
  只在没有时才回落到 `request_rows[].request_record_id`）。缺了就返回空
  ⇒ `loadRequestRows` 照旧 `no_request_ids`（不发卡、不写表），**不猜"最近一笔"**。
- `handleTopicMessageLocked` 多一个可选入参 `callerHandledCardId`：命中时**跳过作废那张卡**
  （由提交入口自己收成「已提交」），并且**默认不传时行为逐字不变**。

### 2.4 分派（`server/src/services/larkMvpService.js`）
- `handleCardAction` 里把 `event.action.form_value` 取出来（与 `value` 并列），
  `SUBMIT` 分派到 `arrivalConversation.handleCardFormSubmit(...)`；
  位置与既有「是 / 否」同段（在 `if (!draftId) throw` **之前**）。

---

## 3. 明确**不做**的事（避免"顺手统一"）
- 不给**销售**卡片加输入框（她说"只留按钮"针对销售方向，别拿这条去改那边）。
- 不新建"发采购申请时顺带发一张空白到货卡"的新入口（那张卡是**既有的**到货核对卡）。
- 不改 `confirmArrivalLocked` 的库存循环、不改 `inventoryService` 幂等、不改 `purchaseRequest` 表。
- 不把提交**直接**当成"确认入库"：入库闸门仍然是「是」（防写错账）。

---

## 4. 逐条对照（验收标准 → 实现 → 用例）

| # | 验收标准（第 1 节） | 实现 | 钉住的用例（`server/test/arrivalConversation.test.js`） |
| --- | --- | --- | --- |
| 1 | 表单容器在**卡片根节点** | `utils/larkCards.js` 新增 `arrivalReconcileForm`，由 `purchaseArrivalReconcileCard` 作为**根 `elements` 的一项**插入（明细之后、是/否之前） | 表单① |
| 2 | 容器内**恰好** `input` ＋ `form_submit` 按钮 | 同一个函数返回 `{tag:'form', elements:[input, button]}` | 表单① |
| 3 | 输入框 `name`/`required`/多行/`label`/`placeholder`/`fallback` 全可配 | `config/arrivalConversation.js` 的 `ARRIVAL_FORM_DEFAULTS` | 表单①、表单⑨ |
| 4 | 提交按钮 `name` 唯一、文案可配、`value` 带 `{action, draft_id}` | `arrivalReconcileForm` 的 button；`action = ARRIVAL_CONVERSATION_ACTIONS.SUBMIT` | 表单① |
| 5 | 卡片内交互组件 `name` **全局唯一**（飞书 200530） | 三个名字都从配置来且互不相同（`arrival_reconcile_form` / `actual_arrival` / `submit_arrival_reconcile`） | 表单①（深挖全卡所有 `name` 后断言无重复） |
| 6 | 既有「是 / 否」**一个都没少** | 那一行 `buttonColumns` **一字未改** | 表单①（＋既有 60 条全绿） |
| 7 | 提交走**同一条** `parseArrivalReconciliation` | `handleFormSubmitLocked` 把 `{text, messageId}` 原样交给 `handleTopicMessageLocked` | 表单②（`recognizer.calls[1]` **深度相等**）、表单⑫（源码级：整个 service 只有 **1** 处 `parseArrivalReconciliation`、**1** 处 `this.buildPlan(`） |
| 8 | ⭐ 与"在话题里说同一句"**逐字一致** | 同一份实现、同样的入参形状 | 表单②：模型入参 / `plan` / `differences` / `acceptance_text` / transcript 文本 / **新发出去那张卡片的 JSON** 全部 `deepEqual` |
| 9 | **不新增**解析实现 | 提交路径没有任何新的差异/数量逻辑 | 表单⑫ |
| 10 | 提交成功 → patch 她提交的那张卡成「已提交」 | `handleFormSubmitLocked` 在 `result.card === true` 时 `safeUpdateCard(…submitted copy)`；新增可选入参 `callerHandledCardId` 让管道**跳过**把同一张卡当"旧卡"再作废一遍 | 表单⑧（`updated.length === 1`、标题「已提交」、终态卡无表单无按钮）、表单⑭（她提交的不是最新那张时，最新那张照旧作废 = 两张各自的终态） |
| 11 | 没算出结果 → 与"说话"一致、卡片**保持可编辑**、**不放宽** | 只在 `card === true` 时 patch；既有三个提前 return 原样生效 | 表单⑦（`no_arrival_content`：不发卡 / 不写表 / **一张都不 patch** / 回执也**不说**"卡片发你下面"）、既有 60 条 |
| 12 | 同一次提交被**重投**幂等 | `messageId = 被提交卡片的 open_message_id` ⇒ 命中管道既有的"同一条消息只记一次"闸门 | 表单⑤（不重复喂模型 / 不重复发卡 / 不写表 / `submitDuplicate` 回执） |
| 13 | 重复提交 / 重复点「是」不重复入库 | 既有 `status === 'posted'` 闸门 ＋ 库存自身幂等（**未改**） | 表单⑤（连点两次「是」，`inventory.calls.length === 2`；入库后再提交也不动库存） |
| 14 | 空提交 → 明确提示 + **零写库** + 不喂模型 + 不发卡 | `handleCardFormSubmit` 的 `!text` 分支（含 `reopenFormAfterEmptySubmit` 只重渲染卡，**进同一批的串行队列**） | 表单④（4 种空值形状：`{}` / 空串 / 全空白 / 字段名不对；断言本地 transcript 与 status **一字未变**、`gateway.writes` 为空、卡片上表单与提醒都还在） |
| 15 | 老客户端**降级文案** | `input.fallback` = `card.form.fallbackText`（明说"直接在话题里回一句"） | 表单⑥ |
| 16 | ⭐ **文字入口原样保留** | `handleTopicMessage` **一行未改**；提交只是**多**一条入口 | 表单⑥（同一个 service 上两条入口都走通、卡片仍回在她说话的那条消息下面）、既有 60 条 |
| 17 | **配置先行** | `config/arrivalConversation.js`：`ARRIVAL_FORM_DEFAULTS` ＋ `card.submittedTitle/Message` ＋ `card.submitMissingNote` ＋ `replies.submitMissing/submitReceived/submitReceivedNoCard/submitDuplicate/disabled` | 表单⑨（覆盖 8 项文案/名字；并断言**没覆盖的仍有默认值** —— `card.form` 走**嵌套合并**，只改一项不会把其余项变成 `undefined`） |
| 18 | 红线：不写任何业务表 | 提交路径全程 `harness.gateway.writes` 为空（入库仍只由「是」触发） | 表单②③④⑤⑦⑩⑬ |
| 补 | 开关**真的能关掉这条路** | `handleCardFormSubmit` 也读 `PURCHASE_ARRIVAL_CONVERSATION_ENABLED`（与"在话题里说"同一个开关） | 表单⑬（关掉 ⇒ 连任务都不建、不调模型、不写表） |

## 5. 先红后绿

**红（动手前）** —— 只加用例、不动实现，`node --test --test-concurrency=1 test/arrivalConversation.test.js`：

```
ℹ tests 71
ℹ pass 60
ℹ fail 11
✖ 表单①⭐：输入框与提交按钮都在**卡片根节点的表单容器**里，name 全局唯一，既有「是/否」一个都没少
✖ 表单②⭐⭐：提交带文字 = 在话题里说同一句 —— 模型入参 / 计划 / 新卡片**逐字一致**
✖ 表单③⭐：提交之后点「是」→ 就是按**表单里说的数**入库（走的是既有的确认链路）
✖ 表单④⚠️：空提交 / 未填 → 明确提示 + **零写库** + 不喂模型 + 不发卡片
✖ 表单⑤：同一次提交被飞书重投 → 不重复喂模型 / 不重复发卡 / 不重复入库
✖ 表单⑥⭐：老客户端降级 —— 输入框带降级文案；**"在话题里说话"这条入口逐字保留**
✖ 表单⑦⚠️：提交里**没有**到货内容 → 与"在话题里说同一句"一样：不发卡、不写表（不许放宽）
✖ 表单⑧：提交成功 → 她提交的那张卡被 patch 成「已提交」终态（表单收掉，避免重复提交）
✖ 表单⑨：表单全部文案走配置（改文案不碰逻辑；只覆盖一项时其余项仍有默认值）
✖ 表单⑩：她提交的那张卡指向的任务已经找不到 → 可见失败（不静默、不写表、不喂模型）
✖ 表单⑪：接线 —— `card.action.trigger` 的 `form_value` 被取出来交给到货核对（不掉进销售那套）
```

⚠️ **60 条既有用例在红的那一轮里全绿** ⇒ 新用例量的确实是**新行为**，不是把旧断言改绿。

**绿（改完 + 补两条）** —— 同一个文件：`ℹ tests 73 / pass 73 / fail 0`。

⭐ 中途有一处**有用的事故**：`表单②` 第一次跑是红的，根因是我在**测试数据**里把 39 码那一行写成了另一个货号
（`req_39` 其实挂的是 `XHB8095/黑`）⇒ `buildPlan` 正确地判了 `difference_unmatched`。
**提交与说话两条路给出的是同一个结论**（两边都不出卡）—— 这反而正面证明了两条路同源；
修的是**测试数据**，不是判据。

## 6. 全量 2 次（在独立 worktree 里跑，**不在主工作区**）

```
$ cd .local/worktrees/arrival-card-form/server
$ node --test --test-concurrency=1     # 第 1 次
ℹ tests 1352   ℹ pass 1352   ℹ fail 0

$ node --test --test-concurrency=1     # 第 2 次
ℹ tests 1352   ℹ pass 1352   ℹ fail 0
```

（主工作区 `origin/main` 的基线是 **1339** 条；本次新增 **13** 条 ⇒ 1352。
⚠️ 全量只在**独立 worktree** 里跑，主工作区一次都没跑。）

**真启动一次**（`AGENTS.md` 第 5 条的精神；本次**没有**改 `app.js` 的 require 顺序，
但改到了 `larkCards` / `larkMvpService` 的加载链）：

```
$ PORT=41234 node src/app.js     # 独立端口，只探自己这一个 PID
$ curl -sS http://127.0.0.1:41234/health
{"status":"ok","version":"0.3.0",……}
```

## 7. 不确定处 / 需要她知情的判断（**如实列出**）

0. ⭐ **卡片动作返回的 toast 她其实看不见**（动手时核出来的既有事实，不是本次引入的）：
   `routes/larkEvents.js` 的 `card.action.trigger` 是 `setImmediate(...)` 里跑 service、然后
   **无条件** `return { toast: { type: 'info', content: '已收到，正在处理' } }` ——
   service 返回的 `toast` 只写进 `lark.card.handled` 日志。
   ⇒ 所以本件里"**明确提示**"一律**落在卡片上**（空提交 → `card.submitMissingNote` 写进她那张卡），
   toast 只是日志 / 可观测性口径（与既有 `visibleFailure`"patch 卡 ＋ 回文字"的理由完全一致）。
   ⚠️ 若将来要把 service 的 toast 真的显示给她，那是**改路由的同步响应**，会影响所有卡片动作，**本件不碰**。
1. ⚠️ **`required: true` 只是前端闸门**（官方原文：未填写则前端提示"有必填项未填写"、
   **不会**发起回传）⇒ 我按"重放 / 模拟 / 降级都可能送空串进来"做了**服务端兜底**（表单④）。
   若她的客户端真能发出空提交，她看到的是卡片上那句提醒，**不会**有任何写入。
2. ⚠️ **提交成功之后那张卡是「已提交」（灰）**，而**真正要点的「是/否」在下面那张新卡上**。
   我没做"就地在这张卡上直接改成是/否"（那要动既有那条"每次都在话题里重发新卡"的可见性结论
   —— 2026-10-07 真机 23:37 的教训就是"猜她在看哪张卡"）。
   ⇒ 如果她希望**只留一张卡**，那是另一个决定，需要她拍板。
3. ⚠️ **"提交"不是"入库"**：入库闸门仍是那张新卡上的「是」（防写错账）。
   她的原话是"以这个来作为**触发后续的到货验收**"，我按"触发核对"实现，
   **没有**把提交直接当成"确认入库"。
4. ❓ **`no_arrival_content` 时卡片保持可编辑**（不 patch 成「已提交」）。
   理由：把"没算出来"写成"已提交"就是谎报。代价是**同一次提交理论上可以重复点**
   （但重投会被 `duplicate_message` 挡住，且**零写入**，所以不会重复入库）。
5. ❓ **空提交会重渲染一张卡**（表单 + 提醒）。这是**多一次远端 patch**，换的是
   "她能在卡片上直接改、不用回话题"；失败只记 `submit_empty_reopen_skipped`，**不影响任何业务写入**。
6. ⚠️ **本机没有对真实飞书客户端验证过**卡片渲染（输入框在群里长什么样、老版本降级长什么样）。
   真机验证需要部署 + 她本人拿手机点一次 —— **部署必须拿到她当次的命令**（本次没有部署）。
   我能给的最强证据是：**卡片 JSON 与官方文档的字段逐一对上**（第 0 节表格）＋ 结构断言（表单①）。

