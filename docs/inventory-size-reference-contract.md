# 尺码关联与库存接口约定

业务层、机器人消息和工作台接口仍使用正整数尺码，例如 `42`。飞书多维表格的「尺码」字段现为关联「尺码管理」的记录，写入时传 `[sizeRecordId]`；读取时从关联记录解析回整数。不得把显示文本当作关联 ID，也不得自动新增尺码管理记录。当前业务不支持小数尺码。

共享服务：`server/src/services/sizeReferenceService.js` 的 `SizeReferenceService`，构造时传 `{ gateway }`。

- `resolveByNumber(size)`：返回 `{ recordId, size }`，用于写销售明细、采购申请、采购入库等单尺码记录。
- `resolveLinkedCell(cellValue)`：要求恰好一个尺码关联，返回 `{ recordId, size }`，用于读单尺码字段。
- `resolveLinkedCells(cellValue)`：返回多个 `{ recordId, size }`，供多选尺码场景使用。
- `clearCache()`：尺码管理记录有变化时清缓存。缺失、重复、无效或歧义尺码一律报错，不猜测。
- `validateSchema(tableKeys)`：只读检查「尺码管理」数字字段及指定表的单条尺码关联目标，不修改飞书字段。

库存服务现有调用接口不变：

- 销售交付：`InventoryService.applySale({ salesDetailRecordId, productRecordId, size, quantity })`；`size` 是整数，优先扣门盒、再扣样品，不扣仓库。
- 采购入库：`InventoryService.applyPurchase({ purchaseInboundRecordId, productRecordId, size, quantity, state })`；`size` 是整数，每双在实时库存生成一条记录。
- 补选样品：`promoteToSample({ salesDetailRecordId, productRecordId, size })`；只从门盒转样品。
- `findLiveInventory(productRecordId, size, state)` 与 `sampleReplacementCandidates(productRecordId)` 的输入／输出仍使用整数尺码。

销售侧负责销售明细的尺码关联写入、交付时的关联读取；采购侧负责采购申请／入库的尺码关联写入与读取。库存侧负责库存流水／实时库存尺码关联读写。不要在销售或采购分支同时改 `InventoryService` 或共享尺码服务；通过 PR 集成后接入。

真实写入测试只允许连接用户指定的独立测试 Base；测试脚本 `server/scripts/test_inventory_e2e.js` 有测试 Base 与显式 table ID 防误写检查。测试数据可以保留，脚本不增删改任何表或字段结构。
