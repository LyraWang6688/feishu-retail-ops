# 扫码页四 tab 统一库存口径 ＋ 抽象成一处配置（2026-10-16 晚）

> 状态：**已实施**（分支 `feat/scan-stock-policy`）。开关**缺省关着** ⇒ 线上行为**逐字节不变**；
> 她确认后再把 `SCAN_STOCK_POLICY_ENABLED=true` 打开。
> 上一份只读诊断：[scan-stock-state-consistency-2026-10-16.md](scan-stock-state-consistency-2026-10-16.md)（货品 8516 · 44 码那一双）。

## 1. 需求 = 业务负责人 2026-10-16 20:5x 亲口定的口径（逐字）

> 「既然四个页面用的都是**实时库存**，那就**统一不用看状态**，只要在实时库存里**这个编号有尺码记录，
>  就都是有货**……也就是说**口径和库存是一样的了**。另外，实际上对于**退货**来说，它展示的是
>  **实时库存里所有的数据**。但像我们的**补货、销售以及库存**，尺码范围**男款是 38 到 48，
>  女款是 34 到 43**。而且我们之前有个规定要分**普通码和特殊码**：**普通码有货无货都要展示出来，
>  特殊码无货时则折叠**。所以你需要看一下，**补货、销售以及库存这边的口径是不是也是一致的**，
>  这个口径其实**也可以做一个配置**。因为对于我们的销售、库存还有补货来说，**它们底层逻辑都是一样的，
>  只不过在前端展示的方式不同，所以完全可以抽象出来**」

## 2. 新配置叫什么、放在哪、为什么

| 项 | 值 |
| --- | --- |
| 文件 | `server/src/config/scanStockPolicy.js` |
| 导出 | `SCAN_STOCK_POLICY` · `resolveScanStockPolicy(env)` · `countInStockOf(row, columns, policy?)` · `isInStock` · `legacySellableCountOf` · `liveInventoryCountOf` · `sizeRangeOf` / `enterableSizesOf` / `normalSizesOf` / `specialSizesOf` |
| 开关 | `SCAN_STOCK_POLICY_ENABLED` —— **显式布尔**（`readFlag`），**缺省 `false`** |
| 变量取值实现 | `config/envValue.js`（没设 → false；**空串 → 关**；认不出的值 → **当场抛错**） |

**为什么叫 `scanStockPolicy`**：它答的是「扫码页这条链上，**什么算库存 / 什么算有货**」这一条**业务口径**
（policy），而不是"这一页长什么样"（那是 view 参数）。名字里的 `scan` 是作用域（只有扫码页四个 tab 读它），
`Stock` 是对象（实时库存），`Policy` 说明它是**会变的口径**——她哪天再改，改的就是这一个文件。

**为什么放 `config/` 而不是 `views/`**：她 2026-10-05 定的「配置先行」＋ 2026-10-16「这个口径其实
也可以做一个配置」。改前那条判据**写死在渲染层**（`views/scanPageRealm.js:184`
`const SELLABLE_STATES = Object.freeze(['门盒', '样品'])`）——**前端在决定"算不算"**，
这正是"四页打架"的根因之一。现在：**口径的家在 `config/**`；视图层只决定"怎么摆"**。

配置里三块（各自都**指向既有那一处**，不复制第二份）：

- `inStock` —— 「有货」的两种口径（开着 = 实时库存里有记录；关着 = 门盒 + 样品）；
- `sizes` —— **`ranges` 就是 `SCAN_PAGE.sizeSegments.ranges` 本身**（`===` 同一个对象）；
  语义名 `enterable`（可录）/ `normal`（普通码，缺码判据）/ `special`（特殊码，无货折叠）；
- `display` / `realms` —— 普通码**都展示** · 特殊码**无货折叠**（复用**已有那一处** helper
  `views/scanPageRealm.js#foldedSpecialRowsOf`）· **退货页全展示实时库存里的所有数据**
  （与另外三页"有货才显示"的**展示**口径不同 ⇒ 写进配置注释，免得下次被"顺手统一"✗）。

## 3. 「有货」判定：改前几处 vs 改后一处

| | 改前 | 改后 |
| --- | --- | --- |
| 判据本体 | **写在渲染层**：`views/scanPageRealm.js:184` 的 `SELLABLE_STATES` ＋ `sellableCountOf` 的函数体 | **一处**：`config/scanStockPolicy.js` 的 `countInStockOf`（唯一那个 `policy.enabled ? … : …` 二选一） |
| 销售页 | `saleSizeGroups` → `sellableCountOf`（渲染层那个函数） | `saleSizeGroups` → **转发** `countInStockOf` |
| 补货页 | `purchaseSizeLines` → `sellableCountOf` | 同上（**同一个** `countInStockOf`） |
| 退货页 | `returnFormHtml` → `purchaseSizeLines` → `sellableCountOf` | 同上（**同一个**） |
| 库存页 | 本来就是"都算"（`row.total` = 那一行所有状态格之和） | **没动**，作为基线对照；判据与它同一个数 |

