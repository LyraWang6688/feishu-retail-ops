# 「补货品信息」段落位置：确认卡片 → **已入账终态卡**（2026-10-07）

## 起因（业务负责人逐字）

> 「现在的问题是：我们现在会去查货品信息表，是为了找到维护缺项的记录链接，对不对？
>  **但现在有个问题：我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了。**
>  **所以我们在销售信息确认卡片里不需要放这个信息；等用户点击确认之后，卡片不是会更新吗？
>  更新时再补这个信息。**
>  **也就是转换一下位置：把这个内容从销售确认卡片，挪到用户点击确认后更新的卡片里。你看一下怎么调整**」

问题本质：确认卡片会被**同一张卡片的后续 patch 覆盖**。她把「去补全这条记录」的链接
放在确认卡片上，点完确认 1~2 分钟后卡片被 patch 成处理中 / 已入账，链接就**永远消失了**。
⇒ 位置必须挪到「点确认之后」的那些卡片上，尤其是**会长期留着的那张终态卡**。

## 🔴 当天收窄 —— **最终口径：只放在「2」上**（2026-10-07）

第一版（PR #220）做成了"**①和②都放**"。业务负责人随后**明确纠正**（逐字）：

> 「**不是，是只放在2上！**」

她给两张卡的编号：

| 编号 | 卡片 | 停留时间 | 带这一段？ |
| --- | --- | --- | --- |
| ① | 「销售订单处理中」卡（`salesProcessingCard`，`stage: 'processing'`） | 点确认后 **0.3 秒**出现、**只停留 1~2 分钟** | ❌ **不带** |
| ② | 绿色「销售订单已入账」终态卡（`salesStatusCard` 的 posted 分支，`stage: 'posted'`） | **长期留着** | ✅ **带**（只要这一张有） |

**为什么①也不该带**：① 很快就被终态卡 patch 覆盖 —— 链接挂在①上照样会消失，
那正是她要解决的问题。把链接放在一张"很快就没了"的卡片上等于没放。

## 验收标准（先写，再动手；逐条对照见文末）

1. **确认卡片 `salesConfirmationCard` 不含该段落** —— 有缺口时不出现，无缺口时**也不留空壳**。
2. ⭐ **「销售订单处理中」卡（`salesProcessingCard`，`stage: 'processing'`）不含该段落**；
   并且它的 `elements` **逐字等于**"这份草稿没有该段"的那一份（**反向断言 + 逐字加固**，
   防止将来又悄悄加回来 —— 哪怕只多一个空元素也要红）。
3. ⭐ **「销售订单已入账」终态卡（`salesStatusCard` 的 posted 分支，`stage: 'posted'`）含该段落**
   —— 这张会长期留着，是她补资料的入口；**这是这一段唯一的挂载点**。
4. **行格式逐字不变**：`<货号+颜色> 还差：<缺什么>` ＋ 换行 ＋ `[去补全这条记录](<url>)`；
   仍是 `div` + `lark_md` + `text_size: 'note'`；超过 6 条仍是"只列 6 条 + 一句还有 N 个"。
5. **链接 url 逐字不变**：仍是 `productInfoGapsFromIndex` 里那条 `recordUrl(...)` 算出的
   「那条货品记录」的飞书 url（`/base/<appToken>?table=<tableId>&record=<record_id>`）。
6. **无缺口（`product_info_gaps` 为空）时，三张卡（确认 / 处理中 / 终态）都不出现该段落**（不留空壳）。
7. **判定来源、数据结构、日志一字不动**：仍只在卖单解析后读**一次**「货品信息」表（走索引）；
   `product_info_gaps` 字段形状不变；`lark.sales.product_info.gaps` 日志仍在；
   点确认这条链路**不重新读表**。
8. **文案 / 格式走配置**（`src/config/productInfoGaps.js`）：段落标题、缺项前缀、样例图标签、
   链接文字、"还有 N 个"那句、最多列几条 —— 逻辑里不写死中文字面量。
9. **不动**：确认卡片（已正确）、终态卡的既有文案与 `options.productInfoGaps` 开关（已正确）、
   `config/productInfoGaps` 的键与取值、数据来源、样品种子补选卡、售后台、到货核对卡、采购卡；
   业务写入（明细 / 收款 / 库存 / 交付）与"点确认"的判定逻辑。
10. **既有断言不许放宽**：终态卡那几条（posted / delivery_partial / delivery_failed /
    duplicate_terminal 非取消 / 确认卡不含 / 无缺口不出现）**一条都不许动**；
    处理中卡那几条从"含"翻成"不含"是**收严**，可以。

### 终态卡覆盖哪几个分支（判据：**这条单据是否已经入账、且卡片会长期留着让她回来补资料**）

| 分支（`stage`） | 卡片标题 | 覆盖 | 理由 |
| --- | --- | --- | --- |
| `posted` | 销售订单已入账 | ✅ | 主分支。单据已入账、卡片长期留着 ⇒ 她补资料的入口 |
| `delivery_partial` | 订单已入账，部分交付 | ✅ | **单据已入账**（钱与明细都写了），只是货没交齐；卡片同样长期留着 |
| `delivery_failed` | 订单已入账，交付待处理 | ✅ | 同上：已入账，交付是另一件事 |
| `duplicate_terminal`（`status = posted` / `posted_delivery_pending`） | 销售订单已入账 / 订单已入账，交付待核对 | ✅ | **同一个已入账状态**走的老卡片再点一次；若这里不带，同一状态会出现两种卡面 |
| `processing` | ⏳ 销售订单处理中 · 正在写入… | ❌ | **她 2026-10-07 收窄**：只停留 1~2 分钟就被终态卡覆盖 ⇒ 链接挂了也会消失 |
| `cancelled` | 销售录单已取消 | ❌ | 原草稿**不会入账**，没有单据需要补资料 |
| `awaiting_correction` | 等待重新发送 | ❌ | 同上 |
| `duplicate_terminal`（`status = cancelled`） | 销售录单已取消 | ❌ | 同上 |

