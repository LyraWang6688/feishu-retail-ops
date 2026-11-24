# 人员字段写入策略（2026-11-24）

## 范围

只统一以下 7 个人员字段：

| 表 | 字段 | 语义键 | 模式 |
|---|---|---|---|
| 库存流水 | 操作人 | `inventoryLedger.operator` | 覆盖 |
| 标签打印 | 打印者 | `labelPrintRequest.printedBy` | 覆盖 |
| 销售主表 | 录单人 | `salesEntry.sender` | 覆盖 |
| 销售主表 | 售后人 | `salesEntry.afterSalesBy` | 追加、去重 |
| 供应主表 | 报货人 | `purchaseOrderBatch.reportedBy` | 覆盖 |
| 供应主表 | 验收人 | `purchaseOrderBatch.acceptedBy` | 覆盖 |
| 实时库存 | 仓库员 | `liveInventory.warehouseStaff` | 覆盖 |

唯一配置：`server/src/config/personFields.js`。  
统一写入 helper：`server/src/services/personFieldService.js`。

## 规则

- 只写真实操作人的飞书 `open_id`（`ou_...`）。
- 应用/工作台机器人 open_id 在 `PERSON_FIELD_BLOCKED_OPEN_IDS` 中，一律不写。
- 没有真实操作人时不写，不用应用身份顶替。
- 库存流水只要有库存变动，就写操作人；实时库存只要有新增行，就写仓库员。
- 历史数据不回填。

## 操作人来源

| 业务动作 | 来源 |
|---|---|
| 采购验收 | 验收操作人 |
| 销售出库 | 销售操作人 |
| 售后换货 / 退货 | 售后操作人 |
| 采购退货 | 退货操作人 |
| 手工调整 / 补样品 / 当季调整 | 工作台操作人 |
| 批量打印表单 | 飞书事件的实际提交人 |
| 服务端打印请求 | 打印任务的 `requested_by`；取不到不写 |

## 验证

- `server/test/personFieldService.test.js`
- `server/test/recordPersonStampService.test.js`
- `server/test/labelPrintRequestLog.test.js`
- `server/test/inventoryMvp.test.js`
- 全量单元测试 / e2e / file-size / observability-events。

## 历史

历史「来财」记录按业务负责人 2026-11-24 口径不清理、不回填；本策略只约束以后的新写入。
