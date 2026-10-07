# 赠品落点从「销售明细」搬到「销售主表」（2026-10-08）

> ⚠️ 本文件按 AGENTS.md 第 2 条「先写验收标准，再动手」写成；第 1 节的验收标准在**改代码之前**写定，
> 第 4 节是改动后的逐条对照与证据。

## 0. 口径（业务负责人逐字）

> 「好的，**写入的落点放在销售主表里的赠品**，**销售明细没有赠品了**」

## 1. 生产真表事实（业务负责人 2026-10-08 01:5x 只读核对，以她给的这份为准）

```
【销售主表 salesEntry】(tblLjFe3NjU61xKB) 18 列，其中 ⭐「赠品」[文本]（新增）：
  销售单号 · 交易类型[关联] · 原话 · 录单人 · 解析状态 · 确认状态 · 销售状态 · 资金状态 · 库存状态
  · 收款状态[公式] · 交付数量[公式] · 待交付数量[公式] · 录单日[创建时间] · ⭐赠品[文本] · 解析结果摘要
  · 失败原因 · 更新时间 · 消息链接
【销售明细 salesDetail】(tblxW5WMKDULyolA) 12 列，⭐「赠品」列已被删除：
  销售明细ID[公式] · 交易类型[关联] · 履约状态[单选] · 销售单号[关联] · 编号[关联] · 尺码[关联]
  · 成交金额[数字] · 销售单价[公式] · 销售日[创建时间] · 配品[关联] · 明细ID[自动编号] · 更新时间
```

⚠️ 本机看不到生产、也不许写任何表（含测试 Base）⇒ 本文件里「真表事实」一节是**转述她的只读核对**，
不是我自己核的；我核的是**代码里的读写点**（第 3 节）。

## 2. ⭐ 改完之后应该是什么样（验收标准，动手前写定）

落点：**一单一条** —— 赠品是**销售主表那一行的一列**；销售明细**没有**这一列，写库时也不许带它。

| # | 场景 | 期望（可执行判据） |
| --- | --- | --- |
| ① | 单件有赠品 | 销售主表「赠品」= 该件的赠品描述；**销售明细那一行不含「赠品」字段**（假 Base 的 create 会把未映射字段当场抛错，所以"带了"一定红） |
| ② | 多件各有赠品 | 销售主表「赠品」= 按**明细顺序**用 `、` 连起来、**去重**（与解析层同一套归一：先按 `、` 拆成单个赠品，再按出现顺序去重） |
| ③ | 没有赠品 | 销售主表「赠品」= 空串；`gift=true` 但**没有描述** ⇒ 沿用占位文案「有赠品」 |
| ④ | 幂等 / 回读比对 | 重放**不重复写、不重复建明细**；主表赠品串**相同**判一致（不再写）；赠品串**变了**要能被识别 ⇒ 报「与当前草稿不一致，已停止重试」 |
| ⑤ | schema 守门 | `V1_BITABLE_SCHEMA.tables.salesDetail.fields.gift === undefined`；`…salesEntry.fields.gift === '赠品'` |
| ⑥ | 哨兵（不许回退） | 既有金额 / 履约 / 库存用例全绿；全量 `node --test --test-concurrency=1` **连跑 2 次 fail=0** |

### 2.1 多件赠品怎么合并（逐字规则）

1. 每一件明细先算它自己的赠品文本：`gift_description` 有值就用它；`gift=true` 且没描述 → 占位「有赠品」；
   否则 = 空（不参与合并）。
2. 把每件的赠品文本**按 `、` 拆成单个赠品**（因为解析层在"单双鞋"时已经把多个赠品用 `、` 串成了一串）。
3. 按**明细顺序**拼接、**按字符串去重**（首次出现保留）。
4. 用 `、` 连成一个字符串写进**销售主表那一行**的「赠品」。
5. 一件都没有 ⇒ 主表写**空串**（与既有语义一致：不是"没有这一列"，是"这一列是空的"）。

> 合并规则的**字面量**（分隔符 `、` 与占位文案「有赠品」）进 `config/salesGift.js`（配置先行）。

### 2.2 明显不改的东西（边界）

- 🔴 解析层字段不动：`items[].gift` / `items[].gift_description`（`doubaoService` 一行不改）。
- 🔴 金额口径不动、履约 / 库存逻辑不动（哪一行明细要交付、扣不扣库存，与赠品无关）。
- 🔴 不碰采购侧、`pendingDealPush*`、`app.js`、到货卡片链、卡片自愈链。
- 🔴 不写任何表（含测试 Base）；不部署。

## 3. 动手前的只读核查（代码里的赠品读写点全清单）