⇒ 视图层现在**一个 if 都不写**（`views/scanPageRealm.js` 的 `sellableCountOf` 只剩一行转发；
`isSellableCell` 已删、搬进配置）。**前端不再决定"算不算"**。
判据：`test/scanStockPolicyConfig.test.js` 的 **AC-STP3**（源码哨兵）。

## 4. 新口径的取数是什么（为什么不新增读表）

服务层（`services/scanPageService.js:1298`）的行集 = 「实时库存」记录建出来的 buckets ∪ 可录范围内的缺货尺码，
且 `row.total` = 那一行**所有状态格之和** ⇒

```
total > 0   ⟺   这个【编号 + 尺码】在「实时库存」里至少有一条记录
```

所以新口径**零新增读**、**零新增字段**：全在**扫码那一次已经取到的**视图模型里。
「尺码未识别」那一行（`unknown_size`）不是一个【编号 + 尺码】⇒ 一律 0（不混进来）。

## 5. 验收标准（先写后做 · 每条都能真红）

| 判据 | 内容 | 位置 |
| --- | --- | --- |
| **AC-ST5** | ⭐ 核心：**同一份实时库存 ⇒ 四页「有货」集合完全一致**（库存页那一行的合计 ＝ 销售页现货段 ＝ 补货页现货 tag ＝ 退货页列出的尺码）；含「仓库 2 双」与「未标状态 1 双」**都算有货**（"统一不用看状态"）；并**反向自证**：拿旧口径算同一份数据 ⇒ 与库存页**必须对不上**（否则这条什么都没钉） | `test/scanStockPolicyUnifiedOn.test.js` |
| **AC-ST6** | **她那把 44 码复刻**（只有「未标状态」= 1）⇒ 四页都认为有货：销售页进「有货（现货）」段（**不再**写"这一款现在没有可选的尺码"）· 补货页 `1 双`＋`现货`（**不再** `0 双/缺码`）· 退货页列出 44 且库存上限 = 1（**不再**写"没有可退的库存"）· 库存页 44 行四格 `—\|—\|—\|1`（**没变**，它本来就是对的） | 同上 |
| **AC-ST7** | ⭐ **零回归**：开关**关着** ⇒ 四个 tab 与今天**逐字节相同**。两层证据：① **整页 HTML sha256**（3 夹具 × 4 tab = **12 个**，取自**改口径之前**那一份渲染器，两个独立进程各跑一次逐字相同）；② 四个领域块的**逐字原文**（`assert.equal`）；③ **判据是活的**（41 从缺码变有货 ⇒ 四个 tab 的哈希都变）；④ 夹具/哈希/快照身份对得上 | `test/scanStockPolicyZeroRegression.test.js` |
| **AC-ST8** | **普通码**（A 38–45 / B 36–41）**有货无货都展示** · **特殊码**（A 46/47/48 · B 34/35/42/43）**无货折叠**；有货的特殊码照旧全展示；**没有任何一个可录码凭空消失**（表体 ∪ 折叠块） | `test/scanStockPolicyUnifiedOn.test.js` |
| **AC-ST9** | **库存页与另外三页对同一份数据的 total 相同**：逐行 `sellableCountOf === row.total`；判据之和 = `view.total`；库存页标题「共 N 双」= 补货页逐格「N 双」之和 = 退货页每行数量之和 | 同上 |
| **AC-STP1…5** | 开关语义（显式布尔、缺省 false、不许 `\|\|` 兜底）· 尺码范围指向既有配置（同一对象、不许抄第二份数字）· 判据只有一处（源码哨兵）· 旧口径算法**逐字等价**（多种行形状逐条对表）· 展示规则与四页口径都在配置里 | `test/scanStockPolicyConfig.test.js` |

### AC-ST6 怎么证（那把 44 码）

夹具就是她的形状（`test/fixtures/scanStockPolicyViews.js` 的 `FULL_SIZES_BLANK_VIEW`：男 A 段 38–48 全列，
**只有 44 码 1 双、且「所属状态」为空**）。开关开着跑一遍，**从 HTML 里读**四页的结论
（不借内部函数 ⇒ 判的是"页面真的这么显示"）：
销售页现货段 = `['44']` · 补货页 44 那一格 = `1 双`/`现货` · 退货页列出 `44` 且 `data-stock="1"` ·
库存页 44 行 = `—|—|—|1`。

