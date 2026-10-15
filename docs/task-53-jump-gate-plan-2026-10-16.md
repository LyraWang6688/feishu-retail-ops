# task-53 改动计划 + 判据草案 —— P0 第二刀「跳转前置判定」＋ 恢复 `⑨` 期望 400

> **本文件是【只读准备】的产物**：没有改任何源码 ✗（`routes/scanPage.js` / `views/**` / `scanWriteService.js` 一个字没碰）。
> 落点行号在**本 worktree 的 base `97808b6`**（= 更新这一版时的 `origin/main`）上**只读核出**：
> `scanPage.js` 的关键锚点与第一版（`ea3bf0c`/`7ec5d6b`）**逐行相同** ⇒ 行号照旧可用 ✓
> （核法：`grep -n 'if (action === actions.submitOrder)'` → `:1695`；`grep -n 'const lineAmounts ='` → `:1716`；
> `grep -n 'lineAmountRequired !== false'` → `:1771`；`grep -n 'const submitView = String'` → `:1794`；
> 跳转出口 `:1808`；`test/scanPageWrite.test.js` 的「钉现状」断言仍在 `:900`）。

> ⭐⭐ **第二版（2026-10-16 更新）**：业务负责人当天**又拍了一条更简单的口径**，把"要不要读单价"整块**删掉**了
> ⇒ 本文件已按新口径重写 §0/§2/§3/§4/§5/§6/§7。第一版（以"单价两个来源"为核心的版本）**已随 #669 合并进 main**（`7f8f042`），
> 那份内容只作**留痕**（§4 保留"当时的两读法"记录 ✓）。

---

## 0. 依据（她逐字 · 最新口径优先）

### ⭐ 最新（2026-10-16，**本刀按这条做**）

> 「算了，这样吧，**实收金额的输入框用户必须填写**，只有用户填了**尺码和金额**，才可以点击提交跳转到资金页，
>  **不用做那个为空去单价的功能了**」

⇒ **判据 = 尺码已填 且 实收金额已填**；**缺任一 ⇒ 拦住 + 停在货品页 + 人话 + 零写入** ✓
⇒ ⭐ **不再需要读**：`submitView.price_text` ✗ · 草稿行 `service.lookup` ✗ · 「其他配品.单价」✗
⇒ 判定输入从三个**缩成两个**（尺码 + 本次填的金额），**且少一次飞书读** ✓

### 更早（2026-10-16 当晚前半场，**已被上面那条覆盖**，留痕）

> 「我们能够**跳转到资金页面**的前提，是用户在**点击提交的那一刻**，系统能不能获取到关于这个**会话的尺码信息**
>  以及**货品单价信息**。**单价信息可能来自用户的手动输入，也可能来自货品信息里的数据**。
>  如果**这两个都取不到，用户就无法跳转到资金页**」

### `⑨` 的「改前逐字」（**原文抄录在 PR #659 的描述里**，本刀要逐字改回 ✓）

> `assert.equal(response.status, 400, '两个都取不到 ⇒ 拦住（不跳资金页）')`
> ＋「必须有那句『…请填金额』的人话」＋「零写入」
> ⚠️ 人话**按新口径改措辞**（不点单价）：「**请先填尺码和实收金额**」这类；
> 🔴 **仍不许出现「成交金额」「交易方式」**（见 §6 第 1 条）。

🔴 已知真因（别重走 ✗）：判定曾经被**老那层** `if (lineAmountRequired && lineAmounts.some(空))`（`:1771`）**包住** ⇒
`lineAmounts` 是**空数组**时 `.some(...)` 恒 `false` ⇒ **整段不执行**；而往前挪到更早的出口会罩住
**幂等连点 / 重复提交 / 刷新 / 资金页动作**（当晚被误拦出 6～13 条红 ✗）。

---

## 1. 落点（`server/src/routes/scanPage.js`，base `97808b6`）

