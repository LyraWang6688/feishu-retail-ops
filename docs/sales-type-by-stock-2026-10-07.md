# 交易类型 = 库存有没有（现货 / 预定）· 类型与资金彻底解耦（2026-10-07）

> 本文件按《AGENTS.md》第 2 条：**先写"按我们的链路应该实现的效果"（= 验收标准），再动手**。
> 下面第 1 节是**动手之前**写的（时点 2026-10-07 19:40 上海时间），第 4 节起是事后回填。

## 0. 业务口径（业务负责人逐字，2026-10-07）

> 「【类型 = 只看库存】（行为表里就两条：现货 SALE_CASH / 预定 SALE_PREPAID）
>   库存里有这双 → 现货（当场交付 + 扣库存）
>   库存里没有 → 预定（不交付；等货到了再交付、那时才扣库存）
>   ⭐ 所以：**每次都必须查库存**（这就是判据本身）→ "预定跳过库存检查"那条配置要删
>  【资金 = 只听你怎么说】（与类型完全无关）
>   全款 → 收款 1 条已收、欠款 0；付了一部分 → 已收那部分 + 待收剩余；没付 → 0 条已收 + 全额待收
>   ⇒「未付」不再是类型（她已从行为表删掉那条），它只是"现货 + 钱没结清"的状态
>  【交付 = 由类型决定】现货已交付 / 预定未交付
>  【卡片 = 分开说】类型 · 履约状态 · 收款情况（已收多少、还欠多少）」

她的三步流程（逐字）：

> 「1. 货品信息还是要先查这个货品有没有、信息全不全
>   2. 这里要给到**全色**，让用户去选
>   3. 用户选完之后，再拿着用户选的颜色去……找，如果找到了，就是现货，如果没找到，就是预定」

Lead 的解读（按此实现）：第 3 步查的是**实时库存**（不是货品信息）。

## 1. 验收标准（动手之前写）

### AC-1 类型判据 = 实时库存有没有（唯一判据）
- **AC-1.1** 同一条输入（有货号 + 尺码 + 单一颜色）、实时库存**有**这一双 ⇒
  明细行交易类型 = `SALE_CASH`（现货）、主表「交易类型」关联到 `SALE_CASH` 那条行为；交付 + 扣库存。
- **AC-1.2** **同一条输入**、实时库存**没有**这一双 ⇒
  明细行交易类型 = `SALE_PREPAID`（预定）、主表关联到它；**不交付、不扣库存**；**不再出"缺货拦截"**、卡片照出。
  （AC-1.1 与 AC-1.2 是**同样输入、只有库存不同**的对照 —— 这就是"判据是库存"的证明。）
- **AC-1.3** 颜色有多个候选时：选完颜色**才**拿这个颜色查库存 → 找到 = 现货，没找到 = 预定
  （同一次点击的两种结果，只有库存不同）。
- **AC-1.4** `config/salesTradeTypePolicy` 里**没有**任何 `stock:false` 的策略；
  `lark.sales.stock_existence.skipped` 不再因"交易类型不查库存"出现（B 对两种类型都跑）。
- **AC-1.5** 配品（配品没有货号/尺码，无从查库存）：沿用她说的性质（默认现货），不被库存判据影响。

### AC-2 候选给【全部颜色】（撤掉"只推在售"）
- **AC-2.1** A（货品信息）给出的候选**不按**「货品状态 = 下架」过滤：全部颜色都出候选。
- **AC-2.2** `SALES_COLOR_OPTIONS_SCOPE` / `salesColorOptionsScopeFor` / `colorOptionsInScope` /
  `SALES_COLOR_SCOPE_EMPTY_TEXT` / 全下架拦截**全部退场**；`config/salesColorChoice` 里
  `SALES_PRODUCT_STATUS_OFF_SHELF` 也随之下线。
- **AC-2.3** ~~「有货 / 无货」标注**保留**（SALES_COLOR_STOCK_LABEL_* 两个环境变量仍是旋钮），
  语义 = 这双会记成现货 / 预定。~~
  🔴 **已被同日晚些时候的口径取代**（业务负责人逐字「**甲 去掉**」）：候选**只显示颜色名**，
  预览标注与那两个环境变量一并删除 —— 见
  [color-candidate-no-stock-preview-2026-10-07.md](color-candidate-no-stock-preview-2026-10-07.md)。
  （`AC-2.4` 里"每条都标无货"同样作废；**"全部颜色都出候选"与"选了没货的 → 预定"不变**。）
