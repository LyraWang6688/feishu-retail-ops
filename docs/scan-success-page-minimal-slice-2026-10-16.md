# 提交成功页 · 统一极简（2026-10-16 · task-52 收尾件 · **本刀只做不冲突的部分**）

> 业务负责人的口径（逐字 · 2026-10-16）：
> 「用户提交之后**都是一个成功页**，说"**已提交成功，数据会更新**"类似这类的话就行了。
>   **都是一个异步的提醒**，告诉系统已经接收到用户提交的这单了」
> 「**不需要做任何跳转，也不需要做任何链接**」

## 1. 本刀做了什么（**只新增 ＋ 一处渲染层挂钩** ✓ 不碰被占用的文件 ✗）

| 件 | 内容 |
| --- | --- |
| ⭐ **新** `server/src/config/scanSuccessPage.js` | 开关 `SCAN_SUCCESS_PAGE_MINIMAL_ENABLED`（**显式布尔 · 缺省 false** ✓ `readFlag` ✓ **空串 = 关** ✓ **禁 `\|\|` 兜底** ✗）＋ 文案 `SCAN_SUCCESS_PAGE_MINIMAL_TEXT`（缺省「已提交成功，数据会更新」✓ **空串 ⇒ 用缺省** ✓ 文案不是开关 ✓ 口径不同已在文件里写明 ✓）＋ `minimalSuccessOverrides()`（开关关着 ⇒ **返回空对象** ✓ 调用方 spread 后逐字不变 ✓） |
| ⭐ 挂钩 `server/src/views/scanPage/index.js`（`renderScanMessagePage` ✓ **本文件无人在改** ✓） | **只在 `tone === 'success'`** 且开关打开时，套用覆盖值：`body` = 那一句 ✓；`number` / `details` / `retryHint` / `backPath` / `backLabel` / `backHint` / `returnPath` / `returnLabel` / `returnDelaySeconds` / `autoReturnUrl` / `extraActionsHtml` **全清** ✗ ⇒ **一个 `<a>` / `<button>` / `<meta http-equiv="refresh">` 都没有** ✓ |
| ⭐ **新** `server/test/scanSuccessPageMinimal.test.js` | `AC-MS-P1`（四条链：同一句 ＋ 零链接零按钮零跳转 ✓）· `AC-MS-P2`（**零回归**：关着时与今天逐字一致 ✓）· `AC-MS-P3`（配置先行：显式布尔缺省 false ✓ 去注释后判"不许 `\|\|`" ✓） |

**为什么不改 `title`** ✗：她要说的是"**一句话 ＋ 不跳不链接**"✓，不是"标题也统一"✗ ⇒ 四条链各自的标题照旧 ✓。

## 2. 现状（只读复核 · 最新 `origin/main` = `6ad32ea` ✓）

已由**别人的 PR** 落地（**本刀不重做** ✗）：

- 补货 / 退货 接异步：#695 ✓（`routes/scanPage/index.js` 的 `schedulePurchaseWrite` ✓）
- 验收（**工作台**入口）接异步：#707 ✓
- 分阶段判据：#677 ✓ · 设计文档：#653 ✓
- **销售**异步写入：#567 / #573 ✓（`services/saleWriteBackgroundService.js` ✓）

⇒ **本刀只把"成功页统一极简"这一件做成可开关、可判定、缺省零回归的配置能力** ✓。

## 3. ⚠️ 本刀**未做**（如实 · 因避让未碰）

1. 🔴 **把四条链的成功页真正接到这个开关上** ✗ —— 那要动
   `routes/scanPage/index.js`（**`sales-scan` 正在改** ✗）与 `views/scanPage/paymentBlock.js:299`（**同样有人在改** ✗）
   ⇒ 按纪律**停手报 Lead** ✗（**不许两个写入者同文件** ✗）。
2. 🔴 **`services/scanWriteService.js` 一个字未动** ✓（余量 0 ✓ 有冻结哨兵 ✓）。
3. ⚠️ **"提交即回"（真异步）**那条本刀**也没做** ✗ —— 扫码页那几条链是否全部已在 #695/#707 覆盖，
   要等 `routes/**` 让出来后再核（届时按 `docs/async-and-success-page-plan-2026-10-16.md` §4 逐条对照 ✓）。

## 4. 判据怎么证（可复现）

```bash
cd server
/usr/local/bin/node --test --test-concurrency=1 --test-force-exit test/scanSuccessPageMinimal.test.js   # 3/0 ✓
```
- **AC-MS-P1**：四条链各渲染一次（开关打开）⇒ ①同一句话 ②`<a` 计数 = 0 ③`<button` 计数 = 0 ④`http-equiv="refresh"` 计数 = 0 ✓
- **AC-MS-P2**：缺省（关）⇒ 那颗 `data-view="success-return"` 链接、`refresh`、她给的原句、追加动作块**都还在** ✓（与今天同形 ✓）
- **变异**：① `minimalSuccessOverrides` 恒返 `{}` ⇒ **P1 红** ✓ ② 渲染层不套用覆盖值 ⇒ **P1 红** ✓（还原后 3/0 ✓）
