# 扫货品码却落到「资金页」—— 按她选的 **②** 落地（2026-10-16 · task-60）

> **来源与边界（先读这一段）**
> · 现象来源：业务负责人 2026-10-16 05:34（上海真机）**截图 + 逐字**：「我用你最新的线上版本测试了一下，
>   静态感觉很好，扫描了几个货品二维码，**但是有一个货品点击了之后出现的是这个资金页** ✗」
> · 修法来源：⭐ **她当日亲口选的方案 ②**（逐字见 §1）——**不是我方自行决定的** ✓。
> · 定位来源：上一任的只读诊断 `docs/scan-landing-diag-2026-10-16.md`（已进 main · #712）——
>   本文**直接引用它的结论**（落点判定条件 / §5.1 的日志待执行清单），**不重新论证** ✓。
> · 🔴 行号基准：本刀**开发时**的 `origin/main` = **`aa311cd`**（含 #710「一单多货路由半」+ #712），
>   **提交前已 rebase 到 `b2e2c28`**（#713，只动 `docs/stage-gate-audit-*.md` ＋ 一个**别**的用例文件
>   ⇒ 与本刀无交集 ✓；两遍全量就是在 rebase 后的树上跑的 ✓）——
>   本仓行号会漂 ⇒ 本文与源码哨兵**都按锚点文本**定位（不靠行号 ✓）。

---

## 1. 她的原话（逐字 · 这就是本刀的**唯一依据**）

> 我问：「你扫 A 货品、点「销售」，却被顶到**上一单**的资金页 ✗ ⇒
> ① 接管前先核对"是不是这个货品" 还是 ② 重扫同一个货品就从头开始（清掉那条未完成）？」
> 她答：**「② 还是重扫同一个货品就从头开始（清掉那条未完成 ✓）」**

⇒ 落地口径：**扫到货品、点「销售」那一发 ⇒ 先把那条"未完成"的标记清掉 ⇒ 页面从货品页开始** ✓。
（上一任的诊断倾向 ① 并提示"② 与刷新不丢冲突风险最大、改之前必须问她"——
**她选了 ②**，所以本刀要解决的核心问题正是**在不破"刷新不丢"的前提下把 ② 落地**，见 §2.2。）

---

## 2. 改了什么

### 2.1 一处判定（`server/src/routes/scanPage.js` · GET handler）

在"**刷新仍给资金页**"那段接管**之前**加一个分支（**位置：`salesContext` 那一行之后、既有接管 `if` 之前**）：

```js
const explicitSalesScan = String(req.query?.from || '') === 'sales';
if (pendingMark === 'pending' && explicitSalesScan) {
  // ① 只清这两个键（`undefined` = 这个键不在 —— 与既有残标记清理**同一种清法**）
  await Promise.resolve(writeService.saveDraftLines?.(
    openIdOf(req), { paymentStep: undefined, submitPending: undefined },
  ));
  // ② 如实记 `scan.payment_step.reset_on_scan`（带旧值 / 旧状态 / 清没清）
  // ③ pendingMark = ''   ← **这一句才是"别再接管"的开关**
}
if (pendingMark === 'pending' && salesContext) { /* 既有接管：**逐字未动** ✓ */ }
```

三件事，缺一不可：

1. **清**未完成标记（`paymentStep` + 同笔的 `submitPending`）；
2. **记**一条 `scan.payment_step.reset_on_scan`（清失败另有 `scan.payment_step.reset_failed` 的 warn）；
3. **把本地那份标记置空**（`let pendingMark` → `''`）⇒ 下面那条既有接管**不再命中** ⇒ 这一发继续走
   **正常整页渲染** ⇒ 她看到的是**货品页** ✓。

> ⚠️ 为什么用"置空本地变量"而不是改那行判据：**既有接管那一行（`pendingMark === 'pending' && salesContext`）
> 逐字不动** ⇒ 既有的两条源码哨兵（`scanPaymentStepRealmScope.test.js` AC-PS1 ·
> `scanPaymentStepStale.test.js` AC-SM6）**照旧绿** ✓，而且改动面最小。