- **AC-2.4** 一个货号**全部颜色都没货** ⇒ 仍然出**全部**候选（⚠️ 但**不再标「无货」**，见 AC-2.3）；
  她选了其中一条 ⇒ 记 `SALE_PREPAID`（预定），不出拦截、不要求重发。

### AC-3 资金与类型彻底解耦（四形态 × 两类型）
对 **现货（有货）** 与 **预定（没货）** 各跑四种资金形态，收款条数与欠款数字逐字断言：
- **AC-3.1 全款**：`payments` = 1 条已收；欠款 0（不补未收款）。
- **AC-3.2 部分**（先给 100、还欠 19）：`payments` = 1 条已收 100 + 1 条未收款 19。
- **AC-3.3 没付**（整单未付）：`payments` = 0 条已收 + 1 条未收款 = 全额。
- **AC-3.4 定金**（定金 100、尾款 128）：`payments` = 1 条已收 100（定金）+ 1 条未收款 128。
- **AC-3.5** 类型不再影响任何金额：同一份资金原话在现货 / 预定两种库存下**逐字同结果**。
- **AC-3.6** "预付必须有定金"之类的隐含前提清掉：预定 + 全款 / 预定 + 没付都是合法输入。

### AC-4 交付
- **AC-4.1** 现货 → 交付 + 扣库存（走既有 `SalesDeliveryService.deliver`）。
- **AC-4.2** 预定 → 不交付、不扣库存（既有的"全不交付 → 不调用交付"保持）。
- **AC-4.3** 一单多明细时**逐行**判：现货行交付、预定行不交付；明细行的「交易类型」单选、
  主表「交易类型」多选去重（#234 不回退）。

### AC-5 卡片三段
- **AC-5.1** 确认卡片与"处理中"卡片把三件事**分段**说：`类型`、`履约状态`、`收款情况`。
- **AC-5.2** 收款情况 = 「已收多少 / 还欠多少」；全款时"还欠"= 已结清（可配）。
- **AC-5.3** 三段文案**一个字都不写在逻辑里**：全在 `config/`（改文案不碰逻辑）。
- **AC-5.4** "未付"**不再**作为类型出现在卡片上。

### AC-6 待处理单推送（`pendingDealPush*`）
- **AC-6.1** 候选源 = 「**预定（未交付）**」＋「**现货但钱没结清**」——即
  "已入账、最近 7 天、**尚未完成履约**"（不再按"未付 / 预付"两个交易类型编码筛）。
- **AC-6.2** 分区标题 = `【预定】` / `【现货待收】`（文案可配，环境变量仍是旋钮）。
- **AC-6.3** 一条现货已交付、还欠着钱的单**会**进候选并落在「现货待收」区（改动前**不会**）。
- **AC-6.4** 渲染逐字：表头 + 分区 + 行（单号 + 标签 + 货号尺码 + 待收 + 深链）。

### AC-7 「未付」/ `SALE_UNPAID` 退场
- **AC-7.1** `SALE_UNPAID` 在全仓**代码判据 / 配置 / 测试**里 0 命中。
- **AC-7.2** 「未付」在**用户可见文案**里 0 命中（守门测试，扫 `server/src/**` 的字符串字面量与 config 默认值）。
- **AC-7.3** 处置清单逐项在汇报里列出（含 `secondDeliveryService` / `pendingDealPush*` / 工作台）。

### AC-8 哨兵（不回退）
- **AC-8.1** 单类型单 + 单明细：金额拆分（#231）、一单多明细（#234）、
  建档拦截（#224）、A 的 this 修复（#226）、A 定颜色→选完才跑 B（#227）、追问文案（#233）**逐条不回退**。
- **AC-8.2** 既有断言**不许放宽**；因口径变更必须改的，逐条说明为什么不是放宽。

### AC-9 历史影响面（只读）
- **AC-9.1** 只读统计：历史销售单 / 明细里原来指向「未付」行为的记录，现在读出来是什么（空 / 异常 / 仍可读）。
- **AC-9.2** 不写任何表；结论按《AGENTS.md》第 17 条给事实表证据，未核到就说"我还没查到这一步"。

## 2. 改动的文件清单（动手之前写）

