# 颜色候选：去掉「有货 / 无货」预览标注（2026-10-07）

## 一句话

**候选只显示颜色名**（`黑色` / `绿色`）——选完颜色**之后**再查库存，
由后端告诉她「这双有货 → 现货」或「没货 → 预定」。

## 业务负责人的口径（逐字）

> 「**甲 去掉**（推荐，贴合你的口径）：候选只显示颜色（黑色 / 绿色），
>  **选完 → 再查库存 → 告诉她"这双有货→现货"或"没货→预定"**，是的！」

她先前的口径：**A 环节只回答"这个货号有几个颜色"，让她选；选完才去查库存定类型**。

## 验收标准（先写，再动手；逐条对照见本文件末节）

| # | 验收标准 | 怎么验 |
| --- | --- | --- |
| **AC-1** | 多颜色货号出候选时，候选按钮文字**逐字只有颜色名**（`黑` / `白`、`黑色` / `绿色`），**不出现**「有货」「无货」（也不出现任何后缀） | `larkCards` 逐字断言按钮 `text.content`；`larkMvpService` / `salesColorCandidatesAllColors` / `salesPrepaidColorResolution` 里对卡片 JSON 做 `doesNotMatch(/有货|无货/)` |
| **AC-2** | 候选**数据对象上没有 `stock_status` 字段**（既不算、也不渲染）；B 兜底候选（`resolveStockAvailabilityForSale` 的 `needsColor` 分支）同样没有 | `color_options.map(o => o.stock_status)` 逐条 `undefined`；`assert.ok(!('stock_status' in option))` |
| **AC-3** | 录单时读「实时库存」**保留**（`liveInventoryPromise` 那条链不动）：单颜色货号**仍在录单时**用这一次读的库存定类型（现货 / 预定） | 单颜色现货：`readLiveReads() === 1` 且 `trade_type_code === 'SALE_CASH'`；单颜色没货：`SALE_PREPAID`（既有用例，未改） |
| **AC-4** | 选完颜色后的行为**一字不改**：`choose_sale_color` → 重新 `loadLiveInventoryIndex()` → 用**选定颜色**跑 `resolveStockAvailabilityForSale` → 定 `现货 / 预定` | `larkMvpService.test.js` ②/②b/⑤、`salesColorCandidatesAllColors` ②/②b/②c、`salesPrepaidColorResolution` ① —— **一个断言都不改**且全绿 |
| **AC-5** | 多颜色卡上**类型仍是「待定」**（`trade_type_code === ''`），不许提前定 | 既有断言（未改） |
| **AC-6** | **配置先行**：`SALES_COLOR_STOCK_LABEL_AVAILABLE` / `SALES_COLOR_STOCK_LABEL_UNAVAILABLE` 两个键**从代码与 `.env.example` 一并删除**（不留死配置）；`SALES_COLOR_STOCK_STATUS` 常量与 `colorOptionButtonText` 的后缀分支随之下线 | 守卫用例断言这几个导出 / 键名 `undefined`；`.env.example` 里 grep 不到 |
| **AC-7** | **点名保留** `SALES_COLOR_STOCK_LOOKUP_FAILED_TEXT`（她点完颜色、这一次读不到库存时那句话）—— 它不属于"预览标注" | `salesColorChoice.test.js` 既有两条断言**一字不改** |
| **AC-8** | 卡片其它部分（三段：类型 / 履约状态 / 收款情况）与其它按钮（确认 / 修改 / 取消 / 补门盒）**不动** | `larkCards.test.js` 既有卡片用例（未改）全绿 |
| **AC-9** | 既有「含（有货）/（无货）」的断言**改成反向**：从"等于带后缀的字串"改成"**等于纯颜色名** ＋ **显式不含这两个词**"。这不是放宽 —— 见下节 | 逐条 diff |
| **AC-10** | **mutation 自证**：把预览标注加回去 ⇒ 新断言必须变红 | 见本文件末节 |

### AC-9 为什么「反向」不是「放宽」

