# 销售录单：A（货品信息）之后加一道「货号有没有建档」的判据（2026-10-07）

> 一句话：**「货品信息」里压根没有这个货号 = 缺项，当场拦、当场回一句；「货号有、只是资料不齐」= 照旧不拦。**

## 一、起因（业务负责人口径，逐字）

> 「**对，所以三种交易类型，在看完货品信息之后，如果在货架上没有找到，
>  都应该给到这个提示，而不是说等到 B**」

同一天真机：`26002-52`（其实是 `B26002-52`，语音转文字漏了 `B`）走**预付**，
点了确认才失败（`找不到货品：26002-52`，抛在 `v1ReferenceResolver`）。根因是两步的差别：

| 解析 | 读哪张表 | 谁跑 | 货号找不到时 |
| --- | --- | --- | --- |
| **A** `resolveProductInfoForSale` | 「货品信息」 | **三种交易类型都跑** | 只记一条 warn，**空手回来、不吭声** |
| **B** `resolveStockAvailabilityForSale` | 「实时库存」 | 现货 / 未付 跑；**预付不跑** | 缺项「库存里没有 XXX 码」→ `needs_info`、不出卡片 |

⇒ 现货 / 未付 被 B 顺手拦住；**预付跳过 B ⇒ 一处提示都没有**。
她的结论：「货品信息里没这个货号」应该由 **A 之后的一步**直接提示，**三种交易类型都要有**。

## 二、验收标准（先写后做；逐条对照见文末）

| # | 标准 | 判据 |
| --- | --- | --- |
| AC-1 | 三种交易类型（现货 / 未付 / 预付）在「货号在货品信息里压根没有」时，都在 **A 之后**被拦 | `status = needs_info`；**不发确认卡片**；回一句**按货号粒度**的可配文案 |
| AC-2 | 一单多双、只缺其中一双 → **只报那一双的货号**；整单仍被拦 | `missing_fields` 只多出缺的那一双的文案；`cards.length === 0` |
| AC-3 | 「货号找到了、只是齐备公式说缺字段（如缺成本）」→ **仍然不拦**，正常出确认卡片 | 既有 `product_info_gaps` 的结构与渲染**一个字不动** |
| AC-4 | 配品（`kind: 'accessory'`，走配品表 / `listAccessories`）**不受本判据约束** | 不因它去「货品信息」里找；不因此多一条缺项 |
| AC-5 | 现货有货 → 照旧正常出卡片（既有链路不破）；现货 / 未付 的 B 检查不变；预付跳过 B 不变 | 既有用例全绿；`stockLookups` 计数不变 |
| AC-6 | 拦截时有一条**正向证据日志** `lark.sales.product_missing.blocked`，带 `task_id` / `item_no` / `size` | 抓 stdout 能看到那条 JSON；`captureLogs` 用例钉住 |
| AC-7 | **配置先行**：开关 + 文案在 `config/` 里（逻辑里不写死中文文案，也没有 `=== '预付'` 之类散落判断） | `server/src/config/salesProductRegistration.js` |
| AC-8 | 不动 A 的语义、不动 B、不动齐备公式的读法、不动 `product_info_gaps` 结构、不动交付 / 扣库存 / 入账；**既有断言不放宽** | 全量测试 2 次 `fail=0`，且**没有放宽任何既有断言** |

### 判据的「正证据」口径（为什么不是"只要 A 空手回来就拦"）

**只有满足下面两条**才判「没建档」：

1. 「货品信息」**整表读成功了**（`loadProductIndex` 真的建出了索引），**且**
2. 这张索引里**确实没有**这个货号（按 `normalizeText` 归一后比对，与 A 的匹配规则同一套）。

原因（两条都不是"顺手放宽"）：

- **A 的「空手回来」是有歧义的**：`resolveProductInfoForSale` 把「找不到货品」和
  「读表失败 / 读挂了」都收敛成 `return {}` + 一条 warn。只凭它拦单，
  会把"飞书抖了一下"误判成"没建档"，把一笔正常销售挡在门外。
- 这正是 `AGENTS.md` 第 17 条的落地：**结论是「没有」→ 必须去事实表核过再说**。
  读不到就**不下结论**（记一条 `lark.sales.product_missing.undetermined` 警告，
  不含糊其辞地拦单）。既有约定「读表失败不挡单」也保持（`productInfoGapsFromIndex` 同源）。

