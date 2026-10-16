# 退货「出图发群」接线（修一个线上真缺陷）· 2026-10-16

> 一句话：**采购退货那条链的出图链路一直没人装配** ⇒ 线上每一次退货都是「**账走了、图一张没发**」。
> 本卡在**装配处**把 `purchaseReturnOptions`（含出图/发群所需的 `webhooks`）接上 —— 与补货 / 验收
> **同一条路**（同一个 `PurchaseWebhookService.deliverSupplierImages` ✓ 不发明新写法 ✗）。
>
> 依据（业务负责人当天拍板）：2026-10-16 明确「**修**」。

---

## 1. 线上铁证（照抄，别重新排查 ✗）

她 **2026-10-16 20:12:04**（上海时间）那一次**真退货**的线上日志：

```json
{"level":"warn","event":"scan.purchase_return.image_failed","task_id":"scan_return_…",
 "batch_no":"CGD-20261016-0001","reason":"no_image_pipeline",
 "note":"没有接出图链路（用例 / 未接线）"}
```

而同一笔在 **20:11:30** 有 `purchase.return.batch.record_ensured` ⇒ **账走了**（批次行 + 明细 + 扣库存），
但**图一张都没发** ✗。

⚠️ 如实标：**单货品退货上也一样**（**老缺口**，不是 2026-10-16「一单多货」那一刀引入的）。

---

## 2. 装配链（只读核查结论，写在这里免得下一个人再核一遍）

| 环节 | 事实 |
| --- | --- |
| 谁调 `createScanWriteService` | **生产只有 3 处**：`routes/scanPage/index.js:277-279`（**扫码页**，`app.js:130` 用 `createScanPageRouter()` **不传参**挂载 ⇒ 这就是线上那条路）· `routes/workbench.js:581`（销售重试）· `routes/larkEvents.js:243`（配品成单）。三处都只传 `{ gateway, config }` |
| 唯一读 `purchaseReturnOptions` 的地方 | `services/scanWriteService.js:239` 的 `...(options.purchaseReturnOptions || {})`（**全仓只有这一处**） |
| 读到之后落到哪 | `services/purchaseReturnService.js:142` 的 `const webhooks = options.webhooks \|\| null;`；`:478` 有它 ⇒ 调 `deliverSupplierImages`；`:489` 没有 ⇒ 记 `reason: 'no_image_pipeline'` |
| ⇒ 根因 | **装配处没人传** `purchaseReturnOptions` ⇒ `webhooks` 恒为空 ⇒ 退货出图**必然** `no_image_pipeline` ✗ |
| 「已经能发图」的两条路怎么接的 | ① **补货**：`services/scanWriteService.js` 的 `purchase()` **自己** `new PurchaseWebhookService({ gateway, store, references })`；② **验收**：`services/scanArrivalService.js` 的 `arrivalConversationOf()` **自己** `new PurchaseWebhookService({ gateway })` ⇒ 都是"**需要出图的那条链拿到 webhook 实例**"，然后调**同一个** `deliverSupplierImages`（按供应商分组在它内部，用 `services/supplierSplitService.js` 那一处唯一的口径 —— task-761 已合）|
| 退货这一条缺的是什么 | 它**不自己造**（只认注入）⇒ 缺的**只有装配那一处** |

---

## 3. 改前逐字 → 改后逐字 → 依据

**改前逐字**（`server/src/routes/scanPage/index.js`）：

```js
  const writeService = writeConfig && options.writeService !== false
    ? (options.writeService || createScanWriteService({ gateway, config: writeConfig }))
    : null;
```

**改后逐字**：

```js
  const writeService = writeConfig && options.writeService !== false
    ? (options.writeService || createScanWriteService({
      gateway,
      config: writeConfig,
      purchaseReturnOptions: resolvePurchaseReturnImageOptions({
        gateway,
        config: writeConfig.purchaseReturn && writeConfig.purchaseReturn.imageDelivery,
        overrides: options.purchaseReturnImage || {},
      }),
    }))
    : null;
```

（＋ 顶部一行 `require('../../services/purchaseReturnImageWiring')`。）

**依据** = 业务负责人 2026-10-16「**修**」（本卡）＋ 她 2026-10-05「**一定要配置先行**」。

### 三个文件的角色

| 文件 | 改了什么 | 为什么 |
| --- | --- | --- |
| `server/src/services/purchaseReturnImageWiring.js`（**新**） | `resolvePurchaseReturnImageOptions({ gateway, config, overrides })` ⇒ `{ webhooks }`（**惰性 getter**） | 真名（`PurchaseWebhookService`）只住在这里一次 —— `routes/**` 有一条**既有哨兵**（`test/multiItemOrderRoute.test.js` 的 RT5 ＋ `test/scanDraftRouteWiring.test.js` 的 AC-D3i2）：路由的**代码行**里不许出现 `purchaseWebhookService` / `purchaseReturnService` / `PurchaseWebhookService` ✗ |
| `server/src/routes/scanPage/index.js` | **1 行 require ＋ 1 处传参** | 装配处把 `purchaseReturnOptions` 接上（**只有这两行** ✓ 别的服务名一个都没带进来 ✓） |
| `server/src/config/scanWrite.js` | `PURCHASE_RETURN` 加 `imageDelivery.enabled` | 配置先行（**显式布尔**） |

