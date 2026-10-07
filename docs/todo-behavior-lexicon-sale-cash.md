# 待办：行为管理的「一码两用」（SALE_CASH）+ 出货量统计口径

> 来源：2026-10-07 业务负责人让我复核另一份 AI 的分析。**我实读生产表核对，结论：那份分析对。**

## 一、事实（生产「行为管理」表实读，2026-10-07）

全表 **20 条**（不是 9 条；她截图那 9 条只是前一部分）：

| 所属环节 | 行为编码 |
| --- | --- |
| 采购 | `PURCHASE_ORDER` 报货 · `PURCHASE_IN` 入库 · `PURCHASE_RETURN` 退货 |
| 销售 | `SALE_CASH` 现货 · `SALE_PREPAID` 预付 · `SALE_UNPAID` 未付 · `SALE_RETURN` 退货 · `SALE_EXCHANGE` 换货 · `SALE_COMPENSATION` 赔货 |
| 资金 | `SALE_INCOME` 销售收入 · `SUPPLIER_PAYMENT` 采购支出 |
| 库存 | `STOCK_SALE_DECREASE` 销售减少 · `STOCK_PURCHASE_INCREASE` 采购增加 · `STOCK_PURCHASE_DECREASE` 采购减少 · `STOCK_MANUAL_INCREASE` 手工调增 · `STOCK_MANUAL_DECREASE` 手工调减 · `STOCK_FREEZE` 转冻结 · `STOCK_UNFREEZE` 转释放 · `STOCK_SAMPLE_TO_DOORBOX` 样品转门盒 · `STOCK_DOORBOX_TO_SAMPLE` 门盒转样品 |

## 二、问题：`SALE_CASH` 一个编码背两个字段的含义（**命名复用**，不是表里重复行）

- 在**「交易类型」**里 → 「现货」（`config/salesMovements.js`：`SALE_CASH → 现货 / 已交付`）
- 在**「库存行为」**里 → **换货时新鞋出库（减少）**（`config/afterSales.js:91` 用 `SALE_CASH` 作 behaviorCode）
- 代码注释原文：`现货销售（SALE_CASH）同时是「交易类型」和「库存行为」`

⚠️ **风险**：看「库存流水」的人看到 `库存行为 = SALE_CASH` 会以为"这是卖出去的"，实际是**换货出的**。
将来统计**出货量**时一定会咬人。

## 三、⭐ 现在的兜底（不用改表也能做对）

表里有**「所属环节」**这一列：`SALE_CASH` 的环节 = **销售**，`STOCK_*` 的环节 = **库存**。
⇒ **做"出货量/库存变动"统计时，只筛 `所属环节 = 库存` 的行**，就不会把换货混进来。

🔴 **真正的隐患是"只看编码、不看环节"的统计口径** —— 写统计前先看这一条。

## 四、待办（不急，但现在记下）

1. 若将来要按「库存行为」做统计 → **一律带上 `所属环节 = 库存` 这个筛子**（或改成注册表驱动）。
2. 可选：把换货出库换成**自己的编码**（例如 `STOCK_EXCHANGE_OUT`），彻底消除一码两用；
   ⚠️ 动它要同步「行为管理」表 + `config/afterSales.js` + 闸门（表里选项 ≈ 配置，别只改一边）。