### AC-ST7 怎么证（零回归）

开关**缺省关着**：① 12 个整页 sha256 与改前留档（`test/fixtures/scanStockPolicy.legacyHtml.json`，
写明了 `capturedFrom: origin/main e1657f1 (+ 512f991 诊断)`）逐字相同；② 四个领域块与
`test/fixtures/stockStateConsistency.golden.json`（前一位执行者的诊断留档，本刀之前 AC-ST3 在**本次改动前**的
代码上跑过是绿的 ⇒ 它就是"今天"的逐字）`assert.equal` 逐字相同。
🔴 留档是**改口径之前**生成的 —— 本刀实施前先跑了一次全套哈希（两个进程一致），实施后**同一条命令**仍逐字相同。

## 6. 既有判据的成对迁移（改前逐字 → 改后逐字 → 依据）

| 文件 | 改前逐字 | 改后逐字 | 依据 |
| --- | --- | --- | --- |
| `test/scanNoSpecialSizes.test.js` AC-NS4 | `/const SELLABLE_STATES = Object\.freeze\(\['门盒', '样品'\]\)/` 在 `views/scanPageRealm.js` | 那份字面量在 `config/scanStockPolicy.js`（`LEGACY_SELLABLE_STATES`）＋ realm 只**引用**（`= LEGACY_SELLABLE_STATES`） | 她 20:5x「也可以做一个配置」；**没放宽**（字面量仍只有一处） |
| `test/scanSpecialSizeFoldMore.test.js` AC-MF1 | `range?.special` 在 realm 里**恰好 1 处** | 配置里恰好 **1 处** ＋ realm 里 **0 处** | 同上；从"1 处"变成"1 处 ＋ 0 处"（**更强**） |
| `test/stockStateConsistency.test.js`（AC-ST0…ST4） | 把「未标状态**不算**有货」当**当前唯一口径** | **断言一条都没删**；只在 AC-ST1 开头加**前提自证** `SCAN_STOCK_POLICY.enabled === false` ⇒ 本文件 = **开关关着（今天）那条路**的基线 | 她 20:5x 改了口径 ⇒ 旧口径不是"错判据"，而是**零回归基线**；新口径钉在 AC-ST5/ST6 |
| `test/scanPageRealms.test.js` AC2 | 注释说"当前可卖 = 样品 + 门盒" | 注释说"**开关关着时**可卖 = 样品 + 门盒"（**断言没动**） | 同上 |

⇒ 含前一位执行者那 5 条（AC-ST0…ST4）在内，**没有任何一条被删 / skip / 放宽**。

## 7. 实施证据（两遍全量 ＋ 变异 3 组）

**两遍全量**（`cd server && /usr/local/bin/node --test --test-concurrency=1`，**系统 node** —— DSH 自带 node 加载不了 `sharp`，会假红几十个文件）：

| | tests | pass | fail | skipped | **真 EXIT** |
| --- | --- | --- | --- | --- | --- |
| 第 1 遍（合并前） | 2974 | 2967 | 0 | 7 | **0** |
| 第 2 遍（合并前） | 2974 | 2967 | 0 | 7 | **0** |
| 第 3 遍（**merge 最新 `origin/main` 之后**） | 2982 | 2975 | 0 | 7 | **0** |
| 第 4 遍（merge 之后） | 2982 | 2975 | 0 | 7 | **0** |