### 2.2 ⭐ 触发点为什么是**显式 `?from=sales`**（本刀最容易做错的一处）

| 请求形状 | 是谁发的 | 本刀怎么处理 | 为什么 |
|---|---|---|---|
| **裸扫**（不带 `from`） | 标签二维码首屏；**也是资金页那张表单的 POST 目标**（`postActionFor(target,'sales')` ⇒ 缺省领域**不带** `?from=`） | **一个字不改**（照旧接管 ⇒ 资金页） | 那是她 2026-10-14 定的「**资金页刷新不丢**」（AC-PF4 / AC-SM2 / AC-SM3 / AC-SM7 / AC-SM8 **原样钉着**）—— 在裸扫上清 = **清过头** ✗ |
| **`?from=sales`** | **她点「销售」那个 realm tab**（`views/scanPageRenderer.js`：`href="?from=<领域>"`） | **按 ② 清掉未完成 ⇒ 货品页** | 上一任诊断 §2.3 / §3.1 已证：线上（骨架屏开 + `firstEntryOnly`）**裸扫先回骨架**、骨架自取那一发 `?data=1` **绕过接管** ⇒ **能落到资金页的入口只有这一发** ✓ 正是她截图那一下 |
| 非销售领域 / `?data=1` | 别的 tab / 骨架脚本 | **不清、不接管**（逐字不动） | 10-14 晚那条边界（AC-SM4）＋ `data=1` 那道闸门 ✓ |

### 2.3 🔴 清的范围 / **不清什么**（逐条 · 她逐字"清掉那条未完成"）

**清（只有这两笔，同一笔写进会话）：**

| 键 | 值 | 为什么 |
|---|---|---|
| `sale.paymentStep` | `undefined`（= **这个键不在**，`scanSessionService` 默认 `sale` 的形状 —— **不新造状态值** ✗） | 这就是"未完成"那个标记本身 |
| `sale.submitPending` | `undefined` | 她 2026-10-15 定下的"点按钮那一刻要写的那一双"pay 载荷；`paymentStep` 一清它**就没有读点** ⇒ 同笔清是纯卫生 ✓ |

**不清（一个字都不碰 ✗）：**

| 不碰的东西 | 证据（判据） |
|---|---|
| `sale.lines`（她的草稿行） | AC-LR2a：**除那两个键外会话对象逐字相等**（`deepEqual`）；AC-SM2b：**草稿行原样还在** |
| `sale.order_no` / `sale.master_record_id`（已建单的事实） | AC-LR2a（`order_no` / `master_record_id` 原样） |
| `sale.status` / `sale.completed` / `sale.seq` | AC-LR2a（`deepEqual` 覆盖） |
| **已落库 / 已提交的单**（飞书那边的数据） | AC-LR2a：**零业务写入**（`write.calls === []` ＋ 零 `bitable.record.*` ＋ 零 `v1.sale.posted`）—— 这一段**只写本地会话** ✓ |
| **别人的会话** | AC-LR2b：只写签名 cookie 那个 `open_id` 的那一份 ⇒ **别人的会话逐字未动** ✓ |
| 非销售领域 / `?data=1` / **裸扫**那一发 | AC-LR2c（三条逐条断：不清、不接管、`?data=1` 穿过整段） |

---

## 3. ⭐ `scan.page.rendered`（上一任已批准、本刀**落地** ✓）

**复用上一任的设计**（同一事件名 / 同一字段 / 同一个 `logRendered` 助手 ——
留档见 `.local/landing-diag/landing-diag-rendered-log.patch` 与它的用例原文；
本文**不另写一份** ✗）：

| 字段 | 取值 | 说明 |
|---|---|---|
| `page` | `skeleton` \| `pay` \| `goods` \| `success` \| `not_found` \| `bad_number` \| `failed` | ⭐ **她看到的是哪一页** |
| `trigger` | `skeleton_first_entry` · `pending_mark:lines\|order\|status_not_submitted` · `realm:<领域>:<explicit\|remembered\|default>` · `write_ok` · `payment_step` · `lookup_not_found` · `lookup_bad_number` · `render_failed` | ⭐ **哪条条件命中** |
| `query_keys` | `Object.keys(req.query).sort()` | **只字段名** ✗ 不记值 |
| `number` | 本次扫的编号 / 记录 ID | 与 `scan.page.viewed` 同口径 |