| 位置 | 现状 | 处置 |
| --- | --- | --- |
| `config/v1BitableSchema.js` `salesDetail.fields.gift='赠品'` | 明细有映射，但真表已删该列 ⇒ 写库抛「未配置语义字段」 | **删** |
| `config/v1BitableSchema.js` `salesEntry` | 没有赠品映射 | **加** `gift: '赠品'` |
| `services/salesOrderService.js:125` | 逐条明细算 `gift` | 改为 `config/salesGift` 的归一；**仍逐件算**，但只用于合并 |
| `services/salesOrderService.js:194` | `create('salesDetail', { gift: … })` | **删**（那一列没了，带了会抛） |
| `services/salesOrderService.js:176` | 幂等比对读**明细的**「赠品」 | 改为**主表的**「赠品」串比对 |
| `services/salesOrderService.js` 主表写入 | 只更新 `failureReason` / 四个状态维度 | **加**主表「赠品」的写入（一单一条） |
| `services/v1WorkbenchService.js:193` | 工作台销售列读**明细的**「赠品」 | ⚠️ 映射删掉后会**静默变空** ⇒ 改读**主表那一行**的「赠品」（记录已经读到，零额外请求） |
| `services/doubaoService.js` | `items[].gift` / `gift_description` | **不动** |
| `utils/larkCards.js:74` | 卡片文案 `item.gift_description \|\| '有'` | **不动**（那是卡片话术，不是落库占位） |
| `test/v1BitableGateway.test.js` 真表快照 | 快照里 `salesDetail` 有「赠品」、`salesEntry` 没有 | 同步（这正是 schema 守门） |

## 4. 逐条对照（实现后填）

### 4.1 关键 diff

**① schema（`config/v1BitableSchema.js`）—— 删明细、加主表**

```diff
       salesEntry: {
         …
         messageLink: '消息链接',
+        // ⭐ 2026-10-08：赠品的落点从「销售明细」搬到「销售主表」…
+        gift: '赠品',
       },
     },
     salesDetail: {
       fields: {
         …
         size: '尺码',
-        gift: '赠品',
+        // 🔴 「赠品」映射已删除（2026-10-08）：她在生产表把这一列整列删掉…
         soldAt: '销售日',
```

**② 写入位置（`services/salesOrderService.js`）—— 逐件算、整单合并、写主表；明细不带**

```diff
-          gift: item.gift ? String(item.giftDescription || '有赠品').trim() : '',
+          // 一件明细自己的赠品文本（有描述用描述；gift=true 没描述用占位；否则空）。
+          // ⚠️ 它不再写进明细，只在下面合并成主表那一列。
+          gift: giftTextOfItem(item),
```

```diff
-            gift: row.item.gift,
+            // 🔴 明细不带赠品（那一列已被她整列删除；带了会抛「未配置语义字段」）。
```

```diff
+      // ⭐ 赠品：一单一条，落在销售主表那一行。
+      const orderGift = mergeGiftTexts(expected.map((item) => item.gift));
+      const existingGift = textValue(entry?.fields?.[entryFields.gift]).trim();
+      if (existingGift && existingGift !== orderGift) {
+        throw new Error('销售主表已记录的赠品与当前草稿不一致，已停止重试');
+      }
+      await this.gateway.update('salesEntry', salesEntryRecordId, { gift: orderGift }, { correlation });
```

**③ 幂等 / 回读比对 —— 从「明细的赠品列」改成「主表的赠品串」**

```diff
           (item.sizeRecordId
             ? singleLinked(record.fields?.[table.size], item.sizeRecordId)
             : linkedRecordIds(record.fields?.[table.size]).length === 0) &&
-          Number(textValue(record.fields?.[table.actualAmount])) === item.actualAmount &&
-          textValue(record.fields?.[table.gift]) === item.gift);
+          Number(textValue(record.fields?.[table.actualAmount])) === item.actualAmount);
+        // ⚠️ 明细这一侧不再比赠品；赠品是整单一条、比在销售主表上。
```

**④ 配置先行（新增 `config/salesGift.js`）**

| 配置项 | 值 | 用途 |
| --- | --- | --- |
| `SALES_GIFT.separator` | `、` | 多个赠品的连接符（与解析层"单双鞋"归一同一个符号） |
| `SALES_GIFT.placeholder` | `有赠品` | `gift=true` 但没描述时的占位（原写死在 `salesOrderService`） |
| `giftTextOfItem(item)` | — | 一件明细的赠品文本（描述 → 占位 → 空） |
| `mergeGiftTexts(texts)` | — | 整单合并：按明细顺序 → 拆单个赠品 → 去重 → `、` 连起来 |

**⑤ 读侧补刀（`services/v1WorkbenchService.js`）—— 不在任务书清单里，但不改就静默变空**

```diff
-          gift: asText(schema, 'salesDetail', record, 'gift'),
+          // 赠品搬到主表 ⇒ 改读这张明细所属的那一单（order 已读到，零额外请求）。
+          gift: asText(schema, 'salesEntry', order, 'gift'),
```

⚠️ **语义代价（需她知情）**：赠品是**整单一条**，所以工作台里**同一单的多行明细会显示同一个赠品串**
（旧行为是每行只显示自己那一件的赠品）。工作台列表是**按明细行**展开的，颗粒度对不上是
"落点搬到主表"这件事本身带来的，不是实现取舍。

