# ④「货 / 钱分离」收尾 —— 交接文档（2026-10-17 01:18 上海）

> **给接手的 AI**：这份文档的目的是**换手即可继续**。请先读完整份，再动手。
> 所有结论都指到了 `文件:行` 或给出可复现命令；**没有结论的地方我都明确写了"未核"**。

---

## 0. 一句话目标

把 ④「货 / 钱分离」（业务负责人 2026-10-16 拍板、**没有开关、永远开**）收尾：
**判据全绿 → 按她的口径改资金页与工作台 → 两遍全量 → 变异验证 → push → PR。**

---

## 1. 当前真实状态（现核 · 2026-10-17 01:18 上海）

| 项 | 值 |
|---|---|
| **线上** | `5e6f85e` @ **2026-10-16 23:34:36 上海**（v0.4.47，`/health` 对版、事件 `ok`、重启后零 error/warn） |
| **主工作区** | 分支 `main`，干净。**远端分支只剩 `main`** |
| **④ 那支** | worktree `.local/switch-34` · 分支 `chore/no-switch-34` · **HEAD `53fe3d01`** · 落后 main **0** · 树干净 |
| **我跑的那 9 个文件** | `183 tests / 179 pass / 1 fail`（剩「失败有人话」，见 §3.A） |
| **全量（344 文件）** | `2997 / 2986 / 4` ⇒ **4 条红**（见 §3.B） |
| **开着的 PR** | `#793`（口径落档，未合）· `#789`（成功页极简＋单号，未合，将并入 ④ 后关闭） |
| **冻结件** | `services/scanWriteService.js` · `services/salesDeliveryService.js` —— **全程一个字没碰** ✓ |

⚠️ **重要**：**线上没有这些问题**。所有红都在 ④ 那支上（它**还没 push、没 PR、没上线**）。

---

## 2. 这一晚做完了什么（**可验证**）

1. **判据迁移：33 红 ⇒ 9 文件 1 红**（清 32 条）。每一条都写了「改前逐字 → 改后逐字 → 依据」。
   - 「已知绿」三条（`AC-H1/H2`、`AC-H3`、`AC-E2E-17`）**每批都跑，全程 4/4**，一次回归都没漏。
2. **真 bug 修好 1 个**：④ 那一刀把「货那一跑」从原段挪出来时，**把耗时汇总日志留在了死代码里** ⇒
   「提交那一发」的 `scan.sale.timing` 再也不打 ⇒ 她"卡在哪一步"查不到。**已搬回 ＋ 加反向哨兵 ＋ 注射验证真咬**（注释掉"传 timing"⇒ 哨兵红；还原 ⇒ 绿）。
3. **业务负责人口径 4 份全部落档并合进 main**：
   - `docs/receivable-vs-received-2026-10-17.md`（应收 = 货品页实收累加 = 主表「总金额」；收款可少不可多）
   - `docs/goods-run-vs-money-page-2026-10-17.md`（货那一跑 vs 资金页；默认一行＋可加付款方式＋默认微信；只填本次金额；没有"跳过"；订单列表只留"二次交割"与"售后"）
   - `docs/no-switch-rule-2026-10-16.md`（不要开关思维）
   - `docs/scan-money-split-async-race-2026-10-16.md`（known bug，已在 main）
4. **大发现（省掉一次冻结件改动）**：**"点成交就扣库存"在 ④ 那支上【已经实现】**——
   用例 `test/scanSaleE2E.test.js:635`（提交前 1 双）＋ `:734`「第2步：库存只扣了一次」＋ `:726`（库存流水 1 行）
   ⇒ **"把扣库存从资金页挪到货那一跑"这一件不用做**（她 2026-10-17 已点头要它；实际已满足）。

---

## 3. 待办（**逐条给到位置与做法**）

### A. 🔴 【真 bug】「半成」页被通用失败页吃掉（**这是我 revert 掉的那件，正解已定位**）

**现象**（`test/scanPageWrite.test.js:958` 一带用例）：
注入 `h.gateway.update` 抛错（**更新** ⇒ 主表**已建** ⇒ 语义是"半成"），
期望 `texts.partialFailedTitle`，实测却是 `texts.failedTitle`。

**定性证据（两边都测过）**：
- **干净 `origin/main`（`ee825f81`）上跑该用例：`pass 2 / fail 0`（绿）**；④ 那支上红 ⇒ **④ 引入的回归**。
- `test/scanPageWrite.test.js:966-969` 注入的是 `h.gateway.update`；主表由 `create` 建 ⇒ **失败时主表一定落了**。

**根因**：`routes/scanPage/index.js` 的 `respondWriteFailure`（定义在 **`:1305`**）里，
`title: moneyFailure ? human : writeConfig.texts.failedTitle`（**`:1326`**）—— **从没判过 `sale_partial_failed`**，
而 `:1312` 的注释早就写着「`sale_partial_failed` 也归 500：单子记上了、后面某步没写完」。