**出口清单（7 个 · 全部落地）**：骨架屏 · 资金页（`sendPaymentStep` 内部、`sendHtml` **之前**）·
货品页 · 成功页（`sendSuccess` 收第 4 个可选参数 `req`，**9 个调用点一个不落全传了** ——
含 #710 新增的"一单多货品"那条成功页 ✓）· 空编号 · 查不到 · 未预期异常。

⭐ 她点名的"**4 个出口**" = 骨架 / 货品页 / 资金页 / 成功页 ⇒ **AC-LR4** 逐出口断"四个字段一个不缺"＋
`request_id` ✓（另三个出口也有判据：AC-RL9b 等）。

### 3.1 ⚠️ 与 **#714**（task-58）的合并 —— 同一件事两个人做，最后是这么合的

`#714`（`d9b6d2c`，**比本刀先合**）已经把**同一份**日志补丁（= `.local/landing-diag` 那份留档，逐字）
合进了 `server/src/routes/scanPage.js` ＋ 新建了**同名**的 `server/test/scanPageRenderedLog.test.js`。
⇒ 本刀 rebase 之后**不重复实现**，只保留**它没做的那三件**（都记在 PR 里）：

| # | 本刀的净增量 | 为什么 |
|---|---|---|
| 1 | `config/scanPage.js` 补 `EVENTS.rendered`（＋本刀那两条 reset 事件名） | #714 **刻意没碰** `config/scanPage.js`（当时那份文件有主）⇒ 它的 AC-RL10 里那条判据是**条件式**的（"摘键期间由兜底字面量顶"）。本刀把键补上 ⇒ 那条判据**自动走严格断言**（`SCAN_PAGE.events.rendered === 'scan.page.rendered'`）—— **判据被加强，没被放宽** ✓ |
| 2 | 成功页那条日志带 `number`（＋"一单多货品"成功页也传 `req`） | 她点名的"字段齐"（AC-LR4）：`page:'success'` 也要说得出来"是哪一件" ✓ |
| 3 | `test/scanPageRenderedLog.test.js` 里那 3 条 GET 接管用例（原 AC-RL2/RL3/RL4）**搬去**本刀那个骨架屏关的用例文件 | `?from=sales` 从本刀起**按 ② 先清标记**（⇒ 货品页）；骨架屏开时**裸扫**又够不着资金页 ⇒ 那三条在本文件里**结构性够不着**。三条 `pending_mark:*` 断言**原样**活在 `test/scanLandingResetOnScan.test.js` 的 **AC-LR2c ③**（**一条没丢** ✓） |

---

## 4. 🔴 既有「残标记自清理」分支**一个字没改**（证据）

- 源码哨兵：**AC-LR3** 把那段（`// 🔴 **残标记**（0 行 + 没单号 + 已 submitted）…`
  到 `had_submit_pending: hadSubmitPending,` 那笔 `});`）**逐字节冻结**在用例里 →
  `src.includes(FROZEN)` 必须成立（**改一个字就红** ✓）。
- 落地时用脚本核过：该段 **1803 字符**，与 `origin/main` 的同一段**逐字节相同** ✓；
  那条分支的两条日志名 `scan.payment_step.stale_cleared` / `stale_clear_failed` **照旧** ✓。
- 行为哨兵：**AC-LR3b** —— 残标记形状走**裸扫**那一发 ⇒ 照旧**不给资金页** ＋ 照旧打
  `scan.payment_step.stale_cleared`（而**不**打本刀那条新日志）⇒ "那条分支真的还在跑" ✓。
- ⚠️ 两条日志**各司其职**：`stale_cleared` 治"有 pending 但**没东西要付**"（2026-10-15 #598/#601）；
  `reset_on_scan` 治"**她主动重扫**"（本刀）。

---

## 5. 成对迁移（受本刀行为变化波及的既有判据 · **不许删/skip/放宽** ✗）