（合并前后差 8 条 = 上游 `1c011c9`「货/钱分离阶段二」带进来的判据 ✓ 不是本刀加的。）
两遍之间 `git diff | shasum -a 256` = `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
（空 diff 的 sha256）—— **每一对前后都是同一个值** ⇒ 跑测试没改任何文件（自证 ✓）。

**变异 3 组（都真红，且还原逐字节一致）**：

| 变异 | 改了什么 | 红了的判据 | 还原 |
| --- | --- | --- | --- |
| A | 新口径的取数改回"只数门盒 + 样品"（`liveInventoryCountOf` → `legacySellableCountOf`） | **AC-ST5 / AC-ST6 / AC-ST8 / AC-ST9** / AC-STP4b（6 红） | blob `557b2bba…` = `HEAD:src/config/scanStockPolicy.js` ✓ |
| B | 特殊码集合恒为空（`specialSizesOf` → `[]`） | **AC-ST8** ＋ 既有 AC-MF1/MF2/MF3/MF4/MF7/MF8（7 红） | 同上 blob ✓ |
| C | 退货页把 `sellable > 0` 收紧成 `> 1`（44 那 1 双被滤掉） | **AC-ST5 / AC-ST6 / AC-ST9**（3 红） | blob `97a0e288…` = `HEAD:src/views/scanPage/returnBlock.js` ✓ |

⇒ 全部还原后 `git status --short` 为空、`git diff | shasum` 仍是那个空 diff 的 sha256：**与提交逐字节一致**。

## 8. 作用域自证（红线）

- 🔴 **没碰** `services/scanWriteService.js`（一个字都没有）。
- 🔴 **没碰** `routes/scanPage/**`（只读核过）。
- 🔴 **没碰** `config/scanWrite.js`、`app.js`、任何装配处（另有人在改退货出图那刀）。
- 本刀只动：`config/scanStockPolicy.js`（新）· `config/scanPage.js`（**没动**）· `views/scanPageRealm.js`
  （口径转发）· `views/scanPage/**`（**没动**）· `server/test/**` · `docs/**` · `.env.example`（新增一行开关说明）。
- 单货品那条链、成功页 / 写库 / 库存扣减 / 出图：**一个字节都没动**（渲染层那条链未触碰；
  开关注释里也写明"写侧不读它"）。
- ⭐ **合并纪律**：本分支从 `origin/main e1657f1` 开出，先把前一位执行者的诊断提交（`512f991`）merge 进来；
  开 PR 时 main 已前进到 `1c011c9`（其中 `9087ceb` = 同一份诊断的 PR #762 ⇒ 与我 merge 进来的那份内容一致）
  ⇒ 用 **merge**（`e9cdc64`）对齐最新 main，**不是 rebase、绝不 `push -f`**。
  冲突只有两处，逐条解法：`docs/README.md`（保留我这一行索引）·
  `server/test/stockStateConsistency.test.js`（上游那一份 = `512f991` **逐字**，取**我这一份**
  = 上游 ＋ 成对迁移的注释与前提自证）✓。

## 9. 如实登记的差异与未做项

1. **尺码范围以**`config/scanPage.js`**为准（本刀不动它）**：任务书里写的"普通码 女 36–42 / 特殊码 女 34/43"
   与**代码里的现行最终口径**（`B.normal = [36,41]` · `B.special = [34,35,42,43]`，
   见该文件 2026-10-14 的注释与 `docs/scan-size-scope-ruling-2026-10-14.md`）**不一致**。
   本刀按任务书「**指向现有配置 · 别复制第二份**」办 ⇒ **以配置为准**，AC-ST8 判据也从配置取。`
   ⚠️ 若她再拍一次女码范围，**只改 `config/scanPage.js` 那一处**即可（新配置会自动跟着变）。
2. **开关没有翻真**：`SCAN_STOCK_POLICY_ENABLED` 缺省 `false`（任务书要求"缺省 false"）。
   要生效需要她点头后在**线上 `.env`** 打开 —— 本刀**不部署、不改线上 env**。
3. **`services/scanPageService.js` 一个字没改**：新口径所需的数（`row.total`）它本来就给；
   故本刀无需碰它（任务书也只要求"只读口径相关处"）。
4. **`SCAN_STOCK_POLICY_ENABLED=true` 时，既有的旧口径用例会红**（它们是旧口径的基线）——
   这是**有意**的：AC-ST1 里加了一句前提自证，会直接点名"环境带了那个变量"。
   ⇒ 全量测试必须在**缺省**下跑（本刀两次全量都是缺省下跑的、EXIT=0）。

---

## ⭐ 业务负责人裁决（2026-10-16 21:2x · 弹窗选「打开」）

她明确选 **「打开」** ⇒ 四页统一口径 **生效**：

1. ⭐ **`SCAN_STOCK_POLICY_ENABLED=true`** —— 线上 `.env` 打开（**随下一次发版一起写**；部署仍须她当次授权）。
2. ⭐ **「仓库」的货 = 有货**、**「未标状态」的货 = 有货**（都算现货）—— 与她 2026-10-16 20:5x 的口径一致：
   「只要在实时库存里**这个编号有尺码记录，就都是有货**」。
3. ⭐ 连带（**她已点头**）：这同一处判据也被「现货 / 预订」在用 ⇒ **卖仓库里那双 / 未标状态那双时，交易类型记成【现货】**（不再是预订）。
4. ⭐ 生效后四页表现（判据 AC-ST5 / ST6 已钉）：销售现货段出现该尺码 · 补货 `N 双/现货` · 退货允许退 · 库存页那一列照旧。
