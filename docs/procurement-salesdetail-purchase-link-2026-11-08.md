# 补货「已报货」精确化：销售明细 → 采购明细 单向关联 · 2026-11-08

> 业务负责人 2026-11-08：在生产「销售明细」新增**单向关联字段「采购明细」**（→「采购明细」表），
> 用于标记「这条销售明细已经被补货报过」；并要求回填时**用编号 + 尺码匹配记录**（不绑销售单号、页面不用传 record_id）。

## 1. 要解决的问题

补货筛选 = `销售日 >= TODAY()-3` 且 `库存数量 = 0`，结束 = 现在。
- 报货 ≠ 到货：提交采购单后库存数量不变（要到验收加库存才 > 0）⇒ 同一条销售明细在 3 天窗口内会**再次出现**；
- 提交幂等只对同一 submitKey 有效 ⇒ 隔天再次提交 = 新采购单 ⇒ **可能重复报货**。

## 2. 方案

**读侧（补货页）**：`销售明细.采购明细` 非空 ⇒ 这条已报过 ⇒ **不再显示**（业务负责人明确：不要开关，就是这个行为）。

**写侧（采购提交成功后，异步后台）**：
1. 采购单写成功（采购主表 + 采购明细已落）后，读本次批次的「采购明细」（按 `报货批次号`）；
2. 按同一补货筛选（库存=0 + 近 N 天窗口）读「销售明细」，**只取未关联**的行；
3. 对每条采购明细，按「**编号 + 尺码**」匹配销售明细：**预订优先**（预订必补／默认已选），
   同类型内按**销售日旧→新**，最多取该采购明细的「数量」条；
4. 把销售明细的「采购明细」列写成 `relation(采购明细 record_id)`；
5. **幂等**：先扣除"已经关联到该采购明细的行数"（重试/重放不会多链）；
6. **失败只记日志**（`procurement.page.sales_link_backfill_failed`），绝不影响采购事实。

## 3. 落点

| 文件 | 改动 |
| --- | --- |
| `server/src/config/v1BitableSchema.js` | `salesDetail.purchaseDetail = '采购明细'`（新增映射；**共享文件，Lead review**；测试 Base 需同步该列） |
| `server/src/config/procurementPage.js` | 两个事件名（配置先行） |
| `server/src/services/procurementPageData.js` | 读销售明细的该列；非空 ⇒ 不计入补货视图（默认） |
| `server/src/services/procurementSalesLinkBackfill.js`（新） | 采购成功后按「编号+尺码」回填关联（幂等、失败不抛、最多 200 行/次） |
| `server/src/services/procurementPageSubmitService.js` | 后台 `run` 在采购成功后调用回填（`engineTaskId = <taskIdPrefix>_<submitKey>`） |

## 4. 判据

- `test/procurementPageData.test.js`
  - **AC-P2c** 已关联「采购明细」的销售明细**不再出现在补货**；混合场景只保留未关联行。
- `test/procurementSalesLinkBackfill.test.js`
  - **AC-SL1** 只链未关联行、按「编号+尺码」、旧→新、最多=采购明细数量；已关联行绝不被改写；
  - **AC-SL6** **预订优先**（即使现货更旧，也先链预订；数量不够时剩下的才是现货）；
  - **AC-SL2** 幂等：同一 task 重跑 ⇒ 0 条新链；
  - **AC-SL3** 未关联行不够 ⇒ 链已有的 + warn（不抛）；
  - **AC-SL4** 某条 update 失败 ⇒ 其余继续 + failed 计数（不抛）；
  - **AC-SL5** 无批次号 ⇒ no-op；gateway 抛错 ⇒ `ok:false` 且不抛；
  - **AC-SL7** 上新来源（`source=new`）⇒ **直接不参与回填**（即使存在可关联销售行），不 warn；
  - **AC-SL8** 补货来源但没有可关联销售记录 ⇒ **静默跳过**（不 warn，仅汇总 info 计数）。
- `test/procurementPageSubmit.test.js`
  - 后台写成功后 ⇒ 回填一次（taskId 与引擎一致）；后台写失败 ⇒ **不回填**。

## 4.1 分批补的例子（业务负责人问过）

3 天内某编号+尺码卖了 3 双（预订 2 + 现货 1），这次只补 **2 双**：
- 回填：按「编号+尺码、预订优先、旧→新」把其中 **2 条**销售明细关联到本次采购明细；
- 剩下 1 条（这里 = 现货那条）**保持未关联** ⇒ 下次打开补货，这个尺码只显示 **现货 1 双**（默认 0，需手动选）；
- 因此可以**分批补**：这次补 2、下次补剩下 1，已补的那 2 条不会再出现（不会重复报）。

## 5. 边界 / 未做

- 页面协议**向后兼容地新增 `source`**（`replenish` / `new`，用于区分补货与上新；仍不绑销售单号、不传销售明细 record_id）；旧载荷没带 `source` ⇒ 按补货口径处理（见 §7）；
- 回填失败（网络/限流）不会重试调度：下次打开补货时若这些行仍未关联，会**再次出现**（存在重复报风险）——后续可加"回填失败重试"；
- 生产 Base **零写入**（回填只会在真实提交链路里发生；测试 Base 验证需先同步该字段列）；
- 采购/退货/验收/销售其他链路未改；扫一扫仍排最低优先级。

