# 身份键契约（货品 / 销售明细 / 销售单）

> 状态：**现行工程契约**  
> 核对日期：2026-11-23  
> 适用范围：网页工作台、扫码页、售后页、采购页、销售查询、库存流水，以及后续新增的选货品页面。

## 0. 一句话规则

```text
货品身份       → productRecordId
销售明细身份   → sales_detail_record_id
销售单身份     → sales_entry_record_id
number / 货号  → 只用于展示、排序、文本匹配
```

**不能拿 `number` 当唯一身份。**

## 1. 为什么不能用 number

生产里已经出现：

```text
记录 A：JX2181-8|米色...   recordId = recA
记录 B：JX2181-8|米色...   recordId = recB
```

两条的：

```text
货号 itemNo 相同
完整编号 number 相同
recordId 不同
```

如果后端按 `number` 查询：

```text
选中 A → 条件仍是 number → A、B 的历史一起返回
```

用户以为自己选了一条记录，实际看到的是两条记录合并后的历史。

`number` 本质上是业务快照：

```text
货号|颜色|类别
```

它可以被改名、重复登记、人工修正，不具备数据库唯一键的语义。

## 2. 三个身份键的分工

| 身份 | 字段 | 用途 | 不能替代成 |
|---|---|---|---|
| 货品 | `productRecordId` | 选货品、库存、采购、售后货品头、扫码 | `number` |
| 销售明细 | `sales_detail_record_id` | 售后换货 / 退货 / 赔货、交付明细 | `productRecordId` |
| 销售单 | `sales_entry_record_id` | 售后候选订单、订单头 | `order_no` |

### 为什么售后必须用销售明细 ID

售后动作的对象是：

```text
某一条销售明细
```

不是“某个货品的全部销售”，也不是“整张订单”。

同一货品可以有多条销售明细；同一订单也可能有两双同款同码。

```text
货品 A 的销售明细 d1、d2
→ 售后选中 d1 时，只能操作 d1
```

所以：

```text
售后卡选择：sales_detail_record_id
售后货品头：productRecordId
售后订单头：sales_entry_record_id
```

三个 ID 同时存在是正常的，不是重复。

## 3. 当前页面实际使用情况

### 已按 record ID

| 页面 / 卡片 | 实际键 | 代码 |
|---|---|---|
| 采购建议报货卡 | `productRecordId` | [render.js](../server/public/workbench/features/procurement/render.js) |
| 采购待提交列表 | 草稿 key = `productRecordId`（列表只展示） | [store.js](../server/public/workbench/features/procurement/store.js) |
| 采购搜索选中结果 | `data-record=productRecordId` | [search.js](../server/public/workbench/features/procurement/search.js) |
| 库存调整货品卡 | `data-pick-product=recordId` | [adjustment.js](../server/public/workbench/features/inventory/adjustment.js) |
| 验收明细 / 样品选择 | `product_record_id` | [acceptanceDoc.js](../server/public/workbench/features/orders/acceptanceDoc.js) · [sampleChoice.js](../server/public/workbench/features/orders/sampleChoice.js) |
| 货品资料 / 下架 / 完善 | `recordId` | [productDelisted.js](../server/public/workbench/features/domains/productDelisted.js) |
| 售后货品头 | `productRecordId` | [after-sales/index.js](../server/public/workbench/features/after-sales/index.js) |
| 售后候选卡 / 下单 | `sales_detail_record_id` + `sales_entry_record_id` | 同上 |
| 扫码页标签 | `recordId` | [scanPageService.js](../server/src/services/scanPageService.js) |
| 销售交付明细动作 | `sales_detail_record_id` | [sales-delivery/index.js](../server/public/workbench/features/sales-delivery/index.js) |
| 销售查询货品筛选 | `productRecordId` | [sales-query/index.js](../server/public/workbench/features/sales-query/index.js) · [salesQueryService.js](../server/src/services/salesQueryService.js) |
| 库存流水货品筛选 | `productRecordId` | [inventory/ledger.js](../server/public/workbench/features/inventory/ledger.js) · [v1WorkbenchService.js](../server/src/services/v1WorkbenchService.js) |

> 2026-11-23：销售查询与库存流水已改为只认 `productRecordId`；旧 `product=<number>` 不再参与过滤。

## 4. API 契约

### 4.1 货品搜索

```text
GET /api/workbench/products/search?q=货号
```

返回必须包含：

```json
{
  "recordId": "rec...",
  "itemNo": "JX2181-8",
  "number": "JX2181-8|米色|男"
}
```

- 搜索阶段可以按 `itemNo` 模糊匹配；
- 选中阶段必须保存 `recordId`；
- 后续查询 / 提交必须使用 `recordId`。

### 4.2 销售查询

```text
GET /api/workbench/sales/query?productRecordId=rec...
```

后端过滤：

```text
销售明细.编号 关联记录 id === productRecordId
```

> 禁止再使用 `product=<number>` 作为筛选参数。

### 4.3 库存流水

```text
GET /api/workbench/inventory/ledger?productRecordId=rec...
```

后端过滤：

```text
库存流水.关联货品 record_id === productRecordId
```

流水响应需要带：

```text
product_record_id
```

供前端精确过滤和排查。

### 4.4 售后

```text
GET /api/workbench/sales/after-sales/scan-candidates?productRecordId=rec...
```

候选行必须带：

```text
sales_entry_record_id
sales_detail_record_id
product_record_id
```

售后提交必须同时带：

```text
salesEntryRecordId
detailRecordId
productRecordId
```

## 5. 写入约束

所有采购 / 库存 / 销售 / 售后的写入关联字段必须是：

```text
product_record_id = productRecordId
```

不能写：

```text
product_record_id = number
```

文本字段可以继续保存 `number` 作为展示快照，但它不承担关联身份。

## 6. 搜索候选的展示

两个重复记录如果 `itemNo`、`number` 都一样，候选列表必须提供可区分信息，至少显示：

```text
记录 ID 后 6 位
```

或：

```text
货品状态（有货 / 无货 / 已下架）
```

否则即使用户选中了 A，也没有办法在视觉上知道自己选的是 A 还是 B。

## 7. 测试要求

新增或修改选货品、查询、售后逻辑时，必须补：

1. 两条记录 `itemNo`、`number` 相同但 `recordId` 不同；
2. 选择 A 查询销售历史 → 只返回 A 的明细；
3. 选择 A 查询库存流水 → 只返回 A 的流水；
4. 选择 A 提交采购 / 售后 → payload 里是 A 的 `productRecordId`；
5. 选择 B 不会被 A 的历史污染；
6. 售后选中 d1 → 只操作 d1，不操作同货品的 d2；
7. 请求里只出现 `productRecordId`，不得再以 `product=number` 过滤。

## 8. 相关历史口径

- 旧 `/s/{编号}` 标签入口已于 2026-11-11 删除，当前只认 `/r/{recordId}`。
- 普通扫码遇到已下架货品会阻止新销售，并提示走售后入口；售后入口允许已下架货品，按 record ID 处理历史订单。
- 重复货品的治理（合并 / 清理）是单独的数据治理问题；本契约只保证查询和写入不混用身份。

## 9. 提交前自检

```text
[ ] 这个选择项保存的是 recordId 吗？
[ ] 后端请求参数是 productRecordId 吗？
[ ] 数据库过滤字段是关联 record_id 吗？
[ ] 是否又把 number 当唯一键了？
[ ] 售后操作对象是 sales_detail_record_id 吗？
[ ] 两条同号不同 recordId 的记录会不会被合并？
```
