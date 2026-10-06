> **归档说明（2026-10-06 清理任务）**：本文件原为 worktree `/private/tmp/repro` 里的未跟踪文件
> `server/tmp404/FINDING.md`（2026-10-06 00:07）。它是**排查报告**（笔记类），按业务负责人
> 「把有价值的交接笔记收进 docs/、其余连同 worktree 一起清掉」收录。
>
> ⚠️ **唯一的改动**：Base 的 `app_token` 值做了**遮蔽**（只留前 8 位 + `…`）——
> 原文含完整 token，而 AGENTS.md 第 7 条正在治理不许硬编码 token；其余**一字未改**。
> ⚠️ 它是**当时的排查记录，不是当前口径**。

# 采购退货 404 —— 根因已复现并定位

- 测试 Base（可写）：GqMMbhnx…(已遮蔽) · 生产 Base（只读）未被写过一个字
- 复现环境：/tmp/repro（origin/main = 6be6470 的 worktree）· 脚本 /tmp/repro/server/tmp404/
- 主工作区分支 docs/adr-002-robot-entry-triage **未改任何文件**（repo 的 .env 也没动）

## 1. 404 是哪个 URL / 哪张表 / 哪一步

URL（实测抓到的 AxiosError.config.url）：
  GET https://open.feishu.cn/open-apis/bitable/v1/apps/{app_token}/tables//records?page_size=500
                                            ↑ table_id 是**空字符串** → `tables//records`
表格：「尺码管理」= schema.tables.sizeManagement
响应：HTTP 404 · content-type text/plain · body 就是纯文本 `404 page not found`
      （对照实测：飞书业务错误一律 JSON；只有**路由不匹配**才是这段纯文本）

失败步骤（逐调用打点，退货核对阶段第 3 个读调用）：
  1. gateway.listAll("liveInventory")              → OK（1086 行）
  2. gateway.get("liveInventory","recvw7x8AxDEON")  → OK（命中"有货"那一行）
  3. gateway.listAll("sizeManagement")              → 💥 404  ← 就是这里
  调用链：process('supplier-report') → readReportBehaviorKind=PURCHASE_RETURN
        → processSupplierReturn → ensureReturnPlan → planPurchaseReturn
        → 循环里 this.getSizeReferences().resolveLinkedCell(liveRecord.fields.尺码)
        → SizeReferenceService.load() → gateway.listAll('sizeManagement')

## 2. 根因：app.js 的模块加载顺序（#88 引入）

app.js:9-10   require('./services/secondDeliveryService') / require('./utils/secondDeliveryReminder')   ← #88 新增
app.js:19     dotenv.config({ path: '../../.env' })

require 先于 dotenv ⇒ 这条 require 链（→ v1BitableGateway → config/v1BitableSchema.js）在
**process.env 还是空的时候**被求值；而 tableId 是**模块级常量**（getEnv 在对象字面量里立即求值）：
  - sizeManagement (v1BitableSchema.js:93, getEnv 无第二参数) → tableId = ''
  - accessory      (v1BitableSchema.js:72, 同上)              → tableId = ''
  - 其余 18 张表都有硬编码兜底(=生产真实 id)，所以"看起来正常"
  - appToken 是 lazy getter（:19-21），所以也没坏
空 table_id 经 SDK fillApiPath 原样替换 ⇒ `tables//records` ⇒ 未注册路由 ⇒ 纯文本 404
（若参数是 undefined，SDK 会抛 "request miss table_id path argument"，所以只有**空串**能出这个现象）

## 3. 是不是这次部署引入的 ⇒ **是**，#88（随 6be6470 合并）；#89 无关

- 14d9285 的 app.js 在 dotenv 之前只 require express/cors/dotenv/path/crypto/logger/upload/uploadCleanup，
  这些文件都不触及 v1BitableSchema（逐个查过 require）⇒ 部署前 tableId 一定是对的