## 6. 测试 Base 真写验证（2026-11-08 03:55）

- 测试 Base 已同步字段：「销售明细.采购明细」（`field_id=fldPG3vq3v`，type=18 SingleLink →「采购明细」，`multiple=true`）；
- 用项目代码在测试 Base 造了 2 条销售明细 + 1 条采购主表 + 1 条采购明细，跑回填：
  - 第一次 `run`：**linked=2、failed=0**；
  - 第二次 `run`（同 taskId）：**linked=0**（幂等）；
  - 回读两条销售明细：「采购明细」= 同一条采购明细记录 `reczz28WuW415l1m` ✓；
- 批次 `CGD-20261108-1432`（采购主表 `reczz28WuVzzVAw3`）；测试 Base 数据按既有口径**保留不删**；
- ⚠️ 合成测试数据时发现测试 Base 与生产结构不一致（测试 Base 的「尺码」是单向关联、「销售日」是自动创建时间、「库存数量」公式不同）⇒ 验证脚本用 `listAll + 客户端筛` 读候选销售行，**写入仍是真实 `gateway.update`**；生产读侧仍走 `config.filters.replenish`。


## 7. 2026-11-09 真机修正：上新/补货分开 + 只在真异常时 warn

真机首单（批次 `CGD-20261109-0001`）暴露：**上新**的 906（当天上架、7 个尺码）没有销售明细可关联，
但回填按"没凑够数量"记了 7 条 `sales_link_backfill_failed` warn —— 数据没坏，但日志误报。

业务负责人口径（2026-11-09）：
- **上新行**：直接不参与回填、**不产生 warn**；
- **补货行**：**没有可关联销售记录** ⇒ 静默跳过（最多汇总一条 info）；
- **有销售记录但没关联上 / 数量不足 / 写入失败** ⇒ **才 warn/告警**。

实现：
1. 页面提交 `items[]` 新增 `source`（`replenish` / `new`，来自她在哪个 tab 选的）；
2. 服务端 `buildItems` 校验并透传（非法值 ⇒ `''`）；`multiItemOrderService` 计划载荷、`postingPlan.plan.items` 冻结 `source`；
3. 回填按 `plan.items[i].source` 分类：
   - `new` ⇒ 跳过（`skipped_new_products`）；
   - `replenish` / 空（旧任务）⇒ 无候选则静默（`skipped_no_sales_rows`），有候选但没凑够/写失败 ⇒ warn；
4. 汇总 info（`sales_link_backfilled`）新增两个计数：`skipped_new_products`、`skipped_no_sales_rows`。

判据：`test/procurementSalesLinkBackfill.test.js` 新增 **AC-SL7 / AC-SL8**；
`test/procurementPageSubmit.test.js` 新增 source 透传用例；AC-SL1~SL6 逐字不变。


## 8. 2026-11-10：回填失败/部分失败 → 统一通知链路

业务负责人（2026-11-10）：「可以通知，你用统一的通知配置化链路」。

**触发条件（只认真异常）**
- 回填抛错（`ok:false`）；
- 写关联失败（`failed>0`，部分失败也算）；
- 有候选但销售记录数量不足（`unmatched>0`）；
- ⚠️ 上新（`source=new`）与「补货但没有可关联销售记录」仍然**静默**，不发通知（§7 口径不变）。

**链路（唯一入口，不直接发 IM）**
- 事件注册：`config/notifications.js` → `procurement_sales_link_backfill_failed`（group，卡片，标题「【采购明细回填失败】」）；
- 发送：`notificationService.send(...)`（目标由 `resolveNotification` 统一解析；⚠️ 2026-11-11 起**单事件开关已全部移除**：触发即发，不再有 `NOTIFY_PROCUREMENT_SALES_LINK_BACKFILL_FAILED_ENABLED`）；
- 行文案：`config/procurementPage.js` 的 `notifications.salesLinkBackfillFailed`（任务/批次号/失败条数/数量不足条数/示例原因/提示），service 不写中文；
- 内容包含：批次号、失败条数、数量不足条数、示例原因、提示「采购单已写成功；关联失败的销售明细下次补货可能重复出现，请人工核对」。

**边界**
- 同一 task 只发一次（submit service 进程内按 taskId 去重；回填只在采购写库成功的那一次跑）；
- 通知发送失败**不影响采购事实**（只记 `sales_link_backfill_failed` warn，runs 仍 ok）；
- 本 PR **只加通知，不加重试**（回填本身仍不自动重试；下次补货这些行仍可能出现）；
- 页面不显示失败提示（统一异步口径）。

**判据**
- `test/procurementPageSubmit.test.js`：真异常发一次（含批次/失败/数量不足行）、静默场景不发、通知失败后台仍 ok；
- `test/procurementSalesLinkBackfill.test.js`：返回值带 `failures` / `unmatched` / `unmatched_details`；
- `test/notifications.test.js`：新事件目标 = group。
