# 测试 Base「收款方式管理」补「团购券管理」列 —— 留档（2026-10-16）

> 任务来源：解开券机制（#704 已合）的**真机端到端验收** —— 它卡在**测试 Base 缺这一列** ✗
> 她的规则（逐字）：「**测试 Base …… 可以随便写，不用问她**」✓ ⇒ 测试 Base 就是拿来造的 ✓
> 对应脚本：`server/scripts/add-voucher-column-to-test-base.mjs`（**只从 env 读凭证** ✗ 不硬编码 ✓ · **不用飞书 CLI** ✓ 走官方 SDK）
> ⭐ **本文件 2026-10-16 由接手者更新**：上一刀（`bec93ac`）**建列失败**；本刀**已建成** ✓ 下面是**真跑**的完整证据。

## 0. 结论（一句话）

⭐ **测试 Base 的「收款方式管理」现在有「团购券管理」列了** ✓ —— 名字 / `type=21` / `property` 三项**逐键对齐生产** ✓
（只有 `table_id` / `back_field_id` 两个**每 Base 各自**的 id 不同，这是物理必然 ✓）

## 1. 生产真表那列的属性（**来源**：Lead 侧**只读**核对；本机够不着生产 ✗）

· 名字 `团购券管理` · `type = 21`（双向关联）· 完整 `property`（原样）：

```json
{"back_field_id":"fldC5OAhpK","back_field_name":"券名称","multiple":false,"table_id":"tblz2kM1CIGkcWsM","table_name":"团购券管理"}
```

生产「收款方式管理」`tblH7YzA1v5vJzEi` 共 **4 列**：`收款方式`(1) · `更新时间`(1002) · `创建时间`(1001) · `团购券管理`(21) ✓

- 🔴 **本机 `.env` 按 AGENTS §8 刻意不放生产凭证** ⇒ **生产 Base 在本机物理上够不着** ✓（这正是那条纪律的目的）
- 🔴 **我没有试图获取生产凭证** ✓（红线）

## 2. ⭐ 关键发现：那串 `property` **不能逐字提交**（上一刀失败的根因不止一个）

| # | 坑 | 事实（**本机只读核过** ✓） |
|---|---|---|
| ① | `table_id` / `back_field_id` 是**每个 Base 自己的** id ✗ | 券表：生产 `tblz2kM1CIGkcWsM` ✗ ｜ **测试 `tblF7KD85JHA4hVi`**（`FEISHU_V1_GROUP_BUY_VOUCHER_TABLE_ID` ✓）<br>⭐ `fldC5OAhpK` 在生产是**反向关联字段「券名称」**，在**测试 Base 里却是「券ID」（文本 type=1）** ✗ |
| ② | `back_field_id` / `table_name` 是**响应字段**，**不是** create 的请求参数 ✗ | 官方 `appTableField.create` 的 `property` 只收 **`multiple` / `table_id`（必填）/ `back_field_name`**<br>（核法：`curl` create 文档 ＋「字段编辑指南·双向关联字段」＋ SDK `types/index.d.ts` ✓） |
| ③ | ⭐ **实测**：把 `table_name` 也塞进去 ⇒ **仍回 `1254092`** ✗ | 提交 `{table_id, table_name, back_field_name, multiple}` ⇒ `DuplexLinkFieldPropertyError` ✗<br>**去掉 `table_name`**（只留文档允许的三个键）⇒ **当场建成** ✓ |

⇒ **等价判据（本刀采用）**：建完后回读的 `property` 与生产**逐键对齐**，**只有 `table_id` / `back_field_id` 允许不同** ✓

## 3. 建列**前**的只读回读（项目代码 / SDK，`--check-only` ⇒ **0 写入** ✓）

```
✓ 闸门通过：FEISHU_TARGET_ENV=test · app_token = 授权测试 Base ✓
· 目标表（收款方式管理）tableId = tblNg7yInC6pNLJR
· 关联目标表（团购券管理）tableId = tblF7KD85JHA4hVi · tableName = 团购券管理
· 回读（建之前）：共 3 列；**没有**「团购券管理」✗
```

另：项目自带只读自检 `node scripts/env-selfcheck.mjs` **同一时刻**也报这条红 ✓
（`FEISHU_V1_PAYMENT_METHOD_TABLE_ID → 3 列 · ✗ 缺字段：团购券管理`）

## 4. 建列 —— **成功** ✓（真跑，只写测试 Base）