**正解（route-only，不动冻结件）**：**在 `respondWriteFailure` 函数【内部】**、`const status = [...]`（`:1313`）**之前**，
补一支：

```js
if (result?.code === 'sale_partial_failed') {
  const orderLine = fillWriteText(writeConfig.texts.submittedOrderLine, { orderNo: result.order_no || '—' });
  markTapCode(res, result.code);
  return sendHuman(res, 500, {
    title: writeConfig.texts.partialFailedTitle,
    body: fillWriteText(writeConfig.texts.partialFailedBody, { orderNo: result.order_no || '—' }),
    requestId,
    details: [orderLine],
    retryHint: writeConfig.texts.partialFailedRetryHint,
    backPath: postActionFor(backTargetFor(req, decodeURIComponent(String(req.params.number || ''))), realm),
    backLabel: writeConfig.texts.submittedRecordAnother,
  });
}
```

- ❌ **不许**在**调用点前面**插分支：`test/saleMoneySplitWire.test.js` 的 **AC-MSW2**（`:60`，断言在 `:68`）
  用正则 `/goods\.ok !== true\)\s*return respondWriteFailure/` 钉着「调用点必须**紧邻** `respondWriteFailure`」
  ⇒ 前面插分支会打破它。**我踩过一次。**
- ⚠️ 我第 2 次"挪进函数内部"时 **AC-MSW2 与「失败有人话」两条同时红** ⇒ 我的挪法仍有问题 ⇒ **已 revert**。
  **下次：一次只动一处，每步单跑这两条判据**（`--test-name-pattern` 各跑一次），别攒到最后。
- ⚠️ **业务负责人 2026-10-17 01:17 说**：「（失败时）**我们统一就回答：任务创建失败呀！**」
  —— **但"任务创建失败"这句在代码里【不存在】**（全仓库搜过），**且要区分两种失败**：
  - 单子**没建上** ⇒ 「任务创建失败」合理；
  - 单子**已建上（有单号）** ⇒ 若也说"任务创建失败"，她会以为什么都没建 ⇒ **可能重复下单**。
  **Lead 已把这个二选一（甲：统一"任务创建失败"／乙：分开显示）问了她，尚未答复。**
  ⇒ **接手时先确认这一条再动手**；若她选甲，则 §A 的正解要改成给「任务创建失败」+（建议仍显示单号）。

### B. 🔴 全量 4 条红（344 文件）—— 只查清了 1 条

- **已定**：`test/scanPage.test.js:322`「④ 只读（源码扫描）：config / service / view / route 四个文件里没有任何写调用」，
  实测 `scanPage.js 出现了写链路的服务：/inventoryService|salesOrderService|purchaseWebhookService/`。
  **干净 main 上这条绿** ⇒ **④ 引入**。⚠️ 修它要动 `routes/scanPage/**`（不是冻结件），但**先看清是哪个文件被引入**。
- **未查**：另 3 条。跑法：
  ```bash
  cd .local/switch-34/server
  CI=true /usr/local/bin/node --test --test-concurrency=1 test/*.test.js > /tmp/full.log 2>&1; echo EXIT=$?
  grep -a -B2 -A12 '✖' /tmp/full.log | head -80
  ```
  ⚠️ 判"是不是老问题"**必须**在**干净 `origin/main`**（= 主工作区）上再跑一遍同一条（纪律③）。

### C. 资金页改法（**她 2026-10-17 已拍板 · 不是冻结件**）

- 收款行**不再按 `count`（这一单几双）预置** ⇒ **默认一行**；
  现在按双数预置的证据：`views/scanPage/paymentBlock.js:57`「正常打开页面（`rows` 没给）⇒ **预置 `count` 行**」；
  `:62` `buildPaymentRows({ count, defaultMethod, rows })`。
- **新增「＋ 再加一种付款方式」**（点一下多一行；一行 = 付款方式下拉 ＋ 金额输入框），
  风格照既有那颗「＋ 再加一个货品」（`paymentBlock.js:183`，`data-multi-add`）。
- **默认行的方式 = 「微信」**（她逐字）。
- **去掉「跳过」** ⇒ 只有「提交」（现状：`config/scanWrite.js:15` 逐字「钱可以先不填（"先货后钱"）」、
  `:125` 逐字「未付（默认档）：一个字都不用填」）。
- 各行金额合计：**= 总金额 ⇒ 全付** ／ **< ⇒ 未付或部分付（轧差记【未收款】）** ／ **> ⇒ 拦住 + 提示「收多了（差额）」**。
- 动态交互**允许**（她 2026-10-12 明确「我们是能够进行动态交互的」）；页面已有 `<script>`：`views/scanPage/index.js:311`、`:354`。
- ⚠️ 连带：那些钉着「资金页可以空着成单」的老判据，**按新口径迁移（不删不放宽）**。

### D. 工作台订单列表：删「补充信息单」

- 现状：`server/public/workbench/config/orders.js:124`
  `{ key: 'supplement', label: '补充信息单', tag: '待补充', tone: 'warning' }`。