| 行 | 是什么 | 与判定的关系 |
|---|---|---|
| `:1695` | `if (action === actions.submitOrder) {` | 提交分支入口（`submitOrder` 与资金页动作**天然分开** ✓） |
| `:1708-1710` | `submitSession` / `pendingDraftLines`（会话草稿行） | 判定的"会话"来源 |
| `:1711-1718` | `lineAmounts` 三档回落（body `line_amount` → 草稿行 `amount` → 单行 `amount`） | **「她填的金额」** 的真源（**唯一**） |
| `:1730-1766` | `saveDraftLines({ lines, paymentStep:'pending', status:draft, submitPending:{ lineAmounts, … } })` | 会话标记（①刀特意**上移到闸门之前** ⇒ 拦住也不会让她卡死 ✓）**不许动它** |
| `:1771-1783` | 老那层 `lineAmountRequired && lineAmounts.some(空)` ⇒ 400 资金页 | 既有行为**一字不改** ✓（判定**不许写进这个 if 里** ✗） |
| `:1793-1797` | `submitView = body[size] ? await service.lookup(...) : null` ＋ `saleTiming.lookup_ms` | ⚠️ 新判据**不再读它**；位置仍保持在这些行之后（见下） |
| **`:1808-1812`** | **`return sendPaymentStep(res, req, { realm, submitKey, count })`** | ⭐ **"点提交要跳资金页"的那一个出口** —— **判定就插在 `:1797` 之后、`:1808` 之前** ✓ |
| `:1813-1834` | `writeService.submitSale(...)`（`// eslint-disable-next-line no-unreachable`） | **不可达残留**（点提交不建单 ✓）—— 判定**不要**放到它后面 ✗ |

**为什么正好是这个位置**（三条都实测过）：
1. **贴住出口**：一跳资金页就必须先过它 ⇒ 不会"跳了又拦"✗；
2. **不往前挪**：`:1695` 到 `:1797` 之间那些"更早的出口"会连带罩住幂等/重复提交/刷新/资金页动作 ✗（①刀那 6～13 条红就是挪早了）；
3. **仍放在 `:1794` 的 lookup 之后**（Lead 明令）：新判据**不需要** `submitView`，所以**不会**增加任何飞书读；
   放在它后面只是**不挪动既有语句**、把 diff 压到最小、贴住那一个出口 ✓（**少一次读**这条仍成立：判定本身一次表都不读）。

### 1.1 `⑨` 判据现在在哪一行

- `server/test/scanPageWrite.test.js:864-910`（用例名 `⑨ 【迁移·甲】没填实收 ⇒ 拦住 + 必填人话（醒目）…`）
  - `:890-899` = ①刀写的「改前逐字 / 改后逐字 / 依据」注释（**原文留着**，本刀把两边对调并补依据 ✓）
  - **`:900` = 现在钉的现状**：`assert.equal(response.status, 200, '现状（判定未上线）⇒ 放行到资金页');`
  - `:901-907` = 现状那一组（成功页 / 单子真建出来 / 实收留空 / 跳过不写收款）
- **本刀的恢复** = 把 `:900` 改回 `assert.equal(response.status, 400, '缺尺码或金额 ⇒ 拦住（不跳资金页）')`
  ＋ 断言「人话『请先填尺码和实收金额』」（落在货品页 HTML 里）
  ＋ 断言「零写入」（四张表全 0）；**`⑨` 这条用例不许删 / 不许 skip** ✗。

---

## 2. 哪些请求会进判定（真值表）

判定的**入口条件**（三条同时成立才判 —— 与第一版一致 ✓）：
```
① action === writeConfig.actions.submitOrder            （资金页两颗是 payAction / skipAction ⇒ 天然分开 ✓）
② 这一发【不带收款字段】：SCAN_WRITE.fields.paymentMethod / paymentAmount / lineAmount 都不在 body ✓
③ 会话标记 paymentStep !== 'pending'                     （连点第二次 / 刷新 与 ⑨ 同形 ⇒ 只能靠它 ✓）
```
**判定本体（新口径）**：
```
hasSize  = 「要尺码的那一行」有尺码：body[size] 非空 ‖ 会话草稿行里有 size（`scanWriteService.js:549` 写的那一栏）
hasMoney = 「她填的金额」有值：lineAmounts（`:1711-1718`）任一非空
缺任一 ⇒ 400 + 停在货品页 + 人话 + 零写入；两个都有 ⇒ 放行到资金页
```