反之，**只要有一处正证据**（A 认得出来 / 索引里有这个货号）就**不拦** —— 两个证据取并集，
避免把"某一路读挂了"变成拦单。

### 判据加在哪一步

`server/src/services/larkMvpService.js` 的 `processSalesTask` 里那条明细循环：

```
for (每个明细) {
  if (item.kind === 'accessory') { …配品自己的匹配… continue; }   ← 配品在这里就 continue 了（AC-4）
  if (item.item_no && item.size) {
      ── 解析 A：resolveProductInfoForSale ──
      ── 🆕 判据 A′：productRegistrationFrom（本文件新增）──   ← 三种交易类型**都走**这里
      ── 解析 B：resolveStockAvailabilityForSale（按交易类型，预付不跑）──
  }
}
```

位置在 **A 之后、B 之前**（且在 `if (parsePolicy.stock)` 之外）⇒ 预付也过得到。

### 「没建档就拦」 vs 「缺资料不拦」 怎么分开

| | 判据来源 | 拦不拦 |
| --- | --- | --- |
| **没建档** | **「货品信息」这张表里有没有这个货号的记录**（A 的结论 + 整表索引，见上） | **拦**（`needs_info`、不发卡片、回一句） |
| **缺资料** | **飞书公式列「缺失信息说明」的取值**（`!= '齐备'` ⇒ `product_info_gaps`） | **不拦**：只进终态卡上那段「补货品信息」 |

两者**判据不同、代码路径不同**：前者读的是「**这张表里有没有这条记录**」，
后者读的是「**这条记录上的公式列怎么说**」。本判据**只**用前者，
`productInfoGapsFromIndex` / `product_info_gaps` **一行没改**。

## 三、配置项（`server/src/config/salesProductRegistration.js`）

