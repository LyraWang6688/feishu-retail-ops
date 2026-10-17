# CI 两条红灯的两份体检（2026-10-16 · 都不是 flake ✗）

> ⚠️ 文件名**故意不叫 flake** ✓ —— 起因是 PR #659 上两条红灯（`test` 1 条 + `CodeQL` 1 条），
> 当时的一个判断是"顺序相关 / 像环境抖动" ✗ —— **两条后来都证明是"改动代码自身的真问题"** ✓：
> · **①** 是**新增文案撞上既有判据**（不是顺序 ✗）
> · **②** 是**真 CodeQL 高危告警**（不是配置/权限/4 秒跑不完 ✗）
> ⇒ 记录在此，**下次别先猜 flake** ✗（先拿证据 ✓）

## ① `test` 那 1 条红：AC-11（`purchaseGroupNoticeText.test.js`）—— **"顺序相关"是幽灵** ✗

**最终真因**（原作者查清并修掉 ✓）：#659 那一刀自己加了一句**死文案**
`jumpNeedsAmountBody: '…请先填上成交金额。'` ⇒ 撞上**既有判据**
【**明令禁止旧列名字面量「成交金额」**】（`test/scanSaleTwoLayerMoney.test.js:1227`）✗
⇒ 原作者把那句连同姊妹句一起摘掉 ⇒ 本地全量重跑 = **2676 / pass 2672 / fail 0 / skipped 4 全绿** ✓

**我这边（只读）当时排除掉的三条**（**结论仍有效**，留档供下次省时间 ✓）：
1. AC-11 读的是**磁盘 `.env.example`**，且解析配置用**显式空 env**（`purchaseGroupNoticeText.test.js:98`
   `resolvePurchaseGroupNoticeConfig({})`）⇒ **不是"被别的用例改了 `process.env`"** ✗
2. **没有任何测试写 `.env.example`**（全 `test/*.test.js` 里只有读 / `grep`）✗
3. `PURCHASE_GROUP_NOTICE_DEFAULTS_BY_KEY` 只出现在配置导出与它自己的用例 ⇒ **不是被别处改对象** ✗

**教训**：看到"单跑绿、全量红" ⇒ ⚠️ **不要先归因于执行顺序** ✗ —— 更常见的是
**这一刀新增的文案/标识撞上了别处的既有判据** ✓（判据是**全仓**的，不只在本文件里 ✓）。
排查顺序建议：**先把"这条断言到底在断什么"读清** ⇒ 再 `grep` 那个字面量/标识的**既有判据** ✓ ⇒ 最后才谈顺序 ✓

## ② `CodeQL` 那条红：**4 秒不是"没分析"，是真告警** ✗

⭐ **关键更正**：CodeQL 在这个仓库**不是 workflow run**，而是 **check-run**（CodeQL 应用自己挂的 ✓）
⇒ `gh run view <id>` 会 **404** ✗；正确姿势：
```bash
SHA=$(gh pr view <PR> --json headRefOid -q .headRefOid)
gh api repos/{owner}/{repo}/commits/$SHA/check-runs -q '.check_runs[] | select(.name|test("CodeQL";"i")) | {id,status,conclusion,started_at,completed_at,output}'
gh api repos/{owner}/{repo}/check-runs/<id>/annotations   # 注解原文
```
**实测拿到的原文**（PR #659 head）：
```
status=completed  conclusion=failure   started 17:32:09Z → completed 17:32:13Z（**4 秒**）
title: 1 new alert including 1 high severity security vulnerability
summary: ### New alerts in code changed by this pull request / Security Alerts: * 1 high
annotation(failure): This string may still contain <!--, which may cause an HTML element injection vulnerability.
```
⇒ **这不是配置 / 权限 / 并发 ✗**，也不是"4 秒跑不完分析" ✗ ——
**CodeQL 只对 PR【改动的那点代码】跑查询，本来就只要几秒** ✓；这次它**真的**判了一处：
**改动代码里的字符串仍可能含 `<!--`** ⇒ **high：HTML 元素注入** ✗
（形状很像"**剥 HTML 注释**"没剥干净：`<!--` 漏出去 ⇒ 注入面 ✓）

**建议**（**只在它自己分支上修** ✗ 不要碰别人的 PR）：
1. 把那处"剥注释 / 拼字符串"的处理**改成剥干净**（或走白名单转义）✓
2. 推上去 ⇒ **CodeQL 会重跑** ✓ ⇒ 绿了再合 ✓
3. 🔴 **不许 `--admin` 绕过** ✗（CI 闸门就是干这个的 ✓）

## ③ 附：本次排查的边界（如实 ✓）
- 🔴 **只读为主**：**没有碰 `#659` 的分支** ✗、**没有改任何 `server/src/**`** ✗、未部署 ✓、生产 Base 只读 ✓
- ⏳ 我起的那次"干净基线 `042bc5f` 全量"探针（`/tmp/probe1.log`）**在结论到手前已终止**（结论已被原作者的重跑取代 ✓）
  —— ⚠️ 如实记：它**没有**产出总账，**不作为证据** ✗