提交的 `property`（**正好是官方文档允许的三个键**）：

```json
{"table_id":"tblF7KD85JHA4hVi","back_field_name":"券名称","multiple":false}
```

**建之后**回读（项目代码 / SDK，原样）：

```
=== 收款方式管理 · tblNg7yInC6pNLJR · 共 4 列 ===
  收款方式   | id=fldCrMMNRX | type=1    | ui_type=Text         | property=null
  更新时间   | id=fld3FNhrdu | type=1002 | ui_type=ModifiedTime | property={"date_formatter":"yyyy/MM/dd"}
  创建时间   | id=fldQlmbmMs | type=1001 | ui_type=CreatedTime  | property={"date_formatter":"yyyy/MM/dd"}
⭐ 团购券管理 | id=fldQPfi7Qp | type=21   | ui_type=DuplexLink   | property={"back_field_id":"fldt0tJaDS","back_field_name":"券名称","multiple":false,"table_id":"tblF7KD85JHA4hVi","table_name":"团购券管理"}
```

⇒ **列名 ✓ · type 21 ✓ · 4 列清单与生产逐条同名同类型** ✓
（生产：`收款方式`(1) · `更新时间`(1002) · `创建时间`(1001) · `团购券管理`(21) ✓）

**幂等复跑**（建完再跑一次 ⇒ 不重复建、0 写入 ✓）：

```
· 回读（建之前）：共 4 列；已存在「团购券管理」✓
· 已存在 ⇒ **跳过**（幂等 ✓，0 写入）                              [EXIT=0]
```

## 5. property 与生产**逐键**比对（唯一来源：只读回读 ✓）

| property 键 | 生产（Lead 只读核对） | 测试 Base（本机只读回读） | 一致？ |
|---|---|---|---|
| `back_field_name` | `券名称` | `券名称` | ✅ **逐字相同** |
| `multiple` | `false` | `false` | ✅ 相同 |
| `table_name` | `团购券管理` | `团购券管理` | ✅ **逐字相同** |
| `table_id` | `tblz2kM1CIGkcWsM` | `tblF7KD85JHA4hVi` | ⚠️ **必然不同**（每 Base 各自的券表 id） |
| `back_field_id` | `fldC5OAhpK` | `fldt0tJaDS` | ⚠️ **必然不同**（每 Base 各自的反向字段 id） |

⇒ **除两个"每 Base 各自"的 id 外，其余三项逐字一致** ✓ —— 在"表名对齐、`table_id` 天然不同"的既有口径下（`docs/payment-method-voucher-link-2026-10-16.md` 第 4 节 D3），这就是**能做到的最强一致** ✓

## 6. ⚠️ 残留差异（如实，需她/他定；**我没有动** ✗）

测试 Base 的券表原有一列**文本**「券名称」（`fldE95mpEI`，type 1）。Feishu 建反向字段时**新建**了一个
**同名**的 `券名称`（`fldt0tJaDS`，type 21 双向关联）⇒ 券表 **11 → 12 列**，且**有两个同名列**：

```
=== 团购券管理 · tblF7KD85JHA4hVi · 共 12 列 ===
  券名称 | id=fldE95mpEI | type=1  | Text        | property=null                                   ← 原有的文本列（测试 Base 遗留）
  ...
  券名称 | id=fldt0tJaDS | type=21 | DuplexLink  | property={"back_field_id":"fldQPfi7Qp","back_field_name":"团购券管理","multiple":false,"table_id":"tblNg7yInC6pNLJR","table_name":"收款方式管理"}
```

- 生产券表是 **11 列**，`券名称` **只有那一列 type 21**（没有同名文本列）⇒ **测试 Base 比生产多一列** ✗
- ⚠️ **同名两列有静默歧义风险**：代码按**字段名**取值（`voucherSettlementService.js:156` 读 `fields.name = '券名称'`），
  同名列谁生效不确定 ⇒ **建议**：把**遗留的那列文本**改名（非破坏性 ✓）或按她口径删掉（**删列 = 删值、不可恢复** ⚠️ **须她拍板**）
- 🔴 **本刀不删/不改**：任务是"**补列**"✗，动别人的表（删列不可恢复）超出授权 ✗ ⇒ **只如实上报** ✓

## 7. 闸门（防生产）—— **5 条原封不动** ✓（代码行，`server/scripts/add-voucher-column-to-test-base.mjs`）

