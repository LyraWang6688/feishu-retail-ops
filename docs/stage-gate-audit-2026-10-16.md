# 「分阶段判据（待激活）」体检 —— 谁是真分阶段、谁是**永远变不真的自足替身**

> 只读盘点 ＋ 一处整改。base = `main 21844e3`（开工前 `git fetch` 核过 ✓）
> 起因：`voucherPaymentRules.test.js` 里 4 条"闸门"**永远打 `[待激活]`** ✗ —— 而它们**只测文件内本地 lambda、
> 不 import 任何实现** ⇒ **接线/落地之后也变不成真判据** ✗，会让人误以为"功能还没做"（今晚骗过 Lead 一次 ✓）

## 1. 全仓命中（`grep -rn '待激活' server/test | wc -l` = **51**，分布在 **10** 个文件）

| 文件 | 命中 | 判定 | 依据 |
| --- | --- | --- | --- |
| `voucherPaymentRules.test.js` | 7 | 🔧 **自足替身 ⇒ 本次已整改**（删 4 条替身 ＋ 换成 `AC-VR-COVER` 覆盖证明 ✓） | 4 条闸门只测文件内 `unpaidByFaceValue` / `paymentLineOf` / `isVoucherMethod` 等**本地 lambda** ✗；真实实现在路由/服务内部、**未导出** ⇒ 无法 import ✓ |
| `multiItemOrderRoute.test.js` | 6 | ⭐ **真分阶段**（**不动** ✗） | 闸门用 `isWired(source)` **真读 `routes/scanPage.js` 源码**（查 `multi_items` / `multiItemWriters()`）⇒ **接线后自动变真** ✓；另有真行为断言 ＋ 探针（`:250`）✓ |
| `saleAmountAndSizeRequired.e2e.test.js` | 8 | ⚠️ **自足替身（我写的那份 ✗，本次未处理）** | **0 个 `require('../src/…')`** —— `assertGatePending()` 只会打印 ⇒ **必须人工改**才可能变真 ✗ ⇒ **建议下一刀按本任务同一方法处理** ✓ |
| `paymentStatusLegacyReject.test.js` | 7 | ❓ **未逐个核**（如实标） | 该文件 import 了 src（3 行）⇒ 有可能真分阶段；**但本次预算内没逐条看闸门** ⇒ 不猜 ✗ |
| `purchaseAmountByRealm.test.js` | 8 | ❓ **未逐个核** | 同上（import 3 行） |
| `purchaseAmountRealmWiring.test.js` | 1 | ❓ **未逐个核** | 同上（import 3 行） |
| `scanMoneyPageTwoStepVerify.test.js` | 2 | ❓ **未逐个核** | 同上（import 5 行）；⚠️ 该文件被全量跑**排除**（既有约定 ✓） |
| `skipPathsMinimal.test.js` | 6 | ❓ **未逐个核** | import 1 行；⚠️ **注意**：它的「待激活」是**由 `saleSuccess` 地标决定**的**真闸门**（落地后自动变真 ✓）—— 与本次那种"自足替身"**不同** ✓ |
| `successPageAcceptance.test.js` | 2 | ❓ **未逐个核** | import 1 行 |
| `saleSuccessHintRemoval.test.js` | 1 | ❓ **未逐个核** | import 1 行 |

**判定口径**（写清，免得后来人各按各的理解 ✗）：
- **真分阶段** = 闸门的"激活条件"读的是**真实源码/真实行为**（如 `isWired(source)`、`saleSuccess` 的值）⇒ 落地后**自动**变真断言 ✓ **不动** ✗
- **自足替身** = 闸门只断言**文件内自造的 lambda/常量** ⇒ **永远不会**变真 ✗ ⇒ 要么**改成真判据**（方案 A），要么**删 + 覆盖证明**（方案 B）✓

## 2. 本次整改（`voucherPaymentRules.test.js`）

**为什么取方案 B（而不是 A）**：那 5 条规则的**真实现都在 `routes/scanPage.js` / 服务内部**，
**没有导出成纯函数** ✗，而本刀**不许碰 `server/src/**`** ⇒ **技术上进不了方案 A** ✓
⇒ 删掉 4 条替身 ＋ 立 **`AC-VR-COVER` 覆盖证明**（**机器可查**，不是口头承诺 ✓）：

| 规则 | 覆盖它的真判据（`voucherPaymentRoute.test.js`） |
| --- | --- |
| ① 差额 = 券【面值】 | `AC-VP1` · `AC-VP2b` |
| ② 明细那一笔 = 【平台结算款】 | `AC-VP1` · `AC-VP4b` |
| ③ 那一笔状态 = 【待平台结算】 | `AC-VP3` |
| ④ 券方式 ⇒ 金额可空 | `AC-VP2b` · `AC-VP7` |
| ⑤ 券没映射 ⇒ `scan.write.voucher_method_unmapped` | `AC-VP5` · `AC-VP6` |

`AC-VR-COVER` 会**真读** `voucherPaymentRoute.test.js`，断言上面每个 AC 编号**确实存在**（≥10 条）
＋ 本文件**不许再有** `^test('…待激活` / `^console.log('[待激活]` 的壳 ✓
⇒ **覆盖者被改名/删掉 ⇒ 本文件红** ✓（**判据总数净减 4 → 换来 1 条不可空跑的覆盖证明**，减的每条都有覆盖者 ✓）

**改前逐字 → 改后逐字 → 依据**（逐条，写在源文件头部 ✓）：
- 改前逐字：`test('③ 待激活闸门：**差额按面值**…')` ＋ `…('**明细金额 = 平台结算款**、**状态 = 待平台结算**…')`
  ＋ `…('**券方式金额可空**…')` ＋ `…('+ 探针：**券没映射到方式…**')`（各自 `console.log('[待激活] …')` 后结束 ✗）
- 改后逐字：**这 4 条删掉** ⇒ `AC-VR-COVER`（见上表 ✓）
- 依据：① 她 2026-10-16 逐字（差额按面值 / 明细按结算款 / 状态待平台结算）② **#704 已落地** ⇒ 真判据在路由级 ✓

## 3. 建议下一步（**不擅自做** ✗）

1. ⚠️ **`saleAmountAndSizeRequired.e2e.test.js`（我自己写的那份）** ⇒ 建议按本任务同一方法处理（它现在也是"自足替身" ✗）
2. ❓ 上表 5 个 **"未逐个核"** 的文件 ⇒ 建议再开一刀**逐个看闸门**（判据：闸门的激活条件是否读**真实源码/行为** ✓）
3. ⭐ **`multiItemOrderRoute.test.js`（一单多货那 13 条）不是自足替身** ✓ —— 它真读路由源码，**接线后自动变真** ✓
   ⇒ 你今晚被它的"待激活"骗过，**但那 13 条本身没错** ✗（误导来自"待激活"这个词，不是判据 ✗）

## 4. 未做项（如实）

- 上表 **5 个文件未逐个核**（预算内没做，**没有猜测性结论** ✗）
- 🔴 `server/src/**` **一个字节没改** ✓ · `scanWriteService.js` 未动 ✓ · 判据**没删/skip/放宽任何真判据** ✓ · 未部署 ✓