| 文件 | 改什么 |
| --- | --- |
| `server/src/config/salesMovements.js` | 两个编码：`SALE_CASH` 现货 / `SALE_PREPAID` 预定；删 `SALE_UNPAID` |
| `server/src/config/salesTradeTypePolicy.js` | 删 `stock:false`、删候选范围；新增"库存 → 类型"判据 |
| `server/src/config/salesColorChoice.js` | 删"不在售过滤"与全下架文案；保留有货/无货标注 |
| `server/src/config/salesCardFacts.js`（新） | 卡片三段的文案模板（类型 / 履约 / 收款） |
| `server/src/config/pendingDealPush.js` | 分区判据从"交易类型编码"改成"履约状态"；标题 预定 / 现货待收 |
| `server/src/services/larkMvpService.js` | 类型的判据改为查完库存再定；候选全色；删缺货拦截 |
| `server/src/services/doubaoService.js` | 提示词 / 归一化里的类型与资金解耦；删「未付」 |
| `server/src/services/secondDeliveryService.js` | 候选筛掉"交易类型编码"，改成"尚未完成履约" |
| `server/src/services/pendingDealPushService.js` | 分区按履约状态 |
| `server/src/services/v1ReferenceResolver.js` | 注释与状态字段（随候选范围撤场） |
| `server/src/utils/larkCards.js` | 卡片三段渲染 |
| `server/test/*` | 新增判据/解耦/守门/推送用例；既有断言按口径变更同步 |
| `server/.env.example` | 三段文案 / 分区标题的旋钮 |

## 3. 明确的边界（不许做）

- 🔴 不许部署；不许写生产表 / 改线上 `.env`。
- 🔴 不许发明新的行为编码（表里只有 `SALE_CASH` / `SALE_PREPAID`）。
- 🔴 不许改交付 / 扣库存 / 入账的**底层写入口径**（只改"按什么决定类型"这一层）。
- 🔴 不回退 #224 / #226 / #227 / #231 / #233 / #234。

<!-- 第 4 节起为事后回填（逐条对照 / 先红后绿 / CI / 全量 / 不确定处） -->

---

## 4. 六处关键 diff（判据 / 候选 / 资金 / 交付 / 卡片 / 推送）

### ① 判据：类型 = 查完实时库存再定
- `config/salesMovements.js`：注册表只剩 `SALE_CASH`（现货，已交付）/ `SALE_PREPAID`（**预定**，未交付）；
  中文标签表 `{现货→SALE_CASH, 预定→SALE_PREPAID}`，**`预付` 作为同一条记录的旧说法**保留映射（编码不变），
  **`未付` 不在表里**（取不出编码）。
- `config/salesTradeTypePolicy.js`：**新增** `SALES_TRADE_TYPE_BY_STOCK` + `salesTradeTypeForStock({ inStock })`
  —— 唯一的"有货 → 现货 / 没货 → 预定"映射；**删掉** `SALES_TRADE_TYPE_PARSE_POLICY` /
  `SALES_PARSE_POLICY_DEFAULT` / `salesParsePolicyFor` / `salesParseRuns`（含 `SALE_PREPAID: stock:false`
  那条"预定跳过库存"的策略）与 `colorOptionsScope` 那一套。
  理由：类型是"查完库存"才有的结论，**不可能再拿它决定"要不要查"**（循环论证）；
  留一张"两行都是 true"的表只会让人以为"这里可以关掉库存检查"。
- `services/larkMvpService.js`：
  · 录单循环里 **A（货品信息）与 B（实时库存）都跑**；B 的结论 `availability.inStock`
    经 `salesTradeTypeForStock` 落成 `items[].trade_type_code`（认不出/还没查 ⇒ **空串 = 还没定**，
    绝不兜成现货）；配品（没有货号 / 尺码）沿用她嘴上说的性质。
  · `choose_sale_color`（她选完颜色那一次）**一定**跑 B → 找到 = `SALE_CASH`，没找到 = `SALE_PREPAID`；
    **「没货」不再是"缺货提示 / 请核实"**，候选也不再"保留等她重选"。
  · `resolveStockAvailabilityForSale` 的返回从 `{ shortage: '库存里没有…' }` 改成 `{ inStock: false }`
    （那句缺货文案**整段退场**）。
  · **新增** `syncSalesTradeTypes(...)`：主表「交易类型」多选在**确认入账前再同步一次** ——
    多颜色那一条的类型是"选完颜色、查完库存"才定下来的，录单那一次写不到它。
  · **新增正向证据日志** `lark.sales.trade_type.decided`
    （`judged_by: 'realtime_stock'` + `in_stock` + `trade_type_code`，录单 / 选颜色两处）；
    **删除** `lark.sales.stock_existence.skipped`（含 `trade_type_policy_skips_stock_parse`
    与 `color_options_out_of_scope` 两个 reason）。