```js
if (targetEnv !== 'test') fail(...)                      // ① 环境标记必须是 test
if (!testBase) fail(...)                                 // ② 取不到授权测试 Base ⇒ 拒绝
if (appToken !== testBase) fail(...)                     // ③ ⭐ 不等于授权测试 Base ⇒ 拒绝（保守闸门）
if (forbidden.includes(appToken)) fail(...)              // ④ 命中禁写清单（生产）⇒ 拒绝
if (!forbidden.length) say('⚠️ warn：禁写清单空转…')      // ⑤ 没配清单 ⇒ **如实 warn**（不是只写注释 ✓）
```

✅ **本条**：**没有增删改任何一条闸门** ✓（与 `bec93ac` 逐字相同 —— 见 `git diff bec93ac -- server/scripts/…` 的闸门段）
✅ **实测有效**（本刀真跑，两次独立复现 ✓）：

```
① 不带 env 直接跑：✗ FEISHU_TARGET_ENV 必须是 `test`（现在 未设置）—— 拒绝运行   [EXIT=1]
③ app_token 换成别的值：✗ app_token **不等于**授权可写的测试 Base —— 拒绝运行     [EXIT=1]
```

⚠️ 本机 `.env` 没有 `FEISHU_V1_FORBIDDEN_APP_TOKENS`（AGENTS §8 刻意如此）⇒ 第 ④ 条**空转**，
但 第 ③ 条（**必须等于授权测试 Base**）是**实拦** ✓ —— 两道合起来仍拦住"写生产" ✓

## 7b. 🔴 文件名**绝不能**以 `test-` 开头（2026-10-16 **真实 CI 红**，PR #718 第一次跑）

`server/package.json` 的 `test` = **`node --test --test-concurrency=1`（不带路径）** ⇒ Node 的**默认发现规则**
里有一条 **`**\/test-*.?(c|m)js`** ⇒ 上一刀把这个脚本命名成 `test-base-add-voucher-column.mjs`
⇒ **它被当成一个"测试文件"去跑** ✗；而它没有 env 时按**闸门 ① 主动 `exit(1)`** ⇒
CI 逐字报：

```
not ok 1 - /home/runner/work/feishu-retail-ops/feishu-retail-ops/server/scripts/test-base-add-voucher-column.mjs
# tests 2748 · pass 2740 · fail 1 · skipped 7    ⇒ ELIFECYCLE  Test failed（exit 1）
```

⚠️ ⭐ **为什么本地一直没发现**：本仓库跑"两遍全量"用的是**显式文件清单**
（`$(ls test/*.test.js | grep -v scanMoneyPageTwoStepVerify.test.js)`）⇒ **永远扫不到 `scripts/`** ✗；
而 CI 是**裸 `node --test`**（会扫全仓）⇒ 只有 CI 抓得到。

⭐ **处置**：改名为 **`server/scripts/add-voucher-column-to-test-base.mjs`**（**不**以 `test-` 开头 ✓）
⇒ 它不再被当成测试；`server/scripts/` 下**不要再出现 `test-*.mjs`** ✗
⭐ **教训**：本地"全量"命令与 CI 的 `node --test` **形状不同** ⇒ 这一类"被误当测试"的红
**只有 CI 能抓**；本刀之后另跑了一次**CI 同形状**的裸 `node --test` 复验 ✓

## 8. 建完后：项目代码 / SDK **只读**复验 ⇒ 自检转绿 ✓

```
FEISHU_V1_PAYMENT_METHOD_TABLE_ID   tblNg7yInC6pNLJR  收款方式管理  收款方式管理  4   OK ✅  内(计)
共 17 张表：OK 16 · ID 过期/不对 1 · 缺字段 0 · … · 红 0 张 · 退出码 0（全绿）
```
（对比第 3 节：同一脚本建列前是 `3 列 · ✗ 缺字段` ＋ `红 1 张 · 退出码 1` ✓）

## 9. 券的真机 e2e —— **跑了，但没有通过**（如实，**不伪造** ✗）

跑法（走项目代码 / 真测试 Base ✓）：

```bash
cd server && FEISHU_TARGET_ENV=test node --test --test-concurrency=1 --test-force-exit test/scanMoneyPageTwoStepVerify.test.js
```

结果：**EXIT=1 · tests 3 · pass 0 · fail 3** —— 红的是 `V1/V2/V5` · `V3` · `V4`。