旧的断言是**等式**：`'黑（有货）' === colorOptionButtonText(...)`。
改成反向时**没有**把它换成宽松的 `match(/黑/)`，而是：

1. **等式收紧成纯颜色名**：`assert.equal(buttons.map(b => b.text.content), ['黑', '白'])`
   —— 逐字相等，多一个字符（哪怕 `·`）都会红；
2. **再加一条显式禁令**：`assert.doesNotMatch(cardText, /有货|无货/)`
   —— 旧断言**从来没有**检查过"别的候选会不会被误标"，这条是**新增**的信息量；
3. 数据层同时断言 `stock_status` **不存在**（AC-2），而旧断言只断言它**等于某值**。

⇒ 断言的信息量只增不减：**"是纯颜色名" ＋ "整张卡片上没有这两个词" ＋ "字段不存在"**。

## 关键 diff（三处）

1. **候选**：`services/larkMvpService.js`
   - `colorOptionsWithStockStatus()` **整体删除**（连同它的注释）；
   - 录单处 `colorOptions = productInfo.colorOptions.map((o) => ({ ...o }))`（不打状态）；
     `lark.sales.color_options.offered` 日志只留 `option_count`（删掉 `available_count` /
     `unavailable_count` —— 没有状态可数了，留着就是假数据）；
   - `resolveStockAvailabilityForSale` 兜底候选里删掉 `stock_status: available`。
2. **渲染**：`utils/larkCards.js` 的 `salesColorPickers` 不再传 `colorChoiceConfig`；
   `colorOptionButtonText(option)` 只回颜色名（保留「未命名颜色」兜底）。
3. **配置**：`config/salesColorChoice.js` 删两个 label 键 / 两个默认值 / `SALES_COLOR_STOCK_STATUS`；
   `.env.example` 同步删两个变量并改注释。

## 「录单时读库存」到底还用不用（结论）

**用。** 证据：

- `larkMvpService.js` 的 `liveInventoryPromise = this.loadLiveInventoryIndex()`（录单处）
  仍在，并在 `Promise.all([liveInventoryPromise, productIndexPromise])` 处被 await；
- 同一轮循环里，**单颜色**货号走 `resolveStockAvailabilityForSale({ itemNo, size, itemQuantity, color }, liveInventory)`
  —— 它**就是**现货 / 预定的判据（`in_stock` → `salesTradeTypeForStock`）；
- 单测证据：`larkMvpService.test.js`「现货单：A 定下的单色就是这一单的颜色与货品…」
  断言 `readLiveReads() === 1` 且 `trade_type_code === 'SALE_CASH'`；
  「收藏品/没库存」那些用例断言 `SALE_PREPAID`。

⚠️ **唯一变化的是"多颜色货号在录单时读了但不用"**：这在改动**之前**就是这样
（多颜色时 B 是 deferred，预览标注用的是同一个已读索引、不额外读表）——
本次改动没有让任何一次读表变成孤儿：`liveInventory` 这个变量在同一个函数里
仍被单颜色分支使用。**所以没有触发"停下报告"的条件。**

## 改后卡片上候选按钮的逐字内容

`server/test/larkCards.test.js`（逐字）：
```
['黑', '白']        // 原：['黑（有货）', '白（无货）']
```
`server/test/salesColorCandidatesAllColors.test.js`（卡片 JSON）：
```
黑色 / 巧克力        // 原：黑色（有货）/ 巧克力（有货）
```
多颜色场景（`salesPrepaidColorResolution`）：`黑色`（原 `黑色（无货）`）。

## mutation 自证

在 worktree 里临时**把预览标注加回去**（`colorOptionsWithStockStatus` 恢复 +
`colorOptionButtonText` 拼后缀），跑这 5 个文件 → 新断言变红；
然后 `git checkout -- <files>` 还原（不留痕）。输出见 PR 描述 / 汇报。

## 没碰的东西（边界）

- 采购侧任何文件（另一个代理在改 schema 与到货图片）；
- `pendingDealPush*`、`app.js`（未改）；
- 「选完颜色后重查库存定类型」「单颜色直接定」「缺货 / 预定判定口径」。