### ② 候选 = **全部颜色**（撤掉 #230）
- `larkMvpService.colorOptionsInScope`、`config/salesColorChoice.SALES_PRODUCT_STATUS_OFF_SHELF` /
  `SALES_COLOR_SCOPE_EMPTY_TEXT` / `formatColorOptionsScopeEmptyText`、
  `config/salesTradeTypePolicy.SALES_COLOR_OPTIONS_SCOPE` / `salesColorOptionsScopeFor` **全部删除**；
  `.env.example` 里 `SALES_COLOR_SCOPE_EMPTY_TEXT` 也删了。
- ~~「有货 / 无货」标注**保留**（`SALES_COLOR_STOCK_LABEL_AVAILABLE/UNAVAILABLE`），
  语义现在 = **这一双会记成现货还是预定**的预告；两种类型、**每个候选都标**。~~
  🔴 **已作废（同日后续口径「甲 去掉」）**：候选只显示颜色名，后缀键与 `SALES_COLOR_STOCK_STATUS`
  一并删除 —— 见 [color-candidate-no-stock-preview-2026-10-07.md](color-candidate-no-stock-preview-2026-10-07.md)。
- 新的正向证据日志 `lark.sales.color_options.offered`（⚠️ 现在只剩**候选数**
  `option_count`：候选上已没有库存状态，`available_count` / `unavailable_count` 随之删除）。

### ③ 资金与类型解耦
- `services/doubaoService.js`：
  · "成交金额 = 实收"那条还价口径**不再看交易类型**（删掉 `tradeType === '现货'` 这个条件），
    只由**钱**的词护栏（`moneyNotSettled`，含 定金 / 尾款 / 欠 / 未付 / **预定**）决定；
  · `moneyNotSettled` 补上 `预定`（她现在的说法）；
  · 交易类型标签统一成**规范标签**（`预付` → `预定`；认不出的留空串），提示词规则 2 重写：
    **类型由后端按实时库存定，模型只填"她嘴上说的性质"**，并明确「她说未付 / 欠着 ⇒ 仍然是现货」。
- 资金四条形态（全款 / 部分 / 没付 / 定金）与类型**零耦合**：`services/salesOrderService.js` 的
  入账口径**一个字没改**（`payments` + 她明说的 `owed` → 补一条「未收款」）。
- 新增测试 `test/salesFundTypeDecoupling.test.js`：四形态 × 两类型共 8 次端到端断言
  「收款条数 / 金额 / 欠款数字**逐字相同**」，只有类型与交付不同。

### ④ 交付
- **零改动**：`deliversForTradeType` / `SalesDeliveryService` / 扣库存入口一个字没动；
  变的只是"类型从哪来"（库存）⇒ 有货的行交付并扣库存、没货的行不交付；
  "全不交付 → 不调用交付"保持。

### ⑤ 卡片三段
- 新增 `config/salesCardFacts.js`：`类型：{type}` / `履约状态：{fulfillment}` / `收款情况：{payment}`
  三行 + 「已收 …；还欠 ￥…／已结清」两个子句——**文案全在 config**（占位符写错在解析时抛错）。
- `utils/larkCards.js`：确认卡片把原来那一行「交易类型：现货 · 已交付」换成**三行**；
  `salesStatusCard`（她明确满意的那张终态卡）**一个字没动**。
- 新增 `config/secondDeliveryCard.js`：成交提醒卡的标题 / 兜底类型名从"未付 / 预付"改成
  「待成交 / 待收款」/「待处理」。

### ⑥ 待处理单推送
- `services/secondDeliveryService.js`：**删掉** `REMINDER_TRADE_TYPE_CODES = ['SALE_UNPAID','SALE_PREPAID']`
  那层筛选（它会把"现货 + 欠着钱"整类漏掉）；候选 = **尚未完成履约**（`progress.orderStatus !== '已完成'`）；
  行为关联只用于**显示名称**，关联悬空**不再跳过**这笔单。
- `config/pendingDealPush.js`：分区判据从"交易类型编码"换成**履约状态**
  （`pendingDealPushCriterionFor`：已交付 → `delivered_unpaid`，其余 → `undelivered`）；
  区块 key `prepaid` / `cash_pending`，默认标题 `【预定】` / `【现货待收】`；
  环境变量 `PENDING_DEAL_PUSH_UNPAID_TITLE` → `PENDING_DEAL_PUSH_CASH_PENDING_TITLE`；
  表头默认改成「⏰ {day} 最近 7 天待处理的销售单（预定 / 现货待收）：{total} 笔{blockCounts}」。
  ⚠️ 旧值 `PENDING_DEAL_PUSH_BLOCK_ORDER=...unpaid` 会在**启动时**报「没声明的区块」（故意吵一声）。
