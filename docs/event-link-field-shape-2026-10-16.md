# 关联字段（link）事件形状 · 实测留档（2026-10-16）

> **来源**：task-45 —— 补 `task-40`（PR #636，已合并 ✓）里那条**如实说明 + 建议**：
> 修配品事故时要求"**先在测试 Base 造一条关联字段事件、打印真实 `after_value`**"，
> 当时**没做成**（`ws-*` 脚本属 task-38 写作用域 ✗）。task-38 收工后补这一刀。
>
> 🔴 **本刀的结论（先看这里）**：**关联字段的"写入形状"与"记录 API 读回形状"都实测到了 ✓**；
> 但**"事件里的 `after_value` 形状"这一次仍然没取到** ✗ ——
> 卡在**外部权限**：测试应用调「订阅该 Base 变更事件」接口被飞书**403 / code=1069603 forbidden**。
> ⇒ **不是代码问题，也不是我们漏了步骤**；解除办法见第 5 节（需要她/开发者后台做一次权限动作）。

## 1. 一句话结论

| # | 形状 | 状态 | 证据 |
|---|---|---|---|
| ① | **我们写进去**：`{ "名称": ["recvvWLQZDsOQ8"] }`（关联字段写值 = **纯 record_id 数组**） | ✅ **实测** | §2 第 1 步的 `raw` 回执 |
| ② | **记录 API 读回来**：`[{"record_ids":["recvvWLQZDsOQ8"],"table_id":"tblnJsLDeHXVxJls","text":"39元腰带","text_arr":["39元腰带"],"type":"text"}]` | ✅ **实测**（**五个键**，与她那条生产记录**逐字同形** ✓） | §2 第 2 步的 `READBACK` |
| ③ | **事件 `after_value` 里长什么样** | ❌ **未取得**（外部权限阻塞，见 §5） | §2 第 3 步 403 |

⭐ 关键含义：**候选形状①（`[{record_ids:[…]}]`）在"记录 API"这条路径上是【真的】**——因为它就是实测值；
而**"事件"这条路径**（也就是配品事故真正走的那条）**仍未取得真机原文** ⇒ 事故机制（事件只带 `text`）
**仍然是"唯一可解释的假设"，没有被真机事件证实**。

## 2. 实测过程（可复现，命令逐字）

工具：`server/scripts/ws-link-field-probe.cjs`（**一次性探针**，本 PR 新增；不做业务逻辑，只造事件 + 打印）。
它沿用既有 `ws-*` 脚本的三道闸门：只认**测试应用**凭证（`LARK_TEST_APP_ID/SECRET`，不回退 `LARK_AGENT_*`）、
命中「禁止写入清单」直接拒、**不打印 secret**；本机 `LARK_TEST_APP_ID == LARK_AGENT_APP_ID`（都是**测试应用**，
AGENTS.md 第 8 条的已知现状）⇒ 沿用 `ws-listen.mjs` 的同名逃生阀 `WS_PROBE_ALLOW_SAME_APP=true`。

```bash
cd <worktree>/server
# ① 造一条**带关联字段**的记录（写入形状）
ACCESSORY_SALE_INTAKE_TABLE_ID=tblKt335Bc9OWk2h WS_PROBE_ALLOW_SAME_APP=true \
  node scripts/ws-link-field-probe.cjs --seconds 35
```

**现场输出（原样，只省掉无关行）**：

```
应用：测试应用 app_id=cli_aa3341b397389cd4（secret 不打印）
Base：GqMMbh…（本机 == FEISHU_V1_E2E_TEST_APP_TOKEN: true）
表：配品销售=tblKt335Bc9OWk2h · 其他配品=tblnJsLDeHXVxJls
关联目标：「其他配品」record_id=recvvWLQZDsOQ8 名称="39元腰带"
订阅失败（继续尝试收事件）：Request failed with status code 403
✅ 长连接已建立 ⇒ 3s 后写探针记录
PROBE_RECORD_CREATED reczz28Nk9AttKca
  raw={"code":0,"data":{"record":{"fields":{"名称":["recvvWLQZDsOQ8"],"数量":1,"金额":1},
        "id":"reczz28Nk9AttKca","record_id":"reczz28Nk9AttKca"}},"msg":"success"}
TIMEOUT 35s 内没收到事件
```

