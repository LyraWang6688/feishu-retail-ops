# 售后扫一扫落地页（2026-10-29）

分支 `feat/after-sales-logic`（worktree `.local/wt-after-sales`）。**这一版只做页面**，点按钮之后的处理逻辑还没接。

## 一、页面口径（业务负责人 2026-10-29 逐字）

> 「我们现在做的售后页，点击后实际上是给到一个飞书的二维码（弹起飞书扫一扫）。用户扫码后会出现一个售后页面。
> 这个页面会基于二维码里的信息（里面应该包含货品颜色），去查找 7 天内满足条件的销售情况，
> 呈现出具体的**销售日、尺码，以及销售主表里的总金额**，并给到用户几个备选项。
> 用户点击选择后，下面会有 **3 个按钮**，水平顺序依次是：1 **换货** 2 **退货** 3 **赔货**。」

## 二、页面结构（就是这一版做出来的东西）

```
┌ XHB8095 · 全黑                ← 货品（货号 · 颜色，来自扫码的货品记录 id）
│ 请选择要售后的那一笔销售
│ ┌ 2026-10-29           尺码 38   总金额 ¥300 ┐  ← 一条候选 = 一笔销售明细
│ │   销售单号 XSD-20261029-0005              │
│ └──────────────────────────────────────────┘
│ ┌ 2026-10-29           尺码 39   总金额 ¥300 ┐
│ …（同款货品近 7 天的其它销售记录）
│ 选择处理方式
│ ┌ 换货 ┐ ┌ 退货 ┐ ┌ 赔货 ┐   ← 选中一条候选后才出现；顺序是 换货 → 退货 → 赔货
└────────────────────────────────────────────┘
```

> ⭐ 2026-10-29（业务负责人 HTML 批注「不需要」）：原来页面顶部还有一个「← 返回 售后单」页头，
> 已整块删掉（HTML / 返回按钮处理 / 样式一起删），页面直接从货品（货号 · 颜色）开始。

状态：加载中 / 空态（近 7 天没有这款货品的销售）/ 失败（原因原样显示）/ 「另有 N 条已经售后过，未列出」。
选中候选：卡片高亮；点动作按钮：按钮高亮 + 一行如实提示（处理流程还没接，**不发任何写请求**）。

## 三、⭐ 数据来源（每个字段对应到表 / 列 / 接口）

**接口（新增，只读）**：`GET /api/workbench/sales/after-sales/scan-candidates?productRecordId=<货品记录id>&days=7`
→ `server/src/routes/workbenchOrderActions.js`（路由）→ `server/src/services/afterSalesScanService.js`（读侧）。

| 页面上的东西 | 接口字段 | 读的哪张表 / 哪一列（语义键 → 飞书列名） | 判据 / 说明 |
| --- | --- | --- | --- |
| 货品「货号 · 颜色」 | `product.item_no` / `product.color`（另带 `product.number`） | 「货品信息」`itemNo → 货号`、`color → 颜色`、`number → 编号` | 二维码里是**货品记录 id**（`/r/{recordId}`）；颜色从这条货品记录上读 |
| 一条候选 = 一笔销售 | `candidates[]`（`sales_detail_record_id` / `sales_entry_record_id`） | 「销售明细」按 `product → 编号` 关联到扫到的货品 | 只列**这一款货品**的明细；一条销售明细一个备选项 |
| **销售日** | `sales_date`（毫秒时间戳）+ `sales_date_source` | 「销售明细」`soldAt → 销售日`；没有时退回「销售主表」`recordedAt → 录单日` | 优先明细的「销售日」；来源如实标 `sold_at` / `recorded_at`（不假装两者一样） |
| **尺码** | `size`（数字）+ `size_record_id` | 「销售明细」`size → 尺码`（单选关联「尺码管理」） | 关联单元格的显示文本转数字；拿不到就是空（页面显示 `—`） |
| **销售主表总金额** | `total_amount` | 「销售主表」`totalAmount → 总金额` | 空的显示 `—`（**空与 0 是两件事**，不拿 0 顶） |
| 次要信息：销售单号 | `order_no` | 「销售主表」`orderNo → 销售单号` | 同一单多条明细（不同尺码）时用来区分"哪一单" |
| 「另有 N 条已经售后过」 | `excluded.alreadyAfterSales` | 「销售明细」`fulfillmentStatus → 履约状态` | 判据 = `config/afterSales.isAfterSalesFulfillment`（已退货 / 已换货 / 已赔货，**唯一判据**），这些不再当候选 |
| 其它两种排除（不展示，但如实回给页面） | `excluded.notPosted` / `excluded.outOfWindow` | 主表 `writeStatus → 写入状态`；明细/主表日期 | 没入账（写入失败 / 未完成）不做售后；超出 7 天窗口不进候选 |
| 近 7 天窗口 | `days` / `cutoff` | —— | 前端 `AFTER_SALES_PAGE.days = 7`；后端封顶 30 天（`config/afterSalesScan.js`） |

