# 配品迁进工作台「销售 → 配品」子 tab（2026-10-14 晚）

> 业务负责人逐字：「把**配品**给**迁移到工作台销售里**，新建一个子 tab，**整体都迁移过去**，
> **只是入口变了，逻辑没有变**」。⇒ 本文件 = 这一次的**验收标准**（先写先红 ✓）。

## 一、口径（**一字不改** ✗ —— 与扫码页那套完全相同）
| 项 | 值 |
|---|---|
| 名称 | 「**其他配品**」下拉（**只读** ✓ 走既有 `listAccessories()` ✓ 30 秒短缓存 ✓） |
| 数量 | **默认 1** ✓（可填） |
| 成交金额 | **必填** ✓（她 2026-10-14：「配品页的**成交金额确实要必填**」✓ 没填 ⇒ **当场拦住 + 人话** ✗ 不许假成功） |
| 付款方式 | **全付**（写入收款明细一行 ✓；`payment_status` 用**已拍板值域**里那个"全付"值 ✓ 不新造 ✗） |
| 落表 | ⭐ **一步成单**：销售主表 **1** + 销售明细 **1** + 收款明细 **1** ✓ |
| 🔴 库存 | **零库存动作**（依据 `docs/sales-total-and-accessory-render-2026-10-07.md:75` C5 逐字「配品不写尺码、**不产生库存动作**」✓） |
| 🔴 幂等 | **同一把 `submitKey`** ✓ 同键两跑 ⇒ **只建一单** ✗ 不重复写 ✗ 不重复收款 ✗ |
| 实现 | **复用既有** `scanWriteService`（`addSaleLine(kind:'accessory')` + `submitSale`）✓ **绝不另起写库** ✗ |

## 二、AC（先写先红）
- **AC-AC1** 工作台「销售」下出现子 tab「**配品**」（`config/domains.js` ✓ `kind:'accessory'` ✓ 位置 = 订单列表/销售查询/客户往来款之后 ✓）
- **AC-AC2** 清单来自**既有**只读接口（`GET /api/workbench/sales/accessories` ✓ 返回值与扫码页同源 ✓ 空清单 ⇒ **人话空态卡** ✗ 不留空 div）
- **AC-AC3** ⭐ **一步成单**：提交一次 ⇒ 主表 **1** / 明细 **1** / 收款 **1**（测试 Base 真跑 ✓ 数表 ✓）
- **AC-AC4** 🔴 **零库存动作**：库存流水 **0 行**、实时库存**一条不变** ✓
- **AC-AC5** ⭐ **同键两跑只建一单**（并发 + 串行各验一次 ✓ 绝不重复写 ✗）
- **AC-AC6** **成交金额必填**：空 ⇒ **HTTP 400 + 人话** ✓ 且**四表零写入** ✗（不许假成功）
- **AC-AC7** 数量默认 **1**（页面渲染值 ✓ 不填也能提交 ✓）
- **AC-AC8** UI 硬规矩：每格 **≥44px** ✓ 点击**即时反馈** ✓ 文案走配置 ✓
  **不许堆说明书文字**（`test/workbenchNoManualText.test.js` 保持绿 ✓）
- **AC-AC9** 旧入口不死：扫码页 `?from=accessory` ⇒ **回落销售** ✓（#523 已定 ✓ 不回归 ✗）

## 三、写作用域（**只碰这些** ✗ 别扩散）
- `server/src/routes/workbench.js`（新增两条：`GET /sales/accessories` · `POST /sales/accessory-sales`）
- `server/src/config/workbenchAccessory.js`（**新**：文案 / 接口键 / 字段名 —— 配置先行 ✓）
- `server/public/workbench/config/domains.js`（加子 tab ✓）· `server/public/workbench/config/links.js`（若需接口键 ✓）
- `server/public/workbench/features/accessory/index.js`（**新**：表单 + 提交 ✓ 复用既有 `api` 与卡片样式 ✓）
- `server/public/workbench/features/domains/index.js`（`kind:'accessory'` 挂载 ✓）
- 测试：`server/test/workbenchAccessoryTab.test.js`（**新** · AC-AC1…AC-AC9 ✓）·
  被影响的既有哨兵**改指向**（不放宽 ✗）
- 🔴 **不碰**：`services/scanWriteService.js` 的写入语义（只**调用** ✓）· 现货/预订/三档付款口径 ✗ · 幂等键 ✗

## 四、完成判据
**全量两遍 EXIT=0** ⇒ PR（不 `--admin` ✗）⇒ 合并 ⇒ 报业务负责人实测 ⇒ **她说"发"才部署** ✗