| # | 文件 / 判据 | **改前逐字** | **改后逐字** | 依据 |
|---|---|---|---|---|
| 1 | `server/test/scanPaymentStepStale.test.js` **AC-SM2b** | 两发 `getPage(base, '?from=sales')` ⇒ 断言**资金页** ＋ `assert.deepEqual(write.patches, [], '两次刷新都不许清标记 ✓')` | 同两发请求 ⇒ 断言**货品页** ＋ 清掉那两个键（**另加**"草稿行原样还在"） | 她 2026-10-16 选 ② ⇒ `?from=sales` = 她点「销售」⇒ 按 ② 从头开始。⚠️ **"刷新不丢"没被删**：真正会刷新的是资金页那张表单（POST 目标 = **裸 URL**）⇒ 由**同文件 AC-SM2 / AC-SM8**（裸扫那两条，**原样未动**）钉着 ✓ |
| 2 | `server/test/scanPaymentMethodsFromTable.test.js` **`getMoneyPage`**（AC-A2A-3a/3b/3d 共用） | `${base}/s/${NUMBER}?from=sales` | `${base}/s/${NUMBER}`（**裸 URL**） | 同上：本文件主题是"**候选收款方式读表**"，与"从哪个 URL 进来"无关；改后走的是**真实那条路**（资金页表单自己的 POST 目标 = 裸 URL）✓ **三条断言一个字没动** ✗ |

> ⚠️ 被本刀**搬走**（不是删掉）的用例：上一任留档那 3 条"GET 接管 ⇒ 资金页"的 trigger 判据
> （原 AC-RL2/RL3/RL4）在**骨架屏开**那个文件里**够不着**（裸扫被骨架抢先、`?from=sales` 又按 ② 清了）
> ⇒ 搬到**骨架屏关**的 `server/test/scanLandingResetOnScan.test.js` **AC-LR2c ③**（裸扫那三条 trigger
> `pending_mark:lines|order|status_not_submitted` 逐条仍在 ✓）—— **判据一条没丢** ✓。

---

## 6. 验收标准（先写后做）＋ 结果

| 判据 | 内容 | 结果 |
|---|---|---|
| **AC-LR1** | 未完成（`pending` + `submitPending`）+ 点「销售」⇒ **货品页** ＋ **标记被清** ＋ **一条 `reset_on_scan`**（带旧值/旧状态/清没清） | ✅ |
| **AC-LR1b** | **扫任意货品**（换编号）同结果（② 不带"是不是这个货品"的核对 ⇒ 与货品身份无关） | ✅ |
| **AC-LR1c** | 清掉后再点一次 ⇒ 仍是货品页，且**不再清第二笔**（真跑了一遍） | ✅ |
| **AC-LR1d** | **真链路一串联**：点「提交这一单」⇒ 资金页（照旧）· 再点「销售」⇒ 货品页从头开始 | ✅ |
| **AC-LR2a** | 已提交的单 / 已落库数据**一个字不动**（除那两个键外会话**逐字相等** ＋ 零业务写入） | ✅ |
| **AC-LR2b** | **别人的会话**一个字不碰 | ✅ |
| **AC-LR2c** | **不清过头**：非销售领域 / `?data=1` / **裸扫** ⇒ 一律不清（裸扫仍接管 ⇒ 顺带钉三条 trigger） | ✅ |
| **AC-LR3** | 既有「残标记自清理」**逐字未动**（源码哨兵 ＋ 行为哨兵 AC-LR3b） | ✅ |
| **AC-LR4** | `scan.page.rendered` **四个出口**（骨架/货品/资金/成功）各一条、`page`·`trigger`·`query_keys`·`number`＋`request_id` 一个不缺 | ✅ |
| **AC-LR5** | 两遍全量 `EXIT=0` ×2 ＋ 四件 CI 全绿 | 见 §7 / PR |

---

## 7. 数字与证据（如实）

