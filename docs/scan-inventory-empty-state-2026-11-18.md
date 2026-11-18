# 扫码库存：门盒 / 样品 / 空状态（2026-11-18）

> 业务负责人确认：当前库存没有「仓库」状态；只有门盒、样品和空状态。空状态有记录才出现。

## 页面

默认列：

~~~text
门盒 | 样品
~~~

如果这一款有任何「所属状态为空」的库存行，再追加：

~~~text
门盒 | 样品 | 空状态
~~~

没有空状态记录时，不显示空状态列。

## 数据保护

配置外的状态（例如以后又出现 仓库）仍会以额外列显示，避免库存总数与明细对不上；不会静默丢掉真实库存。

## 代码

- server/src/config/scanPage.js
  - STATES.columns = ['门盒', '样品']
  - emptyLabel = '空状态'
- server/src/services/scanPageService.js
  - 继续按 emptyStateRows 条件追加空状态列。

## 测试

- test/scanPage.test.js
- test/stockStateConsistency.test.js
- test/fixtures/stockStateConsistency.golden.json

## 说明

仓库状态本身没有从库存写入值域中删除；这次只改扫码页展示。当前线上实时库存 1612 条里仓库记录为 0。