取值规则走既有的 `config/envValue`（**没设** → 默认；**设了**（含空串）→ 就是显式取值）。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SALES_PRODUCT_REGISTRATION_GUARD_ENABLED` | `true` | **显式布尔**。`false` / 空串 = 不拦，但仍记一条 `lark.sales.product_missing.guard_disabled`（"为什么没拦"可查） |
| `SALES_PRODUCT_REGISTRATION_MISSING_TEXT` | `货品信息里没有 {item_no}，请先在「货品信息」建档或核对货号，再发一次～` | 拦截时回她的那句话。`{item_no}` 替换成**这一条明细**的货号（多双只缺一双时只报那一双） |

## 四、日志（正向证据）

| 事件 | 级别 | 字段 |
| --- | --- | --- |
| `lark.sales.product_missing.blocked` | info | `task_id` · `item_no` · `size` · `item_index` · `trade_type` · `trade_type_code` · `index_available` · `reason` |
| `lark.sales.product_missing.guard_disabled` | info | 同上（开关关掉时"本可以拦"的痕迹） |
| `lark.sales.product_missing.undetermined` | warn | `task_id` · `item_no` · `size` · `reason: 'product_index_unavailable'`（读不到「货品信息」⇒ 不拦，但要能查） |

## 五、明确不做（边界）

- **不改 A 本身**：A 仍然"找不到就空手回来"，本判据是它**之后**新加的一步。
- **不动 B**：现货 / 未付 的「库存里没有…」照旧；预付跳过 B 照旧。
- **不动齐备公式的读法**与 `product_info_gaps` 的结构 / 卡片渲染（那段只在已入账终态卡上）。
- **不动交付 / 扣库存 / 入账**：一个字都没改。
- **配品不查「货品信息」**：`kind: 'accessory'` 在判据之前就 `continue` 了。

## 六、验收对照（先写后做 · 逐条）

| # | 验收标准 | 实现落点 | 用例（`server/test/`） |
| --- | --- | --- | --- |
| **AC-1** | 三种交易类型都拦、都不出卡片、都回那句文案 | `larkMvpService.processSalesTask` 明细循环：A 之后、**`if (parsePolicy.stock)` 之外**调 `productRegistrationFrom`；命中 ⇒ `missingFields.push(...)`（既有的 `needs_info` + `return` 就在发卡片之前） | `larkMvpService.test.js` →「三种交易类型：货号压根没建档 → 都拦…」：现货 / 未付 / 预付 各跑一遍；**现货 / 未付 的实时库存里故意有这双鞋**，证明拦住它的**不是 B**（预付则 `stockLookups === 0`） |
| **AC-2** | 一单多双只缺一双 → 只报那一双 | 判据**按明细**跑；文案按 `item.item_no` 渲染（`formatMissingProductText`） | 「一单多双、只缺其中一双 → 只报那一双的货号，整单仍被拦」（并断言另一双照旧解析出来） |
| **AC-3** | 「缺资料」仍然不拦 | 判据只读「**有没有这条记录**」；`productInfoGapsFromIndex` / `product_info_gaps` / 卡片渲染**一行没改** | 「货号在货品信息里、只是齐备公式说缺字段 → 仍然不拦、正常出确认卡片」（同时断言**没有** `blocked` 事件） |
| **AC-4** | 配品不受约束 | 判据在 `if (item.kind === 'accessory') { … continue; }` **之后**才轮到 | 「配品不走「货号建档」判据…」：断言 `resolveProduct` **0 次**调用、无凭空多出的缺项、照常出卡片 |
| **AC-5** | 现货有货照旧；B 不变；预付跳过 B 不变 | 判据不碰 B，也不改 `salesTradeTypePolicy` | 「现货单：货号已建档 + 有货 → 照旧正常出确认卡片」+ 既有那 7 条交易类型用例（**逐字未改**，全部仍绿） |
| **AC-6** | 拦截时有正向证据日志 | `lark.sales.product_missing.blocked`（带 `task_id` / `item_no` / `size` / `item_index` / `trade_type` / `trade_type_code` / `index_available` / `reason`） | 「拦截时那条正向证据日志在…」（抓 stdout 的 JSON 逐字段比对） |
| **AC-7** | 配置先行 | `server/src/config/salesProductRegistration.js`（开关 + 文案 + 事件名）；逻辑里**没有**中文文案、也没有 `=== '预付'` 类散落判断 | `salesProductRegistration.test.js`（6 条）+「开关关掉 → 不拦但留痕」「文案可配：`{item_no}` 换货号」 |
| **AC-8** | 不动 A / B / 齐备公式 / `product_info_gaps` / 交付扣库存；既有断言不放宽 | 只**新增**（`git diff` 对既有测试的改动只有：`runSaleScenario` 多了一个**可选**参数 `productIndexRows`，不传时行为与改前**逐字相同**） | 全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0**（1037 条 = 既有 1022 + 本分支新增 15：`larkMvpService` 9 条、配置 6 条） |

## 七、已知边界 / 不确定处（如实记）

1. **判据的"证据"沿用 `loadProductIndex` 的既有闸门**：那份索引只在 schema 映射了
   `completeness`（生产是「缺失信息说明」）且整表读成功时才会建出来。
   ⇒ 万一有人**把那一行映射删掉**，判据会退化成"不下结论"（不拦）+ 日志留 `undetermined`。
   `v1:schema-check` 只盯"字段名对不对"，**删映射这件事没有闸门会红**（既有
   `product_info_gaps` 也是同一个形状）。生产当前是配着的。
2. **读不到「货品信息」时不拦（fail-open）**：那一刻她的单仍可能"点确认才失败"。
   这是**刻意**的：沿用既有「读表失败不挡单」约定（`productInfoGapsFromIndex` 同源）
   + `AGENTS.md` 第 17 条（结论是「没有」必须核过再说），并记一条
   `lark.sales.product_missing.undetermined` 警告留痕 —— 不是静默。
3. **拦截回复只回"没建档"那句话**：同一单若还有别的缺项（例如某个配品没对上、金额缺失），
   它们照旧记在 `missing_fields` / 销售主表的「解析失败原因」里，但**不在这一句里重复**——
   她先按这句话建档 / 核对货号，重发时其余缺项会再提一次。
4. 判据只在 `item.item_no && item.size` 的明细上跑（与解析 A **同一道门**）；
   只有货号、没有尺码的行仍由解析层的缺项先挡住（不在这里多报一句）。

## 八、验证（本分支实跑）

```
cd server && node --test --test-concurrency=1     # 第 1 次
cd server && node --test --test-concurrency=1     # 第 2 次
```

> 结果见 PR 描述与 CI（工作流「server tests」）。本分支只改代码 / 测试 / 文档 / `.env.example`，
> **不部署、不写任何业务表**。