⇒ **写入形状 = `{"名称":["rec…"]}`**（纯 id 数组）✓；探针记录 = `reczz28Nk9AttKca`（测试 Base，**不用删** ✓）。

（顺带一条**安全证据**：第一次跑时 `配品销售` 的表 id 用了配置默认值 —— 那是**生产**表 id
`tblkT1QTUsESnl5b`，飞书直接回 **`TableIdNotFound`**。这正好是 AGENTS.md 第 8 条那句话的现场版：
**本机物理上够不着生产表** ✓。测试 Base 里那张同名表是 `tblKt335Bc9OWk2h`「配品销售（E2E 测试表）」，
用 `ACCESSORY_SALE_INTAKE_TABLE_ID` 指过去即可 ✓。）

```bash
# ② 把刚写进去的那条**读回来**（记录 API 形状）
node -e '… appTableRecord.list({table_id:"tblKt335Bc9OWk2h"}) …'
```

**现场输出**：

```
READBACK {"record_id":"reczz28Nk9AttKca","名称":[{"record_ids":["recvvWLQZDsOQ8"],
  "table_id":"tblnJsLDeHXVxJls","text":"39元腰带","text_arr":["39元腰带"],"type":"text"}],
  "数量":"1","金额":"1"}
```

⭐ 与她那条**生产**记录（`reczz28NjOq89MFw`）的形状**逐字同形**（同样的五个键、同样的 `text_arr`、同样的 `type:"text"`）✓。

```bash
# ③ 订阅该 Base 的变更事件（想拿事件里的 after_value —— 这一步被 403 挡住）
node -e '… client.drive.v1.file.subscribe({file_token: appToken, file_type:"bitable"}) …'
```

**现场输出**：

```
SUBSCRIBE 403 body: {"code":1069603,"msg":"forbidden","error":{"log_id":"202610152356389CEE2D23B8220105215D",…}}
```

⇒ 长连接本身**建立成功**（`event-dispatch is ready` ✓），但**没订阅上这张 Base** ⇒ 飞书**一条事件都不推** ⇒
`TIMEOUT 35s 内没收到事件`（与 `ws-subscribe.cjs` 文件头那句"没订阅这一步，一条事件都收不到"完全一致 ✓）。

## 3. 与 #636（task-40）三种候选形状的**逐条对照**

#636 的 `linkIdsOf` 现在覆盖（判据：**只认字符串 + 只从 `record_ids`/`link_record_ids`/`record_id` 取**，
坏值（对象被 `String()`、带空格/方括号/引号）一律不当 id ✗）：

| # | #636 的候选形状 | 本次实测结论 | 说明 |
|---|---|---|---|
| ① | `[{ record_ids: ["rec…"] }]` | ✅ **真**（**记录 API 路径**实测） | 与生产记录同形；`linkIdsOf` **覆盖** ✓ |
| ② | `["rec…"]`（纯 id 数组） | ✅ **真**（**写入路径**实测 —— 我们就是这样写的） | 事件里是否也这样推，**未证实**；`linkIdsOf` **覆盖** ✓ |
| ③ | `{ record_ids: […] }` / `{ text: "…" }`（单个对象） | ⚠️ **只是可能** | 本次**没有**任何实测证据出现过这个形状；`linkIdsOf` 覆盖 `record_ids` ✓、`text` 走 `linkTextsOf` ✓ |
| ④ | `"rec…"`（裸字符串） | ⚠️ **只是可能** | 同上，未实测；`linkIdsOf` **覆盖** ✓ |
| ⑤ | 🔴 **事件里只带 `text`、不带 `record_ids`**（= 事故机制假设） | ❌ **未证实**（事件没取到） | 若成立 ⇒ `record_ids` 取不到 ⇒ 走**「名称」文本兜底**（`resolveAccessory`）✅ —— 这正是 #636 加的兜底 |

⇒ **没有发现"#636 覆盖不到的形状"**（本次实测到的两种都在覆盖内 ✓）；
⇒ 但**事故的确切机制（事件是否真缺 `record_ids`）依然没有被证实** —— 见 §5 的补刀办法。

## 4. 与 #636 新逻辑的对应（一眼看懂哪一段管哪一形状）