⭐ **这 3 条是【既有红】、与本刀无关** —— 依据（**不是我的推断**）：
`docs/orders-read-path-perf-2026-10-16.md` 第 129–132 行逐字：

> 5. **全套里的 3 条红**（`scanMoneyPageTwoStepVerify.test.js` 的 V1/V2/V5 · V3 · V4）
>    是**既有、与本次无关**：它在**改动前的 pristine 代码**上同样红（已实测），
>    形态是"对活体测试 Base 断言零写入，被并发写污染"。

⚠️ 该文件在**全量跑里被既有约定排除**（`docs/async-and-success-page-plan-2026-10-16.md:169` 等 ✓），
CI 里没有测试 Base 凭证 ⇒ **明确 skip**（不是"跑了 0 条 = 绿" ✓）。

**本刀观察到的机理**（与上面"并发写污染"一致 ✓）：销售入账已改**异步**（`scan.sale.background_queued`，
PR #707 起先回 200、后台再写库），而该用例在 HTTP 200 之后**立刻**比对**全表计数** ⇒ 后台那一写还没落库
（实测：② 的数在 `22:47:28` 取、`salesDetail` 那一行 `22:47:38` 才 created）⇒ 必然差 1。
日志里还可见 `resetSessions()` 与后台写抢 `scan_sessions/*.json.tmp` 的 `ENOENT` ✓。

⇒ **"券列建成 ⇒ 这条 e2e 就绿"这个假设不成立** ✗ —— 它卡在**另一条链路（异步入账 vs 同步计数断言）**上。
🔴 **本刀没有去改这条 e2e、也没有改 `src/**`**（各有主 ✗）⇒ **如实标"未通过"** ✓

## 9b. 两遍全量 —— **EXIT=0 ×2** ✓（跑的是 **CI 同形状**那条命令）

```bash
cd server && rm -rf data && FEISHU_V1_E2E_TEST_APP_TOKEN= node --test --test-concurrency=1
```
（⭐ **刻意用裸 `node --test`** —— 与 CI `pnpm test` 逐字同形状，才抓得到第 7b 节那类"被误当测试"的红 ✗；
   `FEISHU_V1_E2E_TEST_APP_TOKEN=` **置空** = 复刻 CI 里"没有测试 Base 凭证"的条件 ⇒ 第 9 节那条真表 e2e **明确 skip**（不进红 ✓））

| 遍 | tests | pass | fail | skipped | EXIT |
|---|---|---|---|---|---|
| A | 2718 | 2711 | **0** | 7 | **0** |
| B | 2718 | 2711 | **0** | 7 | **0** |

两遍**背靠背**跑同一份工作区，并在「第 1 遍前 / 两遍之间 / 第 2 遍后」各取一次
`git diff HEAD | shasum -a 256` ⇒ **三次逐字相同** ✓ ⇒ 自证两遍跑的是**同一份改动**、中间没人动过它 ✓

⚠️ 具体哈希值**刻意不写进本文件** —— 本文件自身也在那份 diff 里，写进去就变成自指（永远对不上 ✗）；
   值的记录见 **PR #718 的正文 / 提交信息**（那里不参与 diff ✓）

⚠️ 本机 2718 ＜ CI 的 2748：CI 的 `pull_request` 检出的**是 merge commit**（本分支 ＋ 当时的 `main`），
比本分支多 30 条 —— 与本刀无关 ✓

## 10. 边界（逐条）

- ✅ **只写测试 Base**（`tblNg7yInC6pNLJR` 新增一列 ＋ Feishu 自动在券表建的反向列）—— **生产一个字未写** ✓（本机也够不着 ✓）
- ✅ **没用飞书 CLI**：建列与回读**全走官方 SDK / 项目代码** ✓
- ✅ **没硬编码 token**：全部从 env 读 ✓（`server/test/scriptProductionGate.test.js` 哨兵 ✓）
- ✅ **没碰 `server/src/**`** ✓ · `scanWriteService.js` 一个字没动 ✓ · **未部署** ✓ · **未合并 PR** ✓
- ✅ **CI 红已修**（第 7b 节）：脚本改名去 `test-` 前缀 ⇒ 不再被 `node --test` 误当测试 ✓
- ⚠️ **未做**：① 券表遗留同名文本列的清理（**等她/他定**，见第 6 节）② `scanMoneyPageTwoStepVerify` 那条既有红（**不归本刀**）
