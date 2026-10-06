# 交接笔记归档（原各 worktree 根目录的未跟踪 `.HANDOFF-*.md`）

> **归档日期**：2026-10-06（清理任务当天）。
> **原文时间**：全部写于 **2026-10-05**（17:35–22:11，+8）。
> **来源**：7 个独立 worktree 根目录下的**未跟踪**文件（`.HANDOFF-*.md`），**从未提交过**。
> **缘起**：业务负责人批准「把**有价值的交接笔记**收进 `docs/`、其余的连同 worktree 一起清掉」，
> 随后明确要求「GitHub 上除 main 以外的分支 + 本地残留 worktree 全清干净」。

## 这批文件是什么

2026-10-05 多代理并行期间，**父代理写给子代理的"裁决 / 纠正 / 叫停"便条**——当时刻意不提交
（便条里写着「这份文件不要提交」），放在 worktree 根目录当**临时信道**用。它们记录的是
**当天的口径与裁决过程**：谁下了什么结论、为什么、以及几处**父代理自己犯的错**。

## ⚠️ 使用前必读

- 这批文件是**历史记录，不是当前口径**。当前口径以 [AGENTS.md](../../AGENTS.md) 与
  [docs/README.md](../README.md) 第 1 节为准。
- 同一话题**可能前后矛盾**（例如 `as-money` 三份、`discount` 两份）：**以时间最新的那份为准**，
  文件表已按时间排序；正文里的「以这份为最新指令」字样是当时的先后标记。
- 正文**一字未改**，只在每份文件顶部加了一段归档说明。
- 含**表 ID**（`tbl…`）等配置标识，**不含任何 token / secret**（收录前已扫过）。

## 清单（按原文时间排序）

