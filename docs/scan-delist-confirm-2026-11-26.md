# 卖完下架确认（销售 / 供应退货）· 2026-11-26

> 业务负责人定稿：下架弹窗的**时点**改到「货品页点【提交这一单】」那一刻；判据只用**页面首次读到的库存快照**
> 减去**前端本单数量**，**不重新读库存表**。

## 口径（逐条来自她当次确认）

1. **时点**：销售 = 货品页提交时；退货 = 退货页提交时（不再是资金页）。
2. **判据**：`剩余 = 页面快照（该 recordId 的实时库存记录数） − 本单该 recordId 的数量`；
   `剩余 <= 0` ⇒ 卖完/退完 ⇒ 弹确认层。
3. **不查库存表**：快照随页面渲染带回来（`stock_snapshot` 隐藏字段 / 草稿行的 `stock_total`）；
   缺失时才退化为提交时 lookup 的数字，并打 `scan.delist.snapshot_missing`。
4. **去重**：按 `productRecordId` 聚合；同款多尺码 = 一行、数量相加；不同 recordId 各判各的。
5. **多选**：多款都卖完 ⇒ 逐款勾选（默认全选），只下架勾中的。
6. **样品也算记录**：只剩样品 ⇒ 剩余 > 0 ⇒ **不提示**。
7. **销售与退货共用同一个纯函数**（`services/stockDelistCandidates.js` 的 `soldOutCandidates`）。

## 流程

```text
提交（货品页/退货页）
  → 服务端按「快照 − 本单数量」算候选（不读库存表）
      ├ 无候选 ⇒ 原流程（资金页 / 0 元直达 / 退货写库）
      └ 有候选 ⇒ 返回确认层（回显原提交 + 勾选 + delist_confirmed）
            → 用户勾选/取消 → 再提交一次 → 带 delist_product_ids 继续原流程
```

## 落点

| 关注点 | 文件 |
| --- | --- |
| 唯一判据 | `src/services/stockDelistCandidates.js` |
| 确认层（共用） | `src/views/scanPage/delistConfirm.js` + `styles.js`（`DELIST_CONFIRM_STYLE`） |
| 销售提交 | `src/routes/scanPage/handlers/salesSubmit.js` |
| 退货提交 | `src/routes/scanPage/handlers/purchase.js` |
| 资金页只带 ids | `src/views/scanPage/index.js` + `flowHelpers.js` |
| 配置 | `config/scanWrite.js`（字段名）/ `config/scanPage.js`（文案）/ `config/stockDelist.js`（入口 + 上限） |

## 已删除（旧实现）

- 货品页 / 退货页的 `data-delist-*` 前端判断（草稿行数算法，第一双永远不弹）；
- 资金页 `payStock/payQty/payDelistIds` 第二套判断；
- `script.js` 里的站内弹层与提交拦截（含 `__scanDelistModal`）。

## 判据

- `test/stockDelistCandidates.test.js`：判据本身（去重 / 样品 / 超卖 / 空值）；
- `test/saleDelistPrompt.test.js`：货品页不再有前端判断、确认层渲染、资金页只带 ids；
- `test/scanSaleZeroAmountFree.test.js`：0 元单「先确认层 → 确认后入队一次」；
- 退货链路：现有 `purchaseReturn*` / `returnBlock*` / `multiItemOrder*` 全绿。