> 判据不是"卡片长得像不像终态"，而是**"这单到底入账了没有"**：入账 = 有单据 = 需要补资料。
> 取消 / 待修正 = 单据不存在（`原草稿不会入账`），所以**刻意不动**它们。
> ⭐ 而 `processing` 是**另一种"不带"**：这单**会**入账，但那一张卡片**留不住**
> —— 判据除了"入账了没有"，还有**"这张卡会不会长期留着"**。

## 数据怎么传到 patch 卡上（**没有多读一次表**）

- 缺口的**唯一**来源仍是卖单解析时的 `productInfoGapsFromIndex(items, productIndex)`
  （`larkMvpService`），结果落进 `task.draft.product_info_gaps`；
- 点确认后所有 patch 用的卡片都拿 `task.draft`（`handleSalesOrLegacyCardAction` 手上的 `task`），
  ⇒ **零额外请求**；本改动**没有**新增任何 `listAll('product')`。

## 实现落点

- `src/config/productInfoGaps.js`（**新增**）：段落文案与上限的配置（`envValue` 那套取值规则）。
- `src/utils/larkCards.js`：
  · 新增 `productInfoGapsElements(draft, config)`（缺口为空 → 空数组，不留空壳）；
  · `salesConfirmationCard` **去掉** `...salesProductInfoGaps(draft)`（原来的私有渲染器被替换）；
  · 🔴 `salesProcessingCard` **不带**该段落（2026-10-07 收窄删掉的就是这里的那一行）；
  · `salesStatusCard` 增加**可选**开关 `options.productInfoGaps`（默认不带 ⇒ 取消 / 待修正等分支字节不变）。
  · ⚠️ `productInfoGapsElements` 现在**只剩一处生产调用点**（`salesStatusCard`），
    但**签名保持可复用**（带 `config` 形参）—— 不因为"看起来只有一个调用点"就内联或改签名。
- `src/services/larkMvpService.js`：在 `posted` / `delivery_partial` / `delivery_failed` /
  `duplicate_terminal`（非 cancelled）四处显式带上该段落。**`processing` 那处没有开**。

## 逐条对照（实现 + 测试证据）

测试：`test/productInfoGapsCardPlacement.test.js`（新增，钉 ①②③④⑤⑥⑦）、
`test/larkCards.test.js`、`test/larkMvpService.test.js`（改：因为"位置变了"）。

| 验收 | 钉它的用例 |
| --- | --- |
| 1 确认卡不含（无缺口不留空壳） | `确认卡片：有缺口也不出现…`（placement 第 1 条）+ `larkCards.test.js` 同名条 + `larkMvpService.test.js` 的 `货品资料不齐时…确认卡片上不再挂这一段` |
| 2 处理中卡**不含** + 逐字加固 | `处理中卡：**不含**「补货品信息」段落…`（`assert.equal(sectionElement(…), undefined)` ＋ 与"无缺口"那份 `deepEqual` ＋ `elements` 逐字 `deepEqual`）；链路 ① 里还钉了"走完真实链路之后 `cards[0]` 逐字等于不带该段的那一份" |
| 3 终态卡含（逐字） | `终态「已入账」卡：含该段落…`、链路 ③、链路 ④（部分交付 / 交付失败）、链路 ⑤（duplicate_terminal 已入账）—— **一条都没改** |
| 4 行格式逐字 / 5 url 逐字 | `EXPECTED_SECTION` 的逐字 `assert.equal`（终态卡）＋ `终态卡：缺口超过上限时…` |
| 6 无缺口三张卡都不出现 | `无缺口时：确认卡 / 处理中卡 / 终态卡**三张**都不出现该段落…` ＋ 链路 ② |
| 7 不重新读表 | 链路 ① 的 `assert.deepEqual(tableReads, [])` |
| 8 文案走配置 | `配置：默认值逐字等于挪位置之前的文案`、`配置：六项都能被环境变量覆盖`、`渲染：段落里每一个字…`、`渲染：段落文案全部来自配置…` |

**反向断言（原来钉"含"、现在钉"不含"）逐条**：
1. placement `处理中卡：含「补货品信息」段落，行格式与链接逐字…` → `处理中卡：**不含**「补货品信息」段落…`
2. placement `处理中卡：链接 url 逐字等于那条货品记录的飞书 url` → `处理中卡：那条货品记录的飞书 url **不**出现在这一张上`
3. placement 链路 ①（原来遍历两张卡都要求逐字相同）→ 现在只要求 `cards[1]` 含、`cards[0]` **不含**且逐字等于无缺口那份
4. placement `渲染：超过默认上限（6）时…` / `配置：超过上限时…`（已改名为 `终态卡：缺口超过上限时…`）：原来经处理中卡渲染 → 改经 `productInfoGapsElements` / **终态卡**渲染（钉的还是同一件事）
5. `larkMvpService.test.js` ×3：原来经 `salesProcessingCard` 钉文案 → 改经 **`salesStatusCard` + `productInfoGaps: true`** 钉同一句文案

**终态卡那几条"没被放宽"的证据**：见上表第 3 行 —— 那 4 条用例的
`assert.equal(sectionElement(...).text.content, EXPECTED_SECTION)` 断言**逐字未改**，
`EXPECTED_SECTION` 的定义（标题 + `还差：` + 样例图 + 逐字 url）也**一字节未改**。