| 形状 | 例子（`file:line`） | 进判定？ | 新口径下的期望 |
|---|---|---|---|
| ⑨ 该拦（**缺金额**） | `test/scanPageWrite.test.js:882-889`（只带 `action`/`submit_key`/`payment_status`；草稿行 `amount:''`，`:869-871`） | **进** ✓ | **400 + 人话 + 零写入**（本刀要恢复的） |
| 幂等连点 | `test/scanSaleE2E.test.js:652-653`（带收款字段 ⇒ 入口条件②不成立）+ 草稿行 `size:'40'` | 不进 ✓ | 200 资金页（**不许拦**） |
| 重复提交文案 | `test/scanSaleE2E.test.js:1128-1131`（带 `line_amount:['280']`） | 不进 ✓ | 200（**不许拦**） |
| ⑧ 多行（本次不带 size/金额） | `test/scanPageWrite.test.js:738`（`addLine(… size:'40', amount:'100' …)`）⇒ 提交 `:779` | **进** ✓ | **200 资金页**（尺码/金额都在**会话草稿行**里 ⇒ 必须从草稿行取 ✓） |
| **AC-E2E-16 step1（缺金额）** | `test/scanSaleE2E.test.js:1173-1177`（**不带**收款字段 ⇒ **进**；草稿行只加了尺码、**没加金额**） | **进** ✓ | ⭐ **改成 400 + 人话 + 零写入**（Lead 点名迁移 ✓ 见 §5.2，**有一个连带后果要看**） |
| 裸提交（缺尺码+金额） | `test/scanSalePayFront.test.js:130/139/147`（`{action: submitOrder}` 裸体 ＋ 桩 sessions `{sale:{lines:[]}}`） | **进** ✓ | ⭐ **会被拦** ⇒ 这 5 条 AC-PF 要**补环境**（§5.2） |
| 只带尺码（缺金额） | `test/scanPaymentStepStale.test.js:164-172`（`{action, size:'41'}`） | **进** ✓ | ⭐ **会被拦** ⇒ AC-SM8/9/11 要**补环境**（§5.2） |
| 资金页收款/跳过 | `routes/scanPage.js:1250`（`payAction`）/ `:1533`（`skipAction`） | 不进 ✓ | 照旧 |
| 刷新 | `GET`（`:1249` 认标记那条路） | 不进（不是 POST）✓ | 照旧资金页 |

---

## 3. 判定的两个输入（**全部只读** ✓，一行新的写都没有；**一次飞书读都没有** ✓）

| 输入 | 真源 | 说明 |
|---|---|---|
| **尺码** | `body[fields.size]`（`config/scanWrite.js:147`）＋ 草稿行的 `size`（`scanWriteService.js:549` 写入） | 多行时本次 body **不带** size ⇒ 必须看草稿行（用例 ⑧ `:738/:779` 就是这种）；⚠️ **配品行没有尺码**（`config/sellableKinds` 的 `requiresSize=false`）⇒ 见 §6「一处待确认」 |
| **金额（她填的）** | `lineAmounts`（`:1711-1718`）任一非空 | 与 `submitPending.lineAmounts` **同一份**（**不许另算一份** ✗） |

### 🔴 明确**不做**（按她「不用做那个为空去单价的功能了」）

- ✗ 不读 `submitView?.price_text`（第一版的「单价②」）；
- ✗ 不按草稿行 `number` 走 `service.lookup`（第一版的「多行单价」）；
- ✗ 不读「其他配品.单价」、不调 `gateway.get('accessory', …)`（第一版的「单价③」）。
  ⇒ 这三条**从计划里删掉** ✓（新判据一次表都不读 ⇒ 提交这一步**不会因为判定而变慢**）。

---

## 4. ⚠️ 第一版那处歧义：**已被她 2026-10-16 的口径裁掉**（留痕，不再需要你裁）

第一版我请你裁「这两个都取不到」指哪两个（A = 单价的两个来源 / B = 尺码＋单价），并推荐 A。
**她当天晚些的口径把整件事变简单了**：「用户必须填**尺码和金额**，只有…才可以跳转；**不用做那个为空去单价的功能了**」
⇒ **等价于把第一版的 B（尺码＋金额）直接拍成规则，并且把"单价"整个删掉** ✓
⇒ 只留一句留痕：**原 A/B 之争作废**；本刀按「**尺码 且 金额**，缺任一 ⇒ 拦」执行 ✓（不再有需要你裁的歧义）。

---

## 5. 判据草案（每条**能真红** ✓；变异法写在括号里）

