# 交接：①每件实收必填 + ②差额一律补【未收款】（按王颖 2026-10-14 最新裁决）

## 一句话
源码两处已改对（见下），**剩下 15 条哨兵要按她今晚那句逐条翻新**，翻完两遍全量 EXIT=0 ⇒ PR。

## 她的原话（最新权威 · 2026-10-14）
1. 「**销售货品页的每件金额必须填，只有资金页可以不填**」⇒ 每件实收 **必填**；整单收款**仍可全空**（"待补充"老路保留）
2. 「**只要本次付的金额小于累计的，那么差额都是未收款，包括本次付款为 0**」⇒ 差额 **一律**补【未收款】（不看档位）

## 已改好的（真源）
- `server/src/config/scanWrite.js`：新增 `lineAmountRequiredNote`（人话，走配置）+ `unpaidMethodLabel: '未收款'`
- `server/src/routes/scanPage.js`：提交那一步 —— 任何一双 `line_amount` 为空 ⇒ **400 + 人话 + 零写入**
- `server/src/services/scanWriteService.js`：`if (itemsCents - paidCents > 0) owedCents = itemsCents - paidCents;`
  （改前是 `if (partial) …` ✗ 只有部分付才补）· 那一条【未收款】仍由**既有业务层** `SalesOrderManager.confirm({ owed })` 写

## 剩下的（15 条哨兵 · 钉着 2026-10-11 的旧口径）
`test/scanSaleTwoLayerMoney.test.js` / `test/scanSaleE2E.test.js` 里这些：
`AC-6b` · `AC-9b` · `AC-5a` · `AC-5a2` · `AC-16` · `AC-12` · `AC-13b` · `AC-8c` · `AC-E2E-11` · `AC-R9` ·
以及同一族的其它几条（跑全量看红名单即可）。
改法：把「未付 ⇒ **不写**未收款 / 她没说欠就不写」翻成「**差额 > 0 ⇒ 写一条**（0 收款也写）」；
夹具里 `line_amount` 空串 ⇒ 补真实价格（保持**元素个数 = 行数**）；每条写「改前逐字 → 改后逐字 → 依据（她的原话）」。
🔴 不许为了变绿放宽判据；不许 skip。

## 验收（做完才算）
- 全量两遍 `cd server && node --test --test-concurrency=1 --test-force-exit` ⇒ **EXIT=0**
- 真渲染/真调用证据：0 收款提交 ⇒ 收款明细**恰一条**「未收款」，金额 = 累计（逐字对）；幂等：同一 submitKey 重试**不写第二条**
- 然后 PR（不 `--admin`）⇒ **部署前先问她**（授权一次一次算）