**为什么新增一个只读接口、而不是复用订单列表那条候选接口**：
既有 `GET /api/workbench/sales/after-sales/candidates`（`salesFollowupService.listAfterSalesCandidates`，订单列表读路径）
**没有读**「销售日」和「销售主表总金额」这两列（它的按需取列清单里没有 `soldAt` / `totalAmount`），
而那个 service 属于另一条并行任务（`salesFollowupService.js` 在 task-6 的写作用域里，本次不动）。
⇒ 落地页走自己的只读取数（**不写库、不改任何既有接口**）；如果以后要合并成一条，
把 `afterSalesScanService` 的两列加进订单列表读路径即可（配置在 `config/afterSalesScan.js` 的 `SCAN_FIELD_KEYS`）。

## 四、代码落点

| 文件 | 作用 |
| --- | --- |
| `server/src/config/afterSalesScan.js` | 读侧配置：时间窗（默认 7 / 封顶 30）、按需取列清单、后端人话 |
| `server/src/services/afterSalesScanService.js` | 只读取数：货品 + 近 N 天销售明细 + 主表总金额；三类排除计数 |
| `server/src/routes/workbenchOrderActions.js` | `GET /sales/after-sales/scan-candidates`（挂在既有工作台鉴权之后） |
| `server/public/workbench/after-sales.html` | 页面外壳（tokens.css + base.css + 本页 CSS） |
| `server/public/workbench/features/after-sales/index.js` | 页面逻辑：候选 → 选中 → 三个动作按钮（这一版不写库） |
| `server/public/workbench/features/after-sales/after-sales.css` | 本页样式（颜色 / 间距 / 圆角 / 字号全部来自 tokens 变量） |
| `server/public/workbench/config/afterSalesPage.js` | 页面文案 / 接口路径 / 动作顺序（换货 · 退货 · 赔货） |

## 五、本地预览（给 HTML 标注用；127.0.0.1，只读）

```bash
node --env-file=/Users/wangying/Documents/workplace/feishu-retail-ops/.env \
     /Users/wangying/Documents/workplace/feishu-retail-ops/.local/preview-after-sales.mjs
# http://127.0.0.1:4213/workbench/after-sales.html?productRecordId=rec28dDHgEcPhL
```

预览服务把**分支里的静态页面**原样吐出，候选接口走**真实的读侧服务 → 项目网关 → 测试 Base（只读）**，
所以页面上的销售日 / 尺码 / 总金额都是测试 Base 的真数据（demo 货品 `XHB8095 全黑` 近 7 天有 4 笔销售）。

**HTML 标注**：标注插件会把页面**重新宿主**到一个 iframe 里（URL 参数会丢、请求会打到插件域），
所以预览服务在吐 `after-sales.html` 时只替换**挂载那一句**调用：
`mountAfterSalesPage(el, { productRecordId, apiBase })`。
页面本身**没有预览分支**（这两个参数是 `mountAfterSalesPage` 的正常可选参数，真实运行不传 = 从 URL 读、同源请求）。

## 六、验收与证据

- 单测：`server/test/afterSalesScan.test.js`（AC1–AC6：字段 / 三类排除 / 销售日兜底 / 400 与 502 口径）；
  `server/test/afterSalesCandidates.test.js` 加 AC-LP1（动作顺序、读 scan-candidates、这一版不许有 POST）。
- E2E：`server/test/e2e/workbench.spec.js` 的售后用例改成新页面口径（候选 → 3 个按钮顺序 → 点击只提示不跳走），
  mobile + tablet 两个 project 全绿。
- 全量 `pnpm test`：0 fail（本分支）；`size:check`：绿。
- 真实 Chrome（390 / 604 视口，测试 Base 真数据）截图：
  `.local/page-shots/after-sales-landing-390-candidates.jpg` ·
  `.local/page-shots/after-sales-landing-390-actions.jpg` ·
  `.local/page-shots/after-sales-landing-390-return-pending-v2.jpg` ·
  `.local/page-shots/after-sales-landing-604-actions.jpg`。

## 七、这一版**没做**的（等她确认页面后再讨论）

1. **三个按钮的触发逻辑**：现在点击只高亮 + 一句"处理流程还没有接上"，**零写请求**。
2. 事件登记：新路由复用了既有事件名 `workbench.sales.after_sales.candidates.failed`（没新造事件）；
   `docs/observability-events.md` 的计数随之重新生成（`config/events.js` 一个字没变）。
3. 已知待办（Lead 已批准、下一阶段做）：售后执行器的「同一原明细重复售后」守卫（P1）、
   关联键贯穿 `afterSales.*` 写库日志（P3）。