### 5.1 新判据（建议落 `server/test/scanJumpGate.test.js`，新建）

- **AC-J1 ⭐ 缺金额 ⇒ 拦**：只在 body 给尺码（或草稿行只有尺码）、一分钱都没填 ⇒
  **400 ＋ 停在货品页（HTML **不含** `data-view="payment-step"`）＋ 人话「请先填尺码和实收金额」＋ 零写入**。
  （变异：删掉判定块 ⇒ 红。）
- **AC-J2 ⭐ 缺尺码 ⇒ 拦**：金额填了但**一条尺码都没有**（body 不带 size 且草稿行没 size）⇒ 同上。
  （变异：只判金额 ⇒ 红。）
- **AC-J3 ⭐ 两个都有 ⇒ 放行**：`size` + `lineAmounts` 都有（body 直给，或**都在草稿行里**）⇒ **200 资金页**。
  （变异：把判定写成"恒拦" ⇒ 红。）
- **AC-J4 ⭐ 多行/会话来源**：本次 body **不带** size/金额，但草稿行有 `size:'40'`、`amount:'100'`（= 用例 ⑧ 的形状）⇒ **200 资金页**。
  （变异：只读 body 不看草稿行 ⇒ 红 —— 这条钉住"会话"来源是必需的真源。）
- **AC-J5 零写入**：被拦那一下 `salesEntry / salesDetail / paymentRecord / inventoryLedger` 全 0（四张表）。
- **AC-J6 判据一次表都不读**：假网关**没有** `get`/`listAll` 调用记录（只读 `sessions.get` 那一层）——
  钉住"少一次飞书读"这条 ✓（变异：加回 `service.lookup` ⇒ 红）。
- **AC-J7 ⭐ 反向哨兵（不许拦）**：幂等连点（AC-E2E-6）/ 重复提交（AC-E2E-15）/ 刷新（AC-SM8/9）/ 资金页动作（`payAction`/`skipAction`）⇒ **一律不是 400**。
  （变异：把入口条件里的"不带收款字段"或 `paymentStep` 去掉 ⇒ 红。）
- **两侧不回归**（任务书点名）：**提交支** = 钱真落库（实收/收款有值、240 不丢）＋ 状态**不是**「待补充」；
  **跳过支** = 状态**是**「待补充」＋ 三处文案（跳过按钮 / `workbenchHint` / `payPendingNote`）**都在** ✗ 不许删。

### 5.2 ⭐ 既有用例**逐条迁移**（每条都要写「改前逐字 → 改后逐字 → 依据」✓ 不许放宽 ✗）

| # | 去处 | 改前逐字（现状） | 改后逐字（建议） | 依据 / 说明 |
|---|---|---|---|---|
| 1 | `test/scanPageWrite.test.js:900`（`⑨`） | `assert.equal(response.status, 200, '现状（判定未上线）⇒ 放行到资金页');` | `assert.equal(response.status, 400, '缺尺码或金额 ⇒ 拦住（不跳资金页）');` ＋ 人话断言 ＋ 零写入 | 她 2026-10-16 原话 ＋ Lead 裁决（**判据加强**，不是放宽） |
| 2 | `test/scanSaleE2E.test.js:1176-1177`（AC-E2E-16 step1） | `assert.equal(step1.status, 200, '第一步：到资金页');` ＋ `assert.ok(…includes('data-view="payment-step"'), '第一步：是资金页');` | `assert.equal(step1.status, 400, '第一步：缺金额 ⇒ 拦住（不跳资金页）');` ＋ `assert.equal(…includes('data-view="payment-step"'), false, '第一步：不许是资金页');` ＋ 零写入 | ⚠️ **连带后果见下面「§5.3」** |
| 3 | `test/scanPaymentStepStale.test.js:164-172`（`submitOrder` helper，5 处用） | `body: { action, [fields.size]: '41', ...extra }`（**没有金额**） | **补环境**：helper 里加 `[SCAN_WRITE.fields.amount]: '399'`（断言**逐字不动**） | 本文件断的是"提交那一步写 `paymentStep/status`""刷新仍是资金页"，与"她填了多少钱"无关；真机提交**必然带金额**（她当天口径）⇒ 补上她本来就会填的金额 = **补环境**（与本文件先前补 `requestId` 同一手法）✓ |
| 4 | `test/scanSalePayFront.test.js:130/139/147`（AC-PF1…PF5 的裸提交，5 处） | `post(base, path, { action: SCAN_WRITE.actions.submitOrder })`（裸体 ⇒ 缺尺码和金额） | **补环境**：这些 `post` 带上 `size` + `amount`（断言**逐字不动**） | 同上：本文件主题是"**什么时候才写库**"，与"能不能跳转"无关；真机提交必然带尺码+金额 ✓ |