### 4.2 多件赠品怎么合并（逐字规则，实现在 `config/salesGift.mergeGiftTexts`）

1. 逐件算赠品文本：`gift_description` 有值 → 用它；`gift=true` 没描述 → 「有赠品」；否则 → 空。
2. 每件的文本**按 `、` 拆成单个赠品**（解析层"单双鞋"已经把多个赠品用 `、` 串成一串）。
3. 按**明细顺序**拼接、按**单个赠品字符串**去重（首次出现保留）。
4. 用 `、` 连成一个字符串，写进**销售主表那一行**的「赠品」。
5. 一件都没有 → 写**空串**。

例：明细1 = 「鞋垫一双、袜子一双」，明细2 = 「袜子一双」 ⇒ 主表 = **「鞋垫一双、袜子一双」**（袜子只留一次）。

### 4.3 先红后绿

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| **改动前（新用例）** | `node --test --test-concurrency=1 test/salesGiftOnEntry.test.js` | **9 红 / 1 绿**（唯一绿的是哨兵⑥；①～⑤ 全红：schema 断言红、主表没有赠品、明细还带着赠品） |
| 改动前（工作台守卫） | 把 `v1WorkbenchService` 那一行临时改回 `salesDetail` | **1 红**：`actual: ['', '']` vs `expected: ['鞋垫一双、袜子一双', …]`（正是"静默变空"那个失败方式） |
| **改动后** | `node --test --test-concurrency=1 test/salesGiftOnEntry.test.js test/v1BitableGateway.test.js test/salesMvp.test.js` | **全绿** |
| 改动后（工作台守卫） | 同上 | **全绿** |

### 4.4 验收标准逐条对照

| # | 期望 | 结果 | 证据（用例） |
| --- | --- | --- | --- |
| ① | 单件 → 主表 = 描述；明细不带 | ✅ | `① 单件有赠品：写进销售主表，明细行不带「赠品」`；既有 `mixed payment…` 同步断言 |
| ② | 多件 → 主表按明细顺序 `、` 连接去重 | ✅ | `② 多件各有赠品…`＋`② 合并去重是"逐个赠品"级…` |
| ③ | 无赠品 → 主表空；`gift=true` 无描述 → 「有赠品」 | ✅ | `③ 没有赠品…`＋`③ gift=true 但没描述…` |
| ④ | 重放不重复写；串相同判一致、变了要能被识别 | ✅ | `④ 幂等：重放…`＋`④ …与草稿不同 ⇒ 判不一致`＋`④ …去掉（变空）也要能被识别` |
| ⑤ | 明细不再有 `gift` 映射；主表有 | ✅ | `⑤ schema 守门…`＋`v1BitableGateway.test.js` 的 `sales schema matches the live three-table field snapshot`（快照同步＋两条显式断言） |
| ⑥ | 哨兵：金额 / 履约 / 库存不回退；全量 2 次 fail=0 | ✅ | `⑥ 哨兵…`＋全量见第 5 节 |
| 补 | 工作台赠品列不静默变空 | ✅ | `v1WorkbenchService.test.js` 的 `赠品列读的是销售主表那一行…` |

### 4.5 边界核对（"不许改"的那些，逐条核过没动）

| 不许动 | 核对结果 |
| --- | --- |
| 解析层 `items[].gift / gift_description` | `doubaoService.js` **零改动**（`git diff` 无此文件）；`items[].gift` 仍是入参 |
| 金额口径 | 零改动（用例断言成交金额 `[100, 130]` 不变） |
| 履约 / 库存逻辑 | 零改动（哨兵断言 `履约状态` 与"零库存动作"不变） |
| 采购侧 / `pendingDealPush*` / `app.js` / 到货卡片链 / 卡片自愈链 | 零改动（`git diff --name-only` 里没有任何这些文件） |
| 卡片话术 | `utils/larkCards.js` 零改动（那里的「赠品：…」是卡片文案，不是落库口径） |

## 5. 全量测试与 CI

_（全量 2 次结果、CI 三项见 PR。）_

## 6. ⚠️ 不确定 / 需她拍板

1. **工作台那一列**（4.1 ⑤）：本任务书没列它，但不改就是"明细列已删 ⇒ 工作台赠品列无声变空"（已实测红）。
   我按"读主表那一行"补上了；代价是**同一单多行显示同一串**。若她要的是"工作台不显示赠品"或别的口径，
   一行即可改。
2. **本机看不到生产、也不许写任何表** ⇒ 5️⃣ schema 守门只在本仓库的**真表快照用例**上验过，
   `v1:schema-check:sales` 对着**测试 Base** 大概率会红（测试 Base 仍带着明细的「赠品」、主表可能还没有新的
   「赠品」列）—— 那是"测试 Base 落后于生产"，不是代码错。**部署前必须在服务器上跑 `v1:schema-check:all`**。
3. **`gift=true` 无描述** 沿用「有赠品」是任务书明确的口径；卡片文案里的占位是「有」（`larkCards`），
   两者**有意不一致**（一个落库、一个给人看），本次不动。

