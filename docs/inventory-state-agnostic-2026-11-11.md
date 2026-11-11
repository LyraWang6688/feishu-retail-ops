# 库存口径 state-agnostic + FIFO（2026-11-11）

业务负责人定案：

> 库存逻辑完全不看状态；数据表里的状态只是给我自己看的，为了做库存统计用。
> 现在状态只有「门盒 / 样品」了，要彻底大改。

## 现行口径

1. **实时库存里有一条记录 = 这一双就是库存**；
2. 「所属状态」**只做展示 / 统计**，不参与任何库存判断：
   - 统计数量、库存不足、可卖、消耗都不看状态；
   - **状态为空也算库存**；
   - 新建记录默认写「门盒」，只为展示。
3. 内部 `stock_key` = `货品 record_id｜尺码`（**不再含状态**）；
4. 出库/减少按「实时库存.**创建时间**」升序 **FIFO** 删除最早的行；
   - 缺失创建时间视为**最早**；
   - 同一时间按 record_id 兜底，顺序稳定；
5. 实时库存允许的状态值只剩「门盒 / 样品」（没有「仓库」）；
6. 销售出库「**有记录就能卖**」（门盒/样品/空状态都行）；
7. 「当季」是独立字段（`season`），与状态无关。

## 实现落点

- `services/inventoryService.js`：`stock_key` 不含状态；`resumePending` 兼容旧键
  （`货品｜尺码｜状态` 也能匹配，避免升级丢未完成任务）；
- `services/inventory/liveStock.js`：`findLiveInventoryIn` 不看状态；
  `sortLiveInventoryFifo()` 按创建时间升序；
- `services/inventory/executeOperation.js` / `saleBatch.js` / `purchaseReturnBatch.js` /
  `ledger.js`：删掉按状态过滤/消耗的判断；
- `config/v1BitableSchema.js`：`实时库存.创建时间` 登记为**只读**语义（FIFO 用）；
- `config/…/movements.js`：`LIVE_STATES` 收窄为门盒/样品（`consumes` 配置已不再参与判断）。

## 部署注意

- `stock_key` 变化影响本地未完成库存任务：部署前确认没有 pending 库存任务；
  `resumePending` 对旧键做了兼容匹配。
- 空状态记录以前被忽略、现在计入库存 ⇒ 上线前先只读核对生产数量差异。
- 不改任何生产表数据。
