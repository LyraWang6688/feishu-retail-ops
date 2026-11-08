# 抖音来客 OpenAPI · 落地记录与团购券结算设计（2026-11-08）

> 起因：业务负责人 2026-11-08 让「把之前做的探索沉淀成文档」。
> 本文记录**已经写过的代码**、**真实调通的接口与数据**、**团购券平台结算的设计**，以及**踩过的坑**。
> 适用范围：本仓库 agent 负责的抖音线（经营侧）；内容侧见 `handoff-douyin-content-co-creation.md`。

---

## 0. 一句话结论

- **能读**：来客（生活服务）OpenAPI 已经用真实账号调通**门店 / 验券 / 分账 / 账单 / 提现 / 订单** 六类接口；
- **能用**：客户端（`services/douyin/`）已合并进 main；**但线上还没有任何调用方**；
- **要做**：团购券「待平台结算 → 已收款」的自动到账，判据 = **按日期三方对平（我方 / 平台账单 / 平台提现），一分不差才改**（PR #995，未合并）；
- **不可得**：抖音**不提供银行流水/到账回执**的 OpenAPI。最接近"到账"的是**提现记录**（带结算账户与 `withdraw_time`）。

---

## 1. 落地状态

| 项 | 状态 | 说明 |
|---|---|---|
| 调研文档（路线/入驻/能力面） | ✅ 已合并 main | `douyin-laike-openapi-research-2026-11-08.md` |
| 来客只读客户端（#982） | ✅ 已合并 main | `config/douyinLaike.js` + `services/douyin/*` + 测试 + 2 个日志事件 |
| 无效 JSON 防护（#991） | ⏳ PR 未合并 | main 上仍是旧行为；目前无调用方，故无实际影响 |
| 团购券自动结算（#995） | ⏳ PR 未合并 | 14:00 + 日期对平 + 一分不差；**未部署** |

> ⚠️ 本机禁止配置生产凭证/生产 Base（AGENTS §8）：所有真机验证都在**服务器上**、走项目代码、**只读**完成。

---

## 2. 已实现能力（客户端）

统一入口：`createLaikeClient()`（`services/douyin/laikeClient.js`）。

- **凭证**：`POST /oauth/client_token/`（`client_key + client_secret + grant_type=client_credential`）；
  - TTL 以 `expires_in` 为准、**提前 5 分钟**刷新；失败不缓存；
  - 错误码映射：`10013`（密钥错）、`2190002`（token 无效）、`4000001`（缺 ID）、`2100005`（参数不合法）；
  - 统一返回 `{ ok, data, logId }` 或 `{ ok:false, reason, message, errorCode, logId }`；token/secret **不进日志、不进返回值**。

| 方法 | 接口 | 关键参数 |
|---|---|---|
| `token()` | `POST /oauth/client_token/` | 无 |
| `verifyRecords()` | `GET /goodlife/v1/fulfilment/certificate/verify_record/query/` | `account_id`、`start_time/end_time`（**int 秒**）、`cursor/size` |
| `settleLedger()` | `GET /goodlife/v1/settle/ledger/query_record_by_cert/` | `certificate_ids`（逗号分隔） |
| `settleBill()` | `GET /goodlife/v1/settle/bill/composite_query/` | `account_id`、`bill_date`（**yyyy-MM-dd**）、`cursor/size` |
| `settleWithdraw()` | `GET /goodlife/v1/settle/withdraw/composite_query/` | `account_id`、`start_date/end_date`（yyyy-MM-dd）、`cursor/size` |
| `orderDetail()` | `GET /goodlife/v1/hermes/trade/order/query/` | `account_id` + `order_id` |

> ⛔ 写接口 `batch_verify`（跨订单核验券）**只登记路径、不调用**。

---

## 3. 真机数据（2026-11-08，生产账号，已脱敏）

- **门店**：1 家，`poi_id 7342444319254513674`；
  - 品牌号 `account_id 7365018427183990825`；门店账号 `7407891402098575401`。
- **团购券管理**（表）：2 张券，均「在售」、面值 100、规则列写着 **`核销日+5个自然日`**
  - `抖音代金券（49.9）`：售价 49.9 / 平台结算款 47.4 / **券ID 1874318025951256**
  - `抖音代金券（89.9）`：售价 89.9 / 平台结算款 85.4 / **券ID 1874371212430344**
  - ⭐ 「券ID」与 API 的 `sku_id` **是同一个值**（以后要精确到券时应以它为桥）。
- **验券历史**（近 30 天 3 条，示例）：
  `certificate_id 7694960812306350109` · `100元代金券` · 原价 8990 / 实付 8690 分 · 核销人「管理员」。
- **分账明细**（按券）：`ledger_total 8990`、`goods 8540`、`pay_handling 54`、`total_commission 450`、`status:2`。
- **账单详情**（`bill_date=2026-10-26`）：
  `settle_time 10-26 14:00` → `settlement_time 10-31 07:54`（打款）· `ledger_id LRC…` · `shop_order_id 111568…`。
- **提现记录**（`2026-10-31`）：
  `amount 8540` · **`settle_account 中国农业银行 (5418)`** · `launch_time 10-31 11:40` → `withdraw_time 10-31 12:26`。
- **生产 S交易明细**：44 条（已收款 33 / 未收款 11 / **待平台结算 0**）—— 当前没有可结算样本。