⚠️ **惰性**是必须的：`new PurchaseWebhookService(…)` 的构造函数会 `getLarkAgentCredentials()`，
缺 `LARK_AGENT_APP_ID/SECRET` 时**当场抛错** ⇒ 若在建 router 时就构造，几十个只读页面的用例会整片崩 ✗。
`get webhooks()` 只在**真读它**时构造 —— 而那个读发生在 `scanWriteService` 的
`...(options.purchaseReturnOptions || {})`（它**惰性建退货服务那一刻**，也就是**她真提交一次退货**时）✓。

---

## 4. 配置先行（零硬编码 ✓）

| 键 | 在哪 | 语义 |
| --- | --- | --- |
| `SCAN_WRITE_PURCHASE_RETURN_IMAGE_ENABLED`（缺省 `true`） | `config/scanWrite.js` 的 `PURCHASE_RETURN.imageDelivery.enabled` | **装配处接不接出图链路**的唯一判据。**显式布尔**（`readFlag`）：**设成空串 = 关**（不是"没配 ⇒ 回退默认"）|
| `PURCHASE_CHAT_ID`（**本来就有**） | `config/groupPurchase.js`（`resolvePurchaseChatId`） | 发到**哪个群**——退货单与采购申请单**同一个群**（`deliverSupplierImages` 自己的口径 ✓）；没配时它自己**大声跳过**（`purchase.request.image.skipped` ＋ 人话 hint ✓ 绝不落回私聊）|
| `SCAN_RETURN_IMAGE_TITLE` / `SCAN_RETURN_FILE_SUFFIX`（**本来就有**） | `config/scanWrite.js` 的 `PURCHASE_RETURN` | 图上的标题 / 文件名后缀（由 `purchaseReturnService` 传给 `deliverSupplierImages` ✓）|

⇒ **代码里零硬编码**：群 id 没写、标题没写、开关没写。`.env.example` 里也补了这一个键的说明。

---

## 5. 验收标准（**先写后做**；判据在 `server/test/purchaseReturnImageWiring.test.js`）

| # | 判据 | 怎么证 |
| --- | --- | --- |
| **AC-RI1** ⭐ 线上同路径 | 扫码页退货 POST（**真路由 → 真引擎 → 真写入件 → 真 `deliverSupplierImages`**；只假**出图 / IM / 网关**）⇒ 装配之后 `webhooks` 非空 ⇒ **不再出现 `no_image_pipeline`** | ①装配件直接断言给的是**真** `PurchaseWebhookService` 且 `deliverSupplierImages` 是函数；②`GET` 页面拿服务端给出的 `submit_key` ⇒ `POST` ⇒ 等后台那一跑 ⇒ 断言 `purchase.request.image.group_sent` 真的出现过、且 `no_image_pipeline` **一次都没有**；③探针：配置关着 ⇒ 装配件**一个键都不给** |
| **AC-RI2** 单货品 | 1 件 ⇒ **1 张图** ＋「单据」1 张 ＋ 群消息 **2 条** | 逐字数 `renders=1` / `documentNamesOf=[甲供应商-采购退货单.png]` / `messages=2` / 主表 1 行 / 明细 1 行 |
| **AC-RI3a** 多货品 / 多供应商 | 2 家 ⇒ **按供应商分 2 组 · 2 张图** | 真路由 POST 带 `multi_items`（2 个货品）⇒ `renders=2`、每组只含该供应商的行、单据 2 张、群消息 4 条、主表仍**1 行**（她选的 ⓐ 同一批次号下分组）|
| **AC-RI3b** 幂等 | 重放同一份提交 ⇒ **图 +0 · 群 +0 · 附件 +0** | 用**装配件给的那一份**真出图链路（不是用例自己拼的 `webhooks` ⇒ 这才测到接线 ✓）提交两次同一个 task ⇒ 四个计数一个都不涨，且主表不多行 |
| **AC-RI4** 🔴 反向哨兵 | 装配那几行**不接** ⇒ `no_image_pipeline` **出现** | 关掉出图开关跑同一条真链路：账照走（主表 1 行）、**图 0 张 · 群 0 条**，并如实记 `returnImageFailed` ＋ `reason: no_image_pipeline` ⇒ 证明 AC-RI1/RI2 里那条"不许出现"的断言**真能红**（不是空跑 ✓）|
| **AC-RI5** 🔴 冻结件 | `services/scanWriteService.js` **逐字节没动** | sha256 与 main 一致（**合进 main 后 = `49772bda…2c12`**；原写的 `199551e1…35ca` 是**分支**上的值 —— **#763 已获授权解冻该文件**，成对迁移成前者 ✓）＋ 探针（多一个字节 ⇒ 指纹必变）|
| **AC-RI6** 🔴 源码哨兵 | 装配处真的接上了 ＋ 路由**代码行**里没有写链路服务名 | `scanPageSource()` 里出现 `purchaseReturnOptions: resolvePurchaseReturnImageOptions({`；剥掉整行注释后，三个服务名一个都不出现（RT5 / AC-D3i2 的既有口径**不放宽** ✓）|

