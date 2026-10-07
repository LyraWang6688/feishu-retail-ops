# 「补货品信息」段落位置调整：确认卡片 → 点确认之后更新的卡片（2026-10-07）

## 起因（业务负责人逐字）

> 「现在的问题是：我们现在会去查货品信息表，是为了找到维护缺项的记录链接，对不对？
>  **但现在有个问题：我们的卡片能够实时更新，更新完之后，用户要补的链接其实就看不到了。**
>  **所以我们在销售信息确认卡片里不需要放这个信息；等用户点击确认之后，卡片不是会更新吗？
>  更新时再补这个信息。**
>  **也就是转换一下位置：把这个内容从销售确认卡片，挪到用户点击确认后更新的卡片里。你看一下怎么调整**」

问题本质：确认卡片会被**同一张卡片的后续 patch 覆盖**。她把「去补全这条记录」的链接
放在确认卡片上，点完确认 1~2 分钟后卡片被 patch 成处理中 / 已入账，链接就**永远消失了**。
⇒ 位置必须挪到「点确认之后」的那些卡片上，尤其是**会长期留着的那张终态卡**。

## 验收标准（先写，再动手；逐条对照见文末）

1. **确认卡片 `salesConfirmationCard` 不含该段落** —— 有缺口时不出现，无缺口时**也不留空壳**。
2. **「销售订单处理中」卡（`salesProcessingCard`，`stage: 'processing'`）含该段落** ——
   她点完确认立刻就能看见。
3. **「销售订单已入账」终态卡（`salesStatusCard` 的 posted 分支，`stage: 'posted'`）含该段落** ——
   这张会长期留着，是她补资料的入口；⭐ 这条是本次改动的**关键**。
4. **行格式逐字不变**：`<货号+颜色> 还差：<缺什么>` ＋ 换行 ＋ `[去补全这条记录](<url>)`；
   仍是 `div` + `lark_md` + `text_size: 'note'`；超过 6 条仍是"只列 6 条 + 一句还有 N 个"。
5. **链接 url 逐字不变**：仍是 `productInfoGapsFromIndex` 里那条 `recordUrl(...)` 算出的
   「那条货品记录」的飞书 url（`/base/<appToken>?table=<tableId>&record=<record_id>`）。
6. **无缺口（`product_info_gaps` 为空）时，处理中卡与终态卡都不出现该段落**（不留空壳）。
7. **判定来源、数据结构、日志一字不动**：仍只在卖单解析后读**一次**「货品信息」表（走索引）；
   `product_info_gaps` 字段形状不变；`lark.sales.product_info.gaps` 日志仍在。
8. **文案 / 格式走配置**（`src/config/productInfoGaps.js`）：段落标题、缺项前缀、样例图标签、
   链接文字、"还有 N 个"那句、最多列几条 —— 逻辑里不写死中文字面量。
9. **不动**：样品种子补选卡、售后台、到货核对卡、采购卡；业务写入（明细 / 收款 / 库存 / 交付）
   与"点确认"的判定逻辑。

### 终态卡覆盖哪几个分支（判据：**这条单据是否已经入账、且卡片会长期留着让她回来补资料**）

| 分支（`stage`） | 卡片标题 | 覆盖 | 理由 |
| --- | --- | --- | --- |
| `posted` | 销售订单已入账 | ✅ | 主分支。单据已入账、卡片长期留着 ⇒ 她补资料的入口 |
| `delivery_partial` | 订单已入账，部分交付 | ✅ | **单据已入账**（钱与明细都写了），只是货没交齐；卡片同样长期留着 |
| `delivery_failed` | 订单已入账，交付待处理 | ✅ | 同上：已入账，交付是另一件事 |
| `duplicate_terminal`（`status = posted` / `posted_delivery_pending`） | 销售订单已入账 / 订单已入账，交付待核对 | ✅ | **同一个已入账状态**走的老卡片再点一次；若这里不带，同一状态会出现两种卡面 |
| `cancelled` | 销售录单已取消 | ❌ | 原草稿**不会入账**，没有单据需要补资料 |
| `awaiting_correction` | 等待重新发送 | ❌ | 同上 |
| `duplicate_terminal`（`status = cancelled`） | 销售录单已取消 | ❌ | 同上 |

> 判据不是"卡片长得像不像终态"，而是**"这单到底入账了没有"**：入账 = 有单据 = 需要补资料。
> 取消 / 待修正 = 单据不存在（`原草稿不会入账`），所以**刻意不动**它们。

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
  · `salesProcessingCard` 加上该段落；
  · `salesStatusCard` 增加**可选**开关（默认不带 ⇒ 取消 / 待修正等分支字节不变）。
- `src/services/larkMvpService.js`：在 `posted` / `delivery_partial` / `delivery_failed` /
  `duplicate_terminal`（非 cancelled）四处显式带上该段落。

## 逐条对照（实现 + 测试证据）

见 PR 描述与本文件对应提交的测试：
`test/productInfoGapsCardPlacement.test.js`（新增，钉 ①②③④⑤⑥⑦）、
`test/larkCards.test.js`、`test/larkMvpService.test.js`（改：因为"位置变了"）。