| 归档文件 | 原 worktree | 时间（+8） | 内容概要 |
|---|---|---|---|
| [after-sales__父代理裁决.md](after-sales__父代理裁决.md) | `/private/tmp/after-sales` | 10-05 17:35 | 售后执行器裁决：库存 3 条行为声明怎么加、**幂等不要加表列**、「客户往来货款」表字段与 `业务事件ID` 幂等键、「客户」字段先留空；并留档**父代理用"文件 3 分钟没动"误判子代理已停、替它提交了两次**这次事故 |
| [arrival-card__业务负责人补充.md](arrival-card__业务负责人补充.md) | `/private/tmp/arrival-card` | 10-05 18:05 | 结果卡片文案定稿（她选的 A：「**正在入库，如有新品，稍后把链接给你**」）+ 建档顺序（发卡片前**不**建档 → 发完后后台建档 → 点确认后给链接）+ 卡片标注与后台建档必须一致、点取消不撤销建档 |
| [as-money__业务负责人纠正.md](as-money__业务负责人纠正.md) | `/private/tmp/as-money` | 10-05 18:09 | **不要资金按钮**：她说清了钱怎么走就按她说的；她没说 → **文字追问一句**，不给 `[退现金]/[存为预存额度]` 按钮；删掉"她没说就自动退现金"的默认值 |
| [as-money__父代理答复.md](as-money__父代理答复.md) | `/private/tmp/as-money` | 10-05 18:11 | 批准 `after_sales_asking` + `pending_plan`（10 分钟）方案；**授权窄改入口层**：有未过期待回答计划时「续接优先于其它意图判断」（覆盖判成 `unsupported`/`sale` 两种情况）；列出必须覆盖的 7 条测试 |
| [as-money__父代理叫停兜底.md](as-money__父代理叫停兜底.md) | `/private/tmp/as-money` | 10-05 18:13 | 🔴 **最新指令，推翻前两份**：她每句话都会说清钱怎么走 ⇒「她没说钱」这个场景**不存在** ⇒ **整个兜底/追问/续接链路全部不做**（含不要改 `larkMvpService.js`）；只保留「她说了按她说的」+「删掉静默默认值、解析不出就大声拦住不写」 |
| [purchase-return__父代理裁决.md](purchase-return__父代理裁决.md) | `/private/tmp/purchase-return` | 10-05 20:05 | 采购退货裁决：基线 529 通过；「合计数量」确认已被她删掉；「库存流水」缺「关联单据」字段判断正确；**批准** `applyChange` 改读注册表 `consumes` |
| [purchase-return__父代理裁决2.md](purchase-return__父代理裁决2.md) | `/private/tmp/purchase-return` | 10-05 20:13 | 第二轮：采纳"路线 3"；动作 =「先完成、然后等通知 rebase」；含一条可能影响汇报口径的新情报与硬性纪律重申 |
| [group-purchase__父代理补充.md](group-purchase__父代理补充.md) | `/private/tmp/group-purchase` | 10-05 20:46 | 群聊基础设施优先顺序（她**要先看到发到群里的图**才能测）+ 父代理刚实测出的硬约束 |
| [group-purchase__规格变更-话题.md](group-purchase__规格变更-话题.md) | `/private/tmp/group-purchase` | 10-05 20:57 | 规格变更（以这份为最新）：规则改成两条；**「话题」方案已实测成立 → 优先按话题做**（比"引用"更好）；含 A 的第二处改动 |
| [schema-fix__范围收窄.md](schema-fix__范围收窄.md) | `/private/tmp/schema-fix` | 10-05 21:09 | 范围收窄：**「图片」字段要留着**；澄清后的删改范围（比原任务书窄）+ 生产表真字段清单 |
| [schema-fix__图片字段定位.md](schema-fix__图片字段定位.md) | `/private/tmp/schema-fix` | 10-05 21:13 | 最终澄清：「图片」字段 = **过渡期保留**（她说的话）+ 每删一处要自问的判断标准 |
| [group-purchase__不要改AGENTS.md.md](group-purchase__不要改AGENTS.md.md) | `/private/tmp/group-purchase` | 10-05 21:22 | 🔴 叫停：**《业务规范》不要写进 `AGENTS.md`**（她原话） |
| [schema-fix__找约定-五个材料.md](schema-fix__找约定-五个材料.md) | `/private/tmp/schema-fix` | 10-05 21:28 | 她亲口列的「五个材料」——去哪五处找那段约定（含 3 个 Base 表 ID） |
| [group-purchase__裁决-退货归属.md](group-purchase__裁决-退货归属.md) | `/private/tmp/group-purchase` | 10-05 21:35 | 批准退货归属方案 + 两条硬约束（她的直接指令） |
| [schema-fix__批准解冲突合并.md](schema-fix__批准解冲突合并.md) | `/private/tmp/schema-fix` | 10-05 21:41 | 批准解冲突 + 合并进 main，但 🔴 **绝不部署**（她的直接指令） |
| [schema-fix__裁决-到货退场与退货嫁接.md](schema-fix__裁决-到货退场与退货嫁接.md) | `/private/tmp/schema-fix` | 10-05 21:44 | 三件产品口径裁决：`kind === 'arrival'` **什么都不做**；#83 的采购退货**必须保住**；`test.js`/`index.js` 口径 |
| [discount__父代理补充-打折判据.md](discount__父代理补充-打折判据.md) | `/private/tmp/discount` | 10-05 22:08 | 「打折」判据（她说透之后补充，当时标注"按这份为准"） |
| [discount__撤销打折.md](discount__撤销打折.md) | `/private/tmp/discount` | 10-05 22:11 | 🔴 **最新指令**：「**打折**」是父代理编的概念 —— 代码里没有、也不该有；把上一份的「打折」整段删掉；正确规则**只有两条** + 术语纪律 |

### 另有两份「排查报告」（同为笔记类，一并收录）

| 归档文件 | 原 worktree | 时间（+8） | 内容概要 |
|---|---|---|---|
| [repro__tmp404-FINDING.md](repro__tmp404-FINDING.md) | `/private/tmp/repro`（`server/tmp404/`） | 10-06 00:07 | **采购退货 404 根因复现与定位**：`table_id` 为空 → URL 打成 `tables//records` → 飞书回 404 纯文本；含抓到的真实 URL、涉及的表（「尺码管理」）与排查脚本清单 |
| [wsfix__.dsh-probe-FINDINGS.md](wsfix__.dsh-probe-FINDINGS.md) | `/private/tmp/wsfix`（`.dsh-probe/`） | 10-06 12:23 | **本地长连接 0 事件定位**（测试应用机器人在哪些群、消息权限范围、写权限实测）；全程只用项目代码 / 官方 SDK、只写测试 Base |

> ⚠️ 这两份**各有一处遮蔽**：Base 的 `app_token` 值只留前 8 位 + `…`（原文含完整 token，
> 而 `AGENTS.md` 第 7 条正在治理"不许硬编码 token"）。其余正文一字未改。

## 没有收录的东西（按规则直接丢弃）

各 worktree 里的 **探测脚本**（`probe*.mjs`、`verify-arrive-3.mjs`）、`node_modules/`、
`server/.dsh-probe/` 的脚本、运行期 `data/`、`server/tmp404/` 的脚本等**未跟踪杂物**一律**不收集**
（其中的**报告类 `.md` 已如上单独收录**）。
