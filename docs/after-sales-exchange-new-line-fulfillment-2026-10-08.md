# 换货：新换出去的那条明细要写「履约状态 = 已交付」（2026-10-08）

分支 `fix/exchange-new-line-fulfillment`（独立 worktree `.local/wt-exchange-fulfillment`）。
🔴 本件**不部署**、**不合并**、**不写任何表**（只读核查）。

## 一、真机事实（业务负责人只读核过，2026-10-08 00:02）

原销售单 `XSD-20261007-0054`（record `reczz28KXdaDKu5h`）的三条明细：

| 明细 | 货号 \| 颜色 \| 类别 | 尺码 | 履约状态 | 交易类型 |
| --- | --- | --- | --- | --- |
| 0054-1 | 26632 \| 黑色 \| B | 39 | 已交付 ✅ | 现货 ✅ |
| 0054-2 | 6C98012-15L \| 黑 \| B | 40 | **已换货** ✅（原那双，正确） | 现货 ✅ |
| 0054-3 | 6C98012-15L \| 黑 \| B | **41** | **(空)** ❌（record `reczz28KZzAY4BBi`，这次换货新写入的那条） | **换货** ✅ |

业务负责人口径（逐字）：

> 问：「新增的这笔换货的履约状态是否有值？」
> 答（她确认）：「好的，是的就叫**已交付**～」

## 二、⭐ 验收标准（动手之前先写死；改完逐条对照）

| # | 验收标准 | 判据（怎么核） |
| --- | --- | --- |
| A1 | 换货执行器**新建的那条明细**（新换出去的那双）落库时「履约状态」= **已交付** | 执行器写「销售明细」的 `create` 里必须带 `fulfillmentStatus`（语义名），值取自 `config/afterSales.js`，不是执行器里的中文字面量 |
| A2 | 值走**配置/枚举**，不写死中文 | `AFTER_SALES_FULFILLMENT.DELIVERED = '已交付'`，由换货动作的 spec 声明（`newLineFulfillmentStatus`），执行器只读 spec |
| A3 | 原那双仍写「**已换货**」（既有正确行为一字不改） | 原明细 `履约状态` = `AFTER_SALES_FULFILLMENT.EXCHANGED` |
| A4 | 退货 / 赔货的**新建明细行**既有行为不变（哨兵：其「履约状态」仍**不写**，不是被改成已交付） | 退货的复制行、赔货的出货行 `履约状态 === undefined` |
| A5 | 赔货 / 退货的**原明细**状态不变（哨兵） | 原明细 = `已赔货` / `已退货` |
| A6 | 只补履约状态这一处，**别的字段一个不动** | 新明细的 `销售单号`=原主表、`交易类型`=换货行为、`成交金额`=出货金额、`尺码`=新尺码；原主表逐字段未变（含「销售状态」） |
| A7 | 重放 / 重试**不重复写** | ① 整次重放（总闸门命中）→ 一个字节都不写，结果对象与第一次 `deepEqual`；② 中途失败后重试 → `create.salesDetail === 1`（不建第二行），新明细行的「履约状态」仍是已交付且不被二次写 |
| A8 | 新鞋出库 / 旧鞋回库的**既有实现不动** | 换货仍是两条流水（`SALE_RETURN` 增加 + `SALE_CASH` 减少）、实时库存 +1 / −1 |

## 三、⭐ 只读核查：换货的库存两腿现在到底做了没有

**结论：已经做了（旧鞋回库 + 新鞋出库都在），本件只补状态，不动库存。**

证据（全部只读、走项目源码）：

1. `config/afterSales.js` 的 `AFTER_SALES_ACTION_SPECS.exchange.movements` 声明**两条**：
   `{ source: 'returned', behaviorCode: 'SALE_RETURN', state: 'restockState' }`
   ＋ `{ source: 'new', behaviorCode: 'SALE_CASH', state: '门盒' }`。
2. `services/afterSalesService.js` 的 `applyStock` 按 `movements × 计划行` 调
   `InventoryService.applyChange(...)`；`new` 行的 `sourceRecordId` 就是**这条新明细行**。
3. `services/inventoryService.js` 的 `STOCK_MOVEMENTS.SALE_CASH` 已注册
   `{ direction: '减少', consumes: ['门盒'] }`，出库成功时打
   **`inventory.change.applied`**（`inventoryService.js:974`）。
4. 既有测试已钉住这一腿：`test/inventoryMvp.test.js:468`
   「售后动作在真 InventoryService 里生效：退货加一行、现货出库从门盒减一行」；
   `test/afterSalesService.test.js:586` 换货用例断言两条流水方向相反、
   实时库存「2 + 1 − 1」。

