# 群聊真机测试环境（2026-10-06 搭好并验证）

## 一套环境（**每一项都实测过**）
| 项 | 值 | 来源 |
| --- | --- | --- |
| **测试群 chat_id** | `oc_9f2cb1ff23ee442a5facbb1fc24ae1f9` | = `.env` 的 `PURCHASE_CHAT_ID`（已核对一致） |
| **测试应用 app_id** | `cli_aa3341b397389cd4` | = `.env` 的 `LARK_TEST_APP_ID` |
| **测试机器人 open_id** | `ou_cd858f2fde7c25cb778b4e0c94874098`（名字"来财备份"） | = `.env` 的 `LARK_BOT_OPEN_ID`（已核对一致） |
| **测试 Base** | `.env` 的 `FEISHU_V1_BITABLE_APP_TOKEN` 已指向测试 Base | 脚本硬闸门会再校验 |

⚠️ **生产群用的是【另一个机器人】**（`ou_dc362967…`）—— **两边物理隔离**，
   测坏了影响不到生产，生产也不会被测试干扰。

## 长连接：本地收【测试群】的消息
```bash
cd server
WS_LISTEN_ALLOW_SAME_APP=true node scripts/ws-listen.mjs \
  --seconds 900 --env-file ../.env --events im.message.receive_v1
```
- ⚠️ **本机只有一个测试应用** → `LARK_TEST_APP_ID` == `LARK_AGENT_APP_ID`（**这是有意的**：
  项目代码只读 `LARK_AGENT_*`，本机跑自测必须这么填）。
- 该判据**默认仍然拒绝**；只有**显式**设 `WS_LISTEN_ALLOW_SAME_APP=true` 才放行（#159 已合并）。
- 放行时会打印"请自行确认它是测试应用 + `.env` 指向测试 Base"与 Base 归属自检。
- **实测**：长连接建立成功（`state=connected`），并**收到过测试群消息 1 条**
  （含 `chat_id` / `chat_type=group` / `message_id` / `thread_id`）。

## 🔴 本机 `.env` 必须先配好（否则脚本跑不起来）
1. **各业务表 id 必须是【测试 Base】的** —— 否则用的是 `v1BitableSchema` 里的**生产默认 id**
   → 报 `TableIdNotFound`（2026-10-06 卡过一次）。
   生成办法：用 SDK `bitable.appTable.list` 列出**测试 Base 的所有表**，
   按 `v1BitableSchema.tables[*].tableName` **同名匹配**，写 `FEISHU_V1_<KEY>_TABLE_ID=<测试 id>`；
   ⚠️ 写 `.env` 时**同名键要替换、不要追加**（dotenv 是先到的赢）。
2. **测试 Base「库存流水」要有「操作人」列**（人员 `type=11`）——
   代码映射了它，缺列会让**所有库存写入**被闸门挡住。

## 已跑通 / 待跑
**✅ 现货（一单一笔交易）**
- 建单后：`{"userAction":"未确认","sales":"","funds":"","stock":""}`
- 点「确认」后：**确认状态=已确认 · 销售状态=已写入 · 资金状态=已写入 · 库存状态=已写入**
- 销售明细 1 条 · 收款明细 1 条 · 库存流水（门盒 −1）· 交付完成
- ⚠️ 走的是"建单 + 点确认"，**没走 AI 解析**，所以「解析状态」停在"解析中"

**⏳ 待跑**：两笔交易 / 两笔支付方式 / 预付 / 未付 / 退货 / 换货 / **话题形式回复**
- 代理写的 `e2e-sales-status.mjs --kind all`（走完整 AI 链路）**卡在 `waitFor` 之外**
  （疑似 `sendGroupMessage` 不返回）→ 改走**真机长连接**路
- 新脚本 `ws-selftest.mjs`（**长连接 → 真实链路 → 回复真的发到测试群**）在做

## 真机测试怎么进行（设计）
1. 本地起脚本：长连接收**测试群**消息 → 喂给真实 `LarkMvpService.acceptMessage`
2. 回复**真的发到测试群**（用真 client 而非本地替身）→ 对方在群里能看到卡片
3. 重点验：**回复带不带 `reply_in_thread`**（= 是不是"话题形式"）
4. 跑完打印：四个字段 / 明细与收款条数 / 库存变化