- 她 2026-10-17 逐字：「销售订单列表里**已经没有**所谓的"待补充信息"了，**只保留二次交割以及售后**」。
- ⚠️ 删前 `grep -rn "supplement"` 核它是否还被筛选/分类引用（别留半截）。

### E. 资金页显示「总金额」（她 2026-10-17 拍板要做）

- 「总金额」算法：`config/v1BitableSchema.js:197` 逐字「总金额 = 那些逐行值的和（含券调整、含少付）」。
- 写入点：`services/salesOrderService.js:291-294`（`update('salesEntry', …, { totalAmount })`）＋ `:296` 有日志。
- **资金页现在没有显示它**：`views/scanPage/index.js:214-216` 注释逐字「资金页现在只剩：收款行 ＋ 赠品」。
- 落地建议（Lead 已核）：在 `sendPaymentStep` **一处**加入参（它 7 个调用点共用：`:293` `:1762` `:2307` `:2437` `:2853` `:2979` `:3122`），
  视图加一行纯文案 ＋ 稳定 `data-view`；**零链接零按钮零自动跳**；文案走 config。

### F. ③「成功页极简」单独一小版（她 2026-10-16 23:4x 起明确要）

- PR `#789` 已在（`chore/success-minimal`）—— 成功页**一句话、零链接零按钮零自动跳、看得到单号**。
- 需要：或在 `#789` 上继续，或并入 ④ 那个大 PR（**按"语义边界"判，不按文件边界**）。
- ⚠️ 共享尺子 `tools/task61-render-baseline.js` 与 508/3xx 那把**一个字不动**。

### G. 收尾（**缺一不可**）

- **两遍全量 `EXIT=0 ×2`**（不带 `.env` 的 CI 口径亦可，如实标注）；
- **变异 ≥2 组真红 ＋ 还原逐字节**；
- **`push`（首推用 `-u`，绝不 `push -f`）** ⇒ **四件 CI 全绿** ⇒ **PR（不合并）**；
- **合之前**必须问业务负责人一句「**现在能发吗**」（授权一次性，不拿旧的）。

---

## 4. 红线（**逐字 · 不可商量**）

- 🔴 **严禁自行部署**（每次先问「现在能发吗」）；生产 Base **只读**；严禁飞书 CLI。
- 🔴 `services/scanWriteService.js` 与 `services/salesDeliveryService.js` **一个字不加/删/改**（冻结件）；真需动 ⇒ **停手报她**。
- ⭐ 判据 **不删 / 不 skip / 不放宽**；改既有判据必须写「改前逐字 → 改后逐字 → 依据」；**数字实测写死**，不许条件表达式/变量算。
- ⭐ 汇报用**上海时间**（服务器日志是 UTC，先换算）。
- ⭐ 新增文档必须登记 `docs/README.md`。
- ⭐ **合并一律 `git merge`（不带 `-X`）**；冲突必须被看见。**绝不 `push -f`**。
- ⭐ **谁合谁清 worktree**；判据 `git cherry origin/main <分支>`（不用祖先关系）；清前先留档 diff，**不用 `--force`**。
- ⭐ **同一 worktree 同一时刻只许一个写入者**。

---

## 5. 今晚踩过的坑（**别重复**）

1. **改一处判据 ⇒ 必须 `grep` 出它名下【所有】断言 ＋ 它自己的注释** —— 今晚出现 5 次"改一半"。
2. **`grep` 出的行要看它属于哪个 `{}` 块** —— 我丢了缩进，把"块外"读成"块内"，把结论说反过一次。
3. **别用 `python` 正则整段替换判据** —— 锚点要么 count=0、要么 count=3（同类循环有 3 个），白费两轮。
4. **别用 `\uXXXX` 转义写中文** —— 我手打转义写错，python 直接语法错（文件没改，但白费一轮）。
5. **源码哨兵钉的是【代码形状】** —— 在调用点前面插分支会打破 `AC-MSW2`（见 §3.A）。
6. **判"是不是老问题"必须测干净的 `origin/main`** —— 今晚靠它定了 2 个真 bug 的性质。
7. **`node --check` 只证语法、不证"有没有删掉代码"** —— 改完 `src/**` 要**先加载一次**自证。
8. **改 `src/**` 后先跑「已知绿」那三条**（`AC-H1/H2`、`AC-H3`、`AC-E2E-17`）—— 一红就是回归。

---

## 6. 接手的建议顺序

1. 读 §1 现状 ⇒ `cd .local/switch-34 && git log --oneline -5` 对一下。
2. **问她/看答复**：§3.A 的「任务创建失败」是（甲）统一 还是（乙）分开（Lead 已问，未答）。
3. 做 §3.A（正解在 `respondWriteFailure` 内部，一次只动一处）。
4. 跑全量 §3.B，查清 4 条红。
5. §3.C / §3.D / §3.E（她已拍板，不涉冻结件）。
6. §3.F / §3.G 收尾。