⚠️ 迁移时**只动请求/夹具，不动断言语义**；凡是"确实要改期望"的（#1 / #2）都要按上面那三行写清依据 ✓。

### 5.3 ⚠️ AC-E2E-16 的**连带后果**（我按你字面执行，但请你扫一眼这个选择）

`AC-E2E-16` 的主题是**后面那一段**（点资金页按钮 ⇒ 金额不齐 ⇒ 400 + 差额人话挂最上面）；它的 step1 只是**走到资金页的路**。
- 若按你字面把 step1 改成 **400** ⇒ 后面那一段得**另找一条路**到资金页。最省事的做法是**直接发 `payAction`**
  —— ⚠️ 但那会把「**被拦时 `:1730` 仍写了 `paymentStep:'pending'`**」这条**隐式依赖**钉进用例
  （一旦实现改成"通过才写标记"，这条就红 ✗）。
- **我的建议（方案 i）**：#2 那一格**不改成 400**，而是给 AC-E2E-16 的 step1 **补上她填的实收金额**
  （`line_amount: ['150']`）⇒ 它继续走到资金页、差额那一段**原样** ✓；
  "**缺金额 ⇒ 400**"这条由 **§5.1 的 AC-J1 / `⑨` 恢复** 两条新判据钉住（强度**不丢**，且各自更专一）。
- 两条路你挑一个（**A = 按你字面改 step1 为 400** / **B = 我的方案 i**）；我倾向 **B**，但**你不回我就按 A 执行**（你的字面）。

---

## 6. 动手时的护栏（我核到的，都会让 CI 真红）

1. 🔴 **新文案不许出现「成交金额」/「交易方式」**：`test/scanSaleTwoLayerMoney.test.js:300`（页面 HTML 不许有「成交金额」）＋ `:1275`（旧列名字面量清单）。
   ⚠️ #659 就是**栽在这**（`jumpNeedsAmountBody` 里写了「成交金额」⇒ CI 红 ✗ 见 `docs/ci-two-real-findings-2026-10-16.md` ①）
   ⇒ 新文案写成「**请先填尺码和实收金额**」这类**不含旧列名**的话 ✓，且**走 `config/scanWrite.js`**（配置先行 ✓）。
2. 🔴 **`services/scanWriteService.js` 一个字不加**（余量 0 行 ✗）—— 所有新逻辑落在路由 + 配置 + 测试。
3. 🔴 **不新开鉴权 / 不新开写入口**：判定**只读**（只读 `sessions.get` 那一层；**不再有任何表读** ✓）。
4. 🔴 **老那层 400（`:1771-1783`）行为逐字不变**；新判定**独立成一块**（不塞进那个 `if` 里 ✗）。
5. 🔴 **修复清单纪律**（任务书）：动手前写清单，**每次 `git checkout --` 之后先核清单还在不在**（今晚就是这里丢过"拆包"）。

### ⚠️ 一处**待你确认**（1 行之差，不阻塞其它部分）

她这次说的是「**用户必须填尺码和金额**」—— 但**配品行天生没有尺码**（`config/sellableKinds.requiresSize=false`）。
若严格按"尺码必须有"，**只有配品的本单将永远跳不了资金页** ✗。
- **我的建议**：尺码那一项**只对"需要尺码的行"判** —— `本单里存在 requiresSize 的行 ? 必须有尺码 : 尺码这一项不适用`；
  金额仍然必填（配品也有「实收金额」框 ✓）。
- 请回一句确认（或你给别的口径）；**不回我就按建议实现**（并在 PR 里显著标注这条取舍与她的原话）。

### 修复清单（照抄）

