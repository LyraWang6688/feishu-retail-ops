# 群查单链路退场（2026-10-12，业务负责人拍板）

> 她的原话（逐字）：「**1 已经不需要了，不会在群里问了！整条下掉！**」
> （先前的"卡片改文字"方案**作废** ✗ ⇒ 改成**整条退场** ✓）

## 一、为什么是"删死代码"
三条判据（含 test/scripts 一起 grep）都指向**生产 0 调用方**：
`handleQuery` / `resolvePendingCandidate(s)` / `storePendingCandidates` 只被 `test/saleLookupService.test.js` 调；
`isLookupIntent` 只 import 从不用；`larkMvpService` 只是 `new SaleLookupService(...)` **构造了从不调**。
⇒ 生产行为**不受影响**（真启动对照：同一条群消息回应**逐字相同** ✓）。

## 二、退场清单（做了什么）
| 位置 | 动作 |
|---|---|
| `services/saleLookupService.js` | **整文件删**（查单那一半 + 只读网关视图；日期窗口工具已先**逐字搬**到中性文件） |
| `config/saleLookup.js` | **整文件删**（唯一消费者就是上面那个 service） |
| `utils/larkCards.js` | 删 `saleLookupCard`（退场后无调用方） |
| `config/saleIntents.js` | 删 `MESSAGE_INTENTS.SALE_QUERY` + 5 个中文/英文别名 + `isLookupIntent` |
| `services/larkMvpService.js` | 删 `require('./saleLookupService')` · `this.saleLookup = new SaleLookupService({...})` · 删掉**未使用**的 `isLookupIntent` import |
| `utils/salesDateWindows.js`（**新**） | 日期窗口工具**逐字搬来**（`SHANGHAI_OFFSET_MS`/`DAY_MS`/`asDate`/`shanghaiDayKey`/`shanghaiDayStart`/`lookupWindowStart`/`isWithinLookupWindow`），原块 **1096 字符原样 1 处** ✓ |
| 5 个消费者 | **只改 import 路径**（`secondDeliveryService` · `pendingDealPushService` · `reportedAt` · `pendingPushCandidateService` · `voucherSettlementService`）—— 逻辑与断言**一个字没动** ✓ |

## 三、测试覆盖去向（**一条都不许静默丢**）
| 原测试 | 去向 |
|---|---|
| `test/saleLookupService.test.js`（33 条：候选查询/卡片/上下文/群话题回复/保守判据…） | **随旧链路退场** ✓ —— 它们验的链路在生产**已无调用方**（死代码）⇒ 行为不再可达，无需再有哨兵 |
| ↳ 其中「候选查询窗口：4 天命中 / 6 天不命中」 | ⭐ **能力迁到新文件直测**：`test/salesDateWindows.test.js`（AS1/AS2/AS3：`asDate` 秒/毫秒/ISO/坏值 · UTC 深夜算上海次日 · **4 天命中 / 6 天不命中** 同口径 ✓） |
| `test/saleLookupCard.test.js` | **随卡片退场** ✓（卡片本身已删 ⇒ 无对象可测） |
| `test/saleLookupConfig.test.js` | **随配置退场** ✓（`config/saleLookup.js` 已整份删） |
| `test/privateChatRemoval.test.js` 里那条文件清单 | ⭐ 那 1 处是"拿查单链路当私聊哨兵"⇒ **改成别的链路**（`salesThreadProgressService`）✓ **哨兵不删** ✓ |
| `test/cardUpdateMulti.test.js` 相关行 | 只是**注释**提到 `saleLookupCard` ⇒ 改注释 ✓（没有活断言） |

## 四、**明确保留**（一个字没动 ✗）
- ⭐ **"认不出"的人话兜底** `UNSUPPORTED_INTENT_REPLY`（`config/messageGate.js`）—— 群里说话必须有回应 ✓
- `normalizeMessageIntent` / `isAfterSalesIntent`（售后意图仍用）✓
- ⭐ `larkMvpService.replyCard` —— 退场后**仍有 2 个活调用方**（`larkMvpService` 内部话题回落 + `purchaseArrivalConversationService` 采购到货卡）⇒ **保留** ✓
- 私聊/群消息准入 · 销售录单 · 采购链路 · ② 二次交付提醒（`secondDeliveryService.sendCardToChat`）· ③ 9 点待处理单推送（`pendingDealPushService`）✓