- `services/pendingDealPushService.js`：`buildSections` 按判据分区（一行中文都没写）。

## 5. `SALE_UNPAID` / 「未付」处置清单（逐个）

| 位置 | 处置 |
| --- | --- |
| `config/salesMovements.js` | 注册表删掉 `SALE_UNPAID`；中文标签表删掉 `未付`；注释说明"它只是现货 + 钱没结清的状态" |
| `config/salesTradeTypePolicy.js` | 类型策略表整体退场（连带 `SALE_UNPAID` 行）；新判据只有现货 / 预定 |
| `config/salesColorChoice.js` | 删掉按"在售 / 下架"过滤候选那一套（`SALES_PRODUCT_STATUS_OFF_SHELF` 等） |
| `config/pendingDealPush.js` | 分区从 `SALE_PREPAID` / `SALE_UNPAID` 编码改成履约判据；默认标题 `【预定】`/`【现货待收】`；env 键改名 |
| `config/v1BitableSchema.js` | 注释里的「未付销售」改成「现货 / 预定」 |
| `services/secondDeliveryService.js` | 删 `REMINDER_TRADE_TYPE_CODES`（含 `SALE_UNPAID`）；候选改成"尚未完成履约"；注释说明老口径为什么会漏单 |
| `services/pendingDealPushService.js` | 分区改判据；日志文案里的"未付/预付"清掉 |
| `services/doubaoService.js` | 交易类型标签集合去掉 `未付`；`未付` **只**留在"钱"的词表里（她的话）；提示词明确「未付 ⇒ 仍是现货」；标签规范化 |
| `services/larkMvpService.js` | 「未付」相关的判据 / 缺货拦截 / 候选范围全删；类型由库存定 |
| `services/groupBuyVoucherPolicy.js` | 券 + "没结清的钱"的拦截文案不再写"预付 / 未付款"（判据仍是她的话） |
| `services/v1ReferenceResolver.js` | 注释更新（候选不再按在售过滤；交易类型只有两种） |
| `utils/larkCards.js` | 卡片三段；成交提醒卡的"未付 / 预付"文案清掉 |
| `utils/secondDeliveryReminder.js` / `utils/shanghaiDailyScheduler.js` / `app.js` | 注释里的"未付 / 预付"清掉 |
| **工作台**（`routes/workbench.js` / `controllers` / `public/workbench`） | **核过：一处都没有**（没有 `未付` / `SALE_UNPAID` / `tradeType` 的任何引用 ⇒ 无需改动） |
| `.env.example` | `SALES_COLOR_SCOPE_EMPTY_TEXT` 删除；分区标题键改名；新增三段文案旋钮；值行 0 命中「未付 / 预付」（有守门用例） |
| `server/test/**` | 相关 fixture / 断言全部改成现货 / 预定；`salesColorOptionsScope.test.js` 删除（被 `salesColorCandidatesAllColors.test.js` 取代）；新增守门用例 |

守门用例：`server/test/salesTypeByStockGuard.test.js`
（① 卡片 / 推送 / 追问渲染 0 命中「未付 / 预付」；② 配置默认值 0 命中；③ `src` 的**代码 / 配置字面量**
里 0 命中 `SALE_UNPAID`（注释里的历史说明允许）；④ `.env.example` 的值行 0 命中）。

## 6. 历史影响面：**只读**核查结果（AC-9）

⚠️ 先说结论的边界（《AGENTS.md》第 17 条）：**这次只读核查到的是【测试 Base】，不是生产 Base。**
本机 `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` 与 `FEISHU_V1_E2E_TEST_APP_TOKEN` **同值**
（指纹 `GqMMbh…nnlb`）⇒ 物理上够不着生产 Base；**生产 Base 上的真实条数，我还没查到这一步**，
不写"结不出来 / 是空的"这种结论。（要核生产必须在服务器上、只读跑同一段逻辑。）

核查方式：**走项目代码**（`V1BitableGateway.listAll('behavior' / 'salesEntry' / 'salesDetail')`
+ `linkedRecordIds`），**零写入**；脚本是临时的、已删除。

**测试 Base 的事实（2026-10-07 19:57 上海时间）**：