```
1) routes/scanPage.js：:1797 之后、:1808 之前插入「跳转前置判定」（只读：尺码 + 她填的金额；缺任一 ⇒ 人话页 + 零写入）
2) test/scanPageWrite.test.js：:900 起把「钉现状」逐字改回 400 + 人话 + 零写入（注释两边对调 + 补依据）
3) 新增 test/scanJumpGate.test.js：AC-J1…AC-J7（每条能真红）
4) 迁移既有用例：#3 scanPaymentStepStale helper 补金额 · #4 scanSalePayFront 5 处补尺码+金额 ·
   （#2 AC-E2E-16 step1 按 §5.3 的 A/B 二选一）
```

---

## 7. 夹具核查与"会被拦"的盘点（只读结论）

- ✅ `test/scanPageWrite.test.js:244` 用的是**真的** `createScanSessionService`（`services/scanSessionService.js:103` 有 `get`）
  ⇒ **`sessions.get` 存在**，任务书里"夹具可能只实现 `saveDraftLines`、没实现 `get`"这条**在本文件不成立** ✓
  ⇒ 所以 `⑨` 恢复 400 时，守卫看到的是**真实会话**（草稿行 `size:40`、`amount:''`）✓
- ⭐ **全仓 POST `submitOrder` 的盘点（只读扫的，21 处）**，按新口径分类：
  - **不进判定**（带 `payment_method`/`payment_amount`/`line_amount`）：`scanSaleE2E.test.js:651/979/1039/1129/1174`、`salesAsyncWrite.test.js:387-388`、`scanSaleE2E.test.js:2136` ✓
  - **进判定且有尺码+金额 ⇒ 放行**：`scanPageWrite.test.js:738`（⑧：草稿行 `size+amount`，提交在 `:779`）· `scanPageWrite.test.js:1223`（迁移·甲：草稿行 `amount:'399'`）
  - **进判定且缺尺码或金额 ⇒ 本次要迁移**：`scanPageWrite.test.js:882`（⑨，**故意**改 400 ✓）·
    `scanSaleE2E.test.js:1174`（AC-E2E-16 step1 ⇒ §5.3 的 A/B）· `scanSalePayFront.test.js:130/139/147`（补环境）·
    `scanPaymentStepStale.test.js:165/170`（helper，补环境；`:403/423/483` 是用同一 helper 的调用点）
  - **不受影响**：`scanPageWrite.test.js:720`（白名单外 403 = 鉴权闸门先拦 ✓）· `:1216`（HTML 字符串断言，不是请求 ✓）
- ⚠️ 用 `sessions` **桩**、且可能进判定的文件（实现时逐个核）：`test/scanSalePayFront.test.js:44` ·
  `test/scanPaymentStepStale.test.js`（`fakeWriteService`）· `test/scanNumberFallback.test.js:141` ·
  `test/scanPageDraftBar.test.js:397` · `test/scanPrintFeedback.test.js:240` · `test/scanPurchaseAmountRequired.test.js:115` ·
  `test/scanRecordIdRoute.test.js:133` · `test/scanReturnSizeList.test.js:93` · `test/scanReturnStockFilter.test.js:71`
  （后几个是补货/退货/领域用例 ⇒ 多半不 POST `submitOrder`，但**别假设**）。

---

## 8. 验收与收尾（task-53）

```
cd server
node --test --test-concurrency=1 --test-force-exit $(find test -name '*.js' | grep -v scanMoneyPageTwoStepVerify.test.js)
```
- **两遍 EXIT=0 ×2**（两遍之间**一个字都不改**；那条真表 E2E 按既有口径排除 —— 它缺 `FEISHU_V1_E2E_TEST_APP_TOKEN` 时本来就 skip ⇒ 与 CI 一致 ✓）
- 关键文件先单跑：`scanPageWrite` · `scanSaleE2E` · `scanPaymentStepStale` · **`scanSalePayFront`**（＋新的 `scanJumpGate`）
- **变异真红**：AC-J1（删判定）/ AC-J2（只判金额）/ AC-J4（只读 body 不看草稿行）/ AC-J7（去掉入口条件）各做一次"能真红"演示，还原后**字节一致**
- 新 worktree（base = 动手时的 `origin/main`）· push → PR（PR 里写"⑨ 逐字改回"＋"新判定落点 `:1797→:1808`"＋"迁移 4 处逐字对照"＋两遍数字）· **回报 Lead，不合并** ✓
- 🔴 严禁部署 · 生产 Base 只读 · 严禁飞书 CLI · 不许 `--admin` · 汇报用上海时间