5. ⭐ **既有真链路 e2e 证据（走项目代码、测试 Base）**：`docs/e2e-group-thread-2026-10-07.md`
   第 ③ 例「换货（新鞋出库 SALE_CASH + 旧鞋入库）」**9/9 通过** ——
   新鞋出库 = 库存流水行为 `现货销售`（`SALE_CASH`）/ 变动 `1`；旧鞋入库 = `销售退货` / 变动 `1`；
   实时库存「旧鞋 +1、新鞋 −1，净 0」；同一份文档 2.8 明确把 **`inventory.change.applied`**
   列为"自证日志事件"。
   ⚠️ 该 e2e 的判据表里**没有**"新换出去那条明细的履约状态"这一条 —— 与这次发现的空缺一致。

⇒ 按任务书第 4 条：**新鞋出库已经做了 → 本件只补状态**（不新增任何库存写入）。
⚠️ 口径（AGENTS.md 第 17 条）：上面四条证据都是**代码 / 测试 / 既有 e2e 留档**层面的；
我**没有**去线上 PM2 日志里核这一笔（本机不配生产凭证、也不该为此上服务器）——
"生产上换货那一刻 `inventory.change.applied` 打没打"这一句仍以她/线上为准。

## 四、改动清单（只碰这两个文件 + 测试 + 本文档）

| 文件 | 改什么 |
| --- | --- |
| `server/src/config/afterSales.js` | ① `AFTER_SALES_FULFILLMENT` 加 `DELIVERED: '已交付'`；② **仅**换货 spec 加 `newLineFulfillmentStatus: AFTER_SALES_FULFILLMENT.DELIVERED`；③ 注释写清"为什么只有换货有这一条腿" |
| `server/src/services/afterSalesService.js` | `buildPlan` 给 `new` 计划行带上 `fulfillmentStatus`（取自 spec，缺省空）；`ensureDetailRows` 在建行时**同一次 `create`** 里带上 `fulfillmentStatus`（不额外发 update ⇒ 重放不会多写） |
| `server/test/afterSalesService.test.js` | 补验收标准 A1/A4/A5/A7 的用例（先红后绿） |

**不碰**：采购侧任何文件、`pendingDealPush*`、`app.js`、销售录单判据、颜色候选、
`config/salesMovements.js`（销售侧的类型→交付注册表；售后行为编码刻意不在里面）、库存服务。

## 五、先红后绿

见下面「实施记录」。

## 六、实施记录

### 6.1 先红（改动前，只跑目标文件）

```
$ cd server && node --test --test-concurrency=1 test/afterSalesService.test.js
ℹ tests 30   ℹ pass 27   ℹ fail 3
✖ 换货：新换出去的那条明细「履约状态」= 已交付（原那双仍是已换货）
    AssertionError: undefined !== '已交付'      (test/afterSalesService.test.js:705)
✖ 配置先行：只有换货声明「新明细行的履约状态」，退货/赔货不声明
    AssertionError: undefined !== '已交付'      (test/afterSalesService.test.js:737)
✖ 换货重放/重试：明细行只建一次，履约状态不被二次写
    AssertionError: undefined !== '已交付'      (test/afterSalesService.test.js:758)
```

哨兵用例（退货复制行 / 赔货出货行「履约状态」仍不写）在改动前后**都是绿的** —— 它钉的正是"不许顺手改别的"。

### 6.2 后绿

```
$ cd server && node --test --test-concurrency=1 test/afterSalesService.test.js
ℹ tests 30   ℹ pass 30   ℹ fail 0
```

### 6.3 全量（worktree 内，`node --test --test-concurrency=1`，连跑 2 次）

**过程中先撞上一条与本改动无关的 pre-existing 失败，已由兄弟 PR 修掉（见下）——最终两次全绿：**

```
HEAD=1568e7a  behind_origin_main=0
===== RUN 1（rebase 到修复后的 main 之后）=====
ℹ tests 1308   pass 1308   fail 0
===== RUN 2 =====
ℹ tests 1308   pass 1308   fail 0
```

#### （历史）rebase 之前的 2 条失败 = 跨午夜的"日期炸弹"，**不是本次引入**

```
RUN1_EXIT=1   ℹ tests 1308   pass 1306   fail 2
RUN2_EXIT=1   ℹ tests 1308   pass 1306   fail 2
```

失败的 2 条是 `test/purchaseBatchNoGeneration.test.js` 的 ②「同天第 2 包 → 0002」与
⑥「并发不重号」：它们把"今天"写死成 `CGD-20261007-*`，而生成器用真实时钟取今天 ——
上海时间 2026-10-08 00:00 过午夜后"今天"变成 10-08，断言必挂。

