# 🔴 待删：「售后回写原单销售状态」那套代码

> ⭐ **为什么必须删**：业务负责人 2026-10-06 明确 ——
> 「**售后不会影响已有的销售主表**……**中间层，按照已有的代码！我们变的只是入口！和输出！
> **中间处理没变化**！」
> 而这套代码**正是"中间处理多出来的一段"**（虽然默认关）。
>
> ⚠️ 另外：它写的「原销售主表 · 销售状态」那一列的选项是
> **未写入 / 部分写入 / 已写入 / 写入失败** —— **没有「已退货」**，
> 一旦打开，**飞书会自动新建选项，把那一列搞乱**。
> "退过没退过"本来就记在【销售明细 · 履约状态】和【新建的退货单】上。

## 已核实的现状（`origin/main` 2026-10-06 晚）
- 售后执行器对「销售主表」的写操作只有两处，**都是对的**：
  - `services/afterSalesService.js:379` `gateway.get('salesEntry', 原单 id)` —— **只读**
  - `services/afterSalesService.js:440` `gateway.create('salesEntry', {…})` —— **新建，用同一个销售单号**
- 🔴 **唯一"多出来的一段"**：`markOriginalSaleStatus`

## ⭐ 要删的（精确清单）
```
① `server/src/services/afterSalesService.js`
   · :21-22        注释里提到这个开关与 markOriginalSaleStatus          → 改掉
   · :339-341      `const originalSaleStatus = await this.markOriginalSaleStatus(…)`  → 删
   · :343+         结果对象里用到 originalSaleStatus 的地方              → 删
   · :615          注释「原主表只写「销售状态」（见 markOriginalSaleStatus）」→ 改回「原主表不动」
   · :630-700 左右 `async markOriginalSaleStatus(…) { … }` 整个方法       → 删
   · 相关 import：AFTER_SALES_ORIGINAL_SALES_STATUS / isReturnTradeType /
     withSalesReadRetry / cellText / linkedRecordIds 若只此处用 → 一并删
② `server/src/config/afterSales.js`
   · :40-60 左右  那段讲这个开关的注释                                   → 删
   · :219-222     `writeOriginalSalesStatus: parseExplicitBoolean(env.AFTER_SALES_WRITE_ORIGINAL_SALES_STATUS, false, …)` → 删
③ 测试
   · 删掉只测"开关打开会写"的用例
   · ⭐ **保留/新增**一条：「**售后跑完，原销售主表一个字节都没变**」—— 用现在的真实行为钉住
④ `.env.example` 里若列了 `AFTER_SALES_WRITE_ORIGINAL_SALES_STATUS` → 删
```

## ⭐ 删完的自检（必须为空）
```bash
grep -rn "AFTER_SALES_WRITE_ORIGINAL_SALES_STATUS\|markOriginalSaleStatus\|writeOriginalSalesStatus" \
  server/src server/test .env.example
```

## ⭐ 删完必须
- 全量 `node --test --test-concurrency=1` 连跑 2 次 fail=0
- 真启动一次 `/health` 200
- ⚠️ **不要动**：`salesProgressIntake` / `salesThreadProgressService`（② 进展识别）·
  `afterSalesFlowService`（回复回话题）· `larkMvpService`（入口/出口层）·
  `salesGroupFlowService` · `saleLookupService` 的 `salesEntryRecordId` 只读筛选