| 事实 | 值 |
| --- | --- |
| 行为记录总数 | 21 |
| 行为编码里有没有 `SALE_UNPAID` | **有**（测试 Base **还没**按生产改成两条） |
| 销售主表 总记录 | 236 |
| 销售主表 交易类型**空** | 80 |
| 销售主表 交易类型**可读** | 156（`SALE_CASH` 97 / `SALE_PREPAID` 14 / **`SALE_UNPAID` 8** / `SALE_RETURN` 20 / `SALE_EXCHANGE` 17） |
| 销售主表 关联**悬空**（指向不存在的行为记录） | **0** |
| 销售明细 总记录 | 249 |
| 销售明细 交易类型**空** | 86 |
| 销售明细 交易类型**可读** | 163（`SALE_CASH` 107 / `SALE_PREPAID` 11 / **`SALE_UNPAID` 8** / `SALE_RETURN` 20 / `SALE_EXCHANGE` 17） |
| 销售明细 关联**悬空** | **0** |

⇒ 在**测试 Base**上，"原来指向未付"的记录 **8 条主表 + 8 条明细**，现在读出来**仍然可读**
（那条行为记录还在，名称还是「未付」）。**没有出现"读出来是空"的现象**。

⚠️ 生产 Base 上她**已经删掉**那条行为记录 ⇒ 生产上那几条历史记录会变成**关联悬空**。
代码侧已按"悬空"这一情形处理（本轮专门加了用例）：
- `secondDeliveryService.listPendingDeliveries`：**不再**因为"类型名读不出来"跳过这笔单
  （判据是履约进展）⇒ 历史单照旧进待处理清单，只是那一行的类型名取不到（走 `待处理` 兜底）；
- 明细行写入侧不受影响（历史明细已经在表里，本轮不动任何写入）。

## 7. 她那条原话的解析（类型 + 收款条数 + 欠款）

| 她的原话 | 类型（由**库存**定） | 收款条数 | 欠款 |
| --- | --- | --- | --- |
| 「全款 228 微信」 | 库里有 → **现货**（已交付 + 扣库存）；没有 → **预定**（未交付） | **1 条已收**（228） | **0** |
| 「先给 100，还欠 128」 | 同上（与钱无关） | **2 条**：100 已收 + 128 未收 | **128** |
| 「228 元未付」（一分没给） | 同上（**"未付"不是类型**） | **0 条已收 + 1 条未收**（228） | **228** |
| 「定金微信交了 100，下次欠 128」 | 同上 | **2 条**：100 已收 + 128 未收 | **128** |

（逐字断言见 `test/salesFundTypeDecoupling.test.js`：同一份资金原话在"库里有 / 没有"两次跑出来的
收款记录**完全相同**，只有类型与交付不同。）

## 8. 验收标准 → 逐条对照

| AC | 对照 | 证据（用例 / 文件） |
| --- | --- | --- |
| AC-1.1 有货 → 现货（交付 + 扣库存） | ✅ | `salesPrepaidColorResolution.test.js` ②、`salesFundTypeDecoupling.test.js`（现货那半）、`larkMvpService.test.js` 现货单卡片用例 |
| AC-1.2 没货 → 预定（不交付、不扣库存、不拦单） | ✅ | `salesPrepaidColorResolution.test.js` ①③、`salesFundTypeDecoupling.test.js`（预定那半）、`larkMvpService.test.js`「库存里没有这个尺码 → 记预定、照出卡片」 |
| AC-1.3 选完颜色才定类型（同一次点击两种结果） | ✅ | `salesColorCandidatesAllColors.test.js` ②b（同一份输入：黑 → 现货、巧克力 → 预定）、`salesPrepaidColorResolution.test.js` ①② |
| AC-1.4 无 `stock:false` 策略 / 无 skipped 日志 | ✅ | `salesTradeTypePolicy.test.js`（断言那套 API 不存在）、`salesColorCandidatesAllColors.test.js` ③（断言两条老日志不再出现） |
| AC-1.5 配品沿用她说的性质 | ✅ | 既有配品用例（`larkMvpService.test.js` 配品 / 混合单）逐字通过 |
| AC-2.1 / 2.2 候选全部颜色、过滤那套退场 | ✅ | `salesColorCandidatesAllColors.test.js` ①③⑤ |
| AC-2.3 ~~有货 / 无货标注保留~~ | 🔴 已作废 | 同日后续口径「甲 去掉」：候选只显示颜色名（`larkCards.test.js` 逐字 `['黑','白']`、`assert.doesNotMatch(/有货\|无货/)`）；见 `docs/color-candidate-no-stock-preview-2026-10-07.md` |
| AC-2.4 全都没货 → 全部候选 → 选了记预定（⚠️ 不再"全标无货"） | ✅ | `salesColorCandidatesAllColors.test.js` ② |
| AC-3.1~3.4 四形态 × 两类型 | ✅ | `salesFundTypeDecoupling.test.js` 8 条 |
| AC-3.5 类型不影响任何金额 | ✅ | 同上最后一条「两次的收款记录逐字相同」 |
| AC-3.6 "预定必须有定金"前提清掉 | ✅ | 同上「预定 + 全款 / 预定 + 没付都能入账」 |
| AC-4.1~4.3 交付 | ✅ | `salesFundTypeDecoupling.test.js`（已交付/未交付 + 库存流水有无）、`salesMultiLineTradeType.test.js` AC-8/AC-9（逐行） |
| AC-5.1~5.4 卡片三段 / 文案在 config | ✅ | `larkCards.test.js`（两段新用例）、`cardUpdateMulti.test.js`（golden 同步，**不是放宽**） |
| AC-6.1~6.4 待处理单推送 | ✅ | `pendingDealPushSections.test.js`（10 条，含判据、分区、逐字渲染）、`pendingDealPush.test.js`、`secondDeliveryPendingItems.test.js`（AC-6.3 候选 + 悬空关联） |
| AC-7.1~7.3 未付 / `SALE_UNPAID` 退场 | ✅ | `salesTypeByStockGuard.test.js`（6 条）、第 5 节清单 |
| AC-8.1~8.2 哨兵 / 不放宽 | ✅ | #224 `sales-product-registration-guard` 用例、#226「A 必须带 this」、#227（选完才跑 B 的用例）、#231/#234 `salesMultiLineTradeType.test.js`、#233 `salesMissingInfoText.test.js` 全绿；改动的断言逐条理由见第 9 节 |
| AC-9.1~9.2 历史影响面只读 | ⚠️ **部分** | 测试 Base 的数字见第 6 节；**生产 Base 未核到**（本机够不着，如实说明） |