**既有判据一条都没删 / skip / 放宽** ✓（退货链那 8 个既有用例文件 + 4 个哨兵文件全绿，见下）。

---

## 6. 两遍全量 + 变异（自证）

| | 命令 | 结果 |
| --- | --- | --- |
| 第 1 遍 | `PATH=/usr/local/bin:$PATH CI=true pnpm test`（系统 node `/usr/local/bin/node` = `v24.14.1`） | 分支 `4314a22`：**tests 2957 · pass 2950 · fail 0 · skipped 7 · EXIT=0** |
| 第 2 遍 | 同上 | **tests 2957 · pass 2950 · fail 0 · skipped 7 · EXIT=0**（与第 1 遍逐字相同）|
| 两遍之间 | `git diff \| shasum -a 256` | 两次**逐字节一致**（空 diff：所有改动都已提交 ✓）|
| 合进 main 后 | 同上（`6ad32ea`） | **tests 2989 · pass 2982 · fail 0 · skipped 7 · EXIT=0** |
| 本次刷新（**纯 docs**） | 同上（`ef2b4a6` ＋ 本文件改动） | **tests 2998 · pass 2991 · fail 0 · skipped 7 · EXIT=0 ×2**（两遍之间 `git diff \| shasum -a 256` = `e3b0c442…` = 空 diff ✓）|

⭐ 上表五个数字都在 **2026-10-16 收尾时【独立复跑】核过** ✓（三棵树各起一个独立 worktree ＋
各自 `CI=true pnpm install --frozen-lockfile`；**EXIT 都没接管道**，取的是 `pnpm test` 自己的退出码）。
⚠️ 合进 main 后总数比分支大，是因为同一时段还有别的 PR 合进来 —— **fail 0 / skipped 7 与基线一致** ✓。

**变异（2 组，每组都在**独立 worktree** 上单独跑过、确认真红 ✓；跑完 `git checkout --` 还原，
`shasum -a 256 -c` 逐字节一致 ✓）**：

| # | 变异 | 真红的是谁（实测） | 说明 |
| --- | --- | --- | --- |
| 1 | 删掉 `routes/scanPage/index.js` 那两处装配（`purchaseReturnOptions:` 那一段） | **AC-RI1 / RI2 / RI3a / RI6** 红（`renders=0`：出图那一步一次都没被调）＋ AC-RI4 **绿**（它本来就是"不接的时候该看到什么"） | 证明"装配那几行"是这批判据的**唯一支点** ✓ |
| 2 | 把 `config/scanWrite.js` 的 `imageDelivery.enabled` 缺省改成 `false` | **AC-RI1 / RI2 / RI3a / RI3b** 红 ＋ AC-RI4 **绿** | 证明**配置开关**真的在把关（不是写死的常量）✓ |

**还原核验**：两组都跑 `git checkout -- <改过的那个文件>` ⇒ `shasum -a 256 -c` 与变异前
**逐字节一致** ✓（`server/src/routes/scanPage/index.js` / `server/src/config/scanWrite.js` 各一次）。

---

## 7. 边界（**没做**的事，如实标 ✓）

- 🔴 **不碰 `services/scanWriteService.js`**（余量 0 的冻结件）：本卡**只在装配处传参**，sha256 与 main 一致 ✓（AC-RI5）。
- 🔴 **不碰** `views/scanPage/**` · `config/scanPage.js` · `services/scanPageService.js`（别人在跑「库存四页口径」）。
- 🔴 **`routes/**` 只动了那两行**（装配处）：`routes/scanPage/index.js` 的 require ＋ 传参；
  既有 RT5 / AC-D3i2 哨兵两条都**没放宽**（AC-RI6 钉着）。
- ⚠️ **另外两个装配处**（`routes/workbench.js:581` 销售重试 / `routes/larkEvents.js:243` 配品成单）
  **没有跟着接**：它们今天**都不提交采购退货** ⇒ 接了是无人读的配置 ✗（扩大改动面 ✗）。
  哪天它们也要跑退货 ⇒ 在同一处加**同一行** `resolvePurchaseReturnImageOptions(...)` 即可。
- ⚠️ **没有动线上 `.env`**、**没有部署**、**没有飞书 CLI**、**没有写任何真表**
  （全部用例都是内存假网关 ＋ 假出图 / 假 IM ✓ 零真表调用）。
- ⚠️ 如实标：**多货品退货"一双都退不成"时引擎仍给她成功页**（`skipped: 'no_stock'`）——
  这是 task-64 留下的**另一条**已知缺口，本卡**没动**（要动共用引擎 `multiItemOrderService`，
  与补货那条链一起判 ⇒ 超出本卡写作用域）。