---

## 4. 团购券结算设计（#995，未合并）

### 4.1 业务口径（业务负责人 2026-11-08 逐字）
> 「平台结算规则应该是 5 天。5 天之后，把『待平台结算』改为『已收款』，并且更新一下收款时间，然后在运营群里通知一声」
> 「**按日期匹配**，以日期维度看需要结算多少钱，不需要具体到券码或者单号」
> 「**必须一分不差，差 1 分也不改、只报差异**」

### 4.2 判据（按「创建日」分批，三方金额完全相等）
对每个「创建日 D」（S交易明细 `创建时间`，上海自然日）：

1. **我方**：D 下所有「待平台结算」的 `交易金额` 合计（= 平台结算款，分）；
2. **平台账单**：`bill_date = D` 的 `settleBill()` 里 `amount.goods` 合计（分）；
3. **平台提现**：`withdraw_time` 落在 **D+5** 这一天的 `settleWithdraw()` 里 `amount` 合计（分）；

**三者完全相等（精确到分）** ⇒ 把该批记录改成「已收款」+ 写「收付日」（执行时间）；
**差 1 分** ⇒ 一笔都不改，只在运营群发差异（`我方 ¥X / 账单 ¥Y / 提现 ¥Z`）。

### 4.3 运行方式
- 调度：`startShanghaiDailyScheduler`，**每天 14:00（上海）之后**每次 tick 跑（幂等：结过的不再是待平台结算）；
- 群：`VOUCHER_SETTLEMENT_CHAT_ID` 优先，否则复用 `PURCHASE_CHAT_ID`（即「邯美皮鞋运营群」）；
- 开关/天数/时点/账号全部走配置：`VOUCHER_SETTLEMENT_*` + `DOUYIN_LAIKE_ACCOUNT_ID`；
- 未配账号 ⇒ 只记 `account_missing`、不结；未配群 ⇒ 业务照做、只记 `chat_missing`。

### 4.4 为什么不做"到单号/券码"匹配
账单有 `shop_order_id / ledger_id / verify_id / sku_id`，但 S交易明细**没有存券码/单号**；
按单号匹配需要先在扫码/入账时补字段（改动面更大）。业务负责人明确「按日期维度即可」⇒ 用金额对平。

---

## 5. 踩过的坑（按出现顺序）

| 现象 | 根因 | 处理 |
|---|---|---|
| `10013 client_key 或者client_secret 错误` | `.env` 值带 `< >`（34 位，实际 32 位） | 去掉首尾尖括号 |
| `10002 参数错误`（token 接口） | `Content-Type: application/json; charset=utf-8` 被网关判非法 | **不带 charset**（已验证 A/B 对照） |
| `2190002 access_token无效`（调试台） | 调试台内置 client_token 是占位/过期 | 不要依赖调试台验权限；用真 token 调 |
| HTTP 200 + 非 JSON 被当成功空数据 | `response.json().catch(() => ({}))` ⇒ 无 error_code ⇒ 当 0 | #991：解析失败/缺 `data` ⇒ `invalid_response`（未合并） |
| 订单列表按时间查恒为 0 | 列表口径不可靠（按 `order_id` 能查到） | 拉数走「验券 ⇒ 分账 ⇒ 订单详情」 |
| `2100005 参数不合法`（时间/日期） | 验券时间要 **int 秒**；账单/提现日期要 **yyyy-MM-dd 字符串** | 客户端分别校验 |
| `cursor must have a value` | 账单/提现分页必须显式传 `cursor=0` | 默认 `cursor=0` |
| 应用读不到 `DOUYIN_LAIKE_*` | 凭证写在 `/opt/box2bitable/server/.env`，而 app 读 `/opt/box2bitable/.env` | **部署前挪到根 `.env`**（未做） |

其他约束：
- 能力开通后默认**限流 400 次/天**，完成「接入解决方案」才解除；
- `status:2`（分账/提现）的**官方语义未确认**，因此**不拿它当判据**；
- 所有接口返回带 `extra.logid`，排查一律带 logid。

---

## 6. 未完成 / 风险

1. **#991 未合并** ⇒ main 上的客户端仍会把坏响应当成功空数据（当前无调用方）；
2. **#995 未合并、未部署** ⇒ 自动结算还没跑过；
3. **凭证位置**：`DOUYIN_LAIKE_*` 与 `DOUYIN_LAIKE_ACCOUNT_ID` 需要放进根 `.env`；
4. **没有真实券单样本**：生产「待平台结算」当前 0 条，无法验证端到端；
5. **支付宝/银行到账**：平台只到"提现完成"，银行入账仍以她那边为准；
6. 「核销日 vs 创建日」：券表规则写"核销日+5"，我方按"创建日+5"。购券当天核销时一致；隔几天核销时会**提前**。要精确到核销日，需要把收款记录与券码关联（未做）。

---

## 7. 下一步

1. 合并 #991（防护）与 #995（结算，等业务负责人口径确认）；
2. 部署前把 `DOUYIN_LAIKE_*` / `DOUYIN_LAIKE_ACCOUNT_ID` 放进根 `.env`；
3. 第一笔真实券单进来后：先**只读观测**（账单/提现出现时间），确认与 14:00 的排期吻合；
4. 若业务要求精确到核销日：给 S交易明细补「券码/订单号」，再改成按券码匹配。