- 6be6470 把那两行 require 加在 dotenv 之前（git diff 可见）
- 实测两种顺序（同一份代码、同一份 .env）：
    dotenv→require：sizeManagement.tableId = "tblVuUvGU4EP1Wm8"
    require→dotenv：sizeManagement.tableId = ""   且 process.env.FEISHU_V1_SIZE_TABLE_ID 明明有值
- 时间线自洽：23:15（14d9285，tableId 正常）能走到写库存→报"缺少 V1 字段 发生时间"；
  23:27 重启后进程带着 '' 的 tableId 起来 → 23:33 / 23:47 稳定 404

## 4. 逐字复现的线上日志与任务形状

  lark.sdk.error {"detail":[["[object]","404 page not found"]]}                     ← 逐字一致
  purchase.report.batch.failed_retryable {"error":"Request failed with status code 404"} ← 逐字一致
  任务落盘：status=failed, error="Request failed with status code 404",
           has_draft=false, has_return_plan=false, has_posting_progress=false, has_posting_stage=false
  ⇒ 与线上失败任务完全同形：失败在只读核对阶段，一个业务字都没写出去

## 5. 为什么读探针全过 / 为什么只有这类记录炸

- 探针是**另一个进程**（app gateway，env 顺序正确），且这个 bug 只取决于"进程启动时求值的那一刻"
- 边界（/tmp/repro/server/tmp404/boundary.js 实测）：
    A情况(尺码空)+有货 2 双        → 💥 404
    A情况(尺码空)+该货品库存为 0    → ✔ available=0（走"没库存"提示，根本不碰尺码表）
    B情况(填了尺码 41)             → 💥 404（更早：resolveByNumber 先读尺码表）
  ⚠️ 修正用户原话：不是"填了41码所以不炸"，而是"**库存为 0** 所以不炸"；
     填了尺码的记录**同样会** 404（在 resolveByNumber 那步）

## 6. 修法（给方案，未执行）

A. 根因修复（推荐，1~2 行）：把 app.js:19 的 dotenv.config() 提到所有业务 require 之前
   （等价：把 app.js:9-10 两行 require 下移到 dotenv 之后）。改完重启即恢复。
B. 加固（建议与 A 一起）：
   B1. v1BitableGateway 的 get/listAll/create/update/delete 补 `if (!table.tableId) throw`
       （listFields:61-63 已有这个守卫，其余没有）→ 把"无声 404"变成一条人话错误
   B2. 把 tableId 也改成 lazy getter（像 appToken 一样），从根上消掉"求值时机"这个坑
C. 可观测：dotenv 之后立刻自检关键表 tableId，空的直接启动失败（fail fast）；
   部署闸门 v1:schema-check 是**独立 CLI 进程**（自己按正确顺序加载 dotenv），
   天然抓不到这个进程内加载顺序 bug
D. 不建议"只回滚 6be6470"：会连带回退 #89（正是让 23:15「缺少 V1 字段 发生时间」消失的修复），
   退货会退回卡在 schema 那一步；且只加 B1 不能恢复功能（尺码表仍然读不到），必须做 A 或 B2

## 7. 未做 / 不确定

- 未读线上 /opt/box2bitable/.env（也没改、没部署、没重启）⇒ "线上进程里 sizeManagement.tableId 确实是 ''"
  是从**日志逐字一致 + 失败阶段一致 + 只有这一条路径能产出 tables//records**推出的，不是直接读到的
- 可验证预测：同一原因下线上 `accessory` 也应当是 ''，所以**凡是读「其他配品」的销售路径也会 404**，
  同一时段应当还有别的 404 warn（这就不只是退货的问题了）
- 测试 Base 只写了 1 条记录（③ 要求的那条）：供应商对接 reczz28Jmxqsfaca（数量2、尺码空、采购行为=采购退单、
  货品 rec28e2HD1zrQE 编号 86822|黑色|A）。单据信息 80 / 库存流水 164 / 实时库存 1086 全部**未变**
- 未跑"修好后完整出单"（会真实扣测试库存 + 给人发飞书图）；fixed 模式只验到只读核对成功
