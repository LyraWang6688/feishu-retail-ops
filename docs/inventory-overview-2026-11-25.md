# 库存总览（2026-11-25）

> 业务负责人 2026-11-25 定的库存分析第一版：**只做「库存总览」**，并把它拆成
> **受日期限制的「库存变动」** ＋ **不受日期限制的「库存现状」** 两段。
> Issue: [#1559](https://github.com/LyraWang6688/feishu-retail-ops/issues/1559)（原设想三视角，本次只落总览）。

## 她的逐字口径

- 「目前我们就做库存总览，分析当季和非当季的库存总量，以及分析当季的样品数量和门盒数量，以及当季鞋的品类和类别分类，还有供应商分类，因为这个是实时更新的，所以就不需要时间选择」
- 「增加就相当于入库，减少就相当于出库」
- 「目前都放在库存总览里，但是这个是可以受时间限制的对吧，所以如果都放在库存总览的话，这个受时间控制，刚才说的不受时间控制」
- 「不用日期控件不是有了吗在库存分析库存流水上面」
- 「把B放在A前面」
- 「B端和当前项目的默认区间保持一致」

## 一页两段（B 在前，A 在后）

    库存分析
    ├─ 日期栏（页面上已有：开始 / 结束 / 查询，默认今天）
    ├─ tab：库存总览 | 库存流水
    │
    ├─ 库存总览
    │   ├─ B 库存变动（吃上面日期栏）
    │   │    入库 / 出库 / 期间净增（双数 + 笔数）
    │   │    增加 3 条 · 减少 3 条按行为拆；状态调整 4 条只给笔数
    │   └─ A 库存现状（实时快照，不受日期影响）
    │        当季 / 非当季 总量（双数 + 款数）
    │        当季 门盒 / 样品
    │        当季 品类 · 类别 · 供应商
    └─ 库存流水（不变）

- **不新增第二个日期控件**：总览与流水共用库存分析上方那一个。
- 点「查询」：总览 tab 重算 B + 刷新 A；流水 tab 照旧查流水。

## 分类口径

| 分类 | 行为（库存环节） | 编码 |
| --- | --- | --- |
| **入库**（库存方向=增加） | 采购增加 · 手工调增 · 销售增加 | STOCK_PURCHASE_INCREASE · STOCK_MANUAL_INCREASE · STOCK_SALE_INCREASE |
| **出库**（库存方向=减少） | 销售减少 · 采购减少 · 手工调减 | STOCK_SALE_DECREASE · STOCK_PURCHASE_DECREASE · STOCK_MANUAL_DECREASE |
| **状态调整**（库存方向=不影响） | 转冻结 · 转释放 · 转门盒 · 转样品 | STOCK_FREEZE · STOCK_RELEASE · STOCK_TO_DOORBOX · STOCK_TO_SAMPLE |

- 分类一律读 **行为管理.库存方向**，不按行为名称/编码写死；行为表新增一条不用改代码。
- 只有**库存流水**里的行参与 B 段。行为管理里采购/销售/资金环节的行为（入库、现货、预定、退货、赔货…）
  虽然也填了库存方向，但**不写库存流水**，不会出现在这里。
- 状态调整按口径「变动数量 = 0」；真出现非 0 记 state_anomalies，页面仍只记笔数、不并进进出。

## 其它已定口径

1. **空状态按门盒算**（与 config/inventoryStatePolicy.js 同口径）；出现配置外状态（如仓库）单独一桶「其他状态」，不悄悄合并。
2. **未分类保留一行**：品类/类别/供应商为空的实时库存行，计入「未分类」，保证合计对得上。
3. **A 段不读库存流水**；品类取实时库存的「品类」公式列，类别/供应商从「货品信息」按 recordId join（product.类别 单选、product.供应商 关联「供应商管理」）。
4. **日期按「库存流水.创建时间」**（流水没有「发生时间」列），上海时区，默认今天 —— 与库存流水页、销售分析页一致。
5. **货品身份 = recordId**；同编号不同记录不合并（款数按「编号」关联的 record_id 去重）。

## 生产数据快照（2026-11-25 17:16，只读）

| 指标 | 数值 |
| --- | --- |
| 实时库存总行数（= 双数） | 1,612 |
| 当季 | 1,255 双 / 472 款（77.9%） |
| 非当季 | 357 双 / 193 款（22.1%） |
| 当季 门盒 | 784 双（62.5%） |
| 当季 样品 | 471 双（37.5%） |
| 当季 品类 | 单鞋 512 · 棉鞋 335 · 休闲棉鞋 217 · 休闲鞋 160 · 布鞋 23 · 布棉鞋 4 · 未分类 4 |
| 当季 类别 | 男 713（244 款）· 女 542（228 款） |
| 当季 供应商 | 七匹狼/吉祥鸟 637 · 三星 206 · 信踏 201 · 一代千金 128 · 舒美特 33 · 贵帝 22 · 爱拍 12 · 信踏·猫猫派派 9 · 未分类 4 · 恒安利 3 |
| 库存流水（11-15 ~ 11-25） | 1,235 条：增加 740 笔/781 双；减少 334 笔/338 双；状态调整 161 笔/0 双 |

交叉校验：品类管理.双数 合计 1,505 + 无品类 107 = 1,612；供应商管理.库存 合计 1,525 + 无供应商 87 = 1,612。

## 接口

GET /api/workbench/inventory/overview?from=YYYY-MM-DD&to=YYYY-MM-DD（只读，from/to 缺省=今天）

    {
      "success": true,
      "range": { "from": "2026-11-25", "to": "2026-11-25", "days": 1 },
      "change": {
        "from": "2026-11-25", "to": "2026-11-25",
        "inbound": { "records": 740, "pairs": 781 },
        "outbound": { "records": 334, "pairs": 338 },
        "net_pairs": 443,
        "groups": [
          { "key": "inbound", "label": "入库", "direction": "增加", "records": 740, "pairs": 781,
            "behaviors": [ { "key": "rec…", "name": "手工调增", "records": 635, "pairs": 673 } ] }
        ],
        "truncated": false,
        "limit": 20000,
        "state_anomalies": 0
      },
      "snapshot": {
        "total": { "pairs": 1612, "styles": 665 },
        "seasons": {
          "current": { "key": "current", "label": "当季", "pairs": 1255, "styles": 472 },
          "off": { "key": "off", "label": "非当季", "pairs": 357, "styles": 193 }
        },
        "current": {
          "pairs": 1255, "styles": 472,
          "states": [ { "key": "doorbox", "label": "门盒", "pairs": 784 }, { "key": "sample", "label": "样品", "pairs": 471 } ],
          "by_category": [ { "name": "单鞋", "pairs": 512, "styles": 166, "share": 0.408 } ],
          "by_class": [ { "name": "男", "pairs": 713, "styles": 244, "share": 0.568 } ],
          "by_supplier": [ { "name": "七匹狼/吉祥鸟", "pairs": 637, "styles": 264, "share": 0.508 } ]
        },
        "missing": { "season": "current", "category_pairs": 4, "class_pairs": 0, "supplier_pairs": 4 }
      }
    }

## 实现落点

| 层 | 文件 |
| --- | --- |
| 口径配置 | server/src/config/inventoryAnalysis.js |
| 聚合服务 | server/src/services/inventoryAnalysisService.js |
| 路由 / 控制器 | server/src/routes/workbench/inventory.js · server/src/controllers/workbenchController.js |
| 页面配置 | server/public/workbench/config/inventoryLedger.js |
| 前端 | server/public/workbench/features/inventory/ledger.js + overview.js + ledger.css |
| 测试 | server/test/inventoryAnalysisService.test.js · server/test/e2e/inventory-analysis-tabs.spec.js |

## 验证

- pnpm test（新增 6 条服务用例：季节/状态/维度、方向符号、状态类非 0、条件读回退、区间校验、截断）
- pnpm run test:e2e -- test/e2e/inventory-analysis-tabs.spec.js
- node scripts/check-file-size.mjs --base origin/main
- pnpm run observability:events:check

## 已知限制 / 待定

1. **B 段不能按当季/非当季拆**：库存流水没有「当季」快照列；「实时库存状态」是当前值公式，不是历史值。
   要拆只能在写流水时新增一列（动生产表）。
2. **当季调整与转冻结/转释放共用编码**：seasonAdjustmentService 写 STOCK_FREEZE / STOCK_RELEASE；
   要单列需在「行为管理」新增一条行为（动生产表）。今天流水里为 0 笔。
3. **期间净增 ≠ 期初→期末**：库存流水从 2026-11-15 才有数据，入库 − 出库 只能叫「期间净增」。
4. **快照新鲜度**：查询时强制重读实时库存；失败退回最后一次成功快照并打
   workbench.inventory.overview_snapshot_fallback 告警。
5. v1BitableSchema.js 已到 800 行棘轮上界，本次**没有**往 schema 加列；类别/供应商走货品信息 join。