| 形状 | 谁处理 | 位置 | 行为 |
|---|---|---|---|
| `[{record_ids:[…]}]`（①） | `linkIdsOf` 的 `visit(对象)` | `services/accessorySaleIntakeService.js` 的 `linkIdsOf` | 取出 id ⇒ 交 `resolveAccessory` |
| `["rec…"]`（②） | `linkIdsOf` 的 `Array.isArray(item)` 分支 | 同上 | 同上 |
| `{record_ids:[…]}` / `"rec…"`（③④） | `linkIdsOf` 的对象/字符串分支 | 同上 | 同上 |
| 只有 `[{text:'…'}]`（⑤） | `linkTextsOf` →「名称」文本兜底 | `linkTextsOf` + `resolveAccessory` | **唯一命中才用** ✓ / 多条 ⇒ 拒单 ✗ / 0 条 ⇒ 拒单 ✓ |
| **任何**形状 | **`gateway.get('accessory', id)` 核实存在** | `resolveAccessory` 第 ① 步 | 查不到 ⇒ 不拿它顶包，转文本兜底 ✓ |

⭐ 一句话：**`linkIdsOf` 负责"从形状里取 id"，`resolveAccessory` 负责"取到的 id 必须真的存在"**——
所以即便真实事件形状是本次没测到的那一种，行为也不会错（最坏情况走文本兜底/如实拒单，**绝不猜** ✓）。

## 5. 未达成项与**解除办法**（需要她/开发者后台做一次动作）

- **阻塞**：`drive.v1.file.subscribe` 返回 **403 / code=1069603 forbidden**。
  ⚠️ 应用**能读写这个 Base 的记录**（探针记录就写成了 ✓），所以**不是 Base 访问权的问题**，
  而是**"订阅文件事件"这项能力/权限**没开。
- **需要做的动作**（二选一或都做，**都在开发者后台 / Base 权限侧，agent 本机做不了**）：
  1. 给**测试应用**（`cli_aa3341b397389cd4`）开通 **`docs:event:subscribe`**（或 `drive:drive`）权限并**发布版本**；
  2. 把她那份**测试 Base** 的**协作者**里加上这个应用（可管理/可阅读即可，用于"订阅该文件"）。
- **解除后的补刀（一条命令）**：
  ```bash
  cd <worktree>/server && WS_PROBE_ALLOW_SAME_APP=true node scripts/ws-link-field-probe.cjs --seconds 45
  ```
  预期：`📥 收到事件 drive.file.bitable_record_changed_v1` + 一行 **`AFTER_VALUE_RAW {…}`（完整 JSON）**，
  同时落盘 `/tmp/ws-link-field-probe-event.json`。拿到之后，本文件 §3 的 ⑤ 就能**从"假设"升级成"实锤/推翻"**。
- ⚠️ 在拿到之前，**不要**因为"形状可能不对"去改代码 —— #636 的兜底已经把正确性守住了 ✓。

## 6. 红线与验收对照

| AC | 结论 |
|---|---|
| **AC-EV1**（测试 Base 真的造出并读到一条**关联字段**记录 + 原文留档） | ⚠️ **部分达成**：造出来了 ✓（`reczz28Nk9AttKca`，写入形状 + 记录 API 读回形状**都留档** ✓）；**事件 `after_value` 未取得** ✗（403，见 §5） |
| **AC-EV2**（与 #636 三种形状逐条对照） | ✅ §3 逐条（覆盖/未覆盖、真/只可能，全部标注） |
| **AC-EV3**（生产零写入 · 严禁飞书 CLI · 不改业务代码） | ✅ 全程只碰**测试 Base**（`FEISHU_V1_BITABLE_APP_TOKEN == FEISHU_V1_E2E_TEST_APP_TOKEN` ✓，且生产表 id 直接 `TableIdNotFound` ⇒ 够不着）；**未用**飞书 CLI（只用 SDK + 项目代码）；**`server/src/**` 零改动** ✓ |
| **AC-EV4**（两遍全量 EXIT=0 ×2 · CI 四件全绿） | 见 PR |

## 7. 本次落盘/新增的文件

| 文件 | 说明 |
|---|---|
| `docs/event-link-field-shape-2026-10-16.md` | 本文 |
| `server/scripts/ws-link-field-probe.cjs` | **一次性探针**（造关联字段记录 + 抓事件原文）。**保留**：§5 解除权限后**一条命令**即可复用，不改它 ✓ |