## 9. 先红后绿证据 + "不是放宽"的逐条说明

**① 全量套件：先红后绿**
- 改完 `src/` 之后第一次跑全量：`tests 1128 / pass 1069 / fail 59`
  （59 条全部落在与本次口径强相关的文件：larkMvpService 13、pendingDealPushSections 9、
  salesColorOptionsScope 8、salesTradeTypePolicy 6、salesMultiLineTradeType 6、
  salesMissingInfoText 4、pendingDealPush 4、salesPrepaidColorResolution 3、salesColorChoice 3 …）。
- 按新口径更新 / 重写这些用例后：`tests 1140 / pass 1140 / fail 0`（连跑 2 次，见第 10 节）。

**② 变异验证（证明新用例真的钉住了"判据 = 库存"）**
把 `salesTradeTypeForStock` 临时改成**恒返回 `SALE_CASH`**（`src` 一行改动），
只跑本次新增 / 重写的三个文件：

```
✖ ② 全部颜色都没货 → 全部候选 + 全部标「无货」；她选了其中一个 → 记预定
✖ ②b 判据是库存：同样输入、库里只有「黑色」→ 选黑色 = 现货，选巧克力 = 预定
✖ ③ 全款 / 部分 / 没付 / 定金：**预定**（库里没有）→ 收款条数与欠款数字逐字相同（4 条）
✖ ③ 预定 + 全款 / 预定 + 没付都能入账
✖ ③ 同一份资金原话：库里有 / 没有，两次的收款记录逐字相同
✖ ⭐ 类型的唯一判据：实时库存里有 → 现货；没有 → 预定
ℹ tests 24 / pass 15 / fail 9
```
恢复这一行之后：`tests 24 / pass 24 / fail 0`。⇒ 这 9 条**确实**是因为"库存判据"才绿的。

**③ 因口径变更必须改的断言 —— 逐条说明"为什么不是放宽"**

