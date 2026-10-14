# 老验收**整块搬进工作台**（2026-10-14 晚 · 业务负责人逐字）

> 她逐字（她把我给的方案原样确认）：
> 「把老验收**整块搬进工作台** ✓：
>  · 工作台「采购 → 验收」的卡片展开后：⭐ **该批的采购明细（货号/尺码/数量，只读）** ✓
>    ＋ ⭐ **自定义尺码（手填尺码 + 数量）** ✓ ＋ ⭐ **自定义货号** ✓ ＋ 实际金额 ＋ 验收原话 ✓ ⇒【确认到货】
>  · 🔴 **复用既有那套写库**（`scanWriteService` 的验收会话 ✓ **不另起一套** ✗）·
>    幂等同一把键 ✓ · 状态值只用已拍板值域 ✓ · 加库存仍走 `InventoryService.applyPurchase` ✓ **不直连表** ✗」

## 一、⭐ 复用的既有件（**真源已核** ✓ 不另起 ✗）
- ⭐ **验收会话 = 既有 `services/scanArrivalService.js`**
  · 造它的形状（与扫码页**同一个**）：`createScanArrivalService({ gateway, config: writeConfig.acceptance, store })`
  · 对外方法：`start` / `addScan` / `finish` / `summaryOf` / `pendingBatches` / `setActualRows` / `submitKeyOf` / `get`
  · 它内部：`start` 读**该批采购明细**（`listPurchaseRequests` ✓ 没读到 ⇒ 人话 `no_request_rows` ✓）·
    `addScan` 收**自定义尺码/自定义货号** ✓ · `finish` **完成验收**（幂等键 = `submitKeyOf` ✓）
- ⭐ **加库存 = 既有 `InventoryService.applyPurchase`** ✓（**绝不直连表** ✗）
- ⭐ **采购明细只读** = 既有 `purchaseQuery.listPurchaseRequests`（工作台那屏已经在用 ✓）

## 二、要做的（工作台那一屏）
```
采购 → 验收 → 某批的卡 ⇒ 展开（既有 <details> 形状 ✓ 不新造 UI 框架 ✗）：
 ① ⭐ 该批**采购明细**（货号 / 尺码 / 数量）—— **只读** ✓（可预填进验收清单 ✓ 她可改的只有实际到货）
 ② ⭐ **自定义尺码**：手填「尺码 + 数量」一行（可多行 ✓）
 ③ ⭐ **自定义货号**：手填/扫到"采购申请里没有的"款 ✓（走既有 `addScan` 那条自定义路 ✓）
 ④ 实际金额 ✓ ＋ 验收原话 ✓（已既有 ✓）
 ⑤ ⇒【确认到货】⇒ 走**同一个** `finish` ✓（同一把 `submitKey` ✓ 同键两跑**只写一次** ✗）
```

## 三、AC（先写先红）
- **AC-AW10** 卡展开后**看得到该批采购明细**（货号/尺码/数量 ✓ **只读** ✓ 无输入框 ✗）
- **AC-AW11** ⭐ **自定义尺码**：手填尺码 + 数量 ⇒ 能提交 ⇒ 该码进这一批的到货明细 ✓
- **AC-AW12** ⭐ **自定义货号**：填一个**采购申请里没有的**货号 ⇒ 走既有自定义路 ✓
      （⚠️ 既有口径：**不知款的自定义行**要**如实**处理 ✓ 不许静默丢 ✗）
- **AC-AW13** ⭐ **同一把 `submitKey`**：**并发 + 串行各两跑 ⇒ 只写一次** ✗（不重复加库存）
- **AC-AW14** ⭐ **加库存走 `InventoryService.applyPurchase`**（源码哨兵：**不许直连表** ✗
      —— 路由/service 里不许出现 `gateway.create/update` 直接写库存表 ✗）
- **AC-AW15** 状态值**只用已拍板值域**（到货状态 / 确认状态 ✓ 不新造选项 ✗）
- **AC-AW16** 手机硬规矩：**≥44px** ✓ **点击即时反馈** ✓ 文案走配置 ✓ **不堆说明书文字** ✓
- **AC-AW17** 失败**如实**：明细读不到 / 没明细 / 重复明细 / 金额不合法 ⇒ **人话 + 不当成功** ✗

## 四、写作用域（实现时）
- `server/src/routes/workbench.js`（新增：`GET /purchase/arrivals/detail`（该批明细，只读 ✓）·
  `POST /purchase/arrivals/accept`（走既有 `scanArrivalService` ✓））
- `server/src/config/workbenchArrival.js`（**新**：文案/字段键 —— 配置先行 ✓）
- `server/public/workbench/features/orders/index.js`（卡片展开里加那几块 ✓ 复用既有 `<details class="action-form">` ✓）
- 测试：`server/test/workbenchAcceptanceFull.test.js`（**新** · AC-AW10…AW17 ✓）＋ 受影响哨兵**改指向**（不放宽 ✗）
- 🔴 **不碰**：`scanArrivalService` 的写入语义（只**调用** ✓）· `InventoryService` ✗ · 幂等键 ✗ ·
  状态值域 ✗ · 现货/预订/三档付款口径 ✗

## 五、与「拆验收」的关系（**顺序**）
- 拆验收 cut A/B 删的是**扫码页那一屏**（`/s/accept` 路由 + 渲染 + 路由分支 ✓）
- ⭐ **本件删的是"入口"，不是"能力"** ⇒ `scanArrivalService` 与 `applyPurchase` **必须留着** ✓（工作台在用 ✓）
- ⇒ 顺序：**cut A 合完** ⇒ 我做本件 ✓（同一片 `routes/workbench.js` ＋ `features/orders/index.js` 不并行 ✗）

---

## 六、实现踩坑（2026-10-14 · 落文件备查 ✓）

⭐ **测试装载前端 feature 的方式**：`test/order-states*.test.js` 那几套会把
`public/workbench/features/orders/index.js` **拷到临时目录**再动态 `import`（临时目录里 `orders-index.mjs`）。
⇒ 该 feature **新增的 import 必须在那个上下文里也能解析**：
**同一屏的新前端配置优先并入既有 `config/orders.js`**（它本来就被这个 feature import ✓），
**不要**为同一屏再开一个独立的 `config/*.js` ✗ —— 临时目录里解析不到 ⇒ **一次打红 ~40 条** ✗
（2026-10-14 实测踩过 ✓；修法 = 把常量并进 `config/orders.js` ✓ 见 9 个文件里那条 diff ✓）。
⚠️ 反向提示：若将来确实要独立配置文件 ⇒ **同时**改那几套测试的临时目录装载方式（把新配置一起拷过去 ✓），
否则"本地单跑绿、全量红"会反复出现 ✗。