- **两遍全量**（`server/` · `pnpm test` = `node --test --test-concurrency=1`）——
  **两遍跑的是【同一个 commit】、工作区全程一字未改**：
  两遍前后 `git status --porcelain` **恒空**、`git diff | shasum -a 256` = 空 diff 的固定值
  `e3b0c442…b855` ✓。
  - ⭐ **数字（tests / pass / fail / skipped）、`HEAD`/`tree` 与三个关键文件的 sha256 写在 PR 说明里**，
    **不写进这份文档** —— 这样"**两遍跑完之后就不用再改树**"（文档也是在两遍之前就定稿的 ✓）。
  - 三个关键文件（两遍后复核）：`routes/scanPage.js` · `config/scanPage.js` ·
    `services/scanWriteService.js`（最后一个 = **与 `origin/main` 逐字节相同** ⇒ 冻结件没被碰 ✓，
    具体 sha256 见 PR）。
  - ⚠️ 本机 Node **v24**（CI 是 **20**）—— 最终权威是 CI 那几件 ✓。
  - ⚠️ **`pnpm test` 的前置依赖检查**（pnpm 11）在 worktree 里会试图 **purge `node_modules`**
    （worktree 里那份是**软链到主工作区**的 ⇒ 一 purge 就动到别人装好的依赖 ✗）⇒
    本机改用 `pnpm --config.verify-deps-before-run=false test`（**跑的还是 package.json 里那条命令**
    `node --test --test-concurrency=1` ✓），**故意不 purge** ✓（第一次不知情时它自己 abort 了，
    **没有删任何东西** —— 已核 `node_modules/.pnpm` 仍在 ✓）。
- **变异 4 组**（改完**逐字节还原**，`routes/scanPage.js` 的 sha256 回到改前那个值 ✓）：

| 变异 | 内容 | 真红 |
|---|---|---|
| **M1** | **把清除去掉**（整段 reset 分支永不命中） | 🔴 **6 条**：AC-LR1 / LR1b / LR1c / LR1d / LR2a / LR2b |
| **M2** | **清过头**（连她的草稿行 `lines` 一起清） | 🔴 **2 条**：AC-LR1 / LR2a |
| **M3** | 删掉**货品页**那个出口的 `logRendered` | 🔴 **6 条**：AC-RL1 / AC-LR4 / AC-RL5 / AC-RL6 / AC-RL7 / AC-RL8 |
| **M4** | 把 `query_keys` 从载荷里删掉 | 🔴 **3 条**：AC-RL1 / AC-LR4 / AC-RL8 |

- **受影响类目扫一遍**（`scan|payment|sale|money|voucher|skip|jump|workbench` 共 1121 条）：
  `pass 1114 / fail 0 / skipped 7` · **EXIT=0** ✓

---

## 8. 未做项 / 已知边界（如实）

- 🔴 **没有部署**（她 2026-10-07 定的纪律：任何时刻都要她当次明说才能部署）·
  **没有合并 PR**（等 Lead 处置）· 生产 Base **只读**（本刀一个字节都没写表）。
- ⚠️ **裸扫那一发照旧会落到资金页**（本刀**刻意**不动它 —— 那是"资金页刷新不丢"）。
  线上（骨架屏开）裸扫先回骨架 ⇒ 她**碰不到**这条路；但若哪天**关掉骨架屏**，
  "扫 A 货品 ⇒ 裸扫 ⇒ 上一单的资金页"会**再次出现**（`docs/scan-landing-diag-2026-10-16.md` §3.2 那张对照表）。
  要连这一条也治 ⇒ 得区分"扫码首屏"与"资金页刷新"（**同一形状**，只能在页面上留标记），**超出本刀授权** ✗。
- ⚠️ **`?from=sales` 上"跳过 / 提交整单付款"两颗按钮的续做路径**：她若在资金页按浏览器刷新，
  刷新的是**裸 URL** ⇒ 照旧资金页 ✓（不受本刀影响）；但若从别处再点「销售」⇒ 按 ② 从头开始
  （**这正是她选的** ✓）。
- ⚠️ 本刀**没碰**：`server/src/services/scanWriteService.js`（余量 0 冻结 ✓ 源码哨兵 AC-RL10 ③ 钉着）、
  `views/**`、`config/scanWrite.js`、`public/workbench/**`、`routes/workbench.js` ✓。