| 断言（改前 → 改后） | 为什么不是放宽 |
| --- | --- |
| 「库存里没有这个尺码 → `needs_info` + 不出卡片 + 回『请核实』」→「→ **预定**、照出卡片、不再回那句」 | 口径本身变了（她逐字：没货就是预定）。新断言**更多**：还钉了 `trade_type_code=SALE_PREPAID`、`delivery_status=未交付`、`missing_fields=[]` |
| 「预付 / 未付：A+B；预付只有 A（B 不跑）」→「两种类型都跑 B」 | 判据变了（B 就是类型判据）。新断言把"两件都查"钉死（`['31678','6681-1']`） |
| 「候选只推在售（下架色不出现）」→「候选 = 全部颜色」 | 她明确「要给到**全色**」。新断言从"丢掉了哪些"变成"一个都不能少 + 每个都要标注"，覆盖面更大 |
| 卡片「交易类型：现货 · 已交付」一行 → 三段三行 | 她明确「卡片 = 分开说」。断言从 1 行变 3 行（+ 逐字收款句），**信息量更大**；`salesStatusCard` 与其余 15 张卡**一个字没动**（golden 只同步了 2 张有意变更的） |
| `salesTradeTypePolicy.test.js` 整个重写 | 被断言的对象（解析策略表 / 候选范围）**已删除**。新文件钉的是新判据 + `SALE_UNPAID` 退场 + "那套 API 不许加回来" |
| `salesColorOptionsScope.test.js` 删除 → 新增 `salesColorCandidatesAllColors.test.js` | 前者钉的是"只推在售"（已撤）；新文件钉"全部颜色 + 有货/无货标注 + 选了记预定 + 零新增远端请求"，条数 8 → 8，覆盖面不缩 |
| 推送「未付 / 预付分区」→「预定 / 现货待收（按履约状态）」 | 分区判据的口径变了；新用例**新增**了"判据函数本身"的断言与"现货待收进候选"（AC-6.3），并保留深链 / 按天去重 / 置顶全部既有断言 |
| `salesMissingInfoText` 里"哪双是预付"→"哪一件付了定金" | 那句追问不再把类型当问题问她（类型由库存定）；判据（`missing_fields`）与映射机制一个字没动，形状守卫仍全绿 |
| `doubaoSalesParser`「定金不能被当成成交金额」用例补上原话 | 资金护栏**不再看类型**（解耦），只看钱的话；补的是**真实输入**（生产一定有原话），语义等价 |

## 10. CI 三项实际输出 + 全量 2 次

**PR #235**（`feat/stock-derived-trade-type`）· `gh pr checks 235`（2026-10-07 20:00 上海时间）：

```
Analyze (javascript-typescript)  pass  51s  https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37617881420/job/112780562840
CodeQL                           pass   5s  https://github.com/LyraWang6688/feishu-retail-ops/runs/112780840848
test                             pass  53s  https://github.com/LyraWang6688/feishu-retail-ops/actions/runs/37617884685/job/112780565485
```

`gh pr view 235 --json mergeStateStatus` ⇒ **`CLEAN`**（三项 conclusion 都是 SUCCESS）。
⚠️ 本 PR **未合并、未部署**（部署必须拿到她当次的明确命令）。

**全量（连跑 2 次，`node --test --test-concurrency=1`）**：
```
=== RUN 1 ===  ℹ tests 1140  ℹ pass 1140  ℹ fail 0   (duration_ms 27696.7)
=== RUN 2 ===  ℹ tests 1140  ℹ pass 1140  ℹ fail 0   (duration_ms 29554.0)
```

## 11. 不确定处 / 需要她拍板的地方

1. **生产 Base 的历史影响面还没核**（第 6 节）：本机够不着生产 Base，只知道**测试 Base**的
   事实（8 + 8 条仍可读、0 条悬空）。生产上那条行为记录已被删 ⇒ 预期是"关联悬空、类型名读不出来"，
   代码已容忍（有用例），但**真实条数与读出来的形状必须在服务器上只读核一次**。
2. **多颜色时"类型待定"**：她还没选颜色之前，卡片上三段会显示「类型：待定 / 履约状态：待定」
   （收款情况照常）。这是**新的显示状态**（改动前那种草稿根本不显示类型）。
   ⚠️ 2026-10-07 后续口径：**候选上不再有"有货 / 无货"预告**（「甲 去掉」，候选只显示颜色名）——
   想知道现货还是预定，就**让她选一个颜色**，后端查完库存会告诉她；
   要换"待定"的措辞，改 `SALES_CARD_UNDETERMINED_TEXT`。
3. **`PENDING_DEAL_PUSH_BLOCK_ORDER` 旧值会报错**：线上若显式配过 `prepaid,unpaid`，
   启动时会抛「没声明的区块」（故意的）。需要确认线上 `.env` 没配这个键（或改成 `prepaid,cash_pending`）。
4. **`PENDING_DEAL_PUSH_UNPAID_TITLE` 改名**为 `PENDING_DEAL_PUSH_CASH_PENDING_TITLE`：
   若线上显式配过旧键，它会静默失效、回落默认 `【现货待收】`。
5. **"部分交付"那一档**：新卡片把"一张单里既有现货又有预定"显示成「部分交付」；
   她原话只说了"现货已交付 / 预定未交付"两档，这一档是**沿用 #234 既有口径**（`salesDeliverySummary` 的 partial）。