**证据（证明不是本次引入）**：在**未改动的 `origin/main`（b75139a）独立 worktree** 上单跑该文件：
`tests 16 / pass 14 / fail 2`，同样是这 2 条；CI 上也是同样 2 条
（`# tests 1308 / # pass 1306 / # fail 2`）。

⚠️ 影响面：最后一次绿 CI 是 `2026-10-07T15:52:08Z`（上海 23:52，午夜之前）；
之后**任何** PR 的 `server tests` 都会红在这 2 条上。
🔴 采购侧文件按任务书属于"不碰"，**本分支一个字没动**（已核对 `git diff origin/main` 里不含该文件）。

✅ **上游已修**：lead 的 **PR #254**「修跨午夜的定时炸弹测试（解阻塞）」把固定时钟注入这两条用例，
已合入 main（`748431c` / merge `1e2687f`）；本分支 rebase 到它之后 → 全绿、CI CLEAN。
（我另外在隔离 worktree 里**临时验证过**同一套修法 16/16，随后把该采购侧文件逐字还原、未提交。）

### 6.6 CI 三项（PR #252，rebase 后）

```
$ gh pr checks 252
test                          pass   1m0s
Analyze (javascript-typescript) pass  48s
CodeQL                        pass   3s
$ gh pr view 252 --json mergeStateStatus,mergeable
{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE"}
```

（rebase 之前是 `test fail` —— 失败的就是上面那 2 条日期用例；本 PR 的售后用例在 CI 里**全过**。）

### 6.4 关键 diff（改在哪一行）

| 位置 | 内容 |
| --- | --- |
| `server/src/config/afterSales.js` `AFTER_SALES_FULFILLMENT` | `+ DELIVERED: '已交付'`（枚举，值只此一处） |
| `server/src/config/afterSales.js` EXCHANGE spec | `+ newLineFulfillmentStatus: AFTER_SALES_FULFILLMENT.DELIVERED`（**只有换货**声明） |
| `server/src/services/afterSalesService.js` `buildPlan`（new 行） | `+ fulfillmentStatus: request.spec?.newLineFulfillmentStatus \|\| ''` |
| `server/src/services/afterSalesService.js` `ensureDetailRows`（create） | `+ ...(row.fulfillmentStatus ? { fulfillmentStatus: row.fulfillmentStatus } : {})` |

### 6.5 ⭐ 逐条对照验收标准

| # | 标准 | 结果 | 判据 |
| --- | --- | --- | --- |
| A1 | 换货新明细「履约状态」= 已交付 | ✅ | 用例「换货：新换出去的那条明细…」断言 `details[0].fields['履约状态'] === '已交付'`；写在**同一次 create** 里 |
| A2 | 值走配置/枚举，不写死中文 | ✅ | 执行器只读 `request.spec.newLineFulfillmentStatus`；中文字面量只出现在 `config/afterSales.js`；用例「配置先行」钉住 |
| A3 | 原那双仍「已换货」 | ✅ | 同上用例断言原明细 = `EXCHANGED` |
| A4 | 退货/赔货的新建行「履约状态」不变（哨兵） | ✅ | 用例「哨兵：…」断言两者 `undefined` |
| A5 | 退货/赔货的原明细状态不变 | ✅ | 哨兵用例断言 = `已退货` / `已赔货` |
| A6 | 只补这一处，别的字段不动 | ✅ | 用例断言新行 交易类型=换货 / 销售单号=原主表 / 金额=出货金额 / 尺码=新尺码；`售后**不写**原单`两条用例仍绿 |
| A7 | 重放/重试不重复写 | ✅ | 用例「换货重放/重试」：整次重放 → `countsOf`/`snapshot` 全等；中途失败重试 → `create.salesDetail === 1`、整行逐字段不变 |
| A8 | 库存两腿的既有实现不动 | ✅ | 换货既有用例仍绿（两条流水方向相反、实时库存 2+1−1）；本次**零**库存改动 |

## 七、⚠️ 不确定处 / 待她定

1. **已经写坏的那条生产记录 `reczz28KZzAY4BBi` 不会因此被自动修好**：它的本地售后任务是
   `completed`，总闸门会整次跳过（连飞书读都不做）。要修它得单独回填一次（写生产表）
   —— 本次**没做**，等她当次命令。
2. **赔货出货那行的履约状态**目前与退货的复制行一样是空的。本次按指示**一个字没动**；
   若她的口径是"赔出去的那双也算已交付"，那是**另一件**（要她点头）。
3. 断点续做的极窄窗口：如果某次换货在**本次改动上线之前**已经建好了明细行、
   但整笔还没跑完（本地记录没到 completed），重试会**复用**那一行 ——
   本次实现**不做回填**（只保证新建时写对）。要"续做时顺手补上"也是一件独立的小改动。
