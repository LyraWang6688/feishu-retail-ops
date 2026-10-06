# 销售四维状态 · 端到端自测方法（2026-10-06 摸清并跑通）

## ⭐ 怎么跑
```bash
cd server
node scripts/e2e-sales-status.mjs --env-file ../.env            # 只读体检（不写任何表）
node scripts/e2e-sales-status.mjs --env-file ../.env --apply    # 真写（只写测试 Base）
```
- 脚本里**写死了硬闸门**：目标 Base 必须 = `FEISHU_V1_E2E_TEST_APP_TOKEN` 且
  `FEISHU_TARGET_ENV=test`，否则**拒绝运行**；**不打印任何 token**。
- 走的是**项目代码**（建单入口 + `handleCardAction({action:'confirm_sale'})` + 交付），
  **不是手拼 SDK、不用飞书 CLI**；IM 全走**本地替身**（不发真实消息）。

## 🔴 本机环境必须先配好（否则跑不起来）
1. **`.env` 里各业务表的 id 必须是【测试 Base】的** ——
   ⚠️ 否则本机用的是 `v1BitableSchema` 里的**生产默认 id** → 报 `TableIdNotFound`
   （2026-10-06 就因此卡住；也在 `AGENTS.md` 第 8 条"本机不配生产多维表格"的精神之内）。
   - **生成办法**：用 SDK `bitable.appTable.list` 列出**测试 Base 的所有表**，
     按 `v1BitableSchema.tables[*].tableName` **同名匹配**，得到
     `FEISHU_V1_<KEY>_TABLE_ID=<测试 id>`（key 转大写下划线）。
   - ⚠️ 写 `.env` 时**同名键要替换、不要追加**（dotenv 是**先到的赢**）。
2. **测试 Base「库存流水」要有「操作人」列**（人员类型 `type=11`）
   —— 代码映射了它，缺列会让**所有库存写入**在测试 Base 上被闸门挡住。
   （2026-10-06 已加，`field_id = fldYpOyvwK`。）

## ⭐ 现货（一单一笔交易）· 已跑通（2026-10-06）
```
建单后 ：{"userAction":"未确认","sales":"","funds":"","stock":""}
点「确认」后：
  确认状态 = 已确认    （期望 已确认）✅
  销售状态 = 已写入    （期望 已写入）✅
  资金状态 = 已写入    （期望 已写入）✅
  库存状态 = 已写入    （期望 已写入）✅
＋ 销售明细 1 条 · 收款明细 1 条
＋ 库存流水：STOCK_SALE_DECREASE · 门盒 · 减 1（实时库存 2 → 1）
＋ 交付完成：fulfillment_status=已交付 · failed_count=0
＋ IM 替身调用 2 次（全部拦在本地，没有真实外发）
```

## ⏳ 还没跑的场景（业务负责人要求）
- 现货：**一单两笔交易** · **一单两笔支付方式**
- **预付销售**：首次 → 明细**未履约** + **两笔收款**（一笔已收 + 一笔待收）
  → 话题里说「已完毕/成交」→ **未履约→履约** · **待收→已收** · **有收款时间**
- **未付销售**：首次 → 明细**已履约** + 收款**待收** → 话题里说「成交」→ **待收→已收** + **收款时间**
- **销售退货** / **销售换货**：并报**库存变化**
- ⭐ **单独验**「机器人回复是不是**话题形式**」（出站 payload 带 `reply_in_thread: true`）
