# 销售录单 / 验收提交后的「是否打印」轻页（2026-11-17 · 业务负责人拍板）

> 背景：库存手工调整已经有「是否需要打印？」弹窗；业务负责人要求把同一套逻辑复用到
> **销售鞋类录单**（资金页提交成功后）和**验收到货**（提交后），打印这次涉及的**最新库存标签**。

## 一、三个入口

| 场景 | 弹窗时机 | 打什么 |
| --- | --- | --- |
| 库存手工调整 | 保存后立刻弹（既有） | 这一款 |
| 销售鞋类录单 | **资金页提交成功**（异步销售 job 已入队）后 | 本单每款鞋各一张；配品不打 |
| 验收到货 | POST /purchase/arrivals/accept 返回 job_id 后 | 本次验收每款各一张 |

⚠️ **销售也是异步写库存**：资金页只做校验 + 冻结 payload + 入队，然后先回执；真正的明细/收款/库存由 salesAsync worker 后台写。
⇒ 轻页点「打印」只记打印意图，**等销售 job 成功后才入队**（与库存调整/验收同形）。
真正的库存写入在 server/src/routes/scanPage/handlers/payment.js 的 salesAsync 分支 + services/salesAsyncWorker.js。

## 二、多货品：一张轻页，默认全勾，可取消

- 页面列出这次涉及的所有货品；
- **默认全勾选**；
- 她可以取消某几款；
- 点「打印选中」只给勾中的款记打印意图，成功后**直接 303 回工作台**（不再有结果页）；
- 点「不打印」直接回工作台；
- 已无库存的款：真正入队时跳过并记日志，不阻塞主流程；
- 打印意图提交失败才回工作台并带错误 toast（提示重新打印）。

同款多尺码 = 一张标签；不同货号/颜色/类别 = 不同款/不同标签。

## 三、申请次数

表：标签打印（tblcUksCp3EmbmBa）

匹配键 = **打印货号 + 来源**：

- 有这一行 ⇒ 申请次数 +1；
- 没有 ⇒ 新建一行，申请次数 = 1；
- 打印日由飞书自动填，代码不写；
- 申请次数 = **打印任务创建次数**，不是物理出纸成功次数；
- 批量打印表单**不参与**（一行可挂多个货号，无法按货号计数）。

来源值以生产表为准：批量打印 / 扫码打印 / 库存调整打印 / 销售录单打印 / 验收录单打印。没有「按编号打印」。

## 四、实现落点

| 件 | 落点 |
| --- | --- |
| 一次性令牌 | server/src/services/printPromptService.js + printPromptRuntime.js（内存、15 分钟、一次性） |
| 轻页 | server/src/views/printPromptPage.js（文案在 config/printPrompt.js） |
| 页面路由 | server/src/routes/printPrompt.js（GET 展示 / POST 建任务或意图） |
| 销售入口 | server/src/routes/scanPage/handlers/payment.js：异步销售 job 入队后 303 到轻页 |
| 销售打印意图 | server/src/services/inventoryPrintIntentService.js（支持销售类型）；salesAsyncWorker 成功收口后 flush |
| 验收入口 | server/src/routes/workbench/purchase.js：accept 返回 print_prompt_url；job 成功后 flush 打印意图 |
| 验收打印意图 | server/src/services/inventoryPrintIntentService.js（扩成支持多货品 + 验收类型） |
| 打印请求记录 | server/src/services/labelPrintRequestLogService.js（搜索 +1 / 新建 1） |

## 五、边界

- 销售（异步）：轻页 POST 只记打印意图；销售 job 成功后才入队，来源 = 销售录单打印。
- 验收：库存还在后台 job ⇒ 轻页 POST 只记打印意图；job 成功后才入队，来源 = 验收录单打印。
- 没有同步兜底：三条链路都只认「job 成功后再入队」。
- 打印失败/无库存**不回滚**销售/验收/库存调整，只提示。
- 轻页令牌是一次性能力凭证，不要求登录；过期/用过返回 410。
- 本链路**不写生产 Base**（代码/测试阶段）；部署需业务负责人当次明确指令。

## 六、验收（已写先红）

- server/test/printPrompt.test.js：令牌一次性/过期、页面默认全勾、销售写意图（每款一条）、验收写意图、坏令牌 410、空选回工作台；
- server/test/labelPrintRequestLog.test.js：首次新建次数 1、同货品同来源 +1、不同来源分行、表单跳过、失败不抛；
- server/test/inventoryPrintIntent.test.js：验收一个 job 多款 ⇒ 每款一个任务（来源=验收录单打印）；
- server/test/labelPrintFormIntake.test.js：来源守卫 + schema 映射（含申请次数）。
