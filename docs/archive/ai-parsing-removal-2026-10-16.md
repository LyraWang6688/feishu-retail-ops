# 「与 AI 分析有关的都停掉」—— Lead 批准与执行范围（2026-10-16）

## 一、业务负责人的口径（逐字）
> 「**都停掉，与 AI 分析有关的都停掉**，目前我们就是**扫码和表单或者在前端 UI 交互**，**其余录入方式不支持**」
> 追问后：① **停掉自动出单**（采购申请改人工录）② **连代码一起删**（照她 2026-10-07 停私聊那次"代码里一行不留"）
> 补充（她今天又说的）：「**为什么采购要删除，因为目前相关的字段已经没有了，而且我们的采购使用的扫一扫里的补货了，所以这条链路就没有用了**」

## 二、⭐ 事实核对（只读盘点结论，已核 ✓）
- **采购「AI 解析 → 自动出单」早在 2026-10-09 就已删除**（PR #308）：`purchaseQuantityPolicy.js` 文件不存在 · `purchaseWebhookService.js:315` 写明 recognizer 已删 · `doubaoService.js:840` 写明 `parsePurchaseReportText` 已删 · `routes/larkEvents.js:142-157` 的采购分派整段已删 ⇒ **她那句判断与事实一致 ✓**
- **群聊销售文字入口 2026-10-12 已退场**（`acceptMessage:720` 群消息只记一条日志 return ✓）
- ⭐ **当前运行期没有任何可达的 AI 解析调用**（可自证：`parseSalesText` 在 `server/src` **0 调用方** · `parseArrivalReconciliation` 只在死路上 · `doubaoService` 全仓只在 `larkMvpService.js:7` 被 require）
  ⇒ **这一刀的性质 = 删死代码** ✓（不是"停活链路"）

## 三、✅ Lead 批准的执行范围（回答盘点里的 C1–C6）
| 编号 | 问题 | 裁决 |
| --- | --- | --- |
| C1 | 「连代码一起删」是否覆盖 2026-10-12 的"只标注不删" | ✅ **以她 2026-10-16 的"连代码一起删"为准** ✓；⚠️ 但**能迁到扫码/工作台入口的判据先迁**（她 10-07 私聊先例 = "测试全部迁移" ✓），**迁不了才删**，且**每条留痕**（删前逐字 → 为什么删 → 依据）✓ |
| C2 | 到货**对话**解析算不算 | ✅ **算，删**（它 2026-10-12 起就不可达 ✓ 验收已改"工作台 + 扫码" ✓） |
| C3 | 非 LLM 的文字入口（`messageGate` 关键词闸门 / `salesThreadProgressService` 的话题文字进展） | ✅ **一并停**（她说"其余录入方式不支持" ✓）：`messageGate` 只喂死路 ⇒ **删** ✓；`salesThreadProgressService` **只删"话题文字进展"那半** ✓ 🔴 **`completeDealFromCard` 必须留**（「确认成交」卡按钮**可达** ✓） |
| C4 | 现在写 `docs/ai-parsing-removal-2026-10-16.md` 吗 | ✅ **写**（红线只约束"第一步只读"，现在进入执行阶段 ✓） |
| C5 | 「人工录」= 工作台表单吗 | ✅ **不是**：**她已明确"采购用的就是扫一扫里的补货"** ✓ ⇒ ⭐ **采购申请的人工入口 = 扫码页「补货」**（`POST /s/:number` → `publishPurchaseRequest` ✓ **现役、免确认** ✓）⇒ 🔴 **不需要新做工作台表单** ✓ |
| C6 | 线上 `.env` 的 `TEXT_LLM_*` 删不删 | ❌ **不动**（照她 10-07 先例：线上 `.env` 的开关**没动**，只是没人读 ✓） |

## 四、🔴 保留清单（B 类，**一个字都不许误删** ✓）
`purchaseWebhookService` 全体（**已零模型** ✓）· 表变更事件入口本身 · 采购查询/到货验收接口与本体（`confirmLocked` / `confirmBatchArrival` / `buildPlan` …）·
`larkMvpService` 的**卡片动作骨架**（补样品 / 到货「是」/ 二次交付 / 确认成交 / 团购券到账 / **未知动作兜底人话** ✓）·
`salesThreadProgressService.completeDealFromCard` · 配品销售（表/表单录入 ✓）· 扫码链路全部 · 共享落库层 ·
`salesMovements` / `salesTradeTypePolicy`（🔴 **冻结文件 `scanWriteService.js` 在用** ✓）· 9 点推送与 `data/purchase_group_messages/` ✓

## 五、执行顺序（**先写哨兵，再删代码** ✓）
```
0. 落本档 + 同步 docs/README.md 索引 ✓
1. **先写"零残留"哨兵**（照 purchaseIntakeRetired.test.js 形状）：断言 src 里
   `parseSalesText` / `parseArrivalReconciliation` / `recognizer` / `TEXT_LLM` 命中 0、`doubaoService.js` 不存在 ⇒ **先红后绿** ✓
2. 删叶子配置：messageGate → saleIntents → salesDepositTerms → salesMissingInfoText → afterSalesFlow → llmModels ＋ .env.example 的 TEXT_LLM
   🔴 **同时成对迁移** `prunedResidueSentinel.test.js:55-65` 哨兵-3（它正方向钉着 `TEXT_LLM*` / `SALES_MISSING_INFO_*` 必须留 ⇒ 必须一起改 ✓）
3. 删 `doubaoService.js` 整文件 ＋ `larkMvpService.js:7/219/232/321` ＋ 清 `:177-208` 过期注释块
4. 删 `purchaseArrivalConversationService` 的 `handleTopicMessage` / `handleTopicMessageLocked` / `trimTranscript` ＋ recognizer 注入
   🔴 **保住** `confirmLocked` / `confirmBatchArrival` / `buildPlan` / `loadRequestRows` ✓
5. 判据成对处理：21 个假 `recognizer` 注入文件改成不注入 ✓；纯 AI 用例**能迁就迁、不能迁才删**（每条留痕 ✓）；清 4 处死 helper；改 `hardcodedChineseWhitelist.json:76` ＋ e2e 脚本 ✓
6. `pnpm test` 全绿 ＋ `v1:schema-check:all`（只读）⇒ 开 PR（**不合并** ✓）
🔴 全程：**严禁部署** · 严禁飞书 CLI · 不许 `--admin` · `scanWriteService.js` 一个字不动（**它里面没有 AI 代码** ✓ 只有 `:21` 一句注释）
🔴 不碰正在被别的任务占着的文件：`routes/scanPage.js`（券机制在跑 ✗）· `routes/workbench.js`（订单性能在跑 ✗）⇒ 遇到就**只报不改** ✓
```
